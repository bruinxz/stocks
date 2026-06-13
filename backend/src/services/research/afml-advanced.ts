/**
 * AFML Ch.16 + Ch.17 + Ch.18 + Ch.19 — Advanced ML Methods
 *
 * 论文 reference:
 *   López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
 *   Chapter 16: "Machine Learning Asset Allocation" (NCO — Nested Clustered Optimization)
 *   Chapter 17: "Microstructural Features"
 *   Chapter 18: "Entropy Features"
 *   Chapter 19: "Structural Breaks"
 *
 *   López de Prado, M. (2020). *Machine Learning for Asset Managers*. Cambridge.
 *   Ch.2: Denoising and Detoning
 *
 * **Chapter 16 NCO**: Hierarchical clustering + within-cluster MVO + cross-cluster MVO.
 *   解决 condition number 高时 Markowitz 爆掉的问题.
 *
 * **Chapter 17 Microstructural**: Beyond OHLCV bars - Roll/Corwin-Schultz/Becker-Parkinson.
 *
 * **Chapter 18 Entropy**: Shannon/Plug-in/Lempel-Ziv 测量 序列复杂度.
 *
 * **Chapter 19 SADF**: Sup Augmented Dickey-Fuller — bubble detection (PSY 2015).
 *
 * **MLfAM Ch.2 Denoising**: Marchenko-Pastur 随机矩阵理论 → identify noisy eigenvalues.
 */

import { topKPrincipalComponents } from './pca-fama-french';
import { hierarchicalRiskParity } from '../portfolio/hrp';

// ============================================================
// Ch.16 NCO (Nested Clustered Optimization)
// ============================================================

/**
 * NCO algorithm (De Prado 2016 + AFML Ch.16):
 *
 *   1. Cluster assets into groups (single-linkage via correlation distance)
 *   2. Within each cluster, compute mean-variance weights (or min-var)
 *   3. Across clusters, compute cross-cluster MVO weights on aggregated cluster
 *   4. Final weights = (within-cluster weight) × (cross-cluster weight)
 *
 * 简化: 用 HRP (我们 v2 已实现) 做 step 1+2+3，对 cluster level 再做 MVO.
 */
export function nestedClusteredOptimization(
  cov: number[][],
  options: { n_clusters?: number } = {}
): { weights: number[]; clusters: number[][] } {
  // Simplified: use HRP recursively (cluster level + within cluster)
  // For first cut, just use HRP directly
  const hrp = hierarchicalRiskParity(cov);
  // Group assets into clusters based on cluster_order
  const k = options.n_clusters ?? Math.max(2, Math.floor(Math.sqrt(cov.length)));
  const clusters: number[][] = [];
  const N = cov.length;
  const per_cluster = Math.ceil(N / k);
  for (let c = 0; c < k; c += 1) {
    clusters.push(hrp.cluster_order.slice(c * per_cluster, (c + 1) * per_cluster));
  }
  return { weights: hrp.weights, clusters };
}

// ============================================================
// Ch.17 Microstructural Estimators
// ============================================================

/**
 * Roll (1984) effective spread estimator.
 *
 *   spread = 2 × sqrt(-cov(ΔP_t, ΔP_{t-1}))
 *
 * 与 v4 microstructure.ts 中 rollsEffectiveSpread 一致.
 */
export function rollSpread(prices: number[]): number | null {
  if (prices.length < 3) return null;
  const dp: number[] = [];
  for (let t = 1; t < prices.length; t += 1) dp.push(prices[t] - prices[t - 1]);
  const x = dp.slice(0, -1), y = dp.slice(1);
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let cov = 0;
  for (let i = 0; i < x.length; i += 1) cov += (x[i] - mx) * (y[i] - my);
  cov /= Math.max(1, x.length - 1);
  return cov < 0 ? 2 * Math.sqrt(-cov) : null;
}

/**
 * Corwin-Schultz (2012) high-low spread estimator.
 *
 *   beta = (log(H_t/L_t))² + (log(H_{t-1}/L_{t-1}))²
 *   gamma = (log(max(H_t, H_{t-1}) / min(L_t, L_{t-1})))²
 *   alpha = (sqrt(2β) - sqrt(β)) / (3 - 2√2) - sqrt(γ / (3 - 2√2))
 *   S = 2 × (exp(alpha) - 1) / (1 + exp(alpha))
 */
export function corwinSchultzSpread(highs: number[], lows: number[]): number[] {
  const T = highs.length;
  const out: number[] = new Array(T).fill(NaN);
  const sqrt2 = Math.sqrt(2);
  const denom = 3 - 2 * sqrt2;
  for (let t = 1; t < T; t += 1) {
    if (highs[t] <= 0 || lows[t] <= 0 || highs[t - 1] <= 0 || lows[t - 1] <= 0) continue;
    const beta = Math.log(highs[t] / lows[t]) ** 2 + Math.log(highs[t - 1] / lows[t - 1]) ** 2;
    const max_h = Math.max(highs[t], highs[t - 1]);
    const min_l = Math.min(lows[t], lows[t - 1]);
    const gamma = Math.log(max_h / min_l) ** 2;
    const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / denom - Math.sqrt(gamma / denom);
    const s = (2 * (Math.exp(alpha) - 1)) / (1 + Math.exp(alpha));
    out[t] = Math.max(0, s);
  }
  return out;
}

/**
 * Becker-Parkinson (1980) range-based volatility.
 *
 *   σ² = (1 / (4 log 2)) × log(H/L)²
 */
export function beckerParkinsonVol(highs: number[], lows: number[]): number[] {
  const out: number[] = [];
  const k = 1 / (4 * Math.log(2));
  for (let t = 0; t < highs.length; t += 1) {
    if (highs[t] <= 0 || lows[t] <= 0) {
      out.push(NaN);
      continue;
    }
    const lhl = Math.log(highs[t] / lows[t]);
    out.push(Math.sqrt(k * lhl * lhl));
  }
  return out;
}

// ============================================================
// Ch.18 Entropy Features
// ============================================================

/**
 * Shannon entropy (plug-in estimator).
 *
 *   H = -Σ p_i × log(p_i)
 *
 * @param values series; bin into k_bins for discrete probabilities
 */
export function shannonEntropy(values: number[], k_bins: number = 10): number {
  const N = values.length;
  if (N === 0) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-12) return 0;
  const bin_width = (max - min) / k_bins;
  const counts: number[] = new Array(k_bins).fill(0);
  for (const v of values) {
    const idx = Math.min(k_bins - 1, Math.max(0, Math.floor((v - min) / bin_width)));
    counts[idx] += 1;
  }
  let H = 0;
  for (const c of counts) {
    if (c > 0) {
      const p = c / N;
      H -= p * Math.log(p);
    }
  }
  return H;
}

/**
 * Sample entropy (SampEn, Richman-Moorman 2000):
 *
 *   SampEn(m, r) = -log(A / B)
 *
 *   - m: template length
 *   - r: tolerance (typical 0.2 × std)
 *   - A: count of m+1 length matches
 *   - B: count of m length matches
 *
 *   Higher → more complex / random.
 */
export function sampleEntropy(values: number[], m: number = 2, r_factor: number = 0.2): number {
  const N = values.length;
  if (N < m + 1) return 0;
  const std = Math.sqrt(values.reduce((s, v) => s + v * v, 0) / N - Math.pow(values.reduce((s, v) => s + v, 0) / N, 2));
  const r = r_factor * std;

  const countMatches = (templateLen: number): number => {
    let count = 0;
    for (let i = 0; i < N - templateLen; i += 1) {
      for (let j = i + 1; j < N - templateLen; j += 1) {
        let match = true;
        for (let k = 0; k < templateLen; k += 1) {
          if (Math.abs(values[i + k] - values[j + k]) > r) {
            match = false;
            break;
          }
        }
        if (match) count += 1;
      }
    }
    return count;
  };

  const A = countMatches(m + 1);
  const B = countMatches(m);
  if (B === 0) return 0;
  return -Math.log(A / B || 1e-12);
}

// ============================================================
// Ch.19 Structural Breaks (SADF)
// ============================================================

/**
 * Simplified Augmented Dickey-Fuller test statistic.
 *
 *   Regress: Δy_t = ρ × y_{t-1} + ε_t
 *
 *   t_stat = ρ_hat / SE(ρ_hat)
 *
 *   Negative t_stat below critical value → reject unit root (stationary).
 *
 *   Critical values (asymptotic):
 *     1%: -3.43, 5%: -2.86, 10%: -2.57
 */
export function adfTestStatistic(values: number[]): { t_stat: number; rho_hat: number; n_samples: number } {
  const T = values.length;
  if (T < 5) return { t_stat: NaN, rho_hat: NaN, n_samples: 0 };

  const x: number[] = [];
  const y: number[] = [];
  for (let t = 1; t < T; t += 1) {
    x.push(values[t - 1]);
    y.push(values[t] - values[t - 1]); // Δy
  }
  const N = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / N;
  const my = y.reduce((s, v) => s + v, 0) / N;
  let num = 0, denom = 0;
  for (let i = 0; i < N; i += 1) {
    num += (x[i] - mx) * (y[i] - my);
    denom += (x[i] - mx) ** 2;
  }
  if (denom < 1e-12) return { t_stat: NaN, rho_hat: NaN, n_samples: N };
  const rho = num / denom;

  // residuals + SE
  let ss = 0;
  for (let i = 0; i < N; i += 1) {
    const pred = rho * (x[i] - mx) + my;
    ss += (y[i] - pred) ** 2;
  }
  const sigma2 = ss / Math.max(1, N - 1);
  const se_rho = Math.sqrt(sigma2 / denom);
  const t_stat = se_rho > 0 ? rho / se_rho : NaN;

  return { t_stat, rho_hat: rho, n_samples: N };
}

/**
 * SADF (Sup Augmented Dickey-Fuller, PSY 2015) — bubble detection.
 *
 * Recursively compute ADF on expanding windows [r_0, r_1] with r_1 = r_0..T,
 * take supremum. SADF > critical → presence of explosive behavior (bubble).
 *
 * @param values series
 * @param r0 minimum window fraction (default 0.4)
 * @returns max ADF stat over all sub-windows
 */
export function supAdf(values: number[], r0: number = 0.4): number {
  const T = values.length;
  if (T < 10) return NaN;
  const min_len = Math.max(5, Math.floor(r0 * T));
  let max_adf = -Infinity;
  for (let end = min_len; end <= T; end += 1) {
    const window = values.slice(0, end);
    const adf = adfTestStatistic(window);
    if (Number.isFinite(adf.t_stat) && adf.t_stat > max_adf) max_adf = adf.t_stat;
  }
  return max_adf;
}

// ============================================================
// MLfAM Ch.2 — Denoised correlation matrix
// ============================================================

/**
 * Marchenko-Pastur (MP) random matrix theory.
 *
 *   For T × N matrix with i.i.d. entries (variance σ²), eigenvalues of
 *   sample correlation matrix follow MP distribution with:
 *
 *     λ_max = σ² × (1 + sqrt(N/T))²
 *     λ_min = σ² × (1 - sqrt(N/T))²
 *
 *   Eigenvalues > λ_max → signal; eigenvalues < λ_max → noise.
 *
 * **Denoising algorithm**:
 *   1. Compute correlation matrix → eigenvalues
 *   2. Find λ_max (MP threshold)
 *   3. Replace noisy eigenvalues with their mean (preserve trace)
 *   4. Reconstruct correlation matrix from cleaned eigenvalues
 */
export function marchenkoPasturThreshold(N: number, T: number, sigma: number = 1): { lambda_max: number; lambda_min: number } {
  const q = N / T;
  const lambda_max = sigma * sigma * (1 + Math.sqrt(q)) ** 2;
  const lambda_min = sigma * sigma * (1 - Math.sqrt(q)) ** 2;
  return { lambda_max, lambda_min };
}

/**
 * Denoise correlation matrix using MP threshold.
 *
 *   1. eigendecompose
 *   2. λ_i = mean of noisy if λ_i < λ_max, else keep
 *   3. reconstruct
 */
export function denoiseCorrelation(corr: number[][], T: number): { denoised: number[][]; n_noise: number } {
  const N = corr.length;
  if (N === 0) return { denoised: [], n_noise: 0 };

  const { lambda_max } = marchenkoPasturThreshold(N, T);
  const pc = topKPrincipalComponents(corr, N);
  const eigenvalues = pc.eigenvalues.slice();
  const noisy_idx = eigenvalues.map((v, i) => ({ v, i })).filter(p => p.v < lambda_max).map(p => p.i);
  const noisy_avg = noisy_idx.length > 0 ? noisy_idx.reduce((s, i) => s + eigenvalues[i], 0) / noisy_idx.length : 0;
  for (const i of noisy_idx) eigenvalues[i] = noisy_avg;

  // Reconstruct: corr_denoised = V × diag(λ_new) × V^T
  const denoised: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      let s = 0;
      for (let k = 0; k < Math.min(N, pc.eigenvectors.length); k += 1) {
        s += pc.eigenvectors[k][i] * eigenvalues[k] * pc.eigenvectors[k][j];
      }
      denoised[i][j] = s;
    }
  }
  // Normalize diagonal to 1 (rescale)
  const sqrt_diag = denoised.map((row, i) => Math.sqrt(Math.max(1e-12, row[i])));
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      denoised[i][j] /= sqrt_diag[i] * sqrt_diag[j];
    }
  }
  return { denoised, n_noise: noisy_idx.length };
}

/**
 * Detoned correlation (remove market component).
 *
 *   1. Find top 1-2 eigenvectors (market + sector)
 *   2. Subtract their contribution from correlation matrix
 */
export function detoneCorrelation(corr: number[][], n_detone: number = 1): number[][] {
  const N = corr.length;
  const pc = topKPrincipalComponents(corr, n_detone);
  const detoned: number[][] = corr.map(row => row.slice());
  for (let k = 0; k < n_detone; k += 1) {
    for (let i = 0; i < N; i += 1) {
      for (let j = 0; j < N; j += 1) {
        detoned[i][j] -= pc.eigenvalues[k] * pc.eigenvectors[k][i] * pc.eigenvectors[k][j];
      }
    }
  }
  // Rescale diagonal
  const sqrt_diag = detoned.map((row, i) => Math.sqrt(Math.max(1e-12, row[i])));
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      detoned[i][j] /= sqrt_diag[i] * sqrt_diag[j];
    }
  }
  return detoned;
}
