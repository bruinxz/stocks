/**
 * US-071 [FE-032] AlertsPanel filter + search + 分类 — pure helper 单元测试.
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/alerts-panel-helpers.test.ts
 * 或:
 *   cd backend && npm test -- --filter=alerts-panel
 *
 * 跨 monorepo import (../../../frontend) — 与 [[alerts-bell-helpers.test.ts]]
 * (US-070) / strategyKillSwitchHelpers / shadowRunHelpers / overfit-metrics
 * 同款"前端 pure helper 跨 monorepo 单测" 范式.
 *
 * 覆盖维度:
 *   [1] 常量 sanity (LEVEL_RANK 高于中高于低 / category 4 类齐全 / 关键词冻结)
 *   [2] normalizeAlertLevel: 大小写 / 兜底 / 空串
 *   [3] deriveAlertCategoryFromMessage: 前缀 / DATA / POSITION / MARKET / fallback / 优先级
 *   [4] enrichAlerts: 兜底 / null 跳过 / 缺字段
 *   [5] filterAlerts: level / category / search / 联合 / cap / 空过滤返全集
 *   [6] sortAlertsBySeverityThenTime: level desc / time desc / id 兜底稳定
 *   [7] summarizeAlertsByCategory: 永远 4 类 / level 分桶 / 顺序固定
 *   [8] summarizeAlertsByLevel: 永远 3 档 / 顺序固定
 *   [9] emptyAlertsPanelFilterState / hasActiveFilter: 空 / level / category / search
 *  [10] META-GUARD fs+regex 守 alertsPanelHelpers.ts 所有 export
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DATA_KEYWORDS,
  DERIVED_CATEGORY_LABEL,
  DERIVED_CATEGORY_TAG_COLOR,
  LEVEL_LABEL,
  LEVEL_RANK,
  MARKET_KEYWORDS,
  MAX_SEARCH_RESULTS,
  MIN_SEARCH_QUERY_LENGTH,
  POSITION_KEYWORDS,
  SYMBOL_PREFIX_CATEGORY,
  type AlertsPanelFilterState,
  type EnrichedAlert,
  deriveAlertCategoryFromMessage,
  emptyAlertsPanelFilterState,
  enrichAlerts,
  filterAlerts,
  hasActiveFilter,
  normalizeAlertLevel,
  sortAlertsBySeverityThenTime,
  summarizeAlertsByCategory,
  summarizeAlertsByLevel,
} from '../../../frontend/src/pages/workspace/alertsPanelHelpers';

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

// ============================================================
// [1] 常量 sanity
// ============================================================
assert('[1.1] LEVEL_RANK HIGH > MEDIUM', LEVEL_RANK.HIGH > LEVEL_RANK.MEDIUM);
assert('[1.2] LEVEL_RANK MEDIUM > LOW', LEVEL_RANK.MEDIUM > LEVEL_RANK.LOW);
assert('[1.3] LEVEL_RANK LOW > 0', LEVEL_RANK.LOW > 0);
assert('[1.4] LEVEL_LABEL 3 项', Object.keys(LEVEL_LABEL).length === 3);
assert(
  '[1.5] DERIVED_CATEGORY_LABEL 4 类',
  Object.keys(DERIVED_CATEGORY_LABEL).length === 4
);
assert(
  '[1.6] DERIVED_CATEGORY_TAG_COLOR 4 类齐',
  Object.keys(DERIVED_CATEGORY_TAG_COLOR).length === 4
);
assert(
  '[1.7] DERIVED_CATEGORY_LABEL.position 中文 = 持仓',
  DERIVED_CATEGORY_LABEL.position === '持仓'
);
assert('[1.8] DERIVED_CATEGORY_LABEL.data 中文 = 数据', DERIVED_CATEGORY_LABEL.data === '数据');
assert('[1.9] MIN_SEARCH_QUERY_LENGTH >= 1', MIN_SEARCH_QUERY_LENGTH >= 1);
assert('[1.10] MAX_SEARCH_RESULTS >= 20', MAX_SEARCH_RESULTS >= 20);

// 关键词冻结
try {
  (POSITION_KEYWORDS as unknown as string[]).push('zzz');
  assert('[1.11] POSITION_KEYWORDS frozen', false, '修改不应成功');
} catch {
  assert('[1.11] POSITION_KEYWORDS frozen', true);
}
try {
  (MARKET_KEYWORDS as unknown as string[]).push('zzz');
  assert('[1.12] MARKET_KEYWORDS frozen', false);
} catch {
  assert('[1.12] MARKET_KEYWORDS frozen', true);
}
try {
  (DATA_KEYWORDS as unknown as string[]).push('zzz');
  assert('[1.13] DATA_KEYWORDS frozen', false);
} catch {
  assert('[1.13] DATA_KEYWORDS frozen', true);
}

// 关键词字典关键条目
assert('[1.14] POSITION_KEYWORDS 含 止损', POSITION_KEYWORDS.includes('止损'));
assert('[1.15] MARKET_KEYWORDS 含 黑天鹅', MARKET_KEYWORDS.includes('黑天鹅'));
assert('[1.16] DATA_KEYWORDS 含 数据缺失', DATA_KEYWORDS.includes('数据缺失'));

// SYMBOL_PREFIX_CATEGORY 映射
assert(
  '[1.17] SYMBOL_PREFIX_CATEGORY[SYSTEM:] = market',
  SYMBOL_PREFIX_CATEGORY['SYSTEM:'] === 'market'
);
assert(
  '[1.18] SYMBOL_PREFIX_CATEGORY[DATA:] = data',
  SYMBOL_PREFIX_CATEGORY['DATA:'] === 'data'
);

// ============================================================
// [2] normalizeAlertLevel
// ============================================================
assert('[2.1] HIGH → HIGH', normalizeAlertLevel('HIGH') === 'HIGH');
assert('[2.2] high → HIGH (大小写无关)', normalizeAlertLevel('high') === 'HIGH');
assert('[2.3] " medium " → MEDIUM (trim)', normalizeAlertLevel(' medium ') === 'MEDIUM');
assert('[2.4] low → LOW', normalizeAlertLevel('low') === 'LOW');
assert('[2.5] 空串 → LOW (safe-default)', normalizeAlertLevel('') === 'LOW');
assert('[2.6] 未知值 → LOW', normalizeAlertLevel('CRITICAL') === 'LOW');
assert('[2.7] null → LOW', normalizeAlertLevel(null) === 'LOW');
assert('[2.8] undefined → LOW', normalizeAlertLevel(undefined) === 'LOW');
assert('[2.9] 数字 5 → LOW (非 string)', normalizeAlertLevel(5) === 'LOW');

// ============================================================
// [3] deriveAlertCategoryFromMessage
// ============================================================
// (1) 前缀映射 (优先级最高)
assert(
  '[3.1] SYSTEM:INDEX → market',
  deriveAlertCategoryFromMessage('SYSTEM:INDEX', '止损被触发') === 'market'
);
assert(
  '[3.2] DATA:RT_QUOTE → data (前缀压过 message 关键词)',
  deriveAlertCategoryFromMessage('DATA:RT_QUOTE', '止损被触发') === 'data'
);

// (2) DATA 优先于 POSITION
assert(
  '[3.3] message 含数据缺失 → data',
  deriveAlertCategoryFromMessage('600519', '行业资金流入数据缺失') === 'data'
);

// (3) POSITION
assert(
  '[3.4] message 含止损 → position',
  deriveAlertCategoryFromMessage('600519', '已触发止损线 -10%') === 'position'
);
assert(
  '[3.5] message 含行业集中 → position',
  deriveAlertCategoryFromMessage('600519', '行业集中度超限') === 'position'
);
assert(
  '[3.6] message 含跟踪止损 → position',
  deriveAlertCategoryFromMessage('600519', '跟踪止损触发') === 'position'
);

// (4) MARKET
assert(
  '[3.7] message 含黑天鹅 → market',
  deriveAlertCategoryFromMessage('601318', '北向资金净流出大于黑天鹅阈值') === 'market'
);
assert(
  '[3.8] message 含大盘 → market',
  deriveAlertCategoryFromMessage('601318', '大盘急跌 -3%') === 'market'
);

// (5) fallback individual
assert(
  '[3.9] message 无关键词 → individual',
  deriveAlertCategoryFromMessage('600519', '股价大幅波动') === 'individual'
);
assert(
  '[3.10] message 空 → individual',
  deriveAlertCategoryFromMessage('600519', '') === 'individual'
);
assert(
  '[3.11] null symbol + null message → individual',
  deriveAlertCategoryFromMessage(null, null) === 'individual'
);

// 优先级 sanity — 已知 message 含多关键词时, data 优先
assert(
  '[3.12] data 关键词优先于 position (message 含数据缺失 + 止损)',
  deriveAlertCategoryFromMessage('600519', '数据缺失导致止损未触发') === 'data'
);

// ============================================================
// [4] enrichAlerts
// ============================================================
{
  const items = [
    {
      id: 1,
      symbol: '600519',
      name: '贵州茅台',
      level: 'high',
      message: '已触发止损线',
      created_at: '2026-06-20T09:30:00Z',
    },
    null,
    undefined,
    {
      id: 2,
      symbol: 'SYSTEM:INDEX',
      name: '',
      level: 'medium',
      message: '大盘急跌',
      created_at: '2026-06-20T10:00:00Z',
    },
  ];
  const out = enrichAlerts(items as any);
  assert('[4.1] enrichAlerts 跳过 null/undefined', out.length === 2);
  assert('[4.2] enrichAlerts 派生 derived_level HIGH', out[0].derived_level === 'HIGH');
  assert(
    '[4.3] enrichAlerts 派生 derived_category position (止损)',
    out[0].derived_category === 'position'
  );
  assert(
    '[4.4] enrichAlerts 第 2 条 derived_category market (SYSTEM:)',
    out[1].derived_category === 'market'
  );
  assert('[4.5] enrichAlerts 原字段透传', out[0].symbol === '600519' && out[0].id === 1);
  assert('[4.6] enrichAlerts null 输入 → []', enrichAlerts(null).length === 0);
  assert('[4.7] enrichAlerts 非数组 → []', enrichAlerts({} as any).length === 0);
  // 缺字段
  const enrichedFromBare = enrichAlerts([{ id: 99 } as any]);
  assert(
    '[4.8] enrichAlerts 缺字段不报错',
    enrichedFromBare.length === 1 && enrichedFromBare[0].derived_level === 'LOW'
  );
}

// ============================================================
// [5] filterAlerts
// ============================================================
function makeSample(): EnrichedAlert[] {
  return enrichAlerts([
    {
      id: 1,
      symbol: '600519',
      name: '贵州茅台',
      level: 'HIGH',
      message: '止损 -10%',
      created_at: '2026-06-20T09:30:00Z',
    },
    {
      id: 2,
      symbol: '601318',
      name: '中国平安',
      level: 'MEDIUM',
      message: '北向资金流出',
      created_at: '2026-06-20T10:00:00Z',
    },
    {
      id: 3,
      symbol: 'DATA:RT_QUOTE',
      name: '行情数据',
      level: 'LOW',
      message: '数据滞后 5min',
      created_at: '2026-06-20T10:30:00Z',
    },
    {
      id: 4,
      symbol: '000001',
      name: '平安银行',
      level: 'LOW',
      message: '盘中振幅扩大',
      created_at: '2026-06-20T11:00:00Z',
    },
  ] as any);
}

{
  const sample = makeSample();
  assert('[5.1] 空 filter → 全集', filterAlerts(sample, {}).length === sample.length);
  assert(
    '[5.2] level=HIGH → 仅 1 条',
    filterAlerts(sample, { level: 'HIGH' }).length === 1
  );
  assert(
    '[5.3] category=market → 1 条 (中国平安 北向)',
    filterAlerts(sample, { category: 'market' }).length === 1
  );
  assert(
    '[5.4] category=data → 1 条 (DATA:RT_QUOTE)',
    filterAlerts(sample, { category: 'data' }).length === 1
  );
  assert(
    '[5.5] search 茅台 → 1 条 (名称匹配)',
    filterAlerts(sample, { search: '茅台' }).length === 1
  );
  assert(
    '[5.6] search 600519 → 1 条 (symbol 匹配)',
    filterAlerts(sample, { search: '600519' }).length === 1
  );
  assert(
    '[5.7] search 止损 → 1 条 (message 匹配)',
    filterAlerts(sample, { search: '止损' }).length === 1
  );
  assert(
    '[5.8] search 大小写无关 (英文)',
    filterAlerts(sample, { search: 'data:rt_quote' }).length === 1
  );
  assert(
    '[5.9] search 空白串 → 不过滤',
    filterAlerts(sample, { search: '   ' }).length === sample.length
  );
  assert(
    '[5.10] level+category 联合 (HIGH+position)',
    filterAlerts(sample, { level: 'HIGH', category: 'position' }).length === 1
  );
  assert(
    '[5.11] level+category 联合 (HIGH+market) → 0',
    filterAlerts(sample, { level: 'HIGH', category: 'market' }).length === 0
  );
  assert('[5.12] null filter → 全集', filterAlerts(sample, null).length === sample.length);
  assert('[5.13] null items → []', filterAlerts(null, {}).length === 0);
}

// cap MAX_SEARCH_RESULTS
{
  // 构造一个超大数组验证 cap
  const big: EnrichedAlert[] = [];
  for (let i = 0; i < MAX_SEARCH_RESULTS + 10; i++) {
    big.push({
      id: i,
      symbol: 'S' + i,
      name: 'N' + i,
      level: 'LOW',
      message: '波动',
      created_at: '2026-06-20T09:30:00Z',
      derived_level: 'LOW',
      derived_category: 'individual',
    });
  }
  const r = filterAlerts(big, {});
  assert('[5.14] filterAlerts cap 在 MAX_SEARCH_RESULTS', r.length === MAX_SEARCH_RESULTS);
}

// ============================================================
// [6] sortAlertsBySeverityThenTime
// ============================================================
{
  const sample = makeSample();
  const sorted = sortAlertsBySeverityThenTime(sample);
  assert('[6.1] 排序后 HIGH 在最前', sorted[0].derived_level === 'HIGH');
  // 后面 MEDIUM, 然后 2 个 LOW
  assert('[6.2] 第 2 位 MEDIUM', sorted[1].derived_level === 'MEDIUM');
  // 2 个 LOW 按 time desc — 11:00 在 10:30 前
  assert('[6.3] LOW 内时间 desc (11:00 前于 10:30)', sorted[2].id === 4 && sorted[3].id === 3);
  assert('[6.4] null → []', sortAlertsBySeverityThenTime(null).length === 0);
}

// id tie-breaker (相同 level + 相同时间)
{
  const tied: EnrichedAlert[] = [
    {
      id: 5,
      symbol: 'A',
      name: 'A',
      level: 'LOW',
      message: 'm',
      created_at: '2026-06-20T09:30:00Z',
      derived_level: 'LOW',
      derived_category: 'individual',
    },
    {
      id: 3,
      symbol: 'B',
      name: 'B',
      level: 'LOW',
      message: 'm',
      created_at: '2026-06-20T09:30:00Z',
      derived_level: 'LOW',
      derived_category: 'individual',
    },
  ];
  const sorted = sortAlertsBySeverityThenTime(tied);
  assert('[6.5] 同 level 同时间按 id asc 兜底稳定', sorted[0].id === 3 && sorted[1].id === 5);
}

// ============================================================
// [7] summarizeAlertsByCategory
// ============================================================
{
  const sample = makeSample();
  const summary = summarizeAlertsByCategory(sample);
  assert('[7.1] 永远返 4 类', summary.length === 4);
  // 顺序固定
  assert('[7.2] 顺序 position', summary[0].category === 'position');
  assert('[7.3] 顺序 market', summary[1].category === 'market');
  assert('[7.4] 顺序 individual', summary[2].category === 'individual');
  assert('[7.5] 顺序 data', summary[3].category === 'data');
  // position: 1 HIGH (600519 止损)
  assert(
    '[7.6] position total=1 high=1',
    summary[0].total === 1 && summary[0].high === 1 && summary[0].medium === 0
  );
  // market: 1 MEDIUM (北向)
  assert(
    '[7.7] market total=1 medium=1',
    summary[1].total === 1 && summary[1].medium === 1
  );
  // individual: 1 LOW (000001 振幅)
  assert(
    '[7.8] individual total=1 low=1',
    summary[2].total === 1 && summary[2].low === 1
  );
  // data: 1 LOW
  assert('[7.9] data total=1 low=1', summary[3].total === 1 && summary[3].low === 1);

  // 空输入: 仍返 4 类全 0
  const empty = summarizeAlertsByCategory([]);
  assert('[7.10] 空集仍返 4 类', empty.length === 4);
  assert('[7.11] 空集 total 全 0', empty.every(c => c.total === 0));
  // null
  assert('[7.12] null 返 4 类', summarizeAlertsByCategory(null).length === 4);
}

// ============================================================
// [8] summarizeAlertsByLevel
// ============================================================
{
  const sample = makeSample();
  const summary = summarizeAlertsByLevel(sample);
  assert('[8.1] 永远返 3 档', summary.length === 3);
  assert('[8.2] 顺序 HIGH', summary[0].level === 'HIGH');
  assert('[8.3] 顺序 MEDIUM', summary[1].level === 'MEDIUM');
  assert('[8.4] 顺序 LOW', summary[2].level === 'LOW');
  assert(
    '[8.5] count HIGH=1, MEDIUM=1, LOW=2',
    summary[0].count === 1 && summary[1].count === 1 && summary[2].count === 2
  );
  assert('[8.6] 空集 → 全 0', summarizeAlertsByLevel([]).every(s => s.count === 0));
  assert('[8.7] null → 仍返 3 档', summarizeAlertsByLevel(null).length === 3);
}

// ============================================================
// [9] emptyAlertsPanelFilterState / hasActiveFilter
// ============================================================
{
  const e = emptyAlertsPanelFilterState();
  assert('[9.1] empty 无 level', !e.level);
  assert('[9.2] empty 无 category', !e.category);
  assert('[9.3] empty search 空串', e.search === '');
  assert('[9.4] hasActiveFilter(empty) = false', hasActiveFilter(e) === false);

  assert(
    '[9.5] hasActiveFilter level=HIGH = true',
    hasActiveFilter({ level: 'HIGH' } as AlertsPanelFilterState) === true
  );
  assert(
    '[9.6] hasActiveFilter category=data = true',
    hasActiveFilter({ category: 'data' } as AlertsPanelFilterState) === true
  );
  assert(
    '[9.7] hasActiveFilter search=茅台 = true',
    hasActiveFilter({ search: '茅台' } as AlertsPanelFilterState) === true
  );
  assert(
    '[9.8] hasActiveFilter search=空白 = false',
    hasActiveFilter({ search: '   ' } as AlertsPanelFilterState) === false
  );
  assert('[9.9] hasActiveFilter null = false', hasActiveFilter(null) === false);
}

// ============================================================
// [10] META-GUARD fs+regex — 守 helper / UI / wiring 全同步
// ============================================================
const FRONTEND_ROOT = join(__dirname, '..', '..', '..', 'frontend', 'src');

function readFile(rel: string): string {
  return readFileSync(join(FRONTEND_ROOT, rel), 'utf8');
}

// 10.1 — helper 所有 export 齐全
{
  const helperSrc = readFile('pages/workspace/alertsPanelHelpers.ts');
  for (const name of [
    'export const MAX_SEARCH_RESULTS',
    'export const MIN_SEARCH_QUERY_LENGTH',
    'export const LEVEL_RANK',
    'export const LEVEL_LABEL',
    'export const DERIVED_CATEGORY_LABEL',
    'export const DERIVED_CATEGORY_TAG_COLOR',
    'export const POSITION_KEYWORDS',
    'export const MARKET_KEYWORDS',
    'export const DATA_KEYWORDS',
    'export const SYMBOL_PREFIX_CATEGORY',
    'export type AlertLevel',
    'export type DerivedAlertCategory',
    'export interface AlertsPanelFilterState',
    'export interface EnrichedAlert',
    'export interface CategorySummary',
    'export interface LevelSummary',
    'export function normalizeAlertLevel',
    'export function deriveAlertCategoryFromMessage',
    'export function enrichAlerts',
    'export function filterAlerts',
    'export function sortAlertsBySeverityThenTime',
    'export function summarizeAlertsByCategory',
    'export function summarizeAlertsByLevel',
    'export function emptyAlertsPanelFilterState',
    'export function hasActiveFilter',
  ]) {
    assert(`[10.1] helper exports ${name}`, helperSrc.includes(name));
  }
}

// ============================================================
// 汇总
// ============================================================
console.log(`\nalerts-panel helpers tests: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
