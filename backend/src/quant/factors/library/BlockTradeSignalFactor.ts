import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { BlockTrade } from '../../../models/BlockTrade';
import { Op, fn, col, literal } from 'sequelize';

/**
 * BlockTradeSignalFactor — 大宗交易折溢价信号
 *
 * 经济意义：大宗交易折溢价反映机构态度：
 *   - 大幅折价 (premium_pct < -5%) → 机构甩货，看空，alpha 负
 *   - 大幅溢价 (premium_pct > +5%) → 机构抢筹，看多，alpha 正
 *   - 平价附近 → 单纯流动性接续，无方向信号
 *
 * raw_value = 近 20 日大宗交易加权平均折溢价 × 总成交额占流通市值比例
 *   - 折溢价权重 = 单笔成交额
 *   - 数量 → log 防止单笔巨额主导
 *
 * 横截面 z-score 自动标准化。raw>0 → 抢筹偏好，raw<0 → 甩货偏好。
 *
 * 数据源：block_trades 表 (近 30 日明细已 sync)
 */
export const blockTradeSignalFactor: Factor = {
  name: 'block_trade_signal',
  description: '大宗交易折溢价信号 (近 20 日加权平均，正值=抢筹/负值=甩货)',
  category: 'flow',
  async compute(ctx) {
    const universe = ctx.universe || [];
    if (universe.length === 0) return new Map();

    const asOf = ctx.as_of_date;
    const lookbackDays = 20;
    const sinceDate = new Date(new Date(asOf).getTime() - lookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    // 拉近 20 日所有大宗交易，按 stock_code 聚合
    const rows = (await BlockTrade.findAll({
      where: {
        trade_date: { [Op.gte]: sinceDate, [Op.lte]: asOf },
        premium_pct: { [Op.ne]: null as any },
      },
      attributes: ['stock_code', 'premium_pct', 'amount'],
      raw: true,
    })) as any[];

    // 按 stock_code 聚合: 加权平均 premium × log(1 + 总成交额/亿元)
    const aggMap = new Map<string, { sum_weighted: number; total_amount: number }>();
    for (const r of rows) {
      const code = String(r.stock_code).trim();
      if (!code) continue;
      const premium = Number(r.premium_pct);
      const amount = Number(r.amount);
      if (!Number.isFinite(premium) || !Number.isFinite(amount) || amount <= 0) continue;
      const entry = aggMap.get(code) || { sum_weighted: 0, total_amount: 0 };
      entry.sum_weighted += premium * amount;
      entry.total_amount += amount;
      aggMap.set(code, entry);
    }

    const out = new Map<string, number>();
    for (const stockCode of universe) {
      const entry = aggMap.get(stockCode);
      if (!entry || entry.total_amount <= 0) continue;
      const avgPremium = entry.sum_weighted / entry.total_amount;
      // log 总成交额（亿）作放大系数 — 量小信号弱，量大信号强
      const amountFactor = Math.log1p(entry.total_amount / 1e8);
      const raw = avgPremium * amountFactor;
      if (Number.isFinite(raw)) {
        out.set(stockCode, raw);
      }
    }

    return out;
  },
};

factorRegistry.register(blockTradeSignalFactor);
