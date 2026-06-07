/**
 * LinkageStrategy 单测（US-027）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/LinkageStrategy.test.ts
 *
 * AC 要求构造 mock 数据验证 entry/exit 触发；本文件覆盖：
 *   - 默认参数符合 AC（maxPositions=5 / leaderMinChangePct=0.09 / candidateMaxYesterdayChangePct=0.05 等）
 *   - 入场 5 维 AND（行业有龙头 + 昨日涨幅 + 流通市值小于龙头 + 开盘高开 + 非 ST）
 *   - 入场各维度独立失败 + boundary 严格 > 测试
 *   - leader 自身排除（不会买入涨停股本身）
 *   - 同股归属多个热门行业只算一次
 *   - 龙头缺市值时安全剔除
 *   - ST 提前过滤
 *   - maxPositions 上限 + HOLD 占用槽位限 BUY
 *   - 排序稳定：leader_change DESC → cand_cap ASC → open_gap ASC → stock_code ASC
 *   - 出场 4 类：持有 N 日 / 止损 / 当日涨停止盈 / 次日大跌
 *   - 出场优先级：持有期 > 止损 > 涨停止盈 > 次日大跌
 *   - 进场首日（holdingDays=0）不触发 next-day drop，但 hit 涨停可触发
 *   - 已持仓不重复 BUY
 *   - 缺当日行情数据安全 HOLD
 *   - evaluate() 返回信息性 hold
 *   - naturalDaysBetween 辅助函数
 *   - invalid trade_date 抛错
 *   - maxPositions <= 0 抛错
 *   - 空 universe 返回空
 *   - 自定义 params override
 *   - hot_industries 字段输出正确
 */

import {
  DEFAULT_LINKAGE_PARAMS,
  LinkageStrategy,
  LinkageDataSource,
  LinkageLimitUpInfo,
  LinkageCandidateMeta,
  LinkageQuote,
  LinkagePosition,
  naturalDaysBetween,
  isSTName,
} from '../../src/quant/strategies/LinkageStrategy';
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

class FakeDataSource implements LinkageDataSource {
  constructor(
    private readonly state: {
      industryLimitUp?: Map<string, Map<string, LinkageLimitUpInfo[]>>; // date → industry → leaders
      constituents?: Map<string, LinkageCandidateMeta[]>; // industry → members
      dailyQuotes?: Map<string, Map<string, LinkageQuote>>; // date → code → quote
      limitUpToday?: Map<string, Set<string>>; // date → set of codes
    } = {}
  ) {}

  async loadIndustryLimitUpStocks(
    tradeDate: string
  ): Promise<Map<string, LinkageLimitUpInfo[]>> {
    return this.state.industryLimitUp?.get(tradeDate) ?? new Map();
  }

  async loadIndustryConstituents(
    industries: string[],
    excludeLimitUpStocks: Set<string>
  ): Promise<Map<string, LinkageCandidateMeta[]>> {
    const out = new Map<string, LinkageCandidateMeta[]>();
    for (const ind of industries) {
      const members = this.state.constituents?.get(ind);
      if (!members) continue;
      const filtered = members.filter(m => !excludeLimitUpStocks.has(m.stock_code));
      out.set(ind, filtered);
    }
    return out;
  }

  async loadDailyQuotes(
    tradeDate: string,
    stockCodes: string[]
  ): Promise<Map<string, LinkageQuote>> {
    const m = this.state.dailyQuotes?.get(tradeDate) ?? new Map<string, LinkageQuote>();
    const out = new Map<string, LinkageQuote>();
    for (const c of stockCodes) {
      const q = m.get(c);
      if (q) out.set(c, q);
    }
    return out;
  }

  async loadLimitUpStocksOnDate(
    tradeDate: string,
    stockCodes: string[]
  ): Promise<Set<string>> {
    const all = this.state.limitUpToday?.get(tradeDate) ?? new Set<string>();
    return new Set([...all].filter(c => stockCodes.includes(c)));
  }
}

// ----------------------------------------------------------------
// Builder helpers
// ----------------------------------------------------------------

function leaderInfo(
  code: string,
  industry: string,
  changePct = 0.10,
  cap = 200 * 1e8,
  name = `${code}_龙头`
): LinkageLimitUpInfo {
  return { stock_code: code, stock_name: name, industry, change_pct: changePct, circulating_market_cap: cap };
}

function cand(
  code: string,
  industry: string,
  cap = 80 * 1e8,
  name = `${code}_候选`
): LinkageCandidateMeta {
  return { stock_code: code, name, industry, circulating_market_cap: cap };
}

function qt(
  todayClose: number,
  todayOpen?: number,
  yesterdayChangePct: number = 0.02,
  changePct: number = 0
): LinkageQuote {
  const prev = todayClose / (1 + changePct);
  const open = todayOpen ?? prev * 1.01; // default +1% open
  const openGap = (open - prev) / prev;
  const yesterdayClose = prev;
  const dayBeforeClose = yesterdayClose / (1 + yesterdayChangePct);
  return {
    open,
    close: todayClose,
    prev_close: prev,
    change_pct: changePct,
    open_gap_pct: openGap,
    yesterday_close: yesterdayClose,
    day_before_yesterday_close: dayBeforeClose,
    yesterday_change_pct: yesterdayChangePct,
  };
}

// ----------------------------------------------------------------
// Test cases
// ----------------------------------------------------------------

async function test_default_params_match_AC() {
  expectEqual('maxPositions=5', DEFAULT_LINKAGE_PARAMS.maxPositions, 5);
  expectEqual('leaderMinChangePct=0.09', DEFAULT_LINKAGE_PARAMS.leaderMinChangePct, 0.09);
  expectEqual(
    'candidateMaxYesterdayChangePct=0.05',
    DEFAULT_LINKAGE_PARAMS.candidateMaxYesterdayChangePct,
    0.05
  );
  expectEqual(
    'candidateMaxOpenGapPct=0.03',
    DEFAULT_LINKAGE_PARAMS.candidateMaxOpenGapPct,
    0.03
  );
  expectEqual('holdingDaysLimit=3', DEFAULT_LINKAGE_PARAMS.holdingDaysLimit, 3);
  expectEqual('exitNextDayDropPct=-0.03', DEFAULT_LINKAGE_PARAMS.exitNextDayDropPct, -0.03);
  expectEqual('stopLossPct=-0.07', DEFAULT_LINKAGE_PARAMS.stopLossPct, -0.07);
  expectEqual('excludeST=true', DEFAULT_LINKAGE_PARAMS.excludeST, true);
}

async function test_strategy_definition() {
  const s = new LinkageStrategy(new FakeDataSource());
  expectEqual('strategy_key', s.definition.strategy_key, 'linkage_strategy');
  expectEqual('category', s.definition.category, 'momentum');
  expectEqual('risk_level', s.definition.risk_level, 'high');
  assert('tags includes 联动', (s.definition.tags ?? []).includes('联动'));
  assert('tags includes 题材扩散', (s.definition.tags ?? []).includes('题材扩散'));
  expectEqual('enabled', s.definition.enabled, true);
}

async function test_entry_all_5_conditions_pass() {
  // 行业「电子」有 600001 龙头 +10% 涨停；候选 600002 流通市值 80 亿 < 龙头 200 亿
  // 昨日涨幅 2% < 5%；开盘高开 1% < 3% → 全部通过
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([
      ['电子', [cand('600002', '电子', 80 * 1e8)]],
    ]),
    dailyQuotes: new Map([
      ['2026-06-05', new Map([['600002', qt(11.0, undefined, 0.02, 0.005)]])],
    ]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible_count=1', res.eligible_count, 1);
  expectEqual('1 buy', res.signals.filter(x => x.signal === 'buy').length, 1);
  expectEqual('target_positions len=1', res.target_positions.length, 1);
  expectEqual('target stock', res.target_positions[0].stock_code, '600002');
  expectEqual('entry_price=11', res.target_positions[0].entry_price, 11);
  expectEqual('entry_leader_code=600001', res.target_positions[0].entry_leader_code, '600001');
  expectEqual('hot_industries len=1', res.hot_industries.length, 1);
  expectEqual('hot_industries[0].industry', res.hot_industries[0].industry, '电子');
  expectEqual('limit_up_count=1', res.filtered.limit_up_stock_count, 1);
}

async function test_entry_fails_when_no_limit_up_in_industry() {
  // 候选行业根本没人涨停 → hot_industry_count=0
  const ds = new FakeDataSource({
    industryLimitUp: new Map(), // 当日 0 涨停
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('limit_up_count=0', res.filtered.limit_up_stock_count, 0);
  expectEqual('hot_industry_count=0', res.filtered.hot_industry_count, 0);
  expectEqual('0 buy', res.signals.filter(x => x.signal === 'buy').length, 0);
}

async function test_entry_fails_when_leader_change_below_threshold() {
  // 龙头涨幅 0.085 < 0.09 阈值 → 该行业不算热门
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.085, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('limit_up_count=1', res.filtered.limit_up_stock_count, 1);
  expectEqual('hot_industry_count=0', res.filtered.hot_industry_count, 0);
}

async function test_entry_leader_change_exactly_at_threshold_fails() {
  // 严格 > 阈值：0.09 恰等于不通过
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.09, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('hot_industry_count=0', res.filtered.hot_industry_count, 0);
}

async function test_entry_fails_when_yesterday_change_too_high() {
  // 昨日涨幅 0.06 > 0.05 阈值 → 候选剔除
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0, undefined, 0.06, 0.005)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual(
    'fail_yesterday_change_too_high=1',
    res.filtered.fail_yesterday_change_too_high,
    1
  );
}

async function test_entry_yesterday_change_exactly_at_threshold_fails() {
  // 严格 < 阈值：0.05 恰等于不通过
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0, undefined, 0.05, 0.005)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_yesterday=1', res.filtered.fail_yesterday_change_too_high, 1);
}

async function test_entry_fails_when_open_gap_too_high() {
  // 开盘高开 0.04 > 0.03 阈值 → 候选剔除
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([
      [
        '2026-06-05',
        new Map([
          ['600002', { open: 10.4, close: 10.5, prev_close: 10.0, change_pct: 0.05, open_gap_pct: 0.04, yesterday_close: 10.0, day_before_yesterday_close: 9.8, yesterday_change_pct: 0.02 }],
        ]),
      ],
    ]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_open_gap_too_high=1', res.filtered.fail_open_gap_too_high, 1);
}

async function test_entry_open_gap_exactly_at_threshold_fails() {
  // 严格 < 阈值：0.03 恰等于不通过
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([
      [
        '2026-06-05',
        new Map([
          ['600002', { open: 10.3, close: 10.5, prev_close: 10.0, change_pct: 0.05, open_gap_pct: 0.03, yesterday_close: 10.0, day_before_yesterday_close: 9.8, yesterday_change_pct: 0.02 }],
        ]),
      ],
    ]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_open_gap=1', res.filtered.fail_open_gap_too_high, 1);
}

async function test_entry_fails_when_cap_not_below_leader() {
  // 候选市值 250 亿 >= 龙头 200 亿 → 不算"联动"
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 250 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_cap_not_below_leader=1', res.filtered.fail_cap_not_below_leader, 1);
}

async function test_entry_cap_exactly_equal_to_leader_fails() {
  // 严格 < 龙头：cap=200亿 恰等于 leader 200亿 不通过
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 200 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_cap_equal=1', res.filtered.fail_cap_not_below_leader, 1);
}

async function test_entry_leader_cap_missing_safe_reject() {
  // 龙头自身缺市值 → 无法判定"小于龙头" → 保守剔除
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [{ ...leaderInfo('600001', '电子', 0.10), circulating_market_cap: null }]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_cap_leader_missing=1', res.filtered.fail_cap_not_below_leader, 1);
}

async function test_entry_fails_for_st_stock() {
  // ST 股 → 提前过滤
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [{ ...cand('600002', '电子', 80 * 1e8), name: 'ST 电子' }]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_st=1', res.filtered.fail_st, 1);
}

async function test_entry_excludeST_false_keeps_st() {
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [{ ...cand('600002', '电子', 80 * 1e8), name: 'ST 电子' }]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0, undefined, 0.02, 0.005)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05', { params: { excludeST: false } });
  expectEqual('eligible=1', res.eligible_count, 1);
  expectEqual('fail_st=0', res.filtered.fail_st, 0);
}

async function test_entry_fails_when_meta_missing_cap() {
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [{ ...cand('600002', '电子'), circulating_market_cap: null }]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_meta=1', res.filtered.fail_meta_missing, 1);
}

async function test_entry_fails_when_quote_missing() {
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map()]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_quote_missing=1', res.filtered.fail_missing_quote, 1);
}

async function test_entry_fails_when_yesterday_quote_missing() {
  // quote 存在但 yesterday_change_pct 是 undefined
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([
      [
        '2026-06-05',
        new Map([
          [
            '600002',
            {
              open: 10.1,
              close: 11.0,
              prev_close: 10.0,
              change_pct: 0.10,
              open_gap_pct: 0.01,
            },
          ],
        ]),
      ],
    ]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=0', res.eligible_count, 0);
  expectEqual('fail_yesterday_missing=1', res.filtered.fail_missing_yesterday, 1);
}

async function test_leader_is_not_in_candidate_pool() {
  // 龙头 600001 本身在涨停股 set 里，会被 loadIndustryConstituents 剔除
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([
      ['电子', [cand('600001', '电子', 200 * 1e8), cand('600002', '电子', 80 * 1e8)]],
    ]),
    dailyQuotes: new Map([
      [
        '2026-06-05',
        new Map([
          ['600001', qt(11.0, undefined, 0.02, 0.005)],
          ['600002', qt(11.0, undefined, 0.02, 0.005)],
        ]),
      ],
    ]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=1', res.eligible_count, 1);
  expectEqual('only 600002 picked', res.target_positions[0].stock_code, '600002');
  // 龙头 600001 不在 BUY 列表里
  assert(
    'leader 600001 not in signals',
    res.signals.every(s => s.stock_code !== '600001')
  );
}

async function test_same_stock_in_multiple_hot_industries_dedup() {
  // 600002 同时被归入「电子」和「半导体」候选 → 只算一次
  // 这模拟了行业归属的边缘情况（很罕见但需要 dedup）
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      [
        '2026-06-05',
        new Map([
          ['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]],
          ['半导体', [leaderInfo('600003', '半导体', 0.10, 250 * 1e8)]],
        ]),
      ],
    ]),
    constituents: new Map([
      ['电子', [cand('600002', '电子', 80 * 1e8)]],
      ['半导体', [cand('600002', '半导体', 80 * 1e8)]],
    ]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0, undefined, 0.02, 0.005)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=1 (dedup)', res.eligible_count, 1);
  expectEqual('only one entry', res.target_positions.length, 1);
}

async function test_held_stock_not_rebought() {
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0, undefined, 0.02, 0.005)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const existing: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const res = await s.generateSignals('2026-06-05', { currentPositions: existing });
  // 持仓首日，HOLD（pnl=+10%, 但今日 600002 没在 limitUpToday 里 → 不触发涨停止盈）
  const buys = res.signals.filter(s => s.signal === 'buy');
  expectEqual('0 buy (already held)', buys.length, 0);
  const holds = res.signals.filter(s => s.signal === 'hold');
  expectEqual('1 hold (existing)', holds.length, 1);
}

async function test_max_positions_caps_buys() {
  // 7 个全部满足条件的候选 / maxPositions=5 → 5 BUY
  const candStocks: LinkageCandidateMeta[] = [];
  const quoteEntries: Array<[string, LinkageQuote]> = [];
  for (let i = 2; i <= 8; i++) {
    const code = `60000${i}`;
    candStocks.push(cand(code, '电子', (80 - i) * 1e8));
    quoteEntries.push([code, qt(10 + i, undefined, 0.02, 0.005)]);
  }
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', candStocks]]),
    dailyQuotes: new Map([['2026-06-05', new Map(quoteEntries)]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=7', res.eligible_count, 7);
  expectEqual('5 buys', res.signals.filter(x => x.signal === 'buy').length, 5);
  expectEqual('target=5', res.target_positions.length, 5);
}

async function test_sort_leader_change_desc() {
  // 2 个热门行业：电子龙头 +12%, 半导体龙头 +10%
  // → 电子行业的候选排在前面
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      [
        '2026-06-05',
        new Map([
          ['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]], // 弱
          ['半导体', [leaderInfo('600003', '半导体', 0.12, 200 * 1e8)]], // 强
        ]),
      ],
    ]),
    constituents: new Map([
      ['电子', [cand('600010', '电子', 80 * 1e8)]],
      ['半导体', [cand('600020', '半导体', 80 * 1e8)]],
    ]),
    dailyQuotes: new Map([
      [
        '2026-06-05',
        new Map([
          ['600010', qt(11.0, undefined, 0.02, 0.005)],
          ['600020', qt(11.0, undefined, 0.02, 0.005)],
        ]),
      ],
    ]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=2', res.eligible_count, 2);
  // 半导体（leader +12%）的候选 600020 排在第一
  expectEqual('first buy is 600020 (semicond strong leader)', res.target_positions[0].stock_code, '600020');
  expectEqual('second buy is 600010', res.target_positions[1].stock_code, '600010');
}

async function test_sort_cap_asc_when_leader_change_tie() {
  // 同一行业 / 同一龙头下：候选股按 cap ASC 排序（小盘弹性优先）
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([
      [
        '电子',
        [
          cand('600010', '电子', 100 * 1e8), // 大
          cand('600020', '电子', 60 * 1e8), // 小（应该排前）
          cand('600030', '电子', 80 * 1e8), // 中
        ],
      ],
    ]),
    dailyQuotes: new Map([
      [
        '2026-06-05',
        new Map([
          ['600010', qt(11.0, undefined, 0.02, 0.005)],
          ['600020', qt(11.0, undefined, 0.02, 0.005)],
          ['600030', qt(11.0, undefined, 0.02, 0.005)],
        ]),
      ],
    ]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=3', res.eligible_count, 3);
  expectEqual('first by smallest cap', res.target_positions[0].stock_code, '600020');
  expectEqual('second', res.target_positions[1].stock_code, '600030');
  expectEqual('third', res.target_positions[2].stock_code, '600010');
}

async function test_sort_open_gap_asc_tiebreak() {
  // 同 leader change / 同 cap 时按 open_gap_pct ASC（高开越小越好）
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([
      [
        '电子',
        [cand('600010', '电子', 80 * 1e8), cand('600020', '电子', 80 * 1e8)],
      ],
    ]),
    dailyQuotes: new Map([
      [
        '2026-06-05',
        new Map([
          ['600010', { open: 10.2, close: 11.0, prev_close: 10.0, change_pct: 0.10, open_gap_pct: 0.02, yesterday_close: 10.0, day_before_yesterday_close: 9.8, yesterday_change_pct: 0.02 }],
          ['600020', { open: 10.1, close: 11.0, prev_close: 10.0, change_pct: 0.10, open_gap_pct: 0.01, yesterday_close: 10.0, day_before_yesterday_close: 9.8, yesterday_change_pct: 0.02 }],
        ]),
      ],
    ]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  // 600020 高开 1% < 600010 高开 2% → 600020 排前
  expectEqual('lower open gap first', res.target_positions[0].stock_code, '600020');
  expectEqual('higher open gap second', res.target_positions[1].stock_code, '600010');
}

async function test_sort_stock_code_tiebreak() {
  // 所有维度都一致时 stock_code 升序稳定 tie-break
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([
      ['电子', [cand('600099', '电子', 80 * 1e8), cand('600010', '电子', 80 * 1e8)]],
    ]),
    dailyQuotes: new Map([
      [
        '2026-06-05',
        new Map([
          ['600099', qt(11.0, undefined, 0.02, 0.005)],
          ['600010', qt(11.0, undefined, 0.02, 0.005)],
        ]),
      ],
    ]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('600010 first (stock_code asc)', res.target_positions[0].stock_code, '600010');
  expectEqual('600099 second', res.target_positions[1].stock_code, '600099');
}

async function test_exit_holding_days_limit_force_sell() {
  // 持有 3 天 → 强制 SELL（即使未涨停未跌）
  const ds = new FakeDataSource({
    industryLimitUp: new Map(),
    dailyQuotes: new Map([['2026-06-08', new Map([['600002', qt(10.2, undefined, 0.01, 0.005)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const res = await s.generateSignals('2026-06-08', { currentPositions: positions });
  const sells = res.signals.filter(s => s.signal === 'sell');
  expectEqual('1 sell', sells.length, 1);
  assert('reason mentions holding days', sells[0].reason.includes('holdingDaysLimit'));
}

async function test_exit_stop_loss_triggers_sell() {
  // 持有 1 天 / pnl = -8% < -7% → 止损 SELL
  const ds = new FakeDataSource({
    industryLimitUp: new Map(),
    dailyQuotes: new Map([['2026-06-06', new Map([['600002', qt(9.2, undefined, 0.01, -0.08)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const res = await s.generateSignals('2026-06-06', { currentPositions: positions });
  const sells = res.signals.filter(s => s.signal === 'sell');
  expectEqual('1 sell', sells.length, 1);
  assert('reason mentions stopLossPct', sells[0].reason.includes('stopLossPct'));
}

async function test_exit_limit_up_triggers_sell_take_profit() {
  // 持有 1 天 / 当日 hit 涨停 → SELL 止盈
  const ds = new FakeDataSource({
    industryLimitUp: new Map(),
    dailyQuotes: new Map([['2026-06-06', new Map([['600002', qt(11.0, undefined, 0.01, 0.10)]])]]),
    limitUpToday: new Map([['2026-06-06', new Set(['600002'])]]),
  });
  const s = new LinkageStrategy(ds);
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const res = await s.generateSignals('2026-06-06', { currentPositions: positions });
  const sells = res.signals.filter(s => s.signal === 'sell');
  expectEqual('1 sell', sells.length, 1);
  assert('reason mentions 涨停', sells[0].reason.includes('涨停'));
}

async function test_exit_next_day_drop_triggers_sell() {
  // 持有 1 天 / change_pct = -5% < -3% → SELL 次日大跌
  const ds = new FakeDataSource({
    industryLimitUp: new Map(),
    dailyQuotes: new Map([['2026-06-06', new Map([['600002', qt(9.5, undefined, 0.01, -0.05)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const res = await s.generateSignals('2026-06-06', { currentPositions: positions });
  const sells = res.signals.filter(s => s.signal === 'sell');
  expectEqual('1 sell', sells.length, 1);
  assert('reason mentions exitNextDayDropPct', sells[0].reason.includes('exitNextDayDropPct'));
}

async function test_exit_priority_holding_days_beats_stop_loss() {
  // 持有 3 天 + pnl=-10% → 持有期触发优先（reason 含 'holdingDaysLimit'）
  const ds = new FakeDataSource({
    industryLimitUp: new Map(),
    dailyQuotes: new Map([['2026-06-08', new Map([['600002', qt(9.0, undefined, 0.01, -0.10)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const res = await s.generateSignals('2026-06-08', { currentPositions: positions });
  const sells = res.signals.filter(s => s.signal === 'sell');
  expectEqual('1 sell', sells.length, 1);
  assert('priority: holdingDays', sells[0].reason.includes('holdingDaysLimit'));
}

async function test_exit_priority_stop_loss_beats_limit_up_take_profit() {
  // 持有 1 天 + pnl=-8% + 当日涨停 → 止损触发优先（reason 含 'stopLossPct'）
  // 这个组合在现实中极少出现（涨停 = 当日涨幅 ~10%，但 entry 太高导致仍亏 8%），
  // 测试的是优先级语义，不是真实场景
  const ds = new FakeDataSource({
    industryLimitUp: new Map(),
    dailyQuotes: new Map([['2026-06-06', new Map([['600002', qt(9.2, undefined, 0.01, -0.08)]])]]),
    limitUpToday: new Map([['2026-06-06', new Set(['600002'])]]),
  });
  const s = new LinkageStrategy(ds);
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const res = await s.generateSignals('2026-06-06', { currentPositions: positions });
  const sells = res.signals.filter(s => s.signal === 'sell');
  expectEqual('1 sell', sells.length, 1);
  assert('priority: stopLoss', sells[0].reason.includes('stopLossPct'));
}

async function test_exit_priority_limit_up_beats_next_day_drop() {
  // 持有 1 天 + 涨停 → SELL 止盈优先于 next-day drop 判定
  const ds = new FakeDataSource({
    industryLimitUp: new Map(),
    dailyQuotes: new Map([['2026-06-06', new Map([['600002', qt(11.0, undefined, 0.01, 0.10)]])]]),
    limitUpToday: new Map([['2026-06-06', new Set(['600002'])]]),
  });
  const s = new LinkageStrategy(ds);
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const res = await s.generateSignals('2026-06-06', { currentPositions: positions });
  const sells = res.signals.filter(s => s.signal === 'sell');
  expectEqual('1 sell', sells.length, 1);
  assert('limit up sells', sells[0].reason.includes('涨停'));
}

async function test_entry_day_no_next_day_drop_check() {
  // holdingDays=0（进场当日）若 change_pct=-5% 不触发出场（避免入场即误平）
  const ds = new FakeDataSource({
    industryLimitUp: new Map(),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(9.5, undefined, 0.01, -0.05)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const res = await s.generateSignals('2026-06-05', { currentPositions: positions });
  // pnl = (9.5 - 10) / 10 = -5% > -7% 止损线 → HOLD（持有期 0 不触发到期，next-day drop 也不触发因 holdingDays=0）
  const sells = res.signals.filter(s => s.signal === 'sell');
  const holds = res.signals.filter(s => s.signal === 'hold');
  expectEqual('0 sell on entry day', sells.length, 0);
  expectEqual('1 hold', holds.length, 1);
}

async function test_entry_day_limit_up_still_triggers_take_profit() {
  // 进场首日（holdingDays=0）若 hit 涨停 → 仍触发止盈（涨停判定不区分持仓天数）
  // 这种情况意味着 BUY 当日就涨停（entry_price 应等于 close，但若 mock 测试中
  // entry < close 仍合理：表示当日盘中买入后涨停）
  const ds = new FakeDataSource({
    industryLimitUp: new Map(),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0, undefined, 0.01, 0.10)]])]]),
    limitUpToday: new Map([['2026-06-05', new Set(['600002'])]]),
  });
  const s = new LinkageStrategy(ds);
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const res = await s.generateSignals('2026-06-05', { currentPositions: positions });
  const sells = res.signals.filter(s => s.signal === 'sell');
  expectEqual('1 sell on entry-day limit up', sells.length, 1);
  assert('limit up reason', sells[0].reason.includes('涨停'));
}

async function test_hold_consumes_buy_slot() {
  // 4 HOLD 持仓 + maxPositions=5 → 只能再 BUY 1 个
  const candStocks: LinkageCandidateMeta[] = [];
  const quoteEntries: Array<[string, LinkageQuote]> = [];
  for (let i = 2; i <= 5; i++) {
    const code = `60000${i}`;
    candStocks.push(cand(code, '电子', (80 - i) * 1e8));
    quoteEntries.push([code, qt(10 + i, undefined, 0.02, 0.005)]);
  }
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-06', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', candStocks]]),
    dailyQuotes: new Map([
      [
        '2026-06-06',
        new Map<string, LinkageQuote>([
          ...quoteEntries,
          // 持仓也需要 quote 才能算 pnl
          ['600010', qt(10.5, undefined, 0.02, 0.01)],
          ['600011', qt(10.5, undefined, 0.02, 0.01)],
          ['600012', qt(10.5, undefined, 0.02, 0.01)],
          ['600013', qt(10.5, undefined, 0.02, 0.01)],
        ]),
      ],
    ]),
  });
  const positions: LinkagePosition[] = [
    { stock_code: '600010', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
    { stock_code: '600011', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
    { stock_code: '600012', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
    { stock_code: '600013', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-06', { currentPositions: positions });
  const buys = res.signals.filter(s => s.signal === 'buy');
  const holds = res.signals.filter(s => s.signal === 'hold');
  expectEqual('4 hold', holds.length, 4);
  expectEqual('1 buy (only 1 slot left)', buys.length, 1);
  expectEqual('target=5', res.target_positions.length, 5);
}

async function test_missing_quote_for_held_position_safe_hold() {
  // 持仓股缺当日 quote → 安全 HOLD
  const ds = new FakeDataSource({
    industryLimitUp: new Map(),
    dailyQuotes: new Map([['2026-06-06', new Map()]]),
  });
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-06', { currentPositions: positions });
  const holds = res.signals.filter(s => s.signal === 'hold');
  expectEqual('1 hold (safe)', holds.length, 1);
  assert('reason mentions 缺行情', holds[0].reason.includes('缺行情数据'));
}

async function test_evaluate_returns_informational_hold() {
  const s = new LinkageStrategy(new FakeDataSource());
  const ctx: QuantStockContext = {
    symbol: '600001.SH',
    name: '测试',
    bars: [
      {
        time: new Date('2026-06-05T00:00:00Z'),
        open: 10,
        high: 10.5,
        low: 9.5,
        close: 10.2,
        volume: 1_000_000,
      },
    ],
  };
  const res = s.evaluate(ctx);
  expectEqual('signal=hold', res.signal, 'hold');
  expectEqual('score=0', res.score, 0);
  assert(
    'factors.note=use_generateSignals_instead',
    res.factors?.note === 'use_generateSignals_instead'
  );
}

async function test_helper_naturalDaysBetween() {
  expectEqual('same day=0', naturalDaysBetween('2026-06-05', '2026-06-05'), 0);
  expectEqual('next day=1', naturalDaysBetween('2026-06-04', '2026-06-05'), 1);
  expectEqual('5 days', naturalDaysBetween('2026-06-01', '2026-06-06'), 5);
  expectEqual('negative→0', naturalDaysBetween('2026-06-06', '2026-06-05'), 0);
  expectEqual('invalid→0', naturalDaysBetween('xxx', '2026-06-05'), 0);
}

async function test_helper_isSTName() {
  assert('ST 前缀', isSTName('ST 电子'));
  assert('*ST 前缀', isSTName('*ST 电子'));
  assert('正常名称', !isSTName('电子'));
  assert('空名称', !isSTName(''));
  assert('undefined', !isSTName(undefined));
}

async function test_invalid_trade_date_throws() {
  const s = new LinkageStrategy(new FakeDataSource());
  try {
    await s.generateSignals('2026/06/05');
    failed += 1;
    console.error('  FAIL invalid_trade_date should throw');
  } catch (err: any) {
    assert('invalid_trade_date throws', err.message.includes('invalid trade_date'));
  }
}

async function test_invalid_max_positions_throws() {
  const s = new LinkageStrategy(new FakeDataSource());
  try {
    await s.generateSignals('2026-06-05', { params: { maxPositions: 0 } });
    failed += 1;
    console.error('  FAIL maxPositions=0 should throw');
  } catch (err: any) {
    assert('maxPositions=0 throws', err.message.includes('maxPositions'));
  }
}

async function test_empty_universe_returns_empty() {
  const s = new LinkageStrategy(new FakeDataSource());
  const res = await s.generateSignals('2026-06-05');
  expectEqual('empty signals', res.signals.length, 0);
  expectEqual('empty target_positions', res.target_positions.length, 0);
  expectEqual('empty hot_industries', res.hot_industries.length, 0);
}

async function test_custom_params_override() {
  // 自定义 leaderMinChangePct=0.05 让 +5% 龙头也可激活行业
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.06, 200 * 1e8)]]])],
    ]),
    constituents: new Map([['电子', [cand('600002', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600002', qt(11.0, undefined, 0.02, 0.005)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05', { params: { leaderMinChangePct: 0.05 } });
  expectEqual('eligible=1 with custom', res.eligible_count, 1);
  expectEqual('params.leaderMinChangePct=0.05', res.params.leaderMinChangePct, 0.05);
}

async function test_hot_industries_output() {
  // 输出含 hot_industries 详情
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      [
        '2026-06-05',
        new Map([
          ['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]],
          ['通信', [leaderInfo('600003', '通信', 0.11, 200 * 1e8)]],
          // 半导体涨幅 5% < 9%，不算热门
          ['半导体', [leaderInfo('600005', '半导体', 0.05, 200 * 1e8)]],
        ]),
      ],
    ]),
    constituents: new Map(),
    dailyQuotes: new Map(),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('hot_industries=2', res.hot_industries.length, 2);
  assert(
    'hot_industries includes 电子',
    res.hot_industries.some(h => h.industry === '电子')
  );
  assert(
    'hot_industries includes 通信',
    res.hot_industries.some(h => h.industry === '通信')
  );
  assert(
    'hot_industries excludes 半导体',
    !res.hot_industries.some(h => h.industry === '半导体')
  );
  expectEqual('limit_up_count=3', res.filtered.limit_up_stock_count, 3);
}

async function test_leader_picked_from_strongest_in_industry() {
  // 行业里多只涨停股，取涨幅最大的为龙头
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      [
        '2026-06-05',
        new Map([
          [
            '电子',
            [
              leaderInfo('600001', '电子', 0.10, 200 * 1e8),
              leaderInfo('600003', '电子', 0.115, 150 * 1e8),
              leaderInfo('600005', '电子', 0.105, 180 * 1e8),
            ],
          ],
        ]),
      ],
    ]),
    constituents: new Map([['电子', [cand('600099', '电子', 80 * 1e8)]]]),
    dailyQuotes: new Map([['2026-06-05', new Map([['600099', qt(11.0, undefined, 0.02, 0.005)]])]]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('hot_industries len=1', res.hot_industries.length, 1);
  expectEqual('leader=600003', res.hot_industries[0].leader_stock_code, '600003');
  expectEqual('leader_change=0.115', res.hot_industries[0].leader_change_pct, 0.115);
  // candidate 用 600003 作为参照
  expectEqual('entry_leader=600003', res.target_positions[0].entry_leader_code, '600003');
}

async function test_target_positions_after_full_exit() {
  // 所有 1 个持仓出场 + 0 候选 → target_positions = []
  const ds = new FakeDataSource({
    industryLimitUp: new Map(),
    dailyQuotes: new Map([['2026-06-08', new Map([['600002', qt(9.0, undefined, 0.01, -0.05)]])]]),
  });
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-08', { currentPositions: positions });
  expectEqual('target empty after full exit', res.target_positions.length, 0);
  expectEqual('1 sell', res.signals.filter(s => s.signal === 'sell').length, 1);
}

async function test_mixed_pass_fail_universe() {
  // 4 个候选：2 通过 + 1 ST + 1 cap 不小于龙头
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-05', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([
      [
        '电子',
        [
          cand('600010', '电子', 80 * 1e8), // ok
          cand('600020', '电子', 60 * 1e8), // ok
          { ...cand('600030', '电子', 80 * 1e8), name: 'ST 电子' }, // ST 剔除
          cand('600040', '电子', 250 * 1e8), // cap > leader
        ],
      ],
    ]),
    dailyQuotes: new Map([
      [
        '2026-06-05',
        new Map([
          ['600010', qt(11.0, undefined, 0.02, 0.005)],
          ['600020', qt(11.0, undefined, 0.02, 0.005)],
          ['600030', qt(11.0, undefined, 0.02, 0.005)],
          ['600040', qt(11.0, undefined, 0.02, 0.005)],
        ]),
      ],
    ]),
  });
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-05');
  expectEqual('eligible=2', res.eligible_count, 2);
  expectEqual('fail_st=1', res.filtered.fail_st, 1);
  expectEqual('fail_cap=1', res.filtered.fail_cap_not_below_leader, 1);
  expectEqual('candidate_pool=4', res.filtered.candidate_pool_size, 4);
}

async function test_dont_buy_already_held_when_candidate() {
  // 持仓中已有 600002 / 候选 600002 + 600003 → 只买 600003
  const ds = new FakeDataSource({
    industryLimitUp: new Map([
      ['2026-06-06', new Map([['电子', [leaderInfo('600001', '电子', 0.10, 200 * 1e8)]]])],
    ]),
    constituents: new Map([
      ['电子', [cand('600002', '电子', 80 * 1e8), cand('600003', '电子', 80 * 1e8)]],
    ]),
    dailyQuotes: new Map([
      [
        '2026-06-06',
        new Map([
          ['600002', qt(10.5, undefined, 0.02, 0.01)],
          ['600003', qt(11.0, undefined, 0.02, 0.005)],
        ]),
      ],
    ]),
  });
  const positions: LinkagePosition[] = [
    { stock_code: '600002', entry_date: '2026-06-05', entry_price: 10.0, entry_industry: '电子' },
  ];
  const s = new LinkageStrategy(ds);
  const res = await s.generateSignals('2026-06-06', { currentPositions: positions });
  const buys = res.signals.filter(s => s.signal === 'buy');
  expectEqual('1 buy', buys.length, 1);
  expectEqual('only 600003', buys[0].stock_code, '600003');
  const holds = res.signals.filter(s => s.signal === 'hold');
  expectEqual('1 hold (existing)', holds.length, 1);
  expectEqual('hold = 600002', holds[0].stock_code, '600002');
}

// ----------------------------------------------------------------
// 测试入口
// ----------------------------------------------------------------

const tests = [
  test_default_params_match_AC,
  test_strategy_definition,
  test_entry_all_5_conditions_pass,
  test_entry_fails_when_no_limit_up_in_industry,
  test_entry_fails_when_leader_change_below_threshold,
  test_entry_leader_change_exactly_at_threshold_fails,
  test_entry_fails_when_yesterday_change_too_high,
  test_entry_yesterday_change_exactly_at_threshold_fails,
  test_entry_fails_when_open_gap_too_high,
  test_entry_open_gap_exactly_at_threshold_fails,
  test_entry_fails_when_cap_not_below_leader,
  test_entry_cap_exactly_equal_to_leader_fails,
  test_entry_leader_cap_missing_safe_reject,
  test_entry_fails_for_st_stock,
  test_entry_excludeST_false_keeps_st,
  test_entry_fails_when_meta_missing_cap,
  test_entry_fails_when_quote_missing,
  test_entry_fails_when_yesterday_quote_missing,
  test_leader_is_not_in_candidate_pool,
  test_same_stock_in_multiple_hot_industries_dedup,
  test_held_stock_not_rebought,
  test_max_positions_caps_buys,
  test_sort_leader_change_desc,
  test_sort_cap_asc_when_leader_change_tie,
  test_sort_open_gap_asc_tiebreak,
  test_sort_stock_code_tiebreak,
  test_exit_holding_days_limit_force_sell,
  test_exit_stop_loss_triggers_sell,
  test_exit_limit_up_triggers_sell_take_profit,
  test_exit_next_day_drop_triggers_sell,
  test_exit_priority_holding_days_beats_stop_loss,
  test_exit_priority_stop_loss_beats_limit_up_take_profit,
  test_exit_priority_limit_up_beats_next_day_drop,
  test_entry_day_no_next_day_drop_check,
  test_entry_day_limit_up_still_triggers_take_profit,
  test_hold_consumes_buy_slot,
  test_missing_quote_for_held_position_safe_hold,
  test_evaluate_returns_informational_hold,
  test_helper_naturalDaysBetween,
  test_helper_isSTName,
  test_invalid_trade_date_throws,
  test_invalid_max_positions_throws,
  test_empty_universe_returns_empty,
  test_custom_params_override,
  test_hot_industries_output,
  test_leader_picked_from_strongest_in_industry,
  test_target_positions_after_full_exit,
  test_mixed_pass_fail_universe,
  test_dont_buy_already_held_when_candidate,
];

(async () => {
  console.log(`\n=== LinkageStrategy unit tests (${tests.length}) ===\n`);
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
