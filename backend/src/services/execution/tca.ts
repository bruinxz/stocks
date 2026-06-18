/**
 * Transaction Cost Analysis (TCA) Framework
 *
 * 论文 reference:
 *   Perold, A. F. (1988). "The Implementation Shortfall: Paper versus Reality."
 *   Journal of Portfolio Management 14(3), 4-9.
 *
 *   Harris, L. (2003). *Trading and Exchanges: Market Microstructure for
 *   Practitioners.* Chapter 21: "Liquidity and Trading Costs"
 *
 *   Kissell, R. and Glantz, M. (2003). *Optimal Trading Strategies:
 *   Quantitative Approaches for Managing Market Impact and Trading Risk.*
 *
 * **Implementation Shortfall (Perold 1988)**:
 *
 *   IS = (Decision Price - Execution Price) × Shares Filled
 *      + (Decision Price - End Price) × Shares Unfilled
 *      + Explicit costs (commission, fees, taxes)
 *      + Opportunity cost (if order not filled)
 *
 *   完整分解 (Wagner-Edwards-Lee 1979 extension):
 *
 *     IS = Delay Cost + Trading Cost + Opportunity Cost + Fixed Cost
 *
 *   - **Delay Cost**: 决策到下单的价格漂移
 *   - **Trading Cost**: 下单到成交的滑点 (spread + impact)
 *   - **Opportunity Cost**: 未成交部分的潜在 alpha 损失
 *   - **Fixed Cost**: commission + 印花税 + 过户费 (确定性)
 *
 * **典型 cost ranges (Harris 2003)**:
 *
 *   - Large caps:     spread 1-3 bps, impact 5-20 bps, total 10-50 bps
 *   - Mid caps:       spread 5-15 bps, impact 20-60 bps, total 30-120 bps
 *   - Small caps:     spread 20-100 bps, impact 50-200 bps, total 100-500 bps
 *
 *   A 股加成: stamp tax 1‰ (sell only), commission 万 2.5 双边, transfer fee 万 0.1.
 *
 * **本实现**:
 *   - computeImplementationShortfall — Perold 完整 IS 公式
 *   - decomposeIS — 4-component decomposition
 *   - estimateExpectedIS — pre-trade 估计 (Almgren-Chriss + Roll spread + delay assumption)
 *   - 配合 ExecutionFeasibilityService 提供 ex-ante + ex-post 视图
 */

export interface OrderExecution {
  /** Decision time price (paper portfolio mark) */
  decision_price: number;
  /** Actually filled shares */
  shares_filled: number;
  /** Average filled price (weighted by tranches) */
  avg_fill_price: number;
  /** Unfilled shares (if order canceled / partially filled) */
  shares_unfilled?: number;
  /** End-of-day or order-cancel price (for opportunity cost) */
  end_price?: number;
  /** Order target shares */
  target_shares: number;
  /** Order side */
  side: 'BUY' | 'SELL';
  /** Commission + fees per share (or total) */
  commission_total?: number;
  /** Stamp tax (A-share sell only): 千 1 of sell_amount */
  stamp_tax_total?: number;
  /** Transfer fee 万 0.1 双边 */
  transfer_fee_total?: number;
}

export interface ISDecomposition {
  /** Total Implementation Shortfall (in price units × shares) */
  total_is: number;
  /** As % of decision-price × target_shares */
  total_is_bps: number;
  /** Trading cost: filled portion (avg_fill - decision) */
  trading_cost: number;
  trading_cost_bps: number;
  /** Opportunity cost: unfilled portion (end - decision) */
  opportunity_cost: number;
  opportunity_cost_bps: number;
  /** Fixed costs (commission + tax + fees) */
  fixed_cost: number;
  fixed_cost_bps: number;
  /** Delay cost (if separate decision_time vs order_time pricing available) */
  delay_cost: number;
  delay_cost_bps: number;
  /** Fill rate (shares_filled / target_shares) */
  fill_rate: number;
  /** Notional baseline (target_shares × decision_price) */
  notional_baseline: number;
}

/**
 * Compute Implementation Shortfall (Perold 1988, signed for buy)
 *
 * For BUY: IS is positive when execution worse than decision price (paid more).
 * For SELL: IS is positive when execution worse than decision price (received less).
 *
 * 内部统一用"adverse direction":
 *   trading_cost_per_share = (avg_fill - decision) × side_factor   (side_factor = +1 BUY, -1 SELL)
 */
export function computeImplementationShortfall(exec: OrderExecution): ISDecomposition {
  const side = exec.side === 'BUY' ? 1 : -1;
  const notional_baseline = exec.target_shares * exec.decision_price;

  // Trading cost (filled portion)
  const trading_cost = exec.shares_filled * (exec.avg_fill_price - exec.decision_price) * side;

  // Opportunity cost (unfilled portion)
  const unfilled = exec.shares_unfilled ?? Math.max(0, exec.target_shares - exec.shares_filled);
  let opportunity_cost = 0;
  if (unfilled > 0 && exec.end_price !== undefined) {
    opportunity_cost = unfilled * (exec.end_price - exec.decision_price) * side;
  }

  // Fixed costs
  const commission = exec.commission_total ?? 0;
  const stampTax = exec.stamp_tax_total ?? 0;
  const transferFee = exec.transfer_fee_total ?? 0;
  const fixed_cost = commission + stampTax + transferFee;

  // Delay cost — 简化版需要 decision_time price + order_time price
  // 本接口未传 order_time price, 默认 0
  const delay_cost = 0;

  const total_is = trading_cost + opportunity_cost + fixed_cost + delay_cost;
  const fill_rate = exec.target_shares > 0 ? exec.shares_filled / exec.target_shares : 0;

  const tobps = (v: number) => (notional_baseline > 0 ? (v / notional_baseline) * 10000 : 0);

  return {
    total_is,
    total_is_bps: tobps(total_is),
    trading_cost,
    trading_cost_bps: tobps(trading_cost),
    opportunity_cost,
    opportunity_cost_bps: tobps(opportunity_cost),
    fixed_cost,
    fixed_cost_bps: tobps(fixed_cost),
    delay_cost,
    delay_cost_bps: tobps(delay_cost),
    fill_rate,
    notional_baseline,
  };
}

/**
 * A 股标准 fixed costs estimator
 *
 *   commission: 万 2.5 双边 (min 5 元) — caller 传 commission_rate (e.g. 0.00025)
 *   stamp_tax:  千 1 仅卖出 (0.001 × sell_amount)
 *   transfer_fee: 万 0.1 双边 (0.00001 × amount)
 */
export function aShareFixedCosts(input: {
  amount: number;
  side: 'BUY' | 'SELL';
  commission_rate?: number;
  min_commission?: number;
}): { commission: number; stamp_tax: number; transfer_fee: number; total: number } {
  const rate = input.commission_rate ?? 0.00025;
  const minComm = input.min_commission ?? 5;
  const commission = Math.max(minComm, input.amount * rate);
  const stamp_tax = input.side === 'SELL' ? input.amount * 0.001 : 0;
  const transfer_fee = input.amount * 0.00001;
  return {
    commission,
    stamp_tax,
    transfer_fee,
    total: commission + stamp_tax + transfer_fee,
  };
}

/**
 * Pre-trade IS estimator (combining Almgren-Chriss impact + Roll spread + fixed costs)
 *
 * 用于"我即将下单, 预期总成本多少 bps?"
 *
 * @param input.order_qty target shares
 * @param input.decision_price entry/decision price
 * @param input.side BUY / SELL
 * @param input.avg_daily_volume in shares
 * @param input.daily_vol decimal
 * @param input.spread_pct decimal
 * @param input.side BUY/SELL — affects fixed costs
 */
export function estimateExpectedIS(input: {
  order_qty: number;
  decision_price: number;
  side: 'BUY' | 'SELL';
  avg_daily_volume: number;
  daily_vol: number;
  spread_pct: number;
}): {
  expected_total_bps: number;
  impact_bps: number;
  spread_bps: number;
  fixed_bps: number;
} {
  const amount = input.order_qty * input.decision_price;

  // Impact (Almgren-Chriss linear, simplified)
  // η = 0.142 × σ × s / V; γ = 0.314 × σ / V
  const eta = (0.142 * input.daily_vol * input.spread_pct) / Math.max(1, input.avg_daily_volume);
  const gamma = (0.314 * input.daily_vol) / Math.max(1, input.avg_daily_volume);
  const v = input.order_qty;
  const impact_pct = input.spread_pct / 2 + eta * v + gamma * v;
  const impact_bps = impact_pct * 10000;

  // Spread cost (half-spread for crossing)
  const spread_bps = (input.spread_pct / 2) * 10000;

  // Fixed costs
  const fixed = aShareFixedCosts({ amount, side: input.side });
  const fixed_bps = amount > 0 ? (fixed.total / amount) * 10000 : 0;

  const expected_total_bps = impact_bps + spread_bps + fixed_bps;

  return {
    expected_total_bps,
    impact_bps,
    spread_bps,
    fixed_bps,
  };
}

/**
 * Realized vs Expected IS reconciliation
 *
 * 用于 ex-post review: 估计准不准?
 */
export function reconcileISRealizedVsExpected(input: {
  realized_bps: number;
  expected_bps: number;
}): {
  realized_bps: number;
  expected_bps: number;
  delta_bps: number;
  delta_ratio: number;
  verdict: 'better_than_expected' | 'as_expected' | 'worse_than_expected' | 'much_worse';
} {
  const delta = input.realized_bps - input.expected_bps;
  const ratio = input.expected_bps > 0 ? delta / input.expected_bps : 0;
  let verdict: 'better_than_expected' | 'as_expected' | 'worse_than_expected' | 'much_worse';
  if (delta <= -input.expected_bps * 0.2) verdict = 'better_than_expected';
  else if (delta <= input.expected_bps * 0.2) verdict = 'as_expected';
  else if (delta <= input.expected_bps * 0.5) verdict = 'worse_than_expected';
  else verdict = 'much_worse';
  return {
    realized_bps: input.realized_bps,
    expected_bps: input.expected_bps,
    delta_bps: delta,
    delta_ratio: ratio,
    verdict,
  };
}
