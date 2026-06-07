/**
 * EastMoneyQAFactor (东财问答热度因子 / 散户关注度变化) — US-034
 *
 * 公式：raw_value = avg(post_count[asOf-RECENT_WINDOW_DAYS+1 .. asOf])
 *                  / avg(post_count[asOf-TOTAL_WINDOW_DAYS+1 .. asOf])
 *
 *   - RECENT_WINDOW_DAYS = 5  自然日窗口（最近一周散户关注度）
 *   - TOTAL_WINDOW_DAYS  = 30 自然日窗口（基线参照）
 *
 *   - 比率 > 1 → 近 5 日散户关注度高于 30 日均值 → 热度上升
 *   - 比率 < 1 → 近 5 日散户关注度低于 30 日均值 → 热度回落
 *   - 比率 = 1 → 关注度稳定
 *
 *   - 越高得分越高（典型散户跟踪因子；alpha 来源："散户开始关注 → 短期资金涌入 →
 *     1-3 周内股价上涨"，但持续高位过热 = 顶部信号，需配合 LowVol / Liquidity
 *     做风险控制——本因子只输出 raw_value，组合后的 alpha 判定留给多因子层）。
 *
 * 数据源：StockSentiment 表（US-034 同步入库）
 *   - PK (trade_date, stock_code)
 *   - 关键字段：post_count（AC 字段；本仓库中实为 1/rank × 100000 的代理 — 详见
 *     StockSentiment 模型 docstring 与 backend/python/akshare_helper.py
 *     get_stock_sentiment）
 *
 * ── 关于 AC "post_count" 字段的代理记号 (US-031 范式) ──
 *
 *   AC 期望的 post_count = 东方财富股吧每日发帖数；该字段在 AKShare 公开 API
 *   中**完全不可得** (stock_guba_em 不存在，guba 网页无 API)。本仓库的
 *   post_count 列实为 **round(100000 / EastMoney 人气榜排名)** 的代理：
 *
 *     - factor.name 保留 AC 命名 (`east_money_qa`)，不污染 Registry 命名空间
 *     - description 与本 jsdoc 显式标注"代理"字样
 *     - 升级路径：若未来引入真实股吧 post_count 数据源 (XQ / TuShare Pro / Wind)，
 *       直接在 sync 阶段填入 StockSentiment.post_count 列，因子层无需改动
 *       —— post_count 是物化字段，因子读的是 column 不是源。
 *
 *   理论根据：股吧发帖数与 EastMoney 人气榜排名高度相关（rank 是综合
 *   click/post/favorite/search 后的排序结果），rank 倒数是 post_count 的
 *   合理代理；5d/30d 比率因比例对偏差更鲁棒（线性偏差被相消）。
 *
 * 失效（不入 Map，让 Pipeline 中性补全）：
 *   - 该股票在窗口内有效观测 < MIN_OBSERVATIONS_TOTAL (10) → 跳过（次新股 / 北交所
 *     冷门股普遍不在 EastMoney 人气榜，rank 缺失）
 *   - recent 窗口（近 5 日）有效观测 = 0 → 跳过
 *   - baseline 窗口（5-30 日前）有效观测 = 0 → 跳过
 *   - baseline avg ≈ 0 (BASELINE_ZERO_THRESHOLD = 1.0) → 跳过（avoid 比率爆炸）
 *
 * 关于"因子不做归一化"约束 #1 (factors/CLAUDE.md)：
 *   - 本因子计算的 raw_value 是"5d/30d 自身比率"，是 **绝对业务量**（per-stock
 *     自身新旧 post_count 之比），不参照横截面统计量 — 走标准模式（不属
 *     LiquidityFactor 例外）。Pipeline 后续仍做 winsorize + zscore 跨因子归一化。
 *
 * 与既有因子的相关性预估：
 *   - 与 liquidity (US-029, 换手率) 相关性 ~0.3-0.5（高换手 ↔ 高散户关注度），
 *     非冗余：换手率反映**真实交易**，本因子反映**情绪/关注**，前者更早信号但
 *     易因机构盘磨蚀波动。
 *   - 与 money_flow (US-010, 主力净流入) 相关性较低 (~0.1-0.2)：主力是机构资金，
 *     与散户情绪是不同维度，组合可同时启用。
 *   - FactorIC (US-041) 上线后可验证；当前预期非冗余可同时启用。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { StockSentiment } from '../../../models/StockSentiment';
import { isFiniteNumber, lookbackStartDate } from './_helpers';

/** 近期窗口（自然日）— "最近 5 日的散户关注度" */
export const RECENT_WINDOW_DAYS = 5;
/** 总窗口（自然日）— "近 30 日"，即 baseline 窗口 = [-30, -5] */
export const TOTAL_WINDOW_DAYS = 30;
/** 单只股票计算因子值所需的最少有效观测数（recent + baseline 合计）
 * AC 没指定，按既有 AnalystConsensusFactor 同款 MIN_REPORTS_TOTAL=5 模式定 10
 * （sentiment 一天一条，30 日窗口里数据更密集 → 阈值高一点更稳健）。
 */
export const MIN_OBSERVATIONS_TOTAL = 10;
/** baseline 均值 ≤ 此绝对值视为"接近 0"，避免比率分母爆炸。
 *  post_count 代理取值范围 ~100-100000，1.0 是安全的"几乎不存在的非零值"门槛。
 */
export const BASELINE_ZERO_THRESHOLD = 1.0;

/**
 * 单只股票多日 post_count 观测的 5d/30d 比率 helper（抽成纯函数便于测试）.
 *
 * @param observations  该股票在 [as_of - TOTAL_WINDOW_DAYS + 1, as_of] 内的全部
 *                      (trade_date, post_count) 记录（trade_date 字符串 ISO YYYY-MM-DD）
 * @param asOfDate      截面日期 (YYYY-MM-DD)
 * @returns             计算出的 5d/30d 比率；任一前置条件不满足 → null
 */
export interface SentimentInput {
  trade_date: string;
  post_count: number | null | undefined;
}

export interface RatioBreakdown {
  recent_avg: number;
  baseline_avg: number;
  ratio: number;
  recent_count: number;
  baseline_count: number;
}

export function computePostCountRatio(
  observations: SentimentInput[],
  asOfDate: string,
  recentWindowDays: number = RECENT_WINDOW_DAYS,
  totalWindowDays: number = TOTAL_WINDOW_DAYS,
  minObsTotal: number = MIN_OBSERVATIONS_TOTAL,
  baselineZeroThreshold: number = BASELINE_ZERO_THRESHOLD
): RatioBreakdown | null {
  if (!observations || !observations.length || !asOfDate) return null;
  if (recentWindowDays <= 0 || totalWindowDays <= recentWindowDays) {
    // 显式 guard：recent 必须 < total，否则 baseline 区间为空
    return null;
  }

  const asOf = new Date(`${asOfDate}T00:00:00Z`);
  const recentCutoffStr = isoDateMinusDays(asOf, recentWindowDays - 1); // 近 5 日 = [asOf-4, asOf]
  const totalCutoffStr = isoDateMinusDays(asOf, totalWindowDays - 1); // 近 30 日 = [asOf-29, asOf]

  const recent: number[] = [];
  const baseline: number[] = [];

  for (const obs of observations) {
    if (!obs.trade_date) continue;
    if (obs.trade_date > asOfDate) continue; // lookahead bias guard (US-030 范式)
    if (obs.trade_date < totalCutoffStr) continue;

    const pc = obs.post_count;
    if (pc === null || pc === undefined) continue;
    // `Number(null) === 0` JS 大坑 (US-031): nullable 字段必须先 null 检查再 Number 转换
    const num = Number(pc);
    if (!isFiniteNumber(num)) continue;
    if (num < 0) continue; // post_count 不应为负

    if (obs.trade_date >= recentCutoffStr) {
      recent.push(num);
    } else {
      baseline.push(num);
    }
  }

  if (recent.length + baseline.length < minObsTotal) return null;
  if (recent.length === 0 || baseline.length === 0) return null;

  const recentAvg = mean(recent);
  const baselineAvg = mean(baseline);
  if (Math.abs(baselineAvg) < baselineZeroThreshold) return null; // 防 0 分母爆炸

  const ratio = recentAvg / baselineAvg;
  if (!isFiniteNumber(ratio)) return null;

  return {
    recent_avg: recentAvg,
    baseline_avg: baselineAvg,
    ratio,
    recent_count: recent.length,
    baseline_count: baseline.length,
  };
}

export const eastMoneyQAFactor: Factor = {
  name: 'east_money_qa',
  description:
    '近 5 日 / 近 30 日 post_count 比率（散户关注度变化代理；post_count 实为 EastMoney 人气榜排名倒数代理）',
  category: 'sentiment',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 拉窗口内的 StockSentiment（按 stock_code IN 过滤 universe）
    const startDate = lookbackStartDate(ctx.as_of_date, TOTAL_WINDOW_DAYS + 5);
    const rows = (await StockSentiment.findAll({
      attributes: ['stock_code', 'trade_date', 'post_count'],
      where: {
        stock_code: { [Op.in]: ctx.universe },
        trade_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      trade_date: string;
      post_count: any;
    }>;

    // 按 stock_code 分组
    const byStock = new Map<string, SentimentInput[]>();
    for (const r of rows) {
      const pc = r.post_count === null || r.post_count === undefined ? null : Number(r.post_count);
      const arr = byStock.get(r.stock_code) ?? [];
      arr.push({
        trade_date: r.trade_date,
        post_count: isFiniteNumber(pc as number) ? (pc as number) : null,
      });
      byStock.set(r.stock_code, arr);
    }

    // per-stock 计算比率
    for (const [code, observations] of byStock.entries()) {
      const result = computePostCountRatio(observations, ctx.as_of_date);
      if (result === null) continue;
      out.set(code, result.ratio);
    }

    return out;
  },
};

factorRegistry.register(eastMoneyQAFactor);

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

/** 给定 Date + 自然日，返回 isoDate 字符串 (YYYY-MM-DD)；days<0 clamp 到 0 */
export function isoDateMinusDays(asOf: Date, days: number): string {
  const d = new Date(asOf.getTime());
  d.setUTCDate(d.getUTCDate() - Math.max(0, days));
  return d.toISOString().slice(0, 10);
}
