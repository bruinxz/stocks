/**
 * health-supported-api-versions.test.ts — ADR-0010 §4.3 (partial · Phase 3 surfacing)
 * + §4.2 co-location (api_version field on /health payload).
 *
 * Boots a minimal express app mirroring backend/src/index.ts /health handler
 * (isolated · no DB/Redis/Bull) and asserts the payload shape.
 *
 * 不依赖 jest · 与 backend/src/scripts/run-tests.ts 约定一致:
 *   cd backend && npx ts-node --transpile-only tests/routing/health-supported-api-versions.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  apiVersionMiddleware,
  CURRENT_API_VERSION,
  SUPPORTED_API_VERSIONS,
} from '../../src/middlewares/apiVersion';

function buildTestApp(): express.Express {
  const app = express();
  app.use(apiVersionMiddleware());
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      api_version: CURRENT_API_VERSION,
      supported_api_versions: SUPPORTED_API_VERSIONS,
    });
  });
  return app;
}

let passed = 0;
let failed = 0;

function assertEq<T>(label: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? `\n    ${detail}` : ''}`);
  }
}

(async () => {
  const app = buildTestApp();

  // (a) /health returns 200 with expected static fields.
  const res = await request(app).get('/health');
  assertEq('/health status = 200', res.status, 200);
  assertEq('/health body.status = "ok"', res.body.status, 'ok');
  assertTrue(
    '/health body.timestamp is ISO-8601',
    typeof res.body.timestamp === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(res.body.timestamp),
    `got timestamp=${res.body.timestamp}`,
  );

  // (b) ADR-0010 §4.2 co-location: api_version field on payload matches
  //     CURRENT_API_VERSION (the same value emitted in X-API-Version header).
  assertEq('/health body.api_version = CURRENT_API_VERSION', res.body.api_version, CURRENT_API_VERSION);
  assertEq(
    '/health X-API-Version header = body.api_version (dual-source consistency)',
    res.headers['x-api-version'],
    res.body.api_version,
  );

  // (c) ADR-0010 §4.3 partial: supported_api_versions is a non-empty array of
  //     positive integers derived from CURRENT_API_VERSION major.
  assertTrue(
    '/health body.supported_api_versions is array',
    Array.isArray(res.body.supported_api_versions),
    `got type=${typeof res.body.supported_api_versions}`,
  );
  assertTrue(
    '/health body.supported_api_versions is non-empty',
    Array.isArray(res.body.supported_api_versions) &&
      res.body.supported_api_versions.length > 0,
  );
  assertTrue(
    '/health body.supported_api_versions contains only positive integers',
    Array.isArray(res.body.supported_api_versions) &&
      res.body.supported_api_versions.every(
        (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0,
      ),
  );
  const expectedMajor = Number.parseInt(CURRENT_API_VERSION.split('.')[0] ?? '', 10);
  assertTrue(
    `/health body.supported_api_versions includes CURRENT major (${expectedMajor})`,
    Array.isArray(res.body.supported_api_versions) &&
      res.body.supported_api_versions.includes(expectedMajor),
  );

  // (d) Middleware still emits X-API-Version response header on /health.
  assertEq('/health X-API-Version header present', res.headers['x-api-version'], CURRENT_API_VERSION);

  console.log(`\n=== health-supported-api-versions: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
