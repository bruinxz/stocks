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
  const sections: DetailSection[] = [
    {
      key: 'relevance',
      title: '相关性分解',
      ariaLabel: 'Relevance breakdown',
      content: <RelevanceBreakdownCard />,
    },
    {
      key: 'ai',
      title: 'AI 推荐门控',
      ariaLabel: 'AI recommendation gates',
      content: <AIRecommendationCard />,
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
      content: <DataSourceBadge />,
    },
  ];

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
