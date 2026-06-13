/**
 * Vince Mathematics of Money Management
 *
 * 论文 reference:
 *   Vince, R. (1992). *The Mathematics of Money Management: Risk Analysis
 *   Techniques for Traders.* Wiley.
 *
 *   Vince, R. (2009). *The Leverage Space Trading Model.* Wiley. (Vol 2)
 *
 * **Optimal f**:
 *
 *   给定一组历史 trade outcomes (P&L per trade),
 *   找 f ∈ [0, 1] 使得 Terminal Wealth Relative (TWR) maximized:
 *
 *     TWR(f) = Π_i (1 + f × (P_i / |worst_loss|))            (Eq.2.5)
 *
 *   - f ∈ [0, 1]: 每次冒"最大单笔亏损 × f"比例的资金
 *   - HPR (Holding Period Return) for trade i = 1 + f × (P_i / |worst_loss|)
 *   - 取 TWR derivative 求 max → optimal f
 *
 *   geometric_mean = TWR^(1/N) — average geometric return per trade.
 *
 * **Leverage Space (Vol2)**:
 *
 *   多 system 情况, 优化 (f_1, ..., f_K) 联合 maximize multi-system geometric mean.
 *
 *   k-system Leverage Space Model 在 k 维超空间上 grid search 或 gradient ascent.
 *
 * **Risk of Ruin**:
 *
 *   给定 win_rate p, loss_rate q, 持续 N 笔后 capital → 0 的概率:
 *
 *     RR(N) = ((q/p))^k     where k = capital_in_risk_units                  (Eq.4.2)
 *
 *   严格防 RR > 5% 避免破产.
 *
 * **本实现**:
 *   - optimalF(trades) — Vince 公式 + grid search
 *   - terminalWealthRelative(trades, f) — Eq.2.5
 *   - geometricMeanReturn(trades, f) — TWR^(1/N) - 1
 *   - leverageSpaceModel(systems, f_grid) — 多 system 优化
 *   - riskOfRuin(p, k) — Eq.4.2
 *   - kellyVsOptimalF — 比较 Kelly 和 Vince 的结果差异
 */

/**
 * Terminal Wealth Relative (TWR) — Vince Eq.2.5
 *
 *   TWR(f) = Π_i (1 + f × (P_i / |worst_loss|))
 *
 * @param trades P&L per trade (positive=win, negative=loss)
 * @param f leverage fraction ∈ [0, 1]
 */
export function terminalWealthRelative(trades: number[], f: number): number {
  if (trades.length === 0 || f < 0 || f > 1) return 1;
  const worst_loss = Math.min(...trades);
  if (worst_loss >= 0) return Number.POSITIVE_INFINITY; // No losses → unbounded
  const abs_worst = Math.abs(worst_loss);
  let twr = 1;
  for (const p of trades) {
    const hpr = 1 + f * (p / abs_worst);
    if (hpr <= 0) return 0; // bankrupted
    twr *= hpr;
  }
  return twr;
}

/**
 * Geometric mean return per trade.
 *
 *   GMR(f) = TWR(f)^(1/N) - 1
 */
export function geometricMeanReturn(trades: number[], f: number): number {
  const twr = terminalWealthRelative(trades, f);
  if (twr <= 0 || trades.length === 0) return -1;
  return Math.pow(twr, 1 / trades.length) - 1;
}

/**
 * Find Optimal f via grid search.
 *
 *   max_f ∈ (0, 1) of TWR(f)
 *
 *   Algorithm:
 *     1. Grid f ∈ {0.01, 0.02, ..., 0.99}
 *     2. Pick f with highest TWR
 *     3. Local refinement around max
 */
export function optimalF(trades: number[]): { f: number; twr: number; geometric_mean_return: number } {
  if (trades.length === 0) return { f: 0, twr: 1, geometric_mean_return: 0 };
  let best_f = 0;
  let best_twr = -Infinity;
  for (let i = 1; i <= 99; i += 1) {
    const f = i / 100;
    const twr = terminalWealthRelative(trades, f);
    if (twr > best_twr) {
      best_twr = twr;
      best_f = f;
    }
  }
  // Refinement around best_f
  for (let delta = -50; delta <= 50; delta += 1) {
    const f = best_f + delta * 0.0001;
    if (f <= 0 || f >= 1) continue;
    const twr = terminalWealthRelative(trades, f);
    if (twr > best_twr) {
      best_twr = twr;
      best_f = f;
    }
  }
  return {
    f: best_f,
    twr: best_twr,
    geometric_mean_return: best_twr > 0 && trades.length > 0 ? Math.pow(best_twr, 1 / trades.length) - 1 : -1,
  };
}

/**
 * Leverage Space Model (Vince Vol2) — multi-system Optimal f.
 *
 * For K independent systems, find (f_1, ..., f_K) maximizing combined TWR.
 *
 * Simplified grid search on K=2 systems; for K>2 use HRP-style cluster approach.
 */
export function leverageSpaceModel(
  systems_trades: number[][], // K systems, each with N_k trades
  options: { grid_steps?: number } = {}
): { f_vector: number[]; combined_twr: number; combined_gmr: number } {
  const K = systems_trades.length;
  if (K === 0) return { f_vector: [], combined_twr: 1, combined_gmr: 0 };

  // For K=1, just optimalF
  if (K === 1) {
    const r = optimalF(systems_trades[0]);
    return { f_vector: [r.f], combined_twr: r.twr, combined_gmr: r.geometric_mean_return };
  }

  // For K=2, 2D grid
  if (K === 2) {
    const steps = options.grid_steps ?? 20;
    let best_f1 = 0, best_f2 = 0, best_twr = -Infinity;
    for (let i = 1; i < steps; i += 1) {
      for (let j = 1; j < steps; j += 1) {
        const f1 = i / steps;
        const f2 = j / steps;
        const twr1 = terminalWealthRelative(systems_trades[0], f1);
        const twr2 = terminalWealthRelative(systems_trades[1], f2);
        // Combined assumes independence: TWR_combined ≈ TWR_1 × TWR_2 (if equally allocated)
        const combined = Math.sqrt(twr1 * twr2);
        if (combined > best_twr) {
          best_twr = combined;
          best_f1 = f1;
          best_f2 = f2;
        }
      }
    }
    return {
      f_vector: [best_f1, best_f2],
      combined_twr: best_twr,
      combined_gmr: Math.pow(best_twr, 1 / Math.max(systems_trades[0].length, systems_trades[1].length)) - 1,
    };
  }

  // For K>2, just per-system optimalF (independent)
  const f_vec: number[] = [];
  let combined = 1;
  let total_trades = 0;
  for (const trades of systems_trades) {
    const r = optimalF(trades);
    f_vec.push(r.f);
    combined *= Math.pow(r.twr, 1 / K);
    total_trades += trades.length;
  }
  return {
    f_vector: f_vec,
    combined_twr: combined,
    combined_gmr: total_trades > 0 ? Math.pow(combined, K / total_trades) - 1 : 0,
  };
}

/**
 * Risk of Ruin (Vince Eq.4.2).
 *
 *   RR = ((1-edge) / (1+edge))^k
 *
 *   - edge = win_rate × avg_win - loss_rate × avg_loss (normalized to 1-unit bet)
 *   - k = bankroll_in_risk_units
 *
 * 简化版 (Kelly-style):
 *   p > 0.5 (有 edge):
 *     RR = ((1-2p+1)/(2p-1+1))^k → ((1-edge)/(1+edge))^k  where edge = 2p-1
 *   p ≤ 0.5: RR = 1 (必破产)
 */
export function riskOfRuin(win_rate: number, bankroll_units: number): number {
  if (win_rate <= 0.5) return 1;
  if (bankroll_units <= 0) return 1;
  const edge = 2 * win_rate - 1;
  const ratio = (1 - edge) / (1 + edge);
  return Math.pow(ratio, bankroll_units);
}

/**
 * Kelly fraction (for comparison vs Optimal f).
 *
 *   f_Kelly = (winRate × payoffRatio - lossRate) / payoffRatio
 *           = (p × b - q) / b   where b = avg_win/avg_loss
 */
export function kellyFraction(win_rate: number, payoff_ratio: number): number {
  const q = 1 - win_rate;
  const f = (win_rate * payoff_ratio - q) / payoff_ratio;
  return Math.max(0, Math.min(1, f));
}

/**
 * Compare Kelly vs Optimal f.
 *
 * 实证: Optimal f 通常比 Kelly 大 (因为它直接 max geometric mean,
 * Kelly assumes Bernoulli outcomes).
 *
 * 真实 trade outcomes 非 Bernoulli → Kelly 是 approx, Optimal f 更准.
 */
export function compareKellyVsOptimalF(trades: number[]): {
  optimal_f: number;
  kelly_f: number;
  optimal_twr: number;
  kelly_twr: number;
  recommendation: string;
} {
  const opt = optimalF(trades);
  const wins = trades.filter(t => t > 0);
  const losses = trades.filter(t => t < 0);
  const win_rate = wins.length / Math.max(1, trades.length);
  const avg_win = wins.length > 0 ? wins.reduce((s, v) => s + v, 0) / wins.length : 0;
  const avg_loss = losses.length > 0 ? Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length) : 1;
  const payoff = avg_loss > 0 ? avg_win / avg_loss : 0;
  const kelly = kellyFraction(win_rate, payoff);
  const kelly_twr = terminalWealthRelative(trades, kelly);

  let rec: string;
  if (Math.abs(opt.f - kelly) < 0.05) {
    rec = 'Kelly ≈ Optimal f: 用任一';
  } else if (opt.f > kelly) {
    rec = 'Optimal f > Kelly: 数据显示 Kelly 保守了';
  } else {
    rec = 'Optimal f < Kelly: 数据显示 Kelly 激进了 (用 Optimal f 更安全)';
  }

  return {
    optimal_f: opt.f,
    kelly_f: kelly,
    optimal_twr: opt.twr,
    kelly_twr,
    recommendation: rec,
  };
}
