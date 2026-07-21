export type TradeReasonSource =
  | 'manual'
  | 'auto_buy_from_signals'
  | 'analysis_engine_hard'
  | 'rebalance'
  | 'trailing_stop'
  | 'drawdown_breaker'
  | 'industry_concentration'
  | 'per_stock_stop_loss'
  | 'black_swan'
  | 'restricted_share'
  | 'market_regime_alert'
  | 'kill_switch'
  | 'close_position'
  | 'take_profit'
  | 'stop_loss'
  | 'trailing_take_profit'
  | 'sell_signal'
  | 'technical_breakdown'
  | 'unknown';

export interface TradeReasonEvidenceItem {
  label: string;
  detail?: string;
  weight?: number;
}

export interface TradeReasonPayload {
  source: TradeReasonSource;
  strategy_key?: string;
  signal_id?: number;
  ai_report_id?: string;
  evidence?: TradeReasonEvidenceItem[];
  confidence?: number;
  key_reasons?: string[];
  risk_trigger?: { type: string; threshold?: number; actual?: number; indicator?: string };
  ai_summary?: string;
}
