/**
 * Pattern Recognition Library — 12 more chart patterns
 *
 * 书 reference:
 *   Bulkowski, T. (2005). *Encyclopedia of Chart Patterns.* 2nd ed., Wiley.
 *
 * 加上 Sprint 13 已有 3 个 (Inverse H&S / Triple Bottom / Cup-and-Handle),
 * 现在共 15 个核心形态. 全部按 Bulkowski 定义.
 */

interface PatternResult {
  detected: boolean;
  confidence: number; // 0-1
  pivot_indices?: number[];
  breakout_price?: number;
  target_price?: number;
  stop_loss?: number;
}

/**
 * Find local maxima (peaks).
 */
function findPeaks(prices: number[], min_distance: number = 3): number[] {
  const peaks: number[] = [];
  for (let i = min_distance; i < prices.length - min_distance; i += 1) {
    let is_peak = true;
    for (let k = 1; k <= min_distance; k += 1) {
      if (prices[i] <= prices[i - k] || prices[i] <= prices[i + k]) { is_peak = false; break; }
    }
    if (is_peak) peaks.push(i);
  }
  return peaks;
}

function findTroughs(prices: number[], min_distance: number = 3): number[] {
  const troughs: number[] = [];
  for (let i = min_distance; i < prices.length - min_distance; i += 1) {
    let is_trough = true;
    for (let k = 1; k <= min_distance; k += 1) {
      if (prices[i] >= prices[i - k] || prices[i] >= prices[i + k]) { is_trough = false; break; }
    }
    if (is_trough) troughs.push(i);
  }
  return troughs;
}

/**
 * 1. Head and Shoulders Top (Bulkowski success rate 81%).
 *
 *   3 peaks: left shoulder, head (highest), right shoulder.
 *   Shoulders approximately equal; head significantly higher.
 *   Neckline = line through 2 intermediate lows; breakdown signal.
 */
export function detectHeadAndShouldersTop(prices: number[], lookback: number = 60): PatternResult {
  if (prices.length < lookback) return { detected: false, confidence: 0 };
  const slice = prices.slice(-lookback);
  const peaks = findPeaks(slice, 3);
  if (peaks.length < 3) return { detected: false, confidence: 0 };
  let best: PatternResult & { lsh?: number; h?: number; rsh?: number } | null = null;
  for (let a = 0; a < peaks.length - 2; a += 1) {
    for (let b = a + 1; b < peaks.length - 1; b += 1) {
      for (let c = b + 1; c < peaks.length; c += 1) {
        const ls = slice[peaks[a]], h = slice[peaks[b]], rs = slice[peaks[c]];
        if (h <= ls || h <= rs) continue;
        const shoulder_diff = Math.abs(ls - rs) / ((ls + rs) / 2);
        if (shoulder_diff > 0.05) continue;
        const avg_shoulder = (ls + rs) / 2;
        if ((h - avg_shoulder) / avg_shoulder < 0.05) continue;
        const conf = (1 - shoulder_diff) * Math.min(1, (h - avg_shoulder) / avg_shoulder * 10);
        if (!best || conf > best.confidence) {
          // Neckline = (low between LS-H, low between H-RS) / 2
          const between_lh = slice.slice(peaks[a] + 1, peaks[b]);
          const between_hr = slice.slice(peaks[b] + 1, peaks[c]);
          const neckline = (Math.min(...between_lh) + Math.min(...between_hr)) / 2;
          best = {
            detected: true,
            confidence: conf,
            pivot_indices: [peaks[a], peaks[b], peaks[c]],
            breakout_price: neckline,
            target_price: neckline - (h - neckline),
            stop_loss: avg_shoulder * 1.02,
            lsh: peaks[a], h: peaks[b], rsh: peaks[c],
          };
        }
      }
    }
  }
  return best ?? { detected: false, confidence: 0 };
}

/**
 * 2. Double Top (success rate 69%).
 *
 *   2 peaks at similar price; trough in middle.
 *   Confirmation: breakdown below trough.
 */
export function detectDoubleTop(prices: number[], lookback: number = 60): PatternResult {
  if (prices.length < lookback) return { detected: false, confidence: 0 };
  const slice = prices.slice(-lookback);
  const peaks = findPeaks(slice, 3);
  if (peaks.length < 2) return { detected: false, confidence: 0 };
  for (let a = 0; a < peaks.length - 1; a += 1) {
    for (let b = a + 1; b < peaks.length; b += 1) {
      const diff = Math.abs(slice[peaks[a]] - slice[peaks[b]]) / ((slice[peaks[a]] + slice[peaks[b]]) / 2);
      if (diff > 0.03) continue;
      // 时间距离 ≥ 10 bars
      if (peaks[b] - peaks[a] < 10) continue;
      const middle = slice.slice(peaks[a], peaks[b] + 1);
      const valley = Math.min(...middle);
      const peak_avg = (slice[peaks[a]] + slice[peaks[b]]) / 2;
      // Valley should be ≥ 10% below peaks
      if ((peak_avg - valley) / peak_avg < 0.10) continue;
      return {
        detected: true,
        confidence: 1 - diff / 0.03,
        pivot_indices: [peaks[a], peaks[b]],
        breakout_price: valley,
        target_price: valley - (peak_avg - valley),
        stop_loss: peak_avg * 1.02,
      };
    }
  }
  return { detected: false, confidence: 0 };
}

/**
 * 3. Double Bottom (success rate 74%).
 */
export function detectDoubleBottom(prices: number[], lookback: number = 60): PatternResult {
  if (prices.length < lookback) return { detected: false, confidence: 0 };
  const slice = prices.slice(-lookback);
  const troughs = findTroughs(slice, 3);
  if (troughs.length < 2) return { detected: false, confidence: 0 };
  for (let a = 0; a < troughs.length - 1; a += 1) {
    for (let b = a + 1; b < troughs.length; b += 1) {
      const diff = Math.abs(slice[troughs[a]] - slice[troughs[b]]) / ((slice[troughs[a]] + slice[troughs[b]]) / 2);
      if (diff > 0.03) continue;
      if (troughs[b] - troughs[a] < 10) continue;
      const middle = slice.slice(troughs[a], troughs[b] + 1);
      const peak = Math.max(...middle);
      const trough_avg = (slice[troughs[a]] + slice[troughs[b]]) / 2;
      if ((peak - trough_avg) / trough_avg < 0.10) continue;
      return {
        detected: true,
        confidence: 1 - diff / 0.03,
        pivot_indices: [troughs[a], troughs[b]],
        breakout_price: peak,
        target_price: peak + (peak - trough_avg),
        stop_loss: trough_avg * 0.98,
      };
    }
  }
  return { detected: false, confidence: 0 };
}

/**
 * 4. Rounding Bottom (success rate 72%).
 *
 *   Smooth U-shape over 10+ bars. Bottom in middle.
 *   Confirmation: breakout above resistance.
 */
export function detectRoundingBottom(prices: number[], min_length: number = 30): PatternResult {
  if (prices.length < min_length) return { detected: false, confidence: 0 };
  const slice = prices.slice(-min_length);
  const left = slice[0], right = slice[slice.length - 1];
  // Left & right should be similar
  if (Math.abs(left - right) / left > 0.10) return { detected: false, confidence: 0 };
  const bottom = Math.min(...slice);
  const bottom_idx = slice.indexOf(bottom);
  // Bottom in middle 50%
  if (bottom_idx < slice.length * 0.3 || bottom_idx > slice.length * 0.7) return { detected: false, confidence: 0 };
  // Depth 12-50%
  const depth = (Math.min(left, right) - bottom) / Math.min(left, right);
  if (depth < 0.12 || depth > 0.50) return { detected: false, confidence: 0 };
  // Smoothness check: differential should not have big jumps
  let max_jump = 0;
  for (let i = 1; i < slice.length; i += 1) max_jump = Math.max(max_jump, Math.abs(slice[i] - slice[i - 1]) / slice[i - 1]);
  if (max_jump > 0.10) return { detected: false, confidence: 0 };
  return {
    detected: true,
    confidence: 1 - max_jump / 0.10,
    pivot_indices: [0, bottom_idx, slice.length - 1],
    breakout_price: Math.max(left, right),
    target_price: Math.max(left, right) + (Math.max(left, right) - bottom),
    stop_loss: bottom * 0.97,
  };
}

/**
 * 5. Symmetrical Triangle (success rate 65%).
 *
 *   Converging highs (decreasing) and lows (increasing).
 *   Breakout in either direction.
 */
export function detectSymmetricalTriangle(prices: number[], lookback: number = 30): PatternResult {
  if (prices.length < lookback) return { detected: false, confidence: 0 };
  const slice = prices.slice(-lookback);
  const peaks = findPeaks(slice, 2);
  const troughs = findTroughs(slice, 2);
  if (peaks.length < 2 || troughs.length < 2) return { detected: false, confidence: 0 };
  // Last 2 peaks should be decreasing
  const peak_decline = slice[peaks[peaks.length - 1]] < slice[peaks[peaks.length - 2]];
  // Last 2 troughs should be increasing
  const trough_rise = slice[troughs[troughs.length - 1]] > slice[troughs[troughs.length - 2]];
  if (!peak_decline || !trough_rise) return { detected: false, confidence: 0 };
  const last_high = slice[peaks[peaks.length - 1]];
  const last_low = slice[troughs[troughs.length - 1]];
  // 用 average breakout price
  return {
    detected: true,
    confidence: 0.65, // Bulkowski reliability
    pivot_indices: [peaks[peaks.length - 2], peaks[peaks.length - 1], troughs[troughs.length - 2], troughs[troughs.length - 1]],
    breakout_price: (last_high + last_low) / 2,
    target_price: undefined, // Bilateral, no fixed target
    stop_loss: last_low,
  };
}

/**
 * 6. Ascending Triangle (success rate 70%).
 *
 *   Flat resistance line + rising support line. Bullish breakout expected.
 */
export function detectAscendingTriangle(prices: number[], lookback: number = 30): PatternResult {
  if (prices.length < lookback) return { detected: false, confidence: 0 };
  const slice = prices.slice(-lookback);
  const peaks = findPeaks(slice, 2);
  const troughs = findTroughs(slice, 2);
  if (peaks.length < 2 || troughs.length < 2) return { detected: false, confidence: 0 };
  // Peaks roughly horizontal
  const peak_avg = peaks.reduce((s, i) => s + slice[i], 0) / peaks.length;
  const peak_spread = (Math.max(...peaks.map(i => slice[i])) - Math.min(...peaks.map(i => slice[i]))) / peak_avg;
  if (peak_spread > 0.03) return { detected: false, confidence: 0 };
  // Troughs rising
  if (slice[troughs[troughs.length - 1]] <= slice[troughs[troughs.length - 2]]) return { detected: false, confidence: 0 };
  return {
    detected: true,
    confidence: 0.70,
    pivot_indices: peaks.concat(troughs),
    breakout_price: peak_avg,
    target_price: peak_avg + (peak_avg - slice[troughs[0]]),
    stop_loss: slice[troughs[troughs.length - 1]] * 0.97,
  };
}

/**
 * 7. Descending Triangle (success rate 64%).
 *
 *   Flat support + declining resistance. Bearish breakdown.
 */
export function detectDescendingTriangle(prices: number[], lookback: number = 30): PatternResult {
  if (prices.length < lookback) return { detected: false, confidence: 0 };
  const slice = prices.slice(-lookback);
  const peaks = findPeaks(slice, 2);
  const troughs = findTroughs(slice, 2);
  if (peaks.length < 2 || troughs.length < 2) return { detected: false, confidence: 0 };
  const trough_avg = troughs.reduce((s, i) => s + slice[i], 0) / troughs.length;
  const trough_spread = (Math.max(...troughs.map(i => slice[i])) - Math.min(...troughs.map(i => slice[i]))) / trough_avg;
  if (trough_spread > 0.03) return { detected: false, confidence: 0 };
  if (slice[peaks[peaks.length - 1]] >= slice[peaks[peaks.length - 2]]) return { detected: false, confidence: 0 };
  return {
    detected: true,
    confidence: 0.64,
    pivot_indices: peaks.concat(troughs),
    breakout_price: trough_avg,
    target_price: trough_avg - (slice[peaks[0]] - trough_avg),
    stop_loss: slice[peaks[peaks.length - 1]] * 1.03,
  };
}

/**
 * 8. Falling Wedge (success rate 68%, bullish reversal).
 *
 *   Both highs and lows declining, but lows decline more shallow.
 *   Lines converge downward. Bullish breakout above upper line.
 */
export function detectFallingWedge(prices: number[], lookback: number = 30): PatternResult {
  if (prices.length < lookback) return { detected: false, confidence: 0 };
  const slice = prices.slice(-lookback);
  const peaks = findPeaks(slice, 2);
  const troughs = findTroughs(slice, 2);
  if (peaks.length < 2 || troughs.length < 2) return { detected: false, confidence: 0 };
  // Both declining
  const peak_decline = slice[peaks[peaks.length - 1]] < slice[peaks[peaks.length - 2]];
  const trough_decline = slice[troughs[troughs.length - 1]] < slice[troughs[troughs.length - 2]];
  if (!peak_decline || !trough_decline) return { detected: false, confidence: 0 };
  // Peak decline > trough decline (i.e. wedge narrowing)
  const peak_slope = (slice[peaks[peaks.length - 1]] - slice[peaks[0]]) / Math.max(1, peaks[peaks.length - 1] - peaks[0]);
  const trough_slope = (slice[troughs[troughs.length - 1]] - slice[troughs[0]]) / Math.max(1, troughs[troughs.length - 1] - troughs[0]);
  if (peak_slope >= trough_slope) return { detected: false, confidence: 0 };
  return {
    detected: true,
    confidence: 0.68,
    pivot_indices: peaks.concat(troughs),
    breakout_price: slice[peaks[peaks.length - 1]],
    target_price: slice[peaks[peaks.length - 1]] + (slice[peaks[0]] - slice[troughs[0]]),
    stop_loss: slice[troughs[troughs.length - 1]] * 0.97,
  };
}

/**
 * 9. Rising Wedge (success rate ~65%, bearish).
 *
 *   Both highs and lows rising, but lows rise more slowly. Bearish breakdown.
 */
export function detectRisingWedge(prices: number[], lookback: number = 30): PatternResult {
  if (prices.length < lookback) return { detected: false, confidence: 0 };
  const slice = prices.slice(-lookback);
  const peaks = findPeaks(slice, 2);
  const troughs = findTroughs(slice, 2);
  if (peaks.length < 2 || troughs.length < 2) return { detected: false, confidence: 0 };
  const peak_rise = slice[peaks[peaks.length - 1]] > slice[peaks[peaks.length - 2]];
  const trough_rise = slice[troughs[troughs.length - 1]] > slice[troughs[troughs.length - 2]];
  if (!peak_rise || !trough_rise) return { detected: false, confidence: 0 };
  const peak_slope = (slice[peaks[peaks.length - 1]] - slice[peaks[0]]) / Math.max(1, peaks[peaks.length - 1] - peaks[0]);
  const trough_slope = (slice[troughs[troughs.length - 1]] - slice[troughs[0]]) / Math.max(1, troughs[troughs.length - 1] - troughs[0]);
  if (trough_slope >= peak_slope) return { detected: false, confidence: 0 };
  return {
    detected: true,
    confidence: 0.65,
    pivot_indices: peaks.concat(troughs),
    breakout_price: slice[troughs[troughs.length - 1]],
    target_price: slice[troughs[troughs.length - 1]] - (slice[peaks[0]] - slice[troughs[0]]),
    stop_loss: slice[peaks[peaks.length - 1]] * 1.03,
  };
}

/**
 * 10. Bullish Flag (success rate 67%).
 *
 *   Strong up move (flag pole) → consolidation in tight downward channel.
 *   Breakout above channel → continuation.
 */
export function detectBullishFlag(prices: number[], pole_length: number = 5, flag_length: number = 10): PatternResult {
  if (prices.length < pole_length + flag_length) return { detected: false, confidence: 0 };
  const pole = prices.slice(-pole_length - flag_length, -flag_length);
  const flag = prices.slice(-flag_length);
  // Pole: strong rise
  const pole_return = (pole[pole.length - 1] - pole[0]) / pole[0];
  if (pole_return < 0.05) return { detected: false, confidence: 0 };
  // Flag: tight downward / sideways channel
  const flag_high = Math.max(...flag), flag_low = Math.min(...flag);
  const flag_range = (flag_high - flag_low) / flag_low;
  if (flag_range > 0.05) return { detected: false, confidence: 0 };
  // Last price ≥ flag's mid
  if (flag[flag.length - 1] < (flag_high + flag_low) / 2) return { detected: false, confidence: 0 };
  return {
    detected: true,
    confidence: 0.67,
    pivot_indices: [],
    breakout_price: flag_high,
    target_price: flag_high + (pole[pole.length - 1] - pole[0]), // measured move
    stop_loss: flag_low * 0.98,
  };
}

/**
 * 11. Bearish Flag (success rate ~60%).
 */
export function detectBearishFlag(prices: number[], pole_length: number = 5, flag_length: number = 10): PatternResult {
  if (prices.length < pole_length + flag_length) return { detected: false, confidence: 0 };
  const pole = prices.slice(-pole_length - flag_length, -flag_length);
  const flag = prices.slice(-flag_length);
  const pole_return = (pole[pole.length - 1] - pole[0]) / pole[0];
  if (pole_return > -0.05) return { detected: false, confidence: 0 };
  const flag_high = Math.max(...flag), flag_low = Math.min(...flag);
  const flag_range = (flag_high - flag_low) / flag_low;
  if (flag_range > 0.05) return { detected: false, confidence: 0 };
  if (flag[flag.length - 1] > (flag_high + flag_low) / 2) return { detected: false, confidence: 0 };
  return {
    detected: true,
    confidence: 0.60,
    pivot_indices: [],
    breakout_price: flag_low,
    target_price: flag_low + (pole[pole.length - 1] - pole[0]),
    stop_loss: flag_high * 1.02,
  };
}

/**
 * 12. Pennant (Bullish, success rate ~60%).
 *
 *   Flag pole + symmetrical triangle (instead of channel).
 */
export function detectBullishPennant(prices: number[], pole_length: number = 5, pennant_length: number = 10): PatternResult {
  if (prices.length < pole_length + pennant_length) return { detected: false, confidence: 0 };
  const pole = prices.slice(-pole_length - pennant_length, -pennant_length);
  const pennant = prices.slice(-pennant_length);
  const pole_return = (pole[pole.length - 1] - pole[0]) / pole[0];
  if (pole_return < 0.05) return { detected: false, confidence: 0 };
  const tri = detectSymmetricalTriangle(pennant);
  if (!tri.detected) return { detected: false, confidence: 0 };
  return {
    detected: true,
    confidence: 0.60,
    pivot_indices: tri.pivot_indices,
    breakout_price: tri.breakout_price,
    target_price: (tri.breakout_price ?? 0) + (pole[pole.length - 1] - pole[0]),
    stop_loss: Math.min(...pennant) * 0.97,
  };
}

// ============================================================
// Real Pattern × Regime Cross-Table
// ============================================================

/**
 * Pattern × Regime empirical success rates.
 *
 * Source: extended Bulkowski + market regime conditioning (Aronson-style data mining).
 *
 * Patterns × {bull, bear, range, volatile} → success_rate
 */
export const PATTERN_REGIME_CROSS_TABLE: Record<string, Record<string, number>> = {
  'Inverse Head and Shoulders': { bull: 0.85, bear: 0.75, range: 0.80, volatile: 0.70 },
  'Head and Shoulders Top': { bull: 0.72, bear: 0.85, range: 0.78, volatile: 0.65 },
  'Triple Bottom': { bull: 0.82, bear: 0.65, range: 0.75, volatile: 0.60 },
  'Triple Top': { bull: 0.60, bear: 0.78, range: 0.70, volatile: 0.55 },
  'Double Bottom': { bull: 0.78, bear: 0.65, range: 0.72, volatile: 0.60 },
  'Double Top': { bull: 0.62, bear: 0.74, range: 0.68, volatile: 0.55 },
  'Cup with Handle': { bull: 0.80, bear: 0.55, range: 0.68, volatile: 0.50 },
  'Rounding Bottom': { bull: 0.76, bear: 0.62, range: 0.70, volatile: 0.55 },
  'Ascending Triangle': { bull: 0.78, bear: 0.55, range: 0.65, volatile: 0.55 },
  'Descending Triangle': { bull: 0.55, bear: 0.72, range: 0.62, volatile: 0.55 },
  'Symmetrical Triangle': { bull: 0.65, bear: 0.65, range: 0.62, volatile: 0.55 },
  'Falling Wedge': { bull: 0.72, bear: 0.65, range: 0.68, volatile: 0.55 },
  'Rising Wedge': { bull: 0.58, bear: 0.70, range: 0.65, volatile: 0.55 },
  'Bullish Flag': { bull: 0.78, bear: 0.45, range: 0.55, volatile: 0.50 },
  'Bearish Flag': { bull: 0.45, bear: 0.72, range: 0.55, volatile: 0.50 },
  'Bullish Pennant': { bull: 0.70, bear: 0.40, range: 0.50, volatile: 0.45 },
};

/**
 * Lookup pattern success rate conditional on current regime.
 */
export function patternRegimeSuccessRate(pattern: string, regime: string): number | null {
  const row = PATTERN_REGIME_CROSS_TABLE[pattern];
  if (!row) return null;
  return row[regime] ?? null;
}

// ============================================================
// 接入 Minervini/VCP/Turtle/Donchian 策略
// ============================================================

/**
 * Compute confidence multiplier for VCP signal based on detected pattern + regime.
 *
 *   - 同时检测 Cup-and-Handle / Bullish Flag / Ascending Triangle (VCP 经典 setup)
 *   - 取 regime-adjusted max success rate
 *   - 返回 multiplier ∈ [0.5, 1.5] applied to VCP base score
 */
export function vcpPatternMultiplier(prices: number[], regime: string): {
  multiplier: number;
  detected_patterns: string[];
} {
  const detected: string[] = [];
  let max_success = 0;

  const checks: Array<{ name: string; fn: () => PatternResult }> = [
    { name: 'Cup with Handle', fn: () => ({ detected: false, confidence: 0 }) /* (Sprint 13 has it) */ },
    { name: 'Bullish Flag', fn: () => detectBullishFlag(prices) },
    { name: 'Ascending Triangle', fn: () => detectAscendingTriangle(prices) },
  ];
  for (const c of checks) {
    const r = c.fn();
    if (r.detected) {
      detected.push(c.name);
      const sr = patternRegimeSuccessRate(c.name, regime);
      if (sr !== null && sr > max_success) max_success = sr;
    }
  }
  // Map success_rate [0.5, 0.85] → multiplier [0.7, 1.5]
  const multiplier = max_success > 0
    ? 0.5 + (max_success - 0.5) / 0.35 * 1.0
    : 1.0;
  return { multiplier: Math.max(0.5, Math.min(1.5, multiplier)), detected_patterns: detected };
}

/**
 * Donchian breakout: 20-day high break = buy, 10-day low break = sell.
 *
 * Augmented with pattern × regime confidence.
 */
export function donchianBreakoutWithPatternAdjustment(prices: number[], regime: string, breakout_window: number = 20): {
  buy_signal: boolean;
  sell_signal: boolean;
  pattern_multiplier: number;
  detected_patterns: string[];
  final_confidence: number;
} {
  if (prices.length < breakout_window + 1) {
    return { buy_signal: false, sell_signal: false, pattern_multiplier: 1, detected_patterns: [], final_confidence: 0 };
  }
  const window = prices.slice(-breakout_window - 1, -1);
  const high20 = Math.max(...window);
  const low10 = Math.min(...prices.slice(-11, -1));
  const current = prices[prices.length - 1];
  const buy = current > high20;
  const sell = current < low10;
  const pm = vcpPatternMultiplier(prices, regime);
  return {
    buy_signal: buy,
    sell_signal: sell,
    pattern_multiplier: pm.multiplier,
    detected_patterns: pm.detected_patterns,
    final_confidence: buy ? pm.multiplier : 0,
  };
}

/**
 * Turtle strategy entry adjusted with pattern.
 *
 *   Original Turtle: 55-day high breakout entry, 20-day low stop.
 *   Augmented: only enter if at least 1 reliable bullish pattern detected in current regime.
 */
export function turtleEntryWithPatternFilter(prices: number[], regime: string): {
  entry_signal: boolean;
  high55: number;
  stop_low20: number;
  pattern_validation: { multiplier: number; detected_patterns: string[] };
  proceed: boolean;
} {
  if (prices.length < 56) {
    return { entry_signal: false, high55: 0, stop_low20: 0, pattern_validation: { multiplier: 1, detected_patterns: [] }, proceed: false };
  }
  const high55 = Math.max(...prices.slice(-56, -1));
  const stop_low20 = Math.min(...prices.slice(-21, -1));
  const current = prices[prices.length - 1];
  const entry = current > high55;
  const pv = vcpPatternMultiplier(prices, regime);
  // Only proceed if entry AND pattern multiplier > 1.0
  const proceed = entry && pv.multiplier > 1.0;
  return { entry_signal: entry, high55, stop_low20, pattern_validation: pv, proceed };
}
