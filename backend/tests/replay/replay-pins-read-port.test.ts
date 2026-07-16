import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import {
  ReplayPinsConflictError,
  ReplayPinsNotFoundError,
  ReplayPinsStoreUnavailableError,
  SequelizeReplayPinsReadAdapter,
} from '../../src/replay/ReplayPinsReadPort';

const ROW = {
  trading_day: '2026-07-14',
  as_of: '2026-07-14T06:00:00Z',
  profile: 'us_preferred',
  market_scope: 'us',
  profile_version: '1.0.0',
  contract_version: '0.3.1',
  input_fingerprint: 'a'.repeat(64),
  strategy_version: '1.0.0',
  pipeline_version: '1.0.0',
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

async function rejectsAs(action: () => Promise<unknown>, type: new () => Error): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error: unknown) {
    return error instanceof type;
  }
}

function adapterFor(
  result: Record<string, unknown>[] | Error,
  calls: Array<{ sql: string; options: Record<string, unknown> }> = []
): SequelizeReplayPinsReadAdapter {
  const sequelize = {
    async query(sql: string, options: Record<string, unknown>) {
      calls.push({ sql, options });
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as Sequelize;
  return new SequelizeReplayPinsReadAdapter(sequelize);
}

async function main(): Promise<void> {
  const calls: Array<{ sql: string; options: Record<string, unknown> }> = [];
  const adapter = adapterFor([ROW], calls);
  const pins = await adapter.resolve({
    trading_day: '2026-07-14',
    profile: 'us_preferred',
    market_scope: 'us',
  });
  assert('returns all nine physical pins unchanged', JSON.stringify(pins) === JSON.stringify(ROW));
  assert('uses one bounded physical query', calls.length === 1 && /LIMIT 2/.test(calls[0].sql));
  assert(
    'query binds only the three user-selected fields',
    JSON.stringify((calls[0].options as any).replacements) ===
      JSON.stringify({ trading_day: '2026-07-14', profile: 'us_preferred', market_scope: 'us' })
  );
  assert('query uses SELECT mode', (calls[0].options as any).type === QueryTypes.SELECT);
  assert('query does not choose a latest capture', !/as_of_utc\s+DESC/i.test(calls[0].sql));

  assert(
    'zero captures is explicit not-found',
    await rejectsAs(
      () =>
        adapterFor([]).resolve({
          trading_day: '2026-07-14',
          profile: 'us_preferred',
          market_scope: 'us',
        }),
      ReplayPinsNotFoundError
    )
  );
  assert(
    'multiple captures fail ambiguous instead of selecting one',
    await rejectsAs(
      () =>
        adapterFor([ROW, { ...ROW, profile_version: '2.0.0' }]).resolve({
          trading_day: '2026-07-14',
          profile: 'us_preferred',
          market_scope: 'us',
        }),
      ReplayPinsConflictError
    )
  );
  assert(
    'malformed persisted pins fail closed',
    await rejectsAs(
      () =>
        adapterFor([{ ...ROW, input_fingerprint: 'NOT-A-HASH' }]).resolve({
          trading_day: '2026-07-14',
          profile: 'us_preferred',
          market_scope: 'us',
        }),
      ReplayPinsStoreUnavailableError
    )
  );
  assert(
    'database errors use a public unavailable error',
    await rejectsAs(
      () =>
        adapterFor(new Error('password=SECRET host=/private/socket')).resolve({
          trading_day: '2026-07-14',
          profile: 'us_preferred',
          market_scope: 'us',
        }),
      ReplayPinsStoreUnavailableError
    )
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
