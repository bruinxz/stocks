import type { CatalystKind } from "./types";

export interface RelevanceComponents {
  sector_map: number;
  revenue_exposure: number;
  adr_parity: number;
  supply_chain: number;
  historical_beta: number;
}

const COMPONENT_WEIGHTS = {
  sector_map: 0.35,
  revenue_exposure: 0.25,
  adr_parity: 0.2,
  supply_chain: 0.15,
  historical_beta: 0.05,
} as const;

const KIND_MULTIPLIER: Record<CatalystKind, number> = {
  earnings: 1.0,
  upgrade_downgrade: 1.0,
  product: 1.0,
  regulator: 1.2,
  geo_macro: 1.2,
  ma_activity: 1.2,
  sector_move: 0.9,
  leadership: 0.9,
  unclassified: 1.0,
};

export function computeRelevanceScore(
  components: RelevanceComponents,
  catalystKind: CatalystKind,
): number {
  const weighted =
    components.sector_map * COMPONENT_WEIGHTS.sector_map +
    components.revenue_exposure * COMPONENT_WEIGHTS.revenue_exposure +
    components.adr_parity * COMPONENT_WEIGHTS.adr_parity +
    components.supply_chain * COMPONENT_WEIGHTS.supply_chain +
    components.historical_beta * COMPONENT_WEIGHTS.historical_beta;

  const multiplied = weighted * KIND_MULTIPLIER[catalystKind];
  return (
    Math.round(Math.max(0, Math.min(1, multiplied)) * 1000) / 1000
  );
}

export const RELEVANCE_MAPPING_THRESHOLD = 0.3;
export const RELEVANCE_ADJUSTMENT_THRESHOLD = 0.5;

export function shouldIncludeInMapping(score: number): boolean {
  return score >= RELEVANCE_MAPPING_THRESHOLD;
}

export function shouldTriggerConvictionAdjustment(
  score: number,
): boolean {
  return score >= RELEVANCE_ADJUSTMENT_THRESHOLD;
}
