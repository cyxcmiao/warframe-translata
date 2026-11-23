/**
 * userterms.ts — 自定义词表编辑文本的解析 / 序列化（纯函数，无环境依赖，便于单测）
 *
 * 格式：一行一条「英文, 中文」。
 * 分隔符 = 行内**最后一个未转义的英文逗号**：
 *  - 英文名本身含英文逗号时无需转义——分隔符之前整段都算英文
 *    （如 `Bounty, Tier 5, 赏金任务5阶` → en = `Bounty, Tier 5`）；
 *  - 中文译文里若要写英文逗号，转义为 `\,`（如 `buff, 增益\, 强化` → zh = `增益, 强化`）；
 *    `\\` 表示字面反斜杠。中文逗号 `，` 不参与分隔，译文里可随意使用。
 *  - 整行没有英文逗号时容忍中文逗号 `，` 作分隔（取第一个——中文标点常出现在译文内部）。
 *  - `#` 开头的行是注释；空行忽略；缺分隔符或缺中文的行计入 bad（编辑端提示后忽略）。
 */

export interface ParsedUserTerms {
  terms: Record<string, string>;
  bad: string[];
}

/** 反转义：`\,` → `,`，`\\` → `\` */
function unescape(s: string): string {
  return s.replace(/\\([,\\])/g, '$1');
}

/** 序列化转义：反斜杠一律双写；zh 里的英文逗号转义（en 里的逗号由分隔符规则天然容纳） */
function escEn(en: string): string {
  return en.replace(/\\/g, '\\\\');
}
function escZh(zh: string): string {
  return zh.replace(/\\/g, '\\\\').replace(/,/g, '\\,');
}

/** 解析编辑文本 → 词条表 + 无效行（无效行不产生任何词条，尤其不产生删除效果） */
export function parseUserTermsText(text: string): ParsedUserTerms {
  const terms: Record<string, string> = {};
  const bad: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // 从右往左找第一个未转义的英文逗号（反斜杠转义的逗号跳过）
    let sep = -1;
    for (let i = line.length - 1; i >= 0; i--) {
      if (line[i] === ',') {
        // 数清前面连续的反斜杠：偶数个 = 未转义
        let bs = 0;
        for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) bs++;
        if (bs % 2 === 0) {
          sep = i;
          break;
        }
      }
    }
    if (sep < 0) {
      // 没有英文逗号：容忍中文逗号作分隔（取第一个，译文内部的中文逗号不受影响）
      const fw = line.indexOf('，');
      if (fw < 0) {
        bad.push(line);
        continue;
      }
      sep = fw;
    }

    const en = unescape(line.slice(0, sep)).trim();
    const zh = unescape(line.slice(sep + 1)).trim();
    if (!en || !zh) {
      bad.push(line);
      continue;
    }
    terms[en] = zh;
  }
  return { terms, bad };
}

/** 词条表 → 编辑文本（按英文码点序，确定性回显；含逗号/反斜杠的译文自动转义） */
export function serializeUserTerms(terms: Record<string, string>): string {
  return Object.entries(terms)
    .sort((a, b) => {
      const ka = a[0].toLowerCase();
      const kb = b[0].toLowerCase();
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .map(([en, zh]) => `${escEn(en)}, ${escZh(zh)}`)
    .join('\n');
}
