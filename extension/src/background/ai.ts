/**
 * ai.ts — OpenAI 兼容接口客户端
 */

export interface AiConfig {
  baseUrl: string;
  key: string;
  model: string;
}

export class AiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export interface ChatResult {
  content: string;
  /** finish_reason === 'length'：输出被 max_tokens 截断，末尾行不可信 */
  truncated: boolean;
  /** 接口返回的 token 用量（部分兼容接口可能不给，为 undefined） */
  usage?: { prompt: number; completion: number };
}

/** 输出上限兜底：中文译文规模与英文原文同量级，2 倍字符数已是宽松上界，只为防失控复读 */
export function estimateMaxTokens(user: string): number {
  return Math.ceil(user.length * 2) + 512;
}

/** 单次 chat completion（超时 60s，不重试——重试在编排层做） */
export async function chatOnce(
  cfg: AiConfig,
  system: string,
  user: string,
  temperature = 0.1,
  maxTokens?: number,
): Promise<ChatResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature,
        stream: false,
        max_tokens: maxTokens ?? estimateMaxTokens(user),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AiError(`HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (!content) throw new AiError('empty response');
    return {
      content,
      truncated: choice?.finish_reason === 'length',
      usage: data.usage
        ? { prompt: data.usage.prompt_tokens ?? 0, completion: data.usage.completion_tokens ?? 0 }
        : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function chatWithRetry(
  cfg: AiConfig,
  system: string,
  user: string,
  retries = 1,
  maxTokens?: number,
): Promise<ChatResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chatOnce(cfg, system, user, 0.1, maxTokens);
    } catch (e) {
      lastErr = e;
      const status = e instanceof AiError ? e.status : undefined;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt === retries) break;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** 错误分型：让 content 能给出用户可操作的提示（Key 问题 / 限流 / 超时 / 网络） */
export type AiErrKind = 'auth' | 'rate' | 'timeout' | 'server' | 'network' | 'unknown';

export function classifyAiError(e: unknown): AiErrKind {
  if (e instanceof AiError) {
    if (e.status === 401 || e.status === 403) return 'auth';
    if (e.status === 429) return 'rate';
    return 'server'; // 其余 HTTP 状态（400/404/5xx 等）都算接口侧问题
  }
  if (e instanceof Error && e.name === 'AbortError') return 'timeout'; // chatOnce 60s 超时
  return 'network'; // fetch 抛出的 TypeError 等 → 连接建立失败
}

/**
 * 翻译提示词。必须保持字节级稳定（不含时间、随机量等动态内容）：
 * DeepSeek 等端的前缀缓存按前缀命中，提示词一旦变动整段缓存失效。
 */
export const TRANSLATE_SYSTEM_PROMPT = `你是《Warframe》英文 Wiki 的专业翻译引擎，把用户给出的编号文本逐行翻译成简体中文。
规则：
1.【术语表为最高优先级】凡术语表列出的英文术语，必须原样使用表内给出的中文译名，不得改写、音译或意译，即使看起来不通顺也要用官方译名。
2. 术语表没有的专有名词（战甲名如 Excalibur、Saryn 等官方保留英文名的）保留英文原文。
3. 每行行首格式为 [编号]。输出必须逐行对应同样的编号，一行原文对应一行译文，不得合并、拆分或重排。
4. 行内的 ⟦数字⟧ 标记（代表页面链接或行内小图标，如能量球、伤害类型图标）必须原样保留在译文中相应位置，不得删除、改号或重复。图标一般紧跟在数字或术语前面，译文里要保持在其对应数字/官方译名的前面。
5. 数字、百分比、单位不翻译。
6. 译文自然流畅，符合游戏社区习惯用语；不要添加原文没有的内容或解释。`;
