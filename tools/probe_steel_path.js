/**
 * probe_steel_path.js — The Steel Path 页四个反馈点的端到端探针
 * 用法: node tools/probe_steel_path.js
 * 加载 tools/.tmp/the_steel_path.html（快照 CSS 把 body 钉死 900px 高，
 * 探针强制 body 可滚并滚 body.scrollTop 放行全部懒翻译块），然后检查:
 *  1) "Enemy Health/Shield 250%" li 是否有译文
 *  2) "In order to access" 段落是否有译文
 *  3) 商店 offeringsBoxName 是否有译文
 *  4) 底部 Missions navbox 是否有译文
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { startMockAI, injectAISettings } = require('./mock_ai');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const HTML_PATH = path.join(__dirname, '.tmp', 'the_steel_path.html');
const PAGE_PATH = '/w/The_Steel_Path';
const HTML = fs.readFileSync(HTML_PATH, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');

(async () => {
  try { fs.rmSync(path.join(__dirname, '.tmp', 'profile-steelpath'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const server = await startMockAI(8796);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.tmp', 'profile-steelpath'), {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise(r => setTimeout(r, 250));
    sw = ctx.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
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
  await page.evaluate(() => { document.body.style.overflowY = 'auto'; document.documentElement.style.overflowY = 'auto'; });

  // 逐屏滚动到底（快照布局 body 是滚动容器），放行全部挂起块
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      document.documentElement.scrollTop = y;
      document.body.scrollTop = y;
      await new Promise(r => setTimeout(r, 100));
    }
  });
  let lastTr = -1, stable = 0;
  for (let i = 0; i < 90 && stable < 6; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await page.evaluate(() => document.querySelectorAll('.tw-tr').length);
    stable = n === lastTr ? stable + 1 : 0;
    lastTr = n;
  }

  const r = await page.evaluate(() => {
    // 译文可能插在宿主内部（cell）或宿主之后（block），两者都查
    const hasTr = el => {
      if (!el) return false;
      if (el.querySelector(':scope > .tw-tr')) return true;
      let n = el.nextElementSibling;
      for (let i = 0; i < 3 && n; i++) {
        if (n.classList.contains('tw-tr')) return true;
        n = n.nextElementSibling;
      }
      return false;
    };
    const trTexts = el => {
      if (!el) return [];
      const out = [...el.querySelectorAll(':scope > .tw-tr')].map(t => t.textContent.trim().slice(0, 90));
      let n = el.nextElementSibling;
      for (let i = 0; i < 3 && n; i++) {
        if (n.classList.contains('tw-tr')) out.push(n.textContent.trim().slice(0, 90));
        n = n.nextElementSibling;
      }
      return out;
    };

    const lis = [...document.querySelectorAll('#mw-content-text li')];
    // 限定修饰列表里的那两条（整条文本就是 "Enemy Health 250%"，翻后 textContent 会带上译文，用 includes）
    const healthLi = lis.find(li => li.textContent.includes('Health 250%') && !li.closest('.navbox'));
    const shieldLi = lis.find(li => li.textContent.replace(/\s+/g, ' ').trim().startsWith('Enemy Shield 250%'));

    const para = [...document.querySelectorAll('#mw-content-text p')].find(p => p.textContent.includes('In order to access The Steel Path'));

    const names = [...document.querySelectorAll('.offeringsBoxName')].slice(0, 40);
    const namesTr = names.filter(hasTr).length;

    const nav = document.querySelector('table.navbox');
    const navTrs = nav ? nav.querySelectorAll('.tw-tr').length : -1;

    // 修饰列表 li 逐条快照（含兄弟关系），供人工核对
    const modList = healthLi ? [...healthLi.parentElement.children].map(el => ({
      tag: el.tagName,
      text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 50),
      selfTr: !!el.querySelector(':scope > .tw-tr'),
      isTr: el.classList.contains('tw-tr'),
      trInside: [...el.querySelectorAll('.tw-tr')].map(t => t.textContent.trim().slice(0, 50)),
    })) : [];

    return {
      totalTrs: document.querySelectorAll('.tw-tr').length,
      issue1Dbg: (() => {
        const li2 = healthLi;
        if (!li2) return null;
        return {
          html: li2.outerHTML.replace(/<img[^>]*>/g, '<IMG>').slice(0, 400),
          childTags: [...li2.children].map(c => c.tagName + '.' + c.className),
          nextSibs: [...Array(4)].map((_, i) => { let n = li2.nextElementSibling; for (let k = 0; k < i && n; k++) n = n.nextElementSibling; return n ? n.tagName + '.' + String(n.className).slice(0, 20) + ':' + n.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : null; }),
        };
      })(),
      issue1: {
        healthLiFound: !!healthLi,
        healthLiTr: hasTr(healthLi),
        healthLiTrText: trTexts(healthLi),
        shieldLiTr: hasTr(shieldLi),
        modList,
      },
      issue2: { paraFound: !!para, paraTr: hasTr(para), paraTrText: trTexts(para) },
      issue3: { namesTotal: names.length, namesWithTr: namesTr, sample: trTexts(names[0]) },
      issue4: { navFound: !!nav, navTrs },
    };
  });
  console.log(JSON.stringify(r, null, 2));
  await ctx.close();
  server.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
