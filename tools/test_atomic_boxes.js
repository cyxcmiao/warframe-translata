/**
 * test_atomic_boxes.js — 纯链接容器（表头/目录项）翻译端到端回归
 * 复现 Atomic Fallout 页面（tools/.tmp/atomic_fallout.html，由 extract_mhtml.py 生成）：
 *  1. 目录 #toc：Contents 标题与各条目（纯链接 li）有译文，条目译文在 li 内部
 *  2. Stats 表纯链接表头（Rank / Magazine Capacity / Cost）有译文（此前被整块丢弃）
 *  3. 含文字的表头（Radiation Damage）不回归
 *  4. 掉落表纯链接单元格（Netracell Arcocanid 等）滚动放行后有译文
 *  5. 嵌套子列表的目录条目（2 Drop Locations）译文在自身文字之后、子列表之前
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = process.argv[2] || path.join(__dirname, '.tmp', 'atomic_fallout.html');
const PAGE_PATH = '/w/Atomic_Fallout';

const HTML = fs.readFileSync(HTML_PATH, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');

(async () => {
  // 持久 profile 会残留陈旧的 SW 注册状态，每次清空保证确定性
  const profile = path.join(__dirname, '.tmp', 'profile-atomic');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(8807);
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
  await injectAISettings(sw, 8807);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route => {
    if (new URL(route.request().url()).pathname === PAGE_PATH) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub' });
  });
  await page.goto('https://wiki.warframe.com' + PAGE_PATH, { waitUntil: 'domcontentloaded' });

  // 逐屏滚动放行挂起块，等译文数量稳定
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  let lastTr = -1;
  let stable = 0;
  for (let i = 0; i < 60 && stable < 5; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    stable = n === lastTr ? stable + 1 : 0;
    lastTr = n;
  }

  const r = await page.evaluate(() => {
    const thOf = name => [...document.querySelectorAll('th')]
      .find(t => t.textContent.replace(/\s+/g, ' ').trim().startsWith(name));
    const hasTr = el => !!el && !!el.querySelector(':scope > .tw-tr');
    const trText = el => (el && el.querySelector(':scope > .tw-tr')?.textContent.replace(/\s+/g, ' ').trim()) || '';

    // 目录条目: li 内部有译文块；嵌套子列表条目的译文在子列表之前
    const tocLis = [...document.querySelectorAll('#toc li')];
    const tocTrInLi = tocLis.filter(li => !!li.querySelector(':scope > .tw-tr')).length;
    const tocParent = [...document.querySelectorAll('#toc li')].find(li => li.querySelector('ul'));
    const tocParentOk = !!tocParent && (() => {
      const tr = tocParent.querySelector(':scope > .tw-tr');
      const ul = tocParent.querySelector('ul');
      return !!tr && !!(ul.compareDocumentPosition(tr) & Node.DOCUMENT_POSITION_PRECEDING);
    })();
    const tocHeadingTr = !!document.querySelector('#toc .toctitle h2 + .tw-tr, #toc h2 + .tw-tr');

    // 掉落表纯链接单元格（克隆剔除 .tw-tr 后比较原文，已翻译的 td 文本会包含译文）。
    // navbox 等有意跳过的区域除外 —— 那里的纯链接块不翻译是既有设计
    const pureTd = [...document.querySelectorAll('td')].filter(td => {
      if (td.closest('.navbox, .catlinks, .mw-cite-backlink')) return false;
      const clone = td.cloneNode(true);
      clone.querySelectorAll('.tw-tr').forEach(n => n.remove());
      const txt = clone.textContent.replace(/\s+/g, ' ').trim();
      if (!txt || !/[A-Za-z]/.test(txt) || txt.startsWith('No mission')) return false;
      const a = [...clone.querySelectorAll('a')].find(a => a.textContent.replace(/\s+/g, ' ').trim() === txt);
      return !!a && !clone.querySelector('table');
    });
    const pureTdTr = pureTd.filter(td => hasTr(td)).length;

    return {
      total: document.querySelectorAll('.tw-tr').length,
      tocTrInLi,
      tocLiCount: tocLis.length,
      tocParentOk,
      tocHeadingTr,
      rankTh: trText(thOf('Rank')),
      magazineTh: trText(thOf('Magazine Capacity')),
      costTh: trText(thOf('Cost')),
      rotationsTh: trText(thOf('Rotations')),
      radiationTh: trText(thOf('Radiation')),
      pureTdCount: pureTd.length,
      pureTdTr,
      pureTdSample: pureTd.slice(0, 3).map(td => trText(td)),
      pureTdMissing: pureTd.filter(td => !hasTr(td)).map(td => td.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)),
    };
  });
  console.log(JSON.stringify(r, null, 2));
  await page.screenshot({ path: path.join(__dirname, '.tmp', 'shot-atomic.png'), fullPage: false });
  await ctx.close();
  server.close();
  const pass =
    r.tocTrInLi >= 5 &&            // 目录 5 个条目都有译文
    r.tocParentOk &&               // 嵌套条目译文位置正确
    r.tocHeadingTr &&              // Contents 标题有译文
    !!r.rankTh && !!r.magazineTh && !!r.costTh &&  // 纯链接表头不再丢弃
    !!r.rotationsTh && !!r.radiationTh &&          // 含文字表头不回归
    r.pureTdCount > 0 && r.pureTdTr === r.pureTdCount;  // 纯链接单元格全部有译文
  console.log(pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
