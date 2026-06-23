/**
 * DailyHealthReportService — Batch BF-4 (2026-06-23)
 *
 * Cron 触发 DAILY_HEALTH_REPORT (推荐 21:00 工作日, 盘后 + 当日 ETF/归因/AI 均已落库).
 * 把当日 7 个维度的健康指标聚合成一张卡片, 推到 Lark OPS 群 + 系统管理邮箱.
 *
 * 用户原话: "收盘后让 admin 一眼看到当天系统怎么样" — 与 DATA_FRESHNESS_CHECK
 * (18:30, "数据有没有到位") + RiskAlert HIGH push (实时, "出事了") 互补:
 * DAILY_HEALTH_REPORT 是 "回顾日报" 不是 "实时告警", 即便全 ok 也照发.
 *
 * 7 段:
 *   (1) 实盘下单 — LiveOrder 当日 created_at::date count + 成功率(status submitted/filled)
 *   (2) 实盘草稿拒绝 top 3 — LiveOrderDraft status=rejected 当日 reject_reason GROUP BY
 *   (3) 模拟盘下单 — PaperTradingTrade 当日 BUY count + SELL count + 平均 realized_pnl
 *   (4) cron 失败 — ScheduledTask is_active AND last_run_status='FAILED' AND last_run_at::date = today
 *   (5) RiskAlert HIGH+ top 10 — RiskAlert created_at::date = today + level IN ('HIGH','CRITICAL')
 *   (6) AI 引擎 — AIStockAnalysisReport 当日 count + 平均 latency_ms + fallback 率
 *   (7) factor std=0 异常 — factor_scores 最近 7 天 stddev(z_score) = 0 GROUP BY factor_name
 *
 * 路由 (复用 SystemAdminAlertPusher.pushSystemAdminAlert):
 *   - dedup_key = `daily-health:${trade_date}` — 同日只推 1 次 (1h dedup 内重启重复跑也不重推)
 *   - level = 'INFO' (即便有 fail/warn 也是 INFO; 真出事走 RiskAlert HIGH push)
 *   - title = `📅 ${trade_date} 系统日报 — 实盘N单/AI N调用/Alert NHigh`
 *
 * fail-OPEN: 任一 section 抛错 → 该段 placeholder '查询失败: <err>' + 不阻塞其他段 +
 * 不阻塞推送主流程. 报告本身 throw 不能让 cron markFailed (cron 仍是 'COMPLETED with
 * partial sections').
 *
 * 单测注入 fake DataSource 完全脱 DB.
 */

import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface LiveOrderSummary {
  total: number;
  by_status: Record<string, number>;
  /** submitted + filled + partially_filled */
  succeeded: number;
  /** rejected + cancelled + error */
  failed: number;
  success_rate: number; // 0..1
}

export interface RejectionReasonRow {
  reason: string;
  count: number;
}

export interface PaperTradingSummary {
  buy_count: number;
  sell_count: number;
  avg_realized_pnl: number | null;
  total_realized_pnl: number;
}

export interface CronFailureRow {
  id: number;
  type: string;
  name: string;
  consecutive_failure_count: number;
  last_run_at: string;
  last_error: string | null;
}

export interface RiskAlertRow {
  id: number;
  symbol: string | null;
  name: string | null;
  level: string;
  rule_id: string | null;
  created_at: string;
  message: string | null;
}

export interface AIEngineSummary {
  total: number;
  completed: number;
  partial: number;
  failed: number;
  avg_latency_ms: number | null;
  fallback_rate: number; // partial+failed / total
}

export interface FactorStdZeroRow {
  factor_name: string;
  observation_count: number;
}

export interface DailyHealthReport {
  trade_date: string;
  is_trading_day: boolean;
  generated_at: string;
  live_order: LiveOrderSummary;
  draft_rejection_top: RejectionReasonRow[];
  paper_trading: PaperTradingSummary;
  cron_failures: CronFailureRow[];
  risk_alerts_high: RiskAlertRow[];
  ai_engine: AIEngineSummary;
  factor_std_zero: FactorStdZeroRow[];
  /** 各段查询失败 reason map (key=section name, value=error message) */
  errors: Record<string, string>;
}

export interface DailyHealthReportDataSource {
  /** LiveOrder 当日 created_at::date = trade_date GROUP BY status. trade_date 上海 YYYY-MM-DD. */
  getLiveOrderStatusBreakdown(trade_date: string): Promise<Record<string, number>>;
  /** LiveOrderDraft 当日 status='rejected' GROUP BY rejection_reason ORDER BY count DESC LIMIT 3 */
  getDraftRejectionTopReasons(trade_date: string, limit: number): Promise<RejectionReasonRow[]>;
  /** PaperTradingTrade 当日 created_at::date = trade_date 聚合 */
  getPaperTradingSummary(trade_date: string): Promise<{
    buy_count: number;
    sell_count: number;
    avg_realized_pnl: number | null;
    total_realized_pnl: number;
  }>;
  /** ScheduledTask is_active AND last_run_status='FAILED' AND last_run_at::date = trade_date */
  getFailedCronsToday(trade_date: string): Promise<CronFailureRow[]>;
  /** RiskAlert created_at::date = trade_date AND level IN ('HIGH','CRITICAL') ORDER BY created_at DESC LIMIT */
  getRiskAlertsHighToday(trade_date: string, limit: number): Promise<RiskAlertRow[]>;
  /** AIStockAnalysisReport 当日 generated_at::date = trade_date 聚合 */
  getAiEngineSummary(trade_date: string): Promise<{
    total: number;
    completed: number;
    partial: number;
    failed: number;
    avg_latency_ms: number | null;
  }>;
  /** factor_scores trade_date >= since_date GROUP BY factor_name HAVING STDDEV(z_score)=0 OR NULL */
  getFactorStdZero(since_date: string): Promise<FactorStdZeroRow[]>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** 是否工作日 (0=Sun, 6=Sat → false). 周末 + 公共假期(粗判仅周末)不算. */
export function isTradingDay(date: Date): boolean {
  const d = date.getUTCDay();
  return d >= 1 && d <= 5;
}

/** 上海时区 YYYY-MM-DD. 输入 Date(UTC); 转 UTC+8. */
export function shanghaiYmd(date: Date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 上海时区 trade_date 减 N 日 */
export function shanghaiYmdMinusDays(date: Date, days: number): string {
  return shanghaiYmd(new Date(date.getTime() - days * 24 * 60 * 60 * 1000));
}

/** LiveOrder status → 成功 / 失败 / 中间态 分类 */
export function isLiveOrderStatusSuccess(status: string): boolean {
  const s = String(status || '').toLowerCase();
  return s === 'submitted' || s === 'filled' || s === 'partially_filled';
}

/** LiveOrder status → 失败终态 */
export function isLiveOrderStatusFailed(status: string): boolean {
  const s = String(status || '').toLowerCase();
  return s === 'rejected' || s === 'cancelled' || s === 'error' || s === 'failed';
}

/** 把 status breakdown 算 success_rate */
export function summarizeLiveOrders(
  by_status: Record<string, number>
): LiveOrderSummary {
  const safeStatus: Record<string, number> = {};
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  for (const [k, v] of Object.entries(by_status || {})) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    safeStatus[k] = n;
    total += n;
    if (isLiveOrderStatusSuccess(k)) succeeded += n;
    else if (isLiveOrderStatusFailed(k)) failed += n;
  }
  const decided = succeeded + failed;
  const success_rate = decided > 0 ? succeeded / decided : 0;
  return {
    total,
    by_status: safeStatus,
    succeeded,
    failed,
    success_rate: Math.round(success_rate * 10000) / 10000, // 4 位小数
  };
}

/** 把 rejection rows 排序 + 截断 */
export function topRejections(
  rows: RejectionReasonRow[],
  limit: number
): RejectionReasonRow[] {
  const safe = (rows || [])
    .filter(r => r && typeof r.reason === 'string' && r.reason.length > 0)
    .map(r => ({ reason: String(r.reason), count: Number(r.count) || 0 }));
  safe.sort((a, b) => b.count - a.count);
  return safe.slice(0, Math.max(0, limit));
}

/** AI engine summary 派生 */
export function summarizeAiEngine(raw: {
  total: number;
  completed: number;
  partial: number;
  failed: number;
  avg_latency_ms: number | null;
}): AIEngineSummary {
  const total = Math.max(0, Number(raw.total) || 0);
  const completed = Math.max(0, Number(raw.completed) || 0);
  const partial = Math.max(0, Number(raw.partial) || 0);
  const failed = Math.max(0, Number(raw.failed) || 0);
  const fallback = partial + failed;
  const fallback_rate = total > 0 ? fallback / total : 0;
  return {
    total,
    completed,
    partial,
    failed,
    avg_latency_ms: Number.isFinite(raw.avg_latency_ms as number)
      ? Math.round(Number(raw.avg_latency_ms))
      : null,
    fallback_rate: Math.round(fallback_rate * 10000) / 10000,
  };
}

/** 自然语言摘要 (1 行) */
export function buildOneLinerSummary(report: DailyHealthReport): string {
  const parts: string[] = [];
  parts.push(`实盘 ${report.live_order.total}/${formatPct(report.live_order.success_rate)}成功`);
  parts.push(`模拟 BUY${report.paper_trading.buy_count}/SELL${report.paper_trading.sell_count}`);
  parts.push(`AI ${report.ai_engine.total}/${formatPct(report.ai_engine.fallback_rate)}fallback`);
  parts.push(`告警 ${report.risk_alerts_high.length}HIGH`);
  parts.push(`cron失败 ${report.cron_failures.length}`);
  parts.push(`std0因子 ${report.factor_std_zero.length}`);
  return parts.join(' | ');
}

function formatPct(rate: number): string {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 'NA';
  return `${(n * 100).toFixed(1)}%`;
}

/** 报告 → Lark markdown body (pure, ≤ 2000 字符 lark 限制) */
export function buildHealthReportMarkdown(report: DailyHealthReport): string {
  const lines: string[] = [];
  lines.push(`**日期**: ${report.trade_date} (${report.is_trading_day ? '工作日' : '休市'})`);
  lines.push(`**摘要**: ${buildOneLinerSummary(report)}`);
  lines.push('');

  // (1) 实盘
  lines.push('**🏦 实盘下单**');
  const lo = report.live_order;
  if (lo.total === 0) {
    lines.push('  - 当日无实盘订单');
  } else {
    lines.push(
      `  - 总数 ${lo.total} | 成功 ${lo.succeeded} | 失败 ${lo.failed} | 成功率 ${formatPct(
        lo.success_rate
      )}`
    );
    const breakdown = Object.entries(lo.by_status)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    if (breakdown) lines.push(`  - 状态: ${breakdown}`);
  }

  // (2) draft rejection top 3
  if (report.draft_rejection_top.length > 0) {
    lines.push('  - 草稿拒绝原因 top 3:');
    for (const r of report.draft_rejection_top) {
      lines.push(`    - ${r.reason} × ${r.count}`);
    }
  }

  // (3) 模拟盘
  const pt = report.paper_trading;
  lines.push('');
  lines.push('**📈 模拟盘**');
  lines.push(
    `  - BUY ${pt.buy_count} | SELL ${pt.sell_count} | 总实现盈亏 ${
      pt.total_realized_pnl.toFixed(2)
    } 元 | 平均 ${pt.avg_realized_pnl != null ? pt.avg_realized_pnl.toFixed(2) + ' 元' : 'N/A'}`
  );

  // (4) cron 失败
  lines.push('');
  lines.push('**🔧 Cron 失败**');
  if (report.cron_failures.length === 0) {
    lines.push('  - 无失败');
  } else {
    for (const c of report.cron_failures.slice(0, 10)) {
      lines.push(
        `  - ${c.type} (连败 ${c.consecutive_failure_count}) ${
          c.last_error ? `- ${c.last_error.slice(0, 80)}` : ''
        }`
      );
    }
  }

  // (5) RiskAlert HIGH+
  lines.push('');
  lines.push('**🚨 RiskAlert HIGH+ (top 10)**');
  if (report.risk_alerts_high.length === 0) {
    lines.push('  - 无 HIGH/CRITICAL 告警');
  } else {
    for (const a of report.risk_alerts_high.slice(0, 10)) {
      const sym = a.symbol || 'SYSTEM';
      const tag = a.rule_id ? `[${a.rule_id}]` : '';
      const msg = (a.message || '').slice(0, 80);
      lines.push(`  - ${a.level} ${tag} ${sym} ${a.name || ''} — ${msg}`);
    }
  }

  // (6) AI engine
  const ai = report.ai_engine;
  lines.push('');
  lines.push('**🤖 AI 引擎**');
  if (ai.total === 0) {
    lines.push('  - 当日无 AI 调用');
  } else {
    lines.push(
      `  - 总 ${ai.total} | completed ${ai.completed} | partial ${ai.partial} | failed ${
        ai.failed
      } | fallback 率 ${formatPct(ai.fallback_rate)} | 平均延迟 ${
        ai.avg_latency_ms != null ? ai.avg_latency_ms + 'ms' : 'N/A'
      }`
    );
  }

  // (7) factor std=0
  lines.push('');
  lines.push('**📊 Factor std=0 异常 (最近 7 日)**');
  if (report.factor_std_zero.length === 0) {
    lines.push('  - 无异常因子');
  } else {
    const top = report.factor_std_zero.slice(0, 10);
    for (const f of top) {
      lines.push(`  - ${f.factor_name} (${f.observation_count} 行)`);
    }
    if (report.factor_std_zero.length > 10) {
      lines.push(`  - ... 还有 ${report.factor_std_zero.length - 10} 个`);
    }
  }

  // 各段错误
  const errorEntries = Object.entries(report.errors || {});
  if (errorEntries.length > 0) {
    lines.push('');
    lines.push('**⚠️ 查询失败段** (fail-OPEN, 报告仍可用)');
    for (const [section, msg] of errorEntries) {
      lines.push(`  - ${section}: ${msg.slice(0, 120)}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 报告 runner
// ---------------------------------------------------------------------------

export async function generateDailyHealthReport(
  ds: DailyHealthReportDataSource,
  now: Date = new Date()
): Promise<DailyHealthReport> {
  const trade_date = shanghaiYmd(now);
  const errors: Record<string, string> = {};

  let liveStatusBreakdown: Record<string, number> = {};
  try {
    liveStatusBreakdown = await ds.getLiveOrderStatusBreakdown(trade_date);
  } catch (err: any) {
    errors.live_order = err?.message || String(err);
  }
  const live_order = summarizeLiveOrders(liveStatusBreakdown);

  let draft_rejection_top: RejectionReasonRow[] = [];
  try {
    draft_rejection_top = topRejections(await ds.getDraftRejectionTopReasons(trade_date, 3), 3);
  } catch (err: any) {
    errors.draft_rejection = err?.message || String(err);
  }

  let paperTradingRaw: {
    buy_count: number;
    sell_count: number;
    avg_realized_pnl: number | null;
    total_realized_pnl: number;
  } = {
    buy_count: 0,
    sell_count: 0,
    avg_realized_pnl: null,
    total_realized_pnl: 0,
  };
  try {
    paperTradingRaw = await ds.getPaperTradingSummary(trade_date);
  } catch (err: any) {
    errors.paper_trading = err?.message || String(err);
  }
  const paper_trading: PaperTradingSummary = {
    buy_count: Math.max(0, Number(paperTradingRaw.buy_count) || 0),
    sell_count: Math.max(0, Number(paperTradingRaw.sell_count) || 0),
    avg_realized_pnl: Number.isFinite(paperTradingRaw.avg_realized_pnl as number)
      ? Math.round(Number(paperTradingRaw.avg_realized_pnl) * 100) / 100
      : null,
    total_realized_pnl:
      Math.round(Number(paperTradingRaw.total_realized_pnl || 0) * 100) / 100,
  };

  let cron_failures: CronFailureRow[] = [];
  try {
    cron_failures = (await ds.getFailedCronsToday(trade_date)) || [];
  } catch (err: any) {
    errors.cron_failures = err?.message || String(err);
  }

  let risk_alerts_high: RiskAlertRow[] = [];
  try {
    risk_alerts_high = (await ds.getRiskAlertsHighToday(trade_date, 10)) || [];
  } catch (err: any) {
    errors.risk_alerts = err?.message || String(err);
  }

  let aiRaw: {
    total: number;
    completed: number;
    partial: number;
    failed: number;
    avg_latency_ms: number | null;
  } = { total: 0, completed: 0, partial: 0, failed: 0, avg_latency_ms: null };
  try {
    aiRaw = await ds.getAiEngineSummary(trade_date);
  } catch (err: any) {
    errors.ai_engine = err?.message || String(err);
  }
  const ai_engine = summarizeAiEngine(aiRaw);

  let factor_std_zero: FactorStdZeroRow[] = [];
  try {
    factor_std_zero =
      (await ds.getFactorStdZero(shanghaiYmdMinusDays(now, 7))) || [];
  } catch (err: any) {
    errors.factor_std_zero = err?.message || String(err);
  }

  return {
    trade_date,
    is_trading_day: isTradingDay(now),
    generated_at: now.toISOString(),
    live_order,
    draft_rejection_top,
    paper_trading,
    cron_failures,
    risk_alerts_high,
    ai_engine,
    factor_std_zero,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Production DataSource — Sequelize / 真表查询
// ---------------------------------------------------------------------------

class DefaultDailyHealthReportDataSource implements DailyHealthReportDataSource {
  async getLiveOrderStatusBreakdown(trade_date: string): Promise<Record<string, number>> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LiveOrder } = require('../models/LiveOrder');
    const sequelize = LiveOrder.sequelize;
    if (!sequelize) return {};
    const [rows]: any = await sequelize.query(
      `SELECT status, COUNT(*) AS cnt FROM live_orders
       WHERE created_at AT TIME ZONE 'Asia/Shanghai' >= :since
         AND created_at AT TIME ZONE 'Asia/Shanghai' < :until
       GROUP BY status`,
      {
        replacements: {
          since: `${trade_date} 00:00:00`,
          until: `${trade_date} 23:59:59`,
        },
      }
    );
    const out: Record<string, number> = {};
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const k = String(r.status || '').trim();
        const v = Number(r.cnt || r.count || 0);
        if (k) out[k] = v;
      }
    }
    return out;
  }

  async getDraftRejectionTopReasons(
    trade_date: string,
    limit: number
  ): Promise<RejectionReasonRow[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LiveOrderDraft } = require('../models/LiveOrderDraft');
    const sequelize = LiveOrderDraft.sequelize;
    if (!sequelize) return [];
    // LiveOrderDraft 无 rejection_reason 列, 拒绝原因写在 metadata->>'reject_reason' 或 risk_check->>'reason'.
    // 试两个 JSON path, COALESCE 拿第一个非空; 仍为空走 risk_level 兜底标签.
    let rows: any[] = [];
    try {
      const [r]: any = await sequelize.query(
        `SELECT
           COALESCE(
             NULLIF(metadata->>'reject_reason', ''),
             NULLIF(metadata->>'reason', ''),
             NULLIF(risk_check->>'reason', ''),
             NULLIF(risk_check->>'block_reason', ''),
             'unspecified'
           ) AS reason,
           COUNT(*) AS cnt
         FROM live_order_drafts
         WHERE status IN ('rejected','blocked')
           AND created_at AT TIME ZONE 'Asia/Shanghai' >= :since
           AND created_at AT TIME ZONE 'Asia/Shanghai' < :until
         GROUP BY reason
         ORDER BY cnt DESC LIMIT :lim`,
        {
          replacements: {
            since: `${trade_date} 00:00:00`,
            until: `${trade_date} 23:59:59`,
            lim: Math.max(1, limit),
          },
        }
      );
      rows = Array.isArray(r) ? r : [];
    } catch {
      rows = [];
    }
    return rows.map(r => ({
      reason: String(r.reason || ''),
      count: Number(r.cnt || r.count || 0),
    }));
  }

  async getPaperTradingSummary(trade_date: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PaperTradingTrade } = require('../models/PaperTradingTrade');
    const sequelize = PaperTradingTrade.sequelize;
    if (!sequelize) return { buy_count: 0, sell_count: 0, avg_realized_pnl: null, total_realized_pnl: 0 };
    const [rows]: any = await sequelize.query(
      `SELECT direction, COUNT(*) AS cnt,
              SUM(COALESCE(realized_pnl,0)) AS sum_pnl,
              AVG(realized_pnl) AS avg_pnl
       FROM paper_trading_trades
       WHERE created_at AT TIME ZONE 'Asia/Shanghai' >= :since
         AND created_at AT TIME ZONE 'Asia/Shanghai' < :until
       GROUP BY direction`,
      {
        replacements: {
          since: `${trade_date} 00:00:00`,
          until: `${trade_date} 23:59:59`,
        },
      }
    );
    let buy = 0;
    let sell = 0;
    let totalPnl = 0;
    let sellAvg: number | null = null;
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const d = String(r.direction || '').toUpperCase();
        const n = Number(r.cnt || r.count || 0);
        const sumPnl = Number(r.sum_pnl || 0);
        if (d === 'BUY') buy = n;
        else if (d === 'SELL') {
          sell = n;
          sellAvg = r.avg_pnl != null ? Number(r.avg_pnl) : null;
        }
        if (Number.isFinite(sumPnl)) totalPnl += sumPnl;
      }
    }
    return {
      buy_count: buy,
      sell_count: sell,
      avg_realized_pnl: sellAvg,
      total_realized_pnl: totalPnl,
    };
  }

  async getFailedCronsToday(trade_date: string): Promise<CronFailureRow[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ScheduledTask } = require('../models/ScheduledTask');
    const sequelize = ScheduledTask.sequelize;
    if (!sequelize) return [];
    // LEFT JOIN task_execution_logs 最新一行拿 error_message (scheduled_tasks 自己没 last_error 列)
    const [rows]: any = await sequelize.query(
      `SELECT s.id, s.type, s.name, s.consecutive_failure_count, s.last_run_at,
              (SELECT l.error_message FROM task_execution_logs l
                 WHERE l.task_id = s.id AND l.status = 'FAILED'
                 ORDER BY l.completed_at DESC NULLS LAST, l.started_at DESC NULLS LAST
                 LIMIT 1) AS last_error
       FROM scheduled_tasks s
       WHERE s.is_active = true
         AND s.last_run_status = 'FAILED'
         AND s.last_run_at AT TIME ZONE 'Asia/Shanghai' >= :since
         AND s.last_run_at AT TIME ZONE 'Asia/Shanghai' < :until
       ORDER BY s.consecutive_failure_count DESC, s.last_run_at DESC
       LIMIT 20`,
      {
        replacements: {
          since: `${trade_date} 00:00:00`,
          until: `${trade_date} 23:59:59`,
        },
      }
    );
    return (rows || []).map((r: any) => ({
      id: Number(r.id),
      type: String(r.type || ''),
      name: String(r.name || ''),
      consecutive_failure_count: Number(r.consecutive_failure_count || 0),
      last_run_at:
        r.last_run_at instanceof Date
          ? r.last_run_at.toISOString()
          : String(r.last_run_at || ''),
      last_error: r.last_error ? String(r.last_error).slice(0, 200) : null,
    }));
  }

  async getRiskAlertsHighToday(trade_date: string, limit: number): Promise<RiskAlertRow[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RiskAlert } = require('../models/RiskAlert');
    const sequelize = RiskAlert.sequelize;
    if (!sequelize) return [];
    const [rows]: any = await sequelize.query(
      `SELECT id, symbol, name, level, rule_id, created_at, message
       FROM risk_alerts
       WHERE level IN ('HIGH','CRITICAL')
         AND created_at AT TIME ZONE 'Asia/Shanghai' >= :since
         AND created_at AT TIME ZONE 'Asia/Shanghai' < :until
       ORDER BY created_at DESC
       LIMIT :lim`,
      {
        replacements: {
          since: `${trade_date} 00:00:00`,
          until: `${trade_date} 23:59:59`,
          lim: Math.max(1, limit),
        },
      }
    );
    return (rows || []).map((r: any) => ({
      id: Number(r.id),
      symbol: r.symbol ? String(r.symbol) : null,
      name: r.name ? String(r.name) : null,
      level: String(r.level || ''),
      rule_id: r.rule_id ? String(r.rule_id) : null,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || ''),
      message: r.message ? String(r.message).slice(0, 200) : null,
    }));
  }

  async getAiEngineSummary(trade_date: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AIStockAnalysisReport } = require('../models/AIStockAnalysisReport');
    const sequelize = AIStockAnalysisReport.sequelize;
    if (!sequelize) return { total: 0, completed: 0, partial: 0, failed: 0, avg_latency_ms: null };
    // ai_stock_analysis_reports 没有显式 latency_ms 列, 派生 (updated_at - created_at) 作 latency 近似.
    // 多数行 status='completed' 落库瞬间 created_at ≈ updated_at = 0ms; 派生只有 partial / failed (重试场景)
    // 才显著. 取 EXTRACT(EPOCH FROM (updated_at - created_at))*1000 作 ms.
    const [rows]: any = await sequelize.query(
      `SELECT status, COUNT(*) AS cnt,
              AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) AS avg_lat
       FROM ai_stock_analysis_reports
       WHERE generated_at AT TIME ZONE 'Asia/Shanghai' >= :since
         AND generated_at AT TIME ZONE 'Asia/Shanghai' < :until
       GROUP BY status`,
      {
        replacements: {
          since: `${trade_date} 00:00:00`,
          until: `${trade_date} 23:59:59`,
        },
      }
    );
    let total = 0;
    let completed = 0;
    let partial = 0;
    let failed = 0;
    let weightedLatency = 0;
    let latencySamples = 0;
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const s = String(r.status || '').toLowerCase();
        const n = Number(r.cnt || r.count || 0);
        const lat = r.avg_lat != null ? Number(r.avg_lat) : null;
        total += n;
        if (s === 'completed') completed += n;
        else if (s === 'partial') partial += n;
        else if (s === 'failed') failed += n;
        if (lat != null && Number.isFinite(lat)) {
          weightedLatency += lat * n;
          latencySamples += n;
        }
      }
    }
    return {
      total,
      completed,
      partial,
      failed,
      avg_latency_ms: latencySamples > 0 ? weightedLatency / latencySamples : null,
    };
  }

  async getFactorStdZero(since_date: string): Promise<FactorStdZeroRow[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FactorScore } = require('../models/FactorScore');
    const sequelize = FactorScore.sequelize;
    if (!sequelize) return [];
    const [rows]: any = await sequelize.query(
      `SELECT factor_name, COUNT(*) AS cnt
       FROM factor_scores
       WHERE trade_date >= :since
       GROUP BY factor_name
       HAVING STDDEV(z_score) = 0 OR STDDEV(z_score) IS NULL
       ORDER BY cnt DESC`,
      { replacements: { since: since_date } }
    );
    return (rows || []).map((r: any) => ({
      factor_name: String(r.factor_name || ''),
      observation_count: Number(r.cnt || r.count || 0),
    }));
  }
}

export const PRODUCTION_DAILY_HEALTH_REPORT_DATA_SOURCE = new DefaultDailyHealthReportDataSource();

// ---------------------------------------------------------------------------
// 推送 wrapper (复用 SystemAdminAlertPusher)
// ---------------------------------------------------------------------------

export interface PushDailyHealthReportOptions {
  /** 测试 — 替换 pusher (默认 require('./SystemAdminAlertPusher').pushSystemAdminAlert) */
  pusher?: (input: any, options?: any) => Promise<any>;
  /** 测试 — 替换 ds (默认 PRODUCTION) */
  data_source?: DailyHealthReportDataSource;
  /** 测试 — 替换 now */
  now?: Date;
  /** dry_run = true: 仅生成报告不推 lark/email */
  dry_run?: boolean;
}

export interface PushDailyHealthReportResult {
  report: DailyHealthReport;
  push_attempted: boolean;
  push_result?: any;
  push_error?: string;
}

export async function generateAndPushDailyHealthReport(
  options: PushDailyHealthReportOptions = {}
): Promise<PushDailyHealthReportResult> {
  const ds = options.data_source || PRODUCTION_DAILY_HEALTH_REPORT_DATA_SOURCE;
  const now = options.now || new Date();
  let report: DailyHealthReport;
  try {
    report = await generateDailyHealthReport(ds, now);
  } catch (err: any) {
    logger.warn(`[DailyHealthReport] generateDailyHealthReport throw: ${err?.message || err}`);
    // fall back to empty placeholder
    report = {
      trade_date: shanghaiYmd(now),
      is_trading_day: isTradingDay(now),
      generated_at: now.toISOString(),
      live_order: { total: 0, by_status: {}, succeeded: 0, failed: 0, success_rate: 0 },
      draft_rejection_top: [],
      paper_trading: { buy_count: 0, sell_count: 0, avg_realized_pnl: null, total_realized_pnl: 0 },
      cron_failures: [],
      risk_alerts_high: [],
      ai_engine: { total: 0, completed: 0, partial: 0, failed: 0, avg_latency_ms: null, fallback_rate: 0 },
      factor_std_zero: [],
      errors: { generate: err?.message || String(err) },
    };
  }

  if (options.dry_run) {
    return { report, push_attempted: false };
  }

  // 推 Lark + email via SystemAdminAlertPusher (1h dedup by daily-health:date)
  const md = buildHealthReportMarkdown(report);
  const summary = buildOneLinerSummary(report);
  const title = `📅 ${report.trade_date} 系统日报 — ${summary.slice(0, 80)}`;
  let pushResult: any;
  let pushError: string | undefined;
  try {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const pusher =
      options.pusher || require('./SystemAdminAlertPusher').pushSystemAdminAlert;
    /* eslint-enable @typescript-eslint/no-var-requires */
    pushResult = await pusher({
      dedup_key: `daily-health:${report.trade_date}`,
      level: 'INFO',
      title,
      body_markdown: md.slice(0, 1900),
      triggered_at: report.generated_at,
    });
  } catch (err: any) {
    pushError = err?.message || String(err);
    logger.warn(`[DailyHealthReport] push throw: ${pushError}`);
  }
  return {
    report,
    push_attempted: true,
    push_result: pushResult,
    push_error: pushError,
  };
}
