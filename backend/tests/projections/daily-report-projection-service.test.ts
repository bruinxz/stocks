import {
  DailyReportProjectionService,
  toProjectionEnvelope,
} from '../../src/projections/DailyReportProjectionService';
import { ProjectionCliPort } from '../../src/projections/ProjectionCliClient';
import {
  RecommendationSnapshotReadPort,
  type RecommendationSnapshotDetail,
} from '../../src/recommendations/RecommendationSnapshotReadPort';

const SNAPSHOT: RecommendationSnapshotDetail = {
  snapshot_id: '11111111-1111-4111-8111-111111111111',
  trading_day: '2026-07-12',
  as_of: '2026-07-12T09:30:00Z',
  profile: 'us_preferred',
  market_scope: 'us',
  output_fingerprint: 'b'.repeat(64),
  fingerprint_preimage_jcs: '{"authenticated":"b3-only"}',
  disclaimer: {
    version: '1.0.0',
    short_text: 'Research only',
    full_text: 'Research only. Markets involve risk.',
    language: 'en-US',
    effective_at: '2026-07-01T00:00:00Z',
    hash: 'c'.repeat(64),
  },
  meta: {
    contract_version: '0.3.1',
    profile_version: '1.2.0',
    input_fingerprint: 'd'.repeat(64),
    strategy_version: '0.3.0',
    pipeline_version: '1.0.0',
    generated_by: 'fixture',
    generation_ms: 12,
  },
  items: [
    {
      recommendation: { ticker: 'AAPL' },
      rating_band: 'A',
    },
  ],
};

type Call = { operation: string; value: unknown };

function ports(
  calls: Call[],
  snapshots = [SNAPSHOT]
): {
  read: RecommendationSnapshotReadPort;
  projection: ProjectionCliPort;
} {
  return {
    read: {
      async latest(scope) {
        calls.push({ operation: 'latest', value: scope });
        return snapshots[0] ?? null;
      },
      async byDate(query) {
        calls.push({ operation: 'byDate', value: query });
        return {
          entries: snapshots.length
            ? [
                {
                  snapshot_id: SNAPSHOT.snapshot_id,
                  trading_day: SNAPSHOT.as_of.slice(0, 10),
                  as_of: SNAPSHOT.as_of,
                  profile: SNAPSHOT.profile,
                  market_scope: SNAPSHOT.market_scope,
                  output_fingerprint: SNAPSHOT.output_fingerprint,
                  item_count: SNAPSHOT.items.length,
                  created_at: SNAPSHOT.as_of,
                },
              ]
            : [],
          total: snapshots.length,
          page: query.page,
          page_size: query.page_size,
        };
      },
      async history(query) {
        calls.push({ operation: 'history', value: query });
        return snapshots;
      },
      async detail(snapshotId) {
        calls.push({ operation: 'detail', value: snapshotId });
        return snapshots[0] ?? null;
      },
      async diff(baseSnapshotId, targetSnapshotId) {
        calls.push({ operation: 'diff', value: [baseSnapshotId, targetSnapshotId] });
        throw new Error('not used');
      },
    },
    projection: {
      async projectDaily(envelope) {
        calls.push({ operation: 'projectDaily', value: envelope });
        return { kind: 'daily', envelope };
      },
      async projectHistory(envelopes, filters, tradingDays) {
        calls.push({ operation: 'projectHistory', value: { envelopes, filters, tradingDays } });
        return { kind: 'history', envelopes, filters, tradingDays };
      },
    },
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
  const envelope = toProjectionEnvelope(SNAPSHOT);
  assert('bridge retains exact RecommendationList keys', Object.keys(envelope).length === 8);
  assert('bridge omits B3-only authenticated preimage', !('fingerprint_preimage_jcs' in envelope));
  assert('bridge preserves item identity', (envelope.items as unknown[]).length === 1);

  const calls: Call[] = [];
  const { read, projection } = ports(calls);
  const service = new DailyReportProjectionService(read, projection, {
    history_source_limit: 77,
  });

  const latest = await service.latest({ profile: 'us_preferred', market_scope: 'us' });
  assert('latest delegates source read', calls[0]?.operation === 'latest');
  assert('latest delegates formula to Python port', latest?.kind === 'daily');
  assert(
    'latest projection receives no B3-only field',
    !('fingerprint_preimage_jcs' in ((calls[1]?.value as Record<string, unknown>) ?? {}))
  );

  calls.length = 0;
  const byDate = await service.byDate({
    trading_day: '2026-07-12',
    profile: 'us_preferred',
    market_scope: 'us',
  });
  const byDateQuery = calls[0]?.value as Record<string, unknown>;
  assert('by-date reuses authoritative B3 browse', calls[0]?.operation === 'byDate');
  assert('by-date pins exact day', byDateQuery.trading_day === '2026-07-12');
  assert('by-date requests one authoritative source', byDateQuery.page_size === 1);
  assert('by-date hydrates selected B3 detail', calls[1]?.operation === 'detail');
  assert('by-date delegates formula to Python port', byDate?.kind === 'daily');

  calls.length = 0;
  const history = await service.history({
    query: 'AAPL',
    profile: 'us_preferred',
    market_scope: 'us',
    from_day: '2026-07-01',
    to_day: '2026-07-12',
  });
  const historyRead = calls[0]?.value as Record<string, unknown>;
  const historyProjection = calls[1]?.value as {
    envelopes: Record<string, unknown>[];
    filters: Record<string, unknown>;
    tradingDays: Record<string, string>;
  };
  assert('history uses configured bounded source limit', historyRead.limit === 77);
  assert(
    'history forwards exact filters only to Python',
    historyProjection.filters.query === 'AAPL'
  );
  assert(
    'history reconstructs exact envelopes',
    !('fingerprint_preimage_jcs' in historyProjection.envelopes[0])
  );
  assert(
    'history preserves the persisted trading day outside the signed envelope',
    historyProjection.tradingDays[SNAPSHOT.snapshot_id] === SNAPSHOT.trading_day
  );
  assert('history delegates formula to Python port', history.kind === 'history');

  const emptyCalls: Call[] = [];
  const emptyPorts = ports(emptyCalls, []);
  const emptyService = new DailyReportProjectionService(emptyPorts.read, emptyPorts.projection);
  assert(
    'latest empty does not invoke projection',
    (await emptyService.latest({ profile: 'us_preferred', market_scope: 'us' })) === null &&
      emptyCalls.every(call => call.operation !== 'projectDaily')
  );
  emptyCalls.length = 0;
  assert(
    'by-date empty does not invoke projection',
    (await emptyService.byDate({
      trading_day: '2026-07-12',
      profile: 'us_preferred',
      market_scope: 'us',
    })) === null && emptyCalls.every(call => call.operation !== 'projectDaily')
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
