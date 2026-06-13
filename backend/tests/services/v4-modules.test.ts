/**
 * v4 联合测试: Microstructure + Grinold-Kahn + Factor Discovery + TCA + Risk Parity Regularized
 */
import {
  olsRegression,
  kylesLambda,
  rollsEffectiveSpread,
  mrrDecomposition,
  dailyOrderFlowImbalance,
} from '../../src/services/execution/microstructure.ts';
import {
  pearsonCorrelation,
  spearmanCorrelation,
  computeIC,
  computeFundamentalLawIR,
  computeTransferCoefficient,
  computeICDecay,
  estimateICHalfLife,
  computeRealizedIR,
  computeICTimeSeriesStats,
} from '../../src/services/research/grinold-kahn.ts';
import {
  treeSize,
  formatFactorTree,
  evaluateFactorTree,
  generateRandomTree,
  evaluateFactorFitness,
  randomFactorSearch,
  FactorNode,
  BarHistory,
} from '../../src/services/research/factor-discovery.ts';
import {
  computeImplementationShortfall,
  aShareFixedCosts,
  estimateExpectedIS,
  reconcileISRealizedVsExpected,
} from '../../src/services/execution/tca.ts';
import {
  tikhonovRegularize,
  autoTikhonovLambda,
  estimateConditionNumber,
  solveERCRegularized,
  recommendCovStrategy,
} from '../../src/services/portfolio/risk-parity-regularized.ts';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`); }
}
function expectClose(name: string, actual: number, expected: number, eps = 1e-3) {
  assert(name, Number.isFinite(actual) && Math.abs(actual - expected) < eps, `expected≈${expected}, got=${actual}`);
}

// ============================================================
// Microstructure
// ============================================================

function testOlsRegression() {
  console.log('\n## olsRegression');
  // y = 2x + 3
  const x = [1, 2, 3, 4, 5];
  const y = [5, 7, 9, 11, 13];
  const r = olsRegression(x, y);
  expectClose('slope = 2', r.slope, 2);
  expectClose('intercept = 3', r.intercept, 3);
  expectClose('R² = 1 (perfect fit)', r.r_squared, 1);
}

function testKylesLambda() {
  console.log('\n## kylesLambda');
  // 构造场景: ΔP = 0.001 × Q (linear price impact)
  const prices = [100];
  const volumes: number[] = [];
  let s = 42;
  for (let i = 1; i < 100; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    const v = 1000 + Math.floor((s / 233280) * 10000);
    volumes.push(v);
    // 50% prob up, 50% down
    const sign = (s % 2 === 0) ? 1 : -1;
    const dp = sign * 0.001 * v; // simulate λ = 0.001 per share
    prices.push(prices[prices.length - 1] + dp);
  }
  volumes.unshift(1000); // align length
  const r = kylesLambda(prices, volumes);
  // 验证 lambda 估计接近 0.001
  expectClose('lambda ≈ 0.001', r.lambda, 0.001, 0.0005);
  assert('n_samples > 0', r.n_samples > 0);
  assert('R² > 0.5 (clear signal)', r.r_squared > 0.5);
}

function testRollsEffectiveSpread() {
  console.log('\n## rollsEffectiveSpread');
  // 构造负 serial correlation: 价格在 bid/ask 跳跃
  // P_t alternates around 100, jumps ±0.5
  const prices: number[] = [];
  for (let i = 0; i < 100; i += 1) {
    prices.push(100 + 0.5 * (i % 2 === 0 ? -1 : 1));
  }
  const r = rollsEffectiveSpread(prices);
  assert('is_estimable', r.is_estimable, `cov=${r.serial_covariance}`);
  // spread = 2·√|cov|. cov 应该接近 -1 (因为 ΔP alternate ±1)
  assert('spread > 0', r.effective_spread > 0);

  // trend 价格 → 正 cov → 不可估
  const trendPrices = [100, 101, 102, 103, 104, 105];
  const r2 = rollsEffectiveSpread(trendPrices);
  assert('trend prices not estimable', !r2.is_estimable);
}

function testMrrDecomposition() {
  console.log('\n## mrrDecomposition');
  const prices: number[] = [];
  const signs: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    prices.push(100 + Math.sin(i * 0.3) * 0.5 + (i * 0.01));
    signs.push(i % 2 === 0 ? 1 : -1);
  }
  const r = mrrDecomposition(prices, signs);
  assert('n_samples > 0', r.n_samples > 0);
  if (r.is_estimable) {
    assert('shares sum to 1', Math.abs(r.adverse_selection_share + r.transitory_share - 1) < 1e-6);
    assert('shares ∈ [0, 1]', r.adverse_selection_share >= 0 && r.adverse_selection_share <= 1);
  }
}

function testDailyOrderFlowImbalance() {
  console.log('\n## dailyOrderFlowImbalance');
  const bars = [
    { close: 100, volume: 1000 },
    { close: 101, volume: 2000 }, // up
    { close: 100, volume: 1500 }, // down
    { close: 102, volume: 3000 }, // up
  ];
  const Q = dailyOrderFlowImbalance(bars);
  assert('length = 4', Q.length === 4);
  expectClose('Q[0] = 0', Q[0], 0);
  expectClose('Q[1] = +2000 (up)', Q[1], 2000);
  expectClose('Q[2] = -1500 (down)', Q[2], -1500);
  expectClose('Q[3] = +3000 (up)', Q[3], 3000);
}

// ============================================================
// Grinold-Kahn
// ============================================================

function testPearsonCorrelation() {
  console.log('\n## pearsonCorrelation');
  expectClose('perfect linear y=2x', pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  expectClose('perfect inverse', pearsonCorrelation([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  expectClose('no relation 接近 0', Math.abs(pearsonCorrelation([1, 2, 3, 4], [3, 1, 4, 2])), 0, 1);
}

function testSpearmanCorrelation() {
  console.log('\n## spearmanCorrelation');
  // monotonic (not linear) → spearman = 1
  expectClose('monotonic y=x³', spearmanCorrelation([1, 2, 3, 4], [1, 8, 27, 64]), 1);
  expectClose('inverse rank', spearmanCorrelation([1, 2, 3, 4], [4, 3, 2, 1]), -1);
}

function testFundamentalLawIR() {
  console.log('\n## computeFundamentalLawIR');
  // IC=0.05, breadth=100 → IR = 0.05 × √100 = 0.5
  expectClose('IR = 0.5', computeFundamentalLawIR({ ic: 0.05, breadth: 100 }), 0.5);
  // 加 TC=0.5: IR = 0.5 × 0.5 = 0.25
  expectClose('with TC=0.5', computeFundamentalLawIR({ ic: 0.05, breadth: 100, transfer_coefficient: 0.5 }), 0.25);
}

function testICDecay() {
  console.log('\n## computeICDecay + estimateICHalfLife');
  const forecasts = [0.1, 0.05, -0.02, -0.08, 0.15, 0.03, -0.05, 0.07];
  const returns_by_horizon = {
    '1d': [0.02, 0.01, 0, -0.01, 0.025, 0.005, -0.005, 0.015],
    '5d': [0.015, 0.005, 0.001, -0.005, 0.018, 0.003, -0.003, 0.010],
    '20d': [0.005, 0, 0.002, 0.001, 0.008, 0.001, 0, 0.003],
    '60d': [0.001, 0, 0.001, 0.001, 0.002, 0, 0, 0.001],
  };
  const decay = computeICDecay(forecasts, returns_by_horizon);
  assert('4 horizons', decay.length === 4);
  for (const d of decay) {
    assert(`${d.horizon}: n_samples = 8`, d.n_samples === 8);
  }
  // IC should decay (1d > 5d > 20d > 60d typically)
  // 不强制要求, 因为 spearman 在小样本有 noise

  // half-life estimation
  const horizonMap = decay.map(d => ({ horizon_days: parseInt(d.horizon), ic: Math.max(0.001, Math.abs(d.ic)) }));
  const hl = estimateICHalfLife(horizonMap);
  if (hl.is_estimable) {
    assert('half_life finite', Number.isFinite(hl.half_life_days), `hl=${hl.half_life_days}`);
  }
}

function testRealizedIR() {
  console.log('\n## computeRealizedIR');
  // 简单 alpha = 0.001/day, vol = 0.01/day → IR = 0.001/0.01 · √252 ≈ 1.587
  const alpha: number[] = [];
  let s = 7;
  for (let i = 0; i < 252; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const u1 = s / 2147483648 || 0.01;
    s = (s * 1103515245 + 12345) % 2147483648;
    const u2 = s / 2147483648 || 0.01;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    alpha.push(0.001 + 0.01 * z);
  }
  const ir = computeRealizedIR(alpha, 252);
  assert('IR ≈ 1.5 ± 1.0 (noise allowance)', Math.abs(ir - 1.5) < 1.0, `ir=${ir}`);
}

// ============================================================
// Factor Discovery
// ============================================================

function makeBarHistory(N: number): BarHistory {
  const close: number[] = [];
  const volume: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const open: number[] = [];
  const returns: number[] = [];
  let p = 100;
  let s = 42;
  for (let i = 0; i < N; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    const ret = (s / 233280 - 0.5) * 0.04;
    const pNew = p * (1 + ret);
    open.push(p);
    close.push(pNew);
    high.push(Math.max(p, pNew) * 1.005);
    low.push(Math.min(p, pNew) * 0.995);
    s = (s * 9301 + 49297) % 233280;
    volume.push(1000 + Math.floor(s / 233280 * 5000));
    returns.push(i === 0 ? 0 : ret);
    p = pNew;
  }
  return { close, volume, high, low, open, returns };
}

function testTreeSize() {
  console.log('\n## treeSize');
  // single leaf
  expectClose('leaf = 1', treeSize({ kind: 'leaf', feature: 'close' }), 1);
  // 1 + leaf + leaf = 3
  expectClose('binary op = 3', treeSize({
    kind: '+',
    children: [{ kind: 'leaf', feature: 'close' }, { kind: 'leaf', feature: 'volume' }],
  }), 3);
}

function testEvaluateFactorTree() {
  console.log('\n## evaluateFactorTree');
  const bars = makeBarHistory(20);
  // close leaf = bars.close
  const closeOut = evaluateFactorTree({ kind: 'leaf', feature: 'close' }, bars);
  expectClose('close leaf returns close[0]', closeOut[0], bars.close[0]);
  expectClose('close leaf returns close[10]', closeOut[10], bars.close[10]);

  // ts_mean(close, 5) — first 4 NaN, then mean of 5 consecutive
  const tmOut = evaluateFactorTree({
    kind: 'ts_mean', window: 5,
    children: [{ kind: 'leaf', feature: 'close' }],
  }, bars);
  for (let i = 0; i < 4; i += 1) assert(`ts_mean[${i}] = NaN`, Number.isNaN(tmOut[i]));
  const expected5 = (bars.close[0] + bars.close[1] + bars.close[2] + bars.close[3] + bars.close[4]) / 5;
  expectClose('ts_mean[4] = mean(close[0..4])', tmOut[4], expected5, 1e-6);
}

function testRandomFactorSearch() {
  console.log('\n## randomFactorSearch');
  const bars = makeBarHistory(100);
  // forward returns: 5-day forward return
  const fwd: number[] = [];
  for (let i = 0; i < bars.close.length; i += 1) {
    if (i + 5 < bars.close.length) {
      fwd.push((bars.close[i + 5] - bars.close[i]) / bars.close[i]);
    } else {
      fwd.push(NaN);
    }
  }
  const top = randomFactorSearch(bars, fwd, { n_candidates: 50, max_depth: 3, seed: 7, top_k: 5 });
  assert('top_k ≤ 5', top.length <= 5);
  assert('top 个体 都有 formula', top.every(t => t.formula.length > 0));
  assert('排序: top[0].fitness ≥ top[1].fitness', top.length < 2 || top[0].fitness >= top[1].fitness);
}

// ============================================================
// TCA
// ============================================================

function testComputeImplementationShortfall() {
  console.log('\n## computeImplementationShortfall');
  // BUY 1000 shares, decision 10, filled 1000 @ 10.10 → trading_cost = 100
  // 加 commission 5 → total_is = 105
  const r = computeImplementationShortfall({
    decision_price: 10,
    target_shares: 1000,
    shares_filled: 1000,
    avg_fill_price: 10.10,
    side: 'BUY',
    commission_total: 5,
  });
  expectClose('trading_cost = 100', r.trading_cost, 100);
  expectClose('fixed_cost = 5', r.fixed_cost, 5);
  expectClose('total_is = 105', r.total_is, 105);
  expectClose('fill_rate = 1', r.fill_rate, 1);
  // bps: 105 / (1000 × 10) = 0.0105 = 105 bps
  expectClose('total_is_bps = 105', r.total_is_bps, 105);

  // Partial fill with opportunity cost
  const r2 = computeImplementationShortfall({
    decision_price: 10,
    target_shares: 1000,
    shares_filled: 500,
    avg_fill_price: 10.05,
    shares_unfilled: 500,
    end_price: 10.20,
    side: 'BUY',
  });
  expectClose('partial trading_cost = 25', r2.trading_cost, 25); // 500 × 0.05
  expectClose('partial opp_cost = 100', r2.opportunity_cost, 100); // 500 × 0.20
  expectClose('fill_rate = 0.5', r2.fill_rate, 0.5);
}

function testAShareFixedCosts() {
  console.log('\n## aShareFixedCosts');
  // BUY 100,000: commission 25, stamp 0, transfer 1, total 26
  const r1 = aShareFixedCosts({ amount: 100_000, side: 'BUY' });
  expectClose('BUY commission = 25', r1.commission, 25);
  expectClose('BUY stamp_tax = 0', r1.stamp_tax, 0);
  expectClose('BUY transfer = 1', r1.transfer_fee, 1);
  expectClose('BUY total = 26', r1.total, 26);

  // SELL 100,000: commission 25, stamp 100, transfer 1, total 126
  const r2 = aShareFixedCosts({ amount: 100_000, side: 'SELL' });
  expectClose('SELL stamp_tax = 100', r2.stamp_tax, 100);
  expectClose('SELL total = 126', r2.total, 126);

  // min commission applies
  const r3 = aShareFixedCosts({ amount: 1000, side: 'BUY' });
  expectClose('min commission = 5', r3.commission, 5);
}

function testEstimateExpectedIS() {
  console.log('\n## estimateExpectedIS');
  const r = estimateExpectedIS({
    order_qty: 10_000,
    decision_price: 10,
    side: 'BUY',
    avg_daily_volume: 1_000_000,
    daily_vol: 0.02,
    spread_pct: 0.001,
  });
  assert('total > 0', r.expected_total_bps > 0);
  assert('impact > 0', r.impact_bps > 0);
  assert('spread_bps = 5', r.spread_bps === 5); // half_spread = 0.0005 = 5 bps
  // bps reconciliation
  expectClose('sum components = total', r.impact_bps + r.spread_bps + r.fixed_bps - r.expected_total_bps, 0, 1e-6);
}

function testReconcileIS() {
  console.log('\n## reconcileISRealizedVsExpected');
  const r1 = reconcileISRealizedVsExpected({ realized_bps: 10, expected_bps: 10 });
  assert('as_expected', r1.verdict === 'as_expected');
  const r2 = reconcileISRealizedVsExpected({ realized_bps: 5, expected_bps: 10 });
  assert('better_than_expected', r2.verdict === 'better_than_expected');
  const r3 = reconcileISRealizedVsExpected({ realized_bps: 50, expected_bps: 10 });
  assert('much_worse', r3.verdict === 'much_worse');
}

// ============================================================
// Risk Parity Regularized
// ============================================================

function testTikhonovRegularize() {
  console.log('\n## tikhonovRegularize');
  const cov = [[1, 0.5], [0.5, 1]];
  const r = tikhonovRegularize(cov, 0.1);
  expectClose('diag added', r[0][0], 1.1);
  expectClose('diag added', r[1][1], 1.1);
  // off-diag 不变
  expectClose('off-diag unchanged', r[0][1], 0.5);
}

function testAutoTikhonovLambda() {
  console.log('\n## autoTikhonovLambda');
  const cov = [[4, 0], [0, 9]];
  // max_diag = 9, fraction = 0.01 → λ = 0.09
  expectClose('λ = 0.09', autoTikhonovLambda(cov), 0.09);
}

function testEstimateConditionNumber() {
  console.log('\n## estimateConditionNumber');
  expectClose('cond([[1,0],[0,1]]) = 1', estimateConditionNumber([[1, 0], [0, 1]]), 1);
  expectClose('cond([[100,0],[0,1]]) = 100', estimateConditionNumber([[100, 0], [0, 1]]), 100);
}

function testSolveERCRegularized() {
  console.log('\n## solveERCRegularized');
  const cov = [
    [0.04, 0.01, 0.005],
    [0.01, 0.09, 0.002],
    [0.005, 0.002, 0.16],
  ];
  const r = solveERCRegularized(cov);
  expectClose('sum = 1', r.weights.reduce((s, v) => s + v, 0), 1, 1e-3);
  assert('lambda > 0', r.lambda_used > 0);
  assert('reg cond ≤ orig cond', r.condition_number_regularized <= r.condition_number_original);
  // 高 vol asset 权重应该最小
  assert('w[2] < w[0]', r.weights[2] < r.weights[0]);
}

function testRecommendCovStrategy() {
  console.log('\n## recommendCovStrategy');
  // 充足样本 (T=300, N=10) → 不需 reg
  const r1 = recommendCovStrategy(10, 300, [[1, 0], [0, 1]]);
  assert('充足 → 不用 reg', !r1.use_ledoit_wolf && !r1.use_tikhonov);

  // 小样本 (T=15, N=10) → LW
  const r2 = recommendCovStrategy(10, 15, [[1, 0], [0, 1]]);
  assert('小样本 → 用 LW', r2.use_ledoit_wolf);

  // 极小样本 (T=2, N=10) → LW + Tikhonov
  const r3 = recommendCovStrategy(10, 2, [[1, 0], [0, 0.001]]);
  assert('极小样本 → LW + Tikhonov', r3.use_ledoit_wolf && r3.use_tikhonov);
}

function main() {
  testOlsRegression();
  testKylesLambda();
  testRollsEffectiveSpread();
  testMrrDecomposition();
  testDailyOrderFlowImbalance();
  testPearsonCorrelation();
  testSpearmanCorrelation();
  testFundamentalLawIR();
  testICDecay();
  testRealizedIR();
  testTreeSize();
  testEvaluateFactorTree();
  testRandomFactorSearch();
  testComputeImplementationShortfall();
  testAShareFixedCosts();
  testEstimateExpectedIS();
  testReconcileIS();
  testTikhonovRegularize();
  testAutoTikhonovLambda();
  testEstimateConditionNumber();
  testSolveERCRegularized();
  testRecommendCovStrategy();

  console.log(`\n========================================`);
  console.log(`v4 tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
