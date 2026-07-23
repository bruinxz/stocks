import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database';
import { logger } from '../utils/logger';
import {
  countTradingDaysBetween,
  getShanghaiDate,
  isAShareTradeDay,
  latestTradeDateOnOrBefore,
} from '../utils/tradingCalendar';

export type PageFreshnessKey =
  | 'market'
  | 'morning'
  | 'us'
  | 'jpkr'
  | 'multi'
  | 'backtest'
  | 'daily'
  | 'history';

export type PageFreshnessStatus = 'fresh' | 'delayed' | 'missing';

export interface PageFreshnessItem {
  page: PageFreshnessKey;
  label: string;
  latest_data_at: string | null;
  latest_data_date: string | null;
  reference_trade_date: string | null;
  lag_days: number | null;
  status: PageFreshnessStatus;
  source: string;
}

export interface PageFreshnessResponse {
  generated_at: string;
  reference_trade_date: string | null;
  pages: Record<PageFreshnessKey, PageFreshnessItem>;
}

interface FreshnessRow {
  latest_data_at: Date | string | null;
  latest_data_date: Date | string | null;
}

interface FreshnessPageDefinition {
  page: PageFreshnessKey;
  label: string;
}

interface FreshnessSourceDefinition {
  pages: FreshnessPageDefinition[];
  source: string;
  sql: string;
}

type FreshnessQueryExecutor = (sql: string) => Promise<FreshnessRow[]>;

function dateOnly(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(parsed);
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function tradingLag(latest: string | null, reference: string | null): number | null {
  if (!latest || !reference) return null;
  return countTradingDaysBetween(latest, reference);
}

export function expectedCompletedTradeDate(now = new Date()): string {
  const today = getShanghaiDate(now);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
  if (isAShareTradeDay(today) && hour >= 17) return today;
  const yesterday = new Date(`${today}T00:00:00+08:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return latestTradeDateOnOrBefore(yesterday);
}

function statusFor(page: PageFreshnessKey, lag: number | null): PageFreshnessStatus {
  if (lag === null) return 'missing';
  const tolerance = page === 'backtest' ? 5 : page === 'us' || page === 'jpkr' ? 1 : 0;
  return lag <= tolerance ? 'fresh' : 'delayed';
}

/**
 * Each source is queried independently. Some projection tables are deployed by
 * a separate data-pipeline migration, so one absent optional table must not make
 * the freshness stamp for every page return HTTP 500.
 */
const PAGE_FRESHNESS_SOURCES: FreshnessSourceDefinition[] = [
  {
    pages: [{ page: 'market', label: 'A 股行情' }],
    source: 'daily_bars',
    sql: `
      WITH listed AS (
        SELECT COUNT(*)::numeric AS total
          FROM stocks
         WHERE is_listed = TRUE AND type = 'stock'
      ), coverage AS (
        SELECT bar.time::date AS trade_date,
               COUNT(DISTINCT bar.stock_id)::numeric AS covered
          FROM daily_bars bar
          JOIN stocks stock ON stock.id = bar.stock_id
         WHERE stock.is_listed = TRUE
           AND stock.type = 'stock'
           AND bar.time >= CURRENT_DATE - INTERVAL '365 days'
         GROUP BY bar.time::date
      ), watermark AS (
        SELECT coverage.trade_date
          FROM coverage CROSS JOIN listed
         WHERE coverage.covered >= CEIL(listed.total * 0.80)
         ORDER BY coverage.trade_date DESC
         LIMIT 1
      )
      SELECT (
               SELECT MAX(bar.updated_at)
                 FROM daily_bars bar
                 JOIN stocks stock ON stock.id = bar.stock_id
                WHERE bar.time >= watermark.trade_date
                  AND bar.time < watermark.trade_date + INTERVAL '1 day'
                  AND stock.is_listed = TRUE
                  AND stock.type = 'stock'
             ) AS latest_data_at,
             watermark.trade_date AS latest_data_date
        FROM watermark
    `,
  },
  {
    pages: [
      { page: 'morning', label: 'A 股早报' },
      { page: 'daily', label: 'A 股日报' },
      { page: 'history', label: '报告档案' },
    ],
    source: 'ai_recommendation_snapshot/cn_a',
    sql: `
      SELECT MAX(as_of_utc) AS latest_data_at,
             MAX(trading_day) AS latest_data_date
        FROM ai_recommendation_snapshot
       WHERE profile = 'us_preferred' AND market_scope = 'cn_a'
    `,
  },
  {
    pages: [{ page: 'us', label: '美股科技' }],
    source: 'global_tech_daily_quote/us',
    sql: `
      SELECT MAX(available_at_utc) AS latest_data_at,
             MAX(trading_day) AS latest_data_date
        FROM global_tech_daily_quote
       WHERE market_scope = 'us'
    `,
  },
  {
    pages: [{ page: 'jpkr', label: '韩股科技' }],
    source: 'jpkr_daily_kline/kr technology representatives',
    sql: `
      SELECT MAX(available_at_utc) AS latest_data_at,
             MAX(trading_day) AS latest_data_date
        FROM jpkr_daily_kline
       WHERE market_scope = 'kr'
    `,
  },
  {
    pages: [{ page: 'multi', label: '高倍潜力' }],
    source: 'multibagger_candidate_snapshot',
    sql: `
      SELECT MAX(as_of_utc) AS latest_data_at,
             MAX(as_of_utc)::date AS latest_data_date
        FROM multibagger_candidate_snapshot
       WHERE available_at_utc <= NOW()
    `,
  },
  {
    pages: [{ page: 'backtest', label: '回测证据' }],
    source: 'backtest_pit_snapshot',
    sql: `
      SELECT MAX(created_at) AS latest_data_at,
             MAX(snapshot_day) AS latest_data_date
        FROM backtest_pit_snapshot
    `,
  },
];

export interface AShareFreshnessAssessment {
  reference_trade_date: string;
  lag_days: number | null;
  status: PageFreshnessStatus;
}

export function assessAShareFreshness(
  latest_data_date: string | Date | null | undefined,
  now = new Date()
): AShareFreshnessAssessment {
  const reference = expectedCompletedTradeDate(now);
  const latestDate = dateOnly(latest_data_date);
  const lag = tradingLag(latestDate, reference);
  return {
    reference_trade_date: reference,
    lag_days: lag,
    status: statusFor('market', lag),
  };
}

export class PageFreshnessService {
  private readonly queryExecutor: FreshnessQueryExecutor;
  private readonly warnedSources = new Set<string>();

  constructor(queryExecutor?: FreshnessQueryExecutor) {
    this.queryExecutor =
      queryExecutor ||
      (async sql =>
        sequelize.query<FreshnessRow>(sql, {
          type: QueryTypes.SELECT,
        }));
  }

  async getPageFreshness(now = new Date()): Promise<PageFreshnessResponse> {
    // 不以 daily_bars 自身 MAX 作为唯一基准，否则整条 A 股链停更时仍会“自我对齐”。
    // 17:00 前以最近一个已完成交易日为基准，17:00 后要求当日数据。
    const reference = expectedCompletedTradeDate(now);
    const pages = {} as Record<PageFreshnessKey, PageFreshnessItem>;

    await Promise.all(
      PAGE_FRESHNESS_SOURCES.map(async definition => {
        let row: FreshnessRow | null = null;
        try {
          const rows = await this.queryExecutor(definition.sql);
          row = rows[0] || null;
          this.warnedSources.delete(definition.source);
        } catch (error: any) {
          if (!this.warnedSources.has(definition.source)) {
            logger.warn(
              `PageFreshnessService source unavailable: ${definition.source}: ${
                error?.message ?? error
              }`
            );
            this.warnedSources.add(definition.source);
          }
        }

        for (const pageDefinition of definition.pages) {
          const latestDate = dateOnly(row?.latest_data_date);
          const lag = tradingLag(latestDate, reference);
          pages[pageDefinition.page] = {
            page: pageDefinition.page,
            label: pageDefinition.label,
            latest_data_at: iso(row?.latest_data_at),
            latest_data_date: latestDate,
            reference_trade_date: reference,
            lag_days: lag,
            status: statusFor(pageDefinition.page, lag),
            source: definition.source,
          };
        }
      })
    );

    for (const definition of PAGE_FRESHNESS_SOURCES) {
      for (const pageDefinition of definition.pages) {
        if (!pages[pageDefinition.page]) {
          pages[pageDefinition.page] = {
            page: pageDefinition.page,
            label: pageDefinition.label,
            latest_data_at: null,
            latest_data_date: null,
            reference_trade_date: reference,
            lag_days: null,
            status: 'missing',
            source: definition.source,
          };
        }
      }
    }

    return { generated_at: new Date().toISOString(), reference_trade_date: reference, pages };
  }
}

export const pageFreshnessService = new PageFreshnessService();
