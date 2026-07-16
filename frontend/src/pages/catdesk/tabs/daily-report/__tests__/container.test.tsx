import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, jest, test } from '@jest/globals';
import type { Mocked } from 'jest-mock';
import { DailyReportContainer } from '../DailyReportContainer';
import { Tab67ApiError, type Tab67Api } from '../tab67Api';
import { reportFixture } from '../testFixtures';

const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock('antd', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
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

function apiFixture(): Mocked<Tab67Api> {
  return {
    latest: jest.fn(),
    daily: jest.fn(),
    history: jest.fn(),
    snapshot: jest.fn(),
    diff: jest.fn(),
    submitReplay: jest.fn(),
    replayStatus: jest.fn(),
  } as unknown as Mocked<Tab67Api>;
}

describe('DailyReportContainer runtime capability', () => {
  test('default live mount enables Generate and runs the replay route', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const api = apiFixture();
    const report = reportFixture();
    api.latest.mockRejectedValue(new Tab67ApiError(404, 'not found'));
    api.daily.mockResolvedValue(report);
    api.submitReplay.mockResolvedValue({
      job_id: JOB_ID,
      status: 'completed',
      snapshot_id: report.snapshot.snapshot_id,
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<DailyReportContainer api={api} tradingDay="2026-07-10" />);
      await Promise.resolve();
    });
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('生成日报');
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.submitReplay).toHaveBeenCalledWith(
      { trading_day: '2026-07-10', profile: 'us_preferred', market_scope: 'us' },
      expect.any(AbortSignal)
    );
    expect(api.replayStatus).not.toHaveBeenCalled();
    expect(api.latest).toHaveBeenCalledTimes(1);
    expect(api.daily).toHaveBeenCalledWith(
      '2026-07-10',
      'us_preferred',
      'us',
      expect.any(AbortSignal)
    );
    await act(async () => root.unmount());
  });
});
