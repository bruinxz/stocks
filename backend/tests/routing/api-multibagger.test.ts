import express from 'express';
import request from 'supertest';
import multibaggerRoutes from '../../src/api/routes/multibagger.routes';
import { sequelize } from '../../src/config/database';

const SYMBOL = '600519.SH';

type QueryCall = {
  sql: string;
  replacements: Record<string, unknown>;
};

const CANDIDATE = {
  symbol: SYMBOL,
  name: 'Sample Candidate',
  score: JSON.stringify({
    scoring_id: '11111111-1111-4111-8111-111111111111',
    snapshot_hash: 'c'.repeat(64),
    ticker: SYMBOL,
    as_of: '2026-07-10',
    quality: { score: 80, band: 'B', evidence: [], inputs: {} },
    growth: { score: 92, band: 'A', evidence: ['free-source evidence'], inputs: {} },
    valuation: { score: 74, band: 'B', evidence: [], inputs: {} },
    moat: { score: 88, band: 'A', evidence: [], inputs: {} },
    trend: { score: 90, band: 'A', evidence: [], inputs: {} },
    risk: { score: 70, band: 'B', evidence: [], inputs: {} },
    weights: { quality: 0.1, growth: 0.3, valuation: 0.1, moat: 0.15, trend: 0.2, risk: 0.15 },
    weights_profile: 'multibagger',
    total: 88.5,
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
  }),
  rating_band: 'A',
  conviction: JSON.stringify({
    ticker: SYMBOL,
    as_of: '2026-07-10',
    base: 80,
    score_ref: {
      scoring_id: '11111111-1111-4111-8111-111111111111',
      snapshot_hash: 'c'.repeat(64),
    },
    adjustments: [],
    final: 82,
    level: 'HIGH',
  }),
  risk_gate: JSON.stringify({
    ticker: SYMBOL,
    evaluated_at: '2026-07-10T06:00:00Z',
    gate: 'GREEN',
    triggers: [],
    ok_to_enter: true,
  }),
  entry_plan: JSON.stringify({
    ticker: SYMBOL,
    generated_at: '2026-07-10T06:00:00Z',
    entry: { low: 100, high: 105, currency: 'CNY' },
    stop: { value: 92, currency: 'CNY' },
    targets: [{ value: 125, currency: 'CNY' }],
    size_hint: { tier: 'TIER_3', pct: 3, disclaimer_key: 'size_hint_advisory' },
    time_horizon: 'POSITION',
    invalidation: 'break thesis',
    conviction_ref: 82,
    score_ref: {
      scoring_id: '11111111-1111-4111-8111-111111111111',
      snapshot_hash: 'c'.repeat(64),
    },
  }),
  latest_catalyst: JSON.stringify({
    kind: 'product',
    title: 'Launch',
    occurred_at: '2026-07-10T05:00:00Z',
  }),
  market: 'A',
  stage: 'growth',
  conclusion: 'MULTIBAGGER_5X',
};

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/multibagger', multibaggerRoutes);
  return app;
}

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function main(): Promise<void> {
  const originalQuery = sequelize.query;
  const calls: QueryCall[] = [];
  let rows: any[] = [CANDIDATE];

  (sequelize as any).query = async (sql: string, options: any) => {
    calls.push({ sql, replacements: options?.replacements || {} });
    return rows;
  };

  try {
    const app = buildApp();

    const list = await request(app).get(
      '/api/v1/multibagger/candidates?stage=seed,growth&conclusion=MULTIBAGGER_5X&market=A'
    );
    assert('list returns deterministic 200', list.status === 200, `status=${list.status}`);
    assert('list returns canonical Score object', list.body.rows?.[0]?.score?.total === 88.5);
    assert('list mirrors canonical Score.rating', list.body.rows?.[0]?.rating_band === 'A');
    assert(
      'list returns canonical RiskGate object',
      list.body.rows?.[0]?.risk_gate?.gate === 'GREEN'
    );
    assert('KPI counts returned rows', list.body.kpi.total_candidates === 1);
    assert(
      'KPI stage distribution is deterministic',
      list.body.kpi.stage_distribution.growth === 1
    );
    assert(
      'KPI conclusion coverage is deterministic',
      list.body.kpi.conclusion_coverage.MULTIBAGGER_5X === 1
    );
    const listCall = calls.at(-1);
    assert(
      'valid filters reach parameterized SQL',
      JSON.stringify(listCall?.replacements.stages) === JSON.stringify(['seed', 'growth']) &&
        JSON.stringify(listCall?.replacements.conclusions) === JSON.stringify(['MULTIBAGGER_5X']) &&
        listCall?.replacements.market === 'A'
    );
    assert(
      'SQL only selects canonical object DTOs',
      Boolean(listCall?.sql.includes("jsonb_typeof(mu.fundamental_snapshot->'score') = 'object'"))
    );

    const beforeInvalid = calls.length;
    const invalidStage = await request(app).get(
      '/api/v1/multibagger/candidates?stage=seed,unknown'
    );
    assert('mixed invalid stage list returns 400', invalidStage.status === 400);
    const invalidConclusion = await request(app).get(
      '/api/v1/multibagger/candidates?conclusion=MULTIBAGGER_5X,UNKNOWN'
    );
    assert('mixed invalid conclusion list returns 400', invalidConclusion.status === 400);
    const invalidMarket = await request(app).get('/api/v1/multibagger/candidates?market=EU');
    assert('invalid market returns 400', invalidMarket.status === 400);
    assert('invalid filters never query DB', calls.length === beforeInvalid);

    const detail = await request(app).get(`/api/v1/multibagger/${SYMBOL}/detail`);
    assert('detail returns deterministic 200', detail.status === 200);
    assert('detail returns normalized candidate', detail.body.symbol === SYMBOL);
    const detailCall = calls.at(-1);
    assert('detail uses symbol replacement', detailCall?.replacements.symbol === SYMBOL);

    rows = [
      {
        ...CANDIDATE,
        score: '88.5',
        risk_gate: JSON.stringify('GREEN'),
        entry_plan: JSON.stringify('legacy-entry-plan'),
        conviction: JSON.stringify(82),
        rating_band: 'C',
      },
    ];
    const unavailable = await request(app).get('/api/v1/multibagger/candidates');
    assert('legacy scalar Score returns explicit null', unavailable.body.rows?.[0]?.score === null);
    assert(
      'legacy scalar RiskGate returns explicit null',
      unavailable.body.rows?.[0]?.risk_gate === null
    );
    assert(
      'legacy scalar EntryPlan returns explicit null',
      unavailable.body.rows?.[0]?.entry_plan === null
    );
    assert(
      'legacy scalar Conviction returns explicit null',
      unavailable.body.rows?.[0]?.conviction === null
    );
    assert(
      'stored mirror rating_band remains fallback',
      unavailable.body.rows?.[0]?.rating_band === 'C'
    );

    rows = [];
    const missing = await request(app).get('/api/v1/multibagger/NOSUCH/detail');
    assert('missing detail returns 404', missing.status === 404, `status=${missing.status}`);
    assert(
      'missing detail returns stable error',
      missing.body.error === 'Multibagger candidate not found'
    );
  } finally {
    (sequelize as any).query = originalQuery;
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
