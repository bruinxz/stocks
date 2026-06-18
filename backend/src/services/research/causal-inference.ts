/**
 * Causal Inference for Alpha Validation
 *
 * 论文 reference:
 *   Pearl, J. (2009). *Causality: Models, Reasoning, and Inference.*
 *   2nd ed., Cambridge University Press.
 *   Chapter 3: "Causal Diagrams and the Identification of Causal Effects"
 *
 *   Pearl, J. and Mackenzie, D. (2018). *The Book of Why: The New Science
 *   of Cause and Effect.*
 *
 *   Hernán, M. and Robins, J. (2020). *Causal Inference: What If.* Chapman & Hall.
 *
 * **核心问题**:
 *
 *   Quant signal correlated with future returns ≠ signal *causes* returns.
 *
 *   常见 confounder:
 *     - **Market beta**: signal 高的股票本身 beta 高, return 来自 market 不是 alpha
 *     - **Size factor**: signal 选小盘股, return 来自 size factor
 *     - **Survivorship bias**: 历史样本里只剩"活着的"股票
 *     - **Reverse causality**: signal 是 future return 的 proxy (用了未来信息)
 *
 *   Pearl 的 do-calculus 通过 backdoor adjustment 估真实因果效应:
 *
 *     E[Y | do(X=x)] = Σ_z P(Z=z) · E[Y | X=x, Z=z]
 *
 *   其中 Z 是 backdoor (covering all confounders).
 *
 * **本实现**:
 *
 *   简化的 backdoor adjustment for 1-D signal X → return Y, 控 confounders Z:
 *
 *     1. Split observations into bins by Z values
 *     2. Within each bin, compute E[Y | X, Z=z]
 *     3. Marginalize: E[Y | do(X)] = weighted avg by P(Z=z)
 *
 *   对照:
 *     - **Naive correlation** corr(X, Y): contaminated by confounders
 *     - **Adjusted correlation** corr(X, Y | Z): controls for confounders
 *     - **Difference** = naive - adjusted: 反映 confounding 程度
 *
 *   如果 naive - adjusted > 0.5: 信号大部分是 confounding 而非真实 alpha
 *
 * **典型 use case for A 股**:
 *   - X = momentum factor (10d return)
 *   - Y = forward 20d return
 *   - Z = [market_beta, market_cap]  (control 系统性 + 风格 exposure)
 *   - naive corr = 0.08 (looks like alpha)
 *   - adjusted corr = 0.02 (mostly confounding)
 *   - → momentum 在 A 股几乎全是 beta + size 暴露
 */

/**
 * 简单 binning: 把 confounder Z 分成 K 个 bin (quantile-based).
 *
 * 返回 bin index (0..K-1) for each observation.
 */
export function quantileBin(values: number[], k_bins: number): number[] {
  const N = values.length;
  if (N === 0 || k_bins < 1) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const bins: number[] = new Array(N).fill(0);
  // bin boundaries (k_bins - 1 internal quantiles)
  const boundaries: number[] = [];
  for (let q = 1; q < k_bins; q += 1) {
    const idx = Math.floor((q * N) / k_bins);
    boundaries.push(sorted[Math.min(idx, N - 1)]);
  }
  for (let i = 0; i < N; i += 1) {
    let b = 0;
    for (let q = 0; q < boundaries.length; q += 1) {
      if (values[i] > boundaries[q]) b = q + 1;
    }
    bins[i] = b;
  }
  return bins;
}

/**
 * Pearson correlation (复用)
 */
function pearson(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return NaN;
  const valid: Array<[number, number]> = [];
  for (let i = 0; i < x.length; i += 1) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) valid.push([x[i], y[i]]);
  }
  if (valid.length < 2) return NaN;
  const mX = valid.reduce((s, p) => s + p[0], 0) / valid.length;
  const mY = valid.reduce((s, p) => s + p[1], 0) / valid.length;
  let num = 0,
    dX = 0,
    dY = 0;
  for (const [xi, yi] of valid) {
    num += (xi - mX) * (yi - mY);
    dX += (xi - mX) ** 2;
    dY += (yi - mY) ** 2;
  }
  return dX * dY > 0 ? num / Math.sqrt(dX * dY) : 0;
}

/**
 * Backdoor adjustment for 1 confounder.
 *
 *   adjusted_corr = Σ_z P(Z=z) · corr(X, Y | Z=z)
 *
 * @param X signal series
 * @param Y outcome series
 * @param Z confounder series
 * @param k_bins how many Z bins (default 5)
 */
export function backdoorAdjustedCorrelation(
  X: number[],
  Y: number[],
  Z: number[],
  k_bins = 5
): {
  naive_corr: number;
  adjusted_corr: number;
  bin_correlations: Array<{ bin: number; corr: number; n_obs: number; weight: number }>;
  confounding_gap: number; // naive - adjusted
} {
  const N = X.length;
  if (N !== Y.length || N !== Z.length) throw new Error('backdoor: length mismatch');

  const naive = pearson(X, Y);

  const bins = quantileBin(Z, k_bins);
  const bin_corrs: Array<{ bin: number; corr: number; n_obs: number; weight: number }> = [];

  let adjusted = 0;
  let total_obs = 0;
  for (let b = 0; b < k_bins; b += 1) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < N; i += 1) {
      if (bins[i] === b && Number.isFinite(X[i]) && Number.isFinite(Y[i])) {
        xs.push(X[i]);
        ys.push(Y[i]);
      }
    }
    if (xs.length < 2) continue;
    const c = pearson(xs, ys);
    const w = xs.length / N;
    bin_corrs.push({ bin: b, corr: c, n_obs: xs.length, weight: w });
    if (Number.isFinite(c)) {
      adjusted += w * c;
      total_obs += xs.length;
    }
  }

  // normalize by total weight to avoid division by missing bins
  const totalWeight = bin_corrs.reduce((s, b) => s + b.weight, 0);
  if (totalWeight > 0) adjusted /= totalWeight;

  return {
    naive_corr: naive,
    adjusted_corr: adjusted,
    bin_correlations: bin_corrs,
    confounding_gap: naive - adjusted,
  };
}

/**
 * Multi-confounder backdoor adjustment.
 *
 * 将所有 confounders Z = (Z_1, ..., Z_m) 一起 bin 形成 m-D grid,
 * 每个 grid cell 内算 corr(X, Y).
 *
 * 简化: m=2 only (实务 confounder set 通常 ≤ 3).
 *
 * @param Zs list of confounder series (each length N)
 * @param k_bins_per_dim bins per confounder (default 3, so 3×3=9 cells for 2 confounders)
 */
export function multiConfounderBackdoor(
  X: number[],
  Y: number[],
  Zs: number[][],
  k_bins_per_dim = 3
): {
  naive_corr: number;
  adjusted_corr: number;
  cells_used: number;
  confounding_gap: number;
} {
  const N = X.length;
  if (Zs.some(z => z.length !== N)) throw new Error('multiConfounderBackdoor: length mismatch');

  const naive = pearson(X, Y);

  // Bin each Z
  const allBins = Zs.map(z => quantileBin(z, k_bins_per_dim));

  // Map cell key → observations
  const cellMap = new Map<string, { xs: number[]; ys: number[] }>();
  for (let i = 0; i < N; i += 1) {
    const key = allBins.map(b => b[i]).join(',');
    if (!cellMap.has(key)) cellMap.set(key, { xs: [], ys: [] });
    const c = cellMap.get(key)!;
    if (Number.isFinite(X[i]) && Number.isFinite(Y[i])) {
      c.xs.push(X[i]);
      c.ys.push(Y[i]);
    }
  }

  let adjusted = 0;
  let totalWeight = 0;
  let cells_used = 0;
  for (const cell of cellMap.values()) {
    if (cell.xs.length < 2) continue;
    const c = pearson(cell.xs, cell.ys);
    if (!Number.isFinite(c)) continue;
    const w = cell.xs.length / N;
    adjusted += w * c;
    totalWeight += w;
    cells_used += 1;
  }
  if (totalWeight > 0) adjusted /= totalWeight;

  return {
    naive_corr: naive,
    adjusted_corr: adjusted,
    cells_used,
    confounding_gap: naive - adjusted,
  };
}

/**
 * Granger causality test (Wald F-test, simplified version).
 *
 * 论文 reference:
 *   Granger, C. W. J. (1969). "Investigating Causal Relations by Econometric
 *   Models and Cross-spectral Methods."
 *   Econometrica 37(3), 424-438.
 *
 *   X Granger-causes Y if past values of X help predict Y beyond what Y's
 *   own past values explain.
 *
 *   Test:
 *     1. Restricted model: Y_t = α + Σ β_i Y_{t-i} + ε
 *     2. Unrestricted model: Y_t = α + Σ β_i Y_{t-i} + Σ γ_j X_{t-j} + ε
 *     3. F = (RSS_R - RSS_U) / p / (RSS_U / (N - 2p - 1))
 *
 *   F > F_critical → reject "no Granger causality" → X Granger-causes Y.
 *
 * 简化: 只做 lag=1 case, 用 OLS 回归.
 *
 * @returns { f_statistic, granger_causality_score: 0-1, n_samples }
 */
export function grangerCausalityTest(
  X: number[],
  Y: number[],
  lag = 1
): {
  f_statistic: number;
  granger_causality_score: number; // 0-1, higher = more evidence of causality
  n_samples: number;
  rss_restricted: number;
  rss_unrestricted: number;
} {
  if (X.length !== Y.length) throw new Error('grangerCausalityTest: length mismatch');
  const N = X.length;
  if (N < lag * 4 + 5) {
    return {
      f_statistic: NaN,
      granger_causality_score: NaN,
      n_samples: 0,
      rss_restricted: NaN,
      rss_unrestricted: NaN,
    };
  }

  // Build feature matrix
  const ys: number[] = [];
  const restrictedRows: number[][] = []; // [1, Y_{t-1}, ..., Y_{t-lag}]
  const unrestrictedRows: number[][] = []; // [1, Y_{t-1}.., X_{t-1}..]
  for (let t = lag; t < N; t += 1) {
    if (![X[t], Y[t]].every(Number.isFinite)) continue;
    const yRow = [1];
    for (let l = 1; l <= lag; l += 1) yRow.push(Y[t - l]);
    restrictedRows.push(yRow);
    unrestrictedRows.push([...yRow, ...Array.from({ length: lag }, (_, l) => X[t - l - 1])]);
    ys.push(Y[t]);
  }

  if (ys.length < 5) {
    return {
      f_statistic: NaN,
      granger_causality_score: NaN,
      n_samples: 0,
      rss_restricted: NaN,
      rss_unrestricted: NaN,
    };
  }

  // Simple OLS via normal equation: β = (X^T X)^{-1} X^T y
  // For numerical stability, use a small linear solve
  const olsRss = (features: number[][], target: number[]): number => {
    const n = features.length;
    const k = features[0].length;
    // Compute X^T X (k×k) and X^T y (k)
    const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
    const Xty: number[] = new Array(k).fill(0);
    for (let i = 0; i < n; i += 1) {
      for (let a = 0; a < k; a += 1) {
        Xty[a] += features[i][a] * target[i];
        for (let b = 0; b < k; b += 1) {
          XtX[a][b] += features[i][a] * features[i][b];
        }
      }
    }
    // Solve via Gauss-Jordan (small k)
    const augmented = XtX.map((row, i) => [...row, Xty[i]]);
    for (let i = 0; i < k; i += 1) {
      // pivot
      let piv = i;
      for (let r = i + 1; r < k; r += 1) {
        if (Math.abs(augmented[r][i]) > Math.abs(augmented[piv][i])) piv = r;
      }
      if (Math.abs(augmented[piv][i]) < 1e-12) return Infinity;
      if (piv !== i) [augmented[i], augmented[piv]] = [augmented[piv], augmented[i]];
      const d = augmented[i][i];
      for (let j = 0; j <= k; j += 1) augmented[i][j] /= d;
      for (let r = 0; r < k; r += 1) {
        if (r === i) continue;
        const factor = augmented[r][i];
        for (let j = 0; j <= k; j += 1) augmented[r][j] -= factor * augmented[i][j];
      }
    }
    const beta = augmented.map(row => row[k]);
    // RSS = Σ (y_i - x_i^T β)²
    let rss = 0;
    for (let i = 0; i < n; i += 1) {
      let pred = 0;
      for (let a = 0; a < k; a += 1) pred += features[i][a] * beta[a];
      rss += (target[i] - pred) ** 2;
    }
    return rss;
  };

  const RSS_R = olsRss(restrictedRows, ys);
  const RSS_U = olsRss(unrestrictedRows, ys);

  if (!Number.isFinite(RSS_R) || !Number.isFinite(RSS_U) || RSS_U <= 0) {
    return {
      f_statistic: NaN,
      granger_causality_score: NaN,
      n_samples: ys.length,
      rss_restricted: RSS_R,
      rss_unrestricted: RSS_U,
    };
  }

  const p = lag;
  const n = ys.length;
  const k_restricted = lag + 1;
  const k_unrestricted = 2 * lag + 1;
  const f_stat = (RSS_R - RSS_U) / p / (RSS_U / Math.max(1, n - k_unrestricted));

  // 简化的"score" 映射: F=0 → 0, F=5 → 0.5, F=20 → 0.9, F → ∞ → 1
  // 用 F / (F + 5) 单调映射
  const score = Math.max(0, f_stat) / (Math.max(0, f_stat) + 5);

  return {
    f_statistic: f_stat,
    granger_causality_score: score,
    n_samples: ys.length,
    rss_restricted: RSS_R,
    rss_unrestricted: RSS_U,
  };
}
