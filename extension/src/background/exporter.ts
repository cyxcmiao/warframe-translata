/**
 * exporter.ts — 官方 DE 导出的抓取与词表重建（增量）
 *
 * 与 tools/build_de_map.js 同一套规则：
 *  - en/zh 按 uniqueName 配对
 *  - zh === en（官方未译，如 Excalibur）不进词表，记入 retained（正文照抄英文即正确）
 *  - /Lotus/Language/* UI 字符串不收
 *  - 战甲 abilities[].abilityName 一并收录
 */
import * as LZMA from 'lzma-wasm';
import type { TermEntry } from '../shared/types';
import STOPLIST from '../../../data/stoplist.json';

export const BASE_CONTENT = 'https://content.warframe.com/PublicExport/';
export const BASE_ORIGIN = 'https://origin.warframe.com/PublicExport/';

export const EXPORT_BASES = [
  'ExportResources', 'ExportWeapons', 'ExportWarframes', 'ExportSentinels',
  'ExportGear', 'ExportKeys', 'ExportFlavour', 'ExportRelicArcane',
  'ExportFusionBundles', 'ExportUpgrades',
];

export interface IndexEntries {
  [key: string]: string; // "ExportWeapons_en" -> "ExportWeapons_en.json!00_hash"
}

function fetchBuf(url: string, timeoutMs = 60000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'translataWiki/0.1' } })
      .then(async res => {
        clearTimeout(timer);
        if (!res.ok) return reject(new Error(`HTTP ${res.status} for ${url}`));
        resolve(new Uint8Array(await res.arrayBuffer()));
      })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

async function fetchBufAny(urls: string[]): Promise<Uint8Array> {
  let lastErr: unknown;
  for (const u of urls) {
    try { return await fetchBuf(u); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

let lzmaReady = false;
async function ensureLzma() {
  if (!lzmaReady) {
    await LZMA.initWasm();
    lzmaReady = true;
  }
}

export async function fetchIndex(lang: 'en' | 'zh'): Promise<IndexEntries> {
  await ensureLzma();
  const buf = await fetchBufAny([
    BASE_ORIGIN + `index_${lang}.txt.lzma`,
    BASE_CONTENT + `index_${lang}.txt.lzma`,
  ]);
  const text = new TextDecoder().decode(await LZMA.decompress(buf));
  const map: IndexEntries = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(.+)\.json!00_(.+)$/);
    if (m) map[m[1]] = line;
  }
  return map;
}

export async function fetchExport(entry: string): Promise<unknown> {
  const buf = await fetchBuf(BASE_CONTENT + 'Manifest/' + entry);
  return JSON.parse(new TextDecoder().decode(buf));
}

/** 词表过滤/清洗规则，返回 null 丢弃；same=true 表示官方未译（英文原名即官方译名） */
function validPair(
  enName: string,
  zhName: string,
  uniqueName: string,
): { en: string; zh: string; same: boolean } | null {
  if (!enName || !zhName) return null;
  const strip = (s: string) => s.replace(/^(<[A-Za-z_ ]+>\s?)+/, '').trim();
  enName = strip(enName);
  zhName = strip(zhName);
  if (!enName || !zhName) return null;
  if (enName.length < 2 || zhName.length < 1) return null;
  if (!enName.includes(' ') && (STOPLIST as string[]).includes(enName.toLowerCase())) return null; // 泛词停用表（仅单词词条）
  if (uniqueName.startsWith('/Lotus/Language/')) return null; // UI 字符串
  if (/[|<>]/.test(enName) || /[|<>]/.test(zhName)) return null;
  if (enName === 'DO NOT USE' || enName.startsWith('/')) return null;
  return { en: enName, zh: zhName, same: zhName.toLowerCase() === enName.toLowerCase() };
}

export interface RebuildInput {
  /** entry -> 解析后的 JSON（来自 IDB 缓存或新下载） */
  files: Map<string, unknown>;
}

export function rebuildTerms(files: Map<string, unknown>): {
  terms: Record<string, string>;
  /** 官方保留英文原名（zh === en）：正文照抄英文即正确，可跳过 AI */
  retained: string[];
  itemCount: number;
  abilityCount: number;
} {
  const terms: Record<string, string> = {};
  const retained = new Set<string>();
  let itemCount = 0;
  let abilityCount = 0;
  const conflicts: string[] = [];
  const add = (en: string, zh: string, isAbility: boolean) => {
    if (Object.prototype.hasOwnProperty.call(terms, en)) {
      if (terms[en] !== zh) conflicts.push(`${en}: ${terms[en]} / ${zh}`);
      return;
    }
    terms[en] = zh;
    if (isAbility) abilityCount++; else itemCount++;
  };
  const addPair = (p: { en: string; zh: string; same: boolean }, isAbility: boolean) => {
    if (p.same) retained.add(p.en);
    else add(p.en, p.zh, isAbility);
  };

  for (const base of EXPORT_BASES) {
    const enFile = files.get(`${base}_en`);
    const zhFile = files.get(`${base}_zh`);
    if (!enFile || !zhFile) continue;
    const flatten = (f: unknown) =>
      Object.values(f as Record<string, unknown>).filter(Array.isArray).flat() as Array<Record<string, unknown>>;
    const enItems = flatten(enFile);
    const zhItems = flatten(zhFile);
    const zhByName = new Map<string, Record<string, unknown>>();
    for (const it of zhItems) {
      if (!it) continue;
      const id = (it.uniqueName || it.abilityUniqueName) as string | undefined;
      if (id) zhByName.set(id, it);
    }
    for (const it of enItems) {
      if (!it) continue;
      const id = (it.uniqueName || it.abilityUniqueName) as string | undefined;
      if (!id) continue;
      const enName = (it.name || it.abilityName) as string | undefined;
      const zhIt = zhByName.get(id);
      if (!zhIt || !enName) continue;
      const zhName = (zhIt.name || zhIt.abilityName) as string | undefined;
      if (enName && zhName) {
        const p = validPair(enName, zhName, id);
        if (p) addPair(p, false);
      }
      const enAb = it.abilities as Array<Record<string, unknown>> | undefined;
      const zhAb = zhIt.abilities as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(enAb) && Array.isArray(zhAb)) {
        const zhAbMap = new Map(zhAb.map(a => [a.abilityUniqueName as string, a]));
        for (const ab of enAb) {
          const zhAbIt = zhAbMap.get(ab.abilityUniqueName as string);
          if (!ab || !zhAbIt) continue;
          const p = validPair(ab.abilityName as string, zhAbIt.abilityName as string, (ab.abilityUniqueName as string) || '');
          if (p) addPair(p, true);
        }
      }
    }
  }
  if (conflicts.length) console.warn('glossary conflicts (first wins):', conflicts.slice(0, 10));
  // 有真译名的名字不再算"保留英文"
  for (const en of retained) if (Object.prototype.hasOwnProperty.call(terms, en)) retained.delete(en);
  return { terms, retained: [...retained], itemCount, abilityCount };
}
