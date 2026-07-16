import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { buildRecommendationReplayRoutes } from '../../src/api/routes/recommendationReplay.routes';
import { buildRecommendationSnapshotRoutes } from '../../src/api/routes/recommendationSnapshot.routes';
import { sequelize as authSequelize } from '../../src/config/database';
import { User } from '../../src/models/User';
import { SequelizeRecommendationSnapshotReadAdapter } from '../../src/recommendations/SequelizeRecommendationSnapshotReadAdapter';
import type {
  RecommendationSnapshotReadPort,
  RecommendationSnapshotScope,
} from '../../src/recommendations/RecommendationSnapshotReadPort';
import { ReplayCliClient } from '../../src/replay/ReplayCliClient';
import type { ReplayJob } from '../../src/replay/ReplayContract';
import { ReplayJobSupervisor } from '../../src/replay/ReplayJobSupervisor';
import { SequelizeReplayPinsReadAdapter } from '../../src/replay/ReplayPinsReadPort';

type Scope = 'cn_a' | 'us';

type SeedCapture = {
  request: {
    trading_day: string;
    profile: 'us_preferred';
    market_scope: Scope;
  };
  capture_id: string;
  ticker: string;
  score_fact_hash: string;
  pins: {
    trading_day: string;
    as_of: string;
    profile: 'us_preferred';
    market_scope: Scope;
    profile_version: string;
    contract_version: '0.3.1';
    input_fingerprint: string;
    strategy_version: string;
    pipeline_version: string;
  };
};

type SeedManifest = {
  generated_from: 'typed-capture-writer';
  captures: SeedCapture[];
};

type JsonObject = Record<string, any>;

const AUTH_USER_ID = 7012;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), 'canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  assert.ok(value && typeof value === 'object', 'canonical JSON value is invalid');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

function exactKeys(value: JsonObject, keys: string[], label: string): void {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys are not exact`);
}

function trackedSnapshotPort(
  delegate: SequelizeRecommendationSnapshotReadAdapter,
  calls: { latest: number }
): RecommendationSnapshotReadPort {
  return {
    async latest(scope: RecommendationSnapshotScope) {
      calls.latest += 1;
      return delegate.latest(scope);
    },
    byDate: query => delegate.byDate(query),
    history: query => delegate.history(query),
    detail: snapshotId => delegate.detail(snapshotId),
    diff: (baseSnapshotId, targetSnapshotId) => delegate.diff(baseSnapshotId, targetSnapshotId),
  };
}

function buildApp(
  sequelize: Sequelize,
  replay: ReplayJobSupervisor,
  latestCalls: { latest: number }
): express.Express {
  const snapshots = trackedSnapshotPort(
    new SequelizeRecommendationSnapshotReadAdapter(sequelize),
    latestCalls
  );
  const app = express();
  // Production installs CORS above these routers. Mirror that boundary in the
  // minimal live app so the jsdom containers still use real localhost HTTP.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use(
    '/api/v1/ai/recommendations',
    buildRecommendationReplayRoutes(new SequelizeReplayPinsReadAdapter(sequelize), replay)
  );
  app.use('/api/v1/ai/recommendations', buildRecommendationSnapshotRoutes(snapshots));
  return app;
}

function supervisor(): ReplayJobSupervisor {
  return new ReplayJobSupervisor(new ReplayCliClient({ timeout_ms: 30_000, env: process.env }), {
    http_wait_ms: 10_000,
    control_timeout_ms: 30_000,
    on_background_error: error => console.error('background replay error', error),
  });
}

async function terminalJob(
  app: express.Express,
  authorization: string,
  initial: ReplayJob
): Promise<Extract<ReplayJob, { status: 'completed' }>> {
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
  assert.equal(job.status, 'completed', JSON.stringify(job));
  return job as Extract<ReplayJob, { status: 'completed' }>;
}

function validateLatest(
  body: JsonObject,
  capture: SeedCapture,
  job: Extract<ReplayJob, { status: 'completed' }>
): JsonObject {
  exactKeys(
    body,
    [
      'snapshot_id',
      'as_of',
      'profile',
      'market_scope',
      'items',
      'output_fingerprint',
      'disclaimer',
      'meta',
    ],
    `${capture.request.market_scope} latest envelope`
  );
  assert.equal(body.snapshot_id, job.snapshot_id);
  assert.equal(body.as_of, capture.pins.as_of);
  assert.equal(body.profile, capture.pins.profile);
  assert.equal(body.market_scope, capture.pins.market_scope);
  assert.equal(body.meta.input_fingerprint, capture.pins.input_fingerprint);
  assert.equal(body.meta.pipeline_version, capture.pins.pipeline_version);
  assert.equal(body.meta.contract_version, capture.pins.contract_version);
  assert.match(body.output_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(body.items.length, 1);

  const recommendation = body.items[0].recommendation as JsonObject;
  assert.equal(recommendation.ticker, capture.ticker);
  const score = recommendation.score as JsonObject;
  assert.equal(score.profile, capture.pins.profile);
  assert.equal(score.market_scope, capture.pins.market_scope);
  assert.equal(score.dims.length, 6);
  assert.deepEqual(
    score.dims.map((dimension: JsonObject) => dimension.key),
    ['Q', 'G', 'V', 'M', 'T', 'R']
  );
  assert.match(score.scoring_id, /^[0-9a-f-]{36}$/);
  const scoreBody = { ...score };
  delete scoreBody.scoring_id;
  delete scoreBody.snapshot_hash;
  assert.equal(score.snapshot_hash, sha256(canonicalize(scoreBody)));
  const scoreRef = {
    scoring_id: score.scoring_id,
    snapshot_hash: score.snapshot_hash,
  };

  const conviction = recommendation.conviction as JsonObject;
  assert.equal(conviction.ticker, capture.ticker);
  assert.equal(conviction.as_of, capture.pins.as_of);
  assert.equal(conviction.base, score.total);
  assert.deepEqual(conviction.score_ref, scoreRef);
  assert.equal(conviction.final, score.total);
  assert.equal(conviction.level, 'HIGH');

  const riskGate = recommendation.risk_gate as JsonObject;
  assert.equal(riskGate.ticker, capture.ticker);
  assert.equal(riskGate.gate, 'GREEN');
  assert.equal(riskGate.ok_to_enter, true);

  const entryPlan = recommendation.entry_plan as JsonObject;
  assert.equal(entryPlan.ticker, capture.ticker);
  assert.equal(entryPlan.conviction_ref, conviction.final);
  assert.deepEqual(entryPlan.score_ref, scoreRef);
  assert.ok(entryPlan.entry.low <= entryPlan.entry.high);
  assert.ok(entryPlan.targets.length >= 1);
  assert.ok(entryPlan.invalidation);

  const evidence = (recommendation.evidence_refs as JsonObject[]).find(
    item => item.kind === 'SCORE_INPUT'
  );
  assert.ok(evidence, 'physical SCORE_INPUT evidence is required');
  assert.equal(evidence?.hash, capture.score_fact_hash);
  assert.ok(evidence?.source_uri.endsWith(`/${capture.score_fact_hash}`));
  assert.equal(recommendation.trigger_signals.length > 0, true);
  return recommendation;
}

function artifactScope(
  body: JsonObject,
  capture: SeedCapture,
  recommendation: JsonObject
): JsonObject {
  const evidence = (recommendation.evidence_refs as JsonObject[]).find(
    item => item.kind === 'SCORE_INPUT'
  ) as JsonObject;
  return {
    profile: capture.request.profile,
    market_scope: capture.request.market_scope,
    snapshot_id: body.snapshot_id,
    ticker: recommendation.ticker,
    contract_version: body.meta.contract_version,
    as_of: body.as_of,
    score: {
      total: recommendation.score.total,
      rating: recommendation.score.rating,
      scoring_id: recommendation.score.scoring_id,
      snapshot_hash: recommendation.score.snapshot_hash,
    },
    conviction: {
      final: recommendation.conviction.final,
      level: recommendation.conviction.level,
    },
    risk_gate: { gate: recommendation.risk_gate.gate },
    entry_plan: {
      entry_low: recommendation.entry_plan.entry.low,
      entry_high: recommendation.entry_plan.entry.high,
      currency: recommendation.entry_plan.entry.currency,
      size_tier: recommendation.entry_plan.size_hint.tier,
      invalidation: recommendation.entry_plan.invalidation,
    },
    evidence: {
      id: evidence.id,
      source_uri: evidence.source_uri,
      hash: evidence.hash,
      short_text: evidence.short_text,
    },
    pins: {
      input_fingerprint: body.meta.input_fingerprint,
      output_fingerprint: body.output_fingerprint,
      pipeline_version: body.meta.pipeline_version,
    },
  };
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
  if (process.env.TAB12_RECOMMENDATION_LIVE_HTTP_TEST !== '1') {
    console.log('tab12-recommendation-live-http: SKIP (guarded disposable-PG harness only)');
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.JWT_SECRET;
  const manifestPath = process.env.TAB12_SEED_MANIFEST;
  const artifactPath = process.env.CATDESK_RECOMMENDATION_RESPONSE_ARTIFACT;
  assert.ok(databaseUrl, 'DATABASE_URL is required');
  assert.ok(jwtSecret, 'JWT_SECRET is required');
  assert.ok(manifestPath, 'TAB12_SEED_MANIFEST is required');
  assert.ok(artifactPath, 'CATDESK_RECOMMENDATION_RESPONSE_ARTIFACT is required');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SeedManifest;
  assert.equal(manifest.generated_from, 'typed-capture-writer');
  assert.deepEqual(
    manifest.captures.map(capture => capture.request.market_scope).sort(),
    ['cn_a', 'us']
  );

  const sequelize = new Sequelize(databaseUrl, { logging: false });
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
    const latestCalls = { latest: 0 };
    const app = buildApp(sequelize, supervisor(), latestCalls);

    const unauthorized = await request(app).get(
      '/api/v1/ai/recommendations/latest?profile=us_preferred&market_scope=us'
    );
    assert.equal(unauthorized.status, 401, unauthorized.text);
    assert.equal(latestCalls.latest, 0, 'authentication must run before latest handler');

    const jobs = new Map<Scope, Extract<ReplayJob, { status: 'completed' }>>();
    for (const capture of manifest.captures) {
      const submitted = await request(app)
        .post('/api/v1/ai/recommendations/replay')
        .set('Authorization', authorization)
        .send(capture.request);
      assert.ok(submitted.status === 200 || submitted.status === 202, submitted.text);
      jobs.set(
        capture.request.market_scope,
        await terminalJob(app, authorization, submitted.body as ReplayJob)
      );
    }

    const latestBodies = new Map<Scope, JsonObject>();
    const recommendations = new Map<Scope, JsonObject>();
    for (const capture of manifest.captures) {
      const scope = capture.request.market_scope;
      const latest = await request(app)
        .get(`/api/v1/ai/recommendations/latest?profile=us_preferred&market_scope=${scope}`)
        .set('Authorization', authorization);
      assert.equal(latest.status, 200, latest.text);
      const job = jobs.get(scope);
      assert.ok(job);
      const recommendation = validateLatest(latest.body, capture, job!);
      latestBodies.set(scope, latest.body);
      recommendations.set(scope, recommendation);

      const detail = await request(app)
        .get(`/api/v1/ai/recommendations/${encodeURIComponent(job!.snapshot_id)}`)
        .set('Authorization', authorization);
      assert.equal(detail.status, 200, detail.text);
      assert.equal(
        sha256(detail.body.fingerprint_preimage_jcs),
        detail.body.output_fingerprint,
        'detail must retain the authenticated physical audit preimage'
      );
    }

    const counts = await sequelize.query<{ snapshots: string; items: string; captures: string }>(
      `SELECT
         (SELECT COUNT(*) FROM ai_recommendation_snapshot)::TEXT AS snapshots,
         (SELECT COUNT(*) FROM ai_recommendation_item)::TEXT AS items,
         (SELECT COUNT(*) FROM ai_replay_typed_source_capture)::TEXT AS captures`,
      { type: QueryTypes.SELECT }
    );
    assert.deepEqual(counts[0], { snapshots: '2', items: '2', captures: '2' });

    const physicalPins = await sequelize.query<Record<string, unknown>>(
      `SELECT trading_day::TEXT AS trading_day,
              TO_CHAR(as_of_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS as_of,
              profile, market_scope, profile_version, contract_version,
              input_fingerprint, strategy_version, pipeline_version
         FROM ai_replay_typed_source_capture
        ORDER BY market_scope`,
      { type: QueryTypes.SELECT }
    );
    assert.deepEqual(
      physicalPins.map(row => ({ ...row })),
      [...manifest.captures]
        .sort((left, right) => left.request.market_scope.localeCompare(right.request.market_scope))
        .map(capture => capture.pins)
    );

    server = await listen(app);
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    for (const scope of ['cn_a', 'us'] as const) {
      const liveLatest = await request(baseUrl)
        .get(`api/v1/ai/recommendations/latest?profile=us_preferred&market_scope=${scope}`)
        .set('Authorization', authorization);
      assert.equal(liveLatest.status, 200, liveLatest.text);
      assert.equal(liveLatest.body.snapshot_id, latestBodies.get(scope)?.snapshot_id);
    }

    const artifact = {
      generated_from: 'live-disposable-postgresql',
      base_url: baseUrl,
      authorization,
      us: artifactScope(
        latestBodies.get('us')!,
        manifest.captures.find(capture => capture.request.market_scope === 'us')!,
        recommendations.get('us')!
      ),
      cn_a: artifactScope(
        latestBodies.get('cn_a')!,
        manifest.captures.find(capture => capture.request.market_scope === 'cn_a')!,
        recommendations.get('cn_a')!
      ),
      negative: { unauthorized_latest: unauthorized.status },
    };
    const temporary = `${artifactPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, artifactPath);

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
    console.log(`tab12-recommendation-live-http: READY ${baseUrl}`);
    await shutdown;
  } finally {
    await closeServer(server).catch(() => undefined);
    await sequelize.close().catch(() => undefined);
    await authSequelize.close().catch(() => undefined);
  }
  console.log('tab12-recommendation-live-http: STOPPED');
}

main().catch(error => {
  console.error('tab12-recommendation-live-http: FAIL', error);
  process.exitCode = 1;
});
