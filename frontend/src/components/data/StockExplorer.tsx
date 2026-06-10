import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Input, Table, Spin, Tag, Space, Select, Button, Typography, message } from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import api from '../../services/api';
import StockDetailPanel from '../stock/StockDetailPanel';

const { Text } = Typography;

interface StockRow {
  id: number;
  symbol: string;
  name: string;
  market?: string;
  industry?: string | null;
  is_listed?: boolean;
  price?: number | string | null;
  change_percent?: number | string | null;
}

const MARKETS = [
  { value: '', label: '全部市场' },
  { value: 'SH', label: '沪市' },
  { value: 'SZ', label: '深市' },
  { value: 'BJ', label: '北交所' },
];

/**
 * 个股趋势浏览器：左侧股票列表 (搜索 + 分页 + 市场过滤)，右侧 K 线详情。
 * 嵌入在 DataWorkspace 'stocks' tab 内。
 */
const StockExplorer: React.FC = () => {
  const [stocks, setStocks] = useState<StockRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchInput, setSearchInput] = useState('');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [market, setMarket] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<StockRow | null>(null);

  // 简单的 debounce: 输入停止 350ms 后再触发搜索
  const debounceRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      setSearchKeyword(searchInput.trim());
      setPage(1);
    }, 350);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  const fetchStocks = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = {
        page,
        limit: pageSize,
        listedOnly: 'true',
      };
      if (market) params.market = market;
      if (searchKeyword) params.search = searchKeyword;
      const resp = await api.get('/stocks', { params });
      const data = resp.data?.data || {};
      const rows: StockRow[] = data.stocks || [];
      setStocks(rows);
      setTotal(data.total ?? rows.length);
      // 自动选中第一个（除非已有选中且在新列表里）
      if (!selected && rows.length > 0) {
        setSelected(rows[0]);
      }
    } catch (err: any) {
      message.error(err?.response?.data?.message || err?.message || '加载股票列表失败');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, searchKeyword, market, selected]);

  useEffect(() => {
    void fetchStocks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, searchKeyword, market]);

  const columns = useMemo(
    () => [
      {
        title: '代码',
        dataIndex: 'symbol',
        width: 100,
        render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text>,
      },
      {
        title: '名称',
        dataIndex: 'name',
        render: (v: string, row: StockRow) => (
          <Space size={4}>
            <span style={{ fontWeight: 500 }}>{v}</span>
            {row.industry && (
              <Tag color="geekblue" style={{ fontSize: 10, padding: '0 4px', lineHeight: '16px' }}>
                {row.industry}
              </Tag>
            )}
          </Space>
        ),
      },
    ],
    []
  );

  return (
    <div style={{ display: 'flex', gap: 16, minHeight: 700 }}>
      {/* 左：股票列表 */}
      <Card
        size="small"
        title="股票列表"
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => void fetchStocks()}
            loading={loading}
          />
        }
        style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
        bodyStyle={{ padding: 8, display: 'flex', flexDirection: 'column', flex: 1 }}
      >
        <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 8 }}>
          <Input
            allowClear
            placeholder="搜索代码或名称 (如 600519 / 茅台)"
            prefix={<SearchOutlined />}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <Select
            style={{ width: '100%' }}
            value={market}
            onChange={(v) => {
              setMarket(v);
              setPage(1);
            }}
            options={MARKETS}
            size="small"
          />
        </Space>

        <Table
          size="small"
          rowKey="id"
          dataSource={stocks}
          loading={loading}
          columns={columns}
          pagination={{
            current: page,
            pageSize,
            total,
            simple: true,
            size: 'small',
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
            showTotal: (t) => `共 ${t}`,
          }}
          onRow={(record) => ({
            onClick: () => setSelected(record),
            style: {
              cursor: 'pointer',
              background: selected?.id === record.id ? '#e6f4ff' : undefined,
            },
          })}
          scroll={{ y: 'calc(100vh - 430px)' }}
        />
      </Card>

      {/* 右：选中股票详情 */}
      <Card
        size="small"
        title={selected ? `${selected.name} · ${selected.symbol}` : '选择左侧股票查看趋势'}
        style={{ flex: 1, minWidth: 0 }}
        bodyStyle={{ padding: 12 }}
      >
        {selected ? (
          <StockDetailPanel
            key={selected.symbol /* 强制重 mount */}
            symbol={selected.symbol}
            showHeader={false}
            compact
          />
        ) : (
          <div style={{ textAlign: 'center', padding: 80, color: '#999' }}>
            ← 从左侧列表点击任意股票
          </div>
        )}
      </Card>
    </div>
  );
};

export default StockExplorer;
