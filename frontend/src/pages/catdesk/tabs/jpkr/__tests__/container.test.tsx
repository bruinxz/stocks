import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { API_DOMAIN_URL } from 'services/api';
import { snapshotFixture } from '../../daily-report/testFixtures';
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
  JpKrTable: ({
    rows,
    error,
  }: {
    rows: Array<{
      symbol: string;
      recommendation?: {
        score: { total: number };
        risk_gate: { gate: string };
        entry_plan: { entry: { low: number; high: number } };
      };
    }>;
    error: Error | null;
  }) =>
    error ? (
      <div role="alert">table error</div>
    ) : (
      <div>
        {rows
          .map(row =>
            row.recommendation
              ? `${row.symbol}:${row.recommendation.score.total}:${row.recommendation.risk_gate.gate}:${row.recommendation.entry_plan.entry.low}-${row.recommendation.entry_plan.entry.high}`
              : row.symbol
          )
          .join(',')}
      </div>
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

function jpRecommendationSnapshot() {
  const base = snapshotFixture();
  const recommendation = base.items[0].recommendation;
  return snapshotFixture({
    profile: 'japan_blue_chip',
    market_scope: 'jp',
    disclaimer: {
      ...base.disclaimer,
      short_text: '参考情報です',
      full_text: '投資判断はご自身の責任で行ってください。',
      language: 'ja-JP',
    },
    items: [
      {
        recommendation: {
          ...recommendation,
          ticker: '7203',
          score: {
            ...recommendation.score,
            profile: 'japan_blue_chip',
            market_scope: 'jp',
          },
          conviction: { ...recommendation.conviction, ticker: '7203' },
          risk_gate: { ...recommendation.risk_gate, ticker: '7203' },
          entry_plan: {
            ...recommendation.entry_plan,
            ticker: '7203',
            entry: { low: 3000, high: 3150, currency: 'JPY' },
            stop: { value: 2850, currency: 'JPY' },
            targets: [{ value: 3500, currency: 'JPY' }],
          },
          explanation: { ...recommendation.explanation, language: 'ja-JP' },
          evidence_refs: [
            {
              ...recommendation.evidence_refs[0],
              source_uri: 'jpx-edinet://E00001/2026-07-10/annual-report',
            },
          ],
        },
        rating_band: 'A',
      },
    ],
  });
}

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function installFetch(
  marketBody: unknown,
  recommendation: { status: number; body?: unknown } = { status: 404 }
) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input).includes('/api/v1/ai/recommendations/latest?')
      ? response(recommendation.status, recommendation.body)
      : response(200, marketBody)
  );
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
    localStorage.setItem('token', 'jpkr-access-token');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.removeItem('token');
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('loads both authenticated endpoints and keeps a missing snapshot explicit', async () => {
    const fetchMock = installFetch(payload());

    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_DOMAIN_URL}/api/v1/jpkr-market/${DATE}?market=JP`,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        credentials: 'include',
        headers: expect.any(Headers),
      })
    );
    const [, requestInit] = fetchMock.mock.calls[0];
    expect(new Headers(requestInit?.headers).get('Authorization')).toBe('Bearer jpkr-access-token');
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_DOMAIN_URL}/api/v1/ai/recommendations/latest?profile=japan_blue_chip&market_scope=jp`,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        credentials: 'include',
        headers: expect.any(Headers),
      })
    );
    expect(container.textContent).toContain('41,000.50');
    expect(container.textContent).toContain('150.25');
    expect(container.textContent).toContain('日本央行');
    expect(container.querySelectorAll('[data-state="available"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-state="unavailable"]')).toHaveLength(2);
    expect(container.textContent?.match(/暂无数据/g)).toHaveLength(2);
    expect(container.textContent).toContain('7203');
    expect(container.textContent).toContain('尚未生成该市场');
  });

  test('merges a strict v0.3.1 snapshot into score, risk and entry-plan UI data', async () => {
    installFetch(payload(), { status: 200, body: jpRecommendationSnapshot() });

    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await settle();
    });

    expect(container.textContent).toContain('7203:87.75:GREEN:3000-3150');
    expect(container.textContent).not.toContain('尚未生成该市场');
    expect(container.textContent).not.toContain('推荐服务当前不可用');
  });

  test('keeps market data visible when recommendation storage is unavailable', async () => {
    installFetch(payload(), { status: 503 });

    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await settle();
    });

    expect(container.textContent).toContain('41,000.50');
    expect(container.textContent).toContain('7203');
    expect(container.textContent).toContain('推荐服务当前不可用');
  });

  test('keeps the loading state visible until the HTTP response settles', async () => {
    let resolveFetch: ((response: unknown) => void) | undefined;
    globalThis.fetch = jest.fn((input: RequestInfo | URL) =>
      String(input).includes('/api/v1/ai/recommendations/latest?')
        ? Promise.resolve(response(404))
        : new Promise(resolve => {
            resolveFetch = resolve;
          })
    ) as unknown as typeof fetch;

    await act(async () => {
      root.render(<JpKrMarket tradingDay={DATE} />);
      await Promise.resolve();
    });
    expect(container.querySelector('[aria-busy="true"]')?.textContent).toBe('loading');

    await act(async () => {
      resolveFetch?.(response(200, payload()));
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
    expect(container.textContent?.match(/暂无数据/g)).toHaveLength(5);
    expect(container.textContent).not.toContain('0.00');
    expect(container.querySelector('[data-testid="empty-state"]')?.textContent).toContain(
      '当日暂无可用行情'
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
