/**
 * measure_r.js — 实测 AI 单次往返延迟 R（真实接口，非 mock）
 * 用法: MEASURE_BASE_URL=... MEASURE_KEY=... [MEASURE_MODEL=...] node tools/measure_r.js
 *
 * 载荷复刻 translate.ts 的真实批请求：TRANSLATE_SYSTEM_PROMPT 原文 + 60 词条术语表
 * + 16 行编号 wiki 文本（~1500 字符，与 MAX_CHARS_PER_REQ=1600 一致）
 * + 同款 estimateMaxTokens 公式 + stream:false。
 *
 * 输出三组数：
 *  1. 预填充延迟（max_tokens=1）：网络 + 排队 + 输入处理，不含解码
 *  2. 串行 R ×5：完整批请求的单次往返
 *  3. 并发波 ×1：3 条同时发（模拟 SEND_WINDOW=3 首波）的墙钟时间
 * 解码速度 = completion_tokens / (R - 预填充延迟)，供优化收益折算。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = process.env.MEASURE_BASE_URL;
const KEY = process.env.MEASURE_KEY;
const MODEL = process.env.MEASURE_MODEL || 'deepseek-chat';
if (!BASE || !KEY) {
  console.error('需要 MEASURE_BASE_URL 与 MEASURE_KEY 环境变量');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');

// 真实系统提示词直接从 ai.ts 提取（反引号定界），保证与线上逐字节一致
const aiTs = fs.readFileSync(path.join(ROOT, 'extension/src/background/ai.ts'), 'utf8');
const sysMatch = aiTs.match(/TRANSLATE_SYSTEM_PROMPT = `([\s\S]*?)`;/);
const SYSTEM = sysMatch ? sysMatch[1] : '你是翻译引擎，把编号文本逐行翻译成简体中文。';

// 术语表：官方层 + 语言层混采 60 条（与 MAX_TERMS_PER_REQ=60 一致）
const official = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/de_names.json'), 'utf8'));
const lang = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/lang_terms.json'), 'utf8')).terms ?? {};
const pool = [...Object.entries(official.terms), ...Object.entries(lang)];
const terms = [];
for (let i = 0; i < pool.length && terms.length < 60; i += Math.max(1, Math.floor(pool.length / 60))) {
  terms.push(pool[i]);
}
const termBlock = terms.length ? '术语表：\n' + terms.map(([en, zh]) => `${en} => ${zh}`).join('\n') + '\n\n' : '';

// 16 行典型 wiki 正文（总长 ~1500 字符，贴近 MAX_CHARS_PER_REQ）
const LINES = [
  'Saryn is a versatile Warframe capable of dealing high damage across wide areas with her spores and abilities.',
  'The Helminth system allows players to customize Warframes by sacrificing others for unique abilities.',
  'This weapon deals primarily Slash damage and benefits from the Naramon polarity in its build.',
  'Kuva Bramma is obtained after completing the Kuva Lich cycle and requires forma for optimal builds.',
  'Critical Chance determines the likelihood of landing a critical hit on an enemy target.',
  'Steel Path is an alternate, harder version of the star chart with enhanced enemies and rewards.',
  'Primed Continuity increases Ability Duration by 15 percent at maximum rank and is widely used.',
  'The Necralisk on Deimos serves as the hub for the Entrati syndicate and their bounties.',
  'Vacuum is a universal sentinel mod that automatically collects pickups within a radius.',
  'Radiation storms occur during Atomic Fallout missions and affect both players and enemies.',
  'Archwing segments allow quick traversal of open landscapes and space missions alike.',
  'Incarnon Genesis transforms certain weapons into their primordial forms with new alt fires.',
  'Riven mods provide randomized stat bonuses and can be rerolled at selected investors.',
  'The Lotus guides the Tenno through missions, offering tactical advice and extraction timing.',
  'Void Fissures open reactive cracks allowing players to collect reactant for prime parts.',
  'Endo is used to upgrade the ranks of arcane enhancements and mod fusion capacity.',
];
const numbering = LINES.map((l, i) => `[${i + 1}] ${l}`).join('\n');
const user = `${termBlock}文本：\n${numbering}`;
const maxTokens = Math.ceil(user.length * 2) + 512; // estimateMaxTokens 同款公式

async function chat(mt) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(BASE.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        stream: false,
        max_tokens: mt,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return {
      ms: performance.now() - t0,
      completion: data.usage?.completion_tokens ?? 0,
      finish: data.choices?.[0]?.finish_reason,
    };
  } finally {
    clearTimeout(timer);
  }
}

const fmt = ms => (ms / 1000).toFixed(1) + 's';

(async () => {
  console.log(`接口: ${BASE}  模型: ${MODEL}  载荷: 术语${terms.length}条 + ${LINES.length}行${user.length}字符  max_tokens=${maxTokens}`);

  // --wave N：只测 N 条并发的墙钟（探 GLOBAL_AI_CAP / AI_CONCURRENCY 上限用）
  const waveArg = process.argv.indexOf('--wave');
  if (waveArg > 0) {
    const n = Number(process.argv[waveArg + 1]) || 6;
    const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: n }, () => chat(maxTokens)));
    console.log(`${n} 并发波墙钟: ${fmt(performance.now() - t0)}  各条: ${rs.map(r => fmt(r.ms)).join(' / ')}`);
    return;
  }

  console.log(`系统提示词: ${SYSTEM.length} 字符\n`);

  const pre = await chat(1);
  console.log(`预填充延迟 (max_tokens=1): ${fmt(pre.ms)}`);

  const seq = [];
  for (let i = 0; i < 5; i++) {
    const r = await chat(maxTokens);
    seq.push(r);
    console.log(`串行 R #${i + 1}: ${fmt(r.ms)}  (completion ${r.completion} tok, finish=${r.finish})`);
  }
  const sorted = seq.map(r => r.ms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const t0 = performance.now();
  const wave = await Promise.all([chat(maxTokens), chat(maxTokens), chat(maxTokens)]);
  const waveMs = performance.now() - t0;
  console.log(`\n并发波 (3 条同时发) 墙钟: ${fmt(waveMs)}  各条: ${wave.map(r => fmt(r.ms)).join(' / ')}`);

  const decode = seq.map(r => r.completion / ((r.ms - pre.ms) / 1000)).filter(Number.isFinite);
  const avgDecode = decode.reduce((a, b) => a + b, 0) / decode.length;
  console.log(`\n—— 汇总 ——`);
  console.log(`预填充: ${fmt(pre.ms)}   串行 R 中位数: ${fmt(median)} (min ${fmt(sorted[0])} / max ${fmt(sorted[sorted.length - 1])})`);
  console.log(`解码速度: ~${avgDecode.toFixed(0)} tok/s   R ≈ ${fmt(pre.ms)} 预填充 + ${median > pre.ms ? fmt(median - pre.ms) : '?'} 解码`);
})().catch(e => {
  console.error('测量失败:', e.message);
  process.exit(1);
});
