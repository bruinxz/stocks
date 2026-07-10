export type JpKrMarket = 'JP' | 'KR';

export type JpKrSector =
  | 'semiconductor' | 'automotive' | 'battery' | 'ai_robotics'
  | 'pharma' | 'steel' | 'shipbuilding' | 'consumer' | 'other';

export type JpKrDisclosureEvent = {
  title: string;
  doc_type: string;
  filed_at: string;
  source: 'EDINET' | 'DART';
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
  nikkei225?: { value: number; change_pct: number; as_of: string };
  topix?: { value: number; change_pct: number; as_of: string };
  kospi?: { value: number; change_pct: number; as_of: string };
};

export type JpKrMarketResponse = {
  kpi: JpKrKpi;
  rows: JpKrMarketRow[];
  date: string;
};
