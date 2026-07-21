import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import { authenticatedFetch } from 'services/api';
import type { JpKrMarket, JpKrMarketResponse, JpKrMarketRow } from './types';
import { parseJpKrDetailResponse, parseJpKrMarketResponse } from './jpkrAdapters';

async function fetchJpKrMarket(
  signal: AbortSignal,
  date: string,
  market: JpKrMarket
): Promise<JpKrMarketResponse> {
  const marketResponse = await authenticatedFetch(
    `/api/v1/jpkr-market/${encodeURIComponent(date)}?market=${encodeURIComponent(market)}`,
    { signal }
  );
  if (!marketResponse.ok) throw new Error(`jpkr-market ${marketResponse.status}`);
  const payload: unknown = await marketResponse.json();
  return parseJpKrMarketResponse(payload, date, market);
}

async function fetchJpKrDetail(
  signal: AbortSignal,
  symbol: string,
  date: string
): Promise<JpKrMarketRow> {
  const res = await authenticatedFetch(
    `/api/v1/jpkr-market/${encodeURIComponent(symbol)}/detail?date=${encodeURIComponent(date)}`,
    { signal }
  );
  if (!res.ok) throw new Error(`jpkr-detail ${res.status}`);
  const payload: unknown = await res.json();
  return parseJpKrDetailResponse(payload, symbol);
}

export function useJpKrMarketData(date: string, market: JpKrMarket) {
  return useAbortableRequest(signal => fetchJpKrMarket(signal, date, market), [date, market]);
}

export function useJpKrDetail(symbol: string | null, date: string) {
  return useAbortableRequest(
    signal => {
      if (!symbol) return Promise.resolve(null);
      return fetchJpKrDetail(signal, symbol, date);
    },
    [symbol, date]
  );
}
