import type {
  Adjustment,
  CatalystKind,
  Conviction,
  ConvictionLevel,
  ScoreRef,
} from "./types";

const CATALYST_DEFAULT_DELTA: Record<CatalystKind, number> = {
  earnings: 5,
  upgrade_downgrade: 5,
  product: 5,
  regulator: 7,
  geo_macro: 7,
  ma_activity: 7,
  sector_move: 3,
  leadership: 3,
  unclassified: 0,
};

const RISK_GATE_DELTA = { YELLOW: -5, RED: -10 } as const;

export function computeConviction(
  ticker: string,
  asOf: string,
  scoreTotal: number,
  scoreRef: ScoreRef,
  adjustments: Adjustment[],
): Conviction {
  validateAdjustments(adjustments);

  const sumDelta = adjustments.reduce((acc, a) => acc + a.delta, 0);
  const final =
    Math.round(
      Math.max(0, Math.min(100, scoreTotal + sumDelta)) * 10,
    ) / 10;

  return {
    ticker,
    as_of: asOf,
    base: scoreTotal,
    score_ref: scoreRef,
    adjustments,
    final,
    level: convictionLevel(final),
  };
}

function convictionLevel(final: number): ConvictionLevel {
  if (final >= 75) return "HIGH";
  if (final >= 50) return "MED";
  return "LOW";
}

function validateAdjustments(adjustments: Adjustment[]): void {
  if (adjustments.length > 5) {
    throw new Error(
      `Adjustments count ${adjustments.length} exceeds max 5`,
    );
  }
  for (const a of adjustments) {
    if (a.delta < -20 || a.delta > 20) {
      throw new Error(
        `Adjustment delta ${a.delta} out of [-20, +20] range`,
      );
    }
  }
  const sumDelta = adjustments.reduce((acc, a) => acc + a.delta, 0);
  if (sumDelta < -20 || sumDelta > 20) {
    throw new Error(
      `Sum of adjustments delta ${sumDelta} out of [-20, +20] range`,
    );
  }
}

export function buildCatalystAdjustment(
  kind: CatalystKind,
  sourceRef: string,
  evidenceDelta?: number,
): Adjustment {
  const baseDelta = CATALYST_DEFAULT_DELTA[kind];
  const delta =
    evidenceDelta != null
      ? Math.max(-20, Math.min(20, baseDelta + evidenceDelta))
      : baseDelta;

  return {
    delta,
    reason: `catalyst_kind=${kind} default=${baseDelta}${evidenceDelta != null ? ` evidence_adjust=${evidenceDelta}` : ""}`,
    kind_ref: kind,
    source_ref: sourceRef,
  };
}

export function buildRiskGateAdjustment(
  gate: "YELLOW" | "RED",
  triggerCode: string,
): Adjustment {
  return {
    delta: RISK_GATE_DELTA[gate],
    reason: `RiskGate ${gate} trigger=${triggerCode}`,
    source_ref: triggerCode,
  };
}
