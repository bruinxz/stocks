import { Job } from 'bull';
import { aiPollingQueue, AIPollingJobData } from './aiPollingQueue';
import { aiAdvisorService } from '../services/AIAdvisorService';
import { DailyScreener } from '../models/DailyScreener';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { AKShareClient } from '../data/sources/AKShareClient';
import { notificationService } from '../services/NotificationService';
import { logger } from '../utils/logger';
import moment from 'moment-timezone';

const akshareClient = new AKShareClient();

const updateLogProgress = async (logId: number | undefined, isSuccess: boolean) => {
  if (!logId) return;
  try {
    const log = await TaskExecutionLog.findByPk(logId);
    if (!log) return;
    
    if (isSuccess) {
      await log.increment('completed_items');
    } else {
      await log.increment('failed_items');
    }
    
    await log.reload();
    
    if (log.completed_items + log.failed_items >= log.total_items) {
      await log.update({
        status: 'COMPLETED',
        completed_at: new Date(),
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
      
      let rating = 'HOLD';
      let summary = '';
      
      // Attempt to parse standard markdown format first
      const ratingMatch = decisionStr.match(/### 1\. \*\*Rating\*\*:\s*([^\n]+)/i);
      if (ratingMatch) rating = ratingMatch[1].trim();
      else {
        // Fallback: Try to parse as JSON if it's a JSON string
        try {
          const jsonObj = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
          if (jsonObj && typeof jsonObj.decision === 'string') {
             rating = jsonObj.decision.toUpperCase();
          } else {
             // Blind fallback, but carefully check word boundaries to avoid matching "BUY" inside a larger word
             if (decisionStr.toUpperCase().includes('STRONG_BUY') || decisionStr.toUpperCase().includes('STRONG BUY')) rating = 'STRONG_BUY';
             else if (decisionStr.toUpperCase().match(/\bBUY\b/)) rating = 'BUY';
             else if (decisionStr.toUpperCase().match(/\bSELL\b/)) rating = 'SELL';
          }
        } catch(e) {
          // Blind fallback if it's not JSON
          if (decisionStr.toUpperCase().includes('STRONG_BUY') || decisionStr.toUpperCase().includes('STRONG BUY')) rating = 'STRONG_BUY';
          else if (decisionStr.toUpperCase().match(/\bBUY\b/)) rating = 'BUY';
          else if (decisionStr.toUpperCase().match(/\bSELL\b/)) rating = 'SELL';
        }
      }
      
      const summaryMatch = decisionStr.match(/### 2\. \*\*Executive Summary\*\*\n([\s\S]*?)(?=### 3\.|\n\n###|$)/i);
      if (summaryMatch) summary = summaryMatch[1].trim();
      else {
        try {
          const jsonObj = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
          if (jsonObj && jsonObj.summary) {
            summary = jsonObj.summary;
          } else {
            summary = decisionStr.substring(0, 200) + '...';
          }
        } catch(e) {
          summary = decisionStr.substring(0, 200) + '...';
        }
      }
      
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
      await updateLogProgress(executionLogId, true);

      // 异步推送微信通知（失败也不影响主流程）
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
        .catch(err => logger.error('推送微信通知失败（不影响主流程）:', err));

      return { success: true };
    } else if (status === 'FAILED' || status === 'ERROR') {
      logger.error(`AI 分析任务 ${taskId} 对于股票 ${symbol} 失败: ${response.error || 'Unknown error'}`);
      await updateLogProgress(executionLogId, false);
      // Return so it doesn't retry
      return { success: false, error: response.error };
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
  }
});
