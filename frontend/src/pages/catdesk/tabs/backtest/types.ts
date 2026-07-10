export interface BacktestSnapshotSlot {
  snapshot_id: string;
  snapshot_day: string;
  profile: 'us_preferred' | 'multibagger';
  as_of_utc: string;
  is_survivorship_biased: boolean;
  is_delisted_at_as_of?: boolean;
  fact_hash: string;
  net_value?: number;
  drawdown?: number;
  cumulative_return?: number;
  sharpe_ratio_6m?: number;
  win_rate_6m?: number;
}

export interface BacktestHolding {
  ticker: string;
  weight: number;
  return_since_entry: number;
  is_stale: boolean;
}
