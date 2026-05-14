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
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  AccountBookOutlined,
  AimOutlined,
  AlertOutlined,
  ApartmentOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  FieldTimeOutlined,
  FundProjectionScreenOutlined,
  LineChartOutlined,
  NodeIndexOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  TrophyOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  getAutonomousTradingDashboard,
  runAutonomousAutoSync,
  runAutonomousRiskCheck,
} from '../services/api';

const { Text, Paragraph } = Typography;

interface Position {
  id?: number;
  symbol: string;
  name?: string;
  quantity: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  weight_pct: number;
  created_at?: string;
}

interface Trade {
  id: number;
  symbol: string;
  name?: string;
  direction: 'BUY' | 'SELL';
  execute_price: number;
  quantity: number;
  amount: number;
  commission: number;
  realized_pnl?: number | null;
  created_at: string;
}

interface EquityPoint {
  date: string;
  total_value: number;
  current_cash: number;
  position_value: number;
  total_return_pct: number;
}

interface TrackingItem {
  signal_id: number;
  symbol: string;
  name?: string;
  signal_date: string;
  source_label: string;
  command: string;
  command_label: string;
  status: string;
  status_label: string;
  score?: number;
  simulated_pnl?: number;
  simulated_pnl_pct?: number;
  rationale?: string;
}

interface DashboardData {
  generated_at: string;
  portfolio: {
    id: number;
    name: string;
    initial_capital: number;
    current_cash: number;
    total_value: number;
  };
  summary: {
    initial_capital: number;
    total_value: number;
    current_cash: number;
    position_value: number;
    cash_pct: number;
    exposure_pct: number;
    total_pnl: number;
    total_return_pct: number;
    realized_pnl: number;
    unrealized_pnl: number;
    open_position_count: number;
    trade_count: number;
    tracked_recommendation_count: number;
    closed_recommendation_count: number;
    win_rate: number;
    excess_win_rate: number;
    avg_closed_return_pct: number;
  };
  positions: Position[];
  recent_trades: Trade[];
  equity_curve: EquityPoint[];
  recommendation_tracking?: {
    summary: {
      total_signals: number;
      buy_signals: number;
      sell_signals: number;
      open_count: number;
      closed_count: number;
      candidate_count: number;
      total_simulated_pnl: number;
      win_rate: number;
    };
    daily_groups: Array<{
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
    }>;
    items: TrackingItem[];
  } | null;
  outcome_dashboard?: {
    summary?: Record<string, any>;
    feedback?: {
      insights?: string[];
      next_actions?: string[];
      recommended_min_score?: number;
      position_multiplier?: number;
    };
  } | null;
  guardrails: {
    initial_capital: number;
    position_sizing: string;
    sell_rule: string;
    capital_rule: string;
  };
}

interface ActionDigest {
  tone: 'entry' | 'risk';
  title: string;
  description: string;
  metrics: Array<{
    label: string;
    value: string | number;
  }>;
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
const clamp = (value?: number | null) => Math.max(0, Math.min(100, Number(value || 0)));

const directionTag = (direction?: string) =>
  direction === 'BUY' ? <Tag color="red">买入</Tag> : <Tag color="green">卖出</Tag>;

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

const AutonomousTradingOverview: React.FC = () => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [riskChecking, setRiskChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastAction, setLastAction] = useState<ActionDigest | null>(null);

  const fetchDashboard = async (silent = false) => {
    setLoading(true);
    try {
      const response = await getAutonomousTradingDashboard({ lookback_days: 60, limit: 120 });
      if (response.data.success) {
        setData(response.data.data);
        if (!silent) message.success('自主模拟盘收益驾驶舱已刷新');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取自主模拟盘失败');
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
        const execution = response.data.data?.execution;
        if (execution) {
          setLastAction({
            tone: 'risk',
            title: execution.dry_run ? '风控预演结果' : '风控结算结果',
            description: execution.dry_run
              ? `本次预演识别出 ${execution.planned || 0} 笔待退出仓位。`
              : `本次已按卖出/止损/止盈规则结算 ${execution.exited || 0} 笔仓位。`,
            metrics: [
              { label: '检查持仓', value: execution.checked || 0 },
              {
                label: execution.dry_run ? '计划退出' : '已退出',
                value: execution.dry_run ? execution.planned || 0 : execution.exited || 0,
              },
              { label: '继续持有', value: execution.held || 0 },
              { label: '跳过', value: execution.skipped || 0 },
            ],
          });
        }
        if (response.data.data?.dashboard) {
          setData(response.data.data.dashboard);
        } else {
          await fetchDashboard(true);
        }
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '卖出/风控结算失败');
    } finally {
      setRiskChecking(false);
    }
  };

  const runAutoSync = async () => {
    setSyncing(true);
    try {
      const response = await runAutonomousAutoSync({
        refresh_recommendations: true,
        universe: 'market',
        style: 'balanced',
        candidate_limit: 12,
        candidate_pool_limit: 360,
        limit: 4,
        scan_limit: 80,
        min_score: 72,
        max_positions: 8,
        default_position_pct: 5,
        max_position_pct: 10,
        report_to_feishu: true,
        verify_signals: true,
        use_entry_risk_guard: true,
        use_profit_gate: true,
        use_outcome_feedback: true,
      });
      if (response.data.success) {
        message.success(response.data.message || '全市场推荐与模拟跟单完成');
        const execution = response.data.data?.execution;
        if (execution) {
          const generated = execution.generated;
          setLastAction({
            tone: 'entry',
            title: execution.dry_run ? '推荐跟单预演结果' : '推荐跟单结果',
            description: generated
              ? `全市场候选 ${generated.analyzed_candidates || 0}/${
                  generated.total_candidates || 0
                }，最终模拟${execution.dry_run ? '计划' : '成交'} ${
                  execution.dry_run ? execution.planned || 0 : execution.executed || 0
                } 笔。`
              : `从已有信号池中扫描 ${execution.scanned || 0} 条，模拟${
                  execution.dry_run ? '计划' : '成交'
                } ${execution.dry_run ? execution.planned || 0 : execution.executed || 0} 笔。`,
            metrics: [
              { label: '扫描信号', value: execution.scanned || 0 },
              { label: '符合条件', value: execution.eligible || 0 },
              {
                label: execution.dry_run ? '计划买入' : '已买入',
                value: execution.dry_run ? execution.planned || 0 : execution.executed || 0,
              },
              { label: '跳过', value: execution.skipped || 0 },
            ],
          });
        }
        if (response.data.data?.dashboard) {
          setData(response.data.data.dashboard);
        } else {
          await fetchDashboard(true);
        }
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '全市场推荐跟单失败');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchDashboard(true);
    // 页面首次进入时拉取一次驾驶舱；筛选参数固定，不需要随函数引用变化重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = data?.summary;
  const trackingSummary = data?.recommendation_tracking?.summary;
  const feedback = data?.outcome_dashboard?.feedback;

  const curve = useMemo(() => {
    if (!data?.equity_curve?.length) {
      const initial = data?.summary?.initial_capital || 200000;
      return [
        {
          date: '启动日',
          total_value: initial,
          current_cash: initial,
          position_value: 0,
          total_return_pct: 0,
        },
      ];
    }
    return data.equity_curve;
  }, [data]);

  const positionColumns = [
    {
      title: '股票',
      dataIndex: 'symbol',
      key: 'symbol',
      render: (_: string, record: Position) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary" className="mono-text">
            {record.symbol}
          </Text>
        </Space>
      ),
    },
    {
      title: '仓位',
      dataIndex: 'weight_pct',
      key: 'weight_pct',
      width: 150,
      render: (value: number) => (
        <Space direction="vertical" size={4} style={{ width: 118 }}>
          <Text strong>{formatPercent(value)}</Text>
          <Progress percent={clamp(value)} showInfo={false} size="small" strokeColor="#d6a64f" />
        </Space>
      ),
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      align: 'right' as const,
      render: (value: number) => Number(value || 0).toLocaleString('zh-CN'),
    },
    {
      title: '成本 / 现价',
      key: 'price',
      align: 'right' as const,
      render: (_: any, record: Position) => (
        <Space direction="vertical" size={0}>
          <Text>{Number(record.avg_cost || 0).toFixed(2)}</Text>
          <Text type="secondary">{Number(record.current_price || 0).toFixed(2)}</Text>
        </Space>
      ),
    },
    {
      title: '市值',
      dataIndex: 'market_value',
      key: 'market_value',
      align: 'right' as const,
      render: (value: number) => formatMoney(value),
    },
    {
      title: '浮盈亏',
      key: 'unrealized_pnl',
      align: 'right' as const,
      render: (_: any, record: Position) => (
        <Space direction="vertical" size={0}>
          <Text strong style={{ color: pnlColor(record.unrealized_pnl) }}>
            {formatSignedMoney(record.unrealized_pnl)}
          </Text>
          <Text style={{ color: pnlColor(record.unrealized_pnl_pct) }}>
            {formatPercent(record.unrealized_pnl_pct)}
          </Text>
        </Space>
      ),
    },
  ];

  const tradeColumns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (value: string) => (value ? value.slice(0, 16).replace('T', ' ') : '-'),
    },
    {
      title: '股票',
      dataIndex: 'symbol',
      key: 'symbol',
      render: (_: string, record: Trade) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary" className="mono-text">
            {record.symbol}
          </Text>
        </Space>
      ),
    },
    {
      title: '方向',
      dataIndex: 'direction',
      key: 'direction',
      width: 76,
      render: directionTag,
    },
    {
      title: '成交价',
      dataIndex: 'execute_price',
      key: 'execute_price',
      align: 'right' as const,
      render: (value: number) => Number(value || 0).toFixed(2),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      align: 'right' as const,
      render: (value: number) => formatMoney(value),
    },
    {
      title: '已实现',
      dataIndex: 'realized_pnl',
      key: 'realized_pnl',
      align: 'right' as const,
      render: (value: number | null) =>
        value === null || value === undefined ? (
          <Text type="secondary">-</Text>
        ) : (
          <Text strong style={{ color: pnlColor(value) }}>
            {formatSignedMoney(value)}
          </Text>
        ),
    },
  ];

  return (
    <div className="autonomous-page autonomous-overview fade-in-up">
      <div className="autonomous-hero">
        <div className="autonomous-hero-grid" />
        <div className="autonomous-hero-content">
          <div className="autonomous-kicker">AUTONOMOUS A-SHARE PAPER ALPHA LOOP</div>
          <h1>自主荐股模拟交易驾驶舱</h1>
          <Paragraph>
            系统以 20W 为默认初始资金，把每日全市场推荐、AI
            复核、自动模拟买入、卖出信号结算和收益反馈放进同一条闭环里。
          </Paragraph>
          <Space wrap className="autonomous-hero-actions">
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => fetchDashboard()}
            >
              刷新驾驶舱
            </Button>
            <Button
              icon={<SafetyCertificateOutlined />}
              loading={riskChecking}
              onClick={runRiskCheck}
            >
              执行卖出/风控结算
            </Button>
            <Button icon={<ThunderboltOutlined />} loading={syncing} onClick={runAutoSync}>
              全市场推荐并模拟跟单
            </Button>
            <Link to="/autonomous-trading/recommendations">
              <Button icon={<NodeIndexOutlined />}>查看每日推荐追踪</Button>
            </Link>
          </Space>
        </div>
        <div className="autonomous-hero-meter">
          <span>PORTFOLIO NAV</span>
          <strong>
            {formatMoney(summary?.total_value || data?.portfolio?.total_value || 200000)}
          </strong>
          <em style={{ color: pnlColor(summary?.total_pnl) }}>
            {formatSignedMoney(summary?.total_pnl)} / {formatPercent(summary?.total_return_pct)}
          </em>
        </div>
      </div>

      <Alert
        className="autonomous-alert"
        showIcon
        type="info"
        message="模拟盘说明"
        description="这里展示的是自主荐股能力的模拟交易闭环，不代表真实账户下单。卖出信号、止损、止盈和最长持有期会触发模拟结算，结算数据会用于后续策略反哺。"
      />

      {lastAction ? (
        <Card className={`modern-card autonomous-action-digest ${lastAction.tone}`}>
          <div className="autonomous-action-copy">
            <div className="autonomous-kicker dark">LATEST LOOP EXECUTION</div>
            <h2>{lastAction.title}</h2>
            <p>{lastAction.description}</p>
          </div>
          <div className="autonomous-action-metrics">
            {lastAction.metrics.map(item => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Row gutter={[16, 16]} className="autonomous-score-row">
        <Col xs={24} sm={12} xl={6}>
          <Card className="autonomous-metric-card gold" loading={loading}>
            <WalletOutlined />
            <span>总资产</span>
            <strong>{formatMoney(summary?.total_value)}</strong>
            <em>
              初始资金 {formatMoney(summary?.initial_capital || data?.guardrails?.initial_capital)}
            </em>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="autonomous-metric-card blue" loading={loading}>
            <FundProjectionScreenOutlined />
            <span>累计收益</span>
            <strong style={{ color: pnlColor(summary?.total_pnl) }}>
              {formatSignedMoney(summary?.total_pnl)}
            </strong>
            <em>
              {formatPercent(summary?.total_return_pct)} / 已实现{' '}
              {formatSignedMoney(summary?.realized_pnl)}
            </em>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="autonomous-metric-card cyan" loading={loading}>
            <RadarChartOutlined />
            <span>当前暴露</span>
            <strong>{formatPercent(summary?.exposure_pct)}</strong>
            <em>
              现金 {formatPercent(summary?.cash_pct)} / 持仓 {summary?.open_position_count || 0} 只
            </em>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="autonomous-metric-card green" loading={loading}>
            <TrophyOutlined />
            <span>闭环胜率</span>
            <strong>{formatPercent(summary?.win_rate)}</strong>
            <em>
              闭环 {summary?.closed_recommendation_count || 0} 笔 / 超额胜率{' '}
              {formatPercent(summary?.excess_win_rate)}
            </em>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card
            className="modern-card autonomous-chart-card"
            title={
              <Space>
                <LineChartOutlined />
                资金曲线与仓位水位
              </Space>
            }
            loading={loading}
          >
            <div style={{ height: 330 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={curve} margin={{ top: 12, right: 18, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="autoNavGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#d6a64f" stopOpacity={0.44} />
                      <stop offset="95%" stopColor="#d6a64f" stopOpacity={0.03} />
                    </linearGradient>
                    <linearGradient id="autoPositionGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00a7c2" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#00a7c2" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(226,236,247,.16)" />
                  <XAxis dataKey="date" stroke="rgba(226,236,247,.62)" tick={{ fontSize: 12 }} />
                  <YAxis stroke="rgba(226,236,247,.62)" tick={{ fontSize: 12 }} />
                  <RechartsTooltip
                    formatter={(value: any, name: string) => [formatMoney(Number(value)), name]}
                    labelFormatter={label => `日期：${label}`}
                  />
                  <Area
                    type="monotone"
                    dataKey="total_value"
                    name="总资产"
                    stroke="#d6a64f"
                    fill="url(#autoNavGradient)"
                    strokeWidth={3}
                  />
                  <Area
                    type="monotone"
                    dataKey="position_value"
                    name="持仓市值"
                    stroke="#00a7c2"
                    fill="url(#autoPositionGradient)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card
            className="modern-card autonomous-command-card"
            title={
              <Space>
                <AimOutlined />
                闭环状态
              </Space>
            }
            loading={loading}
          >
            <div className="autonomous-command-list">
              <div className="autonomous-command-item active">
                <CheckCircleOutlined />
                <div>
                  <strong>全市场候选</strong>
                  <span>{trackingSummary?.total_signals || 0} 条推荐信号进入追踪池</span>
                </div>
              </div>
              <div className="autonomous-command-item">
                <AccountBookOutlined />
                <div>
                  <strong>模拟持仓</strong>
                  <span>{trackingSummary?.open_count || 0} 条推荐正在模拟持仓中</span>
                </div>
              </div>
              <div className="autonomous-command-item">
                <FieldTimeOutlined />
                <div>
                  <strong>收益结算</strong>
                  <span>{trackingSummary?.closed_count || 0} 条推荐已按卖出/风控信号闭环</span>
                </div>
              </div>
              <div className="autonomous-command-item warning">
                <AlertOutlined />
                <div>
                  <strong>策略反哺</strong>
                  <span>
                    胜率 {formatPercent(trackingSummary?.win_rate)}，累计模拟{' '}
                    {formatSignedMoney(trackingSummary?.total_simulated_pnl)}
                  </span>
                </div>
              </div>
            </div>
            {feedback?.insights?.length ? (
              <div className="autonomous-feedback-box">
                <Text strong>系统反馈</Text>
                {feedback.insights.slice(0, 3).map((item, index) => (
                  <p key={index}>{item}</p>
                ))}
              </div>
            ) : null}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card
            className="modern-card table-card-no-padding"
            title={
              <Space>
                <ApartmentOutlined />
                当前持仓
              </Space>
            }
            extra={<Text type="secondary">浮盈亏实时随快照刷新</Text>}
            loading={loading}
          >
            <Table
              rowKey={record => `${record.symbol}-${record.id || ''}`}
              columns={positionColumns}
              dataSource={data?.positions || []}
              pagination={false}
              locale={{ emptyText: <Empty description="暂无持仓，等待自动跟单信号" /> }}
              scroll={{ x: 820 }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card
            className="modern-card table-card-no-padding"
            title={
              <Space>
                <ThunderboltOutlined />
                最近推荐动作
              </Space>
            }
            extra={
              <Link to="/autonomous-trading/recommendations">
                <Button type="link" size="small">
                  全部追踪 <ArrowRightOutlined />
                </Button>
              </Link>
            }
            loading={loading}
          >
            <div className="autonomous-recent-list">
              {data?.recommendation_tracking?.items?.length ? (
                data.recommendation_tracking.items.slice(0, 8).map(item => (
                  <div className="autonomous-signal-row" key={item.signal_id}>
                    <div>
                      <strong>{item.name || item.symbol}</strong>
                      <span>
                        {item.symbol} · {item.signal_date} · {item.source_label}
                      </span>
                    </div>
                    <div className="autonomous-signal-tail">
                      {statusTag(item.status, item.status_label)}
                      <Text style={{ color: pnlColor(item.simulated_pnl) }}>
                        {formatPercent(item.simulated_pnl_pct)}
                      </Text>
                    </div>
                  </div>
                ))
              ) : (
                <Empty description="暂无推荐追踪数据" />
              )}
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card
            className="modern-card table-card-no-padding"
            title={
              <Space>
                <NodeIndexOutlined />
                最近交易流水
              </Space>
            }
            loading={loading}
          >
            <Table
              rowKey="id"
              columns={tradeColumns}
              dataSource={data?.recent_trades || []}
              pagination={{ pageSize: 8 }}
              locale={{ emptyText: <Empty description="暂无模拟交易流水" /> }}
              scroll={{ x: 760 }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card
            className="modern-card autonomous-rules-card"
            title="自主交易纪律"
            loading={loading}
          >
            <div className="autonomous-rule">
              <span>01</span>
              <p>
                {data?.guardrails?.position_sizing ||
                  '默认单票 5%，根据信号质量与收益反馈自动调仓。'}
              </p>
            </div>
            <div className="autonomous-rule">
              <span>02</span>
              <p>
                {data?.guardrails?.sell_rule ||
                  '出现止损、止盈、最长持有期或新的卖出信号时自动模拟结算。'}
              </p>
            </div>
            <div className="autonomous-rule">
              <span>03</span>
              <p>{data?.guardrails?.capital_rule || '收益仅用于策略反馈，不代表真实账户交易。'}</p>
            </div>
            <div className="autonomous-mini-stats">
              <Statistic
                title="推荐最低分建议"
                value={feedback?.recommended_min_score || 72}
                precision={0}
              />
              <Statistic
                title="仓位倍率"
                value={feedback?.position_multiplier || 1}
                precision={2}
              />
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default AutonomousTradingOverview;
