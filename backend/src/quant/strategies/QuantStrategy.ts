import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';

export abstract class QuantStrategy {
  abstract readonly definition: QuantStrategyDefinition;

  abstract evaluate(
    context: QuantStockContext,
    options?: QuantStrategyRuntimeOptions
  ): QuantSignalResult;

  protected mergeParams(options?: QuantStrategyRuntimeOptions): Record<string, any> {
    return {
      ...(this.definition.default_params || {}),
      ...(options?.params || {}),
    };
  }
}
