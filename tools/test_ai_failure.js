/**
 * test_ai_failure.js — AI 失败块的呈现与补翻重试回归
 * 用法: node tools/test_ai_failure.js
 *
 * 场景（The Steel Path 快照页，真实 mock 接口可控三种模式）:
 *  1. echo 模式（模型原样回显 = 假译文，背景判 failed 不落缓存）:
 *     AI 块静默不渲染——尤其不能渲染"原文+译名链接"的误导性半翻译；词典终局块照常渲染。
 *  2. 保持 echo 并逐屏滚动：挂起块放行时失败块搭车补翻（仍失败 → 每宿主限自动重试一次），
 *     页面不得出现 AI 假译文。
 *  3. 接口恢复后按 Ctrl+Alt+D 两连（隐藏→重新显示）：手动补翻重试全部失败块，段落出译文。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');
const { injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = path.join(__dirname, '.tmp', 'the_steel_path.html');
const PAGE_PATH = '/w/The_Steel_Path';
const HTML = fs.readFileSync(HTML_PATH, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');

/** mock 接口: mode = good（【AI】前缀正常译）/ echo（原样回显=假译文）/ error（500） */
function startSwitchableMock(port) {
  let mode = 'good';
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.url.endsWith('/chat/completions')) {
      let data = '';
      req.on('data', c => (data += c));
      req.on('end', () => {
        if (mode === 'error') { res.writeHead(500); return res.end('mock down'); }
        const body = JSON.parse(data);
        const user = body.messages.find(m => m.role === 'user')?.content || '';
        const numbered = user.split(/文本：\n/)[1] || '';
        const out = numbered.split('\n').map(line => {
          const m = line.match(/^\[(\d+)\] (.*)$/);
          if (!m) return line;
          return mode === 'echo' ? line : `[${m[1]}] 【AI】${m[2]}`;
        }).join('\n');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: out }, finish_reason: 'stop' }] }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => {
    Object.defineProperty(server, 'mode', { get: () => mode, set: m => { mode = m; } });
    r(server);
  }));
}

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-aifail'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startSwitchableMock(18947);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-aifail'), {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await injectAISettings(sw, 18947);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route => {
    if (new URL(route.request().url()).pathname === PAGE_PATH) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub' });
  });
  await page.goto('https://wiki.warframe.com' + PAGE_PATH, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.body.style.overflowY = 'auto'; document.documentElement.style.overflowY = 'auto'; });

  const waitStable = async (maxMs = 40000) => {
    let last = -1, stable = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs && stable < 4) {
      await new Promise(r => setTimeout(r, 1000));
      const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
      stable = n === last ? stable + 1 : 0;
      last = n;
    }
  };
  const scrollAll = async () => {
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) {
        document.documentElement.scrollTop = y;
        document.body.scrollTop = y;
        await new Promise(r => setTimeout(r, 80));
      }
    });
  };
  const toggle = () => page.evaluate(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', ctrlKey: true, altKey: true, bubbles: true }));
  });
  const paraTrs = () => page.evaluate(() => {
    const para = [...document.querySelectorAll('#mw-content-text p')].find(p => p.textContent.includes('In order to access The Steel Path'));
    if (!para) return [];
    const out = [];
    let sib = para.nextElementSibling;
    for (let i = 0; i < 3 && sib; i++) {
      if (sib.classList.contains('tw-tr')) out.push(sib.textContent.trim().slice(0, 60));
      sib = sib.nextElementSibling;
    }
    return out;
  });
  // 页面上是否渲染了 AI 假译文（echo 模式下译文不会有【AI】前缀，检测方式: mock good 模式译文必带【AI】）
  const aiRenders = () => page.evaluate(() =>
    [...document.querySelectorAll('.tw-tr')].filter(t => t.textContent.includes('【AI】')).length);
  const totalTrs = () => page.evaluate(() => document.querySelectorAll('.tw-tr').length);

  // ---- 阶段 1: echo 模式，首屏翻译 ----
  server.mode = 'echo';
  await new Promise(r => setTimeout(r, 1500)); // 等首屏块入队发出
  await waitStable();
  const t1 = await totalTrs();
  const p1 = await paraTrs();
  console.log('阶段1(echo):', JSON.stringify({ totalTrs: t1, paraTrs: p1 }));
  if (p1.length) throw new Error('FAIL: echo 假译文块被渲染（应静默跳过等待补翻）: ' + JSON.stringify(p1));
  if (t1 === 0) throw new Error('FAIL: 词典终局块应照常渲染');

  // ---- 阶段 2: 仍 echo，滚动放行挂起块（失败块搭车补翻一次，仍失败须保持静默）----
  await scrollAll();
  await waitStable();
  const t2 = await totalTrs();
  const p2 = await paraTrs();
  console.log('阶段2(echo+滚动):', JSON.stringify({ totalTrs: t2, paraTrs: p2 }));
  if (p2.length) throw new Error('FAIL: 搭车补翻后（仍失败）不得渲染假译文');
  if (t2 <= t1) throw new Error('FAIL: 滚动后词典终局块应增加渲染');

  // ---- 阶段 3: 接口恢复，Ctrl+Alt+D 两连（隐藏→重新显示）手动补翻 ----
  server.mode = 'good';
  await toggle();
  await new Promise(r => setTimeout(r, 800));
  await toggle();
  await waitStable();
  const p3 = await paraTrs();
  const ai3 = await aiRenders();
  console.log('阶段3(恢复+快捷键):', JSON.stringify({ paraTrs: p3, aiRenders: ai3 }));
  if (!p3.length) throw new Error('FAIL: 接口恢复后手动补翻未生效');
  if (!/【AI】In order to access/.test(p3[0])) throw new Error('FAIL: 补翻译文不是 AI 结果: ' + p3[0]);

  await ctx.close();
  server.close();
  console.log('PASS');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
