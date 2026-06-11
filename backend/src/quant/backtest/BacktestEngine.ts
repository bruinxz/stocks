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
import { costSensitivityAnalysis, CostSensitivityAnalyzeOptions } from './CostSensitivityAnalysis';
import {
  walkForwardValidator,
  WalkForwardInput,
  WalkForwardOptions,
} from './WalkForwardValidator';

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

  /**
   * US-016：对比 2-4 个已完成回测的核心指标 + 净值曲线。前端在"回测对比" tab 调用。
   */
  compare(taskIds: number[]) {
    return quantBacktestService.compareBacktests(taskIds);
  }

  /**
   * US-075：回测对比子图 — 冠军策略的回撤序列。
   * 前端 LabWorkspace "回测对比" tab 下方叠加多任务回撤曲线。
   */
  getDrawdownSeries(taskId: number) {
    return quantBacktestService.getDrawdownSeries(taskId);
  }

  /**
   * US-075：回测对比子图 — 冠军策略的月度收益。
   * 前端按 (year × month) 矩阵渲染热力图。
   */
  getMonthlyReturns(taskId: number) {
    return quantBacktestService.getMonthlyReturns(taskId);
  }

  /**
   * US-075：回测对比子图 — 冠军策略的滚动 N 日（默认 90）夏普序列。
   */
  getRollingSharpeSeries(taskId: number, windowDays?: number) {
    return quantBacktestService.getRollingSharpeSeries(taskId, windowDays);
  }

  /**
   * US-085：交易成本敏感性分析 — 对一个已完成 backtest 按 3 档佣金
   * （万 1.5 / 万 2.5 / 万 5）重跑，把每档的 annual_return / sharpe /
   * turnover 落到 CostSensitivityResult。
   *
   * 由 POST /api/quant/backtests/:id/cost-sensitivity 调用。controller
   * 只 import 本 facade —— 与 US-003 facade 收敛规则一致。
   */
  runCostSensitivityAnalysis(taskId: number, options?: CostSensitivityAnalyzeOptions) {
    return costSensitivityAnalysis.analyze(taskId, options);
  }

  /**
   * Phase 1: Walk-Forward 验证 — in-process 实现 (US-039+ 升级版)
   *
   * 与 `createWalkForward()` 不同：后者走 Bull queue 并发跑多个 backtest tasks
   * （兼容旧 UI），前者走单进程 walkForwardValidator 自带的 train/test 流水线
   * 加 DSR/PBO/CPCV/Bayesian 严谨性升级。
   *
   * 由 POST /api/quant/walk-forward 调用。
   */
  runWalkForwardValidation(input: WalkForwardInput, options?: WalkForwardOptions) {
    return walkForwardValidator.validate(input, options);
  }

  /**
   * Phase 1: 列出最近的 walk-forward run
   * 由 GET /api/quant/walk-forward/runs 调用。
   */
  listWalkForwardRuns(options?: { strategy_name?: string; limit?: number; user_id?: number }) {
    return walkForwardValidator.listRuns(options);
  }

  /**
   * Phase 1: 拿一个 walk-forward run 的所有 windows
   * 由 GET /api/quant/walk-forward/runs/:id/windows 调用。
   */
  getWalkForwardWindows(run_id: number) {
    return walkForwardValidator.getRunWindows(run_id);
  }

  /**
   * Phase 1: 删除一个 walk-forward run
   * 由 DELETE /api/quant/walk-forward/runs/:id 调用。
   */
  deleteWalkForwardRun(run_id: number) {
    return walkForwardValidator.deleteRun(run_id);
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
