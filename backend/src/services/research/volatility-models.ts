/**
 * Volatility Models: GARCH(1,1) + EGARCH + HAR-RV
 *
 * 论文 reference:
 *   Bollerslev, T. (1986). "Generalized Autoregressive Conditional Heteroskedasticity."
 *   Journal of Econometrics 31(3), 307-327.
 *
 *   Nelson, D. B. (1991). "Conditional Heteroskedasticity in Asset Returns: A New Approach."
 *   Econometrica 59(2), 347-370. (EGARCH)
 *
 *   Corsi, F. (2009). "A Simple Approximate Long-Memory Model of Realized Volatility."
 *   Journal of Financial Econometrics 7(2), 174-196. (HAR-RV)
 *
 * **GARCH(1,1)** (Bollerslev 1986):
 *
 *   σ²_t = ω + α · r²_{t-1} + β · σ²_{t-1}
 *
 *   稳定性: α + β < 1
 *   长期方差: σ² = ω / (1 - α - β)
 *
 *   MLE: log L = -0.5 Σ (log σ²_t + r²_t / σ²_t)
 *
 * **EGARCH** (Nelson 1991):
 *
 *   log σ²_t = ω + α · |ε_{t-1}| + γ · ε_{t-1} + β · log σ²_{t-1}
 *
 *   优点: 不需要 ω, α, β > 0 约束（log 自然 positive）
 *   γ 捕获 leverage effect (负收益 → 更大 vol)
 *
 * **HAR-RV** (Corsi 2009):
 *
 *   RV_t = β_0 + β_d · RV_{t-1}^{(daily)} + β_w · RV_{t-1}^{(weekly)} + β_m · RV_{t-1}^{(monthly)} + ε_t
 *
 *   - RV^{(d)} = realized variance in past 1 day
 *   - RV^{(w)} = mean RV in past 5 days
 *   - RV^{(m)} = mean RV in past 22 days
 *
 *   简单 OLS, 接近 long-memory (fractional integration) 效果
 */

// ============================================================
// GARCH(1,1) MLE estimation
// ============================================================

export interface GARCHParams {
  omega: number;
  alpha: number;
  beta: number;
}

/**
 * Compute σ²_t sequence given params + returns.
 *
 *   σ²_0 = unconditional variance estimate
 *   σ²_t = ω + α · r²_{t-1} + β · σ²_{t-1}
 */
export function garchVolatility(returns: number[], params: GARCHParams): number[] {
  const T = returns.length;
  if (T === 0) return [];
  // Initial variance = sample variance
  const mean = returns.reduce((s, v) => s + v, 0) / T;
  const sample_var = T > 1 ? returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (T - 1) : 1;
  const sigma2: number[] = new Array(T).fill(sample_var);
  for (let t = 1; t < T; t += 1) {
    sigma2[t] = params.omega + params.alpha * returns[t - 1] ** 2 + params.beta * sigma2[t - 1];
    if (sigma2[t] < 1e-12) sigma2[t] = 1e-12;
  }
  return sigma2;
}

/**
 * Negative log-likelihood for MLE (we minimize)
 *
 *   -log L = 0.5 Σ (log σ²_t + r²_t / σ²_t)
 */
export function garchNegLogLikelihood(returns: number[], params: GARCHParams): number {
  if (params.alpha < 0 || params.beta < 0 || params.omega < 0) return Infinity;
  if (params.alpha + params.beta >= 0.999) return Infinity; // stationarity
  const sigma2 = garchVolatility(returns, params);
  let nll = 0;
  for (let t = 0; t < returns.length; t += 1) {
    nll += 0.5 * (Math.log(sigma2[t]) + (returns[t] ** 2) / sigma2[t]);
  }
  return nll;
}

/**
 * GARCH(1,1) MLE via grid search + local refinement.
 *
 * 简化版: 不用 BFGS, 用 coordinate descent.
 */
export function fitGARCH(returns: number[]): { params: GARCHParams; log_likelihood: number; converged: boolean } {
  const T = returns.length;
  if (T < 30) throw new Error(`fitGARCH: need ≥30 obs, got ${T}`);

  // Initial guess
  const mean = returns.reduce((s, v) => s + v, 0) / T;
  const sample_var = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (T - 1);
  let best: GARCHParams = { omega: 0.05 * sample_var, alpha: 0.1, beta: 0.85 };
  let best_nll = garchNegLogLikelihood(returns, best);

  // Grid search around init
  for (const alpha of [0.05, 0.08, 0.10, 0.12, 0.15, 0.20]) {
    for (const beta of [0.70, 0.75, 0.80, 0.85, 0.88, 0.90]) {
      if (alpha + beta >= 0.99) continue;
      const omega = sample_var * (1 - alpha - beta);
      const params = { omega, alpha, beta };
      const nll = garchNegLogLikelihood(returns, params);
      if (nll < best_nll) {
        best_nll = nll;
        best = params;
      }
    }
  }

  // Coordinate descent refinement
  let converged = false;
  for (let iter = 0; iter < 50; iter += 1) {
    let improved = false;
    const candidates: GARCHParams[] = [
      { ...best, alpha: Math.max(0.001, best.alpha * 0.95) },
      { ...best, alpha: Math.min(0.99 - best.beta, best.alpha * 1.05) },
      { ...best, beta: Math.max(0.001, best.beta * 0.99) },
      { ...best, beta: Math.min(0.99 - best.alpha, best.beta * 1.01) },
      { ...best, omega: Math.max(1e-10, best.omega * 0.9) },
      { ...best, omega: best.omega * 1.1 },
    ];
    for (const c of candidates) {
      const nll = garchNegLogLikelihood(returns, c);
      if (nll < best_nll - 1e-6) {
        best_nll = nll;
        best = c;
        improved = true;
      }
    }
    if (!improved) {
      converged = true;
      break;
    }
  }

  return { params: best, log_likelihood: -best_nll, converged };
}

/**
 * Forecast σ²_{T+1} given fit
 */
export function garchForecast(returns: number[], params: GARCHParams): number {
  const sigma2 = garchVolatility(returns, params);
  const last_r2 = returns[returns.length - 1] ** 2;
  const last_sigma2 = sigma2[sigma2.length - 1];
  return params.omega + params.alpha * last_r2 + params.beta * last_sigma2;
}

// ============================================================
// EGARCH (Nelson 1991)
// ============================================================

export interface EGARCHParams {
  omega: number;
  alpha: number;
  gamma: number; // leverage
  beta: number;
}

export function egarchVolatility(returns: number[], params: EGARCHParams): number[] {
  const T = returns.length;
  const mean = returns.reduce((s, v) => s + v, 0) / T;
  const sample_var = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, T - 1);
  const log_sigma2: number[] = new Array(T).fill(Math.log(sample_var));
  const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI);
  for (let t = 1; t < T; t += 1) {
    const sigma_prev = Math.sqrt(Math.exp(log_sigma2[t - 1]));
    const eps = returns[t - 1] / Math.max(1e-12, sigma_prev);
    const abs_eps_minus_E = Math.abs(eps) - SQRT_2_OVER_PI;
    log_sigma2[t] = params.omega + params.alpha * abs_eps_minus_E + params.gamma * eps + params.beta * log_sigma2[t - 1];
  }
  return log_sigma2.map(v => Math.exp(v));
}

export function egarchNegLogLikelihood(returns: number[], params: EGARCHParams): number {
  if (Math.abs(params.beta) >= 0.999) return Infinity;
  const sigma2 = egarchVolatility(returns, params);
  let nll = 0;
  for (let t = 0; t < returns.length; t += 1) {
    nll += 0.5 * (Math.log(sigma2[t]) + (returns[t] ** 2) / sigma2[t]);
  }
  return nll;
}

/**
 * Fit EGARCH via simple grid + coordinate descent.
 */
export function fitEGARCH(returns: number[]): { params: EGARCHParams; log_likelihood: number; converged: boolean } {
  const T = returns.length;
  if (T < 30) throw new Error(`fitEGARCH: need ≥30 obs, got ${T}`);

  let best: EGARCHParams = { omega: -0.1, alpha: 0.1, gamma: -0.05, beta: 0.95 };
  let best_nll = egarchNegLogLikelihood(returns, best);
  for (const alpha of [0.05, 0.1, 0.15]) {
    for (const gamma of [-0.1, -0.05, 0, 0.05]) {
      for (const beta of [0.85, 0.9, 0.95, 0.98]) {
        for (const omega of [-0.5, -0.2, -0.1, -0.05]) {
          const params = { omega, alpha, gamma, beta };
          const nll = egarchNegLogLikelihood(returns, params);
          if (nll < best_nll) {
            best_nll = nll;
            best = params;
          }
        }
      }
    }
  }

  let converged = false;
  for (let iter = 0; iter < 30; iter += 1) {
    let improved = false;
    const steps = [-0.02, -0.01, 0.01, 0.02];
    for (const key of ['omega', 'alpha', 'gamma', 'beta'] as const) {
      for (const step of steps) {
        const c: EGARCHParams = { ...best };
        c[key] = best[key] + step;
        if (key === 'beta' && Math.abs(c.beta) >= 0.999) continue;
        const nll = egarchNegLogLikelihood(returns, c);
        if (nll < best_nll - 1e-6) {
          best_nll = nll;
          best = c;
          improved = true;
        }
      }
    }
    if (!improved) {
      converged = true;
      break;
    }
  }
  return { params: best, log_likelihood: -best_nll, converged };
}

// ============================================================
// HAR-RV (Corsi 2009)
// ============================================================

export interface HARRVParams {
  beta_0: number;
  beta_d: number;
  beta_w: number;
  beta_m: number;
}

/**
 * Compute Realized Variance series (sum of squared intraday returns OR proxy
 * by daily squared return if no intraday).
 *
 * Here for daily data, RV_t = r_t² (proxy).
 */
export function realizedVariance(returns: number[]): number[] {
  return returns.map(r => r * r);
}

/**
 * Fit HAR-RV via OLS.
 *
 *   RV_t = β_0 + β_d RV_{t-1} + β_w mean(RV_{t-5..t-1}) + β_m mean(RV_{t-22..t-1}) + ε
 *
 * 需要 T ≥ 22 + 5 = 27 obs.
 */
export function fitHARRV(rv: number[]): { params: HARRVParams; r_squared: number; n_samples: number } {
  const T = rv.length;
  if (T < 30) throw new Error(`fitHARRV: need ≥30 obs, got ${T}`);

  const features: number[][] = [];
  const targets: number[] = [];
  for (let t = 22; t < T; t += 1) {
    if (!Number.isFinite(rv[t])) continue;
    const rv_d = rv[t - 1];
    const rv_w = rv.slice(t - 5, t).reduce((s, v) => s + v, 0) / 5;
    const rv_m = rv.slice(t - 22, t).reduce((s, v) => s + v, 0) / 22;
    if (![rv_d, rv_w, rv_m].every(Number.isFinite)) continue;
    features.push([1, rv_d, rv_w, rv_m]);
    targets.push(rv[t]);
  }

  const k = 4;
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < features.length; i += 1) {
    for (let a = 0; a < k; a += 1) {
      Xty[a] += features[i][a] * targets[i];
      for (let b = 0; b < k; b += 1) XtX[a][b] += features[i][a] * features[i][b];
    }
  }
  // Gauss-Jordan
  const aug = XtX.map((row, i) => [...row, Xty[i]]);
  for (let i = 0; i < k; i += 1) {
    let piv = i;
    for (let r = i + 1; r < k; r += 1) if (Math.abs(aug[r][i]) > Math.abs(aug[piv][i])) piv = r;
    if (Math.abs(aug[piv][i]) < 1e-12) {
      return { params: { beta_0: NaN, beta_d: NaN, beta_w: NaN, beta_m: NaN }, r_squared: NaN, n_samples: targets.length };
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
  const ymean = targets.reduce((s, v) => s + v, 0) / targets.length;
  let ss_tot = 0, ss_res = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const pred = beta[0] + beta[1] * features[i][1] + beta[2] * features[i][2] + beta[3] * features[i][3];
    ss_res += (targets[i] - pred) ** 2;
    ss_tot += (targets[i] - ymean) ** 2;
  }
  return {
    params: { beta_0: beta[0], beta_d: beta[1], beta_w: beta[2], beta_m: beta[3] },
    r_squared: ss_tot > 0 ? 1 - ss_res / ss_tot : 0,
    n_samples: targets.length,
  };
}

/**
 * Forecast RV_{t+1} given HAR-RV fit
 */
export function harRVForecast(rv: number[], params: HARRVParams): number {
  const T = rv.length;
  if (T < 22) return NaN;
  const rv_d = rv[T - 1];
  const rv_w = rv.slice(T - 5, T).reduce((s, v) => s + v, 0) / 5;
  const rv_m = rv.slice(T - 22, T).reduce((s, v) => s + v, 0) / 22;
  return params.beta_0 + params.beta_d * rv_d + params.beta_w * rv_w + params.beta_m * rv_m;
}
