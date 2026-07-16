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
        { label: 'sector_map', value: relevance.sector_map * 100, color: '#3b82f6' },
        {
          label: 'revenue_exposure',
          value: relevance.revenue_exposure * 100,
          color: '#22c55e',
        },
        { label: 'adr_parity', value: relevance.adr_parity * 100, color: '#f59e0b' },
        { label: 'supply_chain', value: relevance.supply_chain * 100, color: '#8b5cf6' },
        {
          label: 'historical_beta',
          value: relevance.historical_beta * 100,
          color: '#ec4899',
        },
      ]
    : [];
  const recommendationGates = [
    {
      label: `trigger_signals = ${row.trigger_signals?.length ?? 0}`,
      passed: (row.trigger_signals?.length ?? 0) > 0,
    },
    { label: 'weights 已归一化', passed: row.weights?.normalized === true },
    { label: 'explanation 可追溯', passed: Boolean(row.explanation?.body) },
    {
      label: `evidence_refs = ${row.evidence_refs?.length ?? 0}`,
      passed: (row.evidence_refs?.length ?? 0) > 0,
    },
  ];
  const dualGate = row.risk_gate
    ? {
        label: `RiskGate ${row.risk_gate.gate}`,
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
      ariaLabel: 'Relevance breakdown',
      content: <RelevanceBreakdownCard components={relevanceComponents} />,
    },
    {
      key: 'ai',
      title: 'AI 推荐门控',
      ariaLabel: 'AI recommendation gates',
      content: <AIRecommendationCard gates={recommendationGates} dualGate={dualGate} />,
    },
    {
      key: 'score',
      title: '评分分解',
      ariaLabel: 'Score breakdown',
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
      ariaLabel: 'Risk gate details',
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
      ariaLabel: 'Conviction breakdown',
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
      ariaLabel: 'Data source badges',
      content: <DataSourceBadge sources={row.data_sources ?? []} />,
    },
  ];

  if (row.explanation) {
    sections.splice(2, 0, {
      key: 'explanation',
      title: '推荐解释',
      ariaLabel: 'Recommendation explanation',
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
      ariaLabel: 'Recommendation evidence references',
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
      ariaLabel: 'Recommendation snapshot provenance',
      content: (
        <div style={{ display: 'grid', gap: 4, fontFamily: 'monospace', fontSize: 11 }}>
          <span>snapshot_id: {row.provenance.snapshot_id}</span>
          <span>as_of: {row.provenance.as_of}</span>
          <span>input: {row.provenance.input_fingerprint}</span>
          <span>output: {row.provenance.output_fingerprint}</span>
          <span>pipeline: {row.provenance.pipeline_version}</span>
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
      ariaLabel: 'Entry plan',
      content: <EntryPlanDetails plan={ep} />,
    });
  }

  return sections;
}
