import { Request, Response } from 'express';
import { quantStrategyService } from '../../quant/services/QuantStrategyService';
import { quantBacktestService } from '../../quant/services/QuantBacktestService';
import { quantSignalService } from '../../quant/services/QuantSignalService';
import { quantFusionService } from '../../quant/services/QuantFusionService';
import { quantStrategyFeedbackService } from '../../quant/services/QuantStrategyFeedbackService';
import { quantFusionAuditService } from '../../quant/services/QuantFusionAuditService';
import { quantPerformanceDashboardService } from '../../quant/services/QuantPerformanceDashboardService';
import { quantOpenWatchdogService } from '../../quant/services/QuantOpenWatchdogService';
import { quantStrategyExperimentService } from '../../quant/services/QuantStrategyExperimentService';
import { quantStrategyParamVersionService } from '../../quant/services/QuantStrategyParamVersionService';
import { quantDataFreshnessService } from '../../quant/services/QuantDataFreshnessService';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { logger } from '../../utils/logger';

export class QuantController {
  async getStrategies(req: Request, res: Response) {
    try {
      const strategies = await quantStrategyService.listStrategies();
      res.json({ success: true, data: strategies });
    } catch (error: any) {
      logger.error('获取量化策略失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async updateStrategyConfig(req: AuthenticatedRequest, res: Response) {
    try {
      const default_params =
        req.body?.default_params !== undefined
          ? req.body.default_params
          : req.body?.defaultParams !== undefined
          ? req.body.defaultParams
          : undefined;
      const strategy = await quantStrategyService.updateStrategyConfig(req.params.strategy_key, {
        enabled:
          req.body?.enabled === undefined || req.body?.enabled === null
            ? undefined
            : Boolean(req.body.enabled),
        default_params,
        execution_policy:
          req.body?.execution_policy !== undefined
            ? req.body.execution_policy
            : req.body?.executionPolicy !== undefined
            ? req.body.executionPolicy
            : undefined,
        environment_policy:
          req.body?.environment_policy !== undefined
            ? req.body.environment_policy
            : req.body?.environmentPolicy !== undefined
            ? req.body.environmentPolicy
            : undefined,
        lifecycle_policy:
          req.body?.lifecycle_policy !== undefined
            ? req.body.lifecycle_policy
            : req.body?.lifecyclePolicy !== undefined
            ? req.body.lifecyclePolicy
            : undefined,
        notes:
          req.body?.notes !== undefined
            ? String(req.body.notes || '')
            : undefined,
        display_order:
          req.body?.display_order !== undefined
            ? Number(req.body.display_order)
            : req.body?.displayOrder !== undefined
            ? Number(req.body.displayOrder)
            : undefined,
      });
      res.json({ success: true, data: strategy });
    } catch (error: any) {
      logger.error('更新量化策略配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getIndicatorCatalog(req: Request, res: Response) {
    try {
      const catalog = quantPerformanceDashboardService.getIndicatorCatalog();
      res.json({ success: true, data: catalog });
    } catch (error: any) {
      logger.error('获取量化指标目录失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getPerformanceDashboard(req: AuthenticatedRequest, res: Response) {
    try {
      const dashboard = await quantPerformanceDashboardService.getDashboard({
        user_id: req.user?.id,
        username: req.user?.username,
      });
      res.json({ success: true, data: dashboard });
    } catch (error: any) {
      logger.error('获取量化收益驾驶舱失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getOpenWatchdog(req: AuthenticatedRequest, res: Response) {
    try {
      const watchdog = await quantOpenWatchdogService.check(req.query as any);
      res.json({ success: true, data: watchdog });
    } catch (error: any) {
      logger.error('获取量化开盘链路看门狗失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getDataFreshness(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await quantDataFreshnessService.getSnapshot({
        trade_date: req.query.trade_date as string,
      });
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.error('获取量化数据新鲜度失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listStrategyExperiments(req: AuthenticatedRequest, res: Response) {
    try {
      const summary = await quantStrategyExperimentService.getExperimentSummary({
        limit: Number(req.query.limit || 80),
      });
      res.json({ success: true, data: summary });
    } catch (error: any) {
      logger.error('获取量化策略实验版本失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getExperimentParamSuggestions(req: AuthenticatedRequest, res: Response) {
    try {
      const suggestions = await quantStrategyExperimentService.getParamsByStrategySuggestion({
        limit: Number(req.query.limit || 300),
        min_rank_score: Number(req.query.min_rank_score || 8),
        min_excess_return_pct: Number(req.query.min_excess_return_pct || 0),
        min_trade_count: Number(req.query.min_trade_count || 1),
        max_drawdown_pct: Number(req.query.max_drawdown_pct || 35),
        min_stable_count: Number(req.query.min_stable_count || 1),
      });
      res.json({ success: true, data: suggestions });
    } catch (error: any) {
      logger.error('获取量化策略实验参数建议失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listParamVersions(req: AuthenticatedRequest, res: Response) {
    try {
      const dashboard = await quantStrategyParamVersionService.getDashboard({
        limit: Number(req.query.limit || 200),
        strategy_key: req.query.strategy_key as string,
      });
      res.json({ success: true, data: dashboard });
    } catch (error: any) {
      logger.error('获取量化策略参数 A/B 验证失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getActiveScanParams(req: AuthenticatedRequest, res: Response) {
    try {
      const strategy_keys =
        typeof req.query.strategy_keys === 'string'
          ? req.query.strategy_keys
              .split(',')
              .map(item => item.trim())
              .filter(Boolean)
          : typeof req.query.strategyKeys === 'string'
          ? req.query.strategyKeys
              .split(',')
              .map(item => item.trim())
              .filter(Boolean)
          : undefined;
      const result = await quantStrategyParamVersionService.getActiveParamsForScan({
        strategy_keys,
        include_grid_search: req.query.include_grid_search !== 'false',
        include_experiment: req.query.include_experiment !== 'false',
        include_observing: req.query.include_observing === 'true',
        include_degraded: req.query.include_degraded === 'true',
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('获取开盘扫描参数版本失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async refreshParamVersions(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await quantStrategyParamVersionService.refreshVersionsFromExperiments({
        suggestion_options: req.body?.suggestion_options || req.body?.suggestionOptions || {},
        manual_params_by_strategy: req.body?.params_by_strategy || req.body?.paramsByStrategy,
        use_experiment_params:
          req.body?.use_experiment_params !== undefined
            ? Boolean(req.body.use_experiment_params)
            : req.body?.useExperimentParams !== undefined
            ? Boolean(req.body.useExperimentParams)
            : true,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('刷新量化策略参数版本失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async refreshParamValidations(req: AuthenticatedRequest, res: Response) {
    try {
      const createResult =
        await quantStrategyParamVersionService.createPendingValidationsFromSignals({
          trade_date: req.body?.trade_date || req.body?.tradeDate,
          start_date: req.body?.start_date || req.body?.startDate,
          end_date: req.body?.end_date || req.body?.endDate,
          strategy_keys: req.body?.strategy_keys || req.body?.strategyKeys,
          horizons: req.body?.horizons,
          limit: Number(req.body?.limit || 500),
          signal: req.body?.signal,
        });
      const refreshResult = await quantStrategyParamVersionService.refreshValidationReturns({
        limit: Number(req.body?.refresh_limit || req.body?.refreshLimit || 1000),
        include_completed: Boolean(req.body?.include_completed || req.body?.includeCompleted),
        auto_sync_benchmark: Boolean(req.body?.auto_sync_benchmark || req.body?.autoSyncBenchmark),
      });
      const lifecycleResult = await quantStrategyParamVersionService.evaluateAndApplyLifecycle({
        dry_run: Boolean(req.body?.dry_run_lifecycle || req.body?.dryRunLifecycle),
        policy: req.body?.lifecycle_policy || req.body?.lifecyclePolicy,
      });
      res.json({
        success: true,
        data: { create: createResult, refresh: refreshResult, lifecycle: lifecycleResult },
      });
    } catch (error: any) {
      logger.error('刷新量化策略参数收益验证失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async refreshParamLifecycle(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await quantStrategyParamVersionService.evaluateAndApplyLifecycle({
        dry_run: Boolean(req.body?.dry_run || req.body?.dryRun),
        policy: req.body?.policy,
        limit: Number(req.body?.limit || 5000),
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('刷新量化策略参数生命周期失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async createBacktest(req: AuthenticatedRequest, res: Response) {
    try {
      const asyncMode = req.body?.async !== false && req.body?.async_mode !== false;
      const strategy_keys = await quantStrategyService.resolveStrategyKeys(
        req.body?.strategy_keys || req.body?.strategyKeys
      );
      const params_by_strategy = {
        ...(await quantStrategyService.getDefaultParamsByStrategy(strategy_keys)),
        ...(req.body?.params_by_strategy || req.body?.paramsByStrategy || {}),
      };
      const result = await quantBacktestService.createBacktestTask(
        {
          ...req.body,
          strategy_keys,
          params_by_strategy,
        },
        req.user?.id,
        asyncMode
      );
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('运行量化跑分失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async createWalkForwardBacktests(req: AuthenticatedRequest, res: Response) {
    try {
      const strategy_keys = await quantStrategyService.resolveStrategyKeys(
        req.body?.strategy_keys || req.body?.strategyKeys
      );
      const params_by_strategy = {
        ...(await quantStrategyService.getDefaultParamsByStrategy(strategy_keys)),
        ...(req.body?.params_by_strategy || req.body?.paramsByStrategy || {}),
      };
      const result = await quantBacktestService.createWalkForwardBacktests(
        {
          ...req.body,
          strategy_keys,
          params_by_strategy,
        },
        req.user?.id
      );
      res.json({ success: true, data: result, message: result.message });
    } catch (error: any) {
      logger.error('创建滚动验证跑分失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async createParameterGridBacktests(req: AuthenticatedRequest, res: Response) {
    try {
      const strategy_keys = await quantStrategyService.resolveStrategyKeys(
        req.body?.strategy_keys || req.body?.strategyKeys
      );
      const params_by_strategy = {
        ...(await quantStrategyService.getDefaultParamsByStrategy(strategy_keys)),
        ...(req.body?.params_by_strategy || req.body?.paramsByStrategy || {}),
      };
      const result = await quantBacktestService.createParameterGridBacktests(
        {
          ...req.body,
          strategy_keys,
          params_by_strategy,
        },
        req.user?.id
      );
      res.json({ success: true, data: result, message: result.message });
    } catch (error: any) {
      logger.error('创建参数网格跑分失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getParameterGridSummary(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await quantBacktestService.summarizeParameterGridSearch({
        user_id: req.user?.id,
        group_id: req.query.group_id as string,
        limit: Number(req.query.limit || 300),
      });
      let param_versions: any = null;
      if (req.query.upsert_versions === 'true' || req.query.upsertVersions === 'true') {
        param_versions = await quantStrategyParamVersionService.upsertGridSearchCandidates({
          groups: data.groups,
          min_rank_score: Number(req.query.min_rank_score || 0),
        });
      }
      res.json({ success: true, data: { ...data, param_versions } });
    } catch (error: any) {
      logger.error('获取参数网格搜索汇总失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listBacktests(req: AuthenticatedRequest, res: Response) {
    try {
      const tasks = await quantBacktestService.listBacktests(
        req.user?.id,
        Number(req.query.limit || 30)
      );
      res.json({ success: true, data: tasks });
    } catch (error: any) {
      logger.error('获取量化跑分任务失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getBacktest(req: Request, res: Response) {
    try {
      const data = await quantBacktestService.getBacktest(Number(req.params.id));
      if (!data) return res.status(404).json({ success: false, message: '跑分任务不存在' });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取量化跑分详情失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async retryBacktest(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await quantBacktestService.retryBacktest(Number(req.params.id), req.user?.id);
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('重试量化跑分失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async generateSignals(req: AuthenticatedRequest, res: Response) {
    try {
      const strategy_keys = await quantStrategyService.resolveStrategyKeys(
        req.body?.strategy_keys || req.body?.strategyKeys
      );
      const params_by_strategy = {
        ...(await quantStrategyService.getDefaultParamsByStrategy(strategy_keys)),
        ...(req.body?.params_by_strategy || req.body?.paramsByStrategy || {}),
      };
      const result = await quantSignalService.generateSignals({
        ...req.body,
        strategy_keys,
        params_by_strategy,
        user_id: req.user?.id,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('生成量化信号失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async runDailyPipeline(req: AuthenticatedRequest, res: Response) {
    try {
      const strategy_keys = await quantStrategyService.resolveStrategyKeys(
        req.body?.strategy_keys || req.body?.strategyKeys
      );
      const params_by_strategy = req.body?.params_by_strategy || req.body?.paramsByStrategy;
      const result = await quantFusionService.runDailyPipeline({
        ...req.body,
        strategy_keys,
        params_by_strategy,
        user_id: req.user?.id,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('运行量化融合闭环失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listSignals(req: Request, res: Response) {
    try {
      const signals = await quantSignalService.listSignals(req.query as any);
      res.json({ success: true, data: signals });
    } catch (error: any) {
      logger.error('获取量化信号失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async refreshStrategyWeights(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await quantStrategyFeedbackService.refreshWeights(req.body || {});
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('刷新量化策略权重失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listStrategyWeights(req: AuthenticatedRequest, res: Response) {
    try {
      const weights = await quantStrategyFeedbackService.listWeights();
      res.json({ success: true, data: weights });
    } catch (error: any) {
      logger.error('获取量化策略权重失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getAllocationPolicy(req: AuthenticatedRequest, res: Response) {
    try {
      const policy = await quantStrategyFeedbackService.getAllocationPolicy({
        capital: Number(req.query.capital || req.body?.capital || 200000),
        max_weight_pct: Number(req.query.max_weight_pct || req.body?.max_weight_pct || 35),
        min_weight_pct: Number(req.query.min_weight_pct || req.body?.min_weight_pct || 4),
      });
      res.json({ success: true, data: policy });
    } catch (error: any) {
      logger.error('获取量化策略资金分配建议失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async listFusionAudits(req: AuthenticatedRequest, res: Response) {
    try {
      const audits = await quantFusionAuditService.listAudits(req.query as any);
      res.json({ success: true, data: audits });
    } catch (error: any) {
      logger.error('获取量化融合审计失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getRankings(req: AuthenticatedRequest, res: Response) {
    try {
      const limit = Number(req.query.limit || 30);
      const [quantDashboard, fusionDashboard] = await Promise.all([
        quantSignalService.getRankingDashboard({
          trade_date: req.query.trade_date as string,
          limit,
        }),
        quantFusionAuditService.getRankingDashboard({
          signal_date: (req.query.signal_date || req.query.trade_date) as string,
          limit,
        }),
      ]);
      const quantSummary: any = quantDashboard.summary || {};
      const fusionSummary: any = fusionDashboard.summary || {};
      res.json({
        success: true,
        data: {
          generated_at: new Date().toISOString(),
          trade_date: quantDashboard.trade_date,
          signal_date: fusionDashboard.signal_date,
          quant_rankings: quantDashboard.quant_rankings,
          fusion_rankings: fusionDashboard.fusion_rankings,
          summary: {
            ...fusionSummary,
            ...quantSummary,
            fusion_count: fusionSummary.fusion_count || 0,
            fusion_buy_count: fusionSummary.fusion_buy_count ?? fusionSummary.buy_count ?? 0,
            fusion_watch_count: fusionSummary.fusion_watch_count ?? fusionSummary.watch_count ?? 0,
            fusion_avoid_count: fusionSummary.fusion_avoid_count ?? fusionSummary.avoid_count ?? 0,
            agent_rescored: Boolean(fusionSummary.agent_rescored),
            avg_quant_score: fusionSummary.avg_quant_score,
            avg_final_score: fusionSummary.avg_final_score,
            realtime_persisted: Boolean(
              quantSummary.quote_persistence?.persisted ||
                quantSummary.quote_persistence?.latest_trade_date_snapshot_count
            ),
          },
        },
      });
    } catch (error: any) {
      logger.error('获取量化排行榜失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const quantController = new QuantController();
