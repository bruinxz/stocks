import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  message,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
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
import { Link, useLocation, useNavigate } from 'react-router-dom';
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
import PaperTrading from './PaperTrading';

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
  account_key?: string;
  account_label?: string;
  account_name?: string;
  portfolio_id?: number;
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
  account_key?: string;
  account_label?: string;
  account_name?: string;
  portfolio_id?: number;
  created_at: string;
}

interface EquityPoint {
  date: string;
  total_value: number;
  current_cash: number;
  position_value: number;
  total_return_pct: number;
}

interface PortfolioFamily {
  key: string;
  label: string;
  name: string;
  description: string;
  exists?: boolean;
  portfolio_id?: number | null;
  total_value?: number;
  current_cash?: number;
  position_value?: number;
  total_pnl?: number;
  total_return_pct?: number;
  cash_pct?: number;
  exposure_pct?: number;
  initial_capital?: number;
  open_position_count?: number;
  trade_count?: number;
  outcome_count?: number;
  closed_outcome_count?: number;
  open_outcome_count?: number;
  win_rate?: number;
  avg_closed_return_pct?: number;
  latest_trade_at?: string | null;
  latest_intent_at?: string | null;
  last_activity_at?: string | null;
  run_status?: 'not_created' | 'ready_empty' | 'signaled_blocked' | 'active' | 'traded_flat';
  run_status_label?: string;
  empty_reason?: string;
  diagnostics?: {
    is_initialized?: boolean;
    has_positions?: boolean;
    has_trades?: boolean;
    has_order_intents?: boolean;
    primary_blocker?: { category: string; label: string; count: number } | null;
    latest_intent_reason?: string | null;
    default_hint?: string;
  };
  recent_intent_summary?: {
    total: number;
    planned_count: number;
    executed_count: number;
    rejected_count: number;
    skipped_count: number;
    held_count: number;
    latest_intent_at?: string | null;
    latest_intent?: {
      symbol?: string;
      name?: string;
      side?: string;
      status?: string;
      status_label?: string;
      reason_category?: string;
      reason_label?: string;
      reason_text?: string;
      reference_price?: number;
      amount?: number;
      created_at?: string;
    } | null;
    top_statuses?: Array<{ status: string; label: string; count: number }>;
    top_reason_categories?: Array<{ category: string; label: string; count: number }>;
    recent_examples?: Array<Record<string, any>>;
  };
}

interface FamilyHindsightItem {
  portfolio_id: number;
  portfolio_name: string;
  total_count: number;
  evaluated_count: number;
  pending_count: number;
  false_reject_count: number;
  saved_loss_count: number;
  avg_intended_action_return_pct: number;
  false_reject_rate: number;
  saved_loss_rate: number;
  action: string;
  action_label: string;
  top_reason_categories?: Array<{ key: string; label: string; count: number }>;
  top_false_rejections?: Array<{
    intent_id: number;
    symbol: string;
    name?: string;
    reason_category_label?: string;
    reason_text?: string;
    intent_date?: string;
    side_label?: string;
    status?: string;
    intended_action_return_pct?: number;
    benchmark_conclusion?: string;
  }>;
  top_saved_losses?: Array<{
    intent_id: number;
    symbol: string;
    name?: string;
    reason_category_label?: string;
    reason_text?: string;
    intent_date?: string;
    side_label?: string;
    status?: string;
    intended_action_return_pct?: number;
    benchmark_conclusion?: string;
  }>;
  conclusion?: string;
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
  all_open_positions?: Position[];
  all_recent_trades?: Trade[];
  portfolio_family_summary?: {
    generated_at: string;
    families: PortfolioFamily[];
    summary: {
      family_count: number;
      active_family_count: number;
      open_position_count: number;
      total_position_value: number;
      total_pnl: number;
      champion?: PortfolioFamily;
      most_active?: PortfolioFamily;
      conclusion?: string;
    };
  };
  family_order_intent_hindsight?: {
    generated_at: string;
    summary: {
      portfolio_count: number;
      evaluated_count: number;
      false_reject_count: number;
      saved_loss_count: number;
      avg_intended_action_return_pct: number;
      conclusion?: string;
    };
    families: FamilyHindsightItem[];
  } | null;
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

const orderIntentStatusTag = (status?: string, label?: string) => {
  const colorMap: Record<string, string> = {
    planned: 'blue',
    executed: 'green',
    rejected: 'volcano',
    skipped: 'default',
    held: 'cyan',
  };
  const labelMap: Record<string, string> = {
    planned: '预演',
    executed: '成交',
    rejected: '拒单',
    skipped: '跳过',
    held: '持有',
  };
  return (
    <Tag color={colorMap[status || ''] || 'default'}>
      {label || labelMap[status || ''] || status || '未知'}
    </Tag>
  );
};

const accountTagColor = (key?: string) => {
  const colorMap: Record<string, string> = {
    legacy_autonomous: 'blue',
    quant_only: 'geekblue',
    quant_agent_fusion: 'purple',
    agent_only: 'cyan',
    param_experiment: 'gold',
    quant_trend_breakout: 'volcano',
    quant_momentum_rotation: 'magenta',
    quant_mean_reversion: 'green',
    quant_multi_factor_quality: 'blue',
    quant_low_vol_defensive: 'lime',
    quant_volume_price: 'orange',
  };
  return colorMap[key || ''] || 'default';
};

const familyRunStatusColor = (status?: string) => {
  const colorMap: Record<string, string> = {
    active: 'green',
    traded_flat: 'cyan',
    signaled_blocked: 'orange',
    ready_empty: 'blue',
    not_created: 'default',
  };
  return colorMap[status || ''] || 'default';
};

const formatShortTime = (value?: string | null) => {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const AutonomousTradingOverview: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [riskChecking, setRiskChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastAction, setLastAction] = useState<ActionDigest | null>(null);
  const [selectedFamilyKey, setSelectedFamilyKey] = useState<string | null>(null);

  const fetchDashboard = async (silent = false) => {
    setLoading(true);
    try {
      const response = await getAutonomousTradingDashboard({ lookback_days: 60, limit: 120 });
      if (response.data.success) {
        setData(response.data.data);
        if (!silent) message.success('交易驾驶舱已刷新');
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
        enable_trailing_take_profit: true,
        enable_sell_signals: true,
        use_adaptive_risk_policy: true,
        adaptive_risk_lookback_days: 180,
        adaptive_risk_min_closed_samples: 5,
        adaptive_risk_override_signal_params: false,
        default_stop_loss_pct: 7,
        default_take_profit_pct: 14,
        trailing_activation_pct: 8,
        trailing_drawdown_pct: 4,
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
  const familySummary = data?.portfolio_family_summary;
  const familyHindsight = data?.family_order_intent_hindsight;
  const portfolioFamilies = useMemo(() => familySummary?.families || [], [familySummary]);
  const familyHindsightByPortfolioId = useMemo(() => {
    const map = new Map<number, FamilyHindsightItem>();
    (familyHindsight?.families || []).forEach(item => {
      map.set(Number(item.portfolio_id), item);
    });
    return map;
  }, [familyHindsight]);
  const selectedFamily = useMemo(
    () => portfolioFamilies.find(item => item.key === selectedFamilyKey) || null,
    [portfolioFamilies, selectedFamilyKey]
  );
  const selectedFamilyHindsight = selectedFamily?.portfolio_id
    ? familyHindsightByPortfolioId.get(Number(selectedFamily.portfolio_id))
    : undefined;
  const totalOpenPositions =
    familySummary?.summary?.open_position_count || summary?.open_position_count || 0;
  const activeFamilies = portfolioFamilies.filter(
    item => item.exists && Number(item.open_position_count || 0) > 0
  );
  const visiblePositions = data?.all_open_positions?.length
    ? data.all_open_positions
    : data?.positions || [];
  const visibleTrades = data?.all_recent_trades?.length
    ? data.all_recent_trades
    : data?.recent_trades || [];
  const activeTab =
    new URLSearchParams(location.search).get('tab') === 'manual' ? 'manual' : 'auto';
  const hasOpenRisk = Number(totalOpenPositions || trackingSummary?.open_count || 0) > 0;
  const hasLoopFeedback = Number(summary?.closed_recommendation_count || 0) > 0;
  const primaryFocus = !hasOpenRisk
    ? '暂无持仓，先看新推荐'
    : hasLoopFeedback
    ? '先看收益，再调仓'
    : '先执行风控，继续沉淀闭环';

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
      title: '账户',
      dataIndex: 'account_label',
      key: 'account_label',
      width: 138,
      render: (_: string, record: Position) => (
        <Tag color={accountTagColor(record.account_key)}>{record.account_label || '综合盘'}</Tag>
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
      title: '账户',
      dataIndex: 'account_label',
      key: 'account_label',
      width: 138,
      render: (_: string, record: Trade) => (
        <Tag color={accountTagColor(record.account_key)}>{record.account_label || '综合盘'}</Tag>
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
      <div className="trading-focus-guide">
        <div>
          <span>先看这里</span>
          <strong>
            {familySummary?.summary
              ? `${totalOpenPositions}只持仓 / ${formatSignedMoney(
                  familySummary.summary.total_pnl
                )}`
              : summary?.total_pnl !== undefined
              ? `${formatSignedMoney(summary.total_pnl)} / ${formatPercent(
                  summary.total_return_pct
                )}`
              : '等待模拟盘数据'}
          </strong>
          <em>全部策略账户汇总，不只看综合盘</em>
        </div>
        <div>
          <span>今天要做什么</span>
          <strong>{primaryFocus}</strong>
          <em>
            {totalOpenPositions} 只持仓待检查，{activeFamilies.length || 0} 个账户已建仓
          </em>
        </div>
        <div>
          <span>入口合并说明</span>
          <strong>交易驾驶舱 = 模拟交易台</strong>
          <em>自动闭环和手动模拟交易放在同一页</em>
        </div>
      </div>

      <Tabs
        className="trading-mode-tabs"
        activeKey={activeTab}
        onChange={key =>
          navigate(
            key === 'manual'
              ? '/autonomous-trading/overview?tab=manual'
              : '/autonomous-trading/overview'
          )
        }
        items={[
          {
            key: 'auto',
            label: (
              <span>
                <FundProjectionScreenOutlined /> 自动闭环驾驶舱
              </span>
            ),
          },
          {
            key: 'manual',
            label: (
              <span>
                <AccountBookOutlined /> 手动模拟交易
              </span>
            ),
          },
        ]}
      />

      {activeTab === 'manual' ? (
        <div className="trading-merged-panel">
          <PaperTrading />
        </div>
      ) : (
        <>
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
                  <Button icon={<NodeIndexOutlined />}>查看每日推荐</Button>
                </Link>
              </Space>
            </div>
            <div className="autonomous-hero-meter">
              <span>PORTFOLIO NAV</span>
              <strong>
                {formatMoney(summary?.total_value || data?.portfolio?.total_value || 200000)}
              </strong>
              <em style={{ color: pnlColor(summary?.total_pnl) }}>
                综合盘 {formatSignedMoney(summary?.total_pnl)} / 全部持仓 {totalOpenPositions} 只
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
                  初始资金{' '}
                  {formatMoney(summary?.initial_capital || data?.guardrails?.initial_capital)}
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
                  综合盘现金 {formatPercent(summary?.cash_pct)} / 全部账户持仓 {totalOpenPositions}{' '}
                  只
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

          <Card className="modern-card autonomous-family-board" loading={loading}>
            <div className="autonomous-family-heading">
              <div>
                <span>ACCOUNT MAP</span>
                <h2>策略账户持仓地图</h2>
              </div>
              <Text type="secondary">
                定时任务已经拆成纯量化、量化+Agent、参数实验等账户；这里汇总全部真实模拟持仓，避免只看综合盘误判为
                0。
              </Text>
            </div>
            <Row gutter={[12, 12]}>
              {portfolioFamilies.map(family => {
                const intentSummary = family.recent_intent_summary;
                const hindsight = family.portfolio_id
                  ? familyHindsightByPortfolioId.get(Number(family.portfolio_id))
                  : undefined;
                const primaryBlocker =
                  family.diagnostics?.primary_blocker ||
                  intentSummary?.top_reason_categories?.[0] ||
                  null;
                const isLive = Number(family.open_position_count || 0) > 0;
                return (
                  <Col xs={24} md={12} xl={8} key={family.key}>
                    <div
                      className={`autonomous-family-card ${
                        isLive ? 'active' : family.run_status || 'ready_empty'
                      }`}
                    >
                      <div className="autonomous-family-topline">
                        <Space wrap size={6}>
                          <Tag color={accountTagColor(family.key)}>{family.label}</Tag>
                          <Tag color={familyRunStatusColor(family.run_status)}>
                            {family.run_status_label || (family.exists ? '已就绪' : '未初始化')}
                          </Tag>
                        </Space>
                        <Space size={6}>
                          <span>{formatShortTime(family.last_activity_at)}</span>
                          <Button
                            size="small"
                            type="link"
                            className="autonomous-family-detail-btn"
                            onClick={() => setSelectedFamilyKey(family.key)}
                          >
                            诊断
                          </Button>
                        </Space>
                      </div>
                      <strong>{formatMoney(family.total_value)}</strong>
                      <p>{family.empty_reason || family.description}</p>
                      <div className="autonomous-family-metrics">
                        <span>持仓 {family.open_position_count || 0}</span>
                        <span>交易 {family.trade_count || 0}</span>
                        <span>订单意图 {intentSummary?.total || 0}</span>
                        <span>收益 {formatPercent(family.total_return_pct)}</span>
                        <span>暴露 {formatPercent(family.exposure_pct)}</span>
                      </div>
                      {hindsight ? (
                        <div className="autonomous-family-hindsight-strip">
                          <span>拒单后验</span>
                          <strong>
                            错杀 {hindsight.false_reject_count} / 避险 {hindsight.saved_loss_count}
                          </strong>
                          <em>{hindsight.action_label}</em>
                        </div>
                      ) : null}
                      <div className="autonomous-family-diagnostics">
                        <div>
                          <span>成交</span>
                          <strong>{intentSummary?.executed_count || 0}</strong>
                        </div>
                        <div>
                          <span>拦截/跳过</span>
                          <strong>
                            {(intentSummary?.rejected_count || 0) +
                              (intentSummary?.skipped_count || 0)}
                          </strong>
                        </div>
                        <div>
                          <span>主因</span>
                          <strong>{primaryBlocker?.label || '等待信号'}</strong>
                        </div>
                      </div>
                      {intentSummary?.latest_intent ? (
                        <div className="autonomous-family-latest">
                          最近：
                          {intentSummary.latest_intent.name || intentSummary.latest_intent.symbol}
                          {' · '}
                          {intentSummary.latest_intent.status_label}
                          {intentSummary.latest_intent.reason_text
                            ? ` · ${intentSummary.latest_intent.reason_text}`
                            : ''}
                        </div>
                      ) : (
                        <div className="autonomous-family-latest">
                          {family.diagnostics?.default_hint || family.description}
                        </div>
                      )}
                    </div>
                  </Col>
                );
              })}
              {!portfolioFamilies.length && (
                <Col span={24}>
                  <Empty description="暂无策略账户数据" />
                </Col>
              )}
            </Row>
            {familySummary?.summary?.conclusion ? (
              <Alert
                className="autonomous-family-note"
                showIcon
                type="success"
                message={familySummary.summary.conclusion}
              />
            ) : null}
            {familyHindsight?.summary ? (
              <div className="autonomous-hindsight-board">
                <div className="autonomous-hindsight-head">
                  <div>
                    <span>REJECTION HINDSIGHT</span>
                    <strong>拒单后验雷达</strong>
                  </div>
                  <p>{familyHindsight.summary.conclusion}</p>
                </div>
                <div className="autonomous-hindsight-stats">
                  <div>
                    <span>已评估</span>
                    <strong>{familyHindsight.summary.evaluated_count}</strong>
                  </div>
                  <div>
                    <span>可能错杀</span>
                    <strong>{familyHindsight.summary.false_reject_count}</strong>
                  </div>
                  <div>
                    <span>有效避险</span>
                    <strong>{familyHindsight.summary.saved_loss_count}</strong>
                  </div>
                  <div>
                    <span>平均相对</span>
                    <strong
                      style={{
                        color: pnlColor(familyHindsight.summary.avg_intended_action_return_pct),
                      }}
                    >
                      {formatPercent(familyHindsight.summary.avg_intended_action_return_pct)}
                    </strong>
                  </div>
                </div>
                <div className="autonomous-hindsight-family-list">
                  {(familyHindsight.families || []).slice(0, 5).map(item => (
                    <div key={item.portfolio_id}>
                      <span>{item.portfolio_name.replace('Codex', '').replace('（20W）', '')}</span>
                      <strong>{item.action_label}</strong>
                      <em>
                        {item.conclusion ||
                          `错杀 ${item.false_reject_count} / 避险 ${item.saved_loss_count}`}
                      </em>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </Card>

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
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,.08)" />
                      <XAxis dataKey="date" stroke="rgba(75,85,101,.58)" tick={{ fontSize: 12 }} />
                      <YAxis stroke="rgba(75,85,101,.58)" tick={{ fontSize: 12 }} />
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
                      <span>{totalOpenPositions} 只股票正在模拟持仓中</span>
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
                    当前持仓（全部策略账户）
                  </Space>
                }
                extra={<Text type="secondary">共 {totalOpenPositions} 只，按账户区分来源</Text>}
                loading={loading}
              >
                <Table
                  rowKey={record => `${record.symbol}-${record.id || ''}`}
                  columns={positionColumns}
                  dataSource={visiblePositions}
                  pagination={false}
                  locale={{ emptyText: <Empty description="暂无持仓，等待自动跟单信号" /> }}
                  scroll={{ x: 960 }}
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
                    <Empty description="暂无每日推荐数据" />
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
                  dataSource={visibleTrades}
                  pagination={{ pageSize: 8 }}
                  locale={{ emptyText: <Empty description="暂无模拟交易流水" /> }}
                  scroll={{ x: 900 }}
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
                  <p>
                    {data?.guardrails?.capital_rule || '收益仅用于策略反馈，不代表真实账户交易。'}
                  </p>
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

          <Drawer
            width={760}
            open={Boolean(selectedFamily)}
            onClose={() => setSelectedFamilyKey(null)}
            className="autonomous-family-drawer"
            title={
              selectedFamily ? (
                <Space wrap>
                  <Tag color={accountTagColor(selectedFamily.key)}>{selectedFamily.label}</Tag>
                  <span>{selectedFamily.name}</span>
                </Space>
              ) : (
                '策略账户诊断'
              )
            }
          >
            {selectedFamily ? (
              <div className="family-dossier">
                <div
                  className={`family-dossier-hero ${selectedFamily.run_status || 'ready_empty'}`}
                >
                  <div>
                    <span>ACCOUNT DOSSIER</span>
                    <h2>{selectedFamily.run_status_label || '账户诊断'}</h2>
                    <p>{selectedFamily.empty_reason || selectedFamily.description}</p>
                  </div>
                  <div>
                    <strong>{formatMoney(selectedFamily.total_value)}</strong>
                    <em style={{ color: pnlColor(selectedFamily.total_pnl) }}>
                      {formatSignedMoney(selectedFamily.total_pnl)} /{' '}
                      {formatPercent(selectedFamily.total_return_pct)}
                    </em>
                  </div>
                </div>

                <div className="family-dossier-stat-grid">
                  <div>
                    <span>持仓 / 暴露</span>
                    <strong>
                      {selectedFamily.open_position_count || 0} /{' '}
                      {formatPercent(selectedFamily.exposure_pct)}
                    </strong>
                  </div>
                  <div>
                    <span>成交 / 交易</span>
                    <strong>
                      {selectedFamily.recent_intent_summary?.executed_count || 0} /{' '}
                      {selectedFamily.trade_count || 0}
                    </strong>
                  </div>
                  <div>
                    <span>拒单+跳过</span>
                    <strong>
                      {(selectedFamily.recent_intent_summary?.rejected_count || 0) +
                        (selectedFamily.recent_intent_summary?.skipped_count || 0)}
                    </strong>
                  </div>
                  <div>
                    <span>后验动作</span>
                    <strong>{selectedFamilyHindsight?.action_label || '等待样本'}</strong>
                  </div>
                </div>

                <div className="family-dossier-section">
                  <div className="family-dossier-section-head">
                    <span>RUN PATH</span>
                    <strong>运行链路判断</strong>
                  </div>
                  <div className="family-dossier-path">
                    <div className={selectedFamily.exists ? 'done' : 'wait'}>
                      <CheckCircleOutlined />
                      <strong>账户初始化</strong>
                      <span>{selectedFamily.exists ? '已创建策略账户' : '尚未创建账户'}</span>
                    </div>
                    <div
                      className={selectedFamily.diagnostics?.has_order_intents ? 'done' : 'wait'}
                    >
                      <NodeIndexOutlined />
                      <strong>信号进入</strong>
                      <span>{selectedFamily.recent_intent_summary?.total || 0} 条订单意图</span>
                    </div>
                    <div className={selectedFamily.diagnostics?.has_trades ? 'done' : 'wait'}>
                      <ThunderboltOutlined />
                      <strong>模拟成交</strong>
                      <span>{selectedFamily.trade_count || 0} 笔交易流水</span>
                    </div>
                    <div
                      className={
                        Number(selectedFamilyHindsight?.evaluated_count || 0) > 0 ? 'done' : 'wait'
                      }
                    >
                      <RadarChartOutlined />
                      <strong>后验反馈</strong>
                      <span>{selectedFamilyHindsight?.conclusion || '等待未来K线验证'}</span>
                    </div>
                  </div>
                </div>

                <div className="family-dossier-section">
                  <div className="family-dossier-section-head">
                    <span>BLOCKERS</span>
                    <strong>主要拦截规则</strong>
                  </div>
                  {selectedFamily.recent_intent_summary?.top_reason_categories?.length ? (
                    <div className="family-dossier-reason-grid">
                      {selectedFamily.recent_intent_summary.top_reason_categories.map(item => (
                        <div key={item.category}>
                          <strong>{item.label}</strong>
                          <span>{item.count} 次</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无拦截规则样本" />
                  )}
                </div>

                <div className="family-dossier-section">
                  <div className="family-dossier-section-head">
                    <span>RECENT INTENTS</span>
                    <strong>最近订单意图</strong>
                  </div>
                  {selectedFamily.recent_intent_summary?.recent_examples?.length ? (
                    <div className="family-intent-list">
                      {selectedFamily.recent_intent_summary.recent_examples.map((intent: any) => (
                        <div key={intent.id || `${intent.symbol}-${intent.created_at}`}>
                          <div>
                            <strong>{intent.name || intent.symbol}</strong>
                            <span>
                              {intent.symbol} · {intent.side === 'SELL' ? '卖出' : '买入'} ·{' '}
                              {formatShortTime(intent.created_at)}
                            </span>
                          </div>
                          <div>
                            <Space wrap size={4}>
                              {orderIntentStatusTag(intent.status, intent.status_label)}
                              <Tag>{intent.reason_label || '未归类'}</Tag>
                            </Space>
                            <p>
                              {intent.reason_text ||
                                `参考价 ${Number(intent.reference_price || 0).toFixed(
                                  2
                                )}，金额 ${formatMoney(intent.amount)}`}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无订单意图" />
                  )}
                </div>

                <div className="family-dossier-section">
                  <div className="family-dossier-section-head">
                    <span>HINDSIGHT</span>
                    <strong>拒单后验：错杀与避险</strong>
                  </div>
                  {selectedFamilyHindsight ? (
                    <>
                      <div className="family-hindsight-mini-summary">
                        <div>
                          <span>已评估</span>
                          <strong>{selectedFamilyHindsight.evaluated_count}</strong>
                        </div>
                        <div>
                          <span>可能错杀</span>
                          <strong>{selectedFamilyHindsight.false_reject_count}</strong>
                        </div>
                        <div>
                          <span>有效避险</span>
                          <strong>{selectedFamilyHindsight.saved_loss_count}</strong>
                        </div>
                        <div>
                          <span>平均相对</span>
                          <strong
                            style={{
                              color: pnlColor(
                                selectedFamilyHindsight.avg_intended_action_return_pct
                              ),
                            }}
                          >
                            {formatPercent(selectedFamilyHindsight.avg_intended_action_return_pct)}
                          </strong>
                        </div>
                      </div>
                      <Row gutter={[12, 12]}>
                        <Col xs={24} md={12}>
                          <div className="family-hindsight-list false-reject">
                            <strong>可能错杀 Top</strong>
                            {(selectedFamilyHindsight.top_false_rejections || [])
                              .slice(0, 4)
                              .map(item => (
                                <div key={item.intent_id}>
                                  <span>
                                    {item.name || item.symbol} ·{' '}
                                    {formatPercent(item.intended_action_return_pct)}
                                  </span>
                                  <em>
                                    {item.reason_category_label || '规则拦截'}：
                                    {item.reason_text || item.benchmark_conclusion || '暂无明细'}
                                  </em>
                                </div>
                              ))}
                            {!selectedFamilyHindsight.top_false_rejections?.length ? (
                              <p>暂无明显错杀样本。</p>
                            ) : null}
                          </div>
                        </Col>
                        <Col xs={24} md={12}>
                          <div className="family-hindsight-list saved-loss">
                            <strong>有效避险 Top</strong>
                            {(selectedFamilyHindsight.top_saved_losses || [])
                              .slice(0, 4)
                              .map(item => (
                                <div key={item.intent_id}>
                                  <span>
                                    {item.name || item.symbol} ·{' '}
                                    {formatPercent(item.intended_action_return_pct)}
                                  </span>
                                  <em>
                                    {item.reason_category_label || '规则拦截'}：
                                    {item.reason_text || item.benchmark_conclusion || '暂无明细'}
                                  </em>
                                </div>
                              ))}
                            {!selectedFamilyHindsight.top_saved_losses?.length ? (
                              <p>暂无明显避险样本。</p>
                            ) : null}
                          </div>
                        </Col>
                      </Row>
                    </>
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无后验数据" />
                  )}
                </div>
              </div>
            ) : null}
          </Drawer>
        </>
      )}
    </div>
  );
};

export default AutonomousTradingOverview;
