import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

function isValidHoldingRow(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.ticker === 'string' &&
    row.ticker.trim().length > 0 &&
    typeof row.weight === 'number' &&
    Number.isFinite(row.weight) &&
    typeof row.return_since_entry === 'number' &&
    Number.isFinite(row.return_since_entry) &&
    typeof row.is_stale === 'boolean'
  );
}

function parseHoldingsPayload(value: unknown): { ok: true; holdings: any[] } | { ok: false } {
  if (value == null) return { ok: true, holdings: [] };

  try {
    const holdings = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(holdings) && holdings.every(isValidHoldingRow)
      ? { ok: true, holdings }
      : { ok: false };
  } catch (_error) {
    return { ok: false };
  }
}

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

      // PostgreSQL timestamptz equality compares instants, so equivalent offsets
      // match the same row. The schema key also includes snapshot_day; LIMIT 2
      // makes any cross-day duplicate instant fail closed instead of choosing one.
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
         LIMIT 2`,
        { replacements: { strategy, as_of }, type: QueryTypes.SELECT }
      );

      if (!rows.length) {
        res.status(404).json({ error: 'Backtest snapshot not found' });
        return;
      }

      if (rows.length > 1) {
        res.status(409).json({ error: 'Backtest snapshot is ambiguous' });
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

      // Keep the same exact-instant and duplicate-detection semantics as detail.
      const rows = await sequelize.query<any>(
        `SELECT bps.holdings
         FROM backtest_pit_snapshot bps
         WHERE bps.strategy = :strategy
           AND bps.as_of_utc = CAST(:as_of AS timestamptz)
         LIMIT 2`,
        { replacements: { strategy, as_of }, type: QueryTypes.SELECT }
      );

      if (!rows.length) {
        res.status(404).json({ error: 'Backtest snapshot not found' });
        return;
      }

      if (rows.length > 1) {
        res.status(409).json({ error: 'Backtest snapshot is ambiguous' });
        return;
      }

      const holdings = rows[0].holdings;
      const parsed = parseHoldingsPayload(holdings);
      if (!parsed.ok) {
        res.status(500).json({ error: 'Invalid backtest holdings payload' });
        return;
      }

      res.json({ holdings: parsed.holdings });
    } catch (error: any) {
      logger.error(`[BacktestPitController.getHoldings] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch backtest holdings' });
    }
  }
}
