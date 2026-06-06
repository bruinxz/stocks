/**
 * DragonTigerFactor (龙虎榜游资因子) — US-010
 *
 * 公式：raw_value = count(distinct trade_date) WHERE
 *           trade_date ∈ [as_of_date - 20 自然日, as_of_date]
 *           AND is_famous_yz = true
 *           AND net_amount > 0
 *
 * 即：近 20 自然日内，该股出现知名游资席位**净买入**的**独立日数**。
 *   - 用 "天数" 而非 "笔数"：龙虎榜单日 buyer×seller 笛卡尔展开下，
 *     一只股票一天可能有 5-10 行 is_famous_yz=true；count(笔数) 会让
 *     一天爆量游资的票 vs 持续多天小量游资的票完全不可比。
 *   - 用 "净买入" (net_amount > 0)：游资同时出现在买/卖席位时不算抢筹。
 *
 * 数据源：DragonTigerBoard 表
 *   - 主键 (trade_date, stock_code, buyer_seat, seller_seat)
 *   - 字段：is_famous_yz boolean、net_amount DECIMAL
 *
 * 失效：窗口内一条都没有的股票 → 不入 Map（让 Pipeline 补中性=0.5 percentile，
 * 而不是给 0 干扰横截面 zscore 的均值）。
 * 注：count=0 vs "未出现在龙虎榜" 语义不同；前者会让大量股票挤在 raw_value=0，
 * 把横截面 zscore 拉成 "0 vs 正" 的二元分布。中性补全反而更纯粹。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { DragonTigerBoard } from '../../../models/DragonTigerBoard';
import { isFiniteNumber, lookbackStartDate } from './_helpers';

const WINDOW_DAYS = 20;

export const dragonTigerFactor: Factor = {
  name: 'dragon_tiger',
  description: '近 20 自然日知名游资席位净买入的独立交易日数',
  category: 'flow',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    const startDate = lookbackStartDate(ctx.as_of_date, WINDOW_DAYS);

    const rows = (await DragonTigerBoard.findAll({
      attributes: ['stock_code', 'trade_date', 'net_amount'],
      where: {
        stock_code: { [Op.in]: ctx.universe },
        trade_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
        is_famous_yz: true,
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      trade_date: string;
      net_amount: any;
    }>;

    // 按 (stock_code, trade_date) 去重 —— 同一天多笔游资行只算 1
    // 同时要求至少有 1 行 net_amount > 0
    const positiveDatesByCode = new Map<string, Set<string>>();
    for (const r of rows) {
      const net = Number(r.net_amount);
      if (!isFiniteNumber(net) || net <= 0) continue;
      const set = positiveDatesByCode.get(r.stock_code) ?? new Set<string>();
      set.add(r.trade_date);
      positiveDatesByCode.set(r.stock_code, set);
    }

    for (const [code, dateSet] of positiveDatesByCode.entries()) {
      if (dateSet.size > 0) {
        out.set(code, dateSet.size);
      }
    }

    return out;
  },
};

factorRegistry.register(dragonTigerFactor);
