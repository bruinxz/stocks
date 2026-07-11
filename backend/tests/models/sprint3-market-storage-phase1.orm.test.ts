/**
 * Real Sequelize -> disposable PostgreSQL proof for generated columns.
 *
 * The shell harness supplies an isolated database and runs this file after the
 * forward migration. No host-user database or production service is touched.
 */

import { Sequelize } from 'sequelize-typescript';
import { SPRINT3_MIGRATION_OWNED_MODELS } from '../../src/models/Sprint3MigrationOwnedModels';
import { BacktestPitHolding } from '../../src/models/BacktestPitHolding';
import { BacktestPitSnapshot } from '../../src/models/BacktestPitSnapshot';
import { JpkrFinancialSnapshot } from '../../src/models/JpkrFinancialSnapshot';

async function main(): Promise<void> {
  if (process.env.SPRINT3_ORM_PG !== '1') {
    const guardSequelize = new Sequelize({
      dialect: 'postgres',
      logging: false,
      models: SPRINT3_MIGRATION_OWNED_MODELS as any,
    });
    const fiscalYear = JpkrFinancialSnapshot.getAttributes().fiscalYear;
    if (!fiscalYear || fiscalYear.allowNull !== true) {
      throw new Error('generated fiscalYear must disable insert-side not-null validation');
    }
    for (const model of SPRINT3_MIGRATION_OWNED_MODELS) {
      const synced = await model.sync({ alter: true });
      if (synced !== model) {
        throw new Error(`migration-owned sync guard failed for ${model.name}`);
      }
    }
    await guardSequelize.close();
    console.log('sprint3-market-storage-phase1.orm: PASS (manifest guard)');
    return;
  }

  const sequelize = new Sequelize({
    database: process.env.DB_NAME,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    dialect: 'postgres',
    logging: false,
    models: SPRINT3_MIGRATION_OWNED_MODELS as any,
  });

  try {
    await sequelize.authenticate();
    const created = await JpkrFinancialSnapshot.create({
      marketScope: 'jp',
      ticker: '7203',
      fiscalPeriodEnd: '2025-03-31',
      fiscalPeriodKind: 'ANNUAL',
      fiscalQuarter: null,
      currency: 'JPY',
      segmentFacts: [],
      taxonomyVersion: 'taxonomy-v1',
      parserVersion: 'parser-v1',
      accountMappingVersion: null,
      conceptProvenance: {},
      parseWarnings: [],
      sourcePayload: {},
      sourceKind: 'jpx-edinet',
      sourceDocumentId: 'orm-generated-year',
      sourceVersion: 'v1',
      effectiveAtUtc: new Date('2025-03-31T06:00:00Z'),
      availableAtUtc: new Date('2025-06-20T06:00:00Z'),
      factHash: 'a'.repeat(64),
    });

    if (created.fiscalYear !== 2025) {
      throw new Error(`expected generated fiscalYear=2025, got ${created.fiscalYear}`);
    }

    let tamperRejected = false;
    try {
      await JpkrFinancialSnapshot.create({
        marketScope: 'jp',
        ticker: '7203',
        fiscalPeriodEnd: '2026-03-31',
        fiscalPeriodKind: 'ANNUAL',
        fiscalQuarter: null,
        fiscalYear: 1999,
        currency: 'JPY',
        segmentFacts: [],
        taxonomyVersion: 'taxonomy-v1',
        parserVersion: 'parser-v1',
        accountMappingVersion: null,
        conceptProvenance: {},
        parseWarnings: [],
        sourcePayload: {},
        sourceKind: 'jpx-edinet',
        sourceDocumentId: 'orm-tampered-year',
        sourceVersion: 'v1',
        effectiveAtUtc: new Date('2026-03-31T06:00:00Z'),
        availableAtUtc: new Date('2026-06-20T06:00:00Z'),
        factHash: 'b'.repeat(64),
      } as any);
    } catch (error: any) {
      tamperRejected =
        error?.original?.code === '428C9' ||
        String(error?.message || error).includes('generated column');
    }
    if (!tamperRejected) {
      throw new Error('explicit fiscalYear tamper was not rejected');
    }

    const [beforeFkRows] = await sequelize.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'fk_backtest_pit_holding_snapshot_as_of'`
    );
    const beforeFk = String((beforeFkRows as any[])[0]?.definition || '');
    if (
      !beforeFk.includes('(snapshot_id, market_scope, snapshot_as_of_utc)') ||
      !beforeFk.includes('(snapshot_id, market_scope, as_of_utc)')
    ) {
      throw new Error(`unexpected pre-sync PIT FK: ${beforeFk}`);
    }

    await sequelize.sync({ alter: true });

    const [afterFkRows] = await sequelize.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'fk_backtest_pit_holding_snapshot_as_of'`
    );
    const afterFk = String((afterFkRows as any[])[0]?.definition || '');
    if (afterFk !== beforeFk) {
      throw new Error(`alter sync changed PIT FK: before=${beforeFk} after=${afterFk}`);
    }

    const snapshot = await BacktestPitSnapshot.create({
      strategy: 'us_preferred',
      marketScope: 'us',
      asOfUtc: new Date('2026-07-10T09:00:00Z'),
      snapshotDay: '2026-07-10',
      publishedAtUtc: new Date('2026-07-10T09:01:00Z'),
      isSurvivorshipBiased: true,
      isDelistedAtAsOf: false,
      sourceVersions: { prices: 'v1' },
      lineageClosure: {},
      metrics: {},
      factHash: 'c'.repeat(64),
    });

    let crossScopeRejected = false;
    try {
      await BacktestPitHolding.create({
        snapshotId: snapshot.snapshotId,
        snapshotAsOfUtc: new Date('2026-07-10T09:00:00Z'),
        positionOrder: 0,
        marketScope: 'cn_a',
        ticker: '600000',
        weight: '1',
        returnSinceEntry: '0',
        isStale: false,
        sourceKind: 'fixture',
        sourceDocumentId: 'cross-scope-after-sync',
        sourceVersion: 'v1',
        availableAtUtc: new Date('2026-07-10T09:00:00Z'),
        lineage: {},
        factHash: 'd'.repeat(64),
      });
    } catch (error: any) {
      crossScopeRejected = error?.original?.code === '23503';
    }
    if (!crossScopeRejected) {
      throw new Error('cross-scope holding was accepted after alter sync');
    }

    console.log(
      'sprint3-market-storage-phase1.orm: PASS ' +
        '(generated 2025, tamper rejected, alter sync preserved FK/defaults)'
    );
  } finally {
    await sequelize.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
