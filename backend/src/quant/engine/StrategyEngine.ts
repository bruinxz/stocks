/**
 * StrategyEngine — public facade for the strategy / experiment / param-version / fusion
 * subsystem. Controllers MUST only import from here (and the 4 other public facades).
 *
 * Backed by services under ./internal/ which are NOT exported from quant/.
 * See backend/src/quant/CLAUDE.md for the facade rules.
 */
import { quantStrategyService } from './internal/QuantStrategyService';
import { quantStrategyFeedbackService } from './internal/QuantStrategyFeedbackService';
import { quantStrategySourceService } from './internal/QuantStrategySourceService';

// Stubs for deleted services
const quantStrategyExperimentService = {
  getExperimentSummary: async (_opts?: any) => ({ experiments: [], count: 0 }),
  getParamsByStrategySuggestion: async (_opts?: any): Promise<any[]> => [],
};
const quantStrategyParamVersionService = {
  getDashboard: async (_opts?: any) => ({ versions: [], count: 0 }),
  getActiveParamsForScan: async (_opts?: any) => ({}),
  refreshVersionsFromExperiments: async (_opts?: any) => ({ created: 0, updated: 0 }),
  createPendingValidationsFromSignals: async (_opts?: any) => ({ created: 0 }),
  refreshValidationReturns: async (_opts?: any) => ({ updated: 0 }),
  evaluateAndApplyLifecycle: async (_opts?: any) => ({ promoted: 0, degraded: 0 }),
  upsertGridSearchCandidates: async (_opts?: any) => ({ upserted: 0 }),
};

export interface UpdateStrategyConfigInput {
  enabled?: boolean;
  default_params?: any;
  execution_policy?: any;
  environment_policy?: any;
  lifecycle_policy?: any;
  /** Phase 4: 策略的可证伪 edge 假设 (替换式更新) */
  edge_hypothesis?: any;
  notes?: string;
  display_order?: number;
}

export class StrategyEngine {
  // ---- registry --------------------------------------------------------
  listStrategies() {
    return quantStrategyService.listStrategies();
  }

  updateStrategyConfig(strategyKey: string, payload: UpdateStrategyConfigInput) {
    return quantStrategyService.updateStrategyConfig(strategyKey, payload);
  }

  /**
   * US-078：单只策略详情聚合 —— 元数据 + 近 10 次回测（带该策略的 KPI）+ 最新 IC + 实盘绑定。
   * 4 类子查询任一失败用 fallback，不阻塞页面渲染。
   */
  getStrategyDetail(strategyKey: string) {
    return quantStrategyService.getStrategyDetail(strategyKey);
  }

  /**
   * US-093：返回策略源文件（.ts）内容，供前端 Monaco 编辑器只读展示。
   * strategy_key 严格校验 `^[a-z][a-z0-9_]*$`；按 strategy_key → filename 的缓存查找
   * 而不是直接拼接路径，杜绝 path traversal。256KB 上限保护后端。
   */
  getStrategySource(strategyKey: string) {
    return quantStrategySourceService.getStrategySource(strategyKey);
  }

  resolveStrategyKeys(input: any) {
    return quantStrategyService.resolveStrategyKeys(input);
  }

  /**
   * US-083: 返回所有标记为 dry-run 的策略 key（`lifecycle_policy.dry_run === true`）。
   * PaperTradingFacade.applyAutomation 调用此方法，把结果传给 AutomationService
   * 让这些策略的信号走 planned-only 路径（仍写 QuantSignal，不实际下单）。
   * DB 故障 fail-OPEN 返回空数组（让 dry-run 策略真实下单也不让全部策略被误判 dry-run）。
   */
  getDryRunStrategyKeys() {
    return quantStrategyService.getDryRunStrategyKeys();
  }

  getDefaultParamsByStrategy(strategyKeys: string[]) {
    return quantStrategyService.getDefaultParamsByStrategy(strategyKeys);
  }

  // ---- experiments -----------------------------------------------------
  listExperiments(options: { limit?: number }) {
    return quantStrategyExperimentService.getExperimentSummary(options);
  }

  getExperimentParamSuggestions(options: {
    limit?: number;
    min_rank_score?: number;
    min_excess_return_pct?: number;
    min_trade_count?: number;
    max_drawdown_pct?: number;
    min_stable_count?: number;
  }) {
    return quantStrategyExperimentService.getParamsByStrategySuggestion(options);
  }

  // ---- param versions --------------------------------------------------
  listParamVersions(options: { limit?: number; strategy_key?: string }) {
    return quantStrategyParamVersionService.getDashboard(options);
  }

  getActiveScanParams(options: {
    strategy_keys?: string[];
    include_grid_search?: boolean;
    include_experiment?: boolean;
    include_observing?: boolean;
    include_degraded?: boolean;
  }) {
    return quantStrategyParamVersionService.getActiveParamsForScan(options);
  }

  refreshParamVersions(options: {
    suggestion_options?: any;
    manual_params_by_strategy?: any;
    use_experiment_params?: boolean;
  }) {
    return quantStrategyParamVersionService.refreshVersionsFromExperiments({
      suggestion_options: options.suggestion_options,
      manual_params_by_strategy: options.manual_params_by_strategy,
      use_experiment_params: options.use_experiment_params,
    });
  }

  async refreshParamValidations(options: {
    trade_date?: string;
    start_date?: string;
    end_date?: string;
    strategy_keys?: string[];
    horizons?: any;
    limit?: number;
    signal?: any;
    refresh_limit?: number;
    include_completed?: boolean;
    auto_sync_benchmark?: boolean;
    dry_run_lifecycle?: boolean;
    lifecycle_policy?: any;
  }) {
    const createResult = await quantStrategyParamVersionService.createPendingValidationsFromSignals(
      {
        trade_date: options.trade_date,
        start_date: options.start_date,
        end_date: options.end_date,
        strategy_keys: options.strategy_keys,
        horizons: options.horizons,
        limit: options.limit ?? 500,
        signal: options.signal,
      }
    );
    const refreshResult = await quantStrategyParamVersionService.refreshValidationReturns({
      limit: options.refresh_limit ?? 1000,
      include_completed: Boolean(options.include_completed),
      auto_sync_benchmark: Boolean(options.auto_sync_benchmark),
    });
    const lifecycleResult = await quantStrategyParamVersionService.evaluateAndApplyLifecycle({
      dry_run: Boolean(options.dry_run_lifecycle),
      policy: options.lifecycle_policy,
    });
    return { create: createResult, refresh: refreshResult, lifecycle: lifecycleResult };
  }

  refreshParamLifecycle(options: { dry_run?: boolean; policy?: any; limit?: number }) {
    return quantStrategyParamVersionService.evaluateAndApplyLifecycle({
      dry_run: Boolean(options.dry_run),
      policy: options.policy,
      limit: options.limit ?? 5000,
    });
  }

  upsertGridSearchCandidates(options: { groups: any[]; min_rank_score?: number }) {
    return quantStrategyParamVersionService.upsertGridSearchCandidates(options);
  }

  // ---- fusion / weights / allocation ----------------------------------
  refreshWeights(options: any) {
    return quantStrategyFeedbackService.refreshWeights(options || {});
  }

  listWeights() {
    return quantStrategyFeedbackService.listWeights();
  }

  getAllocationPolicy(options: {
    capital?: number;
    max_weight_pct?: number;
    min_weight_pct?: number;
  }) {
    return quantStrategyFeedbackService.getAllocationPolicy({
      capital: options.capital ?? 200000,
      max_weight_pct: options.max_weight_pct ?? 35,
      min_weight_pct: options.min_weight_pct ?? 4,
    });
  }
}

export const strategyEngine = new StrategyEngine();
