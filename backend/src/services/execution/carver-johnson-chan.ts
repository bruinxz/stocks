/**
 * Carver Vol2 + Johnson DMA + Chan
 *
 * 书 reference:
 *   Carver, R. (2023). *Advanced Futures Trading Strategies.* Harriman House.
 *   (Vol2: multi-system combination, carry, FDM)
 *
 *   Johnson, B. (2010). *Algorithmic Trading and DMA: An introduction to
 *   direct access trading strategies.* 4Myeloma Press.
 *   (VWAP, TWAP, POV, dark pools, SOR)
 *
 *   Chan, E. (2008). *Quantitative Trading.* Wiley.
 *   Chan, E. (2013). *Algorithmic Trading: Winning Strategies and Their
 *   Rationale.* Wiley.
 *   (Mean reversion, pairs trading, co-integration)
 *
 * **Carver Vol2 multi-system**:
 *
 *   Combine K independent trading systems:
 *
 *     combined_signal = Σ_k w_k × system_k_forecast × FDM
 *
 *   FDM (Forecast Diversification Multiplier) = 1 / √(w^T ρ w)
 *   where ρ is correlation matrix between systems.
 *
 *   FDM compensates for the reduction in variance when combining correlated
 *   forecasts (vs independent).
 *
 * **Carry Strategy**:
 *
 *   Long high carry assets, short low carry assets.
 *
 *   Carry = (future return implied by static prices) — for futures:
 *     carry_n = (P_near - P_far) / P_far × (days_in_year / days_diff)
 *
 *   For stocks: carry ≈ dividend yield + buyback yield
 *
 * **VWAP/TWAP detailed (Johnson)**:
 *
 *   VWAP: Volume Weighted Average Price
 *     - Schedule: distribute order proportional to historical volume curve
 *     - Goal: minimize tracking error to day's VWAP
 *
 *   TWAP: Time Weighted Average Price
 *     - Schedule: equal slices over time
 *     - Goal: minimize impact, predictable benchmark
 *
 *   POV: Percent of Volume (≈ Carver bullet vs Almgren-Chriss linear schedule)
 *
 * **SOR (Smart Order Routing)**:
 *
 *   - Liquidity-seeking: probe multiple venues, find best fill
 *   - Cost-aware: account for venue fees / rebates
 *   - Anti-gaming: detect when liquidity is "wash" not real
 *
 * **Chan Pairs Trading (Co-integration)**:
 *
 *   1. Find stocks A, B with co-integrated relationship:
 *      A_t = β × B_t + α + ε_t  (ε ~ stationary)
 *   2. Compute spread = A - β B - α
 *   3. Trade: long spread when < lower_band, short when > upper_band
 *   4. Bollinger band on spread (mean ± 2σ rolling)
 *
 *   Engle-Granger test: ADF on regression residuals.
 *
 * **Chan Mean Reversion**:
 *
 *   Indicator: z-score(price, lookback=20)
 *   Signal: long when z < -2, exit when z > 0; short symmetric
 *
 *   Half-life of mean reversion: HL = -log(2) / κ  where κ from AR(1) on log price
 */

// ============================================================
// Carver Vol2 — Multi-system FDM
// ============================================================

/**
 * Forecast Diversification Multiplier (Carver Vol1+Vol2 unified).
 *
 *   FDM = 1 / sqrt(w^T ρ w)
 *
 *   where ρ is K×K correlation matrix of forecasts.
 *
 *   FDM compensates for the variance reduction when combining correlated
 *   forecasts (so combined forecast has same vol as individual forecasts).
 *
 * @param weights K forecast weights (sum=1)
 * @param correlation_matrix K×K
 */
export function forecastDiversificationMultiplier(
  weights: number[],
  correlation_matrix: number[][]
): number {
  const K = weights.length;
  if (K === 0) return 1;
  let q = 0;
  for (let i = 0; i < K; i += 1) {
    for (let j = 0; j < K; j += 1) {
      q += weights[i] * correlation_matrix[i][j] * weights[j];
    }
  }
  return q > 0 ? 1 / Math.sqrt(q) : 1;
}

/**
 * Combine K systems' forecasts with FDM (Carver Vol2 Ch.4).
 *
 *   combined_forecast = (Σ_k w_k × forecast_k) × FDM
 *
 *   Cap at ±20 (Carver standard).
 */
export function combineSystemForecastsWithFDM(input: {
  forecasts: number[]; // K signed forecasts (scaled to abs_mean=10)
  weights: number[];
  correlation_matrix: number[][];
  cap?: number;
}): { combined_forecast: number; fdm: number; raw_weighted_sum: number } {
  const K = input.forecasts.length;
  const cap = input.cap ?? 20;
  let raw_sum = 0;
  for (let k = 0; k < K; k += 1) raw_sum += input.weights[k] * input.forecasts[k];
  const fdm = forecastDiversificationMultiplier(input.weights, input.correlation_matrix);
  const combined = raw_sum * fdm;
  return {
    combined_forecast: Math.max(-cap, Math.min(cap, combined)),
    fdm,
    raw_weighted_sum: raw_sum,
  };
}

/**
 * Carry strategy for stocks (dividend + buyback yield).
 *
 *   carry = dividend_yield + buyback_yield - financing_cost
 */
export function stockCarry(input: {
  dividend_yield: number;
  buyback_yield: number;
  borrow_rate?: number;
}): number {
  return input.dividend_yield + input.buyback_yield - (input.borrow_rate ?? 0);
}

/**
 * Carver multi-system position sizing.
 *
 *   target_position = (forecast × volatility_target) / (forecast_cap × instrument_vol) × capital
 *
 *   forecast: scaled forecast ∈ [-20, +20]
 *   volatility_target: portfolio target σ (e.g. 0.20)
 *   forecast_cap: 20
 *   instrument_vol: annual σ of instrument
 *
 *   FDM × IDM (Instrument Diversification Multiplier) 进一步缩放.
 */
export function carverPositionSize(input: {
  forecast: number; // -20 to +20
  vol_target_annual: number; // e.g. 0.20
  instrument_vol_annual: number;
  capital: number;
  forecast_cap?: number;
  idm?: number; // instrument diversification multiplier
}): number {
  const cap = input.forecast_cap ?? 20;
  const idm = input.idm ?? 1;
  const base =
    (input.forecast * input.vol_target_annual) /
    (cap * Math.max(0.01, input.instrument_vol_annual));
  return base * idm * input.capital;
}

// ============================================================
// Johnson DMA — VWAP / TWAP / POV
// ============================================================

/**
 * VWAP schedule based on historical intraday volume curve.
 *
 *   Schedule: distribute order proportional to historical volume in each time bucket.
 *
 * @param order_qty total shares
 * @param historical_volume_curve volume in each time bucket (sums to total day volume)
 * @returns shares to trade in each bucket
 */
export function vwapSchedule(order_qty: number, historical_volume_curve: number[]): number[] {
  const total = historical_volume_curve.reduce((s, v) => s + v, 0);
  if (total <= 0)
    return historical_volume_curve.map(() => order_qty / historical_volume_curve.length);
  return historical_volume_curve.map(v => (v / total) * order_qty);
}

/**
 * TWAP schedule (equal slices over time).
 */
export function twapSchedule(order_qty: number, n_slices: number): number[] {
  if (n_slices <= 0) return [];
  const slice = order_qty / n_slices;
  return new Array(n_slices).fill(slice);
}

/**
 * POV (Percent of Volume) schedule.
 *
 *   Always trade at participation_rate × current_realized_volume.
 *   Adaptive: 高 vol 时段成交多, 低 vol 时段成交少.
 *
 * Returns: shares per bucket given realized vol.
 */
export function povSchedule(participation_rate: number, realized_volume_curve: number[]): number[] {
  return realized_volume_curve.map(v => participation_rate * v);
}

/**
 * Smart Order Routing decision (simplified).
 *
 *   Inputs: list of venues with (cost, available_liquidity, latency).
 *   Output: routing decisions per venue (shares).
 *
 *   Greedy algorithm: send to cheapest venue first up to available_liquidity, then next.
 */
export function smartOrderRouting(input: {
  order_qty: number;
  venues: Array<{
    name: string;
    cost_bps: number;
    available_liquidity: number;
    latency_ms: number;
  }>;
}): Array<{ venue: string; shares: number; estimated_cost_bps: number }> {
  // Sort by cost
  const sorted = [...input.venues].sort((a, b) => a.cost_bps - b.cost_bps);
  const routes: Array<{ venue: string; shares: number; estimated_cost_bps: number }> = [];
  let remaining = input.order_qty;
  for (const v of sorted) {
    if (remaining <= 0) break;
    const fill = Math.min(remaining, v.available_liquidity);
    if (fill > 0) {
      routes.push({ venue: v.name, shares: fill, estimated_cost_bps: v.cost_bps });
      remaining -= fill;
    }
  }
  return routes;
}

// ============================================================
// Chan — Pairs Trading + Co-integration
// ============================================================

/**
 * Engle-Granger co-integration test (simplified).
 *
 *   1. Regress y on x: y = α + β x + ε
 *   2. Compute residuals ε
 *   3. ADF test on residuals → if stationary, x and y are cointegrated
 *
 *   Returns: { beta, alpha, adf_t_stat, is_cointegrated }
 */
export function engleGrangerCointegration(
  y: number[],
  x: number[]
): {
  beta: number;
  alpha: number;
  residuals: number[];
  adf_t_stat: number;
  is_cointegrated: boolean;
} {
  if (y.length !== x.length || y.length < 30) {
    return { beta: NaN, alpha: NaN, residuals: [], adf_t_stat: NaN, is_cointegrated: false };
  }
  // OLS: y = α + β x
  const N = y.length;
  const mx = x.reduce((s, v) => s + v, 0) / N;
  const my = y.reduce((s, v) => s + v, 0) / N;
  let num = 0,
    denom = 0;
  for (let i = 0; i < N; i += 1) {
    num += (x[i] - mx) * (y[i] - my);
    denom += (x[i] - mx) ** 2;
  }
  if (denom < 1e-12)
    return { beta: NaN, alpha: NaN, residuals: [], adf_t_stat: NaN, is_cointegrated: false };
  const beta = num / denom;
  const alpha = my - beta * mx;
  const residuals = y.map((v, i) => v - alpha - beta * x[i]);

  // ADF test on residuals
  const dr: number[] = [];
  for (let t = 1; t < residuals.length; t += 1) dr.push(residuals[t] - residuals[t - 1]);
  const r_lag = residuals.slice(0, -1);
  const mr = r_lag.reduce((s, v) => s + v, 0) / r_lag.length;
  const mdr = dr.reduce((s, v) => s + v, 0) / dr.length;
  let numA = 0,
    denomA = 0;
  for (let i = 0; i < r_lag.length; i += 1) {
    numA += (r_lag[i] - mr) * (dr[i] - mdr);
    denomA += (r_lag[i] - mr) ** 2;
  }
  if (denomA < 1e-12) return { beta, alpha, residuals, adf_t_stat: NaN, is_cointegrated: false };
  const rho = numA / denomA;
  let ss = 0;
  for (let i = 0; i < r_lag.length; i += 1) {
    const pred = rho * (r_lag[i] - mr) + mdr;
    ss += (dr[i] - pred) ** 2;
  }
  const sigma = Math.sqrt(ss / Math.max(1, r_lag.length - 1));
  const se_rho = sigma / Math.sqrt(denomA);
  const t_stat = rho / Math.max(1e-12, se_rho);
  // Engle-Granger critical at 5%: -3.34 (less strict than ADF)
  const is_cointegrated = t_stat < -3.34;

  return { beta, alpha, residuals, adf_t_stat: t_stat, is_cointegrated };
}

/**
 * Pairs trading signal generator.
 *
 *   Given pair (y, x) and cointegration result:
 *     spread = y - β x - α
 *     z = (spread - rolling_mean) / rolling_std
 *
 *   Signal:
 *     z < -entry → buy y, sell β × x
 *     z > +entry → sell y, buy β × x
 *     |z| < exit → close position
 */
export function pairsTradingSignal(input: {
  y: number[];
  x: number[];
  beta: number;
  alpha: number;
  window: number;
  entry_z: number;
  exit_z: number;
}): {
  spreads: number[];
  z_scores: number[];
  positions: Array<'long_spread' | 'short_spread' | 'flat'>;
} {
  const N = input.y.length;
  const spreads: number[] = new Array(N).fill(NaN);
  for (let i = 0; i < N; i += 1) {
    spreads[i] = input.y[i] - input.beta * input.x[i] - input.alpha;
  }
  const z_scores: number[] = new Array(N).fill(NaN);
  for (let i = input.window - 1; i < N; i += 1) {
    const slice = spreads.slice(i - input.window + 1, i + 1).filter(Number.isFinite);
    if (slice.length < 2) continue;
    const m = slice.reduce((s, v) => s + v, 0) / slice.length;
    const v = slice.reduce((s, x) => s + (x - m) ** 2, 0) / (slice.length - 1);
    const std = Math.sqrt(v);
    z_scores[i] = std > 0 ? (spreads[i] - m) / std : 0;
  }
  const positions: Array<'long_spread' | 'short_spread' | 'flat'> = [];
  let current: 'long_spread' | 'short_spread' | 'flat' = 'flat';
  for (let i = 0; i < N; i += 1) {
    const z = z_scores[i];
    if (!Number.isFinite(z)) {
      positions.push(current);
      continue;
    }
    if (current === 'flat') {
      if (z < -input.entry_z) current = 'long_spread';
      else if (z > input.entry_z) current = 'short_spread';
    } else if (current === 'long_spread' && z > -input.exit_z) {
      current = 'flat';
    } else if (current === 'short_spread' && z < input.exit_z) {
      current = 'flat';
    }
    positions.push(current);
  }
  return { spreads, z_scores, positions };
}

/**
 * Chan mean-reversion half-life (Ornstein-Uhlenbeck speed).
 *
 *   AR(1): y_{t+1} - y_t = κ × (μ - y_t) + ε
 *
 *   Half-life = -log(2) / log(1 + κ)   (κ is speed of reversion in discrete time)
 *
 *   If κ > 0 and small → slow reversion (HL large); κ near 1 → fast.
 */
export function meanReversionHalfLife(prices: number[]): {
  kappa: number;
  half_life_days: number;
  is_mean_reverting: boolean;
} {
  if (prices.length < 30) return { kappa: NaN, half_life_days: NaN, is_mean_reverting: false };
  // Δy = κ (μ - y_t) + ε → Δy = κμ - κ y_t + ε
  const y_lag = prices.slice(0, -1);
  const dy = prices.slice(1).map((v, i) => v - prices[i]);
  const N = y_lag.length;
  const mx = y_lag.reduce((s, v) => s + v, 0) / N;
  const my = dy.reduce((s, v) => s + v, 0) / N;
  let num = 0,
    denom = 0;
  for (let i = 0; i < N; i += 1) {
    num += (y_lag[i] - mx) * (dy[i] - my);
    denom += (y_lag[i] - mx) ** 2;
  }
  if (denom < 1e-12) return { kappa: NaN, half_life_days: NaN, is_mean_reverting: false };
  const beta = num / denom;
  // β = -κ → κ = -β
  const kappa = -beta;
  if (kappa <= 0) return { kappa, half_life_days: Infinity, is_mean_reverting: false };
  const half_life = -Math.log(2) / Math.log(1 - kappa);
  return {
    kappa,
    half_life_days: half_life,
    is_mean_reverting: half_life > 0 && half_life < 100,
  };
}
