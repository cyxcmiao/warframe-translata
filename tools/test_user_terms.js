/**
 * test_user_terms.js — 自定义词表 e2e：设置页编辑 → 自动保存 → 最高优先级 → 中文检索 → 持久化
 *
 * 验证点：
 *  1. options 页输入「英文, 中文」自动保存，状态显示条数；
 *  2. 自定义词条压过官方词表（翻译路径：词典终局块直接用自定义译名，不发 AI）；
 *  3. 中文检索（zhSuggest/zhResolve）收录自定义中文，同中文多候选时自定义英文排最前；
 *  4. 空译名不生效：不删除官方词条（自定义层无删除语义），按无效行忽略；
 *  5. 刷新设置页后内容仍在（IndexedDB 持久化）；
 *  6. 缺逗号/缺中文的脏行被忽略且有提示。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const DIST = path.join(ROOT, 'dist', 'chrome');

const ok = (name) => console.log(`  ok  ${name}`);
function fail(name, detail) {
  console.error(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  process.exitCode = 1;
}
function check(name, cond, detail) {
  if (cond) ok(name);
  else fail(name, detail);
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  // 持久 profile + 重建扩展会留下陈旧 SW（记忆约定：每次清空保证确定性）
  try { fs.rmSync(path.join(TMP, 'profile-ut'), { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
  const context = await chromium.launchPersistentContext(path.join(TMP, 'profile-ut'), {
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
    sw = context.serviceWorkers().find(s => s.url().includes('background'));
  }
  if (!sw) throw new Error('SW not found');
  const extId = new URL(sw.url()).host;
  console.log('extension id:', extId);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#userTerms');
  // 等首次加载完成（后台 ensureGlossary 装载词表）
  await page.waitForFunction(
    () => !document.getElementById('userTermsStatus').textContent.includes('加载中'),
    null,
    { timeout: 60000 },
  );
  console.log('初始状态:', (await page.textContent('#userTermsStatus')).trim());

  // ---- 1. 输入并自动保存（含注释、脏行、覆盖官方、新增、空译名、强制保留英文、英文名含逗号）----
  const initial = [
    '# 自定义词表测试',
    'Tigris Prime, 自定义猛虎',   // 覆盖官方 猛虎 Prime
    'Thunder, 电击',             // 与官方 电击 碰撞，prio 排最前
    'MyTestTerm, 测试名词',       // 新增官方没有的词条
    'Bounty, Tier 5, 赏金任务5阶', // 英文名自带英文逗号（按最后一个逗号分隔）
    'EscTest, 含逗号\\, 译名',     // 译文里的英文逗号转义 \, 
    'Shock,',                    // 空译名：无效行（不再删除官方词条）
    'Excalibur, Excalibur',      // 强制保留英文（retained 覆盖）
    'this line has no comma',    // 脏行：忽略
  ].join('\n');
  await page.fill('#userTerms', initial);
  await page.waitForFunction(
    () => document.getElementById('userTermsStatus').textContent.includes('已保存 6 条'),
    null,
    { timeout: 20000 },
  );
  console.log('保存状态:', (await page.textContent('#userTermsStatus')).trim());
  console.log('保存结果:', (await page.textContent('#userTermsResult')).trim());
  check('状态显示已保存条数', /已保存 6 条/.test(await page.textContent('#userTermsStatus')));
  check('脏行与空译名行被忽略并提示', /已忽略 2 行/.test(await page.textContent('#userTermsResult')));

  // ---- 2. 翻译路径：自定义词条压过官方（词典终局块不发 AI）----
  // 需要 aiKey 非空才会进入翻译编排；Tigris Prime 用纯中文自定义译名 → 词典终局，不发 AI
  await page.evaluate(async () => {
    const o = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...(o.settings || {}), aiKey: 'sk-test-dummy', aiBaseUrl: 'http://127.0.0.1:9/v1', aiModel: 'test-model' },
    });
  });
  const tr = await page.evaluate(async () => {
    return await new Promise(res => {
      chrome.runtime.sendMessage(
        {
          type: 'translate',
          blocks: [
            { id: 'a', text: 'Tigris Prime' },
            { id: 'b', text: 'MyTestTerm' },
            { id: 'c', text: 'Electricity' },
            { id: 'd', text: 'Bounty, Tier 5' },
            { id: 'e', text: 'EscTest' },
          ],
        },
        res,
      );
    });
  });
  console.log('translate:', JSON.stringify(tr));
  check('自定义词条覆盖官方译名', tr?.results?.a?.translation === '自定义猛虎', tr?.results?.a);
  check('自定义新增词条生效', tr?.results?.b?.translation === '测试名词', tr?.results?.b);
  check('未干预的官方词条保持原译名', tr?.results?.c?.translation === '电击', tr?.results?.c);
  check('英文名含逗号的词条生效', tr?.results?.d?.translation === '赏金任务5阶', tr?.results?.d);
  check('译文转义英文逗号还原', tr?.results?.e?.translation === '含逗号, 译名', tr?.results?.e);

  // ---- 3. 中文检索：自定义中文出候选、碰撞时 prio 排最前、空译名不删除官方词条 ----
  const sugThunder = await page.evaluate(
    () =>
      new Promise(res =>
        chrome.runtime.sendMessage({ type: 'zhSuggest', q: '电击', limit: 8 }, res),
      ),
  );
  console.log('zhSuggest 电击:', JSON.stringify(sugThunder));
  check('同中文多候选时自定义英文排最前', sugThunder?.items?.[0]?.en === 'Thunder', sugThunder?.items);
  check('空译名不删除官方词条（Shock 仍在候选）', sugThunder?.items?.some(x => x.en === 'Shock'), sugThunder?.items);
  check('官方同中文词条仍保留（Electricity）', sugThunder?.items?.some(x => x.en === 'Electricity'), sugThunder?.items);

  const sugCustom = await page.evaluate(
    () =>
      new Promise(res =>
        chrome.runtime.sendMessage({ type: 'zhSuggest', q: '测试名词', limit: 8 }, res),
      ),
  );
  console.log('zhSuggest 测试名词:', JSON.stringify(sugCustom));
  check('自定义中文可检索出候选', sugCustom?.items?.[0]?.en === 'MyTestTerm', sugCustom?.items);

  const resCustom = await page.evaluate(
    () =>
      new Promise(res =>
        chrome.runtime.sendMessage({ type: 'zhResolve', q: '测试名词 mod' }, res),
      ),
  );
  console.log('zhResolve 测试名词 mod:', JSON.stringify(resCustom));
  check('提交改写作优先命中自定义词条', resCustom?.query === 'MyTestTerm mod', resCustom);

  // 覆盖官方译名的中文：旧中文 电击 不再指向被改写的词条（上一步已查 Electricity 仍在，
  // 这里验证自定义中文 雷电/自定义猛虎 反查）
  const resTigris = await page.evaluate(
    () =>
      new Promise(res =>
        chrome.runtime.sendMessage({ type: 'zhResolve', q: '自定义猛虎' }, res),
      ),
  );
  check('自定义中文反查改写为英文', resTigris?.query === 'Tigris Prime', resTigris);

  // 英文名含逗号的词条：中文反查应完整还原英文名（含逗号）
  const resBounty = await page.evaluate(
    () =>
      new Promise(res =>
        chrome.runtime.sendMessage({ type: 'zhResolve', q: '赏金任务5阶' }, res),
      ),
  );
  console.log('zhResolve 赏金任务5阶:', JSON.stringify(resBounty));
  check('含逗号英文名反查完整', resBounty?.query === 'Bounty, Tier 5', resBounty);

  // ---- 4. retained 覆盖：Excalibur = Excalibur（词典终局，不发 AI）----
  const tr2 = await page.evaluate(
    () =>
      new Promise(res =>
        chrome.runtime.sendMessage({ type: 'translate', blocks: [{ id: 'x', text: 'Excalibur' }] }, res),
      ),
  );
  check('强制保留英文的条目照抄英文', tr2?.results?.x?.translation === 'Excalibur', tr2?.results?.x);

  // ---- 5. 持久化：刷新设置页内容仍在 ----
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => !document.getElementById('userTermsStatus').textContent.includes('加载中'),
    null,
    { timeout: 60000 },
  );
  const reloaded = await page.inputValue('#userTerms');
  console.log('刷新后内容:\n' + reloaded);
  check('刷新后自定义词条仍在', /Tigris Prime, 自定义猛虎/.test(reloaded) && /MyTestTerm, 测试名词/.test(reloaded), reloaded);
  check('刷新后含逗号英文名回显完整', /Bounty, Tier 5, 赏金任务5阶/.test(reloaded), reloaded);
  check('刷新后译文逗号仍为转义形式', /EscTest, 含逗号\\, 译名/.test(reloaded), reloaded);
  check('刷新后空译名行未入库', !/Shock,/.test(reloaded), reloaded);
  check('刷新后状态显示条数', /当前 6 条/.test(await page.textContent('#userTermsStatus')));

  // ---- 6. 清空 → 官方译名恢复（热重建生效）----
  await page.fill('#userTerms', '');
  await page.waitForFunction(
    () => /已保存 0 条/.test(document.getElementById('userTermsStatus').textContent),
    null,
    { timeout: 20000 },
  );
  const tr3 = await page.evaluate(
    () =>
      new Promise(res =>
        chrome.runtime.sendMessage({ type: 'translate', blocks: [{ id: 'y', text: 'Tigris Prime' }] }, res),
      ),
  );
  check('清空后官方译名恢复', tr3?.results?.y?.translation === '猛虎 Prime', tr3?.results?.y);

  await context.close();
  console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL PASS');
  process.exit(process.exitCode || 0);
})().catch(e => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
