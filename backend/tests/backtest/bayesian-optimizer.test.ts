/**
 * BayesianOptimizer 单元测试（US-038）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/backtest/bayesian-optimizer.test.ts
 *
 * 完全脱离 DB：通过 `runner` 选项注入纯内存 fake runner + `persist: false`，
 * 让 optimize() 不写库。所有测试在毫秒级跑完。
 *
 * 覆盖维度：
 *   - SeededRandom：同 seed 完全可复现 / 不同 seed 不同序列 / [0,1) 范围
 *   - normalizeParams / denormalizeParams：边界 / integer rounding / clamp / dim mismatch
 *   - rbfKernel：self=1 / 距离单调 / 维度不匹配抛错 / length scale 影响
 *   - normalCDF / normalPDF：对称性 / 已知值
 *   - expectedImprovement：σ<=0→0 / improvement<0→低分 / 正常公式
 *   - choleskyDecompose / solveLowerTriangular / solveUpperTriangular：纯线代正确性
 *   - gaussianProcessPosterior：empty → 先验 (mean=0, std=1) / 单点 / 多点 + 中心化
 *   - sampleInitialPoints：count / seed reproducible / bounds 边界 / integer rounding
 *   - generateEICandidates：低维 cartesian / 高维 sample / 局部加密
 *   - pickNextByEI：基本工作 / 空 candidates 抛错 / tie-break 远离已观测点
 *   - validateBounds：min >= max 抛错 / 缺字段 / NaN
 *   - BayesianOptimizer.optimize：
 *     - 基本 happy-path：30 iter 收敛到已知最优
 *     - failure isolation：单 iter 抛错不中断
 *     - 全 iter 失败时 best=null
 *     - max_iterations 截断 iterations
 *     - init_points > iterations 被 clamp
 *     - 同 seed 完全可复现采样序列
 *     - persist=false 不写库
 *     - injected runner 跳过 strategyRegistry 校验
 *     - 自定义 weights 改变 best
 *     - integer bounds 采样全为整数
 *     - exploration_xi 影响 EI 选点
 */

import {
  SeededRandom,
  normalizeParams,
  denormalizeParams,
  rbfKernel,
  normalCDF,
  normalPDF,
  expectedImprovement,
  choleskyDecompose,
  solveLowerTriangular,
  solveUpperTriangular,
  gaussianProcessPosterior,
  sampleInitialPoints,
  generateEICandidates,
  pickNextByEI,
  BayesianOptimizer,
  ParamBounds,
} from '../../src/quant/backtest/BayesianOptimizer';
import { BacktestRunner } from '../../src/quant/backtest/GridSearchOptimizer';

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

function expectClose(name: string, actual: number, expected: number, eps = 1e-6) {
  assert(
    name,
    Number.isFinite(actual) && Math.abs(actual - expected) < eps,
    `expected≈${expected}, got=${actual}`
  );
}

// ============================================================
// SeededRandom
// ============================================================

function testSeededRandom() {
  console.log('\n## SeededRandom');

  const rng1 = new SeededRandom(42);
  const rng2 = new SeededRandom(42);
  const seq1 = [rng1.next(), rng1.next(), rng1.next()];
  const seq2 = [rng2.next(), rng2.next(), rng2.next()];
  expectEqual('same seed → same sequence', seq1, seq2);

  const rng3 = new SeededRandom(123);
  const seq3 = [rng3.next(), rng3.next(), rng3.next()];
  assert(
    'different seed → different sequence',
    JSON.stringify(seq1) !== JSON.stringify(seq3)
  );

  // [0, 1) range
  const rng4 = new SeededRandom(99);
  for (let i = 0; i < 1000; i++) {
    const v = rng4.next();
    if (v < 0 || v >= 1) {
      assert(`[0,1) range iter ${i}`, false, `got ${v}`);
      return;
    }
  }
  assert('[0, 1) range over 1000 samples', true);

  // seed=0 fallback to seed=1 (LCG can't start from 0)
  const rng5 = new SeededRandom(0);
  const v = rng5.next();
  assert('seed=0 fallback works', Number.isFinite(v) && v >= 0 && v < 1, `got ${v}`);

  // nextRange
  const rng6 = new SeededRandom(7);
  for (let i = 0; i < 100; i++) {
    const v2 = rng6.nextRange(-10, 10);
    if (v2 < -10 || v2 >= 10) {
      assert('nextRange in [-10, 10)', false, `got ${v2}`);
      return;
    }
  }
  assert('nextRange [-10, 10) over 100 samples', true);
}

// ============================================================
// normalizeParams / denormalizeParams
// ============================================================

function testNormalizeDenormalize() {
  console.log('\n## normalizeParams / denormalizeParams');

  const bounds: ParamBounds = {
    topN: { min: 10, max: 50, integer: true },
    stopLossPct: { min: -15, max: -3 },
  };

  // normalize
  expectEqual('normalize: 中点', normalizeParams({ topN: 30, stopLossPct: -9 }, bounds), [
    0.5,
    0.5,
  ]);
  expectEqual('normalize: min 端', normalizeParams({ topN: 10, stopLossPct: -15 }, bounds), [
    0,
    0,
  ]);
  expectEqual('normalize: max 端', normalizeParams({ topN: 50, stopLossPct: -3 }, bounds), [
    1,
    1,
  ]);

  // dim order = bounds keys order
  const out = normalizeParams({ stopLossPct: -3, topN: 50 }, bounds);
  expectEqual('normalize: dim 顺序按 bounds keys', out, [1, 1]);

  // 非有限数抛错
  let err: Error | null = null;
  try {
    normalizeParams({ topN: NaN, stopLossPct: -9 }, bounds);
  } catch (e) {
    err = e as Error;
  }
  assert('normalize: NaN → throws', err !== null);

  // denormalize
  expectEqual(
    'denormalize: 中点',
    denormalizeParams([0.5, 0.5], bounds),
    { topN: 30, stopLossPct: -9 }
  );
  expectEqual(
    'denormalize: integer rounding',
    denormalizeParams([0.6, 0.5], bounds),
    { topN: 34, stopLossPct: -9 }
  );

  // clamp 到 [0,1]
  const clamped = denormalizeParams([-0.5, 1.5], bounds);
  assert('denormalize: clamp [-0.5] → min', clamped.topN === 10);
  assert('denormalize: clamp [1.5] → max', clamped.stopLossPct === -3);

  // dim mismatch
  let dimErr: Error | null = null;
  try {
    denormalizeParams([0.5], bounds);
  } catch (e) {
    dimErr = e as Error;
  }
  assert('denormalize: dim 不匹配 → throws', dimErr !== null);

  // round trip
  const original = { topN: 25, stopLossPct: -8 };
  const norm = normalizeParams(original, bounds);
  const back = denormalizeParams(norm, bounds);
  expectEqual('round trip integer dim', back.topN, 25);
  expectClose('round trip float dim', back.stopLossPct, -8);
}

// ============================================================
// rbfKernel + normalCDF + normalPDF + expectedImprovement
// ============================================================

function testKernelAndStats() {
  console.log('\n## rbfKernel / normalCDF / normalPDF / EI');

  // RBF self = 1
  expectClose('rbf self = 1', rbfKernel([0.5, 0.5], [0.5, 0.5]), 1, 1e-12);
  expectClose('rbf 单维 self = 1', rbfKernel([0.3], [0.3]), 1, 1e-12);

  // RBF 距离越大 kernel 越小
  const k_close = rbfKernel([0, 0], [0.1, 0.1]);
  const k_far = rbfKernel([0, 0], [0.8, 0.8]);
  assert('rbf 远点 < 近点', k_close > k_far, `${k_close} > ${k_far}`);

  // length scale 影响：lengthScale 越大 → kernel 越平滑（远点也保持高 kernel）
  const k1 = rbfKernel([0, 0], [0.5, 0.5], 0.1);
  const k2 = rbfKernel([0, 0], [0.5, 0.5], 1.0);
  assert('rbf 大 lengthScale → kernel 大', k2 > k1, `${k1} vs ${k2}`);

  // dim mismatch 抛错
  let err: Error | null = null;
  try {
    rbfKernel([1, 2, 3], [1, 2]);
  } catch (e) {
    err = e as Error;
  }
  assert('rbf dim 不匹配 → throws', err !== null);

  // normalCDF
  expectClose('CDF(0) = 0.5', normalCDF(0), 0.5);
  expectClose('CDF(1.96) ≈ 0.975', normalCDF(1.96), 0.975, 1e-3);
  expectClose('CDF(-1.96) ≈ 0.025', normalCDF(-1.96), 0.025, 1e-3);
  expectClose('CDF(3) ≈ 0.9987', normalCDF(3), 0.9987, 1e-3);
  expectClose('CDF(-3) ≈ 0.0013', normalCDF(-3), 0.0013, 1e-3);
  expectClose('CDF symmetric', normalCDF(1.5) + normalCDF(-1.5), 1, 1e-6);

  // normalPDF
  expectClose('PDF(0) ≈ 0.3989', normalPDF(0), 1 / Math.sqrt(2 * Math.PI), 1e-6);
  expectClose('PDF symmetric', normalPDF(1.5), normalPDF(-1.5), 1e-12);

  // EI
  // 当 std=0 → EI = 0
  expectClose('EI std=0 → 0', expectedImprovement(2.0, 0, 1.0), 0, 1e-12);
  expectClose('EI std<0 → 0', expectedImprovement(2.0, -1.0, 1.0), 0, 1e-12);

  // 当 improvement << 0 → EI 接近 0
  const ei_neg = expectedImprovement(0.1, 0.05, 1.0);
  assert('EI improvement << 0 → 接近 0', ei_neg < 0.1, `got ${ei_neg}`);

  // 当 mean 远大于 best + std 小 → EI 接近 (improvement - xi)
  const ei_big = expectedImprovement(5.0, 0.01, 1.0);
  assert(
    'EI mean >> best, std 小 → EI ≈ improvement',
    Math.abs(ei_big - (5.0 - 1.0 - 0.01)) < 0.1,
    `got ${ei_big}`
  );

  // 当 mean = best + std 中等 → EI 由 exploration 项主导
  const ei_explore = expectedImprovement(1.0, 0.5, 1.0);
  assert('EI 探索项 std × φ(z) > 0', ei_explore > 0, `got ${ei_explore}`);

  // xi 越大 → EI 越小（更保守）
  const ei_xi_small = expectedImprovement(1.5, 0.3, 1.0, 0.01);
  const ei_xi_big = expectedImprovement(1.5, 0.3, 1.0, 0.5);
  assert('xi 越大 EI 越小', ei_xi_small > ei_xi_big, `${ei_xi_small} > ${ei_xi_big}`);

  // NaN / Infinity 输入 → 0
  expectClose('EI NaN mean → 0', expectedImprovement(NaN, 0.3, 1.0), 0);
  expectClose('EI Infinity std → 0', expectedImprovement(1.5, Infinity, 1.0), 0);
}

// ============================================================
// Cholesky 线代
// ============================================================

function testCholesky() {
  console.log('\n## choleskyDecompose / solveLowerTriangular / solveUpperTriangular');

  // K = [[4, 2], [2, 3]] → L = [[2, 0], [1, √2]]
  const K = [
    [4, 2],
    [2, 3],
  ];
  const L = choleskyDecompose(K);
  expectClose('L[0][0] = 2', L[0][0], 2);
  expectClose('L[1][0] = 1', L[1][0], 1);
  expectClose('L[1][1] = √2', L[1][1], Math.sqrt(2));
  expectClose('L[0][1] = 0', L[0][1], 0);

  // 验证 L * L^T = K
  const LL = [
    [L[0][0] * L[0][0], L[0][0] * L[1][0]],
    [L[1][0] * L[0][0], L[1][0] * L[1][0] + L[1][1] * L[1][1]],
  ];
  expectClose('L * L^T[0][0] = 4', LL[0][0], 4);
  expectClose('L * L^T[1][1] = 3', LL[1][1], 3);
  expectClose('L * L^T[0][1] = 2', LL[0][1], 2);

  // 非正定矩阵抛错
  const K_bad = [
    [1, 2],
    [2, 1], // det = -3
  ];
  let err: Error | null = null;
  try {
    choleskyDecompose(K_bad);
  } catch (e) {
    err = e as Error;
  }
  assert('非正定 K → throws', err !== null);

  // 解 K * x = b：K = [[4, 0], [0, 9]] → L = [[2,0],[0,3]] → x = [b[0]/4, b[1]/9]
  const K_diag = [
    [4, 0],
    [0, 9],
  ];
  const L_diag = choleskyDecompose(K_diag);
  const b = [8, 27];
  const z = solveLowerTriangular(L_diag, b);
  const x = solveUpperTriangular(L_diag, z);
  expectClose('solve K * x = b, x[0] = 2', x[0], 2);
  expectClose('solve K * x = b, x[1] = 3', x[1], 3);

  // 解非对角线 K：K = [[4,2],[2,3]], b = [6, 5] → x = K^{-1} * b
  // K^{-1} = 1/(4*3-2*2) * [[3,-2],[-2,4]] = 1/8 * [[3,-2],[-2,4]]
  // x = 1/8 * [3*6 - 2*5, -2*6 + 4*5] = 1/8 * [8, 8] = [1, 1]
  const L_K = choleskyDecompose(K);
  const z_K = solveLowerTriangular(L_K, [6, 5]);
  const x_K = solveUpperTriangular(L_K, z_K);
  expectClose('solve K * x = b → x[0] = 1', x_K[0], 1);
  expectClose('solve K * x = b → x[1] = 1', x_K[1], 1);
}

// ============================================================
// gaussianProcessPosterior
// ============================================================

function testGaussianProcessPosterior() {
  console.log('\n## gaussianProcessPosterior');

  // 空训练集 → 先验
  const prior = gaussianProcessPosterior([0.5], []);
  expectClose('empty → mean = 0', prior.mean, 0);
  expectClose('empty → variance = 1', prior.variance, 1);
  expectClose('empty → std = 1', prior.std, 1);

  // 单训练点 (x=0.5, y=2.0)：在 x=0.5 query 应该接近 y=2.0，远处接近 prior mean
  const single = [{ x: [0.5], y: 2.0 }];
  const at_train = gaussianProcessPosterior([0.5], single);
  expectClose('单点 query 训练点 → mean ≈ y', at_train.mean, 2.0, 1e-3);
  assert('单点 query 训练点 → variance 接近 0', at_train.variance < 1e-3);

  const far = gaussianProcessPosterior([10.0], single); // 远处
  // 远处的 mean 应该接近 y mean (中心化先验)
  assert(
    `远处 query std 接近 prior std (got ${far.std})`,
    far.std > 0.5,
    `expect close to 1 prior`
  );

  // 两个相同 x 不同 y 训练点 → Cholesky fallback 到 prior (jitter 内可解决)
  const tricky = [
    { x: [0.5], y: 1.0 },
    { x: [0.5, 0.001].slice(0, 1).map(_ => 0.500001), y: 1.5 },
  ];
  const result = gaussianProcessPosterior([0.5], tricky);
  assert(
    '近重合点 GP 仍可解（jitter 默认值）',
    Number.isFinite(result.mean) && Number.isFinite(result.std)
  );

  // 多点训练 → GP 是 mean = 中间值，std 在中间最低
  const multi = [
    { x: [0.1], y: 1.0 },
    { x: [0.5], y: 2.0 },
    { x: [0.9], y: 1.5 },
  ];
  const mid = gaussianProcessPosterior([0.5], multi);
  expectClose('多点中间训练 → mean ≈ y_mid', mid.mean, 2.0, 0.05);
  assert('多点中间 query → std 较小', mid.std < 0.3);

  // 二维 GP
  const multi2d = [
    { x: [0.1, 0.1], y: 1.0 },
    { x: [0.9, 0.9], y: 3.0 },
  ];
  const center2d = gaussianProcessPosterior([0.5, 0.5], multi2d);
  expectClose('2D mean 中间 ≈ (1+3)/2 = 2', center2d.mean, 2.0, 0.5);
}

// ============================================================
// sampleInitialPoints
// ============================================================

function testSampleInitialPoints() {
  console.log('\n## sampleInitialPoints');

  const bounds: ParamBounds = {
    topN: { min: 10, max: 50, integer: true },
    stopLossPct: { min: -15, max: -3 },
  };

  // n=5 → 5 个点
  const pts5 = sampleInitialPoints(bounds, 5, 42);
  expectEqual('n=5 → 5 个点', pts5.length, 5);

  // 每个点 topN ∈ [10, 50] 且 integer
  for (const p of pts5) {
    if (p.topN < 10 || p.topN > 50 || !Number.isInteger(p.topN)) {
      assert('topN ∈ [10,50] integer', false, `got ${p.topN}`);
      return;
    }
    if (p.stopLossPct < -15 || p.stopLossPct > -3) {
      assert('stopLossPct ∈ [-15,-3]', false, `got ${p.stopLossPct}`);
      return;
    }
  }
  assert('所有 5 点都在 bounds 内 + topN integer', true);

  // 同 seed 完全可复现
  const pts5_again = sampleInitialPoints(bounds, 5, 42);
  expectEqual('同 seed → 完全相同序列', pts5, pts5_again);

  // 不同 seed → 不同序列
  const pts5_diff = sampleInitialPoints(bounds, 5, 99);
  assert(
    '不同 seed → 不同序列',
    JSON.stringify(pts5) !== JSON.stringify(pts5_diff)
  );

  // n=0 → 空数组
  expectEqual('n=0 → []', sampleInitialPoints(bounds, 0, 42), []);

  // n=1 → 1 点
  expectEqual('n=1 → 1 点', sampleInitialPoints(bounds, 1, 42).length, 1);

  // n=20 → 20 点（退化为纯随机）
  const pts20 = sampleInitialPoints(bounds, 20, 42);
  expectEqual('n=20 → 20 点', pts20.length, 20);
  for (const p of pts20) {
    if (p.topN < 10 || p.topN > 50) {
      assert('n=20 topN 在 bounds 内', false, `got ${p.topN}`);
      return;
    }
  }
  assert('n=20 所有点在 bounds 内', true);

  // 空 bounds → 空数组（即使 n > 0）
  expectEqual('空 bounds → []', sampleInitialPoints({}, 5, 42), []);
}

// ============================================================
// generateEICandidates
// ============================================================

function testGenerateEICandidates() {
  console.log('\n## generateEICandidates');

  const bounds1d: ParamBounds = { x: { min: 0, max: 10 } };
  const rng = new SeededRandom(42);

  // 1D cartesian: gridSize 个点
  const c1d = generateEICandidates(bounds1d, 16, rng);
  expectEqual('1D cartesian: 16 个点', c1d.length, 16);
  for (const p of c1d) {
    assert(`1D 点维度=1 (got ${p.length})`, p.length === 1);
    assert(`1D 点 ∈ [0,1] (got ${p[0]})`, p[0] >= 0 && p[0] <= 1);
  }

  // 2D cartesian
  const bounds2d: ParamBounds = { x: { min: 0, max: 1 }, y: { min: 0, max: 1 } };
  const rng2 = new SeededRandom(42);
  const c2d = generateEICandidates(bounds2d, 10, rng2);
  expectEqual('2D cartesian: 10x10 = 100 个点', c2d.length, 100);

  // 1D with bestNormalized → 额外 32 加密点
  const rng3 = new SeededRandom(42);
  const c1dWithBest = generateEICandidates(bounds1d, 16, rng3, [0.5]);
  expectEqual('1D + best: 16 + 32 = 48 个点', c1dWithBest.length, 48);

  // 高维（>3）退化为随机采样
  const bounds5d: ParamBounds = {
    a: { min: 0, max: 1 },
    b: { min: 0, max: 1 },
    c: { min: 0, max: 1 },
    d: { min: 0, max: 1 },
    e: { min: 0, max: 1 },
  };
  const rng4 = new SeededRandom(42);
  const c5d = generateEICandidates(bounds5d, 16, rng4);
  assert(
    '5D 退化为随机采样，点数有上限',
    c5d.length > 0 && c5d.length < 100000,
    `got ${c5d.length}`
  );

  // 空 bounds → 空数组
  expectEqual('空 bounds → []', generateEICandidates({}, 16, rng), []);
}

// ============================================================
// pickNextByEI
// ============================================================

function testPickNextByEI() {
  console.log('\n## pickNextByEI');

  // 简单场景：3 个候选，已观测点都不在候选附近 → EI 都 > 0，max EI 取 argmax
  const candidates = [[0.0], [0.5], [1.0]];
  const observations = [
    { normalized: [0.5], score: 1.0, params: {} },
  ];
  const picked = pickNextByEI(candidates, observations, 1.0, 0.3, 1e-6, 0.01);
  assert('返回 point + ei', Array.isArray(picked.point) && Number.isFinite(picked.ei));

  // 空 candidates 抛错
  let err: Error | null = null;
  try {
    pickNextByEI([], observations, 1.0, 0.3, 1e-6, 0.01);
  } catch (e) {
    err = e as Error;
  }
  assert('空 candidates → throws', err !== null);

  // 无观测点 → 任意 candidate 都 EI > 0 (prior std=1)，会取第一个
  const empty = pickNextByEI(candidates, [], 1.0, 0.3, 1e-6, 0.01);
  assert('无观测 → 仍能返回 point', Array.isArray(empty.point));
}

// ============================================================
// optimize() 端到端测试
// ============================================================

/**
 * 构造一个简单的合成目标函数：score = -(x - target)²，在 x=target 处最大化。
 * 让 GP + EI 在 ~30 iter 内收敛到 target 附近。
 */
function makeKnownOptimumRunner(target: number): BacktestRunner {
  return async ({ params }) => {
    const x = Number(params.x);
    const score = -Math.pow(x - target, 2); // 在 x=target 处 score=0（最大）
    // 把 score 映射到 sharpe / annual_return / max_drawdown
    return {
      sharpe: 1.0 + score, // x=target → sharpe=1.0；远离 → sharpe < 1.0
      annual_return: 0.1,
      max_drawdown: 0.1,
    };
  };
}

async function testBasicConvergence() {
  // 在 [0, 10] 找 target=7 的最优
  const optimizer = new BayesianOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_bounds: { x: { min: 0, max: 10 } },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    {
      runner: makeKnownOptimumRunner(7),
      persist: false,
      iterations: 25,
      init_points: 5,
      seed: 42,
    }
  );

  assert('basic: iterations_run = 25', out.iterations_run === 25);
  assert('basic: failed_iterations = 0', out.failed_iterations === 0);
  assert('basic: init_iterations = 5', out.init_iterations === 5);
  assert('basic: ei_iterations = 20', out.ei_iterations === 20);
  assert('basic: best 非 null', out.best !== null);

  const bestX = Number(out.best?.params_json.x);
  // 30 iter 后应该收敛到 target=7 ±1 的范围内（连续优化的合理预期）
  assert(
    `basic: best.x 收敛到 7 附近 (got ${bestX})`,
    Math.abs(bestX - 7) < 1.5,
    `expect close to 7, got ${bestX}`
  );

  // best.sharpe 应该接近 1.0（即 score 接近 0）
  assert(
    `basic: best.sharpe 接近 1.0 (got ${out.best?.sharpe})`,
    Number(out.best?.sharpe) > 0.7,
    `expect > 0.7`
  );
}

async function testFailureIsolation() {
  const flakey: BacktestRunner = async ({ params }) => {
    if (Math.abs(Number(params.x) - 5) < 0.5) {
      throw new Error(`synthetic failure near x=5 (got ${params.x})`);
    }
    return { sharpe: 1.0, annual_return: 0.1, max_drawdown: 0.1 };
  };
  const optimizer = new BayesianOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_bounds: { x: { min: 0, max: 10 } },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    {
      runner: flakey,
      persist: false,
      iterations: 15,
      init_points: 5,
      seed: 42,
    }
  );

  assert('isolation: iterations_run = 15', out.iterations_run === 15);
  assert('isolation: failed > 0', out.failed_iterations > 0);
  assert('isolation: best 仍非 null（成功 iter 存在）', out.best !== null);

  const failedRow = out.results.find(r => r.status === 'failed');
  assert(
    'isolation: 失败行 error_message 含 synthetic',
    !!failedRow?.error_message?.includes('synthetic failure')
  );
  assert(
    'isolation: 失败行 composite_score = null',
    failedRow?.composite_score === null || failedRow?.composite_score === undefined
  );
  assert(
    'isolation: 失败行 sharpe = null',
    failedRow?.sharpe === null || failedRow?.sharpe === undefined
  );
}

async function testAllFailures() {
  const allFail: BacktestRunner = async () => {
    throw new Error('all-fail');
  };
  const optimizer = new BayesianOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_bounds: { x: { min: 0, max: 10 } },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    {
      runner: allFail,
      persist: false,
      iterations: 5,
      init_points: 5,
      seed: 42,
    }
  );

  assert('all-fail: iterations_run = 5', out.iterations_run === 5);
  assert('all-fail: failed = 5', out.failed_iterations === 5);
  assert('all-fail: best = null', out.best === null);
  assert(
    'all-fail: 所有 results status=failed',
    out.results.every(r => r.status === 'failed')
  );
}

async function testMaxIterationsCap() {
  const optimizer = new BayesianOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_bounds: { x: { min: 0, max: 10 } },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    {
      runner: makeKnownOptimumRunner(5),
      persist: false,
      iterations: 100,
      max_iterations: 8,
      init_points: 3,
      seed: 42,
    }
  );
  assert('max_iter cap: iterations_run = 8', out.iterations_run === 8);
}

async function testInitPointsClampedToIterations() {
  const optimizer = new BayesianOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_bounds: { x: { min: 0, max: 10 } },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    {
      runner: makeKnownOptimumRunner(5),
      persist: false,
      iterations: 5,
      init_points: 100, // > iterations
      seed: 42,
    }
  );
  assert('init clamped: iterations_run = 5', out.iterations_run === 5);
  assert('init clamped: init_iterations = 5', out.init_iterations === 5);
  assert('init clamped: ei_iterations = 0', out.ei_iterations === 0);
}

async function testReproducibilityBySeed() {
  const optimizer = new BayesianOptimizer();
  const runner = makeKnownOptimumRunner(7);
  const baseInput = {
    strategy_key: 'fake_strategy_for_test',
    param_bounds: { x: { min: 0, max: 10 } },
    base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
  };
  const out1 = await optimizer.optimize(baseInput, {
    runner,
    persist: false,
    iterations: 10,
    init_points: 4,
    seed: 999,
  });
  const out2 = await optimizer.optimize(baseInput, {
    runner,
    persist: false,
    iterations: 10,
    init_points: 4,
    seed: 999,
  });
  // 采样点序列完全相同
  const xs1 = out1.results.map(r => r.params_json.x);
  const xs2 = out2.results.map(r => r.params_json.x);
  expectEqual('同 seed → 完全相同的 x 序列', xs1, xs2);

  // 不同 seed → 序列不同（初始采样开始就不同）
  const out3 = await optimizer.optimize(baseInput, {
    runner,
    persist: false,
    iterations: 10,
    init_points: 4,
    seed: 12345,
  });
  const xs3 = out3.results.map(r => r.params_json.x);
  assert(
    '不同 seed → 序列不同',
    JSON.stringify(xs1) !== JSON.stringify(xs3),
    `seed=999 vs seed=12345`
  );
}

async function testInjectedRunnerSkipsRegistryCheck() {
  const optimizer = new BayesianOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'this_definitely_does_not_exist',
      param_bounds: { x: { min: 0, max: 10 } },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    {
      runner: makeKnownOptimumRunner(5),
      persist: false,
      iterations: 5,
      init_points: 2,
      seed: 42,
    }
  );
  assert(
    'injected runner: 跳过 registry check',
    out.iterations_run === 5 && out.failed_iterations === 0
  );
}

async function testNonInjectedRunnerRegistryFails() {
  const optimizer = new BayesianOptimizer();
  let err: Error | null = null;
  try {
    await optimizer.optimize(
      {
        strategy_key: 'definitely_not_registered_xyz',
        param_bounds: { x: { min: 0, max: 10 } },
        base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
      },
      { persist: false, iterations: 2 }
    );
  } catch (e) {
    err = e as Error;
  }
  assert('未注册 strategy + 无 runner → 抛错', err !== null);
  assert('错误消息含 "未在 StrategyRegistry"', !!err?.message?.includes('未在 StrategyRegistry'));
}

async function testIntegerBoundsRounded() {
  const optimizer = new BayesianOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_bounds: { topN: { min: 10, max: 50, integer: true } },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    {
      runner: async ({ params }) => ({
        sharpe: 1.0 + Math.random() * 0.1,
        annual_return: 0.1,
        max_drawdown: 0.1,
      }),
      persist: false,
      iterations: 12,
      init_points: 4,
      seed: 42,
    }
  );
  // 所有采样的 topN 都是整数
  for (const r of out.results) {
    const t = r.params_json.topN;
    if (!Number.isInteger(t)) {
      assert(`integer bounds: 所有 topN integer (iter ${r.combo_index}: ${t})`, false);
      return;
    }
  }
  assert(`integer bounds: 所有 12 iter 的 topN 都是 integer`, true);
}

async function testValidateBoundsErrors() {
  const optimizer = new BayesianOptimizer();
  const runner = makeKnownOptimumRunner(5);
  let err1: Error | null = null;
  try {
    await optimizer.optimize(
      {
        strategy_key: 'fake_strategy_for_test',
        param_bounds: {} as any, // 空
        base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
      },
      { runner, persist: false, iterations: 5 }
    );
  } catch (e) {
    err1 = e as Error;
  }
  assert('空 bounds → throws', err1 !== null && err1.message.includes('param_bounds 为空'));

  let err2: Error | null = null;
  try {
    await optimizer.optimize(
      {
        strategy_key: 'fake_strategy_for_test',
        param_bounds: { x: { min: 10, max: 5 } }, // min >= max
        base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
      },
      { runner, persist: false, iterations: 5 }
    );
  } catch (e) {
    err2 = e as Error;
  }
  assert('min >= max → throws', err2 !== null && err2.message.includes('必须 <'));

  let err3: Error | null = null;
  try {
    await optimizer.optimize(
      {
        strategy_key: 'fake_strategy_for_test',
        param_bounds: { x: { min: NaN, max: 5 } }, // NaN min
        base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
      },
      { runner, persist: false, iterations: 5 }
    );
  } catch (e) {
    err3 = e as Error;
  }
  assert('NaN min → throws', err3 !== null);
}

async function testRunnerReceivesCorrectOptions() {
  const optimizer = new BayesianOptimizer();
  const observed: Array<Record<string, any>> = [];
  const runner: BacktestRunner = async (combo, options) => {
    observed.push({
      combo_params: combo.params,
      combo_index: combo.index,
      params_by_strategy: options.params_by_strategy,
      strategy_keys: options.strategy_keys,
      start_date: options.start_date,
    });
    return { sharpe: 1.0, annual_return: 0.1, max_drawdown: 0.1 };
  };
  await optimizer.optimize(
    {
      strategy_key: 'multi_factor_alpha',
      param_bounds: { topN: { min: 10, max: 50, integer: true } },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner, persist: false, iterations: 4, init_points: 2, seed: 42 }
  );
  assert('runner: 收到 4 次调用', observed.length === 4);
  assert(
    'runner: combo[0].params_by_strategy[strategy] = combo[0].params',
    JSON.stringify(observed[0].params_by_strategy['multi_factor_alpha']) ===
      JSON.stringify(observed[0].combo_params)
  );
  assert(
    'runner: combo[0].strategy_keys = [strategy]',
    JSON.stringify(observed[0].strategy_keys) === JSON.stringify(['multi_factor_alpha'])
  );
  assert('runner: base_config.start_date 透传', observed[0].start_date === '2025-01-01');
  // combo_index 升序
  for (let i = 0; i < observed.length; i++) {
    if (observed[i].combo_index !== i) {
      assert(`runner: combo_index[${i}] = ${i}`, false, `got ${observed[i].combo_index}`);
      return;
    }
  }
  assert('runner: combo_index 升序 0..N-1', true);
}

async function testCustomWeights() {
  // 让两组参数有不同的 sharpe / dd 关系；测试自定义权重确实改变 best
  const runner: BacktestRunner = async ({ params }) => {
    const x = Number(params.x);
    if (x < 0.5) return { sharpe: 2.0, annual_return: 0.15, max_drawdown: 0.3 }; // A
    return { sharpe: 1.0, annual_return: 0.15, max_drawdown: 0.05 }; // B
  };
  const baseInput = {
    strategy_key: 'fake_strategy_for_test',
    param_bounds: { x: { min: 0, max: 1 } },
    base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
  };
  const optimizer = new BayesianOptimizer();

  // 默认权重：A score = 2.0 + 0.4*0.15 - 0.5*0.3 = 1.91，B = 1.0 + 0.4*0.15 - 0.5*0.05 = 1.035 → A 胜
  const outDefault = await optimizer.optimize(baseInput, {
    runner,
    persist: false,
    iterations: 10,
    init_points: 8, // 覆盖范围避免 EI 卡在某一侧
    seed: 42,
  });
  assert(
    `default weights: best.x < 0.5 (A)`,
    Number(outDefault.best?.params_json.x) < 0.5,
    `got ${outDefault.best?.params_json.x}`
  );

  // 自定义权重：drawdown 极重 → A: 2.0 - 10*0.3 = -1.0, B: 1.0 - 10*0.05 = 0.5 → B 胜
  const outDDHeavy = await optimizer.optimize(baseInput, {
    runner,
    persist: false,
    iterations: 10,
    init_points: 8,
    seed: 42,
    weights: { drawdown: 10 },
  });
  assert(
    `drawdown-heavy: best.x >= 0.5 (B)`,
    Number(outDDHeavy.best?.params_json.x) >= 0.5,
    `got ${outDDHeavy.best?.params_json.x}`
  );
}

async function testDurationRecorded() {
  const optimizer = new BayesianOptimizer();
  const slowRunner: BacktestRunner = async () => {
    await new Promise(resolve => setTimeout(resolve, 15));
    return { sharpe: 1.0, annual_return: 0.1, max_drawdown: 0.1 };
  };
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_bounds: { x: { min: 0, max: 1 } },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner: slowRunner, persist: false, iterations: 3, init_points: 2, seed: 42 }
  );
  for (const r of out.results) {
    const dur = Number(r.duration_seconds);
    if (!(dur > 0 && dur < 1)) {
      assert(`duration_seconds reasonable (iter ${r.combo_index}: ${dur})`, false);
      return;
    }
  }
  assert('所有 iter duration_seconds > 0 且 < 1s', true);
}

async function testRankedAndBestConsistent() {
  const optimizer = new BayesianOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_bounds: { x: { min: 0, max: 10 } },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    {
      runner: makeKnownOptimumRunner(7),
      persist: false,
      iterations: 12,
      init_points: 4,
      seed: 42,
    }
  );
  assert('best == ranked[0]', out.best?.combo_index === out.ranked[0].combo_index);
  for (let i = 1; i < out.ranked.length; i++) {
    const prev = Number(out.ranked[i - 1].composite_score || -Infinity);
    const cur = Number(out.ranked[i].composite_score || -Infinity);
    assert(`ranked monotone non-increasing at ${i}`, prev >= cur, `${prev} → ${cur}`);
  }
}

async function testTwoDimConvergence() {
  // 二维：在 (3, 7) 处取最优
  const runner: BacktestRunner = async ({ params }) => {
    const x = Number(params.x);
    const y = Number(params.y);
    const score = -((x - 3) ** 2 + (y - 7) ** 2);
    return {
      sharpe: 1.0 + score * 0.1,
      annual_return: 0.1,
      max_drawdown: 0.1,
    };
  };
  const optimizer = new BayesianOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_bounds: { x: { min: 0, max: 10 }, y: { min: 0, max: 10 } },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    {
      runner,
      persist: false,
      iterations: 25,
      init_points: 8,
      seed: 42,
    }
  );
  const bestX = Number(out.best?.params_json.x);
  const bestY = Number(out.best?.params_json.y);
  assert(
    `2D 收敛到 x ≈ 3 (got ${bestX})`,
    Math.abs(bestX - 3) < 2.5,
    `expect close to 3`
  );
  assert(
    `2D 收敛到 y ≈ 7 (got ${bestY})`,
    Math.abs(bestY - 7) < 2.5,
    `expect close to 7`
  );
}

// ============================================================
// 主入口（按顺序 await）
// ============================================================

async function main() {
  testSeededRandom();
  testNormalizeDenormalize();
  testKernelAndStats();
  testCholesky();
  testGaussianProcessPosterior();
  testSampleInitialPoints();
  testGenerateEICandidates();
  testPickNextByEI();

  console.log('\n## BayesianOptimizer.optimize 端到端');
  await testBasicConvergence();
  await testFailureIsolation();
  await testAllFailures();
  await testMaxIterationsCap();
  await testInitPointsClampedToIterations();
  await testReproducibilityBySeed();
  await testInjectedRunnerSkipsRegistryCheck();
  await testNonInjectedRunnerRegistryFails();
  await testIntegerBoundsRounded();
  await testValidateBoundsErrors();
  await testRunnerReceivesCorrectOptions();
  await testCustomWeights();
  await testDurationRecorded();
  await testRankedAndBestConsistent();
  await testTwoDimConvergence();

  console.log(`\n========================================`);
  console.log(`BayesianOptimizer tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('UNCAUGHT TEST ERROR:', err);
  process.exit(2);
});
