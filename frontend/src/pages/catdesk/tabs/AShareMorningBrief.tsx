import { useState, useMemo, useCallback } from 'react';
import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import { LoadingState } from '../shared/LoadingState';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import { UnavailableState } from '../shared/UnavailableState';
import { DisclaimerFooter } from '../shared/DisclaimerFooter';
import { MorningBriefTable } from './morning/MorningBriefTable';
import { MorningFilterBar } from './morning/MorningFilterBar';
import { MorningKpiSlots } from './morning/MorningKpiSlots';
import { buildMorningSections } from './morning/detail/buildMorningSections';
import { DetailSidebar } from 'shared/components/DetailSidebar';
import type { CandidateListEntry, CatalystKind } from './c1Types';
import { CONVICTION_MED_MIN } from '../types';
import {
  loadRecommendationCandidateFeed,
  type RecommendationCandidateLoadResult,
} from './recommendationCandidates';

interface MorningFilters {
  sector: string | null;
  catalystKind: CatalystKind | null;
  convictionMinMed: boolean;
}

const DEFAULT_FILTERS: MorningFilters = {
  sector: null,
  catalystKind: null,
  convictionMinMed: false,
};

function extractSectors(rows: CandidateListEntry[]): string[] {
  const set = new Set<string>();
  rows.forEach(r => {
    const cat = r.latest_catalyst as
      | { kind: CatalystKind; title: string; occurred_at: string; sector?: string }
      | undefined;
    if (cat?.sector) set.add(cat.sector);
  });
  return Array.from(set).sort();
}

export default function AShareMorningBrief() {
  const [filters, setFilters] = useState<MorningFilters>(DEFAULT_FILTERS);
  const [selectedRow, setSelectedRow] = useState<CandidateListEntry | null>(null);

  const {
    data: loadResult,
    loading,
    error,
  } = useAbortableRequest<RecommendationCandidateLoadResult>(
    signal => loadRecommendationCandidateFeed(signal, 'us_preferred', 'cn_a'),
    []
  );
  const data = loadResult?.kind === 'ready' ? loadResult.feed : null;

  const filtered = useMemo(() => {
    if (!data?.candidates) return [];
    let rows = data.candidates;
    if (filters.sector) {
      const sec = filters.sector;
      rows = rows.filter(r => {
        const cat = r.latest_catalyst as { sector?: string } | undefined;
        return cat?.sector === sec;
      });
    }
    if (filters.catalystKind) {
      rows = rows.filter(r => r.latest_catalyst?.kind === filters.catalystKind);
    }
    if (filters.convictionMinMed) {
      rows = rows.filter(r => (r.conviction?.final ?? 0) >= CONVICTION_MED_MIN);
    }
    return rows;
  }, [data?.candidates, filters]);

  const sectors = useMemo(() => extractSectors(data?.candidates ?? []), [data?.candidates]);

  const handleRowSelect = useCallback((row: CandidateListEntry) => {
    setSelectedRow(prev => (prev?.symbol === row.symbol ? null : row));
  }, []);

  const detailSections = useMemo(
    () => (selectedRow ? buildMorningSections(selectedRow) : []),
    [selectedRow]
  );

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message="数据加载失败" />;
  if (loadResult?.kind === 'not_generated')
    return <EmptyState title="当前尚未生成 A 股推荐快照" variant="simple" />;
  if (loadResult?.kind === 'unavailable')
    return <UnavailableState message="推荐服务当前不可用，请稍后重试" />;
  if (!data?.candidates?.length)
    return <EmptyState title="当前尚未生成 A 股推荐快照" variant="simple" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <MorningKpiSlots
        total={filtered.length}
        highConviction={filtered.filter(r => (r.conviction?.final ?? 0) >= 75).length}
        avgScore={
          filtered.length > 0
            ? filtered.reduce((s, r) => s + (r.score?.total ?? 0), 0) / filtered.length
            : 0
        }
        updatedAt={data.kpi.updated_at}
      />
      <MorningFilterBar
        sector={filters.sector}
        catalystKind={filters.catalystKind}
        convictionMin={filters.convictionMinMed ? 'med' : 'all'}
        onSectorChange={v => setFilters(f => ({ ...f, sector: v }))}
        onCatalystKindChange={v =>
          setFilters(f => ({ ...f, catalystKind: v as CatalystKind | null }))
        }
        onConvictionChange={v =>
          setFilters(f => ({ ...f, convictionMinMed: v === 'med' || v === 'high' }))
        }
        sectors={sectors}
      />
      <MorningBriefTable
        data={filtered}
        loading={false}
        onRowClick={r => handleRowSelect(r)}
        selectedSymbol={selectedRow?.symbol ?? null}
      />
      <DisclaimerFooter disclaimerKey="size_hint_advisory" />
      <DetailSidebar
        open={selectedRow !== null}
        onClose={() => setSelectedRow(null)}
        title={selectedRow?.name ?? ''}
        subtitle={selectedRow?.symbol}
        ariaLabel="候选详情"
        sections={detailSections}
      />
    </div>
  );
}
