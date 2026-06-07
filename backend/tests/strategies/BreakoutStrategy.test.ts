/**
 * BreakoutStrategy 单测（US-023）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/BreakoutStrategy.test.ts
 *
 * FakeDataSource 注入到 BreakoutStrategy(constructor)，避免任何 DB 依赖。
 *
 * 覆盖：
 *   - 默认参数 (AC 指定: newHighDays=60, volumeMultiplier=1.5,
 *     maxPositions=10, holdingDaysLimit=60, stopLossPct=-0.15, ma20Period=20)
 *   - strategy_definition 元数据
 *   - 入场 4 维全通过
 *   - 入场各维度独立失败：
 *     · 未突破 60 日新高 (close == max / close < max)
 *     · 成交量未放大（边界值 = 不入选 — > 严格大于）
 *     · 行业资金净流入 ≤ 0 或缺数据
 *     · ST 名称
 *     · 缺 industry 字段
 *     · 历史 bar 不足
 *     · stale bar（最后一条 != asOfDate）
 *   - 已持仓不重复 BUY (fail_already_held)
 *   - excludeST=false 保留 ST
 *   - 5 日窗口内有零成交日 → 视为成交结构异常剔除
 *   - maxPositions cap
 *   - 排序：volume_ratio 降序 → industry_inflow 降序 → stock_code 稳定 tie-break
 *   - 出场 A (持有期到期) / B (止损) / C (跌破 MA20) / D (HOLD)
 *   - 出场优先级 A > B > C
 *   - 缺当日 close → 安全 HOLD
 *   - bars 不足 ma20Period → 安全 HOLD (不当出场)
 *   - HOLD 占用槽位限 BUY 数
 *   - evaluate() 信息性 hold + factors.note
 *   - helper isSTName / naturalDaysBetween 边角
 *   - invalid trade_date 抛出
 *   - newHighDays ≤ 0 抛出
 *   - ma20Period ≤ 1 抛出
 *   - 空 universe 安全
 *   - 自定义 params override
 *   - boundary：close 严格 > prior_high 才入选
 *   - boundary：turnover 严格 > avg5 × multiplier 才入选
 */

import {
  BreakoutBarSnapshot,
  BreakoutDataSource,
  BreakoutPosition,
  BreakoutStockMeta,
  BreakoutStrategy,
  DEFAULT_BREAKOUT_PARAMS,
  isSTName,
  naturalDaysBetween,
} from '../../src/quant/strategies/BreakoutStrategy';

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
  candidateBars?: Map<string, BreakoutBarSnapshot>;
  positionBars?: Map<string, BreakoutBarSnapshot>;
  industryFlow?: Map<string, number>;
  meta?: Map<string, BreakoutStockMeta>;
}

class FakeDataSource implements BreakoutDataSource {
  public lastCandidateMinBars = 0;
  public lastPositionMinBars = 0;

  constructor(public state: FakeFixtures = {}) {}

  async loadCandidateBars(
    _asOfDate: string,
    minBarCount: number
  ): Promise<Map<string, BreakoutBarSnapshot>> {
    this.lastCandidateMinBars = minBarCount;
    // 模拟生产实现：只返回 bar 数 >= minBarCount 的股票
    const out = new Map<string, BreakoutBarSnapshot>();
    for (const [code, snap] of (this.state.candidateBars ?? new Map()).entries()) {
      if (snap.bars.length >= minBarCount) {
        out.set(code, { bars: snap.bars.slice(-minBarCount) });
      }
    }
    return out;
  }

  async loadPositionBars(
    _asOfDate: string,
    stockCodes: string[],
    minBarCount: number
  ): Promise<Map<string, BreakoutBarSnapshot>> {
    this.lastPositionMinBars = minBarCount;
    const all = this.state.positionBars ?? new Map();
    const out = new Map<string, BreakoutBarSnapshot>();
    for (const code of stockCodes) {
      const snap = all.get(code);
      if (snap) out.set(code, snap);
    }
    return out;
  }

  async loadIndustryNetInflow(_asOfDate: string): Promise<Map<string, number>> {
    return new Map(this.state.industryFlow ?? new Map());
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, BreakoutStockMeta>> {
    const all = this.state.meta ?? new Map();
    const out = new Map<string, BreakoutStockMeta>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }
}

// ----------------------------------------------------------------
// Bar fixtures helper
// ----------------------------------------------------------------

/**
 * 生成 N 个 bar 升序到 asOfDate（每天 close + turnover 自定义）。
 * 默认 close = baseClose, turnover = baseTurnover；可通过 overrides 修改特定日期。
 */
function makeBars(
  asOfDate: string,
  count: number,
  baseClose: number,
  baseTurnover: number,
  overrides: Record<number, { close?: number; turnover?: number }> = {}
): BreakoutBarSnapshot {
  // 生成 count 天的 bar，最后一天 = asOfDate
  const bars: { date: string; close: number; turnover: number }[] = [];
  const asOf = new Date(`${asOfDate}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    const d = new Date(asOf);
    d.setUTCDate(asOf.getUTCDate() - (count - 1 - i));
    const dateIso = d.toISOString().slice(0, 10);
    const ov = overrides[i] ?? {};
    bars.push({
      date: dateIso,
      close: ov.close ?? baseClose,
      turnover: ov.turnover ?? baseTurnover,
    });
  }
  return { bars };
}

function makeMeta(name: string, industry: string | null): BreakoutStockMeta {
  return { name, industry };
}

// ----------------------------------------------------------------
// 测试用例
// ----------------------------------------------------------------

async function runTests() {
  console.log('Running BreakoutStrategy.test.ts ...\n');

  // -------- 1) 默认参数 (AC 指定) --------
  console.log('1) 默认参数 (AC 指定 7 项)');
  expectEqual('newHighDays', DEFAULT_BREAKOUT_PARAMS.newHighDays, 60);
  expectEqual('volumeMultiplier', DEFAULT_BREAKOUT_PARAMS.volumeMultiplier, 1.5);
  expectEqual('maxPositions', DEFAULT_BREAKOUT_PARAMS.maxPositions, 10);
  expectEqual('holdingDaysLimit', DEFAULT_BREAKOUT_PARAMS.holdingDaysLimit, 60);
  expectEqual('stopLossPct', DEFAULT_BREAKOUT_PARAMS.stopLossPct, -0.15);
  expectEqual('ma20Period', DEFAULT_BREAKOUT_PARAMS.ma20Period, 20);
  expectEqual('excludeST', DEFAULT_BREAKOUT_PARAMS.excludeST, true);

  // -------- 2) strategy_definition 元数据 --------
  console.log('\n2) strategy_definition 元数据');
  const strat = new BreakoutStrategy(new FakeDataSource());
  expectEqual('strategy_key', strat.definition.strategy_key, 'breakout_strategy');
  expectEqual('category', strat.definition.category, 'momentum');
  expectEqual('risk_level', strat.definition.risk_level, 'medium');
  assert('tags 包含 趋势 突破', strat.definition.tags?.includes('突破') === true);
  expectEqual('enabled', strat.definition.enabled, true);
  // default_params 通过 strategy_definition 透出
  expectEqual(
    'default_params 与 DEFAULT_BREAKOUT_PARAMS 一致',
    strat.definition.default_params,
    DEFAULT_BREAKOUT_PARAMS
  );

  // -------- 3) 入场 4 维全通过 --------
  console.log('\n3) 入场 4 维全通过');
  {
    const asOf = '2026-06-07';
    // 61 个 bar：前 60 天 close 10, turnover 100M；今日 close 11 (突破)，turnover 200M (放大 2x)
    const winnerBars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 200_000_000 }, // 今日突破 + 放量
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000001', winnerBars]]),
      industryFlow: new Map([['银行', 50_000_000]]),
      meta: new Map([['000001', makeMeta('平安银行', '银行')]]),
    });
    const s = new BreakoutStrategy(ds);
    const r = await s.generateSignals(asOf);
    expectEqual('eligible_count = 1', r.eligible_count, 1);
    expectEqual('target_positions.length = 1', r.target_positions.length, 1);
    expectEqual('signals.length = 1 BUY', r.signals.length, 1);
    expectEqual('signal type', r.signals[0].signal, 'buy');
    expectEqual('signal symbol', r.signals[0].stock_code, '000001');
    expectEqual('industry filled', r.signals[0].industry, '银行');
    assert('volume_ratio ≈ 2.0', Math.abs((r.signals[0].volume_ratio ?? 0) - 2.0) < 1e-6);
    expectEqual('industry_inflow', r.signals[0].industry_inflow, 50_000_000);
    expectEqual('reference_price = 11', r.signals[0].reference_price, 11);
    // target position structure
    const tgt = r.target_positions[0];
    expectEqual('target.entry_date', tgt.entry_date, asOf);
    expectEqual('target.entry_price', tgt.entry_price, 11);
    expectEqual('target.entry_60d_high', tgt.entry_60d_high, 10);
    expectEqual('target.entry_industry', tgt.entry_industry, '银行');
  }

  // -------- 4a) 未突破 60 日新高（close ≤ max） --------
  console.log('\n4a) 入场失败：close == max（不严格 >）');
  {
    const asOf = '2026-06-07';
    // 前 60 天 close 10，第 30 天偷偷给一个 11；今日 close 也是 11 → 不严格 > priorHigh
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      30: { close: 11 },
      60: { close: 11, turnover: 200_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000002', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000002', makeMeta('xxx', '行业A')]]),
    });
    const s = new BreakoutStrategy(ds);
    const r = await s.generateSignals(asOf);
    expectEqual('eligible_count = 0', r.eligible_count, 0);
    expectEqual('fail_no_new_high = 1', r.filtered.fail_no_new_high, 1);
  }

  // -------- 4b) close < max --------
  console.log('\n4b) 入场失败：close < max');
  {
    const asOf = '2026-06-07';
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      30: { close: 12 },
      60: { close: 9, turnover: 200_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000003', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000003', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('fail_no_new_high = 1', r.filtered.fail_no_new_high, 1);
  }

  // -------- 5) 成交量未放大 --------
  console.log('\n5) 入场失败：成交量未放大');
  {
    const asOf = '2026-06-07';
    // 突破，但 turnover 仅 1.4x（< 1.5x 阈值）
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 140_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000004', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000004', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('fail_volume_insufficient = 1', r.filtered.fail_volume_insufficient, 1);
  }

  // -------- 5b) 成交量恰等于阈值 → 不入选（严格 >） --------
  console.log('\n5b) 入场失败：成交量恰等于 1.5x（边界严格大于）');
  {
    const asOf = '2026-06-07';
    // 突破 + turnover 恰好 = 150M（1.5x of 100M）
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 150_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000005', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000005', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('boundary turnover = threshold → 不入选', r.filtered.fail_volume_insufficient, 1);
  }

  // -------- 6) 行业资金净流入 ≤ 0 --------
  console.log('\n6) 入场失败：行业资金净流入 ≤ 0');
  {
    const asOf = '2026-06-07';
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 200_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000006', bars]]),
      industryFlow: new Map([['行业A', -10_000_000]]), // 净流出
      meta: new Map([['000006', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('fail_industry_flow_negative = 1', r.filtered.fail_industry_flow_negative, 1);
  }

  // -------- 6b) 行业资金恰 0 --------
  console.log('\n6b) 入场失败：行业资金恰 0（严格 > 0）');
  {
    const asOf = '2026-06-07';
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 200_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000007', bars]]),
      industryFlow: new Map([['行业A', 0]]),
      meta: new Map([['000007', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('boundary inflow = 0 → 不入选', r.filtered.fail_industry_flow_negative, 1);
  }

  // -------- 6c) 行业资金缺数据 --------
  console.log('\n6c) 入场失败：行业未在 industryFlow Map 中');
  {
    const asOf = '2026-06-07';
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 200_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000008', bars]]),
      industryFlow: new Map(),
      meta: new Map([['000008', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('fail_industry_flow_negative (missing) = 1', r.filtered.fail_industry_flow_negative, 1);
  }

  // -------- 7) ST 名称剔除 --------
  console.log('\n7) 入场失败：ST 名称剔除');
  {
    const asOf = '2026-06-07';
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 200_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000009', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000009', makeMeta('ST康得新', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('fail_st = 1', r.filtered.fail_st, 1);
    expectEqual('eligible_count = 0', r.eligible_count, 0);
  }

  // -------- 7b) excludeST=false 保留 ST --------
  console.log('\n7b) excludeST=false 保留 ST');
  {
    const asOf = '2026-06-07';
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 200_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000010', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000010', makeMeta('*ST 凡谷', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, { params: { excludeST: false } });
    expectEqual('eligible_count = 1', r.eligible_count, 1);
    expectEqual('fail_st = 0', r.filtered.fail_st, 0);
  }

  // -------- 8) 缺 meta / 缺 industry --------
  console.log('\n8) 入场失败：缺 meta');
  {
    const asOf = '2026-06-07';
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 200_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000011', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map(),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('fail_meta_missing = 1', r.filtered.fail_meta_missing, 1);
  }
  console.log('\n8b) 入场失败：meta.industry 为 null');
  {
    const asOf = '2026-06-07';
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 200_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000012', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000012', makeMeta('x', null)]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('fail_meta_missing = 1 (null industry)', r.filtered.fail_meta_missing, 1);
  }

  // -------- 9) 历史 bar 不足 --------
  console.log('\n9) 入场失败：历史 bar 不足（数据层就过滤了）');
  {
    const asOf = '2026-06-07';
    // 只给 50 个 bar，loadCandidateBars 在 minBarCount=61 时直接不返回该股票
    const bars = makeBars(asOf, 50, 10, 100_000_000, {
      49: { close: 15, turnover: 300_000_000 }, // 即使最后一天大涨大放量也无效
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000013', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000013', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('candidate_pool_size = 0 (被 datasource 过滤)', r.filtered.candidate_pool_size, 0);
    expectEqual('eligible = 0', r.eligible_count, 0);
  }

  // -------- 10) stale bar（最后一条 != asOfDate） --------
  console.log('\n10) 入场失败：最后一条 bar != asOfDate（停牌）');
  {
    const asOf = '2026-06-07';
    // makeBars 默认最后一天 = asOf。这里手工构造 stale snapshot：所有 bars 都比 asOf 早
    const stale: BreakoutBarSnapshot = {
      bars: Array.from({ length: 61 }, (_, i) => {
        const d = new Date(`2026-03-01T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        return { date: d.toISOString().slice(0, 10), close: 10, turnover: 100_000_000 };
      }),
    };
    // 改最后一天 close 14 + turnover 200M 以便仅看 stale_bar 维度
    stale.bars[60] = { date: stale.bars[60].date, close: 14, turnover: 200_000_000 };
    const ds = new FakeDataSource({
      candidateBars: new Map([['000014', stale]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000014', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('fail_stale_bar = 1', r.filtered.fail_stale_bar, 1);
  }

  // -------- 11) 5 日窗口内有零成交日 --------
  console.log('\n11) 入场失败：5 日内有零成交日');
  {
    const asOf = '2026-06-07';
    const overrides: Record<number, { close?: number; turnover?: number }> = {
      57: { turnover: 0 }, // 5 日窗口（55-59）内有一天零成交（停牌）
      60: { close: 11, turnover: 200_000_000 },
    };
    const bars = makeBars(asOf, 61, 10, 100_000_000, overrides);
    const ds = new FakeDataSource({
      candidateBars: new Map([['000015', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000015', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('fail_volume_insufficient = 1 (零成交)', r.filtered.fail_volume_insufficient, 1);
  }

  // -------- 12) 已持仓不重复 BUY --------
  console.log('\n12) 已持仓不重复 BUY (fail_already_held)');
  {
    const asOf = '2026-06-07';
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 200_000_000 },
    });
    // 给 position bars：让 holdingDays < 60 + close 不破 ma20 → HOLD
    const posBars = makeBars(asOf, 21, 10, 100_000_000, {
      20: { close: 11 }, // 今日 11，ma20 ≈ 10.05 → close > ma20 → HOLD
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000016', bars]]),
      positionBars: new Map([['000016', posBars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000016', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000016', entry_date: '2026-05-20', entry_price: 10 },
      ],
    });
    // 候选池有 1 只，但已持仓被剔除
    expectEqual('candidate_pool_size = 1', r.filtered.candidate_pool_size, 1);
    expectEqual('fail_already_held = 1', r.filtered.fail_already_held, 1);
    expectEqual('eligible_count = 0', r.eligible_count, 0);
    const buys = r.signals.filter(s => s.signal === 'buy');
    expectEqual('no BUY signals', buys.length, 0);
    const holds = r.signals.filter(s => s.signal === 'hold');
    expectEqual('1 HOLD signal', holds.length, 1);
  }

  // -------- 13) maxPositions cap --------
  console.log('\n13) maxPositions cap');
  {
    const asOf = '2026-06-07';
    const candidateBars = new Map<string, BreakoutBarSnapshot>();
    const meta = new Map<string, BreakoutStockMeta>();
    // 生成 5 只候选股，每只 close 11 turnover 200M
    for (let i = 1; i <= 5; i++) {
      const code = `00010${i}`;
      candidateBars.set(
        code,
        makeBars(asOf, 61, 10, 100_000_000, {
          60: { close: 11, turnover: 200_000_000 },
        })
      );
      meta.set(code, makeMeta(`股票${i}`, '行业A'));
    }
    const ds = new FakeDataSource({
      candidateBars,
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta,
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      params: { maxPositions: 3 },
    });
    expectEqual('eligible_count = 5 (未被 cap 前)', r.eligible_count, 5);
    expectEqual('target_positions.length = 3', r.target_positions.length, 3);
    expectEqual('BUY signals = 3', r.signals.filter(s => s.signal === 'buy').length, 3);
  }

  // -------- 14) 排序：volume_ratio 降序 → industry_inflow 降序 → stock_code 稳定 --------
  console.log('\n14) 排序：volume_ratio 降序 → industry_inflow 降序 → stock_code 稳定');
  {
    const asOf = '2026-06-07';
    // 3 只股票：
    //   股A 002000 → volume_ratio=3.0, inflow=10M
    //   股B 002001 → volume_ratio=2.0, inflow=10M
    //   股C 002002 → volume_ratio=2.0, inflow=5M
    // 期望顺序 A → B → C
    const candidateBars = new Map<string, BreakoutBarSnapshot>([
      [
        '002000',
        makeBars(asOf, 61, 10, 100_000_000, {
          60: { close: 11, turnover: 300_000_000 },
        }),
      ],
      [
        '002001',
        makeBars(asOf, 61, 10, 100_000_000, {
          60: { close: 11, turnover: 200_000_000 },
        }),
      ],
      [
        '002002',
        makeBars(asOf, 61, 10, 100_000_000, {
          60: { close: 11, turnover: 200_000_000 },
        }),
      ],
    ]);
    const ds = new FakeDataSource({
      candidateBars,
      industryFlow: new Map([
        ['行业 hi', 10_000_000],
        ['行业 lo', 5_000_000],
      ]),
      meta: new Map([
        ['002000', makeMeta('A', '行业 hi')],
        ['002001', makeMeta('B', '行业 hi')],
        ['002002', makeMeta('C', '行业 lo')],
      ]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('排序顺序', r.target_positions.map(p => p.stock_code), ['002000', '002001', '002002']);
  }

  // -------- 14b) tie-break stock_code 升序 --------
  console.log('\n14b) tie-break：完全相同 volume_ratio + inflow 时 stock_code 升序');
  {
    const asOf = '2026-06-07';
    const candidateBars = new Map<string, BreakoutBarSnapshot>([
      [
        '003003',
        makeBars(asOf, 61, 10, 100_000_000, {
          60: { close: 11, turnover: 200_000_000 },
        }),
      ],
      [
        '003001',
        makeBars(asOf, 61, 10, 100_000_000, {
          60: { close: 11, turnover: 200_000_000 },
        }),
      ],
      [
        '003002',
        makeBars(asOf, 61, 10, 100_000_000, {
          60: { close: 11, turnover: 200_000_000 },
        }),
      ],
    ]);
    const ds = new FakeDataSource({
      candidateBars,
      industryFlow: new Map([['行业A', 10_000_000]]),
      meta: new Map([
        ['003001', makeMeta('a', '行业A')],
        ['003002', makeMeta('b', '行业A')],
        ['003003', makeMeta('c', '行业A')],
      ]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual(
      'stock_code 升序 tie-break',
      r.target_positions.map(p => p.stock_code),
      ['003001', '003002', '003003']
    );
  }

  // -------- 15) 出场 A：持有 ≥ 60 自然日 --------
  console.log('\n15) 出场 A：持有 ≥ holdingDaysLimit → SELL');
  {
    const asOf = '2026-06-07';
    const posBars = makeBars(asOf, 21, 10, 100_000_000);
    const ds = new FakeDataSource({
      positionBars: new Map([['000020', posBars]]),
      meta: new Map([['000020', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000020', entry_date: '2026-04-01', entry_price: 10 },
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000020');
    expectEqual('signal = sell (持有期到期)', sig?.signal, 'sell');
    assert('reason mentions 到期', sig?.reason.includes('到期') === true);
    expectEqual('target_positions 不含 000020', r.target_positions.length, 0);
  }

  // -------- 16) 出场 B：止损 --------
  console.log('\n16) 出场 B：(close - entry) / entry ≤ -15% → SELL');
  {
    const asOf = '2026-06-07';
    const posBars = makeBars(asOf, 21, 10, 100_000_000, {
      20: { close: 7 }, // pnl = (7-10)/10 = -30% ≤ -15%
    });
    const ds = new FakeDataSource({
      positionBars: new Map([['000021', posBars]]),
      meta: new Map([['000021', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000021', entry_date: '2026-05-30', entry_price: 10 },
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000021');
    expectEqual('signal = sell (止损)', sig?.signal, 'sell');
    assert('reason mentions 止损', sig?.reason.includes('止损') === true);
  }

  // -------- 17) 出场 C：跌破 MA20 --------
  console.log('\n17) 出场 C：close < MA20 → SELL');
  {
    const asOf = '2026-06-07';
    // 20 days at close=10 (ma20 = 10), today close = 9.5 < 10 (跌破 ma20) but pnl=-5% > -15% (不触止损)
    const posBars = makeBars(asOf, 20, 10, 100_000_000, {
      19: { close: 9.5 },
    });
    const ds = new FakeDataSource({
      positionBars: new Map([['000022', posBars]]),
      meta: new Map([['000022', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000022', entry_date: '2026-05-30', entry_price: 10 },
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000022');
    expectEqual('signal = sell (跌破均线)', sig?.signal, 'sell');
    assert('reason mentions 跌破均线', sig?.reason.includes('跌破') === true);
  }

  // -------- 18) 出场 D：HOLD --------
  console.log('\n18) 出场 D：close > MA20，pnl > stopLoss，未到期 → HOLD');
  {
    const asOf = '2026-06-07';
    const posBars = makeBars(asOf, 20, 10, 100_000_000, {
      19: { close: 10.5 },
    });
    const ds = new FakeDataSource({
      positionBars: new Map([['000023', posBars]]),
      meta: new Map([['000023', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000023', entry_date: '2026-05-30', entry_price: 10 },
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000023');
    expectEqual('signal = hold', sig?.signal, 'hold');
    assert('reason mentions 继续持有', sig?.reason.includes('继续持有') === true);
    expectEqual('target_positions 仍含 000023', r.target_positions.length, 1);
  }

  // -------- 19) 出场优先级 A > B (即使止损触发，先到期优先) --------
  console.log('\n19) 出场优先级 A > B：持有期到期 > 止损');
  {
    const asOf = '2026-06-07';
    const posBars = makeBars(asOf, 21, 10, 100_000_000, {
      20: { close: 5 }, // -50% 大幅止损
    });
    const ds = new FakeDataSource({
      positionBars: new Map([['000024', posBars]]),
      meta: new Map([['000024', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000024', entry_date: '2026-04-01', entry_price: 10 }, // 持有 67 天
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000024');
    expectEqual('signal = sell', sig?.signal, 'sell');
    assert(
      'reason 是持有期到期不是止损',
      sig?.reason.includes('到期') === true && sig?.reason.includes('止损') === false
    );
  }

  // -------- 20) 出场优先级 B > C (即使破 ma20，止损先优先) --------
  console.log('\n20) 出场优先级 B > C：止损 > 跌破均线');
  {
    const asOf = '2026-06-07';
    // pnl = -20% 触发止损；同时 close < ma20
    const posBars = makeBars(asOf, 20, 10, 100_000_000, {
      19: { close: 8 }, // -20% 止损; ma20 = (19*10 + 8)/20 = 9.9; 8 < 9.9 也破 ma20
    });
    const ds = new FakeDataSource({
      positionBars: new Map([['000025', posBars]]),
      meta: new Map([['000025', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000025', entry_date: '2026-05-30', entry_price: 10 },
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000025');
    expectEqual('signal = sell', sig?.signal, 'sell');
    assert(
      'reason 是止损不是跌破均线',
      sig?.reason.includes('止损') === true && sig?.reason.includes('跌破') === false
    );
  }

  // -------- 21) 缺当日 close → 安全 HOLD --------
  console.log('\n21) 缺当日 close → 安全 HOLD（不当出场）');
  {
    const asOf = '2026-06-07';
    // positionBars 不返回该股票 → snapshot 为 undefined
    const ds = new FakeDataSource({
      positionBars: new Map(),
      meta: new Map([['000026', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000026', entry_date: '2026-05-30', entry_price: 10 },
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000026');
    expectEqual('signal = hold', sig?.signal, 'hold');
    assert('reason 缺数据', sig?.reason.includes('缺') === true);
    expectEqual('target_positions 仍含 (不当 SELL)', r.target_positions.length, 1);
  }

  // -------- 22) bars 不足 ma20Period → 安全 HOLD --------
  console.log('\n22) bars 不足 ma20Period → 安全 HOLD');
  {
    const asOf = '2026-06-07';
    // 仅 5 个 bar < 20 → 不能算 ma20
    const posBars = makeBars(asOf, 5, 10, 100_000_000, {
      4: { close: 10.5 },
    });
    const ds = new FakeDataSource({
      positionBars: new Map([['000027', posBars]]),
      meta: new Map([['000027', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000027', entry_date: '2026-06-01', entry_price: 10 },
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000027');
    expectEqual('signal = hold (bars 不足)', sig?.signal, 'hold');
    assert('reason mentions ma20Period', sig?.reason.includes('ma20Period') === true);
  }

  // -------- 23) HOLD 占用槽位限 BUY 数 --------
  console.log('\n23) HOLD 占用槽位限 BUY 数');
  {
    const asOf = '2026-06-07';
    // 3 候选 BUY + 已有 3 HOLD（不触发任何出场）+ maxPositions=5
    // → 期望: 3 HOLD + 2 BUY = 5
    const candidateBars = new Map<string, BreakoutBarSnapshot>();
    const positionBars = new Map<string, BreakoutBarSnapshot>();
    const meta = new Map<string, BreakoutStockMeta>();
    for (let i = 1; i <= 3; i++) {
      const code = `00030${i}`;
      candidateBars.set(
        code,
        makeBars(asOf, 61, 10, 100_000_000, {
          60: { close: 11, turnover: 200_000_000 },
        })
      );
      meta.set(code, makeMeta(`c${i}`, '行业A'));
    }
    const currentPositions: BreakoutPosition[] = [];
    for (let i = 1; i <= 3; i++) {
      const code = `00040${i}`;
      // 20 days at 10, today 10.5 → HOLD
      positionBars.set(
        code,
        makeBars(asOf, 20, 10, 100_000_000, {
          19: { close: 10.5 },
        })
      );
      meta.set(code, makeMeta(`p${i}`, '行业A'));
      currentPositions.push({
        stock_code: code,
        entry_date: '2026-05-30',
        entry_price: 10,
      });
    }
    const ds = new FakeDataSource({
      candidateBars,
      positionBars,
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta,
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      params: { maxPositions: 5 },
      currentPositions,
    });
    expectEqual('eligible_count = 3', r.eligible_count, 3);
    expectEqual('target_positions = 5', r.target_positions.length, 5);
    expectEqual('BUY = 2', r.signals.filter(s => s.signal === 'buy').length, 2);
    expectEqual('HOLD = 3', r.signals.filter(s => s.signal === 'hold').length, 3);
    expectEqual('SELL = 0', r.signals.filter(s => s.signal === 'sell').length, 0);
  }

  // -------- 24) evaluate() 信息性 hold --------
  console.log('\n24) evaluate() 返回信息性 hold + factors.note');
  {
    const s = new BreakoutStrategy(new FakeDataSource());
    const ctx = {
      symbol: '000001.SZ',
      name: '平安银行',
      sector: null,
      bars: [{ time: new Date(), open: 10, high: 11, low: 9, close: 11, volume: 1000 }] as any,
      ma_indicators: {} as any,
      latest_bar: { time: new Date(), open: 10, high: 11, low: 9, close: 11, volume: 1000 } as any,
      previous_bar: undefined,
      indicators: {} as any,
      factor_snapshot: undefined,
      market_environment: undefined,
      historical_returns: [],
      bull_market: false,
      sector_strength: undefined,
    } as any;
    const result = s.evaluate(ctx);
    expectEqual('signal = hold', result.signal, 'hold');
    assert('reasons 包含 use_generateSignals', result.reasons.some(r => r.includes('generateSignals')));
    expectEqual('factors.note', result.factors?.note, 'use_generateSignals_instead');
  }

  // -------- 25) helper isSTName 边角（与其他策略保持一致） --------
  console.log('\n25) helper isSTName 9 边角');
  expectEqual('ST康得新', isSTName('ST康得新'), true);
  expectEqual('*ST康得新', isSTName('*ST康得新'), true);
  expectEqual('XST 平安', isSTName('XST平安'), false);
  expectEqual('正常 平安银行', isSTName('平安银行'), false);
  expectEqual('S康美药业', isSTName('S康美药业'), true); // S+ 非英数 = 退市风险预警 (与 NorthboundFollow 同款约定)
  expectEqual('S*ST 锐电', isSTName('S*ST锐电'), true);
  expectEqual('S ST 安然', isSTName('S ST安然'), true);
  expectEqual('空', isSTName(''), false);
  expectEqual('null', isSTName(null), false);

  // -------- 26) helper naturalDaysBetween 边角 --------
  console.log('\n26) helper naturalDaysBetween 边角');
  expectEqual('entry=trade 当日', naturalDaysBetween('2026-06-07', '2026-06-07'), 0);
  expectEqual('1 天后', naturalDaysBetween('2026-06-06', '2026-06-07'), 1);
  expectEqual('30 天后', naturalDaysBetween('2026-05-08', '2026-06-07'), 30);
  expectEqual('60 天后', naturalDaysBetween('2026-04-08', '2026-06-07'), 60);
  expectEqual('entry > trade (负差) 取 0', naturalDaysBetween('2026-06-08', '2026-06-07'), 0);

  // -------- 27) invalid trade_date 抛出 --------
  console.log('\n27) invalid trade_date 抛出');
  {
    const s = new BreakoutStrategy(new FakeDataSource());
    let threw = false;
    try {
      await s.generateSignals('2026/06/07');
    } catch (_e) {
      threw = true;
    }
    assert('抛出 invalid trade_date', threw);
  }

  // -------- 28) newHighDays ≤ 0 抛出 --------
  console.log('\n28) newHighDays ≤ 0 抛出');
  {
    const s = new BreakoutStrategy(new FakeDataSource());
    let threw = false;
    try {
      await s.generateSignals('2026-06-07', { params: { newHighDays: 0 } });
    } catch (_e) {
      threw = true;
    }
    assert('newHighDays=0 抛出', threw);
  }

  // -------- 29) ma20Period ≤ 1 抛出 --------
  console.log('\n29) ma20Period ≤ 1 抛出');
  {
    const s = new BreakoutStrategy(new FakeDataSource());
    let threw = false;
    try {
      await s.generateSignals('2026-06-07', { params: { ma20Period: 1 } });
    } catch (_e) {
      threw = true;
    }
    assert('ma20Period=1 抛出', threw);
  }

  // -------- 30) 空 universe 安全 --------
  console.log('\n30) 空 universe 安全返回');
  {
    const ds = new FakeDataSource();
    const r = await new BreakoutStrategy(ds).generateSignals('2026-06-07');
    expectEqual('candidate_pool_size = 0', r.filtered.candidate_pool_size, 0);
    expectEqual('eligible_count = 0', r.eligible_count, 0);
    expectEqual('signals = []', r.signals.length, 0);
    expectEqual('target_positions = []', r.target_positions.length, 0);
  }

  // -------- 31) 自定义 params override --------
  console.log('\n31) 自定义 params override 透传');
  {
    const asOf = '2026-06-07';
    // 用 newHighDays=10, volumeMultiplier=2.0 → 需要 11 个 bar，今日 turnover > 5 日均 × 2
    const bars = makeBars(asOf, 11, 10, 100_000_000, {
      10: { close: 11, turnover: 250_000_000 }, // 2.5x
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000031', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000031', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      params: { newHighDays: 10, volumeMultiplier: 2.0, maxPositions: 5 },
    });
    expectEqual('params override.newHighDays', r.params.newHighDays, 10);
    expectEqual('params override.volumeMultiplier', r.params.volumeMultiplier, 2.0);
    expectEqual('eligible_count = 1', r.eligible_count, 1);
    expectEqual('lastCandidateMinBars=11', ds.lastCandidateMinBars, 11);
  }

  // -------- 32) DataSource minBarCount 调用参数 --------
  console.log('\n32) DataSource minBarCount 透传');
  {
    const ds = new FakeDataSource();
    await new BreakoutStrategy(ds).generateSignals('2026-06-07', {
      currentPositions: [
        { stock_code: '000099', entry_date: '2026-06-01', entry_price: 10 },
      ],
    });
    expectEqual('candidate minBars = newHighDays+1 = 61', ds.lastCandidateMinBars, 61);
    expectEqual('position minBars = ma20Period = 20', ds.lastPositionMinBars, 20);
  }

  // -------- 33) 边界：close 严格 > priorHigh 才入选 --------
  console.log('\n33) 边界：close 严格 > priorHigh（不能等于）');
  {
    const asOf = '2026-06-07';
    // 前 60 天最高 10.99，今日 close 11 → 严格 > 入选
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      30: { close: 10.99 },
      60: { close: 11, turnover: 200_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000033', bars]]),
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([['000033', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('eligible_count = 1', r.eligible_count, 1);
  }

  // -------- 34) 边界：MA20 close 恰等于不触发出场（< 严格） --------
  console.log('\n34) 边界：close = MA20 不触发出场（要严格 <）');
  {
    const asOf = '2026-06-07';
    // 20 days at close=10 → ma20 = 10. today close = 10 (= ma20) → 不出场
    const posBars = makeBars(asOf, 20, 10, 100_000_000);
    const ds = new FakeDataSource({
      positionBars: new Map([['000034', posBars]]),
      meta: new Map([['000034', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000034', entry_date: '2026-05-30', entry_price: 10 },
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000034');
    expectEqual('signal = hold (close = ma20)', sig?.signal, 'hold');
  }

  // -------- 35) 边界：stopLoss 恰等于阈值触发出场（≤ 不严格） --------
  console.log('\n35) 边界：pnl = stopLossPct 触发出场（≤ 不严格）');
  {
    const asOf = '2026-06-07';
    // pnl = (8.5 - 10)/10 = -15% = stopLossPct → 触发
    const posBars = makeBars(asOf, 20, 10, 100_000_000, {
      19: { close: 8.5 },
    });
    const ds = new FakeDataSource({
      positionBars: new Map([['000035', posBars]]),
      meta: new Map([['000035', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000035', entry_date: '2026-05-30', entry_price: 10 },
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000035');
    expectEqual('signal = sell (止损边界 ≤)', sig?.signal, 'sell');
  }

  // -------- 36) 多空混合场景：1 候选 BUY + 1 止损 SELL + 1 HOLD --------
  console.log('\n36) 多空混合场景：1 BUY + 1 SELL + 1 HOLD');
  {
    const asOf = '2026-06-07';
    const candidateBars = new Map<string, BreakoutBarSnapshot>([
      [
        '000041',
        makeBars(asOf, 61, 10, 100_000_000, {
          60: { close: 11, turnover: 200_000_000 },
        }),
      ],
    ]);
    const positionBars = new Map<string, BreakoutBarSnapshot>([
      [
        '000042',
        makeBars(asOf, 20, 10, 100_000_000, {
          19: { close: 7 },
        }),
      ],
      [
        '000043',
        makeBars(asOf, 20, 10, 100_000_000, {
          19: { close: 10.5 },
        }),
      ],
    ]);
    const ds = new FakeDataSource({
      candidateBars,
      positionBars,
      industryFlow: new Map([['行业A', 50_000_000]]),
      meta: new Map([
        ['000041', makeMeta('cand', '行业A')],
        ['000042', makeMeta('losing', '行业A')],
        ['000043', makeMeta('winning', '行业A')],
      ]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000042', entry_date: '2026-05-30', entry_price: 10 },
        { stock_code: '000043', entry_date: '2026-05-30', entry_price: 10 },
      ],
    });
    expectEqual('BUY = 1', r.signals.filter(s => s.signal === 'buy').length, 1);
    expectEqual('SELL = 1', r.signals.filter(s => s.signal === 'sell').length, 1);
    expectEqual('HOLD = 1', r.signals.filter(s => s.signal === 'hold').length, 1);
    expectEqual('target_positions = 2 (HOLD + BUY)', r.target_positions.length, 2);
  }

  // -------- 37) 多次失败维度同时存在：仅记录最早被命中的维度 --------
  console.log('\n37) 多失败维度：仅最早匹配的失败维度被记录 (early-exit)');
  {
    const asOf = '2026-06-07';
    // 同时具备：未突破新高 + 成交量未放大 + 行业流入为负 + ST
    // 期望：fail_no_new_high 先被检测（早过滤）= 1，其他维度不再统计该股
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      30: { close: 15 },
      60: { close: 9, turnover: 50_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000050', bars]]),
      industryFlow: new Map([['行业A', -1_000_000]]),
      meta: new Map([['000050', makeMeta('ST x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('fail_no_new_high = 1 (early exit)', r.filtered.fail_no_new_high, 1);
    expectEqual('fail_volume_insufficient = 0 (没机会检测)', r.filtered.fail_volume_insufficient, 0);
    expectEqual('fail_st = 0', r.filtered.fail_st, 0);
    expectEqual('fail_industry_flow_negative = 0', r.filtered.fail_industry_flow_negative, 0);
  }

  // -------- 38) trade_date 与最新 bar 不一致 + 持有期到期 (复合场景) --------
  console.log('\n38) 持仓 stale bar → 不是 SELL 而是 HOLD（除非到期）');
  {
    const asOf = '2026-06-07';
    // 给一个 stale snapshot（最后 bar date 不等于 asOfDate）+ 持有日 < 60
    const stale: BreakoutBarSnapshot = {
      bars: Array.from({ length: 20 }, (_, i) => ({
        date: `2026-05-${String(i + 1).padStart(2, '0')}`,
        close: 10,
        turnover: 100_000_000,
      })),
    };
    const ds = new FakeDataSource({
      positionBars: new Map([['000060', stale]]),
      meta: new Map([['000060', makeMeta('x', '行业A')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000060', entry_date: '2026-06-05', entry_price: 10 }, // 持有 2 天
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000060');
    expectEqual('stale bar 持有期内 → HOLD', sig?.signal, 'hold');
    expectEqual('target 仍含', r.target_positions.length, 1);
  }

  // -------- 39) holding 边界：持有 60 天恰好触发 --------
  console.log('\n39) 持有 = holdingDaysLimit 触发出场（≥ 不严格）');
  {
    const asOf = '2026-06-07';
    const posBars = makeBars(asOf, 20, 10, 100_000_000);
    const ds = new FakeDataSource({
      positionBars: new Map([['000061', posBars]]),
      meta: new Map([['000061', makeMeta('x', '行业A')]]),
    });
    // 60 天前
    const r = await new BreakoutStrategy(ds).generateSignals(asOf, {
      currentPositions: [
        { stock_code: '000061', entry_date: '2026-04-08', entry_price: 10 }, // 60 自然日
      ],
    });
    const sig = r.signals.find(s => s.stock_code === '000061');
    expectEqual('signal = sell (恰 60 天)', sig?.signal, 'sell');
  }

  // -------- 40) industry name 带空格容错 --------
  console.log('\n40) industry name 带前后空格容错');
  {
    const asOf = '2026-06-07';
    const bars = makeBars(asOf, 61, 10, 100_000_000, {
      60: { close: 11, turnover: 200_000_000 },
    });
    const ds = new FakeDataSource({
      candidateBars: new Map([['000070', bars]]),
      // industryFlow 用 trim 后的 key
      industryFlow: new Map([['行业A', 50_000_000]]),
      // meta 包含前后空格
      meta: new Map([['000070', makeMeta('x', '  行业A  ')]]),
    });
    const r = await new BreakoutStrategy(ds).generateSignals(asOf);
    expectEqual('eligible_count = 1 (trim 容错)', r.eligible_count, 1);
  }

  // ----------------------------------------------------------------

  console.log('');
  if (failed === 0) {
    console.log('All BreakoutStrategy tests passed.');
    process.exit(0);
  } else {
    console.error(`${failed} BreakoutStrategy test(s) failed.`);
    process.exit(1);
  }
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
