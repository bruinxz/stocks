/**
 * GrowthFactor (成长因子) — US-010
 *
 * 公式：raw_value = 0.6 * net_profit_growth + 0.4 * revenue_growth
 *   - 净利润同比增长权重 0.6（利润是成长性核心）
 *   - 营收同比增长权重 0.4（营收增长支撑利润，避免单纯利润操纵）
 *
 * 数据源：StockFundamentalFactor 表
 *   - 字段：symbol、factor_date、net_profit_growth、revenue_growth
 *   - 各自取最新的非空值（季度数据通常滞后 1-2 个月，所以 lookback 90 天足够）
 *
 * 失效：net_profit_growth 与 revenue_growth 都缺 → 跳过；只缺一项时
 * 用 0 代入，但 raw_value 会被另一项的方向左右。
 *
 * **注意符号**：StockFundamentalFactor.net_profit_growth 在该表里是 "%" 形式
 * （如 23.5 表示 +23.5%），不是 0..1 小数。直接用即可，因子的横截面 zscore
 * 不依赖单位。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { StockFundamentalFactor } from '../../../models/StockFundamentalFactor';
import { stripSuffix, isFiniteNumber, lookbackStartDate } from './_helpers';

export const growthFactor: Factor = {
  name: 'growth',
  description: '0.6*净利润同比 + 0.4*营收同比；最新一期财务数据',
  category: 'growth',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 季报披露最长延迟 ~75 天（一季报 4 月底），取 120 天 lookback 兜底
    const startDate = lookbackStartDate(ctx.as_of_date, 120);

    const rows = (await StockFundamentalFactor.findAll({
      attributes: ['symbol', 'factor_date', 'net_profit_growth', 'revenue_growth'],
      where: {
        factor_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      net_profit_growth: any;
      revenue_growth: any;
    }>;

    // 取每只股票最新一行的增长数据
    interface Snap {
      np: number | null;
      rev: number | null;
      date: string;
    }
    const latestBySymbol = new Map<string, Snap>();
    for (const r of rows) {
      const cur = latestBySymbol.get(r.symbol);
      if (!cur || r.factor_date > cur.date) {
        const np = Number(r.net_profit_growth);
        const rev = Number(r.revenue_growth);
        latestBySymbol.set(r.symbol, {
          np: isFiniteNumber(np) ? np : null,
          rev: isFiniteNumber(rev) ? rev : null,
          date: r.factor_date,
        });
      }
    }

    const universeSet = new Set(ctx.universe);
    for (const [symbol, snap] of latestBySymbol.entries()) {
      const code = stripSuffix(symbol);
      if (!universeSet.has(code)) continue;
      if (snap.np === null && snap.rev === null) continue; // 两个都缺：放弃

      const np = snap.np ?? 0;
      const rev = snap.rev ?? 0;
      out.set(code, 0.6 * np + 0.4 * rev);
    }

    return out;
  },
};

factorRegistry.register(growthFactor);
