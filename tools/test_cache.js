/**
 * test_cache.js — 缓存 / 懒翻译 / 用量统计 专项测试（本地 mock OpenAI 接口）
 *
 * 断言：
 *  1. 数值/单位单元格（36 m、2x、1.5 s）与占位词（None、N/A）不进 AI 请求
 *  2. 机制术语表生效（Damage Falloff 进入请求术语表）
 *  3. AI 原样回显的行不落缓存；正常 AI 译文与词典终局块正常落缓存
 *  4. 缓存 key 带提示词版本前缀（tr|5|，与 const.ts PROMPT_VERSION 同步，改 prompt/机制表时两者一起改）
 *  5. AI 用量统计：requests === 请求数，tokens > 0
 *  6. 视口懒翻译：屏外块挂起不翻，滚动到底部后放行翻完
 *  7. 未配置 Key 时点悬浮按钮 → 打开设置页（而不是把站点记为停用）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const DIST = path.join(ROOT, 'dist', 'chrome');
const FILLERS = 40; // 视口外的填充段（词典终局，翻出来是 "伤害衰减 n."）

const fillerHtml = Array.from({ length: FILLERS }, (_, i) => `<p class="filler">Damage Falloff ${i + 1}.</p>`).join('\n');

const FIXTURE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Cache Test - WARFRAME Wiki</title></head>
<body><div id="mw-content-text"><div class="mw-parser-output">
<p>The Tigris Prime is a shotgun that consumes <a href="/w/Forma">Forma</a> to build.</p>
<p>This weapon suffers heavy Damage Falloff at long range.</p>
<p>Staggering enemies also builds up the combo counter quickly.</p>
<table><tbody><tr><td>36 m</td><td>2x</td><td>1.5 s</td><td>None</td><td>N/A</td></tr></tbody></table>
${fillerHtml}
</div></div></body></html>`;

const SKIP_CELLS = new Set(['36 m', '2x', '1.5 s', 'None', 'N/A']);

/** AI 请求里出现过的编号行文本 / 术语表原文 / mock 原样回传的行 */
const aiLines = [];
const termBlocks = [];
let echoedLine = null;
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
        const tm = user.match(/术语表：\n([\s\S]*?)\n\n文本：/);
        if (tm) termBlocks.push(tm[1]);
        const numbered = user.split(/文本：\n/)[1] || '';
        for (const line of numbered.split('\n')) {
          const m = line.match(/^\[(\d+)\] (.*)$/);
          if (m) aiLines.push(m[2]);
        }
        const out = numbered.split('\n').map(line => {
          const m = line.match(/^\[(\d+)\] (.*)$/);
          if (!m) return line;
          if (m[2].includes('shotgun')) {
            echoedLine = m[2]; // 模拟 AI 偷懒：这行原样抄回
            return `[${m[1]}] ${m[2]}`;
          }
          return `[${m[1]}] 【AI】${m[2]}`;
        }).join('\n');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: out }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

async function dumpTcache(sw) {
  return sw.evaluate(async () => new Promise(resolve => {
    const rq = indexedDB.open('tw', 1);
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction('tcache', 'readonly');
      const store = tx.objectStore('tcache');
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      let keys = null, vals = null;
      const done = () => { if (keys && vals) resolve({ keys, vals }); };
      keysReq.onsuccess = () => { keys = keysReq.result; done(); };
      valsReq.onsuccess = () => { vals = valsReq.result; done(); };
    };
    rq.onerror = () => resolve({ keys: [], vals: [] });
  }));
}

(async () => {
  await new Promise(r => server.listen(8803, '127.0.0.1', r));

  fs.mkdirSync(TMP, { recursive: true });
  const profile = path.join(TMP, 'profile-cache');
  fs.rmSync(profile, { recursive: true, force: true }); // 全新 profile：词表/缓存从零开始
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE }));
  await page.goto('https://wiki.warframe.com/w/Cache_Test', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500); // content script boot

  // ---- 断言 7：未配置 Key，点 FAB 打开设置页 ----
  await page.mouse.click(1280 - 30, 900 - 28);
  let optionsOpened = false;
  for (let i = 0; i < 20 && !optionsOpened; i++) {
    await page.waitForTimeout(500);
    optionsOpened = context.pages().some(p => p.url().includes('options'));
  }

  // 注入 AI 设置 → content 监听到 Key 出现，自动开翻
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
      aiModel: 'mock-cache',
      autoTranslate: true,
      fontSize: 14,
      color: '#4a90d9',
      glossaryCheckHours: 24,
    };
    await new Promise(res => chrome.storage.local.set({ settings }, res));
  });

  // ---- 断言 6a：视口外挂起（最后 10 段 filler 不出现译文） ----
  await page.waitForFunction(() => document.querySelectorAll('.tw-tr').length >= 10, { timeout: 30000 });
  await page.waitForTimeout(3000); // 等初始队列与 AI 批次收尾
  const fillerTranslated = () => page.evaluate(() =>
    [...document.querySelectorAll('p.filler')]
      .filter(p => p.nextElementSibling?.classList.contains('tw-tr')).length);
  const parkedOk = (await fillerTranslated()) < FILLERS; // 尚未全翻 = 挂起生效

  // ---- 断言 6b：滚动到底部 → 挂起块放行翻完 ----
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  let allTranslated = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    allTranslated = await fillerTranslated();
    if (allTranslated === FILLERS) break;
  }

  // ---- 断言 1/2：AI 请求内容 ----
  const unitLeaked = aiLines.filter(l => SKIP_CELLS.has(l.trim()));
  const mechInTerms = termBlocks.some(t => t.includes('Damage Falloff => 伤害衰减'));
  // filler 行的固定格式是 "Damage Falloff <n>."（正文段落里含该词不算）
  const fillerLeaked = aiLines.filter(l => /^Damage Falloff \d+\.$/.test(l.trim()));

  // ---- 断言 3/4/5：缓存与用量 ----
  const { keys, vals } = await dumpTcache(sw);
  const allKeysPrefixed = keys.length > 0 && keys.every(k => String(k).startsWith('tr|5|'));
  const echoCached = echoedLine
    ? vals.some(v => v && v.viaAI === true && v.translation === echoedLine)
    : 'echo-line-missing'; // mock 没回显 = 测试设计失效
  const aiCached = vals.some(v => v && v.viaAI === true);
  const dictCached = vals.some(v => v && v.viaAI === false);
  const usage = await sw.evaluate(() => new Promise(res =>
    chrome.storage.local.get('usage', o => res(o.usage || null))));
  const usageOk = usage
    && usage.requests === bodies.length
    && usage.prompt > 0
    && usage.completion > 0;

  const result = {
    optionsOpened,
    aiRequests: bodies.length,
    aiLineCount: aiLines.length,
    unitLeaked,
    mechInTerms,
    fillerLeaked,
    parkedOk,
    allTranslated: `${allTranslated}/${FILLERS}`,
    cacheKeys: keys.length,
    allKeysPrefixed,
    echoCached,
    aiCached,
    dictCached,
    usage,
  };
  console.log(JSON.stringify(result, null, 2));

  await context.close();
  server.close();

  const ok = optionsOpened
    && bodies.length === 1
    && unitLeaked.length === 0
    && mechInTerms
    && fillerLeaked.length === 0
    && parkedOk
    && allTranslated === FILLERS
    && allKeysPrefixed
    && echoCached === false
    && aiCached
    && dictCached
    && usageOk;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
