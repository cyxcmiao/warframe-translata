/**
 * ZhMatcher — 词表反向匹配器（zh→en），搜索框中文术语支持的核心
 *
 * 与 TermMatcher(en→zh) 方向相反：同名 zh 可对应多个 en（官方同名译名，
 * 如 电击 → Electricity|Shock）。suggest 返回全部候选供用户点选消歧，
 * resolve 按确定性排序取第一个改写。不依赖 AI，纯本地词表。
 *
 * 复杂度：suggest 精确/前缀 O(log n + 命中数)，包含补位线性扫 keys（2 万条 includes 毫秒级）；
 * resolve 逐位置贪心最长匹配 + 未命中段包含匹配，O(文本长 × (maxKeyLen + 一次全扫))。
 */
import type { TermEntry, ZhResolveHit, ZhSuggestItem } from './types';

/** CJK 统一表意文字（含扩展 A）——zh 词条必须含中文才进反向索引 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** 码点序比较：localeCompare 的中文排序随环境 ICU 不同（拼音 vs 码点），跨环境不确定 */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function hasCJK(s: string): boolean {
  return CJK_RE.test(s);
}

export class ZhMatcher {
  /** zh → en 候选（prio 词条排最前，其余字典序，确定性） */
  private exact = new Map<string, string[]>();
  /** 含 CJK 的 zh key 升序数组（前缀二分用） */
  private keys: string[] = [];
  private maxKeyLen = 0;

  constructor(entries: TermEntry[]) {
    const raw = new Map<string, Set<string>>();
    const prioEns = new Map<string, Set<string>>();
    for (const { en, zh, prio } of entries) {
      const key = zh.replace(/\s+/g, ' ').trim();
      // 只索引含中文的词条：zh===en（retained/强制保留英文）与纯英文名没有中文可输入
      if (key.length < 2 || !hasCJK(key) || key === en.trim()) continue;
      let set = raw.get(key);
      if (!set) {
        set = new Set();
        raw.set(key, set);
      }
      set.add(en);
      if (prio) {
        let ps = prioEns.get(key);
        if (!ps) {
          ps = new Set();
          prioEns.set(key, ps);
        }
        ps.add(en);
      }
    }
    for (const [zh, set] of raw) {
      // prio（用户自定义）候选排最前：resolve 取首个改写、suggest 完全命中按此序展示
      const ps = prioEns.get(zh);
      const head = ps ? [...ps].sort(cmp) : [];
      const rest = ps ? [...set].filter(en => !ps.has(en)).sort(cmp) : [...set].sort(cmp);
      this.exact.set(zh, [...head, ...rest]);
    }
    this.keys = [...raw.keys()].sort(cmp);
    for (const k of this.keys) this.maxKeyLen = Math.max(this.maxKeyLen, k.length);
  }

  /**
   * 候选：完全命中排最前（exact 标记），其余按 zh 长度升序
   * （基础词先于括号变体，如 电击 先于 电击伤害 Mod 基础组合包）再按 zh/en 码点序；
   * 前缀候选不足 limit 时用包含匹配补位（如 布拉玛 → 赤毒·布拉玛）；
   * 整串无命中（混合查询 布拉玛 mod）退用最长中文段匹配。
   */
  suggest(q: string, limit = 8): ZhSuggestItem[] {
    const qn = q.replace(/\s+/g, ' ').trim();
    if (!qn || !hasCJK(qn)) return [];
    const items = this.suggestCore(qn, limit);
    if (items.length) return items;
    // 整串无命中（混合查询如 布拉玛 mod）：退而用查询里最长的连续中文段匹配，
    // 否则混合输入的下拉永远空白
    const runs = qn.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? [];
    if (!runs.length) return [];
    const frag = runs.sort((a, b) => b.length - a.length)[0];
    return !frag || frag === qn ? [] : this.suggestCore(frag, limit);
  }

  private suggestCore(qn: string, limit: number): ZhSuggestItem[] {
    const items: ZhSuggestItem[] = [];
    const seenEn = new Set<string>();
    const seenZh = new Set<string>([qn]);
    for (const en of this.exact.get(qn) ?? []) {
      items.push({ en, zh: qn, exact: true });
      seenEn.add(en);
    }
    if (items.length < limit) {
      // 二分定位第一个 >= qn 的 key，向后线性扫前缀命中
      let lo = 0;
      let hi = this.keys.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.keys[mid] < qn) lo = mid + 1;
        else hi = mid;
      }
      const prefix: Array<{ zh: string; en: string }> = [];
      for (let i = lo; i < this.keys.length && this.keys[i].startsWith(qn); i++) {
        const zh = this.keys[i];
        if (zh === qn) continue; // 完全命中已收录
        for (const en of this.exact.get(zh)!) {
          if (!seenEn.has(en)) prefix.push({ zh, en });
        }
      }
      prefix.sort(
        (a, b) => a.zh.length - b.zh.length || cmp(a.zh, b.zh) || cmp(a.en, b.en),
      );
      for (const p of prefix) {
        if (items.length >= limit) break;
        items.push({ en: p.en, zh: p.zh, exact: false });
        seenEn.add(p.en);
        seenZh.add(p.zh);
      }
      // 包含匹配补位：线性扫全量 keys（2 万条 includes 毫秒级，防抖后逐键可承受）
      if (items.length < limit) {
        const contains: Array<{ zh: string; en: string }> = [];
        for (const zh of this.keys) {
          if (seenZh.has(zh) || !zh.includes(qn)) continue;
          for (const en of this.exact.get(zh)!) {
            if (!seenEn.has(en)) contains.push({ zh, en });
          }
        }
        contains.sort(
          (a, b) => a.zh.length - b.zh.length || cmp(a.zh, b.zh) || cmp(a.en, b.en),
        );
        for (const p of contains) {
          if (items.length >= limit) break;
          items.push({ en: p.en, zh: p.zh, exact: false });
          seenEn.add(p.en);
        }
      }
    }
    return items;
  }

  /**
   * 包含匹配的最佳词条：连续中文段被某词条包含时（如 布拉玛 ⊂ 赤毒·布拉玛），
   * 取 前缀包含 > 更短 zh > 码点序 的第一个（最短包含 ≈ 用户想打的基础词，
   * Prime 等变体更长排后面）。run 少于 2 字不参与（单字包含改写过于激进）。
   */
  private bestContaining(run: string): string | null {
    if (run.length < 2) return null;
    let best: string | null = null;
    for (const key of this.keys) {
      if (!key.includes(run)) continue;
      if (
        best === null ||
        (key.startsWith(run) && !best.startsWith(run)) ||
        key.length < best.length ||
        (key.length === best.length && cmp(key, best) < 0)
      ) {
        best = key;
      }
    }
    return best;
  }

  /**
   * 查询串改写：对每个 CJK 起点贪心取最长 zh 命中，替换为其第一个 en 候选。
   * 没命中的中文片段原样保留（交站点自身搜索兜底）；纯英文查询原样返回。
   */
  /**
   * 查询串改写：对每个 CJK 起点贪心取最长 zh 命中，替换为其第一个 en 候选；
   * 无精确命中的连续中文段尝试包含改写（布拉玛 → 赤毒·布拉玛 → Kuva Bramma，
   * 最短包含词条）。都没命中的中文片段原样保留（交站点自身搜索兜底）；
   * 纯英文查询原样返回。
   */
  resolve(q: string): { query: string; hits: ZhResolveHit[] } {
    if (!q || !hasCJK(q)) return { query: q, hits: [] };
    let out = '';
    let last = 0;
    let i = 0;
    const hits: ZhResolveHit[] = [];
    while (i < q.length) {
      if (!CJK_RE.test(q[i])) {
        i++;
        continue;
      }
      let hit: ZhResolveHit | null = null;
      const maxLen = Math.min(this.maxKeyLen, q.length - i);
      for (let len = maxLen; len >= 2; len--) {
        const ens = this.exact.get(q.slice(i, i + len));
        if (ens?.length) {
          hit = { zh: q.slice(i, i + len), en: ens[0] };
          break;
        }
      }
      if (hit) {
        const got = hit;
        out += q.slice(last, i) + got.en;
        last = i + got.zh.length;
        i = last;
        if (!hits.some(h => h.zh === got.zh)) hits.push(got);
      } else {
        // 包含改写：整个连续中文段被某词条包含时改写为最短包含词条的译名
        let j = i;
        while (j < q.length && CJK_RE.test(q[j])) j++;
        const run = q.slice(i, j);
        const best = this.bestContaining(run);
        if (best) {
          const en = this.exact.get(best)![0];
          out += q.slice(last, i) + en;
          last = j;
          i = j;
          if (!hits.some(h => h.zh === best)) hits.push({ zh: best, en });
        } else {
          i++;
        }
      }
    }
    out += q.slice(last);
    return { query: out, hits };
  }
}
