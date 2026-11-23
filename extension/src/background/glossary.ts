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
import { ZhMatcher } from '../shared/zhmatch';
import { effectiveUserTerms, mergeGlossaryLayers, userRetained } from '../shared/layers';
import { GITEE_REPO, LANG_TERMS_REPO } from '../shared/const';
import type { GlossaryMeta, TermEntry } from '../shared/types';
import { todayStr, sha256hex, b64ToUtf8 } from '../shared/util';
import { EXPORT_BASES, fetchIndex, fetchExport, rebuildTerms } from './exporter';
import { api } from '../shared/api';

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
/** 反向匹配器（zh→en）：搜索框中文术语支持，随词表重建同步刷新 */
let zhMatcher: ZhMatcher | null = null;
let entryList: TermEntry[] = [];
/**
 * 三个远程补充/人工层的运行时状态。加载与更新统一走 LAYERS 表：
 * 每层 = IDB 远程记录优先（'glossary' store，key=层 id），无记录用扩展内置快照；
 * layerSha 是当前生效内容的 sha256，作为后续增量比对基准。
 * userTerms 不走 LAYERS（无远程源）：options 页写入 IDB key='userTerms'，纯本机层。
 */
const layerTerms: Record<'mechTerms' | 'langTerms' | 'manualOverrides' | 'userTerms', Record<string, string>> = {
  mechTerms: {},
  langTerms: {},
  manualOverrides: {},
  userTerms: {},
};
const layerSha: Record<string, string> = { mechTerms: '', langTerms: '', manualOverrides: '' };
let remoteLastCheck: string | null = null;
let layersLoaded = false;
let updating: Promise<UpdateResult> | null = null;

/** 简写别名（合并/校验用） */
const mechTerms = () => layerTerms.mechTerms;
const langTerms = () => layerTerms.langTerms;
const manualOverrides = () => layerTerms.manualOverrides;
const userTerms = () => layerTerms.userTerms;

/** 远程词条记录（IDB store 'glossary'，key=层 id），存在则优先于内置快照 */
interface LayerRecord {
  terms: Record<string, string>;
  sha: string;
  version?: string;
  fetchedAt: string;
}

/** 用户自定义词表记录（IDB store 'glossary'，key='userTerms'；纯本机数据，不参与远程同步） */
interface UserTermsRecord {
  terms: Record<string, string>;
  updatedAt: string;
}

export interface RemoteLayersResult {
  updated: boolean; // 任一层有变化
  changed: string[]; // 变化的层 id
  counts: { mechTerms: number; langTerms: number; manualOverrides: number };
  error?: string; // 各文件失败的错误（分号连接；单文件失败不影响其他层）
  /** 仓库常量未配置时跳过远程检查 */
  skipped?: boolean;
}

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
  const url = api.runtime.getURL('data/de_names.json');
  return JSON.parse(await (await fetch(url)).text()) as Snapshot;
}

/**
 * 三个可远程更新的补充/人工层：
 *  - mechTerms: 机制术语表（人工维护的 wiki 用语）
 *  - langTerms: 游戏语言文件挖掘层（Actions 每日重建）
 *  - manualOverrides: 人工覆盖层（最高优先级修正）
 * 人工层文件直接提交在托管仓库（data/ 下，无需 Actions 加工），与语言层共用
 * 同一套 5 镜像拉取 + sha 增量机制：push 后 24h 内自动流转到所有用户，免发版。
 */
interface LayerSpec {
  id: keyof typeof layerTerms;
  file: string;
  min?: number; // 词条数合理性下限（防拉到截断/损坏文件）
  max?: number;
}

const LAYERS: LayerSpec[] = [
  { id: 'mechTerms', file: 'data/mechanism_terms.json', max: 5000 },
  { id: 'langTerms', file: 'data/lang_terms.json', min: 1000, max: 100000 },
  { id: 'manualOverrides', file: 'data/manual_overrides.json', max: 5000 },
];

/** 拉取镜像序：GitHub raw → jsDelivr 三入口 → statically → Gitee API（兜底，Secrets 配置后由 Actions 自动镜像）。
 *  Gitee 用 API v5 contents 端点而非 raw——raw 对未通过开源审核的仓库返回 451，API 匿名 GET
 *  稳定可用（响应为 {content: base64}，解码后才是文件原文）。Gitee 仓库置空串则跳过。 */
interface MirrorSource {
  url: string;
  giteeApi?: boolean;
}

const MIRROR_SOURCES = (repo: string, file: string): MirrorSource[] => {
  const list: MirrorSource[] = [
    { url: `https://raw.githubusercontent.com/${repo}/main/${file}` },
    { url: `https://cdn.jsdelivr.net/gh/${repo}@main/${file}` },
    { url: `https://fastly.jsdelivr.net/gh/${repo}@main/${file}` },
    { url: `https://gcore.jsdelivr.net/gh/${repo}@main/${file}` },
    { url: `https://cdn.statically.io/gh/${repo}/main/${file}` },
  ];
  if (GITEE_REPO) {
    list.push({ url: `https://gitee.com/api/v5/repos/${GITEE_REPO}/contents/${file}?ref=main`, giteeApi: true });
  }
  return list;
};

/** 读扩展内置的层文件：lang_terms.json 是 {terms:{...}}，mech/overrides 是平面对象 */
async function loadBundledLayer(file: string): Promise<{ terms: Record<string, string>; sha: string }> {
  try {
    const text = await (await fetch(api.runtime.getURL(file))).text();
    const parsed = JSON.parse(text) as Record<string, string> | { terms?: Record<string, string> };
    const terms =
      (parsed as { terms?: Record<string, string> }).terms ?? (parsed as Record<string, string>) ?? {};
    return {
      terms: terms && typeof terms === 'object' ? terms : {},
      sha: await sha256hex(text),
    };
  } catch {
    return { terms: {}, sha: '' };
  }
}

function isTermsObject(v: unknown): v is Record<string, string> {
  return (
    !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string')
  );
}

/** 单层加载：IDB 远程记录优先（运行时拉取过），无记录用内置快照；sha 作为增量基准 */
async function loadLayerState(spec: LayerSpec): Promise<void> {
  let rec: LayerRecord | null = null;
  try {
    const d = await getDb();
    rec = (await idbGet<LayerRecord>(d, 'glossary', spec.id)) ?? null;
  } catch {
    /* IDB 不可用则直接用内置快照 */
  }
  if (rec && isTermsObject(rec.terms) && Object.keys(rec.terms).length) {
    // 远程层有效：直接用 IDB 记录。内置快照的 fetch+parse+sha256 必须跳过——
    // lang_terms.json 数百 KB，SW 每次冷启动都白加载一遍是可感知的固定延迟。
    layerTerms[spec.id] = rec.terms;
    layerSha[spec.id] = rec.sha;
    return;
  }
  const bundled = await loadBundledLayer(spec.file);
  layerTerms[spec.id] = bundled.terms;
  layerSha[spec.id] = bundled.sha;
}

/**
 * 远程拉取全部补充/人工层（GitHub 托管仓库；语言层由 Actions 每日重建，人工层直接提交源文件）。
 * 按文件内容 sha 增量：不变跳过，与内置快照一致则重置回内置（清掉过期远程记录），
 * 有变化写 IDB 并热重建匹配器。单文件失败不阻塞其他层；全部失败静默降级当前生效层。
 */
export async function updateRemoteLayers(force = false): Promise<RemoteLayersResult> {
  await ensureGlossary(); // 保证各层状态与官方 record 就绪，供热重建
  const counts = (): RemoteLayersResult['counts'] => ({
    mechTerms: Object.keys(layerTerms.mechTerms).length,
    langTerms: Object.keys(layerTerms.langTerms).length,
    manualOverrides: Object.keys(layerTerms.manualOverrides).length,
  });
  if (!LANG_TERMS_REPO || /YOUR_GH_USER/i.test(LANG_TERMS_REPO)) {
    return { updated: false, changed: [], counts: counts(), skipped: true };
  }
  const changed: string[] = [];
  const errors: string[] = [];
  const now = new Date().toISOString();
  const d = await getDb();
  for (const spec of LAYERS) {
    let text: string | null = null;
    let lastErr: unknown = null;
    for (const src of MIRROR_SOURCES(LANG_TERMS_REPO, spec.file)) {
      try {
        const res = await fetch(src.url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let body = await res.text();
        if (src.giteeApi) {
          // Gitee contents API：{content: base64} → 解码为文件原文（sha 基准与直链拉取一致）
          const api = JSON.parse(body) as { content?: string };
          if (typeof api.content !== 'string') throw new Error('API 响应缺少 content');
          body = b64ToUtf8(api.content);
        }
        JSON.parse(body); // 预校验：坏内容不进入 sha 基准
        text = body;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (text === null) {
      errors.push(`${spec.id}: ${String(lastErr)}`);
      continue;
    }
    const sha = await sha256hex(text);
    if (!force && sha === layerSha[spec.id]) continue; // 增量：与当前生效一致
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      errors.push(`${spec.id}: JSON 解析失败`);
      continue;
    }
    const terms =
      spec.id === 'langTerms'
        ? ((parsed as { terms?: Record<string, string> }).terms ?? {})
        : (parsed as Record<string, string>);
    if (!isTermsObject(terms)) {
      errors.push(`${spec.id}: 数据格式异常`);
      continue;
    }
    const n = Object.keys(terms).length;
    if ((spec.min && n < spec.min) || (spec.max && n > spec.max)) {
      errors.push(`${spec.id}: 词条数异常（${n}），放弃更新`);
      continue;
    }
    const rec: LayerRecord = { terms, sha, fetchedAt: now };
    await idbPut(d, 'glossary', rec, spec.id);
    layerTerms[spec.id] = terms;
    layerSha[spec.id] = sha;
    changed.push(spec.id);
  }
  if (changed.length) {
    remoteLastCheck = now;
    if (record) installRecord(record); // 任一层变化 → 热重建匹配器（官方层不变）
  } else if (!errors.length) {
    remoteLastCheck = now;
  }
  return { updated: changed.length > 0, changed, counts: counts(), error: errors.length ? errors.join('; ') : undefined };
}

/**
 * 用户自定义词表（本机层，最高优先级）：
 *  - 存储：IDB 'glossary' store key='userTerms'，纯本机数据，不上传不同步；
 *  - options 页编辑（一行一条「英文, 中文」），保存即热重建匹配器；
 *  - 空译名不生效（自定义层不支持删除词条，编辑端按无效行忽略）。
 */

/** 读取本机自定义词表（随 ensureGlossary 装载，返回运行时生效状态） */
export async function getUserTerms(): Promise<{
  terms: Record<string, string>;
  updatedAt: string | null;
  count: number;
}> {
  await ensureGlossary();
  const d = await getDb();
  const rec = await idbGet<UserTermsRecord>(d, 'glossary', 'userTerms');
  return {
    terms: userTerms(),
    updatedAt: rec?.updatedAt ?? null,
    count: Object.keys(userTerms()).length,
  };
}

/** 保存本机自定义词表：落 IDB + 热重建匹配器（调用方负责触发缓存失效清理） */
export async function setUserTerms(terms: Record<string, string>): Promise<{ count: number }> {
  if (!isTermsObject(terms)) throw new Error('自定义词表格式异常');
  const clean = effectiveUserTerms(terms); // 防御：空译名不入库（自定义层无删除语义）
  const d = await getDb();
  const rec: UserTermsRecord = { terms: clean, updatedAt: new Date().toISOString() };
  await idbPut(d, 'glossary', rec, 'userTerms');
  layerTerms.userTerms = clean;
  await ensureGlossary(); // record 未就绪时先完成装载（其 installRecord 已含新 user 层）
  if (record) installRecord(record); // record 已就绪则热重建
  return { count: Object.keys(clean).length };
}

function installRecord(rec: GlossaryRecord): void {
  record = rec;
  const merged = mergeGlossaryLayers(
    {
      mech: mechTerms(),
      lang: langTerms(),
      official: rec.terms,
      overrides: manualOverrides(),
      user: userTerms(),
    },
    rec.retained ?? [],
  );
  const userMap = effectiveUserTerms(userTerms());
  const userLower = new Set(Object.keys(userMap).map(k => k.toLowerCase()));
  entryList = Object.entries(merged).map(([en, zh]) => ({ en, zh, prio: userLower.has(en.toLowerCase()) }));
  matcher = new TermMatcher(entryList);
  // retained 匹配器 = 官方保留英文名 + 用户强制保留英文（zh===en），后者需热随自定义层重建
  const retainedAll = [...(rec.retained ?? []), ...userRetained(userMap)];
  retainedMatcher = new TermMatcher(retainedAll.map(en => ({ en, zh: en })));
  zhMatcher = new ZhMatcher(entryList);
}

export async function ensureGlossary(): Promise<void> {
  if (!layersLoaded) {
    for (const spec of LAYERS) await loadLayerState(spec);
    // 本机自定义层：IDB 记录（options 页写入），无内置快照
    try {
      const d = await getDb();
      const rec = await idbGet<UserTermsRecord>(d, 'glossary', 'userTerms');
      if (rec && isTermsObject(rec.terms)) layerTerms.userTerms = rec.terms;
    } catch {
      /* IDB 不可用则自定义层为空 */
    }
    layersLoaded = true;
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

/** 搜索框中文前缀候选（词表反向查询） */
export function zhSuggest(q: string, limit?: number): ReturnType<ZhMatcher['suggest']> {
  if (!zhMatcher) throw new Error('glossary not ready');
  return zhMatcher.suggest(q, limit);
}

/** 搜索提交前的中文查询改写（zh 片段 → en 术语） */
export function zhResolve(q: string): ReturnType<ZhMatcher['resolve']> {
  if (!zhMatcher) throw new Error('glossary not ready');
  return zhMatcher.resolve(q);
}

export function glossaryMeta(): GlossaryMeta {
  if (!record) {
    return {
      version: '',
      count: 0,
      retainedCount: 0,
      builtAt: '',
      lastCheck: null,
      langCount: 0,
      langLastCheck: null,
      userCount: 0,
    };
  }
  return {
    version: record.version,
    count: entryList.length,
    retainedCount: record.retained?.length ?? 0,
    builtAt: record.builtAt,
    lastCheck: record.lastCheck,
    langCount: Object.keys(layerTerms.langTerms).length,
    langLastCheck: remoteLastCheck,
    userCount: Object.keys(layerTerms.userTerms).length,
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
      // 后台自动路径降为 warn：DE 拉取失败是常见网络状况，console.error 会点亮扩展
      // 管理页的「错误」按钮（后台失败不打扰约定）；手动检查的失败已在设置页提示
      console.warn('glossary update failed:', e);
      return { updated: false, count: entryList.length, error: String(e) };
    } finally {
      updating = null;
    }
  })();
  return updating;
}
