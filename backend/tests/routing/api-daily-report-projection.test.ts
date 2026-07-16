import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { User } from '../../src/models/User';
import { DailyReportProjectionPort } from '../../src/projections/DailyReportProjectionService';
import {
  RecommendationSnapshotConflictError,
  RecommendationSnapshotContractError,
  RecommendationSnapshotStoreUnavailableError,
} from '../../src/recommendations/RecommendationSnapshotReadPort';
import {
  ProjectionCliInputTooLargeError,
  ProjectionCliOutputTooLargeError,
  ProjectionCliProtocolError,
  ProjectionCliRejectedError,
  ProjectionCliTimeoutError,
  ProjectionCliUnavailableError,
} from '../../src/projections/ProjectionCliClient';

const JWT_SECRET = 'api-daily-report-projection-test-secret';
const AUTH_USER = {
  id: 9002,
  username: 'routing-test-user',
  email: 'routing-test@example.com',
  role: 'admin',
  is_active: true,
} as User;

process.env.JWT_SECRET = JWT_SECRET;
(User as any).findByPk = async (userId: number) => (userId === AUTH_USER.id ? AUTH_USER : null);

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
const { buildDailyReportProjectionRoutes } =
  require('../../src/api/routes/dailyReportProjection.routes') as typeof import('../../src/api/routes/dailyReportProjection.routes');

type Call = { operation: string; value: unknown };

const DAILY = {
  projection_version: '0.1.0',
  report_id: 'daily-report:2026-07-12:us_preferred:us',
  trading_day: '2026-07-12',
};
const HISTORY = {
  projection_version: '0.1.0',
  filters: {
    query: '',
    profile: null,
    market_scope: null,
    from_day: null,
    to_day: null,
  },
  entries: [],
  total: 0,
};

function port(calls: Call[]): DailyReportProjectionPort {
  return {
    async latest(scope) {
      calls.push({ operation: 'latest', value: scope });
      return DAILY;
    },
    async byDate(query) {
      calls.push({ operation: 'byDate', value: query });
      return DAILY;
    },
    async history(query) {
      calls.push({ operation: 'history', value: query });
      return HISTORY;
    },
  };
}

function app(projections: DailyReportProjectionPort): express.Express {
  const instance = express();
  instance.use('/api/v1/daily-report', buildDailyReportProjectionRoutes(projections));
  return instance;
}

function authorizedGet(app: express.Express, path: string) {
  return request(app).get(path).set('Authorization', AUTHORIZATION);
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
  const calls: Call[] = [];
  const instance = app(port(calls));

  const callsBeforeAuth = calls.length;
  const missingAuthorization = await request(instance).get(
    '/api/v1/daily-report/latest?profile=us_preferred&market_scope=us'
  );
  assert('missing Authorization returns 401', missingAuthorization.status === 401);
  const invalidAuthorization = await request(instance)
    .get('/api/v1/daily-report/latest?profile=us_preferred&market_scope=us')
    .set('Authorization', 'Bearer invalid.jwt.token');
  assert('invalid Authorization returns 401', invalidAuthorization.status === 401);
  assert('unauthorized requests do not call service', calls.length === callsBeforeAuth);

  const latest = await authorizedGet(
    instance,
    '/api/v1/daily-report/latest?profile=us_preferred&market_scope=us'
  );
  assert('latest returns projected report', latest.status === 200);
  assert('latest preserves Python wire', latest.body.report_id === DAILY.report_id);
  assert(
    'latest passes exact explicit scope',
    JSON.stringify(calls.at(-1)?.value) ===
      JSON.stringify({ profile: 'us_preferred', market_scope: 'us' })
  );

  const byDate = await authorizedGet(
    instance,
    '/api/v1/daily-report/2026-07-12?profile=multibagger&market_scope=cn_a'
  );
  assert('by-date returns projected report', byDate.status === 200);
  assert(
    'by-date passes exact date and scope',
    JSON.stringify(calls.at(-1)?.value) ===
      JSON.stringify({
        trading_day: '2026-07-12',
        profile: 'multibagger',
        market_scope: 'cn_a',
      })
  );

  const history = await authorizedGet(
    instance,
    '/api/v1/daily-report/history' +
      '?query=AAPL&profile=us_preferred&market_scope=us' +
      '&from_day=2026-07-01&to_day=2026-07-12'
  );
  assert('history returns Python wire', history.status === 200 && history.body.total === 0);
  assert(
    'history passes exact frozen filters',
    JSON.stringify(calls.at(-1)?.value) ===
      JSON.stringify({
        query: 'AAPL',
        profile: 'us_preferred',
        market_scope: 'us',
        from_day: '2026-07-01',
        to_day: '2026-07-12',
      })
  );

  const callsBeforeInvalid = calls.length;
  const invalidRequests = await Promise.all([
    authorizedGet(instance, '/api/v1/daily-report/latest?profile=us_preferred'),
    authorizedGet(instance, '/api/v1/daily-report/latest?profile=japan_blue_chip&market_scope=us'),
    authorizedGet(instance, '/api/v1/daily-report/not-a-day?profile=us_preferred&market_scope=us'),
    authorizedGet(instance, '/api/v1/daily-report/history?profile=custom&market_scope=us'),
    authorizedGet(instance, '/api/v1/daily-report/history?from_day=2026-07-12&to_day=2026-07-01'),
    authorizedGet(instance, `/api/v1/daily-report/history?query=${'x'.repeat(201)}`),
  ]);
  assert(
    'invalid queries all return 400',
    invalidRequests.every(response => response.status === 400)
  );
  assert('invalid queries do not call service', calls.length === callsBeforeInvalid);

  const emptyPort = port([]);
  emptyPort.latest = async () => null;
  emptyPort.byDate = async () => null;
  assert(
    'missing latest returns 404',
    (
      await authorizedGet(
        app(emptyPort),
        '/api/v1/daily-report/latest?profile=us_preferred&market_scope=us'
      )
    ).status === 404
  );
  assert(
    'missing day returns 404',
    (
      await authorizedGet(
        app(emptyPort),
        '/api/v1/daily-report/2026-07-12?profile=us_preferred&market_scope=us'
      )
    ).status === 404
  );

  const errorPort = (
    error: Error,
    operation: keyof DailyReportProjectionPort = 'latest'
  ): DailyReportProjectionPort => ({
    ...port([]),
    [operation]: async () => {
      throw error;
    },
  });
  const latestPath = '/api/v1/daily-report/latest?profile=us_preferred&market_scope=us';

  const errors: Array<[string, Error, number, string]> = [
    [
      'snapshot conflict',
      new RecommendationSnapshotConflictError('secret conflict'),
      409,
      'ambiguous',
    ],
    ['input cap', new ProjectionCliInputTooLargeError(), 413, 'too large'],
    [
      'snapshot contract',
      new RecommendationSnapshotContractError('secret contract'),
      422,
      'invalid',
    ],
    [
      'CLI contract',
      new ProjectionCliRejectedError('CONTRACT_ERROR', 'secret CLI detail', 3),
      422,
      'invalid',
    ],
    [
      'store unavailable',
      new RecommendationSnapshotStoreUnavailableError('secret store'),
      503,
      'unavailable',
    ],
    ['CLI unavailable', new ProjectionCliUnavailableError('secret spawn'), 503, 'unavailable'],
    ['timeout', new ProjectionCliTimeoutError(), 504, 'timed out'],
    ['output cap', new ProjectionCliOutputTooLargeError('stdout'), 502, 'failed'],
    ['protocol', new ProjectionCliProtocolError('secret protocol'), 502, 'failed'],
    [
      'CLI request rejection',
      new ProjectionCliRejectedError('INVALID_REQUEST', 'secret request', 2),
      502,
      'failed',
    ],
  ];
  for (const [name, error, expectedStatus, expectedPublicText] of errors) {
    const response = await authorizedGet(app(errorPort(error)), latestPath);
    assert(`${name} maps bounded status`, response.status === expectedStatus);
    assert(
      `${name} returns bounded public message`,
      response.body.error.includes(expectedPublicText)
    );
    assert(`${name} does not leak error detail`, !response.text.includes('secret'));
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
