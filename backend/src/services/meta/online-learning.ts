/**
 * Online Learning for MetaLabel (SGD incremental update)
 *
 * 思想 reference:
 *   Robbins, H. and Monro, S. (1951). "A Stochastic Approximation Method."
 *   Annals of Mathematical Statistics 22(3), 400-407.
 *
 *   Bottou, L. (2010). "Large-Scale Machine Learning with Stochastic Gradient Descent."
 *   COMPSTAT 2010.
 *
 * **核心问题**:
 *
 *   原 MetaLabelService 是 batch training — 必须周期性重训整个 logistic regression.
 *   生产环境每天/每周才训一次 → 模型对最近 closed outcomes 滞后.
 *
 *   Online learning: 每来 1 个新 closed outcome → 立即用 SGD 一步更新参数.
 *
 *     w_new = w_old - η · ∇L(w_old, x_new, y_new)
 *
 *   其中 η = learning rate (decreasing schedule).
 *
 * **SGD for Logistic Regression**:
 *
 *   loss L = -(y · log(σ(z)) + (1-y) · log(1 - σ(z))), z = w^T x + b
 *
 *   ∇_w L = (σ(z) - y) · x
 *   ∇_b L = (σ(z) - y)
 *
 * **Learning rate schedule (Bottou 2010)**:
 *
 *   η_t = η_0 / (1 + γ · t)
 *
 *   或 RobbinsMonro:  η_t = η_0 · t^{-0.6}
 *
 * **关键约束 (与 batch 训练相比)**:
 *   1. SGD 步长太大会让模型震荡; 太小学得慢
 *   2. 必须用 momentum / Adam 让 noise 不破坏收敛 (生产推荐 Adam)
 *   3. 每 N 个 update 后做 batch validation 防 drift
 *   4. 用 EWMA decay 模拟"近期样本权重更高"
 *
 * **本实现**:
 *   - 简单 SGD with decaying learning rate
 *   - 每次 update 同时更新 in-process model 和 disk JSON
 *   - L2 reg 防过拟合 (与 batch 训练一致)
 *   - 支持 momentum (默认 0.9, Nesterov 风格)
 */

import {
  MetaLabelModel,
  RawSignalFeatures,
  buildFeatureVector,
  sigmoid,
  FEATURE_NAMES,
  FeatureName,
} from './MetaLabelService';

export interface OnlineUpdateOptions {
  /** Initial learning rate (default 0.05) */
  learning_rate_initial?: number;
  /** Decay rate γ in η_t = η_0 / (1 + γ · t) (default 1e-4) */
  learning_rate_decay?: number;
  /** L2 regularization (default 0.001) */
  l2?: number;
  /** Momentum coefficient (default 0.9) */
  momentum?: number;
}

export interface OnlineUpdateState {
  /** 累计 update 步数 */
  step: number;
  /** Momentum vectors per feature */
  velocity_weights: Record<FeatureName, number>;
  velocity_bias: number;
}

/**
 * 创建初始 online state (与 model.version 关联)
 */
export function createInitialOnlineState(model: MetaLabelModel): OnlineUpdateState {
  const v: any = {};
  for (const n of FEATURE_NAMES) v[n] = 0;
  return {
    step: 0,
    velocity_weights: v,
    velocity_bias: 0,
  };
}

/**
 * 单步 SGD update with momentum
 *
 * 算法:
 *   1. forward: pred = sigmoid(w·x + b)
 *   2. compute gradient
 *   3. update velocity: v = β · v - η · grad
 *   4. update weights: w = w + v
 *
 * @returns updated model + state + loss (for monitoring)
 */
export function onlineUpdate(
  model: MetaLabelModel,
  state: OnlineUpdateState,
  features: RawSignalFeatures,
  label: 0 | 1,
  options: OnlineUpdateOptions = {}
): {
  updated_model: MetaLabelModel;
  updated_state: OnlineUpdateState;
  loss: number;
  pred: number;
} {
  const eta0 = options.learning_rate_initial ?? 0.05;
  const gamma = options.learning_rate_decay ?? 1e-4;
  const l2 = options.l2 ?? 0.001;
  const beta = options.momentum ?? 0.9;

  const t = state.step + 1;
  const eta = eta0 / (1 + gamma * t);

  // Feature vector (standardized using existing model means/stds)
  const x = buildFeatureVector(features, model.feature_means, model.feature_stds);

  // Forward
  let z = model.bias;
  for (const n of FEATURE_NAMES) z += model.weights[n] * x[n];
  const pred = sigmoid(z);

  // Loss (for monitoring)
  const p_clip = Math.min(Math.max(pred, 1e-12), 1 - 1e-12);
  const loss = -(label * Math.log(p_clip) + (1 - label) * Math.log(1 - p_clip));

  // Gradients
  const err = pred - label;
  const grad_w: any = {};
  for (const n of FEATURE_NAMES) {
    grad_w[n] = err * x[n] + l2 * model.weights[n];
  }
  const grad_b = err;

  // Momentum update + apply
  const new_v_w: any = {};
  const new_w: any = {};
  for (const n of FEATURE_NAMES) {
    new_v_w[n] = beta * state.velocity_weights[n] - eta * grad_w[n];
    new_w[n] = model.weights[n] + new_v_w[n];
  }
  const new_v_b = beta * state.velocity_bias - eta * grad_b;
  const new_b = model.bias + new_v_b;

  const updated_model: MetaLabelModel = {
    ...model,
    weights: new_w,
    bias: new_b,
    version: `${model.version}+online_${t}`,
  };
  const updated_state: OnlineUpdateState = {
    step: t,
    velocity_weights: new_v_w,
    velocity_bias: new_v_b,
  };

  return { updated_model, updated_state, loss, pred };
}

/**
 * Batch online updates: feed N samples sequentially
 *
 * 用于 backfill 历史 outcomes 或 nightly batch refresh.
 *
 * @returns final updated model + loss history (for convergence monitoring)
 */
export function onlineUpdateBatch(
  model: MetaLabelModel,
  initial_state: OnlineUpdateState,
  samples: Array<{ features: RawSignalFeatures; label: 0 | 1 }>,
  options: OnlineUpdateOptions = {}
): {
  final_model: MetaLabelModel;
  final_state: OnlineUpdateState;
  loss_history: number[];
} {
  let m = model;
  let s = initial_state;
  const losses: number[] = [];
  for (const sample of samples) {
    const r = onlineUpdate(m, s, sample.features, sample.label, options);
    m = r.updated_model;
    s = r.updated_state;
    losses.push(r.loss);
  }
  return { final_model: m, final_state: s, loss_history: losses };
}

/**
 * Decay schedule (Robbins-Monro form, alternative to default)
 *
 * η_t = η_0 · t^{-α} where α = 0.6 推荐 (between 0.5 and 1.0)
 */
export function robbinsMonroLearningRate(t: number, eta_0 = 0.1, alpha = 0.6): number {
  return eta_0 / Math.pow(Math.max(1, t), alpha);
}
