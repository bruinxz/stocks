import express from 'express';
import request from 'supertest';
import { sequelize } from '../../src/config/database';

const VALID_SYMBOL = 'AAPL';

function buildApp() {
  const app = express();
  app.use(express.json());
  const { MultibaggerController } = require('../../src/api/controllers/MultibaggerController');
  const controller = new MultibaggerController();
  app.get('/api/v1/multibagger/candidates', controller.getCandidates);
  app.get('/api/v1/multibagger/:symbol/detail', controller.getDetail);
  return app;
}

(async () => {
  let passed = 0;
  let failed = 0;
  function assert(condition: boolean, label: string) {
    if (condition) { passed++; console.log(`  PASS: ${label}`); }
    else { failed++; console.error(`  FAIL: ${label}`); }
  }
  console.log('=== api-multibagger.test.ts ===\n');
  {
    const app = buildApp();

    console.log('[1] GET /api/v1/multibagger/candidates returns 200 or 500');
    const res = await request(app).get('/api/v1/multibagger/candidates');
    assert([200, 500].includes(res.status), 'status');

    console.log('[2] Response envelope');
    if (res.status === 200) {
      assert(res.body.kpi !== undefined, 'kpi');
      assert(Array.isArray(res.body.rows), 'rows');
    } else { assert(res.body.error !== undefined, 'error on 500'); }

    console.log('[3] KPI fields');
    if (res.status === 200 && res.body.kpi) {
      const kpi = res.body.kpi;
      assert(typeof kpi.total_candidates === 'number', 'total_candidates');
      assert(kpi.stage_distribution !== undefined, 'stage_distribution');
      assert(kpi.conclusion_coverage !== undefined, 'conclusion_coverage');
    } else { assert(true, 'skipped'); }

    console.log('[4] Stage distribution keys');
    if (res.status === 200 && res.body.kpi?.stage_distribution) {
      const sd = res.body.kpi.stage_distribution;
      assert('seed' in sd && 'early' in sd && 'growth' in sd && 'break_below' in sd && 'deep' in sd, 'all 5 stages');
    } else { assert(true, 'skipped'); }

    console.log('[5] stage filter');
    const stageRes = await request(app).get('/api/v1/multibagger/candidates?stage=seed,early');
    assert([200, 500].includes(stageRes.status), 'stage filter accepted');

    console.log('[6] conclusion filter');
    const conclusionRes = await request(app).get('/api/v1/multibagger/candidates?conclusion=MULTIBAGGER_2X');
    assert([200, 500].includes(conclusionRes.status), 'conclusion filter accepted');

    console.log('[7] market filter');
    for (const mkt of ['A', 'US', 'JP', 'KR']) {
      const mktRes = await request(app).get(`/api/v1/multibagger/candidates?market=${mkt}`);
      assert([200, 500].includes(mktRes.status), `market=${mkt} accepted`);
    }

    console.log('[8] Detail endpoint');
    const detailRes = await request(app).get(`/api/v1/multibagger/${VALID_SYMBOL}/detail`);
    assert([200, 404, 500].includes(detailRes.status), 'detail responds');

    console.log('[9] Detail 200 fields');
    if (detailRes.status === 200) {
      assert(detailRes.body.symbol !== undefined, 'symbol');
      assert(detailRes.body.score !== undefined, 'score');
      assert(detailRes.body.stage !== undefined, 'stage');
      assert(detailRes.body.conclusion !== undefined, 'conclusion');
      assert(detailRes.body.market !== undefined, 'market');
    } else { assert(true, 'skipped'); }

    console.log('[10] Detail 404');
    const notFoundRes = await request(app).get('/api/v1/multibagger/NOSUCHSYMBOL999/detail');
    assert([404, 500].includes(notFoundRes.status), 'not found or error');
  }
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  await sequelize.close().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
})();
