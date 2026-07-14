import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import backtestPitRoutes from '../../src/api/routes/backtestPit.routes';
import { sequelize } from '../../src/config/database';

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
  const before = await sequelize.query<{ snapshots: string; holdings: string }>(
    `SELECT
       (SELECT count(*)::text FROM backtest_pit_snapshot) AS snapshots,
       (SELECT count(*)::text FROM backtest_pit_holding) AS holdings`,
    { type: 'SELECT' as any }
  );
  assert.deepEqual(before[0], { snapshots: '216', holdings: '648' });

  const lists: Record<string, unknown> = {};
  const details: Record<string, unknown> = {};
  const holdings: Record<string, unknown> = {};
  let requestCount = 0;
  let sawStale = false;
  let sawDelisted = false;

  for (const [strategy, scope] of PAIRS) {
    const listResponse = await request(app).get(listUrl(strategy, scope));
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

      const detailResponse = await request(app).get(detailUrl(strategy, scope, snapshot.as_of_utc));
      requestCount += 1;
      assert.equal(detailResponse.status, 200, detailResponse.text);
      assert.equal(detailResponse.body.snapshot_id, snapshot.snapshot_id);
      assert.equal(detailResponse.body.holdings.length, 3);
      assert.equal(detailResponse.body.metrics.metric_contract_version, '1.0.0');
      details[snapshot.snapshot_id] = detailResponse.body;

      const holdingsResponse = await request(app).get(
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

  const originalQuery = sequelize.query.bind(sequelize);
  let invalidDbReads = 0;
  (sequelize as any).query = async (...args: any[]) => {
    invalidDbReads += 1;
    return originalQuery(...args);
  };
  const invalidResponses = [];
  for (const strategy of ALL_STRATEGIES) {
    for (const scope of SCOPES) {
      if (!legal.has(`${strategy}/${scope}`)) {
        invalidResponses.push(await request(app).get(listUrl(strategy, scope)));
      }
    }
  }
  invalidResponses.push(
    await request(app).get('/api/v1/backtest-pit/custom?market_scope=cn_a'),
    await request(app).get('/api/v1/backtest-pit/us_preferred/not-a-timestamp?market_scope=us')
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
  await sequelize.close();
}

main().catch(async error => {
  console.error(error);
  await sequelize.close().catch(() => undefined);
  process.exit(1);
});
