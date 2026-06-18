/**
 * Portfolio Advanced: Brinson Attribution + MCR + Style Cap + Crowding + Vol Targeting
 *
 * 论文 reference:
 *   Brinson, G., Hood, L., Beebower, G. (1986). "Determinants of Portfolio
 *   Performance." Financial Analysts Journal 42(4), 39-44.
 *
 *   Litterman, R. (1996). "Hot Spots and Hedges." Journal of Portfolio
 *   Management 22(special), 52-75. (MCR origin)
 *
 *   Patton, A. and Weller, B. (2020). "What you see is not what you get:
 *   The costs of trading market anomalies."
 *   Journal of Financial Economics 137, 515-549. (Crowding paper)
 *
 *   Black, F. and Treynor, J. (1973). "How to use security analysis to
 *   improve portfolio selection." Journal of Business 46(1), 66-86. (Vol targeting)
 *
 * **Brinson Attribution**:
 *
 *   Portfolio return decomposed into:
 *     - Allocation effect: 行业 weight vs benchmark weight (with benchmark returns)
 *     - Selection effect: stock pick within each industry
 *     - Interaction effect: cross-term
 *
 *     R_p - R_b = Σ (w_p_i - w_b_i)(R_b_i)         [allocation]
 *               + Σ (R_p_i - R_b_i)(w_b_i)         [selection]
 *               + Σ (w_p_i - w_b_i)(R_p_i - R_b_i) [interaction]
 *
 * **Marginal Contribution to Risk (MCR)**:
 *
 *   MCR_i = (Σ × w)_i / sqrt(w^T Σ w)
 *
 *   = ∂σ_portfolio / ∂w_i
 *
 *   Sum: Σ w_i × MCR_i = σ_portfolio
 *
 *   Sign: 正 MCR → 该股增加 portfolio risk;
 *         负 MCR → 该股 hedge / decrease risk.
 *
 * **Crowding Score (Patton-Weller 2020)**:
 *
 *   alpha 信号被多家 fund 追时:
 *     - 实际 P&L < paper P&L
 *     - 短期 → mean reversion (crowded trade unwind)
 *
 *   Crowding proxy: 信号 correlation with market consensus + Δ short interest + Δ fund holdings.
 *
 * **Portfolio-Level Vol Targeting**:
 *
 *   target_leverage = vol_target / realized_portfolio_vol
 *
 *   动态调整: 高 vol 时段 deleverage, 低 vol 时段 leverage up.
 *
 *   With buffer zone (Carver Ch.15): 只在 |leverage - prev_leverage| > buffer 时调整.
 */

// ============================================================
// Brinson Attribution
// ============================================================

export interface BrinsonInput {
  /** Industry / sector codes */
  industries: string[];
  /** Portfolio weights per stock */
  portfolio_weights: number[];
  /** Benchmark weights per stock */
  benchmark_weights: number[];
  /** Returns per stock */
  stock_returns: number[];
}

export interface BrinsonAttribution {
  total_portfolio_return: number;
  total_benchmark_return: number;
  active_return: number;
  /** Per-industry decomposition */
  industry_attribution: Array<{
    industry: string;
    allocation_effect: number;
    selection_effect: number;
    interaction_effect: number;
    total_effect: number;
  }>;
  /** Aggregate effects */
  total_allocation_effect: number;
  total_selection_effect: number;
  total_interaction_effect: number;
}

export function brinsonAttribution(input: BrinsonInput): BrinsonAttribution {
  const N = input.industries.length;
  if (
    input.portfolio_weights.length !== N ||
    input.benchmark_weights.length !== N ||
    input.stock_returns.length !== N
  ) {
    throw new Error('brinsonAttribution: length mismatch');
  }
  // Aggregate by industry
  const industryMap = new Map<
    string,
    {
      industry: string;
      p_weight: number;
      b_weight: number;
      p_value_weighted_return: number;
      b_value_weighted_return: number;
    }
  >();
  for (let i = 0; i < N; i += 1) {
    const ind = input.industries[i];
    if (!industryMap.has(ind)) {
      industryMap.set(ind, {
        industry: ind,
        p_weight: 0,
        b_weight: 0,
        p_value_weighted_return: 0,
        b_value_weighted_return: 0,
      });
    }
    const e = industryMap.get(ind)!;
    e.p_weight += input.portfolio_weights[i];
    e.b_weight += input.benchmark_weights[i];
    e.p_value_weighted_return += input.portfolio_weights[i] * input.stock_returns[i];
    e.b_value_weighted_return += input.benchmark_weights[i] * input.stock_returns[i];
  }

  let total_alloc = 0,
    total_select = 0,
    total_inter = 0;
  let total_p_return = 0,
    total_b_return = 0;
  const industry_attribution: BrinsonAttribution['industry_attribution'] = [];

  for (const e of industryMap.values()) {
    const r_p_i = e.p_weight > 0 ? e.p_value_weighted_return / e.p_weight : 0;
    const r_b_i = e.b_weight > 0 ? e.b_value_weighted_return / e.b_weight : 0;
    const allocation = (e.p_weight - e.b_weight) * r_b_i;
    const selection = e.b_weight * (r_p_i - r_b_i);
    const interaction = (e.p_weight - e.b_weight) * (r_p_i - r_b_i);
    const total = allocation + selection + interaction;

    industry_attribution.push({
      industry: e.industry,
      allocation_effect: allocation,
      selection_effect: selection,
      interaction_effect: interaction,
      total_effect: total,
    });
    total_alloc += allocation;
    total_select += selection;
    total_inter += interaction;
    total_p_return += e.p_value_weighted_return;
    total_b_return += e.b_value_weighted_return;
  }

  return {
    total_portfolio_return: total_p_return,
    total_benchmark_return: total_b_return,
    active_return: total_p_return - total_b_return,
    industry_attribution,
    total_allocation_effect: total_alloc,
    total_selection_effect: total_select,
    total_interaction_effect: total_inter,
  };
}

// ============================================================
// MCR (Marginal Contribution to Risk)
// ============================================================

/**
 * Marginal Contribution to Risk per asset.
 *
 *   MCR_i = (Σ × w)_i / σ_portfolio
 *
 *   Sum(w_i × MCR_i) = σ_portfolio
 *
 * @returns MCR vector + percent contributions
 */
export function marginalContributionToRisk(
  weights: number[],
  cov: number[][]
): {
  portfolio_vol: number;
  mcr: number[];
  pct_contribution: number[]; // per asset
} {
  const N = weights.length;
  if (cov.length !== N) throw new Error('MCR: cov size mismatch');
  // Σ × w
  const Sw: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) Sw[i] += cov[i][j] * weights[j];
  }
  // portfolio variance = w^T × Σ × w
  let port_var = 0;
  for (let i = 0; i < N; i += 1) port_var += weights[i] * Sw[i];
  const port_vol = Math.sqrt(Math.max(0, port_var));
  if (port_vol < 1e-12) {
    return { portfolio_vol: 0, mcr: new Array(N).fill(0), pct_contribution: new Array(N).fill(0) };
  }
  // MCR_i = Sw_i / port_vol
  const mcr = Sw.map(v => v / port_vol);
  // Contribution_i = w_i × MCR_i
  // Pct = contribution / port_vol
  const pct = weights.map((w, i) => (w * mcr[i]) / port_vol);
  return { portfolio_vol: port_vol, mcr, pct_contribution: pct };
}

/**
 * Identify top risk contributors (and hedgers).
 */
export function topRiskContributors(
  weights: number[],
  cov: number[][],
  symbols: string[],
  top_n = 5
): {
  top_contributors: Array<{ symbol: string; pct_contribution: number; mcr: number }>;
  top_hedgers: Array<{ symbol: string; pct_contribution: number; mcr: number }>;
} {
  const r = marginalContributionToRisk(weights, cov);
  const indexed = symbols.map((s, i) => ({
    symbol: s,
    pct_contribution: r.pct_contribution[i],
    mcr: r.mcr[i],
  }));
  const sorted_desc = [...indexed].sort((a, b) => b.pct_contribution - a.pct_contribution);
  const sorted_asc = [...indexed].sort((a, b) => a.pct_contribution - b.pct_contribution);
  return {
    top_contributors: sorted_desc.slice(0, top_n),
    top_hedgers: sorted_asc.slice(0, top_n),
  };
}

// ============================================================
// Style Exposure Cap
// ============================================================

export type StyleFactor =
  | 'size'
  | 'momentum'
  | 'value'
  | 'volatility'
  | 'growth'
  | 'quality'
  | 'beta';

/**
 * Compute portfolio's exposure to each style factor.
 *
 *   portfolio_factor_exposure = Σ w_i × factor_exposure_i
 *
 * @returns map style → exposure
 */
export function computeStyleExposures(
  weights: number[],
  factor_exposures: Record<StyleFactor, number[]>
): Record<StyleFactor, number> {
  const out: any = {};
  for (const [factor, exps] of Object.entries(factor_exposures)) {
    let s = 0;
    for (let i = 0; i < weights.length; i += 1) s += weights[i] * (exps as number[])[i];
    out[factor] = s;
  }
  return out;
}

/**
 * Cap style exposures to ranges and re-balance.
 *
 *   For each style with |exposure| > cap:
 *     - Reduce overweight stocks (high exposure to that style)
 *     - Or increase underweight stocks
 *
 * Simplified: scale down weights of stocks with extreme exposure.
 */
export function applyStyleExposureCaps(input: {
  weights: number[];
  factor_exposures: Record<StyleFactor, number[]>;
  caps: Partial<Record<StyleFactor, { min: number; max: number }>>;
}): {
  adjusted_weights: number[];
  original_exposures: Record<string, number>;
  adjusted_exposures: Record<string, number>;
  cap_violations: string[];
} {
  const original = computeStyleExposures(input.weights, input.factor_exposures);
  const adjusted = input.weights.slice();
  const violations: string[] = [];

  for (const [style, cap] of Object.entries(input.caps)) {
    const exp = original[style as StyleFactor];
    if (!cap || (exp >= cap.min && exp <= cap.max)) continue;
    violations.push(`${style}: ${exp.toFixed(3)} not in [${cap.min}, ${cap.max}]`);
    const factor_exp = input.factor_exposures[style as StyleFactor];
    // Identify extreme holders + scale down
    const sign = exp > cap.max ? -1 : 1;
    for (let i = 0; i < adjusted.length; i += 1) {
      // Scale proportional to |factor exposure|
      if (Math.sign(factor_exp[i]) === Math.sign(exp)) {
        const reduction = Math.abs(factor_exp[i]) * 0.05; // 5% scaling
        adjusted[i] *= 1 + sign * reduction;
      }
    }
  }
  // Renormalize
  const sum = adjusted.reduce((s, v) => s + v, 0);
  if (sum > 0) for (let i = 0; i < adjusted.length; i += 1) adjusted[i] /= sum;

  const final_exposures = computeStyleExposures(adjusted, input.factor_exposures);
  return {
    adjusted_weights: adjusted,
    original_exposures: original,
    adjusted_exposures: final_exposures,
    cap_violations: violations,
  };
}

// ============================================================
// Crowding Score
// ============================================================

/**
 * Crowding Score for a signal.
 *
 *   Components:
 *     - Consensus correlation: 信号与市场 consensus 的 correlation
 *     - Fund concentration: top fund holding 集中度变化
 *     - Short interest: 卖空 interest change (US-only proxy; A 股用融资融券)
 *
 *   High crowding → 短期 alpha 会快速 decay.
 */
export function crowdingScore(input: {
  signal: number[];
  market_consensus: number[]; // e.g. broad fund holding signal
  fund_concentration_change: number; // top 10 funds holding pct change
  margin_balance_change: number; // 融资余额变化 (A 股 proxy)
}): {
  consensus_correlation: number;
  crowding_score: number; // 0 = uncrowded, 100 = crowded
  decay_warning: string;
} {
  // Consensus correlation
  if (input.signal.length !== input.market_consensus.length || input.signal.length < 2) {
    return { consensus_correlation: 0, crowding_score: 0, decay_warning: '数据不足' };
  }
  const N = input.signal.length;
  const ms = input.signal.reduce((s, v) => s + v, 0) / N;
  const mc = input.market_consensus.reduce((s, v) => s + v, 0) / N;
  let num = 0,
    ds = 0,
    dc = 0;
  for (let i = 0; i < N; i += 1) {
    num += (input.signal[i] - ms) * (input.market_consensus[i] - mc);
    ds += (input.signal[i] - ms) ** 2;
    dc += (input.market_consensus[i] - mc) ** 2;
  }
  const corr = ds * dc > 0 ? num / Math.sqrt(ds * dc) : 0;

  // Crowding score 0-100
  const score = Math.max(
    0,
    Math.min(
      100,
      50 +
        Math.abs(corr) * 30 +
        input.fund_concentration_change * 100 +
        input.margin_balance_change * 50
    )
  );

  let warning: string;
  if (score > 75) warning = '🔴 高度拥挤 — alpha 半衰期可能 < 30 天';
  else if (score > 50) warning = '🟠 中度拥挤 — 关注 unwind';
  else if (score > 25) warning = '🟢 轻度拥挤 — 正常';
  else warning = '✅ 不拥挤 — 信号独特';

  return { consensus_correlation: corr, crowding_score: score, decay_warning: warning };
}

// ============================================================
// Portfolio-Level Volatility Targeting Service
// ============================================================

/**
 * Compute realized portfolio volatility.
 *
 *   σ_p² = w^T × Σ × w
 */
export function realizedPortfolioVol(weights: number[], cov: number[][]): number {
  const N = weights.length;
  let v = 0;
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) v += weights[i] * cov[i][j] * weights[j];
  }
  return Math.sqrt(Math.max(0, v));
}

/**
 * Compute target leverage to achieve vol_target.
 *
 *   target_leverage = vol_target / realized_vol
 *
 *   After leverage: σ_actual = leverage × σ_realized = vol_target
 */
export function computeTargetLeverage(realized_vol: number, vol_target: number): number {
  if (realized_vol < 1e-12) return 1;
  return vol_target / realized_vol;
}

/**
 * Apply leverage with buffer zone (Carver Ch.15).
 *
 *   if |new_leverage - prev_leverage| < buffer × prev → 不调整
 *   else → 调到 target ± buffer
 *
 * 减少换手频率.
 */
export function bufferedLeverageUpdate(
  current_leverage: number,
  target_leverage: number,
  buffer_pct = 0.1
): { new_leverage: number; changed: boolean } {
  const buffer = current_leverage * buffer_pct;
  const diff = target_leverage - current_leverage;
  if (Math.abs(diff) <= buffer) {
    return { new_leverage: current_leverage, changed: false };
  }
  if (diff > 0) {
    return { new_leverage: target_leverage - buffer, changed: true };
  } else {
    return { new_leverage: target_leverage + buffer, changed: true };
  }
}

/**
 * Service-level portfolio vol targeting.
 *
 *   Input: current portfolio weights + cov
 *   Output: scaled weights to hit vol_target + max_leverage cap
 */
export function portfolioVolTargeting(input: {
  weights: number[];
  cov: number[][];
  vol_target_annual: number;
  max_leverage: number;
  prev_leverage?: number;
  buffer_pct?: number;
}): {
  scaled_weights: number[];
  applied_leverage: number;
  realized_vol_before: number;
  realized_vol_after: number;
  leverage_changed: boolean;
} {
  const realized_vol = realizedPortfolioVol(input.weights, input.cov);
  const target = computeTargetLeverage(realized_vol, input.vol_target_annual);
  const capped = Math.min(input.max_leverage, target);

  let final_leverage = capped;
  let changed = true;
  if (input.prev_leverage !== undefined) {
    const buffered = bufferedLeverageUpdate(input.prev_leverage, capped, input.buffer_pct ?? 0.1);
    final_leverage = buffered.new_leverage;
    changed = buffered.changed;
  }

  const scaled = input.weights.map(w => w * final_leverage);
  const new_vol = realizedPortfolioVol(scaled, input.cov);

  return {
    scaled_weights: scaled,
    applied_leverage: final_leverage,
    realized_vol_before: realized_vol,
    realized_vol_after: new_vol,
    leverage_changed: changed,
  };
}
