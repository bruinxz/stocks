/**
 * AnalystConsensusFactor (分析师一致预期评分) — US-030
 *
 * 公式：raw_value = 近 30 日 forecast_eps_y1 一致预期相对近 90 日历史一致预期的 *上调比例*。
 *
 *   per-year revision = ( avg(forecast_eps_y1 in [as_of - 30, as_of])
 *                       - avg(forecast_eps_y1 in [as_of - 90, as_of - 30]) )
 *                       / |avg(forecast_eps_y1 in [as_of - 90, as_of - 30])|
 *
 *   raw_value = mean(per-year revisions across all forecast_year_y1 covered by this stock)
 *
 *   - 正值 → 卖方分析师近 30 日把 EPS 预测上调（看好基本面）
 *   - 负值 → 下调（基本面恶化或 guidance miss）
 *   - 因子越高得分越高，符合 multi-factor 加权后期望
 *
 * 为什么按 forecast_year_y1 分组：
 *   - 跨年时 AKShare 的 "{Y}-盈利预测-收益" 列年份会自动向后滚动 (e.g. Y1 从 2025
 *     变成 2026)。如果不按 forecast_year_y1 分组，2024 末的 "2025E EPS" 会
 *     被错误地与 2025 末的 "2026E EPS" 直接比较，得到无意义的"revision"。
 *   - 按 year 分组后，每个年度内部进行新旧对比，跨年滚动不污染信号；
 *     如同一只股票多个年度都有 revision，取算术均值。
 *
 * 数据源：AnalystForecast 表（US-030 同步落库）
 *   - 主键 (report_date, stock_code, analyst_firm) — 一份研报一行
 *   - 关键字段：forecast_eps_y1（最近期前向年度 EPS）+ forecast_year_y1
 *
 * 失效（不入 Map，让 Pipeline 中性补全）：
 *   - 该股票近 90 日窗口内有效研报 < MIN_REPORTS_TOTAL（5）→ 跳过
 *     （研报太少无统计意义；散户股 / 北交所新股普遍如此）
 *   - 任一 forecast_year_y1 在 baseline 窗口 [-90, -30] 内 0 条 → 该年份跳过
 *   - 任一 forecast_year_y1 在 recent 窗口 [-30, 0] 内 0 条 → 该年份跳过
 *   - 所有年份都跳过 → 该股票不入 Map
 *   - baseline avg ≈ 0（亏损股，分母接近 0）→ 该年份跳过（避免 revision 爆炸）
 *
 * 关于"因子不做归一化"约束 #1：
 *   - 本因子计算的 raw_value 是"上调比例"，是 **绝对业务量**（per-stock 自身
 *     新旧 EPS 预测之比），不参照横截面统计量 — 走标准模式（不属 LiquidityFactor
 *     例外）。Pipeline 后续仍做 winsorize + zscore 跨因子归一化。
 *
 * 与 EarningsSurpriseFactor (US-032 计划) 的协作：
 *   - 本因子捕捉 **预期变化**（事前，研报频次驱动）
 *   - US-032 捕捉 **实际超预期**（事后，实际 vs 一致预期的 surprise）
 *   - 二者互补：前者预测拐点早，后者验证拐点真伪
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { AnalystForecast } from '../../../models/AnalystForecast';
import { isFiniteNumber, lookbackStartDate } from './_helpers';

/** 近期窗口（自然日）— "最近 30 日的研报" */
export const RECENT_WINDOW_DAYS = 30;
/** 总窗口（自然日）— "近 90 日"，即 baseline 窗口 = [-90, -30] */
export const TOTAL_WINDOW_DAYS = 90;
/** 单只股票计算因子值所需的最少有效研报数（recent + baseline 合计） */
export const MIN_REPORTS_TOTAL = 5;
/** baseline 均值 ≤ 此绝对值视为"接近 0"，避免上调比例分母爆炸 */
export const BASELINE_ZERO_THRESHOLD = 0.05;

/**
 * 单只股票多家机构多年度 EPS 预测的 revision 计算 helper（抽成纯函数便于测试）.
 *
 * @param reports   该股票在 [as_of - TOTAL_WINDOW_DAYS, as_of] 内的全部 (firm, date, eps_y1, year_y1) 记录
 * @param asOfDate  截面日期 (YYYY-MM-DD)
 * @returns         per-year revision 数组（已剔除无效年份）；若无可用 year → 空数组
 */
export interface ForecastInput {
  report_date: string;
  forecast_eps_y1: number | null | undefined;
  forecast_year_y1: number | null | undefined;
}

export interface PerYearRevision {
  forecast_year_y1: number;
  recent_avg: number;
  baseline_avg: number;
  revision: number;
  recent_count: number;
  baseline_count: number;
}

export function computeRevisionPerYear(
  reports: ForecastInput[],
  asOfDate: string,
  recentWindowDays: number = RECENT_WINDOW_DAYS,
  totalWindowDays: number = TOTAL_WINDOW_DAYS,
  baselineZeroThreshold: number = BASELINE_ZERO_THRESHOLD
): PerYearRevision[] {
  if (!reports.length || !asOfDate) return [];

  const asOf = new Date(`${asOfDate}T00:00:00Z`);
  const recentCutoffStr = isoDateMinusDays(asOf, recentWindowDays);
  const totalCutoffStr = isoDateMinusDays(asOf, totalWindowDays);

  // 按 forecast_year_y1 分组
  const byYear = new Map<number, { recent: number[]; baseline: number[] }>();
  for (const r of reports) {
    const yr = r.forecast_year_y1;
    const eps = r.forecast_eps_y1;
    if (yr == null || !Number.isFinite(yr) || yr <= 0) continue;
    if (eps == null || !isFiniteNumber(eps)) continue;
    if (!r.report_date) continue;
    if (r.report_date < totalCutoffStr) continue;
    if (r.report_date > asOfDate) continue;

    const bucket = byYear.get(yr) ?? { recent: [], baseline: [] };
    if (r.report_date >= recentCutoffStr) {
      bucket.recent.push(eps);
    } else {
      bucket.baseline.push(eps);
    }
    byYear.set(yr, bucket);
  }

  const out: PerYearRevision[] = [];
  for (const [year, { recent, baseline }] of byYear.entries()) {
    if (recent.length === 0 || baseline.length === 0) continue;
    const recentAvg = mean(recent);
    const baselineAvg = mean(baseline);
    if (Math.abs(baselineAvg) < baselineZeroThreshold) continue; // 亏损股 / 接近零 — 跳过
    const revision = (recentAvg - baselineAvg) / Math.abs(baselineAvg);
    if (!isFiniteNumber(revision)) continue;
    out.push({
      forecast_year_y1: year,
      recent_avg: recentAvg,
      baseline_avg: baselineAvg,
      revision,
      recent_count: recent.length,
      baseline_count: baseline.length,
    });
  }
  // 排序：按年份升序，便于阅读（compute() 内取 mean 顺序无关）
  out.sort((a, b) => a.forecast_year_y1 - b.forecast_year_y1);
  return out;
}

/**
 * 跨多个 forecast_year_y1 的 revision 数组聚合成一个 raw_value（算术均值）.
 * 空数组 → null（让 Pipeline 中性补全）.
 */
export function aggregateRevisions(perYearRevisions: PerYearRevision[]): number | null {
  if (!perYearRevisions.length) return null;
  const vals = perYearRevisions.map(p => p.revision);
  return mean(vals);
}

export const analystConsensusFactor: Factor = {
  name: 'analyst_consensus',
  description: '近 30 日 vs 60 日前 forecast_eps_y1 一致预期上调比例（卖方研报上修方向）',
  category: 'sentiment',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 拉窗口内的 AnalystForecast（按 stock_code IN 过滤 universe）
    const startDate = lookbackStartDate(ctx.as_of_date, TOTAL_WINDOW_DAYS + 5);
    const rows = (await AnalystForecast.findAll({
      attributes: ['stock_code', 'report_date', 'forecast_eps_y1', 'forecast_year_y1'],
      where: {
        stock_code: { [Op.in]: ctx.universe },
        report_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      report_date: string;
      forecast_eps_y1: any;
      forecast_year_y1: any;
    }>;

    // 按 stock_code 分组
    const byStock = new Map<string, ForecastInput[]>();
    for (const r of rows) {
      const eps = r.forecast_eps_y1 == null ? null : Number(r.forecast_eps_y1);
      const yr = r.forecast_year_y1 == null ? null : Number(r.forecast_year_y1);
      const arr = byStock.get(r.stock_code) ?? [];
      arr.push({
        report_date: r.report_date,
        forecast_eps_y1: isFiniteNumber(eps as number) ? (eps as number) : null,
        forecast_year_y1: yr != null && Number.isFinite(yr) ? yr : null,
      });
      byStock.set(r.stock_code, arr);
    }

    // per-stock 计算 revision
    for (const [code, reports] of byStock.entries()) {
      // 总研报数低于 MIN_REPORTS_TOTAL 直接跳过（研报覆盖不足无统计意义）
      const validCount = reports.filter(
        r =>
          r.forecast_eps_y1 != null &&
          isFiniteNumber(r.forecast_eps_y1) &&
          r.forecast_year_y1 != null
      ).length;
      if (validCount < MIN_REPORTS_TOTAL) continue;

      const perYear = computeRevisionPerYear(reports, ctx.as_of_date);
      const agg = aggregateRevisions(perYear);
      if (agg === null) continue;
      out.set(code, agg);
    }

    return out;
  },
};

factorRegistry.register(analystConsensusFactor);

// ---------------------------------------------------------------------------
// 纯数学 helpers（抽成 export 供单测独立调用 — 模式来自 US-029 LiquidityFactor）
// ---------------------------------------------------------------------------

/** 算术均值；空数组返回 0 */
export function mean(values: number[]): number {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** 给定 Date + 自然日，返回 isoDate 字符串 (YYYY-MM-DD) */
export function isoDateMinusDays(asOf: Date, days: number): string {
  const d = new Date(asOf.getTime());
  d.setUTCDate(d.getUTCDate() - Math.max(0, days));
  return d.toISOString().slice(0, 10);
}
