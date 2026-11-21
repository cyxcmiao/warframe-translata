# -*- coding: utf-8 -*-
"""apply_user_verdict.py — 应用用户对 unresolved 冲突的人工裁决（2026-11-21）

规则（用户指令）:
  1. 清单内的词条按清单值写入 data/manual_overrides.json（与现值相同也写入，锁定防语言层重建平票翻转）；
     zh === en 表示锁定保留英文。
  2. unresolved 里未提及的词条 → 覆盖层写空串，运行时合并层将其从生效词表删除
     （glossary.ts mergeGlossaryLayers 过滤空值），交 AI 语境兜底。

用法: python -I tools/apply_user_verdict.py
"""
import json, csv

USER_VERDICT = {
    'Accessibility': '无障碍', 'Agent': '间谍', 'Beacon': '信标', 'Citrine Prime': 'Citrine Prime',
    'Combo': '连击', 'Commander': '指挥官', 'Complete Quest: Heart of Deimos': '完成系列任务：《惊惧之心》',
    'Corpus': 'Corpus', 'CORPUS INTERIOR DECORATIONS': 'CORPUS 内部装饰', 'Cressa Tal': 'Cressa Tal',
    'Dig': '挖掘', 'Ember': 'Ember', 'Excalibur': 'Excalibur', 'Forma Cache': 'Forma 储藏箱',
    'Frost': 'Frost', 'Grineer': 'Grineer', 'Helminth': 'Helminth', 'Infested': 'Infested',
    'Jade': 'Jade', 'LISET VERV SKIN': 'LISET 热忱外观', 'Liset Verv Skin': 'Liset 热忱外观',
    'Loki': 'Loki', 'Lotus': 'Lotus', 'Lotus Symbol Glyph': 'Lotus 标志浮印', 'Mag': 'Mag',
    'Margulis': 'Margulis', 'Natah': 'Natah', 'Nekros': 'Nekros', 'Nyx': 'Nyx', 'Octavia': 'Octavia',
    'Palladino': 'Palladino', 'Phoenix Intercept': '凤凰拦截行动', 'POTENCY': '效价',
    'Radiator': '散热器', 'Rhino': 'Rhino', 'Sacrifice': '牺牲', 'Sanctuary': '圣殿',
    'Statuette - Thousand-Year Fish': '千年灵鱼小雕像', 'Tenno': 'Tenno',
    'The Triumph of Dust': '尘埃的胜利', 'TICKER': 'TICKER', 'Trinity': 'Trinity',
    'Undying': '不朽', 'VARIANT': '变体', 'Volt': 'Volt',
}
VERDICT = {k.lower(): v for k, v in USER_VERDICT.items()}


def main():
    de = json.load(open('data/de_names.json', encoding='utf-8'))
    retained = {r.lower() for r in de['retained']}
    rows = list(csv.reader(open('glossary_conflicts_unresolved.csv', encoding='utf-8-sig')))[1:]
    unresolved = {}
    for r in rows:
        unresolved.setdefault(r[1], []).append(r)

    overrides = json.load(open('data/manual_overrides.json', encoding='utf-8'))
    before = dict(overrides)
    applied, deleted, changed_existing, retained_skipped = [], [], [], []

    for en in unresolved:
        low = en.lower()
        if low in VERDICT:
            v = VERDICT[low]
            if v.lower() == low and low in retained:
                # 官方 retained 名单已锁定保留英文（主词表不含它），写覆盖层反而把它塞回主词表
                retained_skipped.append(en)
                continue
            if en in before and before[en] != v:
                changed_existing.append((en, before[en], v))
            overrides[en] = v
            applied.append((en, v))
        else:
            overrides[en] = ''  # 删除语义

    mech = json.load(open('data/mechanism_terms.json', encoding='utf-8'))
    nuked_mech = [en for en in overrides if overrides[en] == '' and en in mech]

    with open('data/manual_overrides.json', 'w', encoding='utf-8') as f:
        json.dump(dict(sorted(overrides.items(), key=lambda kv: kv[0].lower())), f, ensure_ascii=False, indent=2)
        f.write('\n')

    n_lock = sum(1 for en, v in applied if v.lower() != en.lower())
    n_keep_en = len(applied) - n_lock
    print(f'应用裁定: {len(applied)} 条（译名锁定 {n_lock} / 保留英文 {n_keep_en}）')
    print(f'retained 已锁定故跳过覆盖层: {len(retained_skipped)} 条: {", ".join(sorted(retained_skipped))}')
    print(f'删除词条: {sum(1 for v in overrides.values() if v == "")} 条（空串删除语义）')
    print(f'覆盖层总数: {len(before)} -> {len(overrides)}')
    if changed_existing:
        print('与既有覆盖条目冲突（以用户清单为准）:')
        for en, old, new in changed_existing:
            print(f'  {en}: {old} -> {new}')
    if nuked_mech:
        print('⚠️ 删除词条命中机制表:', nuked_mech)
    json.load(open('data/manual_overrides.json', encoding='utf-8'))
    print('JSON 校验通过')


if __name__ == '__main__':
    main()
