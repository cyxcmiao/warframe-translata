/**
 * searchbox.ts — 搜索框中文术语支持（纯词表反向查询，不依赖 AI Key）
 *
 * 站点（MediaWiki Vector 2022 + Codex TypeaheadSearch）输入中文时只会命中
 * 人工建的少量中文重定向页，覆盖面远小于词表（20k+ 中文译名）。三层补齐：
 *
 *  L1 借壳注入：输入含中文时把词表前缀候选注入站点自带的建议下拉
 *     （.cdx-menu__listbox 顶部，复用原生 cdx 样式，左侧色条区分来源）；
 *     站点自己的重定向候选保持原样。Vue 重渲染会打乱未托管节点的次序，
 *     MutationObserver 保证候选始终在列且居顶。
 *  L2 点选直达：候选项是真实的 Go 搜索链接（/?title=Special:Search&search=英文名）。
 *     普通点击在点击时刻按当前输入重算改写（保留查询里其余部分）后直接提交跳转，
 *     MediaWiki Go 精确命中页面即直接进页（如 电击 → /w/Electricity）；Ctrl/中键走
 *     静态 href 新标签打开。用户不需要再点第二次链接。
 *  L3 提交改写：表单提交时把查询中的完整中文术语改写为英文（键盘 Enter /
 *     按钮 / requestSubmit 都会经过 submit 事件）；纯前缀歧义不改写放行，
 *     交站点自身搜索兜底。改写成功 toast 一次说明映射（后台失败不打扰）。
 */
import { api } from '../shared/api';
import { showToast } from './toast';
import type { ZhResolveHit, ZhSuggestItem } from '../shared/types';

const SEARCH_INPUT_SEL = '#searchInput, input[name="search"]';
const MENU_HOST_SEL = '#p-search'; // Vector 2022 头部搜索容器（Codex TypeaheadSearch 挂载点）
const LISTBOX_SEL = '.cdx-menu__listbox';
const ITEM_CLASS = 'tw-zh-item';
const SUGGEST_LIMIT = 8; // 给站点自己的重定向候选留位置
const SUGGEST_DEBOUNCE = 150;
/** 本地缓存改写的最长 zh 片段尝试长度（比绝大多数词条长；更长的走后台路径） */
const LOCAL_MAX_LEN = 48;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const hasCJK = (s: string): boolean => CJK_RE.test(s);

let enabled = false;
let composing = false;
let submitBusy = false;
let suggestTimer: number | undefined;
let suggestSeq = 0;
let items: ZhSuggestItem[] = [];
/** zh → en 候选（suggest/resolve 响应累积）：提交时同步改写的数据源，键覆盖后才免后台往返 */
const zhEnCache = new Map<string, string[]>();
let menuObs: MutationObserver | null = null;
let menuObsHost: Element | null = null;
let ensurePending = false;
const SUGGEST_RETRIES = 3;
let suggestRetries = 0;

function mergeEns(prev: string[] | undefined, en: string): string[] {
  const set = new Set(prev ?? []);
  set.add(en);
  // 与后台 ZhMatcher 一致的码点序（localeCompare 中文/ASCII 排序随环境 ICU 浮动）
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function initZhSearch(on: boolean): void {
  enabled = on;
  document.addEventListener('input', onDocInput);
  document.addEventListener('compositionstart', () => {
    composing = true;
  });
  document.addEventListener('compositionend', e => {
    composing = false;
    onDocInput(e);
  });
  document.addEventListener('submit', onSubmit, true);
  // bootstrap（ensureGlossary）等待期间用户可能已经输入了中文——监听挂上后补扫一次，
  // 否则这次输入永远错过（没有新 input 事件就没人触发 suggest）
  const cur = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SEL)?.value ?? '';
  if (hasCJK(cur)) window.setTimeout(doSuggest, 300);
}

/** 设置开关变化（即时生效）：关闭时清掉已注入的候选 */
export function setZhSearchEnabled(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  if (!on) {
    items = [];
    clearInjected();
  }
}

function isSearchInput(t: EventTarget | null): t is HTMLInputElement {
  return t instanceof HTMLInputElement && t.matches(SEARCH_INPUT_SEL);
}

function onDocInput(e: Event): void {
  if (!enabled || !isSearchInput(e.target)) return;
  if (composing || (e instanceof InputEvent && e.isComposing)) return;
  if (suggestTimer) clearTimeout(suggestTimer);
  suggestTimer = window.setTimeout(doSuggest, SUGGEST_DEBOUNCE);
}

async function doSuggest(): Promise<void> {
  const q = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SEL)?.value ?? '';
  if (!hasCJK(q)) {
    items = [];
    clearInjected();
    suggestRetries = 0;
    return;
  }
  const seq = ++suggestSeq;
  let resp: { items?: ZhSuggestItem[] } | undefined;
  try {
    resp = (await api.runtime.sendMessage({ type: 'zhSuggest', q, limit: SUGGEST_LIMIT })) as
      | { items?: ZhSuggestItem[] }
      | undefined;
  } catch {
    // SW 冷启动/重载瞬间消息失败：有界重试（SW 休眠后第一个中文按键就靠它兜底）；
    // 重试期间用户继续打字会经 onDocInput 重置定时器走正常路径，连续失败 3 次静默放弃
    if (suggestRetries < SUGGEST_RETRIES) {
      suggestRetries++;
      if (suggestTimer) clearTimeout(suggestTimer);
      suggestTimer = window.setTimeout(doSuggest, 400);
    }
    return;
  }
  suggestRetries = 0;
  if (seq !== suggestSeq || !enabled) return;
  const cur = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SEL)?.value ?? '';
  if (!resp?.items?.length || !hasCJK(cur)) {
    items = [];
    clearInjected();
    return;
  }
  items = resp.items;
  for (const it of items) zhEnCache.set(it.zh, mergeEns(zhEnCache.get(it.zh), it.en));
  ensureInjected();
  watchMenu();
}

/** 候选所在的 Codex listbox：优先从当前搜索输入框就近找，退化到头部容器。
 *  注意输入框用通用选择器——站点 Vue 接管后 input 会丢掉 id="searchInput"，只剩 name="search" */
function listbox(): HTMLUListElement | null {
  const input = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SEL);
  const host = (input?.closest('.cdx-typeahead-search') as Element | null) ?? document.querySelector(MENU_HOST_SEL);
  return host?.querySelector<HTMLUListElement>(LISTBOX_SEL) ?? null;
}

function ensureInjected(): void {
  if (!enabled || !items.length) return;
  const ul = listbox();
  if (!ul) return;
  const ours = ul.querySelectorAll(`li.${ITEM_CLASS}`);
  if (ours.length === items.length && ours.length > 0 && ul.firstElementChild === ours[0]) return;
  ours.forEach(n => n.remove());
  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(buildItem(it));
  ul.prepend(frag);
}

function scheduleEnsure(): void {
  if (ensurePending) return;
  ensurePending = true;
  requestAnimationFrame(() => {
    ensurePending = false;
    ensureInjected();
  });
}

/** Vue 每次重渲染建议列表都可能让我们的条目移位/缺失；observer 统一在帧尾补齐。
 *  宿主(#p-search)被站点整树替换时（重定向/水合）重挂 observer。 */
function watchMenu(): void {
  const host = document.querySelector(MENU_HOST_SEL);
  if (!host) return;
  if (menuObs && menuObsHost === host) return;
  menuObs?.disconnect();
  menuObs = new MutationObserver(() => {
    if (!enabled || !items.length) return;
    scheduleEnsure();
  });
  menuObsHost = host;
  menuObs.observe(host, { childList: true, subtree: true });
}

function clearInjected(): void {
  document.querySelectorAll(`li.${ITEM_CLASS}`).forEach(n => n.remove());
}

function buildItem(it: ZhSuggestItem): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `cdx-menu-item cdx-menu-item--enabled cdx-menu-item--bold-label cdx-menu-item--has-description ${ITEM_CLASS}`;
  li.setAttribute('role', 'option');
  li.title = it.zh;
  const a = document.createElement('a');
  a.className = 'cdx-menu-item__content';
  // 静态 href = 该术语的 Go 搜索：中键/Ctrl 新标签直达；普通点击由 bridge 按当前输入重算
  a.href = searchGoUrl(it.en);
  const text = document.createElement('span');
  text.className = 'cdx-menu-item__text';
  const label = document.createElement('span');
  label.className = 'cdx-menu-item__text__label';
  const zh = document.createElement('bdi');
  zh.textContent = it.zh;
  label.appendChild(zh);
  const desc = document.createElement('span');
  desc.className = 'cdx-menu-item__text__description';
  const en = document.createElement('bdi');
  en.textContent = `词表 · ${it.en}`;
  desc.appendChild(en);
  text.append(label, desc);
  a.appendChild(text);
  a.addEventListener('click', ev => {
    // 修饰键点击交给浏览器默认行为（静态 href 新标签打开）
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
    ev.preventDefault();
    bridge(it);
  });
  li.appendChild(a);
  return li;
}

/** MediaWiki Go 搜索 URL：精确命中页面标题时直接进页，否则出搜索结果列表 */
function searchGoUrl(q: string): string {
  return `/?title=Special%3ASearch&search=${encodeURIComponent(q)}`;
}

/**
 * L2 直达：把候选对应的中文改写成英文（整词命中替换该片段；只打了前缀如“电”点
 * “电击”时替换尾部中文段；都不是就整体替换——点了某个候选即明确想要它），
 * 保留查询其余部分，走站点原生表单提交直接跳转（不再让用户点第二次链接）。
 */
function bridge(it: ZhSuggestItem): void {
  const input = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SEL);
  if (!input) return;
  const q = input.value;
  const idx = q.indexOf(it.zh);
  let next: string;
  if (idx >= 0) {
    next = q.slice(0, idx) + it.en + q.slice(idx + it.zh.length);
  } else {
    const run = /[\u3400-\u4dbf\u4e00-\u9fff]+$/.exec(q)?.[0] ?? '';
    next = run && it.zh.startsWith(run) ? q.slice(0, q.length - run.length) + it.en : it.en;
  }
  zhEnCache.set(it.zh, mergeEns(zhEnCache.get(it.zh), it.en));
  input.value = next;
  // 原生表单提交（Go）。改写后查询若仍含其他中文片段，submit 处理器会继续兜底改写
  const form = input.closest('form');
  if (form) form.requestSubmit();
  else location.assign(searchGoUrl(next));
}

function onSubmit(e: Event): void {
  if (!enabled) return;
  if (submitBusy) {
    e.preventDefault(); // 改写提交已在途：吞掉重复提交，防原值抢先导航
    return;
  }
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  const input = form.querySelector<HTMLInputElement>('input[name="search"]');
  if (!input) return;
  const q = input.value;
  if (!hasCJK(q)) return;
  const local = resolveLocal(q);
  if (local.complete) {
    // 缓存足够：同步改写。不 preventDefault，浏览器用提交时刻的值序列化
    if (local.hits.length) {
      input.value = local.query;
      toastRewrite(local.hits);
    }
    return;
  }
  // 有未缓存的中文片段（粘贴直搜等）：拦下问后台全量反向词表，再代为提交
  e.preventDefault();
  e.stopPropagation();
  submitBusy = true;
  void (async () => {
    try {
      const resp = (await api.runtime.sendMessage({ type: 'zhResolve', q })) as
        | { query?: string; hits?: ZhResolveHit[] }
        | undefined;
      if (resp?.hits?.length) {
        input.value = resp.query ?? q;
        for (const h of resp.hits) zhEnCache.set(h.zh, mergeEns(zhEnCache.get(h.zh), h.en));
        toastRewrite(resp.hits);
      }
    } catch {
      /* SW 不可用：finally 里按原值放行 */
    } finally {
      submitBusy = false;
      form.submit(); // 不触发 submit 事件，无递归
    }
  })();
}

function toastRewrite(hits: ZhResolveHit[]): void {
  showToast(`已按词表改写: ${hits.map(h => `${h.zh} → ${h.en}`).join('、')}`, { duration: 4000 });
}

/** 本地缓存改写：逐位置贪心最长匹配；遇到缓存没有的中文片段立即判 incomplete */
function resolveLocal(q: string): { query: string; hits: ZhResolveHit[]; complete: boolean } {
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
    const maxLen = Math.min(LOCAL_MAX_LEN, q.length - i);
    for (let len = maxLen; len >= 2; len--) {
      const ens = zhEnCache.get(q.slice(i, i + len));
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
      return { query: q, hits: [], complete: false };
    }
  }
  out += q.slice(last);
  return { query: out, hits, complete: true };
}
