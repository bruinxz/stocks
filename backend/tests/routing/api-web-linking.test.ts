/**
 * api-web-linking.test.ts — ADR-0010 §4.10 · RFC 8288 Web Linking
 * (Oct 2017 · Mark Nottingham · IETF · obsoletes RFC 5988) hypermedia
 * navigation advisory Link header echo behavior.
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-web-linking.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  buildApiWebLinkingMiddleware,
  apiWebLinkingMiddleware,
  CURRENT_WEB_LINKING_CONFIG,
  WebLinkingConfig,
  WebLink,
  isValidWebLink,
  formatLinkValue,
} from '../../src/middlewares/apiWebLinking';
import { buildApiServerTimingMiddleware } from '../../src/middlewares/apiServerTiming';
import { buildApiTimingAllowOriginMiddleware } from '../../src/middlewares/apiTimingAllowOrigin';
import { buildApiTraceContextMiddleware } from '../../src/middlewares/apiTraceContext';

function buildApp(config: WebLinkingConfig | null): express.Express {
  const app = express();
  app.use(buildApiWebLinkingMiddleware(config));
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/notfound', (_req, res) => res.status(404).json({ error: 'not_found' }));
  app.get('/server-error', (_req, res) => res.status(500).json({ error: 'server_error' }));
  app.get('/preset', (_req, res) => {
    res.setHeader('Link', '</api/v1/self>; rel="self"');
    res.status(200).json({ ok: true, preset: true });
  });
  return app;
}

function buildQuadrupleApp(wlConfig: WebLinkingConfig | null): express.Express {
  // Compose §4.7 + §4.8 + §4.9 + §4.10 canonical quadruple observability +
  // hypermedia trio-plus-hypermedia family.
  const app = express();
  app.use(buildApiServerTimingMiddleware({ static_metrics: [{ name: 'app' }] }));
  app.use(buildApiTimingAllowOriginMiddleware({ allow_all: true }));
  app.use(buildApiTraceContextMiddleware({ echo_traceparent: true }));
  app.use(buildApiWebLinkingMiddleware(wlConfig));
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
    assertAbsent('null config · no Link emitted', r.headers, 'Link');
  }

  // (b) empty config object → zero-emit
  {
    const app = buildApp({});
    const r = await request(app).get('/ping');
    assertAbsent('empty config · no Link', r.headers, 'Link');
    assertEq('empty config · downstream reached', r.status, 200);
  }

  // (c) static_links empty array → zero-emit
  {
    const app = buildApp({ static_links: [] });
    const r = await request(app).get('/ping');
    assertAbsent('empty static_links · no Link', r.headers, 'Link');
  }

  // (d) all-invalid static_links → zero-emit (fail-OPEN)
  {
    const app = buildApp({
      static_links: [
        { uri: '', rel: 'help' } as WebLink,
        { uri: '/x', rel: '' } as WebLink,
      ],
    });
    const r = await request(app).get('/ping');
    assertAbsent('all-invalid links · no Link (fail-OPEN)', r.headers, 'Link');
  }

  // (e) single valid link → canonical Link header emit
  {
    const app = buildApp({
      static_links: [{ uri: '/api/v1/openapi.json', rel: 'describedby' }],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'single link · canonical <uri>; rel="rel"',
      r.headers['link'],
      '</api/v1/openapi.json>; rel="describedby"',
    );
  }

  // (f) multiple valid links → comma-joined per RFC 8288 §3 #link-value
  {
    const app = buildApp({
      static_links: [
        { uri: '/api/v1/openapi.json', rel: 'describedby' },
        { uri: '/api/v1/docs', rel: 'help' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'multi link · comma-joined canonical',
      r.headers['link'],
      '</api/v1/openapi.json>; rel="describedby", </api/v1/docs>; rel="help"',
    );
  }

  // (g) link with type param → quoted-string param emission
  {
    const app = buildApp({
      static_links: [
        { uri: '/api/v1/openapi.json', rel: 'describedby', type: 'application/json' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'type param · quoted-string',
      r.headers['link'],
      '</api/v1/openapi.json>; rel="describedby"; type="application/json"',
    );
  }

  // (h) link with title param
  {
    const app = buildApp({
      static_links: [{ uri: '/api/v1/x', rel: 'help', title: 'API help page' }],
    });
    const r = await request(app).get('/ping');
    assertContains('title param present', r.headers['link'], 'title="API help page"');
  }

  // (i) title with DQUOTE / backslash → dropped (safer than escape round-trip)
  {
    const app = buildApp({
      static_links: [
        { uri: '/valid', rel: 'help' },
        { uri: '/x', rel: 'help', title: 'She said "hi"' },
        { uri: '/y', rel: 'help', title: 'back\\slash' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'title with DQUOTE/backslash · dropped (no escape · fail-OPEN)',
      r.headers['link'],
      '</valid>; rel="help"',
    );
  }

  // (j) link with hreflang (RFC 5646 · token-shape) → unquoted token emit
  {
    const app = buildApp({
      static_links: [{ uri: '/x', rel: 'help', hreflang: 'en-US' }],
    });
    const r = await request(app).get('/ping');
    assertContains('hreflang token · unquoted', r.headers['link'], 'hreflang=en-US');
  }

  // (k) link with anchor param → quoted-string
  {
    const app = buildApp({
      static_links: [{ uri: '/x', rel: 'section', anchor: '#chapter-1' }],
    });
    const r = await request(app).get('/ping');
    assertContains('anchor param · quoted', r.headers['link'], 'anchor="#chapter-1"');
  }

  // (l) link with media param → quoted-string
  {
    const app = buildApp({
      static_links: [{ uri: '/print.css', rel: 'stylesheet', media: 'print' }],
    });
    const r = await request(app).get('/ping');
    assertContains('media param · quoted', r.headers['link'], 'media="print"');
  }

  // (m) all params combined
  {
    const app = buildApp({
      static_links: [
        {
          uri: '/api/v1/full',
          rel: 'describedby',
          type: 'application/json',
          title: 'Full API',
          hreflang: 'en',
          anchor: '/api/v1',
          media: 'all',
        },
      ],
    });
    const r = await request(app).get('/ping');
    const lnk = r.headers['link'] as string;
    assertContains('all params · uri', lnk, '</api/v1/full>');
    assertContains('all params · rel', lnk, 'rel="describedby"');
    assertContains('all params · type', lnk, 'type="application/json"');
    assertContains('all params · title', lnk, 'title="Full API"');
    assertContains('all params · hreflang', lnk, 'hreflang=en');
    assertContains('all params · anchor', lnk, 'anchor="/api/v1"');
    assertContains('all params · media', lnk, 'media="all"');
  }

  // (n) invalid uri (contains DQUOTE) → dropped
  {
    const app = buildApp({
      static_links: [
        { uri: '/valid', rel: 'help' },
        { uri: '/bad"path', rel: 'help' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'invalid DQUOTE in uri · dropped',
      r.headers['link'],
      '</valid>; rel="help"',
    );
  }

  // (o) invalid uri (contains angle-bracket) → dropped
  {
    const app = buildApp({
      static_links: [
        { uri: '/valid', rel: 'help' },
        { uri: '/bad<path', rel: 'help' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'invalid <> in uri · dropped',
      r.headers['link'],
      '</valid>; rel="help"',
    );
  }

  // (p) invalid rel (empty) → dropped
  {
    const app = buildApp({
      static_links: [
        { uri: '/x', rel: '' } as WebLink,
        { uri: '/y', rel: 'help' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('empty rel · dropped', r.headers['link'], '</y>; rel="help"');
  }

  // (q) invalid rel (control char) → dropped
  {
    const app = buildApp({
      static_links: [
        { uri: '/x', rel: 'help\x01x' } as WebLink,
        { uri: '/y', rel: 'help' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('control-char in rel · dropped', r.headers['link'], '</y>; rel="help"');
  }

  // (r) invalid param type (non-string) → dropped
  {
    const app = buildApp({
      static_links: [
        { uri: '/x', rel: 'help', type: 123 as unknown as string },
        { uri: '/y', rel: 'help' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq('non-string type · dropped', r.headers['link'], '</y>; rel="help"');
  }

  // (s) route pre-sets Link → middleware appends (RFC 8288 §3 comma-list canonical)
  {
    const app = buildApp({
      static_links: [{ uri: '/api/v1/openapi.json', rel: 'describedby' }],
    });
    const r = await request(app).get('/preset');
    assertEq(
      'route pre-set Link · middleware appends comma-list',
      r.headers['link'],
      '</api/v1/self>; rel="self", </api/v1/openapi.json>; rel="describedby"',
    );
  }

  // (t) applies uniformly on 2xx/4xx/5xx
  {
    const app = buildApp({ static_links: [{ uri: '/x', rel: 'help' }] });
    const r200 = await request(app).get('/ping');
    const r404 = await request(app).get('/notfound');
    const r500 = await request(app).get('/server-error');
    assertContains('2xx · Link emitted', r200.headers['link'], 'rel="help"');
    assertContains('4xx · Link emitted', r404.headers['link'], 'rel="help"');
    assertContains('5xx · Link emitted', r500.headers['link'], 'rel="help"');
    assertEq('4xx status preserved', r404.status, 404);
    assertEq('5xx status preserved', r500.status, 500);
  }

  // (u) concurrent requests · per-request isolation (config is shared but header emit is per-response)
  {
    const app = buildApp({ static_links: [{ uri: '/x', rel: 'help' }] });
    const [rA, rB, rC] = await Promise.all([
      request(app).get('/ping'),
      request(app).get('/notfound'),
      request(app).get('/preset'),
    ]);
    assertContains('concurrent A · Link emit', rA.headers['link'], '</x>');
    assertContains('concurrent B · Link emit', rB.headers['link'], '</x>');
    assertEq(
      'concurrent C · route preset + append',
      rC.headers['link'],
      '</api/v1/self>; rel="self", </x>; rel="help"',
    );
  }

  // (v) §4.7 + §4.8 + §4.9 + §4.10 canonical quadruple coexist
  {
    const app = buildQuadrupleApp({
      static_links: [{ uri: '/api/v1/openapi.json', rel: 'describedby' }],
    });
    const r = await request(app)
      .get('/ping')
      .set('Origin', 'https://any.example')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    assertEq('quadruple · Server-Timing', r.headers['server-timing'], 'app');
    assertEq('quadruple · TAO', r.headers['timing-allow-origin'], '*');
    assertEq(
      'quadruple · traceparent',
      r.headers['traceparent'],
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );
    assertEq(
      'quadruple · Link',
      r.headers['link'],
      '</api/v1/openapi.json>; rel="describedby"',
    );
  }

  // (w) quadruple · null WL config → other three still emit
  {
    const app = buildQuadrupleApp(null);
    const r = await request(app).get('/ping').set('Origin', 'https://any.example');
    assertEq('quadruple null WL · Server-Timing still emits', r.headers['server-timing'], 'app');
    assertEq('quadruple null WL · TAO still emits', r.headers['timing-allow-origin'], '*');
    assertAbsent('quadruple null WL · Link absent', r.headers, 'Link');
  }

  // (x) next() 100% called · downstream body reached
  {
    const app = buildApp({ static_links: [{ uri: '/x', rel: 'help' }] });
    const r = await request(app).get('/ping');
    assertEq('next() called · body reached', r.body, { ok: true });
  }

  // (y) factory returns function · pkg-level default null
  {
    assertTrue('apiWebLinkingMiddleware() returns function', typeof apiWebLinkingMiddleware() === 'function');
    assertEq('pkg default · CURRENT_WEB_LINKING_CONFIG null', CURRENT_WEB_LINKING_CONFIG, null);
  }

  // (z) isValidWebLink standalone helper canonical vectors
  {
    assertTrue('isValid: minimal valid', isValidWebLink({ uri: '/x', rel: 'help' }));
    assertTrue('isValid: all params', isValidWebLink({
      uri: '/x', rel: 'help', type: 't', title: 'T', hreflang: 'en', anchor: '/', media: 'a',
    }));
    assertTrue('isValid: null → false', !isValidWebLink(null));
    assertTrue('isValid: undefined → false', !isValidWebLink(undefined));
    assertTrue('isValid: not object → false', !isValidWebLink('x'));
    assertTrue('isValid: empty uri → false', !isValidWebLink({ uri: '', rel: 'help' }));
    assertTrue('isValid: missing rel → false', !isValidWebLink({ uri: '/x' }));
    assertTrue('isValid: empty rel → false', !isValidWebLink({ uri: '/x', rel: '' }));
    assertTrue('isValid: non-string uri → false', !isValidWebLink({ uri: 42, rel: 'help' }));
    assertTrue('isValid: DQUOTE in uri → false', !isValidWebLink({ uri: '/a"b', rel: 'help' }));
    assertTrue('isValid: < in uri → false', !isValidWebLink({ uri: '/a<b', rel: 'help' }));
    assertTrue('isValid: > in uri → false', !isValidWebLink({ uri: '/a>b', rel: 'help' }));
    assertTrue('isValid: control char in uri → false', !isValidWebLink({ uri: '/a\x01b', rel: 'help' }));
    assertTrue('isValid: non-string param → false', !isValidWebLink({ uri: '/x', rel: 'help', type: 1 }));
    assertTrue('isValid: control char in param → false', !isValidWebLink({ uri: '/x', rel: 'help', title: 'a\x02b' }));
  }

  // (aa) formatLinkValue standalone canonical vectors
  {
    assertEq(
      'format: minimal',
      formatLinkValue({ uri: '/x', rel: 'help' }),
      '</x>; rel="help"',
    );
    assertEq(
      'format: with type',
      formatLinkValue({ uri: '/x', rel: 'help', type: 'text/html' }),
      '</x>; rel="help"; type="text/html"',
    );
    assertEq(
      'format: hreflang non-token · quoted',
      formatLinkValue({ uri: '/x', rel: 'help', hreflang: 'x with space' }),
      '</x>; rel="help"; hreflang="x with space"',
    );
    assertEq(
      'format: hreflang token · unquoted',
      formatLinkValue({ uri: '/x', rel: 'help', hreflang: 'zh-Hans-CN' }),
      '</x>; rel="help"; hreflang=zh-Hans-CN',
    );
  }

  // (ab) config array with mix valid + invalid → only valid emitted
  {
    const app = buildApp({
      static_links: [
        { uri: '/a', rel: 'help' },
        { uri: '', rel: 'help' } as WebLink,
        { uri: '/b', rel: 'section' },
        { uri: '/bad', rel: '' } as WebLink,
      ],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'mix valid/invalid · only valid emitted',
      r.headers['link'],
      '</a>; rel="help", </b>; rel="section"',
    );
  }

  // (ac) rel as URI-shape (RFC 8288 §3.3 extension rel) → quoted-string canonical
  {
    const app = buildApp({
      static_links: [
        { uri: '/x', rel: 'https://example.com/ext/rel' },
      ],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'URI-shape rel · quoted-string canonical',
      r.headers['link'],
      '</x>; rel="https://example.com/ext/rel"',
    );
  }

  // (ad) multi-token rel (space-separated) → single quoted-string canonical
  {
    const app = buildApp({
      static_links: [{ uri: '/x', rel: 'prev next' }],
    });
    const r = await request(app).get('/ping');
    assertEq(
      'multi-token rel · single quoted-string',
      r.headers['link'],
      '</x>; rel="prev next"',
    );
  }

  // (ae) verify RFC 8288 §3 ABNF · complete quoted-string round-trip
  {
    // Emit + regex-parse round-trip: extract rel from `<uri>; rel="value"`
    const app = buildApp({
      static_links: [{ uri: '/api/v1/x', rel: 'describedby', type: 'application/json' }],
    });
    const r = await request(app).get('/ping');
    const lnk = r.headers['link'] as string;
    const relMatch = lnk.match(/rel="([^"]*)"/);
    const typeMatch = lnk.match(/type="([^"]*)"/);
    assertEq('round-trip · rel extract', relMatch?.[1], 'describedby');
    assertEq('round-trip · type extract', typeMatch?.[1], 'application/json');
  }

  console.log(`\n=== api-web-linking: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
