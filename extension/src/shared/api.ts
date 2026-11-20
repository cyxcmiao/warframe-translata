/** 跨浏览器 API 别名: Firefox 用 browser.*，Chrome 用 chrome.*（两者都返回 Promise） */
export const api: typeof chrome = (globalThis as unknown as { browser?: typeof chrome }).browser
  ?? (globalThis as unknown as { chrome: typeof chrome }).chrome;
