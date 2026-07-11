#!/usr/bin/env node
const assert = require('assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  canonicalEslintTargets,
  compareDiagnostics,
  compareDiagnosticSets,
  ensureBaselineIsAncestor,
  ensureConfigHashes,
  ensureEslintControlAuthority,
  groupDiagnostics,
  makeFingerprint,
  parseProducerExit,
  parseEslintJson,
  parseTscText,
  validateBaselineAuthority,
  validateBaselineShape,
  validateBaselineStructure,
  validateProducerEvidence,
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
  const grouped = groupDiagnostics('eslint', current);
  const producerExit = current.some((diagnostic) => diagnostic.severity === 'error') ? 1 : 0;
  validateBaselineStructure(baseline);
  validateProducerEvidence('eslint', grouped, producerExit);
  return compareDiagnosticSets(baseline, grouped, producerExit);
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

expectThrow('malformed baseline', () => validateBaselineStructure({ version: 1 }), 'invalid baseline kind');

const duplicate = baselineFor([baseDiagnostic]);
duplicate.diagnostics.push({ ...duplicate.diagnostics[0] });
expectThrow('duplicate fingerprint', () => validateBaselineStructure(duplicate), 'duplicate fingerprint');

const stale = baselineFor([baseDiagnostic], { baseline_sha: 'not-a-sha' });
expectThrow('stale baseline schema', () => validateBaselineStructure(stale), 'baseline_sha');

const missingProducerPolicy = baselineFor([baseDiagnostic], { baseline_sha: headSha });
delete missingProducerPolicy.tool.allowed_producer_exits;
expectThrow(
  'missing producer exit policy',
  () => validateBaselineStructure(missingProducerPolicy),
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
    () => validateBaselineStructure(invalidPolicy),
    'must equal canonical eslint policy [0,1]',
  );
}

const missingToolName = baselineFor([baseDiagnostic], { baseline_sha: headSha });
delete missingToolName.tool.name;
expectThrow('missing tool name', () => validateBaselineStructure(missingToolName), 'canonical eslint tool');

const wrongToolName = baselineFor([baseDiagnostic], { baseline_sha: headSha });
wrongToolName.tool.name = 'typescript';
expectThrow('wrong tool name', () => validateBaselineStructure(wrongToolName), 'canonical eslint tool');

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
    () => validateBaselineStructure(invalidConfigs),
    'config_files paths must equal canonical eslint set',
  );
}

const badFingerprint = baselineFor([baseDiagnostic], { baseline_sha: headSha });
badFingerprint.diagnostics[0].fingerprint = 'f'.repeat(64);
expectThrow(
  'fingerprint mismatch',
  () => validateBaselineStructure(badFingerprint),
  'fingerprint mismatch',
);

expectThrow(
  'producer failure without diagnostics',
  () =>
    validateProducerEvidence('eslint', [], 2),
  'no parseable diagnostics',
);

expectThrow(
  'ESLint producer crash with parseable diagnostics',
  () =>
    validateProducerEvidence('eslint', groupDiagnostics('eslint', [baseDiagnostic]), 2),
  'allowed exits are 0, 1',
);

expectThrow(
  'non-integer producer exit via API',
  () =>
    validateProducerEvidence('eslint', groupDiagnostics('eslint', [baseDiagnostic]), 1.5),
  'non-negative safe integer',
);

expectThrow(
  'ESLint success with error diagnostics',
  () =>
    validateProducerEvidence('eslint', groupDiagnostics('eslint', [baseDiagnostic]), 0),
  'exit/diagnostic mismatch',
);

const warningDiagnostic = { ...baseDiagnostic, severity: 'warning' };
const warningBaseline = baselineFor([warningDiagnostic], { baseline_sha: headSha });
expectThrow(
  'ESLint failure without error diagnostics',
  () =>
    validateProducerEvidence('eslint', groupDiagnostics('eslint', [warningDiagnostic]), 1),
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

const realEslintBaseline = JSON.parse(
  fs.readFileSync('docs/refactor/baseline/ci/backend-eslint-da801a52.json', 'utf8'),
);
const realTscBaseline = JSON.parse(
  fs.readFileSync('docs/refactor/baseline/ci/frontend-tsc-da801a52.json', 'utf8'),
);
validateBaselineShape(realEslintBaseline);
validateBaselineShape(realTscBaseline);
for (const [name, mutate] of [
  [
    'appended authorized-looking diagnostic',
    (ledger) => [
      ...ledger,
      {
        ...ledger[0],
        path: 'backend/src/new-debt.ts',
        fingerprint: makeFingerprint('eslint', {
          ...ledger[0],
          path: 'backend/src/new-debt.ts',
        }),
      },
    ],
  ],
  [
    'increased diagnostic count',
    (ledger) => [{ ...ledger[0], count: ledger[0].count + 1 }, ...ledger.slice(1)],
  ],
]) {
  const mutated = {
    ...realEslintBaseline,
    diagnostics: mutate(realEslintBaseline.diagnostics),
  };
  expectThrow(name, () => validateBaselineAuthority(mutated), 'ledger hash mismatch');
}
expectThrow(
  'TypeScript producer crash with parseable diagnostics',
  () =>
    validateProducerEvidence('tsc', groupDiagnostics('tsc', [tscDiagnostic]), 1),
  'allowed exits are 0, 2',
);
expectThrow(
  'TypeScript success with diagnostics',
  () =>
    validateProducerEvidence('tsc', groupDiagnostics('tsc', [tscDiagnostic]), 0),
  'exit/diagnostic mismatch',
);
expectThrow(
  'TypeScript failure without diagnostics',
  () =>
    validateProducerEvidence('tsc', [], 2),
  'no parseable diagnostics',
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-baseline-'));
try {
  function initGitRepo(repoDir) {
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'ci@example.invalid'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: repoDir });
  }

  function writeRepoFile(repoDir, relPath, contents) {
    const absPath = path.join(repoDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, contents);
  }

  function commitAll(repoDir, message) {
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: repoDir });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  }

  function configFilesInRepo(repoDir) {
    return [
      'backend/.eslintrc.js',
      'backend/tsconfig.json',
      'backend/package.json',
      'backend/package-lock.json',
    ].map((configPath) => ({
      path: configPath,
      sha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(repoDir, configPath)))
        .digest('hex'),
    }));
  }

  const driftRepo = path.join(tempDir, 'config-drift-repo');
  initGitRepo(driftRepo);
  for (const configPath of [
    'backend/.eslintrc.js',
    'backend/tsconfig.json',
    'backend/package.json',
    'backend/package-lock.json',
  ]) {
    writeRepoFile(
      driftRepo,
      configPath,
      configPath.endsWith('package.json') ? '{}\n' : `old:${configPath}\n`,
    );
  }
  const driftAnchor = commitAll(driftRepo, 'anchor');
  writeRepoFile(driftRepo, 'backend/.eslintrc.js', 'new eslint config\n');
  commitAll(driftRepo, 'child config drift');
  const driftBaseline = baselineFor([warningDiagnostic], {
    baseline_sha: driftAnchor,
    config_files: configFilesInRepo(driftRepo),
  });
  expectThrow(
    'baseline config hashes cannot be replaced with child hashes',
    () => ensureConfigHashes(driftRepo, driftBaseline),
    'baseline config hash mismatch at baseline_sha',
  );

  const missingAnchorRepo = path.join(tempDir, 'missing-anchor-config-repo');
  initGitRepo(missingAnchorRepo);
  for (const configPath of [
    'backend/.eslintrc.js',
    'backend/tsconfig.json',
    'backend/package.json',
  ]) {
    writeRepoFile(
      missingAnchorRepo,
      configPath,
      configPath.endsWith('package.json') ? '{}\n' : `stable:${configPath}\n`,
    );
  }
  const missingAnchor = commitAll(missingAnchorRepo, 'anchor without lockfile');
  writeRepoFile(missingAnchorRepo, 'backend/package-lock.json', 'added later\n');
  commitAll(missingAnchorRepo, 'child adds lockfile');
  const missingAnchorBaseline = baselineFor([warningDiagnostic], {
    baseline_sha: missingAnchor,
    config_files: configFilesInRepo(missingAnchorRepo),
  });
  expectThrow(
    'canonical config missing at anchor',
    () => ensureConfigHashes(missingAnchorRepo, missingAnchorBaseline),
    'config file missing at baseline_sha',
  );

  const ignoreRepo = path.join(tempDir, 'eslint-ignore-repo');
  initGitRepo(ignoreRepo);
  for (const configPath of [
    'backend/.eslintrc.js',
    'backend/tsconfig.json',
    'backend/package.json',
    'backend/package-lock.json',
  ]) {
    writeRepoFile(
      ignoreRepo,
      configPath,
      configPath.endsWith('package.json') ? '{}\n' : `stable:${configPath}\n`,
    );
  }
  writeRepoFile(ignoreRepo, 'backend/src/covered.ts', 'export const covered = true;\n');
  const ignoreAnchor = commitAll(ignoreRepo, 'anchor');
  writeRepoFile(ignoreRepo, 'backend/.eslintignore', 'src/covered.ts\n');
  commitAll(ignoreRepo, 'child adds ignore');
  expectThrow(
    'current eslint ignore surface rejected',
    () => ensureEslintControlAuthority(ignoreRepo, ignoreAnchor),
    'current ESLint control surfaces',
  );

  const nestedConfigRepo = path.join(tempDir, 'eslint-nested-config-repo');
  initGitRepo(nestedConfigRepo);
  for (const configPath of [
    'backend/.eslintrc.js',
    'backend/tsconfig.json',
    'backend/package.json',
    'backend/package-lock.json',
  ]) {
    writeRepoFile(
      nestedConfigRepo,
      configPath,
      configPath.endsWith('package.json') ? '{}\n' : `stable:${configPath}\n`,
    );
  }
  writeRepoFile(nestedConfigRepo, 'backend/src/.eslintrc.json', '{}\n');
  const nestedAnchor = commitAll(nestedConfigRepo, 'anchor with nested config');
  expectThrow(
    'anchor nested eslint config rejected',
    () => ensureEslintControlAuthority(nestedConfigRepo, nestedAnchor),
    'baseline ESLint control surfaces',
  );

  const eslintInput = path.join(tempDir, 'eslint.json');
  fs.writeFileSync(
    eslintInput,
    JSON.stringify([
      {
        filePath: path.join(process.cwd(), 'backend/src/foo.ts'),
        errorCount: 1,
        warningCount: 0,
        fatalErrorCount: 0,
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
  const parsedEslint = parseEslintJson(eslintInput, process.cwd(), '.', ['backend/src/foo.ts']);
  assert.equal(parsedEslint.length, 1, 'ESLint JSON parser groups one diagnostic');
  assert.equal(parsedEslint[0].path, 'backend/src/foo.ts');
  assert.equal(parsedEslint[0].message, 'Delete blank line');

  const eslintRootVariantInput = path.join(tempDir, 'eslint-root-variant.json');
  fs.writeFileSync(
    eslintRootVariantInput,
    JSON.stringify([
      {
        filePath: path.join(process.cwd(), 'backend/src/foo.test.ts'),
        errorCount: 1,
        warningCount: 0,
        fatalErrorCount: 1,
        messages: [
          {
            severity: 2,
            fatal: true,
            ruleId: null,
            line: null,
            column: null,
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
        errorCount: 1,
        warningCount: 0,
        fatalErrorCount: 1,
        messages: [
          {
            severity: 2,
            fatal: true,
            ruleId: null,
            line: null,
            column: null,
            message: 'parser project <tsconfigRootDir>/tsconfig.json',
          },
        ],
      },
    ]),
  );
  assert.equal(
    parseEslintJson(eslintRootVariantInput, process.cwd(), '.', [
      'backend/src/foo.test.ts',
    ])[0].fingerprint,
    parseEslintJson(eslintTokenVariantInput, process.cwd(), '.', [
      'backend/src/foo.test.ts',
    ])[0].fingerprint,
    'ESLint tsconfigRootDir diagnostics are stable across local and CI path rendering',
  );

  for (const [name, result] of [
    [
      'hidden ESLint error count',
      {
        filePath: path.join(process.cwd(), 'backend/src/hidden.ts'),
        errorCount: 1,
        warningCount: 0,
        fatalErrorCount: 0,
        messages: [],
      },
    ],
    [
      'missing ESLint count fields',
      {
        filePath: path.join(process.cwd(), 'backend/src/missing.ts'),
        messages: [],
      },
    ],
    [
      'negative ESLint count',
      {
        filePath: path.join(process.cwd(), 'backend/src/negative.ts'),
        errorCount: -1,
        warningCount: 0,
        fatalErrorCount: 0,
        messages: [],
      },
    ],
    [
      'invalid ESLint severity',
      {
        filePath: path.join(process.cwd(), 'backend/src/severity.ts'),
        errorCount: 0,
        warningCount: 0,
        fatalErrorCount: 0,
        messages: [{ severity: 0, message: 'hidden' }],
      },
    ],
    [
      'invalid ESLint fatal type',
      {
        filePath: path.join(process.cwd(), 'backend/src/fatal.ts'),
        errorCount: 1,
        warningCount: 0,
        fatalErrorCount: 0,
        messages: [{ severity: 2, fatal: 'yes', message: 'bad fatal' }],
      },
    ],
  ]) {
    const invalidEslintInput = path.join(tempDir, `${name.replace(/\s+/g, '-')}.json`);
    fs.writeFileSync(invalidEslintInput, JSON.stringify([result]));
    expectThrow(
      name,
      () =>
        parseEslintJson(invalidEslintInput, process.cwd(), '.', [
          repoRelativeForTest(result.filePath),
        ]),
      'ESLint',
    );
  }

  function repoRelativeForTest(filePath) {
    return path.relative(process.cwd(), filePath).split(path.sep).join('/');
  }

  const coverageResults = [
    {
      filePath: path.join(process.cwd(), 'backend/src/covered-a.ts'),
      errorCount: 0,
      warningCount: 0,
      fatalErrorCount: 0,
      messages: [],
    },
    {
      filePath: path.join(process.cwd(), 'backend/src/covered-b.ts'),
      errorCount: 0,
      warningCount: 0,
      fatalErrorCount: 0,
      messages: [],
    },
  ];
  const coverageInput = path.join(tempDir, 'eslint-coverage.json');
  fs.writeFileSync(coverageInput, JSON.stringify(coverageResults));
  const coverageTargets = ['backend/src/covered-a.ts', 'backend/src/covered-b.ts'];
  assert.deepEqual(
    parseEslintJson(coverageInput, process.cwd(), '.', coverageTargets),
    [],
    'complete zero-diagnostic ESLint target set is accepted',
  );
  for (const [name, results, targets] of [
    ['partial ESLint result set', coverageResults.slice(0, 1), coverageTargets],
    ['omitted zero-diagnostic ESLint target', coverageResults.slice(0, 1), coverageTargets],
    ['duplicate ESLint result path', [coverageResults[0], coverageResults[0]], [coverageTargets[0]]],
    [
      'extra ESLint result path',
      [...coverageResults, { ...coverageResults[0], filePath: path.join(process.cwd(), 'outside.ts') }],
      coverageTargets,
    ],
  ]) {
    const invalidCoverageInput = path.join(tempDir, `${name.replace(/\s+/g, '-')}.json`);
    fs.writeFileSync(invalidCoverageInput, JSON.stringify(results));
    expectThrow(
      name,
      () => parseEslintJson(invalidCoverageInput, process.cwd(), '.', targets),
      name.includes('duplicate') ? 'duplicate ESLint result paths' : 'target set mismatch',
    );
  }

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
  validateProducerEvidence('tsc', parsedMixedTsc, 2);
  const mixedComparison = compareDiagnosticSets(tscBaseline, parsedMixedTsc, 2);
  assert.equal(mixedComparison.ok, false, 'new global TSC diagnostic fails comparison');
  assert.equal(mixedComparison.fingerprints.added, 1);

  const malformedTscInput = path.join(tempDir, 'malformed-tsc.log');
  fs.writeFileSync(malformedTscInput, 'unexpected compiler failure\n');
  expectThrow(
    'unparseable tsc output',
    () => parseTscText(malformedTscInput, process.cwd(), 'frontend'),
    'unparseable nonblank lines',
  );

  const cliInputPath = path.join(tempDir, 'eslint-cli.json');
  const cliOldOnlyInputPath = path.join(tempDir, 'eslint-cli-old-only.json');
  const cliSummaryPath = path.join(tempDir, 'summary.json');
  const cliTargets = canonicalEslintTargets(process.cwd());
  const cliBaseDiagnostic = realEslintBaseline.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'error' && diagnostic.code !== 'fatal',
  );
  assert.ok(cliBaseDiagnostic, 'real ESLint baseline contains a nonfatal error diagnostic');
  const cliNewDiagnostic = {
    ...baseDiagnostic,
    path: cliTargets.find((target) => target !== cliBaseDiagnostic.path),
    code: 'synthetic/new-debt',
    message: 'Synthetic new debt',
    fingerprint: undefined,
  };
  cliNewDiagnostic.fingerprint = makeFingerprint('eslint', cliNewDiagnostic);
  function completeEslintResults(includeNewDiagnostic) {
    return cliTargets.map((targetPath) => {
      const messages = [];
      if (targetPath === cliBaseDiagnostic.path) {
        const location = cliBaseDiagnostic.locations[0] || { line: 1, column: 1 };
        const fatal = cliBaseDiagnostic.code === 'fatal';
        for (let index = 0; index < cliBaseDiagnostic.count; index += 1) {
          messages.push({
            severity: cliBaseDiagnostic.severity === 'error' ? 2 : 1,
            ruleId: fatal ? null : cliBaseDiagnostic.code,
            fatal: fatal || undefined,
            message: cliBaseDiagnostic.message,
            line: fatal && location.line === 0 ? null : Math.max(location.line, 1),
            column: fatal && location.column === 0 ? null : Math.max(location.column, 1),
          });
        }
      }
      if (includeNewDiagnostic && targetPath === cliNewDiagnostic.path) {
        messages.push({
          severity: 2,
          ruleId: cliNewDiagnostic.code,
          message: cliNewDiagnostic.message,
          line: 20,
          column: 2,
        });
      }
      return {
        filePath: path.join(process.cwd(), targetPath),
        errorCount: messages.filter((message) => message.severity === 2).length,
        warningCount: messages.filter((message) => message.severity === 1).length,
        fatalErrorCount: messages.filter((message) => message.fatal === true).length,
        messages,
      };
    });
  }
  fs.writeFileSync(cliInputPath, JSON.stringify(completeEslintResults(true)));
  fs.writeFileSync(cliOldOnlyInputPath, JSON.stringify(completeEslintResults(false)));
  const cliResult = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'diagnostic-baseline.js'),
      'compare',
      '--baseline',
      'docs/refactor/baseline/ci/backend-eslint-da801a52.json',
      '--input',
      cliInputPath,
      '--tool-version',
      '8.57.1',
      '--producer-exit',
      '1',
      '--repo-root',
      process.cwd(),
      '--workdir',
      'backend',
      '--summary',
      cliSummaryPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cliResult.status, 1, 'CLI exits 1 for a new diagnostic');
  assert.match(cliResult.stdout, /diagnostic-baseline FAIL/);
  assert.match(
    cliResult.stderr,
    new RegExp(`ADDED ${cliNewDiagnostic.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:20:2`),
  );
  const cliSummary = JSON.parse(fs.readFileSync(cliSummaryPath, 'utf8'));
  assert.equal(cliSummary.ok, false, 'CLI emits a machine-readable failure summary');
  assert.equal(cliSummary.fingerprints.added, 1);

  const eslintSuccessMismatch = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'diagnostic-baseline.js'),
      'compare',
      '--baseline',
      'docs/refactor/baseline/ci/backend-eslint-da801a52.json',
      '--input',
      cliOldOnlyInputPath,
      '--tool-version',
      '8.57.1',
      '--producer-exit',
      '0',
      '--repo-root',
      process.cwd(),
      '--workdir',
      'backend',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(eslintSuccessMismatch.status, 1, 'CLI rejects ESLint success with errors');
  assert.match(eslintSuccessMismatch.stderr, /exit\/diagnostic mismatch/);

  const tscSuccessMismatch = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'diagnostic-baseline.js'),
      'compare',
      '--baseline',
      'docs/refactor/baseline/ci/frontend-tsc-da801a52.json',
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
        'docs/refactor/baseline/ci/backend-eslint-da801a52.json',
        '--input',
        cliOldOnlyInputPath,
        '--tool-version',
        '8.57.1',
        '--repo-root',
        process.cwd(),
        '--workdir',
        'backend',
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
