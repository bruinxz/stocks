import { Op } from 'sequelize';
import { ScheduledTask } from '../models/ScheduledTask';
import { schedulerService } from './SchedulerService';
import { taskParameterAuditService, TaskParameterAuditOperator } from './TaskParameterAuditService';
import { paperTradingPlanService } from './PaperTradingPlanService';
import { recommendationTradeOutcomeService } from './RecommendationTradeOutcomeService';

interface ApplyOrderIntentTuningOptions {
  dry_run?: boolean;
  parameter_keys?: string[];
  task_ids?: number[];
  canary?: boolean;
  canary_max_parameters?: number;
  canary_observation_trades?: number;
  canary_observation_days?: number;
  user_id?: number;
  username?: string;
  operator?: TaskParameterAuditOperator;
}

const TARGET_TASK_TYPES = ['PAPER_TRADING_AUTO_SYNC', 'PAPER_TRADING_DAILY_PLAN'];
const PARAMETER_ALLOWLIST = [
  'min_avg_turnover_yuan',
  'max_daily_new_positions',
  'max_daily_new_exposure_pct',
  'profit_gate_min_quality_score',
  'profit_gate_sampling_multiplier',
  'min_score',
  'default_position_pct',
  'min_trade_amount',
];

function toBoolean(value: any, fallback = true): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeNumber(value: any): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeParameterValue(key: string, value: any) {
  const numeric = normalizeNumber(value);
  if (numeric === null) return value;
  if (['max_daily_new_positions'].includes(key)) return Math.max(1, Math.round(numeric));
  if (['min_avg_turnover_yuan', 'min_trade_amount'].includes(key)) return Math.max(0, numeric);
  if (['profit_gate_sampling_multiplier'].includes(key)) {
    return Math.round(Math.min(Math.max(numeric, 0.1), 1) * 100) / 100;
  }
  return Math.round(numeric * 100) / 100;
}

function valuesEqual(left: any, right: any): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  const normalized = Math.floor(num);
  return max ? Math.min(normalized, max) : normalized;
}

function uniqueStrings(values: any[]): string[] {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

export class PaperTradingTuningApplyService {
  async applyOrderIntentTuningPreview(options: ApplyOrderIntentTuningOptions = {}) {
    const dryRun = toBoolean(options.dry_run, true);
    const canary = toBoolean(options.canary, false);
    const canaryMaxParameters = toPositiveInt(options.canary_max_parameters, 1, 3);
    const canaryObservationTrades = toPositiveInt(options.canary_observation_trades, 8, 30);
    const canaryObservationDays = toPositiveInt(options.canary_observation_days, 10, 60);
    const selectedKeys = new Set(
      (options.parameter_keys || [])
        .map(key => String(key || '').trim())
        .filter(key => PARAMETER_ALLOWLIST.includes(key))
    );
    const selectedTaskIds = new Set(
      (options.task_ids || []).map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0)
    );

    const plan = await paperTradingPlanService.generatePlan({
      user_id: options.user_id,
      username: options.username,
      report_to_feishu: false,
      include_entries: true,
      include_exits: true,
      include_monitor: true,
      source_type: 'quant_recommendation',
      limit: 30,
      entry_limit: 3,
      scan_limit: 100,
      min_score: 72,
      max_positions: 8,
      use_attribution_feedback: true,
      use_profit_gate: true,
      profit_gate_horizon: '5d',
      profit_gate_min_samples: 5,
      profit_gate_min_quality_score: 45,
      profit_gate_allow_sampling: true,
      profit_gate_sampling_multiplier: 0.35,
      use_outcome_feedback: true,
      outcome_feedback_min_closed_samples: 5,
      outcome_feedback_lookback_days: 365,
      outcome_feedback_limit: 2000,
      use_adaptive_risk_policy: true,
      adaptive_risk_lookback_days: 180,
      adaptive_risk_min_closed_samples: 5,
      adaptive_risk_override_signal_params: false,
    });

    const rawPreviews = (plan.summary.order_intent_feedback?.parameter_adjustment_preview || [])
      .filter((item: any) => PARAMETER_ALLOWLIST.includes(String(item.parameter_key || '')))
      .filter((item: any) => selectedKeys.size === 0 || selectedKeys.has(item.parameter_key));
    const previews = canary
      ? this.pickCanaryPreviews(rawPreviews, canaryMaxParameters)
      : rawPreviews;

    if (previews.length === 0) {
      return {
        dry_run: dryRun,
        applied: false,
        canary,
        message: '当前没有通过稳定窗口的订单意图调参预览，暂不更新任务参数。',
        changes: [],
        preview_count: rawPreviews.length,
        selected_preview_count: 0,
        applied_count: 0,
        canary_plan: canary
          ? {
              enabled: true,
              max_parameters: canaryMaxParameters,
              observation_trades: canaryObservationTrades,
              observation_days: canaryObservationDays,
              selected_parameter_keys: [],
            }
          : undefined,
      };
    }

    const tasks = await ScheduledTask.findAll({
      where: {
        type: { [Op.in]: TARGET_TASK_TYPES },
      },
      order: [['id', 'ASC']],
    });
    const targetTasks = tasks.filter(task => {
      if (selectedTaskIds.size > 0 && !selectedTaskIds.has(Number(task.id))) return false;
      return true;
    });

    const changes = targetTasks
      .map(task => this.buildTaskChange(task, previews))
      .filter(change => change.changed_keys.length > 0);
    const canaryPlan = canary
      ? {
          enabled: true,
          max_parameters: canaryMaxParameters,
          observation_trades: canaryObservationTrades,
          observation_days: canaryObservationDays,
          selected_parameter_keys: uniqueStrings(
            changes.flatMap(change => change.applied_previews.map(item => item.parameter_key))
          ),
          selected_preview_count: previews.length,
          target_task_count: changes.length,
          guardrails: [
            '每次最多放行少量参数，避免多变量同时变化导致收益归因失真。',
            '写入任务参数但不立即触发买卖，等待下一轮自动任务自然运行。',
            '后续用推荐交易收益闭环观察样本数、胜率、超额收益和最大亏损。',
          ],
        }
      : undefined;

    if (!dryRun) {
      for (const change of changes) {
        const task = targetTasks.find(item => Number(item.id) === Number(change.id));
        if (!task) continue;
        const beforeParameters = { ...(task.parameters || {}) };
        await task.update({ parameters: change.suggested_parameters });
        await taskParameterAuditService.record({
          task,
          event_type: canary
            ? 'order_intent_tuning_canary_applied'
            : 'order_intent_tuning_applied',
          before_parameters: beforeParameters,
          after_parameters: change.suggested_parameters,
          changed_keys: change.changed_keys,
          operator: options.operator,
          metadata: {
            source: 'paper_trading_order_intent_tuning_apply',
            generated_at: plan.generated_at,
            portfolio_id: plan.portfolio_id,
            tuning_preview_conclusion:
              plan.summary.order_intent_feedback?.tuning_preview_conclusion,
            previews: change.applied_previews,
            canary: canaryPlan,
          },
        });
        await schedulerService.reloadTask(Number(task.id));
      }
    }

    return {
      dry_run: dryRun,
      applied: !dryRun,
      canary,
      message:
        changes.length === 0
          ? '目标任务参数已与订单意图调参预览一致，无需更新。'
          : canary && dryRun
          ? `已生成 Canary 小流量调参预览：${changes.length} 个任务、${canaryPlan?.selected_parameter_keys.length || 0} 个参数，确认后先小范围观察。`
          : canary
          ? `已应用 Canary 小流量调参：${changes.length} 个任务、${canaryPlan?.selected_parameter_keys.length || 0} 个参数，等待后续收益闭环观察。`
          : dryRun
          ? `已生成 ${changes.length} 个任务的订单意图调参预览，确认后才会写入。`
          : `已应用 ${changes.length} 个任务的订单意图调参建议，并重新加载启用中的定时任务。`,
      preview_count: rawPreviews.length,
      selected_preview_count: previews.length,
      applied_count: dryRun ? 0 : changes.length,
      generated_at: plan.generated_at,
      tuning_preview_conclusion: plan.summary.order_intent_feedback?.tuning_preview_conclusion,
      previews,
      changes,
      canary_plan: canaryPlan,
      apply_mode: dryRun ? (canary ? 'canary_preview' : 'preview') : canary ? 'canary' : 'manual_confirmed',
    };
  }

  async getCanaryStatus(options: ApplyOrderIntentTuningOptions = {}) {
    const limit = toPositiveInt((options as any).limit, 5, 20);
    const audits = await taskParameterAuditService.list({
      event_type: 'order_intent_tuning_canary_applied',
      limit,
      watched_only: false,
    });
    const activeAudit = audits[0];
    if (!activeAudit) {
      return {
        active: false,
        audits: [],
        summary: {
          conclusion: '暂无正在观察的订单意图 Canary 调参，下一次可先生成小流量预览。',
        },
      };
    }

    const metadata = (activeAudit as any).metadata || {};
    const canary = metadata.canary || {};
    const appliedAt = (activeAudit as any).created_at;
    const observationDays = toPositiveInt(canary.observation_days, 10, 60);
    const observationTrades = toPositiveInt(canary.observation_trades, 8, 30);
    const startDate = appliedAt
      ? new Date(appliedAt).toISOString().slice(0, 10)
      : undefined;
    const dashboard = await recommendationTradeOutcomeService.getDashboard({
      user_id: options.user_id,
      username: options.username,
      include_open: true,
      start_date: startDate,
      limit: 500,
      report_to_feishu: false,
    });

    const closedCount = dashboard.summary.closed_count || 0;
    const elapsedDays = appliedAt
      ? Math.max(
          0,
          Math.floor((Date.now() - new Date(appliedAt).getTime()) / (24 * 60 * 60 * 1000))
        )
      : 0;
    const observationProgress = Math.min(
      100,
      Math.max(
        observationTrades > 0 ? (closedCount / observationTrades) * 100 : 0,
        observationDays > 0 ? (elapsedDays / observationDays) * 100 : 0
      )
    );
    const readyForReview = closedCount >= observationTrades || elapsedDays >= observationDays;
    const outcomeTone =
      dashboard.summary.closed_count === 0
        ? 'observing'
        : dashboard.summary.avg_excess_return_pct >= 0 && dashboard.summary.win_rate >= 45
        ? 'healthy'
        : dashboard.summary.avg_excess_return_pct < -1 || dashboard.summary.win_rate < 35
        ? 'risk'
        : 'mixed';

    const conclusion = readyForReview
      ? outcomeTone === 'healthy'
        ? `Canary 已满足观察条件，闭环 ${closedCount} 笔，平均超额 ${dashboard.summary.avg_excess_return_pct}%，可考虑人工复核后扩大。`
        : `Canary 已满足观察条件，但收益表现仍需谨慎：闭环 ${closedCount} 笔，平均超额 ${dashboard.summary.avg_excess_return_pct}%。`
      : `Canary 观察中：已闭环 ${closedCount}/${observationTrades} 笔，运行 ${elapsedDays}/${observationDays} 天，暂不建议扩大。`;

    return {
      active: true,
      generated_at: new Date().toISOString(),
      audit: activeAudit,
      canary,
      observation: {
        start_date: startDate,
        elapsed_days: elapsedDays,
        target_days: observationDays,
        target_closed_trades: observationTrades,
        progress_pct: Math.round(observationProgress * 100) / 100,
        ready_for_review: readyForReview,
        outcome_tone: outcomeTone,
      },
      outcome_summary: dashboard.summary,
      recent_outcomes: dashboard.outcomes.slice(0, 8),
      audits,
      summary: {
        conclusion,
      },
    };
  }

  private pickCanaryPreviews(previews: any[], maxParameters: number) {
    const ranked = [...previews]
      .filter(item => ['loosen', 'tighten'].includes(String(item.action || '')))
      .sort(
        (a: any, b: any) =>
          Number(b.confidence || 0) - Number(a.confidence || 0) ||
          Number(b.sample_count || 0) - Number(a.sample_count || 0)
      );
    const selectedKeys = new Set<string>();
    const selected: any[] = [];
    for (const item of ranked) {
      const key = String(item.parameter_key || '');
      if (!key || selectedKeys.has(key)) continue;
      selected.push(item);
      selectedKeys.add(key);
      if (selectedKeys.size >= maxParameters) break;
    }
    return selected.length > 0 ? selected : previews.slice(0, maxParameters);
  }

  private buildTaskChange(task: ScheduledTask, previews: any[]) {
    const beforeParameters = { ...(task.parameters || {}) };
    const suggestedParameters = { ...beforeParameters };
    const appliedPreviews: any[] = [];

    for (const preview of previews) {
      const key = String(preview.parameter_key || '');
      if (!PARAMETER_ALLOWLIST.includes(key)) continue;
      if (!this.isParameterRelevantToTask(task, key)) continue;
      const nextValue = normalizeParameterValue(key, preview.preview_value);
      if (valuesEqual(suggestedParameters[key], nextValue)) continue;
      suggestedParameters[key] = nextValue;
      appliedPreviews.push({
        ...preview,
        before_value: beforeParameters[key],
        after_value: nextValue,
      });
    }

    const changedKeys = taskParameterAuditService.buildChangedKeys(
      beforeParameters,
      suggestedParameters,
      appliedPreviews.map(item => item.parameter_key)
    );

    return {
      id: task.id,
      name: task.name,
      type: task.type,
      changed_keys: changedKeys,
      before_parameters: beforeParameters,
      suggested_parameters: suggestedParameters,
      applied_previews: appliedPreviews.filter(item => changedKeys.includes(item.parameter_key)),
    };
  }

  private isParameterRelevantToTask(task: ScheduledTask, key: string): boolean {
    if (task.type === 'PAPER_TRADING_DAILY_PLAN') return PARAMETER_ALLOWLIST.includes(key);
    if (task.type !== 'PAPER_TRADING_AUTO_SYNC') return false;
    if (['min_score', 'default_position_pct', 'min_trade_amount'].includes(key)) return true;
    if (
      [
        'max_daily_new_positions',
        'max_daily_new_exposure_pct',
        'min_avg_turnover_yuan',
        'profit_gate_min_quality_score',
        'profit_gate_sampling_multiplier',
      ].includes(key)
    ) {
      return true;
    }
    return false;
  }
}

export const paperTradingTuningApplyService = new PaperTradingTuningApplyService();
