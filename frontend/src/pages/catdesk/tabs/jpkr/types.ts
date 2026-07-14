export type JpKrMarket = 'JP' | 'KR';

export type JpKrSector =
  | 'semiconductor'
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
  date: string;
};
