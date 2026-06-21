/**
 * AFML Ch.10 — Bet Sizing
 *
 * 论文 reference:
 *   López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
 *   Chapter 10: "Bet Sizing"
 *
 * **核心问题**:
 *   ML 模型输出 probability p (从 Triple Barrier meta-label). 如何转换为 position size?
 *
 *   v1 fractional Kelly: size = winRate × payoffRatio.
 *   v5 Thompson Sampling: size = Beta posterior lower CI.
 *
 *   De Prado 推荐 (Section 10.3): **Sizing from probabilities** 用 cumulative distribution:
 *
 *     z = (p - 0.5) / sqrt(p × (1 - p))                       (Eq.10.3, t-statistic)
 *
 *     m = 2 × Φ(z) - 1                                        (Eq.10.4, bet size ∈ [-1, +1])
 *
 *   - p = 0.5: m = 0 (no bet)
 *   - p = 0.8: m = ~0.74 (strong bet)
 *   - p = 0.95: m = ~0.96 (max bet)
 *
 *   优点:
 *     - 自然 monotonic in p
 *     - probability uncertainty 内嵌 (low confidence p ≈ 0.55 → small bet)
 *     - 不需要 win_rate / payoff 估计 (与 fractional Kelly 不同)
 *
 * **Discrete Bet Sizes** (Section 10.4):
 *
 *   Round m to multiples of step_size (e.g. 0.1 → 10 levels):
 *
 *     m_discretized = round(m / step) × step
 *
 *   减少换手 (transaction cost), 防 over-tuning.
 *
 * **Uniqueness-aware sizing** (Section 10.5):
 *
 *   如果一段时间内 N 个 bets 重叠 (来自 different signals 同 stock),
 *   sizing 应除以 sqrt(N) (avg uniqueness 的另一种 use):
 *
 *     size_adjusted = m / sqrt(concurrent_bets)
 *
 * **本实现**:
 *   - sizeFromProbability(p) — Eq.10.3 + Eq.10.4
 *   - discretizeBetSize(m, step) — Eq.10.4 discrete
 *   - uniquenessAdjustedSize(m, concurrent_bets) — Section 10.5
 *   - bridge: 给 PositionSizingPolicy 用作 alternative method
 */

import { standardNormalCdf } from '../../quant/backtest/OverfitMetrics';

/**
 * Bet size from probability (Eq.10.3 + 10.4).
 *
 *   z = (p - 0.5) / sqrt(p × (1 - p))
 *   m = 2 × Φ(z) - 1
 *
 * Range: m ∈ [-1, +1]
 *   - p = 0.5 → m = 0
 *   - p > 0.5 → m > 0 (long)
 *   - p < 0.5 → m < 0 (short / skip if long-only)
 *
 * 边界:
 *   - p = 0 → m = -1
 *   - p = 1 → m = +1
 */
export function sizeFromProbability(p: number): number {
  if (!Number.isFinite(p)) return 0;
  const p_clip = Math.max(1e-6, Math.min(1 - 1e-6, p));
  const z = (p_clip - 0.5) / Math.sqrt(p_clip * (1 - p_clip));
  const m = 2 * standardNormalCdf(z) - 1;
  return Math.max(-1, Math.min(1, m));
}

/**
 * Discretize bet size to multiples of `step`.
 *
 *   m_discrete = round(m / step) × step
 *
 * @param step typical 0.05, 0.1, 0.2 (5%/10%/20% increments)
 */
export function discretizeBetSize(m: number, step = 0.1): number {
  if (step <= 0) return m;
  const rounded = Math.round(m / step) * step;
  return Math.max(-1, Math.min(1, rounded));
}

/**
 * Uniqueness-aware adjustment for concurrent bets.
 *
 *   size_adjusted = m / sqrt(concurrent_bets)
 *
 * 当 N 个同时开仓 → 每个 size 缩 1/√N, 总暴露 ≈ √N × original.
 * 防止 portfolio 整体超 leveraged.
 */
export function uniquenessAdjustedSize(m: number, concurrent_bets: number): number {
  if (concurrent_bets <= 1) return m;
  return m / Math.sqrt(concurrent_bets);
}

/**
 * Sizing decision combining 3 steps:
 *   1. p → m via Eq.10.4
 *   2. m → m_discrete (optional)
 *   3. m_discrete → size_adjusted (optional)
 *
 * @returns final bet size ∈ [-max_size, max_size]
 */
export function decideBetSize(input: {
  probability: number;
  /** 离散步长 (0 表示不离散) */
  discretization_step?: number;
  /** 同时持仓数 (1 表示单仓) */
  concurrent_bets?: number;
  /** Max absolute bet size cap (default 1.0) */
  max_size?: number;
  /** Min absolute bet size to bother trading (below this → 0) */
  min_size_threshold?: number;
}): {
  raw_m: number;
  discretized_m: number;
  adjusted_m: number;
  final_size: number;
  should_bet: boolean;
} {
  const raw = sizeFromProbability(input.probability);
  const discr =
    input.discretization_step && input.discretization_step > 0
      ? discretizeBetSize(raw, input.discretization_step)
      : raw;
  const adj = uniquenessAdjustedSize(discr, input.concurrent_bets ?? 1);
  const maxSize = input.max_size ?? 1.0;
  const min_threshold = input.min_size_threshold ?? 0.05;
  const final_size = Math.max(-maxSize, Math.min(maxSize, adj));
  const should_bet = Math.abs(final_size) >= min_threshold;
  return {
    raw_m: raw,
    discretized_m: discr,
    adjusted_m: adj,
    final_size: should_bet ? final_size : 0,
    should_bet,
  };
}

/**
 * Position sizing from prediction probability + reference price.
 *
 * Practical wrapper: converts bet size m ∈ [-1, 1] to dollar amount.
 *
 *   amount = m × max_allocation
 *
 * For long-only strategy, set m_lo = 0 (skip m < 0).
 */
export function bettingSizeToDollarAmount(
  m: number,
  max_allocation: number,
  long_only = true
): number {
  if (long_only && m < 0) return 0;
  return m * max_allocation;
}

/**
 * Average active bet size (Eq.10.2).
 *
 * Given a sequence of bets (each ∈ [-1, +1]), compute average active size.
 *
 * Used for monitoring: 如果 avg_active_size << max → 模型大部分时间在 fence
 */
export function averageActiveBetSize(bet_sizes: number[]): number {
  const active = bet_sizes.filter(s => Math.abs(s) > 1e-6);
  if (active.length === 0) return 0;
  const sum_abs = active.reduce((s, v) => s + Math.abs(v), 0);
  return sum_abs / active.length;
}

/**
 * Calculate target position from probability + reference (long-only).
 *
 * Usage in PaperTradingAutomationService:
 *   - p = MetaLabel.shouldBet(...).confidence
 *   - target_position_pct = sizeFromProbability(p) × max_position_pct
 *
 * 替代 fractional Kelly 的简化 sizing.
 */
export function probabilityToPositionPct(
  p: number,
  max_position_pct: number,
  long_only = true
): number {
  const m = sizeFromProbability(p);
  const size = bettingSizeToDollarAmount(m, max_position_pct, long_only);
  return size;
}
