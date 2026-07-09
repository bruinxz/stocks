/**
 * api-server-timing.test.ts — ADR-0010 §4.7 · W3C Server-Timing Level 1 (CR 25-May-2022).
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-server-timing.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  buildApiServerTimingMiddleware,
  apiServerTimingMiddleware,
  CURRENT_SERVER_TIMING_CONFIG,
  ServerTimingConfig,
} from '../../src/middlewares/apiServerTiming';

function buildApp(config: ServerTimingConfig | null): express.Express {
  const app = express();
  app.use(buildApiServerTimingMiddleware(config));
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/notfound', (_req, res) => res.status(404).json({ error: 'not_found' }));
  app.get('/server-error', (_req, res) => res.status(500).json({ error: 'server_error' }));
  app.get('/preset', (_req, res) => {
    res.setHeader('Server-Timing', 'route-owned;dur=1');
    res.status(200).json({ ok: true, preset: true });
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
  // (a) null config → zero-emit · downstream reached
  {
    const app = buildApp(null);
    const r = await request(app).get('/ping');
    assertEq('null config · status 200', r.status, 200);
    assertAbsent('null config · no Server-Timing', r.headers, 'Server-Timing');
  }

  // (b) empty static_metrics + measure_total absent → zero-emit
  {
    const app = buildApp({});
    const r = await request(app).get('/ping');
    assertAbsent('empty config · no Server-Timing', r.headers, 'Server-Timing');
    assertEq('empty config · downstream reached', r.status, 200);
  }

  // (c) empty static_metrics + measure_total=false → zero-emit
  {
    const app = buildApp({ static_metrics: [], measure_total: false });
    const r = await request(app).get('/ping');
    assertAbsent('empty static + measure=false · no header', r.headers, 'Server-Timing');
  }

  // (d) one static metric name-only
  {
    const app = buildApp({ static_metrics: [{ name: 'app' }] });
    const r = await request(app).get('/ping');
    assertEq('static name-only · Server-Timing: app', r.headers['server-timing'], 'app');
  }

  // (e) static metric with dur
  {
    const app = buildApp({ static_metrics: [{ name: 'app', dur: 42 }] });
    const r = await request(app).get('/ping');
    assertEq('static name+dur · Server-Timing: app;dur=42', r.headers['server-timing'], 'app;dur=42');
  }

  // (f) static metric with desc
  {
    const app = buildApp({ static_metrics: [{ name: 'app', desc: 'raft-backend' }] });
    const r = await request(app).get('/ping');
    assertEq('static name+desc · Server-Timing: app;desc="raft-backend"', r.headers['server-timing'], 'app;desc="raft-backend"');
  }

  // (g) static metric with dur + desc
  {
    const app = buildApp({ static_metrics: [{ name: 'app', desc: 'raft-backend', dur: 42 }] });
    const r = await request(app).get('/ping');
    assertEq('static name+desc+dur canonical', r.headers['server-timing'], 'app;desc="raft-backend";dur=42');
  }

  // (h) multiple static metrics → comma-delimited
  {
    const app = buildApp({ static_metrics: [{ name: 'db', dur: 53 }, { name: 'app', dur: 47 }, { name: 'cache', desc: 'Cache Read', dur: 23 }] });
    const r = await request(app).get('/ping');
    assertEq('multi-metric comma-delimited', r.headers['server-timing'], 'db;dur=53, app;dur=47, cache;desc="Cache Read";dur=23');
  }

  // (i) measure_total only → total;dur=<positive-ms>
  {
    const app = buildApp({ measure_total: true });
    const r = await request(app).get('/ping');
    const header = r.headers['server-timing'] as string | undefined;
    assertTrue('measure_total only · header present', typeof header === 'string', `got: ${header}`);
    assertTrue('measure_total · matches total;dur=<num>', /^total;dur=\d+\.\d{3}$/.test(header ?? ''), `got: ${header}`);
    const match = (header ?? '').match(/^total;dur=(\d+\.\d{3})$/);
    const durVal = match ? parseFloat(match[1]) : NaN;
    assertTrue('measure_total · dur >= 0', durVal >= 0, `got: ${durVal}`);
    assertTrue('measure_total · dur < 5000ms (test-scale sanity)', durVal < 5000, `got: ${durVal}`);
  }

  // (j) static + measure_total combined
  {
    const app = buildApp({ static_metrics: [{ name: 'app', desc: 'raft-backend' }], measure_total: true });
    const r = await request(app).get('/ping');
    const header = r.headers['server-timing'] as string | undefined;
    assertTrue('static+measure_total · header present', typeof header === 'string');
    assertTrue('static+measure_total · starts with app;desc', (header ?? '').startsWith('app;desc="raft-backend"'), `got: ${header}`);
    assertTrue('static+measure_total · contains total;dur=', (header ?? '').includes(', total;dur='), `got: ${header}`);
  }

  // (k) invalid metric-name (contains space) → skip
  {
    const app = buildApp({ static_metrics: [{ name: 'has space', dur: 1 }, { name: 'ok', dur: 2 }] });
    const r = await request(app).get('/ping');
    assertEq('invalid name skipped · valid emitted', r.headers['server-timing'], 'ok;dur=2');
  }

  // (l) invalid dur (string) → dur param dropped · name-only emitted
  {
    const app = buildApp({ static_metrics: [{ name: 'app', dur: 'nope' as unknown as number }] });
    const r = await request(app).get('/ping');
    assertEq('invalid dur (string) · dropped · name emitted', r.headers['server-timing'], 'app');
  }

  // (m) negative dur → dur param dropped
  {
    const app = buildApp({ static_metrics: [{ name: 'app', dur: -5 }] });
    const r = await request(app).get('/ping');
    assertEq('negative dur · dropped', r.headers['server-timing'], 'app');
  }

  // (n) NaN dur → dur param dropped
  {
    const app = buildApp({ static_metrics: [{ name: 'app', dur: NaN }] });
    const r = await request(app).get('/ping');
    assertEq('NaN dur · dropped', r.headers['server-timing'], 'app');
  }

  // (o) Infinity dur → dur param dropped
  {
    const app = buildApp({ static_metrics: [{ name: 'app', dur: Infinity }] });
    const r = await request(app).get('/ping');
    assertEq('Infinity dur · dropped', r.headers['server-timing'], 'app');
  }

  // (p) desc with special chars (quote + backslash) → escaped canonically
  {
    const app = buildApp({ static_metrics: [{ name: 'app', desc: 'say "hi"\\end' }] });
    const r = await request(app).get('/ping');
    assertEq('desc special chars escaped', r.headers['server-timing'], 'app;desc="say \\"hi\\"\\\\end"');
  }

  // (q) route pre-sets Server-Timing → middleware does NOT overwrite
  {
    const app = buildApp({ static_metrics: [{ name: 'mw', dur: 1 }] });
    const r = await request(app).get('/preset');
    assertEq('route pre-set preserved (route authority)', r.headers['server-timing'], 'route-owned;dur=1');
  }

  // (r) concurrent requests · per-request independent
  {
    const app = buildApp({ static_metrics: [{ name: 'app' }], measure_total: true });
    const [r1, r2, r3] = await Promise.all([
      request(app).get('/ping'),
      request(app).get('/ping'),
      request(app).get('/ping'),
    ]);
    for (const r of [r1, r2, r3]) {
      const h = r.headers['server-timing'] as string;
      assertTrue('concurrent · each request has app + total', typeof h === 'string' && h.startsWith('app') && h.includes(', total;dur='), `got: ${h}`);
    }
  }

  // (s) Server-Timing emits on 4xx (404 route)
  {
    const app = buildApp({ static_metrics: [{ name: 'app' }] });
    const r = await request(app).get('/notfound');
    assertEq('4xx · Server-Timing emitted', r.headers['server-timing'], 'app');
    assertEq('4xx · status preserved', r.status, 404);
  }

  // (t) Server-Timing emits on 5xx (500 route)
  {
    const app = buildApp({ static_metrics: [{ name: 'app' }] });
    const r = await request(app).get('/server-error');
    assertEq('5xx · Server-Timing emitted', r.headers['server-timing'], 'app');
  }

  // (u) all metrics invalid → zero header
  {
    const app = buildApp({ static_metrics: [{ name: 'bad name' }, { name: '' }, { name: 'also bad' }] });
    const r = await request(app).get('/ping');
    assertAbsent('all invalid metrics · no header', r.headers, 'Server-Timing');
  }

  // (v) empty desc string → desc param dropped, name emitted alone
  {
    const app = buildApp({ static_metrics: [{ name: 'app', desc: '' }] });
    const r = await request(app).get('/ping');
    assertEq('empty desc · dropped · name only', r.headers['server-timing'], 'app');
  }

  // (w) zero dur → emitted (RFC allows non-negative)
  {
    const app = buildApp({ static_metrics: [{ name: 'app', dur: 0 }] });
    const r = await request(app).get('/ping');
    assertEq('zero dur · emitted (non-negative allowed)', r.headers['server-timing'], 'app;dur=0');
  }

  // (x) factory returns function
  {
    assertTrue('apiServerTimingMiddleware() returns function', typeof apiServerTimingMiddleware() === 'function');
  }

  // (y) pkg-level default null (no api_server_timing block in package.json)
  {
    assertEq('pkg default · CURRENT_SERVER_TIMING_CONFIG null', CURRENT_SERVER_TIMING_CONFIG, null);
  }

  // (z) next() 100% called · downstream body reached
  {
    const app = buildApp({ static_metrics: [{ name: 'app' }] });
    const r = await request(app).get('/ping');
    assertEq('next() called · body reached', r.body, { ok: true });
  }

  // (aa) tchar edge chars valid (all RFC 7230 tchar set members)
  {
    const app = buildApp({ static_metrics: [{ name: "a!#$%&'*+.^_`|~-9Z" }] });
    const r = await request(app).get('/ping');
    assertEq('tchar full-set canonical valid', r.headers['server-timing'], "a!#$%&'*+.^_`|~-9Z");
  }

  console.log(`\n=== api-server-timing: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
