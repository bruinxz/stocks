import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { sequelize } from '../../src/config/database';
import { User } from '../../src/models/User';

const JWT_SECRET = 'api-backtest-pit-test-secret';
const AUTH_USER = {
  id: 9003,
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
const backtestPitRoutes = require('../../src/api/routes/backtestPit.routes')
  .default as typeof import('../../src/api/routes/backtestPit.routes').default;

const STRATEGY = 'us_preferred';
const MARKET_SCOPE = 'us';
const AS_OF = '2026-07-10T06:00:00Z';
const ENCODED_AS_OF = encodeURIComponent(AS_OF);

type QueryCall = {
  sql: string;
  replacements: Record<string, unknown>;
};

const SNAPSHOT = {
  snapshot_id: '11111111-1111-4111-8111-111111111111',
  strategy: STRATEGY,
  market_scope: MARKET_SCOPE,
  snapshot_day: '2026-07-10',
  as_of_utc: AS_OF,
  is_survivorship_biased: false,
  is_delisted_at_as_of: false,
  source_versions: { us_price: 'free-source-2026-07-10' },
  metrics: {
    net_value: 1.24,
    drawdown: -0.08,
    cumulative_return: 0.24,
    sharpe_ratio_6m: 1.85,
    win_rate_6m: 0.58,
  },
  fact_hash: 'a'.repeat(64),
};

const LIST_SNAPSHOT = {
  ...SNAPSHOT,
  metrics: undefined,
  net_value: '1.24',
  drawdown: '-0.08',
  cumulative_return: '0.24',
  sharpe_ratio_6m: '1.85',
  win_rate_6m: '0.58',
};

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/backtest-pit', backtestPitRoutes);
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
  let returnEmpty = false;
  let duplicateRows = false;
  let evidenceSnapshotCount = 27;
  let holdingRows: any[] = [
    { ticker: 'AAPL', weight: '0.15', return_since_entry: '0.12', is_stale: false },
  ];

  (sequelize as any).query = async (sql: string, options: any) => {
    calls.push({ sql, replacements: options?.replacements || {} });
    if (returnEmpty) return [];
    if (sql.includes('COUNT(*)::int AS snapshot_count')) {
      return [{ snapshot_count: evidenceSnapshotCount }];
    }
    const requestedAsOf = options?.replacements?.as_of;
    if (requestedAsOf && Date.parse(String(requestedAsOf)) !== Date.parse(AS_OF)) {
      return [];
    }
    if (sql.includes('FROM backtest_pit_holding bph')) {
      return holdingRows;
    }
    if (sql.includes("bps.metrics->>'net_value'")) {
      return [LIST_SNAPSHOT];
    }
    if (duplicateRows) {
      return [SNAPSHOT, { ...SNAPSHOT, snapshot_id: '22222222-2222-4222-8222-222222222222' }];
    }
    return [SNAPSHOT];
  };

  try {
    const app = buildApp();

    const callsBeforeAuth = calls.length;
    const missingAuthorization = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}?market_scope=${MARKET_SCOPE}`
    );
    assert('missing Authorization returns 401', missingAuthorization.status === 401);
    const invalidAuthorization = await request(app)
      .get(`/api/v1/backtest-pit/${STRATEGY}?market_scope=${MARKET_SCOPE}`)
      .set('Authorization', 'Bearer invalid.jwt.token');
    assert('invalid Authorization returns 401', invalidAuthorization.status === 401);
    assert('unauthorized requests never query DB', calls.length === callsBeforeAuth);

    const list = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}?market_scope=${MARKET_SCOPE}&from=2026-01-01&to=2026-07-10&limit=5`
    );
    assert('list returns 200 with Authorization', list.status === 200, `status=${list.status}`);
    assert('list envelope keeps strategy', list.body.strategy === STRATEGY);
    assert('list envelope keeps market_scope', list.body.market_scope === MARKET_SCOPE);
    assert(
      'list row keeps canonical strategy field',
      list.body.snapshots?.[0]?.strategy === STRATEGY
    );
    assert(
      'list row does not introduce profile alias',
      !('profile' in (list.body.snapshots?.[0] || {}))
    );
    assert('list exposes top-level net_value', list.body.snapshots?.[0]?.net_value === 1.24);
    assert('list exposes top-level drawdown', list.body.snapshots?.[0]?.drawdown === -0.08);
    assert(
      'list exposes top-level cumulative_return',
      list.body.snapshots?.[0]?.cumulative_return === 0.24
    );
    assert(
      'list exposes top-level sharpe_ratio_6m',
      list.body.snapshots?.[0]?.sharpe_ratio_6m === 1.85
    );
    assert('list exposes top-level win_rate_6m', list.body.snapshots?.[0]?.win_rate_6m === 0.58);
    assert('list does not expose nested metrics', !('metrics' in (list.body.snapshots?.[0] || {})));
    assert('list marks persisted evidence ready', list.body.evidence_status?.state === 'ready');
    assert('ready evidence has no blockers', list.body.evidence_status?.blockers?.length === 0);
    const listCall = calls.at(-2);
    assert(
      'list uses parameterized filters',
      listCall?.replacements.strategy === STRATEGY &&
        listCall?.replacements.market_scope === MARKET_SCOPE &&
        listCall?.replacements.from === '2026-01-01' &&
        listCall?.replacements.to === '2026-07-10' &&
        listCall?.replacements.limit === 5
    );
    assert(
      'list excludes fixture and synthetic provenance',
      Boolean(
        listCall?.sql.includes('jsonb_each_text(bps.source_versions)') &&
          listCall?.sql.includes("'(fixture|synthetic|mock|seed)'")
      )
    );
    const evidenceCall = calls.at(-1);
    assert(
      'list verifies the complete persisted checkpoint count',
      evidenceCall?.replacements.strategy === STRATEGY &&
        evidenceCall?.replacements.market_scope === MARKET_SCOPE
    );
    assert(
      'readiness counts only trusted provenance',
      Boolean(evidenceCall?.sql.includes('jsonb_each_text(bps.source_versions)'))
    );

    evidenceSnapshotCount = 1;
    const partialList = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}?market_scope=${MARKET_SCOPE}`
    );
    assert(
      'one persisted snapshot does not bypass the 27-checkpoint gate',
      partialList.body.evidence_status?.state === 'blocked' &&
        partialList.body.evidence_status?.snapshot_count === 1
    );
    assert(
      'partial persisted replay exposes a stable blocker',
      partialList.body.evidence_status?.blockers?.[0]?.code === 'pit_replay_not_materialized'
    );
    assert(
      'partial persisted replay never exposes curve points',
      Array.isArray(partialList.body.snapshots) && partialList.body.snapshots.length === 0
    );
    evidenceSnapshotCount = 27;

    const detail = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}?market_scope=${MARKET_SCOPE}`
    );
    assert('detail returns deterministic 200', detail.status === 200, `status=${detail.status}`);
    assert('detail returns canonical snapshot', detail.body.snapshot_id === SNAPSHOT.snapshot_id);
    assert('detail keeps nested metrics', detail.body.metrics?.net_value === 1.24);
    assert('detail hydrates normalized holdings', detail.body.holdings?.[0]?.weight === 0.15);
    const detailCall = calls.at(-2);
    assert(
      'detail matches exact as_of_utc',
      Boolean(detailCall?.sql.includes('bps.as_of_utc = CAST(:as_of AS timestamptz)'))
    );
    assert(
      'detail limits to two rows to detect ambiguity',
      Boolean(detailCall?.sql.includes('LIMIT 2'))
    );
    assert('detail passes exact timestamp', detailCall?.replacements.as_of === AS_OF);
    assert('detail never selects removed bps.holdings', !detailCall?.sql.includes('bps.holdings'));

    const equivalentAsOf = '2026-07-10T14:00:00+08:00';
    const equivalentDetail = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${encodeURIComponent(equivalentAsOf)}` +
        `?market_scope=${MARKET_SCOPE}`
    );
    assert(
      'timezone-equivalent as_of reaches exact timestamptz equality',
      equivalentDetail.status === 200,
      `status=${equivalentDetail.status}`
    );
    assert(
      'timezone-equivalent replacement is preserved byte-for-byte',
      calls.at(-2)?.replacements.as_of === equivalentAsOf
    );

    const nonEquivalentAsOf = '2026-07-10T06:00:01Z';
    const nonEquivalentDetail = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${encodeURIComponent(nonEquivalentAsOf)}` +
        `?market_scope=${MARKET_SCOPE}`
    );
    assert(
      'non-equivalent as_of can miss instead of matching unintended row',
      nonEquivalentDetail.status === 404,
      `status=${nonEquivalentDetail.status}`
    );

    const holdings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert(
      'holdings returns deterministic 200',
      holdings.status === 200,
      `status=${holdings.status}`
    );
    assert('holdings returns array', Array.isArray(holdings.body.holdings));
    assert(
      'holdings preserve four-field contract',
      JSON.stringify(Object.keys(holdings.body.holdings[0]).sort()) ===
        JSON.stringify(['is_stale', 'return_since_entry', 'ticker', 'weight'])
    );
    const holdingsCall = calls.at(-2);
    assert(
      'holdings matches exact as_of_utc',
      Boolean(holdingsCall?.sql.includes('bps.as_of_utc = CAST(:as_of AS timestamptz)'))
    );
    assert(
      'holdings limits to two rows to detect ambiguity',
      Boolean(holdingsCall?.sql.includes('LIMIT 2'))
    );
    assert(
      'holdings snapshot lookup binds market_scope',
      holdingsCall?.replacements.market_scope === MARKET_SCOPE
    );
    const holdingChildCall = calls.at(-1);
    assert(
      'holdings use normalized child table in position order',
      Boolean(
        holdingChildCall?.sql.includes('FROM backtest_pit_holding bph') &&
          holdingChildCall?.sql.includes('ORDER BY bph.position_order ASC') &&
          holdingChildCall?.replacements.snapshot_id === SNAPSHOT.snapshot_id
      )
    );

    holdingRows = [];
    const emptyHoldings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert(
      'empty normalized holdings return []',
      emptyHoldings.status === 200 && emptyHoldings.body.holdings.length === 0
    );

    holdingRows = [{ ticker: 'NVDA' }];
    const objectHoldings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert('object holdings returns stable 500', objectHoldings.status === 500);
    assert(
      'object holdings stable error',
      objectHoldings.body.error === 'Invalid backtest holdings payload'
    );

    holdingRows = [{ ticker: 'NVDA', return_since_entry: '0.12', is_stale: false }];
    const missingWeightHoldings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert('missing weight holdings returns stable 500', missingWeightHoldings.status === 500);

    holdingRows = [
      {
        ticker: 'NVDA',
        weight: Number.POSITIVE_INFINITY,
        return_since_entry: 0.12,
        is_stale: false,
      },
    ];
    const nonFiniteWeightHoldings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert('non-finite weight holdings returns stable 500', nonFiniteWeightHoldings.status === 500);

    holdingRows = [{ ticker: 'NVDA', weight: '0.15', is_stale: false }];
    const missingReturnHoldings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert(
      'missing return_since_entry holdings returns stable 500',
      missingReturnHoldings.status === 500
    );

    holdingRows = [
      { ticker: 'NVDA', weight: 0.15, return_since_entry: Number.NaN, is_stale: false },
    ];
    const nonFiniteReturnHoldings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert(
      'non-finite return_since_entry holdings returns stable 500',
      nonFiniteReturnHoldings.status === 500
    );

    holdingRows = [{ ticker: 'NVDA', weight: 0.15, return_since_entry: 0.12, is_stale: 'false' }];
    const badStaleHoldings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert('non-boolean is_stale holdings returns stable 500', badStaleHoldings.status === 500);

    holdingRows = [{ ticker: '', weight: '0.15', return_since_entry: '0.12', is_stale: false }];
    const emptyTickerHoldings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert('empty ticker holdings returns stable 500', emptyTickerHoldings.status === 500);

    holdingRows = [{ ticker: 123, weight: '0.15', return_since_entry: '0.12', is_stale: false }];
    const nonStringTickerHoldings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert('non-string ticker holdings returns stable 500', nonStringTickerHoldings.status === 500);

    duplicateRows = true;
    holdingRows = [{ ticker: 'AAPL', weight: '0.15', return_since_entry: '0.12', is_stale: false }];
    const ambiguousDetail = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}?market_scope=${MARKET_SCOPE}`
    );
    assert('duplicate PIT snapshots return 409', ambiguousDetail.status === 409);
    const ambiguousHoldings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert('duplicate PIT holdings return 409', ambiguousHoldings.status === 409);
    duplicateRows = false;

    const beforeInvalid = calls.length;
    const invalidStrategy = await authorizedGet(app, '/api/v1/backtest-pit/not-a-strategy');
    assert(
      'invalid strategy returns 400',
      invalidStrategy.status === 400,
      `status=${invalidStrategy.status}`
    );
    assert('invalid strategy never queries DB', calls.length === beforeInvalid);

    const missingScope = await authorizedGet(app, `/api/v1/backtest-pit/${STRATEGY}`);
    assert('missing market_scope returns 400', missingScope.status === 400);
    const incompatibleScope = await authorizedGet(
      app,
      '/api/v1/backtest-pit/japan_blue_chip?market_scope=us'
    );
    assert('incompatible market_scope returns 400', incompatibleScope.status === 400);
    const customScope = await authorizedGet(app, '/api/v1/backtest-pit/custom?market_scope=cn_a');
    assert('custom PIT replay is rejected until exact weights persist', customScope.status === 400);

    const beforeInvalidTimestamp = calls.length;
    const invalidAsOf = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/not-a-timestamp?market_scope=${MARKET_SCOPE}`
    );
    assert('invalid as_of returns 400', invalidAsOf.status === 400, `status=${invalidAsOf.status}`);
    const dateOnlyAsOf = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/2026-07-10?market_scope=${MARKET_SCOPE}`
    );
    assert(
      'date-only as_of returns 400',
      dateOnlyAsOf.status === 400,
      `status=${dateOnlyAsOf.status}`
    );
    assert('invalid as_of never queries DB', calls.length === beforeInvalidTimestamp);

    returnEmpty = true;
    const missingDetail = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}?market_scope=${MARKET_SCOPE}`
    );
    assert(
      'missing snapshot returns 404',
      missingDetail.status === 404,
      `status=${missingDetail.status}`
    );
    assert(
      'missing snapshot returns stable error',
      missingDetail.body.error === 'Backtest snapshot not found'
    );

    const missingHoldings = await authorizedGet(
      app,
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings?market_scope=${MARKET_SCOPE}`
    );
    assert('missing holdings snapshot returns 404', missingHoldings.status === 404);
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
