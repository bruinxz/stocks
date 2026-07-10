import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FireOutlined,
  InfoCircleOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  AutomationHealth,
  AutomationHealthChain,
  LiveShadowBudgetApplyResult,
  QueueJobSummary,
  RiskLimitSuggestionApplyResult,
  ScheduledTask,
  TaskParameterAuditLog,
  TaskExecutionLog,
  taskService,
} from '../services/taskService';
import { riskLimitKeyLabels, riskLimitKeyPriority } from '../constants/riskLimits';
import { DeploymentAuditSummary, ParameterAuditSummary } from '../components/task/AuditSummaries';
import { RiskLimitPreviewModal } from '../components/task/RiskLimitPreviewModal';
import dayjs from 'dayjs';

const { Text, Title } = Typography;
const { Option } = Select;

const taskTypeLabels: Record<string, string> = {
  DAILY_UPDATE: '每日行情增量同步',
  SYNC_ALL_STOCKS: '全市场股票列表同步',
  SYNC_HISTORY: '股票历史行情同步',
  DATA_QUALITY_SCAN: '数据质量扫描',
  BENCHMARK_INDEX_SYNC: '基准指数行情同步',
  QUANT_DAILY_PIPELINE: '量化策略全市场扫描',
  QUANT_PARAM_MAINTENANCE: '量化参数后验维护',
  REALTIME_QUOTE_SYNC: '实时行情快照刷新',
  AI_DAILY_SCREENER: 'AI 每日优选评估',
  AUTO_RECOMMENDATION_LOOP: '全市场荐股闭环',
  SIGNAL_PERFORMANCE_REFRESH: '推荐绩效后验刷新',
  SIGNAL_QUALITY_DAILY_REPORT: '信号质量日报',
  PAPER_TRADING_AUTO_SYNC: '推荐信号模拟盘跟单',
  PAPER_TRADING_RISK_CHECK: '模拟盘风控退出检查',
  PAPER_TRADING_ATTRIBUTION_REPORT: '模拟盘收益归因报告',
  RECOMMENDATION_TRADE_OUTCOME_REFRESH: '推荐交易收益闭环刷新',
  PAPER_TRADING_DAILY_PLAN: '模拟盘交易计划报告',
};

const defaultParametersByType: Record<string, any> = {
  DAILY_UPDATE: {
    force_update: false,
  },
  SYNC_ALL_STOCKS: {},
  SYNC_HISTORY: {
    syncAllStocks: true,
    lookback_days: 10,
    dataSource: 'auto',
    concurrency: 2,
  },
  DATA_QUALITY_SCAN: {
    scope: 'market',
    lookback_days: 180,
    limit: 200,
  },
  AI_DAILY_SCREENER: {
    universe: 'favorites',
    style: 'balanced',
    candidate_limit: 10,
    lookback_days: 120,
  },
  AUTO_RECOMMENDATION_LOOP: {
    username: 'stock',
    universe: 'market',
    style: 'balanced',
    candidate_limit: 30,
    candidate_pool_limit: 360,
    archive_limit: 30,
    verify_signals: true,
    submit_agent_analysis: true,
    agent_max_count: 5,
    agent_min_score: 72,
    run_paper_trading: true,
    dry_run: false,
    use_profit_gate: true,
    use_entry_risk_guard: true,
    use_strategy_experiment_feedback: true,
    risk_threshold_stability_min_consecutive_same_action: 2,
    risk_threshold_stability_min_actionable_samples: 2,
    risk_threshold_stability_min_protected_runs: 3,
    risk_threshold_stability_tighten_min_delta_pct: 0.5,
    risk_threshold_stability_relax_max_delta_pct: -0.8,
    risk_threshold_field_stability_min_consecutive_same_action: 2,
    risk_threshold_field_min_confidence: 0.45,
    risk_threshold_field_min_sample_count: 3,
    risk_threshold_field_min_triggered_count: 1,
    report_to_feishu: true,
  },
  BENCHMARK_INDEX_SYNC: {
    lookback_days: 180,
    data_source: 'tencent_only',
    concurrency: 2,
    report_to_feishu: true,
  },
  QUANT_PARAM_MAINTENANCE: {
    lookback_days: 21,
    horizons: [1, 3, 5, 10],
    signal: ['buy', 'watch'],
    limit: 1500,
    refresh_limit: 5000,
    lifecycle_limit: 5000,
    auto_sync_benchmark: false,
    dry_run_lifecycle: false,
    report_to_feishu: true,
    notify_to_feishu_bot: false,
  },
  REALTIME_QUOTE_SYNC: {
    universe: 'market',
    limit: 360,
    source: 'auto',
    batch_size: 300,
    report_to_feishu: false,
    notify_to_feishu_bot: false,
  },
  QUANT_DAILY_PIPELINE: {
    username: 'stock',
    use_autonomous_portfolio: true,
    universe: 'market',
    strategy_keys: [
      'multi_factor_ranking',
      'relative_strength_momentum',
      'ma_trend',
      'macd_trend',
      'volume_price_confirmation',
      'low_volatility_quality',
    ],
    lookback_days: 180,
    candidate_limit: 220,
    min_score: 55,
    archive_limit: 30,
    submit_agent_analysis: true,
    agent_max_count: 5,
    agent_min_score: 72,
    agent_session: 'close',
    agent_auto_paper_trade: true,
    run_paper_trading: true,
    dry_run: false,
    paper_trade_limit: 3,
    risk_threshold_stability_min_consecutive_same_action: 2,
    risk_threshold_stability_min_actionable_samples: 2,
    risk_threshold_stability_min_protected_runs: 3,
    risk_threshold_stability_tighten_min_delta_pct: 0.5,
    risk_threshold_stability_relax_max_delta_pct: -0.8,
    risk_threshold_field_stability_min_consecutive_same_action: 2,
    risk_threshold_field_min_confidence: 0.45,
    risk_threshold_field_min_sample_count: 3,
    risk_threshold_field_min_triggered_count: 1,
    report_to_feishu: true,
  },
  SIGNAL_PERFORMANCE_REFRESH: {
    limit: 500,
    report_to_feishu: true,
  },
  SIGNAL_QUALITY_DAILY_REPORT: {
    horizon: '5d',
    lookback_days: 30,
    min_samples: 5,
    auto_repair_missing_data: true,
    report_to_feishu: true,
  },
  PAPER_TRADING_AUTO_SYNC: {
    username: 'stock',
    refresh_recommendations: true,
    universe: 'market',
    style: 'balanced',
    candidate_limit: 30,
    use_profit_gate: true,
    dry_run: false,
    report_to_feishu: true,
  },
  PAPER_TRADING_RISK_CHECK: {
    username: 'stock',
    enable_stop_loss: true,
    enable_take_profit: true,
    enable_trailing_take_profit: true,
    enable_sell_signals: true,
    use_adaptive_risk_policy: true,
    adaptive_risk_lookback_days: 180,
    adaptive_risk_min_closed_samples: 5,
    adaptive_risk_override_signal_params: false,
    trailing_activation_pct: 8,
    trailing_drawdown_pct: 4,
    dry_run: false,
    report_to_feishu: true,
  },
  PAPER_TRADING_ATTRIBUTION_REPORT: {
    username: 'stock',
    include_open: true,
    report_to_feishu: true,
  },
  RECOMMENDATION_TRADE_OUTCOME_REFRESH: {
    username: 'stock',
    include_open: true,
    lookback_days: 180,
    limit: 2000,
    report_to_feishu: true,
  },
  PAPER_TRADING_DAILY_PLAN: {
    username: 'stock',
    include_entries: true,
    include_exits: true,
    include_monitor: true,
    enable_trailing_take_profit: true,
    use_adaptive_risk_policy: true,
    adaptive_risk_lookback_days: 180,
    adaptive_risk_min_closed_samples: 5,
    adaptive_risk_override_signal_params: false,
    trailing_activation_pct: 8,
    trailing_drawdown_pct: 4,
    report_to_feishu: true,
  },
};

const queueStateLabels: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  active: '执行中',
  waiting: '等待中',
  delayed: '延迟中',
  paused: '已暂停',
  unknown: '未知',
};

const healthLabelMap: Record<string, string> = {
  healthy: '链路健康',
  warning: '需要关注',
  critical: '需要修复',
};

const healthColorMap: Record<string, string> = {
  healthy: 'success',
  warning: 'warning',
  critical: 'error',
};

const getLastRunStatusColor = (status?: string) => {
  if (status === 'SUCCESS') return 'success';
  if (status === 'FAILED') return 'error';
  return 'processing';
};

const getQueueStateColor = (state?: string) => {
  if (state === 'completed') return 'success';
  if (state === 'failed') return 'error';
  if (state === 'active') return 'processing';
  if (state === 'waiting' || state === 'delayed') return 'warning';
  return 'default';
};

const formatQueueTime = (timestamp?: number) =>
  timestamp ? dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss') : '-';

const formatDateTime = (value?: string | null) =>
  value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-';

const formatPercent = (value?: number | string | null) => {
  const num = Number(value || 0);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : '-';
};

const formatQueueProgress = (progress: any) => {
  if (progress === null || progress === undefined || progress === '') return '-';
  if (typeof progress === 'number') return `${progress}%`;
  if (typeof progress === 'object') return JSON.stringify(progress);
  return String(progress);
};

const getRiskFieldEvidenceScore = (evidence: any) => {
  const confidence = Number(evidence?.confidence || 0);
  const sampleCount = Number(evidence?.sample_count || 0);
  const triggeredCount = Number(evidence?.triggered_count || 0);
  const stability = evidence?.stability || {};
  const sameAction = Number(stability.consecutive_same_action || 0);
  const minSameAction = Number(stability.min_consecutive_same_action || 2);
  const minConfidence = Number(stability.min_confidence || 0.45);
  const minSampleCount = Number(stability.min_sample_count || 3);
  const minTriggeredCount = Number(stability.min_triggered_count || 1);
  const ratio = (value: number, target: number) => (target > 0 ? Math.min(value / target, 1) : 0);
  return (
    ratio(confidence, minConfidence) * 0.35 +
    ratio(sampleCount, minSampleCount) * 0.25 +
    ratio(triggeredCount, minTriggeredCount) * 0.2 +
    ratio(sameAction, minSameAction) * 0.2
  );
};

const auditEventLabels: Record<string, string> = {
  task_created: '任务创建',
  task_updated: '参数更新',
  risk_limit_suggestion_applied: '风险阈值应用',
  risk_stability_settings_updated: '稳定性门槛',
  live_shadow_budget_suggestion: '影子预算建议',
  live_shadow_budget_applied: '影子预算已应用',
  deployment_smoke_passed: '部署验证通过',
  deployment_smoke_failed: '部署验证失败',
  deployment_smoke_skipped: '部署验证跳过',
};

const auditEventColors: Record<string, string> = {
  task_created: 'blue',
  task_updated: 'default',
  risk_limit_suggestion_applied: 'green',
  risk_stability_settings_updated: 'purple',
  live_shadow_budget_suggestion: 'cyan',
  live_shadow_budget_applied: 'green',
  deployment_smoke_passed: 'green',
  deployment_smoke_failed: 'red',
  deployment_smoke_skipped: 'gold',
};

const defaultRiskStabilitySettings = {
  min_consecutive_same_action: 2,
  min_actionable_samples: 2,
  min_protected_runs: 3,
  tighten_min_delta_pct: 0.5,
  relax_max_delta_pct: -0.8,
  field_min_consecutive_same_action: 2,
  field_min_confidence: 0.45,
  field_min_sample_count: 3,
  field_min_triggered_count: 1,
};

const formatRiskLimitValue = (key: string, value: any) => {
  if (value === null || value === undefined || value === '') return '未配置';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (key === 'max_position_correlation') return num.toFixed(2);
  if (key.startsWith('risk_threshold_stability_')) {
    const isCountKey =
      key.includes('consecutive') || key.includes('samples') || key.includes('protected_runs');
    return isCountKey ? `${num.toFixed(0)} 次` : `${num.toFixed(2)}pct`;
  }
  if (key.startsWith('risk_threshold_field_stability_')) return `${num.toFixed(0)} 次`;
  if (key === 'risk_threshold_field_min_confidence') return num.toFixed(2);
  if (
    key === 'risk_threshold_field_min_sample_count' ||
    key === 'risk_threshold_field_min_triggered_count'
  )
    return `${num.toFixed(0)} 次`;
  return `${num.toFixed(2)}%`;
};

const stringifyJson = (value: any) => {
  if (value === null || value === undefined || value === '') return '-';
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
};

const getRuntimeHealthTagColor = (status?: string) => {
  if (status === 'ready' || status === 'ok' || status === 'healthy') return 'green';
  if (status === 'risk' || status === 'critical') return 'red';
  if (status === 'warn' || status === 'warning') return 'gold';
  return 'default';
};

const getChainIcon = (key: string) => {
  if (key === 'market_data') return <DatabaseOutlined />;
  if (key === 'auto_recommendation_loop') return <ThunderboltOutlined />;
  if (key === 'signal_feedback') return <RadarChartOutlined />;
  if (key === 'paper_trading') return <SafetyCertificateOutlined />;
  if (key === 'trade_outcome_loop') return <NodeIndexOutlined />;
  return <ApiOutlined />;
};

const TaskScheduler: React.FC = () => {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [health, setHealth] = useState<AutomationHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [currentLogs, setCurrentLogs] = useState<TaskExecutionLog[]>([]);
  const [activeTaskName, setActiveTaskName] = useState<string>('');
  const [queueDetail, setQueueDetail] = useState<QueueJobSummary | null>(null);
  const [isQueueDetailVisible, setIsQueueDetailVisible] = useState(false);
  const [quickCreatingQuant, setQuickCreatingQuant] = useState(false);
  const [riskLimitApplying, setRiskLimitApplying] = useState(false);
  const [riskLimitPreview, setRiskLimitPreview] = useState<RiskLimitSuggestionApplyResult | null>(
    null
  );
  const [shadowBudgetApplying, setShadowBudgetApplying] = useState(false);
  const [shadowBudgetPreview, setShadowBudgetPreview] =
    useState<LiveShadowBudgetApplyResult | null>(null);
  const [isRiskLimitModalVisible, setIsRiskLimitModalVisible] = useState(false);
  const [isShadowBudgetModalVisible, setIsShadowBudgetModalVisible] = useState(false);
  const [isStabilityModalVisible, setIsStabilityModalVisible] = useState(false);
  const [stabilitySaving, setStabilitySaving] = useState(false);
  const [auditLogs, setAuditLogs] = useState<TaskParameterAuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditFilter, setAuditFilter] = useState<'watched' | 'deployment' | 'all'>('watched');
  const [deploymentAudits, setDeploymentAudits] = useState<TaskParameterAuditLog[]>([]);
  const [deploymentAuditLoading, setDeploymentAuditLoading] = useState(false);
  const [auditExpanded, setAuditExpanded] = useState(false);
  const [auditDetail, setAuditDetail] = useState<TaskParameterAuditLog | null>(null);
  const [fieldGateSuggestionFilled, setFieldGateSuggestionFilled] = useState(false);
  const [form] = Form.useForm();
  const [stabilityForm] = Form.useForm();

  const fetchTasks = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const data = await taskService.getTasks(signal);
      if (signal?.aborted) return;
      setTasks(data);
    } catch (error: any) {
      if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') return;
      if (signal?.aborted) return;
      message.error('获取任务列表失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  const fetchHealth = useCallback(async (signal?: AbortSignal) => {
    setHealthLoading(true);
    try {
      const data = await taskService.getAutomationHealth(signal);
      if (signal?.aborted) return;
      setHealth(data);
    } catch (error: any) {
      if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') return;
      if (signal?.aborted) return;
      message.error('获取自动化健康状态失败');
    } finally {
      if (!signal?.aborted) setHealthLoading(false);
    }
  }, []);

  const fetchAuditLogs = useCallback(async (signal?: AbortSignal) => {
    setAuditLoading(true);
    try {
      setAuditExpanded(false);
      const data = await taskService.getTaskParameterAudits(
        {
          limit: auditFilter === 'deployment' ? 20 : 12,
          watched_only: auditFilter === 'watched',
          event_type: auditFilter === 'deployment' ? 'deployment_smoke' : undefined,
        },
        signal
      );
      if (signal?.aborted) return;
      setAuditLogs(
        auditFilter === 'deployment'
          ? data.filter(item => String(item.event_type || '').startsWith('deployment_smoke_'))
          : data
      );
    } catch (error: any) {
      if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') return;
      if (signal?.aborted) return;
      // 审计不阻断主链路展示，旧库首次启动前可能还没有表。
      setAuditLogs([]);
    } finally {
      if (!signal?.aborted) setAuditLoading(false);
    }
  }, [auditFilter]);

  const fetchDeploymentAudits = useCallback(async (signal?: AbortSignal) => {
    setDeploymentAuditLoading(true);
    try {
      const data = await taskService.getTaskParameterAudits(
        {
          limit: 6,
          event_type: 'deployment_smoke',
          watched_only: false,
        },
        signal
      );
      if (signal?.aborted) return;
      setDeploymentAudits(
        data.filter(item => String(item.event_type || '').startsWith('deployment_smoke_'))
      );
    } catch (error: any) {
      if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') return;
      if (signal?.aborted) return;
      setDeploymentAudits([]);
    } finally {
      if (!signal?.aborted) setDeploymentAuditLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async (signal?: AbortSignal) => {
    await Promise.all([
      fetchTasks(signal),
      fetchHealth(signal),
      fetchAuditLogs(signal),
      fetchDeploymentAudits(signal),
    ]);
  }, [fetchAuditLogs, fetchDeploymentAudits, fetchHealth, fetchTasks]);

  // 每次 mount / 手动 refresh / mutation-triggered refresh / 按钮 click 用独立 AbortController，
  // 保证只提交本次结果，旧的 in-flight 请求被 abort，避免 late-arriver 覆盖新状态。
  const tickControllerRef = useRef<AbortController | null>(null);

  const refreshFresh = useCallback(async () => {
    if (tickControllerRef.current) tickControllerRef.current.abort();
    const c = new AbortController();
    tickControllerRef.current = c;
    await refreshAll(c.signal);
  }, [refreshAll]);

  useEffect(() => {
    const mountController = new AbortController();
    tickControllerRef.current = mountController;
    void refreshAll(mountController.signal);
    return () => {
      if (tickControllerRef.current) tickControllerRef.current.abort();
      tickControllerRef.current = null;
    };
  }, [refreshAll]);

  const healthTone = health?.status || 'warning';
  const latestLoop = health?.latest_loop;
  const topSkipReasons = latestLoop?.paper_trading?.skip_reason_summary?.top_reasons || [];
  const latestRiskGate = latestLoop?.risk_profile_gate;
  const latestRiskProfile = latestLoop?.risk_profile;
  const riskLimitSuggestion = health?.risk_limit_suggestion;
  const riskLimitTargets = riskLimitSuggestion?.targets || [];
  const riskLimitStability = riskLimitSuggestion?.stability;
  const riskLimitCanApply = Boolean(
    riskLimitStability?.can_apply && riskLimitTargets.some((target: any) => target.changed)
  );
  const riskLimitFieldStabilityFirst = riskLimitSuggestion?.field_stability
    ? (Object.values(riskLimitSuggestion.field_stability as Record<string, any>)[0] as any)
    : null;
  const riskFieldGateAdvice = riskLimitSuggestion?.field_gate_advice;
  const riskFieldGateAdjustmentAttribution = riskLimitSuggestion?.field_gate_adjustment_attribution;
  const riskFieldGateAdviceItems = Array.isArray(riskFieldGateAdvice?.items)
    ? riskFieldGateAdvice.items.filter((item: any) => ['tighten', 'relax'].includes(item.action))
    : [];
  const riskFieldGateSuggestedParams = riskFieldGateAdviceItems.reduce(
    (summary: Record<string, any>, item: any) => ({
      ...summary,
      ...(item.suggested_parameters || {}),
    }),
    {} as Record<string, any>
  );
  const latestDeploymentAudit = deploymentAudits[0];
  const latestDeploymentSummary = latestDeploymentAudit?.after_parameters || {};
  const latestLocalRegression =
    latestDeploymentSummary.local_regression || latestDeploymentAudit?.metadata?.local_regression;
  const latestDeploymentResults = Array.isArray(latestDeploymentAudit?.metadata?.results)
    ? latestDeploymentAudit.metadata?.results || []
    : [];
  const latestDeploymentFailures = latestDeploymentResults.filter(
    (item: any) => item?.status === 'fail'
  );
  const consecutiveDeploymentSkips = deploymentAudits.findIndex(
    item => item.event_type !== 'deployment_smoke_skipped'
  );
  const deploymentSkipStreak =
    consecutiveDeploymentSkips === -1 ? deploymentAudits.length : consecutiveDeploymentSkips;
  const latestDeploymentTone =
    latestDeploymentAudit?.event_type === 'deployment_smoke_failed'
      ? 'critical'
      : latestDeploymentAudit?.event_type === 'deployment_smoke_skipped'
        ? 'warning'
        : latestDeploymentAudit
          ? 'healthy'
          : 'warning';
  const latestShadowBudgetSuggestion = auditLogs.find(
    item => item.event_type === 'live_shadow_budget_suggestion'
  );
  const visibleAuditLogs = auditExpanded ? auditLogs : auditLogs.slice(0, 4);

  const taskStats = useMemo(() => {
    const active = tasks.filter(item => item.is_active).length;
    const failed = tasks.filter(item => item.last_run_status === 'FAILED').length;
    const running = tasks.filter(item => item.last_run_status === 'RUNNING').length;
    return { active, failed, running };
  }, [tasks]);

  const handleAdd = () => {
    setEditingTask(null);
    form.resetFields();
    form.setFieldsValue({
      is_active: true,
      type: 'DAILY_UPDATE',
      cron_expression: '10 17 * * 1-5',
      parameters: JSON.stringify(defaultParametersByType.DAILY_UPDATE, null, 2),
    });
    setIsModalVisible(true);
  };

  const handleEdit = (record: ScheduledTask) => {
    setEditingTask(record);
    form.setFieldsValue({
      ...record,
      parameters: record.parameters ? JSON.stringify(record.parameters, null, 2) : '',
    });
    setIsModalVisible(true);
  };

  const handleDelete = (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除这个定时任务吗？',
      onOk: async () => {
        try {
          await taskService.deleteTask(id);
          message.success('删除成功');
          refreshFresh();
        } catch (error) {
          message.error('删除失败');
        }
      },
    });
  };

  const handleExecute = (id: number) => {
    Modal.confirm({
      title: '确认立即执行',
      content: '确定要忽略定时配置，立刻在后台触发一次该任务吗？',
      onOk: async () => {
        try {
          await taskService.executeTask(id);
          message.success('任务已在后台触发执行');
          refreshFresh();
        } catch (error) {
          message.error('触发执行失败');
        }
      },
    });
  };

  const handleEnsureQuantTask = async () => {
    setQuickCreatingQuant(true);
    try {
      const existing = tasks.find(task => task.type === 'QUANT_DAILY_PIPELINE');
      const payload = {
        name: '量化策略全市场扫描',
        type: 'QUANT_DAILY_PIPELINE',
        cron_expression: '32 15 * * 1-5',
        is_active: true,
        parameters: defaultParametersByType.QUANT_DAILY_PIPELINE,
      };
      if (existing?.id) {
        await taskService.updateTask(existing.id, {
          ...payload,
          parameters: { ...payload.parameters, ...(existing.parameters || {}) },
        });
        message.success('已检查并更新量化全市场扫描任务');
      } else {
        await taskService.createTask(payload);
        message.success('已创建量化全市场扫描任务');
      }
      await refreshFresh();
    } catch (error: any) {
      message.error(error?.response?.data?.message || '创建/更新量化任务失败');
    } finally {
      setQuickCreatingQuant(false);
    }
  };

  const handlePreviewRiskLimitApply = async () => {
    setRiskLimitApplying(true);
    try {
      const result = await taskService.applyRiskLimitSuggestion({
        dry_run: true,
        source_loop_run_id: riskLimitSuggestion?.source_loop_run_id,
      });
      setRiskLimitPreview(result);
      setIsRiskLimitModalVisible(true);
      if (!result.changes?.length) {
        message.info(result.message || '当前没有需要更新的风险阈值');
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || '生成风险阈值变更预览失败');
    } finally {
      setRiskLimitApplying(false);
    }
  };

  const handleConfirmRiskLimitApply = () => {
    if (!riskLimitPreview?.changes?.length) return;
    if (!riskLimitPreview.stability?.can_apply) {
      message.warning('当前风险阈值建议还未形成连续同向信号，暂不建议应用。');
      return;
    }
    Modal.confirm({
      title: '确认应用风险阈值建议',
      content:
        '该操作只会更新全市场荐股闭环与量化全市场扫描的风险阈值参数，并会重新加载已启用的定时任务。不会修改交易记录或立即触发交易。',
      okText: '确认应用',
      cancelText: '再看看',
      onOk: async () => {
        setRiskLimitApplying(true);
        try {
          const result = await taskService.applyRiskLimitSuggestion({
            dry_run: false,
            task_ids: riskLimitPreview.changes.map(item => item.id),
            source_loop_run_id: riskLimitPreview.source_loop_run_id || undefined,
          });
          setRiskLimitPreview(result);
          message.success(result.message || '风险阈值建议已应用');
          await refreshFresh();
        } catch (error: any) {
          message.error(error?.response?.data?.message || '应用风险阈值建议失败');
        } finally {
          setRiskLimitApplying(false);
        }
      },
    });
  };

  const handlePreviewShadowBudgetApply = async (audit?: TaskParameterAuditLog) => {
    setShadowBudgetApplying(true);
    try {
      const result = await taskService.applyLiveShadowBudgetSuggestion({
        audit_id: audit?.id || latestShadowBudgetSuggestion?.id,
        dry_run: true,
      });
      setShadowBudgetPreview(result);
      setIsShadowBudgetModalVisible(true);
      if (!result.changed_keys?.length) {
        message.info(result.message || '影子预算已与建议一致');
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || '生成影子预算应用预览失败');
    } finally {
      setShadowBudgetApplying(false);
    }
  };

  const handleConfirmShadowBudgetApply = () => {
    if (!shadowBudgetPreview?.audit_id) return;
    Modal.confirm({
      title: '确认应用影子预算建议',
      content:
        '该操作只会更新 LIVE_SHADOW_AUTOPILOT 的影子执行 limit 和说明字段，不会执行任务，也不会提交真实券商委托。',
      okText: '确认应用',
      cancelText: '再看看',
      onOk: async () => {
        setShadowBudgetApplying(true);
        try {
          const result = await taskService.applyLiveShadowBudgetSuggestion({
            audit_id: shadowBudgetPreview.audit_id,
            dry_run: false,
          });
          message.success(result.message || '影子预算建议已应用');
          setIsShadowBudgetModalVisible(false);
          setShadowBudgetPreview(null);
          await refreshFresh();
        } catch (error: any) {
          message.error(error?.response?.data?.message || '应用影子预算建议失败');
        } finally {
          setShadowBudgetApplying(false);
        }
      },
    });
  };

  const handleOpenStabilitySettings = () => {
    const target =
      tasks.find(task => task.type === 'AUTO_RECOMMENDATION_LOOP') ||
      tasks.find(task => task.type === 'QUANT_DAILY_PIPELINE');
    const params = target?.parameters || {};
    stabilityForm.setFieldsValue({
      min_consecutive_same_action:
        params.risk_threshold_stability_min_consecutive_same_action ??
        riskLimitStability?.thresholds?.min_consecutive_same_action ??
        2,
      min_actionable_samples:
        params.risk_threshold_stability_min_actionable_samples ??
        riskLimitStability?.thresholds?.min_actionable_samples ??
        2,
      min_protected_runs:
        params.risk_threshold_stability_min_protected_runs ??
        riskLimitStability?.thresholds?.min_protected_runs ??
        3,
      tighten_min_delta_pct:
        params.risk_threshold_stability_tighten_min_delta_pct ??
        riskLimitStability?.thresholds?.tighten_min_protection_delta_pct ??
        0.5,
      relax_max_delta_pct:
        params.risk_threshold_stability_relax_max_delta_pct ??
        riskLimitStability?.thresholds?.relax_max_protection_delta_pct ??
        -0.8,
      field_min_consecutive_same_action:
        params.risk_threshold_field_stability_min_consecutive_same_action ?? 2,
      field_min_confidence: params.risk_threshold_field_min_confidence ?? 0.45,
      field_min_sample_count: params.risk_threshold_field_min_sample_count ?? 3,
      field_min_triggered_count: params.risk_threshold_field_min_triggered_count ?? 1,
    });
    setFieldGateSuggestionFilled(false);
    setIsStabilityModalVisible(true);
  };

  const handleSaveStabilitySettings = async () => {
    try {
      const values = await stabilityForm.validateFields();
      const targetTasks = tasks.filter(task =>
        ['AUTO_RECOMMENDATION_LOOP', 'QUANT_DAILY_PIPELINE'].includes(task.type)
      );
      if (!targetTasks.length) {
        message.warning('未找到可更新的全市场荐股闭环或量化扫描任务');
        return;
      }
      Modal.confirm({
        title: '确认更新稳定性门槛',
        content:
          '该操作只会更新关键任务参数中的 risk_threshold_stability_* 字段，不会立即触发交易或修改风险阈值。',
        okText: '确认更新',
        cancelText: '取消',
        onOk: async () => {
          setStabilitySaving(true);
          try {
            await Promise.all(
              targetTasks.flatMap(task => {
                if (!task.id) return [];
                return [
                  taskService.updateTask(task.id, {
                    audit_event_type: 'risk_stability_settings_updated',
                    parameters: {
                      ...(task.parameters || {}),
                      risk_threshold_stability_min_consecutive_same_action:
                        values.min_consecutive_same_action,
                      risk_threshold_stability_min_actionable_samples:
                        values.min_actionable_samples,
                      risk_threshold_stability_min_protected_runs: values.min_protected_runs,
                      risk_threshold_stability_tighten_min_delta_pct: values.tighten_min_delta_pct,
                      risk_threshold_stability_relax_max_delta_pct: values.relax_max_delta_pct,
                      risk_threshold_field_stability_min_consecutive_same_action:
                        values.field_min_consecutive_same_action,
                      risk_threshold_field_min_confidence: values.field_min_confidence,
                      risk_threshold_field_min_sample_count: values.field_min_sample_count,
                      risk_threshold_field_min_triggered_count: values.field_min_triggered_count,
                      risk_threshold_stability_updated_at: new Date().toISOString(),
                      risk_threshold_stability_update_note: 'updated_from_task_scheduler_safe_form',
                      risk_threshold_field_gate_update_source: fieldGateSuggestionFilled
                        ? 'filled_from_outcome_advice'
                        : 'manual_input',
                    },
                  }),
                ];
              })
            );
            message.success('稳定性门槛已更新');
            setIsStabilityModalVisible(false);
            await refreshFresh();
          } catch (error: any) {
            message.error(error?.response?.data?.message || '稳定性门槛更新失败');
          } finally {
            setStabilitySaving(false);
          }
        },
      });
    } catch (error) {
      // 表单校验失败时不提示额外错误，AntD 会标注字段。
    }
  };

  const handleFillFieldGateSuggestedValues = () => {
    if (!Object.keys(riskFieldGateSuggestedParams).length) {
      message.info('当前没有可填入的字段级门槛建议值');
      return;
    }
    stabilityForm.setFieldsValue({
      field_min_confidence:
        riskFieldGateSuggestedParams.risk_threshold_field_min_confidence ??
        stabilityForm.getFieldValue('field_min_confidence'),
      field_min_sample_count:
        riskFieldGateSuggestedParams.risk_threshold_field_min_sample_count ??
        stabilityForm.getFieldValue('field_min_sample_count'),
      field_min_triggered_count:
        riskFieldGateSuggestedParams.risk_threshold_field_min_triggered_count ??
        stabilityForm.getFieldValue('field_min_triggered_count'),
      field_min_consecutive_same_action:
        riskFieldGateSuggestedParams.risk_threshold_field_stability_min_consecutive_same_action ??
        stabilityForm.getFieldValue('field_min_consecutive_same_action'),
    });
    setFieldGateSuggestionFilled(true);
    message.info('已填入建议值；尚未保存，确认后需点击“保存到关键任务”。');
  };

  const handleToggleActive = async (id: number, checked: boolean) => {
    try {
      await taskService.updateTask(id, { is_active: checked });
      message.success(checked ? '任务已启用' : '任务已禁用');
      refreshFresh();
    } catch (error) {
      message.error('状态更新失败');
    }
  };

  const handleModalOk = () => {
    form.validateFields().then(async (values: any) => {
      try {
        let parameters = null;
        if (values.parameters) {
          try {
            parameters = JSON.parse(values.parameters);
          } catch (e) {
            message.error('参数必须是有效的 JSON 格式');
            return;
          }
        }

        const data = { ...values, parameters };

        if (editingTask && editingTask.id) {
          await taskService.updateTask(editingTask.id, data);
          message.success('更新成功');
        } else {
          await taskService.createTask(data);
          message.success('创建成功');
        }

        setIsModalVisible(false);
        refreshFresh();
      } catch (error) {
        message.error('操作失败');
      }
    });
  };

  const handleViewLogs = async (record: ScheduledTask) => {
    setActiveTaskName(record.name);
    setIsLogModalVisible(true);
    setLogLoading(true);
    setCurrentLogs([]);
    try {
      if (!record.id) return;
      const logs = await taskService.getTaskLogs(record.id);
      setCurrentLogs(logs);
    } catch (error: any) {
      const detail =
        error?.response?.data?.details || error?.response?.data?.message || error?.message || '';
      message.error(`获取日志失败${detail ? `：${detail}` : ''}`);
    } finally {
      setLogLoading(false);
    }
  };

  const renderHealthChain = (chain: AutomationHealthChain) => (
    <div className={`automation-chain-card automation-chain-card--${chain.status}`} key={chain.key}>
      <div className="automation-chain-card__head">
        <span className="automation-chain-card__icon">{getChainIcon(chain.key)}</span>
        <div>
          <div className="automation-chain-card__title">{chain.title}</div>
          <Text type="secondary">{chain.subtitle}</Text>
        </div>
        <Tag color={healthColorMap[chain.status]}>{healthLabelMap[chain.status]}</Tag>
      </div>

      <div className="automation-chain-card__meta">
        <span>
          启用 {chain.active_count}/{chain.task_count}
        </span>
        <span>问题 {chain.issues.length}</span>
      </div>

      <Timeline
        className="automation-chain-timeline"
        items={chain.tasks.map(task => {
          const isMissing = task.type === 'MISSING';
          const statusColor = isMissing
            ? 'red'
            : task.last_run_status === 'FAILED'
              ? 'red'
              : task.last_run_status === 'RUNNING'
                ? 'blue'
                : task.is_active
                  ? 'green'
                  : 'gray';
          return {
            color: statusColor,
            children: (
              <div className="automation-chain-task">
                <Space size={6} wrap>
                  <Text strong>{task.name}</Text>
                  {!isMissing && (
                    <Tag color={task.is_active ? 'green' : 'default'}>
                      {task.is_active ? 'ON' : 'OFF'}
                    </Tag>
                  )}
                  {task.last_run_status && (
                    <Tag color={getLastRunStatusColor(task.last_run_status)}>
                      {task.last_run_status}
                    </Tag>
                  )}
                </Space>
                <div className="automation-chain-task__sub">
                  {task.cron_expression ? <Text code>{task.cron_expression}</Text> : '-'} · 最近{' '}
                  {formatDateTime(task.last_run_at || task.last_log_started_at)}
                </div>
              </div>
            ),
          };
        })}
      />

      {chain.issues.length > 0 && (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {chain.issues.slice(0, 3).map((issue, index) => (
            <Alert
              key={`${issue.code}-${index}`}
              type={issue.level === 'critical' ? 'error' : 'warning'}
              message={issue.message}
              showIcon
            />
          ))}
        </Space>
      )}
    </div>
  );

  const columns = [
    {
      title: '任务名称',
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record: ScheduledTask) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {taskTypeLabels[record.type] || record.type}
          </Text>
        </Space>
      ),
    },
    {
      title: '任务类型',
      dataIndex: 'type',
      key: 'type',
      render: (text: string) => <Tag color="blue">{text}</Tag>,
    },
    {
      title: 'Cron 表达式',
      dataIndex: 'cron_expression',
      key: 'cron_expression',
      render: (text: string) => <Text code>{text}</Text>,
    },
    {
      title: '状态',
      key: 'is_active',
      render: (_: any, record: ScheduledTask) => (
        <Switch
          checked={record.is_active}
          onChange={checked => record.id && handleToggleActive(record.id, checked)}
        />
      ),
    },
    {
      title: '上次运行',
      key: 'lastRun',
      render: (_: any, record: ScheduledTask) => (
        <Space direction="vertical" size={0}>
          {record.last_run_at ? new Date(record.last_run_at).toLocaleString() : '-'}
          {record.last_run_status && (
            <Tag color={getLastRunStatusColor(record.last_run_status)}>
              {record.last_run_status}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: ScheduledTask) => (
        <Space size="small" wrap>
          <Button
            type="link"
            icon={<PlayCircleOutlined />}
            onClick={() => record.id && handleExecute(record.id)}
            style={{ color: '#008f6b' }}
          >
            执行
          </Button>
          <Button type="link" onClick={() => handleViewLogs(record)}>
            历史记录
          </Button>
          <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Button
            type="link"
            danger
            icon={<DeleteOutlined />}
            onClick={() => record.id && handleDelete(record.id)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const renderAuditLog = (item: TaskParameterAuditLog) => {
    const visibleDiffs = (item.diffs || []).slice(0, 3);
    const isDeploymentSmoke = String(item.event_type || '').startsWith('deployment_smoke_');
    const failedSmoke = item.event_type === 'deployment_smoke_failed';
    const after = item.after_parameters || {};
    const fromOutcomeAdvice =
      after.risk_threshold_field_gate_update_source === 'filled_from_outcome_advice';
    const shadowAdvice = item.metadata?.outcome_summary;
    const isShadowBudgetSuggestion = item.event_type === 'live_shadow_budget_suggestion';
    return (
      <div
        className={`task-audit-row ${failedSmoke ? 'task-audit-row--danger' : ''}`}
        key={item.id}
      >
        <div className="task-audit-row__head">
          <Space size={6} wrap>
            <Tag color={auditEventColors[item.event_type] || 'default'}>
              {auditEventLabels[item.event_type] || item.event_type}
            </Tag>
            <Text strong>{item.task_name}</Text>
            {fromOutcomeAdvice && <Tag color="cyan">收益后验建议</Tag>}
            {isShadowBudgetSuggestion && <Tag color="geekblue">仅候选不自动应用</Tag>}
          </Space>
          <Space size={6}>
            {isShadowBudgetSuggestion && (
              <Button
                size="small"
                type="link"
                loading={shadowBudgetApplying}
                onClick={() => handlePreviewShadowBudgetApply(item)}
              >
                应用预览
              </Button>
            )}
            <Text type="secondary">{formatDateTime(item.created_at)}</Text>
          </Space>
        </div>
        <div className="task-audit-row__body">
          <Text type="secondary">
            {isDeploymentSmoke
              ? `通过 ${after.passed || 0} · 失败 ${after.failed || 0} · 关键失败 ${
                  after.critical_failed || 0
                }${after.deployment_id ? ` · ${after.deployment_id}` : ''}${
                  after.skip_reason ? ` · ${after.skip_reason}` : ''
                }${
                  after.local_regression
                    ? ` · 本地回归 ${after.local_regression.passed || 0}/${
                        after.local_regression.total || 0
                      }`
                    : ''
                } · ${after.base_url || ''}`
              : isShadowBudgetSuggestion
                ? `建议 ${
                    shadowAdvice?.budget_label || after.shadow_budget_advice?.label || '-'
                  } · limit ${item.before_parameters?.limit ?? '-'} → ${after.limit ?? '-'} · ${
                    shadowAdvice?.budget_reason || after.shadow_budget_advice?.reason || ''
                  }`
                : `${item.operator_username ? `${item.operator_username} · ` : ''}更新 ${
                    item.changed_keys?.length || 0
                  } 项${item.source_loop_run_id ? ` · 来源 ${item.source_loop_run_id}` : ''}`}
          </Text>
          <div className="task-audit-row__foot">
            <Space wrap size={[6, 6]}>
              {visibleDiffs.map(diff => (
                <Tag key={`${item.id}-${diff.key}`} className="task-audit-diff-tag">
                  {riskLimitKeyLabels[diff.key] || diff.key}:{' '}
                  {formatRiskLimitValue(diff.key, diff.before)} →{' '}
                  {formatRiskLimitValue(diff.key, diff.after)}
                </Tag>
              ))}
              {(item.diffs || []).length > visibleDiffs.length && (
                <Tag>+{(item.diffs || []).length - visibleDiffs.length}</Tag>
              )}
            </Space>
            <Button size="small" type="link" onClick={() => setAuditDetail(item)}>
              详情
            </Button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="task-ops-page fade-in-up">
      <div className={`task-ops-hero task-ops-hero--${healthTone}`}>
        <div className="task-ops-hero__content">
          <Tag
            color={healthColorMap[healthTone]}
            icon={healthTone === 'healthy' ? <CheckCircleOutlined /> : <WarningOutlined />}
          >
            {healthLabelMap[healthTone] || '健康检查'}
          </Tag>
          <h1>调度任务中心</h1>
          <p>
            管理 cron 调度任务，覆盖行情同步、全市场扫描、Agent
            复核、模拟盘交易到收益反哺的整条链路。 目前共 31
            个活跃任务，覆盖开盘前数据预热、盘中实时刷新、盘后 AI 复盘、风控告警全流程。
          </p>
          <Space wrap>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={loading || healthLoading}
              onClick={refreshFresh}
            >
              刷新链路状态
            </Button>
            <Button icon={<PlusOutlined />} onClick={handleAdd}>
              新建任务
            </Button>
            <Button
              icon={<ThunderboltOutlined />}
              loading={quickCreatingQuant}
              onClick={handleEnsureQuantTask}
            >
              确保量化闭环任务
            </Button>
          </Space>
        </div>
        <div className="task-ops-hero__panel">
          <div className="task-ops-orbit">
            <span />
            <span />
            <span />
            <ThunderboltOutlined />
          </div>
          <div className="task-ops-hero__stamp">
            <Text type="secondary">最近健康扫描</Text>
            <strong>{health?.generated_at || '-'}</strong>
          </div>
        </div>
      </div>

      <Row gutter={[16, 16]} className="task-ops-metrics">
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card task-ops-metric" variant="borderless">
            <Statistic
              title="关键任务启用"
              value={taskStats.active}
              suffix={`/ ${tasks.length || 0}`}
              prefix={<ClockCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card task-ops-metric" variant="borderless">
            <Statistic
              title="严重问题"
              value={health?.summary.critical_issues || 0}
              prefix={<CloseCircleOutlined />}
              valueStyle={{
                color: (health?.summary.critical_issues || 0) > 0 ? '#d14343' : '#008f6b',
              }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card task-ops-metric" variant="borderless">
            <Statistic
              title="队列等待/延迟"
              value={health?.summary.queue_waiting || 0}
              prefix={<DatabaseOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card task-ops-metric" variant="borderless">
            <Statistic
              title="最近闭环交易/跳过"
              value={health?.summary.latest_loop_trade_action || '-'}
              prefix={<FireOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card
            className="modern-card task-ops-section"
            variant="borderless"
            title="自动化链路健康图"
            extra={<Tag color={healthColorMap[healthTone]}>{healthLabelMap[healthTone]}</Tag>}
            loading={healthLoading && !health}
          >
            <div className="automation-chain-grid">
              {(health?.chains || []).map(renderHealthChain)}
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card className="modern-card task-ops-section" variant="borderless" title="下一步建议">
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {(health?.next_actions || ['正在加载链路建议...']).map((item, index) => (
                  <div className="task-ops-action" key={index}>
                    <span>{index + 1}</span>
                    <Text>{item}</Text>
                  </div>
                ))}
              </Space>
            </Card>

            <Card
              className={`modern-card task-ops-section ops-health-card ops-health-card--${latestDeploymentTone}`}
              variant="borderless"
              title="运维健康"
              extra={
                <Button
                  size="small"
                  type="link"
                  loading={deploymentAuditLoading}
                  onClick={() => fetchDeploymentAudits()}
                >
                  刷新
                </Button>
              }
            >
              {latestDeploymentAudit ? (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <div className="ops-health-summary">
                    <div>
                      <Text type="secondary">最近部署验证</Text>
                      <strong>
                        {latestDeploymentAudit.event_type === 'deployment_smoke_failed'
                          ? '未通过'
                          : latestDeploymentAudit.event_type === 'deployment_smoke_skipped'
                            ? '已跳过'
                            : '已通过'}
                      </strong>
                    </div>
                    <Tag
                      color={
                        latestDeploymentAudit.event_type === 'deployment_smoke_failed'
                          ? 'red'
                          : latestDeploymentAudit.event_type === 'deployment_smoke_skipped'
                            ? 'gold'
                            : 'green'
                      }
                    >
                      {formatDateTime(latestDeploymentAudit.created_at)}
                    </Tag>
                  </div>

                  <div className="ops-health-counts">
                    <span>
                      <b>{latestDeploymentSummary.passed || 0}</b>
                      通过
                    </span>
                    <span>
                      <b>{latestDeploymentSummary.failed || 0}</b>
                      失败
                    </span>
                    <span>
                      <b>{latestDeploymentSummary.critical_failed || 0}</b>
                      关键失败
                    </span>
                  </div>

                  {latestLocalRegression && (
                    <div className="ops-local-regression">
                      <div>
                        <Text type="secondary">部署前本地回归</Text>
                        <strong>{latestLocalRegression.success ? '已通过' : '未通过'}</strong>
                      </div>
                      <Space wrap size={6}>
                        <Tag color={latestLocalRegression.success ? 'green' : 'red'}>
                          {latestLocalRegression.passed || 0}/{latestLocalRegression.total || 0}
                        </Tag>
                        {Number(latestLocalRegression.failed || 0) > 0 && (
                          <Tag color="red">失败 {latestLocalRegression.failed}</Tag>
                        )}
                      </Space>
                    </div>
                  )}

                  <Text type="secondary" ellipsis={{ tooltip: latestDeploymentSummary.base_url }}>
                    目标：{latestDeploymentSummary.base_url || '-'}
                  </Text>
                  {latestDeploymentSummary.deployment_id && (
                    <Text code copyable>
                      {latestDeploymentSummary.deployment_id}
                    </Text>
                  )}
                  {latestDeploymentSummary.skip_reason && (
                    <Tag color="gold">跳过原因：{latestDeploymentSummary.skip_reason}</Tag>
                  )}

                  {latestDeploymentFailures.length > 0 ? (
                    <div className="ops-health-failures">
                      <Text strong>需要优先看</Text>
                      {latestDeploymentFailures.slice(0, 3).map((item: any, index: number) => (
                        <div className="ops-health-failure-row" key={`${item.name}-${index}`}>
                          <Text ellipsis={{ tooltip: item.message }}>
                            {item.name || item.path || '未知检查点'}
                          </Text>
                          <Tag color={item.critical ? 'red' : 'orange'}>
                            {item.critical ? '关键' : '可选'}
                          </Tag>
                        </div>
                      ))}
                    </div>
                  ) : latestDeploymentAudit.event_type === 'deployment_smoke_skipped' ? (
                    <Alert
                      type="warning"
                      showIcon
                      className="ops-health-ok ops-health-skip"
                      message={
                        deploymentSkipStreak >= 2
                          ? `已连续 ${deploymentSkipStreak} 次跳过部署验证`
                          : '最近一次部署验证被跳过'
                      }
                      description="建议恢复只读冒烟测试，至少覆盖登录、任务健康、量化与模拟盘核心只读接口。"
                    />
                  ) : (
                    <Alert
                      type="success"
                      showIcon
                      className="ops-health-ok"
                      message="核心只读接口最近验证正常"
                    />
                  )}
                </Space>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={deploymentAuditLoading ? '正在读取部署验证...' : '暂无部署验证记录'}
                />
              )}
            </Card>

            <Card
              className="modern-card task-ops-section"
              variant="borderless"
              title="最近荐股闭环"
            >
              {latestLoop ? (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Descriptions column={1} size="small">
                    <Descriptions.Item label="运行ID">
                      <Text code copyable>
                        {latestLoop.loop_run_id || '-'}
                      </Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="时间">
                      {formatDateTime(latestLoop.generated_at)}
                    </Descriptions.Item>
                    <Descriptions.Item label="风格/评分">
                      {latestLoop.effective_style || '-'} / ≥{latestLoop.effective_min_score || '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="共识排序">
                      <Tag color={latestLoop.consensus?.ranked ? 'purple' : 'default'}>
                        {latestLoop.consensus?.ranked ? '已启用' : '未启用'} ·{' '}
                        {latestLoop.consensus?.overlap_count || 0} 个共识
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="模拟盘">
                      成交 {latestLoop.paper_trading?.executed || 0} / 计划{' '}
                      {latestLoop.paper_trading?.planned || 0} / 跳过{' '}
                      {latestLoop.paper_trading?.skipped || 0}
                    </Descriptions.Item>
                    <Descriptions.Item label="风险闸门">
                      {latestRiskGate ? (
                        <Space wrap>
                          <Tag color={latestRiskGate.applied ? 'volcano' : 'green'}>
                            {latestRiskGate.action === 'pause'
                              ? '暂停新增'
                              : latestRiskGate.action === 'reduce'
                                ? '自动降仓'
                                : '正常放行'}
                          </Tag>
                          <Text type="secondary">
                            {latestRiskGate.reason || '组合风险画像正常'}
                          </Text>
                        </Space>
                      ) : (
                        '-'
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item label="组合风险">
                      {latestRiskProfile?.status ? (
                        <Space wrap>
                          <Tag
                            color={
                              latestRiskProfile.status.level === 'danger'
                                ? 'red'
                                : latestRiskProfile.status.level === 'watch'
                                  ? 'gold'
                                  : 'green'
                            }
                          >
                            {latestRiskProfile.status.label}
                          </Tag>
                          <Text type="secondary">
                            现金 {formatPercent(latestRiskProfile.risk_metrics?.cash_pct)} / 仓位{' '}
                            {formatPercent(latestRiskProfile.risk_metrics?.exposure_pct)}
                          </Text>
                        </Space>
                      ) : (
                        '-'
                      )}
                    </Descriptions.Item>
                  </Descriptions>

                  {topSkipReasons.length > 0 && (
                    <div className="task-ops-skip-box">
                      <Text strong>主要阻断原因</Text>
                      {topSkipReasons.slice(0, 4).map((item: any, index: number) => (
                        <div className="task-ops-skip-row" key={`${item.reason}-${index}`}>
                          <Text ellipsis={{ tooltip: item.reason }}>{item.reason}</Text>
                          <Tag color="orange">×{item.count}</Tag>
                        </div>
                      ))}
                    </div>
                  )}

                  {riskLimitSuggestion && (
                    <Alert
                      className="risk-limit-suggestion-card"
                      type={
                        riskLimitCanApply
                          ? riskLimitSuggestion.action === 'tighten'
                            ? 'warning'
                            : 'success'
                          : 'info'
                      }
                      showIcon
                      message={
                        <Space wrap>
                          <span>风险阈值建议（手动确认）</span>
                          {riskLimitStability?.label && (
                            <Tag color={riskLimitCanApply ? 'green' : 'blue'}>
                              {riskLimitStability.label}
                            </Tag>
                          )}
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size={8}>
                          <Text>{riskLimitSuggestion.reason}</Text>
                          {riskLimitStability?.reason && (
                            <Text type={riskLimitCanApply ? 'success' : 'secondary'}>
                              {riskLimitStability.reason}
                            </Text>
                          )}
                          {riskLimitStability?.thresholds && (
                            <Text type="secondary">
                              门槛：连续同向≥
                              {riskLimitStability.thresholds.min_consecutive_same_action}{' '}
                              次，保护样本≥
                              {riskLimitStability.thresholds.min_protected_runs}，收紧差值≥
                              {formatPercent(
                                riskLimitStability.thresholds.tighten_min_protection_delta_pct
                              )}
                              ，放松差值≤
                              {formatPercent(
                                riskLimitStability.thresholds.relax_max_protection_delta_pct
                              )}
                            </Text>
                          )}
                          {riskLimitSuggestion.field_stability && (
                            <Text type="secondary">
                              字段级门槛：单个阈值也需连续同向≥
                              {riskLimitFieldStabilityFirst?.min_consecutive_same_action || 2}{' '}
                              次、样本≥{riskLimitFieldStabilityFirst?.min_sample_count || 3}、触发≥
                              {riskLimitFieldStabilityFirst?.min_triggered_count || 1}、置信度≥
                              {Number(riskLimitFieldStabilityFirst?.min_confidence ?? 0.45).toFixed(
                                2
                              )}
                              ，才会进入实际写入候选。
                            </Text>
                          )}
                          {riskFieldGateAdvice && (
                            <div className="risk-field-gate-advice">
                              <Text strong>字段门槛后验建议</Text>
                              <Text type="secondary">
                                {riskFieldGateAdvice.conclusion || '暂无明确字段级门槛调整信号。'}
                              </Text>
                              {riskFieldGateAdviceItems.length > 0 && (
                                <Space wrap size={[6, 6]}>
                                  {riskFieldGateAdviceItems.slice(0, 2).map((item: any) => (
                                    <Tag
                                      key={item.key}
                                      color={item.action === 'tighten' ? 'orange' : 'green'}
                                    >
                                      {item.label || riskLimitKeyLabels[item.key] || item.key}：
                                      {item.action === 'tighten' ? '建议更保守' : '可观察放松'}
                                    </Tag>
                                  ))}
                                </Space>
                              )}
                            </div>
                          )}
                          <Space wrap>
                            <Tag>
                              现金底线{' '}
                              {formatPercent(riskLimitSuggestion.limits?.min_cash_reserve_pct)}
                            </Tag>
                            <Tag>
                              总仓位≤
                              {formatPercent(riskLimitSuggestion.limits?.max_total_exposure_pct)}
                            </Tag>
                            <Tag>
                              行业≤
                              {formatPercent(riskLimitSuggestion.limits?.max_industry_exposure_pct)}
                            </Tag>
                            <Tag>
                              相关≤
                              {formatPercent(
                                Number(riskLimitSuggestion.limits?.max_position_correlation || 0) *
                                  100
                              )}
                            </Tag>
                            <Tag>
                              VaR≤{formatPercent(riskLimitSuggestion.limits?.max_portfolio_var_pct)}
                            </Tag>
                          </Space>
                          {riskLimitTargets.length > 0 && (
                            <Space direction="vertical" size={4} style={{ width: '100%' }}>
                              {riskLimitTargets.slice(0, 2).map((target: any) => (
                                <Text type="secondary" key={target.id || target.name}>
                                  {target.name}：建议更新{' '}
                                  {target.changed_keys?.join('、') || '无差异'}
                                </Text>
                              ))}
                            </Space>
                          )}
                          <Space wrap>
                            <Button
                              size="small"
                              icon={<EyeOutlined />}
                              loading={riskLimitApplying}
                              onClick={handlePreviewRiskLimitApply}
                              disabled={!riskLimitTargets.some((target: any) => target.changed)}
                              type={riskLimitCanApply ? 'primary' : 'default'}
                            >
                              {riskLimitCanApply ? '预览并应用' : '预览差异'}
                            </Button>
                            <Text type="secondary">
                              {riskLimitCanApply
                                ? '建议已连续同向，仍需二次确认后才会写入。'
                                : '低置信建议默认只观察；确认后也只更新风险阈值参数。'}
                            </Text>
                            <Button size="small" type="link" onClick={handleOpenStabilitySettings}>
                              调整稳定性门槛
                            </Button>
                          </Space>
                        </Space>
                      }
                    />
                  )}
                </Space>
              ) : (
                <Empty description="暂无闭环快照" />
              )}
            </Card>
          </Space>
        </Col>
      </Row>

      <Card className="modern-card task-ops-table" variant="borderless" title="任务编排清单">
        <Table
          columns={columns}
          dataSource={tasks}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: <Empty description="暂无定时任务，请点击右上角新建任务" /> }}
        />
      </Card>

      <Card
        className="modern-card task-audit-card"
        variant="borderless"
        title="参数变更审计"
        extra={
          <Space wrap>
            <Select
              size="small"
              value={auditFilter}
              style={{ width: 136 }}
              onChange={value => setAuditFilter(value)}
            >
              <Option value="watched">关键参数</Option>
              <Option value="deployment">部署验证</Option>
              <Option value="all">全部审计</Option>
            </Select>
            <Button size="small" type="link" loading={auditLoading} onClick={() => fetchAuditLogs()}>
              刷新审计
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          className="task-audit-hint"
          message={
            auditFilter === 'deployment'
              ? '这里用于追溯部署验证明细，结论优先看右侧「运维健康」卡片'
              : '这里用于追溯影响收益闭环的参数变化'
          }
          description={
            auditFilter === 'deployment'
              ? '仅当需要定位某次部署失败接口、部署 ID 或历史验证摘要时查看本区，避免和运维健康结论重复阅读。'
              : '风险阈值、稳定性门槛和任务参数改动都会留下改前/改后差异，方便后续回看某次调参是否提升了荐股收益。'
          }
        />
        {latestShadowBudgetSuggestion && (
          <Alert
            className="task-shadow-budget-advice"
            type="info"
            showIcon
            message="影子执行预算有候选补丁"
            description={
              <Space direction="vertical" size={4}>
                <Text>
                  {latestShadowBudgetSuggestion.metadata?.outcome_summary?.budget_label ||
                    latestShadowBudgetSuggestion.after_parameters?.shadow_budget_advice?.label ||
                    '影子预算建议'}
                  ：limit {latestShadowBudgetSuggestion.before_parameters?.limit ?? '-'} →{' '}
                  {latestShadowBudgetSuggestion.after_parameters?.limit ?? '-'}。
                  该补丁只影响影子执行频次，不会触发真实下单。
                </Text>
                <Text type="secondary">
                  {latestShadowBudgetSuggestion.metadata?.outcome_summary?.budget_reason ||
                    latestShadowBudgetSuggestion.after_parameters?.shadow_budget_advice?.reason ||
                    '建议先预览差异，再手动应用。'}
                </Text>
              </Space>
            }
            action={
              <Button
                size="small"
                type="primary"
                ghost
                loading={shadowBudgetApplying}
                onClick={() => handlePreviewShadowBudgetApply(latestShadowBudgetSuggestion)}
              >
                预览应用
              </Button>
            }
          />
        )}
        {auditLogs.length ? (
          <>
            <div className="task-audit-list">{visibleAuditLogs.map(renderAuditLog)}</div>
            {auditLogs.length > visibleAuditLogs.length && (
              <div className="task-audit-more">
                <Text type="secondary">
                  已收起 {auditLogs.length - visibleAuditLogs.length} 条历史记录
                </Text>
                <Button size="small" type="link" onClick={() => setAuditExpanded(true)}>
                  展开全部
                </Button>
              </div>
            )}
            {auditExpanded && auditLogs.length > 4 && (
              <div className="task-audit-more">
                <Text type="secondary">当前显示 {auditLogs.length} 条记录</Text>
                <Button size="small" type="link" onClick={() => setAuditExpanded(false)}>
                  收起历史
                </Button>
              </div>
            )}
          </>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={auditLoading ? '正在加载审计记录...' : '暂无关键参数变更记录'}
          />
        )}
      </Card>

      <Modal
        title={editingTask ? '编辑定时任务' : '新建定时任务'}
        open={isModalVisible}
        onOk={handleModalOk}
        onCancel={() => setIsModalVisible(false)}
        width={640}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            is_active: true,
            parameters:
              '{\n  "universe": "favorites",\n  "style": "balanced",\n  "candidate_limit": 10,\n  "lookback_days": 120\n}',
          }}
        >
          <Form.Item
            name="name"
            label="任务名称"
            rules={[{ required: true, message: '请输入任务名称' }]}
          >
            <Input placeholder="如：每日全量股票数据同步" />
          </Form.Item>

          <Form.Item
            name="type"
            label="任务类型"
            rules={[{ required: true, message: '请选择任务类型' }]}
          >
            <Select
              placeholder="选择要执行的任务类型"
              onChange={(type: string) => {
                if (defaultParametersByType[type]) {
                  form.setFieldValue(
                    'parameters',
                    JSON.stringify(defaultParametersByType[type], null, 2)
                  );
                }
              }}
            >
              <Option value="DAILY_UPDATE">每日行情增量同步</Option>
              <Option value="SYNC_ALL_STOCKS">全市场股票列表同步</Option>
              <Option value="SYNC_HISTORY">股票历史行情同步</Option>
              <Option value="DATA_QUALITY_SCAN">数据质量扫描</Option>
              <Option value="BENCHMARK_INDEX_SYNC">基准指数行情同步</Option>
              <Option value="QUANT_DAILY_PIPELINE">量化策略全市场扫描</Option>
              <Option value="AI_DAILY_SCREENER">AI 每日优选评估</Option>
              <Option value="AUTO_RECOMMENDATION_LOOP">全市场荐股闭环</Option>
              <Option value="SIGNAL_PERFORMANCE_REFRESH">推荐绩效后验刷新</Option>
              <Option value="SIGNAL_QUALITY_DAILY_REPORT">信号质量日报</Option>
              <Option value="PAPER_TRADING_AUTO_SYNC">推荐信号模拟盘跟单</Option>
              <Option value="PAPER_TRADING_RISK_CHECK">模拟盘风控退出检查</Option>
              <Option value="PAPER_TRADING_ATTRIBUTION_REPORT">模拟盘收益归因报告</Option>
              <Option value="RECOMMENDATION_TRADE_OUTCOME_REFRESH">推荐交易收益闭环刷新</Option>
              <Option value="PAPER_TRADING_DAILY_PLAN">模拟盘交易计划报告</Option>
            </Select>
          </Form.Item>

          <Form.Item
            name="cron_expression"
            label={
              <Space>
                Cron 表达式
                <Tooltip title="分 时 日 月 周。例如每天凌晨1点: 0 1 * * *">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            rules={[{ required: true, message: '请输入 Cron 表达式' }]}
          >
            <Input placeholder="如：0 1 * * * (每天凌晨1点)" />
          </Form.Item>

          <Form.Item name="parameters" label="任务参数 (JSON 格式)">
            <Input.TextArea
              rows={8}
              onFocus={() => {
                const type = form.getFieldValue('type');
                const current = form.getFieldValue('parameters');
                if (!current && defaultParametersByType[type]) {
                  form.setFieldValue(
                    'parameters',
                    JSON.stringify(defaultParametersByType[type], null, 2)
                  );
                }
              }}
              placeholder={
                '{\n  "syncAllStocks": true,\n  "lookback_days": 10,\n  "dataSource": "auto",\n  "concurrency": 2\n}'
              }
            />
          </Form.Item>

          <Form.Item name="is_active" label="启用状态" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="审计记录详情"
        open={Boolean(auditDetail)}
        onCancel={() => setAuditDetail(null)}
        footer={[
          <Button key="close" onClick={() => setAuditDetail(null)}>
            关闭
          </Button>,
        ]}
        width={820}
      >
        {auditDetail && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap>
              <Tag color={auditEventColors[auditDetail.event_type] || 'default'}>
                {auditEventLabels[auditDetail.event_type] || auditDetail.event_type}
              </Tag>
              <Text strong>{auditDetail.task_name}</Text>
              <Text type="secondary">{formatDateTime(auditDetail.created_at)}</Text>
            </Space>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="任务类型">{auditDetail.task_type}</Descriptions.Item>
              <Descriptions.Item label="操作者">
                {auditDetail.operator_username || auditDetail.operator_user_id || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="来源闭环">
                {auditDetail.source_loop_run_id || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="变更字段">
                {(auditDetail.changed_keys || []).join('、') || '-'}
              </Descriptions.Item>
            </Descriptions>
            <DeploymentAuditSummary audit={auditDetail} />
            <ParameterAuditSummary
              audit={auditDetail}
              riskLimitKeyLabels={riskLimitKeyLabels}
              formatRiskLimitValue={formatRiskLimitValue}
            />
            <div>
              <Title level={5} style={{ marginBottom: 8 }}>
                完整审计 JSON
              </Title>
              <pre className="task-ops-codeblock">{stringifyJson(auditDetail)}</pre>
            </div>
          </Space>
        )}
      </Modal>

      <Modal
        title={`[${activeTaskName}] - 历史执行记录`}
        open={isLogModalVisible}
        onCancel={() => setIsLogModalVisible(false)}
        footer={null}
        width={1180}
      >
        <Table
          dataSource={currentLogs}
          rowKey="id"
          loading={logLoading}
          pagination={{ pageSize: 10 }}
          size="small"
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: '状态',
              dataIndex: 'status',
              key: 'status',
              render: (status: string) => {
                const color =
                  status === 'COMPLETED' ? 'green' : status === 'FAILED' ? 'red' : 'blue';
                return <Tag color={color}>{status}</Tag>;
              },
            },
            {
              title: '开始时间',
              dataIndex: 'started_at',
              key: 'started_at',
              render: (text: string) => dayjs(text).format('MM-DD HH:mm:ss'),
            },
            {
              title: '结束时间',
              dataIndex: 'completed_at',
              key: 'completed_at',
              render: (text: string) => (text ? dayjs(text).format('MM-DD HH:mm:ss') : '-'),
            },
            {
              title: '进度 (完成/失败/总计)',
              key: 'progress',
              render: (_: any, record: TaskExecutionLog) => (
                <Text>
                  {record.completed_items} / <Text type="danger">{record.failed_items}</Text> /{' '}
                  {record.total_items}
                </Text>
              ),
            },
            {
              title: '执行结论',
              key: 'result_summary',
              width: 280,
              render: (_: any, record: TaskExecutionLog) => {
                const summary = record.result_summary || {};
                const runtimeHealth = summary.runtime_health || null;
                if (!summary.scenario && !runtimeHealth) {
                  return <Text type="secondary">暂无摘要</Text>;
                }

                return (
                  <Space direction="vertical" size={4} style={{ maxWidth: 270 }}>
                    <Space wrap size={4}>
                      {summary.runtime_risk_blocked ? (
                        <Tag color="red">风险阻断买入</Tag>
                      ) : summary.scenario === 'quant_daily_pipeline' ? (
                        <Tag color="blue">量化闭环</Tag>
                      ) : summary.scenario === 'quant_param_maintenance' ? (
                        <Tag color="purple">参数后验</Tag>
                      ) : summary.scenario === 'realtime_quote_sync' ? (
                        <Tag color="cyan">行情快照</Tag>
                      ) : null}
                      {summary.lifecycle_applied !== undefined && (
                        <Tag
                          color={Number(summary.lifecycle_applied || 0) > 0 ? 'green' : 'default'}
                        >
                          生命周期 {summary.lifecycle_applied}
                        </Tag>
                      )}
                      {summary.completed_validations !== undefined && (
                        <Tag>完成验证 {summary.completed_validations}</Tag>
                      )}
                      {summary.persisted_count !== undefined && (
                        <Tag>行情 {summary.persisted_count}</Tag>
                      )}
                      {runtimeHealth?.status && (
                        <Tag color={getRuntimeHealthTagColor(runtimeHealth.status)}>
                          健康 {runtimeHealth.status}
                          {runtimeHealth.score !== undefined ? `/${runtimeHealth.score}` : ''}
                        </Tag>
                      )}
                      {runtimeHealth?.factor_min_coverage_rate !== undefined && (
                        <Tag>因子 {runtimeHealth.factor_min_coverage_rate}%</Tag>
                      )}
                    </Space>
                    <Text
                      type={summary.runtime_risk_blocked ? 'danger' : 'secondary'}
                      ellipsis={{
                        tooltip:
                          summary.runtime_block_reason ||
                          runtimeHealth?.conclusion ||
                          summary.message,
                      }}
                      style={{ maxWidth: 260 }}
                    >
                      {summary.runtime_block_reason ||
                        runtimeHealth?.conclusion ||
                        summary.message ||
                        '执行完成'}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {summary.scenario === 'quant_param_maintenance'
                        ? `新增 ${summary.created_validations ?? 0} · 完成 ${
                            summary.completed_validations ?? 0
                          } · 待完成 ${summary.pending_validations ?? 0}`
                        : summary.scenario === 'realtime_quote_sync'
                          ? `请求 ${summary.requested_count ?? '-'} · 落盘 ${
                              summary.persisted_count ?? 0
                            } · 覆盖 ${summary.latest_trade_date_symbol_count ?? 0}`
                          : `归档 ${summary.archived_signal_count ?? '-'} · Agent ${
                              summary.agent_submitted ?? 0
                            } · 模拟买入 ${summary.paper_executed ?? summary.paper_planned ?? 0}`}
                    </Text>
                  </Space>
                );
              },
            },
            {
              title: '队列任务',
              key: 'queue_jobs',
              width: 260,
              render: (_: any, record: TaskExecutionLog) => {
                const jobs = record.queue_jobs || [];
                if (!jobs.length) {
                  return record.queue_error ? (
                    <Text type="warning" ellipsis={{ tooltip: record.queue_error }}>
                      队列详情暂不可用
                    </Text>
                  ) : (
                    <Text type="secondary">暂无关联</Text>
                  );
                }

                return (
                  <Space direction="vertical" size={6}>
                    {jobs.map(job => (
                      <Space key={`${job.queue_name}-${job.id}`} size={6} wrap>
                        <Tag
                          color={getQueueStateColor(job.state)}
                          icon={<DatabaseOutlined />}
                          style={{ marginRight: 0 }}
                        >
                          {job.queue_name} · {queueStateLabels[job.state] || job.state}
                        </Tag>
                        <Button
                          type="link"
                          size="small"
                          icon={<EyeOutlined />}
                          onClick={() => {
                            setQueueDetail(job);
                            setIsQueueDetailVisible(true);
                          }}
                          style={{ paddingInline: 0 }}
                        >
                          详情
                        </Button>
                      </Space>
                    ))}
                  </Space>
                );
              },
            },
            {
              title: '异常信息',
              dataIndex: 'error_message',
              key: 'error_message',
              render: (text: string) =>
                text ? (
                  <Text type="danger" ellipsis={{ tooltip: text }} style={{ maxWidth: 200 }}>
                    {text}
                  </Text>
                ) : (
                  '-'
                ),
            },
          ]}
        />
      </Modal>

      <Modal
        title={
          <Space>
            <DatabaseOutlined />
            队列任务详情
          </Space>
        }
        open={isQueueDetailVisible}
        onCancel={() => setIsQueueDetailVisible(false)}
        footer={null}
        width={780}
      >
        {queueDetail && (
          <div className="queue-detail-panel">
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Space wrap>
                <Tag color="geekblue">{queueDetail.queue_name}</Tag>
                <Tag color={getQueueStateColor(queueDetail.state)}>
                  {queueStateLabels[queueDetail.state] || queueDetail.state}
                </Tag>
                <Text code copyable>
                  {String(queueDetail.id)}
                </Text>
              </Space>

              <Descriptions bordered size="small" column={1}>
                <Descriptions.Item label="任务名称">{queueDetail.name || '-'}</Descriptions.Item>
                <Descriptions.Item label="状态">
                  <Tag color={getQueueStateColor(queueDetail.state)}>
                    {queueStateLabels[queueDetail.state] || queueDetail.state}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="进度">
                  {formatQueueProgress(queueDetail.progress)}
                </Descriptions.Item>
                <Descriptions.Item label="尝试次数">
                  {queueDetail.attempts_made ?? '-'}
                </Descriptions.Item>
                <Descriptions.Item label="创建时间">
                  {formatQueueTime(queueDetail.timestamp)}
                </Descriptions.Item>
                <Descriptions.Item label="开始处理">
                  {formatQueueTime(queueDetail.processed_on)}
                </Descriptions.Item>
                <Descriptions.Item label="结束时间">
                  {formatQueueTime(queueDetail.finished_on)}
                </Descriptions.Item>
                <Descriptions.Item label="失败原因">
                  {queueDetail.failed_reason || '-'}
                </Descriptions.Item>
              </Descriptions>

              <Divider style={{ margin: '4px 0' }} />

              <div>
                <Title level={5} style={{ marginBottom: 8 }}>
                  投递数据
                </Title>
                <pre className="task-ops-codeblock">{stringifyJson(queueDetail.data)}</pre>
              </div>

              {queueDetail.return_value !== undefined && queueDetail.return_value !== null && (
                <div>
                  <Title level={5} style={{ marginBottom: 8 }}>
                    执行返回
                  </Title>
                  <pre className="task-ops-codeblock task-ops-codeblock--green">
                    {stringifyJson(queueDetail.return_value)}
                  </pre>
                </div>
              )}
            </Space>
          </div>
        )}
      </Modal>

      <RiskLimitPreviewModal
        open={isRiskLimitModalVisible}
        loading={riskLimitApplying}
        preview={riskLimitPreview}
        riskFieldGateAdvice={riskFieldGateAdvice}
        riskFieldGateAdjustmentAttribution={riskFieldGateAdjustmentAttribution}
        riskFieldGateSuggestedParams={riskFieldGateSuggestedParams}
        riskLimitKeyLabels={riskLimitKeyLabels}
        riskLimitKeyPriority={riskLimitKeyPriority}
        onCancel={() => setIsRiskLimitModalVisible(false)}
        onPreview={handlePreviewRiskLimitApply}
        onApply={handleConfirmRiskLimitApply}
        formatPercent={formatPercent}
        formatRiskLimitValue={formatRiskLimitValue}
        getRiskFieldEvidenceScore={getRiskFieldEvidenceScore}
      />

      <Modal
        title={
          <Space>
            <SafetyCertificateOutlined />
            影子预算建议预览
          </Space>
        }
        open={isShadowBudgetModalVisible}
        onCancel={() => {
          setIsShadowBudgetModalVisible(false);
          setShadowBudgetPreview(null);
        }}
        width={760}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setIsShadowBudgetModalVisible(false);
              setShadowBudgetPreview(null);
            }}
          >
            先不应用
          </Button>,
          <Button
            key="refresh"
            loading={shadowBudgetApplying}
            onClick={() =>
              handlePreviewShadowBudgetApply(
                shadowBudgetPreview
                  ? ({
                      id: shadowBudgetPreview.audit_id,
                    } as TaskParameterAuditLog)
                  : undefined
              )
            }
          >
            重新预览
          </Button>,
          <Button
            key="apply"
            type="primary"
            loading={shadowBudgetApplying}
            disabled={!shadowBudgetPreview?.changed_keys?.length}
            onClick={handleConfirmShadowBudgetApply}
          >
            应用到影子任务
          </Button>,
        ]}
      >
        {shadowBudgetPreview ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type="success"
              showIcon
              className="task-shadow-budget-modal__guard"
              message="安全边界：只调整影子执行预算"
              description="该操作仅更新 LIVE_SHADOW_AUTOPILOT 的 limit 与影子预算说明，不会立即执行任务，不会创建真实券商委托，也不会改动历史交易记录。"
            />

            <div className="task-shadow-budget-modal__hero">
              <div>
                <Text type="secondary">目标任务</Text>
                <Title level={5} style={{ margin: '4px 0 0' }}>
                  {shadowBudgetPreview.target_task_name || 'LIVE_SHADOW_AUTOPILOT'}
                </Title>
                <Text type="secondary">审计 #{shadowBudgetPreview.audit_id}</Text>
              </div>
              <div className="task-shadow-budget-modal__limit">
                <span>{shadowBudgetPreview.current_limit ?? '-'}</span>
                <b>→</b>
                <span>{shadowBudgetPreview.suggested_limit ?? '-'}</span>
              </div>
            </div>

            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="目标任务 ID">
                {shadowBudgetPreview.target_task_id}
              </Descriptions.Item>
              <Descriptions.Item label="变更字段">
                {(shadowBudgetPreview.changed_keys || []).length ? (
                  <Space wrap size={[6, 6]}>
                    {shadowBudgetPreview.changed_keys.map(key => (
                      <Tag color={key === 'limit' ? 'blue' : 'cyan'} key={key}>
                        {key}
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  <Text type="secondary">当前参数已与建议一致，无需更新</Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="应用后说明">
                {shadowBudgetPreview.suggested_parameters?.shadow_budget_advice?.label ||
                  shadowBudgetPreview.suggested_parameters?.shadow_budget_advice?.action ||
                  '-'}
                {shadowBudgetPreview.suggested_parameters?.shadow_budget_advice?.reason ? (
                  <Text type="secondary">
                    {' '}
                    · {shadowBudgetPreview.suggested_parameters.shadow_budget_advice.reason}
                  </Text>
                ) : null}
              </Descriptions.Item>
              <Descriptions.Item label="预览结论">
                {shadowBudgetPreview.message || '-'}
              </Descriptions.Item>
            </Descriptions>

            <div>
              <Title level={5} style={{ marginBottom: 8 }}>
                建议参数快照
              </Title>
              <pre className="task-ops-codeblock task-shadow-budget-modal__json">
                {stringifyJson({
                  limit: shadowBudgetPreview.suggested_parameters?.limit,
                  shadow_budget_advice:
                    shadowBudgetPreview.suggested_parameters?.shadow_budget_advice,
                })}
              </pre>
            </div>
          </Space>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={shadowBudgetApplying ? '正在生成影子预算预览...' : '暂无预览内容'}
          />
        )}
      </Modal>

      <Modal
        title={
          <Space>
            <SafetyCertificateOutlined />
            稳定性门槛安全编辑
          </Space>
        }
        open={isStabilityModalVisible}
        onCancel={() => setIsStabilityModalVisible(false)}
        footer={[
          <Button key="cancel" onClick={() => setIsStabilityModalVisible(false)}>
            取消
          </Button>,
          <Button
            key="reset"
            onClick={() => stabilityForm.setFieldsValue(defaultRiskStabilitySettings)}
          >
            恢复默认保守门槛
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={stabilitySaving}
            onClick={handleSaveStabilitySettings}
          >
            保存到关键任务
          </Button>,
        ]}
        width={720}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16, borderRadius: 14 }}
          message="只更新稳定性判定参数"
          description="这些参数只决定何时把阈值建议标记为“稳定可应用”，不会立即买卖股票，也不会直接改风险阈值。"
        />
        {riskFieldGateAdvice && (
          <div className="risk-field-gate-modal-advice">
            <Text strong>收益后验参考，不自动覆盖</Text>
            <Text type="secondary">
              {riskFieldGateAdvice.conclusion || '暂无明确字段级门槛调整信号。'}
            </Text>
            {riskFieldGateAdviceItems.length > 0 && (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {riskFieldGateAdviceItems.slice(0, 3).map((item: any) => (
                  <div className="risk-field-gate-modal-advice__item" key={item.key}>
                    <span>{item.label || riskLimitKeyLabels[item.key] || item.key}</span>
                    <Text type="secondary" ellipsis={{ tooltip: item.reason }}>
                      {item.reason}
                    </Text>
                  </div>
                ))}
              </Space>
            )}
            {Object.keys(riskFieldGateSuggestedParams).length > 0 && (
              <div className="risk-field-gate-modal-advice__suggestions">
                <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Text strong>建议值对比</Text>
                  <Button size="small" type="link" onClick={handleFillFieldGateSuggestedValues}>
                    填入建议值（不保存）
                  </Button>
                </Space>
                {Object.entries(riskFieldGateSuggestedParams).map(([key, value]) => (
                  <Text type="secondary" key={key}>
                    {riskLimitKeyLabels[key] || key}：
                    {formatRiskLimitValue(key, riskFieldGateAdvice.current_parameters?.[key])} →{' '}
                    {formatRiskLimitValue(key, value)}
                  </Text>
                ))}
              </div>
            )}
          </div>
        )}
        <Form form={stabilityForm} layout="vertical" className="risk-stability-form">
          <Row gutter={14}>
            <Col xs={24} sm={12}>
              <Form.Item
                name="min_consecutive_same_action"
                label="连续同向建议"
                rules={[{ required: true, message: '请输入连续次数' }]}
              >
                <InputNumber min={1} max={10} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="min_actionable_samples"
                label="可执行建议样本"
                rules={[{ required: true, message: '请输入样本数' }]}
              >
                <InputNumber min={1} max={20} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="min_protected_runs"
                label="最少保护触发"
                rules={[{ required: true, message: '请输入保护触发次数' }]}
              >
                <InputNumber min={1} max={30} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="tighten_min_delta_pct"
                label="收紧所需保护差值"
                rules={[{ required: true, message: '请输入收紧差值' }]}
              >
                <InputNumber
                  min={0}
                  max={10}
                  step={0.1}
                  style={{ width: '100%' }}
                  addonAfter="pct"
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="relax_max_delta_pct"
                label="放松允许保护差值"
                rules={[{ required: true, message: '请输入放松差值' }]}
              >
                <InputNumber
                  min={-10}
                  max={0}
                  step={0.1}
                  style={{ width: '100%' }}
                  addonAfter="pct"
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="field_min_consecutive_same_action"
                label="字段连续同向"
                rules={[{ required: true, message: '请输入字段连续次数' }]}
              >
                <InputNumber min={1} max={10} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="field_min_confidence"
                label="字段最小置信度"
                rules={[{ required: true, message: '请输入字段置信度门槛' }]}
              >
                <InputNumber min={0.1} max={0.95} step={0.05} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="field_min_sample_count"
                label="字段最小样本"
                rules={[{ required: true, message: '请输入字段样本门槛' }]}
              >
                <InputNumber min={1} max={50} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="field_min_triggered_count"
                label="字段最小触发"
                rules={[{ required: true, message: '请输入字段触发门槛' }]}
              >
                <InputNumber min={1} max={50} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
};

export default TaskScheduler;
