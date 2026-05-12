import { Job } from 'bull';
import { aiPollingQueue, AIPollingJobData } from './aiPollingQueue';
import { aiAdvisorService } from '../services/AIAdvisorService';
import { DailyScreener } from '../models/DailyScreener';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { AKShareClient } from '../data/sources/AKShareClient';
import { notificationService } from '../services/NotificationService';
import { aiInvestmentSignalService } from '../services/AIInvestmentSignalService';
import { AISignalDecision } from '../models/AIInvestmentSignal';
import { feishuTaskReportService } from '../services/FeishuTaskReportService';
import { ScheduledTask } from '../models/ScheduledTask';
import { logger } from '../utils/logger';
import moment from 'moment-timezone';

const akshareClient = new AKShareClient();

const updateLogProgress = async (logId: number | undefined, isSuccess: boolean) => {
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
      const errorMessage = allFailed
        ? 'AI_DAILY_SCREENER 所有候选股分析均失败，请查看关联队列任务失败原因'
        : log.failed_items > 0
        ? `AI_DAILY_SCREENER 部分候选股分析失败：${log.failed_items}/${log.total_items}`
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
        record_type: allFailed ? 'AI定时任务失败' : 'AI定时任务完成',
        task_type: 'AI_DAILY_SCREENER',
        error: allFailed ? new Error(errorMessage || 'AI_DAILY_SCREENER failed') : undefined,
      });
    }
  } catch (error) {
    logger.error(`更新任务日志 ${logId} 失败:`, error);
  }
};

aiPollingQueue.process(async (job: Job<AIPollingJobData>) => {
  const {
    taskId,
    symbol,
    name,
    executionLogId,
    taskLabel,
    quant_score,
    quant_factors,
    quant_reasons,
    quant_warnings,
    recommendation_style,
    recommendation_source,
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
      let currentPrice = null;
      let priceChangePct = null;
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
          recommendation_style,
          recommendation_source,
        },
        current_price: currentPrice,
        price_change_pct: priceChangePct,
      });

      logger.info(`AI 分析任务 ${taskId} 对于股票 ${symbol} 已完成并保存入库 (增量)`);

      try {
        const archivedSignal = await aiInvestmentSignalService.archiveTradingAgentsResult({
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
        });
        await aiInvestmentSignalService.verifySignalReturns(archivedSignal);
      } catch (archiveError: any) {
        logger.warn(`AI 轮询任务结果归档失败 ${taskId}: ${archiveError.message}`);
      }

      await updateLogProgress(executionLogId, true);

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

      return { success: true };
    } else if (status === 'FAILED' || status === 'ERROR') {
      const errorMessage = response.error || 'Unknown error';
      logger.error(
        `AI 分析任务 ${taskId} 对于股票 ${symbol} 失败: ${errorMessage}`
      );
      await updateLogProgress(executionLogId, false);
      // 远端任务已给出终态失败，不需要继续重试轮询；但应让 Bull job 呈现 failed，
      // 这样“队列任务详情”页面不会把实际失败误显示为 completed。
      job.discard();
      throw new Error(`Remote AI task failed: ${errorMessage}`);
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

// 处理最终失败的重试耗尽
aiPollingQueue.on('failed', async (job, err) => {
  if (job && job.attemptsMade >= job.opts.attempts!) {
    logger.error(`AI轮询任务最终失败(重试耗尽) ${job.id}: ${err.message}`);
    await updateLogProgress(job.data.executionLogId, false);
    await feishuTaskReportService.reportAiPollingFailure(job.data, err, job.id);
  }
});
