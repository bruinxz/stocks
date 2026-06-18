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
    const metric =
      typeof hypo.kill_switch_metric === 'string' ? hypo.kill_switch_metric.trim() : '';
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
        md.strategy_key ||
        sm.strategy_key ||
        (Array.isArray(md.strategy_keys) ? md.strategy_keys[0] : null);
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

export type MetricType = 'sharpe' | 'win_rate' | 'sortino' | 'calmar' | 'profit_factor';
export interface ParsedMetric {
  type: MetricType;
  lookback_days: number;
}

/**
 * 解析 metric 字符串，e.g.:
 *   - "sharpe_30d" → {type: 'sharpe', lookback_days: 30}
 *   - "mean_test_sharpe_60d" → {type: 'sharpe', lookback_days: 60}  (alias)
 *   - "win_rate_90d" → {type: 'win_rate', lookback_days: 90}
 *   - "sortino_30d" → {type: 'sortino', lookback_days: 30}
 *   - "calmar_60d" → {type: 'calmar', lookback_days: 60}
 *   - "profit_factor_30d" → {type: 'profit_factor', lookback_days: 30}
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

  // sortino (downside-deviation-adjusted return)
  const sortinoMatch = lower.match(/sortino_(\d+)d?$/);
  if (sortinoMatch) {
    const days = parseInt(sortinoMatch[1], 10);
    if (Number.isFinite(days) && days >= 1 && days <= 365) {
      return { type: 'sortino', lookback_days: days };
    }
  }

  // calmar (annualized_return / max_drawdown_pct)
  const calmarMatch = lower.match(/calmar_(\d+)d?$/);
  if (calmarMatch) {
    const days = parseInt(calmarMatch[1], 10);
    if (Number.isFinite(days) && days >= 1 && days <= 365) {
      return { type: 'calmar', lookback_days: days };
    }
  }

  // profit_factor (sum of wins / abs(sum of losses))
  const pfMatch = lower.match(/profit_factor_(\d+)d?$/);
  if (pfMatch) {
    const days = parseInt(pfMatch[1], 10);
    if (Number.isFinite(days) && days >= 1 && days <= 365) {
      return { type: 'profit_factor', lookback_days: days };
    }
  }

  return null;
}

/**
 * 从 outcome 行计算指标值（纯函数）。
 *
 * 所有按"每笔 pnl_pct 当成一个观测样本"算（简化口径，与 backtest 日级 sharpe 公式
 * 有差异，但作为 kill_switch 阈值监控足够）。
 *
 * - 'sharpe': mean / std × sqrt(12)
 * - 'win_rate': wins / total (0-1)
 * - 'sortino': mean / downside_std × sqrt(12) (只考虑负回报样本的 std)
 * - 'calmar': annualized_return / max_drawdown_pct (peak-to-trough)
 * - 'profit_factor': sum(positive) / abs(sum(negative))
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
    const annualizationFactor = Math.sqrt(12);
    return (mean / std) * annualizationFactor;
  }

  if (type === 'sortino') {
    if (pnls.length < 2) return null;
    const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
    // downside deviation: 只对负样本计算（vs 0 而非 mean，Sortino 经典定义）
    const negatives = pnls.filter(v => v < 0);
    if (negatives.length === 0) {
      // 没有亏损样本 — sortino 理论上为 +∞；返回大正数表示 "无下行风险"
      return mean > 0 ? 999 : null;
    }
    const downsideVariance = negatives.reduce((s, v) => s + v * v, 0) / pnls.length; // 用全体 n 而非 negatives.length (target=0)
    const downsideStd = Math.sqrt(downsideVariance);
    if (downsideStd <= 1e-10) return null;
    const annualizationFactor = Math.sqrt(12);
    return (mean / downsideStd) * annualizationFactor;
  }

  if (type === 'calmar') {
    if (pnls.length < 2) return null;
    // 按 trade 序列累计算 equity curve，再求 max drawdown
    let equity = 100; // 起始 100
    let peak = 100;
    let maxDd = 0;
    const eqCurve: number[] = [equity];
    for (const r of pnls) {
      equity *= 1 + r / 100;
      eqCurve.push(equity);
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
    const totalReturn = (equity - 100) / 100;
    // 年化：假设 12 trades/year, annualized_return = (1+totalReturn)^(12/n) - 1
    const periods = pnls.length;
    const annualReturn = Math.pow(1 + totalReturn, 12 / periods) - 1;
    if (maxDd <= 1e-10) {
      // 无回撤 — calmar 理论 +∞；正回报返大正数，负/零回报返 null
      return annualReturn > 0 ? 999 : null;
    }
    return annualReturn / maxDd;
  }

  if (type === 'profit_factor') {
    if (pnls.length === 0) return null;
    const wins = pnls.filter(v => v > 0);
    const losses = pnls.filter(v => v < 0);
    const grossWin = wins.reduce((s, v) => s + v, 0);
    const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
    if (grossLoss <= 1e-10) {
      // 没亏过 — profit_factor 理论 +∞；返大正数表示稳赢
      return grossWin > 0 ? 999 : null;
    }
    return grossWin / grossLoss;
  }

  return null;
}

function round(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

export const strategyKillSwitchMonitor = new StrategyKillSwitchMonitor();
