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
      const createResult = await quantStrategyParamVersionService.createPendingValidationsFromSignals(
        {
          trade_date: req.body?.trade_date || req.body?.tradeDate,
          start_date: req.body?.start_date || req.body?.startDate,
          end_date: req.body?.end_date || req.body?.endDate,
          strategy_keys: req.body?.strategy_keys || req.body?.strategyKeys,
          horizons: req.body?.horizons,
          limit: Number(req.body?.limit || 500),
          signal: req.body?.signal,
        }
      );
      const refreshResult = await quantStrategyParamVersionService.refreshValidationReturns({
        limit: Number(req.body?.refresh_limit || req.body?.refreshLimit || 1000),
        include_completed: Boolean(req.body?.include_completed || req.body?.includeCompleted),
        auto_sync_benchmark: Boolean(req.body?.auto_sync_benchmark || req.body?.autoSyncBenchmark),
      });
      res.json({ success: true, data: { create: createResult, refresh: refreshResult } });
    } catch (error: any) {
      logger.error('刷新量化策略参数收益验证失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async createBacktest(req: AuthenticatedRequest, res: Response) {
    try {
      const asyncMode = req.body?.async !== false && req.body?.async_mode !== false;
      const result = await quantBacktestService.createBacktestTask(
        req.body,
        req.user?.id,
        asyncMode
      );
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('运行量化跑分失败:', error);
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

  async generateSignals(req: AuthenticatedRequest, res: Response) {
    try {
      const result = await quantSignalService.generateSignals({
        ...req.body,
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
      const result = await quantFusionService.runDailyPipeline({
        ...req.body,
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
      res.json({
        success: true,
        data: {
          generated_at: new Date().toISOString(),
          trade_date: quantDashboard.trade_date,
          signal_date: fusionDashboard.signal_date,
          quant_rankings: quantDashboard.quant_rankings,
          fusion_rankings: fusionDashboard.fusion_rankings,
          summary: {
            ...(quantDashboard.summary || {}),
            ...(fusionDashboard.summary || {}),
            realtime_persisted: Boolean(
              quantDashboard.summary?.quote_persistence?.persisted ||
              quantDashboard.summary?.quote_persistence?.latest_trade_date_snapshot_count
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
