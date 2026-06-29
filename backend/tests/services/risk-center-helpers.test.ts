/**
 * PR-C 风控中心 v2 — riskCenterHelpers 跨 monorepo pure-helper 单测.
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/risk-center-helpers.test.ts
 *
 * 套 [[alerts-panel-helpers.test.ts]] / [[alerts-bell-helpers.test.ts]] 同款 fs+regex
 * META-GUARD 范式: pure helper 全单测, 守 TodayWorkspace.tsx import 路径正确,
 * 守 RuleId 覆盖率 >= 17, 守 4 view options 完整, 守新加 rule_id 不会无声丢失映射.
 *
 * 覆盖维度:
 *  [1] RULE_ID_META 覆盖 (>= 17 rule_id, 4 类齐, frozen) + 关键 rule_id 存在
 *  [2] getRuleIdMeta: 正常 / 兜底 / 未知 / null/undefined / trim
 *  [3] ALERT_VIEW_OPTIONS: 4 项 / 顺序 / value=critical 第一
 *  [4] filterAlertsByView: critical / positions / data / all
 *  [5] aggregateAlertsByRuleAndSymbol: 同 day 同 rule 同 sym 折叠 / 跨 day 不折 / 缺字段
 *  [6] computeRiskCenterHeroStats: 计数 / dataHealth / highRatio / 空数组
 *  [7] countUnreadHighAlerts: 仅 unread HIGH 计入
 *  [8] META-GUARD fs+regex 守
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ALERT_VIEW_OPTIONS,
  FALLBACK_RULE_META,
  RULE_ID_META,
  RULE_ID_META_COVERAGE_COUNT,
  aggregateAlertsByRuleAndSymbol,
  computeRiskCenterHeroStats,
  countUnreadHighAlerts,
  filterAlertsByView,
  getRuleIdMeta,
  type AlertView,
} from '../../../frontend/src/pages/workspace/riskCenterHelpers';
import type { RiskAlertItem } from '../../../frontend/src/services/riskAlertService';

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

// 工厂: 让 alert fixture 精简
function mkAlert(overrides: Partial<RiskAlertItem> = {}): RiskAlertItem {
  return {
    id: 1,
    user_id: 1,
    symbol: '600000',
    name: '浦发银行',
    level: 'MEDIUM',
    message: 'test',
    rule_id: null,
    is_read: false,
    created_at: '2026-06-29T08:00:00.000Z',
    updated_at: '2026-06-29T08:00:00.000Z',
    category: 'individual',
    ...overrides,
  } as RiskAlertItem;
}

// ============================================================
// [1] RULE_ID_META 覆盖 + 冻结
// ============================================================
assert('[1.1] RULE_ID_META_COVERAGE_COUNT >= 17', RULE_ID_META_COVERAGE_COUNT >= 17);
assert('[1.2] FALLBACK_RULE_META 有 label', typeof FALLBACK_RULE_META.label === 'string');
assert('[1.3] RULE_ID_META 含 per_stock_stop_loss', Boolean(RULE_ID_META.per_stock_stop_loss));
assert('[1.4] RULE_ID_META 含 wizard_compliance', Boolean(RULE_ID_META.wizard_compliance));
assert('[1.5] RULE_ID_META 含 black_swan', Boolean(RULE_ID_META.black_swan));
assert('[1.6] RULE_ID_META 含 stock_bullish_event', Boolean(RULE_ID_META.stock_bullish_event));
assert('[1.7] RULE_ID_META 含 data_freshness', Boolean(RULE_ID_META.data_freshness));
assert('[1.8] RULE_ID_META 含 drawdown_breaker', Boolean(RULE_ID_META.drawdown_breaker));
assert(
  '[1.9] per_stock_stop_loss.category = risk',
  RULE_ID_META.per_stock_stop_loss.category === 'risk'
);
assert(
  '[1.10] wizard_compliance.category = compliance',
  RULE_ID_META.wizard_compliance.category === 'compliance'
);
assert(
  '[1.11] data_freshness.category = data',
  RULE_ID_META.data_freshness.category === 'data'
);
assert(
  '[1.12] stock_bullish_event.category = opportunity',
  RULE_ID_META.stock_bullish_event.category === 'opportunity'
);

// 4 类齐
const allCats = new Set(Object.values(RULE_ID_META).map(m => m.category));
assert('[1.13] 4 categories 齐 (risk/data/compliance/opportunity)', allCats.size === 4);

// frozen
try {
  (RULE_ID_META as Record<string, unknown>).__hack__ = {};
  assert('[1.14] RULE_ID_META frozen', false, '修改成功了不应');
} catch {
  assert('[1.14] RULE_ID_META frozen', true);
}

// ============================================================
// [2] getRuleIdMeta 取数
// ============================================================
const stopLoss = getRuleIdMeta('per_stock_stop_loss');
assert('[2.1] per_stock_stop_loss → 个股止损', stopLoss.label === '个股止损');
assert('[2.2] per_stock_stop_loss icon 非空', stopLoss.icon.length > 0);
assert('[2.3] null → fallback label', getRuleIdMeta(null).label === FALLBACK_RULE_META.label);
assert(
  '[2.4] undefined → fallback label',
  getRuleIdMeta(undefined).label === FALLBACK_RULE_META.label
);
assert('[2.5] 空串 → fallback', getRuleIdMeta('').label === FALLBACK_RULE_META.label);
assert(
  '[2.6] 未知 rule_id 返 fallback 但 label=raw',
  getRuleIdMeta('totally_unknown_rule').label === 'totally_unknown_rule'
);
assert(
  '[2.7] trim 前后空格',
  getRuleIdMeta('  per_stock_stop_loss  ').label === '个股止损'
);

// ============================================================
// [3] ALERT_VIEW_OPTIONS
// ============================================================
assert('[3.1] ALERT_VIEW_OPTIONS 4 项', ALERT_VIEW_OPTIONS.length === 4);
assert(
  '[3.2] 第一项是 critical',
  ALERT_VIEW_OPTIONS[0].value === 'critical' as AlertView
);
const optionValues = ALERT_VIEW_OPTIONS.map(o => o.value).sort();
assert(
  '[3.3] 4 个 value 齐',
  JSON.stringify(optionValues) === JSON.stringify(['all', 'critical', 'data', 'positions'])
);

// ============================================================
// [4] filterAlertsByView
// ============================================================
const fixtureAlerts: RiskAlertItem[] = [
  mkAlert({ id: 1, level: 'HIGH', rule_id: 'per_stock_stop_loss', symbol: '600019', category: 'position' }),
  mkAlert({ id: 2, level: 'MEDIUM', rule_id: 'wizard_compliance', symbol: '601318', category: 'individual' }),
  mkAlert({ id: 3, level: 'LOW', rule_id: 'stock_bullish_event', symbol: '600519', category: 'individual' }),
  mkAlert({ id: 4, level: 'MEDIUM', rule_id: 'data_freshness', symbol: 'SYSTEM:data_status', category: 'market' }),
  mkAlert({ id: 5, level: 'MEDIUM', rule_id: 'industry_concentration', symbol: '000001', category: 'position' }),
];

// critical: HIGH (id=1) + force list (stock_bullish_event id=3)
const critFiltered = filterAlertsByView(fixtureAlerts, 'critical');
const critIds = critFiltered.map(a => a.id).sort();
assert(
  '[4.1] critical view 含 HIGH 和 force list rule',
  JSON.stringify(critIds) === JSON.stringify([1, 3])
);

// positions: category=position OR symbol in posSet
const posFiltered = filterAlertsByView(fixtureAlerts, 'positions', ['601318']);
const posIds = posFiltered.map(a => a.id).sort();
assert(
  '[4.2] positions view 含 position cat + 用户持仓 symbol',
  JSON.stringify(posIds) === JSON.stringify([1, 2, 5])
);

// data: rule_id meta.category=data
const dataFiltered = filterAlertsByView(fixtureAlerts, 'data');
assert(
  '[4.3] data view 仅 data 类 rule_id',
  dataFiltered.length === 1 && dataFiltered[0].id === 4
);

// all: 全部
const allFiltered = filterAlertsByView(fixtureAlerts, 'all');
assert('[4.4] all view 不过滤', allFiltered.length === fixtureAlerts.length);

// 空数组兜底
assert('[4.5] null items → []', filterAlertsByView(null, 'critical').length === 0);
assert('[4.6] undefined items → []', filterAlertsByView(undefined, 'critical').length === 0);

// positionSymbols 缺省 → 仅 category=position
const posNoSymbols = filterAlertsByView(fixtureAlerts, 'positions');
assert(
  '[4.7] positions view 无 posSymbols 仍能按 category 过滤',
  posNoSymbols.every(a => a.category === 'position') && posNoSymbols.length === 2
);

// ============================================================
// [5] aggregateAlertsByRuleAndSymbol
// ============================================================
const dupAlerts: RiskAlertItem[] = [
  mkAlert({
    id: 11,
    rule_id: 'wizard_compliance',
    symbol: '600000',
    created_at: '2026-06-29T08:00:00.000Z',
  }),
  mkAlert({
    id: 12,
    rule_id: 'wizard_compliance',
    symbol: '600000',
    created_at: '2026-06-29T10:00:00.000Z',
  }),
  mkAlert({
    id: 13,
    rule_id: 'wizard_compliance',
    symbol: '600000',
    created_at: '2026-06-29T12:00:00.000Z',
  }),
  // 跨天 - 不应聚合
  mkAlert({
    id: 14,
    rule_id: 'wizard_compliance',
    symbol: '600000',
    created_at: '2026-06-28T12:00:00.000Z',
  }),
  // 不同 symbol - 不应聚合
  mkAlert({
    id: 15,
    rule_id: 'wizard_compliance',
    symbol: '600001',
    created_at: '2026-06-29T11:00:00.000Z',
  }),
];

const aggregated = aggregateAlertsByRuleAndSymbol(dupAlerts);
assert('[5.1] 5 条聚合成 3 组', aggregated.length === 3);

const bigGroup = aggregated.find(a => a.aggregated_count === 3);
assert('[5.2] 同 day/rule/symbol 3 条折叠', !!bigGroup);
assert('[5.3] 代表行用最新 (id=13, 12:00)', bigGroup?.id === 13);
assert(
  '[5.4] aggregated_alerts 全量挂上 + 时间降序',
  bigGroup?.aggregated_alerts.length === 3 &&
    bigGroup.aggregated_alerts[0].id === 13 &&
    bigGroup.aggregated_alerts[2].id === 11
);

const lonelyGroups = aggregated.filter(a => a.aggregated_count === 1);
assert('[5.5] 单条组 2 个', lonelyGroups.length === 2);
assert('[5.6] 单条组 aggregated_alerts.length === 1', lonelyGroups.every(g => g.aggregated_alerts.length === 1));

// 兜底: 空 / null
assert('[5.7] null → []', aggregateAlertsByRuleAndSymbol(null).length === 0);
assert('[5.8] [] → []', aggregateAlertsByRuleAndSymbol([]).length === 0);

// 兜底: 缺字段
const noFields = aggregateAlertsByRuleAndSymbol([
  mkAlert({ id: 21, rule_id: null, symbol: '' }),
  mkAlert({ id: 22, rule_id: null, symbol: '' }),
]);
assert('[5.9] rule_id+symbol 缺省的 alerts 也能聚合', noFields.length === 1 && noFields[0].aggregated_count === 2);

// ============================================================
// [6] computeRiskCenterHeroStats
// ============================================================
const now = new Date('2026-06-29T12:00:00.000Z');
const heroFixture: RiskAlertItem[] = [
  mkAlert({ id: 31, level: 'HIGH', created_at: '2026-06-29T08:00:00.000Z', rule_id: 'per_stock_stop_loss' }),
  mkAlert({ id: 32, level: 'MEDIUM', created_at: '2026-06-29T09:00:00.000Z', rule_id: 'wizard_compliance' }),
  mkAlert({ id: 33, level: 'MEDIUM', created_at: '2026-06-27T09:00:00.000Z', rule_id: 'data_freshness' }),
  mkAlert({ id: 34, level: 'LOW', created_at: '2026-06-20T09:00:00.000Z', rule_id: 'wizard_compliance' }), // > 7 天前
];

const stats = computeRiskCenterHeroStats(heroFixture, now);
assert('[6.1] newToday = 2 (今天 2 条)', stats.newToday === 2);
assert('[6.2] weekTotal = 3 (近 7 天 3 条)', stats.weekTotal === 3);
assert('[6.3] highRatio = 1/4', Math.abs(stats.highRatio - 0.25) < 1e-9);
assert('[6.4] dataHealth = degraded (有 data MEDIUM)', stats.dataHealth === 'degraded');
assert('[6.5] dataIssueCount = 1', stats.dataIssueCount === 1);

// 空兜底
const emptyStats = computeRiskCenterHeroStats(null, now);
assert('[6.6] null → all 0', emptyStats.newToday === 0 && emptyStats.weekTotal === 0);
assert('[6.7] null → healthy', emptyStats.dataHealth === 'healthy');

// ============================================================
// [7] countUnreadHighAlerts
// ============================================================
const mix = [
  mkAlert({ id: 41, level: 'HIGH', is_read: false }),
  mkAlert({ id: 42, level: 'HIGH', is_read: true }),
  mkAlert({ id: 43, level: 'MEDIUM', is_read: false }),
  mkAlert({ id: 44, level: 'CRITICAL', is_read: false }),
];
assert('[7.1] unread HIGH/CRITICAL = 2', countUnreadHighAlerts(mix) === 2);
assert('[7.2] null → 0', countUnreadHighAlerts(null) === 0);

// ============================================================
// [8] META-GUARD fs+regex
// ============================================================
const HELPER_PATH = join(
  __dirname,
  '../../../frontend/src/pages/workspace/riskCenterHelpers.ts'
);
const helperSrc = readFileSync(HELPER_PATH, 'utf-8');

const exportChecks = [
  'export const RULE_ID_META',
  'export const FALLBACK_RULE_META',
  'export function getRuleIdMeta',
  'export const ALERT_VIEW_OPTIONS',
  'export function filterAlertsByView',
  'export function aggregateAlertsByRuleAndSymbol',
  'export function computeRiskCenterHeroStats',
  'export function countUnreadHighAlerts',
];
for (const [i, check] of exportChecks.entries()) {
  assert(`[8.${i + 1}] helper exports ${check}`, helperSrc.includes(check));
}

const WORKSPACE_PATH = join(
  __dirname,
  '../../../frontend/src/pages/workspace/TodayWorkspace.tsx'
);
const wsSrc = readFileSync(WORKSPACE_PATH, 'utf-8');
assert(
  '[8.A] TodayWorkspace 引 ./RiskAlertCenterPanel',
  wsSrc.includes("from './RiskAlertCenterPanel'")
);
assert(
  '[8.B] TodayWorkspace 渲染 <RiskAlertCenterPanel',
  wsSrc.includes('<RiskAlertCenterPanel ')
);

// Panel 文件自己 META-GUARD
const PANEL_PATH = join(
  __dirname,
  '../../../frontend/src/pages/workspace/RiskAlertCenterPanel.tsx'
);
const panelSrc = readFileSync(PANEL_PATH, 'utf-8');
assert(
  '[8.C] Panel 引 ./riskCenterHelpers',
  panelSrc.includes("from './riskCenterHelpers'")
);
assert(
  '[8.D] Panel 调 filterAlertsByView',
  panelSrc.includes('filterAlertsByView(')
);
assert(
  '[8.E] Panel 调 aggregateAlertsByRuleAndSymbol',
  panelSrc.includes('aggregateAlertsByRuleAndSymbol(')
);
assert(
  '[8.F] Panel 用 Segmented 智能视图',
  panelSrc.includes('Segmented')
);
assert(
  '[8.G] Panel 调 getRuleIdMeta',
  panelSrc.includes('getRuleIdMeta(')
);
assert(
  '[8.H] Panel 调 countUnreadHighAlerts',
  panelSrc.includes('countUnreadHighAlerts(')
);

// PortfolioWorkspace 我的提醒 tab — 也复用 panel
const PORTFOLIO_PATH = join(
  __dirname,
  '../../../frontend/src/pages/workspace/PortfolioWorkspace.tsx'
);
const portfolioSrc = readFileSync(PORTFOLIO_PATH, 'utf-8');
assert(
  '[8.I] PortfolioWorkspace 引 ./RiskAlertCenterPanel',
  portfolioSrc.includes("from './RiskAlertCenterPanel'")
);
assert(
  '[8.J] PortfolioWorkspace 含 alerts tab key',
  /key:\s*['"]alerts['"]/.test(portfolioSrc)
);

// ============================================================
// 汇总
// ============================================================
console.log(`\n[risk-center-helpers] passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
