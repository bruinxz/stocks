/**
 * BlackSwanPostmortemService — L4-Portfolio + Risk / US-102 [PR-013]
 * 黑天鹅事件复盘报告主入口
 *
 * 触发后 30 min 内, 把外部写入源落到 BlackSwanEvent
 * (PR-010) 的事件, UPSERT 一行 BlackSwanPostmortemReport (PR-012). 本 story 编排
 * 4 段生成 + 落表; 4 段中:
 *   1. event_summary           — **本 story 主入口直接填充**
 *      (event_type/severity/scope/symbol/duration_minutes/linked_risk_alert_ids[]/...)
 *   2. counterfactual_baselines — PR-014 (US-103) 后续接入; 本 story 留 {}
 *   3. event_timeline           — PR-015 (US-104) 后续接入; 本 story 留 {}
 *   4. improvement_suggestions  — PR-016 (US-105) 后续接入; 本 story 留 {}
 *
 * status 一开始 INSERT 为 'partial' 而非 'ok' — 因为 PR-014/015/016 还没接入, 4 段
 * 中只有 event_summary 真填了. 等 PR-014/015/016 各自把段填好后, 它们自己负责把
 * status 从 'partial' 升到 'ok'. 本服务 metadata.sections_filled = ['event_summary']
 * 留痕, metadata.errors[] 收集每段失败原因.
 *
 * ============================================================================
 * 调用方式 (cron 30min 巡)
 * ============================================================================
 * - cron: `runBlackSwanPostmortem(getProductionPostmortemRunner(), {})`;
 * - 默认扫最近 24h 内 detected 的事件 (lookback_hours=24); 已有 postmortem (按
 *   black_swan_event_id 业务唯一键) 走 UPSERT 覆盖 — 但只覆盖 event_summary 段 +
 *   sections_filled 重新累积, PR-014/015/016 已填的段不动 (model 层默认值 {} 不擦);
 * - dry_run=true → 仅返"会处理几条事件"预演, 不调 upsert;
 * - event_id (debug) → 仅处理指定事件 id (覆盖 lookback 范围).
 *
 * ============================================================================
 * fail-OPEN (与 DbBackupService 同款)
 * ============================================================================
 * - loadEvents throw → 整次 service 返 success=false + error: events_query_failed
 *   + 0 reports; 不让 SchedulerService cron tick 崩;
 * - 单事件 upsert throw → 该事件 metadata.errors 留痕, 整体继续; 最后 reports_failed
 *   累计;
 * - 全部 upsert throw → success=true (因为 events_total > 0 时整体不算 fail 因子,
 *   reports_failed 字段告知失败规模; 与 SchedulerService.failed_items 对齐).
 *
 * ============================================================================
 * idempotent (30min 重跑同事件不会双写)
 * ============================================================================
 * - BlackSwanPostmortemReport.UNIQUE(black_swan_event_id) (PR-012 已落);
 *   upsert(row) 在唯一键冲突时 UPDATE 而非 INSERT 二次, 与"事件→报告 1:1" 语义对齐;
 * - 重跑会**覆盖** event_summary + generated_at + metadata.sections_filled
 *   (本 service 只负责这 3 个字段段; PR-014/015/016 已填 JSONB 段 model 默认值 {}
 *   不会因为本 service 没填就被擦 — 关键在于 upsert payload 只列我们要更新的字段,
 *   其余字段在 row 里**根本不出现**, sequelize upsert 不动它们).
 *
 * ============================================================================
 * SchedulerService 接入
 * ============================================================================
 *   `cronRegistry.ts`: type='BLACK_SWAN_POSTMORTEM', recommendedCron='13,43 * * * *'
 *   (BLACK_SWAN_DETECT cron 已在 C-BS-03 批次删除 · BlackSwanEvent 读端由外部写入源承担;
 *    与 OPS-006 webhook retry '* / 5' 错峰);
 *   `SchedulerService._executeTaskLogic`: lazy-require runBlackSwanPostmortem +
 *   getProductionPostmortemRunner, 透传 parameters.dry_run + parameters.event_id +
 *   parameters.lookback_hours.
 */

import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

/**
 * 单条上游 BlackSwanEvent 的 snapshot — 只含本 service 真用的字段, 与
 * BlackSwanEvent model schema 对齐 (其它字段如 created_at/updated_at 不读).
 */
export interface BlackSwanEventSnapshot {
  id: number;
  detected_at: Date;
  event_type: string;
  severity: string;
  scope: string;
  symbol: string | null;
  title: string;
  description: string;
  signature: string;
  resolved_at: Date | null;
  resolved_reason: string | null;
  metadata: Record<string, unknown>;
}

/** event_summary JSONB 段 — 4 段中第 1 段, 本 service 主入口填充. */
export interface BlackSwanEventSummary {
  event_type: string;
  severity: string;
  scope: string;
  symbol: string | null;
  detected_at: string; // ISO
  resolved_at: string | null; // ISO or null
  duration_minutes: number | null; // null = open / 未 resolved
  title: string;
  description: string;
  linked_risk_alert_ids: number[];
}

/** UPSERT 一行 postmortem 报告的 payload (字段子集 — 不含 PR-014/015/016 段). */
export interface BlackSwanPostmortemReportRow {
  black_swan_event_id: number;
  title: string;
  summary: string;
  event_summary: BlackSwanEventSummary;
  source: string;
  status: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  generated_at: Date;
}

/** runBlackSwanPostmortem 主返值. */
export interface BlackSwanPostmortemResult {
  success: boolean;
  dry_run: boolean;
  /** lookback 窗口扫到的 BlackSwanEvent 数 (或 event_id 限定时为 1 / 0). */
  events_total: number;
  /** 实际生成 postmortem 报告 (含 upsert success) 的数量. */
  reports_generated: number;
  /** upsert 抛错的事件数. */
  reports_failed: number;
  /** 失败原因 (success=false 时必填; loadEvents throw / 顶层 catch). */
  error?: string;
  /** asOf 时间戳 (cron tick 起点, ISO string). */
  generated_at_iso: string;
}

/** runBlackSwanPostmortem 调用选项. */
export interface RunBlackSwanPostmortemOptions {
  /**
   * dry_run=true → 不调 upsert, 只返"会处理几条事件"预演.
   */
  dry_run?: boolean;
  /** 指定单事件 id (debug / ops 单测时用); 不填 = 扫 lookback 窗口. */
  event_id?: number;
  /** 默认 24h. event_id 优先 — 此字段被忽略. */
  lookback_hours?: number;
  /** 覆盖 asOf 时间 (测试 / 回填); 默认 NOW. */
  generated_at?: Date;
  /** cron 调用 metadata 透传进 row.metadata (cron_run_id / service_version / 等). */
  metadata?: Record<string, unknown>;
}

/**
 * PostmortemRunner — DI 接口. 抽掉 Sequelize findAll / upsert + 关联 RiskAlert
 * 查询, 单测注入 fake.
 */
export interface PostmortemRunner {
  /**
   * 拉取候选 BlackSwanEvent.
   * - asOf - lookback_hours ≤ detected_at ≤ asOf;
   * - 若 event_id 给定 → 仅拉该 id (1 行或 0 行);
   * - 永不 throw — 失败返 ok:false + error.
   */
  loadEvents(input: {
    asOf: Date;
    lookback_hours: number;
    event_id?: number;
  }): Promise<{ ok: true; events: BlackSwanEventSnapshot[] } | { ok: false; error: string }>;

  /**
   * 拉取与某事件 (event_type, symbol) 相关的 RiskAlert ids (BlackSwanWatchdog
   * 之前已发的告警). 用于填 event_summary.linked_risk_alert_ids.
   *
   * 失败时返空数组 (不让单事件追溯失败影响整体 postmortem 落库).
   */
  loadLinkedRiskAlertIds(input: {
    event_type: string;
    symbol: string | null;
    detected_at: Date;
    lookback_days: number;
  }): Promise<number[]>;

  /**
   * UPSERT 一行 BlackSwanPostmortemReport.
   * 失败返 ok:false (不抛, 本服务统一走 fail-OPEN 累计).
   */
  upsertReport(
    row: BlackSwanPostmortemReportRow
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

// ============================================================================
// 纯函数 helpers (全 export 便于单测)
// ============================================================================

/** 默认 cron 30min 巡: 推荐 cron 表达式 (Asia/Shanghai). BlackSwanEvent 读端由外部写入源承担 (C-BS-03 后). */
export const BLACK_SWAN_POSTMORTEM_RECOMMENDED_CRON = '13,43 * * * *';

/** 默认 lookback 窗口 (小时). cron 30min 跑一次, 24h 余量足够覆盖任何漏跑/补跑. */
export const BLACK_SWAN_POSTMORTEM_DEFAULT_LOOKBACK_HOURS = 24;

/** RiskAlert 关联回溯天数 (PRD US-104 lookback_days 思想, 但仅用于关联 IDs). */
export const BLACK_SWAN_POSTMORTEM_RISK_ALERT_LOOKBACK_DAYS = 7;

/** 报告 title cap (与 BlackSwanPostmortemReport model STRING(200) 对齐, 留 buffer). */
const TITLE_MAX_LEN = 200;
/** 报告 summary cap (model 是 TEXT 无硬限, cap 防 push 风暴). */
const SUMMARY_MAX_LEN = 500;

/**
 * 计算事件持续分钟数. 未 resolved (resolved_at=null) 返 null.
 * - resolved_at 早于 detected_at (异常) → 0
 * - 正常 → ceil 分钟数 (与 ops 看板 / 飞书 push "持续 N 分钟" 文案对齐)
 */
export function calcDurationMinutes(detected_at: Date, resolved_at: Date | null): number | null {
  if (!resolved_at) return null;
  const ms = resolved_at.getTime() - detected_at.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 0;
  return Math.ceil(ms / 60_000);
}

/**
 * 给单条事件生成 postmortem report 的 title (≤ 200 字; model schema 上限).
 * 格式: "<event title> - 复盘报告".
 * 若 event.title 已超过 188 → 截断 + "..." 后再拼.
 */
export function buildReportTitle(event: BlackSwanEventSnapshot): string {
  const suffix = ' - 复盘报告';
  const room = TITLE_MAX_LEN - suffix.length;
  const base = (event.title || '').slice(0, room);
  const trimmed = base.length < (event.title || '').length ? base.slice(0, room - 3) + '...' : base;
  return `${trimmed}${suffix}`;
}

/**
 * 给单条事件生成 postmortem report 的 summary (≤ 500 字).
 * 启发式格式: "<event_type> 事件 (severity=...) 于 <iso> 触发; <持续/未恢复>; <description>".
 * 描述部分留至少 200 字空间, 不足时截断.
 */
export function buildReportSummary(
  event: BlackSwanEventSnapshot,
  duration_minutes: number | null
): string {
  const sevTag = `[severity=${event.severity}]`;
  const tsTag = event.detected_at.toISOString();
  const durTag =
    duration_minutes === null
      ? '事件仍在持续中'
      : duration_minutes === 0
      ? '瞬时事件 (resolved_at ≤ detected_at)'
      : `共持续 ${duration_minutes} 分钟`;
  const head = `${event.event_type} 事件 ${sevTag} 于 ${tsTag} 触发; ${durTag}.`;
  const room = SUMMARY_MAX_LEN - head.length - 1;
  let tail = event.description || '';
  if (tail.length > room && room > 3) {
    tail = tail.slice(0, room - 3) + '...';
  } else if (room <= 0) {
    tail = '';
  }
  const full = tail ? `${head} ${tail}` : head;
  return full.length > SUMMARY_MAX_LEN ? full.slice(0, SUMMARY_MAX_LEN - 3) + '...' : full;
}

/**
 * 给单条事件构造 event_summary JSONB 段 (4 段中第 1 段, 本 service 主入口填).
 *
 * linked_risk_alert_ids 由调用方先调 runner.loadLinkedRiskAlertIds 拿到再传入,
 * 不在本纯函数里直接读 DB.
 */
export function buildEventSummary(
  event: BlackSwanEventSnapshot,
  linked_risk_alert_ids: readonly number[]
): BlackSwanEventSummary {
  const duration_minutes = calcDurationMinutes(event.detected_at, event.resolved_at);
  return {
    event_type: event.event_type,
    severity: event.severity,
    scope: event.scope,
    symbol: event.symbol,
    detected_at: event.detected_at.toISOString(),
    resolved_at: event.resolved_at ? event.resolved_at.toISOString() : null,
    duration_minutes,
    title: event.title || '',
    description: event.description || '',
    linked_risk_alert_ids: Array.from(linked_risk_alert_ids),
  };
}

/**
 * 把 BlackSwanEventSnapshot + event_summary + metadata → 完整 upsert payload.
 *
 * status='partial' (而非 'ok') — 本 story 只填了 4 段中的 1 段; PR-014/015/016
 * 接入后由它们自己把 status 升到 'ok'.
 * reason='only_event_summary_filled' — 给 ops 看板 / 调试一眼看出哪段没填.
 * sections_filled=['event_summary'] — metadata 字段, 供后续 service 累加.
 */
export function buildPostmortemReportRow(
  event: BlackSwanEventSnapshot,
  event_summary: BlackSwanEventSummary,
  generated_at: Date,
  metadata: Record<string, unknown> = {}
): BlackSwanPostmortemReportRow {
  const duration_minutes = event_summary.duration_minutes;
  return {
    black_swan_event_id: event.id,
    title: buildReportTitle(event),
    summary: buildReportSummary(event, duration_minutes),
    event_summary,
    source: 'service_auto',
    status: 'partial',
    reason: 'only_event_summary_filled',
    metadata: {
      ...metadata,
      service_version: 'PR-013/v1',
      sections_filled: ['event_summary'],
      // 留痕首次生成时戳 (重跑时 sequelize upsert 不动这字段 — 只有第一次 INSERT 才进库;
      // 后续 UPDATE 会用 row 里的值覆盖. 调用方若想区分首次 vs 重跑可读 created_at).
      first_generated_at_iso: generated_at.toISOString(),
    },
    generated_at,
  };
}

// ============================================================================
// Service 主入口
// ============================================================================

/**
 * runBlackSwanPostmortem — cron 主函数. 永不 throw; 失败返 success=false + error.
 *
 * 流程:
 *   1. 调 runner.loadEvents (lookback 24h 或 event_id 单条);
 *   2. 对每条 event 调 runner.loadLinkedRiskAlertIds 拿关联告警 (永不抛, 失败返 []);
 *   3. buildEventSummary + buildPostmortemReportRow → row;
 *   4. dry_run=true → return 预演 (不调 upsert);
 *      dry_run=false → 逐条 upsertReport, 失败累计 reports_failed.
 */
export async function runBlackSwanPostmortem(
  runner: PostmortemRunner,
  options: RunBlackSwanPostmortemOptions = {}
): Promise<BlackSwanPostmortemResult> {
  const dryRun = Boolean(options.dry_run);
  const generated_at = options.generated_at instanceof Date ? options.generated_at : new Date();
  const lookback_hours =
    Number.isFinite(options.lookback_hours) && (options.lookback_hours as number) > 0
      ? Math.floor(options.lookback_hours as number)
      : BLACK_SWAN_POSTMORTEM_DEFAULT_LOOKBACK_HOURS;
  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};

  const baseResult: BlackSwanPostmortemResult = {
    success: false,
    dry_run: dryRun,
    events_total: 0,
    reports_generated: 0,
    reports_failed: 0,
    generated_at_iso: generated_at.toISOString(),
  };

  // Step 1: loadEvents — fail-OPEN
  const ev = await runner.loadEvents({
    asOf: generated_at,
    lookback_hours,
    event_id: options.event_id,
  });
  if (!ev.ok) {
    const errMsg = (ev as { ok: false; error: string }).error;
    logger.warn(`[BlackSwanPostmortem] loadEvents failed: ${errMsg}`);
    return { ...baseResult, error: `events_query_failed: ${errMsg}` };
  }
  const events = ev.events || [];

  // dry_run 预演
  if (dryRun) {
    return {
      ...baseResult,
      success: true,
      events_total: events.length,
    };
  }

  // Step 2-4: 对每条 event upsert (顺序串行, 单事件失败不影响其它)
  let reports_generated = 0;
  let reports_failed = 0;
  for (const event of events) {
    let linked_ids: number[] = [];
    try {
      linked_ids = await runner.loadLinkedRiskAlertIds({
        event_type: event.event_type,
        symbol: event.symbol,
        detected_at: event.detected_at,
        lookback_days: BLACK_SWAN_POSTMORTEM_RISK_ALERT_LOOKBACK_DAYS,
      });
      if (!Array.isArray(linked_ids)) linked_ids = [];
    } catch (err: any) {
      // 关联告警查询失败 → 留空数组 + 留痕, 但不影响 postmortem 生成
      logger.warn(
        `[BlackSwanPostmortem] loadLinkedRiskAlertIds event_id=${event.id} threw: ${
          err?.message || err
        }`
      );
      linked_ids = [];
    }

    const event_summary = buildEventSummary(event, linked_ids);
    const row = buildPostmortemReportRow(event, event_summary, generated_at, metadata);

    try {
      const r = await runner.upsertReport(row);
      if (r.ok) {
        reports_generated += 1;
      } else {
        reports_failed += 1;
        logger.warn(
          `[BlackSwanPostmortem] upsertReport event_id=${event.id} failed: ${
            (r as any).error || 'unknown'
          }`
        );
      }
    } catch (err: any) {
      reports_failed += 1;
      logger.warn(
        `[BlackSwanPostmortem] upsertReport event_id=${event.id} threw: ${err?.message || err}`
      );
    }
  }

  return {
    success: true,
    dry_run: false,
    events_total: events.length,
    reports_generated,
    reports_failed,
    generated_at_iso: generated_at.toISOString(),
  };
}

// ============================================================================
// Production runner — lazy-require BlackSwanEvent / BlackSwanPostmortemReport
// / RiskAlert sequelize models
// ============================================================================

/**
 * createProductionPostmortemRunner — production singleton 工厂. 测试不调它.
 *
 * lazy-require 模式 (与 DbBackupService 同款): 单测脱
 * DB / 脱 sequelize-typescript 走 fake runner 时, 这些 require 不触发.
 */
export function createProductionPostmortemRunner(): PostmortemRunner {
  return {
    async loadEvents({ asOf, lookback_hours, event_id }) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { BlackSwanEvent } = require('../models/BlackSwanEvent');
        const { Op } = require('sequelize');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const where: Record<string, unknown> = {};
        if (event_id !== undefined && event_id !== null) {
          where.id = Number(event_id);
        } else {
          const since = new Date(asOf.getTime() - lookback_hours * 3_600_000);
          where.detected_at = { [Op.between]: [since, asOf] };
        }
        const rows = await BlackSwanEvent.findAll({
          where,
          order: [['detected_at', 'ASC']],
          limit: 500, // cap 防风暴 (24h 内 500 条事件已远超 ops 容量)
        });
        const events: BlackSwanEventSnapshot[] = (Array.isArray(rows) ? rows : []).map(
          (r: any) => ({
            id: Number(r.id),
            detected_at: r.detected_at instanceof Date ? r.detected_at : new Date(r.detected_at),
            event_type: String(r.event_type || ''),
            severity: String(r.severity || ''),
            scope: String(r.scope || ''),
            symbol: r.symbol || null,
            title: String(r.title || ''),
            description: String(r.description || ''),
            signature: String(r.signature || ''),
            resolved_at: r.resolved_at
              ? r.resolved_at instanceof Date
                ? r.resolved_at
                : new Date(r.resolved_at)
              : null,
            resolved_reason: r.resolved_reason || null,
            metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
          })
        );
        return { ok: true as const, events };
      } catch (err: any) {
        return { ok: false as const, error: err?.message || String(err) };
      }
    },
    async loadLinkedRiskAlertIds({ event_type, symbol, detected_at, lookback_days }) {
      // RiskAlert 没有 event_type 列 — BlackSwanWatchdog 写的是 alert_type='black_swan'
      // + metadata 里夹 event_type. 这里启发式只做 (alert_type, symbol, created_at)
      // 范围匹配, 返 id 数组. 失败返 [] 让本 service fail-OPEN.
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { RiskAlert } = require('../models/RiskAlert');
        const { Op } = require('sequelize');
        /* eslint-enable @typescript-eslint/no-var-requires */
        if (!RiskAlert) return [];
        const since = new Date(detected_at.getTime() - lookback_days * 86_400_000);
        const until = new Date(detected_at.getTime() + lookback_days * 86_400_000);
        const where: Record<string, unknown> = {
          created_at: { [Op.between]: [since, until] },
        };
        if (symbol) (where as any).symbol = symbol;
        const rows = await RiskAlert.findAll({
          where,
          attributes: ['id', 'metadata'],
          limit: 200,
        });
        if (!Array.isArray(rows)) return [];
        // 仅保留 metadata.event_type === event_type 的 (避免误关 RebalanceAlert 等)
        const ids: number[] = [];
        for (const r of rows) {
          const md: any = r.metadata || {};
          if (!md || typeof md !== 'object') continue;
          if (md.event_type && md.event_type !== event_type) continue;
          if (Number.isFinite(Number(r.id))) ids.push(Number(r.id));
        }
        return ids;
      } catch {
        return [];
      }
    },
    async upsertReport(row) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { BlackSwanPostmortemReport } = require('../models/BlackSwanPostmortemReport');
        /* eslint-enable @typescript-eslint/no-var-requires */
        // sequelize upsert: UNIQUE(black_swan_event_id) 冲突时 UPDATE
        // payload 只列了 6 个字段 + metadata + generated_at — 其它 JSONB
        // (counterfactual_baselines / event_timeline / improvement_suggestions)
        // 不出现在 row 里, sequelize 不动它们, 保留 PR-014/015/016 已写值.
        await BlackSwanPostmortemReport.upsert(row);
        return { ok: true as const };
      } catch (err: any) {
        return { ok: false as const, error: err?.message || String(err) };
      }
    },
  };
}

let _prodRunner: PostmortemRunner | null = null;
/** Singleton (lazy). SchedulerService 复用. */
export function getProductionPostmortemRunner(): PostmortemRunner {
  if (!_prodRunner) _prodRunner = createProductionPostmortemRunner();
  return _prodRunner;
}
