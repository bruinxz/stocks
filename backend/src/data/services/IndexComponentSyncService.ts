import { IndexComponent } from '../../models/IndexComponent';
import { logger } from '../../utils/logger';
import { IndexComponentClient, indexComponentClient } from '../sources/IndexComponentClient';

/**
 * 指数成份股入库服务（US-020）
 *
 * - `syncDate(indexCode, date)`：拉单个指数 + 单日并按 (trade_date, index_code,
 *   stock_code) upsert。
 * - `syncIndexes(indexCodes[], date)`：循环遍历多个指数，单日多指数一次性同步
 *   （CTA100 用 000852；后续 SectorRotation/Ensemble 等会需要多指数）。
 *
 * 网络/解析失败会被记录到统计里但不会中断循环，便于隔夜补漏。
 *
 * 与北向/龙虎榜等"实时快照"型数据源同理：AKShare 没有"历史日期 X 当日的成份"
 * 端点，trade_date 只是写入时的标签。月度调仓策略每月跑一次同步即可。
 */
export interface SyncIndexComponentsResult {
  trade_date: string;
  index_code: string;
  fetched: number;
  upserted: number;
  skipped: boolean;
  error?: string;
}

export interface SyncIndexesOptions {
  /** 同一 (trade_date, index_code) 已有记录时跳过，默认 true */
  skipExisting?: boolean;
}

export interface SyncIndexesResult {
  trade_date: string;
  total_indexes: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: SyncIndexComponentsResult[];
}

export class IndexComponentSyncService {
  private client: IndexComponentClient;

  constructor(client: IndexComponentClient = indexComponentClient) {
    this.client = client;
  }

  /**
   * 同步单个指数单日成份股快照
   * @param indexCode 6 位指数代码，如 '000852'
   * @param date ISO YYYY-MM-DD
   */
  async syncDate(indexCode: string, date: string): Promise<SyncIndexComponentsResult> {
    try {
      const rows = await this.client.fetchComponents(indexCode, date);
      if (rows.length === 0) {
        logger.warn(`IndexComponent: no data returned for ${indexCode}/${date}`);
        return {
          trade_date: date,
          index_code: indexCode,
          fetched: 0,
          upserted: 0,
          skipped: false,
        };
      }

      // 按主键 (trade_date, index_code, stock_code) 做 bulkCreate + updateOnDuplicate
      // 重跑同日会覆盖名称 / 权重 / raw_payload（指数样本月内基本不动，但权重每日漂移）
      const records = rows.map(row => ({
        trade_date: row.trade_date,
        index_code: row.index_code,
        stock_code: row.stock_code,
        stock_name: row.stock_name ?? undefined,
        index_name: row.index_name ?? undefined,
        weight: row.weight ?? undefined,
        source: 'akshare',
        raw_payload: row.raw_payload ?? {},
      }));

      await IndexComponent.bulkCreate(records, {
        updateOnDuplicate: [
          'stock_name',
          'index_name',
          'weight',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(`IndexComponent: upserted ${records.length} rows for ${indexCode}/${date}`);
      return {
        trade_date: date,
        index_code: indexCode,
        fetched: rows.length,
        upserted: records.length,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`IndexComponent syncDate(${indexCode}, ${date}) failed: ${message}`);
      return {
        trade_date: date,
        index_code: indexCode,
        fetched: 0,
        upserted: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 单日同步多个指数（断点续传：当 (date, index_code) 已有记录则跳过）
   */
  async syncIndexes(
    indexCodes: string[],
    date: string,
    options: SyncIndexesOptions = {}
  ): Promise<SyncIndexesResult> {
    const skipExisting = options.skipExisting ?? process.env.INDEX_COMPONENT_SKIP_EXISTING !== '0';

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`IndexComponent syncIndexes: invalid date ${date}`);
    }

    const details: SyncIndexComponentsResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const indexCode of indexCodes) {
      if (skipExisting) {
        const existing = await IndexComponent.count({
          where: { trade_date: date, index_code: indexCode },
        });
        if (existing > 0) {
          logger.info(
            `IndexComponent: skip ${indexCode}/${date} (${existing} rows already present)`
          );
          details.push({
            trade_date: date,
            index_code: indexCode,
            fetched: 0,
            upserted: 0,
            skipped: true,
          });
          skipped += 1;
          continue;
        }
      }

      const result = await this.syncDate(indexCode, date);
      details.push(result);
      if (result.error) failed += 1;
      else succeeded += 1;
    }

    return {
      trade_date: date,
      total_indexes: indexCodes.length,
      succeeded,
      skipped,
      failed,
      details,
    };
  }
}

export const indexComponentSyncService = new IndexComponentSyncService();
