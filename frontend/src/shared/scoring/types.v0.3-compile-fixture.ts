import type { Dimension, Score } from './types';

const dimension: Dimension = {
  score: 88,
  band: 'A',
  evidence: ['canonical evidence'],
  inputs: {},
};

const score: Score = {
  scoring_id: '00000000-0000-4000-8000-000000000001',
  snapshot_hash: 'a'.repeat(64),
  ticker: '7203',
  as_of: '2026-07-10',
  market_scope: 'jp',
  quality: dimension,
  growth: dimension,
  valuation: dimension,
  moat: dimension,
  trend: dimension,
  risk: dimension,
  weights: {
    quality: 0.25,
    growth: 0.15,
    valuation: 0.15,
    moat: 0.2,
    trend: 0.15,
    risk: 0.1,
  },
  weights_profile: 'japan_blue_chip',
  total: 88,
  rating: 'A',
  computed_at: '2026-07-10T06:00:00Z',
  source_versions: {
    quality_engine: 'quality@v0.3.0',
    growth_engine: 'growth@v0.3.0',
    valuation_engine: 'valuation@v0.3.0',
    moat_engine: 'moat@v0.3.0',
    trend_engine: 'trend@v0.3.0',
    risk_engine: 'risk@v0.3.0',
  },
};

// Aggregate rating is `Score.rating`; only dimensions expose `.band`.
// @ts-expect-error legacy aggregate Score.band must stay rejected
const legacyAggregateBand = score.band;
void legacyAggregateBand;
