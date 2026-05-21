import { Op } from 'sequelize';
import { ScheduledTask } from '../models/ScheduledTask';
import { schedulerService } from './SchedulerService';
import { taskParameterAuditService, TaskParameterAuditOperator } from './TaskParameterAuditService';
import { paperTradingPlanService } from './PaperTradingPlanService';

interface ApplyOrderIntentTuningOptions {
  dry_run?: boolean;
  parameter_keys?: string[];
  task_ids?: number[];
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

export class PaperTradingTuningApplyService {
  async applyOrderIntentTuningPreview(options: ApplyOrderIntentTuningOptions = {}) {
    const dryRun = toBoolean(options.dry_run, true);
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

    const previews = (plan.summary.order_intent_feedback?.parameter_adjustment_preview || [])
      .filter((item: any) => PARAMETER_ALLOWLIST.includes(String(item.parameter_key || '')))
      .filter((item: any) => selectedKeys.size === 0 || selectedKeys.has(item.parameter_key));

    if (previews.length === 0) {
      return {
        dry_run: dryRun,
        applied: false,
        message: '当前没有通过稳定窗口的订单意图调参预览，暂不更新任务参数。',
        changes: [],
        preview_count: 0,
        applied_count: 0,
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

    if (!dryRun) {
      for (const change of changes) {
        const task = targetTasks.find(item => Number(item.id) === Number(change.id));
        if (!task) continue;
        const beforeParameters = { ...(task.parameters || {}) };
        await task.update({ parameters: change.suggested_parameters });
        await taskParameterAuditService.record({
          task,
          event_type: 'order_intent_tuning_applied',
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
          },
        });
        await schedulerService.reloadTask(Number(task.id));
      }
    }

    return {
      dry_run: dryRun,
      applied: !dryRun,
      message:
        changes.length === 0
          ? '目标任务参数已与订单意图调参预览一致，无需更新。'
          : dryRun
          ? `已生成 ${changes.length} 个任务的订单意图调参预览，确认后才会写入。`
          : `已应用 ${changes.length} 个任务的订单意图调参建议，并重新加载启用中的定时任务。`,
      preview_count: previews.length,
      applied_count: dryRun ? 0 : changes.length,
      generated_at: plan.generated_at,
      tuning_preview_conclusion: plan.summary.order_intent_feedback?.tuning_preview_conclusion,
      previews,
      changes,
      apply_mode: dryRun ? 'preview' : 'manual_confirmed',
    };
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
