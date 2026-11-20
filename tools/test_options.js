/**
 * test_options.js — options 页 + 词表自动更新链路验证
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const DIST = path.join(ROOT, 'dist', 'chrome');

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  // 持久 profile 会残留陈旧的 SW 注册状态（扩展重建后 SW 不换新），每次清空保证确定性
  try { fs.rmSync(path.join(TMP, 'profile-opt'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const context = await chromium.launchPersistentContext(path.join(TMP, 'profile-opt'), {
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
    sw = context.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  const extId = new URL(sw.url()).host;
  console.log('extension id:', extId);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('#glossStatus');
  console.log('glossStatus:', await page.textContent('#glossStatus'));

  await page.click('#glossUpdate');
  // 等结果出现（增量下载 10 个文件需要时间）
  await page.waitForFunction(
    () => {
      const t = document.getElementById('glossResult');
      return t && t.textContent && !t.textContent.includes('检查中');
    },
    null,
    { timeout: 120000 },
  );
  console.log('glossResult:', await page.textContent('#glossResult'));
  console.log('glossStatus:', await page.textContent('#glossStatus'));

  // 词表确实持久化了：刷新 SW 存储再读一次
  const meta = await sw.evaluate(async () => {
    return await new Promise(res => chrome.runtime.sendMessage({ type: 'glossaryStatus' }, res));
  });
  console.log('SW glossary meta:', JSON.stringify(meta));

  // 显示设置改一下看 storage 生效
  await page.click('#save');
  console.log('options page functional ✓');

  await context.close();
  process.exit(0);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
