/**
 * TCAService 单元测试 (Sprint 42-B):
 *   - signalScoreToExpectedReturnPct
 *   - computeEntrySlippage / computeExitSlippage / computeDelayCost
 *   - attributeSingleTrade
 *   - aggregateAttribution (per-strategy + weight 建议)
 *   - service.runAttribution() (fake DataSource)
 *
 * 不依赖 jest:
 *   cd backend && npx ts-node --transpile-only tests/services/tca-service.test.ts
 */

import {
  signalScoreToExpectedReturnPct,
  computeEntrySlippage,
  computeExitSlippage,
  computeDelayCost,
  attributeSingleTrade,
  aggregateAttribution,
  TCAService,
  TCATradeInput,
  TCAResult,
} from '../../src/services/tca/TCAService';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}
function close(name: string, a: number, b: number, eps = 1e-6): void {
  assert(name, Math.abs(a - b) < eps, `actual=${a} expected=${b}`);
}
function eq<T>(name: string, a: T, b: T): void {
  assert(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
}

// ===========================================================================
// signalScoreToExpectedReturnPct
// ===========================================================================

function testScoreToExpected(): void {
  console.log('# signalScoreToExpectedReturnPct');
  close('95 → 12%', signalScoreToExpectedReturnPct(95)!, 0.12);
  close('85 → 8%', signalScoreToExpectedReturnPct(85)!, 0.08);
  close('75 → 4%', signalScoreToExpectedReturnPct(75)!, 0.04);
  close('65 → 2%', signalScoreToExpectedReturnPct(65)!, 0.02);
  close('55 → 1%', signalScoreToExpectedReturnPct(55)!, 0.01);
  eq('undefined → null', signalScoreToExpectedReturnPct(undefined), null);
}

// ===========================================================================
// slippage helpers
// ===========================================================================

function testSlippageHelpers(): void {
  console.log('# slippage helpers');
  // BUY 100 vs reference 99 → 多付 1% slippage
  close('entry slip 1%', computeEntrySlippage(100, 99)!, 1 / 99);
  // BUY 99 vs reference 100 → 赚 -1% slippage (负 = 好)
  close('entry slip -1%', computeEntrySlippage(99, 100)!, -0.01);
  eq('entry 缺 ref → null', computeEntrySlippage(100), null);
  eq('entry ref=0 → null', computeEntrySlippage(100, 0), null);

  // SELL 99 vs target 100 → 少收 1%
  close('exit slip 1%', computeExitSlippage(99, 100)!, 0.01);
  // SELL 101 vs target 100 → 超额 -1%
  close('exit slip -1%', computeExitSlippage(101, 100)!, -0.01);
  eq('exit 缺 sell → null', computeExitSlippage(undefined, 100), null);
  eq('exit 缺 target → null', computeExitSlippage(99), null);

  // delay: open 101 vs signal close 100 → +1%
  close('delay cost 1%', computeDelayCost(101, 100)!, 0.01);
  eq('delay 缺 → null', computeDelayCost(101), null);
}

// ===========================================================================
// attributeSingleTrade
// ===========================================================================

function testAttribute(): void {
  console.log('# attributeSingleTrade');
  // 完整 trade: signal=85 (expect 8%), buy 100 (ref 99 → slip 1.01%), sell 105 (target 108 → slip ~2.78%)
  // realized = 105/100 - 1 = 5%
  // tracking_error = 8% - 5% = 3%
  const r = attributeSingleTrade({
    symbol: '600519',
    strategy_key: 'mfa',
    buy_execute_price: 100,
    buy_reference_price: 99,
    sell_execute_price: 105,
    sell_reference_price: 108,
    signal_score: 85,
    estimated_impact_cost_pct: 0.005,
  });
  close('realized 5%', r.realized_pnl_pct!, 0.05);
  close('expected 8%', r.signal_expected_return_pct!, 0.08);
  close('tracking_error 3%', r.tracking_error_pct!, 0.03);
  close('entry_slip ~1.01%', r.entry_slippage_pct!, 1 / 99, 1e-4);
  close('impact 0.5%', r.impact_cost_pct, 0.005);
  assert('residual 非 null', r.residual_pct !== null);

  // 缺 sell → realized=null
  const r2 = attributeSingleTrade({
    symbol: '600519',
    strategy_key: 'mfa',
    buy_execute_price: 100,
    signal_score: 85,
  });
  eq('realized=null', r2.realized_pnl_pct, null);
  eq('tracking_error=null', r2.tracking_error_pct, null);
  // 但 impact 应有默认值
  close('impact 默认 0.3%', r2.impact_cost_pct, 0.003);

  // 缺 reference → entry_slip=null
  const r3 = attributeSingleTrade({
    symbol: '600519',
    strategy_key: 'mfa',
    buy_execute_price: 100,
    sell_execute_price: 105,
    signal_score: 85,
  });
  eq('entry_slip 缺 → null', r3.entry_slippage_pct, null);
  assert('realized 仍有值', r3.realized_pnl_pct !== null);
}

// ===========================================================================
// aggregateAttribution
// ===========================================================================

function testAggregate(): void {
  console.log('# aggregateAttribution');
  // 策略 A: 3 trades, entry_slip 平均 0.2% / impact 0.2% → ok
  // 策略 B: 3 trades, entry_slip 平均 0.8% / impact 0.2% → high_cost
  // 策略 C: 3 trades, entry_slip 平均 0.8% / impact 0.5% → severe
  const results: TCAResult[] = [
    {
      symbol: 'A1',
      strategy_key: 'A',
      realized_pnl_pct: 0.05,
      signal_expected_return_pct: 0.08,
      tracking_error_pct: 0.03,
      entry_slippage_pct: 0.002,
      exit_slippage_pct: 0,
      delay_cost_pct: 0,
      impact_cost_pct: 0.002,
      residual_pct: 0.026,
      trade_id: 1,
      reason: '',
    },
    {
      symbol: 'A2',
      strategy_key: 'A',
      realized_pnl_pct: 0.04,
      signal_expected_return_pct: 0.08,
      tracking_error_pct: 0.04,
      entry_slippage_pct: 0.002,
      exit_slippage_pct: 0,
      delay_cost_pct: 0,
      impact_cost_pct: 0.002,
      residual_pct: 0.036,
      trade_id: 2,
      reason: '',
    },
    {
      symbol: 'B1',
      strategy_key: 'B',
      realized_pnl_pct: 0.02,
      signal_expected_return_pct: 0.08,
      tracking_error_pct: 0.06,
      entry_slippage_pct: 0.008,
      exit_slippage_pct: 0,
      delay_cost_pct: 0,
      impact_cost_pct: 0.002,
      residual_pct: 0.05,
      trade_id: 3,
      reason: '',
    },
    {
      symbol: 'C1',
      strategy_key: 'C',
      realized_pnl_pct: 0.0,
      signal_expected_return_pct: 0.08,
      tracking_error_pct: 0.08,
      entry_slippage_pct: 0.008,
      exit_slippage_pct: 0,
      delay_cost_pct: 0,
      impact_cost_pct: 0.005,
      residual_pct: 0.067,
      trade_id: 4,
      reason: '',
    },
  ];
  const summary = aggregateAttribution(results);
  eq('3 strategies', summary.size, 3);
  const a = summary.get('A')!;
  eq('A trade_count=2', a.trade_count, 2);
  eq('A warning=ok', a.warning, 'ok');
  close('A weight=1.0', a.recommended_weight_multiplier, 1);

  const b = summary.get('B')!;
  eq('B warning=high_cost (entry_slip 0.8% > 0.5%)', b.warning, 'high_cost');
  close('B weight=0.7', b.recommended_weight_multiplier, 0.7);

  const c = summary.get('C')!;
  eq('C warning=severe (entry 0.8% + impact 0.5%)', c.warning, 'severe');
  close('C weight=0.5', c.recommended_weight_multiplier, 0.5);
}

// ===========================================================================
// service.runAttribution
// ===========================================================================

async function testService(): Promise<void> {
  console.log('# TCAService.runAttribution');
  const trades: TCATradeInput[] = [
    {
      symbol: 'A1',
      strategy_key: 'mfa',
      buy_execute_price: 100,
      buy_reference_price: 99,
      sell_execute_price: 105,
      sell_reference_price: 108,
      signal_score: 85,
      estimated_impact_cost_pct: 0.003,
    },
    {
      symbol: 'A2',
      strategy_key: 'mfa',
      buy_execute_price: 50,
      buy_reference_price: 49.5,
      sell_execute_price: 52,
      sell_reference_price: 54,
      signal_score: 80,
      estimated_impact_cost_pct: 0.003,
    },
  ];
  const svc = new TCAService({
    async loadClosedTradesForTCA() {
      return trades;
    },
  });
  const r = await svc.runAttribution({ lookback_days: 30 });
  eq('per_trade.length=2', r.per_trade.length, 2);
  eq('total_trades=2', r.total_trades, 2);
  eq('per_strategy.length=1 (都是 mfa)', r.per_strategy.length, 1);
  eq('strategy_key=mfa', r.per_strategy[0].strategy_key, 'mfa');
}

// ===========================================================================
// Run
// ===========================================================================

(async () => {
  testScoreToExpected();
  testSlippageHelpers();
  testAttribute();
  testAggregate();
  await testService();
  console.log('');
  console.log(`✅ passed=${passed}`);
  console.log(`❌ failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
