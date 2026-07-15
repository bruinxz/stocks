import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import backtestPitRoutes from '../../src/api/routes/backtestPit.routes';
import { sequelize } from '../../src/config/database';
import { User } from '../../src/models/User';

type Pair = readonly [string, string];

const PAIRS: readonly Pair[] = [
  ['us_preferred', 'cn_a'],
  ['us_preferred', 'us'],
  ['multibagger', 'cn_a'],
  ['multibagger', 'us'],
  ['japan_blue_chip', 'jp'],
  ['japan_multibagger', 'jp'],
  ['korea_semiconductor_chain', 'kr'],
  ['korea_multibagger', 'kr'],
];
const ALL_STRATEGIES = [
  'us_preferred',
  'multibagger',
  'japan_blue_chip',
  'japan_multibagger',
  'korea_semiconductor_chain',
  'korea_multibagger',
];
const SCOPES = ['cn_a', 'us', 'jp', 'kr'];
const legal = new Set(PAIRS.map(([strategy, scope]) => `${strategy}/${scope}`));
const artifactPath = path.resolve(
  __dirname,
  process.env.T5D_RESPONSE_ARTIFACT || 'tab5-six-month-live-responses.json'
);
const app = express();
app.use('/api/v1/backtest-pit', backtestPitRoutes);

let authorization = '';

function authorizedGet(url: string) {
  return request(app).get(url).set('Authorization', authorization);
}

function listUrl(strategy: string, scope: string): string {
  return (
    `/api/v1/backtest-pit/${encodeURIComponent(strategy)}` +
    `?market_scope=${scope}&from=2026-01-10&to=2026-07-10&limit=27`
  );
}

function detailUrl(strategy: string, scope: string, asOf: string): string {
  return (
    `/api/v1/backtest-pit/${encodeURIComponent(strategy)}/` +
    `${encodeURIComponent(asOf)}?market_scope=${scope}`
  );
}

function holdingsUrl(strategy: string, scope: string, asOf: string): string {
  return (
    `/api/v1/backtest-pit/${encodeURIComponent(strategy)}/` +
    `${encodeURIComponent(asOf)}/holdings?market_scope=${scope}`
  );
}

async function main(): Promise<void> {
  if (process.env.T5D_LIVE_HTTP_TEST !== '1') {
    console.log('tab5-six-month-live-http: SKIP (explicit disposable-PG harness only)');
    return;
  }
  const jwtSecret = process.env.JWT_SECRET;
  assert.ok(jwtSecret, 'JWT_SECRET is required by the disposable-PG harness');
  const originalFindByPk = User.findByPk;
  const activeUser = {
    id: 7005,
    username: 'tab5-live-http',
    email: 'tab5-live-http@example.com',
    role: 'analyst',
    is_active: true,
  } as User;
  let userLookups = 0;
  (User as any).findByPk = async (id: number) => {
    userLookups += 1;
    return id === activeUser.id ? activeUser : null;
  };
  authorization = `Bearer ${jwt.sign(
    { user_id: activeUser.id, username: activeUser.username, role: activeUser.role },
    jwtSecret,
    { expiresIn: '5m' }
  )}`;

  const before = await sequelize.query<{ snapshots: string; holdings: string }>(
    `SELECT
       (SELECT count(*)::text FROM backtest_pit_snapshot) AS snapshots,
       (SELECT count(*)::text FROM backtest_pit_holding) AS holdings`,
    { type: 'SELECT' as any }
  );
  assert.deepEqual(before[0], { snapshots: '216', holdings: '648' });

  const originalQuery = sequelize.query.bind(sequelize);
  let unauthorizedDatabaseCalls = 0;
  (sequelize as any).query = async (...args: any[]) => {
    unauthorizedDatabaseCalls += 1;
    return originalQuery(...args);
  };
  const lookupsBeforeUnauthorized = userLookups;
  const missingAuthorization = await request(app).get(listUrl('us_preferred', 'us'));
  const invalidAuthorization = await request(app)
    .get(listUrl('us_preferred', 'us'))
    .set('Authorization', 'Bearer invalid.jwt.token');
  assert.equal(missingAuthorization.status, 401, missingAuthorization.text);
  assert.equal(invalidAuthorization.status, 401, invalidAuthorization.text);
  assert.equal(unauthorizedDatabaseCalls, 0, 'unauthorized requests must not invoke handlers');
  assert.equal(
    userLookups,
    lookupsBeforeUnauthorized,
    'invalid credentials must not look up users'
  );
  (sequelize as any).query = originalQuery;

  const lists: Record<string, unknown> = {};
  const details: Record<string, unknown> = {};
  const holdings: Record<string, unknown> = {};
  let requestCount = 0;
  let sawStale = false;
  let sawDelisted = false;

  for (const [strategy, scope] of PAIRS) {
    const listResponse = await authorizedGet(listUrl(strategy, scope));
    requestCount += 1;
    assert.equal(listResponse.status, 200, listResponse.text);
    assert.equal(listResponse.body.strategy, strategy);
    assert.equal(listResponse.body.market_scope, scope);
    assert.equal(listResponse.body.snapshots.length, 27);
    lists[`${strategy}/${scope}`] = listResponse.body;

    for (const snapshot of listResponse.body.snapshots) {
      assert.equal(snapshot.strategy, strategy);
      assert.equal(snapshot.market_scope, scope);
      assert.equal(snapshot.is_survivorship_biased, false);
      assert.equal(snapshot.fact_hash.length, 64);
      for (const key of [
        'net_value',
        'drawdown',
        'cumulative_return',
        'sharpe_ratio_6m',
        'win_rate_6m',
      ]) {
        assert.ok(snapshot[key] == null || Number.isFinite(snapshot[key]), key);
      }
      assert.ok(snapshot.drawdown <= 0 && snapshot.drawdown >= -1);
      sawDelisted ||= snapshot.is_delisted_at_as_of === true;

      const detailResponse = await authorizedGet(detailUrl(strategy, scope, snapshot.as_of_utc));
      requestCount += 1;
      assert.equal(detailResponse.status, 200, detailResponse.text);
      assert.equal(detailResponse.body.snapshot_id, snapshot.snapshot_id);
      assert.equal(detailResponse.body.holdings.length, 3);
      assert.equal(detailResponse.body.metrics.metric_contract_version, '1.0.0');
      details[snapshot.snapshot_id] = detailResponse.body;

      const holdingsResponse = await authorizedGet(
        holdingsUrl(strategy, scope, snapshot.as_of_utc)
      );
      requestCount += 1;
      assert.equal(holdingsResponse.status, 200, holdingsResponse.text);
      assert.equal(holdingsResponse.body.holdings.length, 3);
      const weight = holdingsResponse.body.holdings.reduce(
        (sum: number, item: any) => sum + item.weight,
        0
      );
      assert.ok(Math.abs(weight - 1) <= 1e-9);
      sawStale ||= holdingsResponse.body.holdings.some((item: any) => item.is_stale === true);
      holdings[snapshot.snapshot_id] = holdingsResponse.body;
    }
  }
  assert.equal(requestCount, 440);
  assert.ok(sawStale, 'at least one stale holding must be visible');
  assert.ok(sawDelisted, 'at least one delisted snapshot must be visible');

  let invalidDbReads = 0;
  (sequelize as any).query = async (...args: any[]) => {
    invalidDbReads += 1;
    return originalQuery(...args);
  };
  const invalidResponses = [];
  for (const strategy of ALL_STRATEGIES) {
    for (const scope of SCOPES) {
      if (!legal.has(`${strategy}/${scope}`)) {
        invalidResponses.push(await authorizedGet(listUrl(strategy, scope)));
      }
    }
  }
  invalidResponses.push(
    await authorizedGet('/api/v1/backtest-pit/custom?market_scope=cn_a'),
    await authorizedGet('/api/v1/backtest-pit/us_preferred/not-a-timestamp?market_scope=us')
  );
  assert.equal(invalidResponses.length, 18);
  assert.ok(invalidResponses.every(response => response.status === 400));
  assert.equal(invalidDbReads, 0, 'invalid requests must not read or write PostgreSQL');
  (sequelize as any).query = originalQuery;

  const after = await sequelize.query<{ snapshots: string; holdings: string }>(
    `SELECT
       (SELECT count(*)::text FROM backtest_pit_snapshot) AS snapshots,
       (SELECT count(*)::text FROM backtest_pit_holding) AS holdings`,
    { type: 'SELECT' as any }
  );
  assert.deepEqual(after[0], before[0]);

  fs.writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        generated_from: 'live-disposable-postgresql',
        request_count: requestCount,
        invalid_request_count: invalidResponses.length,
        pairs: PAIRS,
        lists,
        details,
        holdings,
        invalid_db_reads: invalidDbReads,
      },
      null,
      2
    )
  );
  console.log(
    `tab5-six-month-live-http: PASS ` +
      `(440 HTTP, 216 details, 216 holdings, stale=${sawStale}, delisted=${sawDelisted})`
  );
  (User as any).findByPk = originalFindByPk;
  await sequelize.close();
}

main().catch(async error => {
  console.error(error);
  await sequelize.close().catch(() => undefined);
  process.exit(1);
});
