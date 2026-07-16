import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Select, Spin, Table, Tag } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { ReloadOutlined, SearchOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import api from '../../../../services/api';
import './a-share-market.css';

interface StockRow {
  id: number;
  symbol: string;
  name: string;
  market?: string;
  industry?: string | null;
  price?: number | string | null;
  change_percent?: number | string | null;
  total_market_cap?: number | string | null;
  pe_dynamic?: number | string | null;
  pb?: number | string | null;
  turnover_rate?: number | string | null;
  quote_date?: string | null;
  quote_updated_at?: string | null;
  quote_source?: string | null;
}

interface HistoryBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const MARKET_OPTIONS = [
  { value: '', label: '全部市场' },
  { value: 'SH', label: '沪市' },
  { value: 'SZ', label: '深市' },
  { value: 'BJ', label: '北交所' },
];

const FAVORITES_KEY = 'catdesk_a_share_favorites';

function readFavorites(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]') as string[];
  } catch {
    return [];
  }
}

function plainCode(symbol: string): string {
  return symbol.includes('.') ? symbol.split('.').pop() || symbol : symbol;
}

function numberValue(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quoteDateLabel(value: string | null | undefined): string {
  if (!value) return '行情待同步';
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return value === today ? '今日行情' : `截至 ${value}`;
}

function formatNumber(value: number | string | null | undefined, digits = 2): string {
  const parsed = numberValue(value);
  return parsed == null || parsed === 0 ? '—' : parsed.toFixed(digits);
}

function formatMarketCap(value: number | string | null | undefined): string {
  const parsed = numberValue(value);
  if (parsed == null || parsed <= 0) return '—';
  if (parsed >= 100_000_000) return `${(parsed / 100_000_000).toFixed(1)} 亿`;
  return `${(parsed / 10_000).toFixed(0)} 万`;
}

function marketLabel(market?: string): string {
  if (market === 'SH') return '沪市';
  if (market === 'SZ') return '深市';
  if (market === 'BJ') return '北交所';
  return market || '未知';
}

function movingAverage(values: number[], period: number): Array<number | null> {
  return values.map((_, index) => {
    if (index < period - 1) return null;
    const slice = values.slice(index - period + 1, index + 1);
    return Number((slice.reduce((sum, value) => sum + value, 0) / period).toFixed(2));
  });
}

export default function AShareMarket() {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [market, setMarket] = useState('SH');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StockRow | null>(null);
  const [history, setHistory] = useState<HistoryBar[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [windowSize, setWindowSize] = useState(120);
  const [favorites, setFavorites] = useState<string[]>(readFavorites);

  const loadStocks = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await api.get('/stocks', {
          signal,
          params: {
            page,
            limit: pageSize,
            listedOnly: 'true',
            ...(market ? { market } : {}),
            ...(search ? { search } : {}),
          },
        });
        const payload = response.data?.data ?? {};
        const nextRows: StockRow[] = payload.stocks ?? [];
        setRows(nextRows);
        setTotal(payload.pagination?.total ?? nextRows.length);
        setSelected(current => {
          if (current && nextRows.some(row => row.symbol === current.symbol)) return current;
          return nextRows[0] ?? null;
        });
      } catch (requestError: any) {
        if (requestError?.code === 'ERR_CANCELED') return;
        setError(requestError?.response?.data?.message || 'A 股行情加载失败');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [market, page, pageSize, search]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadStocks(controller.signal);
    return () => controller.abort();
  }, [loadStocks]);

  useEffect(() => {
    if (!selected) {
      setHistory([]);
      return;
    }
    const controller = new AbortController();
    setHistoryLoading(true);
    api
      .get(`/market/history/${selected.symbol}`, { signal: controller.signal })
      .then(response => setHistory(response.data?.data?.history ?? []))
      .catch(errorValue => {
        if (errorValue?.code !== 'ERR_CANCELED') setHistory([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [selected]);

  const toggleFavorite = useCallback((symbol: string) => {
    setFavorites(current => {
      const next = current.includes(symbol)
        ? current.filter(item => item !== symbol)
        : [...current, symbol];
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const columns = useMemo<ColumnsType<StockRow>>(
    () => [
      {
        title: '代码',
        dataIndex: 'symbol',
        width: 96,
        sorter: (a, b) => a.symbol.localeCompare(b.symbol),
        render: value => <span className="market-code">{plainCode(String(value))}</span>,
      },
      {
        title: '名称',
        dataIndex: 'name',
        width: 132,
        ellipsis: true,
        sorter: (a, b) => a.name.localeCompare(b.name, 'zh-CN'),
        render: (value, row) => (
          <div className="market-name-cell">
            <strong>{String(value)}</strong>
            <small>{row.industry || '行业待补充'}</small>
          </div>
        ),
      },
      {
        title: '市场',
        dataIndex: 'market',
        width: 78,
        sorter: (a, b) => String(a.market ?? '').localeCompare(String(b.market ?? '')),
        render: value => <Tag>{marketLabel(String(value || ''))}</Tag>,
      },
      {
        title: '现价',
        dataIndex: 'price',
        align: 'right',
        width: 86,
        sorter: (a, b) => (numberValue(a.price) ?? -Infinity) - (numberValue(b.price) ?? -Infinity),
        render: (value, row) => {
          const change = numberValue(row.change_percent);
          return (
            <div className={change != null && change < 0 ? 'quote-down' : 'quote-up'}>
              <strong>{formatNumber(value)}</strong>
              <small>
                {change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
              </small>
              <small className="quote-date">{quoteDateLabel(row.quote_date)}</small>
            </div>
          );
        },
      },
      {
        title: '市盈率',
        dataIndex: 'pe_dynamic',
        align: 'right',
        width: 82,
        sorter: (a, b) =>
          (numberValue(a.pe_dynamic) ?? -Infinity) - (numberValue(b.pe_dynamic) ?? -Infinity),
        render: value => formatNumber(value),
      },
      {
        title: '市净率',
        dataIndex: 'pb',
        align: 'right',
        width: 78,
        sorter: (a, b) => (numberValue(a.pb) ?? -Infinity) - (numberValue(b.pb) ?? -Infinity),
        render: value => formatNumber(value),
      },
      {
        title: '换手率',
        dataIndex: 'turnover_rate',
        align: 'right',
        width: 82,
        sorter: (a, b) =>
          (numberValue(a.turnover_rate) ?? -Infinity) - (numberValue(b.turnover_rate) ?? -Infinity),
        render: value => {
          const parsed = numberValue(value);
          return parsed == null ? '—' : `${parsed.toFixed(2)}%`;
        },
      },
      {
        title: '总市值',
        dataIndex: 'total_market_cap',
        align: 'right',
        width: 100,
        sorter: (a, b) =>
          (numberValue(a.total_market_cap) ?? -Infinity) -
          (numberValue(b.total_market_cap) ?? -Infinity),
        render: value => formatMarketCap(value),
      },
      {
        title: '自选',
        key: 'favorite',
        align: 'center',
        width: 58,
        render: (_, row) => {
          const active = favorites.includes(row.symbol);
          return (
            <Button
              type="text"
              aria-label={active ? `取消关注 ${row.name}` : `关注 ${row.name}`}
              icon={active ? <StarFilled /> : <StarOutlined />}
              className={active ? 'market-favorite is-active' : 'market-favorite'}
              onClick={event => {
                event.stopPropagation();
                toggleFavorite(row.symbol);
              }}
            />
          );
        },
      },
    ],
    [favorites, toggleFavorite]
  );

  const visibleHistory = useMemo(
    () => (history.length > windowSize ? history.slice(-windowSize) : history),
    [history, windowSize]
  );

  const chartOption = useMemo(() => {
    const dates = visibleHistory.map(item => item.date);
    const closes = visibleHistory.map(item => Number(item.close));
    return {
      animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { data: ['日K线', '5日均线', '20日均线'], top: 0, textStyle: { color: '#62534b' } },
      grid: { left: 48, right: 18, top: 42, bottom: 38 },
      xAxis: {
        type: 'category',
        data: dates,
        boundaryGap: true,
        axisLabel: { color: '#8a776c', fontSize: 10 },
        axisLine: { lineStyle: { color: '#d9c9ba' } },
      },
      yAxis: {
        scale: true,
        axisLabel: { color: '#8a776c', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(48,38,33,.08)' } },
      },
      series: [
        {
          name: '日K线',
          type: 'candlestick',
          data: visibleHistory.map(item => [item.open, item.close, item.low, item.high]),
          itemStyle: {
            color: '#df5c5f',
            color0: '#4ca58f',
            borderColor: '#df5c5f',
            borderColor0: '#4ca58f',
          },
        },
        {
          name: '5日均线',
          type: 'line',
          data: movingAverage(closes, 5),
          symbol: 'none',
          lineStyle: { width: 1.5, color: '#d99d36' },
        },
        {
          name: '20日均线',
          type: 'line',
          data: movingAverage(closes, 20),
          symbol: 'none',
          lineStyle: { width: 1.5, color: '#7c6fc6' },
        },
      ],
    };
  }, [visibleHistory]);

  const pagination: TablePaginationConfig = {
    current: page,
    pageSize,
    total,
    showSizeChanger: true,
    pageSizeOptions: [10, 20, 50, 100],
    showTotal: count => `共 ${count.toLocaleString()} 条证券`,
    onChange: (nextPage, nextSize) => {
      setPage(nextSize !== pageSize ? 1 : nextPage);
      setPageSize(nextSize);
    },
  };

  return (
    <div className="a-share-market">
      <div className="market-toolbar">
        <div>
          <span className="market-toolbar__kicker">全市场证券目录</span>
          <strong>{total.toLocaleString()} 项</strong>
          <small>当前范围内的股票、指数与 ETF</small>
        </div>
        <div className="market-toolbar__controls">
          <Input.Search
            allowClear
            value={searchInput}
            prefix={<SearchOutlined />}
            placeholder="搜索股票、指数或ETF，如 600519、沪深300"
            enterButton="搜索"
            onChange={event => setSearchInput(event.target.value)}
            onSearch={value => {
              setSearch(value.trim());
              setPage(1);
            }}
          />
          <Select
            value={market}
            options={MARKET_OPTIONS}
            aria-label="选择A股市场"
            onChange={value => {
              setMarket(value);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void loadStocks()}>
            刷新
          </Button>
        </div>
      </div>

      {error ? <div className="market-error">{error}</div> : null}

      <div className="market-browser-grid">
        <section className="market-list-panel">
          <Table<StockRow>
            rowKey="symbol"
            columns={columns}
            dataSource={rows}
            loading={{ spinning: loading, tip: '正在核对最新 A 股行情' }}
            size="small"
            pagination={pagination}
            scroll={{ x: 880, y: 540 }}
            locale={{ emptyText: '没有找到匹配的证券' }}
            onRow={row => ({
              onClick: () => setSelected(row),
              className: row.symbol === selected?.symbol ? 'is-selected' : '',
            })}
          />
        </section>

        <aside className="market-detail-panel">
          {selected ? (
            <>
              <div className="market-detail-head">
                <div>
                  <span>
                    {plainCode(selected.symbol)} · {marketLabel(selected.market)}
                  </span>
                  <h2>{selected.name}</h2>
                  <p>{selected.industry || '行业信息待补充'}</p>
                </div>
                <div
                  className={
                    (numberValue(selected.change_percent) ?? 0) < 0 ? 'quote-down' : 'quote-up'
                  }
                >
                  <strong>{formatNumber(selected.price)}</strong>
                  <small>
                    {numberValue(selected.change_percent) == null
                      ? '暂无最新涨跌幅'
                      : `${(numberValue(selected.change_percent) ?? 0) >= 0 ? '+' : ''}${numberValue(selected.change_percent)?.toFixed(2)}%`}
                  </small>
                  <small className="quote-date quote-date--detail">
                    {quoteDateLabel(selected.quote_date)}
                  </small>
                </div>
              </div>
              <div className="market-window-switch" aria-label="选择行情周期">
                {[60, 120, 250].map(value => (
                  <button
                    key={value}
                    type="button"
                    className={windowSize === value ? 'is-active' : ''}
                    onClick={() => setWindowSize(value)}
                  >
                    {value === 250 ? '近一年' : `近${value}日`}
                  </button>
                ))}
              </div>
              <div className="market-chart">
                {historyLoading ? (
                  <Spin tip="正在加载历史行情" />
                ) : visibleHistory.length ? (
                  <ReactECharts option={chartOption} style={{ height: 340 }} />
                ) : (
                  <Empty description="该股票暂无可用历史行情" />
                )}
              </div>
              <div className="market-facts">
                <span>
                  <small>市盈率</small>
                  <strong>{formatNumber(selected.pe_dynamic)}</strong>
                </span>
                <span>
                  <small>市净率</small>
                  <strong>{formatNumber(selected.pb)}</strong>
                </span>
                <span>
                  <small>换手率</small>
                  <strong>{formatNumber(selected.turnover_rate)}%</strong>
                </span>
                <span>
                  <small>总市值</small>
                  <strong>{formatMarketCap(selected.total_market_cap)}</strong>
                </span>
              </div>
            </>
          ) : (
            <Empty description="从左侧选择证券查看行情" />
          )}
        </aside>
      </div>
    </div>
  );
}
