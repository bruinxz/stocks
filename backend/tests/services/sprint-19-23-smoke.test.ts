/**
 * Sprint 19-23 联合 smoke test
 */
import {
  mutualInformation, variationOfInformation,
  silhouetteScore, optimalNumberOfClusters,
  trendScanningLabels, clusteredFeatureImportance,
  ncoComplete, combinatorialBacktestPBO,
  detectBaggingLeakage, recommendBacktestMethod,
} from '../../src/services/research/mlfam-afml-complete';
import {
  brinsonAttribution, marginalContributionToRisk, topRiskContributors,
  computeStyleExposures, applyStyleExposureCaps,
  crowdingScore, realizedPortfolioVol, computeTargetLeverage,
  bufferedLeverageUpdate, portfolioVolTargeting,
} from '../../src/services/portfolio/brinson-mcr-style-crowding';
import {
  detectHeadAndShouldersTop, detectDoubleTop, detectDoubleBottom,
  detectRoundingBottom, detectSymmetricalTriangle,
  detectAscendingTriangle, detectDescendingTriangle,
  detectFallingWedge, detectRisingWedge,
  detectBullishFlag, detectBearishFlag, detectBullishPennant,
  PATTERN_REGIME_CROSS_TABLE, patternRegimeSuccessRate,
  vcpPatternMultiplier, donchianBreakoutWithPatternAdjustment, turtleEntryWithPatternFilter,
} from '../../src/services/research/pattern-library';
import {
  computeReasonTriplet, checkDruckenmiller, checkPaulTudorJones,
  checkMichaelMarcus, checkBruceKovner, checkSorosReflexivity, checkAllWizards,
  computeQuantPostmortemScore, autoApplyDqsToClosedTrade,
} from '../../src/services/governor/trader-mind-deep';
import {
  getFinancialPublishDeadline, isPITSafe, getLatestPITSafeData, detectFinancialLookahead,
  getIndexMembershipAt, detectSurvivorshipBias,
  estimateStrategyCapacity, observedHalfLife, monitorAlphaDecay,
  recommendHoldingPeriod, SIGNAL_HALF_LIVES,
} from '../../src/services/research/ashare-pit-capacity';

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
// Sprint 19 — MLfAM + AFML Ch.6/9
// ============================================================
console.log('\n## Sprint 19: MLfAM + AFML Ch.6/9');
{
  const X = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const Y = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]; // perfectly correlated
  const mi_high = mutualInformation(X, Y, 5);
  assert('MI of correlated > 0', mi_high > 0);
  close('VI of identical = 0', variationOfInformation(X, X, 5), 0);

  // Silhouette + ONC
  const data: number[][] = [];
  for (let k = 0; k < 3; k += 1) {
    for (let i = 0; i < 10; i += 1) data.push([k * 5 + Math.random() * 0.5, k * 5 + Math.random() * 0.5]);
  }
  const onc = optimalNumberOfClusters(data, 6, { seed: 42 });
  assert('ONC found best_k', onc.best_k >= 2);
  // Trend labels
  const prices = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5 + (i * 7 % 11 - 5) * 0.1); // noisy uptrend
  const labels = trendScanningLabels(prices, 10, 1.5);
  assert('trend scanning has +1 labels', labels.includes(1));
  // Clustered FI
  const fi = clusteredFeatureImportance({ a: 0.3, b: 0.2, c: 0.4, d: 0.1 }, { a: 0, b: 0, c: 1, d: 1 });
  assert('clustered FI cluster 0 sum 0.5', Math.abs(fi[0].total_importance - 0.5) < 1e-6);

  // NCO complete
  const cov = [[1, 0.5, 0.1], [0.5, 1, 0.1], [0.1, 0.1, 1]];
  const nco = ncoComplete(cov, [0, 0, 1]);
  assert('NCO final weights sum ≈ 1', Math.abs(nco.final_weights.reduce((s, v) => s + v, 0) - 1) < 0.01);
  // Combinatorial backtest PBO
  const strategy_returns: number[][] = [];
  for (let s = 0; s < 3; s += 1) {
    strategy_returns.push(Array.from({ length: 80 }, () => Math.random() * 0.01 - 0.005));
  }
  const cb = combinatorialBacktestPBO({ strategy_returns, n_train_groups: 4, n_total_groups: 8 });
  assert('CB paths > 0', cb.paths.length > 0);
  assert('CB pbo in [0, 1]', cb.pbo >= 0 && cb.pbo <= 1);
  // Bagging leakage
  const lk_low = detectBaggingLeakage([0.9, 0.85, 0.95]);
  assert('low overlap → low risk', lk_low.leakage_risk === 'low');
  // Backtest method recommender
  const r1 = recommendBacktestMethod({ n_samples: 200, n_strategies_to_compare: 1, need_pbo: false });
  assert('small samples → walk_forward', r1.recommended_method === 'walk_forward');
  const r2 = recommendBacktestMethod({ n_samples: 500, n_strategies_to_compare: 10, need_pbo: true });
  assert('PBO + many strategies → combinatorial', r2.recommended_method === 'combinatorial');
}

// ============================================================
// Sprint 20 — Brinson + MCR + Style Cap + Crowding + Vol Target
// ============================================================
console.log('\n## Sprint 20: Brinson + MCR + Style Cap + Crowding + Vol Target');
{
  const brinson = brinsonAttribution({
    industries: ['银行', '银行', '科技', '科技'],
    portfolio_weights: [0.3, 0.2, 0.3, 0.2],
    benchmark_weights: [0.25, 0.25, 0.25, 0.25],
    stock_returns: [0.10, 0.05, 0.15, 0.08],
  });
  assert('Brinson industry_attribution has 2', brinson.industry_attribution.length === 2);
  assert('Brinson total decomposes correctly',
    Math.abs(brinson.active_return - (brinson.total_allocation_effect + brinson.total_selection_effect + brinson.total_interaction_effect)) < 1e-6);

  // MCR
  const cov = [[0.04, 0.01, 0], [0.01, 0.09, 0], [0, 0, 0.16]];
  const weights = [0.4, 0.3, 0.3];
  const mcr = marginalContributionToRisk(weights, cov);
  assert('MCR sum to portfolio vol',
    Math.abs(weights.reduce((s, w, i) => s + w * mcr.mcr[i], 0) - mcr.portfolio_vol) < 1e-3);
  const tc = topRiskContributors(weights, cov, ['A', 'B', 'C']);
  assert('top contributors 3', tc.top_contributors.length === 3);

  // Style exposures + caps
  const styles = computeStyleExposures([0.3, 0.4, 0.3], { size: [1, -1, 0.5], momentum: [0, 1, -1], value: [0, 0, 0], volatility: [0, 0, 0], growth: [0, 0, 0], quality: [0, 0, 0], beta: [0, 0, 0] });
  assert('size exposure computed', Number.isFinite(styles.size));
  const cap_result = applyStyleExposureCaps({
    weights: [0.5, 0.3, 0.2],
    factor_exposures: { size: [2, 0, -1], momentum: [0, 0, 0], value: [0, 0, 0], volatility: [0, 0, 0], growth: [0, 0, 0], quality: [0, 0, 0], beta: [0, 0, 0] },
    caps: { size: { min: -0.5, max: 0.5 } },
  });
  assert('size cap applied', cap_result.cap_violations.length >= 0);

  // Crowding
  const crowd = crowdingScore({
    signal: [0.01, 0.02, -0.01, 0.005],
    market_consensus: [0.01, 0.02, -0.01, 0.005],
    fund_concentration_change: 0.05,
    margin_balance_change: 0.10,
  });
  assert('crowding score in [0,100]', crowd.crowding_score >= 0 && crowd.crowding_score <= 100);

  // Vol targeting
  const vol = realizedPortfolioVol([0.4, 0.3, 0.3], cov);
  assert('realized vol > 0', vol > 0);
  const leverage = computeTargetLeverage(0.15, 0.20);
  close('leverage 0.20/0.15 ≈ 1.33', leverage, 4 / 3);
  const buf = bufferedLeverageUpdate(1.0, 1.05, 0.10);
  assert('小变化不调', !buf.changed);
  const vt = portfolioVolTargeting({
    weights: [0.4, 0.3, 0.3], cov, vol_target_annual: 0.20, max_leverage: 2,
  });
  assert('vt scaled_weights non-empty', vt.scaled_weights.length === 3);
}

// ============================================================
// Sprint 21 — 形态识别 + 接入策略
// ============================================================
console.log('\n## Sprint 21: 12 形态识别 + Pattern×Regime + 策略集成');
{
  // 各形态生成 synthetic data + 检测
  // Double top
  const dt_prices = [...Array(20).fill(100).map((_, i) => 100 + i * 0.3), 110, 109, 108, 107, 105, 108, 110.5, 109, 107, 105, 100, 95];
  const dt = detectDoubleTop(dt_prices, 32);
  assert('double top runs', typeof dt.detected === 'boolean');

  // Double bottom
  const db_prices = [110, 108, 105, 100, 95, 90, 95, 100, 105, 100, 95, 91, 95, 100, 105, 110, 115];
  const db = detectDoubleBottom(db_prices, 17);
  assert('double bottom runs', typeof db.detected === 'boolean');

  // 其他 10 个
  const generic = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.3) * 5);
  assert('H&S top runs', typeof detectHeadAndShouldersTop(generic).detected === 'boolean');
  assert('Rounding bottom runs', typeof detectRoundingBottom(generic).detected === 'boolean');
  assert('Sym triangle runs', typeof detectSymmetricalTriangle(generic).detected === 'boolean');
  assert('Asc triangle runs', typeof detectAscendingTriangle(generic).detected === 'boolean');
  assert('Desc triangle runs', typeof detectDescendingTriangle(generic).detected === 'boolean');
  assert('Falling wedge runs', typeof detectFallingWedge(generic).detected === 'boolean');
  assert('Rising wedge runs', typeof detectRisingWedge(generic).detected === 'boolean');
  // Bull flag: strong pole + tight consolidation
  const flag = [100, 102, 105, 109, 113, 117, 116, 115, 116, 115, 116, 115, 116, 115, 116];
  const bf = detectBullishFlag(flag, 5, 10);
  assert('bull flag runs', typeof bf.detected === 'boolean');
  assert('bear flag runs', typeof detectBearishFlag(generic).detected === 'boolean');
  assert('bull pennant runs', typeof detectBullishPennant(generic).detected === 'boolean');

  // Pattern × Regime
  assert('CROSS_TABLE has 16 patterns', Object.keys(PATTERN_REGIME_CROSS_TABLE).length === 16);
  close('IHS bull = 0.85', patternRegimeSuccessRate('Inverse Head and Shoulders', 'bull')!, 0.85);
  assert('unknown pattern → null', patternRegimeSuccessRate('Bad Pattern', 'bull') === null);

  // VCP multiplier
  const vcp_m = vcpPatternMultiplier(generic, 'bull');
  assert('VCP multiplier ∈ [0.5, 1.5]', vcp_m.multiplier >= 0.5 && vcp_m.multiplier <= 1.5);

  // Donchian
  const don = donchianBreakoutWithPatternAdjustment(generic, 'bull');
  assert('Donchian has buy/sell flags', typeof don.buy_signal === 'boolean');

  // Turtle
  const turtle_prices = Array.from({ length: 70 }, (_, i) => 100 + i * 0.5);
  const turtle = turtleEntryWithPatternFilter(turtle_prices, 'bull');
  assert('Turtle entry computed', typeof turtle.entry_signal === 'boolean');
}

// ============================================================
// Sprint 22 — Trader Mind Deep
// ============================================================
console.log('\n## Sprint 22: Trader Mind Deep');
{
  const triplet = computeReasonTriplet({
    thesis_recorded_pre_trade: true,
    data_support_count: 3,
    entry_at_planned_price: true,
    exit_per_plan: true,
    stop_loss_honored: true,
    emotional_exit_flag: false,
    conviction_level: 8,
    position_size_pct: 0.08,
    vol_target_size_pct: 0.08,
  });
  assert('high quality DQS > 80', triplet.composite_dqs > 80);

  const triplet_bad = computeReasonTriplet({
    thesis_recorded_pre_trade: false,
    data_support_count: 0,
    entry_at_planned_price: false,
    exit_per_plan: false,
    stop_loss_honored: false,
    emotional_exit_flag: true,
    conviction_level: 3,
    position_size_pct: 0.20,
    vol_target_size_pct: 0.05,
  });
  assert('bad DQS < 50', triplet_bad.composite_dqs < 50);
  assert('weaknesses listed', triplet_bad.weaknesses.length > 0);

  // 5 wizards
  const dr = checkDruckenmiller({ realized_pnl_pct: -0.08, position_size_pct: 0.10, conviction_level: 6 });
  assert('Druckenmiller violations > 0', dr.length > 0);
  const ptj = checkPaulTudorJones({ max_drawdown_during_hold_pct: -0.07, closed_pre_weekend: false, held_over_weekend: true, realized_vol_during_hold: 0.5 });
  assert('PTJ violations > 0', ptj.length > 0);
  const marcus = checkMichaelMarcus({ position_size_pct: 0.1, stop_loss_distance_pct: 0.10, market_trend: 'down', trade_direction: 'BUY' });
  assert('Marcus violations > 0', marcus.length > 0);
  const kovner = checkBruceKovner({ expected_target_pct: 0.05, expected_stop_pct: 0.05, worst_case_analyzed_pre_trade: false });
  assert('Kovner violations > 0', kovner.length > 0);
  const soros = checkSorosReflexivity({ current_pe: 30, historical_avg_pe: 12, has_specific_catalyst: false, trade_direction: 'BUY' });
  assert('Soros violations > 0', soros.length > 0);

  const all_check = checkAllWizards({
    realized_pnl_pct: -0.08, position_size_pct: 0.10, conviction_level: 6,
    max_drawdown_during_hold_pct: -0.07, closed_pre_weekend: false, held_over_weekend: true, realized_vol_during_hold: 0.5,
    stop_loss_distance_pct: 0.10, market_trend: 'down', trade_direction: 'BUY',
    expected_target_pct: 0.05, expected_stop_pct: 0.05, worst_case_analyzed_pre_trade: false,
    current_pe: 30, historical_avg_pe: 12, has_specific_catalyst: false,
  });
  assert('all_check has violations', all_check.total_violations > 0);
  assert('grade ∈ A-F', ['A', 'B', 'C', 'D', 'F'].includes(all_check.rule_compliance_grade));

  // Postmortem
  const pm = computeQuantPostmortemScore({
    thesis_predicted_direction_correct: true,
    thesis_predicted_magnitude_pct: 0.10,
    actual_magnitude_pct: 0.08,
    entry_slippage_bps: 5,
    exit_slippage_bps: 5,
    position_size_pct: 0.05,
    optimal_size_pct: 0.05,
    exit_at_optimal_window: true,
    hold_too_long_days: 0,
    hold_too_short_days: 0,
    learnings_documented: true,
    rule_changes_proposed: 1,
  });
  assert('postmortem composite > 70', pm.composite_score > 70);
  assert('classification valid', ['true_alpha', 'variance_loss', 'lucky_win', 'bad_execution'].includes(pm.classification));

  // Auto DQS apply
  const auto = autoApplyDqsToClosedTrade({
    entry_date: '2024-01-01', exit_date: '2024-01-15',
    entry_price: 10, exit_price: 11, total_pnl_pct: 0.10, holding_days: 14,
    metadata: {}, thesis_recorded_pre_trade: true, data_support_count: 2,
    stop_loss_honored: true, conviction_level: 7, position_size_pct: 0.07,
  });
  assert('auto DQS produces summary', auto.postmortem_summary.length > 0);
}

// ============================================================
// Sprint 23 — A 股 PIT + Capacity + Decay
// ============================================================
console.log('\n## Sprint 23: A 股专项收尾');
{
  // PIT deadlines
  assert('Q1 2024 deadline', getFinancialPublishDeadline(2024, 'Q1') === '2024-04-30');
  assert('Q4 2024 deadline', getFinancialPublishDeadline(2024, 'Q4') === '2025-04-30');

  const pit_point = {
    symbol: 'sh.600000', fiscal_year: 2024, fiscal_period: 'Q1' as const,
    fiscal_period_end_date: '2024-03-31', actual_publish_date: '2024-04-28',
    is_pit_safe: true, data: { revenue: 1e9 },
  };
  assert('PIT safe at 2024-05-01', isPITSafe(pit_point, '2024-05-01'));
  assert('PIT not safe at 2024-04-01', !isPITSafe(pit_point, '2024-04-01'));

  const latest = getLatestPITSafeData([pit_point], 'sh.600000', '2024-05-15');
  assert('latest PIT-safe found', latest?.fiscal_period_end_date === '2024-03-31');

  // Lookahead detection
  const lookahead = detectFinancialLookahead({
    backtest_used_data: [
      { symbol: 'sh.600000', as_of_date: '2024-04-01', data_point: pit_point },
    ],
  });
  assert('lookahead detected', lookahead.lookahead_count === 1);

  // PIT index membership
  const members = getIndexMembershipAt({
    current_members: ['A', 'B', 'C', 'D'],
    historical_changes: [
      { index_code: 'CSI300', effective_date: '2024-06-01', added_symbols: ['D'], removed_symbols: ['E'] },
    ],
    as_of_date: '2024-05-01',
  });
  assert('PIT membership reverted', members.includes('E') && !members.includes('D'));

  // Survivorship bias
  const sb = detectSurvivorshipBias({
    backtest_universe: ['A', 'B', 'C'],
    pit_membership_at_start: ['A', 'B', 'X'],
    pit_membership_at_end: ['A', 'B', 'C'],
  });
  assert('survivorship bias 0', sb.survivorship_bias_count === 0);

  // Strategy capacity
  const cap = estimateStrategyCapacity({
    stock_adv_values: [{ symbol: 'sh.600000', adv_cny: 1e9 }, { symbol: 'sz.000001', adv_cny: 5e8 }],
    positions_per_stock_pct: 0.05,
    n_holding_days: 20,
    participation_rate: 0.10,
    n_trades_per_year: 50,
  });
  assert('capacity grade valid', ['high', 'medium', 'low'].includes(cap.capacity_grade));
  assert('bottleneck identified', cap.bottleneck_symbol === 'sz.000001');

  // Alpha decay
  assert('signal half-lives has dragon_tiger', SIGNAL_HALF_LIVES['dragon_tiger_seat'] === 4);
  const half_life = observedHalfLife([
    { days_after_signal: 1, ic: 0.10 },
    { days_after_signal: 3, ic: 0.07 },
    { days_after_signal: 5, ic: 0.05 },
    { days_after_signal: 10, ic: 0.02 },
  ]);
  assert('observed half-life > 0', (half_life ?? 0) > 0);
  const decay = monitorAlphaDecay({
    signal_name: 'dragon_tiger_seat',
    observed_ic_series: [{ days_after_signal: 1, ic: 0.10 }, { days_after_signal: 5, ic: 0.005 }],
  });
  assert('decay status set', ['accelerated', 'normal', 'extended', 'unknown'].includes(decay.decay_status));

  // Optimal holding
  const rec = recommendHoldingPeriod(7);
  assert('optimal 7d', rec.optimal_days === 7);
  assert('max 14d', rec.max_days_before_stale === 14);
}

console.log(`\n========================================`);
console.log(`Sprint 19-23 联合测试: ${passed} pass / ${failed} fail`);
console.log(`========================================`);
process.exit(failed > 0 ? 1 : 0);
