import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { API_DOMAIN_URL } from 'services/api';
import USStockPicks from '../../USStockPicks';
import { parseUsTechMarketResponse } from '../techMarket';

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

const DATE = '2026-07-21';
const originalFetch = globalThis.fetch;

function instrument(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'SMH',
    name: 'VanEck Semiconductor ETF',
    instrument_type: 'etf',
    sector: 'semiconductor',
    sector_label: '半导体',
    exchange: 'PCX',
    close: 402.5,
    change_pct: 2.4,
    change_5d_pct: 5.1,
    volume: 8_000_000,
    notional_volume: 3_220_000_000,
    currency: 'USD',
    as_of: DATE,
    data_source: 'yahoo-chart-public',
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    market: 'US',
    date: DATE,
    as_of: DATE,
    market_summary: {
      leader_sector: 'semiconductor',
      leader_sector_label: '半导体',
      leader_change_pct: 2.4,
      advancing_sectors: 2,
      sector_count: 3,
      tech_breadth_pct: 66.7,
    },
    sector_performance: [{ ...instrument(), proxy_symbol: 'SMH', calculation_basis: 'proxy_etf' }],
    representative_tech_stocks: [
      instrument({
        symbol: 'NVDA',
        name: 'NVIDIA',
        instrument_type: 'stock',
        close: 205.31,
        change_pct: 1.8,
        notional_volume: 12_000_000_000,
      }),
    ],
    focus_etfs: [
      {
        ...instrument({ symbol: 'QQQ', name: 'Invesco QQQ Trust', sector: 'nasdaq_100' }),
        attention_rank: 1,
        attention_basis: 'latest_dollar_volume',
      },
    ],
    ...overrides,
  };
}

function response(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('US technology market contract', () => {
  test('parses sector-first market data and preserves attention basis', () => {
    const parsed = parseUsTechMarketResponse(payload(), DATE);
    expect(parsed.sector_performance[0]).toMatchObject({
      proxy_symbol: 'SMH',
      calculation_basis: 'proxy_etf',
      change_pct: 2.4,
    });
    expect(parsed.representative_tech_stocks[0].symbol).toBe('NVDA');
    expect(parsed.focus_etfs[0]).toMatchObject({
      symbol: 'QQQ',
      attention_rank: 1,
      attention_basis: 'latest_dollar_volume',
    });
  });

  test('rejects recommendation-shaped or mislabeled market data', () => {
    expect(() => parseUsTechMarketResponse({ candidates: [] }, DATE)).toThrow(/market must be US/);
    expect(() =>
      parseUsTechMarketResponse(
        payload({
          focus_etfs: [
            {
              ...instrument(),
              attention_rank: 1,
              attention_basis: 'social_sentiment',
            },
          ],
        }),
        DATE
      )
    ).toThrow(/attention_basis is invalid/);
  });
});

describe('USStockPicks sector-first container', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.setItem('token', 'us-tech-access-token');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.removeItem('token');
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('loads authenticated market data and renders sectors before stocks and ETFs', async () => {
    const fetchMock = jest.fn(async () => response(200, payload()));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      root.render(<USStockPicks tradingDay={DATE} />);
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_DOMAIN_URL}/api/v1/us-tech-market/${DATE}`,
      expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) })
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer us-tech-access-token');
    const text = container.textContent ?? '';
    expect(text.indexOf('科技板块涨幅')).toBeLessThan(text.indexOf('突出科技股'));
    expect(text.indexOf('突出科技股')).toBeLessThan(text.indexOf('高关注科技 ETF'));
    expect(text).toContain('NVDA');
    expect(text).toContain('QQQ');
  });

  test('fails closed when the wire is malformed', async () => {
    globalThis.fetch = jest.fn(async () =>
      response(200, { candidates: [] })
    ) as unknown as typeof fetch;
    await act(async () => {
      root.render(<USStockPicks tradingDay={DATE} />);
      await settle();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('暂时不可用');
  });
});
