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
  factor_snapshot?: {
    valuation?: Record<string, any> | null;
    money_flow?: Record<string, any> | null;
    fundamental?: Record<string, any> | null;
    factor_date?: string | null;
  };
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
  /**
   * US-083 dry-run 模式：一次性 override 策略实例的 dryRun 标志。
   * 当 true 时，PaperTradingFacade.applyAutomation 只把信号写入 QuantSignal 表，
   * 不调用 placeOrder 真实下单。未传时回落到策略实例的 dryRun 字段（持久化在
   * QuantStrategyModel.lifecycle_policy.dry_run）。
   */
  dryRun?: boolean;
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
  min_commission?: number;
  slippage_rate?: number;
  stamp_tax_rate?: number;
  execution_timing?: 'next_open' | 'same_close' | 'twap_proxy';
  enable_t_plus_one?: boolean;
  lot_size?: number;
  limit_up_pct?: number;
  limit_down_pct?: number;
  block_limit_up?: boolean;
  block_limit_down?: boolean;
  block_suspended?: boolean;
  /** US-014：是否过滤 ST / *ST 股，默认 true */
  block_st_stocks?: boolean;
  /** US-014：过户费率（双边），默认 0.00001（万 0.1） */
  transfer_fee_rate?: number;
  min_turnover_yuan?: number;
  max_trade_amount_pct_of_turnover?: number;
  dynamic_slippage?: boolean;
  max_positions?: number;
  position_pct?: number;
  rebalance_frequency?: 'daily' | 'weekly';
  benchmark_symbol?: string;
  candidate_limit?: number;
  min_score?: number;
  params_by_strategy?: Record<string, Record<string, any>>;
  validation_split?: {
    enabled?: boolean;
    train_pct?: number;
    validation_pct?: number;
    test_pct?: number;
    train_end_date?: string;
    validation_start_date?: string;
    validation_end_date?: string;
    test_start_date?: string;
  };
  grid_search?: Record<string, any>;
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

/**
 * 被 AShareConstraintEngine 拦截的订单（US-014）。
 * 与 trades 并行保存到 QuantBacktestResult.rejected_orders_json，便于
 * 复盘"如果没有 T+1/涨停等约束，回测能成多少单"。
 */
export interface QuantBacktestRejectedOrder {
  /** 拒单发生的交易日 */
  trade_date: string;
  /** 当时正在执行的策略 key */
  strategy_key: string;
  /** 股票代码 */
  symbol: string;
  name?: string;
  side: 'buy' | 'sell';
  /** 原因码（来自 RejectionReason enum，便于聚合统计） */
  reason: string;
  /** 人类可读补充（"涨幅 9.95% ≥ 阈值 9.8%" 等） */
  detail?: string;
  /** 拒单时的参考价（next_open 价 / same_close 价等） */
  reference_price?: number | null;
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
  /** US-014：被 A 股约束引擎拦截的订单明细 */
  rejected_orders?: QuantBacktestRejectedOrder[];
}
