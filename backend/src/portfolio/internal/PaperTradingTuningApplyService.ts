import { Op } from 'sequelize';
import { ScheduledTask } from '../models/ScheduledTask';
import { schedulerService } from './SchedulerService';
import { taskParameterAuditService, TaskParameterAuditOperator } from './TaskParameterAuditService';
import { paperTradingPlanService } from './PaperTradingPlanService';
import { recommendationTradeOutcomeService } from './RecommendationTradeOutcomeService';
import { paperTradingOrderIntentService } from './PaperTradingOrderIntentService';
import { PaperTradingCanaryReviewSnapshot } from '../models/PaperTradingCanaryReviewSnapshot';
import { logger } from '../utils/logger';

interface ApplyOrderIntentTuningOptions {
  dry_run?: boolean;
  confirm?: boolean;
  confirm_text?: string;
  parameter_keys?: string[];
  task_ids?: number[];
  canary?: boolean;
  canary_max_parameters?: number;
  canary_observation_trades?: number;
  canary_observation_days?: number;
  use_family_hindsight?: boolean;
  family_hindsight_lookback_days?: number;
  family_hindsight_limit?: number;
  family_hindsight_min_consensus?: number;
  family_hindsight_min_evaluated?: number;
  limit?: number;
  user_id?: number;
  username?: string;
  operator?: TaskParameterAuditOperator;
}

const CANARY_ROLLBACK_CONFIRM_TEXT = 'CONFIRM_CANARY_ROLLBACK';

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

const REASON_PARAMETER_MAP: Record<
  string,
  Array<{
    parameter_key: string;
    parameter_label: string;
    current_value: number;
    loosen_value: number;
    tighten_value: number;
    unit: string;
    loosen_rationale: string;
    tighten_rationale: string;
  }>
> = {
  execution_reality: [
    {
      parameter_key: 'min_avg_turnover_yuan',
      parameter_label: '最低日均成交额',
      current_value: 30000000,
      loosen_value: 26000000,
      tighten_value: 36000000,
      unit: '元',
      loosen_rationale:
        '多账户后验证明真实成交约束可能错杀机会，Canary 仅小幅降低流动性门槛，仍保留涨跌停/停牌硬拦截。',
      tighten_rationale:
        '多账户后验证明真实成交约束有效避险，Canary 小幅提高流动性门槛，减少低成交额标的消耗资金。',
    },
  ],
  market_data: [
    {
      parameter_key: 'min_avg_turnover_yuan',
      parameter_label: '最低日均成交额',
      current_value: 30000000,
      loosen_value: 26000000,
      tighten_value: 36000000,
      unit: '元',
      loosen_rationale:
        '行情/数据质量拦截若在多个账户中被后验证明偏严，可小幅降低流动性门槛做有限试错。',
      tighten_rationale: '行情/数据质量拦截若持续避免亏损，应提高流动性门槛，优先保护本金。',
    },
  ],
  entry_risk_guard: [
    {
      parameter_key: 'max_daily_new_positions',
      parameter_label: '单日新增持仓上限',
      current_value: 3,
      loosen_value: 4,
      tighten_value: 2,
      unit: '笔',
      loosen_rationale:
        '入场风控在多个账户出现错杀时，只增加一笔小流量试错名额，避免一次放大敞口。',
      tighten_rationale: '入场风控有效避险时，减少单日新增仓位，让弱环境下的纪律更可执行。',
    },
    {
      parameter_key: 'max_daily_new_exposure_pct',
      parameter_label: '单日新增敞口上限',
      current_value: 12,
      loosen_value: 13,
      tighten_value: 10,
      unit: '%',
      loosen_rationale: '仅小幅放松新增敞口，避免多账户错杀信号被完全挡在模拟盘外。',
      tighten_rationale: '收紧新增敞口，把已被证明有效的拦截转化为更稳的仓位纪律。',
    },
  ],
  market_environment_guard: [
    {
      parameter_key: 'max_daily_new_positions',
      parameter_label: '单日新增持仓上限',
      current_value: 3,
      loosen_value: 4,
      tighten_value: 2,
      unit: '笔',
      loosen_rationale: '市场环境拦截若多账户错杀，可只增加一笔观察仓，不直接扩大满额跟单。',
      tighten_rationale: '市场环境拦截有效避险时，降低新增持仓数，优先等环境改善。',
    },
  ],
  position_limit: [
    {
      parameter_key: 'max_daily_new_positions',
      parameter_label: '单日新增持仓上限',
      current_value: 3,
      loosen_value: 4,
      tighten_value: 2,
      unit: '笔',
      loosen_rationale: '持仓上限若多账户错杀，可用一笔 Canary 名额验证是否提高收益。',
      tighten_rationale: '持仓上限若避免亏损，应减少新增仓位，降低组合噪声。',
    },
  ],
  profit_gate: [
    {
      parameter_key: 'profit_gate_min_quality_score',
      parameter_label: '收益闸门质量分',
      current_value: 45,
      loosen_value: 42,
      tighten_value: 52,
      unit: '分',
      loosen_rationale: '收益闸门多账户错杀时，仅小幅降低质量分，让少量候选进入验证。',
      tighten_rationale: '收益闸门多账户避险有效时，提高质量分，减少低质量信号消耗资金。',
    },
    {
      parameter_key: 'profit_gate_sampling_multiplier',
      parameter_label: '收益闸门抽样仓位倍率',
      current_value: 0.35,
      loosen_value: 0.42,
      tighten_value: 0.28,
      unit: 'x',
      loosen_rationale: '放松时仍走抽样仓位，不直接恢复满仓位。',
      tighten_rationale: '收紧时降低抽样仓位，保留验证通道但减少亏损。',
    },
  ],
  outcome_feedback: [
    {
      parameter_key: 'min_score',
      parameter_label: '最低推荐评分',
      current_value: 72,
      loosen_value: 70,
      tighten_value: 75,
      unit: '分',
      loosen_rationale: '收益闭环后验证明评分线偏严时，小幅降低门槛扩大候选池。',
      tighten_rationale: '收益闭环后验证明低分样本拖累收益时，提高评分线。',
    },
  ],
  risk_level: [
    {
      parameter_key: 'min_score',
      parameter_label: '最低推荐评分',
      current_value: 72,
      loosen_value: 70,
      tighten_value: 75,
      unit: '分',
      loosen_rationale: '风险等级拦截若多账户错杀，可小幅降低评分线，让高质量样本进入试错。',
      tighten_rationale: '风险等级拦截若多账户避险有效，应提高评分线。',
    },
  ],
  trade_discipline: [
    {
      parameter_key: 'default_position_pct',
      parameter_label: '默认单票仓位',
      current_value: 5,
      loosen_value: 5.25,
      tighten_value: 4.5,
      unit: '%',
      loosen_rationale: '交易纪律错杀时只微增仓位，避免因为短期样本过拟合而放大风险。',
      tighten_rationale: '交易纪律避险有效时先降低单票仓位，把验证放在更小风险下进行。',
    },
  ],
  capital_or_lot_size: [
    {
      parameter_key: 'min_trade_amount',
      parameter_label: '最低单笔交易额',
      current_value: 3000,
      loosen_value: 2500,
      tighten_value: 4000,
      unit: '元',
      loosen_rationale:
        '资金/一手限制在多个账户出现错杀时，只小幅降低最低交易额，提高冷启动小仓试错能力。',
      tighten_rationale: '小额交易若多账户后验证明噪声高，则提高最低交易额，减少无效订单。',
    },
  ],
};

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

function stripSnapshotStatus(status: any) {
  if (!status || typeof status !== 'object') return status;
  const { audits, audit, ...safeStatus } = status;
  return safeStatus;
}

export class PaperTradingTuningApplyService {
  async applyOrderIntentTuningPreview(options: ApplyOrderIntentTuningOptions = {}) {
    const dryRun = toBoolean(options.dry_run, true);
    const canary = toBoolean(options.canary, false);
    const useFamilyHindsight = toBoolean(options.use_family_hindsight, canary);
    const canaryMaxParameters = toPositiveInt(options.canary_max_parameters, 1, 3);
    const canaryObservationTrades = toPositiveInt(options.canary_observation_trades, 8, 30);
    const canaryObservationDays = toPositiveInt(options.canary_observation_days, 10, 60);
    const familyHindsightMinConsensus = toPositiveInt(options.family_hindsight_min_consensus, 2, 5);
    const familyHindsightMinEvaluated = toPositiveInt(
      options.family_hindsight_min_evaluated,
      5,
      50
    );
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
    const familyHindsight = useFamilyHindsight
      ? await paperTradingOrderIntentService
          .getFamilyHindsightDashboard({
            user_id: options.user_id,
            username: options.username,
            lookback_days: toPositiveInt(options.family_hindsight_lookback_days, 45, 3650),
            limit: toPositiveInt(options.family_hindsight_limit, 3000, 10000),
          })
          .catch(() => null)
      : null;
    const familyCandidates = familyHindsight
      ? this.buildFamilyHindsightPreviews(familyHindsight, {
          minConsensus: familyHindsightMinConsensus,
          minEvaluated: familyHindsightMinEvaluated,
        }).filter((item: any) => selectedKeys.size === 0 || selectedKeys.has(item.parameter_key))
      : [];
    const mergedPreviews = this.mergePreviewCandidates(rawPreviews, familyCandidates);
    const previews = canary
      ? this.pickCanaryPreviews(mergedPreviews, canaryMaxParameters)
      : mergedPreviews;

    if (previews.length === 0) {
      return {
        dry_run: dryRun,
        applied: false,
        canary,
        message: '当前没有通过稳定窗口的订单意图调参预览，暂不更新任务参数。',
        changes: [],
        preview_count: rawPreviews.length,
        family_hindsight_preview_count: familyCandidates.length,
        selected_preview_count: 0,
        applied_count: 0,
        family_hindsight: familyHindsight
          ? this.summarizeFamilyHindsightForResult(familyHindsight, familyCandidates, {
              minConsensus: familyHindsightMinConsensus,
              minEvaluated: familyHindsightMinEvaluated,
            })
          : undefined,
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
          evidence_sources: uniqueStrings(previews.map((item: any) => item.evidence_source)),
          guardrails: [
            '每次最多放行少量参数，避免多变量同时变化导致收益归因失真。',
            '写入任务参数但不立即触发买卖，等待下一轮自动任务自然运行。',
            '后续用推荐交易收益闭环观察样本数、胜率、超额收益和最大亏损。',
            '多账户后验候选必须至少两个策略账户同向，且单账户样本达到最低评估数。',
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
          event_type: canary ? 'order_intent_tuning_canary_applied' : 'order_intent_tuning_applied',
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
          ? `已生成 Canary 小流量调参预览：${changes.length} 个任务、${
              canaryPlan?.selected_parameter_keys.length || 0
            } 个参数，确认后先小范围观察。`
          : canary
          ? `已应用 Canary 小流量调参：${changes.length} 个任务、${
              canaryPlan?.selected_parameter_keys.length || 0
            } 个参数，等待后续收益闭环观察。`
          : dryRun
          ? `已生成 ${changes.length} 个任务的订单意图调参预览，确认后才会写入。`
          : `已应用 ${changes.length} 个任务的订单意图调参建议，并重新加载启用中的定时任务。`,
      preview_count: rawPreviews.length,
      family_hindsight_preview_count: familyCandidates.length,
      selected_preview_count: previews.length,
      applied_count: dryRun ? 0 : changes.length,
      generated_at: plan.generated_at,
      tuning_preview_conclusion: plan.summary.order_intent_feedback?.tuning_preview_conclusion,
      previews,
      family_hindsight: familyHindsight
        ? this.summarizeFamilyHindsightForResult(familyHindsight, familyCandidates, {
            minConsensus: familyHindsightMinConsensus,
            minEvaluated: familyHindsightMinEvaluated,
          })
        : undefined,
      changes,
      canary_plan: canaryPlan,
      apply_mode: dryRun
        ? canary
          ? 'canary_preview'
          : 'preview'
        : canary
        ? 'canary'
        : 'manual_confirmed',
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
    const startDate = appliedAt ? new Date(appliedAt).toISOString().slice(0, 10) : undefined;
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
    const evidence = this.buildCanaryEvidenceSummary(
      relatedAudits.length ? relatedAudits : [activeAudit],
      canary
    );

    const result = {
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
      evidence,
      recent_outcomes: dashboard.outcomes.slice(0, 8),
      audits,
      summary: {
        conclusion,
      },
    };
    const snapshot = await this.recordCanaryReviewSnapshot(result, options).catch(error => {
      logger.warn(`记录 Canary 评审快照失败: ${error?.message || error}`);
      return null;
    });
    if (snapshot) {
      (result as any).snapshot_capture = {
        captured: true,
        snapshot_id: Number((snapshot as any).id),
        generated_at: (snapshot as any).generated_at,
      };
    }
    return result;
  }

  async listCanaryReviewSnapshots(options: ApplyOrderIntentTuningOptions = {}) {
    const limit = toPositiveInt(options.limit, 12, 100);
    const where: any = {};
    if (options.user_id) {
      where.user_id = options.user_id;
    } else if (options.username) {
      where.username = options.username;
    }

    const rows = await PaperTradingCanaryReviewSnapshot.findAll({
      where,
      order: [['generated_at', 'DESC']],
      limit,
    });
    const snapshots = rows.map(row => {
      const plain = toPlain(row);
      return {
        ...plain,
        review_score: roundNumber(plain.review_score, 2),
        avg_excess_return_pct: roundNumber(plain.avg_excess_return_pct, 4),
        avg_closed_return_pct: roundNumber(plain.avg_closed_return_pct, 4),
        avg_mae_pct: roundNumber(plain.avg_mae_pct, 4),
        worst_adverse_excursion_pct: roundNumber(plain.worst_adverse_excursion_pct, 4),
        win_rate: roundNumber(plain.win_rate, 2),
        profit_factor: roundNumber(plain.profit_factor, 4),
        total_pnl: roundNumber(plain.total_pnl, 2),
      };
    });

    const latest = snapshots[0];
    const promoteCount = snapshots.filter(item => item.action === 'promote').length;
    const rollbackCount = snapshots.filter(item => item.action === 'rollback').length;
    const drawdownBlockedCount = snapshots.filter(
      item => item.drawdown_guard_passed === false
    ).length;
    const avgScore =
      snapshots.length > 0
        ? roundNumber(
            snapshots.reduce((sum, item) => sum + Number(item.review_score || 0), 0) /
              snapshots.length,
            2
          )
        : 0;

    return {
      generated_at: new Date().toISOString(),
      summary: {
        snapshot_count: snapshots.length,
        latest_action: latest?.action,
        latest_action_label: latest?.action_label,
        latest_review_score: latest?.review_score,
        promote_count: promoteCount,
        rollback_count: rollbackCount,
        drawdown_blocked_count: drawdownBlockedCount,
        avg_review_score: avgScore,
        conclusion: latest
          ? `最近一次 Canary 评审为「${latest.action_label || latest.action || '未知'}」，评分 ${
              latest.review_score || 0
            }，闭环 ${latest.closed_count || 0} 笔。`
          : '暂无 Canary 评审快照；刷新 Canary 状态后会自动沉淀快照。',
      },
      snapshots,
    };
  }

  async getTuningCandidates(options: ApplyOrderIntentTuningOptions = {}) {
    const useFamilyHindsight = toBoolean(options.use_family_hindsight, true);
    const familyHindsightMinConsensus = toPositiveInt(options.family_hindsight_min_consensus, 2, 5);
    const familyHindsightMinEvaluated = toPositiveInt(
      options.family_hindsight_min_evaluated,
      5,
      50
    );
    const selectedKeys = new Set(
      (options.parameter_keys || [])
        .map(key => String(key || '').trim())
        .filter(key => PARAMETER_ALLOWLIST.includes(key))
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

    const stableWindowCandidates = (
      plan.summary.order_intent_feedback?.parameter_adjustment_preview || []
    )
      .filter((item: any) => PARAMETER_ALLOWLIST.includes(String(item.parameter_key || '')))
      .map((item: any) => ({
        ...item,
        evidence_source: item.evidence_source || 'stable_window',
        evidence_source_label: item.evidence_source_label || '稳定窗口',
      }))
      .filter((item: any) => selectedKeys.size === 0 || selectedKeys.has(item.parameter_key));
    const familyHindsight = useFamilyHindsight
      ? await paperTradingOrderIntentService
          .getFamilyHindsightDashboard({
            user_id: options.user_id,
            username: options.username,
            lookback_days: toPositiveInt(options.family_hindsight_lookback_days, 45, 3650),
            limit: toPositiveInt(options.family_hindsight_limit, 3000, 10000),
          })
          .catch(() => null)
      : null;
    const familyCandidates = familyHindsight
      ? this.buildFamilyHindsightPreviews(familyHindsight, {
          minConsensus: familyHindsightMinConsensus,
          minEvaluated: familyHindsightMinEvaluated,
        }).filter((item: any) => selectedKeys.size === 0 || selectedKeys.has(item.parameter_key))
      : [];
    const mergedCandidates = this.mergePreviewCandidates(stableWindowCandidates, familyCandidates);
    const canaryCandidates = this.pickCanaryPreviews(
      mergedCandidates,
      toPositiveInt(options.canary_max_parameters, 1, 3)
    );

    return {
      generated_at: plan.generated_at,
      read_only: true,
      thresholds: {
        family_hindsight_min_consensus: familyHindsightMinConsensus,
        family_hindsight_min_evaluated: familyHindsightMinEvaluated,
      },
      summary: {
        stable_window_candidate_count: stableWindowCandidates.length,
        family_hindsight_candidate_count: familyCandidates.length,
        merged_candidate_count: mergedCandidates.length,
        canary_candidate_count: canaryCandidates.length,
        evidence_sources: uniqueStrings(mergedCandidates.map((item: any) => item.evidence_source)),
        conclusion:
          mergedCandidates.length > 0
            ? `当前共有 ${mergedCandidates.length} 条只读调参候选，其中 Canary 推荐先观察 ${canaryCandidates.length} 条。`
            : '当前没有满足稳定窗口或多账户后验门槛的调参候选，继续观察。',
      },
      family_hindsight: familyHindsight
        ? this.summarizeFamilyHindsightForResult(familyHindsight, familyCandidates, {
            minConsensus: familyHindsightMinConsensus,
            minEvaluated: familyHindsightMinEvaluated,
          })
        : undefined,
      candidates: mergedCandidates,
      canary_candidates: canaryCandidates,
    };
  }

  async applyCanaryRollback(options: ApplyOrderIntentTuningOptions = {}) {
    const dryRun = toBoolean(options.dry_run, true);
    const confirm = toBoolean(options.confirm, false);
    const status = await this.getCanaryStatus(options);
    if (!status.active) {
      return {
        dry_run: dryRun,
        applied: false,
        confirm_required: true,
        confirm_text: CANARY_ROLLBACK_CONFIRM_TEXT,
        can_apply: false,
        blocked_reason: '暂无可回滚的 Canary 调参记录。',
        message: '暂无可回滚的 Canary 调参记录。',
        rollback_plan: null,
        changes: [],
      };
    }

    const rollbackPlan = (status as any).rollback_plan;
    const allItems = Array.isArray(rollbackPlan?.items) ? rollbackPlan.items : [];
    const selectedTaskIds = new Set(
      (options.task_ids || []).map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0)
    );
    const selectedKeys = new Set(
      (options.parameter_keys || [])
        .map(key => String(key || '').trim())
        .filter(key => PARAMETER_ALLOWLIST.includes(key))
    );
    const scopedItems = allItems
      .filter(
        (item: any) => selectedTaskIds.size === 0 || selectedTaskIds.has(Number(item.task_id))
      )
      .map((item: any) => ({
        ...item,
        parameters: (item.parameters || []).filter((parameter: any) => {
          if (selectedKeys.size > 0 && !selectedKeys.has(parameter.key)) return false;
          return Boolean(parameter.needs_rollback);
        }),
      }))
      .filter((item: any) => item.parameters.length > 0);

    const changes = scopedItems.map((item: any) => {
      const currentParameters = Object.fromEntries(
        item.parameters.map((parameter: any) => [parameter.key, parameter.current_value])
      );
      const restoreParameters = Object.fromEntries(
        item.parameters.map((parameter: any) => [parameter.key, parameter.restore_value])
      );
      return {
        task_id: item.task_id,
        task_name: item.task_name,
        task_type: item.task_type,
        audit_id: item.audit_id,
        changed_keys: item.parameters.map((parameter: any) => parameter.key),
        current_parameters: currentParameters,
        restore_parameters: restoreParameters,
        parameters: item.parameters,
      };
    });

    const hasManualReviewRisk = scopedItems.some((item: any) =>
      (item.parameters || []).some((parameter: any) => parameter.changed_after_canary)
    );
    const canApply =
      changes.length > 0 &&
      !hasManualReviewRisk &&
      rollbackPlan?.safety_state !== 'manual_review' &&
      rollbackPlan?.safety_state !== 'no_change';

    if (!dryRun && (!confirm || options.confirm_text !== CANARY_ROLLBACK_CONFIRM_TEXT)) {
      throw new Error(
        `回滚 Canary 参数必须传 confirm=true 且 confirm_text=${CANARY_ROLLBACK_CONFIRM_TEXT}`
      );
    }
    if (!dryRun && !canApply) {
      throw new Error(
        hasManualReviewRisk
          ? 'Canary 后部分参数又被其它流程修改，禁止直接回滚，请人工核对。'
          : '当前没有可应用的 Canary 回滚参数。'
      );
    }

    if (!dryRun) {
      const tasks = await ScheduledTask.findAll({
        where: { id: { [Op.in]: changes.map((change: any) => Number(change.task_id)) } },
      });
      const taskById = new Map<number, ScheduledTask>();
      tasks.forEach(task => taskById.set(Number(task.id), task));

      for (const change of changes) {
        const task = taskById.get(Number(change.task_id));
        if (!task) continue;
        const beforeParameters = { ...(task.parameters || {}) };
        const afterParameters = { ...beforeParameters, ...change.restore_parameters };
        await task.update({ parameters: afterParameters });
        await taskParameterAuditService.record({
          task,
          event_type: 'order_intent_tuning_canary_rollback',
          before_parameters: beforeParameters,
          after_parameters: afterParameters,
          changed_keys: change.changed_keys,
          operator: options.operator,
          metadata: {
            source: 'paper_trading_order_intent_canary_rollback',
            canary_audit_id: change.audit_id,
            rollback_reason: (status as any).review?.action_label || '',
            attribution: (status as any).attribution,
            rollback_plan_summary: {
              safety_state: rollbackPlan?.safety_state,
              safety_label: rollbackPlan?.safety_label,
              rollback_key_count: rollbackPlan?.rollback_key_count,
            },
          },
        });
        await schedulerService.reloadTask(Number(task.id));
      }
    }

    return {
      dry_run: dryRun,
      applied: !dryRun,
      confirm_required: true,
      confirm_text: CANARY_ROLLBACK_CONFIRM_TEXT,
      can_apply: canApply,
      blocked_reason: canApply
        ? ''
        : hasManualReviewRisk
        ? 'Canary 后部分参数又被其它流程修改，需人工核对。'
        : '当前没有可回滚参数。',
      rollback_plan: rollbackPlan,
      changes,
      applied_count: dryRun ? 0 : changes.length,
      message:
        changes.length === 0
          ? '当前没有可回滚的 Canary 参数。'
          : dryRun
          ? `Canary 回滚预览完成：将影响 ${changes.length} 个任务、${
              uniqueStrings(changes.flatMap((change: any) => change.changed_keys)).length
            } 个参数；当前未写入。`
          : `Canary 回滚已应用：恢复 ${changes.length} 个任务参数，并写入审计日志。`,
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
        restore_parameters: Object.fromEntries(
          changedKeys.map((key: string) => [key, before?.[key]])
        ),
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
      avg_mae_pct: roundNumber(summary.avg_mae_pct, 4),
      worst_adverse_excursion_pct: roundNumber(summary.worst_trade?.max_adverse_excursion_pct, 4),
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

  private async recordCanaryReviewSnapshot(status: any, options: ApplyOrderIntentTuningOptions) {
    if (!status?.active || !status.review) return null;

    const generatedAt = new Date(status.generated_at || Date.now());
    const review = status.review || {};
    const metrics = review.metrics || {};
    const observation = status.observation || {};
    const outcomeSummary = status.outcome_summary || {};
    const attribution = status.attribution || {};
    const evidence = status.evidence || {};
    const auditId = Number(status.audit?.id || 0) || undefined;
    const coreFingerprint = {
      action: review.action,
      ready_for_review: Boolean(review.ready_for_review),
      closed_count: Number(metrics.closed_count ?? outcomeSummary.closed_count ?? 0),
      open_count: Number(metrics.open_count ?? outcomeSummary.open_count ?? 0),
      review_score: roundNumber(review.review_score, 2),
      drawdown_guard_passed:
        review.drawdown_guard?.passed === undefined
          ? undefined
          : Boolean(review.drawdown_guard.passed),
    };
    const latestWhere: any = {};
    if (auditId) latestWhere.audit_id = auditId;
    if (options.user_id) latestWhere.user_id = options.user_id;
    else if (options.username) latestWhere.username = options.username;

    if (Object.keys(latestWhere).length > 0) {
      const latest = await PaperTradingCanaryReviewSnapshot.findOne({
        where: latestWhere,
        order: [['generated_at', 'DESC']],
      });
      const latestPlain = toPlain(latest);
      const latestGeneratedAt = latestPlain?.generated_at
        ? new Date(latestPlain.generated_at).getTime()
        : 0;
      const recentEnough =
        latestGeneratedAt > 0 && generatedAt.getTime() - latestGeneratedAt < 6 * 60 * 60 * 1000;
      const sameFingerprint =
        latestPlain &&
        latestPlain.action === coreFingerprint.action &&
        Boolean(latestPlain.ready_for_review) === coreFingerprint.ready_for_review &&
        Number(latestPlain.closed_count || 0) === coreFingerprint.closed_count &&
        Number(latestPlain.open_count || 0) === coreFingerprint.open_count &&
        roundNumber(latestPlain.review_score, 2) === coreFingerprint.review_score &&
        latestPlain.drawdown_guard_passed === coreFingerprint.drawdown_guard_passed;
      if (recentEnough && sameFingerprint) {
        return latest;
      }
    }

    return PaperTradingCanaryReviewSnapshot.create({
      generated_at: generatedAt,
      snapshot_date: generatedAt.toISOString().slice(0, 10),
      user_id: options.user_id,
      username: options.username,
      audit_id: auditId,
      canary_applied_at: status.audit?.created_at ? new Date(status.audit.created_at) : undefined,
      status: 'active',
      action: review.action,
      action_label: review.action_label,
      review_score: roundNumber(review.review_score, 2),
      ready_for_review: Boolean(review.ready_for_review),
      outcome_tone: observation.outcome_tone,
      closed_count: coreFingerprint.closed_count,
      open_count: coreFingerprint.open_count,
      avg_excess_return_pct: roundNumber(
        metrics.avg_excess_return_pct ?? outcomeSummary.avg_excess_return_pct,
        4
      ),
      avg_closed_return_pct: roundNumber(
        metrics.avg_closed_return_pct ?? outcomeSummary.avg_closed_return_pct,
        4
      ),
      avg_mae_pct: roundNumber(metrics.avg_mae_pct ?? outcomeSummary.avg_mae_pct, 4),
      worst_adverse_excursion_pct: roundNumber(
        metrics.worst_adverse_excursion_pct ??
          outcomeSummary.worst_trade?.max_adverse_excursion_pct,
        4
      ),
      win_rate: roundNumber(metrics.win_rate ?? outcomeSummary.win_rate, 2),
      profit_factor: roundNumber(metrics.profit_factor ?? outcomeSummary.profit_factor, 4),
      total_pnl: roundNumber(outcomeSummary.total_pnl ?? attribution.total_pnl, 2),
      drawdown_guard_passed: coreFingerprint.drawdown_guard_passed,
      selected_parameter_keys: review.selected_parameter_keys || [],
      evidence_sources: evidence.evidence_sources || status.canary?.evidence_sources || [],
      observation,
      outcome_summary: outcomeSummary,
      review,
      attribution,
      evidence,
      rollback_plan: status.rollback_plan || {},
      recent_outcomes: Array.isArray(status.recent_outcomes) ? status.recent_outcomes.slice(0, 8) : [],
      metadata: {
        source: 'paper_trading_canary_status',
        related_audit_count: status.related_audit_count || 1,
        summary: status.summary || {},
        safe_status: stripSnapshotStatus(status),
      },
    });
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
    const avgMaePct = roundNumber(input.summary.avg_mae_pct, 4);
    const avgMaeAbs = Math.abs(avgMaePct);
    const worstAdversePct = roundNumber(input.summary.worst_trade?.max_adverse_excursion_pct, 4);
    const worstAdverseAbs = Math.abs(worstAdversePct);
    const winRate = roundNumber(input.summary.win_rate, 2);
    const profitFactor = roundNumber(input.summary.profit_factor, 4);
    const readyByTrades = closedCount >= input.observation.target_closed_trades;
    const readyByDays = input.observation.elapsed_days >= input.observation.target_days;
    const sampleScore = Math.min(
      100,
      (closedCount / Math.max(1, input.observation.target_closed_trades)) * 100
    );
    const performanceScore =
      avgExcess * 12 +
      (winRate - 50) * 0.65 +
      Math.min(18, Math.max(-12, (profitFactor - 1) * 8)) +
      Math.min(8, avgReturn * 0.8);
    const reviewScore = roundNumber(
      Math.max(0, Math.min(100, 50 + performanceScore + sampleScore * 0.18)),
      2
    );

    let action: 'promote' | 'rollback' | 'continue_observing' | 'hold';
    if (!input.observation.ready_for_review) {
      action = 'continue_observing';
    } else if (
      closedCount >= 3 &&
      (avgExcess <= -1.5 || winRate < 35 || profitFactor < 0.75 || avgMaeAbs >= 10)
    ) {
      action = 'rollback';
    } else if (
      closedCount >= 5 &&
      avgExcess >= 0.5 &&
      winRate >= 50 &&
      profitFactor >= 1 &&
      avgMaeAbs <= 6 &&
      worstAdverseAbs <= 12
    ) {
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
    reasons.push(
      `闭环样本 ${closedCount}/${input.observation.target_closed_trades} 笔，运行 ${input.observation.elapsed_days}/${input.observation.target_days} 天。`
    );
    reasons.push(`平均超额 ${avgExcess}%，胜率 ${winRate}%，利润因子 ${profitFactor || 0}。`);
    reasons.push(
      `回撤约束：平均最大不利波动 ${avgMaePct || 0}%，单笔最差不利波动 ${worstAdversePct || 0}%。`
    );
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
        avg_mae_pct: avgMaePct,
        worst_adverse_excursion_pct: worstAdversePct,
        win_rate: winRate,
        profit_factor: profitFactor,
      },
      drawdown_guard: {
        avg_mae_pct: avgMaePct,
        avg_mae_limit_pct: 6,
        worst_adverse_excursion_pct: worstAdversePct,
        worst_adverse_limit_pct: 12,
        passed: avgMaeAbs <= 6 && worstAdverseAbs <= 12,
        conclusion:
          avgMaeAbs <= 6 && worstAdverseAbs <= 12
            ? '回撤约束通过，可继续看收益质量。'
            : '回撤约束未通过，即使收益为正也暂不建议扩大。',
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

  private mergePreviewCandidates(primary: any[], familyCandidates: any[]) {
    const byKey = new Map<string, any>();
    for (const item of [...familyCandidates, ...primary]) {
      const key = `${item.parameter_key}:${item.action}`;
      const existing = byKey.get(key);
      if (!existing || Number(item.confidence || 0) > Number(existing.confidence || 0)) {
        byKey.set(key, item);
      } else if (
        existing &&
        item.evidence_source &&
        existing.evidence_source !== item.evidence_source
      ) {
        existing.evidence_source = 'stable_window+family_hindsight';
        existing.evidence_source_label = '稳定窗口 + 多账户后验';
        existing.confidence = Math.max(
          Number(existing.confidence || 0),
          Number(item.confidence || 0)
        );
      }
    }
    return [...byKey.values()].sort(
      (a, b) =>
        Number(b.confidence || 0) - Number(a.confidence || 0) ||
        Number(b.sample_count || 0) - Number(a.sample_count || 0)
    );
  }

  private buildCanaryEvidenceSummary(audits: any[], canary: any) {
    const previews = audits
      .flatMap((audit: any) => audit?.metadata?.previews || [])
      .filter(Boolean);
    const sourceLabels: Record<string, string> = {
      stable_window: '稳定窗口',
      family_hindsight: '多账户后验',
      'stable_window+family_hindsight': '稳定窗口 + 多账户后验',
    };
    const evidenceSources = uniqueStrings([
      ...(canary?.evidence_sources || []),
      ...previews.map((item: any) => item.evidence_source),
    ]);
    const familyConsensusItems = previews
      .filter((item: any) => item.family_consensus)
      .map((item: any) => ({
        parameter_key: item.parameter_key,
        parameter_label: item.parameter_label,
        action: item.action,
        action_label: item.action_label,
        confidence: item.confidence,
        sample_count: item.sample_count,
        family_consensus: item.family_consensus,
      }));

    return {
      evidence_sources: evidenceSources,
      evidence_source_labels: evidenceSources.map(source => sourceLabels[source] || source),
      candidate_count_by_source: evidenceSources.map(source => ({
        source,
        label: sourceLabels[source] || source || '未知',
        count: previews.filter((item: any) => String(item.evidence_source || '') === source).length,
      })),
      preview_count: previews.length,
      previews: previews.slice(0, 10).map((item: any) => ({
        parameter_key: item.parameter_key,
        parameter_label: item.parameter_label,
        action: item.action,
        action_label: item.action_label,
        confidence: item.confidence,
        sample_count: item.sample_count,
        evidence_source: item.evidence_source,
        evidence_source_label: item.evidence_source_label || sourceLabels[item.evidence_source],
        family_consensus: item.family_consensus,
      })),
      family_consensus_items: familyConsensusItems.slice(0, 8),
      conclusion:
        familyConsensusItems.length > 0
          ? `本次 Canary 包含 ${familyConsensusItems.length} 条多账户后验证据。`
          : previews.length > 0
          ? `本次 Canary 基于 ${previews.length} 条稳定窗口/审计候选。`
          : '本次 Canary 暂无可解析的候选证据。',
    };
  }

  private buildFamilyHindsightPreviews(
    familyHindsight: any,
    options: { minConsensus: number; minEvaluated: number }
  ) {
    const candidates: any[] = [];
    const families = (familyHindsight?.families || []).filter((family: any) => {
      const action = String(family.action || '');
      return (
        ['loosen', 'tighten'].includes(action) &&
        Number(family.evaluated_count || 0) >= options.minEvaluated
      );
    });

    const directionGroups = new Map<string, any[]>();
    for (const family of families) {
      const action = String(family.action || '');
      const list = directionGroups.get(action) || [];
      list.push(family);
      directionGroups.set(action, list);
    }

    for (const [action, group] of directionGroups.entries()) {
      if (group.length < options.minConsensus) continue;
      const reasonCounts = new Map<string, { key: string; label: string; count: number }>();
      for (const family of group) {
        for (const reason of family.top_reason_categories || []) {
          const key = String(reason.key || reason.category || 'unknown');
          const existing = reasonCounts.get(key) || {
            key,
            label: reason.label || key,
            count: 0,
          };
          existing.count += Number(reason.count || 0);
          reasonCounts.set(key, existing);
        }
      }

      const reasons = [...reasonCounts.values()]
        .filter(reason => REASON_PARAMETER_MAP[reason.key]?.length)
        .sort((a, b) => b.count - a.count)
        .slice(0, 4);

      for (const reason of reasons) {
        const templates = REASON_PARAMETER_MAP[reason.key] || [];
        for (const template of templates) {
          const avg = roundNumber(
            group.reduce(
              (sum, family) => sum + Number(family.avg_intended_action_return_pct || 0),
              0
            ) / group.length,
            4
          );
          const sampleCount = group.reduce(
            (sum, family) => sum + Number(family.evaluated_count || 0),
            0
          );
          const confidence = roundNumber(
            Math.min(
              100,
              group.length * 24 +
                Math.min(24, sampleCount * 0.8) +
                Math.min(18, Math.abs(avg) * 4) +
                Math.min(10, Number(reason.count || 0) * 0.4)
            ),
            2
          );
          const previewValue = action === 'loosen' ? template.loosen_value : template.tighten_value;
          const actionLabel = action === 'loosen' ? '建议放松' : '建议收紧';
          candidates.push({
            reason_category: reason.key,
            reason_category_label: reason.label,
            action,
            action_label: actionLabel,
            parameter_key: template.parameter_key,
            parameter_label: template.parameter_label,
            current_value: template.current_value,
            preview_value: previewValue,
            unit: template.unit,
            change_label: `${action === 'loosen' ? '放松' : '收紧'}：${template.current_value}${
              template.unit
            } → ${previewValue}${template.unit}`,
            rationale: action === 'loosen' ? template.loosen_rationale : template.tighten_rationale,
            confidence,
            sample_count: sampleCount,
            apply_status: 'preview_only',
            apply_status_label: '仅预览，未应用',
            evidence_source: 'family_hindsight',
            evidence_source_label: '多账户后验',
            family_consensus: {
              action,
              action_label: actionLabel,
              family_count: group.length,
              portfolio_names: group.map(family => family.portfolio_name),
              evaluated_count: sampleCount,
              false_reject_count: group.reduce(
                (sum, family) => sum + Number(family.false_reject_count || 0),
                0
              ),
              saved_loss_count: group.reduce(
                (sum, family) => sum + Number(family.saved_loss_count || 0),
                0
              ),
              avg_intended_action_return_pct: avg,
              reason_count: reason.count,
              conclusion: `多账户同向 ${group.length} 个，合计后验 ${sampleCount} 条，平均相对 ${avg}%。`,
            },
          });
        }
      }
    }

    return candidates
      .filter(item => PARAMETER_ALLOWLIST.includes(String(item.parameter_key || '')))
      .slice(0, 12);
  }

  private summarizeFamilyHindsightForResult(
    familyHindsight: any,
    candidates: any[],
    options: { minConsensus: number; minEvaluated: number }
  ) {
    return {
      generated_at: familyHindsight.generated_at,
      filters: familyHindsight.filters,
      thresholds: {
        min_consensus_families: options.minConsensus,
        min_evaluated_per_family: options.minEvaluated,
      },
      summary: familyHindsight.summary,
      candidate_count: candidates.length,
      candidates: candidates.slice(0, 8).map(item => ({
        parameter_key: item.parameter_key,
        parameter_label: item.parameter_label,
        action: item.action,
        action_label: item.action_label,
        confidence: item.confidence,
        sample_count: item.sample_count,
        change_label: item.change_label,
        reason_category_label: item.reason_category_label,
        evidence_source_label: item.evidence_source_label,
        family_consensus: item.family_consensus,
      })),
      conclusion:
        candidates.length > 0
          ? `多账户拒单后验生成 ${candidates.length} 条保守 Canary 候选，只允许小流量验证。`
          : `多账户后验未达到 ${options.minConsensus} 个账户同向且每账户 ${options.minEvaluated} 条样本的门槛，继续观察。`,
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
