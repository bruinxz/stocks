/**
 * 策略排行 Tab — LabWorkspace 内嵌
 *
 * 展示所有策略的最新回测结果按 sharpe / annual_return / total_return 排序.
 * 每策略取最新一次 backtest。
 *
 * 数据来自 GET /api/quant/strategy-leaderboard.
 *
 * US-054 [FE-015]：每行追加「vs 沪深300 / vs 中证500 / vs 中证1000」3 列超额收益，
 * 让用户在排行榜直接看到策略相对各档主流基准的 alpha/excess。后端 response 的
 * `benchmark_attributions[]` 已经按 BENCHMARK_DISPLAY_ORDER 排好序，前端按 symbol 查表渲染。
 * 历史无归因的 run 显示 '—' (Tooltip 提示"暂无归因数据，请等待回测 hook 完成")。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Table, Tag, Space, Spin, Alert, Empty, Typography, Radio, Tooltip } from 'antd';
import { TrophyOutlined } from '@ant-design/icons';
import api from '../../services/api';

const { Text } = Typography;

/**
 * 与 backend BENCHMARK_DISPLAY_ORDER + BENCHMARK_NAME_MAP 同源。
 * 前端硬编码 3 列让 antd Table column 在 SSR / 空数据时仍有完整表头骨架。
 */
const BENCHMARK_COLUMNS: ReadonlyArray<{ symbol: string; label: string; short: string }> = [
  { symbol: 'sh.000300', label: '沪深300', short: 'HS300' },
  { symbol: 'sh.000905', label: '中证500', short: 'ZZ500' },
  { symbol: 'sh.000852', label: '中证1000', short: 'CSI1000' },
];

interface BenchmarkAttribution {
  benchmark_symbol: string;
  benchmark_name?: string;
  excess_return_pct: number | null;
  alpha_annual_pct: number | null;
  information_ratio: number | null;
  beta: number | null;
  sample_count: number;
  period_start: string | null;
  period_end: string | null;
}

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
  benchmark_attributions?: BenchmarkAttribution[];
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
    const color = redIfNeg ? (n >= 0 ? '#dc2626' : '#16a34a') : '#1677ff';
    return (
      <Text style={{ color, fontWeight: 500 }}>
        {n >= 0 ? '+' : ''}
        {n.toFixed(2)}%
      </Text>
    );
  };

  const sharpeRender = (v: any) => {
    const n = num(v);
    if (n == null) return <Text type="secondary">—</Text>;
    const color = n >= 1.5 ? '#dc2626' : n >= 0.5 ? '#fa8c16' : n >= 0 ? '#1677ff' : '#16a34a';
    return <Text style={{ color, fontWeight: 500 }}>{n.toFixed(2)}</Text>;
  };

  /**
   * 渲染单个基准 vs 列：超额（主数字）+ Tooltip 展示 alpha/IR/beta/sample.
   * 历史 run 无归因 → 渲染 '—' + Tooltip 解释（避免空白让用户以为是 bug）。
   *
   * 颜色映射：与 pctRender 红涨绿跌一致（A 股语义），让"红色 = 跑赢"直觉延续。
   */
  const benchmarkAttrRender = (
    row: LeaderboardItem,
    benchmarkSymbol: string,
    benchmarkLabel: string
  ) => {
    const attr = (row.benchmark_attributions || []).find(
      a => a.benchmark_symbol === benchmarkSymbol
    );
    if (!attr) {
      return (
        <Tooltip title={`暂无 ${benchmarkLabel} 归因数据（回测 hook 异步计算中或历史 run）`}>
          <Text type="secondary">—</Text>
        </Tooltip>
      );
    }
    const excess = attr.excess_return_pct;
    const tooltipContent = (
      <div style={{ fontSize: 12, lineHeight: 1.7 }}>
        <div>
          <strong>vs {benchmarkLabel}</strong>
        </div>
        <div>
          超额收益: {excess == null ? '—' : `${excess >= 0 ? '+' : ''}${excess.toFixed(2)}%`}
        </div>
        <div>
          年化 alpha:{' '}
          {attr.alpha_annual_pct == null
            ? '—'
            : `${attr.alpha_annual_pct >= 0 ? '+' : ''}${attr.alpha_annual_pct.toFixed(2)}%`}
        </div>
        <div>
          信息比率 (IR): {attr.information_ratio == null ? '—' : attr.information_ratio.toFixed(2)}
        </div>
        <div>beta: {attr.beta == null ? '—' : attr.beta.toFixed(2)}</div>
        <div>样本数: {attr.sample_count}</div>
        {attr.period_start && attr.period_end && (
          <div style={{ color: '#999', fontSize: 12 }}>
            区间: {attr.period_start} ~ {attr.period_end}
          </div>
        )}
      </div>
    );
    if (excess == null) {
      return (
        <Tooltip title={tooltipContent}>
          <Text type="secondary">—</Text>
        </Tooltip>
      );
    }
    // A 股语义: 红涨绿跌 — 跑赢 = 红
    const color = excess >= 0 ? '#dc2626' : '#16a34a';
    return (
      <Tooltip title={tooltipContent}>
        <Text style={{ color, fontWeight: 500 }}>
          {excess >= 0 ? '+' : ''}
          {excess.toFixed(2)}%
        </Text>
      </Tooltip>
    );
  };

  return (
    <Card
      title={
        <Space>
          <TrophyOutlined style={{ color: '#fa8c16' }} />
          <span>策略排行榜</span>
          <Tag color="blue">{items.length} 个策略</Tag>
        </Space>
      }
      extra={
        <Radio.Group size="small" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <Radio.Button value="sharpe">夏普比率</Radio.Button>
          <Radio.Button value="annual">年化收益</Radio.Button>
          <Radio.Button value="total">总收益</Radio.Button>
        </Radio.Group>
      }
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}

      {loading && !items.length ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
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
                const colors = ['#dc2626', '#fa8c16', '#fadb14', '#1677ff', '#1677ff'];
                const color = idx < 5 ? colors[Math.min(idx, 4)] : '#999';
                return (
                  <Text strong style={{ color, fontSize: 14 }}>
                    {idx + 1}
                  </Text>
                );
              },
            },
            {
              title: '策略',
              dataIndex: 'strategy_key',
              width: 230,
              render: (k: string) => (
                <div>
                  <Text strong>{nameMap.get(k) || k}</Text>
                  <div style={{ fontSize: 12, color: '#999' }}>{k}</div>
                </div>
              ),
            },
            {
              title: '夏普比率',
              dataIndex: 'sharpe_ratio',
              width: 90,
              align: 'right' as const,
              sorter: (a: LeaderboardItem, b: LeaderboardItem) =>
                (num(a.sharpe_ratio) ?? 0) - (num(b.sharpe_ratio) ?? 0),
              render: (v: any) => sharpeRender(v),
            },
            {
              title: '年化收益',
              dataIndex: 'annual_return_pct',
              width: 90,
              align: 'right' as const,
              sorter: (a: LeaderboardItem, b: LeaderboardItem) =>
                (num(a.annual_return_pct) ?? 0) - (num(b.annual_return_pct) ?? 0),
              render: (v: any) => pctRender(v),
            },
            {
              title: '总收益',
              dataIndex: 'total_return_pct',
              width: 90,
              align: 'right' as const,
              sorter: (a: LeaderboardItem, b: LeaderboardItem) =>
                (num(a.total_return_pct) ?? 0) - (num(b.total_return_pct) ?? 0),
              render: (v: any) => pctRender(v),
            },
            // US-054: vs HS300 / vs ZZ500 / vs CSI1000 — 超额收益 + Tooltip 展示 alpha/IR/beta/sample
            ...BENCHMARK_COLUMNS.map(bc => ({
              title: (
                <Tooltip title={`策略相对 ${bc.label} 的超额收益（hover 查 alpha / IR / beta）`}>
                  <span>vs {bc.short}</span>
                </Tooltip>
              ),
              key: `vs_${bc.symbol}`,
              width: 100,
              align: 'right' as const,
              sorter: (a: LeaderboardItem, b: LeaderboardItem) => {
                const va =
                  (a.benchmark_attributions || []).find(x => x.benchmark_symbol === bc.symbol)
                    ?.excess_return_pct ?? -Infinity;
                const vb =
                  (b.benchmark_attributions || []).find(x => x.benchmark_symbol === bc.symbol)
                    ?.excess_return_pct ?? -Infinity;
                return va - vb;
              },
              render: (_: any, row: LeaderboardItem) =>
                benchmarkAttrRender(row, bc.symbol, bc.label),
            })),
            {
              title: '最大回撤',
              dataIndex: 'max_drawdown_pct',
              width: 90,
              align: 'right' as const,
              sorter: (a: LeaderboardItem, b: LeaderboardItem) =>
                (num(a.max_drawdown_pct) ?? 0) - (num(b.max_drawdown_pct) ?? 0),
              render: (v: any) => {
                const n = num(v);
                if (n == null) return <Text type="secondary">—</Text>;
                const color =
                  Math.abs(n) > 20 ? '#dc2626' : Math.abs(n) > 10 ? '#fa8c16' : '#16a34a';
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
                const color = pct >= 60 ? '#dc2626' : pct >= 50 ? '#fa8c16' : '#16a34a';
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
                    <Text style={{ fontSize: 12 }}>{label}</Text>
                    <div style={{ fontSize: 12, color: '#999' }}>
                      {days === 0 ? '今日' : `${days}天前`}
                    </div>
                  </Tooltip>
                );
              },
            },
          ]}
        />
      )}
      <div style={{ marginTop: 12, fontSize: 12, color: '#999' }}>
        说明：每个策略取最新一次回测结果。夏普&gt;1.5 = 优秀，&gt;0.5 = 可用，&lt;0 =
        亏损。回撤&gt;20% 高风险。
      </div>
    </Card>
  );
};

export default LeaderboardTab;
