import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import jpkrMarketRoutes from '../../src/api/routes/jpkrMarket.routes';
import { buildRecommendationReplayRoutes } from '../../src/api/routes/recommendationReplay.routes';
import { buildRecommendationSnapshotRoutes } from '../../src/api/routes/recommendationSnapshot.routes';
import { sequelize as authSequelize } from '../../src/config/database';
import { User } from '../../src/models/User';
import { SequelizeRecommendationSnapshotReadAdapter } from '../../src/recommendations/SequelizeRecommendationSnapshotReadAdapter';
import {
  unavailableRecommendationSnapshotReadPort,
  type RecommendationSnapshotReadPort,
  type RecommendationSnapshotScope,
} from '../../src/recommendations/RecommendationSnapshotReadPort';
import { ReplayCliClient } from '../../src/replay/ReplayCliClient';
import type { ReplayJob } from '../../src/replay/ReplayContract';
import { ReplayJobSupervisor } from '../../src/replay/ReplayJobSupervisor';
import { SequelizeReplayPinsReadAdapter } from '../../src/replay/ReplayPinsReadPort';

type JsonObject = Record<string, any>;

type SeedManifest = {
  generated_from: 'controlled-official-jp-fixture';
  fixture_disclaimer: string;
  trading_day: string;
  capture: {
    request: {
      trading_day: string;
      profile: 'japan_blue_chip';
      market_scope: 'jp';
    };
    capture_id: string;
    capture_hash: string;
    ticker: string;
    score_fact_hash: string;
    pins: {
      trading_day: string;
      as_of: string;
      profile: 'japan_blue_chip';
      market_scope: 'jp';
      profile_version: string;
      contract_version: '0.3.1';
      input_fingerprint: string;
      strategy_version: string;
      pipeline_version: string;
    };
  };
  facts: {
    security: { count: number; ticker: string; fact_hash: string; available_at_utc: string };
    kline: {
      count: number;
      ticker: string;
      fact_hash: string;
      trading_day: string;
      available_at_utc: string;
    };
    financial: { count: number; fact_hash: string; available_at_utc: string };
    disclosure: {
      count: number;
      fact_hash: string;
      available_at_utc: string;
      title: string;
    };
    fx: {
      count: number;
      latest_fact_hash: string;
      latest_observation_day: string;
      latest_rate: number;
      available_at_utc: string;
    };
  };
};

const AUTH_USER_ID = 7013;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

function installCors(app: express.Express): void {
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
}

function buildApp(
  database: Sequelize,
  replay: ReplayJobSupervisor,
  latestCalls: { latest: number }
): express.Express {
  const app = express();
  installCors(app);
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/v1/jpkr-market', jpkrMarketRoutes);
  app.use(
    '/api/v1/ai/recommendations',
    buildRecommendationReplayRoutes(new SequelizeReplayPinsReadAdapter(database), replay)
  );
  app.use(
    '/api/v1/ai/recommendations',
    buildRecommendationSnapshotRoutes(
      trackedSnapshotPort(new SequelizeRecommendationSnapshotReadAdapter(database), latestCalls)
    )
  );
  return app;
}

function buildUnavailableApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/ai/recommendations',
    buildRecommendationSnapshotRoutes(unavailableRecommendationSnapshotReadPort)
  );
  return app;
}

function supervisor(): ReplayJobSupervisor {
  return new ReplayJobSupervisor(new ReplayCliClient({ timeout_ms: 30_000, env: process.env }), {
    http_wait_ms: 10_000,
    control_timeout_ms: 30_000,
    on_background_error: error => console.error('tab3 replay background error', error),
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

function recommendationArtifact(snapshot: JsonObject, recommendation: JsonObject): JsonObject {
  const evidence = (recommendation.evidence_refs as JsonObject[]).find(
    item => item.kind === 'SCORE_INPUT'
  );
  assert.ok(evidence, 'SCORE_INPUT evidence must survive the replay pipeline');
  return {
    snapshot_id: snapshot.snapshot_id,
    profile: snapshot.profile,
    market_scope: snapshot.market_scope,
    contract_version: snapshot.meta.contract_version,
    as_of: snapshot.as_of,
    score: {
      total: recommendation.score.total,
      rating: recommendation.score.rating,
      scoring_id: recommendation.score.scoring_id,
    },
    conviction: {
      final: recommendation.conviction.final,
      level: recommendation.conviction.level,
    },
    risk_gate: {
      gate: recommendation.risk_gate.gate,
      trigger_code: recommendation.risk_gate.triggers[0]?.code,
    },
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
      input_fingerprint: snapshot.meta.input_fingerprint,
      output_fingerprint: snapshot.output_fingerprint,
      pipeline_version: snapshot.meta.pipeline_version,
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
  if (process.env.TAB3_JPKR_LIVE_HTTP_TEST !== '1') {
    console.log('tab3-jpkr-live-http: SKIP (guarded disposable-PG harness only)');
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.JWT_SECRET;
  const manifestPath = process.env.TAB3_JPKR_SEED_MANIFEST;
  const artifactPath = process.env.TAB3_JPKR_RESPONSE_ARTIFACT;
  assert.ok(databaseUrl, 'DATABASE_URL is required');
  assert.ok(jwtSecret, 'JWT_SECRET is required');
  assert.ok(manifestPath, 'TAB3_JPKR_SEED_MANIFEST is required');
  assert.ok(artifactPath, 'TAB3_JPKR_RESPONSE_ARTIFACT is required');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SeedManifest;
  assert.equal(manifest.generated_from, 'controlled-official-jp-fixture');
  assert.match(manifest.fixture_disclaimer, /not production real-time/i);
  assert.equal(manifest.capture.request.profile, 'japan_blue_chip');
  assert.equal(manifest.capture.request.market_scope, 'jp');
  assert.equal(manifest.capture.ticker, manifest.facts.kline.ticker);

  const database = new Sequelize(databaseUrl, { logging: false });
  let server: http.Server | undefined;
  let marketQueries = 0;
  const queryHook = () => {
    marketQueries += 1;
  };
  authSequelize.addHook('beforeQuery', 'tab3-live-query-counter', queryHook);
  try {
    const authUser = await User.findByPk(AUTH_USER_ID);
    assert.ok(authUser?.is_active, 'disposable-PG auth user must be active');
    const authorization = `Bearer ${jwt.sign(
      { user_id: authUser.id, username: authUser.username, role: authUser.role },
      jwtSecret,
      { expiresIn: '10m' }
    )}`;
    const latestCalls = { latest: 0 };
    const app = buildApp(database, supervisor(), latestCalls);

    const queriesBeforeUnauthorized = marketQueries;
    const unauthorizedMarket = await request(app).get(
      `/api/v1/jpkr-market/${manifest.trading_day}?market=JP`
    );
    assert.equal(unauthorizedMarket.status, 401, unauthorizedMarket.text);
    assert.equal(
      marketQueries,
      queriesBeforeUnauthorized,
      'market authentication must run before database handlers'
    );
    const unauthorizedDbReads = marketQueries - queriesBeforeUnauthorized;
    const unauthorizedRecommendation = await request(app).get(
      '/api/v1/ai/recommendations/latest?profile=japan_blue_chip&market_scope=jp'
    );
    assert.equal(unauthorizedRecommendation.status, 401, unauthorizedRecommendation.text);
    assert.equal(latestCalls.latest, 0, 'recommendation authentication must run before handler');

    const submitted = await request(app)
      .post('/api/v1/ai/recommendations/replay')
      .set('Authorization', authorization)
      .send(manifest.capture.request);
    assert.ok(submitted.status === 200 || submitted.status === 202, submitted.text);
    const job = await terminalJob(app, authorization, submitted.body as ReplayJob);

    const latest = await request(app)
      .get('/api/v1/ai/recommendations/latest?profile=japan_blue_chip&market_scope=jp')
      .set('Authorization', authorization);
    assert.equal(latest.status, 200, latest.text);
    assert.equal(latest.body.snapshot_id, job.snapshot_id);
    assert.equal(latest.body.as_of, manifest.capture.pins.as_of);
    assert.equal(latest.body.profile, manifest.capture.pins.profile);
    assert.equal(latest.body.market_scope, manifest.capture.pins.market_scope);
    assert.equal(latest.body.meta.contract_version, '0.3.1');
    assert.equal(latest.body.meta.input_fingerprint, manifest.capture.pins.input_fingerprint);
    assert.equal(latest.body.meta.profile_version, manifest.capture.pins.profile_version);
    assert.equal(latest.body.meta.strategy_version, manifest.capture.pins.strategy_version);
    assert.equal(latest.body.meta.pipeline_version, manifest.capture.pins.pipeline_version);
    assert.equal(latest.body.items.length, 1);
    const recommendation = latest.body.items[0].recommendation as JsonObject;
    assert.equal(recommendation.ticker, manifest.capture.ticker);
    assert.equal(recommendation.score.profile, 'japan_blue_chip');
    assert.equal(recommendation.score.market_scope, 'jp');
    assert.equal(recommendation.risk_gate.gate, 'GREEN');
    assert.deepEqual(recommendation.risk_gate.triggers, []);
    assert.equal(recommendation.entry_plan.entry.currency, 'JPY');
    assert.match(latest.body.output_fingerprint, /^[0-9a-f]{64}$/);

    const detailSnapshot = await request(app)
      .get(`/api/v1/ai/recommendations/${encodeURIComponent(job.snapshot_id)}`)
      .set('Authorization', authorization);
    assert.equal(detailSnapshot.status, 200, detailSnapshot.text);
    assert.equal(
      sha256(detailSnapshot.body.fingerprint_preimage_jcs),
      detailSnapshot.body.output_fingerprint,
      'recommendation fingerprint preimage must remain physically authentic'
    );

    const market = await request(app)
      .get(`/api/v1/jpkr-market/${manifest.trading_day}?market=JP`)
      .set('Authorization', authorization);
    assert.equal(market.status, 200, market.text);
    assert.equal(market.body.rows.length, 1);
    const marketRow = market.body.rows[0] as JsonObject;
    assert.equal(marketRow.symbol, manifest.capture.ticker);
    assert.equal(marketRow.close, 4505);
    assert.equal(marketRow.currency, 'JPY');
    assert.equal(marketRow.disclosure_events[0]?.title, manifest.facts.disclosure.title);
    assert.equal(marketRow.disclosure_events[0]?.source, 'jpx-edinet');
    assert.equal(marketRow.revenue_by_region[0]?.region, 'Japan');
    assert.equal(marketRow.fx_beta, 0.42);
    assert.equal(market.body.kpi.usdjpy.rate, manifest.facts.fx.latest_rate);
    assert.equal(market.body.kpi.usdjpy.as_of, manifest.facts.fx.latest_observation_day);

    const marketDetail = await request(app)
      .get(
        `/api/v1/jpkr-market/${encodeURIComponent(manifest.capture.ticker)}/detail?date=${
          manifest.trading_day
        }`
      )
      .set('Authorization', authorization);
    assert.equal(marketDetail.status, 200, marketDetail.text);
    assert.equal(marketDetail.body.symbol, manifest.capture.ticker);

    const missingDetail = await request(app)
      .get(`/api/v1/jpkr-market/NOSUCH/detail?date=${manifest.trading_day}`)
      .set('Authorization', authorization);
    assert.equal(missingDetail.status, 404, missingDetail.text);
    const missingRecommendation = await request(app)
      .get('/api/v1/ai/recommendations/latest?profile=japan_multibagger&market_scope=jp')
      .set('Authorization', authorization);
    assert.equal(missingRecommendation.status, 404, missingRecommendation.text);
    const unavailableRecommendation = await request(buildUnavailableApp())
      .get('/api/v1/ai/recommendations/latest?profile=japan_blue_chip&market_scope=jp')
      .set('Authorization', authorization);
    assert.equal(unavailableRecommendation.status, 503, unavailableRecommendation.text);

    const physical = await database.query<Record<string, any>>(
      `SELECT
         (SELECT COUNT(*) FROM jpkr_security_master)::INTEGER AS securities,
         (SELECT COUNT(*) FROM jpkr_daily_kline)::INTEGER AS klines,
         (SELECT COUNT(*) FROM jpkr_financial_snapshot)::INTEGER AS financials,
         (SELECT COUNT(*) FROM jpkr_disclosure_event)::INTEGER AS disclosures,
         (SELECT COUNT(*) FROM jpkr_fx_observation)::INTEGER AS fx,
         (SELECT COUNT(*) FROM ai_replay_typed_source_capture)::INTEGER AS captures,
         (SELECT COUNT(*) FROM ai_recommendation_snapshot)::INTEGER AS snapshots,
         (SELECT COUNT(*) FROM ai_recommendation_item)::INTEGER AS items`,
      { type: QueryTypes.SELECT }
    );
    assert.deepEqual(physical[0], {
      securities: manifest.facts.security.count,
      klines: manifest.facts.kline.count,
      financials: manifest.facts.financial.count,
      disclosures: manifest.facts.disclosure.count,
      fx: manifest.facts.fx.count,
      captures: 1,
      snapshots: 1,
      items: 1,
    });
    const physicalFacts = await database.query<Record<string, any>>(
      `SELECT
         (SELECT fact_hash FROM jpkr_security_master WHERE ticker = :ticker LIMIT 1) AS security_hash,
         (SELECT fact_hash FROM jpkr_daily_kline WHERE ticker = :ticker LIMIT 1) AS kline_hash,
         (SELECT fact_hash FROM jpkr_financial_snapshot WHERE ticker = :ticker LIMIT 1) AS financial_hash,
         (SELECT fact_hash FROM jpkr_disclosure_event WHERE ticker = :ticker LIMIT 1) AS disclosure_hash,
         (SELECT fact_hash FROM jpkr_fx_observation ORDER BY observation_day DESC LIMIT 1) AS fx_hash,
         (SELECT BOOL_AND(available_at_utc <= CAST(:cutoff AS timestamptz))
            FROM jpkr_security_master) AS security_pit,
         (SELECT BOOL_AND(available_at_utc <= CAST(:cutoff AS timestamptz))
            FROM jpkr_daily_kline) AS kline_pit,
         (SELECT BOOL_AND(available_at_utc <= CAST(:cutoff AS timestamptz))
            FROM jpkr_financial_snapshot) AS financial_pit,
         (SELECT BOOL_AND(available_at_utc <= CAST(:cutoff AS timestamptz))
            FROM jpkr_disclosure_event) AS disclosure_pit,
         (SELECT BOOL_AND(available_at_utc <= CAST(:cutoff AS timestamptz))
            FROM jpkr_fx_observation) AS fx_pit`,
      {
        replacements: {
          ticker: manifest.capture.ticker,
          cutoff: `${manifest.trading_day}T23:59:59.999Z`,
        },
        type: QueryTypes.SELECT,
      }
    );
    assert.deepEqual(physicalFacts[0], {
      security_hash: manifest.facts.security.fact_hash,
      kline_hash: manifest.facts.kline.fact_hash,
      financial_hash: manifest.facts.financial.fact_hash,
      disclosure_hash: manifest.facts.disclosure.fact_hash,
      fx_hash: manifest.facts.fx.latest_fact_hash,
      security_pit: true,
      kline_pit: true,
      financial_pit: true,
      disclosure_pit: true,
      fx_pit: true,
    });
    const captureRows = await database.query<Record<string, any>>(
      `SELECT trading_day::TEXT AS trading_day,
              TO_CHAR(as_of_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS as_of,
              profile,
              market_scope,
              profile_version,
              contract_version,
              input_fingerprint,
              strategy_version,
              pipeline_version,
              capture_hash,
              scores_json->0->>'fact_hash' AS score_fact_hash,
              available_at_utc <= as_of_utc AS capture_pit
         FROM ai_replay_typed_source_capture
        WHERE capture_id = CAST(:capture_id AS uuid)`,
      {
        replacements: { capture_id: manifest.capture.capture_id },
        type: QueryTypes.SELECT,
      }
    );
    assert.equal(captureRows.length, 1);
    const capture = captureRows[0];
    assert.deepEqual(
      {
        trading_day: capture.trading_day,
        as_of: capture.as_of,
        profile: capture.profile,
        market_scope: capture.market_scope,
        profile_version: capture.profile_version,
        contract_version: capture.contract_version,
        input_fingerprint: capture.input_fingerprint,
        strategy_version: capture.strategy_version,
        pipeline_version: capture.pipeline_version,
      },
      manifest.capture.pins
    );
    assert.equal(capture.capture_hash, manifest.capture.capture_hash);
    assert.equal(capture.score_fact_hash, manifest.capture.score_fact_hash);
    assert.equal(capture.capture_pit, true);

    server = await listen(app);
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const liveMarket = await request(baseUrl)
      .get(`/api/v1/jpkr-market/${manifest.trading_day}?market=JP`)
      .set('Authorization', authorization);
    assert.equal(liveMarket.status, 200, liveMarket.text);
    const liveLatest = await request(baseUrl)
      .get('/api/v1/ai/recommendations/latest?profile=japan_blue_chip&market_scope=jp')
      .set('Authorization', authorization);
    assert.equal(liveLatest.status, 200, liveLatest.text);

    const artifact = {
      generated_from: 'controlled-official-jp-fixture-disposable-postgresql',
      fixture_disclaimer: manifest.fixture_disclaimer,
      base_url: baseUrl,
      authorization,
      trading_day: manifest.trading_day,
      expected: {
        symbol: marketRow.symbol,
        name_local: marketRow.name_local,
        name_en: marketRow.name_en,
        close: marketRow.close,
        currency: marketRow.currency,
        data_sources: marketRow.data_sources,
        disclosure: marketRow.disclosure_events[0],
        financial: {
          revenue_region: marketRow.revenue_by_region[0].region,
          revenue_pct: marketRow.revenue_by_region[0].pct,
          fx_beta: marketRow.fx_beta,
        },
        fx: {
          pair: 'USDJPY',
          rate: market.body.kpi.usdjpy.rate,
          as_of: market.body.kpi.usdjpy.as_of,
        },
        recommendation: recommendationArtifact(latest.body, recommendation),
      },
      physical: {
        ...physical[0],
        fact_hashes: {
          security: manifest.facts.security.fact_hash,
          kline: manifest.facts.kline.fact_hash,
          financial: manifest.facts.financial.fact_hash,
          disclosure: manifest.facts.disclosure.fact_hash,
          fx: manifest.facts.fx.latest_fact_hash,
          capture: manifest.capture.capture_hash,
          score: manifest.capture.score_fact_hash,
        },
        pit_checked:
          ['security_pit', 'kline_pit', 'financial_pit', 'disclosure_pit', 'fx_pit'].every(
            key => physicalFacts[0][key] === true
          ) && capture.capture_pit === true,
        capture_pins_match:
          latest.body.as_of === manifest.capture.pins.as_of &&
          latest.body.profile === manifest.capture.pins.profile &&
          latest.body.market_scope === manifest.capture.pins.market_scope &&
          latest.body.meta.profile_version === manifest.capture.pins.profile_version &&
          latest.body.meta.contract_version === manifest.capture.pins.contract_version &&
          latest.body.meta.input_fingerprint === manifest.capture.pins.input_fingerprint &&
          latest.body.meta.strategy_version === manifest.capture.pins.strategy_version &&
          latest.body.meta.pipeline_version === manifest.capture.pins.pipeline_version,
      },
      negative: {
        unauthorized_market: unauthorizedMarket.status,
        unauthorized_recommendation: unauthorizedRecommendation.status,
        unauthorized_db_reads: unauthorizedDbReads,
        missing_detail: missingDetail.status,
        recommendation_not_found: missingRecommendation.status,
        recommendation_unavailable: unavailableRecommendation.status,
      },
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
    console.log(`tab3-jpkr-live-http: READY ${baseUrl}`);
    await shutdown;
  } finally {
    authSequelize.removeHook('beforeQuery', 'tab3-live-query-counter');
    await closeServer(server).catch(() => undefined);
    await database.close().catch(() => undefined);
    await authSequelize.close().catch(() => undefined);
  }
  console.log('tab3-jpkr-live-http: STOPPED');
}

main().catch(error => {
  console.error('tab3-jpkr-live-http: FAIL', error);
  process.exitCode = 1;
});
