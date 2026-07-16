import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { sequelize } from '../../src/config/database';
import { User } from '../../src/models/User';

const JWT_SECRET = 'api-jpkr-market-test-secret';
const AUTH_USER = {
  id: 9004,
  username: 'routing-test-user',
  email: 'routing-test@example.com',
  role: 'admin',
  is_active: true,
} as User;

process.env.JWT_SECRET = JWT_SECRET;
(User as any).findByPk = async (userId: number) => (userId === AUTH_USER.id ? AUTH_USER : null);

const AUTHORIZATION = `Bearer ${jwt.sign(
  {
    user_id: AUTH_USER.id,
    username: AUTH_USER.username,
    role: AUTH_USER.role,
    type: 'access',
  },
  JWT_SECRET,
  {
    algorithm: 'HS256',
    issuer: 'stocks-backend',
    audience: 'stocks-api',
    expiresIn: '5m',
  }
)}`;
const jpkrMarketRoutes = require('../../src/api/routes/jpkrMarket.routes')
  .default as typeof import('../../src/api/routes/jpkrMarket.routes').default;

const DATE = '2026-07-10';
const SYMBOL = '7203';

type QueryCall = {
  sql: string;
  replacements: Record<string, unknown>;
};

const SCORE = {
  scoring_id: '11111111-1111-4111-8111-111111111111',
  snapshot_hash: 'b'.repeat(64),
  ticker: SYMBOL,
  as_of: DATE,
  quality: { score: 88, band: 'A', evidence: ['EDINET filing'], inputs: {} },
  growth: { score: 82, band: 'B', evidence: [], inputs: {} },
  valuation: { score: 75, band: 'B', evidence: [], inputs: {} },
  moat: { score: 80, band: 'B', evidence: [], inputs: {} },
  trend: { score: 85, band: 'A', evidence: [], inputs: {} },
  risk: { score: 76, band: 'B', evidence: [], inputs: {} },
  weights: { quality: 0.25, growth: 0.15, valuation: 0.15, moat: 0.2, trend: 0.15, risk: 0.1 },
  weights_profile: 'japan_blue_chip',
  total: 84,
  rating: 'B',
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

const RISK_GATE = {
  ticker: SYMBOL,
  evaluated_at: '2026-07-10T06:00:00Z',
  gate: 'YELLOW',
  triggers: [{ code: 'TSE_HALT', severity: 'block', detail: 'TSE halt condition' }],
  ok_to_enter: false,
};

const MARKET_ROW = {
  symbol: SYMBOL,
  name_local: 'トヨタ自動車',
  name_en: 'Toyota Motor',
  market: 'JP',
  sector: 'automotive',
  close: '3125.50',
  change_pct: '1.25',
  currency: 'JPY',
  disclosure_events: JSON.stringify([
    {
      title: '決算短信',
      doc_type: 'earnings',
      filed_at: '2026-07-10T05:00:00Z',
      source: 'jpx-edinet',
      doc_url: 'https://example.test/filing',
    },
  ]),
  revenue_by_region: JSON.stringify([{ region: 'Japan', pct: 30 }]),
  fx_beta: '0.75',
  is_halted: false,
  data_sources: ['jpx-edinet', 'stooq-jp'],
  score: JSON.stringify(SCORE),
  risk_gate: JSON.stringify(RISK_GATE),
};

const KPI_ROW = {
  nikkei225: JSON.stringify({ value: '41000.5', change_pct: '0.8', as_of: DATE }),
  topix: JSON.stringify({ value: '2900.25', change_pct: '0.4', as_of: DATE }),
  kospi: null,
  usdjpy: JSON.stringify({ rate: '150.25', change_pct: '0.2', as_of: DATE }),
  usdkrw: JSON.stringify({ rate: '1380.50', change_pct: '-0.1', as_of: DATE }),
};

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/jpkr-market', jpkrMarketRoutes);
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
  let rowFixture: any[] = [MARKET_ROW];
  let kpiFixture: any[] = [KPI_ROW];

  (sequelize as any).query = async (sql: string, options: any) => {
    calls.push({ sql, replacements: options?.replacements || {} });
    return sql.includes('WITH index_symbols') ? kpiFixture : rowFixture;
  };

  try {
    const app = buildApp();

    const callsBeforeAuth = calls.length;
    const missingAuthorization = await request(app).get(`/api/v1/jpkr-market/${DATE}?market=JP`);
    assert('missing Authorization returns 401', missingAuthorization.status === 401);
    const invalidAuthorization = await request(app)
      .get(`/api/v1/jpkr-market/${SYMBOL}/detail?date=${DATE}`)
      .set('Authorization', 'Bearer invalid.jwt.token');
    assert('invalid Authorization returns 401', invalidAuthorization.status === 401);
    assert('unauthorized requests never query DB', calls.length === callsBeforeAuth);

    const list = await authorizedGet(app, `/api/v1/jpkr-market/${DATE}?market=JP`);
    assert('list returns 200 with Authorization', list.status === 200, `status=${list.status}`);
    assert('list has deterministic row', list.body.rows?.[0]?.symbol === SYMBOL);
    assert('numeric row fields are normalized', list.body.rows?.[0]?.close === 3125.5);
    assert('canonical Score passes through', list.body.rows?.[0]?.score?.total === 84);
    assert('canonical Score rating passes through', list.body.rows?.[0]?.score?.rating === 'B');
    assert('canonical RiskGate passes through', list.body.rows?.[0]?.risk_gate?.gate === 'YELLOW');
    assert(
      'risk_triggers mirrors RiskGate triggers',
      JSON.stringify(list.body.rows?.[0]?.risk_triggers) === JSON.stringify(RISK_GATE.triggers)
    );
    assert('USDJPY consumes dedicated FX fact', list.body.kpi.usdjpy?.rate === 150.25);
    assert('USDKRW consumes dedicated FX fact', list.body.kpi.usdkrw?.rate === 1380.5);

    const kpiCall = calls[0];
    const listCall = calls[1];
    assert(
      'KPI SQL does not average company financial FX',
      !kpiCall.sql.includes('fx_rate_to_usd')
    );
    assert('KPI SQL contains no rejected fx_days CTE', !kpiCall.sql.includes('fx_days'));
    assert('KPI SQL contains no rejected fx_summary CTE', !kpiCall.sql.includes('fx_summary'));
    assert('KPI SQL consumes dedicated FX table', kpiCall.sql.includes('jpkr_fx_observation'));
    assert(
      'KPI SQL applies availability cutoff',
      kpiCall.sql.includes('fx.available_at_utc <= CAST(:cutoff AS timestamptz)')
    );
    assert('row SQL uses frozen ticker names', listCall.sql.includes('k.ticker_name_local'));
    assert('row SQL maps disclosure table', listCall.sql.includes('jpkr_disclosure_event'));
    assert('row SQL derives prior-close change', listCall.sql.includes('previous_rows'));
    assert(
      'row SQL preserves exchange+ticker candidates',
      listCall.sql.includes('DISTINCT ON (k.exchange, k.ticker)')
    );
    assert(
      'row SQL rejects ticker-only candidate collapse',
      !listCall.sql.includes('DISTINCT ON (k.ticker)')
    );
    assert('row SQL avoids nonexistent kline change_pct', !listCall.sql.includes('k.change_pct'));
    assert('row SQL avoids financial-as-disclosure fields', !listCall.sql.includes('d.title'));
    assert(
      'financial PIT uses market_scope and availability authority',
      listCall.sql.includes('DISTINCT ON (f.market_scope, f.ticker)') &&
        listCall.sql.includes('f.available_at_utc <= CAST(:cutoff AS timestamptz)') &&
        listCall.sql.includes('f.source_version DESC') &&
        !listCall.sql.includes('f.as_of_utc')
    );
    assert(
      'disclosure SQL uses canonical market_scope',
      listCall.sql.includes('disclosure.market_scope') &&
        !listCall.sql.includes('disclosure.market =')
    );
    assert(
      'list uses canonical replacements',
      listCall.replacements.date === DATE &&
        listCall.replacements.market === 'JP' &&
        listCall.replacements.symbol === null &&
        listCall.replacements.limit === 200 &&
        listCall.replacements.cutoff === `${DATE}T23:59:59.999Z`
    );

    const detail = await authorizedGet(app, `/api/v1/jpkr-market/${SYMBOL}/detail?date=${DATE}`);
    assert('detail returns 200 with Authorization', detail.status === 200);
    assert('detail returns same locked row shape', Array.isArray(detail.body.risk_triggers));
    const detailCall = calls.at(-1);
    assert(
      'detail uses symbol and limit=2 for ambiguity detection',
      detailCall?.replacements.symbol === SYMBOL && detailCall?.replacements.limit === 2
    );

    rowFixture = [
      {
        ...MARKET_ROW,
        score: null,
        risk_gate: null,
      },
    ];
    const unavailable = await authorizedGet(app, `/api/v1/jpkr-market/${DATE}?market=JP`);
    assert('unavailable Score is explicit null', unavailable.body.rows?.[0]?.score === null);
    assert('unavailable RiskGate is explicit null', unavailable.body.rows?.[0]?.risk_gate === null);
    assert(
      'unavailable risk_triggers is empty array',
      unavailable.body.rows?.[0]?.risk_triggers?.length === 0
    );
    kpiFixture = [{ ...KPI_ROW, usdjpy: null, usdkrw: null }];
    const unavailableFx = await authorizedGet(app, `/api/v1/jpkr-market/${DATE}?market=JP`);
    assert(
      'unavailable FX snapshots are explicit null',
      unavailableFx.body.kpi.usdjpy === null && unavailableFx.body.kpi.usdkrw === null
    );

    const beforeInvalid = calls.length;
    const lowerMarket = await authorizedGet(app, `/api/v1/jpkr-market/${DATE}?market=jp`);
    assert('lowercase market is rejected with 400', lowerMarket.status === 400);
    const missingMarket = await authorizedGet(app, `/api/v1/jpkr-market/${DATE}`);
    assert('missing market is rejected with 400', missingMarket.status === 400);
    const invalidDate = await authorizedGet(app, '/api/v1/jpkr-market/not-a-date?market=JP');
    assert('invalid date is rejected with 400', invalidDate.status === 400);
    assert('invalid requests never query DB', calls.length === beforeInvalid);

    rowFixture = [];
    const missing = await authorizedGet(app, `/api/v1/jpkr-market/NOSUCH/detail?date=${DATE}`);
    assert('missing detail returns 404', missing.status === 404, `status=${missing.status}`);
    assert(
      'missing detail returns stable error',
      missing.body.error === 'JPKR market entry not found'
    );

    rowFixture = [
      MARKET_ROW,
      { ...MARKET_ROW, market: 'KR', currency: 'KRW', data_sources: ['krx-marketdata'] },
    ];
    const ambiguous = await authorizedGet(app, `/api/v1/jpkr-market/${SYMBOL}/detail?date=${DATE}`);
    assert('ambiguous detail returns 409', ambiguous.status === 409, `status=${ambiguous.status}`);
    assert(
      'ambiguous detail stable error',
      ambiguous.body.error === 'JPKR market entry is ambiguous'
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
