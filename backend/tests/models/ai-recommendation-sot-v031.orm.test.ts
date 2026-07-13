import { createHash } from 'crypto';
import { deepStrictEqual } from 'assert';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { Sequelize } from 'sequelize-typescript';
import { AiRecommendationItem } from '../../src/models/AiRecommendationItem';
import { AiRecommendationSnapshot } from '../../src/models/AiRecommendationSnapshot';
import { SPRINT3_MIGRATION_OWNED_MODELS } from '../../src/models/Sprint3MigrationOwnedModels';

const SNAPSHOT_ID = '88888888-8888-4888-8888-888888888888';
const ITEM_ID = '99999999-9999-4999-8999-999999999999';
const PROFILE_VERSION = '1.2.3-alpha-beta.1+build-meta-7';
const PIPELINE_VERSION = '2.0.0-rc.1+pipeline-build-5';
const MODEL_VERSION = '3.4.5-model-alpha+model-build';
const STRATEGY_VERSION = '4.5.6-strategy-2+strategy-build-9';

const VERSION_FIELDS = [
  ['profileVersion', 'profile_version'],
  ['pipelineVersion', 'pipeline_version'],
  ['modelVersion', 'model_version'],
  ['strategyVersion', 'strategy_version'],
] as const;
const INVALID_SEMVERS = [
  ['Unicode digit', '１.2.3'],
  ['Unicode prerelease', '1.2.3-α'],
  ['moving alias', 'current'],
  ['v prefix', 'v1.2.3'],
  ['core leading zero', '01.2.3'],
  ['numeric prerelease leading zero', '1.2.3-01'],
  ['empty prerelease', '1.2.3-'],
  ['empty build', '1.2.3+'],
  ['empty prerelease identifier', '1.2.3-alpha..1'],
  ['empty build identifier', '1.2.3+build..1'],
] as const;

function recommendation(): Record<string, unknown> {
  return {
    id: ITEM_ID,
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
    model_version: MODEL_VERSION,
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

function reviewedSemanticPreimage(env: Record<string, unknown>): string {
  const repoRoot = join(__dirname, '../../..');
  return execFileSync(
    'python3',
    [
      '-c',
      [
        'import json,sys',
        'from ai.snapshot.fingerprint import canonicalize_output_fingerprint_preimage',
        'print(canonicalize_output_fingerprint_preimage(json.load(sys.stdin)), end="")',
      ].join(';'),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, PYTHONPATH: repoRoot },
      input: JSON.stringify(env),
      encoding: 'utf8',
    }
  );
}

function envelope(
  rec: Record<string, unknown>,
  outputFingerprint: string,
  snapshotId = SNAPSHOT_ID,
  asOf = '2026-07-10T06:30:00Z'
): Record<string, unknown> {
  return {
    snapshot_id: snapshotId,
    as_of: asOf,
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
      profile_version: PROFILE_VERSION,
      input_fingerprint: 'd'.repeat(64),
      strategy_version: STRATEGY_VERSION,
      pipeline_version: PIPELINE_VERSION,
      generated_by: 'fixture',
      generation_ms: 1,
    },
  };
}

function snapshotAttributes(
  env: Record<string, unknown>,
  outputFingerprint: string,
  fingerprintPreimageJcs: string
): Record<string, unknown> {
  return {
    snapshotId: String(env.snapshot_id),
    asOfUtc: new Date(String(env.as_of)),
    tradingDay: '2026-07-10',
    profile: 'us_preferred',
    marketScope: 'us',
    contractVersion: '0.3.1',
    profileVersion: PROFILE_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    modelVersion: MODEL_VERSION,
    strategyVersion: STRATEGY_VERSION,
    ruleBundleHash: 'a'.repeat(64),
    templateHash: 'b'.repeat(64),
    disclaimerHash: 'c'.repeat(64),
    inputFingerprint: 'd'.repeat(64),
    outputFingerprint,
    fingerprintPreimageJcs,
    idempotencyKey: '2'.repeat(64),
    itemCount: (env.items as unknown[]).length,
    envelopeJson: env,
  };
}

function itemAttributes(rec: Record<string, unknown>): Record<string, unknown> {
  const jcs = canonicalFixture(rec);
  return {
    itemId: String(rec.id),
    snapshotId: String(rec.snapshot_id),
    ticker: String(rec.ticker),
    sortRank: 0,
    recommendationJson: rec,
    recommendationJcs: jcs,
    recommendationHash: digest(jcs),
    ratingBand: 'A',
    convictionFinal: '90.0',
    riskGateStatus: (rec.risk_gate as Record<string, unknown>).gate,
    sizeHintTier: 'TIER_5',
  };
}

async function modelValidationProof(): Promise<void> {
  const rec = recommendation();
  const env = envelope(rec, '0'.repeat(64));
  const fingerprintPreimageJcs = reviewedSemanticPreimage(env);
  const outputFingerprint = digest(fingerprintPreimageJcs);
  env.output_fingerprint = outputFingerprint;
  const validSnapshot = snapshotAttributes(env, outputFingerprint, fingerprintPreimageJcs);

  await AiRecommendationSnapshot.build(validSnapshot).validate();
  for (const [field] of VERSION_FIELDS) {
    for (const [caseName, invalidVersion] of INVALID_SEMVERS) {
      let rejected = false;
      try {
        await AiRecommendationSnapshot.build({
          ...validSnapshot,
          [field]: invalidVersion,
        }).validate();
      } catch (error: any) {
        rejected =
          error?.name === 'SequelizeValidationError' &&
          error?.errors?.some((entry: any) => entry.path === field);
      }
      if (!rejected) throw new Error(`${field} accepted invalid SemVer (${caseName})`);
    }
  }

  await AiRecommendationItem.build(itemAttributes(rec)).validate();
  for (const riskGateStatus of ['YELLOW', 'RED'] as const) {
    const gatedRec = {
      ...rec,
      risk_gate: {
        gate: riskGateStatus,
        ok_to_enter: true,
        triggers: [{ code: `FIXTURE_${riskGateStatus}` }],
      },
    };
    let rejected = false;
    try {
      await AiRecommendationItem.build(itemAttributes(gatedRec)).validate();
    } catch (error: any) {
      rejected =
        error?.name === 'SequelizeValidationError' &&
        error?.errors?.some((entry: any) => entry.path === 'riskGateStatus');
    }
    if (!rejected) throw new Error(`model accepted coherent ${riskGateStatus} recommendation`);
  }
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
  try {
    for (const model of [AiRecommendationSnapshot, AiRecommendationItem]) {
      const synced = await model.sync({ alter: true });
      if (synced !== model) throw new Error(`migration-owned sync guard failed for ${model.name}`);
    }
    await modelValidationProof();
  } finally {
    await sequelize.close();
  }
  console.log('ai-recommendation-sot-v031.orm: PASS (manifest/SemVer/GREEN-only guards)');
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
    const env = envelope(rec, '0'.repeat(64));
    const fingerprintPreimageJcs = reviewedSemanticPreimage(env);
    const outputFingerprint = digest(fingerprintPreimageJcs);
    env.output_fingerprint = outputFingerprint;

    await sequelize.transaction(async transaction => {
      await AiRecommendationSnapshot.create(
        {
          snapshotId: SNAPSHOT_ID,
          asOfUtc: new Date('2026-07-10T06:30:00Z'),
          tradingDay: '2026-07-10',
          profile: 'us_preferred',
          marketScope: 'us',
          contractVersion: '0.3.1',
          profileVersion: PROFILE_VERSION,
          pipelineVersion: PIPELINE_VERSION,
          modelVersion: MODEL_VERSION,
          strategyVersion: STRATEGY_VERSION,
          ruleBundleHash: 'a'.repeat(64),
          templateHash: 'b'.repeat(64),
          disclaimerHash: 'c'.repeat(64),
          inputFingerprint: 'd'.repeat(64),
          outputFingerprint,
          fingerprintPreimageJcs,
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

    await modelValidationProof();

    let invalidVersionSequence = 16;
    for (const [field, column] of VERSION_FIELDS) {
      for (const [caseName, invalidVersion] of INVALID_SEMVERS) {
        const suffix = (invalidVersionSequence++).toString(16).padStart(12, '0');
        const invalidSnapshotId = `00000000-0000-4000-8000-${suffix}`;
        const invalidAsOf = new Date(
          Date.parse('2026-07-10T07:00:00Z') + invalidVersionSequence * 1000
        ).toISOString();
        const invalidEnv = envelope(
          {
            ...rec,
            id: `10000000-0000-4000-8000-${suffix}`,
            snapshot_id: invalidSnapshotId,
            model_version: column === 'model_version' ? invalidVersion : MODEL_VERSION,
          },
          '0'.repeat(64),
          invalidSnapshotId,
          invalidAsOf
        );
        (invalidEnv.meta as Record<string, unknown>)[column] = invalidVersion;
        const invalidFingerprintPreimageJcs = reviewedSemanticPreimage(invalidEnv);
        const invalidOutputFingerprint = digest(invalidFingerprintPreimageJcs);
        invalidEnv.output_fingerprint = invalidOutputFingerprint;
        let rejected = false;
        try {
          await AiRecommendationSnapshot.create(
            {
              ...snapshotAttributes(
                invalidEnv,
                invalidOutputFingerprint,
                invalidFingerprintPreimageJcs
              ),
              [field]: invalidVersion,
              idempotencyKey: suffix.padStart(64, '0'),
            },
            { validate: false }
          );
        } catch (error: any) {
          rejected =
            error?.original?.code === '23514' &&
            String(error?.original?.constraint || '').includes(column);
        }
        if (!rejected) throw new Error(`${column} PG check accepted invalid SemVer (${caseName})`);
      }
    }

    for (const [index, riskGateStatus] of (['YELLOW', 'RED'] as const).entries()) {
      const invalidSnapshotId =
        index === 0
          ? '55555555-5555-4555-8555-555555555555'
          : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const invalidItemId =
        index === 0
          ? '66666666-6666-4666-8666-666666666666'
          : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const invalidRec = {
        ...rec,
        id: invalidItemId,
        snapshot_id: invalidSnapshotId,
        ticker: index === 0 ? 'MSFT' : 'GOOG',
        risk_gate: {
          gate: riskGateStatus,
          ok_to_enter: true,
          triggers: [{ code: `FIXTURE_${riskGateStatus}` }],
        },
      };
      const invalidJcs = canonicalFixture(invalidRec);
      const invalidEnv = envelope(
        invalidRec,
        '0'.repeat(64),
        invalidSnapshotId,
        `2026-07-10T06:3${index + 1}:00Z`
      );
      const invalidFingerprintPreimageJcs = reviewedSemanticPreimage(invalidEnv);
      const invalidOutputFingerprint = digest(invalidFingerprintPreimageJcs);
      invalidEnv.output_fingerprint = invalidOutputFingerprint;
      let atomicRollback = false;
      try {
        await sequelize.transaction(async transaction => {
          await AiRecommendationSnapshot.create(
            {
              ...snapshotAttributes(
                invalidEnv,
                invalidOutputFingerprint,
                invalidFingerprintPreimageJcs
              ),
              idempotencyKey: String(index + 8).repeat(64),
            },
            { transaction }
          );
          await AiRecommendationItem.create(
            {
              ...itemAttributes(invalidRec),
              recommendationJcs: invalidJcs,
              recommendationHash: digest(invalidJcs),
            },
            { transaction, validate: false }
          );
        });
      } catch (error: any) {
        atomicRollback =
          error?.original?.code === '23514' &&
          error?.original?.constraint === 'ai_recommendation_item_risk_gate_status_check';
      }
      if (!atomicRollback) {
        throw new Error(`coherent ${riskGateStatus} child did not roll back atomic write`);
      }
      if (await AiRecommendationSnapshot.findByPk(invalidSnapshotId)) {
        throw new Error(`partial snapshot remained after ${riskGateStatus} item failure`);
      }
    }

    const invalidPayloadCases = [
      {
        name: 'non-GREEN payload gate',
        snapshotId: '12121212-1212-4121-8121-121212121212',
        itemId: '13131313-1313-4131-8131-131313131313',
        ticker: 'NVDA',
        gate: 'YELLOW',
        okToEnter: true,
        idempotencyKey: 'a'.repeat(64),
        asOf: '2026-07-10T06:40:00Z',
      },
      {
        name: 'false payload ok_to_enter',
        snapshotId: '14141414-1414-4141-8141-141414141414',
        itemId: '15151515-1515-4151-8151-151515151515',
        ticker: 'TSLA',
        gate: 'GREEN',
        okToEnter: false,
        idempotencyKey: 'b'.repeat(64),
        asOf: '2026-07-10T06:41:00Z',
      },
    ] as const;
    for (const invalidCase of invalidPayloadCases) {
      const invalidRec = {
        ...rec,
        id: invalidCase.itemId,
        snapshot_id: invalidCase.snapshotId,
        ticker: invalidCase.ticker,
        risk_gate: {
          gate: invalidCase.gate,
          ok_to_enter: invalidCase.okToEnter,
          triggers: [{ code: 'FIXTURE_PAYLOAD_GATE' }],
        },
      };
      const invalidEnv = envelope(
        invalidRec,
        '0'.repeat(64),
        invalidCase.snapshotId,
        invalidCase.asOf
      );
      const invalidFingerprintPreimageJcs = reviewedSemanticPreimage(invalidEnv);
      const invalidOutputFingerprint = digest(invalidFingerprintPreimageJcs);
      invalidEnv.output_fingerprint = invalidOutputFingerprint;
      let rejected = false;
      try {
        await sequelize.transaction(async transaction => {
          await AiRecommendationSnapshot.create(
            {
              ...snapshotAttributes(
                invalidEnv,
                invalidOutputFingerprint,
                invalidFingerprintPreimageJcs
              ),
              idempotencyKey: invalidCase.idempotencyKey,
            },
            { transaction }
          );
          await AiRecommendationItem.create(
            {
              ...itemAttributes(invalidRec),
              riskGateStatus: 'GREEN',
            },
            { transaction, validate: false }
          );
        });
      } catch (error: any) {
        rejected =
          error?.original?.code === '23514' &&
          error?.original?.constraint === 'ck_ai_recommendation_item_payload';
      }
      if (!rejected) throw new Error(`${invalidCase.name} was accepted`);
      if (await AiRecommendationSnapshot.findByPk(invalidCase.snapshotId)) {
        throw new Error(`partial snapshot remained after ${invalidCase.name}`);
      }
    }

    let idempotencyRejected = false;
    try {
      await AiRecommendationSnapshot.create({
        snapshotId: '77777777-7777-4777-8777-777777777777',
        asOfUtc: new Date('2026-07-10T06:32:00Z'),
        tradingDay: '2026-07-10',
        profile: 'us_preferred',
        marketScope: 'us',
        contractVersion: '0.3.1',
        profileVersion: PROFILE_VERSION,
        pipelineVersion: PIPELINE_VERSION,
        modelVersion: MODEL_VERSION,
        strategyVersion: STRATEGY_VERSION,
        ruleBundleHash: 'a'.repeat(64),
        templateHash: 'b'.repeat(64),
        disclaimerHash: 'c'.repeat(64),
        inputFingerprint: 'd'.repeat(64),
        outputFingerprint,
        fingerprintPreimageJcs,
        idempotencyKey: '2'.repeat(64),
        itemCount: 1,
        envelopeJson: {
          ...env,
          snapshot_id: '77777777-7777-4777-8777-777777777777',
          as_of: '2026-07-10T06:32:00Z',
        },
      });
    } catch (error: any) {
      idempotencyRejected =
        error?.original?.code === '23505' &&
        error?.original?.constraint === 'uq_ai_recommendation_snapshot_idempotency';
    }
    if (!idempotencyRejected) throw new Error('duplicate idempotency key was accepted');

    let envelopeMismatchRejected = false;
    try {
      await sequelize.transaction(async transaction => {
        await snapshot.update(
          {
            envelopeJson: {
              ...env,
              items: [{ recommendation: rec, rating_band: 'B' }],
            },
          },
          { transaction }
        );
      });
    } catch (error: any) {
      envelopeMismatchRejected = String(error?.message || error).includes(
        'Recommendation envelope/items mismatch'
      );
    }
    if (!envelopeMismatchRejected) throw new Error('envelope/item mismatch was accepted');

    let itemIdMismatchRejected = false;
    try {
      await sequelize.transaction(async transaction => {
        const wrongIdRec = {
          ...rec,
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          ticker: 'MSFT',
        };
        const wrongIdJcs = canonicalFixture(wrongIdRec);
        await AiRecommendationItem.create(
          {
            itemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            snapshotId: SNAPSHOT_ID,
            ticker: 'MSFT',
            sortRank: 1,
            recommendationJson: wrongIdRec,
            recommendationJcs: wrongIdJcs,
            recommendationHash: digest(wrongIdJcs),
            ratingBand: 'A',
            convictionFinal: '90.0',
            riskGateStatus: 'GREEN',
            sizeHintTier: 'TIER_5',
          },
          { transaction }
        );
      });
    } catch (error: any) {
      itemIdMismatchRejected = error?.original?.code === '23514';
    }
    if (!itemIdMismatchRejected) throw new Error('recommendation/item id mismatch was accepted');

    let rankGapRejected = false;
    try {
      await sequelize.transaction(async transaction => {
        const rankRec = {
          ...rec,
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          ticker: 'MSFT',
        };
        const rankJcs = canonicalFixture(rankRec);
        const rankEnv = {
          ...env,
          items: [
            { recommendation: rec, rating_band: 'A' },
            { recommendation: rankRec, rating_band: 'A' },
          ],
        };
        const rankFingerprintPreimageJcs = reviewedSemanticPreimage(rankEnv);
        rankEnv.output_fingerprint = digest(rankFingerprintPreimageJcs);
        await AiRecommendationItem.create(
          {
            itemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            snapshotId: SNAPSHOT_ID,
            ticker: 'MSFT',
            sortRank: 2,
            recommendationJson: rankRec,
            recommendationJcs: rankJcs,
            recommendationHash: digest(rankJcs),
            ratingBand: 'A',
            convictionFinal: '90.0',
            riskGateStatus: 'GREEN',
            sizeHintTier: 'TIER_5',
          },
          { transaction }
        );
        await snapshot.update(
          {
            itemCount: 2,
            envelopeJson: rankEnv,
            outputFingerprint: rankEnv.output_fingerprint,
            fingerprintPreimageJcs: rankFingerprintPreimageJcs,
          },
          { transaction }
        );
      });
    } catch (error: any) {
      rankGapRejected = String(error?.message || error).includes('sort_rank sequence mismatch');
    }
    if (!rankGapRejected) throw new Error('non-contiguous rank sequence was accepted');

    let jcsHashRejected = false;
    try {
      await AiRecommendationItem.update(
        { recommendationHash: '0'.repeat(64) },
        { where: { itemId: ITEM_ID } }
      );
    } catch (error: any) {
      jcsHashRejected = error?.original?.code === '23514';
    }
    if (!jcsHashRejected) throw new Error('JCS/hash mismatch was accepted');

    await snapshot.destroy();
    if (await AiRecommendationItem.findByPk(ITEM_ID)) throw new Error('item cascade delete failed');
    console.log(
      'ai-recommendation-sot-v031.orm: PASS ' +
        '(SemVer/GREEN-only/atomic/JCS/idempotency/alter-sync)'
    );
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
