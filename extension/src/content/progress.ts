/**
 * progress.ts — 顶部灵动岛式进度胶囊（Shadow DOM 隔离样式，同 FAB/Toast）
 *
 * 翻译进行中的全局反馈：页顶居中一颗短胶囊（深色毛玻璃，backdrop-filter），
 * 内部按 已完成/剩余 推进彩色填充，清空后定格 100% 短暂停留再缩出淡去。
 * 防闪烁：开始 300ms 内就结束的波次（缓存全命中等瞬时场景）不显示，避免瞬闪。
 * 填充色跟随译文主色（--tw-tr-color 经 :root 继承进 Shadow DOM）。
 */

let host: HTMLDivElement | null = null;
let barEl: HTMLDivElement | null = null;
let fill: HTMLDivElement | null = null;
let shown = false;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null; // 100% 定格计时
let offTimer: ReturnType<typeof setTimeout> | null = null; // 'off' 缩出后的复位计时

const SHOW_DELAY_MS = 300; // 短波次防闪烁：300ms 内结束就不显示
const DONE_HOLD_MS = 400; // 100% 定格时长
const FADE_MS = 350; // 缩出淡去时长（与 CSS transition 保持一致）

function ensure(): void {
  if (host && host.isConnected) return;
  host = document.createElement('div');
  host.id = 'tw-progress-host';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
      z-index: 2147483646; pointer-events: none;
    }
    .bar {
      all: initial;
      display: block; position: relative;
      width: 140px; height: 10px; border-radius: 999px;
      background: rgba(14, 17, 26, .78);
      -webkit-backdrop-filter: blur(16px) saturate(1.5);
      backdrop-filter: blur(16px) saturate(1.5);
      box-shadow: 0 2px 16px rgba(0,0,0,.25), inset 0 0 0 1px rgba(255,255,255,.12);
      overflow: hidden;
      opacity: 0; transform: scale(.7);
      transition: opacity .3s ease, transform .3s cubic-bezier(.2, .9, .3, 1.2);
    }
    .bar.on { opacity: 1; transform: scale(1); }
    .bar.off { opacity: 0; transform: scale(.7); }
    .track { position: absolute; inset: 2px; border-radius: 999px; background: rgba(255,255,255,.16); overflow: hidden; }
    .track::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.3), transparent);
      transform: translateX(-100%);
    }
    .bar.on .track::after { animation: tw-sheen 1.8s ease-in-out infinite; }
    @keyframes tw-sheen { 60%, 100% { transform: translateX(100%); } }
    .fill {
      position: absolute; top: 2px; bottom: 2px; left: 2px; width: 0;
      border-radius: 999px;
      background: var(--tw-tr-color, #4a90d9);
      box-shadow: 0 0 6px var(--tw-tr-color, #4a90d9);
      transition: width .25s ease;
    }
  `;
  barEl = document.createElement('div');
  barEl.className = 'bar';
  const track = document.createElement('div');
  track.className = 'track';
  fill = document.createElement('div');
  fill.className = 'fill';
  barEl.append(track, fill);
  root.append(style, barEl);
  document.body.appendChild(host);
}

function show(): void {
  ensure();
  shown = true;
  barEl!.classList.remove('off');
  barEl!.classList.add('on');
}

function clearTimers(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (offTimer) {
    clearTimeout(offTimer);
    offTimer = null;
  }
}

/** 新波次开始：已显示则复用（比例由 advance 推进），未显示则武装防闪烁计时 */
export function progressStart(): void {
  if (!document.body) return;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (offTimer) {
    // 上一波正在缩出淡去时来了新波：取消复位、从 'off' 复活，胶囊不闪空
    clearTimeout(offTimer);
    offTimer = null;
    barEl!.classList.remove('off');
    barEl!.classList.add('on');
    return;
  }
  if (shown) return;
  clearTimers();
  showTimer = setTimeout(() => {
    showTimer = null;
    show();
  }, SHOW_DELAY_MS);
}

/** 推进：done 为已完成块数，total = done + 队列剩余（非链接块） */
export function progressAdvance(done: number, total: number): void {
  if (!shown) {
    if (!showTimer) return;
    clearTimeout(showTimer);
    showTimer = null;
    show(); // 已有真实进度可展示，提前结束防闪烁等待
  }
  const pct = total > 0 ? Math.min(done / total, 1) : 0;
  fill!.style.width = `${(pct * 100).toFixed(1)}%`;
}

/** 波次结束：定格 100%，短暂停留后缩出淡去 */
export function progressFinish(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (!shown) return;
  fill!.style.width = '100%';
  hideTimer = setTimeout(() => {
    hideTimer = null;
    barEl!.classList.remove('on');
    barEl!.classList.add('off');
    offTimer = setTimeout(() => {
      offTimer = null;
      // 缩出结束后复位填充，下一波次从 0 开始
      if (fill) fill.style.width = '0%';
      shown = false;
      barEl?.classList.remove('off');
    }, FADE_MS);
  }, DONE_HOLD_MS);
}

/** 立即隐藏（停止翻译/切换会话），不打 100% */
export function progressReset(): void {
  clearTimers();
  if (shown) {
    shown = false;
    barEl?.classList.remove('on', 'off');
    if (fill) fill.style.width = '0%';
  }
}
