/**
 * test_browser.js — 加载扩展到本机 Chrome 实测 wiki 页面
 * 用法: node tools/test_browser.js [url] [--ai]
 * 输出: 译文块统计 + 样例 + 截图 tools/.tmp/shot.png
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const DIST = path.join(ROOT, 'dist', 'chrome');
const URL_TO_TEST = process.argv[2] || 'https://warframe.fandom.com/wiki/Tigris_Prime';

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const context = await chromium.launchPersistentContext(path.join(TMP, 'profile'), {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
    ],
  });

  const logs = [];
  context.on('serviceworker', sw => console.log('SW registered:', sw.url()));
  context.on('page', p => p.on('console', m => logs.push(`[page.${m.type()}] ${m.text()}`)));
  context.on('console', m => logs.push(`[ctx.${m.type()}] ${m.text()}`));

  // 等 service worker 起来
  let sw = context.serviceWorkers().find(s => s.url().includes('background'));
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = context.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) console.log('!! background service worker not detected');
  else console.log('SW up:', sw.url());

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(URL_TO_TEST, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 等翻译完成（.tw-tr 出现并稳定）
  let counts = [];
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    counts.push(n);
    if (i > 6 && n === counts[counts.length - 4] && n > 0) break;
  }
  const result = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('.tw-tr')];
    return {
      count: trs.length,
      samples: trs.slice(0, 6).map(e => e.textContent.trim().slice(0, 80)),
      modes: {
        ai: trs.filter(e => e.dataset.twMode === 'ai').length,
        dict: trs.filter(e => e.dataset.twMode === 'dict').length,
      },
      fabText: document.querySelector('#tw-fab-host') ? 'fab-present' : 'fab-missing',
    };
  });
  console.log('RESULT:', JSON.stringify(result, null, 2));

  await page.screenshot({ path: path.join(TMP, 'shot.png') });
  console.log('screenshot saved');

  const errs = logs.filter(l => l.includes('error') || l.includes('Error') || l.includes('Uncaught'));
  console.log('console errors:', errs.length ? errs.slice(0, 10) : 'none');
  if (errs.length === 0) console.log('all logs tail:', logs.slice(-8));

  await context.close();
  process.exit(0);
})().catch(e => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
