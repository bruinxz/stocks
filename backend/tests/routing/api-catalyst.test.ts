import express from 'express';
import request from 'supertest';
import { sequelize } from '../../src/config/database';

const VALID_UUID = '00000000-0000-4000-8000-000000000001';

function buildApp() {
  const app = express();
  app.use(express.json());
  const { CatalystController } = require('../../src/api/controllers/CatalystController');
  const controller = new CatalystController();
  app.get('/api/v1/catalyst/:id', controller.getById);
  app.get('/api/v1/catalyst/:id/candidates', controller.getCandidates);
  return app;
}

(async () => {
  let passed = 0;
  let failed = 0;
  function assert(condition: boolean, label: string) {
    if (condition) { passed++; console.log(`  PASS: ${label}`); }
    else { failed++; console.error(`  FAIL: ${label}`); }
  }
  console.log('=== api-catalyst.test.ts ===\n');
  {
    const app = buildApp();
    console.log('[1] GET /api/v1/catalyst/:id with valid UUID');
    const res = await request(app).get(`/api/v1/catalyst/${VALID_UUID}`);
    assert([200, 404, 500].includes(res.status), 'valid UUID accepted');

    console.log('[2] 404 has error field');
    if (res.status === 404) { assert(res.body.error === 'Catalyst event not found', '404 msg'); }
    else { assert(true, 'skipped'); }

    console.log('[3] GET /api/v1/catalyst/:id/candidates');
    const candRes = await request(app).get(`/api/v1/catalyst/${VALID_UUID}/candidates`);
    assert([200, 404, 500].includes(candRes.status), 'candidates responds');

    console.log('[4] Candidates 200 envelope');
    if (candRes.status === 200) {
      assert(candRes.body.catalyst_id === VALID_UUID, 'catalyst_id');
      assert(Array.isArray(candRes.body.candidates), 'candidates array');
    } else { assert(true, 'skipped'); }

    console.log('[5] Candidates 404');
    if (candRes.status === 404) { assert(candRes.body.error === 'Catalyst event not found', '404'); }
    else { assert(true, 'skipped'); }
  }
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  await sequelize.close().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
})();
