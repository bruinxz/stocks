/**
 * PlaybookGenerator 单元测试 (Sprint 42-D):
 *   - STRATEGY_TYPE_MAP / HOLDING_DAYS / FAILURE_CONDITION 完整性
 *   - inferTradeStyle (3 档边界)
 *   - inferAccountRiskStatus (drawdown + position cap)
 *   - inferCoreCatalyst (事件优先 vs strategy 默认)
 *   - generatePlaybook 端到端
 *
 * 不依赖 jest:
 *   cd backend && npx ts-node --transpile-only tests/services/playbook-generator.test.ts
 */

import {
  STRATEGY_TYPE_MAP,
  STRATEGY_HOLDING_DAYS_MAP,
  STRATEGY_FAILURE_CONDITION_MAP,
  inferTradeStyle,
  inferAccountRiskStatus,
  inferCoreCatalyst,
  generatePlaybook,
} from '../../src/services/playbook/PlaybookGenerator';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}
function eq<T>(name: string, a: T, b: T): void {
  assert(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
}

// ===========================================================================
// Mapping 完整性
// ===========================================================================

function testMappingTables(): void {
  console.log('# mapping tables');
  // 13 个组合级策略全在 trade_type map
  const compositeKeys = [
    'multi_factor_alpha',
    'ensemble_strategy',
    'dragon_head_momentum',
    'earnings_surprise',
    'northbound_follow',
    'cta100_momentum',
    'sector_rotation_leader',
    'high_dividend_value',
    'breakout_strategy',
    'garp_strategy',
    'game_trader_relay',
    'left_side_reversal',
    'linkage_strategy',
  ];
  for (const k of compositeKeys) {
    assert(`STRATEGY_TYPE_MAP 含 ${k}`, k in STRATEGY_TYPE_MAP, `missing ${k}`);
  }
  // trade_type 值合法
  for (const [key, type] of Object.entries(STRATEGY_TYPE_MAP)) {
    assert(
      `${key} type valid`,
      ['trend', 'reversal', 'event', 'value_repair', 'flow_driven', 'unknown'].includes(type)
    );
  }
  // 关键策略的 holding_days 合理
  eq('dragon_head 持仓 3 天', STRATEGY_HOLDING_DAYS_MAP.dragon_head_momentum, 3);
  eq('high_dividend 持仓 180 天', STRATEGY_HOLDING_DAYS_MAP.high_dividend_value, 180);

  // 关键 failure_condition 包含止损线
  assert(
    'breakout_strategy failure 含止损',
    STRATEGY_FAILURE_CONDITION_MAP.breakout_strategy.includes('-15%')
  );
  assert(
    'dragon_head failure 含 3 天',
    STRATEGY_FAILURE_CONDITION_MAP.dragon_head_momentum.includes('3 天')
  );
}

// ===========================================================================
// inferTradeStyle
// ===========================================================================

function testTradeStyle(): void {
  console.log('# inferTradeStyle');
  eq('3 天 → quick_swing', inferTradeStyle(3), 'quick_swing');
  eq('14 天 → quick_swing', inferTradeStyle(14), 'quick_swing');
  eq('15 天 → position', inferTradeStyle(15), 'position');
  eq('60 天 → position', inferTradeStyle(60), 'position');
  eq('90 天 → long_term', inferTradeStyle(90), 'long_term');
  eq('180 天 → long_term', inferTradeStyle(180), 'long_term');
  eq('0 → unknown', inferTradeStyle(0), 'unknown');
  eq('NaN → unknown', inferTradeStyle(NaN), 'unknown');
  eq('-5 → unknown', inferTradeStyle(-5), 'unknown');
}

// ===========================================================================
// inferAccountRiskStatus
// ===========================================================================

function testAccountRisk(): void {
  console.log('# inferAccountRiskStatus');
  // 高 drawdown → defensive
  eq(
    'drawdown=10% → defensive',
    inferAccountRiskStatus({ current_drawdown_pct: 10, position_count: 3, max_positions: 8 }),
    'defensive'
  );
  // 高 position pct → defensive
  eq(
    'position_pct=95% → defensive',
    inferAccountRiskStatus({ current_drawdown_pct: 2, position_count: 8, max_positions: 8 }),
    'defensive'
  );
  // 低 drawdown + 低 position → aggressive
  eq(
    'dd=1% pos=2/8 → aggressive',
    inferAccountRiskStatus({ current_drawdown_pct: 1, position_count: 2, max_positions: 8 }),
    'aggressive'
  );
  // 中等 → normal
  eq(
    'dd=4% pos=5/8 → normal',
    inferAccountRiskStatus({ current_drawdown_pct: 4, position_count: 5, max_positions: 8 }),
    'normal'
  );
  // 全缺 → unknown
  eq('全缺 → unknown', inferAccountRiskStatus({}), 'unknown');
}

// ===========================================================================
// inferCoreCatalyst
// ===========================================================================

function testCatalyst(): void {
  console.log('# inferCoreCatalyst');
  // 事件优先 — 业绩 > 北向 > 龙虎榜
  eq(
    '业绩事件优先',
    inferCoreCatalyst(
      {
        strategy_key: 'mfa',
        symbol: '600519',
        has_earnings_event: true,
        has_northbound_inflow: true,
        has_dragon_tiger_inst_buy: true,
      },
      'trend'
    ),
    '业绩超预期 / 业绩报告期'
  );
  // 北向 (无业绩)
  eq(
    '北向次优',
    inferCoreCatalyst(
      {
        strategy_key: 'mfa',
        symbol: '600519',
        has_northbound_inflow: true,
        has_dragon_tiger_inst_buy: true,
      },
      'trend'
    ),
    '北向资金 5 日大幅加仓'
  );
  // 无事件 → strategy 默认
  eq(
    'trend 默认描述',
    inferCoreCatalyst({ strategy_key: 'mfa', symbol: '600519' }, 'trend'),
    '价量趋势延续 / 突破信号'
  );
  eq(
    'reversal 默认',
    inferCoreCatalyst({ strategy_key: 'rsi_mean_reversion', symbol: '600519' }, 'reversal'),
    '超跌反弹 / 技术指标超卖反转'
  );
  eq(
    'value_repair 默认',
    inferCoreCatalyst({ strategy_key: 'high_dividend_value', symbol: '600519' }, 'value_repair'),
    '低估修复 / 高分红长线持有'
  );
  eq(
    'flow_driven 默认',
    inferCoreCatalyst({ strategy_key: 'northbound_follow', symbol: '600519' }, 'flow_driven'),
    '资金面跟随 (北向/主力)'
  );
}

// ===========================================================================
// generatePlaybook end-to-end
// ===========================================================================

function testGenerate(): void {
  console.log('# generatePlaybook');
  const pb1 = generatePlaybook({
    strategy_key: 'breakout_strategy',
    symbol: '600519',
    signal_score: 85,
    market_regime: 'bull',
    current_drawdown_pct: 2,
    position_count: 3,
    max_positions: 8,
    factor_crowding_score: 0.3,
  });
  eq('breakout → trend', pb1.trade_type, 'trend');
  eq('60 天 → position', pb1.trade_style, 'position');
  eq('failure 含止损', pb1.failure_condition.includes('-15%'), true);
  eq('expected_holding_days=60', pb1.expected_holding_days, 60);
  eq('crowding 0.3 → not crowded', pb1.is_crowded, false);
  eq('account risk=aggressive', pb1.account_risk_status, 'aggressive');

  // 事件 + 短线
  const pb2 = generatePlaybook({
    strategy_key: 'dragon_head_momentum',
    symbol: '600519',
    has_dragon_tiger_inst_buy: true,
    current_drawdown_pct: 5,
    position_count: 5,
    max_positions: 8,
    factor_crowding_score: 0.8,
  });
  eq('dragon → event', pb2.trade_type, 'event');
  eq('3 天 → quick_swing', pb2.trade_style, 'quick_swing');
  eq('catalyst = 龙虎榜', pb2.core_catalyst, '龙虎榜机构净买入');
  eq('crowding 0.8 → crowded', pb2.is_crowded, true);
  eq('normal account', pb2.account_risk_status, 'normal');

  // 长线 + 防御
  const pb3 = generatePlaybook({
    strategy_key: 'high_dividend_value',
    symbol: '600519',
    current_drawdown_pct: 12,
    position_count: 8,
    max_positions: 8,
  });
  eq('high_dividend → value_repair', pb3.trade_type, 'value_repair');
  eq('180 天 → long_term', pb3.trade_style, 'long_term');
  eq('account=defensive (dd>=8%)', pb3.account_risk_status, 'defensive');

  // unknown strategy fallback
  const pb4 = generatePlaybook({
    strategy_key: 'random_unknown_strategy',
    symbol: '600519',
  });
  eq('unknown strategy → trade_type=unknown', pb4.trade_type, 'unknown');
  eq('unknown 默认 30 天', pb4.expected_holding_days, 30);
  eq('30 天 → position', pb4.trade_style, 'position');
  eq('unknown 默认 failure', pb4.failure_condition, '-7% 止损 / 30 天到期');
  eq('unknown account → unknown', pb4.account_risk_status, 'unknown');
}

// ===========================================================================
// Run
// ===========================================================================

testMappingTables();
testTradeStyle();
testAccountRisk();
testCatalyst();
testGenerate();

console.log('');
console.log(`✅ passed=${passed}`);
console.log(`❌ failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
