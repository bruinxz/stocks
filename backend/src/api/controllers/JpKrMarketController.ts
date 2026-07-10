import { Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

export class JpKrMarketController {
  constructor() {
    this.getByDate = this.getByDate.bind(this);
    this.getDetail = this.getDetail.bind(this);
  }

  async getByDate(req: Request, res: Response): Promise<void> {
    try {
      const { date } = req.params;
      const market = (req.query.market as string).toUpperCase();

      const [kpiRows] = await sequelize.query(
        `SELECT
           CASE WHEN :market = 'JP' THEN
             jsonb_build_object(
               'nikkei225', (SELECT jsonb_build_object('value', k.close, 'change_pct', k.change_pct, 'as_of', k.trading_day)
                             FROM jpkr_daily_kline k WHERE k.ticker = 'NI225' AND k.trading_day = :date LIMIT 1),
               'topix', (SELECT jsonb_build_object('value', k.close, 'change_pct', k.change_pct, 'as_of', k.trading_day)
                         FROM jpkr_daily_kline k WHERE k.ticker = 'TOPX' AND k.trading_day = :date LIMIT 1)
             )
           ELSE
             jsonb_build_object(
               'kospi', (SELECT jsonb_build_object('value', k.close, 'change_pct', k.change_pct, 'as_of', k.trading_day)
                         FROM jpkr_daily_kline k WHERE k.ticker = 'KOSPI' AND k.trading_day = :date LIMIT 1)
             )
           END AS kpi`,
        { replacements: { date, market }, type: 'SELECT' as any }
      );

      const kpi = (kpiRows as any[])[0]?.kpi || {};

      const [rows] = await sequelize.query(
        `SELECT k.ticker AS symbol,
                COALESCE(f.dim_quality->>'name_local', k.ticker) AS name_local,
                COALESCE(f.dim_quality->>'name_en', k.ticker) AS name_en,
                :market AS market,
                COALESCE(f.dim_moat->>'sector', 'other') AS sector,
                k.close,
                k.change_pct,
                CASE WHEN :market = 'JP' THEN 'JPY' ELSE 'KRW' END AS currency,
                COALESCE(
                  (SELECT jsonb_agg(jsonb_build_object('title', d.title, 'doc_type', d.doc_type, 'filed_at', d.filed_at, 'source', d.source_kind, 'doc_url', d.doc_url))
                   FROM jpkr_financial_snapshot d
                   WHERE d.market = LOWER(:market) AND d.ticker = k.ticker
                     AND d.as_of_utc::date = :date),
                  '[]'::jsonb
                ) AS disclosure_events,
                COALESCE(f.dim_risk->>'revenue_by_region', '[]') AS revenue_by_region,
                COALESCE((f.dim_trend->>'fx_beta')::numeric, 0) AS fx_beta,
                COALESCE(k.is_halted, FALSE) AS is_halted,
                ARRAY[k.source_kind] AS data_sources
         FROM jpkr_daily_kline k
         LEFT JOIN jpkr_financial_snapshot f
           ON f.market = LOWER(:market) AND f.ticker = k.ticker
           AND f.as_of_utc = (SELECT MAX(f2.as_of_utc) FROM jpkr_financial_snapshot f2 WHERE f2.market = LOWER(:market) AND f2.ticker = k.ticker)
         WHERE k.exchange IN (
           CASE WHEN :market = 'JP' THEN 'tse' ELSE 'krx' END,
           CASE WHEN :market = 'JP' THEN 'ose' ELSE 'kosdaq' END
         )
         AND k.trading_day = :date
         ORDER BY k.close DESC
         LIMIT 200`,
        { replacements: { date, market }, type: 'SELECT' as any }
      );

      const parsedRows = (rows as any[]).map((r: any) => ({
        ...r,
        close: Number(r.close),
        change_pct: Number(r.change_pct),
        fx_beta: Number(r.fx_beta),
        is_halted: Boolean(r.is_halted),
        disclosure_events: typeof r.disclosure_events === 'string' ? JSON.parse(r.disclosure_events) : r.disclosure_events,
        revenue_by_region: typeof r.revenue_by_region === 'string' ? JSON.parse(r.revenue_by_region) : r.revenue_by_region,
      }));

      res.json({ kpi, rows: parsedRows, date });
    } catch (error: any) {
      logger.error(`[JpKrMarketController.getByDate] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch JPKR market data' });
    }
  }

  async getDetail(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const date = req.query.date as string;

      const [rows] = await sequelize.query(
        `SELECT k.ticker AS symbol,
                COALESCE(f.dim_quality->>'name_local', k.ticker) AS name_local,
                COALESCE(f.dim_quality->>'name_en', k.ticker) AS name_en,
                CASE WHEN k.exchange IN ('tse', 'ose') THEN 'JP' ELSE 'KR' END AS market,
                COALESCE(f.dim_moat->>'sector', 'other') AS sector,
                k.close,
                k.change_pct,
                CASE WHEN k.exchange IN ('tse', 'ose') THEN 'JPY' ELSE 'KRW' END AS currency,
                COALESCE(
                  (SELECT jsonb_agg(jsonb_build_object('title', d.title, 'doc_type', d.doc_type, 'filed_at', d.filed_at, 'source', d.source_kind, 'doc_url', d.doc_url))
                   FROM jpkr_financial_snapshot d
                   WHERE d.ticker = k.ticker AND d.as_of_utc::date = :date),
                  '[]'::jsonb
                ) AS disclosure_events,
                COALESCE(f.dim_risk->>'revenue_by_region', '[]') AS revenue_by_region,
                COALESCE((f.dim_trend->>'fx_beta')::numeric, 0) AS fx_beta,
                COALESCE(k.is_halted, FALSE) AS is_halted,
                ARRAY[k.source_kind] AS data_sources
         FROM jpkr_daily_kline k
         LEFT JOIN jpkr_financial_snapshot f
           ON f.ticker = k.ticker AND f.market = (CASE WHEN k.exchange IN ('tse', 'ose') THEN 'jp' ELSE 'kr' END)
           AND f.as_of_utc = (SELECT MAX(f2.as_of_utc) FROM jpkr_financial_snapshot f2 WHERE f2.ticker = k.ticker)
         WHERE k.ticker = :symbol
           AND k.trading_day = :date
         LIMIT 1`,
        { replacements: { symbol, date }, type: 'SELECT' as any }
      );

      if (!(rows as any[]).length) {
        res.status(404).json({ error: 'JPKR market entry not found' });
        return;
      }

      const r = (rows as any[])[0];
      res.json({
        ...r,
        close: Number(r.close),
        change_pct: Number(r.change_pct),
        fx_beta: Number(r.fx_beta),
        is_halted: Boolean(r.is_halted),
        disclosure_events: typeof r.disclosure_events === 'string' ? JSON.parse(r.disclosure_events) : r.disclosure_events,
        revenue_by_region: typeof r.revenue_by_region === 'string' ? JSON.parse(r.revenue_by_region) : r.revenue_by_region,
      });
    } catch (error: any) {
      logger.error(`[JpKrMarketController.getDetail] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch JPKR market detail' });
    }
  }
}
