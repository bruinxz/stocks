/**
 * Aronson Evidence-Based TA + Bulkowski Chart Patterns
 *
 * 书 reference:
 *   Aronson, D. R. (2007). *Evidence-Based Technical Analysis: Applying the
 *   Scientific Method and Statistical Inference to Trading Signals.* Wiley.
 *
 *   White, H. (2000). "A Reality Check for Data Snooping."
 *   Econometrica 68(5), 1097-1126.
 *
 *   Bulkowski, T. (2005). *Encyclopedia of Chart Patterns.* 2nd ed., Wiley.
 *
 * **Aronson核心思想**:
 *
 *   1. **Subjective vs Objective TA**:
 *      - Subjective: "head and shoulders 来了" (主观判断, no rigor)
 *      - Objective: precise rules + 历史回测 + 统计 significance
 *
 *   2. **Data Mining Bias (DMB)**:
 *      Testing K rules, if any has p-value < 0.05, you "discover" something.
 *      但 false positive rate = 1 - (1-0.05)^K → 50% for K=14.
 *
 *   3. **White's Reality Check (2000)**:
 *      Bootstrap test that adjusts for K-rule simultaneous testing.
 *      H_0: best of K rules has no positive expected return.
 *      Bootstrap distribution of best_return - mean(returns).
 *      p-value = % of bootstrap > observed best.
 *
 *   4. **Bonferroni-Holm correction**:
 *      Simple alternative: α_individual = α_family / K
 *
 * **Bulkowski 60+ Chart Patterns**:
 *
 *   每个形态有:
 *     - Success rate (% reaches target)
 *     - Average R/R ratio (gain / loss)
 *     - Failure rate
 *     - Optimal market regime
 *
 *   Top patterns (high reliability):
 *     - Head and Shoulders (top): 81% reach target
 *     - Inverse H&S (bottom): 83% reach target
 *     - Triple Bottom: 78% reach target
 *     - Cup with Handle: 73% reach target
 *
 *   Bottom patterns (low reliability):
 *     - Symmetrical Triangle: 65% (不可信主指引)
 *     - Pennant: 60% (太多 noise)
 *     - Flag: 67% (短期)
 *
 * **本实现**:
 *   - dataMiningBiasAdjustment — Bonferroni-Holm 多检验校正
 *   - whitesRealityCheck — Bootstrap simultaneous test
 *   - chartPatternReliabilityTable — 60+ pattern stats (table data)
 *   - detectHeadAndShoulders — 实际形态识别 algorithm
 *   - detectTripleBottom — 三重底
 *   - detectCupAndHandle — 杯柄
 */

// ============================================================
// Aronson Statistical Testing
// ============================================================

/**
 * Bonferroni-Holm correction for multiple hypothesis testing.
 *
 *   Sort p-values ascending.
 *   At step k, threshold = α / (K - k + 1)
 *   Reject all H_k with p_k < threshold (sequentially).
 *
 *   Less conservative than pure Bonferroni (α / K).
 */
export function bonferroniHolmCorrection(p_values: number[], alpha = 0.05): boolean[] {
  const K = p_values.length;
  const indexed = p_values.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const reject = new Array(K).fill(false);
  for (let k = 0; k < K; k += 1) {
    const threshold = alpha / (K - k);
    if (indexed[k].p < threshold) {
      reject[indexed[k].i] = true;
    } else {
      // Stop at first failure to reject (Holm sequential)
      break;
    }
  }
  return reject;
}

/**
 * False Discovery Rate (Benjamini-Hochberg).
 *
 *   Less conservative than Bonferroni.
 *   Control E[V/R] = expected false discovery rate at level α.
 */
export function benjaminiHochbergFDR(p_values: number[], alpha = 0.05): boolean[] {
  const K = p_values.length;
  const indexed = p_values.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const reject = new Array(K).fill(false);
  let last_rejected_idx = -1;
  for (let k = 0; k < K; k += 1) {
    const threshold = ((k + 1) / K) * alpha;
    if (indexed[k].p < threshold) {
      last_rejected_idx = k;
    }
  }
  for (let k = 0; k <= last_rejected_idx; k += 1) {
    reject[indexed[k].i] = true;
  }
  return reject;
}

/**
 * White's Reality Check (2000) - simplified.
 *
 *   Test if best of K rules has positive return after correcting for data snooping.
 *
 *   Algorithm:
 *     1. Compute observed mean return for each of K rules → r_1, ..., r_K
 *     2. Center: r_i - mean(r_i)  (remove unconditional mean)
 *     3. Block bootstrap B times: pick contiguous blocks of returns
 *     4. For each bootstrap: max(r_i*) over K rules
 *     5. p-value = % of bootstrap max > observed max
 *
 *   Reject H_0 (no rule has alpha) if p < α.
 */
export function whitesRealityCheck(input: {
  /** Each rule's daily returns (K rules × T days) */
  rule_returns: number[][];
  /** Bootstrap iterations (default 1000) */
  B?: number;
  /** Bootstrap block size (default 10) */
  block_size?: number;
  /** Significance level */
  alpha?: number;
  /** RNG seed for reproducibility */
  seed?: number;
}): {
  observed_best_mean: number;
  bootstrap_distribution_p95: number;
  p_value: number;
  reject_h0: boolean;
} {
  const K = input.rule_returns.length;
  const T = input.rule_returns[0]?.length ?? 0;
  const B = input.B ?? 1000;
  const block_size = input.block_size ?? 10;
  const alpha = input.alpha ?? 0.05;

  // Observed means
  const observed_means = input.rule_returns.map(rets =>
    rets.length > 0 ? rets.reduce((s, v) => s + v, 0) / rets.length : 0
  );
  const observed_best = Math.max(...observed_means);

  // Centered returns
  const centered = input.rule_returns.map((rets, k) => rets.map(r => r - observed_means[k]));

  // Seeded RNG
  let state = (input.seed ?? 42) % 2147483647;
  if (state <= 0) state += 2147483646;
  const rng = (): number => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };

  // Block bootstrap
  const boot_best_distribution: number[] = [];
  for (let b = 0; b < B; b += 1) {
    const n_blocks = Math.ceil(T / block_size);
    const boot_means: number[] = new Array(K).fill(0);
    for (let bl = 0; bl < n_blocks; bl += 1) {
      const start = Math.floor(rng() * (T - block_size + 1));
      for (let s = 0; s < block_size && bl * block_size + s < T; s += 1) {
        for (let k = 0; k < K; k += 1) {
          boot_means[k] += centered[k][start + s];
        }
      }
    }
    for (let k = 0; k < K; k += 1) boot_means[k] /= T;
    boot_best_distribution.push(Math.max(...boot_means));
  }

  // p-value
  const count_above = boot_best_distribution.filter(v => v > observed_best).length;
  const p_value = (count_above + 1) / (B + 1);
  const p95 = boot_best_distribution.sort((a, b) => a - b)[Math.floor(B * 0.95)];

  return {
    observed_best_mean: observed_best,
    bootstrap_distribution_p95: p95,
    p_value,
    reject_h0: p_value < alpha,
  };
}

// ============================================================
// Bulkowski Pattern Reliability Table
// ============================================================

export interface PatternStat {
  pattern: string;
  category: 'top' | 'bottom' | 'continuation' | 'reversal';
  success_rate: number; // % reaches target (after breakout)
  avg_rise_pct?: number; // avg return to target
  avg_fall_pct?: number;
  failure_rate: number;
  optimal_regime?: 'bull' | 'bear' | 'all';
  reliability_rank: number; // 1=most reliable
}

/**
 * Bulkowski reliability table (subset of 60+ patterns; top 15 by reliability).
 *
 * Source: *Encyclopedia of Chart Patterns* 2nd ed., 2005 (bull/bear market data).
 */
export const BULKOWSKI_PATTERN_TABLE: PatternStat[] = [
  {
    pattern: 'Inverse Head and Shoulders (bottom)',
    category: 'bottom',
    success_rate: 0.83,
    avg_rise_pct: 0.38,
    failure_rate: 0.05,
    optimal_regime: 'bull',
    reliability_rank: 1,
  },
  {
    pattern: 'Head and Shoulders Top',
    category: 'top',
    success_rate: 0.81,
    avg_fall_pct: 0.22,
    failure_rate: 0.04,
    optimal_regime: 'bear',
    reliability_rank: 2,
  },
  {
    pattern: 'Triple Bottom',
    category: 'bottom',
    success_rate: 0.78,
    avg_rise_pct: 0.37,
    failure_rate: 0.06,
    optimal_regime: 'bull',
    reliability_rank: 3,
  },
  {
    pattern: 'Double Bottom (Adam-Adam)',
    category: 'bottom',
    success_rate: 0.74,
    avg_rise_pct: 0.35,
    failure_rate: 0.07,
    optimal_regime: 'bull',
    reliability_rank: 4,
  },
  {
    pattern: 'Cup with Handle',
    category: 'continuation',
    success_rate: 0.73,
    avg_rise_pct: 0.34,
    failure_rate: 0.07,
    optimal_regime: 'bull',
    reliability_rank: 5,
  },
  {
    pattern: 'Rounding Bottom',
    category: 'bottom',
    success_rate: 0.72,
    avg_rise_pct: 0.36,
    failure_rate: 0.05,
    optimal_regime: 'bull',
    reliability_rank: 6,
  },
  {
    pattern: 'Triple Top',
    category: 'top',
    success_rate: 0.71,
    avg_fall_pct: 0.19,
    failure_rate: 0.09,
    optimal_regime: 'bear',
    reliability_rank: 7,
  },
  {
    pattern: 'Ascending Triangle',
    category: 'continuation',
    success_rate: 0.7,
    avg_rise_pct: 0.31,
    failure_rate: 0.1,
    optimal_regime: 'bull',
    reliability_rank: 8,
  },
  {
    pattern: 'Double Top (Adam-Adam)',
    category: 'top',
    success_rate: 0.69,
    avg_fall_pct: 0.18,
    failure_rate: 0.09,
    optimal_regime: 'bear',
    reliability_rank: 9,
  },
  {
    pattern: 'Falling Wedge',
    category: 'reversal',
    success_rate: 0.68,
    avg_rise_pct: 0.32,
    failure_rate: 0.11,
    optimal_regime: 'all',
    reliability_rank: 10,
  },
  {
    pattern: 'Bullish Flag',
    category: 'continuation',
    success_rate: 0.67,
    avg_rise_pct: 0.13,
    failure_rate: 0.12,
    optimal_regime: 'bull',
    reliability_rank: 11,
  },
  {
    pattern: 'Symmetrical Triangle (continuation)',
    category: 'continuation',
    success_rate: 0.65,
    avg_rise_pct: 0.3,
    failure_rate: 0.13,
    optimal_regime: 'all',
    reliability_rank: 12,
  },
  {
    pattern: 'Descending Triangle',
    category: 'continuation',
    success_rate: 0.64,
    avg_fall_pct: 0.16,
    failure_rate: 0.14,
    optimal_regime: 'bear',
    reliability_rank: 13,
  },
  {
    pattern: 'Bullish Pennant',
    category: 'continuation',
    success_rate: 0.6,
    avg_rise_pct: 0.12,
    failure_rate: 0.16,
    optimal_regime: 'bull',
    reliability_rank: 14,
  },
  {
    pattern: 'Bearish Pennant',
    category: 'continuation',
    success_rate: 0.58,
    avg_fall_pct: 0.1,
    failure_rate: 0.17,
    optimal_regime: 'bear',
    reliability_rank: 15,
  },
];

/**
 * Get pattern statistics by name.
 */
export function lookupPattern(name: string): PatternStat | undefined {
  return BULKOWSKI_PATTERN_TABLE.find(p => p.pattern.toLowerCase().includes(name.toLowerCase()));
}

/**
 * Filter patterns by reliability threshold.
 *
 * Only return patterns with success_rate ≥ min_success.
 */
export function reliablePatternsOnly(min_success = 0.7): PatternStat[] {
  return BULKOWSKI_PATTERN_TABLE.filter(p => p.success_rate >= min_success);
}

/**
 * Pattern × Regime conditional success rate.
 *
 * In bull regime: only consider patterns with optimal_regime='bull' or 'all'.
 * In bear regime: only consider patterns with optimal_regime='bear' or 'all'.
 *
 * Conditional success_rate boost: +5% if regime matches (实证 Bulkowski).
 */
export function patternRegimeAdjusted(
  pattern: PatternStat,
  current_regime: 'bull' | 'bear' | 'range'
): {
  base_success: number;
  adjusted_success: number;
  regime_match: boolean;
} {
  const matched =
    pattern.optimal_regime === 'all' ||
    (current_regime === 'bull' && pattern.optimal_regime === 'bull') ||
    (current_regime === 'bear' && pattern.optimal_regime === 'bear');
  const adj = matched ? Math.min(1, pattern.success_rate * 1.05) : pattern.success_rate * 0.85;
  return {
    base_success: pattern.success_rate,
    adjusted_success: adj,
    regime_match: matched,
  };
}

// ============================================================
// Pattern Recognition Algorithms (3 most reliable)
// ============================================================

/**
 * Detect Inverse Head and Shoulders (bottom reversal).
 *
 *   Pattern:
 *     - 3 troughs: left shoulder, head (lowest), right shoulder
 *     - Left and right shoulders approximately equal lows
 *     - Head is significantly lower
 *     - Neckline = line through 2 intermediate highs
 *     - Confirmation: breakout above neckline with volume
 */
export function detectInverseHeadAndShoulders(
  prices: number[],
  lookback = 60
): {
  detected: boolean;
  confidence: number; // 0-1
  left_shoulder_idx?: number;
  head_idx?: number;
  right_shoulder_idx?: number;
  neckline?: number;
  target_price?: number;
} {
  if (prices.length < lookback) return { detected: false, confidence: 0 };
  const slice = prices.slice(-lookback);

  // Find local minima (troughs) — points lower than 3 neighbors on each side
  const troughs: Array<{ idx: number; price: number }> = [];
  for (let i = 5; i < slice.length - 5; i += 1) {
    let is_local_min = true;
    for (let k = 1; k <= 3; k += 1) {
      if (slice[i] >= slice[i - k] || slice[i] >= slice[i + k]) {
        is_local_min = false;
        break;
      }
    }
    if (is_local_min) troughs.push({ idx: i, price: slice[i] });
  }

  if (troughs.length < 3) return { detected: false, confidence: 0 };

  // Try every consecutive triple
  let best_match: { confidence: number; ls: number; h: number; rs: number } | null = null;
  for (let a = 0; a < troughs.length - 2; a += 1) {
    for (let b = a + 1; b < troughs.length - 1; b += 1) {
      for (let c = b + 1; c < troughs.length; c += 1) {
        const ls = troughs[a].price;
        const h = troughs[b].price;
        const rs = troughs[c].price;
        // Head must be lowest
        if (h >= ls || h >= rs) continue;
        // Shoulders roughly equal (within 5%)
        const shoulder_diff = Math.abs(ls - rs) / ((ls + rs) / 2);
        if (shoulder_diff > 0.05) continue;
        // Head significantly lower (> 5% below shoulders)
        const avg_shoulder = (ls + rs) / 2;
        if ((avg_shoulder - h) / avg_shoulder < 0.05) continue;
        // Confidence based on closeness of shoulders + head depth
        const confidence =
          (1 - shoulder_diff) * Math.min(1, ((avg_shoulder - h) / avg_shoulder) * 10);
        if (!best_match || confidence > best_match.confidence) {
          best_match = { confidence, ls: troughs[a].idx, h: troughs[b].idx, rs: troughs[c].idx };
        }
      }
    }
  }

  if (!best_match) return { detected: false, confidence: 0 };

  // Compute neckline (highs between shoulders + head)
  const between_ls_h = slice.slice(best_match.ls + 1, best_match.h);
  const between_h_rs = slice.slice(best_match.h + 1, best_match.rs);
  const max_lh = Math.max(...between_ls_h);
  const max_hr = Math.max(...between_h_rs);
  const neckline = (max_lh + max_hr) / 2;
  // Target: neckline + (neckline - head)
  const target = neckline + (neckline - slice[best_match.h]);

  return {
    detected: true,
    confidence: best_match.confidence,
    left_shoulder_idx: best_match.ls,
    head_idx: best_match.h,
    right_shoulder_idx: best_match.rs,
    neckline,
    target_price: target,
  };
}

/**
 * Detect Triple Bottom.
 *
 *   3 approximately equal lows with intermediate rallies.
 */
export function detectTripleBottom(
  prices: number[],
  lookback = 60
): {
  detected: boolean;
  confidence: number;
  bottom_indices?: [number, number, number];
  resistance?: number;
} {
  if (prices.length < lookback) return { detected: false, confidence: 0 };
  const slice = prices.slice(-lookback);

  // Find local minima
  const troughs: Array<{ idx: number; price: number }> = [];
  for (let i = 5; i < slice.length - 5; i += 1) {
    let is_min = true;
    for (let k = 1; k <= 3; k += 1) {
      if (slice[i] >= slice[i - k] || slice[i] >= slice[i + k]) {
        is_min = false;
        break;
      }
    }
    if (is_min) troughs.push({ idx: i, price: slice[i] });
  }

  if (troughs.length < 3) return { detected: false, confidence: 0 };

  // Find 3 consecutive troughs at similar prices (within 3%)
  for (let a = 0; a < troughs.length - 2; a += 1) {
    for (let b = a + 1; b < troughs.length - 1; b += 1) {
      for (let c = b + 1; c < troughs.length; c += 1) {
        const prices_3 = [troughs[a].price, troughs[b].price, troughs[c].price];
        const avg = (prices_3[0] + prices_3[1] + prices_3[2]) / 3;
        const max_diff = Math.max(...prices_3) - Math.min(...prices_3);
        if (max_diff / avg > 0.03) continue;
        // Compute resistance: max in between
        const between = slice.slice(troughs[a].idx, troughs[c].idx + 1);
        const resistance = Math.max(...between);
        return {
          detected: true,
          confidence: 1 - max_diff / avg / 0.03,
          bottom_indices: [troughs[a].idx, troughs[b].idx, troughs[c].idx],
          resistance,
        };
      }
    }
  }

  return { detected: false, confidence: 0 };
}

/**
 * Detect Cup and Handle.
 *
 *   Pattern:
 *     - "Cup" = U-shaped bottom over 7-65 weeks
 *     - "Handle" = mild pullback after right rim, 5-15% retracement
 *     - Breakout above rim with volume = signal
 *
 *   Simplified detection: find rounded bottom + slight pullback.
 */
export function detectCupAndHandle(
  prices: number[],
  min_cup_length = 30
): {
  detected: boolean;
  cup_left_rim?: number;
  cup_bottom?: number;
  cup_right_rim?: number;
  handle_low?: number;
  breakout_target?: number;
} {
  if (prices.length < min_cup_length) return { detected: false };
  const left_idx = 0;
  const right_idx = prices.length - 5; // last 5 days = handle area

  const cup_prices = prices.slice(left_idx, right_idx);
  const left_rim_price = cup_prices[0];
  const right_rim_price = cup_prices[cup_prices.length - 1];
  // Rims similar (within 10%)
  if (Math.abs(left_rim_price - right_rim_price) / left_rim_price > 0.1) return { detected: false };

  const cup_bottom = Math.min(...cup_prices);
  const cup_bottom_idx = cup_prices.indexOf(cup_bottom);
  // Bottom should be 12-50% below rims
  const depth =
    (Math.min(left_rim_price, right_rim_price) - cup_bottom) /
    Math.min(left_rim_price, right_rim_price);
  if (depth < 0.12 || depth > 0.5) return { detected: false };
  // Bottom in middle 50%
  if (cup_bottom_idx < cup_prices.length * 0.25 || cup_bottom_idx > cup_prices.length * 0.75)
    return { detected: false };

  // Handle: last 5 days, small pullback
  const handle_prices = prices.slice(right_idx);
  const handle_low = Math.min(...handle_prices);
  const handle_retrace = (right_rim_price - handle_low) / right_rim_price;
  if (handle_retrace > 0.15 || handle_retrace < 0.02) return { detected: false };

  // Breakout target = rim + depth
  const breakout_target = right_rim_price + (right_rim_price - cup_bottom);

  return {
    detected: true,
    cup_left_rim: left_rim_price,
    cup_bottom,
    cup_right_rim: right_rim_price,
    handle_low,
    breakout_target,
  };
}
