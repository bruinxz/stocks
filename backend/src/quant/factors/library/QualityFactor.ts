/**
 * QualityFactor (质量因子) — US-010
 *
 * 公式：raw_value = ROE_5y_avg - 0.3 * debt_asset_ratio
 *   - ROE 5 年均值越高 → 越优质（盈利能力强）
 *   - 资产负债率反向（系数 -0.3）：杠杆过高的公司质量低
 *
 * 数据源：StockFundamentalFactor 表
 *   - 字段：symbol、factor_date、roe、debt_asset_ratio
 *   - 取最近 5 年（ctx.lookbackDays * 5 自然日 ≈ 5 年）的 roe 均值
 *   - debt_asset_ratio 取最新值
 *
 * 失效：ROE 缺数据 / 5 年内只有 < 2 个观测 → 跳过这只股票（不入 Map，
 * Pipeline 会用中性行补全）。
 *
 * **小心 PRD 的 "5 年均值"**：A 股年报一年发布 1 次，公司层面 ROE 一年通常
 * 只有 ~4 个观测（一季报/半年报/三季报/年报）。
 * 5 年 = ~20 个观测，是足够的样本。
 * StockFundamentalFactor 的 factor_date 是 "数据计算日"，不一定是报告期；
 * 但通常每季度更新一次，5 年自然日 ≈ 1825 天能覆盖 20 个观测。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { stripSuffix, isFiniteNumber, lookbackStartDate } from './_helpers';
import { StockFundamentalFactor } from '../../../models/StockFundamentalFactor';
import { FinancialReport } from '../../../models/FinancialReport';

const FIVE_YEARS_DAYS = 365 * 5;

export const qualityFactor: Factor = {
  name: 'quality',
  description: 'ROE 5 年均值 - 0.3*资产负债率，反映长期盈利能力与杠杆水平',
  category: 'quality',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    const startDate = lookbackStartDate(ctx.as_of_date, FIVE_YEARS_DAYS);

    const rows = (await StockFundamentalFactor.findAll({
      attributes: ['symbol', 'factor_date', 'roe', 'debt_asset_ratio'],
      where: {
        factor_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      roe: any;
      debt_asset_ratio: any;
    }>;

    // 按 symbol 分组聚合：累计 ROE 用于求均值 + 取最新 debt_asset_ratio
    interface Agg {
      roeSum: number;
      roeCount: number;
      latestDebt: number | null;
      latestDebtDate: string;
    }
    const agg = new Map<string, Agg>();
    for (const r of rows) {
      const cur = agg.get(r.symbol) ?? {
        roeSum: 0,
        roeCount: 0,
        latestDebt: null,
        latestDebtDate: '',
      };
      const roe = r.roe == null || r.roe === '' ? NaN : Number(r.roe);
      if (isFiniteNumber(roe)) {
        cur.roeSum += roe;
        cur.roeCount += 1;
      }
      const debt =
        r.debt_asset_ratio == null || r.debt_asset_ratio === '' ? NaN : Number(r.debt_asset_ratio);
      if (isFiniteNumber(debt) && r.factor_date > cur.latestDebtDate) {
        cur.latestDebt = debt;
        cur.latestDebtDate = r.factor_date;
      }
      agg.set(r.symbol, cur);
    }

    const universeSet = new Set(ctx.universe);
    const resolvedCodes = new Set<string>();
    for (const [symbol, a] of agg.entries()) {
      const code = stripSuffix(symbol);
      if (!universeSet.has(code)) continue;

      // 至少要 2 个 ROE 观测才能算均值（避免单点噪音被当作"长期"）
      if (a.roeCount < 2) continue;
      const avgRoe = a.roeSum / a.roeCount;

      // debt_asset_ratio 缺时按 0 处理（最佳情况），但 ROE 缺则放弃
      const debt = a.latestDebt ?? 0;

      out.set(code, avgRoe - 0.3 * debt);
      resolvedCodes.add(code);
    }

    // 全市场财务源按公告日保留历史可见性。旧 SFF 数据大量 roe=NULL，不能再
    // 让 Number(null) 把整张截面伪造成 0；对缺失股票使用截至当日已公告报告
    // 的年化 ROE 均值，仍维持“长期盈利质量”的原始业务含义。
    const missingCodes = ctx.universe.filter(code => !resolvedCodes.has(code));
    if (missingCodes.length) {
      const reports = (await FinancialReport.findAll({
        attributes: ['stock_code', 'report_date', 'roe', 'raw_payload'],
        where: {
          stock_code: { [Op.in]: missingCodes },
          report_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
        },
        raw: true,
      })) as unknown as Array<{
        stock_code: string;
        report_date: string;
        roe: unknown;
        raw_payload?: Record<string, any> | null;
      }>;
      const reportAgg = new Map<string, { sum: number; count: number }>();
      for (const report of reports) {
        const announcementDate = report.raw_payload?.announcement_date;
        if (
          announcementDate &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(String(announcementDate)) ||
            String(announcementDate) > ctx.as_of_date)
        ) {
          continue;
        }
        const rawRoe = report.roe == null || report.roe === '' ? NaN : Number(report.roe);
        if (!isFiniteNumber(rawRoe)) continue;
        const suffix = report.report_date.slice(5, 10);
        const annualizer =
          suffix === '03-31' ? 4 : suffix === '06-30' ? 2 : suffix === '09-30' ? 4 / 3 : 1;
        const current = reportAgg.get(report.stock_code) ?? { sum: 0, count: 0 };
        current.sum += rawRoe * annualizer;
        current.count += 1;
        reportAgg.set(report.stock_code, current);
      }
      for (const [code, values] of reportAgg.entries()) {
        if (values.count < 1 || !universeSet.has(code)) continue;
        out.set(code, values.sum / values.count);
      }
    }

    return out;
  },
};

factorRegistry.register(qualityFactor);
