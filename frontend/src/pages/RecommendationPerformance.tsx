import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  AimOutlined,
  ExperimentOutlined,
  FieldTimeOutlined,
  LineChartOutlined,
  ReloadOutlined,
  RiseOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import dayjs from 'dayjs';
import api from '../services/api';

const { Text, Paragraph } = Typography;

type QualityGate = {
  action: string;
  label: string;
  severity: 'good' | 'bad' | 'watch' | 'neutral' | string;
  position_multiplier: number;
  reason: string;
};

type QualityBucket = SummaryRow & {
  label?: string;
  dimension?: string;
  quality_score: number;
  gate: QualityGate;
};

type SummaryRow = {
  key?: string;
  horizon?: string;
  horizon_days?: number;
  count: number;
  avg_return_pct: number;
  median_return_pct?: number;
  positive_rate: number;
  directional_success_rate?: number;
  payoff_ratio?: number;
  profit_factor?: number;
  avg_mfe_pct?: number;
  avg_mae_pct?: number;
  quality_score?: number;
  gate?: QualityGate;
};

type RecentSignal = {
  signal_id: number;
  source_type: string;
  symbol: string;
  name?: string;
  signal_date: string;
  normalized_decision: string;
  confidence_score?: number;
  risk_level?: string;
  horizon: string;
  entry_price?: number;
  exit_price?: number;
  exit_date?: string;
  return_pct: number;
  directional_return_pct?: number;
  max_favorable_excursion_pct?: number;
  max_adverse_excursion_pct?: number;
  consensus_count?: number;
  consensus_bonus?: number;
  consensus_variants?: string[];
  recommendation_tier_label?: string;
};

type QualityReportData = {
  generated_at: string;
  filters: Record<string, any>;
  overview: QualityBucket & {
    total_signals: number;
    pending_signals: number;
    no_data_signals: number;
    completed_samples: number;
  };
  data_health?: {
    pending_signals: number;
    no_data_signals: number;
    missing_bars: number;
    waiting_for_market_data: number;
    insufficient_horizon_bars: number;
    symbols_need_sync: number;
  };
  repair_summary?: {
    enabled: boolean;
    synced_symbols: number;
    inserted_bars: number;
    after?: {
      no_data_signals?: number;
      pending_signals?: number;
      missing_bars?: number;
      insufficient_horizon_bars?: number;
    };
  };
  rankings: {
    by_source_type: QualityBucket[];
    by_agent_session: QualityBucket[];
    by_decision: QualityBucket[];
    by_risk_level: QualityBucket[];
    by_symbol: QualityBucket[];
  };
  best_segments: QualityBucket[];
  worst_segments: QualityBucket[];
  action_items: string[];
};

type DashboardData = {
  generated_at: string;
  filters: Record<string, any>;
  overview: SummaryRow & {
    total_signals: number;
    pending_signals: number;
    no_data_signals: number;
    completed_samples: number;
    horizon: string;
  };
  playbook?: {
    horizon: string;
    min_samples: number;
    overall: QualityBucket;
    buy_side: QualityBucket;
    sell_side: QualityBucket;
    best_segments: QualityBucket[];
    risk_notes: string[];
  };
  by_decision: SummaryRow[];
  by_source_type: SummaryRow[];
  by_risk_level: SummaryRow[];
  by_consensus?: Array<SummaryRow & { label?: string; quality_score?: number; gate?: QualityGate }>;
  horizon_summary: SummaryRow[];
  top_symbols: Array<SummaryRow & { symbol: string; name?: string; latest_signal_date?: string }>;
  recent_signals: RecentSignal[];
  equity_curve: Array<{
    date: string;
    signal_id: number;
    symbol: string;
    return_pct: number;
    cumulative_return_pct: number;
    drawdown_pct: number;
  }>;
};

const horizonOptions = ['1d', '3d', '5d', '10d', '20d'].map(value => ({ label: value, value }));
const sourceOptions = [
  { label: '全部来源', value: '' },
  { label: '量化候选', value: 'quant_recommendation' },
  { label: 'TradingAgents', value: 'tradingagents' },
  { label: '每日优选', value: 'daily_screener' },
];
const decisionOptions = [
  { label: '全部建议', value: '' },
  { label: '强买', value: 'strong_buy' },
  { label: '买入', value: 'buy' },
  { label: '持有', value: 'hold' },
  { label: '卖出', value: 'sell' },
  { label: '强卖', value: 'strong_sell' },
];
const agentSessionOptions = [
  { label: '全部场次', value: '' },
  { label: '尾盘建议', value: 'close' },
  { label: '午盘建议', value: 'midday' },
  { label: '早盘建议', value: 'morning' },
];

const decisionColorMap: Record<string, string> = {
  strong_buy: 'magenta',
  buy: 'red',
  hold: 'gold',
  sell: 'green',
  strong_sell: 'cyan',
  unknown: 'default',
};

const sourceLabelMap: Record<string, string> = {
  quant_recommendation: '量化候选',
  tradingagents: 'TradingAgents',
  daily_screener: '每日优选',
  manual_analysis: '人工分析',
};

const agentSessionLabelMap: Record<string, string> = {
  close: '尾盘',
  midday: '午盘',
  morning: '早盘',
};

const consensusLabelMap: Record<string, string> = {
  consensus_4_plus: '4组以上共识',
  consensus_3: '3组共识',
  consensus_2: '2组共识',
  no_consensus: '无显式共识',
};

const gateToneMap: Record<
  string,
  { color: string; badge: 'success' | 'error' | 'warning' | 'default' | 'processing' }
> = {
  good: { color: 'red', badge: 'success' },
  bad: { color: 'green', badge: 'error' },
  watch: { color: 'gold', badge: 'warning' },
  neutral: { color: 'blue', badge: 'processing' },
};

const formatMultiplier = (value?: number | null) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '--';
  return `${Number(value).toFixed(2)}x`;
};

const formatPct = (value?: number | null, digits = 2) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '--';
  return `${Number(value).toFixed(digits)}%`;
};

const returnColor = (value?: number | null) => {
  const num = Number(value || 0);
  if (num > 0) return '#b42318';
  if (num < 0) return '#137333';
  return '#5f6b7a';
};

const renderReturn = (value?: number | null) => (
  <Text style={{ color: returnColor(value), fontWeight: 800 }}>{formatPct(value)}</Text>
);

const RecommendationPerformance: React.FC = () => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [qualityReport, setQualityReport] = useState<QualityReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [horizon, setHorizon] = useState('5d');
  const [sourceType, setSourceType] = useState('');
  const [decision, setDecision] = useState('');
  const [agentSession, setAgentSession] = useState('');

  const fetchDashboard = async () => {
    setLoading(true);
    try {
      const response = await api.get('/ai/signals/performance', {
        params: {
          horizon,
          source_type: sourceType || undefined,
          decision: decision || undefined,
          agent_session: agentSession || undefined,
        },
      });
      if (response.data.success) {
        setData(response.data.data);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取推荐绩效看板失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchQualityReport = async () => {
    try {
      const response = await api.get('/ai/signals/quality-report', {
        params: {
          horizon,
          source_type: sourceType || undefined,
          decision: decision || undefined,
          agent_session: agentSession || undefined,
          lookback_days: 30,
          min_samples: 5,
          auto_repair_missing_data: false,
        },
      });
      if (response.data.success) {
        setQualityReport(response.data.data);
      }
    } catch (error) {
      // 日报失败不阻塞主看板
    }
  };

  const reportQualityDaily = async () => {
    setReporting(true);
    try {
      const response = await api.post('/ai/signals/quality-report', {
        horizon,
        source_type: sourceType || undefined,
        decision: decision || undefined,
        agent_session: agentSession || undefined,
        lookback_days: 30,
        min_samples: 5,
        auto_repair_missing_data: true,
        data_source: 'tencent_only',
        repair_lookback_days: 30,
        sync_concurrency: 2,
        verify_before_report: true,
        report_to_feishu: true,
        record_type: agentSession === 'close' ? '尾盘Agent信号质量日报' : '信号质量日报',
      });
      if (response.data.success) {
        setQualityReport(response.data.data);
        message.success('信号质量日报已生成并写入飞书');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '生成信号质量日报失败');
    } finally {
      setReporting(false);
    }
  };

  const refreshPerformance = async () => {
    setRefreshing(true);
    try {
      const response = await api.post('/ai/signals/performance/refresh', {
        limit: 800,
        source_type: sourceType || undefined,
        decision: decision || undefined,
        agent_session: agentSession || undefined,
        horizon,
        record_type: agentSession === 'close' ? 'Agent尾盘建议收益追踪' : undefined,
        report_to_feishu: true,
      });
      if (response.data.success) {
        setData(response.data.data.dashboard);
        const verified = response.data.data.verification?.verified || 0;
        const pending = response.data.data.verification?.pending || 0;
        message.success(`绩效刷新完成：完成 ${verified} 条，等待 ${pending} 条，并已写入飞书`);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '刷新推荐绩效失败');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
    fetchQualityReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizon, sourceType, decision, agentSession]);

  const overview = data?.overview;
  const selectedHorizonStats = useMemo(
    () => data?.horizon_summary?.find(item => item.horizon === horizon) || overview,
    [data, horizon, overview]
  );
  const playbook = data?.playbook;
  const playbookGate = playbook?.overall?.gate;
  const gateTone = gateToneMap[playbookGate?.severity || 'neutral'] || gateToneMap.neutral;
  const consensusBuckets = useMemo(() => data?.by_consensus || [], [data?.by_consensus]);
  const consensusEdge = useMemo(() => {
    const consensus = consensusBuckets.filter(item => item.key !== 'no_consensus');
    const noConsensus = consensusBuckets.find(item => item.key === 'no_consensus');
    const total = consensus.reduce((sum, item) => sum + Number(item.count || 0), 0);
    const avg =
      total > 0
        ? consensus.reduce(
            (sum, item) => sum + Number(item.avg_return_pct || 0) * Number(item.count || 0),
            0
          ) / total
        : 0;
    const noAvg = Number(noConsensus?.avg_return_pct || 0);
    return {
      total,
      avg_return_pct: avg,
      no_consensus_avg_return_pct: noAvg,
      edge: Number((avg - noAvg).toFixed(2)),
      best: [...consensus].sort(
        (a, b) => Number(b.avg_return_pct || 0) - Number(a.avg_return_pct || 0)
      )[0],
    };
  }, [consensusBuckets]);

  const edgeScore = useMemo(() => {
    const stats = selectedHorizonStats;
    if (!stats || !stats.count) return 0;
    const expectancy = Math.max(-10, Math.min(10, Number(stats.avg_return_pct || 0))) * 4;
    const winRate = Math.max(0, Math.min(100, Number(stats.positive_rate || 0))) * 0.35;
    const payoff = Math.min(3, Number(stats.payoff_ratio || 0)) * 8;
    return Math.max(0, Math.min(100, expectancy + winRate + payoff));
  }, [selectedHorizonStats]);

  const monthlyBuckets = useMemo(() => {
    const buckets = new Map<string, { month: string; count: number; total: number }>();
    for (const point of data?.equity_curve || []) {
      const month = dayjs(point.date).format('YYYY-MM');
      const current = buckets.get(month) || { month, count: 0, total: 0 };
      current.count += 1;
      current.total += Number(point.return_pct || 0);
      buckets.set(month, current);
    }
    return Array.from(buckets.values()).map(item => ({
      month: item.month,
      avg_return_pct: Number((item.total / item.count).toFixed(2)),
      count: item.count,
    }));
  }, [data]);

  const recentColumns = [
    {
      title: '信号',
      key: 'signal',
      width: 220,
      render: (_: any, record: RecentSignal) => (
        <Space direction="vertical" size={2}>
          <Space>
            <Text strong>{record.name || record.symbol}</Text>
            <Tag color={decisionColorMap[record.normalized_decision] || 'default'}>
              {record.normalized_decision}
            </Tag>
            {Number(record.consensus_count || 0) > 1 && (
              <Tag color="purple">共识{record.consensus_count}</Tag>
            )}
          </Space>
          <Text type="secondary">
            {record.symbol} · {record.signal_date} ·{' '}
            {sourceLabelMap[record.source_type] || record.source_type}
          </Text>
        </Space>
      ),
    },
    {
      title: '周期',
      dataIndex: 'horizon',
      key: 'horizon',
      width: 80,
      render: (text: string) => <Tag>{text}</Tag>,
    },
    {
      title: '收益',
      dataIndex: 'return_pct',
      key: 'return_pct',
      width: 100,
      sorter: (a: RecentSignal, b: RecentSignal) => a.return_pct - b.return_pct,
      render: (value: number) => renderReturn(value),
    },
    {
      title: '方向收益',
      dataIndex: 'directional_return_pct',
      key: 'directional_return_pct',
      width: 110,
      render: (value: number) => renderReturn(value),
    },
    {
      title: 'MFE / MAE',
      key: 'mfe_mae',
      width: 150,
      render: (_: any, record: RecentSignal) => (
        <Space direction="vertical" size={0}>
          <Text style={{ color: '#b42318' }}>+{formatPct(record.max_favorable_excursion_pct)}</Text>
          <Text style={{ color: '#137333' }}>{formatPct(record.max_adverse_excursion_pct)}</Text>
        </Space>
      ),
    },
    {
      title: '出场',
      key: 'exit',
      width: 160,
      render: (_: any, record: RecentSignal) => (
        <Space direction="vertical" size={0}>
          <Text>{record.exit_date || '-'}</Text>
          <Text type="secondary">
            {record.entry_price ?? '--'} → {record.exit_price ?? '--'}
          </Text>
        </Space>
      ),
    },
  ];

  const playbookColumns = [
    {
      title: '片段',
      key: 'segment',
      render: (_: any, record: QualityBucket) => (
        <Space direction="vertical" size={2}>
          <Text strong>{record.label || record.key}</Text>
          <Text type="secondary">
            {record.dimension || 'quality'} · {record.count} 样本
          </Text>
        </Space>
      ),
    },
    {
      title: '质量分',
      dataIndex: 'quality_score',
      key: 'quality_score',
      width: 110,
      render: (value: number) => (
        <Progress percent={value || 0} size="small" strokeColor="#9f6b25" />
      ),
      sorter: (a: QualityBucket, b: QualityBucket) =>
        (a.quality_score || 0) - (b.quality_score || 0),
    },
    {
      title: '闸门',
      key: 'gate',
      width: 130,
      render: (_: any, record: QualityBucket) => {
        const tone = gateToneMap[record.gate?.severity || 'neutral'] || gateToneMap.neutral;
        return <Tag color={tone.color}>{record.gate?.label || '--'}</Tag>;
      },
    },
    {
      title: '仓位倍率',
      key: 'position_multiplier',
      width: 110,
      render: (_: any, record: QualityBucket) => (
        <Text strong>{formatMultiplier(record.gate?.position_multiplier)}</Text>
      ),
    },
    {
      title: '核心理由',
      key: 'reason',
      render: (_: any, record: QualityBucket) => (
        <Text type="secondary">{record.gate?.reason || '--'}</Text>
      ),
    },
  ];

  const groupColumns = [
    {
      title: '分组',
      key: 'key',
      render: (_: any, record: SummaryRow) => (
        <Tag color={decisionColorMap[record.key || ''] || 'blue'}>
          {sourceLabelMap[record.key || ''] || record.key || record.horizon}
        </Tag>
      ),
    },
    { title: '样本', dataIndex: 'count', key: 'count' },
    {
      title: '平均收益',
      dataIndex: 'avg_return_pct',
      key: 'avg_return_pct',
      render: (value: number) => renderReturn(value),
      sorter: (a: SummaryRow, b: SummaryRow) => a.avg_return_pct - b.avg_return_pct,
    },
    {
      title: '胜率',
      dataIndex: 'positive_rate',
      key: 'positive_rate',
      render: (value: number) => <Text strong>{formatPct(value, 1)}</Text>,
    },
    {
      title: '盈亏比',
      dataIndex: 'payoff_ratio',
      key: 'payoff_ratio',
      render: (value: number) => <Text>{Number(value || 0).toFixed(2)}</Text>,
    },
  ];

  return (
    <div className="fade-in-up recommendation-performance-page">
      <div
        className="page-header-modern performance-hero"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <div>
          <div className="performance-kicker">Recommendation Alpha Lab</div>
          <h1 className="page-title-modern">推荐绩效实验室</h1>
          <p className="page-subtitle-modern">
            用真实后验收益淘汰无效推荐：跟踪胜率、盈亏比、MFE/MAE 与标的贡献，形成可赚钱的投研闭环。
          </p>
          <div className="tail-agent-strip">
            <span>Tail Agent Ledger</span>
            <strong>
              {agentSession ? agentSessionLabelMap[agentSession] || agentSession : '全场次'} ·{' '}
              {selectedHorizonStats?.count || 0} 个已完成样本 · 均收{' '}
              {formatPct(selectedHorizonStats?.avg_return_pct)}
            </strong>
          </div>
        </div>
        <Space wrap>
          <Select
            value={horizon}
            onChange={setHorizon}
            options={horizonOptions}
            style={{ width: 110 }}
          />
          <Select
            value={sourceType}
            onChange={setSourceType}
            options={sourceOptions}
            style={{ width: 150 }}
          />
          <Select
            value={agentSession}
            onChange={setAgentSession}
            options={agentSessionOptions}
            style={{ width: 130 }}
          />
          <Select
            value={decision}
            onChange={setDecision}
            options={decisionOptions}
            style={{ width: 130 }}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchDashboard} loading={loading}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<ExperimentOutlined />}
            onClick={refreshPerformance}
            loading={refreshing}
          >
            重新验证并写飞书
          </Button>
          <Button icon={<TrophyOutlined />} onClick={reportQualityDaily} loading={reporting}>
            生成质量日报
          </Button>
        </Space>
      </div>

      <Alert
        type={agentSession === 'close' ? 'success' : 'info'}
        showIcon
        style={{ marginBottom: 16 }}
        message={
          agentSession === 'close' ? '尾盘 Agent 建议收益追踪已开启' : '如何使用这张看板赚钱'
        }
        description={
          agentSession === 'close'
            ? '收盘/尾盘 TradingAgents 建议会带 close 场次标签归档；每日 15:25 自动验证 1/3/5/10/20 日收益并写入飞书，用于判断 Agent 尾盘建议是否具备稳定 alpha。'
            : '只放大在目标周期胜率、期望收益和盈亏比同时为正的信号来源/风格；对平均 MAE 过大的方向降仓，对连续跑输的标的从候选池降权。'
        }
      />

      <Card
        className="modern-card quality-daily-card"
        variant="borderless"
        title="信号来源质量日报"
        extra={<Text type="secondary">30日窗口 · {horizon}</Text>}
        style={{ marginBottom: 16 }}
      >
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} lg={7}>
            <div className="quality-daily-score">
              <span>Quality Ledger</span>
              <strong>{qualityReport?.overview?.quality_score ?? 0}</strong>
              <em>{qualityReport?.overview?.gate?.label || '等待样本'}</em>
            </div>
          </Col>
          <Col xs={24} lg={5}>
            <div className="quality-health-grid">
              <div>
                <span>no_data</span>
                <strong>{qualityReport?.data_health?.no_data_signals ?? 0}</strong>
              </div>
              <div>
                <span>缺行情</span>
                <strong>{qualityReport?.data_health?.missing_bars ?? 0}</strong>
              </div>
              <div>
                <span>周期未完</span>
                <strong>{qualityReport?.data_health?.insufficient_horizon_bars ?? 0}</strong>
              </div>
              <div>
                <span>已修复</span>
                <strong>{qualityReport?.repair_summary?.inserted_bars ?? 0}</strong>
              </div>
            </div>
          </Col>
          <Col xs={24} lg={7}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {(qualityReport?.action_items || []).slice(0, 4).map((item, index) => (
                <div className="quality-action-line" key={`action-${index}`}>
                  {item}
                </div>
              ))}
              {!qualityReport?.action_items?.length && (
                <Text type="secondary">等待完成样本形成后，系统会自动给出放大/降权动作。</Text>
              )}
            </Space>
          </Col>
          <Col xs={24} lg={5}>
            <Row gutter={[8, 8]}>
              {(qualityReport?.best_segments || []).slice(0, 3).map(item => (
                <Col span={24} key={`${item.dimension}-${item.key}`}>
                  <div className="quality-rank-line">
                    <Text strong>{item.label || item.key}</Text>
                    <Tag color="red">{item.quality_score}分</Tag>
                    <Text style={{ color: returnColor(item.avg_return_pct), fontWeight: 800 }}>
                      {formatPct(item.avg_return_pct)}
                    </Text>
                  </div>
                </Col>
              ))}
              {!qualityReport?.best_segments?.length && (
                <Col span={24}>
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无排行榜样本" />
                </Col>
              )}
            </Row>
          </Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={9}>
          <Card className="modern-card playbook-command-card" variant="borderless">
            <div className="playbook-command-head">
              <div>
                <Text type="secondary">Profit Gate</Text>
                <div className="playbook-command-title">收益闸门建议</div>
              </div>
              <Badge status={gateTone.badge} text={playbookGate?.label || '等待样本'} />
            </div>
            <div className="playbook-command-score">
              {playbook?.overall?.quality_score ?? 0}
              <span>/100</span>
            </div>
            <Paragraph className="playbook-command-reason">
              {playbookGate?.reason || '暂无完成后验样本，先保持观察，不放大仓位。'}
            </Paragraph>
            <Space wrap>
              <Tag color="volcano">
                建议仓位倍率 {formatMultiplier(playbookGate?.position_multiplier)}
              </Tag>
              <Tag>{horizon} 持有周期</Tag>
              <Tag>{playbook?.min_samples || 5} 样本后启用放大</Tag>
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={15}>
          <Card
            className="modern-card playbook-segment-card"
            variant="borderless"
            title="可赚钱片段排行"
            extra={<Text type="secondary">按质量分排序</Text>}
          >
            <Table
              columns={playbookColumns}
              dataSource={playbook?.best_segments || []}
              rowKey={record => `${record.dimension}-${record.key}`}
              size="small"
              pagination={false}
              locale={{
                emptyText: <Empty description="等待 5d/10d 样本形成后自动给出放大/降权建议" />,
              }}
            />
          </Card>
        </Col>
        {Boolean(playbook?.risk_notes?.length) && (
          <Col span={24}>
            <Alert
              type="warning"
              showIcon
              message="当前执行提醒"
              description={(playbook?.risk_notes || []).join('；')}
            />
          </Col>
        )}
      </Row>

      {sourceType === 'quant_recommendation' && (
        <Card
          className="modern-card consensus-signal-card"
          variant="borderless"
          title="多策略共识信号前瞻收益"
          extra={<Text type="secondary">{horizon} 后验 · 共识 vs 非共识</Text>}
          style={{ marginBottom: 16 }}
        >
          <Row gutter={[16, 16]} align="middle">
            <Col xs={24} lg={7}>
              <Statistic
                title="共识样本均收"
                value={consensusEdge.avg_return_pct}
                precision={2}
                suffix="%"
                valueStyle={{ color: returnColor(consensusEdge.avg_return_pct) }}
              />
              <Text type="secondary">
                共识完成样本 {consensusEdge.total} 个；相对无共识{' '}
                <Text strong style={{ color: returnColor(consensusEdge.edge) }}>
                  {consensusEdge.edge >= 0 ? '+' : ''}
                  {consensusEdge.edge.toFixed(2)}%
                </Text>
              </Text>
            </Col>
            <Col xs={24} lg={7}>
              <Statistic
                title="最强共识层"
                value={consensusEdge.best?.avg_return_pct || 0}
                precision={2}
                suffix="%"
                valueStyle={{ color: returnColor(consensusEdge.best?.avg_return_pct) }}
              />
              <Text type="secondary">
                {(consensusEdge.best as any)?.label ||
                  consensusLabelMap[consensusEdge.best?.key || ''] ||
                  '等待样本'}
              </Text>
            </Col>
            <Col xs={24} lg={10}>
              <Space wrap>
                {consensusBuckets.map(bucket => (
                  <Tag
                    key={bucket.key}
                    color={
                      bucket.key === 'no_consensus'
                        ? 'default'
                        : Number(bucket.avg_return_pct || 0) >= 0
                        ? 'purple'
                        : 'orange'
                    }
                  >
                    {(bucket as any).label || consensusLabelMap[bucket.key || ''] || bucket.key}：
                    {bucket.count}样本 / 均收 {formatPct(bucket.avg_return_pct)} / 胜率{' '}
                    {formatPct(bucket.positive_rate)}
                  </Tag>
                ))}
                {!consensusBuckets.length && <Text type="secondary">等待共识信号后验样本</Text>}
              </Space>
            </Col>
          </Row>
        </Card>
      )}

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={8} xl={5}>
          <Card className="modern-card performance-score-card" variant="borderless">
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Text type="secondary">Alpha Edge Score</Text>
              <div className="performance-score-value">{edgeScore.toFixed(0)}</div>
              <Progress percent={Math.round(edgeScore)} showInfo={false} strokeColor="#9f6b25" />
              <Text type="secondary">基于均收、胜率与盈亏比的综合边际</Text>
            </Space>
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="总信号"
              value={overview?.total_signals || 0}
              prefix={<AimOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title={`${horizon} 样本`}
              value={selectedHorizonStats?.count || 0}
              prefix={<FieldTimeOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="平均收益"
              value={selectedHorizonStats?.avg_return_pct || 0}
              precision={2}
              suffix="%"
              valueStyle={{ color: returnColor(selectedHorizonStats?.avg_return_pct) }}
              prefix={<RiseOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="胜率"
              value={selectedHorizonStats?.positive_rate || 0}
              precision={1}
              suffix="%"
              prefix={<TrophyOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={3}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="盈亏比"
              value={selectedHorizonStats?.payoff_ratio || 0}
              precision={2}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={14}>
          <Card
            className="modern-card"
            variant="borderless"
            title="累计推荐收益曲线"
            extra={<Text type="secondary">{data?.generated_at || '--'}</Text>}
          >
            <div style={{ height: 320 }}>
              {data?.equity_curve?.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data.equity_curve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.2)" />
                    <XAxis dataKey="date" tick={{ fontSize: 12 }} minTickGap={24} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(value: any) => `${Number(value).toFixed(2)}%`} />
                    <Area
                      type="monotone"
                      dataKey="cumulative_return_pct"
                      fill="rgba(159,107,37,0.16)"
                      stroke="#9f6b25"
                      strokeWidth={2.4}
                      name="累计收益"
                    />
                    <Line
                      type="monotone"
                      dataKey="drawdown_pct"
                      stroke="#137333"
                      dot={false}
                      strokeDasharray="4 4"
                      name="回撤"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <Empty description="暂无完成样本，先归档推荐并等待后验周期" />
              )}
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card className="modern-card" variant="borderless" title="不同持有周期表现">
            <div style={{ height: 320 }}>
              {data?.horizon_summary?.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.horizon_summary}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.2)" />
                    <XAxis dataKey="horizon" />
                    <YAxis yAxisId="left" />
                    <YAxis yAxisId="right" orientation="right" />
                    <Tooltip
                      formatter={(value: any, name: any) =>
                        String(name).includes('胜率')
                          ? `${Number(value).toFixed(1)}%`
                          : `${Number(value).toFixed(2)}%`
                      }
                    />
                    <Bar
                      yAxisId="left"
                      dataKey="avg_return_pct"
                      fill="#9f6b25"
                      radius={[8, 8, 0, 0]}
                      name="平均收益"
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="positive_rate"
                      stroke="#1f3a5f"
                      strokeWidth={2.2}
                      name="胜率"
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <Empty description="暂无周期统计" />
              )}
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={12}>
          <Card className="modern-card" variant="borderless" title="建议类型表现">
            <Table
              columns={groupColumns}
              dataSource={data?.by_decision || []}
              rowKey="key"
              size="small"
              pagination={false}
              loading={loading}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card className="modern-card" variant="borderless" title="月度推荐质量">
            <div style={{ height: 250 }}>
              {monthlyBuckets.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={monthlyBuckets}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.2)" />
                    <XAxis dataKey="month" />
                    <YAxis />
                    <Tooltip formatter={(value: any) => `${Number(value).toFixed(2)}%`} />
                    <Area
                      type="monotone"
                      dataKey="avg_return_pct"
                      stroke="#1f3a5f"
                      fill="rgba(31,58,95,0.14)"
                      name="月均收益"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <Empty description="暂无月度样本" />
              )}
            </div>
          </Card>
        </Col>
      </Row>

      <Card
        className="modern-card"
        variant="borderless"
        title="最赚钱标的贡献"
        style={{ marginBottom: 16 }}
      >
        <Row gutter={[12, 12]}>
          {(data?.top_symbols || []).slice(0, 8).map((item, index) => (
            <Col xs={24} sm={12} lg={6} key={item.symbol}>
              <div className="performance-symbol-card">
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Text strong>
                      {index + 1}. {item.name || item.symbol}
                    </Text>
                    <Tag>{item.count}样本</Tag>
                  </Space>
                  <Text type="secondary">
                    {item.symbol} · 最近 {item.latest_signal_date || '--'}
                  </Text>
                  <Statistic
                    value={item.avg_return_pct}
                    precision={2}
                    suffix="%"
                    valueStyle={{ color: returnColor(item.avg_return_pct), fontSize: 22 }}
                  />
                  <Paragraph style={{ margin: 0 }} type="secondary">
                    胜率 {formatPct(item.positive_rate, 1)} · 盈亏比{' '}
                    {Number(item.payoff_ratio || 0).toFixed(2)}
                  </Paragraph>
                </Space>
              </div>
            </Col>
          ))}
          {!data?.top_symbols?.length && (
            <Col span={24}>
              <Empty description="暂无标的贡献样本" />
            </Col>
          )}
        </Row>
      </Card>

      <Card
        className="modern-card"
        variant="borderless"
        title="最近完成的信号样本"
        extra={<LineChartOutlined />}
      >
        <Table
          columns={recentColumns}
          dataSource={data?.recent_signals || []}
          rowKey={record => `${record.signal_id}-${record.horizon}`}
          loading={loading}
          size="small"
          scroll={{ x: 980 }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          locale={{ emptyText: <Empty description="暂无完成样本" /> }}
        />
      </Card>
    </div>
  );
};

export default RecommendationPerformance;
