import {
  RecommendationSnapshotSignalProjectionService,
  buildRecommendationSignalPayload,
  type RecommendationProjectionSnapshot,
} from '../../src/services/RecommendationSnapshotSignalProjectionService';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function fixture(): RecommendationProjectionSnapshot {
  return {
    snapshot_id: '11111111-1111-4111-8111-111111111111',
    trading_day: '2026-07-21',
    profile: 'us_preferred',
    market_scope: 'cn_a',
    as_of: new Date('2026-07-21T00:30:00.000Z'),
    items: [
      {
        item_id: '22222222-2222-4222-8222-222222222222',
        snapshot_id: '11111111-1111-4111-8111-111111111111',
        ticker: '600483.SH',
        rank: 0,
        rating_band: 'A',
        conviction_final: 88,
        risk_gate_status: 'GREEN',
        size_hint_tier: 'TIER_5',
        recommendation: {
          name: '福能股份',
          explanation: { headline: '盈利质量改善', body: '现金流与催化同时改善' },
          entry_plan: {
            entry: { low: 10, high: 10.4 },
            stop: { value: 9.5 },
            targets: [{ value: 12 }],
            size_hint: { tier: 'TIER_5', pct: 5 },
          },
        },
      },
      {
        item_id: '33333333-3333-4333-8333-333333333333',
        snapshot_id: '11111111-1111-4111-8111-111111111111',
        ticker: '600098.SH',
        rank: 1,
        rating_band: 'B',
        conviction_final: 75,
        risk_gate_status: 'GREEN',
        size_hint_tier: 'SKIP',
        recommendation: {},
      },
    ],
  };
}

async function main() {
  const snapshot = fixture();
  const payload = buildRecommendationSignalPayload(
    snapshot,
    snapshot.items[0],
    '2026-07-21T07:30:00.000Z'
  );
  assert('canonical source type', payload.source_type === 'recommendation_snapshot');
  assert('source id is item id', payload.source_id === snapshot.items[0].item_id);
  assert('symbol normalized', payload.symbol === 'sh.600483');
  assert('metadata carries snapshot id', payload.metadata.snapshot_id === snapshot.snapshot_id);
  assert('metadata carries expiry', Boolean(payload.metadata.expires_at));
  assert('green item becomes buy action', payload.metadata.action === 'buy');

  const writes: Record<string, any>[] = [];
  const service = new RecommendationSnapshotSignalProjectionService({
    async loadSnapshot() {
      return snapshot;
    },
    async upsertSignal(input) {
      writes.push(input);
      return 'created';
    },
  });
  const result = await service.projectTradingDay({
    trading_day: '2026-07-21',
    now: new Date('2026-07-21T01:40:00.000Z'),
  });
  assert('only GREEN non-SKIP item projected', result.projected === 1 && result.skipped === 1);
  assert('one canonical signal written', writes.length === 1);

  const expired = await service.projectTradingDay({
    trading_day: '2026-07-21',
    now: new Date('2026-07-21T08:00:00.000Z'),
  });
  assert(
    'expired snapshot does not project',
    expired.projected === 0 && expired.reason === 'snapshot_expired'
  );

  console.log(`${passed} ok, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
