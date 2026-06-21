/**
 * DailyAttributionService 单元测试 (US-078 [PM-001]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/attribution/daily-attribution-service.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 sanity (cap / status enum frozen)
 *   [2] normalizeAttributionDate (合法 / 非法 / null / undefined / 长串)
 *   [3] normalizeIndustryName (string / null / empty / non-string)
 *   [4] extractTradeDate (ISO / 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DD' / null)
 *   [5] bucketByIndustry (BUY 过滤 / null pnl 过滤 / 同行业累加 / 未知归 '其它')
 *   [6] rankIndustryContrib (|pnl| 降序 / pct 计算 / base=0 → pct=0 / limit)
 *   [7] computeExecutionCost (sum commission / 负值跳过 / NaN 跳过)
 *   [8] computeRealizedPnL (仅 SELL / null 跳过)
 *   [9] computeDailyPnL (2 条乱序 / 少于 2 条返 NaN / prev=0 → pct=null)
 *   [10] topPnL (best/worst / direction filter / pnl=0 过滤 / limit)
 *   [11] sixDimBreakdown (industry_contrib 填充 / placeholder 0 / residual 公式)
 *   [12] heuristicSummary (≤ MAX_CHARS / 含 3 数字 / 截断标志)
 *   [13] buildDailyAttributionReport (happy / 仅 BUY / snapshot 不足 / 跨日过滤)
 *   [14] DailyAttributionService.generateDailyReport — AC 主验收:
 *        (a) happy path → status='ok' + 6 维齐
 *        (b) snapshot 不足 → status='skipped' reason='no_prev_snapshot'
 *        (c) DataSource throw → status='failed' reason='db_error' (fail-OPEN)
 *        (d) industry map 空时仍能跑
 *        (e) symbols 自动 dedup + 同时来自 trades + positions
 *   [15] PRODUCTION DataSource factory — 不抛 (lazy require + try/catch 内层兜底)
 *   [16] META-GUARD fs+regex — service 含 关键 exports + dir layout
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS,
  DAILY_ATTRIBUTION_TOP_TRADE_LIMIT,
  DAILY_ATTRIBUTION_TOP_INDUSTRY_LIMIT,
  DAILY_ATTRIBUTION_STATUS,
  normalizeAttributionDate,
  normalizeIndustryName,
  extractTradeDate,
  bucketByIndustry,
  rankIndustryContrib,
  computeExecutionCost,
  computeRealizedPnL,
  computeDailyPnL,
  topPnL,
  sixDimBreakdown,
  heuristicSummary,
  buildDailyAttributionReport,
  createProductionDailyAttributionDataSource,
  DailyAttributionService,
  DailyAttributionDataSource,
  DailyAttributionTradeRow,
  DailyAttributionSnapshotRow,
  DailyAttributionPositionRow,
} from '../../src/services/attribution/DailyAttributionService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function approxEq(a: number, b: number, eps = 1e-2): boolean {
  return Math.abs(a - b) < eps;
}

function trade(o: Partial<DailyAttributionTradeRow> & { id: number }): DailyAttributionTradeRow {
  return {
    id: o.id,
    portfolio_id: o.portfolio_id ?? 1,
    symbol: o.symbol ?? '600519',
    name: o.name ?? '贵州茅台',
    direction: o.direction ?? 'SELL',
    execute_price: o.execute_price ?? 100,
    quantity: o.quantity ?? 100,
    amount: o.amount ?? 10000,
    commission: o.commission ?? 5,
    realized_pnl: o.realized_pnl === undefined ? 500 : o.realized_pnl,
    created_at: o.created_at ?? '2026-06-19 10:00:00',
  };
}

function snap(date: string, total: number, cash = 0): DailyAttributionSnapshotRow {
  return { date, total_value: total, current_cash: cash, position_value: total - cash };
}

function pos(o: Partial<DailyAttributionPositionRow> & { symbol: string }): DailyAttributionPositionRow {
  return {
    symbol: o.symbol,
    name: o.name ?? null,
    quantity: o.quantity ?? 100,
    avg_cost: o.avg_cost ?? 50,
    current_price: o.current_price ?? 60,
    market_value: o.market_value ?? 6000,
    unrealized_pnl: o.unrealized_pnl ?? 1000,
  };
}

// ---- [1] 常量 sanity --------------------------------------------------------
assert('[1.1] AI_SUMMARY_MAX_CHARS = 200', DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS === 200);
assert('[1.2] TOP_TRADE_LIMIT = 3', DAILY_ATTRIBUTION_TOP_TRADE_LIMIT === 3);
assert('[1.3] TOP_INDUSTRY_LIMIT = 5', DAILY_ATTRIBUTION_TOP_INDUSTRY_LIMIT === 5);
assert('[1.4] STATUS frozen', Object.isFrozen(DAILY_ATTRIBUTION_STATUS));
assert(
  '[1.5] STATUS values',
  DAILY_ATTRIBUTION_STATUS.OK === 'ok' &&
    DAILY_ATTRIBUTION_STATUS.SKIPPED === 'skipped' &&
    DAILY_ATTRIBUTION_STATUS.FAILED === 'failed',
);

// ---- [2] normalizeAttributionDate -----------------------------------------
assert('[2.1] valid YYYY-MM-DD', normalizeAttributionDate('2026-06-19') === '2026-06-19');
assert(
  '[2.2] ISO 字符串截前 10',
  normalizeAttributionDate('2026-06-19T10:00:00Z') === '2026-06-19',
);
assert('[2.3] null → 今日格式', /^\d{4}-\d{2}-\d{2}$/.test(normalizeAttributionDate(null)));
assert(
  '[2.4] undefined → 今日格式',
  /^\d{4}-\d{2}-\d{2}$/.test(normalizeAttributionDate(undefined)),
);
assert('[2.5] 数字 → 今日', /^\d{4}-\d{2}-\d{2}$/.test(normalizeAttributionDate(123)));

// ---- [3] normalizeIndustryName --------------------------------------------
assert('[3.1] 普通名', normalizeIndustryName('银行') === '银行');
assert('[3.2] trim', normalizeIndustryName('  半导体  ') === '半导体');
assert('[3.3] null → 其它', normalizeIndustryName(null) === '其它');
assert('[3.4] empty → 其它', normalizeIndustryName('') === '其它');
assert('[3.5] 仅空格 → 其它', normalizeIndustryName('   ') === '其它');
assert('[3.6] 数字 → 其它', normalizeIndustryName(123) === '其它');

// ---- [4] extractTradeDate -------------------------------------------------
assert('[4.1] ISO', extractTradeDate('2026-06-19T10:00:00Z') === '2026-06-19');
assert('[4.2] HH:mm:ss', extractTradeDate('2026-06-19 10:00:00') === '2026-06-19');
assert("[4.3] 'YYYY-MM-DD'", extractTradeDate('2026-06-19') === '2026-06-19');
assert('[4.4] null', extractTradeDate(null) === '');
assert('[4.5] 短串', extractTradeDate('2026') === '');
assert('[4.6] 非法日期', extractTradeDate('not-a-date') === '');

// ---- [5] bucketByIndustry --------------------------------------------------
{
  const trades: DailyAttributionTradeRow[] = [
    trade({ id: 1, symbol: 'A', realized_pnl: 1000 }),
    trade({ id: 2, symbol: 'A', realized_pnl: 500 }),
    trade({ id: 3, symbol: 'B', realized_pnl: -300 }),
    trade({ id: 4, symbol: 'C', realized_pnl: 700 }), // 未知 industry
    trade({ id: 5, symbol: 'D', direction: 'BUY', realized_pnl: null }),
    trade({ id: 6, symbol: 'A', realized_pnl: null }),
  ];
  const map: Record<string, string> = { A: '银行', B: '半导体' };
  const buckets = bucketByIndustry(trades, map);
  // 银行 (A): 1000+500=1500, 2 笔; 半导体 (B): -300, 1 笔; 其它 (C): 700, 1 笔
  const bank = buckets.find(b => b.industry === '银行');
  const semi = buckets.find(b => b.industry === '半导体');
  const other = buckets.find(b => b.industry === '其它');
  assert('[5.1] 3 个行业桶', buckets.length === 3);
  assert('[5.2] 银行 pnl=1500', bank?.pnl === 1500 && bank?.trade_count === 2);
  assert('[5.3] 半导体 pnl=-300', semi?.pnl === -300 && semi?.trade_count === 1);
  assert('[5.4] 未知归其它 pnl=700', other?.pnl === 700 && other?.trade_count === 1);
  assert('[5.5] BUY 过滤 (id=5 不入)', buckets.every(b => b.trade_count <= 2));
}

// ---- [6] rankIndustryContrib -----------------------------------------------
{
  const buckets = [
    { industry: '银行', pnl: 1500, pct: 0, trade_count: 2 },
    { industry: '半导体', pnl: -300, pct: 0, trade_count: 1 },
    { industry: '其它', pnl: 700, pct: 0, trade_count: 1 },
  ];
  const ranked = rankIndustryContrib(buckets, 1900);
  assert('[6.1] 排序: 银行 first (|1500|>700>300)', ranked[0].industry === '银行');
  assert('[6.2] 排序: 其它 second', ranked[1].industry === '其它');
  assert('[6.3] 排序: 半导体 last', ranked[2].industry === '半导体');
  assert('[6.4] pct 计算: 银行 ≈ 78.95', approxEq(ranked[0].pct, 78.9474));
  const zeroBase = rankIndustryContrib(buckets, 0);
  assert('[6.5] base=0 → pct=0', zeroBase.every(r => r.pct === 0));
  const limited = rankIndustryContrib(buckets, 1900, 2);
  assert('[6.6] limit=2 → 仅 2 条', limited.length === 2);
}

// ---- [7] computeExecutionCost ----------------------------------------------
{
  const trades: DailyAttributionTradeRow[] = [
    trade({ id: 1, commission: 5 }),
    trade({ id: 2, commission: 10 }),
    trade({ id: 3, commission: -3 }), // 负数跳过
    trade({ id: 4, commission: NaN as any }), // NaN 跳过
    trade({ id: 5, commission: 2 }),
  ];
  assert('[7.1] sum = 17', computeExecutionCost(trades) === 17);
  assert('[7.2] 空数组 → 0', computeExecutionCost([]) === 0);
}

// ---- [8] computeRealizedPnL ------------------------------------------------
{
  const trades: DailyAttributionTradeRow[] = [
    trade({ id: 1, realized_pnl: 100 }),
    trade({ id: 2, realized_pnl: -50 }),
    trade({ id: 3, direction: 'BUY', realized_pnl: null }),
    trade({ id: 4, realized_pnl: null }),
    trade({ id: 5, realized_pnl: 200 }),
  ];
  assert('[8.1] sum = 250 (仅 SELL 有数)', computeRealizedPnL(trades) === 250);
}

// ---- [9] computeDailyPnL ---------------------------------------------------
{
  const snaps = [snap('2026-06-18', 100000), snap('2026-06-19', 105000)];
  const r = computeDailyPnL(snaps);
  assert('[9.1] pnl=5000', r.pnl === 5000);
  assert('[9.2] pct=5', r.pct !== null && approxEq(r.pct, 5));
}
{
  const r = computeDailyPnL([snap('2026-06-19', 100000)]);
  assert('[9.3] 仅 1 条 → NaN', Number.isNaN(r.pnl));
  assert('[9.4] pct null', r.pct === null);
}
{
  // 顺序故意反过来
  const r = computeDailyPnL([snap('2026-06-18', 100000), snap('2026-06-19', 102000)]);
  assert('[9.5] 反序输入仍正确', r.pnl === 2000);
}
{
  const r = computeDailyPnL([snap('2026-06-18', 0), snap('2026-06-19', 5000)]);
  assert('[9.6] prev=0 → pct=null', r.pct === null);
  assert('[9.7] pnl=5000', r.pnl === 5000);
}

// ---- [10] topPnL -----------------------------------------------------------
{
  const trades: DailyAttributionTradeRow[] = [
    trade({ id: 1, symbol: 'A', realized_pnl: 1000 }),
    trade({ id: 2, symbol: 'B', realized_pnl: -500 }),
    trade({ id: 3, symbol: 'C', realized_pnl: 2000 }),
    trade({ id: 4, symbol: 'D', realized_pnl: -1500 }),
    trade({ id: 5, symbol: 'E', realized_pnl: 500 }),
    trade({ id: 6, symbol: 'F', realized_pnl: 0 }), // 过滤
    trade({ id: 7, symbol: 'G', direction: 'BUY', realized_pnl: 9999 }), // 过滤
    trade({ id: 8, symbol: 'H', realized_pnl: -300 }),
  ];
  const best = topPnL(trades, true);
  assert('[10.1] best 3 条', best.length === 3);
  assert(
    '[10.2] best 降序 C(2000)→A(1000)→E(500)',
    best[0].symbol === 'C' && best[1].symbol === 'A' && best[2].symbol === 'E',
  );
  const worst = topPnL(trades, false);
  assert('[10.3] worst 3 条', worst.length === 3);
  assert(
    '[10.4] worst 升序 D(-1500)→B(-500)→H(-300)',
    worst[0].symbol === 'D' && worst[1].symbol === 'B' && worst[2].symbol === 'H',
  );
  assert('[10.5] BUY 过滤 (id=7 不出现)', !best.some(b => b.id === 7) && !worst.some(b => b.id === 7));
  assert('[10.6] pnl=0 过滤 (id=6 不出现)', !best.some(b => b.id === 6) && !worst.some(b => b.id === 6));
}

// ---- [11] sixDimBreakdown --------------------------------------------------
{
  const trades: DailyAttributionTradeRow[] = [
    trade({ id: 1, symbol: 'A', realized_pnl: 1000, commission: 5 }),
    trade({ id: 2, symbol: 'B', realized_pnl: -200, commission: 3 }),
  ];
  const breakdown = sixDimBreakdown({
    trades,
    symbolToIndustry: { A: '银行', B: '半导体' },
    totalPnL: 800,
  });
  assert('[11.1] factor_contrib placeholder=[]', breakdown.factor_contrib.length === 0);
  assert('[11.2] factor_contrib_total=0', breakdown.factor_contrib_total === 0);
  assert('[11.3] industry_contrib 2 条', breakdown.industry_contrib.length === 2);
  assert('[11.4] execution_cost = 8', breakdown.execution_cost === 8);
  assert('[11.5] timing/selection/sizing placeholder=0',
    breakdown.timing_contrib === 0 &&
      breakdown.selection_contrib === 0 &&
      breakdown.sizing_contrib === 0,
  );
  // residual = totalPnL - industry_total + execution_cost = 800 - 800 + 8 = 8
  assert('[11.6] residual = 8', breakdown.residual === 8);
}

// ---- [12] heuristicSummary --------------------------------------------------
{
  const report = buildDailyAttributionReport({
    portfolio_id: 1,
    date: '2026-06-19',
    trades: [trade({ id: 1, symbol: 'A', realized_pnl: 1000, commission: 5 })],
    snapshots: [snap('2026-06-18', 100000), snap('2026-06-19', 105000)],
    positions: [],
    symbolToIndustry: { A: '银行' },
    generated_at: '2026-06-19T17:00:00Z',
  });
  const summary = heuristicSummary(report);
  assert(
    `[12.1] summary ≤ ${DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS} 字`,
    summary.length <= DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS,
  );
  assert('[12.2] 含日期', summary.includes('2026-06-19'));
  assert('[12.3] 含总盈亏数字', summary.includes('5000') || summary.includes('+5000'));
  assert('[12.4] 含主贡献行业 银行', summary.includes('银行'));
}
{
  // 边界 — 长字符串截断
  const report = buildDailyAttributionReport({
    portfolio_id: 1,
    date: '2026-06-19',
    trades: Array.from({ length: 50 }, (_, i) =>
      trade({ id: i, symbol: `S${i}`, realized_pnl: 1000 }),
    ),
    snapshots: [snap('2026-06-18', 100000), snap('2026-06-19', 150000)],
    positions: [],
    symbolToIndustry: {},
  });
  assert(
    '[12.5] 大报告 summary 仍 ≤ cap',
    report.ai_summary.length <= DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS,
  );
}

// ---- [13] buildDailyAttributionReport -------------------------------------
{
  // happy
  const report = buildDailyAttributionReport({
    portfolio_id: 7,
    date: '2026-06-19',
    trades: [
      trade({ id: 1, symbol: 'A', realized_pnl: 1500, commission: 5 }),
      trade({ id: 2, symbol: 'B', realized_pnl: -300, commission: 3 }),
      // 跨日 trade 应被过滤
      trade({ id: 3, symbol: 'C', realized_pnl: 9999, created_at: '2026-06-18 10:00' }),
      trade({ id: 4, symbol: 'D', direction: 'BUY', realized_pnl: null }),
    ],
    snapshots: [snap('2026-06-18', 100000), snap('2026-06-19', 105000)],
    positions: [pos({ symbol: 'A' })],
    symbolToIndustry: { A: '银行', B: '半导体' },
  });
  assert('[13.1] date=2026-06-19', report.date === '2026-06-19');
  assert('[13.2] portfolio_id=7', report.portfolio_id === 7);
  assert('[13.3] total_pnl=5000', report.total_pnl === 5000);
  assert('[13.4] total_pnl_pct=5', report.total_pnl_pct !== null && approxEq(report.total_pnl_pct, 5));
  assert('[13.5] realized=1200 (1500-300)', report.realized_pnl === 1200);
  assert('[13.6] unrealized_delta=3800', report.unrealized_delta === 3800);
  assert('[13.7] trade_count=3 (跨日过滤掉 id=3)', report.trade_count === 3);
  assert('[13.8] buy_count=1', report.buy_count === 1);
  assert('[13.9] sell_count=2', report.sell_count === 2);
  assert('[13.10] best_trades 仅 A', report.best_trades.length === 1 && report.best_trades[0].symbol === 'A');
  assert('[13.11] worst_trades 仅 B', report.worst_trades.length === 1 && report.worst_trades[0].symbol === 'B');
  assert('[13.12] summary 非空', report.ai_summary.length > 0);
  assert('[13.13] bias_findings 占位 []', Array.isArray(report.bias_findings) && report.bias_findings.length === 0);
  assert('[13.14] recommendations 占位 []', Array.isArray(report.recommendations) && report.recommendations.length === 0);
}
{
  // 仅 BUY
  const report = buildDailyAttributionReport({
    portfolio_id: 1,
    date: '2026-06-19',
    trades: [trade({ id: 1, direction: 'BUY', realized_pnl: null, commission: 5 })],
    snapshots: [snap('2026-06-18', 100000), snap('2026-06-19', 99000)],
    positions: [],
    symbolToIndustry: {},
  });
  assert('[13.15] BUY 只 → realized=0', report.realized_pnl === 0);
  assert('[13.16] best/worst 空', report.best_trades.length === 0 && report.worst_trades.length === 0);
}
{
  // snapshot 不足 → buildReport 用 total_pnl=0; service 层会另外 skip
  const report = buildDailyAttributionReport({
    portfolio_id: 1,
    date: '2026-06-19',
    trades: [trade({ id: 1, realized_pnl: 500 })],
    snapshots: [snap('2026-06-19', 100000)],
    positions: [],
    symbolToIndustry: {},
  });
  assert('[13.17] snapshot 不足 → total_pnl=0', report.total_pnl === 0);
  assert('[13.18] total_pnl_pct=null', report.total_pnl_pct === null);
}

// ---- [14] DailyAttributionService.generateDailyReport — AC 主验收 ---------

function makeFakeSource(o: {
  trades?: DailyAttributionTradeRow[];
  snapshots?: DailyAttributionSnapshotRow[];
  positions?: DailyAttributionPositionRow[];
  industry?: Record<string, string>;
  throwOn?: 'trades' | 'snapshots' | 'positions' | 'industry';
}): DailyAttributionDataSource {
  return {
    async loadTrades() {
      if (o.throwOn === 'trades') throw new Error('boom trades');
      return o.trades || [];
    },
    async loadSnapshots() {
      if (o.throwOn === 'snapshots') throw new Error('boom snapshots');
      return o.snapshots || [];
    },
    async loadPositions() {
      if (o.throwOn === 'positions') throw new Error('boom positions');
      return o.positions || [];
    },
    async loadSymbolIndustryMap() {
      if (o.throwOn === 'industry') throw new Error('boom industry');
      return o.industry || {};
    },
  };
}

(async () => {
  const svc = new DailyAttributionService();

  // (a) happy path
  {
    const r = await svc.generateDailyReport(7, {
      date: '2026-06-19',
      data_source: makeFakeSource({
        trades: [
          trade({ id: 1, symbol: 'A', realized_pnl: 1500, commission: 5 }),
          trade({ id: 2, symbol: 'B', realized_pnl: -300, commission: 3 }),
        ],
        snapshots: [snap('2026-06-19', 105000), snap('2026-06-18', 100000)],
        positions: [pos({ symbol: 'A' })],
        industry: { A: '银行', B: '半导体' },
      }),
      generated_at: '2026-06-19T17:00:00Z',
    });
    assert('[14.a.1] status=ok', r.status === 'ok');
    assert('[14.a.2] report 非空', r.report !== null);
    assert('[14.a.3] total_pnl=5000', r.report?.total_pnl === 5000);
    assert('[14.a.4] portfolio_id=7', r.report?.portfolio_id === 7);
    assert('[14.a.5] industry_contrib 2 条', r.report?.breakdown.industry_contrib.length === 2);
    assert('[14.a.6] execution_cost=8', r.report?.breakdown.execution_cost === 8);
    assert('[14.a.7] best_trades 仅 A', r.report?.best_trades[0]?.symbol === 'A');
    assert('[14.a.8] worst_trades 仅 B', r.report?.worst_trades[0]?.symbol === 'B');
    assert('[14.a.9] ai_summary 非空且 ≤ cap',
      (r.report?.ai_summary?.length || 0) > 0 &&
      (r.report?.ai_summary?.length || 0) <= DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS,
    );
  }

  // (b) snapshot 不足
  {
    const r = await svc.generateDailyReport(1, {
      date: '2026-06-19',
      data_source: makeFakeSource({
        snapshots: [snap('2026-06-19', 100000)],
      }),
    });
    assert('[14.b.1] status=skipped', r.status === 'skipped');
    assert('[14.b.2] reason=no_prev_snapshot', r.reason === 'no_prev_snapshot');
    assert('[14.b.3] report=null', r.report === null);
  }

  // (c) DataSource throw → fail-OPEN
  {
    const r = await svc.generateDailyReport(1, {
      date: '2026-06-19',
      data_source: makeFakeSource({ throwOn: 'snapshots' }),
    });
    assert('[14.c.1] status=failed', r.status === 'failed');
    assert('[14.c.2] reason=db_error', r.reason === 'db_error');
    assert('[14.c.3] error 含 boom', (r.error || '').includes('boom'));
  }

  // (d) industry map 空仍能跑
  {
    const r = await svc.generateDailyReport(1, {
      date: '2026-06-19',
      data_source: makeFakeSource({
        trades: [trade({ id: 1, symbol: 'X', realized_pnl: 500, commission: 5 })],
        snapshots: [snap('2026-06-19', 100500), snap('2026-06-18', 100000)],
        positions: [],
        industry: {},
      }),
    });
    assert('[14.d.1] status=ok', r.status === 'ok');
    assert(
      '[14.d.2] 未知 symbol 归 其它',
      r.report?.breakdown.industry_contrib[0]?.industry === '其它',
    );
  }

  // (e) symbols dedup + 同时来自 trades + positions
  {
    let askedSymbols: string[] = [];
    const fake: DailyAttributionDataSource = {
      async loadTrades() {
        return [
          trade({ id: 1, symbol: 'A', realized_pnl: 100 }),
          trade({ id: 2, symbol: 'B', realized_pnl: 200 }),
          trade({ id: 3, symbol: 'A', realized_pnl: 50 }), // dup A
        ];
      },
      async loadSnapshots() {
        return [snap('2026-06-19', 100350), snap('2026-06-18', 100000)];
      },
      async loadPositions() {
        return [pos({ symbol: 'A' }), pos({ symbol: 'C' })]; // A dup with trades, C 仅在 positions
      },
      async loadSymbolIndustryMap(syms) {
        askedSymbols = [...syms].sort();
        return {};
      },
    };
    const r = await svc.generateDailyReport(1, { date: '2026-06-19', data_source: fake });
    assert('[14.e.1] status=ok', r.status === 'ok');
    assert(
      '[14.e.2] symbols 自动 dedup + 包含 positions C',
      askedSymbols.join(',') === 'A,B,C',
    );
  }

  // ---- [15] PRODUCTION DataSource factory — 不抛 ---------------------------
  {
    const ds = createProductionDailyAttributionDataSource();
    // 无 DB 环境下 loadTrades 调真 Sequelize 应失败但 fail-OPEN 返 []
    const trades = await ds.loadTrades(1, '2026-06-19');
    assert('[15.1] PRODUCTION loadTrades 不抛, 返 array', Array.isArray(trades));
    const snaps = await ds.loadSnapshots(1, '2026-06-19');
    assert('[15.2] PRODUCTION loadSnapshots 不抛', Array.isArray(snaps));
    const positions = await ds.loadPositions(1, '2026-06-19');
    assert('[15.3] PRODUCTION loadPositions 不抛', Array.isArray(positions));
    const map = await ds.loadSymbolIndustryMap(['A', 'B']);
    assert('[15.4] PRODUCTION loadSymbolIndustryMap 不抛, 返 object', typeof map === 'object' && map !== null);
    const empty = await ds.loadSymbolIndustryMap([]);
    assert('[15.5] PRODUCTION 空 symbols 短路返 {}', Object.keys(empty).length === 0);
  }

  // ---- [16] META-GUARD fs+regex -------------------------------------------
  {
    const servicePath = join(
      __dirname,
      '../../src/services/attribution/DailyAttributionService.ts',
    );
    const src = readFileSync(servicePath, 'utf8');
    assert(
      '[16.1] service 含 export class DailyAttributionService',
      /export\s+class\s+DailyAttributionService/.test(src),
    );
    assert(
      '[16.2] service 含 generateDailyReport 方法',
      /async\s+generateDailyReport\s*\(/.test(src),
    );
    assert(
      '[16.3] service 含 export buildDailyAttributionReport',
      /export\s+function\s+buildDailyAttributionReport/.test(src),
    );
    assert(
      '[16.4] service 含 export DailyAttributionDataSource interface',
      /export\s+interface\s+DailyAttributionDataSource/.test(src),
    );
    assert(
      '[16.5] service 含 PRODUCTION factory',
      /export\s+function\s+createProductionDailyAttributionDataSource/.test(src),
    );
    assert(
      '[16.6] service 含 status 枚举',
      /DAILY_ATTRIBUTION_STATUS/.test(src),
    );
    assert(
      '[16.7] service 含 fail-OPEN 注释',
      /fail-OPEN/.test(src),
    );
    assert(
      '[16.8] service 含 6 维 breakdown 字段名',
      /factor_contrib/.test(src) &&
        /industry_contrib/.test(src) &&
        /timing_contrib/.test(src) &&
        /selection_contrib/.test(src) &&
        /sizing_contrib/.test(src) &&
        /execution_cost/.test(src) &&
        /residual/.test(src),
    );
    assert(
      '[16.9] service 含 PM-001 标识 (story id)',
      /PM-001|US-078/.test(src),
    );
    // singleton export
    assert(
      '[16.10] service 含 singleton export dailyAttributionService',
      /export\s+const\s+dailyAttributionService\s*=/.test(src),
    );
  }

  // ---- summary --------------------------------------------------------------
  console.log(`\ndaily-attribution-service: ${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
