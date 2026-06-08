import { Op } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { EarningsForecast } from '../../models/EarningsForecast';
import { NorthboundHolding } from '../../models/NorthboundHolding';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { logger } from '../../utils/logger';
import { isSTName } from '../../utils/stNameUtils';

/**
 * EarningsSurpriseStrategy — 业绩预告超预期 + 北向加仓双确认（US-013）
 *
 * 事件驱动选股：在业绩预告公告日，筛选满足以下双确认的股票：
 *
 *   1. **业绩超预期**：forecast_type ∈ {预增, 扭亏, 续盈} 且
 *      profit_change_low ≥ 50（已在 EarningsForecastSyncService 中标定为
 *      `is_surprise = true`）。
 *   2. **北向加仓**：过去 lookbackDays（默认 5）个交易日北向持股比例
 *      累计上升（即 hold_ratio[as_of] > hold_ratio[as_of - N 日]）。
 *
 * 持仓与出场（每个交易日扫描已有持仓）：
 *   - A. 持有 ≥ holdingDaysLimit（默认 60 自然日）到期 → SELL 全部
 *   - B. (close - entry_price) / entry_price ≤ stopLossPct（默认 -10%）→ SELL 全部
 *   - C. 否则 HOLD
 *
 * 与 DragonHeadMomentumStrategy 的关键差异：
 *   - **事件触发，不每日产 BUY**：generateSignals(date) 当天没有新预告则
 *     不产生入场信号；只在 announce_date == tradeDate 的行触发。
 *   - **中线持仓 60 自然日**（vs DragonHead 3 自然日 / MultiFactor 月度）。
 *   - **入场前必须双确认**——业绩 + 北向资金，两者缺一不可。
 *
 * 与现有 QuantStrategy 基类的 evaluate() 兼容性：
 *   evaluate() 实现为信息性 hold。组合级策略不通过 per-stock pipeline 工作。
 *
 * 默认参数（AC 指定值）：
 *   maxPositions=20   holdingDaysLimit=60   stopLossPct=-0.10
 *   lookbackDays=5    minProfitChangeLow=50  excludeST=true
 */

export const DEFAULT_EARNINGS_SURPRISE_PARAMS: Readonly<Required<EarningsSurpriseParams>> =
  Object.freeze({
    maxPositions: 20,
    holdingDaysLimit: 60,
    stopLossPct: -0.1,
    lookbackDays: 5,
    minProfitChangeLow: 50,
    excludeST: true,
    surpriseForecastTypes: ['预增', '扭亏', '续盈'],
  });

export interface EarningsSurpriseParams {
  /** 最大同时持仓数（AC 默认 20） */
  maxPositions: number;
  /** 持有 N 自然日到期强制 SELL（AC 默认 60） */
  holdingDaysLimit: number;
  /** 个股止损阈值（AC 默认 -0.10 = -10%） */
  stopLossPct: number;
  /** 北向加仓 lookback 天数（AC 默认 5 个交易日） */
  lookbackDays: number;
  /** 入场最低 profit_change_low (%)（AC 默认 50） */
  minProfitChangeLow: number;
  /** 是否剔除 ST/*ST 命名（默认 true） */
  excludeST: boolean;
  /** 触发"超预期"的预告类型白名单（AC 指定: 预增/扭亏/续盈） */
  surpriseForecastTypes: string[];
}

/** 单只持仓的结构化记录（出场规则需要 entry_date / entry_price） */
export interface EarningsSurprisePosition {
  stock_code: string;
  /** 进场日 ISO YYYY-MM-DD */
  entry_date: string;
  /** 进场价（用于止损与盈亏计算） */
  entry_price: number;
  /** 进场时的报告期（debug 用） */
  entry_report_period?: string;
}

/** 单笔调仓信号 */
export interface EarningsSurpriseSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  signal: 'buy' | 'sell' | 'hold';
  reason: string;
  reference_price?: number;
  forecast_type?: string | null;
  profit_change_low?: number | null;
  profit_change_high?: number | null;
  northbound_ratio_delta?: number | null;
  report_period?: string | null;
}

/** 入场候选过滤维度统计 */
export interface EarningsSurpriseFilteredStats {
  /** 当日公告的预告条数（过滤前） */
  forecast_pool_size: number;
  /** 非超预期类型剔除数 */
  fail_forecast_type: number;
  /** profit_change_low 不足剔除数 */
  fail_profit_change: number;
  /** 北向数据缺失剔除数 */
  fail_northbound_missing: number;
  /** 北向未加仓剔除数 */
  fail_northbound_not_increased: number;
  /** ST 名称剔除数 */
  fail_st: number;
  /** 已持仓不重复 BUY 剔除数 */
  fail_already_held: number;
}

export interface EarningsSurpriseSignalsResult {
  trade_date: string;
  /** 调仓后目标持仓（含已持有保留 + 新进 BUY；不含 SELL 剔除项） */
  target_positions: EarningsSurprisePosition[];
  /** 增量信号（BUY/SELL/HOLD） */
  signals: EarningsSurpriseSignal[];
  /** 候选过滤维度统计 */
  filtered: EarningsSurpriseFilteredStats;
  /** 实际生效参数（合并 default + override 后） */
  params: EarningsSurpriseParams;
  /** 当日通过双确认的入场候选数（未受 maxPositions cap 前） */
  eligible_count: number;
}

export interface EarningsSurpriseGenerateOptions {
  params?: Partial<EarningsSurpriseParams>;
  /** 当前持仓；不传视为首次评估（无 exit 流程） */
  currentPositions?: EarningsSurprisePosition[];
}

// ---------------------------------------------------------------------------
// DataSource 接口（便于测试用 fake 注入）
// ---------------------------------------------------------------------------

/**
 * 4 个 loader 方法 — 把 Sequelize 查询从策略主体抽离，便于单元测试 mock。
 *
 * 生产环境用 DefaultEarningsSurpriseDataSource；单元测试传入 FakeDataSource。
 */
export interface EarningsSurpriseDataSource {
  /**
   * 当日公告的业绩预告全集（按 announce_date 精确匹配）。
   * 返回每条记录的 (stock_code, forecast_type, profit_change_low/high, report_period)。
   */
  loadAnnouncedForecasts(tradeDate: string): Promise<EarningsForecastRow[]>;

  /**
   * 给定 (asOfDate, lookbackDays, stockCodes) 计算每只股票"过去 N 个交易日
   * 北向持股比例的累计变化"。返回 Map<stock_code, delta>，delta > 0 表示
   * 加仓。缺数据的股票不出现在 Map 中。
   *
   * 注意：lookbackDays 是 **交易日数**，不是自然日；DataSource 内部要正确
   * 处理（北向数据本身就只在交易日有，按 trade_date 字段排序取最近 N+1 条
   * 即可）。
   */
  loadNorthboundRatioDelta(
    asOfDate: string,
    lookbackDays: number,
    stockCodes: string[]
  ): Promise<Map<string, number>>;

  /**
   * 给定 stock_codes 集合的元数据（name / industry）。
   * 缺失的 stock_code 可以不出现在返回 Map 中。
   */
  loadStockMeta(stockCodes: string[]): Promise<Map<string, EarningsSurpriseStockMeta>>;

  /**
   * 给定 (tradeDate, stockCodes) 当日 close 价格快照。
   * 用于止损判定；缺数据的股票可以不出现。
   */
  loadDailyClose(tradeDate: string, stockCodes: string[]): Promise<Map<string, number>>;
}

export interface EarningsForecastRow {
  stock_code: string;
  stock_name?: string | null;
  forecast_type: string | null;
  profit_change_low: number | null;
  profit_change_high: number | null;
  report_period: string;
}

export interface EarningsSurpriseStockMeta {
  name?: string | null;
  industry?: string | null;
}

// ---------------------------------------------------------------------------
// 生产 DataSource 实现
// ---------------------------------------------------------------------------

export class DefaultEarningsSurpriseDataSource implements EarningsSurpriseDataSource {
  async loadAnnouncedForecasts(tradeDate: string): Promise<EarningsForecastRow[]> {
    const rows = (await EarningsForecast.findAll({
      attributes: [
        'stock_code',
        'stock_name',
        'forecast_type',
        'profit_change_low',
        'profit_change_high',
        'report_period',
      ],
      where: { announce_date: tradeDate },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      stock_name: string | null;
      forecast_type: string | null;
      profit_change_low: number | string | null;
      profit_change_high: number | string | null;
      report_period: string;
    }>;
    return rows.map(r => ({
      stock_code: r.stock_code,
      stock_name: r.stock_name,
      forecast_type: r.forecast_type,
      profit_change_low:
        r.profit_change_low == null
          ? null
          : typeof r.profit_change_low === 'string'
          ? Number(r.profit_change_low)
          : r.profit_change_low,
      profit_change_high:
        r.profit_change_high == null
          ? null
          : typeof r.profit_change_high === 'string'
          ? Number(r.profit_change_high)
          : r.profit_change_high,
      report_period: r.report_period,
    }));
  }

  async loadNorthboundRatioDelta(
    asOfDate: string,
    lookbackDays: number,
    stockCodes: string[]
  ): Promise<Map<string, number>> {
    if (!stockCodes.length || lookbackDays <= 0) return new Map();

    // 拉过去 ~3 倍 lookbackDays 自然日范围内的所有北向行（覆盖周末/节假日 gap）
    // 然后按 stock_code 分组找最早 ≤ asOf 的"近 N+1 天"（按 trade_date 倒序排）
    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - lookbackDays * 3);
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const rows = (await NorthboundHolding.findAll({
      attributes: ['stock_code', 'trade_date', 'hold_ratio'],
      where: {
        stock_code: { [Op.in]: stockCodes },
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

    const out = new Map<string, number>();
    for (const [code, arr] of byCode.entries()) {
      arr.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
      // asOf 当日 ratio：最后一条
      const latest = arr[arr.length - 1];
      if (!latest) continue;
      // lookback 起点：往前数第 lookbackDays + 1 条（含当日 → 取 index = length - 1 - lookbackDays）
      const startIdx = arr.length - 1 - lookbackDays;
      if (startIdx < 0) continue; // 数据不足 N+1 天 → 跳过
      const base = arr[startIdx];
      out.set(code, latest.hold_ratio - base.hold_ratio);
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, EarningsSurpriseStockMeta>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));
    const rows = (await Stock.findAll({
      attributes: ['symbol', 'name', 'industry'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{ symbol: string; name: string; industry: string | null }>;
    const out = new Map<string, EarningsSurpriseStockMeta>();
    for (const r of rows) {
      const code = stripSuffix(r.symbol);
      out.set(code, { name: r.name ?? null, industry: r.industry ?? null });
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

    // 一次性查 [as_of - 5 天, as_of] 范围，按 stock_id 分组挑当日 bar
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
      // 优先精确匹配当日；缺则取最新（市场停牌兜底）
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

const PRODUCTION_DATA_SOURCE: EarningsSurpriseDataSource = new DefaultEarningsSurpriseDataSource();

// ---------------------------------------------------------------------------
// 策略主体
// ---------------------------------------------------------------------------

export class EarningsSurpriseStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'earnings_surprise',
    name: '业绩预告超预期 + 北向加仓双确认',
    description:
      '在业绩预告公告日筛选预增/扭亏/续盈且 profit_change_low ≥ 50% 的股票，' +
      '叠加近 5 日北向持股比例上升做双确认；持有 60 日或 -10% 止损出场。',
    category: 'multi_factor',
    default_params: { ...DEFAULT_EARNINGS_SURPRISE_PARAMS },
    enabled: true,
    risk_level: 'medium',
    tags: ['事件驱动', '业绩预告', '北向资金', '中线'],
    style: 'mid_cap_balanced',
  };

  private readonly dataSource: EarningsSurpriseDataSource;

  constructor(dataSource: EarningsSurpriseDataSource = PRODUCTION_DATA_SOURCE) {
    super();
    this.dataSource = dataSource;
  }

  /**
   * QuantStrategy 抽象基类要求的 per-stock evaluate()。
   *
   * 本策略是组合级 + 事件驱动，不通过单股 pipeline 工作；返回信息性 hold。
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
      reasons: ['EarningsSurprise 是组合级事件驱动策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-013 主入口。
   *
   * @param tradeDate ISO YYYY-MM-DD，当日交易日
   * @param options.params 覆盖 default_params 的部分字段
   * @param options.currentPositions 当前持仓
   */
  async generateSignals(
    tradeDate: string,
    options: EarningsSurpriseGenerateOptions = {}
  ): Promise<EarningsSurpriseSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    const currentPositions = options.currentPositions ?? [];

    // === Step A: Exit 流程（持仓 > 0 时先算出场，腾出 BUY 槽位）
    const exitResults = await this.evaluateExits(tradeDate, currentPositions, params);

    // === Step B: 入场流程 — 双确认筛选当日公告
    const heldCodes = new Set(
      exitResults.signals.filter(s => s.signal === 'hold').map(s => s.stock_code)
    );
    const entryEvaluation = await this.evaluateEntries(tradeDate, params, heldCodes);

    // === Step C: target_positions = HOLD（保留）+ 新 BUY（cap 在 maxPositions）
    const kept: EarningsSurprisePosition[] = [];
    const sellMap = new Map(exitResults.signals.map(s => [s.stock_code, s]));
    for (const pos of currentPositions) {
      const sig = sellMap.get(pos.stock_code);
      if (!sig) {
        // 不应发生，兜底保留
        kept.push(pos);
        continue;
      }
      if (sig.signal === 'sell') continue;
      // hold
      kept.push(pos);
    }

    const remainingSlots = Math.max(0, params.maxPositions - kept.length);
    const buyCandidates = entryEvaluation.candidates.slice(0, remainingSlots);

    const buySignals: EarningsSurpriseSignal[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      name: c.meta?.name ?? null,
      industry: c.meta?.industry ?? null,
      signal: 'buy',
      reason:
        `预告 ${
          c.forecast.forecast_type ?? ''
        } 净利同比下限 ${c.forecast.profit_change_low?.toFixed(2)}%, ` +
        `近 ${params.lookbackDays} 日北向持股比例 +${(c.northbound_delta * 100).toFixed(3)}pp`,
      reference_price: c.reference_price,
      forecast_type: c.forecast.forecast_type,
      profit_change_low: c.forecast.profit_change_low,
      profit_change_high: c.forecast.profit_change_high,
      northbound_ratio_delta: c.northbound_delta,
      report_period: c.forecast.report_period,
    }));

    const newPositions: EarningsSurprisePosition[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      entry_date: tradeDate,
      entry_price: c.reference_price,
      entry_report_period: c.forecast.report_period,
    }));

    const targetPositions = [...kept, ...newPositions];
    const allSignals = [...exitResults.signals, ...buySignals];

    logger.info(
      `EarningsSurprise.generateSignals(${tradeDate}): ` +
        `forecast_pool=${entryEvaluation.filtered.forecast_pool_size} ` +
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
    params: EarningsSurpriseParams,
    excludeStockCodes: Set<string>
  ): Promise<{
    candidates: Array<{
      stock_code: string;
      forecast: EarningsForecastRow;
      meta?: EarningsSurpriseStockMeta;
      northbound_delta: number;
      reference_price: number;
    }>;
    filtered: EarningsSurpriseFilteredStats;
  }> {
    const filtered: EarningsSurpriseFilteredStats = {
      forecast_pool_size: 0,
      fail_forecast_type: 0,
      fail_profit_change: 0,
      fail_northbound_missing: 0,
      fail_northbound_not_increased: 0,
      fail_st: 0,
      fail_already_held: 0,
    };

    // 1) 当日公告的预告池
    const forecasts = await this.dataSource.loadAnnouncedForecasts(tradeDate);
    filtered.forecast_pool_size = forecasts.length;
    if (forecasts.length === 0) {
      return { candidates: [], filtered };
    }

    // 2) 业绩超预期过滤（forecast_type + profit_change_low）
    const surpriseSet = new Set(params.surpriseForecastTypes);
    const stage1: EarningsForecastRow[] = [];
    for (const f of forecasts) {
      if (excludeStockCodes.has(f.stock_code)) {
        filtered.fail_already_held += 1;
        continue;
      }
      if (!f.forecast_type || !surpriseSet.has(f.forecast_type.trim())) {
        filtered.fail_forecast_type += 1;
        continue;
      }
      if (
        f.profit_change_low == null ||
        !Number.isFinite(f.profit_change_low) ||
        f.profit_change_low < params.minProfitChangeLow
      ) {
        filtered.fail_profit_change += 1;
        continue;
      }
      stage1.push(f);
    }
    if (stage1.length === 0) {
      return { candidates: [], filtered };
    }

    // 3) 北向加仓双确认（一次批量计算所有候选）
    const stockCodes = stage1.map(f => f.stock_code);
    const [northboundDeltas, metaMap, closeMap] = await Promise.all([
      this.dataSource.loadNorthboundRatioDelta(tradeDate, params.lookbackDays, stockCodes),
      this.dataSource.loadStockMeta(stockCodes),
      this.dataSource.loadDailyClose(tradeDate, stockCodes),
    ]);

    const candidates: Array<{
      stock_code: string;
      forecast: EarningsForecastRow;
      meta?: EarningsSurpriseStockMeta;
      northbound_delta: number;
      reference_price: number;
    }> = [];

    for (const f of stage1) {
      const meta = metaMap.get(f.stock_code);
      if (params.excludeST && meta?.name && isSTName(meta.name)) {
        filtered.fail_st += 1;
        continue;
      }
      const delta = northboundDeltas.get(f.stock_code);
      if (delta == null || !Number.isFinite(delta)) {
        filtered.fail_northbound_missing += 1;
        continue;
      }
      if (delta <= 0) {
        filtered.fail_northbound_not_increased += 1;
        continue;
      }
      const ref = closeMap.get(f.stock_code) ?? 0;
      candidates.push({
        stock_code: f.stock_code,
        forecast: f,
        meta,
        northbound_delta: delta,
        reference_price: ref,
      });
    }

    // 4) 排序：profit_change_low 降序 + northbound_delta 降序 + stock_code tie-break
    candidates.sort((a, b) => {
      const pa = a.forecast.profit_change_low ?? 0;
      const pb = b.forecast.profit_change_low ?? 0;
      if (pa !== pb) return pb - pa;
      if (a.northbound_delta !== b.northbound_delta) return b.northbound_delta - a.northbound_delta;
      return a.stock_code.localeCompare(b.stock_code);
    });

    return { candidates, filtered };
  }

  /** Exit 流程：对每只 currentPositions 计算 signal */
  private async evaluateExits(
    tradeDate: string,
    currentPositions: EarningsSurprisePosition[],
    params: EarningsSurpriseParams
  ): Promise<{ signals: EarningsSurpriseSignal[] }> {
    if (currentPositions.length === 0) return { signals: [] };

    const codes = currentPositions.map(p => p.stock_code);
    const [closeMap, metaMap] = await Promise.all([
      this.dataSource.loadDailyClose(tradeDate, codes),
      this.dataSource.loadStockMeta(codes),
    ]);

    const signals: EarningsSurpriseSignal[] = [];
    for (const pos of currentPositions) {
      const close = closeMap.get(pos.stock_code);
      const meta = metaMap.get(pos.stock_code);
      const holdingDays = naturalDaysBetween(pos.entry_date, tradeDate);

      // A. 持有 ≥ holdingDaysLimit → SELL（最高优先级）
      if (holdingDays >= params.holdingDaysLimit) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `持有 ${holdingDays} 自然日 ≥ holdingDaysLimit(${params.holdingDaysLimit})，到期 SELL`,
          reference_price: close,
        });
        continue;
      }

      // 缺当日 close → 安全起见 HOLD
      if (close == null || !Number.isFinite(close)) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'hold',
          reason: '当日缺 close 数据，HOLD 等下一交易日',
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
        });
        continue;
      }

      // C. 默认 HOLD
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
   * 合并 default_params + override。surpriseForecastTypes（数组类型参数）
   * 整体替换 default 而非 concat — 同 MultiFactorAlpha.weights 的"用户列出
   * 的就是全部"语义。
   */
  private resolveParams(override?: Partial<EarningsSurpriseParams>): EarningsSurpriseParams {
    const def = this.definition.default_params as Required<EarningsSurpriseParams>;
    const surpriseForecastTypes =
      override?.surpriseForecastTypes && override.surpriseForecastTypes.length > 0
        ? [...override.surpriseForecastTypes]
        : [...def.surpriseForecastTypes];
    return {
      maxPositions: override?.maxPositions ?? def.maxPositions,
      holdingDaysLimit: override?.holdingDaysLimit ?? def.holdingDaysLimit,
      stopLossPct: override?.stopLossPct ?? def.stopLossPct,
      lookbackDays: override?.lookbackDays ?? def.lookbackDays,
      minProfitChangeLow: override?.minProfitChangeLow ?? def.minProfitChangeLow,
      excludeST: override?.excludeST ?? def.excludeST,
      surpriseForecastTypes,
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
 * ST 名称判定 — 重新导出自 `backend/src/utils/stNameUtils.ts`（US-025 抽取）。
 * 任何判定逻辑变更只改共享模块。
 */
export { isSTName };

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
