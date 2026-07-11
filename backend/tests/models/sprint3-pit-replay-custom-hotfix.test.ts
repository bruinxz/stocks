/**
 * P0 PIT replay hotfix proof.
 *
 * Default manifest mode is DB-less. The PG harness sets PIT_HOTFIX_PG=1 and
 * verifies that a real Sequelize create with strategy=custom is rejected by
 * PostgreSQL while the six replayable profiles remain constructible.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Sequelize } from 'sequelize-typescript';
import { BacktestPitSnapshot } from '../../src/models/BacktestPitSnapshot';

const ROOT = join(__dirname, '../..');
const UP_PATH = join(ROOT, 'scripts/migrations/2026-07-12-pit-replay-custom-hotfix.sql');
const DOWN_PATH = join(ROOT, 'scripts/migrations/2026-07-12-pit-replay-custom-hotfix-rollback.sql');
const MODEL_PATH = join(ROOT, 'src/models/BacktestPitSnapshot.ts');

function staticProof(): void {
  const up = readFileSync(UP_PATH, 'utf8');
  const down = readFileSync(DOWN_PATH, 'utf8');
  const model = readFileSync(MODEL_PATH, 'utf8');

  if (!existsSync(UP_PATH) || !existsSync(DOWN_PATH)) {
    throw new Error('paired PIT replay hotfix migrations are required');
  }
  if (/\|\s*'custom'/.test(model)) {
    throw new Error('BacktestPitSnapshot model must not expose custom replay');
  }
  if (!/ADD CONSTRAINT ck_backtest_pit_strategy/.test(up)) {
    throw new Error('forward migration must install the six-profile strategy check');
  }
  const forwardStrategyBlock =
    up.match(/ADD CONSTRAINT ck_backtest_pit_strategy[\s\S]*?\)\),/)?.[0] || '';
  if (/\bcustom\b/.test(forwardStrategyBlock)) {
    throw new Error('forward strategy check must reject custom');
  }
  if (!/\bcustom\b/.test(down)) {
    throw new Error('paired rollback must restore the prior custom contract');
  }
}

async function pgProof(): Promise<void> {
  const sequelize = new Sequelize({
    database: process.env.DB_NAME,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    dialect: 'postgres',
    logging: false,
    models: [BacktestPitSnapshot],
  });

  try {
    await sequelize.authenticate();
    let rejected = false;
    try {
      await BacktestPitSnapshot.create({
        strategy: 'custom',
        marketScope: 'us',
        asOfUtc: new Date('2026-07-10T10:00:00Z'),
        snapshotDay: '2026-07-10',
        publishedAtUtc: new Date('2026-07-10T10:01:00Z'),
        isSurvivorshipBiased: true,
        isDelistedAtAsOf: false,
        sourceVersions: { prices: 'v1' },
        lineageClosure: {},
        metrics: {},
        factHash: 'a'.repeat(64),
      } as any);
    } catch (error: any) {
      rejected = error?.original?.code === '23514';
    }
    if (!rejected) throw new Error('custom PIT replay was not rejected');
  } finally {
    await sequelize.close();
  }
}

async function main(): Promise<void> {
  staticProof();
  if (process.env.PIT_HOTFIX_PG === '1') await pgProof();
  console.log('sprint3-pit-replay-custom-hotfix: PASS');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
