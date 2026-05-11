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

export interface RecommendationPerformanceReportPayload {
  record_type?: string;
  source_type?: string;
  result?: any;
  stats?: any;
  dashboard?: any;
}

type TaskLogLike = TaskExecutionLog | Record<string, any> | null | undefined;

class FeishuTaskReportService {
  async reportStockAnalysis(payload: StockAnalysisReportPayload) {
    const markdownMessage = [
      `## AI分析结果：${payload.name || payload.symbol}（${payload.symbol}）`,
      '',
      `- **投资评级**：${payload.decision || 'UNKNOWN'}`,
      payload.score != null ? `- **综合评分**：${Number(payload.score).toFixed(2)}` : '',
      payload.current_price != null ? `- **最新价**：${payload.current_price}` : '',
      payload.price_change_pct != null
        ? `- **涨跌幅**：${Number(payload.price_change_pct).toFixed(2)}%`
        : '',
      payload.task_label ? `- **任务来源**：${payload.task_label}` : '',
      '',
      '### 核心理由',
      this.safeText(payload.rationale || '暂无核心理由', 3000),
    ]
      .filter(Boolean)
      .join('\n');

    return this.safeAppend({
      文本: `AI分析结果 - ${payload.name}(${payload.symbol}) - ${payload.decision}`,
      message: markdownMessage,
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
    const markdownMessage = this.buildTaskMarkdownMessage(log, options, recordType);
    return this.safeAppend({
      文本: `${recordType} - ${log?.task_name || options.queue_job_name || '未知任务'} - ${
        log?.status || options.queue_state || ''
      }`,
      message: markdownMessage,
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
    const markdownMessage = [
      `## AI轮询失败：${jobData?.name || jobData?.symbol || '未知股票'}`,
      '',
      `- **股票代码**：${jobData?.symbol || '-'}`,
      `- **股票名称**：${jobData?.name || '-'}`,
      `- **任务名称**：${jobData?.taskLabel || 'AI 每日优选评估'}`,
      jobId ? `- **队列任务ID**：${jobId}` : '',
      '',
      '### 错误信息',
      this.errorMessage(error) || '-',
    ]
      .filter(Boolean)
      .join('\n');

    return this.safeAppend({
      文本: `AI轮询失败 - ${jobData?.name || jobData?.symbol || '未知股票'}`,
      message: markdownMessage,
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

  async reportRecommendationPerformance(payload: RecommendationPerformanceReportPayload) {
    const dashboard = payload.dashboard || {};
    const stats = payload.stats || {};
    const overview = dashboard.overview || {};
    const horizonSummary = dashboard.horizon_summary || [];
    const result = payload.result || {};
    const targetHorizon =
      overview.horizon ||
      (Array.isArray(horizonSummary)
        ? horizonSummary.find((item: any) => item.horizon === '5d')?.horizon
        : '') ||
      '5d';
    const targetStats = Array.isArray(horizonSummary)
      ? horizonSummary.find((item: any) => item.horizon === targetHorizon) || horizonSummary[0]
      : stats.horizon_summary?.[targetHorizon] || {};
    const bestSymbol = Array.isArray(dashboard.top_symbols) ? dashboard.top_symbols[0] : null;
    const markdownMessage = [
      `## ${payload.record_type || '推荐绩效刷新'}`,
      '',
      `- **信号来源**：${payload.source_type || dashboard.filters?.source_type || 'all'}`,
      `- **绩效周期**：${targetHorizon}`,
      `- **信号总数**：${overview.total_signals ?? stats.total_signals ?? '-'}`,
      `- **完成样本**：${overview.completed_samples ?? targetStats?.count ?? '-'}`,
      `- **待验证信号**：${overview.pending_signals ?? '-'}`,
      `- **无数据信号**：${overview.no_data_signals ?? result.no_data ?? '-'}`,
      '',
      '### 核心收益',
      `- **平均收益**：${
        this.formatPercent(targetStats?.avg_return_pct ?? overview.avg_return_pct) || '-'
      }`,
      `- **中位收益**：${
        this.formatPercent(targetStats?.median_return_pct ?? overview.median_return_pct) || '-'
      }`,
      `- **胜率**：${
        this.formatPercent(targetStats?.positive_rate ?? overview.positive_rate) || '-'
      }`,
      `- **方向成功率**：${
        this.formatPercent(
          targetStats?.directional_success_rate ?? overview.directional_success_rate
        ) || '-'
      }`,
      bestSymbol
        ? `\n### 最佳标的\n- ${bestSymbol.name || bestSymbol.symbol}（${bestSymbol.symbol}）：${
            bestSymbol.avg_return_pct
          }%`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    return this.safeAppend({
      文本: `${payload.record_type || '推荐绩效刷新'} - ${targetHorizon} 胜率 ${
        targetStats?.positive_rate ?? overview.positive_rate ?? '--'
      }% / 均收 ${targetStats?.avg_return_pct ?? overview.avg_return_pct ?? '--'}%`,
      message: markdownMessage,
      记录类型: payload.record_type || '推荐绩效刷新',
      任务名称: '推荐后验绩效追踪',
      任务类型: 'SIGNAL_PERFORMANCE_REFRESH',
      运行状态: 'COMPLETED',
      信号来源: payload.source_type || dashboard.filters?.source_type || 'all',
      绩效周期: targetHorizon,
      信号总数: overview.total_signals ?? stats.total_signals,
      完成样本: overview.completed_samples ?? targetStats?.count,
      待验证信号: overview.pending_signals,
      无数据信号: overview.no_data_signals ?? result.no_data,
      平均收益: this.formatPercent(targetStats?.avg_return_pct ?? overview.avg_return_pct),
      中位收益: this.formatPercent(targetStats?.median_return_pct ?? overview.median_return_pct),
      胜率: this.formatPercent(targetStats?.positive_rate ?? overview.positive_rate),
      方向成功率: this.formatPercent(
        targetStats?.directional_success_rate ?? overview.directional_success_rate
      ),
      盈亏比: targetStats?.payoff_ratio ?? overview.payoff_ratio,
      ProfitFactor: targetStats?.profit_factor ?? overview.profit_factor,
      平均MFE: this.formatPercent(targetStats?.avg_mfe_pct ?? overview.avg_mfe_pct),
      平均MAE: this.formatPercent(targetStats?.avg_mae_pct ?? overview.avg_mae_pct),
      最佳标的: bestSymbol
        ? `${bestSymbol.name || bestSymbol.symbol}(${bestSymbol.symbol}) ${
            bestSymbol.avg_return_pct
          }%`
        : '',
      结果摘要: this.safeJson(
        {
          result,
          overview,
          horizon_summary: horizonSummary,
          top_symbols: Array.isArray(dashboard.top_symbols)
            ? dashboard.top_symbols.slice(0, 5)
            : undefined,
        },
        10000
      ),
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

  private buildTaskMarkdownMessage(log: any, options: any, recordType: string): string {
    const result = options.result || {};
    const returnValue = result.return_value || result;
    const jobData = result.job_data || {};
    const status = log?.status || options.queue_state || (options.error ? 'FAILED' : 'COMPLETED');
    const taskName = log?.task_name || options.queue_job_name || jobData.type || '未知任务';
    const taskType = options.task_type || jobData.type || '';
    const total = this.firstDefined(
      log?.total_items,
      returnValue?.totalStocks,
      returnValue?.total,
      returnValue?.affected_stocks
    );
    const completed = this.firstDefined(
      log?.completed_items,
      returnValue?.successfulSyncs !== undefined
        ? Number(returnValue.successfulSyncs) + Number(returnValue.skippedSyncs || 0)
        : undefined,
      returnValue?.completed
    );
    const failed = this.firstDefined(
      log?.failed_items,
      returnValue?.failedSyncs,
      returnValue?.failed
    );
    const inserted = this.firstDefined(
      returnValue?.totalRecordsInserted,
      returnValue?.inserted_records,
      returnValue?.totalInserted
    );
    const affected = this.firstDefined(returnValue?.affected_stocks, returnValue?.affectedStocks);
    const skipped = this.firstDefined(
      returnValue?.skippedSyncs,
      returnValue?.skipped ? 1 : undefined
    );
    const dataUpdateLogId = returnValue?.logId || returnValue?.log_id || result?.data_update_log_id;
    const isSkipped = Boolean(returnValue?.skipped);
    const errorText = this.errorMessage(options.error || log?.error_message);

    const lines = [
      `## ${recordType}：${taskName}`,
      '',
      `- **运行状态**：${status || '-'}`,
      taskType ? `- **任务类型**：${taskType}` : '',
      log?.id ? `- **任务日志ID**：${log.id}` : '',
      log?.task_id ? `- **任务ID**：${log.task_id}` : '',
      options.queue_name ? `- **队列名称**：${options.queue_name}` : '',
      options.queue_job_id ? `- **队列任务ID**：${options.queue_job_id}` : '',
      options.queue_state ? `- **队列状态**：${options.queue_state}` : '',
      options.queue_progress !== undefined
        ? `- **队列进度**：${this.safeText(options.queue_progress, 200)}`
        : '',
      log?.started_at ? `- **开始时间**：${this.formatDate(log.started_at)}` : '',
      log?.completed_at || status !== 'IN_PROGRESS'
        ? `- **完成时间**：${this.formatDate(log?.completed_at || new Date())}`
        : '',
      '',
      '### 执行结果',
      total !== undefined ? `- **总数**：${total}` : '',
      completed !== undefined ? `- **完成数**：${completed}` : '',
      failed !== undefined ? `- **失败数**：${failed}` : '',
      skipped !== undefined ? `- **跳过数**：${skipped}` : '',
      inserted !== undefined ? `- **插入记录数**：${inserted}` : '',
      affected !== undefined ? `- **影响股票数**：${affected}` : '',
      dataUpdateLogId ? `- **数据更新日志ID**：${dataUpdateLogId}` : '',
      isSkipped
        ? `- **跳过原因**：${returnValue?.message || returnValue?.reason || '任务已跳过'}`
        : '',
    ];

    const detailLines = this.buildResultDetailLines(returnValue);
    if (detailLines.length > 0) {
      lines.push('', '### 明细', ...detailLines);
    }

    if (errorText) {
      lines.push('', '### 错误信息', errorText);
    }

    return this.safeText(lines.filter(Boolean).join('\n'), 10000);
  }

  private buildResultDetailLines(result: any): string[] {
    if (!result || typeof result !== 'object') return [];
    const lines: string[] = [];
    const details = result.details || {};
    const dailyUpdate = details.dailyUpdate || result.dailyUpdate;
    const stockInfoUpdate = details.stockInfoUpdate || result.stockInfoUpdate;

    if (dailyUpdate) {
      lines.push(
        `- **日更目标日期**：${dailyUpdate.targetDate || '-'}`,
        `- **日更开始日期**：${dailyUpdate.startDate || '-'}`,
        `- **待更新股票**：${dailyUpdate.stocksNeedingUpdate ?? '-'}`,
        `- **日更成功/失败/跳过**：${dailyUpdate.successCount ?? 0}/${dailyUpdate.failCount ?? 0}/${
          dailyUpdate.skipCount ?? 0
        }`,
        `- **日更插入记录**：${dailyUpdate.totalInserted ?? 0}`
      );
    }

    if (stockInfoUpdate) {
      lines.push(`- **股票基础信息更新**：${stockInfoUpdate.updatedCount ?? 0}`);
    }

    if (result.message && !result.skipped) {
      lines.push(`- **返回消息**：${this.safeText(result.message, 1000)}`);
    }

    return lines;
  }

  private firstDefined(...values: any[]): any {
    return values.find(value => value !== undefined && value !== null && value !== '');
  }

  private errorMessage(error: any): string {
    if (!error) return '';
    if (typeof error === 'string') return this.safeText(error, 5000);
    return this.safeText(error?.message || error, 5000);
  }

  private formatPercent(value: any): string {
    if (value === undefined || value === null || value === '') return '';
    const num = Number(value);
    return Number.isFinite(num) ? `${num.toFixed(2)}%` : String(value);
  }
}

export const feishuTaskReportService = new FeishuTaskReportService();
