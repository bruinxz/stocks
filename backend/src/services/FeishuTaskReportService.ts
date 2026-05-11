import type { Job } from 'bull';
import moment from 'moment-timezone';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import type { DataUpdateJobData } from '../jobs/dataUpdateQueue';
import type { AIPollingJobData } from '../jobs/aiPollingQueue';
import { logger } from '../utils/logger';
import { feishuBitableClient } from './FeishuBitableClient';

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

type TaskLogLike = TaskExecutionLog | Record<string, any> | null | undefined;

class FeishuTaskReportService {
  async reportStockAnalysis(payload: StockAnalysisReportPayload) {
    return this.safeAppend({
      文本: `AI分析结果 - ${payload.name}(${payload.symbol}) - ${payload.decision}`,
      记录类型: 'AI分析结果',
      任务名称: payload.task_label || 'AI 每日优选评估',
      任务类型: 'AI_DAILY_SCREENER',
      运行状态: 'COMPLETED',
      股票代码: payload.symbol,
      股票名称: payload.name,
      投资评级: payload.decision,
      评分: payload.score != null ? Number(payload.score).toFixed(2) : '',
      最新价: payload.current_price != null ? String(payload.current_price) : '',
      涨跌幅:
        payload.price_change_pct != null ? `${Number(payload.price_change_pct).toFixed(2)}%` : '',
      核心理由: this.safeText(payload.rationale, 5000),
      详情: this.safeText(payload.detail || '', 10000),
      创建时间: this.formatDate(new Date()),
    });
  }

  async reportTaskExecutionLog(
    logLike: TaskLogLike,
    options: {
      record_type?: string;
      task_type?: string;
      queue_name?: string;
      queue_job_id?: string | number;
      queue_job_name?: string;
      queue_state?: string;
      queue_progress?: any;
      result?: any;
      error?: any;
    } = {}
  ) {
    const log = this.normalizeLog(logLike);
    const recordType = options.record_type || '定时任务完成';
    return this.safeAppend({
      文本: `${recordType} - ${log?.task_name || options.queue_job_name || '未知任务'} - ${
        log?.status || options.queue_state || ''
      }`,
      记录类型: recordType,
      任务日志ID: log?.id,
      任务ID: log?.task_id,
      任务名称: log?.task_name,
      任务类型: options.task_type || '',
      运行状态: log?.status,
      开始时间: this.formatDate(log?.started_at),
      完成时间: this.formatDate(log?.completed_at || new Date()),
      总数: log?.total_items,
      完成数: log?.completed_items,
      失败数: log?.failed_items,
      队列名称: options.queue_name,
      队列任务ID: options.queue_job_id,
      队列任务名称: options.queue_job_name,
      队列状态: options.queue_state,
      队列进度: this.safeJson(options.queue_progress, 1000),
      结果摘要: this.safeJson(options.result, 10000),
      错误信息: this.errorMessage(options.error || log?.error_message),
      创建时间: this.formatDate(new Date()),
    });
  }

  async reportQueueJobCompletion(
    queueName: string,
    job: Job<DataUpdateJobData>,
    result?: any,
    error?: any
  ) {
    const executionLogId = Number(job?.data?.execution_log_id);
    const log = executionLogId ? await TaskExecutionLog.findByPk(executionLogId) : null;
    let queueState = error ? 'failed' : 'completed';

    try {
      queueState = await job.getState();
    } catch (stateError) {
      logger.warn(`获取飞书上报队列状态失败 ${job?.id}:`, stateError);
    }

    return this.reportTaskExecutionLog(log, {
      record_type: error ? '队列任务失败' : '队列任务完成',
      task_type: job?.data?.type,
      queue_name: queueName,
      queue_job_id: job?.id,
      queue_job_name: job?.name,
      queue_state: queueState,
      queue_progress: typeof job?.progress === 'function' ? job.progress() : undefined,
      result: {
        job_data: job?.data,
        return_value: result,
        data_update_log_id: result?.logId || result?.log_id,
      },
      error,
    });
  }

  async reportAiPollingFailure(jobData: AIPollingJobData, error: any, jobId?: string | number) {
    return this.safeAppend({
      文本: `AI轮询失败 - ${jobData?.name || jobData?.symbol || '未知股票'}`,
      记录类型: 'AI轮询失败',
      任务名称: jobData?.taskLabel || 'AI 每日优选评估',
      任务类型: 'AI_DAILY_SCREENER',
      运行状态: 'FAILED',
      任务日志ID: jobData?.executionLogId,
      队列名称: 'ai_polling',
      队列任务ID: jobId,
      股票代码: jobData?.symbol,
      股票名称: jobData?.name,
      错误信息: this.errorMessage(error),
      创建时间: this.formatDate(new Date()),
    });
  }

  private async safeAppend(fields: Record<string, any>) {
    try {
      const result = await feishuBitableClient.createRecord(fields);
      if (result.success) {
        logger.info('飞书多维表格写入成功');
      } else if (result.skipped) {
        logger.warn(`飞书多维表格写入跳过: ${result.message}`);
      } else {
        logger.error(`飞书多维表格写入失败: ${result.message}`);
      }
      return result;
    } catch (error: any) {
      logger.error('飞书多维表格写入异常:', error?.message || error);
      return { success: false, message: error?.message || '写入异常' };
    }
  }

  private normalizeLog(logLike: TaskLogLike): any {
    if (!logLike) return null;
    if (typeof (logLike as any).toJSON === 'function') return (logLike as any).toJSON();
    return logLike;
  }

  private formatDate(value?: Date | string | number | null): string {
    if (!value) return '';
    return moment(value).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
  }

  private safeText(value: any, maxLength: number): string {
    if (value === undefined || value === null) return '';
    const text = typeof value === 'string' ? value : this.safeJson(value, maxLength);
    return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
  }

  private safeJson(value: any, maxLength: number): string {
    if (value === undefined || value === null || value === '') return '';
    let text = '';
    if (typeof value === 'string') {
      text = value;
    } else {
      try {
        text = JSON.stringify(value, null, 2);
      } catch (error) {
        text = String(value);
      }
    }
    return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
  }

  private errorMessage(error: any): string {
    if (!error) return '';
    if (typeof error === 'string') return this.safeText(error, 5000);
    return this.safeText(error?.message || error, 5000);
  }
}

export const feishuTaskReportService = new FeishuTaskReportService();
