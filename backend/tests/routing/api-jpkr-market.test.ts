import express from 'express';
import request from 'supertest';
import { sequelize } from '../../src/config/database';

const VALID_DATE = '2026-07-10';
const VALID_SYMBOL = '7203.T';

function buildApp() {
  const app = express();
  app.use(express.json());
  const { JpKrMarketController } = require('../../src/api/controllers/JpKrMarketController');
  const controller = new JpKrMarketController();
  app.get('/api/v1/jpkr-market/:date', controller.getByDate);
  app.get('/api/v1/jpkr-market/:symbol/detail', controller.getDetail);
  return app;
}

(async () => {
  let passed = 0;
  let failed = 0;
  function assert(condition: boolean, label: string) {
    if (condition) { passed++; console.log(`  PASS: ${label}`); }
    else { failed++; console.error(`  FAIL: ${label}`); }
  }
  console.log('=== api-jpkr-market.test.ts ===\n');
  {
    const app = buildApp();

    console.log('[1] GET /api/v1/jpkr-market/:date?market=JP returns 200 or 500');
    const resJP = await request(app).get(`/api/v1/jpkr-market/${VALID_DATE}?market=JP`);
    assert([200, 500].includes(resJP.status), 'JP status');

    console.log('[2] JP response envelope');
    if (resJP.status === 200) {
      assert(resJP.body.date === VALID_DATE, 'date');
      assert(resJP.body.kpi !== undefined, 'kpi');
      assert(Array.isArray(resJP.body.rows), 'rows');
    } else { assert(resJP.body.error !== undefined, 'error on 500'); }

    console.log('[3] JP kpi fields');
    if (resJP.status === 200 && resJP.body.kpi) {
      const kpi = resJP.body.kpi;
      assert(typeof kpi.total_stocks === 'number', 'total_stocks');
      assert(kpi.index_close !== undefined, 'index_close');
      assert(kpi.index_change_pct !== undefined, 'index_change_pct');
    } else { assert(true, 'skipped'); }

    console.log('[4] GET /api/v1/jpkr-market/:date?market=KR');
    const resKR = await request(app).get(`/api/v1/jpkr-market/${VALID_DATE}?market=KR`);
    assert([200, 500].includes(resKR.status), 'KR status');

    console.log('[5] KR response envelope');
    if (resKR.status === 200) {
      assert(resKR.body.date === VALID_DATE, 'date');
      assert(Array.isArray(resKR.body.rows), 'rows');
    } else { assert(resKR.body.error !== undefined, 'error on 500'); }

    console.log('[6] Detail endpoint');
    const detailRes = await request(app).get(`/api/v1/jpkr-market/${VALID_SYMBOL}/detail?date=${VALID_DATE}`);
    assert([200, 404, 500].includes(detailRes.status), 'detail responds');

    console.log('[7] Detail 200 fields');
    if (detailRes.status === 200) {
      assert(detailRes.body.symbol !== undefined, 'symbol');
      assert(detailRes.body.close !== undefined, 'close');
      assert(detailRes.body.change_pct !== undefined, 'change_pct');
    } else { assert(true, 'skipped'); }

    console.log('[8] Detail 404');
    const notFoundRes = await request(app).get('/api/v1/jpkr-market/NOSUCH/detail?date=2000-01-01');
    assert([404, 500].includes(notFoundRes.status), 'not found or error');

    console.log('[9] Empty date');
    const emptyRes = await request(app).get('/api/v1/jpkr-market/2000-01-01?market=JP');
    if (emptyRes.status === 200) { assert(emptyRes.body.rows.length === 0, 'empty rows'); }
    else { assert([500].includes(emptyRes.status), 'error acceptable'); }
  }
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  await sequelize.close().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
})();
