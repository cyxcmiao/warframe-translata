/**
 * layers.ts — 词表分层的纯合并逻辑（无环境依赖，便于单测）
 *
 * 优先级从低到高：机制表 < 语言文件层 < 官方词表 < 人工覆盖层（远程仲裁）< 用户自定义（本机）。
 *  - 官方已有译名的条目以官方为准（后展开覆盖）；
 *  - 官方保留英文名（retained，如 Excalibur）即使各补充层里有也删掉，照抄英文才是正确译法；
 *  - 人工覆盖层：明确的人工意图可覆盖官方与 retained 锁定（zh===en 强制保留英文）；
 *    覆盖层 zh 为空串 = 删除词条（人工裁决不收录的争议词不强制译名，交 AI 语境兜底）；
 *  - 用户自定义层最后展开（最高优先级）：本机词表修正一切更早的层，包括官方与覆盖层；
 *    空译名不生效——自定义层不支持删除语义（编辑端即按无效行忽略），空值不会删掉任何词条。
 */

/** 用户层生效词条：空译名/空英文不生效（自定义层没有删除语义，空行在编辑端即被忽略） */
export function effectiveUserTerms(user: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [en, zh] of Object.entries(user)) {
    if (en.trim() && zh && zh.trim()) out[en] = zh;
  }
  return out;
}

/** 五个术语层的原始词条表（en → zh） */
export interface LayerParts {
  /** 机制术语表（人工维护的 wiki 用语） */
  mech: Record<string, string>;
  /** 游戏语言文件挖掘层 */
  lang: Record<string, string>;
  /** 官方 DE 导出词表 */
  official: Record<string, string>;
  /** 人工覆盖层（远程仲裁） */
  overrides: Record<string, string>;
  /** 用户自定义层（本机 IndexedDB，最高优先级） */
  user: Record<string, string>;
}

export function mergeGlossaryLayers(parts: LayerParts, retained: string[]): Record<string, string> {
  const out = { ...parts.mech, ...parts.lang };
  const retainedSet = new Set(retained.map(s => s.toLowerCase()));
  for (const en of Object.keys(out)) {
    if (retainedSet.has(en.toLowerCase())) delete out[en];
  }
  const merged = { ...out, ...parts.official, ...parts.overrides };
  // 用户层是手输文本：空译名不生效（不支持删除），大小写变体键也要压过旧条目
  // （用户写 electricity 也能覆盖官方的 Electricity；否则两个键共存，Trie 先到先得让官方赢）
  const user = effectiveUserTerms(parts.user);
  const userLower = new Set(Object.keys(user).map(k => k.toLowerCase()));
  if (userLower.size) {
    for (const en of Object.keys(merged)) {
      if (Object.hasOwn(user, en)) continue; // 精确同名键由展开直接覆盖
      if (userLower.has(en.toLowerCase())) delete merged[en];
    }
  }
  Object.assign(merged, user);
  for (const en of Object.keys(merged)) {
    if (!merged[en]) delete merged[en];
  }
  return merged;
}

/**
 * 用户层里「中文 === 英文」的词条（强制保留英文，如 Prime = Prime）：
 * 交给 translate 的 retained 匹配器，让词典直译判定把这些英文残留视为合法，
 * 不再白送 AI 一遍。返回 en 列表（保留用户原始写法）。
 */
export function userRetained(user: Record<string, string>): string[] {
  return Object.keys(user).filter(en => {
    const zh = user[en]?.trim();
    return !!zh && zh.toLowerCase() === en.trim().toLowerCase();
  });
}
