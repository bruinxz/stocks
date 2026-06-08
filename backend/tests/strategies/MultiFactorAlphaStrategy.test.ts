/**
 * MultiFactorAlphaStrategy 单测（US-011 / US-081）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/MultiFactorAlphaStrategy.test.ts
 *
 * 测试用 FakeDataSource 注入到 MultiFactorAlphaStrategy(constructor)，避免任何 DB 依赖。
 * AC 要求至少覆盖 industryNeutral 与 excludeST 两个分支；本文件总共覆盖：
 *   - 默认权重已按 AC 设定 (sum=1.0)
 *   - 12 因子加权合成 composite_score 正确（US-081）
 *   - industryNeutral=true 时每行业最多 maxPerIndustry 只
 *   - industryNeutral=false 时不做行业限制
 *   - excludeST=true 剔除 ST/*ST 命名
 *   - excludeST=false 保留 ST
 *   - excludeNew60d 按上市日期剔除次新股
 *   - 因子覆盖 0 的股票（全 z=0）被剔除
 *   - 排序稳定性：composite 相同时按 stock_code 升序
 *   - previousSelection 计算 BUY / SELL / HOLD 增量
 *   - 权重归一化：用户传未归一化权重，内部 sum-normalize 到 1.0
 *   - evaluate() 返回信息性 hold 信号
 *   - （US-081）weightMode='static'（默认）= 等价 US-011 旧行为
 *   - （US-081）weightMode='equal' = 所有正权重因子 1/N 等权
 *   - （US-081）weightMode='ic_weighted' = 按 IC 动态加权
 *   - （US-081）weightMode='ic_weighted' 所有 IC ≤ 0 → 整体回退 static
 *   - （US-081）computeEffectiveWeights 纯函数 3 mode 边界覆盖
 */

import {
  computeEffectiveWeights,
  DEFAULT_IC_LOOK_FORWARD_DAYS,
  DEFAULT_IC_LOOKBACK_DAYS,
  DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS,
  isNewerThan,
  isSTName,
  MultiFactorAlphaDataSource,
  MultiFactorAlphaStrategy,
  StockMeta,
} from '../../src/quant/strategies/MultiFactorAlphaStrategy';
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
  assert(name, same, detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ----------------------------------------------------------------
// FakeDataSource — 测试用注入实现
// ----------------------------------------------------------------

/**
 * FakeDataSource 接收两个固定 Map，避免任何 DB / Sequelize 调用。
 * 任何 generateSignals 调用都从内存里读，结果完全确定。
 *
 * （US-081）可选注入 icMap 让 weightMode='ic_weighted' 测试可控；
 * 同时记录 loadRecentFactorICs 调用次数 + 入参，便于断言"static/equal mode
 * 不该调本接口"。
 */
class FakeDataSource implements MultiFactorAlphaDataSource {
  /** loadRecentFactorICs 累计调用次数（US-081 测试用） */
  public icCallCount = 0;
  /** loadRecentFactorICs 上一次入参快照（US-081 断言 lookForwardDays / lookbackDays 透传） */
  public lastIcCallArgs?: {
    factorNames: string[];
    asOfDate: string;
    lookForwardDays: number;
    lookbackDays: number;
  };

  constructor(
    /** code → factor → z_score；未列出的 factor 默认 0（与生产中性补全一致） */
    private factorMap: Map<string, Map<string, number>>,
    /** code → meta（name / industry / listing_date） */
    private metaMap: Map<string, StockMeta>,
    /** （US-081）factor_name → ic_mean；未列出的 factor 视为"无 IC 数据"（不返回） */
    private icMap: Map<string, number> = new Map()
  ) {}

  async loadFactorScores(
    _tradeDate: string,
    factorNames: string[]
  ): Promise<Map<string, Map<string, number>>> {
    // 投影：只返回请求的 factorNames（与生产 SQL where 等价）
    const out = new Map<string, Map<string, number>>();
    for (const [code, inner] of this.factorMap.entries()) {
      const projected = new Map<string, number>();
      for (const name of factorNames) {
        const z = inner.get(name);
        if (z !== undefined) projected.set(name, z);
      }
      out.set(code, projected);
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, StockMeta>> {
    const out = new Map<string, StockMeta>();
    for (const code of stockCodes) {
      const meta = this.metaMap.get(code);
      if (meta) out.set(code, meta);
    }
    return out;
  }

  async loadRecentFactorICs(
    factorNames: string[],
    asOfDate: string,
    lookForwardDays: number,
    lookbackDays: number
  ): Promise<Map<string, number>> {
    this.icCallCount += 1;
    this.lastIcCallArgs = { factorNames: [...factorNames], asOfDate, lookForwardDays, lookbackDays };
    // 投影：只返回请求的 factorNames 中 icMap 已配置的项
    const out = new Map<string, number>();
    for (const name of factorNames) {
      const v = this.icMap.get(name);
      if (v !== undefined) out.set(name, v);
    }
    return out;
  }
}

/**
 * 构造一个 N 行的 fake 数据集；每只股票 12 因子都有 z_score。
 *
 * @param fixtures stocks 数组：{code, name, industry, listing_date?, factor_z?}
 *   factor_z 可只填部分因子，其余默认 0。
 * @param icMap （US-081）可选：factor_name → ic_mean，用于 weightMode='ic_weighted' 测试
 */
function buildFakeDataSource(
  fixtures: Array<{
    code: string;
    name: string;
    industry: string | null;
    listing_date?: string | null;
    factor_z?: Partial<Record<string, number>>;
  }>,
  icMap?: Map<string, number>
): FakeDataSource {
  const factorMap = new Map<string, Map<string, number>>();
  const metaMap = new Map<string, StockMeta>();
  const ALL = Object.keys(DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS);
  for (const f of fixtures) {
    const inner = new Map<string, number>();
    for (const factor of ALL) {
      inner.set(factor, f.factor_z?.[factor] ?? 0);
    }
    factorMap.set(f.code, inner);
    metaMap.set(f.code, {
      name: f.name,
      industry: f.industry,
      listing_date: f.listing_date ?? null,
    });
  }
  return new FakeDataSource(factorMap, metaMap, icMap);
}

// ----------------------------------------------------------------
// 测试用例
// ----------------------------------------------------------------

async function test_default_weights_match_AC() {
  const weights = DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS;
  // US-081 升级后的 12 因子默认权重
  expectEqual('default weights.value', weights.value, 0.1);
  expectEqual('default weights.quality', weights.quality, 0.1);
  expectEqual('default weights.growth', weights.growth, 0.1);
  expectEqual('default weights.momentum', weights.momentum, 0.1);
  expectEqual('default weights.low_vol', weights.low_vol, 0.08);
  expectEqual('default weights.northbound', weights.northbound, 0.08);
  expectEqual('default weights.money_flow', weights.money_flow, 0.08);
  expectEqual('default weights.dragon_tiger', weights.dragon_tiger, 0.08);
  // US-081 新增 4 个因子
  expectEqual('default weights.quality_high', weights.quality_high, 0.07);
  expectEqual('default weights.analyst_consensus', weights.analyst_consensus, 0.07);
  expectEqual('default weights.east_money_qa', weights.east_money_qa, 0.06);
  expectEqual('default weights.momentum_reversal', weights.momentum_reversal, 0.08);
  expectEqual('US-081: 12 个因子全部都在', Object.keys(weights).length, 12);
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  assert('default weights sum to 1.0', Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
}

async function test_default_params_are_AC_defaults() {
  const s = new MultiFactorAlphaStrategy(buildFakeDataSource([]));
  const def = s.definition.default_params as any;
  expectEqual('default topN', def.topN, 30);
  expectEqual('default rebalancePeriod', def.rebalancePeriod, 'monthly');
  expectEqual('default industryNeutral', def.industryNeutral, true);
  expectEqual('default maxPerIndustry', def.maxPerIndustry, 3);
  expectEqual('default excludeST', def.excludeST, true);
  expectEqual('default excludeNew60d', def.excludeNew60d, true);
  // US-081 新增 3 字段
  expectEqual('default weightMode', def.weightMode, 'static');
  expectEqual('default icLookForwardDays', def.icLookForwardDays, DEFAULT_IC_LOOK_FORWARD_DAYS);
  expectEqual('default icLookbackDays', def.icLookbackDays, DEFAULT_IC_LOOKBACK_DAYS);
  expectEqual('DEFAULT_IC_LOOK_FORWARD_DAYS = 20', DEFAULT_IC_LOOK_FORWARD_DAYS, 20);
  expectEqual('DEFAULT_IC_LOOKBACK_DAYS = 90', DEFAULT_IC_LOOKBACK_DAYS, 90);
}

async function test_composite_score_weighted_sum() {
  // 构造一只股票：12 因子 z 都是 1.0 → composite_score 应当 = 1.0（weight sum 1.0）
  const ds = buildFakeDataSource([
    {
      code: '600519',
      name: '贵州茅台',
      industry: '食品饮料',
      factor_z: {
        value: 1,
        quality: 1,
        growth: 1,
        momentum: 1,
        low_vol: 1,
        northbound: 1,
        money_flow: 1,
        dragon_tiger: 1,
        // US-081 新增 4 个因子也设 z=1
        quality_high: 1,
        analyst_consensus: 1,
        east_money_qa: 1,
        momentum_reversal: 1,
      },
    },
  ]);
  const s = new MultiFactorAlphaStrategy(ds);
  const result = await s.generateSignals('2026-06-05');
  expectEqual('全 z=1 → composite=1.0', result.signals[0].composite_score, 1.0);

  // 构造一只股票：value=2.0，其他全 0；权重 0.10 (US-081 新值) → composite = 2.0 * 0.10 = 0.20
  const ds2 = buildFakeDataSource([
    {
      code: '600519',
      name: '贵州茅台',
      industry: '食品饮料',
      factor_z: { value: 2.0 },
    },
  ]);
  const s2 = new MultiFactorAlphaStrategy(ds2);
  const r2 = await s2.generateSignals('2026-06-05');
  const composite = r2.signals[0].composite_score;
  assert(
    'value=2, 其余=0 → composite ≈ 0.20 (US-081 新权重 0.10)',
    Math.abs(composite - 0.2) < 1e-9,
    `got ${composite}`
  );
}

async function test_industry_neutral_caps_per_industry() {
  // 5 只食品饮料 + 5 只医药，industryNeutral=true, maxPerIndustry=3 → 每行业最多 3 只
  // composite 设计：让 5 只同行业内 5 只 composite 差异化
  const stocks = [
    ['600519', '贵州茅台', '食品饮料', 5.0],
    ['000858', '五粮液', '食品饮料', 4.0],
    ['600809', '山西汾酒', '食品饮料', 3.0],
    ['000568', '泸州老窖', '食品饮料', 2.0],
    ['000596', '古井贡酒', '食品饮料', 1.0],
    ['600276', '恒瑞医药', '医药', 5.0],
    ['300015', '爱尔眼科', '医药', 4.0],
    ['600196', '复星医药', '医药', 3.0],
    ['000538', '云南白药', '医药', 2.0],
    ['600085', '同仁堂', '医药', 1.0],
  ] as const;
  const ds = buildFakeDataSource(
    stocks.map(([code, name, industry, valZ]) => ({
      code,
      name,
      industry,
      // 把 z 全压在 value 上，方便排序
      factor_z: { value: valZ },
    }))
  );

  // 带 industryNeutral=true（默认）
  const s = new MultiFactorAlphaStrategy(ds);
  const result = await s.generateSignals('2026-06-05', {
    params: { topN: 10, maxPerIndustry: 3 },
  });

  expectEqual(
    'industryNeutral=true → target_portfolio 共 6 只（每行业 3 只 × 2 行业）',
    result.target_portfolio.length,
    6
  );

  // 验证每行业不超过 3
  const counts = new Map<string, number>();
  for (const code of result.target_portfolio) {
    const inMeta = result.signals.find(s => s.stock_code === code)?.industry;
    counts.set(inMeta || 'unknown', (counts.get(inMeta || 'unknown') ?? 0) + 1);
  }
  for (const [industry, cnt] of counts) {
    assert(
      `industry "${industry}" 持仓 ≤ 3`,
      cnt <= 3,
      `actual = ${cnt}`
    );
  }

  // 应当选中各行业 z 最高的 3 只（食品饮料的 600519/000858/600809；医药 600276/300015/600196）
  const expected = ['600519', '000858', '600809', '600276', '300015', '600196'].sort();
  const actual = [...result.target_portfolio].sort();
  expectEqual('industryNeutral 取每行业 top-3', actual, expected);

  // filtered.industry_capped 应当 = 4（被 cap 出局的 4 只）
  expectEqual(
    'filtered.industry_capped = 4 (5+5 - 3*2)',
    result.filtered.industry_capped,
    4
  );

  // 同样数据但 industryNeutral=false → 应取 composite top-10（全 10 只都进）
  const s2 = new MultiFactorAlphaStrategy(ds);
  const r2 = await s2.generateSignals('2026-06-05', {
    params: { topN: 10, industryNeutral: false },
  });
  expectEqual(
    'industryNeutral=false → target_portfolio 全 10 只',
    r2.target_portfolio.length,
    10
  );
  expectEqual(
    'industryNeutral=false → filtered.industry_capped = 0',
    r2.filtered.industry_capped,
    0
  );
}

async function test_excludeST_filters_ST_names() {
  // 3 只正常 + 3 只 ST（不同前缀变体）
  const ds = buildFakeDataSource([
    { code: '600519', name: '贵州茅台', industry: '食品饮料', factor_z: { value: 5 } },
    { code: '000858', name: '五粮液', industry: '食品饮料', factor_z: { value: 4 } },
    { code: '600276', name: '恒瑞医药', industry: '医药', factor_z: { value: 3 } },
    { code: '000404', name: 'ST华信', industry: '其他', factor_z: { value: 10 } }, // 高分 ST
    { code: '000662', name: '*ST天夏', industry: '其他', factor_z: { value: 9 } },
    { code: '600145', name: 'S*ST石岘', industry: '其他', factor_z: { value: 8 } },
  ]);

  // excludeST=true（默认）→ 3 只 ST 都被剔除
  const s = new MultiFactorAlphaStrategy(ds);
  const r = await s.generateSignals('2026-06-05', { params: { topN: 10 } });
  expectEqual(
    'excludeST=true → target_portfolio 只剩 3 只非 ST',
    r.target_portfolio.length,
    3
  );
  expectEqual('filtered.st = 3', r.filtered.st, 3);
  // ST 的高分也不能让它入选
  for (const code of r.target_portfolio) {
    const meta = r.signals.find(s => s.stock_code === code);
    assert(
      `选中的 ${code}(${meta?.name}) 非 ST`,
      !isSTName(meta?.name)
    );
  }

  // excludeST=false → 全 6 只都进，且 ST 因为 composite 更高排在前面
  const s2 = new MultiFactorAlphaStrategy(ds);
  const r2 = await s2.generateSignals('2026-06-05', {
    params: { topN: 10, excludeST: false },
  });
  expectEqual(
    'excludeST=false → target_portfolio 全 6 只',
    r2.target_portfolio.length,
    6
  );
  expectEqual('excludeST=false → filtered.st = 0', r2.filtered.st, 0);
  expectEqual(
    'excludeST=false → 高分 ST 排第一',
    r2.target_portfolio[0],
    '000404'
  );
}

async function test_excludeNew60d_filters_recent_listings() {
  const tradeDate = '2026-06-05';
  // 2 只老股 + 2 只次新（30 天上市 + 90 天上市）
  const ds = buildFakeDataSource([
    {
      code: '600519',
      name: '贵州茅台',
      industry: '食品饮料',
      listing_date: '2001-08-27',
      factor_z: { value: 5 },
    },
    {
      code: '000858',
      name: '五粮液',
      industry: '食品饮料',
      listing_date: '1998-04-27',
      factor_z: { value: 4 },
    },
    {
      code: '301999',
      name: '新次新',
      industry: '其他',
      listing_date: '2026-05-15', // 21 天 < 60
      factor_z: { value: 10 },
    },
    {
      code: '301888',
      name: '90日次新',
      industry: '其他',
      listing_date: '2026-03-05', // 92 天 > 60
      factor_z: { value: 9 },
    },
  ]);

  const s = new MultiFactorAlphaStrategy(ds);
  const r = await s.generateSignals(tradeDate, { params: { topN: 10 } });
  // 21 天那只剔除，92 天那只保留
  assert(
    'excludeNew60d=true 剔除 21 天新股',
    !r.target_portfolio.includes('301999')
  );
  assert(
    'excludeNew60d=true 保留 92 天股',
    r.target_portfolio.includes('301888')
  );
  expectEqual('filtered.new60d = 1', r.filtered.new60d, 1);
}

async function test_no_factor_data_filtered_out() {
  // 一只股票 8 因子全部 z=0（pipeline 中性补全场景）→ no_factor_data 剔除
  const ds = buildFakeDataSource([
    {
      code: '600519',
      name: '贵州茅台',
      industry: '食品饮料',
      factor_z: { value: 1 }, // 有一个非零
    },
    {
      code: '000000',
      name: '中性股',
      industry: '其他',
      factor_z: {}, // 全 0
    },
  ]);
  const s = new MultiFactorAlphaStrategy(ds);
  const r = await s.generateSignals('2026-06-05', { params: { topN: 10 } });
  expectEqual('全 0 因子被剔除', r.target_portfolio, ['600519']);
  expectEqual('filtered.no_factor_data = 1', r.filtered.no_factor_data, 1);
}

async function test_stable_sort_on_tie() {
  // composite 完全一致的 3 只股票 → 按 stock_code 升序排
  const ds = buildFakeDataSource([
    { code: '300999', name: '丙', industry: 'A', factor_z: { value: 1 } },
    { code: '300888', name: '乙', industry: 'B', factor_z: { value: 1 } },
    { code: '300777', name: '甲', industry: 'C', factor_z: { value: 1 } },
  ]);
  const s = new MultiFactorAlphaStrategy(ds);
  const r = await s.generateSignals('2026-06-05', { params: { topN: 2 } });
  expectEqual('tie-break 按 stock_code 升序', r.target_portfolio, ['300777', '300888']);
}

async function test_previous_selection_emits_buy_sell_hold() {
  const ds = buildFakeDataSource([
    { code: '600519', name: '贵州茅台', industry: '食品饮料', factor_z: { value: 5 } },
    { code: '000858', name: '五粮液', industry: '食品饮料', factor_z: { value: 4 } },
    { code: '600276', name: '恒瑞医药', industry: '医药', factor_z: { value: 3 } },
  ]);
  const s = new MultiFactorAlphaStrategy(ds);
  const r = await s.generateSignals('2026-06-05', {
    params: { topN: 2 },
    previousSelection: ['600519', '300888'], // 600519 仍在, 300888 应当 SELL
  });
  expectEqual('target = top 2', r.target_portfolio, ['600519', '000858']);
  const bySignal = (sig: string) => r.signals.filter(s => s.signal === sig).map(s => s.stock_code);
  expectEqual('BUY = 新进入选', bySignal('buy'), ['000858']);
  expectEqual('HOLD = 仍持有', bySignal('hold'), ['600519']);
  expectEqual('SELL = 跌出 top-N', bySignal('sell'), ['300888']);
}

async function test_first_open_position_all_buy() {
  // 不传 previousSelection → 全部应当是 BUY
  const ds = buildFakeDataSource([
    { code: '600519', name: '贵州茅台', industry: '食品饮料', factor_z: { value: 5 } },
    { code: '000858', name: '五粮液', industry: '食品饮料', factor_z: { value: 4 } },
  ]);
  const s = new MultiFactorAlphaStrategy(ds);
  const r = await s.generateSignals('2026-06-05', { params: { topN: 10 } });
  const buyCount = r.signals.filter(s => s.signal === 'buy').length;
  const holdCount = r.signals.filter(s => s.signal === 'hold').length;
  const sellCount = r.signals.filter(s => s.signal === 'sell').length;
  expectEqual('首次开仓 BUY 数 = target_portfolio 长度', buyCount, r.target_portfolio.length);
  expectEqual('首次开仓 HOLD = 0', holdCount, 0);
  expectEqual('首次开仓 SELL = 0', sellCount, 0);
}

async function test_custom_weights_are_normalized() {
  // 用户传未归一化权重（只有 value=2, momentum=8；其他 0）
  // 内部 sum-normalize 后：value=0.2, momentum=0.8
  // 构造股票：value z=10, momentum z=5 → composite = 10*0.2 + 5*0.8 = 2 + 4 = 6.0
  const ds = buildFakeDataSource([
    {
      code: '600519',
      name: '贵州茅台',
      industry: '食品饮料',
      factor_z: { value: 10, momentum: 5 },
    },
  ]);
  const s = new MultiFactorAlphaStrategy(ds);
  const r = await s.generateSignals('2026-06-05', {
    params: {
      weights: { value: 2, momentum: 8 },
    },
  });
  const composite = r.signals[0].composite_score;
  assert(
    '未归一化权重 (2,8) → 归一化后 composite = 6.0',
    Math.abs(composite - 6.0) < 1e-9,
    `got ${composite}`
  );
}

async function test_evaluate_returns_informational_hold() {
  const s = new MultiFactorAlphaStrategy(buildFakeDataSource([]));
  const ctx: QuantStockContext = {
    stock_id: 1,
    symbol: '600519.SH',
    name: '贵州茅台',
    bars: [
      {
        time: new Date('2026-06-05'),
        open: 1500,
        high: 1510,
        low: 1490,
        close: 1505,
        volume: 100000,
      },
    ],
  };
  const result = s.evaluate(ctx);
  expectEqual('evaluate 返回 hold', result.signal, 'hold');
  expectEqual('evaluate strategy_key', result.strategy_key, 'multi_factor_alpha');
  assert(
    'evaluate reasons 包含 generateSignals 提示',
    result.reasons.some(r => r.includes('generateSignals'))
  );
}

async function test_helper_isSTName() {
  assert('ST 前缀', isSTName('ST华信') === true);
  assert('*ST 前缀', isSTName('*ST天夏') === true);
  assert('S 前缀（旧）', isSTName('S 石化') === true);
  assert('正常名不被误判', isSTName('贵州茅台') === false);
  assert('空名安全', isSTName('') === false);
  assert('undefined 安全', isSTName(undefined) === false);
  assert('null 安全', isSTName(null) === false);
  assert('小写 st 也被识别（toUpperCase）', isSTName('st华信') === true);
}

async function test_helper_isNewerThan() {
  assert('21 天前上市 < 60 → true', isNewerThan('2026-05-15', '2026-06-05', 60) === true);
  assert('92 天前上市 > 60 → false', isNewerThan('2026-03-05', '2026-06-05', 60) === false);
  assert('未来上市日（异常）→ true', isNewerThan('2027-01-01', '2026-06-05', 60) === true);
  assert('listing_date 缺失 → false', isNewerThan(null, '2026-06-05', 60) === false);
  assert('listing_date 空串 → false', isNewerThan('', '2026-06-05', 60) === false);
  assert('30 天阈值: 21 天 < 30', isNewerThan('2026-05-15', '2026-06-05', 30) === true);
  assert('30 天阈值: 31 天 > 30', isNewerThan('2026-05-05', '2026-06-05', 30) === false);
}

async function test_invalid_trade_date_throws() {
  const s = new MultiFactorAlphaStrategy(buildFakeDataSource([]));
  let threw = false;
  try {
    await s.generateSignals('20260605');
  } catch (e) {
    threw = true;
    assert(
      '错误信息含 YYYY-MM-DD',
      String((e as Error).message).includes('YYYY-MM-DD')
    );
  }
  assert('非 ISO 日期被拒', threw);

  let threw2 = false;
  try {
    await s.generateSignals('2026-13-05');
  } catch {
    threw2 = true;
  }
  // 我们的正则只校验格式，13 月会通过；这条文档化预期行为
  assert(
    '正则只校验格式（13 月通过—这是预期；调用方应保证日期有效）',
    !threw2,
    'format-only regex 故意宽松'
  );
}

async function test_empty_universe_returns_empty_portfolio() {
  const s = new MultiFactorAlphaStrategy(buildFakeDataSource([]));
  const r = await s.generateSignals('2026-06-05');
  expectEqual('空 universe → target 空', r.target_portfolio, []);
  expectEqual('空 universe → signals 空', r.signals, []);
  expectEqual('空 universe → universe_size = 0', r.universe_size, 0);
}

async function test_topN_caps_output() {
  // 5 只候选，topN=3 → 输出 3 只
  const ds = buildFakeDataSource([
    { code: 'A1', name: 'A1', industry: 'A', factor_z: { value: 5 } },
    { code: 'A2', name: 'A2', industry: 'A', factor_z: { value: 4 } },
    { code: 'A3', name: 'A3', industry: 'A', factor_z: { value: 3 } },
    { code: 'A4', name: 'A4', industry: 'A', factor_z: { value: 2 } },
    { code: 'A5', name: 'A5', industry: 'A', factor_z: { value: 1 } },
  ]);
  const s = new MultiFactorAlphaStrategy(ds);
  // 关掉行业中性以让 5 只同行业都能进
  const r = await s.generateSignals('2026-06-05', {
    params: { topN: 3, industryNeutral: false },
  });
  expectEqual('topN=3 切顶', r.target_portfolio.length, 3);
  expectEqual('topN 取 composite top-3', r.target_portfolio, ['A1', 'A2', 'A3']);
}

// ================================================================
// US-081: weightMode 测试
// ================================================================

async function test_weight_mode_static_is_default_equiv_us011() {
  // weightMode='static'（不传或显式传）应当完全等价 US-011 旧行为
  // value=10, momentum=10, 其他 0 + default weights (value=0.10, momentum=0.10)
  // composite = 10 * 0.10 + 10 * 0.10 = 2.0
  const ds = buildFakeDataSource([
    {
      code: '600519',
      name: '贵州茅台',
      industry: '食品饮料',
      factor_z: { value: 10, momentum: 10 },
    },
  ]);
  const s = new MultiFactorAlphaStrategy(ds);

  // 不传 weightMode（默认 'static'）
  const r1 = await s.generateSignals('2026-06-05');
  assert(
    'weightMode 默认 = static',
    r1.params.weightMode === 'static',
    `got ${r1.params.weightMode}`
  );
  assert(
    'static (default): composite ≈ 2.0',
    Math.abs(r1.signals[0].composite_score - 2.0) < 1e-9,
    `got ${r1.signals[0].composite_score}`
  );

  // 显式传 weightMode='static' 与默认完全一致
  const r2 = await s.generateSignals('2026-06-05', { params: { weightMode: 'static' } });
  assert(
    'static (explicit): composite 与默认一致',
    Math.abs(r2.signals[0].composite_score - r1.signals[0].composite_score) < 1e-12
  );

  // static / equal mode 不查 IC 表
  expectEqual(
    'static mode 不调 loadRecentFactorICs',
    ds.icCallCount,
    0
  );
}

async function test_weight_mode_equal_uniform_weights() {
  // weightMode='equal' = 12 个正权重因子各 1/12
  // 12 因子全 z=1 → composite = sum(1 * 1/12) * 12 = 1.0（与 static 全 z=1 结果一致）
  const ds = buildFakeDataSource([
    {
      code: '600519',
      name: '贵州茅台',
      industry: '食品饮料',
      factor_z: {
        value: 1,
        quality: 1,
        growth: 1,
        momentum: 1,
        low_vol: 1,
        northbound: 1,
        money_flow: 1,
        dragon_tiger: 1,
        quality_high: 1,
        analyst_consensus: 1,
        east_money_qa: 1,
        momentum_reversal: 1,
      },
    },
  ]);
  const s = new MultiFactorAlphaStrategy(ds);
  const r = await s.generateSignals('2026-06-05', { params: { weightMode: 'equal' } });
  assert(
    'equal mode: 全 z=1 → composite=1.0',
    Math.abs(r.signals[0].composite_score - 1.0) < 1e-9,
    `got ${r.signals[0].composite_score}`
  );

  // value=12, 其他 0 + equal mode → composite = 12 * (1/12) = 1.0
  const ds2 = buildFakeDataSource([
    {
      code: '600519',
      name: '贵州茅台',
      industry: '食品饮料',
      factor_z: { value: 12 },
    },
  ]);
  const s2 = new MultiFactorAlphaStrategy(ds2);
  const r2 = await s2.generateSignals('2026-06-05', { params: { weightMode: 'equal' } });
  assert(
    'equal mode: value=12 其他 0 → composite = 12 * 1/12 = 1.0',
    Math.abs(r2.signals[0].composite_score - 1.0) < 1e-9,
    `got ${r2.signals[0].composite_score}`
  );

  // equal mode 不查 IC 表
  expectEqual(
    'equal mode 不调 loadRecentFactorICs',
    ds.icCallCount,
    0
  );
}

async function test_weight_mode_ic_weighted_dynamic_weights() {
  // weightMode='ic_weighted' + IC: {value: 0.10, momentum: 0.05}（其余因子无 IC 数据，per-factor fallback to static）
  // 构造股票：value z=10, momentum z=5
  // computeEffectiveWeights: value=0.10 (来自 IC), momentum=0.05 (来自 IC),
  //   其余因子 = static weights (quality=0.10, growth=0.10, ..., 12 项)
  //   注意因 fixture 中其他因子 z=0 → 不贡献 composite
  // 归一化后 value+momentum 占总权重 = 0.15 / (0.10 + 0.05 + 0.32 [4 老因子 sum] + 0.06 + 0.07*2 + 0.08*4)
  //   = 0.15 / (0.15 + 0.32 + 0.06 + 0.14 + 0.32) = 0.15 / 0.99 ≈ 0.1515
  // composite = 10 * (0.10/0.99) + 5 * (0.05/0.99)
  //           = (1.0 + 0.25) / 0.99 = 1.25 / 0.99 ≈ 1.2626
  // 实际上 value+momentum 之外的因子 z=0 不贡献 composite，所以最终 composite 只取决于这两个的归一化权重
  // 重要的是：value 的权重 > momentum 的权重（因 IC 0.10 > 0.05），所以 composite > 单看 momentum
  const icMap = new Map<string, number>([
    ['value', 0.1],
    ['momentum', 0.05],
  ]);
  const ds = buildFakeDataSource(
    [
      {
        code: '600519',
        name: '贵州茅台',
        industry: '食品饮料',
        factor_z: { value: 10, momentum: 5 },
      },
    ],
    icMap
  );
  const s = new MultiFactorAlphaStrategy(ds);
  const r = await s.generateSignals('2026-06-05', { params: { weightMode: 'ic_weighted' } });

  // 调了 loadRecentFactorICs 一次
  expectEqual('ic_weighted mode 调 loadRecentFactorICs', ds.icCallCount, 1);
  // 入参透传正确
  assert(
    'ic_weighted: factorNames 含 value/momentum',
    !!ds.lastIcCallArgs?.factorNames.includes('value') &&
      !!ds.lastIcCallArgs?.factorNames.includes('momentum')
  );
  expectEqual(
    'ic_weighted: lookForwardDays 透传 default 20',
    ds.lastIcCallArgs?.lookForwardDays,
    20
  );
  expectEqual(
    'ic_weighted: lookbackDays 透传 default 90',
    ds.lastIcCallArgs?.lookbackDays,
    90
  );

  // composite 应当 > 0（IC 用了正值）
  assert(
    'ic_weighted: composite > 0',
    r.signals[0].composite_score > 0,
    `got ${r.signals[0].composite_score}`
  );

  // 等价的纯函数验证：computeEffectiveWeights 应当让 value 的 effective weight = 0.10
  const eff = computeEffectiveWeights(
    { ...DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS },
    'ic_weighted',
    icMap
  );
  expectEqual('ic_weighted effective: value = 0.10 (from IC)', eff.value, 0.1);
  expectEqual('ic_weighted effective: momentum = 0.05 (from IC)', eff.momentum, 0.05);
  // 其他因子无 IC 数据 → fallback to static weight
  expectEqual('ic_weighted effective: quality = 0.10 (fallback static)', eff.quality, 0.1);
  expectEqual('ic_weighted effective: growth = 0.10 (fallback static)', eff.growth, 0.1);
  expectEqual(
    'ic_weighted effective: east_money_qa = 0.06 (fallback static)',
    eff.east_money_qa,
    0.06
  );
}

async function test_weight_mode_ic_weighted_all_negative_fallback_to_static() {
  // 所有 IC 都 ≤ 0 → 整体回退到 static weights（不允许 normalize 后全 0）
  const icMap = new Map<string, number>([
    ['value', -0.05],
    ['quality', -0.03],
    ['growth', 0],
    ['momentum', -0.01],
    ['low_vol', 0],
    ['northbound', -0.02],
    ['money_flow', 0],
    ['dragon_tiger', -0.01],
    ['quality_high', 0],
    ['analyst_consensus', 0],
    ['east_money_qa', 0],
    ['momentum_reversal', 0],
  ]);
  const eff = computeEffectiveWeights(
    { ...DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS },
    'ic_weighted',
    icMap
  );

  // 整体 fallback：与 static weights 相同
  expectEqual(
    'all IC ≤ 0 → fallback static.value',
    eff.value,
    DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS.value
  );
  expectEqual(
    'all IC ≤ 0 → fallback static.momentum_reversal',
    eff.momentum_reversal,
    DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS.momentum_reversal
  );
}

async function test_compute_effective_weights_pure_function() {
  const staticW = { value: 0.5, quality: 0.3, growth: 0.2 };

  // static mode = identity
  const eStatic = computeEffectiveWeights(staticW, 'static');
  expectEqual('static mode = identity', eStatic, staticW);

  // equal mode = 所有 > 0 因子赋 1.0（normalize 后等价 1/N）
  const eEqual = computeEffectiveWeights(staticW, 'equal');
  expectEqual('equal mode: value = 1.0', eEqual.value, 1.0);
  expectEqual('equal mode: quality = 1.0', eEqual.quality, 1.0);
  expectEqual('equal mode: growth = 1.0', eEqual.growth, 1.0);

  // ic_weighted, 全部都有正 IC → 完全用 IC
  const icAllPositive = new Map<string, number>([
    ['value', 0.10],
    ['quality', 0.05],
    ['growth', 0.02],
  ]);
  const eIc = computeEffectiveWeights(staticW, 'ic_weighted', icAllPositive);
  expectEqual('ic_weighted all positive: value = 0.10', eIc.value, 0.1);
  expectEqual('ic_weighted all positive: quality = 0.05', eIc.quality, 0.05);
  expectEqual('ic_weighted all positive: growth = 0.02', eIc.growth, 0.02);

  // ic_weighted, 部分缺失 → 缺的用 static 兜底
  const icPartial = new Map<string, number>([['value', 0.10]]);
  const eIcPartial = computeEffectiveWeights(staticW, 'ic_weighted', icPartial);
  expectEqual('ic_weighted partial: value 用 IC', eIcPartial.value, 0.1);
  expectEqual('ic_weighted partial: quality fallback static', eIcPartial.quality, 0.3);
  expectEqual('ic_weighted partial: growth fallback static', eIcPartial.growth, 0.2);

  // ic_weighted, 部分负 IC + 部分正 IC → 负的用 static 兜底，正的用 IC
  const icMixed = new Map<string, number>([
    ['value', 0.10],
    ['quality', -0.05],
    ['growth', 0],
  ]);
  const eIcMixed = computeEffectiveWeights(staticW, 'ic_weighted', icMixed);
  expectEqual('ic_weighted mixed: value 用正 IC', eIcMixed.value, 0.1);
  expectEqual('ic_weighted mixed: quality 用 static (因 IC<0)', eIcMixed.quality, 0.3);
  expectEqual('ic_weighted mixed: growth 用 static (因 IC=0)', eIcMixed.growth, 0.2);

  // ic_weighted, icMap=undefined → 全部 fallback static
  const eIcMissing = computeEffectiveWeights(staticW, 'ic_weighted');
  expectEqual('ic_weighted icMap undefined: 全部 fallback static', eIcMissing, staticW);

  // ic_weighted, 全部 IC 都 ≤ 0 → 整体 fallback static
  const icAllNegative = new Map<string, number>([
    ['value', -0.10],
    ['quality', -0.05],
    ['growth', 0],
  ]);
  const eIcAllNeg = computeEffectiveWeights(staticW, 'ic_weighted', icAllNegative);
  expectEqual('ic_weighted 全负 IC: 整体 fallback static', eIcAllNeg, staticW);

  // 边界：staticW 中权重为 0 / 负 → 在所有 mode 下 effective = 0
  const staticWithZero = { value: 0.5, quality: 0, growth: -0.1 };
  const eEqualWithZero = computeEffectiveWeights(staticWithZero, 'equal');
  expectEqual('equal mode: quality=0 → effective=0', eEqualWithZero.quality, 0);
  expectEqual('equal mode: growth=-0.1 → effective=0', eEqualWithZero.growth, 0);
}

async function test_weight_mode_ic_weighted_overrides_lookback() {
  // 验证 icLookForwardDays / icLookbackDays 参数透传到 DataSource
  const ds = buildFakeDataSource([
    { code: '600519', name: '贵州茅台', industry: '食品饮料', factor_z: { value: 5 } },
  ]);
  const s = new MultiFactorAlphaStrategy(ds);
  await s.generateSignals('2026-06-05', {
    params: {
      weightMode: 'ic_weighted',
      icLookForwardDays: 5,
      icLookbackDays: 30,
    },
  });
  expectEqual('icLookForwardDays 覆盖透传', ds.lastIcCallArgs?.lookForwardDays, 5);
  expectEqual('icLookbackDays 覆盖透传', ds.lastIcCallArgs?.lookbackDays, 30);
}

// ----------------------------------------------------------------
// Runner
// ----------------------------------------------------------------

const tests: Array<() => Promise<void>> = [
  test_default_weights_match_AC,
  test_default_params_are_AC_defaults,
  test_composite_score_weighted_sum,
  test_industry_neutral_caps_per_industry,
  test_excludeST_filters_ST_names,
  test_excludeNew60d_filters_recent_listings,
  test_no_factor_data_filtered_out,
  test_stable_sort_on_tie,
  test_previous_selection_emits_buy_sell_hold,
  test_first_open_position_all_buy,
  test_custom_weights_are_normalized,
  test_evaluate_returns_informational_hold,
  test_helper_isSTName,
  test_helper_isNewerThan,
  test_invalid_trade_date_throws,
  test_empty_universe_returns_empty_portfolio,
  test_topN_caps_output,
  // US-081
  test_weight_mode_static_is_default_equiv_us011,
  test_weight_mode_equal_uniform_weights,
  test_weight_mode_ic_weighted_dynamic_weights,
  test_weight_mode_ic_weighted_all_negative_fallback_to_static,
  test_compute_effective_weights_pure_function,
  test_weight_mode_ic_weighted_overrides_lookback,
];

(async () => {
  console.log(`\n=== MultiFactorAlphaStrategy unit tests (${tests.length}) ===\n`);
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
