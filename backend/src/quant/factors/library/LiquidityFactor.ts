/**
 * LiquidityFactor (流动性因子) — US-029
 *
 * 公式：raw_value = -| ( avg_turnover_20 - P30(cross-section) ) / sd(cross-section) |
 *
 *   - avg_turnover_20：近 20 个交易日内有效换手率（DailyBar.turnover_rate, %）的算术均值
 *   - P30：当日全市场（universe 内有效样本）avg_turnover_20 的 30 % 分位数
 *   - sd：当日全市场 avg_turnover_20 的样本标准差（n-1）
 *
 *   - 取负绝对值的目的：过低（≈ 僵尸股 / 无人问津）与过高（≈ 过度拥挤 / 接近顶部）
 *     两端都得低分；avg_turnover_20 越靠近 P30 raw_value 越接近 0（最高）。
 *     形成围绕 P30 的 U 形评分。
 *
 *   - 学术依据：低换手 = 流动性折价（买卖摩擦大，机构难进出，长期收益偏低）；
 *     极高换手 = 过度交易 / 散户主导 / 接近泡沫顶部，未来 alpha 也偏低。
 *     P30 是 A 股实证里的健康流动性档（参考 Amihud 流动性研究与国内 broker 报告）。
 *
 * 数据源：DailyBar.turnover_rate
 *   - 字段：DailyBar.turnover_rate (DECIMAL(10,4)，单位 %)
 *   - 查询窗口：自然日 30 天兜底周末/节假日，取每只股票最近 20 个有效观测
 *
 * 失效（不入 Map，让 Pipeline 自动补中性）：
 *   - 单只股票 20 日窗口内有效 turnover_rate 观测 < MIN_OBS（10）→ 跳过
 *   - 全市场有效样本数 < 2 → compute 返回空 Map（pipeline 中性补全）
 *   - 全市场样本标准差 sd = 0（极端 degenerate：所有股票同 turnover）→
 *     给所有 effective 股票 raw_value = 0（无惩罚，等价于全中性）
 *
 * 关于"因子不做归一化"约束的例外说明（参见 factors/CLAUDE.md 设计约束 #1）：
 *   - 8 个基础因子（US-010）的 raw_value 都是 **绝对业务量**（PE 倒数、ROE 均值、动量、波动率…），
 *     不参照任何横截面统计。
 *   - LiquidityFactor 是首个 **参照横截面统计点（P30 + sd）** 的因子。它不是
 *     "额外标准化"——P30 + sd 是这个因子的经济意义本体（U 形评分必须有参照点）。
 *   - 输出的 raw_value 在 [-∞, 0] 区间（负数惩罚），Pipeline 后续仍做 winsorize +
 *     zscore，"距离 P30 越远 → 惩罚越大 → zscore 越低"，跨因子可比性维持不变。
 *   - 未来 US-029+ 任何 "围绕某分位做 U 评分" / "距历史均值的偏离" / "横截面贴现" 类
 *     因子都可走这条路径；在 factors/CLAUDE.md 已记录此例外模式。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { DailyBar } from '../../../models/DailyBar';
import { loadStocksByCodes, isFiniteNumber, lookbackStartDate } from './_helpers';

/** 单只股票计算 avg_turnover_20 所需的最少有效观测数 */
export const MIN_TURNOVER_OBSERVATIONS = 10;
/** 单只股票的 turnover 滑动窗口长度（最近 N 个有效观测，按时间倒序取） */
export const TURNOVER_WINDOW = 20;
/** 自然日回看窗口（包含周末/节假日 buffer，保证拿到 ≥ 20 个交易日） */
export const TURNOVER_QUERY_CALENDAR_DAYS = 30;
/** 横截面参照分位（30 %） */
export const LIQUIDITY_REFERENCE_QUANTILE = 0.3;

/**
 * 已排序数组的分位值（线性插值法），quantile ∈ [0, 1]。
 *
 * 与 normalization.ts 内部的 quantileAtSorted 同一公式，但本文件独立持有副本
 * 避免 import 内部 helper（normalization.ts 没 export 它）。如未来 3+ 因子都需要
 * 分位计算，可考虑提到 _helpers.ts。
 */
export function quantileAtSortedAsc(sortedAsc: number[], quantile: number): number {
  if (!sortedAsc.length) return 0;
  if (quantile <= 0) return sortedAsc[0];
  if (quantile >= 1) return sortedAsc[sortedAsc.length - 1];
  const pos = quantile * (sortedAsc.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 >= sortedAsc.length) return sortedAsc[base];
  return sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base]);
}

/** 样本标准差 (n-1 分母)。len < 2 返回 0（与 normalization.stddev 同口径） */
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
 * U-shape liquidity penalty：return -|(value - center) / sd|；sd = 0 → 0（无惩罚）。
 *
 * 抽成纯函数便于单测验证："越靠近 P30 raw 越接近 0；越偏离 raw 越负"。
 */
export function liquidityPenaltyScore(value: number, center: number, sd: number): number {
  if (!isFiniteNumber(value) || !isFiniteNumber(center) || !isFiniteNumber(sd)) return 0;
  if (sd <= 0) return 0;
  return -Math.abs((value - center) / sd);
}

/**
 * 取 DailyBar rows 中每只股票 **最近 TURNOVER_WINDOW 个有效观测** 的算术均值。
 *
 * 有效定义：turnover_rate 为 finite 正数（停牌/缺数据/为 0 都跳过 — turnover_rate=0
 * 表示当日无成交，对 "近 20 日平均换手率" 的语义贡献为 0 反而扭曲均值；剔除更稳健）。
 *
 * 输入 rows 不必有序；本函数按 time DESC 内部排序后取前 TURNOVER_WINDOW 条。
 *
 * @returns 有效观测数 < MIN_TURNOVER_OBSERVATIONS → 返回 null（让 Pipeline 中性补全）。
 */
export function computeAvgTurnoverFromBars(
  rows: Array<{ time: Date | string | number; turnover_rate?: any }>
): number | null {
  if (!rows.length) return null;
  const validPairs: Array<{ t: number; rate: number }> = [];
  for (const r of rows) {
    const rate = Number(r.turnover_rate);
    if (!isFiniteNumber(rate) || rate <= 0) continue;
    const t =
      r.time instanceof Date
        ? r.time.getTime()
        : typeof r.time === 'number'
        ? r.time
        : new Date(r.time).getTime();
    if (!Number.isFinite(t)) continue;
    validPairs.push({ t, rate });
  }
  if (validPairs.length < MIN_TURNOVER_OBSERVATIONS) return null;
  validPairs.sort((a, b) => b.t - a.t); // 时间倒序
  const recent = validPairs.slice(0, TURNOVER_WINDOW);
  if (recent.length < MIN_TURNOVER_OBSERVATIONS) return null;
  let sum = 0;
  for (const p of recent) sum += p.rate;
  return sum / recent.length;
}

export const liquidityFactor: Factor = {
  name: 'liquidity',
  description: '近 20 日平均换手率围绕全市场 P30 的负绝对偏离 — 过低过高都减分（U 形）',
  category: 'liquidity',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 1) universe → Stock.id 反查
    const stockByCode = await loadStocksByCodes(ctx.universe, ['id', 'symbol']);
    if (!stockByCode.size) return out;

    const stockIds: number[] = [];
    const codeByStockId = new Map<number, string>();
    for (const [code, s] of stockByCode.entries()) {
      stockIds.push(s.id);
      codeByStockId.set(s.id, code);
    }

    // 2) 拉自然日 30 天的 turnover_rate（足够拿 20 个交易日）
    const startDate = lookbackStartDate(ctx.as_of_date, TURNOVER_QUERY_CALENDAR_DAYS);
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'turnover_rate'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: {
          [Op.gte]: `${startDate}T00:00:00Z`,
          [Op.lte]: `${ctx.as_of_date}T23:59:59Z`,
        },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      turnover_rate: any;
    }>;

    // 3) 按 stock_id 分组 + 计算 avg_turnover_20
    const barsByStockId = new Map<number, Array<{ time: Date | string; turnover_rate: any }>>();
    for (const b of bars) {
      const arr = barsByStockId.get(b.stock_id) ?? [];
      arr.push({ time: b.time, turnover_rate: b.turnover_rate });
      barsByStockId.set(b.stock_id, arr);
    }

    const avgByCode = new Map<string, number>();
    for (const [stockId, rows] of barsByStockId.entries()) {
      const code = codeByStockId.get(stockId);
      if (!code) continue;
      const avg = computeAvgTurnoverFromBars(rows);
      if (avg === null) continue;
      avgByCode.set(code, avg);
    }

    // 4) 横截面 P30 + 样本标准差
    if (avgByCode.size < 2) {
      // 全市场 < 2 只 → 无法做横截面参照，全部不入 Map（pipeline 中性补全）
      return out;
    }
    const values = Array.from(avgByCode.values());
    const sortedAsc = values.slice().sort((a, b) => a - b);
    const p30 = quantileAtSortedAsc(sortedAsc, LIQUIDITY_REFERENCE_QUANTILE);
    const sd = sampleStddev(values);

    // 5) 应用 U-shape penalty 输出 raw_value
    //    sd = 0 时所有股票 raw_value = 0（liquidityPenaltyScore 已处理）
    for (const [code, avg] of avgByCode.entries()) {
      out.set(code, liquidityPenaltyScore(avg, p30, sd));
    }

    return out;
  },
};

factorRegistry.register(liquidityFactor);
