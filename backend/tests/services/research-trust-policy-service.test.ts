/**
 * ResearchTrustPolicyService tests — phase 1 ideal-state hard gates.
 *
 * These tests protect the "trusted research" boundary from becoming a UI-only
 * affordance. PIT, audited returns, and A-share execution reality must be
 * enforced by shared backend code and wired into the real callers.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  researchTrustPolicyService,
  buildPointInTimeFactorWhere,
} from '../../src/services/research/ResearchTrustPolicyService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function readSrc(relativePath: string) {
  return fs.readFileSync(path.join(__dirname, '../../src', relativePath), 'utf8');
}

console.log('\n## ResearchTrustPolicyService hard policy');

const trustedBacktest = researchTrustPolicyService.normalizeBacktestOptions({
  strategy_keys: ['multi_factor_alpha'],
  start_date: '2025-01-01',
  end_date: '2025-12-31',
  execution_timing: 'same_close',
  enable_t_plus_one: false,
  block_limit_up: false,
  block_limit_down: false,
  block_suspended: false,
  data_policy_json: {
    point_in_time: false,
    disclosure_date_required: false,
    universe_as_of_required: false,
  },
  constraint_policy_json: {
    enable_t_plus_one: false,
    block_limit_up: false,
    block_limit_down: false,
    block_suspended: false,
  },
} as any);

assert('normalizer forces next_open execution', trustedBacktest.execution_timing === 'next_open');
assert('normalizer preserves explicit T+1 override', trustedBacktest.enable_t_plus_one === false);
assert('normalizer preserves explicit limit-up override', trustedBacktest.block_limit_up === false);
assert('normalizer preserves explicit limit-down override', trustedBacktest.block_limit_down === false);
assert('normalizer preserves explicit suspended override', trustedBacktest.block_suspended === false);
assert(
  'data policy forces point_in_time on',
  trustedBacktest.data_policy_json.point_in_time === true
);
assert(
  'data policy records hard backend enforcement',
  trustedBacktest.data_policy_json.enforcement?.mode === 'hard'
);
assert(
  'data policy declares factor as-of coverage',
  trustedBacktest.data_policy_json.audit_coverage?.factor_snapshot_as_of === true
);
assert(
  'constraint policy preserves explicit T+1 override',
  trustedBacktest.constraint_policy_json.enable_t_plus_one === false
);
assert(
  'constraint policy preserves explicit limit overrides',
  trustedBacktest.constraint_policy_json.block_limit_up === false &&
    trustedBacktest.constraint_policy_json.block_limit_down === false
);

const factorWhere = buildPointInTimeFactorWhere(['sh.600000'], '2025-06-30');
const symbolOps = Object.getOwnPropertySymbols((factorWhere as any).symbol || {});
const dateOps = Object.getOwnPropertySymbols((factorWhere as any).factor_date || {});
assert(
  'factor where filters symbols',
  symbolOps.some(op => Array.isArray((factorWhere as any).symbol[op]))
);
assert(
  'factor where filters factor_date by as-of',
  dateOps.some(op => (factorWhere as any).factor_date[op] === '2025-06-30')
);

const executionGate = researchTrustPolicyService.evaluateExecutionGate({
  side: 'BUY',
  symbol: 'sh.600000',
  profile: {
    is_limit_up: true,
    is_limit_down: false,
    is_suspended: false,
    is_st: false,
    latest_change_percent: 10,
    latest_price: 12.34,
  },
  quote: { price: 12.34, source: 'daily_bar' },
  policy: { block_limit_up: false },
});
assert('execution gate respects explicit limit-up override', executionGate.allowed === true);
assert(
  'execution gate reports allow label when override is explicit',
  executionGate.label.includes('可模拟成交')
);

const replayArtifact = researchTrustPolicyService.buildAuditedReturnReplayArtifact({
  best_result: {
    total_return_pct: 48,
    annual_return_pct: 48,
    max_drawdown_pct: 9,
    trade_count: 64,
  },
  point_in_time_artifact: {
    status: 'reject',
    payload_json: {
      issue_slots: [
        { status: 'reject', future_count: 37, key: 'disclosure_date', summary: '37 笔未来披露' },
      ],
    },
  },
  execution_artifact: {
    status: 'watch',
    payload_json: {
      rejected_order_count: 25,
      reason_counts: {
        limit_up_block_buy: 12,
        limit_down_block_sell: 8,
        t_plus_one_block: 5,
      },
    },
  },
});
assert(
  'audited return artifact has dedicated type',
  replayArtifact.artifact_type === 'audited_return_replay'
);
assert(
  'audited return replay lowers audited return for PIT rejects',
  Number(replayArtifact.payload_json?.audited_return_pct) < 48
);
assert(
  'audited return replay lowers executable return after execution blocks',
  Number(replayArtifact.payload_json?.executable_return_pct) <
    Number(replayArtifact.payload_json?.audited_return_pct)
);
assert(
  'audited return replay keeps reason counts',
  replayArtifact.payload_json?.execution_reason_counts?.limit_up_block_buy === 12
);

const rerunOptions = researchTrustPolicyService.buildTrustedRerunOptions({
  source_task_id: 93,
  experiment_id: 7,
  task_name: '原始回测',
  universe: 'favorites',
  strategy_keys: ['multi_factor_alpha'],
  symbols: ['sh.600000'],
  start_date: '2025-01-01',
  end_date: '2025-12-31',
  initial_capital: 200000,
  commission_rate: 0.0003,
  slippage_rate: 0.0005,
  parameters: {
    execution_timing: 'same_close',
    enable_t_plus_one: false,
    block_limit_up: false,
    data_policy_json: { point_in_time: false },
  },
});
assert('trusted rerun marks source task', rerunOptions.trusted_rerun_of_task_id === 93);
assert(
  'trusted rerun is identifiable',
  researchTrustPolicyService.isTrustedRerunTask(rerunOptions)
);
assert('trusted rerun disables recursive rerun', rerunOptions.auto_trusted_rerun === false);
assert(
  'trusted rerun keeps strategy keys',
  rerunOptions.strategy_keys?.[0] === 'multi_factor_alpha'
);
assert('trusted rerun forces PIT policy', rerunOptions.data_policy_json?.point_in_time === true);
assert('trusted rerun preserves explicit execution override', rerunOptions.enable_t_plus_one === false);

console.log('\n## Research trust wiring meta-guards');

const quantDataSrc = readSrc('quant/engine/internal/QuantDataService.ts');
assert(
  'QuantDataService computes factorAsOfDate',
  /const\s+factorAsOfDate\s*=\s*options\.as_of_date\s*\|\|\s*options\.start_date/.test(quantDataSrc)
);
assert(
  'QuantDataService filters factor_date with buildPointInTimeFactorWhere',
  (quantDataSrc.match(/buildPointInTimeFactorWhere\s*\(/g) || []).length >= 3
);

const backtestSrc = readSrc('quant/backtest/internal/QuantBacktestService.ts');
assert(
  'QuantBacktestService imports researchTrustPolicyService',
  backtestSrc.includes('services/research/ResearchTrustPolicyService')
);
assert(
  'QuantBacktestService normalizes options through trust policy first',
  /researchTrustPolicyService\.normalizeBacktestOptions\s*\(\s*options\s*\)/.test(backtestSrc)
);

const researchExperimentSrc = readSrc('services/research/ResearchExperimentService.ts');
assert(
  'ResearchExperimentService stores audited return replay artifact',
  researchExperimentSrc.includes('buildAuditedReturnReplayArtifact') &&
    researchExperimentSrc.includes('auditedReturnArtifact') &&
    /replaceArtifact\s*\(\s*lockedExperiment\.id,\s*task\.id,\s*draft/.test(
      researchExperimentSrc
    )
);
assert(
  'ResearchExperimentService enqueues trusted rerun after audit',
  researchExperimentSrc.includes('ensureTrustedRerunTask') &&
    researchExperimentSrc.includes('quantBacktestQueue.add') &&
    researchExperimentSrc.includes('trusted_rerun_of_task_id')
);
assert(
  'ResearchExperimentService avoids recursive trusted reruns',
  researchExperimentSrc.includes('isTrustedRerunTask(rawOptionsFromTask(task))')
);
assert(
  'ResearchExperimentService syncs trusted rerun result back to original task artifact',
  researchExperimentSrc.includes('syncTrustedRerunBackToOriginal') &&
    researchExperimentSrc.includes('trusted_backtest_task_actual') &&
    researchExperimentSrc.includes('source_task_id') &&
    researchExperimentSrc.includes('refreshCredibilitySummary')
);
assert(
  'ResearchExperimentService checks task and experiment ownership for audit reads',
  researchExperimentSrc.includes('sameOwner(task.user_id, user_id)') &&
    researchExperimentSrc.includes('sameOwner(experiment.user_id, user_id)')
);

assert(
  'QuantBacktestService merges queue job id without overwriting worker parameters',
  backtestSrc.includes('COALESCE("parameters",') && backtestSrc.includes('queue_job_id')
);

const paperSrc = readSrc('portfolio/internal/PaperTradingAutomationService.ts');
assert(
  'PaperTradingAutomationService evaluates shared research execution gate',
  paperSrc.includes('evaluateExecutionGate') && paperSrc.includes('researchTrustPolicyService')
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
