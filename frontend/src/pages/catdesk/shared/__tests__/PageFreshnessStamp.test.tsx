import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockAuthenticatedFetch = jest.fn<Promise<any>, [RequestInfo | URL, RequestInit?]>();

jest.mock('services/api', () => ({
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) =>
    mockAuthenticatedFetch(input, init),
}));

import { PageFreshnessStamp } from '../PageFreshnessStamp';
import { RESEARCH_LOOP_AUTO_REFRESH_MS } from '../useResearchTradingLoop';

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PageFreshnessStamp', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    jest.useFakeTimers();
    mockAuthenticatedFetch.mockReset();
    mockAuthenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          pages: {
            morning: {
              page: 'morning',
              label: 'A股早报',
              latest_data_at: '2026-07-24T01:00:00Z',
              latest_data_date: '2026-07-23',
              reference_trade_date: '2026-07-23',
              lag_days: 0,
              status: 'fresh',
              source: 'recommendation_snapshot',
            },
          },
        },
      }),
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  test('keeps the data watermark on the same one-minute refresh cadence', async () => {
    await act(async () => {
      root.render(<PageFreshnessStamp activeTab="morning" />);
      await flush();
    });
    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('A股早报截至 2026-07-23');

    await act(async () => {
      jest.advanceTimersByTime(RESEARCH_LOOP_AUTO_REFRESH_MS);
      await flush();
    });
    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(2);
  });
});
