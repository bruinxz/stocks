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
  agent_session?: string;
  result?: any;
  stats?: any;
  dashboard?: any;
}

export interface PaperTradingPlanReportPayload {
  record_type?: string;
  task_type?: string;
  error?: any;
}

type TaskLogLike = TaskExecutionLog | Record<string, any> | null | undefined;

class FeishuTaskReportService {
  private readonly defaultMessageMaxLength = 12000;

  async reportStockAnalysis(payload: StockAnalysisReportPayload) {
    const readable = this.normalizeStockAnalysisPayload(payload);
    const decision = readable.decision || payload.decision || 'UNKNOWN';
    const coreRationale = this.safeText(readable.rationale || payload.rationale || '暂无核心理由', 2200);
    const markdownMessage = [
      `## AI分析结果：${payload.name || payload.symbol}（${payload.symbol}）`,
      '',
      '### 结论',
      `- **投资评级**：${decision}`,
      payload.score != null ? `- **综合评分**：${Number(payload.score).toFixed(2)}` : '',
      payload.current_price != null ? `- **最新价**：${payload.current_price}` : '',
      payload.price_change_pct != null
        ? `- **涨跌幅**：${Number(payload.price_change_pct).toFixed(2)}%`
        : '',
      payload.task_label ? `- **任务来源**：${payload.task_label}` : '',
      '',
      '### 核心理由',
      coreRationale,
    ]
      .filter(Boolean)
      .join('\n');

    return this.safeAppend({
      文本: `AI分析结果 - ${payload.name}(${payload.symbol}) - ${decision}`,
      message: this.safeMarkdownMessage(markdownMessage),
      记录类型: 'AI分析结果',
      任务名称: payload.task_label || 'AI 每日优选评估',
      任务类型: 'AI_DAILY_SCREENER',
      运行状态: 'COMPLETED',
      股票代码: payload.symbol,
      股票名称: payload.name,
      投资评级: decision,
      评分: payload.score != null ? Number(payload.score).toFixed(2) : '',
      最新价: payload.current_price != null ? String(payload.current_price) : '',
      涨跌幅:
        payload.price_change_pct != null ? `${Number(payload.price_change_pct).toFixed(2)}%` : '',
      核心理由: this.safeText(readable.rationale || payload.rationale, 5000),
      详情: this.safeText(readable.detail || payload.detail || '', 10000),
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
    const agentSession = payload.agent_session || dashboard.filters?.agent_session || '';
    const markdownMessage = [
      `## ${payload.record_type || '推荐绩效刷新'}`,
      '',
      `- **信号来源**：${payload.source_type || dashboard.filters?.source_type || 'all'}`,
      agentSession ? `- **Agent 场次**：${this.agentSessionLabel(agentSession)}` : '',
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
      Agent场次: agentSession ? this.agentSessionLabel(agentSession) : '',
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

  async reportSignalVerificationRepair(result: any, options: { record_type?: string } = {}) {
    const recordType = options.record_type || '信号收益验证修复';
    const initial = result?.initial_diagnosis?.summary || {};
    const final = result?.final_diagnosis?.summary || {};
    const syncResult = result?.sync_result || {};
    const syncedSymbols = Object.entries(syncResult);
    const inserted = syncedSymbols.reduce(
      (sum, [, count]) => (Number(count) > 0 ? sum + Number(count) : sum),
      0
    );
    const failedSymbols = syncedSymbols
      .filter(([, count]) => Number(count) < 0)
      .map(([symbol]) => symbol);

    const markdownMessage = [
      `## ${recordType}`,
      '',
      '### 结论',
      `- **初始缺行情/不可验证**：${initial.no_data_signals ?? 0} 条`,
      `- **补行情股票**：${syncedSymbols.length} 只；新增/尝试写入K线 ${inserted} 条`,
      `- **重新验证**：${result?.verification?.verified ?? 0} 条；仍无数据 ${
        result?.verification?.no_data ?? 0
      } 条`,
      `- **最终可验证**：${final.ready_for_verification ?? 0} 条；周期未完成 ${
        final.insufficient_horizon_bars ?? 0
      } 条；缺行情 ${final.missing_bars ?? 0} 条`,
      '',
      '### 核心理由',
      final.no_data_signals > 0 || final.insufficient_horizon_bars > 0
        ? '仍存在不可验证样本，主要由行情缺失、股票映射缺失或后验周期尚未走完导致。系统已尽量补齐缺失行情，后续每日同步后会继续滚动验证。'
        : '缺失行情已补齐，当前样本具备后验验证条件，可以进入收益统计与策略反哺。',
      failedSymbols.length
        ? `\n### 同步失败股票\n${failedSymbols.slice(0, 20).map(symbol => `- ${symbol}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    return this.safeAppend({
      文本: `${recordType} - 补行情 ${syncedSymbols.length} 只 / 验证 ${
        result?.verification?.verified ?? 0
      } 条`,
      message: markdownMessage,
      记录类型: recordType,
      任务名称: 'AI信号收益验证修复',
      任务类型: 'SIGNAL_VERIFICATION_REPAIR',
      运行状态: 'COMPLETED',
      总数: initial.total_signals,
      完成数: result?.verification?.verified,
      失败数: result?.verification?.no_data,
      补行情股票数: syncedSymbols.length,
      插入记录数: inserted,
      错误信息: failedSymbols.length ? `同步失败：${failedSymbols.join(',')}` : '',
      结果摘要: this.safeJson(
        {
          sync_window: result?.sync_window,
          initial_summary: initial,
          final_summary: final,
          sync_result: syncResult,
          sample_issues: Array.isArray(result?.final_diagnosis?.details)
            ? result.final_diagnosis.details.slice(0, 20)
            : [],
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

  async reportPaperTradingAttribution(
    result: any,
    options: {
      record_type?: string;
      task_type?: string;
      error?: any;
    } = {}
  ) {
    const recordType = options.record_type || '模拟盘收益归因';
    const summary = result?.summary || {};
    const feedback = result?.feedback || {};
    const closedTrades = Array.isArray(result?.closed_trades) ? result.closed_trades : [];
    const openPositions = Array.isArray(result?.open_positions) ? result.open_positions : [];
    const markdownMessage = this.buildPaperTradingAttributionMarkdown(result, options, recordType);

    return this.safeAppend({
      文本: `${recordType} - 闭环 ${summary.closed_count ?? 0} 笔 / 胜率 ${
        summary.win_rate ?? 0
      }% / 总盈亏 ${this.formatSignedMoney(summary.total_pnl)} - ${this.formatDate(new Date())}`,
      message: markdownMessage,
      记录类型: recordType,
      任务名称: '模拟盘收益归因与策略反哺',
      任务类型: options.task_type || 'PAPER_TRADING_ATTRIBUTION_REPORT',
      运行状态: options.error ? 'FAILED' : 'COMPLETED',
      模拟盘ID: result?.portfolio_id,
      用户ID: result?.user_id,
      生成时间: result?.generated_at,
      已执行信号数: summary.executed_signals,
      已闭环交易数: summary.closed_count,
      当前持仓数: summary.open_count,
      胜率: this.formatPercent(summary.win_rate),
      平均收益: this.formatPercent(summary.avg_return_pct),
      总实现盈亏: this.formatSignedMoney(summary.total_realized_pnl),
      总浮动盈亏: this.formatSignedMoney(summary.total_unrealized_pnl),
      总盈亏: this.formatSignedMoney(summary.total_pnl),
      平均持有天数: summary.avg_holding_days,
      盈亏比: summary.payoff_ratio,
      ProfitFactor: summary.profit_factor,
      建议最低评分: feedback.recommended_min_score,
      建议风险等级: Array.isArray(feedback.recommended_allowed_risk_levels)
        ? feedback.recommended_allowed_risk_levels.join(',')
        : '',
      最佳标的: summary.best_trade
        ? `${summary.best_trade.name || summary.best_trade.symbol}(${summary.best_trade.symbol}) ${
            summary.best_trade.realized_pnl_pct
          }%`
        : '',
      最差标的: summary.worst_trade
        ? `${summary.worst_trade.name || summary.worst_trade.symbol}(${
            summary.worst_trade.symbol
          }) ${summary.worst_trade.realized_pnl_pct}%`
        : '',
      结果摘要: this.safeJson(
        {
          summary,
          feedback,
          groups: result?.groups,
          closed_trades: closedTrades.slice(0, 20),
          open_positions: openPositions.slice(0, 20),
        },
        10000
      ),
      错误信息: this.errorMessage(options.error),
      创建时间: this.formatDate(new Date()),
    });
  }

  async reportPaperTradingPlan(result: any, options: PaperTradingPlanReportPayload = {}) {
    const recordType = options.record_type || '模拟盘交易计划';
    const summary = result?.summary || {};
    const actions = Array.isArray(result?.actions) ? result.actions : [];
    const firstAction = actions[0] || {};
    const markdownMessage = this.buildPaperTradingPlanMarkdown(result, options, recordType);

    return this.safeAppend({
      文本: `${recordType} - 动作 ${summary.action_count ?? actions.length} 条 / 紧急 ${
        summary.urgent_count ?? 0
      } 条 - ${this.formatDate(new Date())}`,
      message: markdownMessage,
      记录类型: recordType,
      任务名称: '模拟盘盘前盘后交易计划',
      任务类型: options.task_type || 'PAPER_TRADING_DAILY_PLAN',
      运行状态: options.error ? 'FAILED' : 'COMPLETED',
      模拟盘ID: result?.portfolio_id,
      用户ID: result?.user_id,
      动作总数: summary.action_count,
      紧急动作数: summary.urgent_count,
      退出动作数: summary.exit_count,
      入场动作数: summary.entry_count,
      观察动作数: summary.monitor_count,
      复盘动作数: summary.review_count,
      当前现金: summary.current_cash,
      当前总资产: summary.total_value,
      卖出回款计划: summary.planned_sell_cash_inflow,
      买入用资计划: summary.planned_buy_cash_outflow,
      计划后现金: summary.projected_cash_after_plan,
      建议最低评分: summary.recommended_min_score,
      实际最低评分: summary.effective_min_score,
      推荐风险等级: Array.isArray(summary.recommended_allowed_risk_levels)
        ? summary.recommended_allowed_risk_levels.join(',')
        : '',
      股票代码: firstAction?.symbol,
      股票名称: firstAction?.name,
      动作标签: firstAction?.action_label,
      结果摘要: this.safeJson(
        {
          summary,
          actions: actions.slice(0, 20),
          attribution_summary: result?.attribution?.summary,
          entry_feedback_policy: result?.entry_preview?.feedback_policy,
        },
        10000
      ),
      错误信息: this.errorMessage(options.error),
      创建时间: this.formatDate(new Date()),
    });
  }

  private async safeAppend(fields: Record<string, any>) {
    try {
      const records = this.expandLongMessageRecords(fields);
      const results = [];

      for (const recordFields of records) {
        const result = await feishuBitableClient.createRecord(recordFields);
        results.push(result);

        if (result.success) {
          logger.info(
            records.length > 1
              ? `飞书多维表格写入成功 (${results.length}/${records.length})`
              : '飞书多维表格写入成功'
          );
        } else if (result.skipped) {
          logger.warn(`飞书多维表格写入跳过: ${result.message}`);
        } else {
          logger.error(`飞书多维表格写入失败: ${result.message}`);
        }
      }

      const failed = results.filter(result => !result.success && !result.skipped);
      const skipped = results.filter(result => result.skipped);
      if (failed.length > 0) {
        return {
          success: false,
          message: failed.map(item => item.message).filter(Boolean).join('; ') || '写入失败',
          segments: records.length,
          results,
        };
      }

      if (skipped.length === results.length) {
        return {
          success: false,
          skipped: true,
          message: skipped.map(item => item.message).filter(Boolean).join('; ') || '已跳过写入',
          segments: records.length,
          results,
        };
      }

      return {
        success: true,
        message: records.length > 1 ? `已分段写入 ${records.length} 条记录` : '写入成功',
        segments: records.length,
        results,
      };
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

  private getMessageMaxLength(): number {
    const configured = Number(process.env.FEISHU_MESSAGE_MAX_LENGTH);
    if (Number.isFinite(configured) && configured >= 2000) {
      return Math.min(Math.floor(configured), 200000);
    }
    return this.defaultMessageMaxLength;
  }

  private safeMarkdownMessage(value: any): string {
    if (value === undefined || value === null) return '';
    const text =
      typeof value === 'string'
        ? value
        : (() => {
            try {
              return JSON.stringify(value, null, 2);
            } catch (error) {
              return String(value);
            }
          })();
    return text;
  }

  private expandLongMessageRecords(fields: Record<string, any>): Record<string, any>[] {
    if (fields.message === undefined || fields.message === null) return [fields];

    const message = this.safeMarkdownMessage(fields.message);
    const maxLength = this.getMessageMaxLength();
    if (message.length <= maxLength) {
      return [{ ...fields, message }];
    }

    const chunkBudget = Math.max(1000, maxLength - 600);
    const chunks = this.splitMarkdownMessage(message, chunkBudget);
    const total = chunks.length;
    const baseText = String(fields.文本 || fields['任务名称'] || fields['记录类型'] || '飞书报告');
    const baseRecordType = String(fields['记录类型'] || '报告');
    const originalLength = String(message.length);

    return chunks.map((chunk, index) => {
      const segmentNo = index + 1;
      const header = [
        `## ${baseRecordType}（第 ${segmentNo}/${total} 段）`,
        '',
        `> 原始 message 共 ${message.length} 字符，已自动拆成 ${total} 条多维表格记录，避免飞书单元格或后续消息转发截断。`,
        '',
      ].join('\n');
      const remainingBudget = Math.max(1000, maxLength - header.length);
      const segmentMessage = `${header}${chunk.slice(0, remainingBudget)}`;

      return {
        ...fields,
        文本: `${baseText} - 分段 ${segmentNo}/${total}`,
        记录类型: fields['记录类型'] || baseRecordType,
        message: segmentMessage,
        message_segment: `${segmentNo}/${total}`,
        message_original_length: originalLength,
      };
    });
  }

  private splitMarkdownMessage(message: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = message;

    while (remaining.length > maxLength) {
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt < Math.floor(maxLength * 0.5)) {
        splitAt = remaining.lastIndexOf('。', maxLength);
      }
      if (splitAt < Math.floor(maxLength * 0.5)) {
        splitAt = remaining.lastIndexOf('；', maxLength);
      }
      if (splitAt < Math.floor(maxLength * 0.5)) {
        splitAt = maxLength;
      }

      chunks.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
  }

  private normalizeStockAnalysisPayload(payload: StockAnalysisReportPayload): {
    decision: string;
    rationale: string;
    detail: string;
  } {
    const parsedRationale = this.tryParseJson(payload.rationale);
    const parsedDetail = this.tryParseJson(payload.detail);
    const rationaleSource = this.firstDefined(
      this.pickReadableField(parsedRationale, ['rationale', 'summary', 'executive_summary', 'reason']),
      this.pickReadableField(parsedDetail, ['rationale', 'summary', 'executive_summary', 'reason']),
      payload.rationale
    );
    const detailSource = this.firstDefined(
      this.pickReadableField(parsedDetail, [
        'detail',
        'report',
        'analysis',
        'rationale',
        'summary',
        'executive_summary',
        'message',
      ]),
      payload.detail
    );

    const decision = String(
      this.firstDefined(
        this.pickReadableField(parsedRationale, ['decision', 'rating']),
        this.pickReadableField(parsedDetail, ['decision', 'rating']),
        payload.decision,
        'UNKNOWN'
      )
    );

    return {
      decision,
      rationale: this.toReadableText(rationaleSource),
      detail: this.toReadableText(detailSource),
    };
  }

  private pickReadableField(value: any, keys: string[]): any {
    if (!value || typeof value !== 'object') return undefined;
    for (const key of keys) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
        return value[key];
      }
    }
    return undefined;
  }

  private tryParseJson(value: any): any {
    if (!value) return undefined;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (!text || !/^[\[{]/.test(text)) return undefined;
    try {
      return JSON.parse(text);
    } catch (error) {
      return undefined;
    }
  }

  private toReadableText(value: any): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map(item => this.toReadableText(item)).filter(Boolean).join('\n');
    }
    if (typeof value === 'object') {
      return Object.entries(value)
        .map(([key, item]) => {
          const text = this.toReadableText(item);
          return text ? `- **${key}**：${text}` : '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return String(value);
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

    return this.safeMarkdownMessage(lines.filter(Boolean).join('\n'));
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
    const feedbackPolicy = result?.feedback_policy || {};
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
      '### 策略反哺参数',
      `- **归因反哺**：${feedbackPolicy?.enabled ? '已启用' : '未启用'}`,
      `- **闭环样本**：${feedbackPolicy?.closed_samples ?? 0}`,
      `- **有效最低评分**：${feedbackPolicy?.effective_min_score ?? '--'}${
        feedbackPolicy?.recommended_min_score !== undefined
          ? `（建议 ${feedbackPolicy.recommended_min_score}）`
          : ''
      }`,
      `- **有效风险等级**：${
        Array.isArray(feedbackPolicy?.effective_allowed_risk_levels)
          ? feedbackPolicy.effective_allowed_risk_levels.filter(Boolean).join('、') || '未限制'
          : '--'
      }`,
      feedbackPolicy?.strongest_bucket
        ? `- **当前强势评分桶**：${feedbackPolicy.strongest_bucket}`
        : '',
      '',
      '### 信号处理概览',
      `- **扫描信号**：${result?.scanned ?? 0}`,
      `- **符合交易条件**：${result?.eligible ?? 0}`,
      `- **${dryRun ? '计划交易' : '自动成交'}**：${
        dryRun ? (result?.planned ?? trades.length) : (result?.executed ?? trades.length)
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

    return this.safeMarkdownMessage(lines.filter(Boolean).join('\n'));
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
        dryRun ? (result?.planned ?? exits.length) : (result?.exited ?? exits.length)
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

    return this.safeMarkdownMessage(lines.filter(Boolean).join('\n'));
  }

  private buildPaperTradingAttributionMarkdown(
    result: any,
    options: { error?: any },
    recordType: string
  ): string {
    const summary = result?.summary || {};
    const feedback = result?.feedback || {};
    const groups = result?.groups || {};
    const closedTrades = Array.isArray(result?.closed_trades) ? result.closed_trades : [];
    const openPositions = Array.isArray(result?.open_positions) ? result.open_positions : [];
    const sourceGroups = Array.isArray(groups.by_source_type) ? groups.by_source_type : [];
    const riskGroups = Array.isArray(groups.by_risk_level) ? groups.by_risk_level : [];
    const actionGroups = Array.isArray(groups.by_action) ? groups.by_action : [];
    const exitGroups = Array.isArray(groups.by_exit_reason) ? groups.by_exit_reason : [];
    const scoreGroups = Array.isArray(groups.by_score_bucket) ? groups.by_score_bucket : [];
    const status = options.error ? 'FAILED' : 'COMPLETED';

    const lines = [
      `## ${recordType}`,
      '',
      `- **运行状态**：${status}`,
      result?.portfolio_id ? `- **模拟盘ID**：${result.portfolio_id}` : '',
      result?.user_id ? `- **用户ID**：${result.user_id}` : '',
      result?.generated_at ? `- **生成时间**：${result.generated_at}` : '',
      '',
      '### 交易闭环总览',
      `- **已执行信号**：${summary.executed_signals ?? 0}`,
      `- **已闭环交易**：${summary.closed_count ?? 0} 笔；**当前持仓**：${
        summary.open_count ?? 0
      } 只`,
      `- **胜率**：${this.formatPercent(summary.win_rate) || '0.00%'}`,
      `- **平均收益**：${this.formatPercent(summary.avg_return_pct) || '0.00%'}`,
      `- **平均持有**：${summary.avg_holding_days ?? 0} 天`,
      `- **盈亏比 / Profit Factor**：${summary.payoff_ratio ?? 0} / ${summary.profit_factor ?? 0}`,
      '',
      '### 钱包结果',
      `- **实现盈亏**：${this.formatSignedMoney(summary.total_realized_pnl)}`,
      `- **浮动盈亏**：${this.formatSignedMoney(summary.total_unrealized_pnl)}`,
      `- **综合盈亏**：${this.formatSignedMoney(summary.total_pnl)}`,
      `- **当前持仓敞口**：¥${this.formatMoney(summary.open_exposure)}（${
        summary.open_exposure_pct ?? 0
      }%）`,
    ];

    if (summary.best_trade || summary.worst_trade) {
      lines.push('', '### 最佳 / 最差样本');
      if (summary.best_trade) {
        lines.push(
          `- **最佳**：${summary.best_trade.name || summary.best_trade.symbol}（${
            summary.best_trade.symbol
          }），收益 ${this.formatPercent(summary.best_trade.realized_pnl_pct)}，实现盈亏 ${this.formatSignedMoney(
            summary.best_trade.realized_pnl
          )}，持有 ${summary.best_trade.holding_days ?? '--'} 天`
        );
      }
      if (summary.worst_trade) {
        lines.push(
          `- **最差**：${summary.worst_trade.name || summary.worst_trade.symbol}（${
            summary.worst_trade.symbol
          }），收益 ${this.formatPercent(summary.worst_trade.realized_pnl_pct)}，实现盈亏 ${this.formatSignedMoney(
            summary.worst_trade.realized_pnl
          )}，退出原因：${summary.worst_trade.exit_reason_label || summary.worst_trade.exit_reason || '-'}`
        );
      }
    }

    if (Array.isArray(feedback.insights) && feedback.insights.length > 0) {
      lines.push('', '### 策略反哺洞察');
      feedback.insights.slice(0, 8).forEach((text: string) => {
        lines.push(`- ${this.safeText(text, 500)}`);
      });
    }

    if (Array.isArray(feedback.next_actions) && feedback.next_actions.length > 0) {
      lines.push('', '### 下一步执行建议');
      feedback.next_actions.slice(0, 8).forEach((text: string) => {
        lines.push(`- ${this.safeText(text, 500)}`);
      });
      lines.push(
        `- **推荐最低评分**：${feedback.recommended_min_score ?? 72}`,
        `- **推荐风险等级**：${
          Array.isArray(feedback.recommended_allowed_risk_levels)
            ? feedback.recommended_allowed_risk_levels.join('、')
            : 'low、medium'
        }`
      );
    }

    this.appendAttributionGroupLines(lines, '来源维度', sourceGroups);
    this.appendAttributionGroupLines(lines, '风险维度', riskGroups);
    this.appendAttributionGroupLines(lines, '动作维度', actionGroups);
    this.appendAttributionGroupLines(lines, '评分桶维度', scoreGroups);
    this.appendAttributionGroupLines(lines, '退出原因维度', exitGroups);

    if (openPositions.length > 0) {
      lines.push('', '### 当前持仓风险暴露');
      openPositions.slice(0, 8).forEach((item: any) => {
        lines.push(
          `- **${item.name || item.symbol}（${item.symbol}）**：浮盈亏 ${this.formatSignedMoney(
            item.unrealized_pnl
          )}（${this.formatPercent(item.unrealized_pnl_pct)}），持有 ${
            item.holding_days ?? '--'
          } 天，距止损 ${
            item.distance_to_stop_loss_pct !== undefined
              ? `${item.distance_to_stop_loss_pct}pct`
              : '--'
          }`
        );
      });
    }

    if (closedTrades.length > 0) {
      lines.push('', '### 最近闭环交易');
      closedTrades.slice(0, 8).forEach((item: any, index: number) => {
        lines.push(
          `${index + 1}. **${item.name || item.symbol}（${item.symbol}）**：收益 ${this.formatPercent(
            item.realized_pnl_pct
          )}，实现盈亏 ${this.formatSignedMoney(item.realized_pnl)}，退出：${
            item.exit_reason_label || item.exit_reason || '-'
          }`
        );
      });
    } else {
      lines.push('', '### 最近闭环交易', '- 暂无已平仓闭环样本，先积累模拟盘交易结果。');
    }

    const errorText = this.errorMessage(options.error);
    if (errorText) {
      lines.push('', '### 错误信息', errorText);
    }

    lines.push(
      '',
      '> 说明：本报告用于把推荐信号、模拟盘买卖和真实收益结果连接起来，帮助自动调优选股阈值；不代表真实账户交易指令。'
    );

    return this.safeMarkdownMessage(lines.filter(Boolean).join('\n'));
  }

  private buildPaperTradingPlanMarkdown(
    result: any,
    options: { error?: any },
    recordType: string
  ): string {
    const summary = result?.summary || {};
    const actions = Array.isArray(result?.actions) ? result.actions : [];
    const attribution = result?.attribution || {};
    const feedback = attribution?.feedback || {};
    const status = options.error ? 'FAILED' : 'COMPLETED';

    const lines = [
      `## ${recordType}`,
      '',
      `- **运行状态**：${status}`,
      result?.portfolio_id ? `- **模拟盘ID**：${result.portfolio_id}` : '',
      result?.user_id ? `- **用户ID**：${result.user_id}` : '',
      result?.generated_at ? `- **生成时间**：${result.generated_at}` : '',
      '',
      '### 今日执行总览',
      `- **动作总数**：${summary.action_count ?? actions.length}`,
      `- **紧急动作**：${summary.urgent_count ?? 0}`,
      `- **退出 / 入场 / 观察 / 复盘**：${summary.exit_count ?? 0} / ${
        summary.entry_count ?? 0
      } / ${summary.monitor_count ?? 0} / ${summary.review_count ?? 0}`,
      `- **当前现金**：¥${this.formatMoney(summary.current_cash)}`,
      `- **计划卖出回款**：${this.formatSignedMoney(summary.planned_sell_cash_inflow)}`,
      `- **计划买入用资**：${this.formatSignedMoney(-Number(summary.planned_buy_cash_outflow || 0))}`,
      `- **计划后现金**：¥${this.formatMoney(summary.projected_cash_after_plan)}`,
      '',
      '### 归因反馈参数',
      `- **闭环样本数**：${summary.generated_from_closed_samples ?? 0}`,
      `- **建议最低评分**：${summary.recommended_min_score ?? '--'}`,
      `- **实际最低评分**：${summary.effective_min_score ?? '--'}`,
      `- **建议风险等级**：${
        Array.isArray(summary.recommended_allowed_risk_levels)
          ? summary.recommended_allowed_risk_levels.join('、')
          : '--'
      }`,
    ];

    if (Array.isArray(feedback.insights) && feedback.insights.length > 0) {
      lines.push('', '### 计划依据');
      feedback.insights.slice(0, 6).forEach((item: string) => {
        lines.push(`- ${this.safeText(item, 600)}`);
      });
    }

    const grouped = {
      critical: actions.filter((action: any) => action.priority === 'critical'),
      high: actions.filter((action: any) => action.priority === 'high'),
      medium: actions.filter((action: any) => action.priority === 'medium'),
      low: actions.filter((action: any) => action.priority === 'low'),
    };

    const renderActionGroup = (title: string, list: any[]) => {
      if (!list.length) return;
      lines.push('', `### ${title}`);
      list.slice(0, 8).forEach((item: any, index: number) => {
        lines.push(
          `${index + 1}. **${item.action_label || item.action_type}**${
            item.symbol ? ` - ${item.name || item.symbol}（${item.symbol}）` : ''
          }`,
          `   - 原因：${item.reason || '-'}`,
          item.reference_price !== undefined
            ? `   - 参考价：¥${this.formatMoney(item.reference_price)}${
                item.quantity ? `；数量：${item.quantity} 股` : ''
              }`
            : '',
          item.estimated_cash_change !== undefined
            ? `   - 现金影响：${this.formatSignedMoney(item.estimated_cash_change)}`
            : '',
          ...(Array.isArray(item.instructions)
            ? item.instructions.slice(0, 3).map((text: string) => `   - ${text}`)
            : [])
        );
      });
    };

    renderActionGroup('紧急动作', [...grouped.critical, ...grouped.high]);
    renderActionGroup('一般动作', grouped.medium);
    renderActionGroup('低优先级复盘', grouped.low);

    const errorText = this.errorMessage(options.error);
    if (errorText) {
      lines.push('', '### 错误信息', errorText);
    }

    lines.push(
      '',
      '> 说明：该计划用于把风控退出、候选入场和收益归因合成一张执行清单，便于盘前/盘后人工复核。'
    );

    return this.safeMarkdownMessage(lines.filter(Boolean).join('\n'));
  }

  private appendAttributionGroupLines(lines: string[], title: string, groups: any[]): void {
    if (!Array.isArray(groups) || groups.length === 0) return;
    lines.push('', `### ${title}`);
    groups.slice(0, 6).forEach(group => {
      lines.push(
        `- **${group.label || group.key}**：闭环 ${group.closed_count ?? 0} / 持仓 ${
          group.open_count ?? 0
        }，均收 ${this.formatPercent(group.avg_return_pct) || '0.00%'}，胜率 ${
          this.formatPercent(group.win_rate) || '0.00%'
        }，实现盈亏 ${this.formatSignedMoney(group.total_realized_pnl)}`
      );
    });
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

  private formatSignedMoney(value: any): string {
    if (value === undefined || value === null || value === '') return '¥0.00';
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    const prefix = num > 0 ? '+¥' : num < 0 ? '-¥' : '¥';
    return `${prefix}${Math.abs(num).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  private agentSessionLabel(value: string): string {
    const normalized = String(value || '').toLowerCase();
    if (normalized === 'close') return '尾盘/收盘';
    if (normalized === 'midday') return '午盘';
    if (normalized === 'morning') return '早盘';
    return value || '';
  }
}

export const feishuTaskReportService = new FeishuTaskReportService();
