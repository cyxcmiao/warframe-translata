/** 把 TS 测试打包成单文件再运行 */
'use strict';
const path = require('path');
const esbuild = require('esbuild');
const { pathToFileURL } = require('url');

const out = path.join(__dirname, '.tmp', 'matcher.test.js');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'extension/src/test/matcher.test.ts')],
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
