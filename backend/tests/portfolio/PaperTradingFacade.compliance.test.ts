/**
 * PaperTradingFacade pre-trade compliance integration 单元测试 (US-010 / PR-005)
 *
 *   cd backend && npx ts-node --transpile-only \
 *     tests/portfolio/PaperTradingFacade.compliance.test.ts
 *
 * 覆盖范围:
 *   [1] buildPreTradeComplianceDraft 纯函数:
 *       - 缺省 context 仍能产出合法 draft
 *       - position_size_pct 用 cost / (current_cash + cost) 公式
 *       - intraday_change_pct 接受 0.07 (小数) 与 7 (百分比) 两种约定
 *       - context 字段透传 (conviction / stop_loss / pe 等)
 *       - bypass 透传
 *   [2] draft + checkPreTradeCompliance 端到端 (无 DB):
 *       - clean draft → ok=true / block=false
 *       - intraday_change_pct=0.08 → NEXT_DAY_CHASE high / block=true
 *       - bypass=true → 总放行
 *       - SELL side → 直接 ok
 *       - stop_loss_distance_pct=0 默认 0.07 (避免 facade 注入 0 时 RR 误触发)
 *   [3] PreTradeComplianceContext shape — TypeScript 编译期校验
 *
 * 不依赖 jest, 与项目其它 backend tests 同款 IIFE + process.exit 模板.
 */

import {
  buildPreTradeComplianceDraft,
  PreTradeComplianceContext,
} from '../../src/portfolio/PaperTradingFacade';
import { checkPreTradeCompliance } from '../../src/services/TradeComplianceChecker';

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

// =====================================================================
// [1] buildPreTradeComplianceDraft 纯函数
// =====================================================================

function test_helper_minimal() {
  const d = buildPreTradeComplianceDraft({
    user_id: 7,
    portfolio_id: 42,
    symbol: '600519',
    side: 'BUY',
    price: 1700,
    quantity: 100,
  });
  assert('minimal: user_id 透传', d.user_id === 7);
  assert('minimal: portfolio_id 透传', d.portfolio_id === 42);
  assert('minimal: symbol 透传', d.symbol === '600519');
  assert('minimal: side BUY', d.side === 'BUY');
  assert('minimal: price/quantity 透传', d.price === 1700 && d.quantity === 100);
  assert(
    'minimal: 无 current_cash 时 position_size_pct undefined',
    d.position_size_pct === undefined
  );
  assert('minimal: conviction_level undefined', d.conviction_level === undefined);
  assert('minimal: stop_loss_distance_pct undefined', d.stop_loss_distance_pct === undefined);
  assert('minimal: market_trend undefined', d.market_trend === undefined);
  assert('minimal: bypass undefined', d.bypass === undefined);
}

function test_helper_position_size_pct() {
  // price 100 × qty 100 = cost 10_000, current_cash 90_000 → 10000/(90000+10000)=0.1
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    current_cash: 90_000,
  });
  assert(
    'position_size_pct: 10% 公式',
    Math.abs((d.position_size_pct as number) - 0.1) < 1e-9,
    `got ${d.position_size_pct}`
  );
}

function test_helper_position_size_pct_zero_cash() {
  // current_cash=0 + cost=10000 → 10000/10000 = 1.0 (满仓), 仍合法
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    current_cash: 0,
  });
  assert(
    'position_size_pct: cash=0 cost>0 → 1.0',
    Math.abs((d.position_size_pct as number) - 1) < 1e-9
  );
}

function test_helper_position_size_pct_sell_skipped() {
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'SELL',
    price: 100,
    quantity: 100,
    current_cash: 90_000,
  });
  assert(
    'position_size_pct: SELL 路径不算 (compliance SELL 直接 ok)',
    d.position_size_pct === undefined
  );
}

function test_helper_intraday_decimal() {
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    context: { intraday_change_pct: 0.08 },
  });
  assert('intraday: 0.08 透传不变', d.intraday_change_pct === 0.08);
}

function test_helper_intraday_percent_form() {
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    context: { intraday_change_pct: 8 }, // 百分比形式 → 0.08
  });
  assert(
    'intraday: 8 (>1) 自动 /100 → 0.08',
    Math.abs((d.intraday_change_pct as number) - 0.08) < 1e-9
  );
}

function test_helper_intraday_negative_percent() {
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    context: { intraday_change_pct: -5 }, // 跌 5%
  });
  assert(
    'intraday: -5 (|>1|) → -0.05',
    Math.abs((d.intraday_change_pct as number) - -0.05) < 1e-9
  );
}

function test_helper_intraday_nan_undefined() {
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    context: { intraday_change_pct: NaN },
  });
  assert('intraday: NaN → undefined', d.intraday_change_pct === undefined);
}

function test_helper_context_passthrough() {
  const ctx: PreTradeComplianceContext = {
    conviction_level: 8,
    strategy_key: 'momentum_v3',
    stop_loss_distance_pct: 0.05,
    market_trend: 'up',
    current_pe: 22,
    historical_avg_pe: 18,
    has_specific_catalyst: true,
    intraday_change_pct: 0.02,
    signal_timestamp_ms: 1_700_000_000_000,
  };
  const d = buildPreTradeComplianceDraft({
    user_id: 9,
    portfolio_id: 33,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    current_cash: 9_000,
    context: ctx,
  });
  assert('context: conviction_level', d.conviction_level === 8);
  assert('context: strategy_key', d.strategy_key === 'momentum_v3');
  assert('context: stop_loss_distance_pct', d.stop_loss_distance_pct === 0.05);
  assert('context: market_trend up', d.market_trend === 'up');
  assert('context: current_pe', d.current_pe === 22);
  assert('context: historical_avg_pe', d.historical_avg_pe === 18);
  assert('context: has_specific_catalyst true', d.has_specific_catalyst === true);
  assert('context: signal_timestamp_ms', d.signal_timestamp_ms === 1_700_000_000_000);
}

function test_helper_has_catalyst_false_dropped() {
  // has_specific_catalyst 仅在显式 true 时透传, false/undefined 都 → undefined
  // 避免 Soros wizard 把"未明示"按"无 catalyst"处理 (区别于真主动声明"无 catalyst")
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    context: { has_specific_catalyst: false },
  });
  assert(
    'has_specific_catalyst=false → undefined (避免误降级)',
    d.has_specific_catalyst === undefined
  );
}

function test_helper_bypass_true() {
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    bypass: true,
  });
  assert('bypass: true 透传', d.bypass === true);
}

function test_helper_bypass_false() {
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    bypass: false,
  });
  assert('bypass: false → undefined (避免误传)', d.bypass === undefined);
}

// =====================================================================
// [2] draft + checkPreTradeCompliance 端到端
// =====================================================================

async function test_e2e_clean_buy() {
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    current_cash: 99_000, // 1%
    context: {
      conviction_level: 9,
      stop_loss_distance_pct: 0.07,
      market_trend: 'up',
      intraday_change_pct: 0.02,
    },
  });
  const r = await checkPreTradeCompliance(d);
  assert('E2E clean BUY → ok=true', r.ok === true);
  assert('E2E clean BUY → block=false', r.block === false);
  assert(
    'E2E clean BUY → 无 high violation',
    !r.violations.some(v => v.severity === 'high'),
    `got ${JSON.stringify(r.violations)}`
  );
}

async function test_e2e_chase_high_blocks() {
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    current_cash: 99_000,
    context: {
      conviction_level: 9,
      stop_loss_distance_pct: 0.07,
      market_trend: 'up',
      intraday_change_pct: 8, // 百分比形式 → 0.08, 触发 NEXT_DAY_CHASE
    },
  });
  const r = await checkPreTradeCompliance(d);
  assert('E2E NEXT_DAY_CHASE → block=true', r.block === true);
  assert(
    'E2E NEXT_DAY_CHASE → 含 high NEXT_DAY_CHASE',
    r.violations.some(v => v.severity === 'high' && v.rule.includes('NEXT_DAY_CHASE'))
  );
}

async function test_e2e_bypass_truthy() {
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    current_cash: 99_000,
    bypass: true,
    context: { intraday_change_pct: 0.5 }, // 涨 50% 也不该触发
  });
  const r = await checkPreTradeCompliance(d);
  assert('E2E bypass=true → ok', r.ok === true && r.block === false);
  assert('E2E bypass=true → 0 violations', r.violations.length === 0);
}

async function test_e2e_sell_short_circuit() {
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'SELL',
    price: 100,
    quantity: 100,
    current_cash: 99_000,
    context: { intraday_change_pct: 0.5 },
  });
  const r = await checkPreTradeCompliance(d);
  assert('E2E SELL → ok', r.ok === true && r.block === false);
  assert('E2E SELL → 0 violations', r.violations.length === 0);
}

async function test_e2e_default_stop_loss_no_false_marcus() {
  // 之前 facade 不传 stop_loss → wizard 内部 fallback 0.07; position 1% × stop 7% = 0.07% 远低于 5%
  // 验证 helper 不传 stop_loss 时 Marcus 风控不会误触发
  const d = buildPreTradeComplianceDraft({
    user_id: 1,
    portfolio_id: 1,
    symbol: '600519',
    side: 'BUY',
    price: 100,
    quantity: 100,
    current_cash: 99_000, // 1%
    context: { market_trend: 'up' },
  });
  assert(
    'helper: 无 stop_loss → stop_loss_distance_pct undefined (让 wizard fallback 0.07)',
    d.stop_loss_distance_pct === undefined
  );
  const r = await checkPreTradeCompliance(d);
  assert(
    'E2E 默认 stop 不触发 Marcus risk per trade',
    !r.violations.some(v => v.severity === 'high' && /risk per trade|风险/i.test(v.rule || v.reason)),
    `got ${JSON.stringify(r.violations)}`
  );
}

// =====================================================================
// IIFE 入口
// =====================================================================

(async () => {
  // [1] 同步纯函数
  test_helper_minimal();
  test_helper_position_size_pct();
  test_helper_position_size_pct_zero_cash();
  test_helper_position_size_pct_sell_skipped();
  test_helper_intraday_decimal();
  test_helper_intraday_percent_form();
  test_helper_intraday_negative_percent();
  test_helper_intraday_nan_undefined();
  test_helper_context_passthrough();
  test_helper_has_catalyst_false_dropped();
  test_helper_bypass_true();
  test_helper_bypass_false();

  // [2] 端到端
  await test_e2e_clean_buy();
  await test_e2e_chase_high_blocks();
  await test_e2e_bypass_truthy();
  await test_e2e_sell_short_circuit();
  await test_e2e_default_stop_loss_no_false_marcus();

  console.log('');
  console.log(`✅ passed=${passed}`);
  console.log(`❌ failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
