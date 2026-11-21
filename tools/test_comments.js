/**
 * test_comments.js — Yappin 评论区翻译回归
 * 用法: node tools/test_comments.js
 *
 * 背景: Yappin 在页面加载时只挂载空容器（#ext-comments-container 位于
 * #mw-content-text 之外），评论项要等用户滚动到评论区才由前端注入。
 * content 管线靠 MutationObserver 增量采集这些评论项 —— 本测试验证
 * 滚动到评论区后评论正文出现译文（且正文控制组不受影响）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = path.join(__dirname, '.tmp', 'comments_fixture.html');
const PAGE_PATH = '/w/Comments_Fixture';
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

async function setCommentsSetting(sw, on) {
  await sw.evaluate(async (on) => {
    const settings = await new Promise(res => chrome.storage.local.get('settings', r => res(r.settings)));
    settings.translateComments = on;
    await new Promise(res => chrome.storage.local.set({ settings }, res));
  }, on);
}

async function waitCommentTr(page, timeoutRounds = 16) {
  let n = 0;
  for (let i = 0; i < timeoutRounds; i++) {
    await new Promise(r => setTimeout(r, 500));
    n = await page.evaluate(() => document.querySelectorAll('#ext-comments-container .tw-tr').length);
    if (n > 0) break;
  }
  return n;
}

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-comments'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(18949);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-comments'), {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await injectAISettings(sw, 18949);

  const page = await ctx.newPage();
  const consoleLogs = [];
  page.on('console', m => {
    const t = m.text();
    if (t.includes('[tw') || m.type() === 'error') consoleLogs.push(`[${m.type()}] ${t}`);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route => {
    if (new URL(route.request().url()).pathname === PAGE_PATH) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub' });
  });

  // ── 场景 A（回归护栏）: 开关默认开，滚动触发 Yappin 注入，MutationObserver 增量采集 ──
  await page.goto('https://wiki.warframe.com' + PAGE_PATH, { waitUntil: 'domcontentloaded' });
  let bodyTr = 0;
  for (let i = 0; i < 20 && bodyTr === 0; i++) {
    await new Promise(r => setTimeout(r, 500));
    bodyTr = await page.evaluate(() => document.querySelectorAll('.mw-parser-output .tw-tr').length);
  }
  await page.evaluate(() => document.querySelector('.ext-comments-comments-list').scrollIntoView({ block: 'center' }));
  const trA = await waitCommentTr(page);
  console.log(`A 滚动注入: body=${bodyTr} comment=${trA}`);

  // ── 场景 B（刷新即评论在视口）: 评论项先于 content script 会话就位 ──
  await page.goto('https://wiki.warframe.com' + PAGE_PATH + '?pre=1', { waitUntil: 'domcontentloaded' });
  bodyTr = 0;
  for (let i = 0; i < 20 && bodyTr === 0; i++) {
    await new Promise(r => setTimeout(r, 500));
    bodyTr = await page.evaluate(() => document.querySelectorAll('.mw-parser-output .tw-tr').length);
  }
  const trB = await (async () => {
    await page.evaluate(() => document.querySelector('.ext-comments-comments-list').scrollIntoView({ block: 'center' }));
    return waitCommentTr(page);
  })();
  console.log(`B 预先就位: body=${bodyTr} comment=${trB}`);

  // ── 场景 C（用户实际操作）: 关→开切换后已就位的评论必须补翻 ──
  // 评论项随初始 HTML 就位（pre=1），开关关闭期间被跳过；切开后 startSession
  // 必须把 #ext-comments-container（位于正文根之外）补采进来
  await setCommentsSetting(sw, false);
  await new Promise(r => setTimeout(r, 1500)); // 等关闭切换的重开会话完成
  await page.goto('https://wiki.warframe.com' + PAGE_PATH + '?pre=2', { waitUntil: 'domcontentloaded' });
  bodyTr = 0;
  for (let i = 0; i < 20 && bodyTr === 0; i++) {
    await new Promise(r => setTimeout(r, 500));
    bodyTr = await page.evaluate(() => document.querySelectorAll('.mw-parser-output .tw-tr').length);
  }
  await new Promise(r => setTimeout(r, 2000)); // 等增量采集把评论项跳过（tc=false）
  const preToggleTr = await page.evaluate(() => document.querySelectorAll('#ext-comments-container .tw-tr').length);
  await setCommentsSetting(sw, true);
  const trC = await (async () => {
    await page.evaluate(() => document.querySelector('.ext-comments-comments-list').scrollIntoView({ block: 'center' }));
    return waitCommentTr(page);
  })();
  console.log(`C 关→开切换: body=${bodyTr} 切换前评论=${preToggleTr} 切换后评论=${trC}`);

  const detail = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#ext-comments-container .ext-comments-comment-item')];
    return {
      items: items.length,
      itemTr: items.filter(i => i.querySelector('.tw-tr')).length,
      trTexts: [...document.querySelectorAll('#ext-comments-container .tw-tr')].map(t => t.textContent.trim().slice(0, 60)),
    };
  });
  console.log('final detail:', JSON.stringify(detail));
  if (consoleLogs.length) console.log('console:\n' + consoleLogs.slice(0, 20).join('\n'));

  await ctx.close();
  server.close();

  const ok = bodyTr > 0 && trA > 0 && trB > 0 && trC > 0 && detail.itemTr === detail.items;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
