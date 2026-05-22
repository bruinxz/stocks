export interface BrokerCapabilities {
  broker_key: string;
  broker_name: string;
  readonly_supported: boolean;
  trading_supported: boolean;
  cancel_supported: boolean;
  sandbox_supported: boolean;
  order_types: string[];
  markets: string[];
  notes: string[];
}

export interface BrokerAccountSnapshot {
  total_asset: number;
  available_cash: number;
  market_value: number;
  frozen_cash?: number;
  total_pnl?: number;
  day_pnl?: number;
  snapshot_time: Date;
  raw_payload?: Record<string, any>;
}

export interface BrokerPosition {
  symbol: string;
  name?: string;
  quantity: number;
  available_quantity: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  quote_time?: Date;
  raw_payload?: Record<string, any>;
}

export interface BrokerOrderQuery {
  start_time?: string;
  end_time?: string;
  status?: string;
  limit?: number;
}

export interface BrokerTradeQuery {
  start_time?: string;
  end_time?: string;
  symbol?: string;
  limit?: number;
}

export interface BrokerOrder {
  broker_order_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  limit_price: number;
  status: string;
  submitted_at?: Date;
  raw_payload?: Record<string, any>;
}

export interface BrokerTrade {
  broker_trade_id: string;
  broker_order_id?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  trade_price: number;
  trade_amount: number;
  trade_time: Date;
  raw_payload?: Record<string, any>;
}

export interface BrokerPlaceOrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  limit_price: number;
  order_type: string;
  client_order_id: string;
}

export interface BrokerPlaceOrderResult {
  broker_order_id: string;
  status: string;
  raw_payload?: Record<string, any>;
}

export interface BrokerCancelOrderResult {
  broker_order_id: string;
  status: string;
  raw_payload?: Record<string, any>;
}

export interface BrokerGateway {
  getCapabilities(): BrokerCapabilities;
  getAccountSnapshot(): Promise<BrokerAccountSnapshot>;
  getPositions(): Promise<BrokerPosition[]>;
  getOrders(query?: BrokerOrderQuery): Promise<BrokerOrder[]>;
  getTrades(query?: BrokerTradeQuery): Promise<BrokerTrade[]>;
  placeOrder(order: BrokerPlaceOrderRequest): Promise<BrokerPlaceOrderResult>;
  cancelOrder(order_id: string): Promise<BrokerCancelOrderResult>;
}
