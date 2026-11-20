/**
 * test_real_page.js — 用用户保存的真实页面 HTML 做端到端回归
 * 用法: node tools/test_real_page.js [html路径] [url路径]
 * 通过路由拦截把真实 DOM 提供给扩展（绕过 Cloudflare）。
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

// 去掉脚本，避免保存页里的统计/反调试代码干扰
const HTML = fs.readFileSync(HTML_PATH, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');

(async () => {
  // 持久 profile 会残留陈旧的 SW 注册状态，每次清空保证确定性
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-real'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(8796);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-real'), {
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
  // 未配置 Key 不翻译：注入指向本地 mock 的 AI 设置
  await injectAISettings(sw, 8796);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route => {
    if (new URL(route.request().url()).pathname === PAGE_PATH) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub' });
  });
  await page.goto('https://wiki.warframe.com' + PAGE_PATH, { waitUntil: 'domcontentloaded' });

  let counts = [];
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    counts.push(n);
    if (i > 6 && n === counts[counts.length - 4] && n > 0) break;
  }

  const r = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('.tw-tr')];
    const outerLi = [...document.querySelectorAll('li')].find(li => li.textContent.replace(/\s+/g, '').startsWith('Excaliburexpends25Energy'));
    const nestedUl = outerLi ? outerLi.querySelector('ul, ol') : null;
    const outerTrs = outerLi ? trs.filter(t => t.parentElement === outerLi) : [];
    const jsonTrs = trs.filter(t => /^\s*[\[{]/.test(t.textContent) && /":/.test(t.textContent));
    return {
      total: trs.length,
      modes: {
        ai: trs.filter(t => t.dataset.twMode === 'ai').length,
        dict: trs.filter(t => t.dataset.twMode === 'dict').length,
      },
      outerLiFound: !!outerLi,
      nestedUlFound: !!nestedUl,
      outerTrCount: outerTrs.length,
      allBeforeNested: outerTrs.length > 0 && !!nestedUl && outerTrs.every(t => !!(nestedUl.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING)),
      jsonBlocks: jsonTrs.length,
      samples: trs.slice(0, 5).map(t => t.textContent.trim().slice(0, 60)),
    };
  });
  console.log(JSON.stringify(r, null, 2));
  // TW_GREP=关键词: 逐屏滚动放行挂起块，静止后打印含该词的译文块（诊断特定短语译法用）
  if (process.env.TW_GREP) {
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    });
    let lastTr = -1;
    let stable = 0;
    for (let i = 0; i < 40 && stable < 4; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
      stable = n === lastTr ? stable + 1 : 0;
      lastTr = n;
    }
    const hits = await page.evaluate(needle => {
      return [...document.querySelectorAll('.tw-tr')]
        .filter(t => t.textContent.includes(needle))
        .map(t => t.textContent.trim().slice(0, 200));
    }, process.env.TW_GREP);
    console.log('grep', JSON.stringify(process.env.TW_GREP), '→', JSON.stringify(hits, null, 1));
  }
  await page.screenshot({ path: path.join(__dirname, '.tmp', 'shot-real.png'), fullPage: false });
  await ctx.close();
  server.close();
  const pass = r.total > 0 && r.outerLiFound && r.nestedUlFound && r.outerTrCount > 0 && r.allBeforeNested && r.jsonBlocks === 0;
  console.log(pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
