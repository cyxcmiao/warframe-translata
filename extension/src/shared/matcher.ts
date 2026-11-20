/**
 * TermMatcher — 词表匹配器
 *
 * Trie + 最长优先 + 词边界 + 大小写不敏感 + 复数/所有格后缀。
 * 词条空格可弹性匹配任意空白串。
 * 复杂度 O(文本长度 × 词条深度)，9.6k 词条对整页文本毫秒级。
 */
import type { TermEntry, TermMatch } from './types';

interface TrieNode {
  ch: Map<string, TrieNode>;
  term?: { en: string; zh: string };
}

const isWord = (c: string) => /[a-z0-9]/i.test(c);
const normalize = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'");

export class TermMatcher {
  private root: TrieNode = { ch: new Map() };

  constructor(entries: TermEntry[]) {
    for (const { en, zh } of entries) {
      const key = normalize(en).replace(/\s+/g, ' ').trim();
      if (key.length < 2) continue;
      let node = this.root;
      for (const c of key) {
        let next = node.ch.get(c);
        if (!next) {
          next = { ch: new Map() };
          node.ch.set(c, next);
        }
        node = next;
      }
      // 同名词条先到先得（构建端已做冲突处理）
      if (!node.term) node.term = { en, zh };
    }
  }

  match(text: string): TermMatch[] {
    const lower = normalize(text);
    const res: TermMatch[] = [];
    let i = 0;
    while (i < lower.length) {
      const m = this.matchAt(lower, i);
      if (m) {
        res.push(m);
        i = m.e;
      } else {
        i++;
      }
    }
    return res;
  }

  private matchAt(lower: string, i: number): TermMatch | null {
    // 命中起点必须是词边界
    if (i > 0 && isWord(lower[i - 1])) return null;

    let node: TrieNode = this.root;
    let best: { term: { en: string; zh: string }; end: number } | null = null;
    let idx = i;
    while (idx < lower.length) {
      const c = lower[idx];
      if (/\s/.test(c)) {
        // 词条中的空格可匹配任意空白串（含空格/换行/制表）
        const sp = node.ch.get(' ');
        if (!sp) break;
        let j = idx;
        while (j < lower.length && /\s/.test(lower[j])) j++;
        node = sp;
        idx = j;
        if (node.term) best = { term: node.term, end: idx };
        continue;
      }
      const next = node.ch.get(c);
      if (!next) break;
      node = next;
      idx++;
      if (node.term) best = { term: node.term, end: idx };
    }
    if (!best) return null;

    // 词尾扩展：所有格 's 优先，其次复数 es/s；扩展后仍要求词边界
    let end = best.end;
    let pos = false;
    const rest = lower.slice(end);
    const apos = /^(?:'s)(?![a-z0-9])/.exec(rest);
    if (apos) {
      end += apos[0].length;
      pos = true;
    } else {
      const plural = /^(?:es|s)(?![a-z0-9])/.exec(rest);
      if (plural) end += plural[0].length;
    }
    const after = lower[end];
    if (after !== undefined && isWord(after)) return null; // 例: "primespecial" 不算命中

    return { s: i, e: end, en: best.term.en, zh: best.term.zh, pos };
  }
}

/** 按匹配结果把原文替换为官方译名（词典直译模式的产物） */
export function buildTranslation(text: string, matches: TermMatch[]): string {
  let out = '';
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.s) + m.zh + (m.pos ? '的' : '');
    last = m.e;
  }
  out += text.slice(last);
  return out.replace(/ {2,}/g, ' ');
}
