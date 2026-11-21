# -*- coding: utf-8 -*-
"""scan_conflicts.py — 术语表撞车检测（一次性审查工具，输出 CSV 供人工复核）

与 tools/build_lang_terms.js 完全同参重挖 tools/cache/lang/{en,zh}.json，检测三类冲突：
  1. lang内同名: *Name key 内部同一 en 值投出多个不同 zh（投票赢家未必正确，平票标记 tie）
  2. Name过滤撞车: 同一 en 在非 *Name key（如 DT_ELECTRICITY_NoIcon→电击）里另有译名，
     build 因 *Name 过滤器看不见——Electricity→电流 误译即此模式
  3. 层间撞车: official / lang / mech 同词不同 zh（运行时 official 覆盖 lang/mech）

用法: python -I tools/scan_conflicts.py   →  输出 glossary_conflicts.csv（UTF-8 BOM）
"""
import json, csv, re, sys
from collections import Counter

ROOT = '..'
sys.path.insert(0, ROOT)

def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)

stoplist = set(load(f'{ROOT}/data/stoplist.json'))
en = load(f'{ROOT}/tools/cache/lang/en.json')
zh = load(f'{ROOT}/tools/cache/lang/zh.json')
de = load(f'{ROOT}/data/de_names.json')
lang_shipped = load(f'{ROOT}/data/lang_terms.json')
mech = load(f'{ROOT}/data/mechanism_terms.json')
override = load(f'{ROOT}/data/manual_overrides.json')
official_terms, retained = de['terms'], de['retained']

# --- 与 build_lang_terms.js 同参过滤器 ---
KEY_RE = re.compile(r"[A-Za-z][A-Za-z0-9'’-]*")

def shape_ok(key, en_val, zh_val):
    if not isinstance(en_val, str) or not isinstance(zh_val, str):
        return False
    if not key.startswith('/Lotus/Language/'):
        return False
    if not zh_val.strip():
        return False
    if '[PH]' in en_val.upper() or '[PH]' in zh_val.upper():
        return False
    words = KEY_RE.findall(en_val)
    if not 1 <= len(words) <= 6 or len(en_val) >= 60 or not KEY_RE.search(en_val):
        return False
    if len(zh_val) >= 30:
        return False
    if len(words) == 1 and en_val.strip().lower() in stoplist:
        return False
    return True

# ① *Name key 内部投票（复现 build 的 byEn）
by_en = {}  # lower -> {en, votes: Counter(有序)}
for key, ev in en.items():
    if not key.endswith('Name'):
        continue
    zv = zh.get(key)
    if not shape_ok(key, ev, zv):
        continue
    rec = by_en.setdefault(ev.strip().lower(), {'en': ev.strip(), 'votes': Counter()})
    rec['votes'][zv.strip()] += 1

lang_win, lang_tie = {}, set()
for low, rec in by_en.items():
    best_zh, best_n = '', 0
    for z, n in rec['votes'].items():
        if n > best_n:
            best_zh, best_n = z, n
    lang_win[low] = (rec['en'], best_zh, rec['votes'])
    if sum(1 for n in rec['votes'].values() if n == best_n) > 1:
        lang_tie.add(low)

# 校验: 重挖赢家应与发行文件一致（缓存与产物不同步则提示）
shipped_lang = {k.strip().lower(): v for k, v in lang_shipped['terms'].items()}
mismatch = sum(1 for low, (_, w, _) in lang_win.items() if low in shipped_lang and shipped_lang[low] != w)

# ② 非 *Name key 的同名异译（仅查已入选词，防噪音）
name_filtered = {}  # lower -> {zh: [keys]}
for key, ev in en.items():
    if key.endswith('Name'):
        continue
    zv = zh.get(key)
    if not shape_ok(key, ev, zv):
        continue
    low = ev.strip().lower()
    if low not in lang_win:
        continue
    name_filtered.setdefault(low, {}).setdefault(zv.strip(), []).append(key)

def sample_keys(keys, n=3):
    return '; '.join(k[:80] for k in keys[:n]) + (';' if len(keys) > n else '')

# ③ 运行时合并（mech < lang < official < override；retained 只过滤 mech/lang）
retained_lower = {r.lower() for r in retained}
final, final_layer = {}, {}
for src, name in [(mech, 'mech'), (shipped_lang, 'lang')]:
    for en_v, zh_v in src.items():
        low = en_v.lower()
        if low in retained_lower:
            continue
        final[low] = zh_v
        final_layer[low] = name
official_lower = {}
for en_v, zh_v in official_terms.items():
    official_lower[en_v.lower()] = (en_v, zh_v)
    final[en_v.lower()] = zh_v
    final_layer[en_v.lower()] = 'official'
for en_v, zh_v in override.items():
    if not zh_v:
        continue  # 空串 = 删除词条（与 glossary.ts mergeGlossaryLayers 空值过滤一致）
    final[en_v.lower()] = zh_v
    final_layer[en_v.lower()] = 'override'

rows = []
def row(type_, en_v, cur_zh, cur_layer, conflict_zh, keys, votes, tie, low):
    o = official_lower.get(low, ('', ''))
    rows.append([type_, en_v, cur_zh, cur_layer, conflict_zh, keys, votes,
                 o[1], shipped_lang.get(low, ''), mech.get(next((k for k in mech if k.lower() == low), ''), ''),
                 final.get(low, ''), final_layer.get(low, ''), tie])

# ① 行: 每个落选 zh 变体一行
for low in sorted(by_en):
    if len(by_en[low]['votes']) < 2:
        continue
    en_v, winner, votes = lang_win[low]
    for z, n in votes.items():
        if z == winner:
            continue
        row('lang内同名', en_v, winner, 'lang', z, '', n, 'tie' if low in lang_tie else '', low)

# ② 行: 每个非 Name 异译 zh 变体一行
for low in sorted(name_filtered):
    winner = lang_win[low][1]
    for z, keys in name_filtered[low].items():
        if z == winner:
            continue
        row('Name过滤撞车', lang_win[low][0], winner, 'lang', z, sample_keys(keys), len(keys), '', low)

# ③ 行: 层间同词不同译（一-en一行）
seen = set()
for low, (en_v, o_zh) in sorted(official_lower.items()):
    l_zh = shipped_lang.get(low)
    m_key = next((k for k in mech if k.lower() == low), None)
    m_zh = mech[m_key] if m_key else None
    vals = [v for v in (o_zh, l_zh, m_zh) if v is not None]
    if len(set(vals)) < 2 or low in seen:
        continue
    seen.add(low)
    row('层间撞车', en_v, final.get(low, ''), final_layer.get(low, ''),
        '', '', '', '', low)

rows.sort(key=lambda r: (['lang内同名', 'Name过滤撞车', '层间撞车'].index(r[0]), r[1].lower()))
with open(f'{ROOT}/glossary_conflicts.csv', 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.writer(f)
    w.writerow(['type', 'en', 'current_zh', 'current_layer', 'conflict_zh', 'conflict_keys',
                'conflict_votes', 'official_zh', 'lang_zh', 'mech_zh', 'final_zh', 'final_layer', 'tie'])
    w.writerows(rows)

cnt = Counter(r[0] for r in rows)
print('冲突总行数:', len(rows), dict(cnt))
print('重挖赢家与发行 lang_terms 不一致条数:', mismatch)
print('平票条数(lang内同名):', sum(1 for r in rows if r[0] == 'lang内同名' and r[12] == 'tie'))
for r in rows:
    if r[1] in ('Electricity', 'Electricity Damage', 'Impact', 'Puncture'):
        print(' ', r[:7], 'final:', r[10], r[11])
