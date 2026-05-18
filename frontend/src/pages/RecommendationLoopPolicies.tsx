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
  CloudSyncOutlined,
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
import { getRiskLimitKeyLabel } from '../constants/riskLimits';

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
  closed_count?: number;
  excess_win_rate?: number;
  auto_action?: string;
  confidence?: number;
  robust_score?: number;
  sample_confidence?: number;
  bayesian_win_rate?: number;
  risk_adjusted_excess_return_pct?: number;
  return_volatility_pct?: number;
  drawdown_penalty?: number;
}

interface StrategyVariant {
  strategy_key?: string;
  strategy_bucket_label?: string;
  style?: string;
  min_score?: number;
  default_position_pct?: number;
  max_position_pct?: number;
  paper_trade_limit?: number;
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
  metadata?: {
    strategy_key?: string;
    strategy_bucket_label?: string;
    strategy_variant?: StrategyVariant;
    environment_policy_snapshot_id?: string;
    environment_policy?: any;
    risk_profile_gate?: any;
    risk_profile_gate_action?: string;
  };
  loop_policy?: {
    strategy_key?: string;
    strategy_bucket_label?: string;
    strategy_variant?: StrategyVariant;
    environment_policy_snapshot_id?: string;
    environment_policy?: any;
    risk_profile_gate?: any;
  };
  run_metrics?: {
    environment_policy_snapshot_id?: string;
    environment_policy?: any;
    risk_profile?: any;
    risk_profile_gate?: any;
    paper_trading?: any;
  };
}

interface PromotionAdvice {
  action: string;
  confidence: number;
  base_confidence?: number;
  field_gate_confidence_adjustment?: number;
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
  best_strategy_key?: PolicyBucket;
  best_environment_policy_version?: PolicyBucket;
  field_gate_adjustment_attribution?: FieldGateAdjustmentAttribution;
  reasons: string[];
}

interface FieldGateAdjustmentAttribution {
  status: string;
  conclusion: string;
  changed_at?: string;
  task_name?: string;
  decision?: {
    action: string;
    label?: string;
    confidence?: number;
    reason?: string;
  };
  before_sample_count?: number;
  after_sample_count?: number;
  before_avg_excess_return_pct?: number;
  after_avg_excess_return_pct?: number;
  delta_pct?: number;
  windows?: Array<{
    days: number;
    sample_count: number;
    avg_excess_return_pct?: number;
    delta_pct?: number;
    conclusion?: string;
  }>;
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
    by_score_position_bucket?: PolicyBucket[];
    by_strategy_key?: PolicyBucket[];
    by_environment_policy_version?: PolicyBucket[];
    by_risk_profile_gate?: PolicyBucket[];
  };
  rankings?: {
    snapshots: any[];
    by_style: PolicyBucket[];
    by_score_bucket: PolicyBucket[];
    by_position_bucket: PolicyBucket[];
    by_universe: PolicyBucket[];
    by_score_position_bucket?: PolicyBucket[];
    by_strategy_key?: PolicyBucket[];
    by_environment_policy_version?: PolicyBucket[];
    by_risk_profile_gate?: PolicyBucket[];
  };
  risk_gate_analysis?: {
    gates: PolicyBucket[];
    allow?: PolicyBucket | null;
    reduce?: PolicyBucket | null;
    pause?: PolicyBucket | null;
    protected_runs: number;
    allow_avg_excess_return_pct: number;
    protected_avg_excess_return_pct: number;
    protection_delta_pct: number;
    suggested_limits?: {
      action: string;
      reason: string;
      limits: Record<string, number>;
      attribution?: any;
      field_gate_advice?: {
        conclusion?: string;
        items?: Array<{
          key: string;
          action: string;
          reason?: string;
          sample_count?: number;
          actionable_count?: number;
          avg_confidence?: number;
        }>;
      };
    };
    field_gate_advice?: {
      conclusion?: string;
      items?: Array<{
        key: string;
        action: string;
        reason?: string;
        sample_count?: number;
        actionable_count?: number;
        avg_confidence?: number;
      }>;
    };
    threshold_attribution?: {
      items?: Array<{
        key: string;
        label: string;
        action: string;
        triggered_count: number;
        sample_count: number;
        trigger_delta_pct?: number;
      }>;
    };
    suggestion_stability?: {
      latest_action: string;
      latest_action_label?: string;
      consecutive_same_action: number;
      actionable_samples: number;
      window_size: number;
      can_apply: boolean;
      confidence: number;
      evidence_passed?: boolean;
      protection_delta_pct?: number;
      protected_runs?: number;
      thresholds?: Record<string, number>;
      label: string;
      reason: string;
    };
    conclusion: string;
  };
  field_gate_adjustment_attribution?: FieldGateAdjustmentAttribution;
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

const comboActionMeta = (value?: string) => {
  const meta: Record<string, { label: string; color: string }> = {
    boost: { label: '放大候选', color: 'red' },
    reduce: { label: '自动降权', color: 'green' },
    hold: { label: '继续观察', color: 'gold' },
    collect_samples: { label: '采样中', color: 'blue' },
  };
  return meta[value || ''] || { label: value || '观察', color: 'default' };
};

const getSnapshotStrategyLabel = (record: PolicySnapshot) =>
  record.metadata?.strategy_bucket_label ||
  record.metadata?.strategy_variant?.strategy_bucket_label ||
  record.loop_policy?.strategy_bucket_label ||
  record.loop_policy?.strategy_variant?.strategy_bucket_label ||
  record.metadata?.strategy_key ||
  record.loop_policy?.strategy_key ||
  '未标注参数组合';

const getSnapshotEnvironmentPolicy = (record?: PolicySnapshot) =>
  record?.metadata?.environment_policy ||
  record?.loop_policy?.environment_policy ||
  record?.run_metrics?.environment_policy ||
  {};

const getSnapshotEnvironmentPolicyId = (record?: PolicySnapshot) =>
  record?.metadata?.environment_policy_snapshot_id ||
  record?.loop_policy?.environment_policy_snapshot_id ||
  record?.run_metrics?.environment_policy_snapshot_id ||
  getSnapshotEnvironmentPolicy(record)?.snapshot_id ||
  '';

const getSnapshotRiskGate = (record?: PolicySnapshot) =>
  record?.metadata?.risk_profile_gate ||
  record?.loop_policy?.risk_profile_gate ||
  record?.run_metrics?.risk_profile_gate ||
  record?.run_metrics?.paper_trading?.risk_profile_gate ||
  {};

const riskGateMeta = (action?: string) => {
  const map: Record<string, { label: string; color: string }> = {
    allow: { label: '正常放行', color: 'green' },
    reduce: { label: '自动降仓', color: 'gold' },
    pause: { label: '暂停新增', color: 'red' },
    observe: { label: '谨慎观察', color: 'blue' },
  };
  return (
    map[String(action || 'allow').toLowerCase()] || {
      label: action || '正常放行',
      color: 'default',
    }
  );
};

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

const fieldGateAttributionMeta = (status?: string, deltaPct?: number) => {
  if (status === 'ready') {
    return Number(deltaPct || 0) >= 0
      ? { label: '调参后改善', color: 'green' }
      : { label: '调参后走弱', color: 'orange' };
  }
  const meta: Record<string, { label: string; color: string }> = {
    insufficient_samples: { label: '样本观察中', color: 'blue' },
    no_advice_adjustment: { label: '暂无人工采纳', color: 'default' },
    unavailable: { label: '暂不可用', color: 'default' },
  };
  return meta[status || ''] || { label: status || '等待样本', color: 'default' };
};

const fieldGateDecisionColor = (action?: string) => {
  const map: Record<string, string> = {
    support: 'green',
    caution: 'orange',
    observe: 'blue',
    insufficient: 'default',
  };
  return map[action || ''] || 'default';
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
  const topStrategyCombos = useMemo(
    () => (dashboard?.rankings?.by_strategy_key || []).slice(0, 5),
    [dashboard]
  );
  const topEnvironmentVersions = useMemo(
    () =>
      (dashboard?.rankings?.by_environment_policy_version || [])
        .filter(item => item.key !== 'unknown')
        .slice(0, 5),
    [dashboard]
  );
  const riskGateAnalysis = dashboard?.risk_gate_analysis;
  const fieldGateAdjustmentAttribution = dashboard?.field_gate_adjustment_attribution;
  const riskGateRankings = useMemo(
    () =>
      dashboard?.rankings?.by_risk_profile_gate || dashboard?.groups?.by_risk_profile_gate || [],
    [dashboard]
  );
  const latestEnvironmentPolicy = getSnapshotEnvironmentPolicy(summary?.latest_policy);
  const latestEnvironmentPolicyId = getSnapshotEnvironmentPolicyId(summary?.latest_policy);

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
          <Text type="secondary" style={{ fontSize: 12 }}>
            组合：{getSnapshotStrategyLabel(record)}
          </Text>
        </Space>
      ),
    },
    {
      title: '环境闸门',
      width: 210,
      render: (_: any, record: PolicySnapshot) => {
        const policy = getSnapshotEnvironmentPolicy(record);
        const policyId = getSnapshotEnvironmentPolicyId(record);
        return (
          <Space direction="vertical" size={3}>
            <Tag color={policy?.applied ? 'cyan' : 'default'}>
              {policy?.applied ? '已应用' : policy?.enabled ? '观察中' : '未启用'}
            </Tag>
            <Text type="secondary">
              倍率 {policy?.default_position_multiplier ?? '--'}x · 置信{' '}
              {Math.round(Number(policy?.confidence || 0) * 100)}%
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {policyId ? `版本 ${policyId}` : '暂无环境版本'}
            </Text>
          </Space>
        );
      },
    },
    {
      title: '风险闸门',
      width: 190,
      render: (_: any, record: PolicySnapshot) => {
        const gate = getSnapshotRiskGate(record);
        const meta = riskGateMeta(gate?.action || record.metadata?.risk_profile_gate_action);
        return (
          <Space direction="vertical" size={3}>
            <Tag color={meta.color}>{meta.label}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              跟单 {gate?.effective_trade_limit ?? record.effective_paper_trade_limit ?? '--'} ·
              仓位 {formatPercent(gate?.effective_default_position_pct)}
            </Text>
            {gate?.reason && (
              <Text type="secondary" ellipsis={{ tooltip: gate.reason }} style={{ maxWidth: 160 }}>
                {gate.reason}
              </Text>
            )}
          </Space>
        );
      },
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
              <em>
                仓位倍率 {promotion?.position_multiplier ?? '--'}x
                {promotion?.field_gate_confidence_adjustment
                  ? ` · 字段后验 ${formatPercent(
                      Number(promotion.field_gate_confidence_adjustment || 0) * 100
                    )}`
                  : ''}
              </em>
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
        <Col xs={24}>
          <div className="loop-policy-env-version">
            <div>
              <div className="outcome-kicker">
                <CloudSyncOutlined /> Environment Gate Version
              </div>
              <h2>环境闸门版本化</h2>
              <p>
                每次全市场闭环现在都会把大盘/行业环境闸门写入策略快照、信号和模拟交易元数据，后续可按“策略参数
                + 环境版本”双维度比较收益。
              </p>
              <Space wrap>
                <Tag color="cyan">版本：{latestEnvironmentPolicyId || '等待生成'}</Tag>
                <Tag color="gold">
                  默认倍率 {latestEnvironmentPolicy?.default_position_multiplier ?? '--'}x
                </Tag>
                <Tag color="purple">
                  暂停 {latestEnvironmentPolicy?.blocked_segments?.length || 0} · 降仓{' '}
                  {latestEnvironmentPolicy?.reduced_segments?.length || 0} · 放大{' '}
                  {latestEnvironmentPolicy?.boosted_segments?.length || 0}
                </Tag>
              </Space>
            </div>
            <div className="loop-policy-env-meter">
              <span>ENV CONFIDENCE</span>
              <strong>{Math.round(Number(latestEnvironmentPolicy?.confidence || 0) * 100)}%</strong>
              <em>{latestEnvironmentPolicy?.reason || '等待环境闭环样本'}</em>
            </div>
          </div>
        </Col>
      </Row>

      <Row gutter={[18, 18]} style={{ marginBottom: 18 }}>
        <Col xs={24}>
          <Card
            className="modern-card"
            variant="borderless"
            title={
              <Space>
                <CloudSyncOutlined /> 环境版本收益排行榜
              </Space>
            }
          >
            {topEnvironmentVersions.length ? (
              <div className="loop-policy-env-ranking">
                {topEnvironmentVersions.map((item, index) => (
                  <div className="loop-policy-env-rank-row" key={item.key || index}>
                    <div className="loop-policy-env-badge">#{index + 1}</div>
                    <div className="loop-policy-env-rank-main">
                      <Text strong>{item.label || item.key}</Text>
                      <Text type="secondary">
                        版本 {item.count} 次 · 成交 {item.executed || 0} · 计划 {item.planned || 0}
                      </Text>
                    </div>
                    <div className="loop-policy-env-rank-stat">
                      <strong style={{ color: pnlColor(item.avg_outcome_excess_return_pct) }}>
                        {formatPercent(item.avg_outcome_excess_return_pct)}
                      </strong>
                      <span>平均闭环超额</span>
                    </div>
                    <div className="loop-policy-env-rank-stat">
                      <strong>{Number(item.promotion_score || 0).toFixed(1)}</strong>
                      <span>晋级分</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty description="暂无可比较的环境版本收益样本" />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[18, 18]} style={{ marginBottom: 18 }}>
        <Col xs={24}>
          <Card
            className="modern-card"
            variant="borderless"
            title={
              <Space>
                <NodeIndexOutlined /> 组合风险闸门后验
              </Space>
            }
          >
            <Row gutter={[14, 14]}>
              <Col xs={24} lg={8}>
                <div className="loop-policy-champion">
                  <span>保护触发</span>
                  <strong>{riskGateAnalysis?.protected_runs || 0} 次</strong>
                  <em>{riskGateAnalysis?.conclusion || '等待风险闸门触发样本'}</em>
                </div>
              </Col>
              <Col xs={12} lg={8}>
                <div className="loop-policy-champion">
                  <span>正常放行均超额</span>
                  <strong>{formatPercent(riskGateAnalysis?.allow_avg_excess_return_pct)}</strong>
                  <em>allow 样本表现</em>
                </div>
              </Col>
              <Col xs={12} lg={8}>
                <div className="loop-policy-champion">
                  <span>保护后均超额</span>
                  <strong style={{ color: pnlColor(riskGateAnalysis?.protection_delta_pct) }}>
                    {formatPercent(riskGateAnalysis?.protected_avg_excess_return_pct)}
                  </strong>
                  <em>差值 {formatPercent(riskGateAnalysis?.protection_delta_pct)}</em>
                </div>
              </Col>
            </Row>

            {fieldGateAdjustmentAttribution && (
              <div className="loop-policy-field-gate-attribution">
                <div className="loop-policy-field-gate-attribution__main">
                  <Space size={8} wrap>
                    <Text strong>字段门槛调参后验</Text>
                    <Tag
                      color={
                        fieldGateAttributionMeta(
                          fieldGateAdjustmentAttribution.status,
                          fieldGateAdjustmentAttribution.delta_pct
                        ).color
                      }
                    >
                      {
                        fieldGateAttributionMeta(
                          fieldGateAdjustmentAttribution.status,
                          fieldGateAdjustmentAttribution.delta_pct
                        ).label
                      }
                    </Tag>
                    {fieldGateAdjustmentAttribution.task_name && (
                      <Tag>{fieldGateAdjustmentAttribution.task_name}</Tag>
                    )}
                    {fieldGateAdjustmentAttribution.decision?.action && (
                      <Tag
                        color={fieldGateDecisionColor(
                          fieldGateAdjustmentAttribution.decision.action
                        )}
                      >
                        {fieldGateAdjustmentAttribution.decision.label ||
                          fieldGateAdjustmentAttribution.decision.action}
                      </Tag>
                    )}
                  </Space>
                  <Text type="secondary">
                    {fieldGateAdjustmentAttribution.decision?.reason ||
                      fieldGateAdjustmentAttribution.conclusion}
                  </Text>
                </div>
                <div className="loop-policy-field-gate-attribution__stats">
                  <span>前 {fieldGateAdjustmentAttribution.before_sample_count || 0} 个样本</span>
                  <strong>
                    {formatPercent(fieldGateAdjustmentAttribution.before_avg_excess_return_pct)}
                  </strong>
                </div>
                <div className="loop-policy-field-gate-attribution__stats">
                  <span>后 {fieldGateAdjustmentAttribution.after_sample_count || 0} 个样本</span>
                  <strong>
                    {formatPercent(fieldGateAdjustmentAttribution.after_avg_excess_return_pct)}
                  </strong>
                </div>
                <div className="loop-policy-field-gate-attribution__delta">
                  <span>变化</span>
                  <strong style={{ color: pnlColor(fieldGateAdjustmentAttribution.delta_pct) }}>
                    {formatPercent(fieldGateAdjustmentAttribution.delta_pct)}
                  </strong>
                </div>
                {Boolean(fieldGateAdjustmentAttribution.windows?.length) && (
                  <div className="loop-policy-field-gate-attribution__windows">
                    {fieldGateAdjustmentAttribution.windows?.slice(0, 3).map(item => (
                      <span key={item.days}>
                        {item.days}天 · {item.sample_count}样本 ·{' '}
                        <b style={{ color: pnlColor(item.delta_pct) }}>
                          {formatPercent(item.delta_pct)}
                        </b>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {riskGateAnalysis?.suggested_limits && (
              <Alert
                style={{ marginTop: 14, borderRadius: 16 }}
                type={
                  riskGateAnalysis.suggested_limits.action === 'tighten'
                    ? 'warning'
                    : riskGateAnalysis.suggested_limits.action === 'relax'
                    ? 'info'
                    : 'success'
                }
                showIcon
                message={`阈值建议：${riskGateAnalysis.suggested_limits.action}`}
                description={
                  <Space direction="vertical" size={8}>
                    <Text>{riskGateAnalysis.suggested_limits.reason}</Text>
                    {riskGateAnalysis.suggestion_stability && (
                      <Space wrap>
                        <Tag
                          color={riskGateAnalysis.suggestion_stability.can_apply ? 'green' : 'blue'}
                        >
                          {riskGateAnalysis.suggestion_stability.label}
                        </Tag>
                        <Text type="secondary">
                          连续同向 {riskGateAnalysis.suggestion_stability.consecutive_same_action}{' '}
                          次 · 置信度{' '}
                          {formatPercent(
                            Number(riskGateAnalysis.suggestion_stability.confidence || 0) * 100
                          )}
                        </Text>
                      </Space>
                    )}
                    {riskGateAnalysis.suggestion_stability?.reason && (
                      <Text type="secondary">{riskGateAnalysis.suggestion_stability.reason}</Text>
                    )}
                    <Space wrap>
                      <Tag>
                        现金底线{' '}
                        {formatPercent(
                          riskGateAnalysis.suggested_limits.limits?.min_cash_reserve_pct
                        )}
                      </Tag>
                      <Tag>
                        总仓位≤
                        {formatPercent(
                          riskGateAnalysis.suggested_limits.limits?.max_total_exposure_pct
                        )}
                      </Tag>
                      <Tag>
                        行业≤
                        {formatPercent(
                          riskGateAnalysis.suggested_limits.limits?.max_industry_exposure_pct
                        )}
                      </Tag>
                      <Tag>
                        相关≤
                        {formatPercent(
                          Number(
                            riskGateAnalysis.suggested_limits.limits?.max_position_correlation || 0
                          ) * 100
                        )}
                      </Tag>
                      <Tag>
                        VaR≤
                        {formatPercent(
                          riskGateAnalysis.suggested_limits.limits?.max_portfolio_var_pct
                        )}
                      </Tag>
                    </Space>
                    {riskGateAnalysis.threshold_attribution?.items?.length ? (
                      <div className="risk-threshold-attribution-strip">
                        {riskGateAnalysis.threshold_attribution.items
                          .filter((item: any) => item.action !== 'observe')
                          .slice(0, 3)
                          .map((item: any) => (
                            <div key={item.key}>
                              <strong>{item.label}</strong>
                              <Tag color={item.action === 'tighten' ? 'orange' : 'blue'}>
                                {item.action === 'tighten'
                                  ? '收紧'
                                  : item.action === 'relax'
                                  ? '放松'
                                  : '保持'}
                              </Tag>
                              <span>
                                触发 {item.triggered_count}/{item.sample_count} · 差值{' '}
                                {formatPercent(item.trigger_delta_pct)}
                              </span>
                            </div>
                          ))}
                      </div>
                    ) : null}
                    {(riskGateAnalysis.field_gate_advice ||
                      riskGateAnalysis.suggested_limits.field_gate_advice) && (
                      <div className="risk-threshold-field-gate-strip">
                        <Text strong>字段门槛后验</Text>
                        <Text type="secondary">
                          {(
                            riskGateAnalysis.field_gate_advice ||
                            riskGateAnalysis.suggested_limits.field_gate_advice
                          )?.conclusion || '暂无明确字段级门槛调整信号'}
                        </Text>
                        <Space wrap size={[6, 6]}>
                          {(
                            (riskGateAnalysis.field_gate_advice ||
                              riskGateAnalysis.suggested_limits.field_gate_advice)?.items || []
                          )
                            .filter((item: any) => ['tighten', 'relax'].includes(item.action))
                            .slice(0, 2)
                            .map((item: any) => (
                              <Tag key={item.key} color={item.action === 'tighten' ? 'orange' : 'green'}>
                                {getRiskLimitKeyLabel(item.key)} ·{' '}
                                {item.action === 'tighten' ? '更保守' : '可放松'}
                              </Tag>
                            ))}
                        </Space>
                      </div>
                    )}
                  </Space>
                }
              />
            )}

            {riskGateRankings.length ? (
              <div className="loop-policy-env-ranking" style={{ marginTop: 14 }}>
                {riskGateRankings.map((item, index) => {
                  const meta = riskGateMeta(item.key);
                  return (
                    <div className="loop-policy-env-rank-row" key={item.key || index}>
                      <div className="loop-policy-env-badge">#{index + 1}</div>
                      <div className="loop-policy-env-rank-main">
                        <Space size={6} wrap>
                          <Text strong>{item.label || meta.label}</Text>
                          <Tag color={meta.color}>{meta.label}</Tag>
                        </Space>
                        <Text type="secondary">
                          触发 {item.count} 次 · 成交 {item.executed || 0} · 跳过{' '}
                          {Math.max(0, Number(item.count || 0) - Number(item.executed || 0))}
                        </Text>
                      </div>
                      <div className="loop-policy-env-rank-stat">
                        <strong style={{ color: pnlColor(item.avg_outcome_excess_return_pct) }}>
                          {formatPercent(item.avg_outcome_excess_return_pct)}
                        </strong>
                        <span>平均闭环超额</span>
                      </div>
                      <div className="loop-policy-env-rank-stat">
                        <strong>{Number(item.robust_score || 0).toFixed(1)}</strong>
                        <span>稳健分</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty description="暂无风险闸门后验样本" />
            )}
          </Card>
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
          <Card className="modern-card" variant="borderless" title="参数组合冠军榜">
            {topStrategyCombos.length ? (
              <Space direction="vertical" style={{ width: '100%' }} size={10}>
                {topStrategyCombos.map((item, index) => (
                  <div className="loop-policy-combo-row" key={item.key || index}>
                    <div className="loop-policy-combo-rank">#{index + 1}</div>
                    <div className="loop-policy-combo-main">
                      <Space size={6} wrap>
                        <strong>{item.label}</strong>
                        <Tag color={comboActionMeta(item.auto_action).color}>
                          {comboActionMeta(item.auto_action).label}
                        </Tag>
                      </Space>
                      <span>
                        版本 {item.count} 次 · 闭环 {item.closed_count || 0} · 成交{' '}
                        {item.executed || 0} · 贝叶斯胜率 {formatPercent(item.bayesian_win_rate)}
                      </span>
                      <span>
                        风险调整超额 {formatPercent(item.risk_adjusted_excess_return_pct)} ·
                        样本置信 {Math.round(Number(item.sample_confidence || 0) * 100)}%
                      </span>
                    </div>
                    <div className="loop-policy-combo-score">
                      <b style={{ color: pnlColor(item.robust_score) }}>
                        {Number(item.robust_score || 0).toFixed(1)}
                      </b>
                      <span>稳健分</span>
                    </div>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty description="暂无参数组合收益样本" />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[18, 18]} style={{ marginBottom: 18 }}>
        <Col xs={24}>
          <Card className="modern-card" variant="borderless" title="参数维度冠军">
            <Row gutter={[12, 12]}>
              {[
                [
                  '参数组合',
                  promotion?.best_strategy_key?.label,
                  promotion?.best_strategy_key?.avg_outcome_excess_return_pct,
                ],
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
                <Col xs={24} md={12} key={String(label)}>
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
