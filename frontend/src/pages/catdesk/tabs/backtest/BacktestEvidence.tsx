import React, { useState, useMemo, useCallback } from 'react';
import { Select, DatePicker } from 'antd';
import { LoadingState } from '../../shared/LoadingState';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { DetailSidebar } from '@/shared/components/DetailSidebar';
import type { KpiSlot } from '../../shared/KpiBar';
import { useBacktestData } from './useBacktestData';
import { SnapshotTable } from './SnapshotTable';
import { MetricsCards } from './MetricsCards';
import { BacktestChart } from './BacktestChart';
import { PitBadge } from './PitBadge';
import { buildBacktestSidebarSections } from './BacktestSidebarSections';

const { RangePicker } = DatePicker;

type Profile = 'us_preferred' | 'multibagger';

const PROFILE_OPTIONS = [
  { value: 'us_preferred' as const, label: '美股优选' },
  { value: 'multibagger' as const, label: '高倍潜力' },
];

export function BacktestEvidence() {
  const [profile, setProfile] = useState<Profile>('us_preferred');
  const [dateRange, setDateRange] = useState<[string, string] | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const {
    snapshots,
    selectedSnapshot,
    holdings,
    loading,
    holdingsLoading,
    error,
    selectSnapshot,
    refetchSnapshots,
  } = useBacktestData({
    profile,
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
    [selectSnapshot],
  );

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!snapshots.length) {
    return (
      <EmptyState title="暂无回测快照 · 请等待 6-month PIT 数据入库或切换 profile" />
    );
  }

  const sidebarSections = selectedSnapshot
    ? buildBacktestSidebarSections(selectedSnapshot, holdings, holdingsLoading)
    : [];

  return (
    <div className="backtest-evidence">
      <div className="backtest-toolbar">
        <Select
          value={profile}
          onChange={setProfile}
          options={PROFILE_OPTIONS}
          style={{ width: 140 }}
        />
        <RangePicker
          onChange={(_, dateStrings) =>
            setDateRange(dateStrings[0] ? [dateStrings[0], dateStrings[1]] : null)
          }
        />
        {selectedSnapshot && <PitBadge snapshot={selectedSnapshot} />}
      </div>

      <MetricsCards kpiSlots={kpiSlots} />

      <div className="backtest-split">
        <div className="backtest-left">
          <BacktestChart snapshots={snapshots} />
        </div>
        <div className="backtest-right">
          <SnapshotTable
            snapshots={snapshots}
            selectedId={selectedSnapshot?.snapshot_id ?? null}
            onSelect={handleSnapshotSelect}
          />
        </div>
      </div>

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
