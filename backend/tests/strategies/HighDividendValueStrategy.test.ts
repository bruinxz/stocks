/**
 * HighDividendValueStrategy 单测（US-022）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/HighDividendValueStrategy.test.ts
 *
 * 测试用 FakeDataSource 注入到 HighDividendValueStrategy(constructor)，避免任何 DB 依赖。
 *
 * 覆盖：
 *   - 默认参数 (topN=30, lookbackYears=3, minAvgDividendYield=4, maxPE=15, minROE=10,
 *     minTotalMarketCap=200亿, excludeST=true, industryNeutral=false, maxPerIndustry=5)
 *   - strategy_definition 元数据 (category=multi_factor, risk_level=low, tags 含 价值/股息)
 *   - 入场 4 维 AND：股息率 + PE + ROE + 市值 同时满足才入选
 *   - 各维度独立失败：股息率不足 / PE 太高 / PE 负值 / ROE 不足 / 市值不足 / ST
 *   - 调仓日判定：非调仓日返回 hold-only + signals=[] + target=previousSelection
 *   - 调仓日 forceRebalance=true 强制触发
 *   - 排序：股息率降序 → PE 升序 → stock_code 稳定 tie-break
 *   - topN cap
 *   - industryNeutral=true 的 maxPerIndustry cap
 *   - BUY/SELL/HOLD 增量：首次开仓全 BUY / 部分覆盖 BUY+HOLD+SELL / 完全不变全 HOLD
 *   - evaluate() 信息性 hold + factors.note
 *   - helper isSTName 边角
 *   - invalid trade_date 抛出
 *   - 空 universe 安全
 *   - 自定义 params override
 *   - total_market_cap 走 valuation 优先，缺则走 stock meta 兜底
 *   - PE = 0 / 负值剔除
 *   - ROE 缺失剔除
 */

import {
  DEFAULT_HIGH_DIVIDEND_VALUE_PARAMS,
  HighDividendValueDataSource,
  HighDividendValueStockMeta,
  HighDividendValueStrategy,
  HighDividendValuationSnap,
  isSTName,
} from '../../src/quant/strategies/HighDividendValueStrategy';

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
  universe?: string[];
  avgYield?: Map<string, number>;
  valuation?: Map<string, HighDividendValuationSnap>;
  roe?: Map<string, number>;
  meta?: Map<string, HighDividendValueStockMeta>;
  dailyClose?: Map<string, number>;
  /** 默认 true（测试默认走调仓日；非调仓日的测试单独设置 false） */
  isRebalanceDay?: boolean;
}

class FakeDataSource implements HighDividendValueDataSource {
  constructor(public state: FakeFixtures = {}) {}

  async loadCandidateUniverse(_asOfDate: string): Promise<string[]> {
    return this.state.universe ?? [];
  }

  async loadAvgDividendYield(
    _asOfDate: string,
    _lookbackYears: number,
    stockCodes: string[]
  ): Promise<Map<string, number>> {
    const all = this.state.avgYield ?? new Map();
    const out = new Map<string, number>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }

  async loadValuationSnapshot(
    _asOfDate: string,
    stockCodes: string[]
  ): Promise<Map<string, HighDividendValuationSnap>> {
    const all = this.state.valuation ?? new Map();
    const out = new Map<string, HighDividendValuationSnap>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }

  async loadRoe5yAvg(
    _asOfDate: string,
    stockCodes: string[]
  ): Promise<Map<string, number>> {
    const all = this.state.roe ?? new Map();
    const out = new Map<string, number>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }

  async loadStockMeta(
    stockCodes: string[]
  ): Promise<Map<string, HighDividendValueStockMeta>> {
    const all = this.state.meta ?? new Map();
    const out = new Map<string, HighDividendValueStockMeta>();
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

  async isFirstTradingDayOfQuarter(_tradeDate: string): Promise<boolean> {
    // 默认 true 让大多数测试走调仓路径；明确测试非调仓日的用 false
    return this.state.isRebalanceDay !== false;
  }
}

/** 帮助：构造"四维全过"的完美样本 */
function buildPassingSample(code = '600519'): FakeFixtures {
  return {
    universe: [code],
    avgYield: new Map([[code, 5.0]]),
    valuation: new Map([[code, { pe_ttm: 10, total_market_cap: 5000e8 }]]),
    roe: new Map([[code, 15.0]]),
    meta: new Map([[code, { name: '贵州茅台', industry: '食品饮料' }]]),
    dailyClose: new Map([[code, 1700]]),
  };
}

// ----------------------------------------------------------------
// 测试用例
// ----------------------------------------------------------------

async function test_default_params_match_AC() {
  const def = DEFAULT_HIGH_DIVIDEND_VALUE_PARAMS;
  expectEqual('default topN', def.topN, 30);
  expectEqual('default lookbackYears', def.lookbackYears, 3);
  expectEqual('default minAvgDividendYield', def.minAvgDividendYield, 4);
  expectEqual('default maxPE', def.maxPE, 15);
  expectEqual('default minROE', def.minROE, 10);
  expectEqual('default minTotalMarketCap', def.minTotalMarketCap, 200 * 1e8);
  expectEqual('default excludeST', def.excludeST, true);
  expectEqual('default industryNeutral', def.industryNeutral, false);
  expectEqual('default maxPerIndustry', def.maxPerIndustry, 5);
  expectEqual('default rebalancePeriod', def.rebalancePeriod, 'quarterly');
}

async function test_strategy_definition_metadata() {
  const s = new HighDividendValueStrategy(new FakeDataSource());
  expectEqual('strategy_key', s.definition.strategy_key, 'high_dividend_value');
  expectEqual('category', s.definition.category, 'multi_factor');
  expectEqual('risk_level', s.definition.risk_level, 'low');
  expectEqual('enabled', s.definition.enabled, true);
  assert('tags 包含 价值', s.definition.tags.includes('价值'));
  assert('tags 包含 股息', s.definition.tags.includes('股息'));
  assert('tags 包含 长线', s.definition.tags.includes('长线'));
}

async function test_entry_full_pass_4_dimensions() {
  const ds = new FakeDataSource(buildPassingSample());
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('is_rebalance_day', r.is_rebalance_day, true);
  expectEqual('eligible_count', r.eligible_count, 1);
  const buys = r.signals.filter(x => x.signal === 'buy');
  expectEqual('1 buy', buys.length, 1);
  expectEqual('buy stock_code', buys[0].stock_code, '600519');
  expectEqual('buy.pe_ttm', buys[0].pe_ttm, 10);
  expectEqual('buy.roe_5y_avg', buys[0].roe_5y_avg, 15.0);
  expectEqual('buy.avg_dividend_yield_pct', buys[0].avg_dividend_yield_pct, 5.0);
  expectEqual('buy.total_market_cap', buys[0].total_market_cap, 5000e8);
  expectEqual('buy.reference_price', buys[0].reference_price, 1700);
  expectEqual('target_portfolio', r.target_portfolio, ['600519']);
}

async function test_entry_fail_dividend_too_low() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    avgYield: new Map([['600519', 3.0]]), // < 4%
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('fail_dividend=1', r.filtered.fail_dividend, 1);
}

async function test_entry_fail_dividend_missing() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    avgYield: new Map(), // empty
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('fail_dividend=1 (missing)', r.filtered.fail_dividend, 1);
}

async function test_entry_fail_dividend_boundary() {
  // 边界：恰好 4% 应入选
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    avgYield: new Map([['600519', 4.0]]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('exactly 4% passes', r.eligible_count, 1);
}

async function test_entry_fail_pe_too_high() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    valuation: new Map([['600519', { pe_ttm: 20, total_market_cap: 5000e8 }]]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('fail_pe=1', r.filtered.fail_pe, 1);
}

async function test_entry_fail_pe_zero() {
  // PE = 0 (异常) → 剔除
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    valuation: new Map([['600519', { pe_ttm: 0, total_market_cap: 5000e8 }]]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('PE=0 剔除', r.filtered.fail_pe, 1);
}

async function test_entry_fail_pe_negative() {
  // 亏损股 PE 负数 → 剔除
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    valuation: new Map([['600519', { pe_ttm: -5, total_market_cap: 5000e8 }]]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('PE 负数剔除', r.filtered.fail_pe, 1);
}

async function test_entry_fail_pe_missing() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    valuation: new Map(), // 缺数据
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('PE 缺数据剔除', r.filtered.fail_pe, 1);
}

async function test_entry_fail_pe_boundary() {
  // 边界：PE = 15 恰好 (≤ 15 应入选)
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    valuation: new Map([['600519', { pe_ttm: 15, total_market_cap: 5000e8 }]]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('PE=15 恰好入选', r.eligible_count, 1);
}

async function test_entry_fail_roe_too_low() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    roe: new Map([['600519', 5.0]]), // < 10
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('fail_roe=1', r.filtered.fail_roe, 1);
}

async function test_entry_fail_roe_missing() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    roe: new Map(),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('ROE 缺数据剔除', r.filtered.fail_roe, 1);
}

async function test_entry_fail_roe_boundary() {
  // 边界：ROE = 10 恰好入选
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    roe: new Map([['600519', 10.0]]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('ROE=10 恰好入选', r.eligible_count, 1);
}

async function test_entry_fail_market_cap_too_small() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    valuation: new Map([['600519', { pe_ttm: 10, total_market_cap: 100e8 }]]), // 100亿 < 200亿
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('fail_market_cap=1', r.filtered.fail_market_cap, 1);
}

async function test_entry_market_cap_fallback_to_stock_meta() {
  // valuation.total_market_cap = null → 走 meta 兜底
  const ds = new FakeDataSource({
    universe: ['600519'],
    avgYield: new Map([['600519', 5.0]]),
    valuation: new Map([['600519', { pe_ttm: 10, total_market_cap: null }]]),
    roe: new Map([['600519', 15.0]]),
    meta: new Map([
      ['600519', { name: '茅台', industry: '食品饮料', total_market_cap: 5000e8 }],
    ]),
    dailyClose: new Map([['600519', 1700]]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('mcap 兜底入选', r.eligible_count, 1);
  expectEqual('buy.total_market_cap from meta', r.signals[0].total_market_cap, 5000e8);
}

async function test_entry_fail_st_excluded() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    meta: new Map([['600519', { name: 'ST 茅台', industry: '食品饮料' }]]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('ST 剔除', r.filtered.fail_st, 1);
  expectEqual('no eligible', r.eligible_count, 0);
}

async function test_entry_st_kept_when_excludeST_false() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    meta: new Map([['600519', { name: 'ST 茅台', industry: '食品饮料' }]]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02', {
    params: { excludeST: false },
  });
  expectEqual('excludeST=false 保留 ST', r.eligible_count, 1);
}

async function test_non_rebalance_day_returns_hold_only() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    isRebalanceDay: false,
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-02-15', {
    previousSelection: ['600519', '600036'],
  });
  expectEqual('is_rebalance_day=false', r.is_rebalance_day, false);
  expectEqual('signals 空数组', r.signals.length, 0);
  expectEqual('target 保持 previousSelection', r.target_portfolio, ['600519', '600036']);
  expectEqual('eligible_count=0 (skipped)', r.eligible_count, 0);
}

async function test_force_rebalance_overrides_calendar() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    isRebalanceDay: false, // 模拟非调仓日
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-02-15', {
    forceRebalance: true,
  });
  expectEqual('forceRebalance=true 触发调仓', r.is_rebalance_day, true);
  expectEqual('eligible=1', r.eligible_count, 1);
}

async function test_sort_by_dividend_yield_desc() {
  // 3 只股票：股息率 5/7/6 → 排序后 7/6/5
  const sample = (code: string, y: number, pe = 10): FakeFixtures => ({
    universe: [code],
    avgYield: new Map([[code, y]]),
    valuation: new Map([[code, { pe_ttm: pe, total_market_cap: 5000e8 }]]),
    roe: new Map([[code, 15]]),
    meta: new Map([[code, { name: code }]]),
    dailyClose: new Map([[code, 100]]),
  });
  const ds = new FakeDataSource({
    universe: ['600001', '600002', '600003'],
    avgYield: new Map([
      ['600001', 5],
      ['600002', 7],
      ['600003', 6],
    ]),
    valuation: new Map([
      ['600001', { pe_ttm: 10, total_market_cap: 5000e8 }],
      ['600002', { pe_ttm: 10, total_market_cap: 5000e8 }],
      ['600003', { pe_ttm: 10, total_market_cap: 5000e8 }],
    ]),
    roe: new Map([
      ['600001', 15],
      ['600002', 15],
      ['600003', 15],
    ]),
    meta: new Map([
      ['600001', { name: 'A' }],
      ['600002', { name: 'B' }],
      ['600003', { name: 'C' }],
    ]),
    dailyClose: new Map([
      ['600001', 10],
      ['600002', 10],
      ['600003', 10],
    ]),
  });
  void sample;
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('eligible=3', r.eligible_count, 3);
  expectEqual('target order', r.target_portfolio, ['600002', '600003', '600001']);
}

async function test_sort_tie_break_by_pe_asc() {
  // 股息率相同 → PE 升序（更便宜的优先）
  const ds = new FakeDataSource({
    universe: ['600001', '600002', '600003'],
    avgYield: new Map([
      ['600001', 6],
      ['600002', 6],
      ['600003', 6],
    ]),
    valuation: new Map([
      ['600001', { pe_ttm: 12, total_market_cap: 5000e8 }],
      ['600002', { pe_ttm: 8, total_market_cap: 5000e8 }],
      ['600003', { pe_ttm: 10, total_market_cap: 5000e8 }],
    ]),
    roe: new Map([
      ['600001', 15],
      ['600002', 15],
      ['600003', 15],
    ]),
    meta: new Map([
      ['600001', { name: 'A' }],
      ['600002', { name: 'B' }],
      ['600003', { name: 'C' }],
    ]),
    dailyClose: new Map([
      ['600001', 10],
      ['600002', 10],
      ['600003', 10],
    ]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('PE 升序排列', r.target_portfolio, ['600002', '600003', '600001']);
}

async function test_sort_tie_break_stable_by_stock_code() {
  // 股息率 + PE 都相同 → stock_code 升序稳定 tie-break
  const ds = new FakeDataSource({
    universe: ['600003', '600001', '600002'],
    avgYield: new Map([
      ['600001', 6],
      ['600002', 6],
      ['600003', 6],
    ]),
    valuation: new Map([
      ['600001', { pe_ttm: 10, total_market_cap: 5000e8 }],
      ['600002', { pe_ttm: 10, total_market_cap: 5000e8 }],
      ['600003', { pe_ttm: 10, total_market_cap: 5000e8 }],
    ]),
    roe: new Map([
      ['600001', 15],
      ['600002', 15],
      ['600003', 15],
    ]),
    meta: new Map([
      ['600001', { name: 'A' }],
      ['600002', { name: 'B' }],
      ['600003', { name: 'C' }],
    ]),
    dailyClose: new Map([
      ['600001', 10],
      ['600002', 10],
      ['600003', 10],
    ]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('stock_code 稳定 tie-break', r.target_portfolio, ['600001', '600002', '600003']);
}

async function test_topN_cap() {
  // 5 个候选，topN=3 → 只取前 3
  const universe = ['600001', '600002', '600003', '600004', '600005'];
  const avgYield = new Map<string, number>();
  const valuation = new Map<string, HighDividendValuationSnap>();
  const roe = new Map<string, number>();
  const meta = new Map<string, HighDividendValueStockMeta>();
  const dailyClose = new Map<string, number>();
  universe.forEach((code, i) => {
    avgYield.set(code, 5 + i); // 5,6,7,8,9 → top 9,8,7,6,5
    valuation.set(code, { pe_ttm: 10, total_market_cap: 5000e8 });
    roe.set(code, 15);
    meta.set(code, { name: code });
    dailyClose.set(code, 10);
  });
  const ds = new FakeDataSource({ universe, avgYield, valuation, roe, meta, dailyClose });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02', {
    params: { topN: 3 },
  });
  expectEqual('eligible=5', r.eligible_count, 5);
  expectEqual('target=3 (topN cap)', r.target_portfolio.length, 3);
  expectEqual('target = 高股息前 3', r.target_portfolio, ['600005', '600004', '600003']);
}

async function test_industry_neutral_cap() {
  // 6 个候选分布在 2 个行业；industryNeutral=true, maxPerIndustry=2 → 每行业 ≤ 2
  const universe = ['600001', '600002', '600003', '600101', '600102', '600103'];
  const avgYield = new Map<string, number>();
  const valuation = new Map<string, HighDividendValuationSnap>();
  const roe = new Map<string, number>();
  const meta = new Map<string, HighDividendValueStockMeta>();
  const dailyClose = new Map<string, number>();
  // 高到低: 600001(银行 10), 600002(银行 9), 600003(银行 8), 600101(白酒 7), 600102(白酒 6), 600103(白酒 5)
  universe.forEach((code, i) => {
    avgYield.set(code, 10 - i);
    valuation.set(code, { pe_ttm: 10, total_market_cap: 5000e8 });
    roe.set(code, 15);
    meta.set(code, {
      name: code,
      industry: code.startsWith('6000') ? '银行' : '白酒',
    });
    dailyClose.set(code, 10);
  });
  const ds = new FakeDataSource({ universe, avgYield, valuation, roe, meta, dailyClose });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02', {
    params: { topN: 6, industryNeutral: true, maxPerIndustry: 2 },
  });
  // 期望 ['600001'(银行), '600002'(银行), '600101'(白酒), '600102'(白酒)] = 4 个
  // 600003 (银行 第 3 只) + 600103 (白酒 第 3 只) 被 industry cap 剔除
  expectEqual('industry cap 后 target = 4', r.target_portfolio.length, 4);
  expectEqual('target = 每行业 2 只', r.target_portfolio, [
    '600001',
    '600002',
    '600101',
    '600102',
  ]);
}

async function test_first_open_all_buy() {
  // previousSelection 空 → 全 BUY
  const ds = new FakeDataSource({
    universe: ['600001', '600002'],
    avgYield: new Map([
      ['600001', 5],
      ['600002', 6],
    ]),
    valuation: new Map([
      ['600001', { pe_ttm: 10, total_market_cap: 5000e8 }],
      ['600002', { pe_ttm: 10, total_market_cap: 5000e8 }],
    ]),
    roe: new Map([
      ['600001', 15],
      ['600002', 15],
    ]),
    meta: new Map([
      ['600001', { name: 'A' }],
      ['600002', { name: 'B' }],
    ]),
    dailyClose: new Map([
      ['600001', 10],
      ['600002', 10],
    ]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  const buys = r.signals.filter(s => s.signal === 'buy');
  const sells = r.signals.filter(s => s.signal === 'sell');
  const holds = r.signals.filter(s => s.signal === 'hold');
  expectEqual('全 BUY', buys.length, 2);
  expectEqual('0 SELL', sells.length, 0);
  expectEqual('0 HOLD', holds.length, 0);
}

async function test_partial_overlap_buy_hold_sell() {
  // previousSelection = [A, X]，target = [A, B] → A=HOLD, B=BUY, X=SELL
  const ds = new FakeDataSource({
    universe: ['600A00', '600B00'],
    avgYield: new Map([
      ['600A00', 7],
      ['600B00', 5],
    ]),
    valuation: new Map([
      ['600A00', { pe_ttm: 10, total_market_cap: 5000e8 }],
      ['600B00', { pe_ttm: 10, total_market_cap: 5000e8 }],
    ]),
    roe: new Map([
      ['600A00', 15],
      ['600B00', 15],
    ]),
    meta: new Map([
      ['600A00', { name: 'A' }],
      ['600B00', { name: 'B' }],
    ]),
    dailyClose: new Map([
      ['600A00', 10],
      ['600B00', 10],
    ]),
  });
  // 600A00 → 排序在 600B00 前
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02', {
    previousSelection: ['600A00', '600X00'], // 600X00 不在 universe
  });
  const buys = r.signals.filter(s => s.signal === 'buy').map(s => s.stock_code);
  const sells = r.signals.filter(s => s.signal === 'sell').map(s => s.stock_code);
  const holds = r.signals.filter(s => s.signal === 'hold').map(s => s.stock_code);
  expectEqual('BUY 新进 = [600B00]', buys, ['600B00']);
  expectEqual('SELL 剔除 = [600X00]', sells, ['600X00']);
  expectEqual('HOLD 保留 = [600A00]', holds, ['600A00']);
  expectEqual('target = [600A00, 600B00]', r.target_portfolio, ['600A00', '600B00']);
}

async function test_unchanged_portfolio_all_hold() {
  // previousSelection 完全等同 target → 全 HOLD，无 BUY/SELL
  const ds = new FakeDataSource(buildPassingSample());
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02', {
    previousSelection: ['600519'],
  });
  const buys = r.signals.filter(s => s.signal === 'buy');
  const sells = r.signals.filter(s => s.signal === 'sell');
  const holds = r.signals.filter(s => s.signal === 'hold');
  expectEqual('0 BUY', buys.length, 0);
  expectEqual('0 SELL', sells.length, 0);
  expectEqual('1 HOLD', holds.length, 1);
  expectEqual('HOLD = 600519', holds[0].stock_code, '600519');
}

async function test_evaluate_returns_info_hold() {
  const s = new HighDividendValueStrategy(new FakeDataSource());
  const result = s.evaluate({
    stock_id: 1,
    symbol: '600519.SH',
    name: '贵州茅台',
    bars: [],
  } as any);
  expectEqual('evaluate.signal=hold', result.signal, 'hold');
  expectEqual('evaluate.score=0', result.score, 0);
  assert('evaluate.reasons 提示 generateSignals', result.reasons[0].includes('generateSignals'));
  expectEqual('evaluate.factors.note', result.factors.note, 'use_generateSignals_instead');
}

async function test_helper_isSTName() {
  expectEqual('isSTName(undefined)', isSTName(undefined), false);
  expectEqual('isSTName("")', isSTName(''), false);
  expectEqual('isSTName("茅台")', isSTName('茅台'), false);
  expectEqual('isSTName("ST 茅台")', isSTName('ST 茅台'), true);
  expectEqual('isSTName("ST茅台")', isSTName('ST茅台'), true);
  expectEqual('isSTName("*ST 茅台")', isSTName('*ST 茅台'), true);
  expectEqual('isSTName("st茅台")', isSTName('st茅台'), true);
  expectEqual('isSTName("S 茅台")', isSTName('S 茅台'), true);
}

async function test_invalid_trade_date_throws() {
  const s = new HighDividendValueStrategy(new FakeDataSource());
  let threw = false;
  try {
    await s.generateSignals('not-a-date');
  } catch (_) {
    threw = true;
  }
  assert('invalid trade_date 抛出', threw);

  let threw2 = false;
  try {
    await s.generateSignals('2025/01/02'); // 错误分隔符
  } catch (_) {
    threw2 = true;
  }
  assert('错误分隔符抛出', threw2);
}

async function test_empty_universe_safe() {
  const ds = new FakeDataSource({ universe: [] });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('empty universe eligible=0', r.eligible_count, 0);
  expectEqual('signals 空数组', r.signals.length, 0);
  expectEqual('target 空数组', r.target_portfolio.length, 0);
  expectEqual('universe_size=0', r.filtered.universe_size, 0);
}

async function test_custom_params_override() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    avgYield: new Map([['600519', 3.5]]), // 3.5% — 默认 4% 不通过
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02', {
    params: { minAvgDividendYield: 3.0 }, // 放宽到 3% → 应该通过
  });
  expectEqual('放宽后入选', r.eligible_count, 1);
  expectEqual('params.minAvgDividendYield=3', r.params.minAvgDividendYield, 3);
  expectEqual('其他参数 default', r.params.maxPE, 15);
}

async function test_mixed_pass_fail_some_dimensions() {
  // 3 只股票：A 全通过；B PE 太高；C 股息率不足
  const ds = new FakeDataSource({
    universe: ['600A', '600B', '600C'],
    avgYield: new Map([
      ['600A', 5],
      ['600B', 5],
      ['600C', 3], // < 4
    ]),
    valuation: new Map([
      ['600A', { pe_ttm: 10, total_market_cap: 5000e8 }],
      ['600B', { pe_ttm: 25, total_market_cap: 5000e8 }], // > 15
      ['600C', { pe_ttm: 10, total_market_cap: 5000e8 }],
    ]),
    roe: new Map([
      ['600A', 15],
      ['600B', 15],
      ['600C', 15],
    ]),
    meta: new Map([
      ['600A', { name: 'A' }],
      ['600B', { name: 'B' }],
      ['600C', { name: 'C' }],
    ]),
    dailyClose: new Map([
      ['600A', 10],
      ['600B', 10],
      ['600C', 10],
    ]),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('只 A 入选', r.eligible_count, 1);
  expectEqual('target = [600A]', r.target_portfolio, ['600A']);
  expectEqual('fail_pe=1', r.filtered.fail_pe, 1);
  expectEqual('fail_dividend=1', r.filtered.fail_dividend, 1);
}

async function test_st_excluded_before_other_filters() {
  // ST 比其他 4 维更便宜地过滤掉（最优化：避免对 ST 拉 PE/ROE/股息率数据）
  // 设置 ST 股各维度都缺数据 — 仍应进入 fail_st，不应被记为 fail_dividend
  const ds = new FakeDataSource({
    universe: ['600ST'],
    avgYield: new Map(), // 缺
    valuation: new Map(),
    roe: new Map(),
    meta: new Map([['600ST', { name: 'ST 闹剧' }]]),
    dailyClose: new Map(),
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('fail_st=1', r.filtered.fail_st, 1);
  // 注意：实际实现中 ST 在最前面过滤，所以股息率缺失不会被计入 fail_dividend
  expectEqual('fail_dividend=0 (被 ST 提前剔除)', r.filtered.fail_dividend, 0);
}

async function test_universe_size_records_total() {
  const ds = new FakeDataSource({
    universe: ['600001', '600002', '600003'],
    // 所有股都缺数据 → 全部 fail_dividend
  });
  const r = await new HighDividendValueStrategy(ds).generateSignals('2025-01-02');
  expectEqual('universe_size=3', r.filtered.universe_size, 3);
  expectEqual('fail_dividend=3', r.filtered.fail_dividend, 3);
}

// ----------------------------------------------------------------
// Runner
// ----------------------------------------------------------------

async function main() {
  const tests = [
    test_default_params_match_AC,
    test_strategy_definition_metadata,
    test_entry_full_pass_4_dimensions,
    test_entry_fail_dividend_too_low,
    test_entry_fail_dividend_missing,
    test_entry_fail_dividend_boundary,
    test_entry_fail_pe_too_high,
    test_entry_fail_pe_zero,
    test_entry_fail_pe_negative,
    test_entry_fail_pe_missing,
    test_entry_fail_pe_boundary,
    test_entry_fail_roe_too_low,
    test_entry_fail_roe_missing,
    test_entry_fail_roe_boundary,
    test_entry_fail_market_cap_too_small,
    test_entry_market_cap_fallback_to_stock_meta,
    test_entry_fail_st_excluded,
    test_entry_st_kept_when_excludeST_false,
    test_non_rebalance_day_returns_hold_only,
    test_force_rebalance_overrides_calendar,
    test_sort_by_dividend_yield_desc,
    test_sort_tie_break_by_pe_asc,
    test_sort_tie_break_stable_by_stock_code,
    test_topN_cap,
    test_industry_neutral_cap,
    test_first_open_all_buy,
    test_partial_overlap_buy_hold_sell,
    test_unchanged_portfolio_all_hold,
    test_evaluate_returns_info_hold,
    test_helper_isSTName,
    test_invalid_trade_date_throws,
    test_empty_universe_safe,
    test_custom_params_override,
    test_mixed_pass_fail_some_dimensions,
    test_st_excluded_before_other_filters,
    test_universe_size_records_total,
  ];
  for (const t of tests) {
    console.log(`\n=== ${t.name} ===`);
    try {
      await t();
    } catch (e) {
      failed += 1;
      console.error(`  EXCEPTION ${(e as Error).message}`);
    }
  }
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
