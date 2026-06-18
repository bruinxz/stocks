/**
 * preTradeGuards — Batch I (2026-06-17)
 *
 * Shared pre-trade guard helpers used by both PaperTradingFacade.placeOrder
 * (manual / UI) and PaperTradingAutomationService.createBuyTrade /
 * createSellTrade (cron / signal driven).
 *
 * 背景: facade.placeOrder 有完整的 T+1 / PositionLimit / DrawdownCircuitBreaker
 * pre-trade 链路, 但 automation 路径直接走自家的 createBuyTrade / createSellTrade,
 * **跳过这三大 guard**:
 *   - 模拟盘可以当日 BUY → stop_loss 立即 SELL (违反 A 股 T+1, EV 系统性高估)
 *   - automation BUY 不查 PositionLimit (单股/行业/总持仓上限)
 *   - automation BUY 不查 DrawdownCircuitBreaker LEVEL_1 pause
 *
 * 本模块提供 3 个纯 async helper, 抛 statusCode=400 的 err.code 标识违规类型.
 * caller 在 transaction 之外调用, 失败直接 propagate 让 caller 决定 skip 还是 throw.
 */

import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { sequelize } from '../../config/database';
import { PaperTradingTrade } from '../../models/PaperTradingTrade';
import { positionLimitGuard } from '../risk/PositionLimitGuard';
import { drawdownCircuitBreaker, RiskGuardUnavailableError } from '../risk/DrawdownCircuitBreaker';
import {
  handleRiskGuardUnavailable,
  loadProductionRiskAlertCreator,
} from '../risk/RiskGuardFailClosed';
import { logger } from '../../utils/logger';

/**
 * 检查当日 BUY 累计量, 算出 today_buy_qty 与 available_for_sell.
 * 卖超返 false + reason; bypass=true 时直接放行.
 */
export async function checkTPlus1(input: {
  portfolio_id: number;
  symbol: string;
  held_quantity: number;
  sell_quantity: number;
  bypass?: boolean;
}): Promise<{
  ok: boolean;
  today_buy_qty: number;
  available_for_sell: number;
  reason?: string;
}> {
  if (input.bypass) {
    return { ok: true, today_buy_qty: 0, available_for_sell: input.held_quantity };
  }
  const todayStartShanghaiIso = moment().tz('Asia/Shanghai').startOf('day').toDate();
  const agg = await PaperTradingTrade.findOne({
    where: {
      portfolio_id: input.portfolio_id,
      symbol: input.symbol,
      direction: 'BUY',
      created_at: { [Op.gte]: todayStartShanghaiIso },
    },
    attributes: [[sequelize.fn('SUM', sequelize.col('quantity')), 'today_buy_qty']],
    raw: true,
  });
  const todayBuyQty = Number((agg as any)?.today_buy_qty ?? 0);
  const availableForSell = Math.max(0, input.held_quantity - todayBuyQty);
  if (input.sell_quantity > availableForSell) {
    return {
      ok: false,
      today_buy_qty: todayBuyQty,
      available_for_sell: availableForSell,
      reason: `T+1 violation: 当日 BUY ${todayBuyQty} 股不可卖. 持仓 ${input.held_quantity} 中可卖 ${availableForSell} 股, 拟卖 ${input.sell_quantity} 股`,
    };
  }
  return { ok: true, today_buy_qty: todayBuyQty, available_for_sell: availableForSell };
}

/**
 * Pre-trade BUY guard chain — DrawdownCircuitBreaker + PositionLimitGuard.
 * 任一失败抛 err.code 标识, caller skip 该 signal (不阻塞其他).
 *
 * US-011 (PR-006): RiskGuardUnavailable 处理走统一 `handleRiskGuardUnavailable`
 * helper — 与 PaperTradingFacade._placeOrderInner 共享 RiskAlert 文案 + rule_id +
 * caller 标识. PositionLimitGuard 现在也走同款 fail-CLOSED wrap (US-047 路径之前
 * 只有 DrawdownCircuitBreaker 有, 现在两套 guard 行为对齐).
 */
export async function checkPreBuyGuards(input: {
  user_id: number;
  symbol: string;
  proposed_value: number;
}): Promise<{ ok: true } | { ok: false; code: string; reason: string; detail?: any }> {
  // DrawdownCircuitBreaker (LEVEL_1 pause)
  let drawdownResult: {
    ok: boolean;
    reason?: string;
    paused_until?: any;
    is_new_holding?: boolean;
  };
  try {
    drawdownResult = await drawdownCircuitBreaker.checkBuyAllowed({
      user_id: input.user_id,
      symbol: input.symbol,
    });
  } catch (guardErr: any) {
    if (guardErr instanceof RiskGuardUnavailableError) {
      await handleRiskGuardUnavailable({
        err: guardErr,
        user_id: input.user_id,
        symbol: input.symbol,
        callerLabel: 'automation.preTradeGuards',
        dataSource: loadProductionRiskAlertCreator(),
      });
      return {
        ok: false,
        code: 'RISK_GUARD_UNAVAILABLE',
        reason: `风控不可用: ${guardErr.message}`,
        detail: guardErr.detail,
      };
    }
    // 其它 unexpected 错误 fail-CLOSED 处理: 拒单 + log. wrapFailClosed
    // 应该已经把 unexpected error 包成 RiskGuardUnavailableError; 这里只是
    // 兜底防御 (例如非 async 同步 throw 在 await 前栈展开).
    logger.warn(
      `[preTradeGuards] drawdownCircuitBreaker.checkBuyAllowed unexpected err: ${
        guardErr?.message || guardErr
      }`
    );
    return {
      ok: false,
      code: 'RISK_GUARD_UNAVAILABLE',
      reason: `风控异常: ${guardErr?.message || guardErr}`,
    };
  }
  if (!drawdownResult.ok && drawdownResult.reason) {
    return {
      ok: false,
      code: 'DRAWDOWN_BREAKER_PAUSED',
      reason: drawdownResult.reason,
      detail: { paused_until: (drawdownResult as any).paused_until },
    };
  }

  // PositionLimitGuard (单股 / 行业 / 总持仓上限) — US-011 (PR-006): 现在也
  // 抛 RiskGuardUnavailableError 而非 raw Sequelize error.
  let limitResult: { ok: boolean; violation?: any };
  try {
    limitResult = await positionLimitGuard.checkBuyOrder({
      user_id: input.user_id,
      symbol: input.symbol,
      proposed_value: input.proposed_value,
    });
  } catch (guardErr: any) {
    if (guardErr instanceof RiskGuardUnavailableError) {
      await handleRiskGuardUnavailable({
        err: guardErr,
        user_id: input.user_id,
        symbol: input.symbol,
        callerLabel: 'automation.preTradeGuards',
        dataSource: loadProductionRiskAlertCreator(),
      });
      return {
        ok: false,
        code: 'RISK_GUARD_UNAVAILABLE',
        reason: `风控不可用: ${guardErr.message}`,
        detail: guardErr.detail,
      };
    }
    logger.warn(
      `[preTradeGuards] positionLimitGuard.checkBuyOrder unexpected err: ${
        guardErr?.message || guardErr
      }`
    );
    return {
      ok: false,
      code: 'RISK_GUARD_UNAVAILABLE',
      reason: `风控异常: ${guardErr?.message || guardErr}`,
    };
  }
  if (!limitResult.ok && limitResult.violation) {
    return {
      ok: false,
      code: 'POSITION_LIMIT_VIOLATION',
      reason: limitResult.violation.message,
      detail: { rule: limitResult.violation.rule, ...limitResult.violation.detail },
    };
  }
  return { ok: true };
}
