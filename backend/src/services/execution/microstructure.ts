/**
 * Market Microstructure: Kyle's Lambda + Glosten-Milgrom Adverse Selection
 *
 * 论文 reference:
 *   1. Kyle, A. S. (1985). "Continuous Auctions and Insider Trading."
 *      Econometrica 53(6), 1315-1335.
 *      https://www.jstor.org/stable/1913210
 *
 *   2. Glosten, L. R. and Milgrom, P. R. (1985). "Bid, Ask and Transaction
 *      Prices in a Specialist Market with Heterogeneously Informed Traders."
 *      Journal of Financial Economics 14(1), 71-100.
 *
 *   3. Harris, L. (2003). *Trading and Exchanges: Market Microstructure for
 *      Practitioners.* Oxford University Press.
 *      Chapter 14: "Liquidity Suppliers and Liquidity Demanders"
 *
 * **Kyle's Lambda (1985)** — 价格冲击系数:
 *
 *   ΔP_t = λ · Q_t + ε_t
 *
 *   其中 Q_t 是 order flow imbalance, λ 是 Kyle's lambda.
 *
 *   λ 通过 OLS 估计: λ̂ = Cov(ΔP, Q) / Var(Q)
 *
 *   λ 越大 → 流动性差 → 同等订单 price impact 越大
 *
 *   λ 是 Almgren-Chriss permanent impact γ 的实证测量:
 *     - Almgren-Chriss 假设 γ = 0.314·σ/V (理论值)
 *     - Kyle's lambda 从真实数据回归直接测出 (实证值)
 *
 * **Glosten-Milgrom (1985)** — Adverse selection spread component:
 *
 *   总 bid-ask spread 拆解为 3 部分:
 *
 *     spread = adverse_selection + order_processing + inventory_holding
 *
 *   其中 **adverse selection** 部分是做市商防"知情交易者"的保护费:
 *
 *     adverse_selection = P(informed) · |E[V | informed buy] - E[V | uninformed]|
 *
 *   GMM-based 拆分: Roll (1984) 简化版 / Madhavan-Smidt (1991) decomposition
 *
 * **本实现**:
 *   - Kyle's lambda 用 OLS 估计 (从 (Q_t, ΔP_t) sample 序列)
 *   - Roll's spread estimator (1984): cov(ΔP_t, ΔP_{t-1}) → effective spread
 *   - Madhavan-Richardson-Roomans (MRR 1997) decomposition: spread = adverse + transitory
 *
 * **A 股应用**:
 *   - 用日级 bar 估 Kyle's lambda: Q_t ≈ sign(close - prev_close) × volume
 *   - 估 Roll's spread 作为 ExecutionFeasibility 的 spread_pct 替代 (high-low)/close proxy
 *   - 配合 Almgren-Chriss 提供"理论 γ + 实证 λ"两个 lens
 */

/**
 * 普通 OLS regression: y = β·x + α + ε
 *
 * 返回 slope β, intercept α, R²
 *
 * 用于 Kyle's lambda 估计.
 */
export function olsRegression(
  x: number[],
  y: number[]
): {
  slope: number;
  intercept: number;
  r_squared: number;
  n_samples: number;
} {
  if (x.length !== y.length) throw new Error('olsRegression: x and y length mismatch');
  const N = x.filter((v, i) => Number.isFinite(v) && Number.isFinite(y[i])).length;
  if (N < 2) return { slope: NaN, intercept: NaN, r_squared: NaN, n_samples: N };

  // filter to valid pairs
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < x.length; i += 1) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) {
      xs.push(x[i]);
      ys.push(y[i]);
    }
  }
  const meanX = xs.reduce((s, v) => s + v, 0) / xs.length;
  const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    denX += (xs[i] - meanX) ** 2;
    denY += (ys[i] - meanY) ** 2;
  }
  if (denX < 1e-12) return { slope: 0, intercept: meanY, r_squared: 0, n_samples: xs.length };
  const slope = num / denX;
  const intercept = meanY - slope * meanX;
  const r2 = denY > 0 ? (num * num) / (denX * denY) : 0;
  return { slope, intercept, r_squared: r2, n_samples: xs.length };
}

/**
 * Kyle's Lambda estimation (Kyle 1985)
 *
 * λ̂ = Cov(ΔP, Q) / Var(Q) — 这就是 OLS slope of ΔP ~ Q
 *
 * 输入:
 *   prices: 价格序列 (T)
 *   volumes: 成交量序列 (T)
 *
 * 计算:
 *   ΔP_t = P_t - P_{t-1}
 *   Q_t = sign(ΔP_t) × V_t   (tick rule order flow imbalance)
 *
 * λ 越大 → 流动性越差
 *
 * @returns lambda + R² 拟合度 + n_samples
 */
export function kylesLambda(
  prices: number[],
  volumes: number[]
): {
  lambda: number;
  r_squared: number;
  n_samples: number;
  /** Average price */
  avg_price: number;
  /** Lambda normalized to per-million-shares impact (for comparison across stocks) */
  lambda_per_million: number;
} {
  if (prices.length !== volumes.length) throw new Error('kylesLambda: length mismatch');
  if (prices.length < 3) {
    return { lambda: NaN, r_squared: NaN, n_samples: 0, avg_price: NaN, lambda_per_million: NaN };
  }

  const deltaP: number[] = [];
  const Q: number[] = [];
  for (let t = 1; t < prices.length; t += 1) {
    const dp = prices[t] - prices[t - 1];
    if (!Number.isFinite(dp)) continue;
    const sign = Math.sign(dp);
    deltaP.push(dp);
    Q.push(sign * volumes[t]);
  }

  const reg = olsRegression(Q, deltaP);
  const avgP = prices.reduce((s, v) => s + v, 0) / prices.length;
  // normalize: lambda × 1M shares = price impact for 1M-share order
  const lambdaPerM = reg.slope * 1_000_000;

  return {
    lambda: reg.slope,
    r_squared: reg.r_squared,
    n_samples: reg.n_samples,
    avg_price: avgP,
    lambda_per_million: lambdaPerM,
  };
}

/**
 * Roll's Effective Spread Estimator (Roll 1984)
 *
 * 论文: Roll, R. (1984). "A simple implicit measure of the effective bid-ask spread
 *       in an efficient market." Journal of Finance 39(4), 1127-1139.
 *
 * **算法**:
 *   假设 transaction prices 在 bid/ask 之间随机跳跃 (因 buy / sell trades 交替):
 *
 *     spread_effective = 2 · √(-Cov(ΔP_t, ΔP_{t-1}))
 *
 *   如果 Cov > 0 (序列正相关，trend) → 无法估，返回 NaN
 *
 * **A 股应用**: 用日级 close 序列估，但效果不如 tick-level data.
 *   日级 spread estimator 在 A 股 trend 期 (Cov 大概率正) 经常 NaN.
 *
 * @returns effective spread (in price units) + Roll's covariance
 */
export function rollsEffectiveSpread(prices: number[]): {
  effective_spread: number;
  serial_covariance: number;
  is_estimable: boolean;
  n_samples: number;
} {
  if (prices.length < 3) {
    return { effective_spread: NaN, serial_covariance: NaN, is_estimable: false, n_samples: 0 };
  }
  const deltaP: number[] = [];
  for (let t = 1; t < prices.length; t += 1) {
    const dp = prices[t] - prices[t - 1];
    if (Number.isFinite(dp)) deltaP.push(dp);
  }
  if (deltaP.length < 2) {
    return {
      effective_spread: NaN,
      serial_covariance: NaN,
      is_estimable: false,
      n_samples: deltaP.length,
    };
  }
  // Cov(ΔP_t, ΔP_{t-1})
  const x = deltaP.slice(0, -1);
  const y = deltaP.slice(1);
  const meanX = x.reduce((s, v) => s + v, 0) / x.length;
  const meanY = y.reduce((s, v) => s + v, 0) / y.length;
  let cov = 0;
  for (let i = 0; i < x.length; i += 1) cov += (x[i] - meanX) * (y[i] - meanY);
  cov /= x.length - 1;

  if (cov >= 0) {
    // trend 期 cov > 0, Roll's estimator 不适用
    return {
      effective_spread: NaN,
      serial_covariance: cov,
      is_estimable: false,
      n_samples: x.length,
    };
  }
  const spread = 2 * Math.sqrt(-cov);
  return {
    effective_spread: spread,
    serial_covariance: cov,
    is_estimable: true,
    n_samples: x.length,
  };
}

/**
 * MRR (Madhavan-Richardson-Roomans 1997) Spread Decomposition
 *
 * 论文 reference:
 *   Madhavan, A., Richardson, M., and Roomans, M. (1997).
 *   "Why do security prices change? A transaction-level analysis of NYSE stocks."
 *   Review of Financial Studies 10(4), 1035-1064.
 *
 * **模型**:
 *
 *   ΔP_t = α + (φ + θ) · q_t - (φ + ρθ) · q_{t-1} + ε_t
 *
 *   其中:
 *     q_t ∈ {+1, -1} = trade direction (tick rule sign)
 *     φ = order processing component (transitory)
 *     θ = adverse selection component (permanent — informed trading)
 *     ρ = autocorrelation of order flow
 *
 *   通过 OLS 估出 (φ + θ) 和 (φ + ρθ), 联立求 φ, θ.
 *
 *   - **Total spread = 2(φ + θ)**
 *   - **Adverse selection share = θ / (φ + θ)**
 *   - **Transitory share = φ / (φ + θ)**
 *
 * **A 股应用**:
 *   - 高 θ/(φ+θ) → 信息不对称严重 (e.g. 新股、龙虎榜出现日)
 *   - 低 θ/(φ+θ) → 流动性 dominated by inventory/processing (蓝筹)
 *
 * **简化实现**:
 *   原模型需 2 个回归方程联立。这里用 1 步简化: 假设 ρ ≈ 0.5,
 *   直接给出 adverse_selection / transitory 估计。
 *
 * @param prices price series
 * @param signs trade direction series (length == prices.length, e.g. tick rule)
 */
export function mrrDecomposition(
  prices: number[],
  signs: number[]
): {
  total_spread: number;
  adverse_selection_share: number;
  transitory_share: number;
  is_estimable: boolean;
  n_samples: number;
} {
  if (prices.length !== signs.length) throw new Error('mrrDecomposition: length mismatch');
  if (prices.length < 4) {
    return {
      total_spread: NaN,
      adverse_selection_share: NaN,
      transitory_share: NaN,
      is_estimable: false,
      n_samples: 0,
    };
  }

  // ΔP_t regressed on q_t and q_{t-1}
  // y = α + a · q_t + b · q_{t-1} + ε, 其中 a = φ+θ, b = -(φ + ρθ)
  const y: number[] = [];
  const qt: number[] = [];
  const qtm1: number[] = [];
  for (let t = 2; t < prices.length; t += 1) {
    const dp = prices[t] - prices[t - 1];
    if (!Number.isFinite(dp)) continue;
    y.push(dp);
    qt.push(signs[t]);
    qtm1.push(signs[t - 1]);
  }
  if (y.length < 3) {
    return {
      total_spread: NaN,
      adverse_selection_share: NaN,
      transitory_share: NaN,
      is_estimable: false,
      n_samples: y.length,
    };
  }

  // 简化: 2 个独立 OLS (实际应 multi-variable regression)
  // a ≈ Cov(y, qt) / Var(qt)
  // b ≈ Cov(y, qtm1) / Var(qtm1)
  const regA = olsRegression(qt, y);
  const regB = olsRegression(qtm1, y);
  const a = regA.slope;
  const b = -regB.slope; // sign flip

  // a = φ + θ, b = φ + ρ·θ
  // 假设 ρ = 0.5:
  //   φ + θ = a
  //   φ + 0.5θ = b
  // → θ = 2(a - b), φ = a - θ = 2b - a
  const theta = 2 * (a - b);
  const phi = 2 * b - a;
  const totalSpread = 2 * (phi + theta);
  const sumPosTheta = Math.abs(theta) + Math.abs(phi);
  if (sumPosTheta <= 0 || !Number.isFinite(totalSpread)) {
    return {
      total_spread: NaN,
      adverse_selection_share: NaN,
      transitory_share: NaN,
      is_estimable: false,
      n_samples: y.length,
    };
  }
  return {
    total_spread: totalSpread,
    adverse_selection_share: Math.abs(theta) / sumPosTheta,
    transitory_share: Math.abs(phi) / sumPosTheta,
    is_estimable: true,
    n_samples: y.length,
  };
}

/**
 * Daily Order Flow Imbalance (Q_t) helper
 *
 * 简化版 — tick rule on daily close:
 *
 *   q_t = sign(close_t - close_{t-1})
 *   Q_t = q_t × volume_t  (signed dollar volume)
 *
 * @param bars sorted bars with close + volume
 * @returns order flow per bar (length = N, first = 0 for t=0)
 */
export function dailyOrderFlowImbalance(bars: Array<{ close: number; volume: number }>): number[] {
  const out: number[] = [0];
  for (let t = 1; t < bars.length; t += 1) {
    const sign = Math.sign(bars[t].close - bars[t - 1].close);
    out.push(sign * bars[t].volume);
  }
  return out;
}
