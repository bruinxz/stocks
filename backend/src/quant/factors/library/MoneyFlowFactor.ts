/**
 * MoneyFlowFactor (主力资金因子) — US-010 + audit M-9 (交易日窗口) + audit M-8 (历史市值) 修复
 *
 * 公式：raw_value = sum(main_net_inflow[last 10 trading days]) / circulating_market_cap[as_of]
 *   - 分子：近 10 个**交易日**主力净流入累计（元）— audit M-9 修复, 用交易日窗口替代自然日近似;
 *   - 分母：**as_of_date 当时的流通市值** (元) — audit M-8 修复, 走 StockValuationFactor
 *     (含 factor_date) 取最新 ≤ as_of 一条; 兜底 Stock.circulating_market_cap (最新 snapshot).
 *     原来直接用 Stock 最新 snapshot, 回测 2020 用 2026 的市值除当时资金流, 偏差 30%+.
 *
 * 数据源：
 *   - StockMoneyFlowFactor 表 (main_net_inflow, 按 factor_date 窗口聚合)
 *   - StockValuationFactor 表 (circulating_market_cap, 按 factor_date 取最新 ≤ as_of)
 *   - Stock 表兜底
 *
 * 失效：
 *   - 10 个交易日窗口内一条都没有 → 跳过
 *   - circulating_market_cap 为空 / ≤ 0 → 跳过
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { stripSuffix, isFiniteNumber } from './_helpers';
import { tradingDayLookbackStartDate } from './_tradingDayWindow';

const StockMoneyFlowFactor = { findAll: async (_?: any): Promise<any[]> => [] };
const loadHistoricalCirculatingMarketCap = async (_symbols: string[], _asOf: string): Promise<Map<string, number>> => new Map();

/** 业务窗口: 近 10 个交易日 (audit M-9: 从 14 自然日改成精确 10 交易日) */
const WINDOW_TRADING_DAYS = 10;

export const moneyFlowFactor: Factor = {
  name: 'money_flow',
  description: '主力资金近 10 交易日累计净流入 / 当时流通市值',
  category: 'flow',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 1) 拉 as_of_date 当时的流通市值 (audit M-8: 不再用最新 snapshot)
    const mcapByCode = await loadHistoricalCirculatingMarketCap(ctx.universe, ctx.as_of_date);
    if (!mcapByCode.size) return out;

    // 2) 拉窗口内的 main_net_inflow (audit M-9: 用交易日窗口而非自然日)
    const startDate = await tradingDayLookbackStartDate(ctx.as_of_date, WINDOW_TRADING_DAYS);
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

    // 4) 按 universe 输出 (sum / market_cap[as_of])
    for (const [symbol, sum] of sumBySymbol.entries()) {
      const code = stripSuffix(symbol);
      const mcap = mcapByCode.get(code);
      if (typeof mcap !== 'number' || !isFiniteNumber(mcap) || mcap <= 0) continue;
      out.set(code, sum / mcap);
    }

    return out;
  },
};

factorRegistry.register(moneyFlowFactor);
