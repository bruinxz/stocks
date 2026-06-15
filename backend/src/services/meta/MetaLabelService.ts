/**
 * MetaLabelService — Sprint 2A 信号二层决策
 *
 * Marcos Lopez de Prado *AFML* 第 3 章 Meta-Labeling 范式。
 *
 * **背景**：
 *   一层模型（策略 / AI / 推荐池）输出"应该买这个吗？"的 0/1 信号。但很多
 *   信号在某些环境下不该执行：bull regime 的 mean-reversion 信号、low-vol
 *   环境的 breakout 信号、过度交易期的所有信号。
 *
 *   Meta-Labeling 加一个二层模型："给定一层模型说 BUY，且当前 environment
 *   features，下注后 profit > 0 的概率是多少？"
 *
 * **方法**：
 *   - 训练数据: RecommendationTradeOutcome (closed) — label = pnl > 0
 *   - 特征:
 *     - signal_score (一层输出 0-100)
 *     - signal_source_one_hot (quant / ai / recommendation)
 *     - regime_one_hot (bull / bear / range / volatile)
 *     - market_breadth_score (-100..100)
 *     - strategy_recent_winrate_30d
 *     - strategy_recent_payoff_30d
 *     - market_vol_atr (1-10 normalized)
 *   - 模型: logistic regression (自实现 Newton-Raphson 训练)
 *   - 输出: confidence = sigmoid(z) ∈ [0, 1]
 *   - 决策: confidence >= threshold (默认 0.55) → bet
 *
 * **降级**：
 *   - 模型未训练 → fallback 到规则：confidence = signal_score / 100 * regime_multiplier
 *   - 训练样本 < MIN_TRAINING_SAMPLES → 也走 fallback
 *
 * **特征工程关键判定**：
 *   - 所有 numeric 特征会 z-score 标准化（在训练时存 mean/std，预测时复用）
 *   - one-hot 特征不标准化
 *   - bias term 单独加（不参与标准化）
 */

import { Op } from 'sequelize';
import * as fs from 'fs';
import * as path from 'path';
import { MetaLabelDecision } from '../../models/MetaLabelDecision';
import { logger } from '../../utils/logger';

// ============================================================
// Constants
// ============================================================

export const DEFAULT_THRESHOLD = 0.55;
export const MIN_TRAINING_SAMPLES = 30;
export const MAX_TRAINING_ITERATIONS = 100;
export const TRAINING_TOLERANCE = 1e-6;
export const L2_REGULARIZATION = 0.01;

export const FEATURE_NAMES = [
  'signal_score_z',
  'source_quant',
  'source_ai',
  'source_recommendation',
  'regime_bull',
  'regime_bear',
  'regime_range',
  'regime_volatile',
  'breadth_score_z',
  'strategy_winrate_z',
  'strategy_payoff_z',
  'market_atr_z',
  // Sprint 34 (短板 #2b): 成交可行性分作为 MetaLabel 特征
  // 来自上一次 ExecutionFeasibility 该 symbol 7 日均分 (0-100, 0=极差 100=完美).
  // 新模型训练时会自动学这个 dim 权重; 老模型 weights 缺该 key → 默认 0 不破坏.
  'pre_check_feasibility_score_z',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

// ============================================================
// Types
// ============================================================

export interface RawSignalFeatures {
  signal_score: number; // 0-100
  signal_source: 'quant' | 'ai' | 'recommendation' | string;
  regime: 'bull' | 'bear' | 'range' | 'volatile' | string;
  market_breadth_score: number; // -100..100
  strategy_recent_winrate_30d: number; // 0-1
  strategy_recent_payoff_30d: number; // >= 0 (loser/winner ratio)
  market_vol_atr: number; // ATR 1-10 范围 normalized
  /**
   * Sprint 34 (短板 #2b): 该 symbol 近 N 天 ExecutionFeasibility 平均 composite_score
   * (0-100). 缺数据 → 50 (中性). caller (PaperTradingAutomationService) 在调
   * shouldBet 前 query execution_feasibility_records 拿这个值.
   */
  pre_check_feasibility_score?: number;
}

export interface MetaLabelModel {
  /** 模型版本 */
  version: string;
  /** 训练时间 ISO */
  trained_at: string;
  /** 训练样本数 */
  trained_samples: number;
  /** features mean (z-score 用) */
  feature_means: Record<FeatureName, number>;
  /** features std */
  feature_stds: Record<FeatureName, number>;
  /** 权重 vector: { feature_name: weight } */
  weights: Record<FeatureName, number>;
  /** bias term */
  bias: number;
  /** in-sample accuracy */
  insample_accuracy: number;
  /** baseline (predict majority) accuracy 对比 */
  baseline_accuracy: number;
}

export interface TrainingRow {
  features: RawSignalFeatures;
  label: 0 | 1;
}

export interface MetaLabelDecisionInput {
  /** 原始信号 ID */
  signal_id?: number | null;
  signal_source?: string | null;
  symbol: string;
  strategy_key?: string | null;
  as_of_date: string;
  features: RawSignalFeatures;
}

export interface MetaLabelDecisionOptions {
  threshold?: number;
  persist?: boolean;
  model?: MetaLabelModel | null;
}

export interface MetaLabelDecisionResult {
  decision: 'bet' | 'skip';
  confidence: number;
  threshold: number;
  model_version: string;
  top_features: Array<{ name: string; contribution: number; value: number | string }>;
  reason: string;
  persisted_id: number | null;
  generated_at: Date;
}

// ============================================================
// Pure helpers (full export for tests)
// ============================================================

export function sigmoid(z: number): number {
  if (z > 35) return 1;
  if (z < -35) return 0;
  return 1 / (1 + Math.exp(-z));
}

export function safeDiv(num: number, den: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

/**
 * 把 raw features 展开为标准化后的 feature vector
 */
export function buildFeatureVector(
  raw: RawSignalFeatures,
  means: Record<FeatureName, number>,
  stds: Record<FeatureName, number>
): Record<FeatureName, number> {
  const v: any = {};
  const norm = (name: FeatureName, value: number): number => {
    const m = means[name] ?? 0;
    const s = stds[name] ?? 1;
    if (s === 0) return 0;
    return (value - m) / s;
  };
  v.signal_score_z = norm('signal_score_z', raw.signal_score);
  v.source_quant = raw.signal_source === 'quant' ? 1 : 0;
  v.source_ai = raw.signal_source === 'ai' ? 1 : 0;
  v.source_recommendation = raw.signal_source === 'recommendation' ? 1 : 0;
  v.regime_bull = raw.regime === 'bull' ? 1 : 0;
  v.regime_bear = raw.regime === 'bear' ? 1 : 0;
  v.regime_range = raw.regime === 'range' ? 1 : 0;
  v.regime_volatile = raw.regime === 'volatile' ? 1 : 0;
  v.breadth_score_z = norm('breadth_score_z', raw.market_breadth_score);
  v.strategy_winrate_z = norm('strategy_winrate_z', raw.strategy_recent_winrate_30d);
  v.strategy_payoff_z = norm('strategy_payoff_z', raw.strategy_recent_payoff_30d);
  v.market_atr_z = norm('market_atr_z', raw.market_vol_atr);
  // Sprint 34 (短板 #2b): pre-check feasibility score; 缺则 50 (中性), z-score 后 ≈ 0
  v.pre_check_feasibility_score_z = norm(
    'pre_check_feasibility_score_z',
    raw.pre_check_feasibility_score ?? 50
  );
  return v;
}

/**
 * 计算 raw value (未标准化) 的 mean / std
 */
export function computeFeatureStats(rawRows: RawSignalFeatures[]): {
  means: Record<FeatureName, number>;
  stds: Record<FeatureName, number>;
} {
  const means: any = {};
  const stds: any = {};
  // 只 z-score numeric 字段，one-hot 全部 mean=0 std=1 (不参与标准化)
  const zFields: Array<{
    name: FeatureName;
    extract: (r: RawSignalFeatures) => number;
  }> = [
    { name: 'signal_score_z', extract: r => r.signal_score },
    { name: 'breadth_score_z', extract: r => r.market_breadth_score },
    { name: 'strategy_winrate_z', extract: r => r.strategy_recent_winrate_30d },
    { name: 'strategy_payoff_z', extract: r => r.strategy_recent_payoff_30d },
    { name: 'market_atr_z', extract: r => r.market_vol_atr },
    // Sprint 34: 新 feature; 训练时该 dim 也参与 z-score 标准化
    { name: 'pre_check_feasibility_score_z', extract: r => r.pre_check_feasibility_score ?? 50 },
  ];
  for (const f of zFields) {
    const vals = rawRows.map(f.extract).filter(v => Number.isFinite(v));
    const m = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    const variance =
      vals.length > 1
        ? vals.reduce((s, v) => s + (v - m) * (v - m), 0) / (vals.length - 1)
        : 1;
    means[f.name] = m;
    stds[f.name] = Math.sqrt(Math.max(variance, 1e-9));
  }
  // one-hot defaults
  for (const n of FEATURE_NAMES) {
    if (!(n in means)) {
      means[n] = 0;
      stds[n] = 1;
    }
  }
  return { means, stds };
}

/**
 * 训练 logistic regression with L2 (gradient descent)
 *
 * 因 feature 维度小 (12)、样本量小 (几十到几百)、追求快速训练，用纯 GD 即可。
 */
export function trainLogisticRegression(
  rows: TrainingRow[],
  options: { max_iter?: number; learning_rate?: number; l2?: number; tolerance?: number } = {}
): MetaLabelModel {
  const max_iter = options.max_iter ?? MAX_TRAINING_ITERATIONS;
  const learning_rate = options.learning_rate ?? 0.1;
  const l2 = options.l2 ?? L2_REGULARIZATION;
  const tolerance = options.tolerance ?? TRAINING_TOLERANCE;

  if (rows.length < MIN_TRAINING_SAMPLES) {
    throw new Error(`trainLogisticRegression: 训练样本 ${rows.length} < ${MIN_TRAINING_SAMPLES}`);
  }

  const { means, stds } = computeFeatureStats(rows.map(r => r.features));

  // 初始化 weights 全 0
  const weights: any = {};
  for (const n of FEATURE_NAMES) weights[n] = 0;
  let bias = 0;

  // 预先把所有样本的 feature vector 算出来
  const xMatrix: Array<Record<FeatureName, number>> = rows.map(r =>
    buildFeatureVector(r.features, means, stds)
  );
  const yLabels = rows.map(r => r.label);
  const N = rows.length;

  let prevLoss = Infinity;
  for (let iter = 0; iter < max_iter; iter += 1) {
    // forward: predictions
    const preds = xMatrix.map(x => {
      let z = bias;
      for (const n of FEATURE_NAMES) z += weights[n] * x[n];
      return sigmoid(z);
    });

    // loss (cross-entropy + L2)
    let loss = 0;
    for (let i = 0; i < N; i += 1) {
      const p = Math.min(Math.max(preds[i], 1e-12), 1 - 1e-12);
      loss += -(yLabels[i] * Math.log(p) + (1 - yLabels[i]) * Math.log(1 - p));
    }
    loss /= N;
    for (const n of FEATURE_NAMES) loss += (l2 / 2) * weights[n] * weights[n];

    if (Math.abs(prevLoss - loss) < tolerance) break;
    prevLoss = loss;

    // grads
    const grads: any = {};
    for (const n of FEATURE_NAMES) grads[n] = 0;
    let biasGrad = 0;
    for (let i = 0; i < N; i += 1) {
      const err = preds[i] - yLabels[i];
      biasGrad += err;
      for (const n of FEATURE_NAMES) grads[n] += err * xMatrix[i][n];
    }
    // L2 reg + averaging
    for (const n of FEATURE_NAMES) {
      grads[n] = grads[n] / N + l2 * weights[n];
      weights[n] -= learning_rate * grads[n];
    }
    bias -= learning_rate * (biasGrad / N);
  }

  // in-sample accuracy
  const finalPreds = xMatrix.map(x => {
    let z = bias;
    for (const n of FEATURE_NAMES) z += weights[n] * x[n];
    return sigmoid(z);
  });
  const correct = finalPreds.filter((p, i) => (p >= 0.5 ? 1 : 0) === yLabels[i]).length;
  const insample_accuracy = correct / N;
  const major = yLabels.filter(y => y === 1).length / N;
  const baseline_accuracy = Math.max(major, 1 - major);

  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10);

  return {
    version: `v1-logistic-${dateStr}`,
    trained_at: date.toISOString(),
    trained_samples: N,
    feature_means: means,
    feature_stds: stds,
    weights,
    bias,
    insample_accuracy: Math.round(insample_accuracy * 10000) / 10000,
    baseline_accuracy: Math.round(baseline_accuracy * 10000) / 10000,
  };
}

/**
 * 用模型预测 confidence
 */
export function predictConfidence(model: MetaLabelModel, raw: RawSignalFeatures): {
  confidence: number;
  contributions: Array<{ name: FeatureName; contribution: number; value: number }>;
} {
  const x = buildFeatureVector(raw, model.feature_means, model.feature_stds);
  let z = model.bias;
  const contributions: Array<{ name: FeatureName; contribution: number; value: number }> = [];
  for (const n of FEATURE_NAMES) {
    const c = model.weights[n] * x[n];
    z += c;
    contributions.push({ name: n, contribution: c, value: x[n] });
  }
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return {
    confidence: sigmoid(z),
    contributions,
  };
}

/**
 * 无模型时的 fallback 规则
 *   confidence = (signal_score / 100) × regime_multiplier
 *   regime_multiplier:
 *     - bull: 1.10
 *     - range: 1.00
 *     - volatile: 0.85
 *     - bear: 0.70
 *   再 cap [0.05, 0.95] 避免极端
 */
export function fallbackConfidence(raw: RawSignalFeatures): {
  confidence: number;
  reason: string;
} {
  const base = Math.max(0, Math.min(1, raw.signal_score / 100));
  const mult =
    raw.regime === 'bull' ? 1.1 : raw.regime === 'range' ? 1.0 : raw.regime === 'volatile' ? 0.85 : 0.7;
  const c = Math.max(0.05, Math.min(0.95, base * mult));
  return {
    confidence: c,
    reason: `fallback (signal_score=${raw.signal_score}, regime=${raw.regime}, mult=${mult})`,
  };
}

// ============================================================
// Service
// ============================================================

export class MetaLabelService {
  private currentModel: MetaLabelModel | null = null;

  constructor() {
    // 启动时从 disk 自动加载模型（如果存在）
    this.tryLoadModelFromDisk();
  }

  /**
   * 默认模型 disk 路径 (CLI train-meta-label 写入此文件)
   */
  private getDefaultModelPath(): string {
    return path.resolve(__dirname, '../../../data/meta-label-model.json');
  }

  /**
   * 启动时尝试从 disk 加载持久化的模型 (CLI train 完后写到 data/meta-label-model.json)
   */
  private tryLoadModelFromDisk(filePath?: string): void {
    const p = filePath || this.getDefaultModelPath();
    try {
      if (!fs.existsSync(p)) {
        logger.info(`[meta-label] no disk model at ${p}, fallback rule will be used`);
        return;
      }
      const raw = fs.readFileSync(p, 'utf8');
      const m = JSON.parse(raw) as MetaLabelModel;
      if (!m.version || !m.weights || !m.feature_means) {
        logger.warn(`[meta-label] disk model ${p} invalid schema, ignored`);
        return;
      }
      this.currentModel = m;
      logger.info(
        `[meta-label] loaded disk model: ${m.version} (acc=${m.insample_accuracy}, samples=${m.trained_samples})`
      );
    } catch (err: any) {
      logger.warn(`[meta-label] failed to load disk model from ${p}: ${err?.message}`);
    }
  }

  /**
   * 重新从 disk 加载（CLI 训练完后调用此方法可热更新）
   */
  reloadFromDisk(filePath?: string): boolean {
    this.tryLoadModelFromDisk(filePath);
    return this.currentModel !== null;
  }

  /**
   * 替换当前激活模型（CLI / admin endpoint 训练完后调用）
   */
  setModel(model: MetaLabelModel | null): void {
    this.currentModel = model;
    logger.info(`[meta-label] model updated to ${model?.version ?? 'NULL'}`);
  }

  getModel(): MetaLabelModel | null {
    return this.currentModel;
  }

  /**
   * 训练新模型
   */
  async train(rows: TrainingRow[]): Promise<MetaLabelModel> {
    const m = trainLogisticRegression(rows);
    this.setModel(m);
    return m;
  }

  /**
   * 主决策接口: 给一个候选信号 → bet / skip + confidence
   */
  async shouldBet(
    input: MetaLabelDecisionInput,
    options: MetaLabelDecisionOptions = {}
  ): Promise<MetaLabelDecisionResult> {
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    const persist = options.persist === true;
    const model = options.model ?? this.currentModel;

    let confidence: number;
    let topFeatures: Array<{ name: string; contribution: number; value: number | string }>;
    let model_version: string;
    let reason: string;

    if (model) {
      const { confidence: c, contributions } = predictConfidence(model, input.features);
      confidence = c;
      topFeatures = contributions.slice(0, 5).map(co => ({
        name: co.name,
        contribution: Math.round(co.contribution * 1000) / 1000,
        value: Math.round(co.value * 1000) / 1000,
      }));
      model_version = model.version;
      reason = `${model.version} (in-sample acc=${model.insample_accuracy}, samples=${model.trained_samples})`;
    } else {
      const { confidence: c, reason: r } = fallbackConfidence(input.features);
      confidence = c;
      model_version = 'fallback-rule';
      reason = r;
      topFeatures = [
        { name: 'signal_score', contribution: input.features.signal_score / 100, value: input.features.signal_score },
        { name: 'regime', contribution: 0, value: input.features.regime },
      ];
    }

    const decision: 'bet' | 'skip' = confidence >= threshold ? 'bet' : 'skip';

    const result: MetaLabelDecisionResult = {
      decision,
      confidence: Math.round(confidence * 10000) / 10000,
      threshold,
      model_version,
      top_features: topFeatures,
      reason,
      persisted_id: null,
      generated_at: new Date(),
    };

    if (persist) {
      try {
        const row = await MetaLabelDecision.create({
          signal_id: input.signal_id ?? null,
          signal_source: input.signal_source ?? null,
          symbol: input.symbol,
          strategy_key: input.strategy_key ?? null,
          as_of_date: input.as_of_date,
          original_score: input.features.signal_score,
          confidence: result.confidence,
          decision: result.decision,
          model_version: result.model_version,
          threshold: result.threshold,
          top_features_json: result.top_features,
          reason: result.reason,
          metadata: { features: input.features },
        });
        result.persisted_id = row.id;
      } catch (err: any) {
        logger.warn(`[meta-label] persist failed: ${err?.message}`);
      }
    }

    return result;
  }

  async listRecent(limit = 50, filters: { decision?: string; strategy_key?: string } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const where: any = {};
    if (filters.decision) where.decision = filters.decision;
    if (filters.strategy_key) where.strategy_key = filters.strategy_key;
    return MetaLabelDecision.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: safeLimit,
    });
  }

  async cleanupOlderThan(days: number) {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const deleted = await MetaLabelDecision.destroy({ where: { created_at: { [Op.lt]: cutoff } } });
    return { deleted };
  }
}

export const metaLabelService = new MetaLabelService();
