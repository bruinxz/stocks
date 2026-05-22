import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  Input,
  Select,
  InputNumber,
  Radio,
  message,
  Spin,
  Progress,
  Tooltip,
  Timeline,
} from 'antd';
import {
  AuditOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  ExperimentOutlined,
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
  WarningOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import {
  AreaChart,
  Area,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from 'recharts';
import api, { getPaperTradingSnapshots } from '../services/api';
import { marketService, Stock } from '../services/marketService';
import TradePolicyExplainPanel from '../components/trading/TradePolicyExplainPanel';

const CANARY_PREVIEW_AUTORUN_STORAGE_KEY = 'today_canary_preview_autorun';

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
  policy_explain?: any;
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
  policy_explain?: any;
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
    order_intent_feedback?: {
      evaluated_count: number;
      false_reject_count: number;
      saved_loss_count: number;
      avg_intended_action_return_pct: number;
      conclusion: string;
      rule_suggestions: Array<{
        key: string;
        label: string;
        action: 'loosen' | 'tighten' | 'keep' | 'observe';
        action_label: string;
        sample_count: number;
        false_reject_rate: number;
        saved_loss_rate: number;
        avg_intended_action_return_pct: number;
        reason: string;
      }>;
      stable_rule_suggestions?: OrderIntentStableRuleSuggestion[];
      parameter_adjustment_preview?: OrderIntentParameterPreview[];
      cache_hit_count?: number;
      cache_miss_count?: number;
      persisted_snapshot_count?: number;
      cache_mode?: string;
      tuning_preview_conclusion?: string;
    };
  };
  actions: TradingPlanAction[];
}

interface PaperTradingRiskProfile {
  generated_at: string;
  portfolio: {
    id: number;
    name: string;
    total_value: number;
    current_cash: number;
    initial_capital: number;
    position_value: number;
    cash_pct: number;
    exposure_pct: number;
    drawdown_pct: number;
    peak_total_value: number;
    open_position_count: number;
  } | null;
  status: {
    level: 'safe' | 'watch' | 'danger';
    label: string;
    conclusion: string;
  };
  limits: {
    min_cash_reserve_pct: number;
    max_portfolio_drawdown_pct: number;
    max_total_exposure_pct: number;
    max_industry_exposure_pct: number;
    max_position_correlation: number;
    max_portfolio_var_pct: number;
    max_single_stock_volatility_pct: number;
  };
  risk_metrics: {
    cash_pct: number;
    exposure_pct: number;
    drawdown_pct: number;
    max_industry_exposure_pct: number;
    max_strategy_exposure_pct: number;
    avg_volatility_20d_pct: number;
    max_volatility_20d_pct: number;
    max_pair_correlation: number;
    portfolio_var_proxy_pct: number;
  };
  top_industries: Array<{
    industry: string;
    market_value: number;
    exposure_pct: number;
    count: number;
  }>;
  top_strategies: Array<{
    strategy_key: string;
    exposure_pct: number;
    count: number;
  }>;
  position_risks: Array<{
    symbol: string;
    name?: string;
    industry: string;
    market_value: number;
    exposure_pct: number;
    volatility_20d_pct: number;
    max_correlation: number;
    strategy_keys: string[];
    risk_flags: string[];
  }>;
  warnings: string[];
  next_actions: string[];
}

interface PaperTradingOrderIntentItem {
  id: number;
  symbol: string;
  name?: string;
  side: 'BUY' | 'SELL';
  side_label?: string;
  status: 'planned' | 'executed' | 'rejected' | 'skipped' | 'held';
  status_label?: string;
  intent_date: string;
  reference_price?: number | null;
  execute_price?: number | null;
  quantity?: number | null;
  amount?: number | null;
  target_position_pct?: number | null;
  score?: number | null;
  reason_category?: string;
  reason_category_label?: string;
  reason_text?: string;
  compact_reason?: string;
  created_at?: string;
}

interface OrderIntentStableRuleSuggestion {
  key: string;
  label: string;
  action: 'loosen' | 'tighten' | 'keep' | 'observe';
  action_label: string;
  sample_count: number;
  false_reject_rate: number;
  saved_loss_rate: number;
  avg_intended_action_return_pct: number;
  reason: string;
  stability_state: 'stable' | 'forming' | 'unstable';
  stability_label: string;
  eligible_for_auto_tune: boolean;
  agreed_window_count: number;
  evidence_sample_count: number;
  stability_score: number;
  next_review_rule?: string;
  evidence_windows?: Array<{
    window_days: number;
    window_label: string;
    sample_count: number;
    action: string;
    action_label: string;
    avg_intended_action_return_pct: number;
    false_reject_rate: number;
    saved_loss_rate: number;
    sample_confidence: number;
  }>;
}

interface OrderIntentParameterPreview {
  reason_category: string;
  reason_category_label: string;
  action: 'loosen' | 'tighten' | 'keep' | 'observe';
  action_label: string;
  parameter_key: string;
  parameter_label: string;
  current_value: number | string;
  preview_value: number | string;
  unit: string;
  change_label: string;
  rationale: string;
  confidence: number;
  sample_count: number;
  apply_status: string;
  apply_status_label: string;
  evidence_source?: string;
  evidence_source_label?: string;
  family_consensus?: {
    action_label?: string;
    family_count: number;
    portfolio_names?: string[];
    evaluated_count: number;
    false_reject_count: number;
    saved_loss_count: number;
    avg_intended_action_return_pct: number;
    conclusion?: string;
  };
}

interface OrderIntentTuningTaskChange {
  id: number;
  name: string;
  type: string;
  changed_keys: string[];
  applied_previews: Array<OrderIntentParameterPreview & { before_value?: any; after_value?: any }>;
}

interface OrderIntentTuningApplyResult {
  dry_run: boolean;
  applied: boolean;
  canary?: boolean;
  message: string;
  preview_count: number;
  family_hindsight_preview_count?: number;
  selected_preview_count?: number;
  applied_count: number;
  generated_at?: string;
  tuning_preview_conclusion?: string;
  previews?: OrderIntentParameterPreview[];
  family_hindsight?: {
    generated_at?: string;
    thresholds?: {
      min_consensus_families?: number;
      min_evaluated_per_family?: number;
    };
    summary?: {
      evaluated_count?: number;
      false_reject_count?: number;
      saved_loss_count?: number;
      avg_intended_action_return_pct?: number;
      conclusion?: string;
    };
    candidate_count: number;
    candidates?: Array<{
      parameter_key: string;
      parameter_label: string;
      action: string;
      action_label: string;
      confidence: number;
      sample_count: number;
      change_label: string;
      reason_category_label: string;
      evidence_source_label?: string;
      family_consensus?: OrderIntentParameterPreview['family_consensus'];
    }>;
    conclusion?: string;
  };
  changes: OrderIntentTuningTaskChange[];
  canary_plan?: {
    enabled: boolean;
    max_parameters: number;
    observation_trades: number;
    observation_days: number;
    selected_parameter_keys: string[];
    selected_preview_count?: number;
    target_task_count?: number;
    evidence_sources?: string[];
    guardrails?: string[];
  };
  apply_mode?: 'preview' | 'manual_confirmed' | 'canary_preview' | 'canary';
}

interface OrderIntentTuningCandidatesResult {
  generated_at?: string;
  read_only: boolean;
  summary: {
    stable_window_candidate_count: number;
    family_hindsight_candidate_count: number;
    merged_candidate_count: number;
    canary_candidate_count: number;
    evidence_sources?: string[];
    conclusion: string;
  };
  family_hindsight?: OrderIntentTuningApplyResult['family_hindsight'];
  candidates: OrderIntentParameterPreview[];
  canary_candidates: OrderIntentParameterPreview[];
}

interface CanaryEvidenceFocus {
  title: string;
  source: 'preview' | 'readonly' | 'active';
  item?: any;
}

interface OrderIntentTuningCanaryStatus {
  active: boolean;
  generated_at?: string;
  audit?: any;
  canary?: {
    selected_parameter_keys?: string[];
    observation_trades?: number;
    observation_days?: number;
    target_task_count?: number;
    evidence_sources?: string[];
    guardrails?: string[];
  };
  observation?: {
    start_date?: string;
    elapsed_days: number;
    target_days: number;
    target_closed_trades: number;
    progress_pct: number;
    ready_for_review: boolean;
    outcome_tone: 'observing' | 'healthy' | 'risk' | 'mixed';
  };
  outcome_summary?: {
    closed_count: number;
    open_count: number;
    avg_excess_return_pct: number;
    avg_closed_return_pct: number;
    win_rate: number;
    profit_factor?: number;
    total_pnl: number;
    total_realized_pnl: number;
    total_unrealized_pnl: number;
  };
  review?: {
    action: 'promote' | 'rollback' | 'continue_observing' | 'hold';
    action_label: string;
    review_score: number;
    ready_for_review: boolean;
    ready_by_trades: boolean;
    ready_by_days: boolean;
    selected_parameter_keys: string[];
    metrics: {
      closed_count: number;
      open_count: number;
      avg_excess_return_pct: number;
      avg_closed_return_pct: number;
      avg_mae_pct?: number;
      worst_adverse_excursion_pct?: number;
      win_rate: number;
      profit_factor: number;
    };
    drawdown_guard?: {
      avg_mae_pct: number;
      avg_mae_limit_pct: number;
      worst_adverse_excursion_pct: number;
      worst_adverse_limit_pct: number;
      passed: boolean;
      conclusion: string;
    };
    reasons: string[];
    next_steps: string[];
  };
  rollback_plan?: {
    available: boolean;
    safety_state: 'ready' | 'manual_review' | 'no_change';
    safety_label: string;
    task_count: number;
    changed_key_count: number;
    rollback_key_count: number;
    changed_after_canary_count: number;
    conclusion: string;
    items?: Array<{
      task_id: number;
      task_name: string;
      task_type: string;
      parameters: Array<{
        key: string;
        before_value: any;
        canary_value: any;
        current_value: any;
        restore_value: any;
        needs_rollback: boolean;
        changed_after_canary: boolean;
      }>;
    }>;
  };
  attribution?: {
    start_date?: string;
    selected_parameter_keys: string[];
    task_count: number;
    closed_count: number;
    open_count: number;
    total_pnl: number;
    total_realized_pnl: number;
    total_unrealized_pnl: number;
    avg_closed_return_pct: number;
    avg_excess_return_pct: number;
    avg_mae_pct?: number;
    worst_adverse_excursion_pct?: number;
    win_rate: number;
    profit_factor: number;
    conclusion: string;
    winners: Array<{ id: number; symbol: string; name?: string; total_pnl_pct: number }>;
    losers: Array<{ id: number; symbol: string; name?: string; total_pnl_pct: number }>;
  };
  evidence?: {
    evidence_sources?: string[];
    evidence_source_labels?: string[];
    preview_count?: number;
    conclusion?: string;
    candidate_count_by_source?: Array<{ source: string; label: string; count: number }>;
    family_consensus_items?: Array<{
      parameter_key: string;
      parameter_label: string;
      action: string;
      action_label: string;
      confidence: number;
      sample_count: number;
      family_consensus?: OrderIntentParameterPreview['family_consensus'];
    }>;
  };
  summary?: {
    conclusion: string;
  };
}

interface CanaryReviewSnapshot {
  id: number;
  generated_at: string;
  snapshot_date: string;
  status: string;
  action?: 'promote' | 'rollback' | 'continue_observing' | 'hold' | string;
  action_label?: string;
  review_score?: number;
  ready_for_review: boolean;
  outcome_tone?: 'observing' | 'healthy' | 'risk' | 'mixed' | string;
  closed_count: number;
  open_count: number;
  avg_excess_return_pct?: number;
  avg_closed_return_pct?: number;
  avg_mae_pct?: number;
  worst_adverse_excursion_pct?: number;
  win_rate?: number;
  profit_factor?: number;
  total_pnl?: number;
  drawdown_guard_passed?: boolean;
  selected_parameter_keys?: string[];
  evidence_sources?: string[];
  review?: OrderIntentTuningCanaryStatus['review'];
  attribution?: OrderIntentTuningCanaryStatus['attribution'];
  evidence?: OrderIntentTuningCanaryStatus['evidence'];
}

interface CanaryReviewSnapshotTimeline {
  generated_at?: string;
  summary: {
    snapshot_count: number;
    latest_action?: string;
    latest_action_label?: string;
    latest_review_score?: number;
    promote_count: number;
    rollback_count: number;
    drawdown_blocked_count: number;
    avg_review_score: number;
    conclusion: string;
  };
  snapshots: CanaryReviewSnapshot[];
}

interface CanaryRollbackResult {
  dry_run: boolean;
  applied: boolean;
  can_apply: boolean;
  confirm_required?: boolean;
  message: string;
  confirm_text: string;
  blocked_reason?: string;
  applied_count: number;
  changes: Array<{
    task_id: number;
    task_name: string;
    task_type: string;
    changed_keys: string[];
    parameters: Array<{
      key: string;
      current_value: any;
      restore_value: any;
      changed_after_canary: boolean;
    }>;
  }>;
}

interface OrderIntentTrace {
  generated_at: string;
  intent: PaperTradingOrderIntentItem & { opportunity_outcome?: any; execution_reality?: any };
  signal?: {
    id: number;
    source_type: string;
    source_id: string;
    loop_run_id?: string;
    signal_date: string;
    normalized_decision: string;
    decision: string;
    confidence_score?: number | null;
    risk_level?: string;
    rationale?: string;
    current_price?: number | null;
    price_change_pct?: number | null;
    verification_status?: string;
    forward_returns?: Record<string, any>;
  } | null;
  opportunity_outcome?: any;
  peer_review?: {
    reason_category: string;
    reason_category_label: string;
    sample_count: number;
    hindsight?: any;
    matching_rule_suggestion?: any;
    stable_rule_suggestion?: OrderIntentStableRuleSuggestion | null;
    parameter_impact?: OrderIntentParameterPreview[];
  };
  timeline: Array<{
    stage: string;
    label: string;
    time?: string;
    status: string;
    summary: string;
    metric?: Record<string, any>;
  }>;
  conclusion: string;
}

interface PaperTradingOrderIntentDashboard {
  generated_at: string;
  portfolio?: PortfolioInfo | null;
  summary: {
    total: number;
    executed_count: number;
    rejected_count: number;
    skipped_count: number;
    planned_count: number;
    held_count: number;
    buy_count: number;
    sell_count: number;
    buy_rejected_count: number;
    sell_rejected_count: number;
    execution_reality_reject_count: number;
    intended_amount: number;
    executed_amount: number;
    execution_rate: number;
    conclusion: string;
    hindsight?: {
      evaluated_count: number;
      pending_count: number;
      benchmark_horizon: string;
      benchmark_count: number;
      false_reject_count: number;
      correct_reject_count: number;
      saved_loss_count: number;
      avg_intended_action_return_pct: number;
      conclusion: string;
      top_false_rejections: Array<{
        id: number;
        symbol: string;
        name?: string;
        side: 'BUY' | 'SELL';
        side_label?: string;
        status: string;
        reason_category_label?: string;
        intended_action_return_pct: number;
        raw_future_return_pct: number;
        horizon: string;
        conclusion: string;
      }>;
      rule_suggestions: Array<{
        key: string;
        label: string;
        action: 'loosen' | 'tighten' | 'keep' | 'observe';
        action_label: string;
        sample_count: number;
        false_reject_count: number;
        false_reject_rate: number;
        saved_loss_count: number;
        saved_loss_rate: number;
        avg_intended_action_return_pct: number;
        sample_confidence: number;
        reason: string;
      }>;
      rule_suggestion_windows?: Array<{
        window_days: number;
        window_label: string;
        start_date: string;
        sample_count: number;
        suggestions: Array<Record<string, any>>;
      }>;
      stable_rule_suggestions?: OrderIntentStableRuleSuggestion[];
      parameter_adjustment_preview?: OrderIntentParameterPreview[];
      cache_hit_count?: number;
      cache_miss_count?: number;
      would_persist_count?: number;
      persisted_snapshot_count?: number;
      persist_failed_count?: number;
      cache_mode?: string;
      tuning_preview_conclusion?: string;
    };
    top_reason_categories: Array<{
      key: string;
      label: string;
      count: number;
    }>;
  };
  intents: PaperTradingOrderIntentItem[];
  recent_rejections: PaperTradingOrderIntentItem[];
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
const formatShortDateTime = (value?: string | Date | null) => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
};
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
const riskProfileToneMap: Record<
  PaperTradingRiskProfile['status']['level'],
  { tag: string; accent: string; progress: string }
> = {
  safe: { tag: 'green', accent: '#008f6b', progress: '#008f6b' },
  watch: { tag: 'gold', accent: '#b7791f', progress: '#d6a64f' },
  danger: { tag: 'volcano', accent: '#d14343', progress: '#d14343' },
};
const orderIntentStatusColorMap: Record<string, string> = {
  executed: 'green',
  planned: 'blue',
  rejected: 'volcano',
  skipped: 'default',
  held: 'gold',
};
const orderRuleActionColorMap: Record<string, string> = {
  loosen: 'orange',
  tighten: 'green',
  keep: 'blue',
  observe: 'default',
};
const orderRuleStabilityColorMap: Record<string, string> = {
  stable: 'green',
  forming: 'gold',
  unstable: 'default',
};
const canaryReviewColorMap: Record<string, string> = {
  promote: 'green',
  rollback: 'red',
  continue_observing: 'gold',
  hold: 'blue',
};
const formatTuningValue = (value?: number | string | null, unit = '') => {
  if (value === undefined || value === null || value === '') return '--';
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (unit === '元') return `¥${numeric.toLocaleString()}`;
    if (unit === 'x') return `${numeric.toFixed(2)}x`;
    if (unit === '%' || unit === '分' || unit === '笔') return `${numeric.toLocaleString()}${unit}`;
  }
  return `${value}${unit}`;
};
const formatRollbackValue = (value: any) => {
  if (value === undefined) return '--';
  if (value === null) return '空';
  if (typeof value === 'number') return Number.isInteger(value) ? `${value}` : value.toFixed(2);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
const formatChartNumber = (value: any, suffix = '') => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '--';
  return `${parsed.toFixed(2)}${suffix}`;
};

const CANARY_ROLLBACK_CONFIRM_TEXT = 'CONFIRM_CANARY_ROLLBACK';

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
  const [tuningApplyLoading, setTuningApplyLoading] = useState(false);
  const [canaryPreviewLoading, setCanaryPreviewLoading] = useState(false);
  const [canaryApplyLoading, setCanaryApplyLoading] = useState(false);
  const [canaryRollbackLoading, setCanaryRollbackLoading] = useState(false);
  const [canaryRollbackPreview, setCanaryRollbackPreview] = useState<CanaryRollbackResult | null>(
    null
  );
  const [isCanaryRollbackModalOpen, setIsCanaryRollbackModalOpen] = useState(false);
  const [canaryRollbackConfirmText, setCanaryRollbackConfirmText] = useState('');
  const [tuningPreview, setTuningPreview] = useState<OrderIntentTuningApplyResult | null>(null);
  const [tuningCandidates, setTuningCandidates] =
    useState<OrderIntentTuningCandidatesResult | null>(null);
  const [tuningCandidatesLoading, setTuningCandidatesLoading] = useState(false);
  const [canaryStatus, setCanaryStatus] = useState<OrderIntentTuningCanaryStatus | null>(null);
  const [canaryStatusLoading, setCanaryStatusLoading] = useState(false);
  const [canarySnapshots, setCanarySnapshots] = useState<CanaryReviewSnapshotTimeline | null>(null);
  const [canarySnapshotsLoading, setCanarySnapshotsLoading] = useState(false);
  const [canaryEvidenceFocus, setCanaryEvidenceFocus] = useState<CanaryEvidenceFocus | null>(null);
  const canaryAutorunHandledRef = useRef(false);
  const [riskProfile, setRiskProfile] = useState<PaperTradingRiskProfile | null>(null);
  const [riskProfileLoading, setRiskProfileLoading] = useState(false);
  const [orderIntents, setOrderIntents] = useState<PaperTradingOrderIntentDashboard | null>(null);
  const [orderIntentsLoading, setOrderIntentsLoading] = useState(false);
  const [orderIntentTrace, setOrderIntentTrace] = useState<OrderIntentTrace | null>(null);
  const [orderIntentTraceLoading, setOrderIntentTraceLoading] = useState(false);
  const [isOrderIntentTraceVisible, setIsOrderIntentTraceVisible] = useState(false);

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
    fetchRiskProfile(true);
    fetchAttribution(true);
    fetchTradingPlan(true);
    fetchOrderIntents(true);
    fetchOrderIntentTuningCanary(true);
    fetchOrderIntentTuningCandidates(true);
    fetchOrderIntentTuningCanarySnapshots(true);
    try {
      const shouldAutorun =
        new URLSearchParams(window.location.search).get('canary_preview') === '1' ||
        window.sessionStorage.getItem(CANARY_PREVIEW_AUTORUN_STORAGE_KEY) === '1';
      if (shouldAutorun && !canaryAutorunHandledRef.current) {
        canaryAutorunHandledRef.current = true;
        window.sessionStorage.removeItem(CANARY_PREVIEW_AUTORUN_STORAGE_KEY);
        setTimeout(() => previewOrderIntentTuningCanary({ source: 'today_command_center' }), 500);
      }
    } catch {
      // 浏览器隐私模式下 sessionStorage 可能不可用；忽略自动预览即可。
    }
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

  const fetchRiskProfile = async (silent = false) => {
    setRiskProfileLoading(true);
    try {
      const response = await api.get('/paper-trading/risk-profile');
      if (response.data.success) {
        setRiskProfile(response.data.data);
        if (!silent) message.success('组合风险画像已刷新');
      }
    } catch (error: any) {
      if (!silent) message.error(error.response?.data?.message || '获取组合风险画像失败');
    } finally {
      setRiskProfileLoading(false);
    }
  };

  const fetchOrderIntents = async (silent = false) => {
    setOrderIntentsLoading(true);
    try {
      const response = await api.get('/paper-trading/order-intents', {
        params: {
          lookback_days: 30,
          limit: 80,
        },
      });
      if (response.data.success) {
        setOrderIntents(response.data.data);
        if (!silent) message.success('执行意图已刷新');
      }
    } catch (error: any) {
      if (!silent) message.error(error.response?.data?.message || '获取执行意图失败');
    } finally {
      setOrderIntentsLoading(false);
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
        await Promise.all([fetchPortfolio(), fetchRiskProfile(true)]); // 刷新持仓与组合风险
        fetchOrderIntents(true);
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

  const openOrderIntentTrace = async (intent: PaperTradingOrderIntentItem) => {
    setIsOrderIntentTraceVisible(true);
    setOrderIntentTraceLoading(true);
    setOrderIntentTrace(null);
    try {
      const response = await api.get(`/paper-trading/order-intents/${intent.id}/trace`, {
        params: { lookback_days: 30 },
      });
      if (response.data.success) {
        setOrderIntentTrace(response.data.data);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取拒单链路失败');
    } finally {
      setOrderIntentTraceLoading(false);
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

  const previewOrderIntentTuningApply = async () => {
    setTuningApplyLoading(true);
    try {
      const response = await api.post('/paper-trading/order-intent-tuning/apply', {
        dry_run: true,
      });
      const result = response.data.data as OrderIntentTuningApplyResult;
      setTuningPreview(result);
      if (result.changes?.length) {
        message.success(result.message || '调参预览已生成');
      } else {
        message.info(result.message || '当前没有可应用的调参预览');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '生成调参预览失败');
    } finally {
      setTuningApplyLoading(false);
    }
  };

  const fetchOrderIntentTuningCanary = async (silent = false) => {
    setCanaryStatusLoading(true);
    try {
      const response = await api.get('/paper-trading/order-intent-tuning/canary');
      if (response.data.success) {
        setCanaryStatus(response.data.data);
        if (!silent) message.success('Canary 状态已刷新');
      }
    } catch (error: any) {
      if (!silent) message.error(error.response?.data?.message || '获取 Canary 状态失败');
    } finally {
      setCanaryStatusLoading(false);
    }
  };

  const fetchOrderIntentTuningCandidates = async (silent = false) => {
    setTuningCandidatesLoading(true);
    try {
      const response = await api.get('/paper-trading/order-intent-tuning/candidates', {
        params: {
          use_family_hindsight: true,
          family_hindsight_lookback_days: 45,
          family_hindsight_min_consensus: 2,
          family_hindsight_min_evaluated: 5,
          canary_max_parameters: 1,
        },
      });
      if (response.data.success) {
        setTuningCandidates(response.data.data);
        if (!silent) message.success('只读调参候选已刷新');
      }
    } catch (error: any) {
      if (!silent) message.error(error.response?.data?.message || '获取只读调参候选失败');
    } finally {
      setTuningCandidatesLoading(false);
    }
  };

  const fetchOrderIntentTuningCanarySnapshots = async (silent = false) => {
    setCanarySnapshotsLoading(true);
    try {
      const response = await api.get('/paper-trading/order-intent-tuning/canary/snapshots', {
        params: { limit: 8 },
      });
      if (response.data.success) {
        setCanarySnapshots(response.data.data);
        if (!silent) message.success('Canary 快照已刷新');
      }
    } catch (error: any) {
      if (!silent) message.error(error.response?.data?.message || '获取 Canary 快照失败');
    } finally {
      setCanarySnapshotsLoading(false);
    }
  };

  const previewOrderIntentTuningCanary = async (options?: { source?: string }) => {
    setCanaryPreviewLoading(true);
    try {
      const response = await api.post('/paper-trading/order-intent-tuning/apply', {
        dry_run: true,
        canary: true,
        use_family_hindsight: true,
        family_hindsight_lookback_days: 45,
        family_hindsight_min_consensus: 2,
        family_hindsight_min_evaluated: 5,
        canary_max_parameters: 1,
        canary_observation_trades: 8,
        canary_observation_days: 10,
      });
      const result = response.data.data as OrderIntentTuningApplyResult;
      setTuningPreview(result);
      if (result.changes?.length) {
        message.success(
          options?.source === 'today_command_center'
            ? '已根据今日作战台首选候选生成 Canary 预览，确认后才会写入参数'
            : result.message || 'Canary 预览已生成'
        );
      } else {
        message.info(result.message || '当前没有可进入 Canary 的参数');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '生成 Canary 预览失败');
    } finally {
      setCanaryPreviewLoading(false);
    }
  };

  const confirmOrderIntentTuningCanary = () => {
    const targetPreview =
      tuningPreview?.canary && tuningPreview.changes?.length ? tuningPreview : null;
    if (!targetPreview?.changes?.length) {
      message.info('请先生成 Canary 预览');
      return;
    }
    Modal.confirm({
      title: '确认启动订单意图 Canary 调参',
      content:
        '该操作只会小流量写入少量参数并记录 Canary 审计，不会立即触发买卖。后续需要观察闭环交易样本和收益表现后再决定是否扩大。',
      okText: '启动 Canary',
      cancelText: '再看看',
      onOk: async () => {
        setCanaryApplyLoading(true);
        try {
          const response = await api.post('/paper-trading/order-intent-tuning/apply', {
            dry_run: false,
            canary: true,
            use_family_hindsight: true,
            family_hindsight_lookback_days: 45,
            family_hindsight_min_consensus: 2,
            family_hindsight_min_evaluated: 5,
            canary_max_parameters: 1,
            canary_observation_trades: targetPreview.canary_plan?.observation_trades || 8,
            canary_observation_days: targetPreview.canary_plan?.observation_days || 10,
            task_ids: targetPreview.changes.map(item => item.id),
            parameter_keys: targetPreview.canary_plan?.selected_parameter_keys?.length
              ? targetPreview.canary_plan.selected_parameter_keys
              : Array.from(new Set(targetPreview.changes.flatMap(item => item.changed_keys || []))),
          });
          const result = response.data.data as OrderIntentTuningApplyResult;
          setTuningPreview(result);
          message.success(result.message || 'Canary 调参已启动');
          await fetchOrderIntentTuningCanary(true);
          await fetchOrderIntentTuningCanarySnapshots(true);
          await fetchTradingPlan(true);
          await fetchOrderIntents(true);
        } catch (error: any) {
          message.error(error.response?.data?.message || '启动 Canary 失败');
        } finally {
          setCanaryApplyLoading(false);
        }
      },
    });
  };

  const previewCanaryRollback = async () => {
    setCanaryRollbackLoading(true);
    try {
      const response = await api.post('/paper-trading/order-intent-tuning/canary/rollback', {
        dry_run: true,
      });
      const result = response.data.data as CanaryRollbackResult;
      setCanaryRollbackPreview(result);
      setCanaryRollbackConfirmText('');
      if (result.changes?.length) {
        message.success(result.message || 'Canary 回滚预览已生成');
      } else {
        message.info(result.message || '当前没有可回滚参数');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '生成 Canary 回滚预览失败');
    } finally {
      setCanaryRollbackLoading(false);
    }
  };

  const openCanaryRollbackConfirm = () => {
    if (!canaryRollbackPreview?.changes?.length) {
      message.info('请先生成 Canary 回滚预览');
      return;
    }
    if (!canaryRollbackPreview.can_apply) {
      message.warning(canaryRollbackPreview.blocked_reason || '当前回滚预案不允许直接应用');
      return;
    }
    setCanaryRollbackConfirmText('');
    setIsCanaryRollbackModalOpen(true);
  };

  const confirmCanaryRollback = async () => {
    if (!canaryRollbackPreview?.changes?.length) {
      message.info('请先生成 Canary 回滚预览');
      return;
    }
    const expectedText = canaryRollbackPreview.confirm_text || CANARY_ROLLBACK_CONFIRM_TEXT;
    if (canaryRollbackConfirmText.trim() !== expectedText) {
      message.warning(`请输入 ${expectedText} 后再确认回滚`);
      return;
    }

    setCanaryRollbackLoading(true);
    try {
      const response = await api.post('/paper-trading/order-intent-tuning/canary/rollback', {
        dry_run: false,
        confirm: true,
        confirm_text: expectedText,
        task_ids: canaryRollbackPreview.changes.map(item => item.task_id),
        parameter_keys: Array.from(
          new Set(canaryRollbackPreview.changes.flatMap(item => item.changed_keys || []))
        ),
      });
      const result = response.data.data as CanaryRollbackResult;
      setCanaryRollbackPreview(result);
      setIsCanaryRollbackModalOpen(false);
      setCanaryRollbackConfirmText('');
      message.success(result.message || 'Canary 参数已回滚');
      await fetchOrderIntentTuningCanary(true);
      await fetchOrderIntentTuningCanarySnapshots(true);
      await fetchTradingPlan(true);
      await fetchOrderIntents(true);
    } catch (error: any) {
      message.error(error.response?.data?.message || '应用 Canary 回滚失败');
    } finally {
      setCanaryRollbackLoading(false);
    }
  };

  const confirmOrderIntentTuningApply = () => {
    if (!tuningPreview?.changes?.length) {
      message.info('没有可应用的参数变化');
      return;
    }
    Modal.confirm({
      title: '确认应用订单意图调参建议',
      content:
        '该操作只会更新自动跟单/交易计划定时任务的参数，并写入审计日志；不会立即触发买卖，也不会修改已有交易记录。',
      okText: '确认写入参数',
      cancelText: '再看看',
      onOk: async () => {
        setTuningApplyLoading(true);
        try {
          const response = await api.post('/paper-trading/order-intent-tuning/apply', {
            dry_run: false,
            task_ids: tuningPreview.changes.map(item => item.id),
            parameter_keys: Array.from(
              new Set(tuningPreview.changes.flatMap(item => item.changed_keys || []))
            ),
          });
          const result = response.data.data as OrderIntentTuningApplyResult;
          setTuningPreview(result);
          message.success(result.message || '订单意图调参建议已写入任务参数');
          await fetchTradingPlan(true);
          await fetchOrderIntents(true);
        } catch (error: any) {
          message.error(error.response?.data?.message || '应用调参建议失败');
        } finally {
          setTuningApplyLoading(false);
        }
      },
    });
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
          fetchRiskProfile(true),
          fetchAttribution(true),
          fetchTradingPlan(true),
          fetchOrderIntents(true),
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
  const planOrderIntentFeedback = tradingPlanSummary?.order_intent_feedback;
  const orderIntentSummary = orderIntents?.summary;
  const orderIntentHindsight = orderIntentSummary?.hindsight;
  const stableOrderRuleSuggestions = orderIntentHindsight?.stable_rule_suggestions || [];
  const autoTuneReadyRules = stableOrderRuleSuggestions.filter(item => item.eligible_for_auto_tune);
  const parameterAdjustmentPreview = orderIntentHindsight?.parameter_adjustment_preview || [];
  const recentOrderRejections = orderIntents?.recent_rejections || [];
  const orderIntentCacheTotal =
    Number(orderIntentHindsight?.cache_hit_count || 0) +
    Number(orderIntentHindsight?.cache_miss_count || 0);
  const orderIntentCacheHitRate =
    orderIntentCacheTotal > 0
      ? (Number(orderIntentHindsight?.cache_hit_count || 0) / orderIntentCacheTotal) * 100
      : 0;
  const canaryReview = canaryStatus?.review;
  const canaryRollback = canaryStatus?.rollback_plan;
  const canaryAttribution = canaryStatus?.attribution;
  const canaryEvidence = canaryStatus?.evidence;
  const canarySnapshotSummary = canarySnapshots?.summary;
  const recentCanarySnapshots = useMemo(
    () => canarySnapshots?.snapshots || [],
    [canarySnapshots?.snapshots]
  );
  const canarySnapshotTrend = useMemo(
    () =>
      [...recentCanarySnapshots]
        .sort(
          (a, b) =>
            new Date(a.generated_at || a.snapshot_date).getTime() -
            new Date(b.generated_at || b.snapshot_date).getTime()
        )
        .map(snapshot => ({
          id: snapshot.id,
          label: formatShortDateTime(snapshot.generated_at || snapshot.snapshot_date),
          review_score: Number(snapshot.review_score || 0),
          avg_excess_return_pct: Number(snapshot.avg_excess_return_pct || 0),
          win_rate: Number(snapshot.win_rate || 0),
          avg_mae_pct: Number(snapshot.avg_mae_pct || 0),
          drawdown_guard_score: snapshot.drawdown_guard_passed === false ? 0 : 100,
          closed_count: Number(snapshot.closed_count || 0),
          action_label: snapshot.action_label || snapshot.action || '观察',
        })),
    [recentCanarySnapshots]
  );
  const latestCanaryTrendPoint = canarySnapshotTrend[canarySnapshotTrend.length - 1];
  const focusedFamilyConsensus =
    canaryEvidenceFocus?.item?.family_consensus ||
    canaryEvidence?.family_consensus_items?.find(
      item => item.parameter_key === canaryEvidenceFocus?.item?.parameter_key
    )?.family_consensus;
  const activeCanaryEvidenceItems = canaryEvidence?.family_consensus_items || [];
  const activeCanaryEvidenceTags =
    canaryEvidence?.candidate_count_by_source || canaryEvidence?.evidence_source_labels || [];
  const riskTone = riskProfile ? riskProfileToneMap[riskProfile.status.level] : undefined;
  const topRiskPosition = riskProfile?.position_risks?.find(item => item.risk_flags.length > 0);
  const outcomeBlockedSegments = tradingPlanSummary?.outcome_blocked_segments || [];
  const urgentPlanActions = (tradingPlan?.actions || []).filter(action =>
    ['critical', 'high'].includes(action.priority)
  );
  const normalPlanActions = (tradingPlan?.actions || []).filter(action =>
    ['medium', 'low'].includes(action.priority)
  );
  const policyReplayItems = useMemo(
    () =>
      [...(attribution?.open_positions || []), ...(attribution?.closed_trades || [])]
        .filter(item => Boolean(item.policy_explain))
        .slice(0, 4),
    [attribution]
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

  const renderCanaryEvidenceButton = (
    title: string,
    source: CanaryEvidenceFocus['source'],
    item?: any
  ) => (
    <Button
      size="small"
      type="link"
      className="order-canary-evidence-link"
      onClick={() => setCanaryEvidenceFocus({ title, source, item })}
    >
      看证据
    </Button>
  );

  return (
    <div className="fade-in-up paper-trading-page">
      <div
        className="page-header-modern paper-trading-header"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <h1 className="page-title-modern">手动模拟交易</h1>
          <p className="page-subtitle-modern">
            与交易驾驶舱共用同一个模拟账户。这里保留手动买卖、交易计划和收益归因能力。
          </p>
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
              'radial-gradient(circle at 12% 18%, rgba(248,113,113,0.16), transparent 28%), linear-gradient(135deg, rgba(255,255,255,0.98), rgba(255,247,237,0.92))',
            border: '1px solid rgba(251,146,60,0.18)',
            boxShadow: '0 16px 42px rgba(124,45,18,0.08)',
          }}
        >
          <Row gutter={[18, 18]} align="middle">
            <Col xs={24} lg={7}>
              <Space direction="vertical" size={6}>
                <Tag color={riskResult.dry_run ? 'blue' : 'volcano'}>
                  {riskResult.dry_run ? '纸面风控预演' : '已执行模拟风控'}
                </Tag>
                <Text style={{ color: '#7c2d12', fontSize: 20, fontWeight: 900 }}>
                  风控交易台回执
                </Text>
                <Text style={{ color: 'rgba(124,45,18,0.72)' }}>
                  检查 {riskResult.checked} 个持仓，触发 {riskResult.exit_candidates} 个退出条件
                </Text>
              </Space>
            </Col>
            <Col xs={12} md={5} lg={4}>
              <Statistic
                title={<span style={{ color: 'rgba(124,45,18,0.66)' }}>退出/计划</span>}
                value={riskResult.dry_run ? riskResult.planned : riskResult.exited}
                suffix="笔"
                prefix={<ThunderboltOutlined />}
                valueStyle={{ color: '#c2410c' }}
              />
            </Col>
            <Col xs={12} md={5} lg={4}>
              <Statistic
                title={<span style={{ color: 'rgba(30,64,175,0.66)' }}>继续持有</span>}
                value={riskResult.held}
                suffix="只"
                prefix={<FieldTimeOutlined />}
                valueStyle={{ color: '#2563eb' }}
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
                <Text style={{ color: 'rgba(75,85,101,0.86)' }}>
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
        className="modern-card paper-order-intent-card"
        variant="borderless"
        loading={orderIntentsLoading && !orderIntents}
        style={{ marginBottom: 24 }}
      >
        <div className="paper-order-intent-header">
          <div>
            <Tag color="blue" icon={<SafetyCertificateOutlined />}>
              Order Intent Ledger
            </Tag>
            <h2>执行意图与拒单归因</h2>
            <p>
              这里不只看成交，也记录“为什么没买/没卖”。先看结论，再看最近被风控、行情或资金纪律拦下的标的。
            </p>
          </div>
          <Space wrap>
            <Tag className="modern-tag tag-info">近30天</Tag>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => fetchOrderIntents(false)}
              loading={orderIntentsLoading}
            >
              刷新意图
            </Button>
          </Space>
        </div>

        <Alert
          className="paper-order-intent-conclusion"
          type={
            (orderIntentSummary?.rejected_count || 0) + (orderIntentSummary?.skipped_count || 0) > 0
              ? 'warning'
              : 'info'
          }
          showIcon
          message={orderIntentSummary?.conclusion || '等待自动荐股或风控任务沉淀订单意图。'}
        />

        <Row gutter={[16, 16]} className="paper-order-intent-metrics">
          <Col xs={12} md={4}>
            <div className="order-intent-metric">
              <span>全部意图</span>
              <strong>{orderIntentSummary?.total || 0}</strong>
              <em>
                买 {orderIntentSummary?.buy_count || 0} / 卖 {orderIntentSummary?.sell_count || 0}
              </em>
            </div>
          </Col>
          <Col xs={12} md={4}>
            <div className="order-intent-metric">
              <span>已成交</span>
              <strong>{orderIntentSummary?.executed_count || 0}</strong>
              <em>成交率 {formatPercent(orderIntentSummary?.execution_rate)}</em>
            </div>
          </Col>
          <Col xs={12} md={4}>
            <div className="order-intent-metric">
              <span>未放行</span>
              <strong>
                {(orderIntentSummary?.rejected_count || 0) +
                  (orderIntentSummary?.skipped_count || 0)}
              </strong>
              <em>
                买 {orderIntentSummary?.buy_rejected_count || 0} / 卖{' '}
                {orderIntentSummary?.sell_rejected_count || 0}
              </em>
            </div>
          </Col>
          <Col xs={12} md={4}>
            <div className="order-intent-metric">
              <span>可调参规则</span>
              <strong>{autoTuneReadyRules.length}</strong>
              <em>稳定建议 {stableOrderRuleSuggestions.length}</em>
            </div>
          </Col>
          <Col xs={12} md={4}>
            <div className="order-intent-metric">
              <span>真实成交拦截</span>
              <strong>{orderIntentSummary?.execution_reality_reject_count || 0}</strong>
              <em>停牌/涨跌停/流动性</em>
            </div>
          </Col>
          <Col xs={12} md={4}>
            <div className="order-intent-metric">
              <span>调参预览</span>
              <strong>{parameterAdjustmentPreview.length}</strong>
              <em>仅预览不应用</em>
            </div>
          </Col>
        </Row>

        {orderIntentHindsight?.tuning_preview_conclusion && (
          <Alert
            className="order-tuning-conclusion"
            type={autoTuneReadyRules.length > 0 ? 'warning' : 'info'}
            showIcon
            icon={<AuditOutlined />}
            message={orderIntentHindsight.tuning_preview_conclusion}
            description="自动调参必须先经过稳定窗口和审计确认；当前页面只给出下一轮参数会如何变化，避免黑箱改规则。"
          />
        )}

        <Row gutter={[18, 18]} style={{ marginTop: 18 }}>
          <Col xs={24} lg={9}>
            <div className="order-intent-panel">
              <div className="order-intent-panel-title">主要原因</div>
              {(orderIntentSummary?.top_reason_categories || []).slice(0, 6).map(item => (
                <div className="order-reason-bar" key={item.key}>
                  <span>{item.label}</span>
                  <strong>{item.count}</strong>
                </div>
              ))}
              {(!orderIntentSummary?.top_reason_categories ||
                orderIntentSummary.top_reason_categories.length === 0) && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无原因分布" />
              )}
            </div>
          </Col>
          <Col xs={24} lg={8}>
            <div className="order-intent-panel">
              <div className="order-intent-panel-title">拒单后验复盘</div>
              {orderIntentHindsight ? (
                <>
                  <Alert
                    type={orderIntentHindsight.false_reject_count > 0 ? 'warning' : 'success'}
                    showIcon
                    message={orderIntentHindsight.conclusion}
                  />
                  <div className="order-hindsight-grid">
                    <div>
                      <span>可评估</span>
                      <strong>{orderIntentHindsight.evaluated_count}</strong>
                    </div>
                    <div>
                      <span>可能错杀</span>
                      <strong>{orderIntentHindsight.false_reject_count}</strong>
                    </div>
                    <div>
                      <span>拦截有效</span>
                      <strong>{orderIntentHindsight.saved_loss_count}</strong>
                    </div>
                    <div>
                      <span>平均相对</span>
                      <strong
                        style={{
                          color: pnlColor(orderIntentHindsight.avg_intended_action_return_pct),
                        }}
                      >
                        {formatPercent(orderIntentHindsight.avg_intended_action_return_pct)}
                      </strong>
                    </div>
                  </div>
                  <div className="order-hindsight-cache-strip">
                    <div>
                      <span>快照命中</span>
                      <strong>{formatPercent(orderIntentCacheHitRate)}</strong>
                    </div>
                    <div>
                      <span>缓存/计算</span>
                      <strong>
                        {orderIntentHindsight.cache_hit_count || 0}/
                        {orderIntentHindsight.cache_miss_count || 0}
                      </strong>
                    </div>
                    <div>
                      <span>本次模式</span>
                      <strong>
                        {orderIntentHindsight.cache_mode === 'persist'
                          ? '写入'
                          : orderIntentHindsight.cache_mode === 'dry_run'
                          ? '预演'
                          : '只读'}
                      </strong>
                    </div>
                  </div>
                  {(orderIntentHindsight.top_false_rejections || []).slice(0, 3).map(item => (
                    <div className="order-false-reject" key={item.id}>
                      <strong>
                        {item.name || item.symbol} · {item.side_label || item.side}
                      </strong>
                      <span>{item.conclusion}</span>
                    </div>
                  ))}
                  {(!orderIntentHindsight.top_false_rejections ||
                    orderIntentHindsight.top_false_rejections.length === 0) && (
                    <Text type="secondary">暂无明显错杀样本，当前拦截规则暂时有效。</Text>
                  )}
                  {(orderIntentHindsight.rule_suggestions || []).length > 0 && (
                    <div className="order-rule-suggestions">
                      <div className="order-rule-suggestion-title">规则建议</div>
                      {(orderIntentHindsight.rule_suggestions || []).slice(0, 4).map(item => (
                        <div className="order-rule-suggestion" key={item.key}>
                          <div>
                            <strong>{item.label}</strong>
                            <span>{item.reason}</span>
                          </div>
                          <Tag color={orderRuleActionColorMap[item.action] || 'default'}>
                            {item.action_label}
                          </Tag>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无后验复盘数据" />
              )}
            </div>
          </Col>
          <Col xs={24} lg={7}>
            <div className="order-intent-panel">
              <div className="order-intent-panel-title">最近未成交/跳过</div>
              {recentOrderRejections.length > 0 ? (
                <Timeline
                  className="order-intent-timeline"
                  items={recentOrderRejections.slice(0, 5).map(item => ({
                    color:
                      item.status === 'rejected'
                        ? 'red'
                        : item.status === 'skipped'
                        ? 'gray'
                        : 'blue',
                    children: (
                      <div className="order-intent-row">
                        <div>
                          <Space size={8} wrap>
                            <Text strong>
                              {item.name || item.symbol}（{item.symbol}）
                            </Text>
                            <Tag color={item.side === 'SELL' ? 'green' : 'red'}>
                              {item.side_label || item.side}
                            </Tag>
                            <Tag color={orderIntentStatusColorMap[item.status] || 'default'}>
                              {item.status_label || item.status}
                            </Tag>
                          </Space>
                          <p>{item.compact_reason || item.reason_text || '暂无原因说明'}</p>
                        </div>
                        <div className="order-intent-row-meta">
                          <Text>{formatMoney(item.amount)}</Text>
                          <span>
                            {item.reference_price
                              ? `参考价 ${Number(item.reference_price).toFixed(2)}`
                              : '无参考价'}
                          </span>
                          {item.score !== undefined && item.score !== null && (
                            <span>评分 {Number(item.score).toFixed(0)}</span>
                          )}
                          <Button
                            size="small"
                            type="link"
                            onClick={() => openOrderIntentTrace(item)}
                          >
                            看链路
                          </Button>
                        </div>
                      </div>
                    ),
                  }))}
                />
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无拒单/跳过记录，说明最近没有候选被拦截或自动任务尚未运行。"
                />
              )}
            </div>
          </Col>
        </Row>

        {(stableOrderRuleSuggestions.length > 0 || parameterAdjustmentPreview.length > 0) && (
          <Row gutter={[18, 18]} style={{ marginTop: 18 }}>
            <Col xs={24} lg={11}>
              <div className="order-intent-panel order-stability-panel">
                <div className="order-intent-panel-title">稳定窗口</div>
                {stableOrderRuleSuggestions.length > 0 ? (
                  <div className="order-stability-list">
                    {stableOrderRuleSuggestions.slice(0, 5).map(item => (
                      <div className="order-stability-item" key={item.key}>
                        <div className="order-stability-main">
                          <Space wrap size={8}>
                            <Text strong>{item.label}</Text>
                            <Tag color={orderRuleActionColorMap[item.action] || 'default'}>
                              {item.action_label}
                            </Tag>
                            <Tag
                              color={orderRuleStabilityColorMap[item.stability_state] || 'default'}
                            >
                              {item.stability_label}
                            </Tag>
                          </Space>
                          <p>{item.reason}</p>
                          <div className="order-window-evidence">
                            {(item.evidence_windows || []).slice(0, 3).map(window => (
                              <span key={`${item.key}-${window.window_days}`}>
                                {window.window_label} · {window.action_label} ·{' '}
                                {window.sample_count} 样本
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="order-stability-score">
                          <strong>{Math.round(Number(item.stability_score || 0))}</strong>
                          <span>稳定分</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无稳定规则建议" />
                )}
              </div>
            </Col>
            <Col xs={24} lg={13}>
              <div className="order-intent-panel order-parameter-preview-panel">
                <div className="order-panel-title-row">
                  <div className="order-intent-panel-title">参数调整预览</div>
                  <Space wrap size={8}>
                    <Tooltip title="先选择 1 个参数小流量观察，避免一次改太多导致收益归因不清">
                      <Button
                        size="small"
                        icon={<ExperimentOutlined />}
                        loading={canaryPreviewLoading}
                        onClick={() => previewOrderIntentTuningCanary()}
                      >
                        Canary预览
                      </Button>
                    </Tooltip>
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      loading={tuningCandidatesLoading}
                      onClick={() => fetchOrderIntentTuningCandidates(false)}
                    >
                      只读候选
                    </Button>
                    <Button
                      size="small"
                      type="default"
                      disabled={!tuningPreview?.canary || !tuningPreview?.changes?.length}
                      loading={canaryApplyLoading}
                      onClick={confirmOrderIntentTuningCanary}
                    >
                      启动Canary
                    </Button>
                    <Button
                      size="small"
                      icon={<AuditOutlined />}
                      loading={tuningApplyLoading}
                      onClick={previewOrderIntentTuningApply}
                    >
                      生成审计预览
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      disabled={!tuningPreview?.changes?.length}
                      loading={tuningApplyLoading}
                      onClick={confirmOrderIntentTuningApply}
                    >
                      写入任务参数
                    </Button>
                  </Space>
                </div>
                {tuningPreview && (
                  <Alert
                    className="order-tuning-audit-alert"
                    type={tuningPreview.changes?.length ? 'warning' : 'info'}
                    showIcon
                    message={tuningPreview.message}
                    description={
                      tuningPreview.changes?.length
                        ? tuningPreview.canary
                          ? `Canary 只选择 ${
                              tuningPreview.canary_plan?.selected_parameter_keys?.length || 0
                            } 个参数，观察 ${
                              tuningPreview.canary_plan?.observation_trades || 8
                            } 笔闭环或 ${
                              tuningPreview.canary_plan?.observation_days || 10
                            } 天后再扩大；多账户后验候选 ${
                              tuningPreview.family_hindsight_preview_count || 0
                            } 条。`
                          : `将影响 ${tuningPreview.changes.length} 个定时任务，确认后写入审计日志。`
                        : '没有可写入的参数变化。'
                    }
                  />
                )}
                {tuningPreview?.family_hindsight ? (
                  <div className="order-family-canary-evidence">
                    <div className="order-family-canary-head">
                      <div>
                        <span>FAMILY HINDSIGHT</span>
                        <strong>多账户后验 Canary 证据</strong>
                      </div>
                      <Tag
                        color={
                          tuningPreview.family_hindsight.candidate_count > 0 ? 'gold' : 'default'
                        }
                      >
                        候选 {tuningPreview.family_hindsight.candidate_count}
                      </Tag>
                    </div>
                    <p>{tuningPreview.family_hindsight.conclusion}</p>
                    <div className="order-family-canary-stats">
                      <div>
                        <span>评估样本</span>
                        <strong>
                          {tuningPreview.family_hindsight.summary?.evaluated_count || 0}
                        </strong>
                      </div>
                      <div>
                        <span>可能错杀</span>
                        <strong>
                          {tuningPreview.family_hindsight.summary?.false_reject_count || 0}
                        </strong>
                      </div>
                      <div>
                        <span>有效避险</span>
                        <strong>
                          {tuningPreview.family_hindsight.summary?.saved_loss_count || 0}
                        </strong>
                      </div>
                      <div>
                        <span>平均相对</span>
                        <strong
                          style={{
                            color: pnlColor(
                              tuningPreview.family_hindsight.summary?.avg_intended_action_return_pct
                            ),
                          }}
                        >
                          {formatPercent(
                            tuningPreview.family_hindsight.summary?.avg_intended_action_return_pct
                          )}
                        </strong>
                      </div>
                    </div>
                    {tuningPreview.family_hindsight.candidates?.length ? (
                      <div className="order-family-canary-candidates">
                        {tuningPreview.family_hindsight.candidates.slice(0, 4).map(item => (
                          <div key={`${item.parameter_key}-${item.action}`}>
                            <div className="order-family-candidate-title">
                              <Space wrap size={6}>
                                <Text strong>{item.parameter_label}</Text>
                                <Tag color={orderRuleActionColorMap[item.action] || 'default'}>
                                  {item.action_label}
                                </Tag>
                                <Tag color="blue">{item.evidence_source_label || '多账户后验'}</Tag>
                              </Space>
                              {renderCanaryEvidenceButton(
                                '多账户后验 Canary 证据',
                                'preview',
                                item
                              )}
                            </div>
                            <p>
                              {item.reason_category_label} · {item.change_label} ·{' '}
                              {item.family_consensus?.conclusion}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {tuningCandidates ? (
                  <div className="order-family-canary-evidence readonly">
                    <div className="order-family-canary-head">
                      <div>
                        <span>READONLY CANDIDATES</span>
                        <strong>只读调参候选雷达</strong>
                      </div>
                      <Space wrap size={6}>
                        <Tag color="blue">
                          合并 {tuningCandidates.summary.merged_candidate_count}
                        </Tag>
                        <Tag color="gold">
                          Canary {tuningCandidates.summary.canary_candidate_count}
                        </Tag>
                      </Space>
                    </div>
                    <p>{tuningCandidates.summary.conclusion}</p>
                    <div className="order-family-canary-stats">
                      <div>
                        <span>稳定窗口</span>
                        <strong>{tuningCandidates.summary.stable_window_candidate_count}</strong>
                      </div>
                      <div>
                        <span>多账户后验</span>
                        <strong>{tuningCandidates.summary.family_hindsight_candidate_count}</strong>
                      </div>
                      <div>
                        <span>合并候选</span>
                        <strong>{tuningCandidates.summary.merged_candidate_count}</strong>
                      </div>
                      <div>
                        <span>Canary首选</span>
                        <strong>{tuningCandidates.summary.canary_candidate_count}</strong>
                      </div>
                    </div>
                    {tuningCandidates.canary_candidates?.length ? (
                      <div className="order-family-canary-candidates">
                        {tuningCandidates.canary_candidates.slice(0, 3).map(item => (
                          <div key={`readonly-${item.parameter_key}-${item.action}`}>
                            <div className="order-family-candidate-title">
                              <Space wrap size={6}>
                                <Text strong>{item.parameter_label}</Text>
                                <Tag color={orderRuleActionColorMap[item.action] || 'default'}>
                                  {item.action_label}
                                </Tag>
                                <Tag
                                  color={
                                    item.evidence_source === 'family_hindsight' ? 'gold' : 'blue'
                                  }
                                >
                                  {item.evidence_source_label || '候选证据'}
                                </Tag>
                              </Space>
                              {renderCanaryEvidenceButton('只读 Canary 首选证据', 'readonly', item)}
                            </div>
                            <p>
                              {item.reason_category_label} · {item.change_label} ·{' '}
                              {item.family_consensus?.conclusion || item.rationale}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <Spin spinning={canaryStatusLoading}>
                  <div
                    className={`order-canary-card tone-${
                      canaryStatus?.observation?.outcome_tone || 'observing'
                    }`}
                  >
                    <div className="order-canary-head">
                      <div>
                        <Tag color={canaryStatus?.active ? 'gold' : 'default'}>Canary</Tag>
                        <strong>{canaryStatus?.active ? '小流量观察中' : '暂无小流量调参'}</strong>
                      </div>
                      <Button
                        size="small"
                        type="link"
                        icon={<ReloadOutlined />}
                        onClick={() => fetchOrderIntentTuningCanary(false)}
                      >
                        刷新
                      </Button>
                    </div>
                    <p>
                      {canaryStatus?.summary?.conclusion ||
                        '先生成 Canary 预览，再只写入少量参数，后续用真实模拟收益决定是否扩大。'}
                    </p>
                    {canaryStatus?.active && (
                      <>
                        <Progress
                          percent={Math.round(canaryStatus.observation?.progress_pct || 0)}
                          size="small"
                          showInfo={false}
                          strokeColor={
                            canaryStatus.observation?.outcome_tone === 'risk'
                              ? '#d14343'
                              : canaryStatus.observation?.outcome_tone === 'healthy'
                              ? '#008f6b'
                              : '#d6a64f'
                          }
                        />
                        <div className="order-canary-metrics">
                          <span>
                            闭环 {canaryStatus.outcome_summary?.closed_count || 0}/
                            {canaryStatus.observation?.target_closed_trades || 8}
                          </span>
                          <span>
                            超额{' '}
                            {formatPercent(canaryStatus.outcome_summary?.avg_excess_return_pct)}
                          </span>
                          <span>胜率 {formatPercent(canaryStatus.outcome_summary?.win_rate)}</span>
                        </div>
                        <Space wrap size={6} className="order-canary-keys">
                          {(canaryStatus.canary?.selected_parameter_keys || []).map(key => (
                            <Tag key={key} color="gold">
                              {key}
                            </Tag>
                          ))}
                        </Space>
                        {canaryEvidence ? (
                          <div className="order-canary-evidence-strip">
                            <div className="order-canary-evidence-strip-head">
                              <div>
                                <span>证据来源</span>
                                <strong>
                                  {canaryEvidence.evidence_source_labels?.join(' + ') || '审计记录'}
                                </strong>
                              </div>
                              {renderCanaryEvidenceButton('当前 Canary 证据链', 'active')}
                            </div>
                            <p>{canaryEvidence.conclusion}</p>
                            <Space wrap size={6}>
                              {(canaryEvidence.candidate_count_by_source || []).map(item => (
                                <Tag
                                  key={item.source}
                                  color={item.source === 'family_hindsight' ? 'gold' : 'blue'}
                                >
                                  {item.label} {item.count}
                                </Tag>
                              ))}
                            </Space>
                          </div>
                        ) : null}
                        {canaryReview && (
                          <div className="order-canary-review">
                            <div className="order-canary-review-head">
                              <Tag color={canaryReviewColorMap[canaryReview.action] || 'default'}>
                                {canaryReview.action_label}
                              </Tag>
                              <strong>评审分 {canaryReview.review_score}</strong>
                              <span>
                                {canaryReview.ready_for_review ? '已到复核窗口' : '样本未满'}
                              </span>
                            </div>
                            <div className="order-canary-review-reasons">
                              {(canaryReview.reasons || []).slice(0, 2).map(reason => (
                                <span key={reason}>{reason}</span>
                              ))}
                            </div>
                            <div className="order-canary-next">
                              {(canaryReview.next_steps || []).slice(0, 2).map(step => (
                                <em key={step}>{step}</em>
                              ))}
                            </div>
                            {canaryReview.drawdown_guard ? (
                              <div className="order-canary-drawdown-guard">
                                <Tag color={canaryReview.drawdown_guard.passed ? 'green' : 'red'}>
                                  {canaryReview.drawdown_guard.passed ? '回撤通过' : '回撤拦截'}
                                </Tag>
                                <span>{canaryReview.drawdown_guard.conclusion}</span>
                              </div>
                            ) : null}
                          </div>
                        )}
                        {(canaryAttribution || canaryRollback) && (
                          <div className="order-canary-detail-grid">
                            {canaryAttribution && (
                              <div className="order-canary-detail-card">
                                <div className="order-canary-detail-title">收益归因</div>
                                <strong
                                  style={{
                                    color: pnlColor(canaryAttribution.avg_excess_return_pct),
                                  }}
                                >
                                  {formatPercent(canaryAttribution.avg_excess_return_pct)}
                                </strong>
                                <span>
                                  闭环 {canaryAttribution.closed_count} 笔 · 胜率{' '}
                                  {formatPercent(canaryAttribution.win_rate)}
                                </span>
                                <p>{canaryAttribution.conclusion}</p>
                                <div className="order-canary-mini-list">
                                  {(canaryAttribution.winners || []).slice(0, 2).map(item => (
                                    <em key={`winner-${item.id}`}>
                                      贡献 {item.name || item.symbol}{' '}
                                      {formatPercent(item.total_pnl_pct)}
                                    </em>
                                  ))}
                                  {(canaryAttribution.losers || []).slice(0, 1).map(item => (
                                    <em key={`loser-${item.id}`}>
                                      拖累 {item.name || item.symbol}{' '}
                                      {formatPercent(item.total_pnl_pct)}
                                    </em>
                                  ))}
                                </div>
                              </div>
                            )}
                            {canaryRollback && (
                              <div className="order-canary-detail-card">
                                <div className="order-canary-detail-title-row">
                                  <div className="order-canary-detail-title">回滚预案</div>
                                  <Space wrap size={6}>
                                    <Button
                                      size="small"
                                      type="link"
                                      loading={canaryRollbackLoading}
                                      onClick={previewCanaryRollback}
                                    >
                                      回滚预览
                                    </Button>
                                    <Button
                                      size="small"
                                      danger
                                      disabled={
                                        !canaryRollbackPreview?.changes?.length ||
                                        !canaryRollbackPreview.can_apply
                                      }
                                      loading={canaryRollbackLoading}
                                      onClick={openCanaryRollbackConfirm}
                                    >
                                      确认回滚
                                    </Button>
                                  </Space>
                                </div>
                                <strong>{canaryRollback.safety_label}</strong>
                                <span>
                                  {canaryRollback.task_count} 个任务 ·{' '}
                                  {canaryRollback.rollback_key_count} 个参数
                                </span>
                                <p>{canaryRollback.conclusion}</p>
                                {canaryRollbackPreview && (
                                  <div className="order-canary-rollback-preview">
                                    <div className="order-canary-rollback-preview-head">
                                      <Tag
                                        color={canaryRollbackPreview.can_apply ? 'green' : 'orange'}
                                      >
                                        {canaryRollbackPreview.can_apply ? '可回滚' : '需复核'}
                                      </Tag>
                                      <span>{canaryRollbackPreview.message}</span>
                                    </div>
                                    {canaryRollbackPreview.blocked_reason && (
                                      <em>{canaryRollbackPreview.blocked_reason}</em>
                                    )}
                                    <div className="order-canary-mini-list">
                                      {(canaryRollbackPreview.changes || [])
                                        .slice(0, 2)
                                        .map(change => (
                                          <em key={`rollback-${change.task_id}`}>
                                            {change.task_name} · {change.changed_keys.join('、')}
                                          </em>
                                        ))}
                                    </div>
                                  </div>
                                )}
                                <Space wrap size={6}>
                                  {(canaryRollback.items || [])
                                    .flatMap(item => item.parameters || [])
                                    .slice(0, 4)
                                    .map(item => (
                                      <Tag
                                        key={`${item.key}-${String(item.restore_value)}`}
                                        color={item.changed_after_canary ? 'red' : 'blue'}
                                      >
                                        {item.key}
                                      </Tag>
                                    ))}
                                </Space>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </Spin>
                <Spin spinning={canarySnapshotsLoading}>
                  <div className="order-canary-snapshots">
                    <div className="order-canary-snapshots-head">
                      <div>
                        <span>REVIEW MEMORY</span>
                        <strong>Canary评审快照</strong>
                      </div>
                      <Button
                        size="small"
                        type="link"
                        icon={<HistoryOutlined />}
                        onClick={() => fetchOrderIntentTuningCanarySnapshots(false)}
                      >
                        刷新快照
                      </Button>
                    </div>
                    <p>
                      {canarySnapshotSummary?.conclusion ||
                        '每次刷新 Canary 状态都会沉淀一条评审快照，后续用于复盘参数是否真的提高收益。'}
                    </p>
                    {canarySnapshotSummary ? (
                      <div className="order-canary-snapshot-metrics">
                        <div>
                          <span>快照</span>
                          <strong>{canarySnapshotSummary.snapshot_count}</strong>
                        </div>
                        <div>
                          <span>均分</span>
                          <strong>
                            {Number(canarySnapshotSummary.avg_review_score || 0).toFixed(1)}
                          </strong>
                        </div>
                        <div>
                          <span>扩大/回滚</span>
                          <strong>
                            {canarySnapshotSummary.promote_count}/
                            {canarySnapshotSummary.rollback_count}
                          </strong>
                        </div>
                        <div>
                          <span>回撤拦截</span>
                          <strong>{canarySnapshotSummary.drawdown_blocked_count}</strong>
                        </div>
                      </div>
                    ) : null}
                    {recentCanarySnapshots.length > 0 ? (
                      <>
                        {canarySnapshotTrend.length > 1 ? (
                          <div className="order-canary-snapshot-trend">
                            <div className="order-canary-snapshot-trend-head">
                              <div>
                                <span>TREND</span>
                                <strong>评审趋势</strong>
                              </div>
                              <Space wrap size={6}>
                                <Tag color="blue">
                                  最新评分 {formatChartNumber(latestCanaryTrendPoint?.review_score)}
                                </Tag>
                                <Tag
                                  color={
                                    latestCanaryTrendPoint?.drawdown_guard_score ? 'green' : 'red'
                                  }
                                >
                                  {latestCanaryTrendPoint?.drawdown_guard_score
                                    ? '回撤OK'
                                    : '回撤拦截'}
                                </Tag>
                              </Space>
                            </div>
                            <div className="order-canary-snapshot-chart">
                              <ResponsiveContainer width="100%" height="100%">
                                <ComposedChart data={canarySnapshotTrend}>
                                  <CartesianGrid
                                    strokeDasharray="3 3"
                                    stroke="rgba(100, 116, 139, 0.18)"
                                  />
                                  <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={18} />
                                  <YAxis yAxisId="left" tick={{ fontSize: 11 }} width={34} />
                                  <YAxis
                                    yAxisId="right"
                                    orientation="right"
                                    tick={{ fontSize: 11 }}
                                    width={34}
                                  />
                                  <RechartsTooltip
                                    formatter={(value: any, name: any) => {
                                      const labelMap: Record<string, string> = {
                                        review_score: '评审分',
                                        avg_excess_return_pct: '超额收益',
                                        win_rate: '胜率',
                                        avg_mae_pct: '平均回撤',
                                        drawdown_guard_score: '回撤守门',
                                      };
                                      const suffix =
                                        name === 'review_score' || name === 'drawdown_guard_score'
                                          ? ''
                                          : '%';
                                      return [
                                        formatChartNumber(value, suffix),
                                        labelMap[name] || name,
                                      ];
                                    }}
                                    labelFormatter={label => `快照 ${label}`}
                                  />
                                  <Area
                                    yAxisId="left"
                                    type="monotone"
                                    dataKey="review_score"
                                    name="review_score"
                                    fill="rgba(39, 100, 184, 0.13)"
                                    stroke="#2764b8"
                                    strokeWidth={2.2}
                                    dot={false}
                                  />
                                  <Line
                                    yAxisId="right"
                                    type="monotone"
                                    dataKey="avg_excess_return_pct"
                                    name="avg_excess_return_pct"
                                    stroke="#cf1322"
                                    strokeWidth={2.1}
                                    dot={{ r: 2 }}
                                  />
                                  <Line
                                    yAxisId="right"
                                    type="monotone"
                                    dataKey="win_rate"
                                    name="win_rate"
                                    stroke="#0f8f83"
                                    strokeDasharray="4 4"
                                    strokeWidth={1.9}
                                    dot={false}
                                  />
                                  <Line
                                    yAxisId="right"
                                    type="monotone"
                                    dataKey="avg_mae_pct"
                                    name="avg_mae_pct"
                                    stroke="#d6a64f"
                                    strokeDasharray="2 4"
                                    strokeWidth={1.9}
                                    dot={false}
                                  />
                                </ComposedChart>
                              </ResponsiveContainer>
                            </div>
                            <div className="order-canary-snapshot-legend">
                              <span className="score">评审分</span>
                              <span className="excess">超额收益</span>
                              <span className="win">胜率</span>
                              <span className="drawdown">平均回撤</span>
                            </div>
                          </div>
                        ) : null}
                        <div className="order-canary-snapshot-list">
                          {recentCanarySnapshots.slice(0, 5).map(snapshot => (
                            <div className="order-canary-snapshot-item" key={snapshot.id}>
                              <div className="order-canary-snapshot-ribbon">
                                <Tag
                                  color={canaryReviewColorMap[snapshot.action || ''] || 'default'}
                                >
                                  {snapshot.action_label || snapshot.action || '观察'}
                                </Tag>
                                <span>{formatShortDateTime(snapshot.generated_at)}</span>
                              </div>
                              <div className="order-canary-snapshot-body">
                                <strong>{Number(snapshot.review_score || 0).toFixed(1)}</strong>
                                <div>
                                  <span>
                                    闭环 {snapshot.closed_count || 0} · 超额{' '}
                                    {formatPercent(snapshot.avg_excess_return_pct)}
                                  </span>
                                  <span>
                                    胜率 {formatPercent(snapshot.win_rate)} · 回撤{' '}
                                    {formatPercent(snapshot.avg_mae_pct)}
                                  </span>
                                </div>
                              </div>
                              <Space wrap size={6}>
                                {(snapshot.selected_parameter_keys || []).slice(0, 4).map(key => (
                                  <Tag key={`${snapshot.id}-${key}`} color="gold">
                                    {key}
                                  </Tag>
                                ))}
                                <Tag
                                  color={snapshot.drawdown_guard_passed === false ? 'red' : 'green'}
                                >
                                  {snapshot.drawdown_guard_passed === false ? '回撤拦截' : '回撤OK'}
                                </Tag>
                              </Space>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="暂无评审快照，刷新 Canary 状态后会自动生成。"
                      />
                    )}
                  </div>
                </Spin>
                {tuningPreview?.changes?.length ? (
                  <div className="order-tuning-audit-list">
                    {tuningPreview.changes.slice(0, 3).map(change => (
                      <div className="order-tuning-audit-item" key={change.id}>
                        <Text strong>{change.name}</Text>
                        <Space wrap size={6}>
                          {change.changed_keys.slice(0, 4).map(key => (
                            <Tag key={`${change.id}-${key}`} color="blue">
                              {key}
                            </Tag>
                          ))}
                        </Space>
                      </div>
                    ))}
                  </div>
                ) : null}
                {parameterAdjustmentPreview.length > 0 ? (
                  <div className="order-parameter-preview-list">
                    {parameterAdjustmentPreview.slice(0, 6).map(item => (
                      <div
                        className="order-parameter-preview-item"
                        key={`${item.reason_category}-${item.parameter_key}-${item.action}`}
                      >
                        <div>
                          <Space wrap size={8}>
                            <Text strong>{item.parameter_label}</Text>
                            <Tag color={orderRuleActionColorMap[item.action] || 'default'}>
                              {item.action_label}
                            </Tag>
                            {item.evidence_source_label ? (
                              <Tag
                                color={
                                  item.evidence_source === 'family_hindsight' ? 'gold' : 'blue'
                                }
                              >
                                {item.evidence_source_label}
                              </Tag>
                            ) : null}
                            <Tag color="default">{item.apply_status_label}</Tag>
                          </Space>
                          <p>
                            {item.rationale}
                            {item.family_consensus?.conclusion
                              ? ` ${item.family_consensus.conclusion}`
                              : ''}
                          </p>
                        </div>
                        <div className="order-parameter-change">
                          <span>{formatTuningValue(item.current_value, item.unit)}</span>
                          <em>→</em>
                          <strong>{formatTuningValue(item.preview_value, item.unit)}</strong>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="还没有通过稳定窗口的参数预览"
                  />
                )}
              </div>
            </Col>
          </Row>
        )}
      </Card>

      <Card
        className={`modern-card paper-risk-profile-card risk-${
          riskProfile?.status.level || 'safe'
        }`}
        variant="borderless"
        loading={riskProfileLoading && !riskProfile}
        style={{ marginBottom: 24 }}
      >
        {riskProfile && riskTone ? (
          <>
            <div className="paper-risk-profile-header">
              <div>
                <Tag color={riskTone.tag} icon={<SafetyCertificateOutlined />}>
                  Portfolio Guard
                </Tag>
                <h2 style={{ color: riskTone.accent }}>{riskProfile.status.label}</h2>
                <p>{riskProfile.status.conclusion}</p>
              </div>
              <Space wrap>
                <Tag className="modern-tag tag-info">
                  持仓 {riskProfile.portfolio?.open_position_count || 0} 只
                </Tag>
                <Button
                  icon={<ReloadOutlined />}
                  onClick={() => fetchRiskProfile(false)}
                  loading={riskProfileLoading}
                >
                  刷新画像
                </Button>
              </Space>
            </div>

            <Row gutter={[14, 14]} className="paper-risk-profile-grid">
              <Col xs={12} md={4}>
                <div className="paper-risk-metric">
                  <span>现金水位</span>
                  <strong>{formatPercent(riskProfile.risk_metrics.cash_pct)}</strong>
                  <Progress
                    percent={clampPercent(riskProfile.risk_metrics.cash_pct)}
                    size="small"
                    showInfo={false}
                    strokeColor={riskTone.progress}
                  />
                  <em>底线 {riskProfile.limits.min_cash_reserve_pct}%</em>
                </div>
              </Col>
              <Col xs={12} md={4}>
                <div className="paper-risk-metric">
                  <span>总仓位</span>
                  <strong>{formatPercent(riskProfile.risk_metrics.exposure_pct)}</strong>
                  <Progress
                    percent={clampPercent(
                      (riskProfile.risk_metrics.exposure_pct /
                        riskProfile.limits.max_total_exposure_pct) *
                        100
                    )}
                    size="small"
                    showInfo={false}
                    strokeColor={riskTone.progress}
                  />
                  <em>上限 {riskProfile.limits.max_total_exposure_pct}%</em>
                </div>
              </Col>
              <Col xs={12} md={4}>
                <div className="paper-risk-metric">
                  <span>组合回撤</span>
                  <strong>{formatPercent(Math.abs(riskProfile.risk_metrics.drawdown_pct))}</strong>
                  <Progress
                    percent={clampPercent(
                      (Math.abs(riskProfile.risk_metrics.drawdown_pct) /
                        riskProfile.limits.max_portfolio_drawdown_pct) *
                        100
                    )}
                    size="small"
                    showInfo={false}
                    strokeColor={riskTone.progress}
                  />
                  <em>上限 {riskProfile.limits.max_portfolio_drawdown_pct}%</em>
                </div>
              </Col>
              <Col xs={12} md={4}>
                <div className="paper-risk-metric">
                  <span>行业集中</span>
                  <strong>
                    {formatPercent(riskProfile.risk_metrics.max_industry_exposure_pct)}
                  </strong>
                  <Progress
                    percent={clampPercent(
                      (riskProfile.risk_metrics.max_industry_exposure_pct /
                        riskProfile.limits.max_industry_exposure_pct) *
                        100
                    )}
                    size="small"
                    showInfo={false}
                    strokeColor={riskTone.progress}
                  />
                  <em>{riskProfile.top_industries?.[0]?.industry || '暂无行业'}</em>
                </div>
              </Col>
              <Col xs={12} md={4}>
                <div className="paper-risk-metric">
                  <span>最高相关</span>
                  <strong>
                    {formatPercent((riskProfile.risk_metrics.max_pair_correlation || 0) * 100)}
                  </strong>
                  <Progress
                    percent={clampPercent(
                      ((riskProfile.risk_metrics.max_pair_correlation || 0) /
                        riskProfile.limits.max_position_correlation) *
                        100
                    )}
                    size="small"
                    showInfo={false}
                    strokeColor={riskTone.progress}
                  />
                  <em>上限 {formatPercent(riskProfile.limits.max_position_correlation * 100)}</em>
                </div>
              </Col>
              <Col xs={12} md={4}>
                <div className="paper-risk-metric">
                  <span>VaR 代理</span>
                  <strong>{formatPercent(riskProfile.risk_metrics.portfolio_var_proxy_pct)}</strong>
                  <Progress
                    percent={clampPercent(
                      (riskProfile.risk_metrics.portfolio_var_proxy_pct /
                        riskProfile.limits.max_portfolio_var_pct) *
                        100
                    )}
                    size="small"
                    showInfo={false}
                    strokeColor={riskTone.progress}
                  />
                  <em>上限 {riskProfile.limits.max_portfolio_var_pct}%</em>
                </div>
              </Col>
            </Row>

            <Row gutter={[18, 18]} style={{ marginTop: 16 }}>
              <Col xs={24} lg={8}>
                <div className="paper-risk-panel">
                  <div className="paper-risk-panel-title">集中度提醒</div>
                  <div className="paper-risk-strip">
                    <span>行业</span>
                    <strong>
                      {riskProfile.top_industries?.[0]
                        ? `${riskProfile.top_industries[0].industry} · ${formatPercent(
                            riskProfile.top_industries[0].exposure_pct
                          )}`
                        : '暂无行业暴露'}
                    </strong>
                  </div>
                  <div className="paper-risk-strip">
                    <span>策略</span>
                    <strong>
                      {riskProfile.top_strategies?.[0]
                        ? `${riskProfile.top_strategies[0].strategy_key} · ${formatPercent(
                            riskProfile.top_strategies[0].exposure_pct
                          )}`
                        : '暂无策略归因'}
                    </strong>
                  </div>
                </div>
              </Col>
              <Col xs={24} lg={8}>
                <div className="paper-risk-panel">
                  <div className="paper-risk-panel-title">下一步只看这个</div>
                  {(riskProfile.next_actions || []).slice(0, 3).map((item, index) => (
                    <div className="paper-risk-action" key={`risk-next-${index}`}>
                      {item}
                    </div>
                  ))}
                  {(!riskProfile.next_actions || riskProfile.next_actions.length === 0) && (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无额外动作" />
                  )}
                </div>
              </Col>
              <Col xs={24} lg={8}>
                <div className="paper-risk-panel">
                  <div className="paper-risk-panel-title">重点观察</div>
                  {topRiskPosition ? (
                    <>
                      <div className="paper-risk-focus-name">
                        {topRiskPosition.name || topRiskPosition.symbol}
                        <Text type="secondary">（{topRiskPosition.symbol}）</Text>
                      </div>
                      <p>{topRiskPosition.risk_flags[0]}</p>
                      <Space wrap>
                        <Tag>{topRiskPosition.industry}</Tag>
                        <Tag>波动 {formatPercent(topRiskPosition.volatility_20d_pct)}</Tag>
                        <Tag>
                          相关 {formatPercent((topRiskPosition.max_correlation || 0) * 100)}
                        </Tag>
                      </Space>
                    </>
                  ) : (
                    <div className="paper-risk-action calm">
                      暂无单票越线风险，继续保持分散和小仓跟踪。
                    </div>
                  )}
                </div>
              </Col>
            </Row>

            {riskProfile.warnings?.length > 0 && (
              <Alert
                className="paper-risk-alert"
                type={riskProfile.status.level === 'danger' ? 'warning' : 'info'}
                showIcon
                message="风险提示"
                description={
                  <Space wrap>
                    {riskProfile.warnings.slice(0, 4).map((item, index) => (
                      <Tag key={`warning-${index}`} color={riskTone.tag}>
                        {item}
                      </Tag>
                    ))}
                  </Space>
                }
              />
            )}
          </>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无组合风险画像" />
        )}
      </Card>

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

        {planOrderIntentFeedback && (
          <Alert
            className="outcome-feedback-alert order-feedback-alert"
            type={planOrderIntentFeedback.false_reject_count > 0 ? 'warning' : 'info'}
            showIcon
            message="拒单后验已进入下一轮计划建议"
            description={
              <div className="plan-order-feedback">
                <p>{planOrderIntentFeedback.conclusion}</p>
                <Space wrap>
                  <Tag color="orange">可能错杀 {planOrderIntentFeedback.false_reject_count}</Tag>
                  <Tag color="green">有效拦截 {planOrderIntentFeedback.saved_loss_count}</Tag>
                  <Tag color="blue">
                    平均相对 {formatPercent(planOrderIntentFeedback.avg_intended_action_return_pct)}
                  </Tag>
                </Space>
                {(planOrderIntentFeedback.rule_suggestions || []).length > 0 && (
                  <div className="plan-order-feedback-rules">
                    {(planOrderIntentFeedback.rule_suggestions || []).slice(0, 3).map(item => (
                      <Tag key={item.key} color={orderRuleActionColorMap[item.action] || 'default'}>
                        {item.label} · {item.action_label}
                      </Tag>
                    ))}
                  </div>
                )}
              </div>
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

        <div className="paper-policy-replay-section">
          <div className="paper-policy-replay-head">
            <div>
              <Tag color="blue" icon={<SafetyCertificateOutlined />}>
                Entry Policy Replay
              </Tag>
              <h3>买入放行回放</h3>
              <p>按当前持仓优先展示：每笔买入当时用了多少预算、过了哪些风控，以及现在赚没赚钱。</p>
            </div>
          </div>
          {policyReplayItems.length > 0 ? (
            <div className="paper-policy-replay-list">
              {policyReplayItems.map((item: any) => (
                <TradePolicyExplainPanel
                  key={`${item.symbol}-${item.signal_id || item.entry_trade_id || item.status}`}
                  policy={item.policy_explain}
                  outcome={item}
                  compact
                  title={`${item.name || item.symbol}（${item.symbol}）买入放行`}
                />
              ))}
            </div>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无可回放的策略预算/风控记录，等自动荐股买入后会在这里沉淀。"
            />
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
        title={canaryEvidenceFocus?.title || 'Canary 证据链'}
        open={Boolean(canaryEvidenceFocus)}
        onCancel={() => setCanaryEvidenceFocus(null)}
        footer={null}
        width={860}
        destroyOnHidden
      >
        <div className="order-canary-evidence-modal">
          <div className="order-canary-evidence-hero">
            <div>
              <span>CANARY EVIDENCE</span>
              <h3>
                {canaryEvidenceFocus?.item?.parameter_label ||
                  (canaryEvidenceFocus?.source === 'active' ? '当前小流量调参证据' : '候选证据')}
              </h3>
              <p>
                {canaryEvidenceFocus?.item?.rationale ||
                  canaryEvidence?.conclusion ||
                  '这里仅用于解释参数候选为什么值得小流量观察，不会写入任务参数，也不会触发买卖。'}
              </p>
            </div>
            <Tag color={canaryEvidenceFocus?.source === 'active' ? 'gold' : 'blue'}>
              {canaryEvidenceFocus?.source === 'active'
                ? '观察中'
                : canaryEvidenceFocus?.source === 'readonly'
                ? '只读候选'
                : '预览候选'}
            </Tag>
          </div>

          {canaryEvidenceFocus?.item ? (
            <>
              <div className="order-canary-evidence-modal-metrics">
                <div>
                  <span>动作</span>
                  <strong>{canaryEvidenceFocus.item.action_label}</strong>
                </div>
                <div>
                  <span>参数变化</span>
                  <strong>{canaryEvidenceFocus.item.change_label}</strong>
                </div>
                <div>
                  <span>置信度</span>
                  <strong>{Number(canaryEvidenceFocus.item.confidence || 0).toFixed(1)}</strong>
                </div>
                <div>
                  <span>样本</span>
                  <strong>{canaryEvidenceFocus.item.sample_count || 0}</strong>
                </div>
              </div>
              <Alert
                type="info"
                showIcon
                message="为什么现在只做 Canary？"
                description="参数候选来自历史拒单/收益后验，但仍可能受行情阶段影响；因此先小流量观察闭环交易，不直接全量放开。"
              />
            </>
          ) : (
            <Alert
              type="info"
              showIcon
              message={canaryEvidence?.conclusion || '当前 Canary 证据来自最近一次审计记录。'}
              description="该弹窗仅做解释，不会改变任务参数；扩大或回滚仍要走评审分、闭环收益和回撤守门。"
            />
          )}

          {focusedFamilyConsensus ? (
            <div className="order-canary-family-brief">
              <div className="order-canary-family-brief-head">
                <div>
                  <span>多账户共识</span>
                  <strong>{focusedFamilyConsensus.action_label || '同向候选'}</strong>
                </div>
                <Tag color="gold">{focusedFamilyConsensus.family_count || 0} 个账户同向</Tag>
              </div>
              <p>{focusedFamilyConsensus.conclusion || '多账户后验显示该参数方向具备共识。'}</p>
              <div className="order-canary-family-grid">
                <div>
                  <span>评估样本</span>
                  <strong>{focusedFamilyConsensus.evaluated_count || 0}</strong>
                </div>
                <div>
                  <span>可能错杀</span>
                  <strong>{focusedFamilyConsensus.false_reject_count || 0}</strong>
                </div>
                <div>
                  <span>有效避险</span>
                  <strong>{focusedFamilyConsensus.saved_loss_count || 0}</strong>
                </div>
                <div>
                  <span>平均相对</span>
                  <strong
                    style={{
                      color: pnlColor(focusedFamilyConsensus.avg_intended_action_return_pct),
                    }}
                  >
                    {formatPercent(focusedFamilyConsensus.avg_intended_action_return_pct)}
                  </strong>
                </div>
              </div>
              {focusedFamilyConsensus.portfolio_names?.length ? (
                <Space wrap size={6} className="order-canary-family-portfolios">
                  {focusedFamilyConsensus.portfolio_names.slice(0, 8).map((name: string) => (
                    <Tag key={name} color="gold">
                      {name}
                    </Tag>
                  ))}
                </Space>
              ) : null}
            </div>
          ) : (
            <div className="order-canary-family-brief muted">
              <div className="order-canary-family-brief-head">
                <div>
                  <span>证据说明</span>
                  <strong>暂无多账户共识样本</strong>
                </div>
              </div>
              <p>该候选可能来自稳定窗口或历史审计；需要继续观察闭环交易后再判断是否扩大。</p>
            </div>
          )}

          {canaryEvidenceFocus?.source === 'active' ? (
            <div className="order-canary-active-evidence-list">
              <div className="order-canary-evidence-section-title">
                <CheckCircleOutlined />
                <span>当前 Canary 来源拆解</span>
              </div>
              <Space wrap size={6}>
                {activeCanaryEvidenceTags.map((item: any) =>
                  typeof item === 'string' ? (
                    <Tag key={item} color="blue">
                      {item}
                    </Tag>
                  ) : (
                    <Tag
                      key={item.source || item.label}
                      color={item.source === 'family_hindsight' ? 'gold' : 'blue'}
                    >
                      {item.label} {item.count}
                    </Tag>
                  )
                )}
              </Space>
              {activeCanaryEvidenceItems.length ? (
                <div className="order-canary-modal-list">
                  {activeCanaryEvidenceItems.slice(0, 6).map(item => (
                    <div key={`${item.parameter_key}-${item.action}`}>
                      <Space wrap size={6}>
                        <Text strong>{item.parameter_label}</Text>
                        <Tag color={orderRuleActionColorMap[item.action] || 'default'}>
                          {item.action_label}
                        </Tag>
                        <Tag>{item.sample_count || 0} 样本</Tag>
                      </Space>
                      <p>{item.family_consensus?.conclusion || '等待更多闭环样本确认。'}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="order-canary-evidence-guardrail">
            <WarningOutlined />
            <span>
              执行纪律：该证据只支持“小流量验证”。只有当闭环收益、胜率、回撤守门同时达标时，才建议扩大；否则继续观察或回滚。
            </span>
          </div>
        </div>
      </Modal>

      <Modal
        title={
          orderIntentTrace?.intent
            ? `${orderIntentTrace.intent.name || orderIntentTrace.intent.symbol} 拒单链路`
            : '拒单链路'
        }
        open={isOrderIntentTraceVisible}
        onCancel={() => setIsOrderIntentTraceVisible(false)}
        footer={null}
        width={980}
        destroyOnHidden
      >
        <Spin spinning={orderIntentTraceLoading}>
          {orderIntentTrace ? (
            <div className="order-trace-modal">
              <Alert type="info" showIcon message={orderIntentTrace.conclusion} />
              <Row gutter={[14, 14]} className="order-trace-summary">
                <Col xs={12} md={6}>
                  <div>
                    <span>动作</span>
                    <strong>
                      {orderIntentTrace.intent.side_label || orderIntentTrace.intent.side}
                    </strong>
                  </div>
                </Col>
                <Col xs={12} md={6}>
                  <div>
                    <span>状态</span>
                    <strong>
                      {orderIntentTrace.intent.status_label || orderIntentTrace.intent.status}
                    </strong>
                  </div>
                </Col>
                <Col xs={12} md={6}>
                  <div>
                    <span>参考价</span>
                    <strong>
                      {orderIntentTrace.intent.reference_price
                        ? `¥${Number(orderIntentTrace.intent.reference_price).toFixed(2)}`
                        : '--'}
                    </strong>
                  </div>
                </Col>
                <Col xs={12} md={6}>
                  <div>
                    <span>同类样本</span>
                    <strong>{orderIntentTrace.peer_review?.sample_count || 0}</strong>
                  </div>
                </Col>
              </Row>

              <Row gutter={[16, 16]}>
                <Col xs={24} lg={13}>
                  <div className="order-trace-section">
                    <h3>链路时间线</h3>
                    <Timeline
                      items={(orderIntentTrace.timeline || []).map(item => ({
                        color:
                          item.status === 'false_reject'
                            ? 'orange'
                            : item.status === 'protected_or_neutral'
                            ? 'green'
                            : item.status === 'missing'
                            ? 'gray'
                            : 'blue',
                        children: (
                          <div className="order-trace-step">
                            <Space wrap size={8}>
                              <Text strong>{item.label}</Text>
                              {item.time && <Tag>{item.time}</Tag>}
                            </Space>
                            <p>{item.summary}</p>
                            {item.metric && (
                              <Space wrap size={8}>
                                <Tag color={pnlColor(item.metric.intended_action_return_pct)}>
                                  相对 {formatPercent(item.metric.intended_action_return_pct)}
                                </Tag>
                                <Tag>
                                  目标价 ¥{Number(item.metric.target_price || 0).toFixed(2)}
                                </Tag>
                              </Space>
                            )}
                          </div>
                        ),
                      }))}
                    />
                  </div>
                </Col>
                <Col xs={24} lg={11}>
                  <div className="order-trace-section">
                    <h3>信号与规则影响</h3>
                    {orderIntentTrace.signal ? (
                      <div className="order-trace-signal">
                        <Space wrap>
                          <Tag color="blue">{orderIntentTrace.signal.source_type}</Tag>
                          <Tag>{orderIntentTrace.signal.normalized_decision}</Tag>
                          <Tag color="purple">
                            评分 {orderIntentTrace.signal.confidence_score ?? '--'}
                          </Tag>
                        </Space>
                        <p>{orderIntentTrace.signal.rationale || '暂无核心理由'}</p>
                      </div>
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有关联信号" />
                    )}

                    {orderIntentTrace.peer_review?.matching_rule_suggestion && (
                      <div className="order-trace-rule">
                        <Text strong>{orderIntentTrace.peer_review.reason_category_label}</Text>
                        <p>{orderIntentTrace.peer_review.matching_rule_suggestion.reason}</p>
                        <Space wrap>
                          <Tag
                            color={
                              orderRuleActionColorMap[
                                orderIntentTrace.peer_review.matching_rule_suggestion.action
                              ] || 'default'
                            }
                          >
                            {orderIntentTrace.peer_review.matching_rule_suggestion.action_label}
                          </Tag>
                          {orderIntentTrace.peer_review.stable_rule_suggestion && (
                            <Tag
                              color={
                                orderRuleStabilityColorMap[
                                  orderIntentTrace.peer_review.stable_rule_suggestion
                                    .stability_state
                                ] || 'default'
                              }
                            >
                              {orderIntentTrace.peer_review.stable_rule_suggestion.stability_label}
                            </Tag>
                          )}
                        </Space>
                      </div>
                    )}

                    {(orderIntentTrace.peer_review?.parameter_impact || []).length > 0 && (
                      <div className="order-trace-params">
                        <h4>可能影响的参数</h4>
                        {(orderIntentTrace.peer_review?.parameter_impact || [])
                          .slice(0, 4)
                          .map(item => (
                            <div className="order-trace-param" key={item.parameter_key}>
                              <span>{item.parameter_label}</span>
                              <strong>
                                {formatTuningValue(item.current_value, item.unit)} →{' '}
                                {formatTuningValue(item.preview_value, item.unit)}
                              </strong>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                </Col>
              </Row>
            </div>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无链路数据" />
          )}
        </Spin>
      </Modal>

      <Modal
        title="强确认回滚 Canary 参数"
        open={isCanaryRollbackModalOpen}
        onOk={confirmCanaryRollback}
        onCancel={() => setIsCanaryRollbackModalOpen(false)}
        confirmLoading={canaryRollbackLoading}
        okText="确认回滚"
        okButtonProps={{
          danger: true,
          disabled:
            canaryRollbackConfirmText.trim() !==
            (canaryRollbackPreview?.confirm_text || CANARY_ROLLBACK_CONFIRM_TEXT),
        }}
        cancelText="取消"
        destroyOnHidden
      >
        <div className="order-canary-rollback-modal">
          <Alert
            type="warning"
            showIcon
            message="该操作会恢复自动任务参数，但不会立即触发买卖。"
            description={
              canaryRollbackPreview?.message || '请先完成回滚预览，确认没有人工复核风险后再执行。'
            }
          />
          <div className="order-canary-rollback-summary">
            {(canaryRollbackPreview?.changes || []).map(change => (
              <div className="order-canary-rollback-task" key={change.task_id}>
                <Text strong>{change.task_name}</Text>
                <span>{change.task_type}</span>
                <div>
                  {(change.parameters || []).map(parameter => (
                    <Tag
                      key={`${change.task_id}-${parameter.key}`}
                      color={parameter.changed_after_canary ? 'red' : 'blue'}
                    >
                      {parameter.key}: {formatRollbackValue(parameter.current_value)} →{' '}
                      {formatRollbackValue(parameter.restore_value)}
                    </Tag>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <Form layout="vertical">
            <Form.Item
              label={`请输入 ${
                canaryRollbackPreview?.confirm_text || CANARY_ROLLBACK_CONFIRM_TEXT
              }`}
              required
            >
              <Input
                value={canaryRollbackConfirmText}
                onChange={event => setCanaryRollbackConfirmText(event.target.value)}
                placeholder={canaryRollbackPreview?.confirm_text || CANARY_ROLLBACK_CONFIRM_TEXT}
              />
            </Form.Item>
          </Form>
        </div>
      </Modal>

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
