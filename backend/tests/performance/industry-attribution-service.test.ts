/**
 * IndustryAttributionService 单元测试（US-046）
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/performance/industry-attribution-service.test.ts
 *
 * 完全脱离 DB：注入 fake IndustryDataSource + in-memory trades；persist=false 跳过写库。
 *
 * 覆盖维度：
 *   - 纯函数：
 *     normalizeIndustryName / isClosedTrade / deriveHoldingDays /
 *     aggregateTradesByIndustry / computeContributionMetrics / sortAttributionsByContribution
 *   - 常量校验：UNKNOWN_INDUSTRY_LABEL / DEFAULT_SOURCE
 *   - end-to-end computeAttribution()：
 *     - happy path：3 个行业 + contribution / win_rate / avg_hold_days 都算对
 *     - 未平仓 trade 不计入（sell_date 缺失）
 *     - 缺 pnl / NaN pnl 不计入
 *     - symbol 不在 industry_map → 归 "其他"
 *     - in-memory 模式 vs result_id 模式优先级
 *     - 缺 initial_capital → 抛错
 *     - 缺 trades / result_id → 抛错
 *     - in-memory period 派生
 *     - data_source 注入 + 加载失败抛错
 *     - 排序：|contribution| 降序 + industry_code ASC tie-break
 *     - admin 方法（getRun / listRecentRuns / deleteRun / cleanupOlderThan）— 不走 DB 仅覆盖签名 + boundary
 */

import {
  IndustryAttributionService,
  IndustryDataSource,
  TradeRecord,
  IndustryGroup,
  IndustryAttribution,
  normalizeIndustryName,
  isClosedTrade,
  deriveHoldingDays,
  aggregateTradesByIndustry,
  computeContributionMetrics,
  sortAttributionsByContribution,
  UNKNOWN_INDUSTRY_LABEL,
  DEFAULT_SOURCE,
} from '../../src/quant/performance/IndustryAttributionService';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertApprox(name: string, actual: number, expected: number, eps = 1e-6): void {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) < eps;
  assert(name, ok, `actual=${actual} expected=${expected}`);
}

function assertNull(name: string, actual: any): void {
  assert(name, actual === null, `actual=${JSON.stringify(actual)}`);
}

// ============================================================
// fixtures
// ============================================================

function makeTrade(
  symbol: string,
  buy_date: string,
  sell_date: string | null,
  pnl: number | null,
  amount: number,
  holding_days: number | null = null
): TradeRecord {
  return { symbol, buy_date, sell_date: sell_date as any, pnl: pnl as any, amount, holding_days };
}

function makeFakeDataSource(
  fixtures: Record<number, Parameters<IndustryDataSource['loadAttributionContext']>[0] extends number ? any : never>
): IndustryDataSource {
  return {
    async loadAttributionContext(result_id) {
      return (fixtures as any)[result_id] || null;
    },
  };
}

// ============================================================
// 常量校验
// ============================================================

(function testConstants() {
  assert('UNKNOWN_INDUSTRY_LABEL = "其他"', UNKNOWN_INDUSTRY_LABEL === '其他');
  assert('DEFAULT_SOURCE = "industry_attribution_service"', DEFAULT_SOURCE === 'industry_attribution_service');
})();

// ============================================================
// 纯函数：normalizeIndustryName
// ============================================================

(function testNormalizeIndustryName() {
  assert('null → "其他"', normalizeIndustryName(null) === '其他');
  assert('undefined → "其他"', normalizeIndustryName(undefined) === '其他');
  assert('空字符串 → "其他"', normalizeIndustryName('') === '其他');
  assert('全空格 → "其他"', normalizeIndustryName('   ') === '其他');
  assert('正常中文 → 原样', normalizeIndustryName('银行') === '银行');
  assert('前后空格 trim', normalizeIndustryName('  半导体  ') === '半导体');
  assert('数字类型 → "其他"', normalizeIndustryName(123) === '其他');
  assert('object → "其他"', normalizeIndustryName({}) === '其他');
  assert('array → "其他"', normalizeIndustryName([]) === '其他');
})();

// ============================================================
// 纯函数：isClosedTrade
// ============================================================

(function testIsClosedTrade() {
  const closed = makeTrade('600519.SH', '2024-01-01', '2024-01-05', 100, 5000);
  const unsold = makeTrade('600519.SH', '2024-01-01', null, null, 5000);
  const nullPnl = makeTrade('600519.SH', '2024-01-01', '2024-01-05', null, 5000);
  const nanPnl = makeTrade('600519.SH', '2024-01-01', '2024-01-05', NaN, 5000);
  const emptySellDate = { ...closed, sell_date: '' };
  const undefinedSellDate = { ...closed, sell_date: undefined };

  assert('正常已平仓 → true', isClosedTrade(closed));
  assert('未平仓 → false', !isClosedTrade(unsold));
  assert('null pnl → false', !isClosedTrade(nullPnl));
  assert('NaN pnl → false', !isClosedTrade(nanPnl));
  assert('空 sell_date → false', !isClosedTrade(emptySellDate));
  assert('undefined sell_date → false', !isClosedTrade(undefinedSellDate));

  // 0 pnl 应算已平仓
  const zeroPnl = makeTrade('600519.SH', '2024-01-01', '2024-01-05', 0, 5000);
  assert('pnl=0 → true（损益持平也算 closed）', isClosedTrade(zeroPnl));

  // 负 pnl 应算已平仓
  const lossTrade = makeTrade('600519.SH', '2024-01-01', '2024-01-05', -200, 5000);
  assert('负 pnl → true', isClosedTrade(lossTrade));
})();

// ============================================================
// 纯函数：deriveHoldingDays
// ============================================================

(function testDeriveHoldingDays() {
  const t1 = makeTrade('A', '2024-01-01', '2024-01-05', 10, 1000, 4);
  assert('holding_days 字段优先', deriveHoldingDays(t1) === 4);

  const t2 = makeTrade('A', '2024-01-01', '2024-01-05', 10, 1000, null);
  assert('null holding_days 派生 → 4', deriveHoldingDays(t2) === 4);

  const t3 = makeTrade('A', '2024-01-01', null, null, 1000, null);
  assert('未平仓 → 0', deriveHoldingDays(t3) === 0);

  // 负差值 clamp
  const t4 = makeTrade('A', '2024-01-05', '2024-01-01', 10, 1000, null);
  assert('负差值 clamp 到 0', deriveHoldingDays(t4) === 0);

  // 非法日期
  const t5 = makeTrade('A', 'invalid-date', '2024-01-05', 10, 1000, null);
  assert('非法 buy_date → 0', deriveHoldingDays(t5) === 0);
})();

// ============================================================
// 纯函数：aggregateTradesByIndustry
// ============================================================

(function testAggregateTradesByIndustry() {
  const trades: TradeRecord[] = [
    makeTrade('600519.SH', '2024-01-01', '2024-01-05', 1000, 50000, 4), // 银行
    makeTrade('600036.SH', '2024-01-02', '2024-01-06', -500, 30000, 4), // 银行
    makeTrade('000725.SZ', '2024-01-03', '2024-01-08', 2000, 20000, 5), // 半导体
    makeTrade('999999.SH', '2024-01-04', '2024-01-09', 100, 10000, 5), // 不在 map → 其他
    makeTrade('600519.SH', '2024-01-05', null, null, 50000), // 未平仓 → 跳过
  ];
  const industry_map: Record<string, string> = {
    '600519.SH': '银行',
    '600036.SH': '银行',
    '000725.SZ': '半导体',
    // 999999.SH 缺失
  };

  const groups = aggregateTradesByIndustry(trades, industry_map);

  assert('3 个行业（银行 / 半导体 / 其他）', groups.size === 3);

  const bank = groups.get('银行')!;
  assert('银行 group 存在', !!bank);
  assert('银行 trade_count=2', bank.trade_count === 2);
  assert('银行 winning=1', bank.winning_count === 1);
  assert('银行 losing=1', bank.losing_count === 1);
  assertApprox('银行 total_pnl=500', bank.total_pnl, 500);
  assert('银行 total_holding_days=8', bank.total_holding_days === 8);

  const semi = groups.get('半导体')!;
  assert('半导体 trade_count=1', semi.trade_count === 1);
  assertApprox('半导体 total_pnl=2000', semi.total_pnl, 2000);

  const other = groups.get('其他')!;
  assert('其他 trade_count=1', other.trade_count === 1);
  assertApprox('其他 total_pnl=100', other.total_pnl, 100);

  // 验证 industry_code === industry_name (US-046 当前实现)
  assert('industry_code == industry_name (银行)', bank.industry_code === bank.industry_name);
  assert('industry_code == industry_name (其他)', other.industry_code === other.industry_name);

  // 验证 industry_map 值经 normalize（前后空格 trim）
  const trades2: TradeRecord[] = [makeTrade('A', '2024-01-01', '2024-01-05', 100, 1000, 4)];
  const map2 = { A: '  医药生物  ' };
  const groups2 = aggregateTradesByIndustry(trades2, map2);
  assert('industry_map 值 trim 后归组', groups2.has('医药生物'));

  // 空 trades
  const emptyGroups = aggregateTradesByIndustry([], {});
  assert('空 trades → 空 groups', emptyGroups.size === 0);

  // 全部未平仓
  const allUnsold: TradeRecord[] = [
    makeTrade('A', '2024-01-01', null, null, 1000),
    makeTrade('B', '2024-01-01', null, null, 1000),
  ];
  const emptyGroups2 = aggregateTradesByIndustry(allUnsold, { A: 'X', B: 'Y' });
  assert('全未平仓 → 空 groups', emptyGroups2.size === 0);
})();

// ============================================================
// 纯函数：computeContributionMetrics
// ============================================================

(function testComputeContributionMetrics() {
  const g: IndustryGroup = {
    industry_code: '银行',
    industry_name: '银行',
    total_pnl: 5000,
    trade_count: 4,
    winning_count: 3,
    losing_count: 1,
    total_volume: 200000,
    total_holding_days: 20,
  };
  const attr = computeContributionMetrics(g, 100000);
  assertApprox('contribution_pct = 5000/100000*100 = 5', attr.contribution_pct, 5);
  assertApprox('win_rate = 3/4 = 0.75', attr.win_rate as number, 0.75);
  assertApprox('avg_hold_days = 20/4 = 5', attr.avg_hold_days as number, 5);
  assert('trade_count = 4', attr.trade_count === 4);
  assert('winning_count = 3', attr.winning_count === 3);
  assert('losing_count = 1', attr.losing_count === 1);
  assertApprox('total_pnl 物化', attr.total_pnl, 5000);
  assertApprox('total_volume 物化', attr.total_volume, 200000);
  assert('industry_code = 银行', attr.industry_code === '银行');
  assert('industry_name = 银行', attr.industry_name === '银行');

  // 空 group (trade_count = 0)
  const emptyG: IndustryGroup = {
    industry_code: '其他',
    industry_name: '其他',
    total_pnl: 0,
    trade_count: 0,
    winning_count: 0,
    losing_count: 0,
    total_volume: 0,
    total_holding_days: 0,
  };
  const emptyAttr = computeContributionMetrics(emptyG, 100000);
  assertApprox('空 group contribution=0', emptyAttr.contribution_pct, 0);
  assertNull('空 group win_rate=null', emptyAttr.win_rate);
  assertNull('空 group avg_hold_days=null', emptyAttr.avg_hold_days);

  // initial_capital = 0 → contribution = 0（无业务意义）
  const zeroCap = computeContributionMetrics(g, 0);
  assertApprox('initial_capital=0 → contribution=0', zeroCap.contribution_pct, 0);

  // initial_capital 负数 → 0
  const negCap = computeContributionMetrics(g, -100);
  assertApprox('initial_capital<0 → contribution=0', negCap.contribution_pct, 0);

  // 负 contribution（亏损行业）
  const lossG: IndustryGroup = { ...g, total_pnl: -3000, winning_count: 1, losing_count: 3 };
  const lossAttr = computeContributionMetrics(lossG, 100000);
  assertApprox('负 contribution', lossAttr.contribution_pct, -3);
  assertApprox('低 win_rate = 0.25', lossAttr.win_rate as number, 0.25);
})();

// ============================================================
// 纯函数：sortAttributionsByContribution
// ============================================================

(function testSortAttributions() {
  const make = (code: string, contrib: number): IndustryAttribution => ({
    industry_code: code,
    industry_name: code,
    contribution_pct: contrib,
    total_pnl: contrib * 1000,
    win_rate: 0.5,
    avg_hold_days: 5,
    trade_count: 1,
    winning_count: 1,
    losing_count: 0,
    total_volume: 1000,
  });

  // |contribution| 降序
  const sorted = sortAttributionsByContribution([
    make('A', 2),
    make('B', -8),
    make('C', 5),
    make('D', 1),
  ]);
  assert('排序后 B 在最前 (|-8| 最大)', sorted[0].industry_code === 'B');
  assert('排序后 C 第二 (|5| = 5)', sorted[1].industry_code === 'C');
  assert('排序后 A 第三 (|2| = 2)', sorted[2].industry_code === 'A');
  assert('排序后 D 最后 (|1| = 1)', sorted[3].industry_code === 'D');

  // tie-break by industry_code ASC
  const tied = sortAttributionsByContribution([
    make('Z', 5),
    make('A', -5),
    make('M', 5),
  ]);
  // |5| 相同 → industry_code ASC = A → M → Z
  assert('tie-break: A 在最前', tied[0].industry_code === 'A');
  assert('tie-break: M 第二', tied[1].industry_code === 'M');
  assert('tie-break: Z 最后', tied[2].industry_code === 'Z');

  // 不 mutate 输入
  const input = [make('X', 1)];
  const result = sortAttributionsByContribution(input);
  assert('不 mutate 输入', result !== input);

  // 空数组
  assert('空数组 → 空', sortAttributionsByContribution([]).length === 0);

  // 单元素
  const single = sortAttributionsByContribution([make('X', 5)]);
  assert('单元素 → 长度 1', single.length === 1);
})();

// ============================================================
// end-to-end: computeAttribution() in-memory mode
// ============================================================

async function testE2EInMemoryHappyPath() {
  const service = new IndustryAttributionService();
  const trades: TradeRecord[] = [
    makeTrade('600519.SH', '2024-01-01', '2024-01-05', 1000, 50000, 4),
    makeTrade('600036.SH', '2024-01-02', '2024-01-06', -500, 30000, 4),
    makeTrade('000725.SZ', '2024-01-03', '2024-01-08', 2000, 20000, 5),
    makeTrade('999999.SH', '2024-01-04', '2024-01-09', 100, 10000, 5),
  ];
  const symbol_to_industry: Record<string, string> = {
    '600519.SH': '银行',
    '600036.SH': '银行',
    '000725.SZ': '半导体',
  };

  const result = await service.computeAttribution(
    {
      trades,
      initial_capital: 100000,
      symbol_to_industry,
      strategy_key: 'test_strategy',
      period_start: '2024-01-01',
      period_end: '2024-01-09',
    },
    { persist: false }
  );

  assert('in-memory: 3 个行业', result.attributions.length === 3);
  assert('in-memory: strategy_key 透传', result.strategy_key === 'test_strategy');
  assertNull('in-memory: run_id=null (无 result_id)', result.run_id);
  assert('in-memory: persisted_ids 全 null', result.persisted_ids.every(id => id === null));
  assert('in-memory: duration_ms >= 0', result.duration_ms >= 0);

  // total_contribution = (1000 - 500 + 2000 + 100) / 100000 * 100 = 2.6%
  assertApprox('in-memory: total_contribution ≈ 2.6%', result.total_contribution_pct, 2.6);

  // 排序：|2.0| (半导体) > |0.5| (银行: (1000-500)/100000) > |0.1| (其他)
  assert('排序: 第一 = 半导体', result.attributions[0].industry_name === '半导体');
  assertApprox('半导体 contribution = 2.0', result.attributions[0].contribution_pct, 2.0);
  assert('排序: 第二 = 银行', result.attributions[1].industry_name === '银行');
  assertApprox('银行 contribution = 0.5', result.attributions[1].contribution_pct, 0.5);
  assert('排序: 第三 = 其他', result.attributions[2].industry_name === '其他');
  assertApprox('其他 contribution = 0.1', result.attributions[2].contribution_pct, 0.1);

  // 银行 win_rate = 1/2 = 0.5
  assertApprox('银行 win_rate = 0.5', result.attributions[1].win_rate as number, 0.5);
  // 银行 avg_hold_days = (4+4)/2 = 4
  assertApprox('银行 avg_hold = 4', result.attributions[1].avg_hold_days as number, 4);
}

async function testE2EUnsoldTradesIgnored() {
  const service = new IndustryAttributionService();
  const trades: TradeRecord[] = [
    makeTrade('600519.SH', '2024-01-01', '2024-01-05', 1000, 50000, 4),
    makeTrade('600519.SH', '2024-01-10', null, null, 50000), // 未平仓
    makeTrade('600519.SH', '2024-01-11', undefined as any, undefined as any, 50000), // 未平仓
  ];
  const result = await service.computeAttribution(
    {
      trades,
      initial_capital: 100000,
      symbol_to_industry: { '600519.SH': '银行' },
      strategy_key: 'test',
      period_start: '2024-01-01',
      period_end: '2024-01-15',
    },
    { persist: false }
  );
  assert('未平仓不计入: 1 个行业', result.attributions.length === 1);
  assert('未平仓不计入: trade_count=1', result.attributions[0].trade_count === 1);
}

async function testE2ENanPnlIgnored() {
  const service = new IndustryAttributionService();
  const trades: TradeRecord[] = [
    makeTrade('A', '2024-01-01', '2024-01-05', 1000, 50000, 4),
    makeTrade('A', '2024-01-10', '2024-01-15', NaN, 50000, 5),
    makeTrade('A', '2024-01-16', '2024-01-20', null, 50000, 4),
  ];
  const result = await service.computeAttribution(
    {
      trades,
      initial_capital: 100000,
      symbol_to_industry: { A: '银行' },
      strategy_key: 'test',
      period_start: '2024-01-01',
      period_end: '2024-01-20',
    },
    { persist: false }
  );
  assert('NaN/null pnl 不计入: 1 个有效 trade', result.attributions[0].trade_count === 1);
}

async function testE2EAllUnsold() {
  const service = new IndustryAttributionService();
  const trades: TradeRecord[] = [
    makeTrade('A', '2024-01-01', null, null, 50000),
    makeTrade('B', '2024-01-02', null, null, 30000),
  ];
  const result = await service.computeAttribution(
    {
      trades,
      initial_capital: 100000,
      symbol_to_industry: { A: '银行', B: '医药' },
      strategy_key: 'test',
      period_start: '2024-01-01',
      period_end: '2024-01-15',
    },
    { persist: false }
  );
  assert('全未平仓: 0 attributions', result.attributions.length === 0);
  assertApprox('全未平仓: total_contribution = 0', result.total_contribution_pct, 0);
}

async function testE2EMissingInitialCapital() {
  const service = new IndustryAttributionService();
  const trades = [makeTrade('A', '2024-01-01', '2024-01-05', 1000, 50000, 4)];
  let threw = false;
  try {
    await service.computeAttribution(
      {
        trades,
        // initial_capital: 缺失
        symbol_to_industry: { A: '银行' },
        strategy_key: 'test',
        period_start: '2024-01-01',
        period_end: '2024-01-05',
      },
      { persist: false }
    );
  } catch (e: any) {
    threw = true;
    assert('缺 initial_capital 抛错 msg 含 initial_capital', e.message.includes('initial_capital'));
  }
  assert('缺 initial_capital → 抛错', threw);
}

async function testE2EMissingInput() {
  const service = new IndustryAttributionService();
  let threw = false;
  try {
    await service.computeAttribution({}, { persist: false });
  } catch (e: any) {
    threw = true;
    assert('缺 input msg 含 result_id', e.message.includes('result_id') || e.message.includes('trades'));
  }
  assert('完全缺 input → 抛错', threw);
}

async function testE2EPeriodDerivation() {
  const service = new IndustryAttributionService();
  const trades = [
    makeTrade('A', '2024-02-15', '2024-02-20', 100, 50000, 5),
    makeTrade('B', '2024-02-10', '2024-02-25', 200, 30000, 15),
  ];
  const result = await service.computeAttribution(
    {
      trades,
      initial_capital: 100000,
      symbol_to_industry: { A: '银行', B: '医药' },
      strategy_key: 'test',
      // period_start/end 不传 → 自动从 trades 派生
    },
    { persist: false }
  );
  assert('period 自动派生: 2 attributions', result.attributions.length === 2);
}

async function testE2EPeriodCannotDerive() {
  const service = new IndustryAttributionService();
  let threw = false;
  try {
    await service.computeAttribution(
      {
        trades: [],
        initial_capital: 100000,
        symbol_to_industry: {},
        strategy_key: 'test',
      },
      { persist: false }
    );
  } catch (e: any) {
    threw = true;
    assert('空 trades + 无 period → 抛错 msg 含 period', e.message.includes('period'));
  }
  assert('空 trades + 无 period 派生 → 抛错', threw);
}

async function testE2EDataSourceInjection() {
  const fakeSource: IndustryDataSource = {
    async loadAttributionContext(result_id: number) {
      if (result_id === 99) {
        return {
          trades: [
            makeTrade('A', '2024-01-01', '2024-01-05', 1500, 50000, 4),
            makeTrade('B', '2024-01-02', '2024-01-07', -300, 20000, 5),
          ],
          initial_capital: 100000,
          period_start: '2024-01-01',
          period_end: '2024-01-07',
          strategy_key: 'fake_strategy',
          symbol_to_industry: { A: '银行', B: '半导体' },
        };
      }
      return null;
    },
  };

  const service = new IndustryAttributionService();
  const result = await service.computeAttribution(
    { quant_backtest_result_id: 99 },
    { persist: false, data_source: fakeSource }
  );

  assert('injected source: run_id = 99', result.run_id === 99);
  assert('injected source: strategy_key from source', result.strategy_key === 'fake_strategy');
  assert('injected source: 2 行业', result.attributions.length === 2);
  // 排序: |1.5| > |0.3|
  assert('injected source: 银行第一', result.attributions[0].industry_name === '银行');
  assertApprox('injected source: 银行 contribution = 1.5', result.attributions[0].contribution_pct, 1.5);
}

async function testE2EDataSourceReturnsNull() {
  const fakeSource: IndustryDataSource = {
    async loadAttributionContext() {
      return null;
    },
  };
  const service = new IndustryAttributionService();
  let threw = false;
  try {
    await service.computeAttribution(
      { quant_backtest_result_id: 404 },
      { persist: false, data_source: fakeSource }
    );
  } catch (e: any) {
    threw = true;
    assert('source null 抛错 msg 含 404', e.message.includes('404'));
  }
  assert('source 返回 null → 抛错', threw);
}

async function testE2EDataSourceBadInitialCapital() {
  const fakeSource: IndustryDataSource = {
    async loadAttributionContext() {
      return {
        trades: [makeTrade('A', '2024-01-01', '2024-01-05', 100, 1000, 4)],
        initial_capital: 0, // 无效
        period_start: '2024-01-01',
        period_end: '2024-01-05',
        strategy_key: 's',
        symbol_to_industry: { A: '银行' },
      };
    },
  };
  const service = new IndustryAttributionService();
  let threw = false;
  try {
    await service.computeAttribution(
      { quant_backtest_result_id: 1 },
      { persist: false, data_source: fakeSource }
    );
  } catch (e: any) {
    threw = true;
    assert(
      'source initial_capital=0 抛错',
      e.message.includes('initial_capital') || e.message.includes('0')
    );
  }
  assert('source initial_capital 无效 → 抛错', threw);
}

async function testE2EOverrideStrategyKey() {
  const fakeSource: IndustryDataSource = {
    async loadAttributionContext() {
      return {
        trades: [makeTrade('A', '2024-01-01', '2024-01-05', 100, 1000, 4)],
        initial_capital: 100000,
        period_start: '2024-01-01',
        period_end: '2024-01-05',
        strategy_key: 'from_source',
        symbol_to_industry: { A: '银行' },
      };
    },
  };
  const service = new IndustryAttributionService();
  const r = await service.computeAttribution(
    { quant_backtest_result_id: 1, strategy_key: 'override' },
    { persist: false, data_source: fakeSource }
  );
  assert('input.strategy_key 覆盖 source.strategy_key', r.strategy_key === 'override');
}

async function testE2EInMemoryPrioritizedOverDataSource() {
  const fakeSource: IndustryDataSource = {
    async loadAttributionContext() {
      return {
        trades: [makeTrade('Z', '2024-01-01', '2024-01-05', 9999, 99999, 4)],
        initial_capital: 99999,
        period_start: '2024-01-01',
        period_end: '2024-01-05',
        strategy_key: 'from_source',
        symbol_to_industry: { Z: '科技' },
      };
    },
  };
  const service = new IndustryAttributionService();
  const r = await service.computeAttribution(
    {
      trades: [makeTrade('A', '2024-01-01', '2024-01-05', 100, 1000, 4)],
      initial_capital: 100000,
      symbol_to_industry: { A: '银行' },
      strategy_key: 'in_memory',
      period_start: '2024-01-01',
      period_end: '2024-01-05',
      quant_backtest_result_id: 1, // 即使有也走 in-memory
    },
    { persist: false, data_source: fakeSource }
  );
  assert('in-memory 优先 → 行业 = 银行 而非 科技', r.attributions[0].industry_name === '银行');
  assert('in-memory 优先 → strategy_key = in_memory', r.strategy_key === 'in_memory');
  assert('in-memory 优先 → run_id = 1（仍记录传入的 result_id）', r.run_id === 1);
}

// ============================================================
// admin 方法 (cleanupOlderThan 参数校验 — 不走 DB)
// ============================================================

async function testCleanupParameterValidation() {
  const service = new IndustryAttributionService();
  let threw = false;
  try {
    await service.cleanupOlderThan(0);
  } catch (e: any) {
    threw = true;
    assert('cleanup days=0 抛错 msg 含「正数」', e.message.includes('正数'));
  }
  assert('cleanup days=0 抛错', threw);

  threw = false;
  try {
    await service.cleanupOlderThan(-5);
  } catch {
    threw = true;
  }
  assert('cleanup days=-5 抛错', threw);

  threw = false;
  try {
    await service.cleanupOlderThan(NaN);
  } catch {
    threw = true;
  }
  assert('cleanup days=NaN 抛错', threw);

  threw = false;
  try {
    await service.cleanupOlderThan(Infinity);
  } catch {
    threw = true;
  }
  assert('cleanup days=Infinity 抛错', threw);
}

// ============================================================
// Runner
// ============================================================

async function main() {
  await testE2EInMemoryHappyPath();
  await testE2EUnsoldTradesIgnored();
  await testE2ENanPnlIgnored();
  await testE2EAllUnsold();
  await testE2EMissingInitialCapital();
  await testE2EMissingInput();
  await testE2EPeriodDerivation();
  await testE2EPeriodCannotDerive();
  await testE2EDataSourceInjection();
  await testE2EDataSourceReturnsNull();
  await testE2EDataSourceBadInitialCapital();
  await testE2EOverrideStrategyKey();
  await testE2EInMemoryPrioritizedOverDataSource();
  await testCleanupParameterValidation();

  console.log(`\n=== IndustryAttributionService tests: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
