export type {
  Score,
  Dimension,
  Weights,
  WeightsProfile,
  Band,
  CatalystKind,
  Adjustment,
  Conviction,
  ConvictionLevel,
  ScoreRef,
  RiskGate,
  RiskGateTriggerCode,
  GateStatus,
  Trigger,
  TriggerSeverity,
  SizeHint,
  SizeHintTier,
  EntryPlan,
  TimeHorizon,
  PriceBand,
  Price,
  TickerDataBundle,
  QualityInputs,
  GrowthInputs,
  ValuationInputs,
  MoatInputs,
  TrendInputs,
  RiskInputs,
  SourceVersions,
} from "./types";

export { scoreToBand } from "./band";
export {
  getWeights,
  validateWeightsSum,
  registerCustomWeights,
} from "./weights";
export { scoreQuality } from "./dimensions/quality";
export { scoreGrowth } from "./dimensions/growth";
export { scoreValuation } from "./dimensions/valuation";
export { scoreMoat } from "./dimensions/moat";
export { scoreTrend } from "./dimensions/trend";
export { scoreRisk } from "./dimensions/risk";
export {
  generateScoringId,
  computeSnapshotHash,
} from "./snapshot";
export {
  computeConviction,
  buildCatalystAdjustment,
  buildRiskGateAdjustment,
} from "./conviction";
export { evaluateRiskGate } from "./risk-gate";
export type { RiskSignals } from "./risk-gate";
export {
  computeRelevanceScore,
  shouldIncludeInMapping,
  shouldTriggerConvictionAdjustment,
  RELEVANCE_MAPPING_THRESHOLD,
  RELEVANCE_ADJUSTMENT_THRESHOLD,
} from "./relevance";
export type { RelevanceComponents } from "./relevance";
export { deriveSizeHint, generateEntryPlan } from "./entry-plan";
export type { EntryPlanInputs } from "./entry-plan";
export { runScoringPipeline } from "./pipeline";
export type {
  ScoringPipelineResult,
  PipelineConfig,
} from "./pipeline";
