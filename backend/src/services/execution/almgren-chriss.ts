/**
 * Almgren-Chriss Optimal Execution Model
 *
 * 论文 reference:
 *   Almgren, R., and Chriss, N. (2000). "Optimal Execution of Portfolio Transactions."
 *   Journal of Risk 3(2), 5-39.
 *   https://www.math.nyu.edu/~chriss/optliq_f.pdf
 *
 * **核心模型** (Section 2)：
 *
 *   定义:
 *     S(t)  — 股票价格 (random walk)
 *     X(t)  — 已成交量；x(t) = X(t)/T, 持仓变化率
 *     τ     — 交易时长 (固定 horizon)
 *     v_k   = (n_k - n_{k-1}) / τ_k  — 单步成交速率
 *
 *   **Temporary impact** h(v_k):
 *     交易瞬间价格偏离 (next bar 回归)
 *     S̃_k = S_{k-1} - τ_k · g(v_k) - h(v_k)
 *     ⇒ 实际成交价 = mid - h(v_k)
 *
 *   **Permanent impact** g(v_k):
 *     持久影响 (后续 bar 不再回归)
 *     S_k = S_{k-1} + σ · ξ_k · √(τ_k) - τ_k · g(v_k)
 *
 *   **典型 linear parameterization** (Section 3):
 *     h(v) = ε · sign(v) + η · v        -- 固定 spread + 线性
 *     g(v) = γ · v                       -- 线性 permanent
 *
 *   **业界常用估计** (Almgren et al. 2005, Eq.34-37):
 *     η = 0.142 × σ × s / V         (s = spread, V = avg daily volume)
 *     γ = 0.314 × σ / V
 *     ε ≈ s / 2                      (half-spread)
 *     默认 σ = annual vol, V = ADV in shares
 *
 * **A 股适配**:
 *   - 涨跌停 → 滑点上限 = (limit_pct × prev_close)
 *   - 集合竞价 / 连续竞价 → η 在开盘 / 收盘附近升高 2-3 倍
 *   - 缺乏 L1 quote data → 用 (high - low) / 2 做 spread proxy
 *
 * **本实现**:
 *   - 简化 linear h(v) = ε + η·v, g(v) = γ·v
 *   - 不实现 closed-form optimal trajectory (sinh/cosh) — 对实盘选股决策无关
 *   - 重点是计算 expected_impact_cost(order_size) 给 ExecutionFeasibility 用
 */

export interface AlmgrenChrissParams {
  /** Average daily volume in shares */
  adv: number;
  /** Daily volatility (decimal, e.g., 0.02 = 2%) */
  daily_vol: number;
  /** Spread estimate (% of price, e.g., 0.001 = 10 bps) */
  spread_pct: number;
  /** Custom η override (default: 0.142 × σ × s / V) */
  eta?: number;
  /** Custom γ override (default: 0.314 × σ / V) */
  gamma?: number;
  /** Custom ε override (default: spread/2) */
  epsilon_pct?: number;
}

export interface ImpactCostBreakdown {
  /** Temporary impact in bps */
  temporary_bps: number;
  /** Permanent impact in bps */
  permanent_bps: number;
  /** Total cost = temporary + permanent in bps */
  total_bps: number;
  /** Participation rate (q / V) */
  participation_rate: number;
  /** Estimated η, γ, ε used */
  eta_used: number;
  /** Annualized in % rather than bps */
  total_pct: number;
}

/**
 * Almgren-Li (2005) 业界标定 η, γ, ε (Eq.34-37)
 */
export function calibrateAlmgrenChrissDefaults(params: AlmgrenChrissParams): {
  eta: number;
  gamma: number;
  epsilon_pct: number;
} {
  const { daily_vol, spread_pct, adv } = params;
  // Eq.34: η = 0.142 × σ × s / V (V in shares, σ daily, s relative spread)
  // 注：原 paper 用 annualized vol，我们用 daily vol 简化（这里 η 单位是 % per share/day）
  const eta = params.eta ?? (0.142 * daily_vol * spread_pct) / Math.max(1, adv);
  // Eq.37: γ = 0.314 × σ / V
  const gamma = params.gamma ?? (0.314 * daily_vol) / Math.max(1, adv);
  // ε = spread/2
  const epsilon_pct = params.epsilon_pct ?? spread_pct / 2;
  return { eta, gamma, epsilon_pct };
}

/**
 * 单笔订单 expected impact cost (基于 linear model)
 *
 * 假设订单在 1 个 bar 内完成 (single-period 简化):
 *   v = order_qty / 1 bar
 *   temporary_cost = h(v) = ε + η · v
 *   permanent_cost = g(v) × T = γ · v × 1 = γ · v
 *
 * 假设 T = 1 bar，单步成交。
 *
 * @returns cost in basis points (bps)
 */
export function expectedImpactCost(
  order_qty: number,
  params: AlmgrenChrissParams
): ImpactCostBreakdown {
  const { eta, gamma, epsilon_pct } = calibrateAlmgrenChrissDefaults(params);
  const v = Math.max(0, order_qty); // 假设 1 bar 完成
  const participation_rate = params.adv > 0 ? order_qty / params.adv : Infinity;

  // η 和 γ 已经是 % per share, 乘 v 得到 % cost
  const temporary_pct = epsilon_pct + eta * v;
  const permanent_pct = gamma * v;
  const total_pct = temporary_pct + permanent_pct;

  return {
    temporary_bps: temporary_pct * 10000,
    permanent_bps: permanent_pct * 10000,
    total_bps: total_pct * 10000,
    participation_rate,
    eta_used: eta,
    total_pct,
  };
}

/**
 * 把 expected impact cost 映射到 ExecutionFeasibility 评分 [0, 100]
 *
 * 业界经验:
 *   - cost ≤ 5 bps    → score 100 (微影响)
 *   - cost 5-20 bps   → score 80
 *   - cost 20-50 bps  → score 50
 *   - cost 50-100 bps → score 20
 *   - cost > 100 bps  → score 0
 */
export function impactCostToScore(total_bps: number): number {
  if (!Number.isFinite(total_bps) || total_bps < 0) return 0;
  if (total_bps <= 5) return 100;
  if (total_bps <= 20) return Math.round(100 - ((total_bps - 5) / 15) * 20);
  if (total_bps <= 50) return Math.round(80 - ((total_bps - 20) / 30) * 30);
  if (total_bps <= 100) return Math.round(50 - ((total_bps - 50) / 50) * 30);
  return Math.max(0, Math.round(20 - ((total_bps - 100) / 100) * 20));
}

/**
 * (Optional, 仅用于 large-order 多 bar 拆单场景)
 *
 * Almgren-Chriss closed-form optimal liquidation trajectory (Section 4):
 *
 *   x*(t) = X · sinh(κ(T-t)) / sinh(κT)
 *   κ = √(λ σ² / η̂)
 *   η̂ = η - γτ/2
 *
 * 把总订单 X 分到 [0, T]，最小化 E[cost] + λ Var[cost]。
 *
 * 参数:
 *   - λ: risk aversion (越大越保守，越急成交)
 *   - σ: daily volatility
 *   - η: temporary impact slope
 *   - γ: permanent impact slope
 *   - τ: 单步时间间隔 (默认 1 day)
 *   - T: 总时长 (默认 5 days)
 *
 * @returns array of holdings (shares remaining) at each step
 */
export function optimalLiquidationTrajectory(
  total_qty: number,
  T_steps: number,
  params: {
    risk_aversion: number;
    daily_vol: number;
    eta: number;
    gamma: number;
    tau?: number;
  }
): { holdings: number[]; trades: number[]; kappa: number } {
  const tau = params.tau ?? 1;
  const eta_hat = params.eta - (params.gamma * tau) / 2;
  if (eta_hat <= 0) {
    // 退化：linear schedule
    const trades = new Array(T_steps).fill(total_qty / T_steps);
    const holdings: number[] = [total_qty];
    for (let i = 0; i < T_steps; i += 1) holdings.push(holdings[i] - trades[i]);
    return { holdings, trades, kappa: 0 };
  }
  const kappa = Math.sqrt((params.risk_aversion * params.daily_vol * params.daily_vol) / eta_hat);
  const T_total = T_steps * tau;
  const holdings: number[] = [total_qty];
  const trades: number[] = [];
  for (let k = 1; k <= T_steps; k += 1) {
    const t = k * tau;
    const x_k = total_qty * (Math.sinh(kappa * (T_total - t)) / Math.sinh(kappa * T_total));
    holdings.push(x_k);
    trades.push(holdings[k - 1] - holdings[k]);
  }
  return { holdings, trades, kappa };
}
