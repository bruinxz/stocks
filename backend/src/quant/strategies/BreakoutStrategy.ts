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
import { IndustryFlow } from '../../models/IndustryFlow';
import { logger } from '../../utils/logger';
import { isSTName } from '../../utils/stNameUtils';

/**
 * BreakoutStrategy — 60 日新高突破策略（US-023）
 *
 * 抓主升浪初始段的趋势策略：扫描全市场，筛选当日突破 60 日新高 +
 * 成交额放大 1.5 倍以上 + 所属行业资金净流入为正 + 非 ST 的股票；
 * 已持仓中持续监测 跌破 20 日均线 / -15% 止损 / 持有 60 日到期 三条出场线。
 *
 * 入场条件（AC 指定，4 维 AND）：
 *   1. 当日 close > max(close[-newHighDays..-1])  — 突破 60 日新高（不含今日）
 *   2. 当日 turnover > avg(turnover[-5..-1]) × volumeMultiplier  — 成交额放大确认
 *   3. 所属行业当日 IndustryFlow.main_inflow > 0  — 行业资金面配合
 *   4. 非 ST / *ST
 *
 * 出场条件（按优先级 A → C；最先命中即触发）：
 *   A. 持有 ≥ holdingDaysLimit (默认 60 自然日) → SELL  ← 硬时间限制
 *   B. (close - entry_price) / entry_price ≤ stopLossPct (默认 -0.15) → SELL  ← 硬损失限制
 *   C. close < MA20（当日收盘价 < 最近 20 日收盘均价，含今日）→ SELL  ← 技术信号
 *   D. 默认 HOLD
 *
 * 与其他组合级策略对比：
 *   - vs NorthboundFollow (US-019): 同为"全市场每日扫描 + 结构化持仓"模式，
 *     差异在触发源（北向资金 vs 价量突破）和 exit 软信号（北向减仓 vs MA20 破位）。
 *   - vs DragonHead (US-012): 同为短-中线趋势策略，但 DragonHead 抓首板/二板
 *     梯队龙头（3 天极短线），Breakout 抓 60 日新高（10-60 天中线趋势），
 *     入场不需龙虎榜确认，止损也宽（-15% vs -7%），仓位空间更大（默认 10 vs 5）。
 *
 * 默认参数（AC 指定）：
 *   newHighDays=60     volumeMultiplier=1.5    maxPositions=10
 *   holdingDaysLimit=60   stopLossPct=-0.15    ma20Period=20
 *   excludeST=true
 */

export const DEFAULT_BREAKOUT_PARAMS: Readonly<Required<BreakoutParams>> = Object.freeze({
  newHighDays: 60,
  volumeMultiplier: 1.5,
  maxPositions: 10,
  holdingDaysLimit: 60,
  stopLossPct: -0.15,
  ma20Period: 20,
  excludeST: true,
});

export interface BreakoutParams {
  /** 新高 lookback 天数（AC 默认 60） */
  newHighDays: number;
  /** 成交额放大倍数（AC 默认 1.5，即当日 turnover > 5 日均 × 1.5） */
  volumeMultiplier: number;
  /** 最大同时持仓数（默认 10；趋势策略给较大持仓空间） */
  maxPositions: number;
  /** 持有 N 自然日强制 SELL（AC 默认 60） */
  holdingDaysLimit: number;
  /** 个股止损阈值（AC 默认 -0.15 = -15%；趋势策略给较宽止损） */
  stopLossPct: number;
  /** MA 出场周期（AC 默认 20 = 跌破 20 日均线 SELL） */
  ma20Period: number;
  /** 是否剔除 ST/*ST */
  excludeST: boolean;
}

/** 单只持仓的结构化记录（exit 规则需要 entry_date / entry_price） */
export interface BreakoutPosition {
  stock_code: string;
  /** 进场日 ISO YYYY-MM-DD */
  entry_date: string;
  /** 进场价（用于止损与盈亏计算） */
  entry_price: number;
  /** 进场时所属行业（debug 用 — 复盘"我是在哪个行业突破时进场的"） */
  entry_industry?: string | null;
  /** 进场时突破的 60 日新高价（debug 用） */
  entry_60d_high?: number;
}

export interface BreakoutSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  signal: 'buy' | 'sell' | 'hold';
  reason: string;
  reference_price?: number;
  /** 当日 close（BUY 时即新高价；exit 时为当日 close） */
  close?: number;
  /** 当日 turnover */
  turnover?: number;
  /** 当日 turnover / 5 日均 turnover 比值（BUY 时填） */
  volume_ratio?: number;
  /** 行业当日 main_inflow（BUY 时填，单位元） */
  industry_inflow?: number;
}

export interface BreakoutFilteredStats {
  /** 当日有 ≥ newHighDays+1 bars 的候选总数（loadCandidateBars 返回数） */
  candidate_pool_size: number;
  /** 已持仓不重复 BUY 剔除数 */
  fail_already_held: number;
  /** 历史 bar 数不足剔除数（< newHighDays + 1） */
  fail_insufficient_history: number;
  /** 当日 bar 不是 asOfDate（停牌 / 数据缺失）剔除数 */
  fail_stale_bar: number;
  /** 未突破 60 日新高剔除数 */
  fail_no_new_high: number;
  /** 成交额未放大 1.5x 剔除数 */
  fail_volume_insufficient: number;
  /** 行业资金净流入为负 / 缺数据剔除数 */
  fail_industry_flow_negative: number;
  /** 缺 stock_meta 行 / industry 字段空 剔除数 */
  fail_meta_missing: number;
  /** ST 名称剔除数 */
  fail_st: number;
}

export interface BreakoutSignalsResult {
  trade_date: string;
  target_positions: BreakoutPosition[];
  signals: BreakoutSignal[];
  filtered: BreakoutFilteredStats;
  params: BreakoutParams;
  /** 通过全部入场维度后的候选数（未受 maxPositions cap 前） */
  eligible_count: number;
}

export interface BreakoutGenerateOptions {
  params?: Partial<BreakoutParams>;
  currentPositions?: BreakoutPosition[];
}

// ---------------------------------------------------------------------------
// DataSource 接口（便于测试用 fake 注入）
// ---------------------------------------------------------------------------

/**
 * 4 个 loader 方法 — 把所有 Sequelize 查询从策略主体抽离，便于单元测试 mock。
 *
 * 设计要点：
 *   - `loadCandidateBars` 是**全市场扫描**（universe-wide）。生产环境 5000 股 ×
 *     61 bar = ~300K rows；可接受，因为本策略每日只跑一次。如未来要优化，
 *     可在数据层做 "今日 close ≥ rolling_max(close, 60) 子查询" 预过滤
 *     再返回精简候选集——不破坏本接口契约。
 *   - `loadPositionBars` 单独存在因 currentPositions 可能含已退市 / 已停牌
 *     股票，需独立查询不依赖 universe 集合；而且 position 数量远小于 universe，
 *     可直接 stock_id IN (...) 一次性拉。
 *   - `loadIndustryNetInflow` 一次拉当日**全行业** main_inflow Map，避免对
 *     每只 candidate 单独查 IndustryFlow（86 个行业 × 1 行 = 极小）。
 *   - `loadStockMeta` 与 NorthboundFollow / DragonHead 完全同形态：基础元数据。
 */
export interface BreakoutDataSource {
  /**
   * 一次性返回所有有近 minBarCount 个 bar 的股票最近 minBarCount 个 bar（升序）。
   * 缺 bar 不足的股票不出现在 Map 中。
   *
   * 注意：bars 的最后一条若不是 asOfDate 当日（例如停牌），策略层会标 fail_stale_bar。
   */
  loadCandidateBars(
    asOfDate: string,
    minBarCount: number
  ): Promise<Map<string, BreakoutBarSnapshot>>;

  /**
   * 给定 stock_codes（currentPositions），返回每只股票最近 minBarCount 个 bar（升序）。
   * 缺数据的股票可不出现；exit 逻辑会安全 HOLD 等下一交易日。
   */
  loadPositionBars(
    asOfDate: string,
    stockCodes: string[],
    minBarCount: number
  ): Promise<Map<string, BreakoutBarSnapshot>>;

  /**
   * 当日 IndustryFlow 全行业 main_inflow 快照。
   * Map<industry_name, main_inflow>; 缺数据的行业不出现。
   */
  loadIndustryNetInflow(asOfDate: string): Promise<Map<string, number>>;

  /**
   * 给定 stock_codes 集合的元数据（name / industry）。
   * 缺失的 stock_code 可不出现在返回 Map 中。
   */
  loadStockMeta(stockCodes: string[]): Promise<Map<string, BreakoutStockMeta>>;
}

export interface BreakoutBarSnapshot {
  /** Bars 按 date 升序；最后一条的 date 理想情况 = asOfDate */
  bars: BreakoutBar[];
}

export interface BreakoutBar {
  /** ISO YYYY-MM-DD */
  date: string;
  close: number;
  /** 成交额（元）；用于 volume 放大判定 */
  turnover: number;
}

export interface BreakoutStockMeta {
  name?: string | null;
  industry?: string | null;
}

// ---------------------------------------------------------------------------
// 生产 DataSource 实现
// ---------------------------------------------------------------------------

export class DefaultBreakoutDataSource implements BreakoutDataSource {
  async loadCandidateBars(
    asOfDate: string,
    minBarCount: number
  ): Promise<Map<string, BreakoutBarSnapshot>> {
    if (minBarCount <= 0) return new Map();

    // 拉全市场 stocks → 得 id ↔ code 映射
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
      attributes: ['stock_id', 'time', 'close', 'turnover'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.gte]: `${startIso}T00:00:00Z`, [Op.lte]: `${asOfDate}T23:59:59Z` },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      close: number | string;
      turnover: number | string | null;
    }>;

    return groupBarsByStock(bars, idToCode, minBarCount);
  }

  async loadPositionBars(
    asOfDate: string,
    stockCodes: string[],
    minBarCount: number
  ): Promise<Map<string, BreakoutBarSnapshot>> {
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
      attributes: ['stock_id', 'time', 'close', 'turnover'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.gte]: `${startIso}T00:00:00Z`, [Op.lte]: `${asOfDate}T23:59:59Z` },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      close: number | string;
      turnover: number | string | null;
    }>;

    return groupBarsByStock(bars, idToCode, minBarCount);
  }

  async loadIndustryNetInflow(asOfDate: string): Promise<Map<string, number>> {
    const rows = (await IndustryFlow.findAll({
      attributes: ['industry_name', 'main_inflow'],
      where: { trade_date: asOfDate },
      raw: true,
    })) as unknown as Array<{
      industry_name: string;
      main_inflow: number | string | null;
    }>;
    const out = new Map<string, number>();
    for (const r of rows) {
      const inflow = r.main_inflow == null ? NaN : Number(r.main_inflow);
      if (!Number.isFinite(inflow)) continue;
      out.set(r.industry_name.trim(), inflow);
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, BreakoutStockMeta>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));
    const rows = (await Stock.findAll({
      attributes: ['symbol', 'name', 'industry'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      name: string;
      industry: string | null;
    }>;
    const out = new Map<string, BreakoutStockMeta>();
    for (const r of rows) {
      out.set(stripSuffix(r.symbol), {
        name: r.name ?? null,
        industry: r.industry ? r.industry.trim() : null,
      });
    }
    return out;
  }
}

const PRODUCTION_DATA_SOURCE: BreakoutDataSource = new DefaultBreakoutDataSource();

/**
 * 把 raw DailyBar rows 分组为 Map<stock_code, BreakoutBarSnapshot>，保留最近 minBarCount 个。
 * 共享给 loadCandidateBars / loadPositionBars 避免代码重复。
 */
function groupBarsByStock(
  bars: Array<{
    stock_id: number;
    time: Date | string;
    close: number | string;
    turnover: number | string | null;
  }>,
  idToCode: Map<number, string>,
  minBarCount: number
): Map<string, BreakoutBarSnapshot> {
  const byStock = new Map<number, BreakoutBar[]>();
  for (const b of bars) {
    const close = Number(b.close);
    const turnover = b.turnover == null ? 0 : Number(b.turnover);
    if (!Number.isFinite(close)) continue;
    const date =
      b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
    const arr = byStock.get(b.stock_id) ?? [];
    arr.push({ date, close, turnover: Number.isFinite(turnover) ? turnover : 0 });
    byStock.set(b.stock_id, arr);
  }

  const out = new Map<string, BreakoutBarSnapshot>();
  for (const [stockId, arr] of byStock.entries()) {
    const code = idToCode.get(stockId);
    if (!code) continue;
    arr.sort((a, b) => a.date.localeCompare(b.date));
    if (arr.length < minBarCount) continue; // 数据不足 → 不进 Map
    // 仅保留最近 minBarCount 个 bar，节省内存
    out.set(code, { bars: arr.slice(-minBarCount) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 策略主体
// ---------------------------------------------------------------------------

export class BreakoutStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'breakout_strategy',
    name: '60 日新高突破',
    description:
      '抓主升浪初始段：扫描全市场，筛选当日突破 60 日新高 + 成交额放大 1.5 倍 + ' +
      '所属行业资金净流入为正 + 非 ST 的股票；跌破 20 日均线 / -15% 止损 / 持有 60 日到期三条出场线。',
    category: 'momentum',
    default_params: { ...DEFAULT_BREAKOUT_PARAMS },
    enabled: true,
    risk_level: 'medium',
    tags: ['趋势', '突破', '成交量', '中线'],
    style: 'momentum',
  };

  private readonly dataSource: BreakoutDataSource;

  constructor(dataSource: BreakoutDataSource = PRODUCTION_DATA_SOURCE) {
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
      reasons: ['Breakout 是组合级策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-023 主入口。
   */
  async generateSignals(
    tradeDate: string,
    options: BreakoutGenerateOptions = {}
  ): Promise<BreakoutSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    if (params.newHighDays <= 0) {
      throw new Error(`generateSignals: newHighDays must be > 0, got ${params.newHighDays}`);
    }
    if (params.ma20Period <= 1) {
      throw new Error(`generateSignals: ma20Period must be > 1, got ${params.ma20Period}`);
    }
    const currentPositions = options.currentPositions ?? [];

    // === Step 1: 入场流程并发拉数据
    // - candidateBars 需要 newHighDays + 1（突破判定）+ max(5, 1) buffer for volume
    //   实际拉 newHighDays + 1 即可（5 日 volume 也在最近 5 天里）
    // - industryFlow 全行业 Map，一次查
    const minBarsForEntry = params.newHighDays + 1;
    const [candidateBars, industryFlowMap] = await Promise.all([
      this.dataSource.loadCandidateBars(tradeDate, minBarsForEntry),
      this.dataSource.loadIndustryNetInflow(tradeDate),
    ]);

    // === Step 2: Exit 流程 — 需要 currentPositions 的 ma20 + 当日 close
    const exitResults = await this.evaluateExits(tradeDate, currentPositions, params);

    // === Step 3: 入场候选过滤
    const heldCodes = new Set(
      exitResults.signals.filter(s => s.signal === 'hold').map(s => s.stock_code)
    );
    const entryEvaluation = await this.evaluateEntries(
      tradeDate,
      params,
      candidateBars,
      industryFlowMap,
      heldCodes
    );

    // === Step 4: target_positions = HOLD（保留）+ 新 BUY（cap 在 maxPositions）
    const kept: BreakoutPosition[] = [];
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

    const buySignals: BreakoutSignal[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      name: c.meta?.name ?? null,
      industry: c.meta?.industry ?? null,
      signal: 'buy',
      reason:
        `突破 ${params.newHighDays} 日新高 ${c.prior_60d_high.toFixed(2)} → ${c.today_close.toFixed(
          2
        )}，` +
        `成交额放大 ${c.volume_ratio.toFixed(2)}x（≥ ${params.volumeMultiplier}），` +
        `行业 "${c.meta?.industry ?? '-'}" 主力净流入 ${c.industry_inflow.toLocaleString()} 元`,
      reference_price: c.today_close,
      close: c.today_close,
      turnover: c.today_turnover,
      volume_ratio: c.volume_ratio,
      industry_inflow: c.industry_inflow,
    }));

    const newPositions: BreakoutPosition[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      entry_date: tradeDate,
      entry_price: c.today_close,
      entry_industry: c.meta?.industry ?? null,
      entry_60d_high: c.prior_60d_high,
    }));

    const targetPositions = [...kept, ...newPositions];
    const allSignals = [...exitResults.signals, ...buySignals];

    logger.info(
      `Breakout.generateSignals(${tradeDate}): ` +
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

  private async evaluateEntries(
    tradeDate: string,
    params: BreakoutParams,
    candidateBars: Map<string, BreakoutBarSnapshot>,
    industryFlowMap: Map<string, number>,
    excludeStockCodes: Set<string>
  ): Promise<{
    candidates: BreakoutEntryCandidate[];
    filtered: BreakoutFilteredStats;
  }> {
    const filtered: BreakoutFilteredStats = {
      candidate_pool_size: candidateBars.size,
      fail_already_held: 0,
      fail_insufficient_history: 0,
      fail_stale_bar: 0,
      fail_no_new_high: 0,
      fail_volume_insufficient: 0,
      fail_industry_flow_negative: 0,
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
      today_turnover: number;
      prior_60d_high: number;
      volume_ratio: number;
    }
    const stage1: Stage1Item[] = [];
    const minBarsRequired = params.newHighDays + 1;

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
      const todayTurnover = lastBar.turnover;

      // priorBars = 不含今日的全部 bar；取最后 newHighDays 个算 60 日新高
      const priorBars = bars.slice(0, bars.length - 1);
      const priorWindow = priorBars.slice(-params.newHighDays);
      if (priorWindow.length < params.newHighDays) {
        // bars.length >= newHighDays+1 才进得来，理论不会触发；防御
        filtered.fail_insufficient_history += 1;
        continue;
      }

      // 突破 60 日新高判定：今日 close > 过去 60 个交易日中的最大 close
      let priorHigh = -Infinity;
      for (const b of priorWindow) {
        if (b.close > priorHigh) priorHigh = b.close;
      }
      if (!Number.isFinite(priorHigh) || todayClose <= priorHigh) {
        filtered.fail_no_new_high += 1;
        continue;
      }

      // 成交额放大判定：今日 turnover > 前 5 日均 turnover × multiplier
      // 注意：取 priorBars 的最后 5 天（不含今日），与"5 日均量"标准一致
      const prior5 = priorBars.slice(-5);
      if (prior5.length < 5) {
        filtered.fail_insufficient_history += 1;
        continue;
      }
      let sumTurnover = 0;
      let validCount = 0;
      for (const b of prior5) {
        if (Number.isFinite(b.turnover) && b.turnover > 0) {
          sumTurnover += b.turnover;
          validCount += 1;
        }
      }
      if (validCount < 5 || sumTurnover <= 0) {
        // 5 日内有停牌/零成交日 → 视为成交结构异常，剔除
        filtered.fail_volume_insufficient += 1;
        continue;
      }
      const avgPrior5Turnover = sumTurnover / validCount;
      const threshold = avgPrior5Turnover * params.volumeMultiplier;
      if (!(todayTurnover > threshold)) {
        filtered.fail_volume_insufficient += 1;
        continue;
      }

      stage1.push({
        stock_code: code,
        today_close: todayClose,
        today_turnover: todayTurnover,
        prior_60d_high: priorHigh,
        volume_ratio: todayTurnover / avgPrior5Turnover,
      });
    }

    if (stage1.length === 0) {
      return { candidates: [], filtered };
    }

    // Stage 2: meta（name/industry/ST）+ 行业资金面过滤
    const stockCodes = stage1.map(s => s.stock_code);
    const metaMap = await this.dataSource.loadStockMeta(stockCodes);

    const candidates: BreakoutEntryCandidate[] = [];
    for (const item of stage1) {
      const meta = metaMap.get(item.stock_code);
      if (!meta || !meta.industry) {
        filtered.fail_meta_missing += 1;
        continue;
      }
      if (params.excludeST && meta.name && isSTName(meta.name)) {
        filtered.fail_st += 1;
        continue;
      }
      const inflow = industryFlowMap.get(meta.industry.trim());
      if (inflow == null || !Number.isFinite(inflow) || inflow <= 0) {
        filtered.fail_industry_flow_negative += 1;
        continue;
      }
      candidates.push({
        stock_code: item.stock_code,
        today_close: item.today_close,
        today_turnover: item.today_turnover,
        prior_60d_high: item.prior_60d_high,
        volume_ratio: item.volume_ratio,
        industry_inflow: inflow,
        meta,
      });
    }

    // 排序：volume_ratio 降序（放量最猛的最优先）+ industry_inflow 降序 + stock_code 稳定 tie-break
    candidates.sort((a, b) => {
      if (a.volume_ratio !== b.volume_ratio) return b.volume_ratio - a.volume_ratio;
      if (a.industry_inflow !== b.industry_inflow) return b.industry_inflow - a.industry_inflow;
      return a.stock_code.localeCompare(b.stock_code);
    });

    return { candidates, filtered };
  }

  /** Exit 流程：对每只 currentPositions 计算 signal（按 A→B→C 优先级） */
  private async evaluateExits(
    tradeDate: string,
    currentPositions: BreakoutPosition[],
    params: BreakoutParams
  ): Promise<{ signals: BreakoutSignal[] }> {
    if (currentPositions.length === 0) return { signals: [] };

    const codes = currentPositions.map(p => p.stock_code);
    // 取 ma20Period 长度的 bars 算 ma20（含今日），所以拉 ma20Period 即可
    const [positionBars, metaMap] = await Promise.all([
      this.dataSource.loadPositionBars(tradeDate, codes, params.ma20Period),
      this.dataSource.loadStockMeta(codes),
    ]);

    const signals: BreakoutSignal[] = [];
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

      // 缺当日 close → 安全 HOLD（不能判定 stop_loss / ma20）
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

      // C. 跌破 MA20：close < ma20
      // ma20 = 最近 ma20Period 个 close 均价（含今日）
      const allBars = snapshot.bars;
      if (allBars.length < params.ma20Period) {
        // 历史不足，无法判 ma20 → 暂时 HOLD（不当出场信号）
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'hold',
          reason: `历史 bar 数 ${allBars.length} < ma20Period(${params.ma20Period})，HOLD 等数据足`,
          close: todayClose,
        });
        continue;
      }
      const ma20Window = allBars.slice(-params.ma20Period);
      let sumClose = 0;
      for (const b of ma20Window) sumClose += b.close;
      const ma20 = sumClose / ma20Window.length;
      if (todayClose < ma20) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `今日 close ${todayClose.toFixed(2)} < MA${params.ma20Period} ${ma20.toFixed(
            2
          )}，跌破均线 SELL`,
          reference_price: todayClose,
          close: todayClose,
        });
        continue;
      }

      // D. 默认 HOLD
      signals.push({
        stock_code: pos.stock_code,
        name: meta?.name ?? null,
        industry: meta?.industry ?? null,
        signal: 'hold',
        reason: `继续持有（持有 ${holdingDays} 日，pnl=${(pnlPct * 100).toFixed(2)}%，close > MA${
          params.ma20Period
        }）`,
        close: todayClose,
      });
    }

    return { signals };
  }

  private resolveParams(override?: Partial<BreakoutParams>): BreakoutParams {
    const def = this.definition.default_params as Required<BreakoutParams>;
    return {
      newHighDays: override?.newHighDays ?? def.newHighDays,
      volumeMultiplier: override?.volumeMultiplier ?? def.volumeMultiplier,
      maxPositions: override?.maxPositions ?? def.maxPositions,
      holdingDaysLimit: override?.holdingDaysLimit ?? def.holdingDaysLimit,
      stopLossPct: override?.stopLossPct ?? def.stopLossPct,
      ma20Period: override?.ma20Period ?? def.ma20Period,
      excludeST: override?.excludeST ?? def.excludeST,
    };
  }
}

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

interface BreakoutEntryCandidate {
  stock_code: string;
  today_close: number;
  today_turnover: number;
  prior_60d_high: number;
  volume_ratio: number;
  industry_inflow: number;
  meta?: BreakoutStockMeta;
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
