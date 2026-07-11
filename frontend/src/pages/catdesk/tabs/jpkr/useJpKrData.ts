import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import type { JpKrMarket, JpKrMarketResponse, JpKrMarketRow } from './types';

async function fetchJpKrMarket(
  signal: AbortSignal,
  date: string,
  market: JpKrMarket,
): Promise<JpKrMarketResponse> {
  const res = await fetch(
    `/api/v1/jpkr-market/${encodeURIComponent(date)}?market=${market}`,
    { signal },
  );
  if (!res.ok) throw new Error(`jpkr-market ${res.status}`);
  return res.json();
}

async function fetchJpKrDetail(
  signal: AbortSignal,
  symbol: string,
  date: string,
): Promise<JpKrMarketRow> {
  const res = await fetch(
    `/api/v1/jpkr-market/${encodeURIComponent(symbol)}/detail?date=${encodeURIComponent(date)}`,
    { signal },
  );
  if (!res.ok) throw new Error(`jpkr-detail ${res.status}`);
  return res.json();
}

export function useJpKrMarketData(date: string, market: JpKrMarket) {
  return useAbortableRequest(
    (signal) => fetchJpKrMarket(signal, date, market),
    [date, market],
  );
}

export function useJpKrDetail(symbol: string | null, date: string) {
  return useAbortableRequest(
    (signal) => {
      if (!symbol) return Promise.resolve(null);
      return fetchJpKrDetail(signal, symbol, date);
    },
    [symbol, date],
  );
}
