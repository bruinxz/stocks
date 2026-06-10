import { Op, fn, col } from 'sequelize';
import { logger } from '../utils/logger';
import { paperTradingFacade } from '../portfolio/PaperTradingFacade';
import {
  MultiFactorAlphaStrategy,
  MultiFactorAlphaSignal,
} from '../quant/strategies/MultiFactorAlphaStrategy';
import {
  DragonHeadMomentumStrategy,
  DragonHeadSignal,
} from '../quant/strategies/DragonHeadMomentumStrategy';
import {
  EarningsSurpriseStrategy,
  EarningsSurpriseSignal,
} from '../quant/strategies/EarningsSurpriseStrategy';
import { FactorScore } from '../models/FactorScore';
import { LimitUpStock } from '../models/LimitUpStock';
import { EarningsForecast } from '../models/EarningsForecast';
import { RiskAlert } from '../models/RiskAlert';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingSnapshot } from '../models/PaperTradingSnapshot';

/**
 * TodaySignalsService — US-018 今日作战工作区后端聚合器
 *
 * 把三条策略的当日信号 + 关键事件 + 风险告警一站式聚合，提供给前端
 * `/workspace/today` 页面：
 *
 *   - MultiFactorAlphaStrategy 当日（按 factor_scores 最新 trade_date）调仓增量
 *   - DragonHeadMomentumStrategy 今日候选 BUY top-N
 *   - EarningsSurpriseStrategy 今日入选 (announce_date == today) candidates
 *
 * 设计要点：
 *   1. **三个策略并发运行** (Promise.all)，任一策略失败 → 该 block 返回
 *      `error: <message>` 字段；其余 block 仍正常输出（避免一个数据缺失
 *      把整页打挂）。
 *   2. **previousSelection 用真实持仓**：MultiFactorAlpha 用 portfolio 的
 *      stock_code 集合（去掉 .SH/.SZ 后缀）；DragonHead/EarningsSurprise
 *      因为需要结构化 Position(entry_date/entry_price)，简化为空数组
 *      （首次评估场景；调用方可后续传入历史）。
 *   3. **trade_date 默认取 factor_scores 最新一日**（与 FactorController 一致）。
 *      调用方可显式传 `?date=YYYY-MM-DD` 覆盖。
 *   4. **applySignals 把 BUY 信号转成 placeOrder 调用**；按"今日新进入选"做白名单，
 *      已持有的 HOLD 信号不重复下单。SELL 信号目前不自动平仓（避免误杀），
 *      只在 UI 展示。
 *
 * 与现有 TodayCommandCenterService 的关系：
 *   - 旧 service 是全栈聚合大杂烩（推荐 + AI 信号 + 任务健康 + 风控 ...），
 *     已被 `/api/today/command-center` 端点使用，不动它。
 *   - 本 service 是 US-018 工作区专用聚合器，只对三条策略 + 事件/告警/账户摘要。
 */

// ---------- Types ---------------------------------------------------------

export interface AccountSummary {
  /** 账户净值（含现金 + 持仓市值） */
  total_value: number;
  /** 可用现金 */
  current_cash: number;
  /** 持仓市值 */
  position_value: number;
  /** 昨日盈亏 = today.total_value - yesterday.total_value（无昨日 snapshot 返回 null） */
  pnl_yesterday: number | null;
  /** 当月收益 = today.total_value - 月初 snapshot.total_value（无月初 snapshot 返回 null） */
  pnl_month_to_date: number | null;
  /** portfolio 是否存在 */
  portfolio_id: number | null;
}

export interface UnreadRiskAlertItem {
  id: number;
  symbol: string;
  name: string;
  level: string;
  message: string;
  created_at: string;
}

export interface MultiFactorBlock {
  trade_date: string | null;
  /** 实际跑出的 BUY/HOLD/SELL 增量信号（注意：previousSelection = 持仓里 MFA 持有的部分） */
  signals: MultiFactorAlphaSignal[];
  /** 新进入选数（BUY count） */
  new_picks: number;
  /** 剔除数（SELL count） */
  drops: number;
  /** 保留数（HOLD count） */
  keeps: number;
  /** 目标持仓 stock_code 数组（top-N，已应用行业中性） */
  target_portfolio: string[];
  error?: string;
}

export interface DragonHeadBlock {
  trade_date: string | null;
  /** 今日 BUY 候选信号（已 cap 在 5 只） */
  candidates: DragonHeadSignal[];
  /** 候选过滤过程中"通过 5 维过滤"的总数（未 cap 前） */
  eligible_count: number;
  /** 涨停池总数（filtered.limit_up_pool_size） */
  limit_up_pool_size?: number;
  /** 当日市场情绪指数（用于判定是否被闸门阻塞） */
  market_sentiment_value?: number | null;
  /** 是否被市场情绪闸门阻塞 */
  market_sentiment_blocked?: boolean;
  /** 各维度过滤计数（用于诊断为何 0 信号） */
  filter_stats?: Record<string, number>;
  error?: string;
}

export interface EarningsSurpriseBlock {
  trade_date: string | null;
  /** 今日 BUY 候选信号（已 cap 在 3 只） */
  candidates: EarningsSurpriseSignal[];
  /** 当日公告的预告条数（未筛选前） */
  forecast_pool_size: number;
  /** 通过双确认的候选总数（未 cap 前） */
  eligible_count: number;
  /** 北向数据是否缺失 — 缺失时已 fail-OPEN 但提示用户 */
  northbound_missing?: boolean;
  /** 各维度过滤计数 */
  filter_stats?: Record<string, number>;
  error?: string;
}

export interface KeyEventItem {
  /** earnings_surprise / earnings_announcement / limit_up_chain */
  event_type: 'earnings_surprise' | 'earnings_announcement' | 'limit_up_chain';
  stock_code: string;
  stock_name: string | null;
  /** 一句话事件摘要（如 "预增 50%+", "三连板", "扭亏"） */
  summary: string;
  /** 排序值；越大越靠前展示（如 profit_change_low 或 continuous_days） */
  rank_value: number;
  /** 额外字段（forecast_type / profit_change / continuous_days 等，UI 可选展示） */
  metadata?: Record<string, unknown>;
}

export interface TodaySignalsResult {
  /** 信号查询 as-of 日期 */
  trade_date: string | null;
  /** 账户摘要（可能为 null：未建账户） */
  account: AccountSummary | null;
  /** 未读风险告警（最近 20 条） */
  unread_alerts: UnreadRiskAlertItem[];
  unread_alert_count: number;
  /** 中部三列 */
  multi_factor: MultiFactorBlock;
  dragon_head: DragonHeadBlock;
  earnings_surprise: EarningsSurpriseBlock;
  /** 底部关键事件（按 event_type 分组前已合并排序） */
  key_events: KeyEventItem[];
}

export interface TodaySignalsOptions {
  user_id?: number;
  username?: string;
  /** 覆盖 as-of 日期 YYYY-MM-DD；缺省 = factor_scores 最新一日，否则今天 */
  trade_date?: string;
  /** DragonHead 候选 cap（AC: 默认 5） */
  dragon_head_limit?: number;
  /** EarningsSurprise 候选 cap（AC: 默认 3，硬上限 10） */
  earnings_limit?: number;
  /** 未读告警 cap（默认 20） */
  alerts_limit?: number;
}

export interface ApplySignalsOptions {
  user_id: number;
  username?: string;
  /** 覆盖 as-of 日期；缺省 = 同 getTodaySignals 默认 */
  trade_date?: string;
  /** 每个 BUY 信号下单买入金额（元）；默认 5000 元 */
  per_order_amount?: number;
  /** 总下单数上限（防误触一次买入几十只）；默认 20 */
  max_orders?: number;
}

export interface ApplySignalsResult {
  trade_date: string | null;
  /** 本次下单成功条数 */
  placed: number;
  /** 跳过条数（已持有 / 价格缺失 / 现金不足） */
  skipped: number;
  /** 下单明细 */
  orders: Array<{
    strategy: 'multi_factor' | 'dragon_head' | 'earnings_surprise';
    symbol: string;
    name: string | null;
    quantity: number;
    expected_amount: number;
    status: 'placed' | 'skipped' | 'failed';
    reason?: string;
    /** 实际成交价（成功时填入） */
    execute_price?: number;
  }>;
}

// ---------- Service -------------------------------------------------------

export class TodaySignalsService {
  private readonly multiFactorStrategy: MultiFactorAlphaStrategy;
  private readonly dragonHeadStrategy: DragonHeadMomentumStrategy;
  private readonly earningsSurpriseStrategy: EarningsSurpriseStrategy;

  /**
   * In-memory cache for /today/signals — TTL 90s.
   * Key: `${trade_date_override||'auto'}|${user_id||0}|${dragonLimit}|${earningsLimit}|${alertsLimit}`
   * 一日内同一用户的相同参数请求直接返回 cached（量化 pipeline 一天才跑一次，没必要每次重算）。
   */
  private cache = new Map<string, { expiresAt: number; payload: TodaySignalsResult }>();
  private readonly CACHE_TTL_MS = 90_000;

  constructor() {
    this.multiFactorStrategy = new MultiFactorAlphaStrategy();
    this.dragonHeadStrategy = new DragonHeadMomentumStrategy();
    this.earningsSurpriseStrategy = new EarningsSurpriseStrategy();
  }

  /**
   * GET /api/today/signals 的核心实现。
   */
  async getTodaySignals(options: TodaySignalsOptions): Promise<TodaySignalsResult> {
    const tradeDate = await this.resolveTradeDate(options.trade_date);
    const dragonHeadLimit = clampInt(options.dragon_head_limit, 5, 1, 50);
    const earningsLimit = clampInt(options.earnings_limit, 3, 1, 10);
    const alertsLimit = clampInt(options.alerts_limit, 20, 1, 100);

    // 缓存命中检查 — 90s TTL；refresh=true 或显式 use_cache=false 跳过
    const useCache = (options as any).use_cache !== false && !(options as any).refresh;
    const cacheKey = `${options.trade_date || 'auto'}|${options.user_id || 0}|${dragonHeadLimit}|${earningsLimit}|${alertsLimit}`;
    if (useCache) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) {
        logger.debug(`[TodaySignals] cache HIT ${cacheKey}`);
        return hit.payload;
      }
    }

    const userId = options.user_id;
    const portfolio = userId
      ? await PaperTradingPortfolio.findOne({ where: { user_id: userId } })
      : null;
    const positions = portfolio
      ? await PaperTradingPosition.findAll({ where: { portfolio_id: portfolio.id } })
      : [];

    const previousSelectionForMFA = positions.map(p => stripSuffix(p.symbol));

    // 并发跑三条策略 + 账户摘要 + 告警 + 事件 — 任一失败不应阻塞其他
    const [multiFactorBlock, dragonHeadBlock, earningsBlock, accountSummary, alerts, keyEvents] =
      await Promise.all([
        this.computeMultiFactorBlock(tradeDate, previousSelectionForMFA).catch(e => ({
          trade_date: tradeDate,
          signals: [],
          new_picks: 0,
          drops: 0,
          keeps: 0,
          target_portfolio: [],
          error: `MultiFactorAlpha 失败：${errMsg(e)}`,
        })) as Promise<MultiFactorBlock>,
        this.computeDragonHeadBlock(tradeDate, dragonHeadLimit).catch(e => ({
          trade_date: tradeDate,
          candidates: [],
          eligible_count: 0,
          error: `DragonHeadMomentum 失败：${errMsg(e)}`,
        })) as Promise<DragonHeadBlock>,
        this.computeEarningsSurpriseBlock(tradeDate, earningsLimit).catch(e => ({
          trade_date: tradeDate,
          candidates: [],
          forecast_pool_size: 0,
          eligible_count: 0,
          error: `EarningsSurprise 失败：${errMsg(e)}`,
        })) as Promise<EarningsSurpriseBlock>,
        this.computeAccountSummary(portfolio, positions).catch(e => {
          logger.warn('TodaySignalsService: account summary failed', e);
          return null;
        }) as Promise<AccountSummary | null>,
        userId
          ? this.loadUnreadAlerts(userId, alertsLimit).catch(e => {
              logger.warn('TodaySignalsService: unread alerts failed', e);
              return { rows: [], count: 0 };
            })
          : Promise.resolve({ rows: [], count: 0 }),
        this.loadKeyEvents(tradeDate).catch(e => {
          logger.warn('TodaySignalsService: key events failed', e);
          return [];
        }) as Promise<KeyEventItem[]>,
      ]);

    const payload: TodaySignalsResult = {
      trade_date: tradeDate,
      account: accountSummary,
      unread_alerts: alerts.rows,
      unread_alert_count: alerts.count,
      multi_factor: multiFactorBlock,
      dragon_head: dragonHeadBlock,
      earnings_surprise: earningsBlock,
      key_events: keyEvents,
    };

    // 写入缓存（90s TTL）
    if (useCache) {
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + this.CACHE_TTL_MS,
        payload,
      });
      // 简单 GC：cache 超过 50 条时清理过期项
      if (this.cache.size > 50) {
        const now = Date.now();
        for (const [k, v] of this.cache) {
          if (v.expiresAt < now) this.cache.delete(k);
        }
      }
    }

    return payload;
  }

  /**
   * POST /api/today/apply-signals 的核心实现。
   *
   * 流程：
   *   1. 重新跑一次 getTodaySignals（保证下单决策与 UI 看到的一致）
   *   2. 收集所有"今日新进入选" BUY 信号（不下 HOLD / SELL）
   *   3. 按 per_order_amount + 100 股最小手数估算下单 quantity
   *   4. 逐笔调 paperTradingFacade.placeOrder，捕获异常成 skipped/failed
   *   5. 返回明细供前端 toast / 跳转持仓页
   */
  async applySignals(options: ApplySignalsOptions): Promise<ApplySignalsResult> {
    if (!options.user_id) {
      throw new Error('apply-signals: user_id is required');
    }
    const perOrderAmount = clampInt(options.per_order_amount, 5000, 1000, 1_000_000);
    const maxOrders = clampInt(options.max_orders, 20, 1, 200);

    const signals = await this.getTodaySignals({
      user_id: options.user_id,
      username: options.username,
      trade_date: options.trade_date,
    });

    // 收集所有 BUY 信号 — 三个策略合并，按策略名打标
    type Candidate = {
      strategy: 'multi_factor' | 'dragon_head' | 'earnings_surprise';
      symbol: string; // .SH/.SZ 后缀格式
      name: string | null;
      reference_price?: number;
    };
    const candidates: Candidate[] = [];

    for (const s of signals.multi_factor.signals) {
      if (s.signal !== 'buy') continue;
      candidates.push({
        strategy: 'multi_factor',
        symbol: inferSymbol(s.stock_code),
        name: s.name ?? null,
      });
    }
    for (const s of signals.dragon_head.candidates) {
      if (s.signal !== 'buy') continue;
      candidates.push({
        strategy: 'dragon_head',
        symbol: inferSymbol(s.stock_code),
        name: s.name ?? null,
        reference_price: s.reference_price,
      });
    }
    for (const s of signals.earnings_surprise.candidates) {
      if (s.signal !== 'buy') continue;
      candidates.push({
        strategy: 'earnings_surprise',
        symbol: inferSymbol(s.stock_code),
        name: s.name ?? null,
        reference_price: s.reference_price,
      });
    }

    const orders: ApplySignalsResult['orders'] = [];
    let placed = 0;
    let skipped = 0;

    // 已持有的股票（任何策略已建仓）→ 跳过避免重复 BUY
    const portfolio = await PaperTradingPortfolio.findOne({ where: { user_id: options.user_id } });
    const heldSymbols = new Set<string>();
    if (portfolio) {
      const positions = await PaperTradingPosition.findAll({
        where: { portfolio_id: portfolio.id },
      });
      for (const p of positions) heldSymbols.add(p.symbol);
    }

    const seenInBatch = new Set<string>();
    for (const c of candidates) {
      if (placed >= maxOrders) break;
      if (heldSymbols.has(c.symbol) || seenInBatch.has(c.symbol)) {
        orders.push({
          strategy: c.strategy,
          symbol: c.symbol,
          name: c.name,
          quantity: 0,
          expected_amount: perOrderAmount,
          status: 'skipped',
          reason: heldSymbols.has(c.symbol) ? '已持有该股票' : '本批次已下过单',
        });
        skipped += 1;
        continue;
      }
      seenInBatch.add(c.symbol);

      // 估算 quantity：reference_price 优先；否则按 10 元/股粗算（placeOrder 会用实时价精算）
      const priceHint = c.reference_price && c.reference_price > 0 ? c.reference_price : 10;
      const rawQty = Math.floor(perOrderAmount / priceHint);
      const quantity = Math.max(100, Math.floor(rawQty / 100) * 100);

      try {
        const result = await paperTradingFacade.placeOrder({
          user_id: options.user_id,
          symbol: c.symbol,
          direction: 'BUY',
          quantity,
        });
        placed += 1;
        orders.push({
          strategy: c.strategy,
          symbol: c.symbol,
          name: c.name,
          quantity,
          expected_amount: perOrderAmount,
          status: 'placed',
          execute_price: (result as { execute_price?: number })?.execute_price,
        });
      } catch (e: unknown) {
        skipped += 1;
        orders.push({
          strategy: c.strategy,
          symbol: c.symbol,
          name: c.name,
          quantity,
          expected_amount: perOrderAmount,
          status: 'failed',
          reason: errMsg(e),
        });
      }
    }

    return {
      trade_date: signals.trade_date,
      placed,
      skipped,
      orders,
    };
  }

  // ---------- 内部 ---------------------------------------------------------

  /** factor_scores 最新一日；空表 → 今天 UTC ISO */
  private async resolveTradeDate(override?: string): Promise<string | null> {
    if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) {
      return override;
    }
    const row = await FactorScore.findOne({
      attributes: [[fn('MAX', col('trade_date')), 'latest_trade_date']],
      raw: true,
    });
    const latest =
      (row as unknown as { latest_trade_date?: string | Date | null } | null)?.latest_trade_date ??
      null;
    if (!latest) return null;
    if (typeof latest === 'string') {
      if (/^\d{4}-\d{2}-\d{2}/.test(latest)) return latest.slice(0, 10);
      return null;
    }
    return latest.toISOString().slice(0, 10);
  }

  private async computeMultiFactorBlock(
    tradeDate: string | null,
    previousSelection: string[]
  ): Promise<MultiFactorBlock> {
    if (!tradeDate) {
      return {
        trade_date: null,
        signals: [],
        new_picks: 0,
        drops: 0,
        keeps: 0,
        target_portfolio: [],
        error: 'factor_scores 表为空，请先运行 npm run compute:factors',
      };
    }
    const result = await this.multiFactorStrategy.generateSignals(tradeDate, { previousSelection });
    const buyCount = result.signals.filter(s => s.signal === 'buy').length;
    const sellCount = result.signals.filter(s => s.signal === 'sell').length;
    const holdCount = result.signals.filter(s => s.signal === 'hold').length;
    return {
      trade_date: result.trade_date,
      signals: result.signals,
      new_picks: buyCount,
      drops: sellCount,
      keeps: holdCount,
      target_portfolio: result.target_portfolio,
    };
  }

  private async computeDragonHeadBlock(
    tradeDate: string | null,
    limit: number
  ): Promise<DragonHeadBlock> {
    if (!tradeDate) {
      return {
        trade_date: null,
        candidates: [],
        eligible_count: 0,
        error: '缺少 trade_date',
      };
    }

    // DragonHead 依赖 limit_up_stocks (push2.eastmoney 数据滞后于 factor_scores)。
    // 用 limit_up_stocks 表自己的最新 trade_date，而不是全局 tradeDate。
    let effectiveDate = tradeDate;
    try {
      const latestRow: any = await LimitUpStock.findOne({
        attributes: [[fn('MAX', col('trade_date')), 'd']],
        where: { trade_date: { [Op.lte]: tradeDate } },
        raw: true,
      });
      const latest = latestRow?.d;
      if (latest) {
        if (typeof latest === 'string') {
          effectiveDate = latest.slice(0, 10);
        } else if (latest instanceof Date) {
          effectiveDate = latest.toISOString().slice(0, 10);
        }
      }
    } catch (e) {
      // 失败回退到 tradeDate
    }

    const result = await this.dragonHeadStrategy.generateSignals(effectiveDate, {
      currentPositions: [],
    });
    const buys = result.signals.filter(s => s.signal === 'buy').slice(0, limit);
    return {
      trade_date: result.trade_date,
      candidates: buys,
      eligible_count: result.eligible_count,
      limit_up_pool_size: result.filtered?.limit_up_pool_size ?? 0,
      market_sentiment_value: result.market_sentiment?.value ?? null,
      market_sentiment_blocked: result.market_sentiment?.blocked ?? false,
      filter_stats: {
        one_word_board: result.filtered?.one_word_board ?? 0,
        fail_continuous_days: result.filtered?.fail_continuous_days ?? 0,
        fail_industry_top: result.filtered?.fail_industry_top ?? 0,
        fail_industry_unknown: result.filtered?.fail_industry_unknown ?? 0,
        fail_meta_missing: result.filtered?.fail_meta_missing ?? 0,
        fail_market_cap: result.filtered?.fail_market_cap ?? 0,
        fail_famous_yz: result.filtered?.fail_famous_yz ?? 0,
        sentiment_blocked: result.filtered?.sentiment_blocked ?? 0,
      },
    };
  }

  private async computeEarningsSurpriseBlock(
    tradeDate: string | null,
    limit: number
  ): Promise<EarningsSurpriseBlock> {
    if (!tradeDate) {
      return {
        trade_date: null,
        candidates: [],
        forecast_pool_size: 0,
        eligible_count: 0,
        error: '缺少 trade_date',
      };
    }
    const result = await this.earningsSurpriseStrategy.generateSignals(tradeDate, {
      currentPositions: [],
    });
    const buys = result.signals.filter(s => s.signal === 'buy').slice(0, limit);
    return {
      trade_date: result.trade_date,
      candidates: buys,
      forecast_pool_size: result.filtered.forecast_pool_size,
      eligible_count: result.eligible_count,
    };
  }

  private async computeAccountSummary(
    portfolio: PaperTradingPortfolio | null,
    positions: PaperTradingPosition[]
  ): Promise<AccountSummary | null> {
    if (!portfolio) return null;
    const totalValue = Number(portfolio.total_value ?? 0);
    const currentCash = Number(portfolio.current_cash ?? 0);
    const positionValue = positions.reduce((sum, p) => sum + Number(p.market_value ?? 0), 0);

    // 找昨日 snapshot + 当月初 snapshot；DATEONLY 字段按字符串比较
    const recent = (await PaperTradingSnapshot.findAll({
      attributes: ['date', 'total_value'],
      where: { portfolio_id: portfolio.id },
      order: [['date', 'DESC']],
      limit: 60,
      raw: true,
    })) as unknown as Array<{ date: string; total_value: number | string }>;

    let pnlYesterday: number | null = null;
    let pnlMonthToDate: number | null = null;

    if (recent.length > 0) {
      // 昨日：取最新一条 snapshot 与今值差额
      const latest = recent[0];
      const latestValue = Number(latest.total_value);
      if (Number.isFinite(latestValue)) {
        pnlYesterday = Math.round((totalValue - latestValue) * 100) / 100;
      }

      // 当月初：找当月第一条 snapshot
      const today = new Date();
      const monthStart = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(
        2,
        '0'
      )}-01`;
      const monthSnap = recent.reverse().find(r => r.date >= monthStart);
      if (monthSnap) {
        const monthBaseValue = Number(monthSnap.total_value);
        if (Number.isFinite(monthBaseValue)) {
          pnlMonthToDate = Math.round((totalValue - monthBaseValue) * 100) / 100;
        }
      }
    }

    return {
      total_value: Math.round(totalValue * 100) / 100,
      current_cash: Math.round(currentCash * 100) / 100,
      position_value: Math.round(positionValue * 100) / 100,
      pnl_yesterday: pnlYesterday,
      pnl_month_to_date: pnlMonthToDate,
      portfolio_id: portfolio.id,
    };
  }

  private async loadUnreadAlerts(
    userId: number,
    limit: number
  ): Promise<{ rows: UnreadRiskAlertItem[]; count: number }> {
    const [rows, count] = await Promise.all([
      RiskAlert.findAll({
        where: { user_id: userId, is_read: false },
        order: [['created_at', 'DESC']],
        limit,
        raw: true,
      }) as unknown as Promise<
        Array<{
          id: number;
          symbol: string;
          name: string;
          level: string;
          message: string;
          created_at: Date | string;
        }>
      >,
      RiskAlert.count({ where: { user_id: userId, is_read: false } }),
    ]);
    return {
      rows: rows.map(r => ({
        id: r.id,
        symbol: r.symbol,
        name: r.name,
        level: r.level,
        message: r.message,
        created_at: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
      })),
      count,
    };
  }

  /**
   * "今日关键事件" — 业绩预告（is_surprise 优先）+ 高连板涨停股。
   *
   * 数据源：
   *   - EarningsForecast where announce_date == tradeDate
   *   - LimitUpStock where trade_date == tradeDate AND continuous_days >= 3
   *
   * 排序：超预期业绩 (rank=profit_change_low) → 普通业绩公告 →
   *      高连板涨停 (rank=continuous_days)。最多 30 条。
   */
  private async loadKeyEvents(tradeDate: string | null): Promise<KeyEventItem[]> {
    if (!tradeDate) return [];

    const [forecasts, limitUps] = await Promise.all([
      EarningsForecast.findAll({
        attributes: [
          'stock_code',
          'stock_name',
          'forecast_type',
          'profit_change_low',
          'profit_change_high',
          'is_surprise',
          'report_period',
        ],
        where: { announce_date: tradeDate },
        limit: 100,
        raw: true,
      }) as unknown as Promise<
        Array<{
          stock_code: string;
          stock_name: string | null;
          forecast_type: string | null;
          profit_change_low: number | string | null;
          profit_change_high: number | string | null;
          is_surprise: boolean;
          report_period: string;
        }>
      >,
      LimitUpStock.findAll({
        attributes: ['stock_code', 'stock_name', 'continuous_days', 'industry'],
        where: { trade_date: tradeDate, continuous_days: { [Op.gte]: 3 } },
        order: [['continuous_days', 'DESC']],
        limit: 30,
        raw: true,
      }) as unknown as Promise<
        Array<{
          stock_code: string;
          stock_name: string | null;
          continuous_days: number | string;
          industry: string | null;
        }>
      >,
    ]);

    const events: KeyEventItem[] = [];

    for (const f of forecasts) {
      const low = f.profit_change_low == null ? null : Number(f.profit_change_low);
      const high = f.profit_change_high == null ? null : Number(f.profit_change_high);
      const isSurprise = !!f.is_surprise;
      const summaryParts: string[] = [];
      if (f.forecast_type) summaryParts.push(f.forecast_type);
      if (low != null && Number.isFinite(low)) {
        const range =
          high != null && Number.isFinite(high) && high !== low
            ? `${low.toFixed(0)}%~${high.toFixed(0)}%`
            : `${low.toFixed(0)}%`;
        summaryParts.push(range);
      }
      const summary = summaryParts.length ? summaryParts.join(' · ') : '业绩预告';
      events.push({
        event_type: isSurprise ? 'earnings_surprise' : 'earnings_announcement',
        stock_code: f.stock_code,
        stock_name: f.stock_name ?? null,
        summary,
        rank_value: isSurprise ? 1_000_000 + (low ?? 0) : low ?? 0,
        metadata: {
          forecast_type: f.forecast_type,
          profit_change_low: low,
          profit_change_high: high,
          is_surprise: isSurprise,
          report_period: f.report_period,
        },
      });
    }

    for (const r of limitUps) {
      const cd =
        typeof r.continuous_days === 'string' ? Number(r.continuous_days) : r.continuous_days;
      events.push({
        event_type: 'limit_up_chain',
        stock_code: r.stock_code,
        stock_name: r.stock_name ?? null,
        summary: `${cd} 连板${r.industry ? ` · ${r.industry}` : ''}`,
        rank_value: cd,
        metadata: { continuous_days: cd, industry: r.industry },
      });
    }

    events.sort((a, b) => {
      // 超预期优先（rank > 1M），其次按 rank 降序
      if (a.event_type === 'earnings_surprise' && b.event_type !== 'earnings_surprise') return -1;
      if (b.event_type === 'earnings_surprise' && a.event_type !== 'earnings_surprise') return 1;
      return b.rank_value - a.rank_value;
    });
    return events.slice(0, 30);
  }
}

// ---------- helpers --------------------------------------------------------

function clampInt(value: unknown, defaultValue: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return defaultValue;
  return Math.max(min, Math.min(max, n));
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function stripSuffix(symbol: string): string {
  if (!symbol) return '';
  const s = symbol.trim();
  if (!s) return '';
  const i = s.indexOf('.');
  if (i < 0) return s;
  const before = s.slice(0, i);
  const after = s.slice(i + 1);
  // 前缀格式 (sh./sz./bj.) — 2 字母 alpha + 数字
  if (/^[a-zA-Z]{2}$/.test(before)) return after;
  return before;
}

/** "600519" → "600519.SH"；"000001" → "000001.SZ"；"688981" → "688981.SH"；"8/4 开头" → ".BJ" */
function inferSymbol(code: string): string {
  if (code.includes('.')) return code;
  if (!code) return code;
  const first = code.charAt(0);
  // stocks 表存的是 sh./sz./bj. 前缀格式
  if (first === '6' || first === '9' || first === '7') return `sh.${code}`;
  if (first === '0' || first === '2' || first === '3') return `sz.${code}`;
  if (first === '8' || first === '4') return `bj.${code}`;
  return `sh.${code}`;
}

// 单例 — controller 直接 import 使用
export const todaySignalsService = new TodaySignalsService();
