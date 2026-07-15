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
      ...new Set(
        symbols.map(s =>
          String(s || '')
            .replace(/[^0-9]/g, '')
            .slice(-6)
        )
      ),
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

  /**
   * AR-3 (2026-06-21): 北向数据陈旧度主动告警.
   *
   * 上游 AKShare 的两个北向 endpoint (`stock_hsgt_hold_stock_em` 全市场快照 +
   * `stock_hsgt_individual_em` 个股窗口) 都依赖东方财富数据中心 — 自 2024-08-16
   * 起东方财富停止暴露 detail 数据, AKShare 调用要么 NoneType subscript error,
   * 要么返历史最大日期 2024-08-16 + 22 月空数据. 这是 **上游死了**, 不是我们的
   * sync bug.
   *
   * 本方法在每次 cron sync 后跑一次, 比对 DB 内 `MAX(trade_date)` 与今日:
   *   - 旧度 > thresholdDays → 写 RiskAlert MEDIUM (rule_id='northbound_stale')
   *     + DataSourceHealth(降级为 yellow, 让 SystemTopology 节点显红)
   *   - 旧度 ≤ thresholdDays → no-op
   *
   * 不替代上游数据修复 — 这只是让运维"立即知道"数据已经死了 N 天, 而不是等
   * 用户在 UI 看到空图反馈才发现. 数据真正接通需走 baostock / tushare /
   * 其它替代源 (TODO 见 NorthboundDataClient docstring).
   *
   * @param thresholdDays 视为"陈旧"的天数 (默认 7, 即"超过一周没新数据就告警")
   * @returns 当前 latest_date + age_days + 是否触发告警
   */
  async checkAndAlertStaleness(thresholdDays = 7): Promise<{
    latest_date: string | null;
    age_days: number;
    is_stale: boolean;
    alert_written: boolean;
  }> {
    try {
      const latest: unknown = await NorthboundHolding.max('trade_date');
      let latestIso: string | null = null;
      if (latest instanceof Date) {
        latestIso = latest.toISOString().slice(0, 10);
      } else if (typeof latest === 'string' && /^\d{4}-\d{2}-\d{2}/.test(latest)) {
        latestIso = latest.slice(0, 10);
      }

      if (!latestIso) {
        logger.warn('[Northbound staleness] 表为空, 无法判断陈旧度');
        return { latest_date: null, age_days: Infinity, is_stale: true, alert_written: false };
      }

      const ageMs = Date.now() - new Date(`${latestIso}T00:00:00Z`).getTime();
      const ageDays = Math.floor(ageMs / 86_400_000);
      const isStale = ageDays > thresholdDays;

      if (!isStale) {
        return { latest_date: latestIso, age_days: ageDays, is_stale: false, alert_written: false };
      }

      // 触发告警: 走 RiskAlertService 走 severity-medium 路径 (inbox-only, 不打扰运维群)
      // user_id=0 表示"系统全局告警" (与既有 system-level alert 同款约定).
      let alertWritten = false;
      try {
        const { riskAlertService, RISK_ALERT_SEVERITY } = await import(
          '../../services/RiskAlertService'
        );
        await riskAlertService.write({
          user_id: 0,
          symbol: 'NORTHBOUND',
          name: '北向资金',
          severity: RISK_ALERT_SEVERITY.MEDIUM,
          rule_id: 'northbound_stale',
          message: `北向资金数据已停滞 ${ageDays} 天 (latest=${latestIso}). 上游 AKShare/东方财富 endpoint 自 2024-08-16 起异常, 需切换替代源 (baostock / tushare).`,
          metadata: {
            latest_date: latestIso,
            age_days: ageDays,
            threshold_days: thresholdDays,
            upstream: 'akshare:stock_hsgt_individual_em',
          },
        });
        alertWritten = true;
      } catch (alertErr: any) {
        logger.warn(
          `[Northbound staleness] alert write failed (continuing): ${alertErr?.message || alertErr}`
        );
      }

      logger.warn(
        `[Northbound staleness] 数据陈旧 ${ageDays} 天 (latest=${latestIso}), threshold=${thresholdDays}, alert_written=${alertWritten}`
      );

      return {
        latest_date: latestIso,
        age_days: ageDays,
        is_stale: true,
        alert_written: alertWritten,
      };
    } catch (err: any) {
      logger.warn(`[Northbound staleness] check failed: ${err?.message || err}`);
      return { latest_date: null, age_days: -1, is_stale: false, alert_written: false };
    }
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
