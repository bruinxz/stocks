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
  promoted_environment_strategy_combo?: EnvironmentStrategyComboRanking | null;
  promoted_environment_strategy_feedback_applied?: boolean;
  promoted_environment_strategy_feedback_reason?: string;
  promoted_environment_strategy_policy?: {
    style?: string;
    min_score?: number;
    default_position_pct?: number;
    max_position_pct?: number;
    paper_trade_limit?: number;
    strategy_key?: string;
  } | null;
  cooled_environment_strategy_combos?: EnvironmentStrategyComboRanking[];
  resample_environment_strategy_combos?: EnvironmentStrategyComboRanking[];
  recovered_environment_strategy_combos?: EnvironmentStrategyComboRanking[];
  extended_cooldown_environment_strategy_combos?: EnvironmentStrategyComboRanking[];
  resample_environment_strategy_policy?: {
    key?: string;
    label?: string;
    position_multiplier?: number;
    reason?: string;
  } | null;
  recovered_environment_strategy_policy?: {
    key?: string;
    label?: string;
    position_multiplier?: number;
    reason?: string;
  } | null;
  budget_action_policy?: BudgetActionPolicy;
  budget_policy_version?: BudgetPolicyVersion;
  budget_policy_execution_audit?: BudgetPolicyExecutionAudit;
}

interface EnvironmentRanking {
  key: string;
  label: string;
  count?: number;
  tracked_count?: number;
  closed_count: number;
  avg_excess_return_pct: number;
  excess_win_rate: number;
  robust_score?: number;
  bayesian_win_rate?: number;
  dimension?: string;
  sample_confidence?: number;
  risk_adjusted_excess_return_pct?: number;
  capital_efficiency_score?: number;
  avg_position_pct?: number;
  avg_entry_amount?: number;
  total_entry_amount?: number;
  pnl_per_10k?: number;
  excess_per_position_pct?: number;
  budget_action?: 'increase' | 'reduce' | 'observe' | 'pause' | string;
  budget_action_reason?: string;
  recommended_budget_multiplier?: number;
}

interface BudgetActionPolicyItem extends EnvironmentRanking {
  action?: string;
  position_multiplier?: number;
  score_adjustment?: number;
  allow_entry?: boolean;
  confidence?: number;
  audit_feedback_applied?: boolean;
  audit_feedback_reason?: string;
  audit_verdict?: string;
  audit_score?: number;
  audit_multiplier_adjustment?: number;
  audit_score_adjustment?: number;
  reason?: string;
}

interface BudgetActionPolicy {
  enabled?: boolean;
  confidence?: number;
  total_closed_count?: number;
  audit_feedback_enabled?: boolean;
  audit_feedback_applied_count?: number;
  audit_feedback_reason?: string;
  version_id?: string;
  version_hash?: string;
  version?: BudgetPolicyVersion;
  actions?: BudgetActionPolicyItem[];
  best_action?: BudgetActionPolicyItem | null;
  weak_action?: BudgetActionPolicyItem | null;
  reason?: string;
  rules?: string[];
}

interface BudgetPolicyVersion {
  enabled?: boolean;
  schema?: string;
  version_id?: string;
  version_hash?: string;
  generated_at?: string;
  lookback_days?: number;
  action_count?: number;
  audit_feedback_applied_count?: number;
  audit_feedback_reason?: string;
  current_version_outcome?: EnvironmentRanking | null;
  version_rankings?: EnvironmentRanking[];
  underperformance_guard?: {
    enabled?: boolean;
    action?: string;
    severity?: string;
    champion_version_id?: string;
    champion_label?: string;
    champion_closed_count?: number;
    champion_avg_excess_return_pct?: number;
    champion_capital_efficiency_score?: number;
    efficiency_gap?: number;
    excess_gap?: number;
    reason?: string;
  };
  raw_version_id?: string;
  comparison_champion_version_id?: string;
  comparison_champion_label?: string;
  comparison_efficiency_gap?: number;
  comparison_excess_gap?: number;
  reason?: string;
}

interface BudgetPolicyExecutionItem extends EnvironmentRanking {
  audit_score?: number;
  verdict?: 'effective' | 'watch' | 'ineffective' | string;
  next_action?: string;
  reason?: string;
}

interface BudgetPolicyExecutionAudit {
  enabled?: boolean;
  confidence?: number;
  total_closed_count?: number;
  effective_count?: number;
  ineffective_count?: number;
  executions?: BudgetPolicyExecutionItem[];
  best_execution?: BudgetPolicyExecutionItem | null;
  weak_execution?: BudgetPolicyExecutionItem | null;
  reason?: string;
}

interface EnvironmentStrategyComboRanking extends EnvironmentRanking {
  total_pnl?: number;
  auto_action?: string;
  takeover_ready?: boolean;
  takeover_reason?: string;
  cooldown_active?: boolean;
  cooldown_reason?: string;
  recent_loss_streak?: number;
  cooldown_days?: number;
  resample_ready?: boolean;
  resample_reason?: string;
  resample_position_multiplier?: number;
  resample_closed_count?: number;
  resample_avg_excess_return_pct?: number;
  resample_win_rate?: number;
  resample_excess_win_rate?: number;
  resample_total_pnl?: number;
  resample_profit_factor?: number;
  resample_decision?: 'promote' | 'continue_sampling' | 'cooldown' | 'observe' | string;
  resample_decision_reason?: string;
  resample_recovery_ready?: boolean;
  resample_recovery_position_multiplier?: number;
  cooldown_extended?: boolean;
  cooldown_extension_days?: number;
  cooldown_expires_at?: string;
  resample_policy_action?: string;
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
    recovered_environment_strategy_combos?: EnvironmentStrategyComboRanking[];
    extended_cooldown_environment_strategy_combos?: EnvironmentStrategyComboRanking[];
    resample_environment_strategy_combos?: EnvironmentStrategyComboRanking[];
    candidate_tuning_reason?: string;
  };
  strategy_evolution?: {
    add_risk_budget?: Array<any>;
    reduce_risk_budget?: Array<any>;
    observe?: Array<any>;
    candidate_tuning_best?: EnvironmentRanking | null;
    candidate_tuning_weak?: EnvironmentRanking | null;
    capital_efficiency_rankings?: EnvironmentRanking[];
    budget_action_rankings?: EnvironmentRanking[];
    best_budget_action?: EnvironmentRanking | null;
    weak_budget_action?: EnvironmentRanking | null;
    budget_action_policy?: BudgetActionPolicy;
    budget_policy_version?: BudgetPolicyVersion;
    budget_policy_execution_audit?: BudgetPolicyExecutionAudit;
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
    version_rankings?: EnvironmentRanking[];
    strategy_combo_rankings?: EnvironmentStrategyComboRanking[];
    resample_summary?: EnvironmentRanking[];
    candidate_tuning_rankings?: EnvironmentRanking[];
    budget_action_rankings?: EnvironmentRanking[];
    budget_policy_action_rankings?: EnvironmentRanking[];
    budget_policy_version_rankings?: EnvironmentRanking[];
    resample_combo_rankings?: EnvironmentStrategyComboRanking[];
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

const budgetActionLabel = (value?: string) => {
  const labels: Record<string, string> = {
    increase: '加预算',
    reduce: '降权',
    observe: '观察',
    pause: '暂停',
    boost: '放大',
    block: '暂停',
    watch: '观察',
  };
  return labels[value || ''] || value || '观察';
};

const budgetPolicyActionLabel = (value?: string) => {
  const labels: Record<string, string> = {
    collect_samples: '收集样本',
    scale_up: '放大',
    cap_increase: '限制放大',
    verify: '继续验证',
    promote_from_observe: '观察升档',
    sample_smaller: '缩小试错',
    keep_observe: '继续观察',
    keep_defensive: '防守跟随',
    tighten_reduce: '继续压仓',
    reopen_small: '小仓重开',
    keep_paused: '继续暂停',
  };
  return labels[value || ''] || value || '观察';
};

const budgetAuditVerdictLabel = (value?: string) => {
  const labels: Record<string, string> = {
    effective: '有效',
    watch: '观察',
    ineffective: '无效',
  };
  return labels[value || ''] || value || '观察';
};

const budgetAuditVerdictColor = (value?: string) => {
  const colors: Record<string, string> = {
    effective: 'cyan',
    watch: 'gold',
    ineffective: 'red',
  };
  return colors[value || ''] || 'default';
};

const budgetMeta = (item: any) => {
  const efficiency =
    item?.capital_efficiency_score !== undefined
      ? `效率 ${Number(item.capital_efficiency_score).toFixed(1)}`
      : `超额 ${formatPercent(item?.avg_excess_return_pct)}`;
  const multiplier =
    item?.recommended_budget_multiplier !== undefined
      ? `预算 ${Number(item.recommended_budget_multiplier).toFixed(2)}x`
      : item?.position_multiplier !== undefined
      ? `预算 ${Number(item.position_multiplier).toFixed(2)}x`
      : '预算 --';
  return `${efficiency} · ${multiplier}`;
};

const renderBudgetItem = (item: any) => (
  <em className="optimization-budget-pill" key={item.key || item.label}>
    <b>{item.label || item.key}</b>
    <span>{budgetMeta(item)}</span>
    {(item.budget_action_reason || item.reason || item.resample_decision_reason) && (
      <small>{item.budget_action_reason || item.reason || item.resample_decision_reason}</small>
    )}
  </em>
);

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
  const environmentVersionRankings = useMemo(
    () => (data?.market_environment?.version_rankings || []).slice(0, 5),
    [data]
  );
  const environmentStrategyComboRankings = useMemo(
    () => (data?.market_environment?.strategy_combo_rankings || []).slice(0, 6),
    [data]
  );
  const resampleComboRankings = useMemo(
    () =>
      (data?.market_environment?.resample_combo_rankings || []).filter(
        item => Number(item.resample_closed_count || 0) > 0 || item.resample_decision
      ),
    [data]
  );
  const candidateTuningRankings = useMemo(
    () =>
      (data?.market_environment?.candidate_tuning_rankings || []).filter(
        item => item.key !== 'no_tuning'
      ),
    [data]
  );
  const capitalEfficiencyRankings = useMemo(
    () => (data?.strategy_evolution?.capital_efficiency_rankings || []).slice(0, 6),
    [data]
  );
  const budgetActionRankings = useMemo(
    () =>
      (
        data?.strategy_evolution?.budget_action_rankings ||
        data?.market_environment?.budget_action_rankings ||
        []
      ).filter(item => item.key !== 'no_budget_action'),
    [data]
  );
  const budgetActionPolicy =
    data?.strategy_evolution?.budget_action_policy ||
    data?.environment_policy?.budget_action_policy;
  const budgetPolicyVersion =
    data?.strategy_evolution?.budget_policy_version ||
    data?.environment_policy?.budget_policy_version ||
    budgetActionPolicy?.version;
  const budgetPolicyVersionRankings = useMemo(
    () =>
      (
        budgetPolicyVersion?.version_rankings ||
        data?.market_environment?.budget_policy_version_rankings ||
        []
      )
        .filter(item => item.key !== 'no_budget_policy_version')
        .slice(0, 6),
    [budgetPolicyVersion, data]
  );
  const budgetPolicyExecutionAudit =
    data?.strategy_evolution?.budget_policy_execution_audit ||
    data?.environment_policy?.budget_policy_execution_audit;

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
          {data?.next_policy?.candidate_tuning_reason && (
            <div className="optimization-env-strip recovered">
              <SafetyCertificateOutlined />
              {data.next_policy.candidate_tuning_reason}
            </div>
          )}
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
        <Col xs={24}>
          <Card
            className="modern-card optimization-env-card"
            title={
              <Space>
                <SlidersOutlined /> 策略演进资金方向
              </Space>
            }
            loading={loading}
          >
            <div className="optimization-evolution-board">
              <div className="add">
                <span>ADD RISK</span>
                <strong>可加预算</strong>
                {(data?.strategy_evolution?.add_risk_budget || [])
                  .slice(0, 4)
                  .map(renderBudgetItem)}
                {!data?.strategy_evolution?.add_risk_budget?.length && (
                  <em className="optimization-budget-empty">暂无满足加预算条件</em>
                )}
              </div>
              <div className="reduce">
                <span>REDUCE</span>
                <strong>降权/暂停</strong>
                {(data?.strategy_evolution?.reduce_risk_budget || [])
                  .slice(0, 4)
                  .map(renderBudgetItem)}
                {!data?.strategy_evolution?.reduce_risk_budget?.length && (
                  <em className="optimization-budget-empty">暂无强制降权片段</em>
                )}
              </div>
              <div className="observe">
                <span>OBSERVE</span>
                <strong>小仓观察</strong>
                {(data?.strategy_evolution?.observe || []).slice(0, 4).map(renderBudgetItem)}
                {!data?.strategy_evolution?.observe?.length && (
                  <em className="optimization-budget-empty">等待新增闭环样本</em>
                )}
              </div>
            </div>
            {!!capitalEfficiencyRankings.length && (
              <div className="optimization-capital-strip">
                <div>
                  <span>CAPITAL EFFICIENCY</span>
                  <strong>单位资金效率排行</strong>
                </div>
                {capitalEfficiencyRankings.map(item => (
                  <div key={item.key} className="optimization-capital-chip">
                    <b>{item.label}</b>
                    <em>
                      {budgetActionLabel(item.budget_action)} · 效率{' '}
                      {Number(item.capital_efficiency_score || 0).toFixed(1)} · 1万收益{' '}
                      {formatMoney(item.pnl_per_10k)}
                    </em>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {!!resampleComboRankings.length && (
        <Row gutter={[16, 16]}>
          <Col xs={24}>
            <Card
              className="modern-card optimization-env-card"
              title={
                <Space>
                  <ReloadOutlined /> 复采样收益回收
                </Space>
              }
              loading={loading}
            >
              <div className="optimization-resample-board">
                {resampleComboRankings.slice(0, 4).map((item, index) => (
                  <div
                    className={`optimization-resample-card ${item.resample_decision || 'observe'}`}
                    key={item.key || index}
                  >
                    <div className="optimization-env-combo-rank">R{index + 1}</div>
                    <Text strong>{item.label || item.key}</Text>
                    <div className="optimization-env-combo-stats">
                      <span>
                        复采闭环 <b>{item.resample_closed_count || 0}</b>
                      </span>
                      <span>
                        复采超额 <b>{formatPercent(item.resample_avg_excess_return_pct)}</b>
                      </span>
                      <span>
                        超额胜率 <b>{formatPercent(item.resample_excess_win_rate)}</b>
                      </span>
                    </div>
                    <strong style={{ color: pnlColor(item.resample_avg_excess_return_pct) }}>
                      {formatPercent(item.resample_avg_excess_return_pct)}
                    </strong>
                    <em>
                      {item.resample_decision === 'promote'
                        ? '可评估恢复常规采样'
                        : item.resample_decision === 'cooldown'
                        ? '复采仍弱，继续冷却'
                        : item.resample_decision === 'continue_sampling'
                        ? '继续小仓观察'
                        : '等待复采闭环'}
                    </em>
                    <Tag
                      color={
                        item.resample_policy_action === 'recover_small'
                          ? 'cyan'
                          : item.resample_policy_action === 'extend_cooldown'
                          ? 'red'
                          : 'gold'
                      }
                    >
                      {item.resample_policy_action === 'recover_small'
                        ? `恢复 ${item.resample_recovery_position_multiplier || 0.58}x`
                        : item.resample_policy_action === 'extend_cooldown'
                        ? `冷却+${item.cooldown_extension_days || 7}天`
                        : '小仓观察'}
                    </Tag>
                    <p>{item.resample_decision_reason || item.resample_reason}</p>
                  </div>
                ))}
              </div>
              {!!candidateTuningRankings.length && (
                <div className="optimization-tuning-ledger">
                  {candidateTuningRankings.slice(0, 3).map(item => (
                    <div key={item.key}>
                      <span>{item.label}</span>
                      <strong style={{ color: pnlColor(item.avg_excess_return_pct) }}>
                        {formatPercent(item.avg_excess_return_pct)}
                      </strong>
                      <em>
                        闭环 {item.closed_count || 0} · 超额胜率{' '}
                        {formatPercent(item.excess_win_rate)}
                      </em>
                    </div>
                  ))}
                </div>
              )}
              {!!budgetActionRankings.length && (
                <div className="optimization-budget-ledger">
                  <div className="optimization-budget-ledger-head">
                    <span>BUDGET ACTION BACKTEST</span>
                    <strong>预算动作收益回收</strong>
                    <em>验证加预算、降权、观察这些动作后续是否真的跑赢</em>
                  </div>
                  {budgetActionRankings.slice(0, 4).map(item => (
                    <div className={`optimization-budget-action-card ${item.key}`} key={item.key}>
                      <span>{item.label}</span>
                      <strong style={{ color: pnlColor(item.avg_excess_return_pct) }}>
                        {formatPercent(item.avg_excess_return_pct)}
                      </strong>
                      <em>
                        闭环 {item.closed_count || 0} · 效率{' '}
                        {Number(item.capital_efficiency_score || 0).toFixed(1)} · 1万收益{' '}
                        {formatMoney(item.pnl_per_10k)}
                      </em>
                    </div>
                  ))}
                </div>
              )}
              {budgetActionPolicy?.enabled && (
                <div className="optimization-budget-policy">
                  {budgetPolicyVersion?.enabled && (
                    <div className="optimization-budget-version-strip">
                      <span>WEIGHT VERSION</span>
                      <strong>{budgetPolicyVersion.version_id}</strong>
                      <em>
                        指纹 {budgetPolicyVersion.version_hash} · 动作{' '}
                        {budgetPolicyVersion.action_count || 0} · 审计反哺{' '}
                        {budgetPolicyVersion.audit_feedback_applied_count || 0}
                      </em>
                    </div>
                  )}
                  {budgetPolicyVersion?.underperformance_guard?.action ===
                    'protective_downgrade' && (
                    <div className="optimization-budget-version-guard">
                      <FireOutlined />
                      <div>
                        <span>VERSION GUARD</span>
                        <strong>预算权重保护降级已启用</strong>
                        <em>{budgetPolicyVersion.underperformance_guard.reason}</em>
                      </div>
                    </div>
                  )}
                  <div className="optimization-budget-policy-head">
                    <span>AUTO UPGRADE POLICY</span>
                    <strong>预算动作自动升降级</strong>
                    <em>
                      {budgetActionPolicy.audit_feedback_applied_count
                        ? budgetActionPolicy.audit_feedback_reason
                        : budgetActionPolicy.reason ||
                          '下一轮自动把预算动作收益回收为调分/调仓规则'}
                    </em>
                  </div>
                  <div className="optimization-budget-policy-grid">
                    {(budgetActionPolicy.actions || []).slice(0, 4).map(item => (
                      <div
                        className={`optimization-budget-policy-card ${item.key || 'observe'} ${
                          item.allow_entry === false ? 'blocked' : ''
                        }`}
                        key={item.key || item.action}
                      >
                        <div>
                          <Tag color={item.allow_entry === false ? 'red' : 'geekblue'}>
                            {budgetPolicyActionLabel(item.action)}
                          </Tag>
                          <span>{budgetActionLabel(item.key)}</span>
                        </div>
                        <strong>{Number(item.position_multiplier ?? 1).toFixed(2)}x</strong>
                        <em>
                          评分 {Number(item.score_adjustment || 0) >= 0 ? '+' : ''}
                          {Number(item.score_adjustment || 0).toFixed(0)} · 闭环{' '}
                          {item.closed_count || 0} · 置信{' '}
                          {Math.round(Number(item.confidence || 0) * 100)}%
                        </em>
                        {item.audit_feedback_applied && (
                          <small>
                            审计反哺 · {budgetAuditVerdictLabel(item.audit_verdict)} · 倍率校准{' '}
                            {Number(item.audit_multiplier_adjustment || 1).toFixed(2)}x
                          </small>
                        )}
                        <p>{item.reason}</p>
                      </div>
                    ))}
                  </div>
                  {!!budgetPolicyVersionRankings.length && (
                    <div className="optimization-budget-version-board">
                      <div className="optimization-budget-version-board-head">
                        <span>VERSION LEADERBOARD</span>
                        <strong>预算权重版本收益榜</strong>
                        <em>当前版本与历史冠军对比，跑输后自动保护降级，不让坏权重继续放大。</em>
                      </div>
                      {budgetPolicyVersionRankings.map((item, index) => {
                        const isCurrent = item.key === budgetPolicyVersion?.version_id;
                        const isChampion =
                          item.key ===
                          budgetPolicyVersion?.underperformance_guard?.champion_version_id;
                        return (
                          <div
                            className={`optimization-budget-version-row ${
                              isCurrent ? 'current' : ''
                            } ${isChampion ? 'champion' : ''}`}
                            key={item.key || index}
                          >
                            <div className="optimization-budget-version-rank">
                              {isCurrent ? 'NOW' : `#${index + 1}`}
                            </div>
                            <div>
                              <Text strong>{item.key || item.label}</Text>
                              <Text type="secondary">
                                闭环 {item.closed_count || 0} · 效率{' '}
                                {Number(item.capital_efficiency_score || 0).toFixed(1)} · 1万收益{' '}
                                {formatMoney(item.pnl_per_10k)}
                              </Text>
                            </div>
                            <strong style={{ color: pnlColor(item.avg_excess_return_pct) }}>
                              {formatPercent(item.avg_excess_return_pct)}
                            </strong>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {budgetPolicyExecutionAudit?.enabled && (
                <div className="optimization-budget-audit">
                  <div className="optimization-budget-audit-head">
                    <span>EXECUTION AUDIT</span>
                    <strong>预算策略执行审计</strong>
                    <em>
                      {budgetPolicyExecutionAudit.reason ||
                        '审计自动升降级策略进入模拟盘后的真实收益表现'}
                    </em>
                  </div>
                  <div className="optimization-budget-audit-grid">
                    {(budgetPolicyExecutionAudit.executions || []).slice(0, 4).map(item => (
                      <div
                        className={`optimization-budget-audit-card ${item.verdict || 'watch'}`}
                        key={item.key || item.label}
                      >
                        <div className="optimization-budget-audit-top">
                          <Tag color={budgetAuditVerdictColor(item.verdict)}>
                            {budgetAuditVerdictLabel(item.verdict)}
                          </Tag>
                          <b>{item.label || item.key}</b>
                        </div>
                        <strong style={{ color: pnlColor(item.avg_excess_return_pct) }}>
                          {formatPercent(item.avg_excess_return_pct)}
                        </strong>
                        <em>
                          审计分 {Number(item.audit_score || 0).toFixed(1)} · 闭环{' '}
                          {item.closed_count || 0} · 效率{' '}
                          {Number(item.capital_efficiency_score || 0).toFixed(1)}
                        </em>
                        <p>{item.reason || item.next_action}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </Col>
        </Row>
      )}

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
        <Col xs={24}>
          <Card
            className="modern-card optimization-env-card"
            title={
              <Space>
                <BranchesOutlined /> 环境版本收益排行榜
              </Space>
            }
            loading={loading}
          >
            <div className="optimization-env-version-ranking">
              {environmentVersionRankings.map((item, index) => (
                <div className="optimization-env-version-row" key={item.key || index}>
                  <div className="optimization-env-rank">#{index + 1}</div>
                  <div className="optimization-env-main">
                    <Text strong>{item.label || item.key}</Text>
                    <Text type="secondary">
                      跟踪 {item.tracked_count || item.count || 0} · 闭环 {item.closed_count || 0} ·
                      稳健分 {Number(item.robust_score || 0).toFixed(2)}
                    </Text>
                  </div>
                  <div className="optimization-env-stat">
                    <strong style={{ color: pnlColor(item.avg_excess_return_pct) }}>
                      {formatPercent(item.avg_excess_return_pct)}
                    </strong>
                    <span>环境版本平均超额</span>
                  </div>
                </div>
              ))}
              {!environmentVersionRankings.length && (
                <Empty description="暂无环境版本收益样本，下一轮闭环后自动沉淀" />
              )}
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24}>
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
        <Col xs={24}>
          <Card
            className="modern-card optimization-env-card"
            title={
              <Space>
                <NodeIndexOutlined /> 环境 × 策略组合收益矩阵
              </Space>
            }
            loading={loading}
          >
            <div className="optimization-env-takeover">
              <div>
                <span>TAKEOVER STATUS</span>
                <strong>
                  {environmentPolicy?.promoted_environment_strategy_feedback_applied
                    ? '已接管下一轮参数'
                    : '等待更多闭环样本'}
                </strong>
                <p>
                  {environmentPolicy?.promoted_environment_strategy_feedback_reason ||
                    '仅当闭环≥3、稳健分≥8、平均超额为正且贝叶斯胜率达标时，环境×策略冠军才会接管。'}
                </p>
              </div>
              <Space wrap>
                <Tag color="cyan">
                  风格：
                  {styleLabel(environmentPolicy?.promoted_environment_strategy_policy?.style)}
                </Tag>
                <Tag color="gold">
                  评分≥{environmentPolicy?.promoted_environment_strategy_policy?.min_score || '--'}
                </Tag>
                <Tag color="purple">
                  仓位{' '}
                  {formatPercent(
                    environmentPolicy?.promoted_environment_strategy_policy?.default_position_pct
                  )}
                </Tag>
                <Tag color="geekblue">
                  跟单{' '}
                  {environmentPolicy?.promoted_environment_strategy_policy?.paper_trade_limit ||
                    '--'}
                </Tag>
              </Space>
            </div>
            {!!environmentPolicy?.cooled_environment_strategy_combos?.length && (
              <div className="optimization-env-cooldown-strip">
                <FireOutlined />
                <span>
                  已冷却 {environmentPolicy.cooled_environment_strategy_combos.length} 个跑输组合：
                  {environmentPolicy.cooled_environment_strategy_combos[0]?.label} ·{' '}
                  {environmentPolicy.cooled_environment_strategy_combos[0]?.cooldown_reason}
                </span>
              </div>
            )}
            {!!environmentPolicy?.resample_environment_strategy_combos?.length && (
              <div className="optimization-env-resample-strip">
                <ReloadOutlined />
                <span>
                  已开放 {environmentPolicy.resample_environment_strategy_combos.length}{' '}
                  个冷却组合小仓复采样：
                  {environmentPolicy.resample_environment_strategy_combos[0]?.label} ·{' '}
                  {environmentPolicy.resample_environment_strategy_combos[0]?.resample_reason}
                </span>
              </div>
            )}
            {!!environmentPolicy?.recovered_environment_strategy_combos?.length && (
              <div className="optimization-env-recovered-strip">
                <SafetyCertificateOutlined />
                <span>
                  {environmentPolicy.recovered_environment_strategy_combos.length}{' '}
                  个组合复采样跑赢，已解除冷却并恢复小仓常规采样：
                  {environmentPolicy.recovered_environment_strategy_combos[0]?.label} ·{' '}
                  {
                    environmentPolicy.recovered_environment_strategy_combos[0]
                      ?.resample_decision_reason
                  }
                </span>
              </div>
            )}
            {!!environmentPolicy?.extended_cooldown_environment_strategy_combos?.length && (
              <div className="optimization-env-cooldown-strip">
                <FireOutlined />
                <span>
                  {environmentPolicy.extended_cooldown_environment_strategy_combos.length}{' '}
                  个组合复采样仍跑输，已延长冷却：
                  {environmentPolicy.extended_cooldown_environment_strategy_combos[0]?.label} · 到期{' '}
                  {environmentPolicy.extended_cooldown_environment_strategy_combos[0]
                    ?.cooldown_expires_at || '--'}
                </span>
              </div>
            )}
            <div className="optimization-env-combo-grid">
              {environmentStrategyComboRankings.map((item, index) => (
                <div
                  className={`optimization-env-combo-tile ${
                    item.resample_recovery_ready
                      ? 'recovered'
                      : item.cooldown_extended
                      ? 'cooldown'
                      : item.resample_ready
                      ? 'resample'
                      : item.cooldown_active
                      ? 'cooldown'
                      : item.takeover_ready
                      ? 'ready'
                      : ''
                  }`}
                  key={item.key || index}
                >
                  <div className="optimization-env-combo-rank">#{index + 1}</div>
                  <Text strong>{item.label || item.key}</Text>
                  <div className="optimization-env-combo-stats">
                    <span>
                      闭环 <b>{item.closed_count || 0}</b>
                    </span>
                    <span>
                      超额胜率 <b>{formatPercent(item.excess_win_rate)}</b>
                    </span>
                    <span>
                      稳健分 <b>{Number(item.robust_score || 0).toFixed(2)}</b>
                    </span>
                  </div>
                  <strong style={{ color: pnlColor(item.avg_excess_return_pct) }}>
                    {formatPercent(item.avg_excess_return_pct)}
                  </strong>
                  <em>
                    {item.resample_recovery_ready
                      ? item.resample_decision_reason || '复采样跑赢，小仓恢复'
                      : item.cooldown_extended
                      ? item.resample_decision_reason || '复采样仍弱，延长冷却'
                      : item.resample_ready
                      ? item.resample_reason || '小仓复采样'
                      : item.cooldown_active
                      ? item.cooldown_reason || '组合冷却中'
                      : item.takeover_ready
                      ? '已满足接管条件'
                      : item.takeover_reason || '继续观察'}
                  </em>
                </div>
              ))}
              {!environmentStrategyComboRankings.length && (
                <Empty description="暂无环境×策略交叉样本，等待更多模拟盘闭环" />
              )}
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
