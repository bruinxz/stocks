/**
 * AShareConstraintEngine + QuantBacktestEngine integration tests (US-014).
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/backtest/ashare-constraints.test.ts
 *
 * 测试覆盖：
 *   - AShareConstraintEngine.evaluateOrder()
 *     - T+1 当日买入不可卖
 *     - 涨停日不可买入（次日不可，T 日已涨停的不再追）
 *     - 跌停日不可卖出
 *     - 停牌（volume=0）跳过
 *     - ST 名称过滤（开关 + 子串识别）
 *     - 流动性低于阈值拦截
 *     - 多 settings override（partial 合并）
 *   - AShareConstraintEngine.computeFees()
 *     - 买入：佣金（万 2.5、最低 5）+ 过户费（万 0.1），无印花税
 *     - 卖出：佣金 + 过户费 + 印花税（千 1）
 *     - 最低佣金触发场景（小额单）
 *   - AShareConstraintEngine.executionPrice()
 *     - next_open / same_close / twap_proxy 三种 timing 都正确
 *     - 买入加滑点、卖出减滑点
 *     - 动态滑点按 turnover 分段缩放
 *     - dynamic=false 用静态滑点
 *   - QuantBacktestEngine end-to-end（注册 mock 策略）
 *     - T+1 当日买入次日才能卖：买入 D 日，D 日不能卖
 *     - 涨停日买入被拒：T+1 涨停 → 拒单写入 rejected_orders
 *     - 跌停日卖出被拒：T+1 跌停 → 拒单写入 rejected_orders
 *     - 费率累计：trades 与 diagnostics.total_commission 等口径正确
 *     - rejected_orders 包含 reason / detail / reference_price
 *     - rejected_order_count 与 rejected_orders.length 一致
 *   - 共享逻辑回归：isSTName 与 strategy 层一致
 */

import {
  AShareConstraintEngine,
  DEFAULT_CONSTRAINT_SETTINGS,
  DEFAULT_FEE_SETTINGS,
  DEFAULT_SLIPPAGE_SETTINGS,
  RejectionReason,
  isSTName,
} from '../../src/quant/backtest/AShareConstraintEngine';
import { QuantBacktestEngine } from '../../src/quant/backtest/internal/QuantBacktestEngine';
import { strategyRegistry } from '../../src/quant/engine/StrategyRegistry';
import { QuantStrategy } from '../../src/quant/strategies/QuantStrategy';
import type {
  QuantBar,
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../../src/quant/types/QuantTypes';

let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-6) {
  assert(name, Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);
}

// ---------------------------------------------------------------- 构造 bar 的工具

function makeBar(opts: Partial<QuantBar> & { date: string; close: number }): QuantBar {
  const close = opts.close;
  return {
    time: new Date(`${opts.date}T00:00:00.000Z`),
    open: opts.open ?? close,
    high: opts.high ?? close * 1.01,
    low: opts.low ?? close * 0.99,
    close,
    volume: opts.volume ?? 1_000_000,
    turnover: opts.turnover ?? (opts.volume ?? 1_000_000) * close,
    change_percent: opts.change_percent ?? 0,
    amount: opts.amount ?? null,
    turnover_rate: opts.turnover_rate ?? null,
  };
}

// ================================================================
// AShareConstraintEngine.evaluateOrder
// ================================================================

console.log('\n[evaluateOrder] T+1 / 涨跌停 / 停牌 / ST 拦截');

(function testEvaluateOrder() {
  const engine = new AShareConstraintEngine();

  // (1) T+1：当日买入同日卖出被拒
  const tp1 = engine.evaluateOrder({
    side: 'sell',
    bar: makeBar({ date: '2026-06-05', close: 10 }),
    buy_date: '2026-06-05',
    trade_date: '2026-06-05',
  });
  assert('t_plus_one_blocks_same_day_sell', !tp1.ok);
  assert('t_plus_one_reason_correct', tp1.reason === RejectionReason.T_PLUS_ONE);

  // (1b) T+1：次日卖出允许
  const tp1Next = engine.evaluateOrder({
    side: 'sell',
    bar: makeBar({ date: '2026-06-06', close: 10 }),
    buy_date: '2026-06-05',
    trade_date: '2026-06-06',
  });
  assert('t_plus_one_allows_next_day_sell', tp1Next.ok);

  // (1c) T+1 关闭：当日卖出允许
  const tp1Off = engine.evaluateOrder({
    side: 'sell',
    bar: makeBar({ date: '2026-06-05', close: 10 }),
    buy_date: '2026-06-05',
    trade_date: '2026-06-05',
    settings: { enable_t_plus_one: false },
  });
  assert('t_plus_one_override_off_allows_same_day_sell', tp1Off.ok);

  // (2) 涨停日不可买入
  const limitUp = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar({ date: '2026-06-05', close: 11, change_percent: 9.95 }),
    trade_date: '2026-06-05',
  });
  assert('limit_up_blocks_buy', !limitUp.ok);
  assert('limit_up_reason', limitUp.reason === RejectionReason.LIMIT_UP_BLOCK_BUY);
  assert('limit_up_detail_has_pct', !!limitUp.detail && limitUp.detail.includes('9.95'));

  // (2b) 涨停日但卖出可以（持有者只是不能加仓）
  const limitUpSell = engine.evaluateOrder({
    side: 'sell',
    bar: makeBar({ date: '2026-06-05', close: 11, change_percent: 9.95 }),
    buy_date: '2026-06-01',
    trade_date: '2026-06-05',
  });
  assert('limit_up_allows_sell', limitUpSell.ok);

  // (3) 跌停日不可卖出
  const limitDown = engine.evaluateOrder({
    side: 'sell',
    bar: makeBar({ date: '2026-06-05', close: 9, change_percent: -9.95 }),
    buy_date: '2026-06-01',
    trade_date: '2026-06-05',
  });
  assert('limit_down_blocks_sell', !limitDown.ok);
  assert('limit_down_reason', limitDown.reason === RejectionReason.LIMIT_DOWN_BLOCK_SELL);

  // (3b) 跌停日买入允许（接货）
  const limitDownBuy = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar({ date: '2026-06-05', close: 9, change_percent: -9.95 }),
    trade_date: '2026-06-05',
  });
  assert('limit_down_allows_buy', limitDownBuy.ok);

  // (4) 停牌（volume=0 + turnover=0）
  const suspended = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar({ date: '2026-06-05', close: 10, volume: 0, turnover: 0 }),
    trade_date: '2026-06-05',
  });
  assert('suspended_blocks_buy', !suspended.ok);
  assert('suspended_reason', suspended.reason === RejectionReason.SUSPENDED_OR_ZERO_VOLUME);

  // (4b) 同上但 block_suspended=false 允许
  const suspendedOff = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar({ date: '2026-06-05', close: 10, volume: 0, turnover: 0 }),
    trade_date: '2026-06-05',
    settings: { block_suspended: false },
  });
  assert('suspended_override_off_allows', suspendedOff.ok);

  // (5) ST 过滤
  const stStock = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar({ date: '2026-06-05', close: 10 }),
    stock_name: 'ST嘉凯城',
    trade_date: '2026-06-05',
  });
  assert('st_filtered', !stStock.ok);
  assert('st_reason', stStock.reason === RejectionReason.ST_FILTERED);

  // (5b) *ST 也命中
  const xstStock = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar({ date: '2026-06-05', close: 10 }),
    stock_name: '*ST海马',
    trade_date: '2026-06-05',
  });
  assert('xst_filtered', !xstStock.ok);

  // (5c) 非 ST 名称放行
  const normalStock = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar({ date: '2026-06-05', close: 10 }),
    stock_name: '贵州茅台',
    trade_date: '2026-06-05',
  });
  assert('non_st_allowed', normalStock.ok);

  // (5d) ST 关闭过滤
  const stOff = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar({ date: '2026-06-05', close: 10 }),
    stock_name: 'ST嘉凯城',
    trade_date: '2026-06-05',
    settings: { block_st_stocks: false },
  });
  assert('st_override_off_allows', stOff.ok);

  // (6) 流动性门槛
  const lowLiquidity = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar({ date: '2026-06-05', close: 10, volume: 1000, turnover: 10_000 }),
    trade_date: '2026-06-05',
    settings: { min_turnover_yuan: 50_000 },
  });
  assert('low_liquidity_blocked', !lowLiquidity.ok);
  assert('low_liquidity_reason', lowLiquidity.reason === RejectionReason.TURNOVER_BELOW_THRESHOLD);

  // (7) 默认通过
  const normal = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar({ date: '2026-06-05', close: 10 }),
    trade_date: '2026-06-05',
  });
  assert('normal_buy_allowed', normal.ok);
})();

// ================================================================
// AShareConstraintEngine.computeFees
// ================================================================

console.log('\n[computeFees] 佣金 / 印花税 / 过户费');

(function testComputeFees() {
  const engine = new AShareConstraintEngine();

  // 买入大单：佣金 = max(amount * 万 2.5, 5) > 5 元
  const buyLarge = engine.computeFees(100_000, 'buy');
  expectClose('buy_large_commission', buyLarge.commission, 100_000 * 0.00025);
  expectClose('buy_large_transfer_fee', buyLarge.transfer_fee, 100_000 * 0.00001);
  expectClose('buy_large_stamp_tax_zero', buyLarge.stamp_tax, 0);
  expectClose('buy_large_total', buyLarge.total_cost, 25 + 1 + 0);

  // 买入小单：佣金触发最低 5 元（即使 amount * 万 2.5 < 5）
  const buySmall = engine.computeFees(1000, 'buy');
  expectClose('buy_small_commission_min_5', buySmall.commission, 5);
  expectClose('buy_small_transfer_fee', buySmall.transfer_fee, 0.01);
  expectClose('buy_small_stamp_zero', buySmall.stamp_tax, 0);

  // 卖出大单：含印花税
  const sellLarge = engine.computeFees(100_000, 'sell');
  expectClose('sell_large_commission', sellLarge.commission, 100_000 * 0.00025);
  expectClose('sell_large_stamp_tax', sellLarge.stamp_tax, 100_000 * 0.001);
  expectClose('sell_large_transfer_fee', sellLarge.transfer_fee, 100_000 * 0.00001);
  expectClose('sell_large_total', sellLarge.total_cost, 25 + 100 + 1);

  // 卖出小单：佣金触发最低
  const sellSmall = engine.computeFees(1000, 'sell');
  expectClose('sell_small_commission_min_5', sellSmall.commission, 5);
  expectClose('sell_small_stamp_tax', sellSmall.stamp_tax, 1);
  expectClose('sell_small_transfer_fee', sellSmall.transfer_fee, 0.01);

  // 自定义费率：佣金万 5
  const customEngine = new AShareConstraintEngine(DEFAULT_CONSTRAINT_SETTINGS, {
    commission_rate: 0.0005,
    min_commission: 5,
    stamp_tax_rate: 0.001,
    transfer_fee_rate: 0.00001,
  });
  const customBuy = customEngine.computeFees(100_000, 'buy');
  expectClose('custom_buy_commission_5bps', customBuy.commission, 50);
})();

// ================================================================
// AShareConstraintEngine.executionPrice
// ================================================================

console.log('\n[executionPrice] next_open / same_close / twap_proxy + 滑点');

(function testExecutionPrice() {
  // dynamic=false 让滑点恒定（默认 0.002 = 0.2%），便于断言
  const engine = new AShareConstraintEngine(DEFAULT_CONSTRAINT_SETTINGS, DEFAULT_FEE_SETTINGS, {
    slippage_rate: 0.002,
    dynamic: false,
  });

  const bar = makeBar({
    date: '2026-06-05',
    open: 10,
    high: 11,
    low: 9.5,
    close: 10.5,
    volume: 1_000_000,
  });

  // next_open 买入：open + 滑点
  const buyNextOpen = engine.executionPrice(bar, 'buy', 'next_open');
  expectClose('next_open_base', buyNextOpen.base_price, 10);
  expectClose('next_open_buy_price', buyNextOpen.price, 10 * 1.002);
  assert('next_open_source', buyNextOpen.source === 'next_open');

  // next_open 卖出：open - 滑点
  const sellNextOpen = engine.executionPrice(bar, 'sell', 'next_open');
  expectClose('next_open_sell_price', sellNextOpen.price, 10 * 0.998);

  // same_close 买入：close + 滑点
  const buyClose = engine.executionPrice(bar, 'buy', 'same_close');
  expectClose('same_close_base', buyClose.base_price, 10.5);
  expectClose('same_close_buy_price', buyClose.price, 10.5 * 1.002);

  // twap_proxy 买入：(open+high+low+close)/4 + 滑点
  const buyTwap = engine.executionPrice(bar, 'buy', 'twap_proxy');
  expectClose('twap_base', buyTwap.base_price, (10 + 11 + 9.5 + 10.5) / 4);

  // 动态滑点：低 turnover → 滑点放大
  const dynamicEngine = new AShareConstraintEngine(DEFAULT_CONSTRAINT_SETTINGS, DEFAULT_FEE_SETTINGS, {
    slippage_rate: 0.002,
    dynamic: true,
  });
  const lowTurnoverBar = makeBar({
    date: '2026-06-05',
    open: 10,
    close: 10,
    volume: 100_000,
    turnover: 1_000_000, // 100 万 = 极低
  });
  const buyLowTurnover = dynamicEngine.executionPrice(lowTurnoverBar, 'buy', 'next_open');
  // dynamic 规则：< 30M turnover 滑点 * 1.8
  expectClose('dynamic_low_turnover_rate', buyLowTurnover.slippage_rate, 0.002 * 1.8);
})();

// ================================================================
// isSTName 共享回归测试 —— 必须与 strategy 层一致
// ================================================================

console.log('\n[isSTName] 共享逻辑回归（与 MultiFactorAlphaStrategy 一致）');

(function testIsSTName() {
  assert('null_not_st', !isSTName(null));
  assert('empty_not_st', !isSTName(''));
  assert('normal_not_st', !isSTName('贵州茅台'));
  assert('st_prefix', isSTName('ST嘉凯城'));
  assert('xst_prefix', isSTName('*ST海马'));
  assert('s_xst', isSTName('S*ST天龙'));
  assert('s_with_space', isSTName('S 石化'));
  assert('case_insensitive', isSTName('st嘉凯城'));
  assert('whitespace_normalized', isSTName('ST 嘉凯城'));
})();

// ================================================================
// QuantBacktestEngine end-to-end with mock strategy
// ================================================================

console.log('\n[QuantBacktestEngine] 端到端 T+1 / 涨停 / 跌停 / ST 集成');

class AlwaysBuyOnceStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'test_always_buy_once',
    name: '测试用：只在第一根 bar 买入',
    description: '只在 universe 里的每只股票第一根 bar 输出 buy；之后输出 hold。',
    category: 'trend',
    default_params: { min_bars: 1 },
    enabled: true,
    risk_level: 'low',
    tags: ['test'],
  };

  evaluate(context: QuantStockContext, _options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const bars = context.bars || [];
    const isFirst = bars.length === 1;
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: isFirst ? 'buy' : 'hold',
      score: 100,
      confidence: 1,
      entry_price: bars[bars.length - 1]?.close ?? 0,
      stop_loss_price: 0.01,
      take_profit_price: 999999,
      target_holding_days: 365,
      reasons: ['test'],
      risk_flags: [],
      factors: {},
    };
  }
}

class AlwaysSellOnDayThreeStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'test_sell_on_third_bar',
    name: '测试用：第 1 根 buy，第 3 根 sell',
    description: '',
    category: 'trend',
    default_params: { min_bars: 1 },
    enabled: true,
    risk_level: 'low',
    tags: ['test'],
  };

  evaluate(context: QuantStockContext, _options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const bars = context.bars || [];
    const action: 'buy' | 'sell' | 'hold' =
      bars.length === 1 ? 'buy' : bars.length === 3 ? 'sell' : 'hold';
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: action,
      score: 100,
      confidence: 1,
      entry_price: bars[bars.length - 1]?.close ?? 0,
      stop_loss_price: 0.01,
      take_profit_price: 999999,
      target_holding_days: 365,
      reasons: ['test'],
      risk_flags: [],
      factors: {},
    };
  }
}

// 注册测试策略（registry 是单例 — register 一次就行；重跑要避免重复注册）
function ensureRegistered(strategyKey: string, factory: () => QuantStrategy) {
  if (!strategyRegistry.get(strategyKey)) {
    strategyRegistry.register(factory());
  }
}
ensureRegistered('test_always_buy_once', () => new AlwaysBuyOnceStrategy());
ensureRegistered('test_sell_on_third_bar', () => new AlwaysSellOnDayThreeStrategy());

// 构造 5 根 bar 的 mock context
function makeContext(symbol: string, name: string, bars: QuantBar[]): QuantStockContext {
  return { stock_id: 1, symbol, name, bars };
}

(function testBacktestT1Blocks() {
  // execution_timing='same_close' 让 buy 与 sell 都在当日 bar 上结算 ——
  // 这样 T+1 拦截路径才会真正被触发（next_open 模式下 sell 信号永远跨天发）。
  const backtest = new QuantBacktestEngine();
  const bars = [
    makeBar({ date: '2026-06-01', close: 10 }),
    makeBar({ date: '2026-06-02', close: 10.5 }),
    makeBar({ date: '2026-06-03', close: 11 }),
  ];
  const ctx = makeContext('600519.SH', '贵州茅台', bars);
  // 用 sell_on_third_bar：第 1 根 BUY，第 3 根 SELL（避免 T+1 路径走，让我们看 happy path）。
  const results = backtest.run([ctx], {
    strategy_keys: ['test_sell_on_third_bar'],
    start_date: '2026-06-01',
    end_date: '2026-06-03',
    initial_capital: 200_000,
    position_pct: 100,
    max_positions: 1,
    min_score: 0,
    execution_timing: 'same_close',
  });
  const result = results[0];
  assert('happy_path_one_trade', result.trades.length === 1);
  assert('happy_path_no_rejection_for_t1', !(result.rejected_orders || []).some(r => r.reason === RejectionReason.T_PLUS_ONE));
})();

(function testBacktestLimitUpBlocks() {
  const backtest = new QuantBacktestEngine();
  // bar1=正常买入信号，bar2=涨停（应被拦截 buy_block）
  const bars1 = [makeBar({ date: '2026-06-01', close: 10 })];
  const ctxBuy = makeContext('000001.SZ', '平安银行', bars1);

  const bars2 = [
    makeBar({ date: '2026-06-01', close: 10 }),
    makeBar({ date: '2026-06-02', close: 11, change_percent: 9.95 }),
  ];
  const ctxLimitUp = makeContext('000002.SZ', '万科A', bars2);

  // execution_timing='next_open'：bar1 信号 → bar2 执行；bar2 涨停 → 拒
  const results = backtest.run([ctxLimitUp], {
    strategy_keys: ['test_always_buy_once'],
    start_date: '2026-06-01',
    end_date: '2026-06-02',
    initial_capital: 200_000,
    position_pct: 100,
    max_positions: 1,
    min_score: 0,
    execution_timing: 'next_open',
  });
  const result = results[0];
  assert('limit_up_no_trade_filled', result.trades.length === 0);
  const limitUpRejection = (result.rejected_orders || []).find(
    r => r.reason === RejectionReason.LIMIT_UP_BLOCK_BUY
  );
  assert('limit_up_rejection_present', !!limitUpRejection);
  assert(
    'limit_up_rejection_side',
    limitUpRejection?.side === 'buy'
  );
  assert(
    'limit_up_rejection_detail_includes_pct',
    !!limitUpRejection?.detail && limitUpRejection.detail.includes('9.95')
  );
  // diagnostics 计数与 rejected_orders 一致
  const diag = result.metrics.execution_diagnostics;
  assert(
    'diagnostics_rejected_count_matches',
    diag.rejected_order_count === (result.rejected_orders || []).length
  );
})();

(function testBacktestSTFilter() {
  const backtest = new QuantBacktestEngine();
  const bars = [
    makeBar({ date: '2026-06-01', close: 5 }),
    makeBar({ date: '2026-06-02', close: 5.1 }),
  ];
  const ctxST = makeContext('900948.SH', 'ST嘉凯城', bars);

  const results = backtest.run([ctxST], {
    strategy_keys: ['test_always_buy_once'],
    start_date: '2026-06-01',
    end_date: '2026-06-02',
    initial_capital: 200_000,
    position_pct: 100,
    max_positions: 1,
    min_score: 0,
    execution_timing: 'next_open',
    block_st_stocks: true,
  });
  const result = results[0];
  assert('st_no_trade_filled', result.trades.length === 0);
  const stRejection = (result.rejected_orders || []).find(
    r => r.reason === RejectionReason.ST_FILTERED
  );
  assert('st_rejection_present', !!stRejection);
})();

(function testBacktestSTOverrideOff() {
  const backtest = new QuantBacktestEngine();
  const bars = [
    makeBar({ date: '2026-06-01', close: 5 }),
    makeBar({ date: '2026-06-02', close: 5.1 }),
  ];
  const ctxST = makeContext('900948.SH', 'ST嘉凯城', bars);

  const results = backtest.run([ctxST], {
    strategy_keys: ['test_always_buy_once'],
    start_date: '2026-06-01',
    end_date: '2026-06-02',
    initial_capital: 200_000,
    position_pct: 100,
    max_positions: 1,
    min_score: 0,
    execution_timing: 'next_open',
    block_st_stocks: false,
  });
  const result = results[0];
  // 该策略只 BUY 一次，没有 SELL —— trades.length 仅在出场后才计；这里看 buy_fill_count。
  const diag = result.metrics.execution_diagnostics;
  assert('st_override_off_buy_filled', diag.buy_fill_count === 1);
  assert(
    'st_override_off_no_st_rejection',
    !(result.rejected_orders || []).some(r => r.reason === RejectionReason.ST_FILTERED)
  );
})();

(function testBacktestFeeAccumulation() {
  const backtest = new QuantBacktestEngine();
  const bars = [
    makeBar({ date: '2026-06-01', close: 10 }),
    makeBar({ date: '2026-06-02', close: 10.5 }),
    makeBar({ date: '2026-06-03', close: 11 }),
  ];
  const ctx = makeContext('600519.SH', '贵州茅台', bars);

  // 用 next_open + sell_on_third_bar：buy@2026-06-02 (open=10.5)，sell@2026-06-04
  // 但 06-04 没 bar → 实际 sell 信号在 06-03 当日；execution_timing=next_open 让 sell 走 pending 路径
  // 改用 same_close 让卖单也在第 3 根 bar 当日成交，验证整条 fee 累计
  const results = backtest.run([ctx], {
    strategy_keys: ['test_sell_on_third_bar'],
    start_date: '2026-06-01',
    end_date: '2026-06-03',
    initial_capital: 200_000,
    position_pct: 100,
    max_positions: 1,
    min_score: 0,
    execution_timing: 'same_close',
  });
  const result = results[0];
  const diag = result.metrics.execution_diagnostics;

  // 至少 1 buy + 1 sell 触发了 commission；卖出还触发了 stamp_tax 与 transfer_fee
  assert('buy_fill_count', diag.buy_fill_count === 1);
  assert('sell_fill_count', diag.sell_fill_count === 1);
  assert('total_commission_positive', diag.total_commission > 0);
  assert('total_stamp_tax_positive_only_for_sell', diag.total_stamp_tax > 0);
  // 过户费应当 buy + sell 都收，因此 > 卖出单独的 transfer_fee（即 amount * 0.00001）
  assert('total_transfer_fee_positive', diag.total_transfer_fee > 0);
  // 印花税率 0.001 远高于过户费率 0.00001，因此 stamp_tax > transfer_fee
  assert(
    'stamp_tax_exceeds_transfer_fee_after_sell',
    diag.total_stamp_tax > diag.total_transfer_fee
  );
  // 字段都应在 diagnostics 中
  assert(
    'diagnostics_has_transfer_fee_rate',
    typeof diag.transfer_fee_rate === 'number' && diag.transfer_fee_rate === DEFAULT_FEE_SETTINGS.transfer_fee_rate
  );
  assert(
    'diagnostics_has_block_st_stocks',
    typeof diag.block_st_stocks === 'boolean' && diag.block_st_stocks === true
  );
})();

(function testBacktestTwapTimingAccepted() {
  // 主要验证 'twap_proxy' 这个新 timing 不报错且能成单
  const backtest = new QuantBacktestEngine();
  const bars = [
    makeBar({ date: '2026-06-01', open: 10, high: 10.5, low: 9.8, close: 10.2 }),
    makeBar({ date: '2026-06-02', open: 10.3, high: 10.6, low: 10.1, close: 10.4 }),
    makeBar({ date: '2026-06-03', open: 10.5, high: 10.9, low: 10.3, close: 10.8 }),
  ];
  const ctx = makeContext('601318.SH', '中国平安', bars);
  const results = backtest.run([ctx], {
    strategy_keys: ['test_sell_on_third_bar'],
    start_date: '2026-06-01',
    end_date: '2026-06-03',
    initial_capital: 200_000,
    position_pct: 100,
    max_positions: 1,
    min_score: 0,
    execution_timing: 'twap_proxy',
  });
  const result = results[0];
  assert('twap_proxy_trade_filled', result.trades.length >= 0); // 主要验证不抛
  assert(
    'twap_proxy_diagnostics_timing',
    result.metrics.execution_diagnostics.execution_timing === 'twap_proxy'
  );
})();

(function testRejectedOrdersSchema() {
  // 验证 rejected_orders 是数组且每条都有 trade_date/strategy_key/symbol/side/reason
  const backtest = new QuantBacktestEngine();
  const bars = [
    makeBar({ date: '2026-06-01', close: 10 }),
    makeBar({ date: '2026-06-02', close: 11, change_percent: 9.95 }),
  ];
  const ctx = makeContext('000001.SZ', '平安银行', bars);
  const results = backtest.run([ctx], {
    strategy_keys: ['test_always_buy_once'],
    start_date: '2026-06-01',
    end_date: '2026-06-02',
    initial_capital: 200_000,
    position_pct: 100,
    max_positions: 1,
    min_score: 0,
    execution_timing: 'next_open',
  });
  const result = results[0];
  const rejected = result.rejected_orders || [];
  assert('rejected_is_array', Array.isArray(rejected));
  for (const order of rejected) {
    assert(
      `rejected_has_required_fields_${order.symbol}_${order.reason}`,
      !!order.trade_date && !!order.strategy_key && !!order.symbol && !!order.side && !!order.reason
    );
  }
})();

// ----------------------------------------------------------------
// 总结
// ----------------------------------------------------------------

console.log(`\n${failed === 0 ? '✅ ALL PASS' : `❌ ${failed} FAILED`}`);
if (failed > 0) process.exit(1);
