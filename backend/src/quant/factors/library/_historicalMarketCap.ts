/**
 * 历史市值 helper (audit M-8 修复, 2026-06-18; BD-2 raw_payload fallback 2026-06-23).
 *
 * 修复对象:
 *   - MoneyFlowFactor / InsiderTradeFactor / MarginFlowFactor 三个因子的分母原来
 *     用 `Stock.circulating_market_cap` (最新 snapshot), 导致回测 2020 年某交易日
 *     时用 "今天 (2026) 的市值" 除 "当时 (2020) 的资金流", 因子值有系统性偏差.
 *
 * 修复策略 (3 级 fallback):
 *   1) `StockValuationFactor.circulating_market_cap` (含 factor_date), 选
 *      `factor_date ≤ as_of_date` 最新一条 — 时点准确, 优先级最高.
 *   2) **BD-2 (2026-06-23) 新增**: `StockValuationFactor.raw_payload.snapshot.circulating_market_cap`
 *      JSONB 路径 — EastMoney provider 把 mcap 落在 raw_payload 而不是顶层列时, 仍能 fallback.
 *      实测当前两路径基本重叠 (都 ~360 票), 但**新代码生效后, 当未来 ingest 改用 jsonb-only 模式**,
 *      因子不需要再改.
 *   3) `Stock.circulating_market_cap` (最新 snapshot, 与旧行为兼容) — 实测当前全表 0 票,
 *      但保留路径以兼容历史 ingest 数据.
 *   - 三兜底都缺时 → 该股不入 Map (走 Pipeline 中性补全).
 *
 * 注意:
 *   - StockValuationFactor.circulating_market_cap 在 ingest 时入库, 时点准确 (与
 *     factor_date 同日). total_market_cap 也可用, 但 ingestion 历史上有部分行
 *     未填 total_market_cap, circulating 覆盖更全, 与 MoneyFlow 原口径一致.
 *   - 此 helper 单次 SQL `WHERE symbol IN ... AND factor_date <= as_of`, 然后
 *     in-memory 取每只 symbol 的最新一条. 性能 OK.
 *
 * **BD-2 限制说明 (2026-06-23 prod 实测)**:
 *   - 当前所有 mcap 来源 (column + payload + Stock 兜底) 都局限在 ~360 票 EastMoney
 *     ingest 池. 1) + 2) **合并仅 360 票**, 不能突破 360 上限 — 因为 raw_payload 和顶层列
 *     是同一批 row 的两份字段写法.
 *   - 真正的 mcap 覆盖缺口在 ingest 上游 — StockValuationFactor.eastmoney source 只
 *     每天 sync ~360 票 (与 `local_derived` 各占一半), 全市场 5500+ 票里其余 5176 票
 *     连 mcap 都没采集过. 真正修复需要扩 EastMoney sync universe 或接 TuShare.
 *   - 但 raw_payload fallback 对未来 ingest 改用 jsonb-only 模式 (顶层 column 留空) 仍是
 *     必要的健壮性兜底 — 不会回退当前覆盖率.
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
 * 从 StockValuationFactor.raw_payload 多个可能路径提取 circulating_market_cap.
 *
 * EastMoney provider 当前固定走 `snapshot.circulating_market_cap` 路径, 但保留
 * fallback 路径以适配旧的 / TuShare 等其他 ingest 形态:
 *   - snapshot.circulating_market_cap (current EastMoney)
 *   - circulating_market_cap (顶层 — 未来 normalized payload 可能直接放顶层)
 *   - snapshot.total_market_cap (流通 mcap 缺失时退到总市值)
 *   - total_market_cap (顶层退)
 *
 * **export 为单独函数让单测可独立断言路径优先级而无需起 Sequelize.**
 *
 * @param payload 任意 jsonb 对象 (Sequelize raw 返 plain object 或 null)
 * @returns      首个 > 0 的有效数值; 全部缺失/0 → null
 */
export function extractMcapFromPayload(payload: any): number | null {
  if (!payload || typeof payload !== 'object') return null;

  const tryPaths: any[] = [
    payload.snapshot?.circulating_market_cap,
    payload.circulating_market_cap,
    payload.snapshot?.total_market_cap,
    payload.total_market_cap,
  ];

  for (const v of tryPaths) {
    if (v === null || v === undefined) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (isFiniteNumber(n) && n > 0) return n;
  }
  return null;
}

/**
 * 按 universe (无后缀 stock_code) 批量取 as_of_date 当时的流通市值.
 *
 * 3 级 fallback:
 *   1) StockValuationFactor.circulating_market_cap 顶层列 (时点准确, 最优)
 *   2) StockValuationFactor.raw_payload.snapshot.circulating_market_cap (BD-2)
 *   3) Stock.circulating_market_cap (最新 snapshot, 旧兼容)
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

  // 1) + 2) StockValuationFactor 优先 (顶层列 + raw_payload fallback 同一行内 try)
  try {
    const valRows = (await StockValuationFactor.findAll({
      attributes: ['symbol', 'factor_date', 'circulating_market_cap', 'raw_payload'],
      where: {
        symbol: { [Op.in]: symbols },
        factor_date: { [Op.gte]: startIso, [Op.lte]: asOfDate },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      circulating_market_cap: any;
      raw_payload: any;
    }>;

    // 按 symbol 取最新 factor_date 的那一行; 内部对该行同时试 column + payload
    const latestBySymbol = new Map<string, { date: string; mcap: number }>();
    for (const r of valRows) {
      // 优先顶层列
      let mcap = Number(r.circulating_market_cap);
      if (!isFiniteNumber(mcap) || mcap <= 0) {
        // BD-2 兜底: raw_payload jsonb 路径
        const fromPayload = extractMcapFromPayload(r.raw_payload);
        if (fromPayload !== null) mcap = fromPayload;
      }
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

  // 3) 兜底: Stock.circulating_market_cap (旧行为, 仅补 valuation 表未命中的股票)
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
