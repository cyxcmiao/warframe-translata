/**
 * content 入口 — 编排：采集 → 批量翻译 → 渲染，含悬浮开关、顶部进度条、SPA URL 监听。
 *
 * 增量翻译：评论区（Yappin）等懒加载内容是滚动后由前端注入的，
 * 用 MutationObserver 监听新增节点，只采集新增块、走同一管线
 * （后台缓存 + 进行中请求合并保证不重复请求）。
 */
import { collectBlocks, collectPageTitle, findContentRoot, COMMENTS_ROOT_SEL } from './dom';
import type { RawBlock } from './dom';
import { renderResult, insert, clearTranslations, removeHostRenders, LinkTexts } from './renderer';
import { showToast } from './toast';
import { progressStart, progressAdvance, progressFinish, progressReset } from './progress';
import { initZhSearch, setZhSearchEnabled } from './searchbox';
import { api } from '../shared/api';
import { DEFAULT_SETTINGS } from '../shared/const';
import { matchShortcut } from '../shared/hotkey';
import type { Settings, GlossaryMeta, BlockOut } from '../shared/types';

const CHUNK = 16;
let settings: Settings = DEFAULT_SETTINGS;
let sessionSeq = 0;
let pageActive = false; // 本页已发起过翻译（自动或手动），增量翻译据此决定是否跟随

let linkTexts: LinkTexts = new Map();
let doneEls = new WeakSet<Element>(); // 已处理过的块宿主（含无译文块），防增量重复采集
let queue: RawBlock[] = [];
/** 视口外的挂起块：宿主 el → 该宿主的待翻块（保持采集顺序，拆句块一起放行） */
let parked = new Map<Element, RawBlock[]>();
let parkIO: IntersectionObserver | null = null;
let parkRO: ResizeObserver | null = null; // 零面积挂起块的尺寸监听（IO 不报"零面积→有面积"）
let pumping = false;
let incSeq = 0;
let incTimer: number | undefined;
let pendingEls: Element[] = [];
let hiddenByToggle = false; // 快捷键隐藏态：译文 DOM 保留（仅 CSS 隐藏），重新显示瞬时恢复
let failedEls = new Set<Element>(); // AI 失败块宿主，滚动放行新内容或重新显示时补翻重试
let autoRetried = new WeakSet<Element>(); // 已搭车自动重试过的失败宿主（限一次，防对故障接口反复刷请求）
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
 * 补翻重试搭车：新一轮内容放行时（滚动挂起块/增量注入），把之前 AI 失败的宿主
 * 重新采集入队，搭同一波请求的便车。只搭车不发起——没有新内容就不重试，
 * 避免对故障接口自动刷请求；每个宿主每次会话只自动搭车一次，再失败等手动切换补翻。
 */
function retryFailedPiggyback(): void {
  if (!failedEls.size) return;
  const els = [...failedEls].filter(el => !autoRetried.has(el));
  if (!els.length) return;
  const blocks: RawBlock[] = [];
  for (const el of els) {
    failedEls.delete(el);
    autoRetried.add(el);
    if (!(el instanceof HTMLElement) || !el.isConnected) continue;
    removeHostRenders(el);
    doneEls.delete(el);
    incSeq++;
    blocks.push(...collectBlocks(el, { blockIdBase: `retry${incSeq}`, skipComments: !settings.translateComments }).blocks);
  }
  if (blocks.length) enqueue(blocks);
}

/**
 * 视口懒翻译：首屏附近（向下预翻 400px）的块立即入队；
 * 其余挂起，滚动接近视口（+800px 预翻带）时由 IntersectionObserver 放行。
 * 省钱（不翻用户没读到的部分）+ 首屏出译文更快。
 */
function enqueue(blocks: RawBlock[]): void {
  retryFailedPiggyback();
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

/** 放行挂起块：取走该宿主的全部待翻块入队（IO 放行与 RO 放行共用） */
function releaseParkedEls(els: Element[]): void {
  const rel: RawBlock[] = [];
  for (const el of els) {
    const arr = parked.get(el);
    if (arr) rel.push(...arr);
    parked.delete(el);
    parkIO?.unobserve(el);
    parkRO?.unobserve(el);
  }
  if (rel.length) {
    retryFailedPiggyback(); // 滚动放行新内容 = 失败块补翻的搭车时机
    queue.push(...rel);
    void drain();
  }
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
        const rel: Element[] = [];
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          // 零面积盒（未激活的 tabber 面板、折叠的 collapsible 等）：零面积点落在
          // margin 带内 isIntersecting 也会报 true，但按懒翻译设计它们必须等真正
          // 显示（拿到真实高度）再放行，否则滚动路过就白翻隐藏内容。
          // 注意 IO 对"零面积→有面积"不触发回调（未跨阈值），改挂 ResizeObserver
          // 盯尺寸变化放行
          if (en.boundingClientRect.height <= 0) {
            parkRO!.observe(en.target);
            continue;
          }
          rel.push(en.target);
        }
        if (rel.length) releaseParkedEls(rel);
      },
      { rootMargin: '800px 0px' },
    );
  }
  if (!parkRO) {
    parkRO = new ResizeObserver(entries => {
      const rel: Element[] = [];
      for (const en of entries) {
        if (en.target.getBoundingClientRect().height <= 0) continue;
        rel.push(en.target);
      }
      if (rel.length) releaseParkedEls(rel);
    });
  }
  for (const el of added) parkIO.observe(el);
}

function releaseParked(): void {
  parkIO?.disconnect();
  parkIO = null;
  parkRO?.disconnect();
  parkRO = null;
  parked.clear();
}

/**
 * 并行发送窗口：同时允许多条 translate 消息在途。原实现每 16 块等一次完整 AI 往返，
 * 后台的并发池（AI_CONCURRENCY）基本闲置，整页翻译近似串行；窗口 3 条后池子吃满，
 * 吞吐约 ×3。首条消息仍是最先入队的小批（链接块优先），首屏出译文时间不变。
 * 跨消息并发的总量由后台全局并发闸（GLOBAL_AI_CAP）兜底，不会压垮限流严格的接口。
 */
const SEND_WINDOW = 3;

/**
 * 单条消息全生命周期：发送 → 渲染 → 失败兜底。
 * 返回 false 表示消息级失败（SW 冷启动/重载瞬间），drain 收到后停止发新消息；
 * 链接块退回队列等下次触发，正文块宿主记入 failedEls 搭车补翻。
 * 自身不抛错（渲染异常也在 catch 内消化），调用方以 then 链保证记账与放行。
 */
async function sendChunk(chunk: RawBlock[], seq: number): Promise<boolean> {
  let results: Record<string, BlockOut> = {};
  let resp: { results?: Record<string, BlockOut>; aiFailed?: boolean; aiError?: string } | undefined;
  try {
    resp = (await api.runtime.sendMessage({
      type: 'translate',
      blocks: chunk.map(b => ({ id: b.id, text: b.text, icons: [...b.icons.keys()] })),
    })) as { results?: Record<string, BlockOut>; aiFailed?: boolean; aiError?: string } | undefined;
  } catch (e) {
    console.warn('[tw] translate failed:', e);
    for (const rec of chunk) {
      if (rec.kind === 'link') queue.unshift(rec); // 链接块无宿主，退回队列等下次触发重发
      else if (rec.el) {
        inFlightEls.delete(rec.el);
        failedEls.add(rec.el);
      }
    }
    return false;
  }
  results = resp?.results ?? {};
  if (resp?.aiFailed) {
    showToast(AI_ERR_MSG[resp.aiError ?? 'unknown'] ?? AI_ERR_MSG.unknown, { cooldownMs: 60000 });
  }
  if (seq !== sessionSeq) return true; // 会话已切换（如 SPA 切页）：跳过渲染，进度条由切会话方 reset

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
    // AI 失败块（显式 failed 或共享超时 ok:false）以原文回退且不渲染：记下宿主，
    // 滚动放行新内容/重新显示时补翻重试（后台缓存使已成功块瞬时还原）
    if (rec.el && (!out?.ok || out?.failed)) {
      failedEls.add(rec.el);
    }
  }
  for (const rec of chunk) if (rec.el) inFlightEls.delete(rec.el);
  return true;
}

async function drain(): Promise<void> {
  if (pumping) return;
  pumping = true;
  let done = 0; // 本波次已渲染块数（含链接块），供顶部进度条推进
  let sent = 0; // 在途块数：进度条分母 = done + 队列剩余 + 在途（管道化后块已出队但未渲染）
  progressStart();
  let active = 0;
  let waiter: (() => void) | null = null; // 单等待者：只有 drain 自己等名额
  const release = (): void => {
    active--;
    const w = waiter;
    waiter = null;
    w?.();
  };
  const waitForSlot = (): Promise<void> => new Promise(r => { waiter = r; });
  let linkInFlight = 0; // 在途链接块数：正文块渲染依赖链接译名（renderResult 对无译名的
  // 纯链接容器直接跳过且不重试），链接未落定前不发送后续正文块——等价于旧串行
  // 管线"链接块全部解析完才轮到正文块"的全局顺序保证
  let sendBroken = false;
  try {
    for (;;) {
      if (sendBroken) break;
      if (!queue.length) {
        if (active === 0) break;
        // 队列空但仍有在途消息：等落定。醒后重新走循环检查——
        // 等待期间 parkIO 放行/增量采集可能已把新块入队（译文插入引起布局变化
        // 会再触发 IO 回调），这里必须拾起，否则块搁浅到下一次触发都没有人翻。
        await waitForSlot();
        continue;
      }
      if (linkInFlight > 0 && queue[0].kind !== 'link') {
        await waitForSlot(); // 链接块在途：正文块等落定（醒后重查队列与在途状态）
        continue;
      }
      if (active >= SEND_WINDOW) await waitForSlot();
      if (sendBroken) break;
      const chunk = queue
        .splice(0, CHUNK)
        .filter(b => b.kind === 'link' || (b.el && b.el.isConnected));
      if (!chunk.length) continue;
      for (const rec of chunk) if (rec.kind !== 'link' && rec.el) inFlightEls.add(rec.el);
      const seq = sessionSeq;
      active++;
      linkInFlight += chunk.reduce((n, b) => n + (b.kind === 'link' ? 1 : 0), 0);
      sent += chunk.length;
      void sendChunk(chunk, seq)
        .catch(e => {
          console.warn('[tw] chunk crashed:', e);
          return false;
        })
        .then(ok => {
          release(); // 最先放行名额：后续记账/渲染异常不能悬挂管道
          linkInFlight -= chunk.reduce((n, b) => n + (b.kind === 'link' ? 1 : 0), 0);
          done += chunk.length;
          sent -= chunk.length;
          progressAdvance(done, done + queue.length + sent);
          if (!ok) sendBroken = true;
        })
        .catch(() => {});
    }
  } finally {
    pumping = false;
    if (sendBroken) progressFinish(); // 消息级失败收尾，进度条不滞留半途
    else if (!queue.length) progressFinish();
  }
}

/** 采集正文根节点并入队（新会话 / 隐藏后重新显示 共用） */
function collectAndEnqueue(): void {
  const rootEl = findContentRoot();
  if (!rootEl) return;
  pageActive = true;
  const { blocks } = collectBlocks(rootEl, { skipComments: !settings.translateComments });
  // 页面大标题（h1#firstHeading）在正文根之外，正文根采集不到——显式补采放最前，
  // 让标题译文最先出（与下方评论容器补采同理：都在 #mw-content-text 外）
  const titleBlock = collectPageTitle();
  if (titleBlock && !rootEl.contains(titleBlock.el)) blocks.unshift(titleBlock);
  // 评论容器（Yappin 挂载点）位于 #mw-content-text 之外，正文根采集不到；
  // 开关切回开、或页面带着评论区位置刷新时它早已挂载（连评论项都在 DOM 里），
  // 必须显式补采——只靠 MutationObserver 赶注入瞬间，错过即永不翻译。
  // blockIdBase 用 'c' 区别于正文根的 'b0…'，避免两轮采集的块 id 撞车
  const commentsEl = settings.translateComments
    ? document.querySelector<HTMLElement>(COMMENTS_ROOT_SEL)
    : null;
  if (commentsEl && !rootEl.contains(commentsEl)) {
    blocks.push(...collectBlocks(commentsEl, { blockIdBase: 'c', skipComments: false }).blocks);
  }
  enqueue(blocks);
}

async function startSession(): Promise<void> {
  if (!settings.hasKey) {
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
  if (!els.length || !pageActive) return;
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
        if (n.classList.contains('tw-tr') || n.id === 'tw-toast-host' || n.id === 'tw-progress-host' || n.id === 'tw-style') continue;
        if (n.closest('.tw-tr')) continue;
        // 搜索框术语候选（searchbox 注入，含中文主文本）不采集，避免被当源文本翻译
        if (n.classList.contains('tw-zh-item') || n.closest('.tw-zh-item')) continue;
        pendingEls.push(n);
      }
    }
    if (pendingEls.length && incTimer === undefined) {
      incTimer = window.setTimeout(runIncremental, 500);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

function watchStorage(): void {
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      const prev = settings;
      const raw = changes.settings.newValue as Partial<Settings>;
      // 脱敏：content 上下文不持有明文 aiKey，只留布尔位
      settings = { ...DEFAULT_SETTINGS, ...raw, aiKey: '', hasKey: !!raw.aiKey };
      applyStyle();
      setZhSearchEnabled(settings.zhSearch); // 搜索框中文术语开关即时生效
      // API Key 增删: 立即开/停整页翻译（配置即时生效）
      if (!!settings.hasKey !== !!prev.hasKey) {
        if (settings.hasKey) {
          if (settings.autoTranslate) startSession();
        } else {
          stopSession();
        }
      } else if (prev.translateComments !== settings.translateComments && pageActive) {
        // 评论翻译开关变化：整页重开 会话（其余块走缓存，瞬时完成）
        startSession();
      }
    }
  });
}

function watchUrl(): void {
  // 只比较路径+查询，不比较 hash：hash 变化是页内锚点跳转（Tabber 切页、TOC、
  // 引文回链），文档没换——按换页处理会 clearTranslations 清空整页译文重翻，
  // 用户点一下 tab 就看着全部翻译消失（Nightwatch Corps 页 tabber 曾必现）
  let lastUrl = location.pathname + location.search;
  setInterval(() => {
    const url = location.pathname + location.search;
    if (url === lastUrl) return;
    lastUrl = url;
    sessionSeq++; // 取消进行中的会话
    hiddenByToggle = false;
    document.documentElement.classList.remove('tw-hide-tr');
    setTimeout(() => {
      if (settings.autoTranslate) startSession();
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
  applyStyle();
  watchStorage();
  watchUrl();
  watchMutations();
  watchShortcut();
  // 搜索框中文术语：纯词表反向查询，不依赖 AI Key，独立于翻译会话
  initZhSearch(settings.zhSearch);

  api.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg.type === 'translateNow') startSession();
    else if (msg.type === 'restore') stopSession();
    else if (msg.type === 'toggleTranslation') toggleTranslation();
  });

  if (settings.autoTranslate) startSession();
}

boot();
