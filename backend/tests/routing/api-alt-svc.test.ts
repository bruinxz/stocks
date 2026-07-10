/**
 * api-alt-svc.test.ts — ADR-0010 §4.12 · RFC 7838 HTTP Alternative Services
 * (Apr 2016 · Nottingham + McManus + Reschke · IETF) alternate-transport
 * advertisement advisory header echo behavior.
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-alt-svc.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  buildApiAltSvcMiddleware,
  apiAltSvcMiddleware,
  CURRENT_ALT_SVC_CONFIG,
  AltSvcConfig,
  AltSvcEntry,
  isValidAltSvcEntry,
  clampMa,
  formatAltSvcEntry,
  formatAltSvcServices,
} from '../../src/middlewares/apiAltSvc';
import { buildApiServerTimingMiddleware } from '../../src/middlewares/apiServerTiming';
import { buildApiTimingAllowOriginMiddleware } from '../../src/middlewares/apiTimingAllowOrigin';
import { buildApiTraceContextMiddleware } from '../../src/middlewares/apiTraceContext';
import { buildApiWebLinkingMiddleware } from '../../src/middlewares/apiWebLinking';
import { buildApiReportingEndpointsMiddleware } from '../../src/middlewares/apiReportingEndpoints';

function buildApp(config: AltSvcConfig | null): express.Express {
  const app = express();
  app.use(buildApiAltSvcMiddleware(config));
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/notfound', (_req, res) => res.status(404).json({ error: 'not_found' }));
  app.get('/server-error', (_req, res) => res.status(500).json({ error: 'server_error' }));
  app.get('/preset-altsvc', (_req, res) => {
    res.setHeader('Alt-Svc', 'h2=":8443"; ma=3600');
    res.status(200).json({ ok: true, preset: 'altsvc' });
  });
  return app;
}

function buildSextupleApp(altSvcConfig: AltSvcConfig | null): express.Express {
  // Compose §4.7 + §4.8 + §4.9 + §4.10 + §4.11 + §4.12 canonical SEXTUPLE
  // observability + hypermedia + reporting + transport family.
  const app = express();
  app.use(buildApiServerTimingMiddleware({ static_metrics: [{ name: 'app' }] }));
  app.use(buildApiTimingAllowOriginMiddleware({ allow_all: true }));
  app.use(buildApiTraceContextMiddleware({ echo_traceparent: true }));
  app.use(buildApiWebLinkingMiddleware({
    static_links: [{ uri: '/api/v1/openapi.json', rel: 'describedby' }],
  }));
  app.use(buildApiReportingEndpointsMiddleware({
    endpoints: [{ name: 'default', url: '/api/v1/reports/default' }],
  }));
  app.use(buildApiAltSvcMiddleware(altSvcConfig));
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

function assertContains(label: string, actual: string | string[] | undefined, needle: string): void {
  const s = Array.isArray(actual) ? actual.join(', ') : actual ?? '';
  if (s.indexOf(needle) >= 0) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}\n    expected substr: ${needle}\n    actual:          ${s}`);
  }
}

(async () => {
  // (a) null config → zero-emit · downstream reached
  {
    const app = buildApp(null);
    const r = await request(app).get('/ping');
    assertEq('null config · status 200', r.status, 200);
    assertAbsent('null config · no Alt-Svc', r.headers, 'Alt-Svc');
  }

  // (b) empty config → zero-emit
  {
    const app = buildApp({});
    const r = await request(app).get('/ping');
    assertAbsent('empty config · no Alt-Svc', r.headers, 'Alt-Svc');
    assertEq('empty config · downstream reached', r.status, 200);
  }

  // (c) services=[] → zero-emit
  {
    const app = buildApp({ services: [] });
    const r = await request(app).get('/ping');
    assertAbsent('empty services · no Alt-Svc', r.headers, 'Alt-Svc');
  }

  // (d) all-invalid services → zero-emit (fail-OPEN)
  {
    const app = buildApp({
      services: [
        { protocol_id: '', authority: ':443' } as AltSvcEntry,
        { protocol_id: 'h3', authority: '' } as AltSvcEntry,
      ],
    });
    const r = await request(app).get('/ping');
    assertAbsent('all-invalid services · no Alt-Svc (fail-OPEN)', r.headers, 'Alt-Svc');
  }

  // (e) clear=true → emit "Alt-Svc: clear"
  {
    const app = buildApp({ clear: true });
    const r = await request(app).get('/ping');
    assertEq('clear mode · canonical value', r.headers['alt-svc'], 'clear');
  }

  // (f) single service canonical h3=":443"; ma=86400
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: ':443', ma: 86400 }],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'single service · canonical h3=":443"; ma=86400',
      r.headers['alt-svc'],
      'h3=":443"; ma=86400',
    );
  }

  // (g) multi service comma-joined per RFC 7838 §3
  {
    const app = buildApp({
      services: [
        { protocol_id: 'h3', authority: ':443', ma: 86400 },
        { protocol_id: 'h2', authority: ':443', ma: 86400 },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'multi service · comma-joined',
      r.headers['alt-svc'],
      'h3=":443"; ma=86400, h2=":443"; ma=86400',
    );
  }

  // (h) ma omitted → parameter dropped (no ma= in output)
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: ':443' }],
    });
    const r = await request(app).get('/ping');
    assertEq('ma omitted · no ma param', r.headers['alt-svc'], 'h3=":443"');
  }

  // (i) ma negative → default clamp 86400
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: ':443', ma: -50 }],
    });
    const r = await request(app).get('/ping');
    assertEq('ma negative · default clamp 86400', r.headers['alt-svc'], 'h3=":443"; ma=86400');
  }

  // (j) ma hard-cap 30 days
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: ':443', ma: 100 * 86400 }],
    });
    const r = await request(app).get('/ping');
    assertEq('ma hard-cap 30 days', r.headers['alt-svc'], `h3=":443"; ma=${30 * 86400}`);
  }

  // (k) persist=true emission
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: ':443', ma: 86400, persist: true }],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'persist=true · persist=1 emit',
      r.headers['alt-svc'],
      'h3=":443"; ma=86400; persist=1',
    );
  }

  // (l) persist=false → no persist param
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: ':443', ma: 86400, persist: false }],
    });
    const r = await request(app).get('/ping');
    assertEq('persist=false · no persist param', r.headers['alt-svc'], 'h3=":443"; ma=86400');
  }

  // (m) invalid protocol_id (empty) → dropped
  {
    const app = buildApp({
      services: [
        { protocol_id: '', authority: ':443' } as AltSvcEntry,
        { protocol_id: 'h3', authority: ':443' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('empty protocol_id · dropped', r.headers['alt-svc'], 'h3=":443"');
  }

  // (n) invalid protocol_id (SP · non-token) → dropped
  {
    const app = buildApp({
      services: [
        { protocol_id: 'has space', authority: ':443' },
        { protocol_id: 'h3', authority: ':443' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('protocol_id with SP · dropped', r.headers['alt-svc'], 'h3=":443"');
  }

  // (o) invalid authority (empty) → dropped
  {
    const app = buildApp({
      services: [
        { protocol_id: 'h3', authority: '' } as AltSvcEntry,
        { protocol_id: 'h2', authority: ':443' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('empty authority · dropped', r.headers['alt-svc'], 'h2=":443"');
  }

  // (p) invalid authority (DQUOTE) → dropped
  {
    const app = buildApp({
      services: [
        { protocol_id: 'h3', authority: ':443"break' },
        { protocol_id: 'h2', authority: ':443' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('authority with DQUOTE · dropped', r.headers['alt-svc'], 'h2=":443"');
  }

  // (q) invalid authority (control char) → dropped
  {
    const app = buildApp({
      services: [
        { protocol_id: 'h3', authority: ':443\x01' },
        { protocol_id: 'h2', authority: ':443' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('authority with control char · dropped', r.headers['alt-svc'], 'h2=":443"');
  }

  // (r) invalid authority (comma) → dropped
  {
    const app = buildApp({
      services: [
        { protocol_id: 'h3', authority: ':443,break' },
        { protocol_id: 'h2', authority: ':443' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('authority with comma · dropped', r.headers['alt-svc'], 'h2=":443"');
  }

  // (s) invalid authority (backslash) → dropped
  {
    const app = buildApp({
      services: [
        { protocol_id: 'h3', authority: ':443\\break' },
        { protocol_id: 'h2', authority: ':443' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('authority with backslash · dropped', r.headers['alt-svc'], 'h2=":443"');
  }

  // (t) non-string types → dropped
  {
    const app = buildApp({
      services: [
        { protocol_id: 42 as unknown as string, authority: ':443' },
        { protocol_id: 'h3', authority: 99 as unknown as string },
        { protocol_id: 'h2', authority: ':443' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('non-string · dropped', r.headers['alt-svc'], 'h2=":443"');
  }

  // (u) route pre-sets Alt-Svc → middleware APPENDS
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: ':443', ma: 86400 }],
    });
    const r = await request(app).get('/preset-altsvc');
    assertEq(
      'route pre-set Alt-Svc · APPEND canonical',
      r.headers['alt-svc'],
      'h2=":8443"; ma=3600, h3=":443"; ma=86400',
    );
  }

  // (v) applies uniformly on 2xx/4xx/5xx
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: ':443' }],
    });
    const r200 = await request(app).get('/ping');
    const r404 = await request(app).get('/notfound');
    const r500 = await request(app).get('/server-error');
    assertEq('2xx · emit', r200.headers['alt-svc'], 'h3=":443"');
    assertEq('4xx · emit', r404.headers['alt-svc'], 'h3=":443"');
    assertEq('5xx · emit', r500.headers['alt-svc'], 'h3=":443"');
    assertEq('4xx status preserved', r404.status, 404);
    assertEq('5xx status preserved', r500.status, 500);
  }

  // (w) concurrent requests · per-request isolation
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: ':443' }],
    });
    const [rA, rB, rC] = await Promise.all([
      request(app).get('/ping'),
      request(app).get('/notfound'),
      request(app).get('/preset-altsvc'),
    ]);
    assertEq('concurrent A', rA.headers['alt-svc'], 'h3=":443"');
    assertEq('concurrent B', rB.headers['alt-svc'], 'h3=":443"');
    assertEq(
      'concurrent C · route preset + append',
      rC.headers['alt-svc'],
      'h2=":8443"; ma=3600, h3=":443"',
    );
  }

  // (x) §4.7+§4.8+§4.9+§4.10+§4.11+§4.12 canonical SEXTUPLE coexist
  {
    const app = buildSextupleApp({
      services: [{ protocol_id: 'h3', authority: ':443', ma: 86400 }],
    });
    const r = await request(app)
      .get('/ping')
      .set('Origin', 'https://any.example')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    assertEq('sextuple · Server-Timing', r.headers['server-timing'], 'app');
    assertEq('sextuple · TAO', r.headers['timing-allow-origin'], '*');
    assertEq(
      'sextuple · traceparent',
      r.headers['traceparent'],
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );
    assertEq(
      'sextuple · Link',
      r.headers['link'],
      '</api/v1/openapi.json>; rel="describedby"',
    );
    assertEq(
      'sextuple · Reporting-Endpoints',
      r.headers['reporting-endpoints'],
      'default="/api/v1/reports/default"',
    );
    assertEq(
      'sextuple · Alt-Svc',
      r.headers['alt-svc'],
      'h3=":443"; ma=86400',
    );
  }

  // (y) sextuple · null Alt-Svc config → other five still emit
  {
    const app = buildSextupleApp(null);
    const r = await request(app).get('/ping').set('Origin', 'https://any.example');
    assertEq('sextuple null AS · Server-Timing still emits', r.headers['server-timing'], 'app');
    assertEq('sextuple null AS · TAO still emits', r.headers['timing-allow-origin'], '*');
    assertContains('sextuple null AS · Link still emits', r.headers['link'], 'rel="describedby"');
    assertContains(
      'sextuple null AS · Reporting-Endpoints still emits',
      r.headers['reporting-endpoints'],
      'default=',
    );
    assertAbsent('sextuple null AS · Alt-Svc absent', r.headers, 'Alt-Svc');
  }

  // (z) next() 100% called · downstream body reached
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: ':443' }],
    });
    const r = await request(app).get('/ping');
    assertEq('next() called · body reached', r.body, { ok: true });
  }

  // (aa) factory returns function · pkg-level default null
  {
    assertTrue('apiAltSvcMiddleware() returns function', typeof apiAltSvcMiddleware() === 'function');
    assertEq('pkg default · CURRENT_ALT_SVC_CONFIG null', CURRENT_ALT_SVC_CONFIG, null);
  }

  // (ab) isValidAltSvcEntry standalone helper canonical vectors
  {
    assertTrue('isValid: minimal valid', isValidAltSvcEntry({ protocol_id: 'h3', authority: ':443' }));
    assertTrue('isValid: null → false', !isValidAltSvcEntry(null));
    assertTrue('isValid: undefined → false', !isValidAltSvcEntry(undefined));
    assertTrue('isValid: not object → false', !isValidAltSvcEntry('h3'));
    assertTrue('isValid: empty protocol_id → false', !isValidAltSvcEntry({ protocol_id: '', authority: ':443' }));
    assertTrue('isValid: protocol_id SP → false', !isValidAltSvcEntry({ protocol_id: 'a b', authority: ':443' }));
    assertTrue('isValid: protocol_id control → false', !isValidAltSvcEntry({ protocol_id: 'a\x01b', authority: ':443' }));
    assertTrue('isValid: empty authority → false', !isValidAltSvcEntry({ protocol_id: 'h3', authority: '' }));
    assertTrue('isValid: authority DQUOTE → false', !isValidAltSvcEntry({ protocol_id: 'h3', authority: ':443"x' }));
    assertTrue('isValid: authority control → false', !isValidAltSvcEntry({ protocol_id: 'h3', authority: ':443\x01' }));
    assertTrue('isValid: authority comma → false', !isValidAltSvcEntry({ protocol_id: 'h3', authority: ':443,x' }));
    assertTrue('isValid: authority backslash → false', !isValidAltSvcEntry({ protocol_id: 'h3', authority: ':443\\x' }));
    assertTrue('isValid: non-string protocol_id → false', !isValidAltSvcEntry({ protocol_id: 42, authority: ':443' }));
    assertTrue('isValid: non-string authority → false', !isValidAltSvcEntry({ protocol_id: 'h3', authority: 99 }));
    assertTrue('isValid: http/1.1 (slash) allowed', isValidAltSvcEntry({ protocol_id: 'http/1.1', authority: ':443' }));
    assertTrue('isValid: h2c allowed', isValidAltSvcEntry({ protocol_id: 'h2c', authority: ':443' }));
    assertTrue('isValid: authority host:port allowed', isValidAltSvcEntry({ protocol_id: 'h3', authority: 'alt.example.com:443' }));
  }

  // (ac) clampMa standalone canonical vectors
  {
    assertEq('clampMa: default when undefined', clampMa(undefined), 86400);
    assertEq('clampMa: default when null', clampMa(null), 86400);
    assertEq('clampMa: default when string', clampMa('86400'), 86400);
    assertEq('clampMa: default when NaN', clampMa(NaN), 86400);
    assertEq('clampMa: default when Infinity', clampMa(Infinity), 86400);
    assertEq('clampMa: default when negative', clampMa(-1), 86400);
    assertEq('clampMa: zero preserved', clampMa(0), 0);
    assertEq('clampMa: mid preserved', clampMa(3600), 3600);
    assertEq('clampMa: exact cap preserved', clampMa(30 * 86400), 30 * 86400);
    assertEq('clampMa: over cap → cap', clampMa(30 * 86400 + 1), 30 * 86400);
    assertEq('clampMa: fractional floored', clampMa(3600.7), 3600);
  }

  // (ad) formatAltSvcEntry standalone canonical vectors
  {
    assertEq(
      'format entry: minimal',
      formatAltSvcEntry({ protocol_id: 'h3', authority: ':443' }),
      'h3=":443"',
    );
    assertEq(
      'format entry: with ma',
      formatAltSvcEntry({ protocol_id: 'h3', authority: ':443', ma: 86400 }),
      'h3=":443"; ma=86400',
    );
    assertEq(
      'format entry: with ma + persist',
      formatAltSvcEntry({ protocol_id: 'h3', authority: ':443', ma: 86400, persist: true }),
      'h3=":443"; ma=86400; persist=1',
    );
    assertEq(
      'format entry: ma negative clamps in format',
      formatAltSvcEntry({ protocol_id: 'h3', authority: ':443', ma: -10 }),
      'h3=":443"; ma=86400',
    );
  }

  // (ae) formatAltSvcServices standalone canonical vectors
  {
    assertEq(
      'format services: empty',
      formatAltSvcServices([]),
      '',
    );
    assertEq(
      'format services: single',
      formatAltSvcServices([{ protocol_id: 'h3', authority: ':443' }]),
      'h3=":443"',
    );
    assertEq(
      'format services: multi',
      formatAltSvcServices([
        { protocol_id: 'h3', authority: ':443', ma: 86400 },
        { protocol_id: 'h2', authority: ':443', ma: 86400 },
      ]),
      'h3=":443"; ma=86400, h2=":443"; ma=86400',
    );
  }

  // (af) mix valid + invalid → only valid emitted
  {
    const app = buildApp({
      services: [
        { protocol_id: 'h3', authority: ':443' },
        { protocol_id: '', authority: ':skip' } as AltSvcEntry,
        { protocol_id: 'h2', authority: ':443' },
        { protocol_id: 'bad space', authority: ':skip' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'mix valid/invalid · only valid emitted',
      r.headers['alt-svc'],
      'h3=":443", h2=":443"',
    );
  }

  // (ag) large service set (10 services) coalesced
  {
    const services = Array.from({ length: 10 }, (_, i) => ({
      protocol_id: `p${i}`,
      authority: `:${1000 + i}`,
    }));
    const app = buildApp({ services });
    const r = await request(app).get('/ping');
    const val = r.headers['alt-svc'] as string;
    for (let i = 0; i < 10; i++) {
      assertContains(`large-set p${i} present`, val, `p${i}=":${1000 + i}"`);
    }
  }

  // (ah) clear mode overrides services (services ignored when clear=true)
  {
    const app = buildApp({
      clear: true,
      services: [{ protocol_id: 'h3', authority: ':443' }],
    });
    const r = await request(app).get('/ping');
    assertEq('clear+services · clear wins', r.headers['alt-svc'], 'clear');
  }

  // (ai) authority with host+port allowed
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: 'alt.example.com:443' }],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'authority host:port · emit',
      r.headers['alt-svc'],
      'h3="alt.example.com:443"',
    );
  }

  // (aj) ma=0 preserved (RFC 7838 §3.1 allows ma=0 to advertise no cache)
  {
    const app = buildApp({
      services: [{ protocol_id: 'h3', authority: ':443', ma: 0 }],
    });
    const r = await request(app).get('/ping');
    assertEq('ma=0 preserved', r.headers['alt-svc'], 'h3=":443"; ma=0');
  }

  console.log(`\n=== api-alt-svc: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
