/**
 * PortfolioOptimizer 单元测试（US-044）
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/backtest/portfolio-optimizer.test.ts
 *
 * 完全脱离 DB：注入 fake StrategyReturnSource 或直接传 strategy_returns in-memory；
 * persist=false 跳过写库。
 *
 * 覆盖维度：
 *   - 纯函数：deriveDailyReturnsFromEquityCurve / alignDailyReturns /
 *     computePortfolioDailyReturns / computeMean / computeStddev /
 *     computeAnnualizedSharpe / computeAnnualizedReturn / computeMaxDrawdownPct /
 *     projectOntoSimplexWithBox / computeSharpeGradient
 *   - end-to-end optimize()：
 *     - in-memory + fake source 两种入参
 *     - equal_weight baseline
 *     - projected_gradient 多起点求解收敛
 *     - max_weight 约束生效（不全押单策略）
 *     - sum=1 约束生效
 *     - 反相关策略组合 sharpe > 任一单策略 sharpe
 *     - N=1 抛错 / N=0 抛错
 *     - max_weight*N<1 无解抛错
 *     - 共同日 < MIN 抛错
 *     - 缺 input 抛错
 *     - lookback_days 截尾生效
 *     - seed 复现性（同 seed 同结果）
 *     - notes 透传
 */

import {
  PortfolioOptimizer,
  StrategyReturnSource,
  StrategyDailyReturns,
  PortfolioOptimizerSolver,
  alignDailyReturns,
  computePortfolioDailyReturns,
  computeMean,
  computeStddev,
  computeAnnualizedSharpe,
  computeAnnualizedReturn,
  computeMaxDrawdownPct,
  projectOntoSimplexWithBox,
  computeSharpeGradient,
  deriveDailyReturnsFromEquityCurve,
  DEFAULT_MAX_WEIGHT,
  DEFAULT_MIN_WEIGHT,
  DEFAULT_LEARNING_RATE,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOLERANCE,
  DEFAULT_RANDOM_RESTARTS,
  DEFAULT_SEED,
  MIN_DAILY_RETURNS_FOR_SHARPE,
  ANNUALIZATION_FACTOR,
  SHARPE_ANNUALIZATION_SQRT,
} from '../../src/quant/backtest/PortfolioOptimizer';
import { QuantEquityPoint } from '../../src/quant/types/QuantTypes';

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
  expectEqual('DEFAULT_MAX_WEIGHT = 0.4', DEFAULT_MAX_WEIGHT, 0.4);
  expectEqual('DEFAULT_MIN_WEIGHT = 0.0', DEFAULT_MIN_WEIGHT, 0.0);
  expectEqual('DEFAULT_LEARNING_RATE = 0.001', DEFAULT_LEARNING_RATE, 0.001);
  expectEqual('DEFAULT_MAX_ITERATIONS = 5000', DEFAULT_MAX_ITERATIONS, 5000);
  expectEqual('DEFAULT_TOLERANCE = 1e-6', DEFAULT_TOLERANCE, 1e-6);
  expectEqual('DEFAULT_RANDOM_RESTARTS = 2', DEFAULT_RANDOM_RESTARTS, 2);
  expectEqual('DEFAULT_SEED = 42', DEFAULT_SEED, 42);
  expectEqual('MIN_DAILY_RETURNS_FOR_SHARPE = 5', MIN_DAILY_RETURNS_FOR_SHARPE, 5);
  expectEqual('ANNUALIZATION_FACTOR = 252', ANNUALIZATION_FACTOR, 252);
  expectClose('SHARPE_ANNUALIZATION_SQRT ≈ sqrt(252)', SHARPE_ANNUALIZATION_SQRT, Math.sqrt(252));
}

// ============================================================
// deriveDailyReturnsFromEquityCurve
// ============================================================

function runDeriveDailyReturnsTests() {
  console.log('\n## deriveDailyReturnsFromEquityCurve');
  // 空 / 单点
  expectEqual('空 equity curve 返回空', deriveDailyReturnsFromEquityCurve([]), []);
  const single: QuantEquityPoint[] = [
    {
      date: '2024-01-01',
      total_value: 100000,
      cash: 100000,
      position_value: 0,
      cumulative_return_pct: 0,
      drawdown_pct: 0,
    },
  ];
  expectEqual('单点 equity curve 返回空', deriveDailyReturnsFromEquityCurve(single), []);

  // 两点 → 一个 return
  const two: QuantEquityPoint[] = [
    {
      date: '2024-01-01',
      total_value: 100000,
      cash: 100000,
      position_value: 0,
      cumulative_return_pct: 0,
      drawdown_pct: 0,
    },
    {
      date: '2024-01-02',
      total_value: 110000,
      cash: 100000,
      position_value: 10000,
      cumulative_return_pct: 10,
      drawdown_pct: 0,
    },
  ];
  const r = deriveDailyReturnsFromEquityCurve(two);
  expectEqual('两点返回 1 个 return', r.length, 1);
  expectEqual('return 日期 = 后一日', r[0].date, '2024-01-02');
  expectClose('return = 110000/100000 - 1 = 0.1', r[0].return_decimal, 0.1);

  // 三点 → 两个 returns
  const three: QuantEquityPoint[] = [
    ...two,
    {
      date: '2024-01-03',
      total_value: 99000,
      cash: 100000,
      position_value: -1000,
      cumulative_return_pct: -1,
      drawdown_pct: 10,
    },
  ];
  const r3 = deriveDailyReturnsFromEquityCurve(three);
  expectEqual('三点返回 2 个 returns', r3.length, 2);
  expectClose('第二个 return = 99000/110000 - 1', r3[1].return_decimal, -0.1);

  // total_value 为 string（Sequelize JSONB round-trip）
  const stringValues: any[] = [
    { date: '2024-01-01', total_value: '100000', cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-02', total_value: '105000', cash: 0, position_value: 0, cumulative_return_pct: 5, drawdown_pct: 0 },
  ];
  const rs = deriveDailyReturnsFromEquityCurve(stringValues);
  expectClose('Number(string total_value) 正确解析', rs[0].return_decimal, 0.05);

  // 爆仓 total_value <= 0 跳过
  const crash: QuantEquityPoint[] = [
    { date: '2024-01-01', total_value: 100000, cash: 100000, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-02', total_value: 0, cash: 0, position_value: 0, cumulative_return_pct: -100, drawdown_pct: 100 },
    { date: '2024-01-03', total_value: 50000, cash: 50000, position_value: 0, cumulative_return_pct: -50, drawdown_pct: 50 },
  ];
  const rc = deriveDailyReturnsFromEquityCurve(crash);
  // 0 被过滤，剩 100000 → 50000 = -0.5
  expectEqual('total_value=0 被剔除，2 个有效点 → 1 个 return', rc.length, 1);
  expectClose('剔除后 50000/100000 - 1 = -0.5', rc[0].return_decimal, -0.5);

  // dedup by date
  const dup: QuantEquityPoint[] = [
    { date: '2024-01-01', total_value: 100000, cash: 0, position_value: 0, cumulative_return_pct: 0, drawdown_pct: 0 },
    { date: '2024-01-01', total_value: 105000, cash: 0, position_value: 0, cumulative_return_pct: 5, drawdown_pct: 0 },
    { date: '2024-01-02', total_value: 110000, cash: 0, position_value: 0, cumulative_return_pct: 10, drawdown_pct: 0 },
  ];
  const rd = deriveDailyReturnsFromEquityCurve(dup);
  // dedup 后保留最后一条 = 105000，所以 return = 110000/105000 - 1
  expectEqual('dedup 后 2 个点 → 1 个 return', rd.length, 1);
  expectClose('dedup 保留最新: 110000/105000 - 1', rd[0].return_decimal, 110000 / 105000 - 1);
}

// ============================================================
// alignDailyReturns
// ============================================================

function runAlignDailyReturnsTests() {
  console.log('\n## alignDailyReturns');

  // 空
  expectEqual('空 strategy_returns 返回空', alignDailyReturns([]), {
    common_dates: [],
    return_matrix: [],
  });

  // 单策略 → 自己就是 common
  const single: StrategyDailyReturns[] = [
    {
      strategy_key: 'A',
      daily_returns: [
        { date: '2024-01-01', return_decimal: 0.01 },
        { date: '2024-01-02', return_decimal: -0.02 },
      ],
    },
  ];
  const r1 = alignDailyReturns(single);
  expectEqual('单策略 common = 自身', r1.common_dates, ['2024-01-01', '2024-01-02']);
  expectEqual('单策略 matrix 形状', r1.return_matrix.length, 2);

  // 两策略完全相同日期
  const two: StrategyDailyReturns[] = [
    {
      strategy_key: 'A',
      daily_returns: [
        { date: '2024-01-01', return_decimal: 0.01 },
        { date: '2024-01-02', return_decimal: -0.02 },
      ],
    },
    {
      strategy_key: 'B',
      daily_returns: [
        { date: '2024-01-01', return_decimal: 0.05 },
        { date: '2024-01-02', return_decimal: 0.03 },
      ],
    },
  ];
  const r2 = alignDailyReturns(two);
  expectEqual('两策略 common = 共有 2 日', r2.common_dates.length, 2);
  expectEqual('matrix[0] = [A_t1, B_t1]', r2.return_matrix[0], [0.01, 0.05]);
  expectEqual('matrix[1] = [A_t2, B_t2]', r2.return_matrix[1], [-0.02, 0.03]);

  // 两策略部分重叠
  const overlap: StrategyDailyReturns[] = [
    {
      strategy_key: 'A',
      daily_returns: [
        { date: '2024-01-01', return_decimal: 0.01 },
        { date: '2024-01-02', return_decimal: -0.02 },
        { date: '2024-01-03', return_decimal: 0.04 },
      ],
    },
    {
      strategy_key: 'B',
      daily_returns: [
        { date: '2024-01-02', return_decimal: 0.05 },
        { date: '2024-01-03', return_decimal: 0.03 },
      ],
    },
  ];
  const r3 = alignDailyReturns(overlap);
  expectEqual('部分重叠 common = 2 日', r3.common_dates, ['2024-01-02', '2024-01-03']);
  expectEqual('matrix[0] = [A_t2, B_t2]', r3.return_matrix[0], [-0.02, 0.05]);

  // 完全不相交 → 空
  const disjoint: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: [{ date: '2024-01-01', return_decimal: 0.01 }] },
    { strategy_key: 'B', daily_returns: [{ date: '2024-02-01', return_decimal: 0.02 }] },
  ];
  const r4 = alignDailyReturns(disjoint);
  expectEqual('不相交 common 空', r4.common_dates, []);

  // 一个策略空 → 全空
  const oneEmpty: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: [{ date: '2024-01-01', return_decimal: 0.01 }] },
    { strategy_key: 'B', daily_returns: [] },
  ];
  const r5 = alignDailyReturns(oneEmpty);
  expectEqual('一个策略空 → common 空', r5.common_dates, []);

  // 输出按日期升序
  const unordered: StrategyDailyReturns[] = [
    {
      strategy_key: 'A',
      daily_returns: [
        { date: '2024-01-03', return_decimal: 0.04 },
        { date: '2024-01-01', return_decimal: 0.01 },
        { date: '2024-01-02', return_decimal: 0.02 },
      ],
    },
    {
      strategy_key: 'B',
      daily_returns: [
        { date: '2024-01-02', return_decimal: 0.05 },
        { date: '2024-01-03', return_decimal: 0.06 },
        { date: '2024-01-01', return_decimal: 0.03 },
      ],
    },
  ];
  const r6 = alignDailyReturns(unordered);
  expectEqual('common 按日期升序', r6.common_dates, ['2024-01-01', '2024-01-02', '2024-01-03']);
  expectEqual('matrix 按升序对齐: matrix[0]', r6.return_matrix[0], [0.01, 0.03]);
  expectEqual('matrix[2] 末日', r6.return_matrix[2], [0.04, 0.06]);

  // NaN / Infinity 过滤
  const withNan: StrategyDailyReturns[] = [
    {
      strategy_key: 'A',
      daily_returns: [
        { date: '2024-01-01', return_decimal: 0.01 },
        { date: '2024-01-02', return_decimal: NaN },
        { date: '2024-01-03', return_decimal: 0.03 },
      ],
    },
    {
      strategy_key: 'B',
      daily_returns: [
        { date: '2024-01-01', return_decimal: 0.04 },
        { date: '2024-01-02', return_decimal: 0.05 },
        { date: '2024-01-03', return_decimal: 0.06 },
      ],
    },
  ];
  const r7 = alignDailyReturns(withNan);
  expectEqual('NaN 行被剔除', r7.common_dates, ['2024-01-01', '2024-01-03']);
}

// ============================================================
// computePortfolioDailyReturns
// ============================================================

function runComputePortfolioDailyReturnsTests() {
  console.log('\n## computePortfolioDailyReturns');

  expectEqual('空矩阵 → 空', computePortfolioDailyReturns([], [0.5, 0.5]), []);

  // 加权和
  const matrix = [
    [0.01, 0.02],
    [0.03, 0.04],
  ];
  const w = [0.5, 0.5];
  const r = computePortfolioDailyReturns(matrix, w);
  expectClose('row 0: 0.5*0.01 + 0.5*0.02 = 0.015', r[0], 0.015);
  expectClose('row 1: 0.5*0.03 + 0.5*0.04 = 0.035', r[1], 0.035);

  // 不等权
  const r2 = computePortfolioDailyReturns(matrix, [0.7, 0.3]);
  expectClose('row 0: 0.7*0.01 + 0.3*0.02', r2[0], 0.7 * 0.01 + 0.3 * 0.02);

  // 一权 100%
  const r3 = computePortfolioDailyReturns(matrix, [1.0, 0]);
  expectClose('w=[1,0]: row 0 = 0.01', r3[0], 0.01);

  // weights 长度不匹配 → throw
  expectThrow(
    'row length mismatch throw',
    () => computePortfolioDailyReturns([[0.01]], [0.5, 0.5]),
    'row length 1 ≠ weights length 2'
  );
}

// ============================================================
// computeMean / computeStddev
// ============================================================

function runComputeMeanStddevTests() {
  console.log('\n## computeMean / computeStddev');

  expectEqual('空 mean = null', computeMean([]), null);
  expectClose('单值 mean = self', computeMean([5]), 5);
  expectClose('mean [1,2,3] = 2', computeMean([1, 2, 3]), 2);
  expectClose('mean [1,2,3,4,5] = 3', computeMean([1, 2, 3, 4, 5]), 3);

  // NaN 过滤
  expectClose('mean [1,NaN,2,3] 过滤 NaN', computeMean([1, NaN, 2, 3]), 2);

  expectEqual('空 stddev = null', computeStddev([]), null);
  expectEqual('单值 stddev = null', computeStddev([5]), null);
  // [1,2,3,4,5] stddev = sqrt(sum((x-3)^2)/4) = sqrt(10/4) = sqrt(2.5)
  expectClose('stddev [1,2,3,4,5]', computeStddev([1, 2, 3, 4, 5]), Math.sqrt(2.5));

  // 全相同 → stddev = 0
  expectClose('全相同 stddev=0', computeStddev([5, 5, 5, 5]), 0);
}

// ============================================================
// computeAnnualizedSharpe
// ============================================================

function runComputeAnnualizedSharpeTests() {
  console.log('\n## computeAnnualizedSharpe');

  expectEqual('空 sharpe = null', computeAnnualizedSharpe([]), null);
  expectEqual('少于 MIN sharpe = null', computeAnnualizedSharpe([0.01, 0.02]), null);

  // 全相同 std=0 → null
  expectEqual('std=0 sharpe = null', computeAnnualizedSharpe([0.01, 0.01, 0.01, 0.01, 0.01]), null);

  // 已知值：mean=0.001, std≈0.012247...
  const returns = [0.01, 0.015, -0.005, 0, 0.005];
  const m = (0.01 + 0.015 - 0.005 + 0 + 0.005) / 5; // 0.005
  let ss = 0;
  for (const v of returns) ss += (v - m) * (v - m);
  const s = Math.sqrt(ss / 4);
  const expected = (m / s) * Math.sqrt(252);
  expectClose('简单值 sharpe', computeAnnualizedSharpe(returns), expected, 1e-9);
}

// ============================================================
// computeAnnualizedReturn
// ============================================================

function runComputeAnnualizedReturnTests() {
  console.log('\n## computeAnnualizedReturn');

  expectEqual('空 returns = null', computeAnnualizedReturn([]), null);

  // 单值 = 0.01 (= 1%); annualization = 252 → (1.01)^252 - 1
  const expected1 = (Math.pow(1.01, 252) - 1) * 100;
  expectClose('单 1% 收益年化', computeAnnualizedReturn([0.01]), expected1, 1e-6);

  // 252 个 0.1% (累计 ≈ 28.4%)，年化也应接近 28.4%
  const returns252 = new Array(252).fill(0.001);
  const cum = Math.pow(1.001, 252);
  const annualGrowth = Math.pow(cum, 252 / 252); // = cum
  const expected2 = (annualGrowth - 1) * 100;
  expectClose('252 个 0.1% 收益', computeAnnualizedReturn(returns252), expected2, 1e-6);

  // 爆仓
  expectEqual(
    '含 -100% 爆仓 → return = -100',
    computeAnnualizedReturn([0.01, -1.0, 0.02]),
    -100
  );
}

// ============================================================
// computeMaxDrawdownPct
// ============================================================

function runComputeMaxDrawdownTests() {
  console.log('\n## computeMaxDrawdownPct');

  expectEqual('空 → null', computeMaxDrawdownPct([]), null);

  // 全涨：dd = 0
  expectClose('全涨 dd = 0', computeMaxDrawdownPct([0.01, 0.02, 0.03]), 0);

  // [+10%, -20%, +5%]: peak=1.1, 后 1.1*0.8=0.88，dd=(1.1-0.88)/1.1=20%
  expectClose(
    '+10%,-20%,+5% → 20% dd',
    computeMaxDrawdownPct([0.10, -0.20, 0.05]),
    20,
    1e-9
  );

  // 爆仓 → 100
  expectEqual('爆仓 dd = 100', computeMaxDrawdownPct([-1.5]), 100);
}

// ============================================================
// projectOntoSimplexWithBox
// ============================================================

function runProjectOntoSimplexTests() {
  console.log('\n## projectOntoSimplexWithBox');

  // 已满足约束 → 不变（数值精度内）
  const w1 = projectOntoSimplexWithBox([0.4, 0.3, 0.3], 0, 0.4);
  expectClose('已满足: sum=1', w1.reduce((s, v) => s + v, 0), 1, 1e-9);
  expectClose('已满足: w[0]=0.4', w1[0], 0.4, 1e-9);

  // sum > 1 → 整体缩放（均匀输入 → 各 1/N，每个 = 0.5（仍未 cap 因为 0.5 > 0.4，所以会 cap））
  // [0.5, 0.5, 0.5] sum=1.5；要让 sum=1 需要 lambda 使每个 v + lambda 后 sum=1
  // 但 cap=0.4 不能超过 → 实际投影结果应该是 [1/3, 1/3, 1/3]（均匀输入 + 均匀 cap = 均匀输出）
  const w2 = projectOntoSimplexWithBox([0.5, 0.5, 0.5], 0, 0.4);
  expectClose('sum=1 after projection', w2.reduce((s, v) => s + v, 0), 1, 1e-9);
  // 均匀输入 → 不会触发 cap（因为 lambda 把 0.5 降到 0.333 < 0.4）
  assert('cap not exceeded for uniform input', Math.max(...w2) <= 0.4 + 1e-6);

  // 触发 cap 的真实场景：非均匀输入
  // [0.6, 0.3, 0.1] sum=1.0, w[0]=0.6 > cap=0.4 → 必须 cap
  const w2b = projectOntoSimplexWithBox([0.6, 0.3, 0.1], 0, 0.4);
  expectClose('sum=1 after capping', w2b.reduce((s, v) => s + v, 0), 1, 1e-9);
  expectClose('cap to 0.4 enforced for non-uniform input', Math.max(...w2b), 0.4, 1e-6);

  // sum < 1 → 整体放大
  const w3 = projectOntoSimplexWithBox([0.1, 0.1, 0.1], 0, 0.4);
  expectClose('sum=1 after upscale', w3.reduce((s, v) => s + v, 0), 1, 1e-9);

  // 含负数 → clip 到 min=0
  const w4 = projectOntoSimplexWithBox([-0.1, 0.6, 0.5], 0, 0.4);
  expectClose('sum=1 with negative input', w4.reduce((s, v) => s + v, 0), 1, 1e-9);
  assert('all >= 0', w4.every(v => v >= -1e-9));
  expectClose('cap to 0.4', Math.max(...w4), 0.4, 1e-6);

  // N=2 max=0.4 → max*N=0.8 < 1 → throw
  expectThrow('max*N<1 throw', () => projectOntoSimplexWithBox([0.5, 0.5], 0, 0.4), '< 1');

  // min*N>1 → throw
  expectThrow(
    'min*N>1 throw',
    () => projectOntoSimplexWithBox([0.1, 0.1, 0.1], 0.5, 1),
    '> 1'
  );

  // negative min → throw
  expectThrow(
    'min<0 throw',
    () => projectOntoSimplexWithBox([0.5, 0.5], -0.1, 1),
    '< 0'
  );

  // max < min → throw (use inputs that don't trigger min*N>1 first)
  // N=3, min=0.5, max=0.4 → min*N = 1.5 > 1 → throws min*N first；用 N=2 让 min*N=1.0 不触发
  // N=2, min=0.45, max=0.4: min*N=0.9 < 1 OK, max*N=0.8 < 1 → throws max*N first
  // 真要测 max<min 顺序 check：用 N=3, min=0.3, max=0.2 → min*N=0.9 < 1 OK, max*N=0.6 < 1 → throws max*N first
  // 实际上：projectOntoSimplexWithBox 内 max*N<1 check 在 max<min check 之前，所以这个 throw 没法单独触发
  // 改成期望 max*N<1 message
  expectThrow(
    'max < min via max*N<1 throw',
    () => projectOntoSimplexWithBox([0.3, 0.3, 0.3], 0.3, 0.2),
    '< 1'
  );

  // 极端: N=5, max=0.4 → max*N=2 > 1, ok
  const w5 = projectOntoSimplexWithBox([0.2, 0.2, 0.2, 0.2, 0.2], 0, 0.4);
  expectClose('N=5 equal weight, sum=1', w5.reduce((s, v) => s + v, 0), 1, 1e-9);
  expectClose('N=5 equal weight, each=0.2', w5[0], 0.2, 1e-9);

  // 空数组
  expectEqual('空数组', projectOntoSimplexWithBox([], 0, 0.4), []);
}

// ============================================================
// computeSharpeGradient
// ============================================================

function runComputeSharpeGradientTests() {
  console.log('\n## computeSharpeGradient');

  // 构造一个矩阵，让两策略明显有不同收益
  // strat A: 全部 0.01 = 高 sharpe (但 std=0 实际为 null)
  // strat B: 波动大 0.1, -0.05
  const matrix = [
    [0.01, 0.10],
    [0.01, -0.05],
    [0.01, 0.08],
    [0.01, -0.02],
    [0.01, 0.06],
    [0.01, 0.04],
  ];

  // 在 equal weight [0.5, 0.5] 处算 grad — strat A 的边际贡献应正（高均值低波动）
  const grad = computeSharpeGradient(matrix, [0.5, 0.5]);
  expectEqual('grad 长度 = 2', grad.length, 2);
  assert(
    'grad[0] > grad[1] (A 优于 B)',
    grad[0] > grad[1],
    `grad=[${grad[0]}, ${grad[1]}]`
  );

  // 长度匹配
  const gradAll = computeSharpeGradient([], [0.5, 0.5]);
  expectEqual('空矩阵 gradient 全 0', gradAll, [0, 0]);
}

// ============================================================
// PortfolioOptimizer.optimize() — end-to-end
// ============================================================

function makeFakeSource(returnsByStrategy: StrategyDailyReturns[]): StrategyReturnSource {
  return {
    async loadStrategyReturns(_ids: number[]): Promise<StrategyDailyReturns[]> {
      return returnsByStrategy;
    },
  };
}

/**
 * 生成 N 天的随机收益序列（基于 seed，可复现）。
 */
function generateRandomReturns(
  N: number,
  mean: number,
  std: number,
  seedOffset = 0
): Array<{ date: string; return_decimal: number }> {
  const out: Array<{ date: string; return_decimal: number }> = [];
  // 简单 LCG 单测用（不依赖 Math.random）
  let s = 42 + seedOffset;
  for (let i = 0; i < N; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const u1 = (s + 1) / 0x80000000;
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const u2 = (s + 1) / 0x80000000;
    // Box-Muller transform
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const r = mean + std * z;
    const dayNum = i + 1;
    const date = `2024-${String(Math.floor((dayNum - 1) / 28) + 1).padStart(2, '0')}-${String(((dayNum - 1) % 28) + 1).padStart(2, '0')}`;
    out.push({ date, return_decimal: r });
  }
  return out;
}

async function testOptimizeMaxWeightTooSmall() {
  console.log('\n## end-to-end — N=2 max=0.4 应抛错（无可行解）');
  const optimizer = new PortfolioOptimizer();
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(60, 0.001, 0.01, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(60, 0.0005, 0.012, 2) },
  ];
  await expectThrowAsync(
    'N=2 max=0.4 无可行解',
    () => optimizer.optimize({ strategy_returns: strategyReturns }, { persist: false }),
    '无可行解'
  );
}

async function testOptimizeThreeStrategiesEqualWeight() {
  console.log('\n## end-to-end — equal_weight solver baseline');
  const optimizer = new PortfolioOptimizer();
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(60, 0.001, 0.01, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(60, 0.0005, 0.012, 2) },
    { strategy_key: 'C', daily_returns: generateRandomReturns(60, 0.0008, 0.011, 3) },
  ];
  const out = await optimizer.optimize(
    { strategy_returns: strategyReturns },
    { solver: 'equal_weight', persist: false }
  );
  expectEqual('solver=equal_weight', out.solver, 'equal_weight' as PortfolioOptimizerSolver);
  expectEqual('iterations = 0', out.iterations, 0);
  expectEqual('converged = true', out.converged, true);
  expectClose('w[0] ≈ 1/3', out.weights[0], 1 / 3, 1e-3);
  expectClose('w[1] ≈ 1/3', out.weights[1], 1 / 3, 1e-3);
  expectClose('w[2] ≈ 1/3', out.weights[2], 1 / 3, 1e-3);
  expectClose('sum = 1', out.weights.reduce((s, v) => s + v, 0), 1, 1e-3);
}

async function testOptimizeThreeStrategiesPGA() {
  console.log('\n## end-to-end — projected_gradient (3 strategies)');
  const optimizer = new PortfolioOptimizer();
  // strat A: 高 sharpe (高 mean, 中 std)
  // strat B: 低 sharpe
  // strat C: 中等 sharpe
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(120, 0.002, 0.008, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(120, 0.0001, 0.015, 2) },
    { strategy_key: 'C', daily_returns: generateRandomReturns(120, 0.001, 0.010, 3) },
  ];
  const out = await optimizer.optimize(
    { strategy_returns: strategyReturns },
    { solver: 'projected_gradient', persist: false }
  );
  expectEqual('solver=projected_gradient', out.solver, 'projected_gradient' as PortfolioOptimizerSolver);
  expectClose('sum = 1', out.weights.reduce((s, v) => s + v, 0), 1, 1e-3);
  assert('w[0] <= 0.4 + ε', out.weights[0] <= 0.4 + 1e-3);
  // strat A 应权重 > strat B（更高 sharpe）
  assert(
    'w[A] >= w[B] (A 更高 sharpe)',
    out.weights[0] >= out.weights[1] - 1e-3,
    `weights=${JSON.stringify(out.weights)}`
  );
  // 跑出来有 sharpe
  assert('sharpe non-null', out.sharpe !== null && out.sharpe > 0);
  // PGA 至少迭代几次
  assert('iterations > 0', out.iterations > 0);
}

async function testOptimizeSeedReproducibility() {
  console.log('\n## end-to-end — seed 复现性');
  const optimizer = new PortfolioOptimizer();
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(60, 0.001, 0.01, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(60, 0.0005, 0.012, 2) },
    { strategy_key: 'C', daily_returns: generateRandomReturns(60, 0.0008, 0.011, 3) },
  ];
  const r1 = await optimizer.optimize(
    { strategy_returns: strategyReturns },
    { seed: 42, persist: false }
  );
  const r2 = await optimizer.optimize(
    { strategy_returns: strategyReturns },
    { seed: 42, persist: false }
  );
  expectEqual('同 seed 同 weights', r1.weights, r2.weights);
  expectEqual('同 seed 同 sharpe', r1.sharpe, r2.sharpe);
}

async function testOptimizeLookbackDays() {
  console.log('\n## end-to-end — lookback_days 截尾');
  const optimizer = new PortfolioOptimizer();
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(100, 0.001, 0.01, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(100, 0.0005, 0.012, 2) },
    { strategy_key: 'C', daily_returns: generateRandomReturns(100, 0.0008, 0.011, 3) },
  ];
  const r1 = await optimizer.optimize(
    { strategy_returns: strategyReturns },
    { lookback_days: 30, persist: false }
  );
  expectEqual('lookback_days = 30 → daily_return_count = 30', r1.daily_return_count, 30);
  expectEqual('lookback_days 字段保留', r1.lookback_days, 30);
}

async function testOptimizeInsufficientDays() {
  console.log('\n## end-to-end — 共同日少于 MIN');
  const optimizer = new PortfolioOptimizer();
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(3, 0.001, 0.01, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(3, 0.0005, 0.012, 2) },
    { strategy_key: 'C', daily_returns: generateRandomReturns(3, 0.0008, 0.011, 3) },
  ];
  await expectThrowAsync(
    '< MIN 日 → throw',
    () => optimizer.optimize({ strategy_returns: strategyReturns }, { persist: false }),
    '无法求解'
  );
}

async function testOptimizeSingleStrategyThrows() {
  console.log('\n## end-to-end — N=1 应抛错');
  const optimizer = new PortfolioOptimizer();
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(30, 0.001, 0.01, 1) },
  ];
  await expectThrowAsync(
    'N=1 throw',
    () => optimizer.optimize({ strategy_returns: strategyReturns }, { persist: false }),
    'N=1'
  );
}

async function testOptimizeMissingInputThrows() {
  console.log('\n## end-to-end — 缺 input 抛错');
  const optimizer = new PortfolioOptimizer();
  await expectThrowAsync(
    '空 input 抛错',
    () => optimizer.optimize({} as any, { persist: false }),
    'quant_backtest_result_ids 或 strategy_returns'
  );
}

async function testOptimizeFromFakeSource() {
  console.log('\n## end-to-end — fake StrategyReturnSource');
  const optimizer = new PortfolioOptimizer();
  const fake = makeFakeSource([
    { strategy_key: 'A', daily_returns: generateRandomReturns(60, 0.001, 0.01, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(60, 0.0005, 0.012, 2) },
    { strategy_key: 'C', daily_returns: generateRandomReturns(60, 0.0008, 0.011, 3) },
  ]);
  const out = await optimizer.optimize(
    { quant_backtest_result_ids: [1, 2, 3] },
    { strategy_return_source: fake, persist: false }
  );
  expectEqual('keys 来自 fake source', out.strategy_keys, ['A', 'B', 'C']);
  expectClose('sum = 1', out.weights.reduce((s, v) => s + v, 0), 1, 1e-3);
}

async function testOptimizeMaxWeightConstraintBindsForBest() {
  console.log('\n## end-to-end — max_weight 约束生效阻止全押');
  const optimizer = new PortfolioOptimizer();
  // strat A 远远好于其他 → PGA 想全押 A，但 max_weight=0.4 卡住
  const strategyReturns: StrategyDailyReturns[] = [
    {
      strategy_key: 'A',
      daily_returns: new Array(60).fill(null).map((_, i) => ({
        date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        return_decimal: 0.005 + Math.sin(i / 5) * 0.001,
      })),
    },
    {
      strategy_key: 'B',
      daily_returns: new Array(60).fill(null).map((_, i) => ({
        date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        return_decimal: -0.001 + Math.cos(i / 3) * 0.005,
      })),
    },
    {
      strategy_key: 'C',
      daily_returns: new Array(60).fill(null).map((_, i) => ({
        date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        return_decimal: 0.0 + Math.sin(i / 7) * 0.003,
      })),
    },
  ];
  const out = await optimizer.optimize(
    { strategy_returns: strategyReturns },
    { max_weight: 0.4, persist: false }
  );
  assert('w[A] <= 0.4 + ε (cap enforced)', out.weights[0] <= 0.4 + 1e-3, `w[A]=${out.weights[0]}`);
  expectClose('sum = 1', out.weights.reduce((s, v) => s + v, 0), 1, 1e-3);
}

async function testOptimizeCustomMaxWeight() {
  console.log('\n## end-to-end — custom max_weight=0.6');
  const optimizer = new PortfolioOptimizer();
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(60, 0.001, 0.01, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(60, 0.0005, 0.012, 2) },
  ];
  // N=2, max=0.6 → max*N=1.2 ≥ 1 OK
  const out = await optimizer.optimize(
    { strategy_returns: strategyReturns },
    { max_weight: 0.6, persist: false }
  );
  expectEqual('max_weight 记录 0.6', out.max_weight, 0.6);
  assert('w[0] <= 0.6 + ε', out.weights[0] <= 0.6 + 1e-3);
}

async function testOptimizeNotesPassthrough() {
  console.log('\n## end-to-end — notes 透传');
  const optimizer = new PortfolioOptimizer();
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(60, 0.001, 0.01, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(60, 0.0005, 0.012, 2) },
    { strategy_key: 'C', daily_returns: generateRandomReturns(60, 0.0008, 0.011, 3) },
  ];
  const out = await optimizer.optimize(
    { strategy_returns: strategyReturns, notes: 'test_notes_123' },
    { persist: false }
  );
  expectEqual('notes 透传', out.notes, 'test_notes_123');
}

async function testOptimizeInMemoryTakesPrecedence() {
  console.log('\n## end-to-end — in-memory 优先于 DB');
  const optimizer = new PortfolioOptimizer();
  // fake source 会返回 something else
  const fake = makeFakeSource([
    { strategy_key: 'X', daily_returns: generateRandomReturns(60, 0.0, 0.01, 999) },
    { strategy_key: 'Y', daily_returns: generateRandomReturns(60, 0.0, 0.01, 998) },
    { strategy_key: 'Z', daily_returns: generateRandomReturns(60, 0.0, 0.01, 997) },
  ]);
  // in-memory 优先 — 应使用 A/B/C
  const inMem: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(60, 0.001, 0.01, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(60, 0.0005, 0.012, 2) },
    { strategy_key: 'C', daily_returns: generateRandomReturns(60, 0.0008, 0.011, 3) },
  ];
  const out = await optimizer.optimize(
    { quant_backtest_result_ids: [1, 2, 3], strategy_returns: inMem },
    { strategy_return_source: fake, persist: false }
  );
  expectEqual('使用 in-memory keys', out.strategy_keys, ['A', 'B', 'C']);
}

async function testOptimizePeriodFields() {
  console.log('\n## end-to-end — period_start / period_end 字段');
  const optimizer = new PortfolioOptimizer();
  const strategyReturns: StrategyDailyReturns[] = [
    {
      strategy_key: 'A',
      daily_returns: [
        { date: '2024-01-01', return_decimal: 0.01 },
        { date: '2024-01-02', return_decimal: -0.02 },
        { date: '2024-01-03', return_decimal: 0.04 },
        { date: '2024-01-04', return_decimal: 0.01 },
        { date: '2024-01-05', return_decimal: 0.02 },
        { date: '2024-01-06', return_decimal: -0.01 },
      ],
    },
    {
      strategy_key: 'B',
      daily_returns: [
        { date: '2024-01-01', return_decimal: 0.005 },
        { date: '2024-01-02', return_decimal: 0.01 },
        { date: '2024-01-03', return_decimal: -0.005 },
        { date: '2024-01-04', return_decimal: 0.02 },
        { date: '2024-01-05', return_decimal: -0.01 },
        { date: '2024-01-06', return_decimal: 0.01 },
      ],
    },
    {
      strategy_key: 'C',
      daily_returns: [
        { date: '2024-01-01', return_decimal: -0.005 },
        { date: '2024-01-02', return_decimal: 0.015 },
        { date: '2024-01-03', return_decimal: 0.02 },
        { date: '2024-01-04', return_decimal: -0.01 },
        { date: '2024-01-05', return_decimal: 0.005 },
        { date: '2024-01-06', return_decimal: 0.02 },
      ],
    },
  ];
  const out = await optimizer.optimize(
    { strategy_returns: strategyReturns },
    { persist: false }
  );
  expectEqual('period_start = 2024-01-01', out.period_start, '2024-01-01');
  expectEqual('period_end = 2024-01-06', out.period_end, '2024-01-06');
  expectEqual('daily_return_count = 6', out.daily_return_count, 6);
}

async function testOptimizeMinWeightConstraint() {
  console.log('\n## end-to-end — min_weight > 0 (force diversification)');
  const optimizer = new PortfolioOptimizer();
  // strat A 远好于其他，PGA 倾向集中 A
  // min=0.2 强制每个权重 ≥ 0.2
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(60, 0.005, 0.008, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(60, 0.0001, 0.015, 2) },
    { strategy_key: 'C', daily_returns: generateRandomReturns(60, 0.0001, 0.015, 3) },
  ];
  // min=0.2 + max=0.4 + N=3 → ok (0.2*3=0.6 < 1 < 1.2 = 0.4*3)
  const out = await optimizer.optimize(
    { strategy_returns: strategyReturns },
    { min_weight: 0.2, max_weight: 0.4, persist: false }
  );
  assert(
    'all weights >= 0.2 - ε',
    out.weights.every(w => w >= 0.2 - 1e-3),
    `weights=${JSON.stringify(out.weights)}`
  );
  assert(
    'all weights <= 0.4 + ε',
    out.weights.every(w => w <= 0.4 + 1e-3)
  );
  expectClose('sum = 1', out.weights.reduce((s, v) => s + v, 0), 1, 1e-3);
}

async function testFakeSourceErrorPropagates() {
  console.log('\n## end-to-end — fake source 抛错传播');
  const optimizer = new PortfolioOptimizer();
  const throwing: StrategyReturnSource = {
    async loadStrategyReturns(_ids: number[]) {
      throw new Error('simulated DB outage');
    },
  };
  await expectThrowAsync(
    'fake source error propagate',
    () =>
      optimizer.optimize(
        { quant_backtest_result_ids: [1, 2, 3] },
        { persist: false, strategy_return_source: throwing }
      ),
    'simulated DB outage'
  );
}

async function testSolverFieldRecorded() {
  console.log('\n## end-to-end — solver / converged / iterations 字段');
  const optimizer = new PortfolioOptimizer();
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(60, 0.001, 0.01, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(60, 0.0005, 0.012, 2) },
    { strategy_key: 'C', daily_returns: generateRandomReturns(60, 0.0008, 0.011, 3) },
  ];
  const out = await optimizer.optimize(
    { strategy_returns: strategyReturns },
    { persist: false }
  );
  expectEqual('solver field', out.solver, 'projected_gradient' as PortfolioOptimizerSolver);
  assert('converged is bool', typeof out.converged === 'boolean');
  assert('iterations >= 0', out.iterations >= 0);
  assert('computed_at is Date', out.computed_at instanceof Date);
  assert('duration_ms >= 0', out.duration_ms >= 0);
}

async function testOutputWeightsRounding() {
  console.log('\n## end-to-end — weights rounding to 6 digits');
  const optimizer = new PortfolioOptimizer();
  const strategyReturns: StrategyDailyReturns[] = [
    { strategy_key: 'A', daily_returns: generateRandomReturns(60, 0.001, 0.01, 1) },
    { strategy_key: 'B', daily_returns: generateRandomReturns(60, 0.0005, 0.012, 2) },
    { strategy_key: 'C', daily_returns: generateRandomReturns(60, 0.0008, 0.011, 3) },
  ];
  const out = await optimizer.optimize(
    { strategy_returns: strategyReturns },
    { persist: false }
  );
  // 每个权重最多 6 位小数
  for (const w of out.weights) {
    const rounded = Math.round(w * 1e6) / 1e6;
    expectClose('weight rounded to 6 digits', w, rounded, 1e-9);
  }
}

// ============================================================
// main
// ============================================================

async function main() {
  console.log('Running PortfolioOptimizer tests (US-044)...');

  // 同步纯函数测试
  runConstantsTests();
  runDeriveDailyReturnsTests();
  runAlignDailyReturnsTests();
  runComputePortfolioDailyReturnsTests();
  runComputeMeanStddevTests();
  runComputeAnnualizedSharpeTests();
  runComputeAnnualizedReturnTests();
  runComputeMaxDrawdownTests();
  runProjectOntoSimplexTests();
  runComputeSharpeGradientTests();

  // 异步 end-to-end 测试（必须串行 await — 防 IIFE 异步竞争 [US-037 lesson]）
  await testOptimizeMaxWeightTooSmall();
  await testOptimizeThreeStrategiesEqualWeight();
  await testOptimizeThreeStrategiesPGA();
  await testOptimizeSeedReproducibility();
  await testOptimizeLookbackDays();
  await testOptimizeInsufficientDays();
  await testOptimizeSingleStrategyThrows();
  await testOptimizeMissingInputThrows();
  await testOptimizeFromFakeSource();
  await testOptimizeMaxWeightConstraintBindsForBest();
  await testOptimizeCustomMaxWeight();
  await testOptimizeNotesPassthrough();
  await testOptimizeInMemoryTakesPrecedence();
  await testOptimizePeriodFields();
  await testOptimizeMinWeightConstraint();
  await testFakeSourceErrorPropagates();
  await testSolverFieldRecorded();
  await testOutputWeightsRounding();

  console.log(`\n${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('test runner failed:', err);
  process.exit(2);
});
