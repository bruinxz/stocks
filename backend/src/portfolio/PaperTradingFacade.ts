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
}

export interface PlaceOrderOptions {
  user_id: number;
  symbol: string;
  direction: 'BUY' | 'SELL';
  quantity: number;
}

export interface ClosePositionOptions {
  user_id: number;
  symbol: string;
}

export type GetDailySnapshotAction = 'list' | 'trades' | 'refresh';

export interface GetDailySnapshotOptions {
  action?: GetDailySnapshotAction;
  user_id: number;
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
  | 'set_stop_loss';

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

const withAutonomousPortfolio = (payload: Record<string, any> = {}) => ({
  ...payload,
  portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
  initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
  use_autonomous_portfolio: true,
});

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

    let portfolio = await PaperTradingPortfolio.findOne({ where: { user_id } });
    if (!portfolio) {
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
   */
  async placeOrder(options: PlaceOrderOptions) {
    const { user_id, symbol, direction, quantity } = options;

    if (!symbol || !direction || !quantity || quantity <= 0) {
      throw new Error('无效的交易参数');
    }
    if (direction !== 'BUY' && direction !== 'SELL') {
      throw new Error('交易方向必须为 BUY 或 SELL');
    }

    const portfolio = await PaperTradingPortfolio.findOne({ where: { user_id } });
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

      const position = await PaperTradingPosition.findOne({
        where: { portfolio_id: portfolio.id, symbol },
      });
      if (position) {
        const totalCostBasis = position.avg_cost * position.quantity + cost;
        position.quantity += quantity;
        position.avg_cost = totalCostBasis / position.quantity;
        position.current_price = current_price;
        position.market_value = position.quantity * current_price;
        position.unrealized_pnl = position.market_value - position.avg_cost * position.quantity;
        await position.save();
      } else {
        await PaperTradingPosition.create({
          portfolio_id: portfolio.id,
          symbol,
          name: stockName,
          quantity,
          avg_cost: execute_price,
          current_price,
          market_value: quantity * current_price,
          unrealized_pnl: quantity * current_price - cost,
        });
      }

      portfolio.current_cash -= totalCost;
      await portfolio.save();

      await PaperTradingTrade.create({
        portfolio_id: portfolio.id,
        symbol,
        name: stockName,
        direction: 'BUY',
        execute_price,
        quantity,
        amount: cost,
        commission,
      });

      return { direction: 'BUY', symbol, quantity, execute_price, commission };
    }

    // SELL branch
    const position = await PaperTradingPosition.findOne({
      where: { portfolio_id: portfolio.id, symbol },
    });
    if (!position || position.quantity < quantity) {
      throw new Error('持仓不足，无法卖出');
    }

    const execute_price = current_price * (1 - slippage);
    const revenue = execute_price * quantity;
    const commission = revenue * commissionRate;
    const netRevenue = revenue - commission;
    const avg_cost = position.avg_cost;

    if (position.quantity === quantity) {
      await position.destroy();
    } else {
      position.quantity -= quantity;
      position.current_price = current_price;
      position.market_value = position.quantity * current_price;
      position.unrealized_pnl = position.market_value - position.avg_cost * position.quantity;
      await position.save();
    }

    portfolio.current_cash += netRevenue;
    await portfolio.save();

    const realized_pnl = revenue - avg_cost * quantity - commission;
    await PaperTradingTrade.create({
      portfolio_id: portfolio.id,
      symbol,
      name: stockName,
      direction: 'SELL',
      execute_price,
      quantity,
      amount: revenue,
      commission,
      realized_pnl,
    });

    return { direction: 'SELL', symbol, quantity, execute_price, commission, realized_pnl };
  }

  // -------------------------------------------------------------------------
  //  3. closePosition
  // -------------------------------------------------------------------------
  /**
   * Close the entire current position of `symbol` at the latest available
   * price.  Convenience wrapper around `placeOrder({ direction: 'SELL', quantity: full })`.
   */
  async closePosition(options: ClosePositionOptions) {
    const portfolio = await PaperTradingPortfolio.findOne({
      where: { user_id: options.user_id },
    });
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
      symbol: options.symbol,
      direction: 'SELL',
      quantity: position.quantity,
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

    const portfolio = await PaperTradingPortfolio.findOne({ where: { user_id } });
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
      return recommendationTradeOutcomeService.getDashboard({
        portfolio_name: QUANT_ONLY_PORTFOLIO_NAME,
        ...(options.query || {}),
        user_id,
      });
    }

    if (action === 'recommendation_outcome_trace') {
      const id = options.params?.id;
      return recommendationTradeOutcomeService.getTrace(String(id), {
        portfolio_name: QUANT_ONLY_PORTFOLIO_NAME,
        ...(options.query || {}),
        user_id,
      });
    }

    if (action === 'refresh_recommendation_outcomes') {
      return recommendationTradeOutcomeService.refreshPortfolioOutcomes({
        portfolio_name: QUANT_ONLY_PORTFOLIO_NAME,
        ...(options.body || {}),
        user_id,
      });
    }

    if (action === 'report_recommendation_outcomes') {
      return recommendationTradeOutcomeService.getDashboard({
        portfolio_name: QUANT_ONLY_PORTFOLIO_NAME,
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

    switch (action) {
      case 'auto_buy':
        return paperTradingAutomationService.autoBuyFromSignals({
          ...body,
          user_id,
        });

      case 'auto_sync':
        return paperTradingAutomationService.runAutoSync({
          ...body,
          user_id,
          refresh_recommendations: body.refresh_recommendations ?? true,
        });

      case 'risk_check':
        return paperTradingAutomationService.runRiskCheck({
          ...body,
          user_id,
        });

      case 'autonomous_auto_sync': {
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
        const portfolio = await PaperTradingPortfolio.findOne({ where: { user_id } });
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
