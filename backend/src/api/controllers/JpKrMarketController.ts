import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

const KR_TECH_REPRESENTATIVES = new Set([
  '005930',
  '000660',
  '042700',
  '035420',
  '035720',
  '373220',
  '006400',
  '277810',
]);

const SECTOR_LABELS: Record<string, string> = {
  semiconductor: '半导体',
  internet_platform: '互联网平台',
  battery: '电池科技',
  ai_robotics: 'AI 与机器人',
  automotive: '汽车',
  consumer: '消费科技',
  pharma: '医药',
  steel: '钢铁',
  shipbuilding: '造船',
  other: '其他',
};

const KPI_SQL = `
  WITH index_symbols(ticker, response_key) AS (
    VALUES ('NI225', 'nikkei225'), ('TOPX', 'topix'), ('KOSPI', 'kospi')
  ),
  index_quotes AS (
    SELECT symbols.response_key,
           latest_quote.close,
           latest_quote.trading_day,
           latest_quote.source_kind,
           COALESCE(
             ROUND(
               ((latest_quote.close / NULLIF(previous_quote.close, 0)) - 1) * 100,
               4
             ),
             0
           ) AS change_pct
    FROM index_symbols symbols
    LEFT JOIN LATERAL (
      SELECT k.close, k.trading_day, k.source_kind
      FROM jpkr_daily_kline k
      WHERE k.ticker = symbols.ticker
        AND k.trading_day <= CAST(:date AS date)
        AND k.available_at_utc <= CAST(:cutoff AS timestamptz)
      ORDER BY k.trading_day DESC, k.available_at_utc DESC, k.source_version DESC
      LIMIT 1
    ) latest_quote ON TRUE
    LEFT JOIN LATERAL (
      SELECT k.close
      FROM jpkr_daily_kline k
      WHERE k.ticker = symbols.ticker
        AND k.trading_day < latest_quote.trading_day
        AND k.available_at_utc <= CAST(:cutoff AS timestamptz)
      ORDER BY k.trading_day DESC, k.available_at_utc DESC, k.source_version DESC
      LIMIT 1
    ) previous_quote ON TRUE
  ),
  latest_fx AS (
    SELECT DISTINCT ON (fx.pair)
           fx.pair,
           fx.local_per_usd,
           fx.change_pct,
           fx.observation_day,
           fx.source_kind
    FROM jpkr_fx_observation fx
    WHERE fx.observation_day <= CAST(:date AS date)
      AND fx.available_at_utc <= CAST(:cutoff AS timestamptz)
    ORDER BY
      fx.pair,
      fx.observation_day DESC,
      fx.available_at_utc DESC,
      fx.source_version DESC
  )
  SELECT
    (SELECT CASE WHEN close IS NULL THEN NULL ELSE jsonb_build_object(
       'value', close,
       'change_pct', change_pct,
       'as_of', trading_day,
       'source_kind', source_kind
     ) END FROM index_quotes WHERE response_key = 'nikkei225') AS nikkei225,
    (SELECT CASE WHEN close IS NULL THEN NULL ELSE jsonb_build_object(
       'value', close,
       'change_pct', change_pct,
       'as_of', trading_day,
       'source_kind', source_kind
     ) END FROM index_quotes WHERE response_key = 'topix') AS topix,
    (SELECT CASE WHEN close IS NULL THEN NULL ELSE jsonb_build_object(
       'value', close,
       'change_pct', change_pct,
       'as_of', trading_day,
       'source_kind', source_kind
     ) END FROM index_quotes WHERE response_key = 'kospi') AS kospi,
    (SELECT jsonb_build_object(
       'rate', local_per_usd,
       'change_pct', change_pct,
       'as_of', observation_day,
       'source_kind', source_kind
     ) FROM latest_fx WHERE pair = 'USDJPY') AS usdjpy,
    (SELECT jsonb_build_object(
       'rate', local_per_usd,
       'change_pct', change_pct,
       'as_of', observation_day,
       'source_kind', source_kind
     ) FROM latest_fx WHERE pair = 'USDKRW') AS usdkrw
`;

const MARKET_ROWS_SQL = `
  WITH current_rows AS (
    SELECT DISTINCT ON (k.exchange, k.ticker)
           k.ticker,
           k.ticker_name_local,
           k.ticker_name_en,
           k.exchange,
           k.trading_day,
           k.close,
           k.currency,
           k.is_halted,
           k.source_kind
    FROM jpkr_daily_kline k
    WHERE k.trading_day <= CAST(:date AS date)
      AND k.available_at_utc <= CAST(:cutoff AS timestamptz)
      AND (:symbol IS NULL OR k.ticker = :symbol)
      AND (
        :market IS NULL
        OR (:market = 'JP' AND k.exchange IN ('tse', 'ose'))
        OR (:market = 'KR' AND k.exchange IN ('krx', 'kosdaq'))
      )
    ORDER BY
      k.exchange,
      k.ticker,
      k.trading_day DESC,
      k.available_at_utc DESC,
      k.source_version DESC
  ),
  previous_rows AS (
    SELECT DISTINCT ON (k.exchange, k.ticker)
           k.ticker,
           k.exchange,
           k.close
    FROM jpkr_daily_kline k
    JOIN current_rows current_row
      ON current_row.ticker = k.ticker
     AND current_row.exchange = k.exchange
    WHERE k.trading_day < current_row.trading_day
      AND k.available_at_utc <= CAST(:cutoff AS timestamptz)
    ORDER BY
      k.exchange,
      k.ticker,
      k.trading_day DESC,
      k.available_at_utc DESC,
      k.source_version DESC
  ),
  latest_financial AS (
    SELECT DISTINCT ON (f.market_scope, f.ticker)
           f.market_scope,
           f.ticker,
           f.dim_moat,
           f.dim_trend,
           f.dim_risk,
           f.source_kind
    FROM jpkr_financial_snapshot f
    WHERE f.available_at_utc <= CAST(:cutoff AS timestamptz)
    ORDER BY
      f.market_scope,
      f.ticker,
      f.available_at_utc DESC,
      f.source_version DESC
  ),
  latest_security AS (
    SELECT DISTINCT ON (s.market_scope, s.ticker)
           s.market_scope,
           s.ticker,
           s.source_payload
    FROM jpkr_security_master s
    WHERE s.available_at_utc <= CAST(:cutoff AS timestamptz)
    ORDER BY
      s.market_scope,
      s.ticker,
      s.available_at_utc DESC,
      s.source_version DESC
  )
  SELECT current_row.ticker AS symbol,
         current_row.ticker_name_local AS name_local,
         COALESCE(
           current_row.ticker_name_en,
           current_row.ticker_name_local,
           current_row.ticker
         ) AS name_en,
         CASE
           WHEN current_row.exchange IN ('tse', 'ose') THEN 'JP'
           ELSE 'KR'
         END AS market,
         CASE
           WHEN current_row.ticker IN ('8035', '6857', '6723', '000660', '005930')
             OR COALESCE(security.source_payload->>'sector', '') = 'semiconductor'
             OR COALESCE(security.source_payload->>'sector_33_name', '') ILIKE '%%半导体%%'
             OR COALESCE(current_row.ticker_name_local, '') ILIKE '%%半导体%%'
             THEN 'semiconductor'
           WHEN current_row.ticker IN ('035420', '035720') THEN 'internet_platform'
           WHEN current_row.ticker IN ('373220', '006400') THEN 'battery'
           WHEN current_row.ticker IN ('6501', '6861', '277810') THEN 'ai_robotics'
           WHEN current_row.ticker IN ('7203', '7267', '005380') THEN 'automotive'
           WHEN current_row.ticker IN ('6758', '9984') THEN 'consumer'
           WHEN current_row.ticker IN ('4502', '4519') THEN 'pharma'
           WHEN current_row.ticker IN ('5401', '005490') THEN 'steel'
           WHEN current_row.ticker IN ('7011', '009540') THEN 'shipbuilding'
           ELSE COALESCE(financial.dim_moat->>'sector', 'other')
         END AS sector,
         current_row.trading_day AS as_of,
         current_row.close,
         COALESCE(
           ROUND(
             ((current_row.close / NULLIF(previous_row.close, 0)) - 1) * 100,
             4
           ),
           0
         ) AS change_pct,
         current_row.currency,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'title', disclosure.event_headline_local,
               'doc_type', disclosure.disclosure_kind,
               'filed_at', disclosure.event_time_utc,
               'source', disclosure.source_kind,
               'doc_url', disclosure.event_body_url
             )
             ORDER BY disclosure.event_time_utc DESC
           )
           FROM jpkr_disclosure_event disclosure
           WHERE disclosure.ticker = current_row.ticker
             AND disclosure.market_scope = CASE
               WHEN current_row.exchange IN ('tse', 'ose') THEN 'jp'
               ELSE 'kr'
             END
             AND disclosure.available_at_utc <= CAST(:cutoff AS timestamptz)
             AND disclosure.event_time_utc >= CAST(:date AS date)
             AND disclosure.event_time_utc < CAST(:date AS date) + INTERVAL '1 day'
         ), '[]'::jsonb) AS disclosure_events,
         COALESCE(
           financial.dim_moat->'revenue_by_region',
           financial.dim_risk->'revenue_by_region',
           '[]'::jsonb
         ) AS revenue_by_region,
         COALESCE((financial.dim_trend->>'fx_beta')::numeric, 0) AS fx_beta,
         current_row.is_halted,
         ARRAY_REMOVE(
           ARRAY[current_row.source_kind, financial.source_kind],
           NULL
         ) AS data_sources,
         NULL::jsonb AS score,
         NULL::jsonb AS risk_gate
  FROM current_rows current_row
  LEFT JOIN previous_rows previous_row
    ON previous_row.ticker = current_row.ticker
   AND previous_row.exchange = current_row.exchange
  LEFT JOIN latest_financial financial
    ON financial.ticker = current_row.ticker
   AND financial.market_scope = CASE
     WHEN current_row.exchange IN ('tse', 'ose') THEN 'jp'
     ELSE 'kr'
   END
  LEFT JOIN latest_security security
    ON security.ticker = current_row.ticker
   AND security.market_scope = CASE
     WHEN current_row.exchange IN ('tse', 'ose') THEN 'jp'
     ELSE 'kr'
   END
  ORDER BY current_row.close DESC
  LIMIT :limit
`;

function parseJson(value: unknown): any {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeKpiSnapshot(value: unknown): any | null {
  const snapshot = parseJson(value);
  if (!snapshot) return null;

  if ('rate' in snapshot) {
    return {
      rate: numberOrZero(snapshot.rate),
      change_pct: numberOrZero(snapshot.change_pct),
      as_of: snapshot.as_of,
      source_kind: snapshot.source_kind,
    };
  }

  return {
    value: numberOrZero(snapshot.value),
    change_pct: numberOrZero(snapshot.change_pct),
    as_of: snapshot.as_of,
    source_kind: snapshot.source_kind,
  };
}

function cutoffForDate(date: string): string {
  return `${date}T23:59:59.999Z`;
}

function normalizeRow(row: any): any {
  const score = parseJson(row.score) ?? null;
  const riskGate = parseJson(row.risk_gate) ?? null;

  return {
    ...row,
    close: numberOrZero(row.close),
    change_pct: numberOrZero(row.change_pct),
    fx_beta: numberOrZero(row.fx_beta),
    is_halted: Boolean(row.is_halted),
    disclosure_events: parseJson(row.disclosure_events) || [],
    revenue_by_region: parseJson(row.revenue_by_region) || [],
    data_sources: Array.isArray(row.data_sources) ? row.data_sources : [],
    score,
    risk_gate: riskGate,
    risk_triggers: Array.isArray(riskGate?.triggers) ? riskGate.triggers : [],
  };
}

function buildSectorPerformance(rows: any[]): any[] {
  const buckets = new Map<string, any[]>();
  rows.forEach(row => {
    const bucket = buckets.get(row.sector) ?? [];
    bucket.push(row);
    buckets.set(row.sector, bucket);
  });
  return Array.from(buckets.entries())
    .map(([sector, members]) => ({
      sector,
      sector_label: SECTOR_LABELS[sector] || sector,
      change_pct:
        Math.round(
          (members.reduce((sum, member) => sum + member.change_pct, 0) / members.length) * 10000
        ) / 10000,
      representative_count: members.length,
      representative_symbols: members.map(member => member.symbol),
      calculation_basis: 'representative_equal_weight',
      as_of: members.reduce<string | null>(
        (latest, member) =>
          !latest || String(member.as_of) > latest ? String(member.as_of) : latest,
        null
      ),
    }))
    .sort((a, b) => b.change_pct - a.change_pct);
}

export class JpKrMarketController {
  constructor() {
    this.getByDate = this.getByDate.bind(this);
    this.getDetail = this.getDetail.bind(this);
  }

  async getByDate(req: Request, res: Response): Promise<void> {
    try {
      const { date } = req.params;
      const market = String(req.query.market).toUpperCase();
      const cutoff = cutoffForDate(date);

      const kpiRows = await sequelize.query<any>(KPI_SQL, {
        replacements: { date, cutoff },
        type: QueryTypes.SELECT,
      });
      const kpiRow = kpiRows[0] || {};
      const kpi = {
        nikkei225: normalizeKpiSnapshot(kpiRow.nikkei225),
        topix: normalizeKpiSnapshot(kpiRow.topix),
        kospi: normalizeKpiSnapshot(kpiRow.kospi),
        usdjpy: normalizeKpiSnapshot(kpiRow.usdjpy),
        usdkrw: normalizeKpiSnapshot(kpiRow.usdkrw),
      };

      const rows = await sequelize.query<any>(MARKET_ROWS_SQL, {
        replacements: { date, cutoff, market, symbol: null, limit: 200 },
        type: QueryTypes.SELECT,
      });
      const normalizedRows = rows.map(normalizeRow);
      const focusedRows =
        market === 'KR'
          ? normalizedRows.filter(row => KR_TECH_REPRESENTATIVES.has(row.symbol))
          : normalizedRows;
      const sector_performance = buildSectorPerformance(focusedRows);
      const sectorRank = new Map(sector_performance.map((sector, index) => [sector.sector, index]));
      focusedRows.sort((a, b) => {
        const sectorDelta =
          (sectorRank.get(a.sector) ?? Number.MAX_SAFE_INTEGER) -
          (sectorRank.get(b.sector) ?? Number.MAX_SAFE_INTEGER);
        return sectorDelta || b.change_pct - a.change_pct;
      });
      const leader = sector_performance[0] ?? null;

      res.json({
        kpi,
        rows: focusedRows,
        sector_performance,
        market_summary: {
          focus: market === 'KR' ? 'technology_representatives' : 'market_representatives',
          leader_sector: leader?.sector ?? null,
          leader_sector_label: leader?.sector_label ?? null,
          leader_change_pct: leader?.change_pct ?? null,
          advancing_sectors: sector_performance.filter(sector => sector.change_pct > 0).length,
          sector_count: sector_performance.length,
        },
        date,
      });
    } catch (error: any) {
      logger.error(`[JpKrMarketController.getByDate] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch JPKR market data' });
    }
  }

  async getDetail(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const date = String(req.query.date);
      const cutoff = cutoffForDate(date);
      const rows = await sequelize.query<any>(MARKET_ROWS_SQL, {
        replacements: { date, cutoff, market: null, symbol, limit: 2 },
        type: QueryTypes.SELECT,
      });

      if (!rows.length) {
        res.status(404).json({ error: 'JPKR market entry not found' });
        return;
      }

      if (rows.length > 1) {
        res.status(409).json({ error: 'JPKR market entry is ambiguous' });
        return;
      }

      res.json(normalizeRow(rows[0]));
    } catch (error: any) {
      logger.error(`[JpKrMarketController.getDetail] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch JPKR market detail' });
    }
  }
}
