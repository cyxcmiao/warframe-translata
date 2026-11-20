import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  aiBaseUrl: 'https://api.deepseek.com/v1',
  aiKey: '',
  aiModel: 'deepseek-chat',
  autoTranslate: true,
  translateComments: true,
  fontSize: 14,
  color: '#4a90d9',
  toggleShortcut: 'Ctrl+Alt+D',
  glossaryCheckHours: 24,
};

/**
 * 语言文件层词条的托管仓库（GitHub Actions 每日重建 data/lang_terms.json 并提交，
 * 扩展后台按文件内容 sha 增量拉取）。仓库必须为 public（raw/jsDelivr 匿名拉取依赖）。
 */
export const LANG_TERMS_REPO = 'cyxcmiao/warframe-translata';

export const STORAGE_KEYS = {
  settings: 'settings',
  siteEnabled: 'siteEnabled', // { [origin]: boolean }
  usage: 'usage', // { month, prompt, completion, requests }
} as const;

/**
 * 翻译缓存 key 的提示词版本号。
 * 改 TRANSLATE_SYSTEM_PROMPT、机制词表（data/mechanism_terms.json）等影响译文
 * 质量的内容时必须 bump，旧缓存自然失效重翻——否则用户永远看到旧译文。
 */
export const PROMPT_VERSION = 5;

/** 链接占位符: ⟦12⟧ */
export const tokenRegex = /⟦(\d+)⟧/g;

export function makeToken(id: number): string {
  return `⟦${id}⟧`;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
