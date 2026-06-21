import { Request, Response } from 'express';
import { quantRecommendationService } from '../../services/QuantRecommendationService';
import { aiAdvisorService } from '../../services/AIAdvisorService';
import { aiInvestmentSignalService } from '../../services/AIInvestmentSignalService';
import { automatedRecommendationLoopService } from '../../services/AutomatedRecommendationLoopService';
import { recommendationLoopPolicySnapshotService } from '../../services/RecommendationLoopPolicySnapshotService';
import { AISignalSourceType } from '../../models/AIInvestmentSignal';
import { aiPollingQueue } from '../../jobs/aiPollingQueue';
import { buildAIPollingJobOptions } from '../../jobs/aiPollingEnqueue';
import { logger } from '../../utils/logger';

export class QuantRecommendationController {
  listRecommendations = async (req: Request, res: Response) => {
    try {
      const user_id = (req as any).user?.id;
      const {
        universe = 'favorites',
        style = 'balanced',
        limit = '20',
        lookback_days = '120',
      } = req.query;

      const result = await quantRecommendationService.generateRecommendations({
        user_id,
        universe: universe === 'market' ? 'market' : 'favorites',
        style: ['balanced', 'momentum', 'value', 'low_risk'].includes(style as string)
          ? (style as any)
          : 'balanced',
        limit: parseInt(limit as string, 10),
        lookback_days: parseInt(lookback_days as string, 10),
        candidate_pool_limit: req.query?.candidate_pool_limit
          ? parseInt(req.query.candidate_pool_limit as string, 10)
          : undefined,
        exclude_st: req.query?.exclude_st === undefined ? true : req.query.exclude_st !== 'false',
        min_market_cap_yi: req.query?.min_market_cap_yi
          ? Number(req.query.min_market_cap_yi)
          : undefined,
      });

      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('获取量化候选推荐失败:', error);
      res
        .status((error as any)?.statusCode || 500)
        .json({ success: false, message: error.message });
    }
  };

  runStrategyExperiment = async (req: Request, res: Response) => {
    try {
      const user_id = (req as any).user?.id;
      const result = await quantRecommendationService.runStrategyExperiment({
        user_id,
        universe: req.query?.universe === 'favorites' ? 'favorites' : 'market',
        limit: req.query?.limit ? Number(req.query.limit) : 12,
        candidate_pool_limit: req.query?.candidate_pool_limit
          ? Number(req.query.candidate_pool_limit)
          : undefined,
        lookback_days: req.query?.lookback_days ? Number(req.query.lookback_days) : 120,
        min_bars: req.query?.min_bars ? Number(req.query.min_bars) : undefined,
        exclude_st: req.query?.exclude_st === undefined ? true : req.query.exclude_st !== 'false',
        min_market_cap_yi: req.query?.min_market_cap_yi
          ? Number(req.query.min_market_cap_yi)
          : undefined,
      });

      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('运行推荐策略实验失败:', error);
      res
        .status((error as any)?.statusCode || 500)
        .json({ success: false, message: error.message });
    }
  };

  submitToTradingAgents = async (req: Request, res: Response) => {
    try {
      const { symbols, target_date, max_count = 5 } = req.body || {};
      if (!Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).json({ success: false, message: 'symbols 不能为空' });
      }

      // Batch Q (2026-06-17, F4 fix): 显式从 req.user 取 caller 的 username,
      // 让 worker 调 autoBuyFromSignals 时不再 fallback 到 env 'stock' 默认账户.
      // 之前任意登录 user POST 这个 endpoint 就让 'stock' 账户下单 (无 caller 一致性).
      // 同 Batch H runAutomatedLoop 的修复.
      const reqUser = (req as any).user;
      const callerUsername = reqUser?.username || 'stock';

      const limitedSymbols = symbols.slice(0, Math.min(Number(max_count) || 5, 10));
      const submitted: any[] = [];
      const failed: any[] = [];

      for (const item of limitedSymbols) {
        const symbol = typeof item === 'string' ? item : item.symbol;
        const name = typeof item === 'string' ? item : item.name || item.symbol;
        if (!symbol) continue;

        try {
          const result = await aiAdvisorService.analyzeStock(symbol, target_date, true);
          if (result?.task_id) {
            const pollingJobOptions = buildAIPollingJobOptions({ taskId: result.task_id });
            if (!pollingJobOptions) {
              failed.push({ symbol, name, error: 'TradingAgents 返回的 task_id 非法' });
              continue;
            }
            await aiPollingQueue.add(
              {
                taskId: result.task_id,
                symbol,
                name,
                taskLabel: '多因子候选深度研报',
                // Batch Q (2026-06-17, F4): paper_trade_username 锁到 caller 防越权.
                paper_trade_username: callerUsername,
                quant_score: typeof item === 'string' ? undefined : item.score,
                quant_factors: typeof item === 'string' ? undefined : item.factors,
                quant_reasons: typeof item === 'string' ? undefined : item.reasons,
                quant_warnings: typeof item === 'string' ? undefined : item.warnings,
                recommendation_style:
                  typeof item === 'string' ? undefined : item.recommendation_style,
                recommendation_source:
                  typeof item === 'string' ? 'manual_recommendation' : item.source,
              },
              // US-019 / EX-005: jobId/attempts/backoff/retention 统一由 aiPollingEnqueue 单点供给;
              // Bull 内置 Redis Lua dedup (同 jobId EXISTS → return existing jobId), 持久化由 Redis 兜底.
              pollingJobOptions
            );
            submitted.push({ symbol, name, task_id: result.task_id, status: result.status });
          } else {
            failed.push({ symbol, name, error: 'TradingAgents 未返回 task_id' });
          }
        } catch (error: any) {
          failed.push({ symbol, name, error: error.message });
        }
      }

      res.json({ success: true, data: { submitted, failed } });
    } catch (error: any) {
      logger.error('提交多因子候选至 TradingAgents 失败:', error);
      res
        .status((error as any)?.statusCode || 500)
        .json({ success: false, message: error.message });
    }
  };

  archiveRecommendations = async (req: Request, res: Response) => {
    try {
      const user_id = (req as any).user?.id;
      const {
        candidates,
        universe = 'favorites',
        style = 'balanced',
        limit = 20,
        lookback_days = 120,
        signal_date,
        verify = true,
      } = req.body || {};

      const normalizedUniverse = universe === 'market' ? 'market' : 'favorites';
      const normalizedStyle = ['balanced', 'momentum', 'value', 'low_risk'].includes(style)
        ? style
        : 'balanced';

      let payloadCandidates = Array.isArray(candidates) ? candidates : [];
      let as_of = req.body?.as_of;
      let generated: any = null;

      if (payloadCandidates.length === 0) {
        generated = await quantRecommendationService.generateRecommendations({
          user_id,
          universe: normalizedUniverse,
          style: normalizedStyle,
          limit: Number(limit) || 20,
          lookback_days: Number(lookback_days) || 120,
          include_trend: true,
        });
        payloadCandidates = generated.recommendations || [];
        as_of = generated.as_of;
      }

      if (payloadCandidates.length === 0) {
        return res.status(400).json({ success: false, message: '没有可归档的候选推荐' });
      }

      const sync = await aiInvestmentSignalService.archiveQuantRecommendations({
        candidates: payloadCandidates,
        universe: normalizedUniverse,
        style: normalizedStyle,
        as_of,
        signal_date,
      });

      const verification =
        verify === false
          ? null
          : await aiInvestmentSignalService.verifySignals({
              source_type: AISignalSourceType.QUANT_RECOMMENDATION,
              limit: Math.max(sync.total, 20),
            });
      const stats = await aiInvestmentSignalService.getSignalStats({
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
      });

      res.json({
        success: true,
        data: {
          sync,
          verification,
          stats,
          generated: generated
            ? {
                as_of: generated.as_of,
                total_candidates: generated.total_candidates,
                analyzed_candidates: generated.analyzed_candidates,
              }
            : null,
        },
      });
    } catch (error: any) {
      logger.error('归档量化候选信号失败:', error);
      res
        .status((error as any)?.statusCode || 500)
        .json({ success: false, message: error.message });
    }
  };

  getLoopPolicySnapshots = async (req: Request, res: Response) => {
    try {
      const result = await recommendationLoopPolicySnapshotService.getDashboard({
        universe: req.query?.universe as string,
        style: req.query?.style as string,
        username: req.query?.username as string,
        loop_run_id: req.query?.loop_run_id as string,
        start_date: req.query?.start_date as string,
        end_date: req.query?.end_date as string,
        limit: req.query?.limit ? Number(req.query.limit) : 100,
        offset: req.query?.offset ? Number(req.query.offset) : 0,
      });

      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('获取荐股闭环策略快照失败:', error);
      res
        .status((error as any)?.statusCode || 500)
        .json({ success: false, message: error.message });
    }
  };

  refreshLoopPolicySnapshotOutcomes = async (req: Request, res: Response) => {
    try {
      const result = await recommendationLoopPolicySnapshotService.refreshOutcomeMetrics({
        loop_run_id: req.body?.loop_run_id || req.query?.loop_run_id,
        loop_run_ids: Array.isArray(req.body?.loop_run_ids)
          ? req.body.loop_run_ids
          : req.body?.loop_run_ids
          ? String(req.body.loop_run_ids).split(',')
          : undefined,
        lookback_days: req.body?.lookback_days ? Number(req.body.lookback_days) : undefined,
        limit: req.body?.limit ? Number(req.body.limit) : 200,
      });

      res.json({
        success: true,
        data: result,
        message: `策略版本收益刷新完成：更新 ${result.refreshed_count} 个版本`,
      });
    } catch (error: any) {
      logger.error('刷新荐股闭环策略快照收益失败:', error);
      res
        .status((error as any)?.statusCode || 500)
        .json({ success: false, message: error.message });
    }
  };

  runAutomatedLoop = async (req: Request, res: Response) => {
    try {
      // Batch H (2026-06-17, C11): username 必须来自 req.user (jwt 解析的 caller),
      // 不能信任 req.body.username — 之前任何登录 user POST {username:'admin'} 就能
      // 让闭环在 admin 名下运行 + 下单到 admin portfolio. 仅 admin 可以代他人执行
      // (传 body.username override). 同款修复 body.paper_trade_username 如有.
      const reqUser = (req as any).user;
      const isAdmin = reqUser?.role === 'admin';
      const effectiveUsername =
        isAdmin && req.body?.username ? String(req.body.username) : reqUser?.username || 'stock';
      if (!isAdmin && req.body?.username && req.body.username !== reqUser?.username) {
        logger.warn(
          `[runAutomatedLoop] user=${reqUser?.id}(${reqUser?.username}) 非 admin 尝试以 username='${req.body.username}' 运行闭环, 已强制改回自己`
        );
      }
      const result = await automatedRecommendationLoopService.run({
        username: effectiveUsername,
        universe: req.body?.universe === 'favorites' ? 'favorites' : 'market',
        style: ['balanced', 'momentum', 'value', 'low_risk'].includes(req.body?.style)
          ? req.body.style
          : 'balanced',
        candidate_limit: req.body?.candidate_limit ? Number(req.body.candidate_limit) : 30,
        candidate_pool_limit: req.body?.candidate_pool_limit
          ? Number(req.body.candidate_pool_limit)
          : undefined,
        lookback_days: req.body?.lookback_days ? Number(req.body.lookback_days) : 120,
        min_bars: req.body?.min_bars ? Number(req.body.min_bars) : undefined,
        exclude_st: req.body?.exclude_st !== false,
        min_market_cap_yi:
          req.body?.min_market_cap_yi !== undefined ? Number(req.body.min_market_cap_yi) : 30,
        archive_limit: req.body?.archive_limit ? Number(req.body.archive_limit) : undefined,
        verify_signals: req.body?.verify_signals !== false,
        run_paper_trading: req.body?.run_paper_trading === true,
        dry_run: req.body?.dry_run === true,
        paper_trade_limit: req.body?.paper_trade_limit
          ? Number(req.body.paper_trade_limit)
          : undefined,
        paper_trade_scan_limit: req.body?.paper_trade_scan_limit
          ? Number(req.body.paper_trade_scan_limit)
          : undefined,
        min_score: req.body?.min_score ? Number(req.body.min_score) : 72,
        max_positions: req.body?.max_positions ? Number(req.body.max_positions) : undefined,
        default_position_pct: req.body?.default_position_pct
          ? Number(req.body.default_position_pct)
          : undefined,
        max_position_pct: req.body?.max_position_pct
          ? Number(req.body.max_position_pct)
          : undefined,
        min_trade_amount: req.body?.min_trade_amount
          ? Number(req.body.min_trade_amount)
          : undefined,
        use_profit_gate: req.body?.use_profit_gate !== false,
        use_policy_version_feedback: req.body?.use_policy_version_feedback !== false,
        policy_version_lookback_limit: req.body?.policy_version_lookback_limit
          ? Number(req.body.policy_version_lookback_limit)
          : 120,
        use_strategy_experiment_feedback: req.body?.use_strategy_experiment_feedback !== false,
        strategy_experiment_min_quality_delta: req.body?.strategy_experiment_min_quality_delta
          ? Number(req.body.strategy_experiment_min_quality_delta)
          : 4,
        strategy_experiment_limit: req.body?.strategy_experiment_limit
          ? Number(req.body.strategy_experiment_limit)
          : undefined,
        strategy_experiment_pool_limit: req.body?.strategy_experiment_pool_limit
          ? Number(req.body.strategy_experiment_pool_limit)
          : undefined,
        profit_gate_horizon: req.body?.profit_gate_horizon || '5d',
        profit_gate_min_samples: req.body?.profit_gate_min_samples
          ? Number(req.body.profit_gate_min_samples)
          : 5,
        profit_gate_min_quality_score: req.body?.profit_gate_min_quality_score
          ? Number(req.body.profit_gate_min_quality_score)
          : 45,
        submit_agent_analysis: req.body?.submit_agent_analysis !== false,
        agent_max_count: req.body?.agent_max_count ? Number(req.body.agent_max_count) : 5,
        agent_min_score: req.body?.agent_min_score ? Number(req.body.agent_min_score) : 72,
        agent_session: req.body?.agent_session || 'close',
        agent_auto_paper_trade: req.body?.agent_auto_paper_trade !== false,
        agent_only_auto_paper_trade: req.body?.agent_only_auto_paper_trade !== false,
        agent_only_paper_trade_min_score: req.body?.agent_only_paper_trade_min_score
          ? Number(req.body.agent_only_paper_trade_min_score)
          : req.body?.agent_min_score
          ? Number(req.body.agent_min_score)
          : 72,
        agent_only_paper_trade_max_positions: req.body?.agent_only_paper_trade_max_positions
          ? Number(req.body.agent_only_paper_trade_max_positions)
          : 8,
        agent_only_paper_trade_default_position_pct: req.body
          ?.agent_only_paper_trade_default_position_pct
          ? Number(req.body.agent_only_paper_trade_default_position_pct)
          : 4,
        agent_only_paper_trade_max_position_pct: req.body?.agent_only_paper_trade_max_position_pct
          ? Number(req.body.agent_only_paper_trade_max_position_pct)
          : 8,
        agent_only_paper_trade_min_trade_amount: req.body?.agent_only_paper_trade_min_trade_amount
          ? Number(req.body.agent_only_paper_trade_min_trade_amount)
          : req.body?.min_trade_amount
          ? Number(req.body.min_trade_amount)
          : 3000,
        target_date: req.body?.target_date,
        task_label: req.body?.task_label || '手动全市场荐股闭环',
        report_to_feishu: req.body?.report_to_feishu === true,
        record_type: req.body?.record_type || '手动全市场荐股闭环',
        use_entry_risk_guard: req.body?.use_entry_risk_guard !== false,
        max_daily_new_positions: req.body?.max_daily_new_positions
          ? Number(req.body.max_daily_new_positions)
          : 3,
        max_daily_new_exposure_pct: req.body?.max_daily_new_exposure_pct
          ? Number(req.body.max_daily_new_exposure_pct)
          : 12,
        max_total_exposure_pct: req.body?.max_total_exposure_pct
          ? Number(req.body.max_total_exposure_pct)
          : 60,
        max_industry_exposure_pct: req.body?.max_industry_exposure_pct
          ? Number(req.body.max_industry_exposure_pct)
          : 25,
        min_avg_turnover_yuan: req.body?.min_avg_turnover_yuan
          ? Number(req.body.min_avg_turnover_yuan)
          : 30000000,
        cooldown_days_after_loss: req.body?.cooldown_days_after_loss
          ? Number(req.body.cooldown_days_after_loss)
          : 12,
        block_limit_up: req.body?.block_limit_up !== false,
        block_limit_down: req.body?.block_limit_down !== false,
        block_suspended: req.body?.block_suspended !== false,
      });

      res.json({ success: true, data: result, message: '全市场荐股闭环已执行' });
    } catch (error: any) {
      logger.error('执行全市场荐股闭环失败:', error);
      res
        .status((error as any)?.statusCode || 500)
        .json({ success: false, message: error.message });
    }
  };
}

export const quantRecommendationController = new QuantRecommendationController();
