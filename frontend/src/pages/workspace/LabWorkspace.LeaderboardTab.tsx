/**
 * 策略排行 Tab — LabWorkspace 内嵌
 *
 * 展示所有策略的最新回测结果按 sharpe / annual_return / total_return 排序.
 * 每策略取最新一次 backtest。
 *
 * 数据来自 GET /api/quant/strategy-leaderboard.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Table, Tag, Space, Spin, Alert, Empty, Typography, Radio, Tooltip } from 'antd';
import { TrophyOutlined } from '@ant-design/icons';
import api from '../../services/api';

const { Text } = Typography;

interface LeaderboardItem {
  strategy_key: string;
  strategy_name?: string;
  task_id: number;
  total_return_pct: number | string | null;
  annual_return_pct: number | string | null;
  max_drawdown_pct: number | string | null;
  sharpe_ratio: number | string | null;
  win_rate: number | string | null;
  profit_factor?: number | string | null;
  trade_count: number;
  benchmark_return_pct?: number | string | null;
  excess_return_pct?: number | string | null;
  created_at: string;
}

const LeaderboardTab: React.FC<{
  strategiesMeta?: Array<{ strategy_key: string; name?: string; description?: string }>;
}> = ({ strategiesMeta = [] }) => {
  const [items, setItems] = useState<LeaderboardItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'sharpe' | 'annual' | 'total'>('sharpe');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get(`/quant/strategy-leaderboard?sort_by=${sortBy}`);
      setItems(resp.data?.data?.items || []);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [sortBy]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of strategiesMeta) m.set(s.strategy_key, s.name || s.strategy_key);
    return m;
  }, [strategiesMeta]);

  const num = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const pctRender = (v: any, redIfNeg = true) => {
    const n = num(v);
    if (n == null) return <Text type="secondary">—</Text>;
    const color = redIfNeg ? (n >= 0 ? '#cf1322' : '#3f8600') : '#1677ff';
    return <Text style={{ color, fontWeight: 500 }}>{n >= 0 ? '+' : ''}{n.toFixed(2)}%</Text>;
  };

  const sharpeRender = (v: any) => {
    const n = num(v);
    if (n == null) return <Text type="secondary">—</Text>;
    const color = n >= 1.5 ? '#cf1322' : n >= 0.5 ? '#fa8c16' : n >= 0 ? '#1677ff' : '#3f8600';
    return <Text style={{ color, fontWeight: 500 }}>{n.toFixed(2)}</Text>;
  };

  return (
    <Card
      title={
        <Space>
          <TrophyOutlined style={{ color: '#fa8c16' }} />
          <span>策略排行榜</span>
          <Tag color="purple">{items.length} 个策略</Tag>
        </Space>
      }
      extra={
        <Radio.Group size="small" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <Radio.Button value="sharpe">夏普比率</Radio.Button>
          <Radio.Button value="annual">年化收益</Radio.Button>
          <Radio.Button value="total">总收益</Radio.Button>
        </Radio.Group>
      }
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}

      {loading && !items.length ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : items.length === 0 ? (
        <Empty description="暂无回测结果 — 请在 '新建回测' tab 触发一次" />
      ) : (
        <Table
          size="small"
          rowKey="strategy_key"
          dataSource={items}
          pagination={false}
          scroll={{ x: 'max-content', y: 600 }}
          columns={[
            {
              title: '#',
              key: 'rank',
              width: 40,
              render: (_: any, __: any, idx: number) => {
                const colors = ['#cf1322', '#fa8c16', '#fadb14', '#1677ff', '#1677ff'];
                const color = idx < 5 ? colors[Math.min(idx, 4)] : '#999';
                return <Text strong style={{ color, fontSize: 14 }}>{idx + 1}</Text>;
              },
            },
            {
              title: '策略',
              dataIndex: 'strategy_key',
              width: 230,
              render: (k: string) => (
                <div>
                  <Text strong>{nameMap.get(k) || k}</Text>
                  <div style={{ fontSize: 10, color: '#999' }}>{k}</div>
                </div>
              ),
            },
            {
              title: '夏普比率',
              dataIndex: 'sharpe_ratio',
              width: 90,
              align: 'right' as const,
              sorter: (a: LeaderboardItem, b: LeaderboardItem) => (num(a.sharpe_ratio) ?? 0) - (num(b.sharpe_ratio) ?? 0),
              render: (v: any) => sharpeRender(v),
            },
            {
              title: '年化收益',
              dataIndex: 'annual_return_pct',
              width: 90,
              align: 'right' as const,
              sorter: (a: LeaderboardItem, b: LeaderboardItem) => (num(a.annual_return_pct) ?? 0) - (num(b.annual_return_pct) ?? 0),
              render: (v: any) => pctRender(v),
            },
            {
              title: '总收益',
              dataIndex: 'total_return_pct',
              width: 90,
              align: 'right' as const,
              sorter: (a: LeaderboardItem, b: LeaderboardItem) => (num(a.total_return_pct) ?? 0) - (num(b.total_return_pct) ?? 0),
              render: (v: any) => pctRender(v),
            },
            {
              title: '最大回撤',
              dataIndex: 'max_drawdown_pct',
              width: 90,
              align: 'right' as const,
              sorter: (a: LeaderboardItem, b: LeaderboardItem) => (num(a.max_drawdown_pct) ?? 0) - (num(b.max_drawdown_pct) ?? 0),
              render: (v: any) => {
                const n = num(v);
                if (n == null) return <Text type="secondary">—</Text>;
                const color = Math.abs(n) > 20 ? '#cf1322' : Math.abs(n) > 10 ? '#fa8c16' : '#3f8600';
                return <Text style={{ color, fontWeight: 500 }}>{n.toFixed(2)}%</Text>;
              },
            },
            {
              title: '胜率',
              dataIndex: 'win_rate',
              width: 80,
              align: 'right' as const,
              render: (v: any) => {
                const n = num(v);
                if (n == null) return <Text type="secondary">—</Text>;
                // win_rate 可能是 0-1 或 0-100, 兼容
                const pct = n > 1 ? n : n * 100;
                const color = pct >= 60 ? '#cf1322' : pct >= 50 ? '#fa8c16' : '#3f8600';
                return <Text style={{ color }}>{pct.toFixed(1)}%</Text>;
              },
            },
            {
              title: '成交数',
              dataIndex: 'trade_count',
              width: 70,
              align: 'right' as const,
              render: (v: number) => <Text>{v}</Text>,
            },
            {
              title: '最近回测',
              dataIndex: 'created_at',
              width: 110,
              render: (v: string) => {
                if (!v) return '—';
                const d = new Date(v);
                const days = Math.floor((Date.now() - d.getTime()) / 86400000);
                const label = d.toISOString().slice(0, 10);
                return (
                  <Tooltip title={v}>
                    <Text style={{ fontSize: 11 }}>{label}</Text>
                    <div style={{ fontSize: 10, color: '#999' }}>
                      {days === 0 ? '今日' : `${days}天前`}
                    </div>
                  </Tooltip>
                );
              },
            },
          ]}
        />
      )}
      <div style={{ marginTop: 12, fontSize: 11, color: '#999' }}>
        说明：每个策略取最新一次回测结果。夏普&gt;1.5 = 优秀，&gt;0.5 = 可用，&lt;0 = 亏损。回撤&gt;20% 高风险。
      </div>
    </Card>
  );
};

export default LeaderboardTab;
