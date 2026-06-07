/**
 * GameTraderRelayStrategy 单测（US-025）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/GameTraderRelayStrategy.test.ts
 *
 * AC 要求构造 mock 数据验证 entry/exit 触发；本文件覆盖：
 *   - 默认参数符合 AC（maxPositions=5 / lookbackDays=2 / netBuyThreshold=50_000_000 等）
 *   - 入场 4 维 AND（累计净买入 + 涨幅 + 流通市值 + 非 ST）
 *   - 接力天数门槛（lookbackDays=2 时至少 2 个 trade_date 都有 famous_yz）
 *   - 入场各维度独立失败
 *   - ST 提前过滤
 *   - maxPositions 上限 + HOLD 占用槽位限 BUY
 *   - 排序稳定：accumulated_net_buy 同分时按 change_pct 降序，再 tie-break stock_code
 *   - 出场 4 类：持有 N 日 / 止损 / 次日大跌 / 接力中断
 *   - 出场优先级：持有期 > 止损 > 次日大跌 > 接力中断
 *   - 进场首日（holdingDays=0）不触发 next-day 出场判定
 *   - 已持仓不重复 BUY
 *   - 缺当日行情数据安全 HOLD
 *   - evaluate() 返回信息性 hold
 *   - naturalDaysBetween 辅助函数
 *   - invalid trade_date 抛错
 *   - lookbackDays <= 0 抛错
 *   - 空 universe 返回空
 *   - 自定义 params override
 */

import {
  DEFAULT_GAME_TRADER_RELAY_PARAMS,
  GameTraderRelayStrategy,
  GameTraderRelayDataSource,
  GameTraderRelayAggregate,
  GameTraderRelayStockMeta,
  GameTraderRelayQuote,
  GameTraderRelayPosition,
  naturalDaysBetween,
  isSTName,
} from '../../src/quant/strategies/GameTraderRelayStrategy';
import { QuantStockContext } from '../../src/quant/types/QuantTypes';

let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectEqual<T>(name: string, actual: T, expected: T, detail = '') {
  const same =
    JSON.stringify(actual) === JSON.stringify(expected) ||
    (typeof actual === 'number' &&
      typeof expected === 'number' &&
      Math.abs(actual - expected) < 1e-9);
  assert(
    name,
    same,
    detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

// ----------------------------------------------------------------
// FakeDataSource — 测试用注入实现
// ----------------------------------------------------------------

class FakeDataSource implements GameTraderRelayDataSource {
  constructor(
    private readonly state: {
      aggregates?: Map<string, Map<string, GameTraderRelayAggregate>>; // date → (code → agg)
      stockMeta?: Map<string, GameTraderRelayStockMeta>;
      dailyQuotes?: Map<string, Map<string, GameTraderRelayQuote>>; // date → (code → quote)
      famousYzToday?: Map<string, Map<string, number>>; // date → (code → net_buy_today)
    } = {}
  ) {}

  async loadFamousYzAggregates(
    asOfDate: string,
    _lookbackDays: number
  ): Promise<Map<string, GameTraderRelayAggregate>> {
    return this.state.aggregates?.get(asOfDate) ?? new Map();
  }
  async loadStockMeta(stockCodes: string[]): Promise<Map<string, GameTraderRelayStockMeta>> {
    const out = new Map<string, GameTraderRelayStockMeta>();
    for (const c of stockCodes) {
      const meta = this.state.stockMeta?.get(c);
      if (meta) out.set(c, meta);
    }
    return out;
  }
  async loadDailyQuotes(
    tradeDate: string,
    stockCodes: string[]
  ): Promise<Map<string, GameTraderRelayQuote>> {
    const m = this.state.dailyQuotes?.get(tradeDate) ?? new Map<string, GameTraderRelayQuote>();
    const out = new Map<string, GameTraderRelayQuote>();
    for (const c of stockCodes) {
      const q = m.get(c);
      if (q) out.set(c, q);
    }
    return out;
  }
  async loadFamousYzNetBuyToday(
    tradeDate: string,
    stockCodes: string[]
  ): Promise<Map<string, number>> {
    const m = this.state.famousYzToday?.get(tradeDate) ?? new Map<string, number>();
    const out = new Map<string, number>();
    for (const c of stockCodes) {
      if (m.has(c)) out.set(c, m.get(c)!);
    }
    return out;
  }
}

// ----------------------------------------------------------------
// Builder helpers
// ----------------------------------------------------------------

function agg(net: number, days = 2): GameTraderRelayAggregate {
  return { accumulated_net_buy: net, relay_day_count: days };
}

function meta(
  name: string,
  industry = '电子',
  cap = 80 * 1e8
): GameTraderRelayStockMeta {
  return { name, industry, circulating_market_cap: cap };
}

function quote(close: number, prev = close / 1.06, change: number = (close - prev) / prev): GameTraderRelayQuote {
  return { open: prev, close, prev_close: prev, change_pct: change };
}

// ----------------------------------------------------------------
// Test cases
// ----------------------------------------------------------------

async function test_default_params_match_AC() {
  // AC: maxPositions=5, lookbackDays=2, netBuyThreshold=5000万, 涨幅 5%,
  // 市值 30-150 亿, holdingDays=3
  expectEqual('maxPositions=5', DEFAULT_GAME_TRADER_RELAY_PARAMS.maxPositions, 5);
  expectEqual('lookbackDays=2', DEFAULT_GAME_TRADER_RELAY_PARAMS.lookbackDays, 2);
  expectEqual('netBuyThreshold=50_000_000', DEFAULT_GAME_TRADER_RELAY_PARAMS.netBuyThreshold, 50_000_000);
  expectEqual('minDailyChangePct=0.05', DEFAULT_GAME_TRADER_RELAY_PARAMS.minDailyChangePct, 0.05);
  expectEqual('minCirculatingMarketCap=30亿', DEFAULT_GAME_TRADER_RELAY_PARAMS.minCirculatingMarketCap, 30 * 1e8);
  expectEqual('maxCirculatingMarketCap=150亿', DEFAULT_GAME_TRADER_RELAY_PARAMS.maxCirculatingMarketCap, 150 * 1e8);
  expectEqual('holdingDaysLimit=3', DEFAULT_GAME_TRADER_RELAY_PARAMS.holdingDaysLimit, 3);
  expectEqual('exitNextDayDropPct=-0.03', DEFAULT_GAME_TRADER_RELAY_PARAMS.exitNextDayDropPct, -0.03);
  expectEqual('stopLossPct=-0.07', DEFAULT_GAME_TRADER_RELAY_PARAMS.stopLossPct, -0.07);
  expectEqual('excludeST=true', DEFAULT_GAME_TRADER_RELAY_PARAMS.excludeST, true);
}

async function test_strategy_definition() {
  const s = new GameTraderRelayStrategy(new FakeDataSource());
  expectEqual('strategy_key', s.definition.strategy_key, 'game_trader_relay');
  expectEqual('category', s.definition.category, 'momentum');
  expectEqual('risk_level', s.definition.risk_level, 'high');
  assert('tags includes 游资', (s.definition.tags ?? []).includes('游资'));
  assert('tags includes 接力', (s.definition.tags ?? []).includes('接力'));
  expectEqual('enabled', s.definition.enabled, true);
}

async function test_entry_all_4_conditions_pass() {
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('正常股票', '电子', 80 * 1e8)]]),
    dailyQuotes: new Map([
      ['2026-06-05', new Map([['600001', quote(11.0, 10.0)]])], // +10% change
    ]),
    famousYzToday: new Map(),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible_count=1', res.eligible_count, 1);
  expectEqual('1 buy', res.signals.filter(x => x.signal === 'buy').length, 1);
  expectEqual('0 sell', res.signals.filter(x => x.signal === 'sell').length, 0);
  expectEqual('target len=1', res.target_positions.length, 1);
  expectEqual('target stock', res.target_positions[0].stock_code, '600001');
  expectEqual('target entry_price=11', res.target_positions[0].entry_price, 11);
}

async function test_entry_fails_when_net_buy_below_threshold() {
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(40_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11.0, 10.0)]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_net_buy=1', res.filtered.fail_net_buy_threshold, 1);
  expectEqual('0 buy', res.signals.filter(x => x.signal === 'buy').length, 0);
}

async function test_entry_fails_when_net_buy_exactly_at_threshold() {
  // 严格 > 阈值：恰等于不通过
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(50_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11.0, 10.0)]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('恰等阈值不通过 eligible=0', res.eligible_count, 0);
  expectEqual('fail_net_buy=1 (boundary strict >)', res.filtered.fail_net_buy_threshold, 1);
}

async function test_entry_fails_when_relay_days_insufficient() {
  // 累计金额够，但只有 1 个 trade_date 触发（单日大单 50_000_001）
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 1)]])]]),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11.0, 10.0)]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0 (relay 1 day insufficient)', res.eligible_count, 0);
  expectEqual('fail_relay_days=1', res.filtered.fail_relay_days, 1);
}

async function test_entry_fails_when_daily_change_insufficient() {
  // 涨幅 4% 不达 5% 门槛
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', { open: 10, close: 10.4, prev_close: 10, change_pct: 0.04 }]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_daily_change=1', res.filtered.fail_daily_change, 1);
}

async function test_entry_change_exactly_at_threshold_fails() {
  // 严格 > 阈值，5% 恰等不通过
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', { open: 10, close: 10.5, prev_close: 10, change_pct: 0.05 }]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0 boundary strict >', res.eligible_count, 0);
  expectEqual('fail_daily_change=1', res.filtered.fail_daily_change, 1);
}

async function test_entry_fails_when_market_cap_too_small() {
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('正常股票', '电子', 20 * 1e8)]]), // 20 亿 < 30 亿
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11, 10)]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_market_cap=1', res.filtered.fail_market_cap, 1);
}

async function test_entry_fails_when_market_cap_too_large() {
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('正常股票', '电子', 200 * 1e8)]]), // 200 亿 > 150 亿
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11, 10)]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_market_cap=1', res.filtered.fail_market_cap, 1);
}

async function test_entry_fails_for_st_stock() {
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('ST华信', '电子', 80 * 1e8)]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11, 10)]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_st=1', res.filtered.fail_st, 1);
}

async function test_entry_excludeST_false_keeps_st() {
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('ST华信', '电子', 80 * 1e8)]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11, 10)]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', { params: { excludeST: false } });
  expectEqual('eligible=1 (excludeST=false 保留)', res.eligible_count, 1);
}

async function test_entry_fails_when_meta_missing() {
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 2)]])]]),
    stockMeta: new Map(), // 缺元数据
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11, 10)]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_meta_missing=1', res.filtered.fail_meta_missing, 1);
}

async function test_entry_fails_when_quote_missing() {
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map(), // 缺当日行情
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_missing_quote=1', res.filtered.fail_missing_quote, 1);
}

async function test_held_stock_not_rebought() {
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11, 10)]])]]),
    famousYzToday: new Map([['2026-06-05', new Map([['600001', 30_000_000]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-05', entry_price: 11 }],
  });
  // 已持仓且 holding=0 + 当日有 famous_yz 净买入 → HOLD
  expectEqual('0 buy (already held)', res.signals.filter(x => x.signal === 'buy').length, 0);
  expectEqual('1 hold', res.signals.filter(x => x.signal === 'hold').length, 1);
}

async function test_max_positions_caps_buys() {
  const codes = ['600001', '600002', '600003', '600004', '600005', '600006', '600007'];
  const aggMap = new Map<string, GameTraderRelayAggregate>();
  const metaMap = new Map<string, GameTraderRelayStockMeta>();
  const quoteMap = new Map<string, GameTraderRelayQuote>();
  for (let i = 0; i < codes.length; i++) {
    aggMap.set(codes[i], agg(100_000_000 - i * 1_000_000, 2)); // 排名
    metaMap.set(codes[i], meta('股票' + i, '电子', 80 * 1e8));
    quoteMap.set(codes[i], quote(11, 10));
  }
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', aggMap]]),
    stockMeta: metaMap,
    dailyQuotes: new Map([['2026-06-05', quoteMap]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=7', res.eligible_count, 7);
  expectEqual('buy capped at maxPositions=5', res.signals.filter(x => x.signal === 'buy').length, 5);
  // 应该选 top 5 (600001..600005)
  expectEqual(
    'top 5 selected',
    res.signals.filter(x => x.signal === 'buy').map(x => x.stock_code).sort(),
    ['600001', '600002', '600003', '600004', '600005']
  );
}

async function test_sort_stable_by_net_buy_then_change() {
  // 5 个都 eligible，accumulated_net_buy 部分相同，比较 change_pct
  const aggMap = new Map<string, GameTraderRelayAggregate>([
    ['600001', agg(80_000_000, 2)], // 大
    ['600002', agg(60_000_000, 2)], // 同
    ['600003', agg(60_000_000, 2)], // 同 (change 高)
    ['600004', agg(70_000_000, 2)], // 中
    ['600005', agg(60_000_000, 2)], // 同 (change 中)
  ]);
  const metaMap = new Map<string, GameTraderRelayStockMeta>();
  for (const c of ['600001', '600002', '600003', '600004', '600005']) {
    metaMap.set(c, meta('股票' + c, '电子'));
  }
  const quoteMap = new Map<string, GameTraderRelayQuote>([
    ['600001', { open: 10, close: 11, prev_close: 10, change_pct: 0.1 }],
    ['600002', { open: 10, close: 10.6, prev_close: 10, change_pct: 0.06 }], // 同 net_buy → change=6%
    ['600003', { open: 10, close: 10.9, prev_close: 10, change_pct: 0.09 }], // 同 net_buy → change=9% (最高)
    ['600004', { open: 10, close: 10.8, prev_close: 10, change_pct: 0.08 }],
    ['600005', { open: 10, close: 10.7, prev_close: 10, change_pct: 0.07 }], // 同 net_buy → change=7%
  ]);
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', aggMap]]),
    stockMeta: metaMap,
    dailyQuotes: new Map([['2026-06-05', quoteMap]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  const buys = res.signals.filter(x => x.signal === 'buy').map(x => x.stock_code);
  // 期待顺序：80M=600001 → 70M=600004 → 60M+change高=600003 → 60M+change中=600005 → 60M+change低=600002
  expectEqual('sort by net_buy desc then change_pct desc', buys, [
    '600001',
    '600004',
    '600003',
    '600005',
    '600002',
  ]);
}

async function test_sort_tie_break_stock_code() {
  // 所有 fields 全部相同 → stock_code 升序
  const aggMap = new Map<string, GameTraderRelayAggregate>([
    ['600003', agg(60_000_000, 2)],
    ['600001', agg(60_000_000, 2)],
    ['600002', agg(60_000_000, 2)],
  ]);
  const metaMap = new Map<string, GameTraderRelayStockMeta>();
  const quoteMap = new Map<string, GameTraderRelayQuote>();
  for (const c of ['600001', '600002', '600003']) {
    metaMap.set(c, meta('股票' + c));
    quoteMap.set(c, { open: 10, close: 11, prev_close: 10, change_pct: 0.1 });
  }
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', aggMap]]),
    stockMeta: metaMap,
    dailyQuotes: new Map([['2026-06-05', quoteMap]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual(
    'tie-break stock_code asc',
    res.signals.filter(x => x.signal === 'buy').map(x => x.stock_code),
    ['600001', '600002', '600003']
  );
}

async function test_exit_holding_days_limit_force_sell() {
  // 持有 3 自然日（== holdingDaysLimit）触发强制平
  const ds = new FakeDataSource({
    aggregates: new Map(), // 无新入场
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11, 11)]])]]),
    famousYzToday: new Map([['2026-06-05', new Map([['600001', 30_000_000]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-02', entry_price: 11 }],
  });
  expectEqual('1 sell', res.signals.filter(x => x.signal === 'sell').length, 1);
  expectEqual(
    'reason contains holdingDaysLimit',
    res.signals[0].reason.includes('holdingDaysLimit') || res.signals[0].reason.includes('强制平仓'),
    true
  );
}

async function test_exit_stop_loss_triggers_sell() {
  // 持有 1 天，跌幅 -8% (< -7% 止损线)
  const ds = new FakeDataSource({
    aggregates: new Map(),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([
      ['2026-06-05', new Map([['600001', { open: 10, close: 9.2, prev_close: 10, change_pct: -0.08 }]])],
    ]),
    famousYzToday: new Map([['2026-06-05', new Map([['600001', 30_000_000]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-04', entry_price: 10 }],
  });
  expectEqual('1 sell', res.signals.filter(x => x.signal === 'sell').length, 1);
  assert(
    'reason contains 止损',
    res.signals[0].reason.includes('止损')
  );
}

async function test_exit_next_day_drop_triggers_sell() {
  // 持有 1 天，跌幅 -4% (> -7% 止损但 < -3% 次日大跌阈值)
  const ds = new FakeDataSource({
    aggregates: new Map(),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([
      ['2026-06-05', new Map([['600001', { open: 10, close: 9.6, prev_close: 10, change_pct: -0.04 }]])],
    ]),
    famousYzToday: new Map([['2026-06-05', new Map([['600001', 30_000_000]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-04', entry_price: 10 }],
  });
  expectEqual('1 sell', res.signals.filter(x => x.signal === 'sell').length, 1);
  assert(
    'reason contains exitNextDayDropPct',
    res.signals[0].reason.includes('exitNextDayDropPct') || res.signals[0].reason.includes('次日跌幅')
  );
}

async function test_exit_relay_break_triggers_sell() {
  // 持有 1 天，今日 famous_yz 净买入消失 → 接力中断
  const ds = new FakeDataSource({
    aggregates: new Map(),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([
      ['2026-06-05', new Map([['600001', { open: 10, close: 10.1, prev_close: 10, change_pct: 0.01 }]])],
    ]),
    famousYzToday: new Map(), // 空 → 当日没有 famous_yz 净买入
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-04', entry_price: 10 }],
  });
  expectEqual('1 sell', res.signals.filter(x => x.signal === 'sell').length, 1);
  assert(
    'reason contains 接力中断',
    res.signals[0].reason.includes('接力中断') || res.signals[0].reason.includes('席位消失')
  );
}

async function test_exit_relay_break_when_net_buy_zero() {
  // 持有 1 天，今日 famous_yz 净买入 == 0 → 也算接力中断（≤ 0）
  const ds = new FakeDataSource({
    aggregates: new Map(),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([
      ['2026-06-05', new Map([['600001', { open: 10, close: 10.1, prev_close: 10, change_pct: 0.01 }]])],
    ]),
    famousYzToday: new Map([['2026-06-05', new Map([['600001', 0]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-04', entry_price: 10 }],
  });
  expectEqual('1 sell (净买入 = 0 算消失)', res.signals.filter(x => x.signal === 'sell').length, 1);
}

async function test_exit_priority_holding_days_beats_stop_loss() {
  // 持有 3 自然日 + 跌幅 -10% → 持有期优先
  const ds = new FakeDataSource({
    aggregates: new Map(),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([
      ['2026-06-05', new Map([['600001', { open: 10, close: 9.0, prev_close: 10, change_pct: -0.1 }]])],
    ]),
    famousYzToday: new Map(),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-02', entry_price: 10 }],
  });
  expectEqual('1 sell', res.signals.filter(x => x.signal === 'sell').length, 1);
  assert(
    'reason mentions 强制平仓 not 止损',
    res.signals[0].reason.includes('强制平仓') && !res.signals[0].reason.includes('止损')
  );
}

async function test_exit_priority_stop_loss_beats_next_day_drop() {
  // 跌幅 -8% → 触发 stop_loss (B) 而不是 next_day_drop (C)
  // 因为 stop_loss 优先级更高
  const ds = new FakeDataSource({
    aggregates: new Map(),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([
      ['2026-06-05', new Map([['600001', { open: 10, close: 9.2, prev_close: 10, change_pct: -0.08 }]])],
    ]),
    famousYzToday: new Map(),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-04', entry_price: 10 }],
  });
  expectEqual('1 sell', res.signals.filter(x => x.signal === 'sell').length, 1);
  assert(
    'reason is 止损 not 次日跌幅',
    res.signals[0].reason.includes('止损') && !res.signals[0].reason.includes('次日跌幅')
  );
}

async function test_exit_priority_next_day_drop_beats_relay_break() {
  // 跌幅 -4% (触发 C) + famous_yz 也没有（也触发 D） → C 先命中
  const ds = new FakeDataSource({
    aggregates: new Map(),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([
      ['2026-06-05', new Map([['600001', { open: 10, close: 9.6, prev_close: 10, change_pct: -0.04 }]])],
    ]),
    famousYzToday: new Map(),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-04', entry_price: 10 }],
  });
  expectEqual('1 sell', res.signals.filter(x => x.signal === 'sell').length, 1);
  assert(
    'reason is 次日跌幅 not 接力中断',
    (res.signals[0].reason.includes('次日跌幅') || res.signals[0].reason.includes('exitNextDayDropPct')) &&
      !res.signals[0].reason.includes('接力中断')
  );
}

async function test_entry_day_no_next_day_drop_check() {
  // 持有 0 天（同日开仓），即便跌幅 -10% 也不触发 next_day_drop（只有 stop_loss 触发）
  // 但 stop_loss -10% 也会触发；让我们设 -2%（不触发 stop_loss 也不触发 next_day_drop）
  // 单纯测 entry-day 不评估 C / D
  const ds = new FakeDataSource({
    aggregates: new Map(),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([
      ['2026-06-05', new Map([['600001', { open: 10, close: 9.8, prev_close: 10, change_pct: -0.02 }]])],
    ]),
    famousYzToday: new Map(), // 当日没有 famous_yz → 但 holding=0 不应触发 D
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-05', entry_price: 10 }],
  });
  expectEqual('entry day → HOLD (不触发 next_day_drop / relay break)', res.signals.filter(x => x.signal === 'hold').length, 1);
  expectEqual('0 sell on entry day', res.signals.filter(x => x.signal === 'sell').length, 0);
}

async function test_exit_hold_kept_consumes_buy_slot() {
  // 5 个候选 + 持仓 3 只都 HOLD → maxPositions=5 → BUY 只剩 2 个槽位
  const codes = ['600006', '600007', '600008', '600009', '600010'];
  const aggMap = new Map<string, GameTraderRelayAggregate>();
  const metaMap = new Map<string, GameTraderRelayStockMeta>([
    ['600001', meta('股票1')],
    ['600002', meta('股票2')],
    ['600003', meta('股票3')],
  ]);
  const quoteMap = new Map<string, GameTraderRelayQuote>([
    ['600001', { open: 10, close: 10.1, prev_close: 10, change_pct: 0.01 }],
    ['600002', { open: 10, close: 10.1, prev_close: 10, change_pct: 0.01 }],
    ['600003', { open: 10, close: 10.1, prev_close: 10, change_pct: 0.01 }],
  ]);
  for (let i = 0; i < codes.length; i++) {
    aggMap.set(codes[i], agg(100_000_000 - i * 1_000_000, 2));
    metaMap.set(codes[i], meta('股票' + i));
    quoteMap.set(codes[i], { open: 10, close: 11, prev_close: 10, change_pct: 0.1 });
  }
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', aggMap]]),
    stockMeta: metaMap,
    dailyQuotes: new Map([['2026-06-05', quoteMap]]),
    famousYzToday: new Map([['2026-06-05', new Map([['600001', 10_000_000], ['600002', 10_000_000], ['600003', 10_000_000]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [
      { stock_code: '600001', entry_date: '2026-06-04', entry_price: 10 },
      { stock_code: '600002', entry_date: '2026-06-04', entry_price: 10 },
      { stock_code: '600003', entry_date: '2026-06-04', entry_price: 10 },
    ],
  });
  expectEqual('3 hold', res.signals.filter(x => x.signal === 'hold').length, 3);
  expectEqual('2 buy (5 - 3 = 2 slots)', res.signals.filter(x => x.signal === 'buy').length, 2);
  expectEqual('target_positions = 5', res.target_positions.length, 5);
}

async function test_missing_quote_for_held_position_safe_hold() {
  // 持仓 + 持有期内 + 缺当日行情 → 安全 HOLD（不出场）
  const ds = new FakeDataSource({
    aggregates: new Map(),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map(), // 缺
    famousYzToday: new Map(),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-04', entry_price: 10 }],
  });
  expectEqual('1 hold', res.signals.filter(x => x.signal === 'hold').length, 1);
  expectEqual('0 sell', res.signals.filter(x => x.signal === 'sell').length, 0);
}

async function test_evaluate_returns_informational_hold() {
  const s = new GameTraderRelayStrategy(new FakeDataSource());
  const ctx: QuantStockContext = {
    symbol: '600001.SH',
    name: '测试',
    industry: '电子',
    bars: [
      { time: new Date('2026-06-04'), open: 10, high: 10.5, low: 9.5, close: 10, volume: 1, turnover: 0 } as any,
    ],
    as_of_date: new Date('2026-06-05'),
  } as any;
  const res = s.evaluate(ctx);
  expectEqual('signal=hold', res.signal, 'hold');
  expectEqual('score=0', res.score, 0);
  expectEqual('factors.note', res.factors?.note, 'use_generateSignals_instead');
}

async function test_helper_naturalDaysBetween() {
  expectEqual('same day=0', naturalDaysBetween('2026-06-05', '2026-06-05'), 0);
  expectEqual('next day=1', naturalDaysBetween('2026-06-04', '2026-06-05'), 1);
  expectEqual('5 days', naturalDaysBetween('2026-06-01', '2026-06-06'), 5);
  expectEqual('negative→0', naturalDaysBetween('2026-06-06', '2026-06-05'), 0);
  expectEqual('invalid→0', naturalDaysBetween('xxx', '2026-06-05'), 0);
}

async function test_helper_isSTName() {
  expectEqual('ST华信→true', isSTName('ST华信'), true);
  expectEqual('*ST天夏→true', isSTName('*ST天夏'), true);
  expectEqual('S*ST石岘→true', isSTName('S*ST石岘'), true);
  expectEqual('SST 海能达→true', isSTName('SST 海能达'), true);
  expectEqual('S 石化→true', isSTName('S 石化'), true);
  expectEqual('贵州茅台→false', isSTName('贵州茅台'), false);
  expectEqual('null→false', isSTName(null), false);
  expectEqual('empty→false', isSTName(''), false);
  expectEqual('whitespace→false', isSTName('   '), false);
}

async function test_invalid_trade_date_throws() {
  const s = new GameTraderRelayStrategy(new FakeDataSource());
  let caught = false;
  try {
    await s.generateSignals('2026/06/05');
  } catch (e) {
    caught = true;
  }
  expectEqual('throws on invalid trade_date', caught, true);
}

async function test_invalid_lookback_days_throws() {
  const s = new GameTraderRelayStrategy(new FakeDataSource());
  let caught = false;
  try {
    await s.generateSignals('2026-06-05', { params: { lookbackDays: 0 } });
  } catch (e) {
    caught = true;
  }
  expectEqual('throws on lookbackDays=0', caught, true);
}

async function test_empty_universe_returns_empty() {
  const ds = new FakeDataSource();
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('0 signals', res.signals.length, 0);
  expectEqual('0 target', res.target_positions.length, 0);
  expectEqual('candidate_pool_size=0', res.filtered.candidate_pool_size, 0);
}

async function test_custom_params_override() {
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(15_000_000, 2)]])]]),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11, 10)]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  // 自定义阈值 1000 万（15M > 10M 通过）
  const res = await s.generateSignals('2026-06-05', {
    params: { netBuyThreshold: 10_000_000 },
  });
  expectEqual('custom netBuyThreshold 通过 1', res.eligible_count, 1);
  expectEqual('effective param', res.params.netBuyThreshold, 10_000_000);
}

async function test_holding_days_2_under_limit_holds() {
  // 持有 2 自然日 < holdingDaysLimit=3 → 不触发 holding-period 出场
  const ds = new FakeDataSource({
    aggregates: new Map(),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([
      ['2026-06-05', new Map([['600001', { open: 10, close: 10.1, prev_close: 10, change_pct: 0.01 }]])],
    ]),
    famousYzToday: new Map([['2026-06-05', new Map([['600001', 30_000_000]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-03', entry_price: 10 }],
  });
  expectEqual('1 hold (2 days < 3)', res.signals.filter(x => x.signal === 'hold').length, 1);
}

async function test_lookback_days_1_relay_only_needs_1_day() {
  // lookbackDays=1 → minRelayDays = min(2, 1) = 1，relay_day_count=1 通过
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600001', agg(60_000_000, 1)]])]]),
    stockMeta: new Map([['600001', meta('正常股票')]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600001', quote(11, 10)]])]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', { params: { lookbackDays: 1 } });
  expectEqual('eligible=1 (lookbackDays=1 relay 1 day OK)', res.eligible_count, 1);
}

async function test_mixed_pass_fail_universe() {
  // 5 只股票，1 通过、4 失败（每种失败 1 个）
  const aggMap = new Map<string, GameTraderRelayAggregate>([
    ['600001', agg(60_000_000, 2)], // pass
    ['600002', agg(40_000_000, 2)], // fail net_buy
    ['600003', agg(60_000_000, 1)], // fail relay days
    ['600004', agg(60_000_000, 2)], // fail change
    ['600005', agg(60_000_000, 2)], // fail market cap
  ]);
  const metaMap = new Map<string, GameTraderRelayStockMeta>([
    ['600001', meta('股票1', '电子', 80 * 1e8)],
    ['600002', meta('股票2', '电子', 80 * 1e8)],
    ['600003', meta('股票3', '电子', 80 * 1e8)],
    ['600004', meta('股票4', '电子', 80 * 1e8)],
    ['600005', meta('股票5', '电子', 200 * 1e8)], // fail cap
  ]);
  const quoteMap = new Map<string, GameTraderRelayQuote>([
    ['600001', { open: 10, close: 11, prev_close: 10, change_pct: 0.1 }],
    ['600002', { open: 10, close: 11, prev_close: 10, change_pct: 0.1 }],
    ['600003', { open: 10, close: 11, prev_close: 10, change_pct: 0.1 }],
    ['600004', { open: 10, close: 10.4, prev_close: 10, change_pct: 0.04 }],
    ['600005', { open: 10, close: 11, prev_close: 10, change_pct: 0.1 }],
  ]);
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', aggMap]]),
    stockMeta: metaMap,
    dailyQuotes: new Map([['2026-06-05', quoteMap]]),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('candidate_pool=5', res.filtered.candidate_pool_size, 5);
  expectEqual('eligible=1', res.eligible_count, 1);
  expectEqual('fail_net_buy_threshold=1', res.filtered.fail_net_buy_threshold, 1);
  expectEqual('fail_relay_days=1', res.filtered.fail_relay_days, 1);
  expectEqual('fail_market_cap=1', res.filtered.fail_market_cap, 1);
  expectEqual('fail_daily_change=1', res.filtered.fail_daily_change, 1);
}

async function test_target_positions_after_full_exit() {
  // 持仓 1 只 -> 持有 3 自然日 SELL → target_positions 应只剩新 BUY
  const ds = new FakeDataSource({
    aggregates: new Map([['2026-06-05', new Map([['600002', agg(60_000_000, 2)]])]]),
    stockMeta: new Map([
      ['600001', meta('股票1')],
      ['600002', meta('股票2')],
    ]),
    dailyQuotes: new Map([
      [
        '2026-06-05',
        new Map<string, GameTraderRelayQuote>([
          ['600001', quote(11, 11)],
          ['600002', quote(11, 10)],
        ]),
      ],
    ]),
    famousYzToday: new Map(),
  });
  const s = new GameTraderRelayStrategy(ds);
  const res = await s.generateSignals('2026-06-05', {
    currentPositions: [{ stock_code: '600001', entry_date: '2026-06-02', entry_price: 10 }],
  });
  expectEqual('1 sell (600001)', res.signals.filter(x => x.signal === 'sell').length, 1);
  expectEqual('1 buy (600002)', res.signals.filter(x => x.signal === 'buy').length, 1);
  expectEqual('target = 1 (only new buy)', res.target_positions.length, 1);
  expectEqual('target stock = 600002', res.target_positions[0].stock_code, '600002');
}

// ----------------------------------------------------------------
// Runner
// ----------------------------------------------------------------

const tests = [
  test_default_params_match_AC,
  test_strategy_definition,
  test_entry_all_4_conditions_pass,
  test_entry_fails_when_net_buy_below_threshold,
  test_entry_fails_when_net_buy_exactly_at_threshold,
  test_entry_fails_when_relay_days_insufficient,
  test_entry_fails_when_daily_change_insufficient,
  test_entry_change_exactly_at_threshold_fails,
  test_entry_fails_when_market_cap_too_small,
  test_entry_fails_when_market_cap_too_large,
  test_entry_fails_for_st_stock,
  test_entry_excludeST_false_keeps_st,
  test_entry_fails_when_meta_missing,
  test_entry_fails_when_quote_missing,
  test_held_stock_not_rebought,
  test_max_positions_caps_buys,
  test_sort_stable_by_net_buy_then_change,
  test_sort_tie_break_stock_code,
  test_exit_holding_days_limit_force_sell,
  test_exit_stop_loss_triggers_sell,
  test_exit_next_day_drop_triggers_sell,
  test_exit_relay_break_triggers_sell,
  test_exit_relay_break_when_net_buy_zero,
  test_exit_priority_holding_days_beats_stop_loss,
  test_exit_priority_stop_loss_beats_next_day_drop,
  test_exit_priority_next_day_drop_beats_relay_break,
  test_entry_day_no_next_day_drop_check,
  test_exit_hold_kept_consumes_buy_slot,
  test_missing_quote_for_held_position_safe_hold,
  test_evaluate_returns_informational_hold,
  test_helper_naturalDaysBetween,
  test_helper_isSTName,
  test_invalid_trade_date_throws,
  test_invalid_lookback_days_throws,
  test_empty_universe_returns_empty,
  test_custom_params_override,
  test_holding_days_2_under_limit_holds,
  test_lookback_days_1_relay_only_needs_1_day,
  test_mixed_pass_fail_universe,
  test_target_positions_after_full_exit,
];

(async () => {
  console.log(`\n=== GameTraderRelayStrategy unit tests (${tests.length}) ===\n`);
  for (const t of tests) {
    try {
      console.log(`-- ${t.name}`);
      await t();
    } catch (err: any) {
      failed += 1;
      console.error(`  THROW ${t.name}: ${err?.message || err}`);
      if (err?.stack) console.error(err.stack);
    }
  }
  console.log(`\nResult: ${failed === 0 ? 'all passed' : `${failed} failed`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
