import { Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { sequelize } from '../../config/database';

const VALID_STAGES = ['seed', 'early', 'growth', 'break_below', 'deep'];
const VALID_CONCLUSIONS = ['MULTIBAGGER_2X', 'MULTIBAGGER_5X', 'MULTIBAGGER_10X', 'SKIP'];
const VALID_MARKETS = ['A', 'US', 'JP', 'KR'];

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
        const stages = stageParam.split(',').filter(s => VALID_STAGES.includes(s));
        if (stages.length > 0) {
          whereClause += ` AND mu.filter_pass_bitmap IS NOT NULL`;
          replacements.stages = stages;
          whereClause += ` AND mu.fundamental_snapshot->>'stage' IN (:stages)`;
        }
      }

      if (conclusionParam) {
        const conclusions = conclusionParam.split(',').filter(c => VALID_CONCLUSIONS.includes(c));
        if (conclusions.length > 0) {
          replacements.conclusions = conclusions;
          whereClause += ` AND mu.fundamental_snapshot->>'conclusion' IN (:conclusions)`;
        }
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

      const [rows] = await sequelize.query(
        `SELECT mu.ticker AS symbol,
                COALESCE(mu.fundamental_snapshot->>'name', mu.ticker) AS name,
                mu.fundamental_snapshot->>'scoring_id' AS scoring_id,
                mu.fact_hash AS snapshot_hash,
                COALESCE((mu.fundamental_snapshot->>'score')::numeric, 0) AS score,
                COALESCE(mu.fundamental_snapshot->>'band', 'C') AS band,
                COALESCE(mu.fundamental_snapshot->'dims', '[]'::jsonb) AS dims,
                COALESCE(mu.fundamental_snapshot->'evidence', '[]'::jsonb) AS evidence,
                mu.fundamental_snapshot->>'weights_profile' AS weights_profile,
                COALESCE(mu.fundamental_snapshot->>'rating_band', 'C') AS rating_band,
                mu.fundamental_snapshot->'conviction' AS conviction,
                mu.fundamental_snapshot->'risk_gate' AS risk_gate,
                mu.fundamental_snapshot->'entry_plan' AS entry_plan,
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
         ORDER BY (mu.fundamental_snapshot->>'score')::numeric DESC NULLS LAST
         LIMIT 200`,
        { replacements, type: 'SELECT' as any }
      );

      const typedRows = (rows as any[]).map((r: any) => ({
        symbol: r.symbol,
        name: r.name,
        score: {
          scoring_id: r.scoring_id || '',
          snapshot_hash: r.snapshot_hash || '',
          score: Number(r.score),
          band: r.band,
          dims: typeof r.dims === 'string' ? JSON.parse(r.dims) : (r.dims || []),
          evidence: typeof r.evidence === 'string' ? JSON.parse(r.evidence) : (r.evidence || []),
          weights_profile: r.weights_profile,
        },
        rating_band: r.rating_band,
        conviction: typeof r.conviction === 'string' ? JSON.parse(r.conviction) : r.conviction,
        risk_gate: typeof r.risk_gate === 'string' ? JSON.parse(r.risk_gate) : r.risk_gate,
        entry_plan: typeof r.entry_plan === 'string' ? JSON.parse(r.entry_plan) : r.entry_plan,
        latest_catalyst: typeof r.latest_catalyst === 'string' ? JSON.parse(r.latest_catalyst) : r.latest_catalyst,
        market: r.market,
        stage: r.stage,
        conclusion: r.conclusion,
      }));

      const stageDistribution: Record<string, number> = { seed: 0, early: 0, growth: 0, break_below: 0, deep: 0 };
      const conclusionCoverage: Record<string, number> = { MULTIBAGGER_2X: 0, MULTIBAGGER_5X: 0, MULTIBAGGER_10X: 0, SKIP: 0 };

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

      const [rows] = await sequelize.query(
        `SELECT mu.ticker AS symbol,
                COALESCE(mu.fundamental_snapshot->>'name', mu.ticker) AS name,
                mu.fundamental_snapshot->>'scoring_id' AS scoring_id,
                mu.fact_hash AS snapshot_hash,
                COALESCE((mu.fundamental_snapshot->>'score')::numeric, 0) AS score,
                COALESCE(mu.fundamental_snapshot->>'band', 'C') AS band,
                COALESCE(mu.fundamental_snapshot->'dims', '[]'::jsonb) AS dims,
                COALESCE(mu.fundamental_snapshot->'evidence', '[]'::jsonb) AS evidence,
                mu.fundamental_snapshot->>'weights_profile' AS weights_profile,
                COALESCE(mu.fundamental_snapshot->>'rating_band', 'C') AS rating_band,
                mu.fundamental_snapshot->'conviction' AS conviction,
                mu.fundamental_snapshot->'risk_gate' AS risk_gate,
                mu.fundamental_snapshot->'entry_plan' AS entry_plan,
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
        { replacements: { symbol }, type: 'SELECT' as any }
      );

      if (!(rows as any[]).length) {
        res.status(404).json({ error: 'Multibagger candidate not found' });
        return;
      }

      const r = (rows as any[])[0];
      res.json({
        symbol: r.symbol,
        name: r.name,
        score: {
          scoring_id: r.scoring_id || '',
          snapshot_hash: r.snapshot_hash || '',
          score: Number(r.score),
          band: r.band,
          dims: typeof r.dims === 'string' ? JSON.parse(r.dims) : (r.dims || []),
          evidence: typeof r.evidence === 'string' ? JSON.parse(r.evidence) : (r.evidence || []),
          weights_profile: r.weights_profile,
        },
        rating_band: r.rating_band,
        conviction: typeof r.conviction === 'string' ? JSON.parse(r.conviction) : r.conviction,
        risk_gate: typeof r.risk_gate === 'string' ? JSON.parse(r.risk_gate) : r.risk_gate,
        entry_plan: typeof r.entry_plan === 'string' ? JSON.parse(r.entry_plan) : r.entry_plan,
        latest_catalyst: typeof r.latest_catalyst === 'string' ? JSON.parse(r.latest_catalyst) : r.latest_catalyst,
        market: r.market,
        stage: r.stage,
        conclusion: r.conclusion,
      });
    } catch (error: any) {
      logger.error(`[MultibaggerController.getDetail] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch multibagger detail' });
    }
  }
}
