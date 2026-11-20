/**
 * test_skip.js — 省 token 专项测试（mock AI 记录请求体）
 *
 * 断言：
 *  1. 词典已终结的块（纯链接文本 / 官方保留英文名 / 官方中文名里含英文）不进 AI 请求
 *  2. 真有英文的段落照常进 AI
 *  3. 请求体带 max_tokens 兜底
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const DIST = path.join(ROOT, 'dist', 'chrome');

const FIXTURE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Tigris Prime - WARFRAME Wiki</title></head>
<body><div id="mw-content-text"><div class="mw-parser-output">
<p>The Tigris Prime is a shotgun that consumes <a href="/w/Forma">Forma</a> to build.</p>
<p><a href="/w/Tigris_Prime">Tigris Prime</a></p>
<table><tbody><tr><td>Forma</td><td>Saryn</td></tr></tbody></table>
<ul><li>Pressure Point</li></ul>
</div></div></body></html>`;

/** AI 请求里出现过的编号行文本 */
const aiLines = [];
const bodies = [];

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
        bodies.push(body);
        const user = body.messages.find(m => m.role === 'user')?.content || '';
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
  await new Promise(r => server.listen(8802, '127.0.0.1', r));

  fs.mkdirSync(TMP, { recursive: true });
  const profile = path.join(TMP, 'profile-skip');
  fs.rmSync(profile, { recursive: true, force: true }); // 清缓存，确保真的发请求
  const context = await chromium.launchPersistentContext(profile, {
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
      aiBaseUrl: 'http://127.0.0.1:8802/v1',
      aiKey: 'mock-key',
      aiModel: 'mock-skip',
      autoTranslate: true,
      fontSize: 14,
      color: '#4a90d9',
      glossaryCheckHours: 24,
    };
    await new Promise(res => chrome.storage.local.set({ settings }, res));
  });

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE }));
  await page.goto('https://wiki.warframe.com/w/Tigris_Prime', { waitUntil: 'domcontentloaded' });

  let n = 0;
  for (let i = 0; i < 36; i++) {
    await new Promise(r => setTimeout(r, 500));
    n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    if (n >= 4) break;
  }

  const dom = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('.tw-tr')];
    return {
      total: trs.length,
      ai: trs.filter(e => e.dataset.twMode === 'ai').length,
      dict: trs.filter(e => e.dataset.twMode === 'dict').length,
      texts: trs.map(e => e.textContent.trim().slice(0, 60)),
    };
  });

  const skipped = ['Tigris Prime', 'Saryn', 'Pressure Point'];
  const leaked = skipped.filter(t => aiLines.some(l => l.trim() === t));
  const paraSent = aiLines.some(l => l.includes('shotgun'));
  const hasMaxTokens = bodies.length > 0 && bodies.every(b => typeof b.max_tokens === 'number' && b.max_tokens > 0);

  const result = {
    aiRequests: bodies.length,
    aiLines,
    dom,
    leakedSkippedBlocks: leaked,
    paragraphSentToAI: paraSent,
    maxTokensPresent: hasMaxTokens,
  };
  console.log(JSON.stringify(result, null, 2));

  await context.close();
  server.close();
  // 只有那段真需要翻译的英文进 AI；三个终局块（Forma / Saryn / Tigris Prime）一条都不该出现
  const ok = bodies.length === 1 && aiLines.length === 1 && leaked.length === 0 && paraSent && hasMaxTokens;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
