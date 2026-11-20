/**
 * build_lang_terms.js — 从游戏语言文件挖掘官方译名词表（PublicExport 的补充层）
 *
 * 来源: GitHub calamity-inc/warframe-languages-bin-data（Actions 自动从游戏文件提取，
 *       senpai 分支，en/zh.json 各 ~18MB，15 语言）。官方导出缺的 UI 复合词
 *       （如 Tether-Flechette Orb → 桎梏飞掷丸）都在这里。
 * 下载: raw.githubusercontent.com 直连不通时回退 cdn.jsdelivr.net 镜像。
 * 范围: 仅 /Lotus/Language/ 路径下以 Name 结尾的展示名 key（物品/战甲技能部署名/浮印/
 *       外观/船员名等）；聊天快捷语、字幕、菜单动词等噪音类别天然被该过滤器排除。
 * 过滤: en ≤6 词且 <60 字符且含字母；[PH] 占位符剔除；zh 空值剔除；
 *       单词条目过停用表（Fire/Bow 等泛词误伤防护）；en 值去重（同名多 key 取多数 zh）。
 * 冲突: 与官方导出同名时运行时由官方层覆盖（glossary.ts 合并顺序），此处只记数。
 * 输出: data/lang_terms.json { version, builtAt, source, stats, terms: {en: zh} }
 * 缓存: tools/cache/lang/ 存上次下载的原始文件，内容 hash 不变则跳过重挖。
 * 缓存策略: lang_terms 的 version 不进翻译缓存 key（避免 DE 每次更新导致全量缓存
 * 失效重翻）；新词条只影响新遇到的文本，人工修订机制表时才 bump PROMPT_VERSION。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const BRANCH = 'senpai';
const REPO = 'calamity-inc/warframe-languages-bin-data';
const URLS = (file) => [
  `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${file}`,
  `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${file}`,
];

const CACHE_DIR = path.join(__dirname, 'cache', 'lang');
const OUT_PATH = path.join(__dirname, '..', 'data', 'lang_terms.json');
const STOPLIST = new Set(
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'stoplist.json'), 'utf8')),
);

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'translataWiki-build/0.1' } }, res => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

async function fetchBufAny(urls) {
  let lastErr;
  for (const u of urls) {
    try {
      return { buf: await fetchBuf(u), url: u };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function loadCachedOrFetch(file) {
  const cached = path.join(CACHE_DIR, file);
  try {
    const buf = fs.readFileSync(cached);
    console.log(`${file}: 使用缓存 (${(buf.length / 1e6).toFixed(1)} MB)`);
    return buf;
  } catch {
    /* 无缓存则下载 */
  }
  const { buf, url } = await fetchBufAny(URLS(file));
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, buf);
  console.log(`${file}: 下载自 ${url} (${(buf.length / 1e6).toFixed(1)} MB)`);
  return buf;
}

(async () => {
  const [enBuf, zhBuf] = await Promise.all([loadCachedOrFetch('en.json'), loadCachedOrFetch('zh.json')]);
  const combinedHash = crypto.createHash('sha256').update(sha256(enBuf) + sha256(zhBuf)).digest('hex').slice(0, 16);

  // 内容没变且产物存在 → 跳过重挖
  let prevMeta = null;
  try {
    prevMeta = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  } catch {
    /* 首次运行 */
  }
  if (prevMeta && prevMeta.source && prevMeta.source.combinedHash === combinedHash) {
    console.log(`语言文件未变化（hash ${combinedHash}），词表已是最新: ${Object.keys(prevMeta.terms).length} 条`);
    return;
  }

  const en = JSON.parse(enBuf.toString('utf8'));
  const zh = JSON.parse(zhBuf.toString('utf8'));

  // en 值 → { zh 候选计数 }（同名多 key 取多数 zh）
  const byEn = new Map(); // lower(en) -> { en, votes: Map<zh, count> }
  let scanned = 0;
  let phSkipped = 0;
  let longSkipped = 0;
  let stopSkipped = 0;
  for (const [key, enVal] of Object.entries(en)) {
    if (typeof enVal !== 'string') continue;
    if (!key.startsWith('/Lotus/Language/') || !key.endsWith('Name')) continue;
    const zhVal = zh[key];
    if (typeof zhVal !== 'string' || !zhVal.trim()) continue;
    scanned++;
    if (/\[PH\]/i.test(enVal) || /\[PH\]/i.test(zhVal)) {
      phSkipped++;
      continue;
    }
    const words = enVal.match(/[A-Za-z][A-Za-z0-9'’-]*/g) || [];
    if (words.length < 1 || words.length > 6 || enVal.length >= 60 || !/[A-Za-z]/.test(enVal)) {
      longSkipped++;
      continue;
    }
    if (zhVal.length >= 30) {
      longSkipped++;
      continue;
    }
    // 单词条目过停用表（泛词误伤防护，与官方导出管线同一张表）
    if (words.length === 1 && STOPLIST.has(enVal.trim().toLowerCase())) {
      stopSkipped++;
      continue;
    }
    const lower = enVal.trim().toLowerCase();
    let rec = byEn.get(lower);
    if (!rec) {
      rec = { en: enVal.trim(), votes: new Map() };
      byEn.set(lower, rec);
    }
    rec.votes.set(zhVal.trim(), (rec.votes.get(zhVal.trim()) || 0) + 1);
  }

  const terms = {};
  let conflicts = 0;
  for (const rec of byEn.values()) {
    let bestZh = '';
    let bestN = 0;
    let total = 0;
    for (const [z, n] of rec.votes) {
      total += n;
      if (n > bestN) {
        bestN = n;
        bestZh = z;
      }
    }
    if (rec.votes.size > 1) conflicts++;
    terms[rec.en] = bestZh;
  }

  const stats = {
    nameKeys: scanned,
    terms: Object.keys(terms).length,
    zhEqualsEn: Object.entries(terms).filter(([e, z]) => e.toLowerCase() === z.toLowerCase()).length,
    phSkipped,
    longSkipped,
    stopSkipped,
    enConflicts: conflicts,
  };

  const out = {
    version: `${new Date().toISOString().slice(0, 10)}+${combinedHash}`,
    builtAt: new Date().toISOString(),
    source: { repo: `${REPO}@${BRANCH}`, combinedHash, files: 'en.json+zh.json' },
    stats,
    terms,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log(`lang_terms: ${stats.terms} 条 (zh===en 锁定英文 ${stats.zhEqualsEn} 条, 同名冲突 ${conflicts}, [PH] 剔除 ${phSkipped}, 超长剔除 ${longSkipped}, 停用表剔除 ${stopSkipped})`);
  console.log(`输出: ${OUT_PATH}`);
})().catch(e => {
  console.error('build_lang_terms failed:', e.message);
  process.exit(1);
});
