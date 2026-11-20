/**
 * test_no_comments.js — "翻译用户评论"开关测试
 * 验证：
 *  1. translateComments=false 时：评论区注入后不翻译，正文不受影响
 *  2. 设置切换为 true 后：立即补翻译评论（storage 变更触发会话重启，其余块走缓存）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');

const FIXTURE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Slash Dash - WARFRAME Wiki</title></head>
<body><div id="mw-content-text"><div class="mw-parser-output">
<p>The Tigris Prime is a shotgun. Pressure Point improves damage.</p>
</div></div></body></html>`;

(async () => {
  // 持久 profile 会残留陈旧的 SW 注册状态，每次清空保证确定性
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-nocmt'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(8795);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-nocmt'), {
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
  // 未配置 Key 不翻译：注入指向本地 mock 的 AI 设置（含 translateComments: false）
  await injectAISettings(sw, 8795, { translateComments: false });

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE }));
  await page.goto('https://wiki.warframe.com/w/Slash_Dash', { waitUntil: 'domcontentloaded' });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await page.evaluate(() => document.querySelectorAll('.tw-tr').length) > 0) break;
  }
  const first = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);

  // 注入评论（Yappin 结构：容器 #ext-comments-container）
  await page.evaluate(() => {
    setTimeout(() => {
      const sec = document.createElement('div');
      sec.id = 'ext-comments-container';
      sec.innerHTML = '<div class="comment-body">I love the Tigris Prime, it deals massive damage.</div>';
      document.querySelector('.mw-parser-output').appendChild(sec);
    }, 1200);
  });
  await page.waitForTimeout(6000);
  const off = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('.tw-tr')];
    return { total: trs.length, commentTranslated: trs.some(t => t.textContent.includes('猛虎 Prime') && t.textContent.includes('massive')) };
  });

  // 打开开关 → storage 变更触发重启会话 → 评论补翻译
  await sw.evaluate(async () => {
    const o = await new Promise(res => chrome.storage.local.get('settings', res));
    o.settings.translateComments = true;
    await new Promise(res => chrome.storage.local.set({ settings: o.settings }, res));
  });
  await page.waitForTimeout(8000);
  const on = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('.tw-tr')];
    return { total: trs.length, commentTranslated: trs.some(t => t.textContent.includes('猛虎 Prime') && t.textContent.includes('massive')), bodyStill: trs.some(t => t.textContent.includes('压迫点')) };
  });

  console.log(JSON.stringify({ first, off, on }, null, 2));
  const pass = first > 0 && !off.commentTranslated && off.total === first && on.commentTranslated && on.bodyStill;
  console.log(pass ? 'PASS' : 'FAIL');
  await ctx.close();
  server.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(1); });
