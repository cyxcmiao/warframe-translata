/**
 * test_searchbox.js — 搜索框中文术语 e2e（真实站点 + 扩展 + mock AI）
 * 断言:
 *  1. L1 注入:输入中文后,站点 Codex 建议下拉出现词表候选(li.tw-zh-item)
 *  2. L2 桥接:点候选后输入框的中文片段被改写为英文术语
 *  3. L3 提交改写:带中文术语的表单提交发出英文查询(URL search 参数)
 * 注意:
 *  - 站点把 /wiki/X 重定向到 /w/X,必须等落定再交互(文档会被整体替换);
 *  - Vue 接管后搜索 input 丢掉 id="searchInput",一律用 input[name="search"]。
 * 每次运行清空持久 profile(陈旧 SW 不应答消息的既有教训)。
 * 用法: node tools/test_searchbox.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const PROFILE = path.join(__dirname, '.tmp', 'profile-test-searchbox');
const PAGE_URL = 'https://wiki.warframe.com/w/Wiki/WARFRAME'; // 直达 /w/ 最终路径，避开中途换文档

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : '');
  }
}

async function shot(ctx, page, name) {
  try { await page.screenshot({ path: path.join(__dirname, '.tmp', name) }); } catch { /* 关闭中忽略 */ }
}

/** MediaWiki "Go" 命中页面时会 302 链式跳转;等 URL 连续多次不再变化再断言 */
async function waitUrlStable(page, stableMs = 2100) {
  let last = page.url();
  let quiet = 0;
  for (let i = 0; i < 40 && quiet < stableMs; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (page.url() === last) quiet += 300;
    else {
      quiet = 0;
      last = page.url();
    }
  }
  return page.url();
}

(async () => {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(18952);
  const ctx = await chromium.launchPersistentContext(PROFILE, {
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
  await injectAISettings(sw, 18952);

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  const logs = [];
  page.on('pageerror', e => logs.push(`[pageerror] ${String(e).slice(0, 200)}`));
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const title = await page.title();
    if (!/just a moment|please wait|请稍候/i.test(title)) break;
  }
  check('过 CF 到正文页', /warframe/i.test(await page.title()), await page.title());
  check('URL 落定 /w/', /\/w\//.test(page.url()), page.url());

  const INPUT = 'input[name="search"]';
  await page.waitForSelector(INPUT, { timeout: 15000 });
  // 等 content script boot 完成（applyStyle 的 #tw-style 在 bootstrap resolve 后注入），
  // 否则打字发生在监听挂上之前、输入事件全丢（真实用户同样场景由 init 补扫兜底）
  await page.waitForSelector('#tw-style', { timeout: 20000, state: 'attached' });

  // --- 1. L1 注入:输入「电击」→ 下拉出现词表候选
  await page.click(INPUT);
  await page.keyboard.type('电击', { delay: 80 });
  let injected = null;
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 500));
    injected = await page.evaluate(sel => {
      const lis = [...document.querySelectorAll('#p-search .cdx-menu__listbox li.tw-zh-item')];
      const input = document.querySelector(sel);
      return {
        count: lis.length,
        firstIsOurs: !!document.querySelector('#p-search .cdx-menu__listbox')?.firstElementChild?.classList.contains('tw-zh-item'),
        inputVal: input?.value ?? null,
        descs: lis.slice(0, 8).map(li => li.querySelector('.cdx-menu-item__text__description')?.textContent?.trim() ?? ''),
      };
    }, INPUT);
    if (injected.count > 0 && injected.firstIsOurs) break;
  }
  check('L1 词表候选注入下拉', !!injected && injected.count > 0, injected);
  check('L1 候选居顶', !!injected && injected.firstIsOurs, injected);
  check('L1 输入框仍是中文原文', !!injected && injected.inputVal === '电击', injected?.inputVal);
  check('L1 一对多候选都出现(Electricity/Shock)', !!injected && injected.descs.some(d => /Electricity/.test(d)) && injected.descs.some(d => /Shock/.test(d)), injected);

  // --- 2. L2 直达:真实点击候选 → 直接跳转(Go 命中页面),无需第二次点击
  const liSel = '#p-search .cdx-menu__listbox li.tw-zh-item a';
  await page.waitForSelector(liSel, { timeout: 8000 });
  const navL2 = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await page.click(liSel); // 第一个候选(排序确定:Electricity 在前)
  await navL2;
  const urlL2 = await waitUrlStable(page);
  check('L2 点击候选直达跳转', /Electricity|Damage\/Electricity/i.test(urlL2), { url: urlL2 });
  check('L2 跳转 URL 不含中文', !/[\u3400-\u4dbf\u4e00-\u9fff]/.test(urlL2), urlL2);

  // --- 3. L3 提交改写(同步路径):改输中文再提交表单。
  // 改写生效后 MediaWiki "Go" 直接命中页面(URL 为 /w/Electricity 等)或带 search= 参数
  await page.click(INPUT);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('电击', { delay: 80 });
  await page.waitForTimeout(1500); // 等 suggest 响应落本地缓存(同步改写路径)
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await page.evaluate(() => {
    const input = document.querySelector('input[name="search"]');
    input?.closest('form')?.requestSubmit();
  });
  await nav;
  const url = await waitUrlStable(page);
  const m = /[?&]search=([^&]*)/.exec(url);
  const query = m ? decodeURIComponent(m[1]) : null;
  // Go 直接命中页面后 wiki 还会 302 到规范名(如 /w/Electricity → /w/Damage/Electricity_Damage),
  // 断言放宽为「路径或 search 参数含改写后的英文术语」
  const rewritten = /Electricity|Shock/i.test(query ?? '') || /\/w\/[^?]*Electricity|\/w\/[^?]*Shock/i.test(url);
  check('L3 同步改写发出英文查询', rewritten, { url, query });
  check('L3 查询不含中文', !/[\u3400-\u4dbf\u4e00-\u9fff]/.test(url), url);

  // --- 3b. L3 异步路径:纯 JS 赋值(不经过 suggest,本地缓存未预热)→ 后台 zhResolve 改写
  await page.waitForSelector(INPUT, { timeout: 15000 });
  const nav2 = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await page.evaluate(() => {
    const input = document.querySelector('input[name="search"]');
    if (input) input.value = '电池';
    input?.closest('form')?.requestSubmit();
  });
  await nav2;
  const url2 = await waitUrlStable(page);
  const m2 = /[?&]search=([^&]*)/.exec(url2);
  const query2 = m2 ? decodeURIComponent(m2[1]) : null;
  const rewritten2 = /Battery/i.test(query2 ?? '') || /\/w\/[^?]*Battery/i.test(url2);
  check('L3b 异步路径改写 电池→Battery', rewritten2, { url: url2, query: query2 });
  check('L3b 查询不含中文', !/[\u3400-\u4dbf\u4e00-\u9fff]/.test(url2), url2);

  // --- 控制台无报错
  const errs = logs.filter(l => /error/i.test(l));
  check('页面无报错', errs.length === 0, errs.slice(0, 5));

  await shot(ctx, page, 'test_searchbox.png');
  await ctx.close();
  server.close();
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
