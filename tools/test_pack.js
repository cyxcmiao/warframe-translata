/**
 * test_pack.js — 三端上架包结构回归（配合 tools/pack.js）
 * 用法: node tools/test_pack.js
 * 校验: manifest.json 在 zip 根 / 无反斜杠条目 / local-central 头一致 /
 *       icons 齐全且为合法 PNG / EOCD 与 central directory 边界吻合
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const TARGETS = ['chrome', 'edge', 'firefox'];

function parseZip(file) {
  const b = fs.readFileSync(file);
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error(`${file}: EOCD not found`);
  const n = b.readUInt16LE(e + 10);
  const cdOff = b.readUInt32LE(e + 16);
  const entries = new Map();
  let o = cdOff;
  for (let i = 0; i < n; i++) {
    if (b.readUInt32LE(o) !== 0x02014b50) throw new Error(`${file}: bad central dir at ${o}`);
    const nl = b.readUInt16LE(o + 28), el = b.readUInt16LE(o + 30), cl = b.readUInt16LE(o + 32);
    const lho = b.readUInt32LE(o + 42);
    const name = b.slice(o + 46, o + 46 + nl).toString();
    if (name.includes('\\')) throw new Error(`${file}: backslash entry ${name}`);
    const lnl = b.readUInt16LE(lho + 26);
    const lname = b.slice(lho + 30, lho + 30 + lnl).toString();
    if (lname !== name) throw new Error(`${file}: name mismatch ${name} vs ${lname}`);
    const method = b.readUInt16LE(o + 10);
    const csize = b.readUInt32LE(o + 20), usize = b.readUInt32LE(o + 24);
    // 解出内容做内容级校验
    const lNameBuf = lho + 30 + lnl;
    const raw = b.slice(lNameBuf, lNameBuf + csize);
    const data = method === 8 ? require('zlib').inflateRawSync(raw) : raw;
    if (data.length !== usize) throw new Error(`${file}: size mismatch ${name}`);
    entries.set(name, data);
    o += 46 + nl + el + cl;
  }
  if (o !== e) throw new Error(`${file}: central directory overrun`);
  return entries;
}

let failed = 0;
for (const target of TARGETS) {
  const file = path.join(ROOT, 'dist', 'pack', `translatawiki-${target}-v${VERSION}.zip`);
  try {
    const z = parseZip(file);
    const expect = ['manifest.json', 'content/content.js', 'content/content.css', 'background/background.js',
      'options/options.html', 'options/options.js', 'popup/popup.html', 'popup/popup.js',
      'data/de_names.json', 'data/lang_terms.json', 'data/mechanism_terms.json', 'data/manual_overrides.json',
      'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'];
    for (const f of expect) {
      if (!z.has(f)) throw new Error(`missing ${f}`);
      if (f.endsWith('.png') && z.get(f).slice(1, 4).toString() !== 'PNG') throw new Error(`bad PNG ${f}`);
    }
    const mf = JSON.parse(z.get('manifest.json').toString());
    if (!mf.icons || !mf.action.default_icon) throw new Error('manifest icons missing');
    if (mf.version !== VERSION) throw new Error(`version mismatch: ${mf.version}`);
    if (target === 'firefox') {
      if (!mf.background.scripts) throw new Error('firefox should use event page scripts');
      if (!mf.browser_specific_settings?.gecko?.id) throw new Error('gecko id missing');
    } else if (mf.background.service_worker !== 'background/background.js') {
      throw new Error('service worker path wrong');
    }
    console.log(`ok  ${target}: ${z.size} entries checked, manifest v${mf.version}`);
  } catch (e) {
    console.error(`FAIL ${target}: ${e.message}`);
    failed++;
  }
}
if (failed) process.exit(1);
console.log('all pack checks passed.');
