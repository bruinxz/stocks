/**
 * ResearchValidationService 单元测试 (Sprint 41-C):
 *   - 基础统计 (mean / stddev / skewness / kurtosis / normalCDF / inverseNormalCDF)
 *   - sharpeRatio
 *   - purgedKFoldSplit (各 fold + embargo 边界)
 *   - deflatedSharpeRatio (DSR 阈值 + 极端 input)
 *   - probabilityOfBacktestOverfitting (PBO 各场景)
 *   - combinations
 *
 * 不依赖 jest, 直接 node 跑:
 *   cd backend && npx ts-node --transpile-only tests/services/research-validation.test.ts
 */

import {
  mean,
  stddev,
  skewness,
  excessKurtosis,
  normalCDF,
  inverseNormalCDF,
  sharpeRatio,
  purgedKFoldSplit,
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
  combinations,
} from '../../src/services/research/ResearchValidationService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}
function close(name: string, a: number, b: number, eps = 1e-4): void {
  assert(name, Math.abs(a - b) < eps, `actual=${a} expected=${b}`);
}
function eq<T>(name: string, a: T, b: T): void {
  assert(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
}

// ===========================================================================
// 基础统计
// ===========================================================================

function testStats(): void {
  console.log('# 基础统计');
  close('mean([1,2,3,4,5])=3', mean([1, 2, 3, 4, 5]), 3);
  close('mean([])=0', mean([]), 0);
  close('stddev([1,2,3,4,5])=√2.5≈1.5811', stddev([1, 2, 3, 4, 5]), Math.sqrt(2.5));
  close('stddev([5,5,5])=0', stddev([5, 5, 5]), 0);
  close('stddev 单样本=0', stddev([1]), 0);

  // 标准正态分布数据
  close('skewness 对称数据≈0', skewness([1, 2, 3, 4, 5]), 0, 1e-6);
  // [1..10] 是均匀分布, sample excess kurtosis = -1.2 (uniform 的 theoretical = -1.2)
  close('kurtosis 均匀数据=-1.2', excessKurtosis([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), -1.2, 1e-3);

  // normalCDF
  close('Φ(0)=0.5', normalCDF(0), 0.5);
  close('Φ(1.96)≈0.975', normalCDF(1.96), 0.975, 1e-3);
  close('Φ(-1.96)≈0.025', normalCDF(-1.96), 0.025, 1e-3);

  // inverseNormalCDF
  close('Φ⁻¹(0.5)=0', inverseNormalCDF(0.5), 0, 1e-6);
  close('Φ⁻¹(0.975)≈1.96', inverseNormalCDF(0.975), 1.96, 1e-3);
  close('Φ⁻¹(0.025)≈-1.96', inverseNormalCDF(0.025), -1.96, 1e-3);

  // sharpeRatio - 用算好的精确值
  close('sharpe(常数)=0 (no vol)', sharpeRatio([0.01, 0.01, 0.01]), 0);
  close('sharpe 单样本=0', sharpeRatio([0.01]), 0);
  // [0, 0.01, -0.01, 0.005, 0.005, -0.005]: mean=0.000833, std=0.007360, sharpe = mean/std*sqrt(252) = 1.797
  close(
    'sharpe([0,0.01,-0.01,0.005,0.005,-0.005])≈1.797',
    sharpeRatio([0, 0.01, -0.01, 0.005, 0.005, -0.005]),
    1.797,
    0.01
  );
}

// ===========================================================================
// Purged K-Fold
// ===========================================================================

function testPurgedKFold(): void {
  console.log('# Purged K-Fold');
  const splits = purgedKFoldSplit(100, 5, 2);
  eq('5 folds', splits.length, 5);
  // 每个 fold test_size ≈ 20
  for (const s of splits) {
    assert(`fold ${s.fold_index} test_size ≈ 20`, s.test_indices.length === 20);
  }
  // fold 0: test=[0,20), purged=[20,22)
  eq('fold 0 test indices [0..20)', splits[0].test_indices.slice(0, 3), [0, 1, 2]);
  eq('fold 0 purged 2 个', splits[0].purged_indices.length, 2);
  // fold 4 (最后): test=[80,100), purged=[78,80)
  eq('fold 4 test_indices.length=20', splits[4].test_indices.length, 20);
  eq('fold 4 purged=[78,80)', splits[4].purged_indices, [78, 79]);
  // 中间 fold 应有 4 个 purged (左右各 2)
  eq('fold 1 purged 4 个', splits[1].purged_indices.length, 4);

  // n < k_folds → 空
  eq('n<k 返回空', purgedKFoldSplit(3, 5, 1), []);

  // embargo=0
  const splits0 = purgedKFoldSplit(100, 5, 0);
  for (const s of splits0) {
    eq(`embargo=0 fold ${s.fold_index} purged=[]`, s.purged_indices, []);
  }
  // 验证 train + test = n (embargo=0 没有 purged)
  for (const s of splits0) {
    assert(`fold ${s.fold_index} train+test=n`, s.train_indices.length + s.test_indices.length === 100);
  }
}

// ===========================================================================
// Deflated Sharpe Ratio
// ===========================================================================

function testDSR(): void {
  console.log('# Deflated Sharpe Ratio');
  // 试 1 次, observed 高 → 显著
  const r1 = deflatedSharpeRatio({
    observed_sharpe: 2.0,
    n_trials: 1,
    variance_of_trials: 0.01, // 单次 trial 也需要个 dummy variance
    n_observations: 252,
    skewness: 0,
    excess_kurtosis: 0,
  });
  // n_trials=1 时 Φ⁻¹(0) 是 -∞, 我们的实现给 -Infinity, expected_max ≈ -∞
  // 这是边界, 不强 assert 数值
  assert('DSR n_trials=1 不崩', typeof r1.deflated_sharpe === 'number');

  // 试 100 次, observed=1.5, expected_max=1.789 (因为 trials var=0.5) → DSR 低
  // 这是预期: observed 不显著高于"100 次试验下最佳 SR"
  const r2 = deflatedSharpeRatio({
    observed_sharpe: 1.5,
    n_trials: 100,
    variance_of_trials: 0.5, // trials std=√0.5=0.71
    n_observations: 252,
    skewness: 0,
    excess_kurtosis: 0,
  });
  assert('DSR 在 [0, 1]', r2.deflated_sharpe >= 0 && r2.deflated_sharpe <= 1);
  console.log(`  ℹ️ DSR(obs=1.5, N=100, var=0.5) = ${r2.deflated_sharpe.toFixed(3)} expected_max=${r2.expected_max_sharpe.toFixed(3)}`);

  // 试 100 次, observed=3 (远高于 expected_max=1.789) → DSR 应该 > 0.95
  const rGood = deflatedSharpeRatio({
    observed_sharpe: 3.0,
    n_trials: 100,
    variance_of_trials: 0.5,
    n_observations: 252,
    skewness: 0,
    excess_kurtosis: 0,
  });
  console.log(`  ℹ️ DSR(obs=3.0, N=100, var=0.5) = ${rGood.deflated_sharpe.toFixed(3)} (应显著)`);
  assert('观察 SR 远超 expected_max → DSR > 0.5', rGood.deflated_sharpe > 0.5);

  // 试 1000 次, observed=1.5 → expected_max 更高
  const r3 = deflatedSharpeRatio({
    observed_sharpe: 1.5,
    n_trials: 1000,
    variance_of_trials: 1.0,
    n_observations: 252,
    skewness: 0,
    excess_kurtosis: 0,
  });
  console.log(`  ℹ️ DSR(obs=1.5, N=1000, var=1) = ${r3.deflated_sharpe.toFixed(3)} expected_max=${r3.expected_max_sharpe.toFixed(3)}`);
  // 更高 N → expected_max 更高 → DSR 更低
  assert('N=1000 vs N=100, expected_max 增大', r3.expected_max_sharpe > r2.expected_max_sharpe);

  // 输入无效
  const rInvalid = deflatedSharpeRatio({
    observed_sharpe: 1,
    n_trials: 0,
    variance_of_trials: 1,
    n_observations: 100,
    skewness: 0,
    excess_kurtosis: 0,
  });
  eq('n_trials=0 → 不显著', rInvalid.is_significant, false);

  // skew/kurt 极端导致分母 <= 0
  const rExtreme = deflatedSharpeRatio({
    observed_sharpe: 2,
    n_trials: 10,
    variance_of_trials: 1,
    n_observations: 100,
    skewness: 0,
    excess_kurtosis: -10, // 极端低 kurt → 分母可能 <= 0
  });
  assert('极端 kurt 不崩', typeof rExtreme.deflated_sharpe === 'number');
}

// ===========================================================================
// PBO
// ===========================================================================

function testPBO(): void {
  console.log('# PBO');
  // case 1: 单调有 alpha 策略 (所有时段都赚) → 低 PBO
  const goodStrats = Array.from({ length: 10 }, (_, i) =>
    Array.from({ length: 80 }, () => 0.001 * (i + 1) + (Math.random() - 0.5) * 0.001)
  );
  const r1 = probabilityOfBacktestOverfitting(goodStrats);
  console.log(`  ℹ️ PBO(单调 alpha 策略) = ${r1.pbo.toFixed(3)} (${r1.warning})`);
  assert('PBO 在 [0, 1]', r1.pbo >= 0 && r1.pbo <= 1);

  // case 2: 纯随机 (无 alpha) → 中等 PBO ≈ 0.5
  const randStrats = Array.from({ length: 10 }, () =>
    Array.from({ length: 80 }, () => (Math.random() - 0.5) * 0.01)
  );
  const r2 = probabilityOfBacktestOverfitting(randStrats);
  console.log(`  ℹ️ PBO(纯随机) = ${r2.pbo.toFixed(3)} (${r2.warning})`);

  // case 3: 样本不足
  const r3 = probabilityOfBacktestOverfitting([], 50);
  eq('空 → 0 PBO', r3.pbo, 0);
  const r4 = probabilityOfBacktestOverfitting([[0.01, 0.02]], 50);
  eq('< 4 时段 → 0 PBO', r4.pbo, 0);
}

// ===========================================================================
// combinations
// ===========================================================================

function testCombinations(): void {
  console.log('# combinations');
  eq('C(4,2)=6', combinations([1, 2, 3, 4], 2).length, 6);
  eq('C(4,0)=1', combinations([1, 2, 3, 4], 0), [[]]);
  eq('C(4,4)=1', combinations([1, 2, 3, 4], 4), [[1, 2, 3, 4]]);
  eq('C(4,5)=空', combinations([1, 2, 3, 4], 5), []);
  // 元素正确
  const c = combinations([1, 2, 3], 2);
  eq('C(3,2)=[1,2],[1,3],[2,3]', c, [[1, 2], [1, 3], [2, 3]]);
}

// ===========================================================================
// Run
// ===========================================================================

testStats();
testPurgedKFold();
testDSR();
testPBO();
testCombinations();

console.log('');
console.log(`✅ passed=${passed}`);
console.log(`❌ failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
