import { Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

export class CatalystController {
  constructor() {
    this.getById = this.getById.bind(this);
    this.getCandidates = this.getCandidates.bind(this);
  }

  async getById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const [rows] = await sequelize.query(
        `SELECT uce.us_catalyst_event_id AS id,
                uce.catalyst_kind,
                uce.event_time_utc,
                uce.cn_trading_day_asia_shanghai,
                uce.event_source_kind,
                uce.ingest_source_hash
         FROM us_catalyst_event uce
         WHERE uce.us_catalyst_event_id = :id`,
        { replacements: { id }, type: 'SELECT' as any }
      );

      if (!(rows as any[]).length) {
        res.status(404).json({ error: 'Catalyst event not found' });
        return;
      }

      res.json((rows as any[])[0]);
    } catch (error: any) {
      logger.error(`[CatalystController.getById] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch catalyst event' });
    }
  }

  async getCandidates(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const [eventRows] = await sequelize.query(
        `SELECT us_catalyst_event_id FROM us_catalyst_event WHERE us_catalyst_event_id = :id`,
        { replacements: { id }, type: 'SELECT' as any }
      );

      if (!(eventRows as any[]).length) {
        res.status(404).json({ error: 'Catalyst event not found' });
        return;
      }

      const [candidates] = await sequelize.query(
        `SELECT acm.cn_ticker,
                acm.rating,
                acm.conviction_level,
                acm.conviction_final,
                acm.conviction_adjustments,
                acm.risk_gate_status,
                acm.score_profile
         FROM a_share_candidate_mapping acm
         WHERE acm.us_catalyst_event_id = :id
         ORDER BY acm.conviction_final DESC NULLS LAST`,
        { replacements: { id }, type: 'SELECT' as any }
      );

      res.json({ catalyst_id: id, candidates: candidates as any[] });
    } catch (error: any) {
      logger.error(`[CatalystController.getCandidates] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch catalyst candidates' });
    }
  }
}
