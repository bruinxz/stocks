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

function Harness({
  api,
  onState,
}: {
  api: Tab67Api;
  onState(state: DailyReportViewState, generate: () => Promise<void>): void;
}) {
  const runtime = useDailyReportRuntime(api, {
    profile: 'us_preferred',
    marketScope: 'us',
    tradingDay: '2026-07-10',
    setTimer: immediateTimer,
    clearTimer: noClearTimer,
    now: zeroNow,
  });
  const stateRef = React.useRef(runtime.state);
  const generateRef = React.useRef(runtime.generate);
  stateRef.current = runtime.state;
  generateRef.current = runtime.generate;
  React.useEffect(() => {
    onState(stateRef.current, generateRef.current);
  }, [onState, runtime.state]);
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

describe('live DailyReport runtime', () => {
  test('loads latest, maps 404 to empty, and polls generated report', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const report = reportFixture();
    const api = baseApi();
    api.latest.mockRejectedValueOnce(new Tab67ApiError(404, 'not found')).mockResolvedValue(report);
    api.submitReplay.mockResolvedValue({ job_id: 'job-1', status: 'queued' });
    api.replayStatus
      .mockResolvedValueOnce({ job_id: 'job-1', status: 'running' })
      .mockResolvedValueOnce({
        job_id: 'job-1',
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
});
