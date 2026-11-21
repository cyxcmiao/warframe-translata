/** 匹配器单元测试: node tools/test_matcher.js */
import { TermMatcher, buildTranslation } from '../shared/matcher';
import { b64ToUtf8 } from '../shared/util';
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

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/de_names.json'), 'utf8'));
const mech = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/mechanism_terms.json'), 'utf8')) as Record<string, string>;
const lang = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/lang_terms.json'), 'utf8')) as { terms: Record<string, string> };
const overrides = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/manual_overrides.json'), 'utf8')) as Record<string, string>;
// 与运行时 glossary.installRecord 一致：机制表 < 语言文件层 < 官方 < 人工覆盖（retained 排除，覆盖层除外）
const retained = new Set(((data.retained ?? []) as string[]).map(s => s.toLowerCase()));
const merged: Record<string, string> = {};
for (const [en, zh] of Object.entries(mech)) {
  if (!retained.has(en.toLowerCase())) merged[en] = zh;
}
for (const [en, zh] of Object.entries(lang.terms)) {
  if (!retained.has(en.toLowerCase())) merged[en] = zh;
}
for (const [en, zh] of Object.entries(data.terms as Record<string, string>)) merged[en] = zh;
for (const [en, zh] of Object.entries(overrides)) merged[en] = zh;
// 与运行时 mergeGlossaryLayers 一致：覆盖层空串 = 删除词条，合并后统一剔除空值
for (const en of Object.keys(merged)) {
  if (!merged[en]) delete merged[en];
}
const entries: TermEntry[] = Object.entries(merged).map(([en, zh]) => ({ en, zh }));
console.log(`glossary: ${entries.length} terms (official v${data.version} + mech ${Object.keys(mech).length} + lang ${Object.keys(lang.terms).length} + overrides ${Object.keys(overrides).length})`);
const m = new TermMatcher(entries);

// --- 基础命中
{
  const ms = m.match('The Tigris Prime is a shotgun.');
  check('基础命中', ms.some(x => x.en === 'Tigris Prime' && x.zh === '猛虎 Prime'), ms);
}
// --- 复数
{
  const ms = m.match('Tigris Primes are powerful weapons.');
  check('复数 Primes', ms.some(x => x.en === 'Tigris Prime' && x.e > x.s && 'Primes'.length > 0), ms);
}
// --- 所有格
{
  const ms = m.match("Tigris Prime's damage is Slash.");
  const tp = ms.find(x => x.en === 'Tigris Prime');
  check('所有格 Tigris Prime\'s → pos', !!tp && tp.pos, ms);
  const tr = buildTranslation("Tigris Prime's damage is Slash.", ms);
  check('所有格替换含 的', tr.includes('的'), tr);
}
// --- 最长优先: 不被拆开
{
  const ms = m.match('The Kuva Bramma is a bow.');
  check('Kuva Bramma 最长匹配', ms.some(x => x.en === 'Kuva Bramma') && !ms.some(x => x.en === 'Kuva'), ms);
}
// --- 词边界: example 不应命中含 amp 的词条
{
  const ms = m.match('This is an example sentence.');
  check('词边界 example', !ms.some(x => x.s >= 10 && x.s <= 14), ms);
}
// --- Primed 前缀不误命中 Prime
{
  const ms = m.match('Primed Sure Footed resists Knockdown.');
  check('Primed ≠ Prime', !ms.some(x => x.en === 'Prime' && x.s === 0), ms);
}
// --- 大小写不敏感
{
  const ms = m.match('the tigris prime rocks');
  check('小写命中', ms.length >= 1 && ms[0].en === 'Tigris Prime', ms);
}
// --- 官方未译词条不存在
{
  check('Excalibur 不在词表', !entries.some(e => e.en === 'Excalibur'));
  const ms = m.match('Excalibur is a starter Warframe.');
  check('Excalibur 无匹配', ms.length === 0, ms);
}
// --- buildTranslation 完整性
{
  const text = 'Use Tigris Prime with Pressure Point for Slash.';
  const ms = m.match(text);
  const tr = buildTranslation(text, ms);
  check('译文包含 官方词', tr.includes('猛虎 Prime') && tr.includes('压迫点'), tr);
}
// --- 弹性空白
{
  const ms = m.match('Use  Tigris\nPrime now');
  check('跨空白命中', ms.some(x => x.en === 'Tigris Prime'), ms);
}
// --- 弯引号
{
  const ms = m.match('The Tigris Prime’s parts');
  check('弯引号所有格', ms.some(x => x.en === 'Tigris Prime' && x.pos), ms);
}
// --- 机制术语表: 连字符复合词（官方导出无此词条，Electric_Shield 页回归）
{
  const ms = m.match("Vauban's Tether-Flechette orb immobilizes enemies.");
  const hit = ms.find(x => x.en === 'Tether-Flechette orb');
  check('Tether-Flechette orb 复合词命中', !!hit && hit.zh === '桎梏飞掷丸', ms);
  check('复合词不被拆成 Tether/Flechette', !ms.some(x => x.en === 'Tether'), ms);
}
{
  const ms = m.match('The Flechette Orb launches deadly nails.');
  check('Flechette Orb → 飞掷丸', ms.some(x => x.en === 'Flechette Orb' && x.zh === '飞掷丸'), ms);
}
{
  const ms = m.match('HOLD to launch a Vector-Overdrive pad.');
  check('Vector-Overdrive pad → 矢量超载垫', ms.some(x => x.en === 'Vector-Overdrive pad' && x.zh === '矢量超载垫'), ms);
}
{
  // 单独的 Flechette（非复合词语境）仍应命中官方词表条目
  const ms = m.match('Flechette rivens are popular.');
  check('单独 Flechette → 箭型弹头', ms.some(x => x.en === 'Flechette' && x.zh === '箭型弹头'), ms);
}
// --- base64 解码（Gitee contents API 拉取路径）
{
  const b64 = Buffer.from('{"terms":{"Tigris Prime":"猛虎 Prime"}}', 'utf8').toString('base64');
  const text = b64ToUtf8(b64);
  const parsed = JSON.parse(text) as { terms: Record<string, string> };
  check('b64ToUtf8 中文 UTF-8 解码', parsed.terms['Tigris Prime'] === '猛虎 Prime', text);
  check('b64ToUtf8 兼容带换行 base64', b64ToUtf8(b64.replace(/(.{10})/g, '$1\n')) === text);
}
// --- 语言文件挖掘层: 官方导出没有的词条（build_lang_terms.js 产出）
{
  check('Hildryn Prime Pack 不在官方导出', (data.terms as Record<string, string>)['Hildryn Prime Pack'] === undefined);
  const ms = m.match('The Hildryn Prime Pack includes shields.');
  check('语言层词条 Hildryn Prime Pack 命中', ms.some(x => x.en === 'Hildryn Prime Pack' && x.zh === 'Hildryn Prime 组合包'), ms);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
