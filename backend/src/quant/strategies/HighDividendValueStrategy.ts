import { Op } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { DividendHistory } from '../../models/DividendHistory';
import { StockValuationFactor } from '../../models/StockValuationFactor';
import { StockFundamentalFactor } from '../../models/StockFundamentalFactor';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { logger } from '../../utils/logger';
import { isSTName } from '../../utils/stNameUtils';

/**
 * HighDividendValueStrategy — 高分红低 PE 长线价值策略（US-022）
 *
 * 稳健型长线选股 + 季度调仓（每季度第一个交易日）：
 *
 * **入场 4 维 AND 过滤**：
 *   1. 近 lookbackYears(3) 年平均股息率 (yield_pct) ≥ minAvgDividendYield(4%)
 *      —— 数据源 DividendHistory.yield_pct（已在 sync 服务里基于 ex_date
 *      前日 close 计算）；3 年内 ex_date 计入。
 *   2. PE-TTM ≤ maxPE(15)
 *      —— 数据源 StockValuationFactor.pe_ttm 最新一条 ≤ asOfDate。
 *      过滤掉亏损股（pe_ttm <= 0）。
 *   3. ROE 5 年均值 ≥ minROE(10%)
 *      —— 数据源 StockFundamentalFactor.roe 近 5 年均值（同 QualityFactor 算法）。
 *      要求至少 2 个观测，避免单点噪音被当作长期。
 *   4. 总市值 > minTotalMarketCap(200 亿)
 *      —— 数据源 StockValuationFactor.total_market_cap 或 Stock.total_market_cap
 *      （前者优先，缺则后者）；过滤"大盘价值"风格。
 *
 * **排序**：股息率降序 → PE 升序 (越低越好) → stock_code 升序稳定 tie-break
 *
 * **持仓 cap = topN（默认 30）** —— 季度调仓 + ST 过滤 + maxPerIndustry（可选行业中性）
 *
 * **出场**：仅在调仓日（每季度第 1 个交易日）做 SELL/HOLD/BUY 差分；
 * 非调仓日返回 currentPositions 不变 + 空 signals 数组（季度调仓的本质）。
 *
 * **季度调仓判定**：tradeDate 是该季度第一个交易日（基于 DailyBar 拿全市场
 * 在 [quarterStart - 7d, quarterStart + 7d] 范围内的交易日，按 trade_date
 * 升序取第一个 ≥ quarterStart 的 ISO date）。这里 quarterStart = YYYY-(01|04|
 * 07|10)-01。调用方传非调仓日时返回 hold-only 结果不动持仓——避免每日重复
 * 跑相同筛选。
 *
 * 与 SectorRotationLeader (US-021) / NorthboundFollow (US-019) 的差异：
 *   - **长线 + 季度调仓**：不每日生成 signals，调用方应在每个季度第 1 个
 *     交易日才传调用本策略；其他日子返回 hold-only。
 *   - **不需要止损**：长线价值持有，AC 没指定 stopLossPct（与 EarningsSurprise
 *     的 -10% / DragonHead 的 -7% / NorthboundFollow 的 -8% 不同）；调仓日
 *     若入选条件失效（PE 涨穿 15 / 股息率掉到 4% 以下）则下季度自然换仓。
 *   - **previousSelection 用 string[]**（与 MultiFactorAlpha 一致）—— 季度调仓
 *     不需要 per-position state（entry_date / entry_price / half_exited 等）。
 *
 * 默认参数（AC 指定）：
 *   topN=30  lookbackYears=3  minAvgDividendYield=4  maxPE=15  minROE=10
 *   minTotalMarketCap=200亿  excludeST=true  industryNeutral=false
 *   maxPerIndustry=5  rebalancePeriod='quarterly'
 */

export const DEFAULT_HIGH_DIVIDEND_VALUE_PARAMS: Readonly<Required<HighDividendValueParams>> =
  Object.freeze({
    topN: 30,
    lookbackYears: 3,
    minAvgDividendYield: 4,
    maxPE: 15,
    minROE: 10,
    minTotalMarketCap: 200 * 1e8,
    excludeST: true,
    industryNeutral: false,
    maxPerIndustry: 5,
    rebalancePeriod: 'quarterly' as HighDividendValueRebalancePeriod,
  });

export type HighDividendValueRebalancePeriod = 'quarterly';

export interface HighDividendValueParams {
  /** 最大持仓数（AC 默认 30） */
  topN: number;
  /** 平均股息率回看年数（AC 默认 3） */
  lookbackYears: number;
  /** 最低平均股息率 % (AC 默认 4) */
  minAvgDividendYield: number;
  /** PE-TTM 上限（AC 默认 15） */
  maxPE: number;
  /** ROE 5 年均值下限 % (AC 默认 10) */
  minROE: number;
  /** 总市值下限 (元)（AC 默认 200 亿 = 200 * 10^8） */
  minTotalMarketCap: number;
  /** 是否剔除 ST/*ST */
  excludeST: boolean;
  /** 是否启用行业中性（每行业 ≤ maxPerIndustry） */
  industryNeutral: boolean;
  /** industryNeutral=true 时每行业最大持仓 */
  maxPerIndustry: number;
  /** 调仓频率（仅 quarterly；未来可能扩 'annual' / 'semi_annual'） */
  rebalancePeriod: HighDividendValueRebalancePeriod;
}

/** 单笔调仓信号 */
export interface HighDividendValueSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  signal: 'buy' | 'sell' | 'hold';
  reason: string;
  reference_price?: number;
  avg_dividend_yield_pct?: number;
  pe_ttm?: number;
  roe_5y_avg?: number;
  total_market_cap?: number;
}

/** 入场候选过滤维度统计 */
export interface HighDividendValueFilteredStats {
  /** 全市场总数（过滤前） */
  universe_size: number;
  /** 缺股息历史 / 平均股息率不足剔除数 */
  fail_dividend: number;
  /** PE-TTM 缺数据 / > maxPE 剔除数 */
  fail_pe: number;
  /** ROE 缺数据 / < minROE / 观测不足剔除数 */
  fail_roe: number;
  /** 总市值缺数据 / < minTotalMarketCap 剔除数 */
  fail_market_cap: number;
  /** ST 剔除数 */
  fail_st: number;
  /** 行业中性 cap 剔除数（industryNeutral=true 时） */
  fail_industry_cap: number;
}

export interface HighDividendValueSignalsResult {
  trade_date: string;
  /** 是否调仓日（季度第 1 个交易日）；非调仓日为 false，target/signals 保持原样 */
  is_rebalance_day: boolean;
  /** 调仓后目标持仓 stock_codes */
  target_portfolio: string[];
  /** 增量信号（BUY/SELL/HOLD）；非调仓日为空数组 */
  signals: HighDividendValueSignal[];
  /** 候选过滤维度统计；非调仓日为零值 */
  filtered: HighDividendValueFilteredStats;
  /** 实际生效参数（合并 default + override 后） */
  params: HighDividendValueParams;
  /** 入场候选数（未 cap 前 / 调仓日才有意义） */
  eligible_count: number;
}

export interface HighDividendValueGenerateOptions {
  params?: Partial<HighDividendValueParams>;
  /** 当前持仓 stock_codes；不传视为首次评估 */
  previousSelection?: string[];
  /** 强制按调仓日处理（测试用）；默认 false 走真正的日历判定 */
  forceRebalance?: boolean;
}

// ---------------------------------------------------------------------------
// DataSource 接口（便于测试用 fake 注入）
// ---------------------------------------------------------------------------

/**
 * 5 个 loader 方法 — 把 Sequelize 查询从策略主体抽离，便于单元测试 mock。
 *
 * 生产用 DefaultHighDividendValueDataSource；测试传 fake。
 */
export interface HighDividendValueDataSource {
  /**
   * 候选 universe：全 A 股（is_listed=true）按 6 位 stock_code 输出。
   * 与 NorthboundFollow 的"扫北向当 universe"不同，本策略是"扫全市场再
   * 4 维过滤"，所以 universe loader 独立返回全市场。
   */
  loadCandidateUniverse(asOfDate: string): Promise<string[]>;

  /**
   * 给定 (asOfDate, lookbackYears, stockCodes) 计算每只股票"近 N 年内
   * ex_date 的 yield_pct 均值"。返回 Map<stock_code, avg_yield_pct>。
   * yield_pct 缺数据（DividendHistory 未填）或 ex_date 区间内一次分红都没有
   * 的股票不出现在 Map 中。
   */
  loadAvgDividendYield(
    asOfDate: string,
    lookbackYears: number,
    stockCodes: string[]
  ): Promise<Map<string, number>>;

  /**
   * 给定 stockCodes 的最新 PE-TTM + 总市值。返回 Map<stock_code, {pe_ttm,
   * total_market_cap}>。任一字段缺则该字段为 null；两者都缺时 stock 可以
   * 不出现在 Map 中（节省 caller 判断）。
   */
  loadValuationSnapshot(
    asOfDate: string,
    stockCodes: string[]
  ): Promise<Map<string, HighDividendValuationSnap>>;

  /**
   * 给定 stockCodes 的 5 年 ROE 均值。返回 Map<stock_code, roe_5y_avg>。
   * 观测数 < 2 的股票不出现在 Map 中（避免单点噪音被当作长期）。
   */
  loadRoe5yAvg(asOfDate: string, stockCodes: string[]): Promise<Map<string, number>>;

  /**
   * 给定 stockCodes 的元数据（name / industry / fallback total_market_cap）。
   */
  loadStockMeta(stockCodes: string[]): Promise<Map<string, HighDividendValueStockMeta>>;

  /**
   * 给定 (tradeDate, stockCodes) 当日 close（作为 BUY 信号的 reference_price）。
   * 缺数据可以不出现。
   */
  loadDailyClose(tradeDate: string, stockCodes: string[]): Promise<Map<string, number>>;

  /**
   * 判断 tradeDate 是否本季度的第 1 个交易日。返回 true → 触发调仓。
   * 实现可以查 DailyBar 全市场的 trade_date 集合，找 [季度起始, +7d] 内最早一个。
   * Fake 实现可以直接基于 ISO 日期判断 + 节假日表。
   */
  isFirstTradingDayOfQuarter(tradeDate: string): Promise<boolean>;
}

export interface HighDividendValuationSnap {
  pe_ttm: number | null;
  total_market_cap: number | null;
}

export interface HighDividendValueStockMeta {
  name?: string | null;
  industry?: string | null;
  /** Stock 表的 total_market_cap，valuation snapshot 缺时的兜底 */
  total_market_cap?: number | null;
}

// ---------------------------------------------------------------------------
// 生产 DataSource 实现
// ---------------------------------------------------------------------------

export class DefaultHighDividendValueDataSource implements HighDividendValueDataSource {
  async loadCandidateUniverse(_asOfDate: string): Promise<string[]> {
    // 全 A 股 is_listed=true 的 stock_code
    const rows = (await Stock.findAll({
      attributes: ['symbol'],
      where: { is_listed: true },
      raw: true,
    })) as unknown as Array<{ symbol: string }>;
    const out: string[] = [];
    for (const r of rows) {
      const code = stripSuffix(r.symbol);
      if (/^\d{6}$/.test(code)) out.push(code);
    }
    return out;
  }

  async loadAvgDividendYield(
    asOfDate: string,
    lookbackYears: number,
    stockCodes: string[]
  ): Promise<Map<string, number>> {
    if (!stockCodes.length || lookbackYears <= 0) return new Map();

    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCFullYear(lookbackStart.getUTCFullYear() - lookbackYears);
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const rows = (await DividendHistory.findAll({
      attributes: ['stock_code', 'ex_date', 'yield_pct'],
      where: {
        stock_code: { [Op.in]: stockCodes },
        ex_date: { [Op.gte]: startIso, [Op.lte]: asOfDate },
        yield_pct: { [Op.ne]: null },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      ex_date: string;
      yield_pct: number | string | null;
    }>;

    // 按 stock_code 聚合：sum / count
    const agg = new Map<string, { sum: number; count: number }>();
    for (const r of rows) {
      const y = r.yield_pct == null ? NaN : Number(r.yield_pct);
      if (!Number.isFinite(y)) continue;
      const cur = agg.get(r.stock_code) ?? { sum: 0, count: 0 };
      cur.sum += y;
      cur.count += 1;
      agg.set(r.stock_code, cur);
    }

    const out = new Map<string, number>();
    for (const [code, { sum, count }] of agg.entries()) {
      if (count > 0) out.set(code, sum / count);
    }
    return out;
  }

  async loadValuationSnapshot(
    asOfDate: string,
    stockCodes: string[]
  ): Promise<Map<string, HighDividendValuationSnap>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));

    // 最近 90 天的最新一条（valuation 通常季度更新，60 天 buffer 足够）
    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 90);
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const rows = (await StockValuationFactor.findAll({
      attributes: ['symbol', 'factor_date', 'pe_ttm', 'total_market_cap'],
      where: {
        symbol: { [Op.in]: symbols },
        factor_date: { [Op.gte]: startIso, [Op.lte]: asOfDate },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      pe_ttm: number | string | null;
      total_market_cap: number | string | null;
    }>;

    // 每个 stock 取 factor_date 最新一条
    const latestDateBySymbol = new Map<string, string>();
    const latestValBySymbol = new Map<string, { pe: number | null; cap: number | null }>();
    for (const r of rows) {
      const cur = latestDateBySymbol.get(r.symbol);
      if (cur && cur >= r.factor_date) continue;
      latestDateBySymbol.set(r.symbol, r.factor_date);
      const pe = r.pe_ttm == null ? null : Number(r.pe_ttm);
      const cap = r.total_market_cap == null ? null : Number(r.total_market_cap);
      latestValBySymbol.set(r.symbol, {
        pe: Number.isFinite(pe as number) ? (pe as number) : null,
        cap: Number.isFinite(cap as number) ? (cap as number) : null,
      });
    }

    const out = new Map<string, HighDividendValuationSnap>();
    for (const [symbol, snap] of latestValBySymbol.entries()) {
      const code = stripSuffix(symbol);
      out.set(code, { pe_ttm: snap.pe, total_market_cap: snap.cap });
    }
    return out;
  }

  async loadRoe5yAvg(asOfDate: string, stockCodes: string[]): Promise<Map<string, number>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));

    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCFullYear(lookbackStart.getUTCFullYear() - 5);
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const rows = (await StockFundamentalFactor.findAll({
      attributes: ['symbol', 'factor_date', 'roe'],
      where: {
        symbol: { [Op.in]: symbols },
        factor_date: { [Op.gte]: startIso, [Op.lte]: asOfDate },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      roe: number | string | null;
    }>;

    const agg = new Map<string, { sum: number; count: number }>();
    for (const r of rows) {
      const v = r.roe == null ? NaN : Number(r.roe);
      if (!Number.isFinite(v)) continue;
      const cur = agg.get(r.symbol) ?? { sum: 0, count: 0 };
      cur.sum += v;
      cur.count += 1;
      agg.set(r.symbol, cur);
    }

    const out = new Map<string, number>();
    for (const [symbol, { sum, count }] of agg.entries()) {
      if (count < 2) continue; // 同 QualityFactor: 至少 2 个观测才算
      out.set(stripSuffix(symbol), sum / count);
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, HighDividendValueStockMeta>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));
    const rows = (await Stock.findAll({
      attributes: ['symbol', 'name', 'industry', 'total_market_cap'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      name: string;
      industry: string | null;
      total_market_cap: number | string | null;
    }>;
    const out = new Map<string, HighDividendValueStockMeta>();
    for (const r of rows) {
      const code = stripSuffix(r.symbol);
      const cap = r.total_market_cap == null ? null : Number(r.total_market_cap);
      out.set(code, {
        name: r.name ?? null,
        industry: r.industry ?? null,
        total_market_cap: Number.isFinite(cap as number) ? (cap as number) : null,
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

  async isFirstTradingDayOfQuarter(tradeDate: string): Promise<boolean> {
    // tradeDate ISO YYYY-MM-DD
    const d = new Date(`${tradeDate}T00:00:00Z`);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1; // 1..12
    // 当前季度起点（含）
    const quarterStartMonth = (Math.floor((month - 1) / 3) * 3 + 1) as 1 | 4 | 7 | 10;
    const quarterStartIso = `${year}-${String(quarterStartMonth).padStart(2, '0')}-01`;

    // 拿 [quarterStart, quarterStart + 7d] 全市场 DailyBar trade_date 集合
    const windowEnd = new Date(`${quarterStartIso}T00:00:00Z`);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 7);
    const windowEndIso = windowEnd.toISOString().slice(0, 10);

    const bars = (await DailyBar.findAll({
      attributes: ['time'],
      where: {
        time: {
          [Op.gte]: `${quarterStartIso}T00:00:00Z`,
          [Op.lte]: `${windowEndIso}T23:59:59Z`,
        },
      },
      raw: true,
      limit: 5000,
    })) as unknown as Array<{ time: Date | string }>;

    const dateSet = new Set<string>();
    for (const b of bars) {
      const tIso =
        b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
      if (tIso >= quarterStartIso) dateSet.add(tIso);
    }
    if (dateSet.size === 0) return false;
    const sorted = Array.from(dateSet).sort();
    return sorted[0] === tradeDate;
  }
}

const PRODUCTION_DATA_SOURCE: HighDividendValueDataSource =
  new DefaultHighDividendValueDataSource();

// ---------------------------------------------------------------------------
// 策略主体
// ---------------------------------------------------------------------------

export class HighDividendValueStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'high_dividend_value',
    name: '高分红低 PE 长线价值',
    description:
      '近 3 年平均股息率 ≥ 4% + PE-TTM ≤ 15 + ROE ≥ 10% + 总市值 > 200 亿 ' +
      '四维过滤选大盘价值股；季度调仓 top-N，长线稳健持有。',
    category: 'multi_factor',
    default_params: { ...DEFAULT_HIGH_DIVIDEND_VALUE_PARAMS },
    enabled: true,
    risk_level: 'low',
    tags: ['价值', '股息', '低 PE', '长线', '季度调仓'],
    style: 'high_yield_defensive',
    edge_hypothesis: {
      thesis:
        '高股息低 PE 长线价值：近 3 年股息率均值 ≥ 4% + PE ≤ 15 + 5 年 ROE 均值 ≥ 8% + 流通市值 ≥ 200 亿，季度调仓',
      category: 'structural',
      expected_edge_pct: 6.0,
      expected_holding_days: 90,
      key_factors: ['avg_dividend_yield_3y', 'pe_ttm', 'roe_5y_avg', 'circulating_market_cap'],
      failure_modes: [
        '高股息陷阱 (股价下跌导致股息率被动升高)',
        '蓝筹股估值切换 (2017→2018 蓝筹周期)',
        '加息周期股息股跑输成长股',
      ],
      kill_switch_metric: 'annual_return_pct',
      kill_switch_threshold: 3.0,
    },
  };

  private readonly dataSource: HighDividendValueDataSource;

  constructor(dataSource: HighDividendValueDataSource = PRODUCTION_DATA_SOURCE) {
    super();
    this.dataSource = dataSource;
  }

  /**
   * QuantStrategy 抽象基类要求的 per-stock evaluate()。
   *
   * 本策略是组合级 + 季度调仓，不通过单股 pipeline 工作；返回信息性 hold。
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
      target_holding_days: 90,
      reasons: [
        'HighDividendValue 是组合级季度调仓策略，请使用 generateSignals(date) 获得调仓信号',
      ],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-022 主入口。
   *
   * @param tradeDate ISO YYYY-MM-DD，当日交易日
   * @param options.params 覆盖 default_params 的部分字段
   * @param options.previousSelection 当前持仓 stock_codes
   * @param options.forceRebalance 强制按调仓日处理（测试用）
   */
  async generateSignals(
    tradeDate: string,
    options: HighDividendValueGenerateOptions = {}
  ): Promise<HighDividendValueSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    const previousSelection = options.previousSelection ?? [];

    // === Step A: 调仓日判定 ===
    const isRebalanceDay =
      options.forceRebalance === true
        ? true
        : await this.dataSource.isFirstTradingDayOfQuarter(tradeDate);
    if (!isRebalanceDay) {
      logger.info(
        `HighDividendValue.generateSignals(${tradeDate}): non-rebalance day, returning hold-only ` +
          `(positions kept=${previousSelection.length})`
      );
      return {
        trade_date: tradeDate,
        is_rebalance_day: false,
        target_portfolio: [...previousSelection],
        signals: [],
        filtered: emptyFilteredStats(),
        params,
        eligible_count: 0,
      };
    }

    // === Step B: 入场候选筛选（4 维 AND）===
    const evaluation = await this.evaluateCandidates(tradeDate, params);

    // === Step C: target = top topN 候选 (依 sort 顺序)；含行业中性 cap ===
    const targetCandidates = this.applyTopNAndIndustryCap(evaluation.eligible, params);
    const targetCodes = targetCandidates.map(c => c.stock_code);
    const targetSet = new Set(targetCodes);
    const prevSet = new Set(previousSelection);

    // === Step D: BUY/SELL/HOLD diff ===
    const signals: HighDividendValueSignal[] = [];

    // SELL = previous ∩ ¬target
    for (const code of previousSelection) {
      if (!targetSet.has(code)) {
        signals.push({
          stock_code: code,
          signal: 'sell',
          reason: '调仓：本季度未入选 top N，剔除',
        });
      }
    }

    // HOLD = previous ∩ target
    for (const c of targetCandidates) {
      if (prevSet.has(c.stock_code)) {
        signals.push({
          stock_code: c.stock_code,
          name: c.meta?.name ?? null,
          industry: c.meta?.industry ?? null,
          signal: 'hold',
          reason: '调仓：保留持仓',
          avg_dividend_yield_pct: c.avg_dividend_yield,
          pe_ttm: c.pe_ttm,
          roe_5y_avg: c.roe_5y_avg,
          total_market_cap: c.total_market_cap,
        });
      }
    }

    // BUY = target ∩ ¬previous
    for (const c of targetCandidates) {
      if (prevSet.has(c.stock_code)) continue;
      signals.push({
        stock_code: c.stock_code,
        name: c.meta?.name ?? null,
        industry: c.meta?.industry ?? null,
        signal: 'buy',
        reason:
          `近 ${params.lookbackYears}y avg yield=${c.avg_dividend_yield.toFixed(2)}%, ` +
          `PE-TTM=${c.pe_ttm.toFixed(2)}, ROE 5y avg=${c.roe_5y_avg.toFixed(2)}%, ` +
          `total_mcap=${(c.total_market_cap / 1e8).toFixed(0)}亿`,
        reference_price: c.reference_price,
        avg_dividend_yield_pct: c.avg_dividend_yield,
        pe_ttm: c.pe_ttm,
        roe_5y_avg: c.roe_5y_avg,
        total_market_cap: c.total_market_cap,
      });
    }

    logger.info(
      `HighDividendValue.generateSignals(${tradeDate}): rebalance ` +
        `universe=${evaluation.filtered.universe_size} ` +
        `eligible=${evaluation.eligible.length} ` +
        `target=${targetCodes.length} ` +
        `buy=${signals.filter(s => s.signal === 'buy').length} ` +
        `sell=${signals.filter(s => s.signal === 'sell').length} ` +
        `hold=${signals.filter(s => s.signal === 'hold').length}`
    );

    return {
      trade_date: tradeDate,
      is_rebalance_day: true,
      target_portfolio: targetCodes,
      signals,
      filtered: evaluation.filtered,
      params,
      eligible_count: evaluation.eligible.length,
    };
  }

  // -------------------------------------------------------------------------
  // 内部步骤
  // -------------------------------------------------------------------------

  /** 4 维过滤 + 排序 candidates；不做 topN/industry cap（cap 在主流程做） */
  private async evaluateCandidates(
    tradeDate: string,
    params: HighDividendValueParams
  ): Promise<{
    eligible: Array<{
      stock_code: string;
      avg_dividend_yield: number;
      pe_ttm: number;
      roe_5y_avg: number;
      total_market_cap: number;
      meta?: HighDividendValueStockMeta;
      reference_price: number;
    }>;
    filtered: HighDividendValueFilteredStats;
  }> {
    const filtered: HighDividendValueFilteredStats = emptyFilteredStats();

    // 1) Universe（全 A 股）
    const universe = await this.dataSource.loadCandidateUniverse(tradeDate);
    filtered.universe_size = universe.length;
    if (universe.length === 0) {
      return { eligible: [], filtered };
    }

    // 2) 并行拉 4 源数据
    const [yieldMap, valuationMap, roeMap, metaMap] = await Promise.all([
      this.dataSource.loadAvgDividendYield(tradeDate, params.lookbackYears, universe),
      this.dataSource.loadValuationSnapshot(tradeDate, universe),
      this.dataSource.loadRoe5yAvg(tradeDate, universe),
      this.dataSource.loadStockMeta(universe),
    ]);

    // 3) 4 维过滤
    interface Candidate {
      stock_code: string;
      avg_dividend_yield: number;
      pe_ttm: number;
      roe_5y_avg: number;
      total_market_cap: number;
      meta?: HighDividendValueStockMeta;
      reference_price: number;
    }
    const stage1: Candidate[] = [];

    for (const code of universe) {
      const meta = metaMap.get(code);

      // ST 过滤先做（最便宜）
      if (params.excludeST && meta?.name && isSTName(meta.name)) {
        filtered.fail_st += 1;
        continue;
      }

      const avgYield = yieldMap.get(code);
      if (avgYield == null || !Number.isFinite(avgYield) || avgYield < params.minAvgDividendYield) {
        filtered.fail_dividend += 1;
        continue;
      }

      const val = valuationMap.get(code);
      const pe = val?.pe_ttm;
      if (pe == null || !Number.isFinite(pe) || pe <= 0 || pe > params.maxPE) {
        filtered.fail_pe += 1;
        continue;
      }

      const roe = roeMap.get(code);
      if (roe == null || !Number.isFinite(roe) || roe < params.minROE) {
        filtered.fail_roe += 1;
        continue;
      }

      // total_market_cap：优先 valuation，缺则 meta（Stock 表）
      const mcap = val?.total_market_cap ?? meta?.total_market_cap;
      if (mcap == null || !Number.isFinite(mcap) || mcap < params.minTotalMarketCap) {
        filtered.fail_market_cap += 1;
        continue;
      }

      stage1.push({
        stock_code: code,
        avg_dividend_yield: avgYield,
        pe_ttm: pe,
        roe_5y_avg: roe,
        total_market_cap: mcap,
        meta,
        reference_price: 0, // 后面再批量拉
      });
    }

    // 4) 排序：股息率降 → PE 升 → stock_code 稳定 tie-break
    stage1.sort((a, b) => {
      if (a.avg_dividend_yield !== b.avg_dividend_yield) {
        return b.avg_dividend_yield - a.avg_dividend_yield;
      }
      if (a.pe_ttm !== b.pe_ttm) return a.pe_ttm - b.pe_ttm;
      return a.stock_code.localeCompare(b.stock_code);
    });

    // 5) 给 candidates 填 reference_price（只对入选的拉，省 IO）
    if (stage1.length > 0) {
      const lookupCap = Math.min(stage1.length, params.topN * 3); // 大几倍 cap 容错 industry-neutral 后顺位填补
      const codesForClose = stage1.slice(0, lookupCap).map(c => c.stock_code);
      const closeMap = await this.dataSource.loadDailyClose(tradeDate, codesForClose);
      for (const c of stage1.slice(0, lookupCap)) {
        c.reference_price = closeMap.get(c.stock_code) ?? 0;
      }
    }

    return { eligible: stage1, filtered };
  }

  /** topN cap + 行业中性 cap (industryNeutral=true 时) */
  private applyTopNAndIndustryCap(
    candidates: Array<{
      stock_code: string;
      avg_dividend_yield: number;
      pe_ttm: number;
      roe_5y_avg: number;
      total_market_cap: number;
      meta?: HighDividendValueStockMeta;
      reference_price: number;
    }>,
    params: HighDividendValueParams
  ): Array<{
    stock_code: string;
    avg_dividend_yield: number;
    pe_ttm: number;
    roe_5y_avg: number;
    total_market_cap: number;
    meta?: HighDividendValueStockMeta;
    reference_price: number;
  }> {
    if (!params.industryNeutral) {
      return candidates.slice(0, params.topN);
    }
    const out: typeof candidates = [];
    const perIndustry = new Map<string, number>();
    for (const c of candidates) {
      if (out.length >= params.topN) break;
      const ind = c.meta?.industry ?? '__UNCLASSIFIED__';
      const seen = perIndustry.get(ind) ?? 0;
      if (seen >= params.maxPerIndustry) continue;
      out.push(c);
      perIndustry.set(ind, seen + 1);
    }
    return out;
  }

  /**
   * 合并 default_params + override。scalar 参数走 ?? default fallback。
   */
  private resolveParams(override?: Partial<HighDividendValueParams>): HighDividendValueParams {
    const def = this.definition.default_params as Required<HighDividendValueParams>;
    return {
      topN: override?.topN ?? def.topN,
      lookbackYears: override?.lookbackYears ?? def.lookbackYears,
      minAvgDividendYield: override?.minAvgDividendYield ?? def.minAvgDividendYield,
      maxPE: override?.maxPE ?? def.maxPE,
      minROE: override?.minROE ?? def.minROE,
      minTotalMarketCap: override?.minTotalMarketCap ?? def.minTotalMarketCap,
      excludeST: override?.excludeST ?? def.excludeST,
      industryNeutral: override?.industryNeutral ?? def.industryNeutral,
      maxPerIndustry: override?.maxPerIndustry ?? def.maxPerIndustry,
      rebalancePeriod: override?.rebalancePeriod ?? def.rebalancePeriod,
    };
  }
}

// ---------------------------------------------------------------------------
// 内部 helpers
// ---------------------------------------------------------------------------

function emptyFilteredStats(): HighDividendValueFilteredStats {
  return {
    universe_size: 0,
    fail_dividend: 0,
    fail_pe: 0,
    fail_roe: 0,
    fail_market_cap: 0,
    fail_st: 0,
    fail_industry_cap: 0,
  };
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
