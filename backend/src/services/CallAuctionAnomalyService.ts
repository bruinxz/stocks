/**
 * CallAuctionAnomalyService — US-041 / FE-002 「集合竞价异动卡片」开盘前/9:25 后一张卡片。
 *
 * 卡片 1 段（AC）：
 *   - 9:15-9:25 集合竞价结束后, 展示当日 universe 的 4 类异动:
 *     * one_word    — 一字板 (open == high == low == prev_close*1.1, 整笔成交) — 通常买不到
 *     * gap_up      — 高开 ≥ +3% (含跳空缺口入选范围)
 *     * gap_down    — 低开 ≤ -3% (止损/止盈 signal)
 *     * normal      — 平开 / 小幅 (不展示, 仅用于统计)
 *
 * Universe (待观察池):
 *   - 昨日 LimitUpStock (连板/强势股池) — 今日最可能一字 / 大幅高开
 *   - 用户当前持仓 (Position) — 自家盘要看缺口
 *
 * 数据源契约 (DataSource DI):
 *   - loadUniverse(tradeDate, userId?, portfolioId?)   返 [{symbol, name, prev_close, source}]
 *     where source ∈ ('limit_up_pool' | 'position')
 *   - loadRealtimeQuotes(symbols)                       返 [{symbol, open, high, low, current, ...}]
 *
 * fail-OPEN 三层 (与 MarketJudgmentService US-040 同款):
 *   1. loadUniverse throw → components.universe.error = msg, 用空池
 *      → status='partial' 卡片仍显示 "暂无数据";
 *   2. loadRealtimeQuotes throw → components.quotes.error = msg, anomaly 列表为空
 *      → status='partial' brief 显示 "行情未到位";
 *   3. 顶层 try/catch — service.getTodayAuction 永远返完整 shape, 不抛.
 *
 * Why 9:25:
 *   - 9:15-9:20 自由申报 + 自由撤单 (虚假大单常见, 不可信)
 *   - 9:20-9:25 申报 + 不可撤单 (真实订单)
 *   - 9:25:01  集合竞价撮合 → 产生开盘价
 *   本 service 只在 9:25 后调用; 9:25 前调用 components.quotes.error='集合竞价未结束'.
 *
 * 与既有 services 关系:
 *   - 复用 RealtimeQuote model — 数据源 cron 已经在 9:25+ 抓回腾讯/akshare 实时报价;
 *   - 复用 LimitUpStock model — 昨日涨停池;
 *   - 复用 Position model — 用户当前持仓;
 *   - 与 MarketJudgmentService (US-040) 邻居互补: MJ 看大盘 regime, 本 service 看个股动作.
 */

import moment from 'moment-timezone';
import { Op } from 'sequelize';
import { logger } from '../utils/logger';
import { LimitUpStock } from '../models/LimitUpStock';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { realtimeQuoteService } from '../data/services/RealtimeQuoteService';
import { isAShareTradeDay } from '../utils/tradingCalendar';
import { inferMarketSegment, getLimitPct } from '../quant/marketLimits';
import { isSTName } from '../utils/stNameUtils';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 大涨/大跌缺口阈值 (% open vs prev_close) — UI 标红/绿. */
export const GAP_UP_PCT_THRESHOLD = 3.0;
export const GAP_DOWN_PCT_THRESHOLD = -3.0;

/** 一字板判定: open == high == low + close 等于 limit_up (1bp 容差). */
export const ONE_WORD_PRICE_EPSILON = 0.001;

/** 集合竞价结束时间 — 集合竞价 9:15-9:25, 9:25:01 后撮合出开盘价. */
export const CALL_AUCTION_END_HOUR = 9;
export const CALL_AUCTION_END_MINUTE = 25;

/** brief 最大长度 — UI 一句话约束, 与 MarketJudgmentService MAX_BRIEF_LEN 同思想. */
export const MAX_AUCTION_BRIEF_LEN = 100;

/** Universe 最大长度 — 限制 panel 大小 + 单次 query 大小. */
export const MAX_UNIVERSE_SIZE = 60;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type AuctionAnomalyType = 'one_word' | 'gap_up' | 'gap_down' | 'normal';

export type AuctionUniverseSource = 'limit_up_pool' | 'position';

/** 一只待观察股的最小元数据 (有 prev_close 用于计算缺口). */
export interface AuctionUniverseEntry {
  symbol: string;
  name: string | null;
  prev_close: number | null;
  /** 数据来自 limit_up_pool 还是 position — 用于 UI 分类展示. */
  sources: AuctionUniverseSource[];
  /** 来自 limit_up_pool 时的连板数, 来自 position 时不填. */
  continuous_days?: number | null;
  industry?: string | null;
  /** 来自 position 时的当前持仓数, 来自 limit_up_pool 时不填. */
  position_shares?: number | null;
}

export interface AuctionQuoteRow {
  symbol: string;
  name?: string | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  current?: number | null;
  prev_close?: number | null;
  /** 行情更新时间 (server 端 UTC ISO 字符串). */
  quote_time?: string | null;
}

export interface AuctionAnomalyItem {
  symbol: string;
  name: string | null;
  anomaly_type: AuctionAnomalyType;
  open: number | null;
  prev_close: number | null;
  open_change_pct: number | null;
  is_one_word: boolean;
  /** 是否昨日已涨停 (continuous_days ≥ 1). */
  was_yesterday_limit_up: boolean;
  /** 是否当前持仓. */
  is_position: boolean;
  continuous_days?: number | null;
  industry?: string | null;
  sources: AuctionUniverseSource[];
  /** 一句话给 UI 显示, e.g. "高开 +5.2%, 昨日 3 板" */
  note: string;
}

export interface AuctionAnomalySummary {
  total: number;
  one_word_count: number;
  gap_up_count: number;
  gap_down_count: number;
  /** universe 中有 prev_close + 当日 open 都拿到的股票数 (用于计算覆盖率). */
  resolved_count: number;
}

export interface CallAuctionComponentError {
  error: string | null;
}

export interface CallAuctionComponents {
  universe: CallAuctionComponentError;
  quotes: CallAuctionComponentError;
  timing: CallAuctionComponentError;
}

export interface CallAuctionAnomalyResult {
  trade_date: string;
  /** 是否在 9:25 后调用 (false 时 components.timing.error 描述原因). */
  is_after_auction: boolean;
  /** 当前服务器时间 hh:mm (Asia/Shanghai). */
  server_clock: string;
  universe_size: number;
  /** 命中异动 (one_word / gap_up / gap_down) 的股票, 排序: one_word → gap_up → gap_down, 各组内按 |pct| 降序. */
  anomalies: AuctionAnomalyItem[];
  summary: AuctionAnomalySummary;
  brief: string;
  status: 'ok' | 'partial' | 'failed';
  message: string;
  components: CallAuctionComponents;
}

export interface CallAuctionAnomalyOptions {
  /** 覆盖 as-of YYYY-MM-DD, 缺省今天 (Asia/Shanghai). */
  trade_date?: string;
  /** 当前登录用户 id — 用于 Position 池. 未传则不带入持仓维度. */
  user_id?: number;
  /** 当前选盘 portfolio_id (多盘场景) — 用于 Position WHERE 过滤. */
  portfolio_id?: number;
  /** 强制跳过 universe 加载 (单测 / 离线). */
  skip_universe?: boolean;
  /** 强制跳过实时行情加载 (单测 / 离线). */
  skip_quotes?: boolean;
  /** 强制 is_after_auction (单测断言 timing 分支). */
  force_after_auction?: boolean;
  /** 强制 universe 上限, 超过截断 (默认 MAX_UNIVERSE_SIZE). */
  max_universe?: number;
}

export interface CallAuctionAnomalyDataSource {
  loadUniverse(
    tradeDate: string,
    userId?: number,
    portfolioId?: number,
    maxSize?: number
  ): Promise<AuctionUniverseEntry[]>;
  loadRealtimeQuotes(symbols: string[]): Promise<AuctionQuoteRow[]>;
}

// ---------------------------------------------------------------------------
// pure helpers — 全 export 单测
// ---------------------------------------------------------------------------

/** 取今天 (Asia/Shanghai) YYYY-MM-DD; 给 trade_date 兜底. */
export function normalizeAuctionTradeDate(input?: string): string {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

/** 当前时间是否 9:25 后 (Asia/Shanghai); now 可注入便于单测. */
export function isAfterCallAuction(now: Date = new Date()): boolean {
  const sh = moment(now).tz('Asia/Shanghai');
  // 周末/节假日 — 也允许"看昨天的数据回顾用", 但提示 timing
  const minutes = sh.hour() * 60 + sh.minute();
  const auctionMinutes = CALL_AUCTION_END_HOUR * 60 + CALL_AUCTION_END_MINUTE;
  return minutes >= auctionMinutes;
}

/** 当前 hh:mm 字符串 (Asia/Shanghai). */
export function getServerClockShanghai(now: Date = new Date()): string {
  return moment(now).tz('Asia/Shanghai').format('HH:mm');
}

/**
 * 判定一只股的开盘异动类型.
 *
 * 决策表 (按优先级链, 同 MarketJudgmentService.pickSuggestedPositionPct):
 *   1. open 或 prev_close 缺失 / 非数值 → 'normal' (caller 视情况丢弃, 不算异动)
 *   2. open_change_pct = (open - prev_close) / prev_close * 100
 *   3. 一字板: open == high == low (3 价相等, EPSILON 容差) 且 open_change_pct ≈ +limit_pct
 *      → 'one_word' (无法成交)
 *   4. open_change_pct ≥ GAP_UP_PCT_THRESHOLD → 'gap_up'
 *   5. open_change_pct ≤ GAP_DOWN_PCT_THRESHOLD → 'gap_down'
 *   6. 其它 → 'normal'
 *
 * one_word 判定要求 open=high=low + open 涨幅几乎等于 limit_up_pct (10/20/30/5%), 缺
 * one_word 之外的 gap_up 大于阈值的也归为 gap_up — 这样 ST 股 5% 涨停一字会归入 one_word
 * 而不是 gap_up.
 */
export function classifyAuctionAnomaly(input: {
  symbol: string;
  name?: string | null;
  open: number | null | undefined;
  high?: number | null;
  low?: number | null;
  prev_close: number | null | undefined;
}): { type: AuctionAnomalyType; open_change_pct: number | null; is_one_word: boolean } {
  const open = numberOrNull(input.open);
  const prevClose = numberOrNull(input.prev_close);
  const high = numberOrNull(input.high);
  const low = numberOrNull(input.low);

  if (open === null || prevClose === null || prevClose <= 0) {
    return { type: 'normal', open_change_pct: null, is_one_word: false };
  }

  const pct = ((open - prevClose) / prevClose) * 100;
  const pctRounded = Math.round(pct * 100) / 100;

  // 一字板: 三价相等 + 涨幅 ~ limit_pct
  let isOneWord = false;
  if (high !== null && low !== null) {
    const threeEqual =
      Math.abs(open - high) <= ONE_WORD_PRICE_EPSILON &&
      Math.abs(open - low) <= ONE_WORD_PRICE_EPSILON;
    if (threeEqual) {
      const segment = inferMarketSegment(input.symbol);
      const st = isSTName(input.name || null);
      const limitPct = getLimitPct(segment, st) * 100;
      // 容差 0.5% 防 round-half 导致的略低
      if (Math.abs(pct - limitPct) <= 0.5) {
        isOneWord = true;
      }
    }
  }

  if (isOneWord) {
    return { type: 'one_word', open_change_pct: pctRounded, is_one_word: true };
  }
  if (pct >= GAP_UP_PCT_THRESHOLD) {
    return { type: 'gap_up', open_change_pct: pctRounded, is_one_word: false };
  }
  if (pct <= GAP_DOWN_PCT_THRESHOLD) {
    return { type: 'gap_down', open_change_pct: pctRounded, is_one_word: false };
  }
  return { type: 'normal', open_change_pct: pctRounded, is_one_word: false };
}

/** 排序 AuctionAnomalyItem: one_word → gap_up → gap_down, 各组内按 |open_change_pct| 降序. */
export function sortAnomalies(items: AuctionAnomalyItem[]): AuctionAnomalyItem[] {
  const order: Record<AuctionAnomalyType, number> = {
    one_word: 0,
    gap_up: 1,
    gap_down: 2,
    normal: 3,
  };
  return [...items].sort((a, b) => {
    const da = order[a.anomaly_type] - order[b.anomaly_type];
    if (da !== 0) return da;
    const pa = Math.abs(a.open_change_pct ?? 0);
    const pb = Math.abs(b.open_change_pct ?? 0);
    return pb - pa;
  });
}

/** 汇总命中异动数. */
export function summarizeAnomalies(items: AuctionAnomalyItem[]): AuctionAnomalySummary {
  let oneWord = 0;
  let gapUp = 0;
  let gapDown = 0;
  let resolved = 0;
  for (const it of items) {
    if (it.open_change_pct !== null) resolved += 1;
    if (it.anomaly_type === 'one_word') oneWord += 1;
    else if (it.anomaly_type === 'gap_up') gapUp += 1;
    else if (it.anomaly_type === 'gap_down') gapDown += 1;
  }
  return {
    total: items.length,
    one_word_count: oneWord,
    gap_up_count: gapUp,
    gap_down_count: gapDown,
    resolved_count: resolved,
  };
}

/** 把 anomaly + 来源信息拼一句中文 note 给 UI 显示. */
export function buildAuctionNote(input: {
  type: AuctionAnomalyType;
  open_change_pct: number | null;
  continuous_days?: number | null;
  is_position: boolean;
}): string {
  const parts: string[] = [];
  if (input.type === 'one_word') {
    parts.push('一字板（无法买入）');
  } else if (input.type === 'gap_up') {
    parts.push(`高开 ${formatSignedPct(input.open_change_pct ?? 0)}`);
  } else if (input.type === 'gap_down') {
    parts.push(`低开 ${formatSignedPct(input.open_change_pct ?? 0)}`);
  } else {
    parts.push('平开');
  }
  if (input.continuous_days && input.continuous_days >= 1) {
    parts.push(`昨日 ${input.continuous_days} 板`);
  }
  if (input.is_position) {
    parts.push('当前持仓');
  }
  return parts.join('，');
}

/** 拼 brief 一句话, ≤MAX_AUCTION_BRIEF_LEN, 超长截断 + '…'. */
export function buildAuctionBrief(input: {
  isAfterAuction: boolean;
  universe: number;
  summary: AuctionAnomalySummary;
  anyError: boolean;
}): string {
  const { isAfterAuction, universe, summary, anyError } = input;
  if (!isAfterAuction) {
    return `集合竞价未结束（每日 9:25 后展示）; 当前观察池 ${universe} 只`;
  }
  if (anyError && summary.resolved_count === 0) {
    return `集合竞价行情未到位（观察池 ${universe} 只, 暂无开盘价数据）`;
  }
  const segs: string[] = [];
  if (summary.one_word_count > 0) segs.push(`一字 ${summary.one_word_count} 只`);
  if (summary.gap_up_count > 0) segs.push(`高开 ${summary.gap_up_count} 只`);
  if (summary.gap_down_count > 0) segs.push(`低开 ${summary.gap_down_count} 只`);
  if (segs.length === 0) {
    segs.push('全部平开, 无异动');
  }
  const text = `观察池 ${universe} 只; ${segs.join(' / ')}`;
  return text.length <= MAX_AUCTION_BRIEF_LEN
    ? text
    : text.slice(0, MAX_AUCTION_BRIEF_LEN - 1) + '…';
}

/** 折叠 components 为 status. 与 MarketJudgmentService.resolveStatus 同思想. */
export function resolveAuctionStatus(
  components: CallAuctionComponents
): CallAuctionAnomalyResult['status'] {
  const u = components.universe.error === null;
  const q = components.quotes.error === null;
  if (u && q) return 'ok';
  if (!u && !q) return 'failed';
  return 'partial';
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function formatSignedPct(value: number): string {
  if (!Number.isFinite(value)) return '0.00%';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// merge: universe + quotes → anomaly items
// ---------------------------------------------------------------------------

/**
 * 把 universe + quote rows 合并成 AuctionAnomalyItem 列表.
 *
 * - 用 symbol 作为 join key, 兼容 sh./sz./bj. 前缀.
 * - prev_close 优先用 quote 里的 (来自实时源更新更及时), 兜底用 universe 自带的.
 * - universe 里 sources 含 'position' → is_position=true.
 * - 不含异动 (normal + 三价缺失) 的丢弃, 避免 panel 数据膨胀.
 */
export function mergeUniverseAndQuotes(
  universe: AuctionUniverseEntry[],
  quotes: AuctionQuoteRow[]
): AuctionAnomalyItem[] {
  const quoteMap = new Map<string, AuctionQuoteRow>();
  for (const q of quotes) {
    if (q.symbol) quoteMap.set(q.symbol, q);
  }
  const items: AuctionAnomalyItem[] = [];
  for (const u of universe) {
    const q = quoteMap.get(u.symbol);
    const prevClose = numberOrNull(q?.prev_close) ?? numberOrNull(u.prev_close);
    const open = numberOrNull(q?.open);
    const high = numberOrNull(q?.high);
    const low = numberOrNull(q?.low);
    const cls = classifyAuctionAnomaly({
      symbol: u.symbol,
      name: u.name,
      open,
      high,
      low,
      prev_close: prevClose,
    });
    // 仅保留异动 (one_word / gap_up / gap_down) — normal 不进 panel 防膨胀
    if (cls.type === 'normal') continue;
    const isPosition = u.sources.includes('position');
    const wasLimit = (u.continuous_days || 0) >= 1;
    items.push({
      symbol: u.symbol,
      name: u.name,
      anomaly_type: cls.type,
      open,
      prev_close: prevClose,
      open_change_pct: cls.open_change_pct,
      is_one_word: cls.is_one_word,
      was_yesterday_limit_up: wasLimit,
      is_position: isPosition,
      continuous_days: u.continuous_days ?? null,
      industry: u.industry ?? null,
      sources: u.sources,
      note: buildAuctionNote({
        type: cls.type,
        open_change_pct: cls.open_change_pct,
        continuous_days: u.continuous_days,
        is_position: isPosition,
      }),
    });
  }
  return sortAnomalies(items);
}

// ---------------------------------------------------------------------------
// production DataSource
// ---------------------------------------------------------------------------

/**
 * 生产 DataSource — lazy require 模型, 与 MarketJudgmentService 同款写法.
 *
 * universe 池构建:
 *   1. 昨日 LimitUpStock (continuous_days ≥ 1) — 最易出现一字 / 高开
 *      where trade_date < today (取交易日历最近一日)
 *   2. 当前用户的 Position (user_id + portfolio_id) — 持仓必看
 *   合并去重, 同 symbol 多来源 sources 数组合并.
 *
 * 行情:
 *   走 realtimeQuoteService.getLatestQuotes(symbols) — 不发新网络请求, 读 DB.
 *   cron 任务 (cron-15s) 会在 9:25 后把腾讯/akshare 抓回的 open/high/low 落库.
 */
export function createProductionCallAuctionDataSource(): CallAuctionAnomalyDataSource {
  return {
    async loadUniverse(
      tradeDate: string,
      userId?: number,
      portfolioId?: number,
      maxSize: number = MAX_UNIVERSE_SIZE
    ): Promise<AuctionUniverseEntry[]> {
      const out = new Map<string, AuctionUniverseEntry>();
      // ---- 昨日涨停池 ----
      try {
        // 取 trade_date < today 最近一日的 limit_up 池 (今天还没数据)
        const limitUps = await LimitUpStock.findAll({
          attributes: ['stock_code', 'stock_name', 'continuous_days', 'industry', 'trade_date'],
          where: {
            trade_date: { [Op.lt]: tradeDate },
            continuous_days: { [Op.gte]: 1 },
          },
          order: [
            ['trade_date', 'DESC'],
            ['continuous_days', 'DESC'],
          ],
          limit: Math.max(1, Math.floor(maxSize * 0.8)),
          raw: true,
        });
        // 同 stock_code 跨日去重, 取最近一日记录
        const latestByCode = new Map<string, any>();
        for (const row of limitUps as any[]) {
          if (!latestByCode.has(row.stock_code)) latestByCode.set(row.stock_code, row);
        }
        for (const row of latestByCode.values()) {
          const symbol = stockCodeToSymbol(row.stock_code);
          if (!symbol) continue;
          out.set(symbol, {
            symbol,
            name: row.stock_name || null,
            prev_close: null,
            sources: ['limit_up_pool'],
            continuous_days:
              typeof row.continuous_days === 'number'
                ? row.continuous_days
                : Number(row.continuous_days) || null,
            industry: row.industry || null,
          });
        }
      } catch (err: unknown) {
        logger.warn(`[CallAuction] loadUniverse limit_up 失败: ${(err as Error)?.message || err}`);
        throw err;
      }
      // ---- 当前持仓 ----
      if (userId) {
        try {
          // 拿用户所有(或指定) portfolio_id
          const portfolioWhere: any = { user_id: userId };
          if (portfolioId) portfolioWhere.id = portfolioId;
          const portfolios = await PaperTradingPortfolio.findAll({
            attributes: ['id'],
            where: portfolioWhere,
            raw: true,
          });
          const portfolioIds = (portfolios as any[]).map(p => p.id);
          if (portfolioIds.length > 0) {
            const positions = await PaperTradingPosition.findAll({
              attributes: ['symbol', 'name', 'quantity', 'portfolio_id'],
              where: {
                portfolio_id: { [Op.in]: portfolioIds },
                quantity: { [Op.gt]: 0 },
              },
              limit: maxSize,
              raw: true,
            });
            for (const p of positions as any[]) {
              const symbol = stockCodeToSymbol(p.symbol);
              if (!symbol) continue;
              const existing = out.get(symbol);
              if (existing) {
                if (!existing.sources.includes('position')) existing.sources.push('position');
                existing.position_shares =
                  typeof p.quantity === 'number' ? p.quantity : Number(p.quantity) || null;
                if (!existing.name && p.name) existing.name = p.name;
              } else {
                out.set(symbol, {
                  symbol,
                  name: p.name || null,
                  prev_close: null,
                  sources: ['position'],
                  position_shares:
                    typeof p.quantity === 'number' ? p.quantity : Number(p.quantity) || null,
                });
              }
            }
          }
        } catch (err: unknown) {
          logger.warn(
            `[CallAuction] loadUniverse position 失败 (忽略, 仅用 limit_up): ${
              (err as Error)?.message || err
            }`
          );
        }
      }
      const arr = Array.from(out.values());
      return arr.slice(0, maxSize);
    },

    async loadRealtimeQuotes(symbols: string[]): Promise<AuctionQuoteRow[]> {
      if (!symbols.length) return [];
      try {
        const rows = await realtimeQuoteService.getLatestQuotes(symbols);
        return rows.map((r: any) => ({
          symbol: r.symbol,
          name: r.name ?? null,
          open: numberOrNull(r.open),
          high: numberOrNull(r.high),
          low: numberOrNull(r.low),
          current: numberOrNull(r.current_price),
          prev_close:
            numberOrNull(r.raw_payload?.previous_close) ?? numberOrNull(r.raw_payload?.prev_close),
          quote_time:
            r.quote_time instanceof Date ? r.quote_time.toISOString() : r.quote_time || null,
        }));
      } catch (err: unknown) {
        logger.warn(`[CallAuction] loadRealtimeQuotes 失败: ${(err as Error)?.message || err}`);
        throw err;
      }
    },
  };
}

/** symbol 兼容: limit_up_stocks.stock_code 通常是 'sh.600519' 或 '600519' (无前缀). 走 inferMarketSegment 兜底. */
function stockCodeToSymbol(stockCode: string): string | null {
  if (!stockCode) return null;
  const raw = String(stockCode).trim();
  if (!raw) return null;
  if (/^(sh|sz|bj)\.\d{6}$/i.test(raw)) return raw.toLowerCase();
  // 纯 6 位代码 → 加前缀
  if (/^\d{6}$/.test(raw)) {
    if (raw.startsWith('6')) return `sh.${raw}`;
    if (raw.startsWith('0') || raw.startsWith('3')) return `sz.${raw}`;
    if (raw.startsWith('8') || raw.startsWith('4') || raw.startsWith('9')) return `bj.${raw}`;
  }
  return raw;
}

export const PRODUCTION_CALL_AUCTION_DATA_SOURCE: CallAuctionAnomalyDataSource =
  createProductionCallAuctionDataSource();

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

/**
 * 主入口: 拿 universe + 实时报价 → 异动列表.
 *
 * fail-OPEN 顶层: 子分支抛错被 catch 转 error → components.<x>.error, 主入口不抛.
 */
export async function evaluateCallAuctionAnomalies(
  source: CallAuctionAnomalyDataSource,
  options: CallAuctionAnomalyOptions = {}
): Promise<CallAuctionAnomalyResult> {
  const tradeDate = normalizeAuctionTradeDate(options.trade_date);
  const now = new Date();
  const isAfterAuction = options.force_after_auction ?? isAfterCallAuction(now);
  const serverClock = getServerClockShanghai(now);
  const maxUniverse = options.max_universe ?? MAX_UNIVERSE_SIZE;

  const components: CallAuctionComponents = {
    universe: { error: null },
    quotes: { error: null },
    timing: { error: null },
  };

  if (!isAfterAuction) {
    components.timing.error = `当前 ${serverClock} (Asia/Shanghai) 集合竞价未结束 (每日 9:25 后才有开盘价)`;
  } else if (!isAShareTradeDay(now)) {
    components.timing.error = `今日非 A 股交易日, 展示昨日涨停股 + 当前持仓的回顾视图`;
  }

  // ---- universe ----
  let universe: AuctionUniverseEntry[] = [];
  if (!options.skip_universe) {
    try {
      universe = await source.loadUniverse(
        tradeDate,
        options.user_id,
        options.portfolio_id,
        maxUniverse
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      components.universe.error = `观察池加载失败: ${msg}`;
      universe = [];
    }
  } else {
    components.universe.error = 'skip_universe=true';
  }

  // ---- quotes ----
  let quotes: AuctionQuoteRow[] = [];
  if (!options.skip_quotes && universe.length > 0) {
    if (!isAfterAuction) {
      components.quotes.error = '集合竞价未结束, 无开盘价';
    } else {
      try {
        quotes = await source.loadRealtimeQuotes(universe.map(u => u.symbol));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        components.quotes.error = `行情加载失败: ${msg}`;
        quotes = [];
      }
    }
  } else if (options.skip_quotes) {
    components.quotes.error = 'skip_quotes=true';
  }

  const anomalies = mergeUniverseAndQuotes(universe, quotes);
  const summary = summarizeAnomalies(anomalies);

  const brief = buildAuctionBrief({
    isAfterAuction,
    universe: universe.length,
    summary,
    anyError:
      components.universe.error !== null ||
      components.quotes.error !== null ||
      components.timing.error !== null,
  });

  const status = resolveAuctionStatus(components);
  const messageMap: Record<CallAuctionAnomalyResult['status'], string> = {
    ok: '集合竞价异动加载成功',
    partial: '部分数据缺失（观察池 或 行情）, 仍可参考剩余维度',
    failed: '观察池与行情数据全缺, 请检查数据源',
  };

  return {
    trade_date: tradeDate,
    is_after_auction: isAfterAuction,
    server_clock: serverClock,
    universe_size: universe.length,
    anomalies,
    summary,
    brief,
    status,
    message: messageMap[status],
    components,
  };
}

// ---------------------------------------------------------------------------
// service singleton
// ---------------------------------------------------------------------------

class CallAuctionAnomalyService {
  /**
   * 主入口, 外层 try/catch 兜底 — controller 永远拿到 200 OK 而非 500.
   */
  async getTodayAuction(
    options: CallAuctionAnomalyOptions = {}
  ): Promise<CallAuctionAnomalyResult> {
    try {
      return await evaluateCallAuctionAnomalies(PRODUCTION_CALL_AUCTION_DATA_SOURCE, options);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[CallAuction] top-level catch: ${msg}`);
      const now = new Date();
      const tradeDate = normalizeAuctionTradeDate(options.trade_date);
      return {
        trade_date: tradeDate,
        is_after_auction: options.force_after_auction ?? isAfterCallAuction(now),
        server_clock: getServerClockShanghai(now),
        universe_size: 0,
        anomalies: [],
        summary: {
          total: 0,
          one_word_count: 0,
          gap_up_count: 0,
          gap_down_count: 0,
          resolved_count: 0,
        },
        brief: `集合竞价异动加载异常 (${msg.slice(0, 60)})`,
        status: 'failed',
        message: `集合竞价异动加载失败: ${msg}`,
        components: {
          universe: { error: msg },
          quotes: { error: msg },
          timing: { error: null },
        },
      };
    }
  }
}

export const callAuctionAnomalyService = new CallAuctionAnomalyService();
