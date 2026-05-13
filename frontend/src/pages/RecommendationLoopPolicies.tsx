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
  Modal,
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
  promotion_score?: number;
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

interface PromotionAdvice {
  action: string;
  confidence: number;
  recommended_style: string;
  recommended_min_score: number;
  recommended_default_position_pct: number;
  recommended_max_position_pct: number;
  recommended_paper_trade_limit: number;
  position_multiplier: number;
  best_snapshot?: any;
  best_style?: PolicyBucket;
  best_score_bucket?: PolicyBucket;
  best_position_bucket?: PolicyBucket;
  reasons: string[];
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
  rankings?: {
    snapshots: any[];
    by_style: PolicyBucket[];
    by_score_bucket: PolicyBucket[];
    by_position_bucket: PolicyBucket[];
    by_universe: PolicyBucket[];
  };
  promotion?: PromotionAdvice;
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

const actionLabel = (value?: string) => {
  const labels: Record<string, string> = {
    wait_for_snapshots: '等待版本样本',
    collect_samples: '继续小仓采样',
    scale_up: '小幅放大验证',
    tighten: '收紧评分/仓位',
    hold_and_compare: '保持参数对比',
  };
  return labels[value || ''] || value || '未生成';
};

const RecommendationLoopPolicies: React.FC = () => {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshingOutcomes, setRefreshingOutcomes] = useState(false);
  const [runningLoop, setRunningLoop] = useState(false);
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

  const runSafeLoop = async (mode: 'smoke' | 'promotion') => {
    const advice = dashboard?.promotion;
    const basePayload = {
      username: 'lym',
      universe: 'market',
      candidate_limit: mode === 'smoke' ? 5 : 12,
      candidate_pool_limit: mode === 'smoke' ? 80 : 180,
      archive_limit: mode === 'smoke' ? 5 : 12,
      run_paper_trading: mode !== 'smoke',
      dry_run: true,
      submit_agent_analysis: false,
      verify_signals: false,
      report_to_feishu: false,
      use_outcome_feedback: true,
      use_policy_version_feedback: true,
      use_entry_risk_guard: true,
      max_daily_new_positions: mode === 'smoke' ? 1 : 2,
      max_daily_new_exposure_pct: mode === 'smoke' ? 4 : 8,
      max_total_exposure_pct: 45,
      max_industry_exposure_pct: 20,
      min_avg_turnover_yuan: 30000000,
      cooldown_days_after_loss: 12,
      record_type: mode === 'smoke' ? '闭环安全烟测' : '策略晋级预演',
      task_label: mode === 'smoke' ? '闭环安全烟测' : '策略晋级预演',
    };
    const payload =
      mode === 'promotion' && advice
        ? {
            ...basePayload,
            style: advice.recommended_style || 'balanced',
            min_score: advice.recommended_min_score || 72,
            default_position_pct: advice.recommended_default_position_pct || 3,
            max_position_pct: advice.recommended_max_position_pct || 6,
            paper_trade_limit: advice.recommended_paper_trade_limit || 2,
          }
        : {
            ...basePayload,
            style: 'balanced',
            min_score: 72,
            default_position_pct: 3,
            max_position_pct: 6,
            paper_trade_limit: 1,
          };

    const title = mode === 'smoke' ? '执行闭环安全烟测？' : '用晋级建议执行小仓预演？';
    const content =
      mode === 'smoke'
        ? '本次只扫描小样本并生成策略快照，不提交 TradingAgents、不真实模拟买入，用于验证闭环链路。'
        : '本次会使用当前策略晋级建议进行模拟盘 dry-run 预演，并启用入场风控，不会真实成交。';

    Modal.confirm({
      title,
      content,
      okText: '开始执行',
      cancelText: '取消',
      onOk: async () => {
        setRunningLoop(true);
        try {
          const response = await api.post('/ai/recommendations/auto-loop', payload);
          if (response.data.success) {
            const data = response.data.data || {};
            message.success(
              `${basePayload.record_type}完成：归档 ${data.archive?.total || 0}，计划 ${
                data.paper_trading?.planned || 0
              }，快照 #${data.policy_snapshot?.id || '--'}`
            );
            await fetchDashboard(true);
          }
        } catch (error: any) {
          message.error(error.response?.data?.message || '执行自动荐股闭环失败');
        } finally {
          setRunningLoop(false);
        }
      },
    });
  };

  useEffect(() => {
    fetchDashboard(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, universe]);

  const summary = dashboard?.summary;
  const promotion = dashboard?.promotion;
  const snapshots = dashboard?.snapshots || [];
  const chartData = useMemo(() => dashboard?.groups?.by_style || [], [dashboard]);
  const topRankedVersions = useMemo(
    () => (dashboard?.rankings?.snapshots || []).slice(0, 5),
    [dashboard]
  );

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
          <Button
            icon={<ExperimentOutlined />}
            onClick={() => runSafeLoop('smoke')}
            loading={runningLoop}
          >
            闭环烟测
          </Button>
          <Button
            type="primary"
            icon={<SlidersOutlined />}
            onClick={() => runSafeLoop('promotion')}
            loading={runningLoop}
          >
            晋级预演
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
        <Col xs={24} lg={16}>
          <div className="loop-policy-promotion">
            <div>
              <div className="outcome-kicker">Next Policy Move</div>
              <h2>{actionLabel(promotion?.action)}</h2>
              <p>
                系统根据策略版本真实超额收益、闭环样本数和成交活跃度，给出下一轮全市场扫描的自动参数建议。
              </p>
              <Space wrap>
                <Tag color="cyan">风格：{styleLabel(promotion?.recommended_style)}</Tag>
                <Tag color="gold">评分≥{promotion?.recommended_min_score ?? '--'}</Tag>
                <Tag color="geekblue">
                  默认仓位 {formatPercent(promotion?.recommended_default_position_pct)}
                </Tag>
                <Tag color="purple">跟单 {promotion?.recommended_paper_trade_limit ?? '--'} 笔</Tag>
              </Space>
            </div>
            <div className="loop-policy-confidence">
              <span>CONFIDENCE</span>
              <strong>{Math.round(Number(promotion?.confidence || 0) * 100)}%</strong>
              <em>仓位倍率 {promotion?.position_multiplier ?? '--'}x</em>
            </div>
          </div>
        </Col>
        <Col xs={24} lg={8}>
          <div className="loop-policy-reasons">
            <div className="outcome-panel-title">
              <SlidersOutlined /> 晋级理由
            </div>
            {(promotion?.reasons || []).slice(0, 4).map((item, index) => (
              <div className="outcome-note" key={index}>
                {item}
              </div>
            ))}
            {!promotion?.reasons?.length && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无晋级建议" />
            )}
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

      <Row gutter={[18, 18]} style={{ marginBottom: 18 }}>
        <Col xs={24} lg={10}>
          <Card className="modern-card" variant="borderless" title="版本晋级榜">
            {topRankedVersions.length ? (
              <Space direction="vertical" style={{ width: '100%' }} size={10}>
                {topRankedVersions.map((item, index) => (
                  <div className="loop-policy-rank-row" key={item.id || index}>
                    <b>#{index + 1}</b>
                    <div>
                      <strong>版本 {item.id}</strong>
                      <span>
                        {styleLabel(item.effective_style)} · 评分≥{item.effective_min_score} · 闭环
                        {item.closed_trade_count || 0}
                      </span>
                    </div>
                    <em>{item.promotion_score}</em>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty description="暂无可排序版本" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card className="modern-card" variant="borderless" title="参数维度冠军">
            <Row gutter={[12, 12]}>
              {[
                [
                  '最佳风格',
                  promotion?.best_style?.label,
                  promotion?.best_style?.avg_outcome_excess_return_pct,
                ],
                [
                  '评分区间',
                  promotion?.best_score_bucket?.label,
                  promotion?.best_score_bucket?.avg_outcome_excess_return_pct,
                ],
                [
                  '仓位区间',
                  promotion?.best_position_bucket?.label,
                  promotion?.best_position_bucket?.avg_outcome_excess_return_pct,
                ],
              ].map(([label, name, excess]) => (
                <Col xs={24} md={8} key={String(label)}>
                  <div className="loop-policy-champion">
                    <span>{label}</span>
                    <strong>{name || '--'}</strong>
                    <em>均超额 {formatPercent(Number(excess || 0))}</em>
                  </div>
                </Col>
              ))}
            </Row>
          </Card>
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
