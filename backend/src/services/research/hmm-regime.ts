/**
 * Hidden Markov Model for Regime Detection
 *
 * 论文 reference:
 *   Hamilton, J. D. (1989). "A New Approach to the Economic Analysis of
 *   Nonstationary Time Series and the Business Cycle."
 *   Econometrica 57(2), 357-384.
 *   https://www.jstor.org/stable/1912559
 *
 *   Rabiner, L. R. (1989). "A Tutorial on Hidden Markov Models and Selected
 *   Applications in Speech Recognition."
 *   Proceedings of the IEEE 77(2), 257-286.
 *
 *   Baum, L. E. and Welch, L. (1970). 原始 EM 算法 for HMM.
 *
 * **核心问题**:
 *
 *   现 MarketEnvironmentService 用 hard rules 判 regime:
 *     - benchmark 30d return > +5% → bull
 *     - < -5% → bear
 *     - else → range
 *
 *   这是 deterministic 切换, 缺点:
 *     - 阈值 ±5% 拍脑袋, 不是从数据学的
 *     - regime 转换无 "概率" 表示 (只有硬切换)
 *     - 不能处理多 regime (e.g. 4-state: bull-quiet / bull-volatile / bear-quiet / bear-volatile)
 *
 * **HMM 模型 (Hamilton 1989 for finance)**:
 *
 *   假设市场处于 K 个 hidden state (regime) 之一. 每个 regime 有自己的:
 *     - mean return μ_k
 *     - volatility σ_k
 *
 *   观测 y_t (daily return) ~ Normal(μ_{s_t}, σ_{s_t})
 *
 *   状态转移: P(s_t = j | s_{t-1} = i) = a_{i,j}  (transition matrix A)
 *
 *   未知参数: π (initial prob), A (K×K transition), μ_k, σ_k for each k
 *
 * **算法**:
 *
 *   1. **Forward-Backward** (computes P(s_t = k | y_1..T)):
 *
 *      α_t(k) = P(y_1..t, s_t = k)       (forward)
 *      β_t(k) = P(y_{t+1}..T | s_t = k)   (backward)
 *      γ_t(k) = α_t(k)·β_t(k) / Σ_j α_t(j)·β_t(j)   (posterior, Eq.27-28 Rabiner)
 *
 *   2. **Baum-Welch EM** (training):
 *      E-step: compute γ_t(k), ξ_t(i,j) given current params
 *      M-step: update π, A, μ, σ to maximize log-likelihood
 *      Repeat until convergence
 *
 *   3. **Viterbi** (most likely sequence):
 *      δ_t(k) = max over previous path P(s_1..t-1, s_t = k, y_1..t)
 *      backtrack the argmax → most likely regime sequence
 *
 * **本实现**:
 *   - K=4 default (bull, bear, range, volatile)
 *   - Gaussian emissions
 *   - Pure functions: forward, backward, baumWelch, viterbi
 *   - 用 log-space computation 防 underflow
 *   - 数学验证: Forward-Backward symmetry, Viterbi 最优路径, Baum-Welch 收敛
 */

const LOG_2PI = Math.log(2 * Math.PI);

/**
 * Log Gaussian PDF: log N(x | μ, σ²)
 */
export function logGaussianPdf(x: number, mu: number, sigma: number): number {
  if (sigma <= 0) return -Infinity;
  const z = (x - mu) / sigma;
  return -0.5 * LOG_2PI - Math.log(sigma) - 0.5 * z * z;
}

/**
 * Log-sum-exp trick (避免 underflow)
 *
 *   log(Σ exp(x_i)) = max + log(Σ exp(x_i - max))
 */
export function logSumExp(logProbs: number[]): number {
  let max = -Infinity;
  for (const v of logProbs) if (v > max) max = v;
  if (!Number.isFinite(max)) return -Infinity;
  let s = 0;
  for (const v of logProbs) s += Math.exp(v - max);
  return max + Math.log(s);
}

export interface HMMParams {
  /** K, number of hidden states */
  K: number;
  /** Initial state probabilities (length K), should sum to 1 */
  pi: number[];
  /** Transition matrix (K × K), rows sum to 1 */
  A: number[][];
  /** Gaussian emission means (length K) */
  mu: number[];
  /** Gaussian emission std (length K) */
  sigma: number[];
}

/**
 * Forward algorithm (log-space).
 *
 *   α_t(k) = P(y_1..t, s_t = k)
 *
 *   log α_t(k) = log b_k(y_t) + log Σ_j exp(log α_{t-1}(j) + log A[j,k])
 *
 * @returns log_alpha matrix (T × K), log P(y_1..t) for each t & state
 */
export function hmmForward(
  params: HMMParams,
  observations: number[]
): {
  log_alpha: number[][];
  log_likelihood: number;
} {
  const T = observations.length;
  const K = params.K;
  if (T === 0) return { log_alpha: [], log_likelihood: 0 };

  const log_alpha: number[][] = Array.from({ length: T }, () => new Array(K).fill(0));

  // t = 0: log α_0(k) = log π_k + log b_k(y_0)
  for (let k = 0; k < K; k += 1) {
    log_alpha[0][k] =
      Math.log(Math.max(1e-300, params.pi[k])) +
      logGaussianPdf(observations[0], params.mu[k], params.sigma[k]);
  }

  // t = 1..T-1
  for (let t = 1; t < T; t += 1) {
    for (let k = 0; k < K; k += 1) {
      const probsArr: number[] = [];
      for (let j = 0; j < K; j += 1) {
        probsArr.push(log_alpha[t - 1][j] + Math.log(Math.max(1e-300, params.A[j][k])));
      }
      log_alpha[t][k] =
        logSumExp(probsArr) + logGaussianPdf(observations[t], params.mu[k], params.sigma[k]);
    }
  }

  // log P(y_1..T) = log Σ_k α_T(k)
  const log_likelihood = logSumExp(log_alpha[T - 1]);
  return { log_alpha, log_likelihood };
}

/**
 * Backward algorithm (log-space).
 *
 *   β_t(k) = P(y_{t+1}..T | s_t = k)
 *
 *   log β_T(k) = 0 (P=1)
 *   log β_t(k) = log Σ_j exp(log A[k,j] + log b_j(y_{t+1}) + log β_{t+1}(j))
 */
export function hmmBackward(params: HMMParams, observations: number[]): number[][] {
  const T = observations.length;
  const K = params.K;
  const log_beta: number[][] = Array.from({ length: T }, () => new Array(K).fill(0));
  if (T === 0) return log_beta;

  // t = T-1: log β_{T-1}(k) = 0 (factor accounts for "all probability comes from absorbing observation y_T")
  // 注: 这里用 standard convention: β_{T-1}(k) = 1 不需 absorbing
  // log_beta[T-1] = all zeros (already)

  for (let t = T - 2; t >= 0; t -= 1) {
    for (let k = 0; k < K; k += 1) {
      const probsArr: number[] = [];
      for (let j = 0; j < K; j += 1) {
        probsArr.push(
          Math.log(Math.max(1e-300, params.A[k][j])) +
            logGaussianPdf(observations[t + 1], params.mu[j], params.sigma[j]) +
            log_beta[t + 1][j]
        );
      }
      log_beta[t][k] = logSumExp(probsArr);
    }
  }
  return log_beta;
}

/**
 * Posterior state probabilities γ_t(k) = P(s_t = k | y_1..T)
 *
 *   γ_t(k) = α_t(k)·β_t(k) / Σ_j α_t(j)·β_t(j)
 *
 * In log-space:
 *   log γ_t(k) = log α_t(k) + log β_t(k) - log P(y_1..T at time t)
 */
export function hmmPosteriorStates(log_alpha: number[][], log_beta: number[][]): number[][] {
  const T = log_alpha.length;
  const K = T > 0 ? log_alpha[0].length : 0;
  const gamma: number[][] = Array.from({ length: T }, () => new Array(K).fill(0));
  for (let t = 0; t < T; t += 1) {
    const logSum = logSumExp(log_alpha[t].map((la, k) => la + log_beta[t][k]));
    for (let k = 0; k < K; k += 1) {
      gamma[t][k] = Math.exp(log_alpha[t][k] + log_beta[t][k] - logSum);
    }
  }
  return gamma;
}

/**
 * Viterbi algorithm: most likely hidden state sequence.
 *
 *   δ_t(k) = max over previous states' path likelihood
 *
 * @returns most likely state sequence (length T)
 */
export function hmmViterbi(
  params: HMMParams,
  observations: number[]
): {
  states: number[];
  log_max_likelihood: number;
} {
  const T = observations.length;
  const K = params.K;
  if (T === 0) return { states: [], log_max_likelihood: -Infinity };

  const log_delta: number[][] = Array.from({ length: T }, () => new Array(K).fill(0));
  const psi: number[][] = Array.from({ length: T }, () => new Array(K).fill(0));

  // t = 0
  for (let k = 0; k < K; k += 1) {
    log_delta[0][k] =
      Math.log(Math.max(1e-300, params.pi[k])) +
      logGaussianPdf(observations[0], params.mu[k], params.sigma[k]);
  }

  // t = 1..T-1
  for (let t = 1; t < T; t += 1) {
    for (let k = 0; k < K; k += 1) {
      let bestVal = -Infinity;
      let bestPrev = 0;
      for (let j = 0; j < K; j += 1) {
        const v = log_delta[t - 1][j] + Math.log(Math.max(1e-300, params.A[j][k]));
        if (v > bestVal) {
          bestVal = v;
          bestPrev = j;
        }
      }
      log_delta[t][k] = bestVal + logGaussianPdf(observations[t], params.mu[k], params.sigma[k]);
      psi[t][k] = bestPrev;
    }
  }

  // Termination
  let bestEnd = 0;
  let bestEndVal = log_delta[T - 1][0];
  for (let k = 1; k < K; k += 1) {
    if (log_delta[T - 1][k] > bestEndVal) {
      bestEndVal = log_delta[T - 1][k];
      bestEnd = k;
    }
  }

  // Backtrack
  const states = new Array(T).fill(0);
  states[T - 1] = bestEnd;
  for (let t = T - 2; t >= 0; t -= 1) {
    states[t] = psi[t + 1][states[t + 1]];
  }

  return { states, log_max_likelihood: bestEndVal };
}

/**
 * Baum-Welch EM training (Rabiner 1989 Section IV).
 *
 * **E-step**:
 *   γ_t(k) — posterior of being in state k at time t
 *   ξ_t(i,j) — posterior of transition i → j at time t
 *
 * **M-step**:
 *   π_k = γ_0(k)
 *   A[i,j] = Σ_t ξ_t(i,j) / Σ_t γ_t(i)
 *   μ_k = Σ_t γ_t(k)·y_t / Σ_t γ_t(k)
 *   σ_k² = Σ_t γ_t(k)·(y_t - μ_k)² / Σ_t γ_t(k)
 *
 * 收敛: log-likelihood 增量 < tolerance.
 */
export function hmmBaumWelch(
  observations: number[],
  initial_params: HMMParams,
  options: { max_iter?: number; tolerance?: number; min_sigma?: number } = {}
): {
  params: HMMParams;
  log_likelihood_history: number[];
  iterations: number;
  converged: boolean;
} {
  const max_iter = options.max_iter ?? 50;
  const tol = options.tolerance ?? 1e-4;
  const min_sigma = options.min_sigma ?? 1e-4;
  const T = observations.length;
  const K = initial_params.K;

  let params: HMMParams = {
    K,
    pi: initial_params.pi.slice(),
    A: initial_params.A.map(row => row.slice()),
    mu: initial_params.mu.slice(),
    sigma: initial_params.sigma.slice(),
  };
  const history: number[] = [];
  let converged = false;
  let iter = 0;

  for (iter = 0; iter < max_iter; iter += 1) {
    // E-step
    const { log_alpha, log_likelihood } = hmmForward(params, observations);
    const log_beta = hmmBackward(params, observations);
    const gamma = hmmPosteriorStates(log_alpha, log_beta);

    // ξ_t(i,j) = P(s_t = i, s_{t+1} = j | y)
    // In log: log ξ_t(i,j) = log α_t(i) + log A[i,j] + log b_j(y_{t+1}) + log β_{t+1}(j) - log P(y)
    const xi: number[][][] = []; // T-1 × K × K
    for (let t = 0; t < T - 1; t += 1) {
      const xi_t: number[][] = Array.from({ length: K }, () => new Array(K).fill(0));
      // compute unnormalized log values
      const log_vals: number[][] = Array.from({ length: K }, () => new Array(K).fill(-Infinity));
      const all_logs: number[] = [];
      for (let i = 0; i < K; i += 1) {
        for (let j = 0; j < K; j += 1) {
          const v =
            log_alpha[t][i] +
            Math.log(Math.max(1e-300, params.A[i][j])) +
            logGaussianPdf(observations[t + 1], params.mu[j], params.sigma[j]) +
            log_beta[t + 1][j];
          log_vals[i][j] = v;
          all_logs.push(v);
        }
      }
      const logZ = logSumExp(all_logs);
      for (let i = 0; i < K; i += 1) {
        for (let j = 0; j < K; j += 1) {
          xi_t[i][j] = Math.exp(log_vals[i][j] - logZ);
        }
      }
      xi.push(xi_t);
    }

    // M-step
    // π_k = γ_0(k)
    const new_pi = gamma[0].slice();

    // A[i,j] = Σ_t ξ_t(i,j) / Σ_t γ_t(i) (over t=0..T-2)
    const new_A: number[][] = Array.from({ length: K }, () => new Array(K).fill(0));
    for (let i = 0; i < K; i += 1) {
      let denom = 0;
      for (let t = 0; t < T - 1; t += 1) denom += gamma[t][i];
      for (let j = 0; j < K; j += 1) {
        let num = 0;
        for (let t = 0; t < T - 1; t += 1) num += xi[t][i][j];
        new_A[i][j] = denom > 0 ? num / denom : params.A[i][j];
      }
      // 防 row 全 0: keep prior
      const rowSum = new_A[i].reduce((s, v) => s + v, 0);
      if (rowSum > 0) {
        for (let j = 0; j < K; j += 1) new_A[i][j] /= rowSum;
      }
    }

    // μ_k = Σ γ_t(k) y_t / Σ γ_t(k)
    const new_mu = new Array(K).fill(0);
    const new_sigma = new Array(K).fill(min_sigma);
    for (let k = 0; k < K; k += 1) {
      let num_mu = 0;
      let denom = 0;
      for (let t = 0; t < T; t += 1) {
        num_mu += gamma[t][k] * observations[t];
        denom += gamma[t][k];
      }
      if (denom > 1e-12) {
        new_mu[k] = num_mu / denom;
      } else {
        new_mu[k] = params.mu[k]; // keep prior
      }
      let num_sigma = 0;
      for (let t = 0; t < T; t += 1) {
        num_sigma += gamma[t][k] * (observations[t] - new_mu[k]) ** 2;
      }
      new_sigma[k] =
        denom > 1e-12
          ? Math.sqrt(Math.max(min_sigma * min_sigma, num_sigma / denom))
          : params.sigma[k];
    }

    params = { K, pi: new_pi, A: new_A, mu: new_mu, sigma: new_sigma };
    history.push(log_likelihood);

    if (history.length >= 2) {
      const delta = history[history.length - 1] - history[history.length - 2];
      if (Math.abs(delta) < tol) {
        converged = true;
        break;
      }
    }
  }

  return { params, log_likelihood_history: history, iterations: iter + 1, converged };
}

/**
 * Initialize HMM params heuristically from observations.
 *
 *   - π uniform
 *   - A uniform-ish with self-transition bias (0.85 self, 0.15/(K-1) others)
 *   - μ_k spread across observed range (k * (max-min)/(K-1) + min)
 *   - σ_k = overall std
 */
export function initializeHMMParams(observations: number[], K: number): HMMParams {
  const T = observations.length;
  if (T === 0 || K < 1) throw new Error('initializeHMMParams: invalid input');

  const mean = observations.reduce((s, v) => s + v, 0) / T;
  const variance = T > 1 ? observations.reduce((s, v) => s + (v - mean) ** 2, 0) / (T - 1) : 1;
  const std = Math.sqrt(Math.max(1e-6, variance));
  let minV = Infinity,
    maxV = -Infinity;
  for (const v of observations) {
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const pi = new Array(K).fill(1 / K);
  const A: number[][] = Array.from({ length: K }, (_, i) =>
    Array.from({ length: K }, (_, j) => (i === j ? 0.85 : 0.15 / (K - 1 || 1)))
  );
  const mu: number[] = [];
  const sigma: number[] = [];
  for (let k = 0; k < K; k += 1) {
    mu.push(K > 1 ? minV + (k / (K - 1)) * (maxV - minV) : mean);
    sigma.push(std);
  }
  return { K, pi, A, mu, sigma };
}

/**
 * Decode regime labels (e.g. 'bull' / 'bear' / 'range' / 'volatile') from state index.
 *
 * Heuristic: sort states by μ then assign:
 *   K=2: [bear, bull]
 *   K=3: [bear, range, bull]
 *   K=4: [bear, range, bull, ...] + 用 σ 区分 quiet/volatile
 */
export function decodeRegimeLabels(params: HMMParams): string[] {
  const K = params.K;
  const indexed = params.mu.map((m, i) => ({ m, sigma: params.sigma[i], i }));
  indexed.sort((a, b) => a.m - b.m);
  const labels = new Array(K).fill('');
  if (K === 2) {
    labels[indexed[0].i] = 'bear';
    labels[indexed[1].i] = 'bull';
  } else if (K === 3) {
    labels[indexed[0].i] = 'bear';
    labels[indexed[1].i] = 'range';
    labels[indexed[2].i] = 'bull';
  } else if (K === 4) {
    // 2 low-mean states 用 σ 区分 (volatile vs quiet bear)
    // 2 high-mean states 同样区分
    const low = [indexed[0], indexed[1]].sort((a, b) => a.sigma - b.sigma);
    labels[low[0].i] = 'range'; // low return, low vol
    labels[low[1].i] = 'bear';
    const high = [indexed[2], indexed[3]].sort((a, b) => a.sigma - b.sigma);
    labels[high[0].i] = 'bull';
    labels[high[1].i] = 'volatile';
  } else {
    for (let k = 0; k < K; k += 1) labels[indexed[k].i] = `regime_${k}`;
  }
  return labels;
}
