import {
  PerUserReplayRateLimiter,
  ReplayOperationalConfigurationError,
  replayOperationalLimits,
} from '../../src/replay/ReplayOperationalLimits';

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

function rejectsConfiguration(env: NodeJS.ProcessEnv): boolean {
  try {
    replayOperationalLimits(env);
    return false;
  } catch (error: unknown) {
    return error instanceof ReplayOperationalConfigurationError;
  }
}

function main(): void {
  const development = replayOperationalLimits({ NODE_ENV: 'test' });
  assert('development defaults are finite', development.worker_deadline_seconds === 120);
  assert('development lease outlives worker deadline', development.lease_seconds === 150);
  assert('development scheduler has bounded capacity', development.max_concurrency === 2);

  assert(
    'production rejects omitted operational limits',
    rejectsConfiguration({ NODE_ENV: 'production' })
  );
  assert(
    'strict parser rejects leading zeroes',
    rejectsConfiguration({ NODE_ENV: 'test', STOCKS_REPLAY_MAX_CONCURRENCY: '02' })
  );
  assert(
    'strict parser rejects excessive concurrency',
    rejectsConfiguration({ NODE_ENV: 'test', STOCKS_REPLAY_MAX_CONCURRENCY: '17' })
  );
  assert(
    'strict parser rejects a lease shorter than deadline grace',
    rejectsConfiguration({
      NODE_ENV: 'test',
      STOCKS_REPLAY_WORKER_DEADLINE_SECONDS: '120',
      STOCKS_REPLAY_LEASE_SECONDS: '124',
    })
  );

  const production = replayOperationalLimits({
    NODE_ENV: 'production',
    STOCKS_REPLAY_WORKER_DEADLINE_SECONDS: '120',
    STOCKS_REPLAY_LEASE_SECONDS: '150',
    STOCKS_REPLAY_MAX_CONCURRENCY: '2',
    STOCKS_REPLAY_MAX_QUEUE_DEPTH: '32',
    STOCKS_REPLAY_SUBMIT_RATE_PER_MINUTE: '10',
    STOCKS_REPLAY_STATUS_RATE_PER_MINUTE: '120',
    STOCKS_REPLAY_RATE_MAX_USERS: '10000',
  });
  assert(
    'complete bounded production configuration is accepted',
    production.max_queue_depth === 32
  );

  let now = 1_000;
  const limiter = new PerUserReplayRateLimiter(2, 2, () => now);
  assert('first per-user request is admitted', limiter.consume(7).allowed);
  assert('second per-user request is admitted', limiter.consume(7).allowed);
  const denied = limiter.consume(7);
  assert('third per-user request is rate limited', !denied.allowed);
  assert('rate limit returns bounded Retry-After', denied.retry_after_seconds === 60);
  assert('different authenticated user has an independent bucket', limiter.consume(8).allowed);
  assert('bounded user map fails closed when full', !limiter.consume(9).allowed);
  now += 60_000;
  assert('expired windows are reclaimed before admitting a new user', limiter.consume(9).allowed);

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
