import { buildBacktestHoldingsUrl, buildBacktestListUrl } from '../backtestUrls';
import type { BacktestSnapshotSlot } from '../types';

describe('backtest PIT URLs', () => {
  test('selected snapshot uses its encoded ISO timestamp for holdings', () => {
    const selectedSnapshot: BacktestSnapshotSlot = {
      snapshot_id: 'pit-2026-07-10',
      snapshot_day: '2026-07-10',
      strategy: 'us_preferred',
      as_of_utc: '2026-07-10T23:59:59Z',
      is_survivorship_biased: false,
      fact_hash: 'sha256:fixture',
    };

    expect(buildBacktestHoldingsUrl('us_preferred', selectedSnapshot)).toBe(
      '/api/v1/backtest-pit/us_preferred/2026-07-10T23%3A59%3A59Z/holdings'
    );
  });

  test('list query preserves strategy and date filters', () => {
    expect(
      buildBacktestListUrl('korea_multibagger', {
        from: '2026-01-01',
        to: '2026-07-10',
        limit: 60,
      })
    ).toBe('/api/v1/backtest-pit/korea_multibagger?from=2026-01-01&to=2026-07-10&limit=60');
  });
});
