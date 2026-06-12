/**
 * PortfolioConstructionService 单测 — Sprint 2B
 */
import {
  PortfolioConstructionService,
  estimateCovariance,
  computePortfolioVariance,
  computeRiskContributions,
  solveERC,
  solveMinVariance,
  solveMaxSharpe,
  applyIndustryConstraints,
  scaleToTotalAllocation,
  computeIndustryExposure,
  DEFAULT_MAX_WEIGHT,
} from '../../src/services/portfolio/PortfolioConstructionService';

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

function testEstimateCovariance() {
  console.log('\n## estimateCovariance');
  // 两资产完全相关: cov(A,B) = var(A) = var(B) = ...
  const returns = [
    [0.01, -0.02, 0.03, -0.01],
    [0.01, -0.02, 0.03, -0.01],
  ];
  const cov = estimateCovariance(returns);
  assert('对角线非零', cov[0][0] > 0);
  expectClose('cov(A,B) = var(A) (完全相关)', cov[0][1], cov[0][0]);

  // 完全反相关
  const returns2 = [
    [0.01, -0.02, 0.03, -0.01],
    [-0.01, 0.02, -0.03, 0.01],
  ];
  const cov2 = estimateCovariance(returns2);
  assert('完全反相关 → 负 cov', cov2[0][1] < 0);
}

function testPortfolioVariance() {
  console.log('\n## computePortfolioVariance');
  const cov = [
    [0.04, 0],
    [0, 0.04],
  ];
  // equal weight 0.5/0.5 → V = 0.25*0.04 + 0.25*0.04 = 0.02
  const V = computePortfolioVariance([0.5, 0.5], cov);
  expectClose('equal w + 对角 cov → V = 0.02', V, 0.02);

  // 全权重 0/1 → V = 0.04
  expectClose('单股 → V = 0.04', computePortfolioVariance([0, 1], cov), 0.04);
}

function testRiskContributions() {
  console.log('\n## computeRiskContributions');
  const cov = [
    [0.04, 0],
    [0, 0.04],
  ];
  const RC = computeRiskContributions([0.5, 0.5], cov);
  // V = 0.02, RC_i = 0.5 * 0.5 * 0.04 = 0.01
  expectClose('对角 cov + equal w → RC 相等', RC[0], 0.01);
  expectClose('对角 cov + equal w → RC 相等 (2)', RC[1], 0.01);
  // sum(RC) = V
  expectClose('sum(RC) = V', RC[0] + RC[1], computePortfolioVariance([0.5, 0.5], cov));
}

function testSolveERC() {
  console.log('\n## solveERC');
  // 高 vol 资产应该得到低权重
  const cov = [
    [0.01, 0],
    [0, 0.04],
  ];
  const r = solveERC(cov);
  assert('收敛', r.converged);
  assert('两个权重和 ≈ 1', Math.abs(r.weights[0] + r.weights[1] - 1) < 1e-3);
  assert('低 vol 资产权重 > 高 vol 资产', r.weights[0] > r.weights[1], `w=[${r.weights[0]}, ${r.weights[1]}]`);

  // RC 应该相等
  const RC = computeRiskContributions(r.weights, cov);
  expectClose('ERC: RC 相等', RC[0], RC[1], 1e-3);
}

function testSolveMinVariance() {
  console.log('\n## solveMinVariance');
  const cov = [
    [0.01, 0],
    [0, 0.04],
  ];
  // min variance 应该把权重放在低 vol 资产
  const r = solveMinVariance(cov, 0, 1);
  assert('权重和 ≈ 1', Math.abs(r.weights[0] + r.weights[1] - 1) < 1e-2);
  assert('低 vol 资产权重更大', r.weights[0] > r.weights[1], `w=[${r.weights[0]}, ${r.weights[1]}]`);
}

function testSolveMaxSharpe() {
  console.log('\n## solveMaxSharpe');
  const cov = [
    [0.01, 0],
    [0, 0.04],
  ];
  // 资产 0 期望收益更高 → max sharpe 倾向 0
  const r = solveMaxSharpe(cov, [0.001, 0.0005], 0, 1, 1.0);
  assert('权重和 ≈ 1', Math.abs(r.weights[0] + r.weights[1] - 1) < 1e-2);
  assert('高期望收益资产权重更大', r.weights[0] > r.weights[1], `w=[${r.weights[0]}, ${r.weights[1]}]`);
}

function testApplyIndustryConstraints() {
  console.log('\n## applyIndustryConstraints');
  // 银行行业 0.6 超过 0.4 → 缩到 0.4
  const w = [0.3, 0.3, 0.2, 0.2];
  const ind = ['银行', '银行', '消费', '科技'];
  const out = applyIndustryConstraints(['A', 'B', 'C', 'D'], w, ind, 0.4);
  const bankSum = out[0] + out[1];
  expectClose('银行行业 ≤ 0.4', bankSum, 0.4, 1e-3);
  // 比例保持: 0.3/0.3 还是 1:1
  expectClose('行业内权重比例保持', out[0] / out[1], 1, 1e-3);

  // 无超 cap → 不变
  const w2 = [0.3, 0.3, 0.3, 0.1];
  const out2 = applyIndustryConstraints(['A', 'B', 'C', 'D'], w2, ['银行', '消费', '科技', '消费'], 0.5);
  assert('无超 cap → 不变', JSON.stringify(out2) === JSON.stringify(w2));
}

function testScaleToTotalAllocation() {
  console.log('\n## scaleToTotalAllocation');
  const out = scaleToTotalAllocation([0.5, 0.5], 0.8);
  expectClose('sum=0.8', out[0] + out[1], 0.8);
  expectClose('比例保持', out[0] / out[1], 1, 1e-3);
}

function testComputeIndustryExposure() {
  console.log('\n## computeIndustryExposure');
  const exp = computeIndustryExposure([0.3, 0.2, 0.1], ['银行', '银行', '科技']);
  expectClose('银行 = 0.5', exp['银行'], 0.5);
  expectClose('科技 = 0.1', exp['科技'], 0.1);

  // null industry → UNKNOWN
  const exp2 = computeIndustryExposure([0.3, 0.7], [null, '银行']);
  expectClose('UNKNOWN = 0.3', exp2['UNKNOWN'], 0.3);
}

async function testServiceConstruct() {
  console.log('\n## construct end-to-end');
  const svc = new PortfolioConstructionService();

  // 3 资产 20 日收益（让 cov 矩阵更稳定）
  const returns = [
    [0.01, -0.01, 0.02, -0.005, 0.015, 0.008, -0.012, 0.011, -0.007, 0.018,
     -0.008, 0.013, -0.011, 0.009, -0.005, 0.012, -0.015, 0.014, -0.009, 0.016],
    [0.02, -0.02, 0.01, 0.005, -0.01, 0.015, -0.018, 0.022, 0.001, -0.012,
     0.018, -0.014, 0.011, -0.019, 0.025, -0.013, 0.017, 0.003, -0.021, 0.019],
    [-0.01, 0.015, 0.005, 0.02, -0.015, -0.008, 0.012, -0.018, 0.024, 0.001,
     -0.011, 0.013, -0.022, 0.015, -0.004, 0.018, -0.012, 0.020, 0.002, -0.016],
  ];
  const r1 = await svc.construct(
    {
      as_of_date: '2026-06-13',
      candidates: [
        { symbol: 'A', industry: '银行', daily_returns: returns[0] },
        { symbol: 'B', industry: '消费', daily_returns: returns[1] },
        { symbol: 'C', industry: '科技', daily_returns: returns[2] },
      ],
    },
    { method: 'risk_parity', max_weight: 0.5, min_weight: 0, persist: false }
  );
  assert('3 个 symbols', r1.symbols.length === 3);
  assert('3 个 weights', r1.weights.length === 3);
  // ERC 在小样本下未必能收敛到 1e-6，但权重应该是合理的
  assert('权重都 > 0', r1.weights.every(w => w > 0), `weights=${JSON.stringify(r1.weights)}`);
  const sum = r1.weights.reduce((s, v) => s + v, 0);
  assert('权重和接近 total_allocation', Math.abs(sum - r1.total_allocation) < 1e-3);

  // equal_weight 1/3
  const r2 = await svc.construct(
    {
      as_of_date: '2026-06-13',
      candidates: [
        { symbol: 'A', industry: '银行' },
        { symbol: 'B', industry: '消费' },
        { symbol: 'C', industry: '科技' },
      ],
    },
    { method: 'equal_weight', persist: false }
  );
  expectClose('equal_weight 权重相等', r2.weights[0], r2.weights[1], 1e-3);

  // 单股
  const r3 = await svc.construct(
    {
      as_of_date: '2026-06-13',
      candidates: [{ symbol: 'A', industry: '银行' }],
    },
    { persist: false }
  );
  assert('单股 1 个 weight', r3.weights.length === 1);

  // 空 → throw
  let threw = false;
  try {
    await svc.construct({ as_of_date: '2026-06-13', candidates: [] }, { persist: false });
  } catch {
    threw = true;
  }
  assert('空 candidates → throw', threw);

  // 行业约束生效
  const r4 = await svc.construct(
    {
      as_of_date: '2026-06-13',
      candidates: [
        { symbol: 'A', industry: '银行', daily_returns: returns[0] },
        { symbol: 'B', industry: '银行', daily_returns: returns[1] },
        { symbol: 'C', industry: '消费', daily_returns: returns[2] },
      ],
    },
    { method: 'risk_parity', max_weight: 0.5, min_weight: 0, max_industry_weight: 0.4, persist: false }
  );
  const bankExp = r4.industry_exposure['银行'] || 0;
  assert('行业 cap 生效', bankExp <= 0.41, `bankExp=${bankExp}`);
}

async function main() {
  testEstimateCovariance();
  testPortfolioVariance();
  testRiskContributions();
  testSolveERC();
  testSolveMinVariance();
  testSolveMaxSharpe();
  testApplyIndustryConstraints();
  testScaleToTotalAllocation();
  testComputeIndustryExposure();
  await testServiceConstruct();
  console.log(`\n========================================`);
  console.log(`PortfolioConstructionService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
