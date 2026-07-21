import { fn, col } from 'sequelize';
import { logger } from '../utils/logger';
import { paperTradingFacade } from '../portfolio/PaperTradingFacade';
import { ETFRotationStrategy, ETFRotationSignal } from '../quant/strategies/ETFRotationStrategy';
import { FactorScore } from '../models/FactorScore';
import { RiskAlert } from '../models/RiskAlert';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingSnapshot } from '../models/PaperTradingSnapshot';
import { getETFProfile } from '../constants/etfIndustry';

/**
 * TodaySignalsService — 今日作战工作区后端聚合器 (信号优先重构 批5 改造版)
 *
 * 旧版聚合 3 条 per-stock 策略 (多因子/龙头/业绩超预期); 批5 主线切换为
 * **ETF 因子轮动 (核心 70%)** 单一策略, 本 service 只对外聚合:
 *
 *   - ETFRotationStrategy 当日 (按 factor_scores 最新 trade_date) 月度再平衡信号
 *     (top4 买 / top6 卖缓冲带, 目标权重 §4.1)
 *   - 账户摘要 + 未读风险告警 + 今日关键事件 (业绩预告 / 高连板, 只读展示)
 *
 * 设计要点:
 *   1. ETF 轮动是**组合级**策略, 走 generateSignals(tradeDate); 失败 → block
 *      返回 error 字段, 其余 (账户/告警/事件) 仍正常输出。
 *   2. currentHoldings 用真实持仓 ETF 代码 (去 sh./sz. 后缀), 算 BUY/SELL/HOLD 增量。
 *   3. trade_date 默认取 factor_scores 最新一日; 调用方可显式传 `?date=YYYY-MM-DD`。
 *   4. applySignals 把 BUY 信号按目标权重换算金额下到模拟盘 (ETF 100 份最小手数),
 *      已持有的 HOLD 不重复下单; SELL 不自动平仓 (只 UI 展示, 由再平衡引擎/风控执行)。
 */

// ---------- Types ---------------------------------------------------------

export interface AccountSummary {
  total_value: number;
  current_cash: number;
  position_value: number;
  pnl_yesterday: number | null;
  pnl_month_to_date: number | null;
  initial_capital: number;
  total_return: number;
  total_return_pct: number | null;
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

export interface ETFRotationBlock {
  trade_date: string | null;
  /** 全 universe 打分 + BUY/SELL/HOLD 增量信号 (含目标权重) */
  signals: ETFRotationSignal[];
  /** 新买入数 (BUY count) */
  buy_count: number;
  /** 卖出数 (SELL count) */
  sell_count: number;
  /** 持有数 (HOLD count) */
  hold_count: number;
  /** 核心桶目标总仓位 (Σ target_weight, ≤ 0.70) */
  core_total_weight: number;
  /** 换仓后应持有的 ETF 6 位代码 (target_weight > 0) */
  target_holdings: string[];
  error?: string;
}

export interface KeyEventItem {
  event_type: 'earnings_surprise' | 'earnings_announcement' | 'limit_up_chain';
  stock_code: string;
  stock_name: string | null;
  summary: string;
  rank_value: number;
  metadata?: Record<string, unknown>;
}

export interface TodaySignalsResult {
  /** 信号查询 as-of 日期 */
  trade_date: string | null;
  /** 账户摘要 (可能为 null: 未建账户) */
  account: AccountSummary | null;
  /** 未读风险告警 (最近 N 条) */
  unread_alerts: UnreadRiskAlertItem[];
  unread_alert_count: number;
  /** 核心主线: ETF 因子轮动 */
  etf_rotation: ETFRotationBlock;
  /** 底部关键事件 (只读展示) */
  key_events: KeyEventItem[];
}

export interface TodaySignalsOptions {
  user_id?: number;
  username?: string;
  /** 覆盖 as-of 日期 YYYY-MM-DD; 缺省 = factor_scores 最新一日 */
  trade_date?: string;
  /** 未读告警 cap (默认 20) */
  alerts_limit?: number;
  /** 显式 portfolio_id (多账户多盘场景必须传, 防串盘) */
  portfolio_id?: number;
}

export interface ApplySignalsOptions {
  user_id: number;
  username?: string;
  trade_date?: string;
  /** 无账户净值兜底时每个 BUY 信号的下单金额 (元); 默认 5000 */
  per_order_amount?: number;
  /** 总下单数上限; 默认 20 */
  max_orders?: number;
  /** 显式 portfolio_id (决定下到哪个盘) */
  portfolio_id: number;
}

export interface ApplySignalsResult {
  trade_date: string | null;
  placed: number;
  skipped: number;
  orders: Array<{
    strategy: 'etf_rotation';
    symbol: string;
    name: string | null;
    quantity: number;
    expected_amount: number;
    status: 'placed' | 'skipped' | 'failed';
    reason?: string;
    execute_price?: number;
  }>;
}

// ---------- Service -------------------------------------------------------

export class TodaySignalsService {
  private readonly etfRotationStrategy: ETFRotationStrategy;

  private cache = new Map<string, { expiresAt: number; payload: TodaySignalsResult }>();
  private readonly CACHE_TTL_MS = 90_000;

  constructor() {
    this.etfRotationStrategy = new ETFRotationStrategy();
  }

  /**
   * GET /api/today/signals 的核心实现。
   */
  async getTodaySignals(options: TodaySignalsOptions): Promise<TodaySignalsResult> {
    const tradeDate = await this.resolveTradeDate(options.trade_date);
    const alertsLimit = clampInt(options.alerts_limit, 20, 1, 100);

    const useCache = (options as any).use_cache !== false && !(options as any).refresh;
    const cacheKey = `${options.trade_date || 'auto'}|${options.user_id || 0}|${
      options.portfolio_id || 0
    }|${alertsLimit}`;
    if (useCache) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) {
        logger.debug(`[TodaySignals] cache HIT ${cacheKey}`);
        return hit.payload;
      }
    }

    const userId = options.user_id;
    let portfolio: PaperTradingPortfolio | null = null;
    if (userId) {
      if (!Number.isInteger(options.portfolio_id) || Number(options.portfolio_id) <= 0) {
        const error: any = new Error(
          'today-signals: portfolio_id 必须为正整数，禁止自动选择其他模拟盘'
        );
        error.statusCode = 400;
        error.code = 'PORTFOLIO_SCOPE_REQUIRED';
        throw error;
      }
      portfolio = await PaperTradingPortfolio.findOne({
        where: { id: options.portfolio_id, user_id: userId },
      });
      if (!portfolio) {
        const error: any = new Error('today-signals: portfolio not found or forbidden');
        error.statusCode = 404;
        error.code = 'PORTFOLIO_NOT_FOUND_OR_FORBIDDEN';
        throw error;
      }
    }
    const positions = portfolio
      ? await PaperTradingPosition.findAll({ where: { portfolio_id: portfolio.id } })
      : [];

    // 当前持有的 ETF 代码 (只取白名单 ETF, 去后缀) 作为轮动增量基准
    const currentHoldings = positions
      .map(p => stripSuffix(p.symbol))
      .filter(code => !!getETFProfile(code));

    const [etfBlock, accountSummary, alerts, keyEvents] = await Promise.all([
      this.computeETFRotationBlock(tradeDate, currentHoldings).catch(e => ({
        trade_date: tradeDate,
        signals: [],
        buy_count: 0,
        sell_count: 0,
        hold_count: 0,
        core_total_weight: 0,
        target_holdings: [],
        error: `ETF 因子轮动失败：${errMsg(e)}`,
      })) as Promise<ETFRotationBlock>,
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
      etf_rotation: etfBlock,
      key_events: keyEvents,
    };

    if (useCache) {
      this.cache.set(cacheKey, { expiresAt: Date.now() + this.CACHE_TTL_MS, payload });
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
   * POST /api/today/apply-signals — 把 ETF 轮动 BUY 信号按目标权重下到模拟盘。
   */
  async applySignals(options: ApplySignalsOptions): Promise<ApplySignalsResult> {
    if (!options.user_id) {
      throw new Error('apply-signals: user_id is required');
    }
    if (!Number.isInteger(options.portfolio_id) || Number(options.portfolio_id) <= 0) {
      const error: any = new Error('apply-signals: portfolio_id is required');
      error.statusCode = 400;
      error.code = 'PORTFOLIO_SCOPE_REQUIRED';
      throw error;
    }
    const perOrderAmount = clampInt(options.per_order_amount, 5000, 1000, 1_000_000);
    const maxOrders = clampInt(options.max_orders, 20, 1, 200);

    const signals = await this.getTodaySignals({
      user_id: options.user_id,
      username: options.username,
      trade_date: options.trade_date,
      portfolio_id: options.portfolio_id,
    });

    // 决定下单目标盘 + 账户净值 (目标权重换算金额)
    const portfolio = await PaperTradingPortfolio.findOne({
      where: { id: options.portfolio_id, user_id: options.user_id },
    });
    if (!portfolio) throw new Error('apply-signals: portfolio not found or forbidden');
    const totalValue = portfolio ? Number(portfolio.total_value ?? 0) : 0;

    const heldSymbols = new Set<string>();
    if (portfolio) {
      const positions = await PaperTradingPosition.findAll({
        where: { portfolio_id: portfolio.id },
      });
      for (const p of positions) heldSymbols.add(p.symbol);
    }

    type Candidate = {
      symbol: string; // sh./sz. 后缀格式
      name: string | null;
      target_weight: number;
    };
    const candidates: Candidate[] = signals.etf_rotation.signals
      .filter(s => s.action === 'buy')
      .map(s => ({
        symbol: inferEtfSymbol(s.etf_code),
        name: s.name ?? getETFProfile(s.etf_code)?.name ?? null,
        target_weight: s.target_weight,
      }));

    const orders: ApplySignalsResult['orders'] = [];
    let placed = 0;
    let skipped = 0;
    const seenInBatch = new Set<string>();

    for (const c of candidates) {
      if (placed >= maxOrders) break;
      if (heldSymbols.has(c.symbol) || seenInBatch.has(c.symbol)) {
        orders.push({
          strategy: 'etf_rotation',
          symbol: c.symbol,
          name: c.name,
          quantity: 0,
          expected_amount: 0,
          status: 'skipped',
          reason: heldSymbols.has(c.symbol) ? '已持有该 ETF' : '本批次已下过单',
        });
        skipped += 1;
        continue;
      }
      seenInBatch.add(c.symbol);

      // 目标金额 = 目标权重 × 账户净值; 无净值兜底 perOrderAmount
      const targetAmount =
        totalValue > 0 && c.target_weight > 0
          ? Math.round(c.target_weight * totalValue)
          : perOrderAmount;

      // ETF 价格: 从最新 daily_bar 拉真实价 (避免假设价超买)
      let priceHint: number | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DailyBar } = require('../models/DailyBar');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Stock } = require('../models/Stock');
        const stock = await Stock.findOne({ where: { symbol: c.symbol }, raw: true });
        if (stock) {
          const lastBar = await DailyBar.findOne({
            where: { stock_id: stock.id },
            order: [['time', 'DESC']],
            raw: true,
          });
          if (lastBar && lastBar.close > 0) priceHint = Number(lastBar.close);
        }
      } catch {
        // ignore
      }
      if (!priceHint || priceHint <= 0) {
        orders.push({
          strategy: 'etf_rotation',
          symbol: c.symbol,
          name: c.name,
          quantity: 0,
          expected_amount: 0,
          status: 'skipped',
          reason: '无法获取真实价格，跳过避免超买',
        });
        skipped += 1;
        continue;
      }

      // ETF 100 份最小手数; 按 targetAmount 整 100 份, 不足 100 用最小 100
      const rawQty = Math.floor(targetAmount / priceHint);
      const quantity = rawQty >= 100 ? Math.floor(rawQty / 100) * 100 : 100;

      try {
        const { buildTradeReasonFromSignal, summarizeTradeReason } = await import(
          '../portfolio/internal/tradeReasonBuilder'
        );
        const reason = buildTradeReasonFromSignal({
          strategy_key: 'etf_factor_rotation',
          reasons: [
            `ETF 因子轮动: 目标权重 ${(c.target_weight * 100).toFixed(1)}% 买入 ${c.symbol}`,
          ],
        });
        const result = await paperTradingFacade.placeOrder({
          user_id: options.user_id,
          portfolio_id: portfolio.id,
          symbol: c.symbol,
          direction: 'BUY',
          quantity,
          trade_reason: reason,
          trade_reason_summary: summarizeTradeReason(reason, 'BUY'),
        });
        placed += 1;
        orders.push({
          strategy: 'etf_rotation',
          symbol: c.symbol,
          name: c.name,
          quantity,
          expected_amount: targetAmount,
          status: 'placed',
          execute_price: (result as { execute_price?: number })?.execute_price,
        });
      } catch (e: unknown) {
        skipped += 1;
        orders.push({
          strategy: 'etf_rotation',
          symbol: c.symbol,
          name: c.name,
          quantity,
          expected_amount: targetAmount,
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

  /** factor_scores 最新一日; 空表 → null */
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

  private async computeETFRotationBlock(
    tradeDate: string | null,
    currentHoldings: string[]
  ): Promise<ETFRotationBlock> {
    if (!tradeDate) {
      return {
        trade_date: null,
        signals: [],
        buy_count: 0,
        sell_count: 0,
        hold_count: 0,
        core_total_weight: 0,
        target_holdings: [],
        error: 'factor_scores 表为空，请先运行 npm run compute:factors',
      };
    }
    const signals = await this.etfRotationStrategy.generateSignals(tradeDate, { currentHoldings });
    const buyCount = signals.filter(s => s.action === 'buy').length;
    const sellCount = signals.filter(s => s.action === 'sell').length;
    const holdCount = signals.filter(s => s.action === 'hold').length;
    const targetHoldings = signals.filter(s => s.target_weight > 0).map(s => s.etf_code);
    const coreTotalWeight =
      Math.round(signals.reduce((sum, s) => sum + (s.target_weight || 0), 0) * 10000) / 10000;
    return {
      trade_date: tradeDate,
      signals,
      buy_count: buyCount,
      sell_count: sellCount,
      hold_count: holdCount,
      core_total_weight: coreTotalWeight,
      target_holdings: targetHoldings,
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
      const todayIso = new Date().toISOString().slice(0, 10);
      const yesterdayOrEarlier = recent.find(r => String(r.date) < todayIso);
      if (yesterdayOrEarlier) {
        const latestValue = Number(yesterdayOrEarlier.total_value);
        if (Number.isFinite(latestValue)) {
          pnlYesterday = Math.round((totalValue - latestValue) * 100) / 100;
        }
      }

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

    const initialCapital = Number(portfolio.initial_capital ?? 0);
    const totalReturn = totalValue - initialCapital;
    const totalReturnPct =
      initialCapital > 0 ? Math.round((totalReturn / initialCapital) * 10000) / 10000 : null;

    return {
      total_value: Math.round(totalValue * 100) / 100,
      current_cash: Math.round(currentCash * 100) / 100,
      position_value: Math.round(positionValue * 100) / 100,
      pnl_yesterday: pnlYesterday,
      pnl_month_to_date: pnlMonthToDate,
      initial_capital: Math.round(initialCapital * 100) / 100,
      total_return: Math.round(totalReturn * 100) / 100,
      total_return_pct: totalReturnPct,
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
   * "今日关键事件" — 业绩预告 (is_surprise 优先) + 高连板涨停股 (只读展示)。
   * 数据源: EarningsForecast (announce_date == tradeDate) + LimitUpStock
   * (trade_date == tradeDate AND continuous_days >= 3)。最多 30 条。
   */
  private async loadKeyEvents(tradeDate: string | null): Promise<KeyEventItem[]> {
    if (!tradeDate) return [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Op } = require('sequelize');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EarningsForecast } = require('../models/EarningsForecast');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LimitUpStock } = require('../models/LimitUpStock');

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
  if (/^[a-zA-Z]{2}$/.test(before)) return after;
  return before;
}

/**
 * ETF 6 位代码 → stocks 表 symbol 前缀格式。
 * 沪市 ETF: 51/56/58/50 开头 → sh.; 深市 ETF: 15/16/18 开头 → sz.。
 * 已含 `.`/前缀则原样返回。
 */
function inferEtfSymbol(code: string): string {
  if (!code) return code;
  if (code.includes('.')) return code;
  if (/^5/.test(code)) return `sh.${code}`;
  if (/^1/.test(code)) return `sz.${code}`;
  return `sh.${code}`;
}

// 单例 — controller 直接 import 使用
export const todaySignalsService = new TodaySignalsService();
