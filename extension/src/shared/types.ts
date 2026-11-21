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
  zhSearch: boolean; // 搜索框支持中文术语：输入官方中文译名拉候选，提交时改写为英文（纯词表反向查询，不依赖 AI）
  /** 仅存在于派生副本（发给 content script 的 settings）：真实 key 是否已配置。
   *  storage 与 options 页持有的 aiKey 不进此字段——content 上下文只拿布尔位，不持明文。 */
  hasKey?: boolean;
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

/** 搜索框中文候选（词表反向查询，zh→en） */
export interface ZhSuggestItem {
  en: string;
  zh: string;
  /** 输入与词条 zh 完全相等（区别于前缀扩展出的候选） */
  exact: boolean;
}

/** 查询串里被改写掉的中文片段 */
export interface ZhResolveHit {
  zh: string;
  en: string;
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
  /** AI 失败/校验不过的回退块（translation = 原文）：不渲染误导性"原文+译名链接"，待补翻重试 */
  failed?: boolean;
}

/** content ↔ background 消息 */
export type Msg =
  | { type: 'bootstrap' }
  | { type: 'translate'; blocks: BlockIn[]; mode?: 'dict' | 'ai' }
  | { type: 'glossaryStatus' }
  | { type: 'glossaryUpdate'; force?: boolean }
  | { type: 'aiTest' }
  | { type: 'settingsChanged' }
  | { type: 'cacheStats' }
  | { type: 'cacheClear' }
  | { type: 'zhSuggest'; q: string; limit?: number }
  | { type: 'zhResolve'; q: string };

export interface BootstrapResp {
  settings: Settings;
  glossary: GlossaryMeta;
  ready: boolean;
}
