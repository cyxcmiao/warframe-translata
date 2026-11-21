/** 把 TS 测试打包成单文件再运行（与 test_matcher.js 同一套模式） */
'use strict';
const path = require('path');
const esbuild = require('esbuild');
const { pathToFileURL } = require('url');

const out = path.join(__dirname, '.tmp', 'zhmatch.test.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'extension/src/test/zhmatch.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'silent',
});

(async () => {
  await import(pathToFileURL(out).href);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
