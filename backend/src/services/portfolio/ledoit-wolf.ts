/**
 * Ledoit-Wolf Shrinkage Covariance Estimator
 *
 * 论文 reference:
 *   Ledoit, O. and Wolf, M. (2004). "Honey, I shrunk the sample covariance matrix."
 *   Journal of Portfolio Management 30(4), 110-119.
 *   https://www.ledoit.net/honey.pdf
 *
 * 实现 reference:
 *   scikit-learn `_shrunk_covariance.py` (BSD-3-Clause licensed)
 *   https://github.com/scikit-learn/scikit-learn/blob/main/sklearn/covariance/_shrunk_covariance.py
 *
 * **核心思想**：
 *   样本协方差 S 在 N (维度) 接近 T (样本数) 时极度不稳定，特征值病态。
 *   Ledoit-Wolf 用 shrinkage:
 *
 *     Σ̂ = (1 − δ) · S + δ · F
 *
 *   其中 F 是高 bias 但 low variance 的 target（sklearn 用 F = μ · I，
 *   μ = trace(S) / N），δ ∈ [0, 1] 由数据自动估出最小化 MSE。
 *
 * **为什么 production 必须用 shrinkage**：
 *   - HRP / ERC / min-var 都依赖 cov inverse 或 cov 特征向量
 *   - 样本 cov 在 N > T/3 时已经病态
 *   - A 股策略常面对 N ~ 30 stocks × T ~ 60 trading days 场景，shrinkage 必备
 *
 * **公式（sklearn impl）**:
 *
 *   X 形状 (T, N)，列已中心化（mean=0）。
 *
 *   mu        = trace(S) / N                                    -- F 的对角值
 *   beta_raw  = sum(X² · X²) / (N · T²) - sum((Xᵀ X)²) / (N · T²)
 *   delta_raw = sum((Xᵀ X)²) - 2 μ · sum(diag(Xᵀ X)) + N · μ²
 *   delta     = delta_raw / N
 *   shrinkage = min(beta_raw / delta, 1)
 *
 *   Σ̂[i,j] = (1 − shrinkage) · S[i,j],      i ≠ j
 *   Σ̂[i,i] = (1 − shrinkage) · S[i,i] + shrinkage · μ
 *
 * **退化情形**:
 *   - X 全 0 → cov = 0, shrinkage = 0
 *   - T < 2 → 抛错
 *   - N = 0 → 抛错
 *
 * **shrinkage intensity 解读**:
 *   - δ → 0: 数据充足，样本 cov 足够稳定
 *   - δ → 1: 数据稀缺，cov 完全用对角 μ 代替
 *   - δ ≈ 0.3-0.6: A 股 30 stocks × 60 days 典型值
 */

/**
 * 中心化矩阵每列（去 mean）
 */
export function centerColumns(matrix: number[][]): number[][] {
  const T = matrix.length;
  if (T === 0) return [];
  const N = matrix[0].length;
  const means = new Array(N).fill(0);
  for (let t = 0; t < T; t += 1) {
    for (let i = 0; i < N; i += 1) {
      means[i] += matrix[t][i];
    }
  }
  for (let i = 0; i < N; i += 1) means[i] /= T;
  return matrix.map(row => row.map((v, i) => v - means[i]));
}

/**
 * Sample covariance with optional centering (n denominator NOT n-1 to match sklearn LW)
 *
 * S[i,j] = (1/T) · Σ_t X[t,i] · X[t,j]   (assuming columns centered)
 */
export function sampleCovariance(centeredX: number[][]): number[][] {
  const T = centeredX.length;
  if (T === 0) return [];
  const N = centeredX[0].length;
  const S: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i += 1) {
    for (let j = i; j < N; j += 1) {
      let s = 0;
      for (let t = 0; t < T; t += 1) {
        s += centeredX[t][i] * centeredX[t][j];
      }
      S[i][j] = s / T;
      S[j][i] = S[i][j];
    }
  }
  return S;
}

/**
 * Compute Ledoit-Wolf shrinkage intensity δ ∈ [0, 1] (sklearn formula).
 *
 * Input X is (T, N) raw returns matrix; will be auto-centered.
 *
 * @returns shrinkage intensity (scalar)
 */
export function ledoitWolfShrinkageIntensity(X: number[][]): number {
  const T = X.length;
  if (T < 2) throw new Error(`ledoitWolfShrinkageIntensity: T=${T} < 2`);
  const N = X[0].length;
  if (N === 0) throw new Error('ledoitWolfShrinkageIntensity: N=0');

  const Xc = centerColumns(X);

  // mu = mean(diag(emp_cov))  where emp_cov[i,i] = (1/T) Σ Xc[t,i]²
  const X2sum = new Array(N).fill(0);
  for (let t = 0; t < T; t += 1) {
    for (let i = 0; i < N; i += 1) X2sum[i] += Xc[t][i] * Xc[t][i];
  }
  const mu = X2sum.reduce((s, v) => s + v / T, 0) / N;

  // beta_raw = sum( (X² @ X².T)_diag ) per sklearn:  beta_ = sum(X2.T @ X2)
  // X2[t,i] = Xc[t,i]²; so X2.T @ X2 is N×N, sum of all entries
  // = Σ_i Σ_j Σ_t X2[t,i] · X2[t,j] = Σ_t (Σ_i X2[t,i])²
  // = Σ_t (Σ_i Xc[t,i]²)²
  let beta_raw_intermediate = 0;
  for (let t = 0; t < T; t += 1) {
    let row_sq = 0;
    for (let i = 0; i < N; i += 1) row_sq += Xc[t][i] * Xc[t][i];
    beta_raw_intermediate += row_sq * row_sq;
  }
  // beta_ = sum(X2.T @ X2)  =>  conceptually above
  const beta_ = beta_raw_intermediate;

  // delta_ = sum((X.T @ X)²) / T²
  // Compute G = Xc.T @ Xc  (N×N), then delta_ = sum(G²) / T²
  const G: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let t = 0; t < T; t += 1) {
    for (let i = 0; i < N; i += 1) {
      for (let j = i; j < N; j += 1) {
        G[i][j] += Xc[t][i] * Xc[t][j];
      }
    }
  }
  for (let i = 0; i < N; i += 1) {
    for (let j = i + 1; j < N; j += 1) G[j][i] = G[i][j];
  }
  let G2sum = 0;
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) G2sum += G[i][j] * G[i][j];
  }
  const delta_ = G2sum / (T * T);

  // Per sklearn (verified):
  //   beta = 1 / (N · T) · (beta_ / T - delta_)
  //   delta = delta_ - 2 · μ · sum(diag(emp_cov_trace)) + N · μ²
  //   delta /= N
  //   beta = min(beta, delta)
  //   shrinkage = beta / delta  (if delta > 0)
  const beta = (1.0 / (N * T)) * (beta_ / T - delta_);

  // sum(diag(emp_cov_trace)) = sum(X2sum)/T = N · μ
  const diagSum = N * mu;
  let delta = delta_ - 2.0 * mu * diagSum + N * mu * mu;
  delta /= N;

  const cappedBeta = Math.min(beta, delta);
  if (delta <= 0) return 0;
  return Math.max(0, Math.min(1, cappedBeta / delta));
}

/**
 * Full Ledoit-Wolf shrunk covariance estimator.
 *
 * @returns shrunk cov (N×N), shrinkage intensity, target μ
 */
export function ledoitWolfCovariance(X: number[][]): {
  cov: number[][];
  shrinkage: number;
  mu: number;
} {
  const T = X.length;
  if (T < 2) throw new Error(`ledoitWolfCovariance: T=${T} < 2`);
  const N = X[0].length;
  const Xc = centerColumns(X);
  const S = sampleCovariance(Xc);

  const shrinkage = ledoitWolfShrinkageIntensity(X);
  const mu = S.reduce((s, row, i) => s + row[i], 0) / N;

  // Σ̂ = (1 - δ) S + δ μ I
  const out: number[][] = S.map((row, i) =>
    row.map((v, j) => (1 - shrinkage) * v + (i === j ? shrinkage * mu : 0))
  );

  return { cov: out, shrinkage, mu };
}
