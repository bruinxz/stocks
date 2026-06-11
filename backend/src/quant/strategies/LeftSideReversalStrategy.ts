import { Op } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { StockMoneyFlowFactor } from '../../models/StockMoneyFlowFactor';
import { logger } from '../../utils/logger';
import { isSTName } from '../../utils/stNameUtils';

/**
 * LeftSideReversalStrategy — 左侧反转策略（US-026）
 *
 * 反转交易范式：抓"近 20 日大跌 + 当日强势反弹 + 主力资金回流 + RSI 触底上穿 +
 * 大盘子市值"的恐慌底接货机会。本质是"超跌反弹"短中线策略，借鉴技术信号
 * + 量化资金流双确认，避免单一信号失效。
 *
 * 与其他组合级策略对比：
 *   - vs BreakoutStrategy (US-023): 完全相反方向——Breakout 抓 60 日新高
 *     做趋势延续；本策略抓 20 日大跌做反转。Position schema 类似（都需
 *     entry_date/entry_price），但 sell_half 信号是本策略独有。
 *   - vs DragonHeadMomentumStrategy (US-012): 同样使用 sell_half 减半信号，
 *     但 DragonHead 是次日大幅高开减半（动量延续），本策略是 5 日内大幅
 *     反弹减半（落袋为安、防止反弹中继转为再次下跌）。
 *
 * 入场条件（AC 指定，5 维 AND）：
 *   1. 近 dropLookbackDays(20) 日跌幅 ≥ dropPctThreshold(30%)
 *      即 close[T] / close[T - dropLookbackDays] - 1 ≤ -0.30（用负号表达跌幅）
 *   2. 当日反弹 > minDailyReboundPct(5%)
 *      即 (close[T] - close[T-1]) / close[T-1] > 0.05
 *   3. 当日 main_net_inflow > 0  ← StockMoneyFlowFactor 表
 *   4. RSI(rsiPeriod=14) 从 < rsiThreshold(25) 区域上穿 ≥ rsiThreshold(25)
 *      即 yesterday rsi < 25 AND today rsi >= 25
 *   5. 流通市值 > minCirculatingMarketCap(50 亿)
 *   附加：非 ST/*ST（默认 excludeST=true）
 *
 * 出场条件（按优先级 A → C；最先命中即触发）：
 *   A. 持有 ≥ holdingDaysLimit (默认 15 自然日) → SELL  ← 硬时间限制
 *   B. (close - entry_price) / entry_price ≤ stopLossPct (默认 -0.07) → SELL  ← 硬损失限制
 *   C. (max(close[entry+1..T]) - entry_price) / entry_price > rapidGainPct (默认 0.15) AND !half_exited
 *      → SELL_HALF  ← 5 日内涨幅 > 15% 落袋为安
 *   D. 默认 HOLD
 *
 * 默认参数（AC 指定）：
 *   dropPctThreshold=0.30  dropLookbackDays=20  rsiThreshold=25  rsiPeriod=14
 *   minDailyReboundPct=0.05  minCirculatingMarketCap=50亿
 *   maxPositions=10  holdingDaysLimit=15  stopLossPct=-0.07
 *   rapidGainPct=0.15  rapidGainLookbackDays=5  excludeST=true
 */

export const DEFAULT_LEFT_SIDE_REVERSAL_PARAMS: Readonly<Required<LeftSideReversalParams>> =
  Object.freeze({
    dropPctThreshold: 0.3, // 近 20 日跌幅 ≥ 30%（正值表达"跌幅"）
    dropLookbackDays: 20,
    rsiThreshold: 25, // RSI 25 = 超卖区
    rsiPeriod: 14,
    minDailyReboundPct: 0.05, // 当日反弹 > 5%
    minCirculatingMarketCap: 50 * 1e8, // 流通市值 > 50 亿
    maxPositions: 10,
    holdingDaysLimit: 15, // 持有 15 自然日强制 SELL
    stopLossPct: -0.07, // 入场价跌破 7% 止损
    rapidGainPct: 0.15, // 5 日内涨幅 > 15% 减半
    rapidGainLookbackDays: 5,
    excludeST: true,
  });

export interface LeftSideReversalParams {
  /** 近 N 日跌幅阈值（正值；如 0.30 表示需 ≥ 30% 跌幅） */
  dropPctThreshold: number;
  /** 大跌回看交易日数（AC 默认 20） */
  dropLookbackDays: number;
  /** RSI 上穿阈值（AC 默认 25 = 超卖回升） */
  rsiThreshold: number;
  /** RSI 周期（AC 默认 14） */
  rsiPeriod: number;
  /** 当日最小反弹幅度（AC 默认 0.05 = 5%） */
  minDailyReboundPct: number;
  /** 流通市值下限（元；AC 默认 50 亿） */
  minCirculatingMarketCap: number;
  /** 最大同时持仓数（默认 10；反转策略持仓相对分散降低单股风险） */
  maxPositions: number;
  /** 持有 N 自然日强制 SELL（AC 默认 15） */
  holdingDaysLimit: number;
  /** 个股止损阈值（AC 默认 -0.07 = -7%） */
  stopLossPct: number;
  /** 快速涨幅减半阈值（AC 默认 0.15 = 15%） */
  rapidGainPct: number;
  /** 快速涨幅回看交易日数（AC 默认 5） */
  rapidGainLookbackDays: number;
  /** 是否剔除 ST / *ST */
  excludeST: boolean;
}

/** 单只持仓的结构化记录（exit 规则需要 entry_date / entry_price / half_exited） */
export interface LeftSideReversalPosition {
  stock_code: string;
  /** 进场日 ISO YYYY-MM-DD */
  entry_date: string;
  /** 进场价（用于止损与盈亏计算） */
  entry_price: number;
  /** 已减半标记 — 防止 5 日内涨幅触发多次减半 */
  half_exited?: boolean;
  /** 进场时所属行业（debug 用） */
  entry_industry?: string | null;
  /** 进场时已下跌幅度（debug 用 —— 复盘"是哪种深度的回调"） */
  entry_drop_pct?: number;
  /** 进场时 RSI（debug 用） */
  entry_rsi?: number;
}

export interface LeftSideReversalSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  /** sell_half = 减半信号；sell = 全平；buy = 新开仓；hold = 保留 */
  signal: 'buy' | 'sell' | 'sell_half' | 'hold';
  reason: string;
  reference_price?: number;
  /** 当日 close */
  close?: number;
  /** 当日反弹幅度 = (close - prev_close) / prev_close（BUY 时填） */
  rebound_pct?: number;
  /** 入场判定时 20 日跌幅 = close[T] / close[T - 20] - 1（BUY 时填） */
  drop_pct?: number;
  /** 当日 RSI（BUY 时填） */
  rsi?: number;
  /** 主力净流入（BUY 时填，单位元） */
  main_net_inflow?: number;
}

export interface LeftSideReversalFilteredStats {
  /** 当日有 ≥ N+1 bars 的候选总数 */
  candidate_pool_size: number;
  /** 已持仓不重复 BUY 剔除数 */
  fail_already_held: number;
  /** 历史 bar 数不足剔除数 */
  fail_insufficient_history: number;
  /** 当日 bar 不是 asOfDate（停牌 / 数据缺失）剔除数 */
  fail_stale_bar: number;
  /** 20 日跌幅不足（跌幅 < 30%）剔除数 */
  fail_drop_insufficient: number;
  /** 当日反弹不足（< 5%）剔除数 */
  fail_rebound_insufficient: number;
  /** RSI 未上穿（昨日已 ≥ 25 或今日 < 25）剔除数 */
  fail_rsi_not_crossing_up: number;
  /** 主力净流入 ≤ 0 或缺数据剔除数 */
  fail_money_flow_negative: number;
  /** 流通市值不足 50 亿剔除数 */
  fail_market_cap_insufficient: number;
  /** 缺 stock_meta 行 剔除数 */
  fail_meta_missing: number;
  /** ST 名称剔除数 */
  fail_st: number;
}

export interface LeftSideReversalSignalsResult {
  trade_date: string;
  target_positions: LeftSideReversalPosition[];
  signals: LeftSideReversalSignal[];
  filtered: LeftSideReversalFilteredStats;
  params: LeftSideReversalParams;
  /** 通过全部入场维度后的候选数（未受 maxPositions cap 前） */
  eligible_count: number;
}

export interface LeftSideReversalGenerateOptions {
  params?: Partial<LeftSideReversalParams>;
  currentPositions?: LeftSideReversalPosition[];
}

// ---------------------------------------------------------------------------
// DataSource 接口（便于测试用 fake 注入）
// ---------------------------------------------------------------------------

/**
 * 4 个 loader 方法 — 把所有 Sequelize 查询从策略主体抽离，便于单元测试 mock。
 *
 * 设计要点：
 *   - `loadCandidateBars` 全市场扫描。生产 minBarCount = max(dropLookbackDays,
 *     rsiPeriod) + 1（rsi 上穿判定需要昨天 + 今天，相当于多 1 bar）。
 *   - `loadPositionBars` 单独存在（持仓可能含已停牌/已退市股票），同时
 *     5 日涨幅出场判定需要 rapidGainLookbackDays 的 bar。
 *   - `loadMoneyFlowToday` 一次拉**当日**全市场 main_net_inflow Map，避免对
 *     每只 candidate 单独查 StockMoneyFlowFactor（StockMoneyFlowFactor 按
 *     symbol+factor_date 唯一，单日全市场 ~5000 行）。
 *   - `loadStockMeta` 同 Breakout / NorthboundFollow 形态 + 必带 circulating_market_cap
 *     用于市值过滤。
 */
export interface LeftSideReversalDataSource {
  /**
   * 一次性返回所有有近 minBarCount 个 bar 的股票最近 minBarCount 个 bar（升序）。
   * 缺 bar 不足的股票不出现在 Map 中。
   *
   * 注意：bars 的最后一条若不是 asOfDate 当日（例如停牌），策略层会标 fail_stale_bar。
   */
  loadCandidateBars(
    asOfDate: string,
    minBarCount: number
  ): Promise<Map<string, LeftSideReversalBarSnapshot>>;

  /**
   * 给定 stock_codes（currentPositions），返回每只股票最近 minBarCount 个 bar（升序）。
   * 缺数据的股票可不出现；exit 逻辑会安全 HOLD 等下一交易日。
   */
  loadPositionBars(
    asOfDate: string,
    stockCodes: string[],
    minBarCount: number
  ): Promise<Map<string, LeftSideReversalBarSnapshot>>;

  /**
   * 当日全市场 main_net_inflow 快照。
   * Map<stock_code, main_net_inflow>; 缺数据的股票不出现。
   *
   * 注意：返回的 stock_code 是无后缀格式（"600519" 而非 "600519.SH"）。
   */
  loadMoneyFlowToday(asOfDate: string): Promise<Map<string, number>>;

  /**
   * 给定 stock_codes 集合的元数据（name / industry / circulating_market_cap）。
   * 缺失的 stock_code 可不出现在返回 Map 中。
   */
  loadStockMeta(stockCodes: string[]): Promise<Map<string, LeftSideReversalStockMeta>>;
}

export interface LeftSideReversalBarSnapshot {
  /** Bars 按 date 升序；最后一条的 date 理想情况 = asOfDate */
  bars: LeftSideReversalBar[];
}

export interface LeftSideReversalBar {
  /** ISO YYYY-MM-DD */
  date: string;
  close: number;
}

export interface LeftSideReversalStockMeta {
  name?: string | null;
  industry?: string | null;
  /** 流通市值（元） */
  circulating_market_cap?: number | null;
}

// ---------------------------------------------------------------------------
// 生产 DataSource 实现
// ---------------------------------------------------------------------------

export class DefaultLeftSideReversalDataSource implements LeftSideReversalDataSource {
  async loadCandidateBars(
    asOfDate: string,
    minBarCount: number
  ): Promise<Map<string, LeftSideReversalBarSnapshot>> {
    if (minBarCount <= 0) return new Map();

    const stocks = (await Stock.findAll({
      attributes: ['id', 'symbol'],
      where: { is_listed: true },
      raw: true,
    })) as unknown as Array<{ id: number; symbol: string }>;
    if (!stocks.length) return new Map();

    const idToCode = new Map<number, string>();
    const stockIds: number[] = [];
    for (const s of stocks) {
      idToCode.set(s.id, stripSuffix(s.symbol));
      stockIds.push(s.id);
    }

    // 拉过去 minBarCount × 2 + 30 自然日范围内的 bars（覆盖周末/节假日）
    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - (minBarCount * 2 + 30));
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.gte]: `${startIso}T00:00:00Z`, [Op.lte]: `${asOfDate}T23:59:59Z` },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      close: number | string;
    }>;

    return groupBarsByStock(bars, idToCode, minBarCount);
  }

  async loadPositionBars(
    asOfDate: string,
    stockCodes: string[],
    minBarCount: number
  ): Promise<Map<string, LeftSideReversalBarSnapshot>> {
    if (!stockCodes.length || minBarCount <= 0) return new Map();
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

    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - (minBarCount * 2 + 30));
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.gte]: `${startIso}T00:00:00Z`, [Op.lte]: `${asOfDate}T23:59:59Z` },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      close: number | string;
    }>;

    return groupBarsByStock(bars, idToCode, minBarCount);
  }

  async loadMoneyFlowToday(asOfDate: string): Promise<Map<string, number>> {
    const rows = (await StockMoneyFlowFactor.findAll({
      attributes: ['symbol', 'main_net_inflow'],
      where: { factor_date: asOfDate },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      main_net_inflow: number | string | null;
    }>;
    const out = new Map<string, number>();
    for (const r of rows) {
      const v = r.main_net_inflow == null ? NaN : Number(r.main_net_inflow);
      if (!Number.isFinite(v)) continue;
      out.set(stripSuffix(r.symbol), v);
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, LeftSideReversalStockMeta>> {
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
    const out = new Map<string, LeftSideReversalStockMeta>();
    for (const r of rows) {
      const cap = r.circulating_market_cap == null ? null : Number(r.circulating_market_cap);
      out.set(stripSuffix(r.symbol), {
        name: r.name ?? null,
        industry: r.industry ? r.industry.trim() : null,
        circulating_market_cap: Number.isFinite(cap as number) ? (cap as number) : null,
      });
    }
    return out;
  }
}

const PRODUCTION_DATA_SOURCE: LeftSideReversalDataSource = new DefaultLeftSideReversalDataSource();

/**
 * 把 raw DailyBar rows 分组为 Map<stock_code, LeftSideReversalBarSnapshot>，保留最近 minBarCount 个。
 * 共享给 loadCandidateBars / loadPositionBars 避免代码重复。
 */
function groupBarsByStock(
  bars: Array<{ stock_id: number; time: Date | string; close: number | string }>,
  idToCode: Map<number, string>,
  minBarCount: number
): Map<string, LeftSideReversalBarSnapshot> {
  const byStock = new Map<number, LeftSideReversalBar[]>();
  for (const b of bars) {
    const close = Number(b.close);
    if (!Number.isFinite(close)) continue;
    const date =
      b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
    const arr = byStock.get(b.stock_id) ?? [];
    arr.push({ date, close });
    byStock.set(b.stock_id, arr);
  }

  const out = new Map<string, LeftSideReversalBarSnapshot>();
  for (const [stockId, arr] of byStock.entries()) {
    const code = idToCode.get(stockId);
    if (!code) continue;
    arr.sort((a, b) => a.date.localeCompare(b.date));
    if (arr.length < minBarCount) continue; // 数据不足 → 不进 Map
    out.set(code, { bars: arr.slice(-minBarCount) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 策略主体
// ---------------------------------------------------------------------------

export class LeftSideReversalStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'left_side_reversal',
    name: '左侧反转',
    description:
      '抓超跌反弹：扫描全市场，筛选近 20 日跌幅 ≥ 30% + 当日反弹 > 5% + ' +
      '主力净流入 > 0 + RSI(14) 从超卖区上穿 25 + 流通市值 > 50 亿的股票；' +
      '5 日内涨幅 > 15% 减半 / 跌破入场价 7% 止损 / 持有 15 日到期三条出场线。',
    category: 'multi_factor',
    default_params: { ...DEFAULT_LEFT_SIDE_REVERSAL_PARAMS },
    enabled: true,
    risk_level: 'high',
    tags: ['反转', '超跌', 'RSI', '资金流', '短中线'],
    style: 'mean_reversion',
    edge_hypothesis: {
      thesis:
        '左侧反转：20 日跌 ≥ 30% + 当日反弹 > 5% + RSI(14) 从 < 25 上穿 25 + 主力 main_net_inflow > 0 + 流通市值 > 50 亿，15 自然日 -7% 止损',
      category: 'mean_reversion',
      expected_edge_pct: 10.0,
      expected_holding_days: 15,
      key_factors: ['drop_pct_20d', 'rebound_pct_today', 'rsi_14', 'main_net_inflow'],
      evidence_link: 'Lo & MacKinlay 1990 mean reversion / De Bondt & Thaler 1985',
      failure_modes: [
        '退市风险股 (超跌但基本面恶化)',
        '小盘股流动性陷阱',
        '主跌段反弹 (反弹后继续下跌)',
      ],
      kill_switch_metric: 'win_rate_30d',
      kill_switch_threshold: 0.4,
    },
  };

  private readonly dataSource: LeftSideReversalDataSource;

  constructor(dataSource: LeftSideReversalDataSource = PRODUCTION_DATA_SOURCE) {
    super();
    this.dataSource = dataSource;
  }

  /**
   * 组合级策略不通过 per-stock pipeline 工作，evaluate 返回信息性 hold。
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
      reasons: ['LeftSideReversal 是组合级策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-026 主入口。
   */
  async generateSignals(
    tradeDate: string,
    options: LeftSideReversalGenerateOptions = {}
  ): Promise<LeftSideReversalSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    if (params.dropLookbackDays <= 0) {
      throw new Error(
        `generateSignals: dropLookbackDays must be > 0, got ${params.dropLookbackDays}`
      );
    }
    if (params.rsiPeriod <= 1) {
      throw new Error(`generateSignals: rsiPeriod must be > 1, got ${params.rsiPeriod}`);
    }
    if (params.rapidGainLookbackDays <= 0) {
      throw new Error(
        `generateSignals: rapidGainLookbackDays must be > 0, got ${params.rapidGainLookbackDays}`
      );
    }
    const currentPositions = options.currentPositions ?? [];

    // === Step 1: 入场流程并发拉数据
    // 需要 max(dropLookbackDays, rsiPeriod) + 1 bar 用于 entry 判定
    // dropLookback 需要 today + T-N（共 N+1 bar）
    // rsi 上穿需要 today + yesterday 两个 rsi（每个 rsi 需要 rsiPeriod+1 bars），所以共 rsiPeriod+2 bar
    const minBarsForEntry = Math.max(params.dropLookbackDays + 1, params.rsiPeriod + 2);
    const [candidateBars, moneyFlowMap] = await Promise.all([
      this.dataSource.loadCandidateBars(tradeDate, minBarsForEntry),
      this.dataSource.loadMoneyFlowToday(tradeDate),
    ]);

    // === Step 2: Exit 流程 — 需要 currentPositions 的 N 日 close（计算 max(close) 与当日 close）
    const exitResults = await this.evaluateExits(tradeDate, currentPositions, params);

    // === Step 3: 入场候选过滤（排除已持仓 — 不论 exit signal 类型）
    const heldCodes = new Set(currentPositions.map(p => p.stock_code));
    const entryEvaluation = await this.evaluateEntries(
      tradeDate,
      params,
      candidateBars,
      moneyFlowMap,
      heldCodes
    );

    // === Step 4: target_positions = HOLD/sell_half（保留，sell_half 标 half_exited）+ 新 BUY
    const kept: LeftSideReversalPosition[] = [];
    const sellMap = new Map(exitResults.signals.map(s => [s.stock_code, s]));
    for (const pos of currentPositions) {
      const sig = sellMap.get(pos.stock_code);
      if (!sig) {
        kept.push(pos);
        continue;
      }
      if (sig.signal === 'sell') continue; // 全平 → 不留
      if (sig.signal === 'sell_half') {
        // sell_half 后保留持仓但标 half_exited=true 防重复触发
        kept.push({ ...pos, half_exited: true });
        continue;
      }
      // hold
      kept.push(pos);
    }

    const remainingSlots = Math.max(0, params.maxPositions - kept.length);
    const buyCandidates = entryEvaluation.candidates.slice(0, remainingSlots);

    const buySignals: LeftSideReversalSignal[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      name: c.meta?.name ?? null,
      industry: c.meta?.industry ?? null,
      signal: 'buy',
      reason:
        `20 日跌幅 ${(c.drop_pct * 100).toFixed(2)}%（≥ ${(params.dropPctThreshold * 100).toFixed(
          2
        )}%）+ 当日反弹 ${(c.rebound_pct * 100).toFixed(2)}%（> ${(
          params.minDailyReboundPct * 100
        ).toFixed(2)}%）+ RSI ${c.rsi.toFixed(2)} 上穿 ${params.rsiThreshold} + ` +
        `主力净流入 ${c.main_net_inflow.toLocaleString()} 元 + ` +
        `流通市值 ${(c.circulating_market_cap / 1e8).toFixed(2)} 亿`,
      reference_price: c.today_close,
      close: c.today_close,
      rebound_pct: c.rebound_pct,
      drop_pct: c.drop_pct,
      rsi: c.rsi,
      main_net_inflow: c.main_net_inflow,
    }));

    const newPositions: LeftSideReversalPosition[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      entry_date: tradeDate,
      entry_price: c.today_close,
      half_exited: false,
      entry_industry: c.meta?.industry ?? null,
      entry_drop_pct: c.drop_pct,
      entry_rsi: c.rsi,
    }));

    const targetPositions = [...kept, ...newPositions];
    const allSignals = [...exitResults.signals, ...buySignals];

    logger.info(
      `LeftSideReversal.generateSignals(${tradeDate}): ` +
        `candidate_pool=${entryEvaluation.filtered.candidate_pool_size} ` +
        `eligible=${entryEvaluation.candidates.length} ` +
        `held_kept=${kept.length} buy=${buySignals.length} ` +
        `sell=${allSignals.filter(s => s.signal === 'sell').length} ` +
        `sell_half=${allSignals.filter(s => s.signal === 'sell_half').length} ` +
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

  private async evaluateEntries(
    tradeDate: string,
    params: LeftSideReversalParams,
    candidateBars: Map<string, LeftSideReversalBarSnapshot>,
    moneyFlowMap: Map<string, number>,
    excludeStockCodes: Set<string>
  ): Promise<{
    candidates: LeftSideReversalEntryCandidate[];
    filtered: LeftSideReversalFilteredStats;
  }> {
    const filtered: LeftSideReversalFilteredStats = {
      candidate_pool_size: candidateBars.size,
      fail_already_held: 0,
      fail_insufficient_history: 0,
      fail_stale_bar: 0,
      fail_drop_insufficient: 0,
      fail_rebound_insufficient: 0,
      fail_rsi_not_crossing_up: 0,
      fail_money_flow_negative: 0,
      fail_market_cap_insufficient: 0,
      fail_meta_missing: 0,
      fail_st: 0,
    };

    if (candidateBars.size === 0) {
      return { candidates: [], filtered };
    }

    // Stage 1: 价量过滤（最便宜 — 纯内存 + arithmetic）
    interface Stage1Item {
      stock_code: string;
      today_close: number;
      rebound_pct: number;
      drop_pct: number; // 负数（如 -0.32 表示跌 32%）
      rsi: number;
    }
    const stage1: Stage1Item[] = [];
    const minBarsRequired = Math.max(params.dropLookbackDays + 1, params.rsiPeriod + 2);

    for (const [code, snapshot] of candidateBars.entries()) {
      if (excludeStockCodes.has(code)) {
        filtered.fail_already_held += 1;
        continue;
      }
      const bars = snapshot.bars;
      if (bars.length < minBarsRequired) {
        filtered.fail_insufficient_history += 1;
        continue;
      }
      const lastBar = bars[bars.length - 1];
      if (lastBar.date !== tradeDate) {
        filtered.fail_stale_bar += 1;
        continue;
      }
      const todayClose = lastBar.close;
      if (!Number.isFinite(todayClose) || todayClose <= 0) {
        filtered.fail_stale_bar += 1;
        continue;
      }

      // 1) 20 日跌幅判定
      // close[T - dropLookbackDays] 即 bars[bars.length - 1 - dropLookbackDays]
      const dropAnchor = bars[bars.length - 1 - params.dropLookbackDays];
      if (!dropAnchor || !Number.isFinite(dropAnchor.close) || dropAnchor.close <= 0) {
        filtered.fail_insufficient_history += 1;
        continue;
      }
      const dropPct = todayClose / dropAnchor.close - 1;
      if (!Number.isFinite(dropPct) || dropPct > -params.dropPctThreshold) {
        // 注意：AC 是"近 20 日跌幅 ≥ 30%"，即 dropPct ≤ -0.30；用 > 表示"跌幅不足"
        filtered.fail_drop_insufficient += 1;
        continue;
      }

      // 2) 当日反弹判定
      const yesterdayBar = bars[bars.length - 2];
      if (!yesterdayBar || !Number.isFinite(yesterdayBar.close) || yesterdayBar.close <= 0) {
        filtered.fail_insufficient_history += 1;
        continue;
      }
      const reboundPct = (todayClose - yesterdayBar.close) / yesterdayBar.close;
      if (!Number.isFinite(reboundPct) || reboundPct <= params.minDailyReboundPct) {
        // 严格 > 阈值；恰等于阈值 = 不入选（边界噪音）
        filtered.fail_rebound_insufficient += 1;
        continue;
      }

      // 3) RSI 上穿判定（昨日 < threshold AND 今日 >= threshold）
      // 计算今日 RSI 需要最近 rsiPeriod+1 个 bar；计算昨日 RSI 需要最近 rsiPeriod+2 个 bar
      const closes = bars.map(b => b.close);
      const todayRsi = computeRSI(closes.slice(-(params.rsiPeriod + 1)), params.rsiPeriod);
      const yesterdayRsi = computeRSI(closes.slice(-(params.rsiPeriod + 2), -1), params.rsiPeriod);
      if (!Number.isFinite(todayRsi) || !Number.isFinite(yesterdayRsi)) {
        filtered.fail_rsi_not_crossing_up += 1;
        continue;
      }
      if (!(yesterdayRsi < params.rsiThreshold && todayRsi >= params.rsiThreshold)) {
        filtered.fail_rsi_not_crossing_up += 1;
        continue;
      }

      stage1.push({
        stock_code: code,
        today_close: todayClose,
        rebound_pct: reboundPct,
        drop_pct: dropPct,
        rsi: todayRsi,
      });
    }

    if (stage1.length === 0) {
      return { candidates: [], filtered };
    }

    // Stage 2: meta（name/industry/circulating_market_cap/ST）+ 主力资金流过滤
    const stockCodes = stage1.map(s => s.stock_code);
    const metaMap = await this.dataSource.loadStockMeta(stockCodes);

    const candidates: LeftSideReversalEntryCandidate[] = [];
    for (const item of stage1) {
      const meta = metaMap.get(item.stock_code);
      if (!meta) {
        filtered.fail_meta_missing += 1;
        continue;
      }
      if (params.excludeST && meta.name && isSTName(meta.name)) {
        filtered.fail_st += 1;
        continue;
      }
      const mcap = meta.circulating_market_cap;
      if (mcap == null || !Number.isFinite(mcap) || mcap <= params.minCirculatingMarketCap) {
        // 严格 > 阈值（AC："流通市值 > 50 亿"）
        filtered.fail_market_cap_insufficient += 1;
        continue;
      }
      const inflow = moneyFlowMap.get(item.stock_code);
      if (inflow == null || !Number.isFinite(inflow) || inflow <= 0) {
        filtered.fail_money_flow_negative += 1;
        continue;
      }
      candidates.push({
        stock_code: item.stock_code,
        today_close: item.today_close,
        rebound_pct: item.rebound_pct,
        drop_pct: item.drop_pct,
        rsi: item.rsi,
        main_net_inflow: inflow,
        circulating_market_cap: mcap,
        meta,
      });
    }

    // 排序：跌幅最深的优先（drop_pct 最负）+ 反弹最强 + stock_code 稳定 tie-break
    // 因 drop_pct 是负数，升序排列让"跌得最惨"的排前面（更经典的左侧反转标的）
    candidates.sort((a, b) => {
      if (a.drop_pct !== b.drop_pct) return a.drop_pct - b.drop_pct;
      if (a.rebound_pct !== b.rebound_pct) return b.rebound_pct - a.rebound_pct;
      return a.stock_code.localeCompare(b.stock_code);
    });

    return { candidates, filtered };
  }

  /** Exit 流程：对每只 currentPositions 计算 signal（按 A→C 优先级） */
  private async evaluateExits(
    tradeDate: string,
    currentPositions: LeftSideReversalPosition[],
    params: LeftSideReversalParams
  ): Promise<{ signals: LeftSideReversalSignal[] }> {
    if (currentPositions.length === 0) return { signals: [] };

    const codes = currentPositions.map(p => p.stock_code);
    // 取 rapidGainLookbackDays + 1 bar 计算 max(close[entry+1..T])
    // (rapidGainLookbackDays + 1 是 sliding window 的最大覆盖，足够看 5 日内涨幅)
    const minBars = params.rapidGainLookbackDays + 1;
    const [positionBars, metaMap] = await Promise.all([
      this.dataSource.loadPositionBars(tradeDate, codes, minBars),
      this.dataSource.loadStockMeta(codes),
    ]);

    const signals: LeftSideReversalSignal[] = [];
    for (const pos of currentPositions) {
      const meta = metaMap.get(pos.stock_code);
      const holdingDays = naturalDaysBetween(pos.entry_date, tradeDate);
      const snapshot = positionBars.get(pos.stock_code);
      const lastBar = snapshot?.bars[snapshot.bars.length - 1];

      // A. 持有 ≥ holdingDaysLimit → SELL（硬时间限制，最高优先级）
      if (holdingDays >= params.holdingDaysLimit) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `持有 ${holdingDays} 自然日 ≥ holdingDaysLimit(${params.holdingDaysLimit})，到期 SELL`,
          reference_price: lastBar?.close,
          close: lastBar?.close,
        });
        continue;
      }

      // 缺当日 close → 安全 HOLD（不能判定 stop_loss / rapid_gain）
      if (!lastBar || lastBar.date !== tradeDate || !Number.isFinite(lastBar.close)) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'hold',
          reason: '当日缺 close 数据，HOLD 等下一交易日',
          close: lastBar?.close,
        });
        continue;
      }

      const todayClose = lastBar.close;

      // B. 止损：(close - entry) / entry ≤ stopLossPct
      const pnlPct = (todayClose - pos.entry_price) / pos.entry_price;
      if (Number.isFinite(pnlPct) && pnlPct <= params.stopLossPct) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `跌幅 ${(pnlPct * 100).toFixed(2)}% ≤ stopLossPct(${(
            params.stopLossPct * 100
          ).toFixed(2)}%)，止损`,
          reference_price: todayClose,
          close: todayClose,
        });
        continue;
      }

      // C. 5 日内涨幅 > 15% → SELL_HALF（已减半的不重复触发）
      // 仅当持仓首日后（holdingDays >= 1）才生效；首日入场 max() 必然 = today_close
      // 含 today_close，因 today 可能就是触发减半的高点
      if (!pos.half_exited && holdingDays >= 1) {
        const recentBars = snapshot.bars.slice(-params.rapidGainLookbackDays);
        // 从 entry_date 之后的 bar 算 max close（含 today）
        // 因 holding 不一定 >= rapidGainLookbackDays，recentBars 已经是 min(snap.bars, lookback) 个
        // 但要排除 entry_date 之前的 bar（不应计入"5 日内涨幅"）
        // simplest semantics: max(close among bars whose date > entry_date)
        let maxClose = -Infinity;
        for (const b of recentBars) {
          if (b.date > pos.entry_date && Number.isFinite(b.close) && b.close > maxClose) {
            maxClose = b.close;
          }
        }
        if (Number.isFinite(maxClose)) {
          const peakGain = (maxClose - pos.entry_price) / pos.entry_price;
          if (peakGain > params.rapidGainPct) {
            signals.push({
              stock_code: pos.stock_code,
              name: meta?.name ?? null,
              industry: meta?.industry ?? null,
              signal: 'sell_half',
              reason: `${params.rapidGainLookbackDays} 日内最高涨幅 ${(peakGain * 100).toFixed(
                2
              )}% > rapidGainPct(${(params.rapidGainPct * 100).toFixed(2)}%)，减半落袋`,
              reference_price: todayClose,
              close: todayClose,
            });
            continue;
          }
        }
      }

      // D. 默认 HOLD
      signals.push({
        stock_code: pos.stock_code,
        name: meta?.name ?? null,
        industry: meta?.industry ?? null,
        signal: 'hold',
        reason: `继续持有（持有 ${holdingDays} 日，pnl=${(pnlPct * 100).toFixed(2)}%${
          pos.half_exited ? '，已减半' : ''
        }）`,
        close: todayClose,
      });
    }

    return { signals };
  }

  private resolveParams(override?: Partial<LeftSideReversalParams>): LeftSideReversalParams {
    const def = this.definition.default_params as Required<LeftSideReversalParams>;
    return {
      dropPctThreshold: override?.dropPctThreshold ?? def.dropPctThreshold,
      dropLookbackDays: override?.dropLookbackDays ?? def.dropLookbackDays,
      rsiThreshold: override?.rsiThreshold ?? def.rsiThreshold,
      rsiPeriod: override?.rsiPeriod ?? def.rsiPeriod,
      minDailyReboundPct: override?.minDailyReboundPct ?? def.minDailyReboundPct,
      minCirculatingMarketCap: override?.minCirculatingMarketCap ?? def.minCirculatingMarketCap,
      maxPositions: override?.maxPositions ?? def.maxPositions,
      holdingDaysLimit: override?.holdingDaysLimit ?? def.holdingDaysLimit,
      stopLossPct: override?.stopLossPct ?? def.stopLossPct,
      rapidGainPct: override?.rapidGainPct ?? def.rapidGainPct,
      rapidGainLookbackDays: override?.rapidGainLookbackDays ?? def.rapidGainLookbackDays,
      excludeST: override?.excludeST ?? def.excludeST,
    };
  }
}

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

interface LeftSideReversalEntryCandidate {
  stock_code: string;
  today_close: number;
  rebound_pct: number;
  /** 负数：如 -0.32 表示 20 日跌幅 32% */
  drop_pct: number;
  rsi: number;
  main_net_inflow: number;
  circulating_market_cap: number;
  meta?: LeftSideReversalStockMeta;
}

// ---------------------------------------------------------------------------
// 内部 helpers
// ---------------------------------------------------------------------------

/** 自然日差（不算交易日，简单 ISO 日期相减）。entry=tradeDate 时返回 0 */
export function naturalDaysBetween(entryDate: string, tradeDate: string): number {
  const a = new Date(`${entryDate}T00:00:00Z`).getTime();
  const b = new Date(`${tradeDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const diff = (b - a) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff));
}

/**
 * 经典 Wilder RSI 计算 — 给定 N+1 个 close 计算 N 期 RSI。
 *
 * 公式：
 *   delta[i] = close[i] - close[i-1]
 *   avg_gain = mean(max(delta, 0))（用 SMA — 简单均；测试便利）
 *   avg_loss = mean(max(-delta, 0))
 *   rs = avg_gain / avg_loss
 *   rsi = 100 - 100 / (1 + rs)
 *
 * 注：传统 Wilder 用指数平滑，简化版用 SMA。差异在窗口边缘但策略层
 * 不在乎绝对精度（"穿越阈值"是相对判断），SMA 让测试可手动复算。
 *
 * 返回 NaN 当 closes.length < period + 1 或 avg_loss = 0 且 avg_gain = 0
 * （RSI 数学上定义为 50 但策略层把它视为"无信号"更安全）。
 */
export function computeRSI(closes: number[], period: number): number {
  if (!Array.isArray(closes) || closes.length < period + 1 || period <= 0) return NaN;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gains += delta;
    else if (delta < 0) losses += -delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0 && avgGain === 0) return NaN;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * ST 名称判定 — 重新导出自 `backend/src/utils/stNameUtils.ts`（US-025 抽取）。
 * 任何判定逻辑变更只改共享模块。
 */
export { isSTName };

function stripSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const s = symbol.trim();
  if (!s) return '';
  const i = s.indexOf('.');
  if (i < 0) return s;
  const before = s.slice(0, i);
  const after = s.slice(i + 1);
  // 前缀格式 (sh./sz./bj.) — 2 字母 alpha + 数字
  if (/^[a-zA-Z]{2}$/.test(before)) return after;
  // 后缀格式 (.SH/.SZ/.BJ)
  return before;
}

function guessStockSymbol(stockCode: string): string {
  if (!stockCode) return '';
  if (stockCode.includes('.')) return stockCode;
  const head = stockCode[0];
  // stocks 表存的是 sh./sz./bj. 前缀格式
  if (head === '6') return `sh.${stockCode}`;
  if (head === '0' || head === '3') return `sz.${stockCode}`;
  if (head === '4' || head === '8' || head === '9') return `bj.${stockCode}`;
  return `sz.${stockCode}`;
}
