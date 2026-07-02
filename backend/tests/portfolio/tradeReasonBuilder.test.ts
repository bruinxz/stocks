/**
 * tradeReasonBuilder 单元测试 (AL-3, 2026-06-21)
 *
 *   cd backend && npx ts-node --transpile-only tests/portfolio/tradeReasonBuilder.test.ts
 *
 * 覆盖:
 *   [1] buildTradeReasonFromSignal
 *       - 完整 signal (strategy_key + score + factors + market_environment + reasons)
 *       - signal 缺 factors / market_environment fallback
 *       - aiReport 注入 confidence / key_points
 *       - analysis_engine source_type → source='analysis_engine_hard'
 *       - 全空 signal (only id) 仍返回 source + 1 条 evidence + 空 key_reasons
 *   [2] buildTradeReasonFromRiskGuard
 *       - 各 guard 名 → source 映射 (trailing_stop / drawdown_breaker / per_stock_stop_loss /
 *         industry_concentration / black_swan / unknown)
 *       - threshold/actual 注入 → risk_trigger 字段
 *       - position 注入 → 持仓盈亏 evidence
 *   [3] buildTradeReasonForManualOrder
 *       - 默认 manual
 *       - source=close_position
 *       - 带 reason notes
 *   [4] summarizeTradeReason
 *       - BUY 来源 → "买入: ..."
 *       - SELL 风控来源 → "卖出: 动态止损 | ..."
 *       - 截断 ≤ 200 字符
 *       - 空 reason → ''
 *
 * 不依赖 jest, IIFE + process.exit 模板.
 */

import {
  buildTradeReasonFromSignal,
  buildTradeReasonFromRiskGuard,
  buildTradeReasonForManualOrder,
  summarizeTradeReason,
  packReason,
  emptyTradeReason,
} from '../../src/portfolio/internal/tradeReasonBuilder';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// =====================================================
// [1] buildTradeReasonFromSignal
// =====================================================
function test_signal_full() {
  const r = buildTradeReasonFromSignal(
    {
      id: 4242,
      strategy_key: 'etf_factor_rotation',
      confidence_score: 78,
      factors: { PE_TTM: 12.3, north_flow_5d: 230_000_000, MA20: '突破' },
      reasons: ['PE 12.3 低估', '北向 +2.3 亿', 'MA20 上穿 MA60'],
      market_environment: {
        market_regime: 'up',
        breadth: { up_20d_ratio: 0.62 },
        volatility_pct: 0.018,
      },
      source_type: 'daily_screener',
    } as any,
    null
  );

  assert('signal_full.source', r.source === 'auto_buy_from_signals', `got ${r.source}`);
  assert('signal_full.strategy_key', r.strategy_key === 'etf_factor_rotation');
  assert('signal_full.signal_id', r.signal_id === 4242);
  assert('signal_full.confidence', r.confidence === 78);
  assert('signal_full.key_reasons_count', r.key_reasons.length === 3);
  assert(
    'signal_full.evidence_has_strategy',
    r.evidence.some(e => /etf_factor_rotation/.test(e.label))
  );
  assert(
    'signal_full.evidence_has_factors',
    r.evidence.some(e => /PE_TTM|north_flow|MA20/.test(e.label))
  );
  assert(
    'signal_full.evidence_has_env',
    r.evidence.some(e => e.label === '市场环境')
  );
}

function test_signal_minimal() {
  const r = buildTradeReasonFromSignal({ id: 1 } as any);
  assert('signal_min.source', r.source === 'auto_buy_from_signals');
  assert('signal_min.signal_id', r.signal_id === 1);
  assert('signal_min.evidence_at_least_one', r.evidence.length >= 1);
  assert('signal_min.key_reasons_empty', r.key_reasons.length === 0);
}

function test_signal_with_ai_report() {
  const r = buildTradeReasonFromSignal(
    { id: 2, strategy_key: 'foo' } as any,
    {
      id: 'rep-1',
      confidence_score: 91,
      key_points: ['点1', '点2', '点3', '点4'],
      recommendation: '强烈买入',
    }
  );
  assert('signal_ai.confidence_pref_ai', r.confidence === 91);
  assert('signal_ai.ai_report_id', r.ai_report_id === 'rep-1');
  assert('signal_ai.ai_summary', r.ai_summary === '强烈买入');
  assert(
    'signal_ai.evidence_includes_ai_points',
    r.evidence.filter(e => e.label === 'AI 要点').length >= 1
  );
}

function test_signal_analysis_engine_source() {
  const r = buildTradeReasonFromSignal({
    id: 7,
    source_type: 'analysis_engine',
    strategy_key: 'MultiDim',
  } as any);
  assert('signal_ae.source_hard', r.source === 'analysis_engine_hard');
}

function test_signal_null() {
  const r = buildTradeReasonFromSignal(null);
  assert('signal_null.source', r.source === 'auto_buy_from_signals');
  assert('signal_null.evidence', r.evidence.length >= 1);
}

function test_signal_rationale_fallback() {
  const r = buildTradeReasonFromSignal({
    id: 9,
    rationale: '理由1; 理由2; 理由3',
    strategy_key: 'X',
  } as any);
  assert('signal_rationale.key_reasons', r.key_reasons.length === 3);
}

// =====================================================
// [2] buildTradeReasonFromRiskGuard
// =====================================================
function test_risk_guard_trailing_stop() {
  const r = buildTradeReasonFromRiskGuard('trailing_stop', {
    threshold: 7,
    actual: 8.2,
    indicator: 'drawdown_pct',
    position: { symbol: '600519', quantity: 100, avg_cost: 1700, current_price: 1561 },
  });
  assert('rg_trailing.source', r.source === 'trailing_stop');
  assert('rg_trailing.risk_trigger', r.risk_trigger?.type === 'trailing_stop');
  assert('rg_trailing.actual', r.risk_trigger?.actual === 8.2);
  assert('rg_trailing.threshold', r.risk_trigger?.threshold === 7);
  assert(
    'rg_trailing.pnl_evidence',
    r.evidence.some(e => e.label === '持仓盈亏')
  );
  assert('rg_trailing.key_reasons', r.key_reasons.length >= 2);
}

function test_risk_guard_mapping() {
  const cases: Array<[string, string]> = [
    ['drawdown_breaker', 'drawdown_breaker'],
    ['drawdown_level_3', 'drawdown_breaker'],
    ['per_stock_stop_loss', 'per_stock_stop_loss'],
    ['per_stock_mass', 'per_stock_stop_loss'],
    ['industry_concentration', 'industry_concentration'],
    ['black_swan', 'black_swan'],
    ['rebalance', 'rebalance'],
    ['close_position', 'close_position'],
    ['some_unknown_kind', 'unknown'],
    ['trailing_take_profit', 'trailing_take_profit'],
    ['technical_breakdown', 'technical_breakdown'],
    ['sell_signal', 'sell_signal'],
  ];
  for (const [input, expected] of cases) {
    const r = buildTradeReasonFromRiskGuard(input);
    assert(`rg_map.${input}_to_${expected}`, r.source === expected, `got ${r.source}`);
  }
}

function test_risk_guard_actual_only() {
  const r = buildTradeReasonFromRiskGuard('drawdown_breaker', { actual: 12.5, indicator: 'pct' });
  assert(
    'rg_actual_only.has_trigger_evidence',
    r.evidence.some(e => e.label === '触发值')
  );
  assert('rg_actual_only.no_threshold', r.risk_trigger?.threshold === undefined);
}

function test_risk_guard_detail_passthrough() {
  const r = buildTradeReasonFromRiskGuard('black_swan', {
    detail: { event_id: 'BS-2026-01', severity: 'high', news_count: 12 },
  });
  assert(
    'rg_detail.has_event_id',
    r.evidence.some(e => e.label === 'event_id')
  );
  assert(
    'rg_detail.has_severity',
    r.evidence.some(e => e.label === 'severity')
  );
}

// =====================================================
// [3] buildTradeReasonForManualOrder
// =====================================================
function test_manual_default() {
  const r = buildTradeReasonForManualOrder();
  assert('manual_default.source', r.source === 'manual');
  assert('manual_default.evidence', r.evidence.length === 1);
  assert('manual_default.has_key', r.key_reasons.length >= 1);
}

function test_manual_with_notes() {
  const r = buildTradeReasonForManualOrder({ reason: '看好低估反弹' });
  assert(
    'manual_notes.evidence_detail',
    r.evidence[0].detail === '看好低估反弹'
  );
  assert('manual_notes.key', r.key_reasons[0] === '看好低估反弹');
}

function test_manual_close_position() {
  const r = buildTradeReasonForManualOrder({ source: 'close_position' });
  assert('manual_cp.source', r.source === 'close_position');
  assert(
    'manual_cp.label',
    r.evidence[0].label === '用户显式平仓'
  );
}

// =====================================================
// [4] summarizeTradeReason
// =====================================================
function test_summary_buy() {
  const r = buildTradeReasonFromSignal({
    id: 1,
    strategy_key: 'X',
    confidence_score: 80,
    reasons: ['r1', 'r2'],
  } as any);
  const s = summarizeTradeReason(r);
  assert('sum_buy.starts_with_买入', /^买入: /.test(s), `got ${s}`);
  assert('sum_buy.has_strategy', s.includes('策略 X'));
  assert('sum_buy.has_confidence', s.includes('置信 80'));
  assert('sum_buy.has_reasons', s.includes('r1') && s.includes('r2'));
}

function test_summary_sell_trailing() {
  const r = buildTradeReasonFromRiskGuard('trailing_stop', {
    threshold: 7,
    actual: 8.2,
    indicator: 'drawdown_pct',
  });
  const s = summarizeTradeReason(r);
  assert('sum_sell.starts_卖出', /^卖出: 动态止损/.test(s), `got ${s}`);
  assert('sum_sell.has_threshold', s.includes('阈 7'));
}

function test_summary_truncate() {
  const long = 'x'.repeat(500);
  const r = buildTradeReasonFromRiskGuard('trailing_stop', {});
  r.key_reasons = [long];
  const s = summarizeTradeReason(r);
  assert('sum_trunc.length', s.length <= 200);
  assert('sum_trunc.ends_ellipsis', s.endsWith('…'));
}

function test_summary_empty() {
  assert('sum_empty', summarizeTradeReason(null) === '');
  assert('sum_undef', summarizeTradeReason(undefined) === '');
}

function test_packReason() {
  const r = buildTradeReasonForManualOrder({ reason: 'foo' });
  const p = packReason(r);
  assert('pack.has_reason', p.trade_reason === r);
  assert('pack.has_summary', typeof p.trade_reason_summary === 'string' && p.trade_reason_summary.length > 0);
}

function test_emptyTradeReason() {
  const r = emptyTradeReason();
  assert('empty.source', r.source === 'unknown');
  assert('empty.evidence', r.evidence.length === 1);
  const r2 = emptyTradeReason('manual');
  assert('empty.source_override', r2.source === 'manual');
}

// =====================================================
// runner
// =====================================================
(function main() {
  console.log('## [1] buildTradeReasonFromSignal');
  test_signal_full();
  test_signal_minimal();
  test_signal_with_ai_report();
  test_signal_analysis_engine_source();
  test_signal_null();
  test_signal_rationale_fallback();

  console.log('## [2] buildTradeReasonFromRiskGuard');
  test_risk_guard_trailing_stop();
  test_risk_guard_mapping();
  test_risk_guard_actual_only();
  test_risk_guard_detail_passthrough();

  console.log('## [3] buildTradeReasonForManualOrder');
  test_manual_default();
  test_manual_with_notes();
  test_manual_close_position();

  console.log('## [4] summarizeTradeReason + helpers');
  test_summary_buy();
  test_summary_sell_trailing();
  test_summary_truncate();
  test_summary_empty();
  test_packReason();
  test_emptyTradeReason();

  console.log(`\n# summary: ${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
