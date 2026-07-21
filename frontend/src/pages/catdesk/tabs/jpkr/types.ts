export type JpKrMarket = 'JP' | 'KR';

export type JpKrSector =
  | 'semiconductor'
  | 'internet_platform'
  | 'automotive'
  | 'battery'
  | 'ai_robotics'
  | 'pharma'
  | 'steel'
  | 'shipbuilding'
  | 'consumer'
  | 'other';

export type JpKrDisclosureEvent = {
  title: string;
  doc_type: string;
  filed_at: string;
  source: 'jpx-edinet' | 'dart' | 'kind';
  doc_url?: string;
};

export type JpKrMarketRow = {
  symbol: string;
  name_local: string;
  name_en: string;
  market: JpKrMarket;
  sector: JpKrSector;
  as_of: string;
  close: number;
  change_pct: number;
  currency: 'JPY' | 'KRW';
  disclosure_events: JpKrDisclosureEvent[];
  revenue_by_region: Array<{ region: string; pct: number }>;
  fx_beta: number;
  is_halted: boolean;
  data_sources: string[];
};

export type JpKrKpi = {
  nikkei225: JpKrIndexKpiSnapshot | null;
  topix: JpKrIndexKpiSnapshot | null;
  kospi: JpKrIndexKpiSnapshot | null;
  usdjpy: JpKrFxKpiSnapshot | null;
  usdkrw: JpKrFxKpiSnapshot | null;
};

export type JpKrIndexKpiSnapshot = {
  value: number;
  change_pct: number;
  as_of: string;
};

export type JpKrFxKpiSnapshot = {
  rate: number;
  change_pct: number;
  as_of: string;
};

export type JpKrMarketResponse = {
  kpi: JpKrKpi;
  rows: JpKrMarketRow[];
  sector_performance: JpKrSectorPerformance[];
  market_summary: {
    focus: 'technology_representatives' | 'market_representatives';
    leader_sector: JpKrSector | null;
    leader_sector_label: string | null;
    leader_change_pct: number | null;
    advancing_sectors: number;
    sector_count: number;
  };
  date: string;
};

export type JpKrSectorPerformance = {
  sector: JpKrSector;
  sector_label: string;
  change_pct: number;
  representative_count: number;
  representative_symbols: string[];
  calculation_basis: 'representative_equal_weight';
  as_of: string;
};
