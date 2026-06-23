/**
 * AnalystConsensusFactor 单元测试 (US-030).
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/factors/AnalystConsensusFactor.test.ts
 *
 * 覆盖：
 *   - 纯函数 mean (空数组 / 1 个 / 多个 / 负数混合)
 *   - 纯函数 isoDateMinusDays (正常 / 跨月 / 跨年 / 负 days 截断到 0)
 *   - 纯函数 computeRevisionPerYear:
 *       - 空 reports → 空数组
 *       - 单一年份 / 多年份分组
 *       - recent 窗口 ≥ 1 + baseline 窗口 ≥ 1 → 正确计算上调 %
 *       - recent 窗口 0 条 → 该年跳过
 *       - baseline 窗口 0 条 → 该年跳过
 *       - baseline avg ≈ 0 → 该年跳过（避免分母爆炸）
 *       - 部分 forecast_year_y1 / forecast_eps_y1 缺数据 → 跳过该条 record
 *       - report_date 超出窗口（更早或晚于 as_of_date）→ 跳过
 *       - 上调 / 下调 / 持平 三类 revision 符号验证
 *   - 纯函数 aggregateRevisions (空 → null / 单 year → 该 year revision /
 *     多 year → 算术均值)
 *   - Factor metadata (name / category / description / 已注册 / 从 registry get)
 *   - 端到端业务校验：构造场景验证 5 维 AND
 *     (validCount >= MIN_REPORTS_TOTAL & ≥1 year passes & 多 firm 多 year 聚合)
 *   - 空 universe 路径不爆 (compute() ctx.universe=[] → 空 Map)
 */

import {
  analystConsensusFactor,
  computeRevisionPerYear,
  aggregateRevisions,
  mean,
  isoDateMinusDays,
  RECENT_WINDOW_DAYS,
  TOTAL_WINDOW_DAYS,
  MIN_REPORTS_TOTAL,
  BASELINE_ZERO_THRESHOLD,
  ForecastInput,
} from '../../src/quant/factors/library/AnalystConsensusFactor';
import { factorRegistry } from '../../src/quant/factors/FactorRegistry';
// 触发 library 自我登记
// eslint-disable-next-line @typescript-eslint/no-var-requires
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

function expectClose(name: string, actual: number, expected: number, eps = 1e-9) {
  assert(name, near(actual, expected, eps), `expected≈${expected}, got=${actual}`);
}

console.log('\n## mean()');
expectClose('空数组 → 0', mean([]), 0);
expectClose('单元素 [42] → 42', mean([42]), 42);
expectClose('[1,2,3,4,5] → 3', mean([1, 2, 3, 4, 5]), 3);
expectClose('[-2, -1, 0, 1, 2] → 0', mean([-2, -1, 0, 1, 2]), 0);
expectClose(
  '[1.5, 2.5, 3.5] → 2.5',
  mean([1.5, 2.5, 3.5]),
  2.5,
  1e-9
);

console.log('\n## isoDateMinusDays()');
assert(
  'asOf=2026-06-07 -30d → 2026-05-08',
  isoDateMinusDays(new Date('2026-06-07T00:00:00Z'), 30) === '2026-05-08'
);
assert(
  'asOf=2026-06-07 -90d → 2026-03-09',
  isoDateMinusDays(new Date('2026-06-07T00:00:00Z'), 90) === '2026-03-09'
);
assert(
  'asOf=2026-01-15 -30d → 2025-12-16 (跨年)',
  isoDateMinusDays(new Date('2026-01-15T00:00:00Z'), 30) === '2025-12-16'
);
assert(
  'days=0 → 同日',
  isoDateMinusDays(new Date('2026-06-07T00:00:00Z'), 0) === '2026-06-07'
);
assert(
  'days<0 → clamp 0',
  isoDateMinusDays(new Date('2026-06-07T00:00:00Z'), -5) === '2026-06-07'
);
assert(
  'asOf=2026-03-01 -30d → 2026-01-30 (跨月)',
  isoDateMinusDays(new Date('2026-03-01T00:00:00Z'), 30) === '2026-01-30'
);

console.log('\n## computeRevisionPerYear() — 基本场景');

const AS_OF = '2026-06-07';

// 场景：单一 forecast_year_y1，recent / baseline 两窗口都有数据，上调 10 %
{
  // recent 窗口 [2026-05-08, 2026-06-07]，baseline [2026-03-09, 2026-05-08)
  const reports: ForecastInput[] = [
    // baseline 窗口（21 天前 — 在 baseline 区间内）
    { report_date: '2026-05-01', forecast_eps_y1: 5.0, forecast_year_y1: 2026 },
    { report_date: '2026-04-15', forecast_eps_y1: 5.0, forecast_year_y1: 2026 },
    // recent 窗口（最近 30 天）
    { report_date: '2026-05-20', forecast_eps_y1: 5.5, forecast_year_y1: 2026 },
    { report_date: '2026-06-01', forecast_eps_y1: 5.5, forecast_year_y1: 2026 },
  ];
  const result = computeRevisionPerYear(reports, AS_OF);
  assert('单一 forecast_year_y1 → 1 个 revision', result.length === 1);
  if (result.length) {
    assert('forecast_year_y1=2026', result[0].forecast_year_y1 === 2026);
    expectClose('recent_avg=5.5', result[0].recent_avg, 5.5);
    expectClose('baseline_avg=5.0', result[0].baseline_avg, 5.0);
    expectClose('revision=+10 %', result[0].revision, 0.1, 1e-12);
    assert('recent_count=2', result[0].recent_count === 2);
    assert('baseline_count=2', result[0].baseline_count === 2);
  }
}

console.log('\n## computeRevisionPerYear() — 多年份分组');
{
  const reports: ForecastInput[] = [
    // 2026 年度
    { report_date: '2026-04-01', forecast_eps_y1: 4.0, forecast_year_y1: 2026 },
    { report_date: '2026-05-20', forecast_eps_y1: 4.4, forecast_year_y1: 2026 },
    // 2027 年度
    { report_date: '2026-04-01', forecast_eps_y1: 6.0, forecast_year_y1: 2027 },
    { report_date: '2026-06-01', forecast_eps_y1: 5.7, forecast_year_y1: 2027 },
  ];
  const result = computeRevisionPerYear(reports, AS_OF);
  assert('2 个 forecast_year_y1 → 2 个 revision 行', result.length === 2);
  if (result.length === 2) {
    assert(
      '排序按 year asc',
      result[0].forecast_year_y1 === 2026 && result[1].forecast_year_y1 === 2027
    );
    expectClose('2026 revision = (4.4-4.0)/4.0 = +10 %', result[0].revision, 0.1, 1e-12);
    expectClose(
      '2027 revision = (5.7-6.0)/6.0 = -5 %',
      result[1].revision,
      -0.05,
      1e-12
    );
  }
}

console.log('\n## computeRevisionPerYear() — recent / baseline 窗口缺失分支');

// recent 窗口 0 条 → 该年跳过
{
  const reports: ForecastInput[] = [
    { report_date: '2026-04-01', forecast_eps_y1: 5.0, forecast_year_y1: 2026 },
    { report_date: '2026-04-15', forecast_eps_y1: 5.0, forecast_year_y1: 2026 },
  ];
  const result = computeRevisionPerYear(reports, AS_OF);
  assert('recent 0 条 → 该年跳过 → 空 result', result.length === 0);
}

// baseline 窗口 0 条 → 该年跳过
{
  const reports: ForecastInput[] = [
    { report_date: '2026-05-20', forecast_eps_y1: 5.5, forecast_year_y1: 2026 },
    { report_date: '2026-06-01', forecast_eps_y1: 5.5, forecast_year_y1: 2026 },
  ];
  const result = computeRevisionPerYear(reports, AS_OF);
  assert('baseline 0 条 → 该年跳过 → 空 result', result.length === 0);
}

// baseline avg 接近 0 → 该年跳过（避免上调比例爆炸）
{
  const reports: ForecastInput[] = [
    // baseline ≈ 0
    { report_date: '2026-04-01', forecast_eps_y1: 0.01, forecast_year_y1: 2026 },
    { report_date: '2026-04-15', forecast_eps_y1: 0.01, forecast_year_y1: 2026 },
    // recent
    { report_date: '2026-05-20', forecast_eps_y1: 1.0, forecast_year_y1: 2026 },
    { report_date: '2026-06-01', forecast_eps_y1: 1.0, forecast_year_y1: 2026 },
  ];
  const result = computeRevisionPerYear(reports, AS_OF);
  assert(
    'baseline avg=0.01 < BASELINE_ZERO_THRESHOLD=0.05 → 跳过',
    result.length === 0
  );
}

// baseline avg 是 -1.0（亏损股） → 该年通过（用绝对值做分母）
{
  const reports: ForecastInput[] = [
    { report_date: '2026-04-01', forecast_eps_y1: -1.0, forecast_year_y1: 2026 },
    { report_date: '2026-04-15', forecast_eps_y1: -1.0, forecast_year_y1: 2026 },
    { report_date: '2026-05-20', forecast_eps_y1: -0.5, forecast_year_y1: 2026 },
    { report_date: '2026-06-01', forecast_eps_y1: -0.5, forecast_year_y1: 2026 },
  ];
  const result = computeRevisionPerYear(reports, AS_OF);
  assert('亏损股 (baseline=-1) → 该年通过', result.length === 1);
  if (result.length === 1) {
    // (-0.5 - (-1.0)) / |-1.0| = 0.5 / 1.0 = +50 %
    expectClose('亏损股 revision = +50 %', result[0].revision, 0.5, 1e-12);
  }
}

console.log('\n## computeRevisionPerYear() — 数据卫生 (缺数据 / 越界日期)');

// forecast_eps_y1 / forecast_year_y1 缺数据的 record 跳过
{
  const reports: ForecastInput[] = [
    // 缺 eps
    { report_date: '2026-04-01', forecast_eps_y1: null, forecast_year_y1: 2026 },
    { report_date: '2026-04-02', forecast_eps_y1: undefined, forecast_year_y1: 2026 },
    { report_date: '2026-04-03', forecast_eps_y1: NaN, forecast_year_y1: 2026 },
    // 缺 year
    { report_date: '2026-04-04', forecast_eps_y1: 5.0, forecast_year_y1: null },
    { report_date: '2026-04-05', forecast_eps_y1: 5.0, forecast_year_y1: undefined },
    { report_date: '2026-04-06', forecast_eps_y1: 5.0, forecast_year_y1: -1 },
    { report_date: '2026-04-07', forecast_eps_y1: 5.0, forecast_year_y1: 0 },
    // 全有效
    { report_date: '2026-04-08', forecast_eps_y1: 4.0, forecast_year_y1: 2026 },
    { report_date: '2026-04-09', forecast_eps_y1: 4.0, forecast_year_y1: 2026 },
    { report_date: '2026-05-20', forecast_eps_y1: 4.8, forecast_year_y1: 2026 },
    { report_date: '2026-06-01', forecast_eps_y1: 4.8, forecast_year_y1: 2026 },
  ];
  const result = computeRevisionPerYear(reports, AS_OF);
  assert('全废数据被忽略后仍能算出 revision', result.length === 1);
  if (result.length === 1) {
    // baseline avg = 4.0; recent avg = 4.8
    expectClose('revision=+20 %', result[0].revision, 0.2, 1e-12);
    assert('baseline_count=2 (仅有效)', result[0].baseline_count === 2);
    assert('recent_count=2', result[0].recent_count === 2);
  }
}

// 超出总窗口 (> 180 天前, BD-4 后) 的 record 跳过
{
  const reports: ForecastInput[] = [
    // 200 天前 — 超出 BD-4 后的 180 天总窗口
    {
      report_date: isoDateMinusDays(new Date(`${AS_OF}T00:00:00Z`), 200),
      forecast_eps_y1: 999.0,
      forecast_year_y1: 2026,
    },
    // baseline
    { report_date: '2026-04-01', forecast_eps_y1: 5.0, forecast_year_y1: 2026 },
    { report_date: '2026-04-15', forecast_eps_y1: 5.0, forecast_year_y1: 2026 },
    // recent
    { report_date: '2026-05-20', forecast_eps_y1: 5.5, forecast_year_y1: 2026 },
    { report_date: '2026-06-01', forecast_eps_y1: 5.5, forecast_year_y1: 2026 },
  ];
  const result = computeRevisionPerYear(reports, AS_OF);
  assert(
    '超窗 200 天前的极端值被剔除 → revision 不受 999 污染 (BD-4 后 window=180d)',
    result.length === 1
  );
  if (result.length === 1) {
    expectClose('revision=+10 % (未被 999 污染)', result[0].revision, 0.1, 1e-12);
  }
}

// report_date 晚于 as_of_date 的 record 跳过（防止未来数据泄漏）
{
  const reports: ForecastInput[] = [
    // 未来日期 — 必须剔除
    { report_date: '2026-06-10', forecast_eps_y1: 999.0, forecast_year_y1: 2026 },
    { report_date: '2026-04-01', forecast_eps_y1: 5.0, forecast_year_y1: 2026 },
    { report_date: '2026-04-15', forecast_eps_y1: 5.0, forecast_year_y1: 2026 },
    { report_date: '2026-05-20', forecast_eps_y1: 5.5, forecast_year_y1: 2026 },
    { report_date: '2026-06-01', forecast_eps_y1: 5.5, forecast_year_y1: 2026 },
  ];
  const result = computeRevisionPerYear(reports, AS_OF);
  assert('未来日期被剔除 → revision 不受未来值污染', result.length === 1);
  if (result.length === 1) {
    expectClose('revision=+10 % (未被未来值污染)', result[0].revision, 0.1, 1e-12);
  }
}

// 持平 (recent == baseline) → revision = 0
{
  const reports: ForecastInput[] = [
    { report_date: '2026-04-01', forecast_eps_y1: 5.0, forecast_year_y1: 2026 },
    { report_date: '2026-05-20', forecast_eps_y1: 5.0, forecast_year_y1: 2026 },
  ];
  const result = computeRevisionPerYear(reports, AS_OF);
  assert('持平 → revision=0', result.length === 1 && result[0].revision === 0);
}

// 下调 (recent < baseline) → revision < 0
{
  const reports: ForecastInput[] = [
    { report_date: '2026-04-01', forecast_eps_y1: 10.0, forecast_year_y1: 2026 },
    { report_date: '2026-05-20', forecast_eps_y1: 8.0, forecast_year_y1: 2026 },
  ];
  const result = computeRevisionPerYear(reports, AS_OF);
  assert('下调 → revision<0', result.length === 1 && result[0].revision < 0);
  if (result.length === 1) {
    expectClose('revision=-20 %', result[0].revision, -0.2, 1e-12);
  }
}

console.log('\n## aggregateRevisions()');
assert('空数组 → null', aggregateRevisions([]) === null);
{
  // 单 year
  const result = aggregateRevisions([
    {
      forecast_year_y1: 2026,
      recent_avg: 5.5,
      baseline_avg: 5.0,
      revision: 0.1,
      recent_count: 2,
      baseline_count: 2,
    },
  ]);
  expectClose('单 year → 该 year revision', result ?? -999, 0.1, 1e-12);
}
{
  // 多 year 算数均值
  const result = aggregateRevisions([
    {
      forecast_year_y1: 2026,
      recent_avg: 5.5,
      baseline_avg: 5.0,
      revision: 0.1,
      recent_count: 2,
      baseline_count: 2,
    },
    {
      forecast_year_y1: 2027,
      recent_avg: 5.7,
      baseline_avg: 6.0,
      revision: -0.05,
      recent_count: 2,
      baseline_count: 2,
    },
  ]);
  // (0.1 + -0.05) / 2 = 0.025
  expectClose('多 year → 算数均值', result ?? -999, 0.025, 1e-12);
}

console.log('\n## Factor metadata + 注册');
assert('name = analyst_consensus', analystConsensusFactor.name === 'analyst_consensus');
assert('category = sentiment', analystConsensusFactor.category === 'sentiment');
assert(
  'description 非空',
  typeof analystConsensusFactor.description === 'string' &&
    analystConsensusFactor.description.length > 0
);
assert('compute 是函数', typeof analystConsensusFactor.compute === 'function');
assert('已注册到 factorRegistry', factorRegistry.has('analyst_consensus'));
assert(
  '已纳入 listNames()',
  factorRegistry.listNames().includes('analyst_consensus')
);
assert(
  'registry get 同一对象',
  factorRegistry.get('analyst_consensus') === analystConsensusFactor
);

console.log('\n## 常量');
assert('RECENT_WINDOW_DAYS=30', RECENT_WINDOW_DAYS === 30);
assert('TOTAL_WINDOW_DAYS=180 (BD-4 relaxed from 90)', TOTAL_WINDOW_DAYS === 180);
assert('MIN_REPORTS_TOTAL=3 (BD-4 relaxed from 5)', MIN_REPORTS_TOTAL === 3);
assert('BASELINE_ZERO_THRESHOLD=0.05', BASELINE_ZERO_THRESHOLD === 0.05);

console.log('\n## 空 universe 路径不爆');
{
  const result = analystConsensusFactor.compute({ as_of_date: AS_OF, universe: [] });
  // result is a Promise<Map>
  result.then(m => {
    assert('空 universe → 空 Map', m.size === 0);
  });
}

console.log('\n## 端到端模拟：3 firm × 2 year × 4 期 → ≥ MIN_REPORTS_TOTAL');
{
  // 单只股票模拟：3 家券商对 2026/2027 两个年度的预测
  // recent (近 30 天) 上调，baseline (60 天前) 持平 → revision 正
  const reports: ForecastInput[] = [
    // baseline 区间 (≈ 60-80 天前 = 2026-03-25 ~ 2026-04-08)
    { report_date: '2026-04-01', forecast_eps_y1: 4.0, forecast_year_y1: 2026 },
    { report_date: '2026-04-02', forecast_eps_y1: 4.0, forecast_year_y1: 2026 },
    { report_date: '2026-04-03', forecast_eps_y1: 4.0, forecast_year_y1: 2026 },
    { report_date: '2026-04-01', forecast_eps_y1: 5.0, forecast_year_y1: 2027 },
    { report_date: '2026-04-02', forecast_eps_y1: 5.0, forecast_year_y1: 2027 },
    { report_date: '2026-04-03', forecast_eps_y1: 5.0, forecast_year_y1: 2027 },
    // recent 区间 (近 20 天 = 2026-05-18 ~ 2026-06-07)
    { report_date: '2026-05-20', forecast_eps_y1: 4.4, forecast_year_y1: 2026 },
    { report_date: '2026-05-25', forecast_eps_y1: 4.4, forecast_year_y1: 2026 },
    { report_date: '2026-06-01', forecast_eps_y1: 4.4, forecast_year_y1: 2026 },
    { report_date: '2026-05-20', forecast_eps_y1: 5.5, forecast_year_y1: 2027 },
    { report_date: '2026-05-25', forecast_eps_y1: 5.5, forecast_year_y1: 2027 },
    { report_date: '2026-06-01', forecast_eps_y1: 5.5, forecast_year_y1: 2027 },
  ];
  const perYear = computeRevisionPerYear(reports, AS_OF);
  assert('2 年度都通过 → 2 个 revision', perYear.length === 2);
  const agg = aggregateRevisions(perYear);
  // 两年都是 +10 % → 均值 +10 %
  expectClose('聚合 = +10 %', agg ?? -999, 0.1, 1e-12);
}

console.log('\n========================================');
console.log(`Total: passed=${passed}  failed=${failed}`);
console.log('========================================');

setTimeout(() => {
  if (failed > 0) {
    console.error('\n❌ tests failed');
    process.exit(1);
  } else {
    console.log('\n✅ all tests pass');
    process.exit(0);
  }
}, 100); // allow the空 universe Promise to settle
