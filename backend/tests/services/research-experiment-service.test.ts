/**
 * ResearchExperimentService tests — phase 1 research credibility ledger.
 */
import {
  buildCredibilitySummary,
  buildExecutionArtifactFromRejectedOrders,
  mapResearchIntegrityArtifact,
} from '../../src/services/research/ResearchExperimentService';

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

console.log('\n## ResearchExperimentService credibility helpers');

const passSummary = buildCredibilitySummary({
  backtest_artifact: { status: 'pass', summary: '回测完成。' },
  integrity_artifact: { status: 'pass', summary: '没有发现未来函数。' },
  execution_artifact: { status: 'pass', summary: 'A 股约束未阻断。' },
});
assert('all pass allows observation', passSummary.can_create_observation === true);
assert('all pass verdict=pass', passSummary.verdict === 'pass');

const watchSummary = buildCredibilitySummary({
  backtest_artifact: { status: 'pass', summary: '收益为正。' },
  integrity_artifact: { status: 'watch', summary: '存在轻微样本外衰减。' },
  execution_artifact: { status: 'pass', summary: '无硬阻断。' },
});
assert('watch allows observation with caution', watchSummary.can_create_observation === true);
assert('watch has watch reason', watchSummary.watch_reasons.length === 1);

const rejectSummary = buildCredibilitySummary({
  backtest_artifact: { status: 'pass', summary: '收益很好。' },
  integrity_artifact: { status: 'reject', summary: '使用了尚未披露的数据。' },
  execution_artifact: { status: 'pass', summary: '无硬阻断。' },
});
assert('reject blocks observation', rejectSummary.can_create_observation === false);
assert('reject has blocking reason', rejectSummary.blocking_reasons[0].includes('尚未披露'));

const insufficientSummary = buildCredibilitySummary({
  backtest_artifact: { status: 'pass', summary: '回测完成。' },
  integrity_artifact: { status: 'insufficient', summary: '缺少披露日数据。' },
  execution_artifact: { status: 'pass', summary: '无硬阻断。' },
});
assert('insufficient blocks observation', insufficientSummary.verdict === 'insufficient');
assert(
  'insufficient next action checks data',
  insufficientSummary.next_action_label.includes('查数据')
);

const integrity = mapResearchIntegrityArtifact({
  verdict: 'FAIL',
  summary_message: '检测到未来函数。',
  lookahead_issues: [{ pattern: 'Date.now()', severity: 'high' }],
  survivorship_issues: [],
  persisted_id: 9,
});
assert('FAIL maps to reject', integrity.status === 'reject');
assert('integrity artifact keeps source id', integrity.source_id === 9);

const execution = buildExecutionArtifactFromRejectedOrders([
  { reason: 'limit_up_blocked_buy', detail: '涨停买入不可成交' },
  { reason: 't_plus_1_violation', detail: 'T+1 不允许当日卖出' },
]);
assert('rejected orders map to reject', execution.status === 'reject');
assert('execution summary explains count', execution.summary.includes('2'));

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
