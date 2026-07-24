import { authenticatedFetch } from './api';

export type ResearchLoopAction = 'BUY' | 'HOLD' | 'SELL';

export type ResearchLoopExecutionStatus =
  | 'research_blocked'
  | 'strategy_blocked'
  | 'market_closed'
  | 'scheduled'
  | 'waiting_for_quotes'
  | 'ready'
  | 'stalled'
  | 'portfolio_not_ready'
  | 'automation_disabled'
  | 'running'
  | 'completed'
  | 'failed';

export type ResearchStrategyQualificationStatus = 'pass' | 'fail' | 'insufficient';

export interface ResearchStrategyQualificationView {
  source: 'morning_brief' | 'multibagger';
  strategy_key: string;
  status: ResearchStrategyQualificationStatus;
  eligible_for_new_positions: boolean;
  verdict: string;
  evaluated_at: string;
  audit_created_at: string | null;
  summary: string;
  blockers: Array<{
    code: string;
    title: string;
    detail: string;
    observed?: string | number | boolean | null;
    required?: string | number | boolean | null;
  }>;
  evidence: {
    pit: null | {
      strategy_key: string;
      snapshot_count: number;
      first_day: string | null;
      last_day: string | null;
      cumulative_return_pct: number | null;
      sharpe_ratio: number | null;
      max_drawdown_pct: number | null;
      win_rate_pct: number | null;
      evidence_hash: string | null;
    };
    qualification_contract_version: string | null;
    oos_trading_days: number | null;
    after_cost_annual_return_pct: number | null;
    benchmark_excess_return_pct: number | null;
    max_drawdown_pct: number | null;
    walk_forward_verdict: string | null;
    overfit_score: number | null;
    double_cost_total_return_pct: number | null;
    point_in_time_ready: boolean;
    evidence_hash: string | null;
  };
}

export interface ResearchLoopDecisionView {
  id: number;
  symbol: string;
  name: string;
  action: ResearchLoopAction;
  status: 'planned' | 'executed' | 'held' | 'skipped' | 'failed';
  combined_score: number | null;
  target_weight_pct: number | null;
  reference_price: number | null;
  quantity: number | null;
  sources: Array<{
    source: 'morning_brief' | 'multibagger';
    source_id: string;
    score: number;
    rating: string | null;
  }>;
  reason: string;
  metadata?: Record<string, unknown>;
  trade_id: number | null;
  created_at: string;
}

export interface ResearchTradingLoopDashboard {
  research: {
    expected_research_day: string;
    morning: {
      snapshot_id: string | null;
      research_day: string | null;
      as_of: string | null;
      candidate_count: number;
      fresh: boolean;
    };
    multibagger: {
      as_of: string | null;
      research_day: string | null;
      candidate_count: number;
      fresh: boolean;
    };
    qualification: {
      status: 'pass' | 'partial' | 'blocked';
      eligible_source_count: number;
      source_count: number;
      allows_new_positions: boolean;
      evaluated_at: string;
      sources: {
        morning_brief: ResearchStrategyQualificationView;
        multibagger: ResearchStrategyQualificationView;
      };
    };
    merged_target_count: number;
    allocation_policy: {
      size_hint_multiplier: number;
      dual_source_bonus_pct: number;
      max_single_weight_pct: number;
      planned_gross_weight_pct: number;
    };
    targets: Array<{
      symbol: string;
      name: string;
      combined_score: number;
      source_size_hint_pct: number;
      target_weight_pct: number;
      sources: Array<'morning_brief' | 'multibagger'>;
    }>;
  };
  execution: {
    trading_day: string;
    status: ResearchLoopExecutionStatus;
    reason_code: string;
    message: string;
    next_attempt_label: string | null;
    required_quote_count: number | null;
    fresh_quote_count: number | null;
    unavailable_symbols: string[];
  };
  latest_run: null | {
    id: number;
    portfolio_id: number;
    portfolio_name: string;
    trading_day: string;
    research_day: string;
    status: string;
    execution_mode?: 'qualified_strategy' | 'de_risk_only' | null;
    is_current: boolean;
    target_count: number;
    buy_count: number;
    hold_count: number;
    sell_count: number;
    skipped_count: number;
    total_value: number;
    current_cash: number;
    completed_at: string | null;
    decisions: ResearchLoopDecisionView[];
  };
}

export class ResearchTradingLoopRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly missing_tables: string[]
  ) {
    super(message);
    this.name = 'ResearchTradingLoopRequestError';
  }
}

export async function getResearchTradingLoopDashboard(
  signal?: AbortSignal
): Promise<ResearchTradingLoopDashboard> {
  const response = await authenticatedFetch('/api/research-trading-loop/dashboard', { signal });
  const body = await response.json();
  if (!response.ok || !body?.success) {
    throw new ResearchTradingLoopRequestError(
      body?.message || `research loop ${response.status}`,
      typeof body?.code === 'string' ? body.code : null,
      Array.isArray(body?.missing_tables) ? body.missing_tables.map(String) : []
    );
  }
  return body.data as ResearchTradingLoopDashboard;
}

export const researchTradingLoopService = { getResearchTradingLoopDashboard };

export default researchTradingLoopService;
