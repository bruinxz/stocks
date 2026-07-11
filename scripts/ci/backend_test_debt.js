#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASELINE_VERSION = 1;
const BASELINE_KIND = 'backend-test-debt';
const ANCHOR_SHA = 'da801a52c6f5bc3e862e144f770113130e87e766';
const TOOL = Object.freeze({
  name: 'backend-test-debt',
  version: '1',
  command: 'cd backend && npm test -- --quiet',
});
const RUNTIME = Object.freeze({
  node_major: 20,
});
const CONFIG_PATHS = Object.freeze([
  'backend/src/scripts/run-tests.ts',
  'backend/package.json',
  'backend/package-lock.json',
]);
const FINGERPRINT_FIELDS = Object.freeze([
  'repo_relative_test_path',
  'child_exit',
  'normalized_first_semantic_diagnostic',
]);
const AUTHORIZED_ENTRIES_SHA256 =
  '5ad6410bc1c62afa1986c6754c57bb4d5237ad5c89e63e0da325e105d9cffef4';
const AUTHORIZED_TEST_PATHS_SHA256 =
  'a18d8658d65c32cc70c14face587f883a84e6e91089bc416908c45b54e93931f';
const AUTHORIZED_TEST_COUNT = 282;
const FORBIDDEN_DURABLE_PATH =
  'backend/tests/quality/test_baseline_json_schema_lint.test.ts';

function fail(message) {
  throw new Error(message);
}

function stripAnsi(value) {
  return String(value).replace(
    // CSI color/control sequences emitted by child test processes.
    // eslint-disable-next-line no-control-regex
    /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,
    '',
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDiagnostic(value, repoRoot) {
  let output = stripAnsi(value).replace(/\r/g, '').trim();
  output = output.replace(/^(?:❌|✗|×)\s*/u, '');
  output = output.replace(/^\[?(?:FAIL|FAILED)\]?\s*:?\s*/i, '');

  const normalizedRoot = path.resolve(repoRoot).split(path.sep).join('/');
  output = output.split(path.sep).join('/');
  output = output.replace(
    new RegExp(escapeRegExp(normalizedRoot), 'gi'),
    '<repo>',
  );

  // A run in another worktree must produce the same diagnostic. Only replace
  // absolute prefixes when a repository-owned path follows them.
  output = output.replace(
    /(?:[A-Za-z]:)?\/(?:[^/\s:'"`]+\/)+(backend|frontend|docs|scripts)\//g,
    '<repo>/$1/',
  );
  output = output
    .replace(/([A-Za-z0-9_.-]+\.[cm]?[jt]sx?):\d+:\d+\b/g, '$1:<line>:<column>')
    .replace(/([A-Za-z0-9_.-]+\.[cm]?[jt]sx?):\d+\b/g, '$1:<line>')
    .replace(/\(\d+,\d+\)/g, '(<line>,<column>)')
    .replace(/\bline\s+\d+(?:\s*,\s*column\s+\d+)?\b/gi, 'line <line>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gi, '<duration>')
    .replace(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g,
      '<timestamp>',
    )
    .replace(/\b0x[0-9a-f]+\b/gi, '<address>')
    .replace(/\s+/g, ' ')
    .trim();

  if (!output) fail('semantic diagnostic normalized to an empty string');
  return output;
}

function isNoiseLine(line) {
  const value = stripAnsi(line).trim();
  if (!value) return true;
  if (/^--- (?:stdout|stderr) ---$/i.test(value)) return true;
  if (/^[=\-_*#]{3,}$/.test(value)) return true;
  if (/^(?:at\s|node:internal\/|\^+$)/.test(value)) return true;
  if (
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+(?:debug|info|warn|error):\s/iu.test(
      value,
    )
  ) {
    return true;
  }
  if (/^\d+\s*\|/.test(value)) return true;
  if (/^baseline JSON discovered:/i.test(value)) return true;
  if (/^(?:✓|✔|✅|\bok\b|\[?pass(?:ed)?\]?\b)/iu.test(value)) return true;
  if (
    /^(?:[#=\-_*]+\s*)?(?:\[[^\]]+\]\s*)?(?:[A-Za-z0-9_. -]+:\s*)?\d+\s+(?:ok|pass(?:ed)?)\s*(?:[,/]|and)\s*\d+\s+fail(?:ed)?(?:\s*\([^)]*\))?(?:\s+of\s+\d+)?\s*(?:[#=\-_*]+)?$/i.test(
      value,
    )
  ) {
    return true;
  }
  return false;
}

function isStrongDiagnostic(line) {
  return /(?:❌|✗|×|\bnot ok\b|\bFAIL(?:ED)?\b|\bERROR\b|(?:Assertion|Syntax|Type|Reference|Range)?Error(?:\s*\[[^\]]+\])?:|Cannot find|ENOENT|missing|required|expected|actual\s*=|mismatch|invalid|does not exist|not found)/iu.test(
    line,
  );
}

function firstSemanticDiagnostic(lines, repoRoot) {
  const meaningful = lines.filter((line) => !isNoiseLine(line));
  if (meaningful.length === 0) {
    fail('FAIL block has no semantic diagnostic');
  }
  const selected = meaningful.find(isStrongDiagnostic) || meaningful[0];
  return normalizeDiagnostic(selected, repoRoot);
}

function validTestPath(value) {
  return /^backend\/tests\/[^/](?:.*\/)?[^/]+\.test\.ts$/.test(value) &&
    !value.includes('..') &&
    !value.includes('\\');
}

function repoTestPath(runnerPath) {
  const normalized = String(runnerPath).replace(/\\/g, '/');
  const result = normalized.startsWith('backend/')
    ? normalized
    : `backend/${normalized}`;
  if (!validTestPath(result)) fail(`invalid backend test path: ${runnerPath}`);
  return result;
}

function fingerprintFor(testPath, diagnostic, childExit = 1) {
  return crypto
    .createHash('sha256')
    .update(`${testPath}\0${childExit}\0${diagnostic}`)
    .digest('hex');
}

function entriesDigest(entries) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(entries))
    .digest('hex');
}

function testPathsDigest(paths) {
  return crypto
    .createHash('sha256')
    .update(`${[...paths].sort().join('\n')}\n`)
    .digest('hex');
}

function parseProducerExit(value) {
  if (value === undefined || value === null || value === '') {
    fail('--producer-exit is required');
  }
  if (!/^(?:0|1)$/.test(String(value))) {
    fail(`producer exit must be exactly 0 or 1, got ${String(value)}`);
  }
  return Number(value);
}

function validateRuntime() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor !== RUNTIME.node_major) {
    fail(
      `Node major mismatch: expected ${RUNTIME.node_major}, got ${process.versions.node}`,
    );
  }
}

function parseBackendTestLog(rawLog, producerExit, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '../..'));
  const exitCode = parseProducerExit(producerExit);
  const lines = stripAnsi(rawLog).replace(/\r\n?/g, '\n').split('\n');

  const summaryCandidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('Total:')) {
      summaryCandidates.push({ index: i, line: lines[i].trim() });
    }
  }
  if (summaryCandidates.length !== 1) {
    fail(`expected exactly one Total summary, found ${summaryCandidates.length}`);
  }
  const summaryMatch = summaryCandidates[0].line.match(
    /^Total: (\d+) files, (\d+) passed, (\d+) failed, (\d+(?:\.\d+)?(?:ms|s)) elapsed$/,
  );
  if (!summaryMatch) {
    fail(`malformed Total summary: ${summaryCandidates[0].line}`);
  }
  const summary = {
    total: Number(summaryMatch[1]),
    passed: Number(summaryMatch[2]),
    failed: Number(summaryMatch[3]),
  };
  if (summary.total < 1) fail('Total summary must report at least one test file');
  if (summary.total !== summary.passed + summary.failed) {
    fail(
      `summary mismatch: total=${summary.total}, passed=${summary.passed}, failed=${summary.failed}`,
    );
  }
  const expectedProducerExit = summary.failed === 0 ? 0 : 1;
  if (exitCode !== expectedProducerExit) {
    fail(
      `producer exit ${exitCode} is inconsistent with ${summary.failed} failed test files`,
    );
  }

  const recordPattern =
    /^\[(\d+)\/(\d+)\] (tests\/\S+\.test\.ts) \.\.\. (OK \((\d+(?:\.\d+)?(?:ms|s))\)|FAIL \(exit=([^,]+), (\d+(?:\.\d+)?(?:ms|s))\))$/;
  const records = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const match = line.match(recordPattern);
    if (match) {
      const failed = match[6] !== undefined;
      const childExit = failed ? Number(match[6]) : 0;
      if (
        failed &&
        (!Number.isSafeInteger(childExit) || childExit <= 0 || String(childExit) !== match[6])
      ) {
        fail(`test child returned invalid exit ${match[6]}: ${match[3]}`);
      }
      records.push({
        lineIndex: i,
        index: Number(match[1]),
        denominator: Number(match[2]),
        path: repoTestPath(match[3]),
        failed,
        childExit,
      });
    } else if (/^\[\d+\/\d+\]\s/.test(line)) {
      fail(`malformed test progress record: ${line}`);
    }
  }

  if (records.length !== summary.total) {
    fail(`summary reports ${summary.total} files but parsed ${records.length} progress records`);
  }
  if (records.some((record) => record.lineIndex >= summaryCandidates[0].index)) {
    fail('test progress record appeared after the Total summary');
  }

  const executedPaths = new Set();
  records.forEach((record, position) => {
    if (record.index !== position + 1) {
      fail(`non-sequential test progress index: expected ${position + 1}, got ${record.index}`);
    }
    if (record.denominator !== summary.total) {
      fail(
        `progress denominator mismatch for ${record.path}: ${record.denominator} != ${summary.total}`,
      );
    }
    if (executedPaths.has(record.path)) fail(`duplicate executed test path: ${record.path}`);
    executedPaths.add(record.path);
  });

  const failedRecords = records.filter((record) => record.failed);
  if (failedRecords.length !== summary.failed) {
    fail(
      `summary reports ${summary.failed} failures but parsed ${failedRecords.length} FAIL records`,
    );
  }
  if (records.length - failedRecords.length !== summary.passed) {
    fail('PASS record count does not match Total summary');
  }

  const failedListMarkers = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === 'Failed test files:') failedListMarkers.push(i);
  }
  if (summary.failed === 0 && failedListMarkers.length !== 0) {
    fail('zero-failure log unexpectedly contains Failed test files section');
  }
  if (summary.failed > 0 && failedListMarkers.length !== 1) {
    fail(`expected exactly one Failed test files section, found ${failedListMarkers.length}`);
  }

  if (summary.failed > 0) {
    const listStart = failedListMarkers[0];
    if (listStart <= summaryCandidates[0].index) {
      fail('Failed test files section must appear after the Total summary');
    }
    const listed = [];
    for (const rawLine of lines.slice(listStart + 1)) {
      const match = rawLine.match(/^\s{2}- (tests\/\S+\.test\.ts) \(exit=([^)]*)\)\s*$/);
      if (match) {
        const childExit = Number(match[2]);
        if (
          !Number.isSafeInteger(childExit) ||
          childExit <= 0 ||
          String(childExit) !== match[2]
        ) {
          fail(`failed-file list contains invalid exit ${match[2]}: ${match[1]}`);
        }
        listed.push({ path: repoTestPath(match[1]), childExit });
      }
    }
    const expected = failedRecords.map((record) => ({
      path: record.path,
      childExit: record.childExit,
    }));
    if (
      listed.length !== expected.length ||
      listed.some(
        (listedEntry, index) =>
          listedEntry.path !== expected[index].path ||
          listedEntry.childExit !== expected[index].childExit,
      )
    ) {
      fail(
        `Failed test files list mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(listed)}`,
      );
    }
    if (new Set(listed.map((entry) => entry.path)).size !== listed.length) {
      fail('duplicate path in Failed test files list');
    }
  }

  const failures = failedRecords.map((record) => {
    const recordPosition = records.indexOf(record);
    const nextLineIndex =
      recordPosition + 1 < records.length
        ? records[recordPosition + 1].lineIndex
        : summaryCandidates[0].index;
    const diagnostic = firstSemanticDiagnostic(
      lines.slice(record.lineIndex + 1, nextLineIndex),
      repoRoot,
    );
    return {
      path: record.path,
      child_exit: record.childExit,
      diagnostic,
      fingerprint: fingerprintFor(record.path, diagnostic, record.childExit),
    };
  });

  const seenFingerprints = new Set();
  for (const entry of failures) {
    if (seenFingerprints.has(entry.fingerprint)) {
      fail(`duplicate current fingerprint: ${entry.fingerprint}`);
    }
    seenFingerprints.add(entry.fingerprint);
  }

  return {
    summary,
    producer_exit: exitCode,
    failures,
    executed_tests: records.map((record) => ({
      path: record.path,
      status: record.failed ? 'FAIL' : 'OK',
      child_exit: record.childExit,
    })),
  };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gitBlobSha256(repoRoot, revision, relativePath) {
  let contents;
  try {
    contents = execFileSync('git', ['show', `${revision}:${relativePath}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    fail(`required config file is missing at ${revision}: ${relativePath}`);
  }
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function gitOutput(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    fail(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function currentConfigFiles(repoRoot) {
  return CONFIG_PATHS.map((relativePath) => {
    const absolutePath = path.resolve(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) fail(`required config file is missing: ${relativePath}`);
    return { path: relativePath, sha256: sha256File(absolutePath) };
  });
}

function discoverTrackedTestPaths(repoRoot) {
  const output = gitOutput(repoRoot, [
    'ls-files',
    '--',
    'backend/tests/**/*.test.ts',
  ]);
  if (!output) fail('tracked backend test discovery returned no files');
  const paths = output.split('\n').filter(Boolean).sort();
  if (paths.some((testPath) => !validTestPath(testPath))) {
    fail('tracked backend test discovery returned an invalid path');
  }
  if (new Set(paths).size !== paths.length) {
    fail('tracked backend test discovery returned duplicate paths');
  }
  return paths;
}

function discoverAnchorTestPaths(repoRoot) {
  const output = gitOutput(repoRoot, [
    'ls-tree',
    '-r',
    '--name-only',
    ANCHOR_SHA,
    '--',
    'backend/tests',
  ]);
  const paths = output
    .split('\n')
    .filter((testPath) => testPath.endsWith('.test.ts'))
    .sort();
  if (paths.length === 0) fail('anchor backend test discovery returned no files');
  return paths;
}

function validateTestInventory(
  executedTests,
  trackedTestPaths,
  anchorTestPaths,
  authorizedCount = AUTHORIZED_TEST_COUNT,
  authorizedPathsSha256 = AUTHORIZED_TEST_PATHS_SHA256,
) {
  if (!Array.isArray(executedTests)) fail('executed test inventory is required');
  if (!Array.isArray(trackedTestPaths)) fail('tracked test inventory is required');
  if (!Array.isArray(anchorTestPaths)) fail('anchor test inventory is required');
  const executedPaths = executedTests.map((entry) => entry.path);
  for (const [label, paths] of [['anchor', anchorTestPaths]]) {
    if (
      paths.length !== authorizedCount ||
      new Set(paths).size !== authorizedCount ||
      paths.some((testPath) => !validTestPath(testPath)) ||
      testPathsDigest(paths) !== authorizedPathsSha256
    ) {
      fail(`${label} test inventory does not match canonical path authority`);
    }
  }
  for (const [label, paths] of [
    ['current', executedPaths],
    ['tracked', trackedTestPaths],
  ]) {
    if (
      paths.length < authorizedCount ||
      new Set(paths).size !== paths.length ||
      paths.some((testPath) => !validTestPath(testPath))
    ) {
      fail(`${label} test inventory is invalid`);
    }
  }
  const executedSet = new Set(executedPaths);
  const trackedSet = new Set(trackedTestPaths);
  if (
    executedSet.size !== trackedSet.size ||
    [...executedSet].some((testPath) => !trackedSet.has(testPath))
  ) {
    fail('current executed test inventory must exactly equal current tracked tests');
  }
  for (const anchorPath of anchorTestPaths) {
    if (!executedSet.has(anchorPath) || !trackedSet.has(anchorPath)) {
      fail(`anchor test path missing from current inventory: ${anchorPath}`);
    }
  }
  const anchorSet = new Set(anchorTestPaths);
  for (const execution of executedTests) {
    if (
      !anchorSet.has(execution.path) &&
      (execution.status !== 'OK' || execution.child_exit !== 0)
    ) {
      fail(`current-only test must pass explicitly: ${execution.path}`);
    }
  }
  return executedPaths;
}

function makeBaseline(parsedRun, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '../..'));
  if (!parsedRun || !Array.isArray(parsedRun.failures)) fail('parsed run is required');
  const entries = parsedRun.failures
    .filter((entry) => entry.path !== FORBIDDEN_DURABLE_PATH)
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    version: BASELINE_VERSION,
    kind: BASELINE_KIND,
    anchor_sha: ANCHOR_SHA,
    capture_sha: ANCHOR_SHA,
    tool: { ...TOOL },
    runtime: { ...RUNTIME },
    test_inventory: {
      count: parsedRun.executed_tests.length,
      paths_sha256: testPathsDigest(
        parsedRun.executed_tests.map((entry) => entry.path),
      ),
    },
    fingerprint_model: {
      fields: [...FINGERPRINT_FIELDS],
      rule: 'exact path, child exit, and diagnostic; removals pass; additions or drift fail',
    },
    config_files: currentConfigFiles(repoRoot),
    entries,
  };
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys mismatch: expected ${wanted.join(', ')}, got ${actual.join(', ')}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function ensureAncestor(repoRoot, sha, label) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch {
    fail(`${label} ${sha} is not an ancestor of HEAD`);
  }
}

function validateBaseline(baseline, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '../..'));
  const authorizedEntriesSha256 =
    options.authorizedEntriesSha256 || AUTHORIZED_ENTRIES_SHA256;
  const authorizedTestCount =
    options.authorizedTestCount || AUTHORIZED_TEST_COUNT;
  const authorizedTestPathsSha256 =
    options.authorizedTestPathsSha256 || AUTHORIZED_TEST_PATHS_SHA256;
  requireObject(baseline, 'baseline');
  exactKeys(
    baseline,
    [
      'version',
      'kind',
      'anchor_sha',
      'capture_sha',
      'tool',
      'runtime',
      'test_inventory',
      'fingerprint_model',
      'config_files',
      'entries',
    ],
    'baseline',
  );
  if (baseline.version !== BASELINE_VERSION) fail(`baseline version must be ${BASELINE_VERSION}`);
  if (baseline.kind !== BASELINE_KIND) fail(`baseline kind must be ${BASELINE_KIND}`);
  if (baseline.anchor_sha !== ANCHOR_SHA) {
    fail(`baseline anchor must be ${ANCHOR_SHA}`);
  }
  if (typeof baseline.capture_sha !== 'string' || !/^[0-9a-f]{40}$/.test(baseline.capture_sha)) {
    fail('baseline capture_sha must be a 40-character lowercase Git SHA');
  }

  requireObject(baseline.tool, 'baseline.tool');
  exactKeys(baseline.tool, ['name', 'version', 'command'], 'baseline.tool');
  for (const [field, expected] of Object.entries(TOOL)) {
    if (baseline.tool[field] !== expected) {
      fail(`baseline tool ${field} mismatch: expected ${expected}, got ${baseline.tool[field]}`);
    }
  }

  requireObject(baseline.runtime, 'baseline.runtime');
  exactKeys(baseline.runtime, ['node_major'], 'baseline.runtime');
  if (baseline.runtime.node_major !== RUNTIME.node_major) {
    fail(
      `baseline runtime node_major mismatch: expected ${RUNTIME.node_major}, got ${String(baseline.runtime.node_major)}`,
    );
  }

  requireObject(baseline.test_inventory, 'baseline.test_inventory');
  exactKeys(
    baseline.test_inventory,
    ['count', 'paths_sha256'],
    'baseline.test_inventory',
  );
  if (
    baseline.test_inventory.count !== authorizedTestCount ||
    baseline.test_inventory.paths_sha256 !== authorizedTestPathsSha256
  ) {
    fail('baseline test inventory authority mismatch');
  }

  requireObject(baseline.fingerprint_model, 'baseline.fingerprint_model');
  exactKeys(baseline.fingerprint_model, ['fields', 'rule'], 'baseline.fingerprint_model');
  if (
    !Array.isArray(baseline.fingerprint_model.fields) ||
    baseline.fingerprint_model.fields.length !== FINGERPRINT_FIELDS.length ||
    baseline.fingerprint_model.fields.some(
      (field, index) => field !== FINGERPRINT_FIELDS[index],
    )
  ) {
    fail('baseline fingerprint fields mismatch');
  }
  if (
    baseline.fingerprint_model.rule !==
    'exact path, child exit, and diagnostic; removals pass; additions or drift fail'
  ) {
    fail('baseline fingerprint rule mismatch');
  }

  if (!Array.isArray(baseline.config_files)) fail('baseline.config_files must be an array');
  if (baseline.config_files.length !== CONFIG_PATHS.length) {
    fail(`baseline must contain exactly ${CONFIG_PATHS.length} config files`);
  }
  const configMap = new Map();
  for (const configFile of baseline.config_files) {
    requireObject(configFile, 'config file entry');
    exactKeys(configFile, ['path', 'sha256'], 'config file entry');
    if (!CONFIG_PATHS.includes(configFile.path)) {
      fail(`unexpected baseline config path: ${String(configFile.path)}`);
    }
    if (configMap.has(configFile.path)) fail(`duplicate baseline config path: ${configFile.path}`);
    if (typeof configFile.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(configFile.sha256)) {
      fail(`invalid config hash for ${configFile.path}`);
    }
    configMap.set(configFile.path, configFile.sha256);
  }
  for (const configFile of currentConfigFiles(repoRoot)) {
    const baselineHash = configMap.get(configFile.path);
    if (!baselineHash) fail(`missing baseline config path: ${configFile.path}`);
    const anchorHash = gitBlobSha256(
      repoRoot,
      baseline.anchor_sha,
      configFile.path,
    );
    if (baselineHash !== anchorHash) {
      fail(`anchor config hash mismatch for ${configFile.path}`);
    }
    if (baselineHash !== configFile.sha256) {
      fail(`config hash mismatch for ${configFile.path}`);
    }
  }

  if (!Array.isArray(baseline.entries)) fail('baseline.entries must be an array');
  const paths = new Set();
  const fingerprints = new Set();
  let previousPath = '';
  for (const entry of baseline.entries) {
    requireObject(entry, 'baseline entry');
    exactKeys(entry, ['path', 'child_exit', 'diagnostic', 'fingerprint'], 'baseline entry');
    if (typeof entry.path !== 'string' || !validTestPath(entry.path)) {
      fail(`invalid baseline test path: ${String(entry.path)}`);
    }
    if (entry.path === FORBIDDEN_DURABLE_PATH) {
      fail(`${FORBIDDEN_DURABLE_PATH} must not enter the durable baseline`);
    }
    if (!Number.isSafeInteger(entry.child_exit) || entry.child_exit <= 0) {
      fail(`invalid child_exit for ${entry.path}`);
    }
    if (paths.has(entry.path)) fail(`duplicate baseline path: ${entry.path}`);
    if (previousPath && previousPath.localeCompare(entry.path) >= 0) {
      fail('baseline entries must be sorted by unique path');
    }
    previousPath = entry.path;
    paths.add(entry.path);
    if (typeof entry.diagnostic !== 'string' || !entry.diagnostic.trim()) {
      fail(`invalid diagnostic for ${entry.path}`);
    }
    if (normalizeDiagnostic(entry.diagnostic, repoRoot) !== entry.diagnostic) {
      fail(`baseline diagnostic is not normalized for ${entry.path}`);
    }
    if (typeof entry.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) {
      fail(`invalid fingerprint for ${entry.path}`);
    }
    if (
      entry.fingerprint !==
      fingerprintFor(entry.path, entry.diagnostic, entry.child_exit)
    ) {
      fail(`fingerprint mismatch for ${entry.path}`);
    }
    if (fingerprints.has(entry.fingerprint)) {
      fail(`duplicate baseline fingerprint: ${entry.fingerprint}`);
    }
    fingerprints.add(entry.fingerprint);
  }
  const actualEntriesDigest = entriesDigest(baseline.entries);
  if (actualEntriesDigest !== authorizedEntriesSha256) {
    fail(
      `baseline entries authority mismatch: expected ${authorizedEntriesSha256}, got ${actualEntriesDigest}`,
    );
  }

  ensureAncestor(repoRoot, baseline.anchor_sha, 'baseline anchor');
  ensureAncestor(repoRoot, baseline.capture_sha, 'baseline capture_sha');
  return baseline;
}

function compareRunToBaseline(parsedRun, baseline, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '../..'));
  validateBaseline(baseline, {
    repoRoot,
    authorizedEntriesSha256: options.authorizedEntriesSha256,
    authorizedTestCount: options.authorizedTestCount,
    authorizedTestPathsSha256: options.authorizedTestPathsSha256,
  });
  if (!parsedRun || !Array.isArray(parsedRun.failures)) fail('parsed run is required');
  const usingSyntheticAuthority =
    AUTHORIZED_TEST_COUNT !== 282 ||
    options.authorizedTestCount !== undefined ||
    options.authorizedTestPathsSha256 !== undefined;
  const trackedTestPaths =
    options.trackedTestPaths ||
    (usingSyntheticAuthority
      ? parsedRun.executed_tests.map((entry) => entry.path)
      : discoverTrackedTestPaths(repoRoot));
  const anchorTestPaths =
    options.anchorTestPaths ||
    (usingSyntheticAuthority
      ? parsedRun.executed_tests.map((entry) => entry.path)
      : discoverAnchorTestPaths(repoRoot));
  validateTestInventory(
    parsedRun.executed_tests,
    trackedTestPaths,
    anchorTestPaths,
    options.authorizedTestCount || AUTHORIZED_TEST_COUNT,
    options.authorizedTestPathsSha256 || AUTHORIZED_TEST_PATHS_SHA256,
  );
  const executedByPath = new Map(
    parsedRun.executed_tests.map((entry) => [entry.path, entry]),
  );

  const currentPaths = new Set();
  const currentFingerprints = new Set();
  for (const entry of parsedRun.failures) {
    if (entry.path === FORBIDDEN_DURABLE_PATH) {
      fail(`${FORBIDDEN_DURABLE_PATH} reappeared after its required independent fix`);
    }
    if (!Number.isSafeInteger(entry.child_exit) || entry.child_exit <= 0) {
      fail(`invalid current child_exit for ${entry.path}`);
    }
    if (currentPaths.has(entry.path)) fail(`duplicate current path: ${entry.path}`);
    if (currentFingerprints.has(entry.fingerprint)) {
      fail(`duplicate current fingerprint: ${entry.fingerprint}`);
    }
    if (
      entry.fingerprint !==
      fingerprintFor(entry.path, entry.diagnostic, entry.child_exit)
    ) {
      fail(`current fingerprint mismatch for ${entry.path}`);
    }
    currentPaths.add(entry.path);
    currentFingerprints.add(entry.fingerprint);
  }

  const baselineByPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const currentByPath = new Map(parsedRun.failures.map((entry) => [entry.path, entry]));
  const added = [];
  const diagnostic_drift = [];
  const removed = [];
  const unchanged = [];

  for (const current of parsedRun.failures) {
    const known = baselineByPath.get(current.path);
    if (!known) added.push(current);
    else if (known.child_exit !== current.child_exit) {
      diagnostic_drift.push({
        path: current.path,
        baseline_diagnostic: `child_exit=${known.child_exit}`,
        current_diagnostic: `child_exit=${current.child_exit}`,
      });
    } else if (known.fingerprint !== current.fingerprint) {
      diagnostic_drift.push({
        path: current.path,
        baseline_diagnostic: known.diagnostic,
        current_diagnostic: current.diagnostic,
      });
    } else unchanged.push(current);
  }
  for (const known of baseline.entries) {
    if (!currentByPath.has(known.path)) {
      const execution = executedByPath.get(known.path);
      if (!execution || execution.status !== 'OK' || execution.child_exit !== 0) {
        fail(`baseline removal lacks same-path OK evidence: ${known.path}`);
      }
      removed.push(known);
    }
  }

  return {
    ok: added.length === 0 && diagnostic_drift.length === 0,
    producer_exit: parsedRun.producer_exit,
    summary: { ...parsedRun.summary },
    baseline_failures: baseline.entries.length,
    current_failures: parsedRun.failures.length,
    unchanged: unchanged.length,
    added,
    diagnostic_drift,
    removed,
    current: parsedRun.failures.map((entry) => ({ ...entry })),
  };
}

function parseArgs(argv) {
  const result = { _: [] };
  const allowed = new Set(['log', 'producer-exit', 'baseline', 'output']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      result._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (!allowed.has(key)) fail(`unknown option --${key}`);
    if (Object.prototype.hasOwnProperty.call(result, key)) fail(`duplicate option --${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`option --${key} requires a value`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function requireFileOption(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || !value) fail(`--${name} is required`);
  if (!fs.existsSync(value)) fail(`--${name} file does not exist: ${value}`);
  return value;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`failed to parse ${label} JSON ${filePath}: ${error.message}`);
  }
}

function commandCapture(args) {
  validateRuntime();
  const logPath = requireFileOption(args, 'log');
  if (args.baseline !== undefined) fail('--baseline is not valid with capture');
  const parsed = parseBackendTestLog(
    fs.readFileSync(logPath, 'utf8'),
    args['producer-exit'],
  );
  const baseline = makeBaseline(parsed);
  validateBaseline(baseline);
  const output = `${JSON.stringify(baseline, null, 2)}\n`;
  if (args.output) fs.writeFileSync(args.output, output);
  else process.stdout.write(output);
}

function printComparison(result) {
  console.log(
    `backend-test-debt ${result.ok ? 'PASS' : 'FAIL'}: current=${result.current_failures}, baseline=${result.baseline_failures}, added=${result.added.length}, diagnostic_drift=${result.diagnostic_drift.length}, removed=${result.removed.length}`,
  );
  for (const entry of result.added) {
    console.error(`ADDED ${entry.path}: ${entry.diagnostic}`);
  }
  for (const entry of result.diagnostic_drift) {
    console.error(
      `DIAGNOSTIC_DRIFT ${entry.path}\n  baseline: ${entry.baseline_diagnostic}\n  current:  ${entry.current_diagnostic}`,
    );
  }
  for (const entry of result.removed) {
    console.log(`BURNDOWN ${entry.path}: ${entry.diagnostic}`);
  }
}

function commandCompare(args) {
  validateRuntime();
  const logPath = requireFileOption(args, 'log');
  const baselinePath = requireFileOption(args, 'baseline');
  const parsed = parseBackendTestLog(
    fs.readFileSync(logPath, 'utf8'),
    args['producer-exit'],
  );
  const baseline = readJson(baselinePath, 'baseline');
  const result = compareRunToBaseline(parsed, baseline);
  if (args.output) {
    fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  printComparison(result);
  if (!result.ok) process.exitCode = 1;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args._.length !== 1 || !['capture', 'compare'].includes(args._[0])) {
    fail(
      'usage: backend_test_debt.js capture --log <file> --producer-exit <0|1> [--output <file>] | compare --log <file> --producer-exit <0|1> --baseline <file>',
    );
  }
  if (args._[0] === 'capture') return commandCapture(args);
  return commandCompare(args);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`backend-test-debt ERROR: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = {
  ANCHOR_SHA,
  AUTHORIZED_ENTRIES_SHA256,
  AUTHORIZED_TEST_COUNT,
  AUTHORIZED_TEST_PATHS_SHA256,
  BASELINE_KIND,
  BASELINE_VERSION,
  CONFIG_PATHS,
  FORBIDDEN_DURABLE_PATH,
  RUNTIME,
  TOOL,
  compareRunToBaseline,
  entriesDigest,
  discoverTrackedTestPaths,
  discoverAnchorTestPaths,
  fingerprintFor,
  firstSemanticDiagnostic,
  gitBlobSha256,
  makeBaseline,
  normalizeDiagnostic,
  parseBackendTestLog,
  parseProducerExit,
  testPathsDigest,
  validateBaseline,
  validateRuntime,
  validateTestInventory,
};
