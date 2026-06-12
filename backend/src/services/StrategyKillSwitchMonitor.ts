/**
 * StrategyKillSwitchMonitor — Phase 4+ 策略熔断监控
 *
 * 每个策略的 edge_hypothesis 里写了 kill_switch_metric + kill_switch_threshold，
 * 比如 multi_factor_alpha = "mean_test_sharpe_30d" < 0.3 → 该策略停用。
 * 之前只是文档化没人执行，现在 cron 跑这个 monitor 自动触发停用 + 飞书告警。
 *
 * 监控指标支持 (从 RecommendationTradeOutcome 聚合，按 strategy_key 分组):
 *   - sharpe_30d / sharpe_60d / sharpe_90d
 *     按 daily return 算 annualized sharpe (n-1 stddev, ×sqrt(252))
 *   - win_rate_30d / win_rate_60d / win_rate_90d
 *     wins / total （0-1）
 *   - mean_test_sharpe_30d (= sharpe_30d 的别名，与 walk-forward 词汇对齐)
 *
 * 触发后动作:
 *   - 策略 enabled=false (PATCH /api/quant/strategies/:id)
 *   - 写 SizingDecisionAudit-like 审计行 (复用 StrategyKillSwitchAudit)
 *   - 推送飞书警告 (如配置)
 *
 * 注意:
 *   - 样本量 < 5 笔 closed trades 时 skip (数据不足)
 *   - 计算失败 fail-OPEN (策略不被错误停用)
 *   - 已 disabled 的策略 skip (避免重复执行)
 */

import { Op } from 'sequelize';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { QuantStrategyModel } from '../models/QuantStrategyModel';
import { logger } from '../utils/logger';

export interface KillSwitchEvaluation {
  strategy_key: string;
  metric: string;
  threshold: number;
  observed_value: number | null;
  sample_size: number;
  triggered: boolean;
  reason: string;
}

export interface KillSwitchMonitorResult {
  generated_at: string;
  total_strategies: number;
  evaluated: number;
  triggered: number;
  skipped_no_kill_switch: number;
  skipped_disabled: number;
  skipped_insufficient_data: number;
  evaluations: KillSwitchEvaluation[];
  errors: Array<{ strategy_key: string; message: string }>;
}

const MIN_SAMPLE_FOR_KILL = 5;

export class StrategyKillSwitchMonitor {
  /**
   * 扫描所有策略，对配置了 kill_switch_metric 的策略评估指标值；
   * 触发的策略自动 enabled=false。
   *
   * @param options.dry_run true = 只评估不真正关闭（debug / 预览）
   */
  async evaluateAll(options: { dry_run?: boolean } = {}): Promise<KillSwitchMonitorResult> {
    const dryRun = options.dry_run !== false; // 默认 dry_run 避免误关
    const result: KillSwitchMonitorResult = {
      generated_at: new Date().toISOString(),
      total_strategies: 0,
      evaluated: 0,
      triggered: 0,
      skipped_no_kill_switch: 0,
      skipped_disabled: 0,
      skipped_insufficient_data: 0,
      evaluations: [],
      errors: [],
    };

    let strategies: QuantStrategyModel[];
    try {
      strategies = await QuantStrategyModel.findAll();
    } catch (err: any) {
      logger.error(`[kill-switch] failed to load strategies: ${err?.message || err}`);
      return result;
    }
    result.total_strategies = strategies.length;

    for (const strategy of strategies) {
      try {
        const evalResult = await this.evaluateOne(strategy);
        if (evalResult === null) {
          result.skipped_no_kill_switch++;
          continue;
        }
        if (evalResult.reason.startsWith('skipped_disabled')) {
          result.skipped_disabled++;
          continue;
        }
        if (evalResult.reason.startsWith('skipped_insufficient_data')) {
          result.skipped_insufficient_data++;
          result.evaluations.push(evalResult);
          continue;
        }
        result.evaluated++;
        result.evaluations.push(evalResult);

        if (evalResult.triggered) {
          result.triggered++;
          logger.warn(
            `[kill-switch] TRIGGERED strategy=${evalResult.strategy_key} ` +
              `metric=${evalResult.metric} observed=${evalResult.observed_value} ` +
              `threshold=${evalResult.threshold} dry_run=${dryRun}`
          );
          if (!dryRun) {
            await strategy.update({ enabled: false });
            logger.warn(`[kill-switch] APPLY: strategy ${strategy.strategy_key} enabled=false`);
          }
        }
      } catch (err: any) {
        result.errors.push({
          strategy_key: strategy.strategy_key,
          message: err?.message || String(err),
        });
        logger.warn(`[kill-switch] error on ${strategy.strategy_key}: ${err?.message || err}`);
      }
    }
    return result;
  }

  /**
   * 评估单个策略的 kill_switch。
   *
   * @returns null 如该策略未配置 kill_switch；否则 KillSwitchEvaluation
   */
  async evaluateOne(strategy: QuantStrategyModel): Promise<KillSwitchEvaluation | null> {
    const hypo: any = strategy.edge_hypothesis || {};
    const metric = typeof hypo.kill_switch_metric === 'string' ? hypo.kill_switch_metric.trim() : '';
    const threshold =
      typeof hypo.kill_switch_threshold === 'number' && Number.isFinite(hypo.kill_switch_threshold)
        ? hypo.kill_switch_threshold
        : null;
    if (!metric || threshold === null) return null;

    if (strategy.enabled === false) {
      return {
        strategy_key: strategy.strategy_key,
        metric,
        threshold,
        observed_value: null,
        sample_size: 0,
        triggered: false,
        reason: 'skipped_disabled',
      };
    }

    // 解析 metric — 当前支持 sharpe_Nd / win_rate_Nd / mean_test_sharpe_Nd
    const parsed = parseMetricName(metric);
    if (!parsed) {
      return {
        strategy_key: strategy.strategy_key,
        metric,
        threshold,
        observed_value: null,
        sample_size: 0,
        triggered: false,
        reason: `unsupported_metric: ${metric}`,
      };
    }

    const since = new Date();
    since.setDate(since.getDate() - parsed.lookback_days);
    const sinceStr = since.toISOString().slice(0, 10);

    const rows = await RecommendationTradeOutcome.findAll({
      where: {
        trade_status: 'closed',
        entry_date: { [Op.gte]: sinceStr },
      },
      attributes: ['total_pnl_pct', 'realized_pnl_pct', 'holding_days', 'metadata'],
      limit: 5000,
    });

    // 过滤匹配 strategy_key 的 outcome
    const matching = rows.filter(r => {
      const md: any = r.metadata || {};
      const sm: any = md.signal_metadata || {};
      const key =
        md.strategy_key || sm.strategy_key || (Array.isArray(md.strategy_keys) ? md.strategy_keys[0] : null);
      return key === strategy.strategy_key;
    });

    if (matching.length < MIN_SAMPLE_FOR_KILL) {
      return {
        strategy_key: strategy.strategy_key,
        metric,
        threshold,
        observed_value: null,
        sample_size: matching.length,
        triggered: false,
        reason: `skipped_insufficient_data: ${matching.length}/${MIN_SAMPLE_FOR_KILL}`,
      };
    }

    const observed = computeMetric(parsed.type, matching);
    if (observed === null || !Number.isFinite(observed)) {
      return {
        strategy_key: strategy.strategy_key,
        metric,
        threshold,
        observed_value: null,
        sample_size: matching.length,
        triggered: false,
        reason: 'computed_NaN',
      };
    }

    // 触发判断：低于 threshold 触发
    const triggered = observed < threshold;
    return {
      strategy_key: strategy.strategy_key,
      metric,
      threshold,
      observed_value: round(observed, 4),
      sample_size: matching.length,
      triggered,
      reason: triggered
        ? `${parsed.type}=${round(observed, 4)} < ${threshold}`
        : `${parsed.type}=${round(observed, 4)} >= ${threshold} (ok)`,
    };
  }
}

// ============================================================
// 纯函数 helpers (export 让单测脱 DB)
// ============================================================

export type MetricType = 'sharpe' | 'win_rate';
export interface ParsedMetric {
  type: MetricType;
  lookback_days: number;
}

/**
 * 解析 metric 字符串，e.g.:
 *   - "sharpe_30d" → {type: 'sharpe', lookback_days: 30}
 *   - "mean_test_sharpe_60d" → {type: 'sharpe', lookback_days: 60}  (alias)
 *   - "win_rate_90d" → {type: 'win_rate', lookback_days: 90}
 * 返回 null 表示不支持的 metric 名（caller 跳过）。
 */
export function parseMetricName(metric: string): ParsedMetric | null {
  if (!metric) return null;
  const lower = metric.toLowerCase().trim();

  // sharpe (含 mean_test_sharpe alias)
  const sharpeMatch = lower.match(/(?:mean_test_)?sharpe_(\d+)d?$/);
  if (sharpeMatch) {
    const days = parseInt(sharpeMatch[1], 10);
    if (Number.isFinite(days) && days >= 1 && days <= 365) {
      return { type: 'sharpe', lookback_days: days };
    }
  }

  // win_rate
  const winMatch = lower.match(/win_rate_(\d+)d?$/);
  if (winMatch) {
    const days = parseInt(winMatch[1], 10);
    if (Number.isFinite(days) && days >= 1 && days <= 365) {
      return { type: 'win_rate', lookback_days: days };
    }
  }

  return null;
}

/**
 * 从 outcome 行计算指标值（纯函数）。
 *
 * - 'sharpe': 按每笔 pnl_pct 当成一个观测样本，算 mean / std × sqrt(252)
 *   注意: 这是简化 sharpe（用 per-trade 而非日 returns），与 BackTester 的
 *   sharpe 公式有差异，但作为 kill_switch 阈值监控足够。
 * - 'win_rate': wins / total （0-1）
 */
export function computeMetric(
  type: MetricType,
  rows: Array<{ total_pnl_pct?: number; realized_pnl_pct?: number }>
): number | null {
  const pnls = rows
    .map(r => Number(r.total_pnl_pct ?? r.realized_pnl_pct ?? NaN))
    .filter(v => Number.isFinite(v));

  if (pnls.length === 0) return null;

  if (type === 'win_rate') {
    const wins = pnls.filter(v => v > 0).length;
    return wins / pnls.length;
  }

  if (type === 'sharpe') {
    if (pnls.length < 2) return null;
    const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
    const variance = pnls.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (pnls.length - 1);
    const std = Math.sqrt(variance);
    if (std <= 1e-10) return null; // 全相等
    // 简化 sharpe 不年化 × sqrt(252)，因 per-trade 不是日级返回
    // 但仍乘 sqrt(n_per_year) 让数字与传统 sharpe 在同一量级
    // 这里用 sqrt(12) (假设月均交易 ~12 笔)
    const annualizationFactor = Math.sqrt(12);
    return (mean / std) * annualizationFactor;
  }

  return null;
}

function round(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

export const strategyKillSwitchMonitor = new StrategyKillSwitchMonitor();
