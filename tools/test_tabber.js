/**
 * test_tabber.js — Tabber 页回归（Nightwatch Corps 页"卡住"复现）
 * 用法: node tools/test_tabber.js
 *
 * 背景（2026-11-21 真站复现 Nightwatch Corps 页两个问题，fixture 内嵌迷你 tabber JS
 * 复刻站点 Tabber 生命周期：运行时生成 tabbernav、display:none 隐藏面板、点击切换）：
 * 1. watchUrl 曾按 location.href（含 hash）判换页：tabber tab 点击（写 hash）、
 *    TOC/引文锚点都触发"SPA 换页"→ clearTranslations 清空整页译文重翻。
 *    修：只比较 pathname+search。断言：tab 点击与锚点点击后译文节点原样保留。
 * 2. tabbernav 的 tab 标签被增量采集，译文块插进 <li> 撑出假 tab 条。
 *    修：SKIP_SEL 加 .tabbernav。断言：导航内零译文块、标签保持英文。
 * 3. 隐藏面板（display:none → 零高度/无盒子）不白翻；点击 tab 显示后由 IO 放行翻译。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = path.join(__dirname, '.tmp', 'tabber_fixture.html');
const PAGE_PATH = '/w/Nightwatch_Corps';
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-tabber'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(18956);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-tabber'), {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await injectAISettings(sw, 18956);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route => {
    if (new URL(route.request().url()).pathname === PAGE_PATH) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub' });
  });
  await page.goto('https://wiki.warframe.com' + PAGE_PATH, { waitUntil: 'domcontentloaded' });
  let last = -1, stable = 0;
  for (let i = 0; i < 30 && stable < 5; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    stable = n === last ? stable + 1 : 0;
    last = n;
  }

  const state = () => page.evaluate(() => {
    const nav = document.querySelector('.tabbernav');
    const panel = t => document.querySelector(`.tabbertab[data-title="${t}"]`);
    const trOf = el => el.querySelectorAll('.tw-tr').length;
    return {
      navTr: nav ? nav.querySelectorAll('.tw-tr').length : -1,
      navLabelEn: nav ? /Brunt Lancer/.test(nav.textContent) && !/【AI】/.test(nav.textContent) : false,
      bruntTr: trOf(panel('Brunt Lancer')),
      // 裸文本面板的译文必须在原文之下（面板末尾），不得插到面板顶部空占位 p 之前
      bruntZhAtEnd: !!panel('Brunt Lancer')?.lastElementChild?.classList.contains('tw-tr'),
      clawTr: trOf(panel('Powerclaw')),
      dareTr: trOf(panel('Daremaker')),
      clawShown: panel('Powerclaw').style.display !== 'none',
    };
  });

  const r = await state();
  console.log('stage1:', JSON.stringify(r));

  // tab 点击 = hash 变化（复刻站点 data-hash 导航）：译文节点必须原样保留，
  // 新面板显示后由 IO 放行翻译
  await page.evaluate(() => document.querySelector('.tabbertab .tw-tr')?.setAttribute('data-marker', 'keepme'));
  await page.click('.tabbernav li:nth-of-type(2) a');
  let after = null;
  for (let i = 0; i < 12; i++) {
    await new Promise(r2 => setTimeout(r2, 1000));
    after = await state();
    if (after.clawTr > 0 && after.bruntTr > 0) break;
  }
  const marker = await page.evaluate(() => ({
    kept: !!document.querySelector('[data-marker="keepme"]'),
    hash: location.hash,
  }));
  console.log('after tab2 click:', JSON.stringify({ ...after, ...marker }));

  await page.click('.tabbernav li:nth-of-type(3) a');
  let after3 = null;
  for (let i = 0; i < 12; i++) {
    await new Promise(r2 => setTimeout(r2, 1000));
    after3 = await state();
    if (after3.dareTr > 0) break;
  }
  console.log('after tab3 click:', JSON.stringify(after3));

  // 锚点链接（TOC/引文同型）：hash 变化不清空译文
  await page.click('a[href="#tab2"]');
  await new Promise(r2 => setTimeout(r2, 4000)); // 覆盖 800ms watcher 轮询 + 800ms 重启延迟
  const anchor = await page.evaluate(() => ({
    kept: !!document.querySelector('[data-marker="keepme"]'),
    tr: document.querySelectorAll('.tw-tr').length,
    hash: location.hash,
  }));
  console.log('after anchor click:', JSON.stringify(anchor));

  await ctx.close();
  server.close();

  const ok = r.navTr === 0 && r.navLabelEn && r.bruntTr > 0 && r.bruntZhAtEnd && r.clawTr === 0 && r.dareTr === 0
    && after && after.clawTr > 0 && after.bruntTr > 0 && marker.kept && marker.hash === '#Powerclaw'
    && after3 && after3.dareTr > 0
    && anchor.kept && anchor.hash === '#tab2';
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
