/**
 * ValueFactor (价值因子) — US-010
 *
 * 公式：raw_value = 1 / PE-TTM + 1 / PB
 *   - PE-TTM 越低 → 1/PE 越大 → 越价值
 *   - PB 越低 → 1/PB 越大 → 越价值
 *   - 两者等权相加（两个比率本身已经是 "便宜度"，无量纲一致）
 *
 * 数据源：
 *   1. StockValuationFactor 表的真实 PE-TTM / PB（优先）
 *   2. 缺失时，用 FinancialReport 的累计 EPS / 每股净资产和当日收盘价计算
 *      年化盈利收益率 + 净资产收益率；公告日前不可见，避免历史前视
 *   - 字段：symbol（带 .SH/.SZ 后缀）、factor_date、pe_ttm、pb
 *   - 选 (symbol, factor_date <= as_of_date) 的最新一条
 *
 * 失效条件（返回 raw_value=null 让 Pipeline 补中性，或干脆不返回这只股票）：
 *   - PE-TTM ≤ 0（亏损股，价值因子无意义）
 *   - PB ≤ 0
 *   - 两者任一缺失
 *
 * 不在因子内做 winsorize / z-score —— FactorPipeline 统一做横截面标准化。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { stripSuffix, isFiniteNumber, lookbackStartDate } from './_helpers';
import { StockValuationFactor } from '../../../models/StockValuationFactor';
import { FinancialReport } from '../../../models/FinancialReport';
import { DailyBar } from '../../../models/DailyBar';
import { Stock } from '../../../models/Stock';

const FINANCIAL_REPORT_LOOKBACK_DAYS = 200;

export function annualizeCumulativeEps(eps: unknown, report_date: string): number | null {
  if (eps == null || eps === '') return null;
  const parsed = Number(eps);
  if (!isFiniteNumber(parsed) || parsed <= 0) return null;
  const suffix = String(report_date).slice(5, 10);
  const multiplier =
    suffix === '03-31' ? 4 : suffix === '06-30' ? 2 : suffix === '09-30' ? 4 / 3 : 1;
  return parsed * multiplier;
}

export function financialReportValueProxy(input: {
  report_date: string;
  raw_payload?: Record<string, any> | null;
  close: unknown;
  as_of_date: string;
}): number | null {
  const rawPayload = input.raw_payload || {};
  const announcementDate = rawPayload.announcement_date;
  if (
    announcementDate &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(String(announcementDate)) ||
      String(announcementDate) > input.as_of_date)
  ) {
    return null;
  }
  const marketRow = rawPayload.market_report_row || {};
  const eps = rawPayload.indicator_row?.['摊薄每股收益(元)'] ?? marketRow['每股收益'];
  const annualizedEps = annualizeCumulativeEps(eps, input.report_date);
  const bookValueRaw = marketRow['每股净资产'];
  const bookValue = bookValueRaw == null || bookValueRaw === '' ? NaN : Number(bookValueRaw);
  const close = input.close == null || input.close === '' ? NaN : Number(input.close);
  if (
    annualizedEps == null ||
    !isFiniteNumber(bookValue) ||
    bookValue <= 0 ||
    !isFiniteNumber(close) ||
    close <= 0
  ) {
    return null;
  }
  // annualized EPS / price = 1/annualized PE; BVPS / price = 1/PB.
  return annualizedEps / close + bookValue / close;
}

export const valueFactor: Factor = {
  name: 'value',
  description: 'PE-TTM 倒数 + PB 倒数；缺失时由已公告每股指标与当日收盘价推导',
  category: 'value',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // StockValuationFactor.symbol 带后缀；universe 是无后缀的。
    // 用 factor_date 时间窗口反查，再按 symbol 取最新一条。
    const lookbackStart = lookbackStartDate(ctx.as_of_date, 60); // 估值数据通常季度更新；60 天足以拿到最新一条

    const rows = (await StockValuationFactor.findAll({
      attributes: ['symbol', 'factor_date', 'pe_ttm', 'pb'],
      where: {
        factor_date: { [Op.gte]: lookbackStart, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      pe_ttm: any;
      pb: any;
    }>;

    // 每个 stock 取 factor_date 最大的一行（最新估值）
    const latestBySymbol = new Map<string, { pe_ttm: any; pb: any; date: string }>();
    for (const r of rows) {
      const cur = latestBySymbol.get(r.symbol);
      if (!cur || r.factor_date > cur.date) {
        latestBySymbol.set(r.symbol, { pe_ttm: r.pe_ttm, pb: r.pb, date: r.factor_date });
      }
    }

    // 按 universe 输出
    const universeSet = new Set(ctx.universe);
    for (const [symbol, snap] of latestBySymbol.entries()) {
      const code = stripSuffix(symbol);
      if (!universeSet.has(code)) continue;

      const pe = Number(snap.pe_ttm);
      const pb = Number(snap.pb);
      if (!isFiniteNumber(pe) || !isFiniteNumber(pb)) continue;
      if (pe <= 0 || pb <= 0) continue; // 亏损 / 异常负值 → 价值不可计算，留稀疏

      out.set(code, 1 / pe + 1 / pb);
    }

    const missingCodes = ctx.universe.filter(code => !out.has(code));
    if (!missingCodes.length) return out;

    const reportStart = lookbackStartDate(ctx.as_of_date, FINANCIAL_REPORT_LOOKBACK_DAYS);
    const reportRows = (await FinancialReport.findAll({
      attributes: ['stock_code', 'report_date', 'raw_payload'],
      where: {
        stock_code: { [Op.in]: missingCodes },
        report_date: { [Op.gte]: reportStart, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      report_date: string;
      raw_payload?: Record<string, any> | null;
    }>;
    const latestReportByCode = new Map<string, (typeof reportRows)[number]>();
    for (const row of reportRows) {
      const announcementDate = row.raw_payload?.announcement_date;
      if (
        announcementDate &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(String(announcementDate)) ||
          String(announcementDate) > ctx.as_of_date)
      ) {
        continue;
      }
      const current = latestReportByCode.get(row.stock_code);
      if (!current || row.report_date > current.report_date) {
        latestReportByCode.set(row.stock_code, row);
      }
    }
    if (!latestReportByCode.size) return out;

    const stocks = (await Stock.findAll({
      attributes: ['id', 'symbol'],
      where: { is_listed: true, type: 'stock' },
      raw: true,
    })) as unknown as Array<{ id: number; symbol: string }>;
    const stockByCode = new Map(
      stocks
        .map(stock => [stripSuffix(stock.symbol), stock] as const)
        .filter(([code]) => latestReportByCode.has(code))
    );
    const stockIds = [...stockByCode.values()].map(stock => stock.id);
    if (!stockIds.length) return out;

    const dayStart = new Date(`${ctx.as_of_date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
        is_trading_day: true,
        is_suspended: false,
      },
      order: [
        ['stock_id', 'ASC'],
        ['time', 'DESC'],
      ],
      raw: true,
    })) as unknown as Array<{ stock_id: number; time: Date; close: any }>;
    const closeByStockId = new Map<number, any>();
    for (const bar of bars) {
      if (!closeByStockId.has(bar.stock_id)) closeByStockId.set(bar.stock_id, bar.close);
    }

    for (const [code, report] of latestReportByCode.entries()) {
      const stock = stockByCode.get(code);
      if (!stock) continue;
      const proxy = financialReportValueProxy({
        report_date: report.report_date,
        raw_payload: report.raw_payload,
        close: closeByStockId.get(stock.id),
        as_of_date: ctx.as_of_date,
      });
      if (proxy != null) out.set(code, proxy);
    }

    return out;
  },
};

factorRegistry.register(valueFactor);
