import { buildOpenApiSpec } from '../../src/config/swagger';

type JsonObject = Record<string, any>;

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` detail=${detail}` : ''}`);
  }
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  assert(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
  );
}

const spec = buildOpenApiSpec() as JsonObject;
const submitPath = spec.paths?.['/api/v1/ai/recommendations/replay'];
const statusPath = spec.paths?.['/api/v1/ai/recommendations/status'];
const submit = submitPath?.post;
const status = statusPath?.get;
const schemas = spec.components?.schemas || {};

console.log('\n[1] only real replay HTTP operations are documented...');
assert('POST replay path exists', Boolean(submit));
assert('GET status path exists', Boolean(status));
assertEqual('submit path exposes POST only', Object.keys(submitPath || {}), ['post']);
assertEqual('status path exposes GET only', Object.keys(statusPath || {}), ['get']);
assert(
  'internal run_one is not invented as HTTP',
  !Object.keys(spec.paths || {}).some(path => /run[_-]?one/i.test(path))
);

console.log('\n[2] authentication and selector contracts are exact...');
assertEqual('POST has Bearer auth', submit?.security, [{ bearerAuth: [] }]);
assertEqual('GET has Bearer auth', status?.security, [{ bearerAuth: [] }]);
assertEqual(
  'POST body uses strict replay selector schema',
  submit?.requestBody?.content?.['application/json']?.schema?.$ref,
  '#/components/schemas/ReplaySubmitRequest'
);
const submitVariants = schemas.ReplaySubmitRequest?.oneOf || [];
assertEqual('request has three profile/scope compatibility variants', submitVariants.length, 3);
for (const [index, variant] of submitVariants.entries()) {
  assertEqual(`request variant ${index + 1} exact required fields`, variant.required, [
    'trading_day',
    'profile',
    'market_scope',
  ]);
  assert(`request variant ${index + 1} rejects extra pins`, variant.additionalProperties === false);
}
assertEqual(
  'profile/scope variants match runtime compatibility matrix',
  submitVariants.map((variant: JsonObject) => [
    variant.properties.profile.enum,
    variant.properties.market_scope.enum,
  ]),
  [
    [['us_preferred', 'multibagger'], ['cn_a', 'us']],
    [['japan_blue_chip', 'japan_multibagger'], ['jp']],
    [['korea_semiconductor_chain', 'korea_multibagger'], ['kr']],
  ]
);

const jobId = (status?.parameters || []).find((parameter: JsonObject) => parameter.name === 'job_id');
assert('status job_id is required query parameter', jobId?.in === 'query' && jobId.required === true);
assert('status job_id declares UUID format', jobId?.schema?.format === 'uuid');
assert(
  'status job_id enforces canonical lowercase UUIDv4',
  jobId?.schema?.pattern ===
    '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
);

console.log('\n[3] HTTP success codes distinguish pending and terminal jobs...');
assertEqual(
  'POST 200 is terminal job only',
  submit?.responses?.['200']?.content?.['application/json']?.schema?.$ref,
  '#/components/schemas/ReplayTerminalJob'
);
assertEqual(
  'POST 202 is pending job only',
  submit?.responses?.['202']?.content?.['application/json']?.schema?.$ref,
  '#/components/schemas/ReplayPendingJob'
);
assertEqual(
  'GET 200 covers every persisted job state',
  status?.responses?.['200']?.content?.['application/json']?.schema?.$ref,
  '#/components/schemas/ReplayJob'
);
assertEqual(
  'ReplayJob has four exact runtime states',
  schemas.ReplayJob?.oneOf?.map((item: JsonObject) => item.$ref),
  [
    '#/components/schemas/ReplayQueuedJob',
    '#/components/schemas/ReplayRunningJob',
    '#/components/schemas/ReplayCompletedJob',
    '#/components/schemas/ReplayFailedJob',
  ]
);
assertEqual('completed job requires snapshot_id', schemas.ReplayCompletedJob?.required, [
  'job_id',
  'status',
  'snapshot_id',
]);
assertEqual('failed job requires bounded error', schemas.ReplayFailedJob?.required, [
  'job_id',
  'status',
  'error',
]);
assertEqual('failed public errors match ReplayCliClient', schemas.ReplayFailedJob?.properties?.error?.enum, [
  'replay pipeline failed',
  'replay source invalid',
  'replay failed',
]);

console.log('\n[4] documented negative statuses match route/controller behavior...');
assertEqual('POST response status set', Object.keys(submit?.responses || {}).sort(), [
  '200',
  '202',
  '400',
  '401',
  '404',
  '409',
  '413',
  '422',
  '429',
  '500',
  '502',
  '503',
  '504',
]);
assertEqual('GET response status set', Object.keys(status?.responses || {}).sort(), [
  '200',
  '400',
  '401',
  '404',
  '409',
  '413',
  '429',
  '500',
  '502',
  '503',
  '504',
]);
assert(
  'POST 429 documents Retry-After',
  Boolean(submit?.responses?.['429']?.headers?.['Retry-After'])
);
assert(
  'GET 429 documents Retry-After',
  Boolean(status?.responses?.['429']?.headers?.['Retry-After'])
);
assertEqual(
  '400 permits exact-field or express-validator response',
  submit?.responses?.['400']?.content?.['application/json']?.schema?.$ref,
  '#/components/schemas/ReplayBadRequestResponse'
);
assertEqual(
  '401 is the exact unauthorized middleware response',
  submit?.responses?.['401']?.content?.['application/json']?.schema?.$ref,
  '#/components/schemas/ReplayUnauthorizedResponse'
);
assertEqual(
  '503 permits auth or replay availability response',
  submit?.responses?.['503']?.content?.['application/json']?.schema?.$ref,
  '#/components/schemas/ReplayUnavailableResponse'
);
assertEqual(
  '503 auth branch is distinct from 401',
  schemas.ReplayUnavailableResponse?.oneOf?.map((item: JsonObject) => item.$ref),
  [
    '#/components/schemas/ReplayErrorResponse',
    '#/components/schemas/ReplayAuthUnavailableResponse',
  ]
);

console.log(`\n[api-recommendation-replay-openapi] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
