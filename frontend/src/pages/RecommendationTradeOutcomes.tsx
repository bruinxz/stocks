import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  message,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ApartmentOutlined,
  ArrowRightOutlined,
  BarChartOutlined,
  CloudUploadOutlined,
  ExperimentOutlined,
  FireOutlined,
  FundProjectionScreenOutlined,
  LineChartOutlined,
  NodeIndexOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
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
import api from '../services/api';
import TradePolicyExplainPanel from '../components/trading/TradePolicyExplainPanel';

const { Text } = Typography;

interface OutcomeBucket {
  key: string;
  label: string;
  count: number;
  open_count: number;
  closed_count: number;
  win_rate: number;
  excess_win_rate: number;
  avg_return_pct: number;
  avg_excess_return_pct: number;
  total_pnl: number;
  profit_factor: number;
  avg_holding_days: number;
  best_symbol?: string;
  best_name?: string;
  best_return_pct?: number;
  worst_symbol?: string;
  worst_name?: string;
  worst_return_pct?: number;
  avg_consensus_count?: number;
  avg_consensus_bonus?: number;
  robust_score?: number;
  bayesian_win_rate?: number;
  risk_adjusted_excess_return_pct?: number;
  sample_confidence?: number;
  dimension?: string;
}

interface TradeOutcome {
  id: number;
  signal_id: number;
  source_type: string;
  source_id: string;
  symbol: string;
  name?: string;
  signal_date: string;
  decision?: string;
  score?: number;
  risk_level?: string;
  action?: string;
  action_label?: string;
  agent_session?: string;
  recommendation_style?: string;
  recommendation_source?: string;
  industry?: string;
  trade_status: 'open' | 'closed';
  entry_date?: string;
  exit_date?: string;
  entry_price?: number;
  exit_price?: number;
  latest_price?: number;
  quantity?: number;
  position_pct?: number;
  entry_amount?: number;
  exit_amount?: number;
  realized_pnl?: number;
  realized_pnl_pct?: number;
  unrealized_pnl?: number;
  unrealized_pnl_pct?: number;
  total_pnl?: number;
  total_pnl_pct?: number;
  max_favorable_excursion_pct?: number;
  max_adverse_excursion_pct?: number;
  holding_days?: number;
  benchmark_code?: string;
  benchmark_name?: string;
  benchmark_return_pct?: number;
  excess_return_pct?: number;
  exit_reason_label?: string;
  // Phase 5: 自动归类根因
  root_cause?: string;
  root_cause_label?: string;
  root_cause_confidence?: number;
  metadata?: {
    signal_metadata?: {
      consensus_count?: number;
      consensus_bonus?: number;
      original_score?: number;
      consensus_variants?: string[];
      recommendation_tier_label?: string;
      market_environment?: {
        market_regime?: string;
        market_regime_label?: string;
        industry?: {
          regime?: string;
          label?: string;
        };
      };
    };
    market_environment?: {
      market_regime?: string;
      market_regime_label?: string;
      industry?: {
        regime?: string;
        label?: string;
      };
    };
    consensus?: {
      consensus_count?: number;
      consensus_bonus?: number;
      original_score?: number;
      consensus_variants?: string[];
      recommendation_tier_label?: string;
    };
  };
  policy_explain?: any;
  updated_at?: string;
}

interface OutcomeDashboard {
  generated_at: string;
  portfolio_id: number;
  user_id: number;
  filters: Record<string, any>;
  summary: {
    total_count: number;
    open_count: number;
    closed_count: number;
    win_count: number;
    loss_count: number;
    excess_win_count: number;
    total_realized_pnl: number;
    total_unrealized_pnl: number;
    total_pnl: number;
    avg_total_pnl_pct: number;
    avg_closed_return_pct: number;
    avg_excess_return_pct: number;
    win_rate: number;
    excess_win_rate: number;
    payoff_ratio: number;
    profit_factor: number;
    avg_holding_days: number;
    avg_mfe_pct: number;
    avg_mae_pct: number;
    open_exposure: number;
    best_trade?: TradeOutcome;
    worst_trade?: TradeOutcome;
  };
  groups: {
    by_source_type: OutcomeBucket[];
    by_agent_session: OutcomeBucket[];
    by_style: OutcomeBucket[];
    by_action: OutcomeBucket[];
    by_risk_level: OutcomeBucket[];
    by_industry: OutcomeBucket[];
    by_consensus?: OutcomeBucket[];
    by_market_regime?: OutcomeBucket[];
    by_industry_regime?: OutcomeBucket[];
    /** Phase 5+: 按 root_cause 聚合（亏损归因 dashboard） */
    by_root_cause?: OutcomeBucket[];
  };
  outcomes: TradeOutcome[];
  feedback: {
    recommended_min_score: number;
    position_multiplier: number;
    allowed_risk_levels: string[];
    best_segments: OutcomeBucket[];
    weak_segments: OutcomeBucket[];
    insights: string[];
    next_actions: string[];
  };
}

const formatMoney = (value?: number | null) =>
  `¥${Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatSignedMoney = (value?: number | null) => {
  const num = Number(value || 0);
  const prefix = num > 0 ? '+¥' : num < 0 ? '-¥' : '¥';
  return `${prefix}${Math.abs(num).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const formatPercent = (value?: number | null) => `${Number(value || 0).toFixed(2)}%`;
const pnlColor = (value?: number | null) => (Number(value || 0) >= 0 ? '#d14343' : '#008f6b');
const statusColor = (status?: string) => (status === 'closed' ? 'purple' : 'blue');
const clampPercent = (value?: number | null) => Math.max(0, Math.min(100, Number(value || 0)));

const sourceLabel = (value?: string) => {
  const labels: Record<string, string> = {
    quant_recommendation: '量化候选',
    tradingagents: 'TradingAgents',
    daily_screener: 'AI每日优选',
    manual_analysis: '手动分析',
  };
  return labels[value || ''] || value || '未标注';
};

const sessionLabel = (value?: string) => {
  const labels: Record<string, string> = { close: '尾盘', midday: '午盘', morning: '早盘' };
  return labels[value || ''] || value || '未标注';
};

const getConsensusMeta = (record: TradeOutcome) =>
  record.metadata?.consensus || record.metadata?.signal_metadata || {};

const getMarketEnvironment = (record?: TradeOutcome) =>
  record?.metadata?.market_environment || record?.metadata?.signal_metadata?.market_environment;

const RecommendationTradeOutcomes: React.FC = () => {
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<OutcomeDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [sourceType, setSourceType] = useState<string>('all');
  const [tradeStatus, setTradeStatus] = useState<string>('all');
  const [agentSession, setAgentSession] = useState<string>('');

  const fetchDashboard = async (silent = false) => {
    setLoading(true);
    try {
      const response = await api.get('/paper-trading/recommendation-outcomes', {
        params: {
          include_open: true,
          source_type: sourceType,
          trade_status: tradeStatus,
          agent_session: agentSession || undefined,
          lookback_days: 365,
          limit: 2000,
        },
      });
      if (response.data.success) {
        setDashboard(response.data.data);
        if (!silent) message.success('收益闭环看板已刷新');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取收益闭环失败');
    } finally {
      setLoading(false);
    }
  };

  const refreshOutcomes = async () => {
    setRefreshing(true);
    try {
      const response = await api.post('/paper-trading/recommendation-outcomes/refresh', {
        include_open: true,
        lookback_days: 365,
        source_type: sourceType,
        agent_session: agentSession || undefined,
        report_to_feishu: false,
      });
      if (response.data.success) {
        setDashboard(response.data.data.dashboard);
        message.success(response.data.message || '收益闭环刷新完成');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '收益闭环刷新失败');
    } finally {
      setRefreshing(false);
    }
  };

  const reportOutcomes = async () => {
    setReporting(true);
    try {
      const response = await api.post('/paper-trading/recommendation-outcomes/report', {
        include_open: true,
        source_type: sourceType,
        trade_status: tradeStatus,
        agent_session: agentSession || undefined,
        lookback_days: 365,
      });
      if (response.data.success) {
        setDashboard(response.data.data);
        message.success('收益闭环结论已写入飞书');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '飞书上报失败');
    } finally {
      setReporting(false);
    }
  };

  useEffect(() => {
    fetchDashboard(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceType, tradeStatus, agentSession]);

  const summary = dashboard?.summary;
  const feedback = dashboard?.feedback;
  const outcomes = useMemo(() => dashboard?.outcomes || [], [dashboard?.outcomes]);

  const equityCurve = useMemo(() => {
    const sorted = [...outcomes].sort((a, b) =>
      String(a.exit_date || a.entry_date || '').localeCompare(
        String(b.exit_date || b.entry_date || '')
      )
    );
    let cumulative = 0;
    return sorted.map(item => {
      cumulative += Number(item.total_pnl || 0);
      return {
        date: item.exit_date || item.entry_date || item.signal_date,
        symbol: item.name || item.symbol,
        pnl: Number(item.total_pnl || 0),
        cumulative: Number(cumulative.toFixed(2)),
      };
    });
  }, [outcomes]);

  const topBuckets = useMemo(() => {
    const groups = dashboard?.groups;
    if (!groups) return [];
    return [...groups.by_source_type, ...groups.by_agent_session, ...groups.by_style]
      .filter(item => item.closed_count > 0)
      .sort((a, b) => b.avg_excess_return_pct - a.avg_excess_return_pct)
      .slice(0, 8);
  }, [dashboard]);

  const consensusBuckets = useMemo(() => dashboard?.groups?.by_consensus || [], [dashboard]);
  const marketRegimeBuckets = useMemo(() => dashboard?.groups?.by_market_regime || [], [dashboard]);
  const industryRegimeBuckets = useMemo(
    () => dashboard?.groups?.by_industry_regime || [],
    [dashboard]
  );
  // Phase 5+: 按 root_cause 聚合（亏损/盈利归因 dashboard）
  const rootCauseBuckets = useMemo(() => dashboard?.groups?.by_root_cause || [], [dashboard]);
  const environmentAttribution = useMemo(() => {
    const bestMarket = [...marketRegimeBuckets]
      .filter(item => item.closed_count > 0)
      .sort((a, b) => Number(b.robust_score || 0) - Number(a.robust_score || 0))[0];
    const weakMarket = [...marketRegimeBuckets]
      .filter(item => item.closed_count > 0)
      .sort((a, b) => Number(a.robust_score || 0) - Number(b.robust_score || 0))[0];
    const bestIndustry = [...industryRegimeBuckets]
      .filter(item => item.closed_count > 0)
      .sort((a, b) => Number(b.robust_score || 0) - Number(a.robust_score || 0))[0];
    return { bestMarket, weakMarket, bestIndustry };
  }, [marketRegimeBuckets, industryRegimeBuckets]);

  const consensusAttribution = useMemo(() => {
    const buckets = consensusBuckets.filter(item => item.key !== 'no_consensus');
    const noConsensus = consensusBuckets.find(item => item.key === 'no_consensus');
    const best = [...buckets].sort((a, b) => b.avg_excess_return_pct - a.avg_excess_return_pct)[0];
    const totalConsensusClosed = buckets.reduce(
      (sum, item) => sum + Number(item.closed_count || 0),
      0
    );
    const avgConsensusExcess =
      totalConsensusClosed > 0
        ? buckets.reduce(
            (sum, item) =>
              sum + Number(item.avg_excess_return_pct || 0) * Number(item.closed_count || 0),
            0
          ) / totalConsensusClosed
        : 0;
    const edge = Number(
      (avgConsensusExcess - Number(noConsensus?.avg_excess_return_pct || 0)).toFixed(2)
    );
    return {
      buckets,
      no_consensus: noConsensus,
      best,
      closed_count: totalConsensusClosed,
      avg_excess_return_pct: avgConsensusExcess,
      edge,
    };
  }, [consensusBuckets]);

  const adaptivePolicy = useMemo(() => {
    const closed = Number(summary?.closed_count || 0);
    const minSamples = 5;
    const bestStyle = (dashboard?.groups?.by_style || [])
      .filter(item => item.closed_count >= 2)
      .sort((a, b) => b.avg_excess_return_pct - a.avg_excess_return_pct)[0];
    const weakStyle = (dashboard?.groups?.by_style || [])
      .filter(item => item.closed_count >= 2)
      .sort((a, b) => a.avg_excess_return_pct - b.avg_excess_return_pct)[0];
    const avgExcess = Number(summary?.avg_excess_return_pct || 0);
    const excessWinRate = Number(summary?.excess_win_rate || 0);
    const positionMultiplier = Number(
      feedback?.position_multiplier || (closed < minSamples ? 0.65 : 0.85)
    );
    const style =
      bestStyle?.key && bestStyle.avg_excess_return_pct > Math.max(1, avgExcess)
        ? bestStyle.label
        : 'balanced';
    let tradeLimit = 3;
    if (closed < minSamples || avgExcess < -1 || excessWinRate < 45) {
      tradeLimit = 2;
    } else if (avgExcess > 2 && excessWinRate >= 55) {
      tradeLimit = 4;
    }

    return {
      closed,
      minSamples,
      style,
      score: feedback?.recommended_min_score || 72,
      positionMultiplier,
      defaultPositionPct: Number((5 * Math.min(positionMultiplier, 1.2)).toFixed(2)),
      maxPositionPct: Number((10 * Math.max(0.45, Math.min(positionMultiplier, 1.2))).toFixed(2)),
      tradeLimit,
      bestStyle,
      weakStyle,
      reason:
        closed < minSamples
          ? `闭环样本 ${closed}/${minSamples}，下一轮以低倍率小仓采样为主。`
          : `闭环样本 ${closed}，平均超额 ${avgExcess.toFixed(
              2
            )}%，系统将自动调整评分、风格和仓位。`,
    };
  }, [dashboard, feedback, summary]);

  const columns = [
    {
      title: '标的 / 来源',
      key: 'symbol',
      fixed: 'left' as const,
      width: 210,
      render: (_: any, record: TradeOutcome) => (
        <Space direction="vertical" size={2}>
          <Text strong>{record.name || record.symbol}</Text>
          <Space size={4} wrap>
            <Text type="secondary">{record.symbol}</Text>
            <Tag color="geekblue">{sourceLabel(record.source_type)}</Tag>
            {record.agent_session && <Tag>{sessionLabel(record.agent_session)}</Tag>}
          </Space>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'trade_status',
      width: 90,
      render: (value: string) => (
        <Tag color={statusColor(value)}>{value === 'closed' ? '已平仓' : '持仓中'}</Tag>
      ),
    },
    {
      title: '评分/风险',
      width: 120,
      render: (_: any, record: TradeOutcome) => (
        <Space direction="vertical" size={2}>
          <Text strong>{record.score ?? '--'}</Text>
          <Text type="secondary">{record.risk_level || '--'}</Text>
        </Space>
      ),
    },
    {
      title: '策略共识',
      width: 130,
      render: (_: any, record: TradeOutcome) => {
        const consensus = getConsensusMeta(record);
        const count = Number(consensus.consensus_count || 0);
        return (
          <Space direction="vertical" size={2}>
            {count > 1 ? (
              <Tag color="purple">共识{count}组</Tag>
            ) : (
              <Tag color="default">无显式共识</Tag>
            )}
            {Number(consensus.consensus_bonus || 0) > 0 && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                原始 {Number(consensus.original_score || record.score || 0).toFixed(1)} · +
                {consensus.consensus_bonus}
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '市场环境',
      width: 150,
      render: (_: any, record: TradeOutcome) => {
        const env = getMarketEnvironment(record);
        return (
          <Space direction="vertical" size={2}>
            <Tag color="cyan">{env?.market_regime_label || env?.market_regime || '未知环境'}</Tag>
            {env?.industry?.label && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {env.industry.label}
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '买入/最新',
      width: 150,
      render: (_: any, record: TradeOutcome) => (
        <Space direction="vertical" size={2}>
          <Text>{formatMoney(record.entry_price)}</Text>
          <Text type="secondary">最新 {formatMoney(record.latest_price || record.exit_price)}</Text>
        </Space>
      ),
    },
    {
      title: '收益',
      width: 150,
      render: (_: any, record: TradeOutcome) => (
        <Space direction="vertical" size={2}>
          <Text strong style={{ color: pnlColor(record.total_pnl) }}>
            {formatSignedMoney(record.total_pnl)}
          </Text>
          <Text style={{ color: pnlColor(record.total_pnl_pct) }}>
            {formatPercent(record.total_pnl_pct)}
          </Text>
        </Space>
      ),
    },
    {
      title: '基准超额',
      width: 150,
      render: (_: any, record: TradeOutcome) => (
        <Space direction="vertical" size={2}>
          <Text strong style={{ color: pnlColor(record.excess_return_pct) }}>
            {formatPercent(record.excess_return_pct)}
          </Text>
          <Text type="secondary">
            {record.benchmark_name || '--'} {formatPercent(record.benchmark_return_pct)}
          </Text>
        </Space>
      ),
    },
    {
      title: 'MFE / MAE',
      width: 140,
      render: (_: any, record: TradeOutcome) => (
        <Space direction="vertical" size={2}>
          <Text style={{ color: '#d14343' }}>
            {formatPercent(record.max_favorable_excursion_pct)}
          </Text>
          <Text style={{ color: '#008f6b' }}>
            {formatPercent(record.max_adverse_excursion_pct)}
          </Text>
        </Space>
      ),
    },
    {
      title: '周期',
      width: 140,
      render: (_: any, record: TradeOutcome) => (
        <Space direction="vertical" size={2}>
          <Text>{record.holding_days ?? 0} 天</Text>
          <Text type="secondary">
            {record.entry_date || '--'} → {record.exit_date || '持仓'}
          </Text>
        </Space>
      ),
    },
    {
      title: '退出原因',
      width: 140,
      render: (_: any, record: TradeOutcome) =>
        record.exit_reason_label || record.action_label || '-',
    },
    // Phase 5: 根因归类
    {
      title: '根因',
      width: 130,
      render: (_: any, record: TradeOutcome) => {
        if (!record.root_cause) return <Text type="secondary">-</Text>;
        const colorMap: Record<string, string> = {
          profit_take: 'success',
          stop_loss: 'red',
          time_stop: 'orange',
          wrong_entry: 'volcano',
          wrong_regime: 'magenta',
          catalyst_failed: 'gold',
          data_quality: 'purple',
          backtest_drift: 'cyan',
          risk_kill_switch: 'red',
          unknown: 'default',
        };
        const tooltip = record.root_cause_confidence !== undefined
          ? `${record.root_cause} (置信度 ${(record.root_cause_confidence * 100).toFixed(0)}%)`
          : record.root_cause;
        return (
          <Tooltip title={tooltip}>
            <Tag color={colorMap[record.root_cause] || 'default'} style={{ fontSize: 11 }}>
              {record.root_cause_label || record.root_cause}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '链路',
      width: 92,
      fixed: 'right' as const,
      render: (_: any, record: TradeOutcome) => (
        <Button
          type="link"
          size="small"
          onClick={() => navigate(`/recommendation-trade-outcomes/${record.id}`)}
        >
          追踪 <ArrowRightOutlined />
        </Button>
      ),
    },
  ];

  return (
    <div className="recommendation-outcomes-page fade-in-up">
      <div className="outcome-hero">
        <div className="outcome-hero-copy">
          <div className="outcome-kicker">Closed Loop Trading Intelligence</div>
          <h1>推荐交易收益闭环</h1>
          <p>
            把全市场荐股、TradingAgents 复核、模拟盘买卖、基准超额和收益归因连成同一条数据链，
            用真实模拟交易结果反过来约束下一轮选股评分与仓位。
          </p>
          <div className="outcome-hero-tags">
            <Tag icon={<NodeIndexOutlined />}>Signal → Trade → P&L</Tag>
            <Tag icon={<RadarChartOutlined />}>Benchmark Excess</Tag>
            <Tag icon={<ExperimentOutlined />}>Feedback Policy</Tag>
          </div>
        </div>
        <div className="outcome-command-panel">
          <div className="command-label">NEXT AUTO POLICY</div>
          <div className="command-score">{feedback?.recommended_min_score || 72}</div>
          <div className="command-caption">
            最低评分 · 仓位倍率 {feedback?.position_multiplier || 0.8}x
          </div>
          <Progress
            percent={clampPercent(summary?.excess_win_rate)}
            strokeColor={{ '0%': '#d6a64f', '100%': '#00a7c2' }}
            trailColor="rgba(255,255,255,.14)"
          />
          <Text style={{ color: 'rgba(248,251,255,.72)' }}>
            超额胜率 {formatPercent(summary?.excess_win_rate)} · Profit Factor{' '}
            {summary?.profit_factor || 0}
          </Text>
          <div className="command-mini-grid">
            <span>风格 {adaptivePolicy.style}</span>
            <span>试单 {adaptivePolicy.tradeLimit} 笔</span>
            <span>仓位 {adaptivePolicy.defaultPositionPct}%</span>
          </div>
        </div>
      </div>

      <Card className="modern-card outcome-filter-card" variant="borderless">
        <Space wrap size="middle">
          <Select value={sourceType} onChange={setSourceType} style={{ width: 180 }}>
            <Select.Option value="all">全部来源</Select.Option>
            <Select.Option value="quant_recommendation">量化候选</Select.Option>
            <Select.Option value="tradingagents">TradingAgents</Select.Option>
            <Select.Option value="daily_screener">AI每日优选</Select.Option>
          </Select>
          <Select value={tradeStatus} onChange={setTradeStatus} style={{ width: 150 }}>
            <Select.Option value="all">全部状态</Select.Option>
            <Select.Option value="open">持仓中</Select.Option>
            <Select.Option value="closed">已平仓</Select.Option>
          </Select>
          <Select value={agentSession} onChange={setAgentSession} style={{ width: 150 }}>
            <Select.Option value="">全部场次</Select.Option>
            <Select.Option value="close">尾盘</Select.Option>
            <Select.Option value="midday">午盘</Select.Option>
            <Select.Option value="morning">早盘</Select.Option>
          </Select>
          <Button icon={<ReloadOutlined />} onClick={() => fetchDashboard(false)} loading={loading}>
            刷新看板
          </Button>
          <Button
            type="primary"
            icon={<FundProjectionScreenOutlined />}
            onClick={refreshOutcomes}
            loading={refreshing}
          >
            重算收益闭环
          </Button>
          <Button icon={<CloudUploadOutlined />} onClick={reportOutcomes} loading={reporting}>
            结论上报飞书
          </Button>
          <Text type="secondary">最后生成：{dashboard?.generated_at || '--'}</Text>
        </Space>
      </Card>

      <Row gutter={[18, 18]} style={{ marginBottom: 18 }}>
        <Col xs={12} lg={6}>
          <Card
            className="modern-card outcome-stat-card hot"
            variant="borderless"
            loading={loading && !dashboard}
          >
            <Statistic
              title="综合盈亏"
              value={summary?.total_pnl || 0}
              precision={2}
              prefix="¥"
              valueStyle={{ color: pnlColor(summary?.total_pnl) }}
            />
            <Text type="secondary">
              实现 {formatSignedMoney(summary?.total_realized_pnl)} / 浮动{' '}
              {formatSignedMoney(summary?.total_unrealized_pnl)}
            </Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card
            className="modern-card outcome-stat-card"
            variant="borderless"
            loading={loading && !dashboard}
          >
            <Statistic
              title="闭环 / 持仓"
              value={summary?.closed_count || 0}
              suffix={`/ ${summary?.open_count || 0}`}
              prefix={<ApartmentOutlined />}
            />
            <Text type="secondary">共跟踪 {summary?.total_count || 0} 笔推荐交易</Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card
            className="modern-card outcome-stat-card"
            variant="borderless"
            loading={loading && !dashboard}
          >
            <Statistic
              title="超额胜率"
              value={summary?.excess_win_rate || 0}
              precision={2}
              suffix="%"
              prefix={<TrophyOutlined />}
            />
            <Text type="secondary">平均超额 {formatPercent(summary?.avg_excess_return_pct)}</Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card
            className="modern-card outcome-stat-card"
            variant="borderless"
            loading={loading && !dashboard}
          >
            <Statistic
              title="MFE / MAE"
              value={summary?.avg_mfe_pct || 0}
              precision={2}
              suffix="%"
              prefix={<SafetyCertificateOutlined />}
            />
            <Text type="secondary">平均不利波动 {formatPercent(summary?.avg_mae_pct)}</Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[18, 18]} style={{ marginBottom: 18 }}>
        <Col xs={24} xl={15}>
          <Card
            className="modern-card outcome-chart-card"
            variant="borderless"
            title="闭环收益曲线"
          >
            {equityCurve.length > 0 ? (
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={equityCurve} margin={{ left: 8, right: 18, top: 12, bottom: 0 }}>
                    <defs>
                      <linearGradient id="outcomeEquity" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#d6a64f" stopOpacity={0.36} />
                        <stop offset="100%" stopColor="#00a7c2" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="rgba(15,23,42,.08)"
                    />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#65727e', fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tick={{ fill: '#65727e', fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={value => `${Number(value / 10000).toFixed(1)}w`}
                    />
                    <RechartsTooltip
                      formatter={(value: number) => [formatSignedMoney(value), '累计盈亏']}
                    />
                    <Area
                      type="monotone"
                      dataKey="cumulative"
                      stroke="#9f6b25"
                      strokeWidth={3}
                      fill="url(#outcomeEquity)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Empty description="暂无收益曲线样本" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card
            className="modern-card outcome-segment-card"
            variant="borderless"
            title="强弱片段雷达"
          >
            {topBuckets.length > 0 ? (
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={topBuckets}
                    layout="vertical"
                    margin={{ left: 8, right: 20, top: 8, bottom: 8 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      horizontal={false}
                      stroke="rgba(15,23,42,.08)"
                    />
                    <XAxis
                      type="number"
                      tick={{ fill: '#65727e', fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={86}
                      tick={{ fill: '#65727e', fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <RechartsTooltip
                      formatter={(value: number) => [`${Number(value).toFixed(2)}%`, '平均超额']}
                    />
                    <Bar dataKey="avg_excess_return_pct" radius={[0, 10, 10, 0]}>
                      {topBuckets.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={entry.avg_excess_return_pct >= 0 ? '#d6a64f' : '#008f6b'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Empty description="暂无可比较片段" />
            )}
          </Card>
        </Col>
      </Row>

      <Card className="modern-card consensus-attribution-card" variant="borderless">
        <Row gutter={[18, 18]} align="middle">
          <Col xs={24} lg={7}>
            <div className="outcome-panel-title">
              <RadarChartOutlined /> 市场/行业环境归因
            </div>
            <p>
              将每笔推荐成交按大盘趋势和行业热度分桶，后续自动跟单会优先保留适配当前环境的组合，压力市和弱行业自动降权。
            </p>
            <Space wrap>
              <Tag color="cyan">
                最强环境 {environmentAttribution.bestMarket?.label || '等待样本'}
              </Tag>
              <Tag color="orange">
                待降权 {environmentAttribution.weakMarket?.label || '等待样本'}
              </Tag>
            </Space>
          </Col>
          <Col xs={12} lg={4}>
            <Statistic
              title="环境稳健分"
              value={environmentAttribution.bestMarket?.robust_score || 0}
              precision={1}
              valueStyle={{ color: pnlColor(environmentAttribution.bestMarket?.robust_score) }}
            />
            <Text type="secondary">{environmentAttribution.bestMarket?.label || '暂无'}</Text>
          </Col>
          <Col xs={12} lg={4}>
            <Statistic
              title="行业状态"
              value={environmentAttribution.bestIndustry?.robust_score || 0}
              precision={1}
              valueStyle={{ color: pnlColor(environmentAttribution.bestIndustry?.robust_score) }}
            />
            <Text type="secondary">{environmentAttribution.bestIndustry?.label || '暂无'}</Text>
          </Col>
          <Col xs={24} lg={9}>
            <Space wrap size={[8, 8]}>
              {[...marketRegimeBuckets, ...industryRegimeBuckets].slice(0, 8).map(bucket => (
                <Tag
                  key={`${bucket.dimension || 'env'}-${bucket.key}`}
                  color={Number(bucket.robust_score || 0) >= 0 ? 'cyan' : 'orange'}
                >
                  {bucket.label}：{bucket.closed_count}闭环 / 稳健分{' '}
                  {Number(bucket.robust_score || 0).toFixed(1)} / 风调超额{' '}
                  {formatPercent(bucket.risk_adjusted_excess_return_pct)}
                </Tag>
              ))}
              {marketRegimeBuckets.length + industryRegimeBuckets.length === 0 && (
                <Text type="secondary">暂无环境归因样本</Text>
              )}
            </Space>
          </Col>
        </Row>
      </Card>

      {/* Phase 5+: 根因 (root_cause) 归因 dashboard
          所有闭环 trade 按 10 种 root_cause 聚合，让用户一眼看到：
            - "中途回撤过深" 占比多少？是不是止损线设得太宽？
            - "催化剂失效" 多发生在哪种 strategy？说明这类策略 catalyst 选得不准
            - "正常兑现" 占比理想 (健康策略) vs "硬止损" 占主导 (策略问题)
      */}
      <Card className="modern-card root-cause-card" variant="borderless" style={{ marginTop: 16 }}>
        <Row gutter={[18, 18]} align="middle">
          <Col xs={24} lg={7}>
            <div className="outcome-panel-title">
              <NodeIndexOutlined /> 闭环根因归因（Phase 5）
            </div>
            <p>
              所有闭环 trade 按 10 种 root_cause 聚类。健康策略应当以"正常兑现"+"止盈触发"为主导；
              如果"催化剂失效"或"中途回撤过深"占比过高，需要回看 strategy 或 sizing 配置。
            </p>
          </Col>
          <Col xs={24} lg={17}>
            {rootCauseBuckets.length === 0 ? (
              <Text type="secondary">暂无 root_cause 样本（运行 npm run reprocess:root-cause 回填历史数据）</Text>
            ) : (
              <Space wrap size={[8, 8]}>
                {rootCauseBuckets
                  .filter(b => b.closed_count > 0)
                  .sort((a, b) => b.closed_count - a.closed_count)
                  .map(bucket => {
                    const pct = (bucket.closed_count / Math.max(1, rootCauseBuckets.reduce((s, b) => s + b.closed_count, 0))) * 100;
                    const winRate = Number(bucket.win_rate || 0);
                    const avgReturn = Number(bucket.avg_return_pct || 0);
                    return (
                      <Tooltip
                        key={bucket.key}
                        title={
                          <div style={{ minWidth: 180 }}>
                            <div><b>{bucket.label}</b></div>
                            <div>闭环 {bucket.closed_count} 笔（{pct.toFixed(1)}%）</div>
                            <div>胜率 {winRate.toFixed(1)}%</div>
                            <div>平均回报 {avgReturn.toFixed(2)}%</div>
                            <div>平均超额 {Number(bucket.avg_excess_return_pct || 0).toFixed(2)}%</div>
                            <div>持仓 {Number(bucket.avg_holding_days || 0).toFixed(1)} 天</div>
                          </div>
                        }
                      >
                        <Tag
                          color={
                            bucket.key === 'normal_thesis_played_out' || bucket.key === 'take_profit_hit'
                              ? 'green'
                              : bucket.key === 'stop_loss_hit' || bucket.key === 'excessive_drawdown'
                              ? 'red'
                              : bucket.key === 'catalyst_failed' || bucket.key === 'micro_thesis_broken'
                              ? 'orange'
                              : bucket.key === 'market_regime_shift' || bucket.key === 'industry_rotation'
                              ? 'volcano'
                              : 'default'
                          }
                          style={{ padding: '4px 10px', fontSize: 13 }}
                        >
                          {bucket.label} · {bucket.closed_count} ({pct.toFixed(0)}%)
                        </Tag>
                      </Tooltip>
                    );
                  })}
              </Space>
            )}
          </Col>
        </Row>
      </Card>

      <Card className="modern-card consensus-attribution-card" variant="borderless">
        <Row gutter={[18, 18]} align="middle">
          <Col xs={24} lg={7}>
            <div className="outcome-panel-title">
              <NodeIndexOutlined /> 多策略共识收益归因
            </div>
            <p>
              将“策略实验共识加权”的标的单独抽出来，与无显式共识样本比较，验证共识排序是否真的转化为模拟交易超额收益。
            </p>
            <Space wrap>
              <Tag color="purple">共识闭环 {consensusAttribution.closed_count} 笔</Tag>
              <Tag color={consensusAttribution.edge >= 0 ? 'red' : 'green'}>
                相对无共识 {consensusAttribution.edge >= 0 ? '+' : ''}
                {consensusAttribution.edge.toFixed(2)}%
              </Tag>
            </Space>
          </Col>
          <Col xs={12} lg={4}>
            <Statistic
              title="共识组平均超额"
              value={consensusAttribution.avg_excess_return_pct}
              precision={2}
              suffix="%"
              valueStyle={{ color: pnlColor(consensusAttribution.avg_excess_return_pct) }}
            />
          </Col>
          <Col xs={12} lg={4}>
            <Statistic
              title="最强共识层"
              value={consensusAttribution.best?.avg_excess_return_pct || 0}
              precision={2}
              suffix="%"
              valueStyle={{ color: pnlColor(consensusAttribution.best?.avg_excess_return_pct) }}
            />
            <Text type="secondary">{consensusAttribution.best?.label || '等待样本'}</Text>
          </Col>
          <Col xs={24} lg={9}>
            <Space wrap size={[8, 8]}>
              {consensusBuckets.map(bucket => (
                <Tag
                  key={bucket.key}
                  color={
                    bucket.key === 'no_consensus'
                      ? 'default'
                      : bucket.avg_excess_return_pct >= 0
                      ? 'purple'
                      : 'orange'
                  }
                >
                  {bucket.label}：{bucket.closed_count}闭环 / 超额{' '}
                  {formatPercent(bucket.avg_excess_return_pct)} / 胜率{' '}
                  {formatPercent(bucket.excess_win_rate)}
                </Tag>
              ))}
              {consensusBuckets.length === 0 && <Text type="secondary">暂无共识归因样本</Text>}
            </Space>
          </Col>
        </Row>
      </Card>

      <Row gutter={[18, 18]} style={{ marginBottom: 18 }}>
        <Col xs={24}>
          <Card className="modern-card adaptive-policy-card" variant="borderless">
            <div className="adaptive-policy-shell">
              <div>
                <div className="outcome-panel-title">
                  <NodeIndexOutlined /> 全市场荐股自适应策略
                </div>
                <p>{adaptivePolicy.reason}</p>
                <div className="adaptive-policy-tags">
                  <Tag color="gold">最低评分 ≥ {adaptivePolicy.score}</Tag>
                  <Tag color="cyan">推荐风格 {adaptivePolicy.style}</Tag>
                  <Tag color="blue">默认仓位 {adaptivePolicy.defaultPositionPct}%</Tag>
                  <Tag color="purple">最大仓位 {adaptivePolicy.maxPositionPct}%</Tag>
                  <Tag>自动跟单 {adaptivePolicy.tradeLimit} 笔</Tag>
                </div>
              </div>
              <div className="adaptive-policy-route">
                <div>
                  <span>Best segment</span>
                  <strong>{adaptivePolicy.bestStyle?.label || '等待样本'}</strong>
                  <em>超额 {formatPercent(adaptivePolicy.bestStyle?.avg_excess_return_pct)}</em>
                </div>
                <div>
                  <span>Reduce</span>
                  <strong>{adaptivePolicy.weakStyle?.label || '暂无'}</strong>
                  <em>超额 {formatPercent(adaptivePolicy.weakStyle?.avg_excess_return_pct)}</em>
                </div>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <div className="outcome-intel-panel">
            <div className="outcome-panel-title">
              <FireOutlined /> 策略洞察
            </div>
            {(feedback?.insights || []).slice(0, 5).map((item, index) => (
              <div className="outcome-note" key={`insight-${index}`}>
                {item}
              </div>
            ))}
            {(!feedback?.insights || feedback.insights.length === 0) && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无洞察" />
            )}
          </div>
        </Col>
        <Col xs={24} lg={8}>
          <div className="outcome-intel-panel">
            <div className="outcome-panel-title">
              <LineChartOutlined /> 下一轮动作
            </div>
            {(feedback?.next_actions || []).slice(0, 5).map((item, index) => (
              <div className="outcome-note calm" key={`action-${index}`}>
                {item}
              </div>
            ))}
            <div className="outcome-policy-row">
              <Tag color="gold">评分 ≥ {feedback?.recommended_min_score || 72}</Tag>
              <Tag color="cyan">仓位 {feedback?.position_multiplier || 0.8}x</Tag>
              {(feedback?.allowed_risk_levels || ['low', 'medium']).map(level => (
                <Tag key={level}>{level}</Tag>
              ))}
            </div>
          </div>
        </Col>
        <Col xs={24} lg={8}>
          <div className="outcome-intel-panel">
            <div className="outcome-panel-title">
              <BarChartOutlined /> 最佳 / 待复盘
            </div>
            {summary?.best_trade ? (
              <Alert
                type="success"
                showIcon
                message={`最佳：${summary.best_trade.name || summary.best_trade.symbol}`}
                description={`收益 ${formatPercent(
                  summary.best_trade.total_pnl_pct
                )}，超额 ${formatPercent(summary.best_trade.excess_return_pct)}`}
                style={{ marginBottom: 12 }}
              />
            ) : null}
            {summary?.worst_trade ? (
              <Alert
                type="warning"
                showIcon
                message={`待复盘：${summary.worst_trade.name || summary.worst_trade.symbol}`}
                description={`收益 ${formatPercent(
                  summary.worst_trade.total_pnl_pct
                )}，超额 ${formatPercent(summary.worst_trade.excess_return_pct)}`}
              />
            ) : null}
            {!summary?.best_trade && !summary?.worst_trade && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无样本" />
            )}
          </div>
        </Col>
      </Row>

      <Card className="modern-card table-card-no-padding" variant="borderless" title="推荐交易明细">
        <Table
          columns={columns}
          dataSource={outcomes}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 12, showSizeChanger: true }}
          scroll={{ x: 1320 }}
          expandable={{
            expandedRowRender: record => (
              <TradePolicyExplainPanel
                policy={record.policy_explain}
                outcome={record}
                compact
                title={`${record.name || record.symbol} 的预算/风控/收益回放`}
              />
            ),
            rowExpandable: record => Boolean(record.policy_explain),
          }}
          locale={{
            emptyText: (
              <Empty description="暂无推荐交易收益样本，请先运行自动荐股闭环或模拟盘跟单" />
            ),
          }}
        />
      </Card>
    </div>
  );
};

export default RecommendationTradeOutcomes;
