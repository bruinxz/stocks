import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { buildRecommendationReplayRoutes } from '../../src/api/routes/recommendationReplay.routes';
import type {
  RecommendationReplayPort,
} from '../../src/api/controllers/RecommendationReplayController';
import {
  ReplayCliInputTooLargeError,
  ReplayCliProtocolError,
  ReplayCliRejectedError,
  ReplayCliTimeoutError,
  ReplayCliUnavailableError,
} from '../../src/replay/ReplayCliClient';
import type { ReplayJob, ReplayPins } from '../../src/replay/ReplayContract';
import { ReplayBackpressureError } from '../../src/replay/ReplayJobSupervisor';
import type { ReplayOperationalLimits } from '../../src/replay/ReplayOperationalLimits';
import {
  ReplayPinsConflictError,
  ReplayPinsNotFoundError,
  ReplayPinsStoreUnavailableError,
  type ReplayPinsQuery,
  type ReplayPinsReadPort,
} from '../../src/replay/ReplayPinsReadPort';
import { User } from '../../src/models/User';

const JWT_SECRET = 'recommendation-replay-routing-test-secret';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST = {
  trading_day: '2026-07-14',
  profile: 'us_preferred' as const,
  market_scope: 'us' as const,
};
const PINS: ReplayPins = {
  ...REQUEST,
  as_of: '2026-07-14T06:00:00Z',
  profile_version: '1.0.0',
  contract_version: '0.3.1',
  input_fingerprint: 'a'.repeat(64),
  strategy_version: '1.0.0',
  pipeline_version: '1.0.0',
};
const LIMITS: ReplayOperationalLimits = {
  worker_deadline_seconds: 120,
  lease_seconds: 150,
  max_concurrency: 2,
  max_queue_depth: 32,
  submit_rate_per_minute: 120,
  status_rate_per_minute: 1_200,
  rate_max_users: 10_000,
};

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

class FakePins implements ReplayPinsReadPort {
  calls: ReplayPinsQuery[] = [];
  error?: Error;

  async resolve(query: ReplayPinsQuery): Promise<ReplayPins> {
    this.calls.push(query);
    if (this.error) throw this.error;
    return PINS;
  }
}

class FakeReplay implements RecommendationReplayPort {
  submit_calls: ReplayPins[] = [];
  status_calls: string[] = [];
  submit_result: ReplayJob = { job_id: JOB_ID, status: 'queued' };
  status_result: ReplayJob = { job_id: JOB_ID, status: 'running' };
  submit_error?: Error;
  status_error?: Error;

  async submitAndRun(pins: ReplayPins): Promise<ReplayJob> {
    this.submit_calls.push(pins);
    if (this.submit_error) throw this.submit_error;
    return this.submit_result;
  }

  async status(job_id: string): Promise<ReplayJob> {
    this.status_calls.push(job_id);
    if (this.status_error) throw this.status_error;
    return this.status_result;
  }
}

function buildApp(
  pins: ReplayPinsReadPort,
  replay: RecommendationReplayPort,
  operational_limits: ReplayOperationalLimits = LIMITS,
  rate_clock?: () => number
): express.Express {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(
    '/api/v1/ai/recommendations',
    buildRecommendationReplayRoutes(pins, replay, { operational_limits, rate_clock })
  );
  return app;
}

async function main(): Promise<void> {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalFindByPk = User.findByPk;
  process.env.JWT_SECRET = JWT_SECRET;
  const token = jwt.sign(
    { user_id: 7, username: 'replay-user', role: 'analyst', type: 'access' },
    JWT_SECRET,
    {
      algorithm: 'HS256',
      issuer: 'stocks-backend',
      audience: 'stocks-api',
      expiresIn: '5m',
    }
  );
  const authorization = `Bearer ${token}`;
  (User as any).findByPk = async (userId: number) => ({
    id: Number(userId),
    username: `replay-user-${userId}`,
    role: 'analyst',
    is_active: true,
  });

  try {
    const pins = new FakePins();
    const replay = new FakeReplay();
    const app = buildApp(pins, replay);

    const missingAuth = await request(app).post('/api/v1/ai/recommendations/replay').send(REQUEST);
    assert('POST requires Bearer authentication', missingAuth.status === 401);
    assert('unauthenticated POST has no replay effects', pins.calls.length === 0);

    const invalidAuth = await request(app)
      .get(`/api/v1/ai/recommendations/status?job_id=${JOB_ID}`)
      .set('Authorization', 'Bearer invalid.jwt.token');
    assert('GET status rejects invalid Bearer', invalidAuth.status === 401);

    const queued = await request(app)
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', authorization)
      .send(REQUEST);
    assert('queued POST returns 202', queued.status === 202 && queued.body.status === 'queued');
    assert(
      'POST resolves physical pins from exactly three selectors',
      JSON.stringify(pins.calls.at(-1)) === JSON.stringify(REQUEST)
    );
    assert('POST passes all nine physical pins to supervisor', replay.submit_calls.at(-1) === PINS);

    replay.submit_result = {
      job_id: JOB_ID,
      status: 'completed',
      snapshot_id: SNAPSHOT_ID,
    };
    const completed = await request(app)
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', authorization)
      .send(REQUEST);
    assert(
      'terminal POST returns exact completed job with 200',
      completed.status === 200 &&
        JSON.stringify(completed.body) === JSON.stringify(replay.submit_result)
    );

    const status = await request(app)
      .get(`/api/v1/ai/recommendations/status?job_id=${JOB_ID}`)
      .set('Authorization', authorization);
    assert('static status route returns 200 before snapshot detail', status.status === 200);
    assert('status passes exact canonical job_id', replay.status_calls.at(-1) === JOB_ID);

    const effectsBeforeInvalid = pins.calls.length + replay.status_calls.length;
    const invalidRequests = await Promise.all([
      request(app)
        .post('/api/v1/ai/recommendations/replay')
        .set('Authorization', authorization)
        .send({ ...REQUEST, invented_version: '9.9.9' }),
      request(app)
        .post('/api/v1/ai/recommendations/replay')
        .set('Authorization', authorization)
        .send({ ...REQUEST, trading_day: '2026-02-30' }),
      request(app)
        .post('/api/v1/ai/recommendations/replay')
        .set('Authorization', authorization)
        .send({ ...REQUEST, profile: 'japan_blue_chip' }),
      request(app)
        .get(`/api/v1/ai/recommendations/status?job_id=${JOB_ID}&extra=1`)
        .set('Authorization', authorization),
      request(app)
        .get('/api/v1/ai/recommendations/status?job_id=NOT-A-UUID')
        .set('Authorization', authorization),
    ]);
    assert(
      'invalid/extra fields return 400',
      invalidRequests.every(result => result.status === 400)
    );
    assert(
      'invalid requests cause no port effects',
      pins.calls.length + replay.status_calls.length === effectsBeforeInvalid
    );

    const errorCases: Array<{
      label: string;
      status: number;
      pins_error?: Error;
      replay_error?: Error;
    }> = [
      { label: 'capture not found', status: 404, pins_error: new ReplayPinsNotFoundError() },
      { label: 'capture ambiguous', status: 409, pins_error: new ReplayPinsConflictError() },
      {
        label: 'capture unavailable',
        status: 503,
        pins_error: new ReplayPinsStoreUnavailableError(),
      },
      { label: 'request cap', status: 413, replay_error: new ReplayCliInputTooLargeError() },
      { label: 'global backpressure', status: 503, replay_error: new ReplayBackpressureError() },
      {
        label: 'invalid pins',
        status: 422,
        replay_error: new ReplayCliRejectedError('INVALID_REPLAY_PINS', 'invalid replay pins', 3),
      },
      { label: 'bad child protocol', status: 502, replay_error: new ReplayCliProtocolError() },
      { label: 'child unavailable', status: 503, replay_error: new ReplayCliUnavailableError() },
      { label: 'child timeout', status: 504, replay_error: new ReplayCliTimeoutError() },
    ];
    for (const testCase of errorCases) {
      const errorPins = new FakePins();
      const errorReplay = new FakeReplay();
      errorPins.error = testCase.pins_error;
      errorReplay.submit_error = testCase.replay_error;
      const response = await request(buildApp(errorPins, errorReplay))
        .post('/api/v1/ai/recommendations/replay')
        .set('Authorization', authorization)
        .send(REQUEST);
      assert(
        `${testCase.label} maps to ${testCase.status}`,
        response.status === testCase.status,
        `got=${response.status}`
      );
      assert(
        `${testCase.label} response leaks no exception detail`,
        !JSON.stringify(response.body).includes('SECRET')
      );
      if (testCase.label === 'global backpressure') {
        assert(
          'global backpressure is a fixed public response with Retry-After',
          response.headers['retry-after'] === '1' &&
            JSON.stringify(response.body) === JSON.stringify({ error: 'Replay service is busy' })
        );
      }
    }

    const missingStatusReplay = new FakeReplay();
    missingStatusReplay.status_error = new ReplayCliRejectedError(
      'REPLAY_JOB_NOT_FOUND',
      'replay job not found',
      3
    );
    const missingStatus = await request(buildApp(new FakePins(), missingStatusReplay))
      .get(`/api/v1/ai/recommendations/status?job_id=${JOB_ID}`)
      .set('Authorization', authorization);
    assert('missing status maps to 404', missingStatus.status === 404);

    let rateNow = 1_000;
    const ratePins = new FakePins();
    const rateReplay = new FakeReplay();
    const rateApp = buildApp(
      ratePins,
      rateReplay,
      {
        ...LIMITS,
        submit_rate_per_minute: 1,
        status_rate_per_minute: 1,
      },
      () => rateNow
    );
    const admittedSubmit = await request(rateApp)
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', authorization)
      .send(REQUEST);
    const deniedSubmit = await request(rateApp)
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', authorization)
      .send(REQUEST);
    assert('first authenticated submit is admitted', admittedSubmit.status === 202);
    assert(
      'per-user submit excess returns sanitized 429 with Retry-After',
        deniedSubmit.status === 429 &&
        deniedSubmit.headers['retry-after'] === '60' &&
        JSON.stringify(deniedSubmit.body) ===
          JSON.stringify({ error: 'Replay rate limit exceeded' })
    );
    assert('rate-limited submit has no pins or replay effects', ratePins.calls.length === 1);

    const secondUserToken = jwt.sign(
      { user_id: 8, username: 'second-replay-user', role: 'analyst', type: 'access' },
      JWT_SECRET,
      {
        algorithm: 'HS256',
        issuer: 'stocks-backend',
        audience: 'stocks-api',
        expiresIn: '5m',
      }
    );
    const secondUser = await request(rateApp)
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', `Bearer ${secondUserToken}`)
      .send(REQUEST);
    assert('submit limiter is isolated by authenticated user id', secondUser.status === 202);

    const admittedStatus = await request(rateApp)
      .get(`/api/v1/ai/recommendations/status?job_id=${JOB_ID}`)
      .set('Authorization', authorization);
    const deniedStatus = await request(rateApp)
      .get(`/api/v1/ai/recommendations/status?job_id=${JOB_ID}`)
      .set('Authorization', authorization);
    assert('first authenticated status request is admitted', admittedStatus.status === 200);
    assert('per-user status excess returns 429', deniedStatus.status === 429);
    assert('rate-limited status has no replay effect', rateReplay.status_calls.length === 1);

    rateNow += 60_000;
    const resetStatus = await request(rateApp)
      .get(`/api/v1/ai/recommendations/status?job_id=${JOB_ID}`)
      .set('Authorization', authorization);
    assert('status rate window resets after one minute', resetStatus.status === 200);
  } finally {
    (User as any).findByPk = originalFindByPk;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
