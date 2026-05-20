import type { Job } from 'bull';
import moment from 'moment-timezone';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import type { DataUpdateJobData } from '../jobs/dataUpdateQueue';
import type { AIPollingJobData } from '../jobs/aiPollingQueue';
import { logger } from '../utils/logger';
import { feishuBitableClient } from './FeishuBitableClient';
import { normalizeTradingAgentsError } from './AIAdvisorService';

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

class FeishuTaskReportService {
  private readonly defaultMessageMaxLength = 12000;

  async reportStockAnalysis(payload: StockAnalysisReportPayload) {
    const readable = this.normalizeStockAnalysisPayload(payload);
    const decision = readable.decision || payload.decision || 'UNKNOWN';
    const coreRationale = this.safeText(
      readable.rationale || payload.rationale || '暂无核心理由',
      2200
    );
    const markdownMessage = [
      `## AI分析结果：${payload.name || payload.symbol}（${payload.symbol}）`,
      '',
      '### 结论',
      `- **投资评级**：${decision}`,
      payload.score != null ? `- **综合评分**：${Number(payload.score).toFixed(2)}` : '',
      this.buildPriceMarkdownLine(
        {
          current_price: payload.current_price,
          price_change_pct: payload.price_change_pct,
        },
        '当前股价（Agent分析时）'
      ),
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
    const readableError = normalizeTradingAgentsError(this.errorMessage(error));
    const markdownMessage = [
      `## AI轮询失败：${jobData?.name || jobData?.symbol || '未知股票'}`,
      '',
      '### 结论',
      '- **结果**：本次 TradingAgents 深度复核失败，未生成可入库交易信号。',
      `- **原因**：${readableError || '远端智能体服务未返回明确错误。'}`,
      '- **下一步**：已记录队列失败；修复/重启 TradingAgents 后可重新触发该股票分析。',
      '',
      '### 任务信息',
      `- **股票代码**：${jobData?.symbol || '-'}`,
      `- **股票名称**：${jobData?.name || '-'}`,
      this.buildPriceMarkdownLine(
        {
          current_price: jobData?.current_price,
          price_change_pct: jobData?.price_change_pct,
        },
        '当前股价（提交Agent时）'
      ),
      `- **任务名称**：${jobData?.taskLabel || 'AI 每日优选评估'}`,
      jobId ? `- **队列任务ID**：${jobId}` : '',
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
      错误信息: readableError,
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
    const playbook = dashboard.playbook || {};
    const gate = playbook.overall?.gate || {};
    const bestSegments = Array.isArray(playbook.best_segments) ? playbook.best_segments : [];
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
      '### 结论闸门',
      `- **当前建议**：${gate.label || '等待样本'}；仓位倍率 ${
        gate.position_multiplier !== undefined
          ? `${Number(gate.position_multiplier).toFixed(2)}x`
          : '--'
      }`,
      gate.reason ? `- **核心理由**：${gate.reason}` : '',
      bestSegments.length
        ? `- **最强片段**：${bestSegments
            .slice(0, 3)
            .map(
              (item: any) =>
                `${item.label || item.key}(${item.quality_score || 0}分/${item.count}样本)`
            )
            .join('、')}`
        : '',
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
      收益闸门: gate.label || '',
      建议仓位倍率:
        gate.position_multiplier !== undefined ? Number(gate.position_multiplier).toFixed(2) : '',
      闸门理由: gate.reason || '',
      最强片段: bestSegments
        .slice(0, 3)
        .map((item: any) => `${item.label || item.key}:${item.quality_score || 0}`)
        .join(', '),
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
          playbook: {
            overall: playbook.overall,
            best_segments: bestSegments.slice(0, 5),
            risk_notes: playbook.risk_notes,
          },
          top_symbols: Array.isArray(dashboard.top_symbols)
            ? dashboard.top_symbols.slice(0, 5)
            : undefined,
        },
        10000
      ),
      创建时间: this.formatDate(new Date()),
    });
  }

  async reportSignalQualityDaily(report: any, options: SignalQualityDailyReportPayload = {}) {
    const recordType = options.record_type || '信号质量日报';
    const overview = report?.overview || {};
    const filters = report?.filters || {};
    const bestSegments = Array.isArray(report?.best_segments) ? report.best_segments : [];
    const worstSegments = Array.isArray(report?.worst_segments) ? report.worst_segments : [];
    const actionItems = Array.isArray(report?.action_items) ? report.action_items : [];
    const dataHealth = report?.data_health || {};
    const repairSummary = report?.repair_summary || {};
    const topSource = report?.rankings?.by_source_type?.[0];
    const topSession = report?.rankings?.by_agent_session?.[0];

    const renderSegments = (segments: any[]) =>
      segments
        .slice(0, 5)
        .map(
          (item: any, index: number) =>
            `${index + 1}. **${item.label || item.key}**：质量分 ${item.quality_score ?? 0}，样本 ${
              item.count ?? 0
            }，均收 ${this.formatPercent(item.avg_return_pct)}，方向胜率 ${this.formatPercent(
              item.directional_success_rate
            )}`
        )
        .join('\n');

    const markdownMessage = [
      `## ${recordType}`,
      '',
      '### 结论',
      `- **统计窗口**：${filters.start_date || '-'} ~ ${filters.end_date || '-'}；周期 ${
        filters.horizon || '5d'
      }`,
      `- **信号总数**：${overview.total_signals ?? 0}；完成样本 ${
        overview.completed_samples ?? overview.count ?? 0
      }；等待 ${overview.pending_signals ?? 0}；无数据 ${overview.no_data_signals ?? 0}`,
      `- **整体质量分**：${overview.quality_score ?? 0}；闸门：${overview.gate?.label || '-'}`,
      `- **整体均收/胜率/方向胜率**：${this.formatPercent(
        overview.avg_return_pct
      )} / ${this.formatPercent(overview.positive_rate)} / ${this.formatPercent(
        overview.directional_success_rate
      )}`,
      topSource
        ? `- **最佳来源**：${topSource.label}，质量分 ${
            topSource.quality_score
          }，均收 ${this.formatPercent(topSource.avg_return_pct)}`
        : '',
      topSession
        ? `- **最佳场次**：${topSession.label}，质量分 ${
            topSession.quality_score
          }，均收 ${this.formatPercent(topSession.avg_return_pct)}`
        : '',
      '',
      '### 数据健康 / 自动修复',
      `- **健康拆解**：pending ${dataHealth.pending_signals ?? 0}；no_data ${
        dataHealth.no_data_signals ?? 0
      }；缺行情 ${dataHealth.missing_bars ?? 0}；周期未完成 ${
        dataHealth.insufficient_horizon_bars ?? 0
      }；等待行情 ${dataHealth.waiting_for_market_data ?? 0}`,
      repairSummary?.enabled
        ? `- **自动修复**：同步 ${repairSummary.synced_symbols ?? 0} 只股票；新增/尝试写入 ${
            repairSummary.inserted_bars ?? 0
          } 条K线；修复后 no_data ${
            repairSummary.after?.no_data_signals ?? dataHealth.no_data_signals ?? 0
          }`
        : '- **自动修复**：未启用',
      '',
      '### 最强片段',
      renderSegments(bestSegments) || '- 暂无完成样本',
      '',
      '### 需要降权/复盘',
      renderSegments(worstSegments) || '- 暂无需要降权的片段',
      actionItems.length ? '\n### 今日动作建议' : '',
      actionItems.map((item: string) => `- ${item}`).join('\n'),
    ]
      .filter(Boolean)
      .join('\n');

    return this.safeAppend({
      文本: `${recordType} - ${filters.horizon || '5d'} 质量分 ${
        overview.quality_score ?? 0
      } / 完成 ${overview.completed_samples ?? overview.count ?? 0} 样本`,
      message: markdownMessage,
      记录类型: recordType,
      任务名称: '信号来源质量排行榜',
      任务类型: 'SIGNAL_QUALITY_DAILY_REPORT',
      运行状态: 'COMPLETED',
      绩效周期: filters.horizon || '5d',
      开始时间: filters.start_date,
      完成时间: filters.end_date,
      信号总数: overview.total_signals,
      完成样本: overview.completed_samples ?? overview.count,
      待验证信号: overview.pending_signals,
      无数据信号: overview.no_data_signals,
      缺行情信号: dataHealth.missing_bars,
      周期未完成信号: dataHealth.insufficient_horizon_bars,
      等待行情信号: dataHealth.waiting_for_market_data,
      自动修复股票数: repairSummary.synced_symbols,
      自动修复K线数: repairSummary.inserted_bars,
      质量分: overview.quality_score,
      收益闸门: overview.gate?.label,
      平均收益: this.formatPercent(overview.avg_return_pct),
      胜率: this.formatPercent(overview.positive_rate),
      方向成功率: this.formatPercent(overview.directional_success_rate),
      最佳来源: topSource
        ? `${topSource.label} / ${topSource.quality_score} / ${this.formatPercent(
            topSource.avg_return_pct
          )}`
        : '',
      最佳场次: topSession
        ? `${topSession.label} / ${topSession.quality_score} / ${this.formatPercent(
            topSession.avg_return_pct
          )}`
        : '',
      结果摘要: this.safeJson(
        {
          filters,
          overview,
          best_segments: bestSegments.slice(0, 8),
          worst_segments: worstSegments.slice(0, 8),
          data_health: dataHealth,
          repair_summary: repairSummary,
          rankings: report?.rankings,
          horizon_summary: report?.horizon_summary,
          action_items: actionItems,
        },
        10000
      ),
      创建时间: this.formatDate(new Date()),
    });
  }

  async reportAutomatedRecommendationLoop(
    result: any,
    options: AutomatedRecommendationLoopReportPayload = {}
  ) {
    const recordType = options.record_type || '全市场荐股闭环';
    const generated = result?.generated || {};
    const recommendations = Array.isArray(generated.recommendations)
      ? generated.recommendations
      : [];
    const archive = result?.archive || {};
    const agentAnalysis = result?.agent_analysis || {};
    const verification = result?.verification || archive?.verification || {};
    const paper = result?.paper_trading || {};
    const riskProfile = result?.risk_profile || paper?.risk_profile || {};
    const riskMetrics = riskProfile?.risk_metrics || {};
    const riskThresholdSuggestion =
      result?.risk_threshold_suggestion || result?.risk_profile_gate?.threshold_version || {};
    const riskThresholdStability =
      riskThresholdSuggestion?.stability || riskThresholdSuggestion?.suggestion_stability || {};
    const riskThresholdAttribution =
      riskThresholdSuggestion?.attribution || riskThresholdSuggestion?.threshold_attribution || {};
    const riskThresholdFieldGateAdvice = riskThresholdSuggestion?.field_gate_advice || {};
    const tradeOutcomes = result?.trade_outcomes || {};
    const outcomeSummary = tradeOutcomes?.summary || {};
    const loopPolicy = result?.loop_policy || {};
    const fieldGateAdjustmentAttribution =
      loopPolicy?.policy_promotion?.field_gate_adjustment_attribution ||
      result?.field_gate_adjustment_attribution ||
      {};
    const riskGatePolicy = loopPolicy?.risk_profile_gate || result?.risk_profile_gate || {};
    const environmentPolicy = loopPolicy?.environment_policy || result?.environment_policy || {};
    const strategyEvolution =
      result?.trade_outcomes?.strategy_evolution || result?.strategy_evolution || {};
    const budgetActionRankings = Array.isArray(strategyEvolution?.budget_action_rankings)
      ? strategyEvolution.budget_action_rankings
      : [];
    const budgetActionPolicy =
      strategyEvolution?.budget_action_policy || environmentPolicy?.budget_action_policy || {};
    const budgetPolicyVersion =
      strategyEvolution?.budget_policy_version ||
      environmentPolicy?.budget_policy_version ||
      budgetActionPolicy?.version ||
      {};
    const budgetPolicyExecutionAudit =
      strategyEvolution?.budget_policy_execution_audit ||
      environmentPolicy?.budget_policy_execution_audit ||
      {};
    const budgetPolicyRollbackAudit =
      strategyEvolution?.budget_policy_rollback_audit ||
      environmentPolicy?.budget_policy_rollback_audit ||
      budgetPolicyVersion?.rollback_audit ||
      {};
    const policySnapshot = result?.policy_snapshot || {};
    const qualityOverview = result?.quality_report?.overview || {};
    const thresholdVersion = riskGatePolicy?.threshold_version || {};
    const thresholdStability =
      thresholdVersion?.stability ||
      loopPolicy?.policy_promotion?.risk_gate_analysis?.suggestion_stability ||
      loopPolicy?.policy_promotion?.risk_gate_analysis?.suggested_limits?.stability ||
      {};
    const topPicks = recommendations.slice(0, 5);
    const bestPick = topPicks[0];
    const skipReasonSummary = paper?.skip_reason_summary || {};
    const topSkipReasons = Array.isArray(skipReasonSummary.top_reasons)
      ? skipReasonSummary.top_reasons.slice(0, 3)
      : [];
    const strategyExperiment = loopPolicy?.strategy_experiment || null;
    const champion = strategyExperiment?.champion;
    const baseVariant = strategyExperiment?.base_variant;
    const consensusOverlapCount =
      generated.consensus_overlap_count ?? strategyExperiment?.overlap_count ?? 0;
    const consensusRanked = Boolean(generated.consensus_ranked);
    const candidateTuning = generated.environment_strategy_candidate_tuning || {};
    const formatBudgetTarget = (item: any) => {
      if (!item) return '暂无';
      const label = item.label || item.key || '未命名组合';
      const efficiency =
        item.capital_efficiency_score !== undefined
          ? `效率 ${Number(item.capital_efficiency_score).toFixed(1)}`
          : item.avg_excess_return_pct !== undefined
            ? `超额 ${this.formatPercent(item.avg_excess_return_pct)}`
            : '';
      const multiplier =
        item.recommended_budget_multiplier !== undefined
          ? `预算 ${Number(item.recommended_budget_multiplier).toFixed(2)}x`
          : item.position_multiplier !== undefined
            ? `预算 ${Number(item.position_multiplier).toFixed(2)}x`
            : '';
      const reason = this.safeText(
        item.budget_action_reason || item.reason || item.resample_decision_reason || '',
        44
      );
      return [label, efficiency, multiplier, reason].filter(Boolean).join('，');
    };
    const consensusTopPicks = topPicks.filter(
      (item: any) =>
        Number(item?.consensus_count || 0) > 1 || Number(item?.consensus_bonus || 0) > 0
    );
    const formatConsensus = (item: any) => {
      const count = Number(item?.consensus_count || 0);
      const bonus = Number(item?.consensus_bonus || 0);
      if (count <= 1 && bonus <= 0) return '';
      const variants = Array.isArray(item?.consensus_variants)
        ? item.consensus_variants.slice(0, 3).join('/')
        : '';
      const originalScore =
        item?.original_score !== undefined && item?.original_score !== null
          ? `，原始 ${Number(item.original_score).toFixed(1)}→${Number(item.score || 0).toFixed(1)}`
          : '';
      return `；策略共识 ${count} 组${bonus ? `，加分 +${bonus}` : ''}${originalScore}${
        variants ? `（${variants}）` : ''
      }`;
    };
    const markdownMessage = [
      `## ${recordType}`,
      '',
      '### 结论',
      result?.loop_run_id ? `- **闭环运行ID**：${result.loop_run_id}` : '',
      `- **候选范围**：${result?.universe === 'market' ? '全市场自动扫描' : '自选池'} / ${
        result?.style || generated.style || 'balanced'
      }`,
      loopPolicy?.enabled !== undefined
        ? `- **闭环自适应**：${loopPolicy.enabled ? '已启用' : '未启用'}；样本 ${
            loopPolicy.closed_samples ?? 0
          }/${loopPolicy.min_closed_samples ?? '-'}；风格 ${loopPolicy.base_style || '-'} → ${
            loopPolicy.effective_style || '-'
          }；最低评分 ${loopPolicy.effective_min_score ?? '-'}；仓位 ${
            loopPolicy.effective_default_position_pct ?? '-'
          }%/${loopPolicy.effective_max_position_pct ?? '-'}%`
        : '',
      `- **评分覆盖**：${generated.analyzed_candidates ?? 0}/${
        generated.total_candidates ?? 0
      }；归档 ${archive.total ?? 0} 条；验证完成 ${verification.verified ?? 0} 条`,
      agentAnalysis?.enabled
        ? `- **Agent 深度复核**：已提交 ${
            Array.isArray(agentAnalysis.submitted) ? agentAnalysis.submitted.length : 0
          } 个；失败 ${
            Array.isArray(agentAnalysis.failed) ? agentAnalysis.failed.length : 0
          } 个；完成后${agentAnalysis.auto_paper_trade ? '会自动进入模拟盘' : '仅归档跟踪'}`
        : '- **Agent 深度复核**：未启用',
      `- **模拟盘动作**：${
        paper?.dry_run ? '预演' : paper?.portfolio_id ? '已执行' : '未执行'
      }；成交/计划 ${paper?.executed ?? paper?.planned ?? 0} 笔；跳过 ${
        paper?.skipped ?? 0
      } 条；共识成交/计划 ${paper?.consensus_executed ?? 0}/${paper?.consensus_planned ?? 0} 笔`,
      riskProfile?.status
        ? `- **组合风险**：${riskProfile.status.label}；现金 ${this.formatPercent(
            riskMetrics.cash_pct
          )}，总仓位 ${this.formatPercent(riskMetrics.exposure_pct)}，回撤 ${this.formatPercent(
            Math.abs(Number(riskMetrics.drawdown_pct || 0))
          )}；${this.safeText(riskProfile.status.conclusion, 120)}`
        : '',
      riskGatePolicy?.enabled
        ? `- **风险闸门**：${
            riskGatePolicy.action === 'pause'
              ? '暂停新增'
              : riskGatePolicy.action === 'reduce'
                ? '自动降仓'
                : '正常放行'
          }；${this.safeText(
            loopPolicy.risk_gate_feedback_reason || riskGatePolicy.reason || '按组合风险画像执行',
            140
          )}`
        : '',
      thresholdStability?.label
        ? `- **阈值建议**：${thresholdStability.label}；${
            thresholdStability.can_apply ? '建议人工预览后应用' : '暂继续观察'
          }；${this.safeText(thresholdStability.reason, 110)}`
        : '',
      this.buildRiskThresholdAttributionLine(riskThresholdAttribution),
      topSkipReasons.length
        ? `- **主要阻断**：${topSkipReasons
            .map((item: any) => `${this.safeText(item.reason, 60)} ×${item.count}`)
            .join('；')}`
        : '',
      tradeOutcomes?.summary
        ? `- **交易收益闭环**：跟踪 ${outcomeSummary.total_count ?? 0} 笔；闭环 ${
            outcomeSummary.closed_count ?? 0
          } 笔；超额胜率 ${this.formatPercent(
            outcomeSummary.excess_win_rate
          )}；总盈亏 ${this.formatSignedMoney(outcomeSummary.total_pnl)}`
        : '',
      qualityOverview?.quality_score !== undefined
        ? `- **当前量化信号质量**：${qualityOverview.quality_score} 分；闸门 ${
            qualityOverview.gate?.label || '-'
          }；5日均超额 ${this.formatPercent(qualityOverview.avg_excess_return_pct)}`
        : '',
      strategyExperiment
        ? `- **策略实验反馈**：冠军 ${champion?.label || '-'}（质量分 ${
            champion?.quality_score ?? '-'
          }），基线 ${baseVariant?.label || loopPolicy.effective_style || '-'}（${
            baseVariant?.quality_score ?? '-'
          }），质量差 ${
            strategyExperiment?.quality_delta ?? '-'
          }；共识标的 ${consensusOverlapCount} 个；${
            consensusRanked ? '本轮已按多策略共识优先排序' : '本轮未触发共识排序'
          }`
        : '',
      candidateTuning?.enabled
        ? `- **候选源头调权**：已启用；恢复组合 ${
            candidateTuning.recovered_count || 0
          } 个，延长冷却 ${candidateTuning.extended_cooldown_count || 0} 个，复采样 ${
            candidateTuning.resample_count || 0
          } 个；预算动作策略 ${
            candidateTuning.budget_action_policy_enabled ? '已接入' : '未接入'
          }；候选在进入 Agent 前已按复采样/预算后验调分调仓。`
        : '',
      environmentPolicy?.enabled
        ? `- **环境闸门版本**：${environmentPolicy.snapshot_id || '-'}；默认倍率 ${
            environmentPolicy.default_position_multiplier ?? '--'
          }x；暂停 ${environmentPolicy.blocked_segments?.length || 0} / 降仓 ${
            environmentPolicy.reduced_segments?.length || 0
          } / 放大 ${environmentPolicy.boosted_segments?.length || 0}；${
            environmentPolicy.reason || '按市场/行业环境闭环结果动态调仓'
          }`
        : '',
      strategyEvolution?.add_risk_budget?.length ||
      strategyEvolution?.reduce_risk_budget?.length ||
      strategyEvolution?.observe?.length
        ? `- **资金方向**：加预算 ${formatBudgetTarget(
            strategyEvolution.add_risk_budget?.[0]
          )}；降权 ${formatBudgetTarget(
            strategyEvolution.reduce_risk_budget?.[0]
          )}；观察 ${formatBudgetTarget(strategyEvolution.observe?.[0])}。`
        : '',
      budgetActionRankings.length
        ? `- **预算动作回收**：最佳 ${formatBudgetTarget(
            budgetActionRankings[0]
          )}；最弱 ${formatBudgetTarget(
            [...budgetActionRankings].sort(
              (a: any, b: any) =>
                Number(a.capital_efficiency_score || 0) - Number(b.capital_efficiency_score || 0) ||
                Number(a.avg_excess_return_pct || 0) - Number(b.avg_excess_return_pct || 0)
            )[0]
          )}。`
        : '',
      budgetActionPolicy?.enabled
        ? `- **预算动作自动策略**：${this.safeText(
            budgetActionPolicy.audit_feedback_applied_count
              ? budgetActionPolicy.audit_feedback_reason
              : budgetActionPolicy.reason || '下一轮按预算动作后验自动升降级',
            120
          )}`
        : '',
      budgetPolicyVersion?.enabled
        ? `- **预算权重版本**：${budgetPolicyVersion.version_id || '-'}；指纹 ${
            budgetPolicyVersion.version_hash || '-'
          }；动作 ${budgetPolicyVersion.action_count ?? 0} 个；${
            budgetPolicyVersion.reason || '等待后续成交验证'
          }`
        : '',
      budgetPolicyVersion?.underperformance_guard?.action === 'protective_downgrade'
        ? `- **预算权重保护**：${this.safeText(
            budgetPolicyVersion.underperformance_guard.reason ||
              '当前预算权重版本跑输历史冠军，下一轮已自动降级',
            140
          )}`
        : '',
      budgetPolicyVersion?.rollback_plan?.apply
        ? `- **预算版本回滚**：${this.safeText(
            budgetPolicyVersion.rollback_plan.reason || '已继承持久化冠军版本权重',
            140
          )}`
        : '',
      budgetPolicyExecutionAudit?.enabled
        ? `- **预算策略执行审计**：${this.safeText(
            budgetPolicyExecutionAudit.reason || '已开始审计预算动作策略的真实成交收益',
            120
          )}`
        : '',
      budgetPolicyRollbackAudit?.enabled
        ? `- **预算版本回滚审计**：${this.safeText(
            budgetPolicyRollbackAudit.reason || '已开始审计回滚后的真实成交收益',
            120
          )}`
        : '',
      bestPick
        ? `- **首选标的**：${bestPick.name || bestPick.symbol}（${bestPick.symbol}），${
            this.buildInlinePriceText(bestPick) || '当前股价 --'
          }，评分 ${bestPick.score}，动作 ${
            bestPick.action_label || bestPick.action || '-'
          }${formatConsensus(bestPick)}`
        : '',
      '',
      '### 核心候选',
      topPicks.length
        ? topPicks
            .map(
              (item: any, index: number) =>
                `${index + 1}. **${item.name || item.symbol}（${item.symbol}）**：评分 ${
                  item.score
                }，${this.buildInlinePriceText(item) || '当前股价 --'}，${
                  item.action_label || item.action || '-'
                }，风险 ${item.risk_level || '-'}${formatConsensus(item)}，20日 ${
                  item.metrics?.return_20d ?? '--'
                }%，理由：${this.safeText((item.reasons || []).slice(0, 2).join('；'), 260)}`
            )
            .join('\n')
        : '- 暂无候选',
      '',
      '### 闭环说明',
      '- 系统已从全市场候选池自动筛选、归档为可后验验证信号，并可接入 Profit Gate 后进入模拟盘。',
      '- Top 候选会提交 TradingAgents 深度复核；复核结果回写后进入尾盘/场次收益跟踪。',
      `- 当前自适应原因：${
        loopPolicy.reason ||
        '下一轮会使用信号后验超额收益继续反哺候选评分，连续跑输市场的标的会被自动降权。'
      }`,
    ]
      .filter(Boolean)
      .join('\n');

    return this.safeAppend({
      文本: `${recordType} - 候选 ${generated.analyzed_candidates ?? 0}/${
        generated.total_candidates ?? 0
      } - 归档 ${archive.total ?? 0} - 模拟盘 ${paper?.executed ?? paper?.planned ?? 0}`,
      message: markdownMessage,
      记录类型: recordType,
      任务名称: '全市场自动荐股闭环',
      任务类型: options.task_type || 'AUTO_RECOMMENDATION_LOOP',
      运行状态: options.error ? 'FAILED' : 'COMPLETED',
      候选范围: result?.universe,
      推荐风格: result?.style,
      闭环自适应: loopPolicy?.enabled ? '已启用' : '未启用',
      闭环样本数: loopPolicy?.closed_samples,
      自适应最低评分: loopPolicy?.effective_min_score,
      自适应仓位倍率: loopPolicy?.position_multiplier,
      自适应默认仓位: loopPolicy?.effective_default_position_pct,
      自适应最大仓位: loopPolicy?.effective_max_position_pct,
      自适应跟单数量: loopPolicy?.effective_paper_trade_limit,
      自适应原因: loopPolicy?.reason,
      闭环运行ID: result?.loop_run_id,
      策略快照ID: policySnapshot?.id,
      候选总数: generated.total_candidates,
      有效评分数: generated.analyzed_candidates,
      归档信号数: archive.total,
      新增信号数: archive.created,
      更新信号数: archive.updated,
      Agent提交数: Array.isArray(agentAnalysis.submitted) ? agentAnalysis.submitted.length : '',
      Agent失败数: Array.isArray(agentAnalysis.failed) ? agentAnalysis.failed.length : '',
      验证完成数: verification.verified,
      等待验证数: verification.pending,
      无数据信号数: verification.no_data,
      模拟盘成交数: paper?.executed,
      模拟盘计划数: paper?.planned,
      模拟盘跳过数: paper?.skipped,
      组合风险状态: riskProfile?.status?.label,
      组合风险结论: riskProfile?.status?.conclusion,
      组合现金水位: this.formatPercent(riskMetrics.cash_pct),
      组合总仓位: this.formatPercent(riskMetrics.exposure_pct),
      组合回撤: this.formatPercent(riskMetrics.drawdown_pct),
      风险闸门动作: riskGatePolicy?.action,
      风险闸门原因: riskGatePolicy?.reason,
      风险闸门后验动作: loopPolicy?.risk_gate_feedback_action,
      风险闸门后验原因: loopPolicy?.risk_gate_feedback_reason,
      风险阈值建议状态: thresholdStability?.label,
      风险阈值建议置信度:
        thresholdStability?.confidence !== undefined
          ? Number(thresholdStability.confidence).toFixed(2)
          : '',
      风险阈值建议原因: thresholdStability?.reason,
      共识模拟盘成交数: paper?.consensus_executed,
      共识模拟盘计划数: paper?.consensus_planned,
      跟踪交易数: outcomeSummary.total_count,
      已闭环交易数: outcomeSummary.closed_count,
      当前持仓数: outcomeSummary.open_count,
      模拟交易总盈亏: this.formatSignedMoney(outcomeSummary.total_pnl),
      模拟交易超额胜率: this.formatPercent(outcomeSummary.excess_win_rate),
      质量分: qualityOverview.quality_score,
      平均收益: this.formatPercent(qualityOverview.avg_return_pct),
      平均超额收益: this.formatPercent(qualityOverview.avg_excess_return_pct),
      胜率: this.formatPercent(qualityOverview.positive_rate),
      超额胜率: this.formatPercent(qualityOverview.excess_positive_rate),
      策略实验冠军: champion?.label,
      策略实验质量差: strategyExperiment?.quality_delta,
      策略实验是否切换: loopPolicy?.strategy_experiment_feedback_applied ? '是' : '否',
      策略实验原因: loopPolicy?.strategy_experiment_feedback_reason,
      环境闸门版本: environmentPolicy?.snapshot_id,
      环境闸门倍率: environmentPolicy?.default_position_multiplier,
      环境闸门置信度: environmentPolicy?.confidence,
      环境闸门原因: environmentPolicy?.reason,
      预算动作自动策略: budgetActionPolicy?.enabled ? '是' : '否',
      预算动作策略原因: budgetActionPolicy?.reason,
      预算审计反哺条数: budgetActionPolicy?.audit_feedback_applied_count,
      预算审计反哺原因: budgetActionPolicy?.audit_feedback_reason,
      预算权重版本: budgetPolicyVersion?.version_id,
      预算权重指纹: budgetPolicyVersion?.version_hash,
      预算权重保护:
        budgetPolicyVersion?.underperformance_guard?.action === 'protective_downgrade'
          ? budgetPolicyVersion?.underperformance_guard?.reason
          : '',
      预算权重冠军版本: budgetPolicyVersion?.underperformance_guard?.champion_version_id,
      预算版本回滚: budgetPolicyVersion?.rollback_plan?.apply
        ? budgetPolicyVersion?.rollback_plan?.reason
        : '',
      预算版本回滚来源: budgetPolicyVersion?.rollback_plan?.source_version_id,
      预算策略执行审计: budgetPolicyExecutionAudit?.enabled ? '是' : '否',
      预算策略审计原因: budgetPolicyExecutionAudit?.reason,
      预算版本回滚审计: budgetPolicyRollbackAudit?.enabled ? '是' : '否',
      预算版本回滚审计原因: budgetPolicyRollbackAudit?.reason,
      预算版本回滚有效数: budgetPolicyRollbackAudit?.effective_count,
      预算版本回滚无效数: budgetPolicyRollbackAudit?.ineffective_count,
      共识排序: consensusRanked ? '是' : '否',
      共识标的数: consensusOverlapCount,
      候选源头调权: candidateTuning?.enabled ? '是' : '否',
      最佳标的: bestPick
        ? `${bestPick.name || bestPick.symbol}(${bestPick.symbol}) ${bestPick.score}`
        : '',
      结果摘要: this.safeJson(
        {
          generated: {
            loop_run_id: result?.loop_run_id,
            as_of: generated.as_of,
            universe: generated.universe,
            style: generated.style,
            total_candidates: generated.total_candidates,
            analyzed_candidates: generated.analyzed_candidates,
            consensus_ranked: consensusRanked,
            consensus_overlap_count: consensusOverlapCount,
            consensus_top_picks: consensusTopPicks,
            recommendations: topPicks,
          },
          archive,
          loop_policy: loopPolicy,
          environment_policy: environmentPolicy,
          strategy_experiment: strategyExperiment,
          policy_snapshot: policySnapshot,
          agent_analysis: agentAnalysis,
          verification,
          paper_trading: {
            portfolio_id: paper?.portfolio_id,
            dry_run: paper?.dry_run,
            scanned: paper?.scanned,
            eligible: paper?.eligible,
            executed: paper?.executed,
            planned: paper?.planned,
            skipped: paper?.skipped,
            consensus_executed: paper?.consensus_executed,
            consensus_planned: paper?.consensus_planned,
            consensus_top_trades: paper?.consensus_top_trades,
            skip_reason_summary: paper?.skip_reason_summary,
            trades: Array.isArray(paper?.trades) ? paper.trades.slice(0, 10) : [],
            profit_gate_policy: paper?.profit_gate_policy,
            outcome_feedback_policy: paper?.outcome_feedback_policy,
            environment_guard_policy: paper?.environment_guard_policy,
            risk_profile: paper?.risk_profile,
          },
          risk_profile: riskProfile,
          risk_threshold_stability: thresholdStability,
          risk_threshold_attribution: riskThresholdAttribution,
          risk_threshold_field_gate_advice: riskThresholdFieldGateAdvice,
          risk_threshold_field_gate_adjustment_attribution: fieldGateAdjustmentAttribution,
          trade_outcomes: tradeOutcomes,
          quality_report: result?.quality_report,
        },
        10000
      ),
      错误信息: this.errorMessage(options.error),
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
      `- **重新验证完成**：${result?.verification?.verified ?? 0} 条；等待周期 ${
        result?.verification?.pending ?? 0
      } 条；仍无数据 ${result?.verification?.no_data ?? 0} 条`,
      `- **最终可验证**：${final.ready_for_verification ?? 0} 条；周期未完成 ${
        final.insufficient_horizon_bars ?? 0
      } 条；缺行情 ${final.missing_bars ?? 0} 条`,
      '',
      '### 核心理由',
      final.no_data_signals > 0 || final.insufficient_horizon_bars > 0
        ? '仍存在不可验证样本，主要由行情缺失、股票映射缺失或后验周期尚未走完导致。系统已尽量补齐缺失行情，后续每日同步后会继续滚动验证。'
        : '缺失行情已补齐，当前样本具备后验验证条件，可以进入收益统计与策略反哺。',
      failedSymbols.length
        ? `\n### 同步失败股票\n${failedSymbols
            .slice(0, 20)
            .map(symbol => `- ${symbol}`)
            .join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    return this.safeAppend({
      文本: `${recordType} - 补行情 ${syncedSymbols.length} 只 / 完成 ${
        result?.verification?.verified ?? 0
      } 条 / 等待 ${result?.verification?.pending ?? 0} 条`,
      message: markdownMessage,
      记录类型: recordType,
      任务名称: 'AI信号收益验证修复',
      任务类型: 'SIGNAL_VERIFICATION_REPAIR',
      运行状态: 'COMPLETED',
      总数: initial.total_signals,
      完成数: result?.verification?.verified,
      等待数: result?.verification?.pending,
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

  async reportQuantDailyPipeline(
    result: any,
    options: {
      record_type?: string;
      task_type?: string;
      error?: any;
    } = {}
  ) {
    const recordType = options.record_type || '量化策略扫描闭环';
    const generated = result?.generated || {};
    const fusion = result?.fusion || {};
    const archive = result?.archive || {};
    const agent = result?.agent_analysis || {};
    const paper = result?.paper_trading || {};
    const riskProfile = result?.risk_profile || paper?.risk_profile || {};
    const riskMetrics = riskProfile?.risk_metrics || {};
    const riskThresholdSuggestion =
      result?.risk_threshold_suggestion || result?.risk_profile_gate?.threshold_version || {};
    const riskThresholdStability =
      riskThresholdSuggestion?.stability || riskThresholdSuggestion?.suggestion_stability || {};
    const riskThresholdAttribution =
      riskThresholdSuggestion?.attribution || riskThresholdSuggestion?.threshold_attribution || {};
    const riskThresholdFieldGateAdvice = riskThresholdSuggestion?.field_gate_advice || {};
    const riskThresholdFieldGateAdjustmentAttribution =
      riskThresholdSuggestion?.field_gate_adjustment_attribution || {};
    const topCandidates = Array.isArray(fusion.top_candidates) ? fusion.top_candidates : [];
    const best = topCandidates[0] || {};
    const quoteSync = generated?.quote_sync || {};
    const factorSync = generated?.factor_sync || {};
    const activeScanParams = generated?.active_scan_params || {};
    const activeScanSummary = activeScanParams?.summary || {};
    const activeScanLifecycle = activeScanParams?.lifecycle || generated?.param_lifecycle || {};
    const riskAdjustedPolicy = activeScanLifecycle?.risk_adjusted_policy;
    const activeScanSelections = Array.isArray(activeScanParams?.selections)
      ? activeScanParams.selections
      : [];
    const bestRawFactors = best?.factors?.best_raw_factors || {};
    const bestPriceSource = bestRawFactors.price_source || best.price_source;
    const bestLatestQuoteTime = bestRawFactors.latest_quote_time || best.latest_quote_time;
    const experimentParamSuggestion = generated?.experiment_param_suggestion || {};
    const experimentParamSummary = experimentParamSuggestion.summary || {};
    const adoptedStrategyKeys = Array.isArray(experimentParamSuggestion.adopted_strategy_keys)
      ? experimentParamSuggestion.adopted_strategy_keys
      : [];
    const topReasons = Array.isArray(best.reasons) ? best.reasons.slice(0, 3) : [];
    const topWarnings = Array.isArray(best.risk_flags) ? best.risk_flags.slice(0, 3) : [];
    const submitted = Array.isArray(agent.submitted) ? agent.submitted.length : 0;
    const failed = Array.isArray(agent.failed) ? agent.failed.length : 0;
    const paperAction = paper
      ? `${paper.dry_run ? '预演' : '执行'} ${paper.executed ?? paper.planned ?? 0} 笔，跳过 ${
          paper.skipped ?? 0
        } 条`
      : '未触发';
    const scenarioLabel = '量化交易场景推荐';

    const markdownMessage = [
      `## ${recordType}`,
      '',
      `> 场景：${scenarioLabel}。候选由量化指标全市场扫描生成，随后可进入 Agent 复核与 20W 模拟盘闭环验证。`,
      '',
      '### 结论',
      `- **推荐场景**：${scenarioLabel}`,
      `- **扫描范围**：${result?.universe === 'favorites' ? '自选池' : '全市场'}；交易日 ${
        result?.trade_date || '-'
      }`,
      `- **量化覆盖**：扫描 ${generated.scanned_stocks ?? 0} 只股票，策略 ${
        generated.strategy_count ?? 0
      } 个，生成 ${generated.signal_count ?? 0} 条原始信号。`,
      quoteSync
        ? `- **实时行情**：落盘 ${quoteSync.persisted_count ?? 0} 条，更新 ${
            quoteSync.updated_stock_count ?? 0
          } 只；最新 ${quoteSync.latest_quote_time || '-'}。`
        : '',
      factorSync
        ? `- **因子刷新**：${factorSync.processed_stock_count ?? 0}/${
            factorSync.requested_stock_count ?? 0
          } 只，估值 ${factorSync.upserts?.valuation ?? 0}，资金流 ${
            factorSync.upserts?.money_flow ?? 0
          }，质量 ${factorSync.upserts?.fundamental ?? 0}；provider ${
            factorSync.provider_plan?.providers?.join('/') || 'local_derived'
          }。`
        : '',
      activeScanSummary.conclusion
        ? `- **参数版本**：${this.safeText(activeScanSummary.conclusion, 160)}`
        : '',
      riskAdjustedPolicy?.enabled
        ? '- **参数护栏**：已启用按策略风险级别的推广/回滚门槛；高波动策略需更多样本与环境桶确认，已回滚参数进入冷却排除。'
        : '',
      experimentParamSummary.conclusion
        ? `- **实验参数反哺**：自动采用 ${experimentParamSummary.use_count ?? 0} 个策略；${
            experimentParamSummary.conclusion
          }`
        : '',
      `- **融合候选**：入选 ${fusion.selected_count ?? archive.total ?? 0} 条；归档 ${
        archive.total ?? 0
      } 条。`,
      `- **Agent复核**：${
        agent.enabled === false ? '未启用' : `提交 ${submitted} 条，失败 ${failed} 条`
      }。`,
      `- **模拟盘**：${paperAction}。`,
      riskProfile?.status
        ? `- **组合风险**：${riskProfile.status.label}；现金 ${this.formatPercent(
            riskMetrics.cash_pct
          )}，总仓位 ${this.formatPercent(riskMetrics.exposure_pct)}，回撤 ${this.formatPercent(
            Math.abs(Number(riskMetrics.drawdown_pct || 0))
          )}，结论：${this.safeText(riskProfile.status.conclusion, 120)}`
        : '',
      riskThresholdStability?.label
        ? `- **阈值建议**：${riskThresholdStability.label}；${
            riskThresholdStability.can_apply ? '建议人工预览后应用' : '暂继续观察'
          }；${this.safeText(riskThresholdStability.reason, 110)}`
        : '',
      this.buildRiskThresholdAttributionLine(riskThresholdAttribution),
      best?.symbol
        ? `- **首选标的**：${best.name || best.symbol}（${best.symbol}），${
            this.buildInlinePriceText(best) || '当前股价 --'
          }，融合分 ${best.score ?? '-'}，动作 ${best.action_label || best.action || '-'}。`
        : '- **首选标的**：暂无达到阈值的候选。',
      '',
      '### 核心理由',
      topReasons.length
        ? topReasons.map((item: string) => `- ${this.safeText(item, 180)}`).join('\n')
        : '- 暂无核心理由。',
      topWarnings.length ? '\n### 主要风险' : '',
      topWarnings.map((item: string) => `- ${this.safeText(item, 180)}`).join('\n'),
    ]
      .filter(Boolean)
      .join('\n');

    return this.safeAppend({
      文本: `${scenarioLabel} - ${recordType} - 入选 ${
        fusion.selected_count ?? archive.total ?? 0
      } / Agent ${submitted} / 模拟盘 ${paper.executed ?? paper.planned ?? 0}`,
      message: markdownMessage,
      记录类型: recordType,
      业务场景: scenarioLabel,
      推荐场景: scenarioLabel,
      任务名称: '量化策略全市场扫描',
      任务类型: options.task_type || 'QUANT_DAILY_PIPELINE',
      运行状态: options.error ? 'FAILED' : 'COMPLETED',
      交易日: result?.trade_date,
      候选范围: result?.universe,
      扫描股票数: generated.scanned_stocks,
      策略数量: generated.strategy_count,
      原始信号数: generated.signal_count,
      融合候选数: fusion.candidate_count,
      入选候选数: fusion.selected_count,
      归档信号数: archive.total,
      Agent提交数: submitted,
      Agent失败数: failed,
      模拟盘成交数: paper.executed,
      模拟盘计划数: paper.planned,
      模拟盘跳过数: paper.skipped,
      最佳标的: best?.symbol
        ? `${best.name || best.symbol}(${best.symbol}) ${best.score ?? '-'}`
        : '',
      最新价: best?.current_price,
      核心理由: topReasons.join('；'),
      风险提示: topWarnings.join('；'),
      实时行情落盘数: quoteSync?.persisted_count,
      实时行情更新股票数: quoteSync?.updated_stock_count,
      实时行情最新时间: quoteSync?.latest_quote_time,
      最佳标的价格源: bestPriceSource,
      最佳标的行情时间: bestLatestQuoteTime,
      因子刷新股票数: factorSync?.processed_stock_count,
      因子刷新Provider: factorSync?.provider_plan?.providers?.join(', '),
      因子估值写入数: factorSync?.upserts?.valuation,
      因子资金流写入数: factorSync?.upserts?.money_flow,
      因子质量写入数: factorSync?.upserts?.fundamental,
      扫描参数版本采用数: activeScanSummary?.adopted_strategy_count,
      扫描参数版本网格数: activeScanSummary?.grid_search_count,
      扫描参数版本冠军数: activeScanSummary?.champion_count,
      扫描参数版本实验数: activeScanSummary?.experiment_count,
      扫描参数版本结论: activeScanSummary?.conclusion,
      参数生命周期推广数: activeScanLifecycle?.summary?.promotion_count,
      参数生命周期降级数: activeScanLifecycle?.summary?.degradation_count,
      参数生命周期回滚数: activeScanLifecycle?.summary?.rollback_count,
      参数风险自适应护栏: riskAdjustedPolicy?.enabled ? 'enabled' : '',
      实验参数采用策略: adoptedStrategyKeys.join(', '),
      实验参数采用数: experimentParamSummary.use_count,
      实验参数建议结论: experimentParamSummary.conclusion,
      组合风险状态: riskProfile?.status?.label,
      组合风险结论: riskProfile?.status?.conclusion,
      组合现金水位: this.formatPercent(riskMetrics.cash_pct),
      组合总仓位: this.formatPercent(riskMetrics.exposure_pct),
      组合回撤: this.formatPercent(riskMetrics.drawdown_pct),
      风险阈值建议状态: riskThresholdStability?.label,
      风险阈值建议置信度:
        riskThresholdStability?.confidence !== undefined
          ? Number(riskThresholdStability.confidence).toFixed(2)
          : '',
      风险阈值建议原因: riskThresholdStability?.reason,
      结果摘要: this.safeJson(
        {
          generated,
          quote_sync: quoteSync,
          factor_sync: factorSync,
          active_scan_params: {
            summary: activeScanSummary,
            selections: activeScanSelections.slice(0, 20),
            lifecycle: activeScanLifecycle,
          },
          best_price_source: {
            symbol: best?.symbol,
            price_source: bestPriceSource,
            latest_quote_time: bestLatestQuoteTime,
            current_price: best?.current_price,
          },
          fusion: {
            candidate_count: fusion.candidate_count,
            selected_count: fusion.selected_count,
            top_candidates: topCandidates.slice(0, 10),
          },
          archive: {
            created: archive.created,
            updated: archive.updated,
            total: archive.total,
            signal_ids: archive.signal_ids,
          },
          agent_analysis: {
            enabled: agent.enabled,
            submitted: Array.isArray(agent.submitted) ? agent.submitted : [],
            failed: Array.isArray(agent.failed) ? agent.failed : [],
            skipped: Array.isArray(agent.skipped) ? agent.skipped.slice(0, 10) : [],
          },
          paper_trading: paper
            ? {
                portfolio_id: paper.portfolio_id,
                dry_run: paper.dry_run,
                executed: paper.executed,
                planned: paper.planned,
                skipped: paper.skipped,
                trades: Array.isArray(paper.trades) ? paper.trades.slice(0, 10) : [],
              }
            : null,
          risk_profile: riskProfile,
          risk_threshold_suggestion: riskThresholdSuggestion,
          risk_threshold_attribution: riskThresholdAttribution,
          risk_threshold_field_gate_advice: riskThresholdFieldGateAdvice,
          risk_threshold_field_gate_adjustment_attribution:
            riskThresholdFieldGateAdjustmentAttribution,
        },
        10000
      ),
      错误信息: this.errorMessage(options.error),
      创建时间: this.formatDate(new Date()),
    });
  }

  async reportQuantOpenWatchdog(
    result: any,
    options: {
      record_type?: string;
      task_type?: string;
      error?: any;
    } = {}
  ) {
    const recordType = options.record_type || '量化开盘链路看门狗';
    const scenarioLabel = '量化交易场景推荐';
    const status = result?.status || (options.error ? 'critical' : 'unknown');
    const checks = result?.checks || {};
    const quote = checks.quote_persistence || {};
    const latestLog = result?.latest_log || {};
    const issues = Array.isArray(result?.issues) ? result.issues : [];
    const topIssues = issues.slice(0, 3);
    const statusLabel =
      status === 'healthy' ? '正常' : status === 'warning' ? '需要观察' : '关键异常';
    const quoteLine = quote.persisted
      ? `已落盘 ${quote.latest_trade_date_snapshot_count ?? 0} 条 / ${
          quote.latest_trade_date_symbol_count ?? 0
        } 只，最新 ${quote.latest_quote_time || '-'}，新鲜度 ${quote.age_minutes ?? '-'} 分钟`
      : '尚未落盘';

    const markdownMessage = [
      `## ${recordType}`,
      '',
      `> 场景：${scenarioLabel}。该记录只汇总结论和核心原因，用于判断明日开盘推荐链路是否可用。`,
      '',
      '### 结论',
      `- **链路状态**：${statusLabel}（${status}）`,
      `- **交易日**：${result?.trade_date || '-'}`,
      `- **任务执行**：${
        latestLog?.status
          ? `${latestLog.status}；开始 ${this.formatDate(latestLog.started_at) || '-'}`
          : '未发现今日执行日志'
      }`,
      `- **信号/归档**：量化信号 ${checks.quant_signal_count ?? 0}/${
        checks.min_quant_signals ?? 0
      }；归档 ${checks.archived_signal_count ?? 0}/${checks.min_archived_signals ?? 0}`,
      `- **实时行情**：${quoteLine}`,
      `- **模拟盘成交**：${checks.paper_trade_count ?? 0} 笔`,
      `- **核心判断**：${this.safeText(result?.conclusion || '', 180)}`,
      topIssues.length ? '' : '',
      topIssues.length ? '### 核心异常' : '',
      topIssues
        .map(
          (issue: any) => `- **${issue.code || issue.level}**：${this.safeText(issue.message, 180)}`
        )
        .join('\n'),
    ]
      .filter(Boolean)
      .join('\n');

    return this.safeAppend({
      文本: `${scenarioLabel} - ${recordType} - ${statusLabel}`,
      message: markdownMessage,
      记录类型: recordType,
      业务场景: scenarioLabel,
      推荐场景: scenarioLabel,
      任务名称: result?.target_task?.name || '量化策略开盘机会扫描',
      任务类型: options.task_type || 'QUANT_OPEN_WATCHDOG',
      运行状态: options.error ? 'FAILED' : status === 'healthy' ? 'COMPLETED' : 'WARNING',
      交易日: result?.trade_date,
      目标任务ID: result?.target_task?.id,
      目标任务状态: result?.target_task?.last_run_status,
      目标任务Cron: result?.target_task?.cron_expression,
      最近日志ID: latestLog?.id,
      最近日志状态: latestLog?.status,
      量化信号数: checks.quant_signal_count,
      归档信号数: checks.archived_signal_count,
      模拟盘成交数: checks.paper_trade_count,
      实时行情状态: quote.freshness_status,
      实时行情最新时间: quote.latest_quote_time,
      实时行情落盘数: quote.latest_trade_date_snapshot_count,
      实时行情股票数: quote.latest_trade_date_symbol_count,
      实时行情年龄分钟: quote.age_minutes,
      核心理由: topIssues.map((issue: any) => issue.message).join('；') || result?.conclusion,
      结果摘要: this.safeJson(
        {
          status,
          trade_date: result?.trade_date,
          target_task: result?.target_task,
          latest_log: result?.latest_log,
          checks: result?.checks,
          issues: topIssues,
          conclusion: result?.conclusion,
        },
        5000
      ),
      错误信息: this.errorMessage(options.error),
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
    const profitGate = result?.profit_gate_policy || {};
    const outcomeFeedback = result?.outcome_feedback_policy || {};
    const environmentGuard = result?.environment_guard_policy || {};
    const entryRiskGuard = result?.entry_risk_guard_policy || {};
    const riskProfile = result?.risk_profile || {};
    const riskMetrics = riskProfile?.risk_metrics || {};
    const riskProfileGate = result?.risk_profile_gate || {};
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
      收益闸门: profitGate?.gate_label,
      收益闸门质量分: profitGate?.quality_score,
      收益闸门仓位倍率: profitGate?.effective_position_multiplier,
      收益闭环样本数: outcomeFeedback?.closed_samples,
      收益闭环平均超额: this.formatPercent(outcomeFeedback?.avg_excess_return_pct),
      收益闭环超额胜率: this.formatPercent(outcomeFeedback?.excess_win_rate),
      收益闭环仓位倍率: outcomeFeedback?.effective_position_multiplier,
      收益闭环结论: outcomeFeedback?.reason,
      环境风控: environmentGuard?.enabled ? environmentGuard.description : '',
      市场环境: firstTrade?.market_regime_label,
      行业环境: firstTrade?.industry_label,
      环境风控仓位倍率: firstTrade?.environment_multiplier,
      环境风控结论: firstTrade?.environment_reason,
      组合风险状态: riskProfile?.status?.label,
      组合风险结论: riskProfile?.status?.conclusion,
      组合现金水位: this.formatPercent(riskMetrics.cash_pct),
      组合总仓位: this.formatPercent(riskMetrics.exposure_pct),
      组合回撤: this.formatPercent(riskMetrics.drawdown_pct),
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
          profit_gate_policy: result?.profit_gate_policy,
          outcome_feedback_policy: result?.outcome_feedback_policy,
          environment_guard_policy: result?.environment_guard_policy,
          risk_profile: riskProfile,
          risk_profile_gate: riskProfileGate,
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
    const riskProfile = result?.risk_profile || {};
    const riskMetrics = riskProfile?.risk_metrics || {};
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
      组合风险状态: riskProfile?.status?.label,
      组合风险结论: riskProfile?.status?.conclusion,
      组合现金水位: this.formatPercent(riskMetrics.cash_pct),
      组合总仓位: this.formatPercent(riskMetrics.exposure_pct),
      组合回撤: this.formatPercent(riskMetrics.drawdown_pct),
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
          risk_profile: riskProfile,
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

  async reportRecommendationTradeOutcomes(
    result: any,
    options: {
      record_type?: string;
      task_type?: string;
      error?: any;
    } = {}
  ) {
    const recordType = options.record_type || '推荐交易收益闭环';
    const summary = result?.summary || {};
    const feedback = result?.feedback || {};
    const bestSegments = Array.isArray(feedback.best_segments) ? feedback.best_segments : [];
    const weakSegments = Array.isArray(feedback.weak_segments) ? feedback.weak_segments : [];
    const consensusSegments = Array.isArray(result?.groups?.by_consensus)
      ? result.groups.by_consensus
      : [];
    const bestConsensusSegment = consensusSegments
      .filter((item: any) => item.key !== 'no_consensus' && Number(item.closed_count || 0) > 0)
      .sort(
        (a: any, b: any) =>
          Number(b.avg_excess_return_pct || 0) - Number(a.avg_excess_return_pct || 0)
      )[0];
    const bestTrade = summary.best_trade || {};
    const worstTrade = summary.worst_trade || {};
    const markdownMessage = this.buildRecommendationTradeOutcomesMarkdown(
      result,
      options,
      recordType
    );

    return this.safeAppend({
      文本: `${recordType} - 闭环 ${summary.closed_count ?? 0} 笔 / 超额胜率 ${
        summary.excess_win_rate ?? 0
      }% / 总盈亏 ${this.formatSignedMoney(summary.total_pnl)} - ${this.formatDate(new Date())}`,
      message: markdownMessage,
      记录类型: recordType,
      任务名称: '推荐信号模拟交易收益闭环',
      任务类型: options.task_type || 'RECOMMENDATION_TRADE_OUTCOME_REFRESH',
      运行状态: options.error ? 'FAILED' : 'COMPLETED',
      模拟盘ID: result?.portfolio_id,
      用户ID: result?.user_id,
      生成时间: result?.generated_at,
      已跟踪交易数: summary.total_count,
      已闭环交易数: summary.closed_count,
      当前持仓数: summary.open_count,
      胜率: this.formatPercent(summary.win_rate),
      超额胜率: this.formatPercent(summary.excess_win_rate),
      平均收益: this.formatPercent(summary.avg_closed_return_pct),
      平均超额收益: this.formatPercent(summary.avg_excess_return_pct),
      总实现盈亏: this.formatSignedMoney(summary.total_realized_pnl),
      总浮动盈亏: this.formatSignedMoney(summary.total_unrealized_pnl),
      总盈亏: this.formatSignedMoney(summary.total_pnl),
      盈亏比: summary.payoff_ratio,
      ProfitFactor: summary.profit_factor,
      平均MFE: this.formatPercent(summary.avg_mfe_pct),
      平均MAE: this.formatPercent(summary.avg_mae_pct),
      建议最低评分: feedback.recommended_min_score,
      建议仓位倍率: feedback.position_multiplier,
      建议风险等级: Array.isArray(feedback.allowed_risk_levels)
        ? feedback.allowed_risk_levels.join(',')
        : '',
      最佳标的: bestTrade?.symbol
        ? `${bestTrade.name || bestTrade.symbol}(${bestTrade.symbol}) ${this.formatPercent(
            bestTrade.total_pnl_pct
          )}`
        : '',
      最差标的: worstTrade?.symbol
        ? `${worstTrade.name || worstTrade.symbol}(${worstTrade.symbol}) ${this.formatPercent(
            worstTrade.total_pnl_pct
          )}`
        : '',
      最强片段: bestSegments
        .slice(0, 3)
        .map((item: any) => `${item.label}:${this.formatPercent(item.avg_excess_return_pct)}`)
        .join(', '),
      待降权片段: weakSegments
        .slice(0, 3)
        .map((item: any) => `${item.label}:${this.formatPercent(item.avg_excess_return_pct)}`)
        .join(', '),
      最强共识片段: bestConsensusSegment
        ? `${bestConsensusSegment.label}:${this.formatPercent(
            bestConsensusSegment.avg_excess_return_pct
          )}/${bestConsensusSegment.closed_count}样本`
        : '',
      结果摘要: this.safeJson(
        {
          summary,
          feedback,
          groups: result?.groups,
          outcomes: Array.isArray(result?.outcomes) ? result.outcomes.slice(0, 30) : [],
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
    const adaptiveRisk =
      summary.adaptive_risk_policy || result?.risk_check?.adaptive_risk_policy || {};
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
      收益闭环样本数: summary.outcome_closed_samples,
      收益闭环平均超额: this.formatPercent(summary.outcome_avg_excess_return_pct),
      收益闭环超额胜率: this.formatPercent(summary.outcome_excess_win_rate),
      收益闭环仓位倍率: summary.outcome_position_multiplier,
      收益闭环结论: summary.outcome_reason,
      自适应风控状态: adaptiveRisk?.enabled ? (adaptiveRisk.applied ? '已应用' : '观察中') : '',
      自适应风控结论: adaptiveRisk?.reason,
      自适应止损: this.formatPercent(adaptiveRisk?.effective_stop_loss_pct),
      自适应止盈: this.formatPercent(adaptiveRisk?.effective_take_profit_pct),
      自适应移动止盈: adaptiveRisk?.enabled
        ? `${this.formatPercent(
            adaptiveRisk?.effective_trailing_activation_pct
          )}/${this.formatPercent(adaptiveRisk?.effective_trailing_drawdown_pct)}`
        : '',
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
          outcome_feedback_policy: result?.entry_preview?.outcome_feedback_policy,
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
          message:
            failed
              .map(item => item.message)
              .filter(Boolean)
              .join('; ') || '写入失败',
          segments: records.length,
          results,
        };
      }

      if (skipped.length === results.length) {
        return {
          success: false,
          skipped: true,
          message:
            skipped
              .map(item => item.message)
              .filter(Boolean)
              .join('; ') || '已跳过写入',
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

  private buildRiskThresholdAttributionLine(attribution: any): string {
    const items = Array.isArray(attribution?.items) ? attribution.items : [];
    const focus = items
      .filter((item: any) => ['tighten', 'relax'].includes(String(item?.action || '')))
      .sort((a: any, b: any) => Number(b.confidence || 0) - Number(a.confidence || 0))[0];
    if (!focus) return '';
    const actionLabel = focus.action === 'tighten' ? '建议收紧' : '可观察放松';
    return `- **阈值归因**：${focus.label || focus.key}${actionLabel}；触发 ${
      focus.triggered_count || 0
    }/${focus.sample_count || 0} 次；${this.safeText(focus.reason, 110)}`;
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
      this.pickReadableField(parsedRationale, [
        'rationale',
        'summary',
        'executive_summary',
        'reason',
      ]),
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
      return value
        .map(item => this.toReadableText(item))
        .filter(Boolean)
        .join('\n');
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

  private buildCompactSkipReasonLines(result: any, skippedItems: any[], limit = 3): string[] {
    const topReasons = Array.isArray(result?.skip_reason_summary?.top_reasons)
      ? result.skip_reason_summary.top_reasons
      : [];
    if (topReasons.length > 0) {
      return topReasons
        .slice(0, limit)
        .map((item: any) => `- ${this.safeText(item.reason || '未说明原因', 120)} ×${item.count}`);
    }

    const reasonMap = new Map<string, number>();
    for (const item of skippedItems || []) {
      const reason = this.safeText(item?.reason || item?.message || '未说明原因', 120);
      reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
    }
    return [...reasonMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([reason, count]) => `- ${reason} ×${count}`);
  }

  private buildPaperTradingAutomationMarkdown(
    result: any,
    options: { error?: any },
    recordType: string
  ): string {
    const trades = Array.isArray(result?.trades) ? result.trades : [];
    const skippedItems = Array.isArray(result?.skipped_items) ? result.skipped_items : [];
    const snapshot = result?.snapshot || {};
    const profitGate = result?.profit_gate_policy || {};
    const outcomeFeedback = result?.outcome_feedback_policy || {};
    const environmentGuard = result?.environment_guard_policy || {};
    const entryRiskGuard = result?.entry_risk_guard_policy || {};
    const riskProfile = result?.risk_profile || {};
    const riskMetrics = riskProfile?.risk_metrics || {};
    const riskProfileGate = result?.risk_profile_gate || {};
    const dryRun = Boolean(result?.dry_run);
    const status = options.error ? 'FAILED' : 'COMPLETED';
    const actionCount = dryRun
      ? (result?.planned ?? trades.length)
      : (result?.executed ?? trades.length);
    const skipReasonLines = this.buildCompactSkipReasonLines(result, skippedItems, 3);

    const lines = [
      `## ${recordType}`,
      '',
      '### 结果',
      `- **运行状态**：${status}`,
      `- **本次${dryRun ? '计划买入' : '模拟买入'}**：${actionCount} 笔；跳过 ${
        result?.skipped ?? skippedItems.length
      } 条`,
      `- **处理信号**：扫描 ${result?.scanned ?? 0} 条，符合条件 ${result?.eligible ?? 0} 条`,
      snapshot?.total_value !== undefined
        ? `- **模拟盘资产**：总资产 ¥${this.formatMoney(
            snapshot.total_value
          )}，现金 ¥${this.formatMoney(snapshot.current_cash)}，持仓 ¥${this.formatMoney(
            snapshot.position_value
          )}`
        : '',
      profitGate?.gate_label
        ? `- **收益闸门**：${profitGate.gate_label}，仓位倍率 ${
            profitGate.effective_position_multiplier ?? '--'
          }x`
        : '',
      outcomeFeedback?.reason
        ? `- **闭环判断**：${this.safeText(outcomeFeedback.reason, 180)}`
        : '',
      environmentGuard?.enabled
        ? `- **环境风控**：已接入大盘/行业状态；压力市和弱行业降仓，压力市+弱行业禁入`
        : '',
      entryRiskGuard?.enabled
        ? `- **入场暴露**：总暴露 ${entryRiskGuard.current_exposure_pct ?? 0}%；今日新增 ${
            entryRiskGuard.today_new_exposure_pct ?? 0
          }%；现金底线 ${entryRiskGuard.min_cash_reserve_pct ?? '--'}%；组合回撤 ${
            entryRiskGuard.portfolio_drawdown_pct ?? 0
          }%；相关性/VaR已约束；策略预算已约束`
        : '',
      riskProfileGate?.quote_freshness_action === 'reduce'
        ? `- **行情新鲜度**：${this.safeText(
            riskProfileGate.quote_freshness_reason,
            120
          )}；仓位倍率 ${riskProfileGate.quote_freshness_multiplier ?? 0.5}x`
        : '',
      riskProfile?.status
        ? `- **组合风险**：${riskProfile.status.label}；现金 ${this.formatPercent(
            riskMetrics.cash_pct
          )}，总仓位 ${this.formatPercent(riskMetrics.exposure_pct)}，回撤 ${this.formatPercent(
            Math.abs(Number(riskMetrics.drawdown_pct || 0))
          )}；${this.safeText(riskProfile.status.conclusion, 120)}`
        : '',
    ];

    if (trades.length > 0) {
      lines.push('', `### ${dryRun ? '计划买入' : '买入明细'}`);
      trades.slice(0, 5).forEach((trade: any, index: number) => {
        const quoteText = this.buildInlinePriceText(trade, '当前股价') || '当前股价 --';
        const executeText = this.buildInlinePriceText(
          { execute_price: trade.execute_price },
          dryRun ? '预估成交价' : '成交价'
        );
        lines.push(
          `${index + 1}. **${trade.name || trade.symbol}（${trade.symbol}）**：${
            trade.quantity ?? '-'
          }股，${quoteText}${executeText ? `；${executeText}` : ''}；金额 ¥${this.formatMoney(
            trade.amount
          )}；目标仓位 ${trade.target_position_pct ?? '--'}%`,
          `   - 结论：${this.buildPaperTradeDecisionSummary(trade)}`
        );
      });
      if (trades.length > 5) {
        lines.push(`- 其余 ${trades.length - 5} 笔已省略，请在页面查看。`);
      }
    } else {
      lines.push('', '### 本次没有买入');
      lines.push(
        skipReasonLines.length ? '主要原因：' : '- 没有符合评分、风控、收益闸门和仓位纪律的标的。'
      );
    }

    if (skipReasonLines.length > 0) {
      lines.push('', '### 主要跳过原因');
      lines.push(...skipReasonLines);
    }

    const errorText = this.errorMessage(options.error);
    if (errorText) {
      lines.push('', '### 错误信息', errorText);
    }

    lines.push('', '> 说明：以上为模拟盘结果，只保留结论和关键原因，不代表真实账户交易指令。');

    return this.safeMarkdownMessage(lines.filter(Boolean).join('\n'));
  }

  private buildPaperTradeDecisionSummary(trade: any): string {
    const parts = [
      `评分 ${trade?.score ?? '--'}`,
      `目标仓位 ${trade?.target_position_pct ?? '--'}%`,
      trade?.strategy_max_single_trade_pct
        ? `策略单票≤${trade.strategy_max_single_trade_pct}%`
        : '',
      trade?.strategy_allocation_pct ? `策略预算${trade.strategy_allocation_pct}%` : '',
      trade?.environment_strategy_budget_policy_version_id
        ? `预算版本 ${trade.environment_strategy_budget_policy_version_id}`
        : '',
      trade?.environment_strategy_budget_policy_version_guard_action === 'protective_downgrade'
        ? `版本保护：${this.safeText(
            trade.environment_strategy_budget_policy_version_guard_reason || '已降级',
            70
          )}`
        : '',
      trade?.environment_strategy_budget_reason
        ? `预算：${this.safeText(trade.environment_strategy_budget_reason, 80)}`
        : '',
      trade?.environment_reason ? `环境：${this.safeText(trade.environment_reason, 80)}` : '',
    ].filter(Boolean);
    return parts.join('；');
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
    const adaptiveRisk = result?.adaptive_risk_policy || {};
    const riskProfile = result?.risk_profile || {};
    const riskMetrics = riskProfile?.risk_metrics || {};
    const dryRun = Boolean(result?.dry_run);
    const status = options.error ? 'FAILED' : 'COMPLETED';
    const exitCount = dryRun ? (result?.planned ?? exits.length) : (result?.exited ?? exits.length);

    const lines = [
      `## ${recordType}`,
      '',
      '### 结果',
      `- **运行状态**：${status}`,
      `- **本次${dryRun ? '计划退出' : '模拟卖出'}**：${exitCount} 笔；继续持有 ${
        result?.held ?? heldItems.length
      } 笔`,
      `- **检查持仓**：${result?.checked ?? 0} 笔；触发退出 ${
        result?.exit_candidates ?? exits.length
      } 笔；跳过 ${result?.skipped ?? skippedItems.length} 笔`,
      snapshot?.total_value !== undefined
        ? `- **模拟盘资产**：总资产 ¥${this.formatMoney(
            snapshot.total_value
          )}，现金 ¥${this.formatMoney(snapshot.current_cash)}，持仓 ¥${this.formatMoney(
            snapshot.position_value
          )}`
        : '',
      adaptiveRisk?.enabled
        ? `- **自适应风控**：${
            adaptiveRisk.applied ? '已应用' : '观察中'
          }；止损 ${this.formatPercent(
            adaptiveRisk.effective_stop_loss_pct
          )}，止盈 ${this.formatPercent(
            adaptiveRisk.effective_take_profit_pct
          )}，移动止盈 ${this.formatPercent(
            adaptiveRisk.effective_trailing_activation_pct
          )}/${this.formatPercent(adaptiveRisk.effective_trailing_drawdown_pct)}；${
            adaptiveRisk.reason || ''
          }`
        : '',
      riskProfile?.status
        ? `- **风控后组合风险**：${riskProfile.status.label}；现金 ${this.formatPercent(
            riskMetrics.cash_pct
          )}，总仓位 ${this.formatPercent(riskMetrics.exposure_pct)}，回撤 ${this.formatPercent(
            Math.abs(Number(riskMetrics.drawdown_pct || 0))
          )}；${this.safeText(riskProfile.status.conclusion, 120)}`
        : '',
    ];

    if (exits.length > 0) {
      lines.push('', `### ${dryRun ? '计划退出' : '卖出明细'}`);
      exits.slice(0, 5).forEach((item: any, index: number) => {
        const pnlPrefix = Number(item.realized_pnl || 0) >= 0 ? '+' : '';
        const quoteText = this.buildInlinePriceText(item, '当前股价') || '当前股价 --';
        const costText = this.buildInlinePriceText({ avg_cost: item.avg_cost }, '持仓成本');
        const executeText = this.buildInlinePriceText(
          { execute_price: item.execute_price },
          dryRun ? '预估卖出价' : '卖出价'
        );
        const trailingText =
          item.reason === 'trailing_take_profit'
            ? `；峰值收益 ${this.formatPercent(item.max_profit_pct) || '--'}，峰值回撤 ${
                this.formatPercent(item.drawdown_from_peak_pct) || '--'
              }`
            : '';
        lines.push(
          `${index + 1}. **${item.name || item.symbol}（${item.symbol}）** - ${
            item.reason_label || item.reason || '风控退出'
          }：${item.quantity ?? '-'}股，${quoteText}${costText ? `；${costText}` : ''}${
            executeText ? `；${executeText}` : ''
          }`,
          `   - 盈亏 ${pnlPrefix}¥${this.formatMoney(item.realized_pnl)}（${
            item.pnl_pct ?? '--'
          }%），持有 ${item.holding_days ?? '--'} 天${
            item.sell_signal_id
              ? `；卖出信号 #${item.sell_signal_id}（${item.sell_signal_score ?? '--'}分）`
              : ''
          }${trailingText}`
        );
      });
      if (exits.length > 5) {
        lines.push(`- 其余 ${exits.length - 5} 笔退出已省略，请在页面查看。`);
      }
    } else {
      lines.push('', '### 本次没有卖出', '- 当前持仓未触发止损、止盈、卖出信号或最大持有期规则。');
    }

    if (heldItems.length > 0) {
      lines.push('', '### 继续观察');
      heldItems.slice(0, 5).forEach((item: any) => {
        const quoteText = this.buildInlinePriceText(item, '当前股价') || '当前股价 --';
        const costText = this.buildInlinePriceText({ avg_cost: item.avg_cost }, '持仓成本');
        lines.push(
          `- **${item.name || item.symbol}（${item.symbol}）**：${quoteText}${
            costText ? `；${costText}` : ''
          }；当前收益 ${item.pnl_pct ?? '--'}%，${item.message || '未触发退出'}`
        );
      });
    }

    if (skippedItems.length > 0) {
      lines.push('', '### 跳过项');
      skippedItems.slice(0, 3).forEach((item: any) => {
        const quoteText = this.buildInlinePriceText(item, '当前股价');
        lines.push(
          `- **${item.name || item.symbol}（${item.symbol}）**：${
            quoteText ? `${quoteText}；` : ''
          }${item.message || '已跳过'}`
        );
      });
    }

    const errorText = this.errorMessage(options.error);
    if (errorText) {
      lines.push('', '### 错误信息', errorText);
    }

    lines.push('', '> 说明：以上为模拟盘风控结果，只保留结论和关键原因，不代表真实账户交易指令。');

    return this.safeMarkdownMessage(lines.filter(Boolean).join('\n'));
  }

  private buildPaperTradingAttributionMarkdown(
    result: any,
    options: { error?: any },
    recordType: string
  ): string {
    const summary = result?.summary || {};
    const feedback = result?.feedback || {};
    const closedTrades = Array.isArray(result?.closed_trades) ? result.closed_trades : [];
    const openPositions = Array.isArray(result?.open_positions) ? result.open_positions : [];
    const status = options.error ? 'FAILED' : 'COMPLETED';

    const lines = [
      `## ${recordType}`,
      '',
      '### 结果',
      `- **运行状态**：${status}`,
      `- **已闭环交易**：${summary.closed_count ?? 0} 笔；当前持仓 ${summary.open_count ?? 0} 只`,
      `- **综合盈亏**：${this.formatSignedMoney(
        summary.total_pnl
      )}（已实现 ${this.formatSignedMoney(
        summary.total_realized_pnl
      )} / 浮动 ${this.formatSignedMoney(summary.total_unrealized_pnl)}）`,
      `- **胜率 / 平均收益**：${this.formatPercent(summary.win_rate) || '0.00%'} / ${
        this.formatPercent(summary.avg_return_pct) || '0.00%'
      }`,
      `- **当前敞口**：¥${this.formatMoney(summary.open_exposure)}（${
        summary.open_exposure_pct ?? 0
      }%）；平均持有 ${summary.avg_holding_days ?? 0} 天`,
    ];

    if (summary.best_trade || summary.worst_trade) {
      lines.push('', '### 最关键样本');
      if (summary.best_trade) {
        lines.push(
          `- **最佳**：${summary.best_trade.name || summary.best_trade.symbol}（${
            summary.best_trade.symbol
          }）${this.buildTradePriceRangeText(summary.best_trade)}；收益 ${this.formatPercent(
            summary.best_trade.realized_pnl_pct
          )}，盈亏 ${this.formatSignedMoney(summary.best_trade.realized_pnl)}，持有 ${
            summary.best_trade.holding_days ?? '--'
          } 天`
        );
      }
      if (summary.worst_trade) {
        lines.push(
          `- **最差**：${summary.worst_trade.name || summary.worst_trade.symbol}（${
            summary.worst_trade.symbol
          }）${this.buildTradePriceRangeText(summary.worst_trade)}；收益 ${this.formatPercent(
            summary.worst_trade.realized_pnl_pct
          )}，盈亏 ${this.formatSignedMoney(summary.worst_trade.realized_pnl)}，原因：${
            summary.worst_trade.exit_reason_label || summary.worst_trade.exit_reason || '-'
          }`
        );
      }
    }

    lines.push('', '### 下一步');
    if (Array.isArray(feedback.next_actions) && feedback.next_actions.length > 0) {
      feedback.next_actions.slice(0, 3).forEach((text: string) => {
        lines.push(`- ${this.safeText(text, 180)}`);
      });
    } else {
      lines.push('- 继续积累模拟盘闭环样本，等待更多平仓结果后再放大或降权。');
    }
    lines.push(
      `- **下一轮信号门槛**：最低评分 ${feedback.recommended_min_score ?? 72}；风险等级 ${
        Array.isArray(feedback.recommended_allowed_risk_levels)
          ? feedback.recommended_allowed_risk_levels.join('、')
          : 'low、medium'
      }`
    );

    if (openPositions.length > 0) {
      lines.push('', '### 当前重点持仓');
      openPositions.slice(0, 5).forEach((item: any) => {
        lines.push(
          `- **${item.name || item.symbol}（${item.symbol}）**：${this.buildTradePriceRangeText(
            item
          )}；浮盈亏 ${this.formatSignedMoney(item.unrealized_pnl)}（${this.formatPercent(
            item.unrealized_pnl_pct
          )}），持有 ${item.holding_days ?? '--'} 天`
        );
      });
    }

    if (closedTrades.length > 0) {
      lines.push('', '### 最近闭环交易');
      closedTrades.slice(0, 5).forEach((item: any, index: number) => {
        lines.push(
          `${index + 1}. **${item.name || item.symbol}（${
            item.symbol
          }）**：${this.buildTradePriceRangeText(item)}；收益 ${this.formatPercent(
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

    lines.push('', '> 说明：以上为模拟盘收益复盘，只保留结论和下一步，不代表真实账户收益承诺。');

    return this.safeMarkdownMessage(lines.filter(Boolean).join('\n'));
  }

  private buildRecommendationTradeOutcomesMarkdown(
    result: any,
    options: { error?: any },
    recordType: string
  ): string {
    const summary = result?.summary || {};
    const feedback = result?.feedback || {};
    const bestSegments = Array.isArray(feedback.best_segments) ? feedback.best_segments : [];
    const weakSegments = Array.isArray(feedback.weak_segments) ? feedback.weak_segments : [];
    const consensusSegments = Array.isArray(result?.groups?.by_consensus)
      ? result.groups.by_consensus
      : [];
    const bestConsensusSegment = consensusSegments
      .filter((item: any) => item.key !== 'no_consensus' && Number(item.closed_count || 0) > 0)
      .sort(
        (a: any, b: any) =>
          Number(b.avg_excess_return_pct || 0) - Number(a.avg_excess_return_pct || 0)
      )[0];
    const noConsensusSegment = consensusSegments.find((item: any) => item.key === 'no_consensus');
    const bestTrade = summary.best_trade || {};
    const worstTrade = summary.worst_trade || {};
    const status = options.error ? 'FAILED' : 'COMPLETED';

    const lines = [
      `## ${recordType}`,
      '',
      '### 结论',
      `- **运行状态**：${status}`,
      `- **跟踪交易**：${summary.total_count ?? 0} 笔；已闭环 ${
        summary.closed_count ?? 0
      } 笔；当前持仓 ${summary.open_count ?? 0} 只`,
      `- **综合盈亏**：${this.formatSignedMoney(summary.total_pnl)}（实现 ${this.formatSignedMoney(
        summary.total_realized_pnl
      )} / 浮动 ${this.formatSignedMoney(summary.total_unrealized_pnl)}）`,
      `- **胜率 / 超额胜率**：${this.formatPercent(summary.win_rate) || '0.00%'} / ${
        this.formatPercent(summary.excess_win_rate) || '0.00%'
      }`,
      `- **平均收益 / 平均超额**：${
        this.formatPercent(summary.avg_closed_return_pct) || '0.00%'
      } / ${this.formatPercent(summary.avg_excess_return_pct) || '0.00%'}`,
      `- **下一轮参数**：最低评分 ${feedback.recommended_min_score ?? 72}；仓位倍率 ${
        feedback.position_multiplier ?? 0.8
      }x；风险等级 ${
        Array.isArray(feedback.allowed_risk_levels)
          ? feedback.allowed_risk_levels.join('、')
          : 'low、medium'
      }`,
      '',
      '### 核心理由',
      bestTrade?.symbol
        ? `- **最佳样本**：${bestTrade.name || bestTrade.symbol}（${
            bestTrade.symbol
          }）${this.buildTradePriceRangeText(bestTrade)}；收益 ${this.formatPercent(
            bestTrade.total_pnl_pct
          )}，超额 ${this.formatPercent(bestTrade.excess_return_pct)}`
        : '- **最佳样本**：暂无',
      worstTrade?.symbol
        ? `- **最弱样本**：${worstTrade.name || worstTrade.symbol}（${
            worstTrade.symbol
          }）${this.buildTradePriceRangeText(worstTrade)}；收益 ${this.formatPercent(
            worstTrade.total_pnl_pct
          )}，超额 ${this.formatPercent(worstTrade.excess_return_pct)}`
        : '',
      bestSegments.length
        ? `- **优先保留片段**：${bestSegments
            .slice(0, 3)
            .map(
              (item: any) =>
                `${item.label}（超额 ${this.formatPercent(item.avg_excess_return_pct)} / ${
                  item.closed_count
                }样本）`
            )
            .join('、')}`
        : '',
      weakSegments.length
        ? `- **需要降权片段**：${weakSegments
            .slice(0, 3)
            .map(
              (item: any) =>
                `${item.label}（超额 ${this.formatPercent(item.avg_excess_return_pct)} / ${
                  item.closed_count
                }样本）`
            )
            .join('、')}`
        : '',
      bestConsensusSegment
        ? `- **多策略共识验证**：${bestConsensusSegment.label} 平均超额 ${this.formatPercent(
            bestConsensusSegment.avg_excess_return_pct
          )} / ${bestConsensusSegment.closed_count}样本；无显式共识 ${this.formatPercent(
            noConsensusSegment?.avg_excess_return_pct
          )}`
        : '',
      `- **过程风险**：平均 MFE ${this.formatPercent(
        summary.avg_mfe_pct
      )}，平均 MAE ${this.formatPercent(summary.avg_mae_pct)}，Profit Factor ${
        summary.profit_factor ?? 0
      }`,
    ];

    if (Array.isArray(feedback.insights) && feedback.insights.length > 0) {
      feedback.insights.slice(0, 3).forEach((item: string) => {
        lines.push(`- ${this.safeText(item, 320)}`);
      });
    }
    if (Array.isArray(feedback.next_actions) && feedback.next_actions.length > 0) {
      feedback.next_actions.slice(0, 3).forEach((item: string) => {
        lines.push(`- ${this.safeText(item, 320)}`);
      });
    }

    const errorText = this.errorMessage(options.error);
    if (errorText) {
      lines.push('', '### 错误信息', errorText);
    }

    lines.push(
      '',
      '> 说明：该消息只保留结论和核心理由，完整明细请查看页面或结果摘要字段；模拟盘收益不代表真实账户承诺收益。'
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
    const outcomePolicy = result?.entry_preview?.outcome_feedback_policy || {};
    const adaptiveRisk =
      summary.adaptive_risk_policy || result?.risk_check?.adaptive_risk_policy || {};
    const status = options.error ? 'FAILED' : 'COMPLETED';
    const urgentActions = actions.filter((action: any) =>
      ['critical', 'high'].includes(action.priority)
    );
    const entryActions = actions.filter((action: any) => action.action_type === 'entry');
    const exitActions = actions.filter((action: any) => action.action_type === 'exit');
    const monitorActions = actions.filter((action: any) => action.action_type === 'monitor');

    const lines = [
      `## ${recordType}`,
      '',
      '### 结果',
      `- **运行状态**：${status}`,
      `- **今日动作**：共 ${summary.action_count ?? actions.length} 条；紧急 ${
        summary.urgent_count ?? urgentActions.length
      } 条`,
      `- **卖出 / 买入 / 观察 / 复盘**：${summary.exit_count ?? 0} / ${
        summary.entry_count ?? 0
      } / ${summary.monitor_count ?? 0} / ${summary.review_count ?? 0}`,
      `- **资金变化**：当前现金 ¥${this.formatMoney(
        summary.current_cash
      )}；卖出回款 ${this.formatSignedMoney(
        summary.planned_sell_cash_inflow
      )}；买入用资 ${this.formatSignedMoney(-Number(summary.planned_buy_cash_outflow || 0))}`,
      `- **计划后现金**：¥${this.formatMoney(summary.projected_cash_after_plan)}`,
      summary.profit_gate_label
        ? `- **收益闸门**：${summary.profit_gate_label}，仓位倍率 ${
            summary.profit_gate_position_multiplier ?? '--'
          }x`
        : '',
      summary.outcome_reason ? `- **闭环判断**：${this.safeText(summary.outcome_reason, 180)}` : '',
      adaptiveRisk?.enabled
        ? `- **自适应风控**：${
            adaptiveRisk.applied ? '已应用' : '观察中'
          }；止损 ${this.formatPercent(
            adaptiveRisk.effective_stop_loss_pct
          )}，止盈 ${this.formatPercent(
            adaptiveRisk.effective_take_profit_pct
          )}，移动止盈 ${this.formatPercent(
            adaptiveRisk.effective_trailing_activation_pct
          )}/${this.formatPercent(adaptiveRisk.effective_trailing_drawdown_pct)}`
        : '',
      Array.isArray(outcomePolicy.blocked_segments) && outcomePolicy.blocked_segments.length
        ? `- **暂停片段**：${outcomePolicy.blocked_segments
            .slice(0, 3)
            .map(
              (item: any) =>
                `${item.label || item.key}(${this.formatPercent(item.avg_excess_return_pct)}/${
                  item.closed_count
                }样本)`
            )
            .join('、')}`
        : '',
    ];

    const renderActionGroup = (title: string, list: any[], limit = 5) => {
      if (!list.length) return;
      lines.push('', `### ${title}`);
      list.slice(0, limit).forEach((item: any, index: number) => {
        lines.push(
          `${index + 1}. **${item.action_label || item.action_type}**${
            item.symbol ? ` - ${item.name || item.symbol}（${item.symbol}）` : ''
          }`,
          `   - 原因：${item.reason || '-'}`,
          item.reference_price !== undefined
            ? `   - ${this.buildInlinePriceText(item, '当前股价/参考价') || '当前股价/参考价 --'}${
                item.quantity ? `；数量：${item.quantity} 股` : ''
              }`
            : '',
          item.estimated_cash_change !== undefined
            ? `   - 现金影响：${this.formatSignedMoney(item.estimated_cash_change)}`
            : '',
          ...(Array.isArray(item.instructions)
            ? item.instructions.slice(0, 2).map((text: string) => `   - ${text}`)
            : [])
        );
      });
    };

    renderActionGroup('优先处理', urgentActions);
    renderActionGroup('计划卖出', exitActions);
    renderActionGroup('计划买入', entryActions);
    renderActionGroup('继续观察', monitorActions, 3);

    const errorText = this.errorMessage(options.error);
    if (errorText) {
      lines.push('', '### 错误信息', errorText);
    }

    lines.push(
      '',
      '> 说明：以上为模拟盘执行计划，只保留今日该做什么和为什么，不代表真实账户交易指令。'
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

  private formatPrice(value: any): string {
    if (value === undefined || value === null || value === '') return '';
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return '';
    return num.toFixed(num >= 100 ? 2 : 3).replace(/\.?0+$/, '');
  }

  private resolveStockPriceValue(item: any): any {
    if (!item || typeof item !== 'object') return undefined;
    return this.firstDefined(
      item.agent_current_price,
      item.current_price,
      item.latest_price,
      item.reference_price,
      item.execute_price,
      item.entry_price,
      item.exit_price,
      item.avg_cost
    );
  }

  private resolveStockPriceLabel(item: any): string {
    const formatted = this.formatPrice(this.resolveStockPriceValue(item));
    return formatted ? `¥${formatted}` : '';
  }

  private buildPriceMarkdownLine(item: any, label = '当前股价'): string {
    const price = this.resolveStockPriceLabel(item);
    if (!price) return '';
    const change = this.firstDefined(
      item?.price_change_pct,
      item?.change_percent,
      item?.latest_change_percent
    );
    const changeText =
      change !== undefined && change !== null && Number.isFinite(Number(change))
        ? `；涨跌幅 ${Number(change).toFixed(2)}%`
        : '';
    return `- **${label}**：${price}${changeText}`;
  }

  private buildInlinePriceText(item: any, label = '当前股价'): string {
    const price = this.resolveStockPriceLabel(item);
    if (!price) return '';
    const change = this.firstDefined(
      item?.price_change_pct,
      item?.change_percent,
      item?.latest_change_percent
    );
    const changeText =
      change !== undefined && change !== null && Number.isFinite(Number(change))
        ? `，涨跌幅 ${Number(change).toFixed(2)}%`
        : '';
    return `${label} ${price}${changeText}`;
  }

  private buildTradePriceRangeText(item: any): string {
    const parts: string[] = [];
    const entry = this.formatPrice(item?.entry_price);
    const exit = this.formatPrice(item?.exit_price);
    const current = this.formatPrice(
      this.firstDefined(item?.current_price, item?.latest_price, item?.reference_price)
    );

    if (entry) parts.push(`入场价 ¥${entry}`);
    if (exit) {
      parts.push(`退出价 ¥${exit}`);
    } else if (current) {
      parts.push(`当前股价 ¥${current}`);
    }

    if (parts.length === 0) {
      const fallback = this.resolveStockPriceLabel(item);
      if (fallback) parts.push(`当前股价 ${fallback}`);
    }

    return parts.join(' / ') || '价格 --';
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
