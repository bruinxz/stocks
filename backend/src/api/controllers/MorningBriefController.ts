import { Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

export class MorningBriefController {
  constructor() {
    this.getByDate = this.getByDate.bind(this);
    this.getSummary = this.getSummary.bind(this);
  }

  async getByDate(req: Request, res: Response): Promise<void> {
    try {
      const { date } = req.params;

      const [events] = await sequelize.query(
        `SELECT uce.us_catalyst_event_id AS id,
                uce.catalyst_kind,
                uce.event_time_utc,
                uce.cn_trading_day_asia_shanghai,
                uce.event_source_kind,
                uce.ingest_source_hash
         FROM us_catalyst_event uce
         WHERE uce.cn_trading_day_asia_shanghai = :date
         ORDER BY uce.event_time_utc DESC`,
        { replacements: { date }, type: 'SELECT' as any }
      );

      const result = [];
      for (const event of events as any[]) {
        const [candidates] = await sequelize.query(
          `SELECT acm.cn_ticker,
                  acm.rating,
                  acm.conviction_level,
                  acm.conviction_final,
                  acm.risk_gate_status,
                  acm.score_profile
           FROM a_share_candidate_mapping acm
           WHERE acm.us_catalyst_event_id = :eventId
           ORDER BY acm.conviction_final DESC NULLS LAST
           LIMIT 20`,
          { replacements: { eventId: event.id }, type: 'SELECT' as any }
        );

        result.push({
          ...event,
          candidates: candidates as any[],
        });
      }

      res.json({ date, events: result });
    } catch (error: any) {
      logger.error(`[MorningBriefController.getByDate] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch morning brief' });
    }
  }

  async getSummary(req: Request, res: Response): Promise<void> {
    try {
      const { date } = req.params;

      const [summaryRows] = await sequelize.query(
        `SELECT
           COUNT(DISTINCT uce.us_catalyst_event_id) AS total_catalysts,
           COUNT(DISTINCT acm.cn_ticker) AS total_candidates,
           COALESCE(AVG(acm.conviction_final), 0) AS avg_conviction
         FROM us_catalyst_event uce
         LEFT JOIN a_share_candidate_mapping acm
           ON acm.us_catalyst_event_id = uce.us_catalyst_event_id
         WHERE uce.cn_trading_day_asia_shanghai = :date`,
        { replacements: { date }, type: 'SELECT' as any }
      );

      const row = (summaryRows as any[])[0] || {};

      const [convictionRows] = await sequelize.query(
        `SELECT acm.conviction_level AS level, COUNT(*) AS cnt
         FROM a_share_candidate_mapping acm
         JOIN us_catalyst_event uce
           ON uce.us_catalyst_event_id = acm.us_catalyst_event_id
         WHERE uce.cn_trading_day_asia_shanghai = :date
           AND acm.conviction_level IS NOT NULL
         GROUP BY acm.conviction_level`,
        { replacements: { date }, type: 'SELECT' as any }
      );

      const conviction_distribution: Record<string, number> = { HIGH: 0, MED: 0, LOW: 0 };
      for (const cr of convictionRows as any[]) {
        if (cr.level in conviction_distribution) {
          conviction_distribution[cr.level] = Number(cr.cnt);
        }
      }

      const [ratingRows] = await sequelize.query(
        `SELECT acm.rating AS band, COUNT(*) AS cnt
         FROM a_share_candidate_mapping acm
         JOIN us_catalyst_event uce
           ON uce.us_catalyst_event_id = acm.us_catalyst_event_id
         WHERE uce.cn_trading_day_asia_shanghai = :date
           AND acm.rating IS NOT NULL
         GROUP BY acm.rating`,
        { replacements: { date }, type: 'SELECT' as any }
      );

      const rating_distribution: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
      for (const rr of ratingRows as any[]) {
        if (rr.band in rating_distribution) {
          rating_distribution[rr.band] = Number(rr.cnt);
        }
      }

      res.json({
        date,
        total_candidates: Number(row.total_candidates) || 0,
        total_catalysts: Number(row.total_catalysts) || 0,
        avg_conviction: Math.round((Number(row.avg_conviction) || 0) * 10) / 10,
        conviction_distribution,
        rating_distribution,
      });
    } catch (error: any) {
      logger.error(`[MorningBriefController.getSummary] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch morning brief summary' });
    }
  }
}
