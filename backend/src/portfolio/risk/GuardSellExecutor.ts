/**
 * GuardSellExecutor — Batch J (2026-06-17)
 *
 * 把风控 guard 产出的 SELL trigger 真正变成成交 (走 facade.placeOrder).
 *
 * Background:
 * 8 个 risk guard 中只有 IndustryConcentrationGuard.rebalanceIndustry 会真卖
 * (HTTP 手动入口). 其它 5 个 EOD trigger guard (TrailingStop / PerStockStopLoss /
 * Drawdown LEVEL_2&3 / PerStock MASS) 都声明"输出 trigger / caller 决定撮合", 但
 * **没有任何 caller** 实际接 trigger → facade.placeOrder. 结果: 触发了止损 /
 * 群体止损 / 回撤 LEVEL_3 也不会卖, 只是写 RiskAlert HIGH 推飞书.
 *
 * 本 executor 在 cron 任务调 guard.evaluate* 之后调用, 把 triggers 转换成 SELL
 * 订单. 关键点:
 *
 *  1. **走 facade.placeOrder**: 保持交易事务 / cash 锁 / 印花税 / commission /
 *     outcome 闭环刷新等所有算账链完整 (vs 直接 mutate position 双轨).
 *  2. **bypass_t_plus_1=true**: EOD guard 是收盘后评估 / 次日开盘前执行,
 *     被卖持仓必然是 prior day 或更早开的, T+1 已自然满足. bypass 安全.
 *  3. **bypass_trading_hours**: 这些 cron 通常在 15:30 / 次日 09:25 等开盘外
 *     时点跑, 没法等到 09:30 才下单. EOD 模型按 daily close 撮合, 不需要 intra-day.
 *     bypass_trading_hours=true 是必要的.
 *  4. **per-position try/catch**: 一只股 SELL 失败 (停牌 / 0 价 / 持仓不足) 不
 *     阻塞其余 trigger; 失败计 errors[] 让 caller / dashboard 看见.
 *  5. **dry_run 透传**: cron `dry_run=true` 时跳过执行, 只 echo 计划.
 */

import { logger } from '../../utils/logger';
import {
  buildTradeReasonFromRiskGuard,
  summarizeTradeReason,
} from '../internal/tradeReasonBuilder';

export interface GuardSellTriggerInput {
  user_id: number;
  symbol: string;
  quantity: number;
  /** trigger 类型, 仅用于日志 / result_summary: 'trailing_stop' / 'per_stock_stop_loss' / 'drawdown_level_2' / 'drawdown_level_3' / 'per_stock_mass' */
  trigger_kind: string;
  /** 可选 portfolio_id; 不传时 facade 走 user 名下 active 第一个盘 (warn) */
  portfolio_id?: number;
  /** debug 上下文 (止损价 / 当前价 / 回撤等) 仅写日志 */
  detail?: Record<string, any>;
}

export interface GuardSellExecutionResult {
  scenario: string;
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  dry_run: boolean;
  executions: Array<{
    user_id: number;
    symbol: string;
    quantity: number;
    portfolio_id?: number;
    trigger_kind: string;
    status: 'success' | 'skipped' | 'failed';
    trade_id?: number;
    realized_pnl?: number;
    error?: string;
    error_code?: string;
  }>;
}

/**
 * 把一批 trigger 转换成 facade.placeOrder SELL 调用.
 *
 * dry_run=true: 只 echo, 不真卖. 用于 cron / UI 预览.
 */
export async function executeGuardSells(
  triggers: GuardSellTriggerInput[],
  options: { scenario: string; dry_run?: boolean }
): Promise<GuardSellExecutionResult> {
  const result: GuardSellExecutionResult = {
    scenario: options.scenario,
    attempted: triggers.length,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    dry_run: options.dry_run === true,
    executions: [],
  };
  if (!triggers.length) return result;

  // lazy-require 避免 risk/ → portfolio/ 循环
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { paperTradingFacade } = require('../PaperTradingFacade');

  for (const trig of triggers) {
    if (options.dry_run) {
      result.skipped++;
      result.executions.push({
        user_id: trig.user_id,
        symbol: trig.symbol,
        quantity: trig.quantity,
        portfolio_id: trig.portfolio_id,
        trigger_kind: trig.trigger_kind,
        status: 'skipped',
        error: 'dry_run',
      });
      continue;
    }
    if (!Number.isFinite(trig.quantity) || trig.quantity <= 0) {
      result.skipped++;
      result.executions.push({
        user_id: trig.user_id,
        symbol: trig.symbol,
        quantity: trig.quantity,
        portfolio_id: trig.portfolio_id,
        trigger_kind: trig.trigger_kind,
        status: 'skipped',
        error: 'invalid quantity',
      });
      continue;
    }
    try {
      // AL-3 (2026-06-21): 把 trigger_kind + detail 转成 trade_reason 透传给 facade.
      const reason = buildTradeReasonFromRiskGuard(trig.trigger_kind, {
        detail: trig.detail,
        threshold: trig.detail?.threshold,
        actual: trig.detail?.actual,
        indicator: trig.detail?.indicator,
        message: trig.detail?.message,
      });
      const trade = await paperTradingFacade.placeOrder({
        user_id: trig.user_id,
        portfolio_id: trig.portfolio_id,
        symbol: trig.symbol,
        direction: 'SELL',
        quantity: trig.quantity,
        bypass_trading_hours: true, // EOD cron 在开盘前/收盘后执行, 模拟盘按 daily close 撮合
        bypass_t_plus_1: true, // EOD trigger 持仓必然是 prior day, T+1 自然满足
        trade_reason: reason,
        trade_reason_summary: summarizeTradeReason(reason, 'SELL'),
      });
      result.succeeded++;
      result.executions.push({
        user_id: trig.user_id,
        symbol: trig.symbol,
        quantity: trig.quantity,
        portfolio_id: trig.portfolio_id,
        trigger_kind: trig.trigger_kind,
        status: 'success',
        trade_id: (trade as any)?.trade_id,
        realized_pnl: (trade as any)?.realized_pnl,
      });
      logger.info(
        `[guard-sell-executor] ${options.scenario} executed: user=${trig.user_id} ${trig.symbol} qty=${trig.quantity} reason=${trig.trigger_kind}`
      );
    } catch (error: any) {
      result.failed++;
      result.executions.push({
        user_id: trig.user_id,
        symbol: trig.symbol,
        quantity: trig.quantity,
        portfolio_id: trig.portfolio_id,
        trigger_kind: trig.trigger_kind,
        status: 'failed',
        error: error?.message || String(error),
        error_code: error?.code,
      });
      logger.warn(
        `[guard-sell-executor] ${options.scenario} failed: user=${trig.user_id} ${
          trig.symbol
        } qty=${trig.quantity}: ${error?.message || error}`
      );
    }
  }
  return result;
}
