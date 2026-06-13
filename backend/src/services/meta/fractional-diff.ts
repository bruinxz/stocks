/**
 * Fractional Differentiation (AFML Ch.5)
 *
 * 论文 reference:
 *   López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
 *   Chapter 5: "Fractionally Differentiated Features"
 *   Section 5.4 "Expanding Window FFD" + Section 5.5 "Fixed-Width Window FFD"
 *
 * **核心问题**:
 *
 *   传统机器学习要求 features stationary (ADF test pass)。
 *   股价时间序列高度 non-stationary（trend + drift）。
 *
 *   常规解法: 一阶差分 ΔX[t] = X[t] - X[t-1] → stationary，但**完全丢失 memory**
 *   (差分后的序列与 X 不相关)。
 *
 *   Fractional Differentiation:
 *
 *     (1 - B)^d · X = Σ_{k=0}^∞ ω_k · X[t-k]
 *
 *   其中:
 *     B = backshift operator (B·X[t] = X[t-1])
 *     d ∈ [0, 1] 是非整数分数 (e.g. 0.3, 0.5, 0.7)
 *     ω_k = ω_{k-1} · -(d - k + 1) / k    (Eq.5.1, recursive)
 *     ω_0 = 1
 *
 *   **关键性质 (Section 5.3)**:
 *     - d = 0: 原序列, full memory but non-stationary
 *     - d = 1: 一阶差分, stationary 但 no memory
 *     - d = 0.4: stationary AND retain memory (best of both worlds)
 *
 *   实际中找最小的 d 让 ADF test pass (Section 5.5).
 *
 * **Fixed-Width Window (FFD, Section 5.5)**:
 *
 *   原始公式 weights 是无限序列，实务用 Fixed-Width Window:
 *
 *     ω_k = 0 if |ω_k| < τ (threshold, default 1e-5)
 *
 *   这样 window 长度 K 是 finite (~ 20-200 by d 和 τ)。
 *
 * **A 股应用**:
 *   - 把 close price FFD 用作 ML features (vs Δlog 等)
 *   - d ≈ 0.4-0.5 在 A 股日级数据 ADF test pass
 */

/**
 * 计算 fractional differentiation weights (Eq.5.1)
 *
 * ω_k = ω_{k-1} · -(d - k + 1) / k
 *
 * 用 fixed-width threshold τ 控制 window 长度。
 *
 * @param d order of differentiation (0 < d < 1; integer values use np.diff instead)
 * @param threshold cutoff for |ω_k|; smaller = longer window, more accurate
 * @returns weights array [ω_0=1, ω_1, ω_2, ...] until |ω_k| < threshold
 */
export function fractionalDiffWeights(d: number, threshold = 1e-5): number[] {
  if (d <= 0 || d >= 1) {
    throw new Error(`fractionalDiffWeights: d=${d} must be in (0, 1)`);
  }
  const weights: number[] = [1];
  let k = 1;
  while (true) {
    const wPrev = weights[k - 1];
    const wNew = (-wPrev * (d - k + 1)) / k;
    if (Math.abs(wNew) < threshold) break;
    weights.push(wNew);
    k += 1;
    if (k > 10000) break; // safety
  }
  return weights;
}

/**
 * Apply fractional differentiation to a time series (Section 5.5 FFD)
 *
 * out[t] = Σ_{k=0}^{K-1} ω_k · X[t-k]    for t >= K-1
 *
 * 前 K-1 个 output 都是 NaN (window 不全)。
 *
 * @param series input time series (length T)
 * @param d differentiation order ∈ (0, 1)
 * @param threshold weights cutoff
 * @returns same-length array; first (weights.length - 1) elements are NaN
 */
export function fractionalDifference(series: number[], d: number, threshold = 1e-5): number[] {
  const w = fractionalDiffWeights(d, threshold);
  const K = w.length;
  const T = series.length;
  const out: number[] = new Array(T).fill(NaN);
  for (let t = K - 1; t < T; t += 1) {
    let s = 0;
    let valid = true;
    for (let k = 0; k < K; k += 1) {
      const x = series[t - k];
      if (!Number.isFinite(x)) {
        valid = false;
        break;
      }
      s += w[k] * x;
    }
    if (valid) out[t] = s;
  }
  return out;
}

/**
 * ADF (Augmented Dickey-Fuller) test approximation
 *
 * 完整 ADF 涉及矩阵回归求 t-stat；本简化版用 lag=1 + 估 ρ=corr(X[t-1], X[t])，
 * 然后 t-stat ≈ (ρ - 1) / std_err。
 *
 * **简化版只用于 findMinDForStationarity 二分搜索**：判断 stationary 用
 * "1 阶 autocorrelation 接近 0" 替代严格 t-stat。
 *
 * 严格 ADF 需要 statsmodels.tsa.stattools.adfuller，本 TS 实现无 numpy
 * 因此用近似。生产推荐用 Python 端 (mlfinlab) 跑严格 ADF.
 *
 * @returns { is_stationary: boolean, ar1_correlation: number }
 */
export function approximateAdfTest(series: number[]): {
  is_stationary: boolean;
  ar1_correlation: number;
} {
  const valid = series.filter(v => Number.isFinite(v));
  if (valid.length < 30) {
    return { is_stationary: false, ar1_correlation: 1.0 };
  }
  // X[t] vs X[t-1]
  const x = valid.slice(0, -1);
  const y = valid.slice(1);
  const meanX = x.reduce((s, v) => s + v, 0) / x.length;
  const meanY = y.reduce((s, v) => s + v, 0) / y.length;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < x.length; i += 1) {
    num += (x[i] - meanX) * (y[i] - meanY);
    denX += (x[i] - meanX) ** 2;
    denY += (y[i] - meanY) ** 2;
  }
  const corr = num / Math.sqrt(denX * denY || 1);
  // 简化 stationarity: |ar1_correlation| < 0.95 视为 stationary
  // (严格 ADF 在 ρ 接近 1 时 fail to reject unit root → non-stationary)
  return {
    is_stationary: Math.abs(corr) < 0.95,
    ar1_correlation: corr,
  };
}

/**
 * 二分搜索最小的 d 让 series 通过 ADF stationary test (Section 5.5.2)
 *
 * 算法:
 *   1. d_lo = 0.01 (almost no diff), d_hi = 0.99 (almost full diff)
 *   2. 二分搜索 mid = (lo + hi) / 2
 *   3. fdiff = fractionalDifference(series, mid)
 *   4. 如果 stationary → 尝试更小 d (lo = mid)
 *      否则 → 增大 d (hi = mid)
 *   5. 重复 max_iter 次 (default 20)
 *
 * 越小 d 越好 (保留更多 memory)，但前提是 stationary.
 *
 * @returns { min_d, weights_used, fdiff_series }
 */
export function findMinDForStationarity(
  series: number[],
  options: { d_range?: [number, number]; threshold?: number; max_iter?: number } = {}
): {
  min_d: number;
  is_stationary: boolean;
  ar1_correlation: number;
  weights_count: number;
} {
  const [dLo0, dHi0] = options.d_range ?? [0.01, 0.99];
  const threshold = options.threshold ?? 1e-5;
  const maxIter = options.max_iter ?? 20;

  let dLo = dLo0;
  let dHi = dHi0;
  let bestD = dHi;
  let bestStationary = false;
  let bestCorr = 1.0;
  let bestWLen = 0;

  for (let i = 0; i < maxIter; i += 1) {
    const mid = (dLo + dHi) / 2;
    const w = fractionalDiffWeights(mid, threshold);
    const fdiff = fractionalDifference(series, mid, threshold);
    const validFdiff = fdiff.filter(v => Number.isFinite(v));
    if (validFdiff.length < 30) {
      // window too long
      dLo = mid;
      continue;
    }
    const adf = approximateAdfTest(validFdiff);
    if (adf.is_stationary) {
      // 可以再小
      bestD = mid;
      bestStationary = true;
      bestCorr = adf.ar1_correlation;
      bestWLen = w.length;
      dHi = mid;
    } else {
      dLo = mid;
    }
  }

  return {
    min_d: bestD,
    is_stationary: bestStationary,
    ar1_correlation: bestCorr,
    weights_count: bestWLen,
  };
}
