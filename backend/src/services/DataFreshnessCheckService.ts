/**
 * DataFreshnessCheckService — Batch BF-3 (2026-06-23)
 *
 * Cron 触发 DATA_FRESHNESS_CHECK (推荐 18:00, 盘后 30min). 检查 5 项:
 *
 *   (1) realtime_quotes 工作日盘中 (9:30-15:00) 最大 updated_at > 1h → 阈值
 *   (2) daily_bars 最新 trade_date < today (工作日) → 阈值
 *   (3) factor_scores std=0 的因子数 > 2 个 (BC-5 后只该有 northbound)
 *   (4) scheduled_tasks 有任一 last_run_status='FAILED' 且 is_active=true
 *   (5) MarketSentimentIndex 最新 trade_date < today-1 (工作日) → 阈值
 *       (akshare invocation 没法直接查, 用 MarketSentimentIndex 代替"akshare 还活着")
 *
 * 命中任一阈值:
 *   - 写 RiskAlert level='MEDIUM' (user_id=1 系统 admin), rule_id='data_freshness'
 *   - 推 Lark OPS 群 (SystemAdminAlertPusher; dedup_key='freshness:run' 仅 1h 1 次)
 *
 * fail-OPEN: 任一检查 throw → continue + warn, 不阻塞其他检查 + 不阻塞主流程.
 *
 * 不依赖第三方数据源 — 全部走本地 DB SELECT MAX/COUNT. 单测注入 fake DataSource
 * 完全脱 DB.
 */

import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type FreshnessCheckStatus = 'ok' | 'warn' | 'fail';

export interface FreshnessCheckItem {
  key: string;
  display_name: string;
  status: FreshnessCheckStatus;
  /** 当前值 */
  current_value: any;
  /** 阈值描述 */
  threshold: string;
  /** 详情 */
  detail: string;
}

export interface FreshnessCheckReport {
  trade_date: string;
  is_trading_day: boolean;
  generated_at: string;
  items: FreshnessCheckItem[];
  fail_count: number;
  warn_count: number;
  ok_count: number;
}

export interface DataFreshnessCheckDataSource {
  /** realtime_quotes 表 MAX(updated_at) — 空表返 null */
  getRealtimeQuoteMaxUpdatedAt(): Promise<Date | null>;
  /** daily_bars 表 MAX(trade_date) — 空表返 null */
  getDailyBarMaxTradeDate(): Promise<string | null>;
  /** factor_scores 表: 按 factor_name 在最近 N 个交易日内, 找 stddev(z_score)=0 的因子.
   *  返 factor_name list. */
  getZeroStdFactors(trade_date_lower: string): Promise<string[]>;
  /** scheduled_tasks 表 SELECT 名 type status — 仅 is_active=true */
  listFailedScheduledTasks(): Promise<
    Array<{ id: number; type: string; name: string; consecutive_failure_count: number }>
  >;
  /** market_sentiment_index 表 MAX(trade_date) */
  getMarketSentimentMaxTradeDate(): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** 是否工作日 (0=Sun, 6=Sat → false). */
export function isTradingDay(date: Date): boolean {
  const d = date.getUTCDay();
  // 注意: 这里粗判周一~周五; 中国法定假日不 detect (会少量误报但不漏报).
  return d >= 1 && d <= 5;
}

/** 上海时区 YYYY-MM-DD */
export function shanghaiYmd(date: Date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 上海时区 HH (0..23) */
export function shanghaiHour(date: Date = new Date()): number {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.getUTCHours();
}

/** 工作日盘中 (9-15 上海时区) */
export function isIntraday(date: Date = new Date()): boolean {
  if (!isTradingDay(date)) return false;
  const h = shanghaiHour(date);
  return h >= 9 && h < 16;
}

/** dateA - dateB in days (正 = A 晚于 B) */
export function diffDays(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((da - db) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// 单项检查器 (Pure, 接 ds + 当前时间)
// ---------------------------------------------------------------------------

/**
 * realtime_quotes 检查:
 *   - 工作日盘中 (9:30-15:00 上海): MAX(updated_at) 必须 < 1h 内, 否则 fail
 *   - 非盘中: 不检查 (跳过 status=ok detail='非盘中时段')
 */
export async function checkRealtimeQuote(
  ds: DataFreshnessCheckDataSource,
  now: Date
): Promise<FreshnessCheckItem> {
  if (!isIntraday(now)) {
    return {
      key: 'realtime_quotes',
      display_name: '实时行情新鲜度',
      status: 'ok',
      current_value: null,
      threshold: '盘中 (9-16 上海) 1h 内',
      detail: '非盘中, 跳过 (盘后 stale 是预期)',
    };
  }
  let maxUpdatedAt: Date | null = null;
  try {
    maxUpdatedAt = await ds.getRealtimeQuoteMaxUpdatedAt();
  } catch (err: any) {
    return {
      key: 'realtime_quotes',
      display_name: '实时行情新鲜度',
      status: 'warn',
      current_value: null,
      threshold: '盘中 1h 内',
      detail: `查询失败: ${err?.message || err}`,
    };
  }
  if (!maxUpdatedAt) {
    return {
      key: 'realtime_quotes',
      display_name: '实时行情新鲜度',
      status: 'fail',
      current_value: null,
      threshold: '盘中 1h 内',
      detail: 'realtime_quotes 表 0 行 — 盘中无任何行情写入',
    };
  }
  const lagMs = now.getTime() - maxUpdatedAt.getTime();
  const lagMin = Math.round(lagMs / (60 * 1000));
  if (lagMs > 60 * 60 * 1000) {
    return {
      key: 'realtime_quotes',
      display_name: '实时行情新鲜度',
      status: 'fail',
      current_value: maxUpdatedAt.toISOString(),
      threshold: '盘中 1h 内',
      detail: `MAX(updated_at)=${maxUpdatedAt.toISOString()}, 已 stale ${lagMin}min (> 60min)`,
    };
  }
  return {
    key: 'realtime_quotes',
    display_name: '实时行情新鲜度',
    status: 'ok',
    current_value: maxUpdatedAt.toISOString(),
    threshold: '盘中 1h 内',
    detail: `MAX(updated_at)=${maxUpdatedAt.toISOString()}, lag=${lagMin}min`,
  };
}

/**
 * daily_bars 检查:
 *   - 工作日: MAX(trade_date) 必须 = today (盘后跑) 或 >= today-1 (盘前跑)
 *   - 非工作日: 跳过
 *
 * lag_max_days: 默认 1 (盘后 cron 跑 = 当日数据应已到位; 容忍 1 天延迟以防节假日补数迟到)
 */
export async function checkDailyBar(
  ds: DataFreshnessCheckDataSource,
  now: Date,
  lagMaxDays: number = 1
): Promise<FreshnessCheckItem> {
  if (!isTradingDay(now)) {
    return {
      key: 'daily_bars',
      display_name: '日 K 线最新日期',
      status: 'ok',
      current_value: null,
      threshold: `工作日 lag ≤ ${lagMaxDays} 日`,
      detail: '非工作日跳过',
    };
  }
  let maxDate: string | null = null;
  try {
    maxDate = await ds.getDailyBarMaxTradeDate();
  } catch (err: any) {
    return {
      key: 'daily_bars',
      display_name: '日 K 线最新日期',
      status: 'warn',
      current_value: null,
      threshold: `工作日 lag ≤ ${lagMaxDays} 日`,
      detail: `查询失败: ${err?.message || err}`,
    };
  }
  if (!maxDate) {
    return {
      key: 'daily_bars',
      display_name: '日 K 线最新日期',
      status: 'fail',
      current_value: null,
      threshold: `工作日 lag ≤ ${lagMaxDays} 日`,
      detail: 'daily_bars 表 0 行',
    };
  }
  const today = shanghaiYmd(now);
  const lag = diffDays(today, maxDate);
  if (lag > lagMaxDays) {
    return {
      key: 'daily_bars',
      display_name: '日 K 线最新日期',
      status: 'fail',
      current_value: maxDate,
      threshold: `工作日 lag ≤ ${lagMaxDays} 日`,
      detail: `MAX(trade_date)=${maxDate}, today=${today}, lag=${lag} 日`,
    };
  }
  return {
    key: 'daily_bars',
    display_name: '日 K 线最新日期',
    status: 'ok',
    current_value: maxDate,
    threshold: `工作日 lag ≤ ${lagMaxDays} 日`,
    detail: `MAX(trade_date)=${maxDate}, today=${today}, lag=${lag} 日`,
  };
}

/**
 * factor_scores 检查:
 *   - 找最近 7 个交易日内 stddev(z_score)=0 的因子数
 *   - BC-5 修复后只剩 northbound 一个 (已知 nodata fallback)
 *   - > 2 个 (即除 northbound 还多了别的) → fail
 */
export async function checkFactorStdZero(
  ds: DataFreshnessCheckDataSource,
  now: Date,
  threshold: number = 2,
  lookbackDays: number = 7
): Promise<FreshnessCheckItem> {
  const tradeDate = shanghaiYmd(new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000));
  let zeroFactors: string[] = [];
  try {
    zeroFactors = await ds.getZeroStdFactors(tradeDate);
  } catch (err: any) {
    return {
      key: 'factor_std_zero',
      display_name: '因子 std=0 异常',
      status: 'warn',
      current_value: null,
      threshold: `≤ ${threshold} 个`,
      detail: `查询失败: ${err?.message || err}`,
    };
  }
  if (zeroFactors.length > threshold) {
    return {
      key: 'factor_std_zero',
      display_name: '因子 std=0 异常',
      status: 'fail',
      current_value: zeroFactors,
      threshold: `≤ ${threshold} 个 (BC-5 后只该有 northbound)`,
      detail: `std=0 因子 ${zeroFactors.length} 个: ${zeroFactors.slice(0, 10).join(', ')}`,
    };
  }
  return {
    key: 'factor_std_zero',
    display_name: '因子 std=0 异常',
    status: 'ok',
    current_value: zeroFactors,
    threshold: `≤ ${threshold} 个`,
    detail:
      zeroFactors.length === 0
        ? '无 std=0 因子'
        : `std=0 因子 ${zeroFactors.length} 个 (符合预期): ${zeroFactors.join(', ')}`,
  };
}

/**
 * scheduled_tasks 检查:
 *   - is_active=true AND last_run_status='FAILED' 任一行 → warn
 *   - consecutive_failure_count >= 3 → fail
 */
export async function checkScheduledTasksFailed(
  ds: DataFreshnessCheckDataSource
): Promise<FreshnessCheckItem> {
  let failedTasks: Array<{
    id: number;
    type: string;
    name: string;
    consecutive_failure_count: number;
  }> = [];
  try {
    failedTasks = await ds.listFailedScheduledTasks();
  } catch (err: any) {
    return {
      key: 'scheduled_tasks_failed',
      display_name: 'scheduled_tasks 失败行',
      status: 'warn',
      current_value: null,
      threshold: '无 FAILED is_active=true',
      detail: `查询失败: ${err?.message || err}`,
    };
  }
  if (failedTasks.length === 0) {
    return {
      key: 'scheduled_tasks_failed',
      display_name: 'scheduled_tasks 失败行',
      status: 'ok',
      current_value: 0,
      threshold: '无 FAILED is_active=true',
      detail: '无 FAILED 任务',
    };
  }
  const severe = failedTasks.filter(t => (t.consecutive_failure_count || 0) >= 3);
  const summary = failedTasks
    .slice(0, 10)
    .map(t => `${t.type}(连败 ${t.consecutive_failure_count || 0})`)
    .join(', ');
  if (severe.length > 0) {
    return {
      key: 'scheduled_tasks_failed',
      display_name: 'scheduled_tasks 失败行',
      status: 'fail',
      current_value: failedTasks.length,
      threshold: '无 FAILED is_active=true',
      detail: `${failedTasks.length} 个 task FAILED, ${severe.length} 个 ≥ 3 连败: ${summary}`,
    };
  }
  return {
    key: 'scheduled_tasks_failed',
    display_name: 'scheduled_tasks 失败行',
    status: 'warn',
    current_value: failedTasks.length,
    threshold: '无 FAILED is_active=true',
    detail: `${failedTasks.length} 个 task FAILED: ${summary}`,
  };
}

/**
 * market_sentiment_index 检查 (代表 "akshare 还活着" 信号源):
 *   - MAX(trade_date) >= today-1 (工作日) → ok
 *   - lag > 2 日 → fail
 */
export async function checkMarketSentimentFresh(
  ds: DataFreshnessCheckDataSource,
  now: Date,
  lagMaxDays: number = 2
): Promise<FreshnessCheckItem> {
  let maxDate: string | null = null;
  try {
    maxDate = await ds.getMarketSentimentMaxTradeDate();
  } catch (err: any) {
    return {
      key: 'market_sentiment_index',
      display_name: '市场情绪指数新鲜度 (akshare 活性)',
      status: 'warn',
      current_value: null,
      threshold: `lag ≤ ${lagMaxDays} 日`,
      detail: `查询失败: ${err?.message || err}`,
    };
  }
  if (!maxDate) {
    return {
      key: 'market_sentiment_index',
      display_name: '市场情绪指数新鲜度 (akshare 活性)',
      status: 'warn',
      current_value: null,
      threshold: `lag ≤ ${lagMaxDays} 日`,
      detail: 'market_sentiment_index 表 0 行 (可能未初始化)',
    };
  }
  const today = shanghaiYmd(now);
  const lag = diffDays(today, maxDate);
  if (lag > lagMaxDays) {
    return {
      key: 'market_sentiment_index',
      display_name: '市场情绪指数新鲜度 (akshare 活性)',
      status: 'fail',
      current_value: maxDate,
      threshold: `lag ≤ ${lagMaxDays} 日`,
      detail: `MAX(trade_date)=${maxDate}, today=${today}, lag=${lag} 日`,
    };
  }
  return {
    key: 'market_sentiment_index',
    display_name: '市场情绪指数新鲜度 (akshare 活性)',
    status: 'ok',
    current_value: maxDate,
    threshold: `lag ≤ ${lagMaxDays} 日`,
    detail: `MAX(trade_date)=${maxDate}, lag=${lag} 日`,
  };
}

// ---------------------------------------------------------------------------
// 主 runner
// ---------------------------------------------------------------------------

export async function runDataFreshnessCheck(
  ds: DataFreshnessCheckDataSource,
  now: Date = new Date()
): Promise<FreshnessCheckReport> {
  const items: FreshnessCheckItem[] = [];

  const runners: Array<() => Promise<FreshnessCheckItem>> = [
    () => checkRealtimeQuote(ds, now),
    () => checkDailyBar(ds, now),
    () => checkFactorStdZero(ds, now),
    () => checkScheduledTasksFailed(ds),
    () => checkMarketSentimentFresh(ds, now),
  ];

  for (const runner of runners) {
    try {
      items.push(await runner());
    } catch (err: any) {
      logger.warn(`[DataFreshnessCheck] runner exception: ${err?.message || err}`);
      items.push({
        key: 'unknown',
        display_name: '未知检查项',
        status: 'warn',
        current_value: null,
        threshold: '-',
        detail: `runner 抛错: ${err?.message || err}`,
      });
    }
  }

  const fail_count = items.filter(i => i.status === 'fail').length;
  const warn_count = items.filter(i => i.status === 'warn').length;
  const ok_count = items.filter(i => i.status === 'ok').length;

  return {
    trade_date: shanghaiYmd(now),
    is_trading_day: isTradingDay(now),
    generated_at: now.toISOString(),
    items,
    fail_count,
    warn_count,
    ok_count,
  };
}

/**
 * 把 report 渲染成 lark markdown body — pure (test export)
 */
export function buildFreshnessReportMarkdown(report: FreshnessCheckReport): string {
  const lines: string[] = [];
  lines.push(`**汇总**: fail=${report.fail_count}, warn=${report.warn_count}, ok=${report.ok_count}`);
  lines.push(`**日期**: ${report.trade_date} (${report.is_trading_day ? '工作日' : '休市'})`);
  lines.push('');
  for (const it of report.items) {
    const emoji = it.status === 'fail' ? '🔴' : it.status === 'warn' ? '🟡' : '🟢';
    lines.push(`${emoji} **${it.display_name}** (${it.key})`);
    lines.push(`  状态: ${it.status} | 阈值: ${it.threshold}`);
    lines.push(`  详情: ${it.detail}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Production DataSource — Sequelize / 真表查询
// ---------------------------------------------------------------------------

class DefaultDataFreshnessCheckDataSource implements DataFreshnessCheckDataSource {
  async getRealtimeQuoteMaxUpdatedAt(): Promise<Date | null> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RealtimeQuote } = require('../models/RealtimeQuote');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fn, col } = require('sequelize');
    const r: any = await RealtimeQuote.findOne({
      attributes: [[fn('MAX', col('updated_at')), 'max_updated_at']],
      raw: true,
    });
    const m = r?.max_updated_at;
    if (!m) return null;
    return new Date(m);
  }

  async getDailyBarMaxTradeDate(): Promise<string | null> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DailyBar } = require('../models/DailyBar');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fn, col } = require('sequelize');
    const r: any = await DailyBar.findOne({
      attributes: [[fn('MAX', col('trade_date')), 'max_date']],
      raw: true,
    });
    const v = r?.max_date;
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
  }

  async getZeroStdFactors(trade_date_lower: string): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FactorScore } = require('../models/FactorScore');
    // raw query — Sequelize-typescript fn 表达能力有限, 直接 SQL.
    // 找 trade_date >= trade_date_lower 的 stddev(z_score)=0 的 factor_name.
    const sequelize = FactorScore.sequelize;
    if (!sequelize) return [];
    const [rows]: any = await sequelize.query(
      `SELECT factor_name FROM factor_scores WHERE trade_date >= :since
       GROUP BY factor_name
       HAVING STDDEV(z_score) = 0 OR STDDEV(z_score) IS NULL`,
      { replacements: { since: trade_date_lower } }
    );
    return Array.isArray(rows)
      ? rows.map((r: any) => String(r.factor_name)).filter(Boolean)
      : [];
  }

  async listFailedScheduledTasks() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ScheduledTask } = require('../models/ScheduledTask');
    const rows: any[] = await ScheduledTask.findAll({
      where: { is_active: true, last_run_status: 'FAILED' },
      attributes: ['id', 'type', 'name', 'consecutive_failure_count'],
      raw: true,
    });
    return (rows || []).map(r => ({
      id: Number(r.id),
      type: String(r.type || ''),
      name: String(r.name || ''),
      consecutive_failure_count: Number(r.consecutive_failure_count || 0),
    }));
  }

  async getMarketSentimentMaxTradeDate(): Promise<string | null> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MarketSentimentIndex } = require('../models/MarketSentimentIndex');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fn, col } = require('sequelize');
    const r: any = await MarketSentimentIndex.findOne({
      attributes: [[fn('MAX', col('trade_date')), 'max_date']],
      raw: true,
    });
    const v = r?.max_date;
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
  }
}

export const PRODUCTION_DATA_FRESHNESS_CHECK_DATA_SOURCE = new DefaultDataFreshnessCheckDataSource();
