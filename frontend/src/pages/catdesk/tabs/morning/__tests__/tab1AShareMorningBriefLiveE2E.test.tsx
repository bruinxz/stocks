import fs from 'node:fs';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { API_DOMAIN_URL } from 'services/api';
import AShareMorningBrief from '../../AShareMorningBrief';
import { recommendationLatestUrl } from '../../recommendationCandidates';

type ExpectedSnapshot = {
  profile: 'us_preferred';
  market_scope: 'cn_a';
  snapshot_id: string;
  ticker: string;
  contract_version: '0.3.1';
  as_of: string;
  score: {
    total: number;
    rating: 'A' | 'B' | 'C' | 'D' | 'F';
    scoring_id: string;
    snapshot_hash: string;
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
    short_text?: string;
  };
  pins: {
    input_fingerprint: string;
    output_fingerprint: string;
    pipeline_version: string;
  };
};

type LiveArtifact = {
  generated_from: 'live-disposable-postgresql';
  base_url: string;
  authorization: string;
  cn_a: ExpectedSnapshot;
};

const artifactPath = process.env.CATDESK_RECOMMENDATION_RESPONSE_ARTIFACT;
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

describeLive('Tab1 AShareMorningBrief live disposable-PG container', () => {
  test('authenticatedFetch crosses localhost HTTP and renders the strict cn_a recommendation', async () => {
    if (!live) throw new Error('CATDESK_RECOMMENDATION_RESPONSE_ARTIFACT is required');
    expect(live.generated_from).toBe('live-disposable-postgresql');
    expect(live.cn_a).toMatchObject({
      profile: 'us_preferred',
      market_scope: 'cn_a',
      contract_version: '0.3.1',
    });
    const server = localhostBaseUrl(live.base_url);
    const bearer = /^Bearer (\S+)$/.exec(live.authorization);
    expect(bearer).not.toBeNull();
    localStorage.setItem('token', bearer?.[1] ?? '');

    const canonicalPath = recommendationLatestUrl('us_preferred', 'cn_a');
    const canonicalOrigin = new URL(API_DOMAIN_URL).origin;
    const networkCalls: Array<{
      path: string;
      authorization: string | null;
      credentials: RequestCredentials | undefined;
      status: number;
    }> = [];
    const fetchTransport = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init = {}) => {
        const requested = new URL(String(input));
        const path = `${requested.pathname}${requested.search}`;
        expect(requested.origin).toBe(canonicalOrigin);
        expect(path).toBe(canonicalPath);
        expect(init.method ?? 'GET').toBe('GET');

        const headers = new Headers(init.headers);
        const authorization = headers.get('Authorization');
        expect(authorization).toBe(live.authorization);
        expect(init.credentials).toBe('include');

        // Preserve the container-generated request and cross a real localhost
        // socket; no response fixture or body is constructed in this test.
        const response = await nativeFetch(new URL(path, server), { ...init, headers });
        networkCalls.push({
          path,
          authorization,
          credentials: init.credentials,
          status: response.status,
        });
        return response;
      });

    const expected = live.cn_a;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <MemoryRouter>
            <AShareMorningBrief />
          </MemoryRouter>
        );
      });

      await eventually(() => {
        expect(container.textContent).toContain(expected.ticker);
        expect(container.textContent).toContain(expected.score.total.toFixed(1));
        expect(container.textContent).toContain(`${expected.conviction.final}%`);
      });
      expect(fetchTransport).toHaveBeenCalledTimes(1);
      expect(networkCalls).toEqual([
        {
          path: canonicalPath,
          authorization: live.authorization,
          credentials: 'include',
          status: 200,
        },
      ]);

      const row = Array.from(container.querySelectorAll('tbody tr')).find(tableRow =>
        tableRow.textContent?.includes(expected.ticker)
      ) as HTMLTableRowElement | undefined;
      expect(row).toBeDefined();
      await act(async () => {
        row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      await eventually(() => {
        const score = document.body.querySelector('[aria-label="评分分解"]');
        const conviction = document.body.querySelector('[aria-label="确信度分解"]');
        const riskGate = document.body.querySelector('[aria-label="风险门禁详情"]');
        const entryPlan = document.body.querySelector('[aria-label="入场方案"]');
        const evidence = document.body.querySelector('[aria-label="推荐证据引用"]');
        const provenance = document.body.querySelector('[aria-label="推荐快照溯源"]');

        expect(score?.textContent).toContain(expected.score.scoring_id);
        expect(score?.textContent).toContain(`综合: ${expected.score.rating}`);
        expect(conviction?.textContent).toContain(`${expected.conviction.final}%`);
        expect(riskGate?.textContent).toContain(`${expected.risk_gate.gate} · 可入场`);
        if (expected.risk_gate.trigger_code) {
          expect(riskGate?.textContent).toContain(expected.risk_gate.trigger_code);
        }
        expect(entryPlan?.textContent).toContain(
          `${expected.entry_plan.entry_low.toFixed(2)}-${expected.entry_plan.entry_high.toFixed(
            2
          )} ${expected.entry_plan.currency}`
        );
        expect(entryPlan?.textContent).toContain(expected.entry_plan.size_tier);
        expect(entryPlan?.textContent).toContain(expected.entry_plan.invalidation);
        expect(evidence?.textContent).toContain(expected.evidence.id);
        expect(evidence?.textContent).toContain(expected.evidence.source_uri);
        if (expected.evidence.short_text) {
          expect(evidence?.textContent).toContain(expected.evidence.short_text);
        }
        expect(provenance?.textContent).toContain(expected.snapshot_id);
        expect(provenance?.textContent).toContain(expected.as_of);
        expect(provenance?.textContent).toContain(expected.pins.input_fingerprint);
        expect(provenance?.textContent).toContain(expected.pins.output_fingerprint);
        expect(provenance?.textContent).toContain(expected.pins.pipeline_version);
      });
    } finally {
      await unmount(root, container);
    }
  }, 60_000);
});
