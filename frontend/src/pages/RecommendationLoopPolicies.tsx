import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  ExperimentOutlined,
  FireOutlined,
  NodeIndexOutlined,
  ReloadOutlined,
  SlidersOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import api from '../services/api';

const { Text } = Typography;

interface PolicyBucket {
  key: string;
  label: string;
  count: number;
  executed: number;
  planned: number;
  avg_min_score: number;
  avg_position_pct: number;
  avg_policy_excess_return_pct: number;
  avg_outcome_excess_return_pct: number;
  latest_generated_at?: string;
}

interface PolicySnapshot {
  id: number;
  generated_at: string;
  loop_run_id?: string;
  record_type?: string;
  username?: string;
  universe: string;
  base_style?: string;
  effective_style?: string;
  base_min_score?: number;
  effective_min_score?: number;
  effective_default_position_pct?: number;
  effective_max_position_pct?: number;
  effective_paper_trade_limit?: number;
  closed_samples?: number;
  min_closed_samples?: number;
  policy_avg_excess_return_pct?: number;
  policy_excess_win_rate?: number;
  position_multiplier?: number;
  generated_total_candidates?: number;
  analyzed_candidates?: number;
  archive_total?: number;
  agent_submitted?: number;
  paper_executed?: number;
  paper_planned?: number;
  paper_skipped?: number;
  tracked_trade_count?: number;
  closed_trade_count?: number;
  total_pnl?: number;
  avg_excess_return_pct?: number;
  excess_win_rate?: number;
  policy_reason?: string;
}

interface Dashboard {
  generated_at: string;
  count: number;
  summary: {
    run_count: number;
    executed_run_count: number;
    total_executed: number;
    total_planned: number;
    avg_effective_min_score: number;
    avg_default_position_pct: number;
    avg_policy_excess_return_pct: number;
    avg_outcome_excess_return_pct: number;
    latest_policy?: PolicySnapshot;
    best_snapshot?: PolicySnapshot;
    most_active_snapshot?: PolicySnapshot;
  };
  groups: {
    by_style: PolicyBucket[];
    by_universe: PolicyBucket[];
    by_score_bucket: PolicyBucket[];
    by_position_bucket: PolicyBucket[];
  };
  snapshots: PolicySnapshot[];
  insights: string[];
}

const styleLabel = (value?: string) => {
  const labels: Record<string, string> = {
    balanced: '均衡',
    momentum: '动量',
    value: '价值',
    low_risk: '低风险',
  };
  return labels[value || ''] || value || '未标注';
};

const formatPercent = (value?: number | null) => `${Number(value || 0).toFixed(2)}%`;
const formatMoney = (value?: number | null) =>
  `¥${Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
const pnlColor = (value?: number | null) => (Number(value || 0) >= 0 ? '#d14343' : '#008f6b');

const RecommendationLoopPolicies: React.FC = () => {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshingOutcomes, setRefreshingOutcomes] = useState(false);
  const [style, setStyle] = useState('all');
  const [universe, setUniverse] = useState('all');

  const fetchDashboard = async (silent = false) => {
    setLoading(true);
    try {
      const response = await api.get('/ai/recommendations/loop-policy-snapshots', {
        params: { style, universe, limit: 120 },
      });
      if (response.data.success) {
        setDashboard(response.data.data);
        if (!silent) message.success('策略参数快照已刷新');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取策略参数快照失败');
    } finally {
      setLoading(false);
    }
  };

  const refreshOutcomeMetrics = async () => {
    setRefreshingOutcomes(true);
    try {
      const response = await api.post(
        '/ai/recommendations/loop-policy-snapshots/refresh-outcomes',
        {
          limit: 200,
        }
      );
      if (response.data.success) {
        message.success(response.data.message || '策略版本收益已回填');
        await fetchDashboard(true);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '刷新策略版本收益失败');
    } finally {
      setRefreshingOutcomes(false);
    }
  };

  useEffect(() => {
    fetchDashboard(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, universe]);

  const summary = dashboard?.summary;
  const snapshots = dashboard?.snapshots || [];
  const chartData = useMemo(() => dashboard?.groups?.by_style || [], [dashboard]);

  const columns = [
    {
      title: '版本 / 时间',
      key: 'version',
      fixed: 'left' as const,
      width: 230,
      render: (_: any, record: PolicySnapshot) => (
        <Space direction="vertical" size={2}>
          <Text strong>#{record.id}</Text>
          {record.loop_run_id && (
            <Text code copyable style={{ fontSize: 11 }}>
              {record.loop_run_id}
            </Text>
          )}
          <Text type="secondary">
            {String(record.generated_at || '')
              .slice(0, 19)
              .replace('T', ' ')}
          </Text>
          {record.record_type && <Tag>{record.record_type}</Tag>}
        </Space>
      ),
    },
    {
      title: '策略参数',
      width: 220,
      render: (_: any, record: PolicySnapshot) => (
        <Space direction="vertical" size={4}>
          <Space wrap size={4}>
            <Tag color="cyan">
              {styleLabel(record.base_style)} → {styleLabel(record.effective_style)}
            </Tag>
            <Tag color="gold">评分≥{record.effective_min_score ?? '--'}</Tag>
          </Space>
          <Text type="secondary">
            仓位 {record.effective_default_position_pct ?? '--'}% / max{' '}
            {record.effective_max_position_pct ?? '--'}%，跟单{' '}
            {record.effective_paper_trade_limit ?? '--'}
          </Text>
        </Space>
      ),
    },
    {
      title: '样本状态',
      width: 150,
      render: (_: any, record: PolicySnapshot) => (
        <Space direction="vertical" size={2}>
          <Text>
            闭环样本 {record.closed_samples || 0}/{record.min_closed_samples || 5}
          </Text>
          <Text type="secondary">
            策略超额 {formatPercent(record.policy_avg_excess_return_pct)}
          </Text>
        </Space>
      ),
    },
    {
      title: '本轮处理',
      width: 170,
      render: (_: any, record: PolicySnapshot) => (
        <Space direction="vertical" size={2}>
          <Text>
            候选 {record.analyzed_candidates || 0}/{record.generated_total_candidates || 0}
          </Text>
          <Text type="secondary">
            Agent {record.agent_submitted || 0} · 归档 {record.archive_total || 0}
          </Text>
        </Space>
      ),
    },
    {
      title: '模拟盘',
      width: 150,
      render: (_: any, record: PolicySnapshot) => (
        <Space direction="vertical" size={2}>
          <Text>
            成交 {record.paper_executed || 0} / 计划 {record.paper_planned || 0}
          </Text>
          <Text type="secondary">跳过 {record.paper_skipped || 0}</Text>
        </Space>
      ),
    },
    {
      title: '闭环收益',
      width: 170,
      render: (_: any, record: PolicySnapshot) => (
        <Space direction="vertical" size={2}>
          <Text strong style={{ color: pnlColor(record.total_pnl) }}>
            {formatMoney(record.total_pnl)}
          </Text>
          <Text style={{ color: pnlColor(record.avg_excess_return_pct) }}>
            超额 {formatPercent(record.avg_excess_return_pct)} / 胜率{' '}
            {formatPercent(record.excess_win_rate)}
          </Text>
        </Space>
      ),
    },
    {
      title: '参数原因',
      dataIndex: 'policy_reason',
      width: 360,
      render: (text: string) => text || '-',
    },
  ];

  return (
    <div className="loop-policy-page fade-in-up">
      <div className="loop-policy-hero">
        <div>
          <div className="outcome-kicker">Policy Version Lab</div>
          <h1>策略参数版本实验室</h1>
          <p>
            把每次全市场荐股闭环实际采用的评分、风格、仓位和跟单数量沉淀为版本快照，后续用真实模拟收益比较哪套参数更会赚钱。
          </p>
          <Space wrap>
            <Tag icon={<NodeIndexOutlined />}>Loop Policy Snapshot</Tag>
            <Tag icon={<ExperimentOutlined />}>Versioned Parameters</Tag>
            <Tag icon={<TrophyOutlined />}>Outcome Attribution</Tag>
          </Space>
        </div>
        <div className="loop-policy-hero-card">
          <span>策略版本</span>
          <strong>{summary?.run_count || 0}</strong>
          <em>累计成交 {summary?.total_executed || 0} 笔</em>
        </div>
      </div>

      <Card className="modern-card loop-policy-filter" variant="borderless">
        <Space wrap>
          <Select value={universe} onChange={setUniverse} style={{ width: 150 }}>
            <Select.Option value="all">全部范围</Select.Option>
            <Select.Option value="market">全市场</Select.Option>
            <Select.Option value="favorites">自选池</Select.Option>
          </Select>
          <Select value={style} onChange={setStyle} style={{ width: 150 }}>
            <Select.Option value="all">全部风格</Select.Option>
            <Select.Option value="balanced">均衡</Select.Option>
            <Select.Option value="momentum">动量</Select.Option>
            <Select.Option value="value">价值</Select.Option>
            <Select.Option value="low_risk">低风险</Select.Option>
          </Select>
          <Button icon={<ReloadOutlined />} onClick={() => fetchDashboard(false)} loading={loading}>
            刷新
          </Button>
          <Button
            icon={<NodeIndexOutlined />}
            onClick={refreshOutcomeMetrics}
            loading={refreshingOutcomes}
          >
            回填收益
          </Button>
          <Text type="secondary">最后生成：{dashboard?.generated_at || '--'}</Text>
        </Space>
      </Card>

      <Row gutter={[18, 18]} style={{ marginBottom: 18 }}>
        <Col xs={12} lg={6}>
          <div className="loop-policy-tile">
            <span>版本数</span>
            <strong>{summary?.run_count || 0}</strong>
            <em>已执行版本 {summary?.executed_run_count || 0}</em>
          </div>
        </Col>
        <Col xs={12} lg={6}>
          <div className="loop-policy-tile">
            <span>平均评分</span>
            <strong>{summary?.avg_effective_min_score || 0}</strong>
            <em>平均仓位 {formatPercent(summary?.avg_default_position_pct)}</em>
          </div>
        </Col>
        <Col xs={12} lg={6}>
          <div className="loop-policy-tile">
            <span>累计成交</span>
            <strong>{summary?.total_executed || 0}</strong>
            <em>计划 {summary?.total_planned || 0}</em>
          </div>
        </Col>
        <Col xs={12} lg={6}>
          <div className="loop-policy-tile hot">
            <span>平均超额</span>
            <strong>{formatPercent(summary?.avg_outcome_excess_return_pct)}</strong>
            <em>策略基线 {formatPercent(summary?.avg_policy_excess_return_pct)}</em>
          </div>
        </Col>
      </Row>

      <Row gutter={[18, 18]} style={{ marginBottom: 18 }}>
        <Col xs={24} lg={15}>
          <Card className="modern-card" variant="borderless" title="不同风格版本表现">
            {chartData.length ? (
              <div style={{ height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ left: 8, right: 18, top: 12, bottom: 0 }}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="rgba(15,23,42,.08)"
                    />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} />
                    <YAxis tickLine={false} axisLine={false} />
                    <RechartsTooltip
                      formatter={(value: number) => [
                        `${Number(value).toFixed(2)}%`,
                        '平均闭环超额',
                      ]}
                    />
                    <Bar dataKey="avg_outcome_excess_return_pct" radius={[10, 10, 0, 0]}>
                      {chartData.map((item, index) => (
                        <Cell
                          key={index}
                          fill={item.avg_outcome_excess_return_pct >= 0 ? '#d6a64f' : '#008f6b'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Empty description="暂无风格版本样本" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={9}>
          <div className="loop-policy-insight-panel">
            <div className="outcome-panel-title">
              <FireOutlined /> 参数复盘结论
            </div>
            {(dashboard?.insights || []).map((item, index) => (
              <div className="outcome-note" key={index}>
                {item}
              </div>
            ))}
            {!dashboard?.insights?.length && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无洞察" />
            )}
          </div>
        </Col>
      </Row>

      <Card
        className="modern-card table-card-no-padding"
        variant="borderless"
        title="策略参数版本明细"
      >
        <Table
          columns={columns}
          dataSource={snapshots}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10, showSizeChanger: true }}
          scroll={{ x: 1410 }}
          locale={{ emptyText: <Empty description="暂无策略快照，等待下一次全市场荐股闭环执行" /> }}
        />
      </Card>

      <Alert
        style={{ marginTop: 18 }}
        type="info"
        showIcon
        icon={<SlidersOutlined />}
        message="如何使用"
        description="当某个评分阈值、推荐风格或仓位版本持续取得正超额，可以逐步放大；连续跑输的版本会在后续闭环中自动提高评分、缩仓或切换风格。"
      />
    </div>
  );
};

export default RecommendationLoopPolicies;
