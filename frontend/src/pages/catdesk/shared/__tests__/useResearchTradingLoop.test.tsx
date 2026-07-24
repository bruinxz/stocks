import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockGetDashboard = jest.fn<Promise<any>, [AbortSignal]>();

jest.mock('services/researchTradingLoopService', () => ({
  getResearchTradingLoopDashboard: (signal: AbortSignal) => mockGetDashboard(signal),
}));

import { RESEARCH_LOOP_AUTO_REFRESH_MS, useResearchTradingLoop } from '../useResearchTradingLoop';

function Probe() {
  const { data, loading } = useResearchTradingLoop();
  return <span>{loading ? 'loading' : String((data as any)?.sequence || 'empty')}</span>;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useResearchTradingLoop', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    jest.useFakeTimers();
    mockGetDashboard.mockReset();
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

  test('refreshes the visible research loop without a manual page reload', async () => {
    mockGetDashboard.mockResolvedValueOnce({ sequence: 1 }).mockResolvedValueOnce({ sequence: 2 });

    await act(async () => {
      root.render(<Probe />);
      await flush();
    });
    expect(mockGetDashboard).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('1');

    await act(async () => {
      jest.advanceTimersByTime(RESEARCH_LOOP_AUTO_REFRESH_MS);
      await flush();
    });
    expect(mockGetDashboard).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('2');
  });
});
