/**
 * api-v1-version.test.ts — ADR-0010 §4.3 Phase 3 canonical `/api/v1/version` endpoint.
 *
 * Boots minimal express app with versionHandler + apiVersionMiddleware · asserts
 * response minimal 2-field (build_version + api_version).
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-v1-version.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  apiVersionMiddleware,
  CURRENT_API_VERSION,
} from '../../src/middlewares/apiVersion';
import { versionHandler } from '../../src/api/version';
import pkg from '../../package.json';

function buildTestApp(): express.Express {
  const app = express();
  app.use(apiVersionMiddleware());
  app.get('/api/v1/version', versionHandler);
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

  const res = await request(app).get('/api/v1/version');

  // (a) status 200
  assertEq('/api/v1/version status = 200', res.status, 200);

  // (b) build_version = pkg.version
  const expectedBuildVersion = (pkg as { version?: string }).version ?? 'unknown';
  assertEq(
    '/api/v1/version body.build_version = pkg.version',
    res.body.build_version,
    expectedBuildVersion,
  );

  // (c) api_version = CURRENT_API_VERSION
  assertEq(
    '/api/v1/version body.api_version = CURRENT_API_VERSION',
    res.body.api_version,
    CURRENT_API_VERSION,
  );

  // (d) minimal surface: response has exactly 2 fields (Orch v131 §二(6) 双-字段正交 canonical)
  const bodyKeys = Object.keys(res.body).sort();
  assertEq(
    '/api/v1/version body has exactly 2 keys [api_version, build_version]',
    bodyKeys,
    ['api_version', 'build_version'],
  );

  // (e) X-API-Version header present (middleware applies)
  assertEq(
    '/api/v1/version X-API-Version header = CURRENT_API_VERSION',
    res.headers['x-api-version'],
    CURRENT_API_VERSION,
  );

  // (f) dual-source cross-attest: header X-API-Version === body.api_version
  assertEq(
    '/api/v1/version header X-API-Version === body.api_version',
    res.headers['x-api-version'],
    res.body.api_version,
  );

  console.log(`\n=== api-v1-version: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
