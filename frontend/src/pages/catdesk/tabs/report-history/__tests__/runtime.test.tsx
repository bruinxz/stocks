import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, jest, test } from '@jest/globals';
import type { Mocked } from 'jest-mock';
import {
  findHistoryPredecessor,
  historyComparisonIds,
  useReportHistoryRuntime,
} from '../useReportHistoryRuntime';
import type { B5HistoryEntryWire, ReportHistoryPage, ReportHistoryViewState } from '../types';
import { reportFixture } from '../../daily-report/testFixtures';
import type { Tab67Api } from '../../daily-report/tab67Api';

function Harness({
  api,
  onState,
  onRuntime,
}: {
  api: Tab67Api;
  onState(state: ReportHistoryViewState): void;
  onRuntime?(runtime: ReturnType<typeof useReportHistoryRuntime>): void;
}) {
  const runtime = useReportHistoryRuntime(api);
  const compareRef = React.useRef(runtime.compare);
  compareRef.current = runtime.compare;
  React.useEffect(() => {
    onState(runtime.state);
  }, [onState, runtime.state]);
  React.useEffect(() => {
    onRuntime?.({
      state: runtime.state,
      setQuery: runtime.setQuery,
      select: runtime.select,
      compare: snapshotId => compareRef.current(snapshotId),
      retry: runtime.retry,
    });
    // Expose stable test drivers once; compare delegates to the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRuntime]);
  return null;
}

function historyEntry(
  snapshot: string,
  day: string,
  asOf: string,
  profile: B5HistoryEntryWire['profile'] = 'us_preferred',
  marketScope: B5HistoryEntryWire['market_scope'] = 'us'
): B5HistoryEntryWire {
  return {
    report_id: `report-${snapshot}`,
    trading_day: day,
    profile,
    market_scope: marketScope,
    source_snapshot_id: snapshot,
    source_as_of: asOf,
    source_output_fingerprint: 'a'.repeat(64),
    source_fingerprint_preimage_jcs: '{}',
    input_fingerprint: 'b'.repeat(64),
    contract_version: '0.3.1',
    profile_version: '1.0.0',
    strategy_version: '1.0.0',
    pipeline_version: '1.0.0',
    disclaimer_version: '1.0.0',
    item_count: 0,
    high_conviction_count: 0,
    rating_counts: { A: 0, B: 0, C: 0, D: 0, F: 0 },
    content_preview: 'preview',
  };
}

function visibleEntry(wire: B5HistoryEntryWire): ReportHistoryPage['entries'][number] {
  return {
    wire,
    report_id: wire.report_id,
    trading_day: wire.trading_day,
    profile: wire.profile,
    market_scope: wire.market_scope,
    snapshot_id: wire.source_snapshot_id,
    output_fingerprint: wire.source_output_fingerprint,
    entry_count: wire.item_count,
    high_conviction_count: wire.high_conviction_count,
    top_rating: null,
    generated_at: wire.source_as_of,
    content_preview: wire.content_preview,
  };
}

describe('live ReportHistory runtime', () => {
  test('loads query-preserving history state', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const report = reportFixture();
    const wireEntry = historyEntry(
      report.snapshot.snapshot_id,
      report.trading_day,
      report.snapshot.as_of
    );
    const page: ReportHistoryPage = {
      wire: {
        projection_version: '0.1.0',
        filters: {
          query: 'aapl',
          profile: 'us_preferred',
          market_scope: 'us',
          from_day: null,
          to_day: null,
        },
        entries: [wireEntry],
        total: 1,
      },
      entries: [visibleEntry(wireEntry)],
      total: 1,
      page: 2,
      page_size: 10,
      query: {
        profile: 'us_preferred',
        market_scope: 'cn_a',
        search: 'aapl',
        page: 2,
        page_size: 10,
      },
    };
    const api = {
      latest: jest.fn(),
      daily: jest.fn(),
      history: jest.fn(async () => page),
      snapshot: jest.fn(),
      diff: jest.fn(),
      submitReplay: jest.fn(),
      replayStatus: jest.fn(),
    } as unknown as Mocked<Tab67Api>;
    const states: ReportHistoryViewState[] = [];
    const root = createRoot(document.createElement('div'));

    await act(async () => {
      root.render(
        <MemoryRouter
          initialEntries={[
            '/catdesk?tab=history&profile=us_preferred&market_scope=us&search=aapl&page=2&page_size=10',
          ]}
        >
          <Harness api={api} onState={state => states.push(state)} />
        </MemoryRouter>
      );
    });
    expect(api.history).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: 'us_preferred',
        market_scope: 'cn_a',
        search: 'aapl',
        page: 2,
        page_size: 10,
      }),
      expect.any(AbortSignal)
    );
    expect(states.at(-1)).toMatchObject({ kind: 'ready', page: { total: 1 } });
    await act(async () => root.unmount());
  });

  test('selects the newest strictly older predecessor in the same profile and scope', () => {
    const target = historyEntry(
      '11111111-1111-4111-8111-111111111111',
      '2026-07-10',
      '2026-07-10T10:00:00Z'
    );
    const sameDayOlder = historyEntry(
      '22222222-2222-4222-8222-222222222222',
      '2026-07-10',
      '2026-07-10T09:00:00Z'
    );
    const newestOlder = historyEntry(
      '33333333-3333-4333-8333-333333333333',
      '2026-07-09',
      '2026-07-09T23:00:00Z'
    );
    const olderAtPaginationBoundary = historyEntry(
      '44444444-4444-4444-8444-444444444444',
      '2026-07-08',
      '2026-07-08T23:00:00Z'
    );
    const wrongProfile = historyEntry(
      '55555555-5555-4555-8555-555555555555',
      '2026-07-10',
      '2026-07-10T09:30:00Z',
      'multibagger',
      'us'
    );
    const wrongScope = historyEntry(
      '66666666-6666-4666-8666-666666666666',
      '2026-07-10',
      '2026-07-10T09:45:00Z',
      'us_preferred',
      'cn_a'
    );
    const future = historyEntry(
      '77777777-7777-4777-8777-777777777777',
      '2026-07-11',
      '2026-07-11T09:00:00Z'
    );
    const mixed = [
      wrongProfile,
      future,
      olderAtPaginationBoundary,
      target,
      wrongScope,
      newestOlder,
      sameDayOlder,
    ];
    expect(findHistoryPredecessor(mixed, target.source_snapshot_id)?.source_snapshot_id).toBe(
      sameDayOlder.source_snapshot_id
    );
    expect(historyComparisonIds(mixed, target.source_snapshot_id)).toEqual([
      sameDayOlder.source_snapshot_id,
      target.source_snapshot_id,
    ]);
    expect(
      findHistoryPredecessor([target, wrongProfile, wrongScope, future], target.source_snapshot_id)
    ).toBeNull();
  });

  test('uses snapshot id as the final strict canonical-key tie-break', () => {
    const target = historyEntry(
      '55555555-5555-4555-8555-555555555555',
      '2026-07-10',
      '2026-07-10T10:00:00Z'
    );
    const lower = historyEntry(
      '44444444-4444-4444-8444-444444444444',
      target.trading_day,
      target.source_as_of
    );
    const greatestLower = historyEntry(
      '55555555-5555-4555-8555-555555555554',
      target.trading_day,
      target.source_as_of
    );
    const higher = historyEntry(
      '66666666-6666-4666-8666-666666666666',
      target.trading_day,
      target.source_as_of
    );
    expect(
      findHistoryPredecessor([higher, lower, target, greatestLower], target.source_snapshot_id)
        ?.source_snapshot_id
    ).toBe(greatestLower.source_snapshot_id);
  });

  test('compares against a predecessor beyond the visible client slice in the bounded wire', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const target = historyEntry(
      '11111111-1111-4111-8111-111111111111',
      '2026-07-10',
      '2026-07-10T10:00:00Z'
    );
    const predecessor = historyEntry(
      '22222222-2222-4222-8222-222222222222',
      '2026-07-09',
      '2026-07-09T10:00:00Z'
    );
    const page: ReportHistoryPage = {
      wire: {
        projection_version: '0.1.0',
        filters: {
          query: '',
          profile: 'us_preferred',
          market_scope: 'us',
          from_day: null,
          to_day: null,
        },
        entries: [target, predecessor],
        total: 2,
      },
      entries: [visibleEntry(target)],
      total: 2,
      page: 1,
      page_size: 1,
      query: { profile: 'us_preferred', market_scope: 'us', page: 1, page_size: 1 },
    };
    const api = {
      latest: jest.fn(),
      daily: jest.fn(),
      history: jest.fn(async () => page),
      snapshot: jest.fn(),
      diff: jest.fn(async () => ({
        base_snapshot_id: predecessor.source_snapshot_id,
        target_snapshot_id: target.source_snapshot_id,
        profile: 'us_preferred' as const,
        market_scope: 'us' as const,
        fingerprint_match: false,
        added: [],
        removed: [],
        changed: [],
        unchanged: [],
      })),
      submitReplay: jest.fn(),
      replayStatus: jest.fn(),
    } as unknown as Mocked<Tab67Api>;
    let compare: ((snapshotId: string) => Promise<void>) | undefined;
    const root = createRoot(document.createElement('div'));

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/catdesk?tab=history&page=1&page_size=1']}>
          <Harness
            api={api}
            onState={() => undefined}
            onRuntime={runtime => {
              compare = runtime.compare;
            }}
          />
        </MemoryRouter>
      );
    });
    await act(async () => {
      await compare?.(target.source_snapshot_id);
    });
    expect(api.diff).toHaveBeenCalledWith(
      predecessor.source_snapshot_id,
      target.source_snapshot_id,
      expect.any(AbortSignal)
    );
    expect(api.history).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  test('reports a controlled error without a diff request when no predecessor exists', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const target = historyEntry(
      '11111111-1111-4111-8111-111111111111',
      '2026-07-10',
      '2026-07-10T10:00:00Z'
    );
    const wrongScope = historyEntry(
      '22222222-2222-4222-8222-222222222222',
      '2026-07-09',
      '2026-07-09T10:00:00Z',
      'us_preferred',
      'cn_a'
    );
    const page: ReportHistoryPage = {
      wire: {
        projection_version: '0.1.0',
        filters: {
          query: '',
          profile: null,
          market_scope: null,
          from_day: null,
          to_day: null,
        },
        entries: [target, wrongScope],
        total: 2,
      },
      entries: [visibleEntry(target)],
      total: 2,
      page: 1,
      page_size: 1,
      query: { page: 1, page_size: 1 },
    };
    const api = {
      latest: jest.fn(),
      daily: jest.fn(),
      history: jest.fn(async () => page),
      snapshot: jest.fn(),
      diff: jest.fn(),
      submitReplay: jest.fn(),
      replayStatus: jest.fn(),
    } as unknown as Mocked<Tab67Api>;
    const states: ReportHistoryViewState[] = [];
    let compare: ((snapshotId: string) => Promise<void>) | undefined;
    const root = createRoot(document.createElement('div'));

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/catdesk?tab=history&page=1&page_size=1']}>
          <Harness
            api={api}
            onState={state => states.push(state)}
            onRuntime={runtime => {
              compare = runtime.compare;
            }}
          />
        </MemoryRouter>
      );
    });
    await act(async () => {
      await compare?.(target.source_snapshot_id);
    });
    expect(api.diff).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({
      kind: 'error',
      message: '当前范围没有可对比的前序快照',
    });
    await act(async () => root.unmount());
  });
});
