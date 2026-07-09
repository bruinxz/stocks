/**
 * api-rate-limit.test.ts — ADR-0010 §4.5 · IETF draft-08 RateLimit + RateLimit-Policy headers.
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-rate-limit.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  buildApiRateLimitMiddleware,
  apiRateLimitMiddleware,
  CURRENT_RATE_LIMIT_CONFIG,
  RateLimitConfig,
} from '../../src/middlewares/apiRateLimit';

function buildApp(config: RateLimitConfig | null): express.Express {
  const app = express();
  app.use(buildApiRateLimitMiddleware(config));
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
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

function assertAbsent(label: string, headers: Record<string, string | string[] | undefined>, key: string): void {
  const lc = key.toLowerCase();
  if (headers[lc] === undefined) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}\n    got header ${key}: ${headers[lc]}`);
  }
}

(async () => {
  // (a-c) null config → zero-emit
  {
    const res = await request(buildApp(null)).get('/ping');
    assertEq('null config · downstream reached · status 200', res.status, 200);
    assertAbsent('null config · no RateLimit header', res.headers, 'RateLimit');
    assertAbsent('null config · no RateLimit-Policy header', res.headers, 'RateLimit-Policy');
  }

  // (d) quota only → RateLimit-Policy q=... · RateLimit r=... · no w= no t=
  {
    const res = await request(buildApp({ quota: 100 })).get('/ping');
    assertEq('quota only · RateLimit-Policy present', res.headers['ratelimit-policy'], '"default";q=100');
    assertEq('quota only · RateLimit present', res.headers['ratelimit'], '"default";r=100');
  }

  // (e) window only → RateLimit-Policy w=... · RateLimit t=... · no q= no r=
  {
    const res = await request(buildApp({ window_seconds: 60 })).get('/ping');
    assertEq('window only · RateLimit-Policy present', res.headers['ratelimit-policy'], '"default";w=60');
    assertEq('window only · RateLimit present', res.headers['ratelimit'], '"default";t=60');
  }

  // (f) empty policy_name → defaults to "default"
  {
    const res = await request(buildApp({ policy_name: '', quota: 50 })).get('/ping');
    assertEq('empty policy_name · defaults to "default"', res.headers['ratelimit-policy'], '"default";q=50');
  }

  // (g) full config → both headers with all fields, custom policy_name
  {
    const res = await request(
      buildApp({ policy_name: 'v1', quota: 200, window_seconds: 3600 }),
    ).get('/ping');
    assertEq('三-字段 config · RateLimit-Policy', res.headers['ratelimit-policy'], '"v1";q=200;w=3600');
    assertEq('三-字段 config · RateLimit', res.headers['ratelimit'], '"v1";r=200;t=3600');
  }

  // (h) NaN quota → skip q= and r= fail-OPEN (window_seconds present)
  {
    const res = await request(buildApp({ quota: NaN, window_seconds: 60 })).get('/ping');
    assertEq('NaN quota · fail-OPEN skip q= (window remains)', res.headers['ratelimit-policy'], '"default";w=60');
    assertEq('NaN quota · fail-OPEN skip r= (t= remains)', res.headers['ratelimit'], '"default";t=60');
    assertEq('NaN quota · downstream reached', res.status, 200);
  }

  // (i) NaN window_seconds → skip w= and t= fail-OPEN
  {
    const res = await request(buildApp({ quota: 100, window_seconds: NaN })).get('/ping');
    assertEq('NaN window · fail-OPEN skip w=', res.headers['ratelimit-policy'], '"default";q=100');
    assertEq('NaN window · fail-OPEN skip t=', res.headers['ratelimit'], '"default";r=100');
  }

  // (j) both NaN → no headers (single-quoted policy-name alone insufficient)
  {
    const res = await request(buildApp({ quota: NaN, window_seconds: NaN })).get('/ping');
    assertAbsent('both NaN · no RateLimit-Policy', res.headers, 'RateLimit-Policy');
    assertAbsent('both NaN · no RateLimit', res.headers, 'RateLimit');
    assertEq('both NaN · downstream reached', res.status, 200);
  }

  // (k) next() 100% called even with config
  {
    const res = await request(buildApp({ quota: 100, window_seconds: 60 })).get('/ping');
    assertEq('with config · next() called · body ok', res.body, { ok: true });
  }

  // (l) apiRateLimitMiddleware() factory returns function
  {
    assertTrue('apiRateLimitMiddleware() returns function', typeof apiRateLimitMiddleware() === 'function');
  }

  // (m) pkg-level default is null (no api_rate_limit block in package.json → zero-emit)
  {
    assertEq(
      'pkg default · CURRENT_RATE_LIMIT_CONFIG null (default OFF)',
      CURRENT_RATE_LIMIT_CONFIG,
      null,
    );
  }

  // (n) draft-08 shape verify: policy-name quoted, semicolon-delimited, no spaces after semicolon
  {
    const res = await request(buildApp({ policy_name: 'burst', quota: 10, window_seconds: 1 })).get('/ping');
    const policy = res.headers['ratelimit-policy'] as string;
    assertTrue('draft-08 · policy-name quoted', policy.startsWith('"burst"'), `got: ${policy}`);
    assertTrue('draft-08 · semicolon-delimited no spaces', !policy.includes('; '), `got: ${policy}`);
  }

  console.log(`\n=== api-rate-limit: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
