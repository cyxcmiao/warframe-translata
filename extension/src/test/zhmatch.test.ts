/** ZhMatcher（zh→en 反向匹配器）单元测试: node tools/test_zh_search.js */
import { ZhMatcher, hasCJK } from '../shared/zhmatch';
import type { TermEntry } from '../shared/types';
import * as fs from 'fs';
import * as path from 'path';

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

// --- 合成数据：碰撞 / 括号变体 / retained / 纯英文 ---
const entries: TermEntry[] = [
  { en: 'Electricity', zh: '电击' },
  { en: 'Shock', zh: '电击' }, // 一对多碰撞（同名官方译名）
  { en: 'Electric Shield', zh: '电力屏障' },
  { en: 'Long Artisan Barrel', zh: '工匠桶（高）' }, // 官方括号变体
  { en: 'Short Artisan Barrel', zh: '工匠桶（矮）' },
  { en: 'Excalibur', zh: 'Excalibur' }, // retained：zh===en 不进反向索引
  { en: 'Nai-Zhen Kubrow Collar', zh: 'Nai-Zhen 库狛项圈' }, // 纯英文名不进
  { en: 'Battery', zh: '电池' },
  { en: 'Kuva Bramma', zh: '赤毒·布拉玛' }, // 包含匹配：词根在词条中段
  { en: 'Kuva Bramma Prime', zh: '赤毒·布拉玛 Prime' },
  { en: 'Tigris Prime', zh: '猛虎 Prime' }, // 前缀包含（词根后接后缀）
];
const m = new ZhMatcher(entries);

// --- suggest：完全命中（含一对多）
{
  const items = m.suggest('电击');
  check('suggest 完全命中两个候选', items.length === 2 && items.every(x => x.exact), items);
  check('suggest 候选含 Electricity 与 Shock', items.some(x => x.en === 'Electricity') && items.some(x => x.en === 'Shock'), items);
}
// --- suggest：前缀扩展
{
  const items = m.suggest('电');
  check('前缀含 电击', items.some(x => x.zh === '电击'), items);
  check('前缀含 电力屏障', items.some(x => x.zh === '电力屏障'), items);
  // 输入不是完整词条时无 exact 项；等长 tie-break 用码点序（击 U+51FB < 池 U+6C60）→ 电击 最前
  check('前缀无 exact 项', items.every(x => !x.exact), items);
  check('码点序 电击 最前', items[0]?.zh === '电击', items);
}
// --- suggest：完全命中排最前（整词输入时 exact 项先于前缀扩展项）
{
  const items = m.suggest('电池');
  check('整词输入 exact 排最前', items[0]?.zh === '电池' && items[0]?.exact === true, items);
}
// --- suggest：括号变体可被基础词前缀命中
{
  const items = m.suggest('工匠桶');
  check('工匠桶 前缀命中（高）（矮）', items.length === 2 && items.every(x => !x.exact), items);
}
// --- suggest：边界
{
  check('suggest 纯英文输入为空', m.suggest('Excalibur').length === 0);
  check('suggest 空串为空', m.suggest('  ').length === 0);
  check('suggest limit 截断', m.suggest('电', 2).length === 2, m.suggest('电', 2));
  check('hasCJK 判定', hasCJK('电') && !hasCJK('abc123'));
}
// --- suggest：retained/纯英文 zh 不进索引
{
  check('Excalibur 不进反向索引', !m.suggest('Excalibur').length && !m.resolve('Excalibur x').hits.length);
  const items = m.suggest('Nai-Zhen');
  check('纯英文 zh 不进反向索引', items.length === 0, items);
}

// --- suggest：包含匹配（词根非前缀，如 布拉玛 ⊂ 赤毒·布拉玛）
{
  const items = m.suggest('布拉玛');
  check('包含匹配命中 赤毒·布拉玛', items.some(x => x.zh === '赤毒·布拉玛'), items);
  check('包含匹配命中 Prime 变体', items.some(x => x.zh === '赤毒·布拉玛 Prime'), items);
  check('包含排序：基础词先于变体', items.findIndex(x => x.zh === '赤毒·布拉玛') < items.findIndex(x => x.zh === '赤毒·布拉玛 Prime'), items);
}
// --- suggest：前缀命中优先于包含命中
{
  const items = m.suggest('猛虎');
  check('前缀包含 猛虎 Prime 命中', items[0]?.zh === '猛虎 Prime', items);
}
// --- suggest：单字符包含可出候选（仅下拉，用户点选）
{
  const items = m.suggest('玛');
  check('单字符包含出候选', items.some(x => x.zh === '赤毒·布拉玛'), items);
}
// --- suggest：完整词条（含间隔号）完全命中
{
  const items = m.suggest('赤毒·布拉玛');
  check('赤毒·布拉玛 完全命中', items[0]?.zh === '赤毒·布拉玛' && items[0]?.exact === true, items);
}
// --- suggest：混合查询整串无命中 → 最长中文段兜底
{
  const items = m.suggest('布拉玛 mod');
  check('混合查询按中文段匹配', items.some(x => x.zh === '赤毒·布拉玛'), items);
}
{
  const items = m.suggest('电 mod');
  check('混合查询单字中文段兜底', items.some(x => x.zh === '电击'), items);
}

// --- resolve：包含改写
{
  const r = m.resolve('布拉玛');
  check('resolve 整词包含改写', r.query === 'Kuva Bramma' && r.hits.length === 1 && r.hits[0]?.zh === '赤毒·布拉玛', r);
}
{
  const r = m.resolve('布拉玛 mod');
  check('resolve 混合查询包含改写', r.query === 'Kuva Bramma mod', r);
}
{
  const r = m.resolve('猛虎');
  check('resolve 前缀包含优先（猛虎→猛虎 Prime）', r.query === 'Tigris Prime', r);
}
{
  // 缺间隔号：整段 赤毒布拉玛 无包含词条放行，但滑动到词根 布拉玛 仍会包含改写
  // （半改写 "赤毒Kuva Bramma" 对站点全文搜索够用：AND 语义能找到目标页）
  const r = m.resolve('赤毒布拉玛');
  check('resolve 缺间隔号半改写', r.query === '赤毒Kuva Bramma' && r.hits.length === 1, r);
}

// --- resolve：改写
{
  const r = m.resolve('电击 mod');
  check('resolve 混合查询改写', r.query === 'Electricity mod' && r.hits.length === 1, r);
  check('resolve 一对多取字典序首位', r.hits[0]?.en === 'Electricity', r);
}
{
  const r = m.resolve('电击 set 电池');
  check('resolve 多片段', r.query === 'Electricity set Battery' && r.hits.length === 2, r);
}
{
  const r = m.resolve('电力屏障与电击');
  check('resolve 无空格粘连', r.query === 'Electric Shield与Electricity', r);
}
{
  const r = m.resolve('unknown 术语 x');
  check('resolve 无命中原样返回', r.query === 'unknown 术语 x' && r.hits.length === 0, r);
}
{
  const r = m.resolve('pure english query');
  check('resolve 纯英文不动', r.query === 'pure english query' && r.hits.length === 0, r);
}
{
  const r = m.resolve('电击');
  check('resolve 重复片段去重 hits', r.hits.length === 1, r);
}
{
  const r = m.resolve('Excalibur 电击');
  check('resolve 英文词保留', r.query.startsWith('Excalibur ') && r.hits.length === 1, r);
}
{
  // 单字符中文（无 ≥2 字词条可命中）原样保留
  const r = m.resolve('电');
  check('resolve 单字符中文放行', r.query === '电' && r.hits.length === 0, r);
}

// --- 真实合并数据冒烟（与运行时 mergeGlossaryLayers 一致的合并序）
{
  const root = path.join(__dirname, '../..');
  const data = JSON.parse(fs.readFileSync(path.join(root, 'data/de_names.json'), 'utf8')) as {
    terms: Record<string, string>;
    retained?: string[];
  };
  const mech = JSON.parse(fs.readFileSync(path.join(root, 'data/mechanism_terms.json'), 'utf8')) as Record<string, string>;
  const lang = JSON.parse(fs.readFileSync(path.join(root, 'data/lang_terms.json'), 'utf8')) as { terms: Record<string, string> };
  const overrides = JSON.parse(fs.readFileSync(path.join(root, 'data/manual_overrides.json'), 'utf8')) as Record<string, string>;
  const retained = new Set(((data.retained ?? []) as string[]).map(s => s.toLowerCase()));
  const merged: Record<string, string> = {};
  for (const [en, zh] of Object.entries(mech)) if (!retained.has(en.toLowerCase())) merged[en] = zh;
  for (const [en, zh] of Object.entries(lang.terms)) if (!retained.has(en.toLowerCase())) merged[en] = zh;
  for (const [en, zh] of Object.entries(data.terms)) merged[en] = zh;
  for (const [en, zh] of Object.entries(overrides)) merged[en] = zh;
  for (const en of Object.keys(merged)) if (!merged[en]) delete merged[en];
  const real = new ZhMatcher(Object.entries(merged).map(([en, zh]) => ({ en, zh })));
  const r = real.resolve('电击');
  check('真实数据 电击 命中', r.hits.length === 1 && /^[A-Za-z]/.test(r.query), r);
  check('真实数据 工匠桶 前缀命中括号变体', real.suggest('工匠桶').length === 2, real.suggest('工匠桶'));
  check('真实数据 建议不超 limit', real.suggest('伤害', 8).length <= 8);
  // 包含匹配（用户反馈场景）：布拉玛 ⊂ 赤毒·布拉玛
  const kuva = real.suggest('布拉玛');
  check('真实数据 布拉玛 包含命中 赤毒·布拉玛', kuva.some(x => x.zh === '赤毒·布拉玛'), kuva);
  const rk = real.resolve('布拉玛');
  check('真实数据 布拉玛 改写 Kuva Bramma', rk.query === 'Kuva Bramma' && rk.hits[0]?.zh === '赤毒·布拉玛', rk);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
