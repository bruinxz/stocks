/**
 * SourceTypeWinRateAdjuster — PR-M3 (2026-06-29) PR-K hotfix
 *
 * 背景 (PR-K 实证发现):
 *   现有 confidence_score = 因子打分总和 + 评级权重. PR-K backtest 复盘发现高 conf
 *   推荐 win 30% < 低 conf win 40% — 反向. 根因: 因子方向反了 / 阈值反了 / sample bias.
 *
 * 临时方案 (此处实现):
 *   1. 算每个 source_type (analysis_engine / quant_recommendation / tradingagents) 近 N 天的
 *      历史 win_rate (close 单已结的 RecommendationTradeOutcome.realized_pnl_pct > 0).
 *   2. 若该 source_type win < 50% → "反向" — 在 V3 返回前把 raw_conf 转成 (100 - raw_conf).
 *      让高 conf (原来反向预测) 落到低位, 低 conf (原来误标但其实方向对) 浮到高位.
 *   3. 每次调整都 logger.info(原值 / 修正值 / 缘由) 记录, 留 audit trail; 同时返回的
 *      decision 对象里塞 confidence_score_raw / confidence_score_adjusted / adjustment_reason
 *      三字段, 前端 / paper trading 可见.
 *
 * 长远方案 (本 PR 不做):
 *   - 重写因子 / 校准 confidence_score (PR-M4+ 计划)
 *   - 加 cross-validation 防过拟合
 *
 * Cache 设计:
 *   - 每个 source_type 的 win_rate 5min TTL (避免每 enrich 都打 DB)
 *   - global singleton — V3 controller 共享一个实例
 *   - cache miss 时 fail-open: 返 null, V3 不动 raw conf (保守不"乱反")
 *
 * fail-OPEN:
 *   - DB query throw → cache 不更新, 返 null, V3 透传 raw conf
 *   - sample size < 阈值 (默认 10 条) → 返 null (统计不显著, 不修正)
 */

import { logger } from '../utils/logger';
import { ensureModelsRegistered } from '../config/database';

// PR-Q (2026-06-30): cold-path Model not initialized hot-fix (AR-1 范式).
ensureModelsRegistered();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceWinRateStats {
  source_type: string;
  /** 已结样本数 (close 单) */
  sample_size: number;
  /** 0..1 */
  win_rate: number;
  /** 修正前 raw conf 取负 / 不取负 */
  should_invert: boolean;
  /** 抓取时间 (cache TTL 判断) */
  computed_at: number;
}

export interface ConfidenceAdjustmentResult {
  /** 原始 conf (来源: ai_investment_signals.confidence_score) */
  confidence_score_raw: number | null;
  /** 修正后 conf — should_invert=true 时取 100 - raw, 否则 == raw */
  confidence_score_adjusted: number | null;
  /** 触发修正的原因. 'no_adjustment' = 无修正 / 'inverted_source_winrate' = 反向 */
  adjustment_reason: 'no_adjustment' | 'inverted_source_winrate' | 'insufficient_samples' | 'no_data';
  /** 当时该 source 的 win_rate (0..1), null = 数据不足 */
  source_win_rate: number | null;
  /** 当时该 source 的样本数 */
  source_sample_size: number;
}

export interface WinRateDataSource {
  /**
   * 给定 source_type + 近 N 天, 返 [n_close, n_win] (close 含已结所有 trade, win = realized_pnl_pct > 0).
   * Throws → caller 视为 null (fail-open).
   */
  fetchSourceTypeWinRate(
    source_type: string,
    lookbackDays: number
  ): Promise<{ n_close: number; n_win: number }>;
}

// ---------------------------------------------------------------------------
// Constants (export for tests)
// ---------------------------------------------------------------------------

/** Cache TTL (毫秒). 5 分钟 = 平衡 freshness + DB load. */
export const WIN_RATE_CACHE_TTL_MS = 5 * 60 * 1000;

/** Win rate 低于此阈值 → 反向 raw conf */
export const WIN_RATE_INVERT_THRESHOLD = 0.5;

/** 最小样本数. < 此值 → 不修正 (统计不显著). */
export const WIN_RATE_MIN_SAMPLE = 10;

/** 默认回溯天数 — 30 天给足 sample 但不太老. */
export const WIN_RATE_LOOKBACK_DAYS = 30;

// ---------------------------------------------------------------------------
// Pure helpers (全 export 单测)
// ---------------------------------------------------------------------------

/**
 * 给定 raw conf + should_invert, 返修正后 conf. raw=null → null.
 * Invert 公式: 100 - raw (clamp 到 [0, 100]).
 */
export function applyInversion(rawConf: number | null, shouldInvert: boolean): number | null {
  if (rawConf == null || !Number.isFinite(rawConf)) return null;
  const clamped = Math.max(0, Math.min(100, Number(rawConf)));
  if (!shouldInvert) return clamped;
  return Math.round((100 - clamped) * 100) / 100;
}

/**
 * 给定 stats + raw conf, 返完整 adjustment result.
 * stats=null → no_data / insufficient_samples → 不修正.
 */
export function computeAdjustment(
  rawConf: number | null,
  stats: SourceWinRateStats | null
): ConfidenceAdjustmentResult {
  if (!stats) {
    return {
      confidence_score_raw: rawConf,
      confidence_score_adjusted: rawConf,
      adjustment_reason: 'no_data',
      source_win_rate: null,
      source_sample_size: 0,
    };
  }
  if (stats.sample_size < WIN_RATE_MIN_SAMPLE) {
    return {
      confidence_score_raw: rawConf,
      confidence_score_adjusted: rawConf,
      adjustment_reason: 'insufficient_samples',
      source_win_rate: stats.win_rate,
      source_sample_size: stats.sample_size,
    };
  }
  if (!stats.should_invert) {
    return {
      confidence_score_raw: rawConf,
      confidence_score_adjusted: rawConf,
      adjustment_reason: 'no_adjustment',
      source_win_rate: stats.win_rate,
      source_sample_size: stats.sample_size,
    };
  }
  return {
    confidence_score_raw: rawConf,
    confidence_score_adjusted: applyInversion(rawConf, true),
    adjustment_reason: 'inverted_source_winrate',
    source_win_rate: stats.win_rate,
    source_sample_size: stats.sample_size,
  };
}

// ---------------------------------------------------------------------------
// Production DataSource (lazy require)
// ---------------------------------------------------------------------------

class DefaultWinRateDataSource implements WinRateDataSource {
  async fetchSourceTypeWinRate(
    source_type: string,
    lookbackDays: number
  ): Promise<{ n_close: number; n_win: number }> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RecommendationTradeOutcome } = require('../models/RecommendationTradeOutcome');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op, fn, col, literal } = require('sequelize');
      const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const cutoffDate = cutoff.toISOString().slice(0, 10);
      const rows: any[] = await RecommendationTradeOutcome.findAll({
        attributes: [
          [fn('COUNT', col('id')), 'n_close'],
          [
            fn(
              'SUM',
              literal('CASE WHEN realized_pnl_pct > 0 THEN 1 ELSE 0 END')
            ),
            'n_win',
          ],
        ],
        where: {
          source_type,
          trade_status: 'closed',
          exit_date: { [Op.gte]: cutoffDate },
        },
        raw: true,
      });
      const r = rows && rows.length > 0 ? rows[0] : null;
      const n_close = Number(r?.n_close ?? 0);
      const n_win = Number(r?.n_win ?? 0);
      return { n_close, n_win };
    } catch (e: any) {
      logger.warn(
        `[SourceTypeWinRateAdjuster] fetchSourceTypeWinRate(${source_type}) failed: ${e?.message || e}`
      );
      throw e;
    }
  }
}

export const DEFAULT_WIN_RATE_DATA_SOURCE: WinRateDataSource = new DefaultWinRateDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface SourceTypeWinRateAdjusterDeps {
  dataSource?: WinRateDataSource;
  /** 测试 — 覆盖 now */
  now?: () => number;
}

export class SourceTypeWinRateAdjuster {
  private readonly ds: WinRateDataSource;
  private readonly nowFn: () => number;
  private cache = new Map<string, SourceWinRateStats>();

  constructor(deps: SourceTypeWinRateAdjusterDeps = {}) {
    this.ds = deps.dataSource ?? DEFAULT_WIN_RATE_DATA_SOURCE;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  /** 给定 source_type, 拉 (or 用 cache) 该 source 的 win_rate stats. fail-open 返 null. */
  async getStats(
    source_type: string,
    lookbackDays: number = WIN_RATE_LOOKBACK_DAYS
  ): Promise<SourceWinRateStats | null> {
    if (!source_type) return null;
    const cached = this.cache.get(source_type);
    const now = this.nowFn();
    if (cached && now - cached.computed_at < WIN_RATE_CACHE_TTL_MS) return cached;
    try {
      const { n_close, n_win } = await this.ds.fetchSourceTypeWinRate(source_type, lookbackDays);
      const win_rate = n_close > 0 ? n_win / n_close : 0;
      const stats: SourceWinRateStats = {
        source_type,
        sample_size: n_close,
        win_rate,
        should_invert: n_close >= WIN_RATE_MIN_SAMPLE && win_rate < WIN_RATE_INVERT_THRESHOLD,
        computed_at: now,
      };
      this.cache.set(source_type, stats);
      return stats;
    } catch {
      // fail-open: 返 null (V3 保守不修正)
      return null;
    }
  }

  /** 主入口: 给定 raw conf + source_type, 返 adjustment result (含 log). */
  async adjust(rawConf: number | null, source_type: string): Promise<ConfidenceAdjustmentResult> {
    const stats = await this.getStats(source_type);
    const result = computeAdjustment(rawConf, stats);
    if (result.adjustment_reason === 'inverted_source_winrate') {
      logger.info(
        `[SourceTypeWinRateAdjuster] INVERT source=${source_type} raw=${result.confidence_score_raw} ` +
          `adjusted=${result.confidence_score_adjusted} win_rate=${(result.source_win_rate || 0).toFixed(3)} ` +
          `samples=${result.source_sample_size}`
      );
    }
    return result;
  }

  /** 清空 cache — 单测 / 手动刷新用 */
  clearCache(): void {
    this.cache.clear();
  }
}

export const sourceTypeWinRateAdjuster = new SourceTypeWinRateAdjuster();
