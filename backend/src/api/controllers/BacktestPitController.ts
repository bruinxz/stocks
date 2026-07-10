import { Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

export class BacktestPitController {
  constructor() {
    this.listSnapshots = this.listSnapshots.bind(this);
    this.getSnapshot = this.getSnapshot.bind(this);
  }

  async listSnapshots(req: Request, res: Response): Promise<void> {
    try {
      const { strategy } = req.params;
      const limit = Number(req.query.limit) || 30;
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;

      let whereClause = 'bps.strategy = :strategy';
      const replacements: Record<string, any> = { strategy, limit };

      if (from) {
        whereClause += ' AND bps.snapshot_day >= :from';
        replacements.from = from;
      }
      if (to) {
        whereClause += ' AND bps.snapshot_day <= :to';
        replacements.to = to;
      }

      const [snapshots] = await sequelize.query(
        `SELECT bps.snapshot_id,
                bps.strategy,
                bps.snapshot_day,
                bps.as_of_utc,
                bps.is_survivorship_biased,
                bps.is_delisted_at_as_of,
                bps.source_versions,
                bps.metrics
         FROM backtest_pit_snapshot bps
         WHERE ${whereClause}
         ORDER BY bps.snapshot_day DESC, bps.as_of_utc DESC
         LIMIT :limit`,
        { replacements, type: 'SELECT' as any }
      );

      res.json({ strategy, snapshots: snapshots as any[] });
    } catch (error: any) {
      logger.error(`[BacktestPitController.listSnapshots] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch backtest snapshots' });
    }
  }

  async getSnapshot(req: Request, res: Response): Promise<void> {
    try {
      const { strategy, as_of } = req.params;

      const [rows] = await sequelize.query(
        `SELECT bps.snapshot_id,
                bps.strategy,
                bps.snapshot_day,
                bps.as_of_utc,
                bps.is_survivorship_biased,
                bps.is_delisted_at_as_of,
                bps.source_versions,
                bps.metrics,
                bps.holdings,
                bps.fact_hash
         FROM backtest_pit_snapshot bps
         WHERE bps.strategy = :strategy
           AND bps.snapshot_day = :as_of
         ORDER BY bps.as_of_utc DESC
         LIMIT 1`,
        { replacements: { strategy, as_of }, type: 'SELECT' as any }
      );

      if (!(rows as any[]).length) {
        res.status(404).json({ error: 'Backtest snapshot not found' });
        return;
      }

      res.json((rows as any[])[0]);
    } catch (error: any) {
      logger.error(`[BacktestPitController.getSnapshot] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch backtest snapshot' });
    }
  }
}
