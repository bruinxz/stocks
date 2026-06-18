import { Op } from 'sequelize';
import { SocialSentimentSnapshot } from '../../models/SocialSentimentSnapshot';
import { MarketHotSearch } from '../../models/MarketHotSearch';
import { logger } from '../../utils/logger';
import { SocialSentimentClient, socialSentimentClient } from '../sources/SocialSentimentClient';

/**
 * SocialSentimentSyncService — Batch AH (2026-06-18).
 *
 * `syncDate(date, options?)`:
 *   1. 决定 universe (传入 stockCodes 或 auto-load 流通市值 top 200)
 *   2. 调 client.fetchSnapshot(codes) 拿合并的 hot_rank + comment_score 行
 *   3. left-join MarketHotSearch 当日数据 → 填 baidu_search_rank
 *   4. 跨日 derived: loadRecentRanks(date, codes, 5) → 算 rank_5d_avg + rank_breakout_delta
 *      (同 US-007 continuous_days 范式, 跨日字段 TS 算不让 Python 知道)
 *   5. Service-layer 2-tuple Map dedup 兜底 (US-030 同款)
 *   6. bulkCreate + updateOnDuplicate upsert
 *
 * **AKShare 实时快照特性 (同 US-008 IndustryFlow)**: 接口无日期参数, trade_date
 * 是 caller 在盘后调度时贴的标签. 历史回填会得到"当下数据贴历史日期" 的污染.
 *
 * **失败兜底**: client 抛出 → 返回 SyncDateResult.error, 不抛 (与 IndustrySyncService
 * 同款形态便于 syncRange 跑完不中断).
 */
export interface SocialSentimentSyncResult {
  trade_date: string;
  universe_size: number;
  fetched: number;
  upserted: number;
  /** 算 rank_breakout_delta 的可用历史天数; 第一周 deploy < 5 */
  history_days_available: number;
  skipped: boolean;
  error?: string;
}

export interface SocialSentimentSyncOptions {
  /** 显式 universe; 不传则 auto-load 流通市值 top N */
  stockCodes?: string[];
  /** auto-load 时的 top N 上限, 默认 200 */
  universeLimit?: number;
  /** rank breakout 回看天数, 默认 5 */
  rankLookbackDays?: number;
}

export interface SocialSentimentRangeOptions extends SocialSentimentSyncOptions {
  skipExisting?: boolean;
  intervalMs?: number;
}

export class SocialSentimentSyncService {
  private client: SocialSentimentClient;

  constructor(client: SocialSentimentClient = socialSentimentClient) {
    this.client = client;
  }

  async syncDate(
    tradeDate: string,
    options: SocialSentimentSyncOptions = {}
  ): Promise<SocialSentimentSyncResult> {
    const universeLimit = Math.max(10, Math.min(1000, options.universeLimit ?? 200));
    const rankLookback = Math.max(1, Math.min(20, options.rankLookbackDays ?? 5));

    try {
      // 1) 决定 universe
      let codes = options.stockCodes;
      if (!codes || codes.length === 0) {
        codes = await this.loadUniverseByMarketCap(universeLimit);
      }
      if (codes.length === 0) {
        return {
          trade_date: tradeDate,
          universe_size: 0,
          fetched: 0,
          upserted: 0,
          history_days_available: 0,
          skipped: false,
          error: 'universe 为空 (Stock 表无 listed 或无 circulating_market_cap 数据)',
        };
      }

      // 2) 拉合并快照
      const rows = await this.client.fetchSnapshot(codes);
      if (rows.length === 0) {
        return {
          trade_date: tradeDate,
          universe_size: codes.length,
          fetched: 0,
          upserted: 0,
          history_days_available: 0,
          skipped: false,
        };
      }

      // 3) 当日 MarketHotSearch left-join
      const baiduRankByCode = new Map<string, number>();
      try {
        const hotSearchRows = (await MarketHotSearch.findAll({
          where: { trade_date: tradeDate },
          attributes: ['keyword', 'rank', 'related_stock_code'],
          raw: true,
        })) as unknown as Array<{
          keyword: string;
          rank: number;
          related_stock_code?: string | null;
        }>;
        // 先按 related_stock_code 直接映射, 再 best-effort 用 keyword 匹配 stock_name
        const nameToCode = new Map<string, string>();
        for (const r of rows) {
          if (r.stock_name) nameToCode.set(r.stock_name, r.stock_code);
        }
        for (const h of hotSearchRows) {
          if (h.related_stock_code) {
            baiduRankByCode.set(h.related_stock_code, h.rank);
          } else if (h.keyword && nameToCode.has(h.keyword)) {
            baiduRankByCode.set(nameToCode.get(h.keyword)!, h.rank);
          }
        }
      } catch (err) {
        logger.warn(
          `SocialSentimentSync: MarketHotSearch left-join failed, baidu_search_rank 留空: ${
            (err as Error).message
          }`
        );
      }

      // 4) 跨日 derived: rank_5d_avg + rank_breakout_delta
      const recentRanks = await this.loadRecentRanks(
        tradeDate,
        rows.map(r => r.stock_code),
        rankLookback
      );
      let historyDaysAvailable = 0;
      for (const dates of recentRanks.values()) {
        if (dates.size > historyDaysAvailable) historyDaysAvailable = dates.size;
      }

      // 5) 组装 records + in-memory dedup
      const records = new Map<string, Record<string, any>>();
      for (const r of rows) {
        const key = `${tradeDate}|${r.stock_code}`;
        const rank5dAvg = this.computeRank5dAvg(recentRanks.get(r.stock_code));
        const breakout =
          rank5dAvg != null && r.hot_rank_em != null ? rank5dAvg - r.hot_rank_em : null;
        records.set(key, {
          trade_date: tradeDate,
          stock_code: r.stock_code,
          stock_name: r.stock_name || null,
          hot_rank_em: r.hot_rank_em,
          comment_score: r.comment_score,
          institution_participation: r.institution_participation,
          retail_desire: r.retail_desire,
          focus_index: r.focus_index,
          baidu_search_rank: baiduRankByCode.get(r.stock_code) ?? null,
          rank_5d_avg: rank5dAvg,
          rank_breakout_delta: breakout,
          source: 'eastmoney+baidu',
          raw_payload: r.raw_payload || {},
        });
      }

      const arr = Array.from(records.values());
      if (arr.length === 0) {
        return {
          trade_date: tradeDate,
          universe_size: codes.length,
          fetched: rows.length,
          upserted: 0,
          history_days_available: historyDaysAvailable,
          skipped: false,
        };
      }

      await SocialSentimentSnapshot.bulkCreate(arr as any, {
        updateOnDuplicate: [
          'stock_name',
          'hot_rank_em',
          'comment_score',
          'institution_participation',
          'retail_desire',
          'focus_index',
          'baidu_search_rank',
          'rank_5d_avg',
          'rank_breakout_delta',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });
      logger.info(
        `SocialSentiment ${tradeDate}: fetched=${rows.length}, upserted=${arr.length}, universe=${codes.length}, history_days=${historyDaysAvailable}`
      );
      return {
        trade_date: tradeDate,
        universe_size: codes.length,
        fetched: rows.length,
        upserted: arr.length,
        history_days_available: historyDaysAvailable,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`SocialSentiment ${tradeDate} failed: ${message}`);
      return {
        trade_date: tradeDate,
        universe_size: 0,
        fetched: 0,
        upserted: 0,
        history_days_available: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * Universe: 流通市值 top N 的 6 位代码列表 (排除 ST).
   *
   * 兼容 stocks.symbol 两种格式:
   *   - sz.300085 / sh.600519 / bj.920011  (prefix.code)
   *   - 300085.SZ / 600519.SH / 920011.BJ  (code.suffix)
   *
   * Fallback: 若 circulating_market_cap 列全为 0 / null (生产历史问题),
   * 退化为 ORDER BY id ASC (按 listing 顺序近似主板, 通常 top N 是大市值).
   */
  async loadUniverseByMarketCap(limit: number): Promise<string[]> {
    // CRITICAL: 必须 require database.ts 让 sequelize 实例创建 + addModels
    // 注册所有模型. 单独 cli 调用 (脱离 server 启动流程) 若仅 require Stock,
    // sequelize 实例可能还没初始化 → Stock 报 "Model not initialized".
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../config/database');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Stock } = require('../../models/Stock');
    try {
      // 探测: circulating_market_cap 是否真的有数据
      const hasMcap = await Stock.count({
        where: { circulating_market_cap: { [Op.gt]: 0 } },
      });
      // 退化策略: 没有市值数据时, 按 symbol 前缀过滤主板/创业板 (排除北交所
      // 920/430 等 stock_comment_em 不覆盖的小盘), 然后取 N
      const orderBy: any = hasMcap > 0 ? [['circulating_market_cap', 'DESC']] : [['id', 'ASC']];

      const where: any = {
        is_listed: true,
        name: { [Op.notLike]: '%ST%' },
      };
      if (hasMcap === 0) {
        // 主板 SH 600xxx, SH 601xxx, 深 000xxx, 创业板 300xxx, 科创 688xxx
        // 排除 BJ 920xxx / 430xxx (东财 comment_em 不覆盖)
        where.symbol = {
          [Op.or]: [
            { [Op.iLike]: 'sh.6%' },
            { [Op.iLike]: 'sh.688%' },
            { [Op.iLike]: 'sz.0%' },
            { [Op.iLike]: 'sz.3%' },
            { [Op.iLike]: '6%.SH' },
            { [Op.iLike]: '0%.SZ' },
            { [Op.iLike]: '3%.SZ' },
          ],
        };
      }

      const rows = (await Stock.findAll({
        attributes: ['symbol'],
        where,
        order: orderBy,
        limit,
        raw: true,
      })) as Array<{ symbol: string }>;

      const codes: string[] = [];
      for (const r of rows) {
        const raw = String(r.symbol || '');
        // 兼容 'sz.300085' / '300085.SZ' / 纯 6 位
        const digits = raw.replace(/[^0-9]/g, '');
        const code = digits.length >= 6 ? digits.slice(-6) : '';
        if (/^\d{6}$/.test(code)) codes.push(code);
      }
      if (hasMcap === 0) {
        logger.warn(
          `loadUniverseByMarketCap: circulating_market_cap 全为 0/null, 退化为 ORDER BY id (返回 ${codes.length} 只)`
        );
      }
      return codes;
    } catch (err) {
      logger.warn(`loadUniverseByMarketCap failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * 拉指定股票近 lookbackDays 个交易日的 hot_rank_em 历史.
   * 返回 Map<stock_code, Map<trade_date, hot_rank_em>>.
   */
  async loadRecentRanks(
    asOfDate: string,
    stockCodes: string[],
    lookbackDays: number
  ): Promise<Map<string, Map<string, number>>> {
    const result = new Map<string, Map<string, number>>();
    if (stockCodes.length === 0) return result;

    // 用自然日窗口拉; 周末没数据自然落空
    const startDate = new Date(Date.now() - lookbackDays * 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    try {
      const rows = (await SocialSentimentSnapshot.findAll({
        attributes: ['stock_code', 'trade_date', 'hot_rank_em'],
        where: {
          stock_code: { [Op.in]: stockCodes },
          trade_date: { [Op.gte]: startDate, [Op.lt]: asOfDate },
          hot_rank_em: { [Op.ne]: null },
        },
        raw: true,
      })) as unknown as Array<{
        stock_code: string;
        trade_date: string | Date;
        hot_rank_em: number;
      }>;
      for (const r of rows) {
        const dt =
          r.trade_date instanceof Date
            ? r.trade_date.toISOString().slice(0, 10)
            : String(r.trade_date).slice(0, 10);
        let perStock = result.get(r.stock_code);
        if (!perStock) {
          perStock = new Map();
          result.set(r.stock_code, perStock);
        }
        perStock.set(dt, r.hot_rank_em);
      }
    } catch (err) {
      logger.warn(`loadRecentRanks failed: ${(err as Error).message}`);
    }
    return result;
  }

  /** 取最近 N 个 distinct date 的均值; 缺值视作不参与平均. */
  private computeRank5dAvg(perStock?: Map<string, number>): number | null {
    if (!perStock || perStock.size === 0) return null;
    let sum = 0;
    let n = 0;
    for (const v of perStock.values()) {
      if (Number.isFinite(v)) {
        sum += v;
        n += 1;
      }
    }
    return n > 0 ? Number((sum / n).toFixed(2)) : null;
  }
}

export const socialSentimentSyncService = new SocialSentimentSyncService();
