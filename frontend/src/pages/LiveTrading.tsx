import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AuditOutlined,
  BranchesOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LockOutlined,
  ReconciliationOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  WalletOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import api from '../services/api';

const { Text } = Typography;
const CONFIRM_TEXT = 'CONFIRM_LIVE_ORDER';

interface LiveReadiness {
  safety: {
    mode: string;
    can_submit_orders: boolean;
    can_sync_account: boolean;
    shadow_autopilot_enabled: boolean;
    unattended_real_order_allowed: boolean;
    global_kill_switch: boolean;
    broker_gateway: string;
    market_data_provider: string;
    confirm_text_required: string;
    blockers: string[];
    warnings: string[];
    default_risk_limits: Record<string, any>;
    unattended_policy?: {
      real_order_submission: string;
      shadow_execution: string;
      conclusion: string;
    };
  };
  broker: {
    broker_key: string;
    broker_name: string;
    readonly_supported: boolean;
    trading_supported: boolean;
    notes: string[];
  };
  market_data: {
    provider_key: string;
    provider_name: string;
    licensed_for_external_use: boolean;
    notes: string[];
  };
  market_data_health: {
    status: string;
    status_label: string;
    sample_count: number;
    missing_count: number;
    stale_count: number;
    missing_ratio_pct: number;
    max_latency_seconds: number;
    licensed_for_external_use: boolean;
    conclusion: string;
    warnings: string[];
    items: Array<{
      symbol: string;
      name?: string;
      current_price?: number;
      status: string;
      latency_seconds?: number;
      source?: string;
    }>;
  };
  market_data_provider_comparison?: {
    active_provider_key: string;
    conclusion: string;
    providers: Array<{
      provider: {
        provider_key: string;
        provider_name: string;
        licensed_for_external_use: boolean;
      };
      status: string;
      status_label: string;
      sample_count: number;
      missing_count: number;
      stale_count: number;
      missing_ratio_pct: number;
      max_latency_seconds: number;
      conclusion: string;
    }>;
  };
  phases: Array<{ key: string; label: string; status: string; detail: string }>;
  conclusion: string;
}

interface LiveOverview {
  generated_at: string;
  readiness: LiveReadiness;
  account?: any;
  latest_snapshot?: any;
  positions: any[];
  order_drafts: any[];
  shadow_autopilot?: {
    enabled: boolean;
    drafts: any[];
    summary: {
      total_count: number;
      shadow_executed_count: number;
      total_shadow_amount: number;
      latest_at?: string | null;
      real_order_submitted: number;
      conclusion: string;
    };
  };
  reconciliation?: LiveReconciliation;
  summary: {
    account_bound: boolean;
    total_asset: number;
    available_cash: number;
    market_value: number;
    exposure_pct: number;
    position_count: number;
    pending_draft_count: number;
    can_submit_orders: boolean;
    market_data_status: string;
    market_data_conclusion: string;
    mode_label: string;
    conclusion: string;
  };
}

interface LiveReconciliation {
  status: string;
  status_label: string;
  snapshot_age_minutes?: number | null;
  stale_threshold_minutes?: number;
  paper_accounts: any[];
  position_matches: any[];
  suggestions: Array<{ level: string; title: string; detail: string }>;
  summary: {
    live_total_asset: number;
    live_available_cash: number;
    live_market_value: number;
    live_position_count: number;
    paper_total_value: number;
    paper_market_value: number;
    paper_position_count: number;
    overlap_count: number;
    live_only_count: number;
    paper_only_count: number;
    average_weight_gap_pct: number;
    alignment_score: number;
    conclusion: string;
  };
}

interface LiveDraftCandidateDashboard {
  generated_at: string;
  account_ready: boolean;
  candidates: any[];
  summary: {
    total_count: number;
    eligible_count: number;
    duplicate_count: number;
    blocked_count: number;
    conclusion: string;
  };
}

interface ShadowOutcomeDashboard {
  generated_at: string;
  horizons: number[];
  items: any[];
  summary: {
    shadow_trade_count: number;
    evaluated_count: number;
    open_count: number;
    win_count: number;
    loss_count: number;
    win_rate_pct?: number | null;
    avg_latest_return_pct?: number | null;
    total_shadow_amount: number;
    total_latest_pnl: number;
    real_order_submitted: number;
    baseline?: {
      since?: string;
      paper_trading?: {
        sample_count: number;
        evaluated_count: number;
        avg_latest_return_pct?: number | null;
        win_rate_pct?: number | null;
        total_pnl?: number | null;
      };
      signal_forward_returns?: {
        sample_count: number;
        avg_return_pct?: number | null;
        win_rate_pct?: number | null;
      };
    };
    budget_decision?: {
      action: string;
      label: string;
      level: string;
      recommended_limit: number;
      reason: string;
    };
    horizon_summary: Array<{
      horizon_days: number;
      evaluated_count: number;
      avg_return_pct?: number | null;
      win_rate_pct?: number | null;
    }>;
    conclusion: string;
  };
}

interface ShadowTrendDashboard {
  generated_at: string;
  points: Array<{
    log_id: number;
    task_name: string;
    scenario: string;
    completed_at: string;
    date: string;
    avg_return_pct?: number | null;
    win_rate_pct?: number | null;
    total_pnl?: number | null;
    evaluated_count: number;
    shadow_trade_count: number;
    recommended_limit?: number | null;
    budget_label?: string;
    real_order_submitted: number;
  }>;
  summary: {
    point_count: number;
    latest_avg_return_pct?: number | null;
    latest_win_rate_pct?: number | null;
    latest_recommended_limit?: number | null;
    latest_budget_label?: string;
    real_order_submitted: number;
    conclusion: string;
  };
}

interface ShadowBudgetAttributionDashboard {
  generated_at: string;
  lookback_days: number;
  window_days: number;
  real_order_submitted: number;
  periods: Array<{
    audit_id: number;
    task_name: string;
    generated_at: string;
    applied: boolean;
    applied_audit_id?: number | null;
    applied_at?: string | null;
    before_limit?: number | null;
    suggested_limit?: number | null;
    budget_action?: string;
    budget_label?: string;
    budget_reason?: string;
    pre_window: {
      sample_count: number;
      evaluated_count: number;
      win_rate_pct?: number | null;
      avg_latest_return_pct?: number | null;
      total_latest_pnl: number;
    };
    post_window: {
      sample_count: number;
      evaluated_count: number;
      win_rate_pct?: number | null;
      avg_latest_return_pct?: number | null;
      total_latest_pnl: number;
    };
    delta: {
      avg_latest_return_pct?: number | null;
      win_rate_pct?: number | null;
      evaluated_count: number;
      total_latest_pnl: number;
    };
    decision: {
      action: string;
      label: string;
      level: string;
      reason: string;
    };
  }>;
  summary: {
    suggestion_count: number;
    applied_count: number;
    pending_count: number;
    effective_count: number;
    ineffective_count: number;
    latest_action: string;
    latest_label: string;
    latest_level: string;
    latest_suggested_limit?: number | null;
    latest_delta_avg_return_pct?: number | null;
    latest_delta_win_rate_pct?: number | null;
    total_shadow_sample_count: number;
    total_evaluated_count: number;
    conclusion: string;
  };
}

const formatMoney = (value?: number | null) =>
  `¥${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
const formatPct = (value?: number | null, digits = 2) =>
  value === null || value === undefined || Number.isNaN(Number(value))
    ? '--'
    : `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(digits)}%`;
const formatDateTime = (value?: string | null) => (value ? new Date(value).toLocaleString() : '--');
const pnlTextType = (value?: number | null) =>
  Number(value || 0) > 0 ? 'success' : Number(value || 0) < 0 ? 'danger' : 'secondary';
const statusColor: Record<string, string> = {
  ready: 'green',
  partial: 'gold',
  locked: 'default',
  blocked: 'red',
  restricted: 'orange',
};
const draftStatusColor: Record<string, string> = {
  pending: 'gold',
  preview: 'blue',
  blocked: 'red',
  approved: 'green',
  rejected: 'default',
  submitted: 'purple',
};
const marketHealthColor: Record<string, string> = {
  ok: 'green',
  degraded: 'gold',
  risk: 'red',
  empty: 'default',
};
const reconciliationColor: Record<string, string> = {
  aligned: 'green',
  diverged: 'gold',
  high_divergence: 'red',
  stale: 'orange',
  no_snapshot: 'default',
  not_bound: 'default',
};
const matchColor: Record<string, string> = {
  aligned: 'green',
  live_only: 'red',
  paper_only: 'blue',
  live_overweight: 'orange',
  live_underweight: 'gold',
};
const shadowOutcomeColor: Record<string, string> = {
  evaluated: 'green',
  open: 'blue',
  waiting_market_data: 'gold',
  missing_entry_price: 'red',
};
const shadowBudgetColor: Record<string, string> = {
  ok: 'green',
  watch: 'gold',
  risk: 'red',
};

const LiveTrading: React.FC = () => {
  const [overview, setOverview] = useState<LiveOverview | null>(null);
  const [draftCandidates, setDraftCandidates] = useState<LiveDraftCandidateDashboard | null>(null);
  const [shadowOutcomes, setShadowOutcomes] = useState<ShadowOutcomeDashboard | null>(null);
  const [shadowTrend, setShadowTrend] = useState<ShadowTrendDashboard | null>(null);
  const [shadowBudgetAttribution, setShadowBudgetAttribution] =
    useState<ShadowBudgetAttributionDashboard | null>(null);
  const [shadowBudgetAudit, setShadowBudgetAudit] = useState<{
    suggestion?: any;
    applied?: any;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [shadowLoading, setShadowLoading] = useState(false);
  const [shadowOutcomeLoading, setShadowOutcomeLoading] = useState(false);
  const [shadowTrendLoading, setShadowTrendLoading] = useState(false);
  const [shadowBudgetAttributionLoading, setShadowBudgetAttributionLoading] = useState(false);
  const [shadowBudgetAuditLoading, setShadowBudgetAuditLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [isDraftModalOpen, setIsDraftModalOpen] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState<any>(null);
  const [confirmText, setConfirmText] = useState('');
  const [draftForm] = Form.useForm();
  // 账户角色切换（main / grayscale），URL 不重写，仅前端 query 透传
  const [accountRole, setAccountRole] = useState<'main' | 'grayscale'>('main');
  // 服务端 kill switch 状态（DB 层），与 overview.safety.global_kill_switch 是 OR 关系
  const [killSwitch, setKillSwitch] = useState<{ active: boolean; state: any } | null>(null);
  // 当前账户的活跃实盘委托（用于撤单 UI）
  const [liveOrders, setLiveOrders] = useState<any[]>([]);
  const [liveOrdersLoading, setLiveOrdersLoading] = useState(false);

  const fetchKillSwitch = async () => {
    try {
      const resp = await api.get('/live-trading/kill-switch');
      setKillSwitch(resp.data.data || null);
    } catch (e: any) {
      // 非阻塞：失败不要影响主面板
    }
  };

  const fetchLiveOrders = async () => {
    setLiveOrdersLoading(true);
    try {
      const resp = await api.get('/live-trading/orders', {
        params: { account_role: accountRole, active_only: true },
      });
      setLiveOrders(resp.data.data?.orders || []);
    } catch (e: any) {
      // 非阻塞
    } finally {
      setLiveOrdersLoading(false);
    }
  };

  const fetchOverview = async (silent = false) => {
    setLoading(true);
    try {
      const response = await api.get('/live-trading/overview', {
        params: { account_role: accountRole },
      });
      setOverview(response.data.data);
      await fetchKillSwitch();
      if (!silent) message.success('实盘能力状态已刷新');
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取实盘总览失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchDraftCandidates = async (silent = false) => {
    setCandidateLoading(true);
    try {
      const response = await api.get('/live-trading/order-draft-candidates', {
        params: { limit: 20, account_role: accountRole },
      });
      setDraftCandidates(response.data.data);
      if (!silent) message.success('策略草稿候选已刷新');
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取策略草稿候选失败');
    } finally {
      setCandidateLoading(false);
    }
  };

  const fetchShadowOutcomes = async (silent = false) => {
    setShadowOutcomeLoading(true);
    try {
      const response = await api.get('/live-trading/shadow-outcomes', {
        params: { limit: 30, horizons: '1,3,5' },
      });
      setShadowOutcomes(response.data.data);
      if (!silent) message.success('影子收益闭环已刷新');
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取影子收益闭环失败');
    } finally {
      setShadowOutcomeLoading(false);
    }
  };

  const fetchShadowTrend = async (silent = false) => {
    setShadowTrendLoading(true);
    try {
      const response = await api.get('/live-trading/shadow-trend', {
        params: { limit: 16 },
      });
      setShadowTrend(response.data.data);
      if (!silent) message.success('影子趋势已刷新');
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取影子趋势失败');
    } finally {
      setShadowTrendLoading(false);
    }
  };

  const fetchShadowBudgetAttribution = async (silent = false) => {
    setShadowBudgetAttributionLoading(true);
    try {
      const response = await api.get('/live-trading/shadow-budget-attribution', {
        params: { limit: 8, window_days: 14 },
      });
      setShadowBudgetAttribution(response.data.data);
      if (!silent) message.success('影子预算效果归因已刷新');
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取影子预算效果归因失败');
    } finally {
      setShadowBudgetAttributionLoading(false);
    }
  };

  const fetchShadowBudgetAudits = async (silent = false) => {
    setShadowBudgetAuditLoading(true);
    try {
      const [suggestionResponse, appliedResponse] = await Promise.all([
        api.get('/tasks/parameter-audits', {
          params: {
            event_type: 'live_shadow_budget_suggestion',
            limit: 1,
            watched_only: false,
          },
        }),
        api.get('/tasks/parameter-audits', {
          params: {
            event_type: 'live_shadow_budget_applied',
            limit: 1,
            watched_only: false,
          },
        }),
      ]);
      setShadowBudgetAudit({
        suggestion: suggestionResponse.data?.data?.[0] || null,
        applied: appliedResponse.data?.data?.[0] || null,
      });
      if (!silent) message.success('影子预算建议状态已刷新');
    } catch (error: any) {
      if (!silent) {
        message.error(error.response?.data?.message || '获取影子预算建议状态失败');
      }
    } finally {
      setShadowBudgetAuditLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview(true);
    fetchDraftCandidates(true);
    fetchShadowOutcomes(true);
    fetchShadowTrend(true);
    fetchShadowBudgetAttribution(true);
    fetchShadowBudgetAudits(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换账户角色时：刷新 overview 和受 account_role 影响的 candidates；
  // shadow/趋势/预算面板暂不强制按 account_role 拉，避免页面抖动太大（后续可加 query 支持）
  useEffect(() => {
    fetchOverview(true);
    fetchDraftCandidates(true);
    fetchLiveOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountRole]);

  const safety = overview?.readiness?.safety;
  const marketHealth = overview?.readiness?.market_data_health;
  const providerComparison = overview?.readiness?.market_data_provider_comparison;
  const reconciliation = overview?.reconciliation;
  const canSubmit = Boolean(safety?.can_submit_orders);
  const shadowSummary = overview?.shadow_autopilot?.summary;
  const blockers = safety?.blockers || [];
  const modeTag = canSubmit ? '受限可提交' : safety?.mode === 'read_only' ? '只读观察' : '安全禁用';
  const latestShadowBudgetSuggestion = shadowBudgetAudit?.suggestion;
  const latestShadowBudgetApplied = shadowBudgetAudit?.applied;
  const latestShadowBudgetSuggestionId = Number(latestShadowBudgetSuggestion?.id || 0);
  const latestShadowBudgetAppliedSourceId = Number(
    latestShadowBudgetApplied?.metadata?.source_audit_id ||
      latestShadowBudgetApplied?.after_parameters?.shadow_budget_advice?.source_audit_id ||
      0
  );
  const latestShadowBudgetSuggestionTime = Date.parse(
    latestShadowBudgetSuggestion?.created_at || ''
  );
  const latestShadowBudgetAppliedTime = Date.parse(latestShadowBudgetApplied?.created_at || '');
  const shadowBudgetSuggestedLimit =
    latestShadowBudgetSuggestion?.after_parameters?.limit ??
    latestShadowBudgetSuggestion?.after_parameters?.shadow_budget_advice?.recommended_limit;
  const shadowBudgetAppliedLimit = latestShadowBudgetApplied?.after_parameters?.limit;
  const shadowBudgetLikelyApplied =
    latestShadowBudgetSuggestionId > 0 &&
    (latestShadowBudgetAppliedSourceId === latestShadowBudgetSuggestionId ||
      (Number.isFinite(latestShadowBudgetAppliedTime) &&
        Number.isFinite(latestShadowBudgetSuggestionTime) &&
        latestShadowBudgetAppliedTime >= latestShadowBudgetSuggestionTime &&
        String(shadowBudgetAppliedLimit ?? '') === String(shadowBudgetSuggestedLimit ?? '')));
  const shadowBudgetSuggestionUnapplied = Boolean(
    latestShadowBudgetSuggestion && !shadowBudgetLikelyApplied
  );
  const shadowBudgetCurrentLimit =
    latestShadowBudgetSuggestion?.before_parameters?.limit ??
    latestShadowBudgetSuggestion?.after_parameters?.shadow_budget_advice?.current_limit ??
    '--';
  const shadowBudgetSuggestionLabel =
    latestShadowBudgetSuggestion?.metadata?.outcome_summary?.budget_label ||
    latestShadowBudgetSuggestion?.after_parameters?.shadow_budget_advice?.label ||
    '影子预算建议';
  const shadowBudgetSuggestionReason =
    latestShadowBudgetSuggestion?.metadata?.outcome_summary?.budget_reason ||
    latestShadowBudgetSuggestion?.after_parameters?.shadow_budget_advice?.reason ||
    '等待更多样本验证影子执行预算是否需要调整。';

  const createDraft = async () => {
    try {
      const values = await draftForm.validateFields();
      setDraftLoading(true);
      const response = await api.post('/live-trading/order-drafts', {
        ...values,
        account_role: accountRole,
      });
      message.success(response.data.message || '订单草稿已创建');
      setIsDraftModalOpen(false);
      draftForm.resetFields();
      await fetchOverview(true);
      await fetchDraftCandidates(true);
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error.response?.data?.message || '创建订单草稿失败');
    } finally {
      setDraftLoading(false);
    }
  };

  const rejectDraft = async (draft: any) => {
    setDraftLoading(true);
    try {
      await api.post(`/live-trading/order-drafts/${draft.id}/reject`, { reason: '用户在页面拒绝' });
      message.success('已拒绝订单草稿');
      await fetchOverview(true);
      await fetchDraftCandidates(true);
    } catch (error: any) {
      message.error(error.response?.data?.message || '拒绝订单草稿失败');
    } finally {
      setDraftLoading(false);
    }
  };

  const openConfirm = (draft: any) => {
    setSelectedDraft(draft);
    setConfirmText('');
    setIsConfirmModalOpen(true);
  };

  const approveDraft = async () => {
    if (!selectedDraft) return;
    if (confirmText.trim() !== (selectedDraft.confirm_text_required || CONFIRM_TEXT)) {
      message.warning(`请输入 ${selectedDraft.confirm_text_required || CONFIRM_TEXT} 后再确认`);
      return;
    }
    setDraftLoading(true);
    try {
      await api.post(`/live-trading/order-drafts/${selectedDraft.id}/approve`, {
        confirm_text: confirmText.trim(),
      });
      message.success('订单草稿已确认');
      setIsConfirmModalOpen(false);
      await fetchOverview(true);
      await fetchDraftCandidates(true);
    } catch (error: any) {
      message.error(error.response?.data?.message || '确认被安全边界阻断');
    } finally {
      setDraftLoading(false);
    }
  };

  const syncReadonly = async (extra?: Record<string, any>) => {
    setSyncLoading(true);
    try {
      // 只读同步带上当前选中的 account_role，避免 grayscale 视图下错把 main 账户刷新
      await api.post('/live-trading/accounts/sync-readonly', {
        account_role: accountRole,
        ...(extra || {}),
      });
      message.success('只读账户同步完成');
      await fetchOverview(true);
      await fetchDraftCandidates(true);
    } catch (error: any) {
      message.warning(error.response?.data?.message || '当前未启用真实券商只读同步');
    } finally {
      setSyncLoading(false);
    }
  };

  // 同步入口：grayscale 角色弹 Modal 收集 account_no 再调 syncReadonly（避免后端必填校验报错）
  const triggerSync = () => {
    if (accountRole !== 'grayscale') {
      syncReadonly();
      return;
    }
    let inputAccountNo = '';
    let inputAlias = '';
    Modal.confirm({
      title: '绑定灰度账户后同步',
      content: (
        <div>
          <p style={{ marginBottom: 8 }}>
            灰度账户必须显式提供资金账号，避免与主账户复用占位行。
          </p>
          <Form layout="vertical">
            <Form.Item label="资金账号">
              <Input
                placeholder="例如 1234567890"
                onChange={e => {
                  inputAccountNo = e.target.value.trim();
                }}
              />
            </Form.Item>
            <Form.Item label="账户别名（可选）">
              <Input
                placeholder="灰度小额账户"
                onChange={e => {
                  inputAlias = e.target.value.trim();
                }}
              />
            </Form.Item>
          </Form>
        </div>
      ),
      okText: '同步并绑定',
      onOk: async () => {
        if (!inputAccountNo) {
          message.error('请填写灰度账户的资金账号');
          throw new Error('missing account_no');
        }
        await syncReadonly({ account_no: inputAccountNo, account_alias: inputAlias || undefined });
      },
    });
  };

  /** 用户撤单：调 POST /live-trading/orders/:id/cancel */
  const cancelLiveOrder = async (order: any) => {
    Modal.confirm({
      title: `确认撤单 ${order.symbol}?`,
      content: `订单 ${order.id} (券商委托号 ${order.broker_order_id || '未知'}) 将通过本地桥撤单通道下发，结果以 trader callback 为准。`,
      okType: 'danger',
      okText: '确认撤单',
      onOk: async () => {
        // 乐观锁定：立刻把该行 bridge_status 标记为 cancelling，避免用户重复点
        setLiveOrders(prev =>
          prev.map(o => (o.id === order.id ? { ...o, bridge_status: 'cancelling' } : o))
        );
        try {
          const resp = await api.post(`/live-trading/orders/${order.id}/cancel`, {
            account_id: order.account_id,
            reason: 'user_cancel_from_ui',
          });
          message.success(resp.data.message || '撤单已入队');
          await fetchOverview(true);
          await fetchLiveOrders();
        } catch (e: any) {
          // 失败回滚乐观更新
          setLiveOrders(prev =>
            prev.map(o => (o.id === order.id ? { ...o, bridge_status: order.bridge_status } : o))
          );
          message.error(e.response?.data?.message || '撤单失败');
        }
      },
    });
  };

  const riskChecks = useMemo(() => selectedDraft?.risk_check?.checks || [], [selectedDraft]);

  const createDraftFromCandidate = async (candidate: any) => {
    setCandidateLoading(true);
    try {
      const response = await api.post('/live-trading/order-drafts/from-candidate', {
        symbol: candidate.symbol,
        account_role: accountRole,
      });
      message.success(response.data.message || '策略候选已生成实盘订单草稿');
      await fetchOverview(true);
      await fetchDraftCandidates(true);
    } catch (error: any) {
      message.warning(error.response?.data?.message || '该候选暂不能生成实盘草稿');
    } finally {
      setCandidateLoading(false);
    }
  };

  const runShadowAutopilot = async () => {
    setShadowLoading(true);
    try {
      const response = await api.post('/live-trading/order-drafts/shadow-autopilot', {
        limit: 3,
        source: 'live_trading_page',
        account_role: accountRole,
      });
      message.success(response.data.message || '无人影子执行已完成');
      await fetchOverview(true);
      await fetchDraftCandidates(true);
      await fetchShadowOutcomes(true);
      await fetchShadowTrend(true);
      await fetchShadowBudgetAttribution(true);
      await fetchShadowBudgetAudits(true);
    } catch (error: any) {
      message.warning(error.response?.data?.message || '无人影子执行暂不可用');
    } finally {
      setShadowLoading(false);
    }
  };

  const shadowExecuteDraft = async (draft: any) => {
    setShadowLoading(true);
    try {
      await api.post(`/live-trading/order-drafts/${draft.id}/shadow-execute`, {
        source: 'live_trading_page',
      });
      message.success('影子执行已记录，未提交真实券商委托');
      await fetchOverview(true);
      await fetchDraftCandidates(true);
      await fetchShadowOutcomes(true);
      await fetchShadowTrend(true);
      await fetchShadowBudgetAttribution(true);
      await fetchShadowBudgetAudits(true);
    } catch (error: any) {
      message.warning(error.response?.data?.message || '影子执行被风控阻断');
    } finally {
      setShadowLoading(false);
    }
  };

  const reconcileColumns = [
    {
      title: '股票',
      dataIndex: 'symbol',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (value: string, record: any) => (
        <Tag color={matchColor[value] || 'default'}>{record.status_label || value}</Tag>
      ),
    },
    {
      title: '实盘',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text>{formatMoney(record.live_market_value)}</Text>
          <Text type="secondary">
            {Number(record.live_quantity || 0).toLocaleString()} 股 ·{' '}
            {Number(record.live_weight_pct || 0).toFixed(2)}%
          </Text>
        </Space>
      ),
    },
    {
      title: '模拟策略',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text>{formatMoney(record.paper_market_value)}</Text>
          <Text type="secondary">
            {Number(record.paper_quantity || 0).toLocaleString()} 股 ·{' '}
            {Number(record.paper_weight_pct || 0).toFixed(2)}%
          </Text>
        </Space>
      ),
    },
    {
      title: '权重差',
      dataIndex: 'weight_gap_pct',
      render: (value: number) => (
        <Text type={Math.abs(Number(value || 0)) > 5 ? 'danger' : 'secondary'}>
          {Number(value || 0).toFixed(2)}%
        </Text>
      ),
    },
  ];

  const draftColumns = [
    {
      title: '标的',
      dataIndex: 'symbol',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '方向',
      dataIndex: 'side',
      render: (value: string) => (
        <Tag color={value === 'BUY' ? 'red' : 'green'}>{value === 'BUY' ? '买入' : '卖出'}</Tag>
      ),
    },
    {
      title: '数量/限价',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text>{Number(record.quantity || 0).toLocaleString()} 股</Text>
          <Text type="secondary">¥{Number(record.limit_price || 0).toFixed(2)}</Text>
        </Space>
      ),
    },
    {
      title: '预计金额',
      dataIndex: 'estimated_amount',
      render: (value: number) => formatMoney(value),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (value: string, record: any) => (
        <Space direction="vertical" size={2}>
          <Tag color={draftStatusColor[value] || 'default'}>{value}</Tag>
          <Text type={record.risk_check?.allowed ? 'secondary' : 'danger'}>
            {record.risk_check?.allowed ? '风控通过' : '风控阻断'}
          </Text>
        </Space>
      ),
    },
    {
      title: 'Bridge 状态',
      dataIndex: 'bridge_status',
      // 来自 live_orders.bridge_status（如果该草稿已经走到 live_orders / live_broker_commands）
      render: (_: any, record: any) => {
        const bridgeStatus = record.bridge_status || record.live_order_bridge_status || '-';
        const colorMap: Record<string, string> = {
          pending: 'default',
          dispatched: 'processing',
          submitted: 'gold',
          partially_filled: 'cyan',
          filled: 'green',
          cancelled: 'orange',
          failed: 'red',
          expired: 'magenta',
        };
        return (
          <Space direction="vertical" size={2}>
            <Tag color={colorMap[bridgeStatus] || 'default'}>{bridgeStatus}</Tag>
            {record.client_order_id && (
              <Text type="secondary" copyable={{ text: record.client_order_id }}>
                {String(record.client_order_id).slice(0, 12)}…
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '行情/复核',
      render: (_: any, record: any) => {
        const quote = record.quote_snapshot || {};
        const failedChecks = record.risk_check?.failed_checks || [];
        return (
          <Space direction="vertical" size={2}>
            <Tag color={quote.is_realtime ? 'green' : quote.current_price ? 'gold' : 'default'}>
              {quote.current_price ? `¥${Number(quote.current_price).toFixed(2)}` : '无行情'}
            </Tag>
            <Text type="secondary">
              {quote.latency_seconds !== undefined
                ? `延迟 ${Math.round(Number(quote.latency_seconds || 0))} 秒`
                : '等待行情 SLA'}
            </Text>
            {failedChecks.length > 0 && (
              <Text type="danger">
                {failedChecks
                  .slice(0, 2)
                  .map((item: any) => item.label)
                  .join('、')}
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '操作',
      fixed: 'right' as const,
      render: (_: any, record: any) => (
        <Space>
          <Button
            size="small"
            disabled={
              !record.risk_check?.allowed || !['pending', 'preview'].includes(record.status)
            }
            onClick={() => openConfirm(record)}
          >
            确认
          </Button>
          <Button
            size="small"
            type="primary"
            ghost
            disabled={
              !record.risk_check?.allowed || !['pending', 'preview'].includes(record.status)
            }
            loading={shadowLoading}
            onClick={() => shadowExecuteDraft(record)}
          >
            影子执行
          </Button>
          <Button
            size="small"
            type="link"
            disabled={['rejected', 'submitted'].includes(record.status)}
            onClick={() => rejectDraft(record)}
          >
            拒绝
          </Button>
        </Space>
      ),
    },
  ];

  const candidateColumns = [
    {
      title: '候选标的',
      dataIndex: 'symbol',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '来源差异',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Tag color={matchColor[record.candidate_type] || 'blue'}>
            {record.status_label || record.candidate_type}
          </Tag>
          <Text type="secondary">权重差 {Number(record.weight_gap_pct || 0).toFixed(2)}%</Text>
        </Space>
      ),
    },
    {
      title: '建议草稿',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text>{Number(record.suggested_quantity || 0).toLocaleString()} 股</Text>
          <Text type="secondary">限价 ¥{Number(record.suggested_limit_price || 0).toFixed(2)}</Text>
          <Text type="secondary">{formatMoney(record.estimated_amount)}</Text>
        </Space>
      ),
    },
    {
      title: '行情',
      render: (_: any, record: any) => {
        const quote = record.quote_snapshot || {};
        return (
          <Space direction="vertical" size={0}>
            <Tag color={quote.is_realtime ? 'green' : quote.current_price ? 'gold' : 'default'}>
              {quote.current_price ? `¥${Number(quote.current_price).toFixed(2)}` : '无行情'}
            </Tag>
            <Text type="secondary">
              {quote.latency_seconds !== undefined
                ? `延迟 ${Math.round(Number(quote.latency_seconds || 0))} 秒`
                : '等待行情'}
            </Text>
          </Space>
        );
      },
    },
    {
      title: '状态',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Tag color={record.eligible ? 'green' : record.duplicate_draft ? 'purple' : 'default'}>
            {record.eligible ? '可生成草稿' : record.duplicate_draft ? '已有草稿' : '暂不满足'}
          </Tag>
          {!record.eligible && (
            <Text type="secondary">{record.block_reason || '等待条件满足'}</Text>
          )}
        </Space>
      ),
    },
    {
      title: '操作',
      fixed: 'right' as const,
      render: (_: any, record: any) => (
        <Button
          size="small"
          type="primary"
          disabled={!record.eligible}
          loading={candidateLoading}
          onClick={() => createDraftFromCandidate(record)}
        >
          生成草稿
        </Button>
      ),
    },
  ];

  const shadowBudgetAttributionColumns = [
    {
      title: '预算建议',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Space wrap size={4}>
            <Tag color={record.applied ? 'green' : 'gold'}>
              {record.applied ? '已应用' : '待应用'}
            </Tag>
            <Text strong>
              limit {record.before_limit ?? '--'} → {record.suggested_limit ?? '--'}
            </Text>
          </Space>
          <Text type="secondary">
            {record.budget_label || record.decision?.label || '影子预算'}
          </Text>
          <Text type="secondary">{formatDateTime(record.applied_at || record.generated_at)}</Text>
        </Space>
      ),
    },
    {
      title: '应用前',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text>{record.pre_window?.evaluated_count || 0} 样本</Text>
          <Text type={pnlTextType(record.pre_window?.avg_latest_return_pct)}>
            均收 {formatPct(record.pre_window?.avg_latest_return_pct)}
          </Text>
          <Text type="secondary">胜率 {formatPct(record.pre_window?.win_rate_pct, 1)}</Text>
        </Space>
      ),
    },
    {
      title: '应用后',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text>{record.post_window?.evaluated_count || 0} 样本</Text>
          <Text type={pnlTextType(record.post_window?.avg_latest_return_pct)}>
            均收 {formatPct(record.post_window?.avg_latest_return_pct)}
          </Text>
          <Text type="secondary">胜率 {formatPct(record.post_window?.win_rate_pct, 1)}</Text>
        </Space>
      ),
    },
    {
      title: '变化',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text type={pnlTextType(record.delta?.avg_latest_return_pct)}>
            均收 {formatPct(record.delta?.avg_latest_return_pct)}
          </Text>
          <Text type={pnlTextType(record.delta?.win_rate_pct)}>
            胜率 {formatPct(record.delta?.win_rate_pct, 1)}
          </Text>
          <Text type="secondary">盈亏 {formatMoney(record.delta?.total_latest_pnl)}</Text>
        </Space>
      ),
    },
    {
      title: '判断',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Tag color={shadowBudgetColor[record.decision?.level || 'watch'] || 'gold'}>
            {record.decision?.label || '观察'}
          </Tag>
          <Text type="secondary" ellipsis={{ tooltip: record.decision?.reason }}>
            {record.decision?.reason || '--'}
          </Text>
        </Space>
      ),
    },
  ];

  const shadowOutcomeColumns = [
    {
      title: '影子标的',
      dataIndex: 'symbol',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '假设成交',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text>{Number(record.quantity || 0).toLocaleString()} 股</Text>
          <Text type="secondary">¥{Number(record.entry_price || 0).toFixed(2)}</Text>
          <Text type="secondary">{record.entry_date || '--'}</Text>
        </Space>
      ),
    },
    {
      title: '最新收益',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text type={pnlTextType(record.latest_return_pct)}>
            {formatPct(record.latest_return_pct)}
          </Text>
          <Text type={pnlTextType(record.latest_pnl)}>
            {record.latest_pnl === null || record.latest_pnl === undefined
              ? '--'
              : formatMoney(record.latest_pnl)}
          </Text>
          <Text type="secondary">
            最新价 {record.latest_price ? `¥${Number(record.latest_price).toFixed(2)}` : '--'}
          </Text>
        </Space>
      ),
    },
    {
      title: '1/3/5日',
      render: (_: any, record: any) => {
        const horizons = record.horizon_returns || {};
        return (
          <Space wrap size={[4, 4]}>
            {['1d', '3d', '5d'].map(key => (
              <Tag
                key={key}
                color={
                  Number(horizons[key]?.return_pct || 0) > 0
                    ? 'green'
                    : Number(horizons[key]?.return_pct || 0) < 0
                    ? 'red'
                    : 'default'
                }
              >
                {key.toUpperCase()} {formatPct(horizons[key]?.return_pct)}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'outcome_status',
      render: (value: string, record: any) => (
        <Space direction="vertical" size={2}>
          <Tag color={shadowOutcomeColor[value] || 'default'}>{record.status_label || value}</Tag>
          <Text type="secondary">真实提交 {record.real_order_submitted ? '1' : '0'} 笔</Text>
        </Space>
      ),
    },
  ];

  return (
    <div className="live-trading-page page-fade-in">
      <div className="page-hero live-trading-hero">
        <div>
          <Space wrap size={8}>
            <Tag
              color={canSubmit ? 'orange' : 'green'}
              icon={canSubmit ? <WarningOutlined /> : <LockOutlined />}
            >
              {modeTag}
            </Tag>
            <Tag color="blue">实盘辅助，不默认代操</Tag>
          </Space>
          <h1>实盘交易安全边界</h1>
          <p>
            这里是接入真实行情与券商账户前的安全控制台。系统可以生成订单草稿与风控解释，
            但默认不会提交真实委托；所有真实交易必须人工确认、强风控、可审计。
          </p>
        </div>
        <Space wrap>
          <Radio.Group
            value={accountRole}
            onChange={e => setAccountRole(e.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="main">主账户</Radio.Button>
            <Radio.Button value="grayscale">灰度账户</Radio.Button>
          </Radio.Group>
          <Button icon={<ReloadOutlined />} onClick={() => fetchOverview(false)} loading={loading}>
            刷新状态
          </Button>
          <Button icon={<WalletOutlined />} onClick={triggerSync} loading={syncLoading}>
            只读同步
          </Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={() => setIsDraftModalOpen(true)}
          >
            新建订单草稿
          </Button>
        </Space>
      </div>

      {/* Kill switch 状态卡片（env 或 DB 任一熔断即显示红色告警） */}
      {(killSwitch?.active || safety?.global_kill_switch) && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            <Space>
              <strong>Kill switch 已熔断 — 所有真实下单被阻断</strong>
              {killSwitch?.state?.reason_code && <Tag color="red">{killSwitch.state.reason_code}</Tag>}
            </Space>
          }
          description={
            <Space direction="vertical" size={4}>
              {killSwitch?.state?.reason_detail && <Text>{killSwitch.state.reason_detail}</Text>}
              {killSwitch?.state?.triggered_at && (
                <Text type="secondary">
                  触发时间 {new Date(killSwitch.state.triggered_at).toLocaleString()}
                </Text>
              )}
              <Space>
                <Button
                  size="small"
                  danger
                  onClick={async () => {
                    Modal.confirm({
                      title: '解除 Kill switch?',
                      content: '只有在确认风险已消除后才解除；解除事件会写入审计。',
                      okType: 'danger',
                      onOk: async () => {
                        try {
                          await api.post('/live-trading/kill-switch/resolve', { note: 'resolved from UI' });
                          message.success('已解除');
                          await fetchKillSwitch();
                          await fetchOverview(true);
                        } catch (e: any) {
                          message.error(e.response?.data?.message || '解除失败');
                        }
                      },
                    });
                  }}
                >
                  人工解除
                </Button>
              </Space>
            </Space>
          }
        />
      )}

      <Spin spinning={loading}>
        <Alert
          className="live-trading-boundary-alert"
          type={canSubmit ? 'warning' : 'success'}
          showIcon
          message={overview?.summary?.conclusion || '实盘提交能力默认关闭'}
          description={
            blockers.length
              ? `当前阻断项：${blockers.join('；')}`
              : '即使开关启用，也必须经过订单审批、强确认和风控审计。'
          }
        />

        <Alert
          className="live-trading-boundary-alert"
          type="info"
          showIcon
          message="无人确认已切到影子执行：真实券商委托仍硬阻断"
          description={
            safety?.unattended_policy?.conclusion ||
            '系统可以自动记录影子成交、沉淀审计和后验样本；不会绕过确认提交真实资金订单。'
          }
          action={
            <Button
              size="small"
              type="primary"
              loading={shadowLoading}
              onClick={runShadowAutopilot}
            >
              运行影子执行
            </Button>
          }
        />

        <Row gutter={[16, 16]}>
          <Col xs={24} md={6}>
            <Card className="modern-card live-stat-card" variant="borderless">
              <Statistic
                title="总资产"
                value={overview?.summary?.total_asset || 0}
                precision={2}
                prefix="¥"
              />
              <span>{overview?.summary?.account_bound ? '已绑定只读账户' : '未绑定真实账户'}</span>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card className="modern-card live-stat-card" variant="borderless">
              <Statistic
                title="可用资金"
                value={overview?.summary?.available_cash || 0}
                precision={2}
                prefix="¥"
              />
              <span>来自券商只读快照</span>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card className="modern-card live-stat-card" variant="borderless">
              <Statistic
                title="总仓位"
                value={overview?.summary?.exposure_pct || 0}
                precision={2}
                suffix="%"
              />
              <span>{overview?.summary?.position_count || 0} 个真实持仓</span>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card className="modern-card live-stat-card" variant="borderless">
              <Statistic title="行情 SLA" value={marketHealth?.status_label || '--'} />
              <span>
                {marketHealth
                  ? `样本 ${marketHealth.sample_count} · 延迟 ${marketHealth.max_latency_seconds}s`
                  : '等待行情检查'}
              </span>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card className="modern-card live-stat-card" variant="borderless">
              <Statistic
                title="影子执行"
                value={shadowSummary?.shadow_executed_count || 0}
                suffix="笔"
              />
              <span>真实提交 {shadowSummary?.real_order_submitted || 0} 笔</span>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card className="modern-card live-stat-card" variant="borderless">
              <Statistic
                title="实盘/模拟对齐"
                value={reconciliation?.summary?.alignment_score || 0}
                precision={0}
                suffix="分"
              />
              <span>{reconciliation?.status_label || '等待对账'}</span>
            </Card>
          </Col>
        </Row>

        <Row gutter={[16, 16]} className="live-section-row">
          <Col xs={24} lg={10}>
            <Card className="modern-card" variant="borderless" title="实盘接入阶段">
              <Timeline
                items={(overview?.readiness?.phases || []).map(item => ({
                  color:
                    item.status === 'ready' ? 'green' : item.status === 'blocked' ? 'red' : 'blue',
                  children: (
                    <div className="live-phase-item">
                      <Space>
                        <Text strong>{item.label}</Text>
                        <Tag color={statusColor[item.status] || 'default'}>{item.status}</Tag>
                      </Space>
                      <p>{item.detail}</p>
                    </div>
                  ),
                }))}
              />
            </Card>
          </Col>
          <Col xs={24} lg={14}>
            <Card className="modern-card" variant="borderless" title="券商与行情网关">
              <Row gutter={[12, 12]}>
                <Col xs={24} md={12}>
                  <div className="live-gateway-card">
                    <SafetyCertificateOutlined />
                    <strong>
                      {overview?.readiness?.broker?.broker_name || '安全占位券商网关'}
                    </strong>
                    <span>{overview?.readiness?.broker?.broker_key || 'mock_guarded'}</span>
                    <p>{overview?.readiness?.broker?.notes?.[0] || '当前不会连接真实券商。'}</p>
                  </div>
                </Col>
                <Col xs={24} md={12}>
                  <div className="live-gateway-card">
                    <AuditOutlined />
                    <Space wrap size={6}>
                      <strong>
                        {overview?.readiness?.market_data?.provider_name || '本地行情缓存'}
                      </strong>
                      <Tag color={marketHealthColor[marketHealth?.status || 'empty'] || 'default'}>
                        {marketHealth?.status_label || '待检查'}
                      </Tag>
                    </Space>
                    <span>
                      {overview?.readiness?.market_data?.provider_key || 'database_realtime_quotes'}
                    </span>
                    <p>{marketHealth?.conclusion || '商业化前需替换授权实时行情。'}</p>
                  </div>
                </Col>
              </Row>
              {marketHealth && (
                <div className="live-market-health-strip">
                  <div>
                    <span>缺失</span>
                    <strong>{marketHealth.missing_count}</strong>
                  </div>
                  <div>
                    <span>延迟</span>
                    <strong>{marketHealth.stale_count}</strong>
                  </div>
                  <div>
                    <span>缺失率</span>
                    <strong>{Number(marketHealth.missing_ratio_pct || 0).toFixed(2)}%</strong>
                  </div>
                  <div>
                    <span>授权</span>
                    <strong>
                      {marketHealth.licensed_for_external_use ? '可外用' : '内部验证'}
                    </strong>
                  </div>
                </div>
              )}
              {providerComparison && (
                <div className="live-provider-compare">
                  <div className="live-provider-compare-head">
                    <Text strong>行情源对比</Text>
                    <Text type="secondary">{providerComparison.conclusion}</Text>
                  </div>
                  {(providerComparison.providers || []).map(provider => (
                    <div
                      className={`live-provider-row ${
                        provider.provider.provider_key === providerComparison.active_provider_key
                          ? 'active'
                          : ''
                      }`}
                      key={provider.provider.provider_key}
                    >
                      <div>
                        <Text strong>{provider.provider.provider_name}</Text>
                        <span>{provider.provider.provider_key}</span>
                      </div>
                      <Tag color={marketHealthColor[provider.status] || 'default'}>
                        {provider.status_label}
                      </Tag>
                      <em>
                        样本 {provider.sample_count} · 缺失 {provider.missing_count} · 延迟{' '}
                        {provider.stale_count} · 最大 {provider.max_latency_seconds}s
                      </em>
                    </div>
                  ))}
                </div>
              )}
              <div className="live-risk-limit-grid">
                {Object.entries(safety?.default_risk_limits || {})
                  .slice(0, 8)
                  .map(([key, value]) => (
                    <div key={key}>
                      <span>{key}</span>
                      <strong>{String(value)}</strong>
                    </div>
                  ))}
              </div>
            </Card>
          </Col>
        </Row>

        <Row gutter={[16, 16]} className="live-section-row">
          <Col xs={24} lg={9}>
            <Card
              className="modern-card live-reconcile-card"
              variant="borderless"
              title={
                <Space>
                  <ReconciliationOutlined />
                  <span>只读对账结论</span>
                </Space>
              }
            >
              <div className="live-reconcile-score">
                <div>
                  <span>对齐分</span>
                  <strong>
                    {Number(reconciliation?.summary?.alignment_score || 0).toFixed(0)}
                  </strong>
                  <em>/100</em>
                </div>
                <Tag
                  color={reconciliationColor[reconciliation?.status || 'not_bound'] || 'default'}
                >
                  {reconciliation?.status_label || '未接账户'}
                </Tag>
              </div>
              <p className="live-reconcile-conclusion">
                {reconciliation?.summary?.conclusion ||
                  '接入券商只读账户后，这里会展示真实持仓与模拟策略账户的差异。'}
              </p>
              <div className="live-reconcile-metrics">
                <div>
                  <span>实盘市值</span>
                  <strong>{formatMoney(reconciliation?.summary?.live_market_value)}</strong>
                </div>
                <div>
                  <span>模拟市值</span>
                  <strong>{formatMoney(reconciliation?.summary?.paper_market_value)}</strong>
                </div>
                <div>
                  <span>仅实盘</span>
                  <strong>{reconciliation?.summary?.live_only_count || 0} 只</strong>
                </div>
                <div>
                  <span>仅模拟</span>
                  <strong>{reconciliation?.summary?.paper_only_count || 0} 只</strong>
                </div>
              </div>
              <div className="live-reconcile-suggestions">
                {(reconciliation?.suggestions || []).slice(0, 4).map(item => (
                  <div key={item.title} className={`live-reconcile-suggestion ${item.level}`}>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </div>
                ))}
              </div>
            </Card>
          </Col>
          <Col xs={24} lg={15}>
            <Card
              className="modern-card"
              variant="borderless"
              title={
                <Space>
                  <BranchesOutlined />
                  <span>实盘 vs 策略模拟持仓</span>
                </Space>
              }
            >
              <div className="live-paper-account-strip">
                {(reconciliation?.paper_accounts || []).slice(0, 5).map(account => (
                  <div key={account.key} className={account.exists ? 'active' : ''}>
                    <span>{account.label}</span>
                    <strong>{formatMoney(account.total_value)}</strong>
                    <em>
                      持仓 {account.open_position_count || 0} · 暴露{' '}
                      {Number(account.exposure_pct || 0).toFixed(1)}%
                    </em>
                  </div>
                ))}
              </div>
              <Table
                columns={reconcileColumns}
                dataSource={reconciliation?.position_matches || []}
                rowKey="symbol"
                size="small"
                pagination={{ pageSize: 6 }}
                scroll={{ x: 'max-content' }}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="暂无可对账持仓。模拟盘建仓或只读账户同步后会显示差异。"
                    />
                  ),
                }}
              />
            </Card>
          </Col>
        </Row>

        <Card
          className="modern-card live-candidate-card"
          variant="borderless"
          title={
            <Space>
              <BulbOutlined />
              <span>策略候选生成实盘草稿</span>
            </Space>
          }
          extra={
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => fetchDraftCandidates(false)}
              loading={candidateLoading}
            >
              刷新候选
            </Button>
          }
        >
          <Alert
            className="live-candidate-alert"
            type={draftCandidates?.summary?.eligible_count ? 'info' : 'warning'}
            showIcon
            message={draftCandidates?.summary?.conclusion || '正在检查策略候选是否可以进入实盘草稿'}
            description="这里会把“仅模拟建议 / 实盘偏轻”的股票转成候选草稿；点击后只创建订单草稿，不会真实下单，确认前仍会重新跑行情 SLA、只读账户快照和风控。"
          />
          <div className="live-candidate-metrics">
            <div>
              <span>候选</span>
              <strong>{draftCandidates?.summary?.total_count || 0}</strong>
            </div>
            <div>
              <span>可生成</span>
              <strong>{draftCandidates?.summary?.eligible_count || 0}</strong>
            </div>
            <div>
              <span>已有草稿</span>
              <strong>{draftCandidates?.summary?.duplicate_count || 0}</strong>
            </div>
            <div>
              <span>阻断</span>
              <strong>{draftCandidates?.summary?.blocked_count || 0}</strong>
            </div>
          </div>
          <Table
            columns={candidateColumns}
            dataSource={draftCandidates?.candidates || []}
            rowKey={(record: any) => `${record.symbol}-${record.candidate_type}`}
            size="small"
            loading={candidateLoading}
            pagination={{ pageSize: 6 }}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无策略草稿候选。需要模拟策略账户有持仓，且券商只读账户完成同步后才会出现。"
                />
              ),
            }}
          />
        </Card>

        <Card
          className="modern-card live-candidate-card"
          variant="borderless"
          title="无人确认影子执行闭环"
          extra={
            <Button
              size="small"
              type="primary"
              loading={shadowLoading}
              onClick={runShadowAutopilot}
            >
              跑影子执行
            </Button>
          }
        >
          <Alert
            type="info"
            showIcon
            message={shadowSummary?.conclusion || '影子执行只记录假设成交，不提交真实券商委托'}
            description="这一步用于跳过人工确认做自动化闭环验证：系统会按策略候选生成草稿、二次风控并标记影子成交；真实资金订单提交数始终为 0。"
          />
          <div className="live-candidate-metrics">
            <div>
              <span>影子记录</span>
              <strong>{shadowSummary?.shadow_executed_count || 0}</strong>
            </div>
            <div>
              <span>影子金额</span>
              <strong>{formatMoney(shadowSummary?.total_shadow_amount)}</strong>
            </div>
            <div>
              <span>真实提交</span>
              <strong>{shadowSummary?.real_order_submitted || 0}</strong>
            </div>
            <div>
              <span>最新时间</span>
              <strong>
                {shadowSummary?.latest_at
                  ? new Date(shadowSummary.latest_at).toLocaleString()
                  : '--'}
              </strong>
            </div>
          </div>
          <Table
            columns={draftColumns.filter((column: any) => column.title !== '操作')}
            dataSource={overview?.shadow_autopilot?.drafts || []}
            rowKey="id"
            size="small"
            pagination={{ pageSize: 5 }}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无影子执行记录。点击运行后会从可用候选中自动生成闭环样本。"
                />
              ),
            }}
          />
        </Card>

        <Card
          className="modern-card live-shadow-outcome-card"
          variant="borderless"
          title={
            <Space>
              <ReconciliationOutlined />
              <span>影子执行收益闭环</span>
            </Space>
          }
          extra={
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => fetchShadowOutcomes(false)}
              loading={shadowOutcomeLoading}
            >
              刷新收益
            </Button>
          }
        >
          <div className="live-shadow-outcome-brief">
            <div>
              <Text type="secondary">结论</Text>
              <strong>
                {shadowOutcomes?.summary?.conclusion ||
                  '运行影子执行后，这里会自动比较假设成交价与后续行情收益。'}
              </strong>
            </div>
            <Space wrap>
              <Tag
                color={
                  shadowBudgetColor[shadowOutcomes?.summary?.budget_decision?.level || 'watch'] ||
                  'gold'
                }
              >
                {shadowOutcomes?.summary?.budget_decision?.label || '等待样本'}
              </Tag>
              <Tag color="green">真实提交 0 笔</Tag>
            </Space>
          </div>
          <div className="live-shadow-budget-note">
            <strong>
              建议影子预算：{shadowOutcomes?.summary?.budget_decision?.recommended_limit || 2} 笔/次
            </strong>
            <span>
              {shadowOutcomes?.summary?.budget_decision?.reason ||
                '样本不足时只保持小流量影子验证，不扩大到真实资金自动执行。'}
            </span>
          </div>
          {latestShadowBudgetSuggestion && (
            <div
              className={`live-shadow-budget-audit ${
                shadowBudgetSuggestionUnapplied
                  ? 'live-shadow-budget-audit--pending'
                  : 'live-shadow-budget-audit--applied'
              }`}
            >
              <div>
                <Space wrap size={6}>
                  <Tag color={shadowBudgetSuggestionUnapplied ? 'gold' : 'green'}>
                    {shadowBudgetSuggestionUnapplied ? '候选补丁待应用' : '最新建议已应用'}
                  </Tag>
                  <Text strong>{shadowBudgetSuggestionLabel}</Text>
                </Space>
                <Text type="secondary">
                  limit {shadowBudgetCurrentLimit} → {shadowBudgetSuggestedLimit ?? '--'} ·{' '}
                  {formatDateTime(latestShadowBudgetSuggestion.created_at)}
                </Text>
                <Text type="secondary">{shadowBudgetSuggestionReason}</Text>
              </div>
              <Space wrap>
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={shadowBudgetAuditLoading}
                  onClick={() => fetchShadowBudgetAudits(false)}
                >
                  刷新建议
                </Button>
                <Button
                  size="small"
                  type={shadowBudgetSuggestionUnapplied ? 'primary' : 'default'}
                  ghost={shadowBudgetSuggestionUnapplied}
                  onClick={() => {
                    window.location.href = '/tasks';
                  }}
                >
                  去调度任务应用
                </Button>
              </Space>
            </div>
          )}
          <div className="live-candidate-metrics live-shadow-outcome-metrics">
            <div>
              <span>样本</span>
              <strong>{shadowOutcomes?.summary?.shadow_trade_count || 0}</strong>
            </div>
            <div>
              <span>已评估</span>
              <strong>{shadowOutcomes?.summary?.evaluated_count || 0}</strong>
            </div>
            <div>
              <span>胜率</span>
              <strong>{formatPct(shadowOutcomes?.summary?.win_rate_pct, 1)}</strong>
            </div>
            <div>
              <span>平均收益</span>
              <strong>{formatPct(shadowOutcomes?.summary?.avg_latest_return_pct, 2)}</strong>
            </div>
            <div>
              <span>浮动盈亏</span>
              <strong>{formatMoney(shadowOutcomes?.summary?.total_latest_pnl)}</strong>
            </div>
          </div>
          <div className="live-shadow-horizon-strip">
            {(shadowOutcomes?.summary?.horizon_summary || []).map(item => (
              <div key={item.horizon_days}>
                <span>{item.horizon_days}日收益</span>
                <strong>{formatPct(item.avg_return_pct, 2)}</strong>
                <em>
                  {item.evaluated_count} 样本 · 胜率 {formatPct(item.win_rate_pct, 1)}
                </em>
              </div>
            ))}
          </div>
          <div className="live-shadow-baseline-strip">
            <div>
              <span>模拟盘同期</span>
              <strong>
                {formatPct(
                  shadowOutcomes?.summary?.baseline?.paper_trading?.avg_latest_return_pct
                )}
              </strong>
              <em>
                {shadowOutcomes?.summary?.baseline?.paper_trading?.evaluated_count || 0} 样本 ·
                胜率{' '}
                {formatPct(shadowOutcomes?.summary?.baseline?.paper_trading?.win_rate_pct, 1)}
              </em>
            </div>
            <div>
              <span>信号后验</span>
              <strong>
                {formatPct(
                  shadowOutcomes?.summary?.baseline?.signal_forward_returns?.avg_return_pct
                )}
              </strong>
              <em>
                {shadowOutcomes?.summary?.baseline?.signal_forward_returns?.sample_count || 0} 样本
                · 胜率{' '}
                {formatPct(
                  shadowOutcomes?.summary?.baseline?.signal_forward_returns?.win_rate_pct,
                  1
                )}
              </em>
            </div>
            <div>
              <span>影子-模拟差</span>
              <strong>
                {shadowOutcomes?.summary?.avg_latest_return_pct !== undefined &&
                shadowOutcomes?.summary?.avg_latest_return_pct !== null &&
                shadowOutcomes?.summary?.baseline?.paper_trading?.avg_latest_return_pct !==
                  undefined &&
                shadowOutcomes?.summary?.baseline?.paper_trading?.avg_latest_return_pct !== null
                  ? `${(
                      Number(shadowOutcomes.summary.avg_latest_return_pct) -
                      Number(shadowOutcomes.summary.baseline.paper_trading.avg_latest_return_pct)
                    ).toFixed(2)}pct`
                  : '--'}
              </strong>
              <em>同期起点 {shadowOutcomes?.summary?.baseline?.since || '--'}</em>
            </div>
          </div>
          <div className="live-shadow-budget-attribution-panel">
            <div className="live-shadow-trend-head">
              <div>
                <Text type="secondary">预算效果归因</Text>
                <strong>
                  {shadowBudgetAttribution?.summary?.conclusion ||
                    '等待周度复盘生成预算建议后，系统会比较应用前后的影子收益变化。'}
                </strong>
              </div>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={shadowBudgetAttributionLoading}
                onClick={() => fetchShadowBudgetAttribution(false)}
              >
                刷新归因
              </Button>
            </div>
            <div className="live-shadow-budget-attribution-metrics">
              <div>
                <span>建议数</span>
                <strong>{shadowBudgetAttribution?.summary?.suggestion_count || 0}</strong>
              </div>
              <div>
                <span>已应用</span>
                <strong>{shadowBudgetAttribution?.summary?.applied_count || 0}</strong>
              </div>
              <div>
                <span>有效</span>
                <strong>{shadowBudgetAttribution?.summary?.effective_count || 0}</strong>
              </div>
              <div>
                <span>最新均收变化</span>
                <strong>
                  {formatPct(shadowBudgetAttribution?.summary?.latest_delta_avg_return_pct)}
                </strong>
              </div>
              <div>
                <span>总样本</span>
                <strong>{shadowBudgetAttribution?.summary?.total_evaluated_count || 0}</strong>
              </div>
            </div>
            <Table
              columns={shadowBudgetAttributionColumns}
              dataSource={shadowBudgetAttribution?.periods || []}
              rowKey="audit_id"
              size="small"
              loading={shadowBudgetAttributionLoading}
              pagination={{ pageSize: 4 }}
              scroll={{ x: 'max-content' }}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无预算建议归因。等待周度影子复盘生成候选补丁，或先运行更多影子执行样本。"
                  />
                ),
              }}
            />
          </div>
          <Table
            columns={shadowOutcomeColumns}
            dataSource={shadowOutcomes?.items || []}
            rowKey="id"
            size="small"
            loading={shadowOutcomeLoading}
            pagination={{ pageSize: 6 }}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无可评估影子成交。运行影子执行后会记录成交价，再用最新行情和日线计算收益。"
                />
              ),
            }}
          />
          <div className="live-shadow-trend-panel">
            <div className="live-shadow-trend-head">
              <div>
                <Text type="secondary">趋势</Text>
                <strong>
                  {shadowTrend?.summary?.conclusion || '等待更多影子执行日志形成趋势。'}
                </strong>
              </div>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={shadowTrendLoading}
                onClick={() => fetchShadowTrend(false)}
              >
                刷新趋势
              </Button>
            </div>
            <div className="live-shadow-trend-chart">
              {shadowTrend?.points?.length ? (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={shadowTrend.points}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.08)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                    <RechartsTooltip
                      formatter={(value: any, name: string) => [
                        name.includes('limit') || name.includes('样本')
                          ? value
                          : `${Number(value || 0).toFixed(2)}%`,
                        name,
                      ]}
                    />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="avg_return_pct"
                      name="平均收益"
                      stroke="#1f8a70"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="win_rate_pct"
                      name="胜率"
                      stroke="#1f3a5f"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      yAxisId="right"
                      type="stepAfter"
                      dataKey="recommended_limit"
                      name="建议limit"
                      stroke="#d97706"
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无趋势点。等待定时影子执行或周度复盘产生执行日志。"
                />
              )}
            </div>
          </div>
        </Card>

        <Card
          className="modern-card"
          variant="borderless"
          title="实盘委托（活跃）"
          extra={
            <Button size="small" loading={liveOrdersLoading} onClick={() => fetchLiveOrders()}>
              刷新
            </Button>
          }
          style={{ marginBottom: 16 }}
        >
          <Table
            loading={liveOrdersLoading}
            dataSource={liveOrders}
            rowKey="id"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              {
                title: '标的',
                render: (_: any, r: any) => (
                  <Space direction="vertical" size={0}>
                    <Text strong>{r.name || r.symbol}</Text>
                    <Text type="secondary">{r.symbol}</Text>
                  </Space>
                ),
              },
              {
                title: '方向/数量',
                render: (_: any, r: any) => (
                  <Space direction="vertical" size={0}>
                    <Tag color={r.side === 'BUY' ? 'red' : 'green'}>
                      {r.side === 'BUY' ? '买入' : '卖出'}
                    </Tag>
                    <Text>{Number(r.quantity || 0).toLocaleString()} 股 @ ¥{Number(r.limit_price || 0).toFixed(2)}</Text>
                  </Space>
                ),
              },
              {
                title: '券商委托号',
                dataIndex: 'broker_order_id',
                render: (value: string) => (
                  <Text copyable={{ text: value || '' }}>{value || <Text type="secondary">未拿到</Text>}</Text>
                ),
              },
              {
                title: 'Bridge 状态',
                dataIndex: 'bridge_status',
                render: (value: string) => {
                  const map: Record<string, string> = {
                    pending: 'default',
                    dispatching: 'processing',
                    dispatched: 'processing',
                    submitted: 'gold',
                    partially_filled: 'cyan',
                    filled: 'green',
                    cancelled: 'orange',
                    failed: 'red',
                    expired: 'magenta',
                  };
                  return <Tag color={map[value || ''] || 'default'}>{value || '-'}</Tag>;
                },
              },
              {
                title: '提交时间',
                dataIndex: 'submitted_at',
                render: (value: string) =>
                  value ? new Date(value).toLocaleString() : <Text type="secondary">-</Text>,
              },
              {
                title: '操作',
                render: (_: any, r: any) => {
                  const cancellable = new Set([
                    'pending',
                    'dispatching',
                    'dispatched',
                    'submitted',
                    'partially_filled',
                  ]);
                  const status = String(r.bridge_status || '').toLowerCase();
                  const isCancelling = status === 'cancelling';
                  const disabled = !r.broker_order_id || isCancelling || !cancellable.has(status);
                  return (
                    <Button
                      size="small"
                      danger
                      loading={isCancelling}
                      onClick={() => cancelLiveOrder(r)}
                      disabled={disabled}
                      title={
                        isCancelling
                          ? '撤单请求处理中'
                          : !r.broker_order_id
                            ? '尚未拿到券商委托号，无法撤单'
                            : !cancellable.has(status)
                              ? `当前状态 ${status} 不可撤单`
                              : undefined
                      }
                    >
                      撤单
                    </Button>
                  );
                },
              },
            ]}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="当前账户暂无活跃实盘委托。"
                />
              ),
            }}
          />
        </Card>

        <Card className="modern-card" variant="borderless" title="实盘订单草稿">
          <Table
            columns={draftColumns}
            dataSource={overview?.order_drafts || []}
            rowKey="id"
            pagination={{ pageSize: 8 }}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无订单草稿。系统生成或手动创建后，会先停在这里等待确认。"
                />
              ),
            }}
          />
        </Card>
      </Spin>

      <Modal
        title="新建实盘订单草稿"
        open={isDraftModalOpen}
        onOk={createDraft}
        onCancel={() => setIsDraftModalOpen(false)}
        confirmLoading={draftLoading}
        okText="生成草稿"
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          message="只创建草稿，不会下单"
          description="订单会先经过基础风控。确认提交仍会被当前安全边界阻断，直到真实券商网关与实盘开关合规启用。"
        />
        <Form
          form={draftForm}
          layout="vertical"
          className="live-draft-form"
          initialValues={{ side: 'BUY', quantity: 100 }}
        >
          <Form.Item
            label="股票代码"
            name="symbol"
            rules={[{ required: true, message: '请输入股票代码' }]}
          >
            <Input placeholder="例如 600519.SH" />
          </Form.Item>
          <Form.Item label="方向" name="side" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio.Button value="BUY">买入</Radio.Button>
              <Radio.Button value="SELL">卖出</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                label="数量"
                name="quantity"
                rules={[{ required: true, message: '请输入数量' }]}
              >
                <InputNumber min={100} step={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="限价"
                name="limit_price"
                rules={[{ required: true, message: '请输入限价' }]}
              >
                <InputNumber min={0.01} step={0.01} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="理由" name="rationale">
            <Input.TextArea rows={3} placeholder="简短说明，不建议放大段分析" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="强确认实盘订单草稿"
        open={isConfirmModalOpen}
        onOk={approveDraft}
        onCancel={() => setIsConfirmModalOpen(false)}
        confirmLoading={draftLoading}
        okText="确认提交"
        okButtonProps={{
          danger: true,
          disabled: confirmText.trim() !== (selectedDraft?.confirm_text_required || CONFIRM_TEXT),
        }}
        destroyOnHidden
      >
        {selectedDraft && (
          <div className="live-confirm-modal">
            <Alert
              type={canSubmit ? 'warning' : 'error'}
              showIcon
              message={
                canSubmit
                  ? '实盘开关已启用，确认后将进入券商提交链路'
                  : '当前安全边界会阻断真实提交'
              }
              description="该弹窗用于验证强确认链路；默认环境不会真实下单。"
            />
            <div className="live-confirm-summary">
              <strong>
                {selectedDraft.side === 'BUY' ? '买入' : '卖出'}{' '}
                {selectedDraft.name || selectedDraft.symbol}
              </strong>
              <span>
                {Number(selectedDraft.quantity || 0).toLocaleString()} 股 · ¥
                {Number(selectedDraft.limit_price || 0).toFixed(2)} ·{' '}
                {formatMoney(selectedDraft.estimated_amount)}
              </span>
            </div>
            <div className="live-risk-checks">
              {riskChecks.map((item: any) => (
                <div key={item.key} className={item.passed ? 'passed' : 'failed'}>
                  {item.passed ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                  <span>{item.label}</span>
                  <em>{item.message}</em>
                </div>
              ))}
            </div>
            <Form layout="vertical">
              <Form.Item
                label={`请输入 ${selectedDraft.confirm_text_required || CONFIRM_TEXT}`}
                required
              >
                <Input
                  value={confirmText}
                  onChange={event => setConfirmText(event.target.value)}
                  placeholder={selectedDraft.confirm_text_required || CONFIRM_TEXT}
                />
              </Form.Item>
            </Form>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default LiveTrading;
