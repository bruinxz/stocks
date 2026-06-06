import { DragonTigerBoard } from '../../models/DragonTigerBoard';
import { logger } from '../../utils/logger';
import {
  DragonTigerClient,
  DragonTigerBoardRow,
  dragonTigerClient,
} from '../sources/DragonTigerClient';
import { isFamousYouzi, canonicalSeatName } from '../../constants/famousSeats';

/**
 * 龙虎榜（Dragon-Tiger Board）日度入库服务
 *
 * - `syncDate(date)`：拉取单日龙虎榜，按 (trade_date, stock_code, buyer_seat,
 *   seller_seat) 做 upsert。同时标注 `is_famous_yz`（买方席位命中知名游资白名单）。
 * - `syncRange(start, end)`：闭区间按日遍历，默认开启断点续传
 *   （当日已有数据则跳过；`--force` 或 `DRAGON_TIGER_SKIP_EXISTING=0` 可禁用）。
 *
 * 失败的单日不中断 range，便于隔夜补漏。
 */
export interface SyncDateResult {
  trade_date: string;
  fetched: number;
  upserted: number;
  famous_hits: number;
  skipped: boolean;
  error?: string;
}

export interface SyncRangeOptions {
  /** 单日已有任意一条 dragon_tiger_board 时跳过整日，默认 true */
  skipExisting?: boolean;
}

export interface SyncRangeResult {
  start: string;
  end: string;
  total_days: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: SyncDateResult[];
}

export class DragonTigerSyncService {
  private client: DragonTigerClient;

  constructor(client: DragonTigerClient = dragonTigerClient) {
    this.client = client;
  }

  /**
   * 同步指定日期的龙虎榜营业部明细。
   * 内部会调用 famousSeats 白名单为每条记录打标。
   *
   * @param date ISO YYYY-MM-DD
   */
  async syncDate(date: string): Promise<SyncDateResult> {
    try {
      const rows = await this.client.fetchDailyDetail(date);
      if (rows.length === 0) {
        logger.warn(`DragonTiger: no data returned for ${date}, marking as empty success`);
        return {
          trade_date: date,
          fetched: 0,
          upserted: 0,
          famous_hits: 0,
          skipped: false,
        };
      }

      // 计算 is_famous_yz 标签并归一席位名（命中别名时落标准名进库）
      let famousHits = 0;
      const records = rows.map((row: DragonTigerBoardRow) => {
        const buyerCanonical = canonicalSeatName(row.buyer_seat);
        const sellerCanonical = canonicalSeatName(row.seller_seat);
        const famous = isFamousYouzi(row.buyer_seat);
        if (famous) famousHits += 1;

        return {
          trade_date: row.trade_date,
          stock_code: row.stock_code,
          buyer_seat: buyerCanonical,
          seller_seat: sellerCanonical,
          stock_name: row.stock_name ?? undefined,
          reason: row.reason ?? undefined,
          buy_amount: row.buy_amount ?? undefined,
          sell_amount: row.sell_amount ?? undefined,
          net_amount: row.net_amount ?? undefined,
          is_famous_yz: famous,
          source: 'akshare',
          raw_payload: row.raw_payload ?? {},
        };
      });

      await DragonTigerBoard.bulkCreate(records, {
        updateOnDuplicate: [
          'stock_name',
          'reason',
          'buy_amount',
          'sell_amount',
          'net_amount',
          'is_famous_yz',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `DragonTiger: upserted ${records.length} rows for ${date} (famous_yz hits=${famousHits})`
      );
      return {
        trade_date: date,
        fetched: rows.length,
        upserted: records.length,
        famous_hits: famousHits,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`DragonTiger syncDate(${date}) failed: ${message}`);
      return {
        trade_date: date,
        fetched: 0,
        upserted: 0,
        famous_hits: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 闭区间按日遍历（含两端）。
   * 周末/节假日 AKShare 会返回空 dataframe，记一条 fetched=0 的 detail，
   * 不计入失败（同 NorthboundSyncService 的契约）。
   */
  async syncRange(
    start: string,
    end: string,
    options: SyncRangeOptions = {}
  ): Promise<SyncRangeResult> {
    const skipExisting = options.skipExisting ?? process.env.DRAGON_TIGER_SKIP_EXISTING !== '0';

    const startDate = parseIsoDate(start);
    const endDate = parseIsoDate(end);
    if (startDate > endDate) {
      throw new Error(`DragonTiger syncRange: start ${start} after end ${end}`);
    }

    const details: SyncDateResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    let totalDays = 0;

    for (
      let cursor = new Date(startDate);
      cursor <= endDate;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      totalDays += 1;
      const iso = cursor.toISOString().slice(0, 10);

      if (skipExisting) {
        const existing = await DragonTigerBoard.count({ where: { trade_date: iso } });
        if (existing > 0) {
          logger.info(`DragonTiger: skip ${iso} (${existing} rows already present)`);
          details.push({
            trade_date: iso,
            fetched: 0,
            upserted: 0,
            famous_hits: 0,
            skipped: true,
          });
          skipped += 1;
          continue;
        }
      }

      const dayResult = await this.syncDate(iso);
      details.push(dayResult);
      if (dayResult.error) failed += 1;
      else succeeded += 1;
    }

    return {
      start,
      end,
      total_days: totalDays,
      succeeded,
      skipped,
      failed,
      details,
    };
  }
}

/** ISO YYYY-MM-DD → Date (UTC midnight)，避免本地时区漂移 */
function parseIsoDate(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Invalid ISO date (expected YYYY-MM-DD): ${iso}`);
  }
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

export const dragonTigerSyncService = new DragonTigerSyncService();
