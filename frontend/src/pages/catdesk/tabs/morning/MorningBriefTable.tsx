import { Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CandidateListEntry, CatalystKind } from '../c1Types';

const CATALYST_KIND_COLOR: Record<CatalystKind, string> = {
  earnings: 'blue',
  upgrade_downgrade: 'purple',
  ma_activity: 'orange',
  sector_move: 'cyan',
  regulator: 'red',
  geo_macro: 'gold',
  product: 'green',
  leadership: 'magenta',
  unclassified: 'default',
};

function convictionColor(v: number): string {
  if (v >= 75) return 'var(--cd-up)';
  if (v >= 50) return 'var(--cd-accent)';
  return 'var(--cd-text-secondary)';
}

interface Props {
  data: CandidateListEntry[];
  loading?: boolean;
  onRowClick: (row: CandidateListEntry) => void;
  selectedSymbol: string | null;
}

export function MorningBriefTable({ data, loading, onRowClick, selectedSymbol }: Props) {
  const columns: ColumnsType<CandidateListEntry> = [
    {
      title: '代码',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 90,
      render: (v: string) => <span style={{ fontFamily: 'var(--cd-font-mono)' }}>{v}</span>,
    },
    { title: '名称', dataIndex: 'name', key: 'name', width: 100 },
    {
      title: '评分',
      key: 'score',
      width: 80,
      sorter: (a, b) => (a.score?.total ?? 0) - (b.score?.total ?? 0),
      render: (_, r) => {
        const band = r.score?.rating ?? r.rating_band;
        return (
          <span style={{ fontFamily: 'var(--cd-font-mono)', fontWeight: 600 }}>
            {r.score ? r.score.total.toFixed(1) : '--'}
            {band ? ` ${band}` : ''}
          </span>
        );
      },
    },
    {
      title: '催化来源',
      key: 'catalystSource',
      width: 120,
      ellipsis: true,
      render: (_, r) => r.latest_catalyst?.title ?? '--',
    },
    {
      title: '催化类型',
      key: 'catalystKind',
      width: 100,
      render: (_, r) => {
        const kind = r.latest_catalyst?.kind ?? 'unclassified';
        return <Tag color={CATALYST_KIND_COLOR[kind] ?? 'default'}>{kind}</Tag>;
      },
    },
    {
      title: '确信度',
      key: 'conviction',
      width: 80,
      sorter: (a, b) => (a.conviction?.final ?? 0) - (b.conviction?.final ?? 0),
      render: (_, r) => {
        const v = r.conviction?.final ?? 0;
        return <span style={{ color: convictionColor(v), fontWeight: 600 }}>{v}%</span>;
      },
    },
    {
      title: '入场区间',
      key: 'entry',
      width: 120,
      render: (_, r) => {
        const ep = r.entry_plan;
        if (!ep?.entry) return '--';
        return (
          <span style={{ fontFamily: 'var(--cd-font-mono)' }}>
            {ep.entry.low.toFixed(2)} - {ep.entry.high.toFixed(2)}
          </span>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 60,
      render: () => (
        <button
          type="button"
          style={{
            color: 'var(--cd-accent)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          详情
        </button>
      ),
    },
  ];

  return (
    <Table<CandidateListEntry>
      columns={columns}
      dataSource={data}
      rowKey="symbol"
      loading={loading}
      size="small"
      pagination={false}
      onRow={record => ({
        onClick: () => onRowClick(record),
        style: {
          cursor: 'pointer',
          background: record.symbol === selectedSymbol ? 'var(--cd-bg-surface)' : undefined,
        },
      })}
    />
  );
}
