/** 共享类型定义 */

export interface Settings {
  aiBaseUrl: string; // 例如 https://api.deepseek.com/v1
  aiKey: string;
  aiModel: string;
  autoTranslate: boolean; // 打开 wiki 页面自动翻译
  translateComments: boolean; // 翻译页面下方的用户评论（Yappin）
  fontSize: number; // 译文字号
  color: string; // 译文主色
  toggleShortcut: string; // 切换 译文/隐藏 的快捷键（"Ctrl+Alt+D"，空串 = 禁用）
  glossaryCheckHours: number; // 词表更新检查间隔
}

export interface GlossaryMeta {
  version: string;
  count: number;
  /** 官方保留英文原名的条目数（这些名字保留英文即正确译法） */
  retainedCount: number;
  builtAt: string;
  lastCheck: string | null;
  /** 游戏语言文件挖掘层的条目数与上次拉取时间（运行时自动更新） */
  langCount: number;
  langLastCheck: string | null;
}

/** 词表匹配结果（位置基于传入文本） */
export interface TermMatch {
  s: number;
  e: number;
  en: string;
  zh: string;
  /** 命中了所有格后缀 's（译文应为 zh + 的） */
  pos: boolean;
}

export interface TermEntry {
  en: string;
  zh: string;
}

export interface BlockIn {
  id: string;
  text: string;
  /** 文本内图标占位符的 token id（⟦n⟧ 里代表行内小图标的 n），供译后重定位 */
  icons?: number[];
}

export interface BlockOut {
  id: string;
  ok: boolean;
  translation?: string;
  viaAI?: boolean;
  error?: string;
}

/** content ↔ background 消息 */
export type Msg =
  | { type: 'bootstrap' }
  | { type: 'translate'; blocks: BlockIn[]; mode?: 'dict' | 'ai' }
  | { type: 'glossaryStatus' }
  | { type: 'glossaryUpdate'; force?: boolean }
  | { type: 'aiTest' }
  | { type: 'settingsChanged' }
  | { type: 'openOptions' }
  | { type: 'cacheStats' }
  | { type: 'cacheClear' };

export interface BootstrapResp {
  settings: Settings;
  glossary: GlossaryMeta;
  ready: boolean;
}
