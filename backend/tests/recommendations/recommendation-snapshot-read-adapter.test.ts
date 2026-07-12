import { Sequelize } from 'sequelize';
import { createHash } from 'crypto';
import {
  RecommendationSnapshotConflictError,
  RecommendationSnapshotContractError,
} from '../../src/recommendations/RecommendationSnapshotReadPort';
import { SequelizeRecommendationSnapshotReadAdapter } from '../../src/recommendations/SequelizeRecommendationSnapshotReadAdapter';

const SNAPSHOT_A = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_B = '22222222-2222-4222-8222-222222222222';
const DISCLAIMER_TEXT = '투자에는 위험이 있습니다.';
const DISCLAIMER_HASH = createHash('sha256').update(DISCLAIMER_TEXT).digest('hex');

const ENVELOPE = {
  snapshot_id: SNAPSHOT_A,
  as_of: '2026-07-10T06:00:00Z',
  profile: 'us_preferred',
  market_scope: 'us',
  output_fingerprint: 'b'.repeat(64),
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
  items: [{ recommendation: { ticker: 'AAPL' }, rating_band: 'A' }],
};

function header(overrides: Record<string, unknown> = {}) {
  return {
    snapshot_id: SNAPSHOT_A,
    trading_day: '2026-07-10',
    as_of_utc: '2026-07-10T06:00:00Z',
    profile: 'us_preferred',
    market_scope: 'us',
    input_fingerprint: 'a'.repeat(64),
    output_fingerprint: 'b'.repeat(64),
    item_count: '1',
    envelope_json: ENVELOPE,
    created_at: '2026-07-10T06:00:01Z',
    ...overrides,
  };
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

  queue = [[header()]];
  const latest = await adapter.latest({ profile: 'us_preferred', market_scope: 'us' });
  assert('latest hydrates full envelope', latest?.items[0]?.rating_band === 'A');
  assert(
    'latest uses canonical header table',
    calls.at(-1)?.sql.includes('ai_recommendation_snapshot')
  );
  assert(
    'latest parameterizes explicit scope',
    calls.at(-1)?.replacements.profile === 'us_preferred' &&
      calls.at(-1)?.replacements.market_scope === 'us'
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

  queue = [[header({ envelope_json: { ...ENVELOPE, market_scope: 'cn_a' } })]];
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
    const row =
      name === 'invalid output fingerprint'
        ? header({ output_fingerprint: 'BAD', envelope_json: envelope })
        : header({ envelope_json: envelope });
    queue = [[row]];
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
    [
      header({
        snapshot_id: SNAPSHOT_B,
        envelope_json: {
          ...ENVELOPE,
          snapshot_id: SNAPSHOT_B,
          output_fingerprint: 'd'.repeat(64),
        },
        output_fingerprint: 'd'.repeat(64),
      }),
    ],
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
    [
      header({
        snapshot_id: SNAPSHOT_B,
        profile: 'multibagger',
        envelope_json: {
          ...ENVELOPE,
          snapshot_id: SNAPSHOT_B,
          profile: 'multibagger',
        },
      }),
    ],
  ];
  let scopeConflict = false;
  try {
    await adapter.diff(SNAPSHOT_A, SNAPSHOT_B);
  } catch (error) {
    scopeConflict = error instanceof RecommendationSnapshotConflictError;
  }
  assert('diff rejects profile/scope mismatch before item query', scopeConflict);

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
