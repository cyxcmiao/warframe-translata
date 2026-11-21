/**
 * probe_winds_align.js — Winds of Purity 页 Syndicate Augments 对齐复现/验证
 * 用法: node tools/probe_winds_align.js
 *
 * 背景: 真实站 navboxTable 为 text-align:center，译文块曾强制 text-align:left，
 * 中文行贴在单元格左缘、与居中原文错位（首词被挤出可视区）。
 * 验证: 渲染用户保存的真实页面，导出每个 navbox 列表单元格的原文/译文/计算对齐。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = path.join(__dirname, '.tmp', 'Winds of Purity - WARFRAME Wiki.html');
const PAGE_PATH = '/w/Winds_of_Purity';
const HTML = fs.readFileSync(HTML_PATH, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-winds'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(18951);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-winds'), {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await injectAISettings(sw, 18951);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.route('https://wiki.warframe.com/**', route => {
    if (new URL(route.request().url()).pathname === PAGE_PATH) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub' });
  });
  await page.goto('https://wiki.warframe.com' + PAGE_PATH, { waitUntil: 'domcontentloaded' });
  // 懒翻译按可视区触发：先滚到底再回顶，让 navbox 各行都进过视口
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
  });
  await new Promise(r => setTimeout(r, 500));
  let last = -1, stable = 0;
  for (let i = 0; i < 40 && stable < 5; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    stable = n === last ? stable + 1 : 0;
    last = n;
  }

  const r = await page.evaluate(() => {
    const out = [];
    for (const table of document.querySelectorAll('table.navbox')) {
      const head = table.querySelector('.navboxhead, th.navbox-title')?.textContent.trim() ?? '';
      for (const row of table.querySelectorAll('tr')) {
        const cells = [...row.children].filter(c => c.tagName === 'TD' || c.tagName === 'TH');
        if (cells.length < 2) continue;
        const group = cells[0].textContent.trim();
        const body = cells[1];
        const tr = body.querySelector('.tw-tr');
        if (!tr) continue;
        out.push({
          head: head.slice(0, 40),
          group: group.slice(0, 24),
          en: body.textContent.replace(tr.textContent, '').replace(/\s+/g, ' ').trim().slice(0, 80),
          zh: tr.textContent.replace(/\s+/g, ' ').trim().slice(0, 80),
          hostAlign: getComputedStyle(body).textAlign,
          trAlign: getComputedStyle(tr).textAlign,
          mirror: tr.classList.contains('tw-tr-mirror'),
        });
      }
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  // 截图 Syndicate Augments 表区域供目检（站内链接文字用 &#160; 即 NBSP 分词，先归一化）
  const box = await page.evaluate(() => {
    for (const table of document.querySelectorAll('table.navbox')) {
      const text = table.textContent.replace(/\u00A0/g, ' ');
      if (text.includes('Bright Purity') || text.includes('光明纯净')) {
        const b = table.getBoundingClientRect();
        return { y: Math.max(0, b.top + window.scrollY), h: b.height };
      }
    }
    return null;
  });
  console.log('target table rect:', JSON.stringify(box));
  if (box) {
    await page.evaluate(y => window.scrollTo(0, y), box.y);
    await new Promise(r2 => setTimeout(r2, 400));
    await page.screenshot({ path: path.join(__dirname, '.tmp', 'winds_after.png') });
    console.log('screenshot saved: tools/.tmp/winds_after.png');
  }
  await ctx.close();
  server.close();
  const bad = r.filter(x => x.hostAlign === 'center' && x.trAlign !== 'center');
  console.log(bad.length ? `FAIL: ${bad.length} 个居中单元格译文未镜像` : 'PASS');
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
