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
import { DataListToolbar } from '../shared/DataListToolbar';
import { useStockNameHydrationState } from '../shared/useStockNameHydration';
import { CONVICTION_MED_MIN } from '../types';
import { matchesMorningCatalyst } from './morning/morningFilters';
import {
  loadRecommendationCandidateFeed,
  type RecommendationCandidateLoadResult,
} from './recommendationCandidates';
import { useResearchTradingLoop } from '../shared/useResearchTradingLoop';
import { ResearchLoopStatusStrip } from '../shared/ResearchLoopStatusStrip';

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
      { kind: CatalystKind; title: string; occurred_at: string; sector?: string } | undefined;
    if (cat?.sector) set.add(cat.sector);
  });
  return Array.from(set).sort();
}

export default function AShareMorningBrief() {
  const [filters, setFilters] = useState<MorningFilters>(DEFAULT_FILTERS);
  const [selectedRow, setSelectedRow] = useState<CandidateListEntry | null>(null);
  const [search, setSearch] = useState('');

  const {
    data: loadResult,
    loading,
    error,
  } = useAbortableRequest<RecommendationCandidateLoadResult>(
    signal => loadRecommendationCandidateFeed(signal, 'us_preferred', 'cn_a'),
    []
  );
  const data = loadResult?.kind === 'ready' ? loadResult.feed : null;
  const { data: loopDashboard } = useResearchTradingLoop();
  const { rows: namedCandidates, loading: namesLoading } = useStockNameHydrationState(
    data?.candidates ?? []
  );

  const filtered = useMemo(() => {
    let rows = namedCandidates;
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    if (keyword) {
      rows = rows.filter(row =>
        [row.symbol, row.name, row.latest_catalyst?.title]
          .filter(Boolean)
          .some(value => String(value).toLocaleLowerCase('zh-CN').includes(keyword))
      );
    }
    if (filters.sector) {
      const sec = filters.sector;
      rows = rows.filter(r => {
        const cat = r.latest_catalyst as { sector?: string } | undefined;
        return cat?.sector === sec;
      });
    }
    const catalystKind = filters.catalystKind;
    if (catalystKind) {
      rows = rows.filter(r => matchesMorningCatalyst(r, catalystKind));
    }
    if (filters.convictionMinMed) {
      rows = rows.filter(r => (r.conviction?.final ?? 0) >= CONVICTION_MED_MIN);
    }
    return rows;
  }, [filters, namedCandidates, search]);

  const sectors = useMemo(() => extractSectors(namedCandidates), [namedCandidates]);

  const handleRowSelect = useCallback((row: CandidateListEntry) => {
    setSelectedRow(prev => (prev?.symbol === row.symbol ? null : row));
  }, []);

  const detailSections = useMemo(
    () => (selectedRow ? buildMorningSections(selectedRow) : []),
    [selectedRow]
  );

  if (loading)
    return (
      <LoadingState
        title="正在整理 A 股早报"
        description="核对今日催化、评分与风险门禁…"
        mood="working"
      />
    );
  if (error) return <ErrorState message="数据加载失败" />;
  if (loadResult?.kind === 'not_generated')
    return <EmptyState title="当前尚未生成 A 股推荐快照" variant="simple" />;
  if (loadResult?.kind === 'unavailable')
    return <UnavailableState message="推荐服务当前不可用，请稍后重试" />;
  if (!data?.candidates?.length)
    return <EmptyState title="当前尚未生成 A 股推荐快照" variant="simple" />;
  if (namesLoading)
    return (
      <LoadingState
        title="正在匹配股票名称"
        description="候选代码已就绪，正在核对证券目录…"
        mood="working"
      />
    );

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
      <ResearchLoopStatusStrip dashboard={loopDashboard} focus="morning" />
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
      <DataListToolbar
        value={search}
        onChange={setSearch}
        total={filtered.length}
        label="条候选"
        placeholder="搜索股票代码、名称或催化线索"
      />
      <MorningBriefTable
        data={filtered}
        loading={false}
        loopDecisions={
          loopDashboard?.research.morning.fresh &&
          loopDashboard.research.multibagger.fresh &&
          loopDashboard.latest_run?.is_current
            ? loopDashboard.latest_run.decisions
            : []
        }
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
