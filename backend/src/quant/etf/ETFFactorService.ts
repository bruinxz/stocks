/**
 * ETFFactorService (ETF 四因子打分) — 信号优先重构 批5-b, 严格按 §4.1
 *
 * 输入: ETF universe (6 位代码列表) + factor_date (月末快照日).
 * 输出: 每只 ETF 的 { value / quality / lowvol / momentum(shadow) raw + z + total_score }.
 *
 * §4.1 口径:
 *   - Value(0.40): 成分股层 z(1/pb)+z(1/pe_ttm)+z(dividend_yield) → 成分权重加权 → ETF 层
 *   - Quality(0.30): 成分股层 z(roe)+z(-stddev_5y_net_profit)+z(roe_5y_avg) → 加权 → ETF 层
 *   - LowVol(0.30): ETF 层直接算 z(-vol_60d)*0.6 + z(-vol_20d)*0.4 (不下沉成分股)
 *   - Momentum(0.0 shadow): ETF 层 z(return_20d) - z(return_5d)*0.3, 单独存不入 total
 *   - z-score in universe: 全部候选 ETF 的所有成分股横截面 (Value/Quality),
 *     ETF 之间横截面 (LowVol/Momentum)
 *   - 综合分 = 0.40*z(value_raw) + 0.30*z(quality_raw) + 0.30*z(lowvol_raw) + 0.0*z(mom_raw)
 *
 * 缺失处理 (§4.1):
 *   - 成分股单字段缺 → universe median 填充
 *   - >30% 成分股缺关键字段 → 该 ETF 当月 data_incomplete, 不参与排名
 *   - LowVol 交易日缺 >5 天 → 该 ETF 剔除
 *
 * 只读不写. 权重 V0 常量与 §4.1 表一致, 可被 options 覆盖用于敏感性验证网格.
 */

import { Op } from 'sequelize';
import { DailyBar } from '../../models/DailyBar';
import { FinancialReport } from '../../models/FinancialReport';
import { DividendHistory } from '../../models/DividendHistory';
import { StockValuationFactor } from '../../models/StockValuationFactor';
import { StockFundamentalFactor } from '../../models/StockFundamentalFactor';
import { zscore } from '../factors/normalization';
import { stripSuffix, inferStockSymbol, lookbackStartDate } from '../factors/library/_helpers';
import { Stock } from '../../models/Stock';
import {
  ETFConstituentExpander,
  etfConstituentExpander,
  ETFConstituents,
} from './ETFConstituentExpander';

/** 因子权重 V0 (§4.1 表, Momentum shadow 不入实盘). 可覆盖做敏感性网格. */
export interface ETFFactorWeights {
  value: number;
  quality: number;
  lowvol: number;
  momentum: number;
}

export const ETF_FACTOR_WEIGHTS_V0: Readonly<ETFFactorWeights> = Object.freeze({
  value: 0.4,
  quality: 0.3,
  lowvol: 0.3,
  momentum: 0.0, // shadow only, walk-forward 观察
});

/** §4.1 缺失阈值. */
const MAX_MISSING_CONSTITUENT_RATIO = 0.3; // >30% 成分缺关键字段 → data_incomplete
const MAX_MISSING_TRADING_DAYS = 5; // LowVol 交易日缺 >5 天 → 剔除
const VOL_60D = 60;
const VOL_20D = 20;
const RET_20D = 20;
const RET_5D = 5;
const ANNUALIZE = Math.sqrt(252);

export interface ETFFactorScore {
  etf_code: string;
  value_raw: number | null;
  quality_raw: number | null;
  lowvol_raw: number | null;
  momentum_raw: number | null; // shadow
  value_z: number;
  quality_z: number;
  lowvol_z: number;
  momentum_z: number; // shadow
  /** 综合分 = Σ weight × z(factor_raw), Momentum 权重 0 不计入 */
  total_score: number;
  /** true = 数据不完整, 不参与排名 */
  data_incomplete: boolean;
  /** 成分展开来源诊断 */
  constituent_source: string;
  reasons: string[];
}

/** 成分股层原始因子值 (universe 内横截面, key = 纯 6 位 code). */
interface StockLevelRaw {
  value: Map<string, number>; // z(1/pb)+z(1/pe)+z(divyield) 之前的三分量, 见实现
  quality: Map<string, number>;
}

export interface ETFFactorDataSource {
  /** 加载全 universe 成分股集合的估值 (pe_ttm/pb, 最新 <= date). key=纯6位 */
  loadValuation(
    codes: string[],
    asOfDate: string
  ): Promise<Map<string, { pe: number; pb: number }>>;
  /** 加载成分股股息率 (yield_pct, 最新 <= date). key=纯6位 */
  loadDividendYield(codes: string[], asOfDate: string): Promise<Map<string, number>>;
  /** 加载成分股最新 roe + 5 年 roe 均值 + 5 年净利润 stddev. key=纯6位 */
  loadQuality(
    codes: string[],
    asOfDate: string
  ): Promise<
    Map<string, { roe: number | null; roe5yAvg: number | null; netProfitStd5y: number | null }>
  >;
  /** 加载 ETF 自身的日 close 序列 (近 ~90 交易日, LowVol/Momentum 用). key=ETF6位 */
  loadEtfCloses(etfCodes: string[], asOfDate: string): Promise<Map<string, number[]>>;
}

export class DefaultETFFactorDataSource implements ETFFactorDataSource {
  async loadValuation(
    codes: string[],
    asOfDate: string
  ): Promise<Map<string, { pe: number; pb: number }>> {
    const out = new Map<string, { pe: number; pb: number }>();
    if (!codes.length) return out;
    const start = lookbackStartDate(asOfDate, 120);
    const rows = (await StockValuationFactor.findAll({
      attributes: ['symbol', 'factor_date', 'pe_ttm', 'pb', 'source'],
      where: { factor_date: { [Op.gte]: start, [Op.lte]: asOfDate } },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      pe_ttm: any;
      pb: any;
      source: string;
    }>;
    const universe = new Set(codes);
    // 同一 factor_date 下多源共存 (uniq 约束含 source): 真实源 (baostock/tushare/eastmoney)
    // 优先于 local_derived 弱代理, 避免 fake pe/pb 盖过真实值。数值越大越优先。
    const sourceRank = (src: string): number => {
      switch (String(src || '').toLowerCase()) {
        case 'tushare':
          return 4;
        case 'baostock':
          return 3;
        case 'eastmoney':
          return 2;
        default:
          return 1; // local_derived / 其它
      }
    };
    const latest = new Map<string, { pe: number; pb: number; date: string; rank: number }>();
    for (const r of rows) {
      const code = stripSuffix(r.symbol);
      if (!universe.has(code)) continue;
      const prev = latest.get(code);
      const rank = sourceRank(r.source);
      const better =
        !prev || r.factor_date > prev.date || (r.factor_date === prev.date && rank > prev.rank);
      if (better) {
        latest.set(code, { pe: Number(r.pe_ttm), pb: Number(r.pb), date: r.factor_date, rank });
      }
    }
    for (const [code, v] of latest) out.set(code, { pe: v.pe, pb: v.pb });
    return out;
  }

  async loadDividendYield(codes: string[], asOfDate: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!codes.length) return out;
    const start = lookbackStartDate(asOfDate, 400); // 股息按年, 400 天足够拿最近一次
    const rows = (await DividendHistory.findAll({
      attributes: ['stock_code', 'ex_date', 'yield_pct'],
      where: { ex_date: { [Op.gte]: start, [Op.lte]: asOfDate } },
      raw: true,
    })) as unknown as Array<{ stock_code: string; ex_date: string; yield_pct: any }>;
    const universe = new Set(codes);
    const latest = new Map<string, { y: number; date: string }>();
    for (const r of rows) {
      const code = stripSuffix(r.stock_code);
      if (!universe.has(code)) continue;
      const y = Number(r.yield_pct);
      if (!Number.isFinite(y)) continue;
      const prev = latest.get(code);
      if (!prev || r.ex_date > prev.date) latest.set(code, { y, date: r.ex_date });
    }
    for (const [code, v] of latest) out.set(code, v.y);
    return out;
  }

  async loadQuality(
    codes: string[],
    asOfDate: string
  ): Promise<
    Map<string, { roe: number | null; roe5yAvg: number | null; netProfitStd5y: number | null }>
  > {
    const out = new Map<
      string,
      { roe: number | null; roe5yAvg: number | null; netProfitStd5y: number | null }
    >();
    if (!codes.length) return out;
    const universe = new Set(codes);

    // 最新 roe: stock_fundamental_factors (report_period 至少早 factor_date 30 天由回填保证)
    const sffStart = lookbackStartDate(asOfDate, 180);
    const sff = (await StockFundamentalFactor.findAll({
      attributes: ['symbol', 'factor_date', 'roe'],
      where: { factor_date: { [Op.gte]: sffStart, [Op.lte]: asOfDate } },
      raw: true,
    })) as unknown as Array<{ symbol: string; factor_date: string; roe: any }>;
    const latestRoe = new Map<string, { roe: number; date: string }>();
    for (const r of sff) {
      const code = stripSuffix(r.symbol);
      if (!universe.has(code)) continue;
      const roe = Number(r.roe);
      if (!Number.isFinite(roe)) continue;
      const prev = latestRoe.get(code);
      if (!prev || r.factor_date > prev.date) latestRoe.set(code, { roe, date: r.factor_date });
    }

    // 5 年年报: roe 序列 (求均值) + net_profit 序列 (求 stddev)
    const frStart = lookbackStartDate(asOfDate, 365 * 5);
    const fr = (await FinancialReport.findAll({
      attributes: ['stock_code', 'report_date', 'report_type', 'roe', 'net_profit'],
      where: {
        report_date: { [Op.gte]: frStart, [Op.lte]: asOfDate },
        report_type: 'annual',
      },
      raw: true,
    })) as unknown as Array<{ stock_code: string; report_date: string; roe: any; net_profit: any }>;
    const roeSeries = new Map<string, number[]>();
    const profitSeries = new Map<string, number[]>();
    for (const r of fr) {
      const code = stripSuffix(r.stock_code);
      if (!universe.has(code)) continue;
      const roe = Number(r.roe);
      if (Number.isFinite(roe)) {
        const a = roeSeries.get(code) ?? [];
        a.push(roe);
        roeSeries.set(code, a);
      }
      const np = Number(r.net_profit);
      if (Number.isFinite(np)) {
        const a = profitSeries.get(code) ?? [];
        a.push(np);
        profitSeries.set(code, a);
      }
    }
    const sd = (arr: number[]): number | null => {
      if (arr.length < 2) return null;
      const m = arr.reduce((s, v) => s + v, 0) / arr.length;
      let acc = 0;
      for (const v of arr) acc += (v - m) * (v - m);
      return Math.sqrt(acc / (arr.length - 1));
    };
    const avg = (arr: number[]): number | null =>
      arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

    for (const code of codes) {
      const roe = latestRoe.get(code)?.roe ?? null;
      const roe5yAvg = avg(roeSeries.get(code) ?? []);
      const netProfitStd5y = sd(profitSeries.get(code) ?? []);
      if (roe === null && roe5yAvg === null && netProfitStd5y === null) continue;
      out.set(code, { roe, roe5yAvg, netProfitStd5y });
    }
    return out;
  }

  async loadEtfCloses(etfCodes: string[], asOfDate: string): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (!etfCodes.length) return out;
    // ETF code(6位) → Stock.symbol(sh./sz.) → stock_id
    const symbols = Array.from(new Set(etfCodes.map(inferStockSymbol).filter(Boolean)));
    const stocks = (await Stock.findAll({
      attributes: ['id', 'symbol'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{ id: number; symbol: string }>;
    const codeByStockId = new Map<number, string>();
    const stockIds: number[] = [];
    for (const s of stocks) {
      const code = stripSuffix(s.symbol);
      codeByStockId.set(s.id, code);
      stockIds.push(s.id);
    }
    if (!stockIds.length) return out;

    const start = lookbackStartDate(asOfDate, 130); // ~90 交易日
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.gte]: `${start}T00:00:00Z`, [Op.lte]: `${asOfDate}T23:59:59Z` },
      },
      raw: true,
    })) as unknown as Array<{ stock_id: number; time: Date | string; close: any }>;
    const byId = new Map<number, Array<{ t: number; c: number }>>();
    for (const b of bars) {
      const c = Number(b.close);
      if (!Number.isFinite(c) || c <= 0) continue;
      const t = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
      if (!Number.isFinite(t)) continue;
      const a = byId.get(b.stock_id) ?? [];
      a.push({ t, c });
      byId.set(b.stock_id, a);
    }
    for (const [id, arr] of byId) {
      const code = codeByStockId.get(id);
      if (!code) continue;
      arr.sort((a, b) => a.t - b.t);
      out.set(
        code,
        arr.map(x => x.c)
      );
    }
    return out;
  }
}

const PRODUCTION_DATA_SOURCE: ETFFactorDataSource = new DefaultETFFactorDataSource();

export class ETFFactorService {
  private readonly ds: ETFFactorDataSource;
  private readonly expander: ETFConstituentExpander;

  constructor(
    ds: ETFFactorDataSource = PRODUCTION_DATA_SOURCE,
    expander: ETFConstituentExpander = etfConstituentExpander
  ) {
    this.ds = ds;
    this.expander = expander;
  }

  /**
   * 计算 ETF universe 的四因子分 + 综合分 (§4.1).
   * @param etfCodes ETF 6 位代码 universe
   * @param factorDate 月末快照日 YYYY-MM-DD
   * @param weightsOverride 可选权重覆盖 (敏感性网格用)
   */
  async score(
    etfCodes: string[],
    factorDate: string,
    weightsOverride?: Partial<ETFFactorWeights>
  ): Promise<ETFFactorScore[]> {
    const weights: ETFFactorWeights = { ...ETF_FACTOR_WEIGHTS_V0, ...(weightsOverride || {}) };
    if (!etfCodes.length) return [];

    // 1) 展开所有 ETF → 成分股权重
    const expanded = await this.expander.expandMany(etfCodes, factorDate);

    // 2) 收集全 universe 成分股集合
    const allConstituents = new Set<string>();
    for (const c of expanded.values())
      for (const code of c.weights.keys()) allConstituents.add(code);
    const constituentList = Array.from(allConstituents);

    // 3) 拉成分股层数据 + ETF 层 close
    const [valuation, divYield, quality, etfCloses] = await Promise.all([
      this.ds.loadValuation(constituentList, factorDate),
      this.ds.loadDividendYield(constituentList, factorDate),
      this.ds.loadQuality(constituentList, factorDate),
      this.ds.loadEtfCloses(etfCodes, factorDate),
    ]);

    // 4) 成分股层 Value / Quality 原始值 → universe 内横截面 z-score
    const stockValueRaw = this.computeStockValueRaw(constituentList, valuation, divYield);
    const stockQualityRaw = this.computeStockQualityRaw(constituentList, quality);

    // 5) 逐 ETF 聚合 + ETF 层 LowVol/Momentum
    const interim = etfCodes.map(code => {
      const cons = expanded.get(code)!;
      const valueAgg = this.aggregate(cons, stockValueRaw);
      const qualityAgg = this.aggregate(cons, stockQualityRaw);
      const closes = etfCloses.get(code) ?? [];
      const lowvol = this.computeLowVolRaw(closes);
      const momentum = this.computeMomentumRaw(closes);
      const reasons: string[] = [];
      let incomplete = false;
      if (cons.source === 'none' || cons.weights.size === 0) {
        incomplete = true;
        reasons.push('成分股展开为空 (index_components + fund_top_holdings 均无数据)');
      }
      if (valueAgg.missingRatio > MAX_MISSING_CONSTITUENT_RATIO) {
        incomplete = true;
        reasons.push(`Value 缺失成分 ${(valueAgg.missingRatio * 100).toFixed(0)}% > 30%`);
      }
      if (qualityAgg.missingRatio > MAX_MISSING_CONSTITUENT_RATIO) {
        incomplete = true;
        reasons.push(`Quality 缺失成分 ${(qualityAgg.missingRatio * 100).toFixed(0)}% > 30%`);
      }
      if (lowvol === null) {
        incomplete = true;
        reasons.push(
          `LowVol 交易日不足 (需 ${VOL_60D + 1} 条, 缺失 >${MAX_MISSING_TRADING_DAYS} 天)`
        );
      }
      return {
        code,
        value_raw: incomplete ? null : valueAgg.value,
        quality_raw: incomplete ? null : qualityAgg.value,
        lowvol_raw: lowvol,
        momentum_raw: momentum,
        constituent_source: cons.source,
        incomplete,
        reasons,
      };
    });

    // 6) ETF 之间横截面 z-score (仅对 !incomplete 的做, incomplete 的 z=0)
    const eligible = interim.filter(x => !x.incomplete);
    const zValue = this.zByCode(eligible, x => x.value_raw);
    const zQuality = this.zByCode(eligible, x => x.quality_raw);
    const zLowvol = this.zByCode(eligible, x => x.lowvol_raw);
    // Momentum shadow: 对全部有值的算 z (不受 eligible 限制, 供 walk-forward 观察)
    const momInterim = interim.filter(x => x.momentum_raw !== null);
    const zMomentum = this.zByCode(momInterim, x => x.momentum_raw);

    return interim.map(x => {
      const vz = zValue.get(x.code) ?? 0;
      const qz = zQuality.get(x.code) ?? 0;
      const lz = zLowvol.get(x.code) ?? 0;
      const mz = zMomentum.get(x.code) ?? 0;
      const total = x.incomplete
        ? Number.NEGATIVE_INFINITY // 不完整 → 排名垫底, 绝不被选中
        : weights.value * vz + weights.quality * qz + weights.lowvol * lz + weights.momentum * mz;
      return {
        etf_code: x.code,
        value_raw: x.value_raw,
        quality_raw: x.quality_raw,
        lowvol_raw: x.lowvol_raw,
        momentum_raw: x.momentum_raw,
        value_z: vz,
        quality_z: qz,
        lowvol_z: lz,
        momentum_z: mz,
        total_score: total,
        data_incomplete: x.incomplete,
        constituent_source: x.constituent_source,
        reasons: x.reasons,
      };
    });
  }

  // ---- 成分股层原始值 (universe 内 z-score) ----
  private computeStockValueRaw(
    codes: string[],
    valuation: Map<string, { pe: number; pb: number }>,
    divYield: Map<string, number>
  ): Map<string, number> {
    // 三分量各自 universe 内 z-score, 再相加: z(1/pb)+z(1/pe)+z(divyield)
    const invPb: Array<{ code: string; v: number }> = [];
    const invPe: Array<{ code: string; v: number }> = [];
    const dy: Array<{ code: string; v: number }> = [];
    for (const code of codes) {
      const val = valuation.get(code);
      if (val && Number.isFinite(val.pb) && val.pb > 0) invPb.push({ code, v: 1 / val.pb });
      if (val && Number.isFinite(val.pe) && val.pe > 0) invPe.push({ code, v: 1 / val.pe });
      const y = divYield.get(code);
      if (y !== undefined && Number.isFinite(y)) dy.push({ code, v: y });
    }
    const zInvPb = this.zList(invPb);
    const zInvPe = this.zList(invPe);
    const zDy = this.zList(dy);
    const out = new Map<string, number>();
    for (const code of codes) {
      const parts: number[] = [];
      if (zInvPb.has(code)) parts.push(zInvPb.get(code)!);
      if (zInvPe.has(code)) parts.push(zInvPe.get(code)!);
      if (zDy.has(code)) parts.push(zDy.get(code)!);
      if (parts.length)
        out.set(
          code,
          parts.reduce((s, v) => s + v, 0)
        );
    }
    return out;
  }

  private computeStockQualityRaw(
    codes: string[],
    quality: Map<
      string,
      { roe: number | null; roe5yAvg: number | null; netProfitStd5y: number | null }
    >
  ): Map<string, number> {
    // z(roe) + z(-stddev_5y_net_profit) + z(roe_5y_avg)
    const roe: Array<{ code: string; v: number }> = [];
    const negStd: Array<{ code: string; v: number }> = [];
    const roeAvg: Array<{ code: string; v: number }> = [];
    for (const code of codes) {
      const q = quality.get(code);
      if (!q) continue;
      if (q.roe !== null && Number.isFinite(q.roe)) roe.push({ code, v: q.roe });
      if (q.netProfitStd5y !== null && Number.isFinite(q.netProfitStd5y))
        negStd.push({ code, v: -q.netProfitStd5y });
      if (q.roe5yAvg !== null && Number.isFinite(q.roe5yAvg)) roeAvg.push({ code, v: q.roe5yAvg });
    }
    const zRoe = this.zList(roe);
    const zNegStd = this.zList(negStd);
    const zRoeAvg = this.zList(roeAvg);
    const out = new Map<string, number>();
    for (const code of codes) {
      const parts: number[] = [];
      if (zRoe.has(code)) parts.push(zRoe.get(code)!);
      if (zNegStd.has(code)) parts.push(zNegStd.get(code)!);
      if (zRoeAvg.has(code)) parts.push(zRoeAvg.get(code)!);
      if (parts.length)
        out.set(
          code,
          parts.reduce((s, v) => s + v, 0)
        );
    }
    return out;
  }

  /** ETF 层聚合: Σ(weight_i × stock_raw_i) / Σ(weight_i), 缺失成分用 universe median 填充. */
  private aggregate(
    cons: ETFConstituents,
    stockRaw: Map<string, number>
  ): { value: number; missingRatio: number } {
    const codes = Array.from(cons.weights.keys());
    if (!codes.length) return { value: 0, missingRatio: 1 };
    const present = codes.filter(c => stockRaw.has(c));
    const missingRatio = 1 - present.length / codes.length;
    // universe median 填充 (§4.1: 单字段缺 → universe median)
    const allVals = Array.from(stockRaw.values());
    const median = allVals.length ? this.medianOf(allVals) : 0;
    let wsum = 0;
    let acc = 0;
    for (const code of codes) {
      const w = cons.weights.get(code)!;
      const raw = stockRaw.has(code) ? stockRaw.get(code)! : median;
      acc += w * raw;
      wsum += w;
    }
    return { value: wsum > 0 ? acc / wsum : 0, missingRatio };
  }

  /** LowVol raw (§4.1): z(-vol_60d)*0.6 + z(-vol_20d)*0.4, 但此处只出未标准化的组合波动. */
  private computeLowVolRaw(closes: number[]): number | null {
    // 需要 60+1 条算 60 日收益; 交易日缺 >5 天判据用 55 作下限 (60-5)
    if (closes.length < VOL_60D + 1 - MAX_MISSING_TRADING_DAYS) return null;
    const vol60 = this.annualizedVol(closes, VOL_60D);
    const vol20 = this.annualizedVol(closes, VOL_20D);
    if (vol60 === null || vol20 === null) return null;
    // 取负 (低波给高分) + 60d/20d 加权. 这里输出 raw 组合, ETF 间再 z-score.
    return -vol60 * 0.6 + -vol20 * 0.4;
  }

  /** Momentum raw (§4.1 shadow): return_20d - return_5d*0.3 (ETF 间再 z-score). */
  private computeMomentumRaw(closes: number[]): number | null {
    if (closes.length < RET_20D + 1) return null;
    const last = closes[closes.length - 1];
    const p20 = closes[closes.length - 1 - RET_20D];
    const p5 = closes.length >= RET_5D + 1 ? closes[closes.length - 1 - RET_5D] : null;
    if (!(last > 0) || !(p20 > 0)) return null;
    const ret20 = last / p20 - 1;
    const ret5 = p5 && p5 > 0 ? last / p5 - 1 : 0;
    return ret20 - ret5 * 0.3;
  }

  /** 近 window 交易日的年化波动率 (日 log-return 标准差 × sqrt(252)). */
  private annualizedVol(closes: number[], window: number): number | null {
    if (closes.length < window + 1) return null;
    const slice = closes.slice(-window - 1);
    const rets: number[] = [];
    for (let i = 1; i < slice.length; i += 1) {
      const prev = slice[i - 1];
      if (prev > 0 && slice[i] > 0) rets.push(Math.log(slice[i] / prev));
    }
    if (rets.length < 2) return null;
    const m = rets.reduce((s, v) => s + v, 0) / rets.length;
    let acc = 0;
    for (const v of rets) acc += (v - m) * (v - m);
    const sd = Math.sqrt(acc / (rets.length - 1));
    return Number.isFinite(sd) ? sd * ANNUALIZE : null;
  }

  // ---- z-score helpers ----
  private zList(items: Array<{ code: string; v: number }>): Map<string, number> {
    const out = new Map<string, number>();
    if (!items.length) return out;
    const zs = zscore(items.map(i => i.v));
    items.forEach((it, i) => out.set(it.code, zs[i]));
    return out;
  }

  private zByCode<T extends { code: string }>(
    items: T[],
    pick: (x: T) => number | null
  ): Map<string, number> {
    const filtered = items.filter(x => {
      const v = pick(x);
      return v !== null && Number.isFinite(v);
    });
    const out = new Map<string, number>();
    if (!filtered.length) return out;
    const zs = zscore(filtered.map(x => pick(x) as number));
    filtered.forEach((x, i) => out.set(x.code, zs[i]));
    return out;
  }

  private medianOf(values: number[]): number {
    if (!values.length) return 0;
    const s = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
}

export const etfFactorService = new ETFFactorService();
