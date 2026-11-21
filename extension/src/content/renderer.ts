/**
 * renderer.ts — 沉浸式双语渲染
 *
 * 段落/标题: 译文块插在原文正下方（.tw-tr）
 * 表格单元格/信息框: 译文追加在单元格内部（不动原图标与链接）
 * 链接: 译文中的 ⟦n⟧ 还原为 <a>，链接文字用翻译结果
 * 行内小图标: 译文中的 ⟦n⟧ 还原为采集时克隆的图标节点
 */
import { tokenRegex } from '../shared/const';
import type { RawBlock } from './dom';
import type { BlockOut } from '../shared/types';

/** token id → 链接译文 */
export type LinkTexts = Map<number, string>;

export function buildTranslatedFragment(text: string, links: RawBlock['links'], icons: RawBlock['icons'], linkTexts: LinkTexts): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(tokenRegex)) {
    const idx = m.index ?? 0;
    if (idx > last) frag.append(text.slice(last, idx));
    const id = Number(m[1]);
    const link = links.get(id);
    const icon = icons.get(id);
    if (icon) {
      const node = icon.el.cloneNode(true) as HTMLElement;
      if (icon.href) {
        const a = document.createElement('a');
        a.href = icon.href;
        a.append(node);
        frag.append(a);
      } else {
        frag.append(node);
      }
    } else {
      const shown = linkTexts.get(id) ?? link?.text ?? '';
      if (link?.href) {
        const a = document.createElement('a');
        a.href = link.href;
        a.textContent = shown || link.text;
        frag.append(a);
      } else {
        frag.append(shown);
      }
    }
    last = idx + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/** 生成译文节点；无有效译文（词典无命中/原样返回）时返回 null 不插入 */
export function renderResult(rec: RawBlock, out: BlockOut | undefined, linkTexts: LinkTexts): HTMLElement | null {
  if (!out?.ok || !out.translation) return null;
  // AI 失败回退块：即使块内链接有译名也不渲染——"原文+译名链接"看起来像翻了一半，
  // 实际整块没翻（宿主已进补翻重试队列，滚动/重开会话时补翻）
  if (out.failed) return null;
  const tr = out.translation.trim();
  const hasTranslatedLinks = [...rec.links.keys()].some(id => linkTexts.has(id));
  // 词典模式：译文与原文相同（无裸词命中）时，若块内链接文字有官方译名，
  // 仍渲染该块 —— 译文行里链接会显示中文（如 显赫刀剑），否则跳过避免噪音
  if (!tr || (tr === rec.text.trim() && !hasTranslatedLinks)) return null;
  const div = document.createElement('div');
  div.className = 'tw-tr' + (rec.kind === 'cell' ? ' tw-tr-cell' : '');
  // 镜像宿主对齐：navbox 表格等 text-align:center 容器里，译文若保持默认左对齐，
  // 会与居中的原文错位（首词贴到单元格左缘、其余悬在半空）。
  // 左对齐宿主不动，维持色条缩进样式
  const hostAlign = rec.el ? getComputedStyle(rec.el).textAlign : '';
  if (hostAlign === 'center' || hostAlign === 'right' || hostAlign === 'end') {
    div.classList.add('tw-tr-mirror');
    div.style.textAlign = hostAlign;
  }
  div.dataset.twMode = out.viaAI ? 'ai' : 'dict';
  div.dataset.twId = rec.id;
  div.append(buildTranslatedFragment(tr, rec.links, rec.icons, linkTexts));
  return div;
}

let lastNode = new WeakMap<Element, Element>();
/** 宿主 el → 已插入的译文节点（快捷键隐藏后重新显示时，按宿主精准移除重试块的旧渲染，防重复插入） */
let hostRenders = new WeakMap<Element, HTMLElement[]>();

/** el 的第一个直接子级块元素（嵌套列表/表格等） */
function firstBlockChild(el: HTMLElement): Element | null {
  for (const child of el.children) {
    if (/^(UL|OL|TABLE|BLOCKQUOTE|DL|DIV|P|SECTION|ASIDE)$/.test(child.tagName) && !child.classList.contains('tw-tr')) {
      return child;
    }
  }
  return null;
}

export function insert(div: HTMLElement, rec: RawBlock): void {
  if (!rec.el || !rec.el.isConnected) return;
  if (rec.kind === 'cell') {
    // 采集时记录的嵌套块中断点（ability-box 标题等行内前奏）：译文插到它之前，
    // 与源文本相邻；否则纯链接 li（目录项等）嵌套子列表时，插在自身文字之后、
    // 子列表之前；都没有才追加到宿主末尾
    if (rec.beforeEl && rec.beforeEl.isConnected) rec.beforeEl.insertAdjacentElement('beforebegin', div);
    else if (rec.el.tagName === 'LI' && firstBlockChild(rec.el)) firstBlockChild(rec.el)!.insertAdjacentElement('beforebegin', div);
    else rec.el.appendChild(div);
  } else {
    const prev = lastNode.get(rec.el);
    if (prev && prev.isConnected) {
      prev.after(div); // 同一宿主的多个译文（长段拆句）保持先后顺序
    } else if (firstBlockChild(rec.el)) {
      // li 内嵌套子列表时，译文必须插在自身文字之后、嵌套块之前，
      // 否则 afterend 会落到整个嵌套列表后面，造成译文错位
      firstBlockChild(rec.el)!.insertAdjacentElement('beforebegin', div);
    } else {
      rec.el.insertAdjacentElement('afterend', div);
    }
  }
  const arr = hostRenders.get(rec.el);
  if (arr) arr.push(div);
  else hostRenders.set(rec.el, [div]);
  lastNode.set(rec.el, div);
}

/** 移除某个宿主的全部已渲染译文（补翻重试前调用，避免拆句块重复插入） */
export function removeHostRenders(host: Element): void {
  for (const d of hostRenders.get(host) ?? []) d.remove();
  hostRenders.delete(host);
  lastNode.delete(host);
}

export function resetInsertState(): void {
  lastNode = new WeakMap();
  hostRenders = new WeakMap();
}

export function clearTranslations(): void {
  resetInsertState();
  document.querySelectorAll('.tw-tr').forEach(n => n.remove());
}
