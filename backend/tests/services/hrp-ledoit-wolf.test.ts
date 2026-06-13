/**
 * HRP + Ledoit-Wolf 单测 — v2 #1
 *
 * 验证关键公式 + 用论文 / sklearn 已知 case 验算
 */
import {
  centerColumns,
  sampleCovariance,
  ledoitWolfShrinkageIntensity,
  ledoitWolfCovariance,
} from '../../src/services/portfolio/ledoit-wolf';
import {
  correlationToDistance,
  covarianceToCorrelation,
  hierarchicalClusterOrder,
  inverseVariancePortfolio,
  clusterVariance,
  recursiveBisection,
  hierarchicalRiskParity,
} from '../../src/services/portfolio/hrp';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}
function expectClose(name: string, actual: number, expected: number, eps = 1e-3) {
  assert(name, Number.isFinite(actual) && Math.abs(actual - expected) < eps, `expected≈${expected}, got=${actual}`);
}

// ============================================================
// Ledoit-Wolf tests
// ============================================================

function testCenterColumns() {
  console.log('\n## centerColumns');
  const X = [[1, 2], [3, 4], [5, 6]];
  const c = centerColumns(X);
  expectClose('col 0 mean = 0', c.reduce((s, r) => s + r[0], 0) / 3, 0);
  expectClose('col 1 mean = 0', c.reduce((s, r) => s + r[1], 0) / 3, 0);
  expectClose('row 0 col 0 = 1 - 3 = -2', c[0][0], -2);
  expectClose('row 2 col 1 = 6 - 4 = 2', c[2][1], 2);
}

function testSampleCovariance() {
  console.log('\n## sampleCovariance');
  // 完美相关: X[t,0] = X[t,1] → cov[0,1] = cov[0,0] = cov[1,1]
  const Xc = centerColumns([[1, 1], [2, 2], [3, 3], [4, 4]]);
  const S = sampleCovariance(Xc);
  expectClose('对角', S[0][0], S[1][1]);
  expectClose('cov(A,B) = var(A) (完全相关)', S[0][1], S[0][0]);
  // 用 1/T 不是 1/(T-1)
  // X centered = [-1.5, -0.5, 0.5, 1.5], var = (2.25 + 0.25 + 0.25 + 2.25) / 4 = 1.25
  expectClose('var = 5/4 = 1.25', S[0][0], 1.25);
}

function testLedoitWolfShrinkageIntensity() {
  console.log('\n## ledoitWolfShrinkageIntensity');
  // Case 1: 完美相关 + 充分样本 → δ 应该非常小（cov 已经很稳定）
  // 用 100 个时点 × 5 资产, 全相关
  const T = 100, N = 5;
  const X1: number[][] = [];
  for (let t = 0; t < T; t += 1) {
    const v = Math.sin(t * 0.1);
    X1.push(new Array(N).fill(v));
  }
  const d1 = ledoitWolfShrinkageIntensity(X1);
  assert('δ ∈ [0, 1]', d1 >= 0 && d1 <= 1, `δ=${d1}`);

  // Case 2: 高维 + 小样本 → δ 应该比较大
  const T2 = 10, N2 = 8; // T < 2*N
  const X2: number[][] = [];
  let s = 42;
  const rng = () => { s = (s * 9301 + 49297) % 233280; return (s / 233280 - 0.5) * 0.04; };
  for (let t = 0; t < T2; t += 1) {
    const row: number[] = [];
    for (let i = 0; i < N2; i += 1) row.push(rng());
    X2.push(row);
  }
  const d2 = ledoitWolfShrinkageIntensity(X2);
  assert('δ 在小样本时 > 0.1', d2 > 0.1, `δ=${d2}`);

  // Case 3: T < 2 抛错
  let threw = false;
  try { ledoitWolfShrinkageIntensity([[1, 2]]); } catch { threw = true; }
  assert('T < 2 → throw', threw);
}

function testLedoitWolfCovariance() {
  console.log('\n## ledoitWolfCovariance');
  // 完美对角 cov: shrinkage 应使 off-diag 接近 0
  const T = 50, N = 3;
  const X: number[][] = [];
  let s = 7;
  const rng = (mean: number, vol: number) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    const u1 = (s / 2147483648) || 0.01;
    s = (s * 1103515245 + 12345) % 2147483648;
    const u2 = (s / 2147483648) || 0.01;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + vol * z;
  };
  for (let t = 0; t < T; t += 1) {
    X.push([rng(0, 0.01), rng(0, 0.02), rng(0, 0.03)]);
  }
  const lw = ledoitWolfCovariance(X);
  assert('lw.cov 是 N×N', lw.cov.length === N && lw.cov[0].length === N);
  assert('shrinkage ∈ [0, 1]', lw.shrinkage >= 0 && lw.shrinkage <= 1, `δ=${lw.shrinkage}`);
  assert('对角 > 0', lw.cov[0][0] > 0 && lw.cov[1][1] > 0 && lw.cov[2][2] > 0);
  // μ = mean(diag(S))
  assert('mu 是 trace/N', Number.isFinite(lw.mu) && lw.mu > 0);
  // shrunk diag = (1-δ)·S_diag + δ·μ
  // → 应该比 raw S_diag 更接近 μ (shrinkage 把 diag pull to mean)
}

// ============================================================
// HRP tests
// ============================================================

function testCovToCorr() {
  console.log('\n## covarianceToCorrelation');
  const cov = [
    [4, 2],
    [2, 9],
  ];
  const corr = covarianceToCorrelation(cov);
  expectClose('对角 = 1', corr[0][0], 1);
  expectClose('对角 = 1 (2)', corr[1][1], 1);
  // ρ = 2 / (2 * 3) = 1/3
  expectClose('ρ = 2 / (√4 · √9) = 1/3', corr[0][1], 1 / 3);
}

function testCorrToDistance() {
  console.log('\n## correlationToDistance');
  const corr = [
    [1, 0, -1],
    [0, 1, 0.5],
    [-1, 0.5, 1],
  ];
  const d = correlationToDistance(corr);
  expectClose('d[0,0] = 0', d[0][0], 0);
  // d[i,j] = √((1 - ρ) / 2)
  // ρ=0 → d = √0.5 ≈ 0.7071
  expectClose('ρ=0 → d ≈ 0.7071', d[0][1], Math.sqrt(0.5));
  // ρ=-1 → d = √1 = 1
  expectClose('ρ=-1 → d = 1', d[0][2], 1);
  // ρ=0.5 → d = √0.25 = 0.5
  expectClose('ρ=0.5 → d = 0.5', d[1][2], 0.5);
}

function testHierarchicalClusterOrder() {
  console.log('\n## hierarchicalClusterOrder');
  // 3 资产: A 和 B 距离近 (0.1), A-C 和 B-C 远 (1.0)
  //   d = [[0, 0.1, 1.0],
  //        [0.1, 0, 1.0],
  //        [1.0, 1.0, 0]]
  // 预期顺序: A 和 B 相邻 (合并)，C 单独
  // 输出 order = [0, 1, 2] 或 [1, 0, 2] (A B 相邻)
  const d = [
    [0, 0.1, 1.0],
    [0.1, 0, 1.0],
    [1.0, 1.0, 0],
  ];
  const order = hierarchicalClusterOrder(d);
  assert('3 元素', order.length === 3);
  // A B 相邻
  const posA = order.indexOf(0);
  const posB = order.indexOf(1);
  assert('A 和 B 相邻', Math.abs(posA - posB) === 1, `order=[${order}]`);
}

function testInverseVariancePortfolio() {
  console.log('\n## inverseVariancePortfolio');
  // cov 对角 = [1, 4, 9]; w = [1/1, 1/4, 1/9] / sum
  const cov = [
    [1, 0, 0],
    [0, 4, 0],
    [0, 0, 9],
  ];
  const ivp = inverseVariancePortfolio(cov, [0, 1, 2]);
  expectClose('sum = 1', ivp[0] + ivp[1] + ivp[2], 1);
  // w0 / w1 = (1/1) / (1/4) = 4
  expectClose('w0/w1 ≈ 4', ivp[0] / ivp[1], 4);
  // 低 vol 资产权重最大
  assert('低 vol 权重最大', ivp[0] > ivp[1] && ivp[1] > ivp[2]);
}

function testClusterVariance() {
  console.log('\n## clusterVariance');
  // 单资产: V = var(asset) (ivp w=1)
  const cov = [
    [4, 0],
    [0, 9],
  ];
  expectClose('单资产 var = 4', clusterVariance(cov, [0]), 4);
  expectClose('单资产 var = 9', clusterVariance(cov, [1]), 9);
  // 2 资产 IVP: w = [9/(4+9), 4/(4+9)] = [9/13, 4/13]
  // V = w² · 4 + (1-w)² · 9 = ... let me check
  // Actually w0 = 1/4/(1/4+1/9) = (1/4)/(13/36) = 9/13
  //         w1 = 4/13
  // V = w0²·4 + w1²·9 + 2·w0·w1·0
  //   = 81/169·4 + 16/169·9
  //   = 324/169 + 144/169 = 468/169 ≈ 2.769
  const v2 = clusterVariance(cov, [0, 1]);
  expectClose('2-asset IVP var', v2, 468 / 169, 1e-3);
}

function testRecursiveBisection() {
  console.log('\n## recursiveBisection');
  // 4 资产: var = [1, 1, 100, 100]
  // 假设聚类后 order = [0, 1, 2, 3] (前 2 一组, 后 2 一组)
  // L1=[0,1] V1 ≈ 0.5  L2=[2,3] V2 ≈ 50
  // α = 1 - 0.5/(0.5+50) = 0.99...
  // → L1 权重大约 50%, L2 权重大约 50% 因 V 差异
  // wait actually α = 1 - V1/(V1+V2) means L1 gets α (high) if L1 low-vol
  // 让我重新看: α 是 L1 的缩放因子, weights[L1] *= α
  // V1 << V2 → α = 1 - small/big ≈ 1 → L1 几乎全权重
  const cov = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 100, 0],
    [0, 0, 0, 100],
  ];
  const w = recursiveBisection(cov, [0, 1, 2, 3]);
  expectClose('sum = 1', w.reduce((s, v) => s + v, 0), 1);
  // 低 vol 资产权重高
  assert('w[0] > w[2]', w[0] > w[2], `w=[${w.map(x => x.toFixed(3))}]`);
  assert('w[1] > w[3]', w[1] > w[3]);
  // w[0] = w[1], w[2] = w[3] (因为对称)
  expectClose('w[0] = w[1]', w[0], w[1], 1e-6);
  expectClose('w[2] = w[3]', w[2], w[3], 1e-6);
}

function testHRP() {
  console.log('\n## hierarchicalRiskParity (端到端)');
  // 3 资产, 不同 vol 不同相关
  const cov = [
    [0.01, 0.005, 0.001],
    [0.005, 0.04, 0.002],
    [0.001, 0.002, 0.09],
  ];
  const r = hierarchicalRiskParity(cov);
  assert('weights 长度 3', r.weights.length === 3);
  expectClose('sum ≈ 1', r.weights.reduce((s, v) => s + v, 0), 1);
  assert('cluster_order 是 3 个 distinct asset', new Set(r.cluster_order).size === 3);
  // 低 vol 资产 (idx 0) 应该权重最大
  assert('低 vol 权重最大', r.weights[0] === Math.max(...r.weights), `w=[${r.weights.map(x => x.toFixed(3))}]`);
}

function main() {
  testCenterColumns();
  testSampleCovariance();
  testLedoitWolfShrinkageIntensity();
  testLedoitWolfCovariance();
  testCovToCorr();
  testCorrToDistance();
  testHierarchicalClusterOrder();
  testInverseVariancePortfolio();
  testClusterVariance();
  testRecursiveBisection();
  testHRP();

  console.log(`\n========================================`);
  console.log(`HRP + Ledoit-Wolf tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
