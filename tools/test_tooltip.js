/**
 * test_tooltip.js — wiki 悬浮提示（Tooltip 扩展）按需翻译回归
 * 用法: node tools/test_tooltip.js
 * 站点行为（活站实测）: 提示内容预渲染在 #tooltip-storage（0 高隐藏容器，初始扫描
 * 按 SKIP_SEL 跳过），hover 触发器时站点 JS 把节点移入 #tooltip-wrapper 浮层。
 * 本测试用快照页模拟该移动，断言: 移入浮层后增量采集翻译，且含官方术语
 * 桎梏飞掷丸（Tether-Flechette orb，机制术语表复合词）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = path.join(__dirname, '.tmp', 'electric_shield.html');
const PAGE_PATH = '/w/Electric_Shield';

const HTML = fs.readFileSync(HTML_PATH, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout: ' + label);
    await new Promise(r => setTimeout(r, 300));
  }
}

(async () => {
  const profile = path.join(__dirname, '.tmp', 'profile-tooltip');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const sw = await waitFor(() => ctx.serviceWorkers().find(s => s.url().includes('background')), 15000, 'service worker');
  const server = await startMockAI(8812);
  await injectAISettings(sw, 8812);

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  page.on('pageerror', e => { console.error('[pageerror]', String(e).slice(0, 200)); process.exitCode = 1; });
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning' || t.includes('tw:dbg')) console.log('[console]', t.slice(0, 200)); });
  await page.route('https://wiki.warframe.com/**', route => {
    if (new URL(route.request().url()).pathname === PAGE_PATH) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub' });
  });
  await page.goto('https://wiki.warframe.com' + PAGE_PATH, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  // 首屏翻译稳定
  await waitFor(() => page.evaluate(() => document.querySelectorAll('.tw-tr').length > 0), 60000, 'auto translate');
  await page.waitForTimeout(3000);

  // 初始扫描必须跳过 #tooltip-storage（悬停前不翻）
  const before = await page.evaluate(() => {
    const storage = document.getElementById('tooltip-storage');
    const tip = storage?.querySelector('.main-tooltip');
    return {
      storageExists: !!storage,
      tipHasTr: !!(tip && tip.querySelector('.tw-tr')),
      bodyTr: document.querySelectorAll('.tw-tr').length,
    };
  });
  if (!before.storageExists) throw new Error('tooltip-storage missing in snapshot');
  if (before.tipHasTr) throw new Error('tooltip translated before hover (should be skipped)');
  console.log('initial scan skips tooltip-storage: ok');

  // 模拟站点 JS: 把 tooltip 节点移入固定定位浮层（活站 hover 时的真实行为）
  const moved = await page.evaluate(() => {
    const tip = [...document.querySelectorAll('#tooltip-storage .main-tooltip')].find(t => /Tether-Flechette/i.test(t.textContent || ''));
    if (!tip) return false;
    let wrapper = document.getElementById('tw-test-tip-layer');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'tw-test-tip-layer';
      wrapper.setAttribute('style', 'position: fixed; left: 200px; top: 120px; z-index: 6000000; width: 606px; display: block; background: #fff;');
      document.body.appendChild(wrapper);
    }
    wrapper.appendChild(tip);
    return true;
  });
  if (!moved) throw new Error('failed to simulate tooltip move');
  console.log('tooltip moved into wrapper: ok');

  // 移入后应增量采集翻译，且复合词按机制术语表正确翻译
  const reqsAtMove = server.chatRequests();
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1500);
    const dbg = await page.evaluate(() => ({
      tr: document.querySelectorAll('.tw-tr').length,
      tipTr: document.querySelectorAll('#tw-test-tip-layer .main-tooltip .tw-tr').length,
      tipTds: document.querySelectorAll('#tw-test-tip-layer .main-tooltip td').length,
      tipInBody: !!document.querySelector('#tw-test-tip-layer .main-tooltip'),
    }));
    console.log(`t+${((i + 1) * 1.5).toFixed(1)}s`, JSON.stringify(dbg), 'reqs:', server.chatRequests());
  }
  await waitFor(() => page.evaluate(() => {
    const tip = document.querySelector('#tw-test-tip-layer .main-tooltip');
    return !!tip && tip.querySelectorAll('.tw-tr').length > 0;
  }), 60000, 'tooltip translated after move');
  const checked = await page.evaluate(() => {
    const tip = document.querySelector('#tw-test-tip-layer .main-tooltip');
    const trs = [...tip.querySelectorAll('.tw-tr')].map(t => t.textContent);
    return {
      count: trs.length,
      hasCompound: trs.some(t => t.includes('桎梏飞掷丸')),
      sample: trs[0]?.slice(0, 120),
    };
  });
  if (!checked.hasCompound) {
    throw new Error('Tether-Flechette orb not translated to 桎梏飞掷丸, got: ' + JSON.stringify(checked.sample));
  }
  console.log(`tooltip translated after hover-move: ok (${checked.count} blocks, compound term correct)`);

  // 移回 storage（站点 mouseout 行为）：渲染应随节点保留，且不再重复翻译
  await page.evaluate(() => {
    const tip = document.querySelector('#tw-test-tip-layer .main-tooltip');
    document.getElementById('tooltip-storage').appendChild(tip);
  });
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => {
    const tip = [...document.querySelectorAll('#tooltip-storage .main-tooltip')].find(t => /Tether-Flechette/i.test(t.textContent || ''));
    return { kept: tip.querySelectorAll('.tw-tr').length };
  });
  if (!after.kept) throw new Error('rendered translations lost after move back');
  console.log('renders survive move back to storage: ok');

  await page.screenshot({ path: path.join(__dirname, '.tmp', 'shot-tooltip.png') });
  await ctx.close();
  server.close();
  if (process.exitCode === 1) process.exit(1);
  console.log('PASS');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
