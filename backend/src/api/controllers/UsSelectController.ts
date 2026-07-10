import { Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

export class UsSelectController {
  constructor() {
    this.getByDate = this.getByDate.bind(this);
    this.getSummary = this.getSummary.bind(this);
  }

  async getByDate(req: Request, res: Response): Promise<void> {
    try {
      const { date } = req.params;
      const limit = Number(req.query.limit) || 50;

      const [candidates] = await sequelize.query(
        `SELECT acm.cn_ticker,
                acm.rating,
                acm.conviction_level,
                acm.conviction_final,
                acm.conviction_adjustments,
                acm.risk_gate_status,
                acm.score_profile,
                uce.catalyst_kind,
                uce.event_time_utc
         FROM a_share_candidate_mapping acm
         JOIN us_catalyst_event uce
           ON uce.us_catalyst_event_id = acm.us_catalyst_event_id
         WHERE uce.cn_trading_day_asia_shanghai = :date
           AND acm.score_profile = 'us_preferred'
         ORDER BY acm.rating ASC, acm.conviction_final DESC NULLS LAST
         LIMIT :limit`,
        { replacements: { date, limit }, type: 'SELECT' as any }
      );

      res.json({ date, profile: 'us_preferred', candidates: candidates as any[] });
    } catch (error: any) {
      logger.error(`[UsSelectController.getByDate] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch US select candidates' });
    }
  }

  async getSummary(req: Request, res: Response): Promise<void> {
    try {
      const { date } = req.params;

      const [summaryRows] = await sequelize.query(
        `SELECT
           COUNT(DISTINCT acm.cn_ticker) AS total_candidates,
           COALESCE(AVG(acm.conviction_final), 0) AS avg_conviction
         FROM a_share_candidate_mapping acm
         JOIN us_catalyst_event uce
           ON uce.us_catalyst_event_id = acm.us_catalyst_event_id
         WHERE uce.cn_trading_day_asia_shanghai = :date
           AND acm.score_profile = 'us_preferred'`,
        { replacements: { date }, type: 'SELECT' as any }
      );

      const row = (summaryRows as any[])[0] || {};

      const [ratingRows] = await sequelize.query(
        `SELECT acm.rating AS band, COUNT(*) AS cnt
         FROM a_share_candidate_mapping acm
         JOIN us_catalyst_event uce
           ON uce.us_catalyst_event_id = acm.us_catalyst_event_id
         WHERE uce.cn_trading_day_asia_shanghai = :date
           AND acm.score_profile = 'us_preferred'
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
        profile: 'us_preferred',
        total_candidates: Number(row.total_candidates) || 0,
        avg_conviction: Math.round((Number(row.avg_conviction) || 0) * 10) / 10,
        rating_distribution,
      });
    } catch (error: any) {
      logger.error(`[UsSelectController.getSummary] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch US select summary' });
    }
  }
}
