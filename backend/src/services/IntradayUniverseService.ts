/**
 * IntradayUniverseService — CE-A (2026-06-25)
 *
 * 给 "盘中高频 RT quote 刷新" + "实时机会推送" 类任务提供一个 ~500 票的活跃
 * universe, 替代之前 cron 每 20min 刷全市场 5500 票的重型路径 (容易 OOM /
 * 超时, 也让有意义的活跃股延迟掉到 20min).
 *
 * 来源 (union → distinct → 截断 max):
 *   1. PaperTradingPosition: 所有 active position (quantity > 0) 跨 portfolio 去重 symbol
 *   2. FavoriteStock / 自选股: TODO (暂返空, 将来 product 加入"实时机会订阅"再补)
 *   3. 涨幅榜 Top200: 取 realtime_quotes 最近一次刷新中 change_percent DESC 前 200
 *   4. 跌幅榜 Top50: change_percent ASC 前 50 (做反弹机会)
 *   5. 昨日涨停: LimitUpStock 最近 1 个有数据交易日全部
 *   6. 今日成交额 Top100: realtime_quotes 最近一次按 turnover DESC 前 100,
 *      fallback (current_price × volume) DESC 前 100
 *
 * 全部子查询 fail-OPEN: 单子失败仅 logger.warn 返回 partial result. 全部失败
 * 走 fallback: stocks 表 is_listed=true 按 total_market_cap DESC 前 max 500 票.
 *
 * Min/Max 守卫 (默认 min=200, max=500): 不足 min 时用市值兜底补到 min, 超过 max
 * 截断 (优先保留 持仓 → 涨停 → 涨幅榜 → 跌幅榜 → 成交额 → 市值兜底, 通过
 * priority 标签实现).
 *
 * Design constraints (与 services/CLAUDE.md 一致):
 * - DataSource DI: PRODUCTION_INTRADAY_UNIVERSE_DATA_SOURCE Sequelize 实现 +
 *   单测注入 fake 完全脱 DB.
 * - 纯函数 helpers 全 export (mergeUniverse / truncateToMax / etc).
 * - fail-OPEN: 任一子查询 throw → 仅 warn 不阻塞主流程.
 * - 不写库: 本 service 只读 + 内存合并; 不持久化任何中间结果.
 */

import { logger } from '../utils/logger';
import { normalizeSymbol } from '../utils/stockSymbol';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type IntradayUniverseSource =
  | 'position'
  | 'favorite'
  | 'top_gainer'
  | 'top_loser'
  | 'yesterday_limit_up'
  | 'top_turnover'
  | 'market_cap_fallback';

export interface IntradayUniverseEntry {
  symbol: string;
  /** 加入时被哪个/哪些子源命中, 用于截断时排序保留. */
  sources: IntradayUniverseSource[];
}

export interface ResolveUniverseOptions {
  /** 最少 symbol 数, 不足则用市值兜底补齐. 默认 200. */
  min_size?: number;
  /** 最多 symbol 数, 超过则按优先级截断. 默认 500. */
  max_size?: number;
  /** 是否纳入涨/跌幅榜 + 成交额榜, 默认 true. 仅持仓 / 自选场景可关. */
  include_market_movers?: boolean;
}

export interface IntradayUniverseDataSource {
  /** 持仓股: 所有 portfolio 的 quantity > 0 positions, 去重 symbol. */
  listPositionSymbols(): Promise<string[]>;
  /** 自选股: 当前 TODO 返空; 留方法以便后续接入 FavoriteStock. */
  listFavoriteSymbols(): Promise<string[]>;
  /** realtime_quotes 最近一次 trade_date 涨幅榜 Top N. */
  listTopGainerSymbols(limit: number): Promise<string[]>;
  /** realtime_quotes 最近一次 trade_date 跌幅榜 Top N. */
  listTopLoserSymbols(limit: number): Promise<string[]>;
  /** LimitUpStock 最近 1 交易日全部 stock_code → 解析为 normalizeSymbol. */
  listYesterdayLimitUpSymbols(): Promise<string[]>;
  /** realtime_quotes 最近一次 trade_date 成交额 Top N (fallback current_price × volume). */
  listTopTurnoverSymbols(limit: number): Promise<string[]>;
  /** 兜底: stocks 表 is_listed=true 按 total_market_cap DESC 前 N. */
  listTopMarketCapSymbols(limit: number): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Pure helpers (全部 export 供单测)
// ---------------------------------------------------------------------------

const DEFAULT_MIN_SIZE = 200;
const DEFAULT_MAX_SIZE = 500;

/**
 * 按 priority 顺序保留 entries, 截到 maxSize.
 *   1. position
 *   2. yesterday_limit_up
 *   3. top_gainer
 *   4. top_loser
 *   5. top_turnover
 *   6. favorite
 *   7. market_cap_fallback
 *
 * 同一 symbol 已合并 sources, 取该 symbol 命中的最高优先级 source 决定排序权重.
 * tie-break: 按字母序稳定排.
 */
const SOURCE_PRIORITY: Record<IntradayUniverseSource, number> = {
  position: 1,
  yesterday_limit_up: 2,
  top_gainer: 3,
  top_loser: 4,
  top_turnover: 5,
  favorite: 6,
  market_cap_fallback: 9,
};

export function truncateToMax(
  entries: IntradayUniverseEntry[],
  maxSize: number
): IntradayUniverseEntry[] {
  if (entries.length <= maxSize) return [...entries];
  const sorted = [...entries].sort((a, b) => {
    const pa = Math.min(...a.sources.map(s => SOURCE_PRIORITY[s] ?? 99));
    const pb = Math.min(...b.sources.map(s => SOURCE_PRIORITY[s] ?? 99));
    if (pa !== pb) return pa - pb;
    return a.symbol.localeCompare(b.symbol);
  });
  return sorted.slice(0, maxSize);
}

/**
 * 把每个 batch 的 raw symbols normalize + dedupe, 并 merge 到 entries map.
 * 同一 symbol 多次出现累计 source 标签.
 */
export function mergeSymbolsIntoMap(
  map: Map<string, IntradayUniverseEntry>,
  symbols: ReadonlyArray<string>,
  source: IntradayUniverseSource
): void {
  for (const raw of symbols) {
    const sym = normalizeSymbol(String(raw || ''));
    if (!sym) continue;
    const existing = map.get(sym);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      map.set(sym, { symbol: sym, sources: [source] });
    }
  }
}

/** 把 LimitUpStock.stock_code (无前缀 / 含前缀均兼容) 转 normalizeSymbol. */
export function stockCodeToSymbol(stockCode: string): string | null {
  if (!stockCode) return null;
  const raw = String(stockCode).trim();
  if (!raw) return null;
  const normalized = normalizeSymbol(raw);
  return normalized || null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class IntradayUniverseService {
  constructor(
    private ds: IntradayUniverseDataSource = PRODUCTION_INTRADAY_UNIVERSE_DATA_SOURCE
  ) {}

  /**
   * 解析活跃 universe. 返回 distinct symbol 列表, 长度 ∈ [min_size, max_size].
   *
   * 任一子源失败仅 warn (fail-OPEN). 全部空 → fallback 市值 Top max_size.
   * 不足 min_size → 用市值兜底补齐.
   */
  async resolveUniverse(options: ResolveUniverseOptions = {}): Promise<string[]> {
    const minSize = Math.max(1, options.min_size ?? DEFAULT_MIN_SIZE);
    const maxSize = Math.max(minSize, options.max_size ?? DEFAULT_MAX_SIZE);
    const includeMovers = options.include_market_movers !== false;

    const map = new Map<string, IntradayUniverseEntry>();

    // 1) 持仓股
    try {
      const positions = await this.ds.listPositionSymbols();
      mergeSymbolsIntoMap(map, positions, 'position');
    } catch (err: unknown) {
      logger.warn(
        `[IntradayUniverseService] listPositionSymbols failed: ${(err as Error)?.message || err}`
      );
    }

    // 2) 自选股 (现状 TODO, ds 实现返空)
    try {
      const favorites = await this.ds.listFavoriteSymbols();
      mergeSymbolsIntoMap(map, favorites, 'favorite');
    } catch (err: unknown) {
      logger.warn(
        `[IntradayUniverseService] listFavoriteSymbols failed: ${(err as Error)?.message || err}`
      );
    }

    // 3) 昨日涨停 (本日 LimitUpStock 当日数据要盘后才入库 → 取最近 1 个有数据交易日)
    try {
      const limits = await this.ds.listYesterdayLimitUpSymbols();
      mergeSymbolsIntoMap(map, limits, 'yesterday_limit_up');
    } catch (err: unknown) {
      logger.warn(
        `[IntradayUniverseService] listYesterdayLimitUpSymbols failed: ${
          (err as Error)?.message || err
        }`
      );
    }

    if (includeMovers) {
      // 4) 涨幅榜
      try {
        const gainers = await this.ds.listTopGainerSymbols(200);
        mergeSymbolsIntoMap(map, gainers, 'top_gainer');
      } catch (err: unknown) {
        logger.warn(
          `[IntradayUniverseService] listTopGainerSymbols failed: ${(err as Error)?.message || err}`
        );
      }

      // 5) 跌幅榜
      try {
        const losers = await this.ds.listTopLoserSymbols(50);
        mergeSymbolsIntoMap(map, losers, 'top_loser');
      } catch (err: unknown) {
        logger.warn(
          `[IntradayUniverseService] listTopLoserSymbols failed: ${(err as Error)?.message || err}`
        );
      }

      // 6) 今日成交额
      try {
        const top = await this.ds.listTopTurnoverSymbols(100);
        mergeSymbolsIntoMap(map, top, 'top_turnover');
      } catch (err: unknown) {
        logger.warn(
          `[IntradayUniverseService] listTopTurnoverSymbols failed: ${(err as Error)?.message || err}`
        );
      }
    }

    // Fallback: 全部子源加起来还是空 → 直接走市值兜底 Top maxSize
    if (map.size === 0) {
      try {
        const fallback = await this.ds.listTopMarketCapSymbols(maxSize);
        mergeSymbolsIntoMap(map, fallback, 'market_cap_fallback');
      } catch (err: unknown) {
        logger.warn(
          `[IntradayUniverseService] listTopMarketCapSymbols (fallback) failed: ${
            (err as Error)?.message || err
          }`
        );
      }
      // 仍空 → 真返空数组 (caller 决定怎么处理)
      if (map.size === 0) {
        logger.warn('[IntradayUniverseService] resolveUniverse returning EMPTY (all sources failed)');
        return [];
      }
    } else if (map.size < minSize) {
      // 不足 min → 用市值兜底补到 min
      try {
        const fill = await this.ds.listTopMarketCapSymbols(minSize);
        mergeSymbolsIntoMap(map, fill, 'market_cap_fallback');
      } catch (err: unknown) {
        logger.warn(
          `[IntradayUniverseService] listTopMarketCapSymbols (fill to min) failed: ${
            (err as Error)?.message || err
          }`
        );
      }
    }

    const entries = Array.from(map.values());
    const truncated = truncateToMax(entries, maxSize);
    return truncated.map(e => e.symbol);
  }
}

// ---------------------------------------------------------------------------
// Production DataSource — Sequelize 真实表查询
// ---------------------------------------------------------------------------

class DefaultIntradayUniverseDataSource implements IntradayUniverseDataSource {
  async listPositionSymbols(): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PaperTradingPosition } = require('../models/PaperTradingPosition');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Op } = require('sequelize');
    const rows: Array<{ symbol: string }> = await PaperTradingPosition.findAll({
      attributes: ['symbol'],
      where: { quantity: { [Op.gt]: 0 } },
      group: ['symbol'],
      raw: true,
    });
    return (rows || [])
      .map(r => String((r as any)?.symbol || '').trim())
      .filter(Boolean);
  }

  async listFavoriteSymbols(): Promise<string[]> {
    // TODO(CE-A 后续): 等"实时机会订阅"功能落地后再实装. 现状直接返空, 让本 source
    // 不影响合并结果. 一定要保留接口让单测能验"空返回也不抛".
    return [];
  }

  async listTopGainerSymbols(limit: number): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RealtimeQuote } = require('../models/RealtimeQuote');
    const sequelize = RealtimeQuote.sequelize;
    if (!sequelize) return [];
    // 最近一次有数据的 trade_date (避免跨日混合数据)
    const [latestRow]: any[] = await sequelize.query(
      `SELECT MAX(trade_date) AS latest FROM realtime_quotes`,
      { type: sequelize.QueryTypes.SELECT }
    );
    const latest = latestRow?.latest;
    if (!latest) return [];
    // DISTINCT ON 取每只票当日最新一行, 然后按 change_percent DESC 取 limit
    const rows: Array<{ symbol: string }> = await sequelize.query(
      `SELECT symbol
       FROM (
         SELECT DISTINCT ON (symbol) symbol, change_percent
         FROM realtime_quotes
         WHERE trade_date = :latest
           AND change_percent IS NOT NULL
         ORDER BY symbol, quote_time DESC
       ) latest
       ORDER BY change_percent DESC
       LIMIT :limit`,
      {
        replacements: { latest, limit },
        type: sequelize.QueryTypes.SELECT,
      }
    );
    return (rows || []).map(r => String(r.symbol || '')).filter(Boolean);
  }

  async listTopLoserSymbols(limit: number): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RealtimeQuote } = require('../models/RealtimeQuote');
    const sequelize = RealtimeQuote.sequelize;
    if (!sequelize) return [];
    const [latestRow]: any[] = await sequelize.query(
      `SELECT MAX(trade_date) AS latest FROM realtime_quotes`,
      { type: sequelize.QueryTypes.SELECT }
    );
    const latest = latestRow?.latest;
    if (!latest) return [];
    const rows: Array<{ symbol: string }> = await sequelize.query(
      `SELECT symbol
       FROM (
         SELECT DISTINCT ON (symbol) symbol, change_percent
         FROM realtime_quotes
         WHERE trade_date = :latest
           AND change_percent IS NOT NULL
         ORDER BY symbol, quote_time DESC
       ) latest
       ORDER BY change_percent ASC
       LIMIT :limit`,
      {
        replacements: { latest, limit },
        type: sequelize.QueryTypes.SELECT,
      }
    );
    return (rows || []).map(r => String(r.symbol || '')).filter(Boolean);
  }

  async listYesterdayLimitUpSymbols(): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LimitUpStock } = require('../models/LimitUpStock');
    const sequelize = LimitUpStock.sequelize;
    if (!sequelize) return [];
    // 取 limit_up_stocks 最近一个有数据的 trade_date 全部
    const [latestRow]: any[] = await sequelize.query(
      `SELECT MAX(trade_date) AS latest FROM limit_up_stocks`,
      { type: sequelize.QueryTypes.SELECT }
    );
    const latest = latestRow?.latest;
    if (!latest) return [];
    const rows: Array<{ stock_code: string }> = await sequelize.query(
      `SELECT stock_code FROM limit_up_stocks WHERE trade_date = :latest`,
      {
        replacements: { latest },
        type: sequelize.QueryTypes.SELECT,
      }
    );
    const out: string[] = [];
    for (const r of rows || []) {
      const sym = stockCodeToSymbol(String((r as any)?.stock_code || ''));
      if (sym) out.push(sym);
    }
    return out;
  }

  async listTopTurnoverSymbols(limit: number): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RealtimeQuote } = require('../models/RealtimeQuote');
    const sequelize = RealtimeQuote.sequelize;
    if (!sequelize) return [];
    const [latestRow]: any[] = await sequelize.query(
      `SELECT MAX(trade_date) AS latest FROM realtime_quotes`,
      { type: sequelize.QueryTypes.SELECT }
    );
    const latest = latestRow?.latest;
    if (!latest) return [];
    // COALESCE(turnover, current_price * volume): 老数据 turnover 可能空, 用 price × vol 兜底
    const rows: Array<{ symbol: string }> = await sequelize.query(
      `SELECT symbol
       FROM (
         SELECT DISTINCT ON (symbol)
           symbol,
           COALESCE(turnover, current_price * volume, 0) AS amount
         FROM realtime_quotes
         WHERE trade_date = :latest
         ORDER BY symbol, quote_time DESC
       ) latest
       WHERE amount > 0
       ORDER BY amount DESC
       LIMIT :limit`,
      {
        replacements: { latest, limit },
        type: sequelize.QueryTypes.SELECT,
      }
    );
    return (rows || []).map(r => String(r.symbol || '')).filter(Boolean);
  }

  async listTopMarketCapSymbols(limit: number): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Stock } = require('../models/Stock');
    const rows: Array<{ symbol: string }> = await Stock.findAll({
      attributes: ['symbol'],
      where: { is_listed: true },
      order: [['total_market_cap', 'DESC NULLS LAST']],
      limit,
      raw: true,
    });
    return (rows || [])
      .map(r => String((r as any)?.symbol || '').trim())
      .filter(Boolean);
  }
}

export const PRODUCTION_INTRADAY_UNIVERSE_DATA_SOURCE: IntradayUniverseDataSource =
  new DefaultIntradayUniverseDataSource();

export const intradayUniverseService = new IntradayUniverseService();
