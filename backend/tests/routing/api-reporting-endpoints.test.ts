/**
 * api-reporting-endpoints.test.ts — ADR-0010 §4.11 · W3C Reporting API L1
 * (Working Draft · Ilya Grigorik + Douglas Creager) browser error-reporting
 * endpoint declaration advisory header echo behavior.
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-reporting-endpoints.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  buildApiReportingEndpointsMiddleware,
  apiReportingEndpointsMiddleware,
  CURRENT_REPORTING_ENDPOINTS_CONFIG,
  ReportingEndpointsConfig,
  ReportingEndpoint,
  isValidReportingEndpoint,
  formatReportingEndpoints,
  formatReportTo,
} from '../../src/middlewares/apiReportingEndpoints';
import { buildApiServerTimingMiddleware } from '../../src/middlewares/apiServerTiming';
import { buildApiTimingAllowOriginMiddleware } from '../../src/middlewares/apiTimingAllowOrigin';
import { buildApiTraceContextMiddleware } from '../../src/middlewares/apiTraceContext';
import { buildApiWebLinkingMiddleware } from '../../src/middlewares/apiWebLinking';

function buildApp(config: ReportingEndpointsConfig | null): express.Express {
  const app = express();
  app.use(buildApiReportingEndpointsMiddleware(config));
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/notfound', (_req, res) => res.status(404).json({ error: 'not_found' }));
  app.get('/server-error', (_req, res) => res.status(500).json({ error: 'server_error' }));
  app.get('/preset-re', (_req, res) => {
    res.setHeader('Reporting-Endpoints', 'preset-key="/route/preset"');
    res.status(200).json({ ok: true, preset: 're' });
  });
  app.get('/preset-rt', (_req, res) => {
    res.setHeader('Report-To', '{"group":"route","max_age":60,"endpoints":[{"url":"/rt/route"}]}');
    res.status(200).json({ ok: true, preset: 'rt' });
  });
  return app;
}

function buildQuintupleApp(reConfig: ReportingEndpointsConfig | null): express.Express {
  // Compose §4.7 + §4.8 + §4.9 + §4.10 + §4.11 canonical quintuple
  // observability + hypermedia + reporting family.
  const app = express();
  app.use(buildApiServerTimingMiddleware({ static_metrics: [{ name: 'app' }] }));
  app.use(buildApiTimingAllowOriginMiddleware({ allow_all: true }));
  app.use(buildApiTraceContextMiddleware({ echo_traceparent: true }));
  app.use(buildApiWebLinkingMiddleware({
    static_links: [{ uri: '/api/v1/openapi.json', rel: 'describedby' }],
  }));
  app.use(buildApiReportingEndpointsMiddleware(reConfig));
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
    assertAbsent('null config · no Reporting-Endpoints', r.headers, 'Reporting-Endpoints');
    assertAbsent('null config · no Report-To', r.headers, 'Report-To');
  }

  // (b) empty config → zero-emit
  {
    const app = buildApp({});
    const r = await request(app).get('/ping');
    assertAbsent('empty config · no Reporting-Endpoints', r.headers, 'Reporting-Endpoints');
    assertAbsent('empty config · no Report-To', r.headers, 'Report-To');
    assertEq('empty config · downstream reached', r.status, 200);
  }

  // (c) endpoints=[] → zero-emit
  {
    const app = buildApp({ endpoints: [] });
    const r = await request(app).get('/ping');
    assertAbsent('empty endpoints · no Reporting-Endpoints', r.headers, 'Reporting-Endpoints');
  }

  // (d) all-invalid endpoints → zero-emit (fail-OPEN)
  {
    const app = buildApp({
      endpoints: [
        { name: '', url: '/x' } as ReportingEndpoint,
        { name: 'x', url: '' } as ReportingEndpoint,
      ],
    });
    const r = await request(app).get('/ping');
    assertAbsent('all-invalid endpoints · no header (fail-OPEN)', r.headers, 'Reporting-Endpoints');
  }

  // (e) single valid endpoint → canonical Reporting-Endpoints emit
  {
    const app = buildApp({
      endpoints: [{ name: 'default', url: '/api/v1/reports/default' }],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'single endpoint · canonical name="url"',
      r.headers['reporting-endpoints'],
      'default="/api/v1/reports/default"',
    );
    assertAbsent('single endpoint · legacy_report_to default false · no Report-To', r.headers, 'Report-To');
  }

  // (f) multiple endpoints → comma-joined per RFC 8941 §3.2 dictionary
  {
    const app = buildApp({
      endpoints: [
        { name: 'default', url: '/api/v1/reports/default' },
        { name: 'csp-endpoint', url: '/api/v1/reports/csp' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'multi endpoint · comma-joined dictionary',
      r.headers['reporting-endpoints'],
      'default="/api/v1/reports/default", csp-endpoint="/api/v1/reports/csp"',
    );
  }

  // (g) legacy_report_to=true → both headers emit
  {
    const app = buildApp({
      endpoints: [{ name: 'default', url: '/api/v1/reports/x' }],
      legacy_report_to: true,
    });
    const r = await request(app).get('/ping');
    assertContains('legacy_report_to · Reporting-Endpoints present', r.headers['reporting-endpoints'], 'default="/api/v1/reports/x"');
    assertContains('legacy_report_to · Report-To group', r.headers['report-to'], '"group":"default"');
    assertContains('legacy_report_to · Report-To max_age default 86400', r.headers['report-to'], '"max_age":86400');
    assertContains('legacy_report_to · Report-To endpoints url', r.headers['report-to'], '"url":"/api/v1/reports/x"');
  }

  // (h) legacy_report_to=false → only Reporting-Endpoints
  {
    const app = buildApp({
      endpoints: [{ name: 'default', url: '/api/v1/reports/x' }],
      legacy_report_to: false,
    });
    const r = await request(app).get('/ping');
    assertContains('legacy=false · Reporting-Endpoints', r.headers['reporting-endpoints'], 'default');
    assertAbsent('legacy=false · Report-To absent', r.headers, 'Report-To');
  }

  // (i) max_age custom emission
  {
    const app = buildApp({
      endpoints: [{ name: 'default', url: '/api/v1/reports/x' }],
      legacy_report_to: true,
      max_age: 3600,
    });
    const r = await request(app).get('/ping');
    assertContains('max_age=3600 emitted', r.headers['report-to'], '"max_age":3600');
  }

  // (j) max_age default 86400 emission (unset)
  {
    const app = buildApp({
      endpoints: [{ name: 'default', url: '/api/v1/reports/x' }],
      legacy_report_to: true,
    });
    const r = await request(app).get('/ping');
    assertContains('max_age default 86400', r.headers['report-to'], '"max_age":86400');
  }

  // (k) max_age negative → default clamp
  {
    const app = buildApp({
      endpoints: [{ name: 'default', url: '/x' }],
      legacy_report_to: true,
      max_age: -50,
    });
    const r = await request(app).get('/ping');
    assertContains('max_age negative · default 86400 clamp', r.headers['report-to'], '"max_age":86400');
  }

  // (l) max_age hard-cap 30 days
  {
    const app = buildApp({
      endpoints: [{ name: 'default', url: '/x' }],
      legacy_report_to: true,
      max_age: 100 * 86400,
    });
    const r = await request(app).get('/ping');
    assertContains('max_age hard-cap 30 days', r.headers['report-to'], `"max_age":${30 * 86400}`);
  }

  // (m) invalid name (empty) → dropped
  {
    const app = buildApp({
      endpoints: [
        { name: '', url: '/a' } as ReportingEndpoint,
        { name: 'ok', url: '/b' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('empty name · dropped', r.headers['reporting-endpoints'], 'ok="/b"');
  }

  // (n) invalid name (SP · non-token) → dropped
  {
    const app = buildApp({
      endpoints: [
        { name: 'has space', url: '/a' },
        { name: 'ok', url: '/b' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('name with SP · dropped', r.headers['reporting-endpoints'], 'ok="/b"');
  }

  // (o) invalid url (empty) → dropped
  {
    const app = buildApp({
      endpoints: [
        { name: 'a', url: '' } as ReportingEndpoint,
        { name: 'b', url: '/b' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('empty url · dropped', r.headers['reporting-endpoints'], 'b="/b"');
  }

  // (p) invalid url (contains DQUOTE) → dropped
  {
    const app = buildApp({
      endpoints: [
        { name: 'a', url: '/bad"path' },
        { name: 'b', url: '/b' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('url with DQUOTE · dropped', r.headers['reporting-endpoints'], 'b="/b"');
  }

  // (q) invalid url (contains angle-bracket) → dropped
  {
    const app = buildApp({
      endpoints: [
        { name: 'a', url: '/bad<path' },
        { name: 'b', url: '/b' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('url with angle · dropped', r.headers['reporting-endpoints'], 'b="/b"');
  }

  // (r) invalid url (control char) → dropped
  {
    const app = buildApp({
      endpoints: [
        { name: 'a', url: '/bad\x01path' },
        { name: 'b', url: '/b' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('url with control char · dropped', r.headers['reporting-endpoints'], 'b="/b"');
  }

  // (s) non-string types → dropped
  {
    const app = buildApp({
      endpoints: [
        { name: 42 as unknown as string, url: '/a' },
        { name: 'b', url: 99 as unknown as string },
        { name: 'ok', url: '/ok' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('non-string · dropped', r.headers['reporting-endpoints'], 'ok="/ok"');
  }

  // (t) route pre-sets Reporting-Endpoints → middleware APPENDS
  {
    const app = buildApp({
      endpoints: [{ name: 'appended', url: '/api/v1/reports/appended' }],
    });
    const r = await request(app).get('/preset-re');
    assertEq(
      'route pre-set Reporting-Endpoints · APPEND canonical',
      r.headers['reporting-endpoints'],
      'preset-key="/route/preset", appended="/api/v1/reports/appended"',
    );
  }

  // (u) route pre-sets Report-To → middleware APPENDS
  {
    const app = buildApp({
      endpoints: [{ name: 'default', url: '/api/v1/reports/x' }],
      legacy_report_to: true,
    });
    const r = await request(app).get('/preset-rt');
    const rt = r.headers['report-to'] as string;
    assertContains('route pre-set Report-To · preserved', rt, '"group":"route"');
    assertContains('route pre-set Report-To · advisory appended', rt, '"group":"default"');
  }

  // (v) applies uniformly on 2xx/4xx/5xx
  {
    const app = buildApp({ endpoints: [{ name: 'x', url: '/x' }] });
    const r200 = await request(app).get('/ping');
    const r404 = await request(app).get('/notfound');
    const r500 = await request(app).get('/server-error');
    assertContains('2xx · emit', r200.headers['reporting-endpoints'], 'x="/x"');
    assertContains('4xx · emit', r404.headers['reporting-endpoints'], 'x="/x"');
    assertContains('5xx · emit', r500.headers['reporting-endpoints'], 'x="/x"');
    assertEq('4xx status preserved', r404.status, 404);
    assertEq('5xx status preserved', r500.status, 500);
  }

  // (w) concurrent requests · per-request isolation
  {
    const app = buildApp({ endpoints: [{ name: 'x', url: '/x' }] });
    const [rA, rB, rC] = await Promise.all([
      request(app).get('/ping'),
      request(app).get('/notfound'),
      request(app).get('/preset-re'),
    ]);
    assertContains('concurrent A', rA.headers['reporting-endpoints'], 'x="/x"');
    assertContains('concurrent B', rB.headers['reporting-endpoints'], 'x="/x"');
    assertEq(
      'concurrent C · route preset + append',
      rC.headers['reporting-endpoints'],
      'preset-key="/route/preset", x="/x"',
    );
  }

  // (x) §4.7+§4.8+§4.9+§4.10+§4.11 canonical QUINTUPLE coexist
  {
    const app = buildQuintupleApp({
      endpoints: [{ name: 'default', url: '/api/v1/reports/default' }],
    });
    const r = await request(app)
      .get('/ping')
      .set('Origin', 'https://any.example')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    assertEq('quintuple · Server-Timing', r.headers['server-timing'], 'app');
    assertEq('quintuple · TAO', r.headers['timing-allow-origin'], '*');
    assertEq(
      'quintuple · traceparent',
      r.headers['traceparent'],
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );
    assertEq(
      'quintuple · Link',
      r.headers['link'],
      '</api/v1/openapi.json>; rel="describedby"',
    );
    assertEq(
      'quintuple · Reporting-Endpoints',
      r.headers['reporting-endpoints'],
      'default="/api/v1/reports/default"',
    );
  }

  // (y) quintuple · null RE config → other four still emit
  {
    const app = buildQuintupleApp(null);
    const r = await request(app).get('/ping').set('Origin', 'https://any.example');
    assertEq('quintuple null RE · Server-Timing still emits', r.headers['server-timing'], 'app');
    assertEq('quintuple null RE · TAO still emits', r.headers['timing-allow-origin'], '*');
    assertContains('quintuple null RE · Link still emits', r.headers['link'], 'rel="describedby"');
    assertAbsent('quintuple null RE · Reporting-Endpoints absent', r.headers, 'Reporting-Endpoints');
  }

  // (z) next() 100% called · downstream body reached
  {
    const app = buildApp({ endpoints: [{ name: 'x', url: '/x' }] });
    const r = await request(app).get('/ping');
    assertEq('next() called · body reached', r.body, { ok: true });
  }

  // (aa) factory returns function · pkg-level default null
  {
    assertTrue('apiReportingEndpointsMiddleware() returns function', typeof apiReportingEndpointsMiddleware() === 'function');
    assertEq('pkg default · CURRENT_REPORTING_ENDPOINTS_CONFIG null', CURRENT_REPORTING_ENDPOINTS_CONFIG, null);
  }

  // (ab) isValidReportingEndpoint standalone helper canonical vectors
  {
    assertTrue('isValid: minimal valid', isValidReportingEndpoint({ name: 'x', url: '/x' }));
    assertTrue('isValid: null → false', !isValidReportingEndpoint(null));
    assertTrue('isValid: undefined → false', !isValidReportingEndpoint(undefined));
    assertTrue('isValid: not object → false', !isValidReportingEndpoint('x'));
    assertTrue('isValid: empty name → false', !isValidReportingEndpoint({ name: '', url: '/x' }));
    assertTrue('isValid: name SP → false', !isValidReportingEndpoint({ name: 'a b', url: '/x' }));
    assertTrue('isValid: name control → false', !isValidReportingEndpoint({ name: 'a\x01b', url: '/x' }));
    assertTrue('isValid: empty url → false', !isValidReportingEndpoint({ name: 'x', url: '' }));
    assertTrue('isValid: url DQUOTE → false', !isValidReportingEndpoint({ name: 'x', url: '/a"b' }));
    assertTrue('isValid: url < → false', !isValidReportingEndpoint({ name: 'x', url: '/a<b' }));
    assertTrue('isValid: url > → false', !isValidReportingEndpoint({ name: 'x', url: '/a>b' }));
    assertTrue('isValid: url control → false', !isValidReportingEndpoint({ name: 'x', url: '/a\x01b' }));
    assertTrue('isValid: non-string name → false', !isValidReportingEndpoint({ name: 42, url: '/x' }));
    assertTrue('isValid: non-string url → false', !isValidReportingEndpoint({ name: 'x', url: 99 }));
    assertTrue('isValid: name with . _ - allowed', isValidReportingEndpoint({ name: 'a.b_c-d', url: '/x' }));
  }

  // (ac) formatReportingEndpoints standalone canonical vectors
  {
    assertEq(
      'format: single',
      formatReportingEndpoints([{ name: 'x', url: '/x' }]),
      'x="/x"',
    );
    assertEq(
      'format: multi',
      formatReportingEndpoints([
        { name: 'a', url: '/a' },
        { name: 'b', url: '/b' },
      ]),
      'a="/a", b="/b"',
    );
    assertEq(
      'format: empty',
      formatReportingEndpoints([]),
      '',
    );
  }

  // (ad) formatReportTo standalone canonical vectors
  {
    const rt = formatReportTo([{ name: 'ignored', url: '/x' }], 3600);
    const parsed = JSON.parse(rt);
    assertEq('formatReportTo · group default', parsed.group, 'default');
    assertEq('formatReportTo · max_age', parsed.max_age, 3600);
    assertEq('formatReportTo · endpoints[0].url', parsed.endpoints[0].url, '/x');
  }

  // (ae) mix valid + invalid → only valid emitted
  {
    const app = buildApp({
      endpoints: [
        { name: 'a', url: '/a' },
        { name: '', url: '/skip' } as ReportingEndpoint,
        { name: 'b', url: '/b' },
        { name: 'bad space', url: '/skip2' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'mix valid/invalid · only valid emitted',
      r.headers['reporting-endpoints'],
      'a="/a", b="/b"',
    );
  }

  // (af) legacy_report_to omitted → default off (no Report-To)
  {
    const app = buildApp({ endpoints: [{ name: 'x', url: '/x' }] });
    const r = await request(app).get('/ping');
    assertContains('legacy omitted · Reporting-Endpoints emit', r.headers['reporting-endpoints'], 'x="/x"');
    assertAbsent('legacy omitted · no Report-To', r.headers, 'Report-To');
  }

  // (ag) large endpoint set (10 endpoints) coalesced
  {
    const eps = Array.from({ length: 10 }, (_, i) => ({ name: `ep${i}`, url: `/reports/${i}` }));
    const app = buildApp({ endpoints: eps });
    const r = await request(app).get('/ping');
    const val = r.headers['reporting-endpoints'] as string;
    for (let i = 0; i < 10; i++) {
      assertContains(`large-set ep${i} present`, val, `ep${i}="/reports/${i}"`);
    }
  }

  console.log(`\n=== api-reporting-endpoints: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
