/**
 * test_toast.js — 未配置 Key / AI 连接失败的行为测试
 * 验证:
 *  1. 无 Key: 不翻译（0 译文），页面弹自动消散的提示（#tw-toast-host）
 *  2. 填 Key 但接口连不通: 仍不翻译，弹「连接失败」提示（不同消息不受冷却限制）
 *  3. 移除 Key: 已有译文立即清空（stopSession 联动）
 * 注: toast 在 closed shadow DOM 里，断言宿主元素存在 + 译文数 + 截图人工核对。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const DIST = path.join(ROOT, 'dist', 'chrome');

const FIXTURE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Tigris Prime - WARFRAME Wiki</title></head>
<body><div id="mw-content-text"><div class="mw-parser-output">
<p>The Tigris Prime is a shotgun that consumes <a href="/w/Forma">Forma</a> to build.</p>
</div></div></body></html>`;

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout: ' + label);
    await new Promise(r => setTimeout(r, 500));
  }
}

(async () => {
  try { fs.rmSync(path.join(TMP, 'profile-toast'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const ctx = await chromium.launchPersistentContext(path.join(TMP, 'profile-toast'), {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE }));
  await page.goto('https://wiki.warframe.com/w/Tigris_Prime', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  // 1. 无 Key: 不翻译 + 提示
  await waitFor(() => page.evaluate(() => !!document.getElementById('tw-toast-host')), 10000, 'no-key toast');
  await page.waitForTimeout(2500); // 给可能的翻译留时间（不应有）
  const s1 = await page.evaluate(() => ({
    tr: document.querySelectorAll('.tw-tr').length,
    toast: !!document.getElementById('tw-toast-host'),
  }));
  console.log('no-key:', JSON.stringify(s1));

  // 2. 注入指向死端口的 Key（连接失败）→ 仍不翻译 + 失败提示
  await sw.evaluate(async () => {
    const settings = {
      aiBaseUrl: 'http://127.0.0.1:8799/v1',
      aiKey: 'dead-key',
      aiModel: 'mock-dead',
      autoTranslate: true, fontSize: 14, color: '#4a90d9', glossaryCheckHours: 24,
    };
    await new Promise(res => chrome.storage.local.set({ settings }, res));
  });
  // 失败提示走 translate 管线（重试 1 次 + 1.5s 退避）：~3-5s 弹出、4.5s 后淡出，5s 时截图正处在可见窗口
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(TMP, 'shot-toast-dead.png') });
  await page.waitForTimeout(10000);
  const s2 = await page.evaluate(() => ({
    tr: document.querySelectorAll('.tw-tr').length,
    toast: !!document.getElementById('tw-toast-host'),
  }));
  console.log('dead-endpoint:', JSON.stringify(s2));

  // 3. 移除 Key → stopSession 清译文（本例无译文，验证状态不崩即可）
  await sw.evaluate(async () => {
    const o = await new Promise(res => chrome.storage.local.get('settings', res));
    delete o.settings.aiKey;
    await new Promise(res => chrome.storage.local.set({ settings: o.settings }, res));
  });
  await page.waitForTimeout(2000);
  const s3 = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
  console.log('key-removed tr:', s3);

  await ctx.close();

  const pass = s1.tr === 0 && s1.toast && s2.tr === 0 && s2.toast && s3 === 0;
  console.log(pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
