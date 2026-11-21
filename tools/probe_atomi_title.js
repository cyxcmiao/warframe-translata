/**
 * probe_atomi_title.js — Atomi-Boost 页标题区端到端探针
 * 用法: node tools/probe_atomi_title.js
 * 加载 tools/.tmp/Atomi-Boost 快照，检查:
 *  1) h1#firstHeading（页面大标题）是否有译文行
 *  2) 信息框（ability-box）标题/描述区渲染情况（selflink 标题、td 级译文是否重复）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = path.join(__dirname, '.tmp', 'Atomi-Boost - WARFRAME Wiki.html');
const PAGE_PATH = '/w/Atomi-Boost';
const HTML = fs.readFileSync(HTML_PATH, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-atomi-title'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(8797);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-atomi-title'), {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await injectAISettings(sw, 8797);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route => {
    if (new URL(route.request().url()).pathname === PAGE_PATH) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub' });
  });
  await page.goto('https://wiki.warframe.com' + PAGE_PATH, { waitUntil: 'domcontentloaded' });

  let lastTr = -1, stable = 0;
  for (let i = 0; i < 60 && stable < 5; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    stable = n === lastTr ? stable + 1 : 0;
    lastTr = n;
  }

  const r = await page.evaluate(() => {
    const h1 = document.querySelector('#firstHeading');
    const h1Next = h1?.nextElementSibling;
    // 信息框: 找含 selflink 的 td
    const selfTd = document.querySelector('#mw-content-text td a.selflink')?.closest('td');
    const dumpTrs = root => [...(root || document).querySelectorAll('.tw-tr')].slice(0, 30).map(t => ({
      id: t.dataset.twId,
      mode: t.dataset.twMode,
      text: t.textContent.replace(/\s+/g, ' ').trim().slice(0, 110),
    }));
    return {
      totalTrs: document.querySelectorAll('.tw-tr').length,
      h1: {
        found: !!h1,
        text: h1?.textContent.trim(),
        selfTr: !!h1?.querySelector(':scope > .tw-tr'),
        nextIsTr: !!h1Next?.classList.contains('tw-tr'),
        nextText: h1Next?.textContent.trim().slice(0, 80) ?? null,
      },
      infobox: selfTd ? {
        selflinkFound: true,
        tdTrs: [...selfTd.querySelectorAll(':scope > .tw-tr')].map(t => t.textContent.replace(/\s+/g, ' ').trim().slice(0, 110)),
        firstChildren: [...selfTd.children].slice(0, 10).map(c => `${c.tagName}${c.classList.contains('tw-tr') ? '.tw-tr' : ''}:${c.textContent.replace(/\s+/g, ' ').trim().slice(0, 50)}`),
      } : { selflinkFound: false },
      allTrs: dumpTrs(),
    };
  });
  console.log(JSON.stringify(r, null, 2));
  await ctx.close();
  server.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
