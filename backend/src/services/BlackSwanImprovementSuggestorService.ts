/**
 * BlackSwanImprovementSuggestorService — L4-Portfolio + Risk / US-105 [PR-016]
 * 黑天鹅复盘 4 类短板归类 + 模板建议生成 (improvement_suggestions 段)
 *
 * 4 段中第 4 段 (最后一段), 接力 PR-013 BlackSwanPostmortemService + PR-014
 * CounterfactualBaselineCalculator + PR-015 EventTimelineReplayer 后填. 主入口
 * cron `BLACK_SWAN_IMPROVEMENT` 每 30min 扫最近 24h status='partial' 且
 * metadata.sections_filled 不含 'improvement_suggestions' 的 BlackSwanPostmortemReport,
 * 对每行从已填段 (event_summary + counterfactual_baselines + event_timeline) 启发式
 * 归类 4 类短板, 套模板生成建议, UPSERT 仅覆盖 improvement_suggestions 段 +
 * metadata.sections_filled 累加 (其它 JSONB 段不出现在 payload 里, sequelize 不动
 * 它们 — 与 [[多段 JSONB 报告分阶段 UPSERT]] 同款).
 *
 * ============================================================================
 * 4 类短板归类 (来自 PRD US-105 AC + docs/trader-system/75_black_swan_postmortem.md)
 * ============================================================================
 *   - detection      — 信号未及时检出: 检出延迟过长 / event 触发瞬间前 N 天无 risk_alert
 *                      / lookback 窗口内 alert 全是 low → 阈值/频率/数据源缺失;
 *   - response       — 检出后响应慢: 有 high/critical alert 但 watchdog_trigger=0 或
 *                      触发间隔过长 → 告警未触发 / 触发后 ops 未跟进;
 *   - execution      — 响应后执行失败: zero baseline 远好于 actual / plan baseline 跑赢
 *                      actual 但实际未止损 → 订单失败 / 滑点 / 流动性不足;
 *   - risk_control   — 风控配置欠缺: actual 跑输 zero baseline 太多 / max_drawdown 突破
 *                      合理阈值 → 止损位 / 集中度 / 对冲缺失.
 *
 * 每类至多生成 1 条 suggestion (避免 ops 看板被噪声淹没); top_findings[] 按 priority
 * 取 ≤5. priority 0..100, 由本段触发原因强度决定 (e.g. drawdown 越深 priority 越高).
 *
 * ============================================================================
 * 调用方式 (cron 30min 巡)
 * ============================================================================
 *   - cron: `runBlackSwanImprovementSuggestorService(getProductionSuggestorRunner(), {})`;
 *   - 默认扫最近 24h detected 的 event 对应 partial postmortem (lookback_hours=24);
 *     already-filled (sections_filled 含 'improvement_suggestions') 走 skip 不重算;
 *   - dry_run=true → 仅返"会处理几条 partial postmortem"预演, 不调 upsert;
 *   - event_id (debug) → 仅处理指定事件 id 的 postmortem;
 *   - top_findings_cap (默认 5) 控制 top_findings[] 长度.
 *
 * ============================================================================
 * fail-OPEN (与 PR-013/014/015 同款)
 * ============================================================================
 *   - loadCandidates throw → 整次 service 返 success=false + error +
 *     candidates_total=0;
 *   - 单事件 engine throw → reports_failed +1 但不抛, 整体 success=true;
 *   - section.suggestions.length === 0 → skipped reason='no_suggestions'
 *     (e.g. 前 3 段全空时无可挖掘信号);
 *   - upsert throw → reports_failed +1 但不抛, 整体 success=true.
 *
 * ============================================================================
 * idempotent (30min 重跑同事件不会双填)
 * ============================================================================
 *   - 候选过滤 = metadata.sections_filled 不含 'improvement_suggestions'; 已填 skip;
 *   - 即使强制重跑 (event_id), upsert payload 只含本段, 不擦其它段;
 *   - sections_filled 累加用 array union (set 语义) 不重复;
 *   - status 升级: 4 段中已填 == 4 时升 'ok', 否则保持 'partial' (与 PR-014/015
 *     decidePostmortemStatus 同款逻辑) — 本 service 作为最后一段, 多数情况会升 'ok'.
 *
 * ============================================================================
 * SchedulerService 接入
 * ============================================================================
 *   `cronRegistry.ts`: type='BLACK_SWAN_IMPROVEMENT', recommendedCron='43,13 * * * *'
 *   (与 BLACK_SWAN_TIMELINE '33,3' 错峰 10min, 让 PR-015 先填 event_timeline →
 *   本 service 再补 improvement_suggestions, 让 cron 跑顺序与段间依赖匹配:
 *   13,43 postmortem → 23,53 baseline → 33,3 timeline →
 *   43,13 improvement).
 *
 * 注意: BLACK_SWAN_POSTMORTEM 也用 13,43 (主入口 + 本段第二轮). 二者错峰 60min 内
 * 不冲突 — cron tick 各取所需 — postmortem 主入口在小时分 13/43, improvement 在
 * 小时分 43/13 (= 同一时刻!). 改为 43,13 是为了让 improvement 在 postmortem 之前
 * 的"上半小时尾巴"消费, 不会与 postmortem 同 tick. 实际值为 '43,13 * * * *' 即
 * 每小时 13 分 + 43 分; 与 postmortem (13,43) 重合 → 实际改用 '43,28 * * * *'?
 * 不必 — postmortem 主入口针对未生成报告的 event, improvement 针对已存在 partial
 * 报告, 两者写不同段, payload 不冲突. 选 43,13 是因为 13 分 timeline 才刚填完
 * (timeline=33), improvement (43) 就接力填本段, 错峰 10min. 13 分填 improvement
 * 是 30min 后的第二轮 tick — 任何漏跑的 event 都能在下一次被处理.
 */

import { logger } from '../utils/logger';

// ============================================================================
// Types (engine input/output)
// ============================================================================

/** 4 类短板枚举 — 与 PRD US-105 AC 对齐. */
export type ImprovementCategory = 'detection' | 'response' | 'execution' | 'risk_control';

/** 4 类短板冻结集合 — 用于校验. */
export const IMPROVEMENT_CATEGORIES = Object.freeze<readonly ImprovementCategory[]>([
  'detection',
  'response',
  'execution',
  'risk_control',
]);

/**
 * 单条改进建议 — 与 BlackSwanPostmortemReport.improvement_suggestions.suggestions[]
 * 对齐.
 */
export interface ImprovementSuggestion {
  category: ImprovementCategory;
  key: string;
  title: string;
  body: string;
  priority: number; // 0..100
  template_id: string;
  evidence: {
    sample_event_ids?: number[];
    metric?: Record<string, unknown>;
  };
  action?: {
    type: 'noop' | 'tune_risk_param' | 'open_workspace_tab' | 'review_alert_threshold';
    payload: Record<string, unknown>;
  };
}

/** improvement_suggestions JSONB 段 (4 段第 4 段) */
export interface ImprovementSuggestionsSection {
  suggestions: ImprovementSuggestion[];
  top_findings: ImprovementSuggestion[];
  suggestor_version: string;
  meta: {
    event_detected_at: string;
    sources_used: string[];
    suggestions_total: number;
    top_findings_cap: number;
  };
}

/**
 * 前 3 段输入 snapshot — 本 service 真读的字段子集 (从 PR-013/014/015 各自填的段
 * 抽出).
 */
export interface PostmortemSectionsSnapshot {
  /** 来自 PR-013 event_summary */
  event_summary?: {
    event_type?: string;
    severity?: string;
    scope?: string;
    symbol?: string | null;
    detected_at?: string;
    resolved_at?: string | null;
    duration_minutes?: number | null;
    linked_risk_alert_ids?: number[];
  } | null;

  /** 来自 PR-014 counterfactual_baselines */
  counterfactual_baselines?: {
    baselines?: Array<{
      type?: 'hold' | 'zero' | 'plan' | 'perfect';
      pnl?: number;
      pnl_pct?: number;
      max_drawdown?: number;
    }>;
    actual?: {
      pnl?: number;
      pnl_pct?: number;
      max_drawdown?: number;
    };
  } | null;

  /** 来自 PR-015 event_timeline */
  event_timeline?: {
    timeline?: Array<{
      ts?: string;
      type?: string;
      severity?: 'low' | 'medium' | 'high' | 'critical';
    }>;
    alert_count_by_level?: {
      low?: number;
      medium?: number;
      high?: number;
      critical?: number;
    };
  } | null;
}

/** engine 主入口 input. */
export interface BuildImprovementSuggestionsInput {
  event_detected_at: Date;
  black_swan_event_id: number;
  sections: PostmortemSectionsSnapshot;
  top_findings_cap?: number;
}

/** PR-013/014/015 已生成的 partial postmortem snapshot (本 service 候选输入). */
export interface PartialPostmortemSnapshot {
  id: number;
  black_swan_event_id: number;
  event_detected_at: Date;
  current_metadata: Record<string, unknown>;
  current_status: string;
  sections: PostmortemSectionsSnapshot;
}

/** UPSERT payload — 只列 improvement_suggestions + metadata + status + reason + generated_at. */
export interface ImprovementReportUpdateRow {
  id: number;
  improvement_suggestions: ImprovementSuggestionsSection;
  metadata: Record<string, unknown>;
  status: string;
  reason: string | null;
  generated_at: Date;
}

/** runBlackSwanImprovementSuggestorService 主返值. */
export interface ImprovementSuggestorResult {
  success: boolean;
  dry_run: boolean;
  candidates_total: number;
  reports_updated: number;
  reports_failed: number;
  reports_skipped: number;
  error?: string;
  generated_at_iso: string;
}

/** 调用选项. */
export interface RunImprovementSuggestorOptions {
  dry_run?: boolean;
  event_id?: number;
  lookback_hours?: number;
  top_findings_cap?: number;
  generated_at?: Date;
  metadata?: Record<string, unknown>;
}

/** SuggestorRunner — DI 接口. */
export interface SuggestorRunner {
  /**
   * 拉取候选 partial postmortem (status='partial' AND sections_filled 不含
   * 'improvement_suggestions'). 永不 throw — 失败返 ok:false.
   */
  loadCandidates(input: {
    asOf: Date;
    lookback_hours: number;
    event_id?: number;
  }): Promise<{ ok: true; candidates: PartialPostmortemSnapshot[] } | { ok: false; error: string }>;

  /**
   * UPDATE 一行 postmortem 仅覆盖 improvement_suggestions 段 + metadata + status.
   * 失败返 ok:false (不抛, 本服务统一走 fail-OPEN 累计).
   */
  updateReport(
    row: ImprovementReportUpdateRow
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

// ============================================================================
// 常量
// ============================================================================

/** cron 推荐表达式 — 与 BLACK_SWAN_TIMELINE '33,3' 错峰 10min. */
export const BLACK_SWAN_IMPROVEMENT_RECOMMENDED_CRON = '43,13 * * * *';

/** 默认 lookback (扫 partial postmortem 的回溯小时数). */
export const BLACK_SWAN_IMPROVEMENT_DEFAULT_LOOKBACK_HOURS = 24;

/** top_findings[] 默认 cap. */
export const BLACK_SWAN_IMPROVEMENT_DEFAULT_TOP_FINDINGS_CAP = 5;

/** suggestor 版本号 (debug 用). */
export const BLACK_SWAN_IMPROVEMENT_SUGGESTOR_VERSION = 'PR-016/v1';

/**
 * detection 类阈值: event 触发前 alert_count_by_level high+critical < 此值 →
 * 视为"信号未及时检出". 默认 1 (一条都没 → 明确缺检出).
 */
export const DETECTION_LOW_ALERT_THRESHOLD = 1;

/**
 * response 类阈值: high+critical alert 已发 ≥ 此值 但 watchdog_trigger=0 → 视为
 * "检出后响应慢" (告警在但 BlackSwanWatchdog 未真触发).
 */
export const RESPONSE_HIGH_ALERT_THRESHOLD = 2;

/**
 * execution 类阈值: zero baseline pnl_pct - actual pnl_pct >= 此值 → 视为
 * "响应后执行失败" (zero baseline 远好于 actual, 说明该止损但没止住).
 */
export const EXECUTION_PNL_GAP_THRESHOLD = 0.03; // 3%

/**
 * risk_control 类阈值: actual max_drawdown 突破此绝对值 → 视为"风控配置欠缺".
 */
export const RISK_CONTROL_DRAWDOWN_THRESHOLD = 0.1; // 10%

/** 4 段 sections_filled 集合 — 用于决定 status 升级 'ok'. */
export const ALL_POSTMORTEM_SECTIONS = Object.freeze([
  'event_summary',
  'counterfactual_baselines',
  'event_timeline',
  'improvement_suggestions',
] as const);

const SECTION_KEY = 'improvement_suggestions';

// ============================================================================
// 纯函数 helpers (engine — 全 export 便于单测)
// ============================================================================

/** 安全数值 — 非有限数返 fallback (fail-safe). */
export function safeNum(n: unknown, fallback = 0): number {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/** priority clamp 到 0..100 区间 (整数). */
export function clampPriority(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p)));
}

/**
 * 从 alert_count_by_level 聚合 high+critical 数 (本 service 短板判定主指标).
 */
export function countHighSeverity(
  counts: PostmortemSectionsSnapshot['event_timeline'] extends infer T
    ? T extends { alert_count_by_level?: infer C }
      ? C
      : never
    : never
): number {
  if (!counts || typeof counts !== 'object') return 0;
  const c = counts as { high?: number; critical?: number };
  return safeNum(c.high, 0) + safeNum(c.critical, 0);
}

/**
 * 数 timeline 中 watchdog_trigger 类型条目数 (response 类判定).
 */
export function countWatchdogTriggers(
  timeline: NonNullable<PostmortemSectionsSnapshot['event_timeline']>['timeline']
): number {
  if (!Array.isArray(timeline)) return 0;
  let n = 0;
  for (const it of timeline) {
    if (it && it.type === 'watchdog_trigger') n += 1;
  }
  return n;
}

/**
 * 找特定 type 的 baseline (e.g. 'zero' / 'plan' / 'perfect' / 'hold').
 * 找不到返 null.
 */
export function findBaseline(
  baselines: NonNullable<PostmortemSectionsSnapshot['counterfactual_baselines']>['baselines'],
  type: 'hold' | 'zero' | 'plan' | 'perfect'
): { pnl_pct: number; max_drawdown: number } | null {
  if (!Array.isArray(baselines)) return null;
  for (const b of baselines) {
    if (b && b.type === type) {
      return {
        pnl_pct: safeNum(b.pnl_pct, 0),
        max_drawdown: safeNum(b.max_drawdown, 0),
      };
    }
  }
  return null;
}

// ============================================================================
// 4 类短板判定 + 模板建议
// (每个 detector 返 ImprovementSuggestion | null; 不命中返 null)
// ============================================================================

/**
 * detection 类: event 触发前 lookback 内 alert_count_by_level high+critical <
 * DETECTION_LOW_ALERT_THRESHOLD → 信号未及时检出.
 *
 * priority 公式: base 50 + (THRESHOLD - actual) * 25 (差越大优先级越高), clamp 0..100.
 *
 * action.type='review_alert_threshold' → 引导 ops 检查阈值/数据源.
 */
export function detectDetectionShortfall(
  input: BuildImprovementSuggestionsInput
): ImprovementSuggestion | null {
  const tl = input.sections.event_timeline;
  if (!tl) return null; // PR-015 还没填 → 无法判定本类
  const high = countHighSeverity(tl.alert_count_by_level);
  if (high >= DETECTION_LOW_ALERT_THRESHOLD) return null;

  const evSummary = input.sections.event_summary || {};
  const symbol = evSummary.symbol || null;
  const eventType = evSummary.event_type || 'unknown';
  const priority = clampPriority(50 + (DETECTION_LOW_ALERT_THRESHOLD - high) * 25);

  return {
    category: 'detection',
    key: 'late_or_missing_detection',
    title: `信号未及时检出: ${eventType}${symbol ? ` (${symbol})` : ''}`,
    body:
      `事件触发前回溯窗口内 high+critical 级 RiskAlert 计数=${high} ` +
      `(阈值 ${DETECTION_LOW_ALERT_THRESHOLD}). 建议: (1) 检查对应 detector cron ` +
      `频率与阈值, (2) 确认上游数据源 (公告/盘口/指数) 健康, ` +
      `(3) 必要时下调告警阈值或缩短巡逻周期.`,
    priority,
    template_id: 'detection.v1.late_or_missing_detection',
    evidence: {
      sample_event_ids: [input.black_swan_event_id],
      metric: {
        high_critical_alert_count: high,
        threshold: DETECTION_LOW_ALERT_THRESHOLD,
      },
    },
    action: {
      type: 'review_alert_threshold',
      payload: {
        event_type: eventType,
        symbol,
        observed_high_critical: high,
      },
    },
  };
}

/**
 * response 类: high+critical alert ≥ RESPONSE_HIGH_ALERT_THRESHOLD 但 timeline 中
 * watchdog_trigger=0 → 告警发了但 BlackSwanWatchdog 没触发 (ops 响应慢).
 *
 * priority: base 55 + min(40, high*5) clamp 0..100.
 */
export function detectResponseShortfall(
  input: BuildImprovementSuggestionsInput
): ImprovementSuggestion | null {
  const tl = input.sections.event_timeline;
  if (!tl) return null;
  const high = countHighSeverity(tl.alert_count_by_level);
  const watchdogs = countWatchdogTriggers(tl.timeline);
  if (high < RESPONSE_HIGH_ALERT_THRESHOLD) return null;
  if (watchdogs > 0) return null;

  const evSummary = input.sections.event_summary || {};
  const symbol = evSummary.symbol || null;
  const eventType = evSummary.event_type || 'unknown';
  const priority = clampPriority(55 + Math.min(40, high * 5));

  return {
    category: 'response',
    key: 'alert_without_watchdog_trigger',
    title: `检出后响应慢: ${eventType}${symbol ? ` (${symbol})` : ''}`,
    body:
      `事件期间累计 high+critical RiskAlert ${high} 条但 BlackSwanWatchdog ` +
      `watchdog_trigger=0. 建议: (1) 检查 BlackSwanWatchdog rule_id ` +
      `配置是否覆盖此 event_type, (2) ops 飞书/IM 通道健康度回测, ` +
      `(3) 高级时段值班响应 SLA 量化.`,
    priority,
    template_id: 'response.v1.alert_without_watchdog_trigger',
    evidence: {
      sample_event_ids: [input.black_swan_event_id],
      metric: {
        high_critical_alert_count: high,
        watchdog_trigger_count: watchdogs,
      },
    },
    action: {
      type: 'open_workspace_tab',
      payload: {
        tab: 'risk-alerts',
        event_id: input.black_swan_event_id,
      },
    },
  };
}

/**
 * execution 类: zero baseline pnl_pct - actual pnl_pct >= EXECUTION_PNL_GAP_THRESHOLD
 * → 该止损但没止住 (执行失败 / 滑点 / 流动性不足).
 *
 * priority: base 60 + min(35, gap*1000) clamp 0..100. (gap 单位是小数, e.g. 0.05
 * = 5% → +35; gap=0.10 → +100 clip 至 95.)
 */
export function detectExecutionShortfall(
  input: BuildImprovementSuggestionsInput
): ImprovementSuggestion | null {
  const cb = input.sections.counterfactual_baselines;
  if (!cb) return null;
  const zero = findBaseline(cb.baselines, 'zero');
  if (!zero) return null;
  const actual = cb.actual;
  if (!actual) return null;
  const actualPnlPct = safeNum(actual.pnl_pct, 0);
  const zeroPnlPct = zero.pnl_pct;
  const gap = zeroPnlPct - actualPnlPct;
  if (gap < EXECUTION_PNL_GAP_THRESHOLD) return null;

  const evSummary = input.sections.event_summary || {};
  const symbol = evSummary.symbol || null;
  const priority = clampPriority(60 + Math.min(35, gap * 1000));

  return {
    category: 'execution',
    key: 'failed_to_cut_losses',
    title: `响应后执行失败: ${symbol || 'portfolio'}`,
    body:
      `实际 pnl_pct=${actualPnlPct.toFixed(4)} vs zero baseline ` +
      `(瞬间清仓) pnl_pct=${zeroPnlPct.toFixed(4)}, 差值 ${(gap * 100).toFixed(2)}% ` +
      `≥ 阈值 ${(EXECUTION_PNL_GAP_THRESHOLD * 100).toFixed(2)}%. 建议: ` +
      `(1) 检查事件期间订单失败记录与滑点统计, (2) 评估 emergency_sell 路径覆盖度, ` +
      `(3) 流动性预算与 maker/taker 策略复盘.`,
    priority,
    template_id: 'execution.v1.failed_to_cut_losses',
    evidence: {
      sample_event_ids: [input.black_swan_event_id],
      metric: {
        actual_pnl_pct: actualPnlPct,
        zero_baseline_pnl_pct: zeroPnlPct,
        gap_pct: gap,
        threshold_pct: EXECUTION_PNL_GAP_THRESHOLD,
      },
    },
    action: {
      type: 'open_workspace_tab',
      payload: {
        tab: 'executions',
        event_id: input.black_swan_event_id,
      },
    },
  };
}

/**
 * risk_control 类: actual max_drawdown 绝对值 >= RISK_CONTROL_DRAWDOWN_THRESHOLD
 * → 风控配置欠缺 (止损位/集中度/对冲不足).
 *
 * priority: base 65 + min(30, dd*200) clamp 0..100. (dd 单位是小数, e.g. 0.15
 * = 15% → +30 满档.)
 */
export function detectRiskControlShortfall(
  input: BuildImprovementSuggestionsInput
): ImprovementSuggestion | null {
  const cb = input.sections.counterfactual_baselines;
  if (!cb || !cb.actual) return null;
  const dd = Math.abs(safeNum(cb.actual.max_drawdown, 0));
  if (dd < RISK_CONTROL_DRAWDOWN_THRESHOLD) return null;

  const evSummary = input.sections.event_summary || {};
  const symbol = evSummary.symbol || null;
  const priority = clampPriority(65 + Math.min(30, dd * 200));

  return {
    category: 'risk_control',
    key: 'drawdown_exceeds_threshold',
    title: `风控配置欠缺: ${symbol || 'portfolio'} 回撤 ${(dd * 100).toFixed(2)}%`,
    body:
      `实际 max_drawdown=${(dd * 100).toFixed(2)}% ≥ 阈值 ` +
      `${(RISK_CONTROL_DRAWDOWN_THRESHOLD * 100).toFixed(2)}%. 建议: ` +
      `(1) 收紧 per_stock_stop_loss.default_pct, (2) 引入集中度上限 ` +
      `(单 symbol/sector 仓位比), (3) 评估对冲工具 (index put / inverse ETF) 接入.`,
    priority,
    template_id: 'risk_control.v1.drawdown_exceeds_threshold',
    evidence: {
      sample_event_ids: [input.black_swan_event_id],
      metric: {
        actual_max_drawdown: dd,
        threshold: RISK_CONTROL_DRAWDOWN_THRESHOLD,
      },
    },
    action: {
      type: 'tune_risk_param',
      payload: {
        param: 'per_stock_stop_loss.default_pct',
        current_drawdown: dd,
      },
    },
  };
}

/**
 * 按 priority desc 排序 suggestions; priority 相同时按 category 字典序兜底 (稳定).
 * 不 mutate 输入.
 */
export function sortByPriority(
  suggestions: readonly ImprovementSuggestion[]
): ImprovementSuggestion[] {
  const sorted = suggestions.slice();
  sorted.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.category.localeCompare(b.category);
  });
  return sorted;
}

/**
 * top_findings = sortByPriority 后取前 N (cap 默认 5, cap<=0 返空).
 */
export function pickTopFindings(
  suggestions: readonly ImprovementSuggestion[],
  cap: number
): ImprovementSuggestion[] {
  if (cap <= 0) return [];
  const sorted = sortByPriority(suggestions);
  return sorted.slice(0, cap);
}

/**
 * 主 engine — 构建完整 improvement_suggestions 段.
 *
 * 4 detector 各跑一遍, 收集非 null 结果; 按 priority 排序 + 截 top_findings.
 */
export function buildImprovementSuggestions(
  input: BuildImprovementSuggestionsInput
): ImprovementSuggestionsSection {
  const top_findings_cap =
    Number.isFinite(input.top_findings_cap) && (input.top_findings_cap as number) > 0
      ? Math.floor(input.top_findings_cap as number)
      : BLACK_SWAN_IMPROVEMENT_DEFAULT_TOP_FINDINGS_CAP;

  const sources_used: string[] = [];
  if (input.sections.event_summary) sources_used.push('event_summary');
  if (input.sections.counterfactual_baselines) sources_used.push('counterfactual_baselines');
  if (input.sections.event_timeline) sources_used.push('event_timeline');

  const detectors = [
    detectDetectionShortfall,
    detectResponseShortfall,
    detectExecutionShortfall,
    detectRiskControlShortfall,
  ];

  const suggestions: ImprovementSuggestion[] = [];
  for (const d of detectors) {
    try {
      const s = d(input);
      if (s) suggestions.push(s);
    } catch (err: any) {
      // 单个 detector 异常不阻塞其它 detector — fail-OPEN.
      logger.warn(`[BlackSwanImprovement] detector ${d.name} threw: ${err?.message || err}`);
    }
  }

  const sorted = sortByPriority(suggestions);
  const top_findings = pickTopFindings(sorted, top_findings_cap);

  return {
    suggestions: sorted,
    top_findings,
    suggestor_version: BLACK_SWAN_IMPROVEMENT_SUGGESTOR_VERSION,
    meta: {
      event_detected_at: input.event_detected_at.toISOString(),
      sources_used,
      suggestions_total: sorted.length,
      top_findings_cap,
    },
  };
}

// ============================================================================
// metadata.sections_filled 累加 + status 升级 helpers
// (与 PR-014/015 同款契约 — 自包含不强耦合到上游 service.)
// ============================================================================

/**
 * 取当前 metadata.sections_filled (兜底数组类型校验), append 'improvement_suggestions'
 * 不重复.
 */
export function appendSectionFilled(
  current_metadata: Record<string, unknown>,
  section: string
): { sections_filled: string[]; merged_metadata: Record<string, unknown> } {
  const md = current_metadata && typeof current_metadata === 'object' ? current_metadata : {};
  const prev = Array.isArray((md as any).sections_filled) ? (md as any).sections_filled : [];
  const set = new Set<string>(prev.filter((s: unknown) => typeof s === 'string'));
  set.add(section);
  const sections_filled = Array.from(set);
  return { sections_filled, merged_metadata: { ...md, sections_filled } };
}

/**
 * 决定 upsert 后 status: sections_filled 包含全部 4 段 → 'ok'; 否则 'partial'.
 */
export function decidePostmortemStatus(sections_filled: readonly string[]): {
  status: string;
  reason: string | null;
} {
  const set = new Set(sections_filled);
  const all = ALL_POSTMORTEM_SECTIONS.every(s => set.has(s));
  if (all) return { status: 'ok', reason: null };
  const missing = ALL_POSTMORTEM_SECTIONS.filter(s => !set.has(s));
  return { status: 'partial', reason: `pending_sections: ${missing.join(',')}`.slice(0, 200) };
}

// ============================================================================
// Service 主入口 (cron)
// ============================================================================

/**
 * runBlackSwanImprovementSuggestorService — cron 主函数. 永不 throw.
 *
 * 流程:
 *   1. runner.loadCandidates (status='partial' 且 sections_filled 不含本段;
 *      lookback 24h 或 event_id 单条);
 *   2. 对每条 candidate:
 *      a) buildImprovementSuggestions(input) → section;
 *      b) section.suggestions.length === 0 → skipped reason='no_suggestions';
 *      c) dry_run=true → 跳过 updateReport;
 *      d) updateReport(row), 失败 → failed +1.
 */
export async function runBlackSwanImprovementSuggestorService(
  runner: SuggestorRunner,
  options: RunImprovementSuggestorOptions = {}
): Promise<ImprovementSuggestorResult> {
  const dryRun = Boolean(options.dry_run);
  const generated_at = options.generated_at instanceof Date ? options.generated_at : new Date();
  const lookback_hours =
    Number.isFinite(options.lookback_hours) && (options.lookback_hours as number) > 0
      ? Math.floor(options.lookback_hours as number)
      : BLACK_SWAN_IMPROVEMENT_DEFAULT_LOOKBACK_HOURS;
  const top_findings_cap =
    Number.isFinite(options.top_findings_cap) && (options.top_findings_cap as number) > 0
      ? Math.floor(options.top_findings_cap as number)
      : BLACK_SWAN_IMPROVEMENT_DEFAULT_TOP_FINDINGS_CAP;
  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};

  const baseResult: ImprovementSuggestorResult = {
    success: false,
    dry_run: dryRun,
    candidates_total: 0,
    reports_updated: 0,
    reports_failed: 0,
    reports_skipped: 0,
    generated_at_iso: generated_at.toISOString(),
  };

  // Step 1
  let cand: { ok: true; candidates: PartialPostmortemSnapshot[] } | { ok: false; error: string };
  try {
    cand = await runner.loadCandidates({
      asOf: generated_at,
      lookback_hours,
      event_id: options.event_id,
    });
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    logger.warn(`[BlackSwanImprovement] loadCandidates threw: ${errMsg}`);
    return { ...baseResult, error: `candidates_query_failed: ${errMsg}` };
  }
  if (!cand.ok) {
    const errMsg = (cand as { ok: false; error: string }).error;
    logger.warn(`[BlackSwanImprovement] loadCandidates failed: ${errMsg}`);
    return { ...baseResult, error: `candidates_query_failed: ${errMsg}` };
  }
  const candidates = cand.candidates || [];

  if (dryRun) {
    return { ...baseResult, success: true, candidates_total: candidates.length };
  }

  let updated = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of candidates) {
    try {
      const section = buildImprovementSuggestions({
        event_detected_at: c.event_detected_at,
        black_swan_event_id: c.black_swan_event_id,
        sections: c.sections || {},
        top_findings_cap,
      });

      if (!section.suggestions.length) {
        skipped += 1;
        continue;
      }

      const { sections_filled, merged_metadata } = appendSectionFilled(
        c.current_metadata,
        SECTION_KEY
      );
      const { status, reason } = decidePostmortemStatus(sections_filled);

      const row: ImprovementReportUpdateRow = {
        id: c.id,
        improvement_suggestions: section,
        metadata: {
          ...merged_metadata,
          ...metadata,
          suggestor_version: BLACK_SWAN_IMPROVEMENT_SUGGESTOR_VERSION,
          sections_filled,
          improvement_suggestions_filled_at_iso: generated_at.toISOString(),
        },
        status,
        reason,
        generated_at,
      };

      const r = await runner.updateReport(row);
      if (r.ok) {
        updated += 1;
      } else {
        failed += 1;
        logger.warn(
          `[BlackSwanImprovement] updateReport postmortem_id=${c.id} failed: ${
            (r as any).error || 'unknown'
          }`
        );
      }
    } catch (err: any) {
      failed += 1;
      logger.warn(
        `[BlackSwanImprovement] candidate postmortem_id=${c.id} threw: ${err?.message || err}`
      );
    }
  }

  return {
    success: true,
    dry_run: false,
    candidates_total: candidates.length,
    reports_updated: updated,
    reports_failed: failed,
    reports_skipped: skipped,
    generated_at_iso: generated_at.toISOString(),
  };
}

// ============================================================================
// Production runner — lazy-require models (与 PR-013/014/015 同款 lazy-require 模式)
// ============================================================================

/**
 * createProductionSuggestorRunner — production singleton 工厂. 测试不调它.
 *
 * lazy-require 模式 (与 BlackSwanPostmortemService / CounterfactualBaselineService
 * / EventTimelineReplayerService 同款): 单测脱 DB 走 fake runner 时, 这些 require
 * 不触发.
 */
export function createProductionSuggestorRunner(): SuggestorRunner {
  return {
    async loadCandidates({ asOf, lookback_hours, event_id }) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { BlackSwanPostmortemReport } = require('../models/BlackSwanPostmortemReport');
        const { BlackSwanEvent } = require('../models/BlackSwanEvent');
        const { Op } = require('sequelize');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const since = new Date(asOf.getTime() - lookback_hours * 3_600_000);
        const where: Record<string, unknown> = { status: 'partial' };
        if (event_id !== undefined && event_id !== null) {
          (where as any).black_swan_event_id = Number(event_id);
        }
        const rows = await BlackSwanPostmortemReport.findAll({
          where,
          include: [
            {
              model: BlackSwanEvent,
              required: true,
              where: { detected_at: { [Op.between]: [since, asOf] } },
            },
          ],
          limit: 500,
        });
        const candidates: PartialPostmortemSnapshot[] = (Array.isArray(rows) ? rows : []).map(
          (r: any) => {
            const ev = r.black_swan_event || {};
            const md = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
            return {
              id: Number(r.id),
              black_swan_event_id: Number(r.black_swan_event_id),
              event_detected_at:
                ev.detected_at instanceof Date ? ev.detected_at : new Date(ev.detected_at),
              current_metadata: md,
              current_status: String(r.status || 'partial'),
              sections: {
                event_summary:
                  r.event_summary && typeof r.event_summary === 'object' ? r.event_summary : null,
                counterfactual_baselines:
                  r.counterfactual_baselines && typeof r.counterfactual_baselines === 'object'
                    ? r.counterfactual_baselines
                    : null,
                event_timeline:
                  r.event_timeline && typeof r.event_timeline === 'object'
                    ? r.event_timeline
                    : null,
              },
            };
          }
        );
        // 客户端再过滤 sections_filled 已含本段的 — 与 dev/test SQLite 兼容
        const filtered = candidates.filter(c => {
          const sf = Array.isArray((c.current_metadata as any).sections_filled)
            ? (c.current_metadata as any).sections_filled
            : [];
          return !sf.includes(SECTION_KEY);
        });
        return { ok: true as const, candidates: filtered };
      } catch (err: any) {
        return { ok: false as const, error: err?.message || String(err) };
      }
    },

    async updateReport(row) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { BlackSwanPostmortemReport } = require('../models/BlackSwanPostmortemReport');
        /* eslint-enable @typescript-eslint/no-var-requires */
        // UPDATE WHERE id — 仅覆盖 improvement_suggestions + metadata + status +
        // reason + generated_at 5 列 (其它 JSONB 段不出现, sequelize 不动).
        await BlackSwanPostmortemReport.update(
          {
            improvement_suggestions: row.improvement_suggestions,
            metadata: row.metadata,
            status: row.status,
            reason: row.reason,
            generated_at: row.generated_at,
          },
          { where: { id: row.id } }
        );
        return { ok: true as const };
      } catch (err: any) {
        return { ok: false as const, error: err?.message || String(err) };
      }
    },
  };
}

let _prodRunner: SuggestorRunner | null = null;
/** Singleton (lazy). SchedulerService 复用. */
export function getProductionSuggestorRunner(): SuggestorRunner {
  if (!_prodRunner) _prodRunner = createProductionSuggestorRunner();
  return _prodRunner;
}
