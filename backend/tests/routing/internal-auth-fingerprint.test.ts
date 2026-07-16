import { __TESTING__ } from '../../src/middlewares/internalAuth';

let passed = 0;
let failed = 0;
const originalEnv = { ...process.env };

function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}`);
  }
}

function invoke(options: {
  nodeEnv: string;
  configuredKey?: string;
  providedKey?: string;
  leakedFingerprints: ReadonlySet<string>;
}) {
  process.env = {
    ...originalEnv,
    NODE_ENV: options.nodeEnv,
  };
  if (options.configuredKey === undefined) {
    delete process.env.INTERNAL_API_KEY;
  } else {
    process.env.INTERNAL_API_KEY = options.configuredKey;
  }

  let statusCode = 200;
  let body: unknown;
  let nextCalls = 0;
  const req = {
    headers: options.providedKey ? { 'x-api-key': options.providedKey } : {},
    query: {},
    ip: '127.0.0.1',
  } as any;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as any;

  __TESTING__.authenticateInternalApiWithFingerprints(
    req,
    res,
    () => {
      nextCalls += 1;
    },
    options.leakedFingerprints
  );

  return { statusCode, body, nextCalls };
}

try {
  const syntheticLeakedKey = 'synthetic-leaked-internal-key-for-fingerprint-test';
  const leakedFingerprints = new Set([__TESTING__.secretFingerprint(syntheticLeakedKey)]);

  const blocked = invoke({
    nodeEnv: 'production',
    configuredKey: syntheticLeakedKey,
    providedKey: syntheticLeakedKey,
    leakedFingerprints,
  });
  check('production leaked fingerprint returns 503', blocked.statusCode === 503);
  check('production leaked fingerprint never reaches handler', blocked.nextCalls === 0);
  check(
    'production leaked fingerprint returns generic unavailable text',
    JSON.stringify(blocked.body) ===
      JSON.stringify({ success: false, message: 'Server configuration error' })
  );

  const strongKey = 'synthetic-strong-internal-key-for-normal-path';
  const accepted = invoke({
    nodeEnv: 'production',
    configuredKey: strongKey,
    providedKey: strongKey,
    leakedFingerprints,
  });
  check('non-leaked matching key reaches handler', accepted.nextCalls === 1);

  const missing = invoke({
    nodeEnv: 'production',
    providedKey: strongKey,
    leakedFingerprints,
  });
  check('missing configured key remains fail-closed', missing.statusCode === 500);
  check('missing configured key never reaches handler', missing.nextCalls === 0);
} finally {
  process.env = originalEnv;
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
