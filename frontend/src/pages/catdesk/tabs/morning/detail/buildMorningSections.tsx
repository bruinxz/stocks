import type { DetailSection } from '@/shared/components/DetailSidebar';
import type { CandidateListEntry } from '../../../types';
import { RelevanceBreakdownCard } from './RelevanceBreakdownCard';
import { AIRecommendationCard } from './AIRecommendationCard';
import { ScoreBreakdownCard } from './ScoreBreakdownCard';
import { RiskGateDetailCard } from './RiskGateDetailCard';
import { ConvictionBreakdownCard } from './ConvictionBreakdownCard';
import { DataSourceBadge } from './DataSourceBadge';

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
          dimensions={row.score?.dims?.map(d => ({ label: d.key, band: d.band }))}
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
          triggers={row.risk_gate?.triggers.map(t => ({
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
      content: (
        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 13 }}
        >
          {ep.price_band && (
            <div>
              <div style={{ color: 'var(--cd-text-secondary)', fontSize: 11 }}>价格区间</div>
              <div style={{ fontFamily: 'var(--cd-font-mono)' }}>
                {ep.price_band.low.toFixed(2)}-{ep.price_band.high.toFixed(2)}{' '}
                {ep.price_band.currency}
              </div>
            </div>
          )}
          {ep.stop != null && (
            <div>
              <div style={{ color: 'var(--cd-text-secondary)', fontSize: 11 }}>止损</div>
              <div style={{ fontFamily: 'var(--cd-font-mono)', color: 'var(--cd-down)' }}>
                {ep.stop.toFixed(2)}
              </div>
            </div>
          )}
          <div>
            <div style={{ color: 'var(--cd-text-secondary)', fontSize: 11 }}>时间窗口</div>
            <div>{ep.time_horizon}</div>
          </div>
          {ep.size_hint && (
            <div>
              <div style={{ color: 'var(--cd-text-secondary)', fontSize: 11 }}>仓位建议</div>
              <div style={{ fontFamily: 'var(--cd-font-mono)' }}>
                {ep.size_hint.tier} ≤{ep.size_hint.pct}%
              </div>
            </div>
          )}
          {ep.invalidation && (
            <div style={{ gridColumn: '1 / -1' }}>
              <div style={{ color: 'var(--cd-text-secondary)', fontSize: 11 }}>失效条件</div>
              <div>{ep.invalidation}</div>
            </div>
          )}
        </div>
      ),
    });
  }

  return sections;
}
