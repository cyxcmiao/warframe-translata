/**
 * pack.js — 三端上架/分发 zip 打包（纯 node stdlib，无新依赖）
 * 用法: npm run pack
 * 产物: dist/pack/translatawiki-{chrome,edge,firefox}-v{version}.zip
 *
 * 商店硬性要求: manifest.json 在 zip 根目录、条目路径用正斜杠（AMO 对
 * 反斜杠条目直接报错，PowerShell Compress-Archive 恰好会生成反斜杠，
 * 故自实现 zip 容器：zlib.deflateRawSync 压缩 + 手写 central directory）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PACK = path.join(DIST, 'pack');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const TARGETS = ['chrome', 'edge', 'firefox'];

// --- zip 容器（STORED/DEFLATE，本地头 + central directory + EOCD） ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

function zipSync(files) {
  // files: [{ name, data, mtime }]
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const [time, date] = dosTime(f.mtime);
    const crc = crc32(f.data);
    let method = 8;
    let comp = zlib.deflateRawSync(f.data, { level: 9 });
    if (comp.length >= f.data.length) { method = 0; comp = f.data; } // 小文件存原始更省
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 名称标志位
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function walk(dir, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ name: rel, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime });
  }
  return out;
}

fs.mkdirSync(PACK, { recursive: true });
for (const target of TARGETS) {
  const files = walk(path.join(DIST, target));
  if (!files.some(f => f.name === 'manifest.json')) throw new Error(`dist/${target} 缺少 manifest.json，先 npm run build`);
  const zip = zipSync(files);
  const dest = path.join(PACK, `translatawiki-${target}-v${VERSION}.zip`);
  fs.writeFileSync(dest, zip);
  console.log(`packed dist/${target} → ${path.relative(ROOT, dest)} (${files.length} files, ${(zip.length / 1024).toFixed(0)} KB)`);
}
console.log('done.');
