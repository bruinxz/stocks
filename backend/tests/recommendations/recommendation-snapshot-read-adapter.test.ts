import { Sequelize } from 'sequelize';
import { createHash } from 'crypto';
import {
  RecommendationSnapshotConflictError,
  RecommendationSnapshotContractError,
} from '../../src/recommendations/RecommendationSnapshotReadPort';
import { SequelizeRecommendationSnapshotReadAdapter } from '../../src/recommendations/SequelizeRecommendationSnapshotReadAdapter';

const SNAPSHOT_A = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_B = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_ITEM_ID = '44444444-4444-4444-8444-444444444444';
const RECOMMENDATION_JCS = `{"id":"${ITEM_ID}","snapshot_id":"${SNAPSHOT_A}",` + '"ticker":"AAPL"}';
const RECOMMENDATION_HASH = 'bdcc639c0dfa42a70b9db429ce64d46c59c5958dcd1a177915dfb8a765964a70';
const FINGERPRINT_PREIMAGE_JCS =
  '{"as_of":"2026-07-10T06:00:00Z","disclaimer":{"effective_at":"2026-07-01T00:00:00Z",' +
  '"full_text":"투자에는 위험이 있습니다.","hash":"d7dca10cd3ea237004ea9319ad31c44c0c4b980d372aeb239a3ed88d4e4b1ff0",' +
  '"language":"ko-KR","short_text":"仅供参考","version":"1.0.0"},"items":[{"rating_band":"A",' +
  '"recommendation":{"ticker":"AAPL"}}],"market_scope":"us","meta":{"contract_version":"0.3.1",' +
  '"input_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
  '"pipeline_version":"3.1.0","profile_version":"3.1.0","strategy_version":"3.1.0"},' +
  '"profile":"us_preferred"}';
const OUTPUT_FINGERPRINT = 'e0e991998068bc2cd036f1dfbe4f09c7bf7aac0d55624e73ed8c8bdb1cfbda38';
const MULTIBAGGER_PREIMAGE_JCS =
  '{"as_of":"2026-07-10T06:00:00Z","disclaimer":{"effective_at":"2026-07-01T00:00:00Z",' +
  '"full_text":"투자에는 위험이 있습니다.","hash":"d7dca10cd3ea237004ea9319ad31c44c0c4b980d372aeb239a3ed88d4e4b1ff0",' +
  '"language":"ko-KR","short_text":"仅供参考","version":"1.0.0"},"items":[{"rating_band":"A",' +
  '"recommendation":{"ticker":"AAPL"}}],"market_scope":"us","meta":{"contract_version":"0.3.1",' +
  '"input_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
  '"pipeline_version":"3.1.0","profile_version":"3.1.0","strategy_version":"3.1.0"},' +
  '"profile":"multibagger"}';
const MULTIBAGGER_OUTPUT_FINGERPRINT =
  'eae26b94df931b648f37246ae0eede0dc76a8e16bb0943c8fee6c74f1704774f';
const DISCLAIMER_TEXT = '투자에는 위험이 있습니다.';
const DISCLAIMER_HASH = createHash('sha256').update(DISCLAIMER_TEXT).digest('hex');

const ENVELOPE = {
  snapshot_id: SNAPSHOT_A,
  as_of: '2026-07-10T06:00:00Z',
  profile: 'us_preferred',
  market_scope: 'us',
  output_fingerprint: OUTPUT_FINGERPRINT,
  disclaimer: {
    version: '1.0.0',
    short_text: '仅供参考',
    full_text: DISCLAIMER_TEXT,
    language: 'ko-KR',
    effective_at: '2026-07-01T00:00:00Z',
    hash: DISCLAIMER_HASH,
  },
  meta: {
    contract_version: '0.3.1',
    profile_version: '3.1.0',
    input_fingerprint: 'a'.repeat(64),
    strategy_version: '3.1.0',
    pipeline_version: '3.1.0',
    generated_by: 'fixture',
    generation_ms: 12,
  },
  items: [
    {
      recommendation: { id: ITEM_ID, snapshot_id: SNAPSHOT_A, ticker: 'AAPL' },
      rating_band: 'A',
    },
  ],
};

function header(overrides: Record<string, unknown> = {}) {
  return {
    snapshot_id: SNAPSHOT_A,
    trading_day: '2026-07-10',
    as_of_utc: '2026-07-10T06:00:00Z',
    profile: 'us_preferred',
    market_scope: 'us',
    input_fingerprint: 'a'.repeat(64),
    contract_version: '0.3.1',
    profile_version: '3.1.0',
    disclaimer_hash: DISCLAIMER_HASH,
    fingerprint_preimage_jcs: FINGERPRINT_PREIMAGE_JCS,
    output_fingerprint: OUTPUT_FINGERPRINT,
    item_count: '1',
    envelope_json: ENVELOPE,
    created_at: '2026-07-10T06:00:01Z',
    ...overrides,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  const row = {
    item_id: ITEM_ID,
    ticker: 'AAPL',
    sort_rank: 0,
    recommendation_json: { id: ITEM_ID, snapshot_id: SNAPSHOT_A, ticker: 'AAPL' },
    recommendation_jcs: RECOMMENDATION_JCS,
    recommendation_hash: RECOMMENDATION_HASH,
    rating_band: 'A',
    ...overrides,
  };
  if ('recommendation_jcs' in overrides && !('recommendation_hash' in overrides)) {
    row.recommendation_hash = createHash('sha256')
      .update(String(row.recommendation_jcs))
      .digest('hex');
  }
  return row;
}

function targetItemRow(overrides: Record<string, unknown> = {}) {
  const recommendationJcs =
    `{"id":"${TARGET_ITEM_ID}","snapshot_id":"${SNAPSHOT_B}",` + '"ticker":"AAPL"}';
  return itemRow({
    item_id: TARGET_ITEM_ID,
    recommendation_json: {
      id: TARGET_ITEM_ID,
      snapshot_id: SNAPSHOT_B,
      ticker: 'AAPL',
    },
    recommendation_jcs: recommendationJcs,
    recommendation_hash: '984bddfbab44d4844da1974039d68ca6b01bad20e97642450f00fd3435eaabaa',
    ...overrides,
  });
}

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}`);
  }
}

async function main(): Promise<void> {
  const calls: Array<{ sql: string; replacements: Record<string, unknown> }> = [];
  let queue: unknown[][] = [];
  const sequelize = {
    async query(sql: string, options: any) {
      calls.push({ sql, replacements: options?.replacements || {} });
      return queue.shift() || [];
    },
  } as unknown as Sequelize;
  const adapter = new SequelizeRecommendationSnapshotReadAdapter(sequelize);

  queue = [[header()], [itemRow()]];
  const latest = await adapter.latest({ profile: 'us_preferred', market_scope: 'us' });
  assert('latest hydrates full envelope', latest?.items[0]?.rating_band === 'A');
  assert(
    'latest uses canonical header table',
    calls.at(-2)?.sql.includes('ai_recommendation_snapshot')
  );
  assert(
    'latest parameterizes explicit scope',
    calls.at(-2)?.replacements.profile === 'us_preferred' &&
      calls.at(-2)?.replacements.market_scope === 'us'
  );

  queue = [[{ total: '1' }], [header()]];
  const page = await adapter.byDate({
    trading_day: '2026-07-10',
    profile: 'us_preferred',
    market_scope: 'us',
    page: 2,
    page_size: 10,
  });
  assert('by-date normalizes count', page.total === 1);
  assert('by-date computes offset', calls.at(-1)?.replacements.offset === 10);

  queue = [[header({ envelope_json: { ...ENVELOPE, market_scope: 'cn_a' } })], [itemRow()]];
  let malformedRejected = false;
  try {
    await adapter.detail(SNAPSHOT_A);
  } catch (error) {
    malformedRejected = error instanceof RecommendationSnapshotContractError;
  }
  assert('detail rejects envelope/header mismatch', malformedRejected);

  const invalidEnvelopes: Array<[string, Record<string, unknown>]> = [
    [
      'missing contract_version',
      { ...ENVELOPE, meta: { ...ENVELOPE.meta, contract_version: undefined } },
    ],
    [
      'missing profile_version',
      { ...ENVELOPE, meta: { ...ENVELOPE.meta, profile_version: undefined } },
    ],
    [
      'invalid input_fingerprint',
      { ...ENVELOPE, meta: { ...ENVELOPE.meta, input_fingerprint: 'NOT-A-HASH' } },
    ],
    ['header contract_version drift', ENVELOPE],
    ['header profile_version drift', ENVELOPE],
    ['header input_fingerprint drift', ENVELOPE],
    ['header disclaimer_hash drift', ENVELOPE],
    [
      'mutually tampered output fingerprint',
      { ...ENVELOPE, items: [{ recommendation: { ticker: 'MSFT' }, rating_band: 'A' }] },
    ],
    ['fingerprint preimage hash mismatch', ENVELOPE],
    ['invalid output fingerprint', ENVELOPE],
    [
      'invalid disclaimer hash',
      { ...ENVELOPE, disclaimer: { ...ENVELOPE.disclaimer, hash: 'd'.repeat(64) } },
    ],
    [
      'invalid disclaimer locale',
      { ...ENVELOPE, disclaimer: { ...ENVELOPE.disclaimer, language: 'fr-FR' } },
    ],
  ];
  for (const [name, envelope] of invalidEnvelopes) {
    let row = header({ envelope_json: envelope });
    if (name === 'fingerprint preimage hash mismatch') {
      row = header({ fingerprint_preimage_jcs: '["tampered"]', envelope_json: envelope });
    } else if (name === 'invalid output fingerprint') {
      row = header({ output_fingerprint: 'BAD', envelope_json: envelope });
    } else if (name === 'header contract_version drift') {
      row = header({ contract_version: '0.3.0', envelope_json: envelope });
    } else if (name === 'header profile_version drift') {
      row = header({ profile_version: 'other', envelope_json: envelope });
    } else if (name === 'header input_fingerprint drift') {
      row = header({ input_fingerprint: 'd'.repeat(64), envelope_json: envelope });
    } else if (name === 'header disclaimer_hash drift') {
      row = header({ disclaimer_hash: 'd'.repeat(64), envelope_json: envelope });
    } else if (name === 'mutually tampered output fingerprint') {
      row = header({
        output_fingerprint: 'd'.repeat(64),
        envelope_json: { ...envelope, output_fingerprint: 'd'.repeat(64) },
      });
    }
    queue = [[row], [itemRow()]];
    let rejected = false;
    try {
      await adapter.detail(SNAPSHOT_A);
    } catch (error) {
      rejected = error instanceof RecommendationSnapshotContractError;
    }
    assert(`${name} fails closed`, rejected);
  }

  queue = [
    [header()],
    [itemRow()],
    [
      header({
        snapshot_id: SNAPSHOT_B,
        envelope_json: {
          ...ENVELOPE,
          snapshot_id: SNAPSHOT_B,
          output_fingerprint: OUTPUT_FINGERPRINT,
          items: [
            {
              recommendation: {
                id: TARGET_ITEM_ID,
                snapshot_id: SNAPSHOT_B,
                ticker: 'AAPL',
              },
              rating_band: 'A',
            },
          ],
        },
      }),
    ],
    [targetItemRow()],
    [
      { snapshot_id: SNAPSHOT_A, ticker: 'AAPL', recommendation_hash: '1'.repeat(64) },
      { snapshot_id: SNAPSHOT_A, ticker: 'NVDA', recommendation_hash: '2'.repeat(64) },
      { snapshot_id: SNAPSHOT_B, ticker: 'AAPL', recommendation_hash: '3'.repeat(64) },
      { snapshot_id: SNAPSHOT_B, ticker: 'MSFT', recommendation_hash: '4'.repeat(64) },
    ],
  ];
  const diff = await adapter.diff(SNAPSHOT_A, SNAPSHOT_B);
  assert('diff added is sorted', JSON.stringify(diff.added) === '["MSFT"]');
  assert('diff removed is sorted', JSON.stringify(diff.removed) === '["NVDA"]');
  assert('diff changed is sorted', JSON.stringify(diff.changed) === '["AAPL"]');
  assert('diff uses canonical item table', calls.at(-1)?.sql.includes('ai_recommendation_item'));

  queue = [
    [header()],
    [itemRow()],
    [
      header({
        snapshot_id: SNAPSHOT_B,
        profile: 'multibagger',
        output_fingerprint: MULTIBAGGER_OUTPUT_FINGERPRINT,
        fingerprint_preimage_jcs: MULTIBAGGER_PREIMAGE_JCS,
        envelope_json: {
          ...ENVELOPE,
          snapshot_id: SNAPSHOT_B,
          profile: 'multibagger',
          output_fingerprint: MULTIBAGGER_OUTPUT_FINGERPRINT,
          items: [
            {
              recommendation: {
                id: TARGET_ITEM_ID,
                snapshot_id: SNAPSHOT_B,
                ticker: 'AAPL',
              },
              rating_band: 'A',
            },
          ],
        },
      }),
    ],
    [targetItemRow()],
  ];
  let scopeConflict = false;
  try {
    await adapter.diff(SNAPSHOT_A, SNAPSHOT_B);
  } catch (error) {
    scopeConflict = error instanceof RecommendationSnapshotConflictError;
  }
  assert('diff rejects profile/scope mismatch before item query', scopeConflict);

  const invalidItemRows: Array<[string, Record<string, unknown>]> = [
    ['invalid item hash shape', itemRow({ recommendation_hash: 'BAD' })],
    ['item hash mismatch', itemRow({ recommendation_hash: 'd'.repeat(64) })],
    ['item id mismatch', itemRow({ item_id: SNAPSHOT_B })],
    [
      'missing recommendation id',
      itemRow({
        recommendation_json: { snapshot_id: SNAPSHOT_A, ticker: 'AAPL' },
        recommendation_jcs: `{"snapshot_id":"${SNAPSHOT_A}","ticker":"AAPL"}`,
      }),
    ],
    [
      'invalid recommendation id',
      itemRow({
        recommendation_json: { id: 'bad', snapshot_id: SNAPSHOT_A, ticker: 'AAPL' },
        recommendation_jcs: `{"id":"bad","snapshot_id":"${SNAPSHOT_A}","ticker":"AAPL"}`,
      }),
    ],
    [
      'missing recommendation snapshot_id',
      itemRow({
        recommendation_json: { id: ITEM_ID, ticker: 'AAPL' },
        recommendation_jcs: `{"id":"${ITEM_ID}","ticker":"AAPL"}`,
      }),
    ],
    [
      'invalid recommendation snapshot_id',
      itemRow({
        recommendation_json: { id: ITEM_ID, snapshot_id: 'bad', ticker: 'AAPL' },
        recommendation_jcs: `{"id":"${ITEM_ID}","snapshot_id":"bad","ticker":"AAPL"}`,
      }),
    ],
    [
      'mismatched recommendation snapshot_id',
      itemRow({
        recommendation_json: { id: ITEM_ID, snapshot_id: SNAPSHOT_B, ticker: 'AAPL' },
        recommendation_jcs: `{"id":"${ITEM_ID}","snapshot_id":"${SNAPSHOT_B}","ticker":"AAPL"}`,
      }),
    ],
    ['item rank gap', itemRow({ sort_rank: 1 })],
    [
      'item JSON/JCS mismatch',
      itemRow({
        recommendation_json: { id: ITEM_ID, snapshot_id: SNAPSHOT_A, ticker: 'MSFT' },
      }),
    ],
    [
      'noncanonical recommendation JCS',
      itemRow({
        recommendation_jcs: `{"ticker":"AAPL","snapshot_id":"${SNAPSHOT_A}","id":"${ITEM_ID}"}`,
      }),
    ],
    ['item envelope mismatch', itemRow({ ticker: 'MSFT' })],
  ];
  for (const [name, invalidItem] of invalidItemRows) {
    queue = [[header()], [invalidItem]];
    let rejected = false;
    try {
      await adapter.detail(SNAPSHOT_A);
    } catch (error) {
      rejected = error instanceof RecommendationSnapshotContractError;
    }
    assert(`${name} fails closed`, rejected);
  }

  queue = [
    [header()],
    [itemRow({ recommendation_hash: 'BAD' })],
    [
      header({
        snapshot_id: SNAPSHOT_B,
        envelope_json: { ...ENVELOPE, snapshot_id: SNAPSHOT_B },
      }),
    ],
    [itemRow()],
  ];
  let corruptDiffRejected = false;
  try {
    await adapter.diff(SNAPSHOT_A, SNAPSHOT_B);
  } catch (error) {
    corruptDiffRejected = error instanceof RecommendationSnapshotContractError;
  }
  assert('diff rejects corrupt physical item proof', corruptDiffRejected);

  const forgedRecommendation = {
    id: ITEM_ID,
    snapshot_id: SNAPSHOT_B,
    ticker: 'AAPL',
  };
  const forgedJcs = `{"id":"${ITEM_ID}","snapshot_id":"${SNAPSHOT_B}",` + '"ticker":"AAPL"}';
  queue = [
    [
      header({
        envelope_json: {
          ...ENVELOPE,
          items: [{ recommendation: forgedRecommendation, rating_band: 'A' }],
        },
      }),
    ],
    [
      itemRow({
        recommendation_json: forgedRecommendation,
        recommendation_jcs: forgedJcs,
      }),
    ],
  ];
  let forgedIdentityRejected = false;
  try {
    await adapter.detail(SNAPSHOT_A);
  } catch (error) {
    forgedIdentityRejected = error instanceof RecommendationSnapshotContractError;
  }
  assert('mutually forged child snapshot identity fails closed', forgedIdentityRejected);

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
