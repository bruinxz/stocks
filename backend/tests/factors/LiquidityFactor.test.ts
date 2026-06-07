/**
 * LiquidityFactor 单元测试（US-029）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/factors/LiquidityFactor.test.ts
 *
 * 覆盖：
 *   - 纯函数 quantileAtSortedAsc（边界 0/1、中间插值、空数组、单元素）
 *   - 纯函数 sampleStddev（< 2 样本 → 0，正常 n-1 公式）
 *   - 纯函数 liquidityPenaltyScore（sd=0 → 0；在 P30 处 raw=0；
 *     越偏离绝对值越大；NaN/非有限输入安全 0）
 *   - 纯函数 computeAvgTurnoverFromBars（不足 MIN_OBS → null；
 *     turnover_rate ≤ 0 / NaN / 缺数据全部剔除；按 time DESC 取最近 20；
 *     超过 20 截尾）
 *   - Factor metadata（name / category / description）
 *   - liquidityFactor 已在 library/index.ts 自我登记到 factorRegistry
 *   - Pipeline 集成：mock FactorContext → 因子输出非空 → winsorize+zscore 后
 *     U 形 raw → 距 P30 越远 z_score 越低（与 normalization 兼容性验证）
 */

import {
  liquidityFactor,
  quantileAtSortedAsc,
  sampleStddev,
  liquidityPenaltyScore,
  computeAvgTurnoverFromBars,
  MIN_TURNOVER_OBSERVATIONS,
  TURNOVER_WINDOW,
  LIQUIDITY_REFERENCE_QUANTILE,
} from '../../src/quant/factors/library/LiquidityFactor';
import { factorRegistry } from '../../src/quant/factors/FactorRegistry';
import {
  winsorize,
  zscore,
  percentileRanks,
} from '../../src/quant/factors/normalization';

// 触发 library 自我登记
// （在 metadata 测试里断言 factorRegistry.has('liquidity') === true）
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
  assert(
    name,
    near(actual, expected, eps),
    `expected≈${expected}, got=${actual}`
  );
}

console.log('\n## quantileAtSortedAsc 边界');
expectClose('q=0 → first', quantileAtSortedAsc([1, 2, 3, 4, 5], 0), 1);
expectClose('q=1 → last', quantileAtSortedAsc([1, 2, 3, 4, 5], 1), 5);
expectClose('q=0.5 → 中位线性插值', quantileAtSortedAsc([1, 2, 3, 4, 5], 0.5), 3);
expectClose('q=0.3 → 30 % 分位插值', quantileAtSortedAsc([1, 2, 3, 4, 5], 0.3), 2.2);
expectClose('q<0 → first (clamp)', quantileAtSortedAsc([1, 2, 3, 4, 5], -0.5), 1);
expectClose('q>1 → last (clamp)', quantileAtSortedAsc([1, 2, 3, 4, 5], 1.5), 5);
expectClose('空数组 → 0', quantileAtSortedAsc([], 0.5), 0);
expectClose('单元素 q=0', quantileAtSortedAsc([42], 0), 42);
expectClose('单元素 q=0.5', quantileAtSortedAsc([42], 0.5), 42);
expectClose('单元素 q=1', quantileAtSortedAsc([42], 1), 42);

console.log('\n## sampleStddev 边界');
expectClose('空数组 → 0', sampleStddev([]), 0);
expectClose('单元素 → 0 (< 2 sample)', sampleStddev([42]), 0);
expectClose(
  '常规 [2,4,4,4,5,5,7,9] sample (n-1) → √(32/7) ≈ 2.138',
  sampleStddev([2, 4, 4, 4, 5, 5, 7, 9]),
  Math.sqrt(32 / 7),
  1e-9
);
expectClose('全相等 → 0', sampleStddev([3, 3, 3, 3]), 0);

console.log('\n## liquidityPenaltyScore (U 形评分)');
expectClose('value=center → raw=0 (peak)', liquidityPenaltyScore(5, 5, 2), 0);
expectClose(
  'value 高于 center 2sd → raw=-2',
  liquidityPenaltyScore(9, 5, 2),
  -2
);
expectClose(
  'value 低于 center 2sd → raw=-2 (对称)',
  liquidityPenaltyScore(1, 5, 2),
  -2
);
expectClose(
  'value 高于 center 0.5sd → raw=-0.5',
  liquidityPenaltyScore(6, 5, 2),
  -0.5
);
expectClose('sd=0 → raw=0 (degenerate)', liquidityPenaltyScore(10, 5, 0), 0);
expectClose('sd<0 → raw=0 (defensive)', liquidityPenaltyScore(10, 5, -1), 0);
expectClose('NaN value → 0', liquidityPenaltyScore(NaN, 5, 2), 0);
expectClose('NaN center → 0', liquidityPenaltyScore(5, NaN, 2), 0);
expectClose('NaN sd → 0', liquidityPenaltyScore(5, 5, NaN), 0);
expectClose('Infinity value → 0', liquidityPenaltyScore(Infinity, 5, 2), 0);

console.log('\n## computeAvgTurnoverFromBars');
{
  // 不足 MIN_OBS → null
  const fewRows = Array.from({ length: MIN_TURNOVER_OBSERVATIONS - 1 }, (_, i) => ({
    time: `2026-05-${String(i + 1).padStart(2, '0')}T03:00:00Z`,
    turnover_rate: 1.5,
  }));
  assert(
    '不足 MIN_TURNOVER_OBSERVATIONS → null',
    computeAvgTurnoverFromBars(fewRows) === null
  );
}
{
  // 恰好 MIN_OBS → 算均值
  const justEnough = Array.from({ length: MIN_TURNOVER_OBSERVATIONS }, (_, i) => ({
    time: `2026-05-${String(i + 1).padStart(2, '0')}T03:00:00Z`,
    turnover_rate: 2.0,
  }));
  expectClose(
    '恰好 MIN_OBS, 均值 2.0',
    computeAvgTurnoverFromBars(justEnough) ?? -1,
    2.0
  );
}
{
  // 全 NaN / 0 / 缺 → 全部跳过 → null
  const allBad = [
    { time: '2026-05-01T03:00:00Z', turnover_rate: 0 },
    { time: '2026-05-02T03:00:00Z', turnover_rate: -1 },
    { time: '2026-05-03T03:00:00Z', turnover_rate: NaN },
    { time: '2026-05-04T03:00:00Z', turnover_rate: undefined },
    { time: '2026-05-05T03:00:00Z', turnover_rate: 'oops' },
  ];
  assert('全无效 → null', computeAvgTurnoverFromBars(allBad) === null);
}
{
  // 混合：10 个有效 (rate=1) + 5 个无效 → 有效 10 个均值 = 1
  const mixed: Array<{ time: string; turnover_rate: any }> = [];
  for (let i = 0; i < 10; i += 1) {
    mixed.push({
      time: `2026-05-${String(i + 1).padStart(2, '0')}T03:00:00Z`,
      turnover_rate: 1,
    });
  }
  for (let i = 10; i < 15; i += 1) {
    mixed.push({
      time: `2026-05-${String(i + 1).padStart(2, '0')}T03:00:00Z`,
      turnover_rate: 0,
    });
  }
  expectClose(
    '混合 10 有效 + 5 无效 → 均值 1',
    computeAvgTurnoverFromBars(mixed) ?? -1,
    1
  );
}
{
  // 超过 TURNOVER_WINDOW (20) → 截尾取最近 20
  // 旧时段 rate=10、新时段 rate=2，应该只取最近 20 个 (rate=2)，均值=2
  const tooMany: Array<{ time: string; turnover_rate: number }> = [];
  for (let i = 0; i < 25; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    // 前 5 天给 rate=10（这些是最旧的）
    // 后 20 天给 rate=2（最新）
    tooMany.push({
      time: `2026-05-${day}T03:00:00Z`,
      turnover_rate: i < 5 ? 10 : 2,
    });
  }
  expectClose(
    '超过 TURNOVER_WINDOW 取最近 20',
    computeAvgTurnoverFromBars(tooMany) ?? -1,
    2
  );
}
{
  // 输入乱序 → 内部按 time DESC 排序后取最近 20
  // 25 天乱序，rate 与日期挂钩，最近 20 天 rate=2，旧 5 天 rate=10
  const shuffled: Array<{ time: string; turnover_rate: number }> = [];
  for (let i = 0; i < 25; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    shuffled.push({
      time: `2026-05-${day}T03:00:00Z`,
      turnover_rate: i < 5 ? 10 : 2,
    });
  }
  // 洗牌
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = (i * 7) % shuffled.length; // 确定性"乱序"
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  expectClose(
    '乱序输入按时间倒序后取最近 20',
    computeAvgTurnoverFromBars(shuffled) ?? -1,
    2
  );
}
{
  // 边界：恰好 21 个全有效 → 取最近 20，丢掉最旧 1 个
  const rows: Array<{ time: string; turnover_rate: number }> = [];
  for (let i = 0; i < 21; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    // 给每天唯一 rate，最旧 = 1，最新 = 21
    rows.push({
      time: `2026-05-${day}T03:00:00Z`,
      turnover_rate: i + 1,
    });
  }
  // 取最新 20 (rate 2..21)，均值 = (2+21)*20/2 / 20 = 11.5
  expectClose(
    '21 个 → 取最新 20 个均值',
    computeAvgTurnoverFromBars(rows) ?? -1,
    11.5
  );
}
{
  // 传 Date 对象 (DailyBar.time 真实形态)
  const rows: Array<{ time: Date; turnover_rate: number }> = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push({
      time: new Date(`2026-05-${String(i + 1).padStart(2, '0')}T03:00:00Z`),
      turnover_rate: 3,
    });
  }
  expectClose(
    'Date 对象输入也工作',
    computeAvgTurnoverFromBars(rows) ?? -1,
    3
  );
}

console.log('\n## liquidityFactor metadata + 注册');
assert('name = liquidity', liquidityFactor.name === 'liquidity');
assert('category = liquidity', liquidityFactor.category === 'liquidity');
assert(
  'description 非空',
  typeof liquidityFactor.description === 'string' &&
    liquidityFactor.description.length > 0
);
assert(
  'compute 是函数',
  typeof liquidityFactor.compute === 'function'
);
assert(
  '已注册到全局 factorRegistry',
  factorRegistry.has('liquidity')
);
assert(
  '已纳入 listNames()',
  factorRegistry.listNames().includes('liquidity')
);
assert(
  '从 registry get 拿回同一对象',
  factorRegistry.get('liquidity') === liquidityFactor
);
assert(
  '常量 LIQUIDITY_REFERENCE_QUANTILE = 0.3',
  near(LIQUIDITY_REFERENCE_QUANTILE, 0.3)
);
assert('常量 TURNOVER_WINDOW = 20', TURNOVER_WINDOW === 20);
assert(
  '常量 MIN_TURNOVER_OBSERVATIONS = 10',
  MIN_TURNOVER_OBSERVATIONS === 10
);

console.log('\n## U-shape 评分行为 (端到端业务校验)');
{
  // 模拟全市场 11 只股票的 avg_turnover_20（已计算完）
  // 排序后 [0.5, 0.7, 0.9, 1.0, 1.2, 1.5, 1.8, 2.5, 4.0, 6.0, 10.0]
  // P30 取 quantile 0.3 = 第 3 个位置（0-indexed pos = 3, 在 1.0 处）
  // 实际计算：pos = 0.3 * 10 = 3, base = 3, rest = 0
  //   → sortedAsc[3] = 1.0  → P30 = 1.0
  // sd = sampleStddev of all 11 values
  const turnovers = [0.5, 0.7, 0.9, 1.0, 1.2, 1.5, 1.8, 2.5, 4.0, 6.0, 10.0];
  const sortedAsc = turnovers.slice().sort((a, b) => a - b);
  const p30 = quantileAtSortedAsc(sortedAsc, 0.3);
  const sd = sampleStddev(turnovers);
  expectClose('P30 of sample series', p30, 1.0);
  assert('sd > 0', sd > 0);

  // 在 P30 (turnover=1.0) 上的股票 raw = 0
  expectClose(
    'turnover=P30 → raw=0 (U 顶点)',
    liquidityPenaltyScore(p30, p30, sd),
    0
  );

  // 极低 turnover (0.5) 与 P30 = 1.0，|偏离|=0.5/sd
  const lowRaw = liquidityPenaltyScore(0.5, p30, sd);
  // 极高 turnover (10.0) 与 P30 = 1.0，|偏离|=9.0/sd（大得多）
  const highRaw = liquidityPenaltyScore(10.0, p30, sd);
  assert('low turnover raw < 0', lowRaw < 0);
  assert('high turnover raw < 0', highRaw < 0);
  assert(
    'high (10.0) 比 low (0.5) 更负 (距离 P30 远更多)',
    highRaw < lowRaw
  );

  // 模拟 Pipeline 后续标准化：winsorize 1%-99% → zscore
  const rawArray = turnovers.map(t => liquidityPenaltyScore(t, p30, sd));
  // raw 中 turnover=1.0 处最接近 0，turnover=10.0 处最负
  const wins = winsorize(rawArray, { lowerQuantile: 0.01, upperQuantile: 0.99 });
  const zs = zscore(wins);
  const pcts = percentileRanks(rawArray);
  assert('Pipeline 输出 z 数组等长', zs.length === turnovers.length);
  assert('Pipeline 输出 percentile 等长', pcts.length === turnovers.length);
  // turnover=1.0 (idx=3) 是 raw 最大 → 其 zscore 应为最高
  const idxAtP30 = turnovers.indexOf(1.0);
  const maxZ = Math.max(...zs);
  expectClose('在 P30 处 zscore = 全样本最大', zs[idxAtP30], maxZ);
  // turnover=10.0 (idx=10) 是 raw 最负 → 其 zscore 应为最低
  const idxExtreme = turnovers.indexOf(10.0);
  const minZ = Math.min(...zs);
  expectClose('极端 turnover 处 zscore = 全样本最小', zs[idxExtreme], minZ);
}

console.log('\n## compute() 业务集成 (无 DB - 直接断言空 universe 路径)');
{
  // 不连 DB；ctx.universe 为空时直接返回空 Map
  liquidityFactor.compute({ as_of_date: '2026-06-05', universe: [] }).then(out => {
    assert('空 universe → 空 Map', out instanceof Map && out.size === 0);
    finish();
  }).catch(err => {
    assert('compute 不应抛错: ' + err.message, false);
    finish();
  });
}

function finish() {
  console.log(`\n========================================`);
  console.log(
    `LiquidityFactor tests: ${passed} passed, ${failed} failed`
  );
  console.log(`========================================`);
  if (failed > 0) {
    process.exit(1);
  }
}
