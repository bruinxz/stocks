import fs from 'node:fs';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { DailyReportContainer } from '../DailyReportContainer';
import { createTab67HttpApi, type Tab67Api } from '../tab67Api';
import { useDailyReportRuntime, type DailyReportRuntime } from '../useDailyReportRuntime';
import type { DailyReportViewState, GenerationJob } from '../types';
import { ReportHistoryContainer } from '../../report-history/ReportHistoryContainer';

// react-markdown/remark-gfm are ESM-only in this CRA/Jest runtime.  Rendering
// remains inside the real report containers; only the markdown parser surface
// is replaced with its transparent test equivalent.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: () => undefined,
}));

type LiveArtifact = {
  generated_from: 'live-disposable-postgresql';
  base_url: string;
  authorization: string;
  profile: 'us_preferred';
  market_scope: 'us';
  initial_snapshot_count: 2;
  initial_item_count: 2;
  generation_request: {
    trading_day: string;
    profile: 'us_preferred';
    market_scope: 'us';
  };
  seeded_captures: Array<{
    request: { trading_day: string; profile: 'us_preferred'; market_scope: 'us' };
    pins: { input_fingerprint: string };
  }>;
  completed_jobs: Array<{ job_id: string; status: 'completed'; snapshot_id: string }>;
  latest: { source_snapshot_id: string; trading_day: string };
  by_date: { source_snapshot_id: string; trading_day: string };
  history: { total: number; entries: Array<{ source_snapshot_id: string }> };
  details: Array<{ snapshot_id: string }>;
  diff: {
    base_snapshot_id: string;
    target_snapshot_id: string;
    profile: 'us_preferred';
    market_scope: 'us';
  };
  negative: {
    future_source: true;
    wrong_scope: true;
    malformed_hash: true;
    duplicate_fact: true;
    idempotent_capture: true;
    wrong_scope_http: 400;
    malformed_request_http: 400;
    child_crash_http: 502;
    child_secret_redacted: true;
  };
};

const artifactPath = process.env.T67_RESPONSE_ARTIFACT;
const live = artifactPath
  ? (JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as LiveArtifact)
  : null;
const describeLive = live ? describe : describe.skip;

let nativeFetch: typeof fetch;

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
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Node fetch is required for the live localhost transport');
  }
  nativeFetch = globalThis.fetch.bind(globalThis);
});

async function eventually(assertion: () => void, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (caught) {
      error = caught;
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
      });
    }
  }
  throw error;
}

async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}

function GenerationHarness({
  api,
  tradingDay,
  onRuntime,
  onState,
}: {
  api: Tab67Api;
  tradingDay: string;
  onRuntime(runtime: DailyReportRuntime): void;
  onState(state: DailyReportViewState): void;
}) {
  const runtime = useDailyReportRuntime(api, {
    profile: 'us_preferred',
    marketScope: 'us',
    tradingDay,
    setTimer: ((callback: (...args: any[]) => void) => setTimeout(callback, 0)) as typeof setTimeout,
  });
  React.useEffect(() => {
    onRuntime(runtime);
  }, [onRuntime, runtime]);
  React.useEffect(() => {
    onState(runtime.state);
  }, [onState, runtime.state]);
  return null;
}

describeLive('Tab6/7 total live disposable-PG E2E', () => {
  test('real HTTP adapters, hooks and containers consume the cross-process artifact', async () => {
    if (!live) throw new Error('T67_RESPONSE_ARTIFACT is required');
    expect(live.generated_from).toBe('live-disposable-postgresql');
    expect(live.initial_snapshot_count).toBe(2);
    expect(live.initial_item_count).toBe(2);
    expect(live.history.total).toBe(2);
    expect(live.negative).toEqual({
      future_source: true,
      wrong_scope: true,
      malformed_hash: true,
      duplicate_fact: true,
      idempotent_capture: true,
      wrong_scope_http: 400,
      malformed_request_http: 400,
      child_crash_http: 502,
      child_secret_redacted: true,
    });

    const networkCalls: string[] = [];
    const api = createTab67HttpApi(async (input, init = {}) => {
      const path = String(input);
      if (!path.startsWith('/api/')) throw new Error(`non-canonical live path: ${path}`);
      const headers = new Headers(init.headers);
      headers.set('Authorization', live.authorization);
      networkCalls.push(`${init.method ?? 'GET'} ${path}`);
      return nativeFetch(`${live.base_url}${path}`, { ...init, headers });
    });
    const signal = new AbortController().signal;

    // Every response crosses localhost HTTP and then the landed strict adapters.
    const initialLatest = await api.latest('us_preferred', 'us', signal);
    expect(initialLatest.snapshot.snapshot_id).toBe(live.latest.source_snapshot_id);
    expect(initialLatest.trading_day).toBe(live.latest.trading_day);
    const initialByDate = await api.daily(
      live.by_date.trading_day,
      'us_preferred',
      'us',
      signal
    );
    expect(initialByDate.snapshot.snapshot_id).toBe(live.by_date.source_snapshot_id);
    const initialHistory = await api.history(
      { profile: 'us_preferred', market_scope: 'us', page: 1, page_size: 20 },
      signal
    );
    expect(initialHistory.total).toBe(2);
    const initialDetail = await api.snapshot(live.details[0].snapshot_id, signal);
    expect(initialDetail.meta.input_fingerprint).toBe(
      live.seeded_captures[0].pins.input_fingerprint
    );
    const initialDiff = await api.diff(
      live.diff.base_snapshot_id,
      live.diff.target_snapshot_id,
      signal
    );
    expect(initialDiff.profile).toBe('us_preferred');
    expect(initialDiff.market_scope).toBe('us');

    // Drive Generate through the landed hook. The server uses http_wait_ms=0,
    // so this exercises POST plus durable status polling rather than a fixture shortcut.
    let runtime: DailyReportRuntime | undefined;
    const generationStates: DailyReportViewState[] = [];
    const generationContainer = document.createElement('div');
    document.body.appendChild(generationContainer);
    const generationRoot = createRoot(generationContainer);
    await act(async () => {
      generationRoot.render(
        <GenerationHarness
          api={api}
          tradingDay={live.generation_request.trading_day}
          onRuntime={value => {
            runtime = value;
          }}
          onState={state => generationStates.push(state)}
        />
      );
    });
    await eventually(() => expect(runtime?.state.kind).toBe('ready'));
    await act(async () => {
      await runtime?.generate();
    });
    const generated = generationStates.at(-1);
    expect(generated?.kind).toBe('ready');
    if (!generated || generated.kind !== 'ready') throw new Error('generation did not finish');
    expect(generated.report.trading_day).toBe(live.generation_request.trading_day);
    expect(generated.generation.status).toBe('completed');
    const generatedJob = generated.generation as Extract<GenerationJob, { status: 'completed' }>;
    expect(generated.report.snapshot.snapshot_id).toBe(generatedJob.snapshot_id);
    expect(networkCalls.some(call => call === 'POST /api/v1/ai/recommendations/replay')).toBe(true);
    expect(networkCalls.some(call => call.startsWith('GET /api/v1/ai/recommendations/status?'))).toBe(
      true
    );
    await unmount(generationRoot, generationContainer);

    // Real DailyReportContainer renders the third generation via the same API/hook stack.
    const dailyContainer = document.createElement('div');
    document.body.appendChild(dailyContainer);
    const dailyRoot = createRoot(dailyContainer);
    await act(async () => {
      dailyRoot.render(
        <DailyReportContainer api={api} tradingDay={live.generation_request.trading_day} />
      );
    });
    await eventually(() => {
      expect(dailyContainer.textContent).toContain('每日日报');
      expect(dailyContainer.textContent).toContain(live.generation_request.trading_day);
      expect(dailyContainer.textContent).toContain('7203');
      expect(dailyContainer.querySelector('.report-document')).not.toBeNull();
    });
    await unmount(dailyRoot, dailyContainer);

    // Real ReportHistoryContainer selects detail and compares the newest snapshot
    // against the strictly older same-profile/same-scope predecessor.
    const historyContainer = document.createElement('div');
    document.body.appendChild(historyContainer);
    const historyRoot = createRoot(historyContainer);
    await act(async () => {
      historyRoot.render(
        <MemoryRouter
          initialEntries={[
            '/catdesk?profile=us_preferred&market_scope=us&page=1&page_size=20',
          ]}
        >
          <ReportHistoryContainer api={api} />
        </MemoryRouter>
      );
    });
    await eventually(() => {
      expect(historyContainer.textContent).toContain('3 reports');
      expect(historyContainer.querySelectorAll('tbody tr')).toHaveLength(3);
    });
    const newestRow = historyContainer.querySelector('tbody tr') as HTMLTableRowElement;
    const buttons = Array.from(newestRow.querySelectorAll('button'));
    const compactText = (button: HTMLButtonElement) =>
      button.textContent?.replace(/\s+/g, '') ?? '';
    const view = buttons.find(button => compactText(button).includes('查看'));
    const compare = buttons.find(button => compactText(button).includes('对比前次'));
    expect(view).toBeDefined();
    expect(compare).toBeDefined();
    await act(async () => {
      view?.click();
    });
    await eventually(() => {
      expect(historyContainer.querySelector('.report-document')).not.toBeNull();
      expect(historyContainer.textContent).toContain(live.generation_request.trading_day);
    });
    await act(async () => {
      compare?.click();
    });
    await eventually(() => {
      expect(historyContainer.querySelector('[aria-label="快照对比结果"]')).not.toBeNull();
      expect(historyContainer.textContent).toContain('DIFF');
    });
    expect(networkCalls.some(call => call.includes('/diff/'))).toBe(true);
    await unmount(historyRoot, historyContainer);
  }, 60_000);
});
