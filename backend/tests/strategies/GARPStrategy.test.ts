/**
 * GARPStrategy 单测（US-024）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/GARPStrategy.test.ts
 *
 * 测试用 FakeDataSource 注入到 GARPStrategy(constructor)，避免任何 DB 依赖。
 *
 * 覆盖：
 *   - 默认参数 (AC 指定 10 项)
 *   - strategy_definition 元数据 (category=multi_factor, risk_level=medium, tags 含 价值/成长/GARP/PEG)
 *   - 入场 4 维 AND：连续 N 年增长 + PEG + ROE + 资产负债率
 *   - 各维度独立失败：增长不足 / 增长不连续 / 增长数据不足 / PE 缺 / PE 负 / PEG 超标 / ROE 不足 / ROE 缺 / debt 超标 / debt 缺 / ST
 *   - 调仓日判定：非调仓日返回 hold-only + signals=[] + target=previousSelection
 *   - 调仓日 forceRebalance=true 强制触发
 *   - 排序：净利润 yoy 降序 → PEG 升序 → stock_code 稳定 tie-break
 *   - topN cap
 *   - industryNeutral=true 的 maxPerIndustry cap
 *   - BUY/SELL/HOLD 增量：首次开仓全 BUY / 部分覆盖 BUY+HOLD+SELL / 完全不变全 HOLD
 *   - evaluate() 信息性 hold + factors.note
 *   - helper isSTName 边角
 *   - invalid trade_date 抛出
 *   - 空 universe 安全
 *   - 自定义 params override
 *   - 边界值（N 年恰好 minNetProfitYoy 等）
 */

import {
  DEFAULT_GARP_PARAMS,
  GARPDataSource,
  GARPStockMeta,
  GARPStrategy,
  isSTName,
} from '../../src/quant/strategies/GARPStrategy';

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
  growthSeries?: Map<string, number[]>;
  pettm?: Map<string, number>;
  roe?: Map<string, number>;
  debt?: Map<string, number>;
  meta?: Map<string, GARPStockMeta>;
  dailyClose?: Map<string, number>;
  /** 默认 true（测试默认走调仓日；非调仓日的测试单独设置 false） */
  isRebalanceDay?: boolean;
}

class FakeDataSource implements GARPDataSource {
  constructor(public state: FakeFixtures = {}) {}

  async loadCandidateUniverse(_asOfDate: string): Promise<string[]> {
    return this.state.universe ?? [];
  }

  async loadAnnualNetProfitYoySeries(
    _asOfDate: string,
    _lookbackYears: number,
    stockCodes: string[]
  ): Promise<Map<string, number[]>> {
    const all = this.state.growthSeries ?? new Map();
    const out = new Map<string, number[]>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }

  async loadLatestPETTM(_asOfDate: string, stockCodes: string[]): Promise<Map<string, number>> {
    const all = this.state.pettm ?? new Map();
    const out = new Map<string, number>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }

  async loadRoe5yAvg(_asOfDate: string, stockCodes: string[]): Promise<Map<string, number>> {
    const all = this.state.roe ?? new Map();
    const out = new Map<string, number>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }

  async loadLatestDebtRatio(
    _asOfDate: string,
    stockCodes: string[]
  ): Promise<Map<string, number>> {
    const all = this.state.debt ?? new Map();
    const out = new Map<string, number>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, GARPStockMeta>> {
    const all = this.state.meta ?? new Map();
    const out = new Map<string, GARPStockMeta>();
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

  async isFirstTradingDayOfSemiAnnual(_tradeDate: string): Promise<boolean> {
    return this.state.isRebalanceDay !== false;
  }
}

/**
 * 帮助：构造"四维全过"的完美样本
 * 默认配置：
 *   - 净利润同比序列：[20, 18, 16]（连续 3 年都 ≥ 15）
 *   - PE-TTM = 10，最新增速 20% → PEG = 10/20 = 0.5（≤ 1.0）
 *   - ROE 5y avg = 18%（≥ 12）
 *   - debt_ratio = 40%（≤ 60）
 */
function buildPassingSample(code = '600519'): FakeFixtures {
  return {
    universe: [code],
    growthSeries: new Map([[code, [20, 18, 16]]]),
    pettm: new Map([[code, 10]]),
    roe: new Map([[code, 18.0]]),
    debt: new Map([[code, 40.0]]),
    meta: new Map([[code, { name: '贵州茅台', industry: '食品饮料' }]]),
    dailyClose: new Map([[code, 1700]]),
  };
}

// ----------------------------------------------------------------
// 测试用例
// ----------------------------------------------------------------

async function test_default_params_match_AC() {
  const def = DEFAULT_GARP_PARAMS;
  expectEqual('default topN', def.topN, 30);
  expectEqual('default lookbackYears', def.lookbackYears, 3);
  expectEqual('default minNetProfitYoy', def.minNetProfitYoy, 15);
  expectEqual('default maxPEG', def.maxPEG, 1.0);
  expectEqual('default minROE', def.minROE, 12);
  expectEqual('default maxDebtRatio', def.maxDebtRatio, 60);
  expectEqual('default excludeST', def.excludeST, true);
  expectEqual('default industryNeutral', def.industryNeutral, false);
  expectEqual('default maxPerIndustry', def.maxPerIndustry, 5);
  expectEqual('default rebalancePeriod', def.rebalancePeriod, 'semi_annual');
}

async function test_strategy_definition_metadata() {
  const s = new GARPStrategy(new FakeDataSource());
  expectEqual('strategy_key', s.definition.strategy_key, 'garp_strategy');
  expectEqual('category', s.definition.category, 'multi_factor');
  expectEqual('risk_level', s.definition.risk_level, 'medium');
  expectEqual('enabled', s.definition.enabled, true);
  assert('tags 包含 价值', s.definition.tags.includes('价值'));
  assert('tags 包含 成长', s.definition.tags.includes('成长'));
  assert('tags 包含 GARP', s.definition.tags.includes('GARP'));
  assert('tags 包含 PEG', s.definition.tags.includes('PEG'));
}

async function test_entry_full_pass_4_dimensions() {
  const ds = new FakeDataSource(buildPassingSample());
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('is_rebalance_day', r.is_rebalance_day, true);
  expectEqual('eligible_count', r.eligible_count, 1);
  const buys = r.signals.filter(x => x.signal === 'buy');
  expectEqual('1 buy', buys.length, 1);
  expectEqual('buy stock_code', buys[0].stock_code, '600519');
  expectEqual('buy.pe_ttm', buys[0].pe_ttm, 10);
  expectEqual('buy.roe_5y_avg', buys[0].roe_5y_avg, 18.0);
  expectEqual('buy.debt_ratio', buys[0].debt_ratio, 40.0);
  expectEqual('buy.net_profit_yoy_latest', buys[0].net_profit_yoy_latest, 20);
  expectEqual('buy.peg', buys[0].peg, 0.5);
  expectEqual('buy.reference_price', buys[0].reference_price, 1700);
  expectEqual('target_portfolio', r.target_portfolio, ['600519']);
}

async function test_entry_fail_growth_below_threshold() {
  // 第二年 yoy = 10 < 15 → fail_growth
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    growthSeries: new Map([['600519', [20, 10, 18]]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('fail_growth=1', r.filtered.fail_growth, 1);
}

async function test_entry_fail_growth_only_2_years() {
  // 只有 2 年数据（不足 lookbackYears=3）→ fail_growth
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    growthSeries: new Map([['600519', [20, 18]]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('fail_growth=1 (insufficient)', r.filtered.fail_growth, 1);
}

async function test_entry_fail_growth_missing() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    growthSeries: new Map(),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('fail_growth=1 (missing)', r.filtered.fail_growth, 1);
}

async function test_entry_fail_growth_NaN_in_series() {
  // 序列里有 NaN（年报数据缺）→ fail_growth
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    growthSeries: new Map([['600519', [20, NaN, 16]]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('fail_growth=1 (NaN)', r.filtered.fail_growth, 1);
}

async function test_entry_growth_boundary() {
  // 边界：恰好 [15, 15, 15] 应入选
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    growthSeries: new Map([['600519', [15, 15, 15]]]),
    // PEG = 10/15 ≈ 0.67 ≤ 1.0
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('boundary 15 passes', r.eligible_count, 1);
}

async function test_entry_fail_peg_too_high() {
  // 最新增速 16%，PE 20 → PEG = 1.25 > 1.0
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    growthSeries: new Map([['600519', [16, 16, 16]]]),
    pettm: new Map([['600519', 20]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('fail_peg=1', r.filtered.fail_peg, 1);
}

async function test_entry_fail_pe_zero() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    pettm: new Map([['600519', 0]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  // pe = 0 → 不出现在 loadLatestPETTM 输出（生产实现会过滤）；fake 中存在
  // 但 strategy 内部 pe <= 0 也剔除
  expectEqual('PE=0 剔除', r.filtered.fail_peg, 1);
}

async function test_entry_fail_pe_negative() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    pettm: new Map([['600519', -5]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('PE 负数剔除', r.filtered.fail_peg, 1);
}

async function test_entry_fail_pe_missing() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    pettm: new Map(),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('PE 缺数据剔除', r.filtered.fail_peg, 1);
}

async function test_entry_peg_boundary() {
  // 边界：PEG = 1.0 恰好 (≤ maxPEG=1.0 应入选)
  // 增速 20%，PE = 20 → PEG = 1.0
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    growthSeries: new Map([['600519', [20, 20, 20]]]),
    pettm: new Map([['600519', 20]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('PEG=1.0 恰好入选', r.eligible_count, 1);
}

async function test_entry_fail_roe_too_low() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    roe: new Map([['600519', 8.0]]), // < 12
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('fail_roe=1', r.filtered.fail_roe, 1);
}

async function test_entry_fail_roe_missing() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    roe: new Map(),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('ROE 缺数据剔除', r.filtered.fail_roe, 1);
}

async function test_entry_roe_boundary() {
  // 边界：ROE = 12 恰好 (≥ minROE 应入选)
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    roe: new Map([['600519', 12.0]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('ROE=12 恰好入选', r.eligible_count, 1);
}

async function test_entry_fail_debt_too_high() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    debt: new Map([['600519', 80.0]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('fail_debt=1', r.filtered.fail_debt, 1);
}

async function test_entry_fail_debt_missing() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    debt: new Map(),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('debt 缺数据剔除', r.filtered.fail_debt, 1);
}

async function test_entry_debt_boundary() {
  // 边界：debt = 60 恰好 (≤ maxDebtRatio 应入选)
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    debt: new Map([['600519', 60.0]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('debt=60 恰好入选', r.eligible_count, 1);
}

async function test_entry_fail_st_excluded() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    meta: new Map([['600519', { name: 'ST 茅台', industry: '食品饮料' }]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('fail_st=1', r.filtered.fail_st, 1);
}

async function test_entry_st_kept_when_excludeST_false() {
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    meta: new Map([['600519', { name: 'ST 茅台', industry: '食品饮料' }]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01', {
    params: { excludeST: false },
  });
  expectEqual('ST kept when excludeST=false', r.eligible_count, 1);
}

async function test_non_rebalance_day_returns_hold_only() {
  const ds = new FakeDataSource({ ...buildPassingSample(), isRebalanceDay: false });
  const r = await new GARPStrategy(ds).generateSignals('2025-04-15', {
    previousSelection: ['000001', '600519'],
  });
  expectEqual('is_rebalance_day=false', r.is_rebalance_day, false);
  expectEqual('target=previousSelection', r.target_portfolio, ['000001', '600519']);
  expectEqual('signals=[]', r.signals.length, 0);
  expectEqual('eligible_count=0 (non-rebalance)', r.eligible_count, 0);
  expectEqual('universe_size=0 (skipped scan)', r.filtered.universe_size, 0);
}

async function test_force_rebalance_overrides_calendar() {
  const ds = new FakeDataSource({ ...buildPassingSample(), isRebalanceDay: false });
  const r = await new GARPStrategy(ds).generateSignals('2025-04-15', {
    forceRebalance: true,
  });
  expectEqual('is_rebalance_day forced true', r.is_rebalance_day, true);
  expectEqual('eligible_count=1', r.eligible_count, 1);
}

async function test_sort_by_growth_desc() {
  // 3 只股票：A 增速 20，B 增速 25，C 增速 30 → C 排前
  const ds = new FakeDataSource({
    universe: ['600A', '600B', '600C'],
    growthSeries: new Map([
      ['600A', [20, 20, 20]],
      ['600B', [25, 25, 25]],
      ['600C', [30, 30, 30]],
    ]),
    pettm: new Map([
      ['600A', 10],
      ['600B', 10],
      ['600C', 10],
    ]),
    roe: new Map([
      ['600A', 15],
      ['600B', 15],
      ['600C', 15],
    ]),
    debt: new Map([
      ['600A', 40],
      ['600B', 40],
      ['600C', 40],
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
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('target order 增速降序', r.target_portfolio, ['600C', '600B', '600A']);
}

async function test_sort_tie_break_by_peg_asc() {
  // 增速相同 → 按 PEG 升序：A PE=20 PEG=1.0, B PE=10 PEG=0.5 → B 排前
  const ds = new FakeDataSource({
    universe: ['600A', '600B'],
    growthSeries: new Map([
      ['600A', [20, 20, 20]],
      ['600B', [20, 20, 20]],
    ]),
    pettm: new Map([
      ['600A', 20], // PEG = 1.0
      ['600B', 10], // PEG = 0.5
    ]),
    roe: new Map([
      ['600A', 15],
      ['600B', 15],
    ]),
    debt: new Map([
      ['600A', 40],
      ['600B', 40],
    ]),
    meta: new Map([
      ['600A', { name: 'A' }],
      ['600B', { name: 'B' }],
    ]),
    dailyClose: new Map([
      ['600A', 10],
      ['600B', 10],
    ]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('target PEG 升序 tie-break', r.target_portfolio, ['600B', '600A']);
}

async function test_sort_tie_break_stable_by_stock_code() {
  // 增速 + PEG 相同 → 按 stock_code 升序：600A 排前 600B
  const ds = new FakeDataSource({
    universe: ['600A', '600B'],
    growthSeries: new Map([
      ['600A', [20, 20, 20]],
      ['600B', [20, 20, 20]],
    ]),
    pettm: new Map([
      ['600A', 10],
      ['600B', 10],
    ]),
    roe: new Map([
      ['600A', 15],
      ['600B', 15],
    ]),
    debt: new Map([
      ['600A', 40],
      ['600B', 40],
    ]),
    meta: new Map([
      ['600A', { name: 'A' }],
      ['600B', { name: 'B' }],
    ]),
    dailyClose: new Map([
      ['600A', 10],
      ['600B', 10],
    ]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('target stock_code 升序 tie-break', r.target_portfolio, ['600A', '600B']);
}

async function test_topN_cap() {
  // 5 只全过 + topN=3 → 只选前 3 只
  const codes = ['600A', '600B', '600C', '600D', '600E'];
  const ds = new FakeDataSource({
    universe: codes,
    growthSeries: new Map(codes.map((c, i) => [c, [20 + i, 20 + i, 20 + i]])),
    pettm: new Map(codes.map(c => [c, 10])),
    roe: new Map(codes.map(c => [c, 15])),
    debt: new Map(codes.map(c => [c, 40])),
    meta: new Map(codes.map(c => [c, { name: c, industry: '行业A' }])),
    dailyClose: new Map(codes.map(c => [c, 10])),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01', {
    params: { topN: 3 },
  });
  expectEqual('eligible_count=5', r.eligible_count, 5);
  expectEqual('target len=3', r.target_portfolio.length, 3);
  // 按增速降序：E(24) D(23) C(22) → target = [E, D, C]
  expectEqual('topN selects highest growth', r.target_portfolio, ['600E', '600D', '600C']);
}

async function test_industry_neutral_cap() {
  // 5 只股票全在同一行业 + maxPerIndustry=2 → 只选 2 只
  const codes = ['600A', '600B', '600C', '600D', '600E'];
  const ds = new FakeDataSource({
    universe: codes,
    growthSeries: new Map(codes.map((c, i) => [c, [20 + i, 20 + i, 20 + i]])),
    pettm: new Map(codes.map(c => [c, 10])),
    roe: new Map(codes.map(c => [c, 15])),
    debt: new Map(codes.map(c => [c, 40])),
    meta: new Map(codes.map(c => [c, { name: c, industry: '食品饮料' }])),
    dailyClose: new Map(codes.map(c => [c, 10])),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01', {
    params: { industryNeutral: true, maxPerIndustry: 2 },
  });
  // 行业中性：每行业 ≤ 2 → 取增速最高的 2 只
  expectEqual('industry-neutral cap', r.target_portfolio, ['600E', '600D']);
}

async function test_first_open_all_buy() {
  // 无 previousSelection → 全 BUY
  const ds = new FakeDataSource(buildPassingSample());
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  const buys = r.signals.filter(s => s.signal === 'buy').map(s => s.stock_code);
  const sells = r.signals.filter(s => s.signal === 'sell');
  const holds = r.signals.filter(s => s.signal === 'hold');
  expectEqual('1 BUY first open', buys, ['600519']);
  expectEqual('0 SELL first open', sells.length, 0);
  expectEqual('0 HOLD first open', holds.length, 0);
}

async function test_partial_overlap_buy_hold_sell() {
  // previousSelection = [600A00, 600X00 (out of universe)]
  // universe = [600A00, 600B00] → target = [600A00, 600B00]
  // → BUY 600B00, HOLD 600A00, SELL 600X00
  const ds = new FakeDataSource({
    universe: ['600A00', '600B00'],
    growthSeries: new Map([
      ['600A00', [20, 20, 20]],
      ['600B00', [20, 20, 20]],
    ]),
    pettm: new Map([
      ['600A00', 10],
      ['600B00', 10],
    ]),
    roe: new Map([
      ['600A00', 15],
      ['600B00', 15],
    ]),
    debt: new Map([
      ['600A00', 40],
      ['600B00', 40],
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
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01', {
    previousSelection: ['600A00', '600X00'],
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
  const ds = new FakeDataSource(buildPassingSample());
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01', {
    previousSelection: ['600519'],
  });
  const buys = r.signals.filter(s => s.signal === 'buy');
  const sells = r.signals.filter(s => s.signal === 'sell');
  const holds = r.signals.filter(s => s.signal === 'hold');
  expectEqual('0 BUY (unchanged)', buys.length, 0);
  expectEqual('0 SELL (unchanged)', sells.length, 0);
  expectEqual('1 HOLD', holds.length, 1);
  expectEqual('HOLD = 600519', holds[0].stock_code, '600519');
}

async function test_evaluate_returns_info_hold() {
  const s = new GARPStrategy(new FakeDataSource());
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
  expectEqual('evaluate.target_holding_days', result.target_holding_days, 180);
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
  const s = new GARPStrategy(new FakeDataSource());
  let threw = false;
  try {
    await s.generateSignals('not-a-date');
  } catch (_) {
    threw = true;
  }
  assert('invalid trade_date 抛出', threw);

  let threw2 = false;
  try {
    await s.generateSignals('2025/07/01');
  } catch (_) {
    threw2 = true;
  }
  assert('错误分隔符抛出', threw2);
}

async function test_empty_universe_safe() {
  const ds = new FakeDataSource({ universe: [] });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('empty universe eligible=0', r.eligible_count, 0);
  expectEqual('signals 空数组', r.signals.length, 0);
  expectEqual('target 空数组', r.target_portfolio.length, 0);
  expectEqual('universe_size=0', r.filtered.universe_size, 0);
}

async function test_custom_params_override() {
  // 默认参数下增速 [10, 10, 10] 不通过；放宽 minNetProfitYoy=5 → 通过
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    growthSeries: new Map([['600519', [10, 10, 10]]]),
    // PEG = 10/10 = 1.0 ≤ 1.0
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01', {
    params: { minNetProfitYoy: 5 },
  });
  expectEqual('放宽后入选', r.eligible_count, 1);
  expectEqual('params.minNetProfitYoy=5', r.params.minNetProfitYoy, 5);
  expectEqual('其他参数 default', r.params.minROE, 12);
}

async function test_mixed_pass_fail_some_dimensions() {
  // 4 只股票：A 全通过；B 增速不足；C PEG 超标；D 负债太高
  const ds = new FakeDataSource({
    universe: ['600A', '600B', '600C', '600D'],
    growthSeries: new Map([
      ['600A', [20, 20, 20]],
      ['600B', [10, 10, 10]], // < 15
      ['600C', [20, 20, 20]],
      ['600D', [20, 20, 20]],
    ]),
    pettm: new Map([
      ['600A', 10],
      ['600B', 10],
      ['600C', 25], // PEG = 1.25 > 1.0
      ['600D', 10],
    ]),
    roe: new Map([
      ['600A', 15],
      ['600B', 15],
      ['600C', 15],
      ['600D', 15],
    ]),
    debt: new Map([
      ['600A', 40],
      ['600B', 40],
      ['600C', 40],
      ['600D', 80], // > 60
    ]),
    meta: new Map([
      ['600A', { name: 'A' }],
      ['600B', { name: 'B' }],
      ['600C', { name: 'C' }],
      ['600D', { name: 'D' }],
    ]),
    dailyClose: new Map([
      ['600A', 10],
      ['600B', 10],
      ['600C', 10],
      ['600D', 10],
    ]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('只 A 入选', r.eligible_count, 1);
  expectEqual('target = [600A]', r.target_portfolio, ['600A']);
  expectEqual('fail_growth=1', r.filtered.fail_growth, 1);
  expectEqual('fail_peg=1', r.filtered.fail_peg, 1);
  expectEqual('fail_debt=1', r.filtered.fail_debt, 1);
}

async function test_st_excluded_before_other_filters() {
  // ST 在最前面过滤 — 即使其他维度都缺，也只计入 fail_st
  const ds = new FakeDataSource({
    universe: ['600ST'],
    growthSeries: new Map(),
    pettm: new Map(),
    roe: new Map(),
    debt: new Map(),
    meta: new Map([['600ST', { name: 'ST 闹剧' }]]),
    dailyClose: new Map(),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('fail_st=1', r.filtered.fail_st, 1);
  expectEqual('fail_growth=0 (ST 提前剔除)', r.filtered.fail_growth, 0);
  expectEqual('fail_peg=0 (ST 提前剔除)', r.filtered.fail_peg, 0);
}

async function test_universe_size_records_total() {
  const ds = new FakeDataSource({
    universe: ['600001', '600002', '600003'],
    // 所有股都缺增长数据 → 全部 fail_growth (after ST check, no name)
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('universe_size=3', r.filtered.universe_size, 3);
  // 缺 meta → 不会触发 ST 判断；缺 growth → 全 fail_growth
  expectEqual('fail_growth=3', r.filtered.fail_growth, 3);
}

async function test_growth_with_negative_yoy_rejected() {
  // 任一年是负值（亏损） → fail_growth
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    growthSeries: new Map([['600519', [20, -5, 18]]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('fail_growth=1 (negative yoy)', r.filtered.fail_growth, 1);
}

async function test_peg_calculation_correctness() {
  // 验证 PEG 的精确计算：增速 [15, 18, 20]（latest=15）, PE = 12
  // → PEG = 12 / 15 = 0.8 ≤ 1.0
  const ds = new FakeDataSource({
    ...buildPassingSample(),
    growthSeries: new Map([['600519', [15, 18, 20]]]),
    pettm: new Map([['600519', 12]]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('peg = 12/15 = 0.8', r.eligible_count, 1);
  const buys = r.signals.filter(s => s.signal === 'buy');
  expectEqual('PEG 字段精度', Math.abs(buys[0].peg! - 0.8) < 1e-9, true);
  // latest yoy = 15 (按 report_date 降序的第一个)
  expectEqual('latest yoy = 15', buys[0].net_profit_yoy_latest, 15);
}

async function test_growth_sort_uses_latest_yoy() {
  // 3 只股票：A latest=20 mean=20, B latest=30 但前两年 15
  // 排序按 latest yoy 降序 → B(30) > A(20)
  const ds = new FakeDataSource({
    universe: ['600A', '600B'],
    growthSeries: new Map([
      ['600A', [20, 20, 20]],
      ['600B', [30, 15, 15]],
    ]),
    pettm: new Map([
      ['600A', 10],
      ['600B', 25], // PEG = 25/30 ≈ 0.83
    ]),
    roe: new Map([
      ['600A', 15],
      ['600B', 15],
    ]),
    debt: new Map([
      ['600A', 40],
      ['600B', 40],
    ]),
    meta: new Map([
      ['600A', { name: 'A' }],
      ['600B', { name: 'B' }],
    ]),
    dailyClose: new Map([
      ['600A', 10],
      ['600B', 10],
    ]),
  });
  const r = await new GARPStrategy(ds).generateSignals('2025-07-01');
  expectEqual('B 排前 by latest yoy', r.target_portfolio, ['600B', '600A']);
}

// ----------------------------------------------------------------
// Runner
// ----------------------------------------------------------------

async function main() {
  const tests = [
    test_default_params_match_AC,
    test_strategy_definition_metadata,
    test_entry_full_pass_4_dimensions,
    test_entry_fail_growth_below_threshold,
    test_entry_fail_growth_only_2_years,
    test_entry_fail_growth_missing,
    test_entry_fail_growth_NaN_in_series,
    test_entry_growth_boundary,
    test_entry_fail_peg_too_high,
    test_entry_fail_pe_zero,
    test_entry_fail_pe_negative,
    test_entry_fail_pe_missing,
    test_entry_peg_boundary,
    test_entry_fail_roe_too_low,
    test_entry_fail_roe_missing,
    test_entry_roe_boundary,
    test_entry_fail_debt_too_high,
    test_entry_fail_debt_missing,
    test_entry_debt_boundary,
    test_entry_fail_st_excluded,
    test_entry_st_kept_when_excludeST_false,
    test_non_rebalance_day_returns_hold_only,
    test_force_rebalance_overrides_calendar,
    test_sort_by_growth_desc,
    test_sort_tie_break_by_peg_asc,
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
    test_growth_with_negative_yoy_rejected,
    test_peg_calculation_correctness,
    test_growth_sort_uses_latest_yoy,
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
