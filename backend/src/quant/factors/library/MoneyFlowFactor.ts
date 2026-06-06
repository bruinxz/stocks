/**
 * MoneyFlowFactor (主力资金因子) — US-010
 *
 * 公式：raw_value = sum(main_net_inflow[last 10 days]) / circulating_market_cap
 *   - 分子：近 10 个交易日主力净流入累计（元）
 *   - 分母：流通市值（元）—— 归一化避免大市值股票数值膨胀
 *
 * 数据源：StockMoneyFlowFactor 表
 *   - 字段：symbol（带后缀）、factor_date、main_net_inflow
 *   - 取 factor_date ∈ [as_of_date - 14, as_of_date] 兜底周末
 * + Stock 表的 circulating_market_cap（最新流通市值）
 *
 * 失效：
 *   - 10 日窗口内一条都没有 → 跳过
 *   - circulating_market_cap 为空 / ≤ 0 → 跳过
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { StockMoneyFlowFactor } from '../../../models/StockMoneyFlowFactor';
import { loadStocksByCodes, stripSuffix, isFiniteNumber, lookbackStartDate } from './_helpers';

const WINDOW_DAYS = 14; // 10 交易日 ≈ 14 自然日

export const moneyFlowFactor: Factor = {
  name: 'money_flow',
  description: '主力资金近 10 交易日累计净流入 / 流通市值',
  category: 'flow',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 1) 拉 Stock 表的 circulating_market_cap（用 _helpers.loadStocksByCodes）
    const stockByCode = await loadStocksByCodes(ctx.universe, [
      'id',
      'symbol',
      'circulating_market_cap',
    ]);
    if (!stockByCode.size) return out;

    // 2) 拉窗口内的 main_net_inflow
    const startDate = lookbackStartDate(ctx.as_of_date, WINDOW_DAYS);
    const rows = (await StockMoneyFlowFactor.findAll({
      attributes: ['symbol', 'factor_date', 'main_net_inflow'],
      where: {
        factor_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      main_net_inflow: any;
    }>;

    // 3) 按 symbol 累计 net_inflow
    const sumBySymbol = new Map<string, number>();
    for (const r of rows) {
      const v = Number(r.main_net_inflow);
      if (!isFiniteNumber(v)) continue;
      sumBySymbol.set(r.symbol, (sumBySymbol.get(r.symbol) ?? 0) + v);
    }

    // 4) 按 universe 输出 (sum / market_cap)
    for (const [symbol, sum] of sumBySymbol.entries()) {
      const code = stripSuffix(symbol);
      const s = stockByCode.get(code);
      if (!s) continue;
      const mcap = Number(s.circulating_market_cap);
      if (!isFiniteNumber(mcap) || mcap <= 0) continue;
      out.set(code, sum / mcap);
    }

    return out;
  },
};

factorRegistry.register(moneyFlowFactor);
