import React from 'react';
import { Tag, Tooltip } from 'antd';
import { TableColumn } from 'shared/components/TableColumn';
import type { TableColumnDef } from 'shared/components/TableColumn';
import type { JpKrMarketRow } from './types';

const MARKET_LABEL: Record<string, string> = { JP: '日本', KR: '韩国' };
const CURRENCY_LABEL: Record<string, string> = { JPY: '日元', KRW: '韩元', USD: '美元' };

function formatChangePct(pct: number): React.ReactNode {
  const color = pct > 0 ? '#cf1322' : pct < 0 ? '#389e0d' : undefined;
  const prefix = pct > 0 ? '+' : '';
  return (
    <span style={{ color }}>
      {prefix}
      {pct.toFixed(2)}%
    </span>
  );
}

function getColumns(): TableColumnDef<JpKrMarketRow>[] {
  return [
    {
      key: 'symbol',
      title: '代码',
      ariaLabel: '股票代码',
      width: 90,
      sortable: (a, b) => a.symbol.localeCompare(b.symbol, 'zh-CN', { numeric: true }),
      render: (_, row) => (
        <span>
          {row.symbol}
          {row.is_halted && (
            <Tag color="red" style={{ marginLeft: 4 }}>
              停
            </Tag>
          )}
        </span>
      ),
    },
    {
      key: 'name',
      title: '名称',
      ariaLabel: '公司名称',
      width: 160,
      sortable: (a, b) => a.name_local.localeCompare(b.name_local, 'zh-CN'),
      render: (_, row) => (
        <Tooltip title={row.name_en}>
          <span>{row.name_local}</span>
        </Tooltip>
      ),
    },
    {
      key: 'market',
      title: '市场',
      ariaLabel: '交易所',
      width: 60,
      sortable: (a, b) => a.market.localeCompare(b.market),
      render: (_, row) => (
        <Tag color={row.market === 'JP' ? 'blue' : 'green'}>
          {MARKET_LABEL[row.market] ?? row.market}
        </Tag>
      ),
    },
    {
      key: 'price',
      title: '现价',
      ariaLabel: '最新收盘价',
      width: 120,
      align: 'right',
      sortable: (a, b) => a.close - b.close,
      render: (_, row) => (
        <span>
          {row.close.toLocaleString()} {CURRENCY_LABEL[row.currency] ?? row.currency}
          <br />
          {formatChangePct(row.change_pct)}
        </span>
      ),
    },
    {
      key: 'disclosure_last',
      title: '最近披露',
      ariaLabel: '最近披露事件',
      width: 180,
      render: (_, row) => {
        const evt = row.disclosure_events[0];
        if (!evt) return <span style={{ color: '#999' }}>—</span>;
        return (
          <Tooltip title={`${evt.doc_type} · ${evt.source}`}>
            <span>
              {evt.title.length > 20 ? evt.title.slice(0, 20) + '…' : evt.title}
              <br />
              <span style={{ color: '#999', fontSize: 12 }}>
                {new Date(evt.filed_at).toLocaleDateString()}
              </span>
            </span>
          </Tooltip>
        );
      },
    },
    {
      key: 'revenue_exposure',
      title: '主营敞口',
      ariaLabel: '按地区收入敞口',
      width: 120,
      render: (_, row) => {
        const top = row.revenue_by_region[0];
        if (!top) return <span style={{ color: '#999' }}>—</span>;
        return (
          <Tooltip
            title={row.revenue_by_region.map(r => `${r.region}: ${r.pct.toFixed(1)}%`).join(' · ')}
          >
            <span>
              {top.region} {top.pct.toFixed(1)}%
            </span>
          </Tooltip>
        );
      },
    },
    {
      key: 'fx_sensitivity',
      title: '汇率敏感度',
      ariaLabel: '汇率敏感系数',
      width: 100,
      align: 'right',
      sortable: (a, b) => a.fx_beta - b.fx_beta,
      render: (_, row) => {
        const abs = Math.abs(row.fx_beta);
        const color = abs > 0.5 ? '#cf1322' : abs > 0.2 ? '#faad14' : '#389e0d';
        return (
          <span style={{ color }}>
            {row.fx_beta > 0 ? '+' : ''}
            {row.fx_beta.toFixed(2)}
          </span>
        );
      },
    },
    {
      key: 'score_hint',
      title: '评分',
      ariaLabel: '策略综合评分',
      width: 80,
      align: 'center',
      sortable: (a, b) =>
        (a.recommendation?.score?.total ?? -Infinity) -
        (b.recommendation?.score?.total ?? -Infinity),
      render: (_, row) =>
        row.recommendation?.score ? (
          <Tooltip title={`推荐快照 ${row.recommendation.provenance?.snapshot_id ?? '—'}`}>
            <Tag color={row.recommendation.risk_gate?.gate === 'GREEN' ? 'green' : 'orange'}>
              {row.recommendation.score.total.toFixed(1)} · {row.recommendation.rating_band}
            </Tag>
          </Tooltip>
        ) : (
          <span style={{ color: '#999' }}>未生成</span>
        ),
    },
    {
      key: 'halt_status',
      title: '状态',
      ariaLabel: '交易状态',
      width: 60,
      align: 'center',
      render: (_, row) =>
        row.is_halted ? <Tag color="red">停牌</Tag> : <Tag color="green">正常</Tag>,
    },
  ];
}

type JpKrTableProps = {
  rows: JpKrMarketRow[];
  loading: boolean;
  error: Error | null;
  onRowClick: (row: JpKrMarketRow) => void;
};

export function JpKrTable({ rows, loading, error, onRowClick }: JpKrTableProps) {
  return (
    <TableColumn<JpKrMarketRow>
      rows={rows}
      columns={getColumns()}
      rowKey="symbol"
      loading={loading}
      onRowClick={onRowClick}
      scroll={{ y: 600 }}
      emptyText="当日无披露事件 / 交易日历休市"
      errorText={
        error ? (
          <div role="alert" aria-live="polite">
            日韩市场数据刷新失败，请检查数据源或返回契约
          </div>
        ) : undefined
      }
      size="small"
    />
  );
}
