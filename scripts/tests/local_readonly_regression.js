#!/usr/bin/env node

/**
 * Local read-only regression gate.
 *
 * This script intentionally avoids network, database writes, queue writes, Agent calls and
 * paper-trading side effects. It is safe to run before commits/deploys on a developer machine.
 *
 * Deployment smoke remains API-only and should not depend on source files or ts-node.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const jsonOutPath = process.env.LOCAL_REGRESSION_JSON_OUT || '';

const checks = [
  {
    name: 'field gate adjustment attribution unit',
    command: process.execPath,
    args: [path.join(repoRoot, 'scripts/tests/field_gate_adjustment_attribution_test.js')],
  },
  {
    name: 'readonly API smoke syntax',
    command: process.execPath,
    args: ['--check', path.join(repoRoot, 'scripts/tests/smoke_readonly_core.js')],
  },
  {
    name: 'quant data freshness syntax',
    command: process.execPath,
    args: ['--check', path.join(repoRoot, 'scripts/tests/quant_data_freshness_check.js')],
  },
  {
    name: 'post deploy smoke syntax',
    command: process.execPath,
    args: ['--check', path.join(repoRoot, 'scripts/deployment/post_deploy_smoke.js')],
  },
  {
    name: 'deployment config syntax',
    command: process.execPath,
    args: ['--check', path.join(repoRoot, 'scripts/deployment/deploy_config.js')],
  },
  {
    name: 'runtime schema migration syntax',
    command: process.execPath,
    args: ['--check', path.join(repoRoot, 'scripts/deployment/runtime_schema_migration.js')],
  },
  {
    name: 'sync deploy script syntax',
    command: process.execPath,
    args: ['--check', path.join(repoRoot, 'scripts/deployment/sync_and_deploy.js')],
  },
  {
    name: 'simple deploy script syntax',
    command: process.execPath,
    args: ['--check', path.join(repoRoot, 'scripts/deployment/simple_deploy.js')],
  },
];

let failed = 0;
const results = [];
for (const check of checks) {
  const startedAt = Date.now();
  const result = spawnSync(check.command, check.args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  const elapsed = Date.now() - startedAt;
  if (result.status === 0) {
    results.push({ name: check.name, status: 'pass', elapsed_ms: elapsed });
    console.log(`[PASS] ${check.name} (${elapsed}ms)`);
  } else {
    failed += 1;
    results.push({
      name: check.name,
      status: 'fail',
      elapsed_ms: elapsed,
      exit_code: result.status,
      signal: result.signal,
    });
    console.error(`[FAIL] ${check.name} (${elapsed}ms)`);
  }
}

const summary = {
  success: failed === 0,
  passed: results.filter(item => item.status === 'pass').length,
  failed,
  total: checks.length,
  generated_at: new Date().toISOString(),
};

if (jsonOutPath) {
  fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true });
  fs.writeFileSync(jsonOutPath, JSON.stringify({ summary, results }, null, 2));
}

if (failed > 0) {
  console.error(`Local read-only regression failed: ${failed}/${checks.length}`);
  process.exit(1);
}

console.log(`Local read-only regression passed: ${summary.passed}/${summary.total}`);
