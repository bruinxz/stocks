import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import multibaggerRoutes from '../../src/api/routes/multibagger.routes';
import { sequelize } from '../../src/config/database';

const artifactPath = path.resolve(
  __dirname,
  process.env.TAB4_RESPONSE_ARTIFACT ?? 'tab4-multibagger-live-responses.json'
);

async function main(): Promise<void> {
  if (process.env.TAB4_LIVE_HTTP_TEST !== '1') {
    console.log('tab4-multibagger-live-http: SKIP (explicit disposable-PG harness only)');
    return;
  }

  const app = express();
  app.use(express.json());
  app.use('/api/v1/multibagger', multibaggerRoutes);

  const count = await sequelize.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM multibagger_candidate_snapshot',
    { type: 'SELECT' as any }
  );
  assert.equal(count[0].count, '1');

  const list = await request(app).get(
    '/api/v1/multibagger/candidates?stage=growth&conclusion=MULTIBAGGER_5X&market=JP'
  );
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.kpi.total_candidates, 1);
  assert.equal(list.body.rows.length, 1);
  const row = list.body.rows[0];
  assert.equal(row.symbol, '1301');
  assert.equal(row.market, 'JP');
  assert.equal(row.market_scope, 'jp');
  assert.equal(row.exchange, 'tse');
  assert.equal(row.stage, 'growth');
  assert.equal(row.conclusion, 'MULTIBAGGER_5X');
  assert.match(row.fact_hash, /^[0-9a-f]{64}$/);
  assert.ok(row.source_fact_hashes.length >= 2);
  assert.ok(row.source_fact_hashes.every((hash: unknown) => /^[0-9a-f]{64}$/.test(String(hash))));
  assert.ok(row.source_fact_hashes.includes(row.latest_catalyst.fact_hash));
  assert.ok(Date.parse(row.latest_catalyst.occurred_at) <= Date.parse(row.latest_catalyst.available_at_utc));
  assert.ok(Date.parse(row.latest_catalyst.available_at_utc) <= Date.parse(row.as_of_utc));
  assert.ok(Date.parse(row.available_at_utc) <= Date.parse(row.as_of_utc));
  assert.equal(row.strategy_version, 'japan-multibagger@1.0.0');
  assert.equal(row.classification_policy_version, 'stage-policy@1.0.0');
  assert.deepEqual(row.classification_reason_codes, ['CAPTURED_SOURCE']);

  const physical = await sequelize.query<any>(
    `SELECT market_scope, exchange, fact_hash, source_fact_hashes,
            strategy_version, classification_policy_version,
            classification_reason_codes
       FROM multibagger_candidate_snapshot`,
    { type: 'SELECT' as any }
  );
  assert.equal(physical.length, 1);
  for (const field of [
    'market_scope',
    'exchange',
    'fact_hash',
    'source_fact_hashes',
    'strategy_version',
    'classification_policy_version',
    'classification_reason_codes',
  ]) {
    assert.deepEqual(row[field], physical[0][field], `API proof pin mismatch: ${field}`);
  }

  const detail = await request(app).get('/api/v1/multibagger/1301/detail');
  assert.equal(detail.status, 200, detail.text);
  assert.deepEqual(detail.body, row);

  const originalQuery = sequelize.query.bind(sequelize);
  let invalidDatabaseCalls = 0;
  (sequelize as any).query = async (...args: any[]) => {
    invalidDatabaseCalls += 1;
    return originalQuery(...args);
  };
  const invalid = await request(app).get('/api/v1/multibagger/candidates?market=EU');
  assert.equal(invalid.status, 400);
  assert.equal(invalidDatabaseCalls, 0);
  (sequelize as any).query = originalQuery;

  fs.writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        generated_from: 'live-disposable-postgresql',
        list: list.body,
        detail: detail.body,
      },
      null,
      2
    )
  );
  console.log('tab4-multibagger-live-http: PASS (list/detail/proof pins/invalid guard)');
  await sequelize.close();
}

main().catch(async error => {
  console.error(error);
  await sequelize.close().catch(() => undefined);
  process.exit(1);
});
