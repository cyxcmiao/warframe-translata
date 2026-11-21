/**
 * test_icons.js — 行内小图标保留的端到端测试（MHTML 快照离线回放 + mock AI）
 *
 * 用法: node tools/test_icons.js
 * 前置: python tools/extract_mhtml.py 生成 tools/.tmp/icons_page.html
 *
 * 断言:
 *  1. AI 模式下能力段落译文块渲染，且内含克隆的图标 <img>（能量球等）≥ 3 个
 *  2. 能量球图标（按 data URI 指纹匹配）出现在译文里
 *  3. 原文段落的图标未被改动
 *  4. 无页面 JS 错误
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const DIST = path.join(ROOT, 'dist', 'chrome');
const PAGE_FILE = path.join(TMP, 'icons_page.html');
const PAGE_URL = 'https://wiki.warframe.com/w/Slash_Dash';

// ---- mock OpenAI 接口（同 test_ai.js: 保留 ⟦n⟧ token，术语用词表回填，必加【AI】前缀保证译文块渲染）----
function mockTranslate(userText) {
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
    for (const [en, zh] of terms) {
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: mockTranslate(user) } }] }));
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
  await new Promise(r => server.listen(8804, '127.0.0.1', r));
  const pageHtml = fs.readFileSync(PAGE_FILE, 'utf-8');
  // 取原文里能量球图标（"expends" 后第一个 data URI）的前缀作指纹
  const anchor = pageHtml.indexOf('expends');
  const m = /src="(data:image\/[a-z+]+;base64,.{60})/.exec(pageHtml.slice(anchor, anchor + 1500));
  if (!m) throw new Error('icons_page.html 中未找到能量球 data URI');
  const energyFingerprint = m[1];

  const profile = path.join(TMP, 'profile-icons');
  fs.rmSync(profile, { recursive: true, force: true }); // 全新 profile，避免 SW 休眠不启动
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
    ],
  });

  const logs = [];
  ctx.on('page', p => p.on('console', msg => logs.push(`[page.${msg.type()}] ${msg.text()}`)));

  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('background service worker not detected');
  console.log('SW up:', sw.url());

  // 注入 mock AI 设置（词典+AI 全链路，离线确定性）
  await sw.evaluate(async () => {
    const settings = {
      aiBaseUrl: 'http://127.0.0.1:8804/v1',
      aiKey: 'mock-key',
      aiModel: 'mock-1',
      autoTranslate: true,
      fontSize: 14,
      color: '#4a90d9',
      glossaryCheckHours: 24,
    };
    await new Promise(res => chrome.storage.local.set({ settings }, res));
  });
  console.log('mock AI settings injected');

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route => {
    const url = route.request().url();
    if (url.startsWith(PAGE_URL)) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageHtml });
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'offline' });
  });
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 等扩展内容脚本就绪（boot 早期注入的 #tw-style），必要时刷新一次
  let ready = false;
  for (let i = 0; i < 8 && !ready; i++) {
    await new Promise(r => setTimeout(r, 1000));
    ready = await page.evaluate(() => !!document.getElementById('tw-style'));
  }
  if (!ready) {
    console.log('tw-style missing, reload once');
    await page.reload({ waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 10 && !ready; i++) {
      await new Promise(r => setTimeout(r, 1000));
      ready = await page.evaluate(() => !!document.getElementById('tw-style'));
    }
  }
  if (!ready) throw new Error('content script not started (no tw-style)');

  // 等翻译稳定
  let counts = [];
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    counts.push(n);
    if (i > 5 && n === counts[counts.length - 4] && n > 0) break;
  }

  const r = await page.evaluate(fp => {
    const trs = [...document.querySelectorAll('.tw-tr')];
    // 能力主段落译文块（mock 输出带【AI】前缀，用原文独有的 expends 匹配）
    const abTr = trs.find(t => t.textContent.includes('expends'));
    const abImgs = abTr ? [...abTr.querySelectorAll('img')] : [];
    const srcLi = [...document.querySelectorAll('#mw-content-text li')].find(li => li.textContent.startsWith('Excalibur expends'));
    return {
      total: trs.length,
      ai: trs.filter(e => e.dataset.twMode === 'ai').length,
      abFound: !!abTr,
      abImgs: abImgs.length,
      abEnergy: abImgs.some(i => i.src.startsWith(fp)),
      abSample: (abTr?.textContent || '').trim().slice(0, 80),
      trImgs: trs.reduce((n, t) => n + t.querySelectorAll('img').length, 0),
      srcIconsIntact: srcLi ? srcLi.querySelectorAll('img').length : -1,
    };
  }, energyFingerprint);
  console.log('RESULT:', JSON.stringify(r, null, 2));

  await page.screenshot({ path: path.join(TMP, 'shot-icons.png'), fullPage: false });
  console.log('screenshot saved');

  const errs = logs.filter(l =>
    /Uncaught|TypeError|ReferenceError|Cannot read/i.test(l) ||
    (l.includes('error') && !/Failed to load resource|net::|404/.test(l)));
  console.log('js errors:', errs.length ? errs.slice(0, 10) : 'none');

  await ctx.close();
  server.close();
  const pass = r.total >= 5 && r.ai >= 5 && r.abFound && r.abImgs >= 3 && r.abEnergy && r.srcIconsIntact >= 5 && errs.length === 0;
  console.log(pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('TEST FAILED:', e); server.close(); process.exit(1); });
