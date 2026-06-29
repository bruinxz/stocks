/**
 * BullishEventDetectorService — PR-B (2026-06-29)
 *
 * 用户原话 (2026-06-28):
 *   > 周末利好华工科技的新闻你看到了吗, 这类新闻你需要发消息提示我
 *
 * 当前系统只有 BlackSwanWatchdog / CriticalAnnouncementPushService 推"利空 / 风险"
 * 类告警, 没有任何 service 主动扫"利好新闻 / 业绩预喜公告 / 关注度突增 / KOL 集中
 * 看多"并 push 给用户. PR-B 把这一空白补上 — 每 30min 跑 4 类 detector, 命中即
 * 写 RiskAlert(level=MEDIUM, rule_id='stock_bullish_event') + 推 OPS 飞书群.
 *
 * ============================================================================
 * Universe (用户感兴趣的股票 union, 去重)
 * ============================================================================
 *   1. paper_trading_positions WHERE quantity > 0 (用户持仓)
 *   2. favorite_stocks (用户自选股, JOIN stocks → symbol)
 *   3. 近 30 日 AI 推荐过买入 (ai_investment_signals.normalized_decision IN ('buy',
 *      'strong_buy') AND signal_date >= NOW() - 30 days)
 *
 * universe 限制最大 1000 票防一次扫太慢; 任一子源 throw → 仅 warn + 返其它子源
 * 结果 (fail-OPEN).
 *
 * ============================================================================
 * 4 个 detector (纯函数, 全 export)
 * ============================================================================
 *   1. detectCriticalAnnouncement(rows, universe_set) — 近 3 日 priority='critical'
 *      AND sentiment != '负面' 的公告 (正面 / 中性 / null 都算; 负面归 CriticalAnnouncementPush
 *      已推).
 *   2. detectPositiveNews(rows, stock_name_map) — 近 24h MarketNews title 含
 *      stock_name (中文模糊匹配, 长度 ≥ 2) AND sentimentByTitle(title) >= 0.5.
 *      sentimentByTitle 是 export 的纯函数 (启发式关键词字典, 与 KOLOpinion
 *      news 同款打分).
 *   3. detectAttentionSpike(today_rows, baseline_rows_7d) — stock_sentiments
 *      最近一日 post_count > avg(近 7 日) + 3 × std(近 7 日). 不足 4 个样本不触发.
 *   4. detectKolConsensus(opinion_rows_3d) — 近 3 日 kol_opinions GROUP BY stock_code
 *      HAVING count(distinct kol_name) >= 3 AND avg(sentiment_score) >= 0.3.
 *
 * 每个 detector 失败 (DB throw / 空表 / null defense) 只仅记 warn, 不阻塞其它 3 个.
 *
 * ============================================================================
 * Dedup (24h)
 * ============================================================================
 * - 用 RiskAlert.message 末尾追加 `[dedup_key:STOCK:DETECTOR:YYYY-MM-DD]` token,
 *   query 时按 created_at >= NOW() - 24h AND message LIKE '%[dedup_key:STOCK:DETECTOR%'
 *   存在即跳过. 简单, 不需要新表/列.
 * - SystemAdminAlertPusher 自带 dedup_key='bullish:STOCK:DETECTOR:YYYY-MM-DD',
 *   1h 内同 key 不重推飞书 (双保险).
 *
 * ============================================================================
 * 写 RiskAlert (level=MEDIUM, rule_id='stock_bullish_event')
 * ============================================================================
 * - 给所有 active user (paper_trading_portfolios.is_active=true 的 user_id 集)
 *   每 user 写一条 RiskAlert. 触发 model.afterCreate hook → RealtimeAlertDispatcher
 *   user-level WS 广播 (level=MEDIUM 不进个性化飞书 push, 因为那是 HIGH/CRITICAL 阈值).
 * - 系统级 OPS 飞书 group push 走 SystemAdminAlertPusher (env webhook), 不依赖
 *   user-level config.
 *
 * ============================================================================
 * fail-OPEN
 * ============================================================================
 * - per-detector try/catch: 单 detector 异常仅 warn, 其它 detector 继续跑;
 * - per-write try/catch: 写单条 RiskAlert / 单条飞书 push 失败仅 warn 计数.
 * - 整次 runOnce 永不 throw — 让 SchedulerService cron tick 始终 SUCCESS, 异常
 *   通过 result_summary.errors 暴露 + 日志可查.
 */

import { logger } from '../utils/logger';
import { normalizeSymbol } from '../utils/stockSymbol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BullishDetectorType =
  | 'critical_announcement'
  | 'positive_news'
  | 'attention_spike'
  | 'kol_consensus';

export const BULLISH_DETECTOR_TYPES: readonly BullishDetectorType[] = Object.freeze([
  'critical_announcement',
  'positive_news',
  'attention_spike',
  'kol_consensus',
]);

export const BULLISH_DETECTOR_LABELS: Record<BullishDetectorType, string> = Object.freeze({
  critical_announcement: 'critical 利好公告',
  positive_news: '正面新闻',
  attention_spike: '关注度突增',
  kol_consensus: 'KOL 集中看多',
}) as Record<BullishDetectorType, string>;

export interface BullishHit {
  /** 6 位纯代码 (stock_code) 或带前缀 (sh.600519); 取决于 detector 源 */
  stock_code: string;
  /** 显示用名称 */
  stock_name: string;
  detector: BullishDetectorType;
  detector_label: string;
  /** 1-2 句中文理由 */
  reason: string;
  /** 排序/筛选用 (0-100) */
  score: number;
  /** 透传给飞书卡片的源字段 */
  source_payload?: Record<string, unknown>;
}

export interface BullishDetectorRunOptions {
  /** 测试 — 覆盖 now */
  now?: Date;
  /** 测试/CLI — 不写 RiskAlert + 不推飞书 (只跑 detector) */
  dry_run?: boolean;
  /** 测试 — 覆盖 universe (跳过 listUniverseSymbols) */
  universe_override?: string[];
}

export interface BullishDetectorRunResult {
  ok: boolean;
  dry_run: boolean;
  scanned: number;
  /** 4 detector 命中总数 (含跨 detector 重复 stock_code) */
  detected: number;
  /** 真写 RiskAlert + 推飞书的命中数 (dedup 之后) */
  pushed: number;
  /** dedup 命中跳过的数 (近 24h 已推过同 stock + detector) */
  deduped: number;
  /** 按 detector 分组的命中数 (含 dedup 前) */
  by_detector: Record<BullishDetectorType, number>;
  errors: Array<{ where: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// DataSource (DI seam — 单测注入 fake 完全脱 DB)
// ---------------------------------------------------------------------------

export interface UniverseBuildResult {
  /** 6 位纯代码集 (与 AnnouncementSummary.stock_code / StockSentiment.stock_code 对齐) */
  bare_codes: Set<string>;
  /** 带前缀 (sh.600519) 集 — 与 PaperTradingPosition.symbol / RiskAlert.symbol 对齐 */
  prefixed_symbols: Set<string>;
  /** stock_code (6位) → stock_name 名称查询 */
  code_to_name: Map<string, string>;
}

export interface AnnouncementRow {
  announce_date: string;
  stock_code: string;
  stock_name: string | null;
  original_title: string;
  summary: string | null;
  sentiment: string | null;
  priority: string;
  event_type: string | null;
  url: string | null;
}

export interface NewsRow {
  title_hash: string;
  publish_time: Date;
  title: string;
  content: string | null;
  source: string;
  url: string | null;
}

export interface SentimentDailyRow {
  stock_code: string;
  trade_date: string;
  post_count: number | null;
  rank: number | null;
  heat_score: number | null;
}

export interface KolOpinionRow {
  stock_code: string;
  kol_name: string;
  opinion_date: string;
  kol_source: string;
  opinion_summary: string;
  sentiment_score: number | null;
}

export interface BullishDataSource {
  /** 用户持仓 symbols (带前缀, e.g. sh.600519) */
  listPositionSymbols(): Promise<string[]>;
  /** 自选股 symbols (带前缀) */
  listFavoriteSymbols(): Promise<string[]>;
  /** 近 N 日 AI 推荐过买入的 symbols (带前缀) */
  listAIRecommendedSymbols(sinceDays: number): Promise<string[]>;
  /** 已组 universe 后查 stock_code → name (用于显示, 也用于 news title 模糊匹配) */
  resolveStockNames(bareCodes: string[]): Promise<Map<string, string>>;
  /** 近 N 日 priority='critical' 公告, 过滤到 universe 内 */
  listCriticalAnnouncements(
    bareCodes: string[],
    sinceDays: number
  ): Promise<AnnouncementRow[]>;
  /** 近 24h 全部市场新闻 (前端再按 name 模糊匹配过滤; 不让 SQL 做 LIKE %name% 防慢查询) */
  listRecentNews(sinceHours: number): Promise<NewsRow[]>;
  /** 取每个股票近 8 个交易日的 stock_sentiments (今日 + 近 7 日 baseline) */
  listSentimentsByCodes(
    bareCodes: string[],
    lookbackDays: number
  ): Promise<SentimentDailyRow[]>;
  /** 取近 N 日 KOL 观点 (filter 到 universe) */
  listRecentKolOpinions(
    bareCodes: string[],
    sinceDays: number
  ): Promise<KolOpinionRow[]>;
  /** 近 24h 已写过的 (stock, detector) dedup key 集合 */
  loadRecentDedupKeys(sinceHours: number): Promise<Set<string>>;
  /** 写一条 RiskAlert (per user). 失败仅 warn, 不抛. 返 alert_id list */
  writeRiskAlerts(input: {
    user_ids: number[];
    symbol: string;
    name: string;
    level: 'MEDIUM' | 'HIGH';
    rule_id: string;
    message: string;
  }): Promise<{ created_ids: number[]; failed: number }>;
  /** active user_ids (paper_trading_portfolios.is_active=true 的 user_id 集) */
  listActiveUserIds(): Promise<number[]>;
}

// ---------------------------------------------------------------------------
// Pure helpers (全 export 单测)
// ---------------------------------------------------------------------------

/** 关键词字典 — 启发式 sentiment 打分. 与 KOLOpinion east_money_news 同款范式. */
export const POSITIVE_NEWS_KEYWORDS: readonly string[] = Object.freeze([
  '中标', '中标公告', '签订', '签约', '合作', '战略合作', '获批', '突破', '创新高',
  '业绩超预期', '业绩预增', '预增', '大涨', '涨停', '收获', '获奖', '荣获',
  '巨额', '订单', '量产', '投产', '增长', '增利', '盈利', '扭亏', '回购',
  '增持', '利好', '受益', '利润大增', '净利润', '高速增长', '新签', '突破性',
  '签下', '中标项目', '夺得', '获得', '研发成功', '量产交付', '战略入股',
  '增资', '签约金额', '订单金额', '合作框架协议', '收购完成', '业绩快报', '同比增长',
]);

/** 强多关键词加权 (+1.0); 中性次级 (+0.5); 同时含负面词 → 0. */
export const STRONG_POSITIVE_KEYWORDS: readonly string[] = Object.freeze([
  '业绩预增', '业绩超预期', '净利润大增', '中标', '签约', '获批', '突破',
  '量产', '回购', '增持', '战略合作', '利润大增',
]);

export const NEGATIVE_NEWS_KEYWORDS: readonly string[] = Object.freeze([
  '亏损', '减持', '处罚', '立案', '调查', '违规', '退市', 'ST', '*ST', '暴跌',
  '跌停', '风险提示', '终止', '失败', '诉讼', '被起诉', '被立案',
  '业绩预亏', '业绩预减', '预亏', '商誉减值', '资产减值',
]);

/**
 * 启发式打分: [-1, +1].
 * 0.5+ → bullish 触发, < 0.5 不触发. 命中负面词强压.
 */
export function scoreNewsTitle(title: string): number {
  const t = String(title || '').toLowerCase();
  if (!t) return 0;
  // 负面词命中: 整段返 0 (即使有正面词, 也不算利好)
  for (const neg of NEGATIVE_NEWS_KEYWORDS) {
    if (t.includes(String(neg).toLowerCase())) return 0;
  }
  let strongHits = 0;
  let weakHits = 0;
  for (const w of STRONG_POSITIVE_KEYWORDS) {
    if (t.includes(String(w).toLowerCase())) strongHits += 1;
  }
  for (const w of POSITIVE_NEWS_KEYWORDS) {
    if (t.includes(String(w).toLowerCase())) weakHits += 1;
  }
  if (strongHits >= 1) return Math.min(1, 0.6 + strongHits * 0.2);
  if (weakHits >= 2) return Math.min(0.9, 0.4 + weakHits * 0.1);
  if (weakHits >= 1) return 0.4;
  return 0;
}

/** 简单 mean. */
export function mean(values: number[]): number {
  if (!Array.isArray(values) || values.length === 0) return 0;
  let s = 0;
  let n = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      s += v;
      n += 1;
    }
  }
  return n === 0 ? 0 : s / n;
}

/** 总体标准差. */
export function stdev(values: number[]): number {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const m = mean(values);
  let acc = 0;
  let n = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      acc += (v - m) * (v - m);
      n += 1;
    }
  }
  return n === 0 ? 0 : Math.sqrt(acc / n);
}

/** 生成 dedup key. 格式 `STOCK:DETECTOR:YYYY-MM-DD`. */
export function buildDedupKey(
  stock_code: string,
  detector: BullishDetectorType,
  now: Date
): string {
  const d = new Date(now);
  // 用 UTC+8 日期 (与 ScheduledTask cron 同时区) — 简化: 直接取本地日期
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${stock_code}:${detector}:${yyyy}-${mm}-${dd}`;
}

/** RiskAlert message 末尾追加 dedup tag, 便于 SQL LIKE 查询 dedup. */
export function appendDedupTag(message: string, dedup_key: string): string {
  return `${message}\n\n[dedup_key:${dedup_key}]`;
}

/** symbol 双向: bare(6 位) ↔ prefixed(sh.600519). */
export function toBareCode(symbol: string): string {
  const s = String(symbol || '').trim();
  if (!s) return '';
  if (/^\d{6}$/.test(s)) return s;
  // sh.600519 / sz.000001 / sh600519 / bj.830799
  const m = s.match(/(?:sh|sz|bj)\.?(\d{6})/i);
  if (m) return m[1];
  return s;
}

// ---------------------------------------------------------------------------
// Detectors (纯函数, 全 export)
// ---------------------------------------------------------------------------

/** detector 1: critical 公告 (sentiment != '负面'). */
export function detectCriticalAnnouncementHits(
  rows: AnnouncementRow[],
  code_to_name: Map<string, string>
): BullishHit[] {
  const out: BullishHit[] = [];
  for (const r of rows || []) {
    if (!r || !r.stock_code) continue;
    if (String(r.priority || '').toLowerCase() !== 'critical') continue;
    const senti = String(r.sentiment || '').trim();
    if (senti === '负面') continue; // 负面 critical 走 CriticalAnnouncementPushService
    const stock_code = String(r.stock_code).trim();
    const name = r.stock_name || code_to_name.get(stock_code) || stock_code;
    const titlePart = r.summary || r.original_title || '';
    const reason = `${r.announce_date} ${r.event_type || '重大事项'}: ${titlePart.slice(0, 80)}`;
    out.push({
      stock_code,
      stock_name: String(name),
      detector: 'critical_announcement',
      detector_label: BULLISH_DETECTOR_LABELS.critical_announcement,
      reason,
      score: 80,
      source_payload: {
        announce_date: r.announce_date,
        event_type: r.event_type,
        url: r.url,
        sentiment: r.sentiment,
      },
    });
  }
  return out;
}

/** detector 2: 正面新闻 (title 含 stock_name AND scoreNewsTitle >= 0.5). */
export function detectPositiveNewsHits(
  newsRows: NewsRow[],
  code_to_name: Map<string, string>
): BullishHit[] {
  const out: BullishHit[] = [];
  const nameToCode = new Map<string, string>();
  for (const [code, name] of code_to_name) {
    const nm = String(name || '').trim();
    if (nm.length >= 2) nameToCode.set(nm, code);
  }
  for (const n of newsRows || []) {
    if (!n || !n.title) continue;
    const score = scoreNewsTitle(n.title);
    if (!(score >= 0.5)) continue;
    // 寻找 title 中含的所有 stock name (一条新闻可同时提多只)
    for (const [name, code] of nameToCode) {
      if (n.title.includes(name)) {
        out.push({
          stock_code: code,
          stock_name: name,
          detector: 'positive_news',
          detector_label: BULLISH_DETECTOR_LABELS.positive_news,
          reason: `${n.source} ${formatPublishTime(n.publish_time)}: ${n.title.slice(0, 100)}`,
          score: Math.round(60 + score * 30),
          source_payload: {
            title: n.title,
            url: n.url,
            source: n.source,
            sentiment_score: score,
          },
        });
      }
    }
  }
  return out;
}

function formatPublishTime(d: Date | string | null | undefined): string {
  if (!d) return '';
  try {
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (Number.isNaN(dt.getTime())) return '';
    return `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

/** detector 3: 关注度突增 — post_count > mean(7d) + 3 * std(7d). */
export function detectAttentionSpikeHits(
  rows: SentimentDailyRow[],
  code_to_name: Map<string, string>
): BullishHit[] {
  const out: BullishHit[] = [];
  // 按 stock_code 分组, 排序 trade_date 升序, 取末 1 行 vs 前 N 行 baseline
  const byCode = new Map<string, SentimentDailyRow[]>();
  for (const r of rows || []) {
    if (!r || !r.stock_code) continue;
    if (!byCode.has(r.stock_code)) byCode.set(r.stock_code, []);
    byCode.get(r.stock_code)!.push(r);
  }
  for (const [code, arr] of byCode) {
    if (arr.length < 4) continue; // 需要至少 1 today + 3 baseline
    arr.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
    const today = arr[arr.length - 1];
    const baseline = arr.slice(0, -1);
    const baselineCounts = baseline
      .map(r => Number(r.post_count))
      .filter(v => Number.isFinite(v) && v > 0);
    if (baselineCounts.length < 3) continue;
    const todayCount = Number(today.post_count);
    if (!Number.isFinite(todayCount) || todayCount <= 0) continue;
    const m = mean(baselineCounts);
    const s = stdev(baselineCounts);
    if (m <= 0) continue;
    // 3σ 阈值; 同时 today 必须 > 1.5 × baseline mean 防 std 接近 0 时的"轻微突起"
    const threshold = m + 3 * s;
    if (!(todayCount > threshold && todayCount > m * 1.5)) continue;
    const ratio = todayCount / m;
    const name = code_to_name.get(code) || code;
    out.push({
      stock_code: code,
      stock_name: String(name),
      detector: 'attention_spike',
      detector_label: BULLISH_DETECTOR_LABELS.attention_spike,
      reason: `${today.trade_date} 关注度 ${todayCount} (近7日均 ${m.toFixed(0)} + 3σ ${threshold.toFixed(0)}); 倍数 ${ratio.toFixed(2)}x`,
      score: Math.min(95, Math.round(50 + ratio * 8)),
      source_payload: {
        trade_date: today.trade_date,
        post_count_today: todayCount,
        post_count_mean_7d: Math.round(m),
        post_count_stdev_7d: Math.round(s),
        ratio,
        rank: today.rank,
      },
    });
  }
  return out;
}

/** detector 4: KOL 集中看多 — distinct kol >= 3 AND avg(sentiment) >= 0.3. */
export function detectKolConsensusHits(
  rows: KolOpinionRow[],
  code_to_name: Map<string, string>
): BullishHit[] {
  const out: BullishHit[] = [];
  const byCode = new Map<string, KolOpinionRow[]>();
  for (const r of rows || []) {
    if (!r || !r.stock_code) continue;
    if (!byCode.has(r.stock_code)) byCode.set(r.stock_code, []);
    byCode.get(r.stock_code)!.push(r);
  }
  for (const [code, arr] of byCode) {
    if (arr.length < 3) continue;
    const distinctKols = new Set(arr.map(r => String(r.kol_name || '').trim()).filter(Boolean));
    if (distinctKols.size < 3) continue;
    const scores = arr
      .map(r => Number(r.sentiment_score))
      .filter(v => Number.isFinite(v));
    if (scores.length === 0) continue;
    const avg = mean(scores);
    if (!(avg >= 0.3)) continue;
    const name = code_to_name.get(code) || code;
    const sourceCounts = new Map<string, number>();
    for (const r of arr) {
      const s = String(r.kol_source || 'unknown');
      sourceCounts.set(s, (sourceCounts.get(s) || 0) + 1);
    }
    const sourceSummary = Array.from(sourceCounts.entries())
      .map(([s, c]) => `${s}=${c}`)
      .join(', ');
    out.push({
      stock_code: code,
      stock_name: String(name),
      detector: 'kol_consensus',
      detector_label: BULLISH_DETECTOR_LABELS.kol_consensus,
      reason: `近 3 日 ${distinctKols.size} 位 KOL 看多 (avg sentiment ${avg.toFixed(2)}; sources: ${sourceSummary})`,
      score: Math.min(95, Math.round(50 + avg * 50 + distinctKols.size * 3)),
      source_payload: {
        distinct_kols: distinctKols.size,
        avg_sentiment: avg,
        sources: Object.fromEntries(sourceCounts),
        latest_titles: arr.slice(0, 3).map(r => r.opinion_summary),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build OPS feishu push body
// ---------------------------------------------------------------------------

export function buildOpsBullishCardBody(hit: BullishHit): string {
  const lines: string[] = [];
  lines.push(`**${hit.stock_code} ${hit.stock_name}** — ${hit.detector_label}`);
  lines.push(`**评分**: ${hit.score}`);
  lines.push(`**理由**: ${hit.reason}`);
  if (hit.source_payload?.url) {
    lines.push(`**链接**: ${hit.source_payload.url}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Production DataSource (lazy require — 避免顶层 import 重量级 model)
// ---------------------------------------------------------------------------

class DefaultBullishDataSource implements BullishDataSource {
  async listPositionSymbols(): Promise<string[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPosition } = require('../models/PaperTradingPosition');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const rows: Array<{ symbol: string }> = await PaperTradingPosition.findAll({
        attributes: ['symbol'],
        where: { quantity: { [Op.gt]: 0 } },
        group: ['symbol'],
        raw: true,
      });
      return (rows || []).map(r => String((r as any)?.symbol || '').trim()).filter(Boolean);
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] listPositionSymbols failed: ${e?.message || e}`);
      return [];
    }
  }

  async listFavoriteSymbols(): Promise<string[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { FavoriteStock } = require('../models/FavoriteStock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../models/Stock');
      const rows: any[] = await FavoriteStock.findAll({
        include: [{ model: Stock, attributes: ['symbol'] }],
      });
      return (rows || [])
        .map((r: any) => String(r?.Stock?.symbol || r?.stock?.symbol || '').trim())
        .filter(Boolean);
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] listFavoriteSymbols failed: ${e?.message || e}`);
      return [];
    }
  }

  async listAIRecommendedSymbols(sinceDays: number): Promise<string[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AIInvestmentSignal } = require('../models/AIInvestmentSignal');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
      const cutoffDate = cutoff.toISOString().slice(0, 10);
      const rows: Array<{ symbol: string }> = await AIInvestmentSignal.findAll({
        attributes: ['symbol'],
        where: {
          normalized_decision: { [Op.in]: ['buy', 'strong_buy'] },
          signal_date: { [Op.gte]: cutoffDate },
        },
        group: ['symbol'],
        raw: true,
      });
      return (rows || []).map(r => String((r as any)?.symbol || '').trim()).filter(Boolean);
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] listAIRecommendedSymbols failed: ${e?.message || e}`);
      return [];
    }
  }

  async resolveStockNames(bareCodes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!bareCodes || bareCodes.length === 0) return out;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      // 用模糊匹配 symbol LIKE '%CODE' (sh.600519 / sz.000001 都能命中)
      const symbolPatterns = bareCodes.map(c => `%${c}`);
      const rows: any[] = await Stock.findAll({
        attributes: ['symbol', 'name'],
        where: { symbol: { [Op.or]: symbolPatterns.map(p => ({ [Op.like]: p })) } },
        raw: true,
      });
      for (const r of rows || []) {
        const bare = toBareCode(String(r.symbol || ''));
        if (bare && r.name) out.set(bare, String(r.name));
      }
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] resolveStockNames failed: ${e?.message || e}`);
    }
    return out;
  }

  async listCriticalAnnouncements(
    bareCodes: string[],
    sinceDays: number
  ): Promise<AnnouncementRow[]> {
    if (!bareCodes || bareCodes.length === 0) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AnnouncementSummary } = require('../models/AnnouncementSummary');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
      const cutoffDate = cutoff.toISOString().slice(0, 10);
      const rows: any[] = await AnnouncementSummary.findAll({
        attributes: [
          'announce_date', 'stock_code', 'stock_name', 'original_title',
          'summary', 'sentiment', 'priority', 'event_type', 'url',
        ],
        where: {
          priority: 'critical',
          announce_date: { [Op.gte]: cutoffDate },
          stock_code: { [Op.in]: bareCodes },
        },
        raw: true,
      });
      return (rows || []).map((r: any) => ({
        announce_date: String(r.announce_date),
        stock_code: String(r.stock_code),
        stock_name: r.stock_name ? String(r.stock_name) : null,
        original_title: String(r.original_title || ''),
        summary: r.summary ? String(r.summary) : null,
        sentiment: r.sentiment ? String(r.sentiment) : null,
        priority: String(r.priority),
        event_type: r.event_type ? String(r.event_type) : null,
        url: r.url ? String(r.url) : null,
      }));
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] listCriticalAnnouncements failed: ${e?.message || e}`);
      return [];
    }
  }

  async listRecentNews(sinceHours: number): Promise<NewsRow[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { MarketNews } = require('../models/MarketNews');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
      const rows: any[] = await MarketNews.findAll({
        attributes: ['title_hash', 'publish_time', 'title', 'content', 'source', 'url'],
        where: { publish_time: { [Op.gte]: cutoff } },
        order: [['publish_time', 'DESC']],
        limit: 2000,
        raw: true,
      });
      return (rows || []).map((r: any) => ({
        title_hash: String(r.title_hash),
        publish_time: r.publish_time instanceof Date ? r.publish_time : new Date(r.publish_time),
        title: String(r.title || ''),
        content: r.content ? String(r.content) : null,
        source: String(r.source || ''),
        url: r.url ? String(r.url) : null,
      }));
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] listRecentNews failed: ${e?.message || e}`);
      return [];
    }
  }

  async listSentimentsByCodes(
    bareCodes: string[],
    lookbackDays: number
  ): Promise<SentimentDailyRow[]> {
    if (!bareCodes || bareCodes.length === 0) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { StockSentiment } = require('../models/StockSentiment');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const cutoffDate = cutoff.toISOString().slice(0, 10);
      const rows: any[] = await StockSentiment.findAll({
        attributes: ['stock_code', 'trade_date', 'post_count', 'rank', 'heat_score'],
        where: {
          stock_code: { [Op.in]: bareCodes },
          trade_date: { [Op.gte]: cutoffDate },
        },
        raw: true,
      });
      return (rows || []).map((r: any) => ({
        stock_code: String(r.stock_code),
        trade_date: String(r.trade_date),
        post_count: r.post_count === null || r.post_count === undefined ? null : Number(r.post_count),
        rank: r.rank === null || r.rank === undefined ? null : Number(r.rank),
        heat_score: r.heat_score === null || r.heat_score === undefined ? null : Number(r.heat_score),
      }));
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] listSentimentsByCodes failed: ${e?.message || e}`);
      return [];
    }
  }

  async listRecentKolOpinions(
    bareCodes: string[],
    sinceDays: number
  ): Promise<KolOpinionRow[]> {
    if (!bareCodes || bareCodes.length === 0) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { KOLOpinion } = require('../models/KOLOpinion');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
      const cutoffDate = cutoff.toISOString().slice(0, 10);
      const rows: any[] = await KOLOpinion.findAll({
        attributes: ['stock_code', 'kol_name', 'opinion_date', 'kol_source', 'opinion_summary', 'sentiment_score'],
        where: {
          stock_code: { [Op.in]: bareCodes },
          opinion_date: { [Op.gte]: cutoffDate },
        },
        raw: true,
      });
      return (rows || []).map((r: any) => ({
        stock_code: String(r.stock_code),
        kol_name: String(r.kol_name || ''),
        opinion_date: String(r.opinion_date),
        kol_source: String(r.kol_source || ''),
        opinion_summary: String(r.opinion_summary || ''),
        sentiment_score:
          r.sentiment_score === null || r.sentiment_score === undefined
            ? null
            : Number(r.sentiment_score),
      }));
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] listRecentKolOpinions failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadRecentDedupKeys(sinceHours: number): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RiskAlert } = require('../models/RiskAlert');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
      const rows: any[] = await RiskAlert.findAll({
        attributes: ['message'],
        where: {
          rule_id: 'stock_bullish_event',
          created_at: { [Op.gte]: cutoff },
        },
        raw: true,
      });
      const re = /\[dedup_key:([^\]]+)\]/;
      for (const r of rows || []) {
        const m = re.exec(String(r.message || ''));
        if (m && m[1]) out.add(m[1]);
      }
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] loadRecentDedupKeys failed: ${e?.message || e}`);
    }
    return out;
  }

  async writeRiskAlerts(input: {
    user_ids: number[];
    symbol: string;
    name: string;
    level: 'MEDIUM' | 'HIGH';
    rule_id: string;
    message: string;
  }): Promise<{ created_ids: number[]; failed: number }> {
    const created_ids: number[] = [];
    let failed = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RiskAlert } = require('../models/RiskAlert');
      for (const uid of input.user_ids) {
        try {
          const row = await RiskAlert.create({
            user_id: uid,
            symbol: input.symbol,
            name: input.name,
            level: input.level,
            message: input.message,
            rule_id: input.rule_id,
          });
          if (row?.id) created_ids.push(Number(row.id));
        } catch (e: any) {
          failed += 1;
          logger.warn(
            `[BullishEventDetector] write RiskAlert user=${uid} symbol=${input.symbol} failed: ${e?.message || e}`
          );
        }
      }
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] writeRiskAlerts top throw: ${e?.message || e}`);
    }
    return { created_ids, failed };
  }

  async listActiveUserIds(): Promise<number[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPortfolio } = require('../models/PaperTradingPortfolio');
      const rows: any[] = await PaperTradingPortfolio.findAll({
        attributes: ['user_id'],
        where: { is_active: true },
        group: ['user_id'],
        raw: true,
      });
      return (rows || [])
        .map((r: any) => Number(r?.user_id))
        .filter((n: number) => Number.isFinite(n) && n > 0);
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] listActiveUserIds failed: ${e?.message || e}`);
      return [];
    }
  }
}

export const DEFAULT_BULLISH_DATA_SOURCE: BullishDataSource = new DefaultBullishDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface BullishEventDetectorDeps {
  dataSource?: BullishDataSource;
  /** 测试 — 覆盖 SystemAdminAlertPusher (默认 pushSystemAdminAlertFireAndForget) */
  feishu_push?: (input: {
    dedup_key: string;
    level: 'INFO' | 'WARN' | 'HIGH' | 'CRITICAL';
    title: string;
    body_markdown: string;
    deeplink?: string;
  }) => Promise<{ pushed: boolean }> | { pushed: boolean };
}

const ANNOUNCEMENT_LOOKBACK_DAYS = 3;
const NEWS_LOOKBACK_HOURS = 24;
const SENTIMENT_LOOKBACK_DAYS = 8;
const KOL_LOOKBACK_DAYS = 3;
const AI_REC_LOOKBACK_DAYS = 30;
const DEDUP_LOOKBACK_HOURS = 24;
const UNIVERSE_HARD_CAP = 1000;

export class BullishEventDetectorService {
  private readonly ds: BullishDataSource;
  private readonly feishuPush?: BullishEventDetectorDeps['feishu_push'];

  constructor(deps: BullishEventDetectorDeps = {}) {
    this.ds = deps.dataSource ?? DEFAULT_BULLISH_DATA_SOURCE;
    this.feishuPush = deps.feishu_push;
  }

  /** 主入口. 整次永不 throw — 失败计入 result.errors. */
  async runOnce(options: BullishDetectorRunOptions = {}): Promise<BullishDetectorRunResult> {
    const now = options.now || new Date();
    const dryRun = options.dry_run === true;
    const result: BullishDetectorRunResult = {
      ok: true,
      dry_run: dryRun,
      scanned: 0,
      detected: 0,
      pushed: 0,
      deduped: 0,
      by_detector: {
        critical_announcement: 0,
        positive_news: 0,
        attention_spike: 0,
        kol_consensus: 0,
      },
      errors: [],
    };

    // ---- Step 1: build universe ----
    let universe: UniverseBuildResult;
    try {
      universe = options.universe_override
        ? this.buildUniverseFromList(options.universe_override)
        : await this.buildUniverse();
      universe.code_to_name = await this.fillStockNames(universe);
    } catch (e: any) {
      result.errors.push({ where: 'build_universe', reason: e?.message || String(e) });
      result.ok = false;
      return result;
    }
    result.scanned = universe.bare_codes.size;
    if (universe.bare_codes.size === 0) {
      logger.info('[BullishEventDetector] universe is empty, nothing to scan');
      return result;
    }

    const bareCodes = Array.from(universe.bare_codes);

    // ---- Step 2: run 4 detectors (each fail-OPEN) ----
    const allHits: BullishHit[] = [];
    await this.safeRunDetector('critical_announcement', result, async () => {
      const rows = await this.ds.listCriticalAnnouncements(bareCodes, ANNOUNCEMENT_LOOKBACK_DAYS);
      const hits = detectCriticalAnnouncementHits(rows, universe.code_to_name);
      result.by_detector.critical_announcement += hits.length;
      allHits.push(...hits);
    });
    await this.safeRunDetector('positive_news', result, async () => {
      const rows = await this.ds.listRecentNews(NEWS_LOOKBACK_HOURS);
      const hits = detectPositiveNewsHits(rows, universe.code_to_name);
      result.by_detector.positive_news += hits.length;
      allHits.push(...hits);
    });
    await this.safeRunDetector('attention_spike', result, async () => {
      const rows = await this.ds.listSentimentsByCodes(bareCodes, SENTIMENT_LOOKBACK_DAYS);
      const hits = detectAttentionSpikeHits(rows, universe.code_to_name);
      result.by_detector.attention_spike += hits.length;
      allHits.push(...hits);
    });
    await this.safeRunDetector('kol_consensus', result, async () => {
      const rows = await this.ds.listRecentKolOpinions(bareCodes, KOL_LOOKBACK_DAYS);
      const hits = detectKolConsensusHits(rows, universe.code_to_name);
      result.by_detector.kol_consensus += hits.length;
      allHits.push(...hits);
    });
    result.detected = allHits.length;

    if (allHits.length === 0) {
      return result;
    }

    // ---- Step 3: dedup vs near-24h history (per (stock, detector, date)) ----
    let recentDedupKeys: Set<string>;
    try {
      recentDedupKeys = await this.ds.loadRecentDedupKeys(DEDUP_LOOKBACK_HOURS);
    } catch (e: any) {
      result.errors.push({ where: 'load_dedup', reason: e?.message || String(e) });
      recentDedupKeys = new Set();
    }

    // ---- Step 4: load active users ----
    let activeUsers: number[] = [];
    try {
      activeUsers = await this.ds.listActiveUserIds();
    } catch (e: any) {
      result.errors.push({ where: 'list_active_users', reason: e?.message || String(e) });
    }

    // ---- Step 5: 逐 hit dedup + 写 RiskAlert + 推飞书 ----
    // 同次 run 内同 stock + detector 也去重 (避免多条 news 命中同股推多次)
    const seenInThisRun = new Set<string>();
    for (const hit of allHits) {
      const dedupKey = buildDedupKey(hit.stock_code, hit.detector, now);
      if (seenInThisRun.has(dedupKey)) {
        result.deduped += 1;
        continue;
      }
      seenInThisRun.add(dedupKey);
      if (recentDedupKeys.has(dedupKey)) {
        result.deduped += 1;
        continue;
      }
      if (dryRun) {
        result.pushed += 1;
        continue;
      }
      // Resolve prefixed symbol for RiskAlert.symbol (与既有 risk_alerts 行格式对齐)
      const prefixedSymbol = this.resolvePrefixed(hit.stock_code, universe);
      const message = appendDedupTag(
        `【利好提示 - ${hit.detector_label}】${hit.reason}`,
        dedupKey
      );
      // (a) RiskAlert per active user
      if (activeUsers.length > 0) {
        try {
          await this.ds.writeRiskAlerts({
            user_ids: activeUsers,
            symbol: prefixedSymbol,
            name: hit.stock_name,
            level: 'MEDIUM',
            rule_id: 'stock_bullish_event',
            message,
          });
        } catch (e: any) {
          result.errors.push({
            where: `write_risk_alert:${hit.stock_code}:${hit.detector}`,
            reason: e?.message || String(e),
          });
        }
      }
      // (b) OPS 飞书群 (走 env webhook, 不依赖 user 设置)
      try {
        await this.pushFeishu(hit, dedupKey);
      } catch (e: any) {
        result.errors.push({
          where: `feishu_push:${hit.stock_code}:${hit.detector}`,
          reason: e?.message || String(e),
        });
      }
      result.pushed += 1;
    }

    return result;
  }

  private async safeRunDetector(
    detector: BullishDetectorType,
    result: BullishDetectorRunResult,
    fn: () => Promise<void>
  ): Promise<void> {
    try {
      await fn();
    } catch (e: any) {
      result.errors.push({ where: detector, reason: e?.message || String(e) });
      logger.warn(`[BullishEventDetector] detector ${detector} failed: ${e?.message || e}`);
    }
  }

  private async buildUniverse(): Promise<UniverseBuildResult> {
    const bare = new Set<string>();
    const pref = new Set<string>();
    const addSym = (s: string) => {
      const trimmed = String(s || '').trim();
      if (!trimmed) return;
      const norm = normalizeSymbol(trimmed);
      const b = toBareCode(norm);
      if (b) bare.add(b);
      if (norm) pref.add(norm);
    };
    try {
      (await this.ds.listPositionSymbols()).forEach(addSym);
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] universe positions failed: ${e?.message || e}`);
    }
    try {
      (await this.ds.listFavoriteSymbols()).forEach(addSym);
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] universe favorites failed: ${e?.message || e}`);
    }
    try {
      (await this.ds.listAIRecommendedSymbols(AI_REC_LOOKBACK_DAYS)).forEach(addSym);
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] universe AI rec failed: ${e?.message || e}`);
    }
    // hard cap 防一次扫太大
    if (bare.size > UNIVERSE_HARD_CAP) {
      const truncated = new Set<string>();
      let i = 0;
      for (const b of bare) {
        if (i++ >= UNIVERSE_HARD_CAP) break;
        truncated.add(b);
      }
      return { bare_codes: truncated, prefixed_symbols: pref, code_to_name: new Map() };
    }
    return { bare_codes: bare, prefixed_symbols: pref, code_to_name: new Map() };
  }

  private buildUniverseFromList(symbols: string[]): UniverseBuildResult {
    const bare = new Set<string>();
    const pref = new Set<string>();
    for (const s of symbols) {
      const norm = normalizeSymbol(String(s || '').trim());
      const b = toBareCode(norm);
      if (b) bare.add(b);
      if (norm) pref.add(norm);
    }
    return { bare_codes: bare, prefixed_symbols: pref, code_to_name: new Map() };
  }

  private async fillStockNames(u: UniverseBuildResult): Promise<Map<string, string>> {
    if (u.bare_codes.size === 0) return new Map();
    try {
      return await this.ds.resolveStockNames(Array.from(u.bare_codes));
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] resolveStockNames failed: ${e?.message || e}`);
      return new Map();
    }
  }

  private resolvePrefixed(bareCode: string, universe: UniverseBuildResult): string {
    // 优先在 universe.prefixed_symbols 中找带前缀版本; 找不到走 normalizeSymbol
    for (const p of universe.prefixed_symbols) {
      if (toBareCode(p) === bareCode) return p;
    }
    return normalizeSymbol(bareCode);
  }

  private async pushFeishu(hit: BullishHit, dedupKey: string): Promise<void> {
    const dedupForPusher = `bullish:${dedupKey}`;
    const title = `[利好] ${hit.stock_code} ${hit.stock_name} - ${hit.detector_label}`;
    const body = buildOpsBullishCardBody(hit);
    if (this.feishuPush) {
      await this.feishuPush({
        dedup_key: dedupForPusher,
        level: 'INFO',
        title,
        body_markdown: body,
      });
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { pushSystemAdminAlertFireAndForget } = require('./SystemAdminAlertPusher');
      pushSystemAdminAlertFireAndForget({
        dedup_key: dedupForPusher,
        level: 'INFO',
        title,
        body_markdown: body,
      });
    } catch (e: any) {
      logger.warn(`[BullishEventDetector] feishu push failed: ${e?.message || e}`);
    }
  }
}

export const bullishEventDetectorService = new BullishEventDetectorService();
