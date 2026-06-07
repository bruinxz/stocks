/**
 * CTA100MomentumStrategy 单测（US-020）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/CTA100MomentumStrategy.test.ts
 *
 * FakeDataSource 注入到 CTA100MomentumStrategy(constructor)，避免任何 DB 依赖。
 *
 * 覆盖：
 *   - 默认参数 (AC 指定: indexCode='000852', topN=30, rebalancePeriod='monthly',
 *     industryNeutral=true, maxPerIndustry=3, excludeST=true, lookbackDays=60,
 *     skipRecentDays=5)
 *   - strategy_definition 元数据 (strategy_key, category='momentum', risk_level='high')
 *   - 入场动量计算正确 (close[T-5]/close[T-60] - 1)
 *   - 历史 bar 不足时剔除 (fail_insufficient_history)
 *   - ST 剔除 (fail_st)
 *   - 缺元数据剔除 (fail_meta_missing)
 *   - 排序 momentum 降序 + stock_code 稳定 tie-break
 *   - 行业中性 cap (maxPerIndustry)
 *   - industryNeutral=false 不做行业限制
 *   - top-N cap (8 候选 + topN=5 → 5 个)
 *   - BUY / HOLD / SELL 增量信号
 *   - 首次开仓 (无 previousSelection) 全为 BUY
 *   - evaluate() 信息性 hold + factors.note
 *   - helper isSTName 边角
 *   - invalid trade_date 抛出
 *   - 空 universe (sync 未跑) 安全空返回
 *   - 自定义 indexCode override
 *   - lookbackDays ≤ skipRecentDays 抛出
 */

import {
  CTA100MomentumDataSource,
  CTA100MomentumStrategy,
  CTA100StockMeta,
  DEFAULT_CTA100_MOMENTUM_PARAMS,
  IndexUniverseSnapshot,
  MomentumBar,
  isSTName,
} from '../../src/quant/strategies/CTA100MomentumStrategy';

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

function expectClose(name: string, actual: number, expected: number, eps = 1e-6) {
  const ok = Math.abs(actual - expected) <= eps;
  assert(name, ok, `expected ≈ ${expected}, got ${actual}`);
}

// ----------------------------------------------------------------
// FakeDataSource — 测试用注入实现
// ----------------------------------------------------------------

interface FakeFixtures {
  /** 指数 universe（snapshot_date + stock_codes） */
  universe?: IndexUniverseSnapshot;
  /** stock_code → 历史 bar 列表（升序） */
  bars?: Map<string, MomentumBar[]>;
  meta?: Map<string, CTA100StockMeta>;
}

class FakeDataSource implements CTA100MomentumDataSource {
  constructor(public state: FakeFixtures = {}) {}

  async loadIndexUniverse(_asOfDate: string, _indexCode: string): Promise<IndexUniverseSnapshot> {
    return this.state.universe ?? { snapshot_date: null, stock_codes: [] };
  }

  async loadMomentumBars(
    _asOfDate: string,
    stockCodes: string[],
    _minTradingDays: number
  ): Promise<Map<string, MomentumBar[]>> {
    const all = this.state.bars ?? new Map();
    const out = new Map<string, MomentumBar[]>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, CTA100StockMeta>> {
    const all = this.state.meta ?? new Map();
    const out = new Map<string, CTA100StockMeta>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }
}

// 构造一个 lookbackDays + skipRecentDays + buffer 长度的 bars 数组。
// closeFn(index) 决定每条 bar 的 close 价。索引 0 = 最早，length-1 = 最新。
function makeBars(length: number, closeFn: (i: number) => number): MomentumBar[] {
  const bars: MomentumBar[] = [];
  // 构造从 2026-01-01 起 length 个交易日的 bar（简化用自然日；测试不关心 trade_date 真实性）
  const start = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < length; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    bars.push({
      trade_date: d.toISOString().slice(0, 10),
      close: closeFn(i),
    });
  }
  return bars;
}

function meta(name: string, industry: string): CTA100StockMeta {
  return { name, industry };
}

// ----------------------------------------------------------------
// 测试用例
// ----------------------------------------------------------------

async function runTests() {
  console.log('Running CTA100MomentumStrategy.test.ts ...\n');

  // ========== Test 1: 默认参数 ==========
  console.log('Test 1: 默认参数 (AC 指定值)');
  {
    expectEqual(
      '  indexCode 默认 000852',
      DEFAULT_CTA100_MOMENTUM_PARAMS.indexCode,
      '000852'
    );
    expectEqual('  topN 默认 30', DEFAULT_CTA100_MOMENTUM_PARAMS.topN, 30);
    expectEqual(
      '  rebalancePeriod 默认 monthly',
      DEFAULT_CTA100_MOMENTUM_PARAMS.rebalancePeriod,
      'monthly'
    );
    expectEqual(
      '  industryNeutral 默认 true',
      DEFAULT_CTA100_MOMENTUM_PARAMS.industryNeutral,
      true
    );
    expectEqual(
      '  maxPerIndustry 默认 3',
      DEFAULT_CTA100_MOMENTUM_PARAMS.maxPerIndustry,
      3
    );
    expectEqual('  excludeST 默认 true', DEFAULT_CTA100_MOMENTUM_PARAMS.excludeST, true);
    expectEqual('  lookbackDays 默认 60', DEFAULT_CTA100_MOMENTUM_PARAMS.lookbackDays, 60);
    expectEqual(
      '  skipRecentDays 默认 5',
      DEFAULT_CTA100_MOMENTUM_PARAMS.skipRecentDays,
      5
    );
  }

  // ========== Test 2: strategy_definition 元数据 ==========
  console.log('\nTest 2: strategy_definition 元数据');
  {
    const s = new CTA100MomentumStrategy(new FakeDataSource());
    expectEqual('  strategy_key', s.definition.strategy_key, 'cta100_momentum');
    expectEqual('  enabled', s.definition.enabled, true);
    expectEqual('  category', s.definition.category, 'momentum');
    expectEqual('  risk_level', s.definition.risk_level, 'high');
    assert('  name 非空', s.definition.name.length > 0);
    assert('  description 非空', s.definition.description.length > 0);
    assert('  tags 含 中证1000', (s.definition.tags ?? []).includes('中证1000'));
    assert('  tags 含 动量', (s.definition.tags ?? []).includes('动量'));
  }

  // ========== Test 3: 动量公式正确 ==========
  console.log('\nTest 3: 动量公式 close[T-5] / close[T-60] - 1');
  {
    // length=66: indices 0..65。最新 bar = bars[65]。
    // close[T-5] = bars[65 - 5] = bars[60] = 110
    // close[T-60] = bars[65 - 60] = bars[5] = 100
    // momentum = 110/100 - 1 = 0.10
    const bars = makeBars(66, i => (i < 60 ? 100 : 110));
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['600001'] },
      bars: new Map([['600001', bars]]),
      meta: new Map([['600001', meta('股A', '行业α')]]),
    });
    const s = new CTA100MomentumStrategy(ds);

    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 1', r.eligible_count, 1);
    expectEqual('  signals 1 笔 BUY', r.signals.length, 1);
    const sig = r.signals[0];
    expectEqual('  signal.signal = buy', sig.signal, 'buy');
    expectClose('  momentum ≈ 0.10', sig.momentum, 0.1);
  }

  // ========== Test 4: 入场失败 - 历史不足 ==========
  console.log('\nTest 4: 入场失败 - 历史 bar 数 < lookbackDays + skipRecentDays + 1');
  {
    // 只 50 条，少于 60+5+1=66
    const bars = makeBars(50, () => 100);
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['600001'] },
      bars: new Map([['600001', bars]]),
      meta: new Map([['600001', meta('股A', '行业α')]]),
    });
    const s = new CTA100MomentumStrategy(ds);

    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual(
      '  filtered.fail_insufficient_history = 1',
      r.filtered.fail_insufficient_history,
      1
    );
  }

  // ========== Test 5: 入场失败 - 缺 bars 完全 ==========
  console.log('\nTest 5: 入场失败 - bars Map 不含该 code');
  {
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['600001'] },
      bars: new Map(),
      meta: new Map([['600001', meta('股A', '行业α')]]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual(
      '  filtered.fail_insufficient_history = 1',
      r.filtered.fail_insufficient_history,
      1
    );
  }

  // ========== Test 6: 入场失败 - close 非法 (T-60 = 0) ==========
  console.log('\nTest 6: 入场失败 - close[T-60] = 0 不能算动量');
  {
    const bars = makeBars(66, i => (i === 5 ? 0 : 100));
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['600001'] },
      bars: new Map([['600001', bars]]),
      meta: new Map([['600001', meta('股A', '行业α')]]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  filtered.fail_missing_close = 1', r.filtered.fail_missing_close, 1);
  }

  // ========== Test 7: 入场失败 - ST 名称 ==========
  console.log('\nTest 7: 入场失败 - ST 名称');
  {
    const bars = makeBars(66, i => (i < 60 ? 100 : 110));
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['000099'] },
      bars: new Map([['000099', bars]]),
      meta: new Map([['000099', meta('ST 测试', '其他')]]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  filtered.fail_st = 1', r.filtered.fail_st, 1);
  }

  // ========== Test 8: ST 但 excludeST=false 保留 ==========
  console.log('\nTest 8: ST 但 excludeST=false 保留');
  {
    const bars = makeBars(66, i => (i < 60 ? 100 : 110));
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['000099'] },
      bars: new Map([['000099', bars]]),
      meta: new Map([['000099', meta('ST 测试', '其他')]]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07', { params: { excludeST: false } });
    expectEqual('  eligible_count = 1', r.eligible_count, 1);
    expectEqual('  signal.signal = buy', r.signals[0].signal, 'buy');
    expectEqual('  filtered.fail_st = 0', r.filtered.fail_st, 0);
  }

  // ========== Test 9: 入场失败 - 缺元数据 ==========
  console.log('\nTest 9: 入场失败 - 缺 Stock 元数据');
  {
    const bars = makeBars(66, i => (i < 60 ? 100 : 110));
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['600001'] },
      bars: new Map([['600001', bars]]),
      meta: new Map(), // 完全缺
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  filtered.fail_meta_missing = 1', r.filtered.fail_meta_missing, 1);
  }

  // ========== Test 10: 排序 momentum 降序 ==========
  console.log('\nTest 10: 排序 - momentum 降序');
  {
    // 三只股票，动量分别 0.05 / 0.20 / 0.10
    function barsForReturn(longClose: number, shortClose: number): MomentumBar[] {
      // bars[5] = longClose (close[T-60]); bars[60] = shortClose (close[T-5])
      return makeBars(66, i => {
        if (i < 60) return longClose;
        return shortClose;
      });
    }
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['600001', '600002', '600003'] },
      bars: new Map([
        ['600001', barsForReturn(100, 105)], // momentum 0.05
        ['600002', barsForReturn(100, 120)], // momentum 0.20 (top)
        ['600003', barsForReturn(100, 110)], // momentum 0.10
      ]),
      meta: new Map([
        ['600001', meta('股A', '行业α')],
        ['600002', meta('股B', '行业β')],
        ['600003', meta('股C', '行业γ')],
      ]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07', { params: { topN: 3 } });
    const buys = r.signals.filter(sg => sg.signal === 'buy');
    expectEqual('  buys[0]', buys[0].stock_code, '600002');
    expectEqual('  buys[1]', buys[1].stock_code, '600003');
    expectEqual('  buys[2]', buys[2].stock_code, '600001');
  }

  // ========== Test 11: 排序 - stock_code tie-break ==========
  console.log('\nTest 11: 排序 - momentum 相同时 stock_code 升序');
  {
    function barsForReturn(longClose: number, shortClose: number): MomentumBar[] {
      return makeBars(66, i => (i < 60 ? longClose : shortClose));
    }
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['600003', '600001', '600002'] },
      bars: new Map([
        ['600001', barsForReturn(100, 110)],
        ['600002', barsForReturn(100, 110)],
        ['600003', barsForReturn(100, 110)],
      ]),
      meta: new Map([
        ['600001', meta('股A', '行业α')],
        ['600002', meta('股B', '行业β')],
        ['600003', meta('股C', '行业γ')],
      ]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    const buys = r.signals.filter(sg => sg.signal === 'buy');
    expectEqual(
      '  buys 顺序 = ascending stock_code',
      buys.map(b => b.stock_code),
      ['600001', '600002', '600003']
    );
  }

  // ========== Test 12: 行业中性 cap (maxPerIndustry=3) ==========
  console.log('\nTest 12: 行业中性 - 同行业 5 只候选 cap 至 3');
  {
    function barsForReturn(short: number): MomentumBar[] {
      return makeBars(66, i => (i < 60 ? 100 : short));
    }
    // 5 只全行业A，动量递减
    const ds = new FakeDataSource({
      universe: {
        snapshot_date: '2026-06-01',
        stock_codes: ['600001', '600002', '600003', '600004', '600005'],
      },
      bars: new Map([
        ['600001', barsForReturn(150)], // 0.50
        ['600002', barsForReturn(140)], // 0.40
        ['600003', barsForReturn(130)], // 0.30
        ['600004', barsForReturn(120)], // 0.20
        ['600005', barsForReturn(110)], // 0.10
      ]),
      meta: new Map([
        ['600001', meta('股1', '行业A')],
        ['600002', meta('股2', '行业A')],
        ['600003', meta('股3', '行业A')],
        ['600004', meta('股4', '行业A')],
        ['600005', meta('股5', '行业A')],
      ]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07', {
      params: { topN: 10, industryNeutral: true, maxPerIndustry: 3 },
    });
    const buys = r.signals.filter(sg => sg.signal === 'buy');
    expectEqual('  BUY = 3 (行业 cap)', buys.length, 3);
    expectEqual(
      '  BUY 是动量最大的 3 只',
      buys.map(b => b.stock_code),
      ['600001', '600002', '600003']
    );
    expectEqual('  filtered.industry_capped = 2', r.filtered.industry_capped, 2);
  }

  // ========== Test 13: industryNeutral=false 不做行业限制 ==========
  console.log('\nTest 13: industryNeutral=false - 不做 cap');
  {
    function barsForReturn(short: number): MomentumBar[] {
      return makeBars(66, i => (i < 60 ? 100 : short));
    }
    const ds = new FakeDataSource({
      universe: {
        snapshot_date: '2026-06-01',
        stock_codes: ['600001', '600002', '600003', '600004', '600005'],
      },
      bars: new Map([
        ['600001', barsForReturn(150)],
        ['600002', barsForReturn(140)],
        ['600003', barsForReturn(130)],
        ['600004', barsForReturn(120)],
        ['600005', barsForReturn(110)],
      ]),
      meta: new Map([
        ['600001', meta('股1', '行业A')],
        ['600002', meta('股2', '行业A')],
        ['600003', meta('股3', '行业A')],
        ['600004', meta('股4', '行业A')],
        ['600005', meta('股5', '行业A')],
      ]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07', {
      params: { topN: 10, industryNeutral: false },
    });
    const buys = r.signals.filter(sg => sg.signal === 'buy');
    expectEqual('  BUY = 5 (无 cap)', buys.length, 5);
    expectEqual('  filtered.industry_capped = 0', r.filtered.industry_capped, 0);
  }

  // ========== Test 14: top-N cap ==========
  console.log('\nTest 14: top-N cap (8 候选 / topN=5 → BUY 5)');
  {
    function barsForReturn(short: number): MomentumBar[] {
      return makeBars(66, i => (i < 60 ? 100 : short));
    }
    const codes = ['6000', '6001', '6002', '6003', '6004', '6005', '6006', '6007'].map(p => p.padStart(6, '0'));
    const bars = new Map(codes.map((c, i) => [c, barsForReturn(110 + i * 5)]));
    const metaMap = new Map(codes.map((c, i) => [c, meta(`股${i}`, `行业${i}`)])); // 每个不同行业避免 cap 干扰
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: codes },
      bars,
      meta: metaMap,
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07', { params: { topN: 5 } });
    expectEqual('  eligible_count = 8', r.eligible_count, 8);
    expectEqual('  BUY = 5 (top-N cap)', r.signals.filter(sg => sg.signal === 'buy').length, 5);
  }

  // ========== Test 15: 首次开仓 - 全为 BUY ==========
  console.log('\nTest 15: 首次开仓 (无 previousSelection) - 全为 BUY，无 HOLD/SELL');
  {
    function barsForReturn(short: number): MomentumBar[] {
      return makeBars(66, i => (i < 60 ? 100 : short));
    }
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['600001', '600002'] },
      bars: new Map([
        ['600001', barsForReturn(120)],
        ['600002', barsForReturn(110)],
      ]),
      meta: new Map([
        ['600001', meta('股A', '行业α')],
        ['600002', meta('股B', '行业β')],
      ]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    expectEqual('  BUY = 2', r.signals.filter(sg => sg.signal === 'buy').length, 2);
    expectEqual('  HOLD = 0', r.signals.filter(sg => sg.signal === 'hold').length, 0);
    expectEqual('  SELL = 0', r.signals.filter(sg => sg.signal === 'sell').length, 0);
  }

  // ========== Test 16: BUY/HOLD/SELL 增量 ==========
  console.log('\nTest 16: BUY/HOLD/SELL 增量');
  {
    function barsForReturn(short: number): MomentumBar[] {
      return makeBars(66, i => (i < 60 ? 100 : short));
    }
    const ds = new FakeDataSource({
      universe: {
        snapshot_date: '2026-06-01',
        stock_codes: ['600001', '600002', '600003'],
      },
      bars: new Map([
        ['600001', barsForReturn(120)], // 0.20 → target
        ['600002', barsForReturn(115)], // 0.15 → target
        ['600003', barsForReturn(110)], // 0.10 → target
      ]),
      meta: new Map([
        ['600001', meta('股A', '行业α')],
        ['600002', meta('股B', '行业β')],
        ['600003', meta('股C', '行业γ')],
      ]),
    });
    const s = new CTA100MomentumStrategy(ds);
    // 之前持有 600002 (HOLD) + 600099 (SELL — 跌出 target)
    const r = await s.generateSignals('2026-06-07', {
      params: { topN: 3 },
      previousSelection: ['600002', '600099'],
    });
    const buyCodes = r.signals
      .filter(sg => sg.signal === 'buy')
      .map(sg => sg.stock_code)
      .sort();
    const holdCodes = r.signals
      .filter(sg => sg.signal === 'hold')
      .map(sg => sg.stock_code)
      .sort();
    const sellCodes = r.signals
      .filter(sg => sg.signal === 'sell')
      .map(sg => sg.stock_code)
      .sort();
    expectEqual('  BUY = [600001, 600003]', buyCodes, ['600001', '600003']);
    expectEqual('  HOLD = [600002]', holdCodes, ['600002']);
    expectEqual('  SELL = [600099]', sellCodes, ['600099']);
  }

  // ========== Test 17: evaluate() 信息性 hold ==========
  console.log('\nTest 17: evaluate() 信息性 hold + factors.note');
  {
    const s = new CTA100MomentumStrategy(new FakeDataSource());
    const ctx = {
      stock_id: 1,
      symbol: '600519.SH',
      name: '贵州茅台',
      industry: '白酒',
      bars: [{ time: new Date(), open: 1, high: 1, low: 1, close: 1800, volume: 1 }],
      factor_snapshot: {},
    } as any;
    const r = s.evaluate(ctx);
    expectEqual('  signal = hold', r.signal, 'hold');
    expectEqual('  factors.note', (r.factors as any).note, 'use_generateSignals_instead');
    expectEqual('  entry_price', r.entry_price, 1800);
  }

  // ========== Test 18: helper isSTName 边角 ==========
  console.log('\nTest 18: helper isSTName 边角');
  {
    assert('  null 非 ST', !isSTName(null));
    assert('  empty 非 ST', !isSTName(''));
    assert('  贵州茅台 非 ST', !isSTName('贵州茅台'));
    assert('  ST华信 是 ST', isSTName('ST华信'));
    assert('  *ST天夏 是 ST', isSTName('*ST天夏'));
    assert('  S*ST石岘 是 ST', isSTName('S*ST石岘'));
    assert('  S 石化 (空格 + S) 是 ST', isSTName('S 石化'));
    assert('  SAMSUNG 不是 ST', !isSTName('SAMSUNG'));
  }

  // ========== Test 19: invalid trade_date 抛出 ==========
  console.log('\nTest 19: invalid trade_date 抛出');
  {
    const s = new CTA100MomentumStrategy(new FakeDataSource());
    try {
      await s.generateSignals('2026/06/07');
      assert('  应当抛错', false);
    } catch (e) {
      assert('  invalid trade_date 抛错', (e as Error).message.includes('invalid trade_date'));
    }
  }

  // ========== Test 20: 空 universe 安全 ==========
  console.log('\nTest 20: 空 universe (sync 未跑) → 空返回');
  {
    const ds = new FakeDataSource({
      universe: { snapshot_date: null, stock_codes: [] },
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  signals 空', r.signals.length, 0);
    expectEqual('  target_portfolio 空', r.target_portfolio.length, 0);
    expectEqual('  filtered.universe_size = 0', r.filtered.universe_size, 0);
  }

  // ========== Test 21: 自定义 indexCode override ==========
  console.log('\nTest 21: 自定义 indexCode override');
  {
    // 用一个 spy DataSource 验证 indexCode 透传
    let receivedIndex = '';
    const ds: CTA100MomentumDataSource = {
      async loadIndexUniverse(_d, indexCode) {
        receivedIndex = indexCode;
        return { snapshot_date: null, stock_codes: [] };
      },
      async loadMomentumBars() {
        return new Map();
      },
      async loadStockMeta() {
        return new Map();
      },
    };
    const s = new CTA100MomentumStrategy(ds);
    await s.generateSignals('2026-06-07', { params: { indexCode: '000300' } });
    expectEqual('  loadIndexUniverse 收到 000300', receivedIndex, '000300');
  }

  // ========== Test 22: lookbackDays ≤ skipRecentDays 抛出 ==========
  console.log('\nTest 22: lookbackDays ≤ skipRecentDays 抛出');
  {
    const s = new CTA100MomentumStrategy(new FakeDataSource());
    try {
      await s.generateSignals('2026-06-07', {
        params: { lookbackDays: 5, skipRecentDays: 5 },
      });
      assert('  应当抛错', false);
    } catch (e) {
      assert(
        '  lookbackDays/skipRecentDays 关系抛错',
        (e as Error).message.includes('lookbackDays')
      );
    }
  }

  // ========== Test 23: target_portfolio 顺序 ==========
  console.log('\nTest 23: target_portfolio 与 BUY+HOLD 顺序一致');
  {
    function barsForReturn(short: number): MomentumBar[] {
      return makeBars(66, i => (i < 60 ? 100 : short));
    }
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['600001', '600002'] },
      bars: new Map([
        ['600001', barsForReturn(120)],
        ['600002', barsForReturn(110)],
      ]),
      meta: new Map([
        ['600001', meta('股A', '行业α')],
        ['600002', meta('股B', '行业β')],
      ]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    expectEqual(
      '  target_portfolio = [600001, 600002]',
      r.target_portfolio,
      ['600001', '600002']
    );
  }

  // ========== Test 24: 缺当日 close 不抛 - 单独覆盖 ==========
  console.log('\nTest 24: closeShort = NaN 时 fail_missing_close');
  {
    // 让 bars[60] = NaN
    const bars = makeBars(66, i => (i === 60 ? NaN : 100));
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['600001'] },
      bars: new Map([['600001', bars]]),
      meta: new Map([['600001', meta('股A', '行业α')]]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  filtered.fail_missing_close = 1', r.filtered.fail_missing_close, 1);
  }

  // ========== Test 25: 边界 - 历史恰好 = lookbackDays + skipRecentDays + 1 ==========
  console.log('\nTest 25: 边界 - 历史恰等于 lookbackDays + skipRecentDays + 1');
  {
    // 66 条 = 60 + 5 + 1，最低门槛刚好满足
    const bars = makeBars(66, i => (i < 60 ? 100 : 110));
    const ds = new FakeDataSource({
      universe: { snapshot_date: '2026-06-01', stock_codes: ['600001'] },
      bars: new Map([['600001', bars]]),
      meta: new Map([['600001', meta('股A', '行业α')]]),
    });
    const s = new CTA100MomentumStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 1 (边界恰好通过)', r.eligible_count, 1);
  }

  // ========== 收尾 ==========
  console.log('\n========================================');
  if (failed === 0) {
    console.log(`✓ All tests passed`);
    process.exit(0);
  } else {
    console.log(`✗ ${failed} assertion(s) FAILED`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
