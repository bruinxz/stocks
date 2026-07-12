import type {
  RatingCounts,
  DailyReportDocument,
  RecommendationMarketScope,
  RecommendationProfile,
  RecommendationSnapshot,
} from '../daily-report/types';

export interface B5HistoryEntryWire {
  report_id: string;
  trading_day: string;
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
  source_snapshot_id: string;
  source_as_of: string;
  source_output_fingerprint: string;
  source_fingerprint_preimage_jcs: string;
  input_fingerprint: string;
  contract_version: '0.3.1';
  profile_version: string;
  strategy_version: string;
  pipeline_version: string;
  disclaimer_version: string;
  item_count: number;
  high_conviction_count: number;
  rating_counts: RatingCounts;
  content_preview: string;
}

export interface B5ReportHistoryWire {
  projection_version: string;
  filters: {
    query: string;
    profile: RecommendationProfile | null;
    market_scope: RecommendationMarketScope | null;
    from_day: string | null;
    to_day: string | null;
  };
  entries: B5HistoryEntryWire[];
  total: number;
}

export interface ReportHistoryEntry {
  wire: B5HistoryEntryWire;
  report_id: string;
  trading_day: string;
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
  snapshot_id: string;
  output_fingerprint: string;
  entry_count: number;
  high_conviction_count: number;
  top_rating: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  generated_at: string;
  content_preview: string;
}

export interface ReportHistoryPage {
  wire: B5ReportHistoryWire;
  entries: ReportHistoryEntry[];
  total: number;
  page: number;
  page_size: number;
  query: ReportHistoryQuery;
}

export interface ReportHistoryQuery {
  date?: string;
  profile?: RecommendationProfile;
  market_scope?: RecommendationMarketScope;
  search?: string;
  page: number;
  page_size: number;
}

export interface SnapshotDiff {
  base_snapshot_id: string;
  target_snapshot_id: string;
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
  fingerprint_match: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export type ReportHistoryViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; query: ReportHistoryQuery }
  | {
      kind: 'ready';
      page: ReportHistoryPage;
      query: ReportHistoryQuery;
      selected_report?: DailyReportDocument;
      selected_snapshot?: RecommendationSnapshot;
      comparison?: SnapshotDiff;
    };
