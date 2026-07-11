import type { DetailSection } from 'shared/components/DetailSidebar';
import { scoreBandDimensions, type CandidateListEntry } from '../../c1Types';
import { ScoreBreakdownCard } from '../../morning/detail/ScoreBreakdownCard';
import { RiskGateDetailCard } from '../../morning/detail/RiskGateDetailCard';
import { ConvictionBreakdownCard } from '../../morning/detail/ConvictionBreakdownCard';
import { EntryPlanDetails } from '../../morning/detail/EntryPlanDetails';

export function buildUSSections(row: CandidateListEntry): DetailSection[] {
  const sections: DetailSection[] = [];

  sections.push({
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
  });

  if (row.conviction) {
    sections.push({
      key: 'conviction',
      title: '确信度分解',
      ariaLabel: 'Conviction breakdown',
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
      ariaLabel: 'Risk gate details',
      content: (
        <RiskGateDetailCard
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
      ariaLabel: 'Entry plan',
      content: <EntryPlanDetails plan={ep} />,
      collapsible: true,
    });
  }

  return sections;
}
