/**
 * build_ext.js — 构建扩展产物到 dist/chrome 与 dist/firefox
 * 用法: npm run build
 */
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

const VERSION = require(path.join(ROOT, 'package.json')).version;

const entryPoints = [
  { in: path.join(EXT, 'src/content/index.ts'), out: 'content/content' },
  { in: path.join(EXT, 'src/background/index.ts'), out: 'background/background' },
  { in: path.join(EXT, 'src/options/options.ts'), out: 'options/options' },
  { in: path.join(EXT, 'src/popup/popup.ts'), out: 'popup/popup' },
];

const staticFiles = [
  ['content/content.css', 'content/content.css'],
  ['options/options.html', 'options/options.html'],
  ['options/options.css', 'options/options.css'],
  ['popup/popup.html', 'popup/popup.html'],
  ['popup/popup.css', 'popup/popup.css'],
  ['manifest.chrome.json', null], // per-target
  ['manifest.firefox.json', null],
  [path.join(ROOT, 'data/de_names.json'), 'data/de_names.json'],
  [path.join(ROOT, 'data/mechanism_terms.json'), 'data/mechanism_terms.json'],
  [path.join(ROOT, 'data/lang_terms.json'), 'data/lang_terms.json'],
];

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

for (const target of ['chrome', 'firefox']) {
  const outdir = path.join(DIST, target);

  esbuild.buildSync({
    entryPoints,
    outdir,
    bundle: true,
    format: 'iife',
    target: 'es2022',
    charset: 'utf8',
    logLevel: 'info',
    // lzma-wasm 引用了 node 模块做环境探测，打包时替换为空
    external: [],
    alias: {},
  });

  // 静态文件
  for (const [from, to] of staticFiles) {
    const src = path.isAbsolute(from) ? from : path.join(EXT, from);
    let dst = to;
    if (to === null) {
      if (!from.includes(target)) continue; // 只拷贝对应 target 的 manifest
      dst = 'manifest.json';
    }
    copy(src, path.join(outdir, dst));
  }

  // manifest 版本号与 package.json 同步
  const mfPath = path.join(outdir, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.version = VERSION;
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

  console.log(`built dist/${target}`);
}
console.log('done.');
