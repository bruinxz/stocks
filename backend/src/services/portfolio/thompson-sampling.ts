/**
 * Thompson Sampling for Multi-Strategy Allocation
 *
 * 论文 reference:
 *   Thompson, W. R. (1933). "On the likelihood that one unknown probability
 *   exceeds another in view of the evidence of two samples."
 *   Biometrika 25(3-4), 285-294.
 *
 *   Russo, D., Van Roy, B., Kazerouni, A., Osband, I., Wen, Z. (2018).
 *   "A Tutorial on Thompson Sampling."
 *   Foundations and Trends in Machine Learning 11(1), 1-96.
 *
 *   Chapelle, O. and Li, L. (2011). "An Empirical Evaluation of Thompson
 *   Sampling." Advances in Neural Information Processing Systems 24.
 *
 * **核心问题**:
 *
 *   Multi-strategy allocation (PortfolioOptimizer for strategies, not stocks):
 *
 *     - Fixed weights = explore-then-commit: 拍脑袋 + 永不更新
 *     - 简单 max-Sharpe past performance = greedy: overfits 短期 noise
 *     - Optimal: balance exploration (try new strategies) vs exploitation (use winners)
 *
 *   Thompson Sampling: 每个策略 maintain a posterior over its expected return.
 *   每次需要 allocate, **从 posterior 采样** μ_i, then pick weights based on samples.
 *
 *   优点:
 *     - 自然平衡 exploration / exploitation
 *     - 不需要 hyperparameter tuning (UCB 需要 c)
 *     - Regret bound 与 UCB 相当, 实证表现更好 (Chapelle-Li 2011)
 *
 * **Bandit Model**:
 *
 *   K 个 strategies, 每个 strategy i 有未知 expected return μ_i.
 *
 *   Prior: μ_i ~ Normal(μ_0, σ_0²)  (uninformed prior)
 *   Likelihood: observed return r ~ Normal(μ_i, σ_obs²)
 *
 *   Posterior after n observations [r_1, ..., r_n] with mean r̄:
 *
 *     μ_i | data ~ Normal(μ_n, σ_n²)
 *
 *     σ_n² = 1 / (1/σ_0² + n/σ_obs²)
 *     μ_n = σ_n² × (μ_0/σ_0² + n·r̄/σ_obs²)
 *
 * **Decision Rule**:
 *
 *   for each round t:
 *     sample μ̃_i ~ Posterior(μ_i)  for all i
 *     weights ∝ softmax(μ̃ / temperature)
 *     observe new return → update posterior
 *
 *   temperature → 0: argmax (pure exploitation)
 *   temperature → ∞: uniform (pure exploration)
 *   temperature = 0.5-1.0: balanced
 *
 * **本实现**:
 *   - Gaussian posterior (conjugate prior with known σ_obs²)
 *   - Track per-strategy (n_obs, mean_reward, posterior_mean, posterior_var)
 *   - sampleAllocations: returns weights array (sum = 1)
 *   - updateWithReward: Bayesian posterior update
 *   - 提供 reproducible seeded sampling (Box-Muller from seeded uniform)
 */

/**
 * Park-Miller LCG seeded RNG (与 BayesianOptimizer / Bootstrap 一致)
 */
export class TSRng {
  private state: number;
  constructor(seed = 42) {
    this.state = seed % 2147483647;
    if (this.state <= 0) this.state += 2147483646;
  }
  next(): number {
    this.state = (this.state * 16807) % 2147483647;
    return this.state / 2147483647;
  }
  /** Box-Muller transform: uniform → normal(0, 1) */
  nextGaussian(): number {
    let u1 = this.next();
    const u2 = this.next();
    if (u1 < 1e-12) u1 = 1e-12;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

export interface StrategyPosterior {
  strategy_key: string;
  /** Number of observations */
  n_obs: number;
  /** Mean of observed returns */
  observed_mean: number;
  /** Sum of squared deviations (for online std calc) */
  observed_sum_sq_dev: number;
  /** Prior mean */
  prior_mu: number;
  /** Prior variance */
  prior_var: number;
  /** Observation noise variance (assumed known) */
  obs_var: number;
  /** Posterior mean (computed from prior + observations) */
  posterior_mu: number;
  /** Posterior variance */
  posterior_var: number;
}

/**
 * Create initial posterior for a new strategy (with prior).
 *
 * @param strategy_key identifier
 * @param prior_mu prior mean (default 0 = uninformed)
 * @param prior_var prior variance (default 1.0 = wide uninformed prior)
 * @param obs_var assumed observation noise variance (default 0.5 = 单期 daily return std² ≈ 0.0001 if returns in fraction; for percentage scale use 1.0)
 */
export function createPrior(
  strategy_key: string,
  prior_mu = 0,
  prior_var = 1.0,
  obs_var = 0.5
): StrategyPosterior {
  return {
    strategy_key,
    n_obs: 0,
    observed_mean: 0,
    observed_sum_sq_dev: 0,
    prior_mu,
    prior_var,
    obs_var,
    posterior_mu: prior_mu,
    posterior_var: prior_var,
  };
}

/**
 * Bayesian update of Normal-Normal conjugate.
 *
 *   posterior_var = 1 / (1/prior_var + n/obs_var)
 *   posterior_mu = posterior_var × (prior_mu/prior_var + n·observed_mean/obs_var)
 *
 * Uses running mean / variance for online update.
 */
export function updatePosterior(
  posterior: StrategyPosterior,
  new_reward: number
): StrategyPosterior {
  if (!Number.isFinite(new_reward)) return posterior;

  const n_new = posterior.n_obs + 1;
  const delta = new_reward - posterior.observed_mean;
  const new_mean = posterior.observed_mean + delta / n_new;
  const delta2 = new_reward - new_mean;
  const new_sum_sq = posterior.observed_sum_sq_dev + delta * delta2;

  const post_var = 1 / (1 / posterior.prior_var + n_new / posterior.obs_var);
  const post_mu =
    post_var * (posterior.prior_mu / posterior.prior_var + (n_new * new_mean) / posterior.obs_var);

  return {
    ...posterior,
    n_obs: n_new,
    observed_mean: new_mean,
    observed_sum_sq_dev: new_sum_sq,
    posterior_mu: post_mu,
    posterior_var: post_var,
  };
}

/**
 * Sample μ from a strategy's posterior: μ ~ N(posterior_mu, posterior_var)
 */
export function samplePosteriorMu(posterior: StrategyPosterior, rng: TSRng): number {
  const z = rng.nextGaussian();
  return posterior.posterior_mu + Math.sqrt(posterior.posterior_var) * z;
}

/**
 * Softmax allocation from sampled μ values.
 *
 *   weight_i = exp(μ̃_i / T) / Σ_j exp(μ̃_j / T)
 *
 * 温度 T:
 *   - T → 0: argmax (1 winner)
 *   - T = 0.5: 强 exploit
 *   - T = 1.0: balanced
 *   - T = 2.0: 强 explore
 *
 * Numerically stable using max-subtraction.
 */
export function softmaxAllocation(sampled_mus: number[], temperature: number): number[] {
  const T = Math.max(1e-6, temperature);
  const scaled = sampled_mus.map(v => v / T);
  let max = -Infinity;
  for (const v of scaled) if (v > max) max = v;
  const exped = scaled.map(v => Math.exp(v - max));
  const sum = exped.reduce((s, v) => s + v, 0);
  if (sum <= 0) return sampled_mus.map(() => 1 / sampled_mus.length);
  return exped.map(v => v / sum);
}

/**
 * 主入口: Thompson sampling allocation.
 *
 *   1. Sample μ̃_i for each strategy
 *   2. Compute weights = softmax(μ̃ / temperature) OR argmax
 *   3. Return weights (sum = 1)
 *
 * @param posteriors current posterior state for each strategy
 * @param options.temperature softmax temperature (default 1.0)
 * @param options.rng seeded RNG (default new TSRng(42))
 * @param options.mode 'softmax' (continuous weights) or 'argmax' (winner takes all)
 * @param options.min_weight floor each weight (default 0)
 */
export function thompsonSamplingAllocation(
  posteriors: StrategyPosterior[],
  options: {
    temperature?: number;
    rng?: TSRng;
    mode?: 'softmax' | 'argmax';
    min_weight?: number;
  } = {}
): { weights: number[]; sampled_mus: number[] } {
  if (posteriors.length === 0) return { weights: [], sampled_mus: [] };
  const rng = options.rng ?? new TSRng(42);
  const mode = options.mode ?? 'softmax';
  const T = options.temperature ?? 1.0;
  const minW = options.min_weight ?? 0;

  const sampled = posteriors.map(p => samplePosteriorMu(p, rng));

  let weights: number[];
  if (mode === 'argmax') {
    let bestIdx = 0;
    let bestVal = sampled[0];
    for (let i = 1; i < sampled.length; i += 1) {
      if (sampled[i] > bestVal) {
        bestVal = sampled[i];
        bestIdx = i;
      }
    }
    weights = sampled.map((_, i) => (i === bestIdx ? 1 : 0));
  } else {
    weights = softmaxAllocation(sampled, T);
  }

  // Apply min_weight floor + renormalize
  if (minW > 0) {
    weights = weights.map(w => Math.max(minW, w));
    const sum = weights.reduce((s, v) => s + v, 0);
    if (sum > 0) weights = weights.map(w => w / sum);
  }

  return { weights, sampled_mus: sampled };
}

/**
 * Beta-Bernoulli Thompson sampling (alternative for binary outcomes).
 *
 * 用于 binary reward (e.g. "策略 t-day 是否盈利"). Beta(α, β) conjugate.
 *
 *   α_new = α + success
 *   β_new = β + failure
 *
 * Sample: θ ~ Beta(α, β), pick argmax θ.
 *
 * 简化版: sample 用 marsaglia 或 inverse CDF.
 * 这里用 Gamma sampling (Marsaglia-Tsang 2000): Beta(α, β) = G(α) / (G(α) + G(β))
 */
export function sampleBeta(alpha: number, beta: number, rng: TSRng): number {
  // Marsaglia-Tsang gamma sampling (simplified for α ≥ 1)
  const sampleGamma = (a: number): number => {
    if (a < 1) {
      // Boost: G(a) = G(a+1) · U^(1/a)
      const g = sampleGamma(a + 1);
      const u = rng.next();
      return g * Math.pow(u, 1 / a);
    }
    const d = a - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      const x = rng.nextGaussian();
      const v = (1 + c * x) ** 3;
      if (v <= 0) continue;
      const u = rng.next();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const ga = sampleGamma(alpha);
  const gb = sampleGamma(beta);
  return ga / (ga + gb);
}

export interface BetaBernoulliPosterior {
  strategy_key: string;
  /** Number of successes (e.g. profitable days) */
  alpha: number;
  /** Number of failures */
  beta: number;
}

/**
 * Beta-Bernoulli posterior update.
 *   α += 1 if outcome else 0
 *   β += 0 if outcome else 1
 */
export function updateBetaBernoulli(
  posterior: BetaBernoulliPosterior,
  outcome: boolean
): BetaBernoulliPosterior {
  return {
    ...posterior,
    alpha: posterior.alpha + (outcome ? 1 : 0),
    beta: posterior.beta + (outcome ? 0 : 1),
  };
}

/**
 * Beta-Bernoulli Thompson sampling allocation.
 *
 * For each strategy, sample θ_i ~ Beta(α_i, β_i), then softmax / argmax over θ.
 */
export function betaBernoulliThompsonAllocation(
  posteriors: BetaBernoulliPosterior[],
  options: { temperature?: number; rng?: TSRng; mode?: 'softmax' | 'argmax' } = {}
): { weights: number[]; sampled_probs: number[] } {
  if (posteriors.length === 0) return { weights: [], sampled_probs: [] };
  const rng = options.rng ?? new TSRng(42);
  const mode = options.mode ?? 'softmax';
  const T = options.temperature ?? 1.0;

  const sampled = posteriors.map(p =>
    sampleBeta(Math.max(0.1, p.alpha), Math.max(0.1, p.beta), rng)
  );

  let weights: number[];
  if (mode === 'argmax') {
    let bestIdx = 0;
    let bestVal = sampled[0];
    for (let i = 1; i < sampled.length; i += 1) {
      if (sampled[i] > bestVal) {
        bestVal = sampled[i];
        bestIdx = i;
      }
    }
    weights = sampled.map((_, i) => (i === bestIdx ? 1 : 0));
  } else {
    weights = softmaxAllocation(sampled, T);
  }

  return { weights, sampled_probs: sampled };
}
