import api from './api';

export interface PortfolioListItem {
  id: number;
  name: string;
  initial_capital: number;
  current_cash: number;
  total_value: number;
  position_count: number;
  positions_count?: number;
  created_at: string;
  strategy_keys?: string[];
  strategy_display?: Array<{ key: string; name: string; brief?: string }>;
  enabled_factors?: string[];
  factor_display?: Array<{ key: string; name: string; category: string }>;
  auto_trade_enabled?: boolean;
  recent_7d_return_pct?: number | null;
  description?: string | null;
  is_active?: boolean;
}

export interface LedgerTimelineItem {
  id: string;
  type: 'trade' | 'signal' | 'alert' | 'notification' | 'correction';
  title: string;
  detail: string | null;
  occurred_at: string;
  status: string | null;
  corrected: boolean;
}

export interface PortfolioLedgerPosition {
  position: {
    id: number;
    symbol: string;
    name: string;
    quantity: number;
    avg_cost: number;
    stop_loss_price: number | null;
    take_profit_price: number | null;
    highest_price: number | null;
    trailing_stop_price: number | null;
    created_at: string | null;
  };
  quote: {
    price: number;
    source: string;
    quote_time: string | null;
    trade_date: string | null;
    freshness: 'fresh' | 'delayed' | 'stale' | 'missing';
    age_minutes: number | null;
  };
  valuation: {
    market_value: number;
    unrealized_pnl: number;
    unrealized_pnl_pct: number | null;
  };
  source_status: 'linked' | 'missing';
  source_message: string | null;
  entry_trades: Array<{
    id: number;
    execute_price: number;
    quantity: number;
    amount: number;
    commission: number;
    trade_reason_summary: string | null;
    created_at: string | null;
  }>;
  investment_signal: {
    id: number;
    source_type: string;
    source_id: string;
    signal_date: string;
    decision: string;
    normalized_decision: string;
    confidence_score: number | null;
    rationale: string | null;
    metadata: Record<string, unknown>;
  } | null;
  outcome: {
    id: number;
    trade_status: string;
    entry_trade_id: number | null;
    exit_trade_id: number | null;
    entry_date: string | null;
    entry_price: number | null;
    latest_price: number | null;
    total_pnl: number | null;
    total_pnl_pct: number | null;
    updated_at: string | null;
  } | null;
  morning_brief: {
    matched: boolean;
    snapshot_id?: string | null;
    item_id?: string;
    trading_day: string | null;
    rank?: number;
    rating?: string;
    conviction?: number | null;
    headline?: string | null;
  };
  multibagger: {
    matched: boolean;
    snapshot_id?: string;
    as_of: string | null;
    stage?: string;
    conclusion?: string;
    rating?: string | null;
  };
  alerts: Array<{
    id: number;
    level: string;
    rule_id: string | null;
    message: string;
    is_read: boolean;
    created_at: string | null;
  }>;
  notifications: Array<{
    id: number;
    title: string;
    kind: string;
    status: string;
    corrected: boolean;
    created_at: string | null;
    sent_at: string | null;
  }>;
  corrections: Array<{
    id: number;
    correction_key: string;
    correction_type: string;
    reason: string;
    created_at: string | null;
  }>;
  timeline: LedgerTimelineItem[];
}

export interface PortfolioLedger {
  portfolio: {
    id: number;
    name: string;
    description: string | null;
    is_active: boolean;
    auto_trade_enabled: boolean;
    strategy_keys: string[];
  };
  valuation: {
    initial_capital: number;
    current_cash: number;
    position_value: number;
    total_value: number;
    total_pnl: number;
    total_pnl_pct: number | null;
    valued_at: string | null;
    quote_source: string;
    has_stale_quotes: boolean;
  };
  latest_morning_brief: {
    snapshot_id: string;
    trading_day: string;
    as_of: string | null;
  } | null;
  latest_multibagger: { as_of: string | null; market_scope: string } | null;
  unread_alerts_count: number;
  positions: PortfolioLedgerPosition[];
}

function unwrap<T>(
  res: { data?: { success?: boolean; data?: T; message?: string } },
  fallback: string
): T {
  if (!res.data?.success) throw new Error(res.data?.message || fallback);
  return res.data.data as T;
}

export async function listPortfolios(): Promise<PortfolioListItem[]> {
  const res = await api.get('/paper-trading/portfolios');
  return unwrap<PortfolioListItem[]>(res, '获取模拟盘列表失败');
}

export async function getPortfolioLedger(portfolio_id: number): Promise<PortfolioLedger> {
  const res = await api.get(`/paper-trading/portfolios/${portfolio_id}/ledger`);
  return unwrap<PortfolioLedger>(res, '获取持仓对账簿失败');
}

export const portfolioWorkspaceService = { listPortfolios, getPortfolioLedger };

export default portfolioWorkspaceService;
