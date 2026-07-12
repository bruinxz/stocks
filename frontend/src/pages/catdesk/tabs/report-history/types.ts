import type {
  DailyReportDocument,
  RecommendationMarketScope,
  RecommendationProfile,
  RecommendationSnapshot,
} from '../daily-report/types';

export interface ReportHistoryEntry {
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
  entries: ReportHistoryEntry[];
  total: number;
  page: number;
  page_size: number;
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
