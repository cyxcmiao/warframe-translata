/** 缓存失效判定单元测试: node tools/test_sweep.js */
import { TermMatcher } from '../shared/matcher';
import { cacheEntryStale } from '../background/translate';
import type { TermEntry } from '../shared/types';

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

const mk = (entries: TermEntry[]) => new TermMatcher(entries);
const termsUsedOf = (m: { match(t: string): { en: string; zh: string }[] }, text: string) => {
  const o: Record<string, string> = {};
  for (const t of m.match(text)) if (!(t.en in o)) o[t.en] = t.zh;
  return o;
};

// --- 场景: 旧词表 Electricity→电流 落缓存，新词表改为 电击（本次 Electricity 案例的抽象）
{
  const oldM = mk([{ en: 'Electricity', zh: '电流' }, { en: 'Damage', zh: '伤害' }]);
  const newM = mk([{ en: 'Electricity', zh: '电击' }, { en: 'Electricity Damage', zh: '电击伤害' }]);
  const text = 'deals Electricity Damage to enemies';
  const used = termsUsedOf(oldM, text);
  check('译名变化 → 失效', cacheEntryStale(newM, text, used), used);
  check('同词表 → 不失效', !cacheEntryStale(oldM, text, used));
}

// --- 场景: 新增词条命中此前未匹配的文本
{
  const oldM = mk([{ en: 'Tigris', zh: '猛虎' }]);
  const newM = mk([{ en: 'Tigris', zh: '猛虎' }, { en: 'Tigris Prime', zh: '猛虎 Prime' }]);
  const text = 'The Tigris Prime is a shotgun.';
  const used = termsUsedOf(oldM, text);
  check('新增长词条命中 → 失效', cacheEntryStale(newM, text, used));
}

// --- 场景: 词条被删除（覆盖层空串删除语义）
{
  const oldM = mk([{ en: 'Safe', zh: '保险箱' }, { en: 'Vault', zh: '金库' }]);
  const newM = mk([{ en: 'Vault', zh: '金库' }]);
  const text = 'open the Safe and the Vault';
  const used = termsUsedOf(oldM, text);
  check('词条删除 → 失效', cacheEntryStale(newM, text, used));
  check('剩余词条不受牵连 → 不失效', !cacheEntryStale(newM, 'open the Vault', termsUsedOf(oldM, 'open the Vault')));
}

// --- 场景: 块内无词条命中（纯 AI 翻译文本）——词表更新不误伤
{
  const oldM = mk([{ en: 'Safe', zh: '保险箱' }]);
  const newM = mk([{ en: 'Safe', zh: '金库' }]);
  const text = 'The warframe dashes forward and shields allies.';
  check('无词条命中块 → 永不失效', !cacheEntryStale(newM, text, termsUsedOf(oldM, text)));
}

// --- 场景: 旧格式条目（无 text/termsUsed）→ 一次性清理
{
  const m = mk([{ en: 'Safe', zh: '保险箱' }]);
  check('缺 text → 失效', cacheEntryStale(m, undefined, { Safe: '保险箱' }));
  check('缺 termsUsed → 失效', cacheEntryStale(m, 'the Safe', undefined));
  check('两者都缺 → 失效', cacheEntryStale(m, undefined, undefined));
}

// --- 场景: 多词条块部分变化（长度相等但键不同也要检出）
{
  const oldM = mk([{ en: 'Safe', zh: '保险箱' }, { en: 'Vault', zh: '金库' }]);
  const newM = mk([{ en: 'Safe', zh: '保险箱' }, { en: 'Chest', zh: '宝箱' }]);
  const text = 'the Safe and the Vault';
  check('等长词条集键变化 → 失效', cacheEntryStale(newM, text, termsUsedOf(oldM, text)));
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exitCode = failed ? 1 : 0;
