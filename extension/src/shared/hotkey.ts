/**
 * hotkey.ts — 自定义切换译文快捷键的录制与匹配
 *
 * 浏览器 chrome.commands 无法由扩展程序化修改（Chrome 不提供 API），
 * 故快捷键由 content 脚本捕获页面 keydown 实现，配置存于设置项，
 * 设置页可录制修改。表示法: "Alt+T"、"Ctrl+Shift+9"、"F3"；空串 = 禁用。
 * 主键取 e.code（KeyT/Digit9 等），不受输入法/大小写锁定影响。
 */

/** 非字母/数字主键的显示名（按 e.code 查） */
const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** keydown 事件对应的主键显示名；纯修饰键/不支持的键返回 null */
function keyOf(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(c)) return c; // F1–F12
  return CODE_LABELS[c] ?? null;
}

function modsOf(e: KeyboardEvent): Set<string> {
  const mods = new Set<string>();
  if (e.ctrlKey) mods.add('Ctrl');
  if (e.altKey) mods.add('Alt');
  if (e.shiftKey) mods.add('Shift');
  if (e.metaKey) mods.add('Meta');
  return mods;
}

/**
 * 从 keydown 事件提取规范快捷键串（录制用）。
 * 裸键（无修饰键且非 F1~F12）不允许 —— 否则会劫持打字/滚动。
 */
export function formatShortcut(e: KeyboardEvent): string | null {
  const key = keyOf(e);
  if (!key) return null;
  const mods = modsOf(e);
  const isFKey = /^F([1-9]|1[0-2])$/.test(key);
  if (!mods.size && !isFKey) return null;
  return [...mods, key].join('+');
}

/** event 是否命中已保存的快捷键 */
export function matchShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.trim().split('+').filter(Boolean);
  if (!parts.length) return false;
  const raw = parts.pop()!;
  const canon: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
  const wanted = new Set<string>();
  for (const p of parts) {
    const m = canon[p.toLowerCase()];
    if (!m) return false;
    wanted.add(m);
  }
  const mods = modsOf(e);
  if (mods.size !== wanted.size) return false;
  for (const m of wanted) if (!mods.has(m)) return false;
  return keyOf(e)?.toUpperCase() === raw.toUpperCase();
}
