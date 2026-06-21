/**
 * GrowthFactor 单元测试 (Batch AN 修补)
 *
 * 重点回归: 之前 `Number(null) === 0` 导致 null 字段被静默当成 0 通过
 * isFiniteNumber, 全市场每只股票产出 raw_value=0, 横截面 std=0.
 *
 * 跑: cd backend && npx ts-node --transpile-only tests/factors/GrowthFactor.test.ts
 */

import { growthFactor } from '../../src/quant/factors/library/GrowthFactor';
import { factorRegistry } from '../../src/quant/factors/FactorRegistry';
import '../../src/quant/factors/library';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

console.log('## GrowthFactor metadata');
assert('name=growth', growthFactor.name === 'growth');
assert('已注册 in registry', factorRegistry.get('growth') === growthFactor);

console.log('\n## Batch AN 回归: null 字段不再变成 0');
// Mock 一份 fundamental 行集合, 验证 compute 内部 helper 行为.
// 直接 monkey-patch StockFundamentalFactor.findAll, 控制返回值.
// (因子按 universe 过滤 + stripSuffix 后只看 raw rows, 行为可端到端验证.)
(async () => {
  const Model = require('../../src/models/StockFundamentalFactor').StockFundamentalFactor;
  const origFindAll = Model.findAll;

  // 场景 1: 全 null 上游字段 — Batch AN 修前会让每只股票输出 0, 修后正确跳过.
  Model.findAll = async () => [
    { symbol: 'sh.600000', factor_date: '2026-06-17', net_profit_growth: null, revenue_growth: null },
    { symbol: 'sh.600519', factor_date: '2026-06-17', net_profit_growth: null, revenue_growth: null },
    { symbol: 'sh.600007', factor_date: '2026-06-17', net_profit_growth: null, revenue_growth: null },
  ];
  const out1 = await growthFactor.compute({
    universe: ['600000', '600519', '600007'],
    as_of_date: '2026-06-17',
  } as any);
  assert(
    '全 null 上游 → Map 空 (修前会是 size=3 全 0)',
    out1.size === 0,
    `actual size=${out1.size}`
  );

  // 场景 2: 真实数据 — 有 npg + rev → 正常加权
  Model.findAll = async () => [
    {
      symbol: 'sh.600519',
      factor_date: '2026-06-17',
      net_profit_growth: 25,
      revenue_growth: 10,
    },
    {
      symbol: 'sh.000001',
      factor_date: '2026-06-17',
      net_profit_growth: -5,
      revenue_growth: 2,
    },
  ];
  const out2 = await growthFactor.compute({
    universe: ['600519', '000001'],
    as_of_date: '2026-06-17',
  } as any);
  assert('两只股票都有数据 → size=2', out2.size === 2);
  // 0.6*25 + 0.4*10 = 15 + 4 = 19
  assert(
    '600519: 0.6*25 + 0.4*10 = 19',
    Math.abs((out2.get('600519') as number) - 19) < 1e-9,
    `got=${out2.get('600519')}`
  );
  // 0.6*-5 + 0.4*2 = -3 + 0.8 = -2.2
  assert(
    '000001: 0.6*-5 + 0.4*2 = -2.2',
    Math.abs((out2.get('000001') as number) - -2.2) < 1e-9,
    `got=${out2.get('000001')}`
  );

  // 场景 3: 同股多行, 取 factor_date 最新 (修后只在该行有数据时才覆盖)
  Model.findAll = async () => [
    // 旧行有数据
    {
      symbol: 'sh.600519',
      factor_date: '2026-04-30',
      net_profit_growth: 30,
      revenue_growth: 12,
    },
    // 新行全 null — 修前会覆盖成 0, 修后被跳过, 保留旧行数据
    {
      symbol: 'sh.600519',
      factor_date: '2026-06-17',
      net_profit_growth: null,
      revenue_growth: null,
    },
  ];
  const out3 = await growthFactor.compute({
    universe: ['600519'],
    as_of_date: '2026-06-17',
  } as any);
  assert(
    '新行全 null → 保留旧行数据 (size=1)',
    out3.size === 1,
    `actual size=${out3.size}`
  );
  // 0.6*30 + 0.4*12 = 18 + 4.8 = 22.8
  assert(
    '600519: 旧行数据 0.6*30 + 0.4*12 = 22.8',
    out3.has('600519') && Math.abs((out3.get('600519') as number) - 22.8) < 1e-9,
    `got=${out3.get('600519')}`
  );

  // 场景 4: 只有一项数据 (rev null), npg=10 → 0.6*10 + 0.4*0 = 6
  Model.findAll = async () => [
    {
      symbol: 'sh.600519',
      factor_date: '2026-06-17',
      net_profit_growth: 10,
      revenue_growth: null,
    },
  ];
  const out4 = await growthFactor.compute({
    universe: ['600519'],
    as_of_date: '2026-06-17',
  } as any);
  assert(
    '只有 npg=10, rev=null → 0.6*10 = 6 (兼容旧行为)',
    out4.size === 1 && Math.abs((out4.get('600519') as number) - 6) < 1e-9,
    `got=${out4.get('600519')}`
  );

  // restore
  Model.findAll = origFindAll;

  console.log(`\nResults: ${passed} ok, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  console.error('TEST ERROR:', e);
  process.exit(1);
});
