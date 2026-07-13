import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { mergeHistoryQuery, parseHistoryQuery } from './queryState';
import type { B5HistoryEntryWire, ReportHistoryQuery, ReportHistoryViewState } from './types';
import type { Tab67Api } from '../daily-report/tab67Api';

export interface ReportHistoryRuntime {
  state: ReportHistoryViewState;
  setQuery(patch: Partial<ReportHistoryQuery>): void;
  select(reportId: string): Promise<void>;
  compare(snapshotId: string): Promise<void>;
  retry(): void;
}

function historyKey(entry: B5HistoryEntryWire): [string, string, string] {
  return [entry.trading_day, entry.source_as_of, entry.source_snapshot_id];
}

function compareHistoryKey(
  left: [string, string, string],
  right: [string, string, string]
): number {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function findNewestHistoryPredecessor(
  entries: readonly B5HistoryEntryWire[],
  target: B5HistoryEntryWire
): B5HistoryEntryWire | null {
  const targetKey = historyKey(target);
  return entries.reduce<B5HistoryEntryWire | null>((predecessor, entry) => {
    if (
      entry.profile !== target.profile ||
      entry.market_scope !== target.market_scope ||
      compareHistoryKey(historyKey(entry), targetKey) >= 0
    ) {
      return predecessor;
    }
    return predecessor == null || compareHistoryKey(historyKey(entry), historyKey(predecessor)) > 0
      ? entry
      : predecessor;
  }, null);
}

export function findHistoryPredecessor(
  entries: readonly B5HistoryEntryWire[],
  snapshotId: string
): B5HistoryEntryWire | null {
  const target = entries.find(entry => entry.source_snapshot_id === snapshotId);
  return target ? findNewestHistoryPredecessor(entries, target) : null;
}

export function historyComparisonIds(
  entries: readonly B5HistoryEntryWire[],
  targetSnapshotId: string
): [string, string] | null {
  const predecessor = findHistoryPredecessor(entries, targetSnapshotId);
  return predecessor ? [predecessor.source_snapshot_id, targetSnapshotId] : null;
}

export function useReportHistoryRuntime(api: Tab67Api): ReportHistoryRuntime {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = `?${searchParams.toString()}`;
  const query = useMemo(() => parseHistoryQuery(search), [search]);
  const [state, setState] = useState<ReportHistoryViewState>({ kind: 'loading' });
  const controllerRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const load = useCallback(async () => {
    stop();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: 'loading' });
    try {
      const page = await api.history(query, controller.signal);
      if (controller.signal.aborted) return;
      setState(page.total === 0 ? { kind: 'empty', query } : { kind: 'ready', page, query });
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, [api, query, stop]);

  useEffect(() => {
    void load();
    return stop;
  }, [load, stop]);

  const setQuery = useCallback(
    (patch: Partial<ReportHistoryQuery>) => {
      const next = mergeHistoryQuery(search, patch);
      setSearchParams(new URLSearchParams(next), { replace: false });
    },
    [search, setSearchParams]
  );

  const select = useCallback(
    async (reportId: string) => {
      if (state.kind !== 'ready') return;
      const entry = state.page.entries.find(candidate => candidate.report_id === reportId);
      if (!entry) throw new Error('报告条目不在当前结果页');
      stop();
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const [report, snapshot] = await Promise.all([
          api.daily(entry.trading_day, entry.profile, entry.market_scope, controller.signal),
          api.snapshot(entry.snapshot_id, controller.signal),
        ]);
        if (!controller.signal.aborted)
          setState({ ...state, selected_report: report, selected_snapshot: snapshot });
      } catch (error) {
        if (!controller.signal.aborted) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    [api, state, stop]
  );

  const compare = useCallback(
    async (snapshotId: string) => {
      if (state.kind !== 'ready') return;
      const target =
        state.page.entries.find(entry => entry.snapshot_id === snapshotId)?.wire ??
        state.page.wire.entries.find(entry => entry.source_snapshot_id === snapshotId);
      if (!target) {
        setState({ kind: 'error', message: '当前范围没有可对比的前序快照' });
        return;
      }
      stop();
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        // Backend returns one bounded history wire (default 365, maximum 1000);
        // page/page_size only select the visible client slice.
        const predecessor = findNewestHistoryPredecessor(state.page.wire.entries, target);
        if (!predecessor) {
          if (!controller.signal.aborted) {
            setState({ kind: 'error', message: '当前范围没有可对比的前序快照' });
          }
          return;
        }
        const comparison = await api.diff(
          predecessor.source_snapshot_id,
          target.source_snapshot_id,
          controller.signal
        );
        if (!controller.signal.aborted) setState({ ...state, comparison });
      } catch (error) {
        if (!controller.signal.aborted) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    [api, state, stop]
  );

  return { state, setQuery, select, compare, retry: load };
}
