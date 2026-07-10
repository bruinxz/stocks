import type {
  Conviction,
  EntryPlan,
  PriceBand,
  Price,
  ScoreRef,
  SizeHint,
  SizeHintTier,
  TimeHorizon,
} from "./types";

const SIZE_HINT_TABLE: readonly {
  minConviction: number;
  tier: SizeHintTier;
  pct: number;
}[] = [
  { minConviction: 85, tier: "TIER_5", pct: 5.0 },
  { minConviction: 70, tier: "TIER_3", pct: 3.0 },
  { minConviction: 55, tier: "TIER_2", pct: 2.0 },
  { minConviction: 40, tier: "TIER_1", pct: 1.0 },
];

export function deriveSizeHint(
  convictionFinal: number,
  rationale: string,
): SizeHint {
  for (const row of SIZE_HINT_TABLE) {
    if (convictionFinal >= row.minConviction) {
      return {
        tier: row.tier,
        pct: row.pct,
        disclaimer_key: "size_hint_advisory",
        rationale: rationale.slice(0, 200),
      };
    }
  }
  return {
    tier: "SKIP",
    pct: 0,
    disclaimer_key: "size_hint_advisory",
    rationale: "Conviction below TIER_1 threshold",
  };
}

export interface EntryPlanInputs {
  ticker: string;
  conviction: Conviction;
  scoreRef: ScoreRef;
  currentPrice: number;
  currency: PriceBand["currency"];
  timeHorizon: TimeHorizon;
  generatedAt: string;
  technicalSupport?: number;
  technicalResistances?: number[];
  trendBand?: string;
  riskBand?: string;
  invalidation: string;
}

export function generateEntryPlan(
  inputs: EntryPlanInputs,
): EntryPlan | null {
  if (inputs.conviction.final < 40) return null;

  const mid = inputs.currentPrice;
  const entry: PriceBand = {
    low: Math.round(mid * 0.97 * 100) / 100,
    high: Math.round(mid * 1.02 * 100) / 100,
    currency: inputs.currency,
  };

  let stopPct = 0.08;
  if (inputs.technicalSupport != null) {
    const supportPct =
      (mid - inputs.technicalSupport) / mid;
    if (supportPct > 0.05 && supportPct < 0.1) {
      stopPct = supportPct;
    }
  }
  const canExpand =
    inputs.trendBand != null &&
    inputs.riskBand != null &&
    ["A", "B"].includes(inputs.trendBand) &&
    ["A", "B"].includes(inputs.riskBand);
  if (canExpand && stopPct === 0.08) {
    stopPct = 0.12;
  }

  const stop: Price = {
    value: Math.round(mid * (1 - stopPct) * 100) / 100,
    currency: inputs.currency,
  };

  const defaultTargetPcts = [0.15, 0.3, 0.5];
  const targets: Price[] = defaultTargetPcts.map((pct) => ({
    value: Math.round(mid * (1 + pct) * 100) / 100,
    currency: inputs.currency,
  }));

  if (
    inputs.technicalResistances &&
    inputs.technicalResistances.length > 0
  ) {
    const sorted = [...inputs.technicalResistances].sort(
      (a, b) => a - b,
    );
    for (
      let i = 0;
      i < Math.min(targets.length, sorted.length);
      i++
    ) {
      targets[i].value =
        Math.round(sorted[i] * 100) / 100;
    }
  }

  const sizeHint = deriveSizeHint(
    inputs.conviction.final,
    `Conviction ${inputs.conviction.final} level=${inputs.conviction.level}`,
  );

  return {
    ticker: inputs.ticker,
    generated_at: inputs.generatedAt,
    entry,
    stop,
    targets,
    size_hint: sizeHint,
    time_horizon: inputs.timeHorizon,
    invalidation: inputs.invalidation.slice(0, 240),
    conviction_ref: inputs.conviction.final,
    score_ref: inputs.scoreRef,
  };
}
