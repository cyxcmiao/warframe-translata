/**
 * probe_searchbox_state.js — 诊断:输入「电击」后 6 秒内的菜单/候选动态
 * 每 300ms 记录 {url, ul存在, 站点条目数, 我们的条目数, 菜单hidden}
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-probe-search2'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(18953);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-probe-search2'), {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await injectAISettings(sw, 18953);

  const page = await ctx.newPage();
  page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('NAVIGATED:', f.url()); });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('https://wiki.warframe.com/wiki/WARFRAME', { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const title = await page.title();
    if (!/just a moment|please wait|请稍候/i.test(title)) break;
  }
  await page.waitForSelector('#searchInput', { timeout: 15000 });
  // 站点会把 /wiki/X 302 到 /w/X：等 URL 与 DOM 都落定再交互，避免在将被替换的文档上打字
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (/\/w\//.test(page.url())) break;
  }
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForSelector('#searchInput', { timeout: 15000 });
  console.log('settled url:', page.url());

  await page.click('#searchInput');
  const TERM = process.argv[2] || '电击';
  await page.keyboard.type(TERM, { delay: 80 });
  console.log('typed:', TERM);
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    const st = await page.evaluate(() => {
      const menu = document.querySelector('#p-search .cdx-menu');
      const ul = document.querySelector('#p-search .cdx-menu__listbox');
      const ours = ul ? [...ul.querySelectorAll('li.tw-zh-item')] : [];
      return {
        path: location.pathname,
        menuHidden: menu ? menu.hidden || menu.getAttribute('aria-hidden') === 'true' || getComputedStyle(menu).display === 'none' : 'no-menu',
        ours: ours.length,
        labels: ours.slice(0, 8).map(li => li.querySelector('.cdx-menu-item__text__label')?.textContent?.trim() ?? ''),
        descs: ours.slice(0, 8).map(li => li.querySelector('.cdx-menu-item__text__description')?.textContent?.trim() ?? ''),
      };
    });
    console.log(`t+${(i * 0.3).toFixed(1)}s`, JSON.stringify(st));
    if (st.ours > 0 && i > 2) break;
  }
  await ctx.close();
  server.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
