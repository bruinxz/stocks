import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import type {
  MultibaggerStage,
  MultibaggerConclusion,
  MultibaggerMarket,
  MultibaggerResponse,
  MultibaggerRow,
} from './types';
import { parseMultibaggerDetail, parseMultibaggerResponse } from './multibaggerAdapters';

async function fetchCandidates(
  signal: AbortSignal,
  stages: MultibaggerStage[],
  conclusions: MultibaggerConclusion[],
  market: MultibaggerMarket | null
): Promise<MultibaggerResponse> {
  const params = new URLSearchParams();
  if (stages.length > 0) params.set('stage', stages.join(','));
  if (conclusions.length > 0) params.set('conclusion', conclusions.join(','));
  if (market) params.set('market', market);

  const res = await fetch(`/api/v1/multibagger/candidates?${params}`, { signal });
  if (!res.ok) throw new Error(`multibagger ${res.status}`);
  return parseMultibaggerResponse(await res.json());
}

async function fetchDetail(signal: AbortSignal, symbol: string): Promise<MultibaggerRow> {
  const res = await fetch(`/api/v1/multibagger/${encodeURIComponent(symbol)}/detail`, { signal });
  if (!res.ok) throw new Error(`multibagger-detail ${res.status}`);
  return parseMultibaggerDetail(await res.json());
}

export function useMultibaggerData(
  stages: MultibaggerStage[],
  conclusions: MultibaggerConclusion[],
  market: MultibaggerMarket | null
) {
  return useAbortableRequest(
    signal => fetchCandidates(signal, stages, conclusions, market),
    [stages.join(','), conclusions.join(','), market]
  );
}

export function useMultibaggerDetail(symbol: string | null) {
  return useAbortableRequest(
    signal => {
      if (!symbol) return Promise.resolve(null);
      return fetchDetail(signal, symbol);
    },
    [symbol]
  );
}
