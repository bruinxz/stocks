import type { DetailSection } from 'shared/components/DetailSidebar';
import { scoreBandDimensions, type CandidateListEntry } from '../../c1Types';
import { RelevanceBreakdownCard } from './RelevanceBreakdownCard';
import { AIRecommendationCard } from './AIRecommendationCard';
import { ScoreBreakdownCard } from './ScoreBreakdownCard';
import { RiskGateDetailCard } from './RiskGateDetailCard';
import { ConvictionBreakdownCard } from './ConvictionBreakdownCard';
import { DataSourceBadge } from './DataSourceBadge';
import { EntryPlanDetails } from './EntryPlanDetails';

export function buildMorningSections(row: CandidateListEntry): DetailSection[] {
  const relevance = row.catalyst_relevance?.components;
  const relevanceComponents = relevance
    ? [
        { label: '板块匹配', value: relevance.sector_map * 100, color: '#3b82f6' },
        {
          label: '营收敞口',
          value: relevance.revenue_exposure * 100,
          color: '#22c55e',
        },
        { label: '存托凭证平价', value: relevance.adr_parity * 100, color: '#f59e0b' },
        { label: '供应链', value: relevance.supply_chain * 100, color: '#8b5cf6' },
        {
          label: '历史贝塔',
          value: relevance.historical_beta * 100,
          color: '#ec4899',
        },
      ]
    : [];
  const recommendationGates = [
    {
      label: `触发信号：${row.trigger_signals?.length ?? 0}`,
      passed: (row.trigger_signals?.length ?? 0) > 0,
    },
    { label: '权重已归一化', passed: row.weights?.normalized === true },
    { label: '推荐解释可追溯', passed: Boolean(row.explanation?.body) },
    {
      label: `证据引用：${row.evidence_refs?.length ?? 0}`,
      passed: (row.evidence_refs?.length ?? 0) > 0,
    },
  ];
  const dualGate = row.risk_gate
    ? {
        label: `风险门禁 ${row.risk_gate.gate}`,
        status: (row.risk_gate.gate === 'GREEN'
          ? 'pass'
          : row.risk_gate.gate === 'YELLOW'
            ? 'warn'
            : 'fail') as 'pass' | 'warn' | 'fail',
      }
    : undefined;
  const sections: DetailSection[] = [
    {
      key: 'relevance',
      title: '相关性分解',
      ariaLabel: '相关性分解',
      content: <RelevanceBreakdownCard components={relevanceComponents} />,
    },
    {
      key: 'ai',
      title: '智能推荐门控',
      ariaLabel: '智能推荐门控',
      content: <AIRecommendationCard gates={recommendationGates} dualGate={dualGate} />,
    },
    {
      key: 'score',
      title: '评分分解',
      ariaLabel: '评分分解',
      content: (
        <ScoreBreakdownCard
          scoringId={row.score?.scoring_id}
          snapshotHash={row.score?.snapshot_hash}
          dimensions={scoreBandDimensions(row.score)}
          totalBand={row.score?.rating}
        />
      ),
    },
    {
      key: 'risk',
      title: '风控门控',
      ariaLabel: '风险门禁详情',
      content: (
        <RiskGateDetailCard
          gate={row.risk_gate?.gate}
          okToEnter={row.risk_gate?.ok_to_enter}
          triggers={row.risk_gate?.triggers.map(t => ({
            id: t.code,
            label: t.code,
            severity: t.severity,
            detail: t.detail,
          }))}
        />
      ),
      collapsible: true,
    },
    {
      key: 'conviction',
      title: '确信度分解',
      ariaLabel: '确信度分解',
      content: (
        <ConvictionBreakdownCard
          base={row.conviction?.base}
          adjustments={row.conviction?.adjustments?.map(a => ({ label: a.reason, delta: a.delta }))}
          final={row.conviction?.final}
        />
      ),
    },
    {
      key: 'datasource',
      title: '数据来源',
      ariaLabel: '数据来源',
      content: <DataSourceBadge sources={row.data_sources ?? []} />,
    },
  ];

  if (row.explanation) {
    sections.splice(2, 0, {
      key: 'explanation',
      title: '推荐解释',
      ariaLabel: '推荐解释',
      content: (
        <div style={{ display: 'grid', gap: 8 }}>
          <strong>{row.explanation.headline}</strong>
          <span>{row.explanation.body}</span>
          {row.explanation.caveats.map(caveat => (
            <span key={caveat} style={{ color: 'var(--cd-text-secondary)' }}>
              风险：{caveat}
            </span>
          ))}
        </div>
      ),
    });
  }

  if (row.evidence_refs?.length) {
    sections.push({
      key: 'evidence',
      title: '证据引用',
      ariaLabel: '推荐证据引用',
      content: (
        <div style={{ display: 'grid', gap: 8 }}>
          {row.evidence_refs.map(evidence => (
            <div key={evidence.id} style={{ fontSize: 12 }}>
              <strong>{evidence.id}</strong> · {evidence.kind} · {evidence.as_of}
              <br />
              <span style={{ color: 'var(--cd-text-secondary)' }}>{evidence.source_uri}</span>
              {evidence.short_text ? <div>{evidence.short_text}</div> : null}
            </div>
          ))}
        </div>
      ),
      collapsible: true,
    });
  }

  if (row.provenance) {
    sections.push({
      key: 'provenance',
      title: '快照溯源',
      ariaLabel: '推荐快照溯源',
      content: (
        <div style={{ display: 'grid', gap: 4, fontFamily: 'monospace', fontSize: 11 }}>
          <span>快照编号：{row.provenance.snapshot_id}</span>
          <span>数据时点：{row.provenance.as_of}</span>
          <span>输入指纹：{row.provenance.input_fingerprint}</span>
          <span>输出指纹：{row.provenance.output_fingerprint}</span>
          <span>处理流程：{row.provenance.pipeline_version}</span>
        </div>
      ),
      collapsible: true,
    });
  }

  if (row.entry_plan) {
    const ep = row.entry_plan;
    sections.push({
      key: 'entry',
      title: '入场计划',
      ariaLabel: '入场方案',
      content: <EntryPlanDetails plan={ep} />,
    });
  }

  return sections;
}
