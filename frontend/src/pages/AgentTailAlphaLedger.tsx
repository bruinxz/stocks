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
  AuditOutlined,
  FieldTimeOutlined,
  FireOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  RiseOutlined,
  SafetyCertificateOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import api from '../services/api';

const { Text, Paragraph } = Typography;

type Gate = {
  action: string;
  label: string;
  severity: string;
  position_multiplier: number;
  reason: string;
};

type LedgerBucket = {
  key: string;
  label: string;
  count: number;
  avg_return_pct: number;
  avg_excess_return_pct: number;
  directional_success_rate: number;
  directional_excess_success_rate: number;
  positive_rate: number;
  payoff_ratio: number;
  profit_factor: number;
  avg_mfe_pct: number;
  avg_mae_pct: number;
  quality_score: number;
  gate: Gate;
  horizon?: string;
  horizon_days?: number;
};

type LatestRecommendation = {
  signal_id: number;
  symbol: string;
  name?: string;
  signal_date: string;
  decision: string;
  confidence_score?: number;
  risk_level?: string;
  rationale?: string;
  verification_status: string;
  completed_for_primary_horizon: boolean;
  horizons: Record<
    string,
    {
      status: string;
      return_pct?: number;
      excess_return_pct?: number;
      directional_return_pct?: number;
      exit_date?: string;
    }
  >;
};

type LedgerData = {
  generated_at: string;
  filters: Record<string, any>;
  summary: {
    total_signals: number;
    pending_signals: number;
    no_data_signals: number;
    completed_primary_samples: number;
    completed_all_samples: number;
    overall: LedgerBucket;
    best_horizon?: LedgerBucket | null;
    action: string;
    gate: Gate;
  };
  horizon_summary: LedgerBucket[];
  by_decision: LedgerBucket[];
  by_risk_level: LedgerBucket[];
  by_confidence: LedgerBucket[];
  by_month: LedgerBucket[];
  best_symbols: LedgerBucket[];
  weak_symbols: LedgerBucket[];
  portfolio_curve: Array<{
    date: string;
    signal_id: number;
    symbol: string;
    name?: string;
    return_pct: number;
    excess_return_pct: number;
    cumulative_return_pct: number;
    cumulative_excess_return_pct: number;
    drawdown_pct: number;
  }>;
  latest_recommendations: LatestRecommendation[];
  insights: string[];
  next_actions: string[];
};

const horizonOptions = ['1d', '3d', '5d', '10d', '20d'].map(value => ({ label: value, value }));
const lookbackOptions = [
  { label: '近60天', value: 60 },
  { label: '近180天', value: 180 },
  { label: '近365天', value: 365 },
  { label: '全部样本', value: 1200 },
];

const decisionLabelMap: Record<string, string> = {
  strong_buy: '强买',
  buy: '买入',
  hold: '持有',
  sell: '卖出',
  strong_sell: '强卖',
  unknown: '未知',
};

const decisionColorMap: Record<string, string> = {
  strong_buy: 'magenta',
  buy: 'red',
  hold: 'gold',
  sell: 'green',
  strong_sell: 'cyan',
  unknown: 'default',
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
  <Text style={{ color: returnColor(value), fontWeight: 900 }}>{formatPct(value)}</Text>
);

const AgentTailAlphaLedger: React.FC = () => {
  const [data, setData] = useState<LedgerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [horizon, setHorizon] = useState('5d');
  const [lookbackDays, setLookbackDays] = useState(180);

  const fetchLedger = async (silent = false) => {
    setLoading(true);
    try {
      const response = await api.get('/ai/signals/agent-tail-ledger', {
        params: {
          horizon,
          horizons: '1d,3d,5d,10d,20d',
          lookback_days: lookbackDays,
          min_samples: 5,
          limit: 5000,
        },
      });
      if (response.data.success) {
        setData(response.data.data);
        if (!silent) message.success('尾盘 Agent Alpha 账本已刷新');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取尾盘 Agent Alpha 账本失败');
    } finally {
      setLoading(false);
    }
  };

  const refreshPerformance = async () => {
    setRefreshing(true);
    try {
      const response = await api.post('/ai/signals/performance/refresh', {
        source_type: 'tradingagents',
        agent_session: 'close',
        horizon,
        limit: 1200,
        record_type: 'Agent尾盘建议收益追踪',
        report_to_feishu: true,
      });
      if (response.data.success) {
        const verified = response.data.data.verification?.verified || 0;
        const pending = response.data.data.verification?.pending || 0;
        message.success(`尾盘建议收益刷新完成：验证 ${verified} 条，等待 ${pending} 条`);
        await fetchLedger(true);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '刷新尾盘建议收益失败');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchLedger(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizon, lookbackDays]);

  const summary = data?.summary;
  const overall = summary?.overall;
  const gate = summary?.gate;
  const gateTone = gateToneMap[gate?.severity || 'neutral'] || gateToneMap.neutral;

  const alphaScore = useMemo(() => {
    if (!overall?.count) return 0;
    const excess = Math.max(-10, Math.min(10, Number(overall.avg_excess_return_pct || 0))) * 4;
    const winRate =
      Math.max(0, Math.min(100, Number(overall.directional_excess_success_rate || 0))) * 0.36;
    const payoff = Math.min(3, Number(overall.payoff_ratio || 0)) * 9;
    return Math.max(0, Math.min(100, excess + winRate + payoff));
  }, [overall]);

  const bucketColumns = [
    {
      title: '片段',
      key: 'segment',
      render: (_: any, record: LedgerBucket) => (
        <Space direction="vertical" size={2}>
          <Text strong>{record.label || record.key}</Text>
          <Text type="secondary">{record.count} 个完成样本</Text>
        </Space>
      ),
    },
    {
      title: '质量分',
      dataIndex: 'quality_score',
      key: 'quality_score',
      width: 120,
      render: (value: number) => (
        <Progress percent={value || 0} size="small" strokeColor="#d6a64f" />
      ),
      sorter: (a: LedgerBucket, b: LedgerBucket) => a.quality_score - b.quality_score,
    },
    {
      title: '平均超额',
      dataIndex: 'avg_excess_return_pct',
      key: 'avg_excess_return_pct',
      width: 120,
      render: (value: number) => renderReturn(value),
      sorter: (a: LedgerBucket, b: LedgerBucket) =>
        a.avg_excess_return_pct - b.avg_excess_return_pct,
    },
    {
      title: '方向胜率',
      dataIndex: 'directional_excess_success_rate',
      key: 'directional_excess_success_rate',
      width: 120,
      render: (value: number) => <Text strong>{formatPct(value, 1)}</Text>,
    },
    {
      title: '闸门',
      key: 'gate',
      width: 130,
      render: (_: any, record: LedgerBucket) => {
        const tone = gateToneMap[record.gate?.severity || 'neutral'] || gateToneMap.neutral;
        return <Tag color={tone.color}>{record.gate?.label || '--'}</Tag>;
      },
    },
  ];

  const latestColumns = [
    {
      title: '尾盘建议',
      key: 'signal',
      width: 260,
      render: (_: any, record: LatestRecommendation) => (
        <Space direction="vertical" size={2}>
          <Space wrap>
            <Text strong>{record.name || record.symbol}</Text>
            <Tag color={decisionColorMap[record.decision] || 'default'}>
              {decisionLabelMap[record.decision] || record.decision}
            </Tag>
            <Tag>{record.risk_level || 'risk?'}</Tag>
          </Space>
          <Text type="secondary">
            {record.symbol} · {record.signal_date} · 置信 {record.confidence_score ?? '--'}
          </Text>
          {record.rationale && <Text type="secondary">{record.rationale}</Text>}
        </Space>
      ),
    },
    ...['1d', '3d', '5d', '10d', '20d'].map(item => ({
      title: item,
      key: item,
      width: 105,
      render: (_: any, record: LatestRecommendation) => {
        const value = record.horizons?.[item];
        if (!value || value.status !== 'completed') {
          return <Tag color="default">{value?.status || 'pending'}</Tag>;
        }
        return (
          <Space direction="vertical" size={0}>
            {renderReturn(value.directional_return_pct ?? value.return_pct)}
            <Text type="secondary">超额 {formatPct(value.excess_return_pct, 1)}</Text>
          </Space>
        );
      },
    })),
  ];

  return (
    <div className="agent-tail-ledger-page fade-in-up">
      <div className="agent-tail-hero">
        <div className="agent-tail-copy">
          <div className="agent-tail-kicker">Tail Agent Alpha Ledger</div>
          <h1>Agent 尾盘建议 Alpha 账本</h1>
          <p>
            把 TradingAgents 在收盘/尾盘给出的建议沉淀为可复盘资产，持续观察 1/3/5/10/20
            日收益、超额收益和方向胜率，验证它到底能不能给自动荐股贡献 alpha。
          </p>
          <Space wrap>
            <Tag icon={<AuditOutlined />}>尾盘建议归档</Tag>
            <Tag icon={<FieldTimeOutlined />}>多周期收益追踪</Tag>
            <Tag icon={<SafetyCertificateOutlined />}>Profit Gate 放大/降权</Tag>
          </Space>
        </div>
        <div className="agent-tail-command">
          <span>ALPHA SCORE</span>
          <strong>{alphaScore.toFixed(0)}</strong>
          <em>
            {gate?.label || '等待样本'} · 仓位倍率 {gate?.position_multiplier ?? 0}x
          </em>
        </div>
      </div>

      <Card className="modern-card agent-tail-toolbar" variant="borderless">
        <Space wrap>
          <Select
            value={horizon}
            onChange={setHorizon}
            options={horizonOptions}
            style={{ width: 110 }}
          />
          <Select
            value={lookbackDays}
            onChange={setLookbackDays}
            options={lookbackOptions}
            style={{ width: 130 }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => fetchLedger(false)} loading={loading}>
            刷新账本
          </Button>
          <Button
            type="primary"
            icon={<RadarChartOutlined />}
            onClick={refreshPerformance}
            loading={refreshing}
          >
            重新验证并写飞书
          </Button>
          <Text type="secondary">最后生成：{data?.generated_at || '--'}</Text>
        </Space>
      </Card>

      <Alert
        type={gate?.severity === 'good' ? 'success' : gate?.severity === 'bad' ? 'warning' : 'info'}
        showIcon
        style={{ marginBottom: 16 }}
        message={`尾盘 Agent 当前动作：${gate?.label || '等待样本'}`}
        description={gate?.reason || '等待更多完成样本后再决定是否放大自动模拟盘跟单。'}
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={7}>
          <Card className="modern-card agent-tail-gate-card" variant="borderless">
            <div className="agent-tail-gate-head">
              <div>
                <Text type="secondary">Profit Gate</Text>
                <h3>尾盘建议闸门</h3>
              </div>
              <Badge status={gateTone.badge} text={gate?.label || '等待样本'} />
            </div>
            <div className="agent-tail-gate-score">{overall?.quality_score || 0}</div>
            <Paragraph>{gate?.reason || '暂无完成样本。'}</Paragraph>
            <Space wrap>
              <Tag color="volcano">倍率 {gate?.position_multiplier ?? 0}x</Tag>
              <Tag>{horizon}</Tag>
              <Tag>样本 {overall?.count || 0}</Tag>
            </Space>
          </Card>
        </Col>
        <Col xs={12} md={6} lg={4}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="尾盘建议"
              value={summary?.total_signals || 0}
              prefix={<FireOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6} lg={4}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="完成样本"
              value={summary?.completed_primary_samples || 0}
              prefix={<TrophyOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6} lg={4}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="平均超额"
              value={overall?.avg_excess_return_pct || 0}
              precision={2}
              suffix="%"
              valueStyle={{ color: returnColor(overall?.avg_excess_return_pct) }}
              prefix={<RiseOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6} lg={5}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="方向超额胜率"
              value={overall?.directional_excess_success_rate || 0}
              precision={1}
              suffix="%"
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={15}>
          <Card className="modern-card" variant="borderless" title="尾盘 Agent 组合收益曲线">
            <div style={{ height: 330 }}>
              {data?.portfolio_curve?.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.portfolio_curve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.2)" />
                    <XAxis dataKey="date" minTickGap={24} />
                    <YAxis />
                    <Tooltip formatter={(value: any) => `${Number(value).toFixed(2)}%`} />
                    <Area
                      type="monotone"
                      dataKey="cumulative_excess_return_pct"
                      stroke="#d6a64f"
                      fill="rgba(214,166,79,.18)"
                      strokeWidth={2.4}
                      name="累计超额"
                    />
                    <Line
                      type="monotone"
                      dataKey="drawdown_pct"
                      stroke="#137333"
                      strokeDasharray="4 4"
                      dot={false}
                      name="回撤"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <Empty description="暂无完成样本，等待尾盘建议后验周期成熟" />
              )}
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card className="modern-card" variant="borderless" title="持有周期对比">
            <div style={{ height: 330 }}>
              {data?.horizon_summary?.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.horizon_summary}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.2)" />
                    <XAxis dataKey="horizon" />
                    <YAxis yAxisId="left" />
                    <YAxis yAxisId="right" orientation="right" />
                    <Tooltip formatter={(value: any) => `${Number(value).toFixed(2)}%`} />
                    <Bar
                      yAxisId="left"
                      dataKey="avg_excess_return_pct"
                      fill="#d6a64f"
                      radius={[10, 10, 0, 0]}
                      name="平均超额"
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="directional_excess_success_rate"
                      stroke="#1f3a5f"
                      strokeWidth={2.3}
                      name="方向胜率"
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <Empty description="暂无周期样本" />
              )}
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={11}>
          <Card className="modern-card" variant="borderless" title="决策/置信片段">
            <Table
              columns={bucketColumns}
              dataSource={[...(data?.by_decision || []), ...(data?.by_confidence || [])].slice(
                0,
                10
              )}
              rowKey={record => `${record.key}-${record.label}`}
              pagination={false}
              loading={loading}
              size="small"
              locale={{ emptyText: <Empty description="暂无片段样本" /> }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={13}>
          <Card className="modern-card" variant="borderless" title="最佳 / 最弱标的片段">
            <Row gutter={[12, 12]}>
              <Col xs={24} md={12}>
                <div className="agent-tail-symbol-panel winner">
                  <h3>值得继续观察</h3>
                  {(data?.best_symbols || []).slice(0, 5).map(item => (
                    <div className="agent-tail-symbol-line" key={`best-${item.key}`}>
                      <span>{item.label}</span>
                      <strong>{formatPct(item.avg_excess_return_pct)}</strong>
                      <em>{item.count}样本</em>
                    </div>
                  ))}
                  {!data?.best_symbols?.length && (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无最佳标的" />
                  )}
                </div>
              </Col>
              <Col xs={24} md={12}>
                <div className="agent-tail-symbol-panel weak">
                  <h3>应降权/冷却</h3>
                  {(data?.weak_symbols || []).slice(0, 5).map(item => (
                    <div className="agent-tail-symbol-line" key={`weak-${item.key}`}>
                      <span>{item.label}</span>
                      <strong>{formatPct(item.avg_excess_return_pct)}</strong>
                      <em>{item.count}样本</em>
                    </div>
                  ))}
                  {!data?.weak_symbols?.length && (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无弱势标的" />
                  )}
                </div>
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={10}>
          <Card
            className="modern-card agent-tail-insight-card"
            variant="borderless"
            title="账本结论"
          >
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
              {(data?.insights || []).map((item, index) => (
                <div className="agent-tail-note" key={`insight-${index}`}>
                  {item}
                </div>
              ))}
              {!data?.insights?.length && <Empty description="暂无结论" />}
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card
            className="modern-card agent-tail-insight-card"
            variant="borderless"
            title="下一步动作"
          >
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
              {(data?.next_actions || []).map((item, index) => (
                <div className="agent-tail-note action" key={`action-${index}`}>
                  {item}
                </div>
              ))}
              {!data?.next_actions?.length && <Empty description="暂无动作建议" />}
            </Space>
          </Card>
        </Col>
      </Row>

      <Card className="modern-card" variant="borderless" title="最近尾盘建议多周期跟踪">
        <Table
          columns={latestColumns}
          dataSource={data?.latest_recommendations || []}
          rowKey="signal_id"
          loading={loading}
          scroll={{ x: 920 }}
          pagination={{ pageSize: 8, showSizeChanger: true }}
          locale={{ emptyText: <Empty description="暂无尾盘 Agent 建议" /> }}
        />
      </Card>
    </div>
  );
};

export default AgentTailAlphaLedger;
