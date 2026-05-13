import cron from 'node-cron';
import moment from 'moment-timezone';
import { ScheduledTask } from '../models/ScheduledTask';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { RecommendationLoopPolicySnapshot } from '../models/RecommendationLoopPolicySnapshot';
import { dataUpdateQueue } from '../jobs/dataUpdateQueue';
import { aiPollingQueue } from '../jobs/aiPollingQueue';
import { logger } from '../utils/logger';

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
    task_names: ['全市场荐股闭环'],
    stale_hours: 72,
    critical_if_inactive: true,
    parameter_checks: [
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
    const [tasks, recentLogs, latestSnapshot, dataQueueCounts, aiQueueCounts] = await Promise.all([
      ScheduledTask.findAll({ order: [['id', 'ASC']] }),
      TaskExecutionLog.findAll({ order: [['started_at', 'DESC']], limit: 300 }),
      RecommendationLoopPolicySnapshot.findOne({ order: [['generated_at', 'DESC']] }),
      this.getQueueHealth('data-update', dataUpdateQueue),
      this.getQueueHealth('ai_polling', aiPollingQueue),
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
    const latestLoop = this.buildLatestLoopSummary(toPlain<any>(latestSnapshot));
    const queuePressureIssues = this.buildQueuePressureIssues(dataQueueCounts, aiQueueCounts);
    const allIssues = [...chains.flatMap(item => item.issues), ...queuePressureIssues];
    const status = worstLevel([
      ...chains.map(item => item.status as HealthLevel),
      ...queuePressureIssues.map(issue => issue.level),
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
          Number(aiQueueCounts.delayed || 0),
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
      },
      chains,
      latest_loop: latestLoop,
      issues: allIssues,
      next_actions: this.buildNextActions(chains, queuePressureIssues, latestLoop),
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
      consensus: {
        ranked: Boolean(consensus.ranked),
        overlap_count: consensus.overlap_count,
        top_symbols: Array.isArray(consensus.top_symbols) ? consensus.top_symbols.slice(0, 5) : [],
      },
      outcome: runMetrics.trade_outcomes?.summary || null,
      quality: runMetrics.quality_report?.overview || null,
    };
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

  private buildNextActions(chains: any[], queueIssues: AutomationHealthIssue[], latestLoop: any) {
    const actions: string[] = [];
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
    if (topSkip) {
      actions.push(
        `最近闭环主要阻断原因：${topSkip.reason}（${topSkip.count} 次），建议针对性调参或等待样本成熟。`
      );
    }
    if (!latestLoop) {
      actions.push('尚未找到荐股闭环快照，建议先手动执行一次“全市场荐股闭环”进行端到端验证。');
    }
    if (actions.length === 0) {
      actions.push('自动化链路处于可运行状态，继续积累模拟盘样本并观察收益闭环反馈。');
    }
    return actions.slice(0, 5);
  }
}

export const taskAutomationHealthService = new TaskAutomationHealthService();
