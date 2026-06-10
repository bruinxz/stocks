/**
 * EarningsForecastWatcher — US-064 飞书业绩预告即时提醒
 *
 * 监听 `EarningsForecast` 表新增/修订的行，对每条新预告：
 *   - 若该 stock 在用户**持仓**中 → 立即推送飞书（intra-day cron 高频，命中
 *     即触发）；
 *   - 若该 stock 仅在用户**自选股**中 → 当日盘后聚合一条 digest（同股多份
 *     报告期合并，按 surprise → forecast_type → stock_code 排序），15:30
 *     post-close cron 推送。
 *
 * 推送内容（AC 指定）：
 *   - 股票代码 + 名称
 *   - 预告类型（预增 / 预减 / 扭亏 / 首亏 / 续盈 / 续亏 / 略增 / 略减 /
 *     不确定）
 *   - 净利润变化区间（profit_change_low / profit_change_high %）
 *   - 历史一致预期对比（用 AnalystForecast.forecast_eps_y1 取近 90 日内
 *     最新研报的均值，与本次 forecast 高低限对比；缺数据时显示"—"不阻塞）
 *   - 直达 AI 解读链接（前端 /workspace/portfolio?ai=<symbol> deeplink）
 *
 * 与现有 6 个 AI feature 范式 + US-063 推送范式一致：
 *   (1) **DataSource 接口注入** — `EarningsForecastWatcherDataSource` 5 method
 *       interface + `DefaultEarningsForecastWatcherDataSource` Sequelize impl
 *       + `PRODUCTION_EARNINGS_FORECAST_WATCHER_DATA_SOURCE` singleton + 构造
 *       器 default 注入（与 DailyTradingDigestService 一脉相承）；
 *   (2) **9+ 个 export 纯函数** 让单测覆盖边界 / NaN / 排序 / dedup：
 *       `pickForecastsForHolders` / `pickForecastsForWatchers` /
 *       `buildAnalystConsensusLine` / `buildEarningsForecastMessage` /
 *       `buildEarningsForecastCard` / `signatureForForecast` /
 *       `mergeSeenForecastSignatures` / `buildForecastDeeplink` /
 *       `normalizeEarningsForecastConfig` /
 *       `shouldSendEarningsForUser` / `formatProfitChangeRange` /
 *       `buildForecastEventId`；
 *   (3) **plain-object 返回类型** — `EarningsForecastSendResult.sent: boolean`
 *       + status='sent'/'skipped'/'failed'/'partial' 维度与 US-055 / US-063
 *       一致；
 *   (4) **status='partial'/'failed'/'skipped' 仍正常返回** 让 caller 看到
 *       （webhook 失败 / dedup 跳过都需 ops 审计）；
 *   (5) **fail-OPEN on saveSeen + sendFeishuCard** — 写 dedup buffer 失败不
 *       阻塞 trigger 返回，飞书 webhook 失败不阻塞下一个 user；
 *   (6) **双重防御 try/catch** — DataSource 实现层 + service 顶层 wrap，
 *       单 user 失败 trace 不串扰其他 user。
 *
 * 设计与 BlackSwanWatchdog (US-053) 同款 event-driven LRU dedup 模式（与
 * US-053 共享 `risk_config.<namespace>_seen` JSONB array LRU 200 条），
 * 复用：
 *   - `mergeSeenForecastSignatures` ← `BlackSwanWatchdog.mergeSeenSignatures`
 *     双子函数同样基于 FIFO LRU；
 *   - `signatureForForecast(announce_date, stock_code, report_period)` —
 *     同公司同公告日同报告期只触发一次（修订公告 = 新公告日 → 新 signature →
 *     允许再发）；
 *
 * 数据流（scheduler 入口）：
 *   1. cron `* /15 9-15 * * 1-5` (intra-day 持仓推送) → `scanHeldStocks()` —
 *      只取持仓股，dedup 后即时发；
 *   2. cron `30 15 * * 1-5` (post-close 自选汇总) → `scanWatchlistStocks()`
 *      → 聚合自选股当日新预告，一条 digest card 发出。
 *
 * 触发条件（per row）：
 *   - announce_date == 当日（intra-day）或 last_24h（首次冷启动）；
 *   - 持仓 path: position.symbol stripSuffix == EarningsForecast.stock_code；
 *   - 自选 path: favorite.stock.symbol stripSuffix == EarningsForecast.stock_code；
 *   - dedup 通过 → 写 signature 进 LRU buffer → push。
 *
 * 边界与坑（**测试必覆盖**）：
 *   - **修订预告 = 新行 = 不同 announce_date**：原 PK 是 (announce_date,
 *     stock_code, report_period)，修订公告日不同就是不同行；signature 也按
 *     此 3-tuple，自然不重复触发；
 *   - **同股同公告日多个 report_period**（年报 + Q1）：每个 report_period 单
 *     独发一条；
 *   - **`forecast_type=null` 也能触发**（罕见，AKShare 偶尔少字段）—— UI 显
 *     示"未知"，不阻塞 push；
 *   - **profit_change_low/high 都 null**：仍然 push（AC "净利润变化区间"
 *     缺数据用 "—" 兜底）；
 *   - **AnalystForecast 数据缺**：consensus line 显示"—"，不阻塞 push；
 *   - **持仓和自选都包含同一只股**：以**持仓优先**路径触发（intra-day），自
 *     选 path 跳过；保证用户不会收到两条；
 *   - **`is_surprise=true` 不是触发前置条件**：用户希望看到全部预告，is_surprise
 *     用于 card header 颜色（surprise=红, predown=蓝, 其他=灰）；
 *   - **持仓 watcher cron 跑 4 次/小时**：dedup buffer 阻止重复 push；首次
 *     冷启动也只发一次（signature 内含 announce_date 自然唯一）；
 *   - **dry_run=true**：返回完整 payload 但不发 webhook + 不写 dedup buffer
 *     （让用户多次预演同一份）；
 *   - **AC "当日盘后汇总推送" 表示 "watchlist 路径"**：单日多预告聚成一条
 *     card；与"持仓"的"每条单独 card"互补，避免持仓告警被汇总埋没。
 */

import { Op } from 'sequelize';
import moment from 'moment-timezone';

import { logger } from '../utils/logger';
import { User } from '../models/User';
import { EarningsForecast } from '../models/EarningsForecast';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { FavoriteStock } from '../models/FavoriteStock';
import { Stock } from '../models/Stock';
import { AnalystForecast } from '../models/AnalystForecast';
import { feishuBotWebhookService, FeishuBotWebhookSendResult } from './FeishuBotWebhookService';
import {
  normalizeNotificationConfig,
  NotificationChannelsConfig,
} from './DailyTradingDigestService';

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

export const EARNINGS_FORECAST_STATUS = Object.freeze({
  SENT: 'sent',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  PARTIAL: 'partial',
} as const);

export type EarningsForecastStatus =
  (typeof EARNINGS_FORECAST_STATUS)[keyof typeof EARNINGS_FORECAST_STATUS];

export const EARNINGS_FORECAST_PATH = Object.freeze({
  /** 持仓股触发 — 即时推送，每条预告独立 card。 */
  HELD: 'held',
  /** 自选股触发 — 当日聚合，一条 digest card。 */
  WATCHLIST: 'watchlist',
} as const);

export type EarningsForecastPath =
  (typeof EARNINGS_FORECAST_PATH)[keyof typeof EARNINGS_FORECAST_PATH];

/** LRU dedup buffer 上限 — 防 JSONB 无限增长（与 BlackSwanWatchdog 一致 200）。 */
export const EARNINGS_FORECAST_SEEN_LRU_LIMIT = 200;

/** 一致预期 lookback 窗口（天）— 用近 N 日内的研报取最新 EPS 均值。 */
export const ANALYST_CONSENSUS_LOOKBACK_DAYS = 90;

/** AnalystForecast 一致预期最少需要的研报数（少于此数视为缺数据）。 */
export const ANALYST_CONSENSUS_MIN_REPORTS = 2;

/** 一条公告 announce_date 距今超过 N 天则视为太老不再推送（默认 7 天）。 */
export const DEFAULT_RECENT_DAYS = 7;

/** AI 解读 deeplink 前缀（前端 / workspace/portfolio?ai=<symbol>）。 */
const DEFAULT_FRONTEND_BASE = 'http://localhost:3000';

// ---------------------------------------------------------------------------
//  Domain types
// ---------------------------------------------------------------------------

export interface EarningsForecastRow {
  announce_date: string;
  stock_code: string;
  stock_name: string | null;
  report_period: string;
  forecast_type: string | null;
  profit_change_low: number | null;
  profit_change_high: number | null;
  profit_low: number | null;
  profit_high: number | null;
  forecast_reason: string | null;
  is_surprise: boolean;
}

/** 一条公告 + 用户上下文 + AI link，构造 card 用。 */
export interface EarningsForecastEventPayload {
  event_id: string;
  user_id: number;
  username: string;
  path: EarningsForecastPath;
  symbol: string;
  stock_name: string;
  forecast: EarningsForecastRow;
  /** AnalystForecast 取的一致预期（缺数据时 null）。 */
  analyst_consensus: AnalystConsensus | null;
  /** 直达 AI 解读链接。 */
  deeplink_url: string;
  /** ISO timestamp string，发出时刻。 */
  pushed_at: string;
}

export interface AnalystConsensus {
  /** 一致预期 EPS（元/股）— 近 N 日内所有研报 forecast_eps_y1 的均值。 */
  consensus_eps_y1: number;
  /** 取了多少份研报。 */
  report_count: number;
  /** 最近一份研报日期。 */
  latest_report_date: string;
  /** 一致预期对应年份。 */
  forecast_year_y1: number | null;
}

export interface EarningsForecastSendResult {
  event_id: string;
  status: EarningsForecastStatus;
  /** 实际是否发了 webhook（dedup / dry_run / 配置关 / 失败 = false）。 */
  sent: boolean;
  user_id: number;
  username: string;
  path: EarningsForecastPath;
  symbol: string;
  signature: string;
  payload?: EarningsForecastEventPayload;
  webhook_url_used?: string;
  webhook_response?: any;
  /** failed/partial 时填错误信息。 */
  error?: string;
  /** skipped 时填原因（dedup / 配置关 / 无 webhook）。 */
  skip_reason?: string;
}

/** 单用户的 watchlist 汇总 card 结果。 */
export interface EarningsForecastWatchlistResult {
  event_id: string;
  status: EarningsForecastStatus;
  sent: boolean;
  user_id: number;
  username: string;
  signature: string;
  forecast_count: number;
  symbols: string[];
  payload?: EarningsForecastWatchlistPayload;
  webhook_url_used?: string;
  webhook_response?: any;
  error?: string;
  skip_reason?: string;
}

export interface EarningsForecastWatchlistPayload {
  event_id: string;
  user_id: number;
  username: string;
  trade_date: string;
  rows: Array<{
    forecast: EarningsForecastRow;
    analyst_consensus: AnalystConsensus | null;
    deeplink_url: string;
  }>;
  pushed_at: string;
}

export interface ScanResult {
  trade_date: string;
  scanned_users: number;
  scanned_forecasts: number;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  dry_run: boolean;
  per_event: EarningsForecastSendResult[];
}

export interface ScanWatchlistResult {
  trade_date: string;
  scanned_users: number;
  scanned_forecasts: number;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  dry_run: boolean;
  per_user: EarningsForecastWatchlistResult[];
}

export interface ScanHeldOptions {
  /** 仅评估单个 user，缺省 = 所有 is_active 且 daily_digest=true 的用户。 */
  user_id?: number;
  /** 覆盖 trade_date，缺省 = 上海时区当前日期。 */
  trade_date?: string;
  /** 不实际推送 webhook + 不写 dedup buffer。 */
  dry_run?: boolean;
  /** 公告日距今超过 N 天的预告跳过（防冷启动暴推），缺省 = DEFAULT_RECENT_DAYS。 */
  recent_days?: number;
  /** 前端 base URL（构造 AI deeplink 用），缺省 = process.env.FRONTEND_BASE_URL || DEFAULT_FRONTEND_BASE。 */
  frontend_base_url?: string;
}

export interface ScanWatchlistOptions {
  user_id?: number;
  trade_date?: string;
  dry_run?: boolean;
  recent_days?: number;
  frontend_base_url?: string;
}

// ---------------------------------------------------------------------------
//  Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 净化 raw user.risk_config.earnings_alert（基于 NotificationChannelsConfig.feishu.earnings_alert
 * 这个 boolean 子开关）+ 顶层 enabled / webhook_url，沿用 US-063 normalizeNotificationConfig
 * 走完全部嵌套结构。
 */
export function normalizeEarningsForecastConfig(raw: any): NotificationChannelsConfig {
  return normalizeNotificationConfig(raw);
}

/**
 * 判定本 user 本次 trade_date 是否应推送：
 *   feishu.enabled && feishu.earnings_alert && webhook_url 非空（或 env 已配）
 */
export function shouldSendEarningsForUser(
  config: NotificationChannelsConfig,
  hasFallbackEnvWebhook: boolean
): { shouldSend: boolean; reason?: string } {
  if (!config.feishu.enabled) {
    return { shouldSend: false, reason: 'feishu 通道未启用' };
  }
  if (!config.feishu.earnings_alert) {
    return { shouldSend: false, reason: '用户已关闭业绩预告提醒' };
  }
  const hasUrl = !!String(config.feishu.webhook_url || '').trim();
  if (!hasUrl && !hasFallbackEnvWebhook) {
    return { shouldSend: false, reason: '未配置 feishu webhook URL' };
  }
  return { shouldSend: true };
}

/**
 * 'sh.600519' / '600519.SH' / '600519' → '600519' （6 位无后缀）。
 * 兼容前缀型 sh./sz./bj. 与后缀型 .SH/.SZ/.BJ。
 */
export function stripSymbolSuffix(symbol: string): string {
  if (typeof symbol !== 'string') return symbol as any;
  const trimmed = symbol.trim().toLowerCase();
  if (trimmed.startsWith('sh.') || trimmed.startsWith('sz.') || trimmed.startsWith('bj.')) {
    return trimmed.slice(3);
  }
  const dotIdx = symbol.indexOf('.');
  if (dotIdx > 0) return symbol.slice(0, dotIdx);
  return symbol;
}

/**
 * 用持仓股 set 过滤当日预告 — 返回 (forecast × position) 笛卡尔交集。
 * 持仓 set 形态: Set<6 位 code>（caller 已 stripSuffix）。
 */
export function pickForecastsForHolders(
  forecasts: EarningsForecastRow[],
  heldStockCodes: Set<string>
): EarningsForecastRow[] {
  if (!Array.isArray(forecasts) || heldStockCodes.size === 0) return [];
  return forecasts.filter(f => f && f.stock_code && heldStockCodes.has(f.stock_code));
}

/**
 * 用自选股 set 过滤当日预告，**排除持仓股**（持仓股优先走 held path），
 * 然后按 (is_surprise desc, forecast_type 字典, stock_code asc) 稳定排序。
 */
export function pickForecastsForWatchers(
  forecasts: EarningsForecastRow[],
  watchedStockCodes: Set<string>,
  heldStockCodes: Set<string>
): EarningsForecastRow[] {
  if (!Array.isArray(forecasts) || watchedStockCodes.size === 0) return [];
  const filtered = forecasts.filter(
    f =>
      f && f.stock_code && watchedStockCodes.has(f.stock_code) && !heldStockCodes.has(f.stock_code)
  );
  filtered.sort((a, b) => {
    const sa = a.is_surprise ? 1 : 0;
    const sb = b.is_surprise ? 1 : 0;
    if (sb !== sa) return sb - sa;
    const ta = a.forecast_type || '';
    const tb = b.forecast_type || '';
    if (ta !== tb) return ta.localeCompare(tb);
    return (a.stock_code || '').localeCompare(b.stock_code || '');
  });
  return filtered;
}

/**
 * dedup signature — 同公告日同股票同报告期只触发一次（修订公告 = 新公告日 →
 * 新 signature → 允许再发；同 user path 也区分，HELD 与 WATCHLIST 共用同 PK
 * 不重复因 watchlist 已排除 held）。
 *
 * `HELD::ANN::<stock_code>::<announce_date>::<report_period>`
 * `WATCHLIST::ANN::<stock_code>::<announce_date>::<report_period>`
 */
export function signatureForForecast(input: {
  path: EarningsForecastPath;
  stock_code: string;
  announce_date: string;
  report_period: string;
}): string {
  return `${input.path.toUpperCase()}::ANN::${input.stock_code}::${input.announce_date}::${
    input.report_period
  }`;
}

/**
 * FIFO LRU merge — 与 BlackSwanWatchdog.mergeSeenSignatures 镜像逻辑。
 * 同 signature 重复时 bump 到末尾刷新位置，head 超过 limit 时 drop 老的。
 */
export function mergeSeenForecastSignatures(
  existing: string[] | null | undefined,
  newOnes: string[],
  limit: number = EARNINGS_FORECAST_SEEN_LRU_LIMIT
): string[] {
  const exist = Array.isArray(existing) ? existing.filter(s => typeof s === 'string') : [];
  const seen = new Set(exist);
  const out: string[] = [...exist];
  for (const sig of newOnes) {
    if (typeof sig !== 'string') continue;
    if (seen.has(sig)) {
      const idx = out.indexOf(sig);
      if (idx >= 0) out.splice(idx, 1);
    } else {
      seen.add(sig);
    }
    out.push(sig);
  }
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : EARNINGS_FORECAST_SEEN_LRU_LIMIT;
  if (out.length > safeLimit) {
    return out.slice(out.length - safeLimit);
  }
  return out;
}

/**
 * 构造 AI 解读 deeplink — 前端 /workspace/portfolio?ai=<symbol>&announce=<date>。
 * 用 URL 标准方法编码，base 缺省自 env。
 */
export function buildForecastDeeplink(
  stockCode: string,
  announceDate: string,
  reportPeriod: string,
  baseUrl: string = DEFAULT_FRONTEND_BASE
): string {
  const safeBase = String(baseUrl || DEFAULT_FRONTEND_BASE).replace(/\/+$/, '');
  const sp = new URLSearchParams({
    ai: stockCode,
    announce: announceDate,
    period: reportPeriod,
    type: 'earnings_forecast',
  });
  return `${safeBase}/workspace/portfolio?${sp.toString()}`;
}

/**
 * 业务 ID：`EARN-{user_id}-{path}-{YYYYMMDD}-{rand4}` （US-055 命名范式 + path 后缀）。
 */
export function buildForecastEventId(
  user_id: number,
  path: EarningsForecastPath,
  announce_date: string,
  rand4Hex: string
): string {
  const ymd = String(announce_date).replace(/-/g, '');
  const rand = String(rand4Hex || '')
    .slice(0, 4)
    .padStart(4, '0');
  return `EARN-${user_id}-${path.toUpperCase()}-${ymd}-${rand}`;
}

/**
 * 格式化净利润变化区间为人类可读字符串：
 *   - 都有：'+50.0% ~ +80.0%'
 *   - 仅 low：'≥ +50.0%'
 *   - 仅 high：'≤ +80.0%'
 *   - 都没有：'—'
 */
export function formatProfitChangeRange(low: number | null, high: number | null): string {
  const hasLow = low !== null && low !== undefined && Number.isFinite(Number(low));
  const hasHigh = high !== null && high !== undefined && Number.isFinite(Number(high));
  const fmt = (v: number) => {
    const n = Number(v);
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
  };
  if (hasLow && hasHigh) return `${fmt(Number(low))} ~ ${fmt(Number(high))}`;
  if (hasLow) return `≥ ${fmt(Number(low))}`;
  if (hasHigh) return `≤ ${fmt(Number(high))}`;
  return '—';
}

/**
 * 拼装一致预期文本，'近 N 日 K 家机构均值 EPS=X.XX 元/股（Y 年度）'；
 * consensus=null → '—'。
 */
export function buildAnalystConsensusLine(consensus: AnalystConsensus | null): string {
  if (!consensus) return '—';
  const yr = consensus.forecast_year_y1 ? `（${consensus.forecast_year_y1} 年度）` : '';
  return `近 ${ANALYST_CONSENSUS_LOOKBACK_DAYS} 日 ${
    consensus.report_count
  } 家机构均值 EPS=${consensus.consensus_eps_y1.toFixed(3)} 元/股${yr}`;
}

/**
 * 拼装中文人类可读 message（单条公告，给 RiskAlert / log / fallback 用）。
 */
export function buildEarningsForecastMessage(input: {
  symbol: string;
  stock_name: string;
  forecast: EarningsForecastRow;
  analyst_consensus: AnalystConsensus | null;
  deeplink_url: string;
}): string {
  const f = input.forecast;
  const ftype = f.forecast_type || '未知类型';
  const surpriseTag = f.is_surprise ? '【超预期】' : '';
  const range = formatProfitChangeRange(f.profit_change_low, f.profit_change_high);
  const consensus = buildAnalystConsensusLine(input.analyst_consensus);
  return (
    `${surpriseTag}${input.symbol}（${input.stock_name}）发布 ${f.report_period} 业绩预告：` +
    `${ftype}，净利润变化 ${range}。一致预期：${consensus}。AI 解读 → ${input.deeplink_url}`
  );
}

/**
 * 构造单条业绩预告 飞书 interactive card。
 * 不直接调 webhook —— `sendFeishuCard` 才发；本函数只产出 card object 便于单测断言。
 */
export function buildEarningsForecastCard(payload: EarningsForecastEventPayload): {
  msg_type: 'interactive';
  card: {
    header: { template: string; title: { content: string; tag: 'plain_text' } };
    elements: any[];
  };
} {
  const f = payload.forecast;
  // header: surprise=红 (positive), 预增/扭亏/续盈/略增=红, 预减/首亏/续亏/略减=绿, 其他=蓝
  const positiveTypes = new Set(['预增', '扭亏', '续盈', '略增']);
  const negativeTypes = new Set(['预减', '首亏', '续亏', '略减']);
  const ftype = f.forecast_type || '';
  const headerTemplate = f.is_surprise
    ? 'red'
    : positiveTypes.has(ftype)
    ? 'red'
    : negativeTypes.has(ftype)
    ? 'green'
    : 'blue';

  const elements: any[] = [];

  // Section 1: header line
  const surpriseTag = f.is_surprise ? ' 🚀【超预期】' : '';
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${payload.symbol} ${payload.stock_name}${surpriseTag}**`,
    },
  });

  // Section 2: kpi grid
  const range = formatProfitChangeRange(f.profit_change_low, f.profit_change_high);
  elements.push({
    tag: 'div',
    fields: [
      {
        is_short: true,
        text: { tag: 'lark_md', content: `**预告类型**\n${ftype || '未知'}` },
      },
      {
        is_short: true,
        text: { tag: 'lark_md', content: `**报告期**\n${f.report_period}` },
      },
      {
        is_short: true,
        text: { tag: 'lark_md', content: `**净利润变化**\n${range}` },
      },
      {
        is_short: true,
        text: { tag: 'lark_md', content: `**公告日**\n${f.announce_date}` },
      },
    ],
  });
  elements.push({ tag: 'hr' });

  // Section 3: analyst consensus
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**一致预期**\n${buildAnalystConsensusLine(payload.analyst_consensus)}`,
    },
  });

  // Section 4: forecast reason (if any)
  if (f.forecast_reason && String(f.forecast_reason).trim().length > 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**业绩变动原因**\n${safeText(f.forecast_reason, 200)}`,
      },
    });
  }
  elements.push({ tag: 'hr' });

  // Section 5: AI deeplink action
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '🤖 打开 AI 解读' },
        type: 'primary',
        url: payload.deeplink_url,
      },
    ],
  });

  // Footer
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `${payload.username} · ${
          payload.path === 'held' ? '持仓即时' : '自选盘后'
        } · 推送时间 ${payload.pushed_at}`,
      },
    ],
  });

  return {
    msg_type: 'interactive',
    card: {
      header: {
        template: headerTemplate,
        title: {
          tag: 'plain_text',
          content: `📢 业绩预告 · ${payload.symbol} ${payload.stock_name}`,
        },
      },
      elements,
    },
  };
}

/**
 * 构造自选股汇总卡（多条预告合并）— 单 user 单日仅一条 digest card。
 */
export function buildEarningsForecastDigestCard(payload: EarningsForecastWatchlistPayload): {
  msg_type: 'interactive';
  card: {
    header: { template: string; title: { content: string; tag: 'plain_text' } };
    elements: any[];
  };
} {
  const surpriseCount = payload.rows.filter(r => r.forecast.is_surprise).length;
  const headerTemplate = surpriseCount > 0 ? 'orange' : 'blue';

  const elements: any[] = [];
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**自选股业绩预告汇总 · 共 ${payload.rows.length} 条**${
        surpriseCount > 0 ? `（含 ${surpriseCount} 条超预期）` : ''
      }`,
    },
  });
  elements.push({ tag: 'hr' });

  for (const row of payload.rows) {
    const f = row.forecast;
    const range = formatProfitChangeRange(f.profit_change_low, f.profit_change_high);
    const surpriseTag = f.is_surprise ? ' 🚀' : '';
    const lineContent =
      `**${f.stock_code} ${f.stock_name || f.stock_code}${surpriseTag}** · ${
        f.forecast_type || '未知'
      } · ${range}\n` +
      `_${f.report_period} · ${buildAnalystConsensusLine(row.analyst_consensus)}_\n` +
      `[🤖 AI 解读](${row.deeplink_url})`;
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: lineContent },
    });
  }

  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `${payload.username} · 自选股盘后汇总 · 推送时间 ${payload.pushed_at}`,
      },
    ],
  });

  return {
    msg_type: 'interactive',
    card: {
      header: {
        template: headerTemplate,
        title: {
          tag: 'plain_text',
          content: `📊 自选股业绩预告 · ${payload.trade_date}`,
        },
      },
      elements,
    },
  };
}

// ---------------------------------------------------------------------------
//  Internal small helpers
// ---------------------------------------------------------------------------

function safeText(value: any, maxLength: number): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function nowShanghaiDate(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function nowShanghaiTimestamp(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
}

function randHex4(): string {
  const n = Math.floor(Math.random() * 0xffff);
  return n.toString(16).padStart(4, '0');
}

function safeString(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// ---------------------------------------------------------------------------
//  DataSource interface (DI seam)
// ---------------------------------------------------------------------------

export interface EarningsForecastWatcherDataSource {
  /**
   * List users eligible for earnings push:
   *   is_active=true AND notification_channels.feishu.earnings_alert=true。
   * 若 user_id 给定则过滤到单 user（仍走相同 normalize 路径）。
   */
  listEligibleUsers(options: {
    user_id?: number;
  }): Promise<Array<{ user_id: number; username: string; config: NotificationChannelsConfig }>>;
  /** Load user's held stock codes (6 位 stripped) — empty set if no portfolio. */
  loadHeldStockCodes(user_id: number): Promise<Set<string>>;
  /** Load user's watchlist stock codes (6 位 stripped) — empty set if no favorites. */
  loadWatchlistStockCodes(user_id: number): Promise<Set<string>>;
  /**
   * Load recent earnings forecasts (announce_date in [trade_date - recent_days, trade_date])。
   * stock_codes filter — caller can prune to held∪watch union for efficiency。
   */
  loadRecentForecasts(input: {
    trade_date: string;
    recent_days: number;
    stock_codes?: Set<string>;
  }): Promise<EarningsForecastRow[]>;
  /**
   * Load analyst consensus for a single stock (近 N 日内研报 forecast_eps_y1
   * 均值)；缺数据时返回 null。
   */
  loadAnalystConsensus(stock_code: string, asOfDate: string): Promise<AnalystConsensus | null>;
  /** Load existing earnings-forecast dedup signatures from User.risk_config.earnings_forecast_seen */
  loadSeenSignatures(user_id: number): Promise<string[]>;
  /** Persist updated signatures (LRU trim already applied by caller). */
  saveSeenSignatures(user_id: number, signatures: string[]): Promise<void>;
  /** Call FeishuBotWebhookService.sendEarningsForecastCard(payload, url) — single event. */
  sendFeishuCard(
    payload: EarningsForecastEventPayload,
    webhook_url: string
  ): Promise<FeishuBotWebhookSendResult>;
  /** Call FeishuBotWebhookService.sendEarningsForecastDigestCard(payload, url) — multi-event digest. */
  sendFeishuDigestCard(
    payload: EarningsForecastWatchlistPayload,
    webhook_url: string
  ): Promise<FeishuBotWebhookSendResult>;
}

// ---------------------------------------------------------------------------
//  Default (production) DataSource — Sequelize-backed
// ---------------------------------------------------------------------------

export class DefaultEarningsForecastWatcherDataSource implements EarningsForecastWatcherDataSource {
  async listEligibleUsers(options: { user_id?: number }) {
    const where: any = { is_active: true };
    if (options.user_id !== undefined) {
      where.id = Number(options.user_id);
    }
    const users = await User.findAll({
      where,
      attributes: ['id', 'username', 'risk_config'],
      raw: true,
    });
    return (
      users
        .map(u => ({
          user_id: (u as any).id,
          username: (u as any).username,
          config: normalizeNotificationConfig((u as any).risk_config),
        }))
        // 仅留 earnings_alert=true 的用户（避免下游每条预告都跑 shouldSend gate）
        .filter(u => u.config.feishu.earnings_alert)
    );
  }

  async loadHeldStockCodes(user_id: number): Promise<Set<string>> {
    const portfolio = await PaperTradingPortfolio.findOne({
      where: { user_id },
      attributes: ['id'],
      raw: true,
    });
    if (!portfolio) return new Set();
    const positions = (await PaperTradingPosition.findAll({
      where: { portfolio_id: (portfolio as any).id, quantity: { [Op.gt]: 0 } },
      attributes: ['symbol'],
      raw: true,
    })) as unknown as Array<{ symbol: string }>;
    const set = new Set<string>();
    for (const p of positions) {
      set.add(stripSymbolSuffix(p.symbol));
    }
    return set;
  }

  async loadWatchlistStockCodes(user_id: number): Promise<Set<string>> {
    const favorites = await FavoriteStock.findAll({
      where: { user_id },
      include: [{ model: Stock, attributes: ['symbol'] }],
    });
    const set = new Set<string>();
    for (const fav of favorites) {
      const sym = fav.stock?.symbol;
      if (sym) set.add(stripSymbolSuffix(sym));
    }
    return set;
  }

  async loadRecentForecasts(input: {
    trade_date: string;
    recent_days: number;
    stock_codes?: Set<string>;
  }): Promise<EarningsForecastRow[]> {
    const sinceDate = moment(input.trade_date, 'YYYY-MM-DD')
      .subtract(Math.max(1, Math.floor(input.recent_days)), 'days')
      .format('YYYY-MM-DD');
    const where: any = {
      announce_date: { [Op.gte]: sinceDate, [Op.lte]: input.trade_date },
    };
    if (input.stock_codes && input.stock_codes.size > 0) {
      where.stock_code = { [Op.in]: Array.from(input.stock_codes) };
    }
    const rows = (await EarningsForecast.findAll({
      where,
      attributes: [
        'announce_date',
        'stock_code',
        'stock_name',
        'report_period',
        'forecast_type',
        'profit_change_low',
        'profit_change_high',
        'profit_low',
        'profit_high',
        'forecast_reason',
        'is_surprise',
      ],
      order: [
        ['announce_date', 'DESC'],
        ['stock_code', 'ASC'],
        ['report_period', 'DESC'],
      ],
      raw: true,
    })) as unknown as Array<{
      announce_date: string;
      stock_code: string;
      stock_name: string | null;
      report_period: string;
      forecast_type: string | null;
      profit_change_low: number | string | null;
      profit_change_high: number | string | null;
      profit_low: number | string | null;
      profit_high: number | string | null;
      forecast_reason: string | null;
      is_surprise: boolean;
    }>;
    return rows.map(r => ({
      announce_date: r.announce_date,
      stock_code: r.stock_code,
      stock_name: r.stock_name,
      report_period: r.report_period,
      forecast_type: r.forecast_type,
      profit_change_low: r.profit_change_low === null ? null : Number(r.profit_change_low),
      profit_change_high: r.profit_change_high === null ? null : Number(r.profit_change_high),
      profit_low: r.profit_low === null ? null : Number(r.profit_low),
      profit_high: r.profit_high === null ? null : Number(r.profit_high),
      forecast_reason: r.forecast_reason,
      is_surprise: Boolean(r.is_surprise),
    }));
  }

  async loadAnalystConsensus(
    stock_code: string,
    asOfDate: string
  ): Promise<AnalystConsensus | null> {
    const sinceDate = moment(asOfDate, 'YYYY-MM-DD')
      .subtract(ANALYST_CONSENSUS_LOOKBACK_DAYS, 'days')
      .format('YYYY-MM-DD');
    const rows = (await AnalystForecast.findAll({
      where: {
        stock_code,
        report_date: { [Op.gte]: sinceDate, [Op.lte]: asOfDate },
        forecast_eps_y1: { [Op.ne]: null },
      },
      attributes: ['report_date', 'forecast_eps_y1', 'forecast_year_y1'],
      order: [['report_date', 'DESC']],
      raw: true,
    })) as unknown as Array<{
      report_date: string;
      forecast_eps_y1: number | string | null;
      forecast_year_y1: number | null;
    }>;
    const valid = rows.filter(r => {
      if (r.forecast_eps_y1 === null || r.forecast_eps_y1 === undefined) return false;
      const n = Number(r.forecast_eps_y1);
      return Number.isFinite(n);
    });
    if (valid.length < ANALYST_CONSENSUS_MIN_REPORTS) return null;
    const meanEps = valid.reduce((s, r) => s + Number(r.forecast_eps_y1), 0) / valid.length;
    return {
      consensus_eps_y1: meanEps,
      report_count: valid.length,
      latest_report_date: valid[0].report_date,
      forecast_year_y1: valid[0].forecast_year_y1 ?? null,
    };
  }

  async loadSeenSignatures(user_id: number): Promise<string[]> {
    const user = await User.findByPk(user_id);
    const raw = (user as any)?.risk_config?.earnings_forecast_seen;
    if (!Array.isArray(raw)) return [];
    return raw.filter(s => typeof s === 'string');
  }

  async saveSeenSignatures(user_id: number, signatures: string[]): Promise<void> {
    const user = await User.findByPk(user_id);
    if (!user) return;
    const rc =
      (user as any).risk_config && typeof (user as any).risk_config === 'object'
        ? { ...(user as any).risk_config }
        : {};
    rc.earnings_forecast_seen = [...signatures];
    (user as any).risk_config = rc;
    user.changed('risk_config', true);
    await user.save();
  }

  async sendFeishuCard(
    payload: EarningsForecastEventPayload,
    webhook_url: string
  ): Promise<FeishuBotWebhookSendResult> {
    return feishuBotWebhookService.sendEarningsForecastCard(payload, webhook_url, {
      buildCard: buildEarningsForecastCard,
    });
  }

  async sendFeishuDigestCard(
    payload: EarningsForecastWatchlistPayload,
    webhook_url: string
  ): Promise<FeishuBotWebhookSendResult> {
    return feishuBotWebhookService.sendEarningsForecastCard(payload, webhook_url, {
      buildCard: buildEarningsForecastDigestCard,
    });
  }
}

export const PRODUCTION_EARNINGS_FORECAST_WATCHER_DATA_SOURCE: EarningsForecastWatcherDataSource =
  new DefaultEarningsForecastWatcherDataSource();

// ---------------------------------------------------------------------------
//  Service
// ---------------------------------------------------------------------------

export class EarningsForecastWatcher {
  private readonly dataSource: EarningsForecastWatcherDataSource;

  constructor(
    dataSource: EarningsForecastWatcherDataSource = PRODUCTION_EARNINGS_FORECAST_WATCHER_DATA_SOURCE
  ) {
    this.dataSource = dataSource;
  }

  /**
   * Intra-day cron 主入口 — 扫所有用户的持仓股，对每条新预告即时推送。
   * 单 user 失败 try/catch 隔离不阻塞其他 user (fail-OPEN)。
   */
  async scanHeldStocks(options: ScanHeldOptions = {}): Promise<ScanResult> {
    const tradeDate = options.trade_date || nowShanghaiDate();
    const dryRun = options.dry_run === true;
    const recentDays =
      Number.isInteger(options.recent_days) && Number(options.recent_days) >= 1
        ? Number(options.recent_days)
        : DEFAULT_RECENT_DAYS;
    const baseUrl =
      safeString(options.frontend_base_url) ||
      safeString(process.env.FRONTEND_BASE_URL) ||
      DEFAULT_FRONTEND_BASE;

    let users: Array<{ user_id: number; username: string; config: NotificationChannelsConfig }> =
      [];
    try {
      users = await this.dataSource.listEligibleUsers({ user_id: options.user_id });
    } catch (err: any) {
      logger.error(`[EarningsForecastWatcher] listEligibleUsers 失败: ${err?.message || err}`);
      return {
        trade_date: tradeDate,
        scanned_users: 0,
        scanned_forecasts: 0,
        sent_count: 0,
        skipped_count: 0,
        failed_count: 0,
        dry_run: dryRun,
        per_event: [],
      };
    }

    const hasFallbackEnv = !!(
      process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK || process.env.FEISHU_BOT_WEBHOOK
    );

    const perEvent: EarningsForecastSendResult[] = [];
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let scannedForecasts = 0;

    for (const user of users) {
      try {
        const userResult = await this.scanOneUserHeld({
          user_id: user.user_id,
          username: user.username,
          config: user.config,
          trade_date: tradeDate,
          dry_run: dryRun,
          recent_days: recentDays,
          base_url: baseUrl,
          has_fallback_env_webhook: hasFallbackEnv,
        });
        scannedForecasts += userResult.scanned_forecasts;
        for (const r of userResult.events) {
          perEvent.push(r);
          if (r.status === EARNINGS_FORECAST_STATUS.SENT) sentCount += 1;
          else if (r.status === EARNINGS_FORECAST_STATUS.SKIPPED) skippedCount += 1;
          else failedCount += 1;
        }
      } catch (err: any) {
        logger.error(
          `[EarningsForecastWatcher] scanOneUserHeld user=${user.user_id} 二重 throw: ${
            err?.message || err
          }`
        );
      }
    }

    return {
      trade_date: tradeDate,
      scanned_users: users.length,
      scanned_forecasts: scannedForecasts,
      sent_count: sentCount,
      skipped_count: skippedCount,
      failed_count: failedCount,
      dry_run: dryRun,
      per_event: perEvent,
    };
  }

  /**
   * Post-close cron 主入口 — 扫所有用户的自选股，单条 digest card 汇总当日新预告。
   * 持仓股已被 intra-day 推过，watchlist path 主动排除避免重复推送。
   */
  async scanWatchlistStocks(options: ScanWatchlistOptions = {}): Promise<ScanWatchlistResult> {
    const tradeDate = options.trade_date || nowShanghaiDate();
    const dryRun = options.dry_run === true;
    const recentDays =
      Number.isInteger(options.recent_days) && Number(options.recent_days) >= 1
        ? Number(options.recent_days)
        : DEFAULT_RECENT_DAYS;
    const baseUrl =
      safeString(options.frontend_base_url) ||
      safeString(process.env.FRONTEND_BASE_URL) ||
      DEFAULT_FRONTEND_BASE;

    let users: Array<{ user_id: number; username: string; config: NotificationChannelsConfig }> =
      [];
    try {
      users = await this.dataSource.listEligibleUsers({ user_id: options.user_id });
    } catch (err: any) {
      logger.error(`[EarningsForecastWatcher] listEligibleUsers 失败: ${err?.message || err}`);
      return {
        trade_date: tradeDate,
        scanned_users: 0,
        scanned_forecasts: 0,
        sent_count: 0,
        skipped_count: 0,
        failed_count: 0,
        dry_run: dryRun,
        per_user: [],
      };
    }

    const hasFallbackEnv = !!(
      process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK || process.env.FEISHU_BOT_WEBHOOK
    );

    const perUser: EarningsForecastWatchlistResult[] = [];
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let scannedForecasts = 0;

    for (const user of users) {
      try {
        const r = await this.scanOneUserWatchlist({
          user_id: user.user_id,
          username: user.username,
          config: user.config,
          trade_date: tradeDate,
          dry_run: dryRun,
          recent_days: recentDays,
          base_url: baseUrl,
          has_fallback_env_webhook: hasFallbackEnv,
        });
        perUser.push(r);
        scannedForecasts += r.forecast_count;
        if (r.status === EARNINGS_FORECAST_STATUS.SENT) sentCount += 1;
        else if (r.status === EARNINGS_FORECAST_STATUS.SKIPPED) skippedCount += 1;
        else failedCount += 1;
      } catch (err: any) {
        logger.error(
          `[EarningsForecastWatcher] scanOneUserWatchlist user=${user.user_id} 二重 throw: ${
            err?.message || err
          }`
        );
        const eventId = buildForecastEventId(
          user.user_id,
          EARNINGS_FORECAST_PATH.WATCHLIST,
          tradeDate,
          randHex4()
        );
        perUser.push({
          event_id: eventId,
          status: EARNINGS_FORECAST_STATUS.FAILED,
          sent: false,
          user_id: user.user_id,
          username: user.username,
          signature: eventId, // signature 无意义但占位
          forecast_count: 0,
          symbols: [],
          error: String(err?.message || err),
        });
        failedCount += 1;
      }
    }

    return {
      trade_date: tradeDate,
      scanned_users: users.length,
      scanned_forecasts: scannedForecasts,
      sent_count: sentCount,
      skipped_count: skippedCount,
      failed_count: failedCount,
      dry_run: dryRun,
      per_user: perUser,
    };
  }

  /**
   * 单 user 持仓 path — 取预告 → dedup → push (每条独立 card)。
   */
  private async scanOneUserHeld(input: {
    user_id: number;
    username: string;
    config: NotificationChannelsConfig;
    trade_date: string;
    dry_run: boolean;
    recent_days: number;
    base_url: string;
    has_fallback_env_webhook: boolean;
  }): Promise<{ events: EarningsForecastSendResult[]; scanned_forecasts: number }> {
    const {
      user_id,
      username,
      config,
      trade_date,
      dry_run,
      recent_days,
      base_url,
      has_fallback_env_webhook,
    } = input;

    const gate = shouldSendEarningsForUser(config, has_fallback_env_webhook);
    if (!gate.shouldSend) {
      return { events: [], scanned_forecasts: 0 };
    }

    let heldCodes: Set<string>;
    try {
      heldCodes = await this.dataSource.loadHeldStockCodes(user_id);
    } catch (err: any) {
      logger.warn(
        `[EarningsForecastWatcher] loadHeldStockCodes user=${user_id} 失败: ${err?.message || err}`
      );
      return { events: [], scanned_forecasts: 0 };
    }
    if (heldCodes.size === 0) {
      return { events: [], scanned_forecasts: 0 };
    }

    let recentForecasts: EarningsForecastRow[];
    try {
      recentForecasts = await this.dataSource.loadRecentForecasts({
        trade_date,
        recent_days,
        stock_codes: heldCodes,
      });
    } catch (err: any) {
      logger.warn(
        `[EarningsForecastWatcher] loadRecentForecasts (held) user=${user_id}: ${
          err?.message || err
        }`
      );
      return { events: [], scanned_forecasts: 0 };
    }

    const heldForecasts = pickForecastsForHolders(recentForecasts, heldCodes);
    if (heldForecasts.length === 0) {
      return { events: [], scanned_forecasts: 0 };
    }

    let seenExisting: string[] = [];
    try {
      seenExisting = await this.dataSource.loadSeenSignatures(user_id);
    } catch (err: any) {
      logger.warn(
        `[EarningsForecastWatcher] loadSeenSignatures user=${user_id}: ${err?.message || err}`
      );
    }
    const seenSet = new Set(seenExisting);

    const webhookUrl =
      safeString(config.feishu.webhook_url) ||
      safeString(process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK) ||
      safeString(process.env.FEISHU_BOT_WEBHOOK);
    const pushedAt = nowShanghaiTimestamp();

    const newSignatures: string[] = [];
    const events: EarningsForecastSendResult[] = [];

    for (const forecast of heldForecasts) {
      const signature = signatureForForecast({
        path: EARNINGS_FORECAST_PATH.HELD,
        stock_code: forecast.stock_code,
        announce_date: forecast.announce_date,
        report_period: forecast.report_period,
      });
      const eventId = buildForecastEventId(
        user_id,
        EARNINGS_FORECAST_PATH.HELD,
        forecast.announce_date,
        randHex4()
      );

      if (seenSet.has(signature)) {
        events.push({
          event_id: eventId,
          status: EARNINGS_FORECAST_STATUS.SKIPPED,
          sent: false,
          user_id,
          username,
          path: EARNINGS_FORECAST_PATH.HELD,
          symbol: forecast.stock_code,
          signature,
          skip_reason: 'dedup: 已推送过此预告',
        });
        continue;
      }

      // 取一致预期（缺数据 → null，不阻塞 push）
      let consensus: AnalystConsensus | null = null;
      try {
        consensus = await this.dataSource.loadAnalystConsensus(
          forecast.stock_code,
          forecast.announce_date
        );
      } catch (err: any) {
        logger.warn(
          `[EarningsForecastWatcher] loadAnalystConsensus user=${user_id} stock=${
            forecast.stock_code
          }: ${err?.message || err}`
        );
      }

      const deeplink = buildForecastDeeplink(
        forecast.stock_code,
        forecast.announce_date,
        forecast.report_period,
        base_url
      );
      const payload: EarningsForecastEventPayload = {
        event_id: eventId,
        user_id,
        username,
        path: EARNINGS_FORECAST_PATH.HELD,
        symbol: forecast.stock_code,
        stock_name: forecast.stock_name || forecast.stock_code,
        forecast,
        analyst_consensus: consensus,
        deeplink_url: deeplink,
        pushed_at: pushedAt,
      };

      if (dry_run) {
        events.push({
          event_id: eventId,
          status: EARNINGS_FORECAST_STATUS.SENT,
          sent: false,
          user_id,
          username,
          path: EARNINGS_FORECAST_PATH.HELD,
          symbol: forecast.stock_code,
          signature,
          payload,
          skip_reason: 'dry_run',
        });
        continue;
      }

      let sendRes: FeishuBotWebhookSendResult;
      try {
        sendRes = await this.dataSource.sendFeishuCard(payload, webhookUrl);
      } catch (err: any) {
        logger.warn(
          `[EarningsForecastWatcher] sendFeishuCard user=${user_id} stock=${forecast.stock_code}: ${
            err?.message || err
          }`
        );
        events.push({
          event_id: eventId,
          status: EARNINGS_FORECAST_STATUS.FAILED,
          sent: false,
          user_id,
          username,
          path: EARNINGS_FORECAST_PATH.HELD,
          symbol: forecast.stock_code,
          signature,
          payload,
          webhook_url_used: webhookUrl,
          error: `飞书 webhook 异常: ${err?.message || err}`,
        });
        continue;
      }

      if (sendRes.success) {
        // 写 dedup buffer (fail-OPEN — 写失败不阻塞 trigger 返回)
        newSignatures.push(signature);
        events.push({
          event_id: eventId,
          status: EARNINGS_FORECAST_STATUS.SENT,
          sent: true,
          user_id,
          username,
          path: EARNINGS_FORECAST_PATH.HELD,
          symbol: forecast.stock_code,
          signature,
          payload,
          webhook_url_used: webhookUrl,
          webhook_response: sendRes.data,
        });
      } else if (sendRes.skipped) {
        events.push({
          event_id: eventId,
          status: EARNINGS_FORECAST_STATUS.SKIPPED,
          sent: false,
          user_id,
          username,
          path: EARNINGS_FORECAST_PATH.HELD,
          symbol: forecast.stock_code,
          signature,
          payload,
          webhook_url_used: webhookUrl,
          skip_reason: sendRes.message || 'feishu adapter skipped',
        });
      } else {
        events.push({
          event_id: eventId,
          status: EARNINGS_FORECAST_STATUS.PARTIAL,
          sent: false,
          user_id,
          username,
          path: EARNINGS_FORECAST_PATH.HELD,
          symbol: forecast.stock_code,
          signature,
          payload,
          webhook_url_used: webhookUrl,
          webhook_response: sendRes.data,
          error: sendRes.message || 'feishu webhook 返回失败',
        });
      }
    }

    if (newSignatures.length > 0) {
      try {
        const merged = mergeSeenForecastSignatures(seenExisting, newSignatures);
        await this.dataSource.saveSeenSignatures(user_id, merged);
      } catch (err: any) {
        logger.warn(
          `[EarningsForecastWatcher] saveSeenSignatures user=${user_id}: ${err?.message || err}`
        );
      }
    }

    return { events, scanned_forecasts: heldForecasts.length };
  }

  /**
   * 单 user 自选 path — 取预告 → 排除已持仓 → dedup → 聚合一条 digest card。
   */
  private async scanOneUserWatchlist(input: {
    user_id: number;
    username: string;
    config: NotificationChannelsConfig;
    trade_date: string;
    dry_run: boolean;
    recent_days: number;
    base_url: string;
    has_fallback_env_webhook: boolean;
  }): Promise<EarningsForecastWatchlistResult> {
    const {
      user_id,
      username,
      config,
      trade_date,
      dry_run,
      recent_days,
      base_url,
      has_fallback_env_webhook,
    } = input;

    const baseEventId = buildForecastEventId(
      user_id,
      EARNINGS_FORECAST_PATH.WATCHLIST,
      trade_date,
      randHex4()
    );
    const baseSignature = `WATCHLIST::DIGEST::${user_id}::${trade_date}`;

    const gate = shouldSendEarningsForUser(config, has_fallback_env_webhook);
    if (!gate.shouldSend) {
      return {
        event_id: baseEventId,
        status: EARNINGS_FORECAST_STATUS.SKIPPED,
        sent: false,
        user_id,
        username,
        signature: baseSignature,
        forecast_count: 0,
        symbols: [],
        skip_reason: gate.reason,
      };
    }

    let watchedCodes: Set<string>;
    try {
      watchedCodes = await this.dataSource.loadWatchlistStockCodes(user_id);
    } catch (err: any) {
      logger.warn(
        `[EarningsForecastWatcher] loadWatchlistStockCodes user=${user_id}: ${err?.message || err}`
      );
      return {
        event_id: baseEventId,
        status: EARNINGS_FORECAST_STATUS.FAILED,
        sent: false,
        user_id,
        username,
        signature: baseSignature,
        forecast_count: 0,
        symbols: [],
        error: `加载自选股失败: ${err?.message || err}`,
      };
    }
    if (watchedCodes.size === 0) {
      return {
        event_id: baseEventId,
        status: EARNINGS_FORECAST_STATUS.SKIPPED,
        sent: false,
        user_id,
        username,
        signature: baseSignature,
        forecast_count: 0,
        symbols: [],
        skip_reason: '用户无自选股',
      };
    }

    let heldCodes: Set<string>;
    try {
      heldCodes = await this.dataSource.loadHeldStockCodes(user_id);
    } catch (err: any) {
      logger.warn(
        `[EarningsForecastWatcher] loadHeldStockCodes (watchlist path) user=${user_id}: ${
          err?.message || err
        }`
      );
      heldCodes = new Set(); // 容忍：watchlist 推送照常，重复风险接受
    }

    let recentForecasts: EarningsForecastRow[];
    try {
      // union of watch ∪ held 把 SQL filter 缩小到候选 set 而不是全市场
      const unionCodes = new Set([...watchedCodes]);
      // 不需要 add heldCodes 因为我们排除 held，但 stock_codes filter 用 watched 即可
      recentForecasts = await this.dataSource.loadRecentForecasts({
        trade_date,
        recent_days,
        stock_codes: unionCodes,
      });
    } catch (err: any) {
      logger.warn(
        `[EarningsForecastWatcher] loadRecentForecasts (watchlist) user=${user_id}: ${
          err?.message || err
        }`
      );
      return {
        event_id: baseEventId,
        status: EARNINGS_FORECAST_STATUS.FAILED,
        sent: false,
        user_id,
        username,
        signature: baseSignature,
        forecast_count: 0,
        symbols: [],
        error: `加载预告失败: ${err?.message || err}`,
      };
    }

    const watchedForecasts = pickForecastsForWatchers(recentForecasts, watchedCodes, heldCodes);
    if (watchedForecasts.length === 0) {
      return {
        event_id: baseEventId,
        status: EARNINGS_FORECAST_STATUS.SKIPPED,
        sent: false,
        user_id,
        username,
        signature: baseSignature,
        forecast_count: 0,
        symbols: [],
        skip_reason: '自选股当日无新业绩预告',
      };
    }

    // dedup — digest 整体一个 signature；同 trade_date 一次成功后再跑跳过
    let seenExisting: string[] = [];
    try {
      seenExisting = await this.dataSource.loadSeenSignatures(user_id);
    } catch (err: any) {
      logger.warn(
        `[EarningsForecastWatcher] loadSeenSignatures (watchlist) user=${user_id}: ${
          err?.message || err
        }`
      );
    }
    if (seenExisting.includes(baseSignature)) {
      return {
        event_id: baseEventId,
        status: EARNINGS_FORECAST_STATUS.SKIPPED,
        sent: false,
        user_id,
        username,
        signature: baseSignature,
        forecast_count: watchedForecasts.length,
        symbols: watchedForecasts.map(f => f.stock_code),
        skip_reason: 'dedup: 当日 digest 已发送',
      };
    }

    // 取每只股票的一致预期（缺数据 → null）
    const rows: EarningsForecastWatchlistPayload['rows'] = [];
    for (const forecast of watchedForecasts) {
      let consensus: AnalystConsensus | null = null;
      try {
        consensus = await this.dataSource.loadAnalystConsensus(
          forecast.stock_code,
          forecast.announce_date
        );
      } catch (err: any) {
        logger.warn(
          `[EarningsForecastWatcher] loadAnalystConsensus (watchlist) stock=${
            forecast.stock_code
          }: ${err?.message || err}`
        );
      }
      rows.push({
        forecast,
        analyst_consensus: consensus,
        deeplink_url: buildForecastDeeplink(
          forecast.stock_code,
          forecast.announce_date,
          forecast.report_period,
          base_url
        ),
      });
    }

    const pushedAt = nowShanghaiTimestamp();
    const payload: EarningsForecastWatchlistPayload = {
      event_id: baseEventId,
      user_id,
      username,
      trade_date,
      rows,
      pushed_at: pushedAt,
    };

    const symbols = watchedForecasts.map(f => f.stock_code);

    if (dry_run) {
      return {
        event_id: baseEventId,
        status: EARNINGS_FORECAST_STATUS.SENT,
        sent: false,
        user_id,
        username,
        signature: baseSignature,
        forecast_count: watchedForecasts.length,
        symbols,
        payload,
        skip_reason: 'dry_run',
      };
    }

    const webhookUrl =
      safeString(config.feishu.webhook_url) ||
      safeString(process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK) ||
      safeString(process.env.FEISHU_BOT_WEBHOOK);

    let sendRes: FeishuBotWebhookSendResult;
    try {
      sendRes = await this.dataSource.sendFeishuDigestCard(payload, webhookUrl);
    } catch (err: any) {
      logger.warn(
        `[EarningsForecastWatcher] sendFeishuDigestCard user=${user_id}: ${err?.message || err}`
      );
      return {
        event_id: baseEventId,
        status: EARNINGS_FORECAST_STATUS.FAILED,
        sent: false,
        user_id,
        username,
        signature: baseSignature,
        forecast_count: watchedForecasts.length,
        symbols,
        payload,
        webhook_url_used: webhookUrl,
        error: `飞书 webhook 异常: ${err?.message || err}`,
      };
    }

    if (sendRes.success) {
      // 写 dedup buffer (fail-OPEN)
      try {
        const merged = mergeSeenForecastSignatures(seenExisting, [baseSignature]);
        await this.dataSource.saveSeenSignatures(user_id, merged);
      } catch (err: any) {
        logger.warn(
          `[EarningsForecastWatcher] saveSeenSignatures (watchlist) user=${user_id}: ${
            err?.message || err
          }`
        );
      }
      return {
        event_id: baseEventId,
        status: EARNINGS_FORECAST_STATUS.SENT,
        sent: true,
        user_id,
        username,
        signature: baseSignature,
        forecast_count: watchedForecasts.length,
        symbols,
        payload,
        webhook_url_used: webhookUrl,
        webhook_response: sendRes.data,
      };
    }
    if (sendRes.skipped) {
      return {
        event_id: baseEventId,
        status: EARNINGS_FORECAST_STATUS.SKIPPED,
        sent: false,
        user_id,
        username,
        signature: baseSignature,
        forecast_count: watchedForecasts.length,
        symbols,
        payload,
        webhook_url_used: webhookUrl,
        skip_reason: sendRes.message || 'feishu adapter skipped',
      };
    }
    return {
      event_id: baseEventId,
      status: EARNINGS_FORECAST_STATUS.PARTIAL,
      sent: false,
      user_id,
      username,
      signature: baseSignature,
      forecast_count: watchedForecasts.length,
      symbols,
      payload,
      webhook_url_used: webhookUrl,
      webhook_response: sendRes.data,
      error: sendRes.message || 'feishu webhook 返回失败',
    };
  }
}

export const earningsForecastWatcher = new EarningsForecastWatcher();
