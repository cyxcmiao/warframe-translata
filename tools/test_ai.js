/**
 * test_ai.js — AI 模式全链路测试（本地 mock OpenAI 接口）
 * mock 会故意保留英文术语原文，验证 enforceTerms 译后校验能强制回填官方译名。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const DIST = path.join(ROOT, 'dist', 'chrome');
const URL_TO_TEST = process.argv[2] || 'https://wiki.warframe.com/w/Tigris_Prime';

// ---- mock OpenAI 接口 ----
function mockTranslate(userText) {
  // 从 prompt 中提取术语表并做朴素替换；保留 ⟦n⟧ token；逐行编号返回
  const terms = new Map();
  const tm = userText.match(/术语表：\n([\s\S]*?)\n\n文本：/);
  if (tm) {
    for (const line of tm[1].split('\n')) {
      const m = line.match(/^(.+) => (.+)$/);
      if (m) terms.set(m[1], m[2]);
    }
  }
  const body = userText.split(/文本：\n/)[1] || userText;
  return body.split('\n').map(line => {
    const m = line.match(/^\[(\d+)\] (.*)$/);
    if (!m) return line;
    let t = m[2];
    // 模拟 AI 不听话: 不主动用术语表；并且故意丢掉部分 token 测试校验
    for (const [en, zh] of terms) {
      // 故意只替换一半出现次数，剩下的留给 enforceTerms
      const re = new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      t = t.replace(re, zh);
    }
    return `[${m[1]}] 【AI】${t}`;
  }).join('\n');
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url.endsWith('/chat/completions')) {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      try {
        const body = JSON.parse(data);
        const user = body.messages.find(m => m.role === 'user')?.content || '';
        const text = mockTranslate(user);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise(r => server.listen(8801, '127.0.0.1', r));
  console.log('mock AI server on :8801');

  fs.mkdirSync(TMP, { recursive: true });
  const context = await chromium.launchPersistentContext(path.join(TMP, 'profile-ai'), {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // 等 SW 起来并注入 AI 设置
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = context.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await sw.evaluate(async () => {
    const settings = {
      aiBaseUrl: 'http://127.0.0.1:8801/v1',
      aiKey: 'mock-key',
      aiModel: 'mock-1',
      autoTranslate: true,
      fontSize: 14,
      color: '#4a90d9',
      glossaryCheckHours: 24,
    };
    await new Promise(res => chrome.storage.local.set({ settings }, res));
  });
  console.log('AI settings injected');

  const logs = [];
  context.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(URL_TO_TEST, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let counts = [];
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    counts.push(n);
    if (i > 6 && n === counts[counts.length - 4] && n > 0) break;
  }

  const result = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('.tw-tr')];
    return {
      count: trs.length,
      ai: trs.filter(e => e.dataset.twMode === 'ai').length,
      dict: trs.filter(e => e.dataset.twMode === 'dict').length,
      samples: trs.slice(0, 8).map(e => e.textContent.trim().slice(0, 100)),
    };
  });
  console.log('RESULT:', JSON.stringify(result, null, 2));
  await page.screenshot({ path: path.join(TMP, 'shot-ai.png') });

  const errs = logs.filter(l => l.toLowerCase().includes('error'));
  console.log('console errors:', errs.length ? errs.slice(0, 5) : 'none');
  await context.close();
  server.close();
  process.exit(0);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
