/**
 * GrowthFactor 单元测试 (Batch AN 修补 + Batch BA 数据源切换)
 *
 * 重点回归:
 *   - Batch AN: `Number(null) === 0` 导致 null 字段被静默当成 0 通过
 *     isFiniteNumber, 全市场每只股票产出 raw_value=0, 横截面 std=0
 *   - Batch BA: 数据源切换 StockFundamentalFactor → FinancialReport 因为
 *     stock_fundamental_factors.{net_profit_growth, revenue_growth} 永远 NULL
 *
 * 跑: cd backend && npx ts-node --transpile-only tests/factors/GrowthFactor.test.ts
 */

import {
  growthFactor,
  pickLatestYoyByStock,
  combineGrowth,
  REPORT_LOOKBACK_DAYS,
} from '../../src/quant/factors/library/GrowthFactor';
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

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

console.log('## GrowthFactor metadata');
assert('name=growth', growthFactor.name === 'growth');
assert('category=growth', growthFactor.category === 'growth');
assert('已注册 in registry', factorRegistry.get('growth') === growthFactor);
assert(
  `REPORT_LOOKBACK_DAYS = 200 (实际 ${REPORT_LOOKBACK_DAYS})`,
  REPORT_LOOKBACK_DAYS === 200
);

console.log('\n## 纯函数 pickLatestYoyByStock');
{
  // 空输入 → 空 Map
  assert('空数组 → 空 Map', pickLatestYoyByStock([]).size === 0);

  // 单股票多份 → 取 report_date 最大
  const m1 = pickLatestYoyByStock([
    { stock_code: '600519', report_date: '2025-12-31', net_profit_yoy: 20, revenue_yoy: 10 },
    { stock_code: '600519', report_date: '2026-03-31', net_profit_yoy: 25, revenue_yoy: 12 },
    { stock_code: '600519', report_date: '2025-09-30', net_profit_yoy: 18, revenue_yoy: 8 },
  ]);
  assert('多份取最新', m1.get('600519')?.report_date === '2026-03-31');
  assert('多份取最新值 np=25', m1.get('600519')?.np_yoy === 25);
  assert('多份取最新值 rev=12', m1.get('600519')?.rev_yoy === 12);

  // 多股票分组
  const m2 = pickLatestYoyByStock([
    { stock_code: '600519', report_date: '2026-03-31', net_profit_yoy: 25, revenue_yoy: 10 },
    { stock_code: '000001', report_date: '2026-03-31', net_profit_yoy: -5, revenue_yoy: 2 },
  ]);
  assert('多股票 size=2', m2.size === 2);
  assert('600519: np_yoy=25', m2.get('600519')?.np_yoy === 25);
  assert('000001: np_yoy=-5', m2.get('000001')?.np_yoy === -5);

  // 全 null 两字段 → 不入 Map (Batch AN 回归)
  const m3 = pickLatestYoyByStock([
    { stock_code: '600519', report_date: '2026-03-31', net_profit_yoy: null, revenue_yoy: null },
    { stock_code: '000001', report_date: '2026-03-31', net_profit_yoy: null, revenue_yoy: null },
  ]);
  assert('全 null 两字段 → Map 空 (Batch AN 回归)', m3.size === 0);

  // 新行全 null + 旧行有值 → 不覆盖
  const m4 = pickLatestYoyByStock([
    { stock_code: '600519', report_date: '2025-12-31', net_profit_yoy: 30, revenue_yoy: 12 },
    { stock_code: '600519', report_date: '2026-03-31', net_profit_yoy: null, revenue_yoy: null },
  ]);
  assert('新行全 null → 保留旧行有效值', m4.get('600519')?.np_yoy === 30);
  assert('新行全 null → 保留旧行 report_date', m4.get('600519')?.report_date === '2025-12-31');

  // 只有一项有效 → 仍入 Map
  const m5 = pickLatestYoyByStock([
    { stock_code: '600519', report_date: '2026-03-31', net_profit_yoy: 10, revenue_yoy: null },
  ]);
  assert('np=10 / rev=null → 入 Map', m5.size === 1);
  assert('np=10', m5.get('600519')?.np_yoy === 10);
  assert('rev=null', m5.get('600519')?.rev_yoy === null);

  // string 输入 (Sequelize DECIMAL raw 出来是 string) → 转 Number
  const m6 = pickLatestYoyByStock([
    {
      stock_code: '600519',
      report_date: '2026-03-31',
      net_profit_yoy: '25.5' as any,
      revenue_yoy: '10.2' as any,
    },
  ]);
  assert('string DECIMAL → 转 Number np', m6.get('600519')?.np_yoy === 25.5);
  assert('string DECIMAL → 转 Number rev', m6.get('600519')?.rev_yoy === 10.2);

  // NaN / Infinity → 视为 null
  const m7 = pickLatestYoyByStock([
    {
      stock_code: '600519',
      report_date: '2026-03-31',
      net_profit_yoy: NaN as any,
      revenue_yoy: Infinity as any,
    },
  ]);
  assert('NaN+Infinity → Map 空 (两值都无效)', m7.size === 0);
}

console.log('\n## 纯函数 combineGrowth');
{
  // 正常
  assert(
    'np=25, rev=10 → 0.6*25 + 0.4*10 = 19',
    near(combineGrowth({ np_yoy: 25, rev_yoy: 10, report_date: '2026-03-31' })!, 19)
  );
  assert(
    'np=-5, rev=2 → 0.6*-5 + 0.4*2 = -2.2',
    near(combineGrowth({ np_yoy: -5, rev_yoy: 2, report_date: '2026-03-31' })!, -2.2)
  );

  // 只缺 rev
  assert(
    'np=10, rev=null → 0.6*10 + 0.4*0 = 6',
    near(combineGrowth({ np_yoy: 10, rev_yoy: null, report_date: '2026-03-31' })!, 6)
  );

  // 只缺 np
  assert(
    'np=null, rev=8 → 0.6*0 + 0.4*8 = 3.2',
    near(combineGrowth({ np_yoy: null, rev_yoy: 8, report_date: '2026-03-31' })!, 3.2)
  );

  // 两个都缺 → null
  assert(
    '都缺 → null',
    combineGrowth({ np_yoy: null, rev_yoy: null, report_date: '2026-03-31' }) === null
  );
}

console.log('\n## Batch BA 端到端: FinancialReport 数据源');
(async () => {
  const Model = require('../../src/models/FinancialReport').FinancialReport;
  const origFindAll = Model.findAll;

  // 场景 1: 真实 prod 风格 — FinancialReport 有数据
  Model.findAll = async () => [
    {
      stock_code: '600519',
      report_date: '2026-03-31',
      net_profit_yoy: 1.3653,
      revenue_yoy: 6.538,
    },
    {
      stock_code: '000001',
      report_date: '2026-03-31',
      net_profit_yoy: 3.0292,
      revenue_yoy: 0.0,
    },
  ];
  const out1 = await growthFactor.compute({
    universe: ['600519', '000001', '999999'], // 999999 在 universe 但无 FinancialReport
    as_of_date: '2026-06-18',
  } as any);
  assert('2 只有数据 → size=2', out1.size === 2);
  assert(
    '600519: 0.6*1.3653 + 0.4*6.538 ≈ 3.4344',
    near(out1.get('600519') as number, 0.6 * 1.3653 + 0.4 * 6.538)
  );
  assert(
    '000001: 0.6*3.0292 + 0.4*0 ≈ 1.8175',
    near(out1.get('000001') as number, 0.6 * 3.0292)
  );
  assert('universe 内但无 FinancialReport 的 999999 → 不入 Map', !out1.has('999999'));

  // 场景 2: 空 FinancialReport (新表 / 早期 universe) → 空 Map
  Model.findAll = async () => [];
  const out2 = await growthFactor.compute({
    universe: ['600519', '000001'],
    as_of_date: '2026-06-18',
  } as any);
  assert('空 FinancialReport → Map 空', out2.size === 0);

  // 场景 3: universe 是空 — 不调 findAll
  let findAllCalled = false;
  Model.findAll = async () => {
    findAllCalled = true;
    return [];
  };
  const out3 = await growthFactor.compute({
    universe: [],
    as_of_date: '2026-06-18',
  } as any);
  assert('空 universe → Map 空', out3.size === 0);
  assert('空 universe → 不调 findAll (early return)', !findAllCalled);

  // 场景 4: 全 null 上游 → Map 空 (Batch AN 回归 — 数据源切换后仍要防御)
  Model.findAll = async () => [
    {
      stock_code: '600519',
      report_date: '2026-03-31',
      net_profit_yoy: null,
      revenue_yoy: null,
    },
  ];
  const out4 = await growthFactor.compute({
    universe: ['600519'],
    as_of_date: '2026-06-18',
  } as any);
  assert('全 null 上游 → Map 空 (Batch AN 回归)', out4.size === 0);

  // 场景 5: 多份历史 + 取最新
  Model.findAll = async () => [
    { stock_code: '600519', report_date: '2025-09-30', net_profit_yoy: 8, revenue_yoy: 5 },
    { stock_code: '600519', report_date: '2026-03-31', net_profit_yoy: 1.3, revenue_yoy: 6.5 },
    { stock_code: '600519', report_date: '2025-12-31', net_profit_yoy: -4.5, revenue_yoy: -1.2 },
  ];
  const out5 = await growthFactor.compute({
    universe: ['600519'],
    as_of_date: '2026-06-18',
  } as any);
  assert(
    '取最新 (2026-03-31): 0.6*1.3 + 0.4*6.5 = 3.38',
    near(out5.get('600519') as number, 0.6 * 1.3 + 0.4 * 6.5)
  );

  Model.findAll = origFindAll;

  console.log(`\nResults: ${passed} ok, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  console.error('TEST ERROR:', e);
  process.exit(1);
});
