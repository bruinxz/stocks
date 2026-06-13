/**
 * AFML Ch.8 — Feature Importance
 *
 * 论文 reference:
 *   López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
 *   Chapter 8: "Feature Importance"
 *
 * **3 个方法**:
 *
 *   1. **MDI** (Mean Decrease Impurity) - tree-based, 训练时计算
 *      - For each split, compute weighted impurity decrease
 *      - Sum across all trees, normalize
 *      - 缺点: biased toward high-cardinality features
 *
 *   2. **MDA** (Mean Decrease Accuracy) - post-training, permutation-based
 *      - For each feature, permute its values in OOS, observe accuracy drop
 *      - 更准确, 但慢 (N_features × N_folds 次)
 *
 *   3. **SFI** (Single Feature Importance) - 训练单 feature 模型
 *      - 训练 N_features 个单变量模型, 看 OOS accuracy
 *      - 不受 substitution effect 影响 (其他 feature 没在场)
 *
 *   实务推荐:
 *     - MDA: 主信号 (考虑 substitution + 整体贡献)
 *     - SFI: 验证 (排除 substitution effect)
 *     - 两者一致 → 强 signal; 不一致 → 看 substitution 性质
 *
 * **本实现** (简化版):
 *   - 假设已有 ML 模型 (Logistic Regression in MetaLabel)
 *   - mdaImportance: 对每个 feature permute, observe loss change
 *   - sfiImportance: 训练 single-feature LR, observe acc
 *   - 无需 RF (我们当前 MetaLabel 用 LR, 不支持 MDI tree-based)
 */

import { TrainingRow, sigmoid, FeatureName, FEATURE_NAMES, buildFeatureVector, MetaLabelModel } from './MetaLabelService';

/** Park-Miller LCG for reproducible permutation */
class PermutationRng {
  private state: number;
  constructor(seed = 42) {
    this.state = seed % 2147483647;
    if (this.state <= 0) this.state += 2147483646;
  }
  next(): number {
    this.state = (this.state * 16807) % 2147483647;
    return this.state / 2147483647;
  }
  /** Fisher-Yates shuffle */
  shuffle<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/**
 * Compute log-loss of model on test set.
 */
export function modelLogLoss(model: MetaLabelModel, rows: TrainingRow[]): number {
  let loss = 0;
  let count = 0;
  for (const r of rows) {
    const x = buildFeatureVector(r.features, model.feature_means, model.feature_stds);
    let z = model.bias;
    for (const n of FEATURE_NAMES) z += model.weights[n] * x[n];
    const p = sigmoid(z);
    const p_clip = Math.max(1e-12, Math.min(1 - 1e-12, p));
    loss += -(r.label * Math.log(p_clip) + (1 - r.label) * Math.log(1 - p_clip));
    count += 1;
  }
  return count > 0 ? loss / count : 0;
}

/**
 * Compute accuracy of model on test set.
 */
export function modelAccuracy(model: MetaLabelModel, rows: TrainingRow[]): number {
  let correct = 0;
  for (const r of rows) {
    const x = buildFeatureVector(r.features, model.feature_means, model.feature_stds);
    let z = model.bias;
    for (const n of FEATURE_NAMES) z += model.weights[n] * x[n];
    const pred = sigmoid(z) >= 0.5 ? 1 : 0;
    if (pred === r.label) correct += 1;
  }
  return rows.length > 0 ? correct / rows.length : 0;
}

/**
 * MDA (Mean Decrease Accuracy) Feature Importance.
 *
 * For each numeric feature:
 *   1. Compute baseline OOS loss
 *   2. Permute that feature's values in OOS rows
 *   3. Recompute loss; importance = permuted_loss - baseline_loss
 *
 * @returns map feature_name → importance (higher = more important)
 */
export function mdaImportance(
  model: MetaLabelModel,
  test_rows: TrainingRow[],
  options: { seed?: number; n_permutations?: number } = {}
): Record<string, number> {
  const seed = options.seed ?? 42;
  const n_perm = options.n_permutations ?? 5;
  const baseline_loss = modelLogLoss(model, test_rows);
  const rng = new PermutationRng(seed);

  const importances: Record<string, number> = {};
  // 6 raw numeric features to permute (与 signal_score / breadth / winrate / payoff / atr 对应)
  const numericFeatures = ['signal_score', 'market_breadth_score', 'strategy_recent_winrate_30d', 'strategy_recent_payoff_30d', 'market_vol_atr'];

  for (const feat of numericFeatures) {
    let totalDelta = 0;
    for (let p = 0; p < n_perm; p += 1) {
      // Permute that feature
      const orig_values = test_rows.map(r => (r.features as any)[feat] as number);
      const permuted = rng.shuffle(orig_values);
      const permuted_rows: TrainingRow[] = test_rows.map((r, i) => ({
        ...r,
        features: { ...r.features, [feat]: permuted[i] } as any,
      }));
      const permuted_loss = modelLogLoss(model, permuted_rows);
      totalDelta += permuted_loss - baseline_loss;
    }
    importances[feat] = totalDelta / n_perm;
  }
  // Permute categorical (signal_source / regime)
  for (const feat of ['signal_source', 'regime']) {
    let totalDelta = 0;
    for (let p = 0; p < n_perm; p += 1) {
      const orig_values = test_rows.map(r => (r.features as any)[feat] as string);
      const permuted = rng.shuffle(orig_values);
      const permuted_rows: TrainingRow[] = test_rows.map((r, i) => ({
        ...r,
        features: { ...r.features, [feat]: permuted[i] } as any,
      }));
      const permuted_loss = modelLogLoss(model, permuted_rows);
      totalDelta += permuted_loss - baseline_loss;
    }
    importances[feat] = totalDelta / n_perm;
  }

  return importances;
}

/**
 * SFI (Single Feature Importance) Feature Importance.
 *
 * For each feature:
 *   - 训练 single-feature LR model
 *   - 返回 OOS accuracy
 *
 * 简化: 我们用 single-feature mean-vs-mean baseline (不真训 LR):
 *   accuracy = % rows where (sign(feature - mean) == label)
 *
 * 真实 SFI 应训完整 single-feature LR, 但复杂度高 (要拟合 W 给每个 feature).
 * 这里给的是 quick estimate, 实务 ops 推荐用 mdaImportance 主要看.
 */
export function sfiImportance(
  rows: TrainingRow[],
  options: { feature_means?: Record<string, number> } = {}
): Record<string, number> {
  const importances: Record<string, number> = {};
  const numericFeatures = ['signal_score', 'market_breadth_score', 'strategy_recent_winrate_30d', 'strategy_recent_payoff_30d', 'market_vol_atr'];

  for (const feat of numericFeatures) {
    const values = rows.map(r => (r.features as any)[feat] as number);
    const mean = options.feature_means?.[feat] ?? values.reduce((s, v) => s + v, 0) / values.length;
    let correct = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const sign_feature = values[i] >= mean ? 1 : 0;
      if (sign_feature === rows[i].label) correct += 1;
    }
    importances[feat] = rows.length > 0 ? correct / rows.length : 0;
  }
  // For categorical, just dummy 0.5 (no easy SFI baseline)
  for (const feat of ['signal_source', 'regime']) {
    importances[feat] = 0.5;
  }
  return importances;
}

/**
 * 综合 importance ranking.
 *
 * Combine MDA + SFI:
 *   - normalize each to [0, 1]
 *   - average = (norm_mda + norm_sfi_above_0.5) / 2
 *   - rank features by combined score
 */
export function rankFeatures(
  mda: Record<string, number>,
  sfi: Record<string, number>
): Array<{ feature: string; mda: number; sfi: number; combined: number; rank: number }> {
  const mdaVals = Object.values(mda);
  const mdaMin = Math.min(...mdaVals);
  const mdaMax = Math.max(...mdaVals);
  const mdaRange = mdaMax - mdaMin || 1;

  const features = Array.from(new Set([...Object.keys(mda), ...Object.keys(sfi)]));
  const ranked = features.map(feat => {
    const mdaNorm = ((mda[feat] || 0) - mdaMin) / mdaRange;
    const sfiAdj = Math.max(0, (sfi[feat] || 0.5) - 0.5) * 2;
    const combined = (mdaNorm + sfiAdj) / 2;
    return { feature: feat, mda: mda[feat] || 0, sfi: sfi[feat] || 0.5, combined, rank: 0 };
  });
  ranked.sort((a, b) => b.combined - a.combined);
  for (let i = 0; i < ranked.length; i += 1) ranked[i].rank = i + 1;
  return ranked;
}
