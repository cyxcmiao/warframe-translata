/**
 * probe_nightwatch_stall.js — Nightwatch Corps 页翻译卡住诊断
 * 用法: node tools/probe_nightwatch_stall.js [html路径] [url路径]
 *
 * 观察: 译文块数量时间线、进度胶囊是否滞留、AI 请求计数、控制台/页面报错，
 * 定位"卡住"发生在哪一环。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = process.argv[2] || path.join(__dirname, '.tmp', 'Nightwatch Corps - WARFRAME Wiki.html');
const PAGE_PATH = process.argv[3] || '/w/Nightwatch_Corps';
const HTML = fs.readFileSync(HTML_PATH, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-nwc'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(18953);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-nwc'), {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await injectAISettings(sw, 18953);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  const dbg = [];
  const errors = [];
  page.on('console', m => {
    const t = m.text();
    if (t.includes('[twdbg]')) dbg.push(t.slice(0, 160));
    else if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${t.slice(0, 200)}`);
  });
  page.on('pageerror', e => errors.push(`[pageerror] ${String(e).slice(0, 300)}`));
  await page.route('https://wiki.warframe.com/**', route => {
    if (new URL(route.request().url()).pathname === PAGE_PATH) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub' });
  });
  await page.goto('https://wiki.warframe.com' + PAGE_PATH, { waitUntil: 'domcontentloaded' });

  // 滚动扫过全页触发懒翻译，然后回顶
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });

  const timeline = [];
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await page.evaluate(() => {
      // 注意：#tw-progress-host 宿主常驻 DOM（淡出只是 shadow 内 bar 的 opacity），
      // 且 shadow 为 closed —— 探针无法从外部判断胶囊可视状态，只能跟踪译文/请求曲线
      return {
        tr: document.querySelectorAll('.tw-tr').length,
        aiFlag: [...document.querySelectorAll('.tw-tr')].filter(t => t.dataset.twMode === 'ai').length,
        dictFlag: [...document.querySelectorAll('.tw-tr')].filter(t => t.dataset.twMode === 'dict').length,
      };
    });
    timeline.push({ t: i + 1, ...s, aiReq: server.chatRequests() });
    const n = timeline.length;
    if (n >= 8) {
      const last8 = timeline.slice(-8);
      if (last8.every(x => x.tr === last8[0].tr && x.aiReq === last8[0].aiReq)) { timeline.push({ note: 'stable 8s' }); break; }
    }
  }
  console.log(JSON.stringify(timeline, null, 1));
  console.log('--- twdbg timeline (last 60) ---');
  console.log(dbg.slice(-60).join('\n') || '(none)');
  console.log('--- errors ---');
  console.log(errors.slice(0, 20).join('\n') || '(none)');
  await page.screenshot({ path: path.join(__dirname, '.tmp', 'nightwatch_stall.png'), fullPage: false });
  console.log('screenshot: tools/.tmp/nightwatch_stall.png');
  await ctx.close();
  server.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
