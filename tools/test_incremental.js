/**
 * test_incremental.js — 增量翻译测试（模拟评论懒加载注入）
 * 验证：
 *  1. 首屏翻译正常
 *  2. 之后注入的 .comment-body（Yappin 评论）被自动增量翻译（词典命中与未命中都出译文）
 *  3. 普通无选择器 div 不会被误翻
 *  4. 重复触发翻译不产生重复译文块（doneEls + 缓存）
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
  // 持久 profile 会残留陈旧的 SW 注册状态与 AI 设置，每次清空并注入 mock 保证确定性
  const profile = path.join(__dirname, '.tmp', 'profile-incr');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(8809);
  const ctx = await chromium.launchPersistentContext(profile, {
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
  await injectAISettings(sw, 8809);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE }));
  await page.goto('https://wiki.warframe.com/w/Slash_Dash', { waitUntil: 'domcontentloaded' });

  // 等首屏翻译
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await page.evaluate(() => document.querySelectorAll('.tw-tr').length) > 0) break;
  }
  const first = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
  console.log('first-wave blocks:', first);

  // 模拟 3 秒后评论懒加载注入（Yappin 结构）
  await page.evaluate(() => {
    setTimeout(() => {
      const sec = document.createElement('div');
      sec.className = 'comment-section';
      sec.innerHTML = [
        '<div class="comment-body">I love the Tigris Prime, it deals massive damage.</div>',
        '<div class="comment-body">Just wow, amazing update!</div>',
        '<div class="plain-div">This plain div is not a block selector, should stay untranslated.</div>',
      ].join('');
      document.querySelector('.mw-parser-output').appendChild(sec);
    }, 1500);
  });

  await page.waitForTimeout(8000);
  const r = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('.tw-tr')];
    const commentTr = trs.find(t => t.textContent.includes('猛虎 Prime') && t.textContent.includes('comment'));
    const byText = s => trs.filter(t => t.textContent.includes(s));
    const plainDiv = document.querySelector('.plain-div');
    const plainTranslated = plainDiv && [...plainDiv.children].some(c => c.classList.contains('tw-tr'));
    const plainAfter = plainDiv && plainDiv.nextElementSibling?.classList.contains('tw-tr');
    return {
      total: trs.length,
      commentTranslated: trs.some(t => t.textContent.includes('猛虎 Prime') && t.textContent.includes('massive')),
      noMatchCommentSkipped: byText('wow').length === 1, // mock AI 下无命中评论也出译文
      plainUntouched: !plainTranslated && !plainAfter,
    };
  });

  // 再触发一次全量翻译（popup 翻译此页），不应产生重复块
  await page.evaluate(() => new Promise(res => {
    // 通过 storage 触发等价路径太绕，直接调内容脚本入口消息
    // （popup 的 translateNow 走 tabs.sendMessage，这里等价模拟）
    const ev = new CustomEvent('tw-test');
    window.dispatchEvent(ev);
    res();
  }));
  const r2 = await page.evaluate(() => {
    return new Promise(res => {
      chrome.storage.onChanged && res(true);
    });
  }).catch(() => null);
  void r2;
  // 直接通过后台触发 translateNow（sw 已在启动时获取）
  await sw.evaluate(async () => {
    const tabs = await new Promise(res => chrome.tabs.query({}, res));
    for (const t of tabs) {
      if (t.id) chrome.tabs.sendMessage(t.id, { type: 'translateNow' }, () => void chrome.runtime.lastError);
    }
  });
  await page.waitForTimeout(6000);
  const afterRetrig = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);

  console.log(JSON.stringify({ ...r, afterRetrig, first }, null, 2));
  const pass = first > 0 && r.total > first && r.commentTranslated && r.noMatchCommentSkipped && r.plainUntouched && afterRetrig === r.total;
  console.log(pass ? 'PASS' : 'FAIL');
  await ctx.close();
  server.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(1); });
