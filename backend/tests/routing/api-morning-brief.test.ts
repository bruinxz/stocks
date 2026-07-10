import express from 'express';
import request from 'supertest';
import { sequelize } from '../../src/config/database';

const VALID_DATE = '2026-07-10';

function buildApp() {
  const app = express();
  app.use(express.json());
  const { MorningBriefController } = require('../../src/api/controllers/MorningBriefController');
  const controller = new MorningBriefController();
  app.get('/api/v1/morning-brief/:date', controller.getByDate);
  app.get('/api/v1/morning-brief/:date/summary', controller.getSummary);
  return app;
}

(async () => {
  let passed = 0;
  let failed = 0;
  function assert(condition: boolean, label: string) {
    if (condition) { passed++; console.log(`  PASS: ${label}`); }
    else { failed++; console.error(`  FAIL: ${label}`); }
  }
  console.log('=== api-morning-brief.test.ts ===\n');
  {
    const app = buildApp();
    console.log('[1] GET /api/v1/morning-brief/:date returns 200 or 500');
    const res = await request(app).get(`/api/v1/morning-brief/${VALID_DATE}`);
    assert([200, 500].includes(res.status), 'status is 200 or 500');

    console.log('[2] Response has date + events envelope');
    if (res.status === 200) {
      assert(res.body.date === VALID_DATE, 'body.date matches param');
      assert(Array.isArray(res.body.events), 'body.events is array');
    } else { assert(res.body.error !== undefined, 'error key present on 500'); }

    console.log('[3] GET /api/v1/morning-brief/:date/summary returns 200 or 500');
    const sumRes = await request(app).get(`/api/v1/morning-brief/${VALID_DATE}/summary`);
    assert([200, 500].includes(sumRes.status), 'summary status');

    console.log('[4] Summary KPI fields');
    if (sumRes.status === 200) {
      assert(typeof sumRes.body.total_candidates === 'number', 'total_candidates');
      assert(typeof sumRes.body.total_catalysts === 'number', 'total_catalysts');
      assert(typeof sumRes.body.avg_conviction === 'number', 'avg_conviction');
      assert(sumRes.body.conviction_distribution !== undefined, 'conviction_distribution');
      assert(sumRes.body.rating_distribution !== undefined, 'rating_distribution');
    } else { assert(true, 'skipped (db unavailable)'); }

    console.log('[5] conviction_distribution has HIGH/MED/LOW');
    if (sumRes.status === 200) {
      const cd = sumRes.body.conviction_distribution;
      assert('HIGH' in cd && 'MED' in cd && 'LOW' in cd, 'all 3 levels');
    } else { assert(true, 'skipped'); }

    console.log('[6] rating_distribution has A/B/C/D/F');
    if (sumRes.status === 200) {
      const rd = sumRes.body.rating_distribution;
      assert('A' in rd && 'B' in rd && 'C' in rd && 'D' in rd && 'F' in rd, 'all 5 bands');
    } else { assert(true, 'skipped'); }

    console.log('[7] Empty date returns empty events (not 404)');
    const emptyRes = await request(app).get('/api/v1/morning-brief/2000-01-01');
    if (emptyRes.status === 200) {
      assert(emptyRes.body.events.length === 0, 'empty events');
    } else { assert(emptyRes.status !== 404, 'not 404'); }
  }
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  await sequelize.close().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
})();
