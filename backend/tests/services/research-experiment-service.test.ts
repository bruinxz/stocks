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

const modeledExecution = buildExecutionArtifactFromRejectedOrders(
  [
    { reason: 'max_positions', detail: '已持仓 6 ≥ 上限 6' },
    { reason: 'max_positions', detail: '已持仓 6 ≥ 上限 6' },
    { reason: 'limit_up_block_buy', detail: '涨停买入不可成交' },
    { reason: 'lot_or_cash_too_small', detail: '目标金额不足以买入 1 手' },
  ],
  {
    buy_fill_count: 12,
    sell_fill_count: 8,
  }
);
assert('modeled rejects with fills become watch', modeledExecution.status === 'watch');
assert(
  'execution summary groups repeated reasons',
  modeledExecution.summary.includes('仓位上限 2 笔') &&
    !modeledExecution.summary.includes('已持仓 6 ≥ 上限 6；已持仓 6 ≥ 上限 6')
);

const modeledVerdict = buildCredibilitySummary({
  backtest_artifact: { status: 'pass', summary: '真实成交后收益为正。' },
  integrity_artifact: { status: 'pass', summary: '没有发现未来函数。' },
  execution_artifact: modeledExecution,
});
assert('modeled execution watch allows observation', modeledVerdict.can_create_observation);

const easyVerdict = buildCredibilitySummary({
  backtest_artifact: { status: 'pass', summary: '冠军策略收益为正。' },
  integrity_artifact: { status: 'pass', summary: '没有发现未来函数。' },
  execution_artifact: { status: 'reject', summary: '1 笔涨停买入不可成交。' },
});
assert('easy status blocks when execution rejects', easyVerdict.verdict === 'reject');
assert(
  'easy label tells user to adjust',
  easyVerdict.next_action_label.includes('修正') ||
    easyVerdict.next_action_label.includes('查数据')
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
