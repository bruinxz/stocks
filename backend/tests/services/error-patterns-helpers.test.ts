/**
 * US-059 [FE-020] PortfolioWorkspace AI 日记 + 错误模式 tab — 单元测试.
 *
 * 不依赖 jest / DB / 网络 / React; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/error-patterns-helpers.test.ts
 *
 * 全部 import 自 frontend/src/pages/workspace/errorPatternsHelpers.ts (pure
 * helpers, 无 antd/react, ts-node 直接吃). 跨 monorepo import 用相对路径
 * `../../../frontend/...`, 与 US-049 / US-051 / US-052 / US-054 / US-055 /
 * US-057 helper 单测同款.
 *
 * 覆盖维度:
 *   [1] 常量 / 配色 sanity
 *   [2] 决策表 computeRepeatLossPriority / computeLargeLossPriority /
 *       computeSameDayStreakPriority / computeChronicLossPriority
 *   [3] groupLossesBySymbol — 仅 SELL loss 入组 + name 兜底
 *   [4] buildRepeatLossPatterns — count 阈值 + priority 与决策表对齐
 *   [5] buildLargeLossPatterns — 绝对额 + 占比 双阈值
 *   [6] buildSameDayStreakPatterns — 同日 ≥2 笔
 *   [7] buildChronicLossPatterns — 集合差 (不与 repeat_loss 重复) + 阈值
 *   [8] sortPatterns — priority 降 → sortKey 降 → key 字母序稳定
 *   [9] countJournalsInWindow + aggregateJournalTags
 *   [10] buildJournalAiSummary — happy + 空 + mood 三态 + 标签
 *   [11] buildErrorPatternsViewModel — AC 主验收 (混合 trades + journal)
 *   [12] view model 边界 — null/undefined / 全盈利 / 仅 BUY
 *   [13] META-GUARD fs+regex:
 *        (a) PortfolioWorkspace.tsx 含 import buildErrorPatternsViewModel
 *        (b) tabs 含 'error-patterns' key + AI 日记 + 错误模式 label
 *        (c) 渲染 <ErrorPatternsTab ... />
 *        (d) helper 主要 export 都在
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AI_JOURNAL_MOOD,
  CHRONIC_LOSS_MIN_ABS,
  ERROR_PATTERN_KIND_LABEL,
  ERROR_PATTERN_PRIORITY_COLOR,
  ERROR_PATTERN_PRIORITY_LABEL,
  LARGE_LOSS_ABS_MIN,
  LARGE_LOSS_RATIO_MIN,
  PATTERN_TOP_LIMIT,
  RECENT_WINDOW_30D,
  RECENT_WINDOW_7D,
  REPEAT_LOSS_MIN_COUNT,
  SAME_DAY_LOSS_MIN_COUNT,
  aggregateJournalTags,
  buildChronicLossPatterns,
  buildErrorPatternsViewModel,
  buildJournalAiSummary,
  buildLargeLossPatterns,
  buildRepeatLossPatterns,
  buildSameDayStreakPatterns,
  computeChronicLossPriority,
  computeLargeLossPriority,
  computeRepeatLossPriority,
  computeSameDayStreakPriority,
  countJournalsInWindow,
  formatMoney,
  formatRatioPct,
  groupLossesBySymbol,
  sortPatterns,
} from '../../../frontend/src/pages/workspace/errorPatternsHelpers';
import type {
  JournalSummary,
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

function makeTrade(overrides: Partial<TradeRow> & { id: number }): TradeRow {
  return {
    id: overrides.id,
    portfolio_id: 1,
    symbol: overrides.symbol || '600519',
    name: overrides.name || '贵州茅台',
    direction: overrides.direction || 'SELL',
    execute_price: overrides.execute_price ?? 100,
    quantity: overrides.quantity ?? 100,
    amount:
      overrides.amount ?? (overrides.execute_price ?? 100) * (overrides.quantity ?? 100),
    commission: overrides.commission ?? 0,
    realized_pnl: overrides.realized_pnl === undefined ? -500 : overrides.realized_pnl,
    created_at: overrides.created_at || '2026-06-19 10:00:00',
  };
}

function makeJournal(
  date: string,
  mood: string | null = AI_JOURNAL_MOOD,
  tags: string[] | null = []
): JournalSummary {
  return { id: 0, date, mood, tags };
}

// ---- [1] 常量 / 配色 sanity --------------------------------------------------
assert('[1.1] LARGE_LOSS_ABS_MIN=200 (¥)', LARGE_LOSS_ABS_MIN === 200);
assert('[1.2] LARGE_LOSS_RATIO_MIN=0.05', LARGE_LOSS_RATIO_MIN === 0.05);
assert('[1.3] REPEAT_LOSS_MIN_COUNT=2', REPEAT_LOSS_MIN_COUNT === 2);
assert('[1.4] SAME_DAY_LOSS_MIN_COUNT=2', SAME_DAY_LOSS_MIN_COUNT === 2);
assert('[1.5] CHRONIC_LOSS_MIN_ABS=500', CHRONIC_LOSS_MIN_ABS === 500);
assert('[1.6] PATTERN_TOP_LIMIT=5', PATTERN_TOP_LIMIT === 5);
assert('[1.7] AI_JOURNAL_MOOD=AI', AI_JOURNAL_MOOD === 'AI');
assert('[1.8] RECENT_WINDOW_7D=7', RECENT_WINDOW_7D === 7);
assert('[1.9] RECENT_WINDOW_30D=30', RECENT_WINDOW_30D === 30);
assert('[1.10] critical 颜色红', ERROR_PATTERN_PRIORITY_COLOR.critical === '#cf1322');
assert('[1.11] high 颜色橙', ERROR_PATTERN_PRIORITY_COLOR.high === '#fa8c16');
assert('[1.12] medium 颜色黄', ERROR_PATTERN_PRIORITY_COLOR.medium === '#fadb14');
assert('[1.13] low 颜色灰', ERROR_PATTERN_PRIORITY_COLOR.low === '#8c8c8c');
assert(
  '[1.14] PRIORITY_LABEL 全 4 档',
  ERROR_PATTERN_PRIORITY_LABEL.critical === '严重' &&
    ERROR_PATTERN_PRIORITY_LABEL.high === '高' &&
    ERROR_PATTERN_PRIORITY_LABEL.medium === '中' &&
    ERROR_PATTERN_PRIORITY_LABEL.low === '低'
);
assert(
  '[1.15] KIND_LABEL 4 类',
  ERROR_PATTERN_KIND_LABEL.repeat_loss === '反复踩雷' &&
    ERROR_PATTERN_KIND_LABEL.large_loss === '大额亏损' &&
    ERROR_PATTERN_KIND_LABEL.same_day_streak === '单日连亏' &&
    ERROR_PATTERN_KIND_LABEL.chronic_loss === '慢性失血'
);

// ---- [2] 决策表 --------------------------------------------------------------
assert('[2.1] repeatLoss count=2 → medium', computeRepeatLossPriority(2) === 'medium');
assert('[2.2] repeatLoss count=3 → high', computeRepeatLossPriority(3) === 'high');
assert('[2.3] repeatLoss count=4 → critical', computeRepeatLossPriority(4) === 'critical');
assert('[2.4] repeatLoss count=10 → critical', computeRepeatLossPriority(10) === 'critical');
assert('[2.5] largeLoss ratio=0.05 → medium', computeLargeLossPriority(0.05) === 'medium');
assert('[2.6] largeLoss ratio=0.11 → high', computeLargeLossPriority(0.11) === 'high');
assert('[2.7] largeLoss ratio=0.16 → critical', computeLargeLossPriority(0.16) === 'critical');
assert(
  '[2.8] largeLoss ratio=0.10 → medium (边界)',
  computeLargeLossPriority(0.1) === 'medium'
);
assert('[2.9] sameDay count=2 → medium', computeSameDayStreakPriority(2) === 'medium');
assert('[2.10] sameDay count=3 → high', computeSameDayStreakPriority(3) === 'high');
assert('[2.11] sameDay count=4 → critical', computeSameDayStreakPriority(4) === 'critical');
assert('[2.12] chronicLoss 始终 low', computeChronicLossPriority() === 'low');

// ---- [3] groupLossesBySymbol -------------------------------------------------
{
  const trades: TradeRow[] = [
    makeTrade({ id: 1, symbol: 'A', name: 'A股', realized_pnl: -300 }),
    makeTrade({ id: 2, symbol: 'A', name: 'A股', realized_pnl: -700 }),
    makeTrade({ id: 3, symbol: 'B', name: 'B股', realized_pnl: -1000 }),
    makeTrade({ id: 4, symbol: 'A', name: 'A股', realized_pnl: 500 }), // 盈利不计
    makeTrade({ id: 5, symbol: 'C', direction: 'BUY', realized_pnl: -999 }), // BUY 不计
    makeTrade({ id: 6, symbol: 'D', name: 'D股', realized_pnl: null }), // null 不计
  ];
  const map = groupLossesBySymbol(trades);
  assert('[3.1] groupLossesBySymbol 仅 2 个 symbol', map.size === 2);
  const a = map.get('A');
  assert('[3.2] A 累亏 2 笔', !!a && a.losses.length === 2);
  assert('[3.3] A totalLoss=1000', !!a && approxEqual(a.totalLoss, 1000));
  assert('[3.4] A maxLoss=700', !!a && approxEqual(a.maxLoss, 700));
  const b = map.get('B');
  assert('[3.5] B totalLoss=1000', !!b && approxEqual(b.totalLoss, 1000));
  assert('[3.6] 无 BUY/null 行', !map.has('C') && !map.has('D'));
}

// ---- [4] buildRepeatLossPatterns --------------------------------------------
{
  const trades: TradeRow[] = [
    makeTrade({ id: 1, symbol: 'A', realized_pnl: -300 }),
    makeTrade({ id: 2, symbol: 'A', realized_pnl: -700 }),
    makeTrade({ id: 3, symbol: 'A', realized_pnl: -200 }),
    makeTrade({ id: 4, symbol: 'B', realized_pnl: -100 }), // 仅 1 笔不入
  ];
  const rows = buildRepeatLossPatterns(groupLossesBySymbol(trades));
  assert('[4.1] rows.length=1 (仅 A 入)', rows.length === 1);
  assert('[4.2] A 触发 high (count=3)', rows[0].priority === 'high');
  assert('[4.3] anchor=A', rows[0].anchor === 'A');
  assert('[4.4] tradeIds 含 1/2/3', rows[0].tradeIds.sort().join(',') === '1,2,3');
  assert('[4.5] sortKey=1200', approxEqual(rows[0].sortKey, 1200));
  assert('[4.6] title 含 "连亏 3 次"', rows[0].title.includes('连亏 3 次'));
}

// ---- [5] buildLargeLossPatterns ---------------------------------------------
{
  const trades: TradeRow[] = [
    // 大额 + 占比超阈值 → 入
    makeTrade({ id: 1, symbol: 'A', execute_price: 100, quantity: 100, realized_pnl: -1500 }),
    // 大额但占比 < 5% → 不入 (10000 amount, 200 loss = 2%)
    makeTrade({ id: 2, symbol: 'B', execute_price: 100, quantity: 100, realized_pnl: -200 }),
    // 占比高但绝对额 < 200 → 不入 (1000 amount, 100 loss = 10%)
    makeTrade({ id: 3, symbol: 'C', execute_price: 10, quantity: 100, realized_pnl: -100 }),
    // 临界值: ratio=0.16 (高于 0.15) → critical
    makeTrade({
      id: 4,
      symbol: 'D',
      execute_price: 100,
      quantity: 100,
      amount: 10000,
      realized_pnl: -1600,
    }),
    // 盈利不计
    makeTrade({ id: 5, symbol: 'E', realized_pnl: 1000 }),
  ];
  const rows = buildLargeLossPatterns(trades);
  assert('[5.1] rows.length=2 (A + D 入)', rows.length === 2);
  const a = rows.find(r => r.anchor === '1');
  const d = rows.find(r => r.anchor === '4');
  assert('[5.2] A priority=high (15%, > 10%)', !!a && a.priority === 'high');
  assert('[5.3] D priority=critical (16%, > 15%)', !!d && d.priority === 'critical');
  assert('[5.4] A sortKey=1500', !!a && approxEqual(a.sortKey, 1500));
  assert('[5.5] A tradeIds=[1]', !!a && a.tradeIds.length === 1 && a.tradeIds[0] === 1);
  assert('[5.6] B 未入 (占比低)', !rows.find(r => r.anchor === '2'));
  assert('[5.7] C 未入 (绝对额低)', !rows.find(r => r.anchor === '3'));
  assert('[5.8] E 未入 (盈利)', !rows.find(r => r.anchor === '5'));
}

// ---- [6] buildSameDayStreakPatterns -----------------------------------------
{
  const trades: TradeRow[] = [
    makeTrade({ id: 1, created_at: '2026-06-18 09:30:00', realized_pnl: -100 }),
    makeTrade({ id: 2, created_at: '2026-06-18 14:00:00', realized_pnl: -200 }),
    makeTrade({ id: 3, created_at: '2026-06-18 15:00:00', realized_pnl: -50 }),
    makeTrade({ id: 4, created_at: '2026-06-19 10:00:00', realized_pnl: -500 }), // 单日 1 笔不入
    makeTrade({ id: 5, created_at: '2026-06-17 10:00:00', realized_pnl: 500 }), // 盈利不计
  ];
  const rows = buildSameDayStreakPatterns(trades);
  assert('[6.1] rows.length=1 (仅 06-18)', rows.length === 1);
  assert('[6.2] anchor=2026-06-18', rows[0].anchor === '2026-06-18');
  assert('[6.3] priority=high (count=3)', rows[0].priority === 'high');
  assert('[6.4] sortKey=350 (合计 100+200+50)', approxEqual(rows[0].sortKey, 350));
  assert('[6.5] tradeIds 含 3 笔', rows[0].tradeIds.length === 3);
  assert('[6.6] title 含 "当日连亏 3 笔"', rows[0].title.includes('当日连亏 3 笔'));
}

// ---- [7] buildChronicLossPatterns -------------------------------------------
{
  const trades: TradeRow[] = [
    // 单笔大额亏损但仅 1 笔, 累计 > 500 → chronic_loss 入
    makeTrade({ id: 1, symbol: 'X', name: 'X股', realized_pnl: -800 }),
    // 单笔但累计 < 500 → 不入
    makeTrade({ id: 2, symbol: 'Y', name: 'Y股', realized_pnl: -200 }),
    // 多笔 → 被 repeat_loss 覆盖, chronic_loss 不重复
    makeTrade({ id: 3, symbol: 'Z', name: 'Z股', realized_pnl: -300 }),
    makeTrade({ id: 4, symbol: 'Z', name: 'Z股', realized_pnl: -400 }),
  ];
  const rows = buildChronicLossPatterns(groupLossesBySymbol(trades));
  assert('[7.1] rows.length=1 (仅 X 入)', rows.length === 1);
  assert('[7.2] X anchor', rows[0].anchor === 'X');
  assert('[7.3] X priority=low', rows[0].priority === 'low');
  assert('[7.4] X sortKey=800', approxEqual(rows[0].sortKey, 800));
  assert('[7.5] Y 未入 (< 阈值)', !rows.find(r => r.anchor === 'Y'));
  assert('[7.6] Z 未入 (repeat_loss 覆盖)', !rows.find(r => r.anchor === 'Z'));
}

// ---- [8] sortPatterns -------------------------------------------------------
{
  // 构造 4 行不同 priority 测稳定排序
  const seed: any[] = [
    { key: 'a', priority: 'low', sortKey: 999 },
    { key: 'b', priority: 'critical', sortKey: 50 },
    { key: 'c', priority: 'critical', sortKey: 100 },
    { key: 'd', priority: 'high', sortKey: 80 },
    { key: 'e', priority: 'critical', sortKey: 100 }, // tie sortKey, key e > c
  ];
  const sorted = sortPatterns(seed as any);
  const order = sorted.map(r => r.key).join(',');
  assert(
    '[8.1] 顺序: c(100,critical), e(100,critical), b(50,critical), d(80,high), a(999,low)',
    order === 'c,e,b,d,a',
    'got=' + order
  );
}

// ---- [9] countJournalsInWindow / aggregateJournalTags ----------------------
{
  const list: JournalSummary[] = [
    makeJournal('2026-06-19', AI_JOURNAL_MOOD, ['tech', 'momentum']),
    makeJournal('2026-06-18', AI_JOURNAL_MOOD, ['tech']),
    makeJournal('2026-06-15', AI_JOURNAL_MOOD, ['value']),
    makeJournal('2026-06-01', 'happy', ['tech', 'value']),
    makeJournal('2026-05-15', 'AI', null),
  ];
  assert('[9.1] last 7d 应含 06-19/06-18/06-15 (anchor=06-19)',
    countJournalsInWindow(list, RECENT_WINDOW_7D) === 3);
  assert('[9.2] last 30d 应含 4 条 (排除 05-15)',
    countJournalsInWindow(list, RECENT_WINDOW_30D) === 4);
  const tags = aggregateJournalTags(list);
  assert('[9.3] tech 出现 3 次最多', tags[0].tag === 'tech' && tags[0].count === 3);
  assert('[9.4] value 第二', tags[1].tag === 'value' && tags[1].count === 2);
  assert('[9.5] momentum 第三', tags[2].tag === 'momentum' && tags[2].count === 1);
}
{
  // 空 list
  assert('[9.6] 空 list count=0', countJournalsInWindow([], 7) === 0);
  assert('[9.7] 空 list tags=[]', aggregateJournalTags([]).length === 0);
  // 显式 anchorDate
  const list: JournalSummary[] = [makeJournal('2026-01-01')];
  assert(
    '[9.8] anchorDate=2026-01-15 windowDays=20 应含 01-01',
    countJournalsInWindow(list, 20, '2026-01-15') === 1
  );
  assert(
    '[9.9] anchorDate=2026-01-20 windowDays=5 应=0',
    countJournalsInWindow(list, 5, '2026-01-20') === 0
  );
}

// ---- [10] buildJournalAiSummary ---------------------------------------------
{
  const list: JournalSummary[] = [
    makeJournal('2026-06-19', AI_JOURNAL_MOOD, ['tech']),
    makeJournal('2026-06-18', AI_JOURNAL_MOOD, ['tech', 'value']),
    makeJournal('2026-06-17', 'happy', ['value']),
    makeJournal('2026-06-16', null, []),
    makeJournal('2026-06-15', '', ['value']),
  ];
  const sum = buildJournalAiSummary(list);
  assert('[10.1] hidden=false', sum.hidden === false);
  assert('[10.2] totalCount=5', sum.totalCount === 5);
  assert('[10.3] aiCount=2', sum.aiCount === 2);
  assert('[10.4] handCount=1 (happy)', sum.handCount === 1);
  assert('[10.5] unlabeledCount=2 (null + 空串)', sum.unlabeledCount === 2);
  assert('[10.6] aiCoverageRatio=0.4', approxEqual(sum.aiCoverageRatio, 0.4));
  assert(
    '[10.7] topTags value 第一 (3 次), tech 第二 (2 次)',
    sum.topTags[0].tag === 'value' &&
      sum.topTags[0].count === 3 &&
      sum.topTags[1].tag === 'tech' &&
      sum.topTags[1].count === 2
  );
}
{
  const sum = buildJournalAiSummary([]);
  assert('[10.8] 空 list → hidden=true', sum.hidden === true);
  const sum2 = buildJournalAiSummary(null);
  assert('[10.9] null → hidden=true', sum2.hidden === true);
}

// ---- [11] buildErrorPatternsViewModel AC 主验收 ----------------------------
{
  const trades: TradeRow[] = [
    // repeat_loss A 4 次 → critical
    makeTrade({ id: 1, symbol: 'A', name: 'A股', realized_pnl: -300 }),
    makeTrade({ id: 2, symbol: 'A', name: 'A股', realized_pnl: -400 }),
    makeTrade({ id: 3, symbol: 'A', name: 'A股', realized_pnl: -500 }),
    makeTrade({
      id: 4,
      symbol: 'A',
      name: 'A股',
      realized_pnl: -1600, // 单笔 16% → large_loss critical
      execute_price: 100,
      quantity: 100,
      amount: 10000,
      created_at: '2026-06-19 10:00:00',
    }),
    // same_day_streak 06-18 3 笔
    makeTrade({ id: 5, symbol: 'B', realized_pnl: -100, created_at: '2026-06-18 09:00:00' }),
    makeTrade({ id: 6, symbol: 'C', realized_pnl: -100, created_at: '2026-06-18 11:00:00' }),
    makeTrade({ id: 7, symbol: 'D', realized_pnl: -100, created_at: '2026-06-18 14:00:00' }),
    // chronic_loss X 单笔 800
    makeTrade({ id: 8, symbol: 'X', name: 'X股', realized_pnl: -800 }),
    // 盈利
    makeTrade({ id: 9, symbol: 'Z', realized_pnl: 500 }),
  ];
  const journals: JournalSummary[] = [
    makeJournal('2026-06-19', AI_JOURNAL_MOOD, ['post-mortem']),
    makeJournal('2026-06-18', AI_JOURNAL_MOOD, ['post-mortem']),
  ];
  const vm = buildErrorPatternsViewModel(trades, journals);
  assert('[11.1] hidden=false', vm.hidden === false);
  // 主 KPI
  assert('[11.2] sellTradeCount=9', vm.sellTradeCount === 9);
  assert('[11.3] lossTradeCount=8', vm.lossTradeCount === 8);
  assert(
    '[11.4] totalRealizedLoss=300+400+500+1600+100*3+800 = 3900',
    approxEqual(vm.totalRealizedLoss, 3900)
  );
  assert('[11.5] lossRate=8/9', approxEqual(vm.lossRate, 8 / 9));
  // patterns
  const kinds = vm.patterns.map(p => p.kind);
  assert('[11.6] 4 类 pattern 都出现', kinds.includes('repeat_loss') &&
    kinds.includes('large_loss') && kinds.includes('same_day_streak') &&
    kinds.includes('chronic_loss'));
  // priority 顺序: critical 在前
  const firstPri = vm.patterns[0].priority;
  assert('[11.7] 排序后第一条 critical', firstPri === 'critical');
  // chronic_loss (low) 在最后
  const lastPri = vm.patterns[vm.patterns.length - 1].priority;
  assert('[11.8] 排序后最后一条 low', lastPri === 'low');
  // journal summary
  assert('[11.9] journalSummary.aiCount=2', vm.journalSummary.aiCount === 2);
  assert('[11.10] journalSummary.totalCount=2', vm.journalSummary.totalCount === 2);
}

// ---- [12] view model 边界 --------------------------------------------------
{
  const vm = buildErrorPatternsViewModel(null, null);
  assert('[12.1] null/null → hidden=true', vm.hidden === true);
  assert('[12.2] patterns=[]', vm.patterns.length === 0);
}
{
  const vm = buildErrorPatternsViewModel(undefined, undefined);
  assert('[12.3] undefined → hidden=true', vm.hidden === true);
}
{
  // 全盈利 → patterns=[] 但 sellTradeCount > 0 → 不隐藏 (显示 KPI 0% 亏损率)
  const trades: TradeRow[] = [
    makeTrade({ id: 1, realized_pnl: 500 }),
    makeTrade({ id: 2, realized_pnl: 200 }),
  ];
  const vm = buildErrorPatternsViewModel(trades, []);
  assert('[12.4] 全盈利 patterns=[]', vm.patterns.length === 0);
  assert('[12.5] 全盈利 sellTradeCount=2', vm.sellTradeCount === 2);
  assert('[12.6] 全盈利 lossRate=0', vm.lossRate === 0);
  assert('[12.7] 全盈利 hidden=false (有 SELL 数据)', vm.hidden === false);
}
{
  // 仅 BUY → 真完全无数据 → hidden=true
  const trades: TradeRow[] = [
    makeTrade({ id: 1, direction: 'BUY', realized_pnl: null }),
  ];
  const vm = buildErrorPatternsViewModel(trades, []);
  assert('[12.8] 仅 BUY sellTradeCount=0', vm.sellTradeCount === 0);
  assert('[12.9] 仅 BUY hidden=true', vm.hidden === true);
}

// ---- [12.fmt] formatMoney / formatRatioPct ----------------------------------
assert('[12.10] formatMoney(0)=0', formatMoney(0) === '0');
assert('[12.11] formatMoney(1234.5) 含小数', formatMoney(1234.5).includes('1,234.5'));
assert('[12.12] formatMoney(12345) 无小数', formatMoney(12345) === '12,345');
assert('[12.13] formatRatioPct(0.1234)=12.34%', formatRatioPct(0.1234) === '12.34%');
assert('[12.14] formatRatioPct(NaN)=—', formatRatioPct(Number.NaN) === '—');

// ---- [13] META-GUARD fs+regex -----------------------------------------------
{
  const workspacePath = join(
    __dirname,
    '../../../frontend/src/pages/workspace/PortfolioWorkspace.tsx'
  );
  const src = readFileSync(workspacePath, 'utf8');
  assert(
    '[13.1] PortfolioWorkspace.tsx import buildErrorPatternsViewModel',
    /import\s*\{[^}]*buildErrorPatternsViewModel[^}]*\}\s*from\s*['"]\.\/errorPatternsHelpers['"]/.test(
      src
    )
  );
  assert(
    '[13.2] tabs 含 error-patterns key + AI 日记 + 错误模式 label',
    /key:\s*['"]error-patterns['"][^}]*label:\s*['"]AI\s*日记\s*\+\s*错误模式['"]/.test(src)
  );
  assert(
    '[13.3] PortfolioWorkspace.tsx 渲染 <ErrorPatternsTab',
    /<ErrorPatternsTab\s/.test(src)
  );
  assert(
    '[13.4] ErrorPatternsTab 组件定义在原文件',
    /const ErrorPatternsTab[:\s]/.test(src)
  );
}
{
  const helperPath = join(
    __dirname,
    '../../../frontend/src/pages/workspace/errorPatternsHelpers.ts'
  );
  const src = readFileSync(helperPath, 'utf8');
  assert(
    '[13.5] helper export buildErrorPatternsViewModel',
    /export\s+function\s+buildErrorPatternsViewModel/.test(src)
  );
  assert(
    '[13.6] helper export buildJournalAiSummary',
    /export\s+function\s+buildJournalAiSummary/.test(src)
  );
  assert(
    '[13.7] helper export computeRepeatLossPriority',
    /export\s+function\s+computeRepeatLossPriority/.test(src)
  );
  assert(
    '[13.8] helper export REPEAT_LOSS_MIN_COUNT',
    /export\s+const\s+REPEAT_LOSS_MIN_COUNT/.test(src)
  );
  assert(
    '[13.9] helper export ERROR_PATTERN_PRIORITY_COLOR',
    /export\s+const\s+ERROR_PATTERN_PRIORITY_COLOR/.test(src)
  );
  assert(
    '[13.10] helper export PATTERN_TOP_LIMIT=5',
    /export\s+const\s+PATTERN_TOP_LIMIT\s*=\s*5/.test(src)
  );
}

// ---- summary ----------------------------------------------------------------
console.log(`\nerror-patterns-helpers: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
