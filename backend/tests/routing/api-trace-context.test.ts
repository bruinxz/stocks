/**
 * api-trace-context.test.ts — ADR-0010 §4.9 · W3C Trace Context Level 1
 * (W3C Recommendation 23-Nov-2021) distributed-tracing carrier advisory
 * header echo-only v0 behavior.
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-trace-context.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  buildApiTraceContextMiddleware,
  apiTraceContextMiddleware,
  CURRENT_TRACE_CONTEXT_CONFIG,
  TraceContextConfig,
  isValidTraceparent,
  isValidTracestate,
} from '../../src/middlewares/apiTraceContext';
import { buildApiServerTimingMiddleware } from '../../src/middlewares/apiServerTiming';
import { buildApiTimingAllowOriginMiddleware } from '../../src/middlewares/apiTimingAllowOrigin';

function buildApp(config: TraceContextConfig | null): express.Express {
  const app = express();
  app.use(buildApiTraceContextMiddleware(config));
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/notfound', (_req, res) => res.status(404).json({ error: 'not_found' }));
  app.get('/server-error', (_req, res) => res.status(500).json({ error: 'server_error' }));
  app.get('/preset-tp', (_req, res) => {
    res.setHeader('traceparent', '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
    res.status(200).json({ ok: true, preset: 'tp' });
  });
  app.get('/preset-ts', (_req, res) => {
    res.setHeader('tracestate', 'vendor=route-owned');
    res.status(200).json({ ok: true, preset: 'ts' });
  });
  return app;
}

function buildCombinedApp(tcConfig: TraceContextConfig | null): express.Express {
  // Compose §4.7 + §4.8 + §4.9 canonical triple (Server-Timing + TAO + Trace Context)
  const app = express();
  app.use(buildApiServerTimingMiddleware({ static_metrics: [{ name: 'app' }] }));
  app.use(buildApiTimingAllowOriginMiddleware({ allow_all: true }));
  app.use(buildApiTraceContextMiddleware(tcConfig));
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

const VALID_TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const VALID_TP2 = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';

(async () => {
  // (a) null config → zero-emit · downstream reached
  {
    const app = buildApp(null);
    const r = await request(app).get('/ping').set('traceparent', VALID_TP);
    assertEq('null config · status 200', r.status, 200);
    assertAbsent('null config · no traceparent echoed', r.headers, 'traceparent');
    assertAbsent('null config · no tracestate echoed', r.headers, 'tracestate');
  }

  // (b) empty config object → zero-emit
  {
    const app = buildApp({});
    const r = await request(app).get('/ping').set('traceparent', VALID_TP);
    assertAbsent('empty config · no traceparent', r.headers, 'traceparent');
    assertEq('empty config · downstream reached', r.status, 200);
  }

  // (c) both toggles false → zero-emit
  {
    const app = buildApp({ echo_traceparent: false, echo_tracestate: false });
    const r = await request(app).get('/ping').set('traceparent', VALID_TP);
    assertAbsent('both false · no traceparent', r.headers, 'traceparent');
    assertAbsent('both false · no tracestate', r.headers, 'tracestate');
  }

  // (d) echo_traceparent=true · valid incoming → echoed verbatim
  {
    const app = buildApp({ echo_traceparent: true });
    const r = await request(app).get('/ping').set('traceparent', VALID_TP);
    assertEq('echo_traceparent · valid incoming echoed', r.headers['traceparent'], VALID_TP);
  }

  // (e) echo_traceparent=true · no incoming header → zero-emit (echo-only v0)
  {
    const app = buildApp({ echo_traceparent: true });
    const r = await request(app).get('/ping');
    assertAbsent('echo_traceparent · missing incoming · no header (echo-only)', r.headers, 'traceparent');
  }

  // (f) echo_traceparent=true · invalid version (not "00") → drop silently
  {
    const app = buildApp({ echo_traceparent: true });
    const r = await request(app)
      .get('/ping')
      .set('traceparent', '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    assertAbsent('invalid version "01" · dropped', r.headers, 'traceparent');
  }

  // (g) echo_traceparent=true · malformed (wrong hex length) → drop
  {
    const app = buildApp({ echo_traceparent: true });
    const r = await request(app)
      .get('/ping')
      .set('traceparent', '00-tooshort-b7ad6b7169203331-01');
    assertAbsent('malformed hex-length · dropped', r.headers, 'traceparent');
  }

  // (h) echo_traceparent=true · uppercase hex → drop (spec: lowercase only)
  {
    const app = buildApp({ echo_traceparent: true });
    const r = await request(app)
      .get('/ping')
      .set('traceparent', '00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01');
    assertAbsent('uppercase hex · dropped (lowercase-only per §3.2)', r.headers, 'traceparent');
  }

  // (i) echo_traceparent=true · all-zero trace-id → drop (§3.2.2.3 MUST NOT)
  {
    const app = buildApp({ echo_traceparent: true });
    const r = await request(app)
      .get('/ping')
      .set('traceparent', '00-00000000000000000000000000000000-b7ad6b7169203331-01');
    assertAbsent('all-zero trace-id · dropped', r.headers, 'traceparent');
  }

  // (j) echo_traceparent=true · all-zero parent-id → drop (§3.2.2.3 MUST NOT)
  {
    const app = buildApp({ echo_traceparent: true });
    const r = await request(app)
      .get('/ping')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01');
    assertAbsent('all-zero parent-id · dropped', r.headers, 'traceparent');
  }

  // (k) echo_traceparent=true · extra fields (future version-forward-compat rejected in v0) → drop
  {
    const app = buildApp({ echo_traceparent: true });
    const r = await request(app)
      .get('/ping')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra');
    assertAbsent('trailing extra field · dropped (v0 strict)', r.headers, 'traceparent');
  }

  // (l) route pre-sets traceparent → middleware does NOT overwrite
  {
    const app = buildApp({ echo_traceparent: true });
    const r = await request(app).get('/preset-tp').set('traceparent', VALID_TP);
    assertEq(
      'route pre-set traceparent preserved (route authority)',
      r.headers['traceparent'],
      '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    );
  }

  // (m) echo_tracestate=true · valid incoming → echoed
  {
    const app = buildApp({ echo_tracestate: true });
    const r = await request(app).get('/ping').set('tracestate', 'vendor=abc123,other=xyz');
    assertEq('echo_tracestate · valid echoed', r.headers['tracestate'], 'vendor=abc123,other=xyz');
  }

  // (n) echo_tracestate=true · empty string → zero-emit
  {
    const app = buildApp({ echo_tracestate: true });
    const r = await request(app).get('/ping').set('tracestate', '');
    assertAbsent('empty tracestate · zero-emit', r.headers, 'tracestate');
  }

  // (o) echo_tracestate=true · injected non-printable via prior middleware → drop
  // (Node's HTTP client rejects non-printable in request headers, so we inject
  // server-side after headers are parsed to exercise the isValidTracestate guard.)
  {
    const app = express();
    app.use((req, _res, next) => {
      (req.headers as Record<string, string>).tracestate = 'vendor=abc\x01xyz';
      next();
    });
    app.use(buildApiTraceContextMiddleware({ echo_tracestate: true }));
    app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
    const r = await request(app).get('/ping');
    assertAbsent('non-printable tracestate (server-injected) · dropped', r.headers, 'tracestate');
  }

  // (p) echo_tracestate=true · over 512 chars → drop
  {
    const app = buildApp({ echo_tracestate: true });
    const overflow = 'vendor=' + 'a'.repeat(600);
    const r = await request(app).get('/ping').set('tracestate', overflow);
    assertAbsent('tracestate over 512 chars · dropped', r.headers, 'tracestate');
  }

  // (q) route pre-sets tracestate → not overwritten
  {
    const app = buildApp({ echo_tracestate: true });
    const r = await request(app).get('/preset-ts').set('tracestate', 'vendor=incoming');
    assertEq(
      'route pre-set tracestate preserved (route authority)',
      r.headers['tracestate'],
      'vendor=route-owned',
    );
  }

  // (r) both toggles true · both echo independently
  {
    const app = buildApp({ echo_traceparent: true, echo_tracestate: true });
    const r = await request(app)
      .get('/ping')
      .set('traceparent', VALID_TP)
      .set('tracestate', 'vendor=abc');
    assertEq('both true · traceparent echoed', r.headers['traceparent'], VALID_TP);
    assertEq('both true · tracestate echoed', r.headers['tracestate'], 'vendor=abc');
  }

  // (s) both toggles true · only traceparent incoming → tracestate absent
  {
    const app = buildApp({ echo_traceparent: true, echo_tracestate: true });
    const r = await request(app).get('/ping').set('traceparent', VALID_TP);
    assertEq('only traceparent incoming · echoed', r.headers['traceparent'], VALID_TP);
    assertAbsent('only traceparent incoming · tracestate absent', r.headers, 'tracestate');
  }

  // (t) applies uniformly on 2xx / 4xx / 5xx
  {
    const app = buildApp({ echo_traceparent: true });
    const r200 = await request(app).get('/ping').set('traceparent', VALID_TP);
    const r404 = await request(app).get('/notfound').set('traceparent', VALID_TP);
    const r500 = await request(app).get('/server-error').set('traceparent', VALID_TP);
    assertEq('2xx · traceparent echoed', r200.headers['traceparent'], VALID_TP);
    assertEq('4xx · traceparent echoed', r404.headers['traceparent'], VALID_TP);
    assertEq('5xx · traceparent echoed', r500.headers['traceparent'], VALID_TP);
    assertEq('4xx · status preserved', r404.status, 404);
    assertEq('5xx · status preserved', r500.status, 500);
  }

  // (u) concurrent requests · per-request independent (no cross-request state leak)
  {
    const app = buildApp({ echo_traceparent: true });
    const [rA, rB, rC] = await Promise.all([
      request(app).get('/ping').set('traceparent', VALID_TP),
      request(app).get('/ping').set('traceparent', VALID_TP2),
      request(app).get('/ping'),
    ]);
    assertEq('concurrent · req A → echo A', rA.headers['traceparent'], VALID_TP);
    assertEq('concurrent · req B → echo B', rB.headers['traceparent'], VALID_TP2);
    assertAbsent('concurrent · req C (no incoming) → no header', rC.headers, 'traceparent');
  }

  // (v) §4.7 + §4.8 + §4.9 canonical triple coexist
  {
    const app = buildCombinedApp({ echo_traceparent: true });
    const r = await request(app)
      .get('/ping')
      .set('Origin', 'https://any.example')
      .set('traceparent', VALID_TP);
    assertEq('canonical triple · Server-Timing present', r.headers['server-timing'], 'app');
    assertEq('canonical triple · Timing-Allow-Origin: *', r.headers['timing-allow-origin'], '*');
    assertEq('canonical triple · traceparent echoed', r.headers['traceparent'], VALID_TP);
  }

  // (w) canonical triple · trace-context zero-emit unaffected by §4.7 §4.8 emit
  {
    const app = buildCombinedApp({ echo_traceparent: true });
    const r = await request(app).get('/ping').set('Origin', 'https://any.example');
    assertEq('canonical triple · Server-Timing still emits', r.headers['server-timing'], 'app');
    assertEq('canonical triple · TAO still emits', r.headers['timing-allow-origin'], '*');
    assertAbsent('canonical triple · trace absent (no incoming)', r.headers, 'traceparent');
  }

  // (x) next() 100% called · downstream body reached
  {
    const app = buildApp({ echo_traceparent: true });
    const r = await request(app).get('/ping').set('traceparent', VALID_TP);
    assertEq('next() called · body reached', r.body, { ok: true });
  }

  // (y) factory returns function · pkg-level default null
  {
    assertTrue('apiTraceContextMiddleware() returns function', typeof apiTraceContextMiddleware() === 'function');
    assertEq('pkg default · CURRENT_TRACE_CONTEXT_CONFIG null', CURRENT_TRACE_CONTEXT_CONFIG, null);
  }

  // (z) isValidTraceparent standalone helper canonical vectors
  {
    assertTrue('isValid: canonical VALID_TP', isValidTraceparent(VALID_TP));
    assertTrue('isValid: canonical VALID_TP2', isValidTraceparent(VALID_TP2));
    assertTrue('isValid: null → false', !isValidTraceparent(null));
    assertTrue('isValid: undefined → false', !isValidTraceparent(undefined));
    assertTrue('isValid: number → false', !isValidTraceparent(123 as unknown));
    assertTrue('isValid: empty string → false', !isValidTraceparent(''));
    assertTrue('isValid: version 01 → false', !isValidTraceparent('01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'));
    assertTrue('isValid: version ff → false', !isValidTraceparent('ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'));
    assertTrue('isValid: all-zero trace-id → false', !isValidTraceparent('00-00000000000000000000000000000000-b7ad6b7169203331-01'));
    assertTrue('isValid: all-zero parent-id → false', !isValidTraceparent('00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01'));
    assertTrue('isValid: uppercase hex → false', !isValidTraceparent('00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01'));
  }

  // (aa) isValidTracestate standalone helper canonical vectors
  {
    assertTrue('isValidTS: single entry', isValidTracestate('vendor=abc'));
    assertTrue('isValidTS: multi entry', isValidTracestate('vendor=abc,other=xyz'));
    assertTrue('isValidTS: 512 chars exact', isValidTracestate('a'.repeat(512)));
    assertTrue('isValidTS: 513 chars → false', !isValidTracestate('a'.repeat(513)));
    assertTrue('isValidTS: empty → false', !isValidTracestate(''));
    assertTrue('isValidTS: control char → false', !isValidTracestate('a\x00b'));
    assertTrue('isValidTS: null → false', !isValidTracestate(null));
    assertTrue('isValidTS: undefined → false', !isValidTracestate(undefined));
  }

  // (ab) trace-flags variation preserved verbatim (sampled=01 vs unsampled=00)
  {
    const app = buildApp({ echo_traceparent: true });
    const rSampled = await request(app).get('/ping').set('traceparent', VALID_TP);
    const rUnsampled = await request(app).get('/ping').set('traceparent', VALID_TP2);
    assertEq('sampled flag=01 preserved', rSampled.headers['traceparent'], VALID_TP);
    assertEq('unsampled flag=00 preserved', rUnsampled.headers['traceparent'], VALID_TP2);
  }

  // (ac) echo_traceparent=true string "true" is NOT truthy (strict boolean === true)
  {
    const app = buildApp({ echo_traceparent: 'true' as unknown as boolean });
    const r = await request(app).get('/ping').set('traceparent', VALID_TP);
    assertAbsent('echo_traceparent string "true" · no echo (strict boolean check)', r.headers, 'traceparent');
  }

  console.log(`\n=== api-trace-context: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
