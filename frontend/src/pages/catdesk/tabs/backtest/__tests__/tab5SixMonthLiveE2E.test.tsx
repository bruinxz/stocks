import React from 'react';
import fs from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHoldingsResponse, parseSnapshotListResponse } from '../backtestAdapters';
import {
  buildBacktestHoldingsUrl,
  buildBacktestListUrl,
  buildBacktestSnapshotUrl,
} from '../backtestUrls';
import { BacktestEvidence } from '../BacktestEvidence';
import { useBacktestData } from '../useBacktestData';
import type { BacktestMarketScope, BacktestStrategy } from '../types';

jest.mock('../useBacktestData', () => ({
  useBacktestData: () => mockBacktestDataResult,
}));

let mockBacktestDataResult: ReturnType<typeof useBacktestData>;

beforeAll(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    },
  });
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
});

type LiveArtifact = {
  generated_from: string;
  request_count: number;
  invalid_request_count: number;
  invalid_db_reads: number;
  pairs: [BacktestStrategy, BacktestMarketScope][];
  lists: Record<string, unknown>;
  details: Record<string, any>;
  holdings: Record<string, unknown>;
};

const artifactPath = process.env.T5D_RESPONSE_ARTIFACT;
const live = artifactPath
  ? (JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as LiveArtifact)
  : null;
const describeLive = live ? describe : describe.skip;

describeLive('Tab5 live disposable-PG E2E', () => {
  test('all 440 live responses pass landed URLs and adapters', () => {
    if (!live) throw new Error('T5D_RESPONSE_ARTIFACT is required');
    expect(live.generated_from).toBe('live-disposable-postgresql');
    expect(live.request_count).toBe(440);
    expect(live.invalid_request_count).toBe(18);
    expect(live.invalid_db_reads).toBe(0);
    let snapshotsSeen = 0;
    let holdingsSeen = 0;
    let sawStale = false;
    let sawDelisted = false;

    for (const [strategy, scope] of live.pairs) {
      expect(
        buildBacktestListUrl(strategy, {
          marketScope: scope,
          from: '2026-01-10',
          to: '2026-07-10',
          limit: 27,
        })
      ).toContain(`/api/v1/backtest-pit/${strategy}?`);
      const snapshots = parseSnapshotListResponse(
        live.lists[`${strategy}/${scope}`],
        strategy,
        scope
      );
      expect(snapshots).toHaveLength(27);
      snapshotsSeen += snapshots.length;

      for (const snapshot of snapshots) {
        expect(buildBacktestSnapshotUrl(strategy, scope, snapshot.as_of_utc)).toContain(
          encodeURIComponent(snapshot.as_of_utc)
        );
        expect(buildBacktestHoldingsUrl(strategy, snapshot)).toContain('/holdings?');
        const detail = live.details[snapshot.snapshot_id];
        expect(detail.snapshot_id).toBe(snapshot.snapshot_id);
        expect(detail.metrics.metric_contract_version).toBe('1.0.0');
        const holdings = parseHoldingsResponse(live.holdings[snapshot.snapshot_id]);
        expect(holdings).toHaveLength(3);
        expect(holdings.reduce((sum, holding) => sum + holding.weight, 0)).toBeCloseTo(1, 9);
        holdingsSeen += holdings.length;
        sawStale ||= holdings.some(holding => holding.is_stale);
        sawDelisted ||= snapshot.is_delisted_at_as_of === true;
      }
    }

    expect(snapshotsSeen).toBe(216);
    expect(holdingsSeen).toBe(648);
    expect(sawStale).toBe(true);
    expect(sawDelisted).toBe(true);
  });

  test('renders the real BacktestEvidence container from live parsed state', async () => {
    if (!live) throw new Error('T5D_RESPONSE_ARTIFACT is required');
    const snapshots = parseSnapshotListResponse(
      live.lists['us_preferred/us'],
      'us_preferred',
      'us'
    );
    const latest = snapshots[0];
    const holdings = parseHoldingsResponse(live.holdings[latest.snapshot_id]);

    mockBacktestDataResult = {
      snapshots,
      selectedSnapshot: latest,
      holdings,
      loading: false,
      holdingsLoading: false,
      error: null,
      holdingsError: null,
      selectSnapshot: () => undefined,
      refetchSnapshots: () => undefined,
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<BacktestEvidence />);
      await Promise.resolve();
    });
    const markup = container.innerHTML;

    expect(markup).toContain('回测证据台');
    expect(markup).toContain('POINT-IN-TIME / 6M');
    expect(markup).toContain('近 6 月胜率');
    expect(markup).toContain('最大回撤');
    expect(markup).toContain('夏普比率');
    expect(markup).toContain(`PIT · as_of ${latest.as_of_utc}`);
    expect(markup).toContain(latest.snapshot_day);

    const unselectedSnapshot = snapshots[1];
    const timelineNode = container.querySelector(
      `[aria-label="${unselectedSnapshot.snapshot_day} PIT 快照"]`
    ) as HTMLButtonElement | null;
    expect(timelineNode).not.toBeNull();
    await act(async () => {
      timelineNode?.click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(holdings[0].ticker);

    await act(async () => root.unmount());
    container.remove();
  });
});
