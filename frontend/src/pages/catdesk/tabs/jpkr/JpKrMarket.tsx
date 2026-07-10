import React, { useCallback, useMemo, useState } from 'react';
import { FilterChip } from '@/shared/components/FilterChip';
import { DetailSidebar } from '@/shared/components/DetailSidebar';
import { LoadingState } from '../../shared/LoadingState';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { DisclaimerFooter } from '../../shared/DisclaimerFooter';
import type { JpKrMarket as JpKrMarketType, JpKrMarketRow, JpKrSector } from './types';
import { useJpKrMarketData, useJpKrDetail } from './useJpKrData';
import { JpKrTable } from './JpKrTable';
import { buildJpKrSections } from './JpKrSidebarSections';

const MARKET_OPTIONS = [
  { value: 'JP' as const, label: '日本', ariaLabel: '日本市场' },
  { value: 'KR' as const, label: '韩国', ariaLabel: '韩国市场' },
];

const SECTOR_OPTIONS: Array<{ value: JpKrSector; label: string; ariaLabel: string }> = [
  { value: 'semiconductor', label: '半导体', ariaLabel: '半导体板块' },
  { value: 'automotive', label: '汽车', ariaLabel: '汽车板块' },
  { value: 'battery', label: '电池', ariaLabel: '电池板块' },
  { value: 'ai_robotics', label: 'AI/机器人', ariaLabel: 'AI 机器人板块' },
  { value: 'pharma', label: '医药', ariaLabel: '医药板块' },
  { value: 'steel', label: '钢铁', ariaLabel: '钢铁板块' },
  { value: 'shipbuilding', label: '造船', ariaLabel: '造船板块' },
  { value: 'consumer', label: '消费', ariaLabel: '消费板块' },
  { value: 'other', label: '其他', ariaLabel: '其他板块' },
];

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function JpKrMarket() {
  const [market, setMarket] = useState<JpKrMarketType>('JP');
  const [sectorFilter, setSectorFilter] = useState<JpKrSector[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const date = getTodayDate();
  const { data, loading, error } = useJpKrMarketData(date, market);
  const { data: detailData } = useJpKrDetail(selectedSymbol, date);

  const filteredRows = useMemo(() => {
    if (!data?.rows) return [];
    if (sectorFilter.length === 0) return data.rows;
    return data.rows.filter((r) => sectorFilter.includes(r.sector));
  }, [data?.rows, sectorFilter]);

  const handleMarketChange = useCallback((next: JpKrMarketType[]) => {
    if (next.length > 0) {
      setMarket(next[0]);
      setSelectedSymbol(null);
      setSidebarOpen(false);
    }
  }, []);

  const handleRowClick = useCallback((row: JpKrMarketRow) => {
    setSelectedSymbol(row.symbol);
    setSidebarOpen(true);
  }, []);

  const handleSidebarClose = useCallback(() => {
    setSidebarOpen(false);
    setSelectedSymbol(null);
  }, []);

  const selectedRow = useMemo(
    () => detailData ?? data?.rows.find((r) => r.symbol === selectedSymbol) ?? null,
    [detailData, data?.rows, selectedSymbol],
  );

  if (loading && !data) {
    return <LoadingState />;
  }

  if (error && !data) {
    return <ErrorState message="数据源暂时不可用 (JPX/KRX/DART 之一失联)" />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <FilterChip<JpKrMarketType>
          options={MARKET_OPTIONS}
          value={[market]}
          onChange={handleMarketChange}
          mode="single"
          ariaLabel="市场切换"
        />
        <FilterChip<JpKrSector>
          options={SECTOR_OPTIONS}
          value={sectorFilter}
          onChange={setSectorFilter}
          mode="multi"
          ariaLabel="板块过滤"
        />
      </div>

      {filteredRows.length === 0 && !loading ? (
        <EmptyState title="当日无披露事件 / 交易日历休市" />
      ) : (
        <JpKrTable
          rows={filteredRows}
          loading={loading}
          error={error}
          onRowClick={handleRowClick}
        />
      )}

      <DetailSidebar
        open={sidebarOpen}
        onClose={handleSidebarClose}
        title={
          selectedRow
            ? `${selectedRow.symbol} · ${selectedRow.name_local}`
            : ''
        }
        subtitle={selectedRow?.name_en}
        ariaLabel={`${selectedSymbol ?? ''} 详情侧栏`}
        sections={selectedRow ? buildJpKrSections(selectedRow) : []}
        loading={!selectedRow && sidebarOpen}
        emptyText="该标的暂无披露事件"
      />

      <DisclaimerFooter disclaimerKey="size_hint_advisory" />
    </div>
  );
}
