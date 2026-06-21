/**
 * analysis-engine — 多维分析引擎 v1 公共出口.
 *
 * 详见 ./CLAUDE.md.
 *
 * 入口:
 *   import { analysisEngineService, shadowDoubleRunService } from '.../analysis-engine';
 */

export * from './AnalyzerTypes';
export { evaluateDataQuality, DATA_QUALITY_COEFFICIENT } from './DataQualityVerdict';
export {
  DEFAULT_ANALYZER_WEIGHTS,
  DecisionAggregator,
  decisionAggregator,
  mapScoreToAction,
  normalizeWeights,
  pickEntryZone,
  pickStopLoss,
  pickTakeProfit,
  pickKeyReasons,
  collectRiskWarnings,
  pickConfidenceTier,
  CONFIDENCE_TIER_HIGH_MIN,
  CONFIDENCE_TIER_MEDIUM_MIN,
} from './DecisionAggregator';
export {
  AnalysisEngineService,
  analysisEngineService,
  PRODUCTION_ANALYSIS_ENGINE_DATA_SOURCE,
  inferMarketSegmentFromSymbol,
} from './AnalysisEngineService';
export {
  ShadowDoubleRunService,
  shadowDoubleRunService,
  normalizeAnalysisEngineConfig,
  DEFAULT_ANALYSIS_ENGINE_CONFIG,
  PRODUCTION_SHADOW_DATA_SOURCE,
  type AnalysisEngineMode,
  type AnalysisEngineUserConfig,
  type ShadowDataSource,
  type MaybeRunShadowInput,
} from './ShadowDoubleRunService';

export { BaseAnalyzer, zScoreToScore, clampScore, clamp01 } from './analyzers/BaseAnalyzer';
export { fundamentalAnalyzer, FundamentalAnalyzer } from './analyzers/FundamentalAnalyzer';
export { technicalAnalyzer, TechnicalAnalyzer } from './analyzers/TechnicalAnalyzer';
export { capitalAnalyzer, CapitalAnalyzer } from './analyzers/CapitalAnalyzer';
export { newsAnalyzer, NewsAnalyzer } from './analyzers/NewsAnalyzer';
export { sentimentAnalyzer, SentimentAnalyzer } from './analyzers/SentimentAnalyzer';
export { industryRegimeAnalyzer, IndustryRegimeAnalyzer } from './analyzers/IndustryRegimeAnalyzer';
export { riskAnalyzer, RiskAnalyzer } from './analyzers/RiskAnalyzer';
export { eventAnalyzer, EventAnalyzer } from './analyzers/EventAnalyzer';

export {
  ANALYSIS_ENGINE_PRESERVED_METADATA_KEYS,
  archiveAnalysisEngineResult,
  buildAnalysisEngineSignalPayload,
  buildAnalysisEngineSourceId,
  createProductionAnalysisEngineArchiveDataSource,
  mapRecommendationActionToDecision,
  mergeAnalysisEnginePayload,
  pickAnalysisEngineRiskLevel,
  type AnalysisEngineArchiveDataSource,
  type AnalysisEngineSignalPayload,
  type ArchiveAnalysisEngineResultInput,
  type ArchiveAnalysisEngineResultOutput,
  type BuildAnalysisEngineSignalPayloadInput,
} from './analysisEngineSignalArchive';

export {
  HARD_SHORT_CIRCUIT_DIMENSIONS,
  ANALYZER_TO_LEGACY_DIMENSION,
  PRODUCTION_HARD_SHORT_CIRCUIT_DATA_SOURCE,
  buildHardModeSummary,
  buildHardShortCircuitResult,
  buildKeyPointsFromDecision,
  createProductionHardShortCircuitDataSource,
  mapActionToRecommendation,
  maybeRunHardShortCircuit,
  pickAnalyzerEvidenceLabels,
  pickHardRiskLevel,
  type HardShortCircuitDataSource,
  type HardShortCircuitDimension,
  type HardShortCircuitResult,
  type MaybeRunHardShortCircuitInput,
} from './hardShortCircuit';
