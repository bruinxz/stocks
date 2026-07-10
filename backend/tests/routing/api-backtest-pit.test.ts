import express from 'express';
import request from 'supertest';
import backtestPitRoutes from '../../src/api/routes/backtestPit.routes';
import { sequelize } from '../../src/config/database';

const STRATEGY = 'us_preferred';
const AS_OF = '2026-07-10T06:00:00Z';
const ENCODED_AS_OF = encodeURIComponent(AS_OF);

type QueryCall = {
  sql: string;
  replacements: Record<string, unknown>;
};

const SNAPSHOT = {
  snapshot_id: '11111111-1111-4111-8111-111111111111',
  strategy: STRATEGY,
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
  holdings: [{ ticker: 'AAPL', weight: 0.15, return_since_entry: 0.12, is_stale: false }],
  fact_hash: 'a'.repeat(64),
};

const LIST_SNAPSHOT = {
  ...SNAPSHOT,
  metrics: undefined,
  holdings: undefined,
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
  let holdingsPayload: unknown = SNAPSHOT.holdings;

  (sequelize as any).query = async (sql: string, options: any) => {
    calls.push({ sql, replacements: options?.replacements || {} });
    if (returnEmpty) return [];
    const requestedAsOf = options?.replacements?.as_of;
    if (requestedAsOf && Date.parse(String(requestedAsOf)) !== Date.parse(AS_OF)) {
      return [];
    }
    if (sql.includes('SELECT bps.holdings')) {
      if (duplicateRows) {
        return [{ holdings: [] }, { holdings: [] }];
      }
      return [{ holdings: holdingsPayload }];
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

    const list = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}?from=2026-01-01&to=2026-07-10&limit=5`
    );
    assert('list returns 200 without Authorization', list.status === 200, `status=${list.status}`);
    assert('list envelope keeps strategy', list.body.strategy === STRATEGY);
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
    const listCall = calls.at(-1);
    assert(
      'list uses parameterized filters',
      listCall?.replacements.strategy === STRATEGY &&
        listCall?.replacements.from === '2026-01-01' &&
        listCall?.replacements.to === '2026-07-10' &&
        listCall?.replacements.limit === 5
    );

    const detail = await request(app).get(`/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}`);
    assert('detail returns deterministic 200', detail.status === 200, `status=${detail.status}`);
    assert('detail returns canonical snapshot', detail.body.snapshot_id === SNAPSHOT.snapshot_id);
    assert('detail keeps nested metrics', detail.body.metrics?.net_value === 1.24);
    const detailCall = calls.at(-1);
    assert(
      'detail matches exact as_of_utc',
      Boolean(detailCall?.sql.includes('bps.as_of_utc = CAST(:as_of AS timestamptz)'))
    );
    assert(
      'detail limits to two rows to detect ambiguity',
      Boolean(detailCall?.sql.includes('LIMIT 2'))
    );
    assert('detail passes exact timestamp', detailCall?.replacements.as_of === AS_OF);

    const equivalentAsOf = '2026-07-10T14:00:00+08:00';
    const equivalentDetail = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${encodeURIComponent(equivalentAsOf)}`
    );
    assert(
      'timezone-equivalent as_of reaches exact timestamptz equality',
      equivalentDetail.status === 200,
      `status=${equivalentDetail.status}`
    );
    assert(
      'timezone-equivalent replacement is preserved byte-for-byte',
      calls.at(-1)?.replacements.as_of === equivalentAsOf
    );

    const nonEquivalentAsOf = '2026-07-10T06:00:01Z';
    const nonEquivalentDetail = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${encodeURIComponent(nonEquivalentAsOf)}`
    );
    assert(
      'non-equivalent as_of can miss instead of matching unintended row',
      nonEquivalentDetail.status === 404,
      `status=${nonEquivalentDetail.status}`
    );

    const holdings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
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
    const holdingsCall = calls.at(-1);
    assert(
      'holdings matches exact as_of_utc',
      Boolean(holdingsCall?.sql.includes('bps.as_of_utc = CAST(:as_of AS timestamptz)'))
    );
    assert(
      'holdings limits to two rows to detect ambiguity',
      Boolean(holdingsCall?.sql.includes('LIMIT 2'))
    );

    holdingsPayload = JSON.stringify(SNAPSHOT.holdings);
    const stringArrayHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert(
      'JSON string array holdings remain valid',
      stringArrayHoldings.status === 200 && stringArrayHoldings.body.holdings.length === 1
    );

    holdingsPayload = null;
    const nullHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert(
      'null holdings normalize to []',
      nullHoldings.status === 200 && nullHoldings.body.holdings.length === 0
    );

    holdingsPayload = undefined;
    const undefinedHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert(
      'undefined holdings normalize to []',
      undefinedHoldings.status === 200 && undefinedHoldings.body.holdings.length === 0
    );

    holdingsPayload = { ticker: 'NVDA' };
    const objectHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert('object holdings returns stable 500', objectHoldings.status === 500);
    assert(
      'object holdings stable error',
      objectHoldings.body.error === 'Invalid backtest holdings payload'
    );

    holdingsPayload = 'null';
    const stringNullHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert('string null holdings returns stable 500', stringNullHoldings.status === 500);
    assert(
      'string null holdings stable error',
      stringNullHoldings.body.error === 'Invalid backtest holdings payload'
    );

    holdingsPayload = '{not-json';
    const malformedHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert('malformed holdings returns stable 500', malformedHoldings.status === 500);
    assert(
      'malformed holdings stable error',
      malformedHoldings.body.error === 'Invalid backtest holdings payload'
    );

    holdingsPayload = [{ ticker: 'NVDA', return_since_entry: 0.12, is_stale: false }];
    const missingWeightHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert('missing weight holdings returns stable 500', missingWeightHoldings.status === 500);

    holdingsPayload = [
      {
        ticker: 'NVDA',
        weight: Number.POSITIVE_INFINITY,
        return_since_entry: 0.12,
        is_stale: false,
      },
    ];
    const nonFiniteWeightHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert('non-finite weight holdings returns stable 500', nonFiniteWeightHoldings.status === 500);

    holdingsPayload = [{ ticker: 'NVDA', weight: 0.15, is_stale: false }];
    const missingReturnHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert(
      'missing return_since_entry holdings returns stable 500',
      missingReturnHoldings.status === 500
    );

    holdingsPayload = [
      { ticker: 'NVDA', weight: 0.15, return_since_entry: Number.NaN, is_stale: false },
    ];
    const nonFiniteReturnHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert(
      'non-finite return_since_entry holdings returns stable 500',
      nonFiniteReturnHoldings.status === 500
    );

    holdingsPayload = [
      { ticker: 'NVDA', weight: 0.15, return_since_entry: 0.12, is_stale: 'false' },
    ];
    const badStaleHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert('non-boolean is_stale holdings returns stable 500', badStaleHoldings.status === 500);

    holdingsPayload = [{ ticker: '', weight: 0.15, return_since_entry: 0.12, is_stale: false }];
    const emptyTickerHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert('empty ticker holdings returns stable 500', emptyTickerHoldings.status === 500);

    holdingsPayload = [{ ticker: 123, weight: 0.15, return_since_entry: 0.12, is_stale: false }];
    const nonStringTickerHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert('non-string ticker holdings returns stable 500', nonStringTickerHoldings.status === 500);

    duplicateRows = true;
    holdingsPayload = SNAPSHOT.holdings;
    const ambiguousDetail = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}`
    );
    assert('duplicate PIT snapshots return 409', ambiguousDetail.status === 409);
    const ambiguousHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
    );
    assert('duplicate PIT holdings return 409', ambiguousHoldings.status === 409);
    duplicateRows = false;

    const beforeInvalid = calls.length;
    const invalidStrategy = await request(app).get('/api/v1/backtest-pit/not-a-strategy');
    assert(
      'invalid strategy returns 400',
      invalidStrategy.status === 400,
      `status=${invalidStrategy.status}`
    );
    assert('invalid strategy never queries DB', calls.length === beforeInvalid);

    const invalidAsOf = await request(app).get(`/api/v1/backtest-pit/${STRATEGY}/not-a-timestamp`);
    assert('invalid as_of returns 400', invalidAsOf.status === 400, `status=${invalidAsOf.status}`);
    const dateOnlyAsOf = await request(app).get(`/api/v1/backtest-pit/${STRATEGY}/2026-07-10`);
    assert(
      'date-only as_of returns 400',
      dateOnlyAsOf.status === 400,
      `status=${dateOnlyAsOf.status}`
    );
    assert('invalid as_of never queries DB', calls.length === beforeInvalid);

    returnEmpty = true;
    const missingDetail = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}`
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

    const missingHoldings = await request(app).get(
      `/api/v1/backtest-pit/${STRATEGY}/${ENCODED_AS_OF}/holdings`
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
