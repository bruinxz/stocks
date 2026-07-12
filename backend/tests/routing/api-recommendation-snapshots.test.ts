import express from 'express';
import request from 'supertest';
import { buildRecommendationSnapshotRoutes } from '../../src/api/routes/recommendationSnapshot.routes';
import {
  RecommendationSnapshotConflictError,
  RecommendationSnapshotContractError,
  RecommendationSnapshotNotFoundError,
  RecommendationSnapshotReadPort,
  RecommendationSnapshotStoreUnavailableError,
  type RecommendationSnapshotDetail,
  type RecommendationSnapshotDiff,
  type RecommendationSnapshotPage,
} from '../../src/recommendations/RecommendationSnapshotReadPort';

const SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

const DETAIL: RecommendationSnapshotDetail = {
  snapshot_id: SNAPSHOT_ID,
  trading_day: '2026-07-10',
  as_of: '2026-07-10T06:00:00Z',
  profile: 'us_preferred',
  market_scope: 'us',
  output_fingerprint: 'b'.repeat(64),
  disclaimer: {
    version: '1.0.0',
    short_text: '仅供参考',
    full_text: '投资有风险，本内容仅供参考。',
    language: 'zh-CN',
    effective_at: '2026-07-01T00:00:00Z',
    hash: 'c'.repeat(64),
  },
  meta: {
    strategy_version: '3.1.0',
    pipeline_version: '3.1.0',
    generated_by: 'fixture',
    generation_ms: 12,
  },
  items: [
    {
      recommendation: {
        ticker: 'AAPL',
        score: { rating: 'A' },
        conviction: { final: 90, level: 'HIGH' },
        risk_gate: { gate: 'GREEN' },
        entry_plan: { size_hint: { tier: 'TIER_3' } },
      },
      rating_band: 'A',
    },
  ],
};

const SUMMARY = {
  snapshot_id: SNAPSHOT_ID,
  trading_day: '2026-07-10',
  as_of: '2026-07-10T06:00:00Z',
  profile: 'us_preferred' as const,
  market_scope: 'us' as const,
  output_fingerprint: 'b'.repeat(64),
  item_count: 1,
  created_at: '2026-07-10T06:00:01Z',
};

type PortCall = { operation: string; args: unknown[] };

function buildPort(calls: PortCall[]): RecommendationSnapshotReadPort {
  return {
    async latest(scope) {
      calls.push({ operation: 'latest', args: [scope] });
      return DETAIL;
    },
    async byDate(query) {
      calls.push({ operation: 'byDate', args: [query] });
      const page: RecommendationSnapshotPage = {
        entries: [SUMMARY],
        total: 1,
        page: query.page,
        page_size: query.page_size,
      };
      return page;
    },
    async detail(snapshotId) {
      calls.push({ operation: 'detail', args: [snapshotId] });
      return DETAIL;
    },
    async diff(baseId, targetId) {
      calls.push({ operation: 'diff', args: [baseId, targetId] });
      const diff: RecommendationSnapshotDiff = {
        base_snapshot_id: baseId,
        target_snapshot_id: targetId,
        profile: 'us_preferred',
        market_scope: 'us',
        fingerprint_match: false,
        added: ['MSFT'],
        removed: [],
        changed: ['AAPL'],
        unchanged: [],
      };
      return diff;
    },
  };
}

function buildApp(port: RecommendationSnapshotReadPort): express.Express {
  const app = express();
  app.use('/api/v1/ai/recommendations', buildRecommendationSnapshotRoutes(port));
  return app;
}

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function main(): Promise<void> {
  const calls: PortCall[] = [];
  const app = buildApp(buildPort(calls));

  const latest = await request(app).get(
    '/api/v1/ai/recommendations/latest?profile=us_preferred&market_scope=us'
  );
  assert('latest returns 200', latest.status === 200);
  assert('latest preserves full disclaimer', latest.body.disclaimer?.hash === 'c'.repeat(64));
  assert('latest preserves full meta', latest.body.meta?.pipeline_version === '3.1.0');
  assert('latest preserves recommendation item', latest.body.items?.[0]?.rating_band === 'A');
  assert(
    'latest passes explicit scope',
    JSON.stringify(calls.at(-1)?.args[0]) ===
      JSON.stringify({ profile: 'us_preferred', market_scope: 'us' })
  );

  const byDate = await request(app).get(
    '/api/v1/ai/recommendations/by-date/2026-07-10' +
      '?profile=multibagger&market_scope=cn_a&page=2&page_size=10'
  );
  assert('by-date returns 200', byDate.status === 200);
  assert('by-date returns page metadata', byDate.body.page === 2 && byDate.body.page_size === 10);
  assert(
    'by-date passes explicit filters',
    JSON.stringify(calls.at(-1)?.args[0]) ===
      JSON.stringify({
        trading_day: '2026-07-10',
        profile: 'multibagger',
        market_scope: 'cn_a',
        page: 2,
        page_size: 10,
      })
  );

  const detail = await request(app).get(`/api/v1/ai/recommendations/${SNAPSHOT_ID}`);
  assert('detail returns 200', detail.status === 200);
  assert('detail uses snapshot id', calls.at(-1)?.args[0] === SNAPSHOT_ID);

  const diff = await request(app).get(
    `/api/v1/ai/recommendations/${SNAPSHOT_ID}/diff/${TARGET_ID}`
  );
  assert('diff returns 200', diff.status === 200);
  assert('diff returns deterministic arrays', JSON.stringify(diff.body.changed) === '["AAPL"]');

  const beforeInvalid = calls.length;
  const missingScope = await request(app).get(
    '/api/v1/ai/recommendations/latest?profile=us_preferred'
  );
  assert('missing scope returns 400', missingScope.status === 400);
  const invalidProfile = await request(app).get(
    '/api/v1/ai/recommendations/latest?profile=custom&market_scope=us'
  );
  assert('custom returns 400', invalidProfile.status === 400);
  const incompatibleScope = await request(app).get(
    '/api/v1/ai/recommendations/latest?profile=japan_blue_chip&market_scope=us'
  );
  assert('incompatible profile/scope returns 400', incompatibleScope.status === 400);
  const invalidDate = await request(app).get(
    '/api/v1/ai/recommendations/by-date/not-a-date' + '?profile=us_preferred&market_scope=us'
  );
  assert('invalid date returns 400', invalidDate.status === 400);
  const invalidDiff = await request(app).get(`/api/v1/ai/recommendations/bad/diff/${TARGET_ID}`);
  assert('invalid diff id returns 400', invalidDiff.status === 400);
  assert('invalid requests do not call port', calls.length === beforeInvalid);

  const missingPort: RecommendationSnapshotReadPort = {
    ...buildPort([]),
    async latest() {
      return null;
    },
    async detail() {
      throw new RecommendationSnapshotNotFoundError();
    },
  };
  const missingApp = buildApp(missingPort);
  assert(
    'null latest returns 404',
    (
      await request(missingApp).get(
        '/api/v1/ai/recommendations/latest?profile=us_preferred&market_scope=us'
      )
    ).status === 404
  );
  assert(
    'not-found error returns 404',
    (await request(missingApp).get(`/api/v1/ai/recommendations/${SNAPSHOT_ID}`)).status === 404
  );

  const errorPort = (
    error: Error,
    operation: keyof RecommendationSnapshotReadPort
  ): RecommendationSnapshotReadPort => ({
    ...buildPort([]),
    [operation]: async () => {
      throw error;
    },
  });
  assert(
    'conflict returns 409',
    (
      await request(
        buildApp(
          errorPort(new RecommendationSnapshotConflictError('Snapshot diff scope mismatch'), 'diff')
        )
      ).get(`/api/v1/ai/recommendations/${SNAPSHOT_ID}/diff/${TARGET_ID}`)
    ).status === 409
  );
  assert(
    'contract error returns 422',
    (
      await request(
        buildApp(
          errorPort(
            new RecommendationSnapshotContractError('Persisted snapshot is malformed'),
            'detail'
          )
        )
      ).get(`/api/v1/ai/recommendations/${SNAPSHOT_ID}`)
    ).status === 422
  );
  assert(
    'unavailable store returns 503',
    (
      await request(
        buildApp(errorPort(new RecommendationSnapshotStoreUnavailableError(), 'latest'))
      ).get('/api/v1/ai/recommendations/latest?profile=us_preferred&market_scope=us')
    ).status === 503
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
