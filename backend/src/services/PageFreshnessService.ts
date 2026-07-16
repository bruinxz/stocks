import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database';

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
  page: PageFreshnessKey;
  label: string;
  latest_data_at: Date | string | null;
  latest_data_date: Date | string | null;
  source: string;
}

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

function calendarLag(latest: string | null, reference: string | null): number | null {
  if (!latest || !reference) return null;
  const from = new Date(`${latest}T00:00:00+08:00`).getTime();
  const to = new Date(`${reference}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

function statusFor(page: PageFreshnessKey, lag: number | null): PageFreshnessStatus {
  if (lag === null) return 'missing';
  const tolerance = page === 'backtest' ? 5 : page === 'us' || page === 'jpkr' ? 1 : 0;
  return lag <= tolerance ? 'fresh' : 'delayed';
}

const PAGE_FRESHNESS_SQL = `
  WITH reference AS (
    SELECT MAX(time)::date AS trade_date FROM daily_bars
  ), watermarks AS (
    SELECT 'market'::text AS page,
           'A 股行情'::text AS label,
           GREATEST(
             (SELECT MAX(time) FROM daily_bars),
             (SELECT MAX(quote_time) FROM realtime_quotes)
           ) AS latest_data_at,
           GREATEST(
             (SELECT MAX(time)::date FROM daily_bars),
             (SELECT MAX(trade_date) FROM realtime_quotes)
           ) AS latest_data_date,
           'daily_bars + realtime_quotes'::text AS source
    UNION ALL
    SELECT 'morning', 'A 股早报', MAX(created_at), MAX(trading_day),
           'ai_recommendation_snapshot/cn_a'
      FROM ai_recommendation_snapshot
     WHERE profile = 'us_preferred' AND market_scope = 'cn_a'
    UNION ALL
    SELECT 'us', '美股催化', MAX(created_at), MAX(trading_day),
           'ai_recommendation_snapshot/us'
      FROM ai_recommendation_snapshot
     WHERE profile = 'us_preferred' AND market_scope = 'us'
    UNION ALL
    SELECT 'jpkr', '日韩市场', MAX(available_at_utc), MAX(trading_day),
           'jpkr_daily_kline'
      FROM jpkr_daily_kline
    UNION ALL
    SELECT 'multi', '高倍潜力', MAX(as_of_utc), MAX(as_of_utc)::date,
           'multibagger_candidate_snapshot'
      FROM multibagger_candidate_snapshot
    UNION ALL
    SELECT 'backtest', '回测证据', MAX(created_at), MAX(snapshot_day),
           'backtest_pit_snapshot'
      FROM backtest_pit_snapshot
    UNION ALL
    SELECT 'daily', 'A 股日报', MAX(created_at), MAX(trading_day),
           'ai_recommendation_snapshot/cn_a'
      FROM ai_recommendation_snapshot
     WHERE profile = 'us_preferred' AND market_scope = 'cn_a'
    UNION ALL
    SELECT 'history', '报告档案', MAX(created_at), MAX(trading_day),
           'ai_recommendation_snapshot/cn_a'
      FROM ai_recommendation_snapshot
     WHERE profile = 'us_preferred' AND market_scope = 'cn_a'
  )
  SELECT watermarks.*, reference.trade_date AS reference_trade_date
    FROM watermarks CROSS JOIN reference
`;

export class PageFreshnessService {
  async getPageFreshness(): Promise<PageFreshnessResponse> {
    const rows = await sequelize.query<
      FreshnessRow & { reference_trade_date: Date | string | null }
    >(PAGE_FRESHNESS_SQL, { type: QueryTypes.SELECT });
    const reference = dateOnly(rows[0]?.reference_trade_date);
    const pages = {} as Record<PageFreshnessKey, PageFreshnessItem>;
    for (const row of rows) {
      const latestDate = dateOnly(row.latest_data_date);
      const lag = calendarLag(latestDate, reference);
      pages[row.page] = {
        page: row.page,
        label: row.label,
        latest_data_at: iso(row.latest_data_at),
        latest_data_date: latestDate,
        reference_trade_date: reference,
        lag_days: lag,
        status: statusFor(row.page, lag),
        source: row.source,
      };
    }
    return { generated_at: new Date().toISOString(), reference_trade_date: reference, pages };
  }
}

export const pageFreshnessService = new PageFreshnessService();
