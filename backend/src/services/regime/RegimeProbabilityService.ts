/**
 * Sprint 42-C: RegimeProbabilityService — 把硬分类 regime 升级成概率分布
 *
 * 问题: MarketEnvironmentService 当前返回硬分类 'bull'/'bear'/'range'/'volatile',
 * 在 regime 切换的边界期 (例如从 bull 转 volatile 的过渡日) 容易误判, 让交易
 * 系统在低置信环境下满仓.
 *
 * 解决: 给当前市场 returns 窗口的 (mean, std) 跟 4 个 regime 模板的 (mean, std)
 * 算 Gaussian likelihood, 用 softmax 输出概率分布. 业务方按 max_prob 决定:
 *   - max_prob >= 0.7 → 高置信, 用 hard regime
 *   - 0.5 <= max_prob < 0.7 → 中置信, position × 0.7
 *   - max_prob < 0.5 → 低置信, position × 0.4 (regime 不明确时收缩仓位)
 *
 * 不引外部 HMM 包 (hmmlearn / etc.), 用 Gaussian Mixture 简化:
 *   - 4 个 regime 各有 1 个 fixed Gaussian (mean, std) 模板
 *   - 给当前 (mean_return, std_return) 算 P(observation | regime_k)
 *   - softmax 出 P(regime_k | observation) (假设 uniform prior)
 *
 * 完整 HMM (transition matrix + Viterbi) 留给 future sprint, 这里先把"概率化"
 * 接入到下单链路.
 *
 * 设计要点:
 *   1. **纯函数**: classifyRegimeProbability(returns) → 4 个概率 + max + confidence
 *   2. **regime 模板可配**: DEFAULT_REGIME_TEMPLATES 可被 caller override
 *   3. **fail-open**: 数据不足 → 返回 uniform 0.25 × 4 + confidence=0
 *   4. **不破坏现有 MarketEnvironmentService**: 仅"额外"层, 业务可选用
 */

import { logger } from '../../utils/logger';

// ===========================================================================
// Constants
// ===========================================================================

export type RegimeName = 'bull' | 'bear' | 'range' | 'volatile';

export interface RegimeTemplate {
  /** 期望日收益 (decimal, 0.005 = +0.5%) */
  mean_return: number;
  /** 期望日收益标准差 (decimal, 0.012 = 1.2%) */
  std_return: number;
}

/**
 * 4 个 regime 的高斯模板 (A 股历史经验值, 可被 override).
 *   bull:     mean +0.1%, std 1.0% — 慢牛
 *   bear:     mean -0.15%, std 1.3% — 阴跌
 *   range:    mean 0%, std 0.8% — 震荡
 *   volatile: mean 0%, std 2.0% — 高波动
 */
export const DEFAULT_REGIME_TEMPLATES: Record<RegimeName, RegimeTemplate> = Object.freeze({
  bull: { mean_return: 0.001, std_return: 0.01 },
  bear: { mean_return: -0.0015, std_return: 0.013 },
  range: { mean_return: 0, std_return: 0.008 },
  volatile: { mean_return: 0, std_return: 0.02 },
}) as Record<RegimeName, RegimeTemplate>;

// ===========================================================================
// Pure helpers
// ===========================================================================

/**
 * Gaussian PDF: f(x | mu, sigma) = 1/(sigma √(2π)) × exp(-(x-mu)²/(2σ²))
 */
export function gaussianPdf(x: number, mu: number, sigma: number): number {
  if (sigma <= 0) return 0;
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
}

/**
 * Softmax 一组 likelihood → 概率分布. 避免大数溢出: 减去 max.
 */
export function softmax(values: number[]): number[] {
  if (!values.length) return [];
  const max = Math.max(...values);
  const exps = values.map(v => Math.exp(v - max));
  const sum = exps.reduce((s, v) => s + v, 0);
  if (sum === 0) {
    // 全 -Inf → uniform fallback
    return new Array(values.length).fill(1 / values.length);
  }
  return exps.map(v => v / sum);
}

/**
 * 算 returns 数组的样本均值 / 标准差.
 */
export function sampleStats(returns: number[]): { mean: number; std: number } {
  if (returns.length < 2) return { mean: 0, std: 0 };
  let s = 0;
  for (const r of returns) s += r;
  const mean = s / returns.length;
  let sq = 0;
  for (const r of returns) sq += (r - mean) ** 2;
  const std = Math.sqrt(sq / (returns.length - 1));
  return { mean, std };
}

// ===========================================================================
// Main API
// ===========================================================================

export interface RegimeProbabilityResult {
  /** 4 个 regime 的概率分布 (sum = 1) */
  probabilities: Record<RegimeName, number>;
  /** 最高概率的 regime */
  argmax_regime: RegimeName;
  /** 最高概率 (0..1) */
  max_probability: number;
  /**
   * Confidence 级别 (基于 max_probability):
   *   high   (>= 0.7): 高置信, 用 hard regime
   *   medium (0.5-0.7): 中置信, 仓位 × 0.7
   *   low    (< 0.5): 低置信, 仓位 × 0.4
   *   none   (数据不足): uniform 分布, 仓位 × 0.0
   */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** 业务方应用到 position pct 的倍数 */
  recommended_position_multiplier: number;
  /** 观测的 returns 统计 */
  observation: { mean: number; std: number; sample_count: number };
  reason: string;
}

/**
 * 给最近 N 日 returns 算 4 个 regime 的概率分布.
 *
 * 算法:
 *   1. 算 observation: (sample_mean, sample_std)
 *   2. 用 sample_mean 作 x 给每个 regime 算 Gaussian likelihood (用 regime
 *      模板的 mu/sigma, 但 sigma 用 observation_std 矫正避免边界)
 *   3. softmax 出概率
 *   4. 按 max_prob 算 confidence + position_multiplier
 *
 * 退化:
 *   - sample_count < 5 → uniform 0.25 × 4, confidence='none', multiplier=0
 *   - 全 NaN/Infinity → 同上
 */
export function classifyRegimeProbability(
  returns: number[],
  templates: Record<RegimeName, RegimeTemplate> = DEFAULT_REGIME_TEMPLATES
): RegimeProbabilityResult {
  const cleaned = returns.filter(r => Number.isFinite(r));
  const MIN_SAMPLES = 5;
  if (cleaned.length < MIN_SAMPLES) {
    return {
      probabilities: { bull: 0.25, bear: 0.25, range: 0.25, volatile: 0.25 },
      argmax_regime: 'range',
      max_probability: 0.25,
      confidence: 'none',
      recommended_position_multiplier: 0,
      observation: { mean: 0, std: 0, sample_count: cleaned.length },
      reason: `样本不足 (${cleaned.length} < ${MIN_SAMPLES}), 返回 uniform, 仓位 ×0`,
    };
  }
  const { mean: obsMean, std: obsStd } = sampleStats(cleaned);

  // 每个 regime 算 likelihood
  const regimes: RegimeName[] = ['bull', 'bear', 'range', 'volatile'];
  // 用 log-likelihood 给 softmax (数值稳定)
  const logLikelihoods = regimes.map(r => {
    const t = templates[r];
    // 用 mean 作 likelihood evidence (核心信号)
    // sigma 用 template.std 但若 obs_std 远大于 template.std 则惩罚 (volatile 优先)
    const sigmaEff = Math.max(t.std_return, obsStd * 0.5);
    const pdfMean = gaussianPdf(obsMean, t.mean_return, sigmaEff);
    // 额外因子: obs_std 与 template std 接近度
    const stdMatch = Math.exp(
      -0.5 * ((obsStd - t.std_return) / Math.max(t.std_return, 0.001)) ** 2
    );
    return Math.log(Math.max(pdfMean * stdMatch, 1e-300));
  });
  const probs = softmax(logLikelihoods);

  const probabilities: Record<RegimeName, number> = {
    bull: probs[0],
    bear: probs[1],
    range: probs[2],
    volatile: probs[3],
  };
  let argmax: RegimeName = 'range';
  let max = 0;
  for (const r of regimes) {
    if (probabilities[r] > max) {
      max = probabilities[r];
      argmax = r;
    }
  }
  const confidence: RegimeProbabilityResult['confidence'] =
    max >= 0.7 ? 'high' : max >= 0.5 ? 'medium' : 'low';
  const multiplier = confidence === 'high' ? 1 : confidence === 'medium' ? 0.7 : 0.4;

  return {
    probabilities,
    argmax_regime: argmax,
    max_probability: max,
    confidence,
    recommended_position_multiplier: multiplier,
    observation: { mean: obsMean, std: obsStd, sample_count: cleaned.length },
    reason: `regime=${argmax} p=${(max * 100).toFixed(0)}% [${confidence}] obs(mean=${(
      obsMean * 100
    ).toFixed(2)}%, std=${(obsStd * 100).toFixed(2)}%) → 仓位 ×${multiplier}`,
  };
}

// ===========================================================================
// DataSource (可选, 用于直接从 DailyBar 拉 benchmark returns)
// ===========================================================================

export interface RegimeProbabilityDataSource {
  /**
   * 拉 benchmark (默认沪深 300) 近 N 日的 daily returns.
   * 返回 [] 表示数据缺.
   */
  loadBenchmarkReturns(lookback_days: number, as_of_date: string): Promise<number[]>;
}

export const PRODUCTION_REGIME_PROBABILITY_DATA_SOURCE: RegimeProbabilityDataSource = {
  async loadBenchmarkReturns(lookback_days, as_of_date) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../../models/DailyBar');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      // 沪深 300 = sh.000300
      const benchmark = await Stock.findOne({
        where: { symbol: { [Op.or]: ['sh.000300', '000300.SH', '000300'] } },
        attributes: ['id'],
      });
      if (!benchmark) {
        logger.warn('RegimeProbability: benchmark sh.000300 不存在');
        return [];
      }
      const end = new Date(`${as_of_date}T23:59:59.999Z`);
      const start = new Date(end);
      start.setDate(start.getDate() - lookback_days * 2); // 留 buffer 覆盖节假日
      const bars = await DailyBar.findAll({
        where: { stock_id: (benchmark as any).id, time: { [Op.between]: [start, end] } },
        attributes: ['time', 'close'],
        order: [['time', 'ASC']],
        limit: lookback_days + 1,
        raw: true,
      });
      if (bars.length < 2) return [];
      const returns: number[] = [];
      for (let i = 1; i < bars.length; i++) {
        const prev = Number((bars[i - 1] as any).close);
        const curr = Number((bars[i] as any).close);
        if (Number.isFinite(prev) && Number.isFinite(curr) && prev > 0) {
          returns.push(curr / prev - 1);
        }
      }
      return returns;
    } catch (error: any) {
      logger.warn(`RegimeProbability loadBenchmarkReturns 失败: ${error?.message || error}`);
      return [];
    }
  },
};

// ===========================================================================
// Service
// ===========================================================================

export class RegimeProbabilityService {
  constructor(
    private dataSource: RegimeProbabilityDataSource = PRODUCTION_REGIME_PROBABILITY_DATA_SOURCE
  ) {}

  /**
   * 主入口: 拉 benchmark returns + 计算 regime 概率分布.
   */
  async classify(input: {
    lookback_days?: number;
    as_of_date?: string;
    /** 直接传 returns 跳过 DB 查询 (单测用) */
    returns_override?: number[];
  }): Promise<RegimeProbabilityResult> {
    let returns: number[];
    if (input.returns_override) {
      returns = input.returns_override;
    } else {
      const lookback = input.lookback_days ?? 60;
      const asOf = input.as_of_date || new Date().toISOString().slice(0, 10);
      returns = await this.dataSource.loadBenchmarkReturns(lookback, asOf);
    }
    return classifyRegimeProbability(returns);
  }
}

export const regimeProbabilityService = new RegimeProbabilityService();
