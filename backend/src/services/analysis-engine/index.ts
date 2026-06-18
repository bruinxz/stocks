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
