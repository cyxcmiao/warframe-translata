/**
 * test_shortcut.js — 验证快捷键切换 翻译/隐藏译文，且可在设置中修改
 * 用法: node tools/test_shortcut.js
 * 快捷键由 content 脚本捕获页面 keydown 实现（shared/hotkey.ts），
 * Playwright page.keyboard 可派发真实按键事件命中该监听。
 * 覆盖: 默认 Ctrl+Alt+D 生效 → 改为 Ctrl+Shift+9（新键生效、旧键失效）→ 清空禁用。
 *       隐藏 = CSS 隐藏（DOM 保留），重新显示不重发 AI 请求（mock 请求数断言）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = process.argv[2] || path.join(__dirname, '.tmp', 'slash_dash.html');
const PAGE_PATH = process.argv[3] || '/w/Slash_Dash';

const HTML = fs.readFileSync(HTML_PATH, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout: ' + label);
    await new Promise(r => setTimeout(r, 500));
  }
}

/** .tw-tr 可见性：hidden 后 DOM 保留（CSS display:none），断言看可见数而非节点数 */
function trVisibility(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('.tw-tr')];
    return { total: els.length, visible: els.filter(el => getComputedStyle(el).display !== 'none').length };
  });
}

/** 等待 1.2s 确认 .tw-tr 可见性一直保持 expect 值（快捷键未触发/已禁用） */
async function expectStable(page, expect) {
  await page.waitForTimeout(1200);
  const v = await trVisibility(page);
  if (expect === 'shown' && !(v.total > 0 && v.visible === v.total)) {
    throw new Error('expected shown, got ' + JSON.stringify(v));
  }
  if (expect === 'hidden' && v.visible !== 0) throw new Error('expected hidden, got ' + JSON.stringify(v));
}

async function setShortcut(sw, value) {
  await sw.evaluate(async v => {
    const o = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...(o.settings || {}), toggleShortcut: v },
    });
  }, value);
}

(async () => {
  // 持久 profile 会残留陈旧的 SW 注册状态（扩展重建后 SW 不换新），每次清空保证确定性
  const profile = path.join(__dirname, '.tmp', 'profile-shortcut');
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

  let sw = await waitFor(() => ctx.serviceWorkers().find(s => s.url().includes('background')), 15000, 'service worker');
  // 未配置 Key 不翻译，注入指向本地 mock 接口的 AI 设置
  const server = await startMockAI(8794);
  await injectAISettings(sw, 8794);

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

  // autoTranslate 默认开 → 自动翻译出译文
  await waitFor(
    () => page.evaluate(() => document.querySelectorAll('.tw-tr').length > 0),
    30000,
    'auto translate',
  );
  const shown = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
  console.log('translated:', shown);
  // 等所有波次静止（首屏+800px 预翻带全部完成、无挂起补翻），再开始快捷键断言
  let last = shown;
  let stableMs = 0;
  const stableDeadline = Date.now() + 30000;
  while (stableMs < 2500 && Date.now() < stableDeadline) {
    await page.waitForTimeout(500);
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    stableMs = n === last ? stableMs + 500 : 0;
    last = n;
  }
  console.log('stable at', last);

  // 默认 Ctrl+Alt+D → 隐藏（CSS 隐藏，DOM 保留，不重发 AI 请求）→ 再按 → 瞬时恢复
  const reqsBefore = server.chatRequests();
  await page.keyboard.press('Control+Alt+D');
  await waitFor(async () => {
    const v = await trVisibility(page);
    return v.total > 0 && v.visible === 0;
  }, 5000, 'hide by Ctrl+Alt+D');
  console.log('default Ctrl+Alt+D hide: ok');
  await page.keyboard.press('Control+Alt+D');
  await waitFor(async () => {
    const v = await trVisibility(page);
    return v.total > 0 && v.visible === v.total;
  }, 5000, 'show by Ctrl+Alt+D');
  console.log('default Ctrl+Alt+D show: ok');
  await page.waitForTimeout(1000);
  const reqsAfter = server.chatRequests();
  if (reqsAfter !== reqsBefore) {
    throw new Error(`re-show re-requested AI: ${reqsBefore} -> ${reqsAfter}`);
  }
  console.log(`re-show without re-request: ok (${reqsAfter} chat requests total)`);

  // 改快捷键为 Ctrl+Shift+9：旧键失效，新键生效
  await setShortcut(sw, 'Ctrl+Shift+9');
  await page.keyboard.press('Control+Alt+D');
  await expectStable(page, 'shown');
  console.log('old Ctrl+Alt+D ignored after change: ok');
  await page.keyboard.press('Control+Shift+9');
  await waitFor(async () => {
    const v = await trVisibility(page);
    return v.total > 0 && v.visible === 0;
  }, 5000, 'hide by Ctrl+Shift+9');
  console.log('new Ctrl+Shift+9 hide: ok');
  await page.keyboard.press('Control+Shift+9');
  await waitFor(async () => {
    const v = await trVisibility(page);
    return v.total > 0 && v.visible === v.total;
  }, 5000, 'show by Ctrl+Shift+9');
  console.log('new Ctrl+Shift+9 show: ok');

  // 清空 = 禁用：按键无效果
  await setShortcut(sw, '');
  await page.keyboard.press('Control+Shift+9');
  await expectStable(page, 'shown');
  console.log('disabled shortcut ignored: ok');

  await page.screenshot({ path: path.join(__dirname, '.tmp', 'shot-shortcut.png') });
  await ctx.close();
  server.close();

  console.log('PASS');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
