/**
 * US-072 [FE-033] AlertItem snooze + 一键执行 — 纯函数 helper.
 *
 * 给 [[alertsPanelHelpers]] 输出的 EnrichedAlert 列表里每一条 AlertItem 增加:
 *   1. snooze 1h / 1d / 1w 三档静音 — 本地 localStorage 持久化, 静音窗口内
 *      该 alert 不在 panel 显示, 也不计入 KPI bar.
 *   2. 一键执行 — 根据 alert.derived_category 算出"主要动作" (跳标的页 / 跳
 *      持仓页 / 跳风控中心 / 跳数据中心), 调用方拿到 ActionDescriptor 决定路由.
 *
 * 为什么 snooze 走前端 localStorage 而不走后端:
 *   - 本 story 验收只要"UI 工作" + 单测; 暂未引入 alert_snoozes 数据表
 *     (那是 backend 大改, 与本 sprint 节奏不符);
 *   - 与 [[alertsBellHelpers]] 60s 轮询配合: 用户 snooze 1h 后 60s 内 Badge
 *     仍可能短暂闪红一次 (server 仍计 unread_count), 这是已知 trade-off,
 *     待 PRD US-073 WebSocket /ws/alerts 落地后再统一收敛;
 *   - localStorage key 单用户单浏览器, 不跨设备 — 与"今日作战" tab 本身
 *     就是单 session 体验吻合;
 *   - 后端真 snooze (持久化 + 跨设备) 是后续 story 的扩展空间, 本 helper
 *     的 API 形态故意预留 readSnoozeMap/writeSnoozeMap 让未来替换为
 *     fetch('/api/alerts/:id/snooze') 时调用层无需大改.
 *
 * 与 [[alertsPanelHelpers]] / [[alertsBellHelpers]] 同款 "前端 pure helper 模板":
 *   - 所有决策表 / 阈值 / 路由 全抽到本文件, JSX 永远只读 helper 返值;
 *   - 阈值常量 export 让单测可直接 import 守 sanity;
 *   - null / undefined / NaN / 空数组 全部兜底成"安全态" 不报错;
 *   - localStorage 缺席 (SSR / 测试 jsdom 关掉时) 全走 in-memory fallback.
 *
 * 不依赖 React / antd. 单测在
 * backend/tests/services/alert-item-action-helpers.test.ts (跨 monorepo import).
 */

import type { EnrichedAlert, DerivedAlertCategory } from './alertsPanelHelpers';
import { ALERTS_BELL_TARGET_PATH } from './alertsBellHelpers';

// ---------------------------------------------------------------------------
// 类型 + 常量
// ---------------------------------------------------------------------------

/**
 * Snooze 档位 — 与 PRD US-072 验收文案"snooze 1h/1d/1w" 完全对齐.
 *
 * 顺序由短到长, 与 UI Dropdown menu item 顺序一致 (短选项在前, 是用户最
 * 常用的"先静一会儿等会再说"思维).
 */
export type SnoozeDuration = '1h' | '1d' | '1w';

/** Snooze 档位人类可读标签 (中文, 显在按钮 / 菜单上). */
export const SNOOZE_DURATION_LABEL: Readonly<Record<SnoozeDuration, string>> = Object.freeze({
  '1h': '静音 1 小时',
  '1d': '静音 1 天',
  '1w': '静音 1 周',
});

/**
 * Snooze 档位毫秒数 — 单测 + 实现的唯一事实源.
 *
 * 1h = 60 * 60 * 1000        = 3,600,000
 * 1d = 24 * 60 * 60 * 1000   = 86,400,000
 * 1w = 7  * 24 * 60 * 60 * 1000 = 604,800,000
 */
export const SNOOZE_DURATION_MS: Readonly<Record<SnoozeDuration, number>> = Object.freeze({
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
});

/**
 * 三档 Snooze 顺序冻结 — UI Dropdown 直接 map 出菜单.
 */
export const SNOOZE_DURATION_ORDER: readonly SnoozeDuration[] = Object.freeze<SnoozeDuration[]>([
  '1h',
  '1d',
  '1w',
]);

/**
 * localStorage key — 与现网其它前端 key (如 'auth_token' / 'workspace_filter')
 * 同款命名风格, 前缀清晰避免与第三方库冲突.
 *
 * 单用户单浏览器: 用户 A 在浏览器 X snooze, 不影响用户 B 也不影响用户 A 在
 * 浏览器 Y. 这与 alertsBellHelpers 轮询同款"无跨设备一致性" 取舍.
 */
export const SNOOZE_STORAGE_KEY = 'alertItem.snoozeMap.v1';

/**
 * 任一 alert 持有的 "snooze 信息" — until 是 ms epoch.
 *
 * until 设计成"绝对时间" 而非"剩余 ms" — 让 localStorage 写完关浏览器再开,
 * 不会因为重算"剩余" 而错算.
 */
export interface SnoozeEntry {
  /** snooze 的档位; 记录用于 UI 显示 "已静音 1 小时" tooltip. */
  duration: SnoozeDuration;
  /** snooze 到期的绝对时间 (ms epoch). now >= until 即"过期", 视为未 snooze. */
  until: number;
}

/**
 * alert id → SnoozeEntry 的字典 — localStorage 持久化形态.
 *
 * 用 string key 而非 number 是因为 JSON.parse 后 Object key 总是 string,
 * 与 alertsPanelHelpers EnrichedAlert.id (number) 之间在 lookup 时显式 String(id).
 */
export type SnoozeMap = Record<string, SnoozeEntry>;

/**
 * Snooze map storage interface — 让单测可注入 in-memory fake.
 * Production: 包一层 window.localStorage. 测试: 给个 Map<string,string> backed obj.
 *
 * 故意不直接 import localStorage — 走 DI seam 是 "前端 pure helper 模板" 的
 * 一致做法 (与 alertsBellHelpers clampPollInterval 不依赖 setInterval 同思想).
 */
export interface SnoozeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 给 production 用的真实 localStorage 适配器 — 任何环境 (test/SSR) 没
 * window.localStorage 时返 null-storage (fail-OPEN: 全走"未 snooze").
 */
export function defaultSnoozeStorage(): SnoozeStorage {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {
      getItem: () => null,
      setItem: () => {
        /* no-op */
      },
      removeItem: () => {
        /* no-op */
      },
    };
  }
  return window.localStorage;
}

// ---------------------------------------------------------------------------
// Snooze map I/O — JSON.parse 全 fail-OPEN
// ---------------------------------------------------------------------------

/**
 * 从 SnoozeStorage 读 SnoozeMap; 任何异常 (JSON 损坏 / quota 失败) → {}.
 *
 * 兜底:
 *   - storage.getItem throw → {}
 *   - JSON.parse 失败 → {} + 顺手清掉脏 entry (storage.removeItem)
 *   - parse 出非 object / array → {}
 *   - entry.until 非 number → 跳该 entry
 *   - entry.duration 非合法档位 → 跳该 entry
 */
export function readSnoozeMap(storage: SnoozeStorage = defaultSnoozeStorage()): SnoozeMap {
  let raw: string | null = null;
  try {
    raw = storage.getItem(SNOOZE_STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'string') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 脏数据顺手清掉, 防下次再次解析失败.
    try {
      storage.removeItem(SNOOZE_STORAGE_KEY);
    } catch {
      /* swallow */
    }
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: SnoozeMap = {};
  for (const [id, entryRaw] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = entryRaw as Partial<SnoozeEntry> | null | undefined;
    if (!entry || typeof entry !== 'object') continue;
    const until = (entry as SnoozeEntry).until;
    const duration = (entry as SnoozeEntry).duration;
    if (typeof until !== 'number' || !Number.isFinite(until)) continue;
    if (duration !== '1h' && duration !== '1d' && duration !== '1w') continue;
    out[String(id)] = { duration, until };
  }
  return out;
}

/**
 * 写回 SnoozeMap — quota 写满 / 任何异常吞掉返 false, 调用方按需 toast.
 *
 * 故意不抛 — 与 alertsBell fail-OPEN 思想一致: snooze 写失败不应让用户的
 * "点了静音" 动作变成红错误屏蔽下一步操作.
 */
export function writeSnoozeMap(
  map: SnoozeMap,
  storage: SnoozeStorage = defaultSnoozeStorage()
): boolean {
  try {
    storage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Snooze 计算 — 纯函数, 不读 storage
// ---------------------------------------------------------------------------

/**
 * 给定 now 与 duration, 算出 snooze until (绝对 ms epoch). 非法 duration 兜底 '1h'.
 */
export function computeSnoozeUntil(nowMs: number, duration: SnoozeDuration): number {
  const safeNow = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : 0;
  const ms = SNOOZE_DURATION_MS[duration] ?? SNOOZE_DURATION_MS['1h'];
  return safeNow + ms;
}

/**
 * 判断单 alert 此刻是否被 snooze.
 *
 * 真即"map 里有该 id 且 until > now". 任一不满足 → 未 snooze (默认显示).
 */
export function isAlertSnoozed(
  alertId: number | string | null | undefined,
  map: SnoozeMap | null | undefined,
  nowMs: number
): boolean {
  if (alertId === null || alertId === undefined) return false;
  if (!map || typeof map !== 'object') return false;
  const entry = map[String(alertId)];
  if (!entry) return false;
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : 0;
  return entry.until > now;
}

/**
 * 加入 / 更新 snooze entry (immutable — 返新 map, 不动 input).
 *
 * caller pattern: const next = addSnooze(prev, id, '1h', Date.now()); writeSnoozeMap(next);
 */
export function addSnooze(
  prev: SnoozeMap | null | undefined,
  alertId: number | string,
  duration: SnoozeDuration,
  nowMs: number
): SnoozeMap {
  const base: SnoozeMap = prev && typeof prev === 'object' ? { ...prev } : {};
  base[String(alertId)] = {
    duration,
    until: computeSnoozeUntil(nowMs, duration),
  };
  return base;
}

/**
 * 取消 snooze (用户 "撤销静音" 或一键执行后顺手清). immutable.
 */
export function removeSnooze(
  prev: SnoozeMap | null | undefined,
  alertId: number | string
): SnoozeMap {
  if (!prev || typeof prev !== 'object') return {};
  if (!(String(alertId) in prev)) return { ...prev };
  const next: SnoozeMap = { ...prev };
  delete next[String(alertId)];
  return next;
}

/**
 * 清理所有已过期 entry — 让 localStorage 不无限膨胀.
 *
 * 期望 caller 在挂载 panel 时跑一次 (与 buildTradingPlan 同款"读前先清"
 * 思想).
 */
export function pruneExpiredSnoozes(map: SnoozeMap | null | undefined, nowMs: number): SnoozeMap {
  if (!map || typeof map !== 'object') return {};
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : 0;
  const out: SnoozeMap = {};
  for (const [id, entry] of Object.entries(map)) {
    if (!entry) continue;
    if (entry.until > now) out[id] = entry;
  }
  return out;
}

/**
 * 过滤掉被 snooze 的 alert — AlertsPanel 在 enrich 后, filter 前调.
 *
 * 与 filterAlerts 解耦 (filter state vs snooze state 是两件事); UI 顺序:
 *   enrichAlerts → pruneExpiredSnoozes → filterOutSnoozedAlerts → filterAlerts → sort
 */
export function filterOutSnoozedAlerts(
  items: ReadonlyArray<EnrichedAlert> | null | undefined,
  map: SnoozeMap | null | undefined,
  nowMs: number
): EnrichedAlert[] {
  if (!Array.isArray(items)) return [];
  if (!map || typeof map !== 'object' || Object.keys(map).length === 0) {
    // 短路 — 多数用户 snooze map 为空, 不必为每条 alert 跑 lookup.
    return items.filter((x): x is EnrichedAlert => Boolean(x));
  }
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : 0;
  const out: EnrichedAlert[] = [];
  for (const it of items) {
    if (!it) continue;
    if (isAlertSnoozed(it.id, map, now)) continue;
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 一键执行 — action descriptor 计算
// ---------------------------------------------------------------------------

/**
 * 单 alert "一键执行" 的动作类型 — 与 derived_category 一一对应.
 *
 * 决策表 (与 [[deriveAlertCategoryFromMessage]] category 同源):
 *   - position   → 'open_position_review' : PortfolioWorkspace 已删，回当前 CatDesk 主入口
 *   - market     → 'open_risk_center'     : 独立风控页已删，回当前 CatDesk 主入口
 *   - individual → 'open_stock_detail'    : 跳 /stock/{symbol}
 *   - data       → 'open_data_center'     : 跳仍有效的 /workspace/data
 */
export type AlertActionType =
  | 'open_stock_detail'
  | 'open_position_review'
  | 'open_risk_center'
  | 'open_data_center';

/**
 * 一键执行 descriptor — caller 拿到后调 navigate(href) + 选择是否标记已读 / 自动 snooze.
 *
 * markReadOnAction: true (默认 true) 让 UI 在点击后顺手把 alert 标已读
 * (复用 markSingleRiskAlertRead). false 见 'individual' (跳详情后用户可能
 * 还需再看, 保留未读状态).
 */
export interface AlertActionDescriptor {
  /** 路由 href — react-router navigate(href) 直接消费. */
  href: string;
  /** 中文按钮文字 — UI 显在 Button 上. */
  label: string;
  /** ARIA / 单测 marker. */
  actionType: AlertActionType;
  /** 是否在跳转后自动 mark-read. */
  markReadOnAction: boolean;
}

/** category → 默认 label 文案 (UI Button text). 与 PRD "一键执行" 验收文案对齐. */
export const ALERT_ACTION_LABEL: Readonly<Record<DerivedAlertCategory, string>> = Object.freeze({
  position: '查看持仓',
  market: '打开风控中心',
  individual: '查看个股',
  data: '打开数据中心',
});

/**
 * symbol "看起来是合法 A 股代码" 的判定 — 用于 individual 分类时是否真能跳
 * /stock/{symbol}. 兜底: 不像合法代码 (如 'SYSTEM:...' / 空 / 带特殊字符)
 * 时降级为 CatDesk 主入口.
 *
 * 与 isValidSymbol (frontend/utils) 风格一致 — 6 位数字 / 600xxx 等 A 股
 * 通配, 也认 60xxxx.SH / 0xxxxx.SZ 后缀格式.
 */
export function looksLikeAShareSymbol(symbol: string | null | undefined): boolean {
  if (typeof symbol !== 'string') return false;
  const s = symbol.trim();
  if (!s) return false;
  // 排除已知系统前缀
  if (s.startsWith('SYSTEM:') || s.startsWith('DATA:')) return false;
  // 6 位数字 or 6 位数字.SH / 6 位数字.SZ / 6 位数字.BJ
  if (/^[0-9]{6}$/.test(s)) return true;
  if (/^[0-9]{6}\.(SH|SZ|BJ)$/i.test(s)) return true;
  return false;
}

/**
 * 计算 alert 的一键执行 descriptor.
 *
 * 决策表 (短路链):
 *   (1) category=='individual' AND symbol 合法 → 跳 /stock/{symbol}
 *   (2) category=='individual' AND symbol 不合法 → 降级到 CatDesk
 *   (3) category=='position' → /catdesk（独立 PortfolioWorkspace 已删）
 *   (4) category=='market'   → /catdesk（独立风控页已删）
 *   (5) category=='data'     → /workspace/data
 *   (6) 未知 category (理论上不会触发) → 兜底 /catdesk
 */
export function buildAlertActionDescriptor(alert: EnrichedAlert): AlertActionDescriptor {
  const cat: DerivedAlertCategory = alert.derived_category;
  if (cat === 'individual') {
    if (looksLikeAShareSymbol(alert.symbol)) {
      return {
        href: `/stock/${alert.symbol.trim()}`,
        label: ALERT_ACTION_LABEL.individual,
        actionType: 'open_stock_detail',
        // 跳到 /stock/ 详情, 用户大概率还要继续阅读历史告警, 不强制 mark-read.
        markReadOnAction: false,
      };
    }
    // 无法打开个股详情时降级到当前主入口。
    return {
      href: ALERTS_BELL_TARGET_PATH,
      label: ALERT_ACTION_LABEL.market,
      actionType: 'open_risk_center',
      markReadOnAction: true,
    };
  }
  if (cat === 'position') {
    return {
      href: ALERTS_BELL_TARGET_PATH,
      label: ALERT_ACTION_LABEL.position,
      actionType: 'open_position_review',
      markReadOnAction: true,
    };
  }
  if (cat === 'data') {
    return {
      href: '/workspace/data',
      label: ALERT_ACTION_LABEL.data,
      actionType: 'open_data_center',
      markReadOnAction: true,
    };
  }
  // market or unknown fallback
  return {
    href: ALERTS_BELL_TARGET_PATH,
    label: ALERT_ACTION_LABEL.market,
    actionType: 'open_risk_center',
    markReadOnAction: true,
  };
}

// ---------------------------------------------------------------------------
// 显示工具
// ---------------------------------------------------------------------------

/**
 * 把 snooze 剩余时间格式化成"还有 47 分钟" / "还有 2 小时" / "还有 3 天".
 *
 * 决策表 (从小到大返第一档命中):
 *   < 60s            → '即将解除'
 *   < 60min          → 'N 分钟后'
 *   < 24h            → 'N 小时后'
 *   else             → 'N 天后'
 *
 * 调用方: AlertItem snooze 状态 tooltip / Tag 文字. caller 已确认 snooze 仍 active
 * (until > now), 本函数不再做 active 判断.
 */
export function formatSnoozeRemaining(nowMs: number, untilMs: number): string {
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : 0;
  const until = typeof untilMs === 'number' && Number.isFinite(untilMs) ? untilMs : 0;
  const remainMs = Math.max(0, until - now);
  if (remainMs < 60 * 1000) return '即将解除';
  if (remainMs < 60 * 60 * 1000) {
    const min = Math.round(remainMs / (60 * 1000));
    return `${min} 分钟后解除`;
  }
  if (remainMs < 24 * 60 * 60 * 1000) {
    const hr = Math.round(remainMs / (60 * 60 * 1000));
    return `${hr} 小时后解除`;
  }
  const day = Math.round(remainMs / (24 * 60 * 60 * 1000));
  return `${day} 天后解除`;
}
