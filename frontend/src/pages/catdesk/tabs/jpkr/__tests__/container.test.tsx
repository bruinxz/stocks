import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import JpKrMarket from '../JpKrMarket';

jest.mock('shared/components/FilterChip', () => ({
  FilterChip: ({ ariaLabel }: { ariaLabel: string }) => <div aria-label={ariaLabel} />,
}));
jest.mock('shared/components/DetailSidebar', () => ({
  DetailSidebar: () => null,
  DataSourceBadge: () => null,
}));
jest.mock('../../../shared/LoadingState', () => ({
  LoadingState: () => <div aria-busy="true">loading</div>,
}));
jest.mock('../../../shared/EmptyState', () => ({
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty-state">{title}</div>,
}));
jest.mock('../../../shared/ErrorState', () => ({
  ErrorState: ({ message }: { message: string }) => <div role="alert">{message}</div>,
}));
jest.mock('../../../shared/DisclaimerFooter', () => ({
  DisclaimerFooter: () => null,
}));
jest.mock('../JpKrTable', () => ({
  JpKrTable: ({ rows, error }: { rows: Array<{ symbol: string }>; error: Error | null }) =>
    error ? (
      <div role="alert">table error</div>
    ) : (
      <div>{rows.map(row => row.symbol).join(',')}</div>
    ),
}));

const DATE = '2026-07-10';
const originalFetch = globalThis.fetch;

function marketRow() {
  return {
    symbol: '7203',
    name_local: 'トヨタ自動車',
    name_en: 'Toyota Motor',
    market: 'JP',
    sector: 'automotive',
    close: 3125.5,
    change_pct: 1.25,
    currency: 'JPY',
    disclosure_events: [],
    revenue_by_region: [],
    fx_beta: 0.75,
    is_halted: false,
    data_sources: ['jpx-daily-statistics-pdf'],
    score: null,
    risk_gate: null,
    risk_triggers: [],
  };
}

function payload(rows: unknown[] = [marketRow()]) {
  return {
    date: DATE,
    kpi: {
      nikkei225: { value: 41000.5, change_pct: 0.8, as_of: DATE },
      topix: { value: 2900.25, change_pct: 0.4, as_of: DATE },
      kospi: null,
      usdjpy: { rate: 150.25, change_pct: 0.2, as_of: DATE },
      usdkrw: null,
    },
    rows,
  };
}

function installFetch(body: unknown): ReturnType<typeof jest.fn> {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('JpKrMarket real container', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('loads through the strict HTTP adapter and renders five honest KPI slots', async () => {
    const fetchMock = installFetch(payload());

    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/jpkr-market/${DATE}?market=JP`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(container.textContent).toContain('41,000.50');
    expect(container.textContent).toContain('150.25');
    expect(container.textContent).toContain('BOJ');
    expect(container.querySelectorAll('[data-state="available"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-state="unavailable"]')).toHaveLength(2);
    expect(container.textContent?.match(/Unavailable/g)).toHaveLength(2);
    expect(container.textContent).toContain('7203');
  });

  test('keeps the loading state visible until the HTTP response settles', async () => {
    let resolveFetch: ((response: unknown) => void) | undefined;
    globalThis.fetch = jest.fn(
      () =>
        new Promise(resolve => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;

    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await Promise.resolve();
    });
    expect(container.querySelector('[aria-busy="true"]')?.textContent).toBe('loading');

    await act(async () => {
      resolveFetch?.({
        ok: true,
        status: 200,
        json: async () => payload(),
      });
      await settle();
    });
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.textContent).toContain('41,000.50');
  });

  test('keeps KPI unavailable distinct from zero while preserving the empty state', async () => {
    installFetch({
      ...payload([]),
      kpi: {},
    });

    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await settle();
    });

    expect(container.querySelectorAll('[data-state="unavailable"]')).toHaveLength(5);
    expect(container.textContent?.match(/Unavailable/g)).toHaveLength(5);
    expect(container.textContent).not.toContain('0.00');
    expect(container.querySelector('[data-testid="empty-state"]')?.textContent).toContain(
      '当日无披露事件'
    );
  });

  test('fails closed into the error state when the backend wire is malformed', async () => {
    installFetch({
      ...payload(),
      kpi: {
        ...payload().kpi,
        usdjpy: { rate: '150.25', change_pct: 0.2, as_of: DATE },
      },
    });

    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await settle();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '日韩市场数据暂时不可用'
    );
    expect(container.querySelector('[aria-label="日韩市场关键指标"]')).toBeNull();
  });
});
