/**
 * test_dedupe.js — 翻译去重专项测试（mock AI 接口计数）
 * 验证：
 *  1. 并发两次相同内容的翻译请求 → AI 请求数不翻倍（进行中合并）
 *  2. 同批内重复文本 → 只占一个条目（token 去重）
 *  3. 翻译完成后再请求同样内容 → 缓存命中，0 新请求
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const DIST = path.join(ROOT, 'dist', 'chrome');

let aiHits = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url.endsWith('/chat/completions')) {
    aiHits++;
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data);
      const user = body.messages.find(m => m.role === 'user')?.content || '';
      const bodyPart = user.split(/文本：\n/)[1] || '';
      const text = bodyPart.split('\n').map(l => {
        const m = l.match(/^\[(\d+)\] (.*)$/);
        return m ? `[${m[1]}] 译${m[2].slice(0, 10)}` : l;
      }).join('\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise(r => server.listen(8803, '127.0.0.1', r));
  // 每次全新 profile，确保测的是请求路径而非历史缓存
  fs.rmSync(path.join(TMP, 'profile-dedupe'), { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(path.join(TMP, 'profile-dedupe'), {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = context.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await sw.evaluate(async () => {
    const settings = {
      aiBaseUrl: 'http://127.0.0.1:8803/v1',
      aiKey: 'mock-key',
      aiModel: 'mock-dedupe',
      autoTranslate: true, fontSize: 14, color: '#4a90d9', glossaryCheckHours: 24,
    };
    await new Promise(res => chrome.storage.local.set({ settings }, res));
  });

  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

  // 30 个块：22 个唯一文本 + 8 个重复（模拟重复链接文字）
  const blocks = [];
  for (let i = 0; i < 22; i++) blocks.push({ id: `b${i}`, text: `Unique sentence number ${i} about Tigris Prime and Slash damage.` });
  for (let i = 0; i < 8; i++) blocks.push({ id: `dup${i}`, text: `Unique sentence number ${i} about Tigris Prime and Slash damage.` });

  const r = await page.evaluate(async (blocks) => {
    const send = () => new Promise(res => chrome.runtime.sendMessage({ type: 'translate', blocks }, res));
    // 并发两次（模拟重复触发）
    const [r1, r2] = await Promise.all([send(), send()]);
    const ok1 = Object.values(r1.results).filter(x => x.ok).length;
    const ok2 = Object.values(r2.results).filter(x => x.ok).length;
    // 稍等片刻让缓存写盘，然后第三次（缓存命中）
    await new Promise(res => setTimeout(res, 500));
    const hitsBefore = null;
    const r3 = await send();
    const ok3 = Object.values(r3.results).filter(x => x.ok).length;
    return { ok1, ok2, ok3, hitsBefore, dupSame: r1.results.b0.translation === r1.results.dup0.translation };
  }, blocks);
  await new Promise(res => setTimeout(res, 800)); // 等 inflight 完全落定

  console.log(JSON.stringify({ ...r, aiHits }, null, 2));
  const pass =
    r.ok1 === 30 && r.ok2 === 30 && r.ok3 === 30 &&
    aiHits === 2 /* 22 唯一文本 = 2 批(16+6)；并发第二次 0 新请求；第三次缓存 0 请求 */ &&
    r.dupSame;
  console.log(pass ? 'PASS' : 'FAIL');
  await context.close();
  server.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(1); });
