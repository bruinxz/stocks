import { MarketHotSearch } from '../../models/MarketHotSearch';
import { logger } from '../../utils/logger';
import {
  MarketHotSearchClient,
  marketHotSearchClient,
} from '../sources/MarketHotSearchClient';

/**
 * MarketHotSearchSyncService — Batch AH (2026-06-18).
 *
 * `syncDate(date)`:
 *   1. client.fetchHotSearch(limit) — 拉百度 A 股搜索热度榜
 *   2. best-effort 模糊匹配 keyword → stock_code (best-effort, 未匹配时 null)
 *   3. Service-layer 2-tuple Map dedup 兜底 (US-030 范式)
 *   4. bulkCreate + updateOnDuplicate
 *
 * 实时快照: trade_date 由 caller 贴标签. 失败不抛.
 */
export interface MarketHotSearchSyncResult {
  trade_date: string;
  fetched: number;
  upserted: number;
  skipped: boolean;
  error?: string;
}

export interface MarketHotSearchSyncOptions {
  limit?: number;
}

export class MarketHotSearchSyncService {
  private client: MarketHotSearchClient;

  constructor(client: MarketHotSearchClient = marketHotSearchClient) {
    this.client = client;
  }

  async syncDate(
    tradeDate: string,
    options: MarketHotSearchSyncOptions = {}
  ): Promise<MarketHotSearchSyncResult> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    try {
      const rows = await this.client.fetchHotSearch(limit);
      if (rows.length === 0) {
        return { trade_date: tradeDate, fetched: 0, upserted: 0, skipped: false };
      }

      // best-effort keyword → stock_code 映射 (Stock 表 name 完全匹配)
      let nameToCode = new Map<string, string>();
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Stock } = require('../../models/Stock');
        const keywords = rows.map(r => r.keyword);
        const stocks = (await Stock.findAll({
          attributes: ['symbol', 'name'],
          where: { name: keywords as any },
          raw: true,
        })) as Array<{ symbol: string; name: string }>;
        for (const s of stocks) {
          const code = String(s.symbol || '').replace(/\.[A-Z]+$/, '');
          if (/^\d{6}$/.test(code)) {
            nameToCode.set(s.name, code);
          }
        }
      } catch (err) {
        logger.warn(`MarketHotSearch name→code 映射失败: ${(err as Error).message}`);
      }

      const records = new Map<string, Record<string, any>>();
      for (const r of rows) {
        const kw = (r.keyword || '').trim();
        if (!kw) continue;
        const key = `${tradeDate}|${kw}`;
        records.set(key, {
          trade_date: tradeDate,
          keyword: kw.slice(0, 118),
          rank: r.rank,
          search_index: r.search_index,
          change_rate: r.change_rate,
          related_stock_code: nameToCode.get(kw) ?? null,
          source: 'baidu_a',
          raw_payload: r.raw_payload || {},
        });
      }

      const arr = Array.from(records.values());
      if (arr.length === 0) {
        return { trade_date: tradeDate, fetched: rows.length, upserted: 0, skipped: false };
      }
      await MarketHotSearch.bulkCreate(arr as any, {
        updateOnDuplicate: [
          'rank',
          'search_index',
          'change_rate',
          'related_stock_code',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });
      logger.info(`MarketHotSearch ${tradeDate}: fetched=${rows.length}, upserted=${arr.length}`);
      return { trade_date: tradeDate, fetched: rows.length, upserted: arr.length, skipped: false };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`MarketHotSearch ${tradeDate} failed: ${message}`);
      return { trade_date: tradeDate, fetched: 0, upserted: 0, skipped: false, error: message };
    }
  }
}

export const marketHotSearchSyncService = new MarketHotSearchSyncService();
