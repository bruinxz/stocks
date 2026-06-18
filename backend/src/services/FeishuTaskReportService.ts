/**
 * FeishuTaskReportService — STUB (删除多维表格写入)
 *
 * 历史：本服务曾把所有 cron / queue / 风控任务的执行日志写入飞书多维表格
 * (FOT8bXz5daxZQqszBqecrCAKnbc / tblxGh9uXavoj9zR)。
 *
 * 现状：用户决定通知统一走 webhook（机器人卡片），删除多维表格垃圾倾倒。
 * - 17 处 caller 仍然调 `feishuTaskReportService.report*()`，不改 caller 避免大爆炸；
 * - 本文件保留所有方法签名 + 接口类型，body 全部 no-op（debug log + return null）。
 * - FeishuBitableClient.ts 也已删除，env 变量 FEISHU_BITABLE_* 也已从 EnvValidator 清理。
 *
 * 如果以后要恢复某个 report 通道，应该独立改 caller，让它直接调
 * feishuBotWebhookService.sendXxxCard，不要再走多维表格。
 */

import { TaskExecutionLog } from '../models/TaskExecutionLog';
import type { AIPollingJobData } from '../jobs/aiPollingQueue';
import { logger } from '../utils/logger';

// ============================================================================
// Public type interfaces — 不变（callers 依赖这些类型）
// ============================================================================

export interface StockAnalysisReportPayload {
  symbol: string;
  name: string;
  decision: string;
  rationale: string;
  detail?: string;
  score?: number;
  current_price?: number | null;
  price_change_pct?: number | null;
  task_label?: string;
}

export interface RecommendationPerformanceReportPayload {
  record_type?: string;
  source_type?: string;
  agent_session?: string;
  result?: any;
  stats?: any;
  dashboard?: any;
}

export interface SignalQualityDailyReportPayload {
  record_type?: string;
}

export interface PaperTradingPlanReportPayload {
  record_type?: string;
  task_type?: string;
  error?: any;
}

export interface AutomatedRecommendationLoopReportPayload {
  record_type?: string;
  task_type?: string;
  error?: any;
}

type TaskLogLike = TaskExecutionLog | Record<string, any> | null | undefined;

// ============================================================================
// Stub implementation — 所有 report* 方法 no-op
// ============================================================================

class FeishuTaskReportService {
  private logOnce(method: string) {
    // 单次 debug 日志，避免每个 cron tick 刷屏
    logger.debug(`[FeishuTaskReport] ${method} called (bitable disabled, no-op)`);
  }

  async reportStockAnalysis(
    _payload: StockAnalysisReportPayload
  ): Promise<{ success: boolean; message?: string }> {
    this.logOnce('reportStockAnalysis');
    // 返回 success=true 让旧 caller (NotificationService) 不会误报失败
    return { success: true };
  }

  async reportTaskExecutionLog(
    _log: TaskLogLike,
    // 接受任意 options（caller 在 SchedulerService 各 cron 传 record_type / result / error / task_type / 等等）
    _options: Record<string, any> = {}
  ): Promise<null> {
    this.logOnce('reportTaskExecutionLog');
    return null;
  }

  // reportQueueJobCompletion 历史 caller 有 3-arg + 4-arg 两种用法（dataUpdateQueue.on('completed'/'failed')）
  async reportQueueJobCompletion(
    _source: any,
    _job?: any,
    _result?: any,
    _error?: any
  ): Promise<null> {
    this.logOnce('reportQueueJobCompletion');
    return null;
  }

  async reportAiPollingFailure(
    _jobData: AIPollingJobData,
    _error: any,
    _jobId?: string | number
  ): Promise<null> {
    this.logOnce('reportAiPollingFailure');
    return null;
  }

  async reportRecommendationPerformance(
    _payload: RecommendationPerformanceReportPayload
  ): Promise<null> {
    this.logOnce('reportRecommendationPerformance');
    return null;
  }

  async reportSignalQualityDaily(
    _report: any,
    _options: SignalQualityDailyReportPayload = {}
  ): Promise<null> {
    this.logOnce('reportSignalQualityDaily');
    return null;
  }

  async reportAutomatedRecommendationLoop(
    _result: any,
    _options: AutomatedRecommendationLoopReportPayload = {}
  ): Promise<null> {
    this.logOnce('reportAutomatedRecommendationLoop');
    return null;
  }

  async reportSignalVerificationRepair(
    _result: any,
    _options: { record_type?: string } = {}
  ): Promise<null> {
    this.logOnce('reportSignalVerificationRepair');
    return null;
  }

  async reportQuantDailyPipeline(
    _result: any,
    _options: { task_type?: string; record_type?: string; error?: any } = {}
  ): Promise<null> {
    this.logOnce('reportQuantDailyPipeline');
    return null;
  }

  async reportQuantOpenWatchdog(
    _result: any,
    _options: { task_type?: string; record_type?: string; error?: any } = {}
  ): Promise<null> {
    this.logOnce('reportQuantOpenWatchdog');
    return null;
  }

  async reportPaperTradingAutomation(
    _result: any,
    _options: { task_type?: string; record_type?: string; error?: any } = {}
  ): Promise<null> {
    this.logOnce('reportPaperTradingAutomation');
    return null;
  }

  async reportPaperTradingRiskCheck(
    _result: any,
    _options: { task_type?: string; record_type?: string; error?: any } = {}
  ): Promise<null> {
    this.logOnce('reportPaperTradingRiskCheck');
    return null;
  }

  async reportPaperTradingAttribution(
    _result: any,
    _options: { task_type?: string; record_type?: string; error?: any } = {}
  ): Promise<null> {
    this.logOnce('reportPaperTradingAttribution');
    return null;
  }

  async reportRecommendationTradeOutcomes(
    _result: any,
    _options: { record_type?: string; task_type?: string; error?: any } = {}
  ): Promise<null> {
    this.logOnce('reportRecommendationTradeOutcomes');
    return null;
  }

  async reportPaperTradingPlan(
    _result: any,
    _options: PaperTradingPlanReportPayload = {}
  ): Promise<null> {
    this.logOnce('reportPaperTradingPlan');
    return null;
  }
}

export const feishuTaskReportService = new FeishuTaskReportService();
