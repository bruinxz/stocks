/**
 * BlackSwanQuarterlyReportService — L4-Portfolio + Risk / US-134 [PR-019]
 * 季度黑天鹅汇总报告
 *
 * 每季度第一天 09:05 (Asia/Shanghai) 把"上一季度 (Q-1) 内所有 BlackSwanEvent"
 * 聚合成一份 HTML 邮件发给 ops 收件人列表 (env QUARTERLY_BLACK_SWAN_RECIPIENTS,
 * 逗号分隔; 缺省 → skipped fail-OPEN). 与 BlackSwanPostmortemReport 单事件 4 段
 * 报告互补 — postmortem 关注 "单事件复盘", quarterly 关注 "季度内总体分布 / 趋势 /
 * 高频 type-symbol 组合" 给操盘手做"上一季 black swan 风险面" 总览.
 *
 * AC (US-134):
 *   - 邮件 (HTML, SMTP via env, 与 WeeklyReviewReportService US-065 同款邮件 channel)
 *   - Typecheck passes
 *   - Relevant unit tests pass
 *
 * ============================================================================
 * 季度切割 (Asia/Shanghai)
 * ============================================================================
 * 给定 reference_date (默认 NOW 上海时区), 自动定位"上一季度"区间:
 *   - 2026-01-15 → 2025 Q4 (2025-10-01 ~ 2025-12-31)
 *   - 2026-04-01 → 2026 Q1 (2026-01-01 ~ 2026-03-31)  // 季度首日跑 = 跑上季
 *   - 2026-07-05 → 2026 Q2 (2026-04-01 ~ 2026-06-30)
 *   - 2026-10-20 → 2026 Q3 (2026-07-01 ~ 2026-09-30)
 *
 * 实现: refDate.month 0-2/3-5/6-8/9-11 → 当前季 Q (1..4), 上一季 = ((Q+2) % 4) + 1,
 * 如果当前 Q==1 → 上季 year = year-1, 否则同 year. 计算保留为纯函数便于单测.
 *
 * ============================================================================
 * 聚合维度
 * ============================================================================
 *   1. summary: { events_total, days_with_events, days_in_quarter }
 *   2. by_event_type: [{ event_type, count, pct }] (按 count desc, 同 count tie 按 type asc)
 *   3. by_severity:   [{ severity, count, pct }]  (同上排序)
 *   4. by_scope:      [{ scope, count, pct }]     (同上排序)
 *   5. top_symbols:   [{ symbol, count }] (按 count desc, scope='symbol' 才计 — 与
 *      BlackSwanEvent.symbol 字段约束对齐: scope != 'symbol' 时 symbol 为 null)
 *   6. severity_critical_high: 同时给"critical + high" 严重事件清单 (≤ 20 条,
 *      detected_at desc), 供操盘手在邮件里看到"上季最值得回看的几件大事"
 *
 * 排序与 cap (全 export, 单测验证):
 *   - QUARTERLY_TOP_SYMBOLS_CAP = 15 (top_symbols 截断, 邮件正文表格 ≤ 15 行)
 *   - QUARTERLY_SEVERITY_HIGHLIGHT_CAP = 20 (critical+high 摘要列表)
 *   - 全部聚合 in-memory, 季度内事件数 cap 由调用方 loadEvents (5000) 守
 *
 * ============================================================================
 * fail-OPEN (与 BlackSwanPostmortemService / WeeklyReviewReportService 同款)
 * ============================================================================
 * - loadEvents throw → success=false + error: events_query_failed + 0 邮件发送;
 * - 邮件 transporter 不可用 / SMTP 缺配置 → skipped (不是 error);
 * - 收件人列表空 → skipped;
 * - dry_run=true → 仅聚合 + 返 payload, 不发邮件 (UI / ops 预览用);
 * - 单个收件人发送失败 → 累计 failed_recipients_count, 整体 success=true (其它
 *   收件人继续发);
 * - 邮件 buildEmail 抛错 → success=true 但 sent_count=0 (与 WeeklyReview 同款) + error.
 *
 * ============================================================================
 * idempotent (季度首日多次 cron tick 不会双发)
 * ============================================================================
 * 本 service 自身不持久化 "已发过" 状态 (引入新表成本高于价值); 依靠 cron 推荐
 * 表达式 '5 9 1 1,4,7,10 *' (每季首日 09:05 仅 1 次) 避免重复. ops 在 dry_run=true
 * 时主动重跑预览不会触发 SMTP. 若未来有强 idempotent 需求, 可加 QuarterlyReportLog
 * 表 INSERT ON CONFLICT (year, quarter, recipient) DO NOTHING.
 *
 * ============================================================================
 * SchedulerService 接入
 * ============================================================================
 *   `cronRegistry.ts`: type='BLACK_SWAN_QUARTERLY_SUMMARY',
 *     recommendedCron='5 9 1 1,4,7,10 *' (每季首日 09:05, 与 weekly_review 08:00 错峰).
 *   `SchedulerService._executeTaskLogic`: lazy-require runBlackSwanQuarterlyReport +
 *     getProductionQuarterlyRunner, 透传 parameters.dry_run + parameters.reference_date.
 */

import { logger } from '../utils/logger';
import {
  emailNotificationService,
  EmailNotificationSendResult,
  EmailPayload,
} from './EmailNotificationService';

// ============================================================================
// Types
// ============================================================================

/**
 * 单条 BlackSwanEvent snapshot — 仅含本 service 用到的字段, 与
 * BlackSwanEvent model schema 对齐.
 */
export interface QuarterlyBlackSwanEventSnapshot {
  id: number;
  detected_at: Date;
  event_type: string;
  severity: string;
  scope: string;
  symbol: string | null;
  title: string;
  signature: string;
}

/** 季度区间 (上海时区, 含起止两端). */
export interface QuarterRange {
  /** 4 位 year, e.g. 2026 */
  year: number;
  /** 1..4 */
  quarter: number;
  /** YYYY-MM-DD 起始日 (季度首日) */
  start_date: string;
  /** YYYY-MM-DD 结束日 (季度末日) */
  end_date: string;
  /** 季度天数 (89~92) — 给报告"覆盖率 days_with_events / days_in_quarter" 用 */
  days_in_quarter: number;
  /** 上海时区 startOfDay(start_date) UTC Date, loadEvents 用 */
  start_at: Date;
  /** 上海时区 endOfDay(end_date) UTC Date, loadEvents 用 */
  end_at: Date;
}

/** 单维度聚合行 (event_type / severity / scope 共用). */
export interface QuarterlyGroupRow {
  /** event_type / severity / scope 的值 (e.g. 'ST', 'high', 'symbol') */
  key: string;
  /** 该 key 命中的事件数 */
  count: number;
  /** count / total * 100, 保留 1 位小数 (e.g. 38.2) */
  pct: number;
}

/** top_symbols 行 (scope='symbol' 事件按 symbol 聚合). */
export interface QuarterlyTopSymbolRow {
  symbol: string;
  count: number;
  /** 该 symbol 命中的最严重 severity (优先级 critical > high > medium > low > unknown) */
  worst_severity: string;
  /** 该 symbol 最近一次事件的 detected_at ISO */
  last_detected_at: string;
}

/** 严重事件高亮 (critical + high) — 邮件正文列表. */
export interface QuarterlyHighlightRow {
  id: number;
  detected_at_iso: string;
  event_type: string;
  severity: string;
  scope: string;
  symbol: string | null;
  title: string;
}

/** 报告主 payload (聚合结果, 给 buildEmail 用). */
export interface QuarterlyReportPayload {
  quarter: QuarterRange;
  events_total: number;
  /** 季度内有事件命中的 distinct 日期数 (YYYY-MM-DD 去重, 上海时区) */
  days_with_events: number;
  by_event_type: QuarterlyGroupRow[];
  by_severity: QuarterlyGroupRow[];
  by_scope: QuarterlyGroupRow[];
  top_symbols: QuarterlyTopSymbolRow[];
  severity_highlights: QuarterlyHighlightRow[];
  generated_at_iso: string;
}

/** 单收件人发送结果. */
export interface QuarterlyRecipientResult {
  address: string;
  status: 'sent' | 'skipped' | 'failed';
  sent: boolean;
  message?: string;
  skip_reason?: string;
}

/** runBlackSwanQuarterlyReport 主返值. */
export interface BlackSwanQuarterlyReportResult {
  success: boolean;
  dry_run: boolean;
  quarter: QuarterRange | null;
  events_total: number;
  recipients_total: number;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  payload: QuarterlyReportPayload | null;
  per_recipient: QuarterlyRecipientResult[];
  /** 失败原因 (success=false 时必填; loadEvents throw / quarter 计算异常). */
  error?: string;
  /** generated_at (cron tick 起点, ISO string). */
  generated_at_iso: string;
}

/** runBlackSwanQuarterlyReport 调用选项. */
export interface RunBlackSwanQuarterlyReportOptions {
  /** dry_run=true → 不发邮件, 仅返聚合 payload. */
  dry_run?: boolean;
  /**
   * 覆盖 reference_date (YYYY-MM-DD 上海时区). 默认 = NOW.
   * 上一季 = quarterOfRefDate - 1 (跨年时年 - 1). 用于回填 / 单测.
   */
  reference_date?: string;
  /** 覆盖 generated_at (测试 / 回填); 默认 NOW. */
  generated_at?: Date;
  /** 显式 override 收件人 (不读 env). 用于单测或 ops 调用 /api 单发. */
  recipients_override?: string[];
}

/** QuarterlyReportRunner — DI 接口, 抽 sequelize / SMTP / env, 单测注入 fake. */
export interface QuarterlyReportRunner {
  /**
   * 拉取季度内所有 BlackSwanEvent.
   * - start_at ≤ detected_at ≤ end_at;
   * - 永不 throw — 失败返 ok:false + error.
   */
  loadEvents(input: {
    start_at: Date;
    end_at: Date;
  }): Promise<
    { ok: true; events: QuarterlyBlackSwanEventSnapshot[] } | { ok: false; error: string }
  >;

  /**
   * 列出 ops 收件人 (env QUARTERLY_BLACK_SWAN_RECIPIENTS 逗号分隔).
   * 永不 throw, 空 / 缺配置 → 空数组.
   */
  listRecipients(): Promise<string[]>;

  /**
   * 发送单封邮件. 复用 EmailNotificationService.sendEmail (与 WeeklyReview 同款).
   */
  sendEmail(
    payload: QuarterlyReportPayload,
    toAddress: string
  ): Promise<EmailNotificationSendResult>;
}

// ============================================================================
// 常量
// ============================================================================

/** 推荐 cron — 每季首日 09:05 跑一次. */
export const BLACK_SWAN_QUARTERLY_RECOMMENDED_CRON = '5 9 1 1,4,7,10 *';

/** top_symbols 截断 cap (邮件正文表格 ≤ 15 行). */
export const QUARTERLY_TOP_SYMBOLS_CAP = 15;

/** severity_highlights 截断 cap (critical+high 摘要). */
export const QUARTERLY_SEVERITY_HIGHLIGHT_CAP = 20;

/** loadEvents 单季最大事件数 (cap 防风暴, 一季实际通常 < 200 条). */
export const QUARTERLY_MAX_EVENTS = 5000;

/** severity 等级排序 (worst → best). */
const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// ============================================================================
// 纯函数 helpers (全 export 便于单测)
// ============================================================================

/**
 * 解析 YYYY-MM-DD → { year, month (1-12), day }. 非法返 null.
 * 不依赖 moment-timezone, 单测脱外部依赖.
 */
export function parseYmd(s: string): { year: number; month: number; day: number } | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!(year >= 1900 && year <= 9999)) return null;
  if (!(month >= 1 && month <= 12)) return null;
  if (!(day >= 1 && day <= 31)) return null;
  return { year, month, day };
}

/** month (1-12) → quarter (1-4). */
export function monthToQuarter(month: number): number {
  if (month < 1 || month > 12) return 0;
  return Math.ceil(month / 3);
}

/** quarter (1-4) → [startMonth, endMonth]. e.g. Q2 → [4, 6]. */
export function quarterMonths(quarter: number): [number, number] {
  const s = (quarter - 1) * 3 + 1;
  return [s, s + 2];
}

/** 季度末日 (28..31), 给定 year + quarter. */
export function lastDayOfQuarterMonth(year: number, quarter: number): number {
  const [, endMonth] = quarterMonths(quarter);
  // JS Date: new Date(year, month, 0) = 上月最末日, 用 month=endMonth (1-based + 1 偏移 = 直接传)
  // Date 构造: month 是 0-based, day=0 → 上月最末. 要 endMonth 的最末 → new Date(year, endMonth, 0).
  return new Date(year, endMonth, 0).getDate();
}

/**
 * 计算"上一季度"区间, 输入 reference_date (YYYY-MM-DD, 上海时区).
 * 非法 → null. Date 构造统一用 UTC (避免 jest/node 环境 TZ 差异); start_at / end_at
 * 用 Asia/Shanghai 转换 (UTC = local - 8h).
 */
export function computePrevQuarterRange(reference_date: string): QuarterRange | null {
  const parsed = parseYmd(reference_date);
  if (!parsed) return null;
  const refQuarter = monthToQuarter(parsed.month);
  if (refQuarter < 1) return null;
  let prevQ = refQuarter - 1;
  let prevYear = parsed.year;
  if (prevQ === 0) {
    prevQ = 4;
    prevYear = parsed.year - 1;
  }
  const [startMonth, endMonth] = quarterMonths(prevQ);
  const lastDay = lastDayOfQuarterMonth(prevYear, prevQ);
  const startDateStr = `${prevYear}-${String(startMonth).padStart(2, '0')}-01`;
  const endDateStr = `${prevYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(
    2,
    '0'
  )}`;

  // 上海时区 = UTC+8: 起 00:00:00 +08 = UTC 前一日 16:00:00; 末 23:59:59.999 +08 = UTC 当日 15:59:59.999
  // 用 Date.UTC 构造 + 减/加 8h. JS Date 内部存 UTC ms, 跨环境一致.
  const startUtcMs = Date.UTC(prevYear, startMonth - 1, 1, 0, 0, 0, 0) - 8 * 3600 * 1000;
  const endUtcMs = Date.UTC(prevYear, endMonth - 1, lastDay, 23, 59, 59, 999) - 8 * 3600 * 1000;

  // 季度天数: (endUtcMs - startUtcMs) / 86_400_000 ceil. Q1 (非闰年) 90, Q2 91, Q3 92, Q4 92.
  const days_in_quarter = Math.round((endUtcMs - startUtcMs + 1) / 86_400_000);

  return {
    year: prevYear,
    quarter: prevQ,
    start_date: startDateStr,
    end_date: endDateStr,
    days_in_quarter,
    start_at: new Date(startUtcMs),
    end_at: new Date(endUtcMs),
  };
}

/**
 * 单维度聚合 (event_type / severity / scope 共用). 排序: count desc, tie 按 key asc.
 * pct 保留 1 位小数; total=0 时 pct=0.
 */
export function aggregateByDimension(
  events: ReadonlyArray<QuarterlyBlackSwanEventSnapshot>,
  dimension: 'event_type' | 'severity' | 'scope'
): QuarterlyGroupRow[] {
  const map = new Map<string, number>();
  for (const e of events) {
    const v = (e[dimension] ?? '').toString();
    if (!v) continue;
    map.set(v, (map.get(v) || 0) + 1);
  }
  const total = events.length;
  const rows: QuarterlyGroupRow[] = [];
  for (const [key, count] of map) {
    const pct = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
    rows.push({ key, count, pct });
  }
  rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.key.localeCompare(b.key);
  });
  return rows;
}

/**
 * top_symbols 聚合 — 仅 scope='symbol' 且 symbol 非空; 排序 count desc, tie 按 symbol asc.
 * 同 symbol 多次事件 → 取最严重 severity + 最近 detected_at.
 */
export function aggregateTopSymbols(
  events: ReadonlyArray<QuarterlyBlackSwanEventSnapshot>,
  cap: number = QUARTERLY_TOP_SYMBOLS_CAP
): QuarterlyTopSymbolRow[] {
  type Acc = {
    count: number;
    worst_severity: string;
    last_detected_at: Date;
  };
  const map = new Map<string, Acc>();
  for (const e of events) {
    if (e.scope !== 'symbol') continue;
    if (!e.symbol) continue;
    const cur = map.get(e.symbol);
    if (!cur) {
      map.set(e.symbol, {
        count: 1,
        worst_severity: e.severity || 'unknown',
        last_detected_at: e.detected_at,
      });
      continue;
    }
    cur.count += 1;
    if (severityRank(e.severity) > severityRank(cur.worst_severity)) {
      cur.worst_severity = e.severity || cur.worst_severity;
    }
    if (e.detected_at.getTime() > cur.last_detected_at.getTime()) {
      cur.last_detected_at = e.detected_at;
    }
  }
  const rows: QuarterlyTopSymbolRow[] = [];
  for (const [symbol, acc] of map) {
    rows.push({
      symbol,
      count: acc.count,
      worst_severity: acc.worst_severity,
      last_detected_at: acc.last_detected_at.toISOString(),
    });
  }
  rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.symbol.localeCompare(b.symbol);
  });
  return rows.slice(0, Math.max(0, cap));
}

/** severity 等级排序值; 未知 severity → 0 (低于 low). */
export function severityRank(s: string | null | undefined): number {
  if (!s) return 0;
  return SEVERITY_RANK[String(s).toLowerCase()] ?? 0;
}

/**
 * critical + high 严重事件高亮列表 — 按 detected_at desc, cap 20 条.
 */
export function buildSeverityHighlights(
  events: ReadonlyArray<QuarterlyBlackSwanEventSnapshot>,
  cap: number = QUARTERLY_SEVERITY_HIGHLIGHT_CAP
): QuarterlyHighlightRow[] {
  const filtered = events.filter(e => {
    const r = severityRank(e.severity);
    return r >= SEVERITY_RANK.high;
  });
  filtered.sort((a, b) => b.detected_at.getTime() - a.detected_at.getTime());
  return filtered.slice(0, Math.max(0, cap)).map(e => ({
    id: e.id,
    detected_at_iso: e.detected_at.toISOString(),
    event_type: e.event_type,
    severity: e.severity,
    scope: e.scope,
    symbol: e.symbol,
    title: e.title || '',
  }));
}

/**
 * 季度内有事件命中的 distinct 日期数 (YYYY-MM-DD 上海时区).
 * 用 UTC+8 偏移把 detected_at (UTC) 转成上海时区当日字符串. 不依赖 moment-timezone.
 */
export function countDaysWithEvents(
  events: ReadonlyArray<QuarterlyBlackSwanEventSnapshot>
): number {
  const set = new Set<string>();
  for (const e of events) {
    const localMs = e.detected_at.getTime() + 8 * 3600 * 1000;
    const d = new Date(localMs);
    // 用 UTC accessors 读 "调整后" 时间 (避开 node 进程 TZ)
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    set.add(`${y}-${m}-${day}`);
  }
  return set.size;
}

/**
 * 解析 env QUARTERLY_BLACK_SWAN_RECIPIENTS — 逗号 / 分号 / 空白分隔, 去重 + trim.
 * 空 / undefined → 空数组. 单测脱 env (DI runner 自己调).
 */
export function parseRecipientsList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const parts = String(raw)
    .split(/[,;\s]+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
  return Array.from(new Set(parts));
}

/**
 * 主 payload builder — 把 events + quarter → 完整 QuarterlyReportPayload.
 * 纯函数, 不调 runner / DB.
 */
export function buildQuarterlyReportPayload(
  quarter: QuarterRange,
  events: ReadonlyArray<QuarterlyBlackSwanEventSnapshot>,
  generated_at: Date
): QuarterlyReportPayload {
  return {
    quarter,
    events_total: events.length,
    days_with_events: countDaysWithEvents(events),
    by_event_type: aggregateByDimension(events, 'event_type'),
    by_severity: aggregateByDimension(events, 'severity'),
    by_scope: aggregateByDimension(events, 'scope'),
    top_symbols: aggregateTopSymbols(events),
    severity_highlights: buildSeverityHighlights(events),
    generated_at_iso: generated_at.toISOString(),
  };
}

/**
 * HTML email 内容 builder — 与 EmailNotificationService.sendEmail.options.buildEmail
 * 的契约对齐 (payload → { subject, html, text? }).
 *
 * 邮件正文结构 (≤ 邮件 client 兼容性 — 仅用 inline-style + table, 不依赖外部 CSS):
 *   <h2> Q{N} YYYY 黑天鹅季度汇总
 *   <p> 总览: total / days_with_events / generated_at
 *   <h3> 按事件类型
 *   <table> by_event_type
 *   <h3> 按严重度
 *   <table> by_severity
 *   <h3> 按影响面
 *   <table> by_scope
 *   <h3> Top symbols
 *   <table> top_symbols
 *   <h3> 高严重度事件 (critical + high)
 *   <ul> severity_highlights
 *   <p> footer
 */
export function buildQuarterlyReportEmail(payload: QuarterlyReportPayload): EmailPayload {
  const q = payload.quarter;
  const subject = `[黑天鹅季度汇总] ${q.year} Q${q.quarter} (${q.start_date} ~ ${q.end_date}) — ${payload.events_total} 起事件`;

  const safe = (s: string | null | undefined): string => htmlEscape(s == null ? '' : String(s));

  const dimensionTable = (rows: QuarterlyGroupRow[], headerKey: string): string => {
    if (rows.length === 0) {
      return `<p style="color:#888;">(无数据)</p>`;
    }
    const headerHtml = `<thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ddd;">${safe(
      headerKey
    )}</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid #ddd;">事件数</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid #ddd;">占比</th></tr></thead>`;
    const bodyHtml = rows
      .map(
        r =>
          `<tr><td style="padding:4px 8px;border-bottom:1px solid #f0f0f0;">${safe(r.key)}</td>` +
          `<td style="padding:4px 8px;border-bottom:1px solid #f0f0f0;text-align:right;">${r.count}</td>` +
          `<td style="padding:4px 8px;border-bottom:1px solid #f0f0f0;text-align:right;">${r.pct.toFixed(
            1
          )}%</td></tr>`
      )
      .join('');
    return `<table style="border-collapse:collapse;font-size:13px;width:100%;">${headerHtml}<tbody>${bodyHtml}</tbody></table>`;
  };

  const topSymbolsTable = (() => {
    if (payload.top_symbols.length === 0) {
      return `<p style="color:#888;">(本季度无 scope=symbol 事件)</p>`;
    }
    const head = `<thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ddd;">Symbol</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid #ddd;">命中次数</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ddd;">最严重</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ddd;">最近触发</th></tr></thead>`;
    const body = payload.top_symbols
      .map(
        r =>
          `<tr><td style="padding:4px 8px;border-bottom:1px solid #f0f0f0;">${safe(
            r.symbol
          )}</td>` +
          `<td style="padding:4px 8px;border-bottom:1px solid #f0f0f0;text-align:right;">${r.count}</td>` +
          `<td style="padding:4px 8px;border-bottom:1px solid #f0f0f0;">${safe(
            r.worst_severity
          )}</td>` +
          `<td style="padding:4px 8px;border-bottom:1px solid #f0f0f0;font-family:monospace;">${safe(
            r.last_detected_at
          )}</td></tr>`
      )
      .join('');
    return `<table style="border-collapse:collapse;font-size:13px;width:100%;">${head}<tbody>${body}</tbody></table>`;
  })();

  const highlightsList = (() => {
    if (payload.severity_highlights.length === 0) {
      return `<p style="color:#888;">(本季度无 critical/high 事件)</p>`;
    }
    const items = payload.severity_highlights
      .map(
        r =>
          `<li style="margin-bottom:4px;"><strong>[${safe(r.severity)}]</strong> ` +
          `${safe(r.event_type)} · ${safe(r.symbol ?? r.scope)} — ` +
          `${safe(r.title)} ` +
          `<span style="color:#888;font-family:monospace;font-size:11px;">(${safe(
            r.detected_at_iso
          )})</span></li>`
      )
      .join('');
    return `<ul style="margin:0;padding-left:20px;font-size:13px;">${items}</ul>`;
  })();

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#222;max-width:760px;margin:auto;">` +
    `<h2 style="margin:0 0 12px;">${safe(q.year.toString())} Q${q.quarter} 黑天鹅季度汇总</h2>` +
    `<p style="margin:0 0 16px;color:#444;font-size:13px;">` +
    `覆盖 ${safe(q.start_date)} ~ ${safe(q.end_date)} (${q.days_in_quarter} 天) · ` +
    `共 <strong>${payload.events_total}</strong> 起事件 · ` +
    `<strong>${payload.days_with_events}</strong>/${q.days_in_quarter} 天有触发` +
    `</p>` +
    `<h3 style="margin:16px 0 8px;">按事件类型</h3>${dimensionTable(
      payload.by_event_type,
      '事件类型'
    )}` +
    `<h3 style="margin:16px 0 8px;">按严重度</h3>${dimensionTable(payload.by_severity, '严重度')}` +
    `<h3 style="margin:16px 0 8px;">按影响面</h3>${dimensionTable(payload.by_scope, '影响面')}` +
    `<h3 style="margin:16px 0 8px;">Top Symbols</h3>${topSymbolsTable}` +
    `<h3 style="margin:16px 0 8px;">高严重度事件 (critical + high, 最多 ${QUARTERLY_SEVERITY_HIGHLIGHT_CAP} 条)</h3>${highlightsList}` +
    `<p style="margin:24px 0 0;color:#888;font-size:12px;">` +
    `Generated at ${safe(
      payload.generated_at_iso
    )} · BlackSwanQuarterlyReportService (US-134 / PR-019)` +
    `</p>` +
    `</div>`;

  const text =
    `${q.year} Q${q.quarter} 黑天鹅季度汇总 (${q.start_date} ~ ${q.end_date}, ${q.days_in_quarter} 天)\n` +
    `共 ${payload.events_total} 起事件; ${payload.days_with_events}/${q.days_in_quarter} 天有触发\n\n` +
    `按事件类型: ${
      payload.by_event_type.map(r => `${r.key}=${r.count}(${r.pct.toFixed(1)}%)`).join(', ') ||
      '(无)'
    }\n` +
    `按严重度:   ${
      payload.by_severity.map(r => `${r.key}=${r.count}(${r.pct.toFixed(1)}%)`).join(', ') || '(无)'
    }\n` +
    `按影响面:   ${
      payload.by_scope.map(r => `${r.key}=${r.count}(${r.pct.toFixed(1)}%)`).join(', ') || '(无)'
    }\n\n` +
    `Top symbols:\n${
      payload.top_symbols
        .map(r => `  ${r.symbol} × ${r.count} (worst=${r.worst_severity})`)
        .join('\n') || '  (无)'
    }\n\n` +
    `高严重度事件:\n${
      payload.severity_highlights
        .map(
          r =>
            `  [${r.severity}] ${r.event_type} ${r.symbol ?? r.scope} ${r.title} @ ${
              r.detected_at_iso
            }`
        )
        .join('\n') || '  (无)'
    }\n\n` +
    `Generated at ${payload.generated_at_iso}`;

  return { subject, html, text };
}

/** 极简 HTML escape — 防 title / symbol 含 <script> 注入. */
function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, ch => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return ch;
    }
  });
}

// ============================================================================
// Service 主入口
// ============================================================================

/**
 * runBlackSwanQuarterlyReport — cron 主函数. 永不 throw; 失败返 success=false + error.
 *
 * 流程:
 *   1. computePrevQuarterRange(refDate) → quarter (null 立即返 error);
 *   2. runner.loadEvents(start_at, end_at) → events 列表 (fail-OPEN);
 *   3. buildQuarterlyReportPayload → payload;
 *   4. dry_run=true → return payload + per_recipient=[] (不发);
 *   5. runner.listRecipients (或 recipients_override) → addresses;
 *   6. 遍历 addresses, runner.sendEmail(payload, addr) → 累计 sent/skipped/failed.
 */
export async function runBlackSwanQuarterlyReport(
  runner: QuarterlyReportRunner,
  options: RunBlackSwanQuarterlyReportOptions = {}
): Promise<BlackSwanQuarterlyReportResult> {
  const dryRun = Boolean(options.dry_run);
  const generated_at = options.generated_at instanceof Date ? options.generated_at : new Date();
  const refDate = options.reference_date || nowShanghaiDate(generated_at);

  const baseResult: BlackSwanQuarterlyReportResult = {
    success: false,
    dry_run: dryRun,
    quarter: null,
    events_total: 0,
    recipients_total: 0,
    sent_count: 0,
    skipped_count: 0,
    failed_count: 0,
    payload: null,
    per_recipient: [],
    generated_at_iso: generated_at.toISOString(),
  };

  const quarter = computePrevQuarterRange(refDate);
  if (!quarter) {
    return { ...baseResult, error: `invalid_reference_date: ${refDate}` };
  }

  // Step 2: loadEvents — fail-OPEN
  const ev = await runner.loadEvents({ start_at: quarter.start_at, end_at: quarter.end_at });
  if (!ev.ok) {
    const errMsg = (ev as { ok: false; error: string }).error;
    logger.warn(`[BlackSwanQuarterly] loadEvents failed: ${errMsg}`);
    return {
      ...baseResult,
      quarter,
      error: `events_query_failed: ${errMsg}`,
    };
  }
  const events = ev.events || [];

  const payload = buildQuarterlyReportPayload(quarter, events, generated_at);

  // dry_run 预演
  if (dryRun) {
    return {
      ...baseResult,
      success: true,
      quarter,
      events_total: events.length,
      payload,
      per_recipient: [],
    };
  }

  // Step 5: 收件人列表
  let recipients: string[] = [];
  if (Array.isArray(options.recipients_override)) {
    recipients = options.recipients_override.filter(
      s => typeof s === 'string' && s.trim().length > 0
    );
  } else {
    try {
      recipients = await runner.listRecipients();
      if (!Array.isArray(recipients)) recipients = [];
    } catch (err: any) {
      logger.warn(`[BlackSwanQuarterly] listRecipients threw: ${err?.message || err}`);
      recipients = [];
    }
  }

  if (recipients.length === 0) {
    return {
      ...baseResult,
      success: true,
      quarter,
      events_total: events.length,
      payload,
      per_recipient: [],
      error: 'no_recipients_configured',
    };
  }

  // Step 6: 逐收件人 send
  let sent_count = 0;
  let skipped_count = 0;
  let failed_count = 0;
  const per_recipient: QuarterlyRecipientResult[] = [];
  for (const addr of recipients) {
    try {
      const res = await runner.sendEmail(payload, addr);
      if (res.success) {
        sent_count += 1;
        per_recipient.push({ address: addr, status: 'sent', sent: true });
      } else if (res.skipped) {
        skipped_count += 1;
        per_recipient.push({
          address: addr,
          status: 'skipped',
          sent: false,
          skip_reason: res.message,
        });
      } else {
        failed_count += 1;
        per_recipient.push({
          address: addr,
          status: 'failed',
          sent: false,
          message: res.message,
        });
      }
    } catch (err: any) {
      failed_count += 1;
      logger.warn(`[BlackSwanQuarterly] sendEmail to=${addr} threw: ${err?.message || err}`);
      per_recipient.push({
        address: addr,
        status: 'failed',
        sent: false,
        message: String(err?.message || err),
      });
    }
  }

  return {
    success: true,
    dry_run: false,
    quarter,
    events_total: events.length,
    recipients_total: recipients.length,
    sent_count,
    skipped_count,
    failed_count,
    payload,
    per_recipient,
    generated_at_iso: generated_at.toISOString(),
  };
}

/** 把 Date 转上海时区当日 YYYY-MM-DD (不依赖 moment-timezone, 与 countDaysWithEvents 同款). */
function nowShanghaiDate(d: Date): string {
  const localMs = d.getTime() + 8 * 3600 * 1000;
  const x = new Date(localMs);
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ============================================================================
// Production runner — lazy-require BlackSwanEvent + EmailNotificationService
// ============================================================================

/**
 * createProductionQuarterlyRunner — production singleton 工厂. 测试不调它.
 *
 * lazy-require 模式 (与 BlackSwanPostmortemService 同款): 单测 fake runner 时
 * 这些 require 不触发.
 */
export function createProductionQuarterlyRunner(): QuarterlyReportRunner {
  return {
    async loadEvents({ start_at, end_at }) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { BlackSwanEvent } = require('../models/BlackSwanEvent');
        const { Op } = require('sequelize');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const rows = await BlackSwanEvent.findAll({
          where: { detected_at: { [Op.between]: [start_at, end_at] } },
          order: [['detected_at', 'ASC']],
          limit: QUARTERLY_MAX_EVENTS,
          attributes: [
            'id',
            'detected_at',
            'event_type',
            'severity',
            'scope',
            'symbol',
            'title',
            'signature',
          ],
          raw: true,
        });
        const events: QuarterlyBlackSwanEventSnapshot[] = (Array.isArray(rows) ? rows : []).map(
          (r: any) => ({
            id: Number(r.id),
            detected_at: r.detected_at instanceof Date ? r.detected_at : new Date(r.detected_at),
            event_type: String(r.event_type || ''),
            severity: String(r.severity || ''),
            scope: String(r.scope || ''),
            symbol: r.symbol || null,
            title: String(r.title || ''),
            signature: String(r.signature || ''),
          })
        );
        return { ok: true as const, events };
      } catch (err: any) {
        return { ok: false as const, error: err?.message || String(err) };
      }
    },
    async listRecipients() {
      return parseRecipientsList(process.env.QUARTERLY_BLACK_SWAN_RECIPIENTS);
    },
    async sendEmail(payload, toAddress) {
      return emailNotificationService.sendEmail(payload, toAddress, {
        buildEmail: p => buildQuarterlyReportEmail(p as QuarterlyReportPayload),
      });
    },
  };
}

let _prodRunner: QuarterlyReportRunner | null = null;
/** Singleton (lazy). SchedulerService 复用. */
export function getProductionQuarterlyRunner(): QuarterlyReportRunner {
  if (!_prodRunner) _prodRunner = createProductionQuarterlyRunner();
  return _prodRunner;
}
