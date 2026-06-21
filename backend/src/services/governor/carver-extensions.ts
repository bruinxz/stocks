/**
 * Carver Buffer Zones + Forecast Scaling (Systematic Trading)
 *
 * 书 reference:
 *   Carver, R. (2015). *Systematic Trading: A unique new method for designing
 *   trading and investing systems.* Harriman House.
 *   Chapter 7: "Forecasts"
 *   Chapter 8: "Volatility Targeting"
 *   Chapter 9: "Position Sizing"
 *
 * **Forecast Scaling (Ch.7)**：
 *
 *   不同策略输出的 raw forecast 单位不一致 (一个策略 score 0-100，另一个
 *   z-score -3 ~ +3，第三个原始 alpha 0.001-0.05)。直接 sum 等于乱来。
 *
 *   Carver 提出：每个策略 forecast normalize 到 absolute_mean = 10
 *
 *     scaled = raw × (10 / avg(|raw|))                            (Eq.7.5)
 *
 *   capped at ±20 (Ch.7.4)：
 *
 *     final = max(-20, min(20, scaled))                          (Eq.7.7)
 *
 *   这样：
 *     - forecast = +10 表示"平均做多信号"
 *     - forecast = +20 表示"极强做多信号" (rare, top 5% of historical)
 *     - forecast = 0 表示"中性"
 *     - 多策略 forecasts 可以直接加权 sum (用 forecast_diversification_multiplier)
 *
 * **Buffer Zones (Ch.15)**：
 *
 *   避免 forecast 在阈值附近反复横跳导致的高换手摩擦 cost。
 *
 *   旧逻辑（无 buffer）:
 *     position = forecast × position_per_unit
 *     forecast=10 → 全仓；forecast=9.9 → 99% 仓位 → 卖出 1%
 *     forecast=10.1 → 全仓 → 又买回 1% → 频繁换手
 *
 *   新逻辑 (Ch.15.4):
 *     buffer = position × buffer_width  (默认 0.10)
 *     如果 |current_position - target| > buffer → 调到 target ± buffer
 *     否则 → 不调
 *
 *   效果：当 target 在 (current - buffer, current + buffer) 之间漂移，仓位不动。
 *   只有当 target 超出 buffer，才把仓位调到 buffer 边缘 (而非完全跟踪 target)。
 *
 * **集成到 Governor**:
 *
 *   原 Governor 是硬切换 5 档 (healthy / cautious / defensive / critical / observe_only)。
 *
 *   v2 改进:
 *     1. 计算 raw_multiplier = sigmoid-like function of drawdown / sharpe
 *     2. 用 buffer zone: 当 raw_multiplier 距上次 multiplier 距离 < buffer 时，
 *        保持上次值；否则更新
 *     3. 这样不会因为 drawdown 在 5.9% / 6.1% 来回横跳就切来切去
 */

// ============================================================
// Forecast Scaling
// ============================================================

export const FORECAST_TARGET_ABS_MEAN = 10;
export const FORECAST_CAP = 20;

/**
 * Compute forecast scalar from historical raw forecasts.
 *
 * scalar = TARGET_ABS_MEAN / avg(|raw|)
 *
 * Caller 应用 historical sample (e.g. last 252 trading days) 算出 scalar，
 * 然后保存到 strategy config；后续每天直接用这个 scalar。
 */
export function computeForecastScalar(raw_forecasts: number[]): number {
  const validVals = raw_forecasts.filter(v => Number.isFinite(v));
  if (validVals.length === 0) return 1;
  const absMean = validVals.reduce((s, v) => s + Math.abs(v), 0) / validVals.length;
  if (absMean <= 0) return 1;
  return FORECAST_TARGET_ABS_MEAN / absMean;
}

/**
 * Apply forecast scalar + cap.
 *
 *   scaled = raw × scalar
 *   final = clamp(scaled, -FORECAST_CAP, +FORECAST_CAP)
 */
export function applyForecastScalar(raw: number, scalar: number): number {
  const scaled = raw * scalar;
  return Math.max(-FORECAST_CAP, Math.min(FORECAST_CAP, scaled));
}

/**
 * Sum multiple scaled forecasts to a single combined forecast.
 *
 * Carver 推荐用 forecast_diversification_multiplier (FDM) 抵消 diversification 损失：
 *   combined = (Σ weight_i × scaled_i) × FDM
 *
 * 简化：FDM = 1 / √(weights^T · corr_matrix · weights)
 *      但小规模可用 fixed FDM = 1.2-1.5 (Carver Ch.7.7)
 */
export function combineScaledForecasts(
  scaled_forecasts: number[],
  weights?: number[],
  fdm = 1.2
): number {
  if (scaled_forecasts.length === 0) return 0;
  const N = scaled_forecasts.length;
  const w = weights ?? new Array(N).fill(1 / N);
  if (w.length !== N)
    throw new Error(`combineScaledForecasts: weights length ${w.length} != forecasts ${N}`);
  let sum = 0;
  for (let i = 0; i < N; i += 1) {
    if (Number.isFinite(scaled_forecasts[i])) sum += w[i] * scaled_forecasts[i];
  }
  const combined = sum * fdm;
  return Math.max(-FORECAST_CAP, Math.min(FORECAST_CAP, combined));
}

// ============================================================
// Buffer Zones (Ch.15)
// ============================================================

export const DEFAULT_BUFFER_WIDTH = 0.1;

/**
 * Apply buffer zone to position update.
 *
 * 算法 (Carver Ch.15.4):
 *   target_position = forecast × pos_per_unit (caller computes)
 *
 *   if |current - target| <= buffer × |target|:
 *     return current (no change)
 *   elif current < target:
 *     return target - buffer × |target|  (买到 buffer 下边)
 *   else:  # current > target
 *     return target + buffer × |target|  (卖到 buffer 上边)
 *
 * 这样调仓金额最小化：不完全跟踪 target，只调到 buffer 边缘。
 */
export function applyBufferZone(
  current_position: number,
  target_position: number,
  buffer_width = DEFAULT_BUFFER_WIDTH
): number {
  const buffer = Math.abs(target_position) * buffer_width;
  const diff = target_position - current_position;
  if (Math.abs(diff) <= buffer) {
    return current_position;
  }
  // 调到 buffer 边缘
  if (diff > 0) {
    // current < target → buy 但 only to (target - buffer)
    return target_position - buffer;
  } else {
    // current > target → sell 但 only to (target + buffer)
    return target_position + buffer;
  }
}

/**
 * Apply buffer zone to multiplier (Governor v2 用)
 *
 * 一样的逻辑但用于 0-1 Kelly multiplier。
 * 当 raw_multiplier 与 prev_multiplier 接近 (< buffer), 不变。
 */
export function applyMultiplierBuffer(
  prev_multiplier: number,
  raw_multiplier: number,
  buffer_width = 0.1
): number {
  return applyBufferZone(prev_multiplier, raw_multiplier, buffer_width);
}

// ============================================================
// Continuous multiplier function (v2 alternative to discrete 5 tiers)
// ============================================================

/**
 * Continuous multiplier from drawdown + sharpe (no discrete tiers).
 *
 * 设计原则:
 *   - drawdown = 0%  → multiplier = 1.0
 *   - drawdown = 10% → multiplier = 0.7 (cautious 区间中点)
 *   - drawdown = 20% → multiplier = 0.4
 *   - drawdown = 30% → multiplier = 0.2
 *   - drawdown = 40% → multiplier = 0.0
 *
 * 公式: multiplier_dd = max(0, 1 - 2.5 × drawdown)
 *
 *   - 然后用 sharpe modulate: low_sharpe penalty
 *     sharpe_factor = clamp((sharpe + 1) / 2, 0, 1)  -- sharpe=-1 → 0, sharpe=1 → 1
 *
 *   - final = multiplier_dd × sharpe_factor
 */
export function continuousMultiplier(drawdown_pct: number, sharpe: number | null): number {
  const dd = Math.max(0, drawdown_pct);
  const mult_dd = Math.max(0, 1 - 2.5 * dd);
  const sharpe_factor =
    sharpe === null || !Number.isFinite(sharpe) ? 1.0 : Math.max(0, Math.min(1, (sharpe + 1) / 2));
  return Math.max(0, Math.min(1, mult_dd * sharpe_factor));
}
