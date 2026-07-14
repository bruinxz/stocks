import fs from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import HighMultipotential from '../HighMultipotential';
import { parseMultibaggerDetail, parseMultibaggerResponse } from '../multibaggerAdapters';

type Artifact = {
  generated_from: string;
  list: unknown;
  detail: unknown;
};

const artifactPath = process.env.TAB4_RESPONSE_ARTIFACT;
const live = artifactPath
  ? (JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact)
  : null;
const describeLive = live ? describe : describe.skip;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describeLive('Tab4 live disposable-PG E2E', () => {
  test('live list/detail pass the strict adapter and render through the real hooks/container', async () => {
    if (!live) throw new Error('TAB4_RESPONSE_ARTIFACT is required');
    expect(live.generated_from).toBe('live-disposable-postgresql');
    const parsedList = parseMultibaggerResponse(live.list);
    const parsedDetail = parseMultibaggerDetail(live.detail);
    expect(parsedList.rows).toEqual([parsedDetail]);

    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      const body = url.includes('/detail') ? live.detail : live.list;
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as Response;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <HighMultipotential />
        </MemoryRouter>
      );
      await flush();
    });
    expect(container.textContent).toContain(parsedDetail.symbol);
    expect(container.textContent).toContain('5X');

    const row = container.querySelector(`[data-row-key="${parsedDetail.symbol}"]`) as HTMLElement;
    expect(row).not.toBeNull();
    await act(async () => {
      row.click();
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/multibagger/${encodeURIComponent(parsedDetail.symbol)}/detail`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(document.body.textContent).toContain(parsedDetail.classification_policy_version);
    expect(document.body.textContent).toContain(parsedDetail.fact_hash);
    expect(document.body.textContent).toContain(parsedDetail.source_fact_hashes[0]);

    await act(async () => root.unmount());
    container.remove();
  });
});
