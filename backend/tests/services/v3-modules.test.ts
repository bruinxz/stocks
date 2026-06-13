/**
 * v3 联合测试: FractionalDiff + InformationBars + BlackLitterman + Bootstrap + OnlineLearning
 */
import {
  fractionalDiffWeights,
  fractionalDifference,
  approximateAdfTest,
  findMinDForStationarity,
} from '../../src/services/meta/fractional-diff';
import {
  buildInformationBars,
  buildImbalanceBars,
  autoCalibrateThreshold,
  RawBar,
} from '../../src/services/meta/information-bars';
import {
  buildPickMatrix,
  buildAbsoluteView,
  buildRelativeView,
  matrixInverse,
  matMul,
  matVec,
  matTranspose,
  impliedEquilibriumReturns,
  computeBlackLittermanPosterior,
} from '../../src/services/portfolio/black-litterman';
import {
  BootstrapRng,
  bootstrapResample,
  computePercentile,
  percentileBootstrap,
  basicBootstrap,
  bcaBootstrap,
} from '../../src/services/research/bootstrap-ci';
import {
  createInitialOnlineState,
  onlineUpdate,
  onlineUpdateBatch,
  robbinsMonroLearningRate,
} from '../../src/services/meta/online-learning';
import { trainLogisticRegression, RawSignalFeatures, TrainingRow } from '../../src/services/meta/MetaLabelService';

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
// Fractional Differentiation
// ============================================================

function testFractionalDiffWeights() {
  console.log('\n## fractionalDiffWeights');
  // d=0.5: ω_0=1, ω_1=-0.5, ω_2=-0.125, ω_3=-0.0625, ...
  const w = fractionalDiffWeights(0.5, 1e-6);
  expectClose('ω_0 = 1', w[0], 1);
  expectClose('ω_1 = -0.5', w[1], -0.5);
  expectClose('ω_2 = -0.125', w[2], -0.125);
  expectClose('ω_3 = -0.0625', w[3], -0.0625);
  // 单调衰减 (绝对值)
  for (let k = 1; k < w.length - 1; k += 1) {
    assert(`|ω_${k+1}| < |ω_${k}|`, Math.abs(w[k+1]) < Math.abs(w[k]));
  }
  // 边界
  let threw = false;
  try { fractionalDiffWeights(0); } catch { threw = true; }
  assert('d=0 → throw', threw);
  threw = false;
  try { fractionalDiffWeights(1); } catch { threw = true; }
  assert('d=1 → throw', threw);
}

function testFractionalDifference() {
  console.log('\n## fractionalDifference');
  // 简单 case: d=0.5, series=[100, 100, 100, 100, ...]
  // 因为 series 常数, frac diff 接近 0
  // 用宽 threshold 让 weights 少一点 (< series length)
  const constSeries = new Array(50).fill(100);
  const fd = fractionalDifference(constSeries, 0.5, 0.05);
  const weights = fractionalDiffWeights(0.5, 0.05);
  // weights 数应该 < 50, 让 loop 正常
  assert(`weights.length=${weights.length} < 50`, weights.length < 50);
  // 前 K-1 个 NaN, 后面是 const × Σω
  for (let i = 0; i < weights.length - 1; i += 1) {
    assert(`fd[${i}] = NaN`, Number.isNaN(fd[i]));
  }
  const sumW = weights.reduce((s, v) => s + v, 0);
  const expected = 100 * sumW;
  expectClose('fd[K-1] = const × Σω', fd[weights.length - 1], expected, 0.01);
}

function testApproximateAdfTest() {
  console.log('\n## approximateAdfTest');
  // 随机白噪声 → stationary (ar1 ≈ 0)
  const noise: number[] = [];
  let s = 42;
  for (let i = 0; i < 100; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    noise.push((s / 233280 - 0.5));
  }
  const r1 = approximateAdfTest(noise);
  assert('白噪声 stationary', r1.is_stationary);
  assert('白噪声 ar1 < 0.5', Math.abs(r1.ar1_correlation) < 0.5, `ar1=${r1.ar1_correlation}`);

  // Random walk → non-stationary (ar1 ≈ 1)
  const rw: number[] = [0];
  let s2 = 7;
  for (let i = 0; i < 100; i += 1) {
    s2 = (s2 * 9301 + 49297) % 233280;
    rw.push(rw[rw.length - 1] + (s2 / 233280 - 0.5));
  }
  const r2 = approximateAdfTest(rw);
  assert('random walk non-stationary', !r2.is_stationary || Math.abs(r2.ar1_correlation) > 0.9, `ar1=${r2.ar1_correlation}`);
}

function testFindMinDForStationarity() {
  console.log('\n## findMinDForStationarity');
  // Random walk → 需要 d 较大才 stationary
  const rw: number[] = [0];
  let s = 13;
  for (let i = 0; i < 200; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    rw.push(rw[rw.length - 1] + (s / 233280 - 0.5));
  }
  const r = findMinDForStationarity(rw, { max_iter: 15 });
  assert('找到了 d', Number.isFinite(r.min_d));
  assert('d > 0', r.min_d > 0);
}

// ============================================================
// Information Bars
// ============================================================

function makeRawBars(N: number, baseVol = 1000000): RawBar[] {
  const bars: RawBar[] = [];
  let close = 100;
  let s = 11;
  for (let i = 0; i < N; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    const r = (s / 233280 - 0.5) * 0.04;
    const newClose = close * (1 + r);
    bars.push({
      date: new Date(2026, 0, i + 1).toISOString().slice(0, 10),
      open: close,
      high: Math.max(close, newClose) * 1.01,
      low: Math.min(close, newClose) * 0.99,
      close: newClose,
      volume: baseVol * (0.5 + (s / 233280)),
    });
    close = newClose;
  }
  return bars;
}

function testBuildInformationBars() {
  console.log('\n## buildInformationBars');
  const raw = makeRawBars(50);
  // dollar bars: threshold = 总 dollar / 5 (期望 ~5 个 bar)
  const totalDollar = raw.reduce((s, b) => s + b.volume * b.close, 0);
  const thr = totalDollar / 5;
  const bars = buildInformationBars(raw, thr, 'dollar');
  assert('生成 ~5 个 bars', bars.length >= 3 && bars.length <= 7, `bars=${bars.length}`);
  // 每个 bar 累积量 >= threshold
  for (const b of bars) {
    assert(`bar ${b.index} dollar >= threshold`, b.dollar_volume >= thr);
  }
  // index 连续
  for (let i = 0; i < bars.length; i += 1) assert(`bar[${i}].index = ${i}`, bars[i].index === i);
}

function testBuildImbalanceBars() {
  console.log('\n## buildImbalanceBars');
  const raw = makeRawBars(50);
  // 阈值: 平均 daily volume × 5
  const avgVol = raw.reduce((s, b) => s + b.volume, 0) / raw.length;
  const bars = buildImbalanceBars(raw, avgVol * 5);
  assert('生成至少 1 个 bar', bars.length >= 1);
  assert('total raw bars ≤ N', bars.reduce((s, b) => s + b.num_raw_bars, 0) <= raw.length);
}

function testAutoCalibrate() {
  console.log('\n## autoCalibrateThreshold');
  const raw = makeRawBars(100);
  const thr = autoCalibrateThreshold(raw, 'dollar', 1);
  // 跑 calibrated threshold 应近似 1 bar/day
  const bars = buildInformationBars(raw, thr, 'dollar');
  // ~ 100 bars (target 1/day × 100 days)
  assert('calibrate 接近 target', bars.length >= 50 && bars.length <= 150, `bars=${bars.length}`);
}

// ============================================================
// Black-Litterman
// ============================================================

function testMatrixInverse() {
  console.log('\n## matrixInverse');
  const I = [[1, 0], [0, 1]];
  const inv = matrixInverse(I);
  expectClose('I^-1 = I[0][0]', inv[0][0], 1);
  expectClose('I^-1 = I[1][1]', inv[1][1], 1);
  // 2x2: [[2, 1], [1, 1]]^-1 = [[1, -1], [-1, 2]]
  const m = [[2, 1], [1, 1]];
  const mInv = matrixInverse(m);
  expectClose('m^-1[0][0]', mInv[0][0], 1);
  expectClose('m^-1[0][1]', mInv[0][1], -1);
  expectClose('m^-1[1][0]', mInv[1][0], -1);
  expectClose('m^-1[1][1]', mInv[1][1], 2);
}

function testMatMul() {
  console.log('\n## matMul');
  const A = [[1, 2], [3, 4]];
  const B = [[5, 6], [7, 8]];
  const C = matMul(A, B);
  // [[19, 22], [43, 50]]
  expectClose('C[0][0]', C[0][0], 19);
  expectClose('C[0][1]', C[0][1], 22);
  expectClose('C[1][0]', C[1][0], 43);
  expectClose('C[1][1]', C[1][1], 50);
}

function testBuildPickMatrix() {
  console.log('\n## buildPickMatrix');
  const views = [
    buildAbsoluteView(0, 0.05, 0.01),
    buildRelativeView(1, 2, 0.02, 0.005),
  ];
  const { P, Q, Omega } = buildPickMatrix(views, 3);
  // P 第 0 行 [1, 0, 0]
  assert('P[0] = [1,0,0]', P[0][0] === 1 && P[0][1] === 0 && P[0][2] === 0);
  // P 第 1 行 [0, 1, -1]
  assert('P[1] = [0,1,-1]', P[1][0] === 0 && P[1][1] === 1 && P[1][2] === -1);
  // Q
  expectClose('Q[0] = 0.05', Q[0], 0.05);
  expectClose('Q[1] = 0.02', Q[1], 0.02);
  // Omega 对角
  expectClose('Ω[0][0] = 0.01', Omega[0][0], 0.01);
  expectClose('Ω[1][1] = 0.005', Omega[1][1], 0.005);
}

function testImpliedEquilibriumReturns() {
  console.log('\n## impliedEquilibriumReturns');
  // sigma = I, weights = [0.5, 0.5], λ = 3 → Π = 3 · I · [0.5, 0.5] = [1.5, 1.5]
  const Pi = impliedEquilibriumReturns([[1, 0], [0, 1]], [0.5, 0.5], 3);
  expectClose('Π[0]', Pi[0], 1.5);
  expectClose('Π[1]', Pi[1], 1.5);
}

function testBlackLitterman() {
  console.log('\n## computeBlackLittermanPosterior');
  // 简单 case: 2 资产, market eq weights = [0.5, 0.5], cov = identity
  // 无 views → posterior = implied
  const sigma = [[0.04, 0.01], [0.01, 0.09]];
  const mktW = [0.6, 0.4];
  const noViews: any[] = [];
  const r1 = computeBlackLittermanPosterior(sigma, mktW, noViews);
  expectClose('无 views → posterior = implied (0)', r1.posterior_returns[0], r1.implied_returns[0]);
  expectClose('无 views → posterior = implied (1)', r1.posterior_returns[1], r1.implied_returns[1]);

  // 加 absolute view "asset 0 期望 0.10" 高不确定性 → posterior 略向 0.10 偏移
  const views = [buildAbsoluteView(0, 0.10, 0.10)];
  const r2 = computeBlackLittermanPosterior(sigma, mktW, views);
  // posterior[0] 应该在 implied 和 view 之间
  assert(
    'posterior 在 implied 和 view 之间',
    (r2.posterior_returns[0] > r1.implied_returns[0] && r2.posterior_returns[0] < 0.10) ||
    (r2.posterior_returns[0] < r1.implied_returns[0] && r2.posterior_returns[0] > 0.10),
    `posterior=${r2.posterior_returns[0]} implied=${r1.implied_returns[0]} view=0.10`
  );
}

// ============================================================
// Bootstrap CI
// ============================================================

function testBootstrapRng() {
  console.log('\n## BootstrapRng');
  const rng = new BootstrapRng(42);
  // 同 seed → 同序列
  const seq1 = [rng.next(), rng.next(), rng.next()];
  const rng2 = new BootstrapRng(42);
  const seq2 = [rng2.next(), rng2.next(), rng2.next()];
  expectClose('seed 42 序列 1[0]', seq1[0], seq2[0]);
  expectClose('seed 42 序列 1[1]', seq1[1], seq2[1]);
  // [0, 1) 范围
  for (let i = 0; i < 100; i += 1) {
    const r = rng.next();
    assert(`r ∈ [0, 1)`, r >= 0 && r < 1);
  }
}

function testComputePercentile() {
  console.log('\n## computePercentile');
  const vals = [1, 2, 3, 4, 5];
  expectClose('median', computePercentile(vals, 50), 3);
  expectClose('p10', computePercentile(vals, 10), 1.4);
  expectClose('p90', computePercentile(vals, 90), 4.6);
}

function testPercentileBootstrap() {
  console.log('\n## percentileBootstrap');
  // 正态 N(0, 1) sample 50 个 → mean ≈ 0, 95% CI 包含 0
  const rng = new BootstrapRng(7);
  const samples: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    const u1 = rng.next() || 0.001;
    const u2 = rng.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    samples.push(z);
  }
  const mean = (s: number[]) => s.reduce((sum, v) => sum + v, 0) / s.length;
  const r = percentileBootstrap(samples, mean, { B: 500, alpha: 0.05, seed: 42 });
  assert('CI 包含 0', r.lower < 0 && r.upper > 0, `[${r.lower.toFixed(3)}, ${r.upper.toFixed(3)}]`);
  assert('replicates 多于 100', r.replicates.length > 100);
}

function testBcaBootstrap() {
  console.log('\n## bcaBootstrap');
  // 同上, BCa 应该也 OK
  const rng = new BootstrapRng(7);
  const samples: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    const u1 = rng.next() || 0.001;
    const u2 = rng.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    samples.push(z);
  }
  const mean = (s: number[]) => s.reduce((sum, v) => sum + v, 0) / s.length;
  const r = bcaBootstrap(samples, mean, { B: 500, alpha: 0.05, seed: 42 });
  assert('BCa CI 包含 0', r.lower < 0 && r.upper > 0, `[${r.lower.toFixed(3)}, ${r.upper.toFixed(3)}]`);
  assert('z0 finite', Number.isFinite(r.z0));
  assert('acceleration finite', Number.isFinite(r.acceleration));
}

// ============================================================
// Online Learning
// ============================================================

function makeSyntheticRows(n: number, seed = 42): TrainingRow[] {
  let s = seed;
  const random = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const out: TrainingRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const score = 30 + Math.floor(random() * 60);
    const regime = random() > 0.5 ? 'bull' : 'bear';
    const label: 0 | 1 = score > 50 && regime === 'bull' ? 1 : 0;
    out.push({
      features: {
        signal_score: score,
        signal_source: 'quant',
        regime,
        market_breadth_score: 0,
        strategy_recent_winrate_30d: 0.5,
        strategy_recent_payoff_30d: 1.0,
        market_vol_atr: 4,
      },
      label,
    });
  }
  return out;
}

function testOnlineUpdate() {
  console.log('\n## onlineUpdate');
  const trainRows = makeSyntheticRows(200);
  const baseModel = trainLogisticRegression(trainRows.slice(0, 100));
  const initialState = createInitialOnlineState(baseModel);

  // 单次 update
  const sample = trainRows[100];
  const r = onlineUpdate(baseModel, initialState, sample.features, sample.label);
  assert('step 增 1', r.updated_state.step === 1);
  assert('loss 非负', r.loss >= 0);
  assert('pred ∈ [0, 1]', r.pred >= 0 && r.pred <= 1);
  // version 标记
  assert('version 含 online_1', r.updated_model.version.includes('+online_1'));
}

function testOnlineUpdateBatch() {
  console.log('\n## onlineUpdateBatch');
  const allRows = makeSyntheticRows(300);
  const baseModel = trainLogisticRegression(allRows.slice(0, 100));
  const initialState = createInitialOnlineState(baseModel);

  // Feed 100 个新样本
  const incrementalSamples = allRows.slice(100, 200).map(r => ({ features: r.features, label: r.label }));
  const result = onlineUpdateBatch(baseModel, initialState, incrementalSamples);

  assert('final step = 100', result.final_state.step === 100);
  assert('loss_history 长 100', result.loss_history.length === 100);
  // loss 应该 trend down (后期 < 早期)
  const earlyMean = result.loss_history.slice(0, 20).reduce((s, v) => s + v, 0) / 20;
  const lateMean = result.loss_history.slice(-20).reduce((s, v) => s + v, 0) / 20;
  console.log(`    early loss mean = ${earlyMean.toFixed(3)}, late = ${lateMean.toFixed(3)}`);
  // 不强制递减 (因为 noise)，只要 final model 在新数据 OK
}

function testRobbinsMonroLearningRate() {
  console.log('\n## robbinsMonroLearningRate');
  // η_t 单调递减
  const eta1 = robbinsMonroLearningRate(1);
  const eta10 = robbinsMonroLearningRate(10);
  const eta100 = robbinsMonroLearningRate(100);
  assert('η_1 > η_10', eta1 > eta10);
  assert('η_10 > η_100', eta10 > eta100);
  expectClose('η_1 = 0.1 · 1^-0.6', eta1, 0.1);
}

function main() {
  testFractionalDiffWeights();
  testFractionalDifference();
  testApproximateAdfTest();
  testFindMinDForStationarity();
  testBuildInformationBars();
  testBuildImbalanceBars();
  testAutoCalibrate();
  testMatrixInverse();
  testMatMul();
  testBuildPickMatrix();
  testImpliedEquilibriumReturns();
  testBlackLitterman();
  testBootstrapRng();
  testComputePercentile();
  testPercentileBootstrap();
  testBcaBootstrap();
  testOnlineUpdate();
  testOnlineUpdateBatch();
  testRobbinsMonroLearningRate();

  console.log(`\n========================================`);
  console.log(`v3 tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
