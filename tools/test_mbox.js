/**
 * test_mbox.js — mbox 消息盒回归测试（路由拦截模拟 wiki 页面，绕过 Cloudflare）
 * 复现 /w/Buff_&_Debuff 顶部三条消息盒（维护中/非官方/剧透）的结构：
 * 引言与正文都在纯 div（.mbox__content__header / .mbox__content__text）里，
 * 曾因不在 BLOCK_SEL 候选里整盒漏翻。断言：
 *  1. 每条消息盒的引言与正文都有译文，且译文落在盒内 wrapper（引言译文在
 *     header 之后、正文译文在 text 之后，不跑到盒外）
 *  2. 译文中的链接 token 还原为 <a>（剧透盒 The Second Dream 链接）
 *  3. 正文普通段落不受影响
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');

const FIXTURE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Buff & Debuff - WARFRAME Wiki</title></head>
<body><div id="mw-content-text"><div class="mw-parser-output">
<div class="mbox noexcerpt notpageimage textSelect mbox-type-orange" id="updateme"><div class="mbox__content"><div class="mbox__content__image mw-collapsible" id="mw-customcollapsible-updateme"><figure class="mw-halign-left" typeof="mw:File"><img src="x.png" width="60" height="60" class="mw-file-element"></figure></div><div class="mbox__content__wrapper"><div class="mbox__content__header mw-collapsible" id="mw-customcollapsible-updateme"><i><q>It's taking longer than I calculated.</q></i></div><div class="mbox__content__text"><b>This page is actively being worked on</b> and may not be completely correct. Please assist in making this page accurate by <a class="text" href="https://wiki.warframe.com/w/Buff_%26_Debuff?action=edit">adding more info</a>. For guidance on performing research, see <a href="/w/WARFRAME_Wiki:Research" title="WARFRAME Wiki:Research">WARFRAME Wiki:Research</a>.</div><span class="mbox__min mw-customtoggle-updateme" title="Minimize"></span><span class="mbox__close noSelect" id="updateme" title="Dismiss"></span></div></div></div>
<div class="mbox noexcerpt notpageimage textSelect mbox-type-green" id="community"><div class="mbox__content"><div class="mbox__content__image mw-collapsible" id="mw-customcollapsible-community"><figure class="mw-halign-left" typeof="mw:File"><img src="y.png" width="60" height="60" class="mw-file-element"></figure></div><div class="mbox__content__wrapper"><div class="mbox__content__header mw-collapsible" id="mw-customcollapsible-community"><i><q>Very well. Keep your secrets.</q></i></div><div class="mbox__content__text">This article/section contains unofficial information, concepts, or terminology derived from or based on community discussion, invention, or knowledge. It may be subjective and contain information or terminology that is not used by <a href="/w/Digital_Extremes" title="Digital Extremes">Digital Extremes</a> or in official communications, and may not be an officially recognized concept.</div><span class="mbox__min mw-customtoggle-community" title="Minimize"></span><span class="mbox__close noSelect" id="community" title="Dismiss"></span></div></div></div>
<div class="mbox noexcerpt notpageimage textSelect mbox-type-blue" id="spoiler"><div class="mbox__content"><div class="mbox__content__image mw-collapsible" id="mw-customcollapsible-spoiler"><figure class="mw-halign-left" typeof="mw:File"><img src="z.png" width="60" height="60" class="mw-file-element"></figure></div><div class="mbox__content__wrapper"><div class="mbox__content__header mw-collapsible" id="mw-customcollapsible-spoiler"><i><q>You're not supposed to be in here! You're going to ruin the surprise!</q></i></div><div class="mbox__content__text">The following article/section contains spoilers. Please complete <a href="/w/The_Second_Dream" title="The Second Dream">The Second Dream</a> before continuing.</div><span class="mbox__min mw-customtoggle-spoiler" title="Minimize"></span><span class="mbox__close noSelect" id="spoiler" title="Dismiss"></span></div></div></div>
<p>Buff &amp; Debuff lists buffs and debuffs. The Tigris Prime is a shotgun.</p>
</div></div></body></html>`;

(async () => {
  // 持久 profile 会残留陈旧的 SW 注册状态（扩展重建后 SW 不换新），每次清空保证确定性
  const profile = path.join(__dirname, '.tmp', 'profile-mbox');
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
  // 拦截 wiki 域名，返回本地夹具
  await page.route('https://wiki.warframe.com/**', route =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE }));
  await page.goto('https://wiki.warframe.com/w/Buff_%26_Debuff', { waitUntil: 'domcontentloaded' });

  let n = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    if (n >= 7) break;
  }

  const r = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('.tw-tr')];
    const boxes = [...document.querySelectorAll('.mbox')];
    const perBox = boxes.map(b => ({
      id: b.id,
      // 引言译文 = header 的相邻下一兄弟；正文译文 = text 的相邻下一兄弟
      headerTr: !!b.querySelector('.mbox__content__header + .tw-tr'),
      textTr: !!b.querySelector('.mbox__content__text + .tw-tr'),
    }));
    const echo = trs.filter(t => t.textContent.includes('【AI】')).length;
    const linkRestored = [...document.querySelectorAll('.mbox .tw-tr a')]
      .some(a => (a.getAttribute('href') || '').includes('The_Second_Dream'));
    // 正文段落译文紧随 <p> 之后（采集/渲染未被 mbox 改动波及）
    const pFollowed = !!document.querySelector('.mw-parser-output > p + .tw-tr');
    return { total: trs.length, perBox, echo, linkRestored, pFollowed };
  });
  console.log(JSON.stringify(r, null, 2));
  await page.screenshot({ path: path.join(__dirname, '.tmp', 'shot-mbox.png') });
  await ctx.close();
  server.close();
  const ok = r.total >= 7 && r.echo >= 7 && r.linkRestored && r.pFollowed
    && r.perBox.length === 3 && r.perBox.every(b => b.headerTr && b.textTr);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
