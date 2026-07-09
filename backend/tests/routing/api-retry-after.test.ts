/**
 * api-retry-after.test.ts — ADR-0010 §4.6 · RFC 9110 §10.2.3 Retry-After header (delay-seconds).
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-retry-after.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  buildApiRetryAfterMiddleware,
  apiRetryAfterMiddleware,
  CURRENT_RETRY_AFTER_CONFIG,
  RetryAfterConfig,
} from '../../src/middlewares/apiRetryAfter';

function buildApp(config: RetryAfterConfig | null): express.Express {
  const app = express();
  app.use(buildApiRetryAfterMiddleware(config));
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/throttled', (_req, res) => res.status(429).json({ error: 'rate_limited' }));
  app.get('/unavailable', (_req, res) => res.status(503).json({ error: 'unavailable' }));
  app.get('/error', (_req, res) => res.status(500).json({ error: 'server_error' }));
  app.get('/preset', (_req, res) => {
    res.setHeader('Retry-After', '999');
    res.status(429).json({ error: 'rate_limited', preset: true });
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
  // (a) null config → zero-emit on any status
  {
    const app = buildApp(null);
    const r200 = await request(app).get('/ping');
    assertEq('null config · status 200', r200.status, 200);
    assertAbsent('null config · no Retry-After on 200', r200.headers, 'Retry-After');
    const r429 = await request(app).get('/throttled');
    assertEq('null config · status 429 pass-through', r429.status, 429);
    assertAbsent('null config · no Retry-After on 429', r429.headers, 'Retry-After');
    const r503 = await request(app).get('/unavailable');
    assertAbsent('null config · no Retry-After on 503', r503.headers, 'Retry-After');
  }

  // (b) empty map → zero-emit
  {
    const app = buildApp({ map: {} });
    const r429 = await request(app).get('/throttled');
    assertAbsent('empty map · no Retry-After on 429', r429.headers, 'Retry-After');
    assertEq('empty map · downstream reached', r429.status, 429);
  }

  // (c) 429 map entry → emit on 429 route only
  {
    const app = buildApp({ map: { '429': 60 } });
    const r429 = await request(app).get('/throttled');
    assertEq('429 map · Retry-After: 60 on /throttled', r429.headers['retry-after'], '60');
    const r200 = await request(app).get('/ping');
    assertAbsent('429 map · no Retry-After on 200', r200.headers, 'Retry-After');
    const r503 = await request(app).get('/unavailable');
    assertAbsent('429 map · no Retry-After on 503 (unmapped)', r503.headers, 'Retry-After');
  }

  // (d) 503 map entry → emit on 503 route only
  {
    const app = buildApp({ map: { '503': 30 } });
    const r503 = await request(app).get('/unavailable');
    assertEq('503 map · Retry-After: 30 on /unavailable', r503.headers['retry-after'], '30');
    const r200 = await request(app).get('/ping');
    assertAbsent('503 map · no Retry-After on 200', r200.headers, 'Retry-After');
  }

  // (e) both 429+503 map entries → correct per-status emit
  {
    const app = buildApp({ map: { '429': 60, '503': 30 } });
    const r429 = await request(app).get('/throttled');
    assertEq('both map · Retry-After: 60 on 429', r429.headers['retry-after'], '60');
    const r503 = await request(app).get('/unavailable');
    assertEq('both map · Retry-After: 30 on 503', r503.headers['retry-after'], '30');
    const r500 = await request(app).get('/error');
    assertAbsent('both map · no Retry-After on 500 (unmapped)', r500.headers, 'Retry-After');
  }

  // (f) route pre-sets Retry-After → middleware does NOT overwrite (route authority)
  {
    const app = buildApp({ map: { '429': 60 } });
    const rPre = await request(app).get('/preset');
    assertEq('route pre-set Retry-After · middleware preserves route value', rPre.headers['retry-after'], '999');
  }

  // (g) non-integer seconds (float) → fail-OPEN skip
  {
    const app = buildApp({ map: { '429': 60.5 } });
    const r429 = await request(app).get('/throttled');
    assertAbsent('non-integer seconds · fail-OPEN skip', r429.headers, 'Retry-After');
    assertEq('non-integer seconds · downstream reached', r429.status, 429);
  }

  // (h) negative seconds → fail-OPEN skip
  {
    const app = buildApp({ map: { '429': -30 } });
    const r429 = await request(app).get('/throttled');
    assertAbsent('negative seconds · fail-OPEN skip', r429.headers, 'Retry-After');
  }

  // (i) NaN seconds → fail-OPEN skip
  {
    const app = buildApp({ map: { '429': NaN } });
    const r429 = await request(app).get('/throttled');
    assertAbsent('NaN seconds · fail-OPEN skip', r429.headers, 'Retry-After');
  }

  // (j) Infinity seconds → fail-OPEN skip
  {
    const app = buildApp({ map: { '429': Infinity } });
    const r429 = await request(app).get('/throttled');
    assertAbsent('Infinity seconds · fail-OPEN skip', r429.headers, 'Retry-After');
  }

  // (k) zero seconds → emit "0" (canonical delay-seconds allows 0)
  {
    const app = buildApp({ map: { '429': 0 } });
    const r429 = await request(app).get('/throttled');
    assertEq('zero seconds · emit "0" (RFC 9110 §10.2.3 delay-seconds = 1*DIGIT, 0 allowed)', r429.headers['retry-after'], '0');
  }

  // (l) 200 status with 429 in map → no header (statusCode not matched)
  {
    const app = buildApp({ map: { '429': 60 } });
    const r200 = await request(app).get('/ping');
    assertEq('status 200 body ok', r200.body, { ok: true });
    assertAbsent('status 200 · no header (429 in map · unmatched)', r200.headers, 'Retry-After');
  }

  // (m) concurrent requests · no cross-talk (per-request writeHead patch)
  {
    const app = buildApp({ map: { '429': 60, '503': 30 } });
    const [r429, r503, r200] = await Promise.all([
      request(app).get('/throttled'),
      request(app).get('/unavailable'),
      request(app).get('/ping'),
    ]);
    assertEq('concurrent · 429 gets 60', r429.headers['retry-after'], '60');
    assertEq('concurrent · 503 gets 30', r503.headers['retry-after'], '30');
    assertAbsent('concurrent · 200 gets no header', r200.headers, 'Retry-After');
  }

  // (n) next() 100% called even with matching status downstream
  {
    const app = buildApp({ map: { '429': 60 } });
    const r429 = await request(app).get('/throttled');
    assertEq('next() called · body reached downstream', r429.body, { error: 'rate_limited' });
  }

  // (o) apiRetryAfterMiddleware() factory returns function
  {
    assertTrue('apiRetryAfterMiddleware() returns function', typeof apiRetryAfterMiddleware() === 'function');
  }

  // (p) pkg-level default is null (no api_retry_after block → zero-emit)
  {
    assertEq(
      'pkg default · CURRENT_RETRY_AFTER_CONFIG null (default OFF)',
      CURRENT_RETRY_AFTER_CONFIG,
      null,
    );
  }

  // (q) map with string-form numeric statusCode keys works canonically (JSON canonical)
  {
    const app = buildApp({ map: { '429': 45 } });
    const r429 = await request(app).get('/throttled');
    assertEq('string-form "429" key · Retry-After: 45', r429.headers['retry-after'], '45');
  }

  console.log(`\n=== api-retry-after: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
