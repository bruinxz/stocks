export interface DailyReportSlot {
  date: string;
  profile: 'us_preferred' | 'multibagger';
  generation_status: 'idle' | 'queued' | 'generating' | 'ready' | 'failed';
  job_id?: string;
  generated_at?: string;
  content_markdown?: string;
  disclaimer: string;
  snapshot_id?: string;
  entries?: DailyReportEntry[];
}

export interface DailyReportEntry {
  ticker: string;
  score_total: number;
  conviction_level: 'HIGH' | 'MED' | 'LOW';
  risk_gate: 'GREEN' | 'YELLOW' | 'RED';
  size_hint: {
    tier: 'TIER_5' | 'TIER_3' | 'TIER_2' | 'TIER_1' | 'SKIP';
    pct: number;
    disclaimer_key: 'size_hint_advisory';
  };
  trigger_signals: string[];
  explanation: string;
  weights: Record<string, number>;
  evidence_refs: string[];
}
