/**
 * QualityHighFactor 单元测试 (US-031).
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/factors/QualityHighFactor.test.ts
 *
 * 覆盖：
 *   - 纯函数 sampleStddev (与 LiquidityFactor 同口径但本地副本：空 / 1 个 /
 *     n-1 正确 / 全相等 → 0)
 *   - 纯函数 computeGrossMarginStability:
 *     - 不足 MIN_GROSS_MARGIN_OBSERVATIONS (3, BD-3 relax) → null
 *     - 恰好 5 个 → 算正确（1/stddev）
 *     - 全相等（sd=0）→ 应用 MIN_GROSS_MARGIN_SD clamp 后返回 1/MIN_GROSS_MARGIN_SD
 *     - sd 极小（< MIN_GROSS_MARGIN_SD）→ clamp 到 1/MIN_GROSS_MARGIN_SD
 *     - 全 NaN → null
 *     - 混合 valid + NaN → 取 valid 的 sd
 *     - 6 个 → 算 6 个 sd
 *   - 纯函数 computeNetMargin:
 *     - 正常：net=20, rev=100 → 20%
 *     - 亏损：net=-10, rev=100 → -10%
 *     - revenue=0 → null
 *     - revenue<0 → null
 *     - net=NaN → null
 *     - rev=NaN → null
 *     - net=null/undefined → null
 *     - rev=null/undefined → null
 *     - string 输入也转 Number （rev='100', net='5' → 5）
 *   - 纯函数 combineQualityHigh:
 *     - 任一 null → null
 *     - 任一 Infinity / NaN → null
 *     - 全有效 → 三项均值
 *     - 负数 + 正数混合 → 算术均值（含符号）
 *   - Factor metadata (name='quality_high' / category='quality' / description
 *     非空 / compute 是函数 / 已注册到 factorRegistry / listNames() 含 / get()
 *     拿回同对象)
 *   - 端到端：compute(ctx={ universe: [] }) → 空 Map（不爆）
 *   - 常量校验 MIN_GROSS_MARGIN_OBSERVATIONS=5 / MIN_GROSS_MARGIN_SD=0.05 /
 *     ANNUAL_REPORT_LOOKBACK_DAYS / GROSS_MARGIN_LOOKBACK_DAYS
 */

import {
  qualityHighFactor,
  sampleStddev,
  computeGrossMarginStability,
  computeNetMargin,
  combineQualityHigh,
  MIN_GROSS_MARGIN_OBSERVATIONS,
  MIN_GROSS_MARGIN_SD,
  ANNUAL_REPORT_LOOKBACK_DAYS,
  GROSS_MARGIN_LOOKBACK_DAYS,
} from '../../src/quant/factors/library/QualityHighFactor';
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

console.log('\n## sampleStddev 边界 (本地副本)');
expectClose('空数组 → 0', sampleStddev([]), 0);
expectClose('单元素 → 0 (< 2 sample)', sampleStddev([42]), 0);
expectClose(
  '常规 [2,4,4,4,5,5,7,9] sample (n-1) → √(32/7) ≈ 2.138',
  sampleStddev([2, 4, 4, 4, 5, 5, 7, 9]),
  Math.sqrt(32 / 7),
  1e-9
);
expectClose('全相等 → 0', sampleStddev([3, 3, 3, 3]), 0);
expectClose(
  '两个不同 → √((x-y)²/2*2/1)，[10,20] → √50',
  sampleStddev([10, 20]),
  Math.sqrt(50),
  1e-9
);

console.log('\n## computeGrossMarginStability');
{
  // 不足 3 个有效观测 → null (BD-3 relax: 阈值 5 → 3)
  assert('空数组 → null', computeGrossMarginStability([]) === null);
  assert('2 个 → null (< MIN_GROSS_MARGIN_OBSERVATIONS=3)', computeGrossMarginStability([20, 21]) === null);
  // 恰好 3 个 → 算正常 1/sd (BD-3 边界)
  const three = [20, 21, 19];
  const sd3 = sampleStddev(three);
  const score3 = computeGrossMarginStability(three);
  assert(
    `恰好 3 个（BD-3 新阈值），应该正常返回 1/sd (sd=${sd3.toFixed(4)})`,
    score3 !== null && near(score3, 1 / sd3)
  );
  // 5 个仍正常
  const five = [20, 21, 19, 22, 18];
  const sd5 = sampleStddev(five);
  const score5 = computeGrossMarginStability(five);
  assert(
    `5 个仍正常 (sd=${sd5.toFixed(4)})`,
    score5 !== null && near(score5, 1 / sd5)
  );
}
{
  // 全相等 → sd=0 → clamp 到 MIN_GROSS_MARGIN_SD → 返回 1/MIN_GROSS_MARGIN_SD
  const constant = [30, 30, 30, 30, 30];
  const score = computeGrossMarginStability(constant);
  expectClose(
    '全相等 → clamp 到 1/MIN_GROSS_MARGIN_SD',
    score ?? -1,
    1 / MIN_GROSS_MARGIN_SD
  );
}
{
  // sd 极小但 > 0 但仍 ≤ MIN_GROSS_MARGIN_SD → clamp 到 1/MIN_GROSS_MARGIN_SD
  const tiny = [30, 30.001, 30, 30.001, 30];
  const sdTiny = sampleStddev(tiny);
  assert(
    `tiny 5 obs 的 sd (${sdTiny.toFixed(6)}) < ${MIN_GROSS_MARGIN_SD}`,
    sdTiny < MIN_GROSS_MARGIN_SD
  );
  const scoreTiny = computeGrossMarginStability(tiny);
  expectClose(
    'sd < MIN_GROSS_MARGIN_SD → clamp',
    scoreTiny ?? -1,
    1 / MIN_GROSS_MARGIN_SD
  );
}
{
  // sd > MIN_GROSS_MARGIN_SD → 用真实 sd
  const noisy = [10, 30, 50, 20, 40];
  const sdNoisy = sampleStddev(noisy);
  assert(
    `noisy 5 obs 的 sd (${sdNoisy.toFixed(4)}) > ${MIN_GROSS_MARGIN_SD}`,
    sdNoisy > MIN_GROSS_MARGIN_SD
  );
  const scoreNoisy = computeGrossMarginStability(noisy);
  assert(
    'sd > MIN_GROSS_MARGIN_SD → 用真实 sd 不 clamp',
    scoreNoisy !== null && near(scoreNoisy, 1 / sdNoisy)
  );
}
{
  // 全 NaN → null
  assert(
    '全 NaN → null',
    computeGrossMarginStability([NaN, NaN, NaN, NaN, NaN, NaN]) === null
  );
}
{
  // 混合 valid + NaN/Infinity → 只取 valid
  const mixed = [20, NaN, 22, Infinity, 18, 21, -Infinity, 25];
  const validOnly = [20, 22, 18, 21, 25];
  const sdValid = sampleStddev(validOnly);
  const score = computeGrossMarginStability(mixed);
  assert(
    '混合输入只取 valid 算 sd',
    score !== null && near(score, 1 / sdValid)
  );
}
{
  // 6 个观测 → 算 6 个 sd
  const six = [10, 12, 14, 16, 18, 20];
  const sd6 = sampleStddev(six);
  const score = computeGrossMarginStability(six);
  assert(
    '6 个观测正常算',
    score !== null && near(score, 1 / sd6)
  );
}
{
  // 边界：BD-3 后 valid=3 已是阈值; 改测 valid=2 (< MIN=3) → null
  const partial = [20, NaN, 22, NaN, NaN, NaN];
  assert(
    'valid 2 个，总数 6 个 → null (BD-3: valid < MIN=3)',
    computeGrossMarginStability(partial) === null
  );
}

console.log('\n## computeNetMargin');
expectClose('net=20, rev=100 → 20.0%', computeNetMargin(20, 100) ?? -1, 20);
expectClose('net=-10, rev=100 → -10.0% (亏损)', computeNetMargin(-10, 100) ?? -999, -10);
expectClose('net=5, rev=50 → 10.0%', computeNetMargin(5, 50) ?? -1, 10);
assert('revenue=0 → null', computeNetMargin(20, 0) === null);
assert('revenue<0 → null (异常)', computeNetMargin(20, -100) === null);
assert('net=NaN → null', computeNetMargin(NaN, 100) === null);
assert('rev=NaN → null', computeNetMargin(20, NaN) === null);
assert('net=null → null', computeNetMargin(null, 100) === null);
assert('rev=null → null', computeNetMargin(20, null) === null);
assert('net=undefined → null', computeNetMargin(undefined, 100) === null);
assert('rev=undefined → null', computeNetMargin(20, undefined) === null);
{
  // string 输入也应该工作（Sequelize raw 出来的 DECIMAL 可能是字符串）
  const score = computeNetMargin('5' as any, '100' as any);
  expectClose('string 输入也转 Number', score ?? -1, 5);
}
{
  // Infinity 输入
  assert('net=Infinity → null', computeNetMargin(Infinity, 100) === null);
  assert('rev=Infinity → null', computeNetMargin(20, Infinity) === null);
}

console.log('\n## combineQualityHigh');
{
  // 任一 null → null
  assert(
    'roic_proxy=null → null',
    combineQualityHigh({ roic_proxy: null, gm_stability: 10, net_margin: 5 }) === null
  );
  assert(
    'gm_stability=null → null',
    combineQualityHigh({ roic_proxy: 15, gm_stability: null, net_margin: 5 }) === null
  );
  assert(
    'net_margin=null → null',
    combineQualityHigh({ roic_proxy: 15, gm_stability: 10, net_margin: null }) === null
  );
  assert(
    '全 null → null',
    combineQualityHigh({ roic_proxy: null, gm_stability: null, net_margin: null }) === null
  );
}
{
  // 全有效 → 三项均值
  const score = combineQualityHigh({ roic_proxy: 15, gm_stability: 9, net_margin: 6 });
  expectClose('15 + 9 + 6 / 3 = 10', score ?? -1, 10);
}
{
  // 负数 + 正数混合
  const score = combineQualityHigh({ roic_proxy: -5, gm_stability: 20, net_margin: -10 });
  expectClose('(-5 + 20 + -10) / 3 ≈ 1.667', score ?? -999, (-5 + 20 + -10) / 3);
}
{
  // 任一 Infinity → null
  assert(
    'roic_proxy=Infinity → null',
    combineQualityHigh({ roic_proxy: Infinity, gm_stability: 10, net_margin: 5 }) === null
  );
  assert(
    'gm_stability=NaN → null',
    combineQualityHigh({ roic_proxy: 15, gm_stability: NaN, net_margin: 5 }) === null
  );
}
{
  // 全 0 → 0
  const score = combineQualityHigh({ roic_proxy: 0, gm_stability: 0, net_margin: 0 });
  expectClose('全 0 → 0', score ?? -1, 0);
}

console.log('\n## qualityHighFactor metadata + 注册');
assert('name = quality_high', qualityHighFactor.name === 'quality_high');
assert('category = quality', qualityHighFactor.category === 'quality');
assert(
  'description 非空',
  typeof qualityHighFactor.description === 'string' &&
    qualityHighFactor.description.length > 0
);
assert(
  'description 包含 ROIC 关键词（jsdoc 一致性）',
  qualityHighFactor.description.includes('ROIC')
);
assert('compute 是函数', typeof qualityHighFactor.compute === 'function');
assert('已注册到全局 factorRegistry', factorRegistry.has('quality_high'));
assert(
  '已纳入 listNames()',
  factorRegistry.listNames().includes('quality_high')
);
assert(
  '从 registry get 拿回同一对象',
  factorRegistry.get('quality_high') === qualityHighFactor
);
assert('quality 因子未被本因子破坏（仍可 get）', factorRegistry.get('quality') !== undefined);

console.log('\n## 常量校验');
assert(
  `MIN_GROSS_MARGIN_OBSERVATIONS = 3 (got ${MIN_GROSS_MARGIN_OBSERVATIONS}) — BD-3 relaxed from 5 → 3`,
  MIN_GROSS_MARGIN_OBSERVATIONS === 3
);
assert(
  `MIN_GROSS_MARGIN_SD = 0.05 (got ${MIN_GROSS_MARGIN_SD})`,
  near(MIN_GROSS_MARGIN_SD, 0.05)
);
assert(
  `ANNUAL_REPORT_LOOKBACK_DAYS = 365*6 = ${365 * 6} (got ${ANNUAL_REPORT_LOOKBACK_DAYS})`,
  ANNUAL_REPORT_LOOKBACK_DAYS === 365 * 6
);
assert(
  `GROSS_MARGIN_LOOKBACK_DAYS = 365*5 = ${365 * 5} (got ${GROSS_MARGIN_LOOKBACK_DAYS})`,
  GROSS_MARGIN_LOOKBACK_DAYS === 365 * 5
);

console.log('\n## compute() 空 universe 安全路径');
(async () => {
  const empty = await qualityHighFactor.compute({
    as_of_date: '2026-06-07',
    universe: [],
  });
  assert(
    'compute(universe=[]) → 空 Map (不走 DB)',
    empty.size === 0
  );

  console.log(`\n## Summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch(e => {
  console.error('TEST_RUNNER_ERROR:', e);
  process.exit(2);
});
