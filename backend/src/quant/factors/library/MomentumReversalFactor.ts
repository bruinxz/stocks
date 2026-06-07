/**
 * MomentumReversalFactor (动量反转因子) — US-033
 *
 * 公式：raw_value = mom_120 - mom_5
 *   - mom_120 = (close[T] / close[T-120]) - 1   # 中长期动量
 *   - mom_5   = (close[T] / close[T-5]) - 1     # 短期动量
 *
 *   - 正值（mom_120 > mom_5）：中长期动量强、短期动量弱 ⇒ "趋势延续"信号
 *     （长期稳健上涨 + 短期健康回调，是经典做多形态）
 *   - 负值（mom_120 < mom_5）：短期动量强但中长期一般 ⇒ "反转 / 超涨"信号
 *     （短期过热脉冲，未来均值回归概率高）
 *
 * 与既有 MomentumFactor (US-010) 的区别：
 *   - momentum (US-010) = (close[T-20] / close[T-120]) - 1
 *     • Asness 风格 "12-1 月动量"：取中长期累计涨幅，**剔除**最近 1 月（避免短反转）
 *     • 输出是单一动量值，正负只代表"涨/跌"
 *   - momentum_reversal (US-033) = mom_120 - mom_5
 *     • 长短动量的"差值"：两段都包含 close[T]，差值消去了 close[T] 项的方向，
 *       只保留"长期 vs 短期"的对比
 *     • 正负代表"延续 vs 反转"，与 momentum 维度互补；多因子模型可同时启用
 *
 *   两个因子相关性预计 0.3-0.5（非冗余）：
 *     • 都用 close 序列，但截取窗口与运算形式不同
 *     • FactorIC (US-041) 上线后可监测，> 0.7 再考虑剔除
 *
 * 数据源：DailyBar 表（与 momentum / low_vol 同表）
 *   - 主键 (stock_id, time)，需要先 loadStocksByCodes 解析 stock_id
 *   - 一次 IN-list 拉所有 universe 的 bars，避免 N 次 round-trip
 *
 * 计算锚点：
 *   - close[T]     = bars[length - 1]            （最近一根）
 *   - close[T-5]   = bars[length - 1 - 5]
 *   - close[T-120] = bars[length - 1 - 120]
 *   - 用 tail-index 而不是按日历日匹配，自然消化春节 / 十一 节假日 gap
 *     （与 momentum / low_vol 同款模式）
 *
 * 失效（不入 Map，让 Pipeline 中性补全）：
 *   - bars 数量 < LONG_WINDOW + 1 = 121 → 次新股 / 数据缺，跳过
 *   - close[T] / close[T-5] / close[T-120] 中任一 ≤ 0 → 跳过（停牌 / 缺数据）
 *
 * 关于"因子不做归一化"约束 #1：
 *   - 本因子是 **绝对业务量**（per-stock 自身两段动量的差值），不参照横截面统计 —
 *     走标准模式（不属 LiquidityFactor 横截面参照例外）。
 *   - mom_120 - mom_5 是因子语义本体（"延续 vs 反转"），不是归一化变换；
 *     与 GrowthFactor 0.6*np + 0.4*rev 同性质。Pipeline 后续仍做 winsorize +
 *     zscore，跨因子可比性维持不变。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { DailyBar } from '../../../models/DailyBar';
import { loadStocksByCodes, isFiniteNumber, lookbackStartDate } from './_helpers';

/** 中长期动量窗口（120 个交易日） */
export const LONG_MOMENTUM_WINDOW = 120;
/** 短期动量窗口（5 个交易日） */
export const SHORT_MOMENTUM_WINDOW = 5;
/** 自然日查询窗口（120 交易日 ≈ 175 自然日 + 春节/十一 buffer） */
export const MOMENTUM_REVERSAL_QUERY_CALENDAR_DAYS = 220;

/**
 * 单段动量计算：(close[length-1] / close[length-1-window]) - 1。
 *
 * 抽成纯函数便于单测验证（不走 DB / 不需要 Sequelize 类型）。
 *
 * @param sortedCloses 按时间升序的 close 序列（length-1 是最近一根）
 * @param window       回看交易日数（length-1-window 是 T-window 那根）
 * @returns 动量比率（小数，0.05 = 5%）；序列长度不足或任一 close ≤ 0 → null
 *
 * 说明：
 *   - 序列必须按时间**升序**排（caller 责任）；本函数不再二次排序。
 *   - 不做 Math.log 等转换，保持原始百分比意义；横截面 zscore 不需要对数化。
 *   - close ≤ 0 = 数据异常（停牌可能给 0），直接 null 让 caller 处理。
 */
export function computeWindowMomentum(sortedCloses: number[], window: number): number | null {
  if (!Number.isInteger(window) || window <= 0) return null;
  if (sortedCloses.length < window + 1) return null;
  const idxT = sortedCloses.length - 1;
  const idxBase = idxT - window;
  if (idxBase < 0) return null;
  const closeT = sortedCloses[idxT];
  const closeBase = sortedCloses[idxBase];
  if (!isFiniteNumber(closeT) || !isFiniteNumber(closeBase)) return null;
  if (closeT <= 0 || closeBase <= 0) return null;
  return closeT / closeBase - 1;
}

/**
 * 长短动量差值：mom_long - mom_short。
 *
 * 任一 momentum null → 整体 null（与 quality_high "任一子分量缺失整体 null"
 * 同款宽容策略：两段同维度（都是 "涨幅 %"），但缺一段后 "0 代入" 让另一段被
 * 当作 spread 主体，因子语义崩坏）。
 *
 * 抽成纯函数便于单测验证算术正确性：例如 (+10% 长 - +3% 短) = +7% 趋势延续；
 * (+2% 长 - +8% 短) = -6% 短期超涨。
 */
export function combineMomentumReversal(
  momLong: number | null,
  momShort: number | null
): number | null {
  if (momLong === null || momShort === null) return null;
  if (!isFiniteNumber(momLong) || !isFiniteNumber(momShort)) return null;
  const diff = momLong - momShort;
  if (!isFiniteNumber(diff)) return null;
  return diff;
}

/**
 * 把 DailyBar 行集合转成按时间升序的 close 序列；
 * close ≤ 0 / NaN / 缺都跳过；非有限时间戳跳过。
 *
 * 抽成纯函数便于单测验证 "无效 close 跳过" + "升序排序"。
 */
export function extractSortedCloses(
  rows: Array<{ time: Date | string | number; close?: any }>
): number[] {
  if (!rows.length) return [];
  const valid: Array<{ t: number; close: number }> = [];
  for (const r of rows) {
    const close = Number(r.close);
    if (!isFiniteNumber(close) || close <= 0) continue;
    const t =
      r.time instanceof Date
        ? r.time.getTime()
        : typeof r.time === 'number'
        ? r.time
        : new Date(r.time).getTime();
    if (!Number.isFinite(t)) continue;
    valid.push({ t, close });
  }
  valid.sort((a, b) => a.t - b.t);
  return valid.map(p => p.close);
}

export const momentumReversalFactor: Factor = {
  name: 'momentum_reversal',
  description: '120 日动量 - 5 日动量：正值=趋势延续 / 负值=短期超涨反转（与 momentum 互补）',
  category: 'momentum',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 1) universe (无后缀) → Stock.id 反查（与 momentum / low_vol 同款模式）
    const stockByCode = await loadStocksByCodes(ctx.universe, ['id', 'symbol']);
    if (!stockByCode.size) return out;

    const stockIds: number[] = [];
    const codeByStockId = new Map<number, string>();
    for (const [code, s] of stockByCode.entries()) {
      stockIds.push(s.id);
      codeByStockId.set(s.id, code);
    }

    // 2) 一次拉所有 universe 的 bars
    const startDate = lookbackStartDate(ctx.as_of_date, MOMENTUM_REVERSAL_QUERY_CALENDAR_DAYS);
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close'],
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
    }>;

    // 3) 按 stock_id 分组
    const barsByStockId = new Map<number, Array<{ time: Date | string; close: any }>>();
    for (const b of bars) {
      const arr = barsByStockId.get(b.stock_id) ?? [];
      arr.push({ time: b.time, close: b.close });
      barsByStockId.set(b.stock_id, arr);
    }

    // 4) 按 stock_id 计算 momentum_reversal
    for (const [stockId, rows] of barsByStockId.entries()) {
      const code = codeByStockId.get(stockId);
      if (!code) continue;

      const closes = extractSortedCloses(rows);
      if (closes.length < LONG_MOMENTUM_WINDOW + 1) continue;

      const momLong = computeWindowMomentum(closes, LONG_MOMENTUM_WINDOW);
      const momShort = computeWindowMomentum(closes, SHORT_MOMENTUM_WINDOW);
      const reversal = combineMomentumReversal(momLong, momShort);
      if (reversal === null) continue;

      out.set(code, reversal);
    }

    return out;
  },
};

factorRegistry.register(momentumReversalFactor);
