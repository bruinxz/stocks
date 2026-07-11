import type { Weights, WeightsProfile } from "./types";

const WEIGHT_REGISTRY: Record<string, Weights> = {
  us_preferred: {
    quality: 0.20,
    growth: 0.20,
    valuation: 0.15,
    moat: 0.20,
    trend: 0.15,
    risk: 0.10,
  },
  multibagger: {
    quality: 0.10,
    growth: 0.30,
    valuation: 0.10,
    moat: 0.15,
    trend: 0.20,
    risk: 0.15,
  },
  japan_blue_chip: {
    quality: 0.25,
    growth: 0.15,
    valuation: 0.15,
    moat: 0.20,
    trend: 0.15,
    risk: 0.10,
  },
  korea_semiconductor_chain: {
    quality: 0.15,
    growth: 0.30,
    valuation: 0.10,
    moat: 0.15,
    trend: 0.20,
    risk: 0.10,
  },
  japan_multibagger: {
    quality: 0.10,
    growth: 0.25,
    valuation: 0.10,
    moat: 0.15,
    trend: 0.25,
    risk: 0.15,
  },
  korea_multibagger: {
    quality: 0.10,
    growth: 0.30,
    valuation: 0.10,
    moat: 0.10,
    trend: 0.25,
    risk: 0.15,
  },
};

export function getWeights(profile: WeightsProfile): Weights {
  const w = WEIGHT_REGISTRY[profile];
  if (!w) {
    throw new Error(`Unknown weight profile: ${profile}`);
  }
  return { ...w };
}

export function validateWeightsSum(w: Weights): void {
  const sum =
    w.quality + w.growth + w.valuation + w.moat + w.trend + w.risk;
  if (Math.abs(sum - 1.0) > 1e-9) {
    throw new Error(`Weights sum ${sum} deviates from 1.0 beyond tolerance`);
  }
}

export function registerCustomWeights(
  profile: string,
  weights: Weights,
): void {
  validateWeightsSum(weights);
  WEIGHT_REGISTRY[profile] = weights;
}
