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
  ServerTimingAccumulator,
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

// §4.13 helper: build an app whose /dyn handler exercises the dynamic
// accumulator via the supplied thunk before responding. The thunk receives
// the accumulator and may return a promise so measureAsync/start races are
// awaited cleanly.
function buildDynApp(
  config: ServerTimingConfig | null,
  dyn: (acc: ServerTimingAccumulator) => void | Promise<void>,
): express.Express {
  const app = express();
  app.use(buildApiServerTimingMiddleware(config));
  app.get('/dyn', async (_req, res) => {
    const acc = (res.locals as Record<string, unknown>).serverTiming as ServerTimingAccumulator;
    await dyn(acc);
    res.status(200).json({ ok: true, dyn: true });
  });
  app.get('/dyn-preset', async (_req, res) => {
    const acc = (res.locals as Record<string, unknown>).serverTiming as ServerTimingAccumulator;
    await dyn(acc);
    res.setHeader('Server-Timing', 'route-owned;dur=1');
    res.status(200).json({ ok: true, dyn: true });
  });
  app.get('/dyn-throws', async (_req, res, next) => {
    const acc = (res.locals as Record<string, unknown>).serverTiming as ServerTimingAccumulator;
    try {
      await dyn(acc);
    } catch (err) {
      return next(err);
    }
    res.status(200).json({ ok: true });
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: String(err) });
  });
  return app;
}

// Tiny sleep helper so measureAsync/start capture a non-zero dur.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // ============================================================
  // §4.13 · Dynamic Server-Timing API (measure / measureAsync / start)
  // ============================================================

  // (ab) accumulator ALWAYS exposed on res.locals, even with null config
  {
    let captured: unknown = 'unset';
    const app = buildDynApp(null, (acc) => {
      captured = acc;
    });
    await request(app).get('/dyn');
    assertTrue('null config · accumulator exposed on res.locals', captured !== null && typeof captured === 'object');
  }

  // (ac) measure() records a dynamic metric · emits at flush
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('db', 12.5);
    });
    const r = await request(app).get('/dyn');
    assertEq('dynamic measure(db, 12.5)', r.headers['server-timing'], 'db;dur=12.5');
  }

  // (ad) measure() with desc + dur
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('cache', 3.14, 'redis-l1');
    });
    const r = await request(app).get('/dyn');
    assertEq('dynamic measure with desc+dur', r.headers['server-timing'], 'cache;desc="redis-l1";dur=3.14');
  }

  // (ae) measure() name-only (no dur, no desc)
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('trace');
    });
    const r = await request(app).get('/dyn');
    assertEq('dynamic measure name-only', r.headers['server-timing'], 'trace');
  }

  // (af) measure() invalid name → silent skip · no emit
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('has space', 1);
    });
    const r = await request(app).get('/dyn');
    assertAbsent('dynamic measure invalid name · no header', r.headers, 'Server-Timing');
  }

  // (ag) measure() empty name → silent skip
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('', 1);
    });
    const r = await request(app).get('/dyn');
    assertAbsent('dynamic measure empty name · no header', r.headers, 'Server-Timing');
  }

  // (ah) measure() invalid dur (NaN) → dur param dropped · name emitted
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('app', NaN);
    });
    const r = await request(app).get('/dyn');
    assertEq('dynamic measure NaN dur · name only', r.headers['server-timing'], 'app');
  }

  // (ai) measure() negative dur → dur param dropped
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('app', -5);
    });
    const r = await request(app).get('/dyn');
    assertEq('dynamic measure negative dur · dropped', r.headers['server-timing'], 'app');
  }

  // (aj) measure() Infinity dur → dur param dropped
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('app', Infinity);
    });
    const r = await request(app).get('/dyn');
    assertEq('dynamic measure Infinity dur · dropped', r.headers['server-timing'], 'app');
  }

  // (ak) measure() zero dur emitted
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('app', 0);
    });
    const r = await request(app).get('/dyn');
    assertEq('dynamic measure zero dur · emitted', r.headers['server-timing'], 'app;dur=0');
  }

  // (al) measure() desc special-chars escaped canonically
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('app', undefined, 'say "hi"\\end');
    });
    const r = await request(app).get('/dyn');
    assertEq('dynamic measure desc special-chars escaped', r.headers['server-timing'], 'app;desc="say \\"hi\\"\\\\end"');
  }

  // (am) measure() empty desc dropped
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('app', undefined, '');
    });
    const r = await request(app).get('/dyn');
    assertEq('dynamic measure empty desc · dropped', r.headers['server-timing'], 'app');
  }

  // (an) multiple measure() calls → comma-list preserved insertion order
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure('a', 1);
      acc.measure('b', 2);
      acc.measure('c', 3);
    });
    const r = await request(app).get('/dyn');
    assertEq('dynamic multi-measure comma-list order', r.headers['server-timing'], 'a;dur=1, b;dur=2, c;dur=3');
  }

  // (ao) size property reflects recorded count
  {
    let sizeBefore = -1;
    let sizeAfter = -1;
    const app = buildDynApp(null, (acc) => {
      sizeBefore = acc.size;
      acc.measure('x', 1);
      acc.measure('y', 2);
      sizeAfter = acc.size;
    });
    await request(app).get('/dyn');
    assertEq('accumulator size before measure', sizeBefore, 0);
    assertEq('accumulator size after 2 measures', sizeAfter, 2);
  }

  // (ap) size does NOT count invalid-name skips
  {
    let sizeAfter = -1;
    const app = buildDynApp(null, (acc) => {
      acc.measure('bad name', 1);
      acc.measure('ok', 2);
      sizeAfter = acc.size;
    });
    await request(app).get('/dyn');
    assertEq('accumulator size only counts valid records', sizeAfter, 1);
  }

  // (aq) measureAsync() records elapsed on resolve
  {
    let awaited: unknown = 'unset';
    const app = buildDynApp(null, async (acc) => {
      awaited = await acc.measureAsync('db', (async () => { await delay(15); return 'result'; })());
    });
    const r = await request(app).get('/dyn');
    const h = r.headers['server-timing'] as string | undefined;
    assertTrue('measureAsync · resolve pass-through value', awaited === 'result');
    assertTrue('measureAsync · db metric emitted', typeof h === 'string' && /^db;dur=\d+\.\d+$/.test(h ?? ''), `got: ${h}`);
    const match = (h ?? '').match(/^db;dur=(\d+\.\d+)$/);
    const dur = match ? parseFloat(match[1]) : NaN;
    assertTrue('measureAsync · dur >= 10ms', dur >= 10, `got: ${dur}`);
    assertTrue('measureAsync · dur < 5000ms', dur < 5000, `got: ${dur}`);
  }

  // (ar) measureAsync() records elapsed on reject · rethrows
  {
    let caught: unknown = 'unset';
    const app = buildDynApp({}, async (acc) => {
      try {
        await acc.measureAsync('slow-fail', (async () => { await delay(10); throw new Error('boom'); })());
      } catch (err) {
        caught = (err as Error).message;
      }
    });
    const r = await request(app).get('/dyn');
    const h = r.headers['server-timing'] as string | undefined;
    assertEq('measureAsync · reject rethrown', caught, 'boom');
    assertTrue('measureAsync · reject metric emitted', typeof h === 'string' && /^slow-fail;dur=\d+\.\d+$/.test(h ?? ''), `got: ${h}`);
  }

  // (as) measureAsync() with desc
  {
    const app = buildDynApp(null, async (acc) => {
      await acc.measureAsync('q', Promise.resolve(1), 'pg-primary');
    });
    const r = await request(app).get('/dyn');
    const h = r.headers['server-timing'] as string | undefined;
    assertTrue('measureAsync · desc canonical', typeof h === 'string' && /^q;desc="pg-primary";dur=\d+\.\d+$/.test(h ?? ''), `got: ${h}`);
  }

  // (at) measureAsync() invalid name · still awaits value · no emit
  {
    let awaited: unknown = 'unset';
    const app = buildDynApp(null, async (acc) => {
      awaited = await acc.measureAsync('has space', Promise.resolve('kept'));
    });
    const r = await request(app).get('/dyn');
    assertEq('measureAsync invalid name · value preserved', awaited, 'kept');
    assertAbsent('measureAsync invalid name · no header', r.headers, 'Server-Timing');
  }

  // (au) start()/stop() records elapsed on stop invocation
  {
    const app = buildDynApp(null, async (acc) => {
      const stop = acc.start('phase');
      await delay(12);
      stop();
    });
    const r = await request(app).get('/dyn');
    const h = r.headers['server-timing'] as string | undefined;
    assertTrue('start/stop · metric emitted', typeof h === 'string' && /^phase;dur=\d+\.\d+$/.test(h ?? ''), `got: ${h}`);
    const match = (h ?? '').match(/^phase;dur=(\d+\.\d+)$/);
    const dur = match ? parseFloat(match[1]) : NaN;
    assertTrue('start/stop · dur >= 8ms', dur >= 8, `got: ${dur}`);
  }

  // (av) start()/stop() idempotent · second stop no-op
  {
    let sizeAfterFirst = -1;
    let sizeAfterSecond = -1;
    const app = buildDynApp(null, async (acc) => {
      const stop = acc.start('once');
      await delay(5);
      stop();
      sizeAfterFirst = acc.size;
      stop();
      sizeAfterSecond = acc.size;
    });
    await request(app).get('/dyn');
    assertEq('start/stop idempotent · size 1 after first', sizeAfterFirst, 1);
    assertEq('start/stop idempotent · size 1 after second', sizeAfterSecond, 1);
  }

  // (aw) start() with desc
  {
    const app = buildDynApp(null, async (acc) => {
      const stop = acc.start('scoped', 'block-A');
      await delay(3);
      stop();
    });
    const r = await request(app).get('/dyn');
    const h = r.headers['server-timing'] as string | undefined;
    assertTrue('start · desc canonical', typeof h === 'string' && /^scoped;desc="block-A";dur=\d+\.\d+$/.test(h ?? ''), `got: ${h}`);
  }

  // (ax) start() invalid name · stop() no-op
  {
    let sizeAfter = -1;
    const app = buildDynApp(null, async (acc) => {
      const stop = acc.start('bad name');
      await delay(2);
      stop();
      sizeAfter = acc.size;
    });
    const r = await request(app).get('/dyn');
    assertEq('start invalid name · size 0', sizeAfter, 0);
    assertAbsent('start invalid name · no header', r.headers, 'Server-Timing');
  }

  // (ay) static + dynamic merge canonical order (static first, dynamic after)
  {
    const app = buildDynApp({ static_metrics: [{ name: 'app', desc: 'raft' }] }, (acc) => {
      acc.measure('db', 12);
      acc.measure('cache', 3);
    });
    const r = await request(app).get('/dyn');
    assertEq('static + dynamic merge canonical', r.headers['server-timing'], 'app;desc="raft", db;dur=12, cache;dur=3');
  }

  // (az) static + dynamic + measure_total (total last)
  {
    const app = buildDynApp({ static_metrics: [{ name: 'app' }], measure_total: true }, (acc) => {
      acc.measure('db', 5);
    });
    const r = await request(app).get('/dyn');
    const h = r.headers['server-timing'] as string | undefined;
    assertTrue('static+dynamic+total · starts with app,', (h ?? '').startsWith('app, '), `got: ${h}`);
    assertTrue('static+dynamic+total · contains db;dur=5', (h ?? '').includes(', db;dur=5, '), `got: ${h}`);
    assertTrue('static+dynamic+total · ends with total;dur=', /, total;dur=\d+\.\d{3}$/.test(h ?? ''), `got: ${h}`);
  }

  // (ba) dynamic-only + measure_total (no static)
  {
    const app = buildDynApp({ measure_total: true }, (acc) => {
      acc.measure('db', 7);
    });
    const r = await request(app).get('/dyn');
    const h = r.headers['server-timing'] as string | undefined;
    assertTrue('dynamic + total · starts with db;dur=7', (h ?? '').startsWith('db;dur=7, '), `got: ${h}`);
    assertTrue('dynamic + total · ends with total;dur=', /, total;dur=\d+\.\d{3}$/.test(h ?? ''), `got: ${h}`);
  }

  // (bb) route pre-set Server-Timing wins · dynamic metrics NOT emitted
  {
    const app = buildDynApp({ static_metrics: [{ name: 'mw' }] }, (acc) => {
      acc.measure('db', 12);
    });
    const r = await request(app).get('/dyn-preset');
    assertEq('route pre-set preserved even with dynamic', r.headers['server-timing'], 'route-owned;dur=1');
  }

  // (bc) concurrent requests · dynamic accumulators isolated per-request
  {
    const app = express();
    app.use(buildApiServerTimingMiddleware(null));
    app.get('/dyn-iso', async (req, res) => {
      const acc = (res.locals as Record<string, unknown>).serverTiming as ServerTimingAccumulator;
      const label = String(req.query.label ?? '');
      acc.measure(`req-${label}`, Number(req.query.dur ?? 0));
      await delay(5);
      res.status(200).json({ ok: true });
    });
    const [r1, r2, r3] = await Promise.all([
      request(app).get('/dyn-iso?label=A&dur=1'),
      request(app).get('/dyn-iso?label=B&dur=2'),
      request(app).get('/dyn-iso?label=C&dur=3'),
    ]);
    assertEq('concurrent isolation · A', r1.headers['server-timing'], 'req-A;dur=1');
    assertEq('concurrent isolation · B', r2.headers['server-timing'], 'req-B;dur=2');
    assertEq('concurrent isolation · C', r3.headers['server-timing'], 'req-C;dur=3');
  }

  // (bd) dynamic-only zero-record + null config · no emit
  {
    const app = buildDynApp(null, () => {
      /* no records */
    });
    const r = await request(app).get('/dyn');
    assertAbsent('null config · zero dynamic · no header', r.headers, 'Server-Timing');
  }

  // (be) dynamic-only zero-record + empty static + total=false · no emit
  {
    const app = buildDynApp({ static_metrics: [], measure_total: false }, () => {
      /* no records */
    });
    const r = await request(app).get('/dyn');
    assertAbsent('empty static + no dyn · no header', r.headers, 'Server-Timing');
  }

  // (bf) dynamic-only emits on 4xx status
  {
    const app = express();
    app.use(buildApiServerTimingMiddleware(null));
    app.get('/dyn-404', (_req, res) => {
      const acc = (res.locals as Record<string, unknown>).serverTiming as ServerTimingAccumulator;
      acc.measure('db', 4);
      res.status(404).json({ error: 'nope' });
    });
    const r = await request(app).get('/dyn-404');
    assertEq('dynamic on 4xx · header emitted', r.headers['server-timing'], 'db;dur=4');
    assertEq('dynamic on 4xx · status preserved', r.status, 404);
  }

  // (bg) dynamic-only emits on 5xx status
  {
    const app = express();
    app.use(buildApiServerTimingMiddleware(null));
    app.get('/dyn-500', (_req, res) => {
      const acc = (res.locals as Record<string, unknown>).serverTiming as ServerTimingAccumulator;
      acc.measure('db', 9);
      res.status(500).json({ error: 'boom' });
    });
    const r = await request(app).get('/dyn-500');
    assertEq('dynamic on 5xx · header emitted', r.headers['server-timing'], 'db;dur=9');
  }

  // (bh) tchar full-set canonical valid for dynamic name too
  {
    const app = buildDynApp(null, (acc) => {
      acc.measure("d!#$%&'*+.^_`|~-9Z", 1);
    });
    const r = await request(app).get('/dyn');
    assertEq('dynamic tchar full-set valid', r.headers['server-timing'], "d!#$%&'*+.^_`|~-9Z;dur=1");
  }

  // (bi) nested start()/stop() records both scopes
  {
    const app = buildDynApp(null, async (acc) => {
      const outer = acc.start('outer');
      await delay(4);
      const inner = acc.start('inner');
      await delay(4);
      inner();
      outer();
    });
    const r = await request(app).get('/dyn');
    const h = r.headers['server-timing'] as string | undefined;
    assertTrue('nested scopes · both emitted in stop-order', typeof h === 'string' && /^inner;dur=\d+\.\d+, outer;dur=\d+\.\d+$/.test(h ?? ''), `got: ${h}`);
  }

  // (bj) measure() after writeHead is a no-op vs header (write already flushed)
  //  — we don't test post-flush behavior here since express handlers run
  //    before writeHead; instead we assert size still records for
  //    introspection (accumulator remains usable).
  {
    let sizeAfter = -1;
    const app = express();
    app.use(buildApiServerTimingMiddleware(null));
    app.get('/dyn-late', (_req, res) => {
      const acc = (res.locals as Record<string, unknown>).serverTiming as ServerTimingAccumulator;
      acc.measure('early', 1);
      res.status(200).json({ ok: true });
      // record after send — accumulator itself still functional
      acc.measure('late', 2);
      sizeAfter = acc.size;
    });
    const r = await request(app).get('/dyn-late');
    // Only the 'early' metric appears in the header (writeHead flush point).
    assertEq('measure before send · emitted', r.headers['server-timing'], 'early;dur=1');
    assertEq('accumulator remains functional post-send', sizeAfter, 2);
  }

  console.log(`\n=== api-server-timing: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
