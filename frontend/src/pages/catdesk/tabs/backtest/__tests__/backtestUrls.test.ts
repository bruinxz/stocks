import { describe, expect, test } from '@jest/globals';
import {
  buildBacktestHoldingsUrl,
  buildBacktestListUrl,
  buildBacktestSnapshotUrl,
} from '../backtestUrls';
import { coerceBacktestMarketScope, type BacktestSnapshotSlot } from '../types';

describe('backtest PIT URLs', () => {
  test('generic list URLs always include explicit CN A or US market_scope', () => {
    expect(
      buildBacktestListUrl('us_preferred', {
        marketScope: 'cn_a',
        from: '2026-01-01',
        to: '2026-07-10',
        limit: 60,
      })
    ).toBe(
      '/api/v1/backtest-pit/us_preferred?market_scope=cn_a&from=2026-01-01&to=2026-07-10&limit=60'
    );
    expect(
      buildBacktestListUrl('multibagger', {
        marketScope: 'us',
        limit: 30,
      })
    ).toBe('/api/v1/backtest-pit/multibagger?market_scope=us&limit=30');
  });

  test('selected snapshot uses encoded ISO timestamp and row scope for detail and holdings', () => {
    const selectedSnapshot: BacktestSnapshotSlot = {
      snapshot_id: 'pit-2026-07-10',
      snapshot_day: '2026-07-10',
      strategy: 'us_preferred',
      market_scope: 'us',
      as_of_utc: '2026-07-10T23:59:59Z',
      is_survivorship_biased: false,
      fact_hash: 'sha256:fixture',
    };

    expect(
      buildBacktestSnapshotUrl(
        selectedSnapshot.strategy,
        selectedSnapshot.market_scope,
        selectedSnapshot.as_of_utc
      )
    ).toBe(
      '/api/v1/backtest-pit/us_preferred/2026-07-10T23%3A59%3A59Z?market_scope=us'
    );
    expect(buildBacktestHoldingsUrl('us_preferred', selectedSnapshot)).toBe(
      '/api/v1/backtest-pit/us_preferred/2026-07-10T23%3A59%3A59Z/holdings?market_scope=us'
    );
  });

  test('JP and KR strategies use their fixed compatible market_scope', () => {
    expect(
      buildBacktestListUrl('japan_blue_chip', {
        marketScope: 'jp',
        limit: 60,
      })
    ).toBe('/api/v1/backtest-pit/japan_blue_chip?market_scope=jp&limit=60');
    expect(
      buildBacktestListUrl('korea_multibagger', {
        marketScope: 'kr',
        limit: 60,
      })
    ).toBe('/api/v1/backtest-pit/korea_multibagger?market_scope=kr&limit=60');
  });

  test('URL builders reject incompatible strategy and market_scope pairs', () => {
    expect(() =>
      buildBacktestListUrl('japan_multibagger', {
        marketScope: 'us',
        limit: 60,
      })
    ).toThrow(/incompatible/);
    expect(() =>
      buildBacktestSnapshotUrl('korea_semiconductor_chain', 'jp', '2026-07-10T00:00:00Z')
    ).toThrow(/incompatible/);
  });

  test('visible strategy changes preserve compatible generic scopes and coerce fixed markets', () => {
    expect(coerceBacktestMarketScope('multibagger', 'cn_a')).toBe('cn_a');
    expect(coerceBacktestMarketScope('us_preferred', 'us')).toBe('us');
    expect(coerceBacktestMarketScope('japan_blue_chip', 'us')).toBe('jp');
    expect(coerceBacktestMarketScope('korea_multibagger', 'jp')).toBe('kr');
  });
});
