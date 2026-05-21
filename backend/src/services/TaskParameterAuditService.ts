import { TaskParameterAuditLog } from '../models/TaskParameterAuditLog';
import { ScheduledTask } from '../models/ScheduledTask';
import { logger } from '../utils/logger';
import { Op } from 'sequelize';

export type TaskParameterAuditEventType =
  | 'task_updated'
  | 'task_created'
  | 'risk_limit_suggestion_applied'
  | 'risk_stability_settings_updated'
  | 'order_intent_tuning_applied';

export interface TaskParameterAuditOperator {
  user_id?: number;
  username?: string;
}

export interface TaskParameterAuditInput {
  task: ScheduledTask | Record<string, any>;
  event_type: TaskParameterAuditEventType | string;
  before_parameters?: Record<string, any>;
  after_parameters?: Record<string, any>;
  changed_keys?: string[];
  source_loop_run_id?: string | null;
  operator?: TaskParameterAuditOperator;
  metadata?: Record<string, any>;
}

const WATCHED_PARAMETER_KEYS = [
  'min_cash_reserve_pct',
  'max_total_exposure_pct',
  'max_industry_exposure_pct',
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
  'min_avg_turnover_yuan',
  'max_daily_new_positions',
  'max_daily_new_exposure_pct',
  'profit_gate_min_quality_score',
  'profit_gate_sampling_multiplier',
  'min_score',
  'default_position_pct',
  'min_trade_amount',
];

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function stableStringify(value: any): string {
  if (value === undefined) return '__undefined__';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  const normalized = keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${normalized.join(',')}}`;
}

function safeJsonStringify(value: any): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function valuesEqual(left: any, right: any): boolean {
  try {
    return stableStringify(left) === stableStringify(right);
  } catch {
    return safeJsonStringify(left) === safeJsonStringify(right);
  }
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

export class TaskParameterAuditService {
  buildChangedKeys(
    before_parameters: Record<string, any> = {},
    after_parameters: Record<string, any> = {},
    keys?: string[]
  ): string[] {
    const candidates = uniq(
      keys?.length
        ? keys
        : [...Object.keys(before_parameters || {}), ...Object.keys(after_parameters || {})]
    );
    return candidates.filter(
      key => !valuesEqual(before_parameters?.[key], after_parameters?.[key])
    );
  }

  buildDiffs(
    before_parameters: Record<string, any> = {},
    after_parameters: Record<string, any> = {},
    keys?: string[]
  ) {
    const changedKeys = this.buildChangedKeys(before_parameters, after_parameters, keys);
    return changedKeys.map(key => ({
      key,
      before: before_parameters?.[key],
      after: after_parameters?.[key],
    }));
  }

  inferEventType(changed_keys: string[], fallback = 'task_updated'): string {
    const keySet = new Set(changed_keys);
    if (
      changed_keys.length > 0 &&
      changed_keys.every(
        key =>
          key.startsWith('risk_threshold_stability_') ||
          key.startsWith('risk_threshold_field_stability_')
      )
    ) {
      return 'risk_stability_settings_updated';
    }
    if (
      [
        'min_cash_reserve_pct',
        'max_total_exposure_pct',
        'max_industry_exposure_pct',
        'max_portfolio_drawdown_pct',
        'max_position_correlation',
        'max_portfolio_var_pct',
        'max_single_stock_volatility_pct',
      ].some(key => keySet.has(key))
    ) {
      return 'risk_limit_suggestion_applied';
    }
    return fallback;
  }

  async record(input: TaskParameterAuditInput) {
    const before_parameters = asPlainObject(input.before_parameters);
    const after_parameters = asPlainObject(input.after_parameters);
    const changed_keys = input.changed_keys?.length
      ? uniq(input.changed_keys)
      : this.buildChangedKeys(before_parameters, after_parameters);

    if (changed_keys.length === 0) return null;

    const task: any =
      typeof (input.task as any).toJSON === 'function' ? (input.task as any).toJSON() : input.task;

    try {
      return await TaskParameterAuditLog.create({
        task_id: Number(task.id),
        task_name: task.name || '',
        task_type: task.type || '',
        event_type: input.event_type || this.inferEventType(changed_keys),
        source_loop_run_id: input.source_loop_run_id || undefined,
        operator_user_id: input.operator?.user_id,
        operator_username: input.operator?.username,
        changed_keys,
        diffs: this.buildDiffs(before_parameters, after_parameters, changed_keys),
        before_parameters,
        after_parameters,
        metadata: {
          watched: changed_keys.filter(key => WATCHED_PARAMETER_KEYS.includes(key)),
          ...asPlainObject(input.metadata),
        },
      });
    } catch (error: any) {
      logger.warn(`记录任务参数审计失败 task=${task?.id}: ${error?.message || error}`);
      return null;
    }
  }

  async list(options: {
    task_id?: number;
    event_type?: string;
    limit?: number;
    watched_only?: boolean;
  }) {
    const where: any = {};
    if (options.task_id !== undefined && options.task_id !== null) {
      where.task_id = Number(options.task_id);
    }
    if (options.event_type && options.event_type !== 'all') {
      where.event_type =
        options.event_type === 'deployment_smoke'
          ? { [Op.like]: 'deployment_smoke_%' }
          : options.event_type;
    }

    const rows = await TaskParameterAuditLog.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: options.watched_only
        ? Math.min(Math.max(Number(options.limit || 50) * 3, 30), 300)
        : Math.min(Math.max(Number(options.limit || 50), 1), 200),
    });

    if (!options.watched_only) return rows;

    const filtered = rows.filter(row =>
      (Array.isArray(row.changed_keys) ? row.changed_keys : []).some(key =>
        WATCHED_PARAMETER_KEYS.includes(key)
      )
    );
    return filtered.slice(0, Math.min(Math.max(Number(options.limit || 50), 1), 200));
  }
}

export const taskParameterAuditService = new TaskParameterAuditService();
