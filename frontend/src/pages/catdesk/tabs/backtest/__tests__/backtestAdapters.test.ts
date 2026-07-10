import {
  BacktestContractError,
  parseHoldingsResponse,
  parseSnapshotListResponse,
} from '../backtestAdapters';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    snapshot_id: 'pit-1',
    snapshot_day: '2026-07-10',
    strategy: 'us_preferred',
    as_of_utc: '2026-07-10T23:59:59Z',
    is_survivorship_biased: false,
    is_delisted_at_as_of: false,
    fact_hash: 'sha256:fixture',
    source_versions: { prices: '2026-07-10' },
    ...overrides,
  };
}

describe('backtest snapshot adapter', () => {
  test('maps canonical top-level metrics', () => {
    const [mapped] = parseSnapshotListResponse(
      {
        strategy: 'us_preferred',
        snapshots: [
          snapshot({
            net_value: 1.24,
            drawdown: -0.08,
            cumulative_return: 0.24,
            sharpe_ratio_6m: 1.85,
            win_rate_6m: 0.58,
          }),
        ],
      },
      'us_preferred'
    );

    expect(mapped).toMatchObject({
      strategy: 'us_preferred',
      net_value: 1.24,
      drawdown: -0.08,
      cumulative_return: 0.24,
      sharpe_ratio_6m: 1.85,
      win_rate_6m: 0.58,
    });
  });

  test('uses nested metrics only as fallback and top-level values win', () => {
    const [mapped] = parseSnapshotListResponse(
      {
        strategy: 'us_preferred',
        snapshots: [
          snapshot({
            net_value: 1.5,
            metrics: {
              net_value: 9.9,
              drawdown: -0.12,
              cumulative_return: 0.5,
              sharpe_ratio_6m: 2.1,
              win_rate_6m: 0.6,
            },
          }),
        ],
      },
      'us_preferred'
    );

    expect(mapped.net_value).toBe(1.5);
    expect(mapped.drawdown).toBe(-0.12);
    expect(mapped.cumulative_return).toBe(0.5);
  });

  test('rejects invalid or request-mismatched strategy values', () => {
    expect(() =>
      parseSnapshotListResponse(
        {
          strategy: 'unknown',
          snapshots: [],
        },
        'us_preferred'
      )
    ).toThrow(BacktestContractError);

    expect(() =>
      parseSnapshotListResponse(
        {
          strategy: 'us_preferred',
          snapshots: [snapshot({ strategy: 'multibagger' })],
        },
        'us_preferred'
      )
    ).toThrow(/does not match request/);
  });
});

describe('backtest holdings adapter', () => {
  test('maps the canonical four-field holding shape', () => {
    expect(
      parseHoldingsResponse({
        holdings: [
          {
            ticker: 'NVDA',
            weight: 0.05,
            return_since_entry: 0.12,
            is_stale: false,
          },
        ],
      })
    ).toEqual([
      {
        ticker: 'NVDA',
        weight: 0.05,
        return_since_entry: 0.12,
        is_stale: false,
      },
    ]);
  });

  test('rejects malformed holding envelopes and rows', () => {
    expect(() => parseHoldingsResponse({ holdings: null })).toThrow(/holdings must be an array/);
    expect(() =>
      parseHoldingsResponse({
        holdings: [{ ticker: 'NVDA', weight: 0.05, is_stale: false }],
      })
    ).toThrow(/return_since_entry is required/);
  });
});
