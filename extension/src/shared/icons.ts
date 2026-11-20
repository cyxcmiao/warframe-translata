/**
 * icons.ts — 图标占位符与后随锚点的配对/重定位（纯函数，无环境依赖）
 *
 * 观察: wiki 行内小图标几乎总是锚定在其后随的数字或词表术语前
 * （能量球 → 25 Energy、伤害图标 → Slash、范围图标 → 36 m/s）。
 * AI 译文语序调整时占位符可能跟丢锚点，这里按官方译名/数字原值吸附回来。
 */
import { tokenRegex, makeToken } from './const';
import type { TermMatch } from './types';

/**
 * 图标 token id → 锚点文本（后随数字原值，或后随词表术语的官方译名）。
 * matches 为背景侧词表匹配结果（位置基于 text）。
 */
export function buildIconPairs(text: string, iconIds: number[], matches: TermMatch[]): Map<number, string> {
  const pairs = new Map<number, string>();
  if (!iconIds.length) return pairs;
  for (const m of text.matchAll(tokenRegex)) {
    const id = Number(m[1]);
    if (!iconIds.includes(id)) continue;
    let j = (m.index ?? 0) + m[0].length;
    while (j < text.length && /\s/.test(text[j])) j++;
    const rest = text.slice(j);
    // 后随数字（数值/百分比通常不翻译，直接作锚点）
    const num = /^\d{1,4}(?:\.\d+)?/.exec(rest);
    if (num) {
      pairs.set(id, num[0]);
      continue;
    }
    // 后随词表术语 → 官方译名作锚点
    const term = matches.find(t => t.s === j);
    if (term) pairs.set(id, term.zh);
  }
  return pairs;
}

/**
 * 译文重定位: 图标占位符未紧邻其锚点、且锚点在译文中唯一时，
 * 把占位符移动到锚点之前。锚点缺失或多处出现时不动（宁缺勿错）。
 */
export function reanchorIcons(_src: string, out: string, pairs: Map<number, string>): string {
  if (!pairs.size) return out;
  let res = out;
  for (const [id, anchor] of pairs) {
    const tok = makeToken(id);
    const ti = res.indexOf(tok);
    if (ti < 0) continue;
    if (res.slice(ti + tok.length).trimStart().startsWith(anchor)) continue; // 已紧邻
    const first = res.indexOf(anchor);
    if (first < 0 || res.indexOf(anchor, first + 1) >= 0) continue; // 无锚点/多处出现 → 不动
    res = res.slice(0, ti) + res.slice(ti + tok.length); // 摘出占位符
    const at = res.indexOf(anchor);
    res = res.slice(0, at) + tok + res.slice(at);
  }
  return res;
}
