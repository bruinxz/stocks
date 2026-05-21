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

function roundNumber(value: any, digits = 2): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function toPlain(record: any): any {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
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
    const relatedAudits = audits.filter((audit: any) => {
      const itemMetadata = audit?.metadata || {};
      if (!metadata.generated_at) return Number(audit?.id) === Number((activeAudit as any).id);
      return (
        itemMetadata.generated_at === metadata.generated_at &&
        itemMetadata.source === metadata.source
      );
    });
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
    const review = this.buildCanaryReview({
      canary,
      observation: {
        elapsed_days: elapsedDays,
        target_days: observationDays,
        target_closed_trades: observationTrades,
        ready_for_review: readyForReview,
        outcome_tone: outcomeTone,
      },
      summary: dashboard.summary,
    });
    const rollback_plan = await this.buildCanaryRollbackPlan(
      relatedAudits.length ? relatedAudits : [activeAudit]
    );
    const attribution = this.buildCanaryAttribution(canary, dashboard, startDate);

    return {
      active: true,
      generated_at: new Date().toISOString(),
      audit: activeAudit,
      related_audit_count: relatedAudits.length || 1,
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
      review,
      rollback_plan,
      attribution,
      recent_outcomes: dashboard.outcomes.slice(0, 8),
      audits,
      summary: {
        conclusion,
      },
    };
  }

  private async buildCanaryRollbackPlan(audits: any[]) {
    const plainAudits = audits.map(toPlain).filter(Boolean);
    const taskIds = plainAudits
      .map(audit => Number(audit.task_id))
      .filter(id => Number.isInteger(id) && id > 0);
    const tasks = taskIds.length
      ? await ScheduledTask.findAll({
          where: { id: { [Op.in]: taskIds } },
        })
      : [];
    const taskById = new Map<number, any>();
    tasks.forEach(task => taskById.set(Number(task.id), task));

    const items = plainAudits.map(audit => {
      const task = taskById.get(Number(audit.task_id));
      const before = audit.before_parameters || {};
      const after = audit.after_parameters || {};
      const current = task ? task.parameters || {} : {};
      const changedKeys = Array.isArray(audit.changed_keys) ? audit.changed_keys : [];
      const parameterItems = changedKeys.map((key: string) => {
        const currentMatchesCanary = valuesEqual(current?.[key], after?.[key]);
        const currentMatchesBefore = valuesEqual(current?.[key], before?.[key]);
        return {
          key,
          before_value: before?.[key],
          canary_value: after?.[key],
          current_value: current?.[key],
          restore_value: before?.[key],
          needs_rollback: !currentMatchesBefore,
          current_matches_canary: currentMatchesCanary,
          current_matches_before: currentMatchesBefore,
          changed_after_canary: !currentMatchesCanary && !currentMatchesBefore,
        };
      });
      return {
        audit_id: audit.id,
        task_id: audit.task_id,
        task_name: audit.task_name,
        task_type: audit.task_type,
        task_exists: Boolean(task),
        changed_keys: changedKeys,
        restore_parameters: Object.fromEntries(changedKeys.map((key: string) => [key, before?.[key]])),
        parameters: parameterItems,
      };
    });

    const parameterItems = items.flatMap(item => item.parameters || []);
    const changedAfterCanary = parameterItems.filter(item => item.changed_after_canary).length;
    const needsRollback = parameterItems.filter(item => item.needs_rollback).length;
    const safetyState =
      changedAfterCanary > 0 ? 'manual_review' : needsRollback > 0 ? 'ready' : 'no_change';
    const safetyLabels: Record<string, string> = {
      manual_review: '需人工核对',
      ready: '可生成回滚',
      no_change: '无需回滚',
    };

    return {
      available: items.length > 0,
      safety_state: safetyState,
      safety_label: safetyLabels[safetyState],
      task_count: items.length,
      changed_key_count: uniqueStrings(parameterItems.map(item => item.key)).length,
      rollback_key_count: needsRollback,
      changed_after_canary_count: changedAfterCanary,
      items,
      conclusion:
        safetyState === 'manual_review'
          ? 'Canary 后部分参数又被其它流程修改，回滚前必须人工核对当前值。'
          : safetyState === 'ready'
          ? `可回滚 ${needsRollback} 个参数到 Canary 前取值；当前仅生成预案，不自动写入。`
          : '当前任务参数已等于 Canary 前取值，暂不需要回滚。',
    };
  }

  private buildCanaryAttribution(canary: any, dashboard: any, startDate?: string) {
    const outcomes = Array.isArray(dashboard?.outcomes) ? dashboard.outcomes : [];
    const closed = outcomes.filter((item: any) => item.trade_status === 'closed');
    const winners = [...closed]
      .sort((a: any, b: any) => Number(b.total_pnl_pct || 0) - Number(a.total_pnl_pct || 0))
      .slice(0, 3)
      .map((item: any) => ({
        id: item.id,
        symbol: item.symbol,
        name: item.name,
        total_pnl_pct: roundNumber(item.total_pnl_pct, 4),
        excess_return_pct: roundNumber(item.excess_return_pct, 4),
        total_pnl: roundNumber(item.total_pnl, 2),
      }));
    const losers = [...closed]
      .sort((a: any, b: any) => Number(a.total_pnl_pct || 0) - Number(b.total_pnl_pct || 0))
      .slice(0, 3)
      .map((item: any) => ({
        id: item.id,
        symbol: item.symbol,
        name: item.name,
        total_pnl_pct: roundNumber(item.total_pnl_pct, 4),
        excess_return_pct: roundNumber(item.excess_return_pct, 4),
        total_pnl: roundNumber(item.total_pnl, 2),
      }));
    const summary = dashboard?.summary || {};
    const avgExcess = roundNumber(summary.avg_excess_return_pct, 4);
    const winRate = roundNumber(summary.win_rate, 2);
    const closedCount = Number(summary.closed_count || 0);
    return {
      start_date: startDate,
      selected_parameter_keys: canary?.selected_parameter_keys || [],
      task_count: Number(canary?.target_task_count || 0),
      closed_count: closedCount,
      open_count: Number(summary.open_count || 0),
      total_pnl: roundNumber(summary.total_pnl, 2),
      total_realized_pnl: roundNumber(summary.total_realized_pnl, 2),
      total_unrealized_pnl: roundNumber(summary.total_unrealized_pnl, 2),
      avg_closed_return_pct: roundNumber(summary.avg_closed_return_pct, 4),
      avg_excess_return_pct: avgExcess,
      win_rate: winRate,
      profit_factor: roundNumber(summary.profit_factor, 4),
      winners,
      losers,
      conclusion:
        closedCount === 0
          ? 'Canary 后尚无闭环交易，暂不能判断本次调参是否贡献收益。'
          : avgExcess > 0 && winRate >= 45
          ? `Canary 后闭环 ${closedCount} 笔，平均超额 ${avgExcess}%，收益贡献偏正。`
          : `Canary 后闭环 ${closedCount} 笔，平均超额 ${avgExcess}%，收益贡献仍需谨慎。`,
    };
  }

  private buildCanaryReview(input: {
    canary: any;
    observation: {
      elapsed_days: number;
      target_days: number;
      target_closed_trades: number;
      ready_for_review: boolean;
      outcome_tone: string;
    };
    summary: any;
  }) {
    const closedCount = Number(input.summary.closed_count || 0);
    const openCount = Number(input.summary.open_count || 0);
    const avgExcess = roundNumber(input.summary.avg_excess_return_pct, 4);
    const avgReturn = roundNumber(input.summary.avg_closed_return_pct, 4);
    const winRate = roundNumber(input.summary.win_rate, 2);
    const profitFactor = roundNumber(input.summary.profit_factor, 4);
    const readyByTrades = closedCount >= input.observation.target_closed_trades;
    const readyByDays = input.observation.elapsed_days >= input.observation.target_days;
    const sampleScore = Math.min(100, (closedCount / Math.max(1, input.observation.target_closed_trades)) * 100);
    const performanceScore =
      avgExcess * 12 +
      (winRate - 50) * 0.65 +
      Math.min(18, Math.max(-12, (profitFactor - 1) * 8)) +
      Math.min(8, avgReturn * 0.8);
    const reviewScore = roundNumber(Math.max(0, Math.min(100, 50 + performanceScore + sampleScore * 0.18)), 2);

    let action: 'promote' | 'rollback' | 'continue_observing' | 'hold';
    if (!input.observation.ready_for_review) {
      action = 'continue_observing';
    } else if (closedCount >= 3 && (avgExcess <= -1.5 || winRate < 35 || profitFactor < 0.75)) {
      action = 'rollback';
    } else if (closedCount >= 5 && avgExcess >= 0.5 && winRate >= 50 && profitFactor >= 1) {
      action = 'promote';
    } else {
      action = 'hold';
    }

    const actionLabels: Record<string, string> = {
      promote: '建议扩大',
      rollback: '建议回滚',
      continue_observing: '继续观察',
      hold: '暂不扩大',
    };
    const reasons: string[] = [];
    reasons.push(`闭环样本 ${closedCount}/${input.observation.target_closed_trades} 笔，运行 ${input.observation.elapsed_days}/${input.observation.target_days} 天。`);
    reasons.push(`平均超额 ${avgExcess}%，胜率 ${winRate}%，利润因子 ${profitFactor || 0}。`);
    if (openCount > 0) reasons.push(`仍有 ${openCount} 笔未闭环持仓，结论需保留安全边际。`);
    if (action === 'promote') {
      reasons.push('样本和收益同时达标，可以进入人工复核后的扩大阶段。');
    } else if (action === 'rollback') {
      reasons.push('收益或胜率低于安全线，应优先回滚或降低该参数影响。');
    } else if (action === 'continue_observing') {
      reasons.push('观察窗口尚未满足，不应提前扩大或回滚。');
    } else {
      reasons.push('观察窗口已满足但收益优势不够明确，建议保持当前小流量。');
    }

    return {
      action,
      action_label: actionLabels[action],
      review_score: reviewScore,
      ready_for_review: input.observation.ready_for_review,
      ready_by_trades: readyByTrades,
      ready_by_days: readyByDays,
      selected_parameter_keys: input.canary?.selected_parameter_keys || [],
      metrics: {
        closed_count: closedCount,
        open_count: openCount,
        avg_excess_return_pct: avgExcess,
        avg_closed_return_pct: avgReturn,
        win_rate: winRate,
        profit_factor: profitFactor,
      },
      reasons,
      next_steps:
        action === 'promote'
          ? ['人工复核最近成交明细', '生成非 Canary 审计预览', '确认后逐步扩大到更多参数/任务']
          : action === 'rollback'
          ? ['保留当前审计记录', '人工回看亏损样本', '生成回滚预案后再恢复旧参数']
          : action === 'continue_observing'
          ? ['等待更多闭环交易或观察天数', '不要扩大参数影响', '继续记录后验收益']
          : ['保持 Canary 参数不变', '等待下一批闭环样本', '若连续改善再考虑扩大'],
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
