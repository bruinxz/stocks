import type { DetailSection } from 'shared/components/DetailSidebar';
import { scoreBandDimensions, type CandidateListEntry } from '../../c1Types';
import { ScoreBreakdownCard } from '../../morning/detail/ScoreBreakdownCard';
import { RiskGateDetailCard } from '../../morning/detail/RiskGateDetailCard';
import { ConvictionBreakdownCard } from '../../morning/detail/ConvictionBreakdownCard';
import { EntryPlanDetails } from '../../morning/detail/EntryPlanDetails';
import { DataSourceBadge } from '../../morning/detail/DataSourceBadge';

export function buildUSSections(row: CandidateListEntry): DetailSection[] {
  const sections: DetailSection[] = [];

  sections.push({
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
  });

  if (row.conviction) {
    sections.push({
      key: 'conviction',
      title: '确信度分解',
      ariaLabel: '确信度分解',
      content: (
        <ConvictionBreakdownCard
          base={row.conviction.base}
          adjustments={row.conviction.adjustments?.map(a => ({ label: a.reason, delta: a.delta }))}
          final={row.conviction.final}
        />
      ),
    });
  }

  if (row.risk_gate) {
    sections.push({
      key: 'risk',
      title: '风控门控',
      ariaLabel: '风险门禁详情',
      content: (
        <RiskGateDetailCard
          gate={row.risk_gate.gate}
          okToEnter={row.risk_gate.ok_to_enter}
          triggers={row.risk_gate.triggers.map(t => ({
            id: t.code,
            label: t.code,
            severity: t.severity,
            detail: t.detail,
          }))}
        />
      ),
      collapsible: true,
    });
  }

  if (row.entry_plan) {
    const ep = row.entry_plan;
    sections.push({
      key: 'entry',
      title: '入场方案',
      ariaLabel: '入场方案',
      content: <EntryPlanDetails plan={ep} />,
      collapsible: true,
    });
  }

  if (row.explanation) {
    sections.push({
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

  sections.push({
    key: 'data_sources',
    title: '数据来源',
    ariaLabel: '推荐数据来源',
    content: <DataSourceBadge sources={row.data_sources ?? []} />,
  });

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

  return sections;
}
