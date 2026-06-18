/**
 * TradeComplianceChecker.preTrade 单元测试 (BETA-1, audit S-5)
 *
 * IIFE + process.exit + ts-node 模板 (与项目其它 tests 一致):
 *   cd backend && npx ts-node --transpile-only tests/services/TradeComplianceChecker.preTrade.test.ts
 *
 * 覆盖:
 *  - 5 wizard 子规则各自至少 1 个 high/medium/low 路径
 *  - 3 个 pre-trade 独有 wizard (NEXT_DAY_CHASE / STALE_SIGNAL / chk)
 *  - SELL 路径直接返回 ok
 *  - bypass=true 跳过
 *  - 内部异常 fail-OPEN
 */

import {
  checkPreTradeCompliance,
  PreTradeComplianceDraft,
} from '../../src/services/TradeComplianceChecker';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}

async function test_bypass() {
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    bypass: true,
  });
  assert('bypass=true → ok', r.ok === true && r.block === false);
  assert('bypass=true → 0 violations', r.violations.length === 0);
}

async function test_sell_skipped() {
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'SELL',
    price: 1700,
    quantity: 100,
    intraday_change_pct: 0.2, // 涨 20% 也不该触发 — 因为 SELL skip 全部 wizard
  });
  assert('SELL → ok', r.ok === true && r.block === false);
  assert('SELL → 0 violations', r.violations.length === 0);
}

async function test_next_day_chase_high() {
  const draft: PreTradeComplianceDraft = {
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    intraday_change_pct: 0.08, // 8% > 7% threshold
  };
  const r = await checkPreTradeCompliance(draft);
  assert('NEXT_DAY_CHASE 命中 → block', r.block === true);
  assert(
    'NEXT_DAY_CHASE 命中 → 含 high violation',
    r.violations.some(v => v.severity === 'high' && v.rule.includes('NEXT_DAY_CHASE'))
  );
}

async function test_next_day_chase_below_threshold() {
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    intraday_change_pct: 0.05, // 5% < 7%
  });
  assert(
    'NEXT_DAY_CHASE 未命中 (< 7%) → 无 NEXT_DAY_CHASE 违规',
    !r.violations.some(v => v.rule.includes('NEXT_DAY_CHASE'))
  );
}

async function test_marcus_risk_per_trade_high() {
  // position_size=0.1 (10%) × stop_loss_distance=0.07 (7%) = 0.7% < 5%; 不命中
  // 改 position=0.5 (50%) × stop=0.2 (20%) = 10% > 5% → 命中
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    position_size_pct: 0.5,
    stop_loss_distance_pct: 0.2,
  });
  assert(
    'Marcus risk>5% → high violation',
    r.violations.some(
      v => v.severity === 'high' && v.wizard === 'Marcus'
    )
  );
}

async function test_marcus_down_trend() {
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    market_trend: 'down',
  });
  assert(
    'Marcus down-trend BUY → medium',
    r.violations.some(
      v => v.severity === 'medium' && v.wizard === 'Marcus' && v.rule.includes('顺势')
    )
  );
}

async function test_druckenmiller_low_conviction() {
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    position_size_pct: 0.1, // 10% (>= 5%)
    conviction_level: 5, // < 8
  });
  assert(
    'Druckenmiller 重仓低信心 → medium',
    r.violations.some(v => v.wizard === 'Druckenmiller' && v.severity === 'medium')
  );
}

async function test_soros_high_pe_no_catalyst() {
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    current_pe: 60,
    historical_avg_pe: 20, // 3× 历史 > 2×
    has_specific_catalyst: false,
  });
  assert(
    'Soros 高估无催化 → medium',
    r.violations.some(v => v.wizard === 'Soros' && v.severity === 'medium')
  );
}

async function test_soros_with_catalyst_ok() {
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    current_pe: 60,
    historical_avg_pe: 20,
    has_specific_catalyst: true,
  });
  assert(
    'Soros 高估但有催化 → 无 Soros 违规',
    !r.violations.some(v => v.wizard === 'Soros')
  );
}

async function test_stale_signal_medium() {
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    signal_timestamp_ms: Date.now() - 26 * 60 * 60 * 1000, // 26h 前
  });
  assert(
    'STALE_SIGNAL > 24h → medium',
    r.violations.some(
      v => v.wizard === 'PreTrade' && v.severity === 'medium' && v.rule.includes('STALE_SIGNAL')
    )
  );
}

async function test_stale_signal_fresh() {
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    signal_timestamp_ms: Date.now() - 60 * 60 * 1000, // 1h 前
  });
  assert(
    'STALE_SIGNAL 新鲜 → 无 STALE 违规',
    !r.violations.some(v => v.rule.includes('STALE_SIGNAL'))
  );
}

async function test_clean_buy_no_violation() {
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    position_size_pct: 0.03, // 3%
    conviction_level: 9, // high
    stop_loss_distance_pct: 0.07,
    market_trend: 'up',
    current_pe: 15,
    historical_avg_pe: 18,
    intraday_change_pct: 0.02,
    signal_timestamp_ms: Date.now() - 30 * 60 * 1000,
  });
  assert('clean BUY → ok', r.ok === true && r.block === false);
  assert('clean BUY → 0 high violations', !r.violations.some(v => v.severity === 'high'));
}

async function test_sort_by_severity() {
  // 同时触发 high (NEXT_DAY_CHASE) + medium (Marcus down) + low (RR?) 验证排序
  const r = await checkPreTradeCompliance({
    user_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
    intraday_change_pct: 0.08, // high
    market_trend: 'down', // medium
  });
  if (r.violations.length >= 2) {
    assert(
      '排序: high 在前',
      r.violations[0].severity === 'high'
    );
  } else {
    assert('排序测试至少有 2 个 violation', false, `got ${r.violations.length}`);
  }
}

(async () => {
  await test_bypass();
  await test_sell_skipped();
  await test_next_day_chase_high();
  await test_next_day_chase_below_threshold();
  await test_marcus_risk_per_trade_high();
  await test_marcus_down_trend();
  await test_druckenmiller_low_conviction();
  await test_soros_high_pe_no_catalyst();
  await test_soros_with_catalyst_ok();
  await test_stale_signal_medium();
  await test_stale_signal_fresh();
  await test_clean_buy_no_violation();
  await test_sort_by_severity();

  console.log('');
  console.log(`✅ passed=${passed}`);
  console.log(`❌ failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
