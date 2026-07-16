import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { buildRecommendationReplayRoutes } from '../../src/api/routes/recommendationReplay.routes';
import { buildRecommendationSnapshotRoutes } from '../../src/api/routes/recommendationSnapshot.routes';
import { SequelizeRecommendationSnapshotReadAdapter } from '../../src/recommendations/SequelizeRecommendationSnapshotReadAdapter';
import { ReplayCliClient } from '../../src/replay/ReplayCliClient';
import type { ReplayJob } from '../../src/replay/ReplayContract';
import { ReplayJobSupervisor } from '../../src/replay/ReplayJobSupervisor';
import { SequelizeReplayPinsReadAdapter } from '../../src/replay/ReplayPinsReadPort';
import { User } from '../../src/models/User';

const REQUEST = {
  trading_day: '2026-07-10',
  profile: 'japan_blue_chip',
  market_scope: 'jp',
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

function buildApp(sequelize: Sequelize, replay: ReplayJobSupervisor): express.Express {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(
    '/api/v1/ai/recommendations',
    buildRecommendationReplayRoutes(new SequelizeReplayPinsReadAdapter(sequelize), replay)
  );
  app.use(
    '/api/v1/ai/recommendations',
    buildRecommendationSnapshotRoutes(new SequelizeRecommendationSnapshotReadAdapter(sequelize))
  );
  return app;
}

function supervisor(): ReplayJobSupervisor {
  return new ReplayJobSupervisor(
    new ReplayCliClient({
      timeout_ms: 30_000,
      env: process.env,
    }),
    {
      http_wait_ms: 10_000,
      control_timeout_ms: 30_000,
    }
  );
}

async function terminalJob(
  app: express.Express,
  authorization: string,
  initial: ReplayJob
): Promise<ReplayJob> {
  let job = initial;
  for (
    let attempt = 0;
    attempt < 20 && (job.status === 'queued' || job.status === 'running');
    attempt += 1
  ) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const status = await request(app)
      .get(`/api/v1/ai/recommendations/status?job_id=${encodeURIComponent(job.job_id)}`)
      .set('Authorization', authorization);
    if (status.status !== 200) throw new Error(`status failed with ${status.status}`);
    job = status.body as ReplayJob;
  }
  return job;
}

async function main(): Promise<void> {
  if (process.env.RECOMMENDATION_REPLAY_PG_INTEGRATION !== '1') {
    console.log('SKIP: set RECOMMENDATION_REPLAY_PG_INTEGRATION=1 via guarded PG harness');
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.JWT_SECRET;
  const expectedInputFingerprint = process.env.EXPECTED_INPUT_FINGERPRINT;
  if (!databaseUrl || !jwtSecret || !expectedInputFingerprint) {
    console.error('guarded DATABASE_URL, JWT_SECRET and fingerprint are required');
    process.exit(2);
  }

  const sequelize = new Sequelize(databaseUrl, { logging: false });
  const originalFindByPk = User.findByPk;
  const activeUser = {
    id: 7,
    username: 'replay-e2e',
    role: 'analyst',
    is_active: true,
  };
  (User as any).findByPk = async (id: number) => (id === activeUser.id ? activeUser : null);
  const authorization = `Bearer ${jwt.sign(
    {
      user_id: activeUser.id,
      username: activeUser.username,
      role: activeUser.role,
      type: 'access',
    },
    jwtSecret,
    {
      algorithm: 'HS256',
      issuer: 'stocks-backend',
      audience: 'stocks-api',
      expiresIn: '10m',
    }
  )}`;

  try {
    const firstApp = buildApp(sequelize, supervisor());
    const unauthorized = await request(firstApp)
      .post('/api/v1/ai/recommendations/replay')
      .send(REQUEST);
    assert('live replay POST is authenticated', unauthorized.status === 401);

    const submitted = await request(firstApp)
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', authorization)
      .send(REQUEST);
    assert(
      'live replay POST returns accepted or terminal',
      submitted.status === 200 || submitted.status === 202,
      `status=${submitted.status}, body=${JSON.stringify(submitted.body)}`
    );
    const completed = await terminalJob(firstApp, authorization, submitted.body as ReplayJob);
    assert(
      'live replay reaches completed',
      completed.status === 'completed',
      JSON.stringify(completed)
    );
    if (completed.status !== 'completed') throw new Error('live replay did not complete');

    const detail = await request(firstApp)
      .get(`/api/v1/ai/recommendations/${completed.snapshot_id}`)
      .set('Authorization', authorization);
    assert(
      'persisted snapshot is browsable over authenticated HTTP',
      detail.status === 200,
      `status=${detail.status}, body=${JSON.stringify(detail.body)}`
    );
    assert(
      'detail preserves the exact physical source fingerprint',
      detail.body.meta?.input_fingerprint === expectedInputFingerprint
    );
    assert('real pipeline persisted one recommendation item', detail.body.items?.length === 1);

    const restartedApp = buildApp(sequelize, supervisor());
    const recovered = await request(restartedApp)
      .get(`/api/v1/ai/recommendations/status?job_id=${completed.job_id}`)
      .set('Authorization', authorization);
    assert(
      'new Backend supervisor recovers durable terminal status',
      recovered.status === 200 && JSON.stringify(recovered.body) === JSON.stringify(completed)
    );

    const repeated = await request(restartedApp)
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', authorization)
      .send(REQUEST);
    assert(
      'idempotent POST returns the same terminal job',
      repeated.status === 200 && JSON.stringify(repeated.body) === JSON.stringify(completed)
    );

    const counts = await sequelize.query<{ snapshots: string; items: string }>(
      `SELECT
         (SELECT COUNT(*) FROM ai_recommendation_snapshot)::TEXT AS snapshots,
         (SELECT COUNT(*) FROM ai_recommendation_item)::TEXT AS items`,
      { type: QueryTypes.SELECT }
    );
    assert(
      'idempotent HTTP replay has one physical snapshot/item',
      counts[0]?.snapshots === '1' && counts[0]?.items === '1',
      JSON.stringify(counts[0])
    );
  } finally {
    (User as any).findByPk = originalFindByPk;
    await sequelize.close();
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled live replay HTTP error:', error);
  process.exit(1);
});
