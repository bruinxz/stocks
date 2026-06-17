/**
 * PaperTradingFacade — US-003
 *
 * Single entry point for all PaperTrading operations exposed to the controller
 * layer.  Internally orchestrates the 8 historical PaperTrading* services that
 * now live under `./internal/`.  Controllers MUST only import this file (and
 * the re-exported constants) — never the internal services directly.
 *
 * The facade exposes exactly **seven public methods** as required by the
 * acceptance criteria:
 *
 *  1. getPortfolio       — portfolio + position views (basic / autonomous / recommendation tracking)
 *  2. placeOrder         — manual order entry (buy / sell)
 *  3. closePosition      — explicit full-position close
 *  4. getDailySnapshot   — equity curve + trade history + snapshot refresh
 *  5. attributePnl       — P&L attribution + autonomous-loop optimization + feishu report
 *  6. applyAutomation    — every "do something" run (auto buy / sync / risk / plan / tuning / hindsight)
 *  7. getRiskProfile     — risk view incl. order-intent dashboards / tuning canary status
 *
 * Each method takes a single `options` argument with an `action` /  `view`
 * discriminator so the controller can multiplex without growing the public
 * surface.  This keeps the facade a true "narrow waist" between the HTTP layer
 * and the internal services.
 */

import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../models/PaperTradingSnapshot';
import { Stock } from '../models/Stock';
import { DataService } from '../data/services/DataService';
import { logger } from '../utils/logger';
import { sequelize } from '../config/database';
import { Op } from 'sequelize';
import moment from 'moment-timezone';

import {
  paperTradingAutomationService,
  DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
} from './internal/PaperTradingAutomationService';
import { paperTradingAttributionService } from './internal/PaperTradingAttributionService';
import {
  paperTradingDashboardService,
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
  QUANT_ONLY_PORTFOLIO_NAME,
} from './internal/PaperTradingDashboardService';
import { paperTradingPlanService } from './internal/PaperTradingPlanService';
import { paperTradingRiskProfileService } from './internal/PaperTradingRiskProfileService';
import { paperTradingOrderIntentService } from './internal/PaperTradingOrderIntentService';
import { paperTradingTuningApplyService } from './internal/PaperTradingTuningApplyService';
import { recommendationTradeOutcomeService } from '../services/RecommendationTradeOutcomeService';
import { positionLimitGuard } from './risk/PositionLimitGuard';
import { drawdownCircuitBreaker } from './risk/DrawdownCircuitBreaker';
import { perStockStopLossGuard, pickEffectivePct } from './risk/PerStockStopLossGuard';
import { incrementOrderTotal } from '../metrics/PrometheusRegistry';

// Re-export the small set of constants the controller still needs literal access
// to (default capital, portfolio name keys for downstream services).  This is the
// ONLY surface the controller layer is allowed to consume aside from the facade
// instance itself.
export {
  DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
  QUANT_ONLY_PORTFOLIO_NAME,
};

// ---------------------------------------------------------------------------
//  Type discriminators
// ---------------------------------------------------------------------------

export type GetPortfolioView = 'basic' | 'autonomous_dashboard' | 'recommendation_tracking';

export interface GetPortfolioOptions {
  view?: GetPortfolioView;
  user_id?: number;
  username?: string;
  query?: Record<string, any>;
  /** 显式 portfolio_id, 多账户多盘场景必须传 (修复 2026-06-17 串盘 bug). */
  portfolio_id?: number;
}

export interface PlaceOrderOptions {
  user_id: number;
  symbol: string;
  direction: 'BUY' | 'SELL';
  quantity: number;
  /**
   * 显式 portfolio_id (强烈建议传). 不传时 facade fallback 到 user 名下第一个 active portfolio,
   * 多账户多盘场景会串盘. 修复 (2026-06-16): user_id=4 有 9 个 portfolio, 不传 portfolio_id
   * 会路由到 portfolio 24 系统观测盘(空仓) → 错卖错买.
   */
  portfolio_id?: number;
  /** 跳过交易时段 guard (测试/回填用) */
  bypass_trading_hours?: boolean;
  /** 跳过 T+1 拦截 (测试用) */
  bypass_t_plus_1?: boolean;
}

export interface ClosePositionOptions {
  user_id: number;
  symbol: string;
  /** 同 PlaceOrderOptions: 强烈建议显式传 portfolio_id 避免多账户串盘. */
  portfolio_id?: number;
  bypass_trading_hours?: boolean;
  bypass_t_plus_1?: boolean;
}

export type GetDailySnapshotAction = 'list' | 'trades' | 'refresh';

export interface GetDailySnapshotOptions {
  action?: GetDailySnapshotAction;
  user_id: number;
  /** 显式 portfolio_id, 多账户多盘场景必须传 */
  portfolio_id?: number;
}

export type AttributePnlAction =
  | 'compute'
  | 'report'
  | 'autonomous_optimization'
  | 'recommendation_outcomes'
  | 'recommendation_outcome_trace'
  | 'refresh_recommendation_outcomes'
  | 'report_recommendation_outcomes';

export interface AttributePnlOptions {
  action?: AttributePnlAction;
  user_id: number;
  username?: string;
  query?: Record<string, any>;
  body?: Record<string, any>;
  params?: Record<string, any>;
}

export type ApplyAutomationAction =
  | 'auto_buy'
  | 'auto_sync'
  | 'risk_check'
  | 'autonomous_auto_sync'
  | 'autonomous_risk_check'
  | 'plan'
  | 'plan_report'
  | 'tuning_apply'
  | 'tuning_rollback'
  | 'hindsight_refresh'
  | 'set_stop_loss'
  | 'set_take_profit'
  | 'per_stock_stop_loss_check';

export interface ApplyAutomationOptions {
  action: ApplyAutomationAction;
  user_id: number;
  username?: string;
  body?: Record<string, any>;
}

export type GetRiskProfileView =
  | 'profile'
  | 'intents'
  | 'intent_family_hindsight'
  | 'intent_trace'
  | 'tuning_canary'
  | 'tuning_candidates'
  | 'tuning_canary_snapshots';

export interface GetRiskProfileOptions {
  view?: GetRiskProfileView;
  user_id: number;
  username?: string;
  query?: Record<string, any>;
  params?: Record<string, any>;
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const toNumber = (value: any, fallback = 0): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const roundMoney = (value: any): number => Math.round(toNumber(value, 0) * 100) / 100;

const withAutonomousPortfolio = (payload: Record<string, any> = {}) => {
  // Batch I (2026-06-17): 防 body 注入 portfolio_id/portfolio_name 劫持 autonomous 盘.
  // 之前 spread payload 后只硬编码 portfolio_name; 但 portfolio_id 仍可被 body 注入 →
  // autoBuyFromSignals 优先用 portfolio_id 路由到任意盘. 现在显式剥掉 portfolio_id.
  const { portfolio_id: _stripPid, portfolio_name: _stripPname, ...rest } = payload;
  void _stripPid;
  void _stripPname;
  return {
    ...rest,
    portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
    initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
    use_autonomous_portfolio: true,
  };
};

/**
 * US-072: 把 legacy un-coded throw（`new Error('可用资金不足')` 等）归一化成稳定的
 * Prometheus label 码 —— 避免 message string 漂移让 `order_total{code=...}` 时间序列
 * 爆炸。新增 err.code 的 throw 优先用 err.code；只在 fallback 路径才靠 message。
 */
export function inferOrderFailureCode(message: unknown): string | null {
  if (typeof message !== 'string' || !message) return null;
  if (message.includes('无效的交易参数')) return 'INVALID_PARAMS';
  if (message.includes('方向必须为')) return 'INVALID_DIRECTION';
  if (message.includes('无法获取该股票的当前价格')) return 'PRICE_UNAVAILABLE';
  if (message.includes('可用资金不足')) return 'INSUFFICIENT_FUNDS';
  if (message.includes('持仓不足')) return 'INSUFFICIENT_HOLDING';
  if (message.includes('未找到模拟盘')) return 'PORTFOLIO_NOT_FOUND';
  if (message.includes('无持仓')) return 'NO_POSITION';
  return null;
}

// ---------------------------------------------------------------------------
//  Facade
// ---------------------------------------------------------------------------

export class PaperTradingFacade {
  private dataService: DataService;

  constructor() {
    this.dataService = new DataService();
  }

  // -------------------------------------------------------------------------
  //  1. getPortfolio
  // -------------------------------------------------------------------------
  /**
   * Returns the user's portfolio overview in one of three shapes depending on
   * `options.view`:
   *   - 'basic' (default): the user's portfolio + positions with refreshed
   *     prices (used by the legacy `/api/paper-trading/portfolio` endpoint).
   *   - 'autonomous_dashboard': the 20W autonomous-loop dashboard payload.
   *   - 'recommendation_tracking': the daily recommendation tracking payload.
   */
  async getPortfolio(options: GetPortfolioOptions) {
    const view = options.view || 'basic';
    const user_id = options.user_id;
    const username = options.username;

    if (view === 'autonomous_dashboard') {
      const result = await paperTradingDashboardService.getAutonomousDashboard({
        ...(options.query || {}),
        user_id,
        username,
      } as any);
      return result;
    }

    if (view === 'recommendation_tracking') {
      const result = await paperTradingDashboardService.getRecommendationTracking({
        ...(options.query || {}),
        user_id,
        username,
      } as any);
      return result;
    }

    // Default: basic view — preserves the existing controller behaviour exactly
    // so manual page loads (positions list with refreshed prices) keep working.
    if (!user_id) {
      throw new Error('getPortfolio: user_id is required for basic view');
    }

    // 修复 (2026-06-17): UI 串盘 bug. 之前 findOne({user_id}) 不带 order, user 4 有 9 个
    // portfolio, Sequelize 任意返回 1 行 → 每次刷新展示不同的盘 (持仓数 / 浮盈一直变).
    // 优先 portfolio_id; 缺则按 (user_id, is_active=true, id ASC) 取第一个并记 warn.
    // Batch G (2026-06-17): 传了 portfolio_id 但不属于 user, 必须 404,
    // 不能 fallback 到 create —— 否则攻击者循环 ?portfolio_id=随机大数 DoS
    // 创建空 portfolio (C2 修复).
    let portfolio: PaperTradingPortfolio | null;
    if (options.portfolio_id) {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { id: options.portfolio_id, user_id },
      });
      if (!portfolio) {
        const err: any = new Error('未找到模拟盘或无权访问');
        err.statusCode = 404;
        err.code = 'PORTFOLIO_NOT_FOUND_OR_FORBIDDEN';
        throw err;
      }
    } else {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id, is_active: true },
        order: [['id', 'ASC']],
      });
      if (portfolio) {
        logger.warn(
          `[facade.getPortfolio] user_id=${user_id} 未传 portfolio_id, 默认取 portfolio ${portfolio.id} (${portfolio.name}). 前端应该通过 ?portfolio_id=X 显式指定.`
        );
      }
    }
    if (!portfolio) {
      // 只在 caller 完全没传 portfolio_id 时才 first-time create
      const fallbackName = username || 'User';
      portfolio = await PaperTradingPortfolio.create({
        user_id,
        name: `${fallbackName}的模拟盘`,
        initial_capital: DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
        current_cash: DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
        total_value: DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
        is_active: true,
      });
    }

    const positions = await PaperTradingPosition.findAll({
      where: { portfolio_id: portfolio.id },
      // 按 id ASC 排序保证持仓表显示顺序稳定（开仓时间早→晚）；
      // PostgreSQL 默认无 stable order，否则前端每次刷新行次序都会变。
      order: [['id', 'ASC']],
    });

    let totalMarketValue = 0;
    const updatedPositions = await Promise.all(
      positions.map(async pos => {
        try {
          const bars = await this.dataService.getDailyBars(
            pos.symbol,
            new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            new Date()
          );
          if (bars && bars.length > 0) {
            const current_price = toNumber(
              bars[bars.length - 1].close,
              toNumber(pos.current_price)
            );
            const quantity = toNumber(pos.quantity);
            const avg_cost = toNumber(pos.avg_cost);
            const market_value = roundMoney(current_price * quantity);
            const unrealized_pnl = roundMoney(market_value - avg_cost * quantity);

            pos.current_price = current_price;
            pos.market_value = market_value;
            pos.unrealized_pnl = unrealized_pnl;
            await pos.save();
          }
          totalMarketValue += toNumber(pos.market_value);
          return pos;
        } catch (e) {
          logger.error(`获取股票 ${pos.symbol} 价格失败`, e);
          totalMarketValue += toNumber(pos.market_value);
          return pos;
        }
      })
    );

    portfolio.total_value = roundMoney(toNumber(portfolio.current_cash) + totalMarketValue);
    await portfolio.save();

    return { portfolio, positions: updatedPositions };
  }

  // -------------------------------------------------------------------------
  //  2. placeOrder
  // -------------------------------------------------------------------------
  /**
   * Place a single BUY or SELL order against the user's portfolio.  Mirrors the
   * legacy `placeTrade` controller method bit-for-bit so the existing
   * `POST /api/paper-trading/trade` endpoint is unchanged.
   *
   * US-072: emits `order_total{direction,status,code}` Prometheus counter via the
   * outer try/catch wrapper.  `code` mirrors the err.code thrown by guards
   * (POSITION_LIMIT_VIOLATION / DRAWDOWN_BREAKER_PAUSED / PER_STOCK_STOP_LOSS_PAUSED),
   * or a normalized label inferred from err.message for the legacy un-coded throws.
   */
  async placeOrder(options: PlaceOrderOptions) {
    const direction = options?.direction || 'unknown';
    try {
      const result = await this._placeOrderInner(options);
      incrementOrderTotal(direction, 'success', 'ok');
      return result;
    } catch (error: any) {
      const code =
        error?.code ||
        (error?.statusCode === 404 ? 'NOT_FOUND' : inferOrderFailureCode(error?.message)) ||
        'unknown';
      incrementOrderTotal(direction, 'failed', code);
      throw error;
    }
  }

  private async _placeOrderInner(options: PlaceOrderOptions) {
    const { user_id, symbol, direction, quantity } = options;

    if (!symbol || !direction || !quantity || quantity <= 0) {
      throw new Error('无效的交易参数');
    }
    if (direction !== 'BUY' && direction !== 'SELL') {
      throw new Error('交易方向必须为 BUY 或 SELL');
    }

    // ============= 交易时段 guard =============
    // 模拟盘按 daily_bar.close 撮合 → 必须在合法时间内调用：
    //   (a) A 股交易日（工作日 + 非节假日, 用 tradingCalendar 判断）
    //   (b) 09:30 - 11:30 + 13:00 - 15:00 Asia/Shanghai (真实开盘到收盘)
    //       注意：09:00-09:30 是集合竞价时段，真实撮合 09:25，不允许下单
    //       午休 11:30-13:00 也不允许（实盘也不撮合）
    //   (c) 允许 bypass：options.bypass_trading_hours=true（手动测试/历史回填用）
    if (!(options as any).bypass_trading_hours) {
      const now = new Date();
      // Asia/Shanghai = UTC+8
      const shanghaiOffset = 8 * 60 * 60 * 1000;
      const shanghai = new Date(now.getTime() + shanghaiOffset);
      const hour = shanghai.getUTCHours();
      const minute = shanghai.getUTCMinutes();
      const totalMinutes = hour * 60 + minute;
      // A 股交易时段（Asia/Shanghai）：09:30-11:30 + 13:00-15:00
      const MORNING_START = 9 * 60 + 30; // 09:30
      const MORNING_END = 11 * 60 + 30; // 11:30
      const AFTERNOON_START = 13 * 60; // 13:00
      const AFTERNOON_END = 15 * 60; // 15:00
      // 1. 节假日 / 周末感知（用 tradingCalendar 比单纯判周末更准）
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { isAShareTradeDay, explainNonTradeDay } = require('../utils/tradingCalendar');
      if (!isAShareTradeDay(now)) {
        const reason = explainNonTradeDay(now) || '非 A 股交易日';
        const err: any = new Error(
          `${reason}, A 股不开市; 如需手动测试请加 bypass_trading_hours=true`
        );
        err.code = 'NON_TRADING_HOURS_HOLIDAY';
        err.statusCode = 400;
        throw err;
      }
      const inMorning = totalMinutes >= MORNING_START && totalMinutes < MORNING_END;
      const inAfternoon = totalMinutes >= AFTERNOON_START && totalMinutes < AFTERNOON_END;
      if (!inMorning && !inAfternoon) {
        const hh = String(hour).padStart(2, '0');
        const mm = String(minute).padStart(2, '0');
        let reason = '在 A 股交易时段 (09:30-11:30 / 13:00-15:00) 外';
        if (totalMinutes >= 9 * 60 && totalMinutes < MORNING_START) reason = '集合竞价时段 (09:00-09:30)，等待 09:30 开盘后再下单';
        else if (totalMinutes >= MORNING_END && totalMinutes < AFTERNOON_START) reason = '午休时段 (11:30-13:00)';
        else if (totalMinutes >= AFTERNOON_END) reason = '已收盘 (>15:00)';
        else if (totalMinutes < 9 * 60) reason = '尚未开盘 (<09:00)';
        const err: any = new Error(
          `当前 ${hh}:${mm} (Asia/Shanghai) ${reason}；如需手动测试请加 bypass_trading_hours=true`
        );
        err.code = 'NON_TRADING_HOURS_OFF_HOURS';
        err.statusCode = 400;
        throw err;
      }
    }

    // ============= portfolio 路由 =============
    // 修复 (2026-06-16, CRITICAL C2): facade 之前 PaperTradingPortfolio.findOne({where:{user_id}})
    // 不带 order, Sequelize 任意返回第一行. user_id=4 有 9 个 portfolio (24/33-40),
    // 导致 IndustryConcentrationGuard.rebalanceIndustry(user_id=4) 实际平掉 portfolio 24
    // (系统观测盘空仓) 而不是当事策略 portfolio. 强制 caller 显式传 portfolio_id, 不传 fallback
    // 到 (user_id, id ASC) 第一个 — 即"系统观测盘" 路径保留兼容, 但日志告警.
    let portfolio: PaperTradingPortfolio | null;
    if (options.portfolio_id) {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { id: options.portfolio_id, user_id },
      });
    } else {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id },
        order: [['id', 'ASC']],
      });
      if (portfolio) {
        logger.warn(
          `[facade.placeOrder] user_id=${user_id} 未显式传 portfolio_id, 默认取 portfolio ${portfolio.id} (${portfolio.name}); ` +
            `多账户多盘场景建议 caller 显式传 portfolio_id 避免串盘`
        );
      }
    }
    if (!portfolio) {
      const err: any = new Error('未找到模拟盘，请先刷新页面');
      err.statusCode = 404;
      throw err;
    }

    const bars = await this.dataService.getDailyBars(
      symbol,
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      new Date()
    );
    if (!bars || bars.length === 0) {
      throw new Error('无法获取该股票的当前价格');
    }
    const current_price = bars[bars.length - 1].close;
    const stockInfo = await Stock.findOne({ where: { symbol } });
    const stockName = stockInfo ? stockInfo.name : symbol;

    const commissionRate = 0.0003;
    const slippage = 0.001;

    if (direction === 'BUY') {
      const execute_price = current_price * (1 + slippage);
      const cost = execute_price * quantity;
      const commission = cost * commissionRate;
      const totalCost = cost + commission;

      // ---- US-049: Drawdown circuit breaker LEVEL_1 pause ----
      // If the portfolio is in an active LEVEL_1 pause window (peak-drawdown
      // ≥ 10% triggered by the EOD evaluator), block NEW openings.  Adding to
      // existing positions is allowed (covers策略 add-on without forcing
      // operators to manually clear the pause for every routine top-up).
      // Failure-open: a DB outage in the guard simply lets the order proceed —
      // upstream `cash check` + `position-limit guard` still gate it.
      const breakerResult = await drawdownCircuitBreaker.checkBuyAllowed({
        user_id,
        symbol,
      });
      if (!breakerResult.ok && breakerResult.reason) {
        const err: any = new Error(breakerResult.reason);
        err.statusCode = 400;
        err.code = 'DRAWDOWN_BREAKER_PAUSED';
        err.paused_until = breakerResult.paused_until;
        throw err;
      }

      // ---- US-047: Position limit guard ----
      // Run BEFORE the cash check so that a position-limit violation is
      // reported as a "仓位上限" issue rather than an "可用资金不足" one.
      // `cost` (execute_price × quantity, ex-commission) is the right
      // notional to compare against `max_single_stock_pct` since commission
      // doesn't accrue to the position's market value.
      const guardResult = await positionLimitGuard.checkBuyOrder({
        user_id,
        symbol,
        proposed_value: cost,
      });
      if (!guardResult.ok && guardResult.violation) {
        const err: any = new Error(guardResult.violation.message);
        err.statusCode = 400;
        err.code = 'POSITION_LIMIT_VIOLATION';
        err.rule = guardResult.violation.rule;
        err.detail = guardResult.violation.detail;
        throw err;
      }

      if (portfolio.current_cash < totalCost) {
        throw new Error('可用资金不足');
      }

      // ============= 事务保护 (修复 CRITICAL C1/C3) =============
      // 之前 position + portfolio + trade 三个 write 没事务, 任一步崩 → 资金/持仓/流水不一致.
      // 加 SELECT FOR UPDATE 锁 portfolio 避免并发 BUY 共享 stale cash.
      const result = await sequelize.transaction(async t => {
        const lockedPortfolio = await PaperTradingPortfolio.findByPk(portfolio.id, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!lockedPortfolio) throw new Error('facade.placeOrder: portfolio 不存在');
        const realCash = Number(lockedPortfolio.current_cash) || 0;
        if (realCash < totalCost) throw new Error('可用资金不足 (并发 BUY 占用)');

        const position = await PaperTradingPosition.findOne({
          where: { portfolio_id: portfolio.id, symbol },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (position) {
          const totalCostBasis = position.avg_cost * position.quantity + cost;
          position.quantity += quantity;
          position.avg_cost = totalCostBasis / position.quantity;
          position.current_price = current_price;
          position.market_value = position.quantity * current_price;
          position.unrealized_pnl = position.market_value - position.avg_cost * position.quantity;
          // 修复 CRITICAL #3 (2026-06-16): 加仓后用 user.risk_config.per_stock_stop_loss.pct
          // 重算 stop_loss_price, 不再硬编码 7%. 三级覆盖 (position.stop_loss_pct →
          // user config → DEFAULT 7%) 与 PerStockStopLossGuard.pickEffectivePct 同源.
          // trailing high_price 不动 (历史最高不该回拉).
          const oldStop = position.stop_loss_price;
          if (oldStop !== null && oldStop !== undefined && position.avg_cost > 0) {
            // 取 user.risk_config.per_stock_stop_loss.pct (allow fail-open default 7%)
            let userPct: number | null = null;
            try {
              const cfg = await perStockStopLossGuard.getConfig(user_id);
              userPct = cfg?.pct ?? null;
            } catch {
              userPct = null;
            }
            const effectivePct = pickEffectivePct(
              (position as any).stop_loss_pct ?? null,
              userPct
            );
            position.stop_loss_price = Number(
              (position.avg_cost * (1 - effectivePct)).toFixed(4)
            );
          }
          await position.save({ transaction: t });
        } else {
          await PaperTradingPosition.create(
            {
              portfolio_id: portfolio.id,
              symbol,
              name: stockName,
              quantity,
              avg_cost: execute_price,
              current_price,
              market_value: quantity * current_price,
              unrealized_pnl: quantity * current_price - cost,
            },
            { transaction: t }
          );
        }

        lockedPortfolio.current_cash = realCash - totalCost;
        await lockedPortfolio.save({ transaction: t });
        // 修复 CRITICAL #9 (2026-06-16): 不在 tx 内 mutate caller's portfolio.current_cash —
        // tx 若回滚, mutated 值会留在内存里造成 caller stale read. 移到 tx commit 之后.

        await PaperTradingTrade.create(
          {
            portfolio_id: portfolio.id,
            symbol,
            name: stockName,
            direction: 'BUY',
            execute_price,
            quantity,
            amount: cost,
            commission,
          },
          { transaction: t }
        );
        return {
          direction: 'BUY' as const,
          symbol,
          quantity,
          execute_price,
          commission,
          _newCash: lockedPortfolio.current_cash, // 让 tx 外 sync caller
        };
      });
      // 修复 CRITICAL #9: tx commit 成功后才 sync 到 caller 的内存对象
      portfolio.current_cash = (result as any)._newCash;
      const { _newCash: _, ...returnResult } = result as any;
      return returnResult;
    }

    // SELL branch
    const position = await PaperTradingPosition.findOne({
      where: { portfolio_id: portfolio.id, symbol },
    });
    if (!position || position.quantity < quantity) {
      throw new Error('持仓不足，无法卖出');
    }

    // ============= T+1 拦截 (修复 CRITICAL C5) =============
    // A 股当日 BUY 不可当日 SELL. Batch I (2026-06-17): 抽到 preTradeGuards.checkTPlus1
    // 共享, automation createSellTrade 同款用. bypass_t_plus_1=true 时跳过.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { checkTPlus1 } = require('./internal/preTradeGuards');
    const tPlus1 = await checkTPlus1({
      portfolio_id: portfolio.id,
      symbol,
      held_quantity: Number(position.quantity) || 0,
      sell_quantity: quantity,
      bypass: options.bypass_t_plus_1 === true,
    });
    if (!tPlus1.ok) {
      const err: any = new Error(tPlus1.reason || 'T+1 violation');
      err.statusCode = 400;
      err.code = 'T_PLUS_1_VIOLATION';
      err.detail = {
        holding: position.quantity,
        today_buy: tPlus1.today_buy_qty,
        available: tPlus1.available_for_sell,
        requested: quantity,
      };
      throw err;
    }

    const execute_price = current_price * (1 - slippage);
    const revenue = execute_price * quantity;
    const baseCommission = revenue * commissionRate;
    // 修复 (CRITICAL C4): A 股 SELL 印花税单边千 1 (BUY 不收). 漏算导致 realized_pnl
    // 高估 0.1%, EV 反算 edge 偏乐观. SELL commission 包含 broker commission + stamp_tax.
    const stampTax = revenue * 0.001;
    const commission = baseCommission + stampTax;
    const netRevenue = revenue - commission;
    const avg_cost = position.avg_cost;
    const positionId = position.id;
    const positionCreatedAtSnapshot = position.created_at;

    // ============= 事务保护 (修复 CRITICAL C1/C3) =============
    const result = await sequelize.transaction(async t => {
      const lockedPortfolio = await PaperTradingPortfolio.findByPk(portfolio.id, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!lockedPortfolio) throw new Error('facade.placeOrder(SELL): portfolio 不存在');
      const lockedPosition = await PaperTradingPosition.findByPk(positionId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!lockedPosition) throw new Error('facade.placeOrder(SELL): position 已被并发删除');
      if (lockedPosition.quantity < quantity) {
        throw new Error('持仓不足，无法卖出 (并发 SELL 已扣减)');
      }

      if (lockedPosition.quantity === quantity) {
        await lockedPosition.destroy({ transaction: t });
      } else {
        lockedPosition.quantity -= quantity;
        // 修复 (M1): 不写 current_price = execute_price, 保留 quote 同步的最新价
        lockedPosition.market_value = lockedPosition.quantity * lockedPosition.current_price;
        lockedPosition.unrealized_pnl =
          lockedPosition.market_value - lockedPosition.avg_cost * lockedPosition.quantity;
        await lockedPosition.save({ transaction: t });
      }

      lockedPortfolio.current_cash = Number(lockedPortfolio.current_cash) + netRevenue;
      await lockedPortfolio.save({ transaction: t });
      // 修复 CRITICAL #9 (2026-06-16): tx 内不 mutate caller portfolio, 通过 result 返出

      // 修复 CRITICAL #2 (2026-06-16): realized_pnl 公式漏 BUY commission.
      // 实盘正确: pnl = (sell_revenue - sell_commission) - (buy_amount + buy_commission)
      // avg_cost 不含 BUY commission (createBuyTrade 写 execute_price 单纯成交价).
      // 估算 buy_commission ≈ avg_cost × quantity × commissionRate.
      const estimatedBuyCommission = avg_cost * quantity * commissionRate;
      const realized_pnl = revenue - avg_cost * quantity - commission - estimatedBuyCommission;
      const trade = await PaperTradingTrade.create(
        {
          portfolio_id: portfolio.id,
          symbol,
          name: stockName,
          direction: 'SELL',
          execute_price,
          quantity,
          amount: revenue,
          commission,
          realized_pnl,
        },
        { transaction: t }
      );
      return {
        direction: 'SELL' as const,
        symbol,
        quantity,
        execute_price,
        commission,
        realized_pnl,
        trade_id: trade.id,
        _newCash: Number(lockedPortfolio.current_cash), // 让 tx 外 sync caller
      };
    });

    // 修复 CRITICAL #9: tx commit 成功后再 sync caller portfolio
    portfolio.current_cash = (result as any)._newCash;

    // ============= 修复 (CRITICAL C1): SELL 后触发 outcome 闭环刷新 =============
    // 之前 facade SELL 不调任何 outcome 更新, UI 手动卖 + 行业再平衡的 outcome 永远 'open'.
    // fire-and-forget — 失败不阻塞 SELL trade 已落库.
    try {
      // 找该 portfolio 对应 symbol 还 open 的 outcome.signal_id, 触发刷新
      const { RecommendationTradeOutcome } = require('../models/RecommendationTradeOutcome');
      const openOutcomes = await RecommendationTradeOutcome.findAll({
        where: { portfolio_id: portfolio.id, symbol, trade_status: 'open' },
        attributes: ['signal_id'],
        raw: true,
        limit: 5,
      });
      for (const row of openOutcomes as Array<{ signal_id: number }>) {
        if (row.signal_id) {
          recommendationTradeOutcomeService
            .refreshOutcomeBySignal(row.signal_id)
            .catch((err: any) =>
              logger.warn(
                `[facade SELL] outcome refresh failed (signal=${row.signal_id}): ${
                  err?.message || err
                }`
              )
            );
        }
      }
    } catch (err: any) {
      logger.warn(`[facade SELL] outcome refresh lookup failed: ${err?.message || err}`);
    }

    void positionCreatedAtSnapshot; // (consumed by T+1 guard above)
    // 修复 CRITICAL #9: 剥掉 internal _newCash 不返给 caller
    const { _newCash: _, ...returnResult } = result as any;
    return returnResult;
  }

  // -------------------------------------------------------------------------
  //  3. closePosition
  // -------------------------------------------------------------------------
  /**
   * Close the entire current position of `symbol` at the latest available
   * price.  Convenience wrapper around `placeOrder({ direction: 'SELL', quantity: full })`.
   */
  async closePosition(options: ClosePositionOptions) {
    // 修复 (2026-06-16, CRITICAL C2): 同 placeOrder, 优先 portfolio_id, 缺则 user_id 第一个.
    let portfolio: PaperTradingPortfolio | null;
    if (options.portfolio_id) {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { id: options.portfolio_id, user_id: options.user_id },
      });
    } else {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id: options.user_id },
        order: [['id', 'ASC']],
      });
      if (portfolio) {
        logger.warn(
          `[facade.closePosition] user_id=${options.user_id} 未传 portfolio_id, 默认 portfolio ${portfolio.id} (${portfolio.name})`
        );
      }
    }
    if (!portfolio) {
      const err: any = new Error('未找到模拟盘');
      err.statusCode = 404;
      throw err;
    }
    const position = await PaperTradingPosition.findOne({
      where: { portfolio_id: portfolio.id, symbol: options.symbol },
    });
    if (!position || position.quantity <= 0) {
      throw new Error('当前无持仓，无法平仓');
    }
    return this.placeOrder({
      user_id: options.user_id,
      portfolio_id: portfolio.id, // 显式传, 避免 placeOrder 重新 fallback 路由错盘
      symbol: options.symbol,
      direction: 'SELL',
      quantity: position.quantity,
      bypass_trading_hours: options.bypass_trading_hours,
      bypass_t_plus_1: options.bypass_t_plus_1,
    });
  }

  // -------------------------------------------------------------------------
  //  4. getDailySnapshot
  // -------------------------------------------------------------------------
  /**
   * Returns daily snapshots (equity curve), trade history, or triggers a fresh
   * snapshot write depending on `options.action`.
   */
  async getDailySnapshot(options: GetDailySnapshotOptions) {
    const action = options.action || 'list';
    const user_id = options.user_id;

    // 修复 (2026-06-17): 同 getPortfolio, 防 UI 串盘
    let portfolio: PaperTradingPortfolio | null;
    if (options.portfolio_id) {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { id: options.portfolio_id, user_id },
      });
    } else {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id, is_active: true },
        order: [['id', 'ASC']],
      });
      if (portfolio) {
        logger.warn(
          `[facade.getDailySnapshot] user_id=${user_id} 未传 portfolio_id, 默认取 portfolio ${portfolio.id} (${portfolio.name})`
        );
      }
    }
    if (!portfolio) {
      const err: any = new Error('未找到模拟盘');
      err.statusCode = 404;
      throw err;
    }

    if (action === 'trades') {
      const trades = await PaperTradingTrade.findAll({
        where: { portfolio_id: portfolio.id },
        order: [['created_at', 'DESC']],
        limit: 100,
      });
      return trades;
    }

    if (action === 'refresh') {
      const snapshot = await paperTradingAutomationService.syncLatestPricesAndSnapshot(
        portfolio.id
      );
      return snapshot;
    }

    // Default list view — ensure at least one row exists so the chart is never
    // empty (mirrors legacy controller behaviour for first-time users).
    const count = await PaperTradingSnapshot.count({ where: { portfolio_id: portfolio.id } });
    if (count === 0) {
      const todayStr = new Date().toISOString().split('T')[0];
      const fallbackCapital =
        Number(portfolio.total_value) ||
        Number(portfolio.initial_capital) ||
        DEFAULT_PAPER_TRADING_INITIAL_CAPITAL;
      const fallbackCash =
        Number(portfolio.current_cash) ||
        Number(portfolio.initial_capital) ||
        DEFAULT_PAPER_TRADING_INITIAL_CAPITAL;
      await PaperTradingSnapshot.create({
        portfolio_id: portfolio.id,
        date: todayStr,
        total_value: fallbackCapital,
        current_cash: fallbackCash,
        position_value: fallbackCapital - fallbackCash,
      });
    }

    const snapshots = await PaperTradingSnapshot.findAll({
      where: { portfolio_id: portfolio.id },
      order: [['date', 'ASC']],
    });
    return snapshots;
  }

  // -------------------------------------------------------------------------
  //  5. attributePnl
  // -------------------------------------------------------------------------
  /**
   * P&L attribution.  By default returns the standard attribution dashboard;
   * with `action: 'report'` it pushes the same payload to Feishu, with
   * `action: 'autonomous_optimization'` it routes through the recommendation
   * outcome optimization view, and the `recommendation_outcomes*` actions wrap
   * the cross-portfolio outcome tracker.
   */
  async attributePnl(options: AttributePnlOptions) {
    const action = options.action || 'compute';
    const user_id = options.user_id;
    const username = options.username;

    if (action === 'report') {
      return paperTradingAttributionService.reportAttribution({
        ...(options.body || {}),
        user_id,
      });
    }

    if (action === 'autonomous_optimization') {
      return recommendationTradeOutcomeService.getOptimizationDashboard(
        withAutonomousPortfolio({
          ...(options.query || {}),
          user_id,
          username,
        }) as any
      );
    }

    if (action === 'recommendation_outcomes') {
      // 修复 (2026-06-17 串盘续): 之前硬注 portfolio_name: QUANT_ONLY_PORTFOLIO_NAME 把所有
      // 用户都锁到 portfolio 33, 8 盘只看到 1 盘的 outcome. 现在 caller (controller) 应该
      // 把 query.portfolio_id 传进来; 缺时 service.resolvePortfolio 走 user 名下 active
      // id ASC 第一个 fallback. 不再硬锁 portfolio 名.
      return recommendationTradeOutcomeService.getDashboard({
        ...(options.query || {}),
        user_id,
      });
    }

    if (action === 'recommendation_outcome_trace') {
      const id = options.params?.id;
      // 修复 (2026-06-17 串盘续): trace 不应按 portfolio_name 锁定, 应直接按 outcome.id lookup,
      // 跨 portfolio 也能查 (outcome 已自带 portfolio_id, getTrace 内部用)
      return recommendationTradeOutcomeService.getTrace(String(id), {
        ...(options.query || {}),
        user_id,
      });
    }

    if (action === 'refresh_recommendation_outcomes') {
      // 修复 (2026-06-17 串盘续): 缺 portfolio_id 时, service 已加 all_portfolios=true 默认
      // 遍历所有 active portfolio (commit 1a6f2e8). 这里去掉硬锁让 caller 决定 scope.
      return recommendationTradeOutcomeService.refreshPortfolioOutcomes({
        ...(options.body || {}),
        user_id,
      });
    }

    if (action === 'report_recommendation_outcomes') {
      // 修复 (2026-06-17 串盘续): 同款去硬锁
      return recommendationTradeOutcomeService.getDashboard({
        ...(options.body || {}),
        user_id,
        report_to_feishu: true,
      });
    }

    // Default: compute
    return paperTradingAttributionService.getAttribution({
      ...(options.query || {}),
      user_id,
    });
  }

  // -------------------------------------------------------------------------
  //  6. applyAutomation
  // -------------------------------------------------------------------------
  /**
   * Single entry point for every automation run the controller exposes
   * (auto-buy / auto-sync / risk-check / autonomous variants / plan generation
   * / order-intent tuning / hindsight refresh).  The `action` discriminator
   * routes to the correct internal service.
   */
  async applyAutomation(options: ApplyAutomationOptions) {
    const { action, user_id, username, body = {} } = options;

    // US-083: pre-resolve per-strategy dry-run list (策略 v2 dry-run 模式).  Any strategy
    // with lifecycle_policy.dry_run === true → its signals get planned-only treatment
    // in autoBuyFromSignals (no createBuyTrade, just order_intent + QuantSignal row).
    // Lazy-require to avoid pulling the entire quant/engine subsystem into facade load.
    //
    // Batch N (2026-06-17): 改成 fail-CLOSED — DB 加载 dry-run 列表失败时, 直接 throw
    // 让本次 applyAutomation 失败 + 告警, 而不是 silent 返空数组让所有 dry-run 策略
    // 误真下单. 反向安全选择: 短暂 DB 故障 → 用户重试 / 等待 cron 下一轮 OK; silent
    // 真下单 → 用户损失真金白银. 同款 fail-CLOSED in PositionLimitGuard.
    const resolveDryRunStrategyKeys = async (): Promise<string[]> => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { strategyEngine } = require('../quant/engine/StrategyEngine');
      const keys = await strategyEngine.getDryRunStrategyKeys();
      if (!Array.isArray(keys)) {
        const err: any = new Error(
          'applyAutomation: getDryRunStrategyKeys 返回非数组, fail-CLOSED 避免误下单'
        );
        err.statusCode = 503;
        err.code = 'DRY_RUN_KEYS_UNAVAILABLE';
        throw err;
      }
      return keys;
    };

    switch (action) {
      case 'auto_buy': {
        // Skip the DB lookup entirely when the caller already forces dry_run=true —
        // every signal is dry-run anyway, so the per-strategy list adds nothing.
        const dryRunStrategyKeys = body.dry_run === true ? [] : await resolveDryRunStrategyKeys();
        return paperTradingAutomationService.autoBuyFromSignals({
          ...body,
          dry_run_strategy_keys: dryRunStrategyKeys,
          user_id,
        });
      }

      case 'auto_sync': {
        const dryRunStrategyKeys = body.dry_run === true ? [] : await resolveDryRunStrategyKeys();
        return paperTradingAutomationService.runAutoSync({
          ...body,
          dry_run_strategy_keys: dryRunStrategyKeys,
          user_id,
          refresh_recommendations: body.refresh_recommendations ?? true,
        });
      }

      case 'risk_check':
        return paperTradingAutomationService.runRiskCheck({
          ...body,
          user_id,
        });

      case 'autonomous_auto_sync': {
        // US-083: autonomous variant also honors per-strategy dry-run.
        const dryRunStrategyKeys = body.dry_run === true ? [] : await resolveDryRunStrategyKeys();
        const execution = await paperTradingAutomationService.runAutoSync(
          withAutonomousPortfolio({
            refresh_recommendations: true,
            universe: 'market',
            style: 'balanced',
            candidate_limit: 12,
            candidate_pool_limit: 360,
            limit: 4,
            scan_limit: 80,
            min_score: 72,
            max_positions: 8,
            default_position_pct: 5,
            max_position_pct: 10,
            verify_signals: true,
            use_entry_risk_guard: true,
            use_profit_gate: true,
            use_outcome_feedback: true,
            report_to_feishu: true,
            dry_run_strategy_keys: dryRunStrategyKeys,
            ...body,
            user_id,
            username,
          })
        );
        const dashboard = await paperTradingDashboardService.getAutonomousDashboard({
          user_id,
          username,
          lookback_days: 60,
          limit: 120,
        });
        return { execution, dashboard };
      }

      case 'autonomous_risk_check': {
        const execution = await paperTradingAutomationService.runRiskCheck(
          withAutonomousPortfolio({
            dry_run: false,
            report_to_feishu: true,
            enable_stop_loss: true,
            enable_take_profit: true,
            enable_trailing_take_profit: true,
            enable_sell_signals: true,
            use_adaptive_risk_policy: true,
            adaptive_risk_lookback_days: 180,
            adaptive_risk_min_closed_samples: 5,
            adaptive_risk_override_signal_params: false,
            default_stop_loss_pct: 7,
            default_take_profit_pct: 14,
            trailing_activation_pct: 8,
            trailing_drawdown_pct: 4,
            max_hold_days: 20,
            min_sell_signal_score: 60,
            sell_signal_source_type: 'all',
            ...body,
            user_id,
            username,
          })
        );
        const dashboard = await paperTradingDashboardService.getAutonomousDashboard({
          user_id,
          username,
          lookback_days: 60,
          limit: 120,
        });
        return { execution, dashboard };
      }

      case 'plan':
        return paperTradingPlanService.generatePlan({
          ...body,
          user_id,
        });

      case 'plan_report':
        return paperTradingPlanService.generatePlan({
          ...body,
          user_id,
          report_to_feishu: true,
        });

      case 'tuning_apply':
        return paperTradingTuningApplyService.applyOrderIntentTuningPreview({
          ...body,
          user_id,
          username,
          operator: { user_id, username },
        } as any);

      case 'tuning_rollback':
        return paperTradingTuningApplyService.applyCanaryRollback({
          ...body,
          user_id,
          username,
          operator: { user_id, username },
        } as any);

      case 'hindsight_refresh':
        return paperTradingOrderIntentService.refreshHindsightSnapshots({
          ...body,
          user_id,
          username,
        } as any);

      case 'set_stop_loss': {
        // US-017 — UI lets the user set a hard stop-loss price per position.
        // Body shape: { position_id: number, stop_loss_price: number | null }.
        // Verifies the position belongs to the user's portfolio before write.
        const positionId = Number(body.position_id);
        if (!Number.isFinite(positionId) || positionId <= 0) {
          const err: any = new Error('position_id 无效');
          err.statusCode = 400;
          throw err;
        }
        const stopLossPrice =
          body.stop_loss_price === null || body.stop_loss_price === undefined
            ? null
            : Number(body.stop_loss_price);
        if (stopLossPrice !== null && (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0)) {
          const err: any = new Error('stop_loss_price 必须是正数或 null');
          err.statusCode = 400;
          throw err;
        }
        // 修复 (2026-06-17): 串盘 — 优先 body.portfolio_id, 缺则 active id ASC + warn
        let portfolio: PaperTradingPortfolio | null;
        if (body?.portfolio_id) {
          portfolio = await PaperTradingPortfolio.findOne({
            where: { id: Number(body.portfolio_id), user_id },
          });
        } else {
          portfolio = await PaperTradingPortfolio.findOne({
            where: { user_id, is_active: true },
            order: [['id', 'ASC']],
          });
          if (portfolio) {
            logger.warn(
              `[facade.applyAutomation] set_*_price user_id=${user_id} 未传 portfolio_id, 默认 portfolio ${portfolio.id}`
            );
          }
        }
        if (!portfolio) {
          const err: any = new Error('未找到模拟盘');
          err.statusCode = 404;
          throw err;
        }
        const position = await PaperTradingPosition.findOne({
          where: { id: positionId, portfolio_id: portfolio.id },
        });
        if (!position) {
          const err: any = new Error('未找到该持仓');
          err.statusCode = 404;
          throw err;
        }
        position.stop_loss_price = stopLossPrice;
        await position.save();
        return {
          position_id: position.id,
          symbol: position.symbol,
          stop_loss_price: position.stop_loss_price,
          current_price: position.current_price,
        };
      }

      case 'set_take_profit': {
        // US-076 — UI lets the user set a hard take-profit price per position.
        // Body shape: { position_id: number, take_profit_price: number | null }.
        // Mirrors set_stop_loss validation; verifies position ownership before write.
        const positionId = Number(body.position_id);
        if (!Number.isFinite(positionId) || positionId <= 0) {
          const err: any = new Error('position_id 无效');
          err.statusCode = 400;
          throw err;
        }
        const takeProfitPrice =
          body.take_profit_price === null || body.take_profit_price === undefined
            ? null
            : Number(body.take_profit_price);
        if (
          takeProfitPrice !== null &&
          (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0)
        ) {
          const err: any = new Error('take_profit_price 必须是正数或 null');
          err.statusCode = 400;
          throw err;
        }
        // 修复 (2026-06-17): 串盘 — 优先 body.portfolio_id, 缺则 active id ASC + warn
        let portfolio: PaperTradingPortfolio | null;
        if (body?.portfolio_id) {
          portfolio = await PaperTradingPortfolio.findOne({
            where: { id: Number(body.portfolio_id), user_id },
          });
        } else {
          portfolio = await PaperTradingPortfolio.findOne({
            where: { user_id, is_active: true },
            order: [['id', 'ASC']],
          });
          if (portfolio) {
            logger.warn(
              `[facade.applyAutomation] set_*_price user_id=${user_id} 未传 portfolio_id, 默认 portfolio ${portfolio.id}`
            );
          }
        }
        if (!portfolio) {
          const err: any = new Error('未找到模拟盘');
          err.statusCode = 404;
          throw err;
        }
        const position = await PaperTradingPosition.findOne({
          where: { id: positionId, portfolio_id: portfolio.id },
        });
        if (!position) {
          const err: any = new Error('未找到该持仓');
          err.statusCode = 404;
          throw err;
        }
        position.take_profit_price = takeProfitPrice;
        await position.save();
        return {
          position_id: position.id,
          symbol: position.symbol,
          take_profit_price: position.take_profit_price,
          current_price: position.current_price,
        };
      }

      case 'per_stock_stop_loss_check': {
        // US-051 — 每股止损评估。Body 可选 dry_run / as_of。
        // 用户作用域：默认仅当前 user（body.scope='all' 走批量扫描所有用户）。
        // 返回结构化 trigger + per-user 结果，调用方决定撮合时机（保持
        // facade 7-method 收敛，与 US-048 / US-049 同款"guard 输出 trigger /
        // caller 决定执行"模式）。
        const dryRun = body.dry_run === undefined ? false : Boolean(body.dry_run);
        const asOfStr = typeof body.as_of === 'string' ? body.as_of : undefined;
        const parsedAsOf = asOfStr ? new Date(asOfStr) : undefined;
        const safeAsOf = parsedAsOf && !Number.isNaN(parsedAsOf.getTime()) ? parsedAsOf : undefined;
        const scope = body.scope === 'all' ? 'all' : 'self';
        return perStockStopLossGuard.evaluateAfterClose({
          user_id: scope === 'self' ? user_id : undefined,
          asOfDate: safeAsOf,
          dry_run: dryRun,
        });
      }

      default: {
        const exhaustiveCheck: never = action;
        throw new Error(`applyAutomation: unknown action ${exhaustiveCheck as string}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  //  7. getRiskProfile
  // -------------------------------------------------------------------------
  /**
   * Returns the portfolio risk profile, order-intent dashboards, or tuning
   * canary observation depending on `options.view`.
   */
  async getRiskProfile(options: GetRiskProfileOptions) {
    const view = options.view || 'profile';
    const user_id = options.user_id;
    const username = options.username;
    const query = options.query || {};

    switch (view) {
      case 'intents':
        return paperTradingOrderIntentService.getIntentDashboard({
          ...query,
          user_id,
          username,
        } as any);

      case 'intent_family_hindsight':
        return paperTradingOrderIntentService.getFamilyHindsightDashboard({
          ...query,
          user_id,
          username,
        } as any);

      case 'intent_trace': {
        const id = Number(options.params?.id);
        return paperTradingOrderIntentService.getIntentTrace(id, {
          ...query,
          user_id,
          username,
        } as any);
      }

      case 'tuning_canary':
        return paperTradingTuningApplyService.getCanaryStatus({
          ...query,
          user_id,
          username,
        } as any);

      case 'tuning_candidates':
        return paperTradingTuningApplyService.getTuningCandidates({
          ...query,
          user_id,
          username,
        } as any);

      case 'tuning_canary_snapshots':
        return paperTradingTuningApplyService.listCanaryReviewSnapshots({
          ...query,
          user_id,
          username,
        } as any);

      case 'profile':
      default:
        return paperTradingRiskProfileService.getRiskProfile({
          ...query,
          user_id,
        });
    }
  }
}

export const paperTradingFacade = new PaperTradingFacade();
