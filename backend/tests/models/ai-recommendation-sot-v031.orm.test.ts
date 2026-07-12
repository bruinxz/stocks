import { createHash } from 'crypto';
import { deepStrictEqual } from 'assert';
import { Sequelize } from 'sequelize-typescript';
import { AiRecommendationItem } from '../../src/models/AiRecommendationItem';
import { AiRecommendationSnapshot } from '../../src/models/AiRecommendationSnapshot';
import { SPRINT3_MIGRATION_OWNED_MODELS } from '../../src/models/Sprint3MigrationOwnedModels';

const SNAPSHOT_ID = '88888888-8888-4888-8888-888888888888';
const ITEM_ID = '99999999-9999-4999-8999-999999999999';

function recommendation(): Record<string, unknown> {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    snapshot_id: SNAPSHOT_ID,
    ticker: 'AAPL',
    as_of: '2026-07-10T06:30:00Z',
    score: {
      scoring_id: '44444444-4444-4444-8444-444444444444',
      snapshot_hash: '4'.repeat(64),
      profile: 'us_preferred',
      market_scope: 'us',
      total: 90,
      rating: 'A',
      dims: [],
    },
    conviction: { final: 90 },
    risk_gate: { gate: 'GREEN', ok_to_enter: true, triggers: [] },
    entry_plan: { size_hint: { tier: 'TIER_5' } },
    trigger_signals: [{ code: 'RISK_GATE_CLEAN', strength: 'STRONG', detail: 'ok' }],
    weights: { contributions: [], normalized: false },
    explanation: {
      headline: 'fixture',
      body: 'evidence [E1]',
      caveats: [],
      language: 'en-US',
      template_id: 'fixture-v1',
      template_hash: '5'.repeat(64),
    },
    evidence_refs: [
      {
        id: 'E1',
        kind: 'RULE',
        source_uri: 'ai-rule://fixture/rule@1.0.0',
        as_of: '2026-07-10T06:30:00Z',
        hash: '6'.repeat(64),
      },
    ],
    model_version: 'model-v1',
    disclaimer_version: '1.0.0',
  };
}

function canonicalFixture(value: Record<string, unknown>): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)])
      );
    }
    return input;
  };
  return JSON.stringify(canonicalize(value));
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function envelope(
  rec: Record<string, unknown>,
  outputFingerprint: string
): Record<string, unknown> {
  return {
    snapshot_id: SNAPSHOT_ID,
    as_of: '2026-07-10T06:30:00Z',
    profile: 'us_preferred',
    market_scope: 'us',
    items: [{ recommendation: rec, rating_band: 'A' }],
    output_fingerprint: outputFingerprint,
    disclaimer: {
      version: '1.0.0',
      short_text: 'fixture',
      full_text: 'fixture disclaimer',
      language: 'en-US',
      effective_at: '2026-07-10T00:00:00Z',
      hash: 'c'.repeat(64),
    },
    meta: {
      contract_version: '0.3.1',
      profile_version: 'profile-v1',
      input_fingerprint: 'd'.repeat(64),
      strategy_version: 'strategy-v1',
      pipeline_version: 'pipeline-v1',
      generated_by: 'fixture',
      generation_ms: 1,
    },
  };
}

function options() {
  return {
    database: process.env.DB_NAME,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    dialect: 'postgres' as const,
    logging: false,
    models: SPRINT3_MIGRATION_OWNED_MODELS as any,
  };
}

async function manifestProof(): Promise<void> {
  const sequelize = new Sequelize({
    dialect: 'postgres',
    logging: false,
    models: SPRINT3_MIGRATION_OWNED_MODELS as any,
  });
  for (const model of [AiRecommendationSnapshot, AiRecommendationItem]) {
    const synced = await model.sync({ alter: true });
    if (synced !== model) throw new Error(`migration-owned sync guard failed for ${model.name}`);
  }
  await sequelize.close();
  console.log('ai-recommendation-sot-v031.orm: PASS (manifest guard)');
}

async function pgProof(): Promise<void> {
  const sequelize = new Sequelize(options());
  try {
    await sequelize.authenticate();
    const [beforeRows] = await sequelize.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid IN (
         'ai_recommendation_snapshot'::regclass,
         'ai_recommendation_item'::regclass
       )
       ORDER BY conname`
    );
    const before = JSON.stringify(beforeRows);
    await sequelize.sync({ alter: true });
    const [afterRows] = await sequelize.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid IN (
         'ai_recommendation_snapshot'::regclass,
         'ai_recommendation_item'::regclass
       )
       ORDER BY conname`
    );
    if (JSON.stringify(afterRows) !== before)
      throw new Error('alter sync changed canonical constraints');

    const rec = recommendation();
    const jcs = canonicalFixture(rec);
    const recHash = digest(jcs);
    const outputFingerprint = '0'.repeat(64);
    const env = envelope(rec, outputFingerprint);

    await sequelize.transaction(async transaction => {
      await AiRecommendationSnapshot.create(
        {
          snapshotId: SNAPSHOT_ID,
          asOfUtc: new Date('2026-07-10T06:30:00Z'),
          tradingDay: '2026-07-10',
          profile: 'us_preferred',
          marketScope: 'us',
          contractVersion: '0.3.1',
          profileVersion: 'profile-v1',
          pipelineVersion: 'pipeline-v1',
          modelVersion: 'model-v1',
          strategyVersion: 'strategy-v1',
          ruleBundleHash: 'a'.repeat(64),
          templateHash: 'b'.repeat(64),
          disclaimerHash: 'c'.repeat(64),
          inputFingerprint: 'd'.repeat(64),
          outputFingerprint,
          idempotencyKey: '2'.repeat(64),
          itemCount: 1,
          envelopeJson: env,
        },
        { transaction }
      );
      await AiRecommendationItem.create(
        {
          itemId: ITEM_ID,
          snapshotId: SNAPSHOT_ID,
          ticker: 'AAPL',
          sortRank: 0,
          recommendationJson: rec,
          recommendationJcs: jcs,
          recommendationHash: recHash,
          ratingBand: 'A',
          convictionFinal: '90.0',
          riskGateStatus: 'GREEN',
          sizeHintTier: 'TIER_5',
        },
        { transaction }
      );
    });

    const item = await AiRecommendationItem.findByPk(ITEM_ID);
    if (!item || item.recommendationJcs !== jcs || item.recommendationHash !== recHash) {
      throw new Error('JCS/hash round-trip mismatch');
    }
    const snapshot = await AiRecommendationSnapshot.findByPk(SNAPSHOT_ID);
    if (!snapshot) throw new Error('RecommendationList snapshot missing after write');
    deepStrictEqual(snapshot.envelopeJson, env, 'RecommendationList envelope round-trip mismatch');

    let atomicRollback = false;
    const invalidRec = {
      ...rec,
      id: '66666666-6666-4666-8666-666666666666',
      snapshot_id: '55555555-5555-4555-8555-555555555555',
      ticker: 'MSFT',
    };
    const invalidJcs = canonicalFixture(invalidRec);
    try {
      await sequelize.transaction(async transaction => {
        await AiRecommendationSnapshot.create(
          {
            snapshotId: '55555555-5555-4555-8555-555555555555',
            asOfUtc: new Date('2026-07-10T06:31:00Z'),
            tradingDay: '2026-07-10',
            profile: 'us_preferred',
            marketScope: 'us',
            contractVersion: '0.3.1',
            profileVersion: 'profile-v1',
            pipelineVersion: 'pipeline-v1',
            modelVersion: 'model-v1',
            strategyVersion: 'strategy-v1',
            ruleBundleHash: 'a'.repeat(64),
            templateHash: 'b'.repeat(64),
            disclaimerHash: 'c'.repeat(64),
            inputFingerprint: 'd'.repeat(64),
            outputFingerprint: '7'.repeat(64),
            idempotencyKey: '8'.repeat(64),
            itemCount: 1,
            envelopeJson: {
              ...env,
              snapshot_id: '55555555-5555-4555-8555-555555555555',
              output_fingerprint: '7'.repeat(64),
            },
          },
          { transaction }
        );
        await AiRecommendationItem.create(
          {
            itemId: '66666666-6666-4666-8666-666666666666',
            snapshotId: '55555555-5555-4555-8555-555555555555',
            ticker: 'MSFT',
            sortRank: 0,
            recommendationJson: invalidRec,
            recommendationJcs: invalidJcs,
            recommendationHash: digest(invalidJcs),
            ratingBand: 'A',
            convictionFinal: '90.0',
            riskGateStatus: 'RED',
            sizeHintTier: 'TIER_5',
          },
          { transaction }
        );
      });
    } catch (error: any) {
      atomicRollback = error?.original?.code === '23514';
    }
    if (!atomicRollback) throw new Error('invalid child did not roll back atomic write');
    if (await AiRecommendationSnapshot.findByPk('55555555-5555-4555-8555-555555555555')) {
      throw new Error('partial snapshot remained after item failure');
    }

    let idempotencyRejected = false;
    try {
      await AiRecommendationSnapshot.create({
        snapshotId: '77777777-7777-4777-8777-777777777777',
        asOfUtc: new Date('2026-07-10T06:30:00Z'),
        tradingDay: '2026-07-10',
        profile: 'us_preferred',
        marketScope: 'us',
        contractVersion: '0.3.1',
        profileVersion: 'profile-v1',
        pipelineVersion: 'pipeline-v1',
        modelVersion: 'model-v1',
        strategyVersion: 'strategy-v1',
        ruleBundleHash: 'a'.repeat(64),
        templateHash: 'b'.repeat(64),
        disclaimerHash: 'c'.repeat(64),
        inputFingerprint: 'd'.repeat(64),
        outputFingerprint: '3'.repeat(64),
        idempotencyKey: '2'.repeat(64),
        itemCount: 1,
        envelopeJson: {
          ...env,
          snapshot_id: '77777777-7777-4777-8777-777777777777',
          output_fingerprint: '3'.repeat(64),
        },
      });
    } catch (error: any) {
      idempotencyRejected =
        error?.original?.code === '23505' &&
        error?.original?.constraint === 'uq_ai_recommendation_snapshot_idempotency';
    }
    if (!idempotencyRejected) throw new Error('duplicate idempotency key was accepted');

    await snapshot.destroy();
    if (await AiRecommendationItem.findByPk(ITEM_ID)) throw new Error('item cascade delete failed');
    console.log('ai-recommendation-sot-v031.orm: PASS (atomic/JCS/idempotency/alter-sync)');
  } finally {
    await sequelize.close();
  }
}

async function main(): Promise<void> {
  if (process.env.AI_RECOMMENDATION_SOT_PG === '1') await pgProof();
  else await manifestProof();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
