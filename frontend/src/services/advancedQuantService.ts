/**
 * advancedQuantService — Sprint 1-3 五大新模块的前端 service
 */
import api from './api';

// ============================================================
// Types
// ============================================================

export interface LookaheadIssue {
  file: string;
  line: number;
  pattern: string;
  snippet: string;
  severity: 'high' | 'medium' | 'low';
}

export interface SurvivorshipIssue {
  kind: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

export interface ResearchIntegrityReport {
  id?: number;
  backtest_id: number | null;
  source: string;
  strategy_key: string | null;
  dsr: number | null;
  pbo: number | null;
  oos_decay_ratio: number | null;
  observed_sharpe: number | null;
  oos_sharpe: number | null;
  num_trials: number | null;
  sample_length: number | null;
  lookahead_issues: LookaheadIssue[];
  survivorship_issues: SurvivorshipIssue[];
  verdict: 'PASS' | 'WARN' | 'FAIL' | 'INSUFFICIENT';
  summary_message: string;
  generated_at: string;
  created_at?: string;
}

export interface ExecutionFeasibilityReport {
  id?: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  target_qty: number;
  target_price: number | null;
  as_of_date: string;
  composite_score: number;
  limit_proximity_score: number | null;
  volume_coverage_score: number | null;
  spread_score: number | null;
  status_score: number | null;
  decision: 'fillable' | 'risky' | 'blocked';
  block_reasons: string[];
  summary: string;
  generated_at: string;
  created_at?: string;
}

export interface MetaLabelDecisionResult {
  id?: number;
  decision: 'bet' | 'skip';
  confidence: number;
  threshold: number;
  model_version: string;
  top_features: Array<{ name: string; contribution: number; value: number | string }>;
  reason: string;
  generated_at: string;
  symbol?: string;
  strategy_key?: string;
  created_at?: string;
}

export interface PortfolioConstructionResult {
  id?: number;
  symbols: string[];
  weights: number[];
  risk_contributions: number[];
  industry_exposure: Record<string, number>;
  total_allocation: number;
  converged: boolean;
  iterations: number;
  method: string;
  expected_volatility: number | null;
  expected_return: number | null;
  sharpe_estimate: number | null;
  summary: string;
  generated_at: string;
  as_of_date?: string;
  created_at?: string;
}

export interface GovernorEvaluateResult {
  id?: number;
  portfolio_id: number;
  user_id: number;
  as_of_date: string;
  tier: 'healthy' | 'cautious' | 'defensive' | 'critical' | 'observe_only';
  kelly_multiplier: number;
  previous_tier: string | null;
  tier_changed: boolean;
  trigger_reason: string;
  summary: string;
  recent_sharpe_30d?: number | null;
  current_drawdown_pct?: number | null;
  recent_winrate_30d?: number | null;
  created_at?: string;
}

// ============================================================
// API calls
// ============================================================

// --- Research Integrity ---
export const runResearchAudit = (input: any) =>
  api.post<{ success: boolean; data: ResearchIntegrityReport }>(
    '/advanced-quant/research-integrity/audit',
    input
  );

export const listResearchAudits = (limit = 30) =>
  api.get<{ success: boolean; data: ResearchIntegrityReport[] }>(
    `/advanced-quant/research-integrity/recent?limit=${limit}`
  );

export const getResearchAuditByBacktest = (source: string, backtest_id: number) =>
  api.get<{ success: boolean; data: ResearchIntegrityReport | null }>(
    `/advanced-quant/research-integrity/by-backtest/${source}/${backtest_id}`
  );

// --- Execution Feasibility ---
export const checkExecutionFeasibility = (input: {
  symbol: string;
  side: 'BUY' | 'SELL';
  target_qty: number;
  target_price?: number | null;
  as_of_date: string;
}) =>
  api.post<{ success: boolean; data: ExecutionFeasibilityReport }>(
    '/advanced-quant/execution-feasibility/check',
    input
  );

export const batchExecutionFeasibility = (candidates: any[]) =>
  api.post<{ success: boolean; data: { reports: ExecutionFeasibilityReport[]; summary: any } }>(
    '/advanced-quant/execution-feasibility/batch',
    { candidates }
  );

export const listExecutionFeasibility = (limit = 50, decision?: string) => {
  const params: any = { limit };
  if (decision) params.decision = decision;
  return api.get<{ success: boolean; data: ExecutionFeasibilityReport[] }>(
    '/advanced-quant/execution-feasibility/recent',
    { params }
  );
};

// --- Meta-label ---
export const decideMetaLabel = (input: any) =>
  api.post<{ success: boolean; data: MetaLabelDecisionResult }>(
    '/advanced-quant/meta-label/decide',
    input
  );

export const trainMetaLabel = (rows: Array<{ features: any; label: 0 | 1 }>) =>
  api.post<{ success: boolean; data: any }>('/advanced-quant/meta-label/train', { rows });

export const getMetaLabelModel = () =>
  api.get<{ success: boolean; data: any }>('/advanced-quant/meta-label/model');

export const listMetaLabelDecisions = (
  limit = 50,
  filters: { decision?: string; strategy_key?: string } = {}
) => {
  const params: any = { limit };
  if (filters.decision) params.decision = filters.decision;
  if (filters.strategy_key) params.strategy_key = filters.strategy_key;
  return api.get<{ success: boolean; data: MetaLabelDecisionResult[] }>(
    '/advanced-quant/meta-label/recent',
    { params }
  );
};

// --- Portfolio Construction ---
export const constructPortfolio = (input: any) =>
  api.post<{ success: boolean; data: PortfolioConstructionResult }>(
    '/advanced-quant/portfolio-construction/construct',
    input
  );

export const listPortfolioConstructions = (limit = 30) =>
  api.get<{ success: boolean; data: PortfolioConstructionResult[] }>(
    `/advanced-quant/portfolio-construction/recent?limit=${limit}`
  );

// --- Equity Curve Governor ---
export const evaluateGovernor = (portfolio_id: number, as_of_date?: string) =>
  api.post<{ success: boolean; data: GovernorEvaluateResult }>(
    '/advanced-quant/governor/evaluate',
    {
      portfolio_id,
      as_of_date,
    }
  );

export const evaluateGovernorAll = () =>
  api.post<{
    success: boolean;
    data: { evaluated: number; by_tier: Record<string, number>; results: GovernorEvaluateResult[] };
  }>('/advanced-quant/governor/evaluate-all', {});

export const getGovernorMultiplier = (portfolio_id: number) =>
  api.get<{ success: boolean; data: { portfolio_id: number; multiplier: number } }>(
    `/advanced-quant/governor/multiplier/${portfolio_id}`
  );

export const getGovernorHistory = (portfolio_id: number, days = 90) =>
  api.get<{ success: boolean; data: GovernorEvaluateResult[] }>(
    `/advanced-quant/governor/history/${portfolio_id}?days=${days}`
  );

// --- Sprint 44-C: TCA per-strategy multiplier ---
export interface StrategyTcaRow {
  id: number;
  strategy_key: string;
  report_date: string;
  lookback_days: number;
  trade_count: number;
  avg_realized_pnl_pct: number | null;
  avg_tracking_error_pct: number | null;
  avg_entry_slippage_pct: number | null;
  avg_impact_cost_pct: number | null;
  recommended_weight_multiplier: number;
  warning: 'ok' | 'high_cost' | 'severe';
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export const listTcaStrategies = (limit = 50) =>
  api.get<{ success: boolean; data: StrategyTcaRow[] }>(
    `/advanced-quant/tca/strategies?limit=${limit}`
  );

// --- Sprint 44-C: Composite rebalance admin ---
export interface CompositeRebalanceStatus {
  tasks: Array<{
    id: number;
    name: string;
    cron_expression: string;
    is_active: boolean;
    parameters: any;
    updated_at: string;
  }>;
  last_execution: {
    created_at: string;
    success_count: number;
    failed_count: number;
    result_summary: any;
  } | null;
}

export const getCompositeRebalanceStatus = () =>
  api.get<{ success: boolean; data: CompositeRebalanceStatus }>(
    '/advanced-quant/composite-rebalance/status'
  );

export const pauseCompositeRebalance = (paused: boolean) =>
  api.post<{
    success: boolean;
    data: { paused: boolean; affected_count: number; message: string };
  }>('/advanced-quant/composite-rebalance/pause', { paused });

export const runCompositeRebalance = (input: {
  portfolio_id: number;
  strategy_key: 'multi_factor_alpha' | 'ensemble_strategy';
  target_portfolio: string[];
  trade_date?: string;
  dry_run?: boolean;
  persist?: boolean;
}) => api.post<{ success: boolean; data: any }>('/advanced-quant/composite-rebalance/run', input);
