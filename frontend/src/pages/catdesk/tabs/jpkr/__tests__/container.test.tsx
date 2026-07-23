import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { API_DOMAIN_URL } from 'services/api';
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
jest.mock('../../../shared/DisclaimerFooter', () => ({ DisclaimerFooter: () => null }));
jest.mock('../JpKrTable', () => ({
  JpKrTable: ({ rows }: { rows: Array<{ symbol: string; sector: string }> }) => (
    <div data-testid="jpkr-table">{rows.map(row => `${row.symbol}:${row.sector}`).join(',')}</div>
  ),
}));

const DATE = '2026-07-21';
const originalFetch = globalThis.fetch;

function marketRow(overrides: Record<string, unknown> = {}) {
  return {
    symbol: '005930',
    name_local: '삼성전자',
    name_en: 'Samsung Electronics',
    market: 'KR',
    sector: 'semiconductor',
    as_of: DATE,
    close: 251000,
    change_pct: 1.25,
    currency: 'KRW',
    disclosure_events: [],
    revenue_by_region: [],
    fx_beta: 0,
    is_halted: false,
    data_sources: ['naver-public'],
    score: null,
    risk_gate: null,
    risk_triggers: [],
    ...overrides,
  };
}

function payload(rows: unknown[] = [marketRow()]) {
  return {
    date: DATE,
    kpi: {
      nikkei225: null,
      topix: null,
      kospi: {
        value: 3250.5,
        change_pct: 0.8,
        as_of: DATE,
        source_kind: 'naver-public',
      },
      usdjpy: null,
      usdkrw: { rate: 1380.5, change_pct: -0.1, as_of: DATE, source_kind: 'BOK' },
    },
    rows,
    sector_performance:
      rows.length === 0
        ? []
        : [
            {
              sector: 'semiconductor',
              sector_label: '半导体',
              change_pct: 1.25,
              representative_count: 1,
              representative_symbols: ['005930'],
              calculation_basis: 'representative_equal_weight',
              as_of: DATE,
            },
          ],
    market_summary: {
      focus: 'technology_representatives',
      leader_sector: rows.length === 0 ? null : 'semiconductor',
      leader_sector_label: rows.length === 0 ? null : '半导体',
      leader_change_pct: rows.length === 0 ? null : 1.25,
      advancing_sectors: rows.length === 0 ? 0 : 1,
      sector_count: rows.length === 0 ? 0 : 1,
    },
  };
}

function response(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('JpKrMarket technology-focused container', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.setItem('token', 'jpkr-access-token');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.removeItem('token');
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('defaults to Korea, uses one authenticated endpoint and renders sectors before stocks', async () => {
    const fetchMock = jest.fn(async () => response(200, payload()));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_DOMAIN_URL}/api/v1/jpkr-market/${DATE}?market=KR`,
      expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) })
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer jpkr-access-token');
    const text = container.textContent ?? '';
    expect(text.indexOf('板块涨幅')).toBeLessThan(text.indexOf('韩国科技代表股'));
    expect(text).toContain('005930:semiconductor');
    expect(text).not.toContain('推荐服务');
  });

  test('keeps loading visible until the market response settles', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    globalThis.fetch = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;

    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await Promise.resolve();
    });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => {
      resolveFetch?.(response(200, payload()));
      await settle();
    });
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.textContent).toContain('005930');
  });

  test('preserves unavailable KPIs and an explicit empty representative state', async () => {
    globalThis.fetch = jest.fn(async () =>
      response(200, { ...payload([]), kpi: {} })
    ) as unknown as typeof fetch;
    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await settle();
    });
    expect(container.querySelectorAll('[data-state="unavailable"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="empty-state"]')?.textContent).toContain(
      '暂无可用代表股行情'
    );
  });

  test('fails closed when the backend wire is malformed', async () => {
    globalThis.fetch = jest.fn(async () =>
      response(200, {
        ...payload(),
        market_summary: { ...payload().market_summary, focus: 'all_stocks' },
      })
    ) as unknown as typeof fetch;
    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await settle();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '日韩科技行情暂时不可用'
    );
  });
});
