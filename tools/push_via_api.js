/**
 * push_via_api.js — 代理失效时经 GitHub Git Database API 推送（绕开 git 的 HTTPS 传输）
 *
 * 用法: node tools/push_via_api.js [remote=origin] [branch=main]
 * 前置: gh CLI 已登录且能访问 API；本地分支相对远端为快进。
 * 流程: 枚举本地独有 blob 逐个上传 → 对每个提交按目录后序创建 tree
 *       （子树先建，父 tree 用子树 sha）→ 创建 commit（父指向远端已有对象）→ PATCH 分支 ref。
 * 注意: 只推分支不推 tag（tag 由 gh release create 直接指向远端 commit）。
 *       远端生成的新 SHA 与本地不同，推送后需 git fetch 对齐工作区。
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REMOTE = process.argv[2] || 'origin';
const BRANCH = process.argv[3] || 'main';

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

function gh(method, endpoint, body) {
  const args = ['api', '--method', method, endpoint];
  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  if (body !== undefined) {
    args.push('--input', '-');
    opts.input = JSON.stringify(body);
  }
  const out = execFileSync('gh', args, opts);
  return out ? JSON.parse(out) : null;
}

function remoteSha(ownerRepo) {
  try {
    return gh('GET', `repos/${ownerRepo}/git/ref/heads/${BRANCH}`).object.sha;
  } catch {
    return null;
  }
}

/** blob 内容 base64 往返（二进制安全） */
function readBlobBase64(sha) {
  return execFileSync('git', ['cat-file', 'blob', sha], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('base64');
}

/**
 * 本地 tree -> 远端 tree。
 * 按目录后序：先建所有子目录 tree，再用子树 sha 建父 tree。返回远端 tree sha。
 */
function uploadTree(ownerRepo, localTreeSha, blobMap, cache) {
  if (cache.has(localTreeSha)) return cache.get(localTreeSha);
  const raw = execFileSync('git', ['ls-tree', '-z', localTreeSha], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8');
  const treeData = [];
  for (const rec of raw.split('\0').filter(Boolean)) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(rec);
    if (!m) throw new Error(`无法解析 ls-tree 条目: ${rec}`);
    const [, mode, type, sha, name] = m;
    if (type === 'tree') {
      treeData.push({ path: name, mode, type, sha: uploadTree(ownerRepo, sha, blobMap, cache) });
    } else if (type === 'blob') {
      const remote = blobMap.get(sha);
      if (!remote) throw new Error(`未上传的 blob: ${name} (${sha})`);
      treeData.push({ path: name, mode, type, sha: remote });
    } else {
      // 子模块（commit 对象）：本仓库无，直接沿用
      treeData.push({ path: name, mode, type, sha });
    }
  }
  const r = gh('POST', `repos/${ownerRepo}/git/trees`, { tree: treeData });
  cache.set(localTreeSha, r.sha);
  return r.sha;
}

function main() {
  const url = git('remote', 'get-url', REMOTE);
  const ownerRepo = url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  console.log(`repo: ${ownerRepo}`);

  const base = remoteSha(ownerRepo);
  if (!base) throw new Error(`远端分支 ${BRANCH} 不存在`);
  const head = git('rev-parse', 'HEAD');
  console.log(`remote ${BRANCH}=${base}`);
  console.log(`local  HEAD=${head}`);
  if (base === head) {
    console.log('已是最新，无需推送');
    return;
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], { cwd: ROOT });
  } catch {
    throw new Error('非快进：远端有本地没有的提交，请先同步');
  }

  const commits = git('rev-list', '--reverse', `${base}..${head}`).split('\n').filter(Boolean);
  console.log(`待推送提交 ${commits.length} 个`);

  // 1. 上传 HEAD 树下的全部 blob。
  //    不能只传差异路径上的 blob：重建整棵 tree 时，未变化目录里的文件同样需要 sha，
  //    而 API 侧对相同内容（同 sha）直接命中、不重复存储，整树上传才是安全的做法。
  const objects = git('rev-list', '--objects', head)
    .split('\n')
    .filter(Boolean)
    .map(l => l.split(' ')[0]);
  const blobs = [...new Set(objects)].filter(sha => git('cat-file', '-t', sha) === 'blob');
  const blobMap = new Map();
  let i = 0;
  for (const sha of blobs) {
    const r = gh('POST', `repos/${ownerRepo}/git/blobs`, { content: readBlobBase64(sha), encoding: 'base64' });
    blobMap.set(sha, r.sha);
    i++;
    if (i % 50 === 0 || i === blobs.length) console.log(`  blobs ${i}/${blobs.length}`);
  }

  // 2. 逐提交重建 tree 与 commit
  const treeCache = new Map();
  let parent = base;
  for (const c of commits) {
    const remoteTree = uploadTree(ownerRepo, git('rev-parse', `${c}^{tree}`), blobMap, treeCache);
    const message = git('log', '-1', '--format=%B', c);
    const author = {
      name: git('log', '-1', '--format=%an', c),
      email: git('log', '-1', '--format=%ae', c),
      date: git('log', '-1', '--format=%aI', c),
    };
    const committer = {
      name: git('log', '-1', '--format=%cn', c),
      email: git('log', '-1', '--format=%ce', c),
      date: git('log', '-1', '--format=%cI', c),
    };
    const commit = gh('POST', `repos/${ownerRepo}/git/commits`, {
      message,
      tree: remoteTree,
      parents: [parent],
      author,
      committer,
    });
    parent = commit.sha;
    console.log(`  commit ${c.slice(0, 7)} -> ${commit.sha.slice(0, 7)}`);
  }

  // 3. 快进分支 ref
  gh('PATCH', `repos/${ownerRepo}/git/refs/heads/${BRANCH}`, { sha: parent, force: false });
  console.log(`\n已推送 ${BRANCH}: ${base.slice(0, 7)} -> ${parent.slice(0, 7)}`);
  console.log(`远端 HEAD sha = ${parent}`);
}

main();
