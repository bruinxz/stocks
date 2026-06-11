/**
 * TradeRootCauseClassifier 单元测试 (Phase 5)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/trade-root-cause-classifier.test.ts
 *
 * 覆盖维度:
 *   - 每个 root_cause 至少一个 happy + 一个 boundary
 *   - 优先级链顺序 (高 confidence 先匹配)
 *   - 边界 (NaN return / 缺失字段)
 *   - confidence 值正确性
 */

import {
  classifyTradeRootCause,
  TradeRootCause,
  ROOT_CAUSE_LABELS,
  TradeRootCauseInput,
} from '../../src/services/TradeRootCauseClassifier';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectRootCause(name: string, input: TradeRootCauseInput, expected: TradeRootCause) {
  const result = classifyTradeRootCause(input);
  assert(name, result.root_cause === expected, `expected=${expected}, got=${result.root_cause} (rule=${result.matched_rule})`);
}

function expectConfidence(name: string, input: TradeRootCauseInput, minConf: number) {
  const result = classifyTradeRootCause(input);
  assert(name, result.confidence >= minConf, `expected confidence >= ${minConf}, got=${result.confidence}`);
}

// ============================================================
// risk_kill_switch (最高优先级)
// ============================================================

function testKillSwitch() {
  console.log('\n## risk_kill_switch');

  expectRootCause('exit_reason=kill_switch', {
    return_pct: -5,
    holding_days: 3,
    exit_reason: 'kill_switch',
  }, 'risk_kill_switch');

  expectRootCause('exit_reason 含 circuit_breaker', {
    return_pct: -2,
    holding_days: 1,
    exit_reason: 'drawdown_circuit_breaker_level2',
  }, 'risk_kill_switch');

  expectRootCause('exit_reason 含 forced_close', {
    return_pct: 0,
    holding_days: 0,
    exit_reason: 'FORCED_CLOSE',  // 大小写不敏感
  }, 'risk_kill_switch');

  expectConfidence('kill_switch confidence 1.0', {
    return_pct: -5,
    holding_days: 3,
    exit_reason: 'kill_switch',
  }, 1.0);
}

// ============================================================
// data_quality (次最高)
// ============================================================

function testDataQuality() {
  console.log('\n## data_quality');

  expectRootCause('entry_price=0 → data_quality', {
    return_pct: -1,
    holding_days: 1,
    entry_price: 0,
    exit_price: 10,
  }, 'data_quality');

  expectRootCause('entry_price=NaN → data_quality', {
    return_pct: -1,
    holding_days: 1,
    entry_price: NaN,
  }, 'data_quality');

  expectRootCause('exit_reason 含 nan', {
    return_pct: 0,
    holding_days: 1,
    exit_reason: 'nan_value_in_quote',
  }, 'data_quality');

  expectRootCause('exit_reason 含 suspended', {
    return_pct: -3,
    holding_days: 2,
    exit_reason: 'stock_suspended',
  }, 'data_quality');
}

// ============================================================
// backtest_drift
// ============================================================

function testBacktestDrift() {
  console.log('\n## backtest_drift');

  expectRootCause('actual << expected → backtest_drift', {
    return_pct: -10,
    holding_days: 30,
    backtest_expected_annual_return_pct: 30,
    actual_annualized_return_pct: 5,  // (30-5)/30 = 0.83 > 0.5
  }, 'backtest_drift');

  // 边界：偏离 < 50% 不算 drift
  expectRootCause('actual 略低 → 不算 drift', {
    return_pct: 5,
    holding_days: 30,
    backtest_expected_annual_return_pct: 30,
    actual_annualized_return_pct: 20,  // (30-20)/30 = 0.33 < 0.5
  }, 'profit_take');

  // expected 太小不算 drift (避免分母噪音)
  expectRootCause('expected 太小不算 drift', {
    return_pct: 0,
    holding_days: 30,
    backtest_expected_annual_return_pct: 1,  // < 5% 阈值
    actual_annualized_return_pct: 0,
  }, 'unknown');
}

// ============================================================
// wrong_regime
// ============================================================

function testWrongRegime() {
  console.log('\n## wrong_regime');

  expectRootCause('bull→bear 持仓 10 天亏损', {
    return_pct: -8,
    holding_days: 10,
    market_regime_at_entry: 'bull',
    market_regime_at_exit: 'bear',
  }, 'wrong_regime');

  expectRootCause('range→stress 持仓 7 天亏损', {
    return_pct: -5,
    holding_days: 7,
    market_regime_at_entry: 'range',
    market_regime_at_exit: 'stress',
  }, 'wrong_regime');

  // 持仓 3 天 < 5 不算 wrong_regime (太短)
  expectRootCause('持仓 3 天不算 wrong_regime', {
    return_pct: -5,
    holding_days: 3,
    market_regime_at_entry: 'bull',
    market_regime_at_exit: 'bear',
    max_drawdown_during_hold_pct: 6,  // 触发 wrong_entry
  }, 'wrong_entry');

  // bull→bull 不算切换
  expectRootCause('regime 不变 不算 wrong_regime', {
    return_pct: -3,
    holding_days: 10,
    market_regime_at_entry: 'bull',
    market_regime_at_exit: 'bull',
  }, 'unknown');
}

// ============================================================
// catalyst_failed
// ============================================================

function testCatalystFailed() {
  console.log('\n## catalyst_failed');

  expectRootCause('earnings_surprise 入场但亏损', {
    return_pct: -4,
    holding_days: 8,
    signal_catalyst: 'earnings_surprise',
  }, 'catalyst_failed');

  expectRootCause('event catalyst 亏损', {
    return_pct: -3,
    holding_days: 5,
    signal_catalyst: 'announcement_event',
  }, 'catalyst_failed');

  // 收益 > 0 不算 catalyst_failed (catalyst 成功了)
  expectRootCause('catalyst+positive return → profit_take', {
    return_pct: 5,
    holding_days: 5,
    signal_catalyst: 'earnings_surprise',
  }, 'profit_take');
}

// ============================================================
// wrong_entry
// ============================================================

function testWrongEntry() {
  console.log('\n## wrong_entry');

  expectRootCause('1 周内回撤 6% 最终亏损', {
    return_pct: -3,
    holding_days: 5,
    max_drawdown_during_hold_pct: 6,
  }, 'wrong_entry');

  // 回撤 < 5% 不算
  expectRootCause('回撤 4% 不算 wrong_entry', {
    return_pct: -2,
    holding_days: 5,
    max_drawdown_during_hold_pct: 4,
  }, 'unknown');

  // 持仓 > 7 天不算
  expectRootCause('持仓 15 天 不算 wrong_entry', {
    return_pct: -3,
    holding_days: 15,
    max_drawdown_during_hold_pct: 8,
  }, 'unknown');
}

// ============================================================
// stop_loss
// ============================================================

function testStopLoss() {
  console.log('\n## stop_loss');

  expectRootCause('exit_reason=stop_loss', {
    return_pct: -7,
    holding_days: 4,
    exit_reason: 'stop_loss',
  }, 'stop_loss');

  expectRootCause('return ≤ strategy_stop_loss_pct', {
    return_pct: -8,
    holding_days: 4,
    strategy_stop_loss_pct: -7,  // -8 <= -7 → stop_loss
  }, 'stop_loss');

  // return 高于 stop 不算
  expectRootCause('return > stop_loss_pct 不算', {
    return_pct: -5,
    holding_days: 4,
    strategy_stop_loss_pct: -7,
  }, 'unknown');
}

// ============================================================
// time_stop
// ============================================================

function testTimeStop() {
  console.log('\n## time_stop');

  expectRootCause('exit_reason=time_stop', {
    return_pct: 1,
    holding_days: 30,
    exit_reason: 'time_stop',
  }, 'time_stop');  // 注意 time_stop > profit_take 在优先级链上

  expectRootCause('holding_days >= max_holding', {
    return_pct: 0.5,
    holding_days: 20,
    strategy_max_holding_days: 20,
  }, 'time_stop');
}

// ============================================================
// profit_take (fallback for positive)
// ============================================================

function testProfitTake() {
  console.log('\n## profit_take');

  expectRootCause('positive return 默认 profit_take', {
    return_pct: 5,
    holding_days: 10,
  }, 'profit_take');

  expectRootCause('1% return 也算 profit_take', {
    return_pct: 1,
    holding_days: 3,
  }, 'profit_take');
}

// ============================================================
// unknown (fallback)
// ============================================================

function testUnknown() {
  console.log('\n## unknown');

  expectRootCause('小亏损没匹配任何 rule', {
    return_pct: -1,
    holding_days: 3,
  }, 'unknown');

  expectRootCause('NaN return → unknown', {
    return_pct: NaN,
    holding_days: 10,
  }, 'unknown');

  expectRootCause('Infinity return → unknown', {
    return_pct: Infinity,
    holding_days: 5,
  }, 'unknown');
}

// ============================================================
// priority order
// ============================================================

function testPriorityOrder() {
  console.log('\n## priority chain');

  // kill_switch > 其他所有
  expectRootCause('kill_switch 优先于 stop_loss', {
    return_pct: -10,
    holding_days: 1,
    exit_reason: 'kill_switch_after_stop_loss',
    strategy_stop_loss_pct: -7,
  }, 'risk_kill_switch');

  // data_quality > backtest_drift
  expectRootCause('data_quality 优先于 drift', {
    return_pct: -1,
    holding_days: 10,
    entry_price: 0,
    backtest_expected_annual_return_pct: 30,
    actual_annualized_return_pct: -100,
  }, 'data_quality');

  // wrong_regime > catalyst_failed
  expectRootCause('regime 优先于 catalyst', {
    return_pct: -5,
    holding_days: 10,
    market_regime_at_entry: 'bull',
    market_regime_at_exit: 'bear',
    signal_catalyst: 'earnings_surprise',
  }, 'wrong_regime');
}

// ============================================================
// labels
// ============================================================

function testLabels() {
  console.log('\n## labels');
  for (const cause of Object.keys(ROOT_CAUSE_LABELS) as TradeRootCause[]) {
    const label = ROOT_CAUSE_LABELS[cause];
    assert(`label exists for ${cause}`, typeof label === 'string' && label.length > 0);
  }
}

// ============================================================
// main
// ============================================================

function main() {
  testKillSwitch();
  testDataQuality();
  testBacktestDrift();
  testWrongRegime();
  testCatalystFailed();
  testWrongEntry();
  testStopLoss();
  testTimeStop();
  testProfitTake();
  testUnknown();
  testPriorityOrder();
  testLabels();

  console.log(`\n========================================`);
  console.log(`TradeRootCauseClassifier tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
