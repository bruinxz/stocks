import { useState, useMemo, useCallback } from 'react';
import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import { LoadingState } from '../shared/LoadingState';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import { UnavailableState } from '../shared/UnavailableState';
import { DisclaimerFooter } from '../shared/DisclaimerFooter';
import { USTable } from './us/USTable';
import { USFilterBar } from './us/USFilterBar';
import { USKpiSlots } from './us/USKpiSlots';
import { buildUSSections } from './us/detail/buildUSSections';
import { DetailSidebar } from 'shared/components/DetailSidebar';
import type { CandidateListEntry } from './c1Types';
import { DataListToolbar } from '../shared/DataListToolbar';
import {
  loadRecommendationCandidateFeed,
  type RecommendationCandidateLoadResult,
} from './recommendationCandidates';

interface USFilters {
  ratingMin: string | null;
}

export default function USStockPicks() {
  const [filters, setFilters] = useState<USFilters>({ ratingMin: null });
  const [selectedRow, setSelectedRow] = useState<CandidateListEntry | null>(null);
  const [search, setSearch] = useState('');

  const {
    data: loadResult,
    loading,
    error,
  } = useAbortableRequest<RecommendationCandidateLoadResult>(
    signal => loadRecommendationCandidateFeed(signal, 'us_preferred', 'us'),
    []
  );
  const data = loadResult?.kind === 'ready' ? loadResult.feed : null;

  const filtered = useMemo(() => {
    if (!data?.candidates) return [];
    let rows = data.candidates;
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    if (keyword) {
      rows = rows.filter(row =>
        [row.symbol, row.name, row.latest_catalyst?.title]
          .filter(Boolean)
          .some(value => String(value).toLocaleLowerCase('zh-CN').includes(keyword))
      );
    }
    if (filters.ratingMin) {
      const minOrder: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };
      const threshold = minOrder[filters.ratingMin] ?? 4;
      rows = rows.filter(r => (minOrder[r.rating_band ?? 'F'] ?? 4) <= threshold);
    }
    return rows;
  }, [data?.candidates, filters, search]);

  const handleRowSelect = useCallback((row: CandidateListEntry) => {
    setSelectedRow(prev => (prev?.symbol === row.symbol ? null : row));
  }, []);

  const detailSections = useMemo(
    () => (selectedRow ? buildUSSections(selectedRow) : []),
    [selectedRow]
  );

  if (loading)
    return (
      <LoadingState
        title="正在扫描美股线索"
        description="同步隔夜催化、评分与入场区间…"
        mood="curious"
      />
    );
  if (error) return <ErrorState message="数据加载失败" />;
  if (loadResult?.kind === 'not_generated')
    return <EmptyState title="当前尚未生成美股推荐快照" variant="simple" />;
  if (loadResult?.kind === 'unavailable')
    return <UnavailableState message="推荐服务当前不可用，请稍后重试" />;
  if (!data?.candidates?.length)
    return <EmptyState title="当前尚未生成美股推荐快照" variant="simple" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <USKpiSlots
        total={filtered.length}
        strongBuy={data.kpi.high_conviction}
        avgScore={data.kpi.avg_score}
        updatedAt={data.kpi.updated_at}
      />
      <USFilterBar
        ratingMin={filters.ratingMin}
        onRatingChange={v => setFilters(f => ({ ...f, ratingMin: v }))}
      />
      <DataListToolbar
        value={search}
        onChange={setSearch}
        total={filtered.length}
        label="条候选"
        placeholder="搜索美股代码、名称或催化线索"
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
