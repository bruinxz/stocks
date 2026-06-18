/**
 * 历史市值 helper (audit M-8 修复, 2026-06-18).
 *
 * 修复对象:
 *   - MoneyFlowFactor / InsiderTradeFactor / MarginFlowFactor 三个因子的分母原来
 *     用 `Stock.circulating_market_cap` (最新 snapshot), 导致回测 2020 年某交易日
 *     时用 "今天 (2026) 的市值" 除 "当时 (2020) 的资金流", 因子值有系统性偏差.
 *
 * 修复策略:
 *   - 优先用 `StockValuationFactor.circulating_market_cap` (含 factor_date), 选
 *     `factor_date ≤ as_of_date` 的最新一条 (容许 30 自然日内的滞后兜底次新股 /
 *     上市初期未入估值表的情况);
 *   - 兜底走 `Stock.circulating_market_cap` (最新 snapshot, 与旧行为兼容);
 *   - 双兜底都缺时 → 该股不入 Map (走 Pipeline 中性补全).
 *
 * 注意:
 *   - StockValuationFactor.circulating_market_cap 在 ingest 时入库, 时点准确 (与
 *     factor_date 同日). total_market_cap 也可用, 但 ingestion 历史上有部分行
 *     未填 total_market_cap, circulating 覆盖更全, 与 MoneyFlow 原口径一致.
 *   - 此 helper 单次 SQL `WHERE symbol IN ... AND factor_date <= as_of`, 然后
 *     in-memory 取每只 symbol 的最新一条. 性能 OK.
 *
 * 用法:
 *   const map = await loadHistoricalCirculatingMarketCap(universe, '2020-06-18');
 *   const mcap = map.get('600519');  // 2020-06-18 当时的流通市值, 不是今天的
 */

import { Op } from 'sequelize';
import { StockValuationFactor } from '../../../models/StockValuationFactor';
import { Stock } from '../../../models/Stock';
import { inferStockSymbol, stripSuffix, isFiniteNumber } from './_helpers';

/** 估值表查询窗口: as_of 前 30 自然日 (兜底次新股 / 估值表缺更新天) */
const VALUATION_LOOKBACK_DAYS = 30;

/**
 * 按 universe (无后缀 stock_code) 批量取 as_of_date 当时的流通市值.
 *
 * 优先路径: StockValuationFactor (含 factor_date), 选最新一条 ≤ as_of_date.
 * 兜底路径: Stock.circulating_market_cap (最新 snapshot, 旧行为).
 *
 * @returns Map<stock_code(无后缀), 市值数值>; 缺数据的股票不入 Map.
 */
export async function loadHistoricalCirculatingMarketCap(
  universe: string[],
  asOfDate: string
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!universe.length || !asOfDate) return out;

  const symbols = Array.from(new Set(universe.map(inferStockSymbol).filter(Boolean)));
  if (!symbols.length) return out;

  const startDate = new Date(`${asOfDate}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - VALUATION_LOOKBACK_DAYS);
  const startIso = startDate.toISOString().slice(0, 10);

  // 1) StockValuationFactor 优先
  try {
    const valRows = (await StockValuationFactor.findAll({
      attributes: ['symbol', 'factor_date', 'circulating_market_cap'],
      where: {
        symbol: { [Op.in]: symbols },
        factor_date: { [Op.gte]: startIso, [Op.lte]: asOfDate },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      circulating_market_cap: any;
    }>;

    // 按 symbol 取最新 factor_date 的那一行
    const latestBySymbol = new Map<string, { date: string; mcap: number }>();
    for (const r of valRows) {
      const mcap = Number(r.circulating_market_cap);
      if (!isFiniteNumber(mcap) || mcap <= 0) continue;
      const code = stripSuffix(r.symbol);
      if (!code) continue;
      const cur = latestBySymbol.get(code);
      if (!cur || r.factor_date > cur.date) {
        latestBySymbol.set(code, { date: r.factor_date, mcap });
      }
    }
    for (const [code, v] of latestBySymbol.entries()) {
      out.set(code, v.mcap);
    }
  } catch (_e) {
    // Sequelize 任何抛错都不应阻塞因子; 直接走兜底
  }

  // 2) 兜底: Stock.circulating_market_cap (旧行为, 仅补 valuation 表未命中的股票)
  const missing = universe.filter(code => !out.has(code));
  if (missing.length) {
    try {
      const missingSyms = Array.from(new Set(missing.map(inferStockSymbol).filter(Boolean)));
      const stockRows = (await Stock.findAll({
        attributes: ['symbol', 'circulating_market_cap'],
        where: { symbol: { [Op.in]: missingSyms } },
        raw: true,
      })) as unknown as Array<{ symbol: string; circulating_market_cap: any }>;
      for (const r of stockRows) {
        const code = stripSuffix(r.symbol);
        if (!code || out.has(code)) continue;
        const mcap = Number(r.circulating_market_cap);
        if (!isFiniteNumber(mcap) || mcap <= 0) continue;
        out.set(code, mcap);
      }
    } catch (_e) {
      // 兜底也失败 → 缺的股票就不入 Map
    }
  }

  return out;
}
