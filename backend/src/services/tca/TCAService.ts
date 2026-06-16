/**
 * Sprint 42-B: TCAService — Transaction Cost Attribution (交易成本归因)
 *
 * 每笔已完成 (closed) trade 拆解 cost 来源, 让运维看清"信号收益和实际收益的
 * 差距来自哪里":
 *
 *   tracking_error = signal_return - realized_pnl
 *                  = entry_slippage + exit_slippage + impact_cost + delay_cost + missed_opportunity
 *
 *   - **entry_slippage_pct**: BUY 执行价 vs signal reference_price 偏差 (%)
 *   - **exit_slippage_pct**:  SELL 执行价 vs target_exit_price 偏差 (%)
 *   - **impact_cost_pct**:    ExecutionPolicyRouter.estimateCostPct 估算 (%)
 *   - **delay_cost_pct**:     signal 生成日 close → trade 执行日 close 漂移 (%)
 *   - **missed_opportunity_pct**: signal 期望收益 - realized (剩余部分; 已包含上面 4 项)
 *   - **realized_pnl_pct**:    实际收益 (close_price / avg_cost - 1)
 *
 * 反哺策略: 每周聚合 per-strategy 的 mean attribution, 自动降低
 * "entry_slip > 0.5% OR impact > 0.3%" 的策略权重 (这类策略实盘成本高).
 *
 * 设计要点:
 *   1. **纯函数 + DataSource DI**: helper 全 export, 单测脱 DB
 *   2. **per-trade 独立计算 + 聚合**: 单 trade 失败不阻塞 batch
 *   3. **fail-open**: signal reference_price 缺失 → entry_slip=null, 不算 NaN
 *   4. **不直接写 RecommendationTradeOutcome**: 只产 TCA result, caller (cron) 决定持久化
 */

import { logger } from '../../utils/logger';

// ===========================================================================
// Types
// ===========================================================================

export interface TCATradeInput {
  /** PaperTradingTrade 的 trade id (实际可选, 仅作 audit) */
  trade_id?: number;
  symbol: string;
  strategy_key: string;
  /** BUY 执行价 (PaperTradingTrade.execute_price) */
  buy_execute_price: number;
  /** BUY 时 signal 建议的 reference price (来自 OrderIntent.reference_price) */
  buy_reference_price?: number;
  /** SELL 执行价 (close 时) */
  sell_execute_price?: number;
  /** SELL 时 target price (来自 signal.target_exit_price 或 take_profit_price) */
  sell_reference_price?: number;
  /** Signal 生成日的 close price */
  signal_day_close?: number;
  /** Trade 执行日的 open price (估 delay 用) */
  trade_day_open?: number;
  /** 历史 signal_score (0-100), 推算预期收益 */
  signal_score?: number;
  /** ExecutionPolicyRouter 估算的 impact cost (% of trade amount) */
  estimated_impact_cost_pct?: number;
  /** 持仓自然日数 */
  holding_days?: number;
}

export interface TCAResult {
  trade_id?: number;
  symbol: string;
  strategy_key: string;
  /** 实际 realized PnL % (sell_price / buy_price - 1) */
  realized_pnl_pct: number | null;
  /** signal 当时预期收益 % (从 signal_score 推算) */
  signal_expected_return_pct: number | null;
  /** 总 tracking error = signal_expected - realized */
  tracking_error_pct: number | null;
  /** entry slippage = (buy_execute - buy_reference) / buy_reference, BUY 时正 = 高于参考价 */
  entry_slippage_pct: number | null;
  /** exit slippage = (sell_reference - sell_execute) / sell_reference, SELL 时正 = 低于目标 */
  exit_slippage_pct: number | null;
  /** delay cost = (trade_open - signal_close) / signal_close */
  delay_cost_pct: number | null;
  /** ExecutionPolicyRouter 估算的 impact cost */
  impact_cost_pct: number;
  /** 残余 = tracking_error - 上面 4 项 (理论上接近 0 或机会成本) */
  residual_pct: number | null;
  reason: string;
}

export interface TCABatchSummary {
  strategy_key: string;
  trade_count: number;
  avg_realized_pnl_pct: number;
  avg_signal_expected_return_pct: number;
  avg_tracking_error_pct: number;
  avg_entry_slippage_pct: number;
  avg_exit_slippage_pct: number;
  avg_delay_cost_pct: number;
  avg_impact_cost_pct: number;
  /** 自动降权建议: entry_slip > 0.5% OR impact > 0.3% → 0.7 */
  recommended_weight_multiplier: number;
  warning: 'ok' | 'high_cost' | 'severe';
  reason: string;
}

// ===========================================================================
// Pure helpers
// ===========================================================================

/**
 * 从 signal_score (0-100) 推算预期收益 %.
 *   80 分 → 8% 预期
 *   70 分 → 4% 预期
 *   60 分 → 2% 预期
 *   < 60 → 1% (噪音水平)
 * 这是粗略映射, 真实期望值应该来自 EVDecisionService.avg_win_pct × win_prob, 但
 * 对历史 trade 没有 EV record, 用 score → return 线性映射兜底.
 */
export function signalScoreToExpectedReturnPct(score: number | undefined): number | null {
  if (!Number.isFinite(score as number)) return null;
  const s = Number(score);
  if (s < 60) return 0.01;
  if (s < 70) return 0.02;
  if (s < 80) return 0.04;
  if (s < 90) return 0.08;
  return 0.12;
}

/**
 * 算单 trade 的 entry slippage.
 * BUY 时: 高于参考价 = 正 slippage (我们多付了); 低于 = 负 (赚到)
 */
export function computeEntrySlippage(buy_execute: number, buy_reference?: number): number | null {
  if (!Number.isFinite(buy_reference as number) || (buy_reference as number) <= 0) return null;
  return (buy_execute - (buy_reference as number)) / (buy_reference as number);
}

/**
 * 算单 trade 的 exit slippage.
 * SELL 时: 低于目标 = 正 slippage (我们少收了); 高于 = 负 (超额)
 */
export function computeExitSlippage(sell_execute?: number, sell_reference?: number): number | null {
  if (
    !Number.isFinite(sell_execute as number) ||
    !Number.isFinite(sell_reference as number) ||
    (sell_reference as number) <= 0
  )
    return null;
  return ((sell_reference as number) - (sell_execute as number)) / (sell_reference as number);
}

/**
 * Delay cost = (trade_day_open - signal_day_close) / signal_day_close
 * BUY 时正 = 价格已上涨, 错过了机会
 */
export function computeDelayCost(trade_open?: number, signal_close?: number): number | null {
  if (
    !Number.isFinite(trade_open as number) ||
    !Number.isFinite(signal_close as number) ||
    (signal_close as number) <= 0
  )
    return null;
  return ((trade_open as number) - (signal_close as number)) / (signal_close as number);
}

/**
 * 单 trade 完整 TCA.
 */
export function attributeSingleTrade(input: TCATradeInput): TCAResult {
  const realized_pnl_pct =
    Number.isFinite(input.sell_execute_price) && input.buy_execute_price > 0
      ? (input.sell_execute_price as number) / input.buy_execute_price - 1
      : null;
  const signal_expected = signalScoreToExpectedReturnPct(input.signal_score);
  const tracking_error =
    realized_pnl_pct !== null && signal_expected !== null
      ? signal_expected - realized_pnl_pct
      : null;
  const entry_slip = computeEntrySlippage(input.buy_execute_price, input.buy_reference_price);
  const exit_slip = computeExitSlippage(input.sell_execute_price, input.sell_reference_price);
  const delay_cost = computeDelayCost(input.trade_day_open, input.signal_day_close);
  const impact_cost = Number.isFinite(input.estimated_impact_cost_pct as number)
    ? (input.estimated_impact_cost_pct as number)
    : 0.003; // 默认 0.3%
  const knownCosts = (entry_slip ?? 0) + (exit_slip ?? 0) + (delay_cost ?? 0) + impact_cost;
  const residual = tracking_error !== null ? tracking_error - knownCosts : null;
  return {
    trade_id: input.trade_id,
    symbol: input.symbol,
    strategy_key: input.strategy_key,
    realized_pnl_pct,
    signal_expected_return_pct: signal_expected,
    tracking_error_pct: tracking_error,
    entry_slippage_pct: entry_slip,
    exit_slippage_pct: exit_slip,
    delay_cost_pct: delay_cost,
    impact_cost_pct: impact_cost,
    residual_pct: residual,
    reason: `${input.symbol} (${input.strategy_key}): realized=${
      realized_pnl_pct !== null ? (realized_pnl_pct * 100).toFixed(2) + '%' : 'n/a'
    } vs expected=${
      signal_expected !== null ? (signal_expected * 100).toFixed(2) + '%' : 'n/a'
    }, tracking_err=${
      tracking_error !== null ? (tracking_error * 100).toFixed(2) + '%' : 'n/a'
    } (entry_slip=${entry_slip !== null ? (entry_slip * 100).toFixed(2) + '%' : 'n/a'} + impact=${(
      impact_cost * 100
    ).toFixed(2)}%)`,
  };
}

/**
 * 聚合 N 个 trade 给 per-strategy summary + 建议权重.
 *
 * 规则:
 *   - entry_slip 平均 > 0.5% → warning='high_cost', multiplier=0.7
 *   - impact 平均 > 0.3% → warning='high_cost', multiplier=0.7
 *   - 两个都超 → warning='severe', multiplier=0.5
 */
export function aggregateAttribution(results: TCAResult[]): Map<string, TCABatchSummary> {
  const groups = new Map<string, TCAResult[]>();
  for (const r of results) {
    const arr = groups.get(r.strategy_key) || [];
    arr.push(r);
    groups.set(r.strategy_key, arr);
  }
  const out = new Map<string, TCABatchSummary>();
  for (const [strategy_key, items] of groups) {
    const avg = (key: keyof TCAResult): number => {
      const vals = items.map(r => r[key]).filter(v => Number.isFinite(v as number)) as number[];
      if (!vals.length) return 0;
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    };
    const avg_entry_slip = avg('entry_slippage_pct');
    const avg_impact = avg('impact_cost_pct');
    const high_slip = avg_entry_slip > 0.005;
    const high_impact = avg_impact > 0.003;
    let multiplier = 1;
    let warning: TCABatchSummary['warning'] = 'ok';
    if (high_slip && high_impact) {
      warning = 'severe';
      multiplier = 0.5;
    } else if (high_slip || high_impact) {
      warning = 'high_cost';
      multiplier = 0.7;
    }
    out.set(strategy_key, {
      strategy_key,
      trade_count: items.length,
      avg_realized_pnl_pct: avg('realized_pnl_pct'),
      avg_signal_expected_return_pct: avg('signal_expected_return_pct'),
      avg_tracking_error_pct: avg('tracking_error_pct'),
      avg_entry_slippage_pct: avg_entry_slip,
      avg_exit_slippage_pct: avg('exit_slippage_pct'),
      avg_delay_cost_pct: avg('delay_cost_pct'),
      avg_impact_cost_pct: avg_impact,
      recommended_weight_multiplier: multiplier,
      warning,
      reason: `${strategy_key}: ${items.length} trades, entry_slip=${(avg_entry_slip * 100).toFixed(
        2
      )}%, impact=${(avg_impact * 100).toFixed(2)}%, weight×${multiplier.toFixed(2)} [${warning}]`,
    });
  }
  return out;
}

// ===========================================================================
// DataSource
// ===========================================================================

export interface TCADataSource {
  /**
   * 拉 N 天内已 closed 的 trades + 关联 OrderIntent.metadata.
   * 返回 TCATradeInput[] 给 attributeSingleTrade 用.
   */
  loadClosedTradesForTCA(lookback_days: number, as_of_date: string): Promise<TCATradeInput[]>;
}

export const PRODUCTION_TCA_DATA_SOURCE: TCADataSource = {
  async loadClosedTradesForTCA(lookback_days, as_of_date) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RecommendationTradeOutcome } = require('../../models/RecommendationTradeOutcome');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingOrderIntent } = require('../../models/PaperTradingOrderIntent');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const start = new Date(`${as_of_date}T00:00:00.000Z`);
      start.setDate(start.getDate() - lookback_days);
      const outcomes = await RecommendationTradeOutcome.findAll({
        where: {
          status: 'closed',
          closed_at: { [Op.gte]: start },
        },
        attributes: ['signal_id', 'symbol', 'strategy_key', 'profit_pct', 'metadata'],
        raw: true,
      });
      const out: TCATradeInput[] = [];
      for (const o of outcomes as any[]) {
        // 用 OrderIntent.metadata 拿 reference_price / execution_policy
        let buy_reference_price: number | undefined;
        let estimated_impact_cost_pct: number | undefined;
        let signal_score: number | undefined;
        try {
          if (o.signal_id) {
            const intent = await PaperTradingOrderIntent.findOne({
              where: { signal_id: o.signal_id, side: 'BUY' },
              attributes: ['reference_price', 'metadata', 'score'],
              raw: true,
            });
            if (intent) {
              buy_reference_price = Number((intent as any).reference_price) || undefined;
              signal_score = Number((intent as any).score) || undefined;
              const meta = (intent as any).metadata || {};
              const policy = meta.execution_policy;
              if (policy && typeof policy === 'object') {
                // ExecutionPolicyRouter 估的 max_slippage_pct + 估算 impact
                estimated_impact_cost_pct = Number(policy.max_slippage_pct) || 0.003;
              }
            }
          }
        } catch (e: any) {
          logger.warn(`TCA 反查 OrderIntent 失败 (signal_id=${o.signal_id}): ${e?.message || e}`);
        }
        const profit_pct = Number(o.profit_pct);
        if (!Number.isFinite(profit_pct)) continue;
        // 注: PaperTradingTrade 没拆 entry/exit 两条, profit_pct 是已经包含 sell_close 的;
        // 用 buy_reference_price 与隐含的 buy_execute (= reference + slippage) 算 entry slip,
        // 没法精确 — 这里先简化: 若 profit_pct 远低于 signal expected, 就算 tracking_error.
        // 完整版需要 trades 表 join sell trade 拿 sell_execute_price.
        out.push({
          symbol: o.symbol,
          strategy_key: o.strategy_key || 'unknown',
          buy_execute_price: buy_reference_price || 0, // 简化
          buy_reference_price,
          sell_execute_price:
            buy_reference_price && buy_reference_price > 0
              ? buy_reference_price * (1 + profit_pct / 100)
              : undefined,
          sell_reference_price: buy_reference_price,
          signal_score,
          estimated_impact_cost_pct,
        });
      }
      return out;
    } catch (error: any) {
      logger.warn(`TCA loadClosedTradesForTCA 失败: ${error?.message || error}`);
      return [];
    }
  },
};

// ===========================================================================
// Service
// ===========================================================================

export class TCAService {
  constructor(private dataSource: TCADataSource = PRODUCTION_TCA_DATA_SOURCE) {}

  /**
   * 主入口: 跑 N 天 lookback 的 TCA, 返回 per-strategy summary.
   */
  async runAttribution(input: { lookback_days?: number; as_of_date?: string }): Promise<{
    per_trade: TCAResult[];
    per_strategy: TCABatchSummary[];
    total_trades: number;
  }> {
    const lookback = input.lookback_days ?? 30;
    const asOf = input.as_of_date || new Date().toISOString().slice(0, 10);
    const trades = await this.dataSource.loadClosedTradesForTCA(lookback, asOf);
    const results: TCAResult[] = [];
    for (const t of trades) {
      try {
        results.push(attributeSingleTrade(t));
      } catch (error: any) {
        logger.warn(`TCA 单 trade 失败 (${t.symbol}): ${error?.message || error}`);
      }
    }
    const byStrategy = aggregateAttribution(results);
    return {
      per_trade: results,
      per_strategy: Array.from(byStrategy.values()),
      total_trades: trades.length,
    };
  }
}

export const tcaService = new TCAService();
