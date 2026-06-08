import { Op, fn, col } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { DragonTigerBoard } from '../../models/DragonTigerBoard';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { logger } from '../../utils/logger';
import { isSTName } from '../../utils/stNameUtils';

/**
 * GameTraderRelayStrategy — 游资接力（US-025）
 *
 * 短线接力策略：识别某只股票在近 lookbackDays（默认 2）个交易日内**连续多日**
 * 出现知名游资席位且累计净买入 > netBuyThreshold（默认 5000 万），同时当日股价
 * 强势上涨（涨幅 > 5%），符合接力买入条件。本质是"昨天游资+今天游资+今天起涨"
 * 的三确认入场。
 *
 * 与 DragonHeadMomentumStrategy（短线龙头）的差异：
 *   - **不要求当日涨停** —— GameTraderRelay 抓"游资连续多日建仓但未必涨停"的票，
 *     盘面更柔和（涨幅 > 5% 即可），适合在涨停板梯队之外做补涨。
 *   - **多日累计净买入门槛**（5000 万）而非"当日单日 famous_yz 净买入 > 0" ——
 *     强调"连续多日"的累计配合而非单日爆发。
 *   - 持仓周期相同（3 个交易日强制平），但出场加了"次日跌幅 > 3% 严格止跌" +
 *     "次日游资席位消失" 双线。
 *
 * 与现有 QuantStrategy 基类的 evaluate() 兼容性：
 *   组合级策略；evaluate() 返回信息性 'hold'，真正入口是 generateSignals(date)。
 *
 * 默认参数（AC 指定值）：
 *   maxPositions=5  lookbackDays=2  netBuyThreshold=50_000_000
 *   minDailyChangePct=0.05  minCirculatingMarketCap=30亿  maxCirculatingMarketCap=150亿
 *   holdingDaysLimit=3  exitNextDayDropPct=-0.03  stopLossPct=-0.07
 *
 * 入场 4 条件（全部 AND）：
 *   1. 近 lookbackDays 个交易日累计 famous_yz 净买入 > netBuyThreshold（5000 万）
 *      —— 单日不够时累计也算，但 lookback 内必须**至少 2 个不同 trade_date** 都
 *      有 famous_yz 买入（"接力"语义）
 *   2. 当日涨幅 > minDailyChangePct（5%）—— 盘面强势确认
 *   3. 流通市值 ∈ [minCirculatingMarketCap, maxCirculatingMarketCap]（30-150 亿）
 *   4. 非 ST / *ST
 *
 * 出场优先级（按 A → D 排序）：
 *   A. 持有 ≥ holdingDaysLimit（3 自然日）→ SELL 全部
 *   B. (close - entry_price) / entry_price ≤ stopLossPct（默认 -7%）→ SELL（个股止损）
 *   C. 持仓首日后，当日跌幅 ≤ exitNextDayDropPct（默认 -3%）→ SELL（次日大跌止跌）
 *   D. 持仓首日后，当日 famous_yz 席位 净买入 ≤ 0 或没出现 → SELL（接力中断）
 *   E. 否则 HOLD
 *
 * Position 必须携带 entry_date + entry_price（exit 规则需要 holding_days / stop_loss）。
 */

/** 默认参数（AC 指定值） */
export const DEFAULT_GAME_TRADER_RELAY_PARAMS: Readonly<Required<GameTraderRelayParams>> =
  Object.freeze({
    maxPositions: 5,
    lookbackDays: 2,
    netBuyThreshold: 50_000_000,
    minDailyChangePct: 0.05,
    minCirculatingMarketCap: 30 * 1e8,
    maxCirculatingMarketCap: 150 * 1e8,
    holdingDaysLimit: 3,
    exitNextDayDropPct: -0.03,
    stopLossPct: -0.07,
    excludeST: true,
  });

export interface GameTraderRelayParams {
  /** 最大同时持仓数（AC 默认 5） */
  maxPositions: number;
  /** 累计净买入回看交易日数（AC 默认 2） */
  lookbackDays: number;
  /** 累计 famous_yz 净买入门槛（元；AC 默认 5000 万） */
  netBuyThreshold: number;
  /** 当日最小涨幅（AC 默认 0.05 = 5%） */
  minDailyChangePct: number;
  /** 流通市值下限（元；AC 默认 30 亿） */
  minCirculatingMarketCap: number;
  /** 流通市值上限（元；AC 默认 150 亿） */
  maxCirculatingMarketCap: number;
  /** 持有 N 自然日强制 SELL（AC 默认 3） */
  holdingDaysLimit: number;
  /** 次日大跌出场阈值（AC 默认 -0.03 = -3%） */
  exitNextDayDropPct: number;
  /** 个股止损阈值（默认 -0.07 = -7%） */
  stopLossPct: number;
  /** 是否剔除 ST / *ST */
  excludeST: boolean;
}

/** 单只持仓的结构化记录（exit 规则需要 entry_date / entry_price） */
export interface GameTraderRelayPosition {
  stock_code: string;
  /** 进场日 ISO YYYY-MM-DD */
  entry_date: string;
  /** 进场价（用于止损与盈亏计算） */
  entry_price: number;
  /** 进场时的累计 famous_yz 净买入（debug 用） */
  entry_accumulated_net_buy?: number;
}

export interface GameTraderRelaySignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  /** buy=新进入选；sell=全平；hold=保留 */
  signal: 'buy' | 'sell' | 'hold';
  reason: string;
  /** 期望成交价（BUY=当日收盘；SELL=次日开盘/盘中价） */
  reference_price?: number;
  /** 累计净买入金额（元） */
  accumulated_net_buy?: number;
  /** 累计净买入跨多少个 trade_date（接力天数） */
  relay_day_count?: number;
  /** 当日涨幅 */
  daily_change_pct?: number;
  /** 流通市值 */
  circulating_market_cap?: number;
}

/** 入场候选过滤维度统计 */
export interface GameTraderRelayFilteredStats {
  /** 当日 lookback 窗口内有 famous_yz 净买入的候选池规模（过滤前） */
  candidate_pool_size: number;
  /** 累计净买入未达门槛剔除数 */
  fail_net_buy_threshold: number;
  /** 接力天数不足（单日 famous_yz）剔除数 */
  fail_relay_days: number;
  /** 当日涨幅不足剔除数 */
  fail_daily_change: number;
  /** 缺当日行情数据剔除数 */
  fail_missing_quote: number;
  /** 缺元数据 / 没流通市值剔除数 */
  fail_meta_missing: number;
  /** 流通市值不在范围剔除数 */
  fail_market_cap: number;
  /** ST 剔除数 */
  fail_st: number;
}

export interface GameTraderRelaySignalsResult {
  trade_date: string;
  /** 调仓后目标持仓（含已持有保留 + 新进 BUY；不含 SELL 剔除项） */
  target_positions: GameTraderRelayPosition[];
  /** 增量信号（BUY/SELL/HOLD） */
  signals: GameTraderRelaySignal[];
  /** 候选过滤维度统计 */
  filtered: GameTraderRelayFilteredStats;
  /** 实际生效参数（合并 default + override 后） */
  params: GameTraderRelayParams;
  /** 当日 eligible 入场候选总数（未受 maxPositions cap 前） */
  eligible_count: number;
}

export interface GameTraderRelayGenerateOptions {
  params?: Partial<GameTraderRelayParams>;
  /** 当前持仓（包含每只股票的 entry_date + entry_price）；不传视为首次评估（无 exit 流程） */
  currentPositions?: GameTraderRelayPosition[];
}

// ---------------------------------------------------------------------------
// DataSource 接口（便于测试用 fake 注入）
// ---------------------------------------------------------------------------

/**
 * 4 个 loader 方法 — 把所有 Sequelize 查询从策略主体抽离，便于单元测试 mock。
 *
 * 与 DragonHead 的 5 loader 差异：
 *   - 不需要 loadLimitUpStocks / loadTopIndustries —— GameTraderRelay 不需要涨停
 *     池和行业排名，因为入场触发是 famous_yz 累计净买入。
 *   - loadFamousYzAggregates 返回的是 lookback 窗口的累计聚合，不是当日值，
 *     带 (累计金额, 接力天数) 双字段。
 *   - loadDailyQuotes 返回当日行情（含 change_pct），用于入场涨幅判定 + 出场
 *     止跌判定，比 DragonHead 的 loadDailyQuote 少 hit_limit_up 字段。
 */
export interface GameTraderRelayDataSource {
  /**
   * 给定 (asOfDate, lookbackDays)，扫描全市场，返回所有在 lookback 窗口内
   * 至少出现一次 famous_yz 净买入 > 0 的股票。返回 (stock_code → {累计净买入, 接力天数})。
   *
   * 累计净买入 = 窗口内所有 famous_yz=true 行的 net_amount SUM（可正可负）。
   * 接力天数 = 窗口内出现 famous_yz=true 行 且 net_amount > 0 的 distinct trade_date 数。
   *
   * 服务层做最终阈值过滤（NetBuyThreshold + relay day_count ≥ 2）。
   */
  loadFamousYzAggregates(
    asOfDate: string,
    lookbackDays: number
  ): Promise<Map<string, GameTraderRelayAggregate>>;

  /**
   * 给定 stock_codes 集合的元数据（name / industry / circulating_market_cap）。
   * 缺失的 stock_code 可以不出现在返回 Map 中。
   */
  loadStockMeta(stockCodes: string[]): Promise<Map<string, GameTraderRelayStockMeta>>;

  /**
   * 给定 (tradeDate, stockCodes) 的当日行情快照（open/close/prev_close/change_pct）。
   * 入场用 change_pct 判定涨幅 > 5%；出场用 change_pct 判定 next-day drop。
   * 缺数据的 stock_code 可以不出现在返回 Map 中。
   */
  loadDailyQuotes(
    tradeDate: string,
    stockCodes: string[]
  ): Promise<Map<string, GameTraderRelayQuote>>;

  /**
   * 给定 (tradeDate, stockCodes)，返回当日 famous_yz 净买入金额（单日，非累计）。
   * 用于 exit 规则 D（接力中断判定）：若返回 Map 中缺失或值 ≤ 0，视为席位消失。
   */
  loadFamousYzNetBuyToday(tradeDate: string, stockCodes: string[]): Promise<Map<string, number>>;
}

export interface GameTraderRelayAggregate {
  /** lookback 窗口内 famous_yz 累计净买入（可正可负） */
  accumulated_net_buy: number;
  /** lookback 窗口内 famous_yz 出现且净买入 > 0 的 distinct trade_date 数（接力天数） */
  relay_day_count: number;
}

export interface GameTraderRelayStockMeta {
  name?: string | null;
  industry?: string | null;
  circulating_market_cap?: number | null;
}

export interface GameTraderRelayQuote {
  open: number;
  close: number;
  prev_close: number;
  /** 当日涨幅（小数；0.05 = 5%）；缺则由 (close-prev)/prev 算 */
  change_pct: number;
}

// ---------------------------------------------------------------------------
// 生产 DataSource 实现
// ---------------------------------------------------------------------------

/**
 * 默认数据源：直接走 Sequelize 模型。生产环境通过 PRODUCTION_DATA_SOURCE 单例
 * 使用；测试不应触碰这个类。
 */
export class DefaultGameTraderRelayDataSource implements GameTraderRelayDataSource {
  async loadFamousYzAggregates(
    asOfDate: string,
    lookbackDays: number
  ): Promise<Map<string, GameTraderRelayAggregate>> {
    if (lookbackDays <= 0) return new Map();
    // lookback 窗口 = [asOfDate - lookbackDays 自然日, asOfDate]
    // 多 +2 天 buffer 防止周末/节假日缩短交易日数（A 股最长法定连休 7 天会跨节
    // 假期，2 天 buffer 通常够 1-3 day lookback；更宽 lookback 可调）
    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - lookbackDays - 2);
    const lookbackStartIso = lookbackStart.toISOString().slice(0, 10);

    const rows = (await DragonTigerBoard.findAll({
      attributes: ['stock_code', 'trade_date', 'net_amount'],
      where: {
        trade_date: { [Op.between]: [lookbackStartIso, asOfDate] },
        is_famous_yz: true,
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      trade_date: string;
      net_amount: number | string | null;
    }>;

    // 按 trade_date 取交易日数（去掉 buffer 之外的）：先按 trade_date 排序去重，
    // 拿最后 lookbackDays 个 trade_date 才算"窗口内"。
    const allTradeDates = new Set<string>();
    for (const r of rows) allTradeDates.add(r.trade_date);
    const sortedDates = [...allTradeDates].sort();
    const windowDates = new Set(sortedDates.slice(-lookbackDays));

    // 按 stock_code 聚合
    const acc = new Map<string, { sum: number; dateSet: Set<string> }>();
    for (const r of rows) {
      if (!windowDates.has(r.trade_date)) continue;
      const v = typeof r.net_amount === 'string' ? Number(r.net_amount) : r.net_amount;
      if (v == null || !Number.isFinite(v)) continue;
      const cur = acc.get(r.stock_code) ?? { sum: 0, dateSet: new Set<string>() };
      cur.sum += v;
      if (v > 0) cur.dateSet.add(r.trade_date);
      acc.set(r.stock_code, cur);
    }

    const out = new Map<string, GameTraderRelayAggregate>();
    for (const [code, a] of acc.entries()) {
      out.set(code, {
        accumulated_net_buy: a.sum,
        relay_day_count: a.dateSet.size,
      });
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, GameTraderRelayStockMeta>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));
    const rows = (await Stock.findAll({
      attributes: ['symbol', 'name', 'industry', 'circulating_market_cap'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      name: string;
      industry: string | null;
      circulating_market_cap: number | string | null;
    }>;
    const out = new Map<string, GameTraderRelayStockMeta>();
    for (const r of rows) {
      const code = stripSuffix(r.symbol);
      const cap =
        typeof r.circulating_market_cap === 'string'
          ? Number(r.circulating_market_cap)
          : r.circulating_market_cap;
      out.set(code, {
        name: r.name ?? null,
        industry: r.industry ?? null,
        circulating_market_cap: cap != null && Number.isFinite(cap) ? cap : null,
      });
    }
    return out;
  }

  async loadDailyQuotes(
    tradeDate: string,
    stockCodes: string[]
  ): Promise<Map<string, GameTraderRelayQuote>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));
    const stocks = (await Stock.findAll({
      attributes: ['id', 'symbol'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{ id: number; symbol: string }>;
    if (!stocks.length) return new Map();
    const idToCode = new Map<number, string>();
    const stockIds: number[] = [];
    for (const s of stocks) {
      idToCode.set(s.id, stripSuffix(s.symbol));
      stockIds.push(s.id);
    }

    // 拉 [asOfDate - 10 自然日, asOfDate] 的所有 bar，按 stock_id 分组挑当日 + 前一交易日
    const lookbackStart = new Date(`${tradeDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 10);
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'open', 'close', 'change_percent'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: {
          [Op.gte]: lookbackStart.toISOString(),
          [Op.lte]: `${tradeDate}T23:59:59Z`,
        },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      open: number | string;
      close: number | string;
      change_percent: number | string | null;
    }>;

    const barsByStockId = new Map<
      number,
      Array<{
        timeMs: number;
        timeIso: string;
        open: number;
        close: number;
        change_percent: number | null;
      }>
    >();
    for (const b of bars) {
      const open = Number(b.open);
      const close = Number(b.close);
      if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
      const tMs = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
      if (!Number.isFinite(tMs)) continue;
      const tIso =
        b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
      const arr = barsByStockId.get(b.stock_id) ?? [];
      arr.push({
        timeMs: tMs,
        timeIso: tIso,
        open,
        close,
        change_percent:
          b.change_percent != null && Number.isFinite(Number(b.change_percent))
            ? Number(b.change_percent)
            : null,
      });
      barsByStockId.set(b.stock_id, arr);
    }

    const out = new Map<string, GameTraderRelayQuote>();
    for (const [stockId, arr] of barsByStockId.entries()) {
      const code = idToCode.get(stockId);
      if (!code) continue;
      arr.sort((a, b) => a.timeMs - b.timeMs);
      const todayIdx = arr.findIndex(b => b.timeIso === tradeDate);
      if (todayIdx < 0) continue;
      const today = arr[todayIdx];
      const prevIdx = todayIdx - 1;
      if (prevIdx < 0) continue;
      const prevClose = arr[prevIdx].close;
      if (!Number.isFinite(prevClose) || prevClose <= 0) continue;
      const changePct =
        today.change_percent != null
          ? today.change_percent / 100
          : (today.close - prevClose) / prevClose;
      out.set(code, {
        open: today.open,
        close: today.close,
        prev_close: prevClose,
        change_pct: changePct,
      });
    }
    return out;
  }

  async loadFamousYzNetBuyToday(
    tradeDate: string,
    stockCodes: string[]
  ): Promise<Map<string, number>> {
    if (!stockCodes.length) return new Map();
    const rows = (await DragonTigerBoard.findAll({
      attributes: ['stock_code', [fn('SUM', col('net_amount')), 'net_buy']],
      where: {
        trade_date: tradeDate,
        stock_code: { [Op.in]: stockCodes },
        is_famous_yz: true,
      },
      group: ['stock_code'],
      raw: true,
    })) as unknown as Array<{ stock_code: string; net_buy: number | string | null }>;
    const out = new Map<string, number>();
    for (const r of rows) {
      const v = typeof r.net_buy === 'string' ? Number(r.net_buy) : r.net_buy;
      if (v != null && Number.isFinite(v)) out.set(r.stock_code, v);
    }
    return out;
  }
}

const PRODUCTION_DATA_SOURCE: GameTraderRelayDataSource = new DefaultGameTraderRelayDataSource();

// ---------------------------------------------------------------------------
// 策略主体
// ---------------------------------------------------------------------------

export class GameTraderRelayStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'game_trader_relay',
    name: '游资接力',
    description:
      '识别近 2 个交易日同一只股票连续出现知名游资席位、累计净买入 > 5000 万、当日涨幅 > 5%、流通市值 30-150 亿的接力候选；3 日内持有，次日大跌 / 接力中断 / 止损出场。',
    category: 'momentum',
    default_params: { ...DEFAULT_GAME_TRADER_RELAY_PARAMS },
    enabled: true,
    risk_level: 'high',
    tags: ['短线', '游资', '接力', '龙虎榜', '事件驱动'],
    style: 'short_term_event_driven',
  };

  private readonly dataSource: GameTraderRelayDataSource;

  constructor(dataSource: GameTraderRelayDataSource = PRODUCTION_DATA_SOURCE) {
    super();
    this.dataSource = dataSource;
  }

  /**
   * QuantStrategy 抽象基类要求的 per-stock evaluate()。
   *
   * 本策略是组合级，不通过单股 pipeline 工作；这里返回一条信息性 'hold'
   * 信号，让 per-stock backtest engine 不至于崩溃，但调用方应当走
   * generateSignals(date) 来获得真正的调仓信号。
   */
  evaluate(context: QuantStockContext, _options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const latestClose = context.bars?.length ? context.bars[context.bars.length - 1].close : 0;
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: 'hold',
      score: 0,
      confidence: 0,
      entry_price: latestClose,
      target_holding_days: this.definition.default_params.holdingDaysLimit,
      reasons: ['GameTraderRelay 是组合级策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-025 主入口。
   *
   * @param tradeDate ISO YYYY-MM-DD，当日交易日
   * @param options.params 覆盖 default_params 的部分字段
   * @param options.currentPositions 当前持仓（含 entry_date + entry_price）
   */
  async generateSignals(
    tradeDate: string,
    options: GameTraderRelayGenerateOptions = {}
  ): Promise<GameTraderRelaySignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    if (params.lookbackDays <= 0) {
      throw new Error(`generateSignals: lookbackDays must be > 0, got ${params.lookbackDays}`);
    }
    const currentPositions = options.currentPositions ?? [];

    // === Step A: Exit 流程（先处理出场；BUY 用的 slot 数 = maxPositions - 保留 HOLD 数）
    const exitResults = await this.evaluateExits(tradeDate, currentPositions, params);

    // === Step B: 入场流程 —— 累计 famous_yz 候选池 → 4 维 AND 过滤 → 排序 → cap
    const entryEvaluation = await this.evaluateEntries(
      tradeDate,
      params,
      new Set(exitResults.signals.filter(s => s.signal === 'hold').map(s => s.stock_code))
    );

    // === Step C: target_positions = HOLD（保留）+ 新 BUY，cap 在 maxPositions
    const kept: GameTraderRelayPosition[] = [];
    const sellMap = new Map(exitResults.signals.map(s => [s.stock_code, s]));
    for (const pos of currentPositions) {
      const sig = sellMap.get(pos.stock_code);
      if (!sig) {
        kept.push(pos);
        continue;
      }
      if (sig.signal === 'sell') continue;
      kept.push(pos);
    }

    const remainingSlots = Math.max(0, params.maxPositions - kept.length);
    const buyCandidates = entryEvaluation.candidates.slice(0, remainingSlots);

    const buySignals: GameTraderRelaySignal[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      name: c.meta.name ?? null,
      industry: c.meta.industry ?? null,
      signal: 'buy',
      reason: `游资接力 ${c.aggregate.relay_day_count} 日累计净买入${formatYi(
        c.aggregate.accumulated_net_buy
      )}亿 + 当日涨幅${(c.quote.change_pct * 100).toFixed(2)}% + 流通市值${formatYi(
        c.meta.circulating_market_cap ?? 0
      )}亿`,
      reference_price: c.quote.close,
      accumulated_net_buy: c.aggregate.accumulated_net_buy,
      relay_day_count: c.aggregate.relay_day_count,
      daily_change_pct: c.quote.change_pct,
      circulating_market_cap: c.meta.circulating_market_cap ?? undefined,
    }));

    const newPositions: GameTraderRelayPosition[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      entry_date: tradeDate,
      entry_price: c.quote.close,
      entry_accumulated_net_buy: c.aggregate.accumulated_net_buy,
    }));

    const targetPositions = [...kept, ...newPositions];
    const allSignals = [...exitResults.signals, ...buySignals];

    logger.info(
      `GameTraderRelay.generateSignals(${tradeDate}): ` +
        `candidate_pool=${entryEvaluation.filtered.candidate_pool_size} ` +
        `eligible=${entryEvaluation.candidates.length} ` +
        `held_kept=${kept.length} buy=${buySignals.length} ` +
        `sell=${allSignals.filter(s => s.signal === 'sell').length} ` +
        `hold=${allSignals.filter(s => s.signal === 'hold').length}`
    );

    return {
      trade_date: tradeDate,
      target_positions: targetPositions,
      signals: allSignals,
      filtered: entryEvaluation.filtered,
      params,
      eligible_count: entryEvaluation.candidates.length,
    };
  }

  // -------------------------------------------------------------------------
  // 内部步骤
  // -------------------------------------------------------------------------

  /** 入场候选过滤 + 排序，不做 cap（cap 在主流程里基于 remainingSlots 做） */
  private async evaluateEntries(
    tradeDate: string,
    params: GameTraderRelayParams,
    excludeStockCodes: Set<string>
  ): Promise<{
    candidates: Array<{
      stock_code: string;
      aggregate: GameTraderRelayAggregate;
      meta: GameTraderRelayStockMeta;
      quote: GameTraderRelayQuote;
    }>;
    filtered: GameTraderRelayFilteredStats;
  }> {
    const filtered: GameTraderRelayFilteredStats = {
      candidate_pool_size: 0,
      fail_net_buy_threshold: 0,
      fail_relay_days: 0,
      fail_daily_change: 0,
      fail_missing_quote: 0,
      fail_meta_missing: 0,
      fail_market_cap: 0,
      fail_st: 0,
    };

    // 1) 累计 famous_yz 净买入候选池
    const aggMap = await this.dataSource.loadFamousYzAggregates(tradeDate, params.lookbackDays);
    filtered.candidate_pool_size = aggMap.size;
    if (aggMap.size === 0) {
      return { candidates: [], filtered };
    }

    // 2) 阈值过滤：累计 > netBuyThreshold 且 relay_day_count >= 2
    //    (lookbackDays=2 时要求 2 天都有；lookbackDays>2 时仍要求 ≥ 2 天接力)
    const minRelayDays = Math.min(2, params.lookbackDays);
    const stage1: Array<{ stock_code: string; aggregate: GameTraderRelayAggregate }> = [];
    for (const [code, agg] of aggMap.entries()) {
      if (excludeStockCodes.has(code)) continue;
      if (agg.accumulated_net_buy <= params.netBuyThreshold) {
        filtered.fail_net_buy_threshold += 1;
        continue;
      }
      if (agg.relay_day_count < minRelayDays) {
        filtered.fail_relay_days += 1;
        continue;
      }
      stage1.push({ stock_code: code, aggregate: agg });
    }
    if (stage1.length === 0) {
      return { candidates: [], filtered };
    }

    // 3) 拉元数据 + 当日行情（合并请求）
    const stockCodes = stage1.map(r => r.stock_code);
    const [metaMap, quoteMap] = await Promise.all([
      this.dataSource.loadStockMeta(stockCodes),
      this.dataSource.loadDailyQuotes(tradeDate, stockCodes),
    ]);

    const candidates: Array<{
      stock_code: string;
      aggregate: GameTraderRelayAggregate;
      meta: GameTraderRelayStockMeta;
      quote: GameTraderRelayQuote;
    }> = [];

    for (const item of stage1) {
      const meta = metaMap.get(item.stock_code);
      if (!meta || meta.circulating_market_cap == null) {
        filtered.fail_meta_missing += 1;
        continue;
      }
      // ST 提前过滤（节省后续 quote 校验）
      if (params.excludeST && meta.name && isSTName(meta.name)) {
        filtered.fail_st += 1;
        continue;
      }
      const cap = meta.circulating_market_cap;
      if (cap < params.minCirculatingMarketCap || cap > params.maxCirculatingMarketCap) {
        filtered.fail_market_cap += 1;
        continue;
      }
      const quote = quoteMap.get(item.stock_code);
      if (!quote) {
        filtered.fail_missing_quote += 1;
        continue;
      }
      if (!Number.isFinite(quote.change_pct) || quote.change_pct <= params.minDailyChangePct) {
        filtered.fail_daily_change += 1;
        continue;
      }
      candidates.push({
        stock_code: item.stock_code,
        aggregate: item.aggregate,
        meta,
        quote,
      });
    }

    // 4) 排序：累计净买入降序 → 当日涨幅降序 → stock_code 稳定 tie-break
    candidates.sort((a, b) => {
      if (a.aggregate.accumulated_net_buy !== b.aggregate.accumulated_net_buy) {
        return b.aggregate.accumulated_net_buy - a.aggregate.accumulated_net_buy;
      }
      if (a.quote.change_pct !== b.quote.change_pct) {
        return b.quote.change_pct - a.quote.change_pct;
      }
      return a.stock_code.localeCompare(b.stock_code);
    });

    return { candidates, filtered };
  }

  /** Exit 流程：对每只 currentPositions 计算 signal */
  private async evaluateExits(
    tradeDate: string,
    currentPositions: GameTraderRelayPosition[],
    params: GameTraderRelayParams
  ): Promise<{ signals: GameTraderRelaySignal[] }> {
    if (currentPositions.length === 0) return { signals: [] };

    const codes = currentPositions.map(p => p.stock_code);
    const [quotes, todayNetBuy, metaMap] = await Promise.all([
      this.dataSource.loadDailyQuotes(tradeDate, codes),
      this.dataSource.loadFamousYzNetBuyToday(tradeDate, codes),
      this.dataSource.loadStockMeta(codes),
    ]);

    const signals: GameTraderRelaySignal[] = [];
    for (const pos of currentPositions) {
      const quote = quotes.get(pos.stock_code);
      const meta = metaMap.get(pos.stock_code);
      const holdingDays = naturalDaysBetween(pos.entry_date, tradeDate);

      // A. 持有 ≥ holdingDaysLimit → SELL（最高优先级）
      if (holdingDays >= params.holdingDaysLimit) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `持有 ${holdingDays} 自然日 ≥ holdingDaysLimit(${params.holdingDaysLimit})，强制平仓`,
          reference_price: quote?.close,
        });
        continue;
      }

      // 缺当日行情数据 → 安全起见 HOLD（next day 会重新评估）
      if (!quote) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'hold',
          reason: '当日缺行情数据，HOLD 等下一交易日',
        });
        continue;
      }

      // B. 个股止损：(close - entry) / entry ≤ stopLossPct
      const pnlPct = (quote.close - pos.entry_price) / pos.entry_price;
      if (Number.isFinite(pnlPct) && pnlPct <= params.stopLossPct) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `跌幅 ${(pnlPct * 100).toFixed(2)}% ≤ stopLossPct(${(
            params.stopLossPct * 100
          ).toFixed(2)}%)，止损`,
          reference_price: quote.close,
        });
        continue;
      }

      // C. 次日大跌：holdingDays >= 1 且 change_pct ≤ exitNextDayDropPct
      //    进场首日（holdingDays=0）不触发此判定（入场就是当日涨幅 > 5%，不能立刻"次日大跌"）
      if (
        holdingDays >= 1 &&
        Number.isFinite(quote.change_pct) &&
        quote.change_pct <= params.exitNextDayDropPct
      ) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `次日跌幅 ${(quote.change_pct * 100).toFixed(2)}% ≤ exitNextDayDropPct(${(
            params.exitNextDayDropPct * 100
          ).toFixed(2)}%)，SELL`,
          reference_price: quote.close,
        });
        continue;
      }

      // D. 次日游资席位消失：holdingDays >= 1 且当日 famous_yz 净买入 ≤ 0
      //    （接力中断 = 游资不再继续买入）
      if (holdingDays >= 1) {
        const netBuyToday = todayNetBuy.get(pos.stock_code);
        if (netBuyToday == null || netBuyToday <= 0) {
          signals.push({
            stock_code: pos.stock_code,
            name: meta?.name ?? null,
            industry: meta?.industry ?? null,
            signal: 'sell',
            reason: '次日游资席位消失（接力中断），SELL',
            reference_price: quote.close,
          });
          continue;
        }
      }

      // E. 都不触发 → HOLD
      signals.push({
        stock_code: pos.stock_code,
        name: meta?.name ?? null,
        industry: meta?.industry ?? null,
        signal: 'hold',
        reason: `继续持有（持有 ${holdingDays} 日，pnl=${(pnlPct * 100).toFixed(2)}%）`,
      });
    }

    return { signals };
  }

  /**
   * 合并 default_params + override。
   *
   * 全部标量参数，spread 合并安全（不踩 "spread merge 偷藏 default" 的坑）。
   */
  private resolveParams(override?: Partial<GameTraderRelayParams>): GameTraderRelayParams {
    const def = this.definition.default_params as Required<GameTraderRelayParams>;
    return {
      maxPositions: override?.maxPositions ?? def.maxPositions,
      lookbackDays: override?.lookbackDays ?? def.lookbackDays,
      netBuyThreshold: override?.netBuyThreshold ?? def.netBuyThreshold,
      minDailyChangePct: override?.minDailyChangePct ?? def.minDailyChangePct,
      minCirculatingMarketCap: override?.minCirculatingMarketCap ?? def.minCirculatingMarketCap,
      maxCirculatingMarketCap: override?.maxCirculatingMarketCap ?? def.maxCirculatingMarketCap,
      holdingDaysLimit: override?.holdingDaysLimit ?? def.holdingDaysLimit,
      exitNextDayDropPct: override?.exitNextDayDropPct ?? def.exitNextDayDropPct,
      stopLossPct: override?.stopLossPct ?? def.stopLossPct,
      excludeST: override?.excludeST ?? def.excludeST,
    };
  }
}

// ---------------------------------------------------------------------------
// 内部 helpers（仅本文件 + .test.ts 复用）
// ---------------------------------------------------------------------------

/** 自然日差（不算交易日，简单 ISO 日期相减）。entry=tradeDate 时返回 0 */
export function naturalDaysBetween(entryDate: string, tradeDate: string): number {
  const a = new Date(`${entryDate}T00:00:00Z`).getTime();
  const b = new Date(`${tradeDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const diff = (b - a) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff));
}

/** 元 → 亿 简化显示（reason 字符串用） */
function formatYi(amountInYuan: number): string {
  if (!Number.isFinite(amountInYuan)) return '0';
  return (amountInYuan / 1e8).toFixed(2);
}

function stripSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const i = symbol.indexOf('.');
  return i < 0 ? symbol : symbol.slice(0, i);
}

function guessStockSymbol(stockCode: string): string {
  if (!stockCode) return '';
  if (stockCode.includes('.')) return stockCode;
  const head = stockCode[0];
  if (head === '6') return `${stockCode}.SH`;
  if (head === '0' || head === '3') return `${stockCode}.SZ`;
  if (head === '4' || head === '8') return `${stockCode}.BJ`;
  return `${stockCode}.SZ`;
}

/**
 * ST 名称判定 — 重新导出自 `backend/src/utils/stNameUtils.ts`（US-025 抽取）。
 * 任何判定逻辑变更只改共享模块。
 */
export { isSTName };
