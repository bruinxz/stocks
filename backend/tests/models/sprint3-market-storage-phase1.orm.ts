/**
 * Real Sequelize -> disposable PostgreSQL proof for generated columns.
 *
 * The shell harness supplies an isolated database and runs this file after the
 * forward migration. No host-user database or production service is touched.
 */

import { Sequelize } from 'sequelize-typescript';
import { JpkrFinancialSnapshot } from '../../src/models/JpkrFinancialSnapshot';

async function main(): Promise<void> {
  const sequelize = new Sequelize({
    database: process.env.DB_NAME,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    dialect: 'postgres',
    logging: false,
    models: [JpkrFinancialSnapshot],
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

    console.log('sprint3-market-storage-phase1.orm: PASS (generated 2025, tamper rejected)');
  } finally {
    await sequelize.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
