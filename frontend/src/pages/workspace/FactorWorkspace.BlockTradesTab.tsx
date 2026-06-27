/**
 * 大宗交易 Tab — FactorWorkspace 内嵌
 *
 * 展示:
 *   - 最近 N 天大宗交易 (按交易额降序)
 *   - 折溢价高亮 (>+5% = 抢筹溢价 / <-5% = 机构甩货)
 *   - 营业部统计 (前 10 大活跃营业部)
 *
 * 数据来自 GET /api/macro/block-trades.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Table, Tag, Space, Spin, Alert, Empty, Typography, Statistic, Row, Col, Radio, Tooltip } from 'antd';
import api from '../../services/api';

const { Text } = Typography;

interface BlockTrade {
  trade_date: string;
  stock_code: string;
  stock_name: string | null;
  price: number;
  close_price: number | null;
  volume: number;
  amount: number;
  premium_pct: number | null;
  change_pct: number | null;
  buyer: string;
  seller: string;
}

const BlockTradesTab: React.FC = () => {
  const [trades, setTrades] = useState<BlockTrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(7);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get(`/macro/block-trades?days=${days}&limit=200`);
      setTrades(resp.data?.data?.items || []);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  // KPI 统计
  const stats = useMemo(() => {
    if (!trades.length) return null;
    const totalAmount = trades.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const premiumTrades = trades.filter(t => (t.premium_pct ?? 0) > 5).length;
    const discountTrades = trades.filter(t => (t.premium_pct ?? 0) < -5).length;
    // 前 10 大买方营业部
    const buyerStats = new Map<string, number>();
    for (const t of trades) {
      if (!t.buyer) continue;
      buyerStats.set(t.buyer, (buyerStats.get(t.buyer) || 0) + (Number(t.amount) || 0));
    }
    const topBuyers = Array.from(buyerStats.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    return {
      total_count: trades.length,
      total_amount: totalAmount,
      premium_trades: premiumTrades,
      discount_trades: discountTrades,
      top_buyers: topBuyers,
    };
  }, [trades]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && <Alert type="error" showIcon message={error} />}

      {/* KPI */}
      {stats && (
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic title="交易笔数" value={stats.total_count} suffix="笔" />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="总成交额"
                value={(stats.total_amount / 1e8).toFixed(2)}
                suffix="亿"
                valueStyle={{ color: '#1677ff' }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="溢价>5% (抢筹)"
                value={stats.premium_trades}
                suffix="笔"
                valueStyle={{ color: '#cf1322' }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="折价>5% (甩货)"
                value={stats.discount_trades}
                suffix="笔"
                valueStyle={{ color: '#3f8600' }}
              />
            </Card>
          </Col>
        </Row>
      )}

      {/* 前 5 大活跃营业部 */}
      {stats && stats.top_buyers.length > 0 && (
        <Card size="small" title="前 5 大活跃买方营业部">
          <Space wrap>
            {stats.top_buyers.map(([buyer, amount], i) => (
              <Tag key={buyer} color={i === 0 ? 'red' : i === 1 ? 'orange' : 'blue'}>
                {buyer.length > 24 ? buyer.substring(0, 22) + '…' : buyer} · {(amount / 1e8).toFixed(2)} 亿
              </Tag>
            ))}
          </Space>
        </Card>
      )}

      {/* 主表 */}
      <Card
        size="small"
        title={
          <Space>
            <span>大宗交易明细</span>
            <Tag color="blue">{trades.length} 笔</Tag>
          </Space>
        }
        extra={
          <Radio.Group size="small" value={days} onChange={e => setDays(e.target.value)}>
            <Radio.Button value={3}>近3日</Radio.Button>
            <Radio.Button value={7}>近7日</Radio.Button>
            <Radio.Button value={14}>近14日</Radio.Button>
            <Radio.Button value={30}>近30日</Radio.Button>
          </Radio.Group>
        }
      >
        {loading && !trades.length ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : trades.length === 0 ? (
          <Empty description="近期无大宗交易数据" />
        ) : (
          <Table
            size="small"
            rowKey={(r) => `${r.trade_date}-${r.stock_code}-${r.buyer}-${r.amount}`}
            dataSource={trades}
            pagination={{ pageSize: 30, size: 'small' }}
            scroll={{ x: 'max-content' }}
            columns={[
              {
                title: '日期',
                dataIndex: 'trade_date',
                width: 100,
                sorter: (a: BlockTrade, b: BlockTrade) => a.trade_date.localeCompare(b.trade_date),
                defaultSortOrder: 'descend' as const,
              },
              {
                title: '股票',
                key: 'stock',
                width: 140,
                render: (_: any, r: BlockTrade) => (
                  <Space size={4}>
                    <Text strong>{r.stock_name || r.stock_code}</Text>
                    <Text code style={{ fontSize: 12 }}>{r.stock_code}</Text>
                  </Space>
                ),
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
                render: (v: number | null) => v ? `¥${Number(v).toFixed(2)}` : '—',
              },
              {
                title: '折溢价',
                dataIndex: 'premium_pct',
                width: 90,
                align: 'right' as const,
                sorter: (a: BlockTrade, b: BlockTrade) => (a.premium_pct ?? 0) - (b.premium_pct ?? 0),
                render: (v: number | null) => {
                  if (v == null) return '—';
                  const n = Number(v);
                  const color = n > 5 ? '#cf1322' : n < -5 ? '#3f8600' : '#999';
                  return (
                    <Text style={{ color, fontWeight: Math.abs(n) > 5 ? 600 : 400 }}>
                      {n > 0 ? '+' : ''}{n.toFixed(2)}%
                    </Text>
                  );
                },
              },
              {
                title: '成交额',
                dataIndex: 'amount',
                width: 90,
                align: 'right' as const,
                sorter: (a: BlockTrade, b: BlockTrade) => (Number(a.amount) || 0) - (Number(b.amount) || 0),
                render: (v: number) => (
                  <Text strong>{(Number(v) / 1e8).toFixed(2)} 亿</Text>
                ),
              },
              {
                title: '当日涨跌',
                dataIndex: 'change_pct',
                width: 80,
                align: 'right' as const,
                render: (v: number | null) => {
                  if (v == null) return '—';
                  const n = Number(v);
                  return (
                    <Text style={{ color: n >= 0 ? '#cf1322' : '#3f8600' }}>
                      {n > 0 ? '+' : ''}{n.toFixed(2)}%
                    </Text>
                  );
                },
              },
              {
                title: '买方营业部',
                dataIndex: 'buyer',
                width: 200,
                ellipsis: true,
                render: (v: string) => (
                  <Tooltip title={v}>
                    <Text style={{ fontSize: 12 }}>{v || '—'}</Text>
                  </Tooltip>
                ),
              },
              {
                title: '卖方营业部',
                dataIndex: 'seller',
                width: 200,
                ellipsis: true,
                render: (v: string) => (
                  <Tooltip title={v}>
                    <Text style={{ fontSize: 12 }}>{v || '—'}</Text>
                  </Tooltip>
                ),
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
};

export default BlockTradesTab;
