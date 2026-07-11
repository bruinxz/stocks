#!/usr/bin/env node
const assert = require('assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compareDiagnostics,
  groupDiagnostics,
  makeFingerprint,
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
    tool: { name: 'eslint', version: '8.57.1' },
    fingerprint_model: {
      fields: ['kind', 'repo_relative_path', 'severity', 'rule_or_code', 'normalized_message'],
      multiplicity: 'exact count per fingerprint',
    },
    config_files: [],
    diagnostics: grouped,
    ...overrides,
  };
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

const wrongConfig = baselineFor([baseDiagnostic], {
  baseline_sha: headSha,
  config_files: [
    {
      path: 'scripts/ci/diagnostic-baseline.test.js',
      sha256: '0'.repeat(64),
    },
  ],
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

  const malformedTscInput = path.join(tempDir, 'malformed-tsc.log');
  fs.writeFileSync(malformedTscInput, 'unexpected compiler failure\n');
  expectThrow(
    'unparseable tsc output',
    () => parseTscText(malformedTscInput, process.cwd(), 'frontend'),
    'no parseable diagnostics',
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
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

assert.match(makeFingerprint('eslint', baseDiagnostic), /^[0-9a-f]{64}$/);
console.log('diagnostic-baseline.test.js: PASS');
