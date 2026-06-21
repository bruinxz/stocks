/**
 * US-068 [FE-029] SettingsWorkspace 待办建议 tab — 纯函数 helper.
 *
 * 把分散在 3 类后端数据里的"操盘手该看一下"事项, 聚合成统一 TodoItem[] 让 UI 一处显示:
 *
 *   1. **黑天鹅 (black-swan)** — 来自 `GET /api/risk-alerts?limit=50` 中未读的
 *      severity=HIGH/CRITICAL 风险告警 (BlackSwanWatchdog / RiskGuard fail-CLOSED
 *      触发). 操盘手最先要看的就是"系统刚捕到的黑天鹅".
 *   2. **偏差 (deviation)** — 来自 `GET /api/tasks/automation-health` 的 issues[]
 *      与 chains[].issues[] (cron 卡死 / queue 积压 / 任务失败 / schema 不健康).
 *      "事先约定的链路 vs 实际跑的链路" 之间的偏差.
 *   3. **改进 (improvement)** — 来自同 automation-health 的 `risk_limit_suggestion`
 *      (TaskAutomationHealthService 自动产出的风险阈值候选补丁) + `next_actions[]`
 *      (人写的下一步建议). 系统在告诉你"调一下这里会更好".
 *
 * 输出统一 TodoItem 结构 (id / category / priority / title / detail / source / action_hint),
 * UI 按 priority(critical→high→medium→low) + 时间倒序排序. 同 priority 内 category 顺序
 * black-swan → deviation → improvement (黑天鹅最先看).
 *
 * 设计 (沿用 [[shadowRunHelpers]] / [[dataWorkspaceTabHelpers]] 同款 "多维输入 → 统一 view model"):
 *   - 阈值常量全 export 便于 ops 调参 + 单测守 sanity;
 *   - 三类 builder 各自 pure function, 都接受 null/undefined/异常输入返 [];
 *   - 主入口 buildTodoSuggestionsViewModel({alerts, health}) 聚合三类 + 排序 + summary;
 *   - 无任何 React/antd 依赖, 单测在 backend/tests/risk/todo-suggestions-helpers.test.ts
 *     跨 monorepo ts-node --transpile-only 跑.
 *
 * 与 backend 解耦: 不新加 API, 只消费已有 /risk-alerts + /tasks/automation-health 两个
 * endpoint. 任何"加一类待办源"只需新增一个 buildXxxTodos pure function + 主入口拼一下.
 */

// ===========================================================================
// 类型定义
// ===========================================================================

/** 3 类 todo, 顺序固定 — 同 priority 内 black-swan 最先 (用户最在意) */
export type TodoCategory = 'black-swan' | 'deviation' | 'improvement';

/** 4 档 priority, 与 backend RiskAlert severity (critical/high/medium/low) 风格对齐 */
export type TodoPriority = 'critical' | 'high' | 'medium' | 'low';

/** 单条 todo 显示项, UI 直接 render — 不依赖 React */
export interface TodoItem {
  /** 用于 React key — 同 category 内唯一 */
  id: string;
  category: TodoCategory;
  priority: TodoPriority;
  /** 标题 (≤30 字) */
  title: string;
  /** 详细说明 (≤120 字), 多条可换行 */
  detail: string;
  /** 数据来源标签 (e.g. 'RiskAlert#123' / 'chain:trading-loop' / 'risk_limit_suggestion') */
  source: string;
  /** 推荐动作 (≤30 字), e.g. "处理告警" / "刷新链路" / "应用建议" */
  action_hint: string;
  /** 时间戳 (ISO 字符串), 用于同 priority 内倒序 — 可空 */
  occurred_at?: string;
}

/** 顶部 KPI summary — 一眼看出"还有几条 critical/high 待办" */
export interface TodoCountByCategory {
  black_swan: number;
  deviation: number;
  improvement: number;
}

export interface TodoCountByPriority {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface TodoSuggestionsViewModel {
  items: TodoItem[];
  total: number;
  by_category: TodoCountByCategory;
  by_priority: TodoCountByPriority;
  /** 是否有 critical 待办 — UI 用来决定顶部 Alert 颜色 (true=error / false=info) */
  has_critical: boolean;
}

// ===========================================================================
// 阈值常量 — 全 export 让单测守 sanity
// ===========================================================================

/** Title 最大显示字符 (超长截断, 与 US-043 AI_VIEW_MAX_CHARS 同款 5 件套思想) */
export const TODO_TITLE_MAX_CHARS = 30;
/** Detail 最大显示字符 */
export const TODO_DETAIL_MAX_CHARS = 120;
/** Action hint 最大显示字符 */
export const TODO_ACTION_HINT_MAX_CHARS = 30;

/** Category 显示顺序 (同 priority 内) — black-swan 最先, 改顺序会影响 UI tie-break */
export const TODO_CATEGORY_ORDER: ReadonlyArray<TodoCategory> = Object.freeze([
  'black-swan',
  'deviation',
  'improvement',
]);

/** Priority 显示顺序 — critical 最先 */
export const TODO_PRIORITY_ORDER: ReadonlyArray<TodoPriority> = Object.freeze([
  'critical',
  'high',
  'medium',
  'low',
]);

/** Category Tag 颜色 (antd Tag color token) */
export const TODO_CATEGORY_COLOR: Readonly<Record<TodoCategory, string>> = Object.freeze({
  'black-swan': 'red', // 最严重: 系统刚抓到的黑天鹅
  deviation: 'orange', // 偏差: 链路出了问题
  improvement: 'blue', // 改进: 系统建议的优化
});

/** Category 显示标签 */
export const TODO_CATEGORY_LABEL: Readonly<Record<TodoCategory, string>> = Object.freeze({
  'black-swan': '黑天鹅',
  deviation: '偏差',
  improvement: '改进',
});

/** Priority Tag 颜色 */
export const TODO_PRIORITY_COLOR: Readonly<Record<TodoPriority, string>> = Object.freeze({
  critical: 'red',
  high: 'volcano',
  medium: 'gold',
  low: 'default',
});

/** Priority 显示标签 */
export const TODO_PRIORITY_LABEL: Readonly<Record<TodoPriority, string>> = Object.freeze({
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
});

// ===========================================================================
// 输入接口 — 与 backend response 对齐 (loose type 让 caller 直接传 response.data)
// ===========================================================================

/** Backend RiskAlert (subset — 只用我们关心的字段) */
export interface RiskAlertInput {
  id?: number | string;
  level?: string; // HIGH / MEDIUM / LOW / CRITICAL (后端有 LOW→medium 兼容)
  rule_id?: string;
  message?: string;
  is_read?: boolean;
  triggered_at?: string;
  created_at?: string;
  metadata?: Record<string, any>;
}

/** Backend AutomationHealthIssue (subset) */
export interface AutomationHealthIssueInput {
  level?: 'warning' | 'critical' | string;
  message?: string;
  task_name?: string;
  code?: string;
}

/** Backend AutomationHealth response (subset) */
export interface AutomationHealthInput {
  status?: 'healthy' | 'warning' | 'critical' | string;
  issues?: AutomationHealthIssueInput[];
  chains?: Array<{
    key?: string;
    title?: string;
    status?: 'healthy' | 'warning' | 'critical' | string;
    issues?: AutomationHealthIssueInput[];
  }>;
  next_actions?: string[];
  risk_limit_suggestion?: {
    action?: string; // observe / apply / pause
    reason?: string;
    limits?: Record<string, any>;
    stability?: {
      can_apply?: boolean;
      label?: string;
      reason?: string;
      consecutive_same_action?: number;
    };
    generated_at?: string | null;
  } | null;
}

// ===========================================================================
// pure helpers — 截断 / 时间归一化
// ===========================================================================

/** 截断字符串到 max 字符 (含最后的 '…'); 空字符串返空 */
export function truncateText(text: string | null | undefined, max: number): string {
  if (text == null) return '';
  const s = String(text);
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + '…';
}

/** 把后端 level 字符串 (HIGH/CRITICAL/MEDIUM/LOW/warning/critical) 归一到 TodoPriority */
export function normalizeAlertLevelToPriority(level: string | null | undefined): TodoPriority {
  if (typeof level !== 'string') return 'medium';
  const s = level.trim().toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'medium' || s === 'warning' || s === 'warn') return 'medium';
  if (s === 'low' || s === 'info') return 'low';
  // 未识别 fallback medium (不上推到 critical, 与 [[US-029 priority 决策表 safe-default low 兜底]]
  // 同款"fail-safe 偏低不偏高"原则的轻量版 — alert 至少给 medium 不被忽略).
  return 'medium';
}

/** 安全取 ISO 时间, 非法/空返 undefined */
export function pickOccurredAt(a: RiskAlertInput): string | undefined {
  const v = a.triggered_at || a.created_at;
  if (typeof v !== 'string' || !v) return undefined;
  return v;
}

// ===========================================================================
// 3 类 builder — 都接受异常输入返 []
// ===========================================================================

/**
 * 从 risk-alerts 列表里筛出 "需要操盘手立即看的黑天鹅类待办":
 *   - 未读 (is_read !== true)
 *   - priority ≥ medium (LOW 不上待办列表, 用户在 AlertsBell 里看)
 *
 * 截断 title/detail 到 cap. 一条 alert → 一条 TodoItem.
 */
export function buildBlackSwanTodos(alerts: RiskAlertInput[] | null | undefined): TodoItem[] {
  if (!Array.isArray(alerts)) return [];
  const out: TodoItem[] = [];
  for (const a of alerts) {
    if (!a || typeof a !== 'object') continue;
    if (a.is_read === true) continue;
    const priority = normalizeAlertLevelToPriority(a.level);
    if (priority === 'low') continue; // low 不进待办

    const rule = typeof a.rule_id === 'string' && a.rule_id ? a.rule_id : '风险告警';
    const message = typeof a.message === 'string' && a.message ? a.message : '(无消息体)';
    out.push({
      id: `black-swan:${a.id ?? rule}-${a.triggered_at ?? a.created_at ?? ''}`,
      category: 'black-swan',
      priority,
      title: truncateText(`[${rule}] ${message}`, TODO_TITLE_MAX_CHARS),
      detail: truncateText(message, TODO_DETAIL_MAX_CHARS),
      source: `RiskAlert#${a.id ?? '?'}`,
      action_hint: truncateText('查看告警 → 处理 / 标记已读', TODO_ACTION_HINT_MAX_CHARS),
      occurred_at: pickOccurredAt(a),
    });
  }
  return out;
}

/**
 * 从 automation-health 的 issues 拼"偏差类待办":
 *   - 顶层 issues[] + 各 chain.issues[] 全拍平
 *   - level=critical → priority=critical, level=warning → priority=high
 *     (warning 在 ops 视角里其实算"高优待办", 不是 medium — 因为是关键链路报警)
 *
 * 同 code+task_name dedup (避免顶层 issues 与 chain issues 重复同条 issue).
 */
export function buildDeviationTodos(health: AutomationHealthInput | null | undefined): TodoItem[] {
  if (!health || typeof health !== 'object') return [];
  const out: TodoItem[] = [];
  const seen = new Set<string>();

  const pushOne = (
    issue: AutomationHealthIssueInput | null | undefined,
    chainTitle?: string
  ): void => {
    if (!issue || typeof issue !== 'object') return;
    const level = typeof issue.level === 'string' ? issue.level.toLowerCase() : '';
    let priority: TodoPriority;
    if (level === 'critical') priority = 'critical';
    else if (level === 'warning' || level === 'warn') priority = 'high';
    else priority = 'medium';

    const code = typeof issue.code === 'string' && issue.code ? issue.code : 'issue';
    const task = typeof issue.task_name === 'string' ? issue.task_name : '';
    const dedupKey = `${code}|${task}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);

    const baseMsg =
      typeof issue.message === 'string' && issue.message ? issue.message : `偏差 ${code}`;
    const titlePrefix = chainTitle ? `[${chainTitle}] ` : '';
    out.push({
      id: `deviation:${dedupKey}`,
      category: 'deviation',
      priority,
      title: truncateText(titlePrefix + baseMsg, TODO_TITLE_MAX_CHARS),
      detail: truncateText(baseMsg + (task ? ` (任务: ${task})` : ''), TODO_DETAIL_MAX_CHARS),
      source: chainTitle ? `chain:${chainTitle}` : `automation-health:${code}`,
      action_hint: truncateText('刷新链路或排查 cron', TODO_ACTION_HINT_MAX_CHARS),
    });
  };

  if (Array.isArray(health.issues)) {
    for (const issue of health.issues) pushOne(issue);
  }
  if (Array.isArray(health.chains)) {
    for (const chain of health.chains) {
      if (!chain || typeof chain !== 'object') continue;
      if (!Array.isArray(chain.issues)) continue;
      for (const issue of chain.issues) {
        pushOne(issue, typeof chain.title === 'string' ? chain.title : undefined);
      }
    }
  }
  return out;
}

/**
 * 从 automation-health 拼"改进类待办":
 *   - risk_limit_suggestion (TaskAutomationHealthService 自动产出的阈值候选补丁):
 *     stability.can_apply === true → 'high' priority "建议应用",
 *     action === 'observe' → 'low' priority "继续观察",
 *     其它 / null → 跳过 (无建议时不展示).
 *   - next_actions[]: 每条文字 → 'medium' priority (人写的下一步建议).
 */
export function buildImprovementTodos(
  health: AutomationHealthInput | null | undefined
): TodoItem[] {
  if (!health || typeof health !== 'object') return [];
  const out: TodoItem[] = [];

  const rs = health.risk_limit_suggestion;
  if (rs && typeof rs === 'object') {
    const action = typeof rs.action === 'string' ? rs.action.toLowerCase() : '';
    const canApply = rs.stability?.can_apply === true;
    const reason = typeof rs.reason === 'string' ? rs.reason : '';
    if (canApply || action === 'apply') {
      out.push({
        id: 'improvement:risk_limit_suggestion_apply',
        category: 'improvement',
        priority: 'high',
        title: truncateText('风险阈值建议: 可应用', TODO_TITLE_MAX_CHARS),
        detail: truncateText(
          reason || '已检测到稳定的风险阈值候选补丁, 可一键预览/应用',
          TODO_DETAIL_MAX_CHARS
        ),
        source: 'risk_limit_suggestion',
        action_hint: truncateText('打开任务设置 → 应用建议', TODO_ACTION_HINT_MAX_CHARS),
        occurred_at: rs.generated_at || undefined,
      });
    } else if (action === 'observe') {
      out.push({
        id: 'improvement:risk_limit_suggestion_observe',
        category: 'improvement',
        priority: 'low',
        title: truncateText('风险阈值建议: 继续观察', TODO_TITLE_MAX_CHARS),
        detail: truncateText(
          reason || '阈值候选稳定性不足, 继续累积样本 (无需操作)',
          TODO_DETAIL_MAX_CHARS
        ),
        source: 'risk_limit_suggestion',
        action_hint: truncateText('无需操作 — 等样本', TODO_ACTION_HINT_MAX_CHARS),
        occurred_at: rs.generated_at || undefined,
      });
    }
    // action='pause' / unknown 静默跳过 — 没必要扰乱 UI
  }

  if (Array.isArray(health.next_actions)) {
    health.next_actions.forEach((text, idx) => {
      if (typeof text !== 'string' || !text.trim()) return;
      out.push({
        id: `improvement:next_action_${idx}`,
        category: 'improvement',
        priority: 'medium',
        title: truncateText(text, TODO_TITLE_MAX_CHARS),
        detail: truncateText(text, TODO_DETAIL_MAX_CHARS),
        source: `next_actions[${idx}]`,
        action_hint: truncateText('查看建议', TODO_ACTION_HINT_MAX_CHARS),
      });
    });
  }

  return out;
}

// ===========================================================================
// 主入口 — 聚合 3 类 + 排序 + summary
// ===========================================================================

const PRIORITY_RANK: Record<TodoPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const CATEGORY_RANK: Record<TodoCategory, number> = {
  'black-swan': 0,
  deviation: 1,
  improvement: 2,
};

/**
 * 排序: priority (critical→low) → category (black-swan→improvement) → occurred_at 倒序 → id 字母序.
 *
 * id 字母序兜底是 React key 稳定 + tie 可预期的关键 — 与 [[todayPlanHelpers]] / [[todaySellHelpers]]
 * 同款"3 段稳定 + 字母序兜底"思想.
 */
function compareTodo(a: TodoItem, b: TodoItem): number {
  const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (pr !== 0) return pr;
  const cr = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
  if (cr !== 0) return cr;
  // occurred_at 倒序 — 新发生的在前. 空值排最后.
  const at = a.occurred_at || '';
  const bt = b.occurred_at || '';
  if (at && bt) {
    if (at > bt) return -1;
    if (at < bt) return 1;
  } else if (at && !bt) {
    return -1;
  } else if (!at && bt) {
    return 1;
  }
  // id 字母序
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** 输入 — caller 同时传 risk-alerts 与 automation-health 两路 response */
export interface BuildTodoSuggestionsInput {
  alerts: RiskAlertInput[] | null | undefined;
  health: AutomationHealthInput | null | undefined;
}

/**
 * 主入口 — null / undefined / 异常输入返 0 条 + 0 计数 view model. 同 input 永远同输出 →
 * UI 端 useMemo 安全, 不依赖 React render path (与 [[todayPlanHelpers]] 同款契约).
 */
export function buildTodoSuggestionsViewModel(
  input: BuildTodoSuggestionsInput | null | undefined
): TodoSuggestionsViewModel {
  const bs = input ? buildBlackSwanTodos(input.alerts) : [];
  const dv = input ? buildDeviationTodos(input.health) : [];
  const im = input ? buildImprovementTodos(input.health) : [];
  const items = [...bs, ...dv, ...im].sort(compareTodo);

  const by_category: TodoCountByCategory = {
    black_swan: bs.length,
    deviation: dv.length,
    improvement: im.length,
  };
  const by_priority: TodoCountByPriority = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const t of items) by_priority[t.priority] += 1;

  return {
    items,
    total: items.length,
    by_category,
    by_priority,
    has_critical: by_priority.critical > 0,
  };
}
