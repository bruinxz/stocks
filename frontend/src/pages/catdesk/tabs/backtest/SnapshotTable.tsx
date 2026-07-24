import React from 'react';
import { TableColumn, type TableColumnDef } from 'shared/components/TableColumn';
import { BACKTEST_STRATEGY_LABELS, type BacktestSnapshotSlot } from './types';
import { MARKET_SCOPE_LABELS } from '../../shared/uiLabels';

interface SnapshotTableProps {
  snapshots: BacktestSnapshotSlot[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const columns: TableColumnDef<BacktestSnapshotSlot>[] = [
  {
    key: 'snapshot_day',
    title: '日期',
    ariaLabel: '快照日期',
    sortable: true,
    render: (_, row) => row.snapshot_day,
  },
  {
    key: 'strategy',
    title: '策略',
    ariaLabel: '策略配置',
    sortable: true,
    render: (_, row) => BACKTEST_STRATEGY_LABELS[row.strategy] ?? row.strategy,
  },
  {
    key: 'market_scope',
    title: '市场',
    ariaLabel: '市场范围',
    sortable: true,
    render: (_, row) => MARKET_SCOPE_LABELS[row.market_scope] ?? row.market_scope,
  },
  {
    key: 'net_value',
    title: '累计净值',
    ariaLabel: '累计净值',
    align: 'right',
    sortable: true,
    render: (_, row) => (row.net_value != null ? row.net_value.toFixed(4) : '--'),
  },
  {
    key: 'cumulative_return',
    title: '累计收益',
    ariaLabel: '累计收益率',
    align: 'right',
    sortable: true,
    render: (_, row) =>
      row.cumulative_return != null ? `${(row.cumulative_return * 100).toFixed(2)}%` : '--',
  },
  {
    key: 'drawdown',
    title: '回撤',
    ariaLabel: '最大回撤',
    align: 'right',
    sortable: true,
    render: (_, row) => (row.drawdown != null ? `${(row.drawdown * 100).toFixed(2)}%` : '--'),
  },
  {
    key: 'sharpe_ratio_6m',
    title: '夏普（6个月）',
    ariaLabel: '夏普比率六个月',
    align: 'right',
    sortable: true,
    render: (_, row) => (row.sharpe_ratio_6m != null ? row.sharpe_ratio_6m.toFixed(2) : '--'),
  },
  {
    key: 'win_rate_6m',
    title: '胜率（6个月）',
    ariaLabel: '胜率六个月',
    align: 'right',
    sortable: true,
    render: (_, row) => (row.win_rate_6m != null ? `${(row.win_rate_6m * 100).toFixed(1)}%` : '--'),
  },
];

export function SnapshotTable({ snapshots, selectedId, onSelect }: SnapshotTableProps) {
  return (
    <TableColumn<BacktestSnapshotSlot>
      rows={snapshots}
      columns={columns}
      rowKey="snapshot_id"
      onRowClick={row => onSelect(row.snapshot_id === selectedId ? null : row.snapshot_id)}
      size="small"
      emptyText="暂无快照数据"
    />
  );
}
