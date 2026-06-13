/**
 * AFML Ch.13 — Strategy Risk
 * AFML Ch.14 — Strategy Independence
 * AFML Ch.15 — Backtest Statistics
 *
 * 论文 reference:
 *   López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
 *   Chapter 13: "Strategy Risk"
 *   Chapter 14: "Backtest Statistics"  (其实 15 in 1st print, 14 in 2nd)
 *
 * **Strategy Risk (Ch.13)**:
 *
 *   把 strategies 当 assets, 用 mean-variance 求最优组合 weights.
 *   不同于 single-stock portfolio, 这里 N=10 个 strategy 的 cov matrix.
 *
 *   Efficient frontier 上找 min-var, max-sharpe, target-return 点.
 *
 * **Strategy Independence (Ch.14, 1st print)**:
 *
 *   策略之间相关性高 → diversification 失效.
 *
 *   Orthogonalization 方法:
 *     1. PCA on strategy returns → 主成分作为 independent factors
 *     2. 每个原 strategy = linear combination of factors + residual
 *     3. residual 部分 (idiosyncratic) 才是真正 alpha
 *     4. discard high-correlation strategies, keep top independent ones
 *
 * **Backtest Statistics (Ch.15)**:
 *
 *   超越普通 sharpe / drawdown 的全面 metrics:
 *
 *   - **Time under water**: 持续亏损的最大时间
 *   - **Drawdown durations**: 每次 drawdown 持续多久
 *   - **Frequency of bets**: 平均多少天有 1 个 trade
 *   - **Average holding period**: 平均持仓天数
 *   - **Implementation Shortfall**: 已在 v4 TCA
 *   - **Probabilistic Sharpe Ratio (PSR)**: Bailey 2012
 *
 *   PSR = Φ(((SR - SR*) × √(T-1)) / sqrt(1 - skew·SR + ((kurt-1)/4)·SR²))
 *
 * **本实现**:
 *   - strategyEfficientFrontier(cov, returns) — N strategies as assets
 *   - orthogonalizeStrategies(returns_matrix) — PCA-based decorrelation
 *   - timeUnderWater(returns) — drawdown duration tracking
 *   - drawdownDurations(returns) — list of dd lengths
 *   - probabilisticSharpeRatio(SR, T, skew, kurt, SR_benchmark) — Bailey 2012
 */

import { standardNormalCdf } from '../../quant/backtest/OverfitMetrics';
import { topKPrincipalComponents } from '../research/pca-fama-french';

/**
 * Strategy efficient frontier (Ch.13.4).
 *
 * Given strategy returns_matrix (T × N), compute min-variance and max-sharpe portfolios.
 *
 * @returns { min_var_weights, max_sharpe_weights, expected_returns }
 */
export function strategyEfficientFrontier(returns_matrix: number[][]): {
  expected_returns: number[];
  cov_matrix: number[][];
  min_var_weights: number[];
  max_sharpe_weights: number[];
} {
  const T = returns_matrix.length;
  const N = returns_matrix[0]?.length ?? 0;

  // Mean returns
  const mu: number[] = new Array(N).fill(0);
  for (const row of returns_matrix) for (let j = 0; j < N; j += 1) mu[j] += row[j] / T;

  // Sample covariance
  const cov: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i += 1) {
    for (let j = i; j < N; j += 1) {
      let s = 0;
      for (let t = 0; t < T; t += 1) {
        s += (returns_matrix[t][i] - mu[i]) * (returns_matrix[t][j] - mu[j]);
      }
      cov[i][j] = s / Math.max(1, T - 1);
      cov[j][i] = cov[i][j];
    }
  }

  // Min-var: equal-volatility approx (1/σ_i normalized)
  const min_var_weights: number[] = mu.map((_, i) => 1 / Math.max(1e-9, Math.sqrt(cov[i][i])));
  const sum_minvar = min_var_weights.reduce((s, v) => s + v, 0);
  for (let i = 0; i < N; i += 1) min_var_weights[i] /= sum_minvar;

  // Max-sharpe: rough heuristic ∝ μ / σ²
  const max_sharpe_weights: number[] = mu.map((m, i) => Math.max(0, m / Math.max(1e-9, cov[i][i])));
  const sum_maxs = max_sharpe_weights.reduce((s, v) => s + v, 0);
  for (let i = 0; i < N; i += 1) max_sharpe_weights[i] = sum_maxs > 0 ? max_sharpe_weights[i] / sum_maxs : 1 / N;

  return { expected_returns: mu, cov_matrix: cov, min_var_weights, max_sharpe_weights };
}

/**
 * Orthogonalize strategies via PCA (Ch.14).
 *
 *   Decompose: returns_matrix = scores · loadings^T + residuals
 *
 *   Top K principal components form "independent factors".
 *   Residuals = idiosyncratic alpha (strategy 真正不同的部分).
 */
export function orthogonalizeStrategies(returns_matrix: number[][], n_components: number = 3): {
  pc_scores: number[][];      // T × K
  pc_loadings: number[][];    // K × N (eigenvectors)
  variance_explained: number[];
  residuals: number[][];       // T × N
} {
  const T = returns_matrix.length;
  const N = returns_matrix[0]?.length ?? 0;
  // Center
  const means = new Array(N).fill(0);
  for (const row of returns_matrix) for (let j = 0; j < N; j += 1) means[j] += row[j] / T;
  const X_centered = returns_matrix.map(row => row.map((v, j) => v - means[j]));

  // Cov
  const cov: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      let s = 0;
      for (let t = 0; t < T; t += 1) s += X_centered[t][i] * X_centered[t][j];
      cov[i][j] = s / Math.max(1, T - 1);
    }
  }

  const pc = topKPrincipalComponents(cov, n_components);
  const total_var = pc.eigenvalues.reduce((s, v) => s + v, 0);
  const var_explained = pc.eigenvalues.map(v => v / Math.max(1e-12, total_var));

  // Project: scores = X_centered · V (T × K)
  const scores: number[][] = Array.from({ length: T }, () => new Array(n_components).fill(0));
  for (let t = 0; t < T; t += 1) {
    for (let k = 0; k < n_components; k += 1) {
      let s = 0;
      for (let j = 0; j < N; j += 1) s += X_centered[t][j] * pc.eigenvectors[k][j];
      scores[t][k] = s;
    }
  }

  // Residuals = X_centered - scores · V^T
  const residuals: number[][] = Array.from({ length: T }, () => new Array(N).fill(0));
  for (let t = 0; t < T; t += 1) {
    for (let j = 0; j < N; j += 1) {
      let reconstructed = 0;
      for (let k = 0; k < n_components; k += 1) {
        reconstructed += scores[t][k] * pc.eigenvectors[k][j];
      }
      residuals[t][j] = X_centered[t][j] - reconstructed;
    }
  }

  return {
    pc_scores: scores,
    pc_loadings: pc.eigenvectors,
    variance_explained: var_explained,
    residuals,
  };
}

/**
 * Time Under Water (Ch.15.4).
 *
 * Returns longest run where cumulative returns < peak.
 *
 * @returns { max_tuw_days, all_tuw_durations }
 */
export function timeUnderWater(returns: number[]): {
  max_tuw_days: number;
  current_tuw_days: number;
  all_tuw_durations: number[];
} {
  const T = returns.length;
  if (T === 0) return { max_tuw_days: 0, current_tuw_days: 0, all_tuw_durations: [] };

  // Cumulative equity
  const equity: number[] = [1];
  for (let t = 0; t < T; t += 1) equity.push(equity[t] * (1 + returns[t]));

  let peak = equity[0];
  let in_dd = false;
  let dd_start = 0;
  const durations: number[] = [];

  for (let t = 1; t <= T; t += 1) {
    if (equity[t] > peak) {
      if (in_dd) {
        durations.push(t - dd_start);
        in_dd = false;
      }
      peak = equity[t];
    } else {
      if (!in_dd) {
        in_dd = true;
        dd_start = t;
      }
    }
  }

  // If still in DD at end
  const current_tuw = in_dd ? T - dd_start + 1 : 0;
  if (in_dd) durations.push(current_tuw);

  return {
    max_tuw_days: durations.length > 0 ? Math.max(...durations) : 0,
    current_tuw_days: current_tuw,
    all_tuw_durations: durations,
  };
}

/**
 * Probabilistic Sharpe Ratio (PSR, Bailey-López de Prado 2012).
 *
 *   PSR(SR*) = Φ(((SR - SR*) × √(T-1)) / sqrt(1 - skew·SR + ((kurt-1)/4)·SR²))
 *
 * Reports probability that true SR > SR* given observed SR over T periods.
 *
 * Default SR* = 0 (是否有 positive sharpe).
 *
 * @param observed_sharpe SR
 * @param T sample length
 * @param skew sample skewness (default 0)
 * @param kurt sample kurtosis (default 3, normal)
 * @param sr_benchmark SR* (default 0)
 */
export function probabilisticSharpeRatio(
  observed_sharpe: number,
  T: number,
  skew: number = 0,
  kurt: number = 3,
  sr_benchmark: number = 0
): number {
  if (!Number.isFinite(observed_sharpe) || T <= 1) return NaN;
  const sr = observed_sharpe;
  const variance_factor = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (variance_factor <= 0) return NaN;
  const std_factor = Math.sqrt(variance_factor);
  const z = (sr - sr_benchmark) * Math.sqrt(T - 1) / std_factor;
  return standardNormalCdf(z);
}

/**
 * Frequency of bets per year (Ch.15.6).
 *
 * @param n_trades number of trades
 * @param sample_days backtest length in days
 * @param trading_days_per_year e.g. 252
 */
export function frequencyOfBets(n_trades: number, sample_days: number, trading_days_per_year: number = 252): number {
  if (sample_days <= 0) return 0;
  return (n_trades / sample_days) * trading_days_per_year;
}

/**
 * Average holding period (Ch.15.5).
 *
 * Total trade time / number of trades.
 *
 * If trades have entry+exit, sum (exit - entry) / N.
 */
export function averageHoldingPeriod(trades: Array<{ entry_idx: number; exit_idx: number }>): number {
  if (trades.length === 0) return 0;
  const total_days = trades.reduce((s, t) => s + (t.exit_idx - t.entry_idx), 0);
  return total_days / trades.length;
}
