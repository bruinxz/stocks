import React, { useState, useEffect } from 'react';
import {
  Alert,
  Card,
  Row,
  Col,
  Statistic,
  Typography,
  Table,
  Space,
  Tag,
  Button,
  Empty,
  Modal,
  Form,
  Select,
  InputNumber,
  Radio,
  message,
  Spin,
  Progress,
} from 'antd';
import {
  BulbOutlined,
  CloudUploadOutlined,
  FallOutlined,
  FieldTimeOutlined,
  HistoryOutlined,
  PlusOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  RiseOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  TrophyOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from 'recharts';
import api, { getPaperTradingSnapshots } from '../services/api';
import { marketService, Stock } from '../services/marketService';

const { Text } = Typography;

interface PortfolioInfo {
  id: number;
  name: string;
  initial_capital: number;
  current_cash: number;
  total_value: number;
  is_active: boolean;
}

interface Position {
  id: number;
  symbol: string;
  name: string;
  quantity: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
}

interface TradeHistory {
  id: number;
  symbol: string;
  name: string;
  direction: 'BUY' | 'SELL';
  execute_price: number;
  quantity: number;
  amount: number;
  commission: number;
  realized_pnl: number | null;
  created_at: string;
}

interface PortfolioSnapshot {
  date: string;
  total_value: number;
  current_cash: number;
  position_value: number;
}

interface RiskExitItem {
  symbol: string;
  name?: string;
  reason_label?: string;
  reason?: string;
  quantity?: number;
  execute_price?: number;
  realized_pnl?: number;
  pnl_pct?: number;
  holding_days?: number;
  max_profit_pct?: number;
  drawdown_from_peak_pct?: number;
  trailing_stop_price?: number;
  message?: string;
}

interface RiskCheckResult {
  dry_run: boolean;
  checked: number;
  exit_candidates: number;
  exited: number;
  planned: number;
  held: number;
  skipped: number;
  exits: RiskExitItem[];
  held_items: RiskExitItem[];
  skipped_items: RiskExitItem[];
}

interface AttributionBucket {
  key: string;
  label: string;
  count: number;
  closed_count: number;
  open_count: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  avg_return_pct: number;
  win_rate: number;
}

interface AttributionClosedTrade {
  signal_id: number;
  symbol: string;
  name?: string;
  realized_pnl: number;
  realized_pnl_pct: number;
  holding_days: number;
  exit_reason_label?: string;
}

interface AttributionOpenPosition {
  signal_id?: number;
  symbol: string;
  name?: string;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  holding_days: number;
  distance_to_stop_loss_pct?: number;
  risk_state: string;
}

interface PaperTradingAttribution {
  generated_at: string;
  summary: {
    executed_signals: number;
    closed_count: number;
    open_count: number;
    orphan_open_count: number;
    win_count: number;
    loss_count: number;
    total_realized_pnl: number;
    total_unrealized_pnl: number;
    total_pnl: number;
    avg_return_pct: number;
    win_rate: number;
    avg_holding_days: number;
    payoff_ratio: number;
    profit_factor: number;
    open_exposure: number;
    open_exposure_pct: number;
    near_stop_loss_count: number;
    best_trade?: AttributionClosedTrade;
    worst_trade?: AttributionClosedTrade;
    largest_open_loss?: AttributionOpenPosition;
    closest_stop_loss?: AttributionOpenPosition;
  };
  groups: {
    by_source_type: AttributionBucket[];
    by_risk_level: AttributionBucket[];
    by_action: AttributionBucket[];
    by_rating: AttributionBucket[];
    by_exit_reason: AttributionBucket[];
    by_score_bucket: AttributionBucket[];
  };
  closed_trades: AttributionClosedTrade[];
  open_positions: AttributionOpenPosition[];
  feedback: {
    recommended_min_score: number;
    recommended_allowed_risk_levels: string[];
    preferred_source_type?: string;
    strongest_bucket?: string;
    weakest_bucket?: string;
    insights: string[];
    next_actions: string[];
  };
}

interface TradingPlanAction {
  action_type: 'exit' | 'entry' | 'monitor' | 'review';
  priority: 'critical' | 'high' | 'medium' | 'low';
  symbol?: string;
  name?: string;
  action_label: string;
  reason: string;
  instructions: string[];
  quantity?: number;
  reference_price?: number;
  estimated_amount?: number;
  estimated_cash_change?: number;
  estimated_pnl?: number;
  estimated_pnl_pct?: number;
  holding_days?: number;
  score?: number;
  risk_level?: string;
  tags?: string[];
}

interface PaperTradingPlan {
  generated_at: string;
  summary: {
    action_count: number;
    urgent_count: number;
    exit_count: number;
    entry_count: number;
    monitor_count: number;
    review_count: number;
    current_cash: number;
    total_value: number;
    position_value: number;
    planned_sell_cash_inflow: number;
    planned_buy_cash_outflow: number;
    projected_cash_after_plan: number;
    recommended_min_score?: number;
    effective_min_score?: number;
    recommended_allowed_risk_levels?: string[];
    generated_from_closed_samples: number;
    profit_gate_label?: string;
    profit_gate_quality_score?: number;
    profit_gate_position_multiplier?: number;
    outcome_feedback_enabled?: boolean;
    outcome_closed_samples?: number;
    outcome_min_closed_samples?: number;
    outcome_avg_excess_return_pct?: number;
    outcome_excess_win_rate?: number;
    outcome_recommended_min_score?: number;
    outcome_effective_min_score?: number;
    outcome_position_multiplier?: number;
    outcome_reason?: string;
    outcome_blocked_segments?: Array<{
      key: string;
      label: string;
      closed_count: number;
      avg_excess_return_pct: number;
      excess_win_rate?: number;
    }>;
  };
  actions: TradingPlanAction[];
}

const formatMoney = (value?: number | null) =>
  `¥${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatSignedMoney = (value?: number | null) => {
  const num = Number(value || 0);
  const prefix = num > 0 ? '+¥' : num < 0 ? '-¥' : '¥';
  return `${prefix}${Math.abs(num).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const formatPercent = (value?: number | null) => `${Number(value || 0).toFixed(2)}%`;
const pnlColor = (value?: number | null) => (Number(value || 0) >= 0 ? '#cf1322' : '#16a34a');
const clampPercent = (value?: number | null) => Math.max(0, Math.min(100, Number(value || 0)));
const priorityLabelMap: Record<TradingPlanAction['priority'], string> = {
  critical: '紧急',
  high: '高',
  medium: '中',
  low: '低',
};
const priorityColorMap: Record<TradingPlanAction['priority'], string> = {
  critical: 'red',
  high: 'volcano',
  medium: 'gold',
  low: 'blue',
};
const actionTypeLabelMap: Record<TradingPlanAction['action_type'], string> = {
  exit: '退出',
  entry: '入场',
  monitor: '观察',
  review: '复盘',
};

const PaperTrading: React.FC = () => {
  const [portfolio, setPortfolio] = useState<PortfolioInfo | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);

  // 交易 Modal 状态
  const [isTradeModalVisible, setIsTradeModalVisible] = useState(false);
  const [tradeForm] = Form.useForm();
  const [submittingTrade, setSubmittingTrade] = useState(false);

  // 股票搜索状态
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [fetchingStocks, setFetchingStocks] = useState(false);

  // 交易历史状态
  const [isHistoryModalVisible, setIsHistoryModalVisible] = useState(false);
  const [tradeHistory, setTradeHistory] = useState<TradeHistory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // 资金曲线快照状态
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [riskCheckLoading, setRiskCheckLoading] = useState(false);
  const [riskPreviewLoading, setRiskPreviewLoading] = useState(false);
  const [riskResult, setRiskResult] = useState<RiskCheckResult | null>(null);
  const [attribution, setAttribution] = useState<PaperTradingAttribution | null>(null);
  const [attributionLoading, setAttributionLoading] = useState(false);
  const [attributionReportLoading, setAttributionReportLoading] = useState(false);
  const [tradingPlan, setTradingPlan] = useState<PaperTradingPlan | null>(null);
  const [tradingPlanLoading, setTradingPlanLoading] = useState(false);
  const [tradingPlanReportLoading, setTradingPlanReportLoading] = useState(false);

  const fetchPortfolio = async () => {
    setLoading(true);
    try {
      const response = await api.get('/paper-trading');
      if (response.data.success) {
        setPortfolio(response.data.data.portfolio);
        setPositions(response.data.data.positions);
      }
    } catch (error) {
      console.error('Failed to fetch paper trading data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPortfolio();
    fetchStocks(''); // 初始加载股票
    fetchSnapshots();
    fetchAttribution(true);
    fetchTradingPlan(true);
  }, []);

  const fetchSnapshots = async () => {
    try {
      const response = await getPaperTradingSnapshots();
      if (response.data.success) {
        setSnapshots(response.data.data);
      }
    } catch (error) {
      console.error('获取资金曲线快照失败:', error);
    }
  };

  const fetchStocks = async (query: string) => {
    setFetchingStocks(true);
    try {
      const response = await marketService.searchStocks(query, 100);
      setStocks(response.data.stocks);
    } catch (error) {
      console.error('获取股票列表失败:', error);
    } finally {
      setFetchingStocks(false);
    }
  };

  const handleSearchStock = (value: string) => {
    fetchStocks(value || '');
  };

  const showTradeModal = (symbol?: string, direction: 'BUY' | 'SELL' = 'BUY') => {
    tradeForm.resetFields();
    if (symbol) {
      tradeForm.setFieldsValue({ symbol, direction });
    } else {
      tradeForm.setFieldsValue({ direction: 'BUY' });
    }
    setIsTradeModalVisible(true);
  };

  const handleTradeSubmit = async () => {
    try {
      const values = await tradeForm.validateFields();
      setSubmittingTrade(true);
      const response = await api.post('/paper-trading/trade', values);
      if (response.data.success) {
        message.success('交易成功');
        setIsTradeModalVisible(false);
        fetchPortfolio(); // 刷新持仓
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '交易失败');
    } finally {
      setSubmittingTrade(false);
    }
  };

  const showHistoryModal = async () => {
    setIsHistoryModalVisible(true);
    setLoadingHistory(true);
    try {
      const response = await api.get('/paper-trading/history');
      if (response.data.success) {
        setTradeHistory(response.data.data);
      }
    } catch (error) {
      message.error('获取交易历史记录失败');
    } finally {
      setLoadingHistory(false);
    }
  };

  const fetchAttribution = async (silent = false) => {
    setAttributionLoading(true);
    try {
      const response = await api.get('/paper-trading/attribution', {
        params: { include_open: true },
      });
      if (response.data.success) {
        setAttribution(response.data.data);
        if (!silent) message.success('收益归因已刷新');
      }
    } catch (error: any) {
      if (!silent) message.error(error.response?.data?.message || '获取收益归因失败');
    } finally {
      setAttributionLoading(false);
    }
  };

  const reportAttribution = async () => {
    setAttributionReportLoading(true);
    try {
      const response = await api.post('/paper-trading/attribution/report', {
        include_open: true,
      });
      if (response.data.success) {
        setAttribution(response.data.data);
        message.success('收益归因已写入飞书多维表格');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '收益归因上报失败');
    } finally {
      setAttributionReportLoading(false);
    }
  };

  const fetchTradingPlan = async (silent = false) => {
    setTradingPlanLoading(true);
    try {
      const response = await api.get('/paper-trading/plan', {
        params: {
          include_entries: true,
          include_exits: true,
          include_monitor: true,
          source_type: 'quant_recommendation',
          limit: 30,
          entry_limit: 3,
          scan_limit: 100,
          min_score: 72,
          max_positions: 8,
          use_attribution_feedback: true,
          use_profit_gate: true,
          profit_gate_horizon: '5d',
          profit_gate_min_samples: 5,
          profit_gate_min_quality_score: 45,
          profit_gate_allow_sampling: true,
          profit_gate_sampling_multiplier: 0.35,
          use_outcome_feedback: true,
          outcome_feedback_min_closed_samples: 5,
          outcome_feedback_lookback_days: 365,
          outcome_feedback_limit: 2000,
          use_adaptive_risk_policy: true,
          adaptive_risk_lookback_days: 180,
          adaptive_risk_min_closed_samples: 5,
          adaptive_risk_override_signal_params: false,
        },
      });
      if (response.data.success) {
        setTradingPlan(response.data.data);
        if (!silent) message.success('交易计划已刷新');
      }
    } catch (error: any) {
      if (!silent) message.error(error.response?.data?.message || '获取交易计划失败');
    } finally {
      setTradingPlanLoading(false);
    }
  };

  const reportTradingPlan = async () => {
    setTradingPlanReportLoading(true);
    try {
      const response = await api.post('/paper-trading/plan/report', {
        include_entries: true,
        include_exits: true,
        include_monitor: true,
        source_type: 'quant_recommendation',
        limit: 30,
        entry_limit: 3,
        scan_limit: 100,
        min_score: 72,
        max_positions: 8,
        use_attribution_feedback: true,
        use_profit_gate: true,
        profit_gate_horizon: '5d',
        profit_gate_min_samples: 5,
        profit_gate_min_quality_score: 45,
        profit_gate_allow_sampling: true,
        profit_gate_sampling_multiplier: 0.35,
        use_outcome_feedback: true,
        outcome_feedback_min_closed_samples: 5,
        outcome_feedback_lookback_days: 365,
        outcome_feedback_limit: 2000,
        use_adaptive_risk_policy: true,
        adaptive_risk_lookback_days: 180,
        adaptive_risk_min_closed_samples: 5,
        adaptive_risk_override_signal_params: false,
      });
      if (response.data.success) {
        setTradingPlan(response.data.data);
        message.success('交易计划已写入飞书多维表格');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '交易计划上报失败');
    } finally {
      setTradingPlanReportLoading(false);
    }
  };

  const runRiskCheck = async (dryRun: boolean) => {
    const setRunning = dryRun ? setRiskPreviewLoading : setRiskCheckLoading;
    setRunning(true);
    try {
      const response = await api.post('/paper-trading/risk-check', {
        dry_run: dryRun,
        report_to_feishu: !dryRun,
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
      const result = response.data.data as RiskCheckResult;
      setRiskResult(result);
      message.success(
        dryRun
          ? `风控预演完成：计划退出 ${result.planned || 0} 笔，继续持有 ${result.held || 0} 笔`
          : `风控检查完成：模拟卖出 ${result.exited || 0} 笔，继续持有 ${result.held || 0} 笔`
      );
      if (!dryRun) {
        await Promise.all([
          fetchPortfolio(),
          fetchSnapshots(),
          fetchAttribution(true),
          fetchTradingPlan(true),
        ]);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '风控检查失败');
    } finally {
      setRunning(false);
    }
  };

  const total_return = portfolio
    ? ((portfolio.total_value - portfolio.initial_capital) / portfolio.initial_capital) * 100
    : 0;
  const isPositive = total_return >= 0;
  const attributionSummary = attribution?.summary;
  const attributionFeedback = attribution?.feedback;
  const tradingPlanSummary = tradingPlan?.summary;
  const outcomeBlockedSegments = tradingPlanSummary?.outcome_blocked_segments || [];
  const urgentPlanActions = (tradingPlan?.actions || []).filter(action =>
    ['critical', 'high'].includes(action.priority)
  );
  const normalPlanActions = (tradingPlan?.actions || []).filter(action =>
    ['medium', 'low'].includes(action.priority)
  );

  const columns = [
    {
      title: '股票',
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record: Position) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '持有股数',
      dataIndex: 'quantity',
      key: 'quantity',
      render: (val: number) => <Text>{val.toLocaleString()}</Text>,
    },
    {
      title: '持仓成本',
      dataIndex: 'avg_cost',
      key: 'avg_cost',
      render: (val: number) => (
        <Text>
          ¥ {val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      ),
    },
    {
      title: '现价',
      dataIndex: 'current_price',
      key: 'current_price',
      render: (val: number) => (
        <Text>
          ¥ {val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      ),
    },
    {
      title: '持仓市值',
      dataIndex: 'market_value',
      key: 'market_value',
      render: (val: number) => (
        <Text>
          ¥ {val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      ),
    },
    {
      title: '浮动盈亏',
      dataIndex: 'unrealized_pnl',
      key: 'unrealized_pnl',
      render: (val: number) => {
        const color = val >= 0 ? '#cf1322' : '#3f8600';
        return (
          <Text strong style={{ color }}>
            {val > 0 ? '+' : ''}
            {val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </Text>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: Position) => (
        <Space size="small">
          <Button type="link" onClick={() => showTradeModal(record.symbol, 'BUY')}>
            买入
          </Button>
          <Button type="link" danger onClick={() => showTradeModal(record.symbol, 'SELL')}>
            卖出
          </Button>
        </Space>
      ),
    },
  ];

  const historyColumns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (val: string) => new Date(val).toLocaleString(),
    },
    {
      title: '股票',
      key: 'stock',
      render: (_: any, record: TradeHistory) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '方向',
      dataIndex: 'direction',
      key: 'direction',
      render: (val: string) => (
        <Tag color={val === 'BUY' ? 'red' : 'green'}>{val === 'BUY' ? '买入' : '卖出'}</Tag>
      ),
    },
    {
      title: '成交价',
      dataIndex: 'execute_price',
      key: 'execute_price',
      render: (val: number) => `¥ ${val.toFixed(2)}`,
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      render: (val: number) => val.toLocaleString(),
    },
    {
      title: '手续费',
      dataIndex: 'commission',
      key: 'commission',
      render: (val: number) => `¥ ${val.toFixed(2)}`,
    },
    {
      title: '实现盈亏',
      dataIndex: 'realized_pnl',
      key: 'realized_pnl',
      render: (val: number | null) => {
        if (val === null) return '-';
        const color = val >= 0 ? '#cf1322' : '#3f8600';
        return (
          <Text strong style={{ color }}>
            {val > 0 ? '+' : ''}
            {val.toFixed(2)}
          </Text>
        );
      },
    },
  ];

  return (
    <div className="fade-in-up">
      <div
        className="page-header-modern"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <h1 className="page-title-modern">投资组合模拟盘</h1>
          <p className="page-subtitle-modern">实时跟踪您的模拟交易与持仓盈亏</p>
        </div>
        <Space>
          <Button
            icon={<RadarChartOutlined />}
            onClick={() => runRiskCheck(true)}
            loading={riskPreviewLoading}
          >
            风控预演
          </Button>
          <Button
            icon={<SafetyCertificateOutlined />}
            onClick={() => runRiskCheck(false)}
            loading={riskCheckLoading}
          >
            自动风控
          </Button>
          <Button icon={<HistoryOutlined />} onClick={showHistoryModal}>
            交易流水
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => showTradeModal()}>
            快速交易
          </Button>
        </Space>
      </div>

      {riskResult && (
        <Card
          className="modern-card"
          variant="borderless"
          style={{
            marginBottom: 24,
            overflow: 'hidden',
            background:
              'radial-gradient(circle at 12% 18%, rgba(248,113,113,0.28), transparent 28%), linear-gradient(135deg, #111827 0%, #1f2937 46%, #431407 100%)',
            border: '1px solid rgba(251,191,36,0.18)',
            boxShadow: '0 24px 60px rgba(15,23,42,0.22)',
          }}
        >
          <Row gutter={[18, 18]} align="middle">
            <Col xs={24} lg={7}>
              <Space direction="vertical" size={6}>
                <Tag color={riskResult.dry_run ? 'blue' : 'volcano'}>
                  {riskResult.dry_run ? '纸面风控预演' : '已执行模拟风控'}
                </Tag>
                <Text style={{ color: '#fff7ed', fontSize: 20, fontWeight: 900 }}>
                  风控交易台回执
                </Text>
                <Text style={{ color: 'rgba(255,247,237,0.72)' }}>
                  检查 {riskResult.checked} 个持仓，触发 {riskResult.exit_candidates} 个退出条件
                </Text>
              </Space>
            </Col>
            <Col xs={12} md={5} lg={4}>
              <Statistic
                title={<span style={{ color: 'rgba(255,247,237,0.72)' }}>退出/计划</span>}
                value={riskResult.dry_run ? riskResult.planned : riskResult.exited}
                suffix="笔"
                prefix={<ThunderboltOutlined />}
                valueStyle={{ color: '#fed7aa' }}
              />
            </Col>
            <Col xs={12} md={5} lg={4}>
              <Statistic
                title={<span style={{ color: 'rgba(255,247,237,0.72)' }}>继续持有</span>}
                value={riskResult.held}
                suffix="只"
                prefix={<FieldTimeOutlined />}
                valueStyle={{ color: '#bfdbfe' }}
              />
            </Col>
            <Col xs={24} lg={9}>
              {riskResult.exits?.length > 0 ? (
                <Space wrap>
                  {riskResult.exits.slice(0, 4).map(item => (
                    <Tag key={`${item.symbol}-${item.reason_label}`} color="orange">
                      {item.name || item.symbol} · {item.reason_label || '退出'} ·{' '}
                      {item.pnl_pct ?? '--'}%
                      {item.reason === 'trailing_take_profit'
                        ? ` · 峰值${item.max_profit_pct ?? '--'}%`
                        : ''}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Text style={{ color: 'rgba(255,247,237,0.75)' }}>
                  暂无触发退出条件：
                  {riskResult.held_items?.[0]?.message || '持仓仍在止损/止盈纪律范围内'}
                </Text>
              )}
            </Col>
          </Row>
        </Card>
      )}

      <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
        <Col xs={24} lg={8}>
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Card className="modern-card" variant="borderless" loading={loading}>
              <Statistic
                title="当前总资产"
                value={portfolio?.total_value || 0}
                precision={2}
                prefix="¥"
                valueStyle={{ color: '#1890ff', fontWeight: 'bold' }}
              />
            </Card>
            <Card className="modern-card" variant="borderless" loading={loading}>
              <Statistic
                title="可用资金"
                value={portfolio?.current_cash || 0}
                precision={2}
                prefix={<WalletOutlined />}
              />
            </Card>
            <Card className="modern-card" variant="borderless" loading={loading}>
              <Statistic
                title="累计收益率"
                value={Math.abs(total_return)}
                precision={2}
                prefix={isPositive ? <RiseOutlined /> : <FallOutlined />}
                suffix="%"
                valueStyle={{ color: isPositive ? '#cf1322' : '#3f8600', fontWeight: 'bold' }}
              />
            </Card>
          </Space>
        </Col>

        <Col xs={24} lg={16}>
          <Card
            className="modern-card"
            variant="borderless"
            title="资产走势"
            style={{ height: '100%' }}
          >
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={snapshots} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                    tickFormatter={val => val.substring(5)} // 只显示 MM-DD
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                    tickFormatter={val => `¥${(val / 10000).toFixed(0)}w`}
                    domain={['auto', 'auto']}
                  />
                  <RechartsTooltip
                    formatter={(value: number) => [
                      `¥${value.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}`,
                      '总资产',
                    ]}
                    labelStyle={{ color: '#6b7280' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="total_value"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorValue)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
      </Row>

      <Card
        className="modern-card paper-plan-card"
        variant="borderless"
        loading={tradingPlanLoading && !tradingPlan}
        style={{ marginBottom: 24 }}
      >
        <div className="paper-plan-header">
          <div>
            <Tag color="cyan" icon={<ThunderboltOutlined />}>
              Execution Plan
            </Tag>
            <h2>今日交易计划</h2>
            <p>自动合并风控退出、候选入场、持仓观察和归因反馈，输出可执行的盘前/盘后清单。</p>
          </div>
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => fetchTradingPlan(false)}
              loading={tradingPlanLoading}
            >
              刷新计划
            </Button>
            <Button
              type="primary"
              icon={<CloudUploadOutlined />}
              onClick={reportTradingPlan}
              loading={tradingPlanReportLoading}
            >
              上报飞书
            </Button>
          </Space>
        </div>

        <Row gutter={[14, 14]} className="paper-plan-scoreboard">
          <Col xs={12} md={4}>
            <div className="plan-score">
              <span>动作</span>
              <strong>{tradingPlanSummary?.action_count || 0}</strong>
            </div>
          </Col>
          <Col xs={12} md={4}>
            <div className="plan-score danger">
              <span>紧急</span>
              <strong>{tradingPlanSummary?.urgent_count || 0}</strong>
            </div>
          </Col>
          <Col xs={12} md={4}>
            <div className="plan-score">
              <span>退出</span>
              <strong>{tradingPlanSummary?.exit_count || 0}</strong>
            </div>
          </Col>
          <Col xs={12} md={4}>
            <div className="plan-score">
              <span>入场</span>
              <strong>{tradingPlanSummary?.entry_count || 0}</strong>
            </div>
          </Col>
          <Col xs={12} md={4}>
            <div className="plan-score">
              <span>计划后现金</span>
              <strong>{formatMoney(tradingPlanSummary?.projected_cash_after_plan)}</strong>
            </div>
          </Col>
          <Col xs={12} md={4}>
            <div className="plan-score">
              <span>有效评分</span>
              <strong>
                {tradingPlanSummary?.outcome_effective_min_score ||
                  tradingPlanSummary?.effective_min_score ||
                  72}
              </strong>
            </div>
          </Col>
        </Row>

        <div className="outcome-feedback-ribbon">
          <div className="outcome-feedback-orb">
            <span>α</span>
          </div>
          <div className="outcome-feedback-main">
            <div className="outcome-feedback-title">交易收益闭环正在反哺下一轮自动跟单</div>
            <p>
              {tradingPlanSummary?.outcome_reason ||
                '等待更多平仓样本，当前以保守仓位继续收集可验证交易结果。'}
            </p>
            <Space wrap>
              <Tag color="gold">
                样本 {tradingPlanSummary?.outcome_closed_samples || 0}/
                {tradingPlanSummary?.outcome_min_closed_samples || 5}
              </Tag>
              <Tag color="cyan">
                平均超额 {formatPercent(tradingPlanSummary?.outcome_avg_excess_return_pct)}
              </Tag>
              <Tag color="blue">
                超额胜率 {formatPercent(tradingPlanSummary?.outcome_excess_win_rate)}
              </Tag>
              <Tag color="purple">
                仓位倍率 {tradingPlanSummary?.outcome_position_multiplier ?? '--'}x
              </Tag>
            </Space>
          </div>
          <div className="outcome-feedback-gate">
            <span>自动参数</span>
            <strong>{tradingPlanSummary?.outcome_effective_min_score || '--'}</strong>
            <em>min score</em>
          </div>
        </div>

        {outcomeBlockedSegments.length > 0 && (
          <Alert
            className="outcome-feedback-alert"
            type="warning"
            showIcon
            message="已根据真实模拟交易收益暂停弱势片段"
            description={
              <Space wrap>
                {outcomeBlockedSegments.slice(0, 4).map(segment => (
                  <Tag key={`${segment.key}-${segment.label}`} color="volcano">
                    {segment.label || segment.key} · 超额{' '}
                    {formatPercent(segment.avg_excess_return_pct)} · {segment.closed_count}样本
                  </Tag>
                ))}
              </Space>
            }
          />
        )}

        <Row gutter={[18, 18]} style={{ marginTop: 18 }}>
          <Col xs={24} lg={12}>
            <div className="plan-lane plan-lane-hot">
              <div className="plan-lane-title">优先执行</div>
              {urgentPlanActions.length > 0 ? (
                urgentPlanActions.slice(0, 6).map((action, index) => (
                  <div className="plan-action-card" key={`urgent-${index}-${action.symbol || ''}`}>
                    <div className="plan-action-topline">
                      <Space wrap>
                        <Tag color={priorityColorMap[action.priority]}>
                          {priorityLabelMap[action.priority]}
                        </Tag>
                        <Tag>{actionTypeLabelMap[action.action_type]}</Tag>
                        {action.symbol && (
                          <Text strong>
                            {action.name || action.symbol}（{action.symbol}）
                          </Text>
                        )}
                      </Space>
                      {action.estimated_cash_change !== undefined && (
                        <Text style={{ color: pnlColor(action.estimated_cash_change) }}>
                          {formatSignedMoney(action.estimated_cash_change)}
                        </Text>
                      )}
                    </div>
                    <div className="plan-action-title">{action.action_label}</div>
                    <p>{action.reason}</p>
                    <ul>
                      {(action.instructions || []).slice(0, 3).map((text, itemIndex) => (
                        <li key={itemIndex}>{text}</li>
                      ))}
                    </ul>
                  </div>
                ))
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无紧急动作" />
              )}
            </div>
          </Col>
          <Col xs={24} lg={12}>
            <div className="plan-lane">
              <div className="plan-lane-title">观察与复盘</div>
              {normalPlanActions.length > 0 ? (
                normalPlanActions.slice(0, 6).map((action, index) => (
                  <div
                    className="plan-action-card calm"
                    key={`normal-${index}-${action.symbol || ''}`}
                  >
                    <div className="plan-action-topline">
                      <Space wrap>
                        <Tag color={priorityColorMap[action.priority]}>
                          {priorityLabelMap[action.priority]}
                        </Tag>
                        <Tag>{actionTypeLabelMap[action.action_type]}</Tag>
                        {action.symbol && (
                          <Text strong>
                            {action.name || action.symbol}（{action.symbol}）
                          </Text>
                        )}
                      </Space>
                      {action.estimated_pnl_pct !== undefined && (
                        <Text style={{ color: pnlColor(action.estimated_pnl_pct) }}>
                          {formatPercent(action.estimated_pnl_pct)}
                        </Text>
                      )}
                    </div>
                    <div className="plan-action-title">{action.action_label}</div>
                    <p>{action.reason}</p>
                    <ul>
                      {(action.instructions || []).slice(0, 2).map((text, itemIndex) => (
                        <li key={itemIndex}>{text}</li>
                      ))}
                    </ul>
                  </div>
                ))
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无观察/复盘动作" />
              )}
            </div>
          </Col>
        </Row>
      </Card>

      <Card
        className="modern-card paper-attribution-card"
        variant="borderless"
        loading={attributionLoading && !attribution}
        style={{ marginBottom: 24 }}
      >
        <div className="paper-attribution-header">
          <div>
            <Tag color="gold" icon={<TrophyOutlined />}>
              Signal P&L Attribution
            </Tag>
            <h2>信号收益归因与策略反哺</h2>
            <p>把推荐信号、模拟买卖、风控退出和真实盈亏串成闭环，用结果倒逼下一轮选股阈值。</p>
          </div>
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => fetchAttribution(false)}
              loading={attributionLoading}
            >
              刷新归因
            </Button>
            <Button
              type="primary"
              icon={<CloudUploadOutlined />}
              onClick={reportAttribution}
              loading={attributionReportLoading}
            >
              上报飞书
            </Button>
          </Space>
        </div>

        <Row gutter={[16, 16]} className="paper-attribution-metrics">
          <Col xs={12} md={6}>
            <div className="attribution-metric-tile">
              <span>闭环交易</span>
              <strong>{attributionSummary?.closed_count || 0}</strong>
              <em>当前持仓 {attributionSummary?.open_count || 0} 只</em>
            </div>
          </Col>
          <Col xs={12} md={6}>
            <div className="attribution-metric-tile">
              <span>综合盈亏</span>
              <strong style={{ color: pnlColor(attributionSummary?.total_pnl) }}>
                {formatSignedMoney(attributionSummary?.total_pnl)}
              </strong>
              <em>浮盈亏 {formatSignedMoney(attributionSummary?.total_unrealized_pnl)}</em>
            </div>
          </Col>
          <Col xs={12} md={6}>
            <div className="attribution-metric-tile">
              <span>胜率 / 均收</span>
              <strong>{formatPercent(attributionSummary?.win_rate)}</strong>
              <em>平均 {formatPercent(attributionSummary?.avg_return_pct)}</em>
            </div>
          </Col>
          <Col xs={12} md={6}>
            <div className="attribution-metric-tile">
              <span>反哺阈值</span>
              <strong>{attributionFeedback?.recommended_min_score || 72}</strong>
              <em>
                {attributionFeedback?.recommended_allowed_risk_levels?.join(' / ') ||
                  'low / medium'}
              </em>
            </div>
          </Col>
        </Row>

        <Row gutter={[18, 18]} style={{ marginTop: 18 }}>
          <Col xs={24} lg={8}>
            <div className="attribution-panel">
              <div className="attribution-panel-title">
                <BulbOutlined /> 策略反哺
              </div>
              {(attributionFeedback?.insights || []).slice(0, 4).map((item, index) => (
                <div className="feedback-note" key={`insight-${index}`}>
                  {item}
                </div>
              ))}
              {(!attributionFeedback?.insights || attributionFeedback.insights.length === 0) && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无归因洞察" />
              )}
            </div>
          </Col>
          <Col xs={24} lg={8}>
            <div className="attribution-panel">
              <div className="attribution-panel-title">
                <RadarChartOutlined /> 维度表现
              </div>
              {(attribution?.groups?.by_source_type || []).slice(0, 4).map(group => (
                <div className="bucket-strip" key={group.key}>
                  <div>
                    <strong>{group.label}</strong>
                    <span>
                      闭环 {group.closed_count} / 持仓 {group.open_count}
                    </span>
                  </div>
                  <div className="bucket-strip-value">
                    <Text style={{ color: pnlColor(group.avg_return_pct), fontWeight: 800 }}>
                      {formatPercent(group.avg_return_pct)}
                    </Text>
                    <Progress
                      percent={clampPercent(group.win_rate)}
                      size="small"
                      showInfo={false}
                      strokeColor={group.avg_return_pct >= 0 ? '#ef4444' : '#16a34a'}
                    />
                  </div>
                </div>
              ))}
              {(!attribution?.groups?.by_source_type ||
                attribution.groups.by_source_type.length === 0) && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无维度样本" />
              )}
            </div>
          </Col>
          <Col xs={24} lg={8}>
            <div className="attribution-panel">
              <div className="attribution-panel-title">
                <SafetyCertificateOutlined /> 当前风险暴露
              </div>
              {(attribution?.open_positions || []).slice(0, 4).map(item => (
                <div className="bucket-strip" key={`${item.symbol}-${item.signal_id || 'manual'}`}>
                  <div>
                    <strong>
                      {item.name || item.symbol}（{item.symbol}）
                    </strong>
                    <span>
                      持有 {item.holding_days} 天 · {formatMoney(item.market_value)}
                    </span>
                  </div>
                  <div className="bucket-strip-value">
                    <Text style={{ color: pnlColor(item.unrealized_pnl), fontWeight: 800 }}>
                      {formatPercent(item.unrealized_pnl_pct)}
                    </Text>
                    <Tag
                      className="modern-tag"
                      color={item.risk_state === 'near_stop_loss' ? 'volcano' : 'blue'}
                    >
                      距止损 {item.distance_to_stop_loss_pct ?? '--'}pct
                    </Tag>
                  </div>
                </div>
              ))}
              {(!attribution?.open_positions || attribution.open_positions.length === 0) && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无持仓风险暴露" />
              )}
            </div>
          </Col>
        </Row>

        <div className="attribution-next-actions">
          {(attributionFeedback?.next_actions || []).slice(0, 4).map((item, index) => (
            <Tag className="attribution-chip" key={`next-${index}`}>
              {item}
            </Tag>
          ))}
          {attributionSummary?.best_trade && (
            <Tag className="attribution-chip attribution-chip-hot">
              最佳：{attributionSummary.best_trade.name || attributionSummary.best_trade.symbol}{' '}
              {formatPercent(attributionSummary.best_trade.realized_pnl_pct)}
            </Tag>
          )}
          {attributionSummary?.worst_trade &&
            attributionSummary.worst_trade.realized_pnl_pct < 0 && (
              <Tag className="attribution-chip attribution-chip-risk">
                待复盘：
                {attributionSummary.worst_trade.name || attributionSummary.worst_trade.symbol}{' '}
                {formatPercent(attributionSummary.worst_trade.realized_pnl_pct)}
              </Tag>
            )}
        </div>
      </Card>

      <Card className="modern-card" variant="borderless" title="当前持仓">
        <Table
          columns={columns}
          dataSource={positions}
          rowKey="id"
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="当前模拟盘空空如也，快去 AI 每日优选看看有什么好票吧！"
              />
            ),
          }}
        />
      </Card>

      <Modal
        title="模拟交易"
        open={isTradeModalVisible}
        onOk={handleTradeSubmit}
        onCancel={() => setIsTradeModalVisible(false)}
        confirmLoading={submittingTrade}
        destroyOnHidden
      >
        <Form form={tradeForm} layout="vertical">
          <Form.Item
            label="交易方向"
            name="direction"
            rules={[{ required: true, message: '请选择交易方向' }]}
          >
            <Radio.Group>
              <Radio.Button value="BUY">买入</Radio.Button>
              <Radio.Button value="SELL">卖出</Radio.Button>
            </Radio.Group>
          </Form.Item>

          <Form.Item
            label="股票代码"
            name="symbol"
            rules={[{ required: true, message: '请选择股票' }]}
          >
            <Select
              showSearch
              placeholder="搜索并选择股票"
              optionFilterProp="children"
              onSearch={handleSearchStock}
              filterOption={false}
              notFoundContent={fetchingStocks ? <Spin size="small" /> : '未找到股票'}
            >
              {stocks.map(stock => (
                <Select.Option key={stock.symbol} value={stock.symbol}>
                  {stock.name} ({stock.symbol})
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            label="交易数量 (股)"
            name="quantity"
            rules={[{ required: true, message: '请输入交易数量' }]}
          >
            <InputNumber
              min={100}
              step={100}
              style={{ width: '100%' }}
              placeholder="请输入交易数量，如 100"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="交易流水记录"
        open={isHistoryModalVisible}
        onCancel={() => setIsHistoryModalVisible(false)}
        footer={null}
        width={900}
      >
        <Table
          columns={historyColumns}
          dataSource={tradeHistory}
          rowKey="id"
          loading={loadingHistory}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: <Empty description="暂无交易记录" /> }}
        />
      </Modal>
    </div>
  );
};

export default PaperTrading;
