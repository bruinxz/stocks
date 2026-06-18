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
import { drawdownCircuitBreaker, RiskGuardUnavailableError } from './risk/DrawdownCircuitBreaker';
import {
  handleRiskGuardUnavailable,
  loadProductionRiskAlertCreator,
} from './risk/RiskGuardFailClosed';
import { perStockStopLossGuard, pickEffectivePct } from './risk/PerStockStopLossGuard';
import { incrementOrderTotal } from '../metrics/PrometheusRegistry';
import {
  inferMarketSegment as inferMarketSegmentLM,
  getLimitPct as getLimitPctLM,
  isAtLimitUp as isAtLimitUpLM,
  isAtLimitDown as isAtLimitDownLM,
} from '../quant/marketLimits';
import { isSTName as isSTNameLM } from '../utils/stNameUtils';

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
  /**
   * 跳过 pre-trade 合规检查 (US-010 / PR-005). 仅给系统级强制路径用:
   *   - GuardSellExecutor 强平 (止损/止盈/集中度), 不该被 wizard 拦
   *   - closePosition (用户已显式选择平仓)
   *   - IndustryConcentrationGuard.rebalance 等再平衡 SELL 链
   * 普通 UI BUY / TodaySignals shadow autopilot / RebalanceEngine BUY **不要**传.
   */
  bypass_compliance?: boolean;
  /**
   * 可选 pre-trade compliance 上下文 — 由 caller (策略层) 注入信号元数据,
   * facade 内不再二次查 DB. 缺省时仅跑 wizard 子规则中不依赖元数据的分支
   * (NEXT_DAY_CHASE / FREQUENT_TRADING / MIN_HOLDING_PERIOD 仍能命中).
   */
  compliance_context?: PreTradeComplianceContext;
}

/**
 * caller 注入的策略/信号上下文，用于 PaperTradingFacade.placeOrder 调
 * checkPreTradeCompliance. 全 optional — 缺什么 wizard 跳什么.
 */
export interface PreTradeComplianceContext {
  conviction_level?: number;
  strategy_key?: string;
  stop_loss_distance_pct?: number;
  market_trend?: 'up' | 'down' | 'sideways';
  current_pe?: number;
  historical_avg_pe?: number;
  has_specific_catalyst?: boolean;
  /** 当日已涨幅 (0-1 小数, 例如 0.07 = 7%) */
  intraday_change_pct?: number;
  /** 信号产生 timestamp (ms epoch) — 超 24h 算 STALE_SIGNAL */
  signal_timestamp_ms?: number;
}

export interface ClosePositionOptions {
  user_id: number;
  symbol: string;
  /** 同 PlaceOrderOptions: 强烈建议显式传 portfolio_id 避免多账户串盘. */
  portfolio_id?: number;
  bypass_trading_hours?: boolean;
  bypass_t_plus_1?: boolean;
  bypass_compliance?: boolean;
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
//  BETA-6 (2026-06-18, audit M-17): Quote staleness 决策纯函数
// ---------------------------------------------------------------------------

export type QuoteStalenessKind =
  | 'pass_realtime'
  | 'pass_daily_bar_fallback'
  | 'stale_realtime'
  | 'stale_daily_bar';

export interface QuoteStalenessDecision {
  kind: QuoteStalenessKind;
  message: string;
  detail: Record<string, any>;
}

/**
 * 评估行情陈旧度 — 优先 RealtimeQuote 30 min，缺失 fallback daily_bar 1 day。
 *
 * 输入全部传值（无 DB 调用 / 无 RealtimeQuoteService 调用），让 caller 注入
 * RealtimeQuote 与 daily_bar timestamp 后纯逻辑判定 — 单测易、回测可复用。
 *
 * 返回 4 种 kind:
 *   - pass_realtime — RealtimeQuote 在 30 min 内 → 放行
 *   - pass_daily_bar_fallback — RealtimeQuote 缺失但 daily_bar 在 1 天内 → 放行
 *   - stale_realtime — RealtimeQuote 超 30 min → 拒单 code='STALE_REALTIME_QUOTE'
 *   - stale_daily_bar — RealtimeQuote 缺失 + daily_bar 超 1 天 → 拒单 code='STALE_DAILY_BAR'
 */
export function evaluateQuoteStaleness(input: {
  symbol: string;
  now_ms: number;
  realtime_quote_time: any | null;
  daily_bar_time: any;
  max_realtime_age_minutes: number;
  max_daily_bar_age_days: number;
}): QuoteStalenessDecision {
  // 1) RealtimeQuote 优先
  if (input.realtime_quote_time !== null && input.realtime_quote_time !== undefined) {
    const ts = new Date(input.realtime_quote_time).getTime();
    if (Number.isFinite(ts)) {
      const ageMinutes = (input.now_ms - ts) / (60 * 1000);
      if (ageMinutes > input.max_realtime_age_minutes) {
        return {
          kind: 'stale_realtime',
          message:
            `行情数据陈旧 (RealtimeQuote 最新 ${Math.round(ageMinutes)} 分钟前 > ` +
            `${input.max_realtime_age_minutes}min), 拒绝按 stale 价撮合。` +
            `请等待行情同步或加 bypass_trading_hours=true 强制下单`,
          detail: {
            symbol: input.symbol,
            quote_time: input.realtime_quote_time,
            age_minutes: Math.round(ageMinutes),
            source: 'realtime_quote',
          },
        };
      }
      return {
        kind: 'pass_realtime',
        message: 'realtime quote within window',
        detail: {
          symbol: input.symbol,
          age_minutes: Math.round(ageMinutes),
          source: 'realtime_quote',
        },
      };
    }
  }

  // 2) RealtimeQuote 不可用 → daily_bar fallback
  const barTs = new Date(input.daily_bar_time).getTime();
  if (!Number.isFinite(barTs)) {
    // 双源都解析失败 — 视为 stale_daily_bar
    return {
      kind: 'stale_daily_bar',
      message: `行情数据陈旧 (RealtimeQuote 不可用 + daily_bar timestamp 无法解析: ${input.daily_bar_time})`,
      detail: { symbol: input.symbol, daily_bar_time: input.daily_bar_time, source: 'daily_bar' },
    };
  }
  const ageMs = input.now_ms - barTs;
  const maxAgeMs = input.max_daily_bar_age_days * 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    const ageDays = Math.round((ageMs / (24 * 60 * 60 * 1000)) * 10) / 10;
    return {
      kind: 'stale_daily_bar',
      message:
        `行情数据陈旧 (RealtimeQuote 不可用 + daily_bar ${ageDays} 天前 > ` +
        `${input.max_daily_bar_age_days} 天), 拒绝按 stale 价撮合。` +
        `请等待数据同步或加 bypass_trading_hours=true 强制下单`,
      detail: {
        symbol: input.symbol,
        latest_bar_time: input.daily_bar_time,
        age_days: ageDays,
        source: 'daily_bar',
      },
    };
  }
  return {
    kind: 'pass_daily_bar_fallback',
    message: 'daily_bar fallback within window',
    detail: {
      symbol: input.symbol,
      age_minutes: Math.round(ageMs / (60 * 1000)),
      source: 'daily_bar',
    },
  };
}

// ---------------------------------------------------------------------------
//  Facade
// ---------------------------------------------------------------------------

/**
 * audit S-3 修复: 涨跌停 pre-trade 拦截的纯函数实现。
 *
 * 单测可以直接调用此函数验证 5 个市场段 × BUY/SELL 边界, 不需要走 placeOrder
 * 整条 DB 链路。`_placeOrderInner` 真实 BUY/SELL 路径里有同款逻辑 inline 嵌入,
 * 把判定逻辑抽到 export 函数让单元测试可独立断言。
 *
 * 返回 { ok: true } 表示放行 (或缺数据 / bypass 时安全 fallback);
 * 返回 { ok: false, code, message, detail } 表示触发涨/跌停, 调用方应当抛错。
 */
export interface LimitUpDownDecision {
  ok: boolean;
  code?: 'LIMIT_UP_BLOCK_BUY' | 'LIMIT_DOWN_BLOCK_SELL';
  message?: string;
  detail?: Record<string, any>;
}

export function evaluateLimitUpDownBlock(input: {
  symbol: string;
  stock_name?: string | null;
  direction: 'BUY' | 'SELL';
  prev_close: number | null | undefined;
  reference_price: number;
  bypass?: boolean;
}): LimitUpDownDecision {
  if (input.bypass) return { ok: true };
  if (!Number.isFinite(input.prev_close as number) || (input.prev_close as number) <= 0) {
    return { ok: true }; // 缺数据安全 fallback
  }
  if (!Number.isFinite(input.reference_price) || input.reference_price <= 0) {
    return { ok: true };
  }
  const segment = inferMarketSegmentLM(input.symbol);
  const isST = isSTNameLM(input.stock_name || '');
  const fakeBar = {
    open: input.reference_price,
    high: input.reference_price,
    low: input.reference_price,
    close: input.reference_price,
  };
  if (input.direction === 'BUY') {
    if (isAtLimitUpLM(fakeBar, segment, isST, input.prev_close as number)) {
      const limitPct = getLimitPctLM(segment, isST);
      return {
        ok: false,
        code: 'LIMIT_UP_BLOCK_BUY',
        message: `标的 ${input.symbol} 当前已涨停 (${segment}${isST ? '+ST' : ''} ${(
          limitPct * 100
        ).toFixed(0)}%), 拒绝买入`,
        detail: {
          symbol: input.symbol,
          segment,
          is_st: isST,
          limit_pct: limitPct,
          prev_close: input.prev_close,
          reference_price: input.reference_price,
        },
      };
    }
  } else {
    if (isAtLimitDownLM(fakeBar, segment, isST, input.prev_close as number)) {
      const limitPct = getLimitPctLM(segment, isST);
      return {
        ok: false,
        code: 'LIMIT_DOWN_BLOCK_SELL',
        message: `标的 ${input.symbol} 当前已跌停 (${segment}${isST ? '+ST' : ''} ${(
          limitPct * 100
        ).toFixed(0)}%), 拒绝卖出`,
        detail: {
          symbol: input.symbol,
          segment,
          is_st: isST,
          limit_pct: limitPct,
          prev_close: input.prev_close,
          reference_price: input.reference_price,
        },
      };
    }
  }
  return { ok: true };
}

/**
 * Pure helper — 把 placeOrder 输入 + 已知盘口/组合信息映射成
 * checkPreTradeCompliance 的 PreTradeComplianceDraft. 抽出做纯函数方便单测,
 * 同时让 facade 的 BUY 主路径与 LiveTradingService.approveDraft /
 * PaperTradingAutomationService.createBuyTrade 的 draft 构造逻辑保持口径一致.
 *
 * - position_size_pct: cost / (current_cash + cost) — 与 automation 同公式
 * - intraday_change_pct: 接受 0.07 (小数) 或 7 (百分比), 自动 /100 归一
 * - 缺什么字段 caller 传 undefined, 不要传 NaN, 让 wizard 子规则自然跳过
 */
export function buildPreTradeComplianceDraft(input: {
  user_id: number;
  portfolio_id?: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  current_cash?: number;
  context?: PreTradeComplianceContext;
  bypass?: boolean;
}): {
  user_id: number;
  portfolio_id?: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  position_size_pct?: number;
  conviction_level?: number;
  strategy_key?: string;
  stop_loss_distance_pct?: number;
  market_trend?: 'up' | 'down' | 'sideways';
  current_pe?: number;
  historical_avg_pe?: number;
  has_specific_catalyst?: boolean;
  intraday_change_pct?: number;
  signal_timestamp_ms?: number;
  bypass?: boolean;
} {
  const ctx = input.context || {};
  const cost = Number(input.price) * Number(input.quantity);
  let positionSizePct: number | undefined;
  if (
    input.side === 'BUY' &&
    Number.isFinite(input.current_cash as number) &&
    Number.isFinite(cost)
  ) {
    const denom = Number(input.current_cash) + cost;
    if (denom > 0 && cost > 0) positionSizePct = cost / denom;
  }
  const intradayChg = (() => {
    const c = Number(ctx.intraday_change_pct);
    if (!Number.isFinite(c)) return undefined;
    return Math.abs(c) > 1 ? c / 100 : c;
  })();
  return {
    user_id: input.user_id,
    portfolio_id: input.portfolio_id,
    symbol: input.symbol,
    side: input.side,
    price: Number(input.price),
    quantity: Number(input.quantity),
    position_size_pct: positionSizePct,
    conviction_level: Number.isFinite(ctx.conviction_level as number)
      ? Number(ctx.conviction_level)
      : undefined,
    strategy_key: ctx.strategy_key,
    stop_loss_distance_pct: Number.isFinite(ctx.stop_loss_distance_pct as number)
      ? Number(ctx.stop_loss_distance_pct)
      : undefined,
    market_trend: ctx.market_trend,
    current_pe: Number.isFinite(ctx.current_pe as number) ? Number(ctx.current_pe) : undefined,
    historical_avg_pe: Number.isFinite(ctx.historical_avg_pe as number)
      ? Number(ctx.historical_avg_pe)
      : undefined,
    has_specific_catalyst: ctx.has_specific_catalyst === true ? true : undefined,
    intraday_change_pct: intradayChg,
    signal_timestamp_ms: Number.isFinite(ctx.signal_timestamp_ms as number)
      ? Number(ctx.signal_timestamp_ms)
      : undefined,
    bypass: input.bypass === true ? true : undefined,
  };
}

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
        if (totalMinutes >= 9 * 60 && totalMinutes < MORNING_START)
          reason = '集合竞价时段 (09:00-09:30)，等待 09:30 开盘后再下单';
        else if (totalMinutes >= MORNING_END && totalMinutes < AFTERNOON_START)
          reason = '午休时段 (11:30-13:00)';
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
    const latestBar = bars[bars.length - 1];
    const current_price = latestBar.close;
    // Batch P (2026-06-17, D1 fix): staleness guard. 之前盘中下单 (UI / industry
    // rebalance / closePosition) 可能拿到昨日 / 上周五 close 当成交价, 用户在
    // 实时价 +5% 时按昨日 close 出货 = realized_pnl 严重失真. automation 路径已有
    // 30 min guard, facade 这条独立 path 之前完全没有.
    //
    // 当前简化判定: latestBar.time 距 now 超 max_age_days (默认 3 天 — 覆盖周末/单日假) → throw.
    // bypass_trading_hours=true (历史回填 / 单测) 时跳过此检查. 未来可接 RealtimeQuoteService
    // 同款 30min 阈值, 这里先用 daily_bar 时间戳保底.
    if (!(options as any).bypass_trading_hours && latestBar.time) {
      // BETA-6 (2026-06-18, audit M-17): 优先用 RealtimeQuoteService 的 timestamp
      // (盘中 30 min 阈值); 不可用则 fallback 到 daily_bar 3 天阈值。daily_bar 3 天
      // 阈值放宽到 1 天 (audit 要求) — 实测发现 facade 历史回填等场景偶尔依赖 1-3 天
      // 老 bar, 折中取 1 天作为 fallback 阈值, 既比之前严格又不破回填场景。
      let quoteSnapshot: { quote_time?: any } | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { realtimeQuoteService } = require('../data/services/RealtimeQuoteService');
        const quotes = await realtimeQuoteService.getLatestQuotes([symbol]);
        quoteSnapshot = Array.isArray(quotes) && quotes.length > 0 ? quotes[0] : null;
      } catch (err: any) {
        logger.warn(
          `[facade.placeOrder] RealtimeQuote getLatestQuotes failed, fallback to daily_bar: ${
            err?.message || err
          }`
        );
        quoteSnapshot = null;
      }
      const stalenessDecision = evaluateQuoteStaleness({
        symbol,
        now_ms: Date.now(),
        realtime_quote_time: quoteSnapshot?.quote_time ?? null,
        daily_bar_time: latestBar.time,
        max_realtime_age_minutes: 30,
        max_daily_bar_age_days: 1,
      });
      if (stalenessDecision.kind === 'stale_realtime') {
        const err: any = new Error(stalenessDecision.message);
        err.statusCode = 503;
        err.code = 'STALE_REALTIME_QUOTE';
        err.detail = stalenessDecision.detail;
        throw err;
      }
      if (stalenessDecision.kind === 'stale_daily_bar') {
        const err: any = new Error(stalenessDecision.message);
        err.statusCode = 503;
        err.code = 'STALE_DAILY_BAR';
        err.detail = stalenessDecision.detail;
        throw err;
      }
      if (stalenessDecision.kind === 'pass_daily_bar_fallback') {
        logger.debug(
          `[facade.placeOrder] staleness fallback to daily_bar source for ${symbol}: ${stalenessDecision.detail?.age_minutes}m`
        );
      }
    }
    const stockInfo = await Stock.findOne({ where: { symbol } });
    const stockName = stockInfo ? stockInfo.name : symbol;

    // Batch S (2026-06-17, G1 fix): 与 AShareConstraintEngine 对齐, 补 transfer_fee
    // (千 0.01 双边过户费) + min_commission (5 元地板). 之前漏算 transfer_fee 让
    // realized_pnl 高估 0.13%; 漏 min_commission 让小额单 (< 16,666 元) 佣金低估.
    // commission_rate / slippage 保留旧值 (0.0003 / 0.001) 避免改动历史 realized_pnl
    // 系统性偏差; 未来如要切到 AShareConstraintEngine 默认 (0.00025 / 0.002) 需要
    // 一次性全量 backfill realized_pnl 列.
    const commissionRate = 0.0003;
    const slippage = 0.001;
    const transferFeeRate = 0.00001; // 千 0.01 双边
    const minCommission = 5;

    if (direction === 'BUY') {
      const execute_price = current_price * (1 + slippage);
      const cost = execute_price * quantity;
      const rawCommission = cost * commissionRate;
      const commission = Math.max(rawCommission, minCommission);
      const transferFee = cost * transferFeeRate;
      const totalCost = cost + commission + transferFee;

      // ---- audit S-3 修复: 涨停板拦截 (用 evaluateLimitUpDownBlock 纯函数) ----
      // 之前 BUY/SELL 完全不查涨跌停, 模拟盘可下单到 300xxx 创业板涨 18% / 920xxx
      // 北交所涨 25% / ST 涨 4.5% (实盘 5% 已涨停)。按市场段计算精确涨停价
      // (主板 10% / 创业板 + 科创板 20% / 北交所 30% / ST 5%), 触及即拒。
      const limitUpDecision = evaluateLimitUpDownBlock({
        symbol,
        stock_name: stockName,
        direction: 'BUY',
        prev_close: bars.length >= 2 ? Number(bars[bars.length - 2].close) : null,
        reference_price: current_price,
        bypass: (options as any).bypass_limit_up_check === true,
      });
      if (!limitUpDecision.ok) {
        const err: any = new Error(limitUpDecision.message);
        err.statusCode = 400;
        err.code = limitUpDecision.code;
        err.detail = limitUpDecision.detail;
        throw err;
      }

      // ---- US-049: Drawdown circuit breaker LEVEL_1 pause ----
      // If the portfolio is in an active LEVEL_1 pause window (peak-drawdown
      // ≥ 10% triggered by the EOD evaluator), block NEW openings.  Adding to
      // existing positions is allowed (covers策略 add-on without forcing
      // operators to manually clear the pause for every routine top-up).
      // US-011 (PR-006): fail-CLOSED handling extracted to the shared
      // `handleRiskGuardUnavailable` helper (was BETA-7 inline catch-and-write
      // duplicated in 3 places). Same alert shape, same statusCode=503 throw,
      // but single source of truth for RiskAlert payload + rule_id.
      let breakerResult: { ok: boolean; reason?: string; paused_until?: any };
      try {
        breakerResult = await drawdownCircuitBreaker.checkBuyAllowed({
          user_id,
          symbol,
        });
      } catch (guardErr: any) {
        if (guardErr instanceof RiskGuardUnavailableError) {
          await handleRiskGuardUnavailable({
            err: guardErr,
            user_id,
            symbol,
            callerLabel: 'facade.placeOrder',
            dataSource: loadProductionRiskAlertCreator(),
          });
          throw guardErr;
        }
        // 其它 unexpected 错误也按 fail-CLOSED 处理 — `wrapFailClosed` 在 guard
        // 层应该已经把 unexpected error 包成 RiskGuardUnavailableError, 这里
        // 只是兜底防御性 re-throw.
        logger.warn(
          `[facade.placeOrder] drawdownCircuitBreaker.checkBuyAllowed unexpected err: ${
            guardErr?.message || guardErr
          }`
        );
        throw guardErr;
      }
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
      // US-011 (PR-006): same fail-CLOSED wrap as drawdown breaker — DB
      // outage in loadPortfolio/loadPositions now bubbles up as
      // RiskGuardUnavailableError instead of raw Sequelize 500.
      let guardResult: { ok: boolean; violation?: any; config: any };
      try {
        guardResult = await positionLimitGuard.checkBuyOrder({
          user_id,
          symbol,
          proposed_value: cost,
        });
      } catch (guardErr: any) {
        if (guardErr instanceof RiskGuardUnavailableError) {
          await handleRiskGuardUnavailable({
            err: guardErr,
            user_id,
            symbol,
            callerLabel: 'facade.placeOrder',
            dataSource: loadProductionRiskAlertCreator(),
          });
          throw guardErr;
        }
        throw guardErr;
      }
      if (!guardResult.ok && guardResult.violation) {
        const err: any = new Error(guardResult.violation.message);
        err.statusCode = 400;
        err.code = 'POSITION_LIMIT_VIOLATION';
        err.rule = guardResult.violation.rule;
        err.detail = guardResult.violation.detail;
        throw err;
      }

      // ============ pre-trade compliance (US-010 / PR-005, BETA-1 续) ============
      // 复用 services/TradeComplianceChecker. 之前只接 LiveTradingService.approveDraft
      // 与 PaperTradingAutomationService.createBuyTrade 两处; facade.placeOrder 是 UI
      // 手动 BUY / TodaySignals shadow autopilot / RebalanceEngine 执行的统一入口,
      // 这次补齐让"全 caller 验收"成立.
      //
      // 规则:
      //   high 违规 → throw err.code=PRE_TRADE_COMPLIANCE_BLOCKED + emit MEDIUM RiskAlert
      //   medium    → 放行, emit LOW RiskAlert
      //   low       → 放行, 不写 RiskAlert (仅 log)
      // bypass_compliance=true 时直接跳过 (强平 / closePosition / 强制 rebalance).
      // fail-OPEN: 内部 unexpected throw 走 logger.warn, 不阻塞业务.
      if (!(options as any).bypass_compliance) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const complianceMod = require('../services/TradeComplianceChecker');
          const { checkPreTradeCompliance, emitPreTradeComplianceAlert } = complianceMod;
          const complianceDraft = buildPreTradeComplianceDraft({
            user_id,
            portfolio_id: portfolio.id,
            symbol,
            side: 'BUY',
            price: execute_price,
            quantity,
            current_cash: Number(portfolio.current_cash) || 0,
            context: (options as any).compliance_context,
          });
          const complianceResult = await checkPreTradeCompliance(complianceDraft);
          if (complianceResult.block) {
            await emitPreTradeComplianceAlert({
              user_id,
              symbol,
              side: 'BUY',
              level: 'MEDIUM',
              draft: complianceDraft,
              result: complianceResult,
            });
            const err: any = new Error(`pre-trade compliance 拒单: ${complianceResult.summary}`);
            err.statusCode = 400;
            err.code = 'PRE_TRADE_COMPLIANCE_BLOCKED';
            err.detail = { violations: complianceResult.violations };
            throw err;
          }
          if (complianceResult.violations.some((v: any) => v.severity === 'medium')) {
            await emitPreTradeComplianceAlert({
              user_id,
              symbol,
              side: 'BUY',
              level: 'LOW',
              draft: complianceDraft,
              result: complianceResult,
            });
          } else if (complianceResult.violations.length > 0) {
            logger.info(
              `[facade.placeOrder] pre-trade compliance LOW-only for ${symbol}: ${complianceResult.summary}`
            );
          }
        } catch (err: any) {
          if (err?.code === 'PRE_TRADE_COMPLIANCE_BLOCKED') throw err;
          logger.warn(
            `[facade.placeOrder] pre-trade compliance check failed (fail-open): ${
              err?.message || err
            }`
          );
        }
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
            const effectivePct = pickEffectivePct((position as any).stop_loss_pct ?? null, userPct);
            position.stop_loss_price = Number((position.avg_cost * (1 - effectivePct)).toFixed(4));
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

    // ---- audit S-3 修复: 跌停板拦截 (SELL, 共用 evaluateLimitUpDownBlock) ----
    const limitDownDecision = evaluateLimitUpDownBlock({
      symbol,
      stock_name: stockName,
      direction: 'SELL',
      prev_close: bars.length >= 2 ? Number(bars[bars.length - 2].close) : null,
      reference_price: current_price,
      bypass: (options as any).bypass_limit_down_check === true,
    });
    if (!limitDownDecision.ok) {
      const err: any = new Error(limitDownDecision.message);
      err.statusCode = 400;
      err.code = limitDownDecision.code;
      err.detail = limitDownDecision.detail;
      throw err;
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
    const rawCommission = revenue * commissionRate;
    // Batch S (2026-06-17, G1 fix): min_commission 5 元地板 + transfer_fee 千 0.01.
    // 修复 (CRITICAL C4): A 股 SELL 印花税单边千 1 (BUY 不收). 漏算导致 realized_pnl
    // 高估 0.1%, EV 反算 edge 偏乐观. SELL commission 包含 broker commission +
    // stamp_tax + transfer_fee + min_commission floor.
    const brokerCommission = Math.max(rawCommission, minCommission);
    const stampTax = revenue * 0.001;
    const transferFee = revenue * transferFeeRate;
    const commission = brokerCommission + stampTax + transferFee;
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
      // Batch S (2026-06-17, G1 fix): 估算 BUY commission 同款补 min_commission +
      // transfer_fee 让 realized_pnl 跟 cash 流出口径一致.
      const buyAmount = avg_cost * quantity;
      const estimatedBuyBrokerComm = Math.max(buyAmount * commissionRate, minCommission);
      const estimatedBuyTransferFee = buyAmount * transferFeeRate;
      const estimatedBuyCommission = estimatedBuyBrokerComm + estimatedBuyTransferFee;
      const realized_pnl = revenue - buyAmount - commission - estimatedBuyCommission;
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
      // closePosition 总是 SELL — 当前 checkPreTradeCompliance 对 SELL 直接 ok=true
      // 跳过, 即便不传 bypass_compliance 也不会被拦. 但显式传 true 表达"用户已确认
      // 平仓, 跳过任何 pre-trade 软合规", 与 GuardSellExecutor 强平语义一致.
      bypass_compliance: options.bypass_compliance !== false,
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
