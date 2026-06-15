/**
 * activation-summary-aggregator.test.ts — Sprint 27 endpoint 聚合函数测试
 *
 * 覆盖 PaperTradingController 内的 4 个 export helper:
 *   - buildEmptyActivationSummary: 0 信号场景
 *   - buildLayerMarks: 8 层 ✓/★/✗/— 映射
 *   - buildLayerDetails: detail 字段截断 + null 处理
 *   - aggregateActivationSummary: 完整聚合 (outcomes / layer_stats / top_block_reasons /
 *     recent_trades) 用纯 mock intent 数组, 无 DB.
 */

import {
  buildEmptyActivationSummary,
  buildLayerMarks,
  buildLayerDetails,
  aggregateActivationSummary,
  ACTIVATION_LAYERS,
} from '../../src/api/controllers/PaperTradingController';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function testEmpty() {
  console.log('\n## buildEmptyActivationSummary');
  const s = buildEmptyActivationSummary(7);
  assert('window_days = 7', s.window_days === 7);
  assert('total_signals = 0', s.total_signals === 0);
  assert('outcomes 全 0', s.outcomes.executed + s.outcomes.skipped + s.outcomes.rejected + s.outcomes.other === 0);
  assert('layer_stats.length = 8', s.layer_stats.length === 8);
  assert('layer_stats 全 0', s.layer_stats.every(l => l.reached === 0 && l.blocked === 0 && l.contributed === 0));
  assert('top_block_reasons 空', s.top_block_reasons.length === 0);
  assert('recent_trades 空', s.recent_trades.length === 0);
}

function testBuildLayerMarks() {
  console.log('\n## buildLayerMarks');
  const act = {
    L1_data: { reached: true, blocked: false, contributed: false },
    L2_signal: { reached: true, blocked: false, contributed: false },
    L3_meta: { reached: true, blocked: false, contributed: true },  // ★
    L5_feasibility: { reached: true, blocked: true, contributed: false },  // ✗
    // L4/L6/L7/L8 缺失 → —
  };
  const m = buildLayerMarks(act);
  assert('L1 = ✓', m.L1_data === '✓');
  assert('L2 = ✓', m.L2_signal === '✓');
  assert('L3 = ★ (contributed)', m.L3_meta === '★');
  assert('L4 = — (未参与)', m.L4_construction === '—');
  assert('L5 = ✗ (blocked)', m.L5_feasibility === '✗');
  assert('L6 = — (snap 缺)', m.L6_risk === '—');
  assert('L7 = —', m.L7_governor === '—');
  assert('L8 = —', m.L8_reflection === '—');

  // null activation → 全 —
  const allEmpty = buildLayerMarks(null);
  assert('null activation → 8 层全 —', ACTIVATION_LAYERS.every(l => allEmpty[l] === '—'));
}

function testBuildLayerDetails() {
  console.log('\n## buildLayerDetails');
  const act = {
    L3_meta: {
      reached: true,
      blocked: false,
      contributed: true,
      detail: {
        confidence: 0.78,
        model_version: 'v1-logistic',
        features_used: { breadth_score: 27.62, payoff: 1.0 },
      },
    },
    L5_feasibility: {
      reached: true,
      blocked: false,
      contributed: true,
      detail: {
        decision: 'fillable',
        snapshot_source: 'tencent',
        block_reasons: [],
      },
    },
    L7_governor: { reached: true, blocked: false, contributed: false }, // no detail
  };
  const d = buildLayerDetails(act);
  assert('L3 detail 完整', d.L3_meta?.confidence === 0.78);
  assert('L3 features_used 保留', d.L3_meta?.features_used?.breadth_score === 27.62);
  assert('L5 snapshot_source = tencent', d.L5_feasibility?.snapshot_source === 'tencent');
  assert('L7 无 detail → null', d.L7_governor === null);
  assert('L4 snap 缺 → null', d.L4_construction === null);

  // 字符串截断
  const longStr = 'a'.repeat(200);
  const longAct = {
    L3_meta: { reached: true, contributed: true, blocked: false, detail: { reason: longStr } },
  };
  const longD = buildLayerDetails(longAct);
  assert(
    'long string 截断 80 + ...',
    String(longD.L3_meta?.reason).length <= 83
  );

  // 数组截断 (>5)
  const arrAct = {
    L5_feasibility: {
      reached: true,
      contributed: true,
      blocked: false,
      detail: { block_reasons: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] },
    },
  };
  const arrD = buildLayerDetails(arrAct);
  assert(
    'array > 5 截断 + more',
    Array.isArray(arrD.L5_feasibility?.block_reasons) &&
      arrD.L5_feasibility?.block_reasons.length === 6 &&
      String(arrD.L5_feasibility?.block_reasons[5]).includes('more')
  );
}

function buildIntent(opts: {
  id: number;
  status: string;
  symbol?: string;
  reached_layer?: string;
  blocked_at?: string;
  final_outcome?: string;
  reason?: string;
  L3?: any;
  L5?: any;
}) {
  return {
    id: opts.id,
    symbol: opts.symbol || `sh.${opts.id}`,
    name: null,
    status: opts.status,
    intent_date: '2026-06-15',
    reason_text: opts.reason || null,
    created_at: new Date(),
    metadata: {
      l8_activation: {
        L1_data: { reached: true, blocked: false, contributed: false },
        L2_signal: { reached: true, blocked: false, contributed: false },
        L3_meta: opts.L3 || { reached: true, blocked: false, contributed: false },
        L4_construction: { reached: false, blocked: false, contributed: false },
        L5_feasibility: opts.L5 || { reached: false, blocked: false, contributed: false },
        L6_risk: { reached: false, blocked: false, contributed: false },
        L7_governor: { reached: false, blocked: false, contributed: false },
        L8_reflection: { reached: false, blocked: false, contributed: false },
        reached_layer: opts.reached_layer || 'L2_signal',
        blocked_at: opts.blocked_at,
        final_outcome: opts.final_outcome || 'skipped',
      },
    },
  };
}

function testAggregator() {
  console.log('\n## aggregateActivationSummary');

  // 10 笔: 3 executed, 4 skipped (L3 block), 3 rejected (L5 block)
  const intents: any[] = [];
  for (let i = 1; i <= 3; i += 1) {
    intents.push(
      buildIntent({
        id: i,
        status: 'executed',
        final_outcome: 'executed',
        reached_layer: 'L8_reflection',
        L3: { reached: true, blocked: false, contributed: true },
        L5: { reached: true, blocked: false, contributed: true },
      })
    );
  }
  for (let i = 4; i <= 7; i += 1) {
    intents.push(
      buildIntent({
        id: i,
        status: 'skipped',
        final_outcome: 'skipped',
        reached_layer: 'L3_meta',
        blocked_at: 'L3_meta',
        reason: 'MetaLabel 不下注',
        L3: { reached: true, blocked: true, contributed: false },
      })
    );
  }
  for (let i = 8; i <= 10; i += 1) {
    intents.push(
      buildIntent({
        id: i,
        status: 'rejected',
        final_outcome: 'rejected',
        reached_layer: 'L5_feasibility',
        blocked_at: 'L5_feasibility',
        reason: 'no_market_data',
        L3: { reached: true, blocked: false, contributed: true },
        L5: { reached: true, blocked: true, contributed: false },
      })
    );
  }

  const s = aggregateActivationSummary(intents, 7);
  assert('total_signals = 10', s.total_signals === 10);
  assert('outcomes.executed = 3', s.outcomes.executed === 3);
  assert('outcomes.skipped = 4', s.outcomes.skipped === 4);
  assert('outcomes.rejected = 3', s.outcomes.rejected === 3);

  // L1 全 reached
  const l1 = s.layer_stats.find(l => l.layer === 'L1_data')!;
  assert('L1 reached = 10', l1.reached === 10);
  assert('L1 blocked = 0', l1.blocked === 0);

  // L3 reached = 10 (4 skip + 3 exec + 3 reject 都到了 L3)
  const l3 = s.layer_stats.find(l => l.layer === 'L3_meta')!;
  assert('L3 reached = 10', l3.reached === 10);
  assert('L3 blocked = 4', l3.blocked === 4);
  assert('L3 contributed = 6 (3 exec + 3 reject)', l3.contributed === 6);

  // L5 reached = 6 (4 L3 block 没到 L5), blocked = 3
  const l5 = s.layer_stats.find(l => l.layer === 'L5_feasibility')!;
  assert('L5 reached = 6', l5.reached === 6);
  assert('L5 blocked = 3', l5.blocked === 3);

  // block_rate: L3 = 4/10 = 0.4, L5 = 3/6 = 0.5
  assert('L3 block_rate ≈ 0.4', Math.abs(l3.block_rate - 0.4) < 0.01);
  assert('L5 block_rate ≈ 0.5', Math.abs(l5.block_rate - 0.5) < 0.01);

  // L4 完全没 reached (mode off, 当前实测正态)
  const l4 = s.layer_stats.find(l => l.layer === 'L4_construction')!;
  assert('L4 reached = 0 (PC mode off)', l4.reached === 0);

  // top_block_reasons: L3 MetaLabel (4) > L5 no_market_data (3)
  assert('top_block_reasons[0].count = 4', s.top_block_reasons[0]?.count === 4);
  assert(
    'top_block_reasons[0].layer = L3_meta',
    s.top_block_reasons[0]?.layer === 'L3_meta'
  );
  assert('top_block_reasons[1].count = 3', s.top_block_reasons[1]?.count === 3);

  // recent_trades: ≤ 10
  assert('recent_trades = 10', s.recent_trades.length === 10);
  // layer_marks 检查 — first trade (id=1, executed)
  const firstTrade = s.recent_trades[0];
  assert('first trade outcome = executed', firstTrade.outcome === 'executed');
  assert('first trade L3 = ★', firstTrade.layer_marks?.L3_meta === '★');
  assert('first trade L8 = — (没 detail)', firstTrade.layer_marks?.L8_reflection === '—');
}

function testAggregatorEmpty() {
  console.log('\n## aggregateActivationSummary 空数组');
  const s = aggregateActivationSummary([], 7);
  assert('total_signals = 0', s.total_signals === 0);
  assert('layer_stats.length = 8', s.layer_stats.length === 8);
  assert(
    'layer_stats 全 0',
    s.layer_stats.every(l => l.reached === 0)
  );
}

function testAggregatorMissingActivation() {
  console.log('\n## aggregateActivationSummary missing l8_activation');
  // 旧代码生成的 intent 没 l8_activation 字段
  const intents: any[] = [
    {
      id: 1,
      symbol: 'sh.600000',
      status: 'skipped',
      intent_date: '2026-06-15',
      reason_text: null,
      created_at: new Date(),
      metadata: { foo: 'bar' },  // 无 l8_activation
    },
  ];
  const s = aggregateActivationSummary(intents, 7);
  assert('total_signals = 1', s.total_signals === 1);
  // 没 activation 时 outcome 走 fallback intent.status='skipped'
  assert('outcomes.skipped = 1 (fallback to status)', s.outcomes.skipped === 1);
  // layer_stats 全 0 (因为没 activation)
  assert(
    'layer_stats 全 0',
    s.layer_stats.every(l => l.reached === 0)
  );
}

function main() {
  testEmpty();
  testBuildLayerMarks();
  testBuildLayerDetails();
  testAggregator();
  testAggregatorEmpty();
  testAggregatorMissingActivation();
  console.log(`\n========================================`);
  console.log(`activation-summary-aggregator tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
