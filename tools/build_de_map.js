/**
 * build_de_map.js — 从 Warframe 官方 PublicExport 生成 en→zh 官方译名词表
 *
 * 用法: node tools/build_de_map.js
 * 输出: data/de_names.json  { version, builtAt, source, stats, terms: {en: zh}, retained: [en] }
 *
 * 规则（与用户约定一致）:
 *  - 英文版与中文版按 uniqueName 配对，两边都有且中文译名非空才收表
 *  - zh === en（官方未翻译，如 Excalibur）不收词表，但记入 retained —— 正文里这些名字
 *    保留英文原文就是"正确译法"，扩展据此跳过对应的 AI 请求
 *  - /Lotus/Language/* UI 字符串不收（那是界面文案，不是物品名）
 *  - ExportWarframes 的技能名（abilities[].abilityName）一并收录，单独计数
 *
 * 词表更新机制: 每个源文件的 !00_hash 记录在 source 里；索引 hash 变了 → 文件内容变了 → 重跑即可增量更新。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const LZMA = require('lzma');

const BASE = 'https://content.warframe.com/PublicExport/';
const ORIGIN = 'https://origin.warframe.com/PublicExport/';
const MANIFEST = BASE + 'Manifest/';

// 用户指定的 10 个导出文件
const EXPORTS = [
  'ExportResources', 'ExportWeapons', 'ExportWarframes', 'ExportSentinels',
  'ExportGear', 'ExportKeys', 'ExportFlavour', 'ExportRelicArcane',
  'ExportFusionBundles', 'ExportUpgrades',
];

const INCLUDE_ABILITIES = true;

const CACHE_DIR = path.join(__dirname, 'cache', 'export');
const OUT_PATH = path.join(__dirname, '..', 'data', 'de_names.json');
// 通用英文单词停用表（单词物品名如 Fire/Bow/Boot 会误伤普通句子）
const STOPLIST = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'stoplist.json'), 'utf8')));

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'translataWiki-build/0.1' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function fetchBufAny(urls) {
  return (async () => {
    let lastErr;
    for (const u of urls) {
      try { return { buf: await fetchBuf(u), url: u }; } catch (e) { lastErr = e; }
    }
    throw lastErr;
  })();
}

function lzmaDecompress(buf) {
  return new Promise((resolve, reject) => {
    LZMA.decompress(buf, (result, err) => (err ? reject(err) : resolve(result)));
  });
}

function parseIndex(text) {
  const map = {}; // "ExportWeapons_en" -> "ExportWeapons_en.json!00_hash"
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const m = line.match(/^(.+)\.json!00_(.+)$/);
    if (m) map[m[1]] = line;
  }
  return map;
}

/**
 * 词表过滤规则，返回 null 表示丢弃；same=true 表示官方未译（英文原名即官方译名）
 * @returns {null | { en: string, zh: string, same: boolean }}
 */
function validPair(enName, zhName, uniqueName) {
  if (!enName || !zhName) return null;
  // 剥离显示标签前缀，如 "<ARCHWING> Amesha" -> "Amesha"
  enName = enName.replace(/^(<[A-Za-z_ ]+>\s?)+/, '').trim();
  zhName = zhName.replace(/^(<[A-Za-z_ ]+>\s?)+/, '').trim();
  if (!enName || !zhName) return null;
  if (enName.length < 2 || zhName.length < 1) return null;
  if (!enName.includes(' ') && STOPLIST.has(enName.toLowerCase())) return null; // 泛词停用表（仅单词词条）
  if (uniqueName.startsWith('/Lotus/Language/')) return null;          // UI 字符串
  if (/[|<>]/.test(enName) || /[|<>]/.test(zhName)) return null;       // 模板标签/HTML 残留
  if (enName === 'DO NOT USE' || enName.startsWith('/')) return null;
  return { en: enName, zh: zhName, same: zhName.toLowerCase() === enName.toLowerCase() };
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  // 1. 拉取双语索引
  const indexes = {};
  for (const lang of ['en', 'zh']) {
    const { buf } = await fetchBufAny([ORIGIN + `index_${lang}.txt.lzma`, BASE + `index_${lang}.txt.lzma`]);
    indexes[lang] = parseIndex(await lzmaDecompress(buf));
    console.log(`index_${lang}: ${Object.keys(indexes[lang]).length} entries`);
  }

  // 2. 下载 10 个导出文件的双语版（带 hash 后缀 + Manifest 路径）
  const source = {};
  const data = {}; // baseName -> { en: [...], zh: [...] }
  for (const base of EXPORTS) {
    const enKey = `${base}_en`, zhKey = `${base}_zh`;
    if (!indexes.en[enKey] || !indexes.zh[zhKey]) {
      console.warn(`!! index missing ${base}: en=${!!indexes.en[enKey]} zh=${!!indexes.zh[zhKey]}`);
      continue;
    }
    const files = {};
    for (const [key, entry] of [[enKey, indexes.en[enKey]], [zhKey, indexes.zh[zhKey]]]) {
      const cached = path.join(CACHE_DIR, entry);
      let raw;
      if (fs.existsSync(cached)) {
        raw = fs.readFileSync(cached);
      } else {
        raw = await fetchBuf(MANIFEST + entry);
        fs.writeFileSync(cached, raw);
      }
      files[key] = JSON.parse(raw.toString('utf8'));
      source[key] = entry.split('!00_')[1];
    }
    data[base] = files;
    const nEn = Array.isArray(files[enKey]) ? files[enKey].length : Object.keys(files[enKey]).length;
    console.log(`${base}: en=${nEn} zh=${Array.isArray(files[zhKey]) ? files[zhKey].length : Object.keys(files[zhKey]).length}`);
  }

  // 3. 按 uniqueName 配对
  const terms = {};
  const retained = new Set(); // 官方保留英文原名（zh === en）
  const conflicts = [];
  let rawPairs = 0, abilities = 0;
  const addTerm = (en, zh) => {
    if (Object.prototype.hasOwnProperty.call(terms, en)) {
      if (terms[en] !== zh) conflicts.push({ en, zhOld: terms[en], zhNew: zh });
      return false;
    }
    terms[en] = zh;
    return true;
  };
  const addPair = (pair, isAbility) => {
    if (pair.same) retained.add(pair.en);
    else if (addTerm(pair.en, pair.zh) && isAbility) abilities++;
  };

  for (const base of EXPORTS) {
    const files = data[base];
    if (!files) continue;
    const enFile = files[`${base}_en`];
    const zhFile = files[`${base}_zh`];
    // 顶层是类目键 -> 数组，全部展开处理
    const enItems = Object.values(enFile).filter(Array.isArray).flat();
    const zhItems = Object.values(zhFile).filter(Array.isArray).flat();
    const zhByName = new Map();
    for (const it of zhItems) {
      if (!it) continue;
      const id = it.uniqueName || it.abilityUniqueName;
      if (id) zhByName.set(id, it);
    }
    for (const it of enItems) {
      if (!it) continue;
      const id = it.uniqueName || it.abilityUniqueName;
      if (!id) continue;
      const enName = it.name || it.abilityName;
      const zhIt = zhByName.get(id);
      if (!zhIt) continue;
      const zhName = zhIt.name || zhIt.abilityName;
      if (enName && zhName) {
        rawPairs++;
        const pair = validPair(enName, zhName, id);
        if (pair) addPair(pair, false);
      }
      // 战甲条目内的技能名也是官方译名，一并收录
      if (INCLUDE_ABILITIES && Array.isArray(it.abilities) && Array.isArray(zhIt.abilities)) {
        const zhAb = new Map(zhIt.abilities.map(a => [a.abilityUniqueName, a]));
        for (const ab of it.abilities) {
          const zhAbIt = zhAb.get(ab.abilityUniqueName);
          if (!ab || !zhAbIt) continue;
          const p = validPair(ab.abilityName, zhAbIt.abilityName, ab.abilityUniqueName || '');
          if (p) addPair(p, true);
        }
      }
    }
  }

  // 词表里的真译名优先于"保留英文"（同名不同 uniqueName 时以有译名为准）
  for (const en of retained) if (Object.prototype.hasOwnProperty.call(terms, en)) retained.delete(en);

  const stats = {
    rawPairs,
    abilities,
    terms: Object.keys(terms).length,
    retained: retained.size,
    conflicts: conflicts.length,
  };
  const out = {
    version: new Date().toISOString().slice(0, 10),
    builtAt: new Date().toISOString(),
    source,
    stats,
    terms,
    retained: [...retained].sort(),
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1), 'utf8');
  console.log('stats:', JSON.stringify(stats));
  console.log('conflicts sample:', conflicts.slice(0, 5));
  console.log('written:', OUT_PATH);

  // 4. 抽查
  for (const probe of ['Tigris Prime', 'Saryn', 'Excalibur', 'Forma', 'Pressure Point', 'The Second Dream', 'Kuva Bramma', 'Shooting Gallery']) {
    console.log(`  ${probe} -> ${JSON.stringify(terms[probe] ?? '(不在词表)')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
