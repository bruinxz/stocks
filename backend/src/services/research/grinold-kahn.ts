/**
 * Grinold-Kahn Fundamental Law of Active Management
 *
 * 论文 reference:
 *   Grinold, R. C. and Kahn, R. N. (2000). *Active Portfolio Management:
 *   A Quantitative Approach for Providing Superior Returns and Controlling Risk.*
 *   2nd ed., McGraw-Hill. Chapter 5: "Information Ratio Building".
 *   Chapter 6: "Forecasting".
 *
 *   Clarke, R., De Silva, H., and Thorley, S. (2002). "Portfolio Constraints
 *   and the Fundamental Law of Active Management."
 *   Financial Analysts Journal 58(5), 48-66. (Transfer Coefficient extension)
 *
 * **Fundamental Law (Grinold 1989)**:
 *
 *     IR = IC × √Breadth                                  (Eq.5.4)
 *
 *   其中:
 *     IR = Information Ratio = alpha / tracking_error
 *     IC = Information Coefficient = corr(forecast, actual_return)
 *     Breadth = N (独立预测次数)
 *
 *   解读:
 *     - IC = 0.05 (典型 alpha 因子)
 *     - Breadth = 100 (覆盖 100 只股票, 月度调仓)
 *     - IR = 0.05 × 10 = 0.5
 *
 *     提升 IR 要么提升 IC (信号质量), 要么扩 Breadth (覆盖更多机会).
 *
 * **Extended Law (Clarke-De Silva-Thorley 2002)**:
 *
 *     IR = TC × IC × √Breadth
 *
 *   其中 TC = Transfer Coefficient = corr(weights, ideal_weights)
 *
 *   TC 反映 portfolio constraints (long-only, position limit, sector cap) 对 IR 的折损:
 *     - TC = 1.0: 无约束 (long-short, unconstrained)
 *     - TC = 0.5: 典型 long-only mutual fund
 *     - TC = 0.3: 重度约束 (大 sector cap + position limit)
 *
 * **IC Decay (Section 6.3)**:
 *
 *   信号在不同 horizon 上的 IC:
 *
 *     IC(1d), IC(5d), IC(20d), IC(60d), IC(120d)
 *
 *   typically IC(20d) > IC(60d) > IC(120d) — 信号衰减
 *   half_life = horizon where IC decays to IC(t=0) / 2
 *
 *   实务意义:
 *     - IC(1d) > 0, IC(20d) = 0: 短线信号, 必须高频换仓
 *     - IC(60d) ≈ IC(20d): 长效信号, 月度换仓即可
 *
 * **本实现**:
 *   - computeIC(forecasts, returns) — Pearson/Spearman corr
 *   - computeFundamentalLaw(ic, breadth, tc) — IR 估算
 *   - computeICDecay(forecasts, returns_by_horizon) — IC vs horizon 曲线
 *   - estimateHalfLife(ic_decay) — IC 衰减半衰期
 *   - computeTransferCoefficient(weights, ideal_weights) — TC 测量
 */

/**
 * Pearson correlation coefficient (与 OverfitMetrics 一致)
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return NaN;
  const valid: Array<[number, number]> = [];
  for (let i = 0; i < x.length; i += 1) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) valid.push([x[i], y[i]]);
  }
  if (valid.length < 2) return NaN;
  const mX = valid.reduce((s, p) => s + p[0], 0) / valid.length;
  const mY = valid.reduce((s, p) => s + p[1], 0) / valid.length;
  let num = 0, dX = 0, dY = 0;
  for (const [xi, yi] of valid) {
    num += (xi - mX) * (yi - mY);
    dX += (xi - mX) ** 2;
    dY += (yi - mY) ** 2;
  }
  return dX * dY > 0 ? num / Math.sqrt(dX * dY) : 0;
}

/**
 * Spearman rank correlation (更稳健, 用于 cross-sectional IC)
 */
export function spearmanCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return NaN;
  const valid: Array<[number, number]> = [];
  for (let i = 0; i < x.length; i += 1) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) valid.push([x[i], y[i]]);
  }
  if (valid.length < 2) return NaN;
  // rank
  const ranksX = computeRanks(valid.map(p => p[0]));
  const ranksY = computeRanks(valid.map(p => p[1]));
  return pearsonCorrelation(ranksX, ranksY);
}

function computeRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length).fill(0);
  for (let r = 0; r < indexed.length; r += 1) {
    ranks[indexed[r].i] = r + 1;
  }
  return ranks;
}

/**
 * Information Coefficient (IC)
 *
 * @param forecasts cross-sectional forecasts (N stocks)
 * @param returns realized returns for same stocks (N)
 * @param method 'pearson' or 'spearman' (default spearman, more robust)
 */
export function computeIC(
  forecasts: number[],
  returns: number[],
  method: 'pearson' | 'spearman' = 'spearman'
): number {
  return method === 'pearson' ? pearsonCorrelation(forecasts, returns) : spearmanCorrelation(forecasts, returns);
}

/**
 * IR from Grinold's Fundamental Law (Eq.5.4)
 *
 *   IR = IC × √Breadth
 *
 * Optional Transfer Coefficient extension (Clarke-De Silva-Thorley 2002):
 *
 *   IR = TC × IC × √Breadth
 */
export function computeFundamentalLawIR(input: {
  ic: number;
  breadth: number;
  transfer_coefficient?: number;
}): number {
  const tc = input.transfer_coefficient ?? 1.0;
  if (!Number.isFinite(input.ic) || input.breadth < 1) return NaN;
  return tc * input.ic * Math.sqrt(input.breadth);
}

/**
 * Transfer Coefficient
 *
 *   TC = corr(actual_weights, ideal_weights)
 *
 * @param actual_weights 受约束实际权重 (N)
 * @param ideal_weights 无约束 optimal 权重 (N)
 */
export function computeTransferCoefficient(actual_weights: number[], ideal_weights: number[]): number {
  return pearsonCorrelation(actual_weights, ideal_weights);
}

/**
 * IC by horizon (decay analysis)
 *
 * 输入:
 *   forecasts: 入场时点的 forecasts (N stocks, 各自 1 个 forecast)
 *   returns_by_horizon: { '1d': [...], '5d': [...], '20d': [...], '60d': [...] }
 *     每个 horizon 是 N 个 stock 在该 horizon 上的 realized return.
 *
 * 输出: 每个 horizon 的 IC.
 */
export function computeICDecay(
  forecasts: number[],
  returns_by_horizon: Record<string, number[]>,
  method: 'pearson' | 'spearman' = 'spearman'
): Array<{ horizon: string; ic: number; n_samples: number }> {
  return Object.entries(returns_by_horizon).map(([h, rets]) => ({
    horizon: h,
    ic: computeIC(forecasts, rets, method),
    n_samples: rets.length,
  }));
}

/**
 * Estimate IC half-life from decay curve (fit exponential decay)
 *
 *   IC(t) = IC(0) · exp(-λ·t)
 *
 *   half_life = ln(2) / λ
 *
 * 取 log: ln IC(t) = ln IC(0) - λ·t
 * → OLS regress ln IC on t → -slope = λ
 *
 * 边界:
 *   - 任一 IC ≤ 0 → 跳过 (无法取 log)
 *   - 拟合点 < 3 → 返回 NaN
 *
 * @param decay [{horizon_days, ic}] sorted by horizon ASC
 */
export function estimateICHalfLife(decay: Array<{ horizon_days: number; ic: number }>): {
  half_life_days: number;
  decay_rate: number;
  ic_initial: number;
  r_squared: number;
  is_estimable: boolean;
} {
  const valid = decay.filter(d => d.ic > 0 && Number.isFinite(d.ic));
  if (valid.length < 3) {
    return { half_life_days: NaN, decay_rate: NaN, ic_initial: NaN, r_squared: NaN, is_estimable: false };
  }
  const t = valid.map(d => d.horizon_days);
  const lnIC = valid.map(d => Math.log(d.ic));
  // 用前一个已有的 olsRegression
  // 复制简版，避免 cross-file import
  const N = t.length;
  const mT = t.reduce((s, v) => s + v, 0) / N;
  const mL = lnIC.reduce((s, v) => s + v, 0) / N;
  let num = 0, dT = 0, dL = 0;
  for (let i = 0; i < N; i += 1) {
    num += (t[i] - mT) * (lnIC[i] - mL);
    dT += (t[i] - mT) ** 2;
    dL += (lnIC[i] - mL) ** 2;
  }
  if (dT < 1e-12) return { half_life_days: NaN, decay_rate: NaN, ic_initial: NaN, r_squared: NaN, is_estimable: false };
  const slope = num / dT;
  const intercept = mL - slope * mT;
  const decayRate = -slope; // positive lambda
  const halfLife = decayRate > 0 ? Math.log(2) / decayRate : Infinity;
  const r2 = dL > 0 ? (num * num) / (dT * dL) : 0;
  return {
    half_life_days: halfLife,
    decay_rate: decayRate,
    ic_initial: Math.exp(intercept),
    r_squared: r2,
    is_estimable: true,
  };
}

/**
 * Information Ratio from realized active returns (sanity check vs Fundamental Law)
 *
 *   IR_realized = mean(alpha) / std(alpha)  × √annualization
 *
 *   alpha = portfolio_return - benchmark_return
 *
 * @param active_returns alpha series (per period)
 * @param periods_per_year e.g. 252 daily, 12 monthly
 */
export function computeRealizedIR(active_returns: number[], periods_per_year: number = 252): number {
  const valid = active_returns.filter(v => Number.isFinite(v));
  if (valid.length < 2) return NaN;
  const m = valid.reduce((s, v) => s + v, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + (v - m) ** 2, 0) / (valid.length - 1);
  const sd = Math.sqrt(variance);
  if (sd < 1e-12) return 0;
  return (m / sd) * Math.sqrt(periods_per_year);
}

/**
 * IC time-series stats (mean, std, IR-like ratio for IC)
 *
 *   IC_IR = mean(IC_t) / std(IC_t)
 *
 *   IC_t 在不同时段计算 (e.g. monthly cross-sectional IC).
 *
 *   IC_IR > 0.5 视为稳定 alpha 因子.
 */
export function computeICTimeSeriesStats(ic_series: number[]): {
  mean_ic: number;
  std_ic: number;
  ic_ir: number;
  positive_ratio: number;
  n_periods: number;
} {
  const valid = ic_series.filter(v => Number.isFinite(v));
  if (valid.length < 2) {
    return { mean_ic: NaN, std_ic: NaN, ic_ir: NaN, positive_ratio: NaN, n_periods: valid.length };
  }
  const m = valid.reduce((s, v) => s + v, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + (v - m) ** 2, 0) / (valid.length - 1);
  const sd = Math.sqrt(variance);
  const posRatio = valid.filter(v => v > 0).length / valid.length;
  return {
    mean_ic: m,
    std_ic: sd,
    ic_ir: sd > 1e-12 ? m / sd : 0,
    positive_ratio: posRatio,
    n_periods: valid.length,
  };
}
