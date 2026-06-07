/**
 * GradualBreakoutFactor (渐进强爆因子) — US-036
 *
 * 公式：raw_value = Σ_{i in 近 RECENT_WINDOW_DAYS 个有效交易日}
 *                    ( daily_volume[i] / avg_60d_volume[i] - 1 ) × sign(change_pct[i])
 *
 *   - RECENT_WINDOW_DAYS   = 30  累计窗口（"近 30 日"）
 *   - VOLUME_BASELINE_DAYS = 60  成交量均值参照窗口（"60 日均量"）
 *   - sign(change_pct[i])  ∈ {-1, 0, +1}
 *     • +1：当日 close > 前一日 close（涨）
 *     • -1：当日 close < 前一日 close（跌）
 *     •  0：当日 close = 前一日 close（平）/ 或前日 close ≤ 0 数据异常
 *
 * 业务直觉 — 4 象限：
 *   (1) 价涨 + 量增（sign=+1, ratio>0）→ **正贡献**
 *       温和放量上行，渐进式建仓信号
 *   (2) 价涨 + 量减（sign=+1, ratio<0）→ 负贡献
 *       缩量上涨 = 量价背离弱信号，警惕拉高出货
 *   (3) 价跌 + 量减（sign=-1, ratio<0）→ **正贡献**
 *       缩量调整 = "无杀伤"加分（主力惜筹）
 *   (4) 价跌 + 量增（sign=-1, ratio>0）→ 负贡献
 *       放量下跌 = 恐慌出货 / 主力派发
 *   (0) 平盘（sign=0）→ 0 贡献（不参与累计）
 *
 * 与既有 momentum (US-010) / momentum_reversal (US-033) 的区别：
 *   - momentum 用 close 序列度量"中长期累计涨幅"，纯价格因子
 *   - momentum_reversal 用 mom_long - mom_short 的差值，仍纯价格
 *   - gradual_breakout 是 **价 + 量配合**的累计因子：同样的"涨"在
 *     "放量涨" vs "缩量涨" 给出截然不同的得分，捕捉的 alpha 维度不同
 *   - 与 liquidity (US-029, 仅看换手率水平) 也不同：liquidity 是 U 形评分
 *     不关心价格方向；本因子要 vol/baseline × sign(close)，价量必须同向才正
 *   - 三个因子相关性预计 < 0.5（非冗余）；FactorIC (US-041) 上线后可验证
 *
 * 数据源：DailyBar 表（与 momentum / low_vol / momentum_reversal 同表）
 *   - 主键 (stock_id, time)，需要先 loadStocksByCodes 解析 stock_id
 *   - 一次 IN-list 拉所有 universe 的 bars
 *   - 字段 attributes = ['stock_id', 'time', 'close', 'volume']
 *
 * change_pct 从 close[T]/close[T-1]-1 自算，**不直接读 DailyBar.change_percent 列**：
 *   - change_percent 是 nullable 列，多数同步任务回填，缺失率较高
 *   - 本因子已经必须读 close 算累计的 ratio，sign 在内存里加一行就完事
 *   - 把 sign 推到 sign(close[T] - close[T-1]) 也避免了 "change_percent
 *     数据流入 DB 时是 % 还是小数" 之类的歧义
 *
 * 计算锚点 — tail-index 滑动（与 momentum / low_vol / momentum_reversal 同款）：
 *   - sortedBars 按 time 升序
 *   - 对 sortedBars[i] (i ∈ [bars.length - RECENT_WINDOW_DAYS, bars.length - 1])：
 *     • avg_60d_volume[i] = mean(volume[i-60..i-1])（i-60 不可负 → 跳过）
 *     • sign[i] = sign(close[i] - close[i-1])
 *     • 贡献 = (volume[i] / avg_60d_volume[i] - 1) × sign[i]
 *   - 用 tail-index 自然消化春节 / 十一 节假日 gap（与 momentum 同款）
 *
 * 失效（不入 Map，让 Pipeline 中性补全 raw_value=null, z=0, percentile=0.5）：
 *   - bars 数 < VOLUME_BASELINE_DAYS + 1 = 61 → 次新股或数据缺，跳过
 *   - 60 日均量基线有效观测 < MIN_VOLUME_BASELINE_OBS = 30 → 基线不可信
 *   - 近 RECENT_WINDOW_DAYS 内有效贡献天数 < MIN_RECENT_DAYS_FOR_VALID = 21
 *     (= RECENT_WINDOW_DAYS × 70%) → 停牌过多累计无业务意义
 *
 * 关于"因子不做归一化"约束 #1 (factors/CLAUDE.md)：
 *   - 本因子是 **绝对业务量**（per-stock 自身价量配合累计），不参照横截面统计 —
 *     走标准模式（不属 LiquidityFactor 例外）。
 *   - `daily_volume / avg_60d_volume - 1` 已是无量纲；累计后让 Pipeline
 *     做 winsorize + zscore，跨因子可比性维持不变。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { DailyBar } from '../../../models/DailyBar';
import { loadStocksByCodes, isFiniteNumber, lookbackStartDate } from './_helpers';

/** 累计窗口（个有效交易日） */
export const RECENT_WINDOW_DAYS = 30;
/** 成交量均值参照窗口（个交易日） */
export const VOLUME_BASELINE_DAYS = 60;
/** 自然日查询窗口（60 交易日 ≈ 87 自然日 + 30 累计窗口 + 春节/十一假期 buffer） */
export const QUERY_CALENDAR_DAYS = 150;
/** 60 日均量基线需要至少 MIN_VOLUME_BASELINE_OBS 个有效 volume 才算可信
 *  (= VOLUME_BASELINE_DAYS / 2)，过半数缺失认为该股票交易不活跃，跳过
 */
export const MIN_VOLUME_BASELINE_OBS = 30;
/** 近 30 日累计窗口里至少需要 MIN_RECENT_DAYS_FOR_VALID 个 effective 贡献天
 *  (= RECENT_WINDOW_DAYS × 70%)，否则停牌过多累计无业务意义
 */
export const MIN_RECENT_DAYS_FOR_VALID = 21;

/** 单个 sorted bar（按 time 升序后用的内存结构） */
export interface SortedBar {
  time: number;
  close: number;
  volume: number;
}

/** computeGradualBreakoutScore() 返回的明细结构（便于单测断言 + jsdoc 阅读） */
export interface BreakoutBreakdown {
  /** 累计 score = Σ(贡献) */
  score: number;
  /** 有效贡献天数（baseline 可信 + close 可计 sign） */
  effective_days: number;
  /** 当中价涨贡献的天数（sign=+1） */
  positive_days: number;
  /** 当中价跌贡献的天数（sign=-1） */
  negative_days: number;
  /** 当中平盘天数（sign=0，对 score 贡献 0） */
  flat_days: number;
}

/**
 * 把 DailyBar 行集合转成按时间升序的 {time, close, volume} 序列；
 * close ≤ 0 / volume ≤ 0 / NaN / 缺都跳过；非有限时间戳跳过。
 *
 * 抽成纯函数便于单测验证 "无效跳过 + 升序排序"。
 */
export function extractSortedBars(
  rows: Array<{ time: Date | string | number; close?: any; volume?: any }>
): SortedBar[] {
  if (!rows.length) return [];
  const valid: SortedBar[] = [];
  for (const r of rows) {
    const close = Number(r.close);
    const volume = Number(r.volume);
    if (!isFiniteNumber(close) || close <= 0) continue;
    if (!isFiniteNumber(volume) || volume <= 0) continue;
    const t =
      r.time instanceof Date
        ? r.time.getTime()
        : typeof r.time === 'number'
        ? r.time
        : new Date(r.time).getTime();
    if (!Number.isFinite(t)) continue;
    valid.push({ time: t, close, volume });
  }
  valid.sort((a, b) => a.time - b.time);
  return valid;
}

/**
 * 计算 close 序列的"前一日变化方向"：
 *   changes[i] = sign(close[i] - close[i-1]) ∈ {-1, 0, +1}
 *
 * - 首位 changes[0] = 0（无前日基准）
 * - 任一 close ≤ 0 / NaN → 当位 sign = 0
 *
 * 抽成纯函数便于单测验证 sign 三态分类。
 */
export function computeChangeSigns(sortedBars: SortedBar[]): number[] {
  const out: number[] = new Array(sortedBars.length).fill(0);
  for (let i = 1; i < sortedBars.length; i += 1) {
    const prev = sortedBars[i - 1].close;
    const curr = sortedBars[i].close;
    if (!isFiniteNumber(prev) || !isFiniteNumber(curr) || prev <= 0 || curr <= 0) {
      out[i] = 0;
      continue;
    }
    if (curr > prev) out[i] = 1;
    else if (curr < prev) out[i] = -1;
    else out[i] = 0; // 平盘
  }
  return out;
}

/**
 * 计算 60 日（参数化 baselineDays）滚动均量序列：
 *   base[i] = mean(volume[i-baselineDays .. i-1])
 *   i < baselineDays → null（不足回看）
 *   baselineDays 内有效 volume < MIN_VOLUME_BASELINE_OBS → null
 *
 * baseline 窗口**不含当日**（i 本身）：这是经典做法 — 把"当日"作为待评估的样本，
 * 与"过去 N 日均值"比较；含当日会让 ratio 自带偏置。
 *
 * 抽成纯函数便于单测验证 "数据不足返回 null + 正确算术 + 滑动 + 自定义 baselineDays"。
 */
export function compute60dAvgVolumes(
  sortedBars: SortedBar[],
  baselineDays: number = VOLUME_BASELINE_DAYS,
  minObs: number = MIN_VOLUME_BASELINE_OBS
): Array<number | null> {
  const out: Array<number | null> = new Array(sortedBars.length).fill(null);
  if (!Number.isInteger(baselineDays) || baselineDays <= 0) return out;
  if (sortedBars.length < baselineDays + 1) return out;
  for (let i = baselineDays; i < sortedBars.length; i += 1) {
    let sum = 0;
    let cnt = 0;
    for (let j = i - baselineDays; j < i; j += 1) {
      const v = sortedBars[j].volume;
      if (!isFiniteNumber(v) || v <= 0) continue;
      sum += v;
      cnt += 1;
    }
    if (cnt < minObs) {
      out[i] = null;
      continue;
    }
    out[i] = sum / cnt;
  }
  return out;
}

/**
 * 单只股票的渐进强爆得分（核心算法）。
 *
 * @param sortedBars             按 time 升序的 bars（先调 extractSortedBars 清洗）
 * @param recentDays             累计窗口大小（默认 RECENT_WINDOW_DAYS=30）
 * @param baselineDays           成交量均值参照窗口（默认 VOLUME_BASELINE_DAYS=60）
 * @param minRecentDaysForValid  累计窗口内最少有效贡献天数（默认 21 = 30×70%）
 * @returns                      明细 + score；任一前置条件不满足 → null
 *
 * 算法步骤：
 *   1. compute60dAvgVolumes(sortedBars, baselineDays) → base[]
 *   2. computeChangeSigns(sortedBars) → sign[]
 *   3. 从尾部往前取最多 recentDays 个 index：
 *      - i ∈ [bars.length - recentDays, bars.length - 1]
 *      - 对每个 i：base[i] 为 null → skip; sign[i] = 0 → 计入 flat_days 但贡献 0
 *      - 贡献_i = (volume[i] / base[i] - 1) × sign[i]
 *      - 累加 score
 *   4. effective_days = positive_days + negative_days + flat_days
 *      effective_days < minRecentDaysForValid → null
 */
export function computeGradualBreakoutScore(
  sortedBars: SortedBar[],
  recentDays: number = RECENT_WINDOW_DAYS,
  baselineDays: number = VOLUME_BASELINE_DAYS,
  minRecentDaysForValid: number = MIN_RECENT_DAYS_FOR_VALID,
  minBaselineObs: number = MIN_VOLUME_BASELINE_OBS
): BreakoutBreakdown | null {
  if (!Number.isInteger(recentDays) || recentDays <= 0) return null;
  if (!Number.isInteger(baselineDays) || baselineDays <= 0) return null;
  if (!Number.isInteger(minRecentDaysForValid) || minRecentDaysForValid < 0) return null;
  if (sortedBars.length < baselineDays + 1) return null;

  const baselines = compute60dAvgVolumes(sortedBars, baselineDays, minBaselineObs);
  const signs = computeChangeSigns(sortedBars);

  const startIdx = Math.max(baselineDays, sortedBars.length - recentDays);
  const endIdx = sortedBars.length - 1;

  let score = 0;
  let positive = 0;
  let negative = 0;
  let flat = 0;

  for (let i = startIdx; i <= endIdx; i += 1) {
    const base = baselines[i];
    if (base === null || base <= 0 || !isFiniteNumber(base)) continue;
    const vol = sortedBars[i].volume;
    if (!isFiniteNumber(vol) || vol <= 0) continue;
    const sgn = signs[i];
    if (sgn === 0) {
      flat += 1;
      continue;
    }
    const contribution = (vol / base - 1) * sgn;
    if (!isFiniteNumber(contribution)) continue;
    score += contribution;
    if (sgn > 0) positive += 1;
    else negative += 1;
  }

  const effective = positive + negative + flat;
  if (effective < minRecentDaysForValid) return null;

  return {
    score,
    effective_days: effective,
    positive_days: positive,
    negative_days: negative,
    flat_days: flat,
  };
}

export const gradualBreakoutFactor: Factor = {
  name: 'gradual_breakout',
  description:
    '近 30 日 Σ(daily_volume/avg_60d_volume - 1) × sign(涨跌幅)：温和放量逐步走强的价量配合累计',
  category: 'momentum',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 1) universe（无后缀）→ Stock 行（含 id）
    const stockByCode = await loadStocksByCodes(ctx.universe, ['id', 'symbol']);
    if (!stockByCode.size) return out;

    const stockIds: number[] = [];
    const codeByStockId = new Map<number, string>();
    for (const [code, s] of stockByCode.entries()) {
      stockIds.push(s.id);
      codeByStockId.set(s.id, code);
    }

    // 2) 一次拉所有 universe 的 bars（足够长的 time 窗口）
    const startDate = lookbackStartDate(ctx.as_of_date, QUERY_CALENDAR_DAYS);
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close', 'volume'],
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
      close: any;
      volume: any;
    }>;

    // 3) 按 stock_id 分组
    const barsByStockId = new Map<
      number,
      Array<{ time: Date | string; close: any; volume: any }>
    >();
    for (const b of bars) {
      const arr = barsByStockId.get(b.stock_id) ?? [];
      arr.push({ time: b.time, close: b.close, volume: b.volume });
      barsByStockId.set(b.stock_id, arr);
    }

    // 4) 按 stock_id 计算 gradual_breakout score
    for (const [stockId, rows] of barsByStockId.entries()) {
      const code = codeByStockId.get(stockId);
      if (!code) continue;

      const sortedBars = extractSortedBars(rows);
      if (sortedBars.length < VOLUME_BASELINE_DAYS + 1) continue;

      const breakdown = computeGradualBreakoutScore(sortedBars);
      if (breakdown === null) continue;

      out.set(code, breakdown.score);
    }

    return out;
  },
};

factorRegistry.register(gradualBreakoutFactor);
