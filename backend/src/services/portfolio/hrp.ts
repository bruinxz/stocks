/**
 * Hierarchical Risk Parity (HRP)
 *
 * 论文 reference:
 *   López de Prado, M. (2016). "Building Diversified Portfolios that Outperform
 *   Out-of-Sample." Journal of Portfolio Management 42(4), 59-69.
 *   https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2708678
 *
 * 实现 reference:
 *   Wikipedia "Hierarchical Risk Parity" (CC BY-SA 4.0)
 *
 * **3 步算法**：
 *
 *   Step 1 — Tree Clustering:
 *     - 从相关矩阵 ρ 派生 distance: d[i,j] = √((1 - ρ[i,j]) / 2)
 *     - 再算 secondary distance: d̃[i,j] = √(Σ_n (d[n,i] - d[n,j])²)
 *     - 用 single-linkage (nearest neighbor) 聚类，构造 dendrogram
 *
 *   Step 2 — Quasi-Diagonalization:
 *     - 按聚类树重排资产，让高相关资产相邻
 *     - cov 矩阵重排后近似 block-diagonal
 *
 *   Step 3 — Recursive Bisection:
 *     - 把排序后的 list 二分为 L1, L2
 *     - 每个子集用 inverse-variance weight 算"子组合 variance"
 *     - α = 1 - V₁ / (V₁ + V₂)  → L1 权重缩 α 倍，L2 缩 (1-α) 倍
 *     - 递归直到每个子集只剩 1 资产
 *
 * **为什么 HRP 比 ERC / Markowitz 好**：
 *   - 不需要 cov inverse → 数值稳健
 *   - 在 N > T/3 (维度接近样本数) 时不会爆掉
 *   - López de Prado 论文 simulation 显示 OOS sharpe HRP > Markowitz > IVP
 *
 * **复杂度**: O(N²) for clustering + O(N) for bisection
 */

/**
 * 从相关矩阵派生 distance (Step 1a)
 *
 * d[i,j] = √((1 - ρ[i,j]) / 2)
 *
 * - ρ = +1 → d = 0 (完全相关 → 距离为 0)
 * - ρ = 0 → d = 1/√2 ≈ 0.707
 * - ρ = -1 → d = 1 (完全反相关 → 距离为 1)
 */
export function correlationToDistance(corr: number[][]): number[][] {
  const N = corr.length;
  const d: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      // 防御 numerical: clip ρ to [-1, 1]
      const r = Math.max(-1, Math.min(1, corr[i][j]));
      d[i][j] = Math.sqrt(Math.max(0, (1 - r) / 2));
    }
  }
  return d;
}

/**
 * 协方差 → 相关矩阵
 *
 * ρ[i,j] = Σ[i,j] / √(Σ[i,i] · Σ[j,j])
 */
export function covarianceToCorrelation(cov: number[][]): number[][] {
  const N = cov.length;
  const corr: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  const sd = cov.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const denom = sd[i] * sd[j];
      corr[i][j] = denom > 1e-12 ? cov[i][j] / denom : i === j ? 1 : 0;
    }
  }
  return corr;
}

/**
 * Single-linkage hierarchical clustering (Step 1b - 2)
 *
 * 返回 cluster order list of length N（每个 entry 是原始 asset index）。
 * 算法：每次找最近的 2 cluster 合并，重复 N-1 次。
 *
 * 实现：维护 active clusters 数组，每个 cluster 是 number[] (asset indices)。
 * 合并后用 single-linkage 更新到剩余 cluster 的距离: min(d_old1, d_old2).
 *
 * 输出 sortedIndex: 按聚类树叶子顺序遍历得到的 asset index 序列
 * （相邻的资产相关性高）。
 */
export function hierarchicalClusterOrder(distance: number[][]): number[] {
  const N = distance.length;
  if (N === 0) return [];
  if (N === 1) return [0];

  // active clusters: each is { items: number[], distToOthers: number[] }
  // distance matrix between current clusters
  const clusters: number[][] = Array.from({ length: N }, (_, i) => [i]);
  // distance matrix between clusters (mutable copy)
  let dmat = distance.map(row => row.slice());

  while (clusters.length > 1) {
    // 找最小距离对 (i, j) i < j
    let bestI = 0;
    let bestJ = 1;
    let bestD = Infinity;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        if (dmat[i][j] < bestD) {
          bestD = dmat[i][j];
          bestI = i;
          bestJ = j;
        }
      }
    }
    // 合并 bestI 和 bestJ → 新 cluster 替代 bestI 位置，删 bestJ
    const merged = clusters[bestI].concat(clusters[bestJ]);
    // 新距离: single-linkage = min(d[bestI,k], d[bestJ,k])
    const newDistRow: number[] = [];
    for (let k = 0; k < clusters.length; k += 1) {
      if (k === bestI || k === bestJ) continue;
      newDistRow.push(Math.min(dmat[bestI][k], dmat[bestJ][k]));
    }
    // 移除 bestI, bestJ；放入合并 cluster
    const newClusters: number[][] = [];
    const newDmat: number[][] = [];
    let idxOff = 0;
    for (let k = 0; k < clusters.length; k += 1) {
      if (k === bestI || k === bestJ) continue;
      newClusters.push(clusters[k]);
      // build new dmat row for k
      const row: number[] = [];
      let idxOff2 = 0;
      for (let l = 0; l < clusters.length; l += 1) {
        if (l === bestI || l === bestJ) continue;
        row.push(dmat[k][l]);
        idxOff2 += 1;
      }
      // append distance to merged
      const distToMerged = Math.min(dmat[k][bestI], dmat[k][bestJ]);
      row.push(distToMerged);
      newDmat.push(row);
      idxOff += 1;
    }
    // append merged cluster row
    const mergedRow = newDistRow.slice();
    mergedRow.push(0); // self
    newDmat.push(mergedRow);
    newClusters.push(merged);

    clusters.splice(0, clusters.length, ...newClusters);
    dmat = newDmat;
  }

  return clusters[0];
}

/**
 * Inverse-variance portfolio weights (Step 3 helper)
 *
 * w_i ∝ 1 / σ_i²  (然后归一化 sum=1)
 */
export function inverseVariancePortfolio(cov: number[][], items: number[]): number[] {
  const ivp = items.map(i => 1.0 / Math.max(1e-12, cov[i][i]));
  const sum = ivp.reduce((s, v) => s + v, 0);
  return sum > 0 ? ivp.map(v => v / sum) : items.map(() => 1 / items.length);
}

/**
 * Cluster variance under inverse-variance weighting
 *
 * V_cluster = wᵀ Σ_cluster w
 */
export function clusterVariance(cov: number[][], items: number[]): number {
  const w = inverseVariancePortfolio(cov, items);
  let v = 0;
  for (let a = 0; a < items.length; a += 1) {
    for (let b = 0; b < items.length; b += 1) {
      v += w[a] * w[b] * cov[items[a]][items[b]];
    }
  }
  return Math.max(0, v);
}

/**
 * Recursive Bisection (Step 3)
 *
 * @param cov     full N×N covariance matrix (original index order)
 * @param order   sorted asset indices from hierarchicalClusterOrder
 * @returns       weights[i] for original asset index i (length N, sums to 1)
 */
export function recursiveBisection(cov: number[][], order: number[]): number[] {
  const N = cov.length;
  const weights: number[] = new Array(N).fill(0);
  for (const i of order) weights[i] = 1.0;

  // BFS over splits
  let clusters: number[][] = [order.slice()];
  while (clusters.length > 0) {
    const next: number[][] = [];
    for (const c of clusters) {
      if (c.length > 1) {
        const mid = Math.floor(c.length / 2);
        const L1 = c.slice(0, mid);
        const L2 = c.slice(mid);
        const V1 = clusterVariance(cov, L1);
        const V2 = clusterVariance(cov, L2);
        const denom = V1 + V2;
        if (denom > 0) {
          const alpha = 1.0 - V1 / denom;
          for (const i of L1) weights[i] *= alpha;
          for (const i of L2) weights[i] *= 1.0 - alpha;
        }
        next.push(L1);
        next.push(L2);
      }
    }
    clusters = next;
  }
  // 验证 sum (numerical sanity); 归一化保险
  const s = weights.reduce((a, b) => a + b, 0);
  if (s > 0 && Math.abs(s - 1) > 1e-6) {
    return weights.map(w => w / s);
  }
  return weights;
}

/**
 * 主入口：HRP weights from raw cov matrix
 */
export function hierarchicalRiskParity(cov: number[][]): {
  weights: number[];
  cluster_order: number[];
  shrinkage_used: number; // 0 if not shrunken externally
} {
  const corr = covarianceToCorrelation(cov);
  const dist = correlationToDistance(corr);
  const order = hierarchicalClusterOrder(dist);
  const weights = recursiveBisection(cov, order);
  return { weights, cluster_order: order, shrinkage_used: 0 };
}
