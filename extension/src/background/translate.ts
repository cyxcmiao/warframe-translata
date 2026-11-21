/**
 * translate.ts — 翻译编排
 *
 * 流程: 缓存 → 词表匹配（词典终局判断，省 token）→ AI 批量请求（并发池）+ 译后校验 → 回写缓存。
 * 词表译名最高优先级: AI 译文里若残留英文术语，强制替换为官方译名。
 * 未配置 API Key: 不做任何翻译（原文直返），由 content 弹提示告知用户。
 * AI 请求失败的块保留原文（不落缓存，修复后重试即可正常翻译），content 据此弹提醒。
 */
import { getMatcher, ensureGlossary, getRetainedMatcher } from './glossary';
import { buildTranslation } from '../shared/matcher';
import { tokenRegex, makeToken, escapeRegex, PROMPT_VERSION } from '../shared/const';
import type { BlockIn, BlockOut, Settings, TermEntry, TermMatch } from '../shared/types';
import { sha256hex } from '../shared/util';
import { buildIconPairs, reanchorIcons } from '../shared/icons';
import { chatWithRetry, classifyAiError, AiErrKind, TRANSLATE_SYSTEM_PROMPT, AiConfig } from './ai';
import { addUsage } from './usage';
import { idbOpen, idbGet, idbPut, idbKeys, idbGetAll, idbClear } from '../shared/idb';
import { glossaryMeta } from './glossary';

const MAX_BLOCKS_PER_REQ = 16;
const MAX_CHARS_PER_REQ = 1600;
const MAX_TERMS_PER_REQ = 60;
/**
 * AI 分批的并发数。DeepSeek 官方并发上限为账号级（deepseek-v4-pro 500 起，
 * api-docs.deepseek.com/quick_start/rate_limit），远高于此值；取小值是为了兼容
 * 第三方 OpenAI 兼容接口的保守限流。超限 429 由 chatWithRetry 的退避重试兜底。
 */
const AI_CONCURRENCY = 6;

interface CacheVal {
  translation: string;
  viaAI: boolean;
}

let tdb: IDBDatabase | null = null;
function getTdb(): Promise<IDBDatabase> {
  if (tdb) return Promise.resolve(tdb);
  return idbOpen('tw', 1).then(d => {
    tdb = d;
    return d;
  });
}

async function cacheKey(text: string, settings: Settings): Promise<string> {
  const gv = glossaryMeta().version;
  // PROMPT_VERSION: 提示词/机制词表升级时 bump，旧缓存自然失效重翻
  return ['tr', PROMPT_VERSION, gv, settings.aiModel, await sha256hex(text)].join('|');
}

function getCache(key: string): Promise<CacheVal | undefined> {
  return getTdb().then(d => idbGet<CacheVal>(d, 'tcache', key));
}
function putCache(key: string, val: CacheVal): Promise<void> {
  return getTdb().then(d => idbPut(d, 'tcache', val, key));
}

/** 批内术语表（命中去重，限制数量防 token 膨胀） */
function collectTerms(allMatches: Map<string, TermMatch[]>): TermEntry[] {
  const seen = new Map<string, string>();
  for (const ms of allMatches.values()) {
    for (const m of ms) if (!seen.has(m.en)) seen.set(m.en, m.zh);
  }
  return [...seen.entries()].slice(0, MAX_TERMS_PER_REQ).map(([en, zh]) => ({ en, zh }));
}

/** ASCII 单词（含连字符/撇号，如 "Kuva-Lich"、"Xiphos"） */
const ASCII_WORD = /[A-Za-z][A-Za-z0-9'’\-]*/g;

/** 数值+可选单位后缀（36 / 2x / 1.5s / 40% / 36m/s） */
const NUM_TOKEN = /^\d{1,5}(?:[.,]\d+)?(?:m|cm|mm|km|s|ms|sec|min|hr|kg|g|t|lb|x|%|°c|°f|°|m\/s)?$/i;
/** 独立单位词（36 m 的 m） */
const UNIT_TOKEN = /^(m|cm|mm|km|s|ms|sec|min|hr|kg|g|t|lb|x|°c|°f|°|m\/s|cr|pt)$/i;
/** 万能占位词：表格里的 None / N/A 等没有翻译价值 */
const PLACEHOLDER_WORDS = new Set(['none', 'n/a', 'na', 'unknown', 'tbd', 'varies', 'null', 'undetermined', 'not applicable']);

/** 纯数值+单位单元格（"36 m"、"2x"、"1.5 s"）：无需翻译，不送 AI。块长上限防误伤长句 */
function isNumUnit(text: string): boolean {
  if (text.length > 24) return false;
  const words = text.split(/[\s,~±–—]+/).filter(Boolean);
  if (!words.length) return false;
  return words.every(w => NUM_TOKEN.test(w) || UNIT_TOKEN.test(w));
}

function isPlaceholder(text: string): boolean {
  return text.length <= 16 && PLACEHOLDER_WORDS.has(text.toLowerCase());
}

/**
 * 词典直译是否已经"终结"该块：块内英文要么已被官方译名替换，要么属于官方保留
 * 英文原名（Excalibur/Forma 这类 zh===en 的条目），要么是官方中文译名里本就
 * 保留的英文（"猛虎 Prime" 的 Prime）—— 此时 AI 只会把同样的内容抄一遍，
 * 白耗 token，还把行数浪费在无意义的行上。
 */
function dictIsFinal(dictTr: string, matches: TermMatch[]): boolean {
  const trimmed = dictTr.trim();
  if (isNumUnit(trimmed) || isPlaceholder(trimmed)) return true;
  if (!/[A-Za-z]/.test(dictTr)) return true;
  // 官方译名里出现的英文片段（Prime/Vandal/Incarnon…）视为合法残留
  const allowed = new Set<string>();
  for (const m of matches) {
    for (const w of m.zh.match(ASCII_WORD) ?? []) allowed.add(w.toLowerCase());
  }
  // 先摘掉官方保留英文名，再看剩下的英文是否都被允许
  let rest = '';
  let last = 0;
  for (const m of getRetainedMatcher().match(dictTr)) {
    rest += dictTr.slice(last, m.s) + ' ';
    last = m.e;
  }
  rest += dictTr.slice(last);
  for (const w of rest.match(ASCII_WORD) ?? []) {
    if (!allowed.has(w.toLowerCase())) return false;
  }
  return true;
}

function chunkBlocks(blocks: BlockIn[]): BlockIn[][] {
  const chunks: BlockIn[][] = [];
  let cur: BlockIn[] = [];
  let chars = 0;
  for (const b of blocks) {
    if (cur.length >= MAX_BLOCKS_PER_REQ || chars + b.text.length > MAX_CHARS_PER_REQ) {
      if (cur.length) chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(b);
    chars += b.text.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** 校验 AI 译文的链接占位符完整性 */
function tokensIntact(src: string, out: string): boolean {
  const srcIds = [...src.matchAll(tokenRegex)].map(m => m[1]).sort();
  const outIds = [...out.matchAll(tokenRegex)].map(m => m[1]).sort();
  return srcIds.join(',') === outIds.join(',');
}

/** 译后校验: AI 译文残留的英文术语强制替换为官方译名 */
function enforceTerms(translation: string, terms: TermEntry[]): string {
  let out = translation;
  for (const { en, zh } of terms) {
    // 后缀簇(es|s|'s)整体可选，但之后必须紧跟词边界，避免 "Primed" 命中 "Prime"
    const re = new RegExp(
      `(^|[^A-Za-z0-9])${escapeRegex(en)}(es|s|'s|’s)?(?![A-Za-z0-9])`,
      'gi',
    );
    out = out.replace(re, (_all, pre: string, suf: string | undefined) => {
      return `${pre}${zh}${suf && /'s|’s/.test(suf) ? '的' : ''}`;
    });
  }
  return out;
}

interface AiRespParsed {
  [id: string]: string;
}

function parseNumbered(raw: string): AiRespParsed {
  const out: AiRespParsed = {};
  const re = /\[(\d+)\]\s*([\s\S]*?)(?=\[\d+\]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * 翻译结果: results 为各块的译文（失败块 = 原文）；aiFailed 表示本轮有 AI 请求失败，
 * aiError 为首个错误的分型（auth/rate/timeout/server/network），content 据此弹可操作的提醒。
 */
export interface TranslateResult {
  results: Record<string, BlockOut>;
  aiFailed?: boolean;
  aiError?: AiErrKind;
}

/**
 * 进行中请求合并：相同缓存 key 的并发翻译共享同一个 Promise，
 * 避免上一批未返回时再次触发翻译造成重复请求。
 * inflight 在扫描期同步注册（缓存查询之后立即），消除并发交错窗口。
 */
const inflight = new Map<string, Promise<CacheVal>>();

function withTimeout(p: Promise<CacheVal>, ms: number): Promise<CacheVal | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>(r => setTimeout(() => r(null), ms)),
  ]);
}

export async function translateBlocks(blocks: BlockIn[], settings: Settings): Promise<TranslateResult> {
  const results: Record<string, BlockOut> = {};
  // 未配置 API Key：翻译不启用，原文直接返回
  if (!settings.aiKey) {
    for (const b of blocks) {
      if (!b.text.trim()) {
        results[b.id] = { id: b.id, ok: false, error: 'empty' };
        continue;
      }
      results[b.id] = { id: b.id, ok: true, translation: b.text };
    }
    return { results };
  }
  await ensureGlossary();
  let aiFailed = false;
  let aiError: AiErrKind | undefined;

  interface Job {
    id: string;
    text: string;
    matches: TermMatch[];
    key: string;
    iconIds: number[]; // 文本内图标占位符 id（AI 语序调整后按锚点重定位）
  }
  const jobs: Job[] = [];
  // 等待其他并发请求的相同文本（直接持有其 Promise 引用，结束后统一 await）
  const shared: Array<{ id: string; p: Promise<CacheVal> }> = [];
  const resolvers = new Map<string, (v: CacheVal) => void>();

  // 1. 扫描：查缓存 → 命中直接出结果；未命中立即原子注册 inflight
  for (const b of blocks) {
    if (!b.text.trim()) {
      results[b.id] = { id: b.id, ok: false, error: 'empty' };
      continue;
    }
    // 纯占位符块（表头/目录项等只含链接的容器）: 原样返回，渲染时用链接译名还原。
    // 不查缓存不送 AI —— 文本只有 ⟦n⟧ 时词典必然无命中，且不同块的 sha256 相同白占缓存
    if (!b.text.replace(tokenRegex, '').trim()) {
      results[b.id] = { id: b.id, ok: true, translation: b.text };
      continue;
    }
    const key = await cacheKey(b.text, settings);
    const hit = await getCache(key);
    if (hit) {
      results[b.id] = { id: b.id, ok: true, translation: hit.translation, viaAI: hit.viaAI };
      continue;
    }
    const running = inflight.get(key);
    if (running) {
      shared.push({ id: b.id, p: running });
      continue;
    }
    const matches = getMatcher().match(b.text);
    const dictTr = buildTranslation(b.text, matches);
    // 词典已给出终局译文的块不再送去 AI（占全页相当比例的链接文本、短单元格）
    if (dictIsFinal(dictTr, matches)) {
      const v: CacheVal = { translation: dictTr, viaAI: false };
      putCache(key, v).catch(() => {});
      results[b.id] = { id: b.id, ok: true, translation: v.translation, viaAI: false };
      continue;
    }
    const p = new Promise<CacheVal>(res => resolvers.set(key, res));
    inflight.set(key, p);
    jobs.push({ id: b.id, text: b.text, matches, key, iconIds: b.icons ?? [] });
  }

  const aiCfg: AiConfig = { baseUrl: settings.aiBaseUrl, key: settings.aiKey, model: settings.aiModel };

  // 2. 分批翻译（并发池）；每批无论成败都保证 resolve（失败块保留原文），避免 inflight 悬挂。
  //    批间操作按缓存 key / 块 id 隔离，无共享可变状态（aiFailed/aiError 为简单标志位）
  const jobByKey = new Map(jobs.map(j => [j.key, j]));
  const chunks = chunkBlocks(jobs.map(j => ({ id: j.key, text: j.text })));
  const runChunk = async (chunk: BlockIn[]): Promise<void> => {
    const inChunk = chunk.map(c => ({ job: jobByKey.get(c.id)! }));
    const matchesMap = new Map(inChunk.map(it => [it.job.key, it.job.matches]));
    const terms = collectTerms(matchesMap);
    const done = new Map<string, CacheVal>();

    try {
      try {
        const numbering = inChunk.map((it, i) => `[${i + 1}] ${it.job.text}`).join('\n');
        const termBlock = terms.length
          ? '术语表：\n' + terms.map(t => `${t.en} => ${t.zh}`).join('\n') + '\n\n'
          : '';
        const user = `${termBlock}文本：\n${numbering}`;
        const { content: raw, truncated, usage } = await chatWithRetry(aiCfg, TRANSLATE_SYSTEM_PROMPT, user);
        addUsage(usage); // 接口自带的用量，顺手记账（不发额外请求）
        const parsed = parseNumbered(raw);
        if (truncated) {
          // 被 max_tokens 截断时末尾行不可信：删掉编号最大的那条，走原文兜底
          const ids = Object.keys(parsed);
          if (ids.length) delete parsed[ids.reduce((a, b) => (+b > +a ? b : a))];
        }
        inChunk.forEach((it, i) => {
          let tr = parsed[String(i + 1)];
          if (!tr || !tokensIntact(it.job.text, tr)) return; // 缺行/链接占位符破坏 → 保留原文
          if (tr.trim() === it.job.text.trim()) return; // AI 原样回显 = 假译文：不落缓存、不渲染
          tr = enforceTerms(tr, terms);
          // 图标占位符跟丢锚点（AI 语序调整）→ 吸附回数字/官方译名之前
          tr = reanchorIcons(it.job.text, tr, buildIconPairs(it.job.text, it.job.iconIds, it.job.matches));
          done.set(it.job.key, { translation: tr, viaAI: true });
        });
      } catch (e) {
        console.warn('AI chunk failed:', e);
        aiFailed = true;
        aiError ??= classifyAiError(e);
      }
    } finally {
      // 无论成功失败，该批全部落定：resolve 等待者 + 移除 inflight（失败块保留原文、不落缓存）
      for (const it of inChunk) {
        const v = done.get(it.job.key);
        if (v) putCache(it.job.key, v).catch(() => {});
        const out: CacheVal = v ?? { translation: it.job.text, viaAI: false };
        const res = resolvers.get(it.job.key);
        if (res) {
          res(out);
          resolvers.delete(it.job.key);
        }
        inflight.delete(it.job.key);
        results[it.job.id] = { id: it.job.id, ok: true, translation: out.translation, viaAI: out.viaAI };
      }
    }
  };
  // 并发池：worker 共享游标同步取批（取批与自增之间无 await，不会重复/漏批）
  let nextChunk = 0;
  await Promise.all(
    Array.from({ length: Math.min(AI_CONCURRENCY, chunks.length) }, async () => {
      while (nextChunk < chunks.length) {
        await runChunk(chunks[nextChunk++]);
      }
    }),
  );

  // 3. 等待共享的进行中结果（此时本请求自己的任务已全部落定，不会自等）
  for (const s of shared) {
    const v = await withTimeout(s.p, 120000);
    results[s.id] = v
      ? { id: s.id, ok: true, translation: v.translation, viaAI: v.viaAI }
      : { id: s.id, ok: false, error: 'shared-timeout' };
  }

  return aiFailed ? { results, aiFailed: true, aiError } : { results };
}

/** 翻译缓存统计（条数 + 估算字节数，供设置页展示） */
export async function cacheStats(): Promise<{ count: number; bytes: number }> {
  const d = await getTdb();
  const [keys, vals] = await Promise.all([
    idbKeys(d, 'tcache'),
    idbGetAll<CacheVal>(d, 'tcache'),
  ]);
  // IDB 字符串按 UTF-16 存：key + 译文长度 ×2 字节 + 每条固定开销
  const bytes = vals.reduce((acc, v, i) => {
    const k = keys[i] as string ?? '';
    return acc + ((k.length + (v?.translation?.length ?? 0) + 8) * 2);
  }, 0);
  return { count: keys.length, bytes };
}

/** 清空翻译缓存（保留词表），返回清空后的统计 */
export async function cacheClear(): Promise<{ count: number; bytes: number }> {
  const d = await getTdb();
  await idbClear(d, 'tcache');
  return cacheStats();
}

/** options 页的连接测试 */
export async function aiTest(settings: Settings): Promise<{ ok: boolean; message: string }> {
  try {
    const cfg: AiConfig = { baseUrl: settings.aiBaseUrl, key: settings.aiKey, model: settings.aiModel };
    const r = await chatWithRetry(
      cfg,
      '你是翻译测试接口，只输出收到的文本原文。',
      'ping（收到请只回复 pong）',
      0,
      32,
    );
    return { ok: true, message: `连接成功，模型回复: ${r.content.trim().slice(0, 50)}` };
  } catch (e) {
    return { ok: false, message: `连接失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// makeToken 保留引用，避免 tree-shake 提示（token 格式变更时使用）
void makeToken;
