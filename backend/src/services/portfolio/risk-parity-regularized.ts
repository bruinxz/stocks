/**
 * Risk Parity with Regularization
 *
 * 论文 reference:
 *   Maillard, S., Roncalli, T. and Teïletche, J. (2010). "The Properties of
 *   Equally Weighted Risk Contribution Portfolios."
 *   Journal of Portfolio Management 36(4), 60-70.
 *
 *   Bruder, B. and Roncalli, T. (2012). "Managing Risk Exposures using the
 *   Risk Budgeting Approach." SSRN.
 *
 *   Tikhonov 正则化: A. N. Tikhonov (1963). "Solution of incorrectly
 *   formulated problems and the regularization method."
 *
 * **核心问题**:
 *
 *   ERC algorithm 需要 cov · w 的 dot product (computeRiskContributions),
 *   cov 接近 singular (e.g. N > T/3, 高相关资产) 时:
 *     - V_i / target 比值波动大 → w_i 更新震荡
 *     - 几个资产可能拿到极小权重 (numerical floor)
 *     - 收敛慢 (1000+ iter)
 *
 * **Tikhonov 正则化**:
 *
 *   Σ_reg = Σ + λ · I
 *
 *   λ > 0 把 diagonal 加大, 让 cov 远离 singular.
 *   λ 大 → 接近 IVP (inverse-variance, 忽略相关)
 *   λ 小 → 接近 full ERC
 *
 *   推荐 λ = 0.01 × max(diag(Σ)) (与 sklearn ridge regression 默认相似)
 *
 * **Ledoit-Wolf 替代**:
 *
 *   v2 中已实现 Ledoit-Wolf shrinkage:
 *     Σ_LW = (1-δ)·Σ + δ·μ·I
 *
 *   LW 是数据驱动的 δ (closed-form), Tikhonov 是简化的固定 λ.
 *
 *   两者都让 cov 数值稳定. **优先用 LW** (数据自适应); Tikhonov 在 LW 还
 *   不够稳定时作为额外 fallback.
 *
 * **本实现**:
 *   - tikhonovRegularize(cov, lambda) — 简单加 λ·I
 *   - autoTikhonovLambda(cov) — 估 λ = 0.01 × max(diag)
 *   - solveERCRegularized(cov, lambda) — 在 regularized cov 上跑 ERC
 *   - 提供给 PortfolioConstructionService 作为 method='risk_parity_regularized'
 */

import { solveERC } from './PortfolioConstructionService';
// 实际 ERC implementation 在 PortfolioConstructionService 内 export
// 这里 wrap 一个 regularized 版本

/**
 * Tikhonov regularization: Σ + λI
 *
 * 在每个对角元素加 λ. 让矩阵 condition number 改善.
 *
 * @param cov original cov matrix (N×N)
 * @param lambda regularization strength (typical 0.001 - 0.1 × max(diag))
 */
export function tikhonovRegularize(cov: number[][], lambda: number): number[][] {
  const N = cov.length;
  return cov.map((row, i) => row.map((v, j) => (i === j ? v + lambda : v)));
}

/**
 * Auto-estimate Tikhonov λ as a fraction of max(diag(cov)).
 *
 * λ = fraction × max(diag(cov))
 *
 * 默认 fraction = 0.01 (与 sklearn ridge regression 默认 alpha 相似量级)
 */
export function autoTikhonovLambda(cov: number[][], fraction = 0.01): number {
  let maxDiag = 0;
  for (let i = 0; i < cov.length; i += 1) {
    if (cov[i][i] > maxDiag) maxDiag = cov[i][i];
  }
  return fraction * maxDiag;
}

/**
 * Condition number estimate (max/min of diag — 简化版, 真 condition number 需要 eigenvalues)
 *
 * 高 condition number (> 10000) → cov 病态, 需要 regularization.
 *
 * 完整 condition number = λ_max / λ_min (eigenvalues), 这里用对角 max/min 简化.
 */
export function estimateConditionNumber(cov: number[][]): number {
  let maxDiag = -Infinity;
  let minDiag = Infinity;
  for (let i = 0; i < cov.length; i += 1) {
    if (cov[i][i] > maxDiag) maxDiag = cov[i][i];
    if (cov[i][i] < minDiag) minDiag = cov[i][i];
  }
  if (minDiag <= 1e-12) return Infinity;
  return maxDiag / minDiag;
}

/**
 * Solve ERC with Tikhonov-regularized covariance
 *
 * 集成 wrapper:
 *   1. λ = autoTikhonovLambda(cov, fraction)
 *   2. Σ_reg = Σ + λI
 *   3. weights = solveERC(Σ_reg, options)
 *
 * 输出 weights + 实际用的 λ + 原 cov 的 condition number
 */
export function solveERCRegularized(
  cov: number[][],
  options: {
    max_iterations?: number;
    tolerance?: number;
    tikhonov_fraction?: number;
    /** Override 自动 λ */
    tikhonov_lambda?: number;
  } = {}
): {
  weights: number[];
  iterations: number;
  converged: boolean;
  lambda_used: number;
  condition_number_original: number;
  condition_number_regularized: number;
} {
  const fraction = options.tikhonov_fraction ?? 0.01;
  const lambda = options.tikhonov_lambda ?? autoTikhonovLambda(cov, fraction);
  const condOrig = estimateConditionNumber(cov);

  const covReg = tikhonovRegularize(cov, lambda);
  const condReg = estimateConditionNumber(covReg);

  const r = solveERC(covReg, {
    max_iterations: options.max_iterations,
    tolerance: options.tolerance,
  });

  return {
    weights: r.weights,
    iterations: r.iterations,
    converged: r.converged,
    lambda_used: lambda,
    condition_number_original: condOrig,
    condition_number_regularized: condReg,
  };
}

/**
 * Recommend regularization strategy based on cov condition.
 *
 *   - 数据充足 (T > 3N): no regularization needed
 *   - 数据偏少 (N/3 < T ≤ 3N): Tikhonov λ = 0.005 × max(diag) OR Ledoit-Wolf
 *   - 数据极少 (T ≤ N/3) OR condition > 10000: 强制 Ledoit-Wolf + Tikhonov λ = 0.05
 *
 * @param N number of assets
 * @param T number of observations
 * @param cov current cov matrix
 */
export function recommendCovStrategy(
  N: number,
  T: number,
  cov: number[][]
): {
  use_ledoit_wolf: boolean;
  use_tikhonov: boolean;
  tikhonov_fraction: number;
  reason: string;
} {
  const ratio = T / Math.max(1, N);
  const cond = estimateConditionNumber(cov);

  if (ratio > 3 && cond < 1000) {
    return {
      use_ledoit_wolf: false,
      use_tikhonov: false,
      tikhonov_fraction: 0,
      reason: `T/N=${ratio.toFixed(1)} > 3 且 condition=${cond.toFixed(0)} < 1000，样本 cov 已稳定`,
    };
  }
  // 极小样本 OR 极病态 → LW + Tikhonov
  if (ratio <= 0.333 || cond >= 10000) {
    return {
      use_ledoit_wolf: true,
      use_tikhonov: true,
      tikhonov_fraction: 0.05,
      reason: `T/N=${ratio.toFixed(1)} ≤ 0.333 或 condition=${cond.toFixed(
        0
      )} ≥ 10000: 严重病态, 同时用 LW + Tikhonov λ=0.05×max(diag)`,
    };
  }
  // 中等情况: 仅 LW
  return {
    use_ledoit_wolf: true,
    use_tikhonov: false,
    tikhonov_fraction: 0,
    reason: `T/N=${ratio.toFixed(1)}, condition=${cond.toFixed(0)}: 推荐 Ledoit-Wolf shrinkage`,
  };
}
