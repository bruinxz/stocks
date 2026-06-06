import { EarningsForecast } from '../../models/EarningsForecast';
import { logger } from '../../utils/logger';
import {
  EarningsForecastClient,
  EarningsForecastRow,
  earningsForecastClient,
} from '../sources/EarningsForecastClient';

/**
 * 业绩预告（业绩预增/扭亏等）入库服务 — US-013 数据层。
 *
 * AKShare 的 `stock_yjyg_em` 按 **报告期** 检索（一只股票在一个报告期通
 * 常只有一条预告，但可能多次修订）。本服务面向**报告期**进行同步：
 *
 *   - `syncReportPeriod(reportPeriod)` — 拉一个报告期 + bulkCreate upsert
 *   - `syncReportPeriods(periods[])`    — 批量
 *
 * 报告期日期约定（必须是 4 个季度末日期之一）：
 *   YYYY-03-31 / YYYY-06-30 / YYYY-09-30 / YYYY-12-31
 *
 * **`is_surprise` 业务标签** 在 TS 服务里计算（符合 codebase pattern：
 * Python 是 dumb fetcher，业务规则留 TS）：
 *   forecast_type ∈ {预增 / 扭亏 / 续盈} AND profit_change_low ≥ 50
 *
 * 这个标签直接被 EarningsSurpriseStrategy 用来过滤入场标的，规则将来
 * 可能随策略迭代调整（如把 50 调成 30 或加入"略增 + low ≥ 80"分支），
 * 留在 TS 服务比硬编码到 Python 更灵活。
 */
export interface SyncReportPeriodResult {
  report_period: string;
  fetched: number;
  upserted: number;
  surprise_count: number;
  skipped: boolean;
  error?: string;
}

export interface SyncReportPeriodsOptions {
  /** 单个报告期已有任意一条记录时跳过整批，默认 true */
  skipExisting?: boolean;
}

export interface SyncReportPeriodsResult {
  periods: string[];
  total_periods: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: SyncReportPeriodResult[];
}

/** 预告类型 → 是否潜在"超预期"的判定基础。AC 指定的 3 种。 */
const SURPRISE_FORECAST_TYPES: Set<string> = new Set(['预增', '扭亏', '续盈']);
/** "超预期"门槛：profit_change_low ≥ 50（即预告净利润同比下限至少 +50%） */
const SURPRISE_PROFIT_CHANGE_LOW_THRESHOLD = 50;

export class EarningsForecastSyncService {
  private client: EarningsForecastClient;

  constructor(client: EarningsForecastClient = earningsForecastClient) {
    this.client = client;
  }

  /**
   * 同步单个报告期的所有业绩预告
   * @param reportPeriod ISO 报告期末 YYYY-MM-DD（必须是季度末）
   */
  async syncReportPeriod(reportPeriod: string): Promise<SyncReportPeriodResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportPeriod)) {
      return {
        report_period: reportPeriod,
        fetched: 0,
        upserted: 0,
        surprise_count: 0,
        skipped: false,
        error: `Invalid report_period format (expected YYYY-MM-DD): ${reportPeriod}`,
      };
    }
    if (!isQuarterEnd(reportPeriod)) {
      logger.warn(
        `EarningsForecast: report_period ${reportPeriod} is not a quarter-end; ` +
          `AKShare will return empty. Continuing anyway.`
      );
    }
    try {
      const rows = await this.client.fetchForReportPeriod(reportPeriod);
      if (rows.length === 0) {
        logger.warn(
          `EarningsForecast: no data returned for report_period=${reportPeriod}, marking as empty success`
        );
        return {
          report_period: reportPeriod,
          fetched: 0,
          upserted: 0,
          surprise_count: 0,
          skipped: false,
        };
      }

      let surpriseCount = 0;
      const records = rows.map((row: EarningsForecastRow) => {
        const isSurprise = computeIsSurprise(row.forecast_type, row.profit_change_low);
        if (isSurprise) surpriseCount += 1;
        return {
          announce_date: row.announce_date,
          stock_code: row.stock_code,
          report_period: row.report_period,
          stock_name: row.stock_name ?? undefined,
          forecast_type: row.forecast_type ?? undefined,
          profit_change_low: row.profit_change_low ?? undefined,
          profit_change_high: row.profit_change_high ?? undefined,
          profit_low: row.profit_low ?? undefined,
          profit_high: row.profit_high ?? undefined,
          forecast_reason: row.forecast_reason ?? undefined,
          is_surprise: isSurprise,
          source: 'akshare',
          raw_payload: row.raw_payload ?? {},
        };
      });

      await EarningsForecast.bulkCreate(records, {
        updateOnDuplicate: [
          'stock_name',
          'forecast_type',
          'profit_change_low',
          'profit_change_high',
          'profit_low',
          'profit_high',
          'forecast_reason',
          'is_surprise',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `EarningsForecast: upserted ${records.length} rows for report_period=${reportPeriod} ` +
          `(surprise=${surpriseCount})`
      );
      return {
        report_period: reportPeriod,
        fetched: rows.length,
        upserted: records.length,
        surprise_count: surpriseCount,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`EarningsForecast syncReportPeriod(${reportPeriod}) failed: ${message}`);
      return {
        report_period: reportPeriod,
        fetched: 0,
        upserted: 0,
        surprise_count: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 批量同步多个报告期；遇到已有数据可跳过（断点续传）
   */
  async syncReportPeriods(
    periods: string[],
    options: SyncReportPeriodsOptions = {}
  ): Promise<SyncReportPeriodsResult> {
    const skipExisting =
      options.skipExisting ?? process.env.EARNINGS_FORECAST_SKIP_EXISTING !== '0';

    const details: SyncReportPeriodResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const period of periods) {
      if (skipExisting) {
        const existing = await EarningsForecast.count({ where: { report_period: period } });
        if (existing > 0) {
          logger.info(
            `EarningsForecast: skip report_period=${period} (${existing} rows already present)`
          );
          details.push({
            report_period: period,
            fetched: 0,
            upserted: 0,
            surprise_count: 0,
            skipped: true,
          });
          skipped += 1;
          continue;
        }
      }
      const dayResult = await this.syncReportPeriod(period);
      details.push(dayResult);
      if (dayResult.error) failed += 1;
      else succeeded += 1;
    }

    return {
      periods,
      total_periods: periods.length,
      succeeded,
      skipped,
      failed,
      details,
    };
  }
}

// ---------------------------------------------------------------------------
// 内部 helpers
// ---------------------------------------------------------------------------

/**
 * "超预期"判定：必须满足两个条件
 *   1. forecast_type ∈ {预增, 扭亏, 续盈}（即偏正向）
 *   2. profit_change_low ≥ 50（同比变动下限至少 +50%）
 *
 * 注意 profit_change_low 在 AKShare 里是百分数（50 即 "50%"），不是 0.5。
 * 缺数据（null）的视为"不超预期"——保守起见。
 */
export function computeIsSurprise(
  forecastType: string | null | undefined,
  profitChangeLow: number | null | undefined
): boolean {
  if (!forecastType) return false;
  const trimmed = forecastType.trim();
  if (!SURPRISE_FORECAST_TYPES.has(trimmed)) return false;
  if (profitChangeLow == null || !Number.isFinite(profitChangeLow)) return false;
  return profitChangeLow >= SURPRISE_PROFIT_CHANGE_LOW_THRESHOLD;
}

/** 是否标准季度末日期（03-31 / 06-30 / 09-30 / 12-31） */
export function isQuarterEnd(reportPeriod: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportPeriod)) return false;
  const md = reportPeriod.slice(5);
  return md === '03-31' || md === '06-30' || md === '09-30' || md === '12-31';
}

export const earningsForecastSyncService = new EarningsForecastSyncService();
