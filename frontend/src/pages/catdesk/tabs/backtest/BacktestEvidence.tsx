import React, { useState, useMemo, useCallback } from 'react';
import { Select, DatePicker } from 'antd';
import './backtest.css';
import { LoadingState } from '../../shared/LoadingState';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { DetailSidebar } from 'shared/components/DetailSidebar';
import type { KpiSlot } from '../../shared/KpiBar';
import { useBacktestData } from './useBacktestData';
import { SnapshotTable } from './SnapshotTable';
import { MetricsCards } from './MetricsCards';
import { BacktestChart } from './BacktestChart';
import { PitTimeline } from './PitTimeline';
import { PitBadge } from './PitBadge';
import { buildBacktestSidebarSections } from './BacktestSidebarSections';
import {
  BACKTEST_STRATEGY_MARKET_SCOPES,
  coerceBacktestMarketScope,
  type BacktestMarketScope,
  type BacktestStrategy,
} from './types';

const { RangePicker } = DatePicker;

const STRATEGY_OPTIONS: { value: BacktestStrategy; label: string }[] = [
  { value: 'us_preferred', label: '美股优选' },
  { value: 'multibagger', label: '高倍潜力' },
  { value: 'japan_blue_chip', label: '日本蓝筹' },
  { value: 'korea_semiconductor_chain', label: '韩国半导体链' },
  { value: 'japan_multibagger', label: '日本高倍潜力' },
  { value: 'korea_multibagger', label: '韩国高倍潜力' },
];

const MARKET_SCOPE_LABEL: Record<BacktestMarketScope, string> = {
  cn_a: '中国 A 股',
  us: '美国市场',
  jp: '日本市场',
  kr: '韩国市场',
};

export function BacktestEvidence() {
  const [strategy, setStrategy] = useState<BacktestStrategy>('us_preferred');
  const [marketScope, setMarketScope] = useState<BacktestMarketScope>('us');
  const [dateRange, setDateRange] = useState<[string, string] | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const {
    snapshots,
    selectedSnapshot,
    holdings,
    loading,
    holdingsLoading,
    holdingsError,
    error,
    selectSnapshot,
  } = useBacktestData({
    strategy,
    marketScope,
    from: dateRange?.[0],
    to: dateRange?.[1],
  });

  const kpiSlots: KpiSlot[] = useMemo(() => {
    if (!snapshots.length) return [];
    const latest = snapshots[0];
    return [
      {
        label: '近 6 月胜率',
        value: latest.win_rate_6m != null ? `${(latest.win_rate_6m * 100).toFixed(1)}%` : '--',
      },
      {
        label: '最大回撤',
        value: latest.drawdown != null ? `${(latest.drawdown * 100).toFixed(1)}%` : '--',
      },
      {
        label: '夏普比率',
        value: latest.sharpe_ratio_6m != null ? latest.sharpe_ratio_6m.toFixed(2) : '--',
      },
    ];
  }, [snapshots]);

  const handleSnapshotSelect = useCallback(
    (id: string | null) => {
      selectSnapshot(id);
      setSidebarOpen(id != null);
    },
    [selectSnapshot]
  );

  const handleStrategyChange = useCallback(
    (nextStrategy: BacktestStrategy) => {
      selectSnapshot(null);
      setSidebarOpen(false);
      setStrategy(nextStrategy);
      setMarketScope(currentScope => coerceBacktestMarketScope(nextStrategy, currentScope));
    },
    [selectSnapshot]
  );

  const marketScopeOptions = useMemo(
    () =>
      BACKTEST_STRATEGY_MARKET_SCOPES[strategy].map(scope => ({
        value: scope,
        label: MARKET_SCOPE_LABEL[scope],
      })),
    [strategy]
  );

  const handleMarketScopeChange = useCallback(
    (nextMarketScope: BacktestMarketScope) => {
      selectSnapshot(null);
      setSidebarOpen(false);
      setMarketScope(nextMarketScope);
    },
    [selectSnapshot]
  );

  const sidebarSections = selectedSnapshot
    ? buildBacktestSidebarSections(selectedSnapshot, holdings, holdingsLoading, holdingsError)
    : [];

  const handleDateRangeChange = useCallback(
    (nextRange: [string, string] | null) => {
      selectSnapshot(null);
      setSidebarOpen(false);
      setDateRange(nextRange);
    },
    [selectSnapshot]
  );

  let content: React.ReactNode;
  if (loading) {
    content = <LoadingState />;
  } else if (error) {
    content = <ErrorState message={error.message} />;
  } else if (!snapshots.length) {
    content = <EmptyState title="暂无回测快照 · 请等待 PIT 数据入库或切换策略" />;
  } else {
    content = (
      <>
        <MetricsCards kpiSlots={kpiSlots} />

        <div className="backtest-split">
          <div className="backtest-left">
            <BacktestChart snapshots={snapshots} />
            <PitTimeline
              snapshots={snapshots}
              selectedId={selectedSnapshot?.snapshot_id ?? null}
              onSelect={handleSnapshotSelect}
            />
          </div>
          <div className="backtest-right">
            <div className="backtest-table-heading">
              <span>SNAPSHOT REGISTER</span>
              <strong>快照登记簿</strong>
            </div>
            <SnapshotTable
              snapshots={snapshots}
              selectedId={selectedSnapshot?.snapshot_id ?? null}
              onSelect={handleSnapshotSelect}
            />
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="backtest-evidence">
      <div className="backtest-toolbar">
        <div className="backtest-toolbar__intro">
          <span>POINT-IN-TIME / 6M</span>
          <h2>回测证据台</h2>
          <p>每一笔指标都锚定到当时可见数据，拒绝事后信息污染。</p>
        </div>
        <div className="backtest-toolbar__controls">
          <Select
            aria-label="选择回测策略"
            value={strategy}
            onChange={handleStrategyChange}
            options={STRATEGY_OPTIONS}
            style={{ width: 180 }}
          />
          <Select
            aria-label="选择回测市场"
            value={marketScope}
            onChange={handleMarketScopeChange}
            options={marketScopeOptions}
            style={{ width: 140 }}
          />
          <RangePicker
            aria-label="选择快照日期范围"
            onChange={(_, dateStrings) =>
              handleDateRangeChange(dateStrings[0] ? [dateStrings[0], dateStrings[1]] : null)
            }
          />
          {selectedSnapshot && <PitBadge snapshot={selectedSnapshot} />}
        </div>
      </div>

      {content}

      <DetailSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        title={selectedSnapshot ? `PIT ${selectedSnapshot.snapshot_day}` : ''}
        ariaLabel="回测快照详情"
        sections={sidebarSections}
        emptyText="未选中任何快照"
        width={480}
      />
    </div>
  );
}
