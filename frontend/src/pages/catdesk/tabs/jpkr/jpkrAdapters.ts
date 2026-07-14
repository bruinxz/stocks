import type {
  JpKrDisclosureEvent,
  JpKrFxKpiSnapshot,
  JpKrIndexKpiSnapshot,
  JpKrKpi,
  JpKrMarket,
  JpKrMarketResponse,
  JpKrMarketRow,
  JpKrSector,
} from './types';

type UnknownRecord = Record<string, unknown>;

const MARKET_SET = new Set<JpKrMarket>(['JP', 'KR']);
const SECTOR_SET = new Set<JpKrSector>([
  'semiconductor',
  'automotive',
  'battery',
  'ai_robotics',
  'pharma',
  'steel',
  'shipbuilding',
  'consumer',
  'other',
]);
const DISCLOSURE_SOURCE_SET = new Set<JpKrDisclosureEvent['source']>([
  'jpx-edinet',
  'dart',
  'kind',
]);
const KPI_KEYS = ['nikkei225', 'topix', 'kospi', 'usdjpy', 'usdkrw'] as const;

export class JpKrContractError extends Error {
  constructor(message: string) {
    super(`JPKR API contract error: ${message}`);
    this.name = 'JpKrContractError';
  }
}

function exactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string
): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JpKrContractError(`${label} must be an object`);
  }
  const record = value as UnknownRecord;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const unexpected = Object.keys(record).filter(key => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new JpKrContractError(`${label} contains unexpected field "${unexpected[0]}"`);
  }
  const missing = requiredKeys.find(key => !(key in record));
  if (missing) {
    throw new JpKrContractError(`${label}.${missing} is required`);
  }
  return record;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new JpKrContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new JpKrContractError(`${label} must be a boolean`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string, minimum?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new JpKrContractError(`${label} must be a finite number`);
  }
  if (minimum !== undefined && value < minimum) {
    throw new JpKrContractError(`${label} must be at least ${minimum}`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (parsed <= 0) {
    throw new JpKrContractError(`${label} must be greater than zero`);
  }
  return parsed;
}

function dateString(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
    throw new JpKrContractError(`${label} must be YYYY-MM-DD`);
  }
  const normalized = new Date(`${parsed}T00:00:00.000Z`);
  if (!Number.isFinite(normalized.valueOf()) || normalized.toISOString().slice(0, 10) !== parsed) {
    throw new JpKrContractError(`${label} must be a valid calendar date`);
  }
  return parsed;
}

function isoDateTime(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed) ||
    !Number.isFinite(Date.parse(parsed))
  ) {
    throw new JpKrContractError(`${label} must be an ISO-8601 timestamp with timezone`);
  }
  return parsed;
}

function optionalHttpUrl(value: unknown, label: string): string | undefined {
  if (value == null) return undefined;
  const parsed = requiredString(value, label);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new JpKrContractError(`${label} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new JpKrContractError(`${label} must be an absolute HTTP(S) URL`);
  }
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new JpKrContractError(`${label} must be an array`);
  }
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function assertNullableRecord(value: unknown, label: string): void {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new JpKrContractError(`${label} must be an object or null`);
  }
}

function assertRecordArray(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new JpKrContractError(`${label} must be an array`);
  }
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new JpKrContractError(`${label}[${index}] must be an object`);
    }
  });
}

function parseMarket(value: unknown, label: string): JpKrMarket {
  if (typeof value !== 'string' || !MARKET_SET.has(value as JpKrMarket)) {
    throw new JpKrContractError(`${label} must be JP or KR`);
  }
  return value as JpKrMarket;
}

function parseSector(value: unknown, label: string): JpKrSector {
  if (typeof value !== 'string' || !SECTOR_SET.has(value as JpKrSector)) {
    throw new JpKrContractError(`${label} is not an authorized sector`);
  }
  return value as JpKrSector;
}

function parseDisclosure(value: unknown, rowIndex: number, index: number): JpKrDisclosureEvent {
  const label = `rows[${rowIndex}].disclosure_events[${index}]`;
  const raw = exactRecord(value, ['title', 'doc_type', 'filed_at', 'source'], ['doc_url'], label);
  if (
    typeof raw.source !== 'string' ||
    !DISCLOSURE_SOURCE_SET.has(raw.source as JpKrDisclosureEvent['source'])
  ) {
    throw new JpKrContractError(`${label}.source is not an authorized disclosure source`);
  }
  const docUrl = optionalHttpUrl(raw.doc_url, `${label}.doc_url`);
  return {
    title: requiredString(raw.title, `${label}.title`),
    doc_type: requiredString(raw.doc_type, `${label}.doc_type`),
    filed_at: isoDateTime(raw.filed_at, `${label}.filed_at`),
    source: raw.source as JpKrDisclosureEvent['source'],
    ...(docUrl ? { doc_url: docUrl } : {}),
  };
}

function parseMarketRow(value: unknown, rowIndex: number): JpKrMarketRow {
  const label = `rows[${rowIndex}]`;
  const raw = exactRecord(
    value,
    [
      'symbol',
      'name_local',
      'name_en',
      'market',
      'sector',
      'close',
      'change_pct',
      'currency',
      'disclosure_events',
      'revenue_by_region',
      'fx_beta',
      'is_halted',
      'data_sources',
    ],
    ['score', 'risk_gate', 'risk_triggers'],
    label
  );
  const market = parseMarket(raw.market, `${label}.market`);
  const expectedCurrency = market === 'JP' ? 'JPY' : 'KRW';
  if (raw.currency !== expectedCurrency) {
    throw new JpKrContractError(`${label}.currency must be ${expectedCurrency} for ${market}`);
  }
  if (!Array.isArray(raw.disclosure_events)) {
    throw new JpKrContractError(`${label}.disclosure_events must be an array`);
  }
  if (!Array.isArray(raw.revenue_by_region)) {
    throw new JpKrContractError(`${label}.revenue_by_region must be an array`);
  }
  assertNullableRecord(raw.score, `${label}.score`);
  assertNullableRecord(raw.risk_gate, `${label}.risk_gate`);
  assertRecordArray(raw.risk_triggers, `${label}.risk_triggers`);

  return {
    symbol: requiredString(raw.symbol, `${label}.symbol`),
    name_local: requiredString(raw.name_local, `${label}.name_local`),
    name_en: requiredString(raw.name_en, `${label}.name_en`),
    market,
    sector: parseSector(raw.sector, `${label}.sector`),
    close: finiteNumber(raw.close, `${label}.close`, 0),
    change_pct: finiteNumber(raw.change_pct, `${label}.change_pct`),
    currency: expectedCurrency,
    disclosure_events: raw.disclosure_events.map((event, index) =>
      parseDisclosure(event, rowIndex, index)
    ),
    revenue_by_region: raw.revenue_by_region.map((region, index) => {
      const regionLabel = `${label}.revenue_by_region[${index}]`;
      const regionRecord = exactRecord(region, ['region', 'pct'], [], regionLabel);
      return {
        region: requiredString(regionRecord.region, `${regionLabel}.region`),
        pct: finiteNumber(regionRecord.pct, `${regionLabel}.pct`, 0),
      };
    }),
    fx_beta: finiteNumber(raw.fx_beta, `${label}.fx_beta`),
    is_halted: requiredBoolean(raw.is_halted, `${label}.is_halted`),
    data_sources: stringArray(raw.data_sources, `${label}.data_sources`),
  };
}

function parseIndexKpi(
  value: unknown,
  key: 'nikkei225' | 'topix' | 'kospi',
  requestedDate: string
): JpKrIndexKpiSnapshot | null {
  if (value == null) return null;
  const label = `response.kpi.${key}`;
  const raw = exactRecord(value, ['value', 'change_pct', 'as_of'], [], label);
  const asOf = dateString(raw.as_of, `${label}.as_of`);
  if (asOf > requestedDate) {
    throw new JpKrContractError(`${label}.as_of cannot be after the requested date`);
  }
  return {
    value: positiveNumber(raw.value, `${label}.value`),
    change_pct: finiteNumber(raw.change_pct, `${label}.change_pct`),
    as_of: asOf,
  };
}

function parseFxKpi(
  value: unknown,
  key: 'usdjpy' | 'usdkrw',
  requestedDate: string
): JpKrFxKpiSnapshot | null {
  if (value == null) return null;
  const label = `response.kpi.${key}`;
  const raw = exactRecord(value, ['rate', 'change_pct', 'as_of'], [], label);
  const asOf = dateString(raw.as_of, `${label}.as_of`);
  if (asOf > requestedDate) {
    throw new JpKrContractError(`${label}.as_of cannot be after the requested date`);
  }
  return {
    rate: positiveNumber(raw.rate, `${label}.rate`),
    change_pct: finiteNumber(raw.change_pct, `${label}.change_pct`),
    as_of: asOf,
  };
}

function parseKpi(value: unknown, requestedDate: string): JpKrKpi {
  const raw = exactRecord(value, [], KPI_KEYS, 'response.kpi');
  return {
    nikkei225: parseIndexKpi(raw.nikkei225, 'nikkei225', requestedDate),
    topix: parseIndexKpi(raw.topix, 'topix', requestedDate),
    kospi: parseIndexKpi(raw.kospi, 'kospi', requestedDate),
    usdjpy: parseFxKpi(raw.usdjpy, 'usdjpy', requestedDate),
    usdkrw: parseFxKpi(raw.usdkrw, 'usdkrw', requestedDate),
  };
}

export function parseJpKrMarketResponse(
  value: unknown,
  requestedDate: string,
  requestedMarket: JpKrMarket
): JpKrMarketResponse {
  const expectedDate = dateString(requestedDate, 'requested date');
  const raw = exactRecord(value, ['kpi', 'rows', 'date'], [], 'response');
  const responseDate = dateString(raw.date, 'response.date');
  if (responseDate !== expectedDate) {
    throw new JpKrContractError(
      `response.date "${responseDate}" does not match request "${expectedDate}"`
    );
  }
  if (!Array.isArray(raw.rows)) {
    throw new JpKrContractError('response.rows must be an array');
  }
  const rows = raw.rows.map(parseMarketRow);
  const mismatchedIndex = rows.findIndex(row => row.market !== requestedMarket);
  if (mismatchedIndex >= 0) {
    throw new JpKrContractError(
      `rows[${mismatchedIndex}].market does not match request "${requestedMarket}"`
    );
  }
  return {
    kpi: parseKpi(raw.kpi, expectedDate),
    rows,
    date: responseDate,
  };
}

export function parseJpKrDetailResponse(value: unknown, requestedSymbol: string): JpKrMarketRow {
  const expectedSymbol = requiredString(requestedSymbol, 'requested symbol');
  const row = parseMarketRow(value, 0);
  if (row.symbol !== expectedSymbol) {
    throw new JpKrContractError(
      `detail symbol "${row.symbol}" does not match request "${expectedSymbol}"`
    );
  }
  return row;
}
