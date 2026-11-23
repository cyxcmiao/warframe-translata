/**
 * dom.ts — wiki 页面正文抽取
 *
 * 只取 #mw-content-text 内的文本块（p/li/h1-h6/td/th/figcaption/...），
 * 跳过编辑链接、代码块、参考资料等区域（navbox 底部导航盒参与翻译：
 * 懒翻译 + 词典终局使其成本可控，且其内容是用户会读的索引信息）。
 * 行内链接 token 化为 ⟦n⟧（翻译时占位，渲染时还原成 <a>）。
 * 行内小图标（能量球/伤害类型等）同样 token 化，渲染时克隆还原。
 */
import { makeToken, tokenRegex } from '../shared/const';

export interface LinkRef {
  id: number;
  href: string;
  text: string;
}

export interface IconRef {
  /** 已克隆好的图标节点（span[mw:File] 包装或 img 本身） */
  el: HTMLElement;
  /** 裸 img 包在链接里时记录，渲染时补 <a>（mw:File 包装自带内层 <a>，无需此项） */
  href?: string;
}

export type BlockKind = 'block' | 'cell' | 'link';

export interface RawBlock {
  id: string;
  el: HTMLElement | null;
  kind: BlockKind;
  text: string;
  links: Map<number, LinkRef>;
  icons: Map<number, IconRef>;
  /** cell 块：宿主内序列化中断点（首个被拆出去的嵌套块），译文插到它之前而非宿主末尾 */
  beforeEl?: Element;
}

const BLOCK_SEL = [
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'dd', 'dt', 'figcaption', 'caption', 'blockquote',
  'th', 'td', '.pi-data-value',
  // 商店模板（offeringsBox）的物品名/描述是普通 div 文本，其余采集器覆盖不到
  '.offeringsBoxName', '.offeringsBoxDes',
  // 消息盒模板（mbox）：引言/正文/旁注全是纯 div（.mbox__content__header 等），
  // 不进候选就整盒英文（Buff & Debuff 顶部的维护中/非官方/剧透盒曾漏翻）
  '.mbox__content__header', '.mbox__content__text', '.mbox__content__aside',
  // Tabber 面板（TabberNeue）：正文常为裸内联文本（不包 p），不进候选就永远
  // 没人采集（Nightwatch Corps 页 Brunt Lancer 等面板整段英文）；包 p 的部分
  // 由 BLOCKISH 中断拆给 p 自己，面板只序列化裸文本，不重复采集
  '.tabbertab',
  // 评论插件（Yappin）的正文容器，滚动后由前端注入
  '.comment-body', '.comment-text',
].join(',');

const SKIP_SEL = [
  'script', 'style', 'pre', 'code', 'kbd', 'samp', 'textarea',
  '.mw-editsection', 'sup.reference', '.mw-references-wrap', '.reference',
  '.catlinks', '.printfooter', '.mw-cite-backlink',
  '.noprint', '.ambox', '.mbox-small', '.toccolours', '.mw-highlight',
  '#siteNotice', '.page-footer', '.page-header', '.article-footer',
  '.selflink', '.mw-empty-elt', '.navbox-styles', '.module-shortcutboxplain',
  '.mw-jump-link', '.notaninfobox', '.error', '.previewnote',
  // wiki 悬浮提示（Tooltip 扩展）的隐藏仓库: 内容在 hover 时由站点 JS 移入
  // #tooltip-wrapper 浮层，届时 MutationObserver 增量采集按需翻译——预翻全被
  // 0 高容器裁剪（IO 永不相交）且 hover 移动后会被 doneEls 去重吞掉
  '#tooltip-storage',
  // Tabber 的 tab 导航条（站点 JS 运行时生成）：交互式 UI，译文块插进 <li> 会
  // 撑爆 tab 栏长出一条假 tab；tab 内容面板（.tabbertab）照常采集翻译
  '.tabbernav',
  // 搜索框中文术语候选（searchbox 注入进站点建议下拉的条目）：主文本就是
  // 中文，被采集会产生英文→假译名的回环
  '.tw-zh-item',
].join(',');

/** 这些块级元素在行内序列化时中断（它们自己会被单独采集） */
const BLOCKISH = new Set(['UL', 'OL', 'TABLE', 'P', 'DIV', 'BLOCKQUOTE', 'DL', 'SECTION', 'ASIDE']);

/** 用户评论区（Yappin 挂载点）—— 可通过设置整体跳过 */
export const COMMENTS_ROOT_SEL = '#ext-comments-container';

export function findContentRoot(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('#mw-content-text .mw-parser-output') ||
    document.querySelector<HTMLElement>('#mw-content-text') ||
    document.querySelector<HTMLElement>('main') ||
    document.body
  );
}

/**
 * 页面大标题（Vector 的 h1#firstHeading / Fandom 的 .page-header__title）。
 * 在 #mw-content-text 之外（正文根采集不到；Fandom 下 .page-header 还整体在
 * SKIP_SEL 里），须由 collectAndEnqueue 显式补采。标题是纯文本（无链接/图标），
 * 直接构造 RawBlock，不经过 collectBlocks。
 */
export function collectPageTitle(): RawBlock | null {
  const el = document.querySelector<HTMLElement>('#firstHeading, .page-header__title');
  if (!el) return null;
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text.length < 2 || !/[A-Za-z]/.test(text)) return null;
  return { id: 't0', el, kind: 'block', text, links: new Map(), icons: new Map() };
}

/** 行内小图标的最大尺寸（px），超过视为正文插图不当作图标 */
const ICON_MAX_PX = 64;

/** 全页唯一 token 序号：首屏与增量采集（评论区等）共用，保证 ⟦n⟧ 永不冲突 */
let globalTokenSeq = 0;

class Collector {
  links = new Map<number, LinkRef>();
  icons = new Map<number, IconRef>();
  /** 本块序列化期间的中断点（BLOCKISH 拆出子块的元素），文档序 */
  cutEls: Element[] = [];

  /**
   * 判断元素是否为"纯图标包装"：本身是图标（img/svg/mw:File span），
   * 或仅包裹单个图标且无可见文字（如 <a><img></a>）。
   * 像tooltip span（图标+链接文字）这种混合内容不能整体 token 化，
   * 否则会吞掉链接文字 —— 应递归展开为 图标token + 链接token。
   */
  private iconNode(e: HTMLElement): HTMLElement | null {
    if (/^(IMG|SVG)$/.test(e.tagName)) return this.isSmallIcon(e) ? e : null;
    if (e.tagName === 'SPAN' && /(?:^|\s)mw:File/.test(e.getAttribute('typeof') || '')) {
      return this.isSmallIcon(e) ? e : null;
    }
    // 无可见文字才可能是纯图标包装
    const text = (e.textContent || '').replace(/\s+/g, '');
    if (text) return null;
    const file = e.querySelector<HTMLElement>('span[typeof*="mw:File"]');
    const imgs = e.querySelectorAll('img, svg');
    if (file && imgs.length === 1 && file.contains(imgs[0])) {
      return this.isSmallIcon(file) ? file : null;
    }
    if (imgs.length === 1) {
      return this.isSmallIcon(imgs[0] as HTMLElement) ? (imgs[0] as HTMLElement) : null;
    }
    return null;
  }

  /** 小尺寸才当作行内图标（≤64px），避免把正文插图克隆进译文 */
  private isSmallIcon(node: Element): boolean {
    const el = /^(IMG|SVG)$/.test(node.tagName) ? node : (node.querySelector('img, svg') ?? node);
    const w = parseInt(el.getAttribute('width') || '', 10);
    const h = parseInt(el.getAttribute('height') || '', 10);
    if (Number.isFinite(w) && w > ICON_MAX_PX) return false;
    if (Number.isFinite(h) && h > ICON_MAX_PX) return false;
    if (!Number.isFinite(w) && !Number.isFinite(h)) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (!r.width || !r.height || r.width > ICON_MAX_PX || r.height > ICON_MAX_PX) return false;
    }
    return true;
  }

  serialize(el: Node): string {
    let out = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += (child.textContent || '').replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const e = child as HTMLElement;
      const tag = e.tagName;
      if (tag === 'BR') { out += ' '; continue; }
      // 行内小图标（能量球/伤害类型等）: 记占位符，渲染时克隆还原
      const icon = this.iconNode(e);
      if (icon) {
        const id = ++globalTokenSeq;
        // mw:File 包装自带内层 <a>；裸 img 才需要渲染时补外层链接
        const bare = /^(IMG|SVG)$/.test(icon.tagName);
        this.icons.set(id, {
          el: icon.cloneNode(true) as HTMLElement,
          href: bare ? ((e.closest('a') as HTMLAnchorElement | null)?.href || undefined) : undefined,
        });
        out += makeToken(id);
        continue;
      }
      if (/^(IMG|SVG|AUDIO|VIDEO|IFRAME|INPUT|BUTTON)$/.test(tag)) continue;
      if (tag === 'SUP' && e.classList.contains('reference')) continue;
      if (tag === 'A') {
        const text = (e.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) {
          // 图片链接等无文字链接: 递归取内层图标
          out += this.serialize(e);
          continue;
        }
        const id = ++globalTokenSeq;
        this.links.set(id, { id, href: (e as HTMLAnchorElement).href || '', text });
        out += makeToken(id);
        continue;
      }
      if (BLOCKISH.has(tag)) {
        // 嵌套块单独采集；但若该块内部没有任何可采集后代（如 navbox 列表单元格的
        // <td><div>链接•链接</div></td> 包装），中断会让整块内容随 DIV 丢失——
        // 此时按行内内容透传。含可采集后代（table/li 等）仍中断，防双重采集。
        // P 无条件中断：p 自身是采集候选，在 td/li 等宿主里透传会让宿主级译文把
        // 各 p 的内容整段复读（ability-box 信息框 = 标题内联 + 描述 p + introduced p，
        // 渲染成 3 段重复译文）；中断后宿主块只剩 p 之外的行内内容（如物品标题）。
        // 本扩展插入的译文块（.tw-tr）绝不透传：重采集（补翻重试）时会把旧译文当源文本
        if (!e.classList.contains('tw-tr') && !e.closest('.tw-tr') && tag !== 'P' && !e.querySelector(BLOCK_SEL)) {
          out += this.serialize(e);
        } else {
          this.cutEls.push(e); // 中断点：宿主行内前奏的译文应插到它之前（见 RawBlock.beforeEl）
        }
        continue;
      }
      out += this.serialize(e);
    }
    return out;
  }
}

/** 拆句: 长段落按句子切开，逐句对应翻译（沉浸式翻译风格） */
export function splitSentences(text: string, minLen = 40): string[] {
  const enders = new Set(['.', '!', '?']);
  const abbrev = /(?:Mr|Mrs|Ms|Dr|Prof|vs|etc|e\.g|i\.e|approx|No|Vol|Ch|Jr|Sr)\.$/i;
  const parts: string[] = [];
  let start = 0;
  let lastCut = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!enders.has(c)) continue;
    // 后面必须跟空白 + 大写/数字/引号/占位符
    let j = i + 1;
    while (j < text.length && text[j] === ' ') j++;
    if (j === i + 1) continue; // 无空格（如 "e.g." 后直接字符）
    const next = text[j];
    if (!next || !/^[A-Z0-9"“⟦(]$/.test(next)) continue;
    const seg = text.slice(lastCut, i + 1);
    if (seg.trim().length < minLen || abbrev.test(seg.trim())) continue;
    parts.push(text.slice(start, i + 1).trim());
    start = j;
    lastCut = j;
    i = j - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : [text];
}

export interface CollectResult {
  blocks: RawBlock[];
  /** token id → link（跨块共享） */
  allLinks: Map<number, LinkRef>;
}

export function collectBlocks(
  root: HTMLElement,
  opts: { blockIdBase?: string; skipComments?: boolean } = {},
): CollectResult {
  const base = opts.blockIdBase ?? '';
  const blocks: RawBlock[] = [];
  const col = new Collector();
  // 增量采集时 root 本身可能就是可翻译块（如 .comment-body）
  const rootInComment = opts.skipComments && !!root.closest(COMMENTS_ROOT_SEL);
  const rootIsBlock = !rootInComment && root.matches(BLOCK_SEL) && !root.closest(SKIP_SEL);
  const candidates = rootIsBlock
    ? [root, ...root.querySelectorAll<HTMLElement>(BLOCK_SEL)]
    : [...root.querySelectorAll<HTMLElement>(BLOCK_SEL)];
  let idx = 0;

  for (const el of candidates) {
    if (el.closest(SKIP_SEL)) continue;
    if (opts.skipComments && el.closest(COMMENTS_ROOT_SEL)) continue;
    // 嵌套块（li 里套 ul、td 里套 table）不整块序列化，子块会单独采集
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      if (el.querySelector('table')) continue;
    }
    if (el.tagName === 'LI' && el.querySelector('ul, ol')) {
      // 只序列化 li 自身行内内容 —— serialize 的 BLOCKISH 中断会自动跳过嵌套列表
    }
    const links = new Map<number, LinkRef>();
    const icons = new Map<number, IconRef>();
    const savedLinks = col.links;
    const savedIcons = col.icons;
    col.links = links;
    col.icons = icons;
    col.cutEls = [];
    let text = col.serialize(el).trim();
    const firstCut = col.cutEls[0] ?? undefined;
    col.links = savedLinks;
    col.icons = savedIcons;
    // 合并前从全局链接表注册
    for (const l of links.values()) {
      if (!savedLinks.has(l.id)) savedLinks.set(l.id, l);
    }
    for (const [id, ic] of icons) {
      if (!savedIcons.has(id)) savedIcons.set(id, ic);
    }
    // 纯占位符块: 容器（表头/目录项等）里只有链接、无自属字母文字（含
    // "⟦1⟧ ⟦2⟧ 250%" 这类 链接+纯数字 组合）。不能丢 —— 链接块拿到译名后按
    // cell 渲染进容器（Rank 这类表头、目录条目、"Enemy Health 250%" 修饰列表）
    const visible = text.replace(tokenRegex, '').trim();
    const pureLink = !/[A-Za-z]/.test(visible) && [...links.values()].some(l => /[A-Za-z]/.test(l.text));
    if (!pureLink) {
      if (text.length < 2 || !/[A-Za-z]/.test(text)) continue;
      // 跳过 JSON/数据块（模板内嵌数据、Lua 表等）
      if (/^\s*[\[{]/.test(text) && /":/.test(text)) continue;
      if (visible.length < 2) continue;
    }

    // tabbertab 面板按 cell 渲染：译文块插进面板内部（appendChild/首个嵌套块前），
    // 显隐跟随面板；按 block 渲染会插到面板后面，落在 tabber 结构外永远可见
    const kind: BlockKind = pureLink || el.tagName === 'TD' || el.tagName === 'TH' || el.classList.contains('pi-data-value') || el.classList.contains('tabbertab')
      ? 'cell'
      : 'block';

    // 长段落拆句
    if (kind === 'block' && text.length > 320 && !tokenRegex.test(text)) {
      const sents = splitSentences(text);
      if (sents.length > 1) {
        sents.forEach((s, k) => {
          blocks.push({ id: `${base}b${idx}s${k}`, el, kind: 'block', text: s, links, icons });
        });
        idx++;
        continue;
      }
    }
    // cell 块记录首个中断点：宿主的行内内容（ability-box 标题等）译文插到
    // 被拆出的首个嵌套块之前，而不是追加到宿主末尾（位置远离源文本）。
    // tabbertab 例外：面板首个 BLOCKISH 子节点常是空的 mw-empty-elt 占位 p，
    // 用它做 beforeEl 会把译文插到面板最顶上（原文之上）——面板译文固定放末尾
    blocks.push({ id: `${base}b${idx}`, el, kind, text, links, icons, beforeEl: kind === 'cell' && !el.classList.contains('tabbertab') ? firstCut : undefined });
    idx++;
  }

  // 链接文本块（放在最前翻译，渲染段落时要用）
  const linkBlocks: RawBlock[] = [];
  const seenLink = new Set<number>();
  for (const l of col.links.values()) {
    if (seenLink.has(l.id) || !l.text) continue;
    seenLink.add(l.id);
    if (l.text.length < 2 || !/[A-Za-z]/.test(l.text)) continue;
    const links = new Map<number, LinkRef>([[l.id, l]]);
    linkBlocks.push({ id: `l${l.id}`, el: null, kind: 'link', text: l.text, links, icons: new Map() });
  }

  return { blocks: [...linkBlocks, ...blocks], allLinks: col.links };
}
