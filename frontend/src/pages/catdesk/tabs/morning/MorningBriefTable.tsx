import React from 'react';
import { Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';

interface MorningBriefRow {
  symbol: string;
  name: string;
  score: number;
  catalystSource: string;
  catalystKind: string;
  conviction: number;
  entryLow: number;
  entryHigh: number;
}

const CATALYST_KIND_COLORS: Record<string, string> = {
  policy: 'blue',
  earnings: 'green',
  sector_rotation: 'orange',
  insider: 'purple',
  technical: 'cyan',
  macro: 'gold',
  news: 'magenta',
  institutional: 'geekblue',
  unclassified: 'default',
};

const CONVICTION_HIGH = 75;
const CONVICTION_MED = 50;

function convictionColor(v: number): string {
  if (v >= CONVICTION_HIGH) return 'var(--cd-up)';
  if (v >= CONVICTION_MED) return 'var(--cd-accent)';
  return 'var(--cd-text-secondary)';
}

const columns: ColumnsType<MorningBriefRow> = [
  { title: '代码', dataIndex: 'symbol', key: 'symbol', width: 90, render: (v: string) => <span style={{ fontFamily: 'var(--cd-font-mono)' }}>{v}</span> },
  { title: '名称', dataIndex: 'name', key: 'name', width: 100 },
  { title: '评分', dataIndex: 'score', key: 'score', width: 70, sorter: (a, b) => a.score - b.score, render: (v: number) => <span style={{ fontFamily: 'var(--cd-font-mono)', fontWeight: 600 }}>{v}</span> },
  { title: '催化来源', dataIndex: 'catalystSource', key: 'catalystSource', width: 120, ellipsis: true },
  { title: '催化类型', dataIndex: 'catalystKind', key: 'catalystKind', width: 100, render: (v: string) => <Tag color={CATALYST_KIND_COLORS[v] ?? 'default'}>{v}</Tag> },
  { title: '确信度', dataIndex: 'conviction', key: 'conviction', width: 80, sorter: (a, b) => a.conviction - b.conviction, render: (v: number) => <span style={{ color: convictionColor(v), fontWeight: 600 }}>{v}%</span> },
  { title: '入场区间', key: 'entry', width: 120, render: (_: unknown, r: MorningBriefRow) => <span style={{ fontFamily: 'var(--cd-font-mono)' }}>{r.entryLow.toFixed(2)} - {r.entryHigh.toFixed(2)}</span> },
  { title: '操作', key: 'action', width: 60, render: () => <a style={{ color: 'var(--cd-accent)' }}>详情</a> },
];

interface MorningBriefTableProps {
  data: MorningBriefRow[];
  loading?: boolean;
  onRowClick?: (symbol: string) => void;
}

export function MorningBriefTable({ data, loading, onRowClick }: MorningBriefTableProps) {
  return (
    <Table<MorningBriefRow>
      columns={columns}
      dataSource={data}
      rowKey="symbol"
      loading={loading}
      size="small"
      pagination={false}
      onRow={(record) => ({ onClick: () => onRowClick?.(record.symbol), style: { cursor: 'pointer' } })}
    />
  );
}
