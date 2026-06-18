/**
 * EarningsSurpriseStrategy 单测（US-013）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/EarningsSurpriseStrategy.test.ts
 *
 * 测试用 FakeDataSource 注入到 EarningsSurpriseStrategy(constructor)，避免任何 DB 依赖。
 *
 * 覆盖：
 *   - 默认参数 (maxPositions=20, holdingDaysLimit=60, stopLossPct=-0.10, lookbackDays=5, minProfitChangeLow=50)
 *   - strategy_definition 元数据正确
 *   - 入场双确认：业绩超预期 + 北向加仓 同时满足才入选
 *   - 入场各维度独立失败：forecast_type 不匹配 / profit_change_low 不足 / 北向缺数据 / 北向未加仓 / ST
 *   - maxPositions cap
 *   - 排序：profit_change_low 降序 + 北向 delta tie-break + stock_code 稳定 tie-break
 *   - 出场：持有期到期 / 止损 / 缺数据 HOLD / 默认 HOLD
 *   - 出场优先级：holdingDaysLimit > stopLoss
 *   - HOLD 占用槽位限 BUY 数
 *   - 已持仓股票当日发预告不重复 BUY
 *   - evaluate() 信息性 hold + factors.note
 *   - helper computeIsSurprise / naturalDaysBetween / isQuarterEnd / isSTName 边角
 *   - invalid trade_date 抛出
 *   - 空 universe 安全
 *   - 自定义 params override
 */

import {
  DEFAULT_EARNINGS_SURPRISE_PARAMS,
  EarningsForecastRow,
  EarningsSurpriseDataSource,
  EarningsSurpriseStockMeta,
  EarningsSurpriseStrategy,
  isSTName,
  naturalDaysBetween,
} from '../../src/quant/strategies/EarningsSurpriseStrategy';
import {
  computeIsSurprise,
  isQuarterEnd,
} from '../../src/data/services/EarningsForecastSyncService';

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
  forecasts?: EarningsForecastRow[];
  /** stock_code → ratio_delta（缺则 loadNorthboundRatioDelta 不返回该 code） */
  northboundDeltas?: Map<string, number>;
  meta?: Map<string, EarningsSurpriseStockMeta>;
  /** stock_code → close 价格 */
  dailyClose?: Map<string, number>;
}

class FakeDataSource implements EarningsSurpriseDataSource {
  constructor(public state: FakeFixtures = {}) {}

  async loadAnnouncedForecasts(_tradeDate: string): Promise<EarningsForecastRow[]> {
    return this.state.forecasts ?? [];
  }

  async loadNorthboundRatioDelta(
    _asOfDate: string,
    _lookbackDays: number,
    stockCodes: string[]
  ): Promise<Map<string, number>> {
    const all = this.state.northboundDeltas ?? new Map();
    const out = new Map<string, number>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, EarningsSurpriseStockMeta>> {
    const all = this.state.meta ?? new Map();
    const out = new Map<string, EarningsSurpriseStockMeta>();
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

// ----------------------------------------------------------------
// 测试用例
// ----------------------------------------------------------------

async function test_default_params_match_AC() {
  const def = DEFAULT_EARNINGS_SURPRISE_PARAMS;
  expectEqual('default maxPositions', def.maxPositions, 20);
  expectEqual('default holdingDaysLimit', def.holdingDaysLimit, 60);
  expectEqual('default stopLossPct', def.stopLossPct, -0.1);
  expectEqual('default lookbackDays', def.lookbackDays, 5);
  expectEqual('default minProfitChangeLow', def.minProfitChangeLow, 50);
  expectEqual('default excludeST', def.excludeST, true);
  expectEqual('default surpriseForecastTypes', [...def.surpriseForecastTypes], [
    '预增',
    '扭亏',
    '续盈',
  ]);
}

async function test_strategy_definition_metadata() {
  const s = new EarningsSurpriseStrategy(new FakeDataSource());
  expectEqual('strategy_key', s.definition.strategy_key, 'earnings_surprise');
  expectEqual('category', s.definition.category, 'multi_factor');
  expectEqual('risk_level', s.definition.risk_level, 'medium');
  expectEqual('enabled', s.definition.enabled, true);
  assert('tags 包含 事件驱动', s.definition.tags.includes('事件驱动'));
  assert('tags 包含 业绩预告', s.definition.tags.includes('业绩预告'));
}

async function test_entry_dual_confirmation_passes() {
  // 一个完美样本：预增 + profit_change_low 100% + 北向加仓 0.5pp + 非 ST
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: '贵州茅台',
        forecast_type: '预增',
        profit_change_low: 100,
        profit_change_high: 150,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([['600519', 0.005]]),
    meta: new Map([['600519', { name: '贵州茅台', industry: '食品饮料' }]]),
    dailyClose: new Map([['600519', 1700]]),
  });
  const s = new EarningsSurpriseStrategy(ds);
  const r = await s.generateSignals('2024-10-15');
  expectEqual('eligible_count', r.eligible_count, 1);
  const buys = r.signals.filter(x => x.signal === 'buy');
  expectEqual('buy 1 只', buys.length, 1);
  expectEqual('buy stock_code', buys[0].stock_code, '600519');
  expectEqual('buy.forecast_type', buys[0].forecast_type, '预增');
  expectEqual('buy.profit_change_low', buys[0].profit_change_low, 100);
  assert('buy.northbound_ratio_delta > 0', (buys[0].northbound_ratio_delta ?? 0) > 0);
  expectEqual('target_positions has 1', r.target_positions.length, 1);
  expectEqual('target_positions[0].entry_date', r.target_positions[0].entry_date, '2024-10-15');
  expectEqual('target_positions[0].entry_price', r.target_positions[0].entry_price, 1700);
}

async function test_entry_fail_forecast_type_not_surprise() {
  // forecast_type = '预减' 不在白名单 → fail_forecast_type
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: '茅台',
        forecast_type: '预减',
        profit_change_low: 100,
        profit_change_high: 150,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([['600519', 0.005]]),
    meta: new Map([['600519', { name: '茅台', industry: '食品饮料' }]]),
    dailyClose: new Map([['600519', 1700]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('filtered.fail_forecast_type=1', r.filtered.fail_forecast_type, 1);
  expectEqual('no buy signals', r.signals.filter(x => x.signal === 'buy').length, 0);
}

async function test_entry_fail_profit_change_too_low() {
  // profit_change_low = 30 < 50 → fail_profit_change
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: '茅台',
        forecast_type: '预增',
        profit_change_low: 30, // < 50
        profit_change_high: 80,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([['600519', 0.005]]),
    meta: new Map([['600519', { name: '茅台', industry: '食品饮料' }]]),
    dailyClose: new Map([['600519', 1700]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual('filtered.fail_profit_change=1', r.filtered.fail_profit_change, 1);
}

async function test_entry_fail_northbound_missing() {
  // 北向 Map 里没这只股票 → 计入 fail_northbound_missing 但 fail-OPEN 仍入场
  // (2026-06 改动：当 AKShare northbound_holdings 接口失效全市场空时, 不应让整条策略瘫痪;
  //  双确认降级为单确认 (业绩超预期即可入场), 仅 delta != null 且 ≤ 0 才真过滤)
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: '茅台',
        forecast_type: '预增',
        profit_change_low: 80,
        profit_change_high: 120,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map(), // 空 — 该股没有北向数据
    meta: new Map([['600519', { name: '茅台', industry: '食品饮料' }]]),
    dailyClose: new Map([['600519', 1700]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  expectEqual('fail-OPEN: 仍 eligible=1', r.eligible_count, 1);
  expectEqual('filtered.fail_northbound_missing 计入=1 (但放行)', r.filtered.fail_northbound_missing, 1);
}

async function test_entry_fail_northbound_not_increased() {
  // 北向 delta = -0.001 (减仓) → fail_northbound_not_increased
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: '茅台',
        forecast_type: '预增',
        profit_change_low: 80,
        profit_change_high: 120,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([['600519', -0.001]]),
    meta: new Map([['600519', { name: '茅台', industry: '食品饮料' }]]),
    dailyClose: new Map([['600519', 1700]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  expectEqual('no eligible', r.eligible_count, 0);
  expectEqual(
    'filtered.fail_northbound_not_increased=1',
    r.filtered.fail_northbound_not_increased,
    1
  );
}

async function test_entry_fail_northbound_exactly_zero() {
  // 北向 delta = 0 (持平，不算加仓) → fail_northbound_not_increased（边界值）
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: '茅台',
        forecast_type: '预增',
        profit_change_low: 80,
        profit_change_high: 120,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([['600519', 0]]),
    meta: new Map([['600519', { name: '茅台', industry: '食品饮料' }]]),
    dailyClose: new Map([['600519', 1700]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  expectEqual(
    'delta=0 视为未加仓',
    r.filtered.fail_northbound_not_increased,
    1
  );
}

async function test_entry_fail_st_excluded() {
  // 名称含 'ST' → fail_st
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: 'ST华信',
        forecast_type: '扭亏',
        profit_change_low: 200,
        profit_change_high: 300,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([['600519', 0.01]]),
    meta: new Map([['600519', { name: 'ST华信', industry: '其他' }]]),
    dailyClose: new Map([['600519', 5.0]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  expectEqual('ST 过滤', r.eligible_count, 0);
  expectEqual('filtered.fail_st=1', r.filtered.fail_st, 1);
}

async function test_entry_excludeST_false_keeps_ST() {
  // excludeST=false 时 ST 也能入选（其他条件满足）
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: 'ST华信',
        forecast_type: '扭亏',
        profit_change_low: 200,
        profit_change_high: 300,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([['600519', 0.01]]),
    meta: new Map([['600519', { name: 'ST华信', industry: '其他' }]]),
    dailyClose: new Map([['600519', 5.0]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15', {
    params: { excludeST: false },
  });
  expectEqual('ST 不过滤', r.eligible_count, 1);
  expectEqual('filtered.fail_st=0', r.filtered.fail_st, 0);
}

async function test_entry_扭亏_类型() {
  // forecast_type = 扭亏 也是默认白名单之一
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '000001',
        stock_name: '平安银行',
        forecast_type: '扭亏',
        profit_change_low: 60,
        profit_change_high: 100,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([['000001', 0.003]]),
    meta: new Map([['000001', { name: '平安银行', industry: '银行' }]]),
    dailyClose: new Map([['000001', 12]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  expectEqual('扭亏 入选', r.eligible_count, 1);
}

async function test_entry_续盈_类型() {
  // forecast_type = 续盈 也是默认白名单之一
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '000002',
        stock_name: '万科A',
        forecast_type: '续盈',
        profit_change_low: 55,
        profit_change_high: 75,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([['000002', 0.002]]),
    meta: new Map([['000002', { name: '万科A', industry: '房地产' }]]),
    dailyClose: new Map([['000002', 10]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  expectEqual('续盈 入选', r.eligible_count, 1);
}

async function test_max_positions_cap() {
  // 25 个候选 → maxPositions=20 cap
  const forecasts: EarningsForecastRow[] = [];
  const ndelta = new Map<string, number>();
  const meta = new Map<string, EarningsSurpriseStockMeta>();
  const close = new Map<string, number>();
  for (let i = 0; i < 25; i++) {
    const code = `60000${i}`.slice(0, 6).padStart(6, '0').replace(/^/, '6').slice(0, 6);
    const fixedCode = `6${String(i).padStart(5, '0')}`;
    forecasts.push({
      stock_code: fixedCode,
      stock_name: `名${i}`,
      forecast_type: '预增',
      profit_change_low: 100 - i, // 排序差异化
      profit_change_high: 150,
      report_period: '2024-09-30',
    });
    ndelta.set(fixedCode, 0.005);
    meta.set(fixedCode, { name: `名${i}`, industry: '科技' });
    close.set(fixedCode, 10 + i);
  }
  const ds = new FakeDataSource({
    forecasts,
    northboundDeltas: ndelta,
    meta,
    dailyClose: close,
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  expectEqual('eligible_count=25', r.eligible_count, 25);
  const buys = r.signals.filter(x => x.signal === 'buy');
  expectEqual('BUY cap at maxPositions=20', buys.length, 20);
  // 最高 profit_change_low (=100) 的应该在前面
  expectEqual('buy[0].profit_change_low=100', buys[0].profit_change_low, 100);
}

async function test_sort_by_profit_change_low_desc() {
  // 3 只候选，profit_change_low 不同 → 排序正确
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600003',
        stock_name: 'A',
        forecast_type: '预增',
        profit_change_low: 80,
        profit_change_high: 100,
        report_period: '2024-09-30',
      },
      {
        stock_code: '600001',
        stock_name: 'B',
        forecast_type: '预增',
        profit_change_low: 200,
        profit_change_high: 300,
        report_period: '2024-09-30',
      },
      {
        stock_code: '600002',
        stock_name: 'C',
        forecast_type: '预增',
        profit_change_low: 150,
        profit_change_high: 200,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([
      ['600001', 0.001],
      ['600002', 0.001],
      ['600003', 0.001],
    ]),
    meta: new Map([
      ['600001', { name: 'B' }],
      ['600002', { name: 'C' }],
      ['600003', { name: 'A' }],
    ]),
    dailyClose: new Map([
      ['600001', 10],
      ['600002', 20],
      ['600003', 30],
    ]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  const buys = r.signals.filter(x => x.signal === 'buy');
  expectEqual('排序 0: highest profit_change_low (200)', buys[0].stock_code, '600001');
  expectEqual('排序 1: 中间 150', buys[1].stock_code, '600002');
  expectEqual('排序 2: lowest 80', buys[2].stock_code, '600003');
}

async function test_sort_tie_break_stable() {
  // 3 只候选 profit_change_low 相同 + 北向 delta 相同 → 按 stock_code 升序
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600002',
        stock_name: 'B',
        forecast_type: '预增',
        profit_change_low: 100,
        profit_change_high: 120,
        report_period: '2024-09-30',
      },
      {
        stock_code: '600001',
        stock_name: 'A',
        forecast_type: '预增',
        profit_change_low: 100,
        profit_change_high: 120,
        report_period: '2024-09-30',
      },
      {
        stock_code: '600003',
        stock_name: 'C',
        forecast_type: '预增',
        profit_change_low: 100,
        profit_change_high: 120,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([
      ['600001', 0.005],
      ['600002', 0.005],
      ['600003', 0.005],
    ]),
    meta: new Map([
      ['600001', { name: 'A' }],
      ['600002', { name: 'B' }],
      ['600003', { name: 'C' }],
    ]),
    dailyClose: new Map([
      ['600001', 10],
      ['600002', 20],
      ['600003', 30],
    ]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  const buys = r.signals.filter(x => x.signal === 'buy');
  expectEqual('tie-break order[0]', buys[0].stock_code, '600001');
  expectEqual('tie-break order[1]', buys[1].stock_code, '600002');
  expectEqual('tie-break order[2]', buys[2].stock_code, '600003');
}

async function test_sort_tie_break_by_northbound_delta() {
  // 同 profit_change_low 但 delta 不同 → 高 delta 优先
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600001',
        stock_name: 'A',
        forecast_type: '预增',
        profit_change_low: 100,
        profit_change_high: 120,
        report_period: '2024-09-30',
      },
      {
        stock_code: '600002',
        stock_name: 'B',
        forecast_type: '预增',
        profit_change_low: 100,
        profit_change_high: 120,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([
      ['600001', 0.001],
      ['600002', 0.010],
    ]),
    meta: new Map([
      ['600001', { name: 'A' }],
      ['600002', { name: 'B' }],
    ]),
    dailyClose: new Map([
      ['600001', 10],
      ['600002', 20],
    ]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  const buys = r.signals.filter(x => x.signal === 'buy');
  expectEqual('higher delta first', buys[0].stock_code, '600002');
  expectEqual('lower delta second', buys[1].stock_code, '600001');
}

async function test_exit_holding_days_limit() {
  // 持有 60+ 自然日 → SELL
  const ds = new FakeDataSource({
    forecasts: [],
    dailyClose: new Map([['600519', 1700]]),
    meta: new Map([['600519', { name: '贵州茅台', industry: '食品饮料' }]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-12-15', {
    currentPositions: [
      {
        stock_code: '600519',
        entry_date: '2024-10-15', // 61 天前
        entry_price: 1700,
      },
    ],
  });
  const sells = r.signals.filter(x => x.signal === 'sell');
  expectEqual('1 SELL', sells.length, 1);
  expectEqual('SELL stock_code', sells[0].stock_code, '600519');
  assert('SELL 原因含 holdingDaysLimit', sells[0].reason.includes('holdingDaysLimit'));
}

async function test_exit_stop_loss() {
  // 跌 -12% (< -10% 阈值) → 止损 SELL
  const ds = new FakeDataSource({
    forecasts: [],
    dailyClose: new Map([['600519', 1496]]), // 1700 * (1 - 0.12) = 1496
    meta: new Map([['600519', { name: '贵州茅台', industry: '食品饮料' }]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-25', {
    currentPositions: [
      {
        stock_code: '600519',
        entry_date: '2024-10-15', // 10 天前 (持仓未到期)
        entry_price: 1700,
      },
    ],
  });
  const sells = r.signals.filter(x => x.signal === 'sell');
  expectEqual('1 SELL', sells.length, 1);
  assert('SELL 原因含 stopLossPct', sells[0].reason.includes('stopLossPct'));
}

async function test_exit_priority_holding_days_over_stop_loss() {
  // 同时触发持有期到期 + 止损 → 持有期到期优先（reason 应当是 holdingDaysLimit）
  const ds = new FakeDataSource({
    forecasts: [],
    dailyClose: new Map([['600519', 1000]]), // 大亏 -41%
    meta: new Map([['600519', { name: '贵州茅台', industry: '食品饮料' }]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-12-15', {
    currentPositions: [
      {
        stock_code: '600519',
        entry_date: '2024-10-15', // 61 天，到期
        entry_price: 1700,
      },
    ],
  });
  const sells = r.signals.filter(x => x.signal === 'sell');
  expectEqual('1 SELL', sells.length, 1);
  assert(
    'SELL reason 优先 holdingDaysLimit',
    sells[0].reason.includes('holdingDaysLimit')
  );
}

async function test_exit_hold_within_threshold() {
  // 持有 30 天 + 跌 -5% (未到 -10% 止损) → HOLD
  const ds = new FakeDataSource({
    forecasts: [],
    dailyClose: new Map([['600519', 1615]]), // -5%
    meta: new Map([['600519', { name: '贵州茅台', industry: '食品饮料' }]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-11-15', {
    currentPositions: [
      {
        stock_code: '600519',
        entry_date: '2024-10-15', // 31 天
        entry_price: 1700,
      },
    ],
  });
  const holds = r.signals.filter(x => x.signal === 'hold');
  expectEqual('1 HOLD', holds.length, 1);
}

async function test_exit_missing_close_holds() {
  // 缺当日 close → 安全 HOLD
  const ds = new FakeDataSource({
    forecasts: [],
    dailyClose: new Map(), // 空
    meta: new Map([['600519', { name: '贵州茅台' }]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-11-15', {
    currentPositions: [
      {
        stock_code: '600519',
        entry_date: '2024-10-15',
        entry_price: 1700,
      },
    ],
  });
  const holds = r.signals.filter(x => x.signal === 'hold');
  expectEqual('1 HOLD (缺数据)', holds.length, 1);
  assert('HOLD 原因含缺数据', holds[0].reason.includes('缺'));
}

async function test_hold_kept_consumes_buy_slot() {
  // 4 个持仓 HOLD + maxPositions=5 → remainingSlots=1 → 最多 1 BUY
  const forecasts: EarningsForecastRow[] = [];
  const ndelta = new Map<string, number>();
  const meta = new Map<string, EarningsSurpriseStockMeta>();
  const closeMap = new Map<string, number>();
  for (let i = 1; i <= 3; i++) {
    const code = `6${String(i).padStart(5, '0')}`;
    forecasts.push({
      stock_code: code,
      stock_name: `${code}`,
      forecast_type: '预增',
      profit_change_low: 100,
      profit_change_high: 150,
      report_period: '2024-09-30',
    });
    ndelta.set(code, 0.005);
    meta.set(code, { name: code });
    closeMap.set(code, 10);
  }
  // 已持仓 4 只
  for (let i = 100; i < 104; i++) {
    const code = `6${String(i).padStart(5, '0')}`;
    meta.set(code, { name: code });
    closeMap.set(code, 100);
  }

  const ds = new FakeDataSource({
    forecasts,
    northboundDeltas: ndelta,
    meta,
    dailyClose: closeMap,
  });

  const currentPositions = [];
  for (let i = 100; i < 104; i++) {
    const code = `6${String(i).padStart(5, '0')}`;
    currentPositions.push({
      stock_code: code,
      entry_date: '2024-10-10', // 5 天前 — HOLD 不出场
      entry_price: 100,
    });
  }

  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15', {
    params: { maxPositions: 5 },
    currentPositions,
  });
  const holds = r.signals.filter(x => x.signal === 'hold');
  const buys = r.signals.filter(x => x.signal === 'buy');
  expectEqual('4 HOLD', holds.length, 4);
  expectEqual('限 1 BUY (5 - 4 = 1)', buys.length, 1);
}

async function test_held_stock_not_re_bought() {
  // 已持仓 600519 今日又发预告 → 不重复 BUY，记入 fail_already_held
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: '贵州茅台',
        forecast_type: '预增',
        profit_change_low: 100,
        profit_change_high: 150,
        report_period: '2024-12-31',
      },
    ],
    northboundDeltas: new Map([['600519', 0.005]]),
    meta: new Map([['600519', { name: '贵州茅台', industry: '食品饮料' }]]),
    dailyClose: new Map([['600519', 1700]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2025-01-15', {
    currentPositions: [
      {
        stock_code: '600519',
        entry_date: '2024-10-15', // 92 天前 — 应该到期 SELL
        entry_price: 1700,
      },
    ],
  });
  // 持有期已到 60+ 天 → 走 SELL；不是 fail_already_held 路径
  // 改造测试：用 entry_date 较近，触发 HOLD + fail_already_held
  const ds2 = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: '贵州茅台',
        forecast_type: '预增',
        profit_change_low: 100,
        profit_change_high: 150,
        report_period: '2024-12-31',
      },
    ],
    northboundDeltas: new Map([['600519', 0.005]]),
    meta: new Map([['600519', { name: '贵州茅台', industry: '食品饮料' }]]),
    dailyClose: new Map([['600519', 1700]]),
  });
  const r2 = await new EarningsSurpriseStrategy(ds2).generateSignals('2024-10-20', {
    currentPositions: [
      {
        stock_code: '600519',
        entry_date: '2024-10-15', // 5 天前
        entry_price: 1700,
      },
    ],
  });
  const buys = r2.signals.filter(x => x.signal === 'buy');
  expectEqual('已持仓不重复 BUY', buys.length, 0);
  expectEqual('fail_already_held=1', r2.filtered.fail_already_held, 1);
  const holds = r2.signals.filter(x => x.signal === 'hold');
  expectEqual('保留 HOLD', holds.length, 1);
  void r; // 避免 unused
}

async function test_evaluate_returns_info_hold() {
  const s = new EarningsSurpriseStrategy(new FakeDataSource());
  const result = s.evaluate({
    stock_id: 1,
    symbol: '600519.SH',
    name: '贵州茅台',
    bars: [],
  } as any);
  expectEqual('evaluate.signal=hold', result.signal, 'hold');
  expectEqual('evaluate.score=0', result.score, 0);
  assert(
    'evaluate.reasons 提示 generateSignals',
    result.reasons[0].includes('generateSignals')
  );
  expectEqual(
    'evaluate.factors.note',
    result.factors.note,
    'use_generateSignals_instead'
  );
}

async function test_helper_computeIsSurprise() {
  // 6 个分支
  expectEqual('预增 + 100 → true', computeIsSurprise('预增', 100), true);
  expectEqual('扭亏 + 50 → true (边界)', computeIsSurprise('扭亏', 50), true);
  expectEqual('续盈 + 49.99 → false (低于阈值)', computeIsSurprise('续盈', 49.99), false);
  expectEqual('预减 + 100 → false (非白名单类型)', computeIsSurprise('预减', 100), false);
  expectEqual('预增 + null → false', computeIsSurprise('预增', null), false);
  expectEqual('null + 100 → false', computeIsSurprise(null, 100), false);
  expectEqual('  预增  + 80 → true (trim)', computeIsSurprise('  预增  ', 80), true);
}

async function test_helper_isQuarterEnd() {
  expectEqual('2024-03-31 → true', isQuarterEnd('2024-03-31'), true);
  expectEqual('2024-06-30 → true', isQuarterEnd('2024-06-30'), true);
  expectEqual('2024-09-30 → true', isQuarterEnd('2024-09-30'), true);
  expectEqual('2024-12-31 → true', isQuarterEnd('2024-12-31'), true);
  expectEqual('2024-09-29 → false', isQuarterEnd('2024-09-29'), false);
  expectEqual('2024-04-30 → false', isQuarterEnd('2024-04-30'), false);
  expectEqual('garbage → false', isQuarterEnd('not-a-date'), false);
}

async function test_helper_isSTName() {
  expectEqual('ST华信 → true', isSTName('ST华信'), true);
  expectEqual('*ST天夏 → true', isSTName('*ST天夏'), true);
  expectEqual('S*ST石岘 → true', isSTName('S*ST石岘'), true);
  expectEqual('贵州茅台 → false', isSTName('贵州茅台'), false);
  expectEqual('"" → false', isSTName(''), false);
  expectEqual('null → false', isSTName(null), false);
  expectEqual('SAMSUNG → false', isSTName('SAMSUNG'), false);
}

async function test_helper_naturalDaysBetween() {
  expectEqual('同日 = 0', naturalDaysBetween('2024-10-15', '2024-10-15'), 0);
  expectEqual('1 天', naturalDaysBetween('2024-10-15', '2024-10-16'), 1);
  expectEqual('60 天', naturalDaysBetween('2024-10-15', '2024-12-14'), 60);
  expectEqual('跨年', naturalDaysBetween('2024-12-31', '2025-01-01'), 1);
  expectEqual('反向 clamp 0', naturalDaysBetween('2024-10-20', '2024-10-15'), 0);
}

async function test_invalid_trade_date_throws() {
  const s = new EarningsSurpriseStrategy(new FakeDataSource());
  try {
    await s.generateSignals('not-a-date');
    assert('invalid trade_date 应当抛出', false);
  } catch (e) {
    assert('invalid trade_date 抛出 ✓', true);
  }
}

async function test_empty_universe_safe() {
  // 空 forecast pool → 不崩，eligible=0
  const ds = new FakeDataSource({ forecasts: [] });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15');
  expectEqual('empty universe → 0 eligible', r.eligible_count, 0);
  expectEqual('no signals', r.signals.length, 0);
}

async function test_custom_params_override() {
  // 自定义 minProfitChangeLow=80 + holdingDaysLimit=30
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: '茅台',
        forecast_type: '预增',
        profit_change_low: 60, // < 80 阈值
        profit_change_high: 100,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([['600519', 0.005]]),
    meta: new Map([['600519', { name: '茅台' }]]),
    dailyClose: new Map([['600519', 1700]]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15', {
    params: { minProfitChangeLow: 80 },
  });
  expectEqual('60 < 80 阈值 → no eligible', r.eligible_count, 0);
  expectEqual('params.minProfitChangeLow=80', r.params.minProfitChangeLow, 80);
  // 默认值仍生效
  expectEqual('params.holdingDaysLimit=60 (default)', r.params.holdingDaysLimit, 60);
}

async function test_custom_surpriseForecastTypes() {
  // 把白名单替换成 ['略增']，预增 应当被剔除
  const ds = new FakeDataSource({
    forecasts: [
      {
        stock_code: '600519',
        stock_name: '茅台',
        forecast_type: '预增',
        profit_change_low: 100,
        profit_change_high: 200,
        report_period: '2024-09-30',
      },
      {
        stock_code: '600520',
        stock_name: '酒鬼',
        forecast_type: '略增',
        profit_change_low: 60,
        profit_change_high: 90,
        report_period: '2024-09-30',
      },
    ],
    northboundDeltas: new Map([
      ['600519', 0.005],
      ['600520', 0.003],
    ]),
    meta: new Map([
      ['600519', { name: '茅台' }],
      ['600520', { name: '酒鬼' }],
    ]),
    dailyClose: new Map([
      ['600519', 1700],
      ['600520', 50],
    ]),
  });
  const r = await new EarningsSurpriseStrategy(ds).generateSignals('2024-10-15', {
    params: { surpriseForecastTypes: ['略增'] },
  });
  expectEqual('只 略增 入选', r.eligible_count, 1);
  expectEqual('入选股 = 600520', r.signals.filter(x => x.signal === 'buy')[0].stock_code, '600520');
  expectEqual('预增 被剔除', r.filtered.fail_forecast_type, 1);
}

// ----------------------------------------------------------------
// Runner
// ----------------------------------------------------------------

async function main() {
  const tests = [
    test_default_params_match_AC,
    test_strategy_definition_metadata,
    test_entry_dual_confirmation_passes,
    test_entry_fail_forecast_type_not_surprise,
    test_entry_fail_profit_change_too_low,
    test_entry_fail_northbound_missing,
    test_entry_fail_northbound_not_increased,
    test_entry_fail_northbound_exactly_zero,
    test_entry_fail_st_excluded,
    test_entry_excludeST_false_keeps_ST,
    test_entry_扭亏_类型,
    test_entry_续盈_类型,
    test_max_positions_cap,
    test_sort_by_profit_change_low_desc,
    test_sort_tie_break_stable,
    test_sort_tie_break_by_northbound_delta,
    test_exit_holding_days_limit,
    test_exit_stop_loss,
    test_exit_priority_holding_days_over_stop_loss,
    test_exit_hold_within_threshold,
    test_exit_missing_close_holds,
    test_hold_kept_consumes_buy_slot,
    test_held_stock_not_re_bought,
    test_evaluate_returns_info_hold,
    test_helper_computeIsSurprise,
    test_helper_isQuarterEnd,
    test_helper_isSTName,
    test_helper_naturalDaysBetween,
    test_invalid_trade_date_throws,
    test_empty_universe_safe,
    test_custom_params_override,
    test_custom_surpriseForecastTypes,
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
