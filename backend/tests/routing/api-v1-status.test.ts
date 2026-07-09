/**
 * api-v1-status.test.ts — ADR-0010 §4.3 Phase 3 canonical `/api/v1/status` endpoint.
 *
 * Boots minimal express app with statusHandler + apiVersionMiddleware · asserts
 * response shape 5-field (api_version + supported_api_versions + build_version +
 * uptime_seconds + timestamp).
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-v1-status.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  apiVersionMiddleware,
  CURRENT_API_VERSION,
  SUPPORTED_API_VERSIONS,
} from '../../src/middlewares/apiVersion';
import { statusHandler } from '../../src/api/status';
import pkg from '../../package.json';

function buildTestApp(): express.Express {
  const app = express();
  app.use(apiVersionMiddleware());
  app.get('/api/v1/status', statusHandler);
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

  const res = await request(app).get('/api/v1/status');

  // (a) status 200
  assertEq('/api/v1/status status = 200', res.status, 200);

  // (b) api_version = CURRENT_API_VERSION
  assertEq(
    '/api/v1/status body.api_version = CURRENT_API_VERSION',
    res.body.api_version,
    CURRENT_API_VERSION,
  );

  // (c) supported_api_versions deep-equals SUPPORTED_API_VERSIONS
  assertEq(
    '/api/v1/status body.supported_api_versions deep-equals SUPPORTED_API_VERSIONS',
    res.body.supported_api_versions,
    Array.from(SUPPORTED_API_VERSIONS),
  );

  // (d) build_version = pkg.version + typeof string
  const expectedBuildVersion = (pkg as { version?: string }).version ?? 'unknown';
  assertEq(
    '/api/v1/status body.build_version = pkg.version',
    res.body.build_version,
    expectedBuildVersion,
  );
  assertTrue(
    '/api/v1/status body.build_version is string',
    typeof res.body.build_version === 'string',
    `got type=${typeof res.body.build_version}`,
  );

  // (e) uptime_seconds is finite number ≥ 0
  assertTrue(
    '/api/v1/status body.uptime_seconds is finite number ≥ 0',
    typeof res.body.uptime_seconds === 'number' &&
      Number.isFinite(res.body.uptime_seconds) &&
      res.body.uptime_seconds >= 0,
    `got=${res.body.uptime_seconds}`,
  );

  // (f) timestamp is ISO-8601 Date parseable
  assertTrue(
    '/api/v1/status body.timestamp is ISO-8601',
    typeof res.body.timestamp === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(res.body.timestamp) &&
      !Number.isNaN(new Date(res.body.timestamp).getTime()),
    `got=${res.body.timestamp}`,
  );

  // (g) X-API-Version header present (middleware applies)
  assertEq(
    '/api/v1/status X-API-Version header = CURRENT_API_VERSION',
    res.headers['x-api-version'],
    CURRENT_API_VERSION,
  );

  // (h) 无鉴权 · unauthenticated 200 (no Authorization header)
  const resNoAuth = await request(app).get('/api/v1/status');
  assertEq('/api/v1/status 无 Authorization header 也 200', resNoAuth.status, 200);

  // (i) triple-source aligned canonical: header + body 天然一致
  assertEq(
    '/api/v1/status header X-API-Version === body.api_version (dual-source cross-attest)',
    res.headers['x-api-version'],
    res.body.api_version,
  );

  console.log(`\n=== api-v1-status: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
