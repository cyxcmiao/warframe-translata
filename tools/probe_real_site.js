/**
 * probe_real_site.js — 真实站点诊断探针（非断言测试）
 * 用法: node tools/probe_real_site.js [wiki路径]
 * 真网络访问 wiki.warframe.com + 扩展 + mock AI，报告翻译管线各环节状态。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const PAGE = process.argv[2] || '/w/Mods_1.0';

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-probe-real'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(18950);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-probe-real'), {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await injectAISettings(sw, 18950);

  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push(`[console.${m.type()}] ${m.text().slice(0, 300)}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
  await page.setViewportSize({ width: 1280, height: 900 });
  console.log('goto', 'https://wiki.warframe.com' + PAGE);
  await page.goto('https://wiki.warframe.com' + PAGE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // 给 CF 挑战页留时间
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const title = await page.title();
    if (!/just a moment|please wait/i.test(title)) break;
  }
  console.log('title:', await page.title());

  // 等正文出译文（最多 30s）
  let bodyTr = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const st = await page.evaluate(() => ({
      tr: document.querySelectorAll('.tw-tr').length,
      hasRoot: !!document.querySelector('#mw-content-text .mw-parser-output'),
      comments: !!document.querySelector('#ext-comments-container'),
      commentItems: document.querySelectorAll('#ext-comments-container .ext-comments-comment-item').length,
    }));
    bodyTr = st.tr;
    if (i === 3) console.log('t+4s state:', JSON.stringify(st));
    if (bodyTr > 0 && i > 5) break;
  }
  console.log('bodyTr:', bodyTr);
  console.log('--- console logs (tw/error) ---');
  for (const l of logs) if (/tw|error|Error/.test(l)) console.log(l.slice(0, 300));
  await ctx.close();
  server.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
