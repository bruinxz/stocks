/**
 * api-deprecation.test.ts — ADR-0010 §4.4 · RFC 9745 Deprecation + RFC 8594 Sunset headers.
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-deprecation.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  buildApiDeprecationMiddleware,
  apiDeprecationMiddleware,
  CURRENT_DEPRECATION_CONFIG,
  DeprecationConfig,
} from '../../src/middlewares/apiDeprecation';

function buildApp(config: DeprecationConfig | null): express.Express {
  const app = express();
  app.use(buildApiDeprecationMiddleware(config));
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
    assertAbsent('null config · no Deprecation header', res.headers, 'Deprecation');
    assertAbsent('null config · no Sunset header', res.headers, 'Sunset');
    assertAbsent('null config · no Link header', res.headers, 'Link');
  }

  // (d) deprecation_ts only
  {
    const res = await request(buildApp({ deprecation_ts: 1723334400 })).get('/ping');
    assertEq('deprecation_ts only · Deprecation = @<ts>', res.headers['deprecation'], '@1723334400');
    assertAbsent('deprecation_ts only · no Sunset', res.headers, 'Sunset');
    assertAbsent('deprecation_ts only · no Link', res.headers, 'Link');
  }

  // (e) sunset_date only
  {
    const res = await request(buildApp({ sunset_date: 'Wed, 11 Nov 2026 00:00:00 GMT' })).get('/ping');
    assertEq('sunset_date only · Sunset = HTTP-date', res.headers['sunset'], 'Wed, 11 Nov 2026 00:00:00 GMT');
    assertAbsent('sunset_date only · no Deprecation', res.headers, 'Deprecation');
    assertAbsent('sunset_date only · no Link', res.headers, 'Link');
  }

  // (f) migration_link only
  {
    const res = await request(buildApp({ migration_link: 'https://example.com/v2-migration' })).get('/ping');
    assertEq(
      'migration_link only · Link rel deprecation+sunset',
      res.headers['link'],
      '<https://example.com/v2-migration>; rel="deprecation", <https://example.com/v2-migration>; rel="sunset"',
    );
    assertAbsent('migration_link only · no Deprecation', res.headers, 'Deprecation');
    assertAbsent('migration_link only · no Sunset', res.headers, 'Sunset');
  }

  // (g) all three
  {
    const res = await request(
      buildApp({
        deprecation_ts: 1723334400,
        sunset_date: 'Wed, 11 Nov 2026 00:00:00 GMT',
        migration_link: 'https://example.com/v2-migration',
      }),
    ).get('/ping');
    assertEq('三-字段 config · Deprecation present', res.headers['deprecation'], '@1723334400');
    assertEq('三-字段 config · Sunset present', res.headers['sunset'], 'Wed, 11 Nov 2026 00:00:00 GMT');
    assertTrue('三-字段 config · Link 双-rel present', typeof res.headers['link'] === 'string' && (res.headers['link'] as string).includes('rel="deprecation"') && (res.headers['link'] as string).includes('rel="sunset"'));
  }

  // (h) NaN deprecation_ts → skip fail-OPEN
  {
    const res = await request(buildApp({ deprecation_ts: NaN })).get('/ping');
    assertAbsent('NaN deprecation_ts · fail-OPEN skip', res.headers, 'Deprecation');
    assertEq('NaN deprecation_ts · downstream reached', res.status, 200);
  }

  // (i) empty sunset_date → skip fail-OPEN
  {
    const res = await request(buildApp({ sunset_date: '' })).get('/ping');
    assertAbsent('empty sunset_date · fail-OPEN skip', res.headers, 'Sunset');
  }

  // (j) next() 100% called even with config
  {
    const res = await request(buildApp({ deprecation_ts: 1723334400 })).get('/ping');
    assertEq('with config · next() called · body ok', res.body, { ok: true });
  }

  // (k) apiDeprecationMiddleware() factory returns function
  {
    assertTrue('apiDeprecationMiddleware() returns function', typeof apiDeprecationMiddleware() === 'function');
  }

  // (l) pkg-level default is null (no api_deprecation block in package.json → zero-emit)
  {
    assertEq('pkg default · CURRENT_DEPRECATION_CONFIG null (default OFF)', CURRENT_DEPRECATION_CONFIG, null);
  }

  console.log(`\n=== api-deprecation: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
