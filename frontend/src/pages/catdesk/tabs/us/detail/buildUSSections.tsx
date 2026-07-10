import type { DetailSection } from '@/shared/components/DetailSidebar';
import type { CandidateListEntry } from '../../../types';
import { ScoreBreakdownCard } from '../../morning/detail/ScoreBreakdownCard';
import { RiskGateDetailCard } from '../../morning/detail/RiskGateDetailCard';
import { ConvictionBreakdownCard } from '../../morning/detail/ConvictionBreakdownCard';

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
        dimensions={row.score?.dims?.map(d => ({ label: d.key, band: d.band }))}
        totalBand={row.score?.band}
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
            severity: t.severity === 'high' ? 'high' : t.severity === 'medium' ? 'medium' : 'low',
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
      content: (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <span style={{ color: 'var(--cd-text-secondary)', fontSize: 12 }}>价格区间</span>
            <div style={{ fontFamily: 'var(--cd-font-mono)' }}>
              {ep.price_band.low.toFixed(2)} – {ep.price_band.high.toFixed(2)}{' '}
              {ep.price_band.currency}
            </div>
          </div>
          <div>
            <span style={{ color: 'var(--cd-text-secondary)', fontSize: 12 }}>止损</span>
            <div style={{ fontFamily: 'var(--cd-font-mono)' }}>
              {ep.stop.toFixed(2)} {ep.price_band.currency}
            </div>
          </div>
          <div>
            <span style={{ color: 'var(--cd-text-secondary)', fontSize: 12 }}>时间维度</span>
            <div>{ep.time_horizon}</div>
          </div>
          <div>
            <span style={{ color: 'var(--cd-text-secondary)', fontSize: 12 }}>仓位建议</span>
            <div>
              {ep.size_hint.tier} ({ep.size_hint.pct}%)
            </div>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <span style={{ color: 'var(--cd-text-secondary)', fontSize: 12 }}>失效条件</span>
            <div>{ep.invalidation}</div>
          </div>
        </div>
      ),
      collapsible: true,
    });
  }

  return sections;
}
