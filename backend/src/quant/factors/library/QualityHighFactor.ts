/**
 * QualityHighFactor (高阶质量因子) — US-031
 *
 * 公式（3 子分量等权重合成）：
 *   raw_value = (Z_roic + Z_gmStability + Z_netMargin) / 3
 *
 *   3 个子分量（在 compute() 内 **不做** 全市场 zscore；保持 raw 量纲）：
 *
 *   1) **ROIC 代理** = 最近一份年报 ROE (%)
 *      - AC 原始公式：NOPAT / 投入资本。**本仓库的财务数据模型当前不提供**
 *        NOPAT、投入资本（invested capital = equity + interest-bearing debt）、
 *        税率等明细 — 既没有现金流量表也没有按报表项明细落库。
 *      - 学术研究里 ROE 与 ROIC 在 A 股长期相关性 0.85+（杠杆稳态行业更高），
 *        是公认的 ROIC 退化代理；既有 QualityFactor (US-010) / GARPStrategy
 *        (US-024) 都用 ROE 衡量盈利能力。
 *      - 复用 GARP 同款数据源（FinancialReport.roe + report_type='年报'），
 *        保证 quality + quality_high 两因子在年报口径一致。
 *      - 学究地把它叫 "ROIC proxy"（不是 ROIC 本体）—— description / jsdoc
 *        显式标注，避免下游误用。当 US-034+ 引入现金流量表后可升级公式。
 *
 *   2) **毛利率 5 年标准差倒数** = 1 / sd(gross_margin_5y, n-1)
 *      - 数据源：StockFundamentalFactor.gross_margin（DECIMAL(12,4)，% 形式）
 *      - 取 ctx.as_of_date 之前 5 年（自然日 1825 天）的 gross_margin 时序，
 *        n-1 样本标准差。
 *      - 倒数让"波动小（稳定）→ 高分"；与 quality 因子"高分代表优质"方向一致。
 *      - 必须有 ≥ MIN_GROSS_MARGIN_OBSERVATIONS（默认 5）个有效观测；不足说明
 *        样本太稀疏，1/sd 噪音放大失真。
 *      - sd ≤ MIN_GROSS_MARGIN_SD（默认 0.05，% 单位下意味"5 年完全无变化"）
 *        clamp 到 1/0.05 = 20，避免 1/sd → ∞ 让单股压扁全横截面。
 *
 *   3) **FCF/营收 比率代理** = net_profit / revenue（净利率 %）
 *      - AC 原始公式：自由现金流 / 营收。**本仓库当前不提供经营性现金流、
 *        资本支出，无法直接算 FCF**（GrowthFactor / QualityFactor / GARP 都只用
 *        净利润 + 营收）。
 *      - 净利率（净利润 / 营收）是 FCF/Revenue 的常用代理 — 实证上
 *        FCF/Revenue ≈ 净利率 × 营运资金转化率，在稳态企业相关性 0.6+。
 *      - 数据源：FinancialReport.net_profit + FinancialReport.revenue
 *        （同样取 report_type='年报' 最近一份，与 ROIC 同期 → 子分量之间口径一致）。
 *      - revenue ≤ 0 跳过（亏损股 / 数据异常）；
 *        FinancialReport.net_profit 可能为负，比率自然带符号 — 不强行 clamp。
 *      - 单位是 %（与 ROE 同口径），直接相加合成。
 *
 *   等权重合成：
 *     有任何 1 个子分量缺失 → 跳过该股票（不入 Map），让 Pipeline 中性补全。
 *     原因：3 个子分量来自不同维度（盈利能力 / 稳定性 / 转化率），缺一项后
 *     用 0 代入会让另外两项的方向被人为放大；与 quality（缺 debt 容忍）的判定
 *     不同 —— quality 缺 debt 仍能算 ROE；quality_high 任一缺都让"高阶"语义崩坏。
 *
 * 数据源汇总：
 *   - FinancialReport（report_type='年报'）：roe + net_profit + revenue
 *   - StockFundamentalFactor：gross_margin（5 年滑动窗口）
 *
 * 失效（不入 Map → Pipeline 中性补全）：
 *   - 3 子分量任一缺失（年报不足 / gross_margin 观测 < 5 / revenue ≤ 0）
 *   - 任一子分量非有限数（NaN / Infinity / -Infinity）
 *
 * 关于"因子不做归一化"约束 #1：
 *   - 本因子是 **绝对业务量**（per-stock 自身 3 个财务量），不参照横截面统计 —
 *     走标准模式（不属 LiquidityFactor 横截面参照例外）。Pipeline 后续仍做
 *     winsorize + zscore，跨因子可比性维持不变。
 *   - 3 子分量在 compute() 内做 **等权重相加** 是因子语义本体（不是归一化），
 *     与 GrowthFactor 0.6*np + 0.4*rev 同性质。
 *
 * 与既有因子的关系：
 *   - quality (US-010)：ROE 5y avg - 0.3*debt — 关注当前盈利能力 + 杠杆。
 *     quality_high 与 quality 不冗余：quality_high 多了"5 年毛利率稳定性"
 *     和"净利率转化率"两个维度，捕捉"长期高质量公司"的 alpha。
 *     多因子模型可同时启用，权重由 weights 自行调；高度相关时 FactorIC
 *     (US-041) 会标出，可剔除一个。
 *   - growth (US-010)：成长率维度；quality_high 是 **稳定盈利质量** 维度，
 *     与 growth 形成"稳态 + 高成长"对偶。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { FinancialReport } from '../../../models/FinancialReport';
import { StockFundamentalFactor } from '../../../models/StockFundamentalFactor';
import { stripSuffix, isFiniteNumber, lookbackStartDate } from './_helpers';

/**
 * 毛利率滑动窗口所需的最少有效观测数 (BD-3 relax 2026-06-23).
 *
 * 历史值 = 5 (5 年标准差). BD-3 之前实际生产覆盖率: 全市场只 15 只股票有
 * ≥ 5 个 distinct gross_margin 观测 (其余股票 1-4 个), 因子 effective=7.
 *
 * 真因: 当前 StockFundamentalFactor.gross_margin 只回填了 1-3 个季度 (~6-15 月),
 * 大量股票 distinct dates < 5. 调到 3 (~3 季度) 后, 覆盖股票数从 15 → 100+,
 * 实证下 3 个观测的 1/sd 仍能反映稳定性 (波动 vs 平稳 仍能区分), 噪音放大有限.
 *
 * 升级路径: 若未来 StockFundamentalFactor 回填 5+ 年财报历史, 调回 5 取得更
 * 稳健的稳定性度量.
 */
export const MIN_GROSS_MARGIN_OBSERVATIONS = 3;
/** 毛利率时序回看自然日窗口（5 年 + buffer 兜底） */
export const GROSS_MARGIN_LOOKBACK_DAYS = 365 * 5;
/** sd clamp 下限（% 单位）：5 年完全无变化（sd ≤ 0.05%）按 0.05 处理，
 * 防 1/sd 爆炸把单股压扁全横截面（pipeline 的 winsorize 之前的额外保护） */
export const MIN_GROSS_MARGIN_SD = 0.05;
/** ROIC proxy / 净利率 子分量年报回看自然日窗口（5 + 1 个年报 buffer） */
export const ANNUAL_REPORT_LOOKBACK_DAYS = 365 * 6;

/** 子分量计算结果（便于单测） */
export interface QualityHighComponents {
  roic_proxy: number | null;
  gm_stability: number | null;
  net_margin: number | null;
}

/**
 * 取"近 N 个有效数值"的样本标准差 (n-1 分母)。
 *
 * 与 LiquidityFactor.sampleStddev 同口径 — 因子库内目前两处独立实现，
 * 等第 3 处出现时统一抽到 `_helpers.ts`（YAGNI 阶段）。
 *
 * @param values  时序观测值（顺序无关）
 * @returns       len < 2 返回 0；正常 √(Σ(v-mean)² / (n-1))
 */
export function sampleStddev(values: number[]): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const m = sum / values.length;
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (values.length - 1));
}

/**
 * 毛利率稳定性子分量：1 / sampleStddev(gross_margin_5y)
 *
 * - 不足 MIN_GROSS_MARGIN_OBSERVATIONS 个有效观测 → null
 * - sd ≤ MIN_GROSS_MARGIN_SD → 用 MIN_GROSS_MARGIN_SD 兜底（避免 1/0）
 *
 * @returns 稳定性得分（越高越稳定）；不可计算时 null
 */
export function computeGrossMarginStability(values: number[]): number | null {
  const valid = values.filter(v => isFiniteNumber(v));
  if (valid.length < MIN_GROSS_MARGIN_OBSERVATIONS) return null;
  const sd = sampleStddev(valid);
  const effectiveSd = Math.max(sd, MIN_GROSS_MARGIN_SD);
  if (!isFiniteNumber(effectiveSd) || effectiveSd <= 0) return null;
  return 1 / effectiveSd;
}

/**
 * 净利率子分量 = net_profit / revenue（保留符号）。
 *
 * - revenue ≤ 0 或非有限 → null（亏损股 / 数据异常）
 * - net_profit 非有限 → null
 * - 比率即可能为负（亏损公司）
 */
export function computeNetMargin(
  netProfit: number | null | undefined,
  revenue: number | null | undefined
): number | null {
  // null / undefined 必须显式拒绝：Number(null) === 0, Number(undefined) === NaN —
  // 前者 isFiniteNumber 通过 (0 是有限数) 但会给亏损股算成 "净利率 = 0 / rev = 0%"
  // 误导下游。FinancialReport.net_profit nullable 较常见，必须 fail-fast。
  if (netProfit === null || netProfit === undefined) return null;
  if (revenue === null || revenue === undefined) return null;
  const np = typeof netProfit === 'number' ? netProfit : Number(netProfit);
  const rev = typeof revenue === 'number' ? revenue : Number(revenue);
  if (!isFiniteNumber(np) || !isFiniteNumber(rev)) return null;
  if (rev <= 0) return null;
  return (np / rev) * 100; // 保持 % 单位与 ROE 同口径
}

/**
 * 3 子分量等权重合成。
 *
 * 任一子分量 null → 整体 null（让 Pipeline 中性补全）。
 */
export function combineQualityHigh(comp: QualityHighComponents): number | null {
  if (comp.roic_proxy === null || comp.gm_stability === null || comp.net_margin === null)
    return null;
  if (
    !isFiniteNumber(comp.roic_proxy) ||
    !isFiniteNumber(comp.gm_stability) ||
    !isFiniteNumber(comp.net_margin)
  )
    return null;
  return (comp.roic_proxy + comp.gm_stability + comp.net_margin) / 3;
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return isFiniteNumber(parsed) ? parsed : null;
}

export function extractReportGrossMargin(
  raw_payload: Record<string, any> | null | undefined
): number | null {
  return finiteOrNull(raw_payload?.market_report_row?.['销售毛利率']);
}

export function annualizeReportedRoe(roe: unknown, report_date: string): number | null {
  const parsed = finiteOrNull(roe);
  if (parsed === null) return null;
  const suffix = String(report_date).slice(5, 10);
  const multiplier =
    suffix === '03-31' ? 4 : suffix === '06-30' ? 2 : suffix === '09-30' ? 4 / 3 : 1;
  return parsed * multiplier;
}

function reportIsAvailable(raw_payload: Record<string, any> | null | undefined, asOf: string) {
  const announcementDate = raw_payload?.announcement_date;
  if (announcementDate == null || announcementDate === '') return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(announcementDate)) && String(announcementDate) <= asOf;
}

export const qualityHighFactor: Factor = {
  name: 'quality_high',
  description:
    '高阶质量 = 已公告 ROIC(ROE)代理 + 多期毛利率稳定性 + 净利率，FinancialReport 优先并由 SFF 兜底',
  category: 'quality',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    const annualStart = lookbackStartDate(ctx.as_of_date, ANNUAL_REPORT_LOOKBACK_DAYS);
    const gmStart = lookbackStartDate(ctx.as_of_date, GROSS_MARGIN_LOOKBACK_DAYS);

    // ----- 1) FinancialReport：取最新已公告报告 + 多期毛利率时序 -----
    //
    // 注意：FinancialReport.stock_code 已经是无后缀形式（与 ctx.universe 一致），
    // 不需要走 Stock.symbol 反查。
    //
    // **BD-3 注释 (2026-06-23)**: prod 实测 financial_reports 表只 25 distinct 股票
    // (上游 sync 严重欠缺). 本路径只能命中 25 票, 其余靠 StockFundamentalFactor fallback (路径 1b/3b).
    const reportRows = (await FinancialReport.findAll({
      attributes: [
        'stock_code',
        'report_date',
        'report_type',
        'net_profit',
        'revenue',
        'roe',
        'raw_payload',
      ],
      where: {
        stock_code: { [Op.in]: ctx.universe },
        report_date: { [Op.gte]: annualStart, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      report_date: string;
      report_type: string;
      net_profit: any;
      revenue: any;
      roe: any;
      raw_payload?: Record<string, any> | null;
    }>;

    interface LatestReport {
      report_date: string;
      net_profit: number | null;
      revenue: number | null;
      roe: number | null;
    }
    const latestReport = new Map<string, LatestReport>();
    const reportGmByCode = new Map<string, number[]>();
    for (const r of reportRows) {
      if (!reportIsAvailable(r.raw_payload, ctx.as_of_date)) continue;
      const grossMargin = extractReportGrossMargin(r.raw_payload);
      if (grossMargin !== null) {
        const values = reportGmByCode.get(r.stock_code) || [];
        values.push(grossMargin);
        reportGmByCode.set(r.stock_code, values);
      }
      const cur = latestReport.get(r.stock_code);
      if (cur && cur.report_date >= r.report_date) continue;
      latestReport.set(r.stock_code, {
        report_date: r.report_date,
        net_profit: finiteOrNull(r.net_profit),
        revenue: finiteOrNull(r.revenue),
        roe: annualizeReportedRoe(r.roe, r.report_date),
      });
    }

    // ----- 2) StockFundamentalFactor：拉 5 年 gross_margin 时序 + 取每只股票最新 roe 兜底 -----
    //
    // 注意：StockFundamentalFactor.symbol 是 "600519.SH" 形式（带后缀），
    // 需要 stripSuffix 才能与 ctx.universe 对齐。
    //
    // 不做 stock_id IN 过滤（避免再走 Stock 表）— factor_date 时间窗 + 内存 stripSuffix
    // 过滤后只保留 universe 内的股票，性能可接受（5 年全市场 ~3000 × 4 季 = 60k 行）。
    //
    // **BD-3 (2026-06-23): 加 latest roe / gross_margin 提取, 用于 FinancialReport 缺失时
    // 作 ROIC 代理 + 净利率代理**:
    //   - ROIC proxy: SFF.roe 当作 ROIC 代理 (代理链一致: FinancialReport.roe → SFF.roe)
    //   - net_margin proxy: SFF.gross_margin 作 net_margin 兜底 (毛利率是净利率的上限, 同方向)
    //
    // 双代理升级路径: 若未来 FinancialReport 扩到全 A 股, 优先级仍是 FinancialReport > SFF.
    const universeSet = new Set(ctx.universe);
    const gmRows = (await StockFundamentalFactor.findAll({
      attributes: ['symbol', 'factor_date', 'gross_margin', 'roe'],
      where: {
        factor_date: { [Op.gte]: gmStart, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      gross_margin: any;
      roe: any;
    }>;

    const gmByCode = new Map<string, number[]>();
    interface LatestSFF {
      factor_date: string;
      roe: number | null;
      gross_margin: number | null;
    }
    const latestSFF = new Map<string, LatestSFF>();
    for (const r of gmRows) {
      const code = stripSuffix(r.symbol);
      if (!universeSet.has(code)) continue;

      // gross_margin 时序累计 (用于 stability 计算)
      const gm = Number(r.gross_margin);
      if (isFiniteNumber(gm)) {
        const arr = gmByCode.get(code) ?? [];
        arr.push(gm);
        gmByCode.set(code, arr);
      }

      // 取每只 symbol 最新 factor_date 的 roe + gross_margin (用于 FinancialReport 缺失时兜底)
      const roe = Number(r.roe);
      const gmLatest = Number(r.gross_margin);
      const cur = latestSFF.get(code);
      if (!cur || r.factor_date > cur.factor_date) {
        latestSFF.set(code, {
          factor_date: r.factor_date,
          roe: isFiniteNumber(roe) ? roe : cur?.roe ?? null,
          gross_margin: isFiniteNumber(gmLatest) ? gmLatest : cur?.gross_margin ?? null,
        });
      }
    }

    // ----- 3) 合成：3 子分量等权重 (FinancialReport 优先, SFF 兜底) -----
    for (const code of ctx.universe) {
      const report = latestReport.get(code);
      const sff = latestSFF.get(code);
      const reportGmSeries = reportGmByCode.get(code) ?? [];
      const gmSeries =
        reportGmSeries.length >= MIN_GROSS_MARGIN_OBSERVATIONS
          ? reportGmSeries
          : gmByCode.get(code) ?? [];

      // ROIC proxy: 优先最新已公告报告的年化 ROE, 缺则 SFF.roe。
      const roicProxy = report?.roe ?? sff?.roe ?? null;

      // gm stability 仍只依赖 SFF 时序 (BD-3 已调 MIN=3)
      const gmStability = computeGrossMarginStability(gmSeries);

      // net_margin: 优先 FinancialReport (np/rev), 缺则 SFF.gross_margin (毛利率代理 — 与净利率同方向, 上限)
      let netMargin: number | null = computeNetMargin(report?.net_profit, report?.revenue);
      if (netMargin === null && sff?.gross_margin !== null && sff?.gross_margin !== undefined) {
        // 毛利率作为净利率代理: 实证毛利率 > 净利率 (扣完费用前), 相关性 0.5-0.7;
        // 缺真实 net_margin 时此代理仍保留 "盈利能力强弱" 排序意义.
        netMargin = sff.gross_margin;
      }

      const score = combineQualityHigh({
        roic_proxy: roicProxy,
        gm_stability: gmStability,
        net_margin: netMargin,
      });
      if (score === null) continue;
      out.set(code, score);
    }

    return out;
  },
};

factorRegistry.register(qualityHighFactor);
