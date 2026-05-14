import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  InputNumber,
  message,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import {
  AccountBookOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  FilterOutlined,
  FireOutlined,
  FundProjectionScreenOutlined,
  LineChartOutlined,
  NodeIndexOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { getRecommendationTracking, runAutonomousRiskCheck } from '../services/api';

const { Text, Paragraph } = Typography;

interface TrackingItem {
  signal_id: number;
  source_type: string;
  source_label: string;
  source_id: string;
  loop_run_id?: string;
  symbol: string;
  name?: string;
  signal_date: string;
  decision: string;
  decision_label: string;
  command: string;
  command_label: string;
  score?: number;
  risk_level?: string;
  action?: string;
  action_label?: string;
  recommendation_tier_label?: string;
  data_quality_bucket?: string;
  data_quality_score?: number;
  status: string;
  status_label: string;
  entry_date?: string;
  exit_date?: string;
  entry_price?: number;
  exit_price?: number;
  latest_price?: number;
  quantity?: number;
  simulated_pnl?: number;
  simulated_pnl_pct?: number;
  realized_pnl?: number;
  unrealized_pnl?: number;
  holding_days?: number;
  exit_reason_label?: string;
  rationale?: string;
  warnings?: string[];
  reasons?: string[];
  forward_return?: {
    horizon?: string;
    status?: string;
    return_pct?: number;
  };
}

interface DailyGroup {
  date: string;
  total: number;
  buy_count: number;
  sell_count: number;
  open_count: number;
  closed_count: number;
  simulated_pnl: number;
  top_symbols: Array<{
    symbol: string;
    name?: string;
    command: string;
    score?: number;
    status: string;
  }>;
}

interface TrackingData {
  generated_at: string;
  filters: Record<string, any>;
  portfolio: {
    id: number;
    name: string;
    initial_capital: number;
    total_value: number;
  };
  summary: {
    total_signals: number;
    buy_signals: number;
    sell_signals: number;
    open_count: number;
    closed_count: number;
    watch_count: number;
    candidate_count: number;
    total_simulated_pnl: number;
    avg_simulated_pnl_pct: number;
    win_rate: number;
  };
  daily_groups: DailyGroup[];
  items: TrackingItem[];
}

const sourceOptions = [
  { label: '全部来源', value: 'all' },
  { label: '全市场量化候选', value: 'quant_recommendation' },
  { label: 'TradingAgents 深度复核', value: 'tradingagents' },
  { label: 'AI 每日优选', value: 'daily_screener' },
];

const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '待跟单候选', value: 'candidate' },
  { label: '模拟持仓中', value: 'open' },
  { label: '已闭环结算', value: 'closed' },
  { label: '卖出信号', value: 'sell_signal' },
  { label: '观察中', value: 'watch' },
  { label: '已跳过', value: 'skipped' },
  { label: '未交易', value: 'not_traded' },
];

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

const statusTag = (status?: string, label?: string) => {
  const colorMap: Record<string, string> = {
    candidate: 'gold',
    watch: 'blue',
    sell_signal: 'orange',
    open: 'cyan',
    closed: 'purple',
    skipped: 'default',
    not_traded: 'default',
  };
  return <Tag color={colorMap[status || ''] || 'default'}>{label || status || '未知'}</Tag>;
};

const commandTag = (command?: string, label?: string) => {
  const colorMap: Record<string, string> = {
    buy: 'red',
    sell: 'green',
    watch: 'blue',
    avoid: 'default',
  };
  return <Tag color={colorMap[command || ''] || 'default'}>{label || command || '未知'}</Tag>;
};

const riskTag = (risk?: string) => {
  const normalized = String(risk || '').toLowerCase();
  if (!normalized) return <Tag>未标注</Tag>;
  if (normalized.includes('high')) return <Tag color="red">高风险</Tag>;
  if (normalized.includes('medium')) return <Tag color="orange">中风险</Tag>;
  if (normalized.includes('low')) return <Tag color="green">低风险</Tag>;
  return <Tag>{risk}</Tag>;
};

const AutonomousRecommendationTracker: React.FC = () => {
  const [data, setData] = useState<TrackingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [riskChecking, setRiskChecking] = useState(false);
  const [sourceType, setSourceType] = useState('all');
  const [status, setStatus] = useState('all');
  const [lookbackDays, setLookbackDays] = useState(60);

  const fetchTracking = async (silent = false) => {
    setLoading(true);
    try {
      const response = await getRecommendationTracking({
        lookback_days: lookbackDays,
        source_type: sourceType,
        status,
        limit: 500,
      });
      if (response.data.success) {
        setData(response.data.data);
        if (!silent) message.success('每日推荐追踪已刷新');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取推荐追踪失败');
    } finally {
      setLoading(false);
    }
  };

  const runRiskCheck = async () => {
    setRiskChecking(true);
    try {
      const response = await runAutonomousRiskCheck({
        dry_run: false,
        report_to_feishu: true,
        enable_stop_loss: true,
        enable_take_profit: true,
        enable_sell_signals: true,
        default_stop_loss_pct: 7,
        default_take_profit_pct: 14,
        max_hold_days: 20,
        min_sell_signal_score: 60,
        sell_signal_source_type: 'all',
      });
      if (response.data.success) {
        message.success(response.data.message || '卖出/风控结算完成');
        await fetchTracking(true);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '卖出/风控结算失败');
    } finally {
      setRiskChecking(false);
    }
  };

  useEffect(() => {
    fetchTracking(true);
    // 页面首次进入时按默认筛选拉取一次，后续由“应用筛选”按钮显式刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dailyGroups = useMemo(() => data?.daily_groups || [], [data]);

  const columns = [
    {
      title: '日期 / 股票',
      key: 'symbol',
      fixed: 'left' as const,
      width: 210,
      render: (_: any, record: TrackingItem) => (
        <Space direction="vertical" size={2}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary" className="mono-text">
            {record.symbol} · {record.signal_date}
          </Text>
        </Space>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source_label',
      key: 'source_label',
      width: 150,
      render: (value: string, record: TrackingItem) => (
        <Space direction="vertical" size={2}>
          <Tag color={record.source_type === 'tradingagents' ? 'purple' : 'blue'}>{value}</Tag>
          {record.recommendation_tier_label ? (
            <Text type="secondary">{record.recommendation_tier_label}</Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '指令 / 状态',
      key: 'command',
      width: 160,
      render: (_: any, record: TrackingItem) => (
        <Space direction="vertical" size={4}>
          {commandTag(record.command, record.command_label)}
          {statusTag(record.status, record.status_label)}
        </Space>
      ),
    },
    {
      title: '评分',
      key: 'score',
      width: 120,
      align: 'right' as const,
      render: (_: any, record: TrackingItem) => (
        <Space direction="vertical" size={2}>
          <Text strong>{Number(record.score || 0).toFixed(1)}</Text>
          {riskTag(record.risk_level)}
        </Space>
      ),
    },
    {
      title: '价格',
      key: 'price',
      width: 156,
      align: 'right' as const,
      render: (_: any, record: TrackingItem) => (
        <Space direction="vertical" size={2}>
          <Text>入场 {Number(record.entry_price || 0).toFixed(2)}</Text>
          <Text type="secondary">
            {record.exit_price
              ? `退出 ${Number(record.exit_price || 0).toFixed(2)}`
              : `最新 ${Number(record.latest_price || 0).toFixed(2)}`}
          </Text>
        </Space>
      ),
    },
    {
      title: '模拟收益',
      key: 'pnl',
      width: 150,
      align: 'right' as const,
      render: (_: any, record: TrackingItem) => (
        <Space direction="vertical" size={2}>
          <Text strong style={{ color: pnlColor(record.simulated_pnl) }}>
            {formatSignedMoney(record.simulated_pnl)}
          </Text>
          <Text style={{ color: pnlColor(record.simulated_pnl_pct) }}>
            {formatPercent(record.simulated_pnl_pct)}
          </Text>
        </Space>
      ),
    },
    {
      title: '持有 / 退出',
      key: 'holding',
      width: 150,
      render: (_: any, record: TrackingItem) => (
        <Space direction="vertical" size={2}>
          <Text>{Number(record.holding_days || 0)} 天</Text>
          <Text type="secondary">
            {record.exit_reason_label || record.exit_date || record.entry_date || '-'}
          </Text>
        </Space>
      ),
    },
    {
      title: '核心理由',
      key: 'rationale',
      width: 340,
      render: (_: any, record: TrackingItem) => {
        const text =
          record.rationale || record.reasons?.join('；') || record.warnings?.join('；') || '-';
        return (
          <Tooltip title={text}>
            <Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 0, maxWidth: 320 }}>
              {text}
            </Paragraph>
          </Tooltip>
        );
      },
    },
  ];

  return (
    <div className="autonomous-page autonomous-tracker fade-in-up">
      <div className="page-header-modern autonomous-tracker-header">
        <div>
          <div className="autonomous-kicker dark">RECOMMENDATION EXECUTION LEDGER</div>
          <h1 className="page-title-modern">每日推荐追踪</h1>
          <p className="page-subtitle-modern">
            每一条推荐都会被记录：推荐日、买入/观察/卖出指令、是否进入模拟盘、当前收益，以及卖出命令触发后的结算结果。
          </p>
        </div>
        <Space wrap>
          <Link to="/autonomous-trading/overview">
            <Button icon={<FundProjectionScreenOutlined />}>收益驾驶舱</Button>
          </Link>
          <Button
            icon={<SafetyCertificateOutlined />}
            loading={riskChecking}
            onClick={runRiskCheck}
          >
            执行卖出/结算
          </Button>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => fetchTracking()}
          >
            刷新追踪
          </Button>
        </Space>
      </div>

      <Alert
        className="autonomous-alert"
        showIcon
        type="warning"
        message="结算规则"
        description="当系统产生卖出信号，或触发止损、止盈、最长持有期规则时，模拟盘会卖出对应持仓并把收益写入闭环；未成交推荐仍保留用于后验观察。"
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card className="autonomous-metric-card gold" loading={loading}>
            <ThunderboltOutlined />
            <span>追踪信号</span>
            <strong>{data?.summary.total_signals || 0}</strong>
            <em>
              买入 {data?.summary.buy_signals || 0} / 卖出 {data?.summary.sell_signals || 0}
            </em>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="autonomous-metric-card cyan" loading={loading}>
            <AccountBookOutlined />
            <span>模拟持仓</span>
            <strong>{data?.summary.open_count || 0}</strong>
            <em>
              待跟单 {data?.summary.candidate_count || 0} / 观察 {data?.summary.watch_count || 0}
            </em>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="autonomous-metric-card green" loading={loading}>
            <CheckCircleOutlined />
            <span>已闭环</span>
            <strong>{data?.summary.closed_count || 0}</strong>
            <em>胜率 {formatPercent(data?.summary.win_rate)}</em>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="autonomous-metric-card blue" loading={loading}>
            <LineChartOutlined />
            <span>累计模拟收益</span>
            <strong style={{ color: pnlColor(data?.summary.total_simulated_pnl) }}>
              {formatSignedMoney(data?.summary.total_simulated_pnl)}
            </strong>
            <em>平均闭环 {formatPercent(data?.summary.avg_simulated_pnl_pct)}</em>
          </Card>
        </Col>
      </Row>

      <Card className="modern-card autonomous-filter-card">
        <Space wrap size="middle">
          <FilterOutlined />
          <Select
            style={{ width: 190 }}
            value={sourceType}
            options={sourceOptions}
            onChange={setSourceType}
          />
          <Select
            style={{ width: 160 }}
            value={status}
            options={statusOptions}
            onChange={setStatus}
          />
          <InputNumber
            min={7}
            max={3650}
            value={lookbackDays}
            addonBefore="回看"
            addonAfter="天"
            onChange={value => setLookbackDays(Number(value || 60))}
          />
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => fetchTracking()}
          >
            应用筛选
          </Button>
          <Text type="secondary">更新于 {data?.generated_at || '-'}</Text>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={8}>
          <Card
            className="modern-card autonomous-timeline-card"
            title={
              <Space>
                <ClockCircleOutlined />
                每日推荐时间线
              </Space>
            }
            loading={loading}
          >
            {dailyGroups.length ? (
              <Timeline
                items={dailyGroups.slice(0, 18).map(group => ({
                  color: group.simulated_pnl >= 0 ? 'red' : 'green',
                  children: (
                    <div className="autonomous-day-node">
                      <div className="autonomous-day-head">
                        <strong>{group.date}</strong>
                        <Text style={{ color: pnlColor(group.simulated_pnl) }}>
                          {formatSignedMoney(group.simulated_pnl)}
                        </Text>
                      </div>
                      <Space size={[4, 6]} wrap>
                        <Tag color="blue">总 {group.total}</Tag>
                        <Tag color="red">买 {group.buy_count}</Tag>
                        <Tag color="green">卖 {group.sell_count}</Tag>
                        <Tag color="cyan">持仓 {group.open_count}</Tag>
                        <Tag color="purple">闭环 {group.closed_count}</Tag>
                      </Space>
                      <div className="autonomous-day-symbols">
                        {group.top_symbols.map(item => (
                          <span key={`${group.date}-${item.symbol}`}>
                            {item.name || item.symbol}
                          </span>
                        ))}
                      </div>
                    </div>
                  ),
                }))}
              />
            ) : (
              <Empty description="暂无每日追踪记录" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={16}>
          <Card
            className="modern-card table-card-no-padding autonomous-ledger-card"
            title={
              <Space>
                <NodeIndexOutlined />
                推荐股票收益账本
              </Space>
            }
            extra={
              <Space>
                <Tag color="gold">
                  初始资金 {formatMoney(data?.portfolio?.initial_capital || 200000)}
                </Tag>
                <Tag color="blue">组合 {formatMoney(data?.portfolio?.total_value)}</Tag>
              </Space>
            }
            loading={loading}
          >
            <Table
              rowKey="signal_id"
              columns={columns}
              dataSource={data?.items || []}
              pagination={{ pageSize: 12, showSizeChanger: true }}
              scroll={{ x: 1460 }}
              locale={{ emptyText: <Empty description="暂无符合条件的推荐记录" /> }}
            />
          </Card>
        </Col>
      </Row>

      <Card className="modern-card autonomous-closing-card">
        <div className="autonomous-closing-grid">
          <div>
            <div className="autonomous-kicker dark">WHAT THIS PAGE IS OPTIMIZING</div>
            <h2>把荐股能力变成可度量的交易系统</h2>
            <p>
              不只看“推荐得像不像”，而是看推荐是否能被执行、执行后是否赚钱、卖出是否及时、哪些来源/风险/分数段真正产生正收益。
            </p>
          </div>
          <div className="autonomous-closing-points">
            <span>
              <FireOutlined /> 全市场自动找机会
            </span>
            <span>
              <RadarChartOutlined /> TradingAgents 与量化信号交叉确认
            </span>
            <span>
              <SafetyCertificateOutlined /> 止损止盈和卖出信号自动结算
            </span>
            <span>
              <NodeIndexOutlined /> 收益结果反哺下一轮推荐门槛
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default AutonomousRecommendationTracker;
