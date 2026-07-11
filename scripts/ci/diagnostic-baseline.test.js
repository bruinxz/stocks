#!/usr/bin/env node
const assert = require('assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compareDiagnostics,
  groupDiagnostics,
  makeFingerprint,
  parseProducerExit,
  parseEslintJson,
  parseTscText,
  validateBaselineShape,
} = require('./diagnostic-baseline');

const baseDiagnostic = {
  path: 'backend/src/foo.ts',
  severity: 'error',
  code: 'prettier/prettier',
  message: 'Delete blank line',
  locations: [{ line: 10, column: 1 }],
};

function baselineFor(diagnostics, overrides = {}) {
  const grouped = groupDiagnostics('eslint', diagnostics);
  return {
    version: 1,
    kind: 'eslint',
    baseline_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    tool: { name: 'eslint', version: '8.57.1', allowed_producer_exits: [0, 1] },
    fingerprint_model: {
      fields: ['kind', 'repo_relative_path', 'severity', 'rule_or_code', 'normalized_message'],
      multiplicity: 'exact count per fingerprint',
    },
    config_files: configFilesFor('eslint'),
    diagnostics: grouped,
    ...overrides,
  };
}

function configFilesFor(kind) {
  const paths =
    kind === 'eslint'
      ? [
          'backend/.eslintrc.js',
          'backend/tsconfig.json',
          'backend/package.json',
          'backend/package-lock.json',
        ]
      : ['frontend/tsconfig.json', 'frontend/package.json', 'frontend/package-lock.json'];
  return paths.map((configPath) => ({
    path: configPath,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex'),
  }));
}

function compare(baseline, current) {
  return compareDiagnostics({
    baseline,
    current: groupDiagnostics('eslint', current),
    repoRoot: process.cwd(),
    toolVersion: '8.57.1',
    producerExit: current.length ? 1 : 0,
  });
}

const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

function expectThrow(name, fn, fragment) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `${name}: expected throw`);
  if (fragment) assert.ok(thrown.message.includes(fragment), `${name}: ${thrown.message}`);
}

assert.equal(parseProducerExit('0'), 0);
assert.equal(parseProducerExit('2'), 2);
for (const invalidExit of [undefined, '', 'abc', '1.0', '-1', ' 1', '01']) {
  expectThrow(
    `invalid producer exit ${String(invalidExit)}`,
    () => parseProducerExit(invalidExit),
    'required and must be a non-negative integer',
  );
}

const baseline = baselineFor([baseDiagnostic], { baseline_sha: headSha });
assert.equal(compare(baseline, [baseDiagnostic]).ok, true, 'unchanged baseline passes');

const newDiagnostic = {
  ...baseDiagnostic,
  path: 'backend/src/bar.ts',
  message: 'Unexpected any',
  code: '@typescript-eslint/no-explicit-any',
};
assert.equal(compare(baseline, [baseDiagnostic, newDiagnostic]).ok, false, 'new diagnostic fails');

const removed = compare(baseline, []);
assert.equal(removed.ok, true, 'removal passes');
assert.equal(removed.fingerprints.removed, 1, 'removal is reported');

const doubledBaseline = baselineFor([baseDiagnostic], { baseline_sha: headSha });
const increased = compare(doubledBaseline, [baseDiagnostic, baseDiagnostic]);
assert.equal(increased.ok, false, 'count increase fails');
assert.equal(increased.fingerprints.increased, 1, 'increase is reported');

expectThrow('malformed baseline', () => validateBaselineShape({ version: 1 }), 'invalid baseline kind');

const duplicate = baselineFor([baseDiagnostic]);
duplicate.diagnostics.push({ ...duplicate.diagnostics[0] });
expectThrow('duplicate fingerprint', () => validateBaselineShape(duplicate), 'duplicate fingerprint');

const stale = baselineFor([baseDiagnostic], { baseline_sha: 'not-a-sha' });
expectThrow('stale baseline schema', () => validateBaselineShape(stale), 'baseline_sha');

const notAncestor = baselineFor([baseDiagnostic], {
  baseline_sha: '0000000000000000000000000000000000000000',
});
expectThrow('stale baseline compare', () => compare(notAncestor, [baseDiagnostic]), 'not an ancestor');

const wrongTool = baselineFor([baseDiagnostic], { baseline_sha: headSha });
expectThrow(
  'wrong tool version',
  () =>
    compareDiagnostics({
      baseline: wrongTool,
      current: groupDiagnostics('eslint', [baseDiagnostic]),
      repoRoot: process.cwd(),
      toolVersion: '9.0.0',
      producerExit: 1,
    }),
  'tool version mismatch',
);

const missingProducerPolicy = baselineFor([baseDiagnostic], { baseline_sha: headSha });
delete missingProducerPolicy.tool.allowed_producer_exits;
expectThrow(
  'missing producer exit policy',
  () => validateBaselineShape(missingProducerPolicy),
  'allowed_producer_exits',
);

for (const [name, policy] of [
  ['extra producer exit', [0, 1, 2]],
  ['wrong producer exit', [0, 2]],
  ['negative producer exit', [-1, 0]],
  ['duplicate producer exit', [0, 0]],
  ['reordered producer exits', [1, 0]],
]) {
  const invalidPolicy = baselineFor([baseDiagnostic], { baseline_sha: headSha });
  invalidPolicy.tool.allowed_producer_exits = policy;
  expectThrow(
    name,
    () => validateBaselineShape(invalidPolicy),
    'must equal canonical eslint policy [0,1]',
  );
}

const missingToolName = baselineFor([baseDiagnostic], { baseline_sha: headSha });
delete missingToolName.tool.name;
expectThrow('missing tool name', () => validateBaselineShape(missingToolName), 'canonical eslint tool');

const wrongToolName = baselineFor([baseDiagnostic], { baseline_sha: headSha });
wrongToolName.tool.name = 'typescript';
expectThrow('wrong tool name', () => validateBaselineShape(wrongToolName), 'canonical eslint tool');

for (const [name, mutate] of [
  ['empty config set', () => []],
  ['missing config path', (paths) => paths.slice(0, -1)],
  [
    'extra config path',
    (paths) => [...paths, { path: 'backend/extra.json', sha256: '0'.repeat(64) }],
  ],
  [
    'replaced config path',
    (paths) => [
      ...paths.slice(0, -1),
      { path: 'backend/replaced.json', sha256: '0'.repeat(64) },
    ],
  ],
]) {
  const invalidConfigs = baselineFor([baseDiagnostic], { baseline_sha: headSha });
  invalidConfigs.config_files = mutate(invalidConfigs.config_files);
  expectThrow(
    name,
    () => validateBaselineShape(invalidConfigs),
    'config_files paths must equal canonical eslint set',
  );
}

const wrongConfig = baselineFor([baseDiagnostic], {
  baseline_sha: headSha,
  config_files: configFilesFor('eslint').map((entry, index) =>
    index === 0 ? { ...entry, sha256: '0'.repeat(64) } : entry,
  ),
});
expectThrow('wrong config hash', () => compare(wrongConfig, [baseDiagnostic]), 'config hash mismatch');

const badFingerprint = baselineFor([baseDiagnostic], { baseline_sha: headSha });
badFingerprint.diagnostics[0].fingerprint = 'f'.repeat(64);
expectThrow(
  'fingerprint mismatch',
  () => validateBaselineShape(badFingerprint),
  'fingerprint mismatch',
);

expectThrow(
  'producer failure without diagnostics',
  () =>
    compareDiagnostics({
      baseline: baselineFor([], { baseline_sha: headSha }),
      current: [],
      repoRoot: process.cwd(),
      toolVersion: '8.57.1',
      producerExit: 2,
    }),
  'no parseable diagnostics',
);

expectThrow(
  'ESLint producer crash with parseable diagnostics',
  () =>
    compareDiagnostics({
      baseline,
      current: groupDiagnostics('eslint', [baseDiagnostic]),
      repoRoot: process.cwd(),
      toolVersion: '8.57.1',
      producerExit: 2,
    }),
  'allowed exits are 0, 1',
);

expectThrow(
  'non-integer producer exit via API',
  () =>
    compareDiagnostics({
      baseline,
      current: groupDiagnostics('eslint', [baseDiagnostic]),
      repoRoot: process.cwd(),
      toolVersion: '8.57.1',
      producerExit: 1.5,
    }),
  'non-negative safe integer',
);

expectThrow(
  'ESLint success with error diagnostics',
  () =>
    compareDiagnostics({
      baseline,
      current: groupDiagnostics('eslint', [baseDiagnostic]),
      repoRoot: process.cwd(),
      toolVersion: '8.57.1',
      producerExit: 0,
    }),
  'exit/diagnostic mismatch',
);

const warningDiagnostic = { ...baseDiagnostic, severity: 'warning' };
const warningBaseline = baselineFor([warningDiagnostic], { baseline_sha: headSha });
expectThrow(
  'ESLint failure without error diagnostics',
  () =>
    compareDiagnostics({
      baseline: warningBaseline,
      current: groupDiagnostics('eslint', [warningDiagnostic]),
      repoRoot: process.cwd(),
      toolVersion: '8.57.1',
      producerExit: 1,
    }),
  'exit/diagnostic mismatch',
);

const tscDiagnostic = {
  path: 'frontend/src/foo.ts',
  severity: 'error',
  code: 'TS2344',
  message: 'Type mismatch',
  locations: [{ line: 2, column: 3 }],
};
const tscBaseline = {
  ...baselineFor([], { baseline_sha: headSha }),
  kind: 'tsc',
  tool: { name: 'typescript', version: '4.9.5', allowed_producer_exits: [0, 2] },
  config_files: configFilesFor('tsc'),
  diagnostics: groupDiagnostics('tsc', [tscDiagnostic]),
};
expectThrow(
  'TypeScript producer crash with parseable diagnostics',
  () =>
    compareDiagnostics({
      baseline: tscBaseline,
      current: groupDiagnostics('tsc', [tscDiagnostic]),
      repoRoot: process.cwd(),
      toolVersion: '4.9.5',
      producerExit: 1,
    }),
  'allowed exits are 0, 2',
);
expectThrow(
  'TypeScript success with diagnostics',
  () =>
    compareDiagnostics({
      baseline: tscBaseline,
      current: groupDiagnostics('tsc', [tscDiagnostic]),
      repoRoot: process.cwd(),
      toolVersion: '4.9.5',
      producerExit: 0,
    }),
  'exit/diagnostic mismatch',
);
expectThrow(
  'TypeScript failure without diagnostics',
  () =>
    compareDiagnostics({
      baseline: {
        ...tscBaseline,
        diagnostics: [],
      },
      current: [],
      repoRoot: process.cwd(),
      toolVersion: '4.9.5',
      producerExit: 2,
    }),
  'no parseable diagnostics',
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-baseline-'));
try {
  const eslintInput = path.join(tempDir, 'eslint.json');
  fs.writeFileSync(
    eslintInput,
    JSON.stringify([
      {
        filePath: path.join(process.cwd(), 'backend/src/foo.ts'),
        messages: [
          {
            severity: 2,
            ruleId: 'prettier/prettier',
            message: 'Delete   blank line',
            line: 10,
            column: 1,
          },
        ],
      },
    ]),
  );
  const parsedEslint = parseEslintJson(eslintInput, process.cwd(), '.');
  assert.equal(parsedEslint.length, 1, 'ESLint JSON parser groups one diagnostic');
  assert.equal(parsedEslint[0].path, 'backend/src/foo.ts');
  assert.equal(parsedEslint[0].message, 'Delete blank line');

  const eslintRootVariantInput = path.join(tempDir, 'eslint-root-variant.json');
  fs.writeFileSync(
    eslintRootVariantInput,
    JSON.stringify([
      {
        filePath: path.join(process.cwd(), 'backend/src/foo.test.ts'),
        messages: [
          {
            severity: 2,
            fatal: true,
            message: `parser project ${path.join(process.cwd(), 'backend/tsconfig.json')}`,
          },
        ],
      },
    ]),
  );
  const eslintTokenVariantInput = path.join(tempDir, 'eslint-token-variant.json');
  fs.writeFileSync(
    eslintTokenVariantInput,
    JSON.stringify([
      {
        filePath: path.join(process.cwd(), 'backend/src/foo.test.ts'),
        messages: [
          {
            severity: 2,
            fatal: true,
            message: 'parser project <tsconfigRootDir>/tsconfig.json',
          },
        ],
      },
    ]),
  );
  assert.equal(
    parseEslintJson(eslintRootVariantInput, process.cwd(), '.')[0].fingerprint,
    parseEslintJson(eslintTokenVariantInput, process.cwd(), '.')[0].fingerprint,
    'ESLint tsconfigRootDir diagnostics are stable across local and CI path rendering',
  );

  const tscInput = path.join(tempDir, 'tsc.log');
  fs.writeFileSync(
    tscInput,
    '\u001b[31msrc/foo.ts(2,3): error TS2344: Type   mismatch\u001b[0m\n',
  );
  const parsedTsc = parseTscText(tscInput, process.cwd(), 'frontend');
  assert.equal(parsedTsc.length, 1, 'TSC parser accepts plain/ANSI diagnostic output');
  assert.equal(parsedTsc[0].path, 'frontend/src/foo.ts');
  assert.equal(parsedTsc[0].code, 'TS2344');
  assert.equal(parsedTsc[0].message, 'Type mismatch');

  const globalTscInput = path.join(tempDir, 'global-tsc.log');
  fs.writeFileSync(globalTscInput, 'error TS5058: The specified path does not exist\n');
  const parsedGlobalTsc = parseTscText(globalTscInput, process.cwd(), 'frontend');
  assert.equal(parsedGlobalTsc.length, 1, 'TSC parser accepts global diagnostics');
  assert.equal(parsedGlobalTsc[0].path, '<global>');
  assert.equal(parsedGlobalTsc[0].code, 'TS5058');
  assert.equal(parsedGlobalTsc[0].message, 'The specified path does not exist');

  const mixedTscInput = path.join(tempDir, 'mixed-tsc.log');
  fs.writeFileSync(
    mixedTscInput,
    [
      'src/foo.ts(2,3): error TS2344: Type mismatch',
      'error TS5058: The specified path does not exist',
      '',
    ].join('\n'),
  );
  const parsedMixedTsc = parseTscText(mixedTscInput, process.cwd(), 'frontend');
  assert.equal(parsedMixedTsc.length, 2, 'TSC parser retains file and global diagnostics');
  const mixedComparison = compareDiagnostics({
    baseline: tscBaseline,
    current: parsedMixedTsc,
    repoRoot: process.cwd(),
    toolVersion: '4.9.5',
    producerExit: 2,
  });
  assert.equal(mixedComparison.ok, false, 'new global TSC diagnostic fails comparison');
  assert.equal(mixedComparison.fingerprints.added, 1);

  const malformedTscInput = path.join(tempDir, 'malformed-tsc.log');
  fs.writeFileSync(malformedTscInput, 'unexpected compiler failure\n');
  expectThrow(
    'unparseable tsc output',
    () => parseTscText(malformedTscInput, process.cwd(), 'frontend'),
    'unparseable nonblank lines',
  );

  const cliBaselinePath = path.join(tempDir, 'baseline.json');
  const cliInputPath = path.join(tempDir, 'eslint-cli.json');
  const cliSummaryPath = path.join(tempDir, 'summary.json');
  fs.writeFileSync(
    cliBaselinePath,
    `${JSON.stringify(baselineFor([baseDiagnostic], { baseline_sha: headSha }), null, 2)}\n`,
  );
  fs.writeFileSync(
    cliInputPath,
    JSON.stringify([
      {
        filePath: path.join(process.cwd(), 'backend/src/foo.ts'),
        messages: [
          {
            severity: 2,
            ruleId: 'prettier/prettier',
            message: 'Delete blank line',
            line: 10,
            column: 1,
          },
        ],
      },
      {
        filePath: path.join(process.cwd(), 'backend/src/bar.ts'),
        messages: [
          {
            severity: 2,
            ruleId: '@typescript-eslint/no-explicit-any',
            message: 'Unexpected any',
            line: 20,
            column: 2,
          },
        ],
      },
    ]),
  );
  const cliResult = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'diagnostic-baseline.js'),
      'compare',
      '--baseline',
      cliBaselinePath,
      '--input',
      cliInputPath,
      '--tool-version',
      '8.57.1',
      '--producer-exit',
      '1',
      '--repo-root',
      process.cwd(),
      '--workdir',
      '.',
      '--summary',
      cliSummaryPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cliResult.status, 1, 'CLI exits 1 for a new diagnostic');
  assert.match(cliResult.stdout, /diagnostic-baseline FAIL/);
  assert.match(cliResult.stderr, /ADDED backend\/src\/bar\.ts:20:2/);
  const cliSummary = JSON.parse(fs.readFileSync(cliSummaryPath, 'utf8'));
  assert.equal(cliSummary.ok, false, 'CLI emits a machine-readable failure summary');
  assert.equal(cliSummary.fingerprints.added, 1);

  const eslintSuccessMismatch = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'diagnostic-baseline.js'),
      'compare',
      '--baseline',
      cliBaselinePath,
      '--input',
      eslintInput,
      '--tool-version',
      '8.57.1',
      '--producer-exit',
      '0',
      '--repo-root',
      process.cwd(),
      '--workdir',
      '.',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(eslintSuccessMismatch.status, 1, 'CLI rejects ESLint success with errors');
  assert.match(eslintSuccessMismatch.stderr, /exit\/diagnostic mismatch/);

  const cliTscBaselinePath = path.join(tempDir, 'tsc-baseline.json');
  fs.writeFileSync(cliTscBaselinePath, `${JSON.stringify(tscBaseline, null, 2)}\n`);
  const tscSuccessMismatch = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'diagnostic-baseline.js'),
      'compare',
      '--baseline',
      cliTscBaselinePath,
      '--input',
      tscInput,
      '--tool-version',
      '4.9.5',
      '--producer-exit',
      '0',
      '--repo-root',
      process.cwd(),
      '--workdir',
      'frontend',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(tscSuccessMismatch.status, 1, 'CLI rejects TypeScript success with diagnostics');
  assert.match(tscSuccessMismatch.stderr, /exit\/diagnostic mismatch/);

  for (const [name, producerExitArgs] of [
    ['omitted', []],
    ['valueless', ['--producer-exit']],
    ['malformed', ['--producer-exit', 'abc']],
    ['fractional', ['--producer-exit', '1.5']],
    ['NaN', ['--producer-exit', 'NaN']],
  ]) {
    const invalidCli = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'diagnostic-baseline.js'),
        'compare',
        '--baseline',
        cliBaselinePath,
        '--input',
        eslintInput,
        '--tool-version',
        '8.57.1',
        '--repo-root',
        process.cwd(),
        '--workdir',
        '.',
        ...producerExitArgs,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(invalidCli.status, 1, `CLI rejects ${name} producer-exit evidence`);
    assert.match(invalidCli.stderr, /--producer-exit is required/);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

assert.match(makeFingerprint('eslint', baseDiagnostic), /^[0-9a-f]{64}$/);
console.log('diagnostic-baseline.test.js: PASS');
