import { Op } from 'sequelize';
import { RestrictedShareRelease } from '../../models/RestrictedShareRelease';
import { logger } from '../../utils/logger';
import {
  RestrictedShareClient,
  RestrictedShareReleaseRow,
  restrictedShareClient,
} from '../sources/RestrictedShareClient';

/**
 * 限售解禁日历入库服务 — US-089 数据层。
 *
 * AKShare `stock_restricted_release_detail_em(start_date, end_date)` 按
 * 日期范围返回全市场解禁批次；本服务面向**日期范围**进行同步：
 *
 *   - `syncDateRange(startDate, endDate)` — 拉一个范围 + bulkCreate upsert
 *   - `syncForUpcomingDays(days)`         — 拉今天 + 未来 N 天 (默认 30 天)
 *   - `syncDateRanges(ranges[])`          — 批量
 *
 * **AC endpoint substitution 说明** (与 RestrictedShareClient / Watchdog
 * 三处文档同步)：AC 指定 `stock_restricted_release_queue` 是 per-stock 历史
 * 端点，本服务用同领域的 `stock_restricted_release_detail_em` (日期范围
 * 端点)。详见 RestrictedShareClient jsdoc。
 *
 * **PK = (ex_date, stock_code, shareholder_name) 三元组**: 同日同股可能因
 * 多种限售股类型 / 多个限售股东而产生多条记录。bulkCreate + updateOnDuplicate
 * 在 N-tuple PK 上 idempotent。
 *
 * **断点续传**：默认 skip-existing —— 若一个日期范围首尾两端都有数据视为
 * 已同步，跳过整批；`--force` 强制覆盖。
 */
export interface SyncDateRangeResult {
  start_date: string;
  end_date: string;
  fetched: number;
  upserted: number;
  skipped: boolean;
  error?: string;
}

export interface SyncDateRangesOptions {
  /** 已有任意一条记录时跳过整批，默认 true */
  skipExisting?: boolean;
}

export interface SyncDateRangesResult {
  ranges: Array<{ start_date: string; end_date: string }>;
  total_ranges: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: SyncDateRangeResult[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class RestrictedShareSyncService {
  private client: RestrictedShareClient;

  constructor(client: RestrictedShareClient = restrictedShareClient) {
    this.client = client;
  }

  /**
   * 同步单个日期范围的所有解禁批次。
   * @param startDate ISO YYYY-MM-DD (含)
   * @param endDate   ISO YYYY-MM-DD (含)
   */
  async syncDateRange(startDate: string, endDate: string): Promise<SyncDateRangeResult> {
    if (!ISO_DATE_RE.test(startDate) || !ISO_DATE_RE.test(endDate)) {
      return {
        start_date: startDate,
        end_date: endDate,
        fetched: 0,
        upserted: 0,
        skipped: false,
        error: `Invalid date format (expected YYYY-MM-DD): start=${startDate} end=${endDate}`,
      };
    }
    if (startDate > endDate) {
      return {
        start_date: startDate,
        end_date: endDate,
        fetched: 0,
        upserted: 0,
        skipped: false,
        error: `start_date ${startDate} > end_date ${endDate}`,
      };
    }
    try {
      const rows = await this.client.fetchForDateRange(startDate, endDate);
      if (rows.length === 0) {
        logger.warn(
          `RestrictedShare: no data returned for ${startDate}..${endDate}, marking as empty success`
        );
        return {
          start_date: startDate,
          end_date: endDate,
          fetched: 0,
          upserted: 0,
          skipped: false,
        };
      }

      // ----- 服务层 dedup (避免源端在同 PK 上偶发重复) -----
      // PK = (ex_date, stock_code, shareholder_name)，service 层用 Map 兜底
      // bulkCreate dialect-dependent 的 in-batch dup 行为 (Postgres 静默后者覆盖前者，
      // 但 service 层显式 dedup 让结果跨方言一致 + 可日志化 dedup_dropped count)。
      // 同 US-030 AnalystForecast 范式。
      const seen = new Map<string, RestrictedShareReleaseRow>();
      let dedupDropped = 0;
      for (const row of rows) {
        const key = `${row.ex_date}::${row.stock_code}::${row.shareholder_name}`;
        if (seen.has(key)) {
          dedupDropped += 1;
          continue;
        }
        seen.set(key, row);
      }
      if (dedupDropped > 0) {
        logger.warn(
          `RestrictedShare: dropped ${dedupDropped} in-batch duplicate PKs for ${startDate}..${endDate}`
        );
      }

      const records = Array.from(seen.values()).map((row: RestrictedShareReleaseRow) => ({
        ex_date: row.ex_date,
        stock_code: row.stock_code,
        shareholder_name: row.shareholder_name,
        stock_name: row.stock_name ?? undefined,
        release_shares: row.release_shares ?? 0,
        release_actual_shares: row.release_actual_shares ?? undefined,
        release_market_value: row.release_market_value ?? 0,
        release_pct_of_float: row.release_pct_of_float ?? undefined,
        prev_close_price: row.prev_close_price ?? undefined,
        prev_20d_change_pct: row.prev_20d_change_pct ?? undefined,
        post_20d_change_pct: row.post_20d_change_pct ?? undefined,
        source: 'akshare',
        raw_payload: row.raw_payload ?? {},
      }));

      await RestrictedShareRelease.bulkCreate(records, {
        updateOnDuplicate: [
          'stock_name',
          'release_shares',
          'release_actual_shares',
          'release_market_value',
          'release_pct_of_float',
          'prev_close_price',
          'prev_20d_change_pct',
          'post_20d_change_pct',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `RestrictedShare: upserted ${records.length} rows for ${startDate}..${endDate}` +
          (dedupDropped > 0 ? ` (dedup_dropped=${dedupDropped})` : '')
      );
      return {
        start_date: startDate,
        end_date: endDate,
        fetched: rows.length,
        upserted: records.length,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`RestrictedShare syncDateRange(${startDate}..${endDate}) failed: ${message}`);
      return {
        start_date: startDate,
        end_date: endDate,
        fetched: 0,
        upserted: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 同步今日 + 未来 N 天的解禁日历 (watchdog 主入口)。
   * 默认 30 天覆盖 watchdog 5 个交易日窗 + 周末缓冲 + 月度调度。
   */
  async syncForUpcomingDays(days = 30, asOfDate?: Date): Promise<SyncDateRangeResult> {
    const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
    const today = asOfDate ?? new Date();
    const start = today.toISOString().slice(0, 10);
    const end = new Date(today.getTime() + safeDays * 86_400_000).toISOString().slice(0, 10);
    return this.syncDateRange(start, end);
  }

  /**
   * 批量同步多个日期范围；遇到已有数据可跳过 (断点续传)。
   */
  async syncDateRanges(
    ranges: Array<{ start_date: string; end_date: string }>,
    options: SyncDateRangesOptions = {}
  ): Promise<SyncDateRangesResult> {
    const skipExisting = options.skipExisting ?? process.env.RESTRICTED_SHARE_SKIP_EXISTING !== '0';

    const details: SyncDateRangeResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const r of ranges) {
      if (skipExisting) {
        const existing = await RestrictedShareRelease.count({
          where: {
            ex_date: {
              [Op.gte]: r.start_date,
              [Op.lte]: r.end_date,
            },
          },
        });
        if (existing > 0) {
          logger.info(
            `RestrictedShare: skip ${r.start_date}..${r.end_date} (${existing} rows already present)`
          );
          details.push({
            start_date: r.start_date,
            end_date: r.end_date,
            fetched: 0,
            upserted: 0,
            skipped: true,
          });
          skipped += 1;
          continue;
        }
      }
      const dayResult = await this.syncDateRange(r.start_date, r.end_date);
      details.push(dayResult);
      if (dayResult.error) failed += 1;
      else succeeded += 1;
    }

    return {
      ranges,
      total_ranges: ranges.length,
      succeeded,
      skipped,
      failed,
      details,
    };
  }
}

export const restrictedShareSyncService = new RestrictedShareSyncService();
