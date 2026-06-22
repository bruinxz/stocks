/**
 * EarningsSurpriseFactor 单元测试 (US-032).
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/factors/EarningsSurpriseFactor.test.ts
 *
 * 覆盖：
 *   - 纯函数 mean (空 / 单元素 / 多元素)
 *   - 纯函数 isoDateMinusDays / isoDatePlusDays (含 0 / 跨月 / 跨年)
 *   - 纯函数 yearOfIsoDate (合法 / 非法 / 空)
 *   - 纯函数 computeSurprise:
 *     - 正常：actual=1.2, consensus=1.0 → 0.20 (20% 超预期)
 *     - miss：actual=0.8, consensus=1.0 → -0.20 (20% 不及预期)
 *     - consensus 接近 0 (亏损股) → null
 *     - actual = consensus → 0
 *     - 任一 NaN/Infinity → null
 *     - null/undefined → null
 *     - 自定义 nearZeroThreshold
 *     - 负 consensus 取绝对值（正确）
 *   - 纯函数 selectFreshestReport:
 *     - 空数组 → null
 *     - 全 stale → null
 *     - 多份候选取 report_date 最大
 *     - report_date > as_of_date 防 lookahead → 跳过
 *     - 自定义 windowDays
 *   - 纯函数 buildConsensusEps:
 *     - 不足 minReports → null
 *     - forecast.report_date >= actualReportDate → 排除（严格小于）
 *     - forecast.report_date < cutoff → 排除
 *     - forecast.forecast_year_y1 != year(actualReportDate) → 排除
 *     - forecast.forecast_eps_y1 null/NaN → 排除
 *     - actualReportDate 非法格式 → null
 *     - 自定义 lookback + minReports
 *     - 跨年度禁止（US-030 同款约束）
 *   - Factor metadata (name='earnings_surprise' / category='event' /
 *     description 非空且含 "代理" / compute 是函数 / 已注册 / listNames 含 /
 *     get 拿回同对象)
 *   - 端到端：compute(ctx={ universe: [] }) → 空 Map（不爆）
 *   - 常量校验 POST_REPORT_WINDOW_DAYS / CONSENSUS_LOOKBACK_DAYS /
 *     MIN_CONSENSUS_REPORTS / ACTUAL_EPS_LOOKAHEAD_DAYS /
 *     CONSENSUS_NEAR_ZERO_THRESHOLD
 *
 * 与 QualityHighFactor.test.ts (US-031) / AnalystConsensusFactor.test.ts (US-030)
 * / LiquidityFactor.test.ts (US-029) 同款节奏：测试纯函数 + 元数据 + 空 universe
 * 路径不爆。compute 内涉及 DB 的部分由生产场景验证。
 */

import {
  earningsSurpriseFactor,
  mean,
  isoDateMinusDays,
  isoDatePlusDays,
  yearOfIsoDate,
  computeSurprise,
  selectFreshestReport,
  buildConsensusEps,
  extractActualEpsFromReport,
  POST_REPORT_WINDOW_DAYS,
  CONSENSUS_LOOKBACK_DAYS,
  MIN_CONSENSUS_REPORTS,
  ACTUAL_EPS_LOOKAHEAD_DAYS,
  CONSENSUS_NEAR_ZERO_THRESHOLD,
} from '../../src/quant/factors/library/EarningsSurpriseFactor';
import { factorRegistry } from '../../src/quant/factors/FactorRegistry';
// 触发 library 自我登记
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

console.log('\n## 纯函数 mean');
expectClose('空数组 → 0', mean([]), 0);
expectClose('单元素 → 它本身', mean([3.14]), 3.14);
expectClose('多元素 → 算术均值', mean([1, 2, 3, 4]), 2.5);
expectClose('含负数', mean([-1, 0, 1]), 0);
expectClose('小数精度', mean([0.1, 0.2, 0.3]), 0.2, 1e-9);

console.log('\n## 纯函数 isoDateMinusDays');
assert('0 天 → 同日', isoDateMinusDays('2025-06-15', 0) === '2025-06-15');
assert('1 天 → 前 1 日', isoDateMinusDays('2025-06-15', 1) === '2025-06-14');
assert(
  '30 天 → 跨月（5 月 16 日）',
  isoDateMinusDays('2025-06-15', 30) === '2025-05-16',
  isoDateMinusDays('2025-06-15', 30)
);
assert(
  '180 天 → 半年前',
  isoDateMinusDays('2025-06-15', 180) === '2024-12-17',
  isoDateMinusDays('2025-06-15', 180)
);
assert('365 天 → 一年前同月', isoDateMinusDays('2025-06-15', 365) === '2024-06-15');
assert('负数 days → clamp 到 0 → 同日', isoDateMinusDays('2025-06-15', -10) === '2025-06-15');

console.log('\n## 纯函数 isoDatePlusDays');
assert('0 天 → 同日', isoDatePlusDays('2025-06-15', 0) === '2025-06-15');
assert(
  '30 天 → 跨月',
  isoDatePlusDays('2025-06-15', 30) === '2025-07-15',
  isoDatePlusDays('2025-06-15', 30)
);
assert(
  '365 天 → 一年后',
  isoDatePlusDays('2025-06-15', 365) === '2026-06-15',
  isoDatePlusDays('2025-06-15', 365)
);
assert('负数 days → clamp 到 0', isoDatePlusDays('2025-06-15', -10) === '2025-06-15');

console.log('\n## 纯函数 yearOfIsoDate');
assert('2024-12-31 → 2024', yearOfIsoDate('2024-12-31') === 2024);
assert('2025-01-01 → 2025', yearOfIsoDate('2025-01-01') === 2025);
assert('空字符串 → null', yearOfIsoDate('') === null);
// @ts-expect-error 测试非字符串输入
assert('null 输入 → null', yearOfIsoDate(null) === null);
assert('非法格式 (无 dash) → null', yearOfIsoDate('20241231') === null);
assert('非法格式 (短年) → null', yearOfIsoDate('24-12-31') === null);

console.log('\n## 纯函数 computeSurprise');
expectClose('正常超预期: actual=1.2 / cons=1.0 → 0.20', computeSurprise(1.2, 1.0)!, 0.2);
expectClose('miss: actual=0.8 / cons=1.0 → -0.20', computeSurprise(0.8, 1.0)!, -0.2);
expectClose('actual = consensus → 0', computeSurprise(1.0, 1.0)!, 0);
assert(
  'consensus 接近 0 (0.005 < 0.01 default) → null',
  computeSurprise(1.0, 0.005) === null
);
assert(
  'consensus = 0 → null',
  computeSurprise(1.0, 0) === null
);
assert('actual NaN → null', computeSurprise(NaN, 1.0) === null);
assert('consensus NaN → null', computeSurprise(1.0, NaN) === null);
assert('actual Infinity → null', computeSurprise(Infinity, 1.0) === null);
assert('actual null → null', computeSurprise(null, 1.0) === null);
assert('consensus null → null', computeSurprise(1.0, null) === null);
assert('actual undefined → null', computeSurprise(undefined, 1.0) === null);
assert('consensus undefined → null', computeSurprise(1.0, undefined) === null);
expectClose(
  '负 consensus 取绝对值: actual=-0.5 / cons=-1.0 → (-0.5 - (-1.0)) / |-1.0| = 0.5',
  computeSurprise(-0.5, -1.0)!,
  0.5
);
expectClose(
  'string 输入也转 Number: actual="1.2" / cons=1.0 → 0.20',
  computeSurprise('1.2' as any, 1.0)!,
  0.2
);
expectClose(
  '自定义 nearZeroThreshold=0.1: cons=0.05 → null (< 0.1)',
  // @ts-expect-error
  computeSurprise(1.0, 0.05, 0.1) === null ? -999 : -1000,
  -999
);
expectClose(
  '自定义 nearZeroThreshold=0.001: cons=0.005 → 应可通过 (> 0.001)',
  computeSurprise(1.0, 0.005, 0.001)!,
  (1.0 - 0.005) / 0.005,
  1e-9
);

console.log('\n## 纯函数 selectFreshestReport');
{
  assert(
    '空数组 → null',
    selectFreshestReport([], '2025-06-15') === null
  );
  // 全 stale（> 180 天前）
  assert(
    '全 stale → null',
    selectFreshestReport(
      [
        { report_date: '2024-01-01' },
        { report_date: '2024-06-01' },
      ],
      '2025-06-15'
    ) === null
  );
  // 一份在窗口内 → 选它
  const r1 = selectFreshestReport(
    [{ report_date: '2025-03-31' }, { report_date: '2024-12-31' }],
    '2025-06-15'
  );
  assert(
    '多份候选取最新',
    r1?.report_date === '2025-03-31',
    r1?.report_date
  );
  // 防 lookahead：report_date > as_of_date 应被剔除
  const r2 = selectFreshestReport(
    [{ report_date: '2025-09-30' }, { report_date: '2025-03-31' }],
    '2025-06-15'
  );
  assert(
    '防 lookahead: 跳过 as_of_date 之后的 report',
    r2?.report_date === '2025-03-31',
    r2?.report_date
  );
  // 自定义 windowDays
  const r3 = selectFreshestReport(
    [{ report_date: '2025-03-31' }],
    '2025-06-15',
    30 // 30 天窗口，距 76 天 > 30 → stale
  );
  assert('自定义 windowDays=30 → null', r3 === null);
  // 边界：report_date == cutoff (距 180 天)
  const r4 = selectFreshestReport(
    [{ report_date: '2024-12-17' }], // 距 2025-06-15 是 180 天
    '2025-06-15',
    180
  );
  assert(
    '边界 distance = window → 包含',
    r4?.report_date === '2024-12-17',
    r4?.report_date
  );
}

console.log('\n## 纯函数 buildConsensusEps');
{
  // 不足 minReports → null
  const c1 = buildConsensusEps(
    [
      { report_date: '2025-01-15', forecast_eps_y1: 1.0, forecast_year_y1: 2025 },
      { report_date: '2025-02-15', forecast_eps_y1: 1.1, forecast_year_y1: 2025 },
    ],
    '2025-04-30'
  );
  assert('2 < MIN_CONSENSUS_REPORTS=3 → null', c1 === null);

  // 恰好 3 份 → 均值
  const c2 = buildConsensusEps(
    [
      { report_date: '2025-01-15', forecast_eps_y1: 1.0, forecast_year_y1: 2025 },
      { report_date: '2025-02-15', forecast_eps_y1: 1.1, forecast_year_y1: 2025 },
      { report_date: '2025-03-15', forecast_eps_y1: 1.2, forecast_year_y1: 2025 },
    ],
    '2025-04-30'
  );
  expectClose('3 份均值', c2!, (1.0 + 1.1 + 1.2) / 3);

  // forecast.report_date == actualReportDate → 排除（严格 <）
  const c3 = buildConsensusEps(
    [
      { report_date: '2025-04-30', forecast_eps_y1: 0.5, forecast_year_y1: 2025 }, // EQ actual
      { report_date: '2025-04-29', forecast_eps_y1: 1.0, forecast_year_y1: 2025 },
      { report_date: '2025-04-28', forecast_eps_y1: 1.1, forecast_year_y1: 2025 },
      { report_date: '2025-04-27', forecast_eps_y1: 1.2, forecast_year_y1: 2025 },
    ],
    '2025-04-30'
  );
  expectClose('排除 report_date == actualReportDate', c3!, (1.0 + 1.1 + 1.2) / 3);

  // forecast.report_date > actualReportDate → 排除
  const c4 = buildConsensusEps(
    [
      { report_date: '2025-05-15', forecast_eps_y1: 0.5, forecast_year_y1: 2025 }, // > actual
      { report_date: '2025-04-15', forecast_eps_y1: 1.0, forecast_year_y1: 2025 },
      { report_date: '2025-03-15', forecast_eps_y1: 1.1, forecast_year_y1: 2025 },
      { report_date: '2025-02-15', forecast_eps_y1: 1.2, forecast_year_y1: 2025 },
    ],
    '2025-04-30'
  );
  expectClose('排除事后 review', c4!, (1.0 + 1.1 + 1.2) / 3);

  // 跨年度禁止（forecast_year_y1 != year(actualReportDate)）
  const c5 = buildConsensusEps(
    [
      { report_date: '2025-01-15', forecast_eps_y1: 1.0, forecast_year_y1: 2024 }, // wrong year
      { report_date: '2025-02-15', forecast_eps_y1: 1.1, forecast_year_y1: 2024 },
      { report_date: '2025-03-15', forecast_eps_y1: 1.2, forecast_year_y1: 2025 },
    ],
    '2025-04-30'
  );
  assert('只剩 1 份同年度 < minReports=3 → null', c5 === null);

  // 全跨年度 → null
  const c6 = buildConsensusEps(
    [
      { report_date: '2025-01-15', forecast_eps_y1: 1.0, forecast_year_y1: 2024 },
      { report_date: '2025-02-15', forecast_eps_y1: 1.1, forecast_year_y1: 2024 },
      { report_date: '2025-03-15', forecast_eps_y1: 1.2, forecast_year_y1: 2024 },
    ],
    '2025-04-30'
  );
  assert('3 份全跨年度 → null', c6 === null);

  // forecast_eps_y1 null/NaN → 排除
  const c7 = buildConsensusEps(
    [
      { report_date: '2025-01-15', forecast_eps_y1: null, forecast_year_y1: 2025 },
      { report_date: '2025-02-15', forecast_eps_y1: NaN as any, forecast_year_y1: 2025 },
      { report_date: '2025-03-15', forecast_eps_y1: 1.2, forecast_year_y1: 2025 },
    ],
    '2025-04-30'
  );
  assert('null/NaN 排除后 < minReports → null', c7 === null);

  // 全 valid，超 lookback 的被排除
  const c8 = buildConsensusEps(
    [
      { report_date: '2024-08-01', forecast_eps_y1: 999, forecast_year_y1: 2025 }, // < cutoff (180 天前)
      { report_date: '2025-01-15', forecast_eps_y1: 1.0, forecast_year_y1: 2025 },
      { report_date: '2025-02-15', forecast_eps_y1: 1.1, forecast_year_y1: 2025 },
      { report_date: '2025-03-15', forecast_eps_y1: 1.2, forecast_year_y1: 2025 },
    ],
    '2025-04-30'
  );
  expectClose('超 lookback 被排除', c8!, (1.0 + 1.1 + 1.2) / 3);

  // 自定义 lookback=30，更窄的窗口
  const c9 = buildConsensusEps(
    [
      { report_date: '2025-01-15', forecast_eps_y1: 1.0, forecast_year_y1: 2025 }, // > 30d before
      { report_date: '2025-04-10', forecast_eps_y1: 1.5, forecast_year_y1: 2025 },
      { report_date: '2025-04-15', forecast_eps_y1: 1.6, forecast_year_y1: 2025 },
      { report_date: '2025-04-20', forecast_eps_y1: 1.7, forecast_year_y1: 2025 },
    ],
    '2025-04-30',
    30
  );
  expectClose('自定义 lookback=30 排除老数据', c9!, (1.5 + 1.6 + 1.7) / 3);

  // 自定义 minReports=2，2 份即可
  const c10 = buildConsensusEps(
    [
      { report_date: '2025-01-15', forecast_eps_y1: 1.0, forecast_year_y1: 2025 },
      { report_date: '2025-02-15', forecast_eps_y1: 1.1, forecast_year_y1: 2025 },
    ],
    '2025-04-30',
    CONSENSUS_LOOKBACK_DAYS,
    2
  );
  expectClose('自定义 minReports=2 → 均值', c10!, 1.05);

  // actualReportDate 非法格式 → null
  const c11 = buildConsensusEps(
    [
      { report_date: '2025-01-15', forecast_eps_y1: 1.0, forecast_year_y1: 2025 },
      { report_date: '2025-02-15', forecast_eps_y1: 1.1, forecast_year_y1: 2025 },
      { report_date: '2025-03-15', forecast_eps_y1: 1.2, forecast_year_y1: 2025 },
    ],
    'invalid-date'
  );
  assert('actualReportDate 非法 → null', c11 === null);

  // 空数组
  assert('空 forecasts → null', buildConsensusEps([], '2025-04-30') === null);

  // forecast_year_y1 null → 排除
  const c12 = buildConsensusEps(
    [
      { report_date: '2025-01-15', forecast_eps_y1: 1.0, forecast_year_y1: null },
      { report_date: '2025-02-15', forecast_eps_y1: 1.1, forecast_year_y1: undefined },
      { report_date: '2025-03-15', forecast_eps_y1: 1.2, forecast_year_y1: 2025 },
    ],
    '2025-04-30'
  );
  assert('forecast_year_y1 null/undefined 排除后 < minReports → null', c12 === null);

  // 大量 valid 全保留
  const c13 = buildConsensusEps(
    [
      { report_date: '2025-01-15', forecast_eps_y1: 1.0, forecast_year_y1: 2025 },
      { report_date: '2025-02-01', forecast_eps_y1: 1.1, forecast_year_y1: 2025 },
      { report_date: '2025-02-15', forecast_eps_y1: 1.2, forecast_year_y1: 2025 },
      { report_date: '2025-03-01', forecast_eps_y1: 1.3, forecast_year_y1: 2025 },
      { report_date: '2025-03-15', forecast_eps_y1: 1.4, forecast_year_y1: 2025 },
      { report_date: '2025-04-01', forecast_eps_y1: 1.5, forecast_year_y1: 2025 },
    ],
    '2025-04-30'
  );
  expectClose('6 份全保留', c13!, (1.0 + 1.1 + 1.2 + 1.3 + 1.4 + 1.5) / 6);
}

console.log('\n## 常量校验');
assert(
  `POST_REPORT_WINDOW_DAYS = 180 (得到 ${POST_REPORT_WINDOW_DAYS})`,
  POST_REPORT_WINDOW_DAYS === 180
);
assert(
  `CONSENSUS_LOOKBACK_DAYS = 180 (得到 ${CONSENSUS_LOOKBACK_DAYS})`,
  CONSENSUS_LOOKBACK_DAYS === 180
);
assert(
  `MIN_CONSENSUS_REPORTS = 3 (得到 ${MIN_CONSENSUS_REPORTS})`,
  MIN_CONSENSUS_REPORTS === 3
);
assert(
  `ACTUAL_EPS_LOOKAHEAD_DAYS = 150 (得到 ${ACTUAL_EPS_LOOKAHEAD_DAYS})`,
  ACTUAL_EPS_LOOKAHEAD_DAYS === 150
);
assert(
  `CONSENSUS_NEAR_ZERO_THRESHOLD = 0.01 (得到 ${CONSENSUS_NEAR_ZERO_THRESHOLD})`,
  CONSENSUS_NEAR_ZERO_THRESHOLD === 0.01
);

console.log('\n## Factor metadata');
assert(`name = 'earnings_surprise' (实际 ${earningsSurpriseFactor.name})`, earningsSurpriseFactor.name === 'earnings_surprise');
assert(`category = 'event' (实际 ${earningsSurpriseFactor.category})`, earningsSurpriseFactor.category === 'event');
assert(
  'description 非空',
  typeof earningsSurpriseFactor.description === 'string' && earningsSurpriseFactor.description.length > 0
);
assert(
  'description 含 "代理" (按 US-031 代理替代范式)',
  earningsSurpriseFactor.description.includes('代理')
);
assert('compute 是函数', typeof earningsSurpriseFactor.compute === 'function');

console.log('\n## Registry 集成');
assert("registry.has('earnings_surprise')", factorRegistry.has('earnings_surprise'));
assert(
  "registry.listNames() 含 'earnings_surprise'",
  factorRegistry.listNames().includes('earnings_surprise')
);
assert(
  "registry.get('earnings_surprise') 返回同对象",
  factorRegistry.get('earnings_surprise') === earningsSurpriseFactor
);
// 其他既有因子未被破坏
assert("既有 'analyst_consensus' 仍注册", factorRegistry.has('analyst_consensus'));
assert("既有 'quality' 仍注册", factorRegistry.has('quality'));
assert("既有 'quality_high' 仍注册", factorRegistry.has('quality_high'));
assert("既有 'value' 仍注册", factorRegistry.has('value'));
assert("既有 'liquidity' 仍注册", factorRegistry.has('liquidity'));

// Sprint 38: 不硬编码 registry 总数 — 改为断言"至少含 earnings_surprise + 不少于
// 17 个" (该 test 写于注册 18 个 factor 那个 sprint, 之后陆续加因子总数会涨,
// 但 earnings_surprise 必须仍在).
{
  const names = factorRegistry.listNames();
  assert(
    `registry 含 earnings_surprise + 至少 17 个因子 (实际 ${names.length})`,
    names.length >= 17 && names.includes('earnings_surprise'),
    names.join(', ')
  );
}

console.log('\n## 端到端：空 universe → 空 Map');
{
  (async () => {
    const out = await earningsSurpriseFactor.compute({
      as_of_date: '2025-06-15',
      universe: [],
    });
    assert('空 universe → Map size = 0', out.size === 0);

    // -------------------------------------------------------------------
    // Batch BA (2026-06-22) 新增: extractActualEpsFromReport 纯函数 + 端到端
    // -------------------------------------------------------------------
    console.log('\n## Batch BA 纯函数 extractActualEpsFromReport');
    {
      const payload1 = {
        abstract_row: { revenue: 5e10, net_profit: 2e10 },
        indicator_row: {
          '摊薄每股收益(元)': 22.4822,
          '加权每股收益(元)': 21.76,
        },
      };
      assert(
        '正常 payload → 取摊薄 EPS 22.4822',
        extractActualEpsFromReport(payload1) === 22.4822
      );

      // 摊薄缺 → fallback 加权
      const payload2 = {
        indicator_row: {
          '摊薄每股收益(元)': null,
          '加权每股收益(元)': 1.5,
        },
      };
      assert('摊薄 null → fallback 加权 1.5', extractActualEpsFromReport(payload2) === 1.5);

      // 摊薄 + 加权都缺 → fallback 调整后
      const payload3 = {
        indicator_row: {
          '摊薄每股收益(元)': null,
          '加权每股收益(元)': null,
          '每股收益_调整后(元)': 0.88,
        },
      };
      assert('摊薄+加权缺 → fallback 调整后 0.88', extractActualEpsFromReport(payload3) === 0.88);

      // 全 null → null
      const payload4 = {
        indicator_row: {
          '摊薄每股收益(元)': null,
          '加权每股收益(元)': null,
          '每股收益_调整后(元)': null,
        },
      };
      assert('3 字段全 null → null', extractActualEpsFromReport(payload4) === null);

      // string DECIMAL (Sequelize raw_payload 偶尔出 string 数字)
      const payload5 = {
        indicator_row: { '摊薄每股收益(元)': '5.55' },
      };
      assert('string DECIMAL → 转 Number 5.55', extractActualEpsFromReport(payload5) === 5.55);

      // NaN → 跳过
      const payload6 = {
        indicator_row: {
          '摊薄每股收益(元)': NaN,
          '加权每股收益(元)': 1.2,
        },
      };
      assert('NaN 字段 → 跳到 fallback 1.2', extractActualEpsFromReport(payload6) === 1.2);

      // 完全空 / 缺 indicator_row / 缺 raw_payload
      assert('空 payload → null', extractActualEpsFromReport({}) === null);
      assert('缺 indicator_row → null', extractActualEpsFromReport({ abstract_row: {} }) === null);
      assert('null payload → null', extractActualEpsFromReport(null) === null);
      assert('undefined payload → null', extractActualEpsFromReport(undefined) === null);
      assert(
        'indicator_row 非 object → null',
        extractActualEpsFromReport({ indicator_row: 'not-object' } as any) === null
      );

      // 负 EPS (亏损股)
      const payload7 = {
        indicator_row: { '摊薄每股收益(元)': -0.5 },
      };
      assert('负 EPS (-0.5) → 仍返回', extractActualEpsFromReport(payload7) === -0.5);
    }

    // -------------------------------------------------------------------
    // Batch BA 端到端: FinancialReport-only 数据源 (无需 StockFundamentalFactor)
    // -------------------------------------------------------------------
    console.log('\n## Batch BA 端到端: FinancialReport 自带 EPS');
    {
      const FRModel = require('../../src/models/FinancialReport').FinancialReport;
      const AFModel = require('../../src/models/AnalystForecast').AnalystForecast;
      const origFRFind = FRModel.findAll;
      const origAFFind = AFModel.findAll;

      // 场景: 茅台 2026-03-31 一季报, 摊薄 EPS=22.4822 vs 一致预期 EPS≈68 (年度)
      // 因为 forecast_year_y1=2026 必须等于 year(report_date)=2026 才匹配
      FRModel.findAll = async () => [
        {
          stock_code: '600519',
          report_date: '2026-03-31',
          report_type: '一季报',
          raw_payload: {
            indicator_row: { '摊薄每股收益(元)': 22.4822 },
          },
        },
      ];
      // 3 份研报 EPS=20 (用 2026 年作为 y1), report_date 在 2026-03-31 之前
      AFModel.findAll = async () => [
        {
          stock_code: '600519',
          report_date: '2026-01-15',
          forecast_eps_y1: 20.0,
          forecast_year_y1: 2026,
        },
        {
          stock_code: '600519',
          report_date: '2026-02-10',
          forecast_eps_y1: 20.0,
          forecast_year_y1: 2026,
        },
        {
          stock_code: '600519',
          report_date: '2026-03-05',
          forecast_eps_y1: 20.0,
          forecast_year_y1: 2026,
        },
      ];
      const outE2E1 = await earningsSurpriseFactor.compute({
        universe: ['600519'],
        as_of_date: '2026-06-18',
      } as any);
      assert('FinancialReport actual 22.4822 vs consensus 20.0 → surprise (22.4822-20)/20', outE2E1.size === 1);
      const surprise = outE2E1.get('600519') as number;
      const expected = (22.4822 - 20.0) / 20.0;
      assert(
        `600519 surprise ≈ ${expected.toFixed(6)} (实际 ${surprise?.toFixed(6)})`,
        Math.abs(surprise - expected) < 1e-9
      );

      // 场景: raw_payload 缺 EPS 字段 → 该股票被跳过
      FRModel.findAll = async () => [
        {
          stock_code: '600519',
          report_date: '2026-03-31',
          report_type: '一季报',
          raw_payload: { indicator_row: {} }, // 无 EPS 字段
        },
      ];
      const outE2E2 = await earningsSurpriseFactor.compute({
        universe: ['600519'],
        as_of_date: '2026-06-18',
      } as any);
      assert('raw_payload 缺 EPS → Map 空 (BA fetch=0 bug 回归)', outE2E2.size === 0);

      // 场景: raw_payload = null → 跳过
      FRModel.findAll = async () => [
        {
          stock_code: '600519',
          report_date: '2026-03-31',
          report_type: '一季报',
          raw_payload: null,
        },
      ];
      const outE2E3 = await earningsSurpriseFactor.compute({
        universe: ['600519'],
        as_of_date: '2026-06-18',
      } as any);
      assert('raw_payload=null → Map 空', outE2E3.size === 0);

      // restore
      FRModel.findAll = origFRFind;
      AFModel.findAll = origAFFind;
    }

    console.log('\n----------------------------------------------------------------');
    console.log(`Summary: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })().catch(err => {
    console.error('Unexpected error during async test:', err);
    process.exit(1);
  });
}
