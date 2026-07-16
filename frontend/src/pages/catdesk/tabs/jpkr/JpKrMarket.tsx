import React, { useCallback, useMemo, useState } from 'react';
import { FilterChip } from 'shared/components/FilterChip';
import { DetailSidebar } from 'shared/components/DetailSidebar';
import { LoadingState } from '../../shared/LoadingState';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { DisclaimerFooter } from '../../shared/DisclaimerFooter';
import type { JpKrMarket as JpKrMarketType, JpKrMarketRow, JpKrSector } from './types';
import { useJpKrMarketData, useJpKrDetail } from './useJpKrData';
import { JpKrTable } from './JpKrTable';
import { buildJpKrSections } from './JpKrSidebarSections';
import { JpKrKpiStrip } from './JpKrKpiStrip';
import './jpkr.css';
import { DataListToolbar } from '../../shared/DataListToolbar';

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
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export type JpKrMarketProps = {
  tradingDay?: string;
};

export default function JpKrMarket({ tradingDay }: JpKrMarketProps = {}) {
  const [market, setMarket] = useState<JpKrMarketType>('JP');
  const [sectorFilter, setSectorFilter] = useState<JpKrSector[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');

  const date = tradingDay ?? getTodayDate();
  const { data, loading, error } = useJpKrMarketData(date, market);
  const { data: detailData } = useJpKrDetail(selectedSymbol, date);

  const filteredRows = useMemo(() => {
    if (!data?.rows) return [];
    let rows =
      sectorFilter.length === 0
        ? data.rows
        : data.rows.filter(r => sectorFilter.includes(r.sector));
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    if (keyword) {
      rows = rows.filter(row =>
        [row.symbol, row.name_local, row.name_en]
          .filter(Boolean)
          .some(value => String(value).toLocaleLowerCase('zh-CN').includes(keyword))
      );
    }
    return rows;
  }, [data?.rows, search, sectorFilter]);

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

  const selectedRow = useMemo(() => {
    const listed = data?.rows.find(r => r.symbol === selectedSymbol);
    if (!detailData) return listed ?? null;
    return {
      ...detailData,
      ...(listed?.recommendation ? { recommendation: listed.recommendation } : {}),
    };
  }, [detailData, data?.rows, selectedSymbol]);

  if (loading && !data) {
    return (
      <LoadingState
        title="正在查看日韩盘面"
        description="核对东京与首尔的行情、板块和披露事件…"
        mood="surprised"
      />
    );
  }

  if (error && !data) {
    return <ErrorState message="日韩市场数据暂时不可用，请检查数据源或返回契约" />;
  }

  return (
    <div className="jpkr-market">
      {data && <JpKrKpiStrip kpi={data.kpi} />}

      {data?.recommendation_status?.kind !== 'ready' && (
        <div
          role="status"
          style={{
            border: '1px solid var(--cd-border)',
            borderRadius: 8,
            padding: '8px 12px',
            color: 'var(--cd-text-secondary)',
          }}
        >
          {data?.recommendation_status?.kind === 'unavailable'
            ? '策略推荐服务当前不可用；行情、披露与汇率数据仍可查看。'
            : '当前交易日尚未生成该市场的策略推荐快照。'}
        </div>
      )}

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

      <DataListToolbar
        value={search}
        onChange={setSearch}
        total={filteredRows.length}
        label="条股票"
        placeholder="搜索股票代码或公司名称"
      />

      {filteredRows.length === 0 && !loading ? (
        <EmptyState
          title={
            sectorFilter.length
              ? '当前市场的所选板块暂无行情，可切换日本/韩国市场'
              : '当日暂无可用行情 / 交易日历休市'
          }
        />
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
        title={selectedRow ? `${selectedRow.symbol} · ${selectedRow.name_local}` : ''}
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
