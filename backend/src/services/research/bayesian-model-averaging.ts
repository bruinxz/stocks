/**
 * Bayesian Model Averaging (BMA)
 *
 * 论文 reference:
 *   Raftery, A. E., Madigan, D., Hoeting, J. A. (1997). "Bayesian Model
 *   Averaging for Linear Regression Models."
 *   Journal of the American Statistical Association 92(437), 179-191.
 *
 *   Hoeting, J. A., Madigan, D., Raftery, A. E., Volinsky, C. T. (1999).
 *   "Bayesian Model Averaging: A Tutorial."
 *   Statistical Science 14(4), 382-401.
 *
 *   Avramov, D. (2002). "Stock return predictability and model uncertainty."
 *   Journal of Financial Economics 64(3), 423-458.
 *
 * **核心思想**:
 *
 *   单个 model 的预测 ignores model uncertainty.
 *   BMA: weight each model by its posterior probability,
 *        combine predictions across models.
 *
 *     P(Y | D) = Σ_k P(Y | M_k, D) · P(M_k | D)
 *
 *   其中:
 *     P(M_k | D) ∝ P(D | M_k) · P(M_k)
 *
 *     P(D | M_k) = marginal likelihood (evidence) — 关键, 用 BIC 近似:
 *
 *       log P(D | M_k) ≈ log L_k - (k/2) log(N)            (BIC approximation)
 *
 *     P(M_k | D) ∝ exp(-BIC_k / 2)
 *
 * **应用**:
 *
 *   1. **Strategy ensemble**: K 个 strategies (MFA, DragonHead, EarningsSurprise)
 *      预测 future return. BMA combine them weighted by posterior probability.
 *
 *   2. **Multiple Black-Litterman views**: 多个 analysts 给出 views,
 *      BMA combine into single posterior expected return.
 *
 *   3. **Model selection**: BIC 自动 penalize 复杂模型, 防过拟合.
 *
 * **本实现**:
 *   - bicScore(log_likelihood, n_params, n_obs) — BIC
 *   - posteriorProbabilities(bic_scores) — soft-max-like normalization
 *   - bayesianModelAverage(predictions, posteriors) — weighted combine
 *   - bmaWithPriorWeights — caller-specified prior + BIC-based likelihood
 */

/**
 * Bayesian Information Criterion (Schwarz 1978):
 *
 *   BIC = -2 log L + k · log(N)
 *
 *   越小越好 (smaller = better model)
 *
 *   approx -2 log P(D | M)
 *
 *   posterior P(M | D) ∝ exp(-BIC / 2)
 */
export function bicScore(log_likelihood: number, n_params: number, n_obs: number): number {
  return -2 * log_likelihood + n_params * Math.log(n_obs);
}

/**
 * Akaike Information Criterion (alternative, lighter penalty):
 *
 *   AIC = -2 log L + 2k
 */
export function aicScore(log_likelihood: number, n_params: number): number {
  return -2 * log_likelihood + 2 * n_params;
}

/**
 * Convert BIC scores to posterior probabilities (with optional model priors).
 *
 *   p_k ∝ P(M_k) · exp(-BIC_k / 2)
 *
 *   等价 softmax(log P(M_k) - BIC_k / 2)
 *
 *   uniform priors: simply exp(-BIC_k / 2) normalized
 */
export function posteriorProbabilities(
  bic_scores: number[],
  prior_log_probs?: number[]
): number[] {
  const K = bic_scores.length;
  const priors = prior_log_probs ?? new Array(K).fill(-Math.log(K)); // uniform prior
  if (priors.length !== K) throw new Error('posteriorProbabilities: priors length mismatch');
  // log unnormalized posterior
  const log_post = bic_scores.map((bic, k) => priors[k] - bic / 2);
  // softmax (max subtraction)
  let max = -Infinity;
  for (const v of log_post) if (v > max) max = v;
  if (!Number.isFinite(max)) return new Array(K).fill(1 / K);
  const exped = log_post.map(v => Math.exp(v - max));
  const sum = exped.reduce((s, v) => s + v, 0);
  return sum > 0 ? exped.map(v => v / sum) : new Array(K).fill(1 / K);
}

/**
 * Bayesian model averaging of point predictions.
 *
 *   ŷ_BMA = Σ_k w_k · ŷ_k
 *
 * Where w_k = posterior probability of model k.
 *
 * @param predictions array of (K models, T predictions each) — must be aligned
 * @param posteriors length K, sums to 1
 * @returns averaged predictions, length T
 */
export function bayesianModelAverage(
  predictions: number[][], // K × T
  posteriors: number[]
): number[] {
  const K = predictions.length;
  if (posteriors.length !== K) throw new Error('bayesianModelAverage: K mismatch');
  if (K === 0) return [];
  const T = predictions[0].length;
  const out: number[] = new Array(T).fill(0);
  for (let t = 0; t < T; t += 1) {
    let s = 0;
    for (let k = 0; k < K; k += 1) {
      if (Number.isFinite(predictions[k][t])) s += posteriors[k] * predictions[k][t];
    }
    out[t] = s;
  }
  return out;
}

/**
 * Combine model variances (uncertainty quantification):
 *
 *   Var(ŷ_BMA) = Σ_k w_k · (Var_k + (ŷ_k - ŷ_BMA)²)
 *
 *   第一项: within-model variance (uncertainty within each model)
 *   第二项: between-model variance (disagreement between models)
 */
export function bmaVariance(
  predictions: number[],
  variances: number[],
  posteriors: number[]
): number {
  const K = predictions.length;
  if (variances.length !== K || posteriors.length !== K) throw new Error('bmaVariance: K mismatch');
  const yBMA = predictions.reduce((s, p, k) => s + posteriors[k] * p, 0);
  let total = 0;
  for (let k = 0; k < K; k += 1) {
    total += posteriors[k] * (variances[k] + (predictions[k] - yBMA) ** 2);
  }
  return total;
}

/**
 * Convenience: combine models with BIC-based weights + uniform priors.
 *
 * @param models list of { predictions, log_likelihood, n_params, n_obs }
 */
export interface BMAModel {
  name: string;
  predictions: number[];
  log_likelihood: number;
  n_params: number;
  n_obs: number;
  /** Optional per-prediction variances (for bmaVariance) */
  prediction_variances?: number[];
}

export interface BMAResult {
  /** Combined predictions */
  averaged_predictions: number[];
  /** Per-model posterior probabilities (sum=1) */
  posteriors: number[];
  /** Per-model BIC */
  bic_scores: number[];
  /** Per-model name */
  model_names: string[];
  /** Combined variance (if all models supply variances) */
  averaged_variances?: number[];
}

export function combineModelsBMA(models: BMAModel[]): BMAResult {
  if (models.length === 0) {
    return { averaged_predictions: [], posteriors: [], bic_scores: [], model_names: [] };
  }
  const T = models[0].predictions.length;
  const bic_scores = models.map(m => bicScore(m.log_likelihood, m.n_params, m.n_obs));
  const posteriors = posteriorProbabilities(bic_scores);
  const preds = models.map(m => m.predictions);
  const averaged = bayesianModelAverage(preds, posteriors);

  let averaged_variances: number[] | undefined;
  if (models.every(m => Array.isArray(m.prediction_variances) && m.prediction_variances!.length === T)) {
    averaged_variances = new Array(T).fill(0);
    for (let t = 0; t < T; t += 1) {
      const ps_t = models.map(m => m.predictions[t]);
      const vs_t = models.map(m => m.prediction_variances![t]);
      averaged_variances[t] = bmaVariance(ps_t, vs_t, posteriors);
    }
  }

  return {
    averaged_predictions: averaged,
    posteriors,
    bic_scores,
    model_names: models.map(m => m.name),
    averaged_variances,
  };
}

/**
 * Effective number of models (entropy-based).
 *
 *   K_eff = exp(H(p)) = exp(-Σ p_k log p_k)
 *
 *   K_eff = 1: 完全 dominated by one model
 *   K_eff = K: uniform (all models equally likely)
 */
export function effectiveModelCount(posteriors: number[]): number {
  let entropy = 0;
  for (const p of posteriors) {
    if (p > 1e-12) entropy -= p * Math.log(p);
  }
  return Math.exp(entropy);
}
