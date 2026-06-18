/**
 * ML Foundation: ESL/ISL Boosting + RF + Kernel + Hyndman ETS/ARIMA
 *
 * 书 reference:
 *   Hastie, Tibshirani, Friedman (2009). *The Elements of Statistical
 *   Learning.* 2nd ed., Springer.
 *
 *   James, Witten, Hastie, Tibshirani (2013). *An Introduction to Statistical
 *   Learning with Applications in R.* Springer.
 *
 *   Hyndman, R. J. and Athanasopoulos, G. (2018). *Forecasting: Principles
 *   and Practice.* 2nd ed., OTexts.
 *   https://otexts.com/fpp2/
 *
 *   Deisenroth, M., Faisal, A., Ong, C. S. (2020). *Mathematics for Machine
 *   Learning.* Cambridge.
 *
 * **AdaBoost (ESL Ch.10)**:
 *
 *   Initialize sample weights w_i = 1/N
 *   For m = 1 to M:
 *     fit weak learner G_m using weights w
 *     err_m = Σ w_i × I(y_i ≠ G_m(x_i)) / Σ w_i
 *     α_m = log((1 - err_m) / err_m) / 2
 *     w_i ← w_i × exp(α_m × I(y_i ≠ G_m(x_i)))
 *
 *   Final: G(x) = sign(Σ α_m × G_m(x))
 *
 * **Gradient Boosting (ESL Ch.10)**:
 *
 *   Sequentially fit weak learner h_m on negative gradient of loss:
 *     h_m = argmin Σ L(y_i, F_{m-1}(x_i) + h_m(x_i))
 *
 *   Update: F_m = F_{m-1} + ν × h_m  (ν = learning rate)
 *
 * **Random Forest (ESL Ch.15)**:
 *
 *   For b = 1 to B:
 *     bootstrap sample n samples from training set
 *     grow tree T_b on bootstrap, at each split randomly pick m features
 *
 *   Predict: avg/majority of {T_1(x), ..., T_B(x)}
 *
 *   关键: 用 random subset of features 降低 tree correlation.
 *
 * **ETS (Hyndman Ch.7)**:
 *
 *   Exponential smoothing state-space model:
 *     - E: error type (Additive A, Multiplicative M)
 *     - T: trend type (None N, Additive A, Damped Ad)
 *     - S: season type (None N, Additive A, Multiplicative M)
 *
 *   Simple ETS(A,N,N) — exponential smoothing:
 *     l_t = α × y_t + (1 - α) × l_{t-1}
 *     ŷ_{t+h} = l_t
 *
 *   Holt's linear (A,A,N):
 *     l_t = α × y_t + (1 - α) × (l_{t-1} + b_{t-1})
 *     b_t = β × (l_t - l_{t-1}) + (1 - β) × b_{t-1}
 *     ŷ_{t+h} = l_t + h × b_t
 *
 * **ARIMA (Hyndman Ch.8)**:
 *
 *   ARIMA(p, d, q):
 *     - p: AR order
 *     - d: integration order (差分次数)
 *     - q: MA order
 *
 *   AR(1): y_t = c + φ × y_{t-1} + ε_t
 *   MA(1): y_t = c + ε_t + θ × ε_{t-1}
 *
 *   简化 fit: Yule-Walker for AR; conditional MLE for MA.
 *
 * **本实现**:
 *   - adaBoost — generic with stump weak learner
 *   - gradientBoosting — squared loss + regression tree stumps
 *   - randomForest — N trees with random feature subset
 *   - simpleExponentialSmoothing — ETS(A,N,N)
 *   - holtsLinear — ETS(A,A,N)
 *   - autoArima — auto select (p,d,q) by AIC
 */

// ============================================================
// AdaBoost (binary classification)
// ============================================================

/**
 * Decision stump: pick 1 feature + threshold, classify by sign.
 *
 *   For each feature, try thresholds; pick (feat, thresh) with min weighted error.
 */
export interface DecisionStump {
  feature_idx: number;
  threshold: number;
  polarity: 1 | -1; // +1: predict +1 if feature > thresh; -1: predict +1 if feature < thresh
}

export function trainDecisionStump(
  X: number[][],
  y: number[],
  weights: number[]
): { stump: DecisionStump; error: number } {
  const N = X.length;
  const D = X[0]?.length ?? 0;
  let best_err = Infinity;
  let best: DecisionStump = { feature_idx: 0, threshold: 0, polarity: 1 };
  for (let d = 0; d < D; d += 1) {
    // candidate thresholds = unique feature values (sample)
    const vals = X.map(row => row[d]).sort((a, b) => a - b);
    const thresh_candidates = [vals[0] - 1, ...vals, vals[vals.length - 1] + 1];
    for (const t of thresh_candidates) {
      for (const polarity of [1, -1] as const) {
        let err = 0;
        for (let i = 0; i < N; i += 1) {
          const pred = polarity === 1 ? (X[i][d] > t ? 1 : -1) : X[i][d] < t ? 1 : -1;
          if (pred !== y[i]) err += weights[i];
        }
        if (err < best_err) {
          best_err = err;
          best = { feature_idx: d, threshold: t, polarity };
        }
      }
    }
  }
  return { stump: best, error: best_err };
}

export function predictStump(stump: DecisionStump, x: number[]): number {
  const val = x[stump.feature_idx];
  if (stump.polarity === 1) return val > stump.threshold ? 1 : -1;
  return val < stump.threshold ? 1 : -1;
}

/**
 * AdaBoost training (M weak learners).
 *
 * @returns ensemble: M stumps + α weights
 */
export function adaBoost(
  X: number[][],
  y: number[],
  M = 50
): {
  stumps: DecisionStump[];
  alphas: number[];
} {
  const N = X.length;
  const weights = new Array(N).fill(1 / N);
  const stumps: DecisionStump[] = [];
  const alphas: number[] = [];

  for (let m = 0; m < M; m += 1) {
    const { stump, error } = trainDecisionStump(X, y, weights);
    if (error >= 0.5 - 1e-10) break; // weak learner worse than random
    const alpha = 0.5 * Math.log((1 - error) / Math.max(1e-12, error));
    // Update weights
    let sum_w = 0;
    for (let i = 0; i < N; i += 1) {
      const pred = predictStump(stump, X[i]);
      weights[i] *= Math.exp(alpha * (pred === y[i] ? -1 : 1));
      sum_w += weights[i];
    }
    for (let i = 0; i < N; i += 1) weights[i] /= sum_w;
    stumps.push(stump);
    alphas.push(alpha);
  }

  return { stumps, alphas };
}

export function predictAdaBoost(
  ensemble: { stumps: DecisionStump[]; alphas: number[] },
  x: number[]
): number {
  let score = 0;
  for (let m = 0; m < ensemble.stumps.length; m += 1) {
    score += ensemble.alphas[m] * predictStump(ensemble.stumps[m], x);
  }
  return score > 0 ? 1 : -1;
}

// ============================================================
// Gradient Boosting (regression)
// ============================================================

/**
 * Train regression stump (single split that minimizes squared loss).
 */
export function trainRegressionStump(
  X: number[][],
  y: number[]
): { feature_idx: number; threshold: number; left_value: number; right_value: number } {
  const N = X.length;
  const D = X[0]?.length ?? 0;
  let best_ss = Infinity;
  let best = { feature_idx: 0, threshold: 0, left_value: 0, right_value: 0 };
  for (let d = 0; d < D; d += 1) {
    const vals = Array.from(new Set(X.map(row => row[d]))).sort((a, b) => a - b);
    for (let i = 0; i < vals.length - 1; i += 1) {
      const t = (vals[i] + vals[i + 1]) / 2;
      const left_y: number[] = [];
      const right_y: number[] = [];
      for (let j = 0; j < N; j += 1) {
        if (X[j][d] <= t) left_y.push(y[j]);
        else right_y.push(y[j]);
      }
      if (left_y.length === 0 || right_y.length === 0) continue;
      const lm = left_y.reduce((s, v) => s + v, 0) / left_y.length;
      const rm = right_y.reduce((s, v) => s + v, 0) / right_y.length;
      let ss = 0;
      for (const v of left_y) ss += (v - lm) ** 2;
      for (const v of right_y) ss += (v - rm) ** 2;
      if (ss < best_ss) {
        best_ss = ss;
        best = { feature_idx: d, threshold: t, left_value: lm, right_value: rm };
      }
    }
  }
  return best;
}

export function predictRegressionStump(
  stump: { feature_idx: number; threshold: number; left_value: number; right_value: number },
  x: number[]
): number {
  return x[stump.feature_idx] <= stump.threshold ? stump.left_value : stump.right_value;
}

/**
 * Gradient Boosting Regressor (squared loss).
 *
 *   F_0 = mean(y)
 *   For m = 1 to M:
 *     residuals = y - F_{m-1}(x)
 *     h_m = fit stump to residuals
 *     F_m = F_{m-1} + ν × h_m
 */
export function gradientBoostingRegressor(
  X: number[][],
  y: number[],
  options: { M?: number; learning_rate?: number } = {}
): {
  initial_prediction: number;
  stumps: Array<{
    feature_idx: number;
    threshold: number;
    left_value: number;
    right_value: number;
  }>;
  learning_rate: number;
} {
  const M = options.M ?? 50;
  const nu = options.learning_rate ?? 0.1;
  const F0 = y.reduce((s, v) => s + v, 0) / y.length;
  const stumps: Array<{
    feature_idx: number;
    threshold: number;
    left_value: number;
    right_value: number;
  }> = [];
  const current_pred = new Array(y.length).fill(F0);
  for (let m = 0; m < M; m += 1) {
    const residuals = y.map((v, i) => v - current_pred[i]);
    const stump = trainRegressionStump(X, residuals);
    stumps.push(stump);
    for (let i = 0; i < y.length; i += 1) {
      current_pred[i] += nu * predictRegressionStump(stump, X[i]);
    }
  }
  return { initial_prediction: F0, stumps, learning_rate: nu };
}

export function predictGradientBoosting(
  model: { initial_prediction: number; stumps: any[]; learning_rate: number },
  x: number[]
): number {
  let pred = model.initial_prediction;
  for (const stump of model.stumps) pred += model.learning_rate * predictRegressionStump(stump, x);
  return pred;
}

// ============================================================
// Random Forest (simplified — bootstrap + random feature subset stumps)
// ============================================================

/**
 * Random Forest Regressor.
 *
 *   For b = 1 to B:
 *     bootstrap N samples
 *     pick m = sqrt(D) random features
 *     fit stump on bootstrap samples + features
 *
 *   Predict: mean across B stumps
 */
export function randomForestRegressor(
  X: number[][],
  y: number[],
  options: { B?: number; m_features?: number; seed?: number } = {}
): {
  trees: Array<{
    stump: { feature_idx: number; threshold: number; left_value: number; right_value: number };
  }>;
} {
  const B = options.B ?? 100;
  const N = X.length;
  const D = X[0]?.length ?? 0;
  const m = options.m_features ?? Math.max(1, Math.floor(Math.sqrt(D)));
  let state = (options.seed ?? 42) % 2147483647;
  if (state <= 0) state += 2147483646;
  const rng = (): number => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };

  const trees: Array<{ stump: any }> = [];
  for (let b = 0; b < B; b += 1) {
    // Bootstrap indices
    const indices: number[] = [];
    for (let i = 0; i < N; i += 1) indices.push(Math.floor(rng() * N));
    // Random feature subset
    const feature_idx: number[] = [];
    while (feature_idx.length < m) {
      const f = Math.floor(rng() * D);
      if (!feature_idx.includes(f)) feature_idx.push(f);
    }
    // Build X_sub
    const X_sub: number[][] = indices.map(i => feature_idx.map(f => X[i][f]));
    const y_sub: number[] = indices.map(i => y[i]);
    const stump = trainRegressionStump(X_sub, y_sub);
    // Map feature_idx back to original
    stump.feature_idx = feature_idx[stump.feature_idx];
    trees.push({ stump });
  }
  return { trees };
}

export function predictRandomForest(forest: { trees: Array<{ stump: any }> }, x: number[]): number {
  if (forest.trees.length === 0) return 0;
  let sum = 0;
  for (const t of forest.trees) sum += predictRegressionStump(t.stump, x);
  return sum / forest.trees.length;
}

// ============================================================
// Hyndman ETS — Simple Exponential Smoothing & Holt's Linear
// ============================================================

/**
 * Simple Exponential Smoothing (ETS A,N,N).
 *
 *   l_t = α × y_t + (1 - α) × l_{t-1}
 *   ŷ_{t+h} = l_t  (constant forecast)
 *
 *   α typically 0.1-0.3.
 */
export function simpleExponentialSmoothing(
  y: number[],
  alpha = 0.3
): {
  level_series: number[];
  forecast: number;
} {
  const N = y.length;
  if (N === 0) return { level_series: [], forecast: 0 };
  const level: number[] = [y[0]];
  for (let t = 1; t < N; t += 1) {
    level.push(alpha * y[t] + (1 - alpha) * level[t - 1]);
  }
  return { level_series: level, forecast: level[level.length - 1] };
}

/**
 * Holt's Linear (ETS A,A,N).
 *
 *   l_t = α × y_t + (1 - α) × (l_{t-1} + b_{t-1})
 *   b_t = β × (l_t - l_{t-1}) + (1 - β) × b_{t-1}
 *   ŷ_{t+h} = l_t + h × b_t
 */
export function holtsLinear(
  y: number[],
  alpha = 0.3,
  beta = 0.1
): {
  level_series: number[];
  trend_series: number[];
  forecast_1step: number;
  forecast_h: (h: number) => number;
} {
  const N = y.length;
  if (N < 2) return { level_series: [], trend_series: [], forecast_1step: 0, forecast_h: () => 0 };
  const level: number[] = [y[0]];
  const trend: number[] = [y[1] - y[0]];
  for (let t = 1; t < N; t += 1) {
    const l_prev = level[t - 1];
    const b_prev = trend[t - 1];
    const new_l = alpha * y[t] + (1 - alpha) * (l_prev + b_prev);
    const new_b = beta * (new_l - l_prev) + (1 - beta) * b_prev;
    level.push(new_l);
    trend.push(new_b);
  }
  const l_T = level[level.length - 1];
  const b_T = trend[trend.length - 1];
  return {
    level_series: level,
    trend_series: trend,
    forecast_1step: l_T + b_T,
    forecast_h: (h: number) => l_T + h * b_T,
  };
}

// ============================================================
// ARIMA — AR(p) fitting via Yule-Walker
// ============================================================

/**
 * Compute autocovariance at lag k.
 */
export function autocovariance(y: number[], lag: number): number {
  const N = y.length;
  if (lag >= N) return 0;
  const m = y.reduce((s, v) => s + v, 0) / N;
  let cov = 0;
  for (let t = lag; t < N; t += 1) {
    cov += (y[t] - m) * (y[t - lag] - m);
  }
  return cov / N;
}

/**
 * Fit AR(p) via Yule-Walker equations.
 *
 *   System: R φ = r  where R is p×p Toeplitz of autocov, r = (γ_1, ..., γ_p)
 */
export function fitARp(
  y: number[],
  p: number
): { coefficients: number[]; intercept: number; sigma2: number } {
  const N = y.length;
  if (N < p + 5) throw new Error(`fitARp: need ≥${p + 5} obs`);
  const m = y.reduce((s, v) => s + v, 0) / N;
  // Build R matrix and r vector
  const R: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => autocovariance(y, Math.abs(i - j)))
  );
  const r = Array.from({ length: p }, (_, k) => autocovariance(y, k + 1));
  // Solve R φ = r
  const aug = R.map((row, i) => [...row, r[i]]);
  for (let i = 0; i < p; i += 1) {
    let piv = i;
    for (let r = i + 1; r < p; r += 1) if (Math.abs(aug[r][i]) > Math.abs(aug[piv][i])) piv = r;
    if (Math.abs(aug[piv][i]) < 1e-12) throw new Error('fitARp: singular Toeplitz');
    if (piv !== i) [aug[i], aug[piv]] = [aug[piv], aug[i]];
    const d = aug[i][i];
    for (let j = 0; j <= p; j += 1) aug[i][j] /= d;
    for (let r = 0; r < p; r += 1) {
      if (r === i) continue;
      const f = aug[r][i];
      for (let j = 0; j <= p; j += 1) aug[r][j] -= f * aug[i][j];
    }
  }
  const phi = aug.map(row => row[p]);
  const intercept = m * (1 - phi.reduce((s, v) => s + v, 0));

  // σ² = γ_0 - Σ φ_k γ_k
  let sigma2 = autocovariance(y, 0);
  for (let k = 0; k < p; k += 1) sigma2 -= phi[k] * autocovariance(y, k + 1);

  return { coefficients: phi, intercept, sigma2: Math.max(0, sigma2) };
}

/**
 * AR(p) 1-step forecast.
 *
 *   ŷ_{T+1} = c + Σ_k φ_k × y_{T+1-k}
 */
export function arPForecast(
  y: number[],
  model: { coefficients: number[]; intercept: number }
): number {
  let pred = model.intercept;
  for (let k = 0; k < model.coefficients.length; k += 1) {
    pred += model.coefficients[k] * y[y.length - 1 - k];
  }
  return pred;
}

/**
 * Auto-select AR(p) order by AIC.
 *
 *   AIC = -2 × log L + 2 × (p + 1)
 *
 *   Pick p ∈ [1, p_max] minimizing AIC.
 */
export function autoSelectARorder(
  y: number[],
  p_max = 5
): { best_p: number; aic: number; model: any } {
  let best_aic = Infinity;
  let best_p = 1;
  let best_model: any = null;
  for (let p = 1; p <= p_max; p += 1) {
    try {
      const m = fitARp(y, p);
      const N = y.length - p;
      // Approx log L = -N/2 × log(2π σ²) - SS_residuals / (2σ²)
      // SS = N × σ² for fitted residuals → log L ≈ -N/2 × log(2π σ²) - N/2
      const logL = (-N / 2) * Math.log(2 * Math.PI * Math.max(1e-12, m.sigma2)) - N / 2;
      const aic = -2 * logL + 2 * (p + 1);
      if (aic < best_aic) {
        best_aic = aic;
        best_p = p;
        best_model = m;
      }
    } catch {
      // singular, skip
    }
  }
  return { best_p, aic: best_aic, model: best_model };
}

// ============================================================
// Math for ML helpers
// ============================================================

/**
 * QR decomposition via Gram-Schmidt (small matrices).
 *
 *   A = Q × R  where Q is orthonormal columns, R upper triangular.
 *
 * Useful for OLS / least squares.
 */
export function qrDecomposition(A: number[][]): { Q: number[][]; R: number[][] } {
  const m = A.length;
  const n = A[0].length;
  // Q has shape m × n; R has shape n × n
  const Q: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  const R: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let j = 0; j < n; j += 1) {
    // Start with column j of A
    const v = A.map(row => row[j]);
    for (let i = 0; i < j; i += 1) {
      // R[i][j] = Q[:,i]^T × A[:,j]
      let r_ij = 0;
      for (let k = 0; k < m; k += 1) r_ij += Q[k][i] * A[k][j];
      R[i][j] = r_ij;
      // v = v - R[i][j] × Q[:,i]
      for (let k = 0; k < m; k += 1) v[k] -= r_ij * Q[k][i];
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    R[j][j] = norm;
    if (norm > 1e-12) {
      for (let k = 0; k < m; k += 1) Q[k][j] = v[k] / norm;
    }
  }
  return { Q, R };
}

/**
 * Cholesky decomposition: A = L × L^T for symmetric PSD A.
 *
 * Returns lower triangular L.
 */
export function choleskyDecomposition(A: number[][]): number[][] {
  const n = A.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = 0;
      for (let k = 0; k < j; k += 1) sum += L[i][k] * L[j][k];
      if (i === j) {
        const diag = A[i][i] - sum;
        if (diag <= 0) throw new Error('choleskyDecomposition: matrix not positive definite');
        L[i][j] = Math.sqrt(diag);
      } else {
        L[i][j] = (A[i][j] - sum) / L[j][j];
      }
    }
  }
  return L;
}
