import { createHash } from 'crypto';
import {
  QuantResearchArtifact,
  QuantResearchArtifactStatus,
} from '../../models/QuantResearchArtifact';
import { QuantResearchExperiment } from '../../models/QuantResearchExperiment';
import { QuantBacktestTask } from '../../models/QuantBacktestTask';
import { QuantBacktestResult } from '../../models/QuantBacktestResult';
import { QuantBacktestOptions } from '../../quant/types/QuantTypes';
import { ResearchIntegrityService } from './ResearchIntegrityService';
import { buildPointInTimeArtifact } from './PointInTimeAuditService';
import {
  buildAuditedReturnReplayArtifact,
  researchTrustPolicyService,
} from './ResearchTrustPolicyService';
import { logger } from '../../utils/logger';
import { quantBacktestQueue } from '../../jobs/quantBacktestQueue';
import sequelize from '../../config/database';

export type QuantResearchVerdict = 'pending' | 'pass' | 'watch' | 'reject' | 'insufficient';

export type ResearchArtifactDraft = {
  artifact_type?:
    | 'backtest'
    | 'integrity_audit'
    | 'point_in_time_audit'
    | 'execution_audit'
    | 'audited_return_replay'
    | 'credibility_summary';
  source_type?: string | null;
  source_id?: number | null;
  status: QuantResearchArtifactStatus;
  title?: string;
  summary: string;
  payload_json?: Record<string, any>;
};

export interface CredibilitySummary {
  verdict: QuantResearchVerdict;
  can_create_observation: boolean;
  blocking_reasons: string[];
  watch_reasons: string[];
  next_action_label: string;
  title: string;
  summary: string;
}

export interface ResearchAuditPayload {
  experiment: any;
  artifacts: any[];
  credibility_verdict: CredibilitySummary;
  can_create_observation: boolean;
  blocking_reasons: string[];
  watch_reasons: string[];
  next_action_label: string;
}

export interface ExecutionConstraintAuditPayload {
  task_id: number;
  experiment: any | null;
  artifact: any;
  status: QuantResearchArtifactStatus;
  title: string;
  summary: string;
  rejected_order_count: number;
  rejected_orders: any[];
  reason_counts: Record<string, number>;
  grouped_reasons: any[];
  diagnostics: Record<string, any>;
}

function statusToReason(artifact: Pick<ResearchArtifactDraft, 'status' | 'summary'>): string {
  return artifact.summary || `状态为 ${artifact.status}`;
}

function mapIntegrityStatus(verdict: string): QuantResearchArtifactStatus {
  const normalized = String(verdict || '').toUpperCase();
  if (normalized === 'PASS') return 'pass';
  if (normalized === 'WARN') return 'watch';
  if (normalized === 'FAIL') return 'reject';
  if (normalized === 'INSUFFICIENT') return 'insufficient';
  return 'error';
}

export function mapResearchIntegrityArtifact(report: any): ResearchArtifactDraft {
  const status = mapIntegrityStatus(report?.verdict);
  return {
    artifact_type: 'integrity_audit',
    source_type: 'research_integrity_audit',
    source_id:
      report?.persisted_id !== null && report?.persisted_id !== undefined
        ? Number(report.persisted_id)
        : null,
    status,
    title: '未来数据检查',
    summary:
      report?.summary_message ||
      (status === 'pass'
        ? '没有发现未来函数或样本可见性问题。'
        : '研究严谨性检查没有生成完整结论。'),
    payload_json: {
      verdict: report?.verdict || null,
      dsr: report?.dsr ?? null,
      pbo: report?.pbo ?? null,
      oos_decay_ratio: report?.oos_decay_ratio ?? null,
      lookahead_issues: report?.lookahead_issues || [],
      survivorship_issues: report?.survivorship_issues || [],
    },
  };
}

export function buildExecutionArtifactFromRejectedOrders(
  rejectedOrders: any[] = [],
  diagnostics: Record<string, any> = {}
): ResearchArtifactDraft {
  const rows = Array.isArray(rejectedOrders) ? rejectedOrders : [];
  const buyFillCount = Number(diagnostics.buy_fill_count || 0);
  const sellFillCount = Number(diagnostics.sell_fill_count || 0);
  const fillCount = buyFillCount + sellFillCount;
  if (rows.length === 0) {
    return {
      artifact_type: 'execution_audit',
      source_type: 'quant_backtest_rejected_orders',
      source_id: null,
      status: 'pass',
      title: 'A股成交约束',
      summary: '没有发现涨跌停、停牌或 T+1 造成的硬阻断。',
      payload_json: { rejected_orders: [] },
    };
  }

  const reasonCounts = rows.reduce<Record<string, number>>((acc, item) => {
    const reason = String(item?.reason || 'unknown');
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});
  const hardReasons = [
    'limit_up',
    'limit_down',
    'suspended',
    't_plus_one_block',
    't_plus_1_violation',
    'st_filtered',
    'next_bar_missing',
    'next_exit_bar_missing',
  ];
  const sizingReasons = ['lot_or_cash_too_small', 'cash_not_enough'];
  const hasHardBlock = Object.keys(reasonCounts).some(reason =>
    hardReasons.some(token => reason.includes(token))
  );
  const hasSizingBlock = Object.keys(reasonCounts).some(reason =>
    sizingReasons.some(token => reason.includes(token))
  );
  const reasonLabels: Record<string, string> = {
    max_positions: '仓位上限',
    already_holding: '已有持仓',
    limit_up_block_buy: '涨停买入',
    limit_up_blocked_buy: '涨停买入',
    limit_down_block_sell: '跌停卖出',
    limit_down_blocked_sell: '跌停卖出',
    t_plus_one_block: 'T+1 限制',
    t_plus_1_violation: 'T+1 限制',
    suspended_or_zero_volume: '停牌或零成交',
    st_filtered: 'ST 过滤',
    turnover_below_threshold: '流动性不足',
    next_bar_missing: '次日行情缺失',
    next_exit_bar_missing: '次日退出行情缺失',
    lot_or_cash_too_small: '金额不足',
    cash_not_enough: '现金不足',
    unknown: '其他原因',
  };
  const groupedReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({
      reason,
      count,
      label: reasonLabels[reason] || reason.replace(/_/g, ' '),
    }));
  const reasonSummary = groupedReasons
    .slice(0, 5)
    .map(item => `${item.label} ${item.count} 笔`)
    .join('，');
  const status: QuantResearchArtifactStatus =
    fillCount > 0 ? 'watch' : hasHardBlock || hasSizingBlock ? 'reject' : 'watch';
  const summary =
    status === 'reject'
      ? `未形成可观察成交，且有 ${rows.length} 笔订单受约束影响${
          reasonSummary ? `：${reasonSummary}` : '。'
        }`
      : `A 股约束已纳入回测：共跳过 ${rows.length} 笔候选/退出单${
          reasonSummary ? `，${reasonSummary}` : ''
        }。`;

  return {
    artifact_type: 'execution_audit',
    source_type: 'quant_backtest_rejected_orders',
    source_id: null,
    status,
    title: 'A股成交约束',
    summary,
    payload_json: {
      rejected_order_count: rows.length,
      buy_fill_count: buyFillCount,
      sell_fill_count: sellFillCount,
      reason_counts: reasonCounts,
      grouped_reasons: groupedReasons,
      rejected_orders: rows,
    },
  };
}

export function buildCredibilitySummary(input: {
  backtest_artifact?: Pick<ResearchArtifactDraft, 'status' | 'summary'> | null;
  integrity_artifact?: Pick<ResearchArtifactDraft, 'status' | 'summary'> | null;
  point_in_time_artifact?: Pick<ResearchArtifactDraft, 'status' | 'summary'> | null;
  execution_artifact?: Pick<ResearchArtifactDraft, 'status' | 'summary'> | null;
  audited_return_artifact?: Pick<ResearchArtifactDraft, 'status' | 'summary'> | null;
}): CredibilitySummary {
  const artifacts = [
    input.backtest_artifact,
    input.integrity_artifact,
    input.point_in_time_artifact,
    input.execution_artifact,
    input.audited_return_artifact,
  ].filter(Boolean) as Array<Pick<ResearchArtifactDraft, 'status' | 'summary'>>;
  const statuses = artifacts.map(item => item.status);
  const blocking_reasons = artifacts
    .filter(item => item.status === 'reject' || item.status === 'error')
    .map(statusToReason);
  const watch_reasons = artifacts.filter(item => item.status === 'watch').map(statusToReason);
  const insufficient_reasons = artifacts
    .filter(item => item.status === 'insufficient' || item.status === 'pending')
    .map(statusToReason);

  let verdict: QuantResearchVerdict = 'pass';
  if (statuses.includes('reject') || statuses.includes('error')) {
    verdict = 'reject';
  } else if (statuses.includes('insufficient') || statuses.includes('pending')) {
    verdict = 'insufficient';
  } else if (statuses.includes('watch')) {
    verdict = 'watch';
  }

  if (artifacts.length === 0) {
    verdict = 'pending';
  }

  const can_create_observation = verdict === 'pass' || verdict === 'watch';
  const allBlockingReasons =
    verdict === 'insufficient' ? [...blocking_reasons, ...insufficient_reasons] : blocking_reasons;

  const title =
    verdict === 'pass'
      ? '可信度通过'
      : verdict === 'watch'
      ? '可信度需谨慎'
      : verdict === 'reject'
      ? '可信度阻断'
      : verdict === 'insufficient'
      ? '可信度数据不足'
      : '可信度待生成';
  const summary =
    verdict === 'pass'
      ? '回测来源、未来数据检查和 A 股成交约束都没有发现阻断问题。'
      : verdict === 'watch'
      ? `可以进入模拟观察，但需要注意：${watch_reasons.join('；')}`
      : verdict === 'reject'
      ? `暂不允许进入模拟观察：${blocking_reasons.join('；')}`
      : verdict === 'insufficient'
      ? `暂不允许进入模拟观察：${insufficient_reasons.join('；')}`
      : '回测完成后会自动生成可信度结论。';

  return {
    verdict,
    can_create_observation,
    blocking_reasons: allBlockingReasons,
    watch_reasons,
    next_action_label: can_create_observation
      ? '进入模拟观察'
      : verdict === 'insufficient' || verdict === 'pending'
      ? '回到查数据'
      : '修正后再测一次',
    title,
    summary,
  };
}

function stableStringify(value: any): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value: any): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 12);
}

function asPlain(row: any) {
  return row && typeof row.toJSON === 'function' ? row.toJSON() : row;
}

function artifactByType(artifacts: any[], artifact_type: string) {
  return artifacts.find(item => item.artifact_type === artifact_type) || null;
}

function credibilityToArtifactStatus(
  credibility: CredibilitySummary
): QuantResearchArtifactStatus {
  if (credibility.verdict === 'pass' || credibility.verdict === 'watch') {
    return credibility.verdict;
  }
  return credibility.verdict === 'pending' ? 'pending' : credibility.verdict;
}

function sameOwner(rowUserId: any, user_id?: number | null): boolean {
  if (!user_id || rowUserId === null || rowUserId === undefined) return true;
  return Number(rowUserId) === Number(user_id);
}

function rawOptionsFromTask(task: QuantBacktestTask): Record<string, any> {
  return task.parameters && typeof task.parameters === 'object' ? task.parameters : {};
}

function aggregateExecutionDiagnostics(results: QuantBacktestResult[]) {
  return results.reduce<Record<string, number>>((acc, result) => {
    const metrics = (result.metrics_json || {}) as any;
    const diagnostics = metrics.execution_diagnostics || {};
    for (const key of ['buy_fill_count', 'sell_fill_count', 'rejected_order_count']) {
      acc[key] = (acc[key] || 0) + Number(diagnostics[key] || 0);
    }
    return acc;
  }, {});
}

function bestResultToPayload(result: QuantBacktestResult | null) {
  if (!result) return null;
  return {
    result_id: result.id,
    strategy_key: result.strategy_key,
    strategy_name: result.strategy_name,
    total_return_pct: Number(result.total_return_pct || 0),
    annual_return_pct: Number(result.annual_return_pct || 0),
    max_drawdown_pct: Number(result.max_drawdown_pct || 0),
    sharpe_ratio: Number(result.sharpe_ratio || 0),
    trade_count: Number(result.trade_count || 0),
  };
}

function buildBacktestArtifact(task: QuantBacktestTask, bestResult: QuantBacktestResult | null) {
  if (!bestResult) {
    return {
      artifact_type: 'backtest',
      source_type: 'quant_backtest_task',
      source_id: task.id,
      status: task.status === 'FAILED' ? 'reject' : 'insufficient',
      title: '回测来源',
      summary:
        task.status === 'FAILED'
          ? task.error_message || '回测失败，没有可信结果。'
          : '回测完成但没有生成策略结果。',
      payload_json: {
        task_id: task.id,
        task_status: task.status,
        error_message: task.error_message || null,
      },
    } as ResearchArtifactDraft;
  }

  return {
    artifact_type: 'backtest',
    source_type: 'quant_backtest_result',
    source_id: bestResult.id,
    status: 'pass',
    title: '回测来源',
    summary: `${bestResult.strategy_name || bestResult.strategy_key} 回测完成，总收益 ${Number(
      bestResult.total_return_pct || 0
    ).toFixed(2)}%，最大回撤 ${Number(bestResult.max_drawdown_pct || 0).toFixed(2)}%。`,
    payload_json: {
      task_id: task.id,
      result_id: bestResult.id,
      strategy_key: bestResult.strategy_key,
      strategy_name: bestResult.strategy_name,
      total_return_pct: Number(bestResult.total_return_pct || 0),
      excess_return_pct: Number(bestResult.excess_return_pct || 0),
      max_drawdown_pct: Number(bestResult.max_drawdown_pct || 0),
      sharpe_ratio: Number(bestResult.sharpe_ratio || 0),
      trade_count: Number(bestResult.trade_count || 0),
    },
  } as ResearchArtifactDraft;
}

function buildResearchAuditPayload(
  experiment: any,
  artifacts: any[],
  storedSummary?: CredibilitySummary | null
): ResearchAuditPayload {
  const plainArtifacts = artifacts.map(row => asPlain(row));
  const credibility_verdict =
    storedSummary ||
    buildCredibilitySummary({
      backtest_artifact: artifactByType(plainArtifacts, 'backtest'),
      integrity_artifact: artifactByType(plainArtifacts, 'integrity_audit'),
      point_in_time_artifact: artifactByType(plainArtifacts, 'point_in_time_audit'),
      execution_artifact: artifactByType(plainArtifacts, 'execution_audit'),
      audited_return_artifact: artifactByType(plainArtifacts, 'audited_return_replay'),
    });
  return {
    experiment: asPlain(experiment),
    artifacts: plainArtifacts,
    credibility_verdict,
    can_create_observation: Boolean(credibility_verdict.can_create_observation),
    blocking_reasons: credibility_verdict.blocking_reasons || [],
    watch_reasons: credibility_verdict.watch_reasons || [],
    next_action_label: credibility_verdict.next_action_label || '回到查数据',
  };
}

export class ResearchExperimentService {
  constructor(private integrityService = new ResearchIntegrityService()) {}

  async createExperiment(input: Record<string, any>, user_id?: number | null) {
    const strategyKeys = Array.isArray(input.strategy_keys)
      ? input.strategy_keys
      : input.strategy_key
      ? [input.strategy_key]
      : [];
    const strategy_key = String(strategyKeys[0] || input.strategy_key || 'unknown');
    const seed = {
      user_id: user_id || null,
      strategy_key,
      template_id: input.template_id || null,
      start_date: input.start_date,
      end_date: input.end_date,
      universe: input.universe || 'market',
      symbols: input.symbols || [],
      hypothesis: input.hypothesis || '',
      created_at: Date.now(),
    };
    const dataPolicy = researchTrustPolicyService.buildDataPolicy(input.data_policy_json || {}, {
      as_of_date: input.as_of_date || input.start_date,
      start_date: input.start_date,
      end_date: input.end_date,
    });
    const constraintPolicy = researchTrustPolicyService.buildConstraintPolicy(
      input.constraint_policy_json || {}
    );
    const experiment = await QuantResearchExperiment.create({
      user_id: user_id || null,
      experiment_key: `qresearch_${shortHash(seed)}`,
      hypothesis: input.hypothesis || null,
      strategy_key,
      template_id: input.template_id || null,
      task_id: input.task_id || null,
      status: input.status || 'draft',
      verdict: 'pending',
      start_date: input.start_date,
      end_date: input.end_date,
      universe: input.universe || 'market',
      symbols: input.symbols || [],
      params_json: input.params_json || input.params_by_strategy || {},
      data_policy_json: dataPolicy,
      cost_policy_json: input.cost_policy_json || {},
      constraint_policy_json: constraintPolicy,
      summary_json: {},
    } as any);
    if (input.task_id) {
      await QuantBacktestTask.update(
        {
          experiment_id: experiment.id,
          data_policy_json: dataPolicy,
          constraint_policy_json: constraintPolicy,
        } as any,
        { where: { id: input.task_id } }
      );
    }
    return experiment;
  }

  async createOrAttachForBacktest(
    options: QuantBacktestOptions,
    task: QuantBacktestTask,
    user_id?: number
  ) {
    const rawOptions = options as any;
    const explicitExperimentId = Number(rawOptions.experiment_id || task.experiment_id || 0);
    if (explicitExperimentId > 0) {
      const existing = await QuantResearchExperiment.findByPk(explicitExperimentId);
      if (existing) {
        if (!sameOwner(existing.user_id, user_id)) {
          const error = new Error('无权绑定其他用户的研究实验') as Error & { status?: number };
          error.status = 403;
          throw error;
        }
        const dataPolicy = researchTrustPolicyService.buildDataPolicy(
          rawOptions.data_policy_json || existing.data_policy_json || {},
          {
            as_of_date: rawOptions.as_of_date || rawOptions.start_date || existing.start_date,
            start_date: rawOptions.start_date || existing.start_date,
            end_date: rawOptions.end_date || existing.end_date,
          }
        );
        const constraintPolicy = researchTrustPolicyService.buildConstraintPolicy(
          rawOptions.constraint_policy_json || existing.constraint_policy_json || {}
        );
        await existing.update({
          task_id: task.id,
          status: 'running',
          data_policy_json: dataPolicy,
          constraint_policy_json: constraintPolicy,
        } as any);
        await task.update({
          experiment_id: existing.id,
          data_policy_json: dataPolicy,
          constraint_policy_json: constraintPolicy,
        } as any);
        return existing;
      }
    }

    const experiment = await this.createExperiment(
      {
        ...rawOptions,
        task_id: task.id,
        status: 'running',
        strategy_key: rawOptions.strategy_keys?.[0],
        params_json: rawOptions.params_by_strategy || {},
        cost_policy_json: {
          initial_capital: rawOptions.initial_capital,
          commission_rate: rawOptions.commission_rate,
          slippage_rate: rawOptions.slippage_rate,
          min_commission: rawOptions.min_commission,
          stamp_tax_rate: rawOptions.stamp_tax_rate,
        },
      },
      user_id
    );
    await task.update({
      experiment_id: experiment.id,
      data_policy_json: experiment.data_policy_json || {},
      constraint_policy_json: experiment.constraint_policy_json || {},
    } as any);
    return experiment;
  }

  private async replaceArtifact(
    experiment_id: number,
    task_id: number | null,
    draft: ResearchArtifactDraft,
    options: { transaction?: any } = {}
  ) {
    const artifact_type = draft.artifact_type || 'credibility_summary';
    await QuantResearchArtifact.destroy({
      where: {
        experiment_id,
        task_id,
        artifact_type,
      },
      transaction: options.transaction,
    });
    return QuantResearchArtifact.create({
      experiment_id,
      task_id,
      artifact_type,
      source_type: draft.source_type || null,
      source_id: draft.source_id || null,
      status: draft.status,
      title: draft.title || artifact_type,
      summary: draft.summary,
      payload_json: draft.payload_json || {},
    } as any, { transaction: options.transaction });
  }

  private async ensureTrustedRerunTask(
    task: QuantBacktestTask,
    experiment: QuantResearchExperiment,
    artifact: ResearchArtifactDraft
  ): Promise<ResearchArtifactDraft> {
    if (researchTrustPolicyService.isTrustedRerunTask(rawOptionsFromTask(task))) {
      return artifact;
    }

    const queued = await sequelize.transaction(async transaction => {
      const lockedExperiment =
        (await QuantResearchExperiment.findByPk(experiment.id, {
          transaction,
          lock: (transaction as any).LOCK.UPDATE,
        } as any)) || experiment;
      const summary = lockedExperiment.summary_json || {};
      const existingTaskId = Number(
        summary.trusted_rerun_task_id || artifact.payload_json?.trusted_rerun_task_id || 0
      );
      if (existingTaskId > 0) {
        const existing = await QuantBacktestTask.findByPk(existingTaskId, { transaction });
        return { existing, existingTaskId, summary, created: false as const };
      }

      const rerunOptions = researchTrustPolicyService.buildTrustedRerunOptions({
        source_task_id: task.id,
        experiment_id: experiment.id,
        task_name: task.task_name,
        universe: task.universe,
        strategy_keys: task.strategy_keys || [],
        symbols: task.symbols || [],
        start_date: task.start_date,
        end_date: task.end_date,
        initial_capital: Number(task.initial_capital || 0),
        commission_rate: Number(task.commission_rate || 0),
        slippage_rate: Number(task.slippage_rate || 0),
        parameters: rawOptionsFromTask(task),
      });
      const rerunTask = await QuantBacktestTask.create(
        {
          user_id: task.user_id || null,
          experiment_id: experiment.id,
          task_name: rerunOptions.task_name,
          universe: rerunOptions.universe || 'market',
          strategy_keys: rerunOptions.strategy_keys || [],
          symbols: rerunOptions.symbols || [],
          start_date: rerunOptions.start_date,
          end_date: rerunOptions.end_date,
          initial_capital: rerunOptions.initial_capital || task.initial_capital || 200000,
          commission_rate: rerunOptions.commission_rate ?? task.commission_rate ?? 0.0003,
          slippage_rate: rerunOptions.slippage_rate ?? task.slippage_rate ?? 0.0005,
          status: 'QUEUED',
          progress: 0,
          parameters: rerunOptions,
          data_policy_json: rerunOptions.data_policy_json || {},
          constraint_policy_json: rerunOptions.constraint_policy_json || {},
        } as any,
        { transaction }
      );
      await lockedExperiment.update(
        {
          summary_json: {
            ...summary,
            trusted_rerun_task_id: rerunTask.id,
            trusted_rerun_source_task_id: task.id,
            trusted_rerun_status: 'QUEUED',
          },
        } as any,
        { transaction }
      );
      return { rerunTask, rerunOptions, summary, created: true as const };
    });

    if (!queued.created) {
      const existingTaskId = queued.existingTaskId;
      const existing = queued.existing;
      return {
        ...artifact,
        status: existing?.status === 'COMPLETED' ? artifact.status : 'pending',
        summary:
          existing?.status === 'COMPLETED'
            ? artifact.summary
            : `可信重跑任务 #${existingTaskId} 已创建，等待队列完成后更新审计后收益。`,
        payload_json: {
          ...(artifact.payload_json || {}),
          trusted_rerun_task_id: existingTaskId,
          trusted_rerun_status: existing?.status || 'QUEUED',
          replay_method:
            existing?.status === 'COMPLETED'
              ? artifact.payload_json?.replay_method
              : 'trusted_backtest_task_queued',
        },
      };
    }

    const { rerunTask, rerunOptions } = queued;
    const job = await quantBacktestQueue.add(
      { task_id: rerunTask.id, user_id: task.user_id, options: rerunOptions },
      {
        jobId: `quant-backtest-trusted-rerun-${task.id}-${rerunTask.id}`,
        delay: 0,
      }
    );
    const nextSummary = {
      ...((experiment.summary_json || {}) as Record<string, any>),
      ...(queued.summary || {}),
      trusted_rerun_task_id: rerunTask.id,
      trusted_rerun_source_task_id: task.id,
      trusted_rerun_status: 'QUEUED',
      trusted_rerun_queue_job_id: job.id,
    };
    await experiment.update({ summary_json: nextSummary } as any);
    return {
      ...artifact,
      status: 'pending',
      summary: `可信重跑任务 #${rerunTask.id} 已自动创建，完成后会用真实重跑结果更新审计后收益。`,
      payload_json: {
        ...(artifact.payload_json || {}),
        trusted_rerun_task_id: rerunTask.id,
        trusted_rerun_status: 'QUEUED',
        trusted_rerun_queue_job_id: job.id,
        replay_method: 'trusted_backtest_task_queued',
      },
    };
  }

  private async refreshCredibilitySummary(
    experiment: QuantResearchExperiment,
    task_id: number,
    task_status?: string | null,
    options: { transaction?: any } = {}
  ): Promise<ResearchAuditPayload> {
    const artifactRows = await QuantResearchArtifact.findAll({
      where: { experiment_id: experiment.id, task_id },
      order: [['created_at', 'ASC']],
      transaction: options.transaction,
    } as any);
    const artifacts = artifactRows.map(row => asPlain(row));
    const credibility = buildCredibilitySummary({
      backtest_artifact: artifactByType(artifacts, 'backtest'),
      integrity_artifact: artifactByType(artifacts, 'integrity_audit'),
      point_in_time_artifact: artifactByType(artifacts, 'point_in_time_audit'),
      execution_artifact: artifactByType(artifacts, 'execution_audit'),
      audited_return_artifact: artifactByType(artifacts, 'audited_return_replay'),
    });
    const credibilityArtifact = await this.replaceArtifact(
      experiment.id,
      task_id,
      {
        artifact_type: 'credibility_summary',
        source_type: 'quant_research_experiment',
        source_id: experiment.id,
        status: credibilityToArtifactStatus(credibility),
        title: credibility.title,
        summary: credibility.summary,
        payload_json: credibility,
      },
      options
    );
    const currentSummary = experiment.summary_json || {};
    await experiment.update(
      {
        status: task_status === 'COMPLETED' ? 'completed' : experiment.status || 'running',
        verdict: credibility.verdict,
        summary_json: {
          ...currentSummary,
          credibility_verdict: credibility,
          updated_at: new Date().toISOString(),
        },
      } as any,
      { transaction: options.transaction }
    );
    return buildResearchAuditPayload(
      experiment,
      [
        ...artifacts.filter(item => item.artifact_type !== 'credibility_summary'),
        asPlain(credibilityArtifact),
      ],
      credibility
    );
  }

  private async syncTrustedRerunBackToOriginal(
    task: QuantBacktestTask,
    bestResult: QuantBacktestResult | null,
    pointInTimeArtifact: ResearchArtifactDraft,
    executionArtifact: ResearchArtifactDraft
  ) {
    const raw = rawOptionsFromTask(task);
    const source_task_id = Number(raw.trusted_rerun_of_task_id || 0);
    if (!source_task_id || !task.experiment_id) return;
    const rerunPayload = bestResultToPayload(bestResult);
    const executableReturn = Number(rerunPayload?.total_return_pct ?? 0);
    const executableAnnualReturn = Number(rerunPayload?.annual_return_pct ?? executableReturn);
    const executableDrawdown = Math.abs(Number(rerunPayload?.max_drawdown_pct ?? 0));
    const status: QuantResearchArtifactStatus = !bestResult
      ? 'insufficient'
      : pointInTimeArtifact.status === 'reject' || executionArtifact.status === 'reject'
      ? 'watch'
      : 'pass';
    await sequelize.transaction(async transaction => {
      const lockedExperiment =
        (await QuantResearchExperiment.findByPk(task.experiment_id, {
          transaction,
          lock: (transaction as any).LOCK.UPDATE,
        } as any)) || null;
      if (!lockedExperiment) return;
      const originalTask = await QuantBacktestTask.findByPk(source_task_id, { transaction });
      const originalArtifact = await QuantResearchArtifact.findOne({
        where: {
          experiment_id: task.experiment_id,
          task_id: source_task_id,
          artifact_type: 'audited_return_replay',
        },
        order: [['created_at', 'DESC']],
        transaction,
      } as any);
      const originalPayload = originalArtifact?.payload_json || {};
      await this.replaceArtifact(
        Number(task.experiment_id),
        source_task_id,
        {
          artifact_type: 'audited_return_replay',
          source_type: 'trusted_backtest_task_actual',
          source_id: bestResult?.id || task.id,
          status,
          title: '审计后收益重跑',
          summary: bestResult
            ? `可信重跑任务 #${task.id} 已完成，可成交收益 ${executableReturn.toFixed(2)}%。`
            : `可信重跑任务 #${task.id} 未生成有效结果。`,
          payload_json: {
            ...originalPayload,
            source_task_id,
            trusted_rerun_task_id: task.id,
            trusted_rerun_result_id: bestResult?.id || null,
            trusted_rerun_status: task.status,
            trusted_rerun_result: rerunPayload,
            audited_return_pct: executableReturn,
            executable_return_pct: executableReturn,
            audited_annual_return_pct: executableAnnualReturn,
            executable_annual_return_pct: executableAnnualReturn,
            executable_max_drawdown_pct: executableDrawdown,
            replay_method: 'trusted_backtest_task_actual',
            point_in_time_status: pointInTimeArtifact.status,
            execution_status: executionArtifact.status,
          },
        },
        { transaction }
      );
      if (originalTask) {
        await this.refreshCredibilitySummary(lockedExperiment, source_task_id, originalTask.status, {
          transaction,
        });
      }
    });
  }

  private async findExperimentForTask(task: QuantBacktestTask, preferred_experiment_id?: number) {
    if (preferred_experiment_id) {
      const preferred = await QuantResearchExperiment.findByPk(preferred_experiment_id);
      if (preferred && Number(preferred.task_id) === Number(task.id)) return preferred;
    }
    if (task.experiment_id) {
      const byId = await QuantResearchExperiment.findByPk(task.experiment_id);
      if (byId) return byId;
    }
    return QuantResearchExperiment.findOne({ where: { task_id: task.id } });
  }

  async runAuditForBacktest(
    task_id: number,
    preferred_experiment_id?: number,
    user_id?: number
  ): Promise<ResearchAuditPayload | null> {
    const task = await QuantBacktestTask.findByPk(task_id);
    if (!task) return null;
    if (!sameOwner(task.user_id, user_id)) return null;
    const experiment = await this.findExperimentForTask(task, preferred_experiment_id);
    if (!experiment) return null;
    if (!sameOwner(experiment.user_id, user_id)) return null;

    const results = await QuantBacktestResult.findAll({
      where: { task_id },
      order: [['total_return_pct', 'DESC']],
    });
    const bestResult = results[0] || null;
    const backtestArtifact = buildBacktestArtifact(task, bestResult);

    let integrityArtifact: ResearchArtifactDraft;
    if (!bestResult) {
      integrityArtifact = {
        artifact_type: 'integrity_audit',
        source_type: 'research_integrity_audit',
        source_id: null,
        status: 'insufficient',
        title: '未来数据检查',
        summary: '缺少可审计的回测结果，无法判断是否使用未来数据。',
        payload_json: {},
      };
    } else {
      try {
        const integrityReport = await this.integrityService.auditBacktest(
          {
            backtest_id: bestResult.id,
            source: 'quant_backtest_result',
            strategy_key: bestResult.strategy_key,
            scan_strategy_code: true,
          },
          { persist: true }
        );
        integrityArtifact = mapResearchIntegrityArtifact(integrityReport);
      } catch (error: any) {
        logger.warn(`[research-experiment] integrity audit failed: ${error?.message || error}`);
        integrityArtifact = {
          artifact_type: 'integrity_audit',
          source_type: 'research_integrity_audit',
          source_id: null,
          status: 'error',
          title: '未来数据检查',
          summary: error?.message || '未来数据检查执行失败。',
          payload_json: { error: error?.message || String(error) },
        };
      }
    }

    const pointInTimeArtifact = buildPointInTimeArtifact({
      data_policy_json: task.data_policy_json || rawOptionsFromTask(task)?.data_policy_json || {},
      constraint_policy_json:
        task.constraint_policy_json || rawOptionsFromTask(task)?.constraint_policy_json || {},
    });

    const rejectedOrders = results.flatMap(result =>
      Array.isArray(result.rejected_orders_json) ? result.rejected_orders_json : []
    );
    const executionArtifact = buildExecutionArtifactFromRejectedOrders(
      rejectedOrders,
      aggregateExecutionDiagnostics(results)
    );

    let auditedReturnArtifact: ResearchArtifactDraft = buildAuditedReturnReplayArtifact({
      best_result: bestResult ? asPlain(bestResult) : null,
      point_in_time_artifact: pointInTimeArtifact,
      execution_artifact: executionArtifact,
    });
    if (researchTrustPolicyService.isTrustedRerunTask(rawOptionsFromTask(task))) {
      await this.syncTrustedRerunBackToOriginal(
        task,
        bestResult,
        pointInTimeArtifact,
        executionArtifact
      );
    } else {
      auditedReturnArtifact = await this.ensureTrustedRerunTask(
        task,
        experiment,
        auditedReturnArtifact
      );
    }

    return sequelize.transaction(async transaction => {
      const lockedExperiment =
        (await QuantResearchExperiment.findByPk(experiment.id, {
          transaction,
          lock: (transaction as any).LOCK.UPDATE,
        } as any)) || experiment;
      for (const draft of [
        backtestArtifact,
        integrityArtifact,
        pointInTimeArtifact,
        executionArtifact,
        auditedReturnArtifact,
      ]) {
        await this.replaceArtifact(lockedExperiment.id, task.id, draft, { transaction });
      }
      return this.refreshCredibilitySummary(lockedExperiment, task.id, task.status, { transaction });
    });
  }

  async getBacktestResearchAudit(
    task_id: number,
    user_id?: number,
    preloadedTask?: QuantBacktestTask | null
  ): Promise<ResearchAuditPayload | null> {
    const task = preloadedTask || (await QuantBacktestTask.findByPk(task_id));
    if (!task) return null;
    if (!sameOwner(task.user_id, user_id)) return null;
    const experiment = await this.findExperimentForTask(task);
    if (!experiment) return null;
    if (!sameOwner(experiment.user_id, user_id)) return null;
    const artifactRows = await QuantResearchArtifact.findAll({
      where: { experiment_id: experiment.id, task_id: task.id },
      order: [['created_at', 'ASC']],
    });
    const artifacts = artifactRows.map(row => asPlain(row));
    const storedSummary = (experiment.summary_json || {}).credibility_verdict;
    return buildResearchAuditPayload(experiment, artifacts, storedSummary);
  }

  async getBacktestExecutionConstraintAudit(
    task_id: number,
    user_id?: number
  ): Promise<ExecutionConstraintAuditPayload | null> {
    const task = await QuantBacktestTask.findByPk(task_id);
    if (!task) return null;
    if (!sameOwner(task.user_id, user_id)) return null;
    const experiment = await this.findExperimentForTask(task);
    if (experiment && !sameOwner(experiment.user_id, user_id)) return null;
    let artifact: any | null = null;
    if (experiment) {
      artifact = await QuantResearchArtifact.findOne({
        where: { experiment_id: experiment.id, task_id: task.id, artifact_type: 'execution_audit' },
        order: [['created_at', 'DESC']],
      });
    }

    if (!artifact) {
      const results = await QuantBacktestResult.findAll({
        where: { task_id },
        order: [['total_return_pct', 'DESC']],
      });
      const rejectedOrders = results.flatMap(result =>
        Array.isArray(result.rejected_orders_json) ? result.rejected_orders_json : []
      );
      artifact = buildExecutionArtifactFromRejectedOrders(
        rejectedOrders,
        aggregateExecutionDiagnostics(results)
      );
    } else {
      artifact = asPlain(artifact);
    }

    const payload = artifact.payload_json || {};
    return {
      task_id,
      experiment: experiment ? asPlain(experiment) : null,
      artifact,
      status: artifact.status,
      title: artifact.title || 'A股成交约束',
      summary: artifact.summary || '',
      rejected_order_count: Number(payload.rejected_order_count || 0),
      rejected_orders: Array.isArray(payload.rejected_orders) ? payload.rejected_orders : [],
      reason_counts: payload.reason_counts || {},
      grouped_reasons: payload.grouped_reasons || [],
      diagnostics: {
        buy_fill_count: Number(payload.buy_fill_count || 0),
        sell_fill_count: Number(payload.sell_fill_count || 0),
      },
    };
  }

  async listExperiments(options: { user_id?: number; limit?: number } = {}) {
    const where: any = {};
    if (options.user_id) where.user_id = options.user_id;
    const rows = await QuantResearchExperiment.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(Number(options.limit || 50), 1), 200),
    });
    return rows.map(row => asPlain(row));
  }

  async getExperiment(id: number, user_id?: number) {
    const where: any = { id };
    if (user_id) where.user_id = user_id;
    const experiment = await QuantResearchExperiment.findOne({ where });
    if (!experiment) return null;
    const artifacts = await QuantResearchArtifact.findAll({
      where: { experiment_id: experiment.id },
      order: [['created_at', 'ASC']],
    });
    return {
      ...asPlain(experiment),
      artifacts: artifacts.map(row => asPlain(row)),
    };
  }

  async runAuditForExperiment(id: number, user_id?: number) {
    const experiment = await this.getExperiment(id, user_id);
    if (!experiment?.task_id) return null;
    return this.runAuditForBacktest(Number(experiment.task_id), id, user_id);
  }
}

export const researchExperimentService = new ResearchExperimentService();
