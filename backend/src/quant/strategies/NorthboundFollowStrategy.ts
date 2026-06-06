import { Op } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { NorthboundHolding } from '../../models/NorthboundHolding';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { logger } from '../../utils/logger';

/**
 * NorthboundFollowStrategy — 北向资金大幅加仓跟随策略（US-019）
 *
 * 跟随"聪明钱"中线策略：每个交易日扫描所有有北向持股的股票，筛选
 * 近 lookbackDays（默认 5）个交易日累计加仓的标的；在已持仓中，
 * 持续监测北向减仓 / 持有期到期 / 个股止损三条出场线。
 *
 * 入场条件（AC 指定）：
 *   1. 近 lookbackDays 个交易日北向持股比例累计上升 ≥ minIncreasePct (默认 +0.5%)
 *   2. 当前 hold_ratio > minCurrentRatio (默认 1%)  — 排除"刚开始建仓试盘"的微仓
 *   3. circulating_market_cap > minCirculatingMarketCap (默认 100 亿)
 *   4. 非 ST / *ST
 *
 * 出场条件（按优先级 A → C）：
 *   A. 持有 ≥ holdingDaysLimit (默认 30 自然日) → SELL
 *   B. (close - entry) / entry ≤ stopLossPct (默认 -8%) → SELL
 *   C. 近 lookbackDays 个交易日北向减仓 ≥ |exitRatioDecreasePct| (默认 -0.3%) → SELL
 *   D. 默认 HOLD
 *
 * 与 EarningsSurprise（事件驱动）的差异：
 *   - **每日扫描全市场**：北向数据每天都有，所以入场不依赖事件触发；
 *     `eligible_count = 0` 通常意味着市场全天北向情绪冷淡，不是数据缺失。
 *   - 出场加了一条"北向减仓"线 — 跟随策略的核心是与聪明钱方向一致，
 *     一旦北向掉头，应当及时退出。
 *
 * 与 DragonHeadMomentumStrategy（短线）的差异：
 *   - 中线 30 自然日 vs 短线 3 自然日。
 *   - 不监测炸板 / 高开减半（北向不是 1-3 板游资资金，没有这种节奏）。
 *
 * evaluate() 兼容性：组合级策略，evaluate 返回信息性 hold；真正入口是
 * generateSignals(date, options)。
 *
 * 默认参数（AC 指定）：
 *   lookbackDays=5       minIncreasePct=0.5     maxPositions=20
 *   minCurrentRatio=1.0  minCirculatingMarketCap=100亿
 *   holdingDaysLimit=30  stopLossPct=-0.08      exitRatioDecreasePct=-0.3
 *   excludeST=true
 */

export const DEFAULT_NORTHBOUND_FOLLOW_PARAMS: Readonly<Required<NorthboundFollowParams>> =
  Object.freeze({
    lookbackDays: 5,
    minIncreasePct: 0.5,
    maxPositions: 20,
    minCurrentRatio: 1.0,
    minCirculatingMarketCap: 100 * 1e8,
    holdingDaysLimit: 30,
    stopLossPct: -0.08,
    exitRatioDecreasePct: -0.3,
    excludeST: true,
  });

export interface NorthboundFollowParams {
  /** 北向 lookback 交易日数（AC 默认 5） */
  lookbackDays: number;
  /** 入场最低累计涨幅 (%)（AC 默认 0.5 = +0.5 个百分点） */
  minIncreasePct: number;
  /** 最大同时持仓数（AC 默认 20） */
  maxPositions: number;
  /** 当前最低 hold_ratio (%) — 排除微仓试探（默认 1.0） */
  minCurrentRatio: number;
  /** 流通市值下限 (元)（默认 100 亿 = 10e9） */
  minCirculatingMarketCap: number;
  /** 持有 N 自然日到期 SELL（AC 默认 30） */
  holdingDaysLimit: number;
  /** 个股止损阈值（AC 默认 -0.08 = -8%） */
  stopLossPct: number;
  /** 出场北向减仓阈值（AC 默认 -0.3 = -0.3 个百分点；负值代表减仓幅度） */
  exitRatioDecreasePct: number;
  /** 是否剔除 ST/*ST */
  excludeST: boolean;
}

/** 持仓记录（出场规则需要 entry_date / entry_price / entry_ratio） */
export interface NorthboundFollowPosition {
  stock_code: string;
  /** 进场日 ISO YYYY-MM-DD */
  entry_date: string;
  /** 进场价（用于止损与盈亏计算） */
  entry_price: number;
  /** 进场时的北向 hold_ratio（debug 用，便于复盘"北向已经追到多深"） */
  entry_ratio?: number;
}

export interface NorthboundFollowSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  signal: 'buy' | 'sell' | 'hold';
  reason: string;
  reference_price?: number;
  current_ratio?: number;
  ratio_delta?: number;
}

export interface NorthboundFollowFilteredStats {
  /** 当日有北向持股变化数据的候选总数（loadCandidateRatioDeltas 返回数） */
  candidate_pool_size: number;
  /** 已持仓不重复 BUY 剔除数 */
  fail_already_held: number;
  /** 北向 delta 不足剔除数 */
  fail_increase_insufficient: number;
  /** 当前 hold_ratio < minCurrentRatio 剔除数 */
  fail_current_ratio_low: number;
  /** 流通市值不足剔除数 */
  fail_market_cap_low: number;
  /** ST 名称剔除数 */
  fail_st: number;
  /** 缺元数据剔除数（无 Stock 行 / 流通市值字段为 null） */
  fail_meta_missing: number;
}

export interface NorthboundFollowSignalsResult {
  trade_date: string;
  /** 调仓后目标持仓 */
  target_positions: NorthboundFollowPosition[];
  /** 全部增量信号 */
  signals: NorthboundFollowSignal[];
  filtered: NorthboundFollowFilteredStats;
  params: NorthboundFollowParams;
  /** 通过全部入场维度后的候选数（未受 maxPositions cap 前） */
  eligible_count: number;
}

export interface NorthboundFollowGenerateOptions {
  params?: Partial<NorthboundFollowParams>;
  /** 当前持仓 */
  currentPositions?: NorthboundFollowPosition[];
}

// ---------------------------------------------------------------------------
// DataSource 接口（便于测试用 fake 注入）
// ---------------------------------------------------------------------------

/**
 * 3 个 loader 方法 — 把 Sequelize 查询从策略主体抽离，便于单元测试 mock。
 *
 * 关键差异点（vs EarningsSurprise）：
 *   - `loadCandidateRatioDeltas` 是**全市场扫描**，输出 Map<stock_code,
 *     {current_ratio, ratio_delta}>。EarningsSurprise 是"先拿 forecasts 缩小
 *     候选池再查北向"，本策略反过来——北向本身就是触发源。
 *   - `loadStockMeta` 多带回 circulating_market_cap，因 AC 有 100 亿门槛。
 *   - `loadDailyClose` 与 EarningsSurprise 完全同形态。
 */
export interface NorthboundFollowDataSource {
  /**
   * 一次性返回所有有近 lookbackDays+1 天北向数据的股票的
   * (current_ratio, ratio_delta) — current_ratio 是 asOfDate 当日的
   * hold_ratio，ratio_delta = current_ratio - hold_ratio[asOfDate - lookbackDays trading days]。
   *
   * 缺 lookbackDays+1 天数据的股票不出现在 Map 中（与 EarningsSurprise 同款约定）。
   */
  loadCandidateRatioDeltas(
    asOfDate: string,
    lookbackDays: number
  ): Promise<Map<string, NorthboundRatioSnapshot>>;

  /**
   * 给定 stock_codes 集合的元数据（name / industry / circulating_market_cap）。
   * 缺失的 stock_code 可以不出现在返回 Map 中。
   */
  loadStockMeta(stockCodes: string[]): Promise<Map<string, NorthboundFollowStockMeta>>;

  /**
   * 给定 (tradeDate, stockCodes) 当日 close 价格快照。
   * 用于止损判定 + BUY 入场参考价；缺数据的股票可以不出现。
   */
  loadDailyClose(tradeDate: string, stockCodes: string[]): Promise<Map<string, number>>;
}

export interface NorthboundRatioSnapshot {
  /** asOfDate 当日 hold_ratio (%) */
  current_ratio: number;
  /** current_ratio - hold_ratio[asOfDate - lookbackDays trading days]，单位 % */
  ratio_delta: number;
}

export interface NorthboundFollowStockMeta {
  name?: string | null;
  industry?: string | null;
  circulating_market_cap?: number | null;
}

// ---------------------------------------------------------------------------
// 生产 DataSource 实现
// ---------------------------------------------------------------------------

export class DefaultNorthboundFollowDataSource implements NorthboundFollowDataSource {
  async loadCandidateRatioDeltas(
    asOfDate: string,
    lookbackDays: number
  ): Promise<Map<string, NorthboundRatioSnapshot>> {
    if (lookbackDays <= 0) return new Map();

    // 拉过去 ~3 倍 lookbackDays 自然日范围内的所有北向行（覆盖周末/节假日 gap）；
    // EarningsSurprise 用的同样模式。
    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - lookbackDays * 3);
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const rows = (await NorthboundHolding.findAll({
      attributes: ['stock_code', 'trade_date', 'hold_ratio'],
      where: {
        trade_date: { [Op.gte]: startIso, [Op.lte]: asOfDate },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      trade_date: string;
      hold_ratio: number | string | null;
    }>;

    // 按 stock_code 分组 + 按 trade_date 升序
    const byCode = new Map<string, Array<{ trade_date: string; hold_ratio: number }>>();
    for (const r of rows) {
      const ratio = r.hold_ratio == null ? NaN : Number(r.hold_ratio);
      if (!Number.isFinite(ratio)) continue;
      const arr = byCode.get(r.stock_code) ?? [];
      arr.push({ trade_date: r.trade_date, hold_ratio: ratio });
      byCode.set(r.stock_code, arr);
    }

    const out = new Map<string, NorthboundRatioSnapshot>();
    for (const [code, arr] of byCode.entries()) {
      arr.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
      // asOf 当日 ratio：取最新一条（理想情况就是 asOfDate；若停牌缺当日则前一交易日）
      const latest = arr[arr.length - 1];
      if (!latest) continue;
      const startIdx = arr.length - 1 - lookbackDays;
      if (startIdx < 0) continue; // 数据不足 N+1 天 → 跳过（候选池中不出现）
      const base = arr[startIdx];
      out.set(code, {
        current_ratio: latest.hold_ratio,
        ratio_delta: latest.hold_ratio - base.hold_ratio,
      });
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, NorthboundFollowStockMeta>> {
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
    const out = new Map<string, NorthboundFollowStockMeta>();
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

  async loadDailyClose(tradeDate: string, stockCodes: string[]): Promise<Map<string, number>> {
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

    // 一次性查 [as_of - 5 天, as_of] 范围，按 stock_id 分组挑当日 bar（同 EarningsSurprise 的兜底逻辑）
    const lookbackStart = new Date(`${tradeDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 5);
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close'],
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
      close: number | string;
    }>;

    const byStockId = new Map<number, Array<{ timeIso: string; close: number }>>();
    for (const b of bars) {
      const close = Number(b.close);
      if (!Number.isFinite(close)) continue;
      const tIso =
        b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
      const arr = byStockId.get(b.stock_id) ?? [];
      arr.push({ timeIso: tIso, close });
      byStockId.set(b.stock_id, arr);
    }

    const out = new Map<string, number>();
    for (const [stockId, arr] of byStockId.entries()) {
      const code = idToCode.get(stockId);
      if (!code) continue;
      const today = arr.find(b => b.timeIso === tradeDate);
      if (today) {
        out.set(code, today.close);
        continue;
      }
      arr.sort((a, b) => a.timeIso.localeCompare(b.timeIso));
      if (arr.length) out.set(code, arr[arr.length - 1].close);
    }
    return out;
  }
}

const PRODUCTION_DATA_SOURCE: NorthboundFollowDataSource = new DefaultNorthboundFollowDataSource();

// ---------------------------------------------------------------------------
// 策略主体
// ---------------------------------------------------------------------------

export class NorthboundFollowStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'northbound_follow',
    name: '北向资金大幅加仓跟随',
    description:
      '每日扫描北向持股，筛选近 5 日累计加仓 ≥ 0.5% 且当前持股比例 > 1% 的大盘股' +
      '（市值 > 100 亿），跟随聪明钱建仓；持有 30 日 / -8% 止损 / 北向减仓 -0.3% 三条出场线。',
    category: 'multi_factor',
    default_params: { ...DEFAULT_NORTHBOUND_FOLLOW_PARAMS },
    enabled: true,
    risk_level: 'medium',
    tags: ['北向资金', '聪明钱', '中线', '跟随'],
  };

  private readonly dataSource: NorthboundFollowDataSource;

  constructor(dataSource: NorthboundFollowDataSource = PRODUCTION_DATA_SOURCE) {
    super();
    this.dataSource = dataSource;
  }

  /**
   * QuantStrategy 抽象基类要求的 per-stock evaluate()。
   *
   * 本策略是组合级，不通过单股 pipeline 工作；返回信息性 hold。
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
      reasons: ['NorthboundFollow 是组合级策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-019 主入口。
   *
   * @param tradeDate ISO YYYY-MM-DD，当日交易日
   * @param options.params 覆盖 default_params 的部分字段
   * @param options.currentPositions 当前持仓
   */
  async generateSignals(
    tradeDate: string,
    options: NorthboundFollowGenerateOptions = {}
  ): Promise<NorthboundFollowSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    const currentPositions = options.currentPositions ?? [];

    // === Step 1: 一次性拉全市场北向 ratio_delta（候选池 + 出场判定都用同份数据）
    const ratioSnapshots = await this.dataSource.loadCandidateRatioDeltas(
      tradeDate,
      params.lookbackDays
    );

    // === Step 2: Exit 流程 — 用 ratioSnapshots 判定北向是否减仓
    const exitResults = await this.evaluateExits(
      tradeDate,
      currentPositions,
      params,
      ratioSnapshots
    );

    // === Step 3: 入场流程 — 双确认筛选（北向加仓 + 大盘股 + 非 ST）
    const heldCodes = new Set(
      exitResults.signals.filter(s => s.signal === 'hold').map(s => s.stock_code)
    );
    const entryEvaluation = await this.evaluateEntries(
      tradeDate,
      params,
      ratioSnapshots,
      heldCodes
    );

    // === Step 4: target_positions = HOLD（保留）+ 新 BUY（cap 在 maxPositions）
    const kept: NorthboundFollowPosition[] = [];
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

    const buySignals: NorthboundFollowSignal[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      name: c.meta?.name ?? null,
      industry: c.meta?.industry ?? null,
      signal: 'buy',
      reason:
        `北向近 ${params.lookbackDays} 日累计加仓 +${c.snapshot.ratio_delta.toFixed(3)}pp，` +
        `当前持股比例 ${c.snapshot.current_ratio.toFixed(3)}%，` +
        `流通市值 ${(c.meta?.circulating_market_cap ?? 0).toLocaleString()} 元`,
      reference_price: c.reference_price,
      current_ratio: c.snapshot.current_ratio,
      ratio_delta: c.snapshot.ratio_delta,
    }));

    const newPositions: NorthboundFollowPosition[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      entry_date: tradeDate,
      entry_price: c.reference_price,
      entry_ratio: c.snapshot.current_ratio,
    }));

    const targetPositions = [...kept, ...newPositions];
    const allSignals = [...exitResults.signals, ...buySignals];

    logger.info(
      `NorthboundFollow.generateSignals(${tradeDate}): ` +
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

  /** 入场候选过滤 + 排序，不做 cap（cap 在主流程基于 remainingSlots 做） */
  private async evaluateEntries(
    tradeDate: string,
    params: NorthboundFollowParams,
    ratioSnapshots: Map<string, NorthboundRatioSnapshot>,
    excludeStockCodes: Set<string>
  ): Promise<{
    candidates: Array<{
      stock_code: string;
      snapshot: NorthboundRatioSnapshot;
      meta?: NorthboundFollowStockMeta;
      reference_price: number;
    }>;
    filtered: NorthboundFollowFilteredStats;
  }> {
    const filtered: NorthboundFollowFilteredStats = {
      candidate_pool_size: ratioSnapshots.size,
      fail_already_held: 0,
      fail_increase_insufficient: 0,
      fail_current_ratio_low: 0,
      fail_market_cap_low: 0,
      fail_st: 0,
      fail_meta_missing: 0,
    };

    if (ratioSnapshots.size === 0) {
      return { candidates: [], filtered };
    }

    // Stage 1: 北向 delta + current_ratio 阈值过滤（最便宜 — 纯内存）
    const stage1: Array<{ stock_code: string; snapshot: NorthboundRatioSnapshot }> = [];
    for (const [code, snap] of ratioSnapshots.entries()) {
      if (excludeStockCodes.has(code)) {
        filtered.fail_already_held += 1;
        continue;
      }
      if (snap.ratio_delta < params.minIncreasePct) {
        filtered.fail_increase_insufficient += 1;
        continue;
      }
      if (snap.current_ratio <= params.minCurrentRatio) {
        filtered.fail_current_ratio_low += 1;
        continue;
      }
      stage1.push({ stock_code: code, snapshot: snap });
    }
    if (stage1.length === 0) {
      return { candidates: [], filtered };
    }

    // Stage 2: 元数据过滤（市值 + ST），与 close 价并发拉取
    const stockCodes = stage1.map(s => s.stock_code);
    const [metaMap, closeMap] = await Promise.all([
      this.dataSource.loadStockMeta(stockCodes),
      this.dataSource.loadDailyClose(tradeDate, stockCodes),
    ]);

    const candidates: Array<{
      stock_code: string;
      snapshot: NorthboundRatioSnapshot;
      meta?: NorthboundFollowStockMeta;
      reference_price: number;
    }> = [];

    for (const item of stage1) {
      const meta = metaMap.get(item.stock_code);
      if (!meta || meta.circulating_market_cap == null) {
        filtered.fail_meta_missing += 1;
        continue;
      }
      if (meta.circulating_market_cap < params.minCirculatingMarketCap) {
        filtered.fail_market_cap_low += 1;
        continue;
      }
      if (params.excludeST && meta.name && isSTName(meta.name)) {
        filtered.fail_st += 1;
        continue;
      }
      const ref = closeMap.get(item.stock_code) ?? 0;
      candidates.push({
        stock_code: item.stock_code,
        snapshot: item.snapshot,
        meta,
        reference_price: ref,
      });
    }

    // 排序：北向 delta 降序（追得最猛的最先要）+ current_ratio 降序 + stock_code 稳定
    candidates.sort((a, b) => {
      if (a.snapshot.ratio_delta !== b.snapshot.ratio_delta) {
        return b.snapshot.ratio_delta - a.snapshot.ratio_delta;
      }
      if (a.snapshot.current_ratio !== b.snapshot.current_ratio) {
        return b.snapshot.current_ratio - a.snapshot.current_ratio;
      }
      return a.stock_code.localeCompare(b.stock_code);
    });

    return { candidates, filtered };
  }

  /** Exit 流程：对每只 currentPositions 计算 signal */
  private async evaluateExits(
    tradeDate: string,
    currentPositions: NorthboundFollowPosition[],
    params: NorthboundFollowParams,
    ratioSnapshots: Map<string, NorthboundRatioSnapshot>
  ): Promise<{ signals: NorthboundFollowSignal[] }> {
    if (currentPositions.length === 0) return { signals: [] };

    const codes = currentPositions.map(p => p.stock_code);
    const [closeMap, metaMap] = await Promise.all([
      this.dataSource.loadDailyClose(tradeDate, codes),
      this.dataSource.loadStockMeta(codes),
    ]);

    const signals: NorthboundFollowSignal[] = [];
    for (const pos of currentPositions) {
      const close = closeMap.get(pos.stock_code);
      const meta = metaMap.get(pos.stock_code);
      const snap = ratioSnapshots.get(pos.stock_code);
      const holdingDays = naturalDaysBetween(pos.entry_date, tradeDate);

      // A. 持有 ≥ holdingDaysLimit → SELL（最高优先级，即使北向还在加仓也认到期）
      if (holdingDays >= params.holdingDaysLimit) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `持有 ${holdingDays} 自然日 ≥ holdingDaysLimit(${params.holdingDaysLimit})，到期 SELL`,
          reference_price: close,
          current_ratio: snap?.current_ratio,
          ratio_delta: snap?.ratio_delta,
        });
        continue;
      }

      // 缺当日 close → 安全 HOLD
      if (close == null || !Number.isFinite(close)) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'hold',
          reason: '当日缺 close 数据，HOLD 等下一交易日',
          current_ratio: snap?.current_ratio,
          ratio_delta: snap?.ratio_delta,
        });
        continue;
      }

      // B. 止损：(close - entry) / entry ≤ stopLossPct
      const pnlPct = (close - pos.entry_price) / pos.entry_price;
      if (Number.isFinite(pnlPct) && pnlPct <= params.stopLossPct) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `跌幅 ${(pnlPct * 100).toFixed(2)}% ≤ stopLossPct(${(
            params.stopLossPct * 100
          ).toFixed(2)}%)，止损`,
          reference_price: close,
          current_ratio: snap?.current_ratio,
          ratio_delta: snap?.ratio_delta,
        });
        continue;
      }

      // C. 北向减仓出场：近 lookbackDays 累计 delta ≤ exitRatioDecreasePct (默认 -0.3)
      if (
        snap &&
        Number.isFinite(snap.ratio_delta) &&
        snap.ratio_delta <= params.exitRatioDecreasePct
      ) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason:
            `北向近 ${params.lookbackDays} 日累计减仓 ${snap.ratio_delta.toFixed(3)}pp ` +
            `≤ exitRatioDecreasePct(${params.exitRatioDecreasePct}pp)，跟随减仓`,
          reference_price: close,
          current_ratio: snap.current_ratio,
          ratio_delta: snap.ratio_delta,
        });
        continue;
      }

      // D. 默认 HOLD
      signals.push({
        stock_code: pos.stock_code,
        name: meta?.name ?? null,
        industry: meta?.industry ?? null,
        signal: 'hold',
        reason: `继续持有（持有 ${holdingDays} 日，pnl=${(pnlPct * 100).toFixed(2)}%）`,
        reference_price: close,
        current_ratio: snap?.current_ratio,
        ratio_delta: snap?.ratio_delta,
      });
    }

    return { signals };
  }

  private resolveParams(override?: Partial<NorthboundFollowParams>): NorthboundFollowParams {
    const def = this.definition.default_params as Required<NorthboundFollowParams>;
    return {
      lookbackDays: override?.lookbackDays ?? def.lookbackDays,
      minIncreasePct: override?.minIncreasePct ?? def.minIncreasePct,
      maxPositions: override?.maxPositions ?? def.maxPositions,
      minCurrentRatio: override?.minCurrentRatio ?? def.minCurrentRatio,
      minCirculatingMarketCap: override?.minCirculatingMarketCap ?? def.minCirculatingMarketCap,
      holdingDaysLimit: override?.holdingDaysLimit ?? def.holdingDaysLimit,
      stopLossPct: override?.stopLossPct ?? def.stopLossPct,
      exitRatioDecreasePct: override?.exitRatioDecreasePct ?? def.exitRatioDecreasePct,
      excludeST: override?.excludeST ?? def.excludeST,
    };
  }
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
 * ST 名称判定（与 MultiFactorAlphaStrategy / EarningsSurpriseStrategy 的
 * isSTName 逻辑一致；这里单独实现避免跨策略文件相互依赖，便于测试隔离）。
 *
 * 注意：若 ST 判定规则变化，需要同步更新 4 处（这 3 个策略 +
 * AShareConstraintEngine.ts）。这个 trade-off 是为换取测试隔离与
 * 各策略独立演进的能力。
 */
export function isSTName(name?: string | null): boolean {
  if (!name) return false;
  const compact = name.replace(/\s+/g, '');
  if (!compact) return false;
  const upper = compact.toUpperCase();
  if (upper.startsWith('ST')) return true;
  if (upper.startsWith('*ST')) return true;
  if (upper.startsWith('S') && upper.indexOf('ST') >= 0 && upper.indexOf('ST') <= 3) {
    return true;
  }
  if (/^S[^A-Z0-9]/.test(upper)) return true;
  return false;
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
