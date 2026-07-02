/**
 * ConfidenceCalibrationService (§5.1 confidence 模型) — 信号优先重构 批6
 *
 * 大白话: 每条信号旁显示的 "置信度 X%" 不能用裸胜率 (样本少时噪音大, 且忽略盈亏比会
 * 系统性过度自信). 本 service 用 **Wilson 下界 (90% 置信)** 作 confidence, 并同时算
 * 5 个校准指标 (n_samples / avg_win / avg_loss / profit_factor / brier), 输出
 * reliability bucket 供 UI 展示 + sizing 降权 + 冷启动纸面模式判定.
 *
 * 数据源: recommendation_trade_outcomes (trade_status='closed'), 按 source_type 分组,
 *   与 meta-v2/EVDecisionService 同源同口径 (total_pnl_pct 以百分点存, /100 转 fraction).
 *
 * 窗口: (as_of - 5 天 - 90 天, as_of - 5 天) — 5 天滞后因 forward_return 需 5 天结算.
 * Regime 分层: 同一 detector 牛/熊/震荡表现差异大, 按 regime 分别算 confidence.
 *
 * 只读, 无副作用 (缓存由调用方 / SchedulerService 每日刷一次).
 */

import { Op } from 'sequelize';
import { RecommendationTradeOutcome } from '../../models/RecommendationTradeOutcome';
import { logger } from '../../utils/logger';

/** §5.1 常量. */
export const WILSON_Z = 1.645; // alpha=0.10, 单侧 90% 下界
export const FORWARD_RETURN_LAG_DAYS = 5; // forward_return 结算滞后
export const DEFAULT_LOOKBACK_DAYS = 90;
export const MIN_SAMPLES_FOR_LIVE = 20; // n < 20 -> 纸面模式
export const MIN_SAMPLES_FULL_WEIGHT = 30; // n >= 30 才可能全权重

export type ReliabilityLabel =
  | 'sufficient_stable'
  | 'sufficient_medium'
  | 'sparse_observe'
  | 'sparse_medium'
  | 'insufficient';

export interface ReliabilityBucket {
  label: ReliabilityLabel;
  display: string;
  /** 是否允许进 EV gate 下实盘 (false = 仅纸面) */
  allow_live: boolean;
  /** sizing 乘数 (1 / 0.7 / 0.5 / 0) */
  sizing_multiplier: number;
}

export interface CalibrationMetrics {
  source_type: string;
  regime: string;
  /** Wilson 90% 下界, 0..1 (§5.1 confidence 主口径) */
  confidence: number;
  /** 裸胜率 k/n (仅供对比, 不用于排序) */
  win_rate_raw: number;
  n_samples: number;
  /** 赚钱信号平均收益 (fraction, e.g. 0.05 = 5%) */
  avg_win_pct: number;
  /** 亏钱信号平均亏损 (fraction, 绝对值) */
  avg_loss_pct: number;
  /** sum盈利 / sum亏损, > 1.5 才算稳定 */
  profit_factor: number;
  /** Brier 校准分, 0=完美 0.25=瞎猜 (以 confidence 为预测概率) */
  brier_score: number;
  reliability: ReliabilityBucket;
  /** 窗口起止 (YYYY-MM-DD), UI 显式标注 "基于 X 至 Y" */
  window_start: string;
  window_end: string;
  /** true = 冷启动 / 样本不足, 只跑 paper */
  cold_start: boolean;
}

/** Wilson score interval 下界 (单侧). */
export function wilsonLowerBound(k: number, n: number, z: number = WILSON_Z): number {
  if (n <= 0) return 0;
  const pHat = k / n;
  const denom = 1 + (z * z) / n;
  const center = (pHat + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((pHat * (1 - pHat)) / n + (z * z) / (4 * n * n))) / denom;
  return Math.max(0, center - margin);
}

/** §5.1 reliability bucket 判定表. */
export function classifyReliability(confidence: number, n: number): ReliabilityBucket {
  if (n < MIN_SAMPLES_FOR_LIVE || confidence < 0.3) {
    return {
      label: 'insufficient',
      display: '样本不足或胜率差',
      allow_live: false,
      sizing_multiplier: 0,
    };
  }
  if (n >= MIN_SAMPLES_FULL_WEIGHT) {
    if (confidence >= 0.45) {
      return {
        label: 'sufficient_stable',
        display: '样本充足, 胜率稳定',
        allow_live: true,
        sizing_multiplier: 1,
      };
    }
    return {
      label: 'sufficient_medium',
      display: '样本充足, 胜率中等',
      allow_live: true,
      sizing_multiplier: 0.7,
    };
  }
  // 20 <= n < 30
  if (confidence >= 0.45) {
    return {
      label: 'sparse_observe',
      display: '样本偏少, 建议观察',
      allow_live: true,
      sizing_multiplier: 0.5,
    };
  }
  return {
    label: 'sparse_medium',
    display: '样本偏少且胜率中等',
    allow_live: false,
    sizing_multiplier: 0,
  };
}

interface OutcomeRow {
  total_pnl_pct: number | null;
  metadata: Record<string, any> | null;
}

export interface CalibrationDataSource {
  /**
   * 拉指定窗口内 closed outcome, 按 source_type 过滤 (regime 在内存分层).
   * @returns 每条 { pnl_pct(fraction), regime }
   */
  loadOutcomes(
    sourceType: string,
    windowStart: string,
    windowEnd: string,
    portfolioId?: number
  ): Promise<Array<{ pnl_pct: number; regime: string }>>;
}

/** 从 outcome.metadata 解析 regime (与 EVDecisionService 同源路径). */
function resolveRegime(metadata: Record<string, any> | null): string {
  const meta = metadata || {};
  const signalMeta = meta.signal_metadata || {};
  return (
    (meta.market_environment && meta.market_environment.market_regime) ||
    (signalMeta.market_environment && signalMeta.market_environment.market_regime) ||
    meta.market_regime ||
    'unknown'
  );
}

export const PRODUCTION_CALIBRATION_DATA_SOURCE: CalibrationDataSource = {
  async loadOutcomes(sourceType, windowStart, windowEnd, portfolioId?) {
    const where: any = {
      source_type: sourceType,
      trade_status: 'closed',
      exit_date: { [Op.gte]: windowStart, [Op.lte]: windowEnd },
    };
    if (Number.isFinite(portfolioId) && (portfolioId as number) > 0) {
      where.portfolio_id = portfolioId;
    }
    const rows = (await RecommendationTradeOutcome.findAll({
      where,
      attributes: ['total_pnl_pct', 'metadata'],
      raw: true,
    })) as unknown as OutcomeRow[];
    return rows.map(r => ({
      // total_pnl_pct 以百分点存 (5 = 5%), /100 转 fraction
      pnl_pct: Number(r.total_pnl_pct || 0) / 100,
      regime: resolveRegime(r.metadata),
    }));
  },
};

export interface CalibrationOptions {
  lookbackDays?: number;
  portfolioId?: number;
  /** as-of 日 (默认今天), 窗口 = (as_of - 5 - lookback, as_of - 5) */
  asOfDate?: string;
}

export class ConfidenceCalibrationService {
  constructor(
    private readonly dataSource: CalibrationDataSource = PRODUCTION_CALIBRATION_DATA_SOURCE
  ) {}

  /** 计算窗口起止 (YYYY-MM-DD), end = as_of - 5, start = end - lookback. */
  private resolveWindow(asOfDate: string, lookbackDays: number): { start: string; end: string } {
    const asOf = new Date(`${asOfDate}T00:00:00.000Z`);
    const end = new Date(asOf);
    end.setUTCDate(end.getUTCDate() - FORWARD_RETURN_LAG_DAYS);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - lookbackDays);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  /**
   * 计算某 source_type 在指定 regime 下的完整校准指标 (§5.1).
   * regime='__all__' 表示不分层 (全 regime 混合).
   */
  async calibrate(
    sourceType: string,
    regime: string = '__all__',
    options: CalibrationOptions = {}
  ): Promise<CalibrationMetrics> {
    const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
    const { start, end } = this.resolveWindow(asOfDate, lookbackDays);

    let outcomes: Array<{ pnl_pct: number; regime: string }> = [];
    try {
      outcomes = await this.dataSource.loadOutcomes(sourceType, start, end, options.portfolioId);
    } catch (error: any) {
      logger.warn(
        `ConfidenceCalibration loadOutcomes 失败 (${sourceType}/${regime}): ${
          error?.message || error
        }`
      );
    }

    const filtered =
      regime === '__all__' ? outcomes : outcomes.filter(o => o.regime === regime);
    return this.computeMetrics(sourceType, regime, filtered, start, end);
  }

  /**
   * 一次算全 regime (bull/bear/range) + __all__, 供 §5.1 regime 分层存储.
   */
  async calibrateAllRegimes(
    sourceType: string,
    options: CalibrationOptions = {}
  ): Promise<Record<string, CalibrationMetrics>> {
    const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
    const { start, end } = this.resolveWindow(asOfDate, lookbackDays);

    let outcomes: Array<{ pnl_pct: number; regime: string }> = [];
    try {
      outcomes = await this.dataSource.loadOutcomes(sourceType, start, end, options.portfolioId);
    } catch (error: any) {
      logger.warn(
        `ConfidenceCalibration calibrateAllRegimes 失败 (${sourceType}): ${error?.message || error}`
      );
    }

    const out: Record<string, CalibrationMetrics> = {};
    out.__all__ = this.computeMetrics(sourceType, '__all__', outcomes, start, end);
    for (const regime of ['bull', 'bear', 'range']) {
      out[regime] = this.computeMetrics(
        sourceType,
        regime,
        outcomes.filter(o => o.regime === regime),
        start,
        end
      );
    }
    return out;
  }

  /** 纯计算: outcome 列表 -> 5 指标 + Wilson confidence + bucket. */
  private computeMetrics(
    sourceType: string,
    regime: string,
    outcomes: Array<{ pnl_pct: number; regime: string }>,
    windowStart: string,
    windowEnd: string
  ): CalibrationMetrics {
    const n = outcomes.length;
    const wins = outcomes.filter(o => o.pnl_pct > 0);
    const losses = outcomes.filter(o => o.pnl_pct <= 0);
    const k = wins.length;

    const winRateRaw = n > 0 ? k / n : 0;
    const confidence = wilsonLowerBound(k, n);
    const avgWin = wins.length ? wins.reduce((s, o) => s + o.pnl_pct, 0) / wins.length : 0;
    const avgLoss = losses.length
      ? -losses.reduce((s, o) => s + o.pnl_pct, 0) / losses.length
      : 0;
    const sumWin = wins.reduce((s, o) => s + o.pnl_pct, 0);
    const sumLoss = -losses.reduce((s, o) => s + o.pnl_pct, 0);
    const profitFactor = sumLoss > 1e-9 ? sumWin / sumLoss : sumWin > 0 ? Infinity : 0;

    // Brier: 以 confidence 为预测概率, 实际 outcome=1(win)/0(loss)
    const brier =
      n > 0
        ? outcomes.reduce((s, o) => {
            const actual = o.pnl_pct > 0 ? 1 : 0;
            return s + (confidence - actual) * (confidence - actual);
          }, 0) / n
        : 0.25;

    const reliability = classifyReliability(confidence, n);
    return {
      source_type: sourceType,
      regime,
      confidence,
      win_rate_raw: winRateRaw,
      n_samples: n,
      avg_win_pct: avgWin,
      avg_loss_pct: avgLoss,
      profit_factor: profitFactor,
      brier_score: brier,
      reliability,
      window_start: windowStart,
      window_end: windowEnd,
      cold_start: n < MIN_SAMPLES_FOR_LIVE,
    };
  }
}

export const confidenceCalibrationService = new ConfidenceCalibrationService();
