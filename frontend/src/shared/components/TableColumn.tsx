import React from 'react';
import { Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Band, Conviction, RiskGate, Score } from '../types/catdesk';
import {
  CONVICTION_LABELS,
  RATING_LABELS,
  RISK_GATE_LABELS,
} from '../../pages/catdesk/shared/uiLabels';

export type TableColumnDef<Row> = {
  key: string;
  title: string;
  ariaLabel: string;
  width?: number | string;
  align?: 'left' | 'center' | 'right';
  sortable?: boolean | ((left: Row, right: Row) => number);
  render?: (value: unknown, row: Row, index: number) => React.ReactNode;
};

export type TableColumnProps<Row> = {
  rows: Row[];
  columns: TableColumnDef<Row>[];
  rowKey: keyof Row | ((row: Row) => string);
  loading?: boolean;
  onRowClick?: (row: Row) => void;
  scroll?: { x?: number; y?: number };
  emptyText?: React.ReactNode;
  errorText?: React.ReactNode;
  size?: 'small' | 'middle';
  className?: string;
  pagination?: false | { pageSize?: number };
};

const BAND_COLOR: Record<Band, string> = {
  A: '#389e0d',
  B: '#52c41a',
  C: '#faad14',
  D: '#fa8c16',
  F: '#cf1322',
};

const CONVICTION_COLOR: Record<string, string> = {
  HIGH: '#389e0d',
  MED: '#faad14',
  LOW: '#cf1322',
};

const RISK_COLOR: Record<string, string> = {
  GREEN: '#389e0d',
  YELLOW: '#faad14',
  RED: '#cf1322',
};

function compareTableValues(left: unknown, right: unknown): number {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right), 'zh-CN', { numeric: true });
}

export function ScoreCell(score: Score, ariaLabel: string): JSX.Element {
  return (
    <span aria-label={ariaLabel}>
      <Tag color={BAND_COLOR[score.rating]}>{RATING_LABELS[score.rating] ?? score.rating}</Tag>
      <span style={{ fontSize: 12 }}>{score.total}</span>
    </span>
  );
}

export function ConvictionPill(c: Conviction, ariaLabel: string): JSX.Element {
  return (
    <Tag color={CONVICTION_COLOR[c.level]} aria-label={ariaLabel}>
      {CONVICTION_LABELS[c.level] ?? c.level} {c.final}
    </Tag>
  );
}

export function RiskGateChip(r: RiskGate, ariaLabel: string): JSX.Element {
  return (
    <Tooltip title={r.triggers.length ? `发现 ${r.triggers.length} 项风险提示` : '未发现风险提示'}>
      <Tag color={RISK_COLOR[r.gate]} aria-label={ariaLabel}>
        {RISK_GATE_LABELS[r.gate] ?? r.gate}
        {r.triggers.length > 0 && ` (${r.triggers.length})`}
      </Tag>
    </Tooltip>
  );
}

export function TableColumn<Row extends object>({
  rows,
  columns,
  rowKey,
  loading,
  onRowClick,
  scroll,
  emptyText,
  errorText,
  size = 'small',
  className,
  pagination,
}: TableColumnProps<Row>) {
  if (errorText) {
    return <div role="alert">{errorText}</div>;
  }

  const antdColumns: ColumnsType<Row> = columns.map(col => ({
    key: col.key,
    title: col.title,
    dataIndex: col.key,
    width: col.width,
    align: col.align,
    sorter:
      typeof col.sortable === 'function'
        ? col.sortable
        : col.sortable
          ? (left: Row, right: Row) =>
              compareTableValues(
                (left as Record<string, unknown>)[col.key],
                (right as Record<string, unknown>)[col.key]
              )
          : undefined,
    render: col.render
      ? (_val: unknown, record: Row, index: number) => col.render?.(_val, record, index)
      : undefined,
    onHeaderCell: () => ({ 'aria-label': col.ariaLabel }) as React.HTMLAttributes<HTMLElement>,
  }));

  return (
    <Table<Row>
      columns={antdColumns}
      dataSource={rows}
      rowKey={rowKey as string | ((record: Row) => string)}
      loading={loading}
      scroll={scroll}
      size={size}
      className={className}
      locale={{ emptyText: emptyText ?? '暂无数据' }}
      pagination={
        pagination === false
          ? false
          : {
              pageSize: pagination?.pageSize ?? 10,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50],
              showTotal: total => `共 ${total} 条`,
            }
      }
      onRow={
        onRowClick
          ? record => ({
              onClick: () => onRowClick(record),
              style: { cursor: 'pointer' },
              role: 'button',
              tabIndex: 0,
              'aria-label': `查看 ${String((record as Record<string, unknown>).symbol ?? '')} 详情`,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onRowClick(record);
                }
              },
            })
          : undefined
      }
    />
  );
}
