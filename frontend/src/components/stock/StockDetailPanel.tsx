import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Row, Col, Statistic, Tag, Space, Spin, Alert, Button, Tabs, Empty, Descriptions, Table, Typography, Radio } from 'antd';
import { ReloadOutlined, RobotOutlined, LineChartOutlined, FundOutlined, ProfileOutlined, BarChartOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import api from '../../services/api';
import AIStockAnalysisModal from '../trading/AIStockAnalysisModal';

const { Text, Title } = Typography;

interface HistoryBar {
  date: string; open: number; high: number; low: number; close: number;
  volume: number; amount: number; pctChg: number;
}
interface StockInfo {
  symbol: string; name: string; market?: string; industry?: string | null;
  price?: number | string | null; change_percent?: number | string | null;
  total_market_cap?: number | string | null; circulating_market_cap?: number | string | null;
  pe_dynamic?: number | string | null; pb?: number | string | null; turnover_rate?: number | string | null;
}

export function normalizeSymbol(input: string): string {
  if (!input) return '';
  const s = input.trim();
  if (s.includes('.')) return s;
  const head = s[0];
  if (head === '6') return `sh.${s}`;
  if (head === '0' || head === '3') return `sz.${s}`;
  if (head === '4' || head === '8' || head === '9') return `bj.${s}`;
  return `sz.${s}`;
}
export function extractCode(sym: string): string {
  if (!sym) return '';
  const parts = sym.split('.');
  return parts.length === 2 ? (parts[0].length === 2 ? parts[1] : parts[0]) : sym;
}

interface Props {
  symbol: string;
  showBack?: boolean;
  onBack?: () => void;
  showHeader?: boolean;
  compact?: boolean;
}

const StockDetailPanel: React.FC<Props> = ({ symbol: rawSymbol, showBack = false, onBack, showHeader = true, compact = false }) => {
  const symbol = useMemo(() => normalizeSymbol(rawSymbol || ''), [rawSymbol]);
  const displayCode = useMemo(() => extractCode(symbol), [symbol]);

  const [history, setHistory] = useState<HistoryBar[]>([]);
  const [stockInfo, setStockInfo] = useState<StockInfo | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<number>(60);
  const [aiOpen, setAiOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('chart');
  const [factors, setFactors] = useState<Array<{ factor_name: string; description: string; category: string; z_score: number | null; percentile: number | null; raw_value: number | null }>>([]);
  const [factorsLoading, setFactorsLoading] = useState(false);
  const [factorsTradeDate, setFactorsTradeDate] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!symbol) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get(`/market/history/${symbol}`);
      const data = resp.data?.data || {};
      setStockInfo(data.stock || null);
      setHistory(data.history || []);
      setSummary(data.summary || null);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => { void load(); }, [load]);

  // 因子 — 仅在 factors tab 激活且首次访问时加载
  useEffect(() => {
    if (activeTab !== 'factors') return;
    if (factors.length > 0 || factorsLoading) return;
    if (!displayCode || !/^\d{6}$/.test(displayCode)) return;
    setFactorsLoading(true);
    api.get(`/factors/stock/${displayCode}`)
      .then((r: any) => {
        const data = r.data?.data;
        setFactors(data?.factors || []);
        setFactorsTradeDate(data?.trade_date || null);
      })
      .catch(() => setFactors([]))
      .finally(() => setFactorsLoading(false));
  }, [activeTab, displayCode, factors.length, factorsLoading]);

  const visibleHistory = useMemo(() => (windowDays >= history.length ? history : history.slice(-windowDays)), [history, windowDays]);

  const klineOption = useMemo(() => {
    const dates = visibleHistory.map((d) => d.date);
    const ohlc = visibleHistory.map((d) => [d.open, d.close, d.low, d.high]);
    const volumes = visibleHistory.map((d, i) => [i, d.volume, d.close >= d.open ? 1 : -1]);
    const ma = (period: number) => {
      const out: (number | null)[] = [];
      for (let i = 0; i < visibleHistory.length; i++) {
        if (i < period - 1) { out.push(null); continue; }
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += visibleHistory[j].close;
        out.push(+(sum / period).toFixed(2));
      }
      return out;
    };
    return {
      animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { data: ['K线', 'MA5', 'MA10', 'MA20', 'MA60'], top: 0 },
      grid: [
        { left: 60, right: 20, top: 40, height: '55%' },
        { left: 60, right: 20, top: '72%', height: '18%' },
      ],
      xAxis: [
        { type: 'category', data: dates, boundaryGap: false, axisLine: { onZero: false }, splitLine: { show: false }, axisLabel: { show: false } },
        { type: 'category', gridIndex: 1, data: dates, axisLabel: { fontSize: 10 }, boundaryGap: false, axisLine: { onZero: false }, splitLine: { show: false } },
      ],
      yAxis: [
        { scale: true, splitArea: { show: true }, axisLabel: { fontSize: 10 } },
        { gridIndex: 1, axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1], bottom: 0, height: 18, start: 0, end: 100 },
      ],
      series: [
        { name: 'K线', type: 'candlestick', data: ohlc, itemStyle: { color: '#ef232a', color0: '#14b143', borderColor: '#ef232a', borderColor0: '#14b143' } },
        { name: 'MA5', type: 'line', data: ma(5), smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#f39c12' } },
        { name: 'MA10', type: 'line', data: ma(10), smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#3498db' } },
        { name: 'MA20', type: 'line', data: ma(20), smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#9b59b6' } },
        { name: 'MA60', type: 'line', data: ma(60), smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#7f8c8d' } },
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volumes, itemStyle: { color: (p: any) => (p.data[2] >= 0 ? '#ef232a' : '#14b143') } },
      ],
    };
  }, [visibleHistory]);

  const lastBar = history[history.length - 1];
  const prevBar = history[history.length - 2];
  const change = lastBar && prevBar ? lastBar.close - prevBar.close : 0;
  const changePct = lastBar && prevBar ? (change / prevBar.close) * 100 : 0;
  const chartHeight = compact ? 420 : 540;

  return (
    <div style={{ padding: compact ? 0 : 16 }}>
      {showHeader && (
        <Space style={{ marginBottom: 16 }} wrap>
          {showBack && <Button onClick={onBack}>← 返回</Button>}
          <Title level={compact ? 5 : 4} style={{ margin: 0 }}>
            {stockInfo?.name || displayCode}
            <Text type="secondary" style={{ marginLeft: 12, fontSize: 14 }}>{displayCode}</Text>
            {stockInfo?.industry && <Tag color="geekblue" style={{ marginLeft: 12 }}>{stockInfo.industry}</Tag>}
          </Title>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>刷新</Button>
          <Button icon={<RobotOutlined />} type="primary" onClick={() => setAiOpen(true)}>AI 解读</Button>
        </Space>
      )}

      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="最新价" value={lastBar?.close ?? Number(stockInfo?.price ?? 0)} precision={2} prefix="¥"
              valueStyle={{ color: change >= 0 ? '#cf1322' : '#3f8600', fontSize: compact ? 18 : 22 }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="涨跌幅" value={lastBar ? changePct : Number(stockInfo?.change_percent ?? 0)} precision={2} suffix="%"
              valueStyle={{ color: (lastBar ? changePct : Number(stockInfo?.change_percent ?? 0)) >= 0 ? '#cf1322' : '#3f8600', fontSize: compact ? 18 : 22 }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="今日成交量" value={lastBar ? (lastBar.volume / 10000).toFixed(0) : '—'} suffix="万手" valueStyle={{ fontSize: 16 }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="数据范围" value={`${history.length} 个交易日`} valueStyle={{ fontSize: 14 }} />
            {summary?.priceChange && (
              <div style={{ marginTop: 4, fontSize: 12 }}>
                <Text type="secondary">区间涨跌：</Text>
                <Text strong style={{ color: summary.priceChange.startsWith('-') ? '#3f8600' : '#cf1322' }}>{summary.priceChange}</Text>
              </div>
            )}
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Tabs activeKey={activeTab} onChange={setActiveTab} size="small" items={[
          {
            key: 'chart',
            label: <Space size={4}><LineChartOutlined />K 线 / 趋势</Space>,
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Text>窗口：</Text>
                  <Radio.Group size="small" value={windowDays} onChange={(e) => setWindowDays(e.target.value)}>
                    <Radio.Button value={30}>30 日</Radio.Button>
                    <Radio.Button value={60}>60 日</Radio.Button>
                    <Radio.Button value={120}>120 日</Radio.Button>
                    <Radio.Button value={250}>250 日</Radio.Button>
                    <Radio.Button value={Math.max(history.length, 1)}>全部</Radio.Button>
                  </Radio.Group>
                </Space>
                {loading ? (
                  <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
                ) : visibleHistory.length === 0 ? (
                  <Empty description="暂无 K 线数据" />
                ) : (
                  <ReactECharts
                    /* key 强制 remount: dataZoom inside 类型 echarts 会保留之前 zoom state,
                       窗口切换时 setOption 不重置；用 key=symbol+windowDays 强制全新 instance */
                    key={`${symbol}-${windowDays}`}
                    option={klineOption}
                    style={{ height: chartHeight }}
                    notMerge
                    lazyUpdate
                  />
                )}
              </>
            ),
          },
          {
            key: 'info',
            label: <Space size={4}><ProfileOutlined />公司信息</Space>,
            children: stockInfo ? (
              <Descriptions bordered column={compact ? 1 : 2} size="small">
                <Descriptions.Item label="代码">{symbol}</Descriptions.Item>
                <Descriptions.Item label="名称">{stockInfo.name}</Descriptions.Item>
                <Descriptions.Item label="市场">{stockInfo.market || '—'}</Descriptions.Item>
                <Descriptions.Item label="所属行业">{stockInfo.industry || '—'}</Descriptions.Item>
                <Descriptions.Item label="总市值">{stockInfo.total_market_cap ? `¥${(Number(stockInfo.total_market_cap) / 1e8).toFixed(2)} 亿` : '—'}</Descriptions.Item>
                <Descriptions.Item label="流通市值">{stockInfo.circulating_market_cap ? `¥${(Number(stockInfo.circulating_market_cap) / 1e8).toFixed(2)} 亿` : '—'}</Descriptions.Item>
                <Descriptions.Item label="动态 PE">{stockInfo.pe_dynamic || '—'}</Descriptions.Item>
                <Descriptions.Item label="PB">{stockInfo.pb || '—'}</Descriptions.Item>
                <Descriptions.Item label="换手率">{stockInfo.turnover_rate ? `${stockInfo.turnover_rate}%` : '—'}</Descriptions.Item>
              </Descriptions>
            ) : <Empty />,
          },
          {
            key: 'history',
            label: <Space size={4}><FundOutlined />历史明细</Space>,
            children: (
              <Table size="small" rowKey="date" dataSource={[...history].reverse()} pagination={{ pageSize: 20 }} scroll={{ x: 'max-content' }} columns={[
                { title: '日期', dataIndex: 'date', width: 110 },
                { title: '开盘', dataIndex: 'open', width: 80, align: 'right', render: (v: number) => v?.toFixed(2) },
                { title: '最高', dataIndex: 'high', width: 80, align: 'right', render: (v: number) => v?.toFixed(2) },
                { title: '最低', dataIndex: 'low', width: 80, align: 'right', render: (v: number) => v?.toFixed(2) },
                { title: '收盘', dataIndex: 'close', width: 80, align: 'right', render: (v: number) => <Text strong>{v?.toFixed(2)}</Text> },
                { title: '涨跌幅', dataIndex: 'pctChg', width: 90, align: 'right', render: (v: number) => <Text style={{ color: v >= 0 ? '#cf1322' : '#3f8600' }}>{v >= 0 ? '+' : ''}{v?.toFixed(2)}%</Text> },
                { title: '成交量', dataIndex: 'volume', width: 100, align: 'right', render: (v: number) => (v / 10000).toFixed(0) + ' 万' },
                { title: '成交额', dataIndex: 'amount', width: 100, align: 'right', render: (v: number) => v ? `${(v / 1e8).toFixed(2)} 亿` : '—' },
              ]} />
            ),
          },
          {
            key: 'factors',
            label: <Space size={4}><BarChartOutlined />因子分数</Space>,
            children: factorsLoading ? (
              <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
            ) : factors.length === 0 ? (
              <Empty description={`该股票 ${displayCode} 暂无因子分数（可能未被横截面纳入）`} />
            ) : (
              <>
                <div style={{ marginBottom: 8, fontSize: 12, color: '#999' }}>
                  trade_date: <Tag color="blue">{factorsTradeDate || '—'}</Tag>
                  共 {factors.length} 个因子（按 |z_score| 降序）
                </div>
                <Table
                  size="small"
                  rowKey="factor_name"
                  dataSource={factors}
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  columns={[
                    { title: '因子', dataIndex: 'factor_name', width: 150,
                      render: (v: string, r: any) => (
                        <div>
                          <Text strong>{v}</Text>
                          <div style={{ fontSize: 10, color: '#999', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.description || ''}
                          </div>
                        </div>
                      ),
                    },
                    { title: '类别', dataIndex: 'category', width: 80,
                      render: (v: string) => <Tag color="geekblue">{v}</Tag>,
                    },
                    { title: 'Z-Score', dataIndex: 'z_score', width: 100, align: 'right',
                      sorter: (a: any, b: any) => (a.z_score ?? 0) - (b.z_score ?? 0),
                      render: (v: number | null) => {
                        if (v == null) return <Text type="secondary">—</Text>;
                        const intensity = Math.min(Math.abs(v) / 2, 1);
                        const bg = v >= 0 ? `rgba(207, 19, 34, ${0.1 + intensity * 0.5})` : `rgba(20, 177, 67, ${0.1 + intensity * 0.5})`;
                        return (
                          <div style={{ background: bg, padding: '2px 8px', borderRadius: 3, textAlign: 'right', fontWeight: Math.abs(v) > 1 ? 600 : 400 }}>
                            {v >= 0 ? '+' : ''}{v.toFixed(2)}
                          </div>
                        );
                      },
                    },
                    { title: '分位 %', dataIndex: 'percentile', width: 90, align: 'right',
                      render: (v: number | null) => {
                        if (v == null) return <Text type="secondary">—</Text>;
                        const pct = v * 100;
                        return <Text style={{ color: pct >= 50 ? '#cf1322' : '#3f8600' }}>{pct.toFixed(1)}%</Text>;
                      },
                    },
                    { title: '原值', dataIndex: 'raw_value', width: 100, align: 'right',
                      render: (v: number | null) => v != null ? Number(v).toFixed(4) : '—',
                    },
                  ]}
                />
                <div style={{ marginTop: 12, fontSize: 11, color: '#999' }}>
                  说明：z_score 横截面标准化 (整个 A 股池). |z| &gt; 1.5 = 极端值. 红色 = 高于均值, 绿色 = 低于均值.
                </div>
              </>
            ),
          },
        ]} />
      </Card>

      <AIStockAnalysisModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        stockCode={symbol}
        stockName={stockInfo?.name || displayCode}
        taskLabel="stock_detail_view"
      />
    </div>
  );
};

export default StockDetailPanel;
