/**
 * build_ext.js — 构建扩展产物到 dist/chrome、dist/edge 与 dist/firefox
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
  [path.join(ROOT, 'data/de_names.json'), 'data/de_names.json'],
  [path.join(ROOT, 'data/mechanism_terms.json'), 'data/mechanism_terms.json'],
  [path.join(ROOT, 'data/lang_terms.json'), 'data/lang_terms.json'],
  [path.join(ROOT, 'data/manual_overrides.json'), 'data/manual_overrides.json'],
];

// 三端 target → manifest 文件（Edge 与 Chrome 同为 MV3 service worker，manifest 内容一致）
const TARGETS = {
  chrome: 'manifest.chrome.json',
  edge: 'manifest.edge.json',
  firefox: 'manifest.firefox.json',
};

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

for (const [target, manifestSrc] of Object.entries(TARGETS)) {
  const outdir = path.join(DIST, target);
  fs.rmSync(outdir, { recursive: true, force: true }); // 清空重建，防陈旧文件混入

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
    copy(src, path.join(outdir, to));
  }

  // 图标
  for (const name of fs.readdirSync(path.join(EXT, 'icons'))) {
    copy(path.join(EXT, 'icons', name), path.join(outdir, 'icons', name));
  }

  // manifest
  copy(path.join(EXT, manifestSrc), path.join(outdir, 'manifest.json'));

  // manifest 版本号与 package.json 同步
  const mfPath = path.join(outdir, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.version = VERSION;
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

  console.log(`built dist/${target}`);
}
console.log('done.');
