#!/usr/bin/env node
/**
 * Professional LabWorkspace phase 1 contract.
 *
 * This is a source-level guard because the existing frontend tests in this repo
 * are lightweight contract checks rather than browser component tests.
 */
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

console.log('\n## LabWorkspace phase 1 contract');

const page = read('src/pages/workspace/LabWorkspace.tsx');
const service = read('src/services/labService.ts');

assert('professional lab has research ledger tab', page.includes('实验账本'));
assert('professional lab has data audit tab', page.includes('数据审计'));
assert('professional lab has execution constraint tab', page.includes('成交约束'));
assert(
  'professional create backtest sends hypothesis and policies',
  page.includes('hypothesis') &&
    page.includes('data_policy_json') &&
    page.includes('constraint_policy_json')
);
assert(
  'professional list displays audit status',
  page.includes('research_verdict') && page.includes('审计状态')
);
assert(
  'professional report compares theory/audit/executable returns',
  page.includes('理论收益') && page.includes('审计后收益') && page.includes('可成交收益')
);
assert('lab service lists research experiments', service.includes('listResearchExperiments'));
assert('lab service fetches research experiment detail', service.includes('getResearchExperiment'));
assert('lab service runs experiment audit', service.includes('runResearchExperimentAudit'));
assert('lab service fetches backtest research audit', service.includes('getBacktestResearchAudit'));
assert(
  'lab service fetches execution constraint audit',
  service.includes('getBacktestExecutionConstraintAudit') &&
    service.includes('/execution-constraint-audit')
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
