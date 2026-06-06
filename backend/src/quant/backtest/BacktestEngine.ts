/**
 * BacktestEngine — public facade for backtest task creation/execution.
 * Controllers MUST only import from here (and the 4 other public facades).
 *
 * NOTE: the strategy_keys / params_by_strategy resolution that QuantController
 * previously did inline before calling QuantBacktestService is now baked into
 * the facade's create*() methods, so callers can pass raw request payloads.
 */
import { quantBacktestService } from './internal/QuantBacktestService';
import { quantStrategyService } from '../engine/internal/QuantStrategyService';

async function withResolvedStrategyParams(input: any) {
  const strategy_keys = await quantStrategyService.resolveStrategyKeys(
    input?.strategy_keys || input?.strategyKeys
  );
  const params_by_strategy = {
    ...(await quantStrategyService.getDefaultParamsByStrategy(strategy_keys)),
    ...(input?.params_by_strategy || input?.paramsByStrategy || {}),
  };
  return { strategy_keys, params_by_strategy };
}

export class BacktestEngine {
  async create(input: any, user_id?: number, asyncMode = true) {
    const { strategy_keys, params_by_strategy } = await withResolvedStrategyParams(input);
    return quantBacktestService.createBacktestTask(
      { ...input, strategy_keys, params_by_strategy },
      user_id,
      asyncMode
    );
  }

  async createWalkForward(input: any, user_id?: number) {
    const { strategy_keys, params_by_strategy } = await withResolvedStrategyParams(input);
    return quantBacktestService.createWalkForwardBacktests(
      { ...input, strategy_keys, params_by_strategy },
      user_id
    );
  }

  async createParameterGrid(input: any, user_id?: number) {
    const { strategy_keys, params_by_strategy } = await withResolvedStrategyParams(input);
    return quantBacktestService.createParameterGridBacktests(
      { ...input, strategy_keys, params_by_strategy },
      user_id
    );
  }

  summarizeParameterGrid(options: { user_id?: number; group_id?: string; limit?: number }) {
    return quantBacktestService.summarizeParameterGridSearch(options);
  }

  list(user_id?: number, limit = 30) {
    return quantBacktestService.listBacktests(user_id, limit);
  }

  get(id: number) {
    return quantBacktestService.getBacktest(id);
  }

  retry(id: number, user_id?: number) {
    return quantBacktestService.retryBacktest(id, user_id);
  }

  processTask(
    taskId: number,
    options: any,
    runtime: { user_id?: number; on_progress?: (progress: number) => Promise<any> | any }
  ) {
    return quantBacktestService.processBacktestTask(taskId, options, runtime);
  }

  markTaskFailed(task_id: number, error: any) {
    return quantBacktestService.markTaskFailed(task_id, error);
  }
}

export const backtestEngine = new BacktestEngine();
