import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, jest, test } from '@jest/globals';
import { DailyReport } from '../../DailyReport';
import { ReportHistory } from '../../ReportHistory';
import { tokenizeEvidence } from '../evidenceTokens';
import { nextGenerationState, parseGenerationJob, pollDelay } from '../generationMachine';
import { reportFixture } from '../testFixtures';
import type { ReportHistoryPage, ReportHistoryViewState } from '../../report-history/types';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock('antd', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
jest.mock('../../../shared/LoadingState', () => ({
  LoadingState: () => <div aria-busy="true">loading</div>,
}));
jest.mock('../../../shared/ErrorState', () => ({
  ErrorState: ({ message }: { message: string }) => <div role="alert">{message}</div>,
}));
jest.mock('../../../shared/EmptyState', () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));

const report = reportFixture();
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
    entries: [],
    total: 1,
  },
  entries: [
    {
      wire: {
        report_id: report.report_id,
        trading_day: report.trading_day,
        profile: report.snapshot.profile,
        market_scope: report.snapshot.market_scope,
        source_snapshot_id: report.snapshot.snapshot_id,
        source_as_of: report.snapshot.as_of,
        source_output_fingerprint: report.snapshot.output_fingerprint,
        source_fingerprint_preimage_jcs: '{}',
        input_fingerprint: report.snapshot.meta.input_fingerprint,
        contract_version: '0.3.1',
        profile_version: report.snapshot.meta.profile_version,
        strategy_version: report.snapshot.meta.strategy_version,
        pipeline_version: report.snapshot.meta.pipeline_version,
        disclaimer_version: report.snapshot.disclaimer.version,
        item_count: 1,
        high_conviction_count: 1,
        rating_counts: { A: 1, B: 0, C: 0, D: 0, F: 0 },
        content_preview: '证据优先',
      },
      report_id: report.report_id,
      trading_day: report.trading_day,
      profile: report.snapshot.profile,
      market_scope: report.snapshot.market_scope,
      snapshot_id: report.snapshot.snapshot_id,
      output_fingerprint: report.snapshot.output_fingerprint,
      entry_count: 1,
      high_conviction_count: 1,
      top_rating: 'A',
      generated_at: report.snapshot.as_of,
      content_preview: '证据优先',
    },
  ],
  total: 1,
  page: 1,
  page_size: 20,
  query: { page: 1, page_size: 20 },
};

describe('Tab 6/7 contract-first behavior', () => {
  test('renders loading, error, and empty states without live HTTP', () => {
    expect(renderToStaticMarkup(<DailyReport state={{ kind: 'loading' }} />)).toContain(
      'aria-busy="true"'
    );
    expect(
      renderToStaticMarkup(<DailyReport state={{ kind: 'error', message: '生成失败' }} />)
    ).toContain('生成失败');
    expect(
      renderToStaticMarkup(
        <DailyReport state={{ kind: 'empty', profile: 'us_preferred', market_scope: 'us' }} />
      )
    ).toContain('当前范围暂无已归档日报');
    expect(
      renderToStaticMarkup(
        <ReportHistory state={{ kind: 'empty', query: { page: 1, page_size: 20 } }} />
      )
    ).toContain('当前筛选条件下没有归档报告');
  });

  test('renders successful report, evidence links, disclaimer, KPI, history and compare', () => {
    const daily = renderToStaticMarkup(
      <DailyReport
        state={{
          kind: 'ready',
          report,
          generation: {
            job_id: '33333333-3333-4333-8333-333333333333',
            status: 'completed',
            snapshot_id: report.snapshot.snapshot_id,
          },
        }}
      />
    );
    expect(daily).toContain('RECOMMENDATION SNAPSHOT / V0.3.1');
    expect(daily).toContain('href="sec-edgar://');
    expect(daily).toContain('投资有风险');
    expect(daily).toContain('高确信度');

    const historyState: ReportHistoryViewState = {
      kind: 'ready',
      page,
      query: { page: 1, page_size: 20 },
      selected_report: report,
      selected_snapshot: report.snapshot,
      comparison: {
        base_snapshot_id: report.snapshot.snapshot_id,
        target_snapshot_id: '44444444-4444-4444-8444-444444444444',
        profile: 'us_preferred',
        market_scope: 'us',
        fingerprint_match: false,
        added: ['MSFT'],
        removed: [],
        changed: ['AAPL'],
        unchanged: [],
      },
    };
    const history = renderToStaticMarkup(<ReportHistory state={historyState} />);
    expect(history).toContain('SNAPSHOT REGISTER');
    expect(history).toContain('新增');
    expect(history).toContain('AAPL');
  });

  test('parses evidence tokens and rejects dangling markers', () => {
    const refs = report.snapshot.items[0].recommendation.evidence_refs;
    expect(tokenizeEvidence('Alpha [E1] omega', refs).map(segment => segment.kind)).toEqual([
      'text',
      'evidence',
      'text',
    ]);
    expect(() => tokenizeEvidence('Missing [E2]', refs)).toThrow(/Unknown evidence token/);
  });

  test('enforces generate/poll state progression, terminal states and backoff cap', () => {
    const queued = parseGenerationJob({ job_id: 'job-1', status: 'queued' });
    const running = parseGenerationJob({ job_id: 'job-1', status: 'running' });
    const completed = parseGenerationJob({
      job_id: 'job-1',
      status: 'completed',
      snapshot_id: report.snapshot.snapshot_id,
    });
    expect(nextGenerationState(queued, running)).toEqual(running);
    expect(nextGenerationState(running, completed)).toEqual(completed);
    expect(() => nextGenerationState(completed, running)).toThrow(/backwards|Terminal/);
    expect(() => parseGenerationJob({ job_id: 'job-2', status: 'completed' })).toThrow(
      /snapshot_id/
    );
    expect([0, 1, 2, 3, 50].map(pollDelay)).toEqual([1000, 2000, 5000, 10000, 10000]);
  });

  test('dispatches mocked generate, history detail, compare, and retry actions', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    const root = createRoot(container);
    const onGenerate = jest.fn();
    const onSelect = jest.fn();
    const onCompare = jest.fn();
    const onRetry = jest.fn();

    await act(async () => {
      root.render(
        <DailyReport
          state={{ kind: 'empty', profile: 'us_preferred', market_scope: 'us' }}
          onGenerate={onGenerate}
        />
      );
    });
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onGenerate).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <ReportHistory
          state={{ kind: 'ready', page, query: { page: 1, page_size: 20 } }}
          onSelect={onSelect}
          onCompare={onCompare}
        />
      );
    });
    const historyButtons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
    historyButtons[0].click();
    historyButtons[1].click();
    expect(onSelect).toHaveBeenCalledWith(report.report_id);
    expect(onCompare).toHaveBeenCalledWith(report.snapshot.snapshot_id);

    await act(async () => {
      root.render(<DailyReport state={{ kind: 'error', message: 'failed' }} onRetry={onRetry} />);
    });
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
