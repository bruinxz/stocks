import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

const VALID_MARKETS = ['A', 'US', 'JP', 'KR'];
const VALID_STAGES = ['seed', 'early', 'growth', 'break_below', 'deep'];
const VALID_CONCLUSIONS = ['MULTIBAGGER_2X', 'MULTIBAGGER_5X', 'MULTIBAGGER_10X', 'SKIP'];

function parseJson(value: unknown): any {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function parseEnumList(value: string | undefined, allowed: string[]): string[] | null {
  if (!value) return [];
  const values = value.split(',');
  return values.length > 0 && values.every(item => allowed.includes(item)) ? values : null;
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
    classification_policy_version: row.classification_policy_version,
    classification_reason_codes: parseJson(row.classification_reason_codes),
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
        const stages = parseEnumList(stageParam, VALID_STAGES);
        if (!stages) {
          res.status(400).json({ error: 'Invalid stage filter' });
          return;
        }
        replacements.stages = stages;
        whereClause += ` AND candidate.stage IN (:stages)`;
      }

      if (conclusionParam) {
        const conclusions = parseEnumList(conclusionParam, VALID_CONCLUSIONS);
        if (!conclusions) {
          res.status(400).json({ error: 'Invalid conclusion filter' });
          return;
        }
        replacements.conclusions = conclusions;
        whereClause += ` AND candidate.conclusion IN (:conclusions)`;
      }

      if (marketParam && VALID_MARKETS.includes(marketParam)) {
        replacements.market = marketParam;
        whereClause += ` AND CASE
          WHEN candidate.market_scope = 'cn_a' THEN 'A'
          WHEN candidate.market_scope = 'us' THEN 'US'
          WHEN candidate.market_scope = 'jp' THEN 'JP'
          WHEN candidate.market_scope = 'kr' THEN 'KR'
        END = :market`;
      }

      const rows = await sequelize.query<any>(
        `WITH latest_candidates AS (
           SELECT DISTINCT ON (
                    snapshot.market_scope,
                    snapshot.exchange,
                    snapshot.ticker
                  )
                  snapshot.*
           FROM multibagger_candidate_snapshot snapshot
           ORDER BY
             snapshot.market_scope,
             snapshot.exchange,
             snapshot.ticker,
             snapshot.as_of_utc DESC,
             snapshot.available_at_utc DESC,
             snapshot.created_at DESC,
             snapshot.strategy_version DESC
         )
         SELECT candidate.ticker AS symbol,
                COALESCE(source_fact.name, candidate.ticker) AS name,
                candidate.score,
                candidate.rating AS rating_band,
                candidate.conviction,
                candidate.risk_gate,
                candidate.entry_plan,
                candidate.latest_catalyst,
                CASE
                  WHEN candidate.market_scope = 'cn_a' THEN 'A'
                  WHEN candidate.market_scope = 'us' THEN 'US'
                  WHEN candidate.market_scope = 'jp' THEN 'JP'
                  WHEN candidate.market_scope = 'kr' THEN 'KR'
                END AS market,
                candidate.stage,
                candidate.conclusion,
                candidate.classification_policy_version,
                candidate.classification_reason_codes
         FROM latest_candidates candidate
         LEFT JOIN LATERAL (
           SELECT source.fundamental_snapshot->>'name' AS name
           FROM multibagger_universe source
           WHERE source.market_scope = candidate.market_scope
             AND source.exchange = candidate.exchange
             AND source.ticker = candidate.ticker
             AND source.available_at_utc <= candidate.as_of_utc
           ORDER BY
             source.available_at_utc DESC,
             source.source_version DESC,
             source.created_at DESC
           LIMIT 1
         ) source_fact ON TRUE
         WHERE ${whereClause}
         ORDER BY COALESCE((candidate.score->>'total')::numeric, 0) DESC
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
        `WITH latest_candidates AS (
           SELECT DISTINCT ON (
                    snapshot.market_scope,
                    snapshot.exchange,
                    snapshot.ticker
                  )
                  snapshot.*
           FROM multibagger_candidate_snapshot snapshot
           WHERE snapshot.ticker = :symbol
           ORDER BY
             snapshot.market_scope,
             snapshot.exchange,
             snapshot.ticker,
             snapshot.as_of_utc DESC,
             snapshot.available_at_utc DESC,
             snapshot.created_at DESC,
             snapshot.strategy_version DESC
         )
         SELECT candidate.ticker AS symbol,
                COALESCE(source_fact.name, candidate.ticker) AS name,
                candidate.score,
                candidate.rating AS rating_band,
                candidate.conviction,
                candidate.risk_gate,
                candidate.entry_plan,
                candidate.latest_catalyst,
                CASE
                  WHEN candidate.market_scope = 'cn_a' THEN 'A'
                  WHEN candidate.market_scope = 'us' THEN 'US'
                  WHEN candidate.market_scope = 'jp' THEN 'JP'
                  WHEN candidate.market_scope = 'kr' THEN 'KR'
                END AS market,
                candidate.stage,
                candidate.conclusion,
                candidate.classification_policy_version,
                candidate.classification_reason_codes
         FROM latest_candidates candidate
         LEFT JOIN LATERAL (
           SELECT source.fundamental_snapshot->>'name' AS name
           FROM multibagger_universe source
           WHERE source.market_scope = candidate.market_scope
             AND source.exchange = candidate.exchange
             AND source.ticker = candidate.ticker
             AND source.available_at_utc <= candidate.as_of_utc
           ORDER BY
             source.available_at_utc DESC,
             source.source_version DESC,
             source.created_at DESC
           LIMIT 1
         ) source_fact ON TRUE
         LIMIT 2`,
        { replacements: { symbol }, type: QueryTypes.SELECT }
      );

      if (!rows.length) {
        res.status(404).json({ error: 'Multibagger candidate not found' });
        return;
      }

      if (rows.length > 1) {
        res.status(409).json({ error: 'Multibagger candidate is ambiguous' });
        return;
      }

      res.json(normalizeCandidate(rows[0]));
    } catch (error: any) {
      logger.error(`[MultibaggerController.getDetail] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch multibagger detail' });
    }
  }
}
