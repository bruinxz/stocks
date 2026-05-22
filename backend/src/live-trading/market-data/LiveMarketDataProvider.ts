export interface LiveQuoteSnapshot {
  symbol: string;
  name?: string;
  current_price?: number;
  change_percent?: number;
  bid_price?: number;
  ask_price?: number;
  turnover?: number;
  volume?: number;
  quote_time?: Date;
  source: string;
  latency_seconds?: number;
  is_realtime: boolean;
  raw_payload?: Record<string, any>;
}

export interface LiveMarketDataProvider {
  getProviderInfo(): {
    provider_key: string;
    provider_name: string;
    realtime_supported: boolean;
    licensed_for_external_use: boolean;
    notes: string[];
  };
  getQuote(symbol: string): Promise<LiveQuoteSnapshot | null>;
  getQuotes(symbols: string[]): Promise<LiveQuoteSnapshot[]>;
}
