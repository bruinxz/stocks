/**
 * NorthboundFollowStrategy 单测（US-019）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/NorthboundFollowStrategy.test.ts
 *
 * FakeDataSource 注入到 NorthboundFollowStrategy(constructor)，避免任何 DB 依赖。
 *
 * 覆盖：
 *   - 默认参数 (AC 指定: lookbackDays=5, minIncreasePct=0.5, maxPositions=20,
 *     minCurrentRatio=1.0, minCirculatingMarketCap=100亿, holdingDaysLimit=30,
 *     stopLossPct=-0.08, exitRatioDecreasePct=-0.3)
 *   - strategy_definition 元数据
 *   - 入场全维度通过
 *   - 入场各维度独立失败：北向 delta 不足 / current_ratio 太低 / 市值不足 / ST / 缺元数据
 *   - 已持仓不重复 BUY (fail_already_held)
 *   - maxPositions cap
 *   - 排序：ratio_delta 降序 → current_ratio tie-break → stock_code 稳定
 *   - 出场：持有期到期 / 止损 / 北向减仓 / 默认 HOLD
 *   - 出场优先级：holdingDaysLimit > stopLoss > 北向减仓
 *   - 缺 close 时安全 HOLD
 *   - HOLD 占用槽位限 BUY 数
 *   - evaluate() 信息性 hold + factors.note
 *   - helper isSTName / naturalDaysBetween 边角
 *   - invalid trade_date 抛出
 *   - 空 universe 安全
 *   - 自定义 params override
 *   - boundary 等于 minIncreasePct
 */

import {
  DEFAULT_NORTHBOUND_FOLLOW_PARAMS,
  isSTName,
  naturalDaysBetween,
  NorthboundFollowDataSource,
  NorthboundFollowPosition,
  NorthboundFollowStockMeta,
  NorthboundFollowStrategy,
  NorthboundRatioSnapshot,
} from '../../src/quant/strategies/NorthboundFollowStrategy';

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

interface FakeFixtures {
  /** stock_code → {current_ratio, ratio_delta}（缺则候选池中没有） */
  ratios?: Map<string, NorthboundRatioSnapshot>;
  meta?: Map<string, NorthboundFollowStockMeta>;
  dailyClose?: Map<string, number>;
}

class FakeDataSource implements NorthboundFollowDataSource {
  constructor(public state: FakeFixtures = {}) {}

  async loadCandidateRatioDeltas(
    _asOfDate: string,
    _lookbackDays: number
  ): Promise<Map<string, NorthboundRatioSnapshot>> {
    return new Map(this.state.ratios ?? new Map());
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, NorthboundFollowStockMeta>> {
    const all = this.state.meta ?? new Map();
    const out = new Map<string, NorthboundFollowStockMeta>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }

  async loadDailyClose(_tradeDate: string, stockCodes: string[]): Promise<Map<string, number>> {
    const all = this.state.dailyClose ?? new Map();
    const out = new Map<string, number>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }
}

// 公共 fixtures 工厂
function makeMeta(
  name: string,
  industry: string,
  mktCapBillion: number
): NorthboundFollowStockMeta {
  return { name, industry, circulating_market_cap: mktCapBillion * 1e8 };
}

// ----------------------------------------------------------------
// 测试用例
// ----------------------------------------------------------------

async function runTests() {
  console.log('Running NorthboundFollowStrategy.test.ts ...\n');

  // ========== Test 1: 默认参数 ==========
  console.log('Test 1: 默认参数 (AC 指定值)');
  {
    expectEqual('  lookbackDays 默认 5', DEFAULT_NORTHBOUND_FOLLOW_PARAMS.lookbackDays, 5);
    expectEqual('  minIncreasePct 默认 0.5', DEFAULT_NORTHBOUND_FOLLOW_PARAMS.minIncreasePct, 0.5);
    expectEqual('  maxPositions 默认 20', DEFAULT_NORTHBOUND_FOLLOW_PARAMS.maxPositions, 20);
    expectEqual(
      '  minCurrentRatio 默认 1.0',
      DEFAULT_NORTHBOUND_FOLLOW_PARAMS.minCurrentRatio,
      1.0
    );
    expectEqual(
      '  minCirculatingMarketCap 默认 100 亿',
      DEFAULT_NORTHBOUND_FOLLOW_PARAMS.minCirculatingMarketCap,
      100 * 1e8
    );
    expectEqual(
      '  holdingDaysLimit 默认 30',
      DEFAULT_NORTHBOUND_FOLLOW_PARAMS.holdingDaysLimit,
      30
    );
    expectEqual('  stopLossPct 默认 -0.08', DEFAULT_NORTHBOUND_FOLLOW_PARAMS.stopLossPct, -0.08);
    expectEqual(
      '  exitRatioDecreasePct 默认 -0.3',
      DEFAULT_NORTHBOUND_FOLLOW_PARAMS.exitRatioDecreasePct,
      -0.3
    );
    expectEqual('  excludeST 默认 true', DEFAULT_NORTHBOUND_FOLLOW_PARAMS.excludeST, true);
  }

  // ========== Test 2: strategy_definition 元数据 ==========
  console.log('\nTest 2: strategy_definition 元数据');
  {
    const s = new NorthboundFollowStrategy(new FakeDataSource());
    expectEqual('  strategy_key', s.definition.strategy_key, 'northbound_follow');
    expectEqual('  enabled', s.definition.enabled, true);
    expectEqual('  category', s.definition.category, 'multi_factor');
    expectEqual('  risk_level', s.definition.risk_level, 'medium');
    assert('  name 非空', s.definition.name.length > 0);
    assert('  description 非空', s.definition.description.length > 0);
    assert('  tags 含 北向资金', (s.definition.tags ?? []).includes('北向资金'));
  }

  // ========== Test 3: 入场全维度通过 ==========
  console.log('\nTest 3: 入场全维度通过 (北向加仓 0.8 > 0.5, current 1.5 > 1.0, 市值 200亿)');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600519', { current_ratio: 1.5, ratio_delta: 0.8 }],
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>([
      ['600519', makeMeta('贵州茅台', '白酒', 200)],
    ]);
    const dailyClose = new Map([['600519', 1800.0]]);
    const ds = new FakeDataSource({ ratios, meta, dailyClose });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 1', r.eligible_count, 1);
    expectEqual('  signals 1 笔 BUY', r.signals.length, 1);
    expectEqual('  signal[0].signal = buy', r.signals[0].signal, 'buy');
    expectEqual('  signal[0].stock_code', r.signals[0].stock_code, '600519');
    expectEqual('  target_positions 1 只', r.target_positions.length, 1);
    expectEqual('  target.entry_date', r.target_positions[0].entry_date, '2026-06-07');
    expectEqual('  target.entry_price', r.target_positions[0].entry_price, 1800.0);
    expectEqual('  target.entry_ratio', r.target_positions[0].entry_ratio, 1.5);
  }

  // ========== Test 4: 入场失败 - 北向 delta 不足 ==========
  console.log('\nTest 4: 入场失败 - 北向 delta 0.3 < minIncreasePct 0.5');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600519', { current_ratio: 1.5, ratio_delta: 0.3 }],
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>([
      ['600519', makeMeta('贵州茅台', '白酒', 200)],
    ]);
    const ds = new FakeDataSource({ ratios, meta });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  filtered.fail_increase_insufficient = 1', r.filtered.fail_increase_insufficient, 1);
  }

  // ========== Test 5: 入场失败 - current_ratio 太低 ==========
  console.log('\nTest 5: 入场失败 - current_ratio 0.5 ≤ minCurrentRatio 1.0');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600519', { current_ratio: 0.5, ratio_delta: 0.8 }],
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>([
      ['600519', makeMeta('贵州茅台', '白酒', 200)],
    ]);
    const ds = new FakeDataSource({ ratios, meta });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  filtered.fail_current_ratio_low = 1', r.filtered.fail_current_ratio_low, 1);
  }

  // ========== Test 6: 入场失败 - 市值不足 ==========
  console.log('\nTest 6: 入场失败 - 流通市值 50 亿 < 100 亿');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['000001', { current_ratio: 1.5, ratio_delta: 0.8 }],
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>([
      ['000001', makeMeta('平安银行', '银行', 50)],
    ]);
    const ds = new FakeDataSource({ ratios, meta });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  filtered.fail_market_cap_low = 1', r.filtered.fail_market_cap_low, 1);
  }

  // ========== Test 7: 入场失败 - ST ==========
  console.log('\nTest 7: 入场失败 - ST 名称');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['000099', { current_ratio: 1.5, ratio_delta: 0.8 }],
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>([
      ['000099', makeMeta('ST 测试', '其他', 200)],
    ]);
    const ds = new FakeDataSource({ ratios, meta });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  filtered.fail_st = 1', r.filtered.fail_st, 1);
  }

  // ========== Test 8: 入场失败 - 缺元数据 ==========
  console.log('\nTest 8: 入场失败 - 缺元数据 / 缺 circulating_market_cap');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600001', { current_ratio: 1.5, ratio_delta: 0.8 }],
      ['600002', { current_ratio: 1.5, ratio_delta: 0.8 }],
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>([
      // 600001 完全缺失
      ['600002', { name: '某股', industry: '某业', circulating_market_cap: null }], // 市值字段为 null
    ]);
    const ds = new FakeDataSource({ ratios, meta });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  filtered.fail_meta_missing = 2', r.filtered.fail_meta_missing, 2);
  }

  // ========== Test 9: 已持仓不重复 BUY ==========
  console.log('\nTest 9: 已持仓股票当日依然满足入场不会重复 BUY (fail_already_held)');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600519', { current_ratio: 1.5, ratio_delta: 0.8 }],
      ['000333', { current_ratio: 2.0, ratio_delta: 1.0 }],
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>([
      ['600519', makeMeta('贵州茅台', '白酒', 200)],
      ['000333', makeMeta('美的集团', '家电', 300)],
    ]);
    const dailyClose = new Map([
      ['600519', 1800.0],
      ['000333', 65.0],
    ]);
    const ds = new FakeDataSource({ ratios, meta, dailyClose });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      currentPositions: [
        { stock_code: '600519', entry_date: '2026-06-05', entry_price: 1750.0, entry_ratio: 1.4 },
      ],
    });
    expectEqual('  eligible_count = 1 (only 000333 新)', r.eligible_count, 1);
    expectEqual('  filtered.fail_already_held = 1', r.filtered.fail_already_held, 1);
    expectEqual(
      '  BUY signals = 1 (000333)',
      r.signals.filter(s => s.signal === 'buy').length,
      1
    );
    expectEqual(
      '  HOLD signals = 1 (600519)',
      r.signals.filter(s => s.signal === 'hold').length,
      1
    );
  }

  // ========== Test 10: maxPositions cap ==========
  console.log('\nTest 10: maxPositions cap (5 个候选 + maxPositions=3 → 只 BUY 3)');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600001', { current_ratio: 1.5, ratio_delta: 2.0 }], // delta 最大
      ['600002', { current_ratio: 1.5, ratio_delta: 1.8 }],
      ['600003', { current_ratio: 1.5, ratio_delta: 1.5 }],
      ['600004', { current_ratio: 1.5, ratio_delta: 1.0 }],
      ['600005', { current_ratio: 1.5, ratio_delta: 0.8 }],
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>();
    for (const c of ['600001', '600002', '600003', '600004', '600005']) {
      meta.set(c, makeMeta(`股票${c}`, '行业A', 200));
    }
    const ds = new FakeDataSource({ ratios, meta });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07', { params: { maxPositions: 3 } });
    expectEqual('  eligible_count = 5 (cap 前)', r.eligible_count, 5);
    expectEqual('  BUY = 3 (cap 后)', r.signals.filter(s => s.signal === 'buy').length, 3);
    const bought = r.signals
      .filter(s => s.signal === 'buy')
      .map(s => s.stock_code)
      .sort();
    expectEqual('  BUY 是 delta 最大的 3 只', bought, ['600001', '600002', '600003']);
  }

  // ========== Test 11: 排序 ratio_delta 降序 ==========
  console.log('\nTest 11: 排序 - ratio_delta 降序');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600001', { current_ratio: 1.5, ratio_delta: 0.8 }],
      ['600002', { current_ratio: 1.5, ratio_delta: 1.5 }], // 应该排第一
      ['600003', { current_ratio: 1.5, ratio_delta: 1.0 }],
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>();
    for (const c of ['600001', '600002', '600003']) {
      meta.set(c, makeMeta(`股票${c}`, '行业A', 200));
    }
    const ds = new FakeDataSource({ ratios, meta });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07', { params: { maxPositions: 3 } });
    const buys = r.signals.filter(s => s.signal === 'buy');
    expectEqual('  buys[0]', buys[0].stock_code, '600002');
    expectEqual('  buys[1]', buys[1].stock_code, '600003');
    expectEqual('  buys[2]', buys[2].stock_code, '600001');
  }

  // ========== Test 12: 排序 - current_ratio tie-break ==========
  console.log('\nTest 12: 排序 - delta 相同时 current_ratio 降序');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600001', { current_ratio: 1.5, ratio_delta: 1.0 }], // tie delta
      ['600002', { current_ratio: 2.5, ratio_delta: 1.0 }], // tie delta, 高 current
      ['600003', { current_ratio: 1.8, ratio_delta: 1.0 }], // tie delta
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>();
    for (const c of ['600001', '600002', '600003']) {
      meta.set(c, makeMeta(`股票${c}`, '行业A', 200));
    }
    const ds = new FakeDataSource({ ratios, meta });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07', { params: { maxPositions: 3 } });
    const buys = r.signals.filter(s => s.signal === 'buy');
    expectEqual('  buys[0] = 600002 (current 最高)', buys[0].stock_code, '600002');
    expectEqual('  buys[1] = 600003 (current 中)', buys[1].stock_code, '600003');
    expectEqual('  buys[2] = 600001 (current 最低)', buys[2].stock_code, '600001');
  }

  // ========== Test 13: 排序 - stock_code tie-break ==========
  console.log('\nTest 13: 排序 - delta + current 完全相同时 stock_code 升序');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600003', { current_ratio: 1.5, ratio_delta: 1.0 }],
      ['600001', { current_ratio: 1.5, ratio_delta: 1.0 }],
      ['600002', { current_ratio: 1.5, ratio_delta: 1.0 }],
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>();
    for (const c of ['600001', '600002', '600003']) {
      meta.set(c, makeMeta(`股票${c}`, '行业A', 200));
    }
    const ds = new FakeDataSource({ ratios, meta });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07');
    const buys = r.signals.filter(s => s.signal === 'buy');
    expectEqual('  buys 顺序 = ascending stock_code', buys.map(b => b.stock_code), [
      '600001',
      '600002',
      '600003',
    ]);
  }

  // ========== Test 14: 出场 - 持有期到期 ==========
  console.log('\nTest 14: 出场 - 持有 ≥ holdingDaysLimit (30 自然日) → SELL');
  {
    const ds = new FakeDataSource({
      ratios: new Map([
        ['600519', { current_ratio: 1.5, ratio_delta: 0.5 }], // 北向仍在加仓
      ]),
      dailyClose: new Map([['600519', 1900]]), // 盈利
      meta: new Map([['600519', makeMeta('贵州茅台', '白酒', 200)]]),
    });
    const s = new NorthboundFollowStrategy(ds);
    const pos: NorthboundFollowPosition = {
      stock_code: '600519',
      entry_date: '2026-05-01', // 距 2026-06-07 = 37 自然日
      entry_price: 1800,
    };
    const r = await s.generateSignals('2026-06-07', { currentPositions: [pos] });
    const sig = r.signals.find(s => s.stock_code === '600519');
    expectEqual('  signal = sell', sig?.signal, 'sell');
    assert('  reason 含 到期', !!sig?.reason.includes('到期'));
  }

  // ========== Test 15: 出场 - 止损 ==========
  console.log('\nTest 15: 出场 - 跌幅 ≤ stopLossPct (-8%)');
  {
    const ds = new FakeDataSource({
      ratios: new Map([['600519', { current_ratio: 1.5, ratio_delta: 0.5 }]]),
      dailyClose: new Map([['600519', 1620]]), // -10% from 1800
      meta: new Map([['600519', makeMeta('贵州茅台', '白酒', 200)]]),
    });
    const s = new NorthboundFollowStrategy(ds);
    const pos: NorthboundFollowPosition = {
      stock_code: '600519',
      entry_date: '2026-06-05',
      entry_price: 1800,
    };
    const r = await s.generateSignals('2026-06-07', { currentPositions: [pos] });
    const sig = r.signals.find(s => s.stock_code === '600519');
    expectEqual('  signal = sell', sig?.signal, 'sell');
    assert('  reason 含 止损', !!sig?.reason.includes('止损'));
  }

  // ========== Test 16: 出场 - 北向减仓 ==========
  console.log('\nTest 16: 出场 - 北向近 5 日累计减仓 ≤ exitRatioDecreasePct (-0.3)');
  {
    const ds = new FakeDataSource({
      ratios: new Map([['600519', { current_ratio: 1.0, ratio_delta: -0.5 }]]), // 减仓 0.5pp
      dailyClose: new Map([['600519', 1780]]), // 微跌但未到止损
      meta: new Map([['600519', makeMeta('贵州茅台', '白酒', 200)]]),
    });
    const s = new NorthboundFollowStrategy(ds);
    const pos: NorthboundFollowPosition = {
      stock_code: '600519',
      entry_date: '2026-06-05',
      entry_price: 1800,
    };
    const r = await s.generateSignals('2026-06-07', { currentPositions: [pos] });
    const sig = r.signals.find(s => s.stock_code === '600519');
    expectEqual('  signal = sell', sig?.signal, 'sell');
    assert('  reason 含 北向减仓', !!sig?.reason.includes('北向'));
  }

  // ========== Test 17: 出场 - 默认 HOLD ==========
  console.log('\nTest 17: 出场 - 持有期内 + 未止损 + 北向没大减 → HOLD');
  {
    const ds = new FakeDataSource({
      ratios: new Map([['600519', { current_ratio: 1.5, ratio_delta: -0.1 }]]), // 小幅减仓但未到阈值
      dailyClose: new Map([['600519', 1820]]), // 微涨
      meta: new Map([['600519', makeMeta('贵州茅台', '白酒', 200)]]),
    });
    const s = new NorthboundFollowStrategy(ds);
    const pos: NorthboundFollowPosition = {
      stock_code: '600519',
      entry_date: '2026-06-05',
      entry_price: 1800,
    };
    const r = await s.generateSignals('2026-06-07', { currentPositions: [pos] });
    const sig = r.signals.find(s => s.stock_code === '600519');
    expectEqual('  signal = hold', sig?.signal, 'hold');
  }

  // ========== Test 18: 出场优先级 - 持有期 > 止损 ==========
  console.log('\nTest 18: 出场优先级 - 同时触发 持有期 + 止损 → 持有期 reason 优先');
  {
    const ds = new FakeDataSource({
      ratios: new Map([['600519', { current_ratio: 1.5, ratio_delta: 0.5 }]]),
      dailyClose: new Map([['600519', 1500]]), // -16.7% 跌幅
      meta: new Map([['600519', makeMeta('贵州茅台', '白酒', 200)]]),
    });
    const s = new NorthboundFollowStrategy(ds);
    const pos: NorthboundFollowPosition = {
      stock_code: '600519',
      entry_date: '2026-05-01', // 37 自然日 >> 30
      entry_price: 1800,
    };
    const r = await s.generateSignals('2026-06-07', { currentPositions: [pos] });
    const sig = r.signals.find(s => s.stock_code === '600519');
    expectEqual('  signal = sell', sig?.signal, 'sell');
    assert('  reason 含 到期 (优先级最高)', !!sig?.reason.includes('到期'));
  }

  // ========== Test 19: 出场优先级 - 止损 > 北向减仓 ==========
  console.log('\nTest 19: 出场优先级 - 同时触发 止损 + 北向减仓 → 止损 reason 优先');
  {
    const ds = new FakeDataSource({
      ratios: new Map([['600519', { current_ratio: 0.5, ratio_delta: -0.5 }]]), // 北向大减仓
      dailyClose: new Map([['600519', 1600]]), // -11% 跌幅
      meta: new Map([['600519', makeMeta('贵州茅台', '白酒', 200)]]),
    });
    const s = new NorthboundFollowStrategy(ds);
    const pos: NorthboundFollowPosition = {
      stock_code: '600519',
      entry_date: '2026-06-05',
      entry_price: 1800,
    };
    const r = await s.generateSignals('2026-06-07', { currentPositions: [pos] });
    const sig = r.signals.find(s => s.stock_code === '600519');
    expectEqual('  signal = sell', sig?.signal, 'sell');
    assert('  reason 含 止损 (优先级 B > C)', !!sig?.reason.includes('止损'));
  }

  // ========== Test 20: 出场 - 缺 close 数据 ==========
  console.log('\nTest 20: 出场 - 当日缺 close 数据 → 安全 HOLD');
  {
    const ds = new FakeDataSource({
      ratios: new Map([['600519', { current_ratio: 1.5, ratio_delta: 0.5 }]]),
      dailyClose: new Map(), // 空
      meta: new Map([['600519', makeMeta('贵州茅台', '白酒', 200)]]),
    });
    const s = new NorthboundFollowStrategy(ds);
    const pos: NorthboundFollowPosition = {
      stock_code: '600519',
      entry_date: '2026-06-05',
      entry_price: 1800,
    };
    const r = await s.generateSignals('2026-06-07', { currentPositions: [pos] });
    const sig = r.signals.find(s => s.stock_code === '600519');
    expectEqual('  signal = hold', sig?.signal, 'hold');
    assert('  reason 含 缺 close 数据', !!sig?.reason.includes('缺 close 数据'));
  }

  // ========== Test 21: HOLD 占用槽位限 BUY 数 ==========
  console.log('\nTest 21: HOLD 占用槽位 - maxPositions=3，4 个 HOLD + 5 个新候选 → BUY 0');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600100', { current_ratio: 1.5, ratio_delta: 0.5 }], // HOLD 持仓 1
      ['600101', { current_ratio: 1.5, ratio_delta: 0.5 }], // HOLD 持仓 2
      ['600102', { current_ratio: 1.5, ratio_delta: 0.5 }], // HOLD 持仓 3
      ['600103', { current_ratio: 1.5, ratio_delta: 0.5 }], // HOLD 持仓 4
      ['600200', { current_ratio: 1.5, ratio_delta: 0.8 }], // 新候选
      ['600201', { current_ratio: 1.5, ratio_delta: 0.8 }], // 新候选
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>();
    for (const c of ['600100', '600101', '600102', '600103', '600200', '600201']) {
      meta.set(c, makeMeta(`股票${c}`, '行业A', 200));
    }
    const dailyClose = new Map<string, number>();
    for (const c of ['600100', '600101', '600102', '600103', '600200', '600201']) {
      dailyClose.set(c, 100);
    }
    const ds = new FakeDataSource({ ratios, meta, dailyClose });
    const s = new NorthboundFollowStrategy(ds);

    const positions: NorthboundFollowPosition[] = [
      { stock_code: '600100', entry_date: '2026-06-05', entry_price: 100 },
      { stock_code: '600101', entry_date: '2026-06-05', entry_price: 100 },
      { stock_code: '600102', entry_date: '2026-06-05', entry_price: 100 },
      { stock_code: '600103', entry_date: '2026-06-05', entry_price: 100 },
    ];
    const r = await s.generateSignals('2026-06-07', {
      params: { maxPositions: 3 },
      currentPositions: positions,
    });
    expectEqual('  BUY = 0 (槽位被 HOLD 占满，且超出)', r.signals.filter(s => s.signal === 'buy').length, 0);
    // HOLD 不会被强行减仓——这是 strategy 设计：超额持仓暂时容忍，下个调仓自然衰减
    expectEqual('  HOLD = 4', r.signals.filter(s => s.signal === 'hold').length, 4);
  }

  // ========== Test 22: evaluate() 信息性 hold ==========
  console.log('\nTest 22: evaluate() 信息性 hold + factors.note');
  {
    const s = new NorthboundFollowStrategy(new FakeDataSource());
    const ctx: any = { symbol: '600519.SH', name: '贵州茅台', bars: [{ close: 1800 }] };
    const r = s.evaluate(ctx);
    expectEqual('  signal', r.signal, 'hold');
    expectEqual('  factors.note', r.factors?.note, 'use_generateSignals_instead');
    expectEqual('  entry_price', r.entry_price, 1800);
    assert('  reasons 提示用 generateSignals', !!r.reasons?.some(rr => rr.includes('generateSignals')));
  }

  // ========== Test 23: helper isSTName ==========
  console.log('\nTest 23: helper isSTName 边角');
  {
    expectEqual('  null', isSTName(null), false);
    expectEqual('  empty', isSTName(''), false);
    expectEqual('  贵州茅台', isSTName('贵州茅台'), false);
    expectEqual('  ST 大唐', isSTName('ST 大唐'), true);
    expectEqual('  *ST 美都', isSTName('*ST 美都'), true);
    expectEqual('  STest 测试 (不是 ST)', isSTName('STest 测试'), true); // 当前实现 startsWith ST → true (与 EarningsSurprise 一致)
    expectEqual('  S佳通', isSTName('S佳通'), true); // 退市风险预警
    expectEqual('  其他 (Some)', isSTName('Some'), false);
  }

  // ========== Test 24: helper naturalDaysBetween ==========
  console.log('\nTest 24: helper naturalDaysBetween');
  {
    expectEqual('  same day = 0', naturalDaysBetween('2026-06-07', '2026-06-07'), 0);
    expectEqual('  1 day', naturalDaysBetween('2026-06-06', '2026-06-07'), 1);
    expectEqual('  31 day', naturalDaysBetween('2026-05-07', '2026-06-07'), 31);
    expectEqual('  invalid → 0', naturalDaysBetween('invalid', '2026-06-07'), 0);
    expectEqual('  reverse → 0 (max)', naturalDaysBetween('2026-06-07', '2026-06-05'), 0);
  }

  // ========== Test 25: invalid trade_date 抛出 ==========
  console.log('\nTest 25: invalid trade_date 抛出');
  {
    const s = new NorthboundFollowStrategy(new FakeDataSource());
    let thrown = false;
    try {
      await s.generateSignals('2026/06/07');
    } catch (e: any) {
      thrown = true;
      assert('  error message 提示 YYYY-MM-DD', !!e.message?.includes('YYYY-MM-DD'));
    }
    assert('  应抛出', thrown);
  }

  // ========== Test 26: 空 universe 安全 ==========
  console.log('\nTest 26: 空 universe 安全 (北向数据全为空)');
  {
    const ds = new FakeDataSource({});
    const s = new NorthboundFollowStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  signals = []', r.signals.length, 0);
    expectEqual('  target_positions = []', r.target_positions.length, 0);
    expectEqual('  filtered.candidate_pool_size = 0', r.filtered.candidate_pool_size, 0);
  }

  // ========== Test 27: 自定义 params override ==========
  console.log('\nTest 27: 自定义 params override (minIncreasePct=0.2)');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600519', { current_ratio: 1.5, ratio_delta: 0.3 }], // 0.3 > 0.2 但 < 默认 0.5
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>([
      ['600519', makeMeta('贵州茅台', '白酒', 200)],
    ]);
    const dailyClose = new Map([['600519', 1800.0]]);
    const ds = new FakeDataSource({ ratios, meta, dailyClose });
    const s = new NorthboundFollowStrategy(ds);

    // 默认参数 - 应不入选
    const r1 = await s.generateSignals('2026-06-07');
    expectEqual('  默认 minIncrease 0.5: eligible 0', r1.eligible_count, 0);

    // override - 应入选
    const r2 = await s.generateSignals('2026-06-07', {
      params: { minIncreasePct: 0.2 },
    });
    expectEqual('  override minIncrease 0.2: eligible 1', r2.eligible_count, 1);
    expectEqual('  实际 minIncreasePct = 0.2', r2.params.minIncreasePct, 0.2);
    expectEqual('  其他参数未变', r2.params.lookbackDays, 5);
  }

  // ========== Test 28: boundary 等于 minIncreasePct (≥ inclusive) ==========
  console.log('\nTest 28: boundary - delta 恰好等于 minIncreasePct → 入选 (≥, inclusive)');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600519', { current_ratio: 1.5, ratio_delta: 0.5 }], // 恰好等于
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>([
      ['600519', makeMeta('贵州茅台', '白酒', 200)],
    ]);
    const dailyClose = new Map([['600519', 1800.0]]);
    const ds = new FakeDataSource({ ratios, meta, dailyClose });
    const s = new NorthboundFollowStrategy(ds);

    const r = await s.generateSignals('2026-06-07');
    expectEqual('  delta 恰等于 → 入选', r.eligible_count, 1);
  }

  // ========== Test 29: 多空混合场景 ==========
  console.log('\nTest 29: 多空混合 - 1 持有期到期 + 1 北向减仓 + 1 持有 + 2 新 BUY 候选');
  {
    const ratios = new Map<string, NorthboundRatioSnapshot>([
      ['600100', { current_ratio: 1.0, ratio_delta: 0.5 }], // 持仓1: 持有期到期 SELL
      ['600101', { current_ratio: 0.8, ratio_delta: -0.4 }], // 持仓2: 北向减仓 SELL
      ['600102', { current_ratio: 1.5, ratio_delta: 0.5 }], // 持仓3: HOLD
      ['600200', { current_ratio: 1.5, ratio_delta: 1.0 }], // 新候选 1
      ['600201', { current_ratio: 1.5, ratio_delta: 0.8 }], // 新候选 2
    ]);
    const meta = new Map<string, NorthboundFollowStockMeta>();
    for (const c of ['600100', '600101', '600102', '600200', '600201']) {
      meta.set(c, makeMeta(`股票${c}`, '行业A', 200));
    }
    const dailyClose = new Map([
      ['600100', 100],
      ['600101', 98],
      ['600102', 102],
      ['600200', 105],
      ['600201', 110],
    ]);
    const ds = new FakeDataSource({ ratios, meta, dailyClose });
    const s = new NorthboundFollowStrategy(ds);

    const positions: NorthboundFollowPosition[] = [
      { stock_code: '600100', entry_date: '2026-05-01', entry_price: 100 }, // 37 自然日 → 到期
      { stock_code: '600101', entry_date: '2026-06-05', entry_price: 100 }, // 北向减仓
      { stock_code: '600102', entry_date: '2026-06-05', entry_price: 100 }, // HOLD
    ];
    const r = await s.generateSignals('2026-06-07', {
      params: { maxPositions: 20 },
      currentPositions: positions,
    });
    const sells = r.signals.filter(s => s.signal === 'sell');
    const buys = r.signals.filter(s => s.signal === 'buy');
    const holds = r.signals.filter(s => s.signal === 'hold');
    expectEqual('  SELL = 2 (持有期到期 + 北向减仓)', sells.length, 2);
    expectEqual('  BUY = 2 (两个新候选)', buys.length, 2);
    expectEqual('  HOLD = 1 (600102)', holds.length, 1);
    expectEqual(
      '  target_positions = HOLD(1) + BUY(2) = 3',
      r.target_positions.length,
      3
    );
    // target_positions 不应包含被 SELL 的
    const targetCodes = r.target_positions.map(p => p.stock_code).sort();
    expectEqual('  target = [600102, 600200, 600201]', targetCodes, [
      '600102',
      '600200',
      '600201',
    ]);
  }

  // ========== Test 30: surveillance lookbackDays override ==========
  console.log('\nTest 30: lookbackDays 自定义 (传给 DataSource)');
  {
    let receivedLookback = -1;
    class CaptureLookback implements NorthboundFollowDataSource {
      async loadCandidateRatioDeltas(
        _asOfDate: string,
        lookbackDays: number
      ): Promise<Map<string, NorthboundRatioSnapshot>> {
        receivedLookback = lookbackDays;
        return new Map();
      }
      async loadStockMeta() {
        return new Map();
      }
      async loadDailyClose() {
        return new Map();
      }
    }
    const s = new NorthboundFollowStrategy(new CaptureLookback());
    await s.generateSignals('2026-06-07', { params: { lookbackDays: 10 } });
    expectEqual('  DataSource 收到 lookbackDays = 10', receivedLookback, 10);
  }

  // ----------------------------------------------------------------
  // 汇总
  // ----------------------------------------------------------------
  console.log('\n----------------------------------------------------------------');
  if (failed === 0) {
    console.log('All NorthboundFollowStrategy tests passed ✓');
  } else {
    console.error(`${failed} assertion(s) failed ✗`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
