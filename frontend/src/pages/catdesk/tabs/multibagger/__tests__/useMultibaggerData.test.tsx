import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockAuthenticatedFetch = jest.fn<Promise<any>, [RequestInfo | URL, RequestInit?]>();

jest.mock('services/api', () => ({
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) =>
    mockAuthenticatedFetch(input, init),
}));

jest.mock('../multibaggerAdapters', () => ({
  parseMultibaggerResponse: () => ({ rows: [], kpi: {} }),
  parseMultibaggerDetail: () => null,
}));

import { RESEARCH_LOOP_AUTO_REFRESH_MS } from '../../../shared/useResearchTradingLoop';
import { useMultibaggerData } from '../useMultibaggerData';

function Probe() {
  const { loading } = useMultibaggerData([], ['MULTIBAGGER_2X'], null);
  return <span>{loading ? 'loading' : 'ready'}</span>;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useMultibaggerData', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    jest.useFakeTimers();
    mockAuthenticatedFetch.mockReset();
    mockAuthenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
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

  test('refreshes visible candidate data every minute', async () => {
    await act(async () => {
      root.render(<Probe />);
      await flush();
    });
    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(RESEARCH_LOOP_AUTO_REFRESH_MS);
      await flush();
    });
    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(2);
  });
});
