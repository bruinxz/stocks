/**
 * EarningsSurpriseFactor (盈利惊喜因子) — US-032
 *
 * 公式：raw_value = (actual_eps - consensus_eps_avg) / |consensus_eps_avg|
 *
 *   - 正值 → 实际 EPS 超过卖方一致预期（基本面改善 / guidance beat）
 *   - 负值 → 实际不及预期（miss）
 *   - 因子越高得分越高，符合 multi-factor 加权"赚 PEAD（Post-Earnings
 *     Announcement Drift）"的预期。
 *
 * 数据源（按 AC 拆解）：
 *   - 实际值：FinancialReport（report_type='年报' / '半年报' / '一季报' / '三季报'）
 *     的 report_date 锁定财报期；
 *     **实际 EPS** 取 StockFundamentalFactor.eps（同期 report_period 匹配）
 *   - 预期值：AnalystForecast.forecast_eps_y1，按 forecast_year_y1 = year(报告期末)
 *     聚合在财报公告前的 N 份研报均值。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 关于 AC 字段不可得的代理替代（按 factors/CLAUDE.md "AC 字段不可得时的代理替代范式"）
 *
 *   AC 原始公式：「(实际净利润 - 一致预期净利润) / |一致预期净利润|」
 *
 *   当前本仓库的数据模型 *不可得* 的字段：
 *     (a) **AnalystForecast 不提供净利润预测**，只提供 forecast_eps_y1（每股盈利）。
 *         若要把 EPS 反推回净利润必须有 total_shares —— 但 Stock /
 *         StockValuationFactor / StockFundamentalFactor 均无 total_shares 字段，
 *         无法转换。
 *     (b) **FinancialReport 不提供公告日 announce_date**，只提供 report_date
 *         （报告期末，e.g. 2024-12-31 = 2024 年报）。
 *         没有 announce_date 就无法精确实现 "公告日后 60 个交易日" 的截止判定。
 *
 *   选定代理（依据 + 升级路径）：
 *     (a) **EPS 维度** 双向比较替代净利润维度：actual_eps 取
 *         StockFundamentalFactor.eps（同股 / 同 report_period），consensus_eps
 *         取 AnalystForecast.forecast_eps_y1 同年度均值。两侧单位 (元/股) 一致，
 *         比率天然无量纲，"surprise rate" 业务语义不变。升级路径：US-090+ 引入
 *         total_shares 落库后可切换为净利润维度（fact: net_profit = eps × shares）。
 *     (b) **`report_date + 窗口` 替代 `announce_date + 60 个交易日`**：
 *         report_date = 2024-12-31 的年报，企业典型公告期为 2025-02 至 2025-04
 *         （CSRC 规定年报 4 月底前公告），PEAD 学术研究 drift 期 ≈ 60 交易日 ≈
 *         90 自然日。"announce 后 60 交易日内" 的最远 as_of_date ≈ 报告期末
 *         + 120 自然日（announce delay 上限）+ 90 自然日（drift 窗口）= 210 自然日。
 *         本 factor 用 POST_REPORT_WINDOW_DAYS（默认 180 自然日）作为更紧的代理 ——
 *         它假设 announce 落在 report_date + 90 自然日，PEAD 持续 90 自然日 ——
 *         覆盖大部分准时披露公司的 alpha 区间，过滤掉拖延披露的尾部噪音。
 *         升级路径：FinancialReport 引入 announce_date 字段后改成
 *         `tradingDaysBetween(announce_date, as_of_date) ≤ 60`。
 *
 *   按 CLAUDE.md "代理替代范式"：
 *     - factor.name = 'earnings_surprise' 保留 AC 命名（不加 _proxy / _v0 后缀，
 *       避免污染 Registry 命名空间）。
 *     - description 显式标注 "代理" 字样。
 *     - 本 jsdoc 顶部即列出 (a) AC 原始公式 (b) 当前不可得字段 (c) 选定代理与系数
 *       (d) 升级路径 —— 让下游策略接入此因子时一眼看到代理边界。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 计算流程（per stock）：
 *   1. 取该股票"最近一份" FinancialReport with report_date ≤ as_of_date AND
 *      (as_of_date - report_date) ≤ POST_REPORT_WINDOW_DAYS。
 *      不限 report_type（年报/半年报/一季报/三季报均可），偏好 report_date 最新者。
 *      没有则跳过（财报太旧或未发布 → 因子不适用）。
 *   2. 在 [report_date - CONSENSUS_LOOKBACK_DAYS, report_date) 区间内查
 *      AnalystForecast（注意 < report_date，分析师必须在公司报告 *之前* 发研报，
 *      否则就不是 forecast 是 review），并要求 forecast_year_y1 = year(report_date)
 *      （同年度才有可比性，跨年度 EPS 比较没意义 — 见 US-030 同款约束）。
 *      不足 MIN_CONSENSUS_REPORTS（默认 3 份）→ 跳过（横截面太稀疏）。
 *      取均值作为 consensus_eps_avg。
 *   3. 在 [report_date, report_date + ACTUAL_EPS_LOOKAHEAD_DAYS] 区间内查
 *      StockFundamentalFactor.eps，优先匹配 report_period = report_date_str，
 *      回退到 factor_date 最早（最接近公告日的 EPS 数据）。没有则跳过。
 *   4. consensus_eps_avg 绝对值过小（|x| < CONSENSUS_NEAR_ZERO_THRESHOLD，默认 0.01
 *      元/股 = 1 分钱）→ 跳过（亏损股 / 微利股 EPS 接近 0，分母放大噪音爆炸）。
 *   5. surprise = (actual_eps - consensus_eps_avg) / |consensus_eps_avg|；非有限数
 *      （NaN / ±Infinity）→ 跳过。
 *
 * 失效（不入 Map → Pipeline 中性补全 raw_value=null / z_score=0 / percentile=0.5）：
 *   - 最近一份财报 stale（distance > POST_REPORT_WINDOW_DAYS）— 财报太旧 surprise 已被消化
 *   - 财报前 N 日窗口内研报数 < MIN_CONSENSUS_REPORTS — 卖方覆盖太少无统计意义
 *   - 没有同期 actual eps（StockFundamentalFactor 缺数据） — 实际值不可用
 *   - |consensus_eps_avg| < CONSENSUS_NEAR_ZERO_THRESHOLD — 亏损股 分母噪音
 *   - 任一中间计算非有限数
 *
 * 关于"因子不做归一化"约束 #1：
 *   - 本因子是 **绝对业务量**（per-stock 自身 actual vs consensus 之比），不参照
 *     横截面统计 — 走标准模式（不属 LiquidityFactor 横截面参照例外）。
 *     Pipeline 后续仍做 winsorize + zscore 跨因子归一化，保证可比性。
 *
 * 与既有因子的关系：
 *   - AnalystConsensusFactor (US-030)：捕捉 **预期变化**（事前，研报频次驱动）。
 *     高分 = 分析师近 30 日把 EPS 预测上调（看好基本面）。
 *   - EarningsSurpriseFactor (US-032，本因子)：捕捉 **实际超预期**（事后，
 *     actual vs forecast 的 surprise）。高分 = 实际 EPS 超过卖方共识。
 *   - 二者互补：前者预测拐点早，后者验证拐点真伪；都登记 sentiment 类
 *     —— FactorIC (US-041) 若发现高度相关 (|r| > 0.7) 再考虑剔除一个。
 *   - QualityFactor / QualityHighFactor 是"稳态盈利"维度，与 surprise（拐点）正交。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { AnalystForecast } from '../../../models/AnalystForecast';
import { FinancialReport } from '../../../models/FinancialReport';
import { StockFundamentalFactor } from '../../../models/StockFundamentalFactor';
import { stripSuffix, isFiniteNumber, lookbackStartDate } from './_helpers';

/**
 * 财报"新鲜窗口"：报告期末后 N 自然日内 actual 仍视为"surprise 可定价"区间。
 * 默认 180 自然日 = ~90 自然日 announce delay 上限 + ~90 自然日 PEAD drift。
 * （详见文件顶部 jsdoc"代理替代范式 (b)"）
 */
export const POST_REPORT_WINDOW_DAYS = 180;

/**
 * 在财报期之前回看多少自然日构造 consensus —— 1 ~ 6 个月内的研报均值。
 * 太短：研报不足 MIN_CONSENSUS_REPORTS；太长：跨年度 / 跨更早预期窗。
 * 默认 180 自然日（覆盖整个上一半年的研报上修周期）。
 */
export const CONSENSUS_LOOKBACK_DAYS = 180;

/** consensus 构造的最低研报数门槛 */
export const MIN_CONSENSUS_REPORTS = 3;

/**
 * 取 actual EPS 时在 report_date 之后的搜索窗口（自然日）。
 * 用于查 StockFundamentalFactor.eps —— actual EPS 数据通常在公告日入库，
 * 即报告期末 + 60~120 自然日。
 */
export const ACTUAL_EPS_LOOKAHEAD_DAYS = 150;

/**
 * consensus_eps_avg 绝对值小于此阈值视为"接近零"，跳过该股票避免分母放大噪音。
 * 单位：元/股；0.01 = 1 分钱 = 微利 / 亏损股 EPS 边缘。
 */
export const CONSENSUS_NEAR_ZERO_THRESHOLD = 0.01;

// ---------------------------------------------------------------------------
// 纯函数 helpers (抽 export 供单测独立调用 — 模式来自 US-029 LiquidityFactor /
// US-030 AnalystConsensusFactor / US-031 QualityHighFactor)
// ---------------------------------------------------------------------------

/** 算术均值；空数组返回 0 */
export function mean(values: number[]): number {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** 给定 ISO 日期 (YYYY-MM-DD) + 自然日，返回 isoDate 字符串 */
export function isoDateMinusDays(asOfDate: string, days: number): string {
  const d = new Date(`${asOfDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.max(0, days));
  return d.toISOString().slice(0, 10);
}

/** 给定 ISO 日期 (YYYY-MM-DD) + 自然日，返回 isoDate 字符串（向后偏移） */
export function isoDatePlusDays(asOfDate: string, days: number): string {
  const d = new Date(`${asOfDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(0, days));
  return d.toISOString().slice(0, 10);
}

/** 给定 ISO 日期，提取年份数字（2024-12-31 → 2024）；非法格式返回 null */
export function yearOfIsoDate(isoDate: string): number | null {
  if (!isoDate || typeof isoDate !== 'string') return null;
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(isoDate);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
}

/**
 * 给定 (actual_eps, consensus_eps_avg) 计算 surprise 因子原始值。
 *
 * - 任一输入非有限 → null
 * - |consensus| < threshold → null（避免 / 0 爆炸）
 * - 返回 (actual - consensus) / |consensus|，正值表示超预期
 */
export function computeSurprise(
  actualEps: number | null | undefined,
  consensusEps: number | null | undefined,
  nearZeroThreshold: number = CONSENSUS_NEAR_ZERO_THRESHOLD
): number | null {
  if (actualEps === null || actualEps === undefined) return null;
  if (consensusEps === null || consensusEps === undefined) return null;
  const act = typeof actualEps === 'number' ? actualEps : Number(actualEps);
  const cons = typeof consensusEps === 'number' ? consensusEps : Number(consensusEps);
  if (!isFiniteNumber(act) || !isFiniteNumber(cons)) return null;
  if (Math.abs(cons) < nearZeroThreshold) return null;
  const v = (act - cons) / Math.abs(cons);
  if (!isFiniteNumber(v)) return null;
  return v;
}

/**
 * 在一组财报记录里挑出"最近且新鲜"的一份。
 *
 * - 必须满足 report_date ≤ as_of_date AND (as_of_date - report_date) ≤ windowDays
 * - 多份满足时取 report_date 最大（最新）
 * - 输入空 / 全 stale → null
 */
export interface ReportLike {
  report_date: string;
  report_type?: string | null;
}

export function selectFreshestReport(
  reports: ReportLike[],
  asOfDate: string,
  windowDays: number = POST_REPORT_WINDOW_DAYS
): ReportLike | null {
  if (!reports.length) return null;
  const cutoff = isoDateMinusDays(asOfDate, windowDays);
  let best: ReportLike | null = null;
  for (const r of reports) {
    if (!r.report_date) continue;
    if (r.report_date > asOfDate) continue; // 防 lookahead bias
    if (r.report_date < cutoff) continue; // 太旧 stale
    if (best === null || r.report_date > best.report_date) best = r;
  }
  return best;
}

/**
 * 给定股票 forecast 记录（含 report_date / forecast_eps_y1 / forecast_year_y1）+
 * 该股票的 actual report_date_str，挑出符合 consensus 构造条件的记录并算均值。
 *
 * 条件：
 *   - forecast.report_date < actualReportDate（严格小于 — 分析师在公司报告 *之前*
 *     发研报才算 forecast，否则是事后 review）
 *   - forecast.report_date >= actualReportDate - lookbackDays
 *   - forecast.forecast_year_y1 == year(actualReportDate)（同年度才可比，
 *     US-030 同款约束 — 跨年度 EPS 比较无意义）
 *   - forecast.forecast_eps_y1 必须有限
 *
 * 不足 minReports → null（横截面太稀疏无统计意义）
 */
export interface ForecastRecord {
  report_date: string;
  forecast_eps_y1: number | null | undefined;
  forecast_year_y1: number | null | undefined;
}

export function buildConsensusEps(
  forecasts: ForecastRecord[],
  actualReportDate: string,
  lookbackDays: number = CONSENSUS_LOOKBACK_DAYS,
  minReports: number = MIN_CONSENSUS_REPORTS
): number | null {
  if (!forecasts.length || !actualReportDate) return null;
  const targetYear = yearOfIsoDate(actualReportDate);
  if (targetYear === null) return null;
  const cutoff = isoDateMinusDays(actualReportDate, lookbackDays);
  const eligible: number[] = [];
  for (const f of forecasts) {
    if (!f.report_date) continue;
    if (f.report_date >= actualReportDate) continue; // 必须 < 财报期
    if (f.report_date < cutoff) continue;
    const yr = f.forecast_year_y1;
    if (yr === null || yr === undefined || Number(yr) !== targetYear) continue;
    const eps = f.forecast_eps_y1;
    if (eps === null || eps === undefined) continue;
    const v = typeof eps === 'number' ? eps : Number(eps);
    if (!isFiniteNumber(v)) continue;
    eligible.push(v);
  }
  if (eligible.length < minReports) return null;
  return mean(eligible);
}

// ---------------------------------------------------------------------------
// Factor 主体
// ---------------------------------------------------------------------------

export const earningsSurpriseFactor: Factor = {
  name: 'earnings_surprise',
  description:
    '盈利惊喜代理：(actual_eps - consensus_eps_avg) / |consensus_eps_avg|；actual 取 StockFundamentalFactor.eps，consensus 取 AnalystForecast.forecast_eps_y1 同年度均值；仅在最近财报 180 自然日内生效（announce_date 不可得，用 report_date + window 代理）',
  category: 'event',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // ----- 1) FinancialReport：拉近 POST_REPORT_WINDOW_DAYS 内的所有报告 -----
    //
    // FinancialReport.stock_code 已经是无后缀形式（与 ctx.universe 一致）。
    // 不限 report_type — 让 selectFreshestReport 挑最新一份。
    const reportStartDate = lookbackStartDate(ctx.as_of_date, POST_REPORT_WINDOW_DAYS);
    const reportRows = (await FinancialReport.findAll({
      attributes: ['stock_code', 'report_date', 'report_type'],
      where: {
        stock_code: { [Op.in]: ctx.universe },
        report_date: { [Op.gte]: reportStartDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      report_date: string;
      report_type: string | null;
    }>;

    if (!reportRows.length) return out; // 全市场近 180 日内无任何财报 — 早返回

    // 按 stock_code 分组 → 挑 freshest 一份
    const freshestByCode = new Map<string, ReportLike>();
    {
      const byCode = new Map<string, ReportLike[]>();
      for (const r of reportRows) {
        const arr = byCode.get(r.stock_code) ?? [];
        arr.push({ report_date: r.report_date, report_type: r.report_type });
        byCode.set(r.stock_code, arr);
      }
      for (const [code, arr] of byCode.entries()) {
        const freshest = selectFreshestReport(arr, ctx.as_of_date);
        if (freshest) freshestByCode.set(code, freshest);
      }
    }

    if (!freshestByCode.size) return out;

    // ----- 2) AnalystForecast：拉 consensus 窗口内的研报 -----
    //
    // consensus 窗口最早起点 = min(freshestByCode.report_date) - CONSENSUS_LOOKBACK_DAYS。
    // 一次性查全部 universe stock 的研报，TS 端按 stock + report_date 切片。
    let consensusStart = ctx.as_of_date;
    for (const r of freshestByCode.values()) {
      const earliest = isoDateMinusDays(r.report_date, CONSENSUS_LOOKBACK_DAYS);
      if (earliest < consensusStart) consensusStart = earliest;
    }

    const codesWithReport = Array.from(freshestByCode.keys());
    const forecastRows = (await AnalystForecast.findAll({
      attributes: ['stock_code', 'report_date', 'forecast_eps_y1', 'forecast_year_y1'],
      where: {
        stock_code: { [Op.in]: codesWithReport },
        // 上限取 as_of_date（防 lookahead）；下限取 consensusStart 兜底
        report_date: { [Op.gte]: consensusStart, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      report_date: string;
      forecast_eps_y1: any;
      forecast_year_y1: any;
    }>;

    const forecastsByCode = new Map<string, ForecastRecord[]>();
    for (const f of forecastRows) {
      const eps = f.forecast_eps_y1 == null ? null : Number(f.forecast_eps_y1);
      const yr = f.forecast_year_y1 == null ? null : Number(f.forecast_year_y1);
      const arr = forecastsByCode.get(f.stock_code) ?? [];
      arr.push({
        report_date: f.report_date,
        forecast_eps_y1: isFiniteNumber(eps as number) ? (eps as number) : null,
        forecast_year_y1: yr != null && Number.isFinite(yr) ? yr : null,
      });
      forecastsByCode.set(f.stock_code, arr);
    }

    // ----- 3) StockFundamentalFactor：拉 actual eps -----
    //
    // 注意：StockFundamentalFactor.symbol 带后缀 "600519.SH"；
    // 需要 stripSuffix 才能与 ctx.universe 对齐。
    // 时间窗 = 所有 freshest report_date 的 [report_date, report_date + ACTUAL_EPS_LOOKAHEAD_DAYS]
    // 的并集；为简化查询直接用全局并集 [minReportDate, maxReportDate + lookahead]，
    // 内存里再按 per-stock 精确过滤。
    let actualMinDate = ctx.as_of_date;
    let actualMaxDate = ctx.as_of_date;
    for (const r of freshestByCode.values()) {
      if (r.report_date < actualMinDate) actualMinDate = r.report_date;
      const upper = isoDatePlusDays(r.report_date, ACTUAL_EPS_LOOKAHEAD_DAYS);
      if (upper > actualMaxDate) actualMaxDate = upper;
    }
    // 上限不能超过 as_of_date（防 lookahead bias —— 因子 ctx 里的"今天"是 as_of_date，
    // 不能用 as_of_date 之后才出现的数据）
    if (actualMaxDate > ctx.as_of_date) actualMaxDate = ctx.as_of_date;

    const universeSet = new Set(ctx.universe);
    const fundamentalRows = (await StockFundamentalFactor.findAll({
      attributes: ['symbol', 'factor_date', 'report_period', 'eps'],
      where: {
        factor_date: { [Op.gte]: actualMinDate, [Op.lte]: actualMaxDate },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      report_period: string | null;
      eps: any;
    }>;

    // 按无后缀 stock_code 分组，记录 [factor_date, report_period, eps]
    interface FundamentalRecord {
      factor_date: string;
      report_period: string | null;
      eps: number;
    }
    const fundByCode = new Map<string, FundamentalRecord[]>();
    for (const r of fundamentalRows) {
      const code = stripSuffix(r.symbol);
      if (!universeSet.has(code)) continue;
      const eps = r.eps == null ? null : Number(r.eps);
      if (!isFiniteNumber(eps as number)) continue;
      const arr = fundByCode.get(code) ?? [];
      arr.push({ factor_date: r.factor_date, report_period: r.report_period, eps: eps as number });
      fundByCode.set(code, arr);
    }

    // ----- 4) per-stock 合成：consensus + actual → surprise -----
    for (const [code, freshest] of freshestByCode.entries()) {
      const forecasts = forecastsByCode.get(code) ?? [];
      if (forecasts.length === 0) continue;

      const consensus = buildConsensusEps(forecasts, freshest.report_date);
      if (consensus === null) continue;

      // actual_eps：从 fundamental 记录中挑
      //   首选：report_period 精确匹配 freshest.report_date（同期口径）
      //   回退：factor_date >= report_date 的最早一条（最接近公告日的 actual）
      const fundRecords = fundByCode.get(code) ?? [];
      let actual: number | null = null;
      // 首选：report_period 精确匹配
      for (const f of fundRecords) {
        if (f.report_period === freshest.report_date) {
          actual = f.eps;
          break;
        }
      }
      // 回退：factor_date >= report_date 的最早一条
      if (actual === null) {
        let bestDate: string | null = null;
        for (const f of fundRecords) {
          if (f.factor_date < freshest.report_date) continue;
          if (bestDate === null || f.factor_date < bestDate) {
            bestDate = f.factor_date;
            actual = f.eps;
          }
        }
      }
      if (actual === null) continue;

      const surprise = computeSurprise(actual, consensus);
      if (surprise === null) continue;
      out.set(code, surprise);
    }

    return out;
  },
};

factorRegistry.register(earningsSurpriseFactor);
