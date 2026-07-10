import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

export class BacktestPitController {
  constructor() {
    this.listSnapshots = this.listSnapshots.bind(this);
    this.getSnapshot = this.getSnapshot.bind(this);
    this.getHoldings = this.getHoldings.bind(this);
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

      const snapshots = await sequelize.query<any>(
        `SELECT bps.snapshot_id,
                bps.strategy,
                bps.snapshot_day,
                bps.as_of_utc,
                bps.is_survivorship_biased,
                bps.is_delisted_at_as_of,
                bps.source_versions,
                bps.fact_hash,
                (bps.metrics->>'net_value')::numeric AS net_value,
                (bps.metrics->>'drawdown')::numeric AS drawdown,
                (bps.metrics->>'cumulative_return')::numeric AS cumulative_return,
                (bps.metrics->>'sharpe_ratio_6m')::numeric AS sharpe_ratio_6m,
                (bps.metrics->>'win_rate_6m')::numeric AS win_rate_6m
         FROM backtest_pit_snapshot bps
         WHERE ${whereClause}
         ORDER BY bps.snapshot_day DESC, bps.as_of_utc DESC
         LIMIT :limit`,
        { replacements, type: QueryTypes.SELECT }
      );

      res.json({
        strategy,
        snapshots: snapshots.map(snapshot => ({
          ...snapshot,
          net_value: snapshot.net_value == null ? null : Number(snapshot.net_value),
          drawdown: snapshot.drawdown == null ? null : Number(snapshot.drawdown),
          cumulative_return:
            snapshot.cumulative_return == null ? null : Number(snapshot.cumulative_return),
          sharpe_ratio_6m:
            snapshot.sharpe_ratio_6m == null ? null : Number(snapshot.sharpe_ratio_6m),
          win_rate_6m: snapshot.win_rate_6m == null ? null : Number(snapshot.win_rate_6m),
        })),
      });
    } catch (error: any) {
      logger.error(`[BacktestPitController.listSnapshots] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch backtest snapshots' });
    }
  }

  async getSnapshot(req: Request, res: Response): Promise<void> {
    try {
      const { strategy, as_of } = req.params;

      const rows = await sequelize.query<any>(
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
           AND bps.as_of_utc = CAST(:as_of AS timestamptz)
         LIMIT 1`,
        { replacements: { strategy, as_of }, type: QueryTypes.SELECT }
      );

      if (!rows.length) {
        res.status(404).json({ error: 'Backtest snapshot not found' });
        return;
      }

      res.json(rows[0]);
    } catch (error: any) {
      logger.error(`[BacktestPitController.getSnapshot] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch backtest snapshot' });
    }
  }

  async getHoldings(req: Request, res: Response): Promise<void> {
    try {
      const { strategy, as_of } = req.params;

      const rows = await sequelize.query<any>(
        `SELECT bps.holdings
         FROM backtest_pit_snapshot bps
         WHERE bps.strategy = :strategy
           AND bps.as_of_utc = CAST(:as_of AS timestamptz)
         LIMIT 1`,
        { replacements: { strategy, as_of }, type: QueryTypes.SELECT }
      );

      if (!rows.length) {
        res.status(404).json({ error: 'Backtest snapshot not found' });
        return;
      }

      const holdings = rows[0].holdings;
      res.json({ holdings: typeof holdings === 'string' ? JSON.parse(holdings) : holdings || [] });
    } catch (error: any) {
      logger.error(`[BacktestPitController.getHoldings] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch backtest holdings' });
    }
  }
}
