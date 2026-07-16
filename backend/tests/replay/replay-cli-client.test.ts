import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ReplayCliAbortedError,
  ReplayCliClient,
  type ReplayCliClientOptions,
  ReplayCliInputTooLargeError,
  ReplayCliOutputTooLargeError,
  ReplayCliProtocolError,
  ReplayCliRejectedError,
  ReplayCliTimeoutError,
  ReplayCliUnavailableError,
  type ReplayPins,
} from '../../src/replay/ReplayCliClient';

const JOB_ID = '12345678-1234-4234-8234-567812345678';
const SNAPSHOT_ID = '22345678-1234-4234-8234-56781234abcd';
const PINS: ReplayPins = {
  trading_day: '2026-07-14',
  as_of: '2026-07-14T20:00:00Z',
  profile: 'us_preferred',
  market_scope: 'us',
  profile_version: '1.0.0',
  contract_version: '0.3.1',
  input_fingerprint: 'a'.repeat(64),
  strategy_version: '1.0.0',
  pipeline_version: '1.0.0',
};

function responseScript(job: Record<string, unknown>, delayMs = 0, requestCheck = 'true'): string {
  return `
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(raw);
  if (!(${requestCheck})) {
    process.stderr.write(JSON.stringify({
      protocol_version: '1.0.0', ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'replay failed' }
    }) + '\\n');
    process.exitCode = 4;
    return;
  }
  setTimeout(() => process.stdout.write(JSON.stringify({
    protocol_version: '1.0.0', ok: true, result: { job: ${JSON.stringify(job)} }
  }) + '\\n'), ${delayMs});
});
`;
}

function rawScript(raw: string, stream: 'stdout' | 'stderr' = 'stdout', exitCode = 0): string {
  return `
process.stdin.resume();
process.stdin.on('end', () => {
  process.${stream}.write(Buffer.from(${JSON.stringify(raw)}, 'utf8'));
  process.exitCode = ${exitCode};
});
`;
}

function client(script: string, overrides: Partial<ReplayCliClientOptions> = {}): ReplayCliClient {
  return new ReplayCliClient({
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
  const submitCheck = [
    `JSON.stringify(Object.keys(request).sort()) === ${JSON.stringify(
      JSON.stringify(['op', 'pins', 'protocol_version'])
    )}`,
    `request.protocol_version === '1.0.0'`,
    `request.op === 'submit'`,
    `JSON.stringify(request.pins) === ${JSON.stringify(JSON.stringify(PINS))}`,
  ].join(' && ');
  const submitted = await client(
    responseScript({ job_id: JOB_ID, status: 'queued' }, 0, submitCheck)
  ).submit({ ...PINS, unexpected: 'omitted' } as ReplayPins & { unexpected: string });
  assert('submit sends the exact request and pin set', submitted.status === 'queued');

  for (const [method, operation] of [
    ['status', 'status'],
    ['runOne', 'run_one'],
  ] as const) {
    const requestCheck = [
      `JSON.stringify(Object.keys(request).sort()) === ${JSON.stringify(
        JSON.stringify(['job_id', 'op', 'protocol_version'])
      )}`,
      `request.protocol_version === '1.0.0'`,
      `request.op === ${JSON.stringify(operation)}`,
      `request.job_id === ${JSON.stringify(JOB_ID)}`,
    ].join(' && ');
    const exact = await client(
      responseScript({ job_id: JOB_ID, status: 'running' }, 0, requestCheck)
    )[method](JOB_ID);
    assert(`${operation} sends the exact request`, exact.status === 'running');
  }

  const completed = await client(
    responseScript({ job_id: JOB_ID, status: 'completed', snapshot_id: SNAPSHOT_ID })
  ).status(JOB_ID);
  assert(
    'completed response is a typed terminal union',
    completed.status === 'completed' && completed.snapshot_id === SNAPSHOT_ID
  );
  const failedJob = await client(
    responseScript({ job_id: JOB_ID, status: 'failed', error: 'replay pipeline failed' })
  ).runOne(JOB_ID);
  assert(
    'failed response is a typed terminal union',
    failedJob.status === 'failed' && failedJob.error === 'replay pipeline failed'
  );

  const invalidSuccesses = [
    {
      name: 'completed without snapshot_id',
      body: {
        protocol_version: '1.0.0',
        ok: true,
        result: { job: { job_id: JOB_ID, status: 'completed' } },
      },
    },
    {
      name: 'completed with non-canonical snapshot_id',
      body: {
        protocol_version: '1.0.0',
        ok: true,
        result: {
          job: { job_id: JOB_ID, status: 'completed', snapshot_id: SNAPSHOT_ID.toUpperCase() },
        },
      },
    },
    {
      name: 'failed with attacker-controlled detail',
      body: {
        protocol_version: '1.0.0',
        ok: true,
        result: { job: { job_id: JOB_ID, status: 'failed', error: 'SECRET_TOKEN=/private/path' } },
      },
    },
    {
      name: 'queued with a terminal field',
      body: {
        protocol_version: '1.0.0',
        ok: true,
        result: { job: { job_id: JOB_ID, status: 'queued', snapshot_id: SNAPSHOT_ID } },
      },
    },
    {
      name: 'failed with an extra terminal field',
      body: {
        protocol_version: '1.0.0',
        ok: true,
        result: {
          job: {
            job_id: JOB_ID,
            status: 'failed',
            error: 'replay failed',
            snapshot_id: SNAPSHOT_ID,
          },
        },
      },
    },
    {
      name: 'unknown job status',
      body: {
        protocol_version: '1.0.0',
        ok: true,
        result: { job: { job_id: JOB_ID, status: 'future' } },
      },
    },
    {
      name: 'non-canonical job_id',
      body: {
        protocol_version: '1.0.0',
        ok: true,
        result: { job: { job_id: 'bad', status: 'queued' } },
      },
    },
    {
      name: 'extra result key',
      body: {
        protocol_version: '1.0.0',
        ok: true,
        result: { job: { job_id: JOB_ID, status: 'queued' }, extra: true },
      },
    },
    {
      name: 'extra response key',
      body: {
        protocol_version: '1.0.0',
        ok: true,
        result: { job: { job_id: JOB_ID, status: 'queued' } },
        extra: true,
      },
    },
  ];
  for (const testCase of invalidSuccesses) {
    const rejection = await rejectsAs(
      () => client(rawScript(JSON.stringify(testCase.body))).status(JOB_ID),
      ReplayCliProtocolError
    );
    assert(`${testCase.name} fails closed`, rejection !== null);
  }

  const invalidJsonResponses = [
    [
      'duplicate response key',
      `{"protocol_version":"1.0.0","ok":true,"ok":true,"result":{"job":{"job_id":"${JOB_ID}","status":"queued"}}}`,
    ],
    [
      'duplicate job key',
      `{"protocol_version":"1.0.0","ok":true,"result":{"job":{"job_id":"${JOB_ID}","status":"queued","status":"queued"}}}`,
    ],
    [
      'lone surrogate response value',
      `{"protocol_version":"1.0.0","ok":true,"result":{"job":{"job_id":"${JOB_ID}","status":"failed","error":"\\ud800"}}}`,
    ],
    ['trailing JSON', `${JSON.stringify({})}${JSON.stringify({})}`],
  ];
  for (const [name, raw] of invalidJsonResponses) {
    const rejection = await rejectsAs(
      () => client(rawScript(raw)).status(JOB_ID),
      ReplayCliProtocolError
    );
    assert(`${name} is rejected by strict JSON parsing`, rejection !== null);
  }

  const validRejection = await rejectsAs(
    () =>
      client(
        rawScript(
          JSON.stringify({
            protocol_version: '1.0.0',
            ok: false,
            error: { code: 'REPLAY_CONFLICT', message: 'replay job conflict' },
          }),
          'stderr',
          3
        )
      ).runOne(JOB_ID),
    ReplayCliRejectedError
  );
  assert('controlled CLI rejection is typed', validRejection?.code === 'REPLAY_CONFLICT');
  assert('controlled CLI rejection preserves the expected exit', validRejection?.exit_code === 3);
  assert(
    'controlled CLI rejection preserves only public text',
    validRejection?.message === 'replay job conflict'
  );

  const invalidRejections: Array<[string, Record<string, unknown>, number]> = [
    [
      'unknown error code',
      { protocol_version: '1.0.0', ok: false, error: { code: 'FUTURE_ERROR', message: 'x' } },
      3,
    ],
    [
      'error and exit mismatch',
      {
        protocol_version: '1.0.0',
        ok: false,
        error: { code: 'REPLAY_CONFLICT', message: 'replay job conflict' },
      },
      4,
    ],
    [
      'attacker-controlled rejection message',
      {
        protocol_version: '1.0.0',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'SECRET_TOKEN=/private/path' },
      },
      4,
    ],
    [
      'extra error field',
      {
        protocol_version: '1.0.0',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'replay failed', detail: 'secret' },
      },
      4,
    ],
  ];
  for (const [name, body, exitCode] of invalidRejections) {
    const rejection = await rejectsAs(
      () => client(rawScript(JSON.stringify(body), 'stderr', exitCode)).status(JOB_ID),
      ReplayCliProtocolError
    );
    assert(`${name} fails closed`, rejection !== null);
    if (name === 'attacker-controlled rejection message') {
      assert(
        'attacker rejection text is not reflected',
        !rejection?.message.includes('SECRET_TOKEN')
      );
    }
  }

  const mixedOutput = await rejectsAs(
    () =>
      client(`
process.stdin.resume(); process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(
    JSON.stringify({
      protocol_version: '1.0.0',
      ok: true,
      result: { job: { job_id: JOB_ID, status: 'queued' } },
    })
  )});
  process.stderr.write('unexpected');
});`).status(JOB_ID),
    ReplayCliProtocolError
  );
  assert('successful invocation with stderr fails closed', mixedOutput !== null);

  const failedWithStdout = await rejectsAs(
    () =>
      client(`
process.stdin.resume(); process.stdin.on('end', () => {
  process.stdout.write('{}');
  process.stderr.write(${JSON.stringify(
    JSON.stringify({
      protocol_version: '1.0.0',
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'replay failed' },
    })
  )});
  process.exitCode = 4;
});`).status(JOB_ID),
    ReplayCliProtocolError
  );
  assert('failed invocation with stdout fails closed', failedWithStdout !== null);

  const timeoutClient = client(responseScript({ job_id: JOB_ID, status: 'queued' }, 75), {
    timeout_ms: 20,
  });
  const timedOut = await rejectsAs(() => timeoutClient.runOne(JOB_ID), ReplayCliTimeoutError);
  assert('configured timeout is typed and terminates the invocation', timedOut !== null);
  const noTimeout = await timeoutClient.runOne(JOB_ID, { timeout_ms: 0 });
  assert('runOne timeout_ms zero disables the kill timer', noTimeout.status === 'queued');

  const preAbortedController = new AbortController();
  preAbortedController.abort(new Error('SECRET_REASON'));
  let spawnCount = 0;
  const preAborted = await rejectsAs(
    () =>
      client(responseScript({ job_id: JOB_ID, status: 'queued' }), {
        spawn_process: ((command, args, options) => {
          spawnCount += 1;
          return spawn(command, args, options);
        }) as typeof spawn,
      }).status(JOB_ID, { signal: preAbortedController.signal }),
    ReplayCliAbortedError
  );
  assert('pre-aborted invocation does not spawn', preAborted !== null && spawnCount === 0);
  assert('abort reason is not reflected', !preAborted?.message.includes('SECRET_REASON'));

  const activeController = new AbortController();
  const activePromise = client(responseScript({ job_id: JOB_ID, status: 'queued' }, 200), {
    timeout_ms: 0,
  }).status(JOB_ID, { signal: activeController.signal });
  setTimeout(() => activeController.abort(new Error('SECRET_REASON')), 20);
  const activelyAborted = await rejectsAs(() => activePromise, ReplayCliAbortedError);
  assert('active abort terminates the invocation with a typed error', activelyAborted !== null);

  const oversizedInput = await rejectsAs(
    () =>
      client(responseScript({ job_id: JOB_ID, status: 'queued' }), {
        max_input_bytes: 128,
      }).submit({ ...PINS, profile_version: 'x'.repeat(256) }),
    ReplayCliInputTooLargeError
  );
  assert('stdin cap rejects before spawning', oversizedInput !== null);

  const oversizedOutput = await rejectsAs(
    () =>
      client(
        `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('x'.repeat(256)));`,
        { max_output_bytes: 64 }
      ).status(JOB_ID),
    ReplayCliOutputTooLargeError
  );
  assert('stdout cap terminates the invocation', oversizedOutput?.stream === 'stdout');
  const oversizedStderr = await rejectsAs(
    () =>
      client(
        `process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('x'.repeat(256)); process.exitCode = 4; });`,
        { max_stderr_bytes: 64 }
      ).status(JOB_ID),
    ReplayCliOutputTooLargeError
  );
  assert('stderr cap terminates the invocation', oversizedStderr?.stream === 'stderr');

  const unavailable = await rejectsAs(
    () =>
      new ReplayCliClient({
        command: '/definitely/missing/replay-cli-SECRET_PATH',
        timeout_ms: 1_000,
      }).status(JOB_ID),
    ReplayCliUnavailableError
  );
  assert('spawn failure is typed unavailable', unavailable !== null);
  assert(
    'spawn failure does not reflect the executable path',
    !unavailable?.message.includes('SECRET_PATH')
  );

  let configuredEnvironment: NodeJS.ProcessEnv | undefined;
  const environmentClient = client(responseScript({ job_id: JOB_ID, status: 'queued' }), {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      STOCKS_REPLAY_RUNTIME_DIR: '/controlled/runtime',
      STOCKS_REPLAY_WORKER_DEADLINE_SECONDS: '120',
      STOCKS_REPLAY_LEASE_SECONDS: '150',
      DATABASE_URL: 'postgresql://allowed-only-for-replay',
      STOCKS_REPLAY_MODEL_VERSION: 'model-v1',
      STOCKS_REPLAY_TEMPLATE_HASH: 'b'.repeat(64),
      STOCKS_REPLAY_DISCLAIMERS_JSON: '{"en":"research only"}',
      JWT_SECRET: 'must-not-leak',
      DB_PASSWORD: 'must-not-leak',
      PROVIDER_TOKEN: 'must-not-leak',
      HOME: '/must/not/be/inherited',
    },
    spawn_process: ((command, args, options) => {
      configuredEnvironment = options?.env;
      return spawn(command, args, options);
    }) as typeof spawn,
  });
  await environmentClient.status(JOB_ID);
  const environmentKeys = Object.keys(configuredEnvironment ?? {}).sort();
  assert(
    'spawn receives the exact replay environment allowlist',
    environmentKeys.join(',') ===
      [
        'DATABASE_URL',
        'NODE_ENV',
        'PATH',
        'PYTHONDONTWRITEBYTECODE',
        'PYTHONIOENCODING',
        'PYTHONPATH',
        'PYTHONUTF8',
        'STOCKS_REPLAY_DISCLAIMERS_JSON',
        'STOCKS_REPLAY_LEASE_SECONDS',
        'STOCKS_REPLAY_MODEL_VERSION',
        'STOCKS_REPLAY_RUNTIME_DIR',
        'STOCKS_REPLAY_TEMPLATE_HASH',
        'STOCKS_REPLAY_WORKER_DEADLINE_SECONDS',
      ]
        .sort()
        .join(',')
  );
  assert('JWT secret is not inherited', configuredEnvironment?.JWT_SECRET === undefined);
  assert(
    'DB password is not inherited separately',
    configuredEnvironment?.DB_PASSWORD === undefined
  );
  assert('provider token is not inherited', configuredEnvironment?.PROVIDER_TOKEN === undefined);
  assert('HOME is not inherited', configuredEnvironment?.HOME === undefined);
  assert(
    'PYTHONPATH is pinned to the repository',
    configuredEnvironment?.PYTHONPATH === path.resolve(__dirname, '../../..')
  );

  const repositoryRoot = path.resolve(__dirname, '../../..');
  const runtimeDirectory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'stocks-replay-cli-client-')
  );
  fs.chmodSync(runtimeDirectory, 0o700);
  try {
    const realClient = new ReplayCliClient({
      cwd: repositoryRoot,
      timeout_ms: 30_000,
      env: {
        PATH: process.env.PATH,
        STOCKS_REPLAY_RUNTIME_DIR: runtimeDirectory,
      },
    });
    const realSubmitted = await realClient.submit(PINS);
    assert(
      'real Python CLI submit returns a canonical queued job',
      realSubmitted.status === 'queued'
    );
    const realRecovered = await realClient.status(realSubmitted.job_id);
    assert(
      'real Python CLI status recovers the durable job across processes',
      realRecovered.status === 'queued' && realRecovered.job_id === realSubmitted.job_id
    );
    const unavailableWorker = await rejectsAs(
      () => realClient.runOne(realSubmitted.job_id),
      ReplayCliRejectedError
    );
    assert(
      'real Python CLI missing worker is a controlled rejection',
      unavailableWorker?.code === 'REPLAY_RUNTIME_UNAVAILABLE' && unavailableWorker.exit_code === 4
    );
    const stillQueued = await realClient.status(realSubmitted.job_id);
    assert(
      'failed-closed real runOne preserves queued durable state',
      stillQueued.status === 'queued'
    );
  } finally {
    fs.rmSync(runtimeDirectory, { recursive: true, force: true });
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
