/**
 * US-055 [FE-016] PortfolioWorkspace 日归因卡 — 单元测试.
 *
 * 不依赖 jest / DB / 网络 / React; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/daily-attribution-helpers.test.ts
 *
 * 全部 import 自 frontend/src/pages/workspace/dailyAttributionHelpers.ts
 * (pure helpers, 无 antd/react, ts-node 直接吃). 跨 monorepo import 用相对
 * 路径 `../../../frontend/...`, 与 US-049 / US-051 / US-052 / US-054 / US-057
 * helper 单测同款.
 *
 * 覆盖维度:
 *   [1] 常量 sanity (颜色 / TOP_TRADE_LIMIT)
 *   [2] extractTradeDate — ISO / 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DD' / null / 非法
 *   [3] pickDailyPnlColor — 正/负/0/非数
 *   [4] pickAnchorSnapshots — 空 / 1 条 / 2 条乱序 / 多条乱序
 *   [5] filterTradesOnDate — 多日混合 / anchorDate 空 / trades 非数组
 *   [6] buildTopTrades — 仅 SELL / pnl=null/0 过滤 / contributors 降序 / detractors 升序 / >limit 切前 N
 *   [7] buildDailyAttributionViewModel — AC 主验收 4 case:
 *       (a) 完整 happy path (2 snapshots + 多 trades) 全字段精确
 *       (b) snapshots < 2 → hidden=true
 *       (c) anchor 日无 trade → realizedPnl=0, unrealizedChange=dailyPnl, contributors/detractors 空
 *       (d) 仅 BUY 无 SELL → realizedPnl=0, top 列表空
 *   [8] view model 边界 — null/undefined / trades 含非数 created_at
 *   [9] META-GUARD fs+regex:
 *       (a) PortfolioWorkspace.tsx 含 import buildDailyAttributionViewModel
 *       (b) PortfolioWorkspace.tsx tabs 含 attribution key
 *       (c) PortfolioWorkspace.tsx 渲染 <DailyAttributionTab ... />
 *       (d) helper 主要 export 都在
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DAILY_PNL_POSITIVE_COLOR,
  DAILY_PNL_NEGATIVE_COLOR,
  DAILY_PNL_NEUTRAL_COLOR,
  DAILY_TOP_TRADE_LIMIT,
  extractTradeDate,
  pickDailyPnlColor,
  pickAnchorSnapshots,
  filterTradesOnDate,
  buildTopTrades,
  buildDailyAttributionViewModel,
} from '../../../frontend/src/pages/workspace/dailyAttributionHelpers';
import type {
  SnapshotRow,
  TradeRow,
} from '../../../frontend/src/services/portfolioWorkspaceService';

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

function approxEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function makeSnap(date: string, total: number): SnapshotRow {
  return {
    id: 0,
    portfolio_id: 1,
    date,
    total_value: total,
    current_cash: 0,
    position_value: total,
  };
}

function makeTrade(overrides: Partial<TradeRow> & { id: number }): TradeRow {
  return {
    id: overrides.id,
    portfolio_id: 1,
    symbol: overrides.symbol || '600519',
    name: overrides.name || '贵州茅台',
    direction: overrides.direction || 'SELL',
    execute_price: overrides.execute_price ?? 100,
    quantity: overrides.quantity ?? 100,
    amount: overrides.amount ?? (overrides.execute_price ?? 100) * (overrides.quantity ?? 100),
    commission: overrides.commission ?? 0,
    realized_pnl: overrides.realized_pnl === undefined ? 500 : overrides.realized_pnl,
    created_at: overrides.created_at || '2026-06-19 10:00:00',
  };
}

// ---- [1] 常量 sanity --------------------------------------------------------
assert('[1.1] POSITIVE_COLOR = #3f8600', DAILY_PNL_POSITIVE_COLOR === '#3f8600');
assert('[1.2] NEGATIVE_COLOR = #cf1322', DAILY_PNL_NEGATIVE_COLOR === '#cf1322');
assert('[1.3] NEUTRAL_COLOR = #1f1f1f', DAILY_PNL_NEUTRAL_COLOR === '#1f1f1f');
assert('[1.4] TOP_TRADE_LIMIT = 3 (AC)', DAILY_TOP_TRADE_LIMIT === 3);

// ---- [2] extractTradeDate ---------------------------------------------------
assert('[2.1] ISO 字符串', extractTradeDate('2026-06-19T10:00:00Z') === '2026-06-19');
assert(
  "[2.2] 'YYYY-MM-DD HH:mm:ss'",
  extractTradeDate('2026-06-19 10:00:00') === '2026-06-19',
);
assert("[2.3] 'YYYY-MM-DD' 原值", extractTradeDate('2026-06-19') === '2026-06-19');
assert('[2.4] null → 空串', extractTradeDate(null) === '');
assert('[2.5] undefined → 空串', extractTradeDate(undefined) === '');
assert("[2.6] 空串 → 空串", extractTradeDate('') === '');
assert('[2.7] 完全非法字符串 → 空串', extractTradeDate('not-a-date') === '');

// ---- [3] pickDailyPnlColor --------------------------------------------------
assert('[3.1] 正值 → 绿', pickDailyPnlColor(100) === DAILY_PNL_POSITIVE_COLOR);
assert('[3.2] 负值 → 红', pickDailyPnlColor(-100) === DAILY_PNL_NEGATIVE_COLOR);
assert('[3.3] 0 → 中性', pickDailyPnlColor(0) === DAILY_PNL_NEUTRAL_COLOR);
assert('[3.4] NaN → 中性', pickDailyPnlColor(NaN) === DAILY_PNL_NEUTRAL_COLOR);
assert('[3.5] Infinity → 中性', pickDailyPnlColor(Infinity) === DAILY_PNL_NEUTRAL_COLOR);

// ---- [4] pickAnchorSnapshots ------------------------------------------------
assert('[4.1] null → null', pickAnchorSnapshots(null) === null);
assert('[4.2] undefined → null', pickAnchorSnapshots(undefined) === null);
assert('[4.3] 空数组 → null', pickAnchorSnapshots([]) === null);
assert('[4.4] 1 条 → null', pickAnchorSnapshots([makeSnap('2026-06-19', 100000)]) === null);
{
  const r = pickAnchorSnapshots([
    makeSnap('2026-06-19', 105000),
    makeSnap('2026-06-18', 100000),
  ]);
  assert('[4.5] 2 条乱序: anchor 取最晚日', r?.anchor.date === '2026-06-19');
  assert('[4.6] 2 条乱序: prev 取次晚日', r?.prev.date === '2026-06-18');
}
{
  const r = pickAnchorSnapshots([
    makeSnap('2026-06-17', 99000),
    makeSnap('2026-06-19', 105000),
    makeSnap('2026-06-15', 98000),
    makeSnap('2026-06-18', 100000),
  ]);
  assert('[4.7] 多条乱序: anchor=最晚', r?.anchor.date === '2026-06-19');
  assert('[4.8] 多条乱序: prev=次晚', r?.prev.date === '2026-06-18');
}

// ---- [5] filterTradesOnDate -------------------------------------------------
{
  const trades: TradeRow[] = [
    makeTrade({ id: 1, created_at: '2026-06-19 10:00:00' }),
    makeTrade({ id: 2, created_at: '2026-06-19T14:30:00Z' }),
    makeTrade({ id: 3, created_at: '2026-06-18 09:30:00' }),
    makeTrade({ id: 4, created_at: '2026-06-20 11:00:00' }),
  ];
  const filtered = filterTradesOnDate(trades, '2026-06-19');
  assert('[5.1] 多日混合: 仅 2 条 anchor 日', filtered.length === 2);
  assert('[5.2] 含 id=1', filtered.some(t => t.id === 1));
  assert('[5.3] 含 id=2', filtered.some(t => t.id === 2));
}
assert('[5.4] anchorDate 空 → []', filterTradesOnDate([makeTrade({ id: 1 })], '').length === 0);
assert('[5.5] trades null → []', filterTradesOnDate(null, '2026-06-19').length === 0);
assert('[5.6] trades undefined → []', filterTradesOnDate(undefined, '2026-06-19').length === 0);

// ---- [6] buildTopTrades -----------------------------------------------------
{
  const trades: TradeRow[] = [
    makeTrade({ id: 1, symbol: 'A', realized_pnl: 1000 }),
    makeTrade({ id: 2, symbol: 'B', realized_pnl: -500 }),
    makeTrade({ id: 3, symbol: 'C', realized_pnl: 2000 }),
    makeTrade({ id: 4, symbol: 'D', realized_pnl: -1500 }),
    makeTrade({ id: 5, symbol: 'E', realized_pnl: 500 }),
    makeTrade({ id: 6, symbol: 'F', realized_pnl: -200 }),
    makeTrade({ id: 7, symbol: 'G', realized_pnl: 300 }),
    makeTrade({ id: 8, symbol: 'H', realized_pnl: -800 }),
    // 应被过滤掉:
    makeTrade({ id: 9, symbol: 'I', direction: 'BUY', realized_pnl: 9999 }),
    makeTrade({ id: 10, symbol: 'J', realized_pnl: 0 }),
    makeTrade({ id: 11, symbol: 'K', realized_pnl: null }),
  ];
  const { contributors, detractors } = buildTopTrades(trades);
  assert(
    '[6.1] contributors 取前 3 (limit)',
    contributors.length === DAILY_TOP_TRADE_LIMIT,
  );
  assert(
    '[6.2] contributors 降序: C(2000)→A(1000)→E(500)',
    contributors[0].symbol === 'C' &&
      contributors[1].symbol === 'A' &&
      contributors[2].symbol === 'E',
  );
  assert(
    '[6.3] detractors 取前 3 (limit)',
    detractors.length === DAILY_TOP_TRADE_LIMIT,
  );
  assert(
    '[6.4] detractors 升序: D(-1500)→H(-800)→B(-500)',
    detractors[0].symbol === 'D' &&
      detractors[1].symbol === 'H' &&
      detractors[2].symbol === 'B',
  );
  assert(
    '[6.5] BUY direction 过滤掉 (id=9 不出现)',
    !contributors.some(r => r.id === 9) && !detractors.some(r => r.id === 9),
  );
  assert(
    '[6.6] realized_pnl=0 过滤掉 (id=10 不出现)',
    !contributors.some(r => r.id === 10) && !detractors.some(r => r.id === 10),
  );
  assert(
    '[6.7] realized_pnl=null 过滤掉 (id=11 不出现)',
    !contributors.some(r => r.id === 11) && !detractors.some(r => r.id === 11),
  );
}
{
  const empty = buildTopTrades([]);
  assert('[6.8] 空数组 contributors=[]', empty.contributors.length === 0);
  assert('[6.9] 空数组 detractors=[]', empty.detractors.length === 0);
}

// ---- [7] buildDailyAttributionViewModel — AC 主验收 ------------------------
{
  // (a) Happy path: 2 snapshots + 多 trades
  const snaps: SnapshotRow[] = [
    makeSnap('2026-06-18', 100000),
    makeSnap('2026-06-19', 105000), // 日 P&L = 5000
  ];
  const trades: TradeRow[] = [
    makeTrade({ id: 1, symbol: 'A', realized_pnl: 1500, created_at: '2026-06-19 10:00:00' }),
    makeTrade({ id: 2, symbol: 'B', realized_pnl: -300, created_at: '2026-06-19 11:00:00' }),
    makeTrade({
      id: 3,
      symbol: 'C',
      direction: 'BUY',
      realized_pnl: null,
      created_at: '2026-06-19 13:00:00',
    }),
    // 非 anchor 日:
    makeTrade({ id: 4, symbol: 'D', realized_pnl: 8888, created_at: '2026-06-18 14:00:00' }),
  ];
  const vm = buildDailyAttributionViewModel(snaps, trades);
  assert('[7.a.1] hidden=false', vm.hidden === false);
  assert('[7.a.2] anchorDate=2026-06-19', vm.anchorDate === '2026-06-19');
  assert('[7.a.3] prevDate=2026-06-18', vm.prevDate === '2026-06-18');
  assert('[7.a.4] dailyPnl=5000', approxEqual(vm.dailyPnl, 5000));
  assert('[7.a.5] dailyReturnPct=5', approxEqual(vm.dailyReturnPct, 5));
  // realizedPnl 仅取 anchor 日 SELL: 1500 + (-300) = 1200
  assert('[7.a.6] realizedPnl=1200', approxEqual(vm.realizedPnl, 1200));
  // unrealizedChange = 5000 - 1200 = 3800
  assert('[7.a.7] unrealizedChange=3800', approxEqual(vm.unrealizedChange, 3800));
  // tradeCount = anchor 日 3 笔 (A SELL + B SELL + C BUY)
  assert('[7.a.8] tradeCount=3', vm.tradeCount === 3);
  assert('[7.a.9] buyCount=1', vm.buyCount === 1);
  assert('[7.a.10] sellCount=2', vm.sellCount === 2);
  assert(
    '[7.a.11] topContributors 仅 A (B 负不入)',
    vm.topContributors.length === 1 && vm.topContributors[0].symbol === 'A',
  );
  assert(
    '[7.a.12] topDetractors 仅 B (A 正不入)',
    vm.topDetractors.length === 1 && vm.topDetractors[0].symbol === 'B',
  );
  assert('[7.a.13] pnlColor 绿 (dailyPnl=5000>0)', vm.pnlColor === DAILY_PNL_POSITIVE_COLOR);
}
{
  // (b) snapshots < 2 → hidden=true
  const vm = buildDailyAttributionViewModel(
    [makeSnap('2026-06-19', 100000)],
    [makeTrade({ id: 1 })],
  );
  assert('[7.b.1] 单 snapshot → hidden=true', vm.hidden === true);
  assert('[7.b.2] anchorDate 空', vm.anchorDate === '');
  assert('[7.b.3] dailyPnl=0', vm.dailyPnl === 0);
  assert('[7.b.4] topContributors=[]', vm.topContributors.length === 0);
}
{
  // (c) anchor 日无 trade → realizedPnl=0, unrealizedChange=dailyPnl
  const snaps: SnapshotRow[] = [
    makeSnap('2026-06-18', 100000),
    makeSnap('2026-06-19', 102000),
  ];
  const vm = buildDailyAttributionViewModel(snaps, [
    makeTrade({ id: 1, created_at: '2026-06-18 10:00:00', realized_pnl: 999 }),
  ]);
  assert('[7.c.1] hidden=false', vm.hidden === false);
  assert('[7.c.2] dailyPnl=2000', approxEqual(vm.dailyPnl, 2000));
  assert('[7.c.3] realizedPnl=0 (anchor 日无 trade)', vm.realizedPnl === 0);
  assert('[7.c.4] unrealizedChange=dailyPnl=2000', approxEqual(vm.unrealizedChange, 2000));
  assert('[7.c.5] tradeCount=0', vm.tradeCount === 0);
  assert('[7.c.6] topContributors=[]', vm.topContributors.length === 0);
  assert('[7.c.7] topDetractors=[]', vm.topDetractors.length === 0);
}
{
  // (d) 仅 BUY 无 SELL → realizedPnl=0
  const snaps: SnapshotRow[] = [
    makeSnap('2026-06-18', 100000),
    makeSnap('2026-06-19', 98000), // 跌
  ];
  const vm = buildDailyAttributionViewModel(snaps, [
    makeTrade({
      id: 1,
      direction: 'BUY',
      realized_pnl: null,
      created_at: '2026-06-19 09:30:00',
    }),
  ]);
  assert('[7.d.1] dailyPnl=-2000', approxEqual(vm.dailyPnl, -2000));
  assert('[7.d.2] realizedPnl=0 (无 SELL)', vm.realizedPnl === 0);
  assert('[7.d.3] unrealizedChange=-2000', approxEqual(vm.unrealizedChange, -2000));
  assert('[7.d.4] sellCount=0', vm.sellCount === 0);
  assert('[7.d.5] buyCount=1', vm.buyCount === 1);
  assert('[7.d.6] topContributors=[]', vm.topContributors.length === 0);
  assert('[7.d.7] topDetractors=[]', vm.topDetractors.length === 0);
  assert('[7.d.8] pnlColor 红 (dailyPnl<0)', vm.pnlColor === DAILY_PNL_NEGATIVE_COLOR);
}

// ---- [8] view model 边界 ---------------------------------------------------
{
  const vm = buildDailyAttributionViewModel(null, null);
  assert('[8.1] null/null → hidden=true', vm.hidden === true);
}
{
  const vm = buildDailyAttributionViewModel(undefined, undefined);
  assert('[8.2] undefined/undefined → hidden=true', vm.hidden === true);
}
{
  // trades 含非法 created_at — 不应使 anchor trade 计数膨胀
  const snaps: SnapshotRow[] = [
    makeSnap('2026-06-18', 100000),
    makeSnap('2026-06-19', 101000),
  ];
  const trades: TradeRow[] = [
    makeTrade({ id: 1, created_at: 'not-a-date' as any, realized_pnl: 500 }),
    makeTrade({ id: 2, created_at: '2026-06-19 10:00:00', realized_pnl: 700 }),
  ];
  const vm = buildDailyAttributionViewModel(snaps, trades);
  assert('[8.3] 非法 created_at 被过滤, anchor 仅 1 笔', vm.tradeCount === 1);
  assert('[8.4] realizedPnl=700 (仅合法 anchor 日)', approxEqual(vm.realizedPnl, 700));
}
{
  // prev.total_value=0 → dailyReturnPct=0 不爆 NaN
  const snaps: SnapshotRow[] = [makeSnap('2026-06-18', 0), makeSnap('2026-06-19', 5000)];
  const vm = buildDailyAttributionViewModel(snaps, []);
  assert('[8.5] prev=0 → dailyReturnPct=0', vm.dailyReturnPct === 0);
  assert('[8.6] dailyPnl=5000', approxEqual(vm.dailyPnl, 5000));
}

// ---- [9] META-GUARD fs+regex -----------------------------------------------
{
  const workspacePath = join(
    __dirname,
    '../../../frontend/src/pages/workspace/PortfolioWorkspace.tsx',
  );
  const src = readFileSync(workspacePath, 'utf8');
  assert(
    '[9.1] PortfolioWorkspace.tsx import buildDailyAttributionViewModel',
    /import\s*\{[^}]*buildDailyAttributionViewModel[^}]*\}\s*from\s*['"]\.\/dailyAttributionHelpers['"]/.test(
      src,
    ),
  );
  assert(
    '[9.2] tabs 含 attribution key + 日归因 label',
    /key:\s*['"]attribution['"][^}]*label:\s*['"]日归因['"]/.test(src),
  );
  assert(
    '[9.3] PortfolioWorkspace.tsx 渲染 <DailyAttributionTab',
    /<DailyAttributionTab\s+snapshots=\{snapshots\}\s+trades=\{trades\}\s*\/>/.test(src),
  );
  assert(
    '[9.4] DailyAttributionTab 组件定义在原文件',
    /const DailyAttributionTab[:\s]/.test(src),
  );
}
{
  const helperPath = join(
    __dirname,
    '../../../frontend/src/pages/workspace/dailyAttributionHelpers.ts',
  );
  const src = readFileSync(helperPath, 'utf8');
  assert(
    '[9.5] helper export buildDailyAttributionViewModel',
    /export\s+function\s+buildDailyAttributionViewModel/.test(src),
  );
  assert(
    '[9.6] helper export pickAnchorSnapshots',
    /export\s+function\s+pickAnchorSnapshots/.test(src),
  );
  assert(
    '[9.7] helper export buildTopTrades',
    /export\s+function\s+buildTopTrades/.test(src),
  );
  assert(
    '[9.8] helper export filterTradesOnDate',
    /export\s+function\s+filterTradesOnDate/.test(src),
  );
  assert(
    '[9.9] helper export extractTradeDate',
    /export\s+function\s+extractTradeDate/.test(src),
  );
  assert(
    '[9.10] helper export DAILY_TOP_TRADE_LIMIT',
    /export\s+const\s+DAILY_TOP_TRADE_LIMIT\s*=\s*3/.test(src),
  );
  assert(
    '[9.11] helper export DAILY_PNL_POSITIVE_COLOR',
    /export\s+const\s+DAILY_PNL_POSITIVE_COLOR/.test(src),
  );
}

// ---- summary ---------------------------------------------------------------
console.log(`\ndaily-attribution-helpers: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
