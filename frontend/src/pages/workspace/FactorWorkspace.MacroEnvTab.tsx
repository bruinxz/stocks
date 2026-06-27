/**
 * 宏观环境 Tab — FactorWorkspace 内嵌
 *
 * 展示:
 *   - 宏观指标 KPI (PMI / M2 yoy / 10Y国债 / SHIBOR / CPI / GDP)
 *   - QVIX 折线图 (4 个标的近 60 日)
 *   - 当前 regime snapshot (含 macro/qvix/breadth/industry)
 *
 * 数据来自 /api/macro/* 几个 endpoint.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Tag, Space, Spin, Alert, Empty, Typography, Tooltip, Table } from 'antd';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from 'recharts';
import api from '../../services/api';
import { useNavigate } from 'react-router-dom';

const { Text, Paragraph } = Typography;

interface MacroIndicatorsResponse {
  latest: Record<string, { date: string; value: number; yoy_pct: number | null }>;
  series: Record<string, Array<{ date: string; value: number; yoy_pct: number | null }>>;
}

interface QvixResponse {
  latest: Record<string, { date: string; close: number; change_5d_pct: string | null }>;
  series: Record<string, Array<{ date: string; close: number; open: number; high: number; low: number }>>;
}

interface RegimeSnapshot {
  market_regime: string;
  market_regime_label: string;
  benchmark_return_20d_pct: number;
  benchmark_drawdown_60d_pct: number;
  macro?: any;
  qvix?: any;
  breadth: {
    up_20d_ratio: number;
    above_ma20_ratio: number;
    sample_count: number;
    strong_industry_count?: number;
    weak_industry_count?: number;
  };
}

const INDICATOR_LABELS: Record<string, string> = {
  pmi: '制造业 PMI',
  cpi: 'CPI 同比',
  m2: 'M2 同比',
  treasury_10y_china: '10Y 国债',
  shibor_overnight: '隔夜 SHIBOR',
  gdp_yearly: 'GDP 同比',
};

const INDICATOR_UNIT: Record<string, string> = {
  pmi: '',
  cpi: '%',
  m2: '%',
  treasury_10y_china: '%',
  shibor_overnight: '%',
  gdp_yearly: '%',
};

const QVIX_LABELS: Record<string, string> = {
  '50etf': '50ETF',
  '300etf': '300ETF',
  '500etf': '500ETF',
  cyb: '创业板',
};

interface BlockTrade {
  trade_date: string;
  stock_code: string;
  stock_name: string | null;
  price: number;
  close_price: number;
  amount: number;
  premium_pct: number | null;
  change_pct: number | null;
  buyer: string;
  seller: string;
}

const MacroEnvTab: React.FC = () => {
  const navigate = useNavigate();
  const [indicators, setIndicators] = useState<MacroIndicatorsResponse | null>(null);
  const [qvix, setQvix] = useState<QvixResponse | null>(null);
  const [regime, setRegime] = useState<RegimeSnapshot | null>(null);
  const [blockTrades, setBlockTrades] = useState<BlockTrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ind, qv, rg, bt] = await Promise.all([
        api.get('/macro/indicators?days=1095').then(r => r.data?.data),
        api.get('/macro/qvix?days=90').then(r => r.data?.data),
        api.get('/macro/regime-snapshot').then(r => r.data?.data),
        api.get('/macro/block-trades?days=7&limit=100').then(r => r.data?.data),
      ]);
      setIndicators(ind);
      setQvix(qv);
      setRegime(rg);
      setBlockTrades(bt?.items || []);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 组合 4 个 qvix series 到一个 chart data
  const qvixChartData = React.useMemo(() => {
    if (!qvix?.series) return [];
    const dateMap = new Map<string, any>();
    for (const [key, list] of Object.entries(qvix.series)) {
      for (const p of list) {
        const row = dateMap.get(p.date) || { date: p.date };
        row[key] = p.close;
        dateMap.set(p.date, row);
      }
    }
    return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [qvix]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && <Alert type="error" showIcon message={error} />}

      {/* 当前 regime 大字 */}
      {regime && (
        <Card size="small">
          <Row gutter={[24, 16]} align="middle">
            <Col xs={24} md={8}>
              <Statistic
                title="当前市场环境"
                value={regime.market_regime_label || regime.market_regime}
                valueStyle={{ fontSize: 18, color: regimeColor(regime.market_regime) }}
              />
              <div style={{ marginTop: 6 }}>
                <Tag color="blue">沪深 300 20日: {regime.benchmark_return_20d_pct?.toFixed(2)}%</Tag>
                <Tag color="orange">60日回撤: {regime.benchmark_drawdown_60d_pct?.toFixed(2)}%</Tag>
              </div>
            </Col>
            <Col xs={24} md={16}>
              <Paragraph type="secondary" style={{ margin: 0 }}>
                regime 分类基于：基准价格 + 市场宽度 (up_20d_ratio={regime.breadth?.up_20d_ratio?.toFixed(1)}%, 强势行业{regime.breadth?.strong_industry_count}/弱势{regime.breadth?.weak_industry_count}) +{' '}
                <Text strong>宏观指标 (PMI/M2/国债)</Text> +{' '}
                <Text strong>QVIX (恐慌指数)</Text>
              </Paragraph>
            </Col>
          </Row>
        </Card>
      )}

      {/* 宏观指标 KPI */}
      {loading && !indicators ? (
        <Card><Spin /></Card>
      ) : indicators?.latest ? (
        <Card size="small" title="宏观经济指标">
          <Row gutter={[12, 12]}>
            {Object.entries(indicators.latest).map(([key, v]) => (
              <Col xs={12} sm={8} md={4} key={key}>
                <Card size="small">
                  <Tooltip title={`最新观测日 ${v.date}`}>
                    <Statistic
                      title={INDICATOR_LABELS[key] || key}
                      value={v.value}
                      precision={2}
                      suffix={INDICATOR_UNIT[key] || ''}
                      valueStyle={{
                        fontSize: 18,
                        color: key === 'pmi' ? (v.value >= 50 ? '#16a34a' : '#dc2626') : '#1677ff',
                      }}
                    />
                  </Tooltip>
                  {v.yoy_pct != null && (
                    <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                      yoy {v.yoy_pct.toFixed(2)}%
                    </div>
                  )}
                </Card>
              </Col>
            ))}
          </Row>
          {indicators.latest.pmi && indicators.latest.pmi.value < 50 && (
            <Alert
              type="warning"
              showIcon
              message="制造业 PMI < 50 (荣枯线)，提示经济收缩。EnsembleStrategy 已自动禁止 bull regime。"
              style={{ marginTop: 12 }}
            />
          )}
        </Card>
      ) : (
        <Empty description="无宏观数据，请先跑 npm run sync:extra-dims -- --dim=macro" />
      )}

      {/* QVIX */}
      {qvix?.latest && (
        <Card size="small" title="期权波动率 QVIX (A 股恐慌指数)">
          <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
            {Object.entries(qvix.latest).map(([key, v]) => (
              <Col xs={12} sm={6} key={key}>
                <Card size="small">
                  <Statistic
                    title={QVIX_LABELS[key] || key}
                    value={v.close}
                    precision={2}
                    valueStyle={{ fontSize: 18 }}
                    suffix={
                      v.change_5d_pct != null ? (
                        <span style={{
                          fontSize: 12,
                          marginLeft: 6,
                          color: Number(v.change_5d_pct) >= 0 ? '#dc2626' : '#16a34a',
                        }}>
                          5d {Number(v.change_5d_pct) >= 0 ? '+' : ''}{v.change_5d_pct}%
                        </span>
                      ) : undefined
                    }
                  />
                  <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>
                    {v.date}
                  </div>
                </Card>
              </Col>
            ))}
          </Row>

          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={qvixChartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <RechartsTooltip />
              <Legend />
              <Line type="monotone" dataKey="50etf" stroke="#f39c12" dot={false} name="50ETF" />
              <Line type="monotone" dataKey="300etf" stroke="#cf1322" dot={false} name="300ETF" strokeWidth={2} />
              <Line type="monotone" dataKey="500etf" stroke="#722ed1" dot={false} name="500ETF" />
              <Line type="monotone" dataKey="cyb" stroke="#13c2c2" dot={false} name="创业板" />
            </LineChart>
          </ResponsiveContainer>
          {regime?.qvix?.is_panic && (
            <Alert
              type="error"
              showIcon
              message={`QVIX 300ETF 触发恐慌阈值 (60d ${regime.qvix.qvix_300etf_percentile_60d}% 分位 + 5d 上升 ${regime.qvix.qvix_300etf_change_5d_pct}%)`}
              style={{ marginTop: 12 }}
            />
          )}
        </Card>
      )}

      {/* 大宗交易 */}
      <Card
        size="small"
        title={
          <Space>
            <span>近 7 日大宗交易</span>
            <Tag>{blockTrades.length} 笔</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              折溢价 &gt; 5% 通常是机构操作信号
            </Text>
          </Space>
        }
      >
        {blockTrades.length === 0 ? (
          <Empty description="暂无大宗交易数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table
            size="small"
            rowKey={(r: any) => `${r.trade_date}-${r.stock_code}-${r.buyer}-${r.amount}`}
            dataSource={blockTrades}
            pagination={{ pageSize: 15, size: 'small' }}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '日期', dataIndex: 'trade_date', width: 100 },
              {
                title: '代码',
                dataIndex: 'stock_code',
                width: 92,
                render: (v: string) => (
                  <a onClick={() => navigate(`/stock/${v}`)}>
                    <Text code style={{ fontSize: 12 }}>{v}</Text>
                  </a>
                ),
              },
              {
                title: '名称',
                dataIndex: 'stock_name',
                width: 110,
                render: (v: string | null, row: BlockTrade) =>
                  v ? <a onClick={() => navigate(`/stock/${row.stock_code}`)}>{v}</a> : '—',
              },
              {
                title: '成交价',
                dataIndex: 'price',
                width: 80,
                align: 'right' as const,
                render: (v: number) => `¥${Number(v).toFixed(2)}`,
              },
              {
                title: '收盘价',
                dataIndex: 'close_price',
                width: 80,
                align: 'right' as const,
                render: (v: number) => `¥${Number(v).toFixed(2)}`,
              },
              {
                title: '折溢价',
                dataIndex: 'premium_pct',
                width: 90,
                align: 'right' as const,
                sorter: (a: BlockTrade, b: BlockTrade) => (a.premium_pct ?? 0) - (b.premium_pct ?? 0),
                render: (v: number | null) => {
                  if (v == null) return '—';
                  const color = v >= 0 ? '#dc2626' : '#16a34a';
                  const label = v >= 0 ? '溢价' : '折价';
                  return (
                    <Tag color={Math.abs(v) > 5 ? (v > 0 ? 'red' : 'green') : 'default'}>
                      {label} {v >= 0 ? '+' : ''}{v.toFixed(2)}%
                    </Tag>
                  );
                },
              },
              {
                title: '成交额',
                dataIndex: 'amount',
                width: 100,
                align: 'right' as const,
                sorter: (a: BlockTrade, b: BlockTrade) => a.amount - b.amount,
                render: (v: number) => `¥${(v / 10000).toFixed(0)} 万`,
              },
              {
                title: '当日涨跌',
                dataIndex: 'change_pct',
                width: 90,
                align: 'right' as const,
                render: (v: number | null) => {
                  if (v == null) return '—';
                  return (
                    <span style={{ color: v >= 0 ? '#dc2626' : '#16a34a', fontSize: 12 }}>
                      {v >= 0 ? '+' : ''}{v.toFixed(2)}%
                    </span>
                  );
                },
              },
              {
                title: '买方',
                dataIndex: 'buyer',
                width: 200,
                ellipsis: true,
                render: (v: string) => <Text style={{ fontSize: 12 }}>{v || '—'}</Text>,
              },
              {
                title: '卖方',
                dataIndex: 'seller',
                width: 200,
                ellipsis: true,
                render: (v: string) => <Text style={{ fontSize: 12 }}>{v || '—'}</Text>,
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
};

function regimeColor(regime: string): string {
  switch (regime) {
    case 'bull': return '#16a34a';
    case 'bear': return '#dc2626';
    case 'stress': return '#dc2626';
    case 'rebound': return '#fa8c16';
    case 'range': return '#1677ff';
    default: return '#999';
  }
}

export default MacroEnvTab;
