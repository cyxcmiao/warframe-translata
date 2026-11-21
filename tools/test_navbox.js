/**
 * test_navbox.js — navbox 列表单元格 div 包装回归
 * 用法: node tools/test_navbox.js
 *
 * 背景: navbox 列表单元格是 <td class="navbox-list"><div>链接•链接</div></td> 结构，
 * serialize 的块级中断曾让 DIV 后整块内容丢失（td 序列化为空被跳过）——
 * Auxiliary Power 页 Archwing Mods 表整列不翻译（组头 th 有译文、Mod 名全英文）。
 * 修复: serialize 对"无可采集后代"的块级包装透传行内内容（.tw-tr 译文块绝不透传）。
 *
 * 另含对齐镜像回归: 真实站 navboxTable 为 text-align:center（fixture 已同步），
 * 译文块须镜像宿主对齐（renderer 加 tw-tr-mirror），否则贴左缘错位
 * （Winds of Purity 页 Syndicate Augments 表曾复现）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = path.join(__dirname, '.tmp', 'navbox_fixture.html');
const PAGE_PATH = '/w/Auxiliary_Power';
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-navbox'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(18948);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-navbox'), {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await injectAISettings(sw, 18948);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('https://wiki.warframe.com/**', route => {
    if (new URL(route.request().url()).pathname === PAGE_PATH) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub' });
  });
  await page.goto('https://wiki.warframe.com' + PAGE_PATH, { waitUntil: 'domcontentloaded' });
  let last = -1, stable = 0;
  for (let i = 0; i < 30 && stable < 5; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    stable = n === last ? stable + 1 : 0;
    last = n;
  }

  const r = await page.evaluate(() => {
    const nav = document.querySelector('table.navbox');
    if (!nav) return { navFound: false };
    const cells = [...nav.querySelectorAll('th, td')];
    const listTds = cells.filter(c => c.classList.contains('navbox-list'));
    const groupThs = cells.filter(c => c.classList.contains('navbox-group'));
    const headTh = cells.filter(c => c.classList.contains('navboxhead'));
    const hasTr = c => !!c.querySelector(':scope > .tw-tr, :scope .tw-tr');
    // 列表单元格译文必须覆盖全部 Mod 名（词典官方译名），不得残留整段英文
    const listTrTexts = listTds.map(c => [...c.querySelectorAll('.tw-tr')].map(t => t.textContent.trim()).join(' '));
    // 对齐镜像回归：真实站 navboxTable 为 text-align:center（fixture 已同步），
    // 单元格译文必须镜像居中（tw-tr-mirror），否则译文贴在单元格左缘、与居中原文错位；
    // 正文左对齐段落不得镜像，保持色条缩进样式
    const align = el => (el ? getComputedStyle(el).textAlign : null);
    const firstListTr = listTds.find(hasTr)?.querySelector('.tw-tr');
    const firstGroupTr = groupThs.find(hasTr)?.querySelector('.tw-tr');
    const paraTr = [...document.querySelectorAll('.tw-tr')].find(t => t.previousElementSibling?.tagName === 'P');
    return {
      navFound: true,
      headTr: headTh.every(hasTr),
      groupTr: groupThs.every(hasTr),
      listTrCount: listTds.filter(hasTr).length,
      listTotal: listTds.length,
      listTrTexts,
      listUntranslated: listTrTexts.some(t => /Argon|Ammo|Astral/.test(t)),
      navboxAlign: align(document.querySelector('table.navbox')),
      listTrMirror: firstListTr?.classList.contains('tw-tr-mirror') ?? null,
      listTrAlign: align(firstListTr),
      groupTrMirror: firstGroupTr?.classList.contains('tw-tr-mirror') ?? null,
      groupTrAlign: align(firstGroupTr),
      paraMirror: paraTr?.classList.contains('tw-tr-mirror') ?? null,
      paraAlign: align(paraTr),
    };
  });
  console.log(JSON.stringify(r, null, 1));
  await ctx.close();
  server.close();

  const ok = r.navFound && r.headTr && r.groupTr && r.listTrCount === r.listTotal && !r.listUntranslated
    && r.navboxAlign === 'center'
    && r.listTrMirror === true && r.listTrAlign === 'center'
    && r.groupTrMirror === true && r.groupTrAlign === 'center'
    && r.paraMirror === false && r.paraAlign === 'left';
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
