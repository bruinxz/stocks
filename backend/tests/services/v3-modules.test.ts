/**
 * v3 联合测试: BlackLitterman + Bootstrap
 * (FractionalDiff / InformationBars / OnlineLearning / MetaLabel 已随 §2.3 删除 meta/ 目录移除)
 */
import {
  buildPickMatrix,
  buildAbsoluteView,
  buildRelativeView,
  matrixInverse,
  matMul,
  impliedEquilibriumReturns,
  computeBlackLittermanPosterior,
} from '../../src/services/portfolio/black-litterman';
import {
  BootstrapRng,
  computePercentile,
  percentileBootstrap,
  bcaBootstrap,
} from '../../src/services/research/bootstrap-ci';

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
// Black-Litterman
// ============================================================

function testMatrixInverse() {
  console.log('\n## matrixInverse');
  const I = [[1, 0], [0, 1]];
  const inv = matrixInverse(I);
  expectClose('I^-1 = I[0][0]', inv[0][0], 1);
  expectClose('I^-1 = I[1][1]', inv[1][1], 1);
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
  assert('P[0] = [1,0,0]', P[0][0] === 1 && P[0][1] === 0 && P[0][2] === 0);
  assert('P[1] = [0,1,-1]', P[1][0] === 0 && P[1][1] === 1 && P[1][2] === -1);
  expectClose('Q[0] = 0.05', Q[0], 0.05);
  expectClose('Q[1] = 0.02', Q[1], 0.02);
  expectClose('Ω[0][0] = 0.01', Omega[0][0], 0.01);
  expectClose('Ω[1][1] = 0.005', Omega[1][1], 0.005);
}

function testImpliedEquilibriumReturns() {
  console.log('\n## impliedEquilibriumReturns');
  const Pi = impliedEquilibriumReturns([[1, 0], [0, 1]], [0.5, 0.5], 3);
  expectClose('Π[0]', Pi[0], 1.5);
  expectClose('Π[1]', Pi[1], 1.5);
}

function testBlackLitterman() {
  console.log('\n## computeBlackLittermanPosterior');
  const sigma = [[0.04, 0.01], [0.01, 0.09]];
  const mktW = [0.6, 0.4];
  const noViews: any[] = [];
  const r1 = computeBlackLittermanPosterior(sigma, mktW, noViews);
  expectClose('无 views → posterior = implied (0)', r1.posterior_returns[0], r1.implied_returns[0]);
  expectClose('无 views → posterior = implied (1)', r1.posterior_returns[1], r1.implied_returns[1]);

  const views = [buildAbsoluteView(0, 0.10, 0.10)];
  const r2 = computeBlackLittermanPosterior(sigma, mktW, views);
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
  const seq1 = [rng.next(), rng.next(), rng.next()];
  const rng2 = new BootstrapRng(42);
  const seq2 = [rng2.next(), rng2.next(), rng2.next()];
  expectClose('seed 42 序列 1[0]', seq1[0], seq2[0]);
  expectClose('seed 42 序列 1[1]', seq1[1], seq2[1]);
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

function main() {
  testMatrixInverse();
  testMatMul();
  testBuildPickMatrix();
  testImpliedEquilibriumReturns();
  testBlackLitterman();
  testBootstrapRng();
  testComputePercentile();
  testPercentileBootstrap();
  testBcaBootstrap();

  console.log(`\n========================================`);
  console.log(`v3 tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
