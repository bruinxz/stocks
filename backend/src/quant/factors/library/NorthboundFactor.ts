/**
 * NorthboundFactor (北向资金因子) — US-010
 *
 * 公式：raw_value = hold_ratio[as_of_date] - hold_ratio[as_of_date - 20 自然日]
 *   - 北向持股比例上升越多 → 越积极（聪明钱抢筹）
 *   - 用差值（绝对百分点）而非比值，因为基数小的股票比值会爆炸
 *
 * 数据源：NorthboundHolding 表
 *   - 主键 (trade_date, stock_code)，stock_code 无后缀，与 universe 直接对齐
 *   - 字段：hold_ratio (DECIMAL 10,6) = 占流通股比 %
 *
 * 失效：
 *   - as_of_date 当天该股没有 北向持股数据 → 不入 Map（次新 / 不在沪深通范围）
 *   - 20 日前没有数据 → 用窗口内最早一条做基线（北向是 2014/2016 才开通，
 *     早期数据天然缺）；若窗口内连基线都没有 → 跳过
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { NorthboundHolding } from '../../../models/NorthboundHolding';
import { isFiniteNumber } from './_helpers';
import { tradingDayLookbackStartDate } from './_tradingDayWindow';

/** 业务窗口: 近 20 个交易日 (audit M-9: 从 30 自然日 +10 buffer 改成精确 20 交易日) */
const WINDOW_TRADING_DAYS = 20;

export const northboundFactor: Factor = {
  name: 'northbound',
  description: '北向持股比例 20 自然日变化（聪明钱方向）',
  category: 'flow',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 拉窗口内 + 当日的全部北向行 (audit M-9: 交易日窗口替代 +10 自然日兜底)
    const startDate = await tradingDayLookbackStartDate(ctx.as_of_date, WINDOW_TRADING_DAYS);
    const rows = (await NorthboundHolding.findAll({
      attributes: ['stock_code', 'trade_date', 'hold_ratio'],
      where: {
        stock_code: { [Op.in]: ctx.universe },
        trade_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      trade_date: string;
      hold_ratio: any;
    }>;

    // 按 stock_code 分组 + 排序
    const rowsByCode = new Map<string, Array<{ date: string; ratio: number }>>();
    for (const r of rows) {
      const ratio = Number(r.hold_ratio);
      if (!isFiniteNumber(ratio)) continue;
      const arr = rowsByCode.get(r.stock_code) ?? [];
      arr.push({ date: r.trade_date, ratio });
      rowsByCode.set(r.stock_code, arr);
    }

    // 当日 ratio - 窗口内最早一条 ratio（≈ 20 自然日前）
    for (const [code, arr] of rowsByCode.entries()) {
      arr.sort((a, b) => a.date.localeCompare(b.date));
      const latest = arr[arr.length - 1];
      if (latest.date !== ctx.as_of_date) continue; // 当日没有北向数据 → 不计算
      const baseline = arr[0]; // 窗口内最早一条作为基线
      if (baseline === latest) continue; // 只有一条数据 → 无法算变化

      out.set(code, latest.ratio - baseline.ratio);
    }

    return out;
  },
};

factorRegistry.register(northboundFactor);
