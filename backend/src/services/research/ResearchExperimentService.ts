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
import { logger } from '../../utils/logger';

export type QuantResearchVerdict = 'pending' | 'pass' | 'watch' | 'reject' | 'insufficient';

export type ResearchArtifactDraft = {
  artifact_type?: 'backtest' | 'integrity_audit' | 'execution_audit' | 'credibility_summary';
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
  rejectedOrders: any[] = []
): ResearchArtifactDraft {
  const rows = Array.isArray(rejectedOrders) ? rejectedOrders : [];
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
  const hardReasons = ['limit_up', 'limit_down', 'suspended', 't_plus_1'];
  const hasHardBlock = Object.keys(reasonCounts).some(reason =>
    hardReasons.some(token => reason.includes(token))
  );
  const details = rows
    .map(item => String(item?.detail || item?.reason || '').trim())
    .filter(Boolean)
    .slice(0, 3);

  return {
    artifact_type: 'execution_audit',
    source_type: 'quant_backtest_rejected_orders',
    source_id: null,
    status: hasHardBlock ? 'reject' : 'watch',
    title: 'A股成交约束',
    summary: `发现 ${rows.length} 笔订单受 A 股成交规则影响${
      details.length ? `：${details.join('；')}` : '。'
    }`,
    payload_json: {
      rejected_order_count: rows.length,
      reason_counts: reasonCounts,
      rejected_orders: rows,
    },
  };
}

export function buildCredibilitySummary(input: {
  backtest_artifact?: Pick<ResearchArtifactDraft, 'status' | 'summary'> | null;
  integrity_artifact?: Pick<ResearchArtifactDraft, 'status' | 'summary'> | null;
  execution_artifact?: Pick<ResearchArtifactDraft, 'status' | 'summary'> | null;
}): CredibilitySummary {
  const artifacts = [
    input.backtest_artifact,
    input.integrity_artifact,
    input.execution_artifact,
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
      data_policy_json: input.data_policy_json || {},
      cost_policy_json: input.cost_policy_json || {},
      constraint_policy_json: input.constraint_policy_json || {},
      summary_json: {},
    } as any);
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
        await existing.update({ task_id: task.id, status: 'running' } as any);
        await task.update({
          experiment_id: existing.id,
          data_policy_json: rawOptions.data_policy_json || existing.data_policy_json || {},
          constraint_policy_json:
            rawOptions.constraint_policy_json || existing.constraint_policy_json || {},
        } as any);
        return existing;
      }
    }

    if (!rawOptions.easy_mode) return null;

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
      data_policy_json: rawOptions.data_policy_json || {},
      constraint_policy_json: rawOptions.constraint_policy_json || {},
    } as any);
    return experiment;
  }

  private async replaceArtifact(
    experiment_id: number,
    task_id: number | null,
    draft: ResearchArtifactDraft
  ) {
    const artifact_type = draft.artifact_type || 'credibility_summary';
    await QuantResearchArtifact.destroy({
      where: {
        experiment_id,
        task_id,
        artifact_type,
      },
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
    } as any);
  }

  private async findExperimentForTask(task: QuantBacktestTask) {
    if (task.experiment_id) {
      const byId = await QuantResearchExperiment.findByPk(task.experiment_id);
      if (byId) return byId;
    }
    return QuantResearchExperiment.findOne({ where: { task_id: task.id } });
  }

  async runAuditForBacktest(task_id: number): Promise<ResearchAuditPayload | null> {
    const task = await QuantBacktestTask.findByPk(task_id);
    if (!task) return null;
    const experiment = await this.findExperimentForTask(task);
    if (!experiment) return null;

    const results = await QuantBacktestResult.findAll({
      where: { task_id },
      order: [['total_return_pct', 'DESC']],
    });
    const bestResult = results[0] || null;
    const backtestArtifact = buildBacktestArtifact(task, bestResult);
    await this.replaceArtifact(experiment.id, task.id, backtestArtifact);

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
    await this.replaceArtifact(experiment.id, task.id, integrityArtifact);

    const rejectedOrders = results.flatMap(result =>
      Array.isArray(result.rejected_orders_json) ? result.rejected_orders_json : []
    );
    const executionArtifact = buildExecutionArtifactFromRejectedOrders(rejectedOrders);
    await this.replaceArtifact(experiment.id, task.id, executionArtifact);

    const credibility = buildCredibilitySummary({
      backtest_artifact: backtestArtifact,
      integrity_artifact: integrityArtifact,
      execution_artifact: executionArtifact,
    });
    await this.replaceArtifact(experiment.id, task.id, {
      artifact_type: 'credibility_summary',
      source_type: 'quant_research_experiment',
      source_id: experiment.id,
      status:
        credibility.verdict === 'pass' || credibility.verdict === 'watch'
          ? credibility.verdict
          : credibility.verdict === 'pending'
          ? 'pending'
          : credibility.verdict,
      title: credibility.title,
      summary: credibility.summary,
      payload_json: credibility,
    });

    await experiment.update({
      status: task.status === 'COMPLETED' ? 'completed' : 'running',
      verdict: credibility.verdict,
      summary_json: {
        credibility_verdict: credibility,
        updated_at: new Date().toISOString(),
      },
    } as any);

    return this.getBacktestResearchAudit(task.id);
  }

  async getBacktestResearchAudit(task_id: number): Promise<ResearchAuditPayload | null> {
    const task = await QuantBacktestTask.findByPk(task_id);
    if (!task) return null;
    const experiment = await this.findExperimentForTask(task);
    if (!experiment) return null;
    const artifactRows = await QuantResearchArtifact.findAll({
      where: { experiment_id: experiment.id, task_id: task.id },
      order: [['created_at', 'ASC']],
    });
    const artifacts = artifactRows.map(row => asPlain(row));
    const storedSummary = (experiment.summary_json || {}).credibility_verdict;
    const credibility_verdict =
      storedSummary ||
      buildCredibilitySummary({
        backtest_artifact: artifactByType(artifacts, 'backtest'),
        integrity_artifact: artifactByType(artifacts, 'integrity_audit'),
        execution_artifact: artifactByType(artifacts, 'execution_audit'),
      });
    return {
      experiment: asPlain(experiment),
      artifacts,
      credibility_verdict,
      can_create_observation: Boolean(credibility_verdict.can_create_observation),
      blocking_reasons: credibility_verdict.blocking_reasons || [],
      watch_reasons: credibility_verdict.watch_reasons || [],
      next_action_label: credibility_verdict.next_action_label || '回到查数据',
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
    return this.runAuditForBacktest(Number(experiment.task_id));
  }
}

export const researchExperimentService = new ResearchExperimentService();
