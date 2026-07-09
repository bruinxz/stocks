/**
 * api-timing-allow-origin.test.ts — ADR-0010 §4.8 · W3C Server-Timing Level 1
 * §3 "Timing-Allow-Origin" (CR 25-May-2022) cross-origin observation header.
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-timing-allow-origin.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  buildApiTimingAllowOriginMiddleware,
  apiTimingAllowOriginMiddleware,
  CURRENT_TAO_CONFIG,
  TimingAllowOriginConfig,
} from '../../src/middlewares/apiTimingAllowOrigin';
import { buildApiServerTimingMiddleware } from '../../src/middlewares/apiServerTiming';

function buildApp(config: TimingAllowOriginConfig | null): express.Express {
  const app = express();
  app.use(buildApiTimingAllowOriginMiddleware(config));
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/notfound', (_req, res) => res.status(404).json({ error: 'not_found' }));
  app.get('/server-error', (_req, res) => res.status(500).json({ error: 'server_error' }));
  app.get('/preset', (_req, res) => {
    res.setHeader('Timing-Allow-Origin', 'https://route-owned.example');
    res.status(200).json({ ok: true, preset: true });
  });
  return app;
}

function buildCombinedApp(taoConfig: TimingAllowOriginConfig | null): express.Express {
  // Compose §4.7 + §4.8 canonical pair (Server-Timing + Timing-Allow-Origin)
  const app = express();
  app.use(buildApiServerTimingMiddleware({ static_metrics: [{ name: 'app' }] }));
  app.use(buildApiTimingAllowOriginMiddleware(taoConfig));
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
  // (a) null config → zero-emit · downstream reached
  {
    const app = buildApp(null);
    const r = await request(app).get('/ping').set('Origin', 'https://example.com');
    assertEq('null config · status 200', r.status, 200);
    assertAbsent('null config · no Timing-Allow-Origin', r.headers, 'Timing-Allow-Origin');
  }

  // (b) empty config object → zero-emit
  {
    const app = buildApp({});
    const r = await request(app).get('/ping').set('Origin', 'https://example.com');
    assertAbsent('empty config · no header', r.headers, 'Timing-Allow-Origin');
    assertEq('empty config · downstream reached', r.status, 200);
  }

  // (c) allow_all=false + empty allowlist → zero-emit
  {
    const app = buildApp({ allow_all: false, allowlist: [] });
    const r = await request(app).get('/ping').set('Origin', 'https://example.com');
    assertAbsent('allow_all=false + empty allowlist · no header', r.headers, 'Timing-Allow-Origin');
  }

  // (d) allow_all=true → wildcard on every response · regardless of Origin
  {
    const app = buildApp({ allow_all: true });
    const r = await request(app).get('/ping').set('Origin', 'https://any.example');
    assertEq('allow_all=true · Timing-Allow-Origin: *', r.headers['timing-allow-origin'], '*');
  }

  // (e) allow_all=true · no Origin request header still emits *
  {
    const app = buildApp({ allow_all: true });
    const r = await request(app).get('/ping');
    assertEq('allow_all=true · no Origin req · still emits *', r.headers['timing-allow-origin'], '*');
  }

  // (f) allowlist match → echo matched origin verbatim
  {
    const app = buildApp({ allowlist: ['https://raft-frontend.example.com', 'https://staging.raft.example.com'] });
    const r = await request(app).get('/ping').set('Origin', 'https://raft-frontend.example.com');
    assertEq('allowlist match · echo origin', r.headers['timing-allow-origin'], 'https://raft-frontend.example.com');
  }

  // (g) allowlist match · second entry
  {
    const app = buildApp({ allowlist: ['https://raft-frontend.example.com', 'https://staging.raft.example.com'] });
    const r = await request(app).get('/ping').set('Origin', 'https://staging.raft.example.com');
    assertEq('allowlist match · second entry echoed', r.headers['timing-allow-origin'], 'https://staging.raft.example.com');
  }

  // (h) allowlist miss → zero-emit
  {
    const app = buildApp({ allowlist: ['https://raft-frontend.example.com'] });
    const r = await request(app).get('/ping').set('Origin', 'https://evil.example');
    assertAbsent('allowlist miss · no header', r.headers, 'Timing-Allow-Origin');
  }

  // (i) allowlist non-empty · missing Origin request header → zero-emit
  {
    const app = buildApp({ allowlist: ['https://raft-frontend.example.com'] });
    const r = await request(app).get('/ping');
    assertAbsent('missing Origin req · no header', r.headers, 'Timing-Allow-Origin');
  }

  // (j) allow_all=true + allowlist populated → wildcard wins (allow_all shortcut)
  {
    const app = buildApp({ allow_all: true, allowlist: ['https://raft-frontend.example.com'] });
    const r = await request(app).get('/ping').set('Origin', 'https://raft-frontend.example.com');
    assertEq('allow_all=true + allowlist · * shortcut wins', r.headers['timing-allow-origin'], '*');
  }

  // (k) route pre-sets Timing-Allow-Origin → middleware does NOT overwrite
  {
    const app = buildApp({ allow_all: true });
    const r = await request(app).get('/preset').set('Origin', 'https://any.example');
    assertEq('route pre-set preserved (route authority)', r.headers['timing-allow-origin'], 'https://route-owned.example');
  }

  // (l) applies uniformly on 2xx / 4xx / 5xx
  {
    const app = buildApp({ allow_all: true });
    const r200 = await request(app).get('/ping');
    const r404 = await request(app).get('/notfound');
    const r500 = await request(app).get('/server-error');
    assertEq('2xx · header emitted', r200.headers['timing-allow-origin'], '*');
    assertEq('4xx · header emitted', r404.headers['timing-allow-origin'], '*');
    assertEq('5xx · header emitted', r500.headers['timing-allow-origin'], '*');
    assertEq('4xx · status preserved', r404.status, 404);
    assertEq('5xx · status preserved', r500.status, 500);
  }

  // (m) allowlist exact match · scheme mismatch → miss (http vs https)
  {
    const app = buildApp({ allowlist: ['https://raft-frontend.example.com'] });
    const r = await request(app).get('/ping').set('Origin', 'http://raft-frontend.example.com');
    assertAbsent('scheme mismatch (http vs https) · miss', r.headers, 'Timing-Allow-Origin');
  }

  // (n) allowlist exact match · port mismatch → miss
  {
    const app = buildApp({ allowlist: ['https://raft-frontend.example.com'] });
    const r = await request(app).get('/ping').set('Origin', 'https://raft-frontend.example.com:8443');
    assertAbsent('port mismatch · miss', r.headers, 'Timing-Allow-Origin');
  }

  // (o) allowlist entry with port · exact match hits
  {
    const app = buildApp({ allowlist: ['https://raft-frontend.example.com:8443'] });
    const r = await request(app).get('/ping').set('Origin', 'https://raft-frontend.example.com:8443');
    assertEq('port-qualified allowlist match · echoed', r.headers['timing-allow-origin'], 'https://raft-frontend.example.com:8443');
  }

  // (p) allowlist entry case-sensitive host mismatch → miss (RFC 6454 case-insensitive host per spec but v0 exact match discipline)
  {
    const app = buildApp({ allowlist: ['https://raft-frontend.example.com'] });
    const r = await request(app).get('/ping').set('Origin', 'https://RAFT-FRONTEND.EXAMPLE.COM');
    assertAbsent('case-sensitive host mismatch (v0 exact) · miss', r.headers, 'Timing-Allow-Origin');
  }

  // (q) concurrent requests · per-request independent (no cross-request state leak)
  {
    const app = buildApp({ allowlist: ['https://a.example', 'https://b.example'] });
    const [rA, rB, rC] = await Promise.all([
      request(app).get('/ping').set('Origin', 'https://a.example'),
      request(app).get('/ping').set('Origin', 'https://b.example'),
      request(app).get('/ping').set('Origin', 'https://c.example'),
    ]);
    assertEq('concurrent · req A → echo a', rA.headers['timing-allow-origin'], 'https://a.example');
    assertEq('concurrent · req B → echo b', rB.headers['timing-allow-origin'], 'https://b.example');
    assertAbsent('concurrent · req C (miss) → no header', rC.headers, 'Timing-Allow-Origin');
  }

  // (r) allowlist ignored when passed as non-array (defensive) → zero-emit if allow_all also false
  {
    const app = buildApp({ allowlist: 'not-an-array' as unknown as string[] });
    const r = await request(app).get('/ping').set('Origin', 'https://raft-frontend.example.com');
    assertAbsent('non-array allowlist + allow_all absent · no header', r.headers, 'Timing-Allow-Origin');
  }

  // (s) allow_all string "true" is NOT truthy (strict boolean === true)
  {
    const app = buildApp({ allow_all: 'true' as unknown as boolean });
    const r = await request(app).get('/ping').set('Origin', 'https://any.example');
    assertAbsent('allow_all string "true" · no header (strict boolean check)', r.headers, 'Timing-Allow-Origin');
  }

  // (t) empty string Origin request header → miss
  {
    const app = buildApp({ allowlist: ['https://raft-frontend.example.com'] });
    const r = await request(app).get('/ping').set('Origin', '');
    assertAbsent('empty Origin string · miss', r.headers, 'Timing-Allow-Origin');
  }

  // (u) §4.7 Server-Timing + §4.8 Timing-Allow-Origin canonical pair coexist
  {
    const app = buildCombinedApp({ allow_all: true });
    const r = await request(app).get('/ping').set('Origin', 'https://any.example');
    assertEq('canonical pair · Server-Timing present', r.headers['server-timing'], 'app');
    assertEq('canonical pair · Timing-Allow-Origin: *', r.headers['timing-allow-origin'], '*');
  }

  // (v) canonical pair · TAO allowlist match echoes while Server-Timing emits
  {
    const app = buildCombinedApp({ allowlist: ['https://raft-frontend.example.com'] });
    const r = await request(app).get('/ping').set('Origin', 'https://raft-frontend.example.com');
    assertEq('canonical pair · TAO echo', r.headers['timing-allow-origin'], 'https://raft-frontend.example.com');
    assertEq('canonical pair · Server-Timing still emits', r.headers['server-timing'], 'app');
  }

  // (w) canonical pair · TAO miss preserves Server-Timing (§4.7 orthogonal)
  {
    const app = buildCombinedApp({ allowlist: ['https://raft-frontend.example.com'] });
    const r = await request(app).get('/ping').set('Origin', 'https://evil.example');
    assertAbsent('canonical pair · TAO miss · no TAO header', r.headers, 'Timing-Allow-Origin');
    assertEq('canonical pair · Server-Timing unaffected by TAO miss', r.headers['server-timing'], 'app');
  }

  // (x) next() 100% called · downstream body reached
  {
    const app = buildApp({ allow_all: true });
    const r = await request(app).get('/ping');
    assertEq('next() called · body reached', r.body, { ok: true });
  }

  // (y) factory returns function
  {
    assertTrue('apiTimingAllowOriginMiddleware() returns function', typeof apiTimingAllowOriginMiddleware() === 'function');
  }

  // (z) pkg-level default null (no api_timing_allow_origin block in package.json)
  {
    assertEq('pkg default · CURRENT_TAO_CONFIG null', CURRENT_TAO_CONFIG, null);
  }

  // (aa) allow_all=true · consecutive requests · each independent · all *
  {
    const app = buildApp({ allow_all: true });
    for (let i = 0; i < 3; i++) {
      const r = await request(app).get('/ping');
      assertEq(`allow_all=true · req ${i + 1} · *`, r.headers['timing-allow-origin'], '*');
    }
  }

  // (ab) allowlist array with single entry (edge-case minimum)
  {
    const app = buildApp({ allowlist: ['https://only.example'] });
    const r = await request(app).get('/ping').set('Origin', 'https://only.example');
    assertEq('single-entry allowlist match', r.headers['timing-allow-origin'], 'https://only.example');
  }

  // (ac) allowlist entry with trailing slash · Origin without → miss (canonical origin has no path)
  {
    const app = buildApp({ allowlist: ['https://raft-frontend.example.com/'] });
    const r = await request(app).get('/ping').set('Origin', 'https://raft-frontend.example.com');
    assertAbsent('trailing-slash allowlist vs bare Origin · miss', r.headers, 'Timing-Allow-Origin');
  }

  console.log(`\n=== api-timing-allow-origin: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
