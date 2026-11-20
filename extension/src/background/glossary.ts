/**
 * glossary.ts — 词表的持久化与自动更新
 *
 * 持久化: IndexedDB db='tw' store='glossary' key='current'。
 * 首次运行: 导入扩展内置快照 data/de_names.json。
 * 更新: 只拉 index_en/index_zh（各 ~500B 压缩），对比每文件 hash，
 *       变了才下载对应文件并重建；无变化零额外流量。
 */
import { idbOpen, idbGet, idbPut } from '../shared/idb';
import { TermMatcher } from '../shared/matcher';
import type { GlossaryMeta, TermEntry } from '../shared/types';
import { todayStr } from '../shared/util';
import { EXPORT_BASES, fetchIndex, fetchExport, rebuildTerms } from './exporter';

const DB_NAME = 'tw';
const DB_VERSION = 1;

export interface GlossaryRecord {
  terms: Record<string, string>;
  /** 官方保留英文原名（zh === en），正文照抄英文即正确译法 */
  retained?: string[];
  version: string;
  builtAt: string;
  /** 每个源导出文件的 hash（用于增量对比） */
  source: Record<string, string>;
  lastCheck: string | null;
}

let db: IDBDatabase | null = null;
let record: GlossaryRecord | null = null;
let matcher: TermMatcher | null = null;
let retainedMatcher: TermMatcher | null = null;
let entryList: TermEntry[] = [];
/** 扩展内置的 wiki 机制术语表（官方导出没有的用语），随扩展版本更新 */
let mechTerms: Record<string, string> = {};
let mechLoaded = false;
/** 游戏语言文件挖掘层（tools/build_lang_terms.js 产出，官方导出缺的 UI 复合词） */
let langTerms: Record<string, string> = {};
let langLoaded = false;
let updating: Promise<UpdateResult> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  return idbOpen(DB_NAME, DB_VERSION, d => {
    d.createObjectStore('glossary');
    d.createObjectStore('exportFiles');
    d.createObjectStore('tcache');
  }).then(d => {
    db = d;
    return d;
  });
}

interface Snapshot {
  terms: Record<string, string>;
  retained?: string[];
  version?: string;
  builtAt?: string;
  source?: Record<string, string>;
}

async function loadSnapshot(): Promise<Snapshot> {
  const url = chrome.runtime.getURL('data/de_names.json');
  return JSON.parse(await (await fetch(url)).text()) as Snapshot;
}

/** 内置机制术语表（data/mechanism_terms.json），读取失败不阻塞词表 */
async function loadMechanisms(): Promise<Record<string, string>> {
  try {
    const url = chrome.runtime.getURL('data/mechanism_terms.json');
    return JSON.parse(await (await fetch(url)).text()) as Record<string, string>;
  } catch {
    return {};
  }
}

/** 游戏语言文件挖掘层（data/lang_terms.json，build_lang_terms.js 产出），读取失败不阻塞词表 */
async function loadLangTerms(): Promise<Record<string, string>> {
  try {
    const url = chrome.runtime.getURL('data/lang_terms.json');
    const parsed = JSON.parse(await (await fetch(url)).text()) as { terms?: Record<string, string> };
    return parsed.terms ?? {};
  } catch {
    return {};
  }
}

/**
 * 合并补充术语层（优先级从低到高：机制表 < 语言文件层 < 官方词表）：
 *  - 官方已有译名的条目以官方为准（后展开覆盖）；
 *  - 官方保留英文名（retained，如 Excalibur）即使各补充层里有也删掉，照抄英文才是正确译法。
 */
function mergeGlossaryLayers(official: Record<string, string>, retained: string[]): Record<string, string> {
  const out = { ...mechTerms, ...langTerms };
  const retainedSet = new Set(retained.map(s => s.toLowerCase()));
  for (const en of Object.keys(out)) {
    if (retainedSet.has(en.toLowerCase())) delete out[en];
  }
  return { ...out, ...official };
}

function installRecord(rec: GlossaryRecord): void {
  record = rec;
  const merged = mergeGlossaryLayers(rec.terms, rec.retained ?? []);
  entryList = Object.entries(merged).map(([en, zh]) => ({ en, zh }));
  matcher = new TermMatcher(entryList);
  retainedMatcher = new TermMatcher((rec.retained ?? []).map(en => ({ en, zh: en })));
}

export async function ensureGlossary(): Promise<void> {
  if (!mechLoaded) {
    mechTerms = await loadMechanisms();
    mechLoaded = true;
  }
  if (!langLoaded) {
    langTerms = await loadLangTerms();
    langLoaded = true;
  }
  if (record) return;
  const d = await getDb();
  let rec = await idbGet<GlossaryRecord>(d, 'glossary', 'current');
  if (!rec || !rec.terms || Object.keys(rec.terms).length === 0) {
    // 首次: 导入内置快照
    const snap = await loadSnapshot();
    rec = {
      terms: snap.terms,
      retained: snap.retained ?? [],
      version: snap.version || todayStr(),
      builtAt: snap.builtAt || new Date().toISOString(),
      source: snap.source || {},
      lastCheck: null,
    };
    await idbPut(d, 'glossary', rec, 'current');
  } else if (rec.retained === undefined) {
    // 旧版记录无 retained：从内置快照补上（保留英文名与词表版本无关，可直接采用）
    try {
      rec.retained = (await loadSnapshot()).retained ?? [];
    } catch {
      rec.retained = [];
    }
    await idbPut(d, 'glossary', rec, 'current');
  }
  installRecord(rec);
}

export function getMatcher(): TermMatcher {
  if (!matcher) throw new Error('glossary not ready');
  return matcher;
}

/** 官方保留英文原名（zh === en）的匹配器，用于判断"英文残留是否本就该保留" */
export function getRetainedMatcher(): TermMatcher {
  if (!retainedMatcher) throw new Error('glossary not ready');
  return retainedMatcher;
}

export function glossaryMeta(): GlossaryMeta {
  if (!record) return { version: '', count: 0, retainedCount: 0, builtAt: '', lastCheck: null };
  return {
    version: record.version,
    count: entryList.length,
    retainedCount: record.retained?.length ?? 0,
    builtAt: record.builtAt,
    lastCheck: record.lastCheck,
  };
}

export interface UpdateResult {
  updated: boolean;
  count: number;
  error?: string;
  changedFiles?: string[];
}

/** 下载某个 entry（带 IDB 缓存），返回解析后的 JSON */
async function loadFile(entry: string, changed: Set<string>): Promise<unknown> {
  const d = await getDb();
  if (!changed.has(entry)) {
    const cached = await idbGet<unknown>(d, 'exportFiles', entry);
    if (cached !== undefined) return cached;
  }
  const json = await fetchExport(entry);
  await idbPut(d, 'exportFiles', json, entry);
  return json;
}

export async function updateGlossary(force = false): Promise<UpdateResult> {
  if (updating) return updating;
  updating = (async () => {
    try {
      await ensureGlossary();
      const [idxEn, idxZh] = await Promise.all([fetchIndex('en'), fetchIndex('zh')]);

      const cur = record!;
      const newSource: Record<string, string> = { ...cur.source };
      const changed = new Set<string>();
      for (const base of EXPORT_BASES) {
        for (const [key, entry] of [
          [`${base}_en`, idxEn[`${base}_en`]],
          [`${base}_zh`, idxZh[`${base}_zh`]],
        ] as const) {
          if (!entry) continue;
          const hash = entry.split('!00_')[1];
          if (force || newSource[key] !== hash) {
            newSource[key] = hash;
            changed.add(entry);
          }
        }
      }

      let result: UpdateResult;
      if (changed.size === 0 && !force) {
        result = { updated: false, count: entryList.length };
      } else {
        const files = new Map<string, unknown>();
        for (const base of EXPORT_BASES) {
          for (const key of [`${base}_en`, `${base}_zh`]) {
            const entry = (key.endsWith('_en') ? idxEn[key] : idxZh[key]) || undefined;
            if (!entry) continue;
            files.set(key, await loadFile(entry, changed));
          }
        }
        const { terms, retained, itemCount, abilityCount } = rebuildTerms(files);
        const next: GlossaryRecord = {
          terms,
          retained,
          version: todayStr(),
          builtAt: new Date().toISOString(),
          source: newSource,
          lastCheck: new Date().toISOString(),
        };
        installRecord(next);
        const d = await getDb();
        await idbPut(d, 'glossary', next, 'current');
        result = { updated: true, count: entryList.length, changedFiles: [...changed] };
        console.log(`glossary updated: items=${itemCount} abilities=${abilityCount} total=${entryList.length}`);
      }
      // 无论是否更新，记录检查时间
      if (record && !record.lastCheck) {
        record.lastCheck = new Date().toISOString();
        const d = await getDb();
        await idbPut(d, 'glossary', record, 'current');
      }
      return result;
    } catch (e) {
      console.error('glossary update failed:', e);
      return { updated: false, count: entryList.length, error: String(e) };
    } finally {
      updating = null;
    }
  })();
  return updating;
}
