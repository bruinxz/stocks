/**
 * MomentumFactor (动量因子) — US-010
 *
 * 公式：raw_value = (close[T-20] / close[T-120]) - 1
 *   - 计算从 120 日前到 20 日前的累计涨幅
 *   - **故意剔除最近 20 日**：经典学术因子，因为近期超涨容易反转，
 *     "中期趋势 - 短期反转" 是 A 股做多动量的稳健形式
 *
 * 数据源：DailyBar 表
 *   - 主键 (stock_id, time)；time 是 DATE 类型
 *   - 需要先通过 Stock 表把 universe（无后缀）→ stock_id 解析
 *   - 一次 IN-list 查所有 universe 的 stock_id 即可（避免 N 次 round-trip）
 *
 * 计算锚点：
 *   - close[T-20] = as_of_date 的 20 个交易日前的收盘价
 *   - close[T-120] = as_of_date 的 120 个交易日前的收盘价
 *   - 用排序后的 bars[]，从尾部找出对齐位置；不用日期日历对齐（避免节假日错位）
 *
 * 失效：bar 数量 < 121 → 跳过（次新股 / 数据缺）。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { DailyBar } from '../../../models/DailyBar';
import { loadStocksByCodes, isFiniteNumber, lookbackStartDate } from './_helpers';

const LOOKBACK_TRADING = 120; // 中长期窗口
const SKIP_RECENT = 20; // 剔除最近 20 日反转区间
// 多取一些日历日作为查询窗口（A 股一年 ~250 交易日 = ~365 自然日）
const QUERY_CALENDAR_DAYS = 220; // 120 交易日 ≈ 175 自然日，向上取整 + 余量

export const momentumFactor: Factor = {
  name: 'momentum',
  description: '120-20 日动量：close[T-20]/close[T-120]-1（剔除短期反转）',
  category: 'momentum',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 1) universe (无后缀) → Stock 行（含 id）
    const stockByCode = await loadStocksByCodes(ctx.universe, ['id', 'symbol']);
    if (!stockByCode.size) return out;

    const stockIds: number[] = [];
    const codeByStockId = new Map<number, string>();
    for (const [code, s] of stockByCode.entries()) {
      stockIds.push(s.id);
      codeByStockId.set(s.id, code);
    }

    // 2) 一次拉所有 universe 的 bars（time 窗口足够长）
    const startDate = lookbackStartDate(ctx.as_of_date, QUERY_CALENDAR_DAYS);
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

    // 3) 按 stock_id 分组 + 按 time 升序排
    const barsByStockId = new Map<number, Array<{ time: number; close: number }>>();
    for (const b of bars) {
      const close = Number(b.close);
      if (!isFiniteNumber(close) || close <= 0) continue;
      const t = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
      if (!Number.isFinite(t)) continue;
      const arr = barsByStockId.get(b.stock_id) ?? [];
      arr.push({ time: t, close });
      barsByStockId.set(b.stock_id, arr);
    }

    // 4) 按 stock_id 计算 momentum
    for (const [stockId, arr] of barsByStockId.entries()) {
      const code = codeByStockId.get(stockId);
      if (!code) continue;
      arr.sort((a, b) => a.time - b.time);

      // 需要至少 LOOKBACK_TRADING + 1 = 121 个观测，按尾部计数
      if (arr.length < LOOKBACK_TRADING + 1) continue;

      const idxRecent = arr.length - 1 - SKIP_RECENT; // T-20
      const idxBase = arr.length - 1 - LOOKBACK_TRADING; // T-120
      if (idxRecent < 0 || idxBase < 0) continue;

      const closeRecent = arr[idxRecent].close;
      const closeBase = arr[idxBase].close;
      if (closeBase <= 0) continue;

      out.set(code, closeRecent / closeBase - 1);
    }

    return out;
  },
};

factorRegistry.register(momentumFactor);
