import type {
  Score,
  Conviction,
  RiskGate,
  EntryPlan,
  TickerDataBundle,
  WeightsProfile,
  Adjustment,
  ScoreRef,
} from "./types";
import { getWeights, validateWeightsSum } from "./weights";
import { scoreToBand } from "./band";
import { scoreQuality } from "./dimensions/quality";
import { scoreGrowth } from "./dimensions/growth";
import { scoreValuation } from "./dimensions/valuation";
import { scoreMoat } from "./dimensions/moat";
import { scoreTrend } from "./dimensions/trend";
import { scoreRisk } from "./dimensions/risk";
import {
  generateScoringId,
  computeSnapshotHash,
} from "./snapshot";
import { computeConviction } from "./conviction";
import {
  evaluateRiskGate,
  type RiskSignals,
} from "./risk-gate";
import {
  generateEntryPlan,
  type EntryPlanInputs,
} from "./entry-plan";

export interface ScoringPipelineResult {
  score: Score;
  conviction: Conviction;
  riskGate: RiskGate;
  entryPlan: EntryPlan | null;
}

export interface PipelineConfig {
  profile: WeightsProfile;
  adjustments: Adjustment[];
  riskSignals: RiskSignals;
  timestamp: string;
  entryPlanInputs?: Omit<
    EntryPlanInputs,
    "conviction" | "scoreRef" | "generatedAt"
  >;
}

export async function runScoringPipeline(
  bundle: TickerDataBundle,
  config: PipelineConfig,
): Promise<ScoringPipelineResult> {
  const weights = getWeights(config.profile);
  validateWeightsSum(weights);

  const quality = scoreQuality(bundle.quality_inputs);
  const growth = scoreGrowth(bundle.growth_inputs);
  const valuation = scoreValuation(bundle.valuation_inputs);
  const moat = scoreMoat(bundle.moat_inputs);
  const trend = scoreTrend(bundle.trend_inputs);
  const risk = scoreRisk(bundle.risk_inputs);

  const rawTotal =
    quality.score * weights.quality +
    growth.score * weights.growth +
    valuation.score * weights.valuation +
    moat.score * weights.moat +
    trend.score * weights.trend +
    risk.score * weights.risk;
  const total =
    Math.round(Math.max(0, Math.min(100, rawTotal)) * 10) / 10;
  const rating = scoreToBand(total);

  const scoringId = generateScoringId();
  const scoreWithoutIds = {
    ticker: bundle.ticker,
    as_of: bundle.as_of,
    quality,
    growth,
    valuation,
    moat,
    trend,
    risk,
    weights,
    weights_profile: config.profile,
    total,
    rating,
    computed_at: config.timestamp,
    source_versions: {
      quality_engine: "quality@v0.2.0",
      growth_engine: "growth@v0.2.0",
      valuation_engine: "valuation@v0.2.0",
      moat_engine: "moat@v0.2.0",
      trend_engine: "trend@v0.2.0",
      risk_engine: "risk@v0.2.0",
    },
  };

  const snapshotHash = await computeSnapshotHash(
    scoreWithoutIds,
  );

  const score: Score = {
    scoring_id: scoringId,
    snapshot_hash: snapshotHash,
    ...scoreWithoutIds,
  };

  const scoreRef: ScoreRef = {
    scoring_id: scoringId,
    snapshot_hash: snapshotHash,
  };

  const riskGate = evaluateRiskGate(
    config.riskSignals,
    config.timestamp,
  );

  const allAdjustments = [...config.adjustments];
  if (riskGate.gate === "YELLOW") {
    const warnTrigger = riskGate.triggers.find(
      (t) => t.severity === "warn",
    );
    if (warnTrigger) {
      allAdjustments.push({
        delta: -5,
        reason: `RiskGate YELLOW trigger=${warnTrigger.code}`,
        source_ref: warnTrigger.code,
      });
    }
  } else if (riskGate.gate === "RED") {
    const blockTrigger = riskGate.triggers.find(
      (t) => t.severity === "block",
    );
    if (blockTrigger) {
      allAdjustments.push({
        delta: -10,
        reason: `RiskGate RED trigger=${blockTrigger.code}`,
        source_ref: blockTrigger.code,
      });
    }
  }

  const conviction = computeConviction(
    bundle.ticker,
    bundle.as_of,
    total,
    scoreRef,
    allAdjustments,
  );

  let entryPlan: EntryPlan | null = null;
  if (riskGate.ok_to_enter && config.entryPlanInputs) {
    entryPlan = generateEntryPlan({
      ...config.entryPlanInputs,
      conviction,
      scoreRef,
      generatedAt: config.timestamp,
    });
  }

  return { score, conviction, riskGate, entryPlan };
}
