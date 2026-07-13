import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, jest, test } from '@jest/globals';
import type { Mocked } from 'jest-mock';
import { DailyReportContainer } from '../DailyReportContainer';
import { Tab67ApiError, type Tab67Api } from '../tab67Api';

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
    latest: jest.fn(async () => {
      throw new Tab67ApiError(404, 'not found');
    }),
    daily: jest.fn(),
    history: jest.fn(),
    snapshot: jest.fn(),
    diff: jest.fn(),
    submitReplay: jest.fn(),
    replayStatus: jest.fn(),
  } as unknown as Mocked<Tab67Api>;
}

describe('DailyReportContainer runtime capability', () => {
  test('default live mount disables Generate and never calls unavailable replay routes', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const api = apiFixture();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<DailyReportContainer api={api} tradingDay="2026-07-10" />);
      await Promise.resolve();
    });
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('回放生成待运行时接入');
    button.click();
    expect(api.submitReplay).not.toHaveBeenCalled();
    expect(api.replayStatus).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
