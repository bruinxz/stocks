/**
 * Square-Root Market Impact (Bouchaud)
 *
 * 论文 reference:
 *   Bouchaud, J. P., Farmer, J. D., Lillo, F. (2009). "How Markets Slowly
 *   Digest Changes in Supply and Demand."
 *   Handbook of Financial Markets: Dynamics and Evolution, Elsevier.
 *
 *   Tóth, B., Lemperière, Y., Deremble, C., De Lataillade, J., Kockelkoren, J.,
 *   Bouchaud, J. P. (2011). "Anomalous price impact and the critical nature
 *   of liquidity in financial markets."
 *   Physical Review X 1, 021006.
 *
 *   Almgren, R., Thum, C., Hauptmann, E., Li, H. (2005). "Direct estimation
 *   of equity market impact." Risk 18, 57-62. (Square-root regression)
 *
 * **核心公式 (Bouchaud-Tóth square root law)**:
 *
 *     ΔP / P = Y · σ · √(Q / V)                            (Eq.4 Tóth 2011)
 *
 *   - ΔP: price impact
 *   - σ: daily volatility
 *   - Q: order size (shares)
 *   - V: avg daily volume (shares)
 *   - Y: empirical constant ≈ 1 (普适常数)
 *
 *   关键: impact ∝ √(participation), 不是 linear (vs Almgren-Chriss assumption).
 *
 * **解释 (Bouchaud)**:
 *
 *   Limit order book 有 fractal liquidity profile. 大单 walk through book,
 *   每层 thickness 与价格 increment 成 √ 关系 → impact √(Q).
 *
 * **vs Almgren-Chriss**:
 *
 *   - Almgren-Chriss: linear h(v) = ε + η v
 *   - Bouchaud:       sqrt h(v) = Y σ √(v/V)
 *
 *   实证 (Almgren-Thum-Hauptmann-Li 2005, ~700,000 trades):
 *     sqrt law 在 [0.1%, 10%] participation 范围下更准.
 *     linear 在 small order 过分高估, large order 过分低估.
 *
 * **本实现**:
 *   - bouchaudImpact(order_qty, adv, daily_vol, Y) — closed form
 *   - calibrateBouchaudY(trades) — fit Y from historical executions
 *   - 配合 Almgren-Chriss 做 A/B 对比 (v4 已实现 AC, v6 加 BC)
 */

/**
 * Square-root impact (in price units):
 *
 *   ΔP / P = Y · σ · √(Q / V)
 *
 * @param order_qty Q (shares)
 * @param adv V (avg daily volume in shares)
 * @param daily_vol σ (decimal e.g. 0.02 = 2%)
 * @param Y empirical constant (default 1, Bouchaud universal)
 *
 * @returns impact as fraction of price (e.g. 0.005 = 50 bps)
 */
export function bouchaudImpact(order_qty: number, adv: number, daily_vol: number, Y = 1.0): number {
  if (adv <= 0 || daily_vol <= 0 || order_qty <= 0) return 0;
  return Y * daily_vol * Math.sqrt(order_qty / adv);
}

/**
 * Convert impact (fractional) to bps.
 */
export function bouchaudImpactBps(
  order_qty: number,
  adv: number,
  daily_vol: number,
  Y = 1.0
): number {
  return bouchaudImpact(order_qty, adv, daily_vol, Y) * 10000;
}

/**
 * Calibrate Y from historical trade data.
 *
 *   For each historical trade with (realized_impact, Q, V, σ):
 *     Y_i = realized_impact / (σ · √(Q/V))
 *
 *   Y_estimate = median(Y_i)  (median 比 mean 更鲁棒)
 *
 *   或 OLS:  realized_impact = Y · σ · √(Q/V)  → Y = Σ(impact · sqrt_term) / Σ(sqrt_term²)
 */
export function calibrateBouchaudY(
  trades: Array<{
    realized_impact_fraction: number; // (avg_fill - decision_price) / decision_price
    order_qty: number;
    adv: number;
    daily_vol: number;
  }>
): { Y_median: number; Y_ols: number; n_valid: number } {
  const ys: number[] = [];
  let num = 0,
    denom = 0;
  for (const t of trades) {
    if (t.adv <= 0 || t.daily_vol <= 0 || t.order_qty <= 0) continue;
    const sqrt_term = t.daily_vol * Math.sqrt(t.order_qty / t.adv);
    if (sqrt_term < 1e-12) continue;
    const Y_i = t.realized_impact_fraction / sqrt_term;
    if (!Number.isFinite(Y_i)) continue;
    ys.push(Y_i);
    num += t.realized_impact_fraction * sqrt_term;
    denom += sqrt_term * sqrt_term;
  }
  if (ys.length === 0) return { Y_median: NaN, Y_ols: NaN, n_valid: 0 };
  ys.sort((a, b) => a - b);
  const Y_median =
    ys.length % 2 === 0
      ? (ys[ys.length / 2 - 1] + ys[ys.length / 2]) / 2
      : ys[Math.floor(ys.length / 2)];
  const Y_ols = denom > 0 ? num / denom : 0;
  return { Y_median, Y_ols, n_valid: ys.length };
}

/**
 * Map impact bps to ExecutionFeasibility score [0, 100]
 * (与 v4 impactCostToScore 同款 mapping)
 */
export function bouchaudImpactToScore(impact_bps: number): number {
  if (!Number.isFinite(impact_bps) || impact_bps < 0) return 0;
  if (impact_bps <= 5) return 100;
  if (impact_bps <= 20) return Math.round(100 - ((impact_bps - 5) / 15) * 20);
  if (impact_bps <= 50) return Math.round(80 - ((impact_bps - 20) / 30) * 30);
  if (impact_bps <= 100) return Math.round(50 - ((impact_bps - 50) / 50) * 30);
  return Math.max(0, Math.round(20 - ((impact_bps - 100) / 100) * 20));
}

/**
 * Compare Almgren-Chriss vs Bouchaud impact estimates.
 *
 * 用于 ops 在生产 A/B 评估两个模型. 输入相同 (Q, σ, V, spread),
 * 输出两个 model 预测的 impact_bps + delta.
 */
export function compareACvsBouchaud(input: {
  order_qty: number;
  adv: number;
  daily_vol: number;
  spread_pct: number;
  Y_bouchaud?: number;
}): {
  almgren_chriss_bps: number;
  bouchaud_bps: number;
  delta_bps: number;
  delta_ratio: number;
  recommendation: string;
} {
  // Almgren-Chriss linear (v4 公式)
  const eta = (0.142 * input.daily_vol * input.spread_pct) / Math.max(1, input.adv);
  const gamma = (0.314 * input.daily_vol) / Math.max(1, input.adv);
  const v = input.order_qty;
  const ac_pct = input.spread_pct / 2 + eta * v + gamma * v;
  const ac_bps = ac_pct * 10000;

  const bc_bps = bouchaudImpactBps(
    input.order_qty,
    input.adv,
    input.daily_vol,
    input.Y_bouchaud ?? 1.0
  );

  const delta = bc_bps - ac_bps;
  const delta_ratio = ac_bps > 0 ? delta / ac_bps : 0;
  let rec = 'AC ≈ BC: 两个模型一致';
  if (Math.abs(delta_ratio) > 0.5) {
    rec =
      bc_bps > ac_bps
        ? 'BC > AC: 大单 / 高 participation; 用 Bouchaud 更保守'
        : 'BC < AC: 小单 / 低 participation; AC 高估了 impact';
  }
  return {
    almgren_chriss_bps: ac_bps,
    bouchaud_bps: bc_bps,
    delta_bps: delta,
    delta_ratio,
    recommendation: rec,
  };
}
