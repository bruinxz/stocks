/**
 * factors/ 模块统一出口（US-009）
 *
 * 调用方建议：
 *   import { factorRegistry, factorPipeline, Factor, FactorContext } from '../quant/factors';
 *   import '../quant/factors/library';  // import-time 触发因子自我登记
 */

export { factorRegistry, FactorRegistry } from './FactorRegistry';
export { factorPipeline, FactorPipeline } from './FactorPipeline';
export type {
  FactorPipelineRunOptions,
  FactorRunResult,
  FactorRunSingleResult,
} from './FactorPipeline';
export type { Factor, FactorContext, FactorComputeOutput, FactorCategory } from './types';
export { winsorize, zscore, percentileRanks, mean, stddev } from './normalization';

// US-041 因子 IC 报告
export {
  factorICReport,
  FactorICReport,
  DefaultFactorICDataSource,
  PRODUCTION_FACTOR_IC_DATA_SOURCE,
  DEFAULT_LOOK_FORWARD_DAYS,
  MIN_CROSS_SECTION_SIZE,
  rankAscending,
  spearmanCorrelation,
  mean as factorICMean,
  sampleStddev as factorICSampleStddev,
  aggregateICSeries,
} from './FactorICReport';
export type {
  FactorICDataSource,
  FactorICReportInput,
  FactorICReportOptions,
  FactorICReportResult,
  FactorICWindowResult,
  DailyICRecord,
  ICStatistics,
  ICResultFilter,
} from './FactorICReport';

// US-042 因子相关性矩阵
export {
  factorCorrelationReport,
  FactorCorrelationReport,
  DefaultFactorCorrelationDataSource,
  PRODUCTION_FACTOR_CORRELATION_DATA_SOURCE,
  MIN_PAIR_SIZE,
  REDUNDANCY_THRESHOLD,
  dedupPairsToUpperTriangle,
  computeDailyCorrelation,
  aggregateCorrelationSeries,
} from './FactorCorrelationReport';
export type {
  FactorCorrelationDataSource,
  FactorCorrelationReportInput,
  FactorCorrelationReportOptions,
  FactorCorrelationReportResult,
  FactorPairResult,
  DailyCorrelationRecord,
  CorrelationStatistics,
  CorrelationResultFilter,
} from './FactorCorrelationReport';
