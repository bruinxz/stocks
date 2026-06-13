/**
 * Sprint 7-18 联合 smoke test
 *
 * 验证每个新模块的关键 export 函数能跑 + 数学正确
 */
import { buildIndicatorMatrix, averageUniqueness, computeSampleWeightsByReturns, timeDecayWeights } from '../../src/services/meta/afml-sample-weights';
import { sizeFromProbability, discretizeBetSize, decideBetSize, averageActiveBetSize } from '../../src/services/meta/afml-bet-sizing';
import { strategyEfficientFrontier, timeUnderWater, probabilisticSharpeRatio, frequencyOfBets, averageHoldingPeriod } from '../../src/services/meta/afml-strategy-stats';
import { nestedClusteredOptimization, rollSpread, corwinSchultzSpread, beckerParkinsonVol, shannonEntropy, adfTestStatistic, supAdf, marchenkoPasturThreshold, denoiseCorrelation, detoneCorrelation } from '../../src/services/research/afml-advanced';
import { terminalWealthRelative, geometricMeanReturn, optimalF, leverageSpaceModel, riskOfRuin, kellyFraction, compareKellyVsOptimalF } from '../../src/services/governor/vince-money-mgmt';
import { computeDecisionQualityScore, decisionPnlMatrix, classifyTraderPattern, scorePreMortem, narangArchitectureAudit, narangCoverageScore } from '../../src/services/governor/decision-quality';
import { computeBarraExposure, zScoreExposures, computeIndustryProsperity, computeGuosenScore, detectStyleSwitch, computeStyleFactorReturns } from '../../src/services/research/china-research';
import { equityRiskPremium, termPremium, volatilityRiskPremium, amihudIlliquidity, macroAdjustedPremium, qepmIRDecomposition, styleIntegration, macroStyleWeights, activeRiskDecomposition } from '../../src/services/research/ilmanen-qepm';
import { bonferroniHolmCorrection, benjaminiHochbergFDR, whitesRealityCheck, BULKOWSKI_PATTERN_TABLE, reliablePatternsOnly, patternRegimeAdjusted, detectInverseHeadAndShoulders, detectTripleBottom, detectCupAndHandle } from '../../src/services/research/aronson-bulkowski';
import { forecastDiversificationMultiplier, combineSystemForecastsWithFDM, stockCarry, carverPositionSize, vwapSchedule, twapSchedule, povSchedule, smartOrderRouting, engleGrangerCointegration, pairsTradingSignal, meanReversionHalfLife } from '../../src/services/execution/carver-johnson-chan';
import { trainDecisionStump, adaBoost, predictAdaBoost, trainRegressionStump, gradientBoostingRegressor, predictGradientBoosting, randomForestRegressor, simpleExponentialSmoothing, holtsLinear, fitARp, autoSelectARorder, qrDecomposition, choleskyDecomposition } from '../../src/services/research/ml-foundation';
import { simplexLP, socpRobustPortfolio, projectOntoPSDCone, dualGapQP, checkKKT } from '../../src/services/portfolio/boyd-convex-full';
import { estimateFillProbability, callAuctionClearing, straddlePayoff, varianceSwapFairStrike, glostenMilgromSpread, probabilityOfInformedTrading, dealerProfitPerRoundTrip, liquidityDemanderCost } from '../../src/services/execution/harris-full';
import { MockBrokerBridge, processOvernightSignals, persistHMMParams, loadHMMParams, persistThompsonPosteriors, loadThompsonPosteriors, persistMetaLabelCheckpoint } from '../../src/services/integration/production-bridges';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`); }
}
function close(name: string, actual: number, expected: number, eps = 1e-3) {
  assert(name, Number.isFinite(actual) && Math.abs(actual - expected) < eps, `expected≈${expected}, got=${actual}`);
}

// ============================================================
// Sprint 7 — AFML
// ============================================================
console.log('\n## Sprint 7: AFML Sample Weights / Bet Sizing / Strategy Stats');
{
  const samples = [{ t_in: 0, t_out: 2 }, { t_in: 1, t_out: 3 }, { t_in: 4, t_out: 5 }];
  const ind = buildIndicatorMatrix(samples, 6);
  assert('indicator matrix shape', ind.length === 6 && ind[0].length === 3);
  assert('sample 0 active at t=0', ind[0][0] === 1);
  const u = averageUniqueness(ind);
  assert('uniqueness sample 2 = 1 (no overlap)', u[2] === 1);
  const w = computeSampleWeightsByReturns([0.5, 0.5, 1.0], [0.02, 0.03, 0.01]);
  assert('weights sum to N (normalized)', Math.abs(w.reduce((s, v) => s + v, 0) - 3) < 0.01);
  const tdw = timeDecayWeights([1, 1, 1], 0.5);
  assert('time decay weights non-zero', tdw.every(v => v > 0));

  close('sizeFromProbability(0.5) = 0', sizeFromProbability(0.5), 0, 1e-6);
  assert('sizeFromProbability(0.8) > 0.5', sizeFromProbability(0.8) > 0.5);
  close('discretizeBetSize(0.37, 0.1) = 0.4', discretizeBetSize(0.37, 0.1), 0.4, 0.01);
  const dec = decideBetSize({ probability: 0.7, discretization_step: 0.1 });
  assert('decideBetSize should_bet=true', dec.should_bet);

  const f_returns = [[0.01, -0.005, 0.02], [0.005, -0.002, 0.01]];
  const ef = strategyEfficientFrontier(f_returns);
  assert('efficient frontier weights sum=1', Math.abs(ef.min_var_weights.reduce((s, v) => s + v, 0) - 1) < 1e-3);
  const tuw = timeUnderWater([-0.1, -0.05, 0.02, 0.1, -0.03]);
  assert('time under water finite', Number.isFinite(tuw.max_tuw_days));
  const psr = probabilisticSharpeRatio(1.5, 100, 0, 3, 0);
  assert('PSR in [0, 1]', psr >= 0 && psr <= 1);
  close('frequencyOfBets(50, 100, 252) ≈ 126', frequencyOfBets(50, 100, 252), 126);
  close('avg holding period', averageHoldingPeriod([{ entry_idx: 0, exit_idx: 5 }, { entry_idx: 10, exit_idx: 15 }]), 5);
}

// ============================================================
// Sprint 8 — AFML Ch.16-19 + MLfAM
// ============================================================
console.log('\n## Sprint 8: AFML Advanced + MLfAM');
{
  const cov_simple = [[1, 0.5], [0.5, 1]];
  const nco = nestedClusteredOptimization(cov_simple);
  assert('NCO weights', nco.weights.length === 2);
  const roll_spread = rollSpread([100, 99.5, 100.5, 99.8, 100.2, 99.9]);
  assert('Roll spread non-null (alternating prices)', roll_spread !== null);

  const highs = [10, 11, 12, 11];
  const lows = [9, 10, 11, 10];
  const cs = corwinSchultzSpread(highs, lows);
  assert('CS spread length = highs.length', cs.length === 4);
  const bp = beckerParkinsonVol(highs, lows);
  assert('BP vol non-negative', bp.every(v => isNaN(v) || v >= 0));

  const entropy = shannonEntropy([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  assert('Shannon entropy > 0', entropy > 0);
  const adf = adfTestStatistic([1, 1.2, 0.9, 1.1, 1.05, 0.95, 1.0, 1.08]);
  assert('ADF t-stat computed', Number.isFinite(adf.t_stat));
  const sadf = supAdf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20]);
  assert('SADF non-NaN', Number.isFinite(sadf));

  const mp = marchenkoPasturThreshold(10, 100);
  assert('MP threshold > 1', mp.lambda_max > 1);
  const corr = [[1, 0.3, 0.2], [0.3, 1, 0.4], [0.2, 0.4, 1]];
  const dn = denoiseCorrelation(corr, 100);
  assert('denoise gives N×N', dn.denoised.length === 3);
  const dt = detoneCorrelation(corr, 1);
  assert('detone diag ≈ 1', Math.abs(dt[0][0] - 1) < 0.1);
}

// ============================================================
// Sprint 9 — Vince
// ============================================================
console.log('\n## Sprint 9: Vince Money Management');
{
  const trades = [0.1, -0.05, 0.08, -0.04, 0.12, -0.06];
  const twr_05 = terminalWealthRelative(trades, 0.5);
  assert('TWR > 0', twr_05 > 0);
  const gmr = geometricMeanReturn(trades, 0.3);
  assert('GMR finite', Number.isFinite(gmr));
  const opt = optimalF(trades);
  assert('optimal f ∈ [0, 1]', opt.f >= 0 && opt.f <= 1);
  const ls = leverageSpaceModel([trades, trades.slice().reverse()]);
  assert('leverage space 2 systems', ls.f_vector.length === 2);
  const rr = riskOfRuin(0.55, 10);
  assert('risk of ruin ∈ [0, 1]', rr >= 0 && rr <= 1);
  close('kelly p=0.6 b=2 = (0.6×2-0.4)/2 = 0.4', kellyFraction(0.6, 2), 0.4);
  const cmp = compareKellyVsOptimalF(trades);
  assert('compare has recommendation', cmp.recommendation.length > 0);
}

// ============================================================
// Sprint 10 — Decision Quality
// ============================================================
console.log('\n## Sprint 10: Decision Quality + Trader Patterns');
{
  const dqs = computeDecisionQualityScore({
    followed_entry_plan: true,
    sizing_matched_conviction: 8,
    honored_stop_loss: true,
    exited_per_plan: 7,
    recorded_thesis_pre_trade: true,
  });
  assert('DQS > 80', dqs.dqs > 80);
  const matrix = decisionPnlMatrix(70, 100);
  assert('high DQS + positive PnL = true alpha', matrix === 'true_alpha');
  const trades = [
    { entry_date: '2024-01-01', exit_date: '2024-01-15', entry_price: 10, exit_price: 11, n_add_on_dips: 0, n_add_on_rallies: 0, days_held: 14, return_pct: 0.10, used_stop_loss: true },
    { entry_date: '2024-02-01', exit_date: '2024-02-10', entry_price: 12, exit_price: 13, n_add_on_dips: 0, n_add_on_rallies: 0, days_held: 9, return_pct: 0.08, used_stop_loss: true },
  ];
  const pat = classifyTraderPattern(trades);
  assert('pattern classified', pat.pattern !== undefined);
  const pm = scorePreMortem({
    thesis: 'Long sh.600000 because of positive earnings surprise', expected_return_pct: 0.15,
    expected_time_horizon_days: 60, position_size_pct: 0.03,
    most_likely_failure_cause: 'Macro downturn', pre_emptive_mitigation: 'Reduce position if VIX > 30',
    explicit_exit_conditions: ['Drop -10%', 'Time stop 90 days'],
    worst_case_loss_pct: 0.15,
  });
  assert('pre-mortem quality > 80', pm.quality_score > 80);
  const audit = narangArchitectureAudit();
  assert('Narang audit 6 layers', audit.length === 6);
  const cov = narangCoverageScore();
  assert('coverage > 50%', cov.overall_coverage_pct > 50);
}

// ============================================================
// Sprint 11 — China Research
// ============================================================
console.log('\n## Sprint 11: China Research');
{
  const expo = computeBarraExposure({
    symbol: 'sh.600000', market_cap: 1e10, beta_252d: 1.1, return_252d_ex_last_month: 0.20,
    vol_90d_annualized: 0.30, book_value_per_share: 5, price: 10, monthly_turnover: 1e6,
    earnings_per_share: 0.5, growth_5y: 0.10, debt_to_equity: 0.5,
  });
  assert('Barra exposure computed', Number.isFinite(expo.size));
  const zexps = zScoreExposures([expo, expo, expo]); // identical → z = 0
  assert('z-score all identical = 0', zexps.every(e => Math.abs(e.size) < 1e-6));
  const prosp = computeIndustryProsperity({
    industry: '银行', upstream_price_change: 0, downstream_demand_change: 0.05,
    revenue_growth: 5, net_margin: 30, roe: 15,
    northbound_change_pct: 0.02, active_fund_holding_change: 0.01,
    pe_ttm: 8, pe_historical_avg: 10, pb: 1.0, pb_historical_avg: 1.2,
  });
  assert('prosperity score 0-100', prosp.score >= 0 && prosp.score <= 100);
  const gs = computeGuosenScore({ fundamental_zscore: 1, technical_zscore: 0.5, sentiment_zscore: 0 });
  assert('Guosen score finite', Number.isFinite(gs.score));
  const sw = detectStyleSwitch([{ date: '2024-01-01', smb: 0.01, hml: -0.01, momentum: 0.005, vol: 0 }], 5);
  assert('style switch returns object', typeof sw === 'object');
}

// ============================================================
// Sprint 12 — Ilmanen + QEPM
// ============================================================
console.log('\n## Sprint 12: Ilmanen + QEPM');
{
  close('ERP', equityRiskPremium({ earnings_yield: 0.06, risk_free_rate: 0.03 }), 0.03);
  close('term premium', termPremium(0.04, 0.02), 0.02);
  close('vol premium', volatilityRiskPremium(0.20, 0.18), 0.02);
  const amihud = amihudIlliquidity([0.02, -0.01, 0.015], [1e6, 1e6, 1e6]);
  assert('Amihud > 0', amihud > 0);
  const macro = macroAdjustedPremium({ base_premium: 0.04, inflation_rate: 3, credit_spread: 100, vix_level: 25 });
  assert('macro adjusted finite', Number.isFinite(macro.adjusted_premium));
  const ir = qepmIRDecomposition({ ic_style: 0.03, ic_stock_specific: 0.04, ic_industry: 0.02, breadth: 100, transfer_coefficient: 0.5 });
  assert('total IR > 0', ir.total_ir > 0);
  const si = styleIntegration([[1, 2, 3], [4, 5, 6]], [0.5, 0.5]);
  close('style integ first', si[0], 2.5);
  const msw = macroStyleWeights(['value', 'growth', 'momentum', 'low_vol', 'quality', 'size'], 'bull');
  assert('macro weights 6', msw.length === 6);
  const ar = activeRiskDecomposition({ active_factor_exposures: [0.1, 0.2], factor_cov_matrix: [[0.04, 0.01], [0.01, 0.09]], active_weights: [0.05, -0.05], specific_variances: [0.04, 0.04] });
  assert('active risk > 0', ar.total_active_risk > 0);
}

// ============================================================
// Sprint 13 — Aronson + Bulkowski
// ============================================================
console.log('\n## Sprint 13: Aronson + Bulkowski');
{
  const bh = bonferroniHolmCorrection([0.001, 0.02, 0.06]);
  assert('first p reject', bh[0] === true);
  const fdr = benjaminiHochbergFDR([0.001, 0.02, 0.06]);
  assert('FDR first reject', fdr[0] === true);
  const wrc = whitesRealityCheck({ rule_returns: [[0.001, 0.002, -0.001], [0.0005, 0.001, 0.001]], B: 100, seed: 42 });
  assert('WRC p-value ∈ [0, 1]', wrc.p_value >= 0 && wrc.p_value <= 1);
  assert('Bulkowski table 15 patterns', BULKOWSKI_PATTERN_TABLE.length === 15);
  const reliable = reliablePatternsOnly(0.7);
  assert('reliable patterns ≥ 7', reliable.length >= 7);
  const adj = patternRegimeAdjusted(BULKOWSKI_PATTERN_TABLE[0], 'bull');
  assert('regime adjusted', Number.isFinite(adj.adjusted_success));
  // Pattern detection (synthetic)
  const ihs_data = [100, 95, 90, 85, 87, 80, 78, 80, 85, 89, 92, 88, 90, 95];
  const ihs = detectInverseHeadAndShoulders(ihs_data, 14);
  // Result depends on data, just check non-throwing
  assert('IHS detect runs', typeof ihs.detected === 'boolean');
  const tb = detectTripleBottom([100, 90, 95, 91, 96, 90, 100], 7);
  assert('triple bottom runs', typeof tb.detected === 'boolean');
}

// ============================================================
// Sprint 14 — Carver V2 + Johnson + Chan
// ============================================================
console.log('\n## Sprint 14: Carver V2 + Johnson DMA + Chan');
{
  close('FDM uncorrelated 2 systems', forecastDiversificationMultiplier([0.5, 0.5], [[1, 0], [0, 1]]), Math.sqrt(2), 0.01);
  const combined = combineSystemForecastsWithFDM({ forecasts: [10, 10], weights: [0.5, 0.5], correlation_matrix: [[1, 0], [0, 1]] });
  assert('combined forecast > 0', combined.combined_forecast > 0);
  close('stock carry', stockCarry({ dividend_yield: 0.04, buyback_yield: 0.02, borrow_rate: 0.01 }), 0.05);
  assert('carver position size finite', Number.isFinite(carverPositionSize({ forecast: 15, vol_target_annual: 0.20, instrument_vol_annual: 0.25, capital: 1e6 })));
  const vwap = vwapSchedule(10000, [100, 200, 300, 400]);
  close('vwap schedule sum = 10000', vwap.reduce((s, v) => s + v, 0), 10000, 1);
  const twap = twapSchedule(10000, 5);
  close('twap each = 2000', twap[0], 2000);
  const pov = povSchedule(0.1, [100, 200]);
  close('pov first = 10', pov[0], 10);
  const sor = smartOrderRouting({ order_qty: 10000, venues: [{ name: 'A', cost_bps: 5, available_liquidity: 4000, latency_ms: 10 }, { name: 'B', cost_bps: 8, available_liquidity: 8000, latency_ms: 5 }] });
  assert('SOR returns routes', sor.length >= 1);
  // Cointegration: synthetic
  const x = Array.from({ length: 100 }, (_, i) => i * 0.01 + 0.5 * Math.sin(i * 0.1));
  const y = x.map(v => 2 * v + 1);
  const coint = engleGrangerCointegration(y, x);
  assert('cointegration beta ≈ 2', Math.abs(coint.beta - 2) < 0.1, `β=${coint.beta}`);
  const sig = pairsTradingSignal({ y, x, beta: coint.beta, alpha: coint.alpha, window: 20, entry_z: 2, exit_z: 0 });
  assert('pairs signal generated', sig.positions.length === y.length);
  // Mean reversion: stationary AR(1)
  const ar1 = [0];
  for (let i = 0; i < 100; i += 1) ar1.push(ar1[i] * 0.5 + (Math.random() - 0.5));
  const mr = meanReversionHalfLife(ar1);
  assert('mean reversion HL > 0 for AR(1)', mr.half_life_days > 0);
}

// ============================================================
// Sprint 15 — ML Foundation
// ============================================================
console.log('\n## Sprint 15: ML Foundation (ESL/ISL/Hyndman)');
{
  const X_data = [[1, 2], [2, 3], [3, 4], [4, 5], [5, 1], [6, 2]];
  const y_data = [1, 1, 1, 1, -1, -1];
  const weights = new Array(6).fill(1 / 6);
  const { stump } = trainDecisionStump(X_data, y_data, weights);
  assert('stump trained', typeof stump.feature_idx === 'number');
  const ab = adaBoost(X_data, y_data, 5);
  assert('adaboost ensemble', ab.stumps.length > 0);
  assert('adaboost predict ±1', [1, -1].includes(predictAdaBoost(ab, [3, 4])));
  const reg = trainRegressionStump(X_data, [1.1, 1.9, 3.0, 4.0, 5.0, 5.9]);
  assert('reg stump', typeof reg.feature_idx === 'number');
  const gb = gradientBoostingRegressor(X_data, [1.1, 1.9, 3.0, 4.0, 5.0, 5.9], { M: 10 });
  assert('GB predict finite', Number.isFinite(predictGradientBoosting(gb, [3, 4])));
  const rf = randomForestRegressor(X_data, [1.1, 1.9, 3.0, 4.0, 5.0, 5.9], { B: 20, m_features: 1 });
  assert('RF has trees', rf.trees.length > 0);
  // ETS
  const ses = simpleExponentialSmoothing([10, 11, 12, 11, 13, 14], 0.3);
  assert('SES forecast > 11', ses.forecast > 11);
  const holt = holtsLinear([10, 11, 12, 13, 14, 15]);
  assert('holt forecast > 15', holt.forecast_1step > 15);
  // ARIMA
  const ar_data = Array.from({ length: 50 }, (_, i) => Math.sin(i * 0.5) + 0.1 * Math.random());
  const ar = fitARp(ar_data, 2);
  assert('AR(2) coef length 2', ar.coefficients.length === 2);
  const auto = autoSelectARorder(ar_data, 5);
  assert('best_p > 0', auto.best_p > 0);
  // Math helpers
  const A = [[1, 2], [3, 4]];
  const qr = qrDecomposition(A);
  assert('QR Q is 2×2', qr.Q.length === 2 && qr.Q[0].length === 2);
  const psd = [[4, 2], [2, 3]];
  const L = choleskyDecomposition(psd);
  assert('Cholesky L 2×2', L.length === 2 && L[0].length === 2);
}

// ============================================================
// Sprint 16 — Boyd Convex Full
// ============================================================
console.log('\n## Sprint 16: Boyd Convex Optimization Full');
{
  const lp = simplexLP([1, -1], [[1, 1], [1, 0]], [10, 5]);
  assert('LP status finite', ['optimal', 'unbounded', 'max_iter'].includes(lp.status));
  const socp = socpRobustPortfolio({ expected_returns: [0.1, 0.08, 0.06], cov_matrix: [[0.04, 0.01, 0], [0.01, 0.09, 0], [0, 0, 0.16]], vol_target: 0.15 });
  assert('socp weights 3', socp.weights.length === 3);
  const psd = projectOntoPSDCone([[1, 0], [0, -1]]);
  assert('PSD projection diag positive', psd[1][1] > 0);
  const dual = dualGapQP({ P: [[2, 0], [0, 2]], q: [-1, -1], A: [[1, 1]], b: [1], x: [0.5, 0.5], lambda: [0] });
  assert('dual gap finite', Number.isFinite(dual.gap));
  const kkt = checkKKT({ P: [[2, 0], [0, 2]], q: [-1, -1], A: [[1, 1]], b: [1], x: [0.5, 0.5], lambda: [1] });
  assert('KKT check returns', typeof kkt.satisfied === 'boolean');
}

// ============================================================
// Sprint 17 — Harris Full
// ============================================================
console.log('\n## Sprint 17: Harris Trading & Exchanges Full');
{
  const fp = estimateFillProbability({
    order: { type: 'market', side: 'BUY', qty: 100 },
    current_bid: 9.99, current_ask: 10.01, expected_vol_per_bucket: 0.01,
  });
  close('market order fill prob = 1', fp, 1);
  const auction = callAuctionClearing({
    buy_orders: [{ price: 10.5, qty: 100 }, { price: 10.0, qty: 200 }],
    sell_orders: [{ price: 9.5, qty: 150 }, { price: 10.0, qty: 100 }],
    reference_price: 10,
  });
  assert('auction matched > 0', auction.matched_qty > 0);
  const straddle = straddlePayoff({ spot_at_expiry: 110, strike: 100, call_premium: 5, put_premium: 5 });
  assert('straddle gross = 10', straddle.gross_payoff === 10);
  assert('straddle net = 0', Math.abs(straddle.net_pnl - 0) < 1e-6);
  const vs = varianceSwapFairStrike([0.01, -0.02, 0.015, -0.01]);
  assert('var swap fair > 0', vs > 0);
  close('GM spread', glostenMilgromSpread({ informed_trader_prob: 0.2, asymmetric_info_payoff: 1 }), 0.4);
  close('PIN', probabilityOfInformedTrading({ alpha: 0.4, mu_informed: 100, epsilon_uninformed: 50 }), 0.4 * 100 / (0.4 * 100 + 100));
  const dealer = dealerProfitPerRoundTrip({ spread: 0.01, volume_per_round_trip: 1000, informed_trader_prob: 0.1, avg_price_drift_post_fill: 0.005 });
  assert('dealer profit finite', Number.isFinite(dealer.net_profit));
  const lc = liquidityDemanderCost({ half_spread_bps: 5, impact_bps: 10, commission_bps: 3 });
  close('demander total = 18', lc.total_bps, 18);
}

// ============================================================
// Sprint 18 — Production Bridges
// ============================================================
console.log('\n## Sprint 18: Production Bridges');
{
  const bridge = new MockBrokerBridge();
  bridge.placeOrder({ symbol: 'TEST', side: 'BUY', qty: 100, price: 10, type: 'market' }).then(r => {
    assert('mock order_id', r.order_id.includes('mock_'));
  });
  // Test overnight handler
  processOvernightSignals({
    signals: [{ id: 1, symbol: 'sh.600000', side: 'BUY', target_pct: 5, target_price: 10 }],
    current_capital: 1000000,
    reference_prices: { 'sh.600000': 10 },
    broker: bridge,
  }).then(r => {
    assert('overnight submitted ≥ 0', r.submitted_orders >= 0);
  });

  // HMM persistence (tmp file)
  const tmp_hmm = persistHMMParams('TEST_SYMBOL', {
    K: 2, pi: [0.5, 0.5], A: [[0.9, 0.1], [0.1, 0.9]], mu: [0, 1], sigma: [0.1, 0.1],
  }, ['bear', 'bull']);
  assert('HMM persist returns bool', typeof tmp_hmm === 'boolean');
  const loaded = loadHMMParams('TEST_SYMBOL');
  assert('HMM load roundtrip', loaded !== null);

  // Thompson posteriors persistence
  persistThompsonPosteriors({ s1: { strategy_key: 's1', n_obs: 0, observed_mean: 0, observed_sum_sq_dev: 0, prior_mu: 0, prior_var: 1, obs_var: 0.5, posterior_mu: 0, posterior_var: 1 } });
  const ts_loaded = loadThompsonPosteriors();
  assert('TS posteriors roundtrip', Object.keys(ts_loaded).length >= 1);

  // MetaLabel checkpoint
  const dummy_model: any = {
    version: 'test_v1', trained_at: new Date().toISOString(), trained_samples: 100,
    feature_means: {}, feature_stds: {}, weights: {}, bias: 0, insample_accuracy: 0.7, baseline_accuracy: 0.5,
  };
  const ok = persistMetaLabelCheckpoint('test_v1', dummy_model);
  assert('MetaLabel persist boolean', typeof ok === 'boolean');
}

// ============================================================
console.log(`\n========================================`);
console.log(`Sprint 7-18 联合测试: ${passed} pass / ${failed} fail`);
console.log(`========================================`);
process.exit(failed > 0 ? 1 : 0);
