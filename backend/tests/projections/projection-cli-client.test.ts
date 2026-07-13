import {
  ProjectionCliClient,
  ProjectionCliInputTooLargeError,
  ProjectionCliOutputTooLargeError,
  ProjectionCliProtocolError,
  ProjectionCliRejectedError,
  ProjectionCliTimeoutError,
  ProjectionCliUnavailableError,
} from '../../src/projections/ProjectionCliClient';
import fs from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { spawn } from 'child_process';

const SUCCESS_SCRIPT = String.raw`
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(raw);
  process.stdout.write(JSON.stringify({
    protocol_version: '1.0.0',
    ok: true,
    result: request
  }) + '\n');
});
`;

const REJECTION_SCRIPT = String.raw`
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write(JSON.stringify({
    protocol_version: '1.0.0',
    ok: false,
    error: { code: 'CONTRACT_ERROR', message: 'fixture contract rejection' }
  }) + '\n');
  process.exitCode = 3;
});
`;

const ENV_SCRIPT = String.raw`
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    protocol_version: '1.0.0',
    ok: true,
    result: process.env
  }) + '\n');
});
`;

function client(script: string, overrides: Record<string, unknown> = {}): ProjectionCliClient {
  return new ProjectionCliClient({
    command: process.execPath,
    args: ['-e', script],
    timeout_ms: 2_000,
    ...overrides,
  });
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

async function rejectsAs<T extends Error>(
  action: () => Promise<unknown>,
  type: new (...args: any[]) => T
): Promise<T | null> {
  try {
    await action();
    return null;
  } catch (error: unknown) {
    return error instanceof type ? error : null;
  }
}

async function main(): Promise<void> {
  const success = client(SUCCESS_SCRIPT);
  const daily = await success.projectDaily({ snapshot_id: 'fixture' });
  assert('daily sends exact protocol version', daily.protocol_version === '1.0.0');
  assert('daily sends exact operation', daily.op === 'daily');
  assert(
    'daily sends exact request keys',
    JSON.stringify(Object.keys(daily).sort()) ===
      JSON.stringify(['envelope', 'op', 'protocol_version'])
  );

  const history = await success.projectHistory([{ snapshot_id: 'fixture' }], {
    query: 'AAPL',
    profile: 'us_preferred',
    market_scope: 'us',
    from_day: '2026-07-12',
    to_day: '2026-07-12',
  });
  assert('history sends exact operation', history.op === 'history');
  assert(
    'history sends exact frozen optional keys',
    JSON.stringify(Object.keys(history).sort()) ===
      JSON.stringify(
        [
          'envelopes',
          'from_day',
          'market_scope',
          'op',
          'profile',
          'protocol_version',
          'query',
          'to_day',
        ].sort()
      )
  );

  const rejection = await rejectsAs(
    () => client(REJECTION_SCRIPT).projectDaily({ snapshot_id: 'fixture' }),
    ProjectionCliRejectedError
  );
  assert('controlled stderr rejection is typed', rejection?.code === 'CONTRACT_ERROR');
  assert('controlled stderr rejection preserves exit code', rejection?.exit_code === 3);
  assert('controlled stderr rejection preserves message', rejection?.message.includes('fixture'));

  const mixedOutput = await rejectsAs(
    () =>
      client(
        `process.stdin.resume(); process.stdin.on('end', () => {
          process.stdout.write('{"protocol_version":"1.0.0","ok":true,"result":{}}\\n');
          process.stderr.write('unexpected');
        });`
      ).projectDaily({}),
    ProjectionCliProtocolError
  );
  assert('successful exit with stderr fails closed', mixedOutput !== null);

  const malformed = await rejectsAs(
    () =>
      client(
        `process.stdin.resume(); process.stdin.on('end', () => {
          process.stdout.write('{"protocol_version":"1.0.0","ok":true}\\n');
        });`
      ).projectDaily({}),
    ProjectionCliProtocolError
  );
  assert('malformed success envelope fails closed', malformed !== null);

  const failedWithStdout = await rejectsAs(
    () =>
      client(
        `process.stdin.resume(); process.stdin.on('end', () => {
          process.stdout.write('{}');
          process.stderr.write('{"protocol_version":"1.0.0","ok":false,"error":{"code":"INTERNAL_ERROR","message":"x"}}');
          process.exitCode = 4;
        });`
      ).projectDaily({}),
    ProjectionCliProtocolError
  );
  assert('failed exit with stdout fails closed', failedWithStdout !== null);

  const mismatchedExit = await rejectsAs(
    () =>
      client(
        `process.stdin.resume(); process.stdin.on('end', () => {
          process.stderr.write('{"protocol_version":"1.0.0","ok":false,"error":{"code":"CONTRACT_ERROR","message":"x"}}');
          process.exitCode = 2;
        });`
      ).projectDaily({}),
    ProjectionCliProtocolError
  );
  assert('error code/exit code mismatch fails closed', mismatchedExit !== null);

  const invalidResponses: Array<[string, string, number]> = [
    [
      'duplicate top-level stdout keys',
      '{"protocol_version":"1.0.0","ok":true,"ok":true,"result":{}}',
      0,
    ],
    [
      'duplicate nested stdout keys',
      '{"protocol_version":"1.0.0","ok":true,"result":{"ticker":"A","ticker":"B"}}',
      0,
    ],
    [
      'duplicate top-level stderr keys',
      '{"protocol_version":"1.0.0","ok":false,"ok":false,"error":{"code":"INVALID_JSON","message":"invalid JSON input"}}',
      2,
    ],
    [
      'duplicate nested stderr keys',
      '{"protocol_version":"1.0.0","ok":false,"error":{"code":"INVALID_JSON","code":"INVALID_JSON","message":"invalid JSON input"}}',
      2,
    ],
    [
      'unknown stderr error code',
      '{"protocol_version":"1.0.0","ok":false,"error":{"code":"FUTURE_ERROR","message":"x"}}',
      2,
    ],
    [
      'lone surrogate stdout key',
      '{"protocol_version":"1.0.0","ok":true,"result":{"\\ud800MARKER":"x"}}',
      0,
    ],
    [
      'lone surrogate stdout value',
      '{"protocol_version":"1.0.0","ok":true,"result":{"value":"\\udc00MARKER"}}',
      0,
    ],
    [
      'lone surrogate stderr key',
      '{"protocol_version":"1.0.0","ok":false,"error":{"code":"INVALID_JSON","message":"invalid JSON input","\\ud800MARKER":"x"}}',
      2,
    ],
    [
      'lone surrogate stderr code',
      '{"protocol_version":"1.0.0","ok":false,"error":{"code":"INVALID_\\ud800JSON","message":"invalid JSON input"}}',
      2,
    ],
    [
      'lone surrogate stderr message',
      '{"protocol_version":"1.0.0","ok":false,"error":{"code":"INVALID_JSON","message":"\\udc00MARKER"}}',
      2,
    ],
    [
      'terminal high surrogate stdout key',
      '{"protocol_version":"1.0.0","ok":true,"result":{"\\ud800":"x"}}',
      0,
    ],
    [
      'terminal high surrogate stdout value',
      '{"protocol_version":"1.0.0","ok":true,"result":{"value":"\\ud800"}}',
      0,
    ],
    [
      'terminal low surrogate stdout value',
      '{"protocol_version":"1.0.0","ok":true,"result":{"value":"\\udc00"}}',
      0,
    ],
    [
      'terminal high surrogate stderr code',
      '{"protocol_version":"1.0.0","ok":false,"error":{"code":"INVALID_\\ud800","message":"invalid JSON input"}}',
      2,
    ],
    [
      'terminal high surrogate stderr message',
      '{"protocol_version":"1.0.0","ok":false,"error":{"code":"INVALID_JSON","message":"\\ud800"}}',
      2,
    ],
    [
      'terminal low surrogate stderr message',
      '{"protocol_version":"1.0.0","ok":false,"error":{"code":"INVALID_JSON","message":"\\udc00"}}',
      2,
    ],
  ];
  for (const [name, response, exitCode] of invalidResponses) {
    const stream = exitCode === 0 ? 'stdout' : 'stderr';
    const rejection = await rejectsAs(
      () =>
        client(
          `process.stdin.resume(); process.stdin.on('end', () => {
            process.${stream}.write(${JSON.stringify(response)});
            process.exitCode = ${exitCode};
          });`
        ).projectDaily({}),
      ProjectionCliProtocolError
    );
    assert(`${name} fails closed`, rejection !== null);
  }

  const validPair = await client(
    `process.stdin.resume(); process.stdin.on('end', () => {
      process.stdout.write('{"protocol_version":"1.0.0","ok":true,"result":{"emoji":"\\\\ud83d\\\\ude00"}}');
    });`
  ).projectDaily({});
  assert('valid surrogate pair passes', validPair.emoji === '😀');
  const protoKey = await client(
    `process.stdin.resume(); process.stdin.on('end', () => {
      process.stdout.write('{"protocol_version":"1.0.0","ok":true,"result":{"__proto__":{"polluted":true}}}');
    });`
  ).projectDaily({});
  assert(
    '__proto__ remains an own JSON key without prototype mutation',
    Object.prototype.hasOwnProperty.call(protoKey, '__proto__') &&
      (protoKey.__proto__ as Record<string, unknown>).polluted === true &&
      !('polluted' in {})
  );

  const timeout = await rejectsAs(
    () =>
      client('process.stdin.resume(); setInterval(() => {}, 1000);', {
        timeout_ms: 25,
      }).projectDaily({}),
    ProjectionCliTimeoutError
  );
  assert('timeout terminates child and is typed', timeout !== null);

  const oversizedInput = await rejectsAs(
    () =>
      client(SUCCESS_SCRIPT, {
        max_input_bytes: 64,
      }).projectDaily({ payload: 'x'.repeat(128) }),
    ProjectionCliInputTooLargeError
  );
  assert('input byte cap rejects before spawn', oversizedInput !== null);

  const oversizedOutput = await rejectsAs(
    () =>
      client(
        `process.stdin.resume(); process.stdin.on('end', () => {
          process.stdout.write('x'.repeat(256));
        });`,
        { max_output_bytes: 64 }
      ).projectDaily({}),
    ProjectionCliOutputTooLargeError
  );
  assert('stdout byte cap terminates child', oversizedOutput !== null);

  const oversizedError = await rejectsAs(
    () =>
      client(
        `process.stdin.resume(); process.stdin.on('end', () => {
          process.stderr.write('x'.repeat(256));
          process.exitCode = 4;
        });`,
        { max_stderr_bytes: 64 }
      ).projectDaily({}),
    ProjectionCliOutputTooLargeError
  );
  assert('stderr byte cap terminates child', oversizedError !== null);

  const unavailable = await rejectsAs(
    () =>
      new ProjectionCliClient({
        command: '/definitely/missing/projection-cli',
        timeout_ms: 1_000,
      }).projectDaily({}),
    ProjectionCliUnavailableError
  );
  assert('spawn failure is typed unavailable', unavailable !== null);

  let configuredEnvironment: NodeJS.ProcessEnv | undefined;
  const childEnvironment = await client(ENV_SCRIPT, {
    env: {
      PATH: process.env.PATH,
      PYTHONPATH: '/must/not/be/inherited',
      DATABASE_URL: 'postgres://must-not-leak',
      DB_PASSWORD: 'must-not-leak',
      JWT_SECRET: 'must-not-leak',
      PROVIDER_TOKEN: 'must-not-leak',
      HOME: '/must/not/be/inherited',
    },
    spawn_process: ((command, args, options) => {
      configuredEnvironment = options?.env;
      return spawn(command, args, options);
    }) as typeof spawn,
  }).projectDaily({});
  assert('child receives an executable PATH', typeof childEnvironment.PATH === 'string');
  assert(
    'child receives repo-only PYTHONPATH',
    childEnvironment.PYTHONPATH === path.resolve(__dirname, '../../..')
  );
  assert('child receives deterministic UTF-8 flags', childEnvironment.PYTHONUTF8 === '1');
  assert('child receives no-bytecode flag', childEnvironment.PYTHONDONTWRITEBYTECODE === '1');
  assert('child does not inherit DATABASE_URL', !('DATABASE_URL' in childEnvironment));
  assert('child does not inherit DB password', !('DB_PASSWORD' in childEnvironment));
  assert('child does not inherit JWT secret', !('JWT_SECRET' in childEnvironment));
  assert('child does not inherit provider token', !('PROVIDER_TOKEN' in childEnvironment));
  assert('child does not inherit HOME', !('HOME' in childEnvironment));
  assert(
    'spawn receives exact application allowlist',
    Object.keys(configuredEnvironment ?? {})
      .sort()
      .join(',') ===
      ['PATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING', 'PYTHONPATH', 'PYTHONUTF8'].join(',')
  );
  assert(
    'live child has no unexpected application variables',
    Object.keys(childEnvironment)
      .filter(key => key !== '__CF_USER_TEXT_ENCODING')
      .sort()
      .join(',') ===
      ['PATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING', 'PYTHONPATH', 'PYTHONUTF8'].join(',')
  );

  const repositoryRoot = path.resolve(__dirname, '../../..');
  const canonicalEnvelope = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, 'strategy/reporting/fixtures/recommendation_list_us_v031.json'),
      'utf8'
    )
  );
  const canonicalDaily = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, 'strategy/reporting/fixtures/daily_report_us_v031.golden.json'),
      'utf8'
    )
  );
  const canonicalHistory = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, 'strategy/reporting/fixtures/report_history_us_v031.golden.json'),
      'utf8'
    )
  );
  const realClient = new ProjectionCliClient({ cwd: repositoryRoot, timeout_ms: 5_000 });
  const realDaily = await realClient.projectDaily(canonicalEnvelope);
  const realHistory = await realClient.projectHistory([canonicalEnvelope]);
  assert(
    'real merged Python daily CLI matches committed golden',
    isDeepStrictEqual(realDaily, canonicalDaily)
  );
  assert(
    'real merged Python history CLI matches committed golden',
    isDeepStrictEqual(realHistory, canonicalHistory)
  );
  const surrogateEnvelope = {
    ...canonicalEnvelope,
    market_scope: 'ATTACKER_\ud800_MARKER',
  };
  const surrogateRejection = await rejectsAs(
    () => realClient.projectDaily(surrogateEnvelope),
    ProjectionCliRejectedError
  );
  assert('real merged Python surrogate rejection is typed', surrogateRejection !== null);
  assert('real merged Python surrogate rejection exits 2', surrogateRejection?.exit_code === 2);
  assert(
    'real merged Python surrogate rejection is INVALID_JSON',
    surrogateRejection?.code === 'INVALID_JSON'
  );
  assert(
    'real merged Python surrogate rejection is bounded public text',
    surrogateRejection?.message === 'invalid JSON input'
  );
  assert(
    'real merged Python surrogate rejection leaks no marker/path/traceback',
    !surrogateRejection?.message.includes('ATTACKER_') &&
      !surrogateRejection?.message.includes('Traceback') &&
      !surrogateRejection?.message.includes(repositoryRoot)
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
