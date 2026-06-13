/**
 * Ilmanen Expected Returns + Qian/Hua/Sorensen QEPM
 *
 * 书 reference:
 *   Ilmanen, A. (2011). *Expected Returns: An Investor's Guide to Harvesting
 *   Market Rewards.* Wiley.
 *
 *   Qian, E., Hua, R., Sorensen, E. (2007). *Quantitative Equity Portfolio
 *   Management: Modern Techniques and Applications.* Chapman & Hall.
 *
 * **Ilmanen Risk Premia 5 大类**:
 *
 *   1. **Equity Risk Premium (ERP)**:
 *      ERP = E[r_equity] - r_f
 *      Cyclical: high in crisis recovery, low in boom
 *
 *   2. **Term Premium**:
 *      Premium for holding long-duration bonds vs rolling short
 *      term_premium ≈ 10y_yield - avg(short_rate forecast)
 *
 *   3. **Volatility Risk Premium (VRP)**:
 *      VRP = implied_vol - realized_vol
 *      Average +2-4% pa, captured by selling volatility
 *
 *   4. **Liquidity Premium (Amihud 2002)**:
 *      Premium for holding illiquid assets
 *      illiquidity = avg(|return| / dollar_volume)
 *
 *   5. **Currency Carry Premium**:
 *      Long high-yield currencies, short low-yield
 *      Profitable but tail risk in crises
 *
 * **QEPM Information Ratio Decomposition (Section 4)**:
 *
 *   IR = IC × √Breadth (Grinold-Kahn, 已 v4 实现)
 *
 *   Extended: IR = TC × IC × √Breadth (Clarke-DeSilva-Thorley)
 *
 *   QEPM 进一步分解:
 *     - Active risk = Σ_i σ_i² × active_weight_i²
 *     - Style risk vs Stock-specific risk
 *     - Industry concentration risk
 *
 * **QEPM Style Integration (Section 6)**:
 *
 *   多 style factor 综合:
 *     combined_score = Σ_k w_k × style_score_k
 *
 *   Style timing: w_k 不是固定, 用 macro signal 动态调整.
 */

// ============================================================
// Ilmanen Risk Premia
// ============================================================

/**
 * Equity Risk Premium (cyclical estimation).
 *
 * 简化版: ERP = E/P (current) - r_f (Gordon model)
 *
 * 更复杂版用 dividend discount model + growth assumption.
 */
export function equityRiskPremium(input: {
  earnings_yield: number; // E/P of broad market
  risk_free_rate: number; // 10y treasury
}): number {
  return input.earnings_yield - input.risk_free_rate;
}

/**
 * Term Premium (Cieslak-Povala 2015 simplification).
 *
 *   term_premium ≈ long_yield - short_yield_avg_forecast
 *
 * Quick proxy: term spread = 10y - 2y treasury.
 */
export function termPremium(yield_10y: number, yield_2y: number): number {
  return yield_10y - yield_2y;
}

/**
 * Volatility Risk Premium.
 *
 *   VRP = implied_vol - realized_vol
 *
 *   Historical average ≈ 2-4% pa (Bekaert-Hoerova 2014).
 */
export function volatilityRiskPremium(implied_vol_annual: number, realized_vol_annual: number): number {
  return implied_vol_annual - realized_vol_annual;
}

/**
 * Amihud Illiquidity Measure (Amihud 2002).
 *
 *   ILLIQ_t = (1/N_t) Σ |r_t| / V_t
 *
 *   Higher → more illiquid → expect higher return premium.
 */
export function amihudIlliquidity(returns: number[], dollar_volumes: number[]): number {
  if (returns.length !== dollar_volumes.length) throw new Error('length mismatch');
  let sum = 0;
  let count = 0;
  for (let i = 0; i < returns.length; i += 1) {
    if (Number.isFinite(returns[i]) && Number.isFinite(dollar_volumes[i]) && dollar_volumes[i] > 0) {
      sum += Math.abs(returns[i]) / dollar_volumes[i];
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Currency Carry premium proxy.
 *
 *   carry = (yield_high_currency - yield_low_currency) × position_size
 *
 * Note: 实际 carry profit 受 exchange rate movement 影响.
 */
export function currencyCarryPremium(yield_long: number, yield_short: number): number {
  return yield_long - yield_short;
}

/**
 * Time-varying risk premia (Ilmanen Section 7).
 *
 *   Premia 与 macro state 相关:
 *     - 通胀高 → bond premium 高 (compensation for inflation risk)
 *     - 信用利差宽 → ERP 高 (recession risk premium)
 *     - VIX 高 → VRP 短期下降 (vol crush already happened)
 */
export function macroAdjustedPremium(input: {
  base_premium: number;
  inflation_rate: number;  // YoY %
  credit_spread: number;    // BBB - 10y treasury (bps)
  vix_level: number;
}): {
  adjusted_premium: number;
  inflation_adjustment: number;
  credit_adjustment: number;
  vix_adjustment: number;
} {
  // 经验 multipliers (Ilmanen 报告)
  const infl_adj = input.inflation_rate * 0.3;  // 1% 通胀 → +0.3% premium
  const credit_adj = (input.credit_spread / 100) * 0.5; // 100bp spread → +0.5% premium
  const vix_adj = (input.vix_level - 20) * -0.05; // VIX > 20 → 已扣过 → negative adj

  return {
    adjusted_premium: input.base_premium + infl_adj + credit_adj + vix_adj,
    inflation_adjustment: infl_adj,
    credit_adjustment: credit_adj,
    vix_adjustment: vix_adj,
  };
}

// ============================================================
// QEPM IR Decomposition + Style Integration
// ============================================================

/**
 * Decompose Information Ratio by source.
 *
 *   Total Variance = Style Risk + Stock-specific Risk + Industry Risk
 *
 *   IR_style = IC_style × √Breadth_style
 *   IR_stock = IC_stock × √Breadth_stock
 *
 *   Combined IR² = IR_style² + IR_stock² (orthogonal sources)
 */
export function qepmIRDecomposition(input: {
  ic_style: number;
  ic_stock_specific: number;
  ic_industry: number;
  breadth: number;
  transfer_coefficient: number;
}): {
  ir_style: number;
  ir_stock: number;
  ir_industry: number;
  total_ir: number;
} {
  const sqrtBreadth = Math.sqrt(input.breadth);
  const tc = input.transfer_coefficient;
  const ir_style = tc * input.ic_style * sqrtBreadth;
  const ir_stock = tc * input.ic_stock_specific * sqrtBreadth;
  const ir_industry = tc * input.ic_industry * sqrtBreadth;
  const total_ir = Math.sqrt(ir_style ** 2 + ir_stock ** 2 + ir_industry ** 2);
  return { ir_style, ir_stock, ir_industry, total_ir };
}

/**
 * Style Integration: combine multiple style scores with dynamic weights.
 *
 *   combined_score = Σ_k w_k(t) × style_score_k
 *
 *   weights w_k(t) can be:
 *     - Equal: 1/K
 *     - IC-weighted: w_k ∝ IC_k (past 12m)
 *     - Macro-conditional: w_k high when macro favors style k
 *
 * @param style_scores per-stock score for each style
 * @param style_weights weight for each style (must sum to 1)
 */
export function styleIntegration(
  style_scores: number[][], // K styles × N stocks
  style_weights: number[]
): number[] {
  const K = style_scores.length;
  const N = style_scores[0]?.length ?? 0;
  if (style_weights.length !== K) throw new Error('K mismatch');
  const out: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i += 1) {
    let s = 0;
    for (let k = 0; k < K; k += 1) s += style_weights[k] * style_scores[k][i];
    out[i] = s;
  }
  return out;
}

/**
 * Macro-conditional style weights.
 *
 *   - Bull market: momentum + growth overweight
 *   - Bear market: value + low-vol overweight
 *   - High inflation: commodity + value overweight
 *   - Low rates: growth + duration-sensitive overweight
 *
 * @param style_names ordered: [value, growth, momentum, low_vol, quality, size]
 * @param regime current regime
 * @returns weights matching style_names
 */
export function macroStyleWeights(
  style_names: string[],
  regime: 'bull' | 'bear' | 'range' | 'volatile' | 'inflation'
): number[] {
  const regimeProfiles: Record<string, Record<string, number>> = {
    bull: { value: 0.10, growth: 0.30, momentum: 0.25, low_vol: 0.05, quality: 0.15, size: 0.15 },
    bear: { value: 0.30, growth: 0.05, momentum: 0.05, low_vol: 0.30, quality: 0.20, size: 0.10 },
    range: { value: 0.20, growth: 0.15, momentum: 0.15, low_vol: 0.15, quality: 0.20, size: 0.15 },
    volatile: { value: 0.15, growth: 0.10, momentum: 0.05, low_vol: 0.35, quality: 0.25, size: 0.10 },
    inflation: { value: 0.35, growth: 0.05, momentum: 0.15, low_vol: 0.15, quality: 0.20, size: 0.10 },
  };
  const profile = regimeProfiles[regime] || regimeProfiles.range;
  return style_names.map(name => profile[name] ?? 0);
}

/**
 * Active Risk decomposition (QEPM Section 5).
 *
 *   Active Risk² = Factor Risk + Specific Risk
 *
 *   Factor Risk = Σ_k Σ_j active_exposure_k × cov_kj × active_exposure_j
 *   Specific Risk = Σ_i active_weight_i² × σ_i²_specific
 */
export function activeRiskDecomposition(input: {
  active_factor_exposures: number[]; // K factors
  factor_cov_matrix: number[][]; // K × K
  active_weights: number[]; // N stocks (active = portfolio - benchmark)
  specific_variances: number[]; // N stocks (idiosyncratic variance)
}): {
  factor_risk: number;
  specific_risk: number;
  total_active_risk: number;
} {
  const K = input.active_factor_exposures.length;
  const N = input.active_weights.length;

  // Factor risk
  let factor_var = 0;
  for (let k = 0; k < K; k += 1) {
    for (let j = 0; j < K; j += 1) {
      factor_var += input.active_factor_exposures[k] * input.factor_cov_matrix[k][j] * input.active_factor_exposures[j];
    }
  }
  const factor_risk = Math.sqrt(Math.max(0, factor_var));

  // Specific risk
  let specific_var = 0;
  for (let i = 0; i < N; i += 1) {
    specific_var += input.active_weights[i] ** 2 * input.specific_variances[i];
  }
  const specific_risk = Math.sqrt(Math.max(0, specific_var));

  const total_active_risk = Math.sqrt(factor_var + specific_var);

  return { factor_risk, specific_risk, total_active_risk };
}

/**
 * Multi-factor risk model construction (QEPM Section 5).
 *
 *   For each stock i: return = α_i + Σ_k β_ik × factor_k + ε_i
 *
 *   Output: factor exposures β_ik (N × K matrix).
 *
 *   Use OLS per stock (we already have famaFrenchRegression).
 */
export function multiFactorRiskModel(input: {
  stock_returns: number[][]; // N × T
  factor_returns: number[][]; // K × T
}): {
  exposures: number[][]; // N × K
  alphas: number[];
  specific_variances: number[];
} {
  const N = input.stock_returns.length;
  const K = input.factor_returns.length;
  const T = input.stock_returns[0]?.length ?? 0;
  const exposures: number[][] = Array.from({ length: N }, () => new Array(K).fill(0));
  const alphas: number[] = new Array(N).fill(0);
  const specific_vars: number[] = new Array(N).fill(0);

  // For each stock, OLS regression on K factors
  for (let i = 0; i < N; i += 1) {
    // Build feature matrix X (T × K+1)
    // Solve via normal equation
    const dim = K + 1;
    const XtX: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
    const Xty: number[] = new Array(dim).fill(0);
    for (let t = 0; t < T; t += 1) {
      const row = [1, ...input.factor_returns.map(f => f[t])];
      const y = input.stock_returns[i][t];
      if (!Number.isFinite(y) || row.some(v => !Number.isFinite(v))) continue;
      for (let a = 0; a < dim; a += 1) {
        Xty[a] += row[a] * y;
        for (let b = 0; b < dim; b += 1) XtX[a][b] += row[a] * row[b];
      }
    }
    // Gauss-Jordan
    const aug = XtX.map((r, idx) => [...r, Xty[idx]]);
    let singular = false;
    for (let idx = 0; idx < dim; idx += 1) {
      let piv = idx;
      for (let r = idx + 1; r < dim; r += 1) if (Math.abs(aug[r][idx]) > Math.abs(aug[piv][idx])) piv = r;
      if (Math.abs(aug[piv][idx]) < 1e-12) { singular = true; break; }
      if (piv !== idx) [aug[idx], aug[piv]] = [aug[piv], aug[idx]];
      const d = aug[idx][idx];
      for (let j = 0; j <= dim; j += 1) aug[idx][j] /= d;
      for (let r = 0; r < dim; r += 1) {
        if (r === idx) continue;
        const f = aug[r][idx];
        for (let j = 0; j <= dim; j += 1) aug[r][j] -= f * aug[idx][j];
      }
    }
    if (singular) continue;
    const beta = aug.map(row => row[dim]);
    alphas[i] = beta[0];
    for (let k = 0; k < K; k += 1) exposures[i][k] = beta[k + 1];

    // Specific variance = var(residuals)
    let ss = 0;
    let count = 0;
    for (let t = 0; t < T; t += 1) {
      const y = input.stock_returns[i][t];
      let pred = alphas[i];
      for (let k = 0; k < K; k += 1) pred += beta[k + 1] * input.factor_returns[k][t];
      if (Number.isFinite(y - pred)) {
        ss += (y - pred) ** 2;
        count += 1;
      }
    }
    specific_vars[i] = count > 1 ? ss / (count - 1) : 0;
  }

  return { exposures, alphas, specific_variances: specific_vars };
}
