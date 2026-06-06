/**
 * LowVolFactor (低波因子) — US-010
 *
 * 公式：raw_value = -stddev(daily_return[-120:])
 *   - 120 日日收益率的标准差，**取负号** —— 波动率低的股票给高分（低波动 anomaly）
 *   - 学术与实证都支持低波动股票长期收益不输甚至超过高波股
 *
 * 数据源：DailyBar 表（与 Momentum 同表，可以共享 stock_id 解析模式）
 *
 * 计算：
 *   - daily_return[i] = close[i] / close[i-1] - 1
 *   - stddev = sqrt(sum((r-mean)^2) / (n-1))
 *   - 输出 raw_value = -stddev（让 Pipeline 横截面 zscore 后高的就是低波的）
 *
 * 失效：bars < 121 → 跳过；stddev = 0（停牌全程没动）→ 跳过。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { DailyBar } from '../../../models/DailyBar';
import { loadStocksByCodes, isFiniteNumber, lookbackStartDate } from './_helpers';

const WINDOW = 120;
const QUERY_CALENDAR_DAYS = 220;

export const lowVolFactor: Factor = {
  name: 'low_vol',
  description: '近 120 日日收益率标准差取负，捕捉低波动 anomaly',
  category: 'volatility',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    const stockByCode = await loadStocksByCodes(ctx.universe, ['id', 'symbol']);
    if (!stockByCode.size) return out;

    const stockIds: number[] = [];
    const codeByStockId = new Map<number, string>();
    for (const [code, s] of stockByCode.entries()) {
      stockIds.push(s.id);
      codeByStockId.set(s.id, code);
    }

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

    for (const [stockId, arr] of barsByStockId.entries()) {
      const code = codeByStockId.get(stockId);
      if (!code) continue;
      arr.sort((a, b) => a.time - b.time);

      if (arr.length < WINDOW + 1) continue;
      const slice = arr.slice(-WINDOW - 1); // 拿 121 条算 120 个日收益率
      const returns: number[] = [];
      for (let i = 1; i < slice.length; i += 1) {
        const prev = slice[i - 1].close;
        if (prev <= 0) continue;
        returns.push(slice[i].close / prev - 1);
      }
      if (returns.length < 30) continue; // 半数都缺直接放弃，避免低样本噪音

      // 简单 n-1 样本标准差（与 normalization.ts 同口径但本地内联，避免循环依赖）
      const m = returns.reduce((s, v) => s + v, 0) / returns.length;
      let acc = 0;
      for (const v of returns) acc += (v - m) * (v - m);
      const sd = Math.sqrt(acc / (returns.length - 1));
      if (!isFiniteNumber(sd) || sd <= 0) continue;

      out.set(code, -sd); // 低波给高分
    }

    return out;
  },
};

factorRegistry.register(lowVolFactor);
