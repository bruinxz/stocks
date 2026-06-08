/**
 * DragonHeadMomentumStrategy 单测（US-012）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/DragonHeadMomentumStrategy.test.ts
 *
 * AC 要求构造 mock 数据验证 entry/exit 触发；本文件覆盖：
 *   - 默认参数符合 AC（maxPositions=5 / 连板 [1,3] / stopLossPct=-7% 等）
 *   - 入场 5 条件 AND（涨停 + 连板范围 + 行业 top-N + 游资 + 流通市值）
 *   - 入场维度逐条单独检验剔除
 *   - 一字板被剔除
 *   - 出场 4 类：持有 N 日强制平、止损、炸板、高开减半
 *   - 出场优先级：持有期 > 止损 > 炸板 > 高开
 *   - 已减半（half_exited=true）不再二次减半
 *   - maxPositions 上限 + HOLD 占用槽位时新 BUY 限额
 *   - 排序稳定：famous_yz_net_buy 同分时按 stock_code 升序
 *   - evaluate() 返回信息性 hold
 *   - naturalDaysBetween 辅助函数
 */

import {
  DEFAULT_DRAGON_HEAD_PARAMS,
  DragonHeadMomentumStrategy,
  DragonHeadDataSource,
  DragonHeadLimitUpRow,
  DragonHeadStockMeta,
  DragonHeadQuote,
  DragonHeadPosition,
  naturalDaysBetween,
} from '../../src/quant/strategies/DragonHeadMomentumStrategy';
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

class FakeDataSource implements DragonHeadDataSource {
  constructor(
    private readonly state: {
      limitUp?: Map<string, DragonHeadLimitUpRow[]>;
      topIndustries?: Map<string, string[]>;
      famousYzNetBuy?: Map<string, Map<string, number>>;
      stockMeta?: Map<string, DragonHeadStockMeta>;
      dailyQuote?: Map<string, Map<string, DragonHeadQuote>>;
      /**
       * （US-082）trade_date → market sentiment index_value（0-100）。
       * 未设置（state.marketSentiment 缺该日）→ loadMarketSentimentIndex 返回 null
       * （策略层 fail-OPEN 继续入场）。设置为 0-100 数字让测试可以模拟
       * "情绪冰点"(< 60) vs "情绪偏多"(≥ 60) 两条路径。
       *
       * **测试默认值约定**：FakeDataSource 在构造器里没拿到 marketSentiment 时返回
       * null（fail-OPEN），让既有 24 个测试不需要修改也能继续走入场流程。
       */
      marketSentiment?: Map<string, number>;
    } = {}
  ) {}

  async loadLimitUpStocks(tradeDate: string): Promise<DragonHeadLimitUpRow[]> {
    return this.state.limitUp?.get(tradeDate) ?? [];
  }
  async loadTopIndustries(tradeDate: string, topN: number): Promise<Set<string>> {
    const list = this.state.topIndustries?.get(tradeDate) ?? [];
    return new Set(list.slice(0, topN));
  }
  async loadFamousYzNetBuy(
    tradeDate: string,
    stockCodes: string[]
  ): Promise<Map<string, number>> {
    const m = this.state.famousYzNetBuy?.get(tradeDate) ?? new Map<string, number>();
    const out = new Map<string, number>();
    for (const c of stockCodes) {
      if (m.has(c)) out.set(c, m.get(c)!);
    }
    return out;
  }
  async loadStockMeta(stockCodes: string[]): Promise<Map<string, DragonHeadStockMeta>> {
    const out = new Map<string, DragonHeadStockMeta>();
    for (const c of stockCodes) {
      const meta = this.state.stockMeta?.get(c);
      if (meta) out.set(c, meta);
    }
    return out;
  }
  async loadDailyQuote(
    tradeDate: string,
    stockCodes: string[]
  ): Promise<Map<string, DragonHeadQuote>> {
    const m = this.state.dailyQuote?.get(tradeDate) ?? new Map<string, DragonHeadQuote>();
    const out = new Map<string, DragonHeadQuote>();
    for (const c of stockCodes) {
      if (m.has(c)) out.set(c, m.get(c)!);
    }
    return out;
  }

  async loadMarketSentimentIndex(tradeDate: string): Promise<number | null> {
    if (!this.state.marketSentiment) return null;
    const v = this.state.marketSentiment.get(tradeDate);
    return v === undefined ? null : v;
  }
}

/** 构造一个典型的"5 维都通过"候选 row */
function eligibleRow(
  code: string,
  opts: Partial<{
    continuous_days: number;
    industry: string;
    is_one_word_board: boolean;
    name: string;
  }> = {}
): DragonHeadLimitUpRow {
  return {
    stock_code: code,
    stock_name: opts.name ?? `测试${code}`,
    continuous_days: opts.continuous_days ?? 1,
    industry: opts.industry ?? '半导体',
    is_one_word_board: opts.is_one_word_board ?? false,
    limit_up_time: '10:15:00',
  };
}

function eligibleMeta(
  code: string,
  opts: Partial<DragonHeadStockMeta> = {}
): [string, DragonHeadStockMeta] {
  return [
    code,
    {
      name: opts.name ?? `测试${code}`,
      industry: opts.industry ?? '半导体',
      circulating_market_cap: opts.circulating_market_cap ?? 100 * 1e8, // 100 亿
    },
  ];
}

// ----------------------------------------------------------------
// 测试用例 — Defaults / 配置
// ----------------------------------------------------------------

async function test_default_params_match_AC() {
  const p = DEFAULT_DRAGON_HEAD_PARAMS;
  expectEqual('AC maxPositions=5', p.maxPositions, 5);
  expectEqual('AC minContinuousDays=1', p.minContinuousDays, 1);
  expectEqual('AC maxContinuousDays=3', p.maxContinuousDays, 3);
  expectEqual('AC stopLossPct=-0.07', p.stopLossPct, -0.07);
  expectEqual('topIndustries=10 (AC 行业 top 10)', p.topIndustries, 10);
  expectEqual('minCirculatingMarketCap=30 亿', p.minCirculatingMarketCap, 30 * 1e8);
  expectEqual('maxCirculatingMarketCap=200 亿', p.maxCirculatingMarketCap, 200 * 1e8);
  expectEqual('holdingDaysLimit=3 (AC 持有 3 日强制)', p.holdingDaysLimit, 3);
  expectEqual('highOpenSellHalfPct=0.05 (AC 高开 5%+)', p.highOpenSellHalfPct, 0.05);
  expectEqual('excludeOneWordBoard=true', p.excludeOneWordBoard, true);
  expectEqual('US-082 minMarketSentiment=60', p.minMarketSentiment, 60);
}

async function test_strategy_definition_metadata() {
  const s = new DragonHeadMomentumStrategy(new FakeDataSource());
  expectEqual('strategy_key', s.definition.strategy_key, 'dragon_head_momentum');
  expectEqual('category', s.definition.category, 'momentum');
  expectEqual('risk_level high (短线游资风格)', s.definition.risk_level, 'high');
  assert('enabled=true', s.definition.enabled === true);
  assert(
    'tags 含 短线/龙头',
    s.definition.tags.includes('短线') && s.definition.tags.includes('龙头')
  );
}

// ----------------------------------------------------------------
// 入场 entry 流程测试
// ----------------------------------------------------------------

async function test_entry_all_5_conditions_pass() {
  // 5 维全通过的最简场景
  const tradeDate = '2026-06-05';
  const code = '600519';
  const ds = new FakeDataSource({
    limitUp: new Map([[tradeDate, [eligibleRow(code, { continuous_days: 2 })]]]),
    topIndustries: new Map([[tradeDate, ['半导体', '军工', '光伏设备']]]),
    famousYzNetBuy: new Map([[tradeDate, new Map([[code, 8000_0000]])]]), // 8000 万
    stockMeta: new Map([eligibleMeta(code, { circulating_market_cap: 80 * 1e8 })]),
    dailyQuote: new Map(),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate);
  expectEqual('5 维通过 → 1 BUY', r.signals.filter(x => x.signal === 'buy').length, 1);
  expectEqual('target_positions 1 只', r.target_positions.length, 1);
  expectEqual('eligible_count = 1', r.eligible_count, 1);
  expectEqual('target 包含该股', r.target_positions[0].stock_code, code);
}

async function test_entry_fails_when_continuous_days_out_of_range() {
  const tradeDate = '2026-06-05';
  const ds = new FakeDataSource({
    limitUp: new Map([
      [
        tradeDate,
        [
          eligibleRow('600001', { continuous_days: 0 }), // 0 < min=1
          eligibleRow('600002', { continuous_days: 4 }), // 4 > max=3
          eligibleRow('600003', { continuous_days: 1 }), // 通过
        ],
      ],
    ]),
    topIndustries: new Map([[tradeDate, ['半导体']]]),
    famousYzNetBuy: new Map([
      [tradeDate, new Map([['600001', 1e8], ['600002', 1e8], ['600003', 1e8]])],
    ]),
    stockMeta: new Map([
      eligibleMeta('600001'),
      eligibleMeta('600002'),
      eligibleMeta('600003'),
    ]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate);
  expectEqual('只 1 只通过', r.eligible_count, 1);
  expectEqual('filtered.fail_continuous_days = 2', r.filtered.fail_continuous_days, 2);
  expectEqual('通过的是 600003', r.target_positions[0].stock_code, '600003');
}

async function test_entry_fails_when_industry_not_in_top() {
  const tradeDate = '2026-06-05';
  // 600003 用 inline 构造（eligibleRow 的 ?? 默认会把 undefined 抹成 '半导体'，
  // 这里需要显式 null industry 来模拟 "数据缺失"）
  const row600003: DragonHeadLimitUpRow = {
    stock_code: '600003',
    stock_name: '测试600003',
    continuous_days: 1,
    industry: null,
    is_one_word_board: false,
    limit_up_time: '10:15:00',
  };
  const ds = new FakeDataSource({
    limitUp: new Map([
      [
        tradeDate,
        [
          eligibleRow('600001', { industry: '冷门行业' }), // 不在 top 10
          eligibleRow('600002', { industry: '半导体' }), // top
          row600003, // unknown industry
        ],
      ],
    ]),
    topIndustries: new Map([[tradeDate, ['半导体', '军工', '光伏设备']]]),
    famousYzNetBuy: new Map([
      [tradeDate, new Map([['600001', 1e8], ['600002', 1e8], ['600003', 1e8]])],
    ]),
    stockMeta: new Map([
      eligibleMeta('600001', { industry: '冷门行业' }),
      eligibleMeta('600002', { industry: '半导体' }),
      eligibleMeta('600003'),
    ]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate);
  expectEqual('只 1 只通过', r.eligible_count, 1);
  expectEqual('filtered.fail_industry_top = 1', r.filtered.fail_industry_top, 1);
  expectEqual('filtered.fail_industry_unknown = 1', r.filtered.fail_industry_unknown, 1);
  expectEqual('通过的是 600002', r.target_positions[0].stock_code, '600002');
}

async function test_entry_fails_when_no_famous_yz_net_buy() {
  const tradeDate = '2026-06-05';
  const ds = new FakeDataSource({
    limitUp: new Map([
      [
        tradeDate,
        [
          eligibleRow('600001'),
          eligibleRow('600002'),
          eligibleRow('600003'),
        ],
      ],
    ]),
    topIndustries: new Map([[tradeDate, ['半导体']]]),
    // 600001 无游资数据；600002 游资净卖出；600003 净买入
    famousYzNetBuy: new Map([
      [tradeDate, new Map([['600002', -5000_0000], ['600003', 5000_0000]])],
    ]),
    stockMeta: new Map([
      eligibleMeta('600001'),
      eligibleMeta('600002'),
      eligibleMeta('600003'),
    ]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate);
  expectEqual('只 600003 通过', r.eligible_count, 1);
  expectEqual('filtered.fail_famous_yz = 2', r.filtered.fail_famous_yz, 2);
  expectEqual('通过的是 600003', r.target_positions[0].stock_code, '600003');
}

async function test_entry_fails_when_market_cap_out_of_range() {
  const tradeDate = '2026-06-05';
  const ds = new FakeDataSource({
    limitUp: new Map([
      [
        tradeDate,
        [
          eligibleRow('600001'), // 小盘 20 亿（不到 30）
          eligibleRow('600002'), // 100 亿（通过）
          eligibleRow('600003'), // 250 亿（超 200）
        ],
      ],
    ]),
    topIndustries: new Map([[tradeDate, ['半导体']]]),
    famousYzNetBuy: new Map([
      [tradeDate, new Map([['600001', 1e8], ['600002', 1e8], ['600003', 1e8]])],
    ]),
    stockMeta: new Map([
      eligibleMeta('600001', { circulating_market_cap: 20 * 1e8 }),
      eligibleMeta('600002', { circulating_market_cap: 100 * 1e8 }),
      eligibleMeta('600003', { circulating_market_cap: 250 * 1e8 }),
    ]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate);
  expectEqual('只 600002 通过', r.eligible_count, 1);
  expectEqual('filtered.fail_market_cap = 2', r.filtered.fail_market_cap, 2);
  expectEqual('通过的是 600002', r.target_positions[0].stock_code, '600002');
}

async function test_entry_excludes_one_word_board() {
  const tradeDate = '2026-06-05';
  const ds = new FakeDataSource({
    limitUp: new Map([
      [
        tradeDate,
        [
          eligibleRow('600001', { is_one_word_board: true }), // 一字板 → 抢不到
          eligibleRow('600002', { is_one_word_board: false }),
        ],
      ],
    ]),
    topIndustries: new Map([[tradeDate, ['半导体']]]),
    famousYzNetBuy: new Map([
      [tradeDate, new Map([['600001', 1e8], ['600002', 1e8]])],
    ]),
    stockMeta: new Map([eligibleMeta('600001'), eligibleMeta('600002')]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate);
  expectEqual('一字板被剔除', r.eligible_count, 1);
  expectEqual('filtered.one_word_board = 1', r.filtered.one_word_board, 1);
  expectEqual('通过的是 600002', r.target_positions[0].stock_code, '600002');
}

async function test_entry_max_positions_caps_buys() {
  // 8 只全部通过 + maxPositions=5 → 选游资净买入 top 5
  const tradeDate = '2026-06-05';
  const stocks = ['600001', '600002', '600003', '600004', '600005', '600006', '600007', '600008'];
  const limitUp = stocks.map(c => eligibleRow(c));
  const meta = new Map(stocks.map(c => eligibleMeta(c)));
  // 游资净买入按数字大小排序：600001=8e8, 600002=7e8 …
  const famous = new Map<string, number>();
  stocks.forEach((c, i) => famous.set(c, (8 - i) * 1e8));
  const ds = new FakeDataSource({
    limitUp: new Map([[tradeDate, limitUp]]),
    topIndustries: new Map([[tradeDate, ['半导体']]]),
    famousYzNetBuy: new Map([[tradeDate, famous]]),
    stockMeta: meta,
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate);
  expectEqual('8 全部 eligible', r.eligible_count, 8);
  expectEqual('maxPositions cap = 5', r.target_positions.length, 5);
  // 选了 net buy 最大的 5 只
  const codes = r.target_positions.map(p => p.stock_code).sort();
  expectEqual(
    'BUY 选游资 top-5 = 600001..600005',
    codes,
    ['600001', '600002', '600003', '600004', '600005']
  );
}

async function test_entry_sort_stable_tie_break() {
  // 3 只游资净买入完全相同 → 按 stock_code 升序
  const tradeDate = '2026-06-05';
  const stocks = ['600003', '600001', '600002'];
  const ds = new FakeDataSource({
    limitUp: new Map([[tradeDate, stocks.map(c => eligibleRow(c))]]),
    topIndustries: new Map([[tradeDate, ['半导体']]]),
    famousYzNetBuy: new Map([
      [tradeDate, new Map(stocks.map(c => [c, 5e8]))],
    ]),
    stockMeta: new Map(stocks.map(c => eligibleMeta(c))),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { params: { maxPositions: 2 } });
  expectEqual(
    'tie-break 按 stock_code 升序',
    r.target_positions.map(p => p.stock_code),
    ['600001', '600002']
  );
}

// ----------------------------------------------------------------
// 出场 exit 流程测试
// ----------------------------------------------------------------

async function test_exit_holding_days_limit_force_sell() {
  // 持仓进场日 6/2，今日 6/5 = 3 自然日 → 触发 holdingDaysLimit=3
  const tradeDate = '2026-06-05';
  const code = '600001';
  const pos: DragonHeadPosition = {
    stock_code: code,
    entry_date: '2026-06-02',
    entry_price: 10.0,
  };
  const ds = new FakeDataSource({
    limitUp: new Map([[tradeDate, [eligibleRow(code)]]]),
    dailyQuote: new Map([
      [
        tradeDate,
        new Map([
          [code, { open: 10.5, close: 11, high: 11.2, low: 10.4, prev_close: 10.5, hit_limit_up: false }],
        ]),
      ],
    ]),
    stockMeta: new Map([eligibleMeta(code)]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { currentPositions: [pos] });
  const sell = r.signals.find(x => x.stock_code === code);
  expectEqual('SELL 全部 (持有 3 自然日)', sell?.signal, 'sell');
  assert('SELL reason 含 强制平仓', sell?.reason.includes('强制平仓') === true);
  expectEqual('target_positions 移除该股', r.target_positions.length, 0);
}

async function test_exit_stop_loss_triggers_sell() {
  // 持仓 entry_price=10，今日 close=9.0 → pnl=-10% < stopLossPct=-7%
  const tradeDate = '2026-06-04';
  const code = '600001';
  const pos: DragonHeadPosition = {
    stock_code: code,
    entry_date: '2026-06-03',
    entry_price: 10.0,
  };
  const ds = new FakeDataSource({
    limitUp: new Map([[tradeDate, [eligibleRow(code)]]]), // 仍在涨停（防止炸板规则误触发）
    dailyQuote: new Map([
      [
        tradeDate,
        new Map([
          [code, { open: 9.5, close: 9.0, high: 9.5, low: 8.9, prev_close: 10.0, hit_limit_up: false }],
        ]),
      ],
    ]),
    stockMeta: new Map([eligibleMeta(code)]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { currentPositions: [pos] });
  const sig = r.signals.find(x => x.stock_code === code);
  expectEqual('SELL 止损', sig?.signal, 'sell');
  assert('SELL reason 含 止损', sig?.reason.includes('止损') === true);
}

async function test_exit_break_limit_up_triggers_sell() {
  // 持仓 6/3 进场（首板），6/4 = 1 自然日，当日未涨停 → 炸板触发 SELL
  const tradeDate = '2026-06-04';
  const code = '600001';
  const pos: DragonHeadPosition = {
    stock_code: code,
    entry_date: '2026-06-03',
    entry_price: 10.0,
  };
  const ds = new FakeDataSource({
    // 当日 limitUp 池里没有 600001 → 炸板
    limitUp: new Map([[tradeDate, [eligibleRow('600999')]]]),
    dailyQuote: new Map([
      [
        tradeDate,
        new Map([
          // 价格平稳（不触发止损 / 不触发高开）：open=10.05, close=10.1
          [code, { open: 10.05, close: 10.1, high: 10.3, low: 9.9, prev_close: 10.0, hit_limit_up: false }],
        ]),
      ],
    ]),
    stockMeta: new Map([eligibleMeta(code)]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { currentPositions: [pos] });
  const sig = r.signals.find(x => x.stock_code === code);
  expectEqual('SELL 炸板', sig?.signal, 'sell');
  assert('SELL reason 含 未涨停 / 炸板', sig?.reason.includes('未涨停') === true);
}

async function test_exit_high_open_sell_half() {
  // 持仓 6/3 进场（首板），6/4 = 1 自然日，仍涨停 + 高开 6% → SELL HALF
  const tradeDate = '2026-06-04';
  const code = '600001';
  const pos: DragonHeadPosition = {
    stock_code: code,
    entry_date: '2026-06-03',
    entry_price: 10.0,
  };
  const ds = new FakeDataSource({
    limitUp: new Map([[tradeDate, [eligibleRow(code)]]]), // 仍涨停
    dailyQuote: new Map([
      [
        tradeDate,
        new Map([
          [
            code,
            { open: 10.6, close: 11.0, high: 11.0, low: 10.5, prev_close: 10.0, hit_limit_up: false },
          ], // open=10.6 / prev=10.0 → 高开 6%
        ]),
      ],
    ]),
    stockMeta: new Map([eligibleMeta(code)]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { currentPositions: [pos] });
  const sig = r.signals.find(x => x.stock_code === code);
  expectEqual('SELL_HALF 高开', sig?.signal, 'sell_half');
  assert('SELL_HALF reason 含 高开', sig?.reason.includes('高开') === true);
  // target_positions 仍保留该股（标 half_exited=true）
  const remaining = r.target_positions.find(p => p.stock_code === code);
  assert('target_positions 仍保留持仓', remaining !== undefined);
  assert('half_exited 置 true', remaining?.half_exited === true);
}

async function test_exit_half_exited_does_not_sell_half_again() {
  // 已经减半过的持仓，再次触发高开条件不应再 sell_half
  const tradeDate = '2026-06-05';
  const code = '600001';
  const pos: DragonHeadPosition = {
    stock_code: code,
    entry_date: '2026-06-04', // 1 自然日（不触发持有期）
    entry_price: 10.0,
    half_exited: true,
  };
  const ds = new FakeDataSource({
    limitUp: new Map([[tradeDate, [eligibleRow(code)]]]),
    dailyQuote: new Map([
      [
        tradeDate,
        new Map([
          [code, { open: 10.8, close: 11.0, high: 11.0, low: 10.5, prev_close: 10.0, hit_limit_up: false }],
        ]),
      ],
    ]),
    stockMeta: new Map([eligibleMeta(code)]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { currentPositions: [pos] });
  const sig = r.signals.find(x => x.stock_code === code);
  expectEqual('half_exited 不再 sell_half → HOLD', sig?.signal, 'hold');
}

async function test_exit_priority_holding_days_beats_stop_loss() {
  // 持仓 3 自然日 + 大幅亏损 → 都应触发，先按 holdingDaysLimit
  const tradeDate = '2026-06-05';
  const code = '600001';
  const pos: DragonHeadPosition = {
    stock_code: code,
    entry_date: '2026-06-02',
    entry_price: 10.0,
  };
  const ds = new FakeDataSource({
    limitUp: new Map(),
    dailyQuote: new Map([
      [
        tradeDate,
        new Map([
          [code, { open: 8.5, close: 8.0, high: 8.6, low: 7.9, prev_close: 9.0, hit_limit_up: false }],
        ]),
      ],
    ]),
    stockMeta: new Map([eligibleMeta(code)]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { currentPositions: [pos] });
  const sig = r.signals.find(x => x.stock_code === code);
  expectEqual('优先级：持有期 > 止损', sig?.signal, 'sell');
  assert(
    'reason 应来自持有期 (强制平仓)',
    sig?.reason.includes('强制平仓') === true && sig?.reason.includes('止损') === false
  );
}

async function test_exit_entry_day_no_break_limit_up_check() {
  // 当日进场，持有 0 天，今日就算不在 limitUp 池也不应触发"炸板"判定
  // （因为是同一天 BUY → 炸板规则要求 holdingDays >= 1）
  const tradeDate = '2026-06-05';
  const code = '600001';
  const pos: DragonHeadPosition = {
    stock_code: code,
    entry_date: tradeDate, // 同日
    entry_price: 10.0,
  };
  const ds = new FakeDataSource({
    limitUp: new Map(), // 不在涨停池
    dailyQuote: new Map([
      [
        tradeDate,
        new Map([
          [code, { open: 10.05, close: 10.0, high: 10.1, low: 9.8, prev_close: 10.0, hit_limit_up: false }],
        ]),
      ],
    ]),
    stockMeta: new Map([eligibleMeta(code)]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { currentPositions: [pos] });
  const sig = r.signals.find(x => x.stock_code === code);
  expectEqual('持有 0 天 → 不触发炸板，HOLD', sig?.signal, 'hold');
}

async function test_exit_hold_kept_consumes_buy_slot() {
  // 已有 4 持仓全部 HOLD + 新 eligible 候选 3 只 + maxPositions=5
  // → 只剩 1 个槽位 → 只新 BUY 1 只
  const tradeDate = '2026-06-05';
  const heldCodes = ['600100', '600101', '600102', '600103'];
  const candidateCodes = ['600200', '600201', '600202'];
  const ds = new FakeDataSource({
    limitUp: new Map([[tradeDate, candidateCodes.map(c => eligibleRow(c))]]),
    topIndustries: new Map([[tradeDate, ['半导体']]]),
    famousYzNetBuy: new Map([
      [tradeDate, new Map(candidateCodes.map((c, i) => [c, (3 - i) * 1e8]))],
    ]),
    stockMeta: new Map([
      ...heldCodes.map(c => eligibleMeta(c)),
      ...candidateCodes.map(c => eligibleMeta(c)),
    ]),
    dailyQuote: new Map([
      [
        tradeDate,
        new Map(
          heldCodes.map(c => [
            c,
            { open: 10.05, close: 10.1, high: 10.2, low: 10.0, prev_close: 10.0, hit_limit_up: false },
          ])
        ),
      ],
    ]),
  });
  // 让持仓都成立：当日仍在涨停池才不会触发炸板
  ds['state'].limitUp!.set(tradeDate, [
    ...candidateCodes.map(c => eligibleRow(c)),
    ...heldCodes.map(c => eligibleRow(c)),
  ]);

  const positions: DragonHeadPosition[] = heldCodes.map(c => ({
    stock_code: c,
    entry_date: '2026-06-04', // 1 自然日
    entry_price: 10.0,
  }));
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { currentPositions: positions });

  const buyCount = r.signals.filter(s => s.signal === 'buy').length;
  const holdCount = r.signals.filter(s => s.signal === 'hold').length;
  expectEqual('已有 4 HOLD', holdCount, 4);
  expectEqual('剩余 1 槽位 → 1 BUY', buyCount, 1);
  expectEqual('target_positions = 5', r.target_positions.length, 5);
  // BUY 选 net buy 最大的 600200
  expectEqual(
    'BUY 选游资 top-1 = 600200',
    r.signals.find(s => s.signal === 'buy')?.stock_code,
    '600200'
  );
}

async function test_exit_held_stock_not_re_bought() {
  // 已持仓的股票今天又在涨停池 → 不应该再次 BUY
  const tradeDate = '2026-06-04';
  const code = '600100';
  const ds = new FakeDataSource({
    limitUp: new Map([[tradeDate, [eligibleRow(code)]]]),
    topIndustries: new Map([[tradeDate, ['半导体']]]),
    famousYzNetBuy: new Map([[tradeDate, new Map([[code, 5e8]])]]),
    stockMeta: new Map([eligibleMeta(code)]),
    dailyQuote: new Map([
      [
        tradeDate,
        new Map([
          [code, { open: 10.05, close: 10.1, high: 10.2, low: 10.0, prev_close: 10.0, hit_limit_up: false }],
        ]),
      ],
    ]),
  });
  const pos: DragonHeadPosition = {
    stock_code: code,
    entry_date: '2026-06-03',
    entry_price: 10.0,
  };
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { currentPositions: [pos] });
  const buyOnHeld = r.signals.filter(s => s.signal === 'buy' && s.stock_code === code);
  expectEqual('已持仓不重复 BUY', buyOnHeld.length, 0);
  // 应当 HOLD（不在 limit_up 且 holdingDays=1 ⇒ break_limit_up；但此处仍在 limit_up，所以 HOLD）
  const sig = r.signals.find(s => s.stock_code === code);
  expectEqual('已持仓 → HOLD', sig?.signal, 'hold');
}

async function test_exit_missing_quote_holds_safe() {
  // 没当日行情数据 → 安全 HOLD
  const tradeDate = '2026-06-05';
  const code = '600001';
  const pos: DragonHeadPosition = {
    stock_code: code,
    entry_date: '2026-06-04',
    entry_price: 10.0,
  };
  const ds = new FakeDataSource({
    limitUp: new Map(),
    dailyQuote: new Map(), // 空
    stockMeta: new Map([eligibleMeta(code)]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { currentPositions: [pos] });
  const sig = r.signals.find(s => s.stock_code === code);
  expectEqual('缺行情数据 → HOLD', sig?.signal, 'hold');
  assert('reason 含 缺行情', sig?.reason.includes('缺行情数据') === true);
}

// ----------------------------------------------------------------
// evaluate() & helper 函数
// ----------------------------------------------------------------

async function test_evaluate_returns_informational_hold() {
  const s = new DragonHeadMomentumStrategy(new FakeDataSource());
  const ctx: QuantStockContext = {
    stock_id: 1,
    symbol: '600519.SH',
    name: '贵州茅台',
    bars: [
      { time: new Date('2026-06-05'), open: 1500, high: 1510, low: 1490, close: 1505, volume: 100000 },
    ],
  };
  const r = s.evaluate(ctx);
  expectEqual('evaluate 返回 hold', r.signal, 'hold');
  expectEqual('evaluate strategy_key', r.strategy_key, 'dragon_head_momentum');
  expectEqual('factors.note = use_generateSignals_instead', r.factors.note, 'use_generateSignals_instead');
  assert(
    'evaluate reasons 含 generateSignals 提示',
    r.reasons.some(s => s.includes('generateSignals'))
  );
}

async function test_helper_naturalDaysBetween() {
  expectEqual('同一天 = 0', naturalDaysBetween('2026-06-05', '2026-06-05'), 0);
  expectEqual('1 自然日', naturalDaysBetween('2026-06-04', '2026-06-05'), 1);
  expectEqual('3 自然日', naturalDaysBetween('2026-06-02', '2026-06-05'), 3);
  expectEqual('跨月 7 自然日', naturalDaysBetween('2026-05-30', '2026-06-06'), 7);
  expectEqual('反向 (entry > trade) clamp 至 0', naturalDaysBetween('2026-06-10', '2026-06-05'), 0);
}

async function test_invalid_trade_date_throws() {
  const s = new DragonHeadMomentumStrategy(new FakeDataSource());
  let threw = false;
  try {
    await s.generateSignals('20260605');
  } catch (e) {
    threw = true;
    assert('错误信息含 YYYY-MM-DD', String((e as Error).message).includes('YYYY-MM-DD'));
  }
  assert('非 ISO 日期被拒', threw);
}

async function test_empty_universe_returns_empty() {
  const s = new DragonHeadMomentumStrategy(new FakeDataSource());
  const r = await s.generateSignals('2026-06-05');
  expectEqual('空 universe → target 空', r.target_positions, []);
  expectEqual('空 universe → signals 空', r.signals, []);
  expectEqual('eligible_count = 0', r.eligible_count, 0);
}

async function test_custom_params_override() {
  const tradeDate = '2026-06-05';
  // 用 minContinuousDays=2, maxContinuousDays=5, topIndustries=2
  const ds = new FakeDataSource({
    limitUp: new Map([
      [
        tradeDate,
        [
          eligibleRow('600001', { continuous_days: 1 }), // 1 < min=2 → 剔除
          eligibleRow('600002', { continuous_days: 4 }), // 通过
          eligibleRow('600003', { continuous_days: 6 }), // 6 > max=5 → 剔除
        ],
      ],
    ]),
    topIndustries: new Map([[tradeDate, ['半导体', '军工']]]),
    famousYzNetBuy: new Map([
      [tradeDate, new Map([['600001', 1e8], ['600002', 1e8], ['600003', 1e8]])],
    ]),
    stockMeta: new Map([
      eligibleMeta('600001'),
      eligibleMeta('600002'),
      eligibleMeta('600003'),
    ]),
  });
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, {
    params: { minContinuousDays: 2, maxContinuousDays: 5, topIndustries: 2 },
  });
  expectEqual('自定义连板范围 → 1 通过', r.eligible_count, 1);
  expectEqual('通过的是 600002', r.target_positions[0].stock_code, '600002');
}

// ----------------------------------------------------------------
// US-082 — 市场情绪过滤 (minMarketSentiment)
// ----------------------------------------------------------------

/** 构造一个 5 维全通过的"基础场景"，可被 4 个 US-082 测试复用，只需切 sentiment */
function buildSentimentScenario(
  tradeDate: string,
  sentimentValue: number | null
): FakeDataSource {
  const code = '600519';
  return new FakeDataSource({
    limitUp: new Map([[tradeDate, [eligibleRow(code, { continuous_days: 2 })]]]),
    topIndustries: new Map([[tradeDate, ['半导体']]]),
    famousYzNetBuy: new Map([[tradeDate, new Map([[code, 8000_0000]])]]),
    stockMeta: new Map([eligibleMeta(code, { circulating_market_cap: 80 * 1e8 })]),
    dailyQuote: new Map(),
    marketSentiment: sentimentValue === null ? undefined : new Map([[tradeDate, sentimentValue]]),
  });
}

async function test_us082_sentiment_above_threshold_passes() {
  // 情绪 = 75 > 60 → 正常入场
  const tradeDate = '2026-06-05';
  const ds = buildSentimentScenario(tradeDate, 75);
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate);
  expectEqual('情绪 75 > 60 → BUY 1', r.signals.filter(x => x.signal === 'buy').length, 1);
  expectEqual('eligible 1', r.eligible_count, 1);
  expectEqual('market_sentiment.value = 75', r.market_sentiment.value, 75);
  expectEqual('market_sentiment.blocked = false', r.market_sentiment.blocked, false);
  expectEqual('market_sentiment.threshold = 60 (default)', r.market_sentiment.threshold, 60);
  expectEqual('filtered.sentiment_blocked = 0', r.filtered.sentiment_blocked, 0);
}

async function test_us082_sentiment_at_threshold_passes() {
  // 边界值: 情绪 = 60 = threshold → 正常入场（≥ 通过，严格 < 才阻断）
  const tradeDate = '2026-06-05';
  const ds = buildSentimentScenario(tradeDate, 60);
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate);
  expectEqual('情绪 == threshold → BUY 1', r.signals.filter(x => x.signal === 'buy').length, 1);
  expectEqual('blocked = false', r.market_sentiment.blocked, false);
}

async function test_us082_sentiment_below_threshold_blocks_entry() {
  // 情绪 = 45 < 60 → 跳过新开仓
  const tradeDate = '2026-06-05';
  const ds = buildSentimentScenario(tradeDate, 45);
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate);
  expectEqual('情绪 45 < 60 → BUY 0', r.signals.filter(x => x.signal === 'buy').length, 0);
  expectEqual('eligible_count = 0', r.eligible_count, 0);
  expectEqual('target_positions 空', r.target_positions.length, 0);
  expectEqual('market_sentiment.value = 45', r.market_sentiment.value, 45);
  expectEqual('market_sentiment.blocked = true', r.market_sentiment.blocked, true);
  expectEqual('limit_up_pool_size 仍 = 1', r.filtered.limit_up_pool_size, 1);
  expectEqual('sentiment_blocked = 1 (1 涨停股被跳过)', r.filtered.sentiment_blocked, 1);
}

async function test_us082_sentiment_missing_fails_open() {
  // 情绪指数缺失（marketSentiment 未配置 → loadMarketSentimentIndex 返回 null）
  // → fail-OPEN 继续入场流程，不阻塞
  const tradeDate = '2026-06-05';
  const ds = buildSentimentScenario(tradeDate, null);
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate);
  expectEqual('缺指数 → fail-OPEN BUY 1', r.signals.filter(x => x.signal === 'buy').length, 1);
  expectEqual('blocked = false (fail-OPEN)', r.market_sentiment.blocked, false);
  expectEqual('value = null', r.market_sentiment.value, null);
}

async function test_us082_held_positions_still_exit_when_blocked() {
  // 关键测试：情绪冰点时，已有持仓必须正常走 exit 流程（保护性平仓不被情绪闸门压制）
  // 场景：持有 600100 三日 → 应该触发 holdingDaysLimit=3 强制 SELL
  //       同时 600519 是涨停候选但被情绪闸门跳过 BUY
  const tradeDate = '2026-06-05';
  const heldCode = '600100';
  const newCode = '600519';
  const ds = new FakeDataSource({
    limitUp: new Map([[tradeDate, [eligibleRow(newCode)]]]),
    topIndustries: new Map([[tradeDate, ['半导体']]]),
    famousYzNetBuy: new Map([[tradeDate, new Map([[newCode, 1e8]])]]),
    stockMeta: new Map([eligibleMeta(heldCode), eligibleMeta(newCode)]),
    dailyQuote: new Map([
      [
        tradeDate,
        new Map([
          [
            heldCode,
            { open: 10.05, close: 10.1, high: 10.2, low: 10.0, prev_close: 10.0, hit_limit_up: false },
          ],
        ]),
      ],
    ]),
    // 情绪冰点
    marketSentiment: new Map([[tradeDate, 20]]),
  });
  const pos: DragonHeadPosition = {
    stock_code: heldCode,
    entry_date: '2026-06-02', // 持有 3 自然日
    entry_price: 10.0,
  };
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { currentPositions: [pos] });

  // 持仓 SELL（情绪闸门不影响 exit）
  const sellSig = r.signals.find(x => x.stock_code === heldCode);
  expectEqual('持仓 SELL (情绪不影响 exit)', sellSig?.signal, 'sell');
  // 新候选 BUY 被跳过
  const buyCount = r.signals.filter(x => x.signal === 'buy').length;
  expectEqual('新 BUY 被情绪闸门跳过', buyCount, 0);
  expectEqual('market_sentiment.blocked = true', r.market_sentiment.blocked, true);
  // target_positions 空 (持仓被 SELL 移除，新 BUY 被跳过)
  expectEqual('target_positions 空', r.target_positions.length, 0);
}

async function test_us082_custom_threshold_override() {
  // override minMarketSentiment=30 → 情绪 45 通过；35 仍被阻
  const tradeDate = '2026-06-05';
  const dsPass = buildSentimentScenario(tradeDate, 45);
  const dsBlock = buildSentimentScenario(tradeDate, 25);
  const s = new DragonHeadMomentumStrategy(dsPass);
  const rPass = await s.generateSignals(tradeDate, { params: { minMarketSentiment: 30 } });
  expectEqual('override 30 → 45 通过 BUY 1', rPass.signals.filter(x => x.signal === 'buy').length, 1);
  expectEqual('threshold 透传到结果', rPass.market_sentiment.threshold, 30);

  const s2 = new DragonHeadMomentumStrategy(dsBlock);
  const rBlock = await s2.generateSignals(tradeDate, { params: { minMarketSentiment: 30 } });
  expectEqual('override 30 → 25 阻 BUY 0', rBlock.signals.filter(x => x.signal === 'buy').length, 0);
  expectEqual('blocked = true', rBlock.market_sentiment.blocked, true);
}

async function test_us082_threshold_zero_disables_filter() {
  // minMarketSentiment=0 → 任何 sentiment 都通过（包括 0），相当于关闭过滤
  const tradeDate = '2026-06-05';
  const ds = buildSentimentScenario(tradeDate, 0); // 极度悲观
  const s = new DragonHeadMomentumStrategy(ds);
  const r = await s.generateSignals(tradeDate, { params: { minMarketSentiment: 0 } });
  expectEqual('阈值 0 → 任何情绪都通过 BUY 1', r.signals.filter(x => x.signal === 'buy').length, 1);
  expectEqual('blocked = false', r.market_sentiment.blocked, false);
}

// ----------------------------------------------------------------
// Runner
// ----------------------------------------------------------------

const tests: Array<() => Promise<void>> = [
  test_default_params_match_AC,
  test_strategy_definition_metadata,
  test_entry_all_5_conditions_pass,
  test_entry_fails_when_continuous_days_out_of_range,
  test_entry_fails_when_industry_not_in_top,
  test_entry_fails_when_no_famous_yz_net_buy,
  test_entry_fails_when_market_cap_out_of_range,
  test_entry_excludes_one_word_board,
  test_entry_max_positions_caps_buys,
  test_entry_sort_stable_tie_break,
  test_exit_holding_days_limit_force_sell,
  test_exit_stop_loss_triggers_sell,
  test_exit_break_limit_up_triggers_sell,
  test_exit_high_open_sell_half,
  test_exit_half_exited_does_not_sell_half_again,
  test_exit_priority_holding_days_beats_stop_loss,
  test_exit_entry_day_no_break_limit_up_check,
  test_exit_hold_kept_consumes_buy_slot,
  test_exit_held_stock_not_re_bought,
  test_exit_missing_quote_holds_safe,
  test_evaluate_returns_informational_hold,
  test_helper_naturalDaysBetween,
  test_invalid_trade_date_throws,
  test_empty_universe_returns_empty,
  test_custom_params_override,
  // US-082 - 市场情绪过滤
  test_us082_sentiment_above_threshold_passes,
  test_us082_sentiment_at_threshold_passes,
  test_us082_sentiment_below_threshold_blocks_entry,
  test_us082_sentiment_missing_fails_open,
  test_us082_held_positions_still_exit_when_blocked,
  test_us082_custom_threshold_override,
  test_us082_threshold_zero_disables_filter,
];

(async () => {
  console.log(`\n=== DragonHeadMomentumStrategy unit tests (${tests.length}) ===\n`);
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
