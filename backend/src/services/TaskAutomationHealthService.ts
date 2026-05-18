import cron from 'node-cron';
import moment from 'moment-timezone';
import { ScheduledTask } from '../models/ScheduledTask';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { RecommendationLoopPolicySnapshot } from '../models/RecommendationLoopPolicySnapshot';
import { dataUpdateQueue } from '../jobs/dataUpdateQueue';
import { aiPollingQueue } from '../jobs/aiPollingQueue';
import { quantBacktestQueue } from '../jobs/quantBacktestQueue';
import { logger } from '../utils/logger';
import { riskThresholdStabilityService } from './RiskThresholdStabilityService';
import { taskParameterAuditService, TaskParameterAuditOperator } from './TaskParameterAuditService';
import { fieldGateAdjustmentAttributionService } from './FieldGateAdjustmentAttributionService';
import { runtimeSchemaHealthService } from './RuntimeSchemaHealthService';

type HealthLevel = 'healthy' | 'warning' | 'critical';

interface AutomationHealthIssue {
  level: Exclude<HealthLevel, 'healthy'>;
  message: string;
  task_name?: string;
  code?: string;
}

type QueueHealthSummary = {
  queue_name: string;
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
  recent_failed: number;
  recent_failed_jobs: Array<{
    id: string | number;
    name?: string;
    failed_reason?: string;
    finished_on?: number;
  }>;
  historical_failed_retained: number;
  error?: string;
};

type RiskLimitSuggestion = {
  action: string;
  reason?: string;
  limits?: Record<string, number>;
  stability?: Record<string, any>;
  attribution?: Record<string, any>;
  threshold_attribution?: Record<string, any>;
  field_stability?: Record<string, any>;
  field_gate_advice?: Record<string, any>;
  field_gate_adjustment_attribution?: Record<string, any>;
};

type ApplyRiskLimitSuggestionOptions = {
  dry_run?: boolean;
  task_ids?: number[];
  source_loop_run_id?: string;
  operator?: TaskParameterAuditOperator;
};

interface HealthTaskSummary {
  id?: number;
  name: string;
  type: string;
  cron_expression?: string;
  is_active?: boolean;
  last_run_at?: Date | string | null;
  last_run_status?: string | null;
  last_log_status?: string | null;
  last_log_started_at?: Date | string | null;
  last_log_completed_at?: Date | string | null;
  parameters?: Record<string, any>;
}

interface HealthChainConfig {
  key: string;
  title: string;
  subtitle: string;
  task_names: string[];
  stale_hours: number;
  critical_if_inactive?: boolean;
  parameter_checks?: Array<{
    task_name: string;
    key: string;
    camel_key?: string;
    expected: boolean | string | number;
    label: string;
    level?: Exclude<HealthLevel, 'healthy'>;
  }>;
}

const CHAIN_CONFIGS: HealthChainConfig[] = [
  {
    key: 'market_data',
    title: '行情数据供给',
    subtitle: '每日增量、全量追赶与基准指数同步，是荐股/后验的底座。',
    task_names: ['每日行情增量同步', '全量股票日线同步', '基准指数行情同步'],
    stale_hours: 72,
    critical_if_inactive: true,
  },
  {
    key: 'auto_recommendation_loop',
    title: '全市场荐股闭环',
    subtitle: '自动扫描 A 股机会、归档信号、触发 Agent 复核与模拟盘采样。',
    task_names: ['量化策略全市场扫描', '全市场荐股闭环'],
    stale_hours: 72,
    critical_if_inactive: true,
    parameter_checks: [
      {
        task_name: '量化策略全市场扫描',
        key: 'run_paper_trading',
        camel_key: 'runPaperTrading',
        expected: true,
        label: '量化候选模拟盘跟单',
        level: 'critical',
      },
      {
        task_name: '量化策略全市场扫描',
        key: 'submit_agent_analysis',
        camel_key: 'submitAgentAnalysis',
        expected: true,
        label: '量化候选进入Agent复核',
      },
      {
        task_name: '量化策略全市场扫描',
        key: 'dry_run',
        camel_key: 'dryRun',
        expected: false,
        label: '量化模拟盘真实记录',
        level: 'warning',
      },
      {
        task_name: '全市场荐股闭环',
        key: 'run_paper_trading',
        camel_key: 'runPaperTrading',
        expected: true,
        label: '自动模拟盘跟单',
        level: 'critical',
      },
      {
        task_name: '全市场荐股闭环',
        key: 'dry_run',
        camel_key: 'dryRun',
        expected: false,
        label: '真实记录模拟盘交易',
        level: 'warning',
      },
      {
        task_name: '全市场荐股闭环',
        key: 'report_to_feishu',
        camel_key: 'reportToFeishu',
        expected: true,
        label: '飞书结果写入',
      },
      {
        task_name: '全市场荐股闭环',
        key: 'use_strategy_experiment_feedback',
        camel_key: 'useStrategyExperimentFeedback',
        expected: true,
        label: '多策略实验反馈',
      },
      {
        task_name: '全市场荐股闭环',
        key: 'use_entry_risk_guard',
        camel_key: 'useEntryRiskGuard',
        expected: true,
        label: '入场风控守门',
      },
      {
        task_name: '全市场荐股闭环',
        key: 'use_profit_gate',
        camel_key: 'useProfitGate',
        expected: true,
        label: 'Profit Gate 收益闸门',
      },
    ],
  },
  {
    key: 'signal_feedback',
    title: '信号后验反馈',
    subtitle: '验证推荐后的 5 日表现，给下一轮评分、仓位和策略版本反哺。',
    task_names: ['推荐绩效后验刷新', 'Agent尾盘建议收益追踪', '信号质量日报'],
    stale_hours: 96,
    critical_if_inactive: true,
  },
  {
    key: 'paper_trading',
    title: '模拟盘执行与风控',
    subtitle: '把高分候选转成模拟交易样本，并按止损/止盈/卖出信号管理退出。',
    task_names: ['推荐信号模拟盘跟单', 'Agent尾盘建议模拟盘跟单', '模拟盘风控退出检查'],
    stale_hours: 96,
    critical_if_inactive: true,
    parameter_checks: [
      {
        task_name: '推荐信号模拟盘跟单',
        key: 'dry_run',
        camel_key: 'dryRun',
        expected: false,
        label: '推荐跟单真实记录',
      },
      {
        task_name: '推荐信号模拟盘跟单',
        key: 'report_to_feishu',
        camel_key: 'reportToFeishu',
        expected: true,
        label: '推荐跟单飞书上报',
      },
      {
        task_name: '模拟盘风控退出检查',
        key: 'dry_run',
        camel_key: 'dryRun',
        expected: false,
        label: '风控退出真实记录',
      },
    ],
  },
  {
    key: 'trade_outcome_loop',
    title: '交易收益闭环',
    subtitle: '沉淀每次推荐后的模拟交易收益，用真实样本反向优化荐股。',
    task_names: ['推荐交易收益闭环刷新', '模拟盘收益归因报告', '模拟盘交易计划报告'],
    stale_hours: 96,
    critical_if_inactive: true,
  },
];

const RISK_LIMIT_TARGET_TASK_TYPES = ['AUTO_RECOMMENDATION_LOOP', 'QUANT_DAILY_PIPELINE'];

const RISK_LIMIT_PARAMETER_KEYS = [
  'min_cash_reserve_pct',
  'max_total_exposure_pct',
  'max_industry_exposure_pct',
  'max_portfolio_drawdown_pct',
  'max_position_correlation',
  'max_portfolio_var_pct',
  'max_single_stock_volatility_pct',
];

const RISK_LIMIT_PARAMETER_LABELS: Record<string, string> = {
  min_cash_reserve_pct: '现金底线',
  max_total_exposure_pct: '总仓位上限',
  max_industry_exposure_pct: '行业集中上限',
  max_portfolio_drawdown_pct: '组合回撤上限',
  max_position_correlation: '持仓相关性上限',
  max_portfolio_var_pct: '组合VaR上限',
  max_single_stock_volatility_pct: '单票波动上限',
};

const RISK_LIMIT_ATTRIBUTION_KEY_MAP: Record<string, string[]> = {
  max_portfolio_drawdown_pct: ['max_portfolio_drawdown_pct', 'drawdown_abs_pct', 'drawdown_pct'],
  max_position_correlation: ['max_position_correlation', 'max_pair_correlation'],
  max_portfolio_var_pct: ['max_portfolio_var_pct', 'portfolio_var_proxy_pct'],
  max_single_stock_volatility_pct: ['max_single_stock_volatility_pct', 'max_volatility_20d_pct'],
};

const FIELD_STABILITY_MIN_CONSECUTIVE = 2;

function toPlain<T = any>(record: any): T {
  if (!record) return record;
  return typeof record.toJSON === 'function' ? record.toJSON() : record;
}

function getParam(parameters: any, key: string, camelKey?: string) {
  if (!parameters || typeof parameters !== 'object') return undefined;
  if (parameters[key] !== undefined) return parameters[key];
  if (camelKey && parameters[camelKey] !== undefined) return parameters[camelKey];
  return undefined;
}

function normalizeBoolean(value: any): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

function normalizeComparable(value: any, expected: any) {
  if (typeof expected === 'boolean') return normalizeBoolean(value);
  if (typeof expected === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return value === undefined || value === null ? undefined : String(value);
}

function roundNumber(value: any, digits = 2): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function averageNumbers(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function worstLevel(levels: HealthLevel[]): HealthLevel {
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warning')) return 'warning';
  return 'healthy';
}

function hoursSince(value?: Date | string | null): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return moment().diff(moment(date), 'hours', true);
}

function isStaleReconcileFailure(log: any): boolean {
  return (
    log?.status === 'FAILED' &&
    /长时间处于运行中|自动标记为失败|stale/i.test(String(log?.error_message || ''))
  );
}

function summarizeParameters(task: any): Record<string, any> {
  const params = task?.parameters && typeof task.parameters === 'object' ? task.parameters : {};
  const keys = [
    'username',
    'universe',
    'style',
    'candidate_limit',
    'candidate_pool_limit',
    'run_paper_trading',
    'dry_run',
    'report_to_feishu',
    'use_profit_gate',
    'use_entry_risk_guard',
    'use_strategy_experiment_feedback',
    'use_policy_version_feedback',
    'max_daily_new_positions',
    'max_daily_new_exposure_pct',
    'max_total_exposure_pct',
    'max_industry_exposure_pct',
    'min_cash_reserve_pct',
    'max_portfolio_drawdown_pct',
    'max_position_correlation',
    'max_portfolio_var_pct',
    'max_single_stock_volatility_pct',
    'risk_threshold_stability_min_consecutive_same_action',
    'risk_threshold_stability_min_actionable_samples',
    'risk_threshold_stability_min_protected_runs',
    'risk_threshold_stability_tighten_min_delta_pct',
    'risk_threshold_stability_relax_max_delta_pct',
    'risk_threshold_field_stability_min_consecutive_same_action',
    'risk_threshold_field_min_confidence',
    'risk_threshold_field_min_sample_count',
    'risk_threshold_field_min_triggered_count',
    'risk_threshold_field_gate_update_source',
    'min_score',
    'paper_trade_limit',
  ];
  return keys.reduce<Record<string, any>>((summary, key) => {
    if (params[key] !== undefined) summary[key] = params[key];
    return summary;
  }, {});
}

export class TaskAutomationHealthService {
  async getHealth() {
    const [
      tasks,
      recentLogs,
      latestSnapshots,
      dataQueueCounts,
      aiQueueCounts,
      quantBacktestQueueCounts,
      runtimeSchemaHealth,
    ] = await Promise.all([
      ScheduledTask.findAll({ order: [['id', 'ASC']] }),
      TaskExecutionLog.findAll({ order: [['started_at', 'DESC']], limit: 300 }),
      RecommendationLoopPolicySnapshot.findAll({ order: [['generated_at', 'DESC']], limit: 8 }),
      this.getQueueHealth('data-update', dataUpdateQueue),
      this.getQueueHealth('ai_polling', aiPollingQueue),
      this.getQueueHealth('quant_backtest', quantBacktestQueue),
      runtimeSchemaHealthService.getHealth(),
    ]);

    const plainTasks = tasks.map(task => toPlain<any>(task));
    const plainLogs = recentLogs.map(log => toPlain<any>(log));
    const latestLogByTaskId = new Map<number, any>();
    for (const log of plainLogs) {
      const taskId = Number(log.task_id);
      if (!taskId || latestLogByTaskId.has(taskId)) continue;
      latestLogByTaskId.set(taskId, log);
    }

    const chains = CHAIN_CONFIGS.map(config =>
      this.buildChainHealth(config, plainTasks, latestLogByTaskId)
    );
    const plainSnapshots = latestSnapshots.map(snapshot => toPlain<any>(snapshot));
    const latestSnapshot = plainSnapshots[0] || null;
    const latestLoop = this.buildLatestLoopSummary(toPlain<any>(latestSnapshot));
    const stabilityConfig = this.resolveRiskThresholdStabilityConfig(plainTasks);
    const stability = this.buildRiskLimitSuggestionStability(plainSnapshots, stabilityConfig);
    const riskLimitSuggestion = this.buildRiskLimitTaskSuggestion(
      plainTasks,
      latestLoop,
      stability,
      plainSnapshots
    );
    const queuePressureIssues = this.buildQueuePressureIssues(
      dataQueueCounts,
      aiQueueCounts,
      quantBacktestQueueCounts
    );
    const runtimeSchemaIssues = this.buildRuntimeSchemaIssues(runtimeSchemaHealth);
    const allIssues = [
      ...chains.flatMap(item => item.issues),
      ...queuePressureIssues,
      ...runtimeSchemaIssues,
    ];
    const status = worstLevel([
      ...chains.map(item => item.status as HealthLevel),
      ...queuePressureIssues.map(issue => issue.level),
      runtimeSchemaHealth?.status as HealthLevel,
    ]);

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      status,
      summary: {
        total_tasks: plainTasks.length,
        active_tasks: plainTasks.filter(task => task.is_active).length,
        critical_issues: allIssues.filter(issue => issue.level === 'critical').length,
        warnings: allIssues.filter(issue => issue.level === 'warning').length,
        queue_waiting:
          Number(dataQueueCounts.waiting || 0) +
          Number(dataQueueCounts.delayed || 0) +
          Number(aiQueueCounts.waiting || 0) +
          Number(aiQueueCounts.delayed || 0) +
          Number(quantBacktestQueueCounts.waiting || 0) +
          Number(quantBacktestQueueCounts.delayed || 0),
        latest_loop_run_at: latestLoop?.generated_at || null,
        latest_loop_run_id: latestLoop?.loop_run_id || null,
        latest_loop_trade_action:
          latestLoop && latestLoop.paper_trading
            ? `${latestLoop.paper_trading.executed || latestLoop.paper_trading.planned || 0}/${
                latestLoop.paper_trading.skipped || 0
              }`
            : null,
      },
      queues: {
        data_update: dataQueueCounts,
        ai_polling: aiQueueCounts,
        quant_backtest: quantBacktestQueueCounts,
      },
      runtime_schema: runtimeSchemaHealth,
      chains,
      latest_loop: latestLoop,
      risk_limit_suggestion: riskLimitSuggestion,
      issues: allIssues,
      next_actions: this.buildNextActions(
        chains,
        queuePressureIssues,
        latestLoop,
        runtimeSchemaHealth
      ),
    };
  }

  async applyRiskLimitSuggestion(options: ApplyRiskLimitSuggestionOptions = {}) {
    const dryRun = options.dry_run !== false;
    const tasks = await ScheduledTask.findAll({ order: [['id', 'ASC']] });
    const latestSnapshots = await RecommendationLoopPolicySnapshot.findAll({
      order: [['generated_at', 'DESC']],
      limit: 8,
    });
    const latestSnapshot = latestSnapshots[0] || null;
    const plainTasks = tasks.map(task => toPlain<any>(task));
    const latestLoop = this.buildLatestLoopSummary(toPlain<any>(latestSnapshot));
    const stabilityConfig = this.resolveRiskThresholdStabilityConfig(plainTasks);
    const fieldGateConfig = this.resolveRiskThresholdFieldGateConfig(plainTasks);
    const plainSnapshots = latestSnapshots.map(snapshot => toPlain<any>(snapshot));
    const stability = this.buildRiskLimitSuggestionStability(plainSnapshots, stabilityConfig);
    const suggestion = this.buildRiskLimitTaskSuggestion(
      plainTasks,
      latestLoop,
      stability,
      plainSnapshots
    );
    const sourceLoopRunId = suggestion?.source_loop_run_id || latestLoop?.loop_run_id;

    if (!suggestion?.limits || !Object.keys(suggestion.limits).length) {
      return {
        dry_run: dryRun,
        applied: false,
        message: suggestion?.reason || '暂无可应用的风险阈值建议。',
        source_loop_run_id: sourceLoopRunId || null,
        action: suggestion?.action || 'observe',
        stability: suggestion?.stability,
        changes: [],
      };
    }

    if (
      options.source_loop_run_id &&
      sourceLoopRunId &&
      String(options.source_loop_run_id) !== String(sourceLoopRunId)
    ) {
      throw new Error('风险阈值建议已更新，请刷新页面后重新预览。');
    }

    const selectedTaskIds = new Set(
      (options.task_ids || []).map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0)
    );
    const targetTasks = tasks.filter(task => {
      if (!RISK_LIMIT_TARGET_TASK_TYPES.includes(task.type)) return false;
      if (selectedTaskIds.size > 0 && !selectedTaskIds.has(Number(task.id))) return false;
      return true;
    });

    const changes = targetTasks
      .map(task =>
        this.buildRiskLimitTaskChange(
          task,
          suggestion.limits || {},
          (suggestion as any).attribution || (suggestion as any).threshold_attribution,
          (suggestion as any).field_stability,
          fieldGateConfig
        )
      )
      .filter(change => change.changed_keys.length > 0);

    if (!dryRun) {
      for (const change of changes) {
        const task = targetTasks.find(item => Number(item.id) === Number(change.id));
        if (!task) continue;
        const beforeParameters = { ...(task.parameters || {}) };
        await task.update({ parameters: change.suggested_parameters });
        await taskParameterAuditService.record({
          task,
          event_type: 'risk_limit_suggestion_applied',
          before_parameters: beforeParameters,
          after_parameters: change.suggested_parameters,
          changed_keys: change.changed_keys,
          source_loop_run_id: sourceLoopRunId || undefined,
          operator: options.operator,
          metadata: {
            source: 'risk_limit_suggestion_apply',
            action: suggestion.action,
            reason: suggestion.reason,
            stability: suggestion.stability,
            generated_at: suggestion.generated_at || null,
          },
        });
      }
    }

    return {
      dry_run: dryRun,
      applied: !dryRun,
      message:
        changes.length === 0
          ? '当前任务参数已经与风险阈值建议一致，无需更新。'
          : dryRun
          ? `已生成 ${changes.length} 个任务的风险阈值变更预览，确认后才会写入。`
          : `已应用 ${changes.length} 个任务的风险阈值建议，并重新加载启用中的定时任务。`,
      action: suggestion.action,
      reason: suggestion.reason,
      limits: suggestion.limits,
      stability: suggestion.stability,
      source_loop_run_id: sourceLoopRunId || null,
      generated_at: suggestion.generated_at || null,
      changes,
      apply_mode: dryRun ? 'preview' : 'manual_confirmed',
    };
  }

  private async getQueueHealth(queueName: string, queue: any): Promise<QueueHealthSummary> {
    try {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
        'paused'
      );
      const recentFailedJobs = await queue.getFailed(0, 19);
      const recentThreshold = Date.now() - 24 * 60 * 60 * 1000;
      const normalizedRecentFailedJobs = recentFailedJobs
        .map((job: any) => ({
          id: job.id,
          name: job.name,
          failed_reason: job.failedReason,
          finished_on: job.finishedOn,
        }))
        .filter((job: any) => Number(job.finished_on || 0) >= recentThreshold);

      return {
        queue_name: queueName,
        waiting: Number(counts.waiting || 0),
        active: Number(counts.active || 0),
        delayed: Number(counts.delayed || 0),
        completed: Number(counts.completed || 0),
        failed: Number(counts.failed || 0),
        paused: Number(counts.paused || 0),
        recent_failed: normalizedRecentFailedJobs.length,
        recent_failed_jobs: normalizedRecentFailedJobs.slice(0, 5),
        historical_failed_retained: Math.max(
          Number(counts.failed || 0) - normalizedRecentFailedJobs.length,
          0
        ),
      };
    } catch (error: any) {
      logger.warn(`读取队列健康状态失败 ${queueName}: ${error?.message || error}`);
      return {
        queue_name: queueName,
        waiting: 0,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
        paused: 0,
        recent_failed: 0,
        recent_failed_jobs: [],
        historical_failed_retained: 0,
        error: error?.message || String(error),
      };
    }
  }

  private buildChainHealth(
    config: HealthChainConfig,
    tasks: any[],
    latestLogByTaskId: Map<number, any>
  ) {
    const issues: AutomationHealthIssue[] = [];
    const taskSummaries: HealthTaskSummary[] = [];

    for (const taskName of config.task_names) {
      const task = tasks.find(item => item.name === taskName);
      if (!task) {
        issues.push({
          level: config.critical_if_inactive ? 'critical' : 'warning',
          message: `缺少默认任务：${taskName}`,
          task_name: taskName,
          code: 'missing_task',
        });
        taskSummaries.push({ name: taskName, type: 'MISSING' });
        continue;
      }

      const latestLog = task.id ? latestLogByTaskId.get(Number(task.id)) : null;
      const summary: HealthTaskSummary = {
        id: task.id,
        name: task.name,
        type: task.type,
        cron_expression: task.cron_expression,
        is_active: task.is_active,
        last_run_at: task.last_run_at,
        last_run_status: task.last_run_status,
        last_log_status: latestLog?.status,
        last_log_started_at: latestLog?.started_at,
        last_log_completed_at: latestLog?.completed_at,
        parameters: summarizeParameters(task),
      };
      taskSummaries.push(summary);

      if (!task.is_active) {
        issues.push({
          level: config.critical_if_inactive ? 'critical' : 'warning',
          message: `关键任务已停用：${taskName}`,
          task_name: taskName,
          code: 'inactive_task',
        });
      }
      if (!task.cron_expression || !cron.validate(task.cron_expression)) {
        issues.push({
          level: 'critical',
          message: `Cron 表达式无效：${taskName}`,
          task_name: taskName,
          code: 'invalid_cron',
        });
      }

      const runHours = hoursSince(task.last_run_at);
      const lastLogHours = hoursSince(latestLog?.started_at);
      if (task.last_run_status === 'FAILED' || latestLog?.status === 'FAILED') {
        const staleReconciled = isStaleReconcileFailure(latestLog);
        issues.push({
          level: staleReconciled ? 'warning' : 'critical',
          message: staleReconciled
            ? `最近一次执行被重启恢复标记为失败：${taskName}`
            : `最近一次执行失败：${taskName}`,
          task_name: taskName,
          code: staleReconciled ? 'stale_reconciled_failed' : 'last_run_failed',
        });
      }
      if (
        (task.last_run_status === 'RUNNING' && runHours !== null && runHours > 6) ||
        (latestLog?.status === 'IN_PROGRESS' && lastLogHours !== null && lastLogHours > 6)
      ) {
        issues.push({
          level: 'critical',
          message: `任务运行超过 6 小时未结束：${taskName}`,
          task_name: taskName,
          code: 'stale_running',
        });
      }
      if (task.is_active && runHours !== null && runHours > config.stale_hours) {
        issues.push({
          level: 'warning',
          message: `任务超过 ${Math.round(config.stale_hours / 24)} 天未运行：${taskName}`,
          task_name: taskName,
          code: 'stale_task',
        });
      }
    }

    for (const check of config.parameter_checks || []) {
      const task = tasks.find(item => item.name === check.task_name);
      if (!task) continue;
      const actual = normalizeComparable(
        getParam(task.parameters, check.key, check.camel_key),
        check.expected
      );
      if (actual === undefined || actual !== check.expected) {
        issues.push({
          level: check.level || 'warning',
          message: `${check.task_name} 参数异常：${check.label} 应为 ${String(
            check.expected
          )}，当前 ${actual === undefined ? '未配置' : String(actual)}`,
          task_name: check.task_name,
          code: 'parameter_mismatch',
        });
      }
    }

    const activeCount = taskSummaries.filter(item => item.is_active).length;
    const status = worstLevel([
      issues.some(issue => issue.level === 'critical') ? 'critical' : 'healthy',
      issues.some(issue => issue.level === 'warning') ? 'warning' : 'healthy',
    ]);

    return {
      key: config.key,
      title: config.title,
      subtitle: config.subtitle,
      status,
      active_count: activeCount,
      task_count: config.task_names.length,
      tasks: taskSummaries,
      issues,
    };
  }

  private buildLatestLoopSummary(snapshot: any) {
    if (!snapshot) return null;
    const runMetrics = snapshot.run_metrics || {};
    const paper = runMetrics.paper_trading || {};
    const consensus = runMetrics.consensus || {};
    const riskProfile = runMetrics.risk_profile || paper?.risk_profile || null;
    const riskProfileGate = runMetrics.risk_profile_gate || paper?.risk_profile_gate || null;
    const thresholdVersion = riskProfileGate?.threshold_version || null;
    const skipSummary = paper?.skip_reason_summary || null;
    return {
      id: snapshot.id,
      loop_run_id: snapshot.loop_run_id,
      generated_at: snapshot.generated_at,
      record_type: snapshot.record_type,
      universe: snapshot.universe,
      effective_style: snapshot.effective_style,
      effective_min_score: snapshot.effective_min_score,
      paper_trading: paper
        ? {
            dry_run: paper.dry_run,
            scanned: paper.scanned,
            eligible: paper.eligible,
            executed: paper.executed,
            planned: paper.planned,
            skipped: paper.skipped,
            consensus_executed: paper.consensus_executed,
            consensus_planned: paper.consensus_planned,
            skip_reason_summary: skipSummary,
          }
        : null,
      risk_profile: riskProfile
        ? {
            status: riskProfile.status,
            risk_metrics: riskProfile.risk_metrics,
            warnings: Array.isArray(riskProfile.warnings) ? riskProfile.warnings.slice(0, 4) : [],
          }
        : null,
      risk_profile_gate: riskProfileGate
        ? {
            action: riskProfileGate.action,
            applied: Boolean(riskProfileGate.applied),
            reason: riskProfileGate.reason,
            effective_trade_limit: riskProfileGate.effective_trade_limit,
            effective_default_position_pct: riskProfileGate.effective_default_position_pct,
            effective_max_position_pct: riskProfileGate.effective_max_position_pct,
            threshold_version: thresholdVersion,
          }
        : null,
      consensus: {
        ranked: Boolean(consensus.ranked),
        overlap_count: consensus.overlap_count,
        top_symbols: Array.isArray(consensus.top_symbols) ? consensus.top_symbols.slice(0, 5) : [],
      },
      outcome: runMetrics.trade_outcomes?.summary || null,
      quality: runMetrics.quality_report?.overview || null,
    };
  }

  private buildRiskLimitTaskSuggestion(
    tasks: any[],
    latestLoop: any,
    stability?: any,
    snapshots: any[] = []
  ) {
    const suggestion: RiskLimitSuggestion | null =
      latestLoop?.risk_profile_gate?.threshold_version || null;
    const fieldGateConfig = this.resolveRiskThresholdFieldGateConfig(tasks);
    const fieldGateAdvice = this.buildRiskThresholdFieldGateAdvice(snapshots, fieldGateConfig);
    const fieldGateAdjustmentAttribution =
      this.buildFieldGateAdjustmentAttributionFromSnapshots(tasks, snapshots);
    if (!suggestion?.limits || !Object.keys(suggestion.limits).length) {
      return {
        action: 'observe',
        reason: '暂无风险阈值版本建议，继续积累 risk gate 后验样本。',
        stability: stability || this.buildRiskLimitSuggestionStability([]),
        field_gate_advice: fieldGateAdvice,
        field_gate_adjustment_attribution: fieldGateAdjustmentAttribution,
        targets: [],
      };
    }

    const attribution = suggestion.attribution || suggestion.threshold_attribution;
    const fieldStability = this.buildRiskLimitFieldStability(
      snapshots,
      attribution,
      fieldGateConfig
    );
    const targetTasks = tasks
      .filter(task => RISK_LIMIT_TARGET_TASK_TYPES.includes(task.type))
      .map(task =>
        this.buildRiskLimitTaskChange(
          task,
          suggestion.limits || {},
          attribution,
          fieldStability,
          fieldGateConfig
        )
      );

    return {
      action: suggestion.action,
      reason: suggestion.reason,
      limits: suggestion.limits,
      stability: stability || this.buildRiskLimitSuggestionStability([]),
      attribution,
      field_stability: fieldStability,
      field_gate_advice: fieldGateAdvice,
      field_gate_adjustment_attribution: fieldGateAdjustmentAttribution,
      source_loop_run_id: latestLoop?.loop_run_id,
      generated_at: latestLoop?.generated_at,
      targets: targetTasks,
      apply_mode: 'suggest_only',
    };
  }

  private buildRiskLimitSuggestionStability(snapshots: any[], config: any = {}) {
    return riskThresholdStabilityService.buildFromSnapshots(snapshots, {}, config);
  }

  private buildFieldGateAdjustmentAttributionFromSnapshots(tasks: any[] = [], snapshots: any[] = []) {
    const sourceTask =
      tasks.find(task => task.type === 'AUTO_RECOMMENDATION_LOOP') ||
      tasks.find(task => task.type === 'QUANT_DAILY_PIPELINE') ||
      null;
    const params =
      sourceTask?.parameters && typeof sourceTask.parameters === 'object'
        ? sourceTask.parameters
        : {};
    return fieldGateAdjustmentAttributionService.build(snapshots, {
      source: params.risk_threshold_field_gate_update_source,
      changed_at: params.risk_threshold_stability_updated_at || sourceTask?.updated_at,
      task_name: sourceTask?.name,
    });
  }

  private buildRiskThresholdFieldGateAdvice(snapshots: any[] = [], config: any = {}) {
    const items = RISK_LIMIT_PARAMETER_KEYS.map(key => {
      const history = (snapshots || [])
        .map(snapshot => this.extractFieldAttributionItem(snapshot, key))
        .filter(Boolean) as any[];
      const actionable = history.filter(item =>
        ['tighten', 'relax'].includes(String(item.action || ''))
      );
      const confidences = actionable
        .map(item => Number(item.confidence))
        .filter(Number.isFinite);
      const sampleCounts = actionable
        .map(item => Number(item.sample_count))
        .filter(Number.isFinite);
      const triggeredCounts = actionable
        .map(item => Number(item.triggered_count))
        .filter(Number.isFinite);
      const latest = actionable[0] || history[0] || null;
      const avgConfidence = averageNumbers(confidences);
      const avgSampleCount = averageNumbers(sampleCounts);
      const avgTriggeredCount = averageNumbers(triggeredCounts);
      const currentConfidence = this.resolvePositiveNumber(config.min_confidence, 0.45);
      const currentSample = this.resolvePositiveInt(config.min_sample_count, 3);
      const currentTriggered = this.resolvePositiveInt(config.min_triggered_count, 1);
      const sampleCount = history.length;
      const actionableCount = actionable.length;

      let action = 'keep';
      let reason = '字段级样本有限，建议保持当前门槛。';
      const suggested: Record<string, number> = {};

      if (sampleCount < 5 || actionableCount < 2) {
        action = 'observe';
        reason = `字段级历史 ${sampleCount} 条、可执行信号 ${actionableCount} 条，暂不建议调整门槛。`;
      } else if (
        avgConfidence >= currentConfidence + 0.12 &&
        avgSampleCount >= currentSample + 2 &&
        avgTriggeredCount >= currentTriggered + 1
      ) {
        action = 'tighten';
        suggested.risk_threshold_field_min_confidence = roundNumber(
          Math.min(0.75, currentConfidence + 0.05),
          2
        );
        suggested.risk_threshold_field_min_sample_count = Math.min(12, currentSample + 1);
        reason = `历史字段信号质量较高（平均置信 ${roundNumber(
          avgConfidence,
          2
        )}、样本 ${roundNumber(avgSampleCount, 1)}），可小幅提高字段级写入门槛，减少误调参。`;
      } else if (
        avgConfidence >= Math.max(0.35, currentConfidence - 0.08) &&
        avgSampleCount >= Math.max(2, currentSample - 1) &&
        avgTriggeredCount >= currentTriggered
      ) {
        action = 'relax';
        suggested.risk_threshold_field_min_confidence = roundNumber(
          Math.max(0.35, currentConfidence - 0.03),
          2
        );
        reason = `历史字段信号接近门槛但经常被拦截（平均置信 ${roundNumber(
          avgConfidence,
          2
        )}、样本 ${roundNumber(avgSampleCount, 1)}），可观察性小幅放松。`;
      } else {
        reason = `字段信号质量一般（平均置信 ${roundNumber(
          avgConfidence,
          2
        )}、样本 ${roundNumber(avgSampleCount, 1)}），建议保持当前字段级门槛。`;
      }

      return {
        key,
        label: RISK_LIMIT_PARAMETER_LABELS[key] || key,
        action,
        reason,
        sample_count: sampleCount,
        actionable_count: actionableCount,
        avg_confidence: roundNumber(avgConfidence, 4),
        avg_sample_count: roundNumber(avgSampleCount, 2),
        avg_triggered_count: roundNumber(avgTriggeredCount, 2),
        latest_action: latest?.action || 'observe',
        suggested_parameters: suggested,
      };
    });
    const actionableItems = items.filter(item => ['tighten', 'relax'].includes(item.action));
    return {
      generated_at: new Date().toISOString(),
      current_parameters: {
        risk_threshold_field_min_confidence: this.resolvePositiveNumber(
          config.min_confidence,
          0.45
        ),
        risk_threshold_field_min_sample_count: this.resolvePositiveInt(config.min_sample_count, 3),
        risk_threshold_field_min_triggered_count: this.resolvePositiveInt(
          config.min_triggered_count,
          1
        ),
        risk_threshold_field_stability_min_consecutive_same_action: this.resolvePositiveInt(
          config.min_consecutive_same_action,
          FIELD_STABILITY_MIN_CONSECUTIVE
        ),
      },
      conclusion: actionableItems.length
        ? `字段级门槛有 ${actionableItems.length} 项可继续观察调整，建议先人工复核，不自动写入。`
        : '字段级门槛暂无明确收益后验调整信号，建议保持当前保守设置。',
      items,
    };
  }

  private resolveRiskThresholdStabilityConfig(tasks: any[]) {
    const sourceTask =
      tasks.find(task => task.type === 'AUTO_RECOMMENDATION_LOOP') ||
      tasks.find(task => task.type === 'QUANT_DAILY_PIPELINE') ||
      null;
    return riskThresholdStabilityService.buildConfigFromParameters(sourceTask?.parameters);
  }

  private resolveRiskThresholdFieldGateConfig(tasks: any[]) {
    const sourceTask =
      tasks.find(task => task.type === 'AUTO_RECOMMENDATION_LOOP') ||
      tasks.find(task => task.type === 'QUANT_DAILY_PIPELINE') ||
      null;
    const params =
      sourceTask?.parameters && typeof sourceTask.parameters === 'object'
        ? sourceTask.parameters
        : {};
    const minConsecutive = Number(
      params.risk_threshold_field_stability_min_consecutive_same_action
    );
    return {
      min_consecutive_same_action:
        Number.isFinite(minConsecutive) && minConsecutive > 0
          ? Math.floor(minConsecutive)
          : FIELD_STABILITY_MIN_CONSECUTIVE,
      min_confidence: this.resolvePositiveNumber(
        params.risk_threshold_field_min_confidence,
        0.45
      ),
      min_sample_count: this.resolvePositiveInt(params.risk_threshold_field_min_sample_count, 3),
      min_triggered_count: this.resolvePositiveInt(
        params.risk_threshold_field_min_triggered_count,
        1
      ),
    };
  }

  private buildRiskLimitFieldStability(
    snapshots: any[] = [],
    latestAttribution: any = {},
    config: {
      min_consecutive_same_action?: number;
      min_confidence?: number;
      min_sample_count?: number;
      min_triggered_count?: number;
    } = {}
  ) {
    const latestItems = Array.isArray(latestAttribution?.items) ? latestAttribution.items : [];
    const keys = RISK_LIMIT_PARAMETER_KEYS;
    const result: Record<string, any> = {};
    const minConsecutiveSameAction =
      Number.isFinite(Number(config.min_consecutive_same_action)) &&
      Number(config.min_consecutive_same_action) > 0
        ? Math.floor(Number(config.min_consecutive_same_action))
        : FIELD_STABILITY_MIN_CONSECUTIVE;

    for (const key of keys) {
      const history = (snapshots || [])
        .map(snapshot => this.extractFieldAttributionItem(snapshot, key))
        .filter(Boolean) as any[];
      const latestItem = this.findAttributionItemByKey(key, latestItems) || history[0];
      const latestAction = String(latestItem?.action || history[0]?.action || 'observe');
      let consecutiveSameAction = 0;
      for (const item of history) {
        if (String(item.action || 'observe') === latestAction) consecutiveSameAction += 1;
        else break;
      }
      const canApply =
        ['tighten', 'relax'].includes(latestAction) &&
        consecutiveSameAction >= minConsecutiveSameAction;
      result[key] = {
        action: latestAction,
        can_apply: canApply,
        consecutive_same_action: consecutiveSameAction,
        min_consecutive_same_action: minConsecutiveSameAction,
        min_confidence: this.resolvePositiveNumber(config.min_confidence, 0.45),
        min_sample_count: this.resolvePositiveInt(config.min_sample_count, 3),
        min_triggered_count: this.resolvePositiveInt(config.min_triggered_count, 1),
        label: canApply ? '字段稳定' : '字段观察',
        reason: canApply
          ? `该字段最近 ${consecutiveSameAction} 次分项归因均为${
              latestAction === 'tighten' ? '收紧' : '放松'
            }，允许进入应用候选。`
          : `该字段最近同向归因 ${consecutiveSameAction}/${minConsecutiveSameAction} 次，暂不自动应用。`,
        history: history.slice(0, 5).map(item => ({
          action: item.action,
          generated_at: item.generated_at,
          loop_run_id: item.loop_run_id,
          confidence: item.confidence,
          sample_count: item.sample_count,
          triggered_count: item.triggered_count,
        })),
      };
    }

    return result;
  }

  private extractFieldAttributionItem(snapshot: any, key: string) {
    const runMetrics = snapshot?.run_metrics || {};
    const paper = runMetrics.paper_trading || {};
    const candidates = [
      runMetrics.risk_profile_gate?.threshold_version?.attribution,
      paper.risk_profile_gate?.threshold_version?.attribution,
      snapshot?.metadata?.risk_profile_gate?.threshold_version?.attribution,
      snapshot?.loop_policy?.risk_profile_gate?.threshold_version?.attribution,
    ];
    for (const attribution of candidates) {
      const items = Array.isArray(attribution?.items) ? attribution.items : [];
      const item = this.findAttributionItemByKey(key, items);
      if (item) {
        return {
          ...item,
          generated_at: snapshot?.generated_at,
          loop_run_id: snapshot?.loop_run_id,
        };
      }
    }
    return null;
  }

  private findAttributionItemByKey(key: string, items: any[] = []) {
    const aliases = new Set([key, ...(RISK_LIMIT_ATTRIBUTION_KEY_MAP[key] || [])]);
    return items.find(item => aliases.has(String(item?.key || '')));
  }

  private buildRiskLimitTaskChange(
    task: any,
    limits: Record<string, number>,
    attribution: any = {},
    fieldStability: Record<string, any> = {},
    fieldGateConfig: Record<string, any> = {}
  ) {
    const current =
      task.parameters && typeof task.parameters === 'object' ? { ...task.parameters } : {};
    const suggestedParameters = { ...current };
    const attributionByKey = this.buildAttributionByKey(attribution);
    const fieldEvidence: Record<string, any> = {};

    for (const key of RISK_LIMIT_PARAMETER_KEYS) {
      if (
        limits[key] !== undefined &&
        limits[key] !== null &&
        Number.isFinite(Number(limits[key]))
      ) {
        const evidence = this.resolveFieldAttribution(key, attributionByKey);
        fieldEvidence[key] = evidence
          ? {
              action: evidence.action,
              confidence: evidence.confidence,
              sample_count: evidence.sample_count,
              triggered_count: evidence.triggered_count,
              reason: evidence.reason,
              stability: fieldStability[key],
              can_apply: this.canApplyRiskLimitField(
                key,
                limits[key],
                current[key],
                evidence,
                fieldStability[key],
                fieldGateConfig
              ),
            }
          : {
              action: 'observe',
              confidence: 0,
              sample_count: 0,
              triggered_count: 0,
              reason: '暂无字段级归因样本，保守起见不自动写入该字段。',
              stability: fieldStability[key],
              can_apply: this.isRiskFieldEvidenceOptional(key),
            };
        if (!fieldEvidence[key].can_apply) continue;
        suggestedParameters[key] = Number(limits[key]);
      }
    }

    const changedKeys = RISK_LIMIT_PARAMETER_KEYS.filter(
      key =>
        suggestedParameters[key] !== undefined &&
        String(current[key] ?? '') !== String(suggestedParameters[key])
    );
    const diffs = changedKeys.map(key => ({
      key,
      current_value: current[key] ?? null,
      suggested_value: suggestedParameters[key],
    }));

    return {
      id: task.id,
      name: task.name,
      type: task.type,
      current_parameters: current,
      suggested_parameters: suggestedParameters,
      changed_keys: changedKeys,
      changed: changedKeys.length > 0,
      diffs,
      field_evidence: fieldEvidence,
    };
  }

  private buildAttributionByKey(attribution: any) {
    const items = Array.isArray(attribution?.items) ? attribution.items : [];
    const map = new Map<string, any>();
    for (const item of items) {
      if (item?.key) map.set(String(item.key), item);
    }
    return map;
  }

  private resolveFieldAttribution(key: string, attributionByKey: Map<string, any>) {
    if (attributionByKey.has(key)) return attributionByKey.get(key);
    for (const alias of RISK_LIMIT_ATTRIBUTION_KEY_MAP[key] || []) {
      if (attributionByKey.has(alias)) return attributionByKey.get(alias);
    }
    return null;
  }

  private isRiskFieldEvidenceOptional(key: string) {
    return false;
  }

  private canApplyRiskLimitField(
    key: string,
    suggestedValue: any,
    currentValue: any,
    evidence: any,
    fieldStability: any = {},
    fieldGateConfig: any = {}
  ) {
    if (this.isRiskFieldEvidenceOptional(key)) return true;
    const suggested = Number(suggestedValue);
    const current = Number(currentValue);
    if (!Number.isFinite(suggested)) return false;
    if (String(suggested) === String(current)) return true;

    const evidenceAction = String(evidence?.action || '');
    const confidence = Number(evidence?.confidence || 0);
    const sampleCount = Number(evidence?.sample_count || 0);
    const triggeredCount = Number(evidence?.triggered_count || 0);
    const fieldStable = fieldStability?.can_apply === true;
    const minConfidence = this.resolvePositiveNumber(
      fieldStability?.min_confidence ?? fieldGateConfig?.min_confidence,
      0.45
    );
    const minSampleCount = this.resolvePositiveInt(
      fieldStability?.min_sample_count ?? fieldGateConfig?.min_sample_count,
      3
    );
    const minTriggeredCount = this.resolvePositiveInt(
      fieldStability?.min_triggered_count ?? fieldGateConfig?.min_triggered_count,
      1
    );
    const hasEnoughEvidence =
      fieldStable &&
      confidence >= minConfidence &&
      sampleCount >= minSampleCount &&
      triggeredCount >= minTriggeredCount;

    if (!Number.isFinite(current)) {
      return ['tighten', 'relax'].includes(evidenceAction) && hasEnoughEvidence;
    }

    const direction =
      key === 'min_cash_reserve_pct'
        ? suggested > current
          ? 'tighten'
          : 'relax'
        : suggested < current
        ? 'tighten'
        : 'relax';

    return evidenceAction === direction && hasEnoughEvidence;
  }

  private resolvePositiveInt(value: any, fallback: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
  }

  private resolvePositiveNumber(value: any, fallback: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
  }

  private buildQueuePressureIssues(...queueCounts: QueueHealthSummary[]): AutomationHealthIssue[] {
    const issues: AutomationHealthIssue[] = [];
    for (const queue of queueCounts) {
      if (queue.error) {
        issues.push({
          level: 'warning',
          message: `${queue.queue_name} 队列状态读取失败：${queue.error}`,
          code: 'queue_unavailable',
        });
      }
      if (Number(queue.recent_failed || 0) >= 3) {
        issues.push({
          level: 'warning',
          message: `${queue.queue_name} 队列近24小时失败任务较多：${queue.recent_failed}`,
          code: 'queue_recent_failed_jobs',
        });
      }
      if (Number(queue.waiting || 0) + Number(queue.delayed || 0) >= 30) {
        issues.push({
          level: 'warning',
          message: `${queue.queue_name} 队列等待/延迟任务积压：${
            Number(queue.waiting || 0) + Number(queue.delayed || 0)
          }`,
          code: 'queue_backlog',
        });
      }
    }
    return issues;
  }

  private buildRuntimeSchemaIssues(runtimeSchemaHealth: any): AutomationHealthIssue[] {
    if (!runtimeSchemaHealth || runtimeSchemaHealth.status === 'healthy') return [];
    const level = runtimeSchemaHealth.status === 'critical' ? 'critical' : 'warning';
    const summary = runtimeSchemaHealth.summary || {};
    const messages = [
      summary.critical_issues ? `关键问题 ${summary.critical_issues}` : '',
      summary.warnings ? `警告 ${summary.warnings}` : '',
      summary.owner_mismatches ? `owner 不一致 ${summary.owner_mismatches}` : '',
      summary.privilege_gaps ? `权限缺口 ${summary.privilege_gaps}` : '',
      summary.sequence_gaps ? `序列缺口 ${summary.sequence_gaps}` : '',
    ].filter(Boolean);

    return [
      {
        level,
        code: 'runtime_schema_health',
        message: `生产数据库运行时 schema 健康异常：${messages.join('，') || runtimeSchemaHealth.status}`,
      },
    ];
  }

  private buildNextActions(
    chains: any[],
    queueIssues: AutomationHealthIssue[],
    latestLoop: any,
    runtimeSchemaHealth?: any
  ) {
    const actions: string[] = [];
    if (runtimeSchemaHealth?.status === 'critical') {
      actions.push(
        '先修复生产数据库 public schema / 表 / 序列权限，否则定时任务日志、量化推荐或模拟盘写入可能失败。'
      );
    } else if (runtimeSchemaHealth?.status === 'warning') {
      actions.push('建议运行数据库权限迁移，消除历史 owner 不一致，降低后续 Sequelize alter 和任务写入噪音。');
    }
    const criticalChains = chains.filter(item => item.status === 'critical');
    if (criticalChains.length > 0) {
      actions.push(
        `优先修复 ${criticalChains.map(item => item.title).join('、')}，否则自动荐股闭环会断链。`
      );
    }
    if (queueIssues.length > 0) {
      actions.push('检查 Redis/Bull 队列积压和失败任务，必要时清理失败任务后重新触发。');
    }
    const topSkip = latestLoop?.paper_trading?.skip_reason_summary?.top_reasons?.[0];
    const riskGate = latestLoop?.risk_profile_gate;
    if (riskGate?.applied) {
      actions.push(
        `最近闭环已触发组合风险闸门：${riskGate.action === 'pause' ? '暂停新增' : '降仓'}；${
          riskGate.reason || '请先观察组合风险'
        }。`
      );
    }
    if (topSkip) {
      actions.push(
        `最近闭环主要阻断原因：${topSkip.reason}（${topSkip.count} 次），建议针对性调参或等待样本成熟。`
      );
    }
    if (!latestLoop) {
      actions.push('尚未找到荐股闭环快照，建议先手动执行一次“量化策略全市场扫描”进行端到端验证。');
    }
    if (actions.length === 0) {
      actions.push('自动化链路处于可运行状态，继续积累模拟盘样本并观察收益闭环反馈。');
    }
    return actions.slice(0, 5);
  }
}

export const taskAutomationHealthService = new TaskAutomationHealthService();
