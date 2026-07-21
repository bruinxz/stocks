import React from 'react';
import { Tag, Tooltip } from 'antd';
import { TableColumn } from 'shared/components/TableColumn';
import type { TableColumnDef } from 'shared/components/TableColumn';
import type { JpKrMarketRow } from './types';

const MARKET_LABEL: Record<string, string> = { JP: '日本', KR: '韩国' };
const CURRENCY_LABEL: Record<string, string> = { JPY: '日元', KRW: '韩元' };
const SECTOR_LABEL: Record<string, string> = {
  semiconductor: '半导体',
  internet_platform: '互联网平台',
  battery: '电池科技',
  ai_robotics: 'AI 与机器人',
  automotive: '汽车',
  consumer: '消费科技',
  pharma: '医药',
  steel: '钢铁',
  shipbuilding: '造船',
  other: '其他',
};

function formatChangePct(pct: number): React.ReactNode {
  const direction = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  return (
    <span data-delta={direction}>
      {pct > 0 ? '+' : ''}
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
      width: 100,
      sortable: (a, b) => a.symbol.localeCompare(b.symbol, 'zh-CN', { numeric: true }),
      render: (_, row) => (
        <span style={{ fontFamily: 'var(--cd-font-mono)', fontWeight: 700 }}>
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
      title: '科技代表股',
      ariaLabel: '公司名称',
      width: 210,
      sortable: (a, b) => a.name_local.localeCompare(b.name_local, 'zh-CN'),
      render: (_, row) => (
        <Tooltip title={row.name_en}>
          <span>
            <strong>{row.name_local}</strong>
            <small className="jpkr-table-subtitle">{row.name_en}</small>
          </span>
        </Tooltip>
      ),
    },
    {
      key: 'sector',
      title: '科技板块',
      ariaLabel: '科技板块',
      width: 130,
      sortable: (a, b) => a.sector.localeCompare(b.sector),
      render: (_, row) => <Tag>{SECTOR_LABEL[row.sector] ?? row.sector}</Tag>,
    },
    {
      key: 'market',
      title: '市场',
      ariaLabel: '交易所',
      width: 72,
      render: (_, row) => <span>{MARKET_LABEL[row.market] ?? row.market}</span>,
    },
    {
      key: 'price',
      title: '收盘 / 涨跌',
      ariaLabel: '最新收盘价与涨跌幅',
      width: 150,
      align: 'right',
      sortable: (a, b) => a.change_pct - b.change_pct,
      render: (_, row) => (
        <span className="jpkr-table-price">
          <strong>{row.close.toLocaleString()}</strong>
          <small>{CURRENCY_LABEL[row.currency] ?? row.currency}</small>
          {formatChangePct(row.change_pct)}
        </span>
      ),
    },
    {
      key: 'as_of',
      title: '交易日',
      ariaLabel: '行情交易日',
      width: 108,
      render: (_, row) => <span style={{ fontFamily: 'var(--cd-font-mono)' }}>{row.as_of}</span>,
    },
    {
      key: 'halt_status',
      title: '状态',
      ariaLabel: '交易状态',
      width: 68,
      align: 'center',
      render: (_, row) =>
        row.is_halted ? <Tag color="red">停牌</Tag> : <span className="jpkr-live-dot">正常</span>,
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
      scroll={{ y: 520 }}
      emptyText="当前交易日暂无代表股行情"
      errorText={
        error ? (
          <div role="alert" aria-live="polite">
            日韩科技行情刷新失败，请检查数据源或返回契约
          </div>
        ) : undefined
      }
      size="small"
    />
  );
}
