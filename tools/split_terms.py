# -*- coding: utf-8 -*-
"""split_terms.py — 术语拆分候选生成器（2026-11-21）

背景：官方/语言层词表按游戏实体整名收录（Anti Moa Purple / Demolisher Anti Moa /
Vapos Anti Moa），Wiki 页面却常出现去掉前后缀的裸名（Anti Moa），词表无此条目则不翻译。

做法：
  1. 对每个多词条目枚举连续词子序列（不含整名本身），排除词表/覆盖层/机制表已有 key
     与 retained 名单；
  2. 只保留出现在 >=2 个不同条目中的候选；
  3. 译名建议 = 所有包含条目译名的公共子串（LCS 逐对折叠），公共片段 <2 字视为无建议；
  4. 冗余剔除：候选与包含它的更长候选建议相同时丢弃短者（Anti/Anti Moa 同为“逆进恐鸟”，
     Anti 是噪声；Moa 同理——其真实译名“恐鸟”无法从这三条可靠推出）；
  5. 复数噪声剔除：单词候选以 s 结尾且去 s 后也是候选则丢弃（Demolishers/Demolisher，
     匹配器本身自动处理复数）。

产出 glossary_split_candidates.csv（审核用），通过项写入 data/manual_overrides.json
（新增 key 会进入 mergeGlossaryLayers 生效词表，push 即免发版流转）。

用法: python -I tools/split_terms.py
"""
import csv, json, re

GLOSSARY = 'glossary_export.csv'
OUT = 'glossary_split_candidates.csv'
MIN_COUNT = 2


def lcs2(a, b):
    m, n = len(a), len(b)
    if not m or not n:
        return ''
    dp = [0] * (n + 1)
    best, endi = 0, 0  # endi: a 侧匹配结束下标(0-based inclusive)
    for i in range(1, m + 1):
        prev = 0
        for j in range(1, n + 1):
            cur = dp[j]
            if a[i - 1] == b[j - 1]:
                dp[j] = prev + 1
                if dp[j] > best:
                    best, endi = dp[j], i - 1
            else:
                dp[j] = 0
            prev = cur
    return a[endi - best + 1:endi + 1] if best else ''


def lcs_all(zhs):
    zs = sorted(zhs, key=len)
    com = zs[0]
    for z in zs[1:]:
        com = lcs2(com, z)
        if len(com) < 2:
            return ''
    return com if len(com) >= 2 else ''


def main():
    rows = list(csv.DictReader(open(GLOSSARY, encoding='utf-8-sig')))
    terms = {}
    for r in rows:
        en = ' '.join(r['en'].split())
        if en and en not in terms:
            terms[en] = r['zh']

    overrides = json.load(open('data/manual_overrides.json', encoding='utf-8'))
    mech = json.load(open('data/mechanism_terms.json', encoding='utf-8'))
    de = json.load(open('data/de_names.json', encoding='utf-8'))
    known = {k.lower() for k in list(terms) + list(overrides) + list(mech)}
    retained = {k.lower() for k in de['retained']}

    # 候选 -> {count, evidence}
    cand = {}
    for en in terms:
        words = en.split()
        if len(words) < 2:
            continue
        seen = set()
        for i in range(len(words)):
            for j in range(i + 1, len(words) + 1):
                if j - i == len(words):
                    continue  # 整名本身
                sub = ' '.join(words[i:j])
                low = sub.lower()
                if low in seen or low in known or low in retained:
                    continue
                if not re.search(r'[A-Za-z]', sub):
                    continue
                seen.add(low)
                c = cand.setdefault(low, {'en': sub, 'count': 0, 'ev': [], 'words': j - i})
                c['count'] += 1
                if len(c['ev']) < 3:
                    c['ev'].append(f"{en}\u2192{terms[en]}")

    cand = {k: v for k, v in cand.items() if v['count'] >= MIN_COUNT}

    # 建议译名
    hosts = {}  # low -> [(en, zh), ...] 完整宿主列表（供冗余比对）
    for en, zh in terms.items():
        words = en.split()
        for i in range(len(words)):
            for j in range(i + 1, len(words) + 1):
                if j - i == len(words):
                    continue
                hosts.setdefault(' '.join(words[i:j]).lower(), []).append((en, zh))

    for low, c in cand.items():
        c['zh'] = lcs_all([zh for _, zh in hosts[low]])

    # 冗余剔除：建议相同且词序列为其连续子序列的更短候选丢弃
    by_sugg = {}
    for low, c in cand.items():
        if c['zh']:
            by_sugg.setdefault(c['zh'], []).append(low)
    drop = set()
    for sugg, lows in by_sugg.items():
        lows.sort(key=lambda k: -cand[k]['words'])
        for i, a in enumerate(lows):
            aw = a.split()
            for b in lows[:i]:
                bw = cand[b]['en'].split()
                # a 是否为 b 的连续词子序列
                for s in range(len(bw) - len(aw) + 1):
                    if [w.lower() for w in bw[s:s + len(aw)]] == aw:
                        drop.add(a)
                        break

    # 复数噪声：单词候选以 s 结尾且去 s 后也是候选
    for low in list(cand):
        c = cand[low]
        if c['words'] == 1 and low.endswith('s') and low[:-1] in cand:
            drop.add(low)

    rows_out = []
    for low, c in cand.items():
        if low in drop:
            continue
        rows_out.append([c['en'], c['zh'], c['count'], c['words'], ' | '.join(c['ev'])])
    rows_out.sort(key=lambda r: (-r[3], -r[2], r[0].lower()))

    with open(OUT, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['en', 'suggested_zh', 'count', 'words', 'evidence'])
        w.writerows(rows_out)

    multi = sum(1 for r in rows_out if r[3] >= 2)
    print(f"词表条目: {len(terms)} | 原始候选: {len(cand) + len(drop)}")
    print(f"count>={MIN_COUNT} 后: {len(cand)} | 冗余/复数剔除: {len(drop)}")
    print(f"输出: {len(rows_out)} 行（多词 {multi} / 单词 {len(rows_out) - multi}）→ {OUT}")


if __name__ == '__main__':
    main()
