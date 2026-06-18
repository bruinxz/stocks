/**
 * Black-Litterman Posterior Expected Returns
 *
 * 论文 reference:
 *   Black, F. and Litterman, R. (1992). "Global Portfolio Optimization."
 *   Financial Analysts Journal 48(5), 28-43.
 *   https://www.cfainstitute.org/research/financial-analysts-journal/1992/global-portfolio-optimization
 *
 * **核心问题**:
 *
 *   Markowitz mean-variance optimization 极度敏感 expected returns 输入。
 *   纯历史 mean 估计 noise 大 → weights 不稳定 + 经常 corner solutions.
 *
 * **Black-Litterman 思想**:
 *
 *   不直接用 historical mean。而是融合:
 *
 *     1. **Market equilibrium prior** Π:
 *        从 market cap weights w_mkt 反推 implied excess returns
 *           Π = λ · Σ · w_mkt          (Eq.1)
 *        其中 λ 是 risk aversion (3 是 industry standard)
 *
 *     2. **Investor views** (P, Q, Ω):
 *        P (k × n) - pick matrix (每行一个 view, 选哪几只票)
 *        Q (k × 1) - view 收益值
 *        Ω (k × k) - view 不确定性 (uncertainty covariance)
 *
 *     3. **Posterior** μ_BL:
 *        μ_BL = [(τΣ)^-1 + P^T Ω^-1 P]^-1 · [(τΣ)^-1 Π + P^T Ω^-1 Q]    (Eq.21)
 *
 *        其中 τ 是 prior 强度 (0.025-0.05 typical)
 *
 * **A 股应用**:
 *   - market cap weights → 沪深 300 实际权重
 *   - views Q 从 quant / AI signals 提取 (e.g. "我认为 sh.600000 月超额 +2%")
 *   - Ω 从 signal 历史准确率反推: 越准 → Ω 越小 → weight 越靠 view
 *
 * **本实现**:
 *   - 提供 computeBlackLittermanPosterior() 主入口
 *   - 提供 buildAbsoluteView(symbol, return, uncertainty) helper
 *   - 提供 buildRelativeView(symbol1, symbol2, spread, uncertainty) helper
 *   - 输出 μ_BL → 给 PortfolioConstructionService max_sharpe 用
 */

/**
 * Pick matrix row (一个 view)
 *
 * 支持两类:
 *   - 'absolute': symbol A 未来收益 = q (e.g. 月 +2%)
 *   - 'relative': symbol A 比 symbol B 高 q (e.g. 月 +1%)
 */
export interface BlackLittermanView {
  type: 'absolute' | 'relative';
  /** 适用 symbol indices */
  symbols: number[];
  /** view 收益值 (decimal e.g. 0.02 = 月 2%) */
  q: number;
  /** view 不确定性 (相对值越大越不确定) */
  uncertainty: number;
}

/**
 * Build pick matrix P (k × n) 和 view vector Q (k) 从 views list
 */
export function buildPickMatrix(
  views: BlackLittermanView[],
  n: number
): {
  P: number[][];
  Q: number[];
  Omega: number[][];
} {
  const k = views.length;
  const P: number[][] = Array.from({ length: k }, () => new Array(n).fill(0));
  const Q: number[] = new Array(k).fill(0);
  const Omega: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));

  for (let i = 0; i < k; i += 1) {
    const v = views[i];
    if (v.type === 'absolute') {
      if (v.symbols.length !== 1) throw new Error(`absolute view 必须 1 个 symbol`);
      P[i][v.symbols[0]] = 1;
    } else if (v.type === 'relative') {
      if (v.symbols.length !== 2) throw new Error(`relative view 必须 2 个 symbols`);
      P[i][v.symbols[0]] = 1;
      P[i][v.symbols[1]] = -1;
    }
    Q[i] = v.q;
    Omega[i][i] = v.uncertainty;
  }

  return { P, Q, Omega };
}

/**
 * 矩阵基础: 求 N×N 矩阵 inverse 用 Gauss-Jordan
 * (small N, no need for fancy linalg)
 */
export function matrixInverse(m: number[][]): number[][] {
  const n = m.length;
  // augment with I
  const aug = m.map((row, i) => {
    const newRow = row.slice();
    for (let j = 0; j < n; j += 1) newRow.push(i === j ? 1 : 0);
    return newRow;
  });
  // Gauss-Jordan elimination with partial pivoting
  for (let i = 0; i < n; i += 1) {
    // find pivot
    let pivot = i;
    let pivotVal = Math.abs(aug[i][i]);
    for (let r = i + 1; r < n; r += 1) {
      if (Math.abs(aug[r][i]) > pivotVal) {
        pivot = r;
        pivotVal = Math.abs(aug[r][i]);
      }
    }
    if (pivotVal < 1e-12) throw new Error(`matrixInverse: singular at row ${i}`);
    if (pivot !== i) [aug[i], aug[pivot]] = [aug[pivot], aug[i]];
    const p = aug[i][i];
    for (let j = 0; j < 2 * n; j += 1) aug[i][j] /= p;
    for (let r = 0; r < n; r += 1) {
      if (r === i) continue;
      const factor = aug[r][i];
      for (let j = 0; j < 2 * n; j += 1) aug[r][j] -= factor * aug[i][j];
    }
  }
  return aug.map(row => row.slice(n));
}

export function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length;
  const n = B[0].length;
  const k = B.length;
  if (A[0].length !== k) throw new Error(`matMul: A cols ${A[0].length} != B rows ${k}`);
  const out: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let s = 0;
      for (let kk = 0; kk < k; kk += 1) s += A[i][kk] * B[kk][j];
      out[i][j] = s;
    }
  }
  return out;
}

export function matVec(A: number[][], v: number[]): number[] {
  const m = A.length;
  if (A[0].length !== v.length)
    throw new Error(`matVec: A cols ${A[0].length} != v length ${v.length}`);
  const out: number[] = new Array(m).fill(0);
  for (let i = 0; i < m; i += 1) {
    let s = 0;
    for (let j = 0; j < v.length; j += 1) s += A[i][j] * v[j];
    out[i] = s;
  }
  return out;
}

export function matTranspose(m: number[][]): number[][] {
  const rows = m.length;
  const cols = m[0].length;
  const out: number[][] = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) out[j][i] = m[i][j];
  }
  return out;
}

/**
 * Black-Litterman implied equilibrium returns Π (Eq.1)
 *
 *   Π = λ · Σ · w_mkt
 *
 * @param sigma cov matrix (N×N)
 * @param marketWeights market cap weights (N,)
 * @param riskAversion λ (default 3 from Idzorek 2007)
 */
export function impliedEquilibriumReturns(
  sigma: number[][],
  marketWeights: number[],
  riskAversion = 3.0
): number[] {
  const N = sigma.length;
  if (marketWeights.length !== N) throw new Error('marketWeights length mismatch');
  // Π[i] = λ · Σ_j sigma[i,j] · w_mkt[j]
  const out: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i += 1) {
    let s = 0;
    for (let j = 0; j < N; j += 1) s += sigma[i][j] * marketWeights[j];
    out[i] = riskAversion * s;
  }
  return out;
}

/**
 * 主入口: Black-Litterman posterior expected returns
 *
 * μ_BL = [(τΣ)^-1 + P^T Ω^-1 P]^-1 · [(τΣ)^-1 Π + P^T Ω^-1 Q]    (Eq.21)
 *
 * @param sigma N×N cov matrix
 * @param marketWeights market equilibrium weights (for Π)
 * @param views list of views (P, Q, Ω built from)
 * @param options.tau prior uncertainty scalar (default 0.05)
 * @param options.risk_aversion λ for Π (default 3.0)
 *
 * @returns posterior expected returns (N,)
 */
export function computeBlackLittermanPosterior(
  sigma: number[][],
  marketWeights: number[],
  views: BlackLittermanView[],
  options: { tau?: number; risk_aversion?: number } = {}
): { posterior_returns: number[]; implied_returns: number[] } {
  const N = sigma.length;
  const tau = options.tau ?? 0.05;
  const lambda = options.risk_aversion ?? 3.0;

  // Step 1: implied equilibrium returns
  const Pi = impliedEquilibriumReturns(sigma, marketWeights, lambda);

  if (views.length === 0) {
    return { posterior_returns: Pi.slice(), implied_returns: Pi };
  }

  // Step 2: build P, Q, Omega
  const { P, Q, Omega } = buildPickMatrix(views, N);
  const k = views.length;

  // tauSigma = tau · Σ
  const tauSigma = sigma.map(row => row.map(v => tau * v));
  const tauSigmaInv = matrixInverse(tauSigma);
  const OmegaInv = matrixInverse(Omega);
  const PT = matTranspose(P);

  // term1: (τΣ)^-1 + P^T Ω^-1 P  (N×N)
  const PT_OmegaInv = matMul(PT, OmegaInv); // N×k
  const PT_OmegaInv_P = matMul(PT_OmegaInv, P); // N×N
  const M_left: number[][] = tauSigmaInv.map((row, i) =>
    row.map((v, j) => v + PT_OmegaInv_P[i][j])
  );
  const M_left_inv = matrixInverse(M_left);

  // term2: (τΣ)^-1 Π + P^T Ω^-1 Q  (N,)
  const tauSigmaInv_Pi = matVec(tauSigmaInv, Pi);
  const PT_OmegaInv_Q = matVec(PT_OmegaInv, Q);
  const rhs = tauSigmaInv_Pi.map((v, i) => v + PT_OmegaInv_Q[i]);

  // posterior = M_left_inv · rhs
  const posterior = matVec(M_left_inv, rhs);
  return { posterior_returns: posterior, implied_returns: Pi };
}

/**
 * Helper: build absolute view
 */
export function buildAbsoluteView(
  symbol_index: number,
  expected_return: number,
  uncertainty: number
): BlackLittermanView {
  return { type: 'absolute', symbols: [symbol_index], q: expected_return, uncertainty };
}

/**
 * Helper: build relative view (symbol A 比 B 高 spread)
 */
export function buildRelativeView(
  symbol_a_index: number,
  symbol_b_index: number,
  spread: number,
  uncertainty: number
): BlackLittermanView {
  return {
    type: 'relative',
    symbols: [symbol_a_index, symbol_b_index],
    q: spread,
    uncertainty,
  };
}
