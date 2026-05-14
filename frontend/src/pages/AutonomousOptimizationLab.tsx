import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  ApartmentOutlined,
  BranchesOutlined,
  CloudSyncOutlined,
  ExperimentOutlined,
  FireOutlined,
  LineChartOutlined,
  NodeIndexOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SlidersOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Link } from 'react-router-dom';
import { getAutonomousOptimization } from '../services/api';

const { Text, Paragraph } = Typography;

interface HorizonPath {
  horizon: string;
  horizon_days: number;
  count: number;
  avg_directional_return_pct: number;
  avg_excess_return_pct: number;
  win_rate: number;
  excess_win_rate: number;
}

interface SymbolPath {
  symbol: string;
  name?: string;
  latest_signal_date?: string;
  trade_status?: string;
  score?: number;
  avg_directional_return_pct: number;
  avg_excess_return_pct: number;
  best_horizon?: string;
  best_horizon_return_pct?: number;
  worst_horizon?: string;
  worst_horizon_return_pct?: number;
  path: Array<{
    horizon: string;
    horizon_days: number;
    directional_return_pct: number;
    excess_return_pct: number;
  }>;
}

interface EnvironmentPolicySegment {
  dimension?: string;
  key: string;
  label: string;
  closed_count: number;
  sample_confidence?: number;
  avg_excess_return_pct: number;
  excess_win_rate?: number;
  bayesian_win_rate?: number;
  robust_score?: number;
  risk_adjusted_excess_return_pct?: number;
  action: 'block' | 'reduce' | 'boost' | 'watch' | string;
  position_multiplier: number;
  reason: string;
}

interface EnvironmentLoopPolicy {
  enabled: boolean;
  confidence: number;
  closed_samples: number;
  default_position_multiplier: number;
  blocked_segments: EnvironmentPolicySegment[];
  reduced_segments: EnvironmentPolicySegment[];
  boosted_segments: EnvironmentPolicySegment[];
  watch_segments: EnvironmentPolicySegment[];
  rules?: string[];
  reason?: string;
}

interface EnvironmentRanking {
  key: string;
  label: string;
  closed_count: number;
  avg_excess_return_pct: number;
  excess_win_rate: number;
  robust_score?: number;
  bayesian_win_rate?: number;
  dimension?: string;
}

interface OptimizationData {
  generated_at: string;
  portfolio: {
    id: number;
    name: string;
    initial_capital: number;
    total_value: number;
    current_cash: number;
  };
  summary: {
    total_count: number;
    open_count: number;
    closed_count: number;
    total_pnl: number;
    avg_excess_return_pct: number;
    win_rate: number;
    excess_win_rate: number;
    avg_holding_days: number;
  };
  horizon_path: HorizonPath[];
  symbol_paths: SymbolPath[];
  adaptive_risk: {
    recommended_max_hold_days: number;
    recommended_stop_loss_pct: number;
    recommended_take_profit_pct: number;
    recommended_trailing_activation_pct?: number;
    recommended_trailing_drawdown_pct?: number;
    current_open_avg_holding_days: number;
    closed_avg_holding_days: number;
    sample_count?: number;
    confidence?: number;
    mode?: string;
    reason?: string;
    best_horizon?: HorizonPath | null;
  };
  next_policy: {
    recommended_style: string;
    recommended_min_score: number;
    recommended_default_position_pct: number;
    recommended_max_position_pct: number;
    recommended_paper_trade_limit: number;
    confidence: number;
    action: string;
    reasons: string[];
    environment_position_multiplier?: number;
    environment_confidence?: number;
    environment_blocked_segments?: EnvironmentPolicySegment[];
    environment_reduced_segments?: EnvironmentPolicySegment[];
    environment_boosted_segments?: EnvironmentPolicySegment[];
  };
  segment_actions: {
    boost: Array<any>;
    reduce: Array<any>;
  };
  policy_versions?: {
    summary?: Record<string, any>;
    promotion?: Record<string, any>;
    top_versions?: Array<any>;
  } | null;
  environment_policy?: EnvironmentLoopPolicy;
  market_environment?: {
    market_regime_rankings?: EnvironmentRanking[];
    industry_regime_rankings?: EnvironmentRanking[];
    policy?: EnvironmentLoopPolicy;
  };
  insights: string[];
}

const formatMoney = (value?: number | null) =>
  `¥${Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatPercent = (value?: number | null) => `${Number(value || 0).toFixed(2)}%`;
const pnlColor = (value?: number | null) => (Number(value || 0) >= 0 ? '#d14343' : '#008f6b');

const environmentActionLabel = (value?: string) => {
  const labels: Record<string, string> = {
    block: '暂停入场',
    reduce: '降仓验证',
    boost: '小幅放大',
    watch: '继续观察',
  };
  return labels[value || ''] || value || '观察';
};

const environmentActionColor = (value?: string) => {
  const colors: Record<string, string> = {
    block: 'red',
    reduce: 'orange',
    boost: 'gold',
    watch: 'blue',
  };
  return colors[value || ''] || 'default';
};

const styleLabel = (value?: string) => {
  const labels: Record<string, string> = {
    balanced: '均衡',
    momentum: '动量',
    value: '价值',
    low_risk: '低风险',
  };
  return labels[value || ''] || value || '未标注';
};

const actionLabel = (value?: string) => {
  const labels: Record<string, string> = {
    wait_for_snapshots: '等待样本',
    collect_samples: '继续采样',
    scale_up: '小幅放大',
    tighten: '收紧参数',
    hold_and_compare: '保持对比',
  };
  return labels[value || ''] || value || '观察';
};

const AutonomousOptimizationLab: React.FC = () => {
  const [data, setData] = useState<OptimizationData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = async (silent = false) => {
    setLoading(true);
    try {
      const response = await getAutonomousOptimization({
        lookback_days: 180,
        horizons: '1d,3d,5d,10d,20d',
        limit: 2000,
      });
      if (response.data.success) {
        setData(response.data.data);
        if (!silent) message.success('自主闭环优化台已刷新');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取自主闭环优化台失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const horizonChart = useMemo(() => data?.horizon_path || [], [data]);
  const pathCurve = useMemo(() => {
    const best = [...(data?.symbol_paths || [])]
      .sort((a, b) => b.avg_directional_return_pct - a.avg_directional_return_pct)
      .slice(0, 5);
    return best.flatMap(item =>
      item.path.map(point => ({
        ...point,
        symbol: item.symbol,
        name: item.name || item.symbol,
      }))
    );
  }, [data]);
  const environmentPolicy = data?.environment_policy || data?.market_environment?.policy;
  const environmentActionSegments = useMemo(
    () =>
      [
        ...(environmentPolicy?.blocked_segments || []),
        ...(environmentPolicy?.reduced_segments || []),
        ...(environmentPolicy?.boosted_segments || []),
        ...(environmentPolicy?.watch_segments || []).slice(0, 3),
      ].slice(0, 8),
    [environmentPolicy]
  );
  const environmentRankings = useMemo(
    () =>
      [
        ...(data?.market_environment?.market_regime_rankings || []).map(item => ({
          ...item,
          dimension_label: '大盘',
        })),
        ...(data?.market_environment?.industry_regime_rankings || []).map(item => ({
          ...item,
          dimension_label: '行业',
        })),
      ].slice(0, 10),
    [data]
  );

  const symbolColumns = [
    {
      title: '标的',
      key: 'symbol',
      fixed: 'left' as const,
      width: 190,
      render: (_: any, record: SymbolPath) => (
        <Space direction="vertical" size={2}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary" className="mono-text">
            {record.symbol} · {record.latest_signal_date || '-'}
          </Text>
          <Tag color={record.trade_status === 'closed' ? 'purple' : 'cyan'}>
            {record.trade_status === 'closed' ? '已闭环' : '持仓/观察'}
          </Tag>
        </Space>
      ),
    },
    {
      title: '路径表现',
      key: 'path',
      width: 260,
      render: (_: any, record: SymbolPath) => (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Text strong style={{ color: pnlColor(record.avg_directional_return_pct) }}>
            平均方向收益 {formatPercent(record.avg_directional_return_pct)}
          </Text>
          <Progress
            percent={Math.max(
              0,
              Math.min(100, 50 + Number(record.avg_directional_return_pct || 0) * 5)
            )}
            showInfo={false}
            size="small"
            strokeColor={pnlColor(record.avg_directional_return_pct)}
          />
          <Text type="secondary">平均超额 {formatPercent(record.avg_excess_return_pct)}</Text>
        </Space>
      ),
    },
    {
      title: '最佳/最弱周期',
      key: 'horizon',
      width: 180,
      render: (_: any, record: SymbolPath) => (
        <Space direction="vertical" size={2}>
          <Tag color="gold">
            最佳 {record.best_horizon || '--'} / {formatPercent(record.best_horizon_return_pct)}
          </Tag>
          <Tag color="green">
            最弱 {record.worst_horizon || '--'} / {formatPercent(record.worst_horizon_return_pct)}
          </Tag>
        </Space>
      ),
    },
  ];

  return (
    <div className="autonomous-page autonomous-optimization-page fade-in-up">
      <div className="optimization-hero">
        <div className="optimization-hero-copy">
          <div className="autonomous-kicker">AUTONOMOUS LOOP OPTIMIZER</div>
          <h1>自主荐股闭环优化台</h1>
          <Paragraph>
            聚合 20W
            自主模拟盘的交易结果、推荐后收益路径、策略版本晋级建议和风控参数建议，让下一轮自动荐股有明确的调参依据。
          </Paragraph>
          <Space wrap>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => fetchData()}
            >
              刷新优化台
            </Button>
            <Link to="/autonomous-trading/overview">
              <Button icon={<LineChartOutlined />}>收益驾驶舱</Button>
            </Link>
            <Link to="/recommendation-loop-policies">
              <Button icon={<BranchesOutlined />}>策略版本实验室</Button>
            </Link>
          </Space>
        </div>
        <div className="optimization-next-card">
          <span>NEXT POLICY</span>
          <strong>{styleLabel(data?.next_policy?.recommended_style)}</strong>
          <em>
            评分≥{data?.next_policy?.recommended_min_score || '--'} · 仓位{' '}
            {formatPercent(data?.next_policy?.recommended_default_position_pct)}
          </em>
          <div className="optimization-env-strip">
            <CloudSyncOutlined />
            环境倍率 {data?.next_policy?.environment_position_multiplier || '--'}x · 置信度{' '}
            {Math.round(Number(data?.next_policy?.environment_confidence || 0) * 100)}%
          </div>
        </div>
      </div>

      <Row gutter={[16, 16]} className="optimization-metrics">
        <Col xs={24} sm={12} xl={5}>
          <Card className="autonomous-metric-card gold" loading={loading}>
            <TrophyOutlined />
            <span>总盈亏</span>
            <strong style={{ color: pnlColor(data?.summary.total_pnl) }}>
              {formatMoney(data?.summary.total_pnl)}
            </strong>
            <em>
              闭环 {data?.summary.closed_count || 0}/{data?.summary.total_count || 0} 笔
            </em>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={5}>
          <Card className="autonomous-metric-card cyan" loading={loading}>
            <NodeIndexOutlined />
            <span>超额胜率</span>
            <strong>{formatPercent(data?.summary.excess_win_rate)}</strong>
            <em>平均超额 {formatPercent(data?.summary.avg_excess_return_pct)}</em>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={5}>
          <Card className="autonomous-metric-card blue" loading={loading}>
            <SafetyCertificateOutlined />
            <span>风控参数</span>
            <strong>{data?.adaptive_risk.recommended_max_hold_days || 20} 天</strong>
            <em>
              止损 {formatPercent(data?.adaptive_risk.recommended_stop_loss_pct)} / 止盈{' '}
              {formatPercent(data?.adaptive_risk.recommended_take_profit_pct)} / 移动{' '}
              {formatPercent(data?.adaptive_risk.recommended_trailing_activation_pct)}/
              {formatPercent(data?.adaptive_risk.recommended_trailing_drawdown_pct)}
            </em>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={5}>
          <Card className="autonomous-metric-card green" loading={loading}>
            <ExperimentOutlined />
            <span>晋级置信度</span>
            <strong>{Math.round(Number(data?.next_policy.confidence || 0) * 100)}%</strong>
            <em>
              {actionLabel(data?.next_policy.action)} · 跟单{' '}
              {data?.next_policy.recommended_paper_trade_limit || '--'} 笔
            </em>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <Card className="autonomous-metric-card cyan" loading={loading}>
            <CloudSyncOutlined />
            <span>环境闸门</span>
            <strong>{environmentPolicy?.default_position_multiplier || '--'}x</strong>
            <em>
              暂停 {environmentPolicy?.blocked_segments?.length || 0} · 降仓{' '}
              {environmentPolicy?.reduced_segments?.length || 0} · 放大{' '}
              {environmentPolicy?.boosted_segments?.length || 0}
            </em>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card
            className="modern-card optimization-chart-card"
            title="推荐后收益路径"
            loading={loading}
          >
            {horizonChart.length ? (
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={horizonChart} margin={{ top: 12, right: 18, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(226,236,247,.16)" />
                    <XAxis dataKey="horizon" stroke="rgba(226,236,247,.62)" />
                    <YAxis stroke="rgba(226,236,247,.62)" />
                    <RechartsTooltip
                      formatter={(value: any, name: string) => [formatPercent(Number(value)), name]}
                    />
                    <Bar
                      dataKey="avg_directional_return_pct"
                      name="平均方向收益"
                      radius={[10, 10, 0, 0]}
                    >
                      {horizonChart.map((item, index) => (
                        <Cell
                          key={index}
                          fill={item.avg_directional_return_pct >= 0 ? '#d6a64f' : '#008f6b'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Empty description="暂无完成的收益路径样本" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card
            className="modern-card optimization-intel-card"
            title="下一轮调参结论"
            loading={loading}
          >
            <div className="optimization-policy-card">
              <span>推荐动作</span>
              <strong>{actionLabel(data?.next_policy.action)}</strong>
              <p>
                {styleLabel(data?.next_policy.recommended_style)} · 评分≥
                {data?.next_policy.recommended_min_score || '--'} · 单票
                {formatPercent(data?.next_policy.recommended_default_position_pct)} / max{' '}
                {formatPercent(data?.next_policy.recommended_max_position_pct)}
              </p>
            </div>
            <div className="optimization-notes">
              {(data?.insights || []).map((item, index) => (
                <div key={index} className="outcome-note">
                  {item}
                </div>
              ))}
              {!data?.insights?.length && <Empty description="暂无闭环洞察" />}
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>
          <Card
            className="modern-card optimization-env-card"
            title={
              <Space>
                <CloudSyncOutlined /> 环境闸门策略
              </Space>
            }
            loading={loading}
          >
            <div className="optimization-policy-card environment">
              <span>ENVIRONMENT GATE</span>
              <strong>{environmentPolicy?.default_position_multiplier || '--'}x</strong>
              <p>
                {environmentPolicy?.reason ||
                  '根据大盘/行业环境闭环收益，自动决定暂停、降仓或小幅放大。'}
              </p>
            </div>
            <div className="optimization-env-actions">
              {environmentActionSegments.map((item, index) => (
                <div className={`optimization-env-segment ${item.action}`} key={index}>
                  <div>
                    <strong>{item.label}</strong>
                    <span>
                      {item.reason} · 样本 {item.closed_count}
                    </span>
                  </div>
                  <Space size={6} wrap>
                    <Tag color={environmentActionColor(item.action)}>
                      {environmentActionLabel(item.action)}
                    </Tag>
                    <Tag color="geekblue">{item.position_multiplier}x</Tag>
                  </Space>
                </div>
              ))}
              {!environmentActionSegments.length && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无环境动作样本" />
              )}
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card
            className="modern-card optimization-env-card"
            title="市场 / 行业环境表现矩阵"
            loading={loading}
          >
            <div className="optimization-env-ranking">
              {environmentRankings.map((item, index) => (
                <div className="optimization-env-row" key={`${item.dimension_label}-${item.key}`}>
                  <div className="optimization-env-rank">{index + 1}</div>
                  <div className="optimization-env-main">
                    <Space size={8} wrap>
                      <Tag color={item.dimension_label === '大盘' ? 'cyan' : 'purple'}>
                        {item.dimension_label}
                      </Tag>
                      <Text strong>{item.label}</Text>
                    </Space>
                    <Progress
                      percent={Math.max(0, Math.min(100, 50 + Number(item.robust_score || 0) * 4))}
                      showInfo={false}
                      size="small"
                      strokeColor={pnlColor(item.avg_excess_return_pct)}
                    />
                  </div>
                  <div className="optimization-env-stat">
                    <strong style={{ color: pnlColor(item.avg_excess_return_pct) }}>
                      {formatPercent(item.avg_excess_return_pct)}
                    </strong>
                    <span>
                      超额胜率 {formatPercent(item.excess_win_rate)} · 稳健分{' '}
                      {Number(item.robust_score || 0).toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
              {!environmentRankings.length && <Empty description="暂无环境归因样本" />}
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>
          <Card
            className="modern-card optimization-path-card"
            title="优先放大 / 降权片段"
            loading={loading}
          >
            <div className="optimization-segment-list">
              <div>
                <div className="outcome-panel-title">
                  <FireOutlined /> 优先放大
                </div>
                {(data?.segment_actions.boost || []).map((item, index) => (
                  <div className="optimization-segment boost" key={index}>
                    <strong>{item.label}</strong>
                    <span>
                      闭环 {item.closed_count} · 超额 {formatPercent(item.avg_excess_return_pct)}
                    </span>
                  </div>
                ))}
                {!data?.segment_actions.boost?.length && (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无放大片段" />
                )}
              </div>
              <div>
                <div className="outcome-panel-title">
                  <SlidersOutlined /> 需要降权
                </div>
                {(data?.segment_actions.reduce || []).map((item, index) => (
                  <div className="optimization-segment reduce" key={index}>
                    <strong>{item.label}</strong>
                    <span>
                      闭环 {item.closed_count} · 超额 {formatPercent(item.avg_excess_return_pct)}
                    </span>
                  </div>
                ))}
                {!data?.segment_actions.reduce?.length && (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无降权片段" />
                )}
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card
            className="modern-card optimization-chart-card"
            title="头部标的收益路径"
            loading={loading}
          >
            {pathCurve.length ? (
              <div style={{ height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={pathCurve} margin={{ top: 12, right: 18, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(226,236,247,.16)" />
                    <XAxis dataKey="horizon" stroke="rgba(226,236,247,.62)" />
                    <YAxis stroke="rgba(226,236,247,.62)" />
                    <RechartsTooltip
                      formatter={(value: any, name: string, item: any) => [
                        formatPercent(Number(value)),
                        `${item.payload?.name || item.payload?.symbol} ${name}`,
                      ]}
                    />
                    <Area
                      type="monotone"
                      dataKey="directional_return_pct"
                      name="方向收益"
                      stroke="#d6a64f"
                      fill="rgba(214,166,79,.22)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Empty description="暂无标的路径样本" />
            )}
          </Card>
        </Col>
      </Row>

      <Card
        className="modern-card table-card-no-padding"
        title={
          <Space>
            <ApartmentOutlined /> 标的路径明细
          </Space>
        }
        loading={loading}
      >
        <Table
          rowKey="symbol"
          columns={symbolColumns}
          dataSource={data?.symbol_paths || []}
          pagination={{ pageSize: 10, showSizeChanger: true }}
          scroll={{ x: 760 }}
          locale={{ emptyText: <Empty description="暂无标的收益路径" /> }}
        />
      </Card>

      <Alert
        className="autonomous-alert"
        showIcon
        type="info"
        message="闭环原则"
        description="优化台只根据模拟盘和后验收益给出下一轮参数建议，不代表真实账户交易指令。样本不足时优先小仓采样，连续跑输的片段会被降权或暂停自动放大。"
      />
    </div>
  );
};

export default AutonomousOptimizationLab;
