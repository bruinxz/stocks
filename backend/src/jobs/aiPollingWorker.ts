import { Job } from 'bull';
import { aiPollingQueue, AIPollingJobData } from './aiPollingQueue';
import { aiAdvisorService, normalizeTradingAgentsError } from '../services/AIAdvisorService';
import { DailyScreener } from '../models/DailyScreener';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { AKShareClient } from '../data/sources/AKShareClient';
import { notificationService } from '../services/NotificationService';
import {
  aiInvestmentSignalService,
  inferAgentSession,
} from '../services/AIInvestmentSignalService';
import { AISignalDecision } from '../models/AIInvestmentSignal';
import { feishuTaskReportService } from '../services/FeishuTaskReportService';
import { ScheduledTask } from '../models/ScheduledTask';
import { logger } from '../utils/logger';
import moment from 'moment-timezone';
import { paperTradingAutomationService } from '../services/PaperTradingAutomationService';
import { RecommendationLoopPolicySnapshot } from '../models/RecommendationLoopPolicySnapshot';
import { quantFusionAuditService } from '../quant/services/QuantFusionAuditService';

const akshareClient = new AKShareClient();
const aiPollingWorkerDisabled =
  String(process.env.DISABLE_QUEUE_WORKERS || '').toLowerCase() === 'true' ||
  String(process.env.DISABLE_AI_POLLING_WORKER || '').toLowerCase() === 'true';

const updateLogProgress = async (
  logId: number | undefined,
  isSuccess: boolean,
  schedulerTaskType = 'AI_DAILY_SCREENER'
) => {
  if (!logId) return;
  try {
    const log = await TaskExecutionLog.findByPk(logId);
    if (!log) return;

    if (log.status !== 'IN_PROGRESS') {
      logger.info(`AI 任务日志 ${logId} 已结束(${log.status})，跳过重复进度更新`);
      return;
    }

    if (isSuccess) {
      await log.increment('completed_items');
    } else {
      await log.increment('failed_items');
    }

    await log.reload();

    if (log.completed_items + log.failed_items >= log.total_items) {
      const allFailed = Number(log.total_items) > 0 && Number(log.completed_items) === 0;
      const finalStatus = allFailed ? 'FAILED' : 'COMPLETED';
      const taskLabel =
        schedulerTaskType === 'QUANT_DAILY_PIPELINE' ? '量化策略Agent复核' : 'AI_DAILY_SCREENER';
      const errorMessage = allFailed
        ? `${taskLabel} 所有候选股分析均失败，请查看关联队列任务失败原因`
        : log.failed_items > 0
        ? `${taskLabel} 部分候选股分析失败：${log.failed_items}/${log.total_items}`
        : null;

      await log.update({
        status: finalStatus,
        completed_at: new Date(),
        error_message: errorMessage,
      });

      await ScheduledTask.update(
        { last_run_status: allFailed ? 'FAILED' : 'SUCCESS' },
        { where: { id: log.task_id } }
      );

      await feishuTaskReportService.reportTaskExecutionLog(log, {
        record_type:
          schedulerTaskType === 'QUANT_DAILY_PIPELINE'
            ? allFailed
              ? '量化策略Agent复核失败'
              : '量化策略Agent复核完成'
            : allFailed
            ? 'AI定时任务失败'
            : 'AI定时任务完成',
        task_type: schedulerTaskType,
        error: allFailed ? new Error(errorMessage || `${schedulerTaskType} failed`) : undefined,
      });
    }
  } catch (error) {
    logger.error(`更新任务日志 ${logId} 失败:`, error);
  }
};

if (aiPollingWorkerDisabled) {
  logger.info('AI 分析轮询队列处理器已按环境变量禁用');
} else {
  aiPollingQueue.process(async (job: Job<AIPollingJobData>) => {
  const {
    taskId,
    symbol,
    name,
    executionLogId,
    scheduler_task_type,
    loopRunId,
    loopPolicySnapshotId,
    taskLabel,
    quant_score,
    quant_factors,
    quant_reasons,
    quant_warnings,
    recommendation_style,
    recommendation_source,
    strategy_key,
    strategy_variant,
    market_environment,
    environment_policy,
    environment_policy_snapshot_id,
    agent_session,
    current_price: submitted_current_price,
    price_change_pct: submitted_price_change_pct,
    data_quality_score: submitted_data_quality_score,
    data_quality_bucket: submitted_data_quality_bucket,
    data_quality: submitted_data_quality,
    auto_paper_trade,
    paper_trade_username,
    paper_trade_portfolio_name,
    paper_trade_initial_capital,
    paper_trade_force_new_portfolio,
    paper_trade_min_score,
    paper_trade_max_positions,
    paper_trade_default_position_pct,
    paper_trade_max_position_pct,
    paper_trade_min_trade_amount,
    paper_trade_risk_profile_gate,
    strategy_allocation_policy,
    strategy_allocation_pct,
    strategy_max_single_trade_pct,
    quant_agent_fusion,
  } = job.data;

  try {
    const response = await aiAdvisorService.getTaskStatus(taskId);
    const status = response.status?.toUpperCase();

    if (status === 'COMPLETED') {
      let decisionStr = response.data || '';

      // 如果大模型接口返回的 data 字段不是纯字符串，而是 JSON 对象或数组，强制将其序列化为字符串，防止 .match() 方法报错
      if (typeof decisionStr !== 'string') {
        decisionStr = JSON.stringify(decisionStr, null, 2);
      }

      const structured = aiInvestmentSignalService.parseTradingAgentsDecision(
        decisionStr,
        response.data
      );
      const normalizedDecision = structured.normalized_decision || AISignalDecision.UNKNOWN;
      const rating = normalizedDecision.toUpperCase();
      const summary =
        structured.summary ||
        (typeof response.data === 'object' && response.data?.rationale
          ? String(response.data.rationale)
          : '') ||
        decisionStr.substring(0, 1200);

      let score = 50;
      if (rating.toUpperCase().includes('STRONG_BUY')) score = 90;
      else if (rating.toUpperCase().includes('BUY')) score = 75;
      else if (rating.toUpperCase().includes('SELL')) score = 30;

      // 如果该任务来自本地多因子候选池，则把量化初筛分与 TradingAgents 决策做融合，
      // 既保留智能体最终评级，也避免每日优选排序完全依赖 LLM 文本关键字。
      if (typeof quant_score === 'number' && Number.isFinite(quant_score)) {
        score = Math.round((score * 0.65 + quant_score * 0.35) * 100) / 100;
      }

      const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');

      // Fetch real-time price
      let currentPrice = submitted_current_price ?? null;
      let priceChangePct = submitted_price_change_pct ?? null;
      try {
        const quotes = await akshareClient.getRealtimeQuotes(symbol);
        if (quotes && quotes[symbol]) {
          currentPrice = quotes[symbol].current_price;
          priceChangePct = quotes[symbol].change_percent;
        }
      } catch (err) {
        logger.warn(`Failed to fetch real-time quote for ${symbol} when saving screener:`, err);
      }

      // Always create a new record (append) instead of updating existing ones for the same day
      const agentSession = agent_session || inferAgentSession(taskLabel, new Date());
      await DailyScreener.create({
        date: today,
        symbol,
        name,
        decision: rating,
        rationale: summary,
        detail: decisionStr,
        score,
        scores: {
          quant_score,
          quant_factors: quant_factors || [],
          quant_reasons: quant_reasons || [],
          quant_warnings: quant_warnings || [],
          quant_data_quality: submitted_data_quality,
          quant_data_quality_score: submitted_data_quality_score,
          quant_data_quality_bucket: submitted_data_quality_bucket,
          recommendation_style,
          recommendation_source,
          strategy_key,
          strategy_variant,
          market_environment,
          task_label: taskLabel,
          scheduler_task_type,
          agent_session: agentSession,
          loop_run_id: loopRunId,
          loop_policy_snapshot_id: loopPolicySnapshotId,
        },
        current_price: currentPrice,
        price_change_pct: priceChangePct,
      });

      logger.info(`AI 分析任务 ${taskId} 对于股票 ${symbol} 已完成并保存入库 (增量)`);

      let archivedSignal: any = null;
      let resolvedPolicySnapshotId: number | undefined;
      try {
        resolvedPolicySnapshotId =
          loopPolicySnapshotId ||
          (loopRunId
            ? (
                await RecommendationLoopPolicySnapshot.findOne({
                  where: { loop_run_id: loopRunId },
                  order: [['generated_at', 'DESC']],
                })
              )?.id
            : undefined);
        archivedSignal = await aiInvestmentSignalService.archiveTradingAgentsResult({
          task_id: taskId,
          symbol,
          signal_date: response.target_date || today,
          decision: rating,
          rationale: summary,
          detail: response.data,
          confidence_score: score,
          current_price: currentPrice || undefined,
          price_change_pct: priceChangePct || undefined,
          source_type: 'tradingagents',
          task_label: taskLabel,
          agent_session: agentSession,
          loop_run_id: loopRunId,
          loop_policy_snapshot_id: resolvedPolicySnapshotId,
          strategy_key,
          strategy_variant: {
            ...(strategy_variant || {}),
            environment_policy,
            environment_policy_snapshot_id,
            quant_agent_fusion: Boolean(
              quant_agent_fusion || scheduler_task_type === 'QUANT_DAILY_PIPELINE'
            ),
          },
          market_environment: market_environment || strategy_variant?.market_environment,
        });
        if (archivedSignal) {
          await archivedSignal.update({
            metadata: {
              ...(archivedSignal.metadata || {}),
              quant_data_quality: submitted_data_quality,
              quant_data_quality_score: submitted_data_quality_score,
              quant_data_quality_bucket: submitted_data_quality_bucket,
              strategy_key,
              strategy_variant: {
                ...(strategy_variant || {}),
                quant_agent_fusion: Boolean(
                  quant_agent_fusion || scheduler_task_type === 'QUANT_DAILY_PIPELINE'
                ),
              },
              strategy_allocation_policy,
              strategy_allocation_pct,
              strategy_max_single_trade_pct,
              quant_framework_signal: Boolean(scheduler_task_type === 'QUANT_DAILY_PIPELINE'),
              quant_agent_fusion: Boolean(
                quant_agent_fusion || scheduler_task_type === 'QUANT_DAILY_PIPELINE'
              ),
              environment_policy,
              environment_policy_snapshot_id,
              market_environment,
            },
          });
        }
        await aiInvestmentSignalService.verifySignalReturns(archivedSignal);
      } catch (archiveError: any) {
        logger.warn(`AI 轮询任务结果归档失败 ${taskId}: ${archiveError.message}`);
      }

      let paperTradingResult: any = null;
      let fusionAudit: any = null;
      if (archivedSignal && scheduler_task_type === 'QUANT_DAILY_PIPELINE') {
        try {
          fusionAudit = await quantFusionAuditService.recordAgentFusion(archivedSignal, {
            task_id: taskId,
            quant_score,
            strategy_key,
            strategy_variant,
            current_price: currentPrice,
          });
          await archivedSignal.update({
            metadata: {
              ...(archivedSignal.metadata || {}),
              quant_fusion_audit_id: fusionAudit.id,
              quant_fusion_final_score: fusionAudit.final_score,
              quant_fusion_final_decision: fusionAudit.final_decision,
              quant_fusion_rationale: fusionAudit.rationale,
              quant_framework_signal: true,
              quant_agent_fusion: true,
            },
          });
        } catch (auditError: any) {
          logger.warn(`量化-Agent 融合审计写入失败 ${taskId}: ${auditError.message}`);
        }
      }

      if (
        auto_paper_trade &&
        archivedSignal &&
        [AISignalDecision.BUY, AISignalDecision.STRONG_BUY].includes(
          archivedSignal.normalized_decision as any
        ) &&
        Number(archivedSignal.confidence_score || 0) >= Number(paper_trade_min_score || 72)
      ) {
        try {
          paperTradingResult = await paperTradingAutomationService.autoBuyFromSignals({
            username: paper_trade_username,
            portfolio_name: paper_trade_portfolio_name,
            initial_capital: paper_trade_initial_capital,
            force_new_portfolio: paper_trade_force_new_portfolio,
            source_type: 'tradingagents',
            agent_session: agentSession,
            signal_ids: [archivedSignal.id],
            limit: 1,
            scan_limit: 1,
            min_score: Number(paper_trade_min_score || 72),
            max_positions: Number(paper_trade_max_positions || 8),
            default_position_pct: Number(paper_trade_default_position_pct || 4),
            max_position_pct: Number(paper_trade_max_position_pct || 8),
            min_trade_amount: Number(paper_trade_min_trade_amount || 3000),
            risk_profile_gate: paper_trade_risk_profile_gate,
            allowed_risk_levels: ['low', 'medium'],
            require_action_buy: false,
            ignore_profit_gate_for_forced_signals: true,
            use_attribution_feedback: true,
            use_profit_gate: true,
            profit_gate_allow_sampling: true,
            use_outcome_feedback: true,
            external_environment_policy: environment_policy,
            environment_policy_snapshot_id,
            loop_policy_snapshot_id: resolvedPolicySnapshotId,
            dry_run: false,
            report_to_feishu: true,
          });
          logger.info(
            `TradingAgents 结果自动进入模拟盘完成 ${symbol}: 成交 ${paperTradingResult.executed}，跳过 ${paperTradingResult.skipped}`
          );
        } catch (tradeError: any) {
          logger.warn(`TradingAgents 结果自动进入模拟盘失败 ${symbol}: ${tradeError.message}`);
        }
      }

      await updateLogProgress(executionLogId, true, scheduler_task_type);

      // 异步写入飞书多维表格（失败也不影响主流程）
      notificationService
        .notifyStockAnalysis({
          symbol,
          name,
          decision: rating,
          rationale: summary,
          detail: decisionStr,
          score,
          current_price: currentPrice,
          price_change_pct: priceChangePct,
          task_label: taskLabel,
        })
        .catch(err => logger.error('写入飞书 AI 分析结果失败（不影响主流程）:', err));

      return {
        success: true,
        signal_id: archivedSignal?.id,
        quant_fusion_audit_id: fusionAudit?.id,
        quant_fusion_final_score: fusionAudit?.final_score,
        quant_fusion_final_decision: fusionAudit?.final_decision,
        auto_paper_trade: Boolean(auto_paper_trade),
        paper_trading: paperTradingResult
          ? {
              portfolio_id: paperTradingResult.portfolio_id,
              executed: paperTradingResult.executed,
              planned: paperTradingResult.planned,
              skipped: paperTradingResult.skipped,
              trades: paperTradingResult.trades,
            }
          : undefined,
      };
    } else if (status === 'FAILED' || status === 'ERROR') {
      const errorMessage = normalizeTradingAgentsError(response.error || 'Unknown error');
      logger.error(`AI 分析任务 ${taskId} 对于股票 ${symbol} 失败: ${errorMessage}`);
      await updateLogProgress(executionLogId, false, scheduler_task_type);
      // 远端任务已给出终态失败，不需要继续重试轮询；但应让 Bull job 呈现 failed，
      // 这样“队列任务详情”页面不会把实际失败误显示为 completed。
      job.discard();
      throw new Error(`TradingAgents 远端任务失败: ${errorMessage}`);
    } else {
      logger.info(`AI 分析任务 ${taskId} 对于股票 ${symbol} 仍在进行中，等待下次轮询...`);
      throw new Error('Task is still processing, need retry');
    }
  } catch (error: any) {
    if (error.message === 'Task is still processing, need retry') {
      throw error;
    }
    logger.error(`Error polling AI task ${taskId}:`, error);
    throw error;
  }
  });
}

// 处理最终失败的重试耗尽
aiPollingQueue.on('failed', async (job, err) => {
  if (job && job.attemptsMade >= job.opts.attempts!) {
    logger.error(`AI轮询任务最终失败(重试耗尽) ${job.id}: ${err.message}`);
    await updateLogProgress(job.data.executionLogId, false, job.data.scheduler_task_type);
    await feishuTaskReportService.reportAiPollingFailure(job.data, err, job.id);
  }
});
