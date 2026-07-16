import fs from 'node:fs';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { API_DOMAIN_URL } from 'services/api';
import JpKrMarket from '../JpKrMarket';

type LiveArtifact = {
  generated_from: 'controlled-official-jp-fixture-disposable-postgresql';
  fixture_disclaimer: string;
  base_url: string;
  authorization: string;
  trading_day: string;
  expected: {
    symbol: string;
    name_local: string;
    name_en: string;
    close: number;
    currency: 'JPY';
    data_sources: string[];
    disclosure: {
      title: string;
      doc_type: string;
      filed_at: string;
      source: 'jpx-edinet';
      doc_url?: string;
    };
    financial: {
      revenue_region: string;
      revenue_pct: number;
      fx_beta: number;
    };
    fx: {
      pair: 'USDJPY';
      rate: number;
      as_of: string;
    };
    recommendation: {
      snapshot_id: string;
      profile: 'japan_blue_chip';
      market_scope: 'jp';
      contract_version: '0.3.1';
      as_of: string;
      score: {
        total: number;
        rating: 'A' | 'B' | 'C' | 'D' | 'F';
        scoring_id: string;
      };
      conviction: {
        final: number;
        level: 'HIGH' | 'MED' | 'LOW';
      };
      risk_gate: {
        gate: 'GREEN' | 'YELLOW' | 'RED';
        trigger_code?: string;
      };
      entry_plan: {
        entry_low: number;
        entry_high: number;
        currency: string;
        size_tier: string;
        invalidation: string;
      };
      evidence: {
        id: string;
        source_uri: string;
        hash: string;
        short_text?: string;
      };
      pins: {
        input_fingerprint: string;
        output_fingerprint: string;
        pipeline_version: string;
      };
    };
  };
  physical: {
    securities: number;
    klines: number;
    financials: number;
    disclosures: number;
    fx: number;
    captures: number;
    snapshots: number;
    items: number;
    fact_hashes: {
      security: string;
      kline: string;
      financial: string;
      disclosure: string;
      fx: string;
      capture: string;
      score: string;
    };
    pit_checked: boolean;
    capture_pins_match: boolean;
  };
  negative: {
    unauthorized_market: number;
    unauthorized_recommendation: number;
    unauthorized_db_reads: number;
    missing_detail: number;
    recommendation_not_found: number;
    recommendation_unavailable: number;
  };
};

type NetworkCall = {
  path: string;
  authorization: string | null;
  credentials: RequestCredentials | undefined;
  status: number;
};

const artifactPath = process.env.TAB3_JPKR_RESPONSE_ARTIFACT;
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
  if (live) {
    if (typeof globalThis.fetch !== 'function') {
      throw new Error('Node fetch is required for the live localhost transport');
    }
    nativeFetch = globalThis.fetch.bind(globalThis);
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.removeItem('token');
});

async function eventually(assertion: () => void, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
      });
    }
  }
  throw lastError;
}

async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}

function localhostBaseUrl(value: string): URL {
  const url = new URL(value);
  expect(url.protocol).toBe('http:');
  expect(['127.0.0.1', 'localhost', '[::1]', '::1']).toContain(url.hostname);
  expect(url.username).toBe('');
  expect(url.password).toBe('');
  expect(url.pathname).toBe('/');
  return url;
}

function formatKpi(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 10 ? 4 : 2,
  }).format(value);
}

describeLive('Tab3 JpKrMarket live disposable-PG container', () => {
  test('real authenticated hooks render the controlled JP fixture and recommendation over localhost', async () => {
    if (!live) throw new Error('TAB3_JPKR_RESPONSE_ARTIFACT is required');

    expect(live.generated_from).toBe('controlled-official-jp-fixture-disposable-postgresql');
    expect(live.fixture_disclaimer).toMatch(/controlled official-source fixture/i);
    expect(live.fixture_disclaimer).toMatch(/not production real-time data/i);
    expect(live.expected.recommendation).toMatchObject({
      profile: 'japan_blue_chip',
      market_scope: 'jp',
      contract_version: '0.3.1',
      risk_gate: { gate: 'GREEN' },
    });
    expect(live.physical).toMatchObject({
      securities: 3,
      klines: 1,
      financials: 1,
      disclosures: 1,
      fx: 3,
      captures: 1,
      snapshots: 1,
      items: 1,
      pit_checked: true,
      capture_pins_match: true,
    });
    Object.values(live.physical.fact_hashes).forEach(hash => {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
    expect(live.expected.recommendation.evidence.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(live.expected.recommendation.evidence.hash).toBe(live.physical.fact_hashes.score);
    expect(live.expected.recommendation.pins.input_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(live.expected.recommendation.pins.output_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(live.expected.recommendation.pins.pipeline_version).not.toBe('');
    expect(live.negative).toEqual({
      unauthorized_market: 401,
      unauthorized_recommendation: 401,
      unauthorized_db_reads: 0,
      missing_detail: 404,
      recommendation_not_found: 404,
      recommendation_unavailable: 503,
    });

    const server = localhostBaseUrl(live.base_url);
    const bearer = /^Bearer (\S+)$/.exec(live.authorization);
    expect(bearer).not.toBeNull();
    localStorage.setItem('token', bearer?.[1] ?? '');

    const marketPath = `/api/v1/jpkr-market/${encodeURIComponent(live.trading_day)}?market=JP`;
    const recommendationPath =
      '/api/v1/ai/recommendations/latest?profile=japan_blue_chip&market_scope=jp';
    const detailPath = `/api/v1/jpkr-market/${encodeURIComponent(
      live.expected.symbol
    )}/detail?date=${encodeURIComponent(live.trading_day)}`;
    const allowedPaths = new Set([marketPath, recommendationPath, detailPath]);
    const canonicalOrigin = new URL(API_DOMAIN_URL).origin;
    const networkCalls: NetworkCall[] = [];
    const fetchTransport = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init = {}) => {
        const requested = new URL(String(input));
        const path = `${requested.pathname}${requested.search}`;
        expect(requested.origin).toBe(canonicalOrigin);
        expect(allowedPaths.has(path)).toBe(true);
        expect(init.method ?? 'GET').toBe('GET');

        const headers = new Headers(init.headers);
        const authorization = headers.get('Authorization');
        expect(authorization).toBe(live.authorization);
        expect(init.credentials).toBe('include');

        // Transport-only shim: the real container owns the canonical request,
        // while this test only redirects it to the dynamic localhost listener.
        // Every response body is produced by the authenticated backend/PG path.
        const response = await nativeFetch(new URL(path, server), { ...init, headers });
        networkCalls.push({
          path,
          authorization,
          credentials: init.credentials,
          status: response.status,
        });
        return response;
      });

    const expected = live.expected;
    const recommendation = expected.recommendation;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <MemoryRouter>
            <JpKrMarket tradingDay={live.trading_day} />
          </MemoryRouter>
        );
      });

      await eventually(() => {
        expect(container.textContent).toContain(expected.symbol);
        expect(container.textContent).toContain(expected.name_local);
        expect(container.textContent).toContain(expected.close.toLocaleString());
        expect(container.textContent).toContain(expected.currency);
        expect(container.textContent).toContain(expected.disclosure.title);
        expect(container.textContent).toContain(
          `${expected.financial.revenue_region} ${expected.financial.revenue_pct.toFixed(1)}%`
        );
        expect(container.textContent).toContain(
          `${expected.financial.fx_beta > 0 ? '+' : ''}${expected.financial.fx_beta.toFixed(2)}`
        );
        expect(container.textContent).toContain(recommendation.score.total.toFixed(1));
        expect(container.textContent).toContain(recommendation.score.rating);
      });

      const kpiStrip = container.querySelector('[aria-label="日韩市场关键指标"]');
      expect(kpiStrip).not.toBeNull();
      expect(kpiStrip?.textContent).toContain('USD/JPY');
      expect(kpiStrip?.textContent).toContain('BOJ');
      expect(kpiStrip?.textContent).toContain(formatKpi(expected.fx.rate));
      expect(kpiStrip?.textContent).toContain(expected.fx.as_of);
      expect(container.querySelector('[aria-label="USD/KRW unavailable"]')).not.toBeNull();

      await eventually(() => {
        expect(fetchTransport).toHaveBeenCalledTimes(2);
        expect(networkCalls).toHaveLength(2);
      });
      expect(networkCalls.map(call => call.path).sort()).toEqual(
        [marketPath, recommendationPath].sort()
      );
      networkCalls.forEach(call => {
        expect(call).toMatchObject({
          authorization: live.authorization,
          credentials: 'include',
          status: 200,
        });
      });

      const row = Array.from(container.querySelectorAll('tbody tr')).find(tableRow =>
        tableRow.textContent?.includes(expected.symbol)
      ) as HTMLTableRowElement | undefined;
      expect(row).toBeDefined();
      await act(async () => {
        row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      await eventually(() => {
        expect(fetchTransport).toHaveBeenCalledTimes(3);
        expect(networkCalls.some(call => call.path === detailPath && call.status === 200)).toBe(
          true
        );
      });
      await eventually(() => {
        const sidebar = document.body.querySelector(`[aria-label="${expected.symbol} 详情侧栏"]`);
        const fx = document.body.querySelector(`[aria-label="${expected.symbol} 汇率 beta 详情"]`);
        const disclosure = document.body.querySelector(
          `[aria-label="${expected.symbol} 披露事件列表"]`
        );
        const score = document.body.querySelector('[aria-label="评分分解"]');
        const conviction = document.body.querySelector('[aria-label="确信度分解"]');
        const riskGate = document.body.querySelector('[aria-label="风险门禁详情"]');
        const entryPlan = document.body.querySelector('[aria-label="入场方案"]');
        const evidence = document.body.querySelector('[aria-label="推荐证据引用"]');
        const provenance = document.body.querySelector('[aria-label="推荐快照溯源"]');

        expect(sidebar?.textContent).toContain(expected.symbol);
        expect(sidebar?.textContent).toContain(expected.name_local);
        expect(fx?.textContent).toContain(
          `${expected.financial.fx_beta > 0 ? '+' : ''}${expected.financial.fx_beta.toFixed(3)}`
        );
        expect(fx?.textContent).toContain(expected.financial.revenue_region);
        expect(fx?.textContent).toContain(`${expected.financial.revenue_pct.toFixed(1)}%`);
        expect(disclosure?.textContent).toContain(expected.disclosure.title);
        expect(disclosure?.textContent).toContain(expected.disclosure.doc_type);
        expect(disclosure?.textContent).toContain('EDINET');

        expect(score?.textContent).toContain(recommendation.score.scoring_id);
        expect(score?.textContent).toContain(`综合: ${recommendation.score.rating}`);
        expect(conviction?.textContent).toContain(`${recommendation.conviction.final}%`);
        expect(riskGate?.textContent).toContain('风控门控详情');
        expect(riskGate?.textContent).toContain(`${recommendation.risk_gate.gate} · 可入场`);
        if (recommendation.risk_gate.trigger_code) {
          expect(riskGate?.textContent).toContain(recommendation.risk_gate.trigger_code);
        } else {
          expect(riskGate?.textContent).toContain('无风险触发项');
        }
        expect(entryPlan?.textContent).toContain(
          `${recommendation.entry_plan.entry_low.toFixed(
            2
          )}-${recommendation.entry_plan.entry_high.toFixed(2)} ${
            recommendation.entry_plan.currency
          }`
        );
        expect(entryPlan?.textContent).toContain(recommendation.entry_plan.size_tier);
        expect(entryPlan?.textContent).toContain(recommendation.entry_plan.invalidation);
        expect(evidence?.textContent).toContain(recommendation.evidence.id);
        expect(evidence?.textContent).toContain(recommendation.evidence.source_uri);
        if (recommendation.evidence.short_text) {
          expect(evidence?.textContent).toContain(recommendation.evidence.short_text);
        }
        expect(provenance?.textContent).toContain(recommendation.snapshot_id);
        expect(provenance?.textContent).toContain(recommendation.as_of);
        expect(provenance?.textContent).toContain(recommendation.pins.input_fingerprint);
        expect(provenance?.textContent).toContain(recommendation.pins.output_fingerprint);
        expect(provenance?.textContent).toContain(recommendation.pins.pipeline_version);
      });
    } finally {
      await unmount(root, container);
    }
  }, 60_000);
});
