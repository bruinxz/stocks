import { NorthboundHolding } from '../../models/NorthboundHolding';
import { logger } from '../../utils/logger';
import { NorthboundDataClient, northboundDataClient } from '../sources/NorthboundDataClient';

/**
 * 北向资金日度持股入库服务
 *
 * - `syncDate(date)`：拉取单日并按 (trade_date, stock_code) upsert。
 * - `syncRange(start, end)`：闭区间按日遍历，支持「断点续传」——
 *   入参或环境变量 `NORTHBOUND_SKIP_EXISTING=1` 时，当日已有任一记录就跳过。
 *
 * 网络/解析失败会被记录到统计里但不会中断 range 同步，便于隔夜补漏。
 */
export interface SyncDateResult {
  trade_date: string;
  fetched: number;
  upserted: number;
  skipped: boolean;
  error?: string;
}

export interface SyncRangeOptions {
  /** 单日已有任意一条 northbound_holdings 时跳过整日，默认 true（与断点续传契约一致） */
  skipExisting?: boolean;
  /** 拉取通道，默认 "北向" */
  market?: '北向' | '沪股通' | '深股通';
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

export class NorthboundSyncService {
  private client: NorthboundDataClient;

  constructor(client: NorthboundDataClient = northboundDataClient) {
    this.client = client;
  }

  /**
   * 同步指定日期的北向持股快照
   * @param date ISO YYYY-MM-DD
   * @param options.market 可选 AKShare 通道
   */
  async syncDate(
    date: string,
    options: { market?: '北向' | '沪股通' | '深股通' } = {}
  ): Promise<SyncDateResult> {
    const market = options.market ?? '北向';
    try {
      const rows = await this.client.fetchHoldings(date, market);
      if (rows.length === 0) {
        logger.warn(`Northbound: no data returned for ${date}, marking as empty success`);
        return { trade_date: date, fetched: 0, upserted: 0, skipped: false };
      }

      // 按主键 (trade_date, stock_code) 做 bulkCreate + updateOnDuplicate
      // 这样既 INSERT 新行也覆盖当日陈旧快照，幂等 + 断点重跑安全
      const records = rows.map(row => ({
        trade_date: row.trade_date,
        stock_code: row.stock_code,
        stock_name: row.stock_name ?? undefined,
        hold_volume: row.hold_volume ?? undefined,
        hold_amount: row.hold_amount ?? undefined,
        hold_ratio: row.hold_ratio ?? undefined,
        market_type: row.market_type,
        source: 'akshare',
        raw_payload: row.raw_payload ?? {},
      }));

      await NorthboundHolding.bulkCreate(records, {
        updateOnDuplicate: [
          'stock_name',
          'hold_volume',
          'hold_amount',
          'hold_ratio',
          'market_type',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(`Northbound: upserted ${records.length} rows for ${date}`);
      return { trade_date: date, fetched: rows.length, upserted: records.length, skipped: false };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`Northbound syncDate(${date}) failed: ${message}`);
      return { trade_date: date, fetched: 0, upserted: 0, skipped: false, error: message };
    }
  }

  /**
   * 闭区间按日遍历（含两端），断点续传：默认遇到当日已有数据则跳过。
   *
   * 注意：北向数据只在交易日才有；遇到周末/节假日 AKShare 返回空 dataframe，
   * 我们记一个 fetched=0 的 day-result，便于 ops 区分"跳过"和"为空"。
   */
  async syncRange(
    start: string,
    end: string,
    options: SyncRangeOptions = {}
  ): Promise<SyncRangeResult> {
    const skipExisting = options.skipExisting ?? process.env.NORTHBOUND_SKIP_EXISTING !== '0';
    const market = options.market ?? '北向';

    const startDate = parseIsoDate(start);
    const endDate = parseIsoDate(end);
    if (startDate > endDate) {
      throw new Error(`Northbound syncRange: start ${start} after end ${end}`);
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
        const existing = await NorthboundHolding.count({ where: { trade_date: iso } });
        if (existing > 0) {
          logger.info(`Northbound: skip ${iso} (${existing} rows already present)`);
          details.push({ trade_date: iso, fetched: 0, upserted: 0, skipped: true });
          skipped += 1;
          continue;
        }
      }

      const dayResult = await this.syncDate(iso, { market });
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

  /**
   * Per-stock fallback ingest — for cases where the global daily endpoint
   * (`stock_hsgt_hold_stock_em`) is broken upstream (East Money returns null
   * pages → AKShare raises `TypeError: 'NoneType' object is not subscriptable`).
   *
   * Iterates `symbols`, calls `stock_hsgt_individual_em(symbol)` per stock,
   * filters to [startDate, endDate], and upserts in the same shape as syncDate.
   *
   * @param symbols 6-digit codes (no market prefix)
   * @param startDate ISO YYYY-MM-DD inclusive
   * @param endDate ISO YYYY-MM-DD inclusive
   * @param options.intervalMs sleep between per-stock calls (default 200ms)
   */
  async syncIndividualUniverse(
    symbols: string[],
    startDate: string,
    endDate: string,
    options: { intervalMs?: number } = {}
  ): Promise<{
    total_stocks: number;
    succeeded: number;
    failed: number;
    upserted_rows: number;
    days: number;
  }> {
    const intervalMs = options.intervalMs ?? 200;
    const codes = [
      ...new Set(symbols.map(s => String(s || '').replace(/[^0-9]/g, '').slice(-6))),
    ].filter(c => /^\d{6}$/.test(c));
    let succeeded = 0;
    let failed = 0;
    let upsertedRows = 0;

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      try {
        const rows = await this.client.fetchIndividualWindow(code, startDate, endDate);
        if (rows.length === 0) {
          succeeded += 1;
        } else {
          const records = rows.map(row => ({
            trade_date: row.trade_date,
            stock_code: row.stock_code,
            stock_name: row.stock_name ?? undefined,
            hold_volume: row.hold_volume ?? undefined,
            hold_amount: row.hold_amount ?? undefined,
            hold_ratio: row.hold_ratio ?? undefined,
            market_type: row.market_type,
            source: 'akshare_individual',
            raw_payload: row.raw_payload ?? {},
          }));
          await NorthboundHolding.bulkCreate(records, {
            updateOnDuplicate: [
              'stock_name',
              'hold_volume',
              'hold_amount',
              'hold_ratio',
              'market_type',
              'source',
              'raw_payload',
              'updated_at',
            ],
          });
          upsertedRows += records.length;
          succeeded += 1;
        }
      } catch (e) {
        failed += 1;
        logger.warn(`Northbound individual sync failed for ${code}: ${(e as Error).message}`);
      }
      if (intervalMs > 0 && i < codes.length - 1) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }

    const days =
      (parseIsoDate(endDate).getTime() - parseIsoDate(startDate).getTime()) / 86_400_000 + 1;
    logger.info(
      `Northbound individual universe: codes=${codes.length} ok=${succeeded} fail=${failed} ` +
        `upserted=${upsertedRows} window=[${startDate},${endDate}] days=${days}`
    );
    return {
      total_stocks: codes.length,
      succeeded,
      failed,
      upserted_rows: upsertedRows,
      days,
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

export const northboundSyncService = new NorthboundSyncService();
