import { QuantResearchArtifactStatus } from '../../models/QuantResearchArtifact';

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

export class ResearchExperimentService {}

export const researchExperimentService = new ResearchExperimentService();
