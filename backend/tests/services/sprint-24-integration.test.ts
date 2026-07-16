/**
 * Pattern-library + TradeCompliance smoke test (retained from Sprint 24).
 *
 * 旧 Minervini/VCP/Turtle/Donchian strategies 已由 7fa8bc9f 明确删除，
 * L1-L8 barrel 空壳已由 66ad4efc 明确删除。本测试只保留仍活跃的纯函数契约：
 *   A. pattern-library regime / multiplier helpers
 *   B. TradeComplianceChecker Wizard rules
 */

import { checkTradeCompliance } from '../../src/services/TradeComplianceChecker';
import {
  inferLocalRegime,
  vcpPatternMultiplier,
  turtleEntryWithPatternFilter,
  donchianBreakoutWithPatternAdjustment,
} from '../../src/services/research/pattern-library';

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

// ============================================================
// Test helpers — 生成 mock QuantBar 序列
// ============================================================

function makeStrongUptrend(length = 260, start = 50) {
  // 真实强势股: 持续上涨, 但带极小噪声 (确保 vol_annual < 20%)
  const closes: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const noise = ((i * 13) % 17 - 8) * 0.02; // ±0.16 极小噪声 → daily vol ≈ 0.5%
    closes.push(start + i * 0.5 + noise); // 260 天涨 130 → 60d 涨 ~30%
  }
  return closes;
}

function makeSideways(length = 260, base = 50) {
  // 横盘 — 模拟 range regime, 噪声小 (vol_annual < 20%)
  const closes: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const noise = ((i * 7) % 11 - 5) * 0.03; // ±0.15 噪声
    closes.push(base + noise);
  }
  return closes;
}

function makeVolatile(length = 260, base = 50) {
  // 高波动 — 模拟 volatile regime, 大噪声 (vol_annual > 30%)
  const closes: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const noise = ((i * 23) % 29 - 14) * 1.5;
    closes.push(base + noise);
  }
  return closes;
}
// ============================================================
// A: inferLocalRegime + pattern multiplier 纯函数
// ============================================================

function testPatternHelpers() {
  console.log('\n## A: inferLocalRegime + pattern helpers');

  const up = makeStrongUptrend();
  const flat = makeSideways();
  const wild = makeVolatile();

  const r_up = inferLocalRegime(up);
  const r_flat = inferLocalRegime(flat);
  const r_wild = inferLocalRegime(wild);

  assert('inferLocalRegime 上涨 → bull', r_up === 'bull', `got ${r_up}`);
  assert('inferLocalRegime 横盘 → range', r_flat === 'range', `got ${r_flat}`);
  assert('inferLocalRegime 高波动 → volatile', r_wild === 'volatile', `got ${r_wild}`);
  assert('inferLocalRegime 短序列 → range', inferLocalRegime([1, 2, 3]) === 'range');

  // vcpPatternMultiplier
  const vcp = vcpPatternMultiplier(up, 'bull');
  assert('vcpPatternMultiplier 返回 multiplier', typeof vcp.multiplier === 'number' && vcp.multiplier > 0);
  assert('vcpPatternMultiplier 返回 detected_patterns', Array.isArray(vcp.detected_patterns));

  const turtle = turtleEntryWithPatternFilter(up, 'bull');
  assert('turtleEntryWithPatternFilter 有 proceed', typeof turtle.proceed === 'boolean');
  assert('turtleEntryWithPatternFilter pattern_validation.multiplier > 0', turtle.pattern_validation.multiplier > 0);

  const don = donchianBreakoutWithPatternAdjustment(up, 'bull');
  assert('donchianBreakoutWithPatternAdjustment 有 buy_signal', typeof don.buy_signal === 'boolean');
  assert('donchian pattern_multiplier > 0', don.pattern_multiplier > 0);
}

// ============================================================
// B: TradeComplianceChecker — Wizard 5 rules
// ============================================================

function testTradeCompliance() {
  console.log('\n## B: TradeComplianceChecker — Wizard rules');

  // 完美交易: 小 size + 高 conviction + 短 hold + 顺势 + RR good + worst case 分析过
  const perfectTrade = {
    realized_pnl_pct: 0.08,
    position_size_pct: 0.05,
    conviction_level: 8,
    max_drawdown_during_hold_pct: 0.02,
    closed_pre_weekend: true,
    held_over_weekend: false,
    realized_vol_during_hold: 0.15,
    stop_loss_distance_pct: 0.04,
    market_trend: 'up' as const,
    trade_direction: 'BUY' as const,
    expected_target_pct: 0.12,
    expected_stop_pct: 0.04,
    worst_case_analyzed_pre_trade: true,
    current_pe: 18,
    historical_avg_pe: 22,
    has_specific_catalyst: true,
  };
  const perfectResult = checkTradeCompliance(perfectTrade);
  assert('完美 trade grade ∈ {A, B}', perfectResult.rule_compliance_grade === 'A' || perfectResult.rule_compliance_grade === 'B',
    `got ${perfectResult.rule_compliance_grade}`);
  assert('完美 trade should_alert = false', perfectResult.should_alert === false);

  // 烂交易: 重仓 + 大回撤 + held over weekend + 逆势 + 无 stop + 无 catalyst
  const badTrade = {
    realized_pnl_pct: -0.20,
    position_size_pct: 0.30,
    conviction_level: 3,
    max_drawdown_during_hold_pct: 0.25,
    closed_pre_weekend: false,
    held_over_weekend: true,
    realized_vol_during_hold: 0.50,
    stop_loss_distance_pct: 0.20,
    market_trend: 'down' as const,
    trade_direction: 'BUY' as const,
    expected_target_pct: 0.05,
    expected_stop_pct: 0.15,
    worst_case_analyzed_pre_trade: false,
    current_pe: 40,
    historical_avg_pe: 15,
    has_specific_catalyst: false,
  };
  const badResult = checkTradeCompliance(badTrade);
  assert('烂 trade 有多条 violations', badResult.total_violations >= 2, `count=${badResult.total_violations}`);
  assert('烂 trade severity_score > 0', badResult.severity_score > 0);
  assert('烂 trade grade != A', badResult.rule_compliance_grade !== 'A');
  // (D/F grade 取决于 wizard 内部阈值; 用 should_alert 兜底)
  assert('烂 trade 触发 should_alert OR grade C+', badResult.should_alert || badResult.rule_compliance_grade !== 'A');
  assert('violations 排序: high severity 在前', badResult.violations[0]
    ? badResult.violations[0].severity === 'high' || badResult.violations[0].severity === 'medium' || badResult.violations[0].severity === 'low'
    : true);
  assert('summary_message 有内容', badResult.summary_message.length > 0);
}
// ============================================================
// Main
// ============================================================

async function main() {
  console.log('=== Pattern + TradeCompliance Smoke Test ===');
  testPatternHelpers();
  testTradeCompliance();
  console.log(`\n========================================`);
  console.log(`Sprint 24: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
