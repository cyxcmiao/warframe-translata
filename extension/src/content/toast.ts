/**
 * toast.ts — 页面内自动消散的悬浮提示（Shadow DOM 隔离样式）
 * 用于 API Key 未配置 / AI 接口连接失败等需要告知用户的状态。
 */

let host: HTMLDivElement | null = null;
let msg: HTMLDivElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let lastShownAt = 0;
let lastMessage = '';

function ensure(): void {
  if (host && host.isConnected) return;
  host = document.createElement('div');
  host.id = 'tw-toast-host';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483646; pointer-events: none; }
    div {
      all: initial;
      display: block;
      font: 500 13px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #fff; background: rgba(28, 36, 54, .92);
      padding: 10px 16px; border-radius: 8px;
      box-shadow: 0 4px 14px rgba(0,0,0,.3);
      max-width: 70vw; word-break: break-word; white-space: pre-wrap; text-align: center;
      opacity: 0; transition: opacity .35s ease;
    }
  `;
  msg = document.createElement('div');
  root.append(style, msg);
  document.body.appendChild(host);
}

/** 显示提示，duration 毫秒后自动淡出；同一消息在 cooldownMs 内的重复调用忽略（防刷屏），新消息不受限 */
export function showToast(message: string, opts: { duration?: number; cooldownMs?: number } = {}): void {
  const { duration = 4500, cooldownMs = 5000 } = opts;
  if (message === lastMessage && Date.now() - lastShownAt < cooldownMs) return;
  if (!document.body) return;
  lastMessage = message;
  lastShownAt = Date.now();
  ensure();
  if (!msg) return;
  msg.textContent = message;
  msg.style.opacity = '1';
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (msg) msg.style.opacity = '0';
  }, duration);
}
