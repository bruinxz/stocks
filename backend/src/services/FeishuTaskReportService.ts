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

  async reportPaperTradingAutomation(
    result: any,
    options: {
      record_type?: string;
      task_type?: string;
      error?: any;
    } = {}
  ) {
    const recordType =
      options.record_type || (result?.dry_run ? '模拟盘跟单预演' : '模拟盘自动跟单');
    const trades = Array.isArray(result?.trades) ? result.trades : [];
    const skippedItems = Array.isArray(result?.skipped_items) ? result.skipped_items : [];
    const snapshot = result?.snapshot || {};
    const firstTrade = trades[0] || {};
    const markdownMessage = this.buildPaperTradingAutomationMarkdown(result, options, recordType);

    return this.safeAppend({
      文本: `${recordType} - 成交/计划 ${trades.length} 笔 - ${this.formatDate(new Date())}`,
      message: markdownMessage,
      记录类型: recordType,
      任务名称: '推荐信号自动进入模拟盘',
      任务类型: options.task_type || 'PAPER_TRADING_AUTO_SYNC',
      运行状态: options.error ? 'FAILED' : 'COMPLETED',
      模拟盘ID: result?.portfolio_id,
      用户ID: result?.user_id,
      信号来源: result?.source_type,
      是否预演: result?.dry_run ? '是' : '否',
      扫描信号数: result?.scanned,
      符合条件数: result?.eligible,
      自动成交数: result?.executed,
      计划交易数: result?.planned,
      跳过数: result?.skipped,
      总资产: snapshot?.total_value,
      可用资金: snapshot?.current_cash,
      持仓市值: snapshot?.position_value,
      股票代码: firstTrade?.symbol,
      股票名称: firstTrade?.name,
      成交数量: firstTrade?.quantity,
      成交价格: firstTrade?.execute_price,
      交易金额: firstTrade?.amount,
      结果摘要: this.safeJson(
        {
          trades,
          skipped_items: skippedItems.slice(0, 10),
          snapshot,
          generated: result?.generated,
          archive: result?.archive,
        },
        10000
      ),
      错误信息: this.errorMessage(options.error),
      创建时间: this.formatDate(new Date()),
    });
  }

  async reportPaperTradingRiskCheck(
    result: any,
    options: {
      record_type?: string;
      task_type?: string;
      error?: any;
    } = {}
  ) {
    const recordType =
      options.record_type || (result?.dry_run ? '模拟盘风控预演' : '模拟盘风控退出');
    const exits = Array.isArray(result?.exits) ? result.exits : [];
    const heldItems = Array.isArray(result?.held_items) ? result.held_items : [];
    const skippedItems = Array.isArray(result?.skipped_items) ? result.skipped_items : [];
    const snapshot = result?.snapshot || {};
    const firstExit = exits[0] || {};
    const markdownMessage = this.buildPaperTradingRiskMarkdown(result, options, recordType);

    return this.safeAppend({
      文本: `${recordType} - 退出/计划 ${exits.length} 笔 - ${this.formatDate(new Date())}`,
      message: markdownMessage,
      记录类型: recordType,
      任务名称: '模拟盘自动风控退出',
      任务类型: options.task_type || 'PAPER_TRADING_RISK_CHECK',
      运行状态: options.error ? 'FAILED' : 'COMPLETED',
      模拟盘ID: result?.portfolio_id,
      用户ID: result?.user_id,
      是否预演: result?.dry_run ? '是' : '否',
      检查持仓数: result?.checked,
      退出候选数: result?.exit_candidates,
      自动退出数: result?.exited,
      计划退出数: result?.planned,
      继续持有数: result?.held,
      跳过数: result?.skipped,
      总资产: snapshot?.total_value,
      可用资金: snapshot?.current_cash,
      持仓市值: snapshot?.position_value,
      股票代码: firstExit?.symbol,
      股票名称: firstExit?.name,
      退出原因: firstExit?.reason_label,
      成交数量: firstExit?.quantity,
      成交价格: firstExit?.execute_price,
      实现盈亏: firstExit?.realized_pnl,
      结果摘要: this.safeJson(
        {
          exits,
          held_items: heldItems.slice(0, 10),
          skipped_items: skippedItems.slice(0, 10),
          snapshot,
        },
        10000
      ),
      错误信息: this.errorMessage(options.error),
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

  private buildPaperTradingAutomationMarkdown(
    result: any,
    options: { error?: any },
    recordType: string
  ): string {
    const trades = Array.isArray(result?.trades) ? result.trades : [];
    const skippedItems = Array.isArray(result?.skipped_items) ? result.skipped_items : [];
    const snapshot = result?.snapshot || {};
    const generated = result?.generated || {};
    const archive = result?.archive || {};
    const dryRun = Boolean(result?.dry_run);
    const status = options.error ? 'FAILED' : 'COMPLETED';
    const tradeAction = dryRun ? '计划买入' : '已模拟买入';

    const lines = [
      `## ${recordType}`,
      '',
      `- **运行状态**：${status}`,
      `- **执行模式**：${dryRun ? '预演，不落地交易' : '正式模拟盘交易'}`,
      result?.portfolio_id ? `- **模拟盘ID**：${result.portfolio_id}` : '',
      result?.user_id ? `- **用户ID**：${result.user_id}` : '',
      result?.source_type ? `- **信号来源**：${result.source_type}` : '',
      '',
      '### 信号处理概览',
      `- **扫描信号**：${result?.scanned ?? 0}`,
      `- **符合交易条件**：${result?.eligible ?? 0}`,
      `- **${dryRun ? '计划交易' : '自动成交'}**：${
        dryRun ? result?.planned ?? trades.length : result?.executed ?? trades.length
      }`,
      `- **跳过信号**：${result?.skipped ?? skippedItems.length}`,
      generated?.total_candidates !== undefined
        ? `- **本轮候选池**：${generated.analyzed_candidates ?? '-'} / ${
            generated.total_candidates
          } 只完成评分`
        : '',
      archive?.total !== undefined
        ? `- **归档信号**：${archive.total} 条（新增 ${archive.created ?? 0} / 更新 ${
            archive.updated ?? 0
          }）`
        : '',
      '',
      '### 模拟盘资产',
      snapshot?.total_value !== undefined
        ? `- **总资产**：¥${this.formatMoney(snapshot.total_value)}`
        : '',
      snapshot?.current_cash !== undefined
        ? `- **可用资金**：¥${this.formatMoney(snapshot.current_cash)}`
        : '',
      snapshot?.position_value !== undefined
        ? `- **持仓市值**：¥${this.formatMoney(snapshot.position_value)}`
        : '',
    ];

    if (trades.length > 0) {
      lines.push('', `### ${tradeAction}明细`);
      trades.slice(0, 10).forEach((trade: any, index: number) => {
        lines.push(
          `${index + 1}. **${trade.name || trade.symbol}（${trade.symbol}）**`,
          `   - 数量：${trade.quantity ?? '-'} 股；成交价：¥${this.formatMoney(
            trade.execute_price
          )}；交易金额：¥${this.formatMoney(trade.amount)}`,
          `   - 仓位纪律：目标 ${trade.target_position_pct ?? '--'}%，止损 ${
            trade.stop_loss_pct ?? '--'
          }%，止盈 ${trade.take_profit_pct ?? '--'}%`,
          `   - 信号：${trade.decision || '-'} / 评分 ${trade.score ?? '--'} / 风险 ${
            trade.risk_level || '--'
          } / 日期 ${trade.signal_date || '--'}`
        );
      });
      if (trades.length > 10) {
        lines.push(`- 其余 ${trades.length - 10} 笔交易已省略，请查看结果摘要。`);
      }
    } else {
      lines.push('', '### 交易明细', '- 本轮没有产生可执行交易。');
    }

    if (skippedItems.length > 0) {
      lines.push('', '### 主要跳过原因');
      skippedItems.slice(0, 8).forEach((item: any) => {
        lines.push(
          `- **${item.name || item.symbol}（${item.symbol}）**：${item.reason || '未给出原因'}`
        );
      });
    }

    const errorText = this.errorMessage(options.error);
    if (errorText) {
      lines.push('', '### 错误信息', errorText);
    }

    lines.push(
      '',
      '> 说明：该记录为模拟盘验证闭环，不代表真实账户交易建议；真实交易前仍需人工复核仓位、流动性和风险。'
    );

    return this.safeText(lines.filter(Boolean).join('\n'), 10000);
  }

  private buildPaperTradingRiskMarkdown(
    result: any,
    options: { error?: any },
    recordType: string
  ): string {
    const exits = Array.isArray(result?.exits) ? result.exits : [];
    const heldItems = Array.isArray(result?.held_items) ? result.held_items : [];
    const skippedItems = Array.isArray(result?.skipped_items) ? result.skipped_items : [];
    const snapshot = result?.snapshot || {};
    const dryRun = Boolean(result?.dry_run);
    const status = options.error ? 'FAILED' : 'COMPLETED';
    const exitAction = dryRun ? '计划退出' : '已模拟卖出';

    const lines = [
      `## ${recordType}`,
      '',
      `- **运行状态**：${status}`,
      `- **执行模式**：${dryRun ? '预演，不落地交易' : '正式模拟盘卖出'}`,
      result?.portfolio_id ? `- **模拟盘ID**：${result.portfolio_id}` : '',
      result?.user_id ? `- **用户ID**：${result.user_id}` : '',
      '',
      '### 风控检查概览',
      `- **检查持仓**：${result?.checked ?? 0}`,
      `- **触发退出**：${result?.exit_candidates ?? exits.length}`,
      `- **${dryRun ? '计划退出' : '自动退出'}**：${
        dryRun ? result?.planned ?? exits.length : result?.exited ?? exits.length
      }`,
      `- **继续持有**：${result?.held ?? heldItems.length}`,
      `- **跳过持仓**：${result?.skipped ?? skippedItems.length}`,
      '',
      '### 模拟盘资产',
      snapshot?.total_value !== undefined
        ? `- **总资产**：¥${this.formatMoney(snapshot.total_value)}`
        : '',
      snapshot?.current_cash !== undefined
        ? `- **可用资金**：¥${this.formatMoney(snapshot.current_cash)}`
        : '',
      snapshot?.position_value !== undefined
        ? `- **持仓市值**：¥${this.formatMoney(snapshot.position_value)}`
        : '',
    ];

    if (exits.length > 0) {
      lines.push('', `### ${exitAction}明细`);
      exits.slice(0, 10).forEach((item: any, index: number) => {
        const pnlPrefix = Number(item.realized_pnl || 0) >= 0 ? '+' : '';
        lines.push(
          `${index + 1}. **${item.name || item.symbol}（${item.symbol}）** - ${
            item.reason_label || item.reason || '风控退出'
          }`,
          `   - 数量：${item.quantity ?? '-'} 股；卖出价：¥${this.formatMoney(
            item.execute_price
          )}；净回款：¥${this.formatMoney(item.net_revenue)}`,
          `   - 盈亏：${pnlPrefix}¥${this.formatMoney(item.realized_pnl)}（${
            item.pnl_pct ?? '--'
          }%）；持有 ${item.holding_days ?? '--'} 天`,
          `   - 纪律：止损 ${item.stop_loss_pct ?? '--'}%，止盈 ${item.take_profit_pct ?? '--'}%${
            item.sell_signal_id
              ? `；卖出信号 #${item.sell_signal_id}（${item.sell_signal_score ?? '--'}分）`
              : ''
          }`
        );
      });
      if (exits.length > 10) {
        lines.push(`- 其余 ${exits.length - 10} 笔退出已省略，请查看结果摘要。`);
      }
    } else {
      lines.push('', '### 退出明细', '- 本轮没有持仓触发退出纪律。');
    }

    if (heldItems.length > 0) {
      lines.push('', '### 继续持有观察');
      heldItems.slice(0, 8).forEach((item: any) => {
        lines.push(
          `- **${item.name || item.symbol}（${item.symbol}）**：当前 ${item.pnl_pct ?? '--'}%，${
            item.message || '未触发退出'
          }`
        );
      });
    }

    if (skippedItems.length > 0) {
      lines.push('', '### 跳过项');
      skippedItems.slice(0, 6).forEach((item: any) => {
        lines.push(
          `- **${item.name || item.symbol}（${item.symbol}）**：${item.message || '已跳过'}`
        );
      });
    }

    const errorText = this.errorMessage(options.error);
    if (errorText) {
      lines.push('', '### 错误信息', errorText);
    }

    lines.push(
      '',
      '> 说明：风控退出基于模拟盘持仓、最新本地行情和已归档信号自动执行；真实交易前仍需人工复核。'
    );

    return this.safeText(lines.filter(Boolean).join('\n'), 10000);
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

  private formatMoney(value: any): string {
    if (value === undefined || value === null || value === '') return '--';
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    return num.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
}

export const feishuTaskReportService = new FeishuTaskReportService();
