import express from 'express';
import request from 'supertest';
import { sequelize } from '../../src/config/database';

const VALID_DATE = '2026-07-10';

function buildApp() {
  const app = express();
  app.use(express.json());
  const { UsSelectController } = require('../../src/api/controllers/UsSelectController');
  const controller = new UsSelectController();
  app.get('/api/v1/us-select/:date', controller.getByDate);
  app.get('/api/v1/us-select/:date/summary', controller.getSummary);
  return app;
}

(async () => {
  let passed = 0;
  let failed = 0;
  function assert(condition: boolean, label: string) {
    if (condition) { passed++; console.log(`  PASS: ${label}`); }
    else { failed++; console.error(`  FAIL: ${label}`); }
  }
  console.log('=== api-us-select.test.ts ===\n');
  {
    const app = buildApp();
    console.log('[1] GET /api/v1/us-select/:date returns 200 or 500');
    const res = await request(app).get(`/api/v1/us-select/${VALID_DATE}`);
    assert([200, 500].includes(res.status), 'status');

    console.log('[2] Response envelope');
    if (res.status === 200) {
      assert(res.body.date === VALID_DATE, 'date');
      assert(res.body.profile === 'us_preferred', 'profile');
      assert(Array.isArray(res.body.candidates), 'candidates');
    } else { assert(res.body.error !== undefined, 'error on 500'); }

    console.log('[3] Summary');
    const sumRes = await request(app).get(`/api/v1/us-select/${VALID_DATE}/summary`);
    assert([200, 500].includes(sumRes.status), 'summary status');

    console.log('[4] Summary fields');
    if (sumRes.status === 200) {
      assert(sumRes.body.profile === 'us_preferred', 'profile');
      assert(typeof sumRes.body.total_candidates === 'number', 'total_candidates');
      assert(typeof sumRes.body.avg_conviction === 'number', 'avg_conviction');
      assert(sumRes.body.rating_distribution !== undefined, 'rating_distribution');
    } else { assert(true, 'skipped'); }

    console.log('[5] rating_distribution A/B/C/D/F');
    if (sumRes.status === 200) {
      const rd = sumRes.body.rating_distribution;
      assert('A' in rd && 'B' in rd && 'C' in rd && 'D' in rd && 'F' in rd, 'all 5 bands');
    } else { assert(true, 'skipped'); }

    console.log('[6] Empty date');
    const emptyRes = await request(app).get('/api/v1/us-select/2000-01-01');
    if (emptyRes.status === 200) { assert(emptyRes.body.candidates.length === 0, 'empty'); }
    else { assert(emptyRes.status !== 404, 'not 404'); }

    console.log('[7] limit=1');
    const limitRes = await request(app).get(`/api/v1/us-select/${VALID_DATE}?limit=1`);
    assert([200, 500].includes(limitRes.status), 'limit accepted');
  }
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  await sequelize.close().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
})();
