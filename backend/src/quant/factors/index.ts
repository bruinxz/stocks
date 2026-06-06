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
