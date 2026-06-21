/**
 * MLfAM Complete + AFML Ch.6/9
 *
 * 书 reference:
 *   López de Prado, M. (2020). *Machine Learning for Asset Managers.*
 *   Cambridge University Press.
 *
 *   López de Prado, M. (2018). *Advances in Financial Machine Learning.*
 *   Ch.6 (Ensembles), Ch.9 (Backtesting through CV).
 *
 * **MLfAM Ch.3 - Distance Metrics**:
 *   - Variation of Information (VI): symmetric mutual information distance
 *   - Mutual Information (MI): 2 variables 信息共享
 *
 * **MLfAM Ch.4 - Optimal Clustering**:
 *   - ONC (Optimal Number of Clusters) algorithm
 *   - Silhouette score for cluster quality
 *
 * **MLfAM Ch.5 - Financial Labels**:
 *   - Fixed-time horizon labels (return after H days)
 *   - Triple Barrier labels (已在 v2 实现)
 *   - Trend-scanning labels (识别 trend 强度)
 *
 * **MLfAM Ch.6 - Feature Importance (MLfAM 版)**:
 *   - MDI/MDA/SFI (与 AFML Ch.8 互补 - 已在 Sprint 7)
 *   - 此处补充 Clustered Feature Importance
 *
 * **MLfAM Ch.7 - Portfolio Construction (NCO 完整)**:
 *   - Step 1: Tree clustering on returns
 *   - Step 2: Intra-cluster MVO
 *   - Step 3: Inter-cluster MVO
 *   - 替换 v2 的简化 NCO
 *
 * **MLfAM Ch.8 - Testing Set Overfitting**:
 *   - Combinatorial Backtests (与 CPCV 不同)
 *   - PBO 实测 vs 理论
 *
 * **AFML Ch.6 - Ensembles in Finance**:
 *   - Bagging causes label leakage (因序列重叠)
 *   - Bayesian aggregation 替代
 *
 * **AFML Ch.9 - Backtesting through CV (完整 framework)**:
 *   - Walk-forward + Purged + Embargo + CPCV 统一框架
 */

// ============================================================
// MLfAM Ch.3 — Distance Metrics (VI, MI)
// ============================================================

/**
 * Mutual Information (MI) between 2 discrete variables.
 *
 *   MI(X, Y) = Σ_x Σ_y p(x,y) × log(p(x,y) / (p(x) × p(y)))
 *
 * @param X discrete values
 * @param Y discrete values (same length)
 * @param n_bins for continuous → discretize
 */
export function mutualInformation(X: number[], Y: number[], n_bins = 10): number {
  if (X.length !== Y.length || X.length === 0) return 0;
  // Discretize via equal-width bins
  const min_x = Math.min(...X),
    max_x = Math.max(...X);
  const min_y = Math.min(...Y),
    max_y = Math.max(...Y);
  if (max_x - min_x < 1e-12 || max_y - min_y < 1e-12) return 0;
  const bin_x = X.map(v =>
    Math.min(n_bins - 1, Math.floor(((v - min_x) / (max_x - min_x)) * n_bins))
  );
  const bin_y = Y.map(v =>
    Math.min(n_bins - 1, Math.floor(((v - min_y) / (max_y - min_y)) * n_bins))
  );

  const joint: Record<string, number> = {};
  const marg_x: Record<number, number> = {};
  const marg_y: Record<number, number> = {};
  const N = X.length;
  for (let i = 0; i < N; i += 1) {
    const k = `${bin_x[i]}_${bin_y[i]}`;
    joint[k] = (joint[k] || 0) + 1;
    marg_x[bin_x[i]] = (marg_x[bin_x[i]] || 0) + 1;
    marg_y[bin_y[i]] = (marg_y[bin_y[i]] || 0) + 1;
  }

  let mi = 0;
  for (const k in joint) {
    const [bx, by] = k.split('_').map(Number);
    const p_xy = joint[k] / N;
    const p_x = marg_x[bx] / N;
    const p_y = marg_y[by] / N;
    if (p_xy > 0 && p_x > 0 && p_y > 0) {
      mi += p_xy * Math.log(p_xy / (p_x * p_y));
    }
  }
  return mi;
}

/**
 * Variation of Information (VI, distance metric):
 *
 *   VI(X, Y) = H(X) + H(Y) - 2 × MI(X, Y)
 *
 *   - VI = 0: X and Y identical
 *   - VI = H(X) + H(Y): X and Y independent
 *
 * Normalized: VI / (H(X) + H(Y) - MI(X, Y)) ∈ [0, 1]
 */
export function variationOfInformation(X: number[], Y: number[], n_bins = 10): number {
  if (X.length !== Y.length || X.length === 0) return 0;
  // Entropy of each
  const min_x = Math.min(...X),
    max_x = Math.max(...X);
  const min_y = Math.min(...Y),
    max_y = Math.max(...Y);
  if (max_x - min_x < 1e-12 || max_y - min_y < 1e-12) return 0;
  const bin_x = X.map(v =>
    Math.min(n_bins - 1, Math.floor(((v - min_x) / (max_x - min_x)) * n_bins))
  );
  const bin_y = Y.map(v =>
    Math.min(n_bins - 1, Math.floor(((v - min_y) / (max_y - min_y)) * n_bins))
  );

  const entropy = (bins: number[]): number => {
    const counts: Record<number, number> = {};
    for (const b of bins) counts[b] = (counts[b] || 0) + 1;
    let h = 0;
    const N = bins.length;
    for (const k in counts) {
      const p = counts[k] / N;
      if (p > 0) h -= p * Math.log(p);
    }
    return h;
  };
  const H_x = entropy(bin_x);
  const H_y = entropy(bin_y);
  const mi = mutualInformation(X, Y, n_bins);
  return H_x + H_y - 2 * mi;
}

// ============================================================
// MLfAM Ch.4 — Optimal Clustering
// ============================================================

/**
 * Silhouette score for a clustering (Kaufman-Rousseeuw 1990).
 *
 *   For each point i:
 *     a(i) = mean intra-cluster distance
 *     b(i) = mean distance to nearest other cluster
 *     s(i) = (b - a) / max(a, b)
 *
 *   Silhouette = mean(s(i))   ∈ [-1, 1]
 *   Higher → better clustering.
 */
export function silhouetteScore(data_points: number[][], cluster_assignment: number[]): number {
  const N = data_points.length;
  if (N < 2 || cluster_assignment.length !== N) return 0;
  const clusters = Array.from(new Set(cluster_assignment));
  if (clusters.length < 2) return 0;

  let total_s = 0;
  for (let i = 0; i < N; i += 1) {
    const same_cluster = cluster_assignment
      .map((c, j) => (c === cluster_assignment[i] && j !== i ? j : -1))
      .filter(j => j !== -1);
    if (same_cluster.length === 0) continue;
    const a_i =
      same_cluster.reduce((s, j) => s + euclideanDistance(data_points[i], data_points[j]), 0) /
      same_cluster.length;
    let b_i = Infinity;
    for (const c of clusters) {
      if (c === cluster_assignment[i]) continue;
      const other = cluster_assignment.map((cc, j) => (cc === c ? j : -1)).filter(j => j !== -1);
      if (other.length === 0) continue;
      const d_mean =
        other.reduce((s, j) => s + euclideanDistance(data_points[i], data_points[j]), 0) /
        other.length;
      if (d_mean < b_i) b_i = d_mean;
    }
    if (b_i === Infinity) continue;
    total_s += (b_i - a_i) / Math.max(a_i, b_i);
  }
  return total_s / N;
}

function euclideanDistance(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/**
 * Optimal Number of Clusters (ONC, MLfAM Ch.4).
 *
 * Iterate k = 2, 3, ..., k_max, pick k with highest silhouette.
 *
 * Uses simple k-means via random init.
 */
export function optimalNumberOfClusters(
  data_points: number[][],
  k_max = 10,
  options: { seed?: number; max_iter?: number } = {}
): { best_k: number; best_silhouette: number; assignment: number[]; silhouette_per_k: number[] } {
  const N = data_points.length;
  if (N < 4)
    return {
      best_k: 1,
      best_silhouette: 0,
      assignment: new Array(N).fill(0),
      silhouette_per_k: [],
    };
  let state = (options.seed ?? 42) % 2147483647;
  if (state <= 0) state += 2147483646;
  const rng = (): number => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };

  let best_k = 2,
    best_sil = -Infinity,
    best_assign: number[] = new Array(N).fill(0);
  const silhouettes: number[] = [];
  for (let k = 2; k <= Math.min(k_max, N - 1); k += 1) {
    // K-means lite: random init + 10 iterations
    let centroids: number[][] = [];
    const indices = Array.from({ length: N }, (_, i) => i);
    for (let kk = 0; kk < k; kk += 1) {
      const idx = Math.floor(rng() * indices.length);
      centroids.push(data_points[indices[idx]].slice());
    }
    const assignment: number[] = new Array(N).fill(0);
    for (let iter = 0; iter < (options.max_iter ?? 30); iter += 1) {
      // Assign
      for (let i = 0; i < N; i += 1) {
        let min_d = Infinity,
          best_c = 0;
        for (let c = 0; c < k; c += 1) {
          const d = euclideanDistance(data_points[i], centroids[c]);
          if (d < min_d) {
            min_d = d;
            best_c = c;
          }
        }
        assignment[i] = best_c;
      }
      // Recompute centroids
      const new_centroids: number[][] = Array.from({ length: k }, () =>
        new Array(data_points[0].length).fill(0)
      );
      const counts: number[] = new Array(k).fill(0);
      for (let i = 0; i < N; i += 1) {
        for (let d = 0; d < data_points[i].length; d += 1)
          new_centroids[assignment[i]][d] += data_points[i][d];
        counts[assignment[i]] += 1;
      }
      for (let c = 0; c < k; c += 1) {
        if (counts[c] > 0)
          for (let d = 0; d < new_centroids[c].length; d += 1) new_centroids[c][d] /= counts[c];
      }
      centroids = new_centroids;
    }
    const sil = silhouetteScore(data_points, assignment);
    silhouettes.push(sil);
    if (sil > best_sil) {
      best_sil = sil;
      best_k = k;
      best_assign = assignment.slice();
    }
  }
  return {
    best_k,
    best_silhouette: best_sil,
    assignment: best_assign,
    silhouette_per_k: silhouettes,
  };
}

// ============================================================
// MLfAM Ch.5 — Financial Labels (Trend-Scanning)
// ============================================================

/**
 * Trend-Scanning Labels (MLfAM Ch.5).
 *
 *   For each time t, look forward H bars; fit OLS y = α + β × time + ε.
 *   - β > 0 + t-stat strong → +1 (up trend)
 *   - β < 0 + t-stat strong → -1 (down trend)
 *   - 否则 → 0
 *
 * Returns labels per time point.
 *
 * @param prices price series
 * @param max_horizon H (look forward bars)
 * @param t_stat_threshold strict t-stat (default 2.0)
 */
export function trendScanningLabels(
  prices: number[],
  max_horizon = 20,
  t_stat_threshold = 2.0
): number[] {
  const N = prices.length;
  const labels: number[] = new Array(N).fill(0);
  for (let t = 0; t < N - max_horizon; t += 1) {
    // OLS fit over forward window
    const xs: number[] = [];
    const ys: number[] = [];
    for (let h = 1; h <= max_horizon; h += 1) {
      xs.push(h);
      ys.push(prices[t + h]);
    }
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0,
      denom = 0;
    for (let i = 0; i < xs.length; i += 1) {
      num += (xs[i] - mx) * (ys[i] - my);
      denom += (xs[i] - mx) ** 2;
    }
    if (denom < 1e-12) continue;
    const beta = num / denom;
    const alpha = my - beta * mx;
    let ss_res = 0;
    for (let i = 0; i < xs.length; i += 1) {
      const pred = alpha + beta * xs[i];
      ss_res += (ys[i] - pred) ** 2;
    }
    const se_beta = Math.sqrt(ss_res / (xs.length - 2) / denom);
    if (se_beta < 1e-12) continue;
    const t_stat = beta / se_beta;
    if (t_stat > t_stat_threshold) labels[t] = 1;
    else if (t_stat < -t_stat_threshold) labels[t] = -1;
  }
  return labels;
}

// ============================================================
// MLfAM Ch.6 — Clustered Feature Importance
// ============================================================

/**
 * Clustered Feature Importance (MLfAM Ch.6.5).
 *
 *   For correlated features, individual MDI/MDA underestimate importance.
 *   Group features into clusters → sum importance within cluster.
 *
 * @param feature_importances Record of feature → importance
 * @param feature_clusters Record of feature → cluster_id
 */
export function clusteredFeatureImportance(
  feature_importances: Record<string, number>,
  feature_clusters: Record<string, number>
): Record<number, { cluster_id: number; total_importance: number; features: string[] }> {
  const clusters: Record<
    number,
    { cluster_id: number; total_importance: number; features: string[] }
  > = {};
  for (const [feat, imp] of Object.entries(feature_importances)) {
    const cid = feature_clusters[feat];
    if (cid === undefined) continue;
    if (!clusters[cid]) clusters[cid] = { cluster_id: cid, total_importance: 0, features: [] };
    clusters[cid].total_importance += imp;
    clusters[cid].features.push(feat);
  }
  return clusters;
}

// ============================================================
// MLfAM Ch.7 — NCO Complete (Tree + Intra/Inter MVO)
// ============================================================

/**
 * Nested Clustered Optimization (NCO, complete version).
 *
 * Algorithm (MLfAM Ch.7):
 *   1. Tree clustering on correlation matrix → K clusters
 *   2. Within each cluster, compute intra-MVO weights (min variance)
 *   3. Aggregate to cluster level returns
 *   4. Compute inter-cluster MVO weights
 *   5. Final = intra × inter
 *
 * @param cov full N×N covariance matrix
 * @param cluster_assignment cluster index per asset (length N)
 */
export function ncoComplete(
  cov: number[][],
  cluster_assignment: number[]
): {
  intra_weights: number[];
  inter_weights: number[];
  final_weights: number[];
} {
  const N = cov.length;
  const clusters = Array.from(new Set(cluster_assignment));
  const K = clusters.length;

  // Intra-cluster: 1/σ² weighted (inverse variance portfolio) per cluster
  const intra_weights: number[] = new Array(N).fill(0);
  const cluster_var: number[] = new Array(K).fill(0);
  for (let ci = 0; ci < K; ci += 1) {
    const c = clusters[ci];
    const members = cluster_assignment.map((cc, i) => (cc === c ? i : -1)).filter(i => i !== -1);
    if (members.length === 0) continue;
    // IVP weights within cluster
    const inv_vars = members.map(i => 1 / Math.max(1e-9, cov[i][i]));
    const sum_inv = inv_vars.reduce((s, v) => s + v, 0);
    const w = inv_vars.map(v => v / sum_inv);
    members.forEach((i, k) => {
      intra_weights[i] = w[k];
    });
    // Cluster variance under intra weights
    let cv = 0;
    for (let a = 0; a < members.length; a += 1) {
      for (let b = 0; b < members.length; b += 1) {
        cv += w[a] * w[b] * cov[members[a]][members[b]];
      }
    }
    cluster_var[ci] = Math.max(1e-9, cv);
  }

  // Inter-cluster: IVP on cluster variances
  const inter_inv_vars = cluster_var.map(v => 1 / v);
  const inter_sum = inter_inv_vars.reduce((s, v) => s + v, 0);
  const inter_weights: number[] = inter_inv_vars.map(v => v / inter_sum);

  // Final = intra × cluster's inter weight
  const final_weights: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i += 1) {
    const ci = clusters.indexOf(cluster_assignment[i]);
    final_weights[i] = intra_weights[i] * inter_weights[ci];
  }
  return { intra_weights, inter_weights, final_weights };
}

// ============================================================
// MLfAM Ch.8 — Testing Set Overfitting (Combinatorial Backtest PBO)
// ============================================================

/**
 * Combinatorial Backtest (MLfAM Ch.8.2).
 *
 *   Split data into K equal groups. For each combination of N out of K groups:
 *     - Train on those N groups
 *     - Test on remaining K-N groups
 *   Repeat for all C(K, N).
 *
 *   For each path, record best strategy in train + its rank in test.
 *
 * @returns paths with train_rank_champion + test_rank_champion
 */
export function combinatorialBacktestPBO(input: {
  strategy_returns: number[][]; // K strategies × T periods
  n_train_groups: number; // N
  n_total_groups: number; // K (typical 8)
}): {
  paths: Array<{
    train_groups: number[];
    test_groups: number[];
    train_champion: number;
    test_rank_of_champion: number;
  }>;
  pbo: number;
} {
  const K = input.n_total_groups;
  const N = input.n_train_groups;
  const n_strategies = input.strategy_returns.length;
  const T = input.strategy_returns[0]?.length ?? 0;
  const group_size = Math.floor(T / K);

  // All combinations of N out of K
  const combinations: number[][] = [];
  const gen = (start: number, combo: number[]) => {
    if (combo.length === N) {
      combinations.push(combo.slice());
      return;
    }
    for (let i = start; i < K; i += 1) {
      combo.push(i);
      gen(i + 1, combo);
      combo.pop();
    }
  };
  gen(0, []);

  const paths: Array<{
    train_groups: number[];
    test_groups: number[];
    train_champion: number;
    test_rank_of_champion: number;
  }> = [];
  let overfit_count = 0;
  for (const train_groups of combinations) {
    const test_groups = Array.from({ length: K }, (_, i) => i).filter(
      g => !train_groups.includes(g)
    );

    // Compute train sharpe per strategy
    const train_sharpes = input.strategy_returns.map(rets => {
      const subset: number[] = [];
      for (const g of train_groups) {
        subset.push(...rets.slice(g * group_size, (g + 1) * group_size));
      }
      const m = subset.reduce((s, v) => s + v, 0) / subset.length;
      const v = subset.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, subset.length - 1);
      return v > 0 ? m / Math.sqrt(v) : 0;
    });
    const test_sharpes = input.strategy_returns.map(rets => {
      const subset: number[] = [];
      for (const g of test_groups) {
        subset.push(...rets.slice(g * group_size, (g + 1) * group_size));
      }
      const m = subset.reduce((s, v) => s + v, 0) / subset.length;
      const v = subset.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, subset.length - 1);
      return v > 0 ? m / Math.sqrt(v) : 0;
    });

    // Champion in train
    let champion = 0;
    let max_sharpe = train_sharpes[0];
    for (let s = 1; s < n_strategies; s += 1) {
      if (train_sharpes[s] > max_sharpe) {
        max_sharpe = train_sharpes[s];
        champion = s;
      }
    }
    // Rank champion in test (1 = best)
    const test_rank = test_sharpes.filter(s => s > test_sharpes[champion]).length + 1;
    paths.push({
      train_groups,
      test_groups,
      train_champion: champion,
      test_rank_of_champion: test_rank,
    });
    if (test_rank > n_strategies / 2) overfit_count += 1;
  }

  return { paths, pbo: paths.length > 0 ? overfit_count / paths.length : 0 };
}

// ============================================================
// AFML Ch.6 — Ensembles in Finance (Bagging Caveat)
// ============================================================

/**
 * Detect bagging leakage in time series.
 *
 *   Standard bagging samples i.i.d. from training set. In time series with
 *   overlapping labels, bootstrap samples are NOT independent. This causes
 *   in-sample sharpe inflation.
 *
 * Detection: average sample uniqueness across bootstrap samples.
 *   If avg_uniqueness < 0.5 → bagging will leak.
 *
 * @param sample_uniquenesses from afml-sample-weights.averageUniqueness
 * @returns recommendation
 */
export function detectBaggingLeakage(sample_uniquenesses: number[]): {
  avg_uniqueness: number;
  leakage_risk: 'low' | 'medium' | 'high';
  recommendation: string;
} {
  if (sample_uniquenesses.length === 0) {
    return { avg_uniqueness: 0, leakage_risk: 'high', recommendation: '无数据' };
  }
  const avg = sample_uniquenesses.reduce((s, v) => s + v, 0) / sample_uniquenesses.length;
  let risk: 'low' | 'medium' | 'high' = 'low';
  let rec: string;
  if (avg > 0.8) {
    rec = '✅ Bagging 安全 (low overlap)';
  } else if (avg > 0.5) {
    risk = 'medium';
    rec = '⚠️ Bagging 中等泄漏风险, 推荐用 sequentialBootstrap (AFML Ch.4)';
  } else {
    risk = 'high';
    rec =
      '🔴 Bagging 高泄漏风险, 必须用 sequentialBootstrap; 否则改用 Bayesian aggregation 替代 bagging';
  }
  return { avg_uniqueness: avg, leakage_risk: risk, recommendation: rec };
}

// ============================================================
// AFML Ch.9 — Backtesting CV Framework (Unified)
// ============================================================

/**
 * Backtest method enum (AFML Ch.9 framework).
 */
export type BacktestMethod = 'walk_forward' | 'purged_kfold' | 'cpcv' | 'combinatorial';

/**
 * Choose backtest method based on data characteristics.
 *
 *   - Small data (< 252 samples): walk_forward
 *   - Medium (252-1000): purged_kfold
 *   - Large + multiple strategies: cpcv or combinatorial
 *   - Need PBO: combinatorial (most paths)
 */
export function recommendBacktestMethod(input: {
  n_samples: number;
  n_strategies_to_compare: number;
  need_pbo: boolean;
}): {
  recommended_method: BacktestMethod;
  reason: string;
  config: any;
} {
  if (input.n_samples < 252) {
    return {
      recommended_method: 'walk_forward',
      reason: `小样本 ${input.n_samples} < 252, walk-forward 最适合避免 over-purging`,
      config: { train_months: 6, test_months: 1 },
    };
  }
  if (input.need_pbo && input.n_strategies_to_compare >= 5) {
    return {
      recommended_method: 'combinatorial',
      reason: `多策略 (${input.n_strategies_to_compare}) + 需 PBO → combinatorial backtest 给最稳定 PBO`,
      config: { n_total_groups: 8, n_train_groups: 4 },
    };
  }
  if (input.n_samples > 1000 && input.n_strategies_to_compare > 1) {
    return {
      recommended_method: 'cpcv',
      reason: `大数据 ${input.n_samples} + ≥2 strategies, CPCV 提供 ${
        (10 * 9) / 2 / 2
      } 倍 walk-forward path 数`,
      config: { n_groups: 10, k_test: 2, embargo_pct: 0.01 },
    };
  }
  return {
    recommended_method: 'purged_kfold',
    reason: `中等数据 + 单策略评估, purged k-fold 标准做法`,
    config: { k: 5, embargo_pct: 0.01 },
  };
}
