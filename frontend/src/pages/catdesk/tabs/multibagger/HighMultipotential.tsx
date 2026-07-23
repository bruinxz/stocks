import React, { useCallback, useMemo, useState } from 'react';
import { FilterChip } from 'shared/components/FilterChip';
import { DetailSidebar } from 'shared/components/DetailSidebar';
import { LoadingState } from '../../shared/LoadingState';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { DisclaimerFooter } from '../../shared/DisclaimerFooter';
import type {
  MultibaggerStage,
  MultibaggerConclusion,
  MultibaggerMarket,
  MultibaggerRow,
} from './types';
import { useMultibaggerData, useMultibaggerDetail } from './useMultibaggerData';
import { MultibaggerTable } from './MultibaggerTable';
import { buildMultibaggerSections } from './MultibaggerSidebarSections';
import { DataListToolbar } from '../../shared/DataListToolbar';
import { useStockNameHydration } from '../../shared/useStockNameHydration';
import { useResearchTradingLoop } from '../../shared/useResearchTradingLoop';
import { ResearchLoopStatusStrip } from '../../shared/ResearchLoopStatusStrip';

const STAGE_OPTIONS: Array<{ value: MultibaggerStage; label: string; ariaLabel: string }> = [
  { value: 'seed', label: '种子', ariaLabel: '种子阶段' },
  { value: 'early', label: '早期', ariaLabel: '早期阶段' },
  { value: 'growth', label: '成长', ariaLabel: '成长阶段' },
  { value: 'break_below', label: '破发', ariaLabel: '破发阶段' },
  { value: 'deep', label: '深度', ariaLabel: '深度价值阶段' },
];

const CONCLUSION_OPTIONS: Array<{
  value: MultibaggerConclusion;
  label: string;
  ariaLabel: string;
  count?: number;
}> = [
  { value: 'MULTIBAGGER_10X', label: '10倍潜力', ariaLabel: '10 倍潜力' },
  { value: 'MULTIBAGGER_5X', label: '5倍潜力', ariaLabel: '5 倍潜力' },
  { value: 'MULTIBAGGER_2X', label: '2倍潜力', ariaLabel: '2 倍潜力' },
  { value: 'SKIP', label: '暂不关注', ariaLabel: '跳过' },
];

const MARKET_OPTIONS: Array<{ value: MultibaggerMarket; label: string; ariaLabel: string }> = [
  { value: 'A', label: 'A股', ariaLabel: 'A 股市场' },
  { value: 'US', label: '美股', ariaLabel: '美股市场' },
  { value: 'JP', label: '日本', ariaLabel: '日本市场' },
  { value: 'KR', label: '韩国', ariaLabel: '韩国市场' },
];

export default function HighMultipotential() {
  const [stages, setStages] = useState<MultibaggerStage[]>([]);
  const [conclusions, setConclusions] = useState<MultibaggerConclusion[]>([
    'MULTIBAGGER_2X',
    'MULTIBAGGER_5X',
    'MULTIBAGGER_10X',
    'SKIP',
  ]);
  const [market, setMarket] = useState<MultibaggerMarket | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selectedMarket = market;
  const { data, loading, error } = useMultibaggerData(stages, conclusions, selectedMarket);
  const { data: loopDashboard, error: loopError } = useResearchTradingLoop();
  const { data: detailData } = useMultibaggerDetail(selectedSymbol);
  const namedRows = useStockNameHydration(
    data?.rows ?? [],
    useCallback((row: MultibaggerRow) => row.market === 'A', [])
  );
  const visibleRows = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    if (!keyword) return namedRows;
    return namedRows.filter(row =>
      [row.symbol, row.name, row.latest_catalyst?.title]
        .filter(Boolean)
        .some(value => String(value).toLocaleLowerCase('zh-CN').includes(keyword))
    );
  }, [namedRows, search]);

  const conclusionOptionsWithCounts = useMemo(() => {
    if (!data?.kpi.conclusion_coverage) return CONCLUSION_OPTIONS;
    return CONCLUSION_OPTIONS.map(opt => ({
      ...opt,
      count: data.kpi.conclusion_coverage[opt.value] ?? 0,
    }));
  }, [data?.kpi.conclusion_coverage]);

  const handleMarketChange = useCallback((next: MultibaggerMarket[]) => {
    setMarket(next.length > 0 ? next[0] : null);
  }, []);

  const handleRowClick = useCallback((row: MultibaggerRow) => {
    setSelectedSymbol(row.symbol);
    setSidebarOpen(true);
  }, []);

  const handleSidebarClose = useCallback(() => {
    setSidebarOpen(false);
    setSelectedSymbol(null);
  }, []);

  const selectedRow = useMemo(
    () =>
      (detailData as MultibaggerRow | null) ??
      namedRows.find(row => row.symbol === selectedSymbol) ??
      null,
    [detailData, namedRows, selectedSymbol]
  );

  if (loading && !data) {
    return (
      <LoadingState
        title="正在筛选高倍潜力"
        description="把长期质量、趋势和催化证据放在一起比较…"
        mood="thinking"
      />
    );
  }

  if (error && !data) {
    return <ErrorState message="候选池服务暂时不可用" />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <ResearchLoopStatusStrip dashboard={loopDashboard} error={loopError} focus="multibagger" />
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <FilterChip<MultibaggerStage>
          options={STAGE_OPTIONS}
          value={stages}
          onChange={setStages}
          mode="multi"
          ariaLabel="阶段过滤"
        />
        <FilterChip<MultibaggerConclusion>
          options={conclusionOptionsWithCounts}
          value={conclusions}
          onChange={setConclusions}
          mode="multi"
          ariaLabel="分结论过滤"
        />
        <FilterChip<MultibaggerMarket>
          options={MARKET_OPTIONS}
          value={market ? [market] : []}
          onChange={handleMarketChange}
          mode="single"
          ariaLabel="市场过滤"
        />
      </div>

      <DataListToolbar
        value={search}
        onChange={setSearch}
        total={visibleRows.length}
        label="条候选"
        placeholder="搜索股票代码、名称或催化线索"
      />

      {data && visibleRows.length === 0 && !loading ? (
        <EmptyState title="当前过滤条件无候选 · 调整阶段或分结论" />
      ) : (
        <MultibaggerTable
          rows={visibleRows}
          loading={loading}
          error={error}
          loopDecisions={
            loopDashboard?.research.morning.fresh &&
            loopDashboard.research.multibagger.fresh &&
            loopDashboard.latest_run?.is_current
              ? loopDashboard.latest_run.decisions
              : []
          }
          onRowClick={handleRowClick}
        />
      )}

      <DetailSidebar
        open={sidebarOpen}
        onClose={handleSidebarClose}
        title={selectedRow ? `${selectedRow.symbol} · ${selectedRow.name}` : ''}
        ariaLabel={`${selectedSymbol ?? ''} 高倍潜力详情`}
        sections={selectedRow ? buildMultibaggerSections(selectedRow) : []}
        loading={!selectedRow && sidebarOpen}
        emptyText="该股票暂无阶段或分结论证据"
      />

      <DisclaimerFooter disclaimerKey="size_hint_advisory" />
    </div>
  );
}
