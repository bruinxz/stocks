import type { DetailSection } from '@/shared/components/DetailSidebar';
import type { CandidateListEntry } from '../../../types';
import { RelevanceBreakdownCard } from './RelevanceBreakdownCard';
import { AIRecommendationCard } from './AIRecommendationCard';
import { ScoreBreakdownCard } from './ScoreBreakdownCard';
import { RiskGateDetailCard } from './RiskGateDetailCard';
import { ConvictionBreakdownCard } from './ConvictionBreakdownCard';
import { DataSourceBadge } from './DataSourceBadge';

export function buildMorningSections(row: CandidateListEntry): DetailSection[] {
  return [
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
          dimensions={row.score?.dims?.map((d) => ({ label: d.key, band: d.band }))}
          totalBand={row.score?.band}
        />
      ),
    },
    {
      key: 'risk',
      title: '风控门控',
      ariaLabel: 'Risk gate details',
      content: (
        <RiskGateDetailCard
          triggers={row.risk_gate?.triggers.map((t) => ({
            id: t.code,
            label: t.code,
            severity: t.severity === 'high' ? 'high' : t.severity === 'medium' ? 'medium' : 'low',
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
          adjustments={row.conviction?.adjustments?.map((a) => ({ label: a.reason, delta: a.delta }))}
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
}
