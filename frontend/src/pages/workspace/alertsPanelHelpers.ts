/**
 * US-071 [FE-032] AlertsPanel filter + search + 分类 — 纯函数 helper.
 *
 * 让 TodayWorkspace 的"风险提醒" tab 从简单预览升级为带过滤/搜索/分类 KPI 的
 * 完整面板, 不引入新的 endpoint 调用 (仍消费 /api/today/signals 返的
 * `unread_alerts` UnreadRiskAlertItem[]).
 *
 * 与 RiskAlertCenterPanel (risk_center sub-tab) 的边界:
 *   - RiskAlertCenterPanel = /api/risk-alerts/list 全量分页 + 批量已读 + 后端过滤;
 *     重操作用户主动进入. 数据含 rule_id / category 等完整字段.
 *   - AlertsPanel (本 story 增强) = /api/today/signals 内的 unread_alerts 预览
 *     (cap=20), 用户在"今日作战"页就地快速浏览, 不切 tab. 数据仅含
 *     id/symbol/name/level/message/created_at, 无 rule_id, 类别只能启发式派生.
 *
 * 与 [[alertsBellHelpers]] / [[strategyKillSwitchHelpers]] / [[shadowRunHelpers]]
 * 同款"前端 pure helper 模板":
 *   - 所有"决策表 / 阈值 / 格式化"全抽到本文件, JSX 永远只读 helper 返值;
 *   - 阈值常量 export 让单测可直接 import 守 sanity;
 *   - null / undefined / NaN / 空数组 全部兜底成"安全态" (空集 / 默认级别) 不报错;
 *   - 决策表用短路链表达, 阈值 export 让单测 + ops 调参一行生效;
 *
 * 不依赖 React / antd / fetch. 单测在
 * backend/tests/services/alerts-panel-helpers.test.ts (跨 monorepo import).
 */

import type { UnreadRiskAlertItem } from '../../services/todayWorkspaceService';

// ---------------------------------------------------------------------------
// 类型 + 常量
// ---------------------------------------------------------------------------

/** Alert level — 与 backend RiskAlert.level 字符串值对齐. */
export type AlertLevel = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * 启发式 category — UnreadRiskAlertItem 没 rule_id 字段, 只能根据 symbol/message
 * 关键词派生. 与 [[deriveAlertCategory]] (基于 rule_id 的精确版) 互补,
 * 在 UnreadRiskAlertItem 上下文使用本 derivation.
 *
 * - position   : 持仓相关 (止损 / 行业集中 / 回撤熔断 / 跟踪止损 等)
 * - market     : 市场宏观 (黑天鹅 / 大盘趋势 / 流动性 / 北向 / 龙虎)
 * - individual : 个股提醒 (波动 / 异动 / 公告 等)
 * - data       : 数据缺失类 (与 US-062 落地的 DATA_MISSING_ALERT_CATEGORY 对齐)
 */
export type DerivedAlertCategory = 'position' | 'market' | 'individual' | 'data';

/** Category 显示标签 (中文). */
export const DERIVED_CATEGORY_LABEL: Readonly<Record<DerivedAlertCategory, string>> = Object.freeze(
  {
    position: '持仓',
    market: '市场',
    individual: '单股',
    data: '数据',
  }
);

/** Category Tag 颜色 — 与 antd Tag 主题色对齐, 与 RiskAlertCenterPanel 同款. */
export const DERIVED_CATEGORY_TAG_COLOR: Readonly<Record<DerivedAlertCategory, string>> =
  Object.freeze({
    position: 'volcano',
    market: 'geekblue',
    individual: 'cyan',
    data: 'gold',
  });

/** Level 中文标签. */
export const LEVEL_LABEL: Readonly<Record<AlertLevel, string>> = Object.freeze({
  HIGH: '高',
  MEDIUM: '中',
  LOW: '低',
});

/**
 * Level 排序权重 — HIGH 最大 (排序时降序排在最前).
 * 与 [[shadowRunHelpers]] 三档严重度同款思想.
 */
export const LEVEL_RANK: Readonly<Record<AlertLevel, number>> = Object.freeze({
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
});

/**
 * 搜索关键词最小长度 — 1 字也允许 (中文单字搜索常见), 但空白串视为无过滤.
 * 与 RiskAlertCenterPanel 的 Input.Search 行为一致.
 */
export const MIN_SEARCH_QUERY_LENGTH = 1;

/**
 * 搜索结果上限 cap — 防止搜出 9999 条把 UI 卡死. UnreadRiskAlertItem
 * 已经 cap=20 from backend, 但本 cap 让 helper 可被复用于未来更长列表.
 */
export const MAX_SEARCH_RESULTS = 200;

/**
 * 持仓类关键词 — 这些词出现在 message 里时 derived 为 'position'.
 * 顺序按"具体度从高到低" — 与 [[classifyEventType]] / [[EVENT_TYPE_KEYWORDS]] (US-026)
 * 同款"具体优先" 思想. 不可改为 Set (Set 无序, 顺序敏感).
 *
 * 频繁更新这张表会让单测 [3.*] failure rate 高 — 加新关键词务必跑 helper 测试.
 */
export const POSITION_KEYWORDS: readonly string[] = Object.freeze([
  '行业集中', // industry concentration
  '回撤熔断', // drawdown breaker
  '跟踪止损', // trailing stop
  '止损', // stop loss
  '止盈', // take profit
  '持仓', // position cap
  '仓位', // position size
  '建仓', // build position
  '减仓', // reduce position
  '清仓', // liquidate
]);

/**
 * 市场宏观类关键词 — message 含这些词时 derived 为 'market'.
 * 注意"黑天鹅" 必须在"天鹅" 之前 (虽 helper 用 includes, 但顺序保持高→低具体度
 * 与 POSITION_KEYWORDS 一致, 便于未来若换 indexOf 链不出 bug).
 */
export const MARKET_KEYWORDS: readonly string[] = Object.freeze([
  '黑天鹅', // black swan
  '大盘', // index
  '指数熔断', // index circuit breaker
  '北向', // northbound
  '南向', // southbound
  '龙虎榜', // dragon-tiger list
  '市场情绪', // market sentiment
  '流动性', // liquidity
  '宏观', // macro
  '汇率', // FX
]);

/**
 * 数据类关键词 — 与 [[DATA_MISSING_ALERT_CATEGORY]] (US-062) 互补.
 * UnreadRiskAlertItem 不带 category 字段, 只能从 message 关键词识别.
 */
export const DATA_KEYWORDS: readonly string[] = Object.freeze([
  '数据缺失', // data missing
  '同步异常', // sync error
  '数据滞后', // data lag
  '数据源', // data source
  '行情中断', // quote interruption
]);

/**
 * symbol 前缀 → category 直接映射 — 优先级最高 (在 message 关键词之前判断).
 * 与 [[deriveAlertCategory]] (US-077) 同款 "SYSTEM:" 视为 market 思想.
 */
export const SYMBOL_PREFIX_CATEGORY: Readonly<Record<string, DerivedAlertCategory>> = Object.freeze(
  {
    'SYSTEM:': 'market',
    'DATA:': 'data',
  }
);

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

/**
 * 把任意 input 规范化为合法 AlertLevel; 非法值兜底为 'LOW'.
 *
 * 兜底规则:
 *   - 大小写无关 ('high'/'High'/'HIGH' 都返 'HIGH')
 *   - 非 string / 空串 / 未知值 → 'LOW' (safe-default, 与 [[normalizePriority]] 同思想)
 */
export function normalizeAlertLevel(input: unknown): AlertLevel {
  if (typeof input !== 'string') return 'LOW';
  const upper = input.trim().toUpperCase();
  if (upper === 'HIGH') return 'HIGH';
  if (upper === 'MEDIUM') return 'MEDIUM';
  if (upper === 'LOW') return 'LOW';
  return 'LOW';
}

/**
 * 派生 category — 优先级链:
 *   (1) symbol 前缀映射 (SYSTEM:/DATA:) — 最权威
 *   (2) message 含 DATA_KEYWORDS — 数据类
 *   (3) message 含 POSITION_KEYWORDS — 持仓类
 *   (4) message 含 MARKET_KEYWORDS — 市场类
 *   (5) 否则 fallback 'individual' — 个股提醒 (最常见, safe-default)
 *
 * 短路 + 优先级链 与 [[classifyEventType]] / [[computeBlackSwanPriority]] 同款.
 *
 * data 优先于 position/market 是因为"数据缺失"本身可能含"行业" 等无关词
 * (e.g. "行业资金流入数据同步异常"), 必须先识别为 data.
 */
export function deriveAlertCategoryFromMessage(
  symbol: string | null | undefined,
  message: string | null | undefined
): DerivedAlertCategory {
  // (1) 前缀映射
  const sym = typeof symbol === 'string' ? symbol : '';
  for (const [prefix, cat] of Object.entries(SYMBOL_PREFIX_CATEGORY)) {
    if (sym.startsWith(prefix)) return cat;
  }

  const msg = typeof message === 'string' ? message : '';
  if (!msg) return 'individual';

  // (2) data 优先
  if (DATA_KEYWORDS.some(kw => msg.includes(kw))) return 'data';
  // (3) position
  if (POSITION_KEYWORDS.some(kw => msg.includes(kw))) return 'position';
  // (4) market
  if (MARKET_KEYWORDS.some(kw => msg.includes(kw))) return 'market';
  // (5) fallback
  return 'individual';
}

/**
 * 为 UnreadRiskAlertItem 计算派生字段 (level + category) — 缓存中间结果让多次
 * 过滤/排序不重复计算. caller 通常调一次 enrichAlerts 把整列 map 出来,
 * 再传给 filterAlerts / sortAlertsBySeverityThenTime / groupAlertsByCategory.
 */
export interface EnrichedAlert extends UnreadRiskAlertItem {
  /** 规范化后的 level (兜底过). */
  derived_level: AlertLevel;
  /** 启发式 category. */
  derived_category: DerivedAlertCategory;
}

/**
 * 把 UnreadRiskAlertItem 转成 EnrichedAlert (加 derived_level / derived_category).
 *
 * 兜底:
 *   - input 非数组 → []
 *   - 单 item null/undefined → 跳过 (不抛)
 *   - 缺字段 → 用空串兜底, derived 走默认 'individual' + 'LOW'
 */
export function enrichAlerts(
  items: ReadonlyArray<UnreadRiskAlertItem | null | undefined> | null | undefined
): EnrichedAlert[] {
  if (!Array.isArray(items)) return [];
  const out: EnrichedAlert[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    out.push({
      ...it,
      symbol: typeof it.symbol === 'string' ? it.symbol : '',
      name: typeof it.name === 'string' ? it.name : '',
      message: typeof it.message === 'string' ? it.message : '',
      derived_level: normalizeAlertLevel(it.level),
      derived_category: deriveAlertCategoryFromMessage(it.symbol, it.message),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filter + search
// ---------------------------------------------------------------------------

/**
 * AlertsPanel 过滤状态 — 与 RiskAlertCenterPanel 的 filterLevel / filterType /
 * filterSearch 同款字段名, 让两个 panel UI 形态对齐 (用户认知零迁移成本).
 *
 * 任何字段缺省 (undefined / null / 空串) = 不过滤. 这与 antd Select allowClear
 * 行为天然吻合.
 */
export interface AlertsPanelFilterState {
  /** 仅显示指定 level (undefined = 全部) */
  level?: AlertLevel;
  /** 仅显示指定 derived_category (undefined = 全部) */
  category?: DerivedAlertCategory;
  /** symbol/name/message 模糊搜索, 不区分大小写, trim 后空串视为无过滤 */
  search?: string;
}

/**
 * 把 EnrichedAlert[] 按 filter state 过滤. AND 关系: level / category / search
 * 全满足才保留. 任一条件缺省即跳过该条件.
 *
 * 性能: O(N) 遍历, 提前 return 短路. 与 RiskAlertCenterPanel 后端 SQL WHERE
 * 同语义 (level=? AND category=? AND (symbol LIKE %?% OR name LIKE %?% OR message LIKE %?%)).
 */
export function filterAlerts(
  items: ReadonlyArray<EnrichedAlert> | null | undefined,
  filterState: AlertsPanelFilterState | null | undefined
): EnrichedAlert[] {
  if (!Array.isArray(items)) return [];
  const f = filterState || {};
  const searchQuery = typeof f.search === 'string' ? f.search.trim().toLowerCase() : '';
  const useSearch = searchQuery.length >= MIN_SEARCH_QUERY_LENGTH;

  const out: EnrichedAlert[] = [];
  for (const it of items) {
    if (!it) continue;
    if (f.level && it.derived_level !== f.level) continue;
    if (f.category && it.derived_category !== f.category) continue;
    if (useSearch) {
      const hay = `${it.symbol}\n${it.name}\n${it.message}`.toLowerCase();
      if (!hay.includes(searchQuery)) continue;
    }
    out.push(it);
    if (out.length >= MAX_SEARCH_RESULTS) break;
  }
  return out;
}

/**
 * 按 (derived_level desc, created_at desc) 稳定排序.
 *
 * 与 [[sortPlanRows]] / [[sortSellSuggestions]] (US-042/044) 同款 3 段稳定:
 *   - 第 1 段: LEVEL_RANK 降序 (HIGH > MEDIUM > LOW)
 *   - 第 2 段: created_at 字符串字典序降序 (ISO 时间字符串可直接比较)
 *   - 第 3 段: id 升序 (兜底稳定, 同时间同级别按 id 顺序, 与 RiskAlertCenterPanel
 *     表格默认排序一致)
 */
export function sortAlertsBySeverityThenTime(
  items: ReadonlyArray<EnrichedAlert> | null | undefined
): EnrichedAlert[] {
  if (!Array.isArray(items)) return [];
  const arr = items.filter((x): x is EnrichedAlert => Boolean(x));
  arr.sort((a, b) => {
    const lr = LEVEL_RANK[b.derived_level] - LEVEL_RANK[a.derived_level];
    if (lr !== 0) return lr;
    const ta = String(a.created_at || '');
    const tb = String(b.created_at || '');
    if (tb !== ta) return tb < ta ? -1 : 1;
    return (a.id || 0) - (b.id || 0);
  });
  return arr;
}

// ---------------------------------------------------------------------------
// Summarize (category KPI bar / level breakdown)
// ---------------------------------------------------------------------------

/**
 * 单 category 的统计摘要 — UI category KPI bar 直接消费.
 */
export interface CategorySummary {
  category: DerivedAlertCategory;
  label: string;
  total: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * 按 derived_category 分桶 + 统计 level 分布. 永远返 4 个 category
 * (即使某类为 0), 让 UI KPI bar 渲染顺序稳定不闪烁.
 *
 * 顺序固定: position → market → individual → data (与 DERIVED_CATEGORY_LABEL
 * 定义顺序一致).
 */
export function summarizeAlertsByCategory(
  items: ReadonlyArray<EnrichedAlert> | null | undefined
): CategorySummary[] {
  const buckets: Record<DerivedAlertCategory, { high: number; medium: number; low: number }> = {
    position: { high: 0, medium: 0, low: 0 },
    market: { high: 0, medium: 0, low: 0 },
    individual: { high: 0, medium: 0, low: 0 },
    data: { high: 0, medium: 0, low: 0 },
  };

  if (Array.isArray(items)) {
    for (const raw of items) {
      const it = raw as EnrichedAlert | null | undefined;
      if (!it) continue;
      const cat: DerivedAlertCategory = it.derived_category;
      const lvl: AlertLevel = it.derived_level;
      if (lvl === 'HIGH') buckets[cat].high += 1;
      else if (lvl === 'MEDIUM') buckets[cat].medium += 1;
      else buckets[cat].low += 1;
    }
  }

  const ordered: DerivedAlertCategory[] = ['position', 'market', 'individual', 'data'];
  return ordered.map(cat => {
    const b = buckets[cat];
    return {
      category: cat,
      label: DERIVED_CATEGORY_LABEL[cat],
      total: b.high + b.medium + b.low,
      high: b.high,
      medium: b.medium,
      low: b.low,
    };
  });
}

/**
 * 单 level 的统计摘要 — UI level KPI 直接消费.
 */
export interface LevelSummary {
  level: AlertLevel;
  label: string;
  count: number;
}

/**
 * 按 derived_level 分桶. 永远返 3 个 level (HIGH/MEDIUM/LOW 顺序固定).
 */
export function summarizeAlertsByLevel(
  items: ReadonlyArray<EnrichedAlert> | null | undefined
): LevelSummary[] {
  const counts: Record<AlertLevel, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  if (Array.isArray(items)) {
    for (const raw of items) {
      const it = raw as EnrichedAlert | null | undefined;
      if (!it) continue;
      const lvl: AlertLevel = it.derived_level;
      counts[lvl] += 1;
    }
  }
  return (['HIGH', 'MEDIUM', 'LOW'] as AlertLevel[]).map(lvl => ({
    level: lvl,
    label: LEVEL_LABEL[lvl],
    count: counts[lvl],
  }));
}

// ---------------------------------------------------------------------------
// Filter state utilities
// ---------------------------------------------------------------------------

/** 空 filter state — caller 初始化 useState 用. */
export function emptyAlertsPanelFilterState(): AlertsPanelFilterState {
  return { level: undefined, category: undefined, search: '' };
}

/**
 * 判断 filter state 是否"非空" (有任何主动过滤). UI 可据此显示"重置过滤"按钮.
 */
export function hasActiveFilter(state: AlertsPanelFilterState | null | undefined): boolean {
  if (!state) return false;
  if (state.level) return true;
  if (state.category) return true;
  if (typeof state.search === 'string' && state.search.trim().length >= MIN_SEARCH_QUERY_LENGTH) {
    return true;
  }
  return false;
}
