import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

const KPI_SQL = `
  WITH index_symbols(ticker, response_key) AS (
    VALUES ('NI225', 'nikkei225'), ('TOPX', 'topix'), ('KOSPI', 'kospi')
  ),
  index_quotes AS (
    SELECT symbols.response_key,
           latest_quote.close,
           latest_quote.trading_day,
           COALESCE(
             ROUND(
               ((latest_quote.close / NULLIF(previous_quote.close, 0)) - 1) * 100,
               4
             ),
             0
           ) AS change_pct
    FROM index_symbols symbols
    LEFT JOIN LATERAL (
      SELECT k.close, k.trading_day
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
           fx.observation_day
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
       'as_of', trading_day
     ) END FROM index_quotes WHERE response_key = 'nikkei225') AS nikkei225,
    (SELECT CASE WHEN close IS NULL THEN NULL ELSE jsonb_build_object(
       'value', close,
       'change_pct', change_pct,
       'as_of', trading_day
     ) END FROM index_quotes WHERE response_key = 'topix') AS topix,
    (SELECT CASE WHEN close IS NULL THEN NULL ELSE jsonb_build_object(
       'value', close,
       'change_pct', change_pct,
       'as_of', trading_day
     ) END FROM index_quotes WHERE response_key = 'kospi') AS kospi,
    (SELECT jsonb_build_object(
       'rate', local_per_usd,
       'change_pct', change_pct,
       'as_of', observation_day
     ) FROM latest_fx WHERE pair = 'USDJPY') AS usdjpy,
    (SELECT jsonb_build_object(
       'rate', local_per_usd,
       'change_pct', change_pct,
       'as_of', observation_day
     ) FROM latest_fx WHERE pair = 'USDKRW') AS usdkrw
`;

const MARKET_ROWS_SQL = `
  WITH current_rows AS (
    SELECT DISTINCT ON (k.exchange, k.ticker)
           k.ticker,
           k.ticker_name_local,
           k.ticker_name_en,
           k.exchange,
           k.close,
           k.currency,
           k.is_halted,
           k.source_kind
    FROM jpkr_daily_kline k
    WHERE k.trading_day = CAST(:date AS date)
      AND k.available_at_utc <= CAST(:cutoff AS timestamptz)
      AND (:symbol IS NULL OR k.ticker = :symbol)
      AND (
        :market IS NULL
        OR (:market = 'JP' AND k.exchange IN ('tse', 'ose'))
        OR (:market = 'KR' AND k.exchange IN ('krx', 'kosdaq'))
      )
    ORDER BY k.exchange, k.ticker, k.available_at_utc DESC, k.source_version DESC
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
    WHERE k.trading_day < CAST(:date AS date)
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
         COALESCE(financial.dim_moat->>'sector', 'other') AS sector,
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
    };
  }

  return {
    value: numberOrZero(snapshot.value),
    change_pct: numberOrZero(snapshot.change_pct),
    as_of: snapshot.as_of,
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

      res.json({ kpi, rows: rows.map(normalizeRow), date });
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
