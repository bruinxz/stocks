/**
 * Sprint 41-B: EVDecisionService — 期望值 (Expected Value) 决策
 *
 * 从"高分 → 买"升级为"正期望 + 可执行 + 组合需要 → 买":
 *
 *   EV = win_prob × avg_win - loss_prob × avg_loss - cost
 *
 *   其中:
 *     - win_prob = 经 IsotonicCalibrator 校准的概率
 *     - loss_prob = 1 - win_prob
 *     - avg_win  = 该策略 + 该 regime 下历史平均盈利 % (winning trades 的 pnl_pct 均值)
 *     - avg_loss = 该策略 + 该 regime 下历史平均亏损 % (losing trades 的 pnl_pct 绝对值均值)
 *     - cost     = 估算的交易成本 % (commission + slippage + impact)
 *
 *   decision:
 *     - EV >= min_ev_threshold  → bet (推荐入场, 按 EV/avg_win 决定仓位)
 *     - EV < min_ev_threshold   → skip
 *
 * 设计要点:
 *   1. **per-(strategy, regime) avg_win / avg_loss**: 不同策略 + 市场环境下盈亏分布
 *      不同, 全局均值会让趋势策略在牛市被低估 / 反转策略在熊市被高估.
 *   2. **avg_win / avg_loss 缺数据 fallback**: 历史样本 < min_samples 时 fallback 到
 *      全局均值 (再缺 fallback 到 5% / 3% 默认), 不让新策略首次跑就被 EV gate 全部 skip.
 *   3. **cost 估算**: 默认 0.3% (commission 0.025% × 2 + slippage 0.05% × 2 + impact 0.05%).
 *      Sprint 41-E ExecutionPolicyRouter 上线后可以传 dynamic cost.
 *   4. **min_ev_threshold = 0.005 (0.5%)**: 期望盈利 < 0.5% 不下注, 留 buffer 给执行误差.
 *   5. **纯函数 + DataSource DI**: helper 全 export, 测试脱 DB.
 */

import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_EV_OPTIONS: EVDecisionOptions = Object.freeze({
  /** 默认估算成本 % (0.003 = 0.3%) */
  default_cost_pct: 0.003,
  /** 历史样本不足时全局 fallback avg_win % */
  fallback_avg_win_pct: 0.05,
  /** 历史样本不足时全局 fallback avg_loss % */
  fallback_avg_loss_pct: 0.03,
  /** 最少样本数, 不足走 fallback */
  min_samples_for_stats: 10,
  /** EV >= 此阈值才 bet (默认 0.5%) */
  min_ev_threshold: 0.005,
  /** Lookback 自然日 (拉历史 outcome 算 avg_win/loss) */
  lookback_days: 180,
}) as EVDecisionOptions;

export interface EVDecisionOptions {
  default_cost_pct: number;
  fallback_avg_win_pct: number;
  fallback_avg_loss_pct: number;
  min_samples_for_stats: number;
  min_ev_threshold: number;
  lookback_days: number;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EVDecisionInput {
  symbol: string;
  strategy_key: string;
  regime: string;
  /** 已经 IsotonicCalibrator 校准的胜率 (0-1) */
  calibrated_win_prob: number;
  as_of_date: string;
  /** 可选 override cost (例如 Sprint 41-E ExecutionPolicyRouter 估算后传入) */
  cost_pct_override?: number;
  /**
   * Batch P (2026-06-17, E1 fix): 可选 portfolio_id, 让 EV 统计按 portfolio 分组.
   * 之前所有 portfolio 共享一份 (strategy_key, regime) avg_win/avg_loss → 一个盘
   * 差表现污染所有盘的 EV gate. 现在 caller (autoBuyFromSignals) 应传当前 portfolio_id,
   * loadStrategyRegimeStats 优先按 portfolio_id 过滤, 数据不足时 fallback 到全平台.
   */
  portfolio_id?: number;
  options?: Partial<EVDecisionOptions>;
}

export interface StrategyRegimeStats {
  strategy_key: string;
  regime: string;
  /** 样本数 */
  sample_count: number;
  /** 平均盈利 % (winning trades 的 pnl_pct 均值) */
  avg_win_pct: number;
  /** 平均亏损 % (losing trades 的 |pnl_pct| 均值, 正数) */
  avg_loss_pct: number;
  /** 历史 win_rate (sanity check, 不参与 EV 计算) */
  historical_win_rate: number;
}

export interface EVDecisionResult {
  decision: 'bet' | 'skip';
  ev: number;
  win_prob: number;
  loss_prob: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  cost_pct: number;
  threshold: number;
  /** 历史样本数 (用于判断 fallback 是否生效) */
  stats_sample_count: number;
  stats_source: 'v2_model' | 'strategy_regime' | 'global_fallback' | 'default_fallback';
  options: EVDecisionOptions;
  reason: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function normalizeEVOptions(input?: Partial<EVDecisionOptions>): EVDecisionOptions {
  const def = DEFAULT_EV_OPTIONS;
  const out = { ...def };
  if (input) {
    if (Number.isFinite(Number(input.default_cost_pct)) && Number(input.default_cost_pct) >= 0)
      out.default_cost_pct = Number(input.default_cost_pct);
    if (
      Number.isFinite(Number(input.fallback_avg_win_pct)) &&
      Number(input.fallback_avg_win_pct) > 0
    )
      out.fallback_avg_win_pct = Number(input.fallback_avg_win_pct);
    if (
      Number.isFinite(Number(input.fallback_avg_loss_pct)) &&
      Number(input.fallback_avg_loss_pct) > 0
    )
      out.fallback_avg_loss_pct = Number(input.fallback_avg_loss_pct);
    if (
      Number.isFinite(Number(input.min_samples_for_stats)) &&
      Number(input.min_samples_for_stats) >= 1
    )
      out.min_samples_for_stats = Math.floor(Number(input.min_samples_for_stats));
    if (Number.isFinite(Number(input.min_ev_threshold)))
      out.min_ev_threshold = Number(input.min_ev_threshold);
    if (Number.isFinite(Number(input.lookback_days)) && Number(input.lookback_days) > 0)
      out.lookback_days = Math.floor(Number(input.lookback_days));
  }
  return out;
}

/**
 * 核心 EV 公式:
 *   EV = p × avg_win - (1 - p) × avg_loss - cost
 *
 * 输入 win_prob 应在 [0, 1], 否则 clamp.
 */
export function computeEV(
  win_prob: number,
  avg_win_pct: number,
  avg_loss_pct: number,
  cost_pct: number
): number {
  const p = Math.max(0, Math.min(1, win_prob));
  const win = Math.max(0, avg_win_pct);
  const loss = Math.max(0, avg_loss_pct);
  const cost = Math.max(0, cost_pct);
  return p * win - (1 - p) * loss - cost;
}

/**
 * 决策: EV >= threshold → bet; 否则 skip.
 */
export function decideByEV(ev: number, threshold: number): 'bet' | 'skip' {
  return ev >= threshold ? 'bet' : 'skip';
}

// ---------------------------------------------------------------------------
// DataSource
// ---------------------------------------------------------------------------

export interface EVDecisionDataSource {
  /**
   * 拉 (strategy_key, regime) 的历史 trade outcome 统计.
   * 返回 null 表示数据完全缺失; sample_count < min_samples 时上层会 fallback 到 global.
   */
  loadStrategyRegimeStats(
    strategy_key: string,
    regime: string,
    lookback_days: number,
    as_of_date: string,
    portfolio_id?: number
  ): Promise<StrategyRegimeStats | null>;

  /**
   * 全局 fallback: 不限 strategy / regime 的近期 outcome 统计.
   * Batch P (2026-06-17, E1): 同款加 portfolio_id 过滤.
   */
  loadGlobalStats(
    lookback_days: number,
    as_of_date: string,
    portfolio_id?: number
  ): Promise<{ sample_count: number; avg_win_pct: number; avg_loss_pct: number } | null>;
}

export const PRODUCTION_EV_DECISION_DATA_SOURCE: EVDecisionDataSource = {
  async loadStrategyRegimeStats(strategy_key, regime, lookback_days, as_of_date, portfolio_id?) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RecommendationTradeOutcome } = require('../../models/RecommendationTradeOutcome');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      // exit_date 是 DATEONLY (YYYY-MM-DD string), 用 ISO 字符串比较, 不要传 Date
      // 否则 Sequelize 自动 toISOString() 多加 "T00:00:00.000Z" 跟 DATEONLY 不匹配.
      const lookbackStart = new Date(`${as_of_date}T00:00:00.000Z`);
      lookbackStart.setUTCDate(lookbackStart.getUTCDate() - lookback_days);
      const lookbackStartIso = lookbackStart.toISOString().slice(0, 10);
      // Batch P (2026-06-17, E1 fix): portfolio_id 过滤. 旧实现全平台混算,
      // 一个盘差表现污染所有盘 EV. 现在优先按 portfolio_id, 数据不足 (caller 自行判
      // sample_count < min_samples) 时 fallback 到全平台.
      const baseWhere: any = {
        trade_status: 'closed',
        exit_date: { [Op.gte]: lookbackStartIso },
      };
      if (Number.isFinite(portfolio_id) && (portfolio_id as number) > 0) {
        baseWhere.portfolio_id = portfolio_id;
      }
      // strategy_key 存在 metadata.strategy_key JSONB, 不能在 where 里精确等值过滤;
      // 改为先按 trade_status + exit_date 过滤, 再 in-memory filter metadata.strategy_key + regime.
      const rows = await RecommendationTradeOutcome.findAll({
        where: baseWhere,
        attributes: ['total_pnl_pct', 'metadata'],
        raw: true,
      });
      const filtered = (rows as any[]).filter(r => {
        const meta = r?.metadata || {};
        const sk = meta.strategy_key;
        // regime 实际存在 metadata.market_environment.market_regime 或
        // metadata.signal_metadata.market_environment.market_regime (与 RecommendationTradeOutcomeService.marketRegimeKey 同源).
        // 之前读 meta.market_regime 永远为空, per-(strategy, regime) 主源永不命中.
        const signalMeta = meta.signal_metadata || {};
        const reg =
          (meta.market_environment && meta.market_environment.market_regime) ||
          (signalMeta.market_environment && signalMeta.market_environment.market_regime) ||
          meta.market_regime; // 兜底: 未来若 backfill 把 regime 提到 top-level 也支持
        return sk === strategy_key && reg === regime;
      });
      if (!filtered.length) return null;
      const wins = filtered.filter(r => Number(r.total_pnl_pct) > 0);
      const losses = filtered.filter(r => Number(r.total_pnl_pct) <= 0);
      // total_pnl_pct 以百分点存储 (5 = 5%), 除以 100 转 fraction (0.05).
      const avg_win_pct = wins.length
        ? wins.reduce((s, r) => s + Number(r.total_pnl_pct), 0) / wins.length / 100
        : 0;
      const avg_loss_pct = losses.length
        ? -losses.reduce((s, r) => s + Number(r.total_pnl_pct), 0) / losses.length / 100
        : 0;
      return {
        strategy_key,
        regime,
        sample_count: filtered.length,
        avg_win_pct,
        avg_loss_pct,
        historical_win_rate: filtered.length > 0 ? wins.length / filtered.length : 0,
      };
    } catch (error: any) {
      logger.warn(
        `EVDecision loadStrategyRegimeStats 失败 (${strategy_key}, ${regime}): ${
          error?.message || error
        }`
      );
      return null;
    }
  },

  async loadGlobalStats(lookback_days, as_of_date, portfolio_id?) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RecommendationTradeOutcome } = require('../../models/RecommendationTradeOutcome');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const lookbackStart = new Date(`${as_of_date}T00:00:00.000Z`);
      lookbackStart.setUTCDate(lookbackStart.getUTCDate() - lookback_days);
      const lookbackStartIso = lookbackStart.toISOString().slice(0, 10);
      const where: any = {
        trade_status: 'closed',
        exit_date: { [Op.gte]: lookbackStartIso },
      };
      // Batch P (2026-06-17, E1): 同 loadStrategyRegimeStats, portfolio_id 优先过滤.
      if (Number.isFinite(portfolio_id) && (portfolio_id as number) > 0) {
        where.portfolio_id = portfolio_id;
      }
      const rows = await RecommendationTradeOutcome.findAll({
        where,
        attributes: ['total_pnl_pct'],
        raw: true,
      });
      if (!rows.length) return null;
      const wins = (rows as any[]).filter(r => Number(r.total_pnl_pct) > 0);
      const losses = (rows as any[]).filter(r => Number(r.total_pnl_pct) <= 0);
      return {
        sample_count: rows.length,
        avg_win_pct: wins.length
          ? wins.reduce((s, r) => s + Number(r.total_pnl_pct), 0) / wins.length / 100
          : 0,
        avg_loss_pct: losses.length
          ? -losses.reduce((s, r) => s + Number(r.total_pnl_pct), 0) / losses.length / 100
          : 0,
      };
    } catch (error: any) {
      logger.warn(`EVDecision loadGlobalStats 失败: ${error?.message || error}`);
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EVDecisionService {
  constructor(private dataSource: EVDecisionDataSource = PRODUCTION_EV_DECISION_DATA_SOURCE) {}

  /**
   * 主决策入口.
   *
   * Sprint 44-A: 4 级 fallback 拿 avg_win / avg_loss:
   *   1. **V2 model.ev_stats_by_regime** (最优先 — triple-barrier label 比 raw pnl 更准)
   *   2. per-(strategy, regime) stats (DB 主源)
   *   3. global stats (DB fallback)
   *   4. default fallback (5% / 3%)
   */
  async decide(input: EVDecisionInput): Promise<EVDecisionResult> {
    const opts = normalizeEVOptions(input.options);
    let stats_source: EVDecisionResult['stats_source'] = 'default_fallback';
    let avg_win_pct = opts.fallback_avg_win_pct;
    let avg_loss_pct = opts.fallback_avg_loss_pct;
    let sample_count = 0;

    // Sprint 44-A: V2 model.ev_stats_by_regime 最高优先级.
    // V2 stats 是基于 triple-barrier label (上轨/下轨/时间轨) 算的, 比 raw pnl
    // 更能反映"路径质量". 缺 (V2 没训过 / 该 regime 无数据) 才退到 DB stats.
    try {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const { isotonicCalibrator } = require('./IsotonicCalibrator');
      /* eslint-enable @typescript-eslint/no-var-requires */
      const v2Model = isotonicCalibrator.getV2Model();
      if (v2Model && v2Model.ev_stats_by_regime) {
        const regimeStats = v2Model.ev_stats_by_regime[input.regime];
        if (regimeStats && regimeStats.n_samples >= opts.min_samples_for_stats) {
          avg_win_pct =
            regimeStats.avg_win_pct > 0 ? regimeStats.avg_win_pct : opts.fallback_avg_win_pct;
          avg_loss_pct =
            regimeStats.avg_loss_pct > 0 ? regimeStats.avg_loss_pct : opts.fallback_avg_loss_pct;
          sample_count = regimeStats.n_samples;
          stats_source = 'v2_model';
        }
      }
    } catch (error: any) {
      logger.warn(`EVDecision V2 model stats 失败 (fail-open): ${error?.message || error}`);
    }

    // 主源 (strategy + regime DB)
    if (stats_source === 'default_fallback') {
      try {
        const stats = await this.dataSource.loadStrategyRegimeStats(
          input.strategy_key,
          input.regime,
          opts.lookback_days,
          input.as_of_date,
          input.portfolio_id // Batch P (2026-06-17, E1): portfolio_id 透传
        );
        if (stats && stats.sample_count >= opts.min_samples_for_stats) {
          avg_win_pct = stats.avg_win_pct > 0 ? stats.avg_win_pct : opts.fallback_avg_win_pct;
          avg_loss_pct = stats.avg_loss_pct > 0 ? stats.avg_loss_pct : opts.fallback_avg_loss_pct;
          sample_count = stats.sample_count;
          stats_source = 'strategy_regime';
        } else if (stats) {
          sample_count = stats.sample_count;
        }
      } catch (error: any) {
        logger.warn(
          `EVDecision strategy_regime stats 失败 (fail-open): ${error?.message || error}`
        );
      }
    }

    // 次源 (global)
    if (stats_source === 'default_fallback') {
      try {
        // Batch P (2026-06-17, E1): 优先按 portfolio_id 查; 数据不足后续 fallback
        // 路径 (default_fallback) 已天然自动应用.
        const global = await this.dataSource.loadGlobalStats(
          opts.lookback_days,
          input.as_of_date,
          input.portfolio_id
        );
        if (global && global.sample_count >= opts.min_samples_for_stats) {
          avg_win_pct = global.avg_win_pct > 0 ? global.avg_win_pct : opts.fallback_avg_win_pct;
          avg_loss_pct = global.avg_loss_pct > 0 ? global.avg_loss_pct : opts.fallback_avg_loss_pct;
          sample_count = global.sample_count;
          stats_source = 'global_fallback';
        }
      } catch (error: any) {
        logger.warn(`EVDecision global stats 失败 (fail-open): ${error?.message || error}`);
      }
    }

    const cost_pct =
      input.cost_pct_override !== undefined && Number.isFinite(Number(input.cost_pct_override))
        ? Number(input.cost_pct_override)
        : opts.default_cost_pct;

    const win_prob = Math.max(0, Math.min(1, input.calibrated_win_prob));
    const loss_prob = 1 - win_prob;
    const ev = computeEV(win_prob, avg_win_pct, avg_loss_pct, cost_pct);
    const decision = decideByEV(ev, opts.min_ev_threshold);

    return {
      decision,
      ev,
      win_prob,
      loss_prob,
      avg_win_pct,
      avg_loss_pct,
      cost_pct,
      threshold: opts.min_ev_threshold,
      stats_sample_count: sample_count,
      stats_source,
      options: opts,
      reason: `${decision} EV=${(ev * 100).toFixed(3)}% (p=${win_prob.toFixed(3)} × win=${(
        avg_win_pct * 100
      ).toFixed(2)}% - loss=${(avg_loss_pct * 100).toFixed(2)}% - cost=${(cost_pct * 100).toFixed(
        2
      )}%) [${stats_source} n=${sample_count}]`,
    };
  }
}

export const evDecisionService = new EVDecisionService();
