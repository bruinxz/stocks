import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

const VALID_MARKETS = ['A', 'US', 'JP', 'KR'];

function parseJson(value: unknown): any {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function normalizeCandidate(row: any): any {
  const score = objectOrNull(row.score);
  const riskGate = objectOrNull(row.risk_gate);
  const entryPlan = objectOrNull(row.entry_plan);
  const conviction = objectOrNull(row.conviction);

  return {
    symbol: row.symbol,
    name: row.name,
    score,
    rating_band: score?.rating || row.rating_band,
    conviction,
    risk_gate: riskGate,
    entry_plan: entryPlan,
    latest_catalyst: parseJson(row.latest_catalyst) ?? null,
    market: row.market,
    stage: row.stage,
    conclusion: row.conclusion,
  };
}

export class MultibaggerController {
  constructor() {
    this.getCandidates = this.getCandidates.bind(this);
    this.getDetail = this.getDetail.bind(this);
  }

  async getCandidates(req: Request, res: Response): Promise<void> {
    try {
      const stageParam = req.query.stage as string | undefined;
      const conclusionParam = req.query.conclusion as string | undefined;
      const marketParam = req.query.market as string | undefined;

      let whereClause = '1=1';
      const replacements: Record<string, any> = {};

      if (stageParam) {
        const stages = stageParam.split(',');
        whereClause += ' AND mu.filter_pass_bitmap IS NOT NULL';
        replacements.stages = stages;
        whereClause += ` AND mu.fundamental_snapshot->>'stage' IN (:stages)`;
      }

      if (conclusionParam) {
        const conclusions = conclusionParam.split(',');
        replacements.conclusions = conclusions;
        whereClause += ` AND mu.fundamental_snapshot->>'conclusion' IN (:conclusions)`;
      }

      if (marketParam && VALID_MARKETS.includes(marketParam)) {
        replacements.market = marketParam;
        whereClause += ` AND CASE
          WHEN mu.exchange IN ('sh', 'sz', 'bj') THEN 'A'
          WHEN mu.exchange IN ('nyse', 'nasdaq') THEN 'US'
          WHEN mu.exchange IN ('tse', 'ose') THEN 'JP'
          WHEN mu.exchange IN ('krx', 'kosdaq') THEN 'KR'
          ELSE 'US'
        END = :market`;
      }

      const rows = await sequelize.query<any>(
        `SELECT mu.ticker AS symbol,
                COALESCE(mu.fundamental_snapshot->>'name', mu.ticker) AS name,
                CASE
                  WHEN jsonb_typeof(mu.fundamental_snapshot->'score') = 'object'
                  THEN mu.fundamental_snapshot->'score'
                  ELSE NULL
                END AS score,
                COALESCE(mu.fundamental_snapshot->>'rating_band', 'C') AS rating_band,
                CASE
                  WHEN jsonb_typeof(mu.fundamental_snapshot->'conviction') = 'object'
                  THEN mu.fundamental_snapshot->'conviction'
                  ELSE NULL
                END AS conviction,
                CASE
                  WHEN jsonb_typeof(mu.fundamental_snapshot->'risk_gate') = 'object'
                  THEN mu.fundamental_snapshot->'risk_gate'
                  ELSE NULL
                END AS risk_gate,
                CASE
                  WHEN jsonb_typeof(mu.fundamental_snapshot->'entry_plan') = 'object'
                  THEN mu.fundamental_snapshot->'entry_plan'
                  ELSE NULL
                END AS entry_plan,
                mu.fundamental_snapshot->'latest_catalyst' AS latest_catalyst,
                CASE
                  WHEN mu.exchange IN ('sh', 'sz', 'bj') THEN 'A'
                  WHEN mu.exchange IN ('nyse', 'nasdaq') THEN 'US'
                  WHEN mu.exchange IN ('tse', 'ose') THEN 'JP'
                  WHEN mu.exchange IN ('krx', 'kosdaq') THEN 'KR'
                  ELSE 'US'
                END AS market,
                COALESCE(mu.fundamental_snapshot->>'stage', 'seed') AS stage,
                COALESCE(mu.fundamental_snapshot->>'conclusion', 'SKIP') AS conclusion
         FROM multibagger_universe mu
         WHERE ${whereClause}
         ORDER BY CASE
           WHEN jsonb_typeof(mu.fundamental_snapshot->'score') = 'object'
             THEN COALESCE((mu.fundamental_snapshot->'score'->>'total')::numeric, 0)
           WHEN jsonb_typeof(mu.fundamental_snapshot->'score') IN ('number', 'string')
             THEN COALESCE((mu.fundamental_snapshot->>'score')::numeric, 0)
           ELSE 0
         END DESC
         LIMIT 200`,
        { replacements, type: QueryTypes.SELECT }
      );

      const typedRows = rows.map(normalizeCandidate);

      const stageDistribution: Record<string, number> = {
        seed: 0,
        early: 0,
        growth: 0,
        break_below: 0,
        deep: 0,
      };
      const conclusionCoverage: Record<string, number> = {
        MULTIBAGGER_2X: 0,
        MULTIBAGGER_5X: 0,
        MULTIBAGGER_10X: 0,
        SKIP: 0,
      };

      for (const row of typedRows) {
        if (row.stage in stageDistribution) stageDistribution[row.stage]++;
        if (row.conclusion in conclusionCoverage) conclusionCoverage[row.conclusion]++;
      }

      res.json({
        kpi: {
          total_candidates: typedRows.length,
          stage_distribution: stageDistribution,
          conclusion_coverage: conclusionCoverage,
        },
        rows: typedRows,
      });
    } catch (error: any) {
      logger.error(`[MultibaggerController.getCandidates] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch multibagger candidates' });
    }
  }

  async getDetail(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;

      const rows = await sequelize.query<any>(
        `SELECT mu.ticker AS symbol,
                COALESCE(mu.fundamental_snapshot->>'name', mu.ticker) AS name,
                CASE
                  WHEN jsonb_typeof(mu.fundamental_snapshot->'score') = 'object'
                  THEN mu.fundamental_snapshot->'score'
                  ELSE NULL
                END AS score,
                COALESCE(mu.fundamental_snapshot->>'rating_band', 'C') AS rating_band,
                CASE
                  WHEN jsonb_typeof(mu.fundamental_snapshot->'conviction') = 'object'
                  THEN mu.fundamental_snapshot->'conviction'
                  ELSE NULL
                END AS conviction,
                CASE
                  WHEN jsonb_typeof(mu.fundamental_snapshot->'risk_gate') = 'object'
                  THEN mu.fundamental_snapshot->'risk_gate'
                  ELSE NULL
                END AS risk_gate,
                CASE
                  WHEN jsonb_typeof(mu.fundamental_snapshot->'entry_plan') = 'object'
                  THEN mu.fundamental_snapshot->'entry_plan'
                  ELSE NULL
                END AS entry_plan,
                mu.fundamental_snapshot->'latest_catalyst' AS latest_catalyst,
                CASE
                  WHEN mu.exchange IN ('sh', 'sz', 'bj') THEN 'A'
                  WHEN mu.exchange IN ('nyse', 'nasdaq') THEN 'US'
                  WHEN mu.exchange IN ('tse', 'ose') THEN 'JP'
                  WHEN mu.exchange IN ('krx', 'kosdaq') THEN 'KR'
                  ELSE 'US'
                END AS market,
                COALESCE(mu.fundamental_snapshot->>'stage', 'seed') AS stage,
                COALESCE(mu.fundamental_snapshot->>'conclusion', 'SKIP') AS conclusion
         FROM multibagger_universe mu
         WHERE mu.ticker = :symbol
         ORDER BY mu.as_of_utc DESC
         LIMIT 1`,
        { replacements: { symbol }, type: QueryTypes.SELECT }
      );

      if (!rows.length) {
        res.status(404).json({ error: 'Multibagger candidate not found' });
        return;
      }

      res.json(normalizeCandidate(rows[0]));
    } catch (error: any) {
      logger.error(`[MultibaggerController.getDetail] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch multibagger detail' });
    }
  }
}
