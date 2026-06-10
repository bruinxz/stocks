/**
 * BlackSwanWatchdog — US-053
 *
 * **黑天鹅事件应对** — 每日扫描所有持仓股，检查是否新增 ST / 停牌 / 重大利空
 * 关键词（'立案' / '退市' / '重大违规' / '处罚' / '问询函' 等），命中后立即
 * 写 `RiskAlert(level='HIGH')` + 调 `notificationService.notifyBlackSwan()`
 * 通知用户。
 *
 * 与 US-047/US-048/US-049/US-050/US-051/US-052 互补的**第 7 类风控形态** ——
 *   - US-047 PositionLimitGuard：pre-trade inline 单股 / 单行业上限（订单期）；
 *   - US-048 TrailingStopGuard：per-position 追踪止损（持有期）；
 *   - US-049 DrawdownCircuitBreaker：portfolio-level cascade（组合期）；
 *   - US-050 MarketRegimeAlertService：market-level 指数信号（大盘期）；
 *   - US-051 PerStockStopLossGuard：per-position 硬止损（成本期）；
 *   - US-052 IndustryConcentrationGuard：post-trade 行业聚合（持有期）；
 *   - **US-053 BlackSwanWatchdog**：**event-driven** 个股黑天鹅（基本面 +
 *     交易状态 + 新闻 NLP，**外部事件触发**而非用户数据驱动）。
 *
 * 这是首个**事件驱动**的风控形态：前 6 类 guard 输入都是用户自己的持仓 /
 * 组合 / 指数收盘数据，本 guard 输入是**外部事件源**（AKShare ST / 停牌
 * 名单 / 个股新闻），事件命中持仓时才发预警 —— 与"外部异常"和"用户暴露"
 * 的交集模型完全不同于前 6 类。
 *
 * AC 关键点：
 *   1. 在 backend/src/portfolio/risk/ 新建 BlackSwanWatchdog.ts；
 *   2. 数据源：stock_zh_a_st_em (ST 列表) + stock_zh_a_stop_em (停牌列表) +
 *      stock_news_em (重大新闻 — 替代 AC 中不存在的 stock_news_main_cx_em，
 *      见 BlackSwanClient.ts 顶部 4 处文档同步说明)；
 *   3. 对每只持仓每日检查是否新增 ST / 停牌 / 重大利空关键词
 *      ('立案' / '退市' / '重大违规' / '处罚' / '问询函')；
 *   4. 触发后立即写 RiskAlert(level='HIGH') + 调 notificationService
 *      (US-080 实现后才能真发飞书 / 邮件；当前 stub 仅 logger.info)；
 *   5. 新增单元测试 + typecheck pass + tests pass。
 *
 * 触发流程：
 *   `evaluateAfterOpen(user_id?, dry_run?)` — 每日开盘后定时任务
 *   - 默认 scope = 所有有 PaperTradingPortfolio 的用户；user_id 限定单 user；
 *   - 单 user 失败 try/catch 隔离（同 US-047/US-048/US-049/US-051/US-052）；
 *   - 流程：
 *     (a) 一次性 fetch ST / 停牌 全市场快照（共享给所有用户）；
 *     (b) per-user 取持仓 → 检查每只是否在 ST set / 停牌 set 中；
 *     (c) per-user per-持仓 fetch 新闻（最多 24h 内 + ≤10 条）→ 关键词扫描；
 *     (d) 触发：写 RiskAlert(level='HIGH', symbol=持仓 symbol) + 调
 *         notificationService 通知（fail-OPEN：notify 失败不阻塞 alert 写入）。
 *   - 反复跑同股 / 同事件去重：依赖 `last_event_signature` JSON 存在
 *     User.risk_config.black_swan.<symbol>，含 `event_type` + `key`（如 ST 用
 *     symbol、新闻用 title hash），重复事件跳过；
 *
 * 设计约束 — 沿用 US-047/US-048/US-049/US-051/US-052 的 7 项 checklist：
 *   - DataSource 接口注入（生产 Sequelize + BlackSwanClient + 测试 fake）；
 *   - 纯函数 helper 全 export 让单测无需 DB / 无需 AKShare（
 *     normalizeBlackSwanConfig / detectKeywordHits / classifyKeywordSeverity /
 *     computeNewsRecencyHours / signatureForEvent / pickDistinctEvents 等）；
 *   - 配置在 User.risk_config.black_swan JSONB + Object.freeze 默认；
 *   - 触发 → RiskAlert(level='HIGH')；
 *   - 写 RiskAlert 失败 try/catch + logger.warn 不掩盖 trigger 返回；
 *   - 单 user 失败 try/catch 隔离不阻塞剩余 user；
 *   - HTTP 入口 GET/PUT /api/risk/black-swan，与现有 risk endpoints 共 namespace；
 *   - 不破坏 facade 收敛 — guard 只输出 alert + 通知，调用方决定是否撮合。
 *
 * 边界与坑：
 *   - **新闻关键词命中用 case-insensitive `String.includes()`**：A 股新闻
 *     中文为主，但偶尔混入英文公告（如 'SEC notice'），统一 lowercased 比对；
 *   - **新闻时间窗口**：默认仅扫 publish_time ≥ asOfDate - 24h 的新闻
 *     （`news_lookback_hours=24` 可配）。避免老新闻反复触发；
 *   - **ST / 停牌 是 snapshot**：当日 list 直接对比持仓 set；不存 history
 *     表是因 ST 状态是 status snapshot，AKShare 端点不提供 history。新加入
 *     ST 的判定 = "今日 ST list 含此 symbol + 上次 signature 不含 ST 事件"；
 *   - **去重 signature**：(event_type, key) where key:
 *       - ST: 持仓 symbol 自身（同 ST 状态期间只发一次）；
 *       - SUSPENDED: 持仓 symbol + asOfDate ISO（每天可以再发，恢复交易
 *         自然停止；如果一直停牌 N 天都发 N 次提示 — 同 US-050 死叉每天
 *         可触发的设计，提示不应被去重静默）；
 *       → 修正版：SUSPENDED 也只用 symbol（同 ST，恢复交易后才能重新触发）；
 *       - NEWS_KEYWORD: 持仓 symbol + title hash (前 50 字符 + 关键词)；
 *     signature 落在 `User.risk_config.black_swan_seen` JSONB 中，由 guard
 *     自维护 (JSONB array，最多 200 条 LRU)；
 *   - **持仓股的 symbol 形态 = '600519.SH'**，AKShare 返回的 stock_code 是
 *     '600519'。比对时统一 `stripSuffix()` 后比对；
 *   - **数据源故障 → fail-OPEN**：BlackSwanClient.fetchSTList() 抛 → 当日
 *     ST 检查跳过（不阻塞停牌 + 新闻检查）；同款 US-050 fail-OPEN；
 *   - **notify 失败不阻塞 alert**：notify 是衍生通道，主路径 RiskAlert 写入
 *     是核心；notify try/catch + logger.warn；
 *   - **enabled=false**：整 user 跳过（returns NONE 不写任何 alert）；
 *   - **新闻 limit 上限**：每只持仓只取最近 ~50 条（黑天鹅时间敏感，老新闻
 *     无意义），减少 AKShare 调用成本；
 *   - **未持仓 stock 不发 alert**：watchdog 只关心用户持仓，全市场扫描留给
 *     后续 US-067 (KOL 观点) / US-068 (情绪)。
 */

import { Op } from 'sequelize';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { Stock } from '../../models/Stock';
import { RiskAlert } from '../../models/RiskAlert';
import { User } from '../../models/User';
import { logger } from '../../utils/logger';
import {
  BlackSwanClient,
  STStockRow,
  SuspendedStockRow,
  StockNewsRow,
  blackSwanClient,
} from '../../data/sources/BlackSwanClient';

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

export interface BlackSwanConfig {
  /** 是否启用（false = 跳过整个 guard）。 */
  enabled: boolean;
  /** 是否扫描 ST / *ST 新增标记（默认 true）。 */
  scan_st: boolean;
  /** 是否扫描停牌（默认 true）。 */
  scan_suspended: boolean;
  /** 是否扫描重大利空新闻关键词（默认 true）。 */
  scan_news: boolean;
  /**
   * 新闻关键词列表 — 命中任一即触发。默认含 '立案' / '退市' / '重大违规' /
   * '处罚' / '问询函'。空 array → 关闭关键词触发（等同 scan_news=false）。
   */
  news_keywords: readonly string[];
  /** 新闻回看窗口 (小时)，默认 24h。 */
  news_lookback_hours: number;
  /** 每只持仓最多扫多少条新闻（cost cap），默认 50。 */
  news_per_stock_limit: number;
  /**
   * 是否启用去重（默认 true）。同事件已发过 alert 后跳过，依赖
   * User.risk_config.black_swan_seen JSONB array (LRU 200 条)。
   */
  dedupe_enabled: boolean;
}

/**
 * 默认配置（AC 指定）：启用 + 全部扫描 + 关键词列表 + 24h 窗口 + 50 条上限。
 *
 * `Object.freeze` 防止模块级常量被意外 mutate（US-037 codebase pattern）。
 * `news_keywords` 用 `as const` 让 readonly 类型推断收紧。
 */
export const DEFAULT_BLACK_SWAN_CONFIG: BlackSwanConfig = Object.freeze({
  enabled: true,
  scan_st: true,
  scan_suspended: true,
  scan_news: true,
  news_keywords: Object.freeze(['立案', '退市', '重大违规', '处罚', '问询函']),
  news_lookback_hours: 24,
  news_per_stock_limit: 50,
  dedupe_enabled: true,
});

/** LRU dedup buffer 上限 — 防 JSONB 无限增长。 */
export const BLACK_SWAN_SEEN_LRU_LIMIT = 200;

// ---------------------------------------------------------------------------
//  Domain types
// ---------------------------------------------------------------------------

/** 黑天鹅事件类型。 */
export type BlackSwanEventType = 'ST' | 'SUSPENDED' | 'NEWS_KEYWORD';

/** 单条 trigger payload。 */
export interface BlackSwanTrigger {
  user_id: number;
  position_id: number;
  symbol: string;
  name: string;
  event_type: BlackSwanEventType;
  /**
   * Event 详情：
   *   - ST: { latest_price, change_pct, raw_name (含 ST 前缀) }；
   *   - SUSPENDED: { latest_price, change_pct, last_trade_price }；
   *   - NEWS_KEYWORD: { keyword, title, content, publish_time, source, url }。
   */
  detail: Record<string, unknown>;
  /** signature 用于去重（同 event 不重复发）。 */
  signature: string;
  /** 中文消息（已渲染）。 */
  message: string;
}

/** per-position evaluation result. */
export interface PositionBlackSwanResult {
  position_id: number;
  symbol: string;
  /** 状态：triggered / skipped_seen (dedup hit) / no_event / skipped_disabled。 */
  status: 'triggered' | 'skipped_seen' | 'no_event' | 'skipped_disabled';
  /** 命中的事件类型（triggered / skipped_seen 才有）。 */
  event_type?: BlackSwanEventType;
  /** 中文描述（用于审计 / dashboard）。 */
  reason?: string;
}

/** per-user evaluation result. */
export interface BlackSwanUserResult {
  user_id: number;
  portfolio_id: number | null;
  enabled: boolean;
  open_positions_count: number;
  triggered_count: number;
  triggers: BlackSwanTrigger[];
  per_position: PositionBlackSwanResult[];
  error?: string;
}

/** 全局 evaluation result. */
export interface BlackSwanEvaluationResult {
  scanned_users: number;
  triggered_users: number;
  /** 所有用户的 trigger 平铺（方便 notify 层处理）。 */
  triggers: BlackSwanTrigger[];
  per_user: BlackSwanUserResult[];
  /** Market-wide ST list size（debug）。 */
  st_market_size: number;
  /** Market-wide suspended list size。 */
  suspended_market_size: number;
  /** 是否 dry_run（无 alert 写入）。 */
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
//  Pure helpers (export for unit tests — no DB, no AKShare)
// ---------------------------------------------------------------------------

/**
 * `'600519.SH'` → `'600519'`；`'600519'` → `'600519'`；其他 → 原值。
 * 用于将持仓 symbol (含 '.SH' 后缀) 与 AKShare 返回的 6 位 code 对齐。
 */
export function stripSymbolSuffix(symbol: string): string {
  if (typeof symbol !== 'string') return symbol as any;
  const idx = symbol.indexOf('.');
  if (idx < 0) return symbol;
  return symbol.slice(0, idx);
}

/**
 * 检查新闻 title + content 是否命中任一关键词（case-insensitive 包含）。
 *
 * - 关键词 array 为空 / null → 始终返回 []；
 * - title 或 content 为 null → 仅扫存在的字段；
 * - 返回**首次命中的关键词**（不重复命中多条），避免单条新闻产生 N 条 alert。
 *
 * @returns 命中的关键词数组（最多一个；保留 array 形态便于未来扩 "多关键词
 *   命中加权"）。
 */
export function detectKeywordHits(
  title: string | null | undefined,
  content: string | null | undefined,
  keywords: readonly string[]
): string[] {
  if (!keywords || keywords.length === 0) return [];
  const text = `${title ?? ''}\n${content ?? ''}`.toLowerCase();
  if (text.trim().length === 0) return [];
  for (const kw of keywords) {
    if (!kw || typeof kw !== 'string') continue;
    if (text.includes(kw.toLowerCase())) {
      return [kw];
    }
  }
  return [];
}

/**
 * 计算新闻 publish_time 距离 asOfDate 的小时数。
 *
 * - publish_time null / 无法解析 → 返回 null（caller 跳过该新闻）；
 * - asOfDate 默认 now；
 * - 兼容 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DDTHH:mm:ss' / 'YYYY-MM-DD' /
 *   epoch ms 格式。
 */
export function computeNewsRecencyHours(
  publishTime: string | null | undefined,
  asOfDate: Date = new Date()
): number | null {
  if (!publishTime) return null;
  const trimmed = String(publishTime).trim();
  if (trimmed.length === 0) return null;
  let ts = Number(trimmed);
  if (!Number.isFinite(ts) || ts < 1e10) {
    // 不是 epoch ms → 走 Date.parse；replace space with T for safari/node compatibility
    const iso = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
    ts = Date.parse(iso);
  }
  if (!Number.isFinite(ts)) return null;
  const diffMs = asOfDate.getTime() - ts;
  if (!Number.isFinite(diffMs)) return null;
  return diffMs / 3_600_000;
}

/**
 * 构造去重 signature（per-event-type stable key）。
 *
 *   ST: `ST::<symbol>` — 进入 ST 后 long-lived (撤销 ST 才会清);
 *   SUSPENDED: `SUSPENDED::<symbol>` — 停牌期间 long-lived;
 *   NEWS_KEYWORD: `NEWS::<symbol>::<keyword>::<title-hash>` —
 *     同新闻不重复发，不同新闻命中同关键词仍可触发；
 */
export function signatureForEvent(input: {
  event_type: BlackSwanEventType;
  symbol: string;
  keyword?: string;
  title?: string | null;
}): string {
  const sym = input.symbol;
  if (input.event_type === 'ST') return `ST::${sym}`;
  if (input.event_type === 'SUSPENDED') return `SUSPENDED::${sym}`;
  const kw = input.keyword || '';
  const titleHash = hashTitle(input.title || '');
  return `NEWS::${sym}::${kw}::${titleHash}`;
}

/**
 * 简易 hash (4-byte) for news title — 不用 crypto 减少依赖；碰撞率足够低
 * 因 (symbol, keyword) 已经把碰撞空间缩到极小子集。
 */
export function hashTitle(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 在多条候选 trigger 中按 (signature, event_type) 去重（同事件保留首条）。
 *
 * 用 Map 保序遍历：keep first occurrence per signature；适合 NEWS 命中多条
 * 同 title 时只发一条。
 */
export function pickDistinctEvents(triggers: BlackSwanTrigger[]): BlackSwanTrigger[] {
  const seen = new Set<string>();
  const out: BlackSwanTrigger[] = [];
  for (const t of triggers) {
    if (seen.has(t.signature)) continue;
    seen.add(t.signature);
    out.push(t);
  }
  return out;
}

/**
 * 把新 signatures 合并到既有 seen array 中（FIFO LRU，最多 LIMIT 条）。
 *
 * 老的 signature 在尾部，新的 signature push 到尾部；超过 LIMIT 从 head pop。
 * 已有的 signature 移到尾部刷新 LRU 位置（保持"近期活跃"含义）。
 */
export function mergeSeenSignatures(
  existing: string[] | null | undefined,
  newOnes: string[],
  limit: number = BLACK_SWAN_SEEN_LRU_LIMIT
): string[] {
  const exist = Array.isArray(existing) ? existing.filter(s => typeof s === 'string') : [];
  const seen = new Set(exist);
  const out: string[] = [...exist];
  for (const sig of newOnes) {
    if (typeof sig !== 'string') continue;
    if (seen.has(sig)) {
      // bump LRU position: remove old, push new
      const idx = out.indexOf(sig);
      if (idx >= 0) out.splice(idx, 1);
    } else {
      seen.add(sig);
    }
    out.push(sig);
  }
  // FIFO trim from head
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : BLACK_SWAN_SEEN_LRU_LIMIT;
  if (out.length > safeLimit) {
    return out.slice(out.length - safeLimit);
  }
  return out;
}

/**
 * 净化 raw config blob（来自 User.risk_config 或 PUT body）。
 *
 * - 非有限 / 负 / 非整数 → 默认；
 * - 非 boolean enabled / scan_* / dedupe_enabled → 默认；
 * - keywords 必须 array of non-empty string，否则 → 默认；
 *
 * 与 US-047/US-048/US-049/US-051/US-052 normalize 同款"沉默退回默认不 4xx"。
 */
export function normalizeBlackSwanConfig(raw: any): BlackSwanConfig {
  const safeBool = (v: any, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  const safePosInt = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : dflt;
  };
  const safeKeywords = (v: any, dflt: readonly string[]) => {
    if (!Array.isArray(v)) return [...dflt];
    const filtered = v
      .filter((s: any) => typeof s === 'string' && s.trim().length > 0)
      .map(s => String(s).trim());
    return filtered.length > 0 ? filtered : [...dflt];
  };
  return {
    enabled: safeBool(raw?.enabled, DEFAULT_BLACK_SWAN_CONFIG.enabled),
    scan_st: safeBool(raw?.scan_st, DEFAULT_BLACK_SWAN_CONFIG.scan_st),
    scan_suspended: safeBool(raw?.scan_suspended, DEFAULT_BLACK_SWAN_CONFIG.scan_suspended),
    scan_news: safeBool(raw?.scan_news, DEFAULT_BLACK_SWAN_CONFIG.scan_news),
    news_keywords: safeKeywords(raw?.news_keywords, DEFAULT_BLACK_SWAN_CONFIG.news_keywords),
    news_lookback_hours: safePosInt(
      raw?.news_lookback_hours,
      DEFAULT_BLACK_SWAN_CONFIG.news_lookback_hours
    ),
    news_per_stock_limit: safePosInt(
      raw?.news_per_stock_limit,
      DEFAULT_BLACK_SWAN_CONFIG.news_per_stock_limit
    ),
    dedupe_enabled: safeBool(raw?.dedupe_enabled, DEFAULT_BLACK_SWAN_CONFIG.dedupe_enabled),
  };
}

/** 拼装 ST 触发 message（中文）。 */
export function buildSTMessage(input: {
  symbol: string;
  name: string;
  raw_name: string | null;
  change_pct: number | null;
}): string {
  const flagged = input.raw_name && input.raw_name !== input.name ? input.raw_name : input.name;
  const pct =
    input.change_pct !== null && Number.isFinite(input.change_pct)
      ? `${input.change_pct.toFixed(2)}%`
      : '—';
  return (
    `${input.symbol}（${input.name}）已被纳入风险警示板（${flagged}）。` +
    `当日涨跌 ${pct}。强烈建议第一时间评估是否清仓避险。`
  );
}

/** 拼装 SUSPENDED 触发 message（中文）。 */
export function buildSuspendedMessage(input: {
  symbol: string;
  name: string;
  latest_price: number | null;
}): string {
  const price =
    input.latest_price !== null && Number.isFinite(input.latest_price)
      ? `${input.latest_price.toFixed(3)} 元`
      : '—';
  return (
    `${input.symbol}（${input.name}）今日**停牌**。最后交易价 ${price}。` +
    `请关注复牌公告与利空原因，做好持仓重估。`
  );
}

/** 拼装新闻关键词触发 message（中文）。 */
export function buildNewsKeywordMessage(input: {
  symbol: string;
  name: string;
  keyword: string;
  title: string;
  source: string | null;
  publish_time: string | null;
}): string {
  const ts = input.publish_time || '近期';
  const source = input.source || '未知来源';
  return (
    `${input.symbol}（${input.name}）出现重大利空关键词【${input.keyword}】。` +
    `标题：${input.title}（${source} / ${ts}）。` +
    `强烈建议复盘后立刻评估持仓。`
  );
}

// ---------------------------------------------------------------------------
//  DataSource — DI seam for unit tests
// ---------------------------------------------------------------------------

export interface BlackSwanDataSource {
  /** Load all users with at least one paper-trading portfolio. */
  loadAllUserIdsWithPortfolios(): Promise<number[]>;
  /** Load this user's effective config (defaults if absent). */
  loadConfig(user_id: number): Promise<BlackSwanConfig>;
  /** Persist this user's config (UPSERT semantics). */
  saveConfig(user_id: number, config: BlackSwanConfig): Promise<BlackSwanConfig>;
  /** Load the user's portfolio header (just id). */
  loadPortfolioId(user_id: number): Promise<number | null>;
  /** Load all open positions (quantity > 0) for the user, with name/stock. */
  loadOpenPositions(user_id: number): Promise<
    Array<{
      id: number;
      portfolio_id: number;
      symbol: string;
      name: string;
    }>
  >;
  /** Read User.risk_config.black_swan_seen array (or []). */
  loadSeenSignatures(user_id: number): Promise<string[]>;
  /** Persist updated seen signatures (with LRU trim already applied). */
  saveSeenSignatures(user_id: number, signatures: string[]): Promise<void>;
  /** Fetch full market ST list (snapshot, shared across users). */
  fetchSTList(): Promise<STStockRow[]>;
  /** Fetch full market suspended list (snapshot, shared across users). */
  fetchSuspendedList(): Promise<SuspendedStockRow[]>;
  /** Fetch per-stock recent news (limit applied per config). */
  fetchStockNews(stock_code: string, limit: number): Promise<StockNewsRow[]>;
  /** Write a single RiskAlert row (level='HIGH'). */
  writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    message: string;
  }): Promise<void>;
  /**
   * Notify channels (US-080 dependency) — current stub logs only.
   *
   * The contract is intentionally permissive (return Promise<void>) so the
   * watchdog can call it fire-and-forget. Future US-080 implementation will
   * route to feishu webhook / email / wechat per user channel config.
   */
  notify(payload: BlackSwanTrigger): Promise<void>;
}

/**
 * Production DataSource — backed by Sequelize + BlackSwanClient + logger
 * (NotificationService swap-in lands with US-080).
 */
export class DefaultBlackSwanDataSource implements BlackSwanDataSource {
  private client: BlackSwanClient;

  constructor(client: BlackSwanClient = blackSwanClient) {
    this.client = client;
  }

  async loadAllUserIdsWithPortfolios(): Promise<number[]> {
    const rows = await PaperTradingPortfolio.findAll({
      attributes: ['user_id'],
      group: ['user_id'],
    });
    return rows.map(r => r.user_id);
  }

  async loadConfig(user_id: number): Promise<BlackSwanConfig> {
    const user = await User.findByPk(user_id);
    const raw = user?.risk_config?.black_swan;
    return normalizeBlackSwanConfig(raw);
  }

  async saveConfig(user_id: number, config: BlackSwanConfig): Promise<BlackSwanConfig> {
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`saveConfig: user ${user_id} not found`);
    }
    const merged = {
      ...(user.risk_config || {}),
      black_swan: { ...config, news_keywords: [...config.news_keywords] },
    };
    user.risk_config = merged;
    user.changed('risk_config', true);
    await user.save();
    return { ...config, news_keywords: [...config.news_keywords] };
  }

  async loadPortfolioId(user_id: number): Promise<number | null> {
    const p = await PaperTradingPortfolio.findOne({ where: { user_id } });
    return p ? p.id : null;
  }

  async loadOpenPositions(
    user_id: number
  ): Promise<Array<{ id: number; portfolio_id: number; symbol: string; name: string }>> {
    const portfolio = await PaperTradingPortfolio.findOne({ where: { user_id } });
    if (!portfolio) return [];
    const rows = await PaperTradingPosition.findAll({
      where: { portfolio_id: portfolio.id, quantity: { [Op.gt]: 0 } },
    });
    if (rows.length === 0) return [];
    // Optional name enrichment via Stock — falls back to symbol when missing.
    const symbols = Array.from(new Set(rows.map(r => r.symbol)));
    const stocks = await Stock.findAll({
      where: { symbol: { [Op.in]: symbols } },
      attributes: ['symbol', 'name'],
    });
    const nameMap = new Map<string, string>();
    stocks.forEach(s => nameMap.set(s.symbol, s.name || s.symbol));
    return rows.map(r => ({
      id: r.id,
      portfolio_id: r.portfolio_id,
      symbol: r.symbol,
      name: r.name || nameMap.get(r.symbol) || r.symbol,
    }));
  }

  async loadSeenSignatures(user_id: number): Promise<string[]> {
    const user = await User.findByPk(user_id);
    const raw = user?.risk_config?.black_swan_seen;
    if (!Array.isArray(raw)) return [];
    return raw.filter(s => typeof s === 'string');
  }

  async saveSeenSignatures(user_id: number, signatures: string[]): Promise<void> {
    const user = await User.findByPk(user_id);
    if (!user) return;
    const merged = {
      ...(user.risk_config || {}),
      black_swan_seen: [...signatures],
    };
    user.risk_config = merged;
    user.changed('risk_config', true);
    await user.save();
  }

  async fetchSTList(): Promise<STStockRow[]> {
    try {
      return await this.client.fetchSTList();
    } catch (err) {
      logger.warn(`BlackSwanWatchdog.fetchSTList failed: ${(err as Error).message}`);
      return [];
    }
  }

  async fetchSuspendedList(): Promise<SuspendedStockRow[]> {
    try {
      return await this.client.fetchSuspendedList();
    } catch (err) {
      logger.warn(`BlackSwanWatchdog.fetchSuspendedList failed: ${(err as Error).message}`);
      return [];
    }
  }

  async fetchStockNews(stock_code: string, limit: number): Promise<StockNewsRow[]> {
    try {
      return await this.client.fetchStockNews(stock_code, limit);
    } catch (err) {
      logger.warn(
        `BlackSwanWatchdog.fetchStockNews(${stock_code}) failed: ${(err as Error).message}`
      );
      return [];
    }
  }

  async writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    message: string;
  }): Promise<void> {
    await RiskAlert.create({
      user_id: input.user_id,
      symbol: input.symbol,
      name: input.name,
      level: 'HIGH',
      message: input.message,
      // US-067 — 给 RealtimeAlertDispatcher dedup signature 用。
      rule_id: 'black_swan',
      is_read: false,
    } as any);
  }

  async notify(payload: BlackSwanTrigger): Promise<void> {
    // US-080 stub: feishu / email / wechat routing lives there. Log so ops can
    // see黑天鹅事件 流向 even before the channel implementation lands.
    logger.warn(
      `[BlackSwan] user=${payload.user_id} symbol=${payload.symbol} ` +
        `event=${payload.event_type} message=${payload.message}`
    );
  }
}

export const PRODUCTION_BLACK_SWAN_DATA_SOURCE: BlackSwanDataSource =
  new DefaultBlackSwanDataSource();

// ---------------------------------------------------------------------------
//  Guard — public entry point
// ---------------------------------------------------------------------------

export interface EvaluateBlackSwanOptions {
  /** If set, only process this user. Otherwise scan all users with portfolios. */
  user_id?: number;
  /** Override the date used to bound news recency (defaults to "now"). */
  asOfDate?: Date;
  /** If true, do NOT write RiskAlert rows + skip notify (dry-run for UI/cron preview). */
  dry_run?: boolean;
}

export class BlackSwanWatchdog {
  private source: BlackSwanDataSource;

  constructor(source: BlackSwanDataSource = PRODUCTION_BLACK_SWAN_DATA_SOURCE) {
    this.source = source;
  }

  /**
   * 每日批量评估所有用户的黑天鹅事件。
   *
   * - 单 user 失败 try/catch 隔离（同 US-047 / US-048 / US-049 / US-051 / US-052）；
   * - disabled 用户跳过整个评估（returns enabled=false 不写任何 alert）；
   * - ST / 停牌 list 一次性 fetch 跨用户共享；
   * - per-user per-持仓 fetch 新闻 (lookback 默认 24h，limit 50 条)；
   * - dry_run=true 跳过 RiskAlert 写入 + notify 调用，但仍返回完整 triggers
   *   list（UI 预演用）。
   *
   * 数据源故障 → 该数据维度跳过（其他维度继续）— fail-OPEN，guard 不应该
   * 因数据外 dependency 故障 crash scheduler。
   */
  async evaluateAfterOpen(
    options: EvaluateBlackSwanOptions = {}
  ): Promise<BlackSwanEvaluationResult> {
    const asOfDate = options.asOfDate ?? new Date();
    const dryRun = Boolean(options.dry_run);
    const userIds = options.user_id
      ? [options.user_id]
      : await this.source.loadAllUserIdsWithPortfolios();

    // Market-wide snapshots (shared)
    const stList = await this.source.fetchSTList();
    const suspendedList = await this.source.fetchSuspendedList();
    const stByCode = new Map<string, STStockRow>();
    stList.forEach(r => stByCode.set(r.stock_code, r));
    const suspendedByCode = new Map<string, SuspendedStockRow>();
    suspendedList.forEach(r => suspendedByCode.set(r.stock_code, r));

    const result: BlackSwanEvaluationResult = {
      scanned_users: userIds.length,
      triggered_users: 0,
      triggers: [],
      per_user: [],
      st_market_size: stList.length,
      suspended_market_size: suspendedList.length,
      dry_run: dryRun,
    };

    for (const user_id of userIds) {
      try {
        const ur = await this.evaluateOneUser(user_id, asOfDate, dryRun, stByCode, suspendedByCode);
        result.per_user.push(ur);
        if (ur.triggers.length > 0) {
          result.triggered_users += 1;
        }
        result.triggers.push(...ur.triggers);
      } catch (err) {
        logger.warn(
          `BlackSwanWatchdog.evaluateAfterOpen user=${user_id} failed: ${(err as Error).message}`
        );
        result.per_user.push({
          user_id,
          portfolio_id: null,
          enabled: false,
          open_positions_count: 0,
          triggered_count: 0,
          triggers: [],
          per_position: [],
          error: (err as Error).message,
        });
      }
    }

    return result;
  }

  /** Single-user evaluation extracted for clarity. */
  private async evaluateOneUser(
    user_id: number,
    asOfDate: Date,
    dryRun: boolean,
    stByCode: Map<string, STStockRow>,
    suspendedByCode: Map<string, SuspendedStockRow>
  ): Promise<BlackSwanUserResult> {
    const config = await this.source.loadConfig(user_id);
    const portfolio_id = await this.source.loadPortfolioId(user_id);
    if (portfolio_id === null) {
      return {
        user_id,
        portfolio_id: null,
        enabled: config.enabled,
        open_positions_count: 0,
        triggered_count: 0,
        triggers: [],
        per_position: [],
      };
    }
    const positions = await this.source.loadOpenPositions(user_id);
    const open_positions_count = positions.length;

    if (!config.enabled) {
      return {
        user_id,
        portfolio_id,
        enabled: false,
        open_positions_count,
        triggered_count: 0,
        triggers: [],
        per_position: positions.map(p => ({
          position_id: p.id,
          symbol: p.symbol,
          status: 'skipped_disabled' as const,
        })),
      };
    }

    const seenExisting = config.dedupe_enabled ? await this.source.loadSeenSignatures(user_id) : [];
    const seenSet = new Set(seenExisting);

    const triggers: BlackSwanTrigger[] = [];
    const perPosition: PositionBlackSwanResult[] = [];

    for (const pos of positions) {
      const pureCode = stripSymbolSuffix(pos.symbol);
      let hit = false;

      // 1) ST check (cheap; uses shared market snapshot)
      const stRow = config.scan_st ? stByCode.get(pureCode) : undefined;
      if (stRow) {
        const row = stRow;
        const sig = signatureForEvent({ event_type: 'ST', symbol: pureCode });
        if (config.dedupe_enabled && seenSet.has(sig)) {
          perPosition.push({
            position_id: pos.id,
            symbol: pos.symbol,
            status: 'skipped_seen',
            event_type: 'ST',
            reason: '已发过 ST 告警（dedup）',
          });
        } else {
          const message = buildSTMessage({
            symbol: pos.symbol,
            name: pos.name,
            raw_name: row.stock_name,
            change_pct: row.change_pct,
          });
          triggers.push({
            user_id,
            position_id: pos.id,
            symbol: pos.symbol,
            name: pos.name,
            event_type: 'ST',
            detail: {
              latest_price: row.latest_price,
              change_pct: row.change_pct,
              raw_name: row.stock_name,
            },
            signature: sig,
            message,
          });
          perPosition.push({
            position_id: pos.id,
            symbol: pos.symbol,
            status: 'triggered',
            event_type: 'ST',
            reason: 'ST 风险警示',
          });
          hit = true;
        }
      }

      // 2) Suspended check
      const suspendedRow =
        !hit && config.scan_suspended ? suspendedByCode.get(pureCode) : undefined;
      if (suspendedRow) {
        const row = suspendedRow;
        const sig = signatureForEvent({ event_type: 'SUSPENDED', symbol: pureCode });
        if (config.dedupe_enabled && seenSet.has(sig)) {
          perPosition.push({
            position_id: pos.id,
            symbol: pos.symbol,
            status: 'skipped_seen',
            event_type: 'SUSPENDED',
            reason: '已发过停牌告警（dedup）',
          });
        } else {
          const message = buildSuspendedMessage({
            symbol: pos.symbol,
            name: pos.name,
            latest_price: row.latest_price,
          });
          triggers.push({
            user_id,
            position_id: pos.id,
            symbol: pos.symbol,
            name: pos.name,
            event_type: 'SUSPENDED',
            detail: {
              latest_price: row.latest_price,
              change_pct: row.change_pct,
            },
            signature: sig,
            message,
          });
          perPosition.push({
            position_id: pos.id,
            symbol: pos.symbol,
            status: 'triggered',
            event_type: 'SUSPENDED',
            reason: '停牌',
          });
          hit = true;
        }
      }

      // 3) News keyword check (most expensive — per-stock AKShare call)
      if (!hit && config.scan_news && config.news_keywords.length > 0) {
        const news = await this.source.fetchStockNews(pureCode, config.news_per_stock_limit);
        let newsHit = false;
        for (const n of news) {
          const hours = computeNewsRecencyHours(n.publish_time, asOfDate);
          if (hours === null || hours > config.news_lookback_hours) continue;
          const hits = detectKeywordHits(n.title, n.content, config.news_keywords);
          if (hits.length === 0) continue;
          const kw = hits[0];
          const sig = signatureForEvent({
            event_type: 'NEWS_KEYWORD',
            symbol: pureCode,
            keyword: kw,
            title: n.title,
          });
          if (config.dedupe_enabled && seenSet.has(sig)) {
            perPosition.push({
              position_id: pos.id,
              symbol: pos.symbol,
              status: 'skipped_seen',
              event_type: 'NEWS_KEYWORD',
              reason: `已发过 [${kw}] 告警（dedup）`,
            });
            newsHit = true;
            break;
          }
          const message = buildNewsKeywordMessage({
            symbol: pos.symbol,
            name: pos.name,
            keyword: kw,
            title: n.title,
            source: n.source,
            publish_time: n.publish_time,
          });
          triggers.push({
            user_id,
            position_id: pos.id,
            symbol: pos.symbol,
            name: pos.name,
            event_type: 'NEWS_KEYWORD',
            detail: {
              keyword: kw,
              title: n.title,
              content: n.content,
              publish_time: n.publish_time,
              source: n.source,
              url: n.url,
              recency_hours: hours,
            },
            signature: sig,
            message,
          });
          perPosition.push({
            position_id: pos.id,
            symbol: pos.symbol,
            status: 'triggered',
            event_type: 'NEWS_KEYWORD',
            reason: `命中关键词 ${kw}`,
          });
          newsHit = true;
          hit = true;
          break;
        }
        if (!newsHit && !hit) {
          perPosition.push({ position_id: pos.id, symbol: pos.symbol, status: 'no_event' });
        }
      } else if (!hit) {
        perPosition.push({ position_id: pos.id, symbol: pos.symbol, status: 'no_event' });
      }
    }

    const distinct = pickDistinctEvents(triggers);

    // Persist seen signatures (skip in dry_run) — fold both freshly-fired AND
    // already-seen positions back in so seen array auto-prunes via LRU + stays
    // sized within the limit.
    if (!dryRun && config.dedupe_enabled && distinct.length > 0) {
      const merged = mergeSeenSignatures(
        seenExisting,
        distinct.map(t => t.signature)
      );
      try {
        await this.source.saveSeenSignatures(user_id, merged);
      } catch (err) {
        logger.warn(
          `BlackSwanWatchdog.saveSeenSignatures user=${user_id} failed: ${(err as Error).message}`
        );
      }
    }

    if (!dryRun) {
      for (const t of distinct) {
        try {
          await this.source.writeAlert({
            user_id,
            symbol: t.symbol,
            name: `黑天鹅 - ${t.name || t.symbol}`,
            message: t.message,
          });
        } catch (err) {
          logger.warn(
            `BlackSwanWatchdog.writeAlert user=${user_id} symbol=${t.symbol}: ${
              (err as Error).message
            }`
          );
        }
        try {
          await this.source.notify(t);
        } catch (err) {
          logger.warn(
            `BlackSwanWatchdog.notify user=${user_id} symbol=${t.symbol}: ${(err as Error).message}`
          );
        }
      }
    }

    return {
      user_id,
      portfolio_id,
      enabled: true,
      open_positions_count,
      triggered_count: distinct.length,
      triggers: distinct,
      per_position: perPosition,
    };
  }

  /** Return the user's effective config (defaults if not customized). */
  async getConfig(user_id: number): Promise<BlackSwanConfig> {
    return this.source.loadConfig(user_id);
  }

  /** Persist a (normalized) updated config for the user. */
  async updateConfig(user_id: number, raw: any): Promise<BlackSwanConfig> {
    const normalized = normalizeBlackSwanConfig(raw);
    return this.source.saveConfig(user_id, normalized);
  }
}

/** Singleton — controllers / scheduler / facade reach this instead of `new`-ing per call. */
export const blackSwanWatchdog = new BlackSwanWatchdog();
