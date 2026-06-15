/**
 * FactorOrthogonalizationService 单元测试 (Sprint 41-D):
 *   - 基础统计 (vecMean / vecStddev)
 *   - pearsonCorrelation
 *   - correlationMatrix (N×N 对称 + 对角=1)
 *   - clusterRedundantFactors (相关性高合并)
 *   - ordinaryLeastSquares (OLS 基本 + singular)
 *   - residualizeFactor (残差化基本)
 *   - computeCrowdingScore (IC 衰减 + spread 收窄)
 *   - downweightCrowded (权重归一化)
 *
 * 不依赖 jest, 直接 node:
 *   cd backend && npx ts-node --transpile-only tests/services/factor-orthogonalization.test.ts
 */

import {
  vecMean,
  vecStddev,
  pearsonCorrelation,
  correlationMatrix,
  clusterRedundantFactors,
  ordinaryLeastSquares,
  residualizeFactor,
  computeCrowdingScore,
  downweightCrowded,
  CrowdingResult,
} from '../../src/services/factor/FactorOrthogonalizationService';

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
  console.log('# vec stats');
  close('vecMean([1,2,3])=2', vecMean([1, 2, 3]), 2);
  close('vecStddev([1,2,3])=1', vecStddev([1, 2, 3]), 1);
  close('vecMean 空=0', vecMean([]), 0);
}

// ===========================================================================
// pearsonCorrelation
// ===========================================================================

function testPearson(): void {
  console.log('# pearsonCorrelation');
  // 完美正相关
  close('y=2x → r=1', pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1);
  // 完美负相关
  close('y=-x → r=-1', pearsonCorrelation([1, 2, 3], [3, 2, 1]), -1);
  // 不相关 (常数)
  close('常数 y → r=0', pearsonCorrelation([1, 2, 3], [5, 5, 5]), 0);
  // 长度不一致
  close('长度不一致 → r=0', pearsonCorrelation([1, 2], [1, 2, 3]), 0);
}

// ===========================================================================
// correlationMatrix
// ===========================================================================

function testCorrelationMatrix(): void {
  console.log('# correlationMatrix');
  const fs = new Map<string, Map<string, number>>();
  fs.set(
    'value',
    new Map([
      ['A', 1],
      ['B', 2],
      ['C', 3],
    ])
  );
  fs.set(
    'momentum',
    new Map([
      ['A', 2],
      ['B', 4],
      ['C', 6],
    ])
  );
  fs.set(
    'quality',
    new Map([
      ['A', 3],
      ['B', 2],
      ['C', 1],
    ])
  );
  const cm = correlationMatrix(fs);
  eq('3 factors sorted asc', cm.factor_names, ['momentum', 'quality', 'value']);
  // momentum vs value 完全正相关
  // matrix index: 0=momentum, 1=quality, 2=value
  close('momentum-value r=1', cm.matrix[0][2], 1);
  // quality vs value 完全负相关
  close('quality-value r=-1', cm.matrix[1][2], -1);
  // 对角 = 1
  for (let i = 0; i < 3; i++) close(`diag[${i}]=1`, cm.matrix[i][i], 1);
  // 对称
  close('symmetric (0,1)', cm.matrix[0][1], cm.matrix[1][0]);
}

// ===========================================================================
// clusterRedundantFactors
// ===========================================================================

function testClusterRedundant(): void {
  console.log('# clusterRedundantFactors');
  // 3 个因子, 0-1 高相关, 2 独立
  const M = [
    [1, 0.9, 0.1],
    [0.9, 1, 0.2],
    [0.1, 0.2, 1],
  ];
  const clusters = clusterRedundantFactors(M, ['a', 'b', 'c'], 0.7);
  eq('2 个 cluster', clusters.length, 2);
  // 找出含 a,b 的 cluster
  const bigCluster = clusters.find(c => c.members.length === 2);
  assert('大 cluster 含 a,b', !!bigCluster && bigCluster.members.includes('a') && bigCluster.members.includes('b'));

  // 全独立
  const Mind = [
    [1, 0.1, 0.2],
    [0.1, 1, 0.15],
    [0.2, 0.15, 1],
  ];
  const indClusters = clusterRedundantFactors(Mind, ['a', 'b', 'c'], 0.7);
  eq('全独立 3 个 cluster', indClusters.length, 3);

  // 全冗余
  const Mall = [
    [1, 0.95, 0.9],
    [0.95, 1, 0.92],
    [0.9, 0.92, 1],
  ];
  const allClusters = clusterRedundantFactors(Mall, ['a', 'b', 'c'], 0.7);
  eq('全冗余 1 个 cluster', allClusters.length, 1);
  eq('cluster 含全部', allClusters[0].members.sort(), ['a', 'b', 'c']);

  // 空
  eq('空 → []', clusterRedundantFactors([], [], 0.7), []);
}

// ===========================================================================
// ordinaryLeastSquares
// ===========================================================================

function testOLS(): void {
  console.log('# OLS');
  // y = 2 + 3x (单变量)
  const X1 = [[1], [2], [3], [4], [5]];
  const y1 = [5, 8, 11, 14, 17];
  const r1 = ordinaryLeastSquares(X1, y1);
  close('单变量 intercept=2', r1.intercept, 2);
  close('单变量 coef=3', r1.coefficients[0], 3);
  close('R²=1 (完美拟合)', r1.r_squared, 1);
  for (const r of r1.residuals) close('完美拟合残差≈0', r, 0, 1e-9);

  // y = 1 + 2x1 + 3x2 (多变量)
  const X2 = [
    [1, 1],
    [2, 1],
    [1, 2],
    [3, 2],
    [2, 3],
  ];
  const y2 = X2.map(([a, b]) => 1 + 2 * a + 3 * b);
  const r2 = ordinaryLeastSquares(X2, y2);
  close('多变量 intercept=1', r2.intercept, 1);
  close('多变量 coef1=2', r2.coefficients[0], 2);
  close('多变量 coef2=3', r2.coefficients[1], 3);

  // 退化情况 (X singular: 全 0)
  const X3 = [[0], [0], [0]];
  const y3 = [1, 2, 3];
  const r3 = ordinaryLeastSquares(X3, y3);
  close('singular intercept=mean', r3.intercept, 2);
}

// ===========================================================================
// residualizeFactor
// ===========================================================================

function testResidualize(): void {
  console.log('# residualizeFactor');
  // 原始因子 = 2 + 3×market_cap + noise; 残差化后应该消掉 market_cap 影响
  const factor = new Map<string, number>();
  const exposures = new Map<string, number[]>();
  for (let i = 1; i <= 10; i++) {
    const cap = i;
    const noise = (i % 3) * 0.5;
    factor.set(`A${i}`, 2 + 3 * cap + noise);
    exposures.set(`A${i}`, [cap]);
  }
  const residuals = residualizeFactor(factor, exposures);
  eq('残差 size=10', residuals.size, 10);
  // 残差 mean ≈ 0
  const resArr = Array.from(residuals.values());
  close('残差 mean≈0', vecMean(resArr), 0, 1e-6);
  // 残差 std 应远小于原始 std (大部分方差被 cap 吸收)
  const origArr = Array.from(factor.values());
  assert('残差 std < 原始 std', vecStddev(resArr) < vecStddev(origArr));

  // 样本不足 < 5 → passthrough
  const small = new Map([['A1', 1.0], ['A2', 2.0]]);
  const smallExp = new Map([
    ['A1', [1]],
    ['A2', [2]],
  ]);
  const smallRes = residualizeFactor(small, smallExp);
  eq('样本不足 passthrough', smallRes.get('A1'), 1.0);
}

// ===========================================================================
// computeCrowdingScore
// ===========================================================================

function testCrowding(): void {
  console.log('# computeCrowdingScore');
  // case 1: 无衰减无收窄 → 0
  const r1 = computeCrowdingScore({
    recent_ic_series: [0.05, 0.06, 0.05, 0.07],
    baseline_ic_series: [0.05, 0.06, 0.05, 0.07],
  });
  close('无衰减 crowding=0', r1.crowding_score, 0);
  eq('warning=ok', r1.warning, 'ok');
  close('weight×1', r1.recommended_weight_multiplier, 1);

  // case 2: IC 衰减 50%
  const r2 = computeCrowdingScore({
    recent_ic_series: [0.025, 0.03, 0.025, 0.035], // mean=0.029
    baseline_ic_series: [0.05, 0.06, 0.05, 0.07], // mean=0.058
  });
  assert('IC 衰减 50%, crowding > 0', r2.crowding_score > 0);
  assert('ic_decay_pct ≈ -0.5', Math.abs(r2.ic_decay_pct - (-0.5)) < 0.05);
  assert('weight < 1', r2.recommended_weight_multiplier < 1);
  console.log(`  ℹ️ IC 衰减 50% → crowding=${r2.crowding_score.toFixed(2)}, weight=${r2.recommended_weight_multiplier.toFixed(2)}`);

  // case 3: 极端 — IC 完全反转
  const r3 = computeCrowdingScore({
    recent_ic_series: [-0.05, -0.06, -0.05, -0.07],
    baseline_ic_series: [0.05, 0.06, 0.05, 0.07],
  });
  assert('完全反转 crowding 高', r3.crowding_score > 0.5);
  console.log(`  ℹ️ IC 完全反转 → crowding=${r3.crowding_score.toFixed(2)} [${r3.warning}]`);

  // case 4: spread 收窄
  const r4 = computeCrowdingScore({
    recent_ic_series: [0.05, 0.05, 0.05],
    baseline_ic_series: [0.05, 0.05, 0.05],
    current_long_short_spread: 0.005,
    baseline_long_short_spread: 0.015,
  });
  assert('spread 收窄 67%', r4.spread_compression_pct < -0.5);
  console.log(`  ℹ️ spread 收窄 → crowding=${r4.crowding_score.toFixed(2)}`);

  // case 5: weight cap at 0.2 (IC 完全衰减 + spread 完全收窄)
  const rMax = computeCrowdingScore({
    recent_ic_series: [-1, -1, -1],
    baseline_ic_series: [0.01, 0.01, 0.01],
    current_long_short_spread: 0,
    baseline_long_short_spread: 0.01,
  });
  close('weight cap=0.2', rMax.recommended_weight_multiplier, 0.2);
}

// ===========================================================================
// downweightCrowded
// ===========================================================================

function testDownweight(): void {
  console.log('# downweightCrowded');
  const weights = new Map([
    ['value', 0.3],
    ['momentum', 0.4],
    ['quality', 0.3],
  ]);
  const crowding = new Map<string, CrowdingResult>();
  crowding.set('momentum', {
    crowding_score: 0.8,
    ic_decay_pct: -0.6,
    spread_compression_pct: -0.5,
    recommended_weight_multiplier: 0.3,
    warning: 'crowded',
    reason: 'test',
  });
  const adjusted = downweightCrowded(weights, crowding);
  eq('size 不变', adjusted.size, 3);
  // momentum 应该被显著降权
  assert('momentum 降权', adjusted.get('momentum')! < 0.4);
  // value/quality 应该相对加权
  assert('value 提升', adjusted.get('value')! > 0.3);
  // sum=1
  const sum = Array.from(adjusted.values()).reduce((s, v) => s + v, 0);
  close('权重归一化 sum=1', sum, 1);
}

// ===========================================================================
// Run
// ===========================================================================

testStats();
testPearson();
testCorrelationMatrix();
testClusterRedundant();
testOLS();
testResidualize();
testCrowding();
testDownweight();

console.log('');
console.log(`✅ passed=${passed}`);
console.log(`❌ failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
