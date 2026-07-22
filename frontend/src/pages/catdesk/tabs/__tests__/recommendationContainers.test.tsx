import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { API_DOMAIN_URL } from 'services/api';
import AShareMorningBrief from '../AShareMorningBrief';
import { recommendationLatestUrl } from '../recommendationCandidates';
import { snapshotFixture } from '../daily-report/testFixtures';

jest.mock('../../shared/LoadingState', () => ({
  LoadingState: () => <div aria-busy="true">loading</div>,
}));
jest.mock('../../shared/EmptyState', () => ({
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty-state">{title}</div>,
}));
jest.mock('../../shared/ErrorState', () => ({
  ErrorState: ({ message }: { message: string }) => <div data-testid="error-state">{message}</div>,
}));
jest.mock('../../shared/UnavailableState', () => ({
  UnavailableState: ({ message }: { message: string }) => (
    <div data-testid="unavailable-state">{message}</div>
  ),
}));
jest.mock('../../shared/DisclaimerFooter', () => ({ DisclaimerFooter: () => null }));
jest.mock('shared/components/DetailSidebar', () => ({ DetailSidebar: () => null }));
jest.mock('../morning/MorningFilterBar', () => ({ MorningFilterBar: () => null }));
jest.mock('../morning/MorningKpiSlots', () => ({ MorningKpiSlots: () => null }));
jest.mock('../morning/MorningBriefTable', () => ({
  MorningBriefTable: ({ data }: { data: Array<{ symbol: string }> }) => (
    <div data-testid="candidate-table">{data.map(item => item.symbol).join(',')}</div>
  ),
}));
jest.mock('../../shared/useResearchTradingLoop', () => ({
  useResearchTradingLoop: () => ({ data: null }),
}));
jest.mock('../../shared/useStockNameHydration', () => ({
  useStockNameHydration: (rows: unknown[]) => rows,
  useStockNameHydrationState: (rows: unknown[]) => ({ rows, loading: false }),
}));

const originalFetch = globalThis.fetch;

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function snapshotFor(marketScope: 'cn_a') {
  const base = snapshotFixture();
  const recommendation = base.items[0].recommendation;
  return snapshotFixture({
    market_scope: marketScope,
    items: [
      {
        recommendation: {
          ...recommendation,
          score: { ...recommendation.score, market_scope: marketScope },
        },
        rating_band: recommendation.score.rating,
      },
    ],
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

const containers = [
  {
    name: 'Tab1 AShareMorningBrief',
    Component: AShareMorningBrief,
    marketScope: 'cn_a' as const,
    url: recommendationLatestUrl('us_preferred', 'cn_a'),
  },
];

describe.each(containers)('$name real container recommendation states', testCase => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.setItem('token', 'tab12-access-token');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.removeItem('token');
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  async function renderWith(fetchImplementation: typeof fetch) {
    const fetchMock = jest.fn(fetchImplementation);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await act(async () => {
      root.render(<testCase.Component />);
      await settle();
    });
    return fetchMock;
  }

  test('ready renders only candidates from a strict v0.3.1 snapshot', async () => {
    const fetchMock = await renderWith(async () =>
      response(200, snapshotFor(testCase.marketScope))
    );

    expect(container.querySelector('[data-testid="candidate-table"]')?.textContent).toContain(
      'AAPL'
    );
    expect(container.querySelector('[data-testid="empty-state"]')).toBeNull();
    expect(container.querySelector('[data-testid="unavailable-state"]')).toBeNull();
    expect(container.querySelector('[data-testid="error-state"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_DOMAIN_URL}${testCase.url}`,
      expect.objectContaining({ signal: expect.any(AbortSignal), credentials: 'include' })
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tab12-access-token');
  });

  test('404 renders an explicit not-generated Empty state', async () => {
    await renderWith(async () => response(404));

    expect(container.querySelector('[data-testid="empty-state"]')?.textContent).toContain(
      '尚未生成'
    );
    expect(container.querySelector('[data-testid="candidate-table"]')).toBeNull();
    expect(container.querySelector('[data-testid="unavailable-state"]')).toBeNull();
    expect(container.querySelector('[data-testid="error-state"]')).toBeNull();
  });

  test('503 renders an explicit Unavailable state', async () => {
    await renderWith(async () => response(503));

    expect(container.querySelector('[data-testid="unavailable-state"]')?.textContent).toContain(
      '推荐服务当前不可用'
    );
    expect(container.querySelector('[data-testid="candidate-table"]')).toBeNull();
    expect(container.querySelector('[data-testid="empty-state"]')).toBeNull();
    expect(container.querySelector('[data-testid="error-state"]')).toBeNull();
  });

  test('malformed 200 payload fails closed into Error', async () => {
    await renderWith(async () => response(200, { meta: { contract_version: '0.3.0' } }));

    expect(container.querySelector('[data-testid="error-state"]')?.textContent).toBe(
      '数据加载失败'
    );
    expect(container.querySelector('[data-testid="candidate-table"]')).toBeNull();
    expect(container.querySelector('[data-testid="empty-state"]')).toBeNull();
    expect(container.querySelector('[data-testid="unavailable-state"]')).toBeNull();
  });

  test('network failure also fails closed into Error', async () => {
    await renderWith(async () => {
      throw new TypeError('network offline');
    });

    expect(container.querySelector('[data-testid="error-state"]')?.textContent).toBe(
      '数据加载失败'
    );
    expect(container.querySelector('[data-testid="candidate-table"]')).toBeNull();
  });
});
