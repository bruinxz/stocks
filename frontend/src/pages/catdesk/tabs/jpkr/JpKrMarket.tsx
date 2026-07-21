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
  { value: 'KR' as const, label: '韩国科技', ariaLabel: '韩国科技市场' },
  { value: 'JP' as const, label: '日本参考', ariaLabel: '日本参考市场' },
];

function getTodayDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function delta(value: number | null): string {
  if (value == null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function deltaDirection(value: number | null): 'up' | 'down' | 'flat' {
  if (value == null || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

export type JpKrMarketProps = {
  tradingDay?: string;
};

export default function JpKrMarket({ tradingDay }: JpKrMarketProps = {}) {
  const [market, setMarket] = useState<JpKrMarketType>('KR');
  const [sectorFilter, setSectorFilter] = useState<JpKrSector | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');

  const date = tradingDay ?? getTodayDate();
  const { data, loading, error } = useJpKrMarketData(date, market);
  const { data: detailData } = useJpKrDetail(selectedSymbol, date);

  const filteredRows = useMemo(() => {
    if (!data?.rows) return [];
    let rows = sectorFilter ? data.rows.filter(row => row.sector === sectorFilter) : data.rows;
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
      setSectorFilter(null);
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
    () => detailData ?? data?.rows.find(row => row.symbol === selectedSymbol) ?? null,
    [detailData, data?.rows, selectedSymbol]
  );

  if (loading && !data) {
    return (
      <LoadingState
        title="正在整理韩国科技盘面"
        description="按科技板块与少量代表股归档最新行情…"
        mood="surprised"
      />
    );
  }

  if (error && !data) {
    return <ErrorState message="日韩科技行情暂时不可用，请检查数据源或返回契约" />;
  }

  return (
    <div className="jpkr-market">
      <header className="jpkr-focus-header">
        <div>
          <span>ASIA TECHNOLOGY DESK · {date}</span>
          <h2>{market === 'KR' ? '韩国科技板块观察' : '日本市场参考'}</h2>
          <p>
            {market === 'KR'
              ? '只保留少量科技代表股，板块涨幅采用代表股等权平均。'
              : '日本市场保留为次级参考视图，不影响韩国科技主观察池。'}
          </p>
        </div>
        <FilterChip<JpKrMarketType>
          options={MARKET_OPTIONS}
          value={[market]}
          onChange={handleMarketChange}
          mode="single"
          ariaLabel="市场切换"
        />
      </header>

      {data && data.sector_performance.length > 0 && (
        <section className="jpkr-sector-section" aria-labelledby="jpkr-sector-title">
          <div className="jpkr-section-heading">
            <div>
              <span>01 / SECTOR FIRST</span>
              <h3 id="jpkr-sector-title">板块涨幅</h3>
            </div>
            <p>代表股等权口径 · 点击可筛选</p>
          </div>
          <div className="jpkr-sector-board">
            {data.sector_performance.map((sector, index) => (
              <button
                className="jpkr-sector-card"
                data-active={sectorFilter === sector.sector}
                type="button"
                key={sector.sector}
                onClick={() =>
                  setSectorFilter(current => (current === sector.sector ? null : sector.sector))
                }
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <span>
                  <strong>{sector.sector_label}</strong>
                  <small>{sector.representative_count} 只代表股</small>
                </span>
                <strong data-delta={deltaDirection(sector.change_pct)}>
                  {delta(sector.change_pct)}
                </strong>
              </button>
            ))}
          </div>
        </section>
      )}

      {data && <JpKrKpiStrip kpi={data.kpi} market={market} />}

      <section className="jpkr-representatives" aria-labelledby="jpkr-stock-title">
        <div className="jpkr-section-heading">
          <div>
            <span>02 / REPRESENTATIVES</span>
            <h3 id="jpkr-stock-title">{market === 'KR' ? '韩国科技代表股' : '日本市场代表股'}</h3>
          </div>
          <p>{sectorFilter ? '已按板块筛选' : '随板块强弱排序'}</p>
        </div>
        <DataListToolbar
          value={search}
          onChange={setSearch}
          total={filteredRows.length}
          label="只代表股"
          placeholder="搜索股票代码或公司名称"
        />

        {filteredRows.length === 0 && !loading ? (
          <EmptyState title="当前交易日暂无可用代表股行情" />
        ) : (
          <JpKrTable
            rows={filteredRows}
            loading={loading}
            error={error}
            onRowClick={handleRowClick}
          />
        )}
      </section>

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
