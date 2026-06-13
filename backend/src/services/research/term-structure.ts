/**
 * Term Structure Models: Nelson-Siegel + Vasicek
 *
 * 论文 reference:
 *   Nelson, C. R. and Siegel, A. F. (1987). "Parsimonious Modeling of Yield Curves."
 *   Journal of Business 60(4), 473-489.
 *
 *   Vasicek, O. (1977). "An Equilibrium Characterization of the Term Structure."
 *   Journal of Financial Economics 5(2), 177-188.
 *
 * **Nelson-Siegel yield curve**:
 *
 *   y(τ) = β_0 + β_1 · [1 - exp(-τ/λ)] / (τ/λ) + β_2 · {[1 - exp(-τ/λ)] / (τ/λ) - exp(-τ/λ)}
 *
 *   - β_0: long-term level
 *   - β_1: short-term slope (β_0 + β_1 = short rate)
 *   - β_2: curvature
 *   - λ: decay parameter (typical 1-3 years)
 *
 *   适合: 利率期限结构、分红期限结构 (dividend term structure)
 *
 * **Vasicek short rate model**:
 *
 *   dr_t = κ(θ - r_t) dt + σ dW_t                          (Eq.4)
 *
 *   - κ: mean-reversion speed
 *   - θ: long-term mean
 *   - σ: instantaneous volatility
 *   - dW_t: Brownian increment
 *
 *   Closed-form bond price:
 *
 *     P(t, T) = A(t, T) · exp(-B(t, T) · r_t)              (Eq.16)
 *
 *     B = (1 - exp(-κ τ)) / κ
 *     A = exp((θ - σ²/(2κ²)) (B - τ) - σ² B² / (4κ))
 *
 *   Yield: y(τ) = -log(P)/τ = R∞ + (r - R∞) (1 - exp(-κτ)) / (κτ) + σ²/(4κ³τ) (1 - exp(-κτ))²
 *
 * **本实现**:
 *   - nelsonSiegelYield(τ, β_0, β_1, β_2, λ) — closed-form
 *   - fitNelsonSiegel(yields, taus) — OLS with fixed λ
 *   - vasicekYield(τ, r, kappa, theta, sigma)
 *   - fitVasicek(yields) — MLE from short rate path
 */

/**
 * Nelson-Siegel yield function.
 *
 *   y(τ) = β_0 + β_1 · F1(τ, λ) + β_2 · F2(τ, λ)
 *
 *   F1(τ, λ) = (1 - exp(-τ/λ)) / (τ/λ)
 *   F2(τ, λ) = F1(τ, λ) - exp(-τ/λ)
 */
export function nelsonSiegelYield(tau: number, beta_0: number, beta_1: number, beta_2: number, lambda: number): number {
  if (tau <= 0 || lambda <= 0) return beta_0;
  const x = tau / lambda;
  const exp_minus_x = Math.exp(-x);
  const F1 = (1 - exp_minus_x) / x;
  const F2 = F1 - exp_minus_x;
  return beta_0 + beta_1 * F1 + beta_2 * F2;
}

/**
 * Fit Nelson-Siegel to observed yields via OLS (with given λ).
 *
 *   y = β_0 + β_1 F1 + β_2 F2
 *
 *   Build design matrix X = [1, F1, F2], solve β = (X^T X)^{-1} X^T y
 *
 * 简化: λ 固定 (typical 1.5 for monthly horizons)
 *       full optimization: grid search over λ ∈ [0.1, 5]
 */
export function fitNelsonSiegel(
  yields: number[],
  taus: number[],
  options: { lambda?: number; auto_lambda?: boolean } = {}
): {
  beta_0: number;
  beta_1: number;
  beta_2: number;
  lambda: number;
  r_squared: number;
} {
  if (yields.length !== taus.length) throw new Error('fitNelsonSiegel: length mismatch');
  const N = yields.length;

  let best_lambda = options.lambda ?? 1.5;
  let best_result = fitFixedLambda(yields, taus, best_lambda);

  if (options.auto_lambda) {
    for (const lam of [0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0, 5.0]) {
      const r = fitFixedLambda(yields, taus, lam);
      if (r.r_squared > best_result.r_squared) {
        best_result = r;
        best_lambda = lam;
      }
    }
  }

  return { ...best_result, lambda: best_lambda };
}

function fitFixedLambda(yields: number[], taus: number[], lambda: number): { beta_0: number; beta_1: number; beta_2: number; r_squared: number } {
  const N = yields.length;
  // Design matrix
  const k = 3;
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < N; i += 1) {
    const x = taus[i] / lambda;
    const e = Math.exp(-x);
    const F1 = x > 1e-9 ? (1 - e) / x : 1;
    const F2 = F1 - e;
    const row = [1, F1, F2];
    for (let a = 0; a < k; a += 1) {
      Xty[a] += row[a] * yields[i];
      for (let b = 0; b < k; b += 1) XtX[a][b] += row[a] * row[b];
    }
  }
  const aug = XtX.map((r, i) => [...r, Xty[i]]);
  for (let i = 0; i < k; i += 1) {
    let piv = i;
    for (let r = i + 1; r < k; r += 1) if (Math.abs(aug[r][i]) > Math.abs(aug[piv][i])) piv = r;
    if (Math.abs(aug[piv][i]) < 1e-12) return { beta_0: NaN, beta_1: NaN, beta_2: NaN, r_squared: NaN };
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
  const ymean = yields.reduce((s, v) => s + v, 0) / N;
  let ss_tot = 0, ss_res = 0;
  for (let i = 0; i < N; i += 1) {
    const pred = nelsonSiegelYield(taus[i], beta[0], beta[1], beta[2], lambda);
    ss_res += (yields[i] - pred) ** 2;
    ss_tot += (yields[i] - ymean) ** 2;
  }
  return {
    beta_0: beta[0],
    beta_1: beta[1],
    beta_2: beta[2],
    r_squared: ss_tot > 0 ? 1 - ss_res / ss_tot : 0,
  };
}

// ============================================================
// Vasicek
// ============================================================

export interface VasicekParams {
  kappa: number; // mean-reversion
  theta: number; // long-term mean
  sigma: number; // instantaneous vol
}

/**
 * Vasicek bond price P(t, T) under risk-neutral.
 *
 *   B(τ) = (1 - exp(-κ τ)) / κ
 *   A(τ) = exp((θ - σ²/(2κ²)) (B - τ) - σ² B² / (4κ))
 *   P = A · exp(-B · r)
 */
export function vasicekBondPrice(tau: number, r: number, params: VasicekParams): number {
  const { kappa, theta, sigma } = params;
  if (kappa <= 0) return Math.exp(-r * tau); // degenerate
  const B = (1 - Math.exp(-kappa * tau)) / kappa;
  const A = Math.exp((theta - sigma * sigma / (2 * kappa * kappa)) * (B - tau) - (sigma * sigma * B * B) / (4 * kappa));
  return A * Math.exp(-B * r);
}

/**
 * Vasicek yield y(τ) = -log(P) / τ
 */
export function vasicekYield(tau: number, r: number, params: VasicekParams): number {
  if (tau <= 0) return r;
  const P = vasicekBondPrice(tau, r, params);
  return -Math.log(P) / tau;
}

/**
 * Fit Vasicek via OLS on AR(1) form (discrete Euler approx):
 *
 *   r_{t+1} - r_t = κ(θ - r_t) Δt + σ √Δt ε_t
 *   = κ θ Δt - κ r_t Δt + noise
 *
 *   Define a = κ θ Δt, b = -κ Δt
 *   r_{t+1} = r_t (1 + b) + a + noise
 *
 *   OLS: y = α + β x  where y = r_{t+1}, x = r_t
 *       α = a, β = 1 + b → κ = (1 - β) / Δt, θ = α / (κ Δt)
 *
 *   σ = std(residuals) / √Δt
 */
export function fitVasicek(short_rates: number[], dt: number = 1 / 252): VasicekParams {
  const N = short_rates.length;
  if (N < 30) throw new Error(`fitVasicek: need ≥30 obs, got ${N}`);
  const x: number[] = []; // r_t
  const y: number[] = []; // r_{t+1}
  for (let t = 0; t < N - 1; t += 1) {
    if (Number.isFinite(short_rates[t]) && Number.isFinite(short_rates[t + 1])) {
      x.push(short_rates[t]);
      y.push(short_rates[t + 1]);
    }
  }
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, denom = 0;
  for (let i = 0; i < n; i += 1) {
    num += (x[i] - mx) * (y[i] - my);
    denom += (x[i] - mx) ** 2;
  }
  const beta = denom > 0 ? num / denom : 1;
  const alpha = my - beta * mx;

  // Residuals
  let ss_res = 0;
  for (let i = 0; i < n; i += 1) {
    const pred = alpha + beta * x[i];
    ss_res += (y[i] - pred) ** 2;
  }
  const sigma_resid = Math.sqrt(ss_res / Math.max(1, n - 2));

  const kappa = (1 - beta) / dt;
  const theta = kappa > 0 ? alpha / (kappa * dt) : mx;
  const sigma = sigma_resid / Math.sqrt(dt);

  return { kappa: Math.max(1e-6, kappa), theta, sigma: Math.max(1e-9, sigma) };
}
