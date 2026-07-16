import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, jest, test } from '@jest/globals';
import type { Mocked } from 'jest-mock';
import { useDailyReportRuntime } from '../useDailyReportRuntime';
import { reportFixture } from '../testFixtures';
import { Tab67ApiError, type Tab67Api } from '../tab67Api';
import type { DailyReportViewState } from '../types';

const immediateTimer = ((callback: () => void) => {
  callback();
  return 1;
}) as typeof setTimeout;
const noClearTimer = (() => undefined) as typeof clearTimeout;
const zeroNow = () => 0;
const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function Harness({
  api,
  onState,
  now = zeroNow,
  profile = 'us_preferred',
  marketScope = 'us',
  setTimer = immediateTimer,
  clearTimer = noClearTimer,
}: {
  api: Tab67Api;
  onState(
    state: DailyReportViewState,
    generate: () => Promise<void>,
    retry: () => void
  ): void;
  now?: () => number;
  profile?: 'us_preferred' | 'multibagger';
  marketScope?: 'us';
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}) {
  const runtime = useDailyReportRuntime(api, {
    profile,
    marketScope,
    tradingDay: '2026-07-10',
    setTimer,
    clearTimer,
    now,
  });
  const stateRef = React.useRef(runtime.state);
  const generateRef = React.useRef(runtime.generate);
  stateRef.current = runtime.state;
  generateRef.current = runtime.generate;
  React.useEffect(() => {
    onState(stateRef.current, generateRef.current, runtime.retry);
  }, [onState, runtime.retry, runtime.state]);
  return null;
}

const baseApi = (): Mocked<Tab67Api> =>
  ({
    latest: jest.fn(),
    daily: jest.fn(),
    history: jest.fn(),
    snapshot: jest.fn(),
    diff: jest.fn(),
    submitReplay: jest.fn(),
    replayStatus: jest.fn(),
  }) as Mocked<Tab67Api>;

function controlledTimer() {
  let nextId = 1;
  const pending = new Set<number>();
  const cleared: number[] = [];
  const setTimer = ((callback: (...args: any[]) => void) => {
    const id = nextId++;
    pending.add(id);
    void callback;
    return id;
  }) as typeof setTimeout;
  const clearTimer = ((handle: ReturnType<typeof setTimeout>) => {
    const id = Number(handle);
    pending.delete(id);
    cleared.push(id);
  }) as typeof clearTimeout;
  return { setTimer, clearTimer, pending, cleared };
}

describe('live DailyReport runtime', () => {
  test('loads latest, maps 404 to empty, and polls generated report', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const report = reportFixture();
    const api = baseApi();
    api.latest.mockRejectedValue(new Tab67ApiError(404, 'not found'));
    api.daily.mockResolvedValue(report);
    api.submitReplay.mockResolvedValue({ job_id: JOB_ID, status: 'queued' });
    api.replayStatus
      .mockResolvedValueOnce({ job_id: JOB_ID, status: 'running' })
      .mockResolvedValueOnce({
        job_id: JOB_ID,
        status: 'completed',
        snapshot_id: report.snapshot.snapshot_id,
      });
    const states: DailyReportViewState[] = [];
    let generate: (() => Promise<void>) | undefined;
    const root = createRoot(document.createElement('div'));

    await act(async () => {
      root.render(
        <Harness
          api={api}
          onState={(state, nextGenerate) => {
            states.push(state);
            generate = nextGenerate;
          }}
        />
      );
    });
    expect(states.at(-1)).toEqual({
      kind: 'empty',
      profile: 'us_preferred',
      market_scope: 'us',
    });

    await act(async () => {
      await generate?.();
    });
    expect(states.at(-1)).toMatchObject({
      kind: 'ready',
      generation: { status: 'completed' },
    });
    expect(api.replayStatus).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  test('surfaces a safe terminal replay failure', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const api = baseApi();
    api.latest.mockRejectedValue(new Tab67ApiError(404, 'not found'));
    api.submitReplay.mockResolvedValue({
      job_id: JOB_ID,
      status: 'failed',
      error: 'replay source invalid',
    });
    const states: DailyReportViewState[] = [];
    let generate: (() => Promise<void>) | undefined;
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <Harness
          api={api}
          onState={(state, nextGenerate) => {
            states.push(state);
            generate = nextGenerate;
          }}
        />
      );
    });
    await act(async () => generate?.());
    expect(states.at(-1)).toEqual({ kind: 'error', message: 'replay source invalid' });
    expect(api.replayStatus).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  test('times out bounded polling without issuing another status request', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const api = baseApi();
    api.latest.mockRejectedValue(new Tab67ApiError(404, 'not found'));
    api.submitReplay.mockResolvedValue({ job_id: JOB_ID, status: 'queued' });
    let nowCalls = 0;
    const now = () => (nowCalls++ === 0 ? 0 : 60_001);
    const states: DailyReportViewState[] = [];
    let generate: (() => Promise<void>) | undefined;
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <Harness
          api={api}
          now={now}
          onState={(state, nextGenerate) => {
            states.push(state);
            generate = nextGenerate;
          }}
        />
      );
    });
    await act(async () => generate?.());
    expect(states.at(-1)).toEqual({ kind: 'error', message: '日报生成轮询超时，请重试' });
    expect(api.replayStatus).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  test('coalesces duplicate generate calls for the same mounted runtime', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const report = reportFixture();
    const api = baseApi();
    api.latest.mockRejectedValue(new Tab67ApiError(404, 'not found'));
    api.daily.mockResolvedValue(report);
    let finishSubmit: ((job: Awaited<ReturnType<Tab67Api['submitReplay']>>) => void) | undefined;
    api.submitReplay.mockImplementation(
      () =>
        new Promise(resolve => {
          finishSubmit = resolve;
        })
    );
    let generate: (() => Promise<void>) | undefined;
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <Harness api={api} onState={(_state, nextGenerate) => (generate = nextGenerate)} />
      );
    });
    await act(async () => {
      const first = generate?.();
      const duplicate = generate?.();
      expect(api.submitReplay).toHaveBeenCalledTimes(1);
      finishSubmit?.({
        job_id: JOB_ID,
        status: 'completed',
        snapshot_id: report.snapshot.snapshot_id,
      });
      await Promise.all([first, duplicate]);
    });
    expect(api.submitReplay).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  test('waits for the completed job snapshot instead of exposing an unrelated projection', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const report = reportFixture();
    const staleSnapshotId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const staleReport = {
      ...report,
      source_snapshot_ids: [staleSnapshotId],
      wire: { ...report.wire, source_snapshot_id: staleSnapshotId },
      snapshot: { ...report.snapshot, snapshot_id: staleSnapshotId },
    };
    const api = baseApi();
    api.latest.mockRejectedValue(new Tab67ApiError(404, 'not found'));
    api.submitReplay.mockResolvedValue({
      job_id: JOB_ID,
      status: 'completed',
      snapshot_id: report.snapshot.snapshot_id,
    });
    api.daily.mockResolvedValueOnce(staleReport).mockResolvedValue(report);
    const states: DailyReportViewState[] = [];
    let generate: (() => Promise<void>) | undefined;
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <Harness
          api={api}
          onState={(state, nextGenerate) => {
            states.push(state);
            generate = nextGenerate;
          }}
        />
      );
    });

    await act(async () => generate?.());

    expect(api.latest).toHaveBeenCalledTimes(1);
    expect(api.daily).toHaveBeenCalledTimes(2);
    const completedReadyStates = states.filter(
      state => state.kind === 'ready' && state.generation.status === 'completed'
    );
    expect(completedReadyStates).toHaveLength(1);
    expect(completedReadyStates[0]).toMatchObject({
      kind: 'ready',
      report: { snapshot: { snapshot_id: report.snapshot.snapshot_id } },
      generation: { status: 'completed', snapshot_id: report.snapshot.snapshot_id },
    });
    await act(async () => root.unmount());
  });

  test('retry aborts a pending poll delay, settles generation, and releases the generate lock', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const api = baseApi();
    const timer = controlledTimer();
    api.latest.mockRejectedValue(new Tab67ApiError(404, 'not found'));
    api.submitReplay
      .mockResolvedValueOnce({ job_id: JOB_ID, status: 'queued' })
      .mockResolvedValueOnce({
        job_id: JOB_ID,
        status: 'failed',
        error: 'second run reached',
      });
    let generate: (() => Promise<void>) | undefined;
    let retry: (() => void) | undefined;
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <Harness
          api={api}
          setTimer={timer.setTimer}
          clearTimer={timer.clearTimer}
          onState={(_state, nextGenerate, nextRetry) => {
            generate = nextGenerate;
            retry = nextRetry;
          }}
        />
      );
    });

    let firstGeneration: Promise<void> | undefined;
    await act(async () => {
      firstGeneration = generate?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(timer.pending.size).toBe(1);
    await act(async () => {
      retry?.();
      await firstGeneration;
      await Promise.resolve();
    });
    expect(timer.pending.size).toBe(0);
    expect(timer.cleared).toHaveLength(1);

    await act(async () => generate?.());
    expect(api.submitReplay).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  test('unmount aborts a pending poll delay and settles the generate promise', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const api = baseApi();
    const timer = controlledTimer();
    api.latest.mockRejectedValue(new Tab67ApiError(404, 'not found'));
    api.submitReplay.mockResolvedValue({ job_id: JOB_ID, status: 'queued' });
    let generate: (() => Promise<void>) | undefined;
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <Harness
          api={api}
          setTimer={timer.setTimer}
          clearTimer={timer.clearTimer}
          onState={(_state, nextGenerate) => (generate = nextGenerate)}
        />
      );
    });

    let generation: Promise<void> | undefined;
    await act(async () => {
      generation = generate?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(timer.pending.size).toBe(1);
    await act(async () => {
      root.unmount();
      await generation;
    });
    expect(timer.pending.size).toBe(0);
    expect(timer.cleared).toHaveLength(1);
  });

  test('profile changes abort a pending delay and allow generation under the new profile', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const api = baseApi();
    const timer = controlledTimer();
    api.latest.mockRejectedValue(new Tab67ApiError(404, 'not found'));
    api.submitReplay
      .mockResolvedValueOnce({ job_id: JOB_ID, status: 'queued' })
      .mockResolvedValueOnce({
        job_id: JOB_ID,
        status: 'failed',
        error: 'new profile run reached',
      });
    let generate: (() => Promise<void>) | undefined;
    const root = createRoot(document.createElement('div'));
    const onState = (_state: DailyReportViewState, nextGenerate: () => Promise<void>) => {
      generate = nextGenerate;
    };
    await act(async () => {
      root.render(
        <Harness
          api={api}
          profile="us_preferred"
          setTimer={timer.setTimer}
          clearTimer={timer.clearTimer}
          onState={onState}
        />
      );
    });

    let firstGeneration: Promise<void> | undefined;
    await act(async () => {
      firstGeneration = generate?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(timer.pending.size).toBe(1);
    await act(async () => {
      root.render(
        <Harness
          api={api}
          profile="multibagger"
          setTimer={timer.setTimer}
          clearTimer={timer.clearTimer}
          onState={onState}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      await firstGeneration;
    });
    expect(timer.pending.size).toBe(0);

    await act(async () => generate?.());
    expect(api.submitReplay).toHaveBeenNthCalledWith(
      2,
      { trading_day: '2026-07-10', profile: 'multibagger', market_scope: 'us' },
      expect.any(AbortSignal)
    );
    await act(async () => root.unmount());
  });

  test('aborts in-flight HTTP work when the container unmounts', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const api = baseApi();
    let observedSignal: AbortSignal | undefined;
    api.latest.mockImplementation((_profile, _scope, signal) => {
      observedSignal = signal;
      return new Promise(() => undefined);
    });
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(<Harness api={api} onState={() => undefined} />);
      await Promise.resolve();
    });
    expect(observedSignal?.aborted).toBe(false);
    await act(async () => root.unmount());
    expect(observedSignal?.aborted).toBe(true);
  });
});
