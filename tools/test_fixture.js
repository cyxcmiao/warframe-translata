/**
 * test_fixture.js — 本地夹具端到端测试（路由拦截模拟 wiki 页面，绕过 Cloudflare）
 * 复现 /w/Slash_Dash 的嵌套列表结构，断言：
 *  1. 外层 li 的译文出现在其文字之后、嵌套子列表之前（错位修复）
 *  2. 长段拆句的多个译文保持句子顺序
 *  3. 词表替换正确（Tigris Prime → 猛虎 Prime）
 */
'use strict';
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');

const FIXTURE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Slash Dash - WARFRAME Wiki</title></head>
<body><div id="mw-content-text"><div class="mw-parser-output">
<ul>
<li>Excalibur expends 25 Energy to dash forward, gaining an boost of 36 m/s to his current velocity, and becoming Invulnerable during the dash. If an enemy is within 20 meters of Excalibur and 10 degrees of the reticle, then Excalibur instead will lock on to them, dash at 75 m/s, and strike them with the Exalted Blade, then automatically chain to and strike additional enemies within 7 meters. Each strike deals the Exalted Blade's damage, along with a forced Slash Status Effect and Knockdown.
<ul>
<li>Every instance of damage increases the Melee Combo Counter by 1 point.</li>
<li>Only benefits the active melee weapon combo counter.</li>
</ul>
</li>
<li>Chained Slash Dash can be cancelled by melee, jumping or rolling.</li>
</ul>
<p>The Tigris Prime is a shotgun. Pressure Point improves damage.</p>
</div></div></body></html>`;

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-fixture'), {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  // 拦截 wiki 域名，返回本地夹具
  await page.route('https://wiki.warframe.com/**', route =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE }));
  await page.goto('https://wiki.warframe.com/w/Slash_Dash', { waitUntil: 'domcontentloaded' });

  let n = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    if (n >= 5) break;
  }

  const r = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('.tw-tr')];
    const outerLi = [...document.querySelectorAll('li')].find(li => li.textContent.startsWith('Excalibur expends'));
    const nestedUl = outerLi.querySelector('ul');
    // 外层 li 自己的译文块 = 直接作为 outerLi 子元素的 .tw-tr（插在文字与嵌套 ul 之间）
    const outerTrs = trs.filter(t => t.parentElement === outerLi);
    const withNum = s => trs.find(t => t.textContent.includes(s));
    const domIdx = el => trs.indexOf(el);
    const found = [withNum('75'), withNum('Knockdown')].filter(Boolean);
    const orderKept = found.every((el, i) => i === 0 || domIdx(found[i - 1]) < domIdx(el));
    return {
      total: trs.length,
      outerTrCount: outerTrs.length,
      allBeforeNested: outerTrs.length > 0 && outerTrs.every(t => !!(nestedUl.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING)),
      sentenceOrderKept: orderKept,
      glossaryOk: !!withNum('猛虎 Prime') && !!withNum('压迫点'),
      outerTrList: outerTrs.map(t => t.textContent.trim().slice(0, 30)),
    };
  });
  console.log(JSON.stringify(r, null, 2));
  await page.screenshot({ path: path.join(__dirname, '.tmp', 'shot-fixture.png') });
  await ctx.close();
  // 词典模式语义：无裸词命中的块（首句、嵌套 li）不产生译文块，total=4 属预期
  process.exit(r.total >= 4 && r.outerTrCount >= 2 && r.allBeforeNested && r.sentenceOrderKept && r.glossaryOk ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
