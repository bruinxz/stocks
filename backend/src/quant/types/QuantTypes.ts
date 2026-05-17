export type QuantSignalAction = 'buy' | 'sell' | 'hold' | 'watch' | 'avoid';
export type QuantStrategyCategory =
  | 'trend'
  | 'momentum'
  | 'mean_reversion'
  | 'breakout'
  | 'multi_factor'
  | 'risk_control';
export type QuantUniverse = 'market' | 'favorites' | 'custom';

export interface QuantBar {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number | null;
  turnover_rate?: number | null;
  change_percent?: number | null;
  amount?: number | null;
}

export interface QuantStockContext {
  stock_id: number;
  symbol: string;
  name: string;
  market?: string | null;
  industry?: string | null;
  bars: QuantBar[];
  as_of?: string;
  latest_price?: number | null;
  latest_quote_time?: string | null;
  price_source?: 'realtime_quote' | 'stock_snapshot' | 'daily_bar';
  change_percent?: number | null;
  total_market_cap?: number | null;
  pe_dynamic?: number | null;
  pb?: number | null;
}

export interface QuantSignalResult {
  strategy_key: string;
  symbol: string;
  name?: string;
  signal: QuantSignalAction;
  score: number;
  confidence: number;
  entry_price?: number;
  stop_loss_price?: number;
  take_profit_price?: number;
  target_holding_days?: number;
  reasons: string[];
  risk_flags: string[];
  factors: Record<string, any>;
  raw?: Record<string, any>;
}

export interface QuantStrategyDefinition {
  strategy_key: string;
  name: string;
  description: string;
  category: QuantStrategyCategory;
  default_params: Record<string, any>;
  enabled: boolean;
  risk_level: 'low' | 'medium' | 'high';
  tags: string[];
}

export interface QuantStrategyRuntimeOptions {
  params?: Record<string, any>;
  as_of?: string;
}

export interface QuantBacktestOptions {
  task_name?: string;
  universe?: QuantUniverse;
  symbols?: string[];
  strategy_keys: string[];
  start_date: string;
  end_date: string;
  initial_capital?: number;
  commission_rate?: number;
  slippage_rate?: number;
  stamp_tax_rate?: number;
  max_positions?: number;
  position_pct?: number;
  rebalance_frequency?: 'daily' | 'weekly';
  benchmark_symbol?: string;
  candidate_limit?: number;
  min_score?: number;
  params_by_strategy?: Record<string, Record<string, any>>;
}

export interface QuantEquityPoint {
  date: string;
  total_value: number;
  cash: number;
  position_value: number;
  cumulative_return_pct: number;
  drawdown_pct: number;
}

export interface QuantBacktestTradeResult {
  strategy_key: string;
  symbol: string;
  name?: string;
  buy_date: string;
  sell_date?: string;
  buy_price: number;
  sell_price?: number;
  quantity: number;
  amount: number;
  pnl?: number;
  return_pct?: number;
  holding_days: number;
  entry_reason?: string;
  exit_reason?: string;
}

export interface QuantBacktestStrategyResult {
  strategy_key: string;
  strategy_name: string;
  total_return_pct: number;
  annual_return_pct: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  win_rate: number;
  profit_factor: number;
  trade_count: number;
  avg_holding_days: number;
  benchmark_return_pct?: number;
  excess_return_pct?: number;
  metrics: Record<string, any>;
  equity_curve: QuantEquityPoint[];
  drawdown_curve: Array<{ date: string; drawdown_pct: number }>;
  trades: QuantBacktestTradeResult[];
}
