import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

const REQUIRED_PIT_CHECKPOINTS = 27;

interface BacktestEvidenceBlocker {
  code: string;
  title: string;
  detail: string;
  observed?: number;
  required?: number;
  unit?: string;
}

interface BacktestEvidenceStatus {
  state: 'ready' | 'blocked';
  snapshot_count: number;
  required_checkpoint_count: number;
  blockers: BacktestEvidenceBlocker[];
}

interface CnAEvidenceReadinessRow {
  snapshot_count: number | string;
  stock_count: number | string;
  listing_date_count: number | string;
  historical_member_count: number | string;
  factor_day_count: number | string;
  complete_factor_day_count: number | string;
  available_at_table_count: number | string;
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function trustedPitPredicate(alias: string, marketScope: string): string {
  const base = `${alias}.is_survivorship_biased = FALSE
    AND NOT EXISTS (
      SELECT 1
        FROM jsonb_each_text(${alias}.source_versions) source
       WHERE LOWER(source.value) ~ '(fixture|synthetic|mock|seed)'
    )`;
  if (marketScope !== 'cn_a') return base;
  return `${base}
    AND ${alias}.source_versions->>'calendar' LIKE 'production-daily-bars-calendar@%'
    AND ${alias}.source_versions->>'membership' = 'stock-master-listing-history@1.0.0'
    AND ${alias}.source_versions->>'prices' = 'daily-bars-close-execution@2.0.0'
    AND ${alias}.source_versions->>'ranking' = 'six-factor-prior-session@2.0.0'
    AND ${alias}.source_versions->>'cost_model' = 'commission5-slippage5@1.0.0'`;
}

async function loadEvidenceStatus(
  strategy: string,
  marketScope: string
): Promise<BacktestEvidenceStatus> {
  const trustedPredicate = trustedPitPredicate('bps', marketScope);
  if (marketScope !== 'cn_a') {
    const [row] = await sequelize.query<{ snapshot_count: number | string }>(
      `SELECT COUNT(*)::int AS snapshot_count
         FROM backtest_pit_snapshot bps
        WHERE bps.strategy = :strategy
          AND bps.market_scope = :market_scope
          AND ${trustedPredicate}`,
      { replacements: { strategy, market_scope: marketScope }, type: QueryTypes.SELECT }
    );
    const snapshotCount = numeric(row?.snapshot_count);
    const enoughSnapshots = snapshotCount >= REQUIRED_PIT_CHECKPOINTS;
    return {
      state: enoughSnapshots ? 'ready' : 'blocked',
      snapshot_count: snapshotCount,
      required_checkpoint_count: REQUIRED_PIT_CHECKPOINTS,
      blockers: enoughSnapshots
        ? []
        : [
            snapshotCount === 0
              ? {
                  code: 'market_history_not_connected',
                  title: '该市场的历史时点证据源尚未接入',
                  detail: '当前没有可核验的历史成分、因子可用时间与持仓快照，因此不展示收益曲线。',
                }
              : {
                  code: 'pit_replay_not_materialized',
                  title: '历史时点快照尚未完整生成',
                  detail: `需要 ${REQUIRED_PIT_CHECKPOINTS} 个检查点，当前只有 ${snapshotCount} 个，暂不展示不完整收益曲线。`,
                  observed: snapshotCount,
                  required: REQUIRED_PIT_CHECKPOINTS,
                  unit: '个快照',
                },
          ],
    };
  }

  const [row] = await sequelize.query<CnAEvidenceReadinessRow>(
    `WITH pit_snapshots AS (
       SELECT COUNT(*)::int AS snapshot_count
         FROM backtest_pit_snapshot bps
        WHERE bps.strategy = :strategy
          AND bps.market_scope = :market_scope
          AND ${trustedPredicate}
     ), stock_master AS (
       SELECT COUNT(*)::int AS stock_count,
              COUNT(listing_date)::int AS listing_date_count,
              COUNT(*) FILTER (
                WHERE delisting_date IS NOT NULL OR is_listed = FALSE
              )::int AS historical_member_count
         FROM stocks
        WHERE type = 'stock'
     ), factor_day_coverage AS (
       SELECT fs.trade_date,
              COUNT(DISTINCT fs.stock_code)::int AS universe_size,
              COUNT(DISTINCT fs.stock_code) FILTER (
                WHERE fs.factor_name IN ('quality', 'quality_high')
                  AND fs.raw_value IS NOT NULL
                  AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                      <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
              )::int AS q_coverage,
              COUNT(DISTINCT fs.stock_code) FILTER (
                WHERE fs.factor_name IN ('growth', 'earnings_surprise', 'analyst_consensus')
                  AND fs.raw_value IS NOT NULL
                  AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                      <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
              )::int AS g_coverage,
              COUNT(DISTINCT fs.stock_code) FILTER (
                WHERE fs.factor_name = 'value' AND fs.raw_value IS NOT NULL
                  AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                      <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
              )::int AS v_coverage,
              COUNT(DISTINCT fs.stock_code) FILTER (
                WHERE fs.factor_name IN ('momentum', 'money_flow', 'northbound')
                  AND fs.raw_value IS NOT NULL
                  AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                      <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
              )::int AS m_coverage,
              COUNT(DISTINCT fs.stock_code) FILTER (
                WHERE fs.factor_name IN ('gradual_breakout', 'industry_momentum')
                  AND fs.raw_value IS NOT NULL
                  AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                      <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
              )::int AS t_coverage,
              COUNT(DISTINCT fs.stock_code) FILTER (
                WHERE fs.factor_name IN ('low_vol', 'liquidity')
                  AND fs.raw_value IS NOT NULL
                  AND NULLIF(to_jsonb(fs)->>'available_at_utc', '')::timestamptz
                      <= (fs.trade_date::text || 'T15:00:00Z')::timestamptz
              )::int AS r_coverage
         FROM factor_scores fs
        GROUP BY fs.trade_date
     ), factor_history AS (
       SELECT COUNT(*)::int AS factor_day_count,
              COUNT(*) FILTER (
                WHERE q_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
                  AND g_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
                  AND v_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
                  AND m_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
                  AND t_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
                  AND r_coverage >= GREATEST(500, CEIL(universe_size * 0.20))
              )::int AS complete_factor_day_count
         FROM factor_day_coverage
     ), availability AS (
       SELECT COUNT(DISTINCT table_name)::int AS available_at_table_count
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'factor_scores', 'stock_fundamental_factors', 'stock_valuation_factors'
          )
          AND column_name = 'available_at_utc'
     )
     SELECT pit_snapshots.snapshot_count,
            stock_master.stock_count,
            stock_master.listing_date_count,
            stock_master.historical_member_count,
            factor_history.factor_day_count,
            factor_history.complete_factor_day_count,
            availability.available_at_table_count
       FROM pit_snapshots
       CROSS JOIN stock_master
       CROSS JOIN factor_history
       CROSS JOIN availability`,
    {
      replacements: { strategy, market_scope: marketScope },
      type: QueryTypes.SELECT,
    }
  );

  const snapshotCount = numeric(row?.snapshot_count);
  const stockCount = numeric(row?.stock_count);
  const listingDateCount = numeric(row?.listing_date_count);
  const completeFactorDayCount = numeric(row?.complete_factor_day_count);
  const availableAtTableCount = numeric(row?.available_at_table_count);
  const blockers: BacktestEvidenceBlocker[] = [];

  if (stockCount === 0 || listingDateCount < stockCount) {
    blockers.push({
      code: 'security_lifecycle_incomplete',
      title: '证券上市与退市时间不完整',
      detail: `仅 ${listingDateCount}/${stockCount} 只股票记录了上市日，无法还原历史时点的真实可投资范围，也无法排除幸存者偏差。`,
      observed: listingDateCount,
      required: stockCount,
      unit: '只股票',
    });
  }

  if (completeFactorDayCount < REQUIRED_PIT_CHECKPOINTS) {
    blockers.push({
      code: 'factor_history_insufficient',
      title: '六维因子历史截面不足',
      detail: `近 6 个月回放需要 ${REQUIRED_PIT_CHECKPOINTS} 个完整检查点，当前只有 ${completeFactorDayCount} 个交易日同时满足质量、成长、估值、动量、趋势和风险覆盖要求。`,
      observed: completeFactorDayCount,
      required: REQUIRED_PIT_CHECKPOINTS,
      unit: '个检查点',
    });
  }

  if (availableAtTableCount < 3) {
    blockers.push({
      code: 'fact_availability_unproven',
      title: '历史事实的可用时间尚未留痕',
      detail:
        '因子、财务与估值事实尚未全部记录 available_at_utc，无法证明回放只使用了当时已经公开的数据。',
      observed: availableAtTableCount,
      required: 3,
      unit: '张事实表',
    });
  }

  if (snapshotCount < REQUIRED_PIT_CHECKPOINTS) {
    blockers.push({
      code: 'pit_replay_not_materialized',
      title: '历史时点快照尚未完整生成',
      detail: `需要 ${REQUIRED_PIT_CHECKPOINTS} 个检查点，当前只有 ${snapshotCount} 个；即使已有部分快照，也不展示不完整收益曲线。`,
      observed: snapshotCount,
      required: REQUIRED_PIT_CHECKPOINTS,
      unit: '个快照',
    });
  }

  return {
    state: blockers.length ? 'blocked' : 'ready',
    snapshot_count: snapshotCount,
    required_checkpoint_count: REQUIRED_PIT_CHECKPOINTS,
    blockers,
  };
}

function normalizeHoldingRows(rows: unknown[]): { ok: true; holdings: any[] } | { ok: false } {
  const holdings: any[] = [];
  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    const row = value as Record<string, unknown>;
    if (
      (typeof row.weight !== 'number' && typeof row.weight !== 'string') ||
      (typeof row.return_since_entry !== 'number' && typeof row.return_since_entry !== 'string') ||
      (typeof row.weight === 'string' && row.weight.trim() === '') ||
      (typeof row.return_since_entry === 'string' && row.return_since_entry.trim() === '')
    ) {
      return { ok: false };
    }
    const weight = Number(row.weight);
    const returnSinceEntry = Number(row.return_since_entry);
    if (
      typeof row.ticker !== 'string' ||
      row.ticker.trim().length === 0 ||
      !Number.isFinite(weight) ||
      !Number.isFinite(returnSinceEntry) ||
      typeof row.is_stale !== 'boolean'
    ) {
      return { ok: false };
    }
    holdings.push({
      ticker: row.ticker,
      weight,
      return_since_entry: returnSinceEntry,
      is_stale: row.is_stale,
    });
  }
  return { ok: true, holdings };
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
      const marketScope = String(req.query.market_scope);
      const limit = Number(req.query.limit) || 30;
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;

      let whereClause = `bps.strategy = :strategy
        AND bps.market_scope = :market_scope
        AND ${trustedPitPredicate('bps', marketScope)}`;
      const replacements: Record<string, any> = {
        strategy,
        market_scope: marketScope,
        limit,
      };

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
                bps.market_scope,
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

      const evidenceStatus = await loadEvidenceStatus(strategy, marketScope);

      res.json({
        strategy,
        market_scope: marketScope,
        evidence_status: evidenceStatus,
        snapshots:
          evidenceStatus.state === 'ready'
            ? snapshots.map(snapshot => ({
                ...snapshot,
                net_value: snapshot.net_value == null ? null : Number(snapshot.net_value),
                drawdown: snapshot.drawdown == null ? null : Number(snapshot.drawdown),
                cumulative_return:
                  snapshot.cumulative_return == null ? null : Number(snapshot.cumulative_return),
                sharpe_ratio_6m:
                  snapshot.sharpe_ratio_6m == null ? null : Number(snapshot.sharpe_ratio_6m),
                win_rate_6m: snapshot.win_rate_6m == null ? null : Number(snapshot.win_rate_6m),
              }))
            : [],
      });
    } catch (error: any) {
      logger.error(`[BacktestPitController.listSnapshots] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch backtest snapshots' });
    }
  }

  async getSnapshot(req: Request, res: Response): Promise<void> {
    try {
      const { strategy, as_of } = req.params;
      const marketScope = String(req.query.market_scope);

      // PostgreSQL timestamptz equality compares instants, so equivalent offsets
      // match the same row. The schema key also includes snapshot_day; LIMIT 2
      // makes any cross-day duplicate instant fail closed instead of choosing one.
      const rows = await sequelize.query<any>(
        `SELECT bps.snapshot_id,
                bps.strategy,
                bps.market_scope,
                bps.snapshot_day,
                bps.as_of_utc,
                bps.is_survivorship_biased,
                bps.is_delisted_at_as_of,
                bps.source_versions,
                bps.metrics,
                bps.fact_hash
         FROM backtest_pit_snapshot bps
         WHERE bps.strategy = :strategy
           AND bps.market_scope = :market_scope
           AND bps.as_of_utc = CAST(:as_of AS timestamptz)
           AND ${trustedPitPredicate('bps', marketScope)}
         LIMIT 2`,
        {
          replacements: { strategy, market_scope: marketScope, as_of },
          type: QueryTypes.SELECT,
        }
      );

      if (!rows.length) {
        res.status(404).json({ error: 'Backtest snapshot not found' });
        return;
      }

      if (rows.length > 1) {
        res.status(409).json({ error: 'Backtest snapshot is ambiguous' });
        return;
      }

      const snapshot = rows[0];
      const holdingRows = await sequelize.query<any>(
        `SELECT bph.ticker,
                bph.weight,
                bph.return_since_entry,
                bph.is_stale
         FROM backtest_pit_holding bph
         WHERE bph.snapshot_id = :snapshot_id
           AND bph.market_scope = :market_scope
           AND bph.snapshot_as_of_utc = CAST(:as_of AS timestamptz)
         ORDER BY bph.position_order ASC`,
        {
          replacements: {
            snapshot_id: snapshot.snapshot_id,
            market_scope: marketScope,
            as_of,
          },
          type: QueryTypes.SELECT,
        }
      );
      const normalized = normalizeHoldingRows(holdingRows);
      if (!normalized.ok) {
        res.status(500).json({ error: 'Invalid backtest holdings payload' });
        return;
      }

      res.json({ ...snapshot, holdings: normalized.holdings });
    } catch (error: any) {
      logger.error(`[BacktestPitController.getSnapshot] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch backtest snapshot' });
    }
  }

  async getHoldings(req: Request, res: Response): Promise<void> {
    try {
      const { strategy, as_of } = req.params;
      const marketScope = String(req.query.market_scope);

      // Keep the same exact-instant and duplicate-detection semantics as detail.
      const rows = await sequelize.query<any>(
        `SELECT bps.snapshot_id
         FROM backtest_pit_snapshot bps
         WHERE bps.strategy = :strategy
           AND bps.market_scope = :market_scope
           AND bps.as_of_utc = CAST(:as_of AS timestamptz)
           AND ${trustedPitPredicate('bps', marketScope)}
         LIMIT 2`,
        {
          replacements: { strategy, market_scope: marketScope, as_of },
          type: QueryTypes.SELECT,
        }
      );

      if (!rows.length) {
        res.status(404).json({ error: 'Backtest snapshot not found' });
        return;
      }

      if (rows.length > 1) {
        res.status(409).json({ error: 'Backtest snapshot is ambiguous' });
        return;
      }

      const holdingRows = await sequelize.query<any>(
        `SELECT bph.ticker,
                bph.weight,
                bph.return_since_entry,
                bph.is_stale
         FROM backtest_pit_holding bph
         WHERE bph.snapshot_id = :snapshot_id
           AND bph.market_scope = :market_scope
           AND bph.snapshot_as_of_utc = CAST(:as_of AS timestamptz)
         ORDER BY bph.position_order ASC`,
        {
          replacements: {
            snapshot_id: rows[0].snapshot_id,
            market_scope: marketScope,
            as_of,
          },
          type: QueryTypes.SELECT,
        }
      );
      const normalized = normalizeHoldingRows(holdingRows);
      if (!normalized.ok) {
        res.status(500).json({ error: 'Invalid backtest holdings payload' });
        return;
      }

      res.json({ holdings: normalized.holdings });
    } catch (error: any) {
      logger.error(`[BacktestPitController.getHoldings] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch backtest holdings' });
    }
  }
}
