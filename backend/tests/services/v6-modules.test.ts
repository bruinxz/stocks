/**
 * v6 联合测试: PCA+FF + GARCH/EGARCH/HAR-RV + NS+Vasicek + Bouchaud + BMA
 */
import {
  powerIteration,
  topKPrincipalComponents,
  projectOntoPCs,
  varianceExplained,
  famaFrenchRegression,
  constructFamaFrenchFactors,
} from '../../src/services/research/pca-fama-french';
import {
  garchVolatility,
  garchNegLogLikelihood,
  fitGARCH,
  garchForecast,
  egarchVolatility,
  fitEGARCH,
  realizedVariance,
  fitHARRV,
  harRVForecast,
} from '../../src/services/research/volatility-models';
import {
  nelsonSiegelYield,
  fitNelsonSiegel,
  vasicekBondPrice,
  vasicekYield,
  fitVasicek,
} from '../../src/services/research/term-structure';
import {
  bouchaudImpact,
  bouchaudImpactBps,
  calibrateBouchaudY,
  bouchaudImpactToScore,
  compareACvsBouchaud,
} from '../../src/services/execution/bouchaud-impact';
import {
  bicScore,
  aicScore,
  posteriorProbabilities,
  bayesianModelAverage,
  bmaVariance,
  combineModelsBMA,
  effectiveModelCount,
} from '../../src/services/research/bayesian-model-averaging';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`); }
}
function expectClose(name: string, actual: number, expected: number, eps = 1e-3) {
  assert(name, Number.isFinite(actual) && Math.abs(actual - expected) < eps, `expected≈${expected}, got=${actual}`);
}

function testPowerIteration() {
  console.log('\n## powerIteration');
  // Diagonal: eigenvalues = diag, top eigenvector = [0, 0, 1] for diag(1, 2, 5)
  const A = [[1, 0, 0], [0, 2, 0], [0, 0, 5]];
  const r = powerIteration(A, { max_iter: 200, tol: 1e-10 });
  expectClose('top eigenvalue = 5', r.eigenvalue, 5, 0.01);
  // eigenvector ≈ ±[0, 0, 1]
  assert('eigenvector points to [0,0,1]', Math.abs(r.eigenvector[2]) > 0.99, `v=[${r.eigenvector.map(x => x.toFixed(2))}]`);
}

function testTopKPC() {
  console.log('\n## topKPrincipalComponents');
  const A = [[1, 0, 0], [0, 2, 0], [0, 0, 5]];
  const r = topKPrincipalComponents(A, 3, { max_iter: 200, tol: 1e-10 });
  assert('3 eigenvalues', r.eigenvalues.length === 3);
  // First should be ~5
  expectClose('eigenvalues[0] ≈ 5', r.eigenvalues[0], 5, 0.1);
  expectClose('eigenvalues[1] ≈ 2', r.eigenvalues[1], 2, 0.1);
}

function testVarianceExplained() {
  console.log('\n## varianceExplained');
  const ev = varianceExplained([5, 3, 2]);
  expectClose('first = 0.5', ev[0], 0.5);
  expectClose('second = 0.3', ev[1], 0.3);
  expectClose('third = 0.2', ev[2], 0.2);
}

function testFamaFrench() {
  console.log('\n## famaFrenchRegression');
  // Synthetic: r_stock = 0.001 + 1.2 mkt + 0.3 smb - 0.1 hml + noise
  const N = 100;
  const mkt: number[] = [], smb: number[] = [], hml: number[] = [], stock: number[] = [];
  let s = 42;
  for (let i = 0; i < N; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    const m = (s / 233280 - 0.5) * 0.02;
    s = (s * 9301 + 49297) % 233280;
    const sm = (s / 233280 - 0.5) * 0.01;
    s = (s * 9301 + 49297) % 233280;
    const h = (s / 233280 - 0.5) * 0.015;
    mkt.push(m); smb.push(sm); hml.push(h);
    stock.push(0.001 + 1.2 * m + 0.3 * sm - 0.1 * h);
  }
  const r = famaFrenchRegression({ stock_excess_returns: stock, mkt, smb, hml });
  expectClose('alpha ≈ 0.001', r.alpha, 0.001, 0.001);
  expectClose('beta_mkt ≈ 1.2', r.beta_mkt, 1.2, 0.05);
  expectClose('beta_smb ≈ 0.3', r.beta_smb, 0.3, 0.05);
  expectClose('beta_hml ≈ -0.1', r.beta_hml, -0.1, 0.05);
  assert('R² > 0.99 (no noise)', r.r_squared > 0.99);
}

function testGarch() {
  console.log('\n## GARCH(1,1)');
  // Synthetic GARCH process
  const N = 200;
  const trueParams = { omega: 0.00001, alpha: 0.1, beta: 0.85 };
  const returns: number[] = [];
  const sigma2: number[] = [0.0004]; // initial
  let s = 11;
  for (let t = 0; t < N; t += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const u1 = (s / 2147483648) || 0.01;
    s = (s * 1103515245 + 12345) % 2147483648;
    const u2 = (s / 2147483648) || 0.01;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const r = z * Math.sqrt(sigma2[t]);
    returns.push(r);
    sigma2.push(trueParams.omega + trueParams.alpha * r * r + trueParams.beta * sigma2[t]);
  }

  const vol = garchVolatility(returns, trueParams);
  assert('vol length = N', vol.length === N);
  assert('vol > 0', vol.every(v => v > 0));

  const fit = fitGARCH(returns);
  assert('fitGARCH converged or grid-found', fit.params.alpha > 0 && fit.params.beta > 0);
  assert('alpha + beta < 1 (stationary)', fit.params.alpha + fit.params.beta < 1);

  const forecast = garchForecast(returns, fit.params);
  assert('forecast > 0', forecast > 0);
}

function testEGarch() {
  console.log('\n## EGARCH');
  const N = 100;
  const returns: number[] = [];
  let s = 7;
  for (let t = 0; t < N; t += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const u1 = (s / 2147483648) || 0.01;
    s = (s * 1103515245 + 12345) % 2147483648;
    const u2 = (s / 2147483648) || 0.01;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    returns.push(z * 0.02);
  }
  const fit = fitEGARCH(returns);
  assert('beta stationary', Math.abs(fit.params.beta) < 1);
  const vol = egarchVolatility(returns, fit.params);
  assert('vol > 0', vol.every(v => v > 0));
}

function testHARRV() {
  console.log('\n## HAR-RV');
  const N = 100;
  const returns: number[] = [];
  let s = 33;
  for (let t = 0; t < N; t += 1) {
    s = (s * 9301 + 49297) % 233280;
    returns.push((s / 233280 - 0.5) * 0.04);
  }
  const rv = realizedVariance(returns);
  const fit = fitHARRV(rv);
  assert('R² finite', Number.isFinite(fit.r_squared));
  const forecast = harRVForecast(rv, fit.params);
  assert('forecast 有限', Number.isFinite(forecast));
}

function testNelsonSiegel() {
  console.log('\n## Nelson-Siegel');
  // Test point: τ=0 should give β_0 (boundary)
  expectClose('τ=0 → β_0', nelsonSiegelYield(0, 3, 1, 0.5, 1.5), 3);
  // Long τ → β_0
  const y_long = nelsonSiegelYield(100, 3, 1, 0.5, 1.5);
  expectClose('τ=100 → β_0 (large τ limit)', y_long, 3, 0.1);

  // Fit: synthetic curve
  const taus = [0.25, 0.5, 1, 2, 3, 5, 7, 10];
  const yields = taus.map(t => nelsonSiegelYield(t, 3, 1, 0.5, 1.5));
  const fit = fitNelsonSiegel(yields, taus, { lambda: 1.5 });
  expectClose('β_0 ≈ 3', fit.beta_0, 3, 0.05);
  expectClose('β_1 ≈ 1', fit.beta_1, 1, 0.05);
  expectClose('β_2 ≈ 0.5', fit.beta_2, 0.5, 0.05);
  assert('R² ≈ 1 (no noise)', fit.r_squared > 0.999);
}

function testVasicek() {
  console.log('\n## Vasicek');
  // bond price at τ=0 should be 1
  expectClose('P(τ=0) = 1', vasicekBondPrice(0, 0.03, { kappa: 0.3, theta: 0.04, sigma: 0.01 }), 1);
  // yield at τ=0 → r (short rate)
  expectClose('y(τ=0) = r', vasicekYield(0, 0.03, { kappa: 0.3, theta: 0.04, sigma: 0.01 }), 0.03);

  // Fit: synthetic short-rate series
  const N = 252;
  const params_true = { kappa: 0.3, theta: 0.04, sigma: 0.01 };
  const dt = 1 / 252;
  const rates: number[] = [0.05];
  let s = 17;
  for (let t = 0; t < N; t += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const u1 = (s / 2147483648) || 0.01;
    s = (s * 1103515245 + 12345) % 2147483648;
    const u2 = (s / 2147483648) || 0.01;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const dr = params_true.kappa * (params_true.theta - rates[t]) * dt + params_true.sigma * Math.sqrt(dt) * z;
    rates.push(rates[t] + dr);
  }
  const fit = fitVasicek(rates, dt);
  assert('kappa > 0', fit.kappa > 0);
  assert('theta in reasonable range', fit.theta > -0.1 && fit.theta < 0.2, `θ=${fit.theta}`);
  assert('sigma > 0', fit.sigma > 0);
}

function testBouchaud() {
  console.log('\n## Bouchaud Square-root impact');
  // 标准 case: Q=1000, V=1M, σ=2%, Y=1
  //   impact = 1 × 0.02 × √(1000/1e6) = 0.02 × 0.0316 = 0.000633 (6.32 bps)
  const r = bouchaudImpact(1000, 1_000_000, 0.02, 1);
  expectClose('impact = 6.32 bps', r * 10000, 6.32, 0.1);

  // Larger order
  const r2 = bouchaudImpact(100_000, 1_000_000, 0.02, 1);
  // = 0.02 × √(0.1) = 0.02 × 0.316 = 0.00632 (63.2 bps)
  expectClose('impact 100K = 63.2 bps', bouchaudImpactBps(100_000, 1_000_000, 0.02, 1), 63.2, 0.5);

  // sqrt scaling: 100x larger order → ~10x larger impact (vs linear's 100x)
  const ratio = bouchaudImpact(100_000, 1_000_000, 0.02, 1) / bouchaudImpact(1000, 1_000_000, 0.02, 1);
  expectClose('100x order → 10x impact', ratio, 10, 0.5);
}

function testCalibrateBouchaud() {
  console.log('\n## calibrateBouchaudY');
  // 构造 trades, true Y = 1.5
  const trades = [
    { realized_impact_fraction: 1.5 * 0.02 * Math.sqrt(0.001), order_qty: 1000, adv: 1_000_000, daily_vol: 0.02 },
    { realized_impact_fraction: 1.5 * 0.025 * Math.sqrt(0.005), order_qty: 5000, adv: 1_000_000, daily_vol: 0.025 },
    { realized_impact_fraction: 1.5 * 0.015 * Math.sqrt(0.01), order_qty: 10000, adv: 1_000_000, daily_vol: 0.015 },
  ];
  const r = calibrateBouchaudY(trades);
  expectClose('Y_median ≈ 1.5', r.Y_median, 1.5, 0.01);
  expectClose('Y_ols ≈ 1.5', r.Y_ols, 1.5, 0.01);
}

function testCompareACvsBC() {
  console.log('\n## compareACvsBouchaud');
  const r = compareACvsBouchaud({
    order_qty: 10000, adv: 1_000_000, daily_vol: 0.02, spread_pct: 0.001,
  });
  assert('AC bps > 0', r.almgren_chriss_bps > 0);
  assert('BC bps > 0', r.bouchaud_bps > 0);
  assert('recommendation 非空', r.recommendation.length > 0);
}

function testBicAic() {
  console.log('\n## BIC + AIC');
  // 2-param model, 100 obs, logL = -50
  expectClose('BIC = 100 + 2 log(100)', bicScore(-50, 2, 100), 100 + 2 * Math.log(100));
  expectClose('AIC = 100 + 4', aicScore(-50, 2), 104);
}

function testPosteriorProbs() {
  console.log('\n## posteriorProbabilities');
  // 2 models with BIC = 100 and 110 → model 1 strongly preferred
  const p = posteriorProbabilities([100, 110]);
  expectClose('sum = 1', p[0] + p[1], 1);
  assert('p[0] > p[1] (lower BIC)', p[0] > p[1]);
  // Exact: p[0] / p[1] = exp((110 - 100) / 2) = exp(5) ≈ 148
  expectClose('p[0] / p[1] ≈ exp(5)', p[0] / p[1], Math.exp(5), 1);
}

function testBayesianAverage() {
  console.log('\n## bayesianModelAverage');
  // 2 models, predictions [1, 2] and [3, 4], weights [0.7, 0.3]
  const r = bayesianModelAverage([[1, 2], [3, 4]], [0.7, 0.3]);
  expectClose('avg[0] = 0.7×1 + 0.3×3 = 1.6', r[0], 1.6);
  expectClose('avg[1] = 0.7×2 + 0.3×4 = 2.6', r[1], 2.6);
}

function testCombineModelsBMA() {
  console.log('\n## combineModelsBMA');
  const r = combineModelsBMA([
    { name: 'A', predictions: [1, 2, 3], log_likelihood: -10, n_params: 2, n_obs: 50 },
    { name: 'B', predictions: [2, 3, 4], log_likelihood: -8, n_params: 2, n_obs: 50 },
    { name: 'C', predictions: [3, 4, 5], log_likelihood: -15, n_params: 3, n_obs: 50 },
  ]);
  expectClose('posteriors sum = 1', r.posteriors[0] + r.posteriors[1] + r.posteriors[2], 1);
  // B has highest log_likelihood and same n_params as A → B should dominate
  assert('B > A in posterior', r.posteriors[1] > r.posteriors[0]);
  assert('3 averaged predictions', r.averaged_predictions.length === 3);
}

function testEffectiveModelCount() {
  console.log('\n## effectiveModelCount');
  // Uniform 3 models → K_eff = 3
  expectClose('uniform → K_eff = 3', effectiveModelCount([1/3, 1/3, 1/3]), 3);
  // One dominant model → K_eff ≈ 1
  expectClose('p=[1, 0, 0] → K_eff = 1', effectiveModelCount([0.999, 0.0005, 0.0005]), 1, 0.01);
}

function main() {
  testPowerIteration();
  testTopKPC();
  testVarianceExplained();
  testFamaFrench();
  testGarch();
  testEGarch();
  testHARRV();
  testNelsonSiegel();
  testVasicek();
  testBouchaud();
  testCalibrateBouchaud();
  testCompareACvsBC();
  testBicAic();
  testPosteriorProbs();
  testBayesianAverage();
  testCombineModelsBMA();
  testEffectiveModelCount();

  console.log(`\n========================================`);
  console.log(`v6 tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
