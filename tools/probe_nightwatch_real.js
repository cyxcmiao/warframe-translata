/**
 * probe_nightwatch_real.js — 真站复现 Nightwatch Corps 卡住（mock AI 保持确定性）
 * 用法: node tools/probe_nightwatch_real.js
 *
 * 真实 DOM 动态（Tabber JS、懒加载）+ mock AI 秒回；跟踪胶囊可视状态（插桩
 * shadow 改 open）、译文块增长、波次时间线；稳定后点 tabber tab 验证切换内容翻译。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const URL = 'https://wiki.warframe.com/w/Nightwatch_Corps';

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-nwc-real'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(18955);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-nwc-real'), {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  let sw = null;
  for (let i = 0; i < 60 && !sw; i++) {
    await new Promise(r => setTimeout(r, 500));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await injectAISettings(sw, 18955);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  const dbg = [];
  page.on('console', m => { if (m.text().includes('[twdbg]')) dbg.push(m.text().slice(0, 150)); });
  page.on('pageerror', e => dbg.push(`[pageerror] ${String(e).slice(0, 200)}`));
  console.log('goto real site (CF challenge may take 30-60s)...');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // 等 CF 放行 + 正文出现
  await page.waitForSelector('#mw-content-text', { timeout: 150000 });
  console.log('content ready, tracking...');

  const timeline = [];
  let lastTr = -1, stable = 0;
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await page.evaluate(() => {
      const host = document.querySelector('#tw-progress-host');
      const bar = host?.shadowRoot?.querySelector('.bar'); // 插桩构建 shadow 为 open
      const dbg = (window).__twdbg?.() ?? {};
      return {
        tr: document.querySelectorAll('.tw-tr').length,
        bar: bar ? bar.className : null,
        fill: bar ? (bar.querySelector('.fill')?.getAttribute('style') ?? '') : null,
        scrollH: document.body.scrollHeight,
        ...dbg,
      };
    });
    timeline.push({ t: i + 1, ...s, aiReq: server.chatRequests() });
    if (s.tr === lastTr && server.chatRequests() === (timeline[timeline.length - 2]?.aiReq ?? -1)) stable++; else stable = 0;
    lastTr = s.tr;
    if (stable >= 6) break;
  }
  console.log(JSON.stringify(timeline, null, 1));

  // 滚动扫过全页（模拟用户阅读），观察挂起块放行
  console.log('--- sweep ---');
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 100));
    }
    window.scrollTo(0, 0);
  });
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await page.evaluate(() => ({
      tr: document.querySelectorAll('.tw-tr').length,
      ...((window).__twdbg?.() ?? {}),
    }));
    console.log('sweep+' + (i + 1) + 's', JSON.stringify(s), 'ai=' + server.chatRequests());
    if (s.tr === timeline[timeline.length - 1]?.tr && !s.queue && !s.parked && !s.pumping && i >= 3) break;
  }

  // 稳定后点击 tabber 的第二个 tab，验证切换内容是否翻译
  const tabInfo = await page.evaluate(() => {
    const tab = document.querySelector('.tabber'); // Units 区第一个 tabber
    if (!tab) return { hasTabber: false };
    // dump 结构定位可点的 tab 头
    const head = tab.querySelector('.tabbernav, [class*=header], ul');
    return {
      hasTabber: true,
      panels: tab.querySelectorAll('.tabbertab').length,
      headClass: head?.className ?? null,
      headHtml: head?.outerHTML.slice(0, 400) ?? null,
    };
  });
  console.log('tabber:', JSON.stringify(tabInfo, null, 1));
  if (tabInfo.hasTabber) {
    // 滚到 Units 区确保 tabber 在视口
    await page.evaluate(() => document.querySelector('.tabber')?.scrollIntoView({ block: 'center' }));
    await new Promise(r => setTimeout(r, 3000));
    const btn = await page.$('.tabber .tabbernav > li:nth-of-type(2) > a');
    if (btn) {
      const before = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
      await btn.click();
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const s = await page.evaluate(() => ({
          tr: document.querySelectorAll('.tw-tr').length,
          visTr: [...document.querySelectorAll('.tabbertab')].filter(t => t.offsetHeight > 0).flatMap(t => [...t.querySelectorAll('.tw-tr')]).length,
          ...((window).__twdbg?.() ?? {}),
        }));
        console.log('tab+' + (i + 1) + 's', JSON.stringify(s), 'ai=' + server.chatRequests());
        if (i >= 3 && s.tr === before && !s.queue && !s.parked && !s.pumping) break;
      }
    } else {
      console.log('tab nav button not found');
    }
  }

  console.log('--- twdbg (last 50) ---');
  console.log(dbg.slice(-50).join('\n') || '(none)');
  await page.screenshot({ path: path.join(__dirname, '.tmp', 'nightwatch_real.png') });
  console.log('screenshot: tools/.tmp/nightwatch_real.png, aiReq =', server.chatRequests());
  await ctx.close();
  server.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
