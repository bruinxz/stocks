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
assert(
  'professional report uses backend audited return replay artifact',
  page.includes("artifact_type === 'audited_return_replay'") &&
    page.includes('audited_return_pct') &&
    page.includes('executable_return_pct') &&
    service.includes("'audited_return_replay'")
);
assert(
  'professional phase one surfaces concise user-story hints through tooltips',
  page.includes('labStoryHints') &&
    page.includes('StoryTooltip') &&
    page.includes('InfoCircleOutlined') &&
    [
      '把策略、股票池、区间和假设固定下来，方便以后复盘这次研究从哪来。',
      '确认当时真的能看到这些数据，避免用未来公告、未来成分股或补齐后的数据作弊。',
      '把理论信号放进 A 股真实限制里，看看涨跌停、停牌、T+1 和资金是否挡单。',
      '先看未经审计、审计后、可成交三层收益差异，再决定要不要深挖。',
      '账本负责把假设、回测任务、审计 artifact 和最终结论串起来。',
    ].every(text => page.includes(text))
);
assert(
  'professional story tooltip icon uses one centralized visual treatment',
  page.includes('labStoryTooltipIconStyle') &&
    page.includes('style={labStoryTooltipIconStyle}') &&
    !page.includes("style={{ color: '#8c8c8c', cursor: 'help', fontSize: 13 }}")
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
