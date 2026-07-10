import express from 'express';
import request from 'supertest';
import jpkrMarketRoutes from '../../src/api/routes/jpkrMarket.routes';
import { sequelize } from '../../src/config/database';

const DATE = '2026-07-10';
const SYMBOL = '7203';

type QueryCall = {
  sql: string;
  replacements: Record<string, unknown>;
};

const SCORE = {
  scoring_id: '11111111-1111-4111-8111-111111111111',
  snapshot_hash: 'b'.repeat(64),
  ticker: SYMBOL,
  as_of: DATE,
  quality: { score: 88, band: 'A', evidence: ['EDINET filing'], inputs: {} },
  growth: { score: 82, band: 'B', evidence: [], inputs: {} },
  valuation: { score: 75, band: 'B', evidence: [], inputs: {} },
  moat: { score: 80, band: 'B', evidence: [], inputs: {} },
  trend: { score: 85, band: 'A', evidence: [], inputs: {} },
  risk: { score: 76, band: 'B', evidence: [], inputs: {} },
  weights: { quality: 0.25, growth: 0.15, valuation: 0.15, moat: 0.2, trend: 0.15, risk: 0.1 },
  weights_profile: 'japan_blue_chip',
  total: 84,
  rating: 'B',
  computed_at: '2026-07-10T06:00:00Z',
  source_versions: {
    quality_engine: 'quality@v0.3.0',
    growth_engine: 'growth@v0.3.0',
    valuation_engine: 'valuation@v0.3.0',
    moat_engine: 'moat@v0.3.0',
    trend_engine: 'trend@v0.3.0',
    risk_engine: 'risk@v0.3.0',
  },
};

const RISK_GATE = {
  ticker: SYMBOL,
  evaluated_at: '2026-07-10T06:00:00Z',
  gate: 'YELLOW',
  triggers: [{ code: 'TSE_HALT', severity: 'block', detail: 'TSE halt condition' }],
  ok_to_enter: false,
};

const MARKET_ROW = {
  symbol: SYMBOL,
  name_local: 'トヨタ自動車',
  name_en: 'Toyota Motor',
  market: 'JP',
  sector: 'automotive',
  close: '3125.50',
  change_pct: '1.25',
  currency: 'JPY',
  disclosure_events: JSON.stringify([
    {
      title: '決算短信',
      doc_type: 'earnings',
      filed_at: '2026-07-10T05:00:00Z',
      source: 'jpx-edinet',
      doc_url: 'https://example.test/filing',
    },
  ]),
  revenue_by_region: JSON.stringify([{ region: 'Japan', pct: 30 }]),
  fx_beta: '0.75',
  is_halted: false,
  data_sources: ['jpx-edinet', 'stooq-jp'],
  score: JSON.stringify(SCORE),
  risk_gate: JSON.stringify(RISK_GATE),
};

const KPI_ROW = {
  nikkei225: JSON.stringify({ value: '41000.5', change_pct: '0.8', as_of: DATE }),
  topix: JSON.stringify({ value: '2900.25', change_pct: '0.4', as_of: DATE }),
  kospi: null,
  usdjpy: JSON.stringify({ rate: '160.25', change_pct: '0.5' }),
  usdkrw: JSON.stringify({ rate: '1380.5', change_pct: '-0.2' }),
};

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/jpkr-market', jpkrMarketRoutes);
  return app;
}

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function main(): Promise<void> {
  const originalQuery = sequelize.query;
  const calls: QueryCall[] = [];
  let rowFixture: any[] = [MARKET_ROW];
  let kpiFixture: any[] = [KPI_ROW];

  (sequelize as any).query = async (sql: string, options: any) => {
    calls.push({ sql, replacements: options?.replacements || {} });
    return sql.includes('WITH index_symbols') ? kpiFixture : rowFixture;
  };

  try {
    const app = buildApp();

    const list = await request(app).get(`/api/v1/jpkr-market/${DATE}?market=JP`);
    assert('list returns 200 without Authorization', list.status === 200, `status=${list.status}`);
    assert('list has deterministic row', list.body.rows?.[0]?.symbol === SYMBOL);
    assert('numeric row fields are normalized', list.body.rows?.[0]?.close === 3125.5);
    assert('canonical Score passes through', list.body.rows?.[0]?.score?.total === 84);
    assert('canonical Score rating passes through', list.body.rows?.[0]?.score?.rating === 'B');
    assert('canonical RiskGate passes through', list.body.rows?.[0]?.risk_gate?.gate === 'YELLOW');
    assert(
      'risk_triggers mirrors RiskGate triggers',
      JSON.stringify(list.body.rows?.[0]?.risk_triggers) === JSON.stringify(RISK_GATE.triggers)
    );
    assert('USDJPY snapshot is numeric', list.body.kpi.usdjpy.rate === 160.25);
    assert('USDKRW snapshot is numeric', list.body.kpi.usdkrw.change_pct === -0.2);

    const kpiCall = calls[0];
    const listCall = calls[1];
    assert('KPI SQL uses frozen financial FX column', kpiCall.sql.includes('f.fx_rate_to_usd'));
    assert('row SQL uses frozen ticker names', listCall.sql.includes('k.ticker_name_local'));
    assert('row SQL maps disclosure table', listCall.sql.includes('jpkr_disclosure_event'));
    assert('row SQL derives prior-close change', listCall.sql.includes('previous_rows'));
    assert('row SQL avoids nonexistent kline change_pct', !listCall.sql.includes('k.change_pct'));
    assert('row SQL avoids financial-as-disclosure fields', !listCall.sql.includes('d.title'));
    assert(
      'list uses canonical replacements',
      listCall.replacements.date === DATE &&
        listCall.replacements.market === 'JP' &&
        listCall.replacements.symbol === null &&
        listCall.replacements.limit === 200
    );

    const detail = await request(app)
      .get(`/api/v1/jpkr-market/${SYMBOL}/detail?date=${DATE}`)
      .set('Authorization', 'Bearer invalid.jwt.token');
    assert('detail returns 200 with invalid token default-admin path', detail.status === 200);
    assert('detail returns same locked row shape', Array.isArray(detail.body.risk_triggers));
    const detailCall = calls.at(-1);
    assert(
      'detail uses symbol and limit=1',
      detailCall?.replacements.symbol === SYMBOL && detailCall?.replacements.limit === 1
    );

    rowFixture = [
      {
        ...MARKET_ROW,
        score: null,
        risk_gate: null,
      },
    ];
    kpiFixture = [
      {
        ...KPI_ROW,
        usdjpy: null,
        usdkrw: null,
      },
    ];
    const unavailable = await request(app).get(`/api/v1/jpkr-market/${DATE}?market=JP`);
    assert('unavailable Score is explicit null', unavailable.body.rows?.[0]?.score === null);
    assert('unavailable RiskGate is explicit null', unavailable.body.rows?.[0]?.risk_gate === null);
    assert(
      'unavailable risk_triggers is empty array',
      unavailable.body.rows?.[0]?.risk_triggers?.length === 0
    );
    assert(
      'unavailable FX snapshots are explicit null',
      unavailable.body.kpi.usdjpy === null && unavailable.body.kpi.usdkrw === null
    );

    const beforeInvalid = calls.length;
    const lowerMarket = await request(app).get(`/api/v1/jpkr-market/${DATE}?market=jp`);
    assert('lowercase market is rejected with 400', lowerMarket.status === 400);
    const missingMarket = await request(app).get(`/api/v1/jpkr-market/${DATE}`);
    assert('missing market is rejected with 400', missingMarket.status === 400);
    const invalidDate = await request(app).get('/api/v1/jpkr-market/not-a-date?market=JP');
    assert('invalid date is rejected with 400', invalidDate.status === 400);
    assert('invalid requests never query DB', calls.length === beforeInvalid);

    rowFixture = [];
    const missing = await request(app).get(`/api/v1/jpkr-market/NOSUCH/detail?date=${DATE}`);
    assert('missing detail returns 404', missing.status === 404, `status=${missing.status}`);
    assert(
      'missing detail returns stable error',
      missing.body.error === 'JPKR market entry not found'
    );
  } finally {
    (sequelize as any).query = originalQuery;
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
