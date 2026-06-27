import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Input, Table, Spin, Tag, Space, Select, Button, Typography, message, Tooltip } from 'antd';
import { SearchOutlined, ReloadOutlined, PushpinFilled, PushpinOutlined, StarOutlined, StarFilled } from '@ant-design/icons';
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

const PINNED_KEY = 'stocks_explorer_pinned';
const loadPinned = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(PINNED_KEY) || '[]');
  } catch {
    return [];
  }
};
const savePinned = (arr: string[]) => localStorage.setItem(PINNED_KEY, JSON.stringify(arr));

const formatPrice = (v: any): string => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  return n.toFixed(2);
};

/**
 * 个股趋势浏览器：左侧股票列表 (搜索 + 分页 + 市场过滤 + 置顶)，右侧 K 线详情。
 * 嵌入在 DataWorkspace 'stocks' tab 内。
 *
 * 列表显示：代码 / 名称+行业 / 最新价+涨跌幅 / 置顶按钮。
 * 数据：/api/stocks 返回 price + change_percent (由 sync 任务更新到 stocks 表)。
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

  // 置顶列表（localStorage 持久化）
  const [pinned, setPinned] = useState<string[]>(loadPinned);
  const [pinnedStocks, setPinnedStocks] = useState<StockRow[]>([]);
  const [showOnlyPinned, setShowOnlyPinned] = useState(false);

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

  // 加载置顶股票的最新行情（独立请求，每次 mount + pinned 变化时刷新）
  const fetchPinnedQuotes = useCallback(async () => {
    if (pinned.length === 0) {
      setPinnedStocks([]);
      return;
    }
    try {
      const promises = pinned.map((sym) =>
        api.get(`/stocks/${sym}`).then(r => r.data?.data?.stock as StockRow).catch(() => null)
      );
      const results = await Promise.all(promises);
      setPinnedStocks(results.filter((x): x is StockRow => !!x));
    } catch {
      // ignore
    }
  }, [pinned]);

  useEffect(() => {
    void fetchPinnedQuotes();
  }, [fetchPinnedQuotes]);

  const togglePin = useCallback((symbol: string) => {
    setPinned((prev) => {
      const next = prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol];
      savePinned(next);
      message.success(prev.includes(symbol) ? '已取消置顶' : '已置顶');
      return next;
    });
  }, []);

  // 当 showOnlyPinned=true，dataSource 切到 pinnedStocks（绕过 server 分页）
  const dataSource = useMemo(() => {
    return showOnlyPinned ? pinnedStocks : stocks;
  }, [showOnlyPinned, pinnedStocks, stocks]);

  const columns = useMemo(
    () => [
      {
        title: '代码',
        dataIndex: 'symbol',
        width: 92,
        render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text>,
      },
      {
        title: '名称',
        dataIndex: 'name',
        render: (v: string, row: StockRow) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {v}
            </div>
            {row.industry && (
              <Tag color="geekblue" style={{ fontSize: 10, padding: '0 4px', lineHeight: '14px', marginTop: 2 }}>
                {row.industry}
              </Tag>
            )}
          </div>
        ),
      },
      {
        title: '现价',
        dataIndex: 'price',
        width: 72,
        align: 'right' as const,
        render: (v: any, row: StockRow) => {
          const price = formatPrice(v);
          const pct = Number(row.change_percent);
          const hasChange = Number.isFinite(pct) && pct !== 0;
          const color = hasChange ? (pct >= 0 ? '#dc2626' : '#16a34a') : '#999';
          return (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, fontWeight: 500, color }}>{price}</div>
              {hasChange && (
                <div style={{ fontSize: 10, color }}>
                  {pct > 0 ? '+' : ''}{pct.toFixed(2)}%
                </div>
              )}
            </div>
          );
        },
      },
      {
        title: '',
        key: 'pin',
        width: 32,
        render: (_: unknown, row: StockRow) => {
          const isPinned = pinned.includes(row.symbol);
          return (
            <Tooltip title={isPinned ? '取消置顶' : '置顶'}>
              <Button
                size="small"
                type="text"
                icon={isPinned ? <PushpinFilled style={{ color: '#fa8c16' }} /> : <PushpinOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin(row.symbol);
                }}
              />
            </Tooltip>
          );
        },
      },
    ],
    [pinned, togglePin]
  );

  return (
    <div style={{ display: 'flex', gap: 16, minHeight: 700 }}>
      {/* 左：股票列表 */}
      <Card
        size="small"
        title={
          <Space size={4}>
            <span>股票列表</span>
            {showOnlyPinned ? (
              <Tag color="orange">置顶 {pinnedStocks.length}</Tag>
            ) : (
              <Tag>{total.toLocaleString()}</Tag>
            )}
          </Space>
        }
        extra={
          <Space size={4}>
            <Tooltip title={showOnlyPinned ? '显示全部' : '仅看置顶'}>
              <Button
                size="small"
                type={showOnlyPinned ? 'primary' : 'default'}
                icon={showOnlyPinned ? <StarFilled /> : <StarOutlined />}
                onClick={() => setShowOnlyPinned((v) => !v)}
              >
                {pinned.length}
              </Button>
            </Tooltip>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => {
                void fetchStocks();
                void fetchPinnedQuotes();
              }}
              loading={loading}
            />
          </Space>
        }
        style={{ width: 420, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
        styles={{ body: { padding: 8, display: 'flex', flexDirection: 'column', flex: 1 } }}
      >
        <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 8 }}>
          <Input
            allowClear
            placeholder="搜索代码或名称 (如 600519 / 茅台)"
            prefix={<SearchOutlined />}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            disabled={showOnlyPinned}
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
            disabled={showOnlyPinned}
          />
        </Space>

        <Table
          size="small"
          rowKey="symbol"
          dataSource={dataSource}
          loading={loading}
          columns={columns}
          pagination={
            showOnlyPinned
              ? false
              : {
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
                }
          }
          onRow={(record) => ({
            onClick: () => setSelected(record),
            style: {
              cursor: 'pointer',
              background: selected?.symbol === record.symbol ? '#e6f4ff' : undefined,
            },
          })}
          scroll={{ y: 'calc(100vh - 460px)' }}
        />
      </Card>

      {/* 右：选中股票详情 */}
      <Card
        size="small"
        title={
          selected ? (
            <Space>
              <span>{selected.name}</span>
              <Text code style={{ fontSize: 11 }}>{selected.symbol}</Text>
              {selected.industry && <Tag color="geekblue">{selected.industry}</Tag>}
              {pinned.includes(selected.symbol) && <PushpinFilled style={{ color: '#fa8c16' }} />}
            </Space>
          ) : (
            '选择左侧股票查看趋势'
          )
        }
        extra={
          selected && (
            <Button
              size="small"
              type={pinned.includes(selected.symbol) ? 'primary' : 'default'}
              icon={pinned.includes(selected.symbol) ? <PushpinFilled /> : <PushpinOutlined />}
              onClick={() => togglePin(selected.symbol)}
            >
              {pinned.includes(selected.symbol) ? '已置顶' : '置顶'}
            </Button>
          )
        }
        style={{ flex: 1, minWidth: 0 }}
        styles={{ body: { padding: 12 } }}
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
