/** mergeGlossaryLayers（词表分层合并优先级）单元测试: node tools/test_layers.js */
import { effectiveUserTerms, mergeGlossaryLayers, userRetained } from '../shared/layers';

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

const parts = (extra?: Partial<Parameters<typeof mergeGlossaryLayers>[0]>) => ({
  mech: { DamageFalloff: '伤害衰减' },
  lang: { 'Tether-Flechette Orb': '桎梏飞掷丸' },
  // 官方层不含 retained 名（构建端 zh===en 不进 terms，进 retained）
  official: { Electricity: '电击', Shock: '电击' },
  overrides: { Electricity: '电流', Volt: 'Volt' },
  user: {},
  ...extra,
});

// --- 基础优先级：机制表 < 语言层 < 官方 < 覆盖层 < 用户自定义
{
  const m = mergeGlossaryLayers(parts(), []);
  check('补充层补充官方缺词', m['Tether-Flechette Orb'] === '桎梏飞掷丸' && m.DamageFalloff === '伤害衰减', m);
  check('覆盖层修正官方译名', m.Electricity === '电流', m);
}

// --- 用户自定义层最高优先级
{
  const m = mergeGlossaryLayers(parts({ user: { Electricity: '雷电' } }), []);
  check('user 覆盖覆盖层与官方', m.Electricity === '雷电', m);
  {
    const m2 = mergeGlossaryLayers(
      parts({ overrides: { Electricity: '电流' }, user: { Electricity: '雷击' } }),
      [],
    );
    check('user 覆盖 overrides', m2.Electricity === '雷击', m2);
  }
}

// --- 用户自定义空译名不生效（自定义层不支持删除，官方译名保持不变）
{
  const m = mergeGlossaryLayers(parts({ user: { Electricity: '', Shock: '' } }), []);
  check('user 空译名不删除官方词条', m.Electricity === '电流' && m.Shock === '电击', m);
  check('user 空译名不影响其他层词条', m.DamageFalloff === '伤害衰减', m);
}

// --- 用户自定义覆盖 retained 锁定
{
  const m = mergeGlossaryLayers(parts({ user: { Excalibur: '段落' } }), ['Excalibur']);
  check('user 覆盖 retained 锁定', m.Excalibur === '段落', m);
  const m2 = mergeGlossaryLayers(parts(), ['Excalibur']);
  check('无 user 干预时 retained 名不入词表', !('Excalibur' in m2), m2);
}

// --- 用户自定义 zh===en 强制保留英文
{
  const m = mergeGlossaryLayers(parts({ user: { Volt: 'Volt' } }), []);
  check('user zh===en 强制保留英文', m.Volt === 'Volt', m);
}

// --- user 新增官方缺词
{
  const m = mergeGlossaryLayers(parts({ user: { MyWarframeTerm: '我的战甲' } }), []);
  check('user 新增词条进生效词表', m.MyWarframeTerm === '我的战甲', m);
}

// --- 用户输入大小写不受控：大小写变体键同样压过官方
{
  const m = mergeGlossaryLayers(parts({ user: { electricity: '雷电' } }), []);
  check('大小写变体覆盖官方键', m.electricity === '雷电' && !('Electricity' in m), m);
  const m2 = mergeGlossaryLayers(parts({ user: { ELECTRICITY: '' } }), []);
  check('大小写变体空译名同样不生效', m2.Electricity === '电流', m2);
}

// --- effectiveUserTerms：空译名/空英文被滤掉，其余原样保留
{
  const eff = effectiveUserTerms({ buff: '增益', Empty: '', Space: '  ', ' ': 'x', ok: '好' });
  check('effectiveUserTerms 滤掉空译名与空英文', Object.keys(eff).join(',') === 'buff,ok', eff);
  check('effectiveUserTerms 保留译名原值', eff.buff === '增益' && eff.ok === '好', eff);
}

// --- userRetained：zh===en（强制保留英文）识别
{
  const r = userRetained({ Prime: 'Prime', Kuva: 'kuva', Electricity: '电击', Empty: '' });
  check('userRetained 识别 zh===en（大小写不敏感）', r.includes('Prime') && r.includes('Kuva'), r);
  check('userRetained 排除真译名与空值', !r.includes('Electricity') && !r.includes('Empty'), r);
}

// --- 其他层空值同样剔除
{
  const m = mergeGlossaryLayers(
    parts({ official: { Electricity: '电击', Broken: '' }, overrides: { Broken: '', Volt: 'Volt' } }),
    [],
  );
  check('任意层空值统一剔除', !('Broken' in m) && m.Volt === 'Volt', m);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
