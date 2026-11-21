/**
 * probe_searchbox.js — 搜索框中文术语功能的前置探针（非断言测试）
 * 摸清 wiki.warframe.com 的搜索框 DOM 结构与原生建议下拉行为：
 *  1. 页面上所有输入框 + 搜索表单结构
 *  2. 输入英文/中文时各自弹出的候选下拉结构（class/层级/条目形态）
 *  3. 回车提交路径（form action）
 * 用法: node tools/probe_searchbox.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-probe-search'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(18951);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-probe-search'), {
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
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  await injectAISettings(sw, 18951);

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  console.log('goto https://wiki.warframe.com/wiki/WARFRAME');
  await page.goto('https://wiki.warframe.com/wiki/WARFRAME', { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const title = await page.title();
    if (!/just a moment|please wait|请稍候/i.test(title)) break;
  }
  console.log('title:', await page.title());

  // 1. 全部输入框 + 搜索表单
  const inputs = await page.evaluate(() => {
    const desc = (el) => {
      const a = [...el.attributes].map(x => `${x.name}="${x.value}"`).join(' ');
      const form = el.closest('form');
      const formDesc = form ? `form[${[...form.attributes].map(x => `${x.name}="${x.value}"`).join(' ')}]` : 'no-form';
      const path = [];
      let p = el;
      while (p && p !== document.body) { path.unshift(`${p.tagName}${p.id ? '#' + p.id : ''}${p.className ? '.' + String(p.className).split(/\s+/).join('.') : ''}`); p = p.parentElement; }
      return `${formDesc} | ${path.join(' > ')} | <${el.tagName.toLowerCase()} ${a}>`;
    };
    return [...document.querySelectorAll('input, textarea')].map(desc);
  });
  console.log('=== all inputs ===');
  for (const l of inputs) console.log(' ', l);

  // 2. 找搜索输入框（优先 visible search 类型/占位符）
  const found = await page.evaluate(() => {
    const cands = [...document.querySelectorAll('input[type="search"], input[name="search"], #searchInput, .vector-search-box-input')];
    const vis = cands.find(el => el.offsetParent !== null || el.getClientRects().length);
    return vis ? vis.getAttribute('id') || vis.name || 'unnamed' : null;
  });
  console.log('search input pick:', found);

  if (found) {
    // 3. 输入英文 → 原生建议结构
    const dumpDropdown = async (label) => {
      const html = await page.evaluate(() => {
        const sels = ['.suggestions', '.suggestions-results', '.cdx-menu', '.citizen-search-results', '[role="listbox"]'];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && (el.offsetParent !== null || el.getClientRects().length)) {
            return `SEL=${s}\n` + el.outerHTML.slice(0, 4000);
          }
        }
        return null;
      });
      console.log(`--- dropdown after ${label} ---`);
      console.log(html ?? '(none visible)');
    };
    const input = await page.evaluate(() => {
      const cands = [...document.querySelectorAll('input[type="search"], input[name="search"], #searchInput, .vector-search-box-input')];
      return cands.find(el => el.offsetParent !== null || el.getClientRects().length) ? true : false;
    });
    if (input) {
      await page.click('input[type="search"], input[name="search"], #searchInput, .vector-search-box-input');
      await page.keyboard.type('Electric', { delay: 80 });
      await page.waitForTimeout(1500);
      await dumpDropdown('"Electric"');
      await page.keyboard.press('Control+a');
      await page.keyboard.type('电', { delay: 80 });
      await page.waitForTimeout(1500);
      await dumpDropdown('"电"');
      await page.keyboard.press('Control+a');
      await page.keyboard.type('电击', { delay: 80 });
      await page.waitForTimeout(1500);
      await dumpDropdown('"电击"');
    }
  }

  await page.screenshot({ path: path.join(__dirname, '.tmp', 'probe_search.png'), fullPage: false });
  console.log('screenshot saved');
  await ctx.close();
  server.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
