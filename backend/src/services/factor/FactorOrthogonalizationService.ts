/**
 * Sprint 41-D: FactorOrthogonalizationService — 因子正交化 + 拥挤度控制
 *
 * 解决多因子系统的 2 个常见病:
 *
 *   1. **看似 12 个因子, 实际都在表达同一个东西**
 *      → correlationMatrix + clusterRedundantFactors 揪出冗余
 *      → residualize 把因子对市值/行业/beta 做回归取残差, 得"纯净 alpha"
 *
 *   2. **某方向交易过热, 因子失效**
 *      → computeCrowdingScore 综合 IC 衰减 + 多空 spread 收窄 + 同向资金过密
 *      → downweightCrowded 给 crowded 因子降权
 *
 * 所有纯函数全 export, 0 DB 依赖. caller (FactorPipeline / FactorICReport)
 * 把 factor_scores 横截面或 IC 时序数据传进来即可.
 *
 * 设计要点:
 *   1. **纯数学, 不引外部包**: Pearson 相关 / OLS 多元回归 / hierarchical clustering
 *      自实现 (≈200 行 JS).
 *   2. **DataSource DI**: 若需要从 DB 读 industry / market_cap 给 residualize 用,
 *      走 DataSource 接口, 测试可注入 fake.
 *   3. **Crowding 信号**: 不依赖任何外部数据 (融资余额 / 北向流向 等),
 *      只用因子自身的 IC 趋势 + 多空组合 spread 作内部信号, 让本服务完全独立可用.
 */

import { logger } from '../../utils/logger';

// ===========================================================================
// 基础统计 (与 ResearchValidationService 同款独立 export, 避免跨包依赖)
// ===========================================================================

export function vecMean(arr: number[]): number {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

export function vecStddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = vecMean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

// ===========================================================================
// 1. Pearson Correlation Matrix
// ===========================================================================

/**
 * Pearson 相关系数 (两个等长数组).
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0;
  const mx = vecMean(x);
  const my = vecMean(y);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return 0;
  return num / denom;
}

/**
 * N×N 相关矩阵.
 * @param factorScores Map<factor_name, Map<stock_code, z_score>>
 * @returns Matrix object: { factor_names, matrix }
 */
export interface CorrelationMatrix {
  factor_names: string[];
  /** matrix[i][j] = correlation(factor_names[i], factor_names[j]) */
  matrix: number[][];
}

export function correlationMatrix(
  factorScores: Map<string, Map<string, number>>
): CorrelationMatrix {
  const factor_names = Array.from(factorScores.keys()).sort();
  const N = factor_names.length;
  // 找 universe 共同 stock (intersection)
  const universes = factor_names.map(f => new Set(factorScores.get(f)!.keys()));
  let common: Set<string> = universes[0] || new Set();
  for (let i = 1; i < N; i++) {
    common = new Set([...common].filter(s => universes[i].has(s)));
  }
  const stocks = Array.from(common);
  // 构造 N × |stocks| 矩阵
  const data: number[][] = factor_names.map(f => {
    const fmap = factorScores.get(f)!;
    return stocks.map(s => Number(fmap.get(s) || 0));
  });
  // 计算 N×N
  const matrix: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < N; j++) {
      const c = pearsonCorrelation(data[i], data[j]);
      matrix[i][j] = c;
      matrix[j][i] = c;
    }
  }
  return { factor_names, matrix };
}

// ===========================================================================
// 2. Hierarchical Clustering (基于 1 - |correlation| 距离)
// ===========================================================================

export interface FactorCluster {
  cluster_id: number;
  members: string[];
  /** average pairwise correlation 该 cluster 内 */
  avg_intra_corr: number;
}

/**
 * Single-linkage hierarchical clustering, threshold = 1 - |corr_threshold|.
 *
 * 算法: 把每个 factor 作为单点 cluster, 不断合并距离最近 (|corr| 最高) 的两个
 * cluster, 直到所有 pairs 的距离 > (1 - corr_threshold).
 *
 * @param corrMatrix N×N Pearson 相关矩阵
 * @param factor_names 与 corrMatrix 行/列一致的因子名
 * @param corr_threshold |相关性| >= 此值视为冗余 (默认 0.7)
 */
export function clusterRedundantFactors(
  corrMatrix: number[][],
  factor_names: string[],
  corr_threshold = 0.7
): FactorCluster[] {
  const N = factor_names.length;
  if (N === 0) return [];
  // 每个 factor 一个 cluster, id = index
  const parent: number[] = Array.from({ length: N }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  // 收集所有满足阈值的 pair 并 union
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (Math.abs(corrMatrix[i][j]) >= corr_threshold) {
        union(i, j);
      }
    }
  }
  // 按 root 聚合
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    const r = find(i);
    const arr = buckets.get(r) || [];
    arr.push(i);
    buckets.set(r, arr);
  }
  // 输出
  const out: FactorCluster[] = [];
  let cluster_id = 0;
  for (const indices of buckets.values()) {
    // intra-cluster avg corr
    let sum = 0;
    let count = 0;
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        sum += Math.abs(corrMatrix[indices[i]][indices[j]]);
        count++;
      }
    }
    out.push({
      cluster_id: cluster_id++,
      members: indices.map(idx => factor_names[idx]),
      avg_intra_corr: count > 0 ? sum / count : 1,
    });
  }
  // 按 size desc 排
  out.sort((a, b) => b.members.length - a.members.length);
  return out;
}

// ===========================================================================
// 3. Residualization (OLS 多元回归取残差)
// ===========================================================================

/**
 * 多元线性回归 OLS solution: β = (X'X)^-1 X'y
 *
 * 用 normal equation + Gauss-Jordan 求逆 (k ≤ 10 时足够稳定).
 * @param X N×k 矩阵 (N 个样本, k 个特征)
 * @param y N 长度 target
 * @returns { coefficients: number[] (length k), intercept: number, residuals: number[] }
 */
export interface OLSResult {
  coefficients: number[];
  intercept: number;
  residuals: number[];
  r_squared: number;
}

export function ordinaryLeastSquares(X: number[][], y: number[]): OLSResult {
  const N = X.length;
  if (N === 0 || X[0].length === 0) {
    return { coefficients: [], intercept: 0, residuals: [], r_squared: 0 };
  }
  const k = X[0].length;
  // 加 intercept 列 (前置 1.0)
  const Xi: number[][] = X.map(row => [1, ...row]);
  const kI = k + 1;
  // X' X (kI × kI)
  const XtX: number[][] = Array.from({ length: kI }, () => new Array(kI).fill(0));
  for (let i = 0; i < kI; i++) {
    for (let j = 0; j < kI; j++) {
      let s = 0;
      for (let n = 0; n < N; n++) s += Xi[n][i] * Xi[n][j];
      XtX[i][j] = s;
    }
  }
  // X' y (kI)
  const Xty: number[] = new Array(kI).fill(0);
  for (let i = 0; i < kI; i++) {
    let s = 0;
    for (let n = 0; n < N; n++) s += Xi[n][i] * y[n];
    Xty[i] = s;
  }
  // 求逆: 用 Gauss-Jordan 解 X'X β = X'y
  const augmented: number[][] = XtX.map((row, i) => [...row, Xty[i]]);
  // Forward elimination
  for (let i = 0; i < kI; i++) {
    // pivot
    let pivot = augmented[i][i];
    if (Math.abs(pivot) < 1e-12) {
      // 找下一行 swap
      let swapped = false;
      for (let r = i + 1; r < kI; r++) {
        if (Math.abs(augmented[r][i]) > 1e-12) {
          [augmented[i], augmented[r]] = [augmented[r], augmented[i]];
          pivot = augmented[i][i];
          swapped = true;
          break;
        }
      }
      if (!swapped) {
        // singular, fallback to zero coefficients
        return {
          coefficients: new Array(k).fill(0),
          intercept: vecMean(y),
          residuals: y.map(v => v - vecMean(y)),
          r_squared: 0,
        };
      }
    }
    for (let j = i; j <= kI; j++) augmented[i][j] /= pivot;
    for (let r = 0; r < kI; r++) {
      if (r === i) continue;
      const factor = augmented[r][i];
      for (let j = i; j <= kI; j++) augmented[r][j] -= factor * augmented[i][j];
    }
  }
  const beta: number[] = augmented.map(row => row[kI]);
  const intercept = beta[0];
  const coefficients = beta.slice(1);
  // 残差 + R²
  const yMean = vecMean(y);
  let ss_res = 0;
  let ss_tot = 0;
  const residuals: number[] = [];
  for (let n = 0; n < N; n++) {
    let pred = intercept;
    for (let j = 0; j < k; j++) pred += coefficients[j] * X[n][j];
    const r = y[n] - pred;
    residuals.push(r);
    ss_res += r * r;
    ss_tot += (y[n] - yMean) ** 2;
  }
  const r_squared = ss_tot > 0 ? 1 - ss_res / ss_tot : 0;
  return { coefficients, intercept, residuals, r_squared };
}

/**
 * 因子残差化 — 给定原始因子 Y 和暴露变量矩阵 X (市值, 行业 dummy, beta 等),
 * 拟合 Y ~ X 取残差作为"纯净 alpha".
 *
 * @param factorValues Map<stock_code, raw_factor_score>
 * @param exposureMatrix Map<stock_code, number[]> (每只 stock 的 k 个暴露)
 * @returns Map<stock_code, residual_score>
 */
export function residualizeFactor(
  factorValues: Map<string, number>,
  exposureMatrix: Map<string, number[]>
): Map<string, number> {
  const out = new Map<string, number>();
  const common = [...factorValues.keys()].filter(s => exposureMatrix.has(s));
  if (common.length < 5) {
    // 样本不足, 直接 passthrough
    for (const s of common) out.set(s, factorValues.get(s)!);
    return out;
  }
  const y = common.map(s => factorValues.get(s)!);
  const X = common.map(s => exposureMatrix.get(s)!);
  const ols = ordinaryLeastSquares(X, y);
  for (let i = 0; i < common.length; i++) {
    out.set(common[i], ols.residuals[i]);
  }
  return out;
}

// ===========================================================================
// 4. Crowding Score
// ===========================================================================

export interface CrowdingInput {
  /** 因子近期 IC 时序 (按时间升序), 例如最近 60 日的 daily IC */
  recent_ic_series: number[];
  /** 因子前期 IC 时序 (基准期), 例如 60-180 日前的 daily IC */
  baseline_ic_series: number[];
  /** 多空组合 (top10% - bottom10%) 当前 spread % */
  current_long_short_spread?: number;
  /** 多空组合基准期 spread (avg) */
  baseline_long_short_spread?: number;
}

export interface CrowdingResult {
  /** 0 = 不拥挤, 1 = 严重拥挤 */
  crowding_score: number;
  /** IC 衰减幅度 (近期 mean / 基准 mean - 1) */
  ic_decay_pct: number;
  /** 多空 spread 收窄幅度 */
  spread_compression_pct: number;
  /** 建议的 downweight 系数 (1 = 不动, 0 = 完全降权) */
  recommended_weight_multiplier: number;
  warning: 'ok' | 'caution' | 'crowded';
  reason: string;
}

/**
 * 因子拥挤度评分.
 *
 * 综合 2 个信号 (任一 > 0 都加权到 crowding):
 *   1. **IC 衰减**: 近期 IC mean / 基准 IC mean - 1 < 0 (变弱)
 *   2. **多空 spread 收窄**: current_spread / baseline_spread - 1 < 0 (赚不到了)
 *
 * crowding_score = 0.6 × ic_decay_factor + 0.4 × spread_compression_factor
 *   (各因子 clip 到 [0, 1])
 *
 * recommended_weight_multiplier = max(0.2, 1 - 0.8 × crowding_score)
 *   (即 crowding=0 → 1.0, crowding=1 → 0.2 — 最多降到 20%)
 */
export function computeCrowdingScore(input: CrowdingInput): CrowdingResult {
  const recent_ic_mean = vecMean(input.recent_ic_series.filter(v => Number.isFinite(v)));
  const baseline_ic_mean = vecMean(input.baseline_ic_series.filter(v => Number.isFinite(v)));

  // IC 衰减: 0 = 无衰减, 1 = IC 归零 / 反向
  let ic_decay_factor = 0;
  let ic_decay_pct = 0;
  if (Math.abs(baseline_ic_mean) >= 0.001) {
    ic_decay_pct = recent_ic_mean / baseline_ic_mean - 1;
    if (ic_decay_pct < 0) {
      // 衰减程度 (-100% = 完全失效)
      ic_decay_factor = Math.min(1, Math.abs(ic_decay_pct));
    }
  }

  // Spread 收窄: 0 = 无收窄, 1 = spread 完全消失
  let spread_compression_factor = 0;
  let spread_compression_pct = 0;
  if (
    input.current_long_short_spread !== undefined &&
    input.baseline_long_short_spread !== undefined &&
    Math.abs(input.baseline_long_short_spread) > 0.001
  ) {
    spread_compression_pct = input.current_long_short_spread / input.baseline_long_short_spread - 1;
    if (spread_compression_pct < 0) {
      spread_compression_factor = Math.min(1, Math.abs(spread_compression_pct));
    }
  }

  const crowding_score = Math.max(
    0,
    Math.min(1, 0.6 * ic_decay_factor + 0.4 * spread_compression_factor)
  );
  const recommended_weight_multiplier = Math.max(0.2, 1 - 0.8 * crowding_score);
  const warning: CrowdingResult['warning'] =
    crowding_score > 0.6 ? 'crowded' : crowding_score > 0.3 ? 'caution' : 'ok';

  return {
    crowding_score,
    ic_decay_pct,
    spread_compression_pct,
    recommended_weight_multiplier,
    warning,
    reason: `crowding=${(crowding_score * 100).toFixed(0)}% (IC decay ${(
      ic_decay_pct * 100
    ).toFixed(0)}%, spread compression ${(spread_compression_pct * 100).toFixed(
      0
    )}%) → weight×${recommended_weight_multiplier.toFixed(2)} [${warning}]`,
  };
}

/**
 * 给一组因子权重应用 crowding downweight.
 *
 * @param weights Map<factor_name, original_weight>
 * @param crowdingByFactor Map<factor_name, CrowdingResult>
 * @returns Map<factor_name, adjusted_weight> (sum 重新归一化到 1)
 */
export function downweightCrowded(
  weights: Map<string, number>,
  crowdingByFactor: Map<string, CrowdingResult>
): Map<string, number> {
  const out = new Map<string, number>();
  let totalWeight = 0;
  for (const [name, w] of weights) {
    const c = crowdingByFactor.get(name);
    const mult = c ? c.recommended_weight_multiplier : 1;
    const adjusted = w * mult;
    out.set(name, adjusted);
    totalWeight += adjusted;
  }
  // 归一化
  if (totalWeight > 0) {
    for (const [name, w] of out) {
      out.set(name, w / totalWeight);
    }
  } else {
    // 全 0 → 退回原权重 (避免全空)
    logger.warn('downweightCrowded: 全因子降权到 0, 退回原权重');
    return new Map(weights);
  }
  return out;
}
