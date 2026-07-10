import React, { useState, useMemo, useCallback } from 'react';
import { MorningBriefTable } from './morning/MorningBriefTable';
import { MorningFilterBar } from './morning/MorningFilterBar';
import { MorningKpiSlots } from './morning/MorningKpiSlots';
import { DisclaimerFooter } from '../shared/DisclaimerFooter';
import { EmptyState } from '../shared/EmptyState';

interface MorningFilters {
  sector: string | null;
  catalystKind: string | null;
  convictionMin: 'all' | 'med' | 'high';
}

const CONVICTION_THRESHOLDS = { all: 0, med: 50, high: 75 } as const;

export default function AShareMorningBrief() {
  const [filters, setFilters] = useState<MorningFilters>({
    sector: null,
    catalystKind: null,
    convictionMin: 'all',
  });

  const data: never[] = [];
  const loading = false;

  const filtered = useMemo(() => {
    let rows = data;
    if (filters.sector) {
      rows = rows.filter((r: any) => r.sector === filters.sector);
    }
    if (filters.catalystKind) {
      rows = rows.filter((r: any) => r.catalystKind === filters.catalystKind);
    }
    const minConv = CONVICTION_THRESHOLDS[filters.convictionMin];
    if (minConv > 0) {
      rows = rows.filter((r: any) => r.conviction >= minConv);
    }
    return rows;
  }, [data, filters]);

  const handleRowClick = useCallback((_symbol: string) => {
    // DetailSidebar selection — wired in Sprint 3
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <MorningKpiSlots total={filtered.length} />
      <MorningFilterBar
        sector={filters.sector}
        catalystKind={filters.catalystKind}
        convictionMin={filters.convictionMin}
        onSectorChange={(v) => setFilters((f) => ({ ...f, sector: v }))}
        onCatalystKindChange={(v) => setFilters((f) => ({ ...f, catalystKind: v }))}
        onConvictionChange={(v) => setFilters((f) => ({ ...f, convictionMin: v }))}
      />
      {filtered.length === 0 && !loading ? (
        <EmptyState title="A 股早报 · 数据接入中" variant="simple" />
      ) : (
        <MorningBriefTable data={filtered} loading={loading} onRowClick={handleRowClick} />
      )}
      <DisclaimerFooter disclaimerKey="size_hint_advisory" />
    </div>
  );
}
