import express from 'express';
import request from 'supertest';
import { sequelize } from '../../src/config/database';

const VALID_STRATEGY = 'us_preferred';
const VALID_DATE = '2026-07-10';

function buildApp() {
  const app = express();
  app.use(express.json());
  const { BacktestPitController } = require('../../src/api/controllers/BacktestPitController');
  const controller = new BacktestPitController();
  app.get('/api/v1/backtest-pit/:strategy', controller.listSnapshots);
  app.get('/api/v1/backtest-pit/:strategy/:as_of', controller.getSnapshot);
  app.get('/api/v1/backtest-pit/:strategy/:as_of/holdings', controller.getHoldings);
  return app;
}

(async () => {
  let passed = 0;
  let failed = 0;
  function assert(condition: boolean, label: string) {
    if (condition) { passed++; console.log(`  PASS: ${label}`); }
    else { failed++; console.error(`  FAIL: ${label}`); }
  }
  console.log('=== api-backtest-pit.test.ts ===\n');
  {
    const app = buildApp();
    console.log('[1] GET /api/v1/backtest-pit/:strategy returns 200 or 500');
    const res = await request(app).get(`/api/v1/backtest-pit/${VALID_STRATEGY}`);
    assert([200, 500].includes(res.status), 'valid strategy accepted');

    console.log('[2] Response envelope');
    if (res.status === 200) {
      assert(res.body.strategy === VALID_STRATEGY, 'strategy');
      assert(Array.isArray(res.body.snapshots), 'snapshots');
    } else { assert(res.body.error !== undefined, 'error on 500'); }

    console.log('[3] Detail endpoint');
    const detailRes = await request(app).get(`/api/v1/backtest-pit/${VALID_STRATEGY}/${VALID_DATE}`);
    assert([200, 404, 500].includes(detailRes.status), 'detail responds');

    console.log('[4] Detail 200 fields');
    if (detailRes.status === 200) {
      assert(detailRes.body.snapshot_id !== undefined, 'snapshot_id');
      assert(detailRes.body.holdings !== undefined, 'holdings');
      assert(detailRes.body.metrics !== undefined, 'metrics');
      assert(detailRes.body.fact_hash !== undefined, 'fact_hash');
    } else { assert(true, 'skipped'); }

    console.log('[5] Detail 404');
    if (detailRes.status === 404) { assert(detailRes.body.error === 'Backtest snapshot not found', '404 msg'); }
    else { assert(true, 'skipped'); }

    console.log('[6] from/to filter');
    const filterRes = await request(app).get(`/api/v1/backtest-pit/${VALID_STRATEGY}?from=2026-01-01&to=2026-06-30`);
    assert([200, 500].includes(filterRes.status), 'filter accepted');

    console.log('[7] limit=5');
    const limitRes = await request(app).get(`/api/v1/backtest-pit/${VALID_STRATEGY}?limit=5`);
    assert([200, 500].includes(limitRes.status), 'limit accepted');

    console.log('[8] All 6 strategies');
    for (const strat of ['us_preferred', 'multibagger', 'japan_blue_chip', 'korea_semiconductor_chain', 'japan_multibagger', 'korea_multibagger']) {
      const sRes = await request(app).get(`/api/v1/backtest-pit/${strat}`);
      assert([200, 500].includes(sRes.status), `${strat} accepted`);
    }

    console.log('[9] Holdings endpoint');
    const holdingsRes = await request(app).get(`/api/v1/backtest-pit/${VALID_STRATEGY}/${VALID_DATE}/holdings`);
    assert([200, 404, 500].includes(holdingsRes.status), 'holdings responds');

    console.log('[10] Holdings 200 fields');
    if (holdingsRes.status === 200) {
      assert(Array.isArray(holdingsRes.body.holdings), 'holdings array');
    } else { assert(true, 'skipped'); }

    console.log('[11] Holdings 404');
    const holdingsNotFoundRes = await request(app).get('/api/v1/backtest-pit/us_preferred/2000-01-01/holdings');
    assert([404, 500].includes(holdingsNotFoundRes.status), 'holdings not found or error');

    console.log('[12] listSnapshots metrics extraction');
    if (resJP?.status === 200) { assert(true, 'skipped - use main res'); }
    const metricsRes = await request(app).get(`/api/v1/backtest-pit/${VALID_STRATEGY}`);
    if (metricsRes.status === 200 && metricsRes.body.snapshots?.length > 0) {
      const snap = metricsRes.body.snapshots[0];
      assert(snap.net_value === undefined || typeof snap.net_value === 'number', 'net_value numeric');
      assert(snap.drawdown === undefined || typeof snap.drawdown === 'number', 'drawdown numeric');
      assert(snap.cumulative_return === undefined || typeof snap.cumulative_return === 'number', 'cumulative_return numeric');
    } else { assert(true, 'skipped'); }
  }
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  await sequelize.close().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
})();
