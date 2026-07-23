import moment from 'moment-timezone';

export interface DailyUpdateWindow {
  start_date: string;
  target_date: string;
  market_coverage_date: string | null;
  lag_days: number | null;
  catchup_mode: boolean;
}

const STANDARD_LOOKBACK_DAYS = 7;
const MAX_CATCHUP_DAYS = 180;

/**
 * Normal daily updates reread a short window for corrections. When the broad
 * market watermark is materially behind, start immediately after that
 * watermark so a successful run closes the whole gap instead of only making
 * the latest quote look fresh.
 */
export function resolveDailyUpdateWindow(
  target_date: string,
  market_coverage_date?: string | null
): DailyUpdateWindow {
  const target = moment.tz(target_date, 'Asia/Shanghai').startOf('day');
  const standardStart = target.clone().subtract(STANDARD_LOOKBACK_DAYS, 'days');
  const coverage = market_coverage_date
    ? moment.tz(market_coverage_date, 'Asia/Shanghai').startOf('day')
    : null;

  if (!target.isValid() || !coverage?.isValid() || coverage.isAfter(target)) {
    return {
      start_date: standardStart.format('YYYY-MM-DD'),
      target_date,
      market_coverage_date: market_coverage_date || null,
      lag_days: null,
      catchup_mode: false,
    };
  }

  const lagDays = target.diff(coverage, 'days');
  if (lagDays <= STANDARD_LOOKBACK_DAYS) {
    return {
      start_date: standardStart.format('YYYY-MM-DD'),
      target_date,
      market_coverage_date,
      lag_days: lagDays,
      catchup_mode: false,
    };
  }

  const earliestCatchup = target.clone().subtract(MAX_CATCHUP_DAYS, 'days');
  const afterCoverage = coverage.clone().add(1, 'day');
  return {
    start_date: moment.max(earliestCatchup, afterCoverage).format('YYYY-MM-DD'),
    target_date,
    market_coverage_date,
    lag_days: lagDays,
    catchup_mode: true,
  };
}
