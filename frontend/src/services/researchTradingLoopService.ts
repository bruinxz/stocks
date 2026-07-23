import { authenticatedFetch } from './api';

export type ResearchLoopAction = 'BUY' | 'HOLD' | 'SELL';

export type ResearchLoopExecutionStatus =
  | 'research_blocked'
  | 'market_closed'
  | 'scheduled'
  | 'waiting_for_quotes'
  | 'ready'
  | 'stalled'
  | 'portfolio_not_ready'
  | 'running'
  | 'completed'
  | 'failed';

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
    merged_target_count: number;
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
