import { useState, useMemo, useCallback } from 'react';
import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import { LoadingState } from '../shared/LoadingState';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import { DisclaimerFooter } from '../shared/DisclaimerFooter';
import { USTable } from './us/USTable';
import { USFilterBar } from './us/USFilterBar';
import { USKpiSlots } from './us/USKpiSlots';
import { buildUSSections } from './us/detail/buildUSSections';
import { DetailSidebar } from 'shared/components/DetailSidebar';
import type { CandidateListEntry } from './c1Types';

interface USSelectResponse {
  kpi: { total: number; strong_buy: number; avg_score: number; updated_at: string };
  candidates: CandidateListEntry[];
}

interface USFilters {
  sector: string | null;
  ratingMin: string | null;
}

function todayISO(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

export default function USStockPicks() {
  const [filters, setFilters] = useState<USFilters>({ sector: null, ratingMin: null });
  const [selectedRow, setSelectedRow] = useState<CandidateListEntry | null>(null);

  const dateParam = todayISO();
  const { data, loading, error } = useAbortableRequest<USSelectResponse>(
    signal =>
      fetch(`/api/v1/us-select/${encodeURIComponent(dateParam)}`, { signal }).then(r => {
        if (!r.ok) throw new Error(`us-select ${r.status}`);
        return r.json();
      }),
    [dateParam]
  );

  const filtered = useMemo(() => {
    if (!data?.candidates) return [];
    let rows = data.candidates;
    if (filters.sector) {
      const sec = filters.sector;
      rows = rows.filter(r => {
        const cat = r.latest_catalyst as { kind: string; sector?: string } | undefined;
        return cat?.sector === sec;
      });
    }
    if (filters.ratingMin) {
      const minOrder: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };
      const threshold = minOrder[filters.ratingMin] ?? 4;
      rows = rows.filter(r => (minOrder[r.rating_band ?? 'F'] ?? 4) <= threshold);
    }
    return rows;
  }, [data?.candidates, filters]);

  const handleRowSelect = useCallback((row: CandidateListEntry) => {
    setSelectedRow(prev => (prev?.symbol === row.symbol ? null : row));
  }, []);

  const detailSections = useMemo(
    () => (selectedRow ? buildUSSections(selectedRow) : []),
    [selectedRow]
  );

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : '数据加载失败'} />;
  if (!data?.candidates?.length)
    return <EmptyState title="美股优选 · 数据接入中" variant="simple" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <USKpiSlots
        total={filtered.length}
        strongBuy={data.kpi.strong_buy}
        avgScore={data.kpi.avg_score}
        updatedAt={data.kpi.updated_at}
      />
      <USFilterBar
        sector={filters.sector}
        ratingMin={filters.ratingMin}
        onSectorChange={v => setFilters(f => ({ ...f, sector: v }))}
        onRatingChange={v => setFilters(f => ({ ...f, ratingMin: v }))}
      />
      <USTable
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
