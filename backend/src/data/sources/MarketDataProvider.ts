export type MarketDataFeature =
  | 'stock_list'
  | 'history_k'
  | 'stock_basic'
  | 'index_constituents'
  | 'trade_calendar'
  | 'realtime_quote'
  | 'intraday_bar'
  | 'health_probe';

export type MarketDataProviderType = 'api' | 'python' | 'analysis' | 'composite';

export interface MarketDataProviderDefinition {
  provider_name: string;
  provider_label: string;
  provider_type: MarketDataProviderType | string;
  priority: number;
  is_enabled: boolean;
  supported_features: MarketDataFeature[];
  metadata?: Record<string, any>;
}

export interface ProviderExecutionOptions extends MarketDataProviderDefinition {
  feature: MarketDataFeature;
  operation_name: string;
  max_retries?: number;
  initial_delay_ms?: number;
  max_delay_ms?: number;
}
