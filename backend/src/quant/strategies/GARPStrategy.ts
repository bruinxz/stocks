import { Op } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { FinancialReport } from '../../models/FinancialReport';
import { StockValuationFactor } from '../../models/StockValuationFactor';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { logger } from '../../utils/logger';
import { isSTName } from '../../utils/stNameUtils';

/**
 * GARPStrategy — 业绩稳定增长 GARP (Growth At Reasonable Price) 策略（US-024）。
 *
 * GARP = 价值与成长的折中：寻找成长性可观但估值仍合理的股票。Peter Lynch
 * 经典策略，PEG ≤ 1 是其核心判断。
 *
 * **入场 4 维 AND 过滤**：
 *   1. 连续 N(默认 3) 年净利润同比 ≥ minNetProfitYoy(15%)
 *      —— 数据源 FinancialReport（report_type='年报'），按 report_date 降序
 *      取最近 N 个年报，全部满足才入选。"连续" 是 GARP 与 "single-year 暴增"
 *      的区别 —— 排除一次性会计利得。
 *   2. PEG ≤ maxPEG(1.0)
 *      —— PEG = PE-TTM / 最新年报净利润增速。
 *      最新年报增速来自 #1 中的最近一期年报；PE-TTM 来自 StockValuationFactor。
 *      仅当 net_profit_yoy > 0 时计算 PEG —— 负增长股票 PEG 无意义。
 *   3. ROE 5 年均值 ≥ minROE(12%)
 *      —— 数据源 FinancialReport（report_type='年报'），近 5 个年报 roe 均值。
 *      要求至少 2 个观测，避免单点噪音被当作长期。
 *   4. 资产负债率 ≤ maxDebtRatio(60%)
 *      —— 数据源 FinancialReport 最近一期 debt_ratio
 *      （任何 report_type，取 report_date 最新）。60% 是 GARP 的传统宽口径
 *      —— 银行 / 地产业天然超过此值，本策略不针对这些行业。
 *
 * **排序**：净利润年化增速降序 → PEG 升序 → stock_code 升序稳定 tie-break
 *
 * **持仓 cap = topN（默认 30）** —— 半年度调仓 + ST 过滤 + maxPerIndustry（可选）
 *
 * **出场**：仅在调仓日（每年 1 月 / 7 月的第 1 个交易日）做 SELL/HOLD/BUY 差分；
 * 非调仓日返回 currentPositions 不变 + 空 signals 数组（同 HighDividendValue 的
 * 季度调仓 gate 模式，但周期是半年度）。
 *
 * **半年度调仓判定**：tradeDate 是 1 月或 7 月的第 1 个交易日（基于 DailyBar
 * 拿全市场在 [半年期起始, +7d] 范围内的交易日，取最早一个 ≥ 起始的 ISO date）。
 * 调用方传非调仓日时返回 hold-only 结果不动持仓——避免每日重复跑相同筛选。
 *
 * 与 HighDividendValue (US-022) 的差异：
 *   - **半年度 vs 季度调仓**：HighDividend 一年 4 次 vs GARP 一年 2 次，
 *     GARP 更"长线"匹配价值成长投资者的换手率偏好。
 *   - **成长 + 估值 双维度** vs 价值单维度：GARP 既看成长性又看估值合理性，
 *     比 HighDividend 的纯价值口径更动态。
 *   - **数据源依赖 FinancialReport** vs DividendHistory：GARP 用基本面增长，
 *     HighDividend 用历史分红。
 *
 * 默认参数（AC 指定）：
 *   topN=30  lookbackYears=3  minNetProfitYoy=15  maxPEG=1.0
 *   minROE=12  maxDebtRatio=60  excludeST=true  industryNeutral=false
 *   maxPerIndustry=5  rebalancePeriod='semi_annual'
 */

export const DEFAULT_GARP_PARAMS: Readonly<Required<GARPParams>> = Object.freeze({
  topN: 30,
  lookbackYears: 3,
  minNetProfitYoy: 15,
  maxPEG: 1.0,
  minROE: 12,
  maxDebtRatio: 60,
  excludeST: true,
  industryNeutral: false,
  maxPerIndustry: 5,
  rebalancePeriod: 'semi_annual' as GARPRebalancePeriod,
});

export type GARPRebalancePeriod = 'semi_annual';

export interface GARPParams {
  /** 最大持仓数（AC 默认 30） */
  topN: number;
  /** 连续 N 年净利润正增长（AC 默认 3） */
  lookbackYears: number;
  /** 连续 N 年每年净利润同比下限 % (AC 默认 15) */
  minNetProfitYoy: number;
  /** PEG 上限（AC 默认 1.0） */
  maxPEG: number;
  /** ROE 5 年均值下限 % (AC 默认 12) */
  minROE: number;
  /** 资产负债率上限 % (AC 默认 60) */
  maxDebtRatio: number;
  /** 是否剔除 ST/*ST */
  excludeST: boolean;
  /** 是否启用行业中性（每行业 ≤ maxPerIndustry） */
  industryNeutral: boolean;
  /** industryNeutral=true 时每行业最大持仓 */
  maxPerIndustry: number;
  /** 调仓频率（仅 semi_annual；未来可能扩 'quarterly' / 'annual'） */
  rebalancePeriod: GARPRebalancePeriod;
}

/** 单笔调仓信号 */
export interface GARPSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  signal: 'buy' | 'sell' | 'hold';
  reason: string;
  reference_price?: number;
  net_profit_yoy_latest?: number;
  peg?: number;
  pe_ttm?: number;
  roe_5y_avg?: number;
  debt_ratio?: number;
}

/** 入场候选过滤维度统计 */
export interface GARPFilteredStats {
  /** 全市场总数（过滤前） */
  universe_size: number;
  /** ST 剔除数 */
  fail_st: number;
  /** 缺年报历史或不连续 N 年正增长 ≥ minNetProfitYoy 剔除数 */
  fail_growth: number;
  /** PE 缺数据 / PE ≤ 0 / PEG > maxPEG 剔除数 */
  fail_peg: number;
  /** ROE 缺数据 / 观测不足 / < minROE 剔除数 */
  fail_roe: number;
  /** 资产负债率缺数据 / > maxDebtRatio 剔除数 */
  fail_debt: number;
  /** 行业中性 cap 剔除数（industryNeutral=true 时） */
  fail_industry_cap: number;
}

export interface GARPSignalsResult {
  trade_date: string;
  /** 是否调仓日（半年度第 1 个交易日）；非调仓日为 false */
  is_rebalance_day: boolean;
  /** 调仓后目标持仓 stock_codes */
  target_portfolio: string[];
  /** 增量信号（BUY/SELL/HOLD）；非调仓日为空数组 */
  signals: GARPSignal[];
  /** 候选过滤维度统计；非调仓日为零值 */
  filtered: GARPFilteredStats;
  /** 实际生效参数（合并 default + override 后） */
  params: GARPParams;
  /** 入场候选数（未 cap 前 / 调仓日才有意义） */
  eligible_count: number;
}

export interface GARPGenerateOptions {
  params?: Partial<GARPParams>;
  /** 当前持仓 stock_codes；不传视为首次评估 */
  previousSelection?: string[];
  /** 强制按调仓日处理（测试用）；默认 false 走真正的日历判定 */
  forceRebalance?: boolean;
}

// ---------------------------------------------------------------------------
// DataSource 接口（便于测试用 fake 注入）
// ---------------------------------------------------------------------------

/**
 * 6 个 loader 方法 — 把 Sequelize 查询从策略主体抽离，便于单元测试 mock。
 *
 * 生产用 DefaultGARPDataSource；测试传 fake。
 */
export interface GARPDataSource {
  /**
   * 候选 universe：全 A 股（is_listed=true）按 6 位 stock_code 输出。
   */
  loadCandidateUniverse(asOfDate: string): Promise<string[]>;

  /**
   * 给定 (asOfDate, lookbackYears, stockCodes) 返回每只股票"最近 lookbackYears
   * 个年报的净利润增长率序列"。按 report_date 降序排列（最新在前）。
   * 不足 lookbackYears 条年报的股票仍出现在 Map 中（让策略统一判定）。
   * 完全无年报的股票不出现在 Map 中。
   */
  loadAnnualNetProfitYoySeries(
    asOfDate: string,
    lookbackYears: number,
    stockCodes: string[]
  ): Promise<Map<string, number[]>>;

  /**
   * 给定 stockCodes 的最新 PE-TTM。返回 Map<stock_code, pe_ttm>。
   * 缺数据 / pe_ttm ≤ 0 不出现在 Map 中。
   */
  loadLatestPETTM(asOfDate: string, stockCodes: string[]): Promise<Map<string, number>>;

  /**
   * 给定 stockCodes 的近 5 年年报 ROE 均值。返回 Map<stock_code, roe_5y_avg>。
   * 观测数 < 2 的股票不出现在 Map 中（避免单点噪音被当作长期）。
   */
  loadRoe5yAvg(asOfDate: string, stockCodes: string[]): Promise<Map<string, number>>;

  /**
   * 给定 stockCodes 的最新一期资产负债率（任何 report_type）。
   * 返回 Map<stock_code, debt_ratio>。缺数据不出现在 Map 中。
   */
  loadLatestDebtRatio(asOfDate: string, stockCodes: string[]): Promise<Map<string, number>>;

  /**
   * 给定 stockCodes 的元数据（name / industry）。
   */
  loadStockMeta(stockCodes: string[]): Promise<Map<string, GARPStockMeta>>;

  /**
   * 给定 (tradeDate, stockCodes) 当日 close（作为 BUY 信号的 reference_price）。
   * 缺数据可以不出现。
   */
  loadDailyClose(tradeDate: string, stockCodes: string[]): Promise<Map<string, number>>;

  /**
   * 判断 tradeDate 是否本半年度的第 1 个交易日。返回 true → 触发调仓。
   * 半年度定义：1-6 月 / 7-12 月；调仓日在 1 月或 7 月第一个交易日。
   * 实现可以查 DailyBar 全市场的 trade_date 集合，找 [半年期起始, +7d] 内最早一个。
   * Fake 实现可以直接基于 ISO 日期判断 + 节假日表。
   */
  isFirstTradingDayOfSemiAnnual(tradeDate: string): Promise<boolean>;
}

export interface GARPStockMeta {
  name?: string | null;
  industry?: string | null;
}

// ---------------------------------------------------------------------------
// 生产 DataSource 实现
// ---------------------------------------------------------------------------

export class DefaultGARPDataSource implements GARPDataSource {
  async loadCandidateUniverse(_asOfDate: string): Promise<string[]> {
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

  async loadAnnualNetProfitYoySeries(
    asOfDate: string,
    lookbackYears: number,
    stockCodes: string[]
  ): Promise<Map<string, number[]>> {
    if (!stockCodes.length || lookbackYears <= 0) return new Map();

    // 取 asOfDate 之前的年报（report_type='年报' ⇔ report_date MMDD = 12-31）
    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCFullYear(lookbackStart.getUTCFullYear() - (lookbackYears + 1));
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const rows = (await FinancialReport.findAll({
      attributes: ['stock_code', 'report_date', 'report_type', 'net_profit_yoy'],
      where: {
        stock_code: { [Op.in]: stockCodes },
        report_date: { [Op.gte]: startIso, [Op.lte]: asOfDate },
        report_type: '年报',
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      report_date: string;
      report_type: string;
      net_profit_yoy: number | string | null;
    }>;

    // 按 stock_code 聚合 → 按 report_date 降序
    const tmp = new Map<string, Array<{ report_date: string; yoy: number | null }>>();
    for (const r of rows) {
      const yoy = r.net_profit_yoy == null ? null : Number(r.net_profit_yoy);
      const yoyFinite = yoy == null || !Number.isFinite(yoy) ? null : yoy;
      const arr = tmp.get(r.stock_code) ?? [];
      arr.push({ report_date: r.report_date, yoy: yoyFinite });
      tmp.set(r.stock_code, arr);
    }

    const out = new Map<string, number[]>();
    for (const [code, arr] of tmp.entries()) {
      arr.sort((a, b) => b.report_date.localeCompare(a.report_date)); // 降序
      // 取最近 lookbackYears 条，把 null 也保留 — 策略层判定 "连续 N 年正增长"
      const series = arr.slice(0, lookbackYears).map(r => (r.yoy ?? NaN) as number);
      out.set(code, series);
    }
    return out;
  }

  async loadLatestPETTM(asOfDate: string, stockCodes: string[]): Promise<Map<string, number>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));

    // 最近 90 天的最新一条
    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 90);
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const rows = (await StockValuationFactor.findAll({
      attributes: ['symbol', 'factor_date', 'pe_ttm'],
      where: {
        symbol: { [Op.in]: symbols },
        factor_date: { [Op.gte]: startIso, [Op.lte]: asOfDate },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      pe_ttm: number | string | null;
    }>;

    const latestDate = new Map<string, string>();
    const latestPE = new Map<string, number>();
    for (const r of rows) {
      const prev = latestDate.get(r.symbol);
      if (prev && prev >= r.factor_date) continue;
      const pe = r.pe_ttm == null ? NaN : Number(r.pe_ttm);
      if (!Number.isFinite(pe) || pe <= 0) continue;
      latestDate.set(r.symbol, r.factor_date);
      latestPE.set(r.symbol, pe);
    }

    const out = new Map<string, number>();
    for (const [symbol, pe] of latestPE.entries()) {
      out.set(stripSuffix(symbol), pe);
    }
    return out;
  }

  async loadRoe5yAvg(asOfDate: string, stockCodes: string[]): Promise<Map<string, number>> {
    if (!stockCodes.length) return new Map();

    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCFullYear(lookbackStart.getUTCFullYear() - 5);
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const rows = (await FinancialReport.findAll({
      attributes: ['stock_code', 'report_date', 'roe'],
      where: {
        stock_code: { [Op.in]: stockCodes },
        report_date: { [Op.gte]: startIso, [Op.lte]: asOfDate },
        report_type: '年报',
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      report_date: string;
      roe: number | string | null;
    }>;

    const agg = new Map<string, { sum: number; count: number }>();
    for (const r of rows) {
      const v = r.roe == null ? NaN : Number(r.roe);
      if (!Number.isFinite(v)) continue;
      const cur = agg.get(r.stock_code) ?? { sum: 0, count: 0 };
      cur.sum += v;
      cur.count += 1;
      agg.set(r.stock_code, cur);
    }

    const out = new Map<string, number>();
    for (const [code, { sum, count }] of agg.entries()) {
      if (count < 2) continue; // 至少 2 个观测才算（同 QualityFactor / HighDividend）
      out.set(code, sum / count);
    }
    return out;
  }

  async loadLatestDebtRatio(asOfDate: string, stockCodes: string[]): Promise<Map<string, number>> {
    if (!stockCodes.length) return new Map();

    // 取近 1.5 年内最新一期 debt_ratio（覆盖最迟年报披露 + 季报）
    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 540);
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const rows = (await FinancialReport.findAll({
      attributes: ['stock_code', 'report_date', 'debt_ratio'],
      where: {
        stock_code: { [Op.in]: stockCodes },
        report_date: { [Op.gte]: startIso, [Op.lte]: asOfDate },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      report_date: string;
      debt_ratio: number | string | null;
    }>;

    const latestDate = new Map<string, string>();
    const latestDebt = new Map<string, number>();
    for (const r of rows) {
      const prev = latestDate.get(r.stock_code);
      if (prev && prev >= r.report_date) continue;
      const d = r.debt_ratio == null ? NaN : Number(r.debt_ratio);
      if (!Number.isFinite(d)) continue;
      latestDate.set(r.stock_code, r.report_date);
      latestDebt.set(r.stock_code, d);
    }

    return latestDebt;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, GARPStockMeta>> {
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
    const out = new Map<string, GARPStockMeta>();
    for (const r of rows) {
      const code = stripSuffix(r.symbol);
      out.set(code, {
        name: r.name ?? null,
        industry: r.industry ?? null,
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

  async isFirstTradingDayOfSemiAnnual(tradeDate: string): Promise<boolean> {
    // tradeDate ISO YYYY-MM-DD
    const d = new Date(`${tradeDate}T00:00:00Z`);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1; // 1..12

    // 半年期起点：1 月（H1）或 7 月（H2）
    const halfStartMonth = month >= 7 ? 7 : 1;
    const halfStartIso = `${year}-${String(halfStartMonth).padStart(2, '0')}-01`;

    // 拿 [halfStart, halfStart + 10d] 全市场 DailyBar trade_date 集合
    const windowEnd = new Date(`${halfStartIso}T00:00:00Z`);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 10);
    const windowEndIso = windowEnd.toISOString().slice(0, 10);

    const bars = (await DailyBar.findAll({
      attributes: ['time'],
      where: {
        time: {
          [Op.gte]: `${halfStartIso}T00:00:00Z`,
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
      if (tIso >= halfStartIso) dateSet.add(tIso);
    }
    if (dateSet.size === 0) return false;
    const sorted = Array.from(dateSet).sort();
    return sorted[0] === tradeDate;
  }
}

const PRODUCTION_DATA_SOURCE: GARPDataSource = new DefaultGARPDataSource();

// ---------------------------------------------------------------------------
// 策略主体
// ---------------------------------------------------------------------------

export class GARPStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'garp_strategy',
    name: '业绩稳定增长 GARP',
    description:
      '连续 3 年净利润同比 ≥ 15% + PEG ≤ 1.0 + ROE 5 年均值 ≥ 12% + 资产负债率 ≤ 60% ' +
      '四维过滤选价值成长股；半年度调仓 top-N，价值与成长的平衡。',
    category: 'multi_factor',
    default_params: { ...DEFAULT_GARP_PARAMS },
    enabled: true,
    risk_level: 'medium',
    tags: ['价值', '成长', 'GARP', 'PEG', '半年度调仓'],
    style: 'large_cap_growth',
    edge_hypothesis: {
      thesis:
        'GARP (Growth at Reasonable Price): 连续 3 年净利润 yoy ≥ 15% + PE ≤ 25 + 5 年 ROE 均值 ≥ 12% + 负债率 ≤ 60%，半年度调仓',
      category: 'structural',
      expected_edge_pct: 8.0,
      expected_holding_days: 180,
      key_factors: ['net_profit_yoy_3y', 'pe_ttm', 'roe_5y_avg', 'debt_ratio'],
      evidence_link: 'Peter Lynch / Beating the Street 1993',
      failure_modes: [
        '业绩增速失速 (企业进入成熟期)',
        'PE 不再 reasonable (估值切换)',
        '高负债率股在加息周期跑输',
      ],
      kill_switch_metric: 'annual_return_pct',
      kill_switch_threshold: 5.0,
    },
  };

  private readonly dataSource: GARPDataSource;

  constructor(dataSource: GARPDataSource = PRODUCTION_DATA_SOURCE) {
    super();
    this.dataSource = dataSource;
  }

  /**
   * QuantStrategy 抽象基类要求的 per-stock evaluate()。
   *
   * 本策略是组合级 + 半年度调仓，不通过单股 pipeline 工作；返回信息性 hold。
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
      target_holding_days: 180,
      reasons: ['GARP 是组合级半年度调仓策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-024 主入口。
   *
   * @param tradeDate ISO YYYY-MM-DD，当日交易日
   * @param options.params 覆盖 default_params 的部分字段
   * @param options.previousSelection 当前持仓 stock_codes
   * @param options.forceRebalance 强制按调仓日处理（测试用）
   */
  async generateSignals(
    tradeDate: string,
    options: GARPGenerateOptions = {}
  ): Promise<GARPSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    const previousSelection = options.previousSelection ?? [];

    // === Step A: 调仓日判定 ===
    const isRebalanceDay =
      options.forceRebalance === true
        ? true
        : await this.dataSource.isFirstTradingDayOfSemiAnnual(tradeDate);
    if (!isRebalanceDay) {
      logger.info(
        `GARP.generateSignals(${tradeDate}): non-rebalance day, returning hold-only ` +
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
    const signals: GARPSignal[] = [];

    // SELL = previous ∩ ¬target
    for (const code of previousSelection) {
      if (!targetSet.has(code)) {
        signals.push({
          stock_code: code,
          signal: 'sell',
          reason: '调仓：本半年度未入选 top N，剔除',
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
          net_profit_yoy_latest: c.net_profit_yoy_latest,
          peg: c.peg,
          pe_ttm: c.pe_ttm,
          roe_5y_avg: c.roe_5y_avg,
          debt_ratio: c.debt_ratio,
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
          `近 ${params.lookbackYears}y NP yoy 全部 ≥ ${params.minNetProfitYoy}%, ` +
          `latest=${c.net_profit_yoy_latest.toFixed(2)}%, PEG=${c.peg.toFixed(2)}, ` +
          `PE-TTM=${c.pe_ttm.toFixed(2)}, ROE 5y avg=${c.roe_5y_avg.toFixed(2)}%, ` +
          `debt=${c.debt_ratio.toFixed(2)}%`,
        reference_price: c.reference_price,
        net_profit_yoy_latest: c.net_profit_yoy_latest,
        peg: c.peg,
        pe_ttm: c.pe_ttm,
        roe_5y_avg: c.roe_5y_avg,
        debt_ratio: c.debt_ratio,
      });
    }

    logger.info(
      `GARP.generateSignals(${tradeDate}): rebalance ` +
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
    params: GARPParams
  ): Promise<{
    eligible: GARPCandidate[];
    filtered: GARPFilteredStats;
  }> {
    const filtered: GARPFilteredStats = emptyFilteredStats();

    // 1) Universe（全 A 股）
    const universe = await this.dataSource.loadCandidateUniverse(tradeDate);
    filtered.universe_size = universe.length;
    if (universe.length === 0) {
      return { eligible: [], filtered };
    }

    // 2) 并行拉 5 源数据（4 财务 + 元数据）
    const [growthMap, peMap, roeMap, debtMap, metaMap] = await Promise.all([
      this.dataSource.loadAnnualNetProfitYoySeries(tradeDate, params.lookbackYears, universe),
      this.dataSource.loadLatestPETTM(tradeDate, universe),
      this.dataSource.loadRoe5yAvg(tradeDate, universe),
      this.dataSource.loadLatestDebtRatio(tradeDate, universe),
      this.dataSource.loadStockMeta(universe),
    ]);

    // 3) 4 维过滤
    const stage1: GARPCandidate[] = [];

    for (const code of universe) {
      const meta = metaMap.get(code);

      // ST 过滤先做（最便宜）
      if (params.excludeST && meta?.name && isSTName(meta.name)) {
        filtered.fail_st += 1;
        continue;
      }

      // 维度 1：连续 N 年净利润同比 ≥ minNetProfitYoy
      const growthSeries = growthMap.get(code);
      if (
        !growthSeries ||
        growthSeries.length < params.lookbackYears ||
        !growthSeries.every(v => Number.isFinite(v) && v >= params.minNetProfitYoy)
      ) {
        filtered.fail_growth += 1;
        continue;
      }
      const latestYoy = growthSeries[0]; // 已按 report_date 降序排列，第 0 个是最新

      // 维度 2：PEG ≤ maxPEG
      const pe = peMap.get(code);
      if (pe == null || !Number.isFinite(pe) || pe <= 0) {
        filtered.fail_peg += 1;
        continue;
      }
      // latestYoy 通过 #1 已确保 > minNetProfitYoy ≥ 0 (default 15)，安全计算 PEG
      const peg = pe / latestYoy;
      if (!Number.isFinite(peg) || peg > params.maxPEG) {
        filtered.fail_peg += 1;
        continue;
      }

      // 维度 3：ROE 5 年均值 ≥ minROE
      const roe = roeMap.get(code);
      if (roe == null || !Number.isFinite(roe) || roe < params.minROE) {
        filtered.fail_roe += 1;
        continue;
      }

      // 维度 4：资产负债率 ≤ maxDebtRatio
      const debt = debtMap.get(code);
      if (debt == null || !Number.isFinite(debt) || debt > params.maxDebtRatio) {
        filtered.fail_debt += 1;
        continue;
      }

      stage1.push({
        stock_code: code,
        net_profit_yoy_latest: latestYoy,
        peg,
        pe_ttm: pe,
        roe_5y_avg: roe,
        debt_ratio: debt,
        meta,
        reference_price: 0, // 后面再批量拉
      });
    }

    // 4) 排序：净利润 yoy 降序 → PEG 升序 → stock_code 升序稳定 tie-break
    stage1.sort((a, b) => {
      if (a.net_profit_yoy_latest !== b.net_profit_yoy_latest) {
        return b.net_profit_yoy_latest - a.net_profit_yoy_latest;
      }
      if (a.peg !== b.peg) return a.peg - b.peg;
      return a.stock_code.localeCompare(b.stock_code);
    });

    // 5) 给 candidates 填 reference_price（只对入选的拉，省 IO）
    if (stage1.length > 0) {
      const lookupCap = Math.min(stage1.length, params.topN * 3);
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
    candidates: GARPCandidate[],
    params: GARPParams
  ): GARPCandidate[] {
    if (!params.industryNeutral) {
      return candidates.slice(0, params.topN);
    }
    const out: GARPCandidate[] = [];
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
  private resolveParams(override?: Partial<GARPParams>): GARPParams {
    const def = this.definition.default_params as Required<GARPParams>;
    return {
      topN: override?.topN ?? def.topN,
      lookbackYears: override?.lookbackYears ?? def.lookbackYears,
      minNetProfitYoy: override?.minNetProfitYoy ?? def.minNetProfitYoy,
      maxPEG: override?.maxPEG ?? def.maxPEG,
      minROE: override?.minROE ?? def.minROE,
      maxDebtRatio: override?.maxDebtRatio ?? def.maxDebtRatio,
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

interface GARPCandidate {
  stock_code: string;
  net_profit_yoy_latest: number;
  peg: number;
  pe_ttm: number;
  roe_5y_avg: number;
  debt_ratio: number;
  meta?: GARPStockMeta;
  reference_price: number;
}

function emptyFilteredStats(): GARPFilteredStats {
  return {
    universe_size: 0,
    fail_st: 0,
    fail_growth: 0,
    fail_peg: 0,
    fail_roe: 0,
    fail_debt: 0,
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
