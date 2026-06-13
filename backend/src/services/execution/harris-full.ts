/**
 * Harris Trading & Exchanges (Full Coverage)
 *
 * 书 reference:
 *   Harris, L. (2003). *Trading and Exchanges: Market Microstructure for
 *   Practitioners.* Oxford University Press.
 *
 *   覆盖 22 章全部经典市场微结构概念.
 *
 * **Market Mechanisms (Ch.6-7)**:
 *
 *   3 种核心机制:
 *
 *   1. **Auction Markets**: 所有 orders 集中 cross at single price (call auction)
 *      e.g. A 股 9:15-9:25 集合竞价, NYSE opening cross
 *
 *   2. **Dealer Markets**: 做市商 quote bid/ask, 客户与做市商交易
 *      e.g. Nasdaq, US Treasury
 *
 *   3. **Hybrid Markets**: 限价单簿 + 做市商
 *      e.g. NYSE (Designated Market Maker + Limit Order Book), 港股
 *
 * **Order Types (Ch.4)**:
 *
 *   - **Limit Order**: 指定价格, 不立即成交
 *   - **Market Order**: 立即按 best bid/ask 成交
 *   - **Stop Order**: 触发价后转成 market order
 *   - **Stop Limit**: 触发后转 limit order
 *   - **Iceberg**: 大单分批显示 (隐藏剩余)
 *   - **Hidden Order**: 完全不在 book 显示
 *   - **Pegged Order**: 跟随 mid-quote 自动调价
 *   - **Reserve Order**: 暗池中暴露 portion
 *   - **MOC (Market on Close)**: 收盘前转 market
 *
 * **Information Traders (Ch.10-13)**:
 *
 *   3 types of informed traders:
 *
 *   1. **Value Traders**: 公司基本面 (long-term, low frequency)
 *   2. **News Traders**: 新闻 / 事件 (medium frequency)
 *   3. **Information-motivated Traders**: 内幕信息 (rare, high alpha)
 *
 *   做市商通过 "spread" 防 informed traders (adverse selection cost).
 *
 *   Glosten-Milgrom model: spread = E[V|buy order] - E[V|sell order]
 *
 * **Volatility Traders (Ch.16)**:
 *
 *   交易 vol 而非 direction. 主要工具:
 *
 *   - **Straddle**: long call + long put 同 strike (long vol)
 *   - **Iron Condor**: short vol via 4 options
 *   - **Variance Swap**: pure vol exposure
 *   - **Calendar Spread**: term structure of vol
 *
 *   vol trader 通过 implied vol vs realized vol 套利.
 *
 * **Liquidity Suppliers vs Demanders (Ch.13-14)**:
 *
 *   - **Suppliers** (做市商, 限价单挂单者): provide liquidity, earn spread
 *   - **Demanders** (市价单, stop order, large orders): pay spread, get immediacy
 *
 *   Supplier earn ~ spread × volume
 *   Demander cost ~ spread × order_size + impact
 *
 * **本实现**: 概念性 utilities + 关键 calculators
 */

// ============================================================
// Order Types
// ============================================================

export type OrderType =
  | 'limit'
  | 'market'
  | 'stop'
  | 'stop_limit'
  | 'iceberg'
  | 'hidden'
  | 'pegged'
  | 'reserve'
  | 'market_on_close'
  | 'fill_or_kill'
  | 'immediate_or_cancel';

export interface OrderSpec {
  type: OrderType;
  side: 'BUY' | 'SELL';
  qty: number;
  limit_price?: number;
  stop_price?: number;
  iceberg_display_qty?: number;
  pegged_offset?: number; // offset from mid
}

/**
 * Estimate fill probability per order type.
 *
 * Returns rough estimate of fill prob within next time bucket (typical horizon).
 *
 * Source: Harris Ch.4 empirical observations.
 */
export function estimateFillProbability(input: {
  order: OrderSpec;
  current_bid: number;
  current_ask: number;
  expected_vol_per_bucket: number; // % price move expected
}): number {
  const mid = (input.current_bid + input.current_ask) / 2;
  switch (input.order.type) {
    case 'market':
    case 'market_on_close':
    case 'immediate_or_cancel':
      return 1.0;
    case 'limit': {
      if (!input.order.limit_price) return 0;
      if (input.order.side === 'BUY') {
        // Will fill if ask drops to limit
        if (input.order.limit_price >= input.current_ask) return 1.0; // marketable
        const dist = (input.current_ask - input.order.limit_price) / mid;
        // Rough: prob = exp(-dist / expected_vol)
        return Math.exp(-Math.abs(dist) / Math.max(0.001, input.expected_vol_per_bucket));
      } else {
        if (input.order.limit_price <= input.current_bid) return 1.0;
        const dist = (input.order.limit_price - input.current_bid) / mid;
        return Math.exp(-Math.abs(dist) / Math.max(0.001, input.expected_vol_per_bucket));
      }
    }
    case 'stop':
    case 'stop_limit': {
      if (!input.order.stop_price) return 0;
      if (input.order.side === 'BUY') {
        if (input.current_ask >= input.order.stop_price) return 1.0;
        const dist = (input.order.stop_price - input.current_ask) / mid;
        return Math.exp(-Math.abs(dist) / Math.max(0.001, input.expected_vol_per_bucket));
      } else {
        if (input.current_bid <= input.order.stop_price) return 1.0;
        const dist = (input.current_bid - input.order.stop_price) / mid;
        return Math.exp(-Math.abs(dist) / Math.max(0.001, input.expected_vol_per_bucket));
      }
    }
    case 'iceberg':
    case 'hidden':
    case 'pegged':
    case 'reserve':
    case 'fill_or_kill':
      return 0.5; // generic estimate
    default:
      return 0.5;
  }
}

// ============================================================
// Market Mechanisms
// ============================================================

/**
 * Call Auction Clearing Price (集合竞价).
 *
 *   Given list of buy orders (price, qty) and sell orders,
 *   find price P* maximizing matched_qty.
 *
 *   Rules:
 *     - All buy orders with price ≥ P* and sell orders with price ≤ P* match
 *     - Matched_qty(P) = sum of buy_qty at price ≥ P min sum of sell_qty at price ≤ P
 *
 *   Tie-breaking (A 股集合竞价规则): minimize unmatched qty, then closest to prev_close.
 */
export function callAuctionClearing(input: {
  buy_orders: Array<{ price: number; qty: number }>;
  sell_orders: Array<{ price: number; qty: number }>;
  reference_price: number; // 前收 for tie-break
}): { clearing_price: number; matched_qty: number; unmatched_buy: number; unmatched_sell: number } {
  // Get candidate prices = all unique prices
  const all_prices = [...new Set([...input.buy_orders.map(o => o.price), ...input.sell_orders.map(o => o.price)])].sort((a, b) => a - b);

  let best_price = input.reference_price;
  let best_matched = 0;
  let best_unmatched = Infinity;

  for (const p of all_prices) {
    const buy_qty = input.buy_orders.filter(o => o.price >= p).reduce((s, o) => s + o.qty, 0);
    const sell_qty = input.sell_orders.filter(o => o.price <= p).reduce((s, o) => s + o.qty, 0);
    const matched = Math.min(buy_qty, sell_qty);
    const unmatched = Math.abs(buy_qty - sell_qty);
    if (matched > best_matched || (matched === best_matched && unmatched < best_unmatched)) {
      best_matched = matched;
      best_unmatched = unmatched;
      best_price = p;
    } else if (matched === best_matched && unmatched === best_unmatched) {
      // Tie: closer to reference price
      if (Math.abs(p - input.reference_price) < Math.abs(best_price - input.reference_price)) {
        best_price = p;
      }
    }
  }

  const buy_qty_at_p = input.buy_orders.filter(o => o.price >= best_price).reduce((s, o) => s + o.qty, 0);
  const sell_qty_at_p = input.sell_orders.filter(o => o.price <= best_price).reduce((s, o) => s + o.qty, 0);

  return {
    clearing_price: best_price,
    matched_qty: best_matched,
    unmatched_buy: Math.max(0, buy_qty_at_p - best_matched),
    unmatched_sell: Math.max(0, sell_qty_at_p - best_matched),
  };
}

// ============================================================
// Volatility Trading
// ============================================================

/**
 * Straddle: long call + long put 同 strike → long vol.
 *
 *   Payoff at expiry: max(S - K, 0) + max(K - S, 0) = |S - K|
 *   Cost: call_premium + put_premium
 *
 *   Break-even: K ± total_premium
 *   Profit if |S_T - K| > total_premium
 */
export function straddlePayoff(input: {
  spot_at_expiry: number;
  strike: number;
  call_premium: number;
  put_premium: number;
}): { gross_payoff: number; net_pnl: number; break_even_low: number; break_even_high: number } {
  const gross = Math.abs(input.spot_at_expiry - input.strike);
  const cost = input.call_premium + input.put_premium;
  return {
    gross_payoff: gross,
    net_pnl: gross - cost,
    break_even_low: input.strike - cost,
    break_even_high: input.strike + cost,
  };
}

/**
 * Variance Swap fair strike.
 *
 *   Variance swap pays (realized_var - K) × notional.
 *
 *   Fair strike K* ≈ E[realized_var] under risk-neutral.
 *
 *   For log returns: realized_var = Σ r_i² (sum, not avg).
 *
 *   实务: K* ≈ implied_var (from option prices replication).
 *
 *   Simplified: use historical realized var as estimate.
 */
export function varianceSwapFairStrike(historical_log_returns: number[]): number {
  if (historical_log_returns.length === 0) return 0;
  return historical_log_returns.reduce((s, r) => s + r * r, 0);
}

/**
 * Variance Swap P&L.
 *
 *   P&L = (realized_variance - fair_strike) × notional / fair_strike
 *
 *   (vega-adjusted notional)
 */
export function varianceSwapPnL(input: {
  realized_variance: number;
  fair_strike: number;
  vega_notional: number;
}): number {
  if (input.fair_strike <= 0) return 0;
  return (input.realized_variance - input.fair_strike) * input.vega_notional / (2 * Math.sqrt(input.fair_strike));
}

// ============================================================
// Liquidity Suppliers vs Demanders
// ============================================================

/**
 * Estimate dealer profit per round trip (Harris Ch.14).
 *
 *   profit = spread × volume - adverse_selection_loss
 *
 *   adverse_selection ≈ informed_trader_prob × |realized_price_change_after_fill|
 */
export function dealerProfitPerRoundTrip(input: {
  spread: number;
  volume_per_round_trip: number;
  informed_trader_prob: number;
  avg_price_drift_post_fill: number;
}): { gross_spread_profit: number; adverse_selection_loss: number; net_profit: number } {
  const gross = input.spread * input.volume_per_round_trip;
  const adverse = input.informed_trader_prob * input.avg_price_drift_post_fill * input.volume_per_round_trip;
  return {
    gross_spread_profit: gross,
    adverse_selection_loss: adverse,
    net_profit: gross - adverse,
  };
}

/**
 * Liquidity demander cost (Harris Ch.14).
 *
 *   cost = spread/2 + impact + commission
 *
 *   spread = transient cost (half-spread to cross)
 *   impact = permanent (information leak)
 *   commission = explicit fee
 */
export function liquidityDemanderCost(input: {
  half_spread_bps: number;
  impact_bps: number;
  commission_bps: number;
}): { total_bps: number; breakdown: { spread: number; impact: number; commission: number } } {
  return {
    total_bps: input.half_spread_bps + input.impact_bps + input.commission_bps,
    breakdown: {
      spread: input.half_spread_bps,
      impact: input.impact_bps,
      commission: input.commission_bps,
    },
  };
}

// ============================================================
// Informed Traders & Adverse Selection
// ============================================================

/**
 * Glosten-Milgrom model: spread from adverse selection alone.
 *
 *   spread = 2 × π × |V_high - V_low|
 *
 *   where:
 *     π = probability informed trader
 *     V_high, V_low = informed trader's belief if good/bad news
 *
 * 简化估计:
 *   π ≈ informed_volume / total_volume
 *   |V_high - V_low| ≈ historical max return swing
 */
export function glostenMilgromSpread(input: {
  informed_trader_prob: number;
  asymmetric_info_payoff: number; // value gap
}): number {
  return 2 * input.informed_trader_prob * Math.abs(input.asymmetric_info_payoff);
}

/**
 * PIN (Probability of Informed Trading, Easley et al. 1996).
 *
 *   PIN = α × μ / (α × μ + 2 × ε)
 *
 *   α: prob info event on any given day
 *   μ: arrival rate of informed traders (when event)
 *   ε: arrival rate of uninformed traders (always)
 *
 *   High PIN → high asymmetric info → wide spread.
 */
export function probabilityOfInformedTrading(input: {
  alpha: number;
  mu_informed: number;
  epsilon_uninformed: number;
}): number {
  const num = input.alpha * input.mu_informed;
  const den = input.alpha * input.mu_informed + 2 * input.epsilon_uninformed;
  return den > 0 ? num / den : 0;
}
