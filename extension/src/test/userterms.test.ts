/** parseUserTermsText / serializeUserTerms（自定义词表文本格式）单元测试: node tools/test_userterms.js */
import { parseUserTermsText, serializeUserTerms } from '../shared/userterms';

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

// --- 基础格式
{
  const r = parseUserTermsText('buff, 增益\nKuva Bramma, 赤毒·布拉玛');
  check('基础两行解析', r.terms.buff === '增益' && r.terms['Kuva Bramma'] === '赤毒·布拉玛' && !r.bad.length, r);
}
// --- 注释 / 空行 / 脏行
{
  const r = parseUserTermsText('\n# 注释: 忽略\nno comma here\nfoo,\n, 只有译名\n');
  check('注释与空行忽略、脏行进 bad', Object.keys(r.terms).length === 0 && r.bad.length === 3, r);
}
// --- 英文名本身含英文逗号：按最后一个逗号分隔，前面的逗号都属于英文
{
  const r = parseUserTermsText('Bounty, Tier 5, 赏金任务5阶');
  check('英文名含逗号', r.terms['Bounty, Tier 5'] === '赏金任务5阶' && !r.bad.length, r);
  const r2 = parseUserTermsText('Foo, Bar, Baz, 三逗号英文');
  check('英文名含多个逗号', r2.terms['Foo, Bar, Baz'] === '三逗号英文', r2);
}
// --- 译文里的英文逗号：转义 \, 
{
  const r = parseUserTermsText('buff, 增益\\, 强化');
  check('译文英文逗号转义', r.terms.buff === '增益, 强化' && !r.bad.length, r);
  // 英文名里也转义逗号（等价写法）
  const r2 = parseUserTermsText('Bounty\\, Tier 5, 赏金任务5阶');
  check('英文名转义逗号等价', r2.terms['Bounty, Tier 5'] === '赏金任务5阶', r2);
}
// --- 没有英文逗号时容忍中文逗号（取第一个，译文内部中文逗号不受影响）
{
  const r = parseUserTermsText('buff，增益，强化');
  check('中文逗号作分隔', r.terms.buff === '增益，强化' && !r.bad.length, r);
}
// --- 反斜杠与逗号混合的转义
{
  const r = parseUserTermsText('a\\\\b, 反斜杠');
  check('反斜杠转义', r.terms['a\\b'] === '反斜杠', r);
  // 译文含字面反斜杠（无逗号）：单逗号分隔，`\\` → `\`
  const r2 = parseUserTermsText('path, C:\\\\dir');
  check('译文含反斜杠', r2.terms.path === 'C:\\dir', r2);
  // 译文同时含反斜杠与英文逗号：逗号写 `\,`（单个反斜杠 = 已转义，不参与分隔）
  const r3 = parseUserTermsText('path, C:\\\\dir\\, 存档');
  check('译文含反斜杠+转义逗号', r3.terms.path === 'C:\\dir, 存档' && !r3.bad.length, r3);
}
// --- 序列化：含逗号的英文名不需要转义；译文里的英文逗号转义；round-trip 稳定
{
  const terms = {
    'Bounty, Tier 5': '赏金任务5阶',
    buff: '增益, 强化',
    'back\\slash': '反\\斜杠',
    plain: '普通',
  };
  const text = serializeUserTerms(terms);
  console.log('    serialize →\n' + text.replace(/^/gm, '      '));
  check('含逗号英文名原样输出', text.includes('Bounty, Tier 5, 赏金任务5阶'), text);
  check('译文英文逗号被转义', text.includes('增益\\, 强化'), text);
  const round = parseUserTermsText(text);
  check('round-trip 无损', JSON.stringify(Object.entries(round.terms).sort()) === JSON.stringify(Object.entries(terms).sort()), round);
  check('round-trip 无脏行', round.bad.length === 0, round.bad);
}
// --- 序列化排序确定性（大小写不敏感码点序）
{
  const text = serializeUserTerms({ b: '乙', A: '甲', c: '丙' });
  check('序列化按英文排序', text.split('\n').map(l => l.split(',')[0]).join(',') === 'A,b,c', text);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
