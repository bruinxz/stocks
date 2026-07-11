#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ANCHOR_SHA,
  AUTHORIZED_ENTRIES_SHA256,
  AUTHORIZED_TEST_COUNT,
  AUTHORIZED_TEST_PATHS_SHA256,
  FORBIDDEN_DURABLE_PATH,
  compareRunToBaseline,
  entriesDigest,
  fingerprintFor,
  makeBaseline,
  normalizeDiagnostic,
  parseBackendTestLog,
  testPathsDigest,
  validateBaseline,
} = require('./backend_test_debt');

const repoRoot = path.resolve(__dirname, '../..');

function failure(pathname, diagnostic, extra = [], childExit = 1) {
  return { pathname, diagnostic, extra, childExit };
}

function makeLog({
  failures = [
    failure(
      'tests/services/alpha.test.ts',
      '❌ expected status healthy but got critical at /tmp/stocks/backend/src/a.ts:42:9',
      ['  ✅ setup passes'],
    ),
    failure(
      'tests/services/beta.test.ts',
      'AssertionError [ERR_ASSERTION]: registry entry missing',
    ),
  ],
  passing = ['tests/services/gamma.test.ts'],
  elapsed = '1.2s',
  summary,
  includeFailedList = true,
}) {
  const records = [
    ...failures.map((item) => ({ ...item, failed: true })),
    ...passing.map((pathname) => ({ pathname, failed: false })),
  ];
  const lines = [`Running ${records.length} test file(s)...`, ''];
  records.forEach((record, index) => {
    if (record.failed) {
      lines.push(
        `[${index + 1}/${records.length}] ${record.pathname} ... FAIL (exit=${record.childExit}, 12ms)`,
        '--- stdout ---',
        ...(record.extra || []),
        record.diagnostic,
      );
    } else {
      lines.push(`[${index + 1}/${records.length}] ${record.pathname} ... OK (8ms)`);
    }
  });
  lines.push(
    '',
    '================================================',
    summary ||
      `Total: ${records.length} files, ${passing.length} passed, ${failures.length} failed, ${elapsed} elapsed`,
    '================================================',
  );
  if (failures.length > 0 && includeFailedList) {
    lines.push(
      '',
      'Failed test files:',
      ...failures.map((item) => `  - ${item.pathname} (exit=${item.childExit})`),
    );
  }
  return `${lines.join('\n')}\n`;
}

function expectThrow(name, fn, fragment) {
  let error;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${name}: expected an error`);
  if (fragment) {
    assert.match(error.message, new RegExp(fragment), `${name}: ${error.message}`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const exactLog = makeLog({});
const exactRun = parseBackendTestLog(exactLog, 1, { repoRoot });
assert.deepEqual(exactRun.summary, { total: 3, passed: 1, failed: 2 });
assert.equal(exactRun.failures.length, 2);
assert.equal(exactRun.failures[0].child_exit, 1);
assert.equal(exactRun.failures[0].path, 'backend/tests/services/alpha.test.ts');
assert.equal(
  exactRun.failures[0].diagnostic,
  'expected status healthy but got critical at <repo>/backend/src/a.ts:<line>:<column>',
);
assert.equal(
  exactRun.failures[1].diagnostic,
  'AssertionError [ERR_ASSERTION]: registry entry missing',
);
assert.equal(
  exactRun.failures[0].fingerprint,
  fingerprintFor(
    exactRun.failures[0].path,
    exactRun.failures[0].diagnostic,
    exactRun.failures[0].child_exit,
  ),
);

const baseline = makeBaseline(exactRun, { repoRoot });
// Unit fixtures are intentionally synthetic; bind the module constant only to
// the real checked-in anchor ledger and exercise authority below via mutation.
assert.notEqual(entriesDigest(baseline.entries), AUTHORIZED_ENTRIES_SHA256);
validateBaseline(baseline, { repoRoot, authorizedEntriesSha256: entriesDigest(baseline.entries), authorizedTestCount: baseline.test_inventory.count, authorizedTestPathsSha256: baseline.test_inventory.paths_sha256 });
const unchanged = compareRunToBaseline(exactRun, baseline, { repoRoot, authorizedEntriesSha256: entriesDigest(baseline.entries), authorizedTestCount: baseline.test_inventory.count, authorizedTestPathsSha256: baseline.test_inventory.paths_sha256 });
assert.equal(unchanged.ok, true, 'unchanged failures pass');
assert.equal(unchanged.unchanged, 2);
assert.equal(unchanged.removed.length, 0);

const removalRun = parseBackendTestLog(
  makeLog({
    failures: [
      failure(
        'tests/services/alpha.test.ts',
        '❌ expected status healthy but got critical at /tmp/stocks/backend/src/a.ts:99:2',
      ),
    ],
    passing: ['tests/services/beta.test.ts', 'tests/services/gamma.test.ts'],
  }),
  1,
  { repoRoot },
);
const removal = compareRunToBaseline(removalRun, baseline, { repoRoot, authorizedEntriesSha256: entriesDigest(baseline.entries), authorizedTestCount: baseline.test_inventory.count, authorizedTestPathsSha256: baseline.test_inventory.paths_sha256 });
assert.equal(removal.ok, true, 'failure removal passes');
assert.deepEqual(
  removal.removed.map((entry) => entry.path),
  ['backend/tests/services/beta.test.ts'],
);

const allGreenRun = parseBackendTestLog(
  makeLog({
    failures: [],
    passing: [
      'tests/services/alpha.test.ts',
      'tests/services/beta.test.ts',
      'tests/services/gamma.test.ts',
    ],
  }),
  0,
  { repoRoot },
);
const allGreen = compareRunToBaseline(allGreenRun, baseline, { repoRoot, authorizedEntriesSha256: entriesDigest(baseline.entries), authorizedTestCount: baseline.test_inventory.count, authorizedTestPathsSha256: baseline.test_inventory.paths_sha256 });
assert.equal(allGreen.ok, true, 'all debt removed passes');
assert.equal(allGreen.removed.length, 2);

const additionRun = parseBackendTestLog(
  makeLog({
    failures: [
      ...[
        failure(
          'tests/services/alpha.test.ts',
          'expected status healthy but got critical at /tmp/stocks/backend/src/a.ts:42:9',
        ),
        failure('tests/services/beta.test.ts', 'AssertionError [ERR_ASSERTION]: registry entry missing'),
      ],
      failure('tests/services/gamma.test.ts', 'Error: new regression'),
    ],
    passing: [],
  }),
  1,
  { repoRoot },
);
const addition = compareRunToBaseline(additionRun, baseline, { repoRoot, authorizedEntriesSha256: entriesDigest(baseline.entries), authorizedTestCount: baseline.test_inventory.count, authorizedTestPathsSha256: baseline.test_inventory.paths_sha256 });
assert.equal(addition.ok, false, 'new failure path fails');
assert.deepEqual(
  addition.added.map((entry) => entry.path),
  ['backend/tests/services/gamma.test.ts'],
);

const driftRun = parseBackendTestLog(
  makeLog({
    failures: [
      failure('tests/services/alpha.test.ts', 'Error: a semantically different failure'),
      failure('tests/services/beta.test.ts', 'AssertionError [ERR_ASSERTION]: registry entry missing'),
    ],
    passing: ['tests/services/gamma.test.ts'],
  }),
  1,
  { repoRoot },
);
const drift = compareRunToBaseline(driftRun, baseline, { repoRoot, authorizedEntriesSha256: entriesDigest(baseline.entries), authorizedTestCount: baseline.test_inventory.count, authorizedTestPathsSha256: baseline.test_inventory.paths_sha256 });
assert.equal(drift.ok, false, 'diagnostic drift fails');
assert.deepEqual(
  drift.diagnostic_drift.map((entry) => entry.path),
  ['backend/tests/services/alpha.test.ts'],
);

expectThrow(
  'missing summary',
  () => parseBackendTestLog(exactLog.replace(/^Total:.*\n/m, ''), 1, { repoRoot }),
  'exactly one Total summary',
);
expectThrow(
  'duplicate summary',
  () =>
    parseBackendTestLog(
      exactLog.replace(
        'Total: 3 files, 1 passed, 2 failed, 1.2s elapsed',
        'Total: 3 files, 1 passed, 2 failed, 1.2s elapsed\nTotal: 3 files, 1 passed, 2 failed, 1.2s elapsed',
      ),
      1,
      { repoRoot },
    ),
  'exactly one Total summary',
);
expectThrow(
  'malformed summary',
  () =>
    parseBackendTestLog(
      exactLog.replace(', 1.2s elapsed', ''),
      1,
      { repoRoot },
    ),
  'malformed Total summary',
);
expectThrow(
  'summary arithmetic mismatch',
  () =>
    parseBackendTestLog(
      exactLog.replace('Total: 3 files, 1 passed, 2 failed', 'Total: 3 files, 2 passed, 2 failed'),
      1,
      { repoRoot },
    ),
  'summary mismatch',
);
expectThrow(
  'summary failure mismatch',
  () =>
    parseBackendTestLog(
      exactLog.replace('Total: 3 files, 1 passed, 2 failed', 'Total: 3 files, 2 passed, 1 failed'),
      1,
      { repoRoot },
    ),
  'FAIL records',
);
expectThrow(
  'truncated progress',
  () =>
    parseBackendTestLog(
      exactLog.replace(/^\[3\/3\].*\n/m, ''),
      1,
      { repoRoot },
    ),
  'parsed 2 progress records',
);
expectThrow(
  'missing failed list',
  () => parseBackendTestLog(makeLog({ includeFailedList: false }), 1, { repoRoot }),
  'Failed test files section',
);
expectThrow(
  'failed list mismatch',
  () =>
    parseBackendTestLog(
      exactLog.replace(
        '  - tests/services/beta.test.ts (exit=1)',
        '  - tests/services/other.test.ts (exit=1)',
      ),
      1,
      { repoRoot },
    ),
  'list mismatch',
);
expectThrow(
  'duplicate execution path',
  () =>
    parseBackendTestLog(
      exactLog.replace(
        '[2/3] tests/services/beta.test.ts',
        '[2/3] tests/services/alpha.test.ts',
      ),
      1,
      { repoRoot },
    ),
  'duplicate executed test path',
);
expectThrow(
  'malformed progress',
  () =>
    parseBackendTestLog(
      exactLog.replace('FAIL (exit=1, 12ms)', 'FAIL exit=1'),
      1,
      { repoRoot },
    ),
  'malformed test progress',
);
expectThrow(
  'invalid child exit',
  () =>
    parseBackendTestLog(
      exactLog.replace('FAIL (exit=1, 12ms)', 'FAIL (exit=null, 12ms)'),
      1,
      { repoRoot },
    ),
  'invalid exit',
);
expectThrow(
  'producer crash',
  () => parseBackendTestLog(exactLog, 2, { repoRoot }),
  'producer exit must be exactly 0 or 1',
);
expectThrow(
  'producer null',
  () => parseBackendTestLog(exactLog, null, { repoRoot }),
  'producer-exit is required',
);
expectThrow(
  'failure exit mismatch',
  () => parseBackendTestLog(exactLog, 0, { repoRoot }),
  'inconsistent',
);
expectThrow(
  'green exit mismatch',
  () =>
    parseBackendTestLog(
      makeLog({
        failures: [],
        passing: ['tests/services/alpha.test.ts'],
      }),
      1,
      { repoRoot },
    ),
  'inconsistent',
);
expectThrow(
  'no semantic diagnostic',
  () =>
    parseBackendTestLog(
      makeLog({
        failures: [failure('tests/services/alpha.test.ts', '✅ only positive output')],
        passing: [],
      }),
      1,
      { repoRoot },
    ),
  'no semantic diagnostic',
);
const summaryThenCause = parseBackendTestLog(
  makeLog({
    failures: [
      failure(
        'tests/services/alpha.test.ts',
        'AssertionError: expected alpha',
        ['Summary: 12 passed, 1 failed'],
      ),
    ],
    passing: [],
  }),
  1,
  { repoRoot },
);
assert.equal(
  summaryThenCause.failures[0].diagnostic,
  'AssertionError: expected alpha',
  'count-only summary is noise; root cause is fingerprinted',
);
expectThrow(
  'summary-only failure block',
  () =>
    parseBackendTestLog(
      makeLog({
        failures: [
          failure(
            'tests/services/alpha.test.ts',
            'Summary: 12 passed, 1 failed',
          ),
        ],
        passing: [],
      }),
      1,
      { repoRoot },
    ),
  'no semantic diagnostic',
);

const ansiDiagnostic = normalizeDiagnostic(
  '\u001b[31m❌ Error at /one/worktree/backend/src/foo.ts:10:2 after 91ms\u001b[0m',
  repoRoot,
);
const otherWorktreeDiagnostic = normalizeDiagnostic(
  'Error at /another/worktree/backend/src/foo.ts:999:8 after 2.4s',
  repoRoot,
);
assert.equal(
  ansiDiagnostic,
  otherWorktreeDiagnostic,
  'ANSI, worktree root, locations, and durations normalize stably',
);
assert.notEqual(
  normalizeDiagnostic('Error: expected alpha', repoRoot),
  normalizeDiagnostic('Error: expected beta', repoRoot),
  'distinct semantic diagnostics stay distinct',
);

const duplicatePathBaseline = clone(baseline);
duplicatePathBaseline.entries.push({ ...duplicatePathBaseline.entries[0] });
expectThrow(
  'duplicate baseline path',
  () => validateBaseline(duplicatePathBaseline, { repoRoot, authorizedEntriesSha256: entriesDigest(duplicatePathBaseline.entries), authorizedTestCount: duplicatePathBaseline.test_inventory.count, authorizedTestPathsSha256: duplicatePathBaseline.test_inventory.paths_sha256 }),
  'duplicate baseline path|sorted by unique path',
);

const duplicateFingerprintBaseline = clone(baseline);
duplicateFingerprintBaseline.entries[1].fingerprint =
  duplicateFingerprintBaseline.entries[0].fingerprint;
expectThrow(
  'duplicate or invalid baseline fingerprint',
  () => validateBaseline(duplicateFingerprintBaseline, { repoRoot, authorizedEntriesSha256: entriesDigest(duplicateFingerprintBaseline.entries), authorizedTestCount: duplicateFingerprintBaseline.test_inventory.count, authorizedTestPathsSha256: duplicateFingerprintBaseline.test_inventory.paths_sha256 }),
  'fingerprint mismatch|duplicate baseline fingerprint',
);

const malformedEntryBaseline = clone(baseline);
delete malformedEntryBaseline.entries[0].diagnostic;
expectThrow(
  'malformed baseline entry',
  () => validateBaseline(malformedEntryBaseline, { repoRoot, authorizedEntriesSha256: entriesDigest(malformedEntryBaseline.entries), authorizedTestCount: malformedEntryBaseline.test_inventory.count, authorizedTestPathsSha256: malformedEntryBaseline.test_inventory.paths_sha256 }),
  'keys mismatch',
);

const childExitDriftRun = parseBackendTestLog(
  makeLog({
    failures: [
      failure(
        'tests/services/alpha.test.ts',
        'expected status healthy but got critical at /tmp/stocks/backend/src/a.ts:42:9',
        [],
        2,
      ),
      failure(
        'tests/services/beta.test.ts',
        'AssertionError [ERR_ASSERTION]: registry entry missing',
      ),
    ],
    passing: ['tests/services/gamma.test.ts'],
  }),
  1,
  { repoRoot },
);
const childExitDrift = compareRunToBaseline(childExitDriftRun, baseline, { repoRoot, authorizedEntriesSha256: entriesDigest(baseline.entries), authorizedTestCount: baseline.test_inventory.count, authorizedTestPathsSha256: baseline.test_inventory.paths_sha256 });
assert.equal(childExitDrift.ok, false, 'child exit drift fails');
assert.equal(childExitDrift.diagnostic_drift.length, 1);
assert.match(childExitDrift.diagnostic_drift[0].current_diagnostic, /child_exit=2/);

const syntheticAnchorPaths = exactRun.executed_tests.map((entry) => entry.path);
const syntheticInventoryAuthority = {
  repoRoot,
  authorizedEntriesSha256: entriesDigest(baseline.entries),
  authorizedTestCount: baseline.test_inventory.count,
  authorizedTestPathsSha256: baseline.test_inventory.paths_sha256,
  anchorTestPaths: syntheticAnchorPaths,
};
const omittedExecutionRun = clone(exactRun);
omittedExecutionRun.executed_tests = omittedExecutionRun.executed_tests.filter(
  (entry) => entry.path !== 'backend/tests/services/beta.test.ts',
);
omittedExecutionRun.failures = omittedExecutionRun.failures.filter(
  (entry) => entry.path !== 'backend/tests/services/beta.test.ts',
);
expectThrow(
  'omitted failing test cannot masquerade as removal',
  () =>
    compareRunToBaseline(omittedExecutionRun, baseline, {
      repoRoot,
      authorizedEntriesSha256: entriesDigest(baseline.entries),
      authorizedTestCount: baseline.test_inventory.count,
      authorizedTestPathsSha256: baseline.test_inventory.paths_sha256,
      trackedTestPaths: omittedExecutionRun.executed_tests.map((entry) => entry.path),
      anchorTestPaths: syntheticAnchorPaths,
    }),
  'anchor test path missing|inventory',
);
const replacedExecutionRun = clone(exactRun);
replacedExecutionRun.executed_tests[0].path =
  'backend/tests/services/replaced.test.ts';
expectThrow(
  'replaced test path fails inventory authority',
  () =>
    compareRunToBaseline(replacedExecutionRun, baseline, {
      repoRoot,
      authorizedEntriesSha256: entriesDigest(baseline.entries),
      authorizedTestCount: baseline.test_inventory.count,
      authorizedTestPathsSha256: baseline.test_inventory.paths_sha256,
      trackedTestPaths: replacedExecutionRun.executed_tests.map((entry) => entry.path),
      anchorTestPaths: syntheticAnchorPaths,
    }),
  'anchor test path missing|inventory',
);
const newPassingExecutionRun = clone(exactRun);
newPassingExecutionRun.executed_tests.push({
  path: 'backend/tests/services/extra.test.ts',
  status: 'OK',
  child_exit: 0,
});
const evolvedPassing = compareRunToBaseline(newPassingExecutionRun, baseline, {
  ...syntheticInventoryAuthority,
  trackedTestPaths: newPassingExecutionRun.executed_tests.map((entry) => entry.path),
});
assert.equal(
  evolvedPassing.ok,
  true,
  'new tracked+executed explicit OK test is allowed',
);

const newUnexecutedRun = clone(exactRun);
expectThrow(
  'new tracked but unexecuted test fails',
  () =>
    compareRunToBaseline(newUnexecutedRun, baseline, {
      ...syntheticInventoryAuthority,
      trackedTestPaths: [
        ...syntheticAnchorPaths,
        'backend/tests/services/extra.test.ts',
      ],
    }),
  'executed test inventory must exactly equal',
);

const newFailingRun = clone(exactRun);
const newFailingPath = 'backend/tests/services/extra.test.ts';
const newFailingDiagnostic = 'Error: new tracked failure';
newFailingRun.executed_tests.push({
  path: newFailingPath,
  status: 'FAIL',
  child_exit: 1,
});
newFailingRun.failures.push({
  path: newFailingPath,
  child_exit: 1,
  diagnostic: newFailingDiagnostic,
  fingerprint: fingerprintFor(newFailingPath, newFailingDiagnostic, 1),
});
expectThrow(
  'new tracked failing test rejects',
  () =>
    compareRunToBaseline(newFailingRun, baseline, {
      ...syntheticInventoryAuthority,
      trackedTestPaths: newFailingRun.executed_tests.map((entry) => entry.path),
    }),
  'current-only test must pass explicitly',
);

const extraUntrackedRun = clone(newPassingExecutionRun);
expectThrow(
  'extra untracked execution rejects',
  () =>
    compareRunToBaseline(extraUntrackedRun, baseline, {
      ...syntheticInventoryAuthority,
      trackedTestPaths: syntheticAnchorPaths,
    }),
  'executed test inventory must exactly equal',
);

const duplicateExecutionRun = clone(exactRun);
duplicateExecutionRun.executed_tests[1].path =
  duplicateExecutionRun.executed_tests[0].path;
expectThrow(
  'duplicate execution path fails inventory authority',
  () =>
    compareRunToBaseline(duplicateExecutionRun, baseline, {
      repoRoot,
      authorizedEntriesSha256: entriesDigest(baseline.entries),
      authorizedTestCount: baseline.test_inventory.count,
      authorizedTestPathsSha256: baseline.test_inventory.paths_sha256,
      trackedTestPaths: duplicateExecutionRun.executed_tests.map((entry) => entry.path),
      anchorTestPaths: syntheticAnchorPaths,
    }),
  'inventory',
);
assert.equal(
  testPathsDigest(removalRun.executed_tests.map((entry) => entry.path)),
  baseline.test_inventory.paths_sha256,
  'true FAIL→same-path OK removal keeps canonical execution inventory',
);

const wrongAnchorBaseline = clone(baseline);
wrongAnchorBaseline.anchor_sha = '0'.repeat(40);
expectThrow(
  'wrong baseline anchor',
  () => validateBaseline(wrongAnchorBaseline, { repoRoot, authorizedEntriesSha256: entriesDigest(wrongAnchorBaseline.entries), authorizedTestCount: wrongAnchorBaseline.test_inventory.count, authorizedTestPathsSha256: wrongAnchorBaseline.test_inventory.paths_sha256 }),
  'baseline anchor must be',
);

const staleCaptureBaseline = clone(baseline);
staleCaptureBaseline.capture_sha = '0'.repeat(40);
expectThrow(
  'stale capture sha',
  () => validateBaseline(staleCaptureBaseline, { repoRoot, authorizedEntriesSha256: entriesDigest(staleCaptureBaseline.entries), authorizedTestCount: staleCaptureBaseline.test_inventory.count, authorizedTestPathsSha256: staleCaptureBaseline.test_inventory.paths_sha256 }),
  'not an ancestor',
);

const wrongToolBaseline = clone(baseline);
wrongToolBaseline.tool.version = '2';
expectThrow(
  'wrong tool version',
  () => validateBaseline(wrongToolBaseline, { repoRoot, authorizedEntriesSha256: entriesDigest(wrongToolBaseline.entries), authorizedTestCount: wrongToolBaseline.test_inventory.count, authorizedTestPathsSha256: wrongToolBaseline.test_inventory.paths_sha256 }),
  'tool version mismatch',
);

const wrongConfigBaseline = clone(baseline);
wrongConfigBaseline.config_files[0].sha256 = '0'.repeat(64);
expectThrow(
  'wrong config hash',
  () => validateBaseline(wrongConfigBaseline, { repoRoot, authorizedEntriesSha256: entriesDigest(wrongConfigBaseline.entries), authorizedTestCount: wrongConfigBaseline.test_inventory.count, authorizedTestPathsSha256: wrongConfigBaseline.test_inventory.paths_sha256 }),
  'config hash mismatch',
);

const childConfigBaseline = clone(baseline);
const configPath = childConfigBaseline.config_files[0].path;
const configContents = fs.readFileSync(path.join(repoRoot, configPath));
const changedContents = Buffer.concat([configContents, Buffer.from('\n// drift\n')]);
fs.writeFileSync(path.join(repoRoot, configPath), changedContents);
childConfigBaseline.config_files[0].sha256 = require('crypto')
  .createHash('sha256')
  .update(changedContents)
  .digest('hex');
expectThrow(
  'child checkout hash cannot replace anchor config hash',
  () => validateBaseline(childConfigBaseline, { repoRoot, authorizedEntriesSha256: entriesDigest(childConfigBaseline.entries), authorizedTestCount: childConfigBaseline.test_inventory.count, authorizedTestPathsSha256: childConfigBaseline.test_inventory.paths_sha256 }),
  'anchor config hash mismatch',
);
fs.writeFileSync(path.join(repoRoot, configPath), configContents);

const forbiddenRun = parseBackendTestLog(
  makeLog({
    failures: [
      failure(
        FORBIDDEN_DURABLE_PATH.replace(/^backend\//, ''),
        'Error: malformed baseline JSON',
      ),
    ],
    passing: [],
  }),
  1,
  { repoRoot },
);
const forbiddenFilteredBaseline = makeBaseline(forbiddenRun, { repoRoot });
assert.equal(
  forbiddenFilteredBaseline.entries.length,
  0,
  'fixed schema-lint failure is omitted from durable anchor entries',
);

const realBaseline = JSON.parse(
  fs.readFileSync(
    path.join(
      repoRoot,
      'docs/refactor/baseline/ci/backend-test-debt-da801a52.json',
    ),
    'utf8',
  ),
);
assert.equal(
  entriesDigest(realBaseline.entries),
  AUTHORIZED_ENTRIES_SHA256,
  'checked-in durable ledger matches code-owned authority digest',
);
validateBaseline(realBaseline, { repoRoot });
const grownRealBaseline = clone(realBaseline);
grownRealBaseline.entries.push({
  path: 'backend/tests/services/z-new-debt.test.ts',
  child_exit: 1,
  diagnostic: 'Error: new debt hidden by baseline growth',
  fingerprint: fingerprintFor(
    'backend/tests/services/z-new-debt.test.ts',
    'Error: new debt hidden by baseline growth',
    1,
  ),
});
expectThrow(
  'durable ledger append cannot authorize itself',
  () => validateBaseline(grownRealBaseline, { repoRoot }),
  'baseline entries authority mismatch',
);
const increasedRealBaseline = clone(realBaseline);
increasedRealBaseline.entries[0].diagnostic += ' increased allowance';
increasedRealBaseline.entries[0].fingerprint = fingerprintFor(
  increasedRealBaseline.entries[0].path,
  increasedRealBaseline.entries[0].diagnostic,
  increasedRealBaseline.entries[0].child_exit,
);
expectThrow(
  'durable ledger reason change cannot authorize itself',
  () => validateBaseline(increasedRealBaseline, { repoRoot }),
  'baseline entries authority mismatch',
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-test-debt-'));
const cliToolPath = path.join(
  __dirname,
  `.backend_test_debt.${process.pid}.test.js`,
);
try {
  fs.writeFileSync(
    cliToolPath,
    fs
      .readFileSync(path.join(__dirname, 'backend_test_debt.js'), 'utf8')
      .replace(
        AUTHORIZED_ENTRIES_SHA256,
        entriesDigest(baseline.entries),
      )
      .replace(
        AUTHORIZED_TEST_PATHS_SHA256,
        baseline.test_inventory.paths_sha256,
      )
      .replace(
        `const AUTHORIZED_TEST_COUNT = ${AUTHORIZED_TEST_COUNT};`,
        `const AUTHORIZED_TEST_COUNT = ${baseline.test_inventory.count};`,
      ),
  );
  const logPath = path.join(tempDir, 'backend-test.log');
  const baselinePath = path.join(tempDir, 'baseline.json');
  const removedLogPath = path.join(tempDir, 'removed.log');
  fs.writeFileSync(logPath, exactLog);

  const capture = spawnSync(
    process.execPath,
    [
      cliToolPath,
      'capture',
      '--log',
      logPath,
      '--producer-exit',
      '1',
      '--output',
      baselinePath,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(capture.status, 0, capture.stderr);
  assert.equal(capture.stdout, '', 'capture --output does not mix JSON with status output');
  const captured = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  assert.equal(captured.anchor_sha, ANCHOR_SHA);
  assert.equal(captured.entries.length, 2);

  fs.writeFileSync(removedLogPath, makeLog({
    failures: [
      failure(
        'tests/services/alpha.test.ts',
        'expected status healthy but got critical at /tmp/stocks/backend/src/a.ts:1:1',
      ),
    ],
    passing: ['tests/services/beta.test.ts', 'tests/services/gamma.test.ts'],
  }));
  const compare = spawnSync(
    process.execPath,
    [
      cliToolPath,
      'compare',
      '--log',
      removedLogPath,
      '--producer-exit',
      '1',
      '--baseline',
      baselinePath,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(compare.status, 0, compare.stderr);
  assert.match(compare.stdout, /backend-test-debt PASS/);
  assert.match(compare.stdout, /BURNDOWN backend\/tests\/services\/beta\.test\.ts/);

  fs.writeFileSync(path.join(tempDir, 'malformed.json'), '{');
  const malformed = spawnSync(
    process.execPath,
    [
      cliToolPath,
      'compare',
      '--log',
      logPath,
      '--producer-exit',
      '1',
      '--baseline',
      path.join(tempDir, 'malformed.json'),
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(malformed.status, 2, 'malformed baseline JSON fails closed with tool error');
  assert.match(malformed.stderr, /failed to parse baseline JSON/);

  const addedCliLog = path.join(tempDir, 'added.log');
  fs.writeFileSync(
    addedCliLog,
    makeLog({
      failures: [
        failure(
          'tests/services/alpha.test.ts',
          'expected status healthy but got critical at /tmp/stocks/backend/src/a.ts:42:9',
        ),
        failure('tests/services/beta.test.ts', 'AssertionError [ERR_ASSERTION]: registry entry missing'),
        failure('tests/services/gamma.test.ts', 'Error: new regression'),
      ],
      passing: [],
    }),
  );
  const addedCli = spawnSync(
    process.execPath,
    [
      cliToolPath,
      'compare',
      '--log',
      addedCliLog,
      '--producer-exit',
      '1',
      '--baseline',
      baselinePath,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(addedCli.status, 1, 'new debt has comparator exit 1');
  assert.match(addedCli.stdout, /backend-test-debt FAIL/);
  assert.match(addedCli.stderr, /ADDED backend\/tests\/services\/gamma\.test\.ts/);
} finally {
  fs.rmSync(cliToolPath, { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('test_backend_test_debt.js: PASS');
