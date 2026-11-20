/**
 * measure_saving.js — 用真实页面快照 + mock AI 测量"跳过词典终局块"省下多少
 *
 * 用法: node tools/measure_saving.js [页面快照.html] [扩展目录]
 * 输出: AI 收到的行数/字符数（比较开启与关闭跳过的两份 dist 即可得到节省比例）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const HTML = process.argv[2] || path.join(__dirname, '.tmp', 'slash_dash_real.html');
const DIST = process.argv[3] || path.join(__dirname, '..', 'dist', 'chrome');
const PORT = 8805;

const aiLines = [];
let aiChars = 0;
let reqs = 0;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url.endsWith('/chat/completions')) {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      reqs++;
      const body = JSON.parse(data);
      const user = body.messages.find(m => m.role === 'user')?.content || '';
      aiChars += user.length;
      const numbered = user.split(/文本：\n/)[1] || '';
      for (const line of numbered.split('\n')) {
        const m = line.match(/^\[(\d+)\] (.*)$/);
        if (m) aiLines.push(m[2]);
      }
      const out = numbered.split('\n').map(line => {
        const m = line.match(/^\[(\d+)\] (.*)$/);
        return m ? `[${m[1]}] 【AI】${m[2]}` : line;
      }).join('\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: out }, finish_reason: 'stop' }] }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const TMP = path.join(__dirname, '.tmp');
  const profile = path.join(TMP, 'profile-measure-' + path.basename(DIST));
  fs.rmSync(profile, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
  });

  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = context.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await sw.evaluate(async port => {
    const settings = {
      aiBaseUrl: `http://127.0.0.1:${port}/v1`,
      aiKey: 'mock-key',
      aiModel: 'mock-measure',
      autoTranslate: true,
      translateComments: false,
      fontSize: 14,
      color: '#4a90d9',
      glossaryCheckHours: 24,
    };
    await new Promise(res => chrome.storage.local.set({ settings }, res));
  }, PORT);

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  const html = fs.readFileSync(HTML, 'utf8');
  await page.route('https://wiki.warframe.com/**', route =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('https://wiki.warframe.com/w/Slash_Dash', { waitUntil: 'domcontentloaded' });

  // 等队列排空：AI 行数连续 4 次不增长
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (aiLines.length === prev) { if (++stable >= 4) break; } else { stable = 0; prev = aiLines.length; }
  }

  const dom = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('.tw-tr')];
    return {
      rendered: trs.length,
      ai: trs.filter(e => e.dataset.twMode === 'ai').length,
      dict: trs.filter(e => e.dataset.twMode === 'dict').length,
    };
  });

  console.log(JSON.stringify({
    dist: path.basename(DIST),
    aiRequests: reqs,
    aiLines: aiLines.length,
    aiPromptChars: aiChars,
    dom,
  }, null, 2));

  await context.close();
  server.close();
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
