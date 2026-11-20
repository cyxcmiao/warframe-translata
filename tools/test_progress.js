/**
 * test_progress.js — 顶部进度条专项回归
 * 用法: node tools/test_progress.js
 * 慢 AI（每批延迟 1.5s）触发防闪烁窗口之外的波次:
 * 覆盖: 翻译进行中出现进度条宿主（#tw-progress-host，show() 才创建）→ 波次结束译文照常渲染 →
 *       停留+淡出复位（closed shadow 外部不可见，截图目检 top 条带）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = path.join(__dirname, '.tmp', 'slash_dash.html');
const PAGE_PATH = '/w/Slash_Dash';
const DELAY_MS = 1500;

const HTML = fs.readFileSync(HTML_PATH, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout: ' + label);
    await new Promise(r => setTimeout(r, 200));
  }
}

(async () => {
  // 持久 profile 会残留陈旧的 SW 注册状态（扩展重建后 SW 不换新），每次清空保证确定性
  const profile = path.join(__dirname, '.tmp', 'profile-progress');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    deviceScaleFactor: 2,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const errors = [];
  ctx.on('page', p => p.on('pageerror', e => errors.push(String(e))));

  let sw = await waitFor(() => ctx.serviceWorkers().find(s => s.url().includes('background')), 15000, 'service worker');
  const server = await startMockAI(8795, DELAY_MS);
  await injectAISettings(sw, 8795);

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route => {
    if (new URL(route.request().url()).pathname === PAGE_PATH) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub' });
  });
  await page.goto('https://wiki.warframe.com' + PAGE_PATH, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  // 翻译进行中（AI 慢响应 > 300ms 防闪烁窗口）：进度条宿主应已创建显示
  await waitFor(() => page.evaluate(() => !!document.getElementById('tw-progress-host')), 10000, 'progress host during pending wave');
  console.log('progress host shown during pending wave: ok');
  await page.screenshot({ path: path.join(__dirname, '.tmp', 'shot-progress-pending.png'), clip: { x: 0, y: 0, width: 800, height: 60 } });
  await page.screenshot({ path: path.join(__dirname, '.tmp', 'shot-progress-pending-zoom.png'), clip: { x: 560, y: 0, width: 160, height: 40 } });
  // 首个 AI 批次（1.5s）返回后再抓一张填充态
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(__dirname, '.tmp', 'shot-progress-fill-zoom.png'), clip: { x: 560, y: 0, width: 160, height: 40 } });

  // 波次结束：译文照常渲染
  await waitFor(() => page.evaluate(() => document.querySelectorAll('.tw-tr').length > 0), 60000, 'translated');
  // 等所有波次静止（800px 预翻带自动放行会触发后续波次）：数量 3s 不变视为结束
  let stableMs = 0;
  const deadline = Date.now() + 30000;
  let last = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
  while (stableMs < 3000 && Date.now() < deadline) {
    await page.waitForTimeout(500);
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    stableMs = n === last ? stableMs + 500 : 0;
    last = n;
  }
  console.log('translated:', last, '(stable)');

  // 停留 400ms + 淡出 350ms + 余量后截图（目检：胶囊应已消失）
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(__dirname, '.tmp', 'shot-progress-done.png'), clip: { x: 0, y: 0, width: 800, height: 60 } });
  console.log('screenshots saved (pending / done): .tmp/shot-progress-*.png');

  if (errors.length) {
    console.error('console errors:', errors);
    await ctx.close();
    server.close();
    process.exit(1);
  }
  await ctx.close();
  server.close();
  console.log('PASS');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
