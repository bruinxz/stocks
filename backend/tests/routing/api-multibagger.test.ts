import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { sequelize } from '../../src/config/database';
import { User } from '../../src/models/User';

const JWT_SECRET = 'api-multibagger-test-secret';
const AUTH_USER = {
  id: 9005,
  username: 'routing-test-user',
  email: 'routing-test@example.com',
  role: 'admin',
  is_active: true,
} as User;

process.env.JWT_SECRET = JWT_SECRET;
(User as any).findByPk = async (userId: number) => (userId === AUTH_USER.id ? AUTH_USER : null);

const AUTHORIZATION = `Bearer ${jwt.sign(
  { user_id: AUTH_USER.id, username: AUTH_USER.username, role: AUTH_USER.role },
  JWT_SECRET,
  { expiresIn: '5m' }
)}`;
const multibaggerRoutes = require('../../src/api/routes/multibagger.routes')
  .default as typeof import('../../src/api/routes/multibagger.routes').default;

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
    market_scope: 'cn_a',
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
    available_at_utc: '2026-07-10T05:30:00Z',
    source_ref: 'official:launch',
    fact_hash: 'c'.repeat(64),
  }),
  market: 'A',
  market_scope: 'cn_a',
  exchange: 'sh',
  stage: 'growth',
  conclusion: 'MULTIBAGGER_5X',
  fact_hash: 'f'.repeat(64),
  source_fact_hashes: JSON.stringify(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]),
  as_of_utc: '2026-07-10T08:00:00Z',
  available_at_utc: '2026-07-10T07:00:00Z',
  strategy_version: 'japan-multibagger@1.0.0',
  classification_policy_version: 'multibagger-policy@1.0.0',
  classification_reason_codes: JSON.stringify(['GROWTH_EVIDENCE']),
};

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/multibagger', multibaggerRoutes);
  return app;
}

function authorizedGet(app: express.Express, path: string) {
  return request(app).get(path).set('Authorization', AUTHORIZATION);
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

    const callsBeforeAuth = calls.length;
    const missingAuthorization = await request(app).get('/api/v1/multibagger/candidates');
    assert('missing Authorization returns 401', missingAuthorization.status === 401);
    const invalidAuthorization = await request(app)
      .get('/api/v1/multibagger/candidates')
      .set('Authorization', 'Bearer invalid.jwt.token');
    assert('invalid Authorization returns 401', invalidAuthorization.status === 401);
    assert('unauthorized requests never query DB', calls.length === callsBeforeAuth);

    const list = await authorizedGet(
      app,
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
    assert(
      'list exposes authenticated candidate fact hash',
      list.body.rows[0].fact_hash === 'f'.repeat(64)
    );
    assert(
      'list exposes ordered source fact hashes',
      JSON.stringify(list.body.rows[0].source_fact_hashes) ===
        JSON.stringify(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)])
    );
    assert('list exposes PIT as_of pin', list.body.rows[0].as_of_utc === CANDIDATE.as_of_utc);
    assert(
      'list exposes PIT availability pin',
      list.body.rows[0].available_at_utc === CANDIDATE.available_at_utc
    );
    assert(
      'list exposes physical identity pins',
      list.body.rows[0].market_scope === 'cn_a' && list.body.rows[0].exchange === 'sh'
    );
    assert(
      'list preserves catalyst source proof pins',
      list.body.rows[0].latest_catalyst.source_ref === 'official:launch' &&
        list.body.rows[0].latest_catalyst.fact_hash === 'c'.repeat(64)
    );
    assert(
      'list exposes strategy and classification versions',
      list.body.rows[0].strategy_version === CANDIDATE.strategy_version &&
        list.body.rows[0].classification_policy_version === CANDIDATE.classification_policy_version
    );
    const listCall = calls.at(-1);
    assert(
      'valid filters reach parameterized SQL',
      JSON.stringify(listCall?.replacements.stages) === JSON.stringify(['seed', 'growth']) &&
        JSON.stringify(listCall?.replacements.conclusions) === JSON.stringify(['MULTIBAGGER_5X']) &&
        listCall?.replacements.market === 'A'
    );
    assert(
      'SQL consumes canonical candidate snapshot SOT',
      Boolean(
        listCall?.sql.includes('FROM multibagger_candidate_snapshot snapshot') &&
          listCall?.sql.includes('candidate.score') &&
          listCall?.sql.includes('candidate.risk_gate') &&
          listCall?.sql.includes('candidate.entry_plan') &&
          listCall?.sql.includes('candidate.fact_hash') &&
          listCall?.sql.includes('candidate.source_fact_hashes') &&
          !listCall?.sql.includes("fundamental_snapshot->'score'")
      )
    );

    const beforeInvalid = calls.length;
    const invalidStage = await authorizedGet(
      app,
      '/api/v1/multibagger/candidates?stage=seed,unknown'
    );
    assert('mixed invalid stage list returns 400', invalidStage.status === 400);
    const invalidConclusion = await authorizedGet(
      app,
      '/api/v1/multibagger/candidates?conclusion=MULTIBAGGER_5X,UNKNOWN'
    );
    assert('mixed invalid conclusion list returns 400', invalidConclusion.status === 400);
    const invalidMarket = await authorizedGet(app, '/api/v1/multibagger/candidates?market=EU');
    assert('invalid market returns 400', invalidMarket.status === 400);
    assert('invalid filters never query DB', calls.length === beforeInvalid);

    const controller =
      new (require('../../src/api/controllers/MultibaggerController').MultibaggerController)();
    let directStatus = 0;
    let directBody: any;
    await controller.getCandidates(
      { query: { stage: 'seed,unknown' } } as any,
      {
        status(code: number) {
          directStatus = code;
          return this;
        },
        json(body: any) {
          directBody = body;
        },
      } as any
    );
    assert('controller defense rejects invalid stage token', directStatus === 400);
    assert(
      'controller defense returns stable stage error',
      directBody?.error === 'Invalid stage filter'
    );

    directStatus = 0;
    directBody = undefined;
    await controller.getCandidates(
      { query: { conclusion: 'MULTIBAGGER_5X,UNKNOWN' } } as any,
      {
        status(code: number) {
          directStatus = code;
          return this;
        },
        json(body: any) {
          directBody = body;
        },
      } as any
    );
    assert('controller defense rejects invalid conclusion token', directStatus === 400);
    assert(
      'controller defense returns stable conclusion error',
      directBody?.error === 'Invalid conclusion filter'
    );

    const detail = await authorizedGet(app, `/api/v1/multibagger/${SYMBOL}/detail`);
    assert('detail returns deterministic 200', detail.status === 200);
    assert('detail returns normalized candidate', detail.body.symbol === SYMBOL);
    assert('detail returns the same proof pins', detail.body.fact_hash === CANDIDATE.fact_hash);
    const detailCall = calls.at(-1);
    assert('detail uses symbol replacement', detailCall?.replacements.symbol === SYMBOL);
    assert(
      'detail uses canonical candidate snapshot SOT and ambiguity guard',
      Boolean(
        detailCall?.sql.includes('FROM multibagger_candidate_snapshot snapshot') &&
          detailCall?.sql.includes('LIMIT 2')
      )
    );

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
    const unavailable = await authorizedGet(app, '/api/v1/multibagger/candidates');
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
    const missing = await authorizedGet(app, '/api/v1/multibagger/NOSUCH/detail');
    assert('missing detail returns 404', missing.status === 404, `status=${missing.status}`);
    assert(
      'missing detail returns stable error',
      missing.body.error === 'Multibagger candidate not found'
    );

    rows = [CANDIDATE, { ...CANDIDATE, market: 'US' }];
    const ambiguous = await authorizedGet(app, `/api/v1/multibagger/${SYMBOL}/detail`);
    assert('ambiguous detail returns 409', ambiguous.status === 409);
    assert(
      'ambiguous detail returns stable error',
      ambiguous.body.error === 'Multibagger candidate is ambiguous'
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
