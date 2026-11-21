# -*- coding: utf-8 -*-
"""fix_conflicts.py — 用外部 UserDict 仲裁 glossary_conflicts.csv 冲突

数据源: E:\\cyxc\\游戏\\warframe\\中英文对照表\\UserDict.csv（zh-hans,en 两列，UTF-8 BOM）
        用户人工维护的权威对照表——【只读，不复制进仓库、不上传、不提交】
输出:   1. 可仲裁条目 → data/manual_overrides.json（与既有条目合并，UserDict 优先）
        2. 无法仲裁条目 → glossary_conflicts_unresolved.csv（含原因列，供人工复核）

用法: python -I tools/fix_conflicts.py
"""
import json, csv, re, sys

USERDICT = r'E:\cyxc\游戏\warframe\中英文对照表\UserDict.csv'
CONFLICTS = 'glossary_conflicts.csv'
UNRESOLVED = 'glossary_conflicts_unresolved.csv'
OVERRIDES = 'data/manual_overrides.json'

# en 侧裸词而 zh 带尾缀消歧括号 → 内部标记非显示文本，不可直接采用
DISAMB = re.compile(r'[（(][^）)]*[）)]$')


def load_ud():
    ud = {}
    with open(USERDICT, encoding='utf-8-sig', newline='') as f:
        r = csv.reader(f)
        header = next(r, None)
        for zh, en in ((row[0].strip(), row[1].strip()) for row in r if len(row) >= 2):
            if zh and en:
                ud.setdefault(en.lower(), {}).setdefault(zh, None)
    return ud


def main():
    ud = load_ud()
    print(f'UserDict: {sum(len(v) for v in ud.values())} 行 → {len(ud)} 个 en 键')

    overrides = json.load(open(OVERRIDES, encoding='utf-8'))
    existing = dict(overrides)
    rows = list(csv.reader(open(CONFLICTS, encoding='utf-8-sig')))
    head, rows = rows[0], rows[1:]

    fixed, verified, unresolved = [], [], []
    for r in rows:
        en, final_zh = r[1], r[10]
        cands = ud.get(en.lower())
        if not cands:
            unresolved.append(r + ['UserDict 无此词条'])
        elif len(cands) > 1:
            unresolved.append(r + ['UserDict 内多译名: ' + ' / '.join(sorted(cands))])
        else:
            zh_ud = next(iter(cands))
            if '(' not in en and '（' not in en and DISAMB.search(zh_ud):
                unresolved.append(r + ['UserDict 译名含消歧括号: ' + zh_ud])
            elif zh_ud == final_zh:
                verified.append((en, zh_ud, r[0]))
            else:
                overrides[en] = zh_ud
                fixed.append((en, final_zh, zh_ud, r[0], r[11]))

    # UserDict 与既有覆盖条目不一致时以 UserDict 为准（日志提示）
    for en in list(overrides):
        if en in existing and overrides[en] != existing[en]:
            print(f'覆盖条目被 UserDict 改写: {en}: {existing[en]} -> {overrides[en]}')

    with open(OVERRIDES, 'w', encoding='utf-8') as f:
        json.dump(dict(sorted(overrides.items(), key=lambda kv: kv[0].lower())), f, ensure_ascii=False, indent=2)
        f.write('\n')

    with open(UNRESOLVED, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(head + ['note'])
        w.writerows(unresolved)

    from collections import Counter
    print(f'已修复(写入覆盖层): {len(fixed)}  已验证(现值即UserDict值): {len(verified)}  无法仲裁: {len(unresolved)}')
    print('无法仲裁按类型:', dict(Counter(r[0] for r in unresolved)))
    print('\n--- 修复样例(最多15) ---')
    for en, old, new, typ, layer in fixed[:15]:
        print(f'  [{typ}] {en}: {old}({layer}) -> {new}')
    print('\n--- 已验证样例(最多10) ---')
    for en, zh, typ in verified[:10]:
        print(f'  [{typ}] {en} == {zh}')
    # UserDict 自身多译名统计
    amb = [(k, sorted(v)) for k, v in ud.items() if len(v) > 1]
    print(f'\nUserDict 内部同名多译: {len(amb)} 条（本次冲突中涉及的已列入无法仲裁）')


if __name__ == '__main__':
    main()
