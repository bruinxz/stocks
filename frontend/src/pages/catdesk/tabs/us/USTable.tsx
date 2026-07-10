import { Table, Tag, Progress, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CandidateListEntry, Band } from '../../types';
import { SIZE_HINT_TIER_PCT } from '../../types';

const BAND_COLOR: Record<Band, string> = {
  A: '#22c55e',
  B: '#3b82f6',
  C: '#eab308',
  D: '#f97316',
  F: '#ef4444',
};

interface USTableProps {
  data: CandidateListEntry[];
  loading: boolean;
  onRowClick?: (row: CandidateListEntry) => void;
  selectedSymbol?: string | null;
}

export function USTable({ data, loading, onRowClick, selectedSymbol }: USTableProps) {
  const columns: ColumnsType<CandidateListEntry> = [
    {
      title: 'Symbol',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 90,
      render: (v: string) => <span style={{ fontFamily: 'var(--cd-font-mono)' }}>{v}</span>,
    },
    { title: 'Name', dataIndex: 'name', key: 'name', width: 140 },
    {
      title: 'Score',
      key: 'score',
      width: 80,
      sorter: (a, b) => (a.score?.score ?? 0) - (b.score?.score ?? 0),
      render: (_, r) => (
        <span style={{ fontFamily: 'var(--cd-font-mono)', fontWeight: 600 }}>
          {r.score?.score?.toFixed(1) ?? '--'}
        </span>
      ),
    },
    {
      title: 'Rating',
      key: 'rating_band',
      width: 70,
      render: (_, r) => {
        const band = r.rating_band ?? r.score?.band;
        if (!band) return '--';
        return <Tag color={BAND_COLOR[band] ?? 'default'}>{band}</Tag>;
      },
    },
    {
      title: 'Catalyst',
      key: 'catalyst',
      width: 100,
      render: (_, r) => <Tag>{r.latest_catalyst?.kind ?? 'unclassified'}</Tag>,
    },
    {
      title: 'Conviction',
      key: 'conviction',
      width: 80,
      render: (_, r) => {
        const v = r.conviction?.final ?? 0;
        const color =
          v >= 75 ? 'var(--cd-up)' : v >= 50 ? 'var(--cd-accent)' : 'var(--cd-text-secondary)';
        return <span style={{ color, fontWeight: 600 }}>{v}%</span>;
      },
    },
    {
      title: 'Size Hint',
      key: 'sizeHint',
      width: 120,
      render: (_, r) => {
        const sh = r.entry_plan?.size_hint;
        if (!sh || sh.tier === 'SKIP')
          return <span style={{ color: 'var(--cd-text-secondary)' }}>--</span>;
        const pct = SIZE_HINT_TIER_PCT[sh.tier] ?? sh.pct ?? 0;
        return (
          <Tooltip title="仅参考·非下单 binding · 不构成投资建议">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Progress
                percent={pct * 20}
                size="small"
                showInfo={false}
                strokeColor="var(--cd-accent)"
                trailColor="var(--cd-border)"
                style={{ width: 60 }}
              />
              <span style={{ fontFamily: 'var(--cd-font-mono)', fontSize: 11 }}>
                {sh.tier} {pct}%
              </span>
            </div>
          </Tooltip>
        );
      },
    },
    {
      title: 'Entry',
      key: 'entry',
      width: 100,
      render: (_, r) => {
        const ep = r.entry_plan;
        if (!ep?.price_band) return '--';
        return (
          <span style={{ fontFamily: 'var(--cd-font-mono)' }}>
            {ep.price_band.low.toFixed(2)}-{ep.price_band.high.toFixed(2)}
          </span>
        );
      },
    },
  ];

  return (
    <Table<CandidateListEntry>
      columns={columns}
      dataSource={data}
      rowKey="symbol"
      loading={loading}
      size="small"
      pagination={{ pageSize: 20, showSizeChanger: false }}
      onRow={record => ({
        onClick: () => onRowClick?.(record),
        onKeyDown: event => {
          if (!onRowClick || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          onRowClick(record);
        },
        tabIndex: onRowClick ? 0 : undefined,
        'aria-selected': record.symbol === selectedSymbol,
        style:
          record.symbol === selectedSymbol
            ? { background: 'var(--cd-bg-selected)', cursor: 'pointer' }
            : { cursor: onRowClick ? 'pointer' : undefined },
      })}
    />
  );
}
