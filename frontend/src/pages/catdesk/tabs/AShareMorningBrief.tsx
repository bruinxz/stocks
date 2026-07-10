import { useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAbortableRequest } from '@/shared/hooks/useAbortableRequest';
import { LoadingState } from '../shared/LoadingState';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import { DisclaimerFooter } from '../shared/DisclaimerFooter';
import { MorningBriefTable } from './morning/MorningBriefTable';
import { MorningFilterBar } from './morning/MorningFilterBar';
import { MorningKpiSlots } from './morning/MorningKpiSlots';
import { buildMorningSections } from './morning/detail/buildMorningSections';
import { DetailSidebar, type DetailSection } from '@/shared/components/DetailSidebar';
import type { CandidateListEntry, CatalystKind } from '../types';
import { CONVICTION_MED_MIN } from '../types';

interface MorningFilters {
  sector: string | null;
  catalystKind: CatalystKind | null;
  convictionMinMed: boolean;
}

interface MorningBriefResponse {
  kpi: { activity: number; overnight_sentiment: number; futures: number; breakout_prob: number };
  candidates: CandidateListEntry[];
  disclaimer_version: string;
}

const DEFAULT_FILTERS: MorningFilters = {
  sector: null,
  catalystKind: null,
  convictionMinMed: false,
};

function todayISO(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function extractSectors(rows: CandidateListEntry[]): string[] {
  const set = new Set<string>();
  rows.forEach((r) => {
    const cat = r.latest_catalyst as { kind: CatalystKind; title: string; occurred_at: string; sector?: string } | undefined;
    if (cat?.sector) set.add(cat.sector);
  });
  return Array.from(set).sort();
}

export default function AShareMorningBrief() {
  const [sp] = useSearchParams();
  const dateParam = sp.get('date') ?? todayISO();
  const [filters, setFilters] = useState<MorningFilters>(DEFAULT_FILTERS);
  const [selectedRow, setSelectedRow] = useState<CandidateListEntry | null>(null);

  const { data, loading, error } = useAbortableRequest<MorningBriefResponse>(
    `/api/v1/morning-brief/${dateParam}`,
    [dateParam],
  );

  const filtered = useMemo(() => {
    if (!data?.candidates) return [];
    let rows = data.candidates;
    if (filters.sector) {
      const sec = filters.sector;
      rows = rows.filter((r) => {
        const cat = r.latest_catalyst as { sector?: string } | undefined;
        return cat?.sector === sec;
      });
    }
    if (filters.catalystKind) {
      rows = rows.filter((r) => r.latest_catalyst?.kind === filters.catalystKind);
    }
    if (filters.convictionMinMed) {
      rows = rows.filter((r) => (r.conviction?.final ?? 0) >= CONVICTION_MED_MIN);
    }
    return rows;
  }, [data?.candidates, filters]);

  const sectors = useMemo(() => extractSectors(data?.candidates ?? []), [data?.candidates]);

  const handleRowSelect = useCallback((row: CandidateListEntry) => {
    setSelectedRow((prev) => (prev?.symbol === row.symbol ? null : row));
  }, []);

  const detailSections = useMemo(
    () => (selectedRow ? buildMorningSections(selectedRow) : []),
    [selectedRow],
  );

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : '数据加载失败'} />;
  if (!data?.candidates?.length) return <EmptyState title="今日暂无 A 股早报数据" variant="simple" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <MorningKpiSlots
        total={filtered.length}
        highConviction={filtered.filter((r) => (r.conviction?.final ?? 0) >= 75).length}
        avgScore={
          filtered.length > 0
            ? filtered.reduce((s, r) => s + (r.score?.score ?? 0), 0) / filtered.length
            : 0
        }
        updatedAt={dateParam}
      />
      <MorningFilterBar
        sector={filters.sector}
        catalystKind={filters.catalystKind}
        convictionMin={filters.convictionMinMed ? 'med' : 'all'}
        onSectorChange={(v) => setFilters((f) => ({ ...f, sector: v }))}
        onCatalystKindChange={(v) => setFilters((f) => ({ ...f, catalystKind: v as CatalystKind | null }))}
        onConvictionChange={(v) => setFilters((f) => ({ ...f, convictionMinMed: v === 'med' || v === 'high' }))}
        sectors={sectors}
      />
      <MorningBriefTable
        data={filtered}
        loading={false}
        onRowClick={(r) => handleRowSelect(r)}
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
