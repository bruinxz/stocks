import { AnalystForecast } from '../../models/AnalystForecast';
import { logger } from '../../utils/logger';
import {
  AnalystForecastClient,
  AnalystForecastRow,
  analystForecastClient,
} from '../sources/AnalystForecastClient';

/**
 * 分析师研报入库服务 — US-030 数据层.
 *
 * 与按 trade_date 批量同步（北向 / 龙虎榜 / 涨停 / 行业流）不同，研报数据
 * 是 **按股票** 同步的：每只股票一次拉全部历史研报（数百条），与 US-022
 * DividendHistory / US-024 FinancialReport 同款 per-stock 模式：
 *
 *   - `syncStock(stockCode)`     — 拉一只股票全部 analyst report rows + upsert
 *   - `syncStocks(stockCodes[])` — 批量；支持 skip-existing 检查点 + friendly throttle
 *
 * **同股同日多份研报 dedup**：AKShare 偶有一家机构同日发深度 + 点评两份，
 * (report_date, stock_code, analyst_firm) 复合 PK 下视为重复键。本服务在
 * bulkCreate 之前 in-memory dedup（保留 forecast_eps_y1 非空 / 评级非空的那条；
 * 同样信息量则保留后出现的那条），避免 sequelize updateOnDuplicate 在同一
 * batch 内的 PK 冲突行为依赖 dialect。
 *
 * **本服务**不**计算业务派生字段**（不像 DividendHistory.yield_pct）：
 * - target_price 只是占位列（AKShare endpoint 不提供）
 * - forecast_eps_y1 上调幅度等 alpha 因子语义留给 AnalystConsensusFactor 在
 *   factor compute() 时实时计算（保持因子可重算，不依赖物化字段）。
 */
export interface SyncStockResult {
  stock_code: string;
  fetched: number;
  upserted: number;
  /** in-memory dedup 后真正落库的行数（< fetched 时记录 dedup_dropped） */
  dedup_dropped: number;
  skipped: boolean;
  error?: string;
}

export interface SyncStocksOptions {
  /** 最近 refreshAfterDays 内已刷新过的股票跳过，默认 true */
  skipExisting?: boolean;
  /** 允许重新抓取前的最短天数，默认 6 天（适配周度任务） */
  refreshAfterDays?: number;
  /** 同步间 sleep 毫秒（友好 AKShare 限流），默认 200 */
  intervalMs?: number;
}

export interface SyncStocksResult {
  stock_codes: string[];
  total_stocks: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: SyncStockResult[];
}

export class AnalystForecastSyncService {
  private client: AnalystForecastClient;

  constructor(client: AnalystForecastClient = analystForecastClient) {
    this.client = client;
  }

  /**
   * 同步单只股票的全部历史研报。
   *
   * @param stockCode 6 位无市场后缀代码，例如 '600519'
   */
  async syncStock(stockCode: string): Promise<SyncStockResult> {
    if (!/^\d{6}$/.test(stockCode)) {
      return {
        stock_code: stockCode,
        fetched: 0,
        upserted: 0,
        dedup_dropped: 0,
        skipped: false,
        error: `Invalid stock_code format (expected 6 digits): ${stockCode}`,
      };
    }

    try {
      const rows = await this.client.fetchForStock(stockCode);
      if (rows.length === 0) {
        logger.warn(
          `AnalystForecast: no data returned for stock=${stockCode}, marking as empty success`
        );
        return {
          stock_code: stockCode,
          fetched: 0,
          upserted: 0,
          dedup_dropped: 0,
          skipped: false,
        };
      }

      // === Dedup by composite PK (report_date, stock_code, analyst_firm) ===
      // 同一 firm 同一天偶有 2 份独立研报（深度 + 点评）；按"信息量更高的优先"保留
      const deduped = dedupReportsByPk(rows);
      const dedupDropped = rows.length - deduped.length;

      const records = deduped.map((row: AnalystForecastRow) => ({
        report_date: row.report_date,
        stock_code: row.stock_code,
        analyst_firm: row.analyst_firm,
        stock_name: row.stock_name ?? undefined,
        target_price: row.target_price ?? undefined,
        rating: row.rating ?? undefined,
        forecast_eps_y1: row.forecast_eps_y1 ?? undefined,
        forecast_eps_y2: row.forecast_eps_y2 ?? undefined,
        forecast_eps_y3: row.forecast_eps_y3 ?? undefined,
        forecast_year_y1: row.forecast_year_y1 ?? undefined,
        forecast_year_y2: row.forecast_year_y2 ?? undefined,
        forecast_year_y3: row.forecast_year_y3 ?? undefined,
        analyst_count: row.analyst_count ?? undefined,
        report_title: row.report_title ?? undefined,
        industry: row.industry ?? undefined,
        report_pdf_url: row.report_pdf_url ?? undefined,
        source: 'akshare',
        raw_payload: row.raw_payload ?? {},
      }));

      await AnalystForecast.bulkCreate(records, {
        updateOnDuplicate: [
          'stock_name',
          'target_price',
          'rating',
          'forecast_eps_y1',
          'forecast_eps_y2',
          'forecast_eps_y3',
          'forecast_year_y1',
          'forecast_year_y2',
          'forecast_year_y3',
          'analyst_count',
          'report_title',
          'industry',
          'report_pdf_url',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `AnalystForecast: upserted ${records.length} rows for stock=${stockCode}` +
          (dedupDropped > 0 ? ` (dedup_dropped=${dedupDropped})` : '')
      );
      return {
        stock_code: stockCode,
        fetched: rows.length,
        upserted: records.length,
        dedup_dropped: dedupDropped,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`AnalystForecast syncStock(${stockCode}) failed: ${message}`);
      return {
        stock_code: stockCode,
        fetched: 0,
        upserted: 0,
        dedup_dropped: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 批量同步多只股票；遇到已有数据可跳过（断点续传）.
   */
  async syncStocks(
    stockCodes: string[],
    options: SyncStocksOptions = {}
  ): Promise<SyncStocksResult> {
    const skipExisting = options.skipExisting ?? process.env.ANALYST_FORECAST_SKIP_EXISTING !== '0';
    const intervalMs = options.intervalMs ?? 200;
    const refreshAfterMs = Math.max(1, Number(options.refreshAfterDays ?? 6)) * 86_400_000;

    const details: SyncStockResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < stockCodes.length; i++) {
      const code = stockCodes[i];
      if (skipExisting) {
        const latest = await AnalystForecast.findOne({
          attributes: ['updated_at'],
          where: { stock_code: code },
          order: [['updated_at', 'DESC']],
        });
        if (latest?.updated_at && Date.now() - latest.updated_at.getTime() < refreshAfterMs) {
          logger.info(`AnalystForecast: skip recently refreshed stock=${code}`);
          details.push({
            stock_code: code,
            fetched: 0,
            upserted: 0,
            dedup_dropped: 0,
            skipped: true,
          });
          skipped += 1;
          continue;
        }
      }
      const r = await this.syncStock(code);
      details.push(r);
      if (r.error) failed += 1;
      else succeeded += 1;

      // friendly throttle for AKShare
      if (intervalMs > 0 && i < stockCodes.length - 1) {
        await new Promise(res => setTimeout(res, intervalMs));
      }
    }

    return {
      stock_codes: stockCodes,
      total_stocks: stockCodes.length,
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
 * 给同一只股票的研报数组去重，PK = (report_date, stock_code, analyst_firm).
 *
 * 选择策略（按优先级）：
 *   1. forecast_eps_y1 非空的优先（深度研报通常有 EPS 预测，点评偶有缺）
 *   2. rating 非空的优先
 *   3. raw_payload 中 "近一月个股研报数" 或 report_title 信息更丰富的优先
 *      （后者用字符串长度做粗略代理 — 深度报告标题往往更长）
 *   4. 平手则保留后出现的（AKShare 通常按日期 desc 顺序输出，但同日内顺序未保证；
 *      保留后出现的等价于"最新一次写入获胜"，与 bulkCreate updateOnDuplicate 一致）
 */
export function dedupReportsByPk(rows: AnalystForecastRow[]): AnalystForecastRow[] {
  const byKey = new Map<string, AnalystForecastRow>();
  for (const row of rows) {
    const key = `${row.report_date}|${row.stock_code}|${row.analyst_firm}`;
    const prev = byKey.get(key);
    if (prev === undefined) {
      byKey.set(key, row);
    } else if (preferRow(row, prev)) {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values());
}

function preferRow(a: AnalystForecastRow, b: AnalystForecastRow): boolean {
  // 1. forecast_eps_y1 非空优先
  const aHasEps = a.forecast_eps_y1 != null && Number.isFinite(a.forecast_eps_y1);
  const bHasEps = b.forecast_eps_y1 != null && Number.isFinite(b.forecast_eps_y1);
  if (aHasEps !== bHasEps) return aHasEps;
  // 2. rating 非空优先
  const aHasRating = !!a.rating && a.rating.trim().length > 0;
  const bHasRating = !!b.rating && b.rating.trim().length > 0;
  if (aHasRating !== bHasRating) return aHasRating;
  // 3. report_title 长度
  const aLen = a.report_title?.length ?? 0;
  const bLen = b.report_title?.length ?? 0;
  if (aLen !== bLen) return aLen > bLen;
  // 4. tie: 默认 true（让后出现的覆盖前面的，与 updateOnDuplicate 一致）
  return true;
}

export const analystForecastSyncService = new AnalystForecastSyncService();
