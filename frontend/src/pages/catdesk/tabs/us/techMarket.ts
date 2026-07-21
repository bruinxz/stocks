import { authenticatedFetch } from 'services/api';

export type UsTechSector =
  | 'semiconductor'
  | 'software_cloud'
  | 'cybersecurity'
  | 'internet_platform'
  | 'ai_robotics'
  | 'broad_technology'
  | 'nasdaq_100';

const US_TECH_SECTORS = new Set<UsTechSector>([
  'semiconductor',
  'software_cloud',
  'cybersecurity',
  'internet_platform',
  'ai_robotics',
  'broad_technology',
  'nasdaq_100',
]);

export type UsTechInstrument = {
  symbol: string;
  name: string;
  instrument_type: 'stock' | 'etf';
  sector: UsTechSector;
  sector_label: string;
  exchange: string;
  close: number;
  change_pct: number;
  change_5d_pct: number | null;
  volume: number;
  notional_volume: number;
  currency: 'USD';
  as_of: string;
  data_source: string;
};

export type UsSectorPerformance = UsTechInstrument & {
  proxy_symbol: string;
  calculation_basis: 'proxy_etf';
};

export type UsFocusEtf = UsTechInstrument & {
  attention_rank: number;
  attention_basis: 'latest_dollar_volume';
};

export type UsTechMarketResponse = {
  market: 'US';
  date: string;
  as_of: string | null;
  market_summary: {
    leader_sector: UsTechSector | null;
    leader_sector_label: string | null;
    leader_change_pct: number | null;
    advancing_sectors: number;
    sector_count: number;
    tech_breadth_pct: number;
  };
  sector_performance: UsSectorPerformance[];
  representative_tech_stocks: UsTechInstrument[];
  focus_etfs: UsFocusEtf[];
};

export class UsTechMarketContractError extends Error {
  constructor(message: string) {
    super(`US technology market contract error: ${message}`);
    this.name = 'UsTechMarketContractError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsTechMarketContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsTechMarketContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UsTechMarketContractError(`${label} must be a finite number`);
  }
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value == null ? null : number(value, label);
}

function date(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
    throw new UsTechMarketContractError(`${label} must be YYYY-MM-DD`);
  }
  return parsed;
}

function parseInstrument(value: unknown, label: string): UsTechInstrument {
  const raw = record(value, label);
  const instrumentType = string(raw.instrument_type, `${label}.instrument_type`);
  if (instrumentType !== 'stock' && instrumentType !== 'etf') {
    throw new UsTechMarketContractError(`${label}.instrument_type is invalid`);
  }
  if (raw.currency !== 'USD') {
    throw new UsTechMarketContractError(`${label}.currency must be USD`);
  }
  const sector = string(raw.sector, `${label}.sector`) as UsTechSector;
  if (!US_TECH_SECTORS.has(sector)) {
    throw new UsTechMarketContractError(`${label}.sector is invalid`);
  }
  return {
    symbol: string(raw.symbol, `${label}.symbol`),
    name: string(raw.name, `${label}.name`),
    instrument_type: instrumentType,
    sector,
    sector_label: string(raw.sector_label, `${label}.sector_label`),
    exchange: string(raw.exchange, `${label}.exchange`),
    close: number(raw.close, `${label}.close`),
    change_pct: number(raw.change_pct, `${label}.change_pct`),
    change_5d_pct: nullableNumber(raw.change_5d_pct, `${label}.change_5d_pct`),
    volume: number(raw.volume, `${label}.volume`),
    notional_volume: number(raw.notional_volume, `${label}.notional_volume`),
    currency: 'USD',
    as_of: date(raw.as_of, `${label}.as_of`),
    data_source: string(raw.data_source, `${label}.data_source`),
  };
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new UsTechMarketContractError(`${label} must be an array`);
  }
  return value;
}

export function parseUsTechMarketResponse(
  value: unknown,
  requestedDate: string
): UsTechMarketResponse {
  const raw = record(value, 'response');
  if (raw.market !== 'US') throw new UsTechMarketContractError('response.market must be US');
  if (date(raw.date, 'response.date') !== requestedDate) {
    throw new UsTechMarketContractError('response.date does not match the request');
  }
  const summary = record(raw.market_summary, 'response.market_summary');
  const sectors = array(raw.sector_performance, 'response.sector_performance').map(
    (item, index) => {
      const parsed = parseInstrument(item, `response.sector_performance[${index}]`);
      const source = record(item, `response.sector_performance[${index}]`);
      if (source.calculation_basis !== 'proxy_etf') {
        throw new UsTechMarketContractError(
          `response.sector_performance[${index}].calculation_basis is invalid`
        );
      }
      return {
        ...parsed,
        proxy_symbol: string(
          source.proxy_symbol,
          `response.sector_performance[${index}].proxy_symbol`
        ),
        calculation_basis: 'proxy_etf' as const,
      };
    }
  );
  const stocks = array(raw.representative_tech_stocks, 'response.representative_tech_stocks').map(
    (item, index) => parseInstrument(item, `response.representative_tech_stocks[${index}]`)
  );
  const etfs = array(raw.focus_etfs, 'response.focus_etfs').map((item, index) => {
    const parsed = parseInstrument(item, `response.focus_etfs[${index}]`);
    const source = record(item, `response.focus_etfs[${index}]`);
    if (source.attention_basis !== 'latest_dollar_volume') {
      throw new UsTechMarketContractError(
        `response.focus_etfs[${index}].attention_basis is invalid`
      );
    }
    return {
      ...parsed,
      attention_rank: number(source.attention_rank, `response.focus_etfs[${index}].attention_rank`),
      attention_basis: 'latest_dollar_volume' as const,
    };
  });
  return {
    market: 'US',
    date: requestedDate,
    as_of: raw.as_of == null ? null : date(raw.as_of, 'response.as_of'),
    market_summary: {
      leader_sector:
        summary.leader_sector == null
          ? null
          : (string(
              summary.leader_sector,
              'response.market_summary.leader_sector'
            ) as UsTechSector),
      leader_sector_label:
        summary.leader_sector_label == null
          ? null
          : string(summary.leader_sector_label, 'response.market_summary.leader_sector_label'),
      leader_change_pct: nullableNumber(
        summary.leader_change_pct,
        'response.market_summary.leader_change_pct'
      ),
      advancing_sectors: number(
        summary.advancing_sectors,
        'response.market_summary.advancing_sectors'
      ),
      sector_count: number(summary.sector_count, 'response.market_summary.sector_count'),
      tech_breadth_pct: number(
        summary.tech_breadth_pct,
        'response.market_summary.tech_breadth_pct'
      ),
    },
    sector_performance: sectors,
    representative_tech_stocks: stocks,
    focus_etfs: etfs,
  };
}

export async function loadUsTechMarket(
  signal: AbortSignal,
  requestedDate: string
): Promise<UsTechMarketResponse> {
  const response = await authenticatedFetch(
    `/api/v1/us-tech-market/${encodeURIComponent(requestedDate)}`,
    { signal }
  );
  if (!response.ok) throw new Error(`us-tech-market ${response.status}`);
  return parseUsTechMarketResponse((await response.json()) as unknown, requestedDate);
}
