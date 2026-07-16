import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { buildRecommendationReplayRoutes } from '../../src/api/routes/recommendationReplay.routes';
import { buildRecommendationSnapshotRoutes } from '../../src/api/routes/recommendationSnapshot.routes';
import { buildDailyReportProjectionRoutes } from '../../src/api/routes/dailyReportProjection.routes';
import { sequelize as authSequelize } from '../../src/config/database';
import { User } from '../../src/models/User';
import { DailyReportProjectionService } from '../../src/projections/DailyReportProjectionService';
import { ProjectionCliClient } from '../../src/projections/ProjectionCliClient';
import { SequelizeRecommendationSnapshotReadAdapter } from '../../src/recommendations/SequelizeRecommendationSnapshotReadAdapter';
import { ReplayCliClient } from '../../src/replay/ReplayCliClient';
import type { ReplayJob } from '../../src/replay/ReplayContract';
import { ReplayJobSupervisor } from '../../src/replay/ReplayJobSupervisor';
import { SequelizeReplayPinsReadAdapter } from '../../src/replay/ReplayPinsReadPort';
import { connectDisposablePostgres } from './disposablePostgres';

type ReplayRequest = {
  trading_day: string;
  profile: 'us_preferred';
  market_scope: 'us';
};

type SeedCapture = {
  request: ReplayRequest;
  capture_id: string;
  pins: {
    trading_day: string;
    as_of: string;
    profile: string;
    market_scope: string;
    profile_version: string;
    contract_version: string;
    input_fingerprint: string;
    strategy_version: string;
    pipeline_version: string;
  };
};

type SeedManifest = {
  generated_from: 'typed-capture-writer';
  captures: SeedCapture[];
  negative: {
    future_source: true;
    wrong_scope: true;
    malformed_hash: true;
    duplicate_fact: true;
    idempotent_capture: true;
  };
};

const AUTH_USER_ID = 7006;
const CHILD_SECRET = 'T67_CHILD_SECRET_MUST_NOT_LEAK';

function buildApp(sequelize: Sequelize, replay: ReplayJobSupervisor): express.Express {
  const snapshots = new SequelizeRecommendationSnapshotReadAdapter(sequelize);
  const projections = new DailyReportProjectionService(
    snapshots,
    new ProjectionCliClient({ timeout_ms: 30_000, env: process.env })
  );
  const app = express();
  // The Jest/jsdom fetch implementation applies browser CORS checks.  The
  // production app installs CORS above these routers; mirror that boundary in
  // this intentionally minimal live app so localhost traffic remains real.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  // Static replay routes must precede the snapshot /:snapshot_id route.
  app.use(
    '/api/v1/ai/recommendations',
    buildRecommendationReplayRoutes(new SequelizeReplayPinsReadAdapter(sequelize), replay)
  );
  app.use(
    '/api/v1/ai/recommendations',
    buildRecommendationSnapshotRoutes(snapshots)
  );
  app.use('/api/v1/daily-report', buildDailyReportProjectionRoutes(projections));
  return app;
}

function supervisor(httpWaitMs: number): ReplayJobSupervisor {
  return new ReplayJobSupervisor(
    new ReplayCliClient({ timeout_ms: 30_000, env: process.env }),
    {
      http_wait_ms: httpWaitMs,
      control_timeout_ms: 30_000,
      on_background_error: error => console.error('background replay error', error),
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
    attempt < 100 && (job.status === 'queued' || job.status === 'running');
    attempt += 1
  ) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const status = await request(app)
      .get(`/api/v1/ai/recommendations/status?job_id=${encodeURIComponent(job.job_id)}`)
      .set('Authorization', authorization);
    assert.equal(status.status, 200, status.text);
    job = status.body as ReplayJob;
  }
  assert.ok(job.status === 'completed' || job.status === 'failed', JSON.stringify(job));
  return job;
}

function completed(job: ReplayJob): asserts job is Extract<ReplayJob, { status: 'completed' }> {
  assert.equal(job.status, 'completed', JSON.stringify(job));
}

async function listen(app: express.Express): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function closeServer(server: http.Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  if (process.env.T67_TOTAL_LIVE_HTTP_TEST !== '1') {
    console.log('tab67-total-live-http: SKIP (guarded disposable-PG harness only)');
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.JWT_SECRET;
  const manifestPath = process.env.T67_SEED_MANIFEST;
  const artifactPath = process.env.T67_RESPONSE_ARTIFACT;
  assert.ok(databaseUrl, 'DATABASE_URL is required');
  assert.ok(jwtSecret, 'JWT_SECRET is required');
  assert.ok(manifestPath, 'T67_SEED_MANIFEST is required');
  assert.ok(artifactPath, 'T67_RESPONSE_ARTIFACT is required');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SeedManifest;
  assert.equal(manifest.generated_from, 'typed-capture-writer');
  assert.equal(manifest.captures.length, 3);
  assert.deepEqual(manifest.negative, {
    future_source: true,
    wrong_scope: true,
    malformed_hash: true,
    duplicate_fact: true,
    idempotent_capture: true,
  });

  const sequelize = connectDisposablePostgres(databaseUrl);
  let server: http.Server | undefined;
  try {
    const authUser = await User.findByPk(AUTH_USER_ID);
    assert.ok(authUser?.is_active, 'disposable-PG auth user must be active');
    const authorization = `Bearer ${jwt.sign(
      {
        user_id: authUser.id,
        username: authUser.username,
        role: authUser.role,
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

    const firstApp = buildApp(sequelize, supervisor(10_000));
    const unauthorized = await request(firstApp)
      .post('/api/v1/ai/recommendations/replay')
      .send(manifest.captures[0].request);
    assert.equal(unauthorized.status, 401, unauthorized.text);

    const jobs: Array<Extract<ReplayJob, { status: 'completed' }>> = [];
    for (const capture of manifest.captures.slice(0, 2)) {
      const submitted = await request(firstApp)
        .post('/api/v1/ai/recommendations/replay')
        .set('Authorization', authorization)
        .send(capture.request);
      assert.ok(submitted.status === 200 || submitted.status === 202, submitted.text);
      const job = await terminalJob(firstApp, authorization, submitted.body as ReplayJob);
      completed(job);
      jobs.push(job);
    }

    // New supervisor instance proves terminal status is recovered from the durable file store.
    const restartedApp = buildApp(sequelize, supervisor(0));
    for (const job of jobs) {
      const recovered = await request(restartedApp)
        .get(`/api/v1/ai/recommendations/status?job_id=${encodeURIComponent(job.job_id)}`)
        .set('Authorization', authorization);
      assert.equal(
        recovered.status,
        200,
        JSON.stringify({ text: recovered.text, body: recovered.body })
      );
      assert.deepEqual(recovered.body, job);
    }
    const repeated = await request(restartedApp)
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', authorization)
      .send(manifest.captures[1].request);
    assert.equal(repeated.status, 200, repeated.text);
    assert.deepEqual(repeated.body, jobs[1]);

    const wrongScope = await request(restartedApp)
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', authorization)
      .send({
        trading_day: manifest.captures[2].request.trading_day,
        profile: 'japan_blue_chip',
        market_scope: 'us',
      });
    assert.equal(wrongScope.status, 400, wrongScope.text);
    const malformedRequest = await request(restartedApp)
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', authorization)
      .send({ ...manifest.captures[2].request, input_fingerprint: 'not-authoritative' });
    assert.equal(malformedRequest.status, 400, malformedRequest.text);

    // Exercise an actual crashing child and prove its private stderr never reaches HTTP.
    const crashingReplay = new ReplayJobSupervisor(
      new ReplayCliClient({
        command: process.execPath,
        args: ['-e', `process.stderr.write(${JSON.stringify(CHILD_SECRET)});process.exit(7)`],
        env: process.env,
        timeout_ms: 5_000,
      }),
      { http_wait_ms: 5_000, control_timeout_ms: 5_000 }
    );
    const childCrash = await request(buildApp(sequelize, crashingReplay))
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', authorization)
      .send(manifest.captures[2].request);
    assert.equal(childCrash.status, 502, childCrash.text);
    assert.ok(!childCrash.text.includes(CHILD_SECRET), childCrash.text);

    const [firstJob, secondJob] = jobs;
    const firstCapture = manifest.captures[0];
    const secondCapture = manifest.captures[1];
    const latest = await request(restartedApp)
      .get('/api/v1/ai/recommendations/latest?profile=us_preferred&market_scope=us')
      .set('Authorization', authorization);
    assert.equal(latest.status, 200, latest.text);
    assert.equal(latest.body.snapshot_id, secondJob.snapshot_id);
    assert.equal(latest.body.meta.input_fingerprint, secondCapture.pins.input_fingerprint);
    assert.match(latest.body.output_fingerprint, /^[0-9a-f]{64}$/);

    const byDate = await request(restartedApp)
      .get(
        `/api/v1/ai/recommendations/by-date/${firstCapture.request.trading_day}` +
          '?profile=us_preferred&market_scope=us&page=1&page_size=20'
      )
      .set('Authorization', authorization);
    assert.equal(byDate.status, 200, byDate.text);
    assert.equal(byDate.body.total, 1);
    assert.equal(byDate.body.entries[0].snapshot_id, firstJob.snapshot_id);

    const details = [];
    for (const [index, job] of jobs.entries()) {
      const detail = await request(restartedApp)
        .get(`/api/v1/ai/recommendations/${encodeURIComponent(job.snapshot_id)}`)
        .set('Authorization', authorization);
      assert.equal(detail.status, 200, detail.text);
      assert.equal(detail.body.items.length, 1);
      assert.equal(
        detail.body.meta.input_fingerprint,
        manifest.captures[index].pins.input_fingerprint
      );
      details.push(detail.body);
    }

    const diff = await request(restartedApp)
      .get(
        `/api/v1/ai/recommendations/${firstJob.snapshot_id}/diff/${secondJob.snapshot_id}`
      )
      .set('Authorization', authorization);
    assert.equal(diff.status, 200, diff.text);
    assert.equal(diff.body.base_snapshot_id, firstJob.snapshot_id);
    assert.equal(diff.body.target_snapshot_id, secondJob.snapshot_id);
    assert.equal(diff.body.profile, 'us_preferred');
    assert.equal(diff.body.market_scope, 'us');
    assert.ok(
      [...diff.body.added, ...diff.body.removed, ...diff.body.changed, ...diff.body.unchanged]
        .includes('7203')
    );

    const dailyLatest = await request(restartedApp)
      .get('/api/v1/daily-report/latest?profile=us_preferred&market_scope=us')
      .set('Authorization', authorization);
    assert.equal(dailyLatest.status, 200, dailyLatest.text);
    assert.equal(dailyLatest.body.source_snapshot_id, secondJob.snapshot_id);
    assert.equal(dailyLatest.body.trading_day, secondCapture.request.trading_day);

    const dailyByDate = await request(restartedApp)
      .get(
        `/api/v1/daily-report/${firstCapture.request.trading_day}` +
          '?profile=us_preferred&market_scope=us'
      )
      .set('Authorization', authorization);
    assert.equal(dailyByDate.status, 200, dailyByDate.text);
    assert.equal(dailyByDate.body.source_snapshot_id, firstJob.snapshot_id);

    const history = await request(restartedApp)
      .get('/api/v1/daily-report/history?profile=us_preferred&market_scope=us')
      .set('Authorization', authorization);
    assert.equal(history.status, 200, history.text);
    assert.equal(history.body.total, 2);
    assert.deepEqual(
      history.body.entries.map((entry: { source_snapshot_id: string }) => entry.source_snapshot_id),
      [secondJob.snapshot_id, firstJob.snapshot_id]
    );
    const queriedHistory = await request(restartedApp)
      .get('/api/v1/daily-report/history?query=7203&profile=us_preferred&market_scope=us')
      .set('Authorization', authorization);
    assert.equal(queriedHistory.status, 200, queriedHistory.text);
    assert.equal(queriedHistory.body.total, 2);

    const counts = await sequelize.query<{ snapshots: string; items: string; captures: string }>(
      `SELECT
         (SELECT COUNT(*) FROM ai_recommendation_snapshot)::TEXT AS snapshots,
         (SELECT COUNT(*) FROM ai_recommendation_item)::TEXT AS items,
         (SELECT COUNT(*) FROM ai_replay_typed_source_capture)::TEXT AS captures`,
      { type: QueryTypes.SELECT }
    );
    assert.deepEqual(counts[0], { snapshots: '2', items: '2', captures: '3' });

    const physicalPins = await sequelize.query<Record<string, unknown>>(
      `SELECT trading_day::TEXT AS trading_day,
              TO_CHAR(as_of_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS as_of,
              profile, market_scope, profile_version, contract_version,
              input_fingerprint, strategy_version, pipeline_version
         FROM ai_replay_typed_source_capture
        ORDER BY trading_day`,
      { type: QueryTypes.SELECT }
    );
    assert.deepEqual(
      physicalPins.map(row => ({ ...row })),
      manifest.captures.map(capture => capture.pins)
    );

    server = await listen(restartedApp);
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>(resolve => {
      resolveShutdown = resolve;
    });
    let signalled = false;
    const onSignal = () => {
      if (signalled) return;
      signalled = true;
      resolveShutdown();
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);

    const artifact = {
      generated_from: 'live-disposable-postgresql',
      base_url: baseUrl,
      authorization,
      profile: 'us_preferred',
      market_scope: 'us',
      initial_snapshot_count: 2,
      initial_item_count: 2,
      generation_request: manifest.captures[2].request,
      seeded_captures: manifest.captures,
      completed_jobs: jobs,
      latest: dailyLatest.body,
      by_date: dailyByDate.body,
      history: history.body,
      details,
      diff: diff.body,
      negative: {
        ...manifest.negative,
        wrong_scope_http: wrongScope.status,
        malformed_request_http: malformedRequest.status,
        child_crash_http: childCrash.status,
        child_secret_redacted: !childCrash.text.includes(CHILD_SECRET),
      },
    };
    const temporary = `${artifactPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, artifactPath);
    console.log(`tab67-total-live-http: READY ${baseUrl}`);
    await shutdown;
  } finally {
    await closeServer(server).catch(() => undefined);
    await sequelize.close().catch(() => undefined);
    await authSequelize.close().catch(() => undefined);
  }
  console.log('tab67-total-live-http: STOPPED');
}

main().catch(error => {
  console.error('tab67-total-live-http: FAIL', error);
  process.exitCode = 1;
});
