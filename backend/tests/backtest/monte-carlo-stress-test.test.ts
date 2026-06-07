/**
 * MonteCarloStressTest 单元测试（US-043）
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/backtest/monte-carlo-stress-test.test.ts
 *
 * 完全脱离 DB：注入 fake TradeReturnSource 或直接传 trade_returns_pct in-memory；
 * persist=false 跳过写库。
 *
 * 覆盖维度：
 *   - 纯函数：computeQuantile / bootstrapResample / computeSimulationFinalReturn /
 *     computeSimulationMaxDrawdown / computeSimulationSharpe / aggregateSimulations
 *   - SeededRandom 复用（通过 BayesianOptimizer 共享）
 *   - end-to-end run()：
 *     - happy path：in-memory + fake source 两种入参
 *     - seed 复现性：同 seed → 完全一致的 outcomes
 *     - 不同 seed → 不同 outcomes（采样不同）
 *     - simulation_count 边界（最小 1 / 最大 100_000 / 异常抛错）
 *     - trade_count < MIN_TRADES_FOR_BOOTSTRAP 抛错
 *     - 同时缺 quant_backtest_result_id + trade_returns_pct 抛错
 *     - in-memory NaN 自动剔除
 *     - 全损失场景（所有 returns < 0）→ return_p95 仍正确
 *     - 全盈利场景（所有 returns > 0）→ return_p5 仍正确
 *     - 大量模拟（1000 次）的分布平滑性（p50 接近 mean）
 */

import {
  MonteCarloStressTest,
  TradeReturnSource,
  computeQuantile,
  bootstrapResample,
  computeSimulationFinalReturn,
  computeSimulationMaxDrawdown,
  computeSimulationSharpe,
  aggregateSimulations,
  SimulationOutcome,
  DEFAULT_SIMULATION_COUNT,
  DEFAULT_SEED,
  MAX_SIMULATION_COUNT,
  MIN_SIMULATION_COUNT,
  MIN_TRADES_FOR_BOOTSTRAP,
  MIN_RETURNS_FOR_SHARPE,
  SHARPE_ANNUALIZATION_FACTOR,
} from '../../src/quant/backtest/MonteCarloStressTest';
import { SeededRandom } from '../../src/quant/backtest/BayesianOptimizer';

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

function expectEqual<T>(name: string, actual: T, expected: T, detail = '') {
  const same =
    JSON.stringify(actual) === JSON.stringify(expected) ||
    (typeof actual === 'number' &&
      typeof expected === 'number' &&
      Math.abs(actual - expected) < 1e-9);
  assert(
    name,
    same,
    detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function expectClose(name: string, actual: number | null, expected: number, eps = 1e-6) {
  assert(
    name,
    actual !== null && Number.isFinite(actual) && Math.abs(actual - expected) < eps,
    `expected≈${expected}, got=${actual}`
  );
}

async function expectThrowAsync(name: string, fn: () => Promise<any>, substr?: string) {
  try {
    await fn();
    assert(name, false, 'expected throw, none thrown');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (substr && !msg.includes(substr)) {
      assert(name, false, `expected msg to include '${substr}', got '${msg}'`);
    } else {
      assert(name, true);
    }
  }
}

function expectThrow(name: string, fn: () => any, substr?: string) {
  try {
    fn();
    assert(name, false, 'expected throw, none thrown');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (substr && !msg.includes(substr)) {
      assert(name, false, `expected msg to include '${substr}', got '${msg}'`);
    } else {
      assert(name, true);
    }
  }
}

// ============================================================
// 常量校验
// ============================================================

function runConstantsTests() {
  console.log('\n## 常量校验');
  expectEqual('DEFAULT_SIMULATION_COUNT = 1000', DEFAULT_SIMULATION_COUNT, 1000);
  expectEqual('DEFAULT_SEED = 42', DEFAULT_SEED, 42);
  expectEqual('MIN_SIMULATION_COUNT = 1', MIN_SIMULATION_COUNT, 1);
  expectEqual('MAX_SIMULATION_COUNT = 100_000', MAX_SIMULATION_COUNT, 100_000);
  expectEqual('MIN_RETURNS_FOR_SHARPE = 5', MIN_RETURNS_FOR_SHARPE, 5);
  expectEqual('MIN_TRADES_FOR_BOOTSTRAP = 2', MIN_TRADES_FOR_BOOTSTRAP, 2);
  expectClose('SHARPE_ANNUALIZATION_FACTOR = sqrt(252)', SHARPE_ANNUALIZATION_FACTOR, Math.sqrt(252));
}

// ============================================================
// computeQuantile
// ============================================================

function runComputeQuantileTests() {
  console.log('\n## computeQuantile');
  expectEqual('空数组 → null', computeQuantile([], 0.5), null);
  expectEqual('单元素 → 该值', computeQuantile([7], 0.5), 7);
  expectEqual('单元素 q=0', computeQuantile([7], 0), 7);
  expectEqual('单元素 q=1', computeQuantile([7], 1), 7);

  // 标准 5 元素：[1,2,3,4,5]
  expectClose('5 元素 q=0 → 1', computeQuantile([1, 2, 3, 4, 5], 0)!, 1);
  expectClose('5 元素 q=0.25 → 2', computeQuantile([1, 2, 3, 4, 5], 0.25)!, 2);
  expectClose('5 元素 q=0.5 → 3 (中位数)', computeQuantile([1, 2, 3, 4, 5], 0.5)!, 3);
  expectClose('5 元素 q=0.75 → 4', computeQuantile([1, 2, 3, 4, 5], 0.75)!, 4);
  expectClose('5 元素 q=1 → 5', computeQuantile([1, 2, 3, 4, 5], 1)!, 5);

  // 偶数元素：[1,2,3,4] q=0.5 = (2+3)/2 = 2.5 (插值)
  expectClose('4 元素 q=0.5 = 2.5 插值', computeQuantile([1, 2, 3, 4], 0.5)!, 2.5);

  // 0.05/0.95 分位 (AC 核心需求)
  expectClose('100 元素 q=0.05 = 5.95', computeQuantile(Array.from({ length: 100 }, (_, i) => i + 1), 0.05)!, 5.95);
  expectClose('100 元素 q=0.95 = 95.05', computeQuantile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)!, 95.05);

  // 负数 + 正数混合
  expectClose('负正混合 q=0.5', computeQuantile([-10, -5, 0, 5, 10], 0.5)!, 0);
  expectClose('全负数 q=0.5', computeQuantile([-10, -5, -2], 0.5)!, -5);

  // q 边界异常
  expectThrow('q=-0.1 抛错', () => computeQuantile([1, 2, 3], -0.1), 'q 必须 ∈');
  expectThrow('q=1.1 抛错', () => computeQuantile([1, 2, 3], 1.1), 'q 必须 ∈');
  expectThrow('q=NaN 抛错', () => computeQuantile([1, 2, 3], NaN), 'q 必须有限');
  expectThrow('q=Infinity 抛错', () => computeQuantile([1, 2, 3], Infinity), 'q 必须有限');
}

// ============================================================
// bootstrapResample
// ============================================================

function runBootstrapResampleTests() {
  console.log('\n## bootstrapResample');

  // 不 mutate 原数组
  const original = [1, 2, 3, 4, 5];
  const originalSnapshot = original.slice();
  const rng1 = new SeededRandom(42);
  const shuffled = bootstrapResample(original, rng1);
  expectEqual('不 mutate 原数组', original, originalSnapshot);

  // 返回新数组（不同引用）
  assert('返回不同数组引用', shuffled !== original);

  // 长度一致
  expectEqual('shuffled.length === input.length', shuffled.length, 5);

  // 元素集合一致（重排不改变元素）
  expectEqual('元素集合不变', shuffled.slice().sort(), [1, 2, 3, 4, 5]);

  // 同 seed 复现性
  const rng2 = new SeededRandom(42);
  const shuffled2 = bootstrapResample(original, rng2);
  expectEqual('同 seed 复现 shuffle 序列', shuffled, shuffled2);

  // 不同 seed 给不同序列
  const rng3 = new SeededRandom(100);
  const shuffled3 = bootstrapResample(original, rng3);
  // 大概率不同（5 元素全排列 120 种，碰巧相同概率小）
  assert(
    '不同 seed → 不同序列（统计上）',
    JSON.stringify(shuffled) !== JSON.stringify(shuffled3),
    `seed=42 → ${JSON.stringify(shuffled)}, seed=100 → ${JSON.stringify(shuffled3)}`
  );

  // 单元素
  const single = bootstrapResample([42], new SeededRandom(1));
  expectEqual('单元素返回相同', single, [42]);

  // 空数组
  const empty = bootstrapResample([], new SeededRandom(1));
  expectEqual('空数组返回空', empty, []);

  // 长数组：完整 Fisher-Yates 覆盖
  const long = Array.from({ length: 100 }, (_, i) => i);
  const longShuffled = bootstrapResample(long, new SeededRandom(7));
  expectEqual('100 元素 length', longShuffled.length, 100);
  expectEqual('100 元素 set 一致', longShuffled.slice().sort((a, b) => a - b), long);
}

// ============================================================
// computeSimulationFinalReturn
// ============================================================

function runComputeSimulationFinalReturnTests() {
  console.log('\n## computeSimulationFinalReturn');

  expectEqual('空数组 → 0', computeSimulationFinalReturn([]), 0);
  expectClose('单 trade +10% → 10', computeSimulationFinalReturn([10]), 10);
  expectClose('单 trade -5% → -5', computeSimulationFinalReturn([-5]), -5);

  // 复利示例：[10, -5, 8] → (1.10 * 0.95 * 1.08 - 1) * 100 = 12.86
  expectClose(
    '[10, -5, 8] 复利 ≈ 12.86%',
    computeSimulationFinalReturn([10, -5, 8]),
    (1.10 * 0.95 * 1.08 - 1) * 100,
    1e-6
  );

  // 全平 → 0
  expectClose('全 0% returns → 0', computeSimulationFinalReturn([0, 0, 0, 0, 0]), 0);

  // 全 +1% 100 次 → (1.01^100 - 1)*100
  expectClose(
    '100 笔 +1% → (1.01^100 - 1)*100',
    computeSimulationFinalReturn(Array(100).fill(1)),
    (Math.pow(1.01, 100) - 1) * 100,
    1e-6
  );

  // 爆仓：单笔 -100% → factor=0 → -100
  expectClose('单笔 -100% → -100% 爆仓', computeSimulationFinalReturn([-100]), -100);
  expectClose('-100% 后任何 trade 仍 -100%', computeSimulationFinalReturn([-100, 50, 80]), -100);
  expectClose('深亏 -150% → -100% 爆仓', computeSimulationFinalReturn([-150]), -100);

  // NaN 跳过
  expectClose('NaN 跳过', computeSimulationFinalReturn([10, NaN, 5]), (1.10 * 1.05 - 1) * 100, 1e-6);
  expectClose('Infinity 跳过', computeSimulationFinalReturn([10, Infinity, 5]), (1.10 * 1.05 - 1) * 100, 1e-6);

  // 顺序无关性（complement 测试：复利是交换的）
  const seq1 = [5, 10, -3, 8, -2];
  const seq2 = [-2, 8, -3, 10, 5];
  expectClose(
    '复利顺序无关',
    computeSimulationFinalReturn(seq1),
    computeSimulationFinalReturn(seq2),
    1e-9
  );
}

// ============================================================
// computeSimulationMaxDrawdown
// ============================================================

function runComputeSimulationMaxDrawdownTests() {
  console.log('\n## computeSimulationMaxDrawdown');

  expectEqual('空数组 → 0', computeSimulationMaxDrawdown([]), 0);

  // 单 trade +10% → dd=0（peak=cumulative, no drawdown）
  expectClose('单 trade +10% → dd=0', computeSimulationMaxDrawdown([10]), 0);

  // 单 trade -5% → dd=5%（亏损本身就是回撤）
  expectClose('单 trade -5% → dd=5%', computeSimulationMaxDrawdown([-5]), 5);

  // 全 0 → dd=0（无变化）
  expectClose('全 0 → dd=0', computeSimulationMaxDrawdown([0, 0, 0]), 0);

  // 先涨后跌：[10, -5] → peak=1.10, after -5%=1.045, dd=(1.10-1.045)/1.10 ≈ 5%
  expectClose(
    '[10, -5] dd ≈ 5%',
    computeSimulationMaxDrawdown([10, -5]),
    (1.10 - 1.10 * 0.95) / 1.10 * 100,
    1e-6
  );

  // 持续涨：[10, 10, 10] → 单调上升 → dd=0
  expectClose('全涨 → dd=0', computeSimulationMaxDrawdown([10, 10, 10]), 0);

  // 持续跌：[-10, -10, -10] → peak=1, 一路跌 → dd=(1-0.9*0.9*0.9)/1 ≈ 27.1%
  expectClose(
    '全跌 -10% × 3 → dd ≈ 27.1%',
    computeSimulationMaxDrawdown([-10, -10, -10]),
    (1 - Math.pow(0.9, 3)) * 100,
    1e-6
  );

  // 顺序敏感（这正是为什么用 MC）：
  //  [10, -10] = peak 1.10 → 1.10*0.90=0.99, dd=(1.10-0.99)/1.10 = 10%
  //  [-10, 10] = peak=1 → 0.90 → 0.99, dd=(1-0.90)/1=10%（最低 0.90 还是 dd 10%）
  // 实际是相同：peak 不同但 dd 比例同
  expectClose('[10,-10] dd ≈ 10%', computeSimulationMaxDrawdown([10, -10]), 10, 1e-6);
  expectClose('[-10,10] dd ≈ 10%', computeSimulationMaxDrawdown([-10, 10]), 10, 1e-6);

  // 爆仓：-100% → 立即 return 100
  expectClose('单笔 -100% → dd=100', computeSimulationMaxDrawdown([-100]), 100);
  expectClose('-150% 爆仓 → dd=100', computeSimulationMaxDrawdown([-150]), 100);

  // NaN 跳过
  expectClose('NaN 跳过', computeSimulationMaxDrawdown([10, NaN, -5]), (1.10 - 1.10 * 0.95) / 1.10 * 100, 1e-6);

  // 经典三段：上 -> 下 -> 再上 (peak 在中间)
  // [10, 10, -20, 5]: 1 → 1.1 → 1.21 → 0.968 → 1.0164
  // peak = 1.21; trough = 0.968; dd = (1.21 - 0.968) / 1.21 = 20%
  expectClose(
    '[10, 10, -20, 5] dd ≈ 20%',
    computeSimulationMaxDrawdown([10, 10, -20, 5]),
    (1.21 - 1.21 * 0.80) / 1.21 * 100,
    1e-6
  );
}

// ============================================================
// computeSimulationSharpe
// ============================================================

function runComputeSimulationSharpeTests() {
  console.log('\n## computeSimulationSharpe');

  // < MIN_RETURNS_FOR_SHARPE → null
  expectEqual('空 → null', computeSimulationSharpe([]), null);
  expectEqual('1 trade → null', computeSimulationSharpe([5]), null);
  expectEqual('4 trades → null（< 5）', computeSimulationSharpe([1, 2, 3, 4]), null);

  // 5 trades 全相等 → std=0 → null
  expectEqual('全相等 std=0 → null', computeSimulationSharpe([5, 5, 5, 5, 5]), null);
  expectEqual('全 0 std=0 → null', computeSimulationSharpe([0, 0, 0, 0, 0]), null);

  // 5 trades 不同 → sharpe finite
  const returns = [1, -1, 2, -2, 3];
  const sharpe = computeSimulationSharpe(returns);
  assert('5 不同 returns → sharpe 非 null', sharpe !== null, `got ${sharpe}`);
  if (sharpe !== null) {
    // mean=(1-1+2-2+3)/5=0.6, n=5; std n-1 公式
    // variance = ((1-0.6)^2 + (-1-0.6)^2 + (2-0.6)^2 + (-2-0.6)^2 + (3-0.6)^2) / 4
    //          = (0.16 + 2.56 + 1.96 + 6.76 + 5.76) / 4 = 17.20/4 = 4.30
    // std = sqrt(4.30) ≈ 2.073644
    // sharpe = (0.6 / 2.073644) * sqrt(252)
    const expectedSharpe = (0.6 / Math.sqrt(4.3)) * Math.sqrt(252);
    expectClose('5 不同 returns sharpe 精确', sharpe, expectedSharpe, 1e-6);
  }

  // NaN 跳过 (但剔除后必须仍有 ≥ 5)
  expectEqual('全 NaN → null', computeSimulationSharpe([NaN, NaN, NaN, NaN, NaN]), null);
  expectEqual('5 个含 1 NaN 后只剩 4 → null', computeSimulationSharpe([1, NaN, 2, 3, 4]), null);

  // 6 个含 1 NaN 后剩 5 → sharpe ok
  const s6 = computeSimulationSharpe([1, NaN, 2, 3, 4, 5]);
  assert('6 含 1 NaN → sharpe finite', s6 !== null, `got ${s6}`);
}

// ============================================================
// aggregateSimulations
// ============================================================

function runAggregateSimulationsTests() {
  console.log('\n## aggregateSimulations');

  // 空 outcomes → 全 null
  const empty = aggregateSimulations([]);
  expectEqual('empty simulation_count', empty.simulation_count, 0);
  expectEqual('empty return_p5 null', empty.return_p5, null);
  expectEqual('empty return_p50 null', empty.return_p50, null);
  expectEqual('empty return_p95 null', empty.return_p95, null);
  expectEqual('empty drawdown_p95 null', empty.drawdown_p95, null);
  expectEqual('empty sharpe_p5 null', empty.sharpe_p5, null);
  expectEqual('empty positive_ratio null', empty.positive_simulation_ratio, null);

  // 单 outcome → 分位数全 = 该值；std=null
  const single: SimulationOutcome[] = [
    { final_return_pct: 15, max_drawdown_pct: 8, sharpe: 1.5 },
  ];
  const aggSingle = aggregateSimulations(single);
  expectClose('single return_p5 = 15', aggSingle.return_p5!, 15);
  expectClose('single return_p50 = 15', aggSingle.return_p50!, 15);
  expectClose('single return_p95 = 15', aggSingle.return_p95!, 15);
  expectClose('single drawdown_p95 = 8', aggSingle.drawdown_p95!, 8);
  expectClose('single sharpe_p5 = 1.5', aggSingle.sharpe_p5!, 1.5);
  expectClose('single return_mean = 15', aggSingle.return_mean!, 15);
  expectEqual('single return_std null', aggSingle.return_std, null);
  expectClose('single positive_ratio = 1', aggSingle.positive_simulation_ratio!, 1);

  // 5 outcome 全正 → positive_ratio=1
  const allPositive: SimulationOutcome[] = [
    { final_return_pct: 5, max_drawdown_pct: 3, sharpe: 1.0 },
    { final_return_pct: 10, max_drawdown_pct: 5, sharpe: 1.5 },
    { final_return_pct: 15, max_drawdown_pct: 7, sharpe: 2.0 },
    { final_return_pct: 20, max_drawdown_pct: 9, sharpe: 2.5 },
    { final_return_pct: 25, max_drawdown_pct: 11, sharpe: 3.0 },
  ];
  const aggPos = aggregateSimulations(allPositive);
  expectClose('全正 positive_ratio = 1', aggPos.positive_simulation_ratio!, 1);
  // 5 元素 [5,10,15,20,25]: q=0.05 → pos=0.2 → 5 + (10-5)*0.2 = 6
  // q=0.5 → pos=2 → 15; q=0.95 → pos=3.8 → 20 + (25-20)*0.8 = 24
  expectClose('全正 return_p5 = 6 (插值)', aggPos.return_p5!, 6);
  expectClose('全正 return_p50 = 15 (中位数)', aggPos.return_p50!, 15);
  expectClose('全正 return_p95 = 24 (插值)', aggPos.return_p95!, 24);

  // 5 outcome 全负 → positive_ratio=0
  const allNegative: SimulationOutcome[] = [
    { final_return_pct: -25, max_drawdown_pct: 30, sharpe: -2.5 },
    { final_return_pct: -20, max_drawdown_pct: 25, sharpe: -2.0 },
    { final_return_pct: -15, max_drawdown_pct: 20, sharpe: -1.5 },
    { final_return_pct: -10, max_drawdown_pct: 15, sharpe: -1.0 },
    { final_return_pct: -5, max_drawdown_pct: 10, sharpe: -0.5 },
  ];
  const aggNeg = aggregateSimulations(allNegative);
  expectClose('全负 positive_ratio = 0', aggNeg.positive_simulation_ratio!, 0);
  // 5 元素 sorted asc [-25,-20,-15,-10,-5]: q=0.05 → pos=0.2 → -25+(-20-(-25))*0.2=-24
  // q=0.95 → pos=3.8 → -10+(-5-(-10))*0.8=-6
  expectClose('全负 return_p5 = -24 (插值)', aggNeg.return_p5!, -24);
  expectClose('全负 return_p95 = -6 (插值)', aggNeg.return_p95!, -6);

  // 混合 → ratio = 3/5 = 0.6 (3 正 + 1 零 + 1 负)
  const mixed: SimulationOutcome[] = [
    { final_return_pct: 10, max_drawdown_pct: 5, sharpe: 1.0 },
    { final_return_pct: 5, max_drawdown_pct: 3, sharpe: 0.8 },
    { final_return_pct: 3, max_drawdown_pct: 2, sharpe: 0.5 },
    { final_return_pct: 0, max_drawdown_pct: 1, sharpe: 0.0 }, // 0 不算正
    { final_return_pct: -10, max_drawdown_pct: 15, sharpe: -1.0 },
  ];
  const aggMixed = aggregateSimulations(mixed);
  expectClose('混合 positive_ratio = 3/5', aggMixed.positive_simulation_ratio!, 0.6);

  // sharpe null 不进入聚合
  const withSharpeNull: SimulationOutcome[] = [
    { final_return_pct: 10, max_drawdown_pct: 5, sharpe: null },
    { final_return_pct: 20, max_drawdown_pct: 10, sharpe: 2.0 },
    { final_return_pct: 5, max_drawdown_pct: 3, sharpe: 1.0 },
  ];
  const aggSharpeNull = aggregateSimulations(withSharpeNull);
  // sharpe valid: [1.0, 2.0]; p5 = 1.0 + (2-1)*0.05 = 1.05
  expectClose('sharpe null 排除 → sharpe_p5 = 1.05', aggSharpeNull.sharpe_p5!, 1.05);
  expectClose('sharpe_mean = (1+2)/2 = 1.5', aggSharpeNull.sharpe_mean!, 1.5);

  // 全 sharpe null
  const allSharpeNull: SimulationOutcome[] = [
    { final_return_pct: 10, max_drawdown_pct: 5, sharpe: null },
    { final_return_pct: 20, max_drawdown_pct: 10, sharpe: null },
  ];
  const aggAllSharpeNull = aggregateSimulations(allSharpeNull);
  expectEqual('全 sharpe null → sharpe_p5 null', aggAllSharpeNull.sharpe_p5, null);
  expectEqual('全 sharpe null → sharpe_mean null', aggAllSharpeNull.sharpe_mean, null);
}

// ============================================================
// End-to-end run() with fake source
// ============================================================

function makeFakeSource(returns: number[], strategyKey = 'fake_strategy'): TradeReturnSource {
  return {
    async loadTradeReturns(_id: number) {
      return { strategy_key: strategyKey, trade_returns_pct: returns };
    },
  };
}

async function testRunInMemorySimple() {
  console.log('\n## end-to-end run() — in-memory 简单流程');
  const mc = new MonteCarloStressTest();
  const returns = [5, -3, 8, -2, 10, -5, 7, 3];
  const out = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { simulation_count: 100, seed: 42, persist: false }
  );
  expectEqual('simulation_count 100', out.simulation_count, 100);
  expectEqual('outcomes length 100', out.outcomes.length, 100);
  expectEqual('seed = 42', out.seed, 42);
  expectEqual('base_run_id null (in-memory)', out.base_run_id, null);
  expectEqual('persisted_id null (persist:false)', out.persisted_id, null);
  expectEqual('strategy_key = test', out.strategy_key, 'test');
  expectEqual('trade_count = 8', out.distribution.trade_count, 8);

  // 由于重排不改变元素集合，复利顺序无关：所有 100 个模拟的 final_return_pct
  // 应该完全相同（≈ 22.46%）
  const finals = out.outcomes.map(o => o.final_return_pct);
  const uniqueFinals = new Set(finals.map(v => v.toFixed(6)));
  expectEqual('复利顺序无关 → 所有 final_return 相同', uniqueFinals.size, 1);

  // 但 drawdown 应该有变化（顺序敏感）
  const dds = out.outcomes.map(o => o.max_drawdown_pct);
  const uniqueDds = new Set(dds.map(v => v.toFixed(4)));
  assert(
    'drawdown 顺序敏感 → 不同模拟有不同 dd',
    uniqueDds.size > 1,
    `${uniqueDds.size} 不同 dd 值`
  );
}

async function testRunFromFakeSource() {
  console.log('\n## end-to-end run() — 从 fake DataSource 取数据');
  const mc = new MonteCarloStressTest();
  const returns = [5, -3, 8, -2, 10];
  const out = await mc.run(
    { quant_backtest_result_id: 999 },
    {
      simulation_count: 50,
      seed: 7,
      persist: false,
      trade_return_source: makeFakeSource(returns, 'fake_mfa'),
    }
  );
  expectEqual('source 提供的 strategy_key', out.strategy_key, 'fake_mfa');
  expectEqual('base_run_id 透传', out.base_run_id, 999);
  expectEqual('trade_count = 5', out.distribution.trade_count, 5);
  expectEqual('simulation_count 50', out.simulation_count, 50);
}

async function testSeedReproducibility() {
  console.log('\n## end-to-end — seed 复现性');
  const mc = new MonteCarloStressTest();
  const returns = [5, -3, 8, -2, 10, -5];

  // 跑两次相同 seed
  const out1 = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { simulation_count: 100, seed: 42, persist: false }
  );
  const out2 = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { simulation_count: 100, seed: 42, persist: false }
  );

  // outcomes 完全一致（包括 dd 顺序）
  const dds1 = out1.outcomes.map(o => o.max_drawdown_pct.toFixed(8));
  const dds2 = out2.outcomes.map(o => o.max_drawdown_pct.toFixed(8));
  expectEqual('同 seed 复现 dd 序列', dds1, dds2);

  const sharpes1 = out1.outcomes.map(o => (o.sharpe ?? 'null').toString());
  const sharpes2 = out2.outcomes.map(o => (o.sharpe ?? 'null').toString());
  expectEqual('同 seed 复现 sharpe 序列', sharpes1, sharpes2);
}

async function testDifferentSeedsDifferOutcomes() {
  console.log('\n## end-to-end — 不同 seed 给不同 outcome 序列');
  const mc = new MonteCarloStressTest();
  const returns = [5, -3, 8, -2, 10, -5];

  const outA = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { simulation_count: 100, seed: 42, persist: false }
  );
  const outB = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { simulation_count: 100, seed: 100, persist: false }
  );
  // outcomes 完整序列大概率不同（drawdown 顺序敏感 + 100 次模拟）
  const ddsA = outA.outcomes.map(o => o.max_drawdown_pct).join(',');
  const ddsB = outB.outcomes.map(o => o.max_drawdown_pct).join(',');
  assert('不同 seed → 不同 dd 序列', ddsA !== ddsB, 'should differ');
}

async function testInvalidSimulationCount() {
  console.log('\n## end-to-end — simulation_count 异常抛错');
  const mc = new MonteCarloStressTest();
  const returns = [5, -3, 8];

  await expectThrowAsync(
    'simulation_count=0 抛错',
    () =>
      mc.run(
        { trade_returns_pct: returns, strategy_key: 'test' },
        { simulation_count: 0, persist: false }
      ),
    'simulation_count'
  );

  await expectThrowAsync(
    'simulation_count=-5 抛错',
    () =>
      mc.run(
        { trade_returns_pct: returns, strategy_key: 'test' },
        { simulation_count: -5, persist: false }
      ),
    'simulation_count'
  );

  await expectThrowAsync(
    'simulation_count=200_000 抛错（> MAX）',
    () =>
      mc.run(
        { trade_returns_pct: returns, strategy_key: 'test' },
        { simulation_count: 200_000, persist: false }
      ),
    'simulation_count'
  );

  await expectThrowAsync(
    'simulation_count=NaN 抛错',
    () =>
      mc.run(
        { trade_returns_pct: returns, strategy_key: 'test' },
        { simulation_count: NaN, persist: false }
      ),
    'simulation_count'
  );

  // simulation_count=1（最小允许）应该 ok
  const okOut = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { simulation_count: 1, seed: 42, persist: false }
  );
  expectEqual('simulation_count=1 (MIN) ok', okOut.simulation_count, 1);

  // simulation_count=MAX 应该 ok 但跑得久（不实际跑）— 不在此测试以免超时
}

async function testInsufficientTrades() {
  console.log('\n## end-to-end — trade_count < MIN_TRADES_FOR_BOOTSTRAP 抛错');
  const mc = new MonteCarloStressTest();

  await expectThrowAsync(
    '空 returns 抛错',
    () =>
      mc.run(
        { trade_returns_pct: [], strategy_key: 'test' },
        { persist: false }
      ),
    'quant_backtest_result_id'
  );

  await expectThrowAsync(
    '1 笔 trade 抛错',
    () =>
      mc.run(
        { trade_returns_pct: [5], strategy_key: 'test' },
        { persist: false }
      ),
    'MIN_TRADES_FOR_BOOTSTRAP'.length > 0 ? '无法重排' : undefined
  );

  // 2 笔（MIN）应该 ok
  const okOut = await mc.run(
    { trade_returns_pct: [5, -3], strategy_key: 'test' },
    { simulation_count: 10, persist: false }
  );
  expectEqual('2 trades (MIN) ok', okOut.distribution.trade_count, 2);
}

async function testMissingInputThrows() {
  console.log('\n## end-to-end — 同时缺 result_id + returns 抛错');
  const mc = new MonteCarloStressTest();
  await expectThrowAsync(
    'no input throws',
    () => mc.run({ strategy_key: 'test' }, { persist: false }),
    'quant_backtest_result_id'
  );
}

async function testInMemoryNaNFiltered() {
  console.log('\n## end-to-end — in-memory NaN/Infinity 自动剔除');
  const mc = new MonteCarloStressTest();
  // 8 元素含 3 个 invalid → 5 有效（≥ MIN=2）
  const returns = [5, NaN, -3, Infinity, 8, -2, -Infinity, 10];
  const out = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { simulation_count: 10, persist: false }
  );
  expectEqual('NaN/Inf 后剩 5 笔', out.distribution.trade_count, 5);
}

async function testInsufficientTradesAfterNaNFilter() {
  console.log('\n## end-to-end — NaN 过滤后不足 MIN 抛错');
  const mc = new MonteCarloStressTest();
  const returns = [NaN, NaN, 5]; // 过滤后只剩 1
  await expectThrowAsync(
    'NaN 过滤后只剩 1 抛错',
    () =>
      mc.run(
        { trade_returns_pct: returns, strategy_key: 'test' },
        { persist: false }
      ),
    '无法重排'
  );
}

async function testAllLossesScenario() {
  console.log('\n## end-to-end — 全损失场景');
  const mc = new MonteCarloStressTest();
  // 全负 returns → 所有模拟都亏损（复利顺序无关）
  const returns = [-2, -3, -1, -4, -2];
  const out = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { simulation_count: 100, seed: 42, persist: false }
  );
  const expectedFinal = (Math.pow(0.98, 1) * Math.pow(0.97, 1) * Math.pow(0.99, 1) * Math.pow(0.96, 1) * Math.pow(0.98, 1) - 1) * 100;
  expectClose('全负 → 所有 final_return < 0', out.distribution.return_p95!, expectedFinal, 1e-4);
  expectClose('全负 → return_p5 = return_p95 (复利无序)', out.distribution.return_p5!, expectedFinal, 1e-4);
  expectClose('全负 → positive_ratio = 0', out.distribution.positive_simulation_ratio!, 0);
  // 所有 dd > 0（亏损 = 回撤）
  const allDdPositive = out.outcomes.every(o => o.max_drawdown_pct > 0);
  expectEqual('全负 → 所有 dd > 0', allDdPositive, true);
}

async function testAllProfitsScenario() {
  console.log('\n## end-to-end — 全盈利场景');
  const mc = new MonteCarloStressTest();
  const returns = [5, 3, 8, 2, 10];
  const out = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { simulation_count: 100, seed: 42, persist: false }
  );
  const expectedFinal = (1.05 * 1.03 * 1.08 * 1.02 * 1.10 - 1) * 100;
  expectClose('全正 → final_return all > 0', out.distribution.return_p5!, expectedFinal, 1e-4);
  expectClose('全正 → positive_ratio = 1', out.distribution.positive_simulation_ratio!, 1);
  // 所有 dd = 0（单调上升，无回撤）
  const allDdZero = out.outcomes.every(o => o.max_drawdown_pct === 0);
  expectEqual('全正 → 所有 dd = 0', allDdZero, true);
}

async function testLargeSimulationsDistributionSmoothing() {
  console.log('\n## end-to-end — 1000 次模拟分布平滑性');
  const mc = new MonteCarloStressTest();
  const returns = [10, -5, 8, -3, 12, -7, 6, -2, 9, -4, 15, -8, 5, -1, 11];
  const out = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { simulation_count: 1000, seed: 42, persist: false }
  );
  expectEqual('1000 outcomes', out.outcomes.length, 1000);
  expectEqual('1000 simulation_count', out.distribution.simulation_count, 1000);

  // dd_p95 应该比 dd_p50 大
  const dds = out.outcomes.map(o => o.max_drawdown_pct).sort((a, b) => a - b);
  const dd_p50 = computeQuantile(dds, 0.5)!;
  const dd_p95 = computeQuantile(dds, 0.95)!;
  assert(
    'dd_p95 > dd_p50 (分布单调)',
    out.distribution.drawdown_p95! >= dd_p50,
    `p95=${out.distribution.drawdown_p95} p50=${dd_p50}`
  );
  expectClose('dd_p95 与手算一致', out.distribution.drawdown_p95!, dd_p95, 1e-4);

  // sharpe_p5 应该比 sharpe_mean 小
  const sharpes = out.outcomes
    .map(o => o.sharpe)
    .filter((v): v is number => v !== null);
  const sharpeMean = sharpes.reduce((s, v) => s + v, 0) / sharpes.length;
  assert(
    'sharpe_p5 ≤ sharpe_mean',
    out.distribution.sharpe_p5! <= sharpeMean,
    `p5=${out.distribution.sharpe_p5} mean=${sharpeMean}`
  );
}

async function testDefaultOptions() {
  console.log('\n## end-to-end — 默认 options');
  const mc = new MonteCarloStressTest();
  const returns = [5, -3, 8, -2, 10];
  const out = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { persist: false } // 没传 simulation_count / seed
  );
  expectEqual('默认 simulation_count = 1000', out.simulation_count, 1000);
  expectEqual('默认 seed = 42', out.seed, 42);
}

async function testUnknownStrategyKeyFallback() {
  console.log('\n## end-to-end — 未提供 strategy_key 退化为 "unknown"');
  const mc = new MonteCarloStressTest();
  const returns = [5, -3, 8];
  const out = await mc.run(
    { trade_returns_pct: returns }, // 无 strategy_key
    { simulation_count: 10, persist: false }
  );
  expectEqual('strategy_key fallback = unknown', out.strategy_key, 'unknown');
}

async function testFakeSourceErrorPropagates() {
  console.log('\n## end-to-end — fake source 抛错 propagate');
  const mc = new MonteCarloStressTest();
  const throwingSource: TradeReturnSource = {
    async loadTradeReturns(_id: number) {
      throw new Error('simulated DB outage');
    },
  };
  await expectThrowAsync(
    'fake source error propagate',
    () =>
      mc.run(
        { quant_backtest_result_id: 999 },
        { simulation_count: 10, persist: false, trade_return_source: throwingSource }
      ),
    'simulated DB outage'
  );
}

async function testInMemoryTakesPrecedenceOverDB() {
  console.log('\n## end-to-end — in-memory 优先于 DB');
  const mc = new MonteCarloStressTest();
  // fake source 会返回不同 returns; in-memory 提供的应该优先
  const dbReturns = [100, -100]; // 极端测试值
  const inMemReturns = [5, -3, 8];
  const out = await mc.run(
    {
      quant_backtest_result_id: 999, // 这会触发 source 但…
      trade_returns_pct: inMemReturns, // …此处被优先
      strategy_key: 'test',
    },
    {
      simulation_count: 10,
      persist: false,
      trade_return_source: makeFakeSource(dbReturns, 'db_strategy'),
    }
  );
  expectEqual('使用 in-memory returns', out.distribution.trade_count, inMemReturns.length);
  // 复利从 [5,-3,8] 算应 ≈ 9.61
  const expected = (1.05 * 0.97 * 1.08 - 1) * 100;
  // 任一模拟应该接近此值（复利无序）
  expectClose('in-memory 复利值', out.outcomes[0].final_return_pct, expected, 1e-6);
}

async function testExtremeValues() {
  console.log('\n## end-to-end — 极端 returns 值不爆');
  const mc = new MonteCarloStressTest();
  // 含 -100% 爆仓 trade
  const returns = [5, -3, -100, 8, 10];
  const out = await mc.run(
    { trade_returns_pct: returns, strategy_key: 'test' },
    { simulation_count: 50, seed: 42, persist: false }
  );
  // 所有模拟都会爆仓（-100% 在序列里）→ final = -100
  const allCrashed = out.outcomes.every(o => o.final_return_pct === -100);
  expectEqual('所有模拟爆仓 → final=-100', allCrashed, true);
  // dd 也应该是 100
  const allDd100 = out.outcomes.every(o => o.max_drawdown_pct === 100);
  expectEqual('所有模拟 dd=100', allDd100, true);
}

// ============================================================
// main
// ============================================================

async function main() {
  console.log('Running MonteCarloStressTest tests (US-043)...');

  // 同步纯函数测试
  runConstantsTests();
  runComputeQuantileTests();
  runBootstrapResampleTests();
  runComputeSimulationFinalReturnTests();
  runComputeSimulationMaxDrawdownTests();
  runComputeSimulationSharpeTests();
  runAggregateSimulationsTests();

  // 异步 end-to-end 测试（必须串行 await — 防 IIFE 异步竞争 [US-037 lesson]）
  await testRunInMemorySimple();
  await testRunFromFakeSource();
  await testSeedReproducibility();
  await testDifferentSeedsDifferOutcomes();
  await testInvalidSimulationCount();
  await testInsufficientTrades();
  await testMissingInputThrows();
  await testInMemoryNaNFiltered();
  await testInsufficientTradesAfterNaNFilter();
  await testAllLossesScenario();
  await testAllProfitsScenario();
  await testLargeSimulationsDistributionSmoothing();
  await testDefaultOptions();
  await testUnknownStrategyKeyFallback();
  await testFakeSourceErrorPropagates();
  await testInMemoryTakesPrecedenceOverDB();
  await testExtremeValues();

  console.log(`\n${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('test runner failed:', err);
  process.exit(2);
});
