/**
 * EventTimelineReplayerService — L4-Portfolio + Risk / US-104 [PR-015]
 * 黑天鹅复盘 事件时间轴回放 (event_timeline 段, 4 段中第 3 段)
 *
 * 接力 PR-013 BlackSwanPostmortemService 与 PR-014 CounterfactualBaselineCalculator
 * 后填 (本 service = 第 3 段; PR-016 ImprovementSuggestor 是第 4 段, 同款形态). 主入口 cron `BLACK_SWAN_TIMELINE` 每 30min 扫最近 24h status='partial' 且
 * metadata.sections_filled 不含 'event_timeline' 的 BlackSwanPostmortemReport, 对
 * 每行调 buildEventTimeline (pure engine) 把事件前 N 天 (默认 7) RiskAlert /
 * BlackSwanWatchdog 触发 (= rule_id='black_swan' 的 RiskAlert) 排时间轴, UPSERT
 * 仅覆盖 event_timeline 段 + metadata.sections_filled 累加 (其它 JSONB 段不出现在
 * payload, sequelize 不动它们 — 与 [[多段 JSONB 报告分阶段 UPSERT]] 同款).
 *
 * ============================================================================
 * timeline 形态 (来自 PRD US-104 AC + docs/trader-system/75_black_swan_postmortem.md)
 * ============================================================================
 *   - lookback_days: 时间轴回溯天数 (默认 7);
 *   - timeline[]: 按 ts 升序排序的事件流;
 *       * ts: ISO timestamp;
 *       * type: 'risk_alert' | 'watchdog_trigger' | 'price_break' | 'volume_spike'
 *               | 'news' | 'shareholder_action' | 'rebalance' | 'manual_action';
 *       * source_id?: number, source_table?: string — 上游记录 id (debug 用);
 *       * symbol?: string, severity?: 'low'|'medium'|'high'|'critical';
 *       * title: string, description?: string, metadata?: {};
 *   - alert_count_by_level: { low, medium, high, critical } 按 severity 聚合;
 *   - replayer_version: PR-015 replayer 版本号;
 *   - meta: { event_detected_at, lookback_days, sources_used[], items_total,
 *            items_truncated_cap }.
 *
 * **本 story (PR-015) 主数据源 = RiskAlert** (含 BlackSwanWatchdog 写的
 * rule_id='black_swan'); 价格/成交量异动 / 公告事件等其它源后续可扩展同款
 * adapter (DataSource.loadXxx + 主 engine concat → 排序), 不改本 engine API.
 *
 * ============================================================================
 * 调用方式 (cron 30min 巡)
 * ============================================================================
 *   - cron: `runEventTimelineReplayerService(getProductionTimelineRunner(), {})`;
 *   - 默认扫最近 24h detected 的 event 对应 partial postmortem
 *     (lookback_hours=24); already-filled (sections_filled 含 'event_timeline')
 *     走 skip 不重算;
 *   - dry_run=true → 仅返"会处理几条 partial postmortem"预演, 不调 upsert;
 *   - event_id (debug) → 仅处理指定事件 id 的 postmortem;
 *   - lookback_days (event_timeline 回溯天数) 默认 7, 与 PRD US-104 AC 对齐.
 *
 * ============================================================================
 * fail-OPEN (与 PR-013/014 同款)
 * ============================================================================
 *   - loadCandidates throw → 整次 service 返 success=false + error +
 *     candidates_total=0;
 *   - 单事件 loadRiskAlerts throw → 该事件 risk_alerts=[], engine 仍按其它源
 *     (本 story 暂无其它源) 继续 — items_total=0 时走 skipped reason='no_items';
 *   - upsert throw → reports_failed +1 但不抛, 整体 success=true.
 *
 * ============================================================================
 * idempotent (30min 重跑同事件不会双填)
 * ============================================================================
 *   - 候选过滤 = metadata.sections_filled 不含 'event_timeline'; 已填 skip;
 *   - 即使强制重跑 (event_id), upsert payload 只含本段, 不擦其它段;
 *   - sections_filled 累加用 array union (set 语义) 不重复;
 *   - status 升级: 4 段中已填 == 4 时升 'ok', 否则保持 'partial' (与 PR-014
 *     decidePostmortemStatus 同款逻辑).
 *
 * ============================================================================
 * SchedulerService 接入
 * ============================================================================
 *   `cronRegistry.ts`: type='BLACK_SWAN_TIMELINE', recommendedCron='33,3 * * * *'
 *   (与 BLACK_SWAN_BASELINE '23,53' 错峰 10min, 让 PR-014 先填 baseline →
 *   本 service 再补 event_timeline).
 */

import { logger } from '../utils/logger';

// ============================================================================
// Types (engine input/output)
// ============================================================================

/**
 * 时间轴单条事件 — 与 BlackSwanPostmortemReport.event_timeline.timeline[] 对齐.
 */
export interface TimelineItem {
  ts: string; // ISO timestamp (升序排序键)
  type: TimelineEventType;
  source_id?: number;
  source_table?: string;
  symbol?: string | null;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export type TimelineEventType =
  | 'risk_alert'
  | 'watchdog_trigger'
  | 'price_break'
  | 'volume_spike'
  | 'news'
  | 'shareholder_action'
  | 'rebalance'
  | 'manual_action';

/** event_timeline JSONB 段 (4 段第 3 段) */
export interface EventTimelineSection {
  lookback_days: number;
  timeline: TimelineItem[];
  alert_count_by_level: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  replayer_version: string;
  meta: {
    event_detected_at: string;
    lookback_days: number;
    items_total: number;
    items_truncated: boolean;
    items_cap: number;
    sources_used: string[];
  };
}

/** 上游 RiskAlert snapshot (本 service 真用的字段子集). */
export interface RiskAlertSnapshot {
  id: number;
  created_at: Date;
  symbol: string | null;
  name?: string | null;
  level: string; // 'HIGH' | 'MEDIUM' | 'LOW' | 'CRITICAL' (兼容大小写)
  message: string;
  rule_id: string | null;
  metadata?: Record<string, unknown>;
}

/** engine 主入口 input. */
export interface BuildEventTimelineInput {
  event_detected_at: Date;
  lookback_days?: number;
  risk_alerts?: readonly RiskAlertSnapshot[];
  /** 未来扩展: news / price_break / volume_spike / shareholder_action / ... */
  extra_items?: readonly TimelineItem[];
  items_cap?: number;
}

/** PR-013 已生成的 partial postmortem snapshot (本 service 候选输入). */
export interface PartialPostmortemSnapshot {
  id: number;
  black_swan_event_id: number;
  event_detected_at: Date;
  event_scope: string;
  event_symbol: string | null;
  event_scope_detail: Record<string, unknown>;
  current_metadata: Record<string, unknown>;
  current_status: string;
}

/** UPSERT payload — 只列 event_timeline + metadata + status + reason + generated_at. */
export interface TimelineReportUpdateRow {
  id: number;
  event_timeline: EventTimelineSection;
  metadata: Record<string, unknown>;
  status: string;
  reason: string | null;
  generated_at: Date;
}

/** runEventTimelineReplayerService 主返值. */
export interface EventTimelineReplayerResult {
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
export interface RunEventTimelineReplayerOptions {
  dry_run?: boolean;
  event_id?: number;
  lookback_hours?: number; // 扫 partial postmortem 的回溯小时数
  lookback_days?: number; // engine 时间轴回溯天数 (默认 7)
  generated_at?: Date;
  metadata?: Record<string, unknown>;
}

/** TimelineRunner — DI 接口. */
export interface TimelineRunner {
  /**
   * 拉取候选 partial postmortem (status='partial' AND sections_filled 不含
   * 'event_timeline'). 永不 throw — 失败返 ok:false.
   */
  loadCandidates(input: {
    asOf: Date;
    lookback_hours: number;
    event_id?: number;
  }): Promise<{ ok: true; candidates: PartialPostmortemSnapshot[] } | { ok: false; error: string }>;

  /**
   * 拉取事件相关的 RiskAlert 时间轴 (event_detected_at - lookback_days 到
   * event_detected_at + 1 天). 失败返 [] 让本 service 走 skipped.
   *
   * 若 symbol 不为空, 优先按 symbol 过滤 (避免拉全市场告警噪声); symbol=null
   * 时 fallback 到 metadata.event_type 等弱过滤.
   */
  loadRiskAlerts(input: {
    symbol: string | null;
    event_detected_at: Date;
    lookback_days: number;
  }): Promise<RiskAlertSnapshot[]>;

  /**
   * UPDATE 一行 postmortem 仅覆盖 event_timeline 段 + metadata + status.
   * 失败返 ok:false (不抛, 本服务统一走 fail-OPEN 累计).
   */
  updateReport(row: TimelineReportUpdateRow): Promise<{ ok: true } | { ok: false; error: string }>;
}

// ============================================================================
// 常量
// ============================================================================

/** cron 推荐表达式 — 与 BLACK_SWAN_BASELINE '23,53' 错峰 10min. */
export const BLACK_SWAN_TIMELINE_RECOMMENDED_CRON = '33,3 * * * *';

/** 默认 lookback (扫 partial postmortem 的回溯小时数). */
export const BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_HOURS = 24;

/** 默认时间轴回溯天数 (PRD US-104 N 天前; AC 默认 7). */
export const BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_DAYS = 7;

/** timeline 单段条目上限 — 防止 JSONB 段无限增长 (>1MB ops 看板会卡). */
export const BLACK_SWAN_TIMELINE_DEFAULT_ITEMS_CAP = 200;

/** replayer 版本号 (debug 用). */
export const BLACK_SWAN_TIMELINE_REPLAYER_VERSION = 'PR-015/v1';

/** 4 段 sections_filled 集合 — 用于决定 status 升级 'ok'. */
export const ALL_POSTMORTEM_SECTIONS = Object.freeze([
  'event_summary',
  'counterfactual_baselines',
  'event_timeline',
  'improvement_suggestions',
] as const);

const SECTION_KEY = 'event_timeline';

/** rule_id='black_swan' 表示 BlackSwanWatchdog (US-053) 触发 → type='watchdog_trigger'. */
const BLACK_SWAN_WATCHDOG_RULE_ID = 'black_swan';

// ============================================================================
// 纯函数 helpers (engine — 全 export 便于单测)
// ============================================================================

/**
 * 规范化 RiskAlert.level (HIGH/MEDIUM/LOW/CRITICAL 任意大小写 → 4 档 union;
 * 未知返 'medium' fail-safe 中档而非 'low' 让 ops 不被静默吞噪声).
 */
export function normalizeAlertSeverity(level: unknown): 'low' | 'medium' | 'high' | 'critical' {
  const s = String(level || '')
    .trim()
    .toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'medium' || s === 'med') return 'medium';
  if (s === 'low') return 'low';
  return 'medium';
}

/**
 * 把 RiskAlert 映射为 TimelineItem.
 * rule_id='black_swan' → type='watchdog_trigger' (BlackSwanWatchdog 触发);
 * 其它 → type='risk_alert' (通用风控告警, e.g. trailing_stop / drawdown 等).
 */
export function alertToTimelineItem(alert: RiskAlertSnapshot): TimelineItem {
  const isWatchdog = (alert.rule_id || '').toLowerCase() === BLACK_SWAN_WATCHDOG_RULE_ID;
  const severity = normalizeAlertSeverity(alert.level);
  // title 取 message 前 80 字 (UI 一行展示)
  const fullMsg = String(alert.message || '').trim();
  const title = fullMsg.length > 80 ? fullMsg.slice(0, 77) + '...' : fullMsg || '(空告警)';
  return {
    ts: alert.created_at.toISOString(),
    type: isWatchdog ? 'watchdog_trigger' : 'risk_alert',
    source_id: alert.id,
    source_table: 'risk_alerts',
    symbol: alert.symbol || null,
    severity,
    title,
    description: fullMsg.length > 80 ? fullMsg : undefined,
    metadata:
      alert.metadata && typeof alert.metadata === 'object' ? { ...alert.metadata } : undefined,
  };
}

/**
 * 按 severity 聚合 alert count (与 alert_count_by_level JSONB 字段对齐).
 * 只统计 type === 'risk_alert' | 'watchdog_trigger' 的条目 (其它 type 不归
 * level 桶, 后续 news/price_break 用别的聚合表)
 */
export function aggregateAlertCounts(items: readonly TimelineItem[]): {
  low: number;
  medium: number;
  high: number;
  critical: number;
} {
  const out = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const it of items) {
    if (it.type !== 'risk_alert' && it.type !== 'watchdog_trigger') continue;
    const sev = it.severity || 'medium';
    if (sev === 'low') out.low += 1;
    else if (sev === 'medium') out.medium += 1;
    else if (sev === 'high') out.high += 1;
    else if (sev === 'critical') out.critical += 1;
  }
  return out;
}

/**
 * 时间轴排序 — 升序 (ts ASC), ts 相同时 source_id ASC 兜底, 兜底兜底用 title.
 * 输入数组不被 mutate (返新数组).
 */
export function sortTimeline(items: readonly TimelineItem[]): TimelineItem[] {
  const sorted = items.slice();
  sorted.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    const ai = a.source_id ?? Number.POSITIVE_INFINITY;
    const bi = b.source_id ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return (a.title || '').localeCompare(b.title || '');
  });
  return sorted;
}

/**
 * 截断 timeline 到 cap (保留最早 cap-1 + 最晚 1, 中间踢掉, 防 JSONB 无限增长).
 * cap<=0 返空数组; len<=cap 不动.
 *
 * 设计选择: 保留首尾代表"事件前夜 + 事件触发瞬间" 两端语义最重要, 中间踢掉
 * 让 ops 看板"开始 + 高潮"双锚点不丢. 与 downsampleSeries (PR-014) "保首尾"
 * 同款思想.
 */
export function truncateTimeline(items: readonly TimelineItem[], cap: number): TimelineItem[] {
  if (cap <= 0) return [];
  if (items.length <= cap) return items.slice();
  const head = items.slice(0, cap - 1);
  const tail = items[items.length - 1];
  return [...head, tail];
}

/**
 * 主 engine — 构建完整 event_timeline 段.
 *
 * risk_alerts + extra_items 拼接 → 排序 → truncate → 聚合 alert count.
 */
export function buildEventTimeline(input: BuildEventTimelineInput): EventTimelineSection {
  const lookback_days =
    Number.isFinite(input.lookback_days) && (input.lookback_days as number) > 0
      ? Math.floor(input.lookback_days as number)
      : BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_DAYS;
  const items_cap =
    Number.isFinite(input.items_cap) && (input.items_cap as number) > 0
      ? Math.floor(input.items_cap as number)
      : BLACK_SWAN_TIMELINE_DEFAULT_ITEMS_CAP;
  const risk_alerts = Array.isArray(input.risk_alerts) ? input.risk_alerts : [];
  const extra_items = Array.isArray(input.extra_items) ? input.extra_items : [];

  const sources_used: string[] = [];
  if (risk_alerts.length > 0) sources_used.push('risk_alerts');
  if (extra_items.length > 0) sources_used.push('extra_items');

  const items_from_alerts = risk_alerts.map(alertToTimelineItem);
  const all_items = [...items_from_alerts, ...extra_items];
  const sorted = sortTimeline(all_items);
  const truncated = truncateTimeline(sorted, items_cap);
  const items_truncated = sorted.length > items_cap;

  return {
    lookback_days,
    timeline: truncated,
    alert_count_by_level: aggregateAlertCounts(truncated),
    replayer_version: BLACK_SWAN_TIMELINE_REPLAYER_VERSION,
    meta: {
      event_detected_at: input.event_detected_at.toISOString(),
      lookback_days,
      items_total: sorted.length,
      items_truncated,
      items_cap,
      sources_used,
    },
  };
}

// ============================================================================
// metadata.sections_filled 累加 + status 升级 helpers
// (与 PR-014 CounterfactualBaselineService 同款逻辑 — 抽到独立 helper 保持
// 单测在 service-local context 自包含, 不强耦合到 PR-014.)
// ============================================================================

/**
 * 取当前 metadata.sections_filled (兜底数组类型校验), append 'event_timeline'
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
 * runEventTimelineReplayerService — cron 主函数. 永不 throw.
 *
 * 流程:
 *   1. runner.loadCandidates (status='partial' 且 sections_filled 不含本段;
 *      lookback 24h 或 event_id 单条);
 *   2. 对每条 candidate:
 *      a) runner.loadRiskAlerts(symbol, event_detected_at, lookback_days)
 *         → alerts; throw → 空数组 + log warn 不阻塞;
 *      b) buildEventTimeline(input) → section;
 *      c) section.timeline.length === 0 → skipped reason='no_items';
 *      d) dry_run=true → 跳过 updateReport;
 *      e) updateReport(row), 失败 → failed +1.
 */
export async function runEventTimelineReplayerService(
  runner: TimelineRunner,
  options: RunEventTimelineReplayerOptions = {}
): Promise<EventTimelineReplayerResult> {
  const dryRun = Boolean(options.dry_run);
  const generated_at = options.generated_at instanceof Date ? options.generated_at : new Date();
  const lookback_hours =
    Number.isFinite(options.lookback_hours) && (options.lookback_hours as number) > 0
      ? Math.floor(options.lookback_hours as number)
      : BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_HOURS;
  const lookback_days =
    Number.isFinite(options.lookback_days) && (options.lookback_days as number) > 0
      ? Math.floor(options.lookback_days as number)
      : BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_DAYS;
  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};

  const baseResult: EventTimelineReplayerResult = {
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
    logger.warn(`[BlackSwanTimeline] loadCandidates threw: ${errMsg}`);
    return { ...baseResult, error: `candidates_query_failed: ${errMsg}` };
  }
  if (!cand.ok) {
    const errMsg = (cand as { ok: false; error: string }).error;
    logger.warn(`[BlackSwanTimeline] loadCandidates failed: ${errMsg}`);
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
      let alerts: RiskAlertSnapshot[] = [];
      try {
        alerts = await runner.loadRiskAlerts({
          symbol: c.event_symbol,
          event_detected_at: c.event_detected_at,
          lookback_days,
        });
        if (!Array.isArray(alerts)) alerts = [];
      } catch (err: any) {
        logger.warn(
          `[BlackSwanTimeline] loadRiskAlerts postmortem_id=${c.id} threw: ${err?.message || err}`
        );
        alerts = [];
      }

      const section = buildEventTimeline({
        event_detected_at: c.event_detected_at,
        risk_alerts: alerts,
        lookback_days,
      });

      if (!section.timeline.length) {
        skipped += 1;
        continue;
      }

      const { sections_filled, merged_metadata } = appendSectionFilled(
        c.current_metadata,
        SECTION_KEY
      );
      const { status, reason } = decidePostmortemStatus(sections_filled);

      const row: TimelineReportUpdateRow = {
        id: c.id,
        event_timeline: section,
        metadata: {
          ...merged_metadata,
          ...metadata,
          replayer_version: BLACK_SWAN_TIMELINE_REPLAYER_VERSION,
          sections_filled,
          event_timeline_filled_at_iso: generated_at.toISOString(),
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
          `[BlackSwanTimeline] updateReport postmortem_id=${c.id} failed: ${
            (r as any).error || 'unknown'
          }`
        );
      }
    } catch (err: any) {
      failed += 1;
      logger.warn(
        `[BlackSwanTimeline] candidate postmortem_id=${c.id} threw: ${err?.message || err}`
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
// Production runner — lazy-require models (与 PR-013/014 同款 lazy-require 模式)
// ============================================================================

/**
 * createProductionTimelineRunner — production singleton 工厂. 测试不调它.
 *
 * lazy-require 模式 (与 BlackSwanPostmortemService / CounterfactualBaselineService
 * 同款): 单测脱 DB 走 fake runner 时, 这些 require 不触发.
 */
export function createProductionTimelineRunner(): TimelineRunner {
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
              event_scope: String(ev.scope || ''),
              event_symbol: ev.symbol || null,
              event_scope_detail:
                ev.scope_detail && typeof ev.scope_detail === 'object' ? ev.scope_detail : {},
              current_metadata: md,
              current_status: String(r.status || 'partial'),
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

    async loadRiskAlerts({ symbol, event_detected_at, lookback_days }) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { RiskAlert } = require('../models/RiskAlert');
        const { Op } = require('sequelize');
        /* eslint-enable @typescript-eslint/no-var-requires */
        if (!RiskAlert) return [];
        const since = new Date(event_detected_at.getTime() - lookback_days * 86_400_000);
        // 事件检出后 +1 天截止 — 让"事件刚触发瞬间" 的 alert 也进时间轴
        const until = new Date(event_detected_at.getTime() + 86_400_000);
        const where: Record<string, unknown> = {
          created_at: { [Op.between]: [since, until] },
        };
        if (symbol) (where as any).symbol = symbol;
        const rows = await RiskAlert.findAll({
          where,
          attributes: [
            'id',
            'symbol',
            'name',
            'level',
            'message',
            'rule_id',
            'created_at',
            'metadata',
          ],
          order: [['created_at', 'ASC']],
          limit: 500,
        });
        if (!Array.isArray(rows)) return [];
        return rows.map((r: any) => ({
          id: Number(r.id),
          created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
          symbol: r.symbol || null,
          name: r.name || null,
          level: String(r.level || ''),
          message: String(r.message || ''),
          rule_id: r.rule_id || null,
          metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : undefined,
        }));
      } catch {
        return [];
      }
    },

    async updateReport(row) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { BlackSwanPostmortemReport } = require('../models/BlackSwanPostmortemReport');
        /* eslint-enable @typescript-eslint/no-var-requires */
        // UPDATE WHERE id — 仅覆盖 event_timeline + metadata + status + reason
        // + generated_at 5 列 (其它 JSONB 段不出现, sequelize 不动).
        await BlackSwanPostmortemReport.update(
          {
            event_timeline: row.event_timeline,
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

let _prodRunner: TimelineRunner | null = null;
/** Singleton (lazy). SchedulerService 复用. */
export function getProductionTimelineRunner(): TimelineRunner {
  if (!_prodRunner) _prodRunner = createProductionTimelineRunner();
  return _prodRunner;
}
