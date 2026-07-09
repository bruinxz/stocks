/**
 * api-v1-mount.test.ts — ADR-0010 §4.1 · Phase 1 routing + X-API-Version test.
 *
 * 不依赖 jest · node 直接跑 (与 backend/src/scripts/run-tests.ts 约定一致):
 *   cd backend && npx ts-node --transpile-only tests/routing/api-v1-mount.test.ts
 *
 * Asserts:
 *   (a) five /api/v1/* endpoints reachable (paper-trading, quant,
 *       portfolio, explain-card, screener)
 *   (b) X-API-Version response header = '1.0' on both /api/v1/* and legacy /api/*
 *   (c) portfolio full-rewrap includes /rebalance-industry sub-route
 *   (d) legacy /api/* routes remain reachable during dual-mount window
 *
 * Isolation: builds a fixture app inline rather than importing the real
 * backend/src/index.ts — the real index boots DB/Redis/Bull and would
 * need heavy mocking. This test validates middleware + mount shape only;
 * real-route integration lives in Phase 2 e2e.
 */
import request from 'supertest';
import express from 'express';
import { apiVersionMiddleware, CURRENT_API_VERSION } from '../../src/middlewares/apiVersion';

function buildTestApp(): express.Express {
  const app = express();
  app.use(apiVersionMiddleware());

  const stub = (label: string) => {
    const r = express.Router();
    r.get('/ping', (_req, res) => res.json({ ok: true, label }));
    r.post('/rebalance-industry', (_req, res) => res.json({ ok: true, label }));
    return r;
  };

  // /api/v1/* new mounts (5 groups per ADR-0010 §1)
  app.use('/api/v1/paper-trading', stub('paper-trading-v1'));
  app.use('/api/v1/quant', stub('quant-v1'));
  app.use('/api/v1/portfolio', stub('portfolio-v1'));
  app.use('/api/v1/explain-card', stub('explain-card-v1'));
  app.use('/api/v1/screener', stub('screener-v1'));

  // Legacy /api/* dual-mount (representative sample)
  app.use('/api/paper-trading', stub('paper-trading-legacy'));
  app.use('/api/portfolio', stub('portfolio-legacy'));

  return app;
}

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('\n## ADR-0010 §4.1 · Phase 1 /api/v1/* mount + X-API-Version');

  const app = buildTestApp();
  assert('CURRENT_API_VERSION constant exported', CURRENT_API_VERSION === '1.0', `got '${CURRENT_API_VERSION}'`);

  const v1Paths = [
    '/api/v1/paper-trading/ping',
    '/api/v1/quant/ping',
    '/api/v1/portfolio/ping',
    '/api/v1/explain-card/ping',
    '/api/v1/screener/ping',
  ];
  for (const url of v1Paths) {
    const res = await request(app).get(url);
    assert(
      `${url} → 200 + X-API-Version=1.0`,
      res.status === 200 && res.headers['x-api-version'] === '1.0',
      `status=${res.status} header=${res.headers['x-api-version']}`
    );
  }

  const rebalance = await request(app).post('/api/v1/portfolio/rebalance-industry');
  assert(
    'portfolio full-rewrap exposes /rebalance-industry under /api/v1',
    rebalance.status === 200 && rebalance.headers['x-api-version'] === '1.0',
    `status=${rebalance.status}`
  );

  const legacy = await request(app).get('/api/paper-trading/ping');
  assert(
    'legacy /api/paper-trading/ping reachable with X-API-Version header',
    legacy.status === 200 && legacy.headers['x-api-version'] === '1.0',
    `status=${legacy.status}`
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('unhandled test error:', err);
  process.exit(1);
});
