/**
 * gen_icons.js — 生成扩展图标（playwright chromium 渲染 SVG → PNG）
 * 用法: node tools/gen_icons.js（npm run icons）
 * 产物: extension/icons/icon{16,32,48,128}.png（打包进扩展）
 *       store/store_logo_300.png（300px logo 物料，不打进扩展包）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'extension', 'icons');
const SIZES = [16, 32, 48, 128, 300];

function svg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#16273f"/>
      <stop offset="1" stop-color="#0a1220"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22d3ee"/>
      <stop offset="1" stop-color="#2dd4bf"/>
    </linearGradient>
  </defs>
  <rect x="1" y="1" width="126" height="126" rx="28" fill="url(#bg)" stroke="#22d3ee" stroke-opacity="0.55" stroke-width="2.5"/>
  <text x="64" y="60" text-anchor="middle" dominant-baseline="central"
        font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif"
        font-weight="700" font-size="62" fill="#f1f5f9">译</text>
  <rect x="26" y="92" width="76" height="10" rx="5" fill="url(#bar)"/>
</svg>`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    // 版本目录与 playwright-core 不匹配时，回退到本机已装的最新 chromium
    const root = process.env.LOCALAPPDATA + '\\ms-playwright';
    const dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort();
    const exe = path.join(root, dirs[dirs.length - 1], 'chrome-win64', 'chrome.exe');
    console.log('fallback executable:', exe);
    browser = await chromium.launch({ executablePath: exe });
  }
  const page = await browser.newPage({ viewport: { width: 340, height: 340 } });
  await page.setContent('<body style="margin:0"><div id="icon"></div></body>');
  for (const size of SIZES) {
    await page.evaluate(html => { document.getElementById('icon').innerHTML = html; }, svg(size));
    const el = page.locator('#icon svg');
    if (size === 300) {
      const storeDir = path.join(ROOT, 'store');
      fs.mkdirSync(storeDir, { recursive: true });
      await el.screenshot({ path: path.join(storeDir, 'store_logo_300.png'), omitBackground: true });
    } else {
      await el.screenshot({ path: path.join(OUT, `icon${size}.png`), omitBackground: true });
    }
    console.log('wrote', size);
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
