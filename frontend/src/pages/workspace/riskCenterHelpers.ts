/**
 * PR-C 风控中心 v2 — 纯函数 helpers.
 *
 * 上下文: prod 近 7 日 196 条 risk_alerts 里 177 (90%) 是 `wizard_compliance`
 * MEDIUM (BUY 信号合规阻断), 真正"关键事件" `per_stock_stop_loss HIGH`
 * (宝钢止损) 仅 1 条, 被埋到第 6 页 — 用户感觉"关键事件没同步"实为信号噪音淹没.
 *
 * 本 helper 负责 4 件事让 RiskAlertCenterPanel 把关键事件"挑出来":
 *   1) RULE_ID_META: 把生硬的 rule_id 字符串映射成 中文 label + icon + 颜色 + category;
 *   2) AlertView: 4 种智能视图 (critical / positions / data / all);
 *   3) filterAlertsByView: 按视图过滤 (持仓视图需要 positionSymbols 入参);
 *   4) aggregateAlertsByRuleAndSymbol: 同 (rule_id, symbol, day) 24h 内 N 条
 *      折叠成 1 条 + aggregated_count.
 *
 * 与 [[alertsPanelHelpers]] (今日作战 unread 预览) 的边界:
 *   - alertsPanelHelpers 消费 UnreadRiskAlertItem (无 rule_id, 启发式分类);
 *   - 本 helper 消费 RiskAlertItem (有 rule_id + category, 精确映射).
 *
 * 单测: backend/tests/services/risk-center-helpers.test.ts (跨 monorepo import).
 * 与 [[alertsPanelHelpers]] / [[strategyKillSwitchHelpers]] 同款 "pure helper +
 * 阈值 export + 兜底 null/undefined/NaN" 范式.
 */

import type { RiskAlertItem, AlertCategory } from '../../services/riskAlertService';

// ---------------------------------------------------------------------------
// RULE_ID_META — 把 rule_id 字符串映射成 UI 友好元数据
// ---------------------------------------------------------------------------

/** rule_id 的元数据 — 1 个 rule 1 行, UI 直接消费. */
export interface RuleIdMeta {
  /** 中文 label, 显示在表格"规则"列 */
  label: string;
  /** emoji icon (单字符, 跨 OS 一致). 不用 SVG 是因为本 v2 不引入新依赖. */
  icon: string;
  /** Tag 浅色背景 + 深色文字 — Stripe-ish; 复用前面 levelTag 红/橙/蓝色板 */
  color: string;
  /** 4 大归类, 与 AlertView 配合 */
  category: 'risk' | 'data' | 'compliance' | 'opportunity';
  /** category 中文 label (Tag 内显示 / view 标题). */
  categoryLabel: string;
}

/**
 * 17 个常见 rule_id 映射 (覆盖 prod 真实数据全部 rule_id).
 *
 * - 4 risk (止损 / 熔断 / 黑天鹅 / 个股利空)
 * - 3 data (陈旧 / 质量 / 同步异常)
 * - 1 compliance (5 维合规 — 占 prod 90%)
 * - 1 opportunity (个股利好 — PR-B 新加, 必须能正向显示)
 *
 * 顺序: risk > data > compliance > opportunity (与 AlertView 排序一致).
 *
 * 新加 rule_id 务必 (a) 在本表登记 (b) 在 backend/tests/services/risk-center-helpers
 * 的 [coverage] 测试加 case. 否则 fallback meta 会让用户看到生硬 rule_id 字符串.
 */
export const RULE_ID_META: Readonly<Record<string, RuleIdMeta>> = Object.freeze({
  // ---- risk ----
  per_stock_stop_loss: {
    label: '个股止损',
    icon: '🛑',
    color: '#dc2626',
    category: 'risk',
    categoryLabel: '风险',
  },
  drawdown_breaker: {
    label: '回撤熔断',
    icon: '⚡',
    color: '#dc2626',
    category: 'risk',
    categoryLabel: '风险',
  },
  trailing_stop: {
    label: '跟踪止损',
    icon: '📉',
    color: '#dc2626',
    category: 'risk',
    categoryLabel: '风险',
  },
  position_limit: {
    label: '仓位上限',
    icon: '⚠️',
    color: '#f59e0b',
    category: 'risk',
    categoryLabel: '风险',
  },
  industry_concentration: {
    label: '行业集中度',
    icon: '⚠️',
    color: '#f59e0b',
    category: 'risk',
    categoryLabel: '风险',
  },
  market_regime_alert: {
    label: '市场环境',
    icon: '🌪️',
    color: '#f59e0b',
    category: 'risk',
    categoryLabel: '风险',
  },
  factor_correlation: {
    label: '因子相关',
    icon: '🔗',
    color: '#f59e0b',
    category: 'risk',
    categoryLabel: '风险',
  },
  black_swan: {
    label: '黑天鹅',
    icon: '🦢',
    color: '#7f1d1d',
    category: 'risk',
    categoryLabel: '风险',
  },
  stock_bearish_event: {
    label: '个股利空',
    icon: '🔴',
    color: '#dc2626',
    category: 'risk',
    categoryLabel: '风险',
  },
  circuit_breaker: {
    label: '熔断',
    icon: '🚨',
    color: '#7f1d1d',
    category: 'risk',
    categoryLabel: '风险',
  },
  // ---- data ----
  data_freshness: {
    label: '数据陈旧',
    icon: '📊',
    color: '#d97706',
    category: 'data',
    categoryLabel: '数据',
  },
  data_quality_scan: {
    label: '数据质量',
    icon: '🔍',
    color: '#6b7280',
    category: 'data',
    categoryLabel: '数据',
  },
  data_missing: {
    label: '数据缺失',
    icon: '📉',
    color: '#d97706',
    category: 'data',
    categoryLabel: '数据',
  },
  sync_failure: {
    label: '同步异常',
    icon: '⚙️',
    color: '#6b7280',
    category: 'data',
    categoryLabel: '数据',
  },
  // ---- compliance ----
  wizard_compliance: {
    label: '5 维合规',
    icon: '✓',
    color: '#6b7280',
    category: 'compliance',
    categoryLabel: '合规',
  },
  // ---- opportunity ----
  stock_bullish_event: {
    label: '个股利好',
    icon: '🟢',
    color: '#16a34a',
    category: 'opportunity',
    categoryLabel: '机会',
  },
  earnings_surprise_alert: {
    label: '业绩超预期',
    icon: '📈',
    color: '#16a34a',
    category: 'opportunity',
    categoryLabel: '机会',
  },
  // ---- PR-M4 (2026-06-29) — 仓位风控 hard caps ----
  // 系统级单仓 5% + 板块 25% hard cap. PR-K 回测 win 32%, 用户授权.
  sizing_cap_exceeded: {
    label: '⚖️ 单仓 5% 上限',
    icon: '⚖️',
    color: '#d97706',
    category: 'risk',
    categoryLabel: '风险',
  },
  industry_concentration_cap_exceeded: {
    label: '📊 板块 25% 上限',
    icon: '📊',
    color: '#d97706',
    category: 'risk',
    categoryLabel: '风险',
  },
  // ---- PR-M2/M3 (2026-06-29) — 盘中异动 / 反转 / 板块强弱 (前向兼容) ----
  // 这些 rule_id 待 PR-M2/M3 后端 merged 后才会真实写入 RiskAlert; 前端先注册中文
  // 映射, 一旦 backend 真实发出 alert UI 立刻能识别 (避免用户先看到生硬英文).
  intraday_momentum_buy: {
    label: '📈 日内动量买入',
    icon: '📈',
    color: '#dc2626',
    category: 'opportunity',
    categoryLabel: '机会',
  },
  intraday_momentum_sell: {
    label: '📉 日内动量卖出',
    icon: '📉',
    color: '#16a34a',
    category: 'risk',
    categoryLabel: '风险',
  },
  reversal_buy: {
    label: '🔄 反转买入',
    icon: '🔄',
    color: '#dc2626',
    category: 'opportunity',
    categoryLabel: '机会',
  },
  reversal_sell: {
    label: '🔄 反转卖出',
    icon: '🔄',
    color: '#16a34a',
    category: 'risk',
    categoryLabel: '风险',
  },
  leader_industry: {
    label: '👑 龙头板块',
    icon: '👑',
    color: '#dc2626',
    category: 'opportunity',
    categoryLabel: '机会',
  },
  weak_industry: {
    label: '⚠️ 弱势板块',
    icon: '⚠️',
    color: '#9ca3af',
    category: 'risk',
    categoryLabel: '风险',
  },
});

/** unknown rule_id 的兜底元数据 — 灰色 + 显示原 rule_id 文本. */
export const FALLBACK_RULE_META: RuleIdMeta = Object.freeze({
  label: '其它规则',
  icon: '·',
  color: '#9ca3af',
  category: 'risk',
  categoryLabel: '其它',
});

/**
 * 取 rule_id 对应元数据. null/undefined/未知 → FALLBACK_RULE_META (label 会被
 * caller 替换为 raw rule_id 字符串, 让用户至少能看到原始值便于排查).
 */
export function getRuleIdMeta(ruleId: string | null | undefined): RuleIdMeta {
  if (typeof ruleId !== 'string' || !ruleId.trim()) return FALLBACK_RULE_META;
  const meta = RULE_ID_META[ruleId.trim()];
  if (meta) return meta;
  // 返回 fallback 但 label 用原 rule_id (让用户至少看到 "未注册的 rule_id" 是什么)
  return { ...FALLBACK_RULE_META, label: ruleId.trim() };
}

/** 覆盖率守护 — 单测 import 这个常量断言总数. */
export const RULE_ID_META_COVERAGE_COUNT = Object.keys(RULE_ID_META).length;

// ---------------------------------------------------------------------------
// AlertView — 智能视图
// ---------------------------------------------------------------------------

/** 4 种智能视图. 默认 'critical' (关键事件) — 让用户进入就直接看到最重要的. */
export type AlertView = 'critical' | 'positions' | 'data' | 'all';

/** Segmented options — caller 直接渲染. label 用最短文本节省宽度. */
export const ALERT_VIEW_OPTIONS: ReadonlyArray<{ label: string; value: AlertView }> = Object.freeze(
  [
    { label: '关键事件', value: 'critical' },
    { label: '持仓相关', value: 'positions' },
    { label: '数据健康', value: 'data' },
    { label: '全部', value: 'all' },
  ]
);

/** 关键事件: HIGH 级 + risk 类全部 rule_id (不论 level) + opportunity 类 (利好/超预期). */
const CRITICAL_RULE_IDS_FORCE: ReadonlyArray<string> = Object.freeze([
  'per_stock_stop_loss',
  'drawdown_breaker',
  'circuit_breaker',
  'black_swan',
  'stock_bullish_event',
  'stock_bearish_event',
  'earnings_surprise_alert',
]);

/**
 * 按视图过滤 alerts.
 *
 * - 'critical': level=HIGH OR rule_id ∈ CRITICAL_RULE_IDS_FORCE
 * - 'positions': symbol 在 positionSymbols (caller 传入用户持仓代码) 内, OR category='position'
 * - 'data': RULE_ID_META[rule_id].category === 'data'
 * - 'all': 不过滤
 *
 * 兜底: positionSymbols 缺省 → 仅按 category='position' 过滤 (退化, 不阻塞).
 */
export function filterAlertsByView(
  items: ReadonlyArray<RiskAlertItem> | null | undefined,
  view: AlertView,
  positionSymbols?: ReadonlyArray<string> | null
): RiskAlertItem[] {
  if (!Array.isArray(items)) return [];
  if (view === 'all') return items.slice();

  const posSet = new Set(
    (positionSymbols ?? []).filter((s): s is string => typeof s === 'string' && s.length > 0)
  );

  const out: RiskAlertItem[] = [];
  for (const it of items) {
    if (!it) continue;
    const ruleId = typeof it.rule_id === 'string' ? it.rule_id : '';
    const level = typeof it.level === 'string' ? it.level.toUpperCase() : '';

    if (view === 'critical') {
      if (level === 'HIGH' || level === 'CRITICAL') {
        out.push(it);
        continue;
      }
      if (ruleId && CRITICAL_RULE_IDS_FORCE.includes(ruleId)) {
        out.push(it);
        continue;
      }
    } else if (view === 'positions') {
      if (it.category === 'position') {
        out.push(it);
        continue;
      }
      if (it.symbol && posSet.has(it.symbol)) {
        out.push(it);
        continue;
      }
    } else if (view === 'data') {
      if (ruleId) {
        const meta = RULE_ID_META[ruleId];
        if (meta && meta.category === 'data') {
          out.push(it);
          continue;
        }
      }
      // category='data' 兜底 (后端将来如果加 data category)
      // (当前后端 AlertCategory 只有 position/market/individual, 不会触发)
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 24h 聚合 — 同 (rule_id, symbol, day) N 条折叠成 1 条
// ---------------------------------------------------------------------------

/** 聚合后单组的 view-model — 用最新一条作为代表 + 携带 group 全量供 expand. */
export interface AggregatedAlert extends RiskAlertItem {
  /** 同组总条数 (>= 1). */
  aggregated_count: number;
  /** 同组全部 alert (按时间倒序). 用于 expandedRowRender. */
  aggregated_alerts: RiskAlertItem[];
}

/**
 * 把 alerts 按 (rule_id, symbol, day) 分组. 同组用最新一条 (created_at desc) 作为
 * 代表行, group 全量挂在 aggregated_alerts 字段供 expand 展示.
 *
 * "day" 用 YYYY-MM-DD UTC 截断 (与 server 存的 created_at ISO 字符串前 10 位
 * 一致, 避免 dayjs 时区抖动). 同一天内同 (rule_id, symbol) 视为重复.
 *
 * 兜底:
 *   - rule_id 缺省 → '__no_rule__' 占位 key (仍参与聚合)
 *   - symbol 缺省 → '__no_symbol__'
 *   - created_at 非法 → 用字符串原值排序 (稳定但可能不准)
 *
 * 性能: 单遍 O(N) 建 Map, 再 O(N) 转数组 + group 内排序. N=200 时 < 1ms.
 */
export function aggregateAlertsByRuleAndSymbol(
  items: ReadonlyArray<RiskAlertItem> | null | undefined
): AggregatedAlert[] {
  if (!Array.isArray(items)) return [];

  const groups = new Map<string, RiskAlertItem[]>();
  for (const it of items) {
    if (!it) continue;
    const rule = typeof it.rule_id === 'string' && it.rule_id ? it.rule_id : '__no_rule__';
    const sym = typeof it.symbol === 'string' && it.symbol ? it.symbol : '__no_symbol__';
    const created = typeof it.created_at === 'string' ? it.created_at : '';
    const day = created.slice(0, 10) || '__no_day__';
    const key = `${rule}|${sym}|${day}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(it);
    else groups.set(key, [it]);
  }

  const out: AggregatedAlert[] = [];
  groups.forEach(bucket => {
    // group 内按 created_at desc 排序, 第一条作为代表行
    bucket.sort((a: RiskAlertItem, b: RiskAlertItem) => {
      const ta = String(a.created_at || '');
      const tb = String(b.created_at || '');
      if (ta === tb) return (b.id || 0) - (a.id || 0);
      return tb < ta ? -1 : 1;
    });
    const head = bucket[0];
    out.push({
      ...head,
      aggregated_count: bucket.length,
      aggregated_alerts: bucket,
    });
  });
  // 聚合后再按 (head.created_at desc) 排, 与表格默认时间排序一致
  out.sort((a, b) => {
    const ta = String(a.created_at || '');
    const tb = String(b.created_at || '');
    if (ta === tb) return (b.id || 0) - (a.id || 0);
    return tb < ta ? -1 : 1;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Hero metrics — 让顶部 hero 4 个 metric 一眼可读
// ---------------------------------------------------------------------------

export interface RiskCenterHeroStats {
  /** 今日 (created_at >= 今日 00:00 本地时区) 新增条数. */
  newToday: number;
  /** 本周 (近 7 天) 累计条数. */
  weekTotal: number;
  /** HIGH 占比 (HIGH / total), 0~1; total=0 时 0. */
  highRatio: number;
  /** 数据健康: 'healthy' (无 data 类 HIGH/MEDIUM) / 'degraded' (有 data 类 MEDIUM/HIGH). */
  dataHealth: 'healthy' | 'degraded';
  /** 数据健康对应的 data 类未读条数 (UI suffix 显示). */
  dataIssueCount: number;
}

/** 今日 0 点 ISO date 字符串 (用于 created_at 比较). */
function todayDateString(now: Date): string {
  // local YYYY-MM-DD 0 点
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 7 天前 0 点 ISO date 字符串. */
function sevenDaysAgoDateString(now: Date): string {
  const past = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000); // 含今天共 7 天
  return todayDateString(past);
}

/**
 * 计算 hero metrics. items 应该是 backend 已经按 user_id 过滤后的全量 (caller
 * 通常传当前分页的 list, 也能跑但 weekTotal 不准 — 真正用 hero 应单独全量拉一次,
 * 现阶段 v2 用当前分页的 items 估算, 后续 PR-D 可加 /api/risk-alerts/stats 端点).
 */
export function computeRiskCenterHeroStats(
  items: ReadonlyArray<RiskAlertItem> | null | undefined,
  now: Date = new Date()
): RiskCenterHeroStats {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      newToday: 0,
      weekTotal: 0,
      highRatio: 0,
      dataHealth: 'healthy',
      dataIssueCount: 0,
    };
  }

  const todayStr = todayDateString(now);
  const weekStartStr = sevenDaysAgoDateString(now);

  let newToday = 0;
  let weekTotal = 0;
  let highCount = 0;
  let dataIssueCount = 0;

  for (const it of items) {
    if (!it) continue;
    const created = typeof it.created_at === 'string' ? it.created_at.slice(0, 10) : '';
    if (created && created >= weekStartStr) weekTotal += 1;
    if (created && created >= todayStr) newToday += 1;
    const level = typeof it.level === 'string' ? it.level.toUpperCase() : '';
    if (level === 'HIGH' || level === 'CRITICAL') highCount += 1;

    const ruleId = typeof it.rule_id === 'string' ? it.rule_id : '';
    const meta = ruleId ? RULE_ID_META[ruleId] : undefined;
    if (meta && meta.category === 'data' && (level === 'HIGH' || level === 'MEDIUM')) {
      dataIssueCount += 1;
    }
  }

  const highRatio = items.length > 0 ? highCount / items.length : 0;
  return {
    newToday,
    weekTotal,
    highRatio,
    dataHealth: dataIssueCount > 0 ? 'degraded' : 'healthy',
    dataIssueCount,
  };
}

// ---------------------------------------------------------------------------
// 未读未处理 HIGH 计数 (sticky banner 用)
// ---------------------------------------------------------------------------

/**
 * 未读 HIGH (或 CRITICAL) 计数. UI sticky banner 据此决定是否显示.
 *
 * 注意: 是 unread + HIGH 同时满足, 不是全部 HIGH (已读的不该再骚扰用户).
 */
export function countUnreadHighAlerts(
  items: ReadonlyArray<RiskAlertItem> | null | undefined
): number {
  if (!Array.isArray(items)) return 0;
  let n = 0;
  for (const it of items) {
    if (!it) continue;
    if (it.is_read) continue;
    const level = typeof it.level === 'string' ? it.level.toUpperCase() : '';
    if (level === 'HIGH' || level === 'CRITICAL') n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 重新 export, 让 caller 单点 import
// ---------------------------------------------------------------------------

export type { RiskAlertItem, AlertCategory };
