import React, { useCallback, useMemo, useState } from 'react';
import { FilterChip } from '@/shared/components/FilterChip';
import { DetailSidebar } from '@/shared/components/DetailSidebar';
import { LoadingState } from '../../shared/LoadingState';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { DisclaimerFooter } from '../../shared/DisclaimerFooter';
import type { MultibaggerStage, MultibaggerConclusion, MultibaggerMarket, MultibaggerRow } from './types';
import { useMultibaggerData, useMultibaggerDetail } from './useMultibaggerData';
import { MultibaggerTable } from './MultibaggerTable';
import { buildMultibaggerSections } from './MultibaggerSidebarSections';

const STAGE_OPTIONS: Array<{ value: MultibaggerStage; label: string; ariaLabel: string }> = [
  { value: 'seed', label: '种子', ariaLabel: '种子阶段' },
  { value: 'early', label: '早期', ariaLabel: '早期阶段' },
  { value: 'growth', label: '成长', ariaLabel: '成长阶段' },
  { value: 'break_below', label: '破发', ariaLabel: '破发阶段' },
  { value: 'deep', label: '深度', ariaLabel: '深度价值阶段' },
];

const CONCLUSION_OPTIONS: Array<{ value: MultibaggerConclusion; label: string; ariaLabel: string; count?: number }> = [
  { value: 'MULTIBAGGER_10X', label: '10X', ariaLabel: '10 倍潜力' },
  { value: 'MULTIBAGGER_5X', label: '5X', ariaLabel: '5 倍潜力' },
  { value: 'MULTIBAGGER_2X', label: '2X', ariaLabel: '2 倍潜力' },
  { value: 'SKIP', label: 'SKIP', ariaLabel: '跳过' },
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
    'MULTIBAGGER_2X', 'MULTIBAGGER_5X', 'MULTIBAGGER_10X', 'SKIP',
  ]);
  const [market, setMarket] = useState<MultibaggerMarket | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const selectedMarket = market;
  const { data, loading, error } = useMultibaggerData(stages, conclusions, selectedMarket);
  const { data: detailData } = useMultibaggerDetail(selectedSymbol);

  const conclusionOptionsWithCounts = useMemo(() => {
    if (!data?.kpi.conclusion_coverage) return CONCLUSION_OPTIONS;
    return CONCLUSION_OPTIONS.map((opt) => ({
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
    () => (detailData as MultibaggerRow | null) ?? data?.rows.find((r) => r.symbol === selectedSymbol) ?? null,
    [detailData, data?.rows, selectedSymbol],
  );

  if (loading && !data) {
    return <LoadingState />;
  }

  if (error && !data) {
    return <ErrorState message="候选池服务暂时不可用" />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
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

      {data && data.rows.length === 0 && !loading ? (
        <EmptyState title="当前过滤条件无候选 · 调整阶段或分结论" />
      ) : (
        <MultibaggerTable
          rows={data?.rows ?? []}
          loading={loading}
          error={error}
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
        emptyText="该标的暂无阶段/分结论 evidence"
      />

      <DisclaimerFooter disclaimerKey="size_hint_advisory" />
    </div>
  );
}
