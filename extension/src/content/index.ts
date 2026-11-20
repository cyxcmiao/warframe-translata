/**
 * content 入口 — 编排：采集 → 批量翻译 → 渲染，含悬浮开关、顶部进度条、SPA URL 监听。
 *
 * 增量翻译：评论区（Yappin）等懒加载内容是滚动后由前端注入的，
 * 用 MutationObserver 监听新增节点，只采集新增块、走同一管线
 * （后台缓存 + 进行中请求合并保证不重复请求）。
 */
import { collectBlocks, findContentRoot, COMMENTS_ROOT_SEL } from './dom';
import type { RawBlock } from './dom';
import { renderResult, insert, clearTranslations, removeHostRenders, LinkTexts } from './renderer';
import { showToast } from './toast';
import { progressStart, progressAdvance, progressFinish, progressReset } from './progress';
import { api } from '../shared/api';
import { DEFAULT_SETTINGS } from '../shared/const';
import { matchShortcut } from '../shared/hotkey';
import { getSiteEnabled, setSiteEnabled } from '../shared/site';
import type { Settings, GlossaryMeta, BlockOut } from '../shared/types';

const CHUNK = 16;
let settings: Settings = DEFAULT_SETTINGS;
let enabled = true;
let sessionSeq = 0;
let pageActive = false; // 本页已发起过翻译（自动或手动），增量翻译据此决定是否跟随
let fab: { update(status: string): void; retitle(): void } | null = null;

let linkTexts: LinkTexts = new Map();
let doneEls = new WeakSet<Element>(); // 已处理过的块宿主（含无译文块），防增量重复采集
let queue: RawBlock[] = [];
/** 视口外的挂起块：宿主 el → 该宿主的待翻块（保持采集顺序，拆句块一起放行） */
let parked = new Map<Element, RawBlock[]>();
let parkIO: IntersectionObserver | null = null;
let pumping = false;
let incSeq = 0;
let incTimer: number | undefined;
let pendingEls: Element[] = [];
let hiddenByToggle = false; // 快捷键隐藏态：译文 DOM 保留（仅 CSS 隐藏），重新显示瞬时恢复
let failedEls = new Set<Element>(); // AI 失败块宿主，重新显示时补翻重试
/** 链接文本 原文→译文（译文与原文相同的失败块不进表）：同文本链接直接本地登记，免重复请求 */
let linkTextByText = new Map<string, string>();
let inFlightEls = new Set<Element>(); // 正在请求中的块宿主（隐藏时放行 doneEls，恢复时补翻）

/** AI 失败分型 → 用户可操作的提示文案 */
const AI_ERR_MSG: Record<string, string> = {
  auth: 'API Key 无效或未授权（401/403），请检查设置中的 Key',
  rate: 'AI 接口限流（429），稍后重新翻译即可',
  timeout: 'AI 接口响应超时，请检查网络后重试',
  server: 'AI 接口服务错误（5xx），请稍后重试',
  network: '无法连接 AI 接口，请检查 Base URL、域名授权与网络',
  unknown: 'AI 请求失败，本轮翻译暂不可用',
};

function statusText(): string {
  if (!enabled) return '停';
  if (!settings.aiKey) return '未启用';
  return '译·AI';
}

function applyStyle(): void {
  let el = document.getElementById('tw-style') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'tw-style';
    document.documentElement.appendChild(el);
  }
  el.textContent = `:root{--tw-tr-color:${settings.color};--tw-tr-font-size:${settings.fontSize}px;}.tw-hide-tr .tw-tr{display:none!important;}`;
}

/**
 * 视口懒翻译：首屏附近（向下预翻 400px）的块立即入队；
 * 其余挂起，滚动接近视口（+800px 预翻带）时由 IntersectionObserver 放行。
 * 省钱（不翻用户没读到的部分）+ 首屏出译文更快。
 */
function enqueue(blocks: RawBlock[]): void {
  const fresh: RawBlock[] = [];
  for (const b of blocks) {
    if (b.kind === 'link') {
      // 同文本链接此前已拿到译文：直接登记到本块 token id（新内容里的重复链接名免请求）
      const zh = linkTextByText.get(b.text);
      if (zh === undefined) fresh.push(b);
      else linkTexts.set(Number(b.id.slice(1)), zh);
      continue;
    }
    if (b.el && !doneEls.has(b.el)) fresh.push(b);
  }
  for (const b of fresh) {
    if (b.el) doneEls.add(b.el);
  }
  if (!fresh.length) return;
  const links = fresh.filter(b => b.kind === 'link');
  const active: RawBlock[] = [];
  const parkedBlocks: RawBlock[] = [];
  const vh = window.innerHeight;
  for (const b of fresh) {
    if (b.kind === 'link') continue;
    const r = b.el!.getBoundingClientRect();
    // height===0 的块（tabber 未激活页等）不可见，挂起等真正显示时再翻
    (r.top < vh + 400 && r.height > 0 ? active : parkedBlocks).push(b);
  }
  // 链接文本块永远最先（段落渲染依赖其译文）
  queue.push(...links, ...active);
  if (parkedBlocks.length) park(parkedBlocks);
  void drain();
}

function park(blocks: RawBlock[]): void {
  const added: HTMLElement[] = [];
  for (const b of blocks) {
    if (!b.el) continue;
    const arr = parked.get(b.el);
    if (arr) arr.push(b);
    else {
      parked.set(b.el, [b]);
      added.push(b.el);
    }
  }
  if (!added.length) return;
  if (!parkIO) {
    parkIO = new IntersectionObserver(
      entries => {
        const rel: RawBlock[] = [];
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const arr = parked.get(en.target);
          if (arr) rel.push(...arr);
          parked.delete(en.target);
          parkIO?.unobserve(en.target);
        }
        if (rel.length) {
          queue.push(...rel);
          void drain();
        }
      },
      { rootMargin: '800px 0px' },
    );
  }
  for (const el of added) parkIO.observe(el);
}

function releaseParked(): void {
  parkIO?.disconnect();
  parkIO = null;
  parked.clear();
}

async function drain(): Promise<void> {
  if (pumping) return;
  pumping = true;
  let done = 0; // 本波次已处理块数（含链接块），供顶部进度条推进
  progressStart();
  try {
    while (queue.length) {
      const chunk = queue
        .splice(0, CHUNK)
        .filter(b => b.kind === 'link' || (b.el && b.el.isConnected));
      if (!chunk.length) continue;
      for (const rec of chunk) if (rec.kind !== 'link' && rec.el) inFlightEls.add(rec.el);
      const seq = sessionSeq;
      let results: Record<string, BlockOut> = {};
      // resp 提升到 try 外：渲染循环里要读 aiFailed 标记失败块宿主
      let resp: { results?: Record<string, BlockOut>; aiFailed?: boolean; aiError?: string } | undefined;
      try {
        resp = (await api.runtime.sendMessage({
          type: 'translate',
          blocks: chunk.map(b => ({ id: b.id, text: b.text, icons: [...b.icons.keys()] })),
        })) as { results?: Record<string, BlockOut>; aiFailed?: boolean; aiError?: string } | undefined;
        results = resp?.results ?? {};
        if (resp?.aiFailed) {
          showToast(AI_ERR_MSG[resp.aiError ?? 'unknown'] ?? AI_ERR_MSG.unknown, { cooldownMs: 60000 });
        }
      } catch (e) {
        console.warn('[tw] translate failed:', e);
        progressFinish(); // 失败收尾，进度条不滞留半途
        break;
      }
      if (seq !== sessionSeq) {
        progressReset(); // 会话已切换（如 SPA 切页），进度条不滞留半途
        return;
      }

      for (const rec of chunk) {
        const out = results[rec.id];
        if (rec.kind === 'link') {
          if (out?.ok && out.translation && out.translation.trim() !== rec.text.trim()) {
            const zh = out.translation.trim();
            linkTexts.set(Number(rec.id.slice(1)), zh);
            linkTextByText.set(rec.text, zh);
          }
          continue;
        }
        const div = renderResult(rec, out, linkTexts);
        if (div) insert(div, rec);
        // AI 失败的块以原文回退但 ok 仍为 true，本轮有失败时记下宿主，重新显示时补翻重试
        if (resp?.aiFailed && rec.el && (!out?.ok || !out.translation || out.translation.trim() === rec.text.trim())) {
          failedEls.add(rec.el);
        }
      }
      for (const rec of chunk) if (rec.el) inFlightEls.delete(rec.el);
      done += chunk.length;
      progressAdvance(done, done + queue.length);
      fab?.update(statusText());
    }
  } finally {
    pumping = false;
    if (!queue.length) progressFinish();
  }
}

/** 采集正文根节点并入队（新会话 / 隐藏后重新显示 共用） */
function collectAndEnqueue(): void {
  const rootEl = findContentRoot();
  if (!rootEl) return;
  pageActive = true;
  const { blocks } = collectBlocks(rootEl, { skipComments: !settings.translateComments });
  enqueue(blocks);
}

async function startSession(): Promise<void> {
  if (!settings.aiKey) {
    showToast('未配置 API Key，翻译未启用（请在扩展设置中填写）');
    return;
  }
  sessionSeq++;
  queue = [];
  releaseParked();
  doneEls = new WeakSet();
  linkTexts = new Map();
  failedEls.clear();
  linkTextByText.clear();
  inFlightEls.clear();
  hiddenByToggle = false;
  document.documentElement.classList.remove('tw-hide-tr');
  progressReset(); // 新会话从干净状态开始
  clearTranslations();
  collectAndEnqueue();
}

function stopSession(): void {
  sessionSeq++;
  queue = [];
  releaseParked();
  pageActive = false;
  hiddenByToggle = false;
  document.documentElement.classList.remove('tw-hide-tr');
  failedEls.clear();
  linkTextByText.clear();
  inFlightEls.clear();
  progressReset();
  clearTranslations();
  fab?.update(statusText());
}

/**
 * 快捷键隐藏：译文 DOM 保留（CSS 隐藏），重新显示瞬时恢复、不重走翻译管线。
 * 未落定的块（队列/挂起/进行中）从 doneEls 放行，恢复时补翻——后台缓存与
 * inflight 合并兜底，不会重复请求 AI。进行中的请求被丢弃，但后台侧会完成并落缓存。
 */
function pauseTranslations(): void {
  hiddenByToggle = true;
  sessionSeq++;
  pageActive = false;
  for (const b of queue) if (b.el) doneEls.delete(b.el);
  for (const arr of parked.values()) for (const b of arr) if (b.el) doneEls.delete(b.el);
  for (const el of inFlightEls) doneEls.delete(el);
  queue = [];
  releaseParked();
  inFlightEls.clear();
  progressReset();
  document.documentElement.classList.add('tw-hide-tr');
  fab?.update(statusText());
}

/** 快捷键重新显示：恢复已渲染译文（瞬时），只补翻 新增内容 + AI 失败块 */
function resumeTranslations(): void {
  hiddenByToggle = false;
  document.documentElement.classList.remove('tw-hide-tr');
  // 失败块宿主：清掉旧渲染后重试（成功句命中缓存瞬时还原，失败句重发 AI）
  for (const el of failedEls) {
    removeHostRenders(el);
    doneEls.delete(el);
  }
  failedEls.clear();
  collectAndEnqueue();
  fab?.update(statusText());
}

/** 快捷键切换：隐藏中 → 瞬时恢复；翻译中/已有译文 → CSS 隐藏；无译文且未在翻 → 全新翻译 */
function toggleTranslation(): void {
  if (hiddenByToggle) {
    resumeTranslations();
    return;
  }
  if (pageActive || document.querySelector('.tw-tr')) pauseTranslations();
  else startSession();
}

/** 页面级快捷键（设置可录制修改，见 shared/hotkey.ts） */
function watchShortcut(): void {
  document.addEventListener(
    'keydown',
    e => {
      if (!settings.toggleShortcut) return;
      const t = e.target;
      // 焦点在输入框/可编辑区时不拦截，避免劫持打字
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (!matchShortcut(e, settings.toggleShortcut)) return;
      e.preventDefault();
      e.stopPropagation();
      toggleTranslation();
    },
    { capture: true },
  );
}

/** 增量采集：懒加载注入的节点（评论区、tabber 切换等）只取新增块 */
function runIncremental(): void {
  incTimer = undefined;
  const els = pendingEls;
  pendingEls = [];
  if (!els.length || !enabled || !pageActive) return;
  for (const el of els) {
    if (!(el instanceof HTMLElement)) continue;
    if (!el.isConnected || doneEls.has(el)) continue;
    // 用户选择不翻译评论：评论区注入的内容整体跳过
    if (!settings.translateComments && el.closest(COMMENTS_ROOT_SEL)) continue;
    incSeq++;
    const { blocks } = collectBlocks(el, { blockIdBase: `inc${incSeq}`, skipComments: !settings.translateComments });
    enqueue(blocks);
  }
}

function watchMutations(): void {
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        // 自己插入的译文块/控件不采集
        if (n.classList.contains('tw-tr') || n.id === 'tw-fab-host' || n.id === 'tw-toast-host' || n.id === 'tw-progress-host' || n.id === 'tw-style') continue;
        if (n.closest('.tw-tr')) continue;
        pendingEls.push(n);
      }
    }
    if (pendingEls.length && incTimer === undefined) {
      incTimer = window.setTimeout(runIncremental, 500);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

/** 悬浮开关（Shadow DOM 隔离样式） */
function fabTitle(): string {
  const keyHint = settings.aiKey ? '' : '未配置 API Key，点击前往设置；';
  const sc = settings.aiKey && settings.toggleShortcut ? `，${settings.toggleShortcut} 切换译文` : '';
  return `Warframe Wiki 精准翻译（${keyHint}点击 开/关${sc}）`;
}

function setupFab(): void {
  const host = document.createElement('div');
  host.id = 'tw-fab-host';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { position: fixed; right: 14px; bottom: 14px; z-index: 2147483646; }
    button {
      all: initial;
      font: 600 12px/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      padding: 8px 12px; border-radius: 16px; cursor: pointer;
      background: rgba(28, 36, 54, .88); color: #fff;
      box-shadow: 0 2px 10px rgba(0,0,0,.35);
      user-select: none;
    }
    button:hover { background: rgba(44, 56, 84, .92); }
  `;
  const btn = document.createElement('button');
  btn.title = fabTitle();
  btn.addEventListener('click', async () => {
    // 未配置 Key：引导去设置页（不改变站点开关，避免之后配好 Key 反而被"停用"）
    if (!settings.aiKey) {
      showToast('未配置 API Key，正在打开设置…', { duration: 2500 });
      api.runtime.sendMessage({ type: 'openOptions' }).catch(() => {});
      return;
    }
    enabled = !enabled;
    await setSiteEnabled(location.origin, enabled);
    if (!enabled) stopSession();
    else if (settings.autoTranslate) startSession();
    btn.textContent = statusText();
  });
  root.append(style, btn);
  document.body.appendChild(host);
  fab = { update: s => { btn.textContent = s; }, retitle: () => { btn.title = fabTitle(); } };
  btn.textContent = statusText();
}

function watchStorage(): void {
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      const prev = settings;
      settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue as Partial<Settings>) };
      applyStyle();
      fab?.update(statusText());
      fab?.retitle();
      // API Key 增删: 立即开/停整页翻译（配置即时生效）
      if (!!settings.aiKey !== !!prev.aiKey) {
        if (settings.aiKey) {
          if (enabled && settings.autoTranslate) startSession();
        } else {
          stopSession();
        }
      } else if (prev.translateComments !== settings.translateComments && pageActive && enabled) {
        // 评论翻译开关变化：整页重开 会话（其余块走缓存，瞬时完成）
        startSession();
      }
    }
    if (changes.siteEnabled) {
      const map = (changes.siteEnabled.newValue as Record<string, boolean> | undefined) || {};
      const en = map[location.origin] !== false;
      if (en !== enabled) {
        enabled = en;
        fab?.update(statusText());
        if (!enabled) stopSession();
        else if (settings.autoTranslate) startSession();
      }
    }
  });
}

function watchUrl(): void {
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    sessionSeq++; // 取消进行中的会话
    hiddenByToggle = false;
    document.documentElement.classList.remove('tw-hide-tr');
    setTimeout(() => {
      if (enabled && settings.autoTranslate) startSession();
    }, 800);
  }, 800);
}

async function boot(): Promise<void> {
  try {
    const resp = (await api.runtime.sendMessage({ type: 'bootstrap' })) as
      | { settings: Settings; glossary: GlossaryMeta; ready: boolean }
      | undefined;
    if (resp?.settings) {
      settings = { ...DEFAULT_SETTINGS, ...resp.settings };
    }
  } catch (e) {
    console.warn('[tw] bootstrap failed (extension reload?)', e);
  }
  enabled = await getSiteEnabled(location.origin);
  applyStyle();
  setupFab();
  watchStorage();
  watchUrl();
  watchMutations();
  watchShortcut();

  api.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg.type === 'translateNow') startSession();
    else if (msg.type === 'restore') stopSession();
    else if (msg.type === 'toggleTranslation') toggleTranslation();
  });

  if (settings.autoTranslate && enabled) startSession();
}

boot();
