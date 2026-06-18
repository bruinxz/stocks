/**
 * PCA + Fama-French Factor Risk Model
 *
 * 论文 reference:
 *   Fama, E. F. and French, K. R. (1993). "Common risk factors in the returns
 *   on stocks and bonds." Journal of Financial Economics 33, 3-56.
 *
 *   Pearson, K. (1901). "On lines and planes of closest fit to systems of
 *   points in space." Philosophical Magazine 2(11), 559-572.
 *
 *   Sharpe, W. F. (1964). CAPM single-factor.
 *
 * **核心公式**:
 *
 *   Fama-French 3-factor model:
 *     r_i - r_f = α_i + β_i_MKT · (r_MKT - r_f) + β_i_SMB · SMB + β_i_HML · HML + ε_i
 *
 *   - MKT: market excess return
 *   - SMB: Small Minus Big (size premium)
 *   - HML: High Minus Low (value premium, book-to-market)
 *
 *   PCA via Power Iteration (no SVD needed):
 *     v_{k+1} = (A v_k) / ||A v_k||   converges to top eigenvector
 *
 *   Deflation: A' = A - λ_1 v_1 v_1^T  让 second iteration 找 second component
 */

const POWER_ITER_DEFAULT_MAX = 200;
const POWER_ITER_DEFAULT_TOL = 1e-8;

/** Pearson correlation (matrix → assumed centered) */
function dotProduct(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

function vecNorm(v: number[]): number {
  return Math.sqrt(dotProduct(v, v));
}

function matVec(A: number[][], v: number[]): number[] {
  const m = A.length;
  const n = v.length;
  const out: number[] = new Array(m).fill(0);
  for (let i = 0; i < m; i += 1) {
    let s = 0;
    for (let j = 0; j < n; j += 1) s += A[i][j] * v[j];
    out[i] = s;
  }
  return out;
}

function outerProduct(a: number[], b: number[]): number[][] {
  const m = a.length;
  const n = b.length;
  const out: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) out[i][j] = a[i] * b[j];
  }
  return out;
}

/**
 * Power iteration: 求矩阵 A 的最大特征值 + 对应特征向量
 *
 *   v_{k+1} = (A v_k) / ||A v_k||
 *   λ = v^T A v
 */
export function powerIteration(
  A: number[][],
  options: { max_iter?: number; tol?: number; seed?: number } = {}
): { eigenvalue: number; eigenvector: number[]; iterations: number; converged: boolean } {
  const n = A.length;
  const max_iter = options.max_iter ?? POWER_ITER_DEFAULT_MAX;
  const tol = options.tol ?? POWER_ITER_DEFAULT_TOL;
  // Init with seeded vector
  let seed = options.seed ?? 42;
  const rng = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let v: number[] = new Array(n).fill(0).map(() => rng() - 0.5);
  const norm0 = vecNorm(v);
  v = v.map(x => x / norm0);

  let prev_lambda = 0;
  let iter = 0;
  let converged = false;
  for (iter = 0; iter < max_iter; iter += 1) {
    const Av = matVec(A, v);
    const norm = vecNorm(Av);
    if (norm < 1e-12) break;
    v = Av.map(x => x / norm);
    const lambda = dotProduct(v, matVec(A, v));
    if (Math.abs(lambda - prev_lambda) < tol) {
      converged = true;
      prev_lambda = lambda;
      break;
    }
    prev_lambda = lambda;
  }
  return { eigenvalue: prev_lambda, eigenvector: v, iterations: iter + 1, converged };
}

/**
 * Compute top-k principal components via deflation.
 *
 * @returns { eigenvalues, eigenvectors (n × k) } sorted by eigenvalue DESC
 */
export function topKPrincipalComponents(
  cov: number[][],
  k: number,
  options: { max_iter?: number; tol?: number; seed?: number } = {}
): { eigenvalues: number[]; eigenvectors: number[][] } {
  const n = cov.length;
  const eigenvalues: number[] = [];
  const eigenvectors: number[][] = [];
  // copy
  const A = cov.map(row => row.slice());

  for (let i = 0; i < Math.min(k, n); i += 1) {
    const pi = powerIteration(A, options);
    eigenvalues.push(pi.eigenvalue);
    eigenvectors.push(pi.eigenvector);
    // Deflation: A = A - λ v v^T
    const op = outerProduct(pi.eigenvector, pi.eigenvector);
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) A[r][c] -= pi.eigenvalue * op[r][c];
    }
  }

  return { eigenvalues, eigenvectors };
}

/**
 * Project returns matrix onto top-k principal components.
 *
 *   PC_scores = X_centered · V  where V = [v_1, ..., v_k] (n × k)
 */
export function projectOntoPCs(
  returns: number[][], // T × N
  eigenvectors: number[][] // k components, each length N
): number[][] {
  const T = returns.length;
  const k = eigenvectors.length;
  // Center
  const N = returns[0]?.length ?? 0;
  const means = new Array(N).fill(0);
  for (const row of returns) for (let j = 0; j < N; j += 1) means[j] += row[j] / T;

  const scores: number[][] = Array.from({ length: T }, () => new Array(k).fill(0));
  for (let t = 0; t < T; t += 1) {
    for (let i = 0; i < k; i += 1) {
      let s = 0;
      for (let j = 0; j < N; j += 1) s += (returns[t][j] - means[j]) * eigenvectors[i][j];
      scores[t][i] = s;
    }
  }
  return scores;
}

/**
 * Compute variance explained by each PC.
 *
 *   var_explained_i = eigenvalue_i / sum(eigenvalues)
 */
export function varianceExplained(eigenvalues: number[]): number[] {
  const total = eigenvalues.reduce((s, v) => s + v, 0);
  if (total <= 0) return eigenvalues.map(() => 0);
  return eigenvalues.map(v => v / total);
}

/**
 * Fama-French regression for a single stock.
 *
 * Run OLS:
 *   r_excess_t = α + β_MKT · MKT_t + β_SMB · SMB_t + β_HML · HML_t + ε_t
 *
 * @returns betas + alpha + R²
 */
export function famaFrenchRegression(input: {
  stock_excess_returns: number[];
  mkt: number[];
  smb: number[];
  hml: number[];
}): {
  alpha: number;
  beta_mkt: number;
  beta_smb: number;
  beta_hml: number;
  r_squared: number;
  n_samples: number;
} {
  const N = input.stock_excess_returns.length;
  if ([input.mkt.length, input.smb.length, input.hml.length].some(l => l !== N)) {
    throw new Error('famaFrenchRegression: length mismatch');
  }
  // OLS via normal equation
  // y = X β, β = (X^T X)^{-1} X^T y
  // X[t] = [1, MKT_t, SMB_t, HML_t]
  const k = 4;
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty: number[] = new Array(k).fill(0);
  const ys: number[] = [];
  const validIdx: number[] = [];
  for (let t = 0; t < N; t += 1) {
    const y = input.stock_excess_returns[t];
    const row = [1, input.mkt[t], input.smb[t], input.hml[t]];
    if (![y, ...row].every(Number.isFinite)) continue;
    validIdx.push(t);
    ys.push(y);
    for (let a = 0; a < k; a += 1) {
      Xty[a] += row[a] * y;
      for (let b = 0; b < k; b += 1) XtX[a][b] += row[a] * row[b];
    }
  }
  // Solve XtX β = Xty via Gauss-Jordan
  const aug = XtX.map((row, i) => [...row, Xty[i]]);
  for (let i = 0; i < k; i += 1) {
    let piv = i;
    for (let r = i + 1; r < k; r += 1) if (Math.abs(aug[r][i]) > Math.abs(aug[piv][i])) piv = r;
    if (Math.abs(aug[piv][i]) < 1e-12) {
      return {
        alpha: NaN,
        beta_mkt: NaN,
        beta_smb: NaN,
        beta_hml: NaN,
        r_squared: NaN,
        n_samples: ys.length,
      };
    }
    if (piv !== i) [aug[i], aug[piv]] = [aug[piv], aug[i]];
    const d = aug[i][i];
    for (let j = 0; j <= k; j += 1) aug[i][j] /= d;
    for (let r = 0; r < k; r += 1) {
      if (r === i) continue;
      const f = aug[r][i];
      for (let j = 0; j <= k; j += 1) aug[r][j] -= f * aug[i][j];
    }
  }
  const beta = aug.map(row => row[k]);
  // R²
  const ymean = ys.reduce((s, v) => s + v, 0) / ys.length;
  let ss_tot = 0,
    ss_res = 0;
  for (let i = 0; i < ys.length; i += 1) {
    const t = validIdx[i];
    const pred = beta[0] + beta[1] * input.mkt[t] + beta[2] * input.smb[t] + beta[3] * input.hml[t];
    ss_res += (ys[i] - pred) ** 2;
    ss_tot += (ys[i] - ymean) ** 2;
  }
  return {
    alpha: beta[0],
    beta_mkt: beta[1],
    beta_smb: beta[2],
    beta_hml: beta[3],
    r_squared: ss_tot > 0 ? 1 - ss_res / ss_tot : 0,
    n_samples: ys.length,
  };
}

/**
 * Fama-French factor construction from raw stock universe.
 *
 *   SMB = mean(small stocks return) - mean(big stocks return)
 *   HML = mean(high B/M stocks return) - mean(low B/M stocks return)
 *
 * @param universe stocks with market_cap + book_to_market + return
 */
export function constructFamaFrenchFactors(
  universe: Array<{
    symbol: string;
    market_cap: number;
    book_to_market: number;
    return_pct: number;
  }>
): { smb: number; hml: number } {
  // Sort by market_cap, split top/bottom 30%
  const byCap = [...universe].sort((a, b) => a.market_cap - b.market_cap);
  const nSmall = Math.floor(byCap.length * 0.3);
  const small = byCap.slice(0, nSmall);
  const big = byCap.slice(byCap.length - nSmall);
  const meanSmall = small.reduce((s, x) => s + x.return_pct, 0) / Math.max(1, small.length);
  const meanBig = big.reduce((s, x) => s + x.return_pct, 0) / Math.max(1, big.length);
  const smb = meanSmall - meanBig;

  // Sort by B/M, split top/bottom 30%
  const byBM = [...universe].sort((a, b) => a.book_to_market - b.book_to_market);
  const nVal = Math.floor(byBM.length * 0.3);
  const value = byBM.slice(byBM.length - nVal);
  const growth = byBM.slice(0, nVal);
  const meanVal = value.reduce((s, x) => s + x.return_pct, 0) / Math.max(1, value.length);
  const meanGrowth = growth.reduce((s, x) => s + x.return_pct, 0) / Math.max(1, growth.length);
  const hml = meanVal - meanGrowth;

  return { smb, hml };
}
