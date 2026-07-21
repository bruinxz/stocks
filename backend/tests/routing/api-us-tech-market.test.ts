import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { sequelize } from '../../src/config/database';
import { User } from '../../src/models/User';

const JWT_SECRET = 'api-us-tech-market-test-secret';
const AUTH_USER = {
  id: 9012,
  username: 'us-tech-routing-user',
  email: 'us-tech@example.com',
  role: 'admin',
  is_active: true,
} as User;

process.env.JWT_SECRET = JWT_SECRET;
(User as any).findByPk = async (user_id: number) => (user_id === AUTH_USER.id ? AUTH_USER : null);

const AUTHORIZATION = `Bearer ${jwt.sign(
  {
    user_id: AUTH_USER.id,
    username: AUTH_USER.username,
    role: AUTH_USER.role,
    type: 'access',
  },
  JWT_SECRET,
  {
    algorithm: 'HS256',
    issuer: 'stocks-backend',
    audience: 'stocks-api',
    expiresIn: '5m',
  }
)}`;
const routes = require('../../src/api/routes/usTechMarket.routes')
  .default as typeof import('../../src/api/routes/usTechMarket.routes').default;

const DATE = '2026-07-21';
const ROWS = [
  {
    symbol: 'SMH',
    instrument_name: 'VanEck Semiconductor ETF',
    instrument_type: 'etf',
    theme: 'semiconductor',
    is_sector_proxy: true,
    is_focus: true,
    exchange: 'PCX',
    trading_day: DATE,
    close: '402.50',
    volume: '8000000',
    currency: 'USD',
    source_kind: 'yahoo-chart-public',
    change_pct: '2.40',
    change_5d_pct: '5.10',
    notional_volume: '3220000000',
  },
  {
    symbol: 'XLK',
    instrument_name: 'Technology Select Sector SPDR Fund',
    instrument_type: 'etf',
    theme: 'broad_technology',
    is_sector_proxy: true,
    is_focus: true,
    exchange: 'PCX',
    trading_day: DATE,
    close: '305.00',
    volume: '5000000',
    currency: 'USD',
    source_kind: 'yahoo-chart-public',
    change_pct: '-0.50',
    change_5d_pct: '1.20',
    notional_volume: '1525000000',
  },
  {
    symbol: 'NVDA',
    instrument_name: 'NVIDIA',
    instrument_type: 'stock',
    theme: 'semiconductor',
    is_sector_proxy: false,
    is_focus: true,
    exchange: 'NMS',
    trading_day: DATE,
    close: '205.31',
    volume: '60000000',
    currency: 'USD',
    source_kind: 'yahoo-chart-public',
    change_pct: '1.80',
    change_5d_pct: '3.40',
    notional_volume: '12318600000',
  },
  {
    symbol: 'QQQ',
    instrument_name: 'Invesco QQQ Trust',
    instrument_type: 'etf',
    theme: 'nasdaq_100',
    is_sector_proxy: false,
    is_focus: true,
    exchange: 'NMS',
    trading_day: DATE,
    close: '620.00',
    volume: '70000000',
    currency: 'USD',
    source_kind: 'yahoo-chart-public',
    change_pct: '0.80',
    change_5d_pct: '2.20',
    notional_volume: '43400000000',
  },
];

function app(): express.Express {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/v1/us-tech-market', routes);
  return instance;
}

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}`);
  }
}

async function main(): Promise<void> {
  const original_query = sequelize.query;
  const calls: Array<{ sql: string; replacements: Record<string, unknown> }> = [];
  (sequelize as any).query = async (sql: string, options: any) => {
    calls.push({ sql, replacements: options.replacements });
    return ROWS;
  };
  try {
    const instance = app();
    const missing_auth = await request(instance).get(`/api/v1/us-tech-market/${DATE}`);
    assert('missing Authorization returns 401', missing_auth.status === 401);
    assert('missing Authorization never queries DB', calls.length === 0);

    const response = await request(instance)
      .get(`/api/v1/us-tech-market/${DATE}`)
      .set('Authorization', AUTHORIZATION);
    assert('authorized request returns 200', response.status === 200);
    assert('market contract is US', response.body.market === 'US');
    assert(
      'sectors are sorted by daily return',
      response.body.sector_performance[0].symbol === 'SMH'
    );
    assert(
      'sector calculation basis is explicit',
      response.body.sector_performance[0].calculation_basis === 'proxy_etf'
    );
    assert(
      'representative stocks exclude ETFs',
      response.body.representative_tech_stocks.length === 1 &&
        response.body.representative_tech_stocks[0].symbol === 'NVDA'
    );
    assert(
      'focus ETFs rank by dollar volume',
      response.body.focus_etfs[0].symbol === 'QQQ' &&
        response.body.focus_etfs[0].attention_rank === 1
    );
    assert(
      'attention basis is explicit',
      response.body.focus_etfs[0].attention_basis === 'latest_dollar_volume'
    );
    assert(
      'summary breadth uses sector proxies',
      response.body.market_summary.tech_breadth_pct === 50
    );
    assert(
      'numeric database values are normalized',
      response.body.representative_tech_stocks[0].close === 205.31
    );
    assert(
      'query applies PIT cutoff',
      calls[0].sql.includes('available_at_utc <= CAST(:cutoff AS timestamptz)')
    );
    assert('query uses five-session comparison', calls[0].sql.includes('OFFSET 4'));
    assert('date replacement is bounded', calls[0].replacements.cutoff === `${DATE}T23:59:59.999Z`);

    const invalid_date = await request(instance)
      .get('/api/v1/us-tech-market/not-a-date')
      .set('Authorization', AUTHORIZATION);
    assert('invalid date returns 400', invalid_date.status === 400);
    assert('invalid date never queries DB', calls.length === 1);
  } finally {
    (sequelize as any).query = original_query;
  }
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
