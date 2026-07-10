export interface ReportHistoryEntrySlot {
  date: string;
  profile: 'us_preferred' | 'multibagger';
  status: 'ready' | 'failed';
  entry_count: number;
  generated_at: string;
  generation_duration_ms?: number;
  snapshot_id?: string;
  content_preview?: string;
}

export interface ReportHistoryPage {
  entries: ReportHistoryEntrySlot[];
  total: number;
  page: number;
  page_size: number;
  sort_by: 'date' | 'profile' | 'status' | 'entry_count' | 'generation_duration_ms';
  sort_dir: 'asc' | 'desc';
}
