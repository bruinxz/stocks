/**
 * AfternoonKickDetector — PR-O6 (2026-06-30)
 *
 * 战法库 §A19-A22 午后开盘 (12:55-13:30) 4 类 pattern detector.
 * 工作日 13:01 (午后开盘 1min 后, 留时间给 REALTIME_QUOTE_SYNC 13:00 写一次) 跑.
 *
 * 4 patterns:
 *   - A19 strong_open    午后强势开盘: 13:01 close > 11:30 close + 0.5%, 量比 > 1.2 → buy
 *   - A20 noon_catalyst  午间利好引爆: 12:00-13:00 critical 公告 → 13:01 涨 > 2% → buy
 *   - A21 exhaustion     午后衰竭反转: 上午涨 > +3% AND 13:00 开盘 < 11:30 close → reduce(WARN)
 *   - A22 sector_kick    板块联动午后启动: 上午板块涨停 ≤ 1 AND 午盘后板块涨停 ≥ 2 → buy
 *
 * 数据源:
 *   - realtime_quotes        (今日 11:30 / 13:01 实时价)
 *   - intraday_klines_30min  (11:00-11:30 bar 作为午前最后一根, close 视作 11:30 close)
 *   - daily_bars             (T-1 收盘价对比, 取上午涨幅)
 *   - announcement_summaries (12:00-13:00 priority=critical 公告)
 *   - limit_up_stocks        (午前 / 当日板块涨停数)
 *
 * 写入:
 *   - AIInvestmentSignal (source_type='afternoon_kick_detector', timing_tag='afternoon_kick')
 *   - RiskAlert (level=MEDIUM, rule_id='afternoon_kick_<pattern>') —— A21 走 reduce 走 HIGH 级
 *
 * dedup: source_id = `afternoon_kick::${pattern}::${symbol}::${trade_date}` 一日一行.
 *
 * fail-OPEN 三层 (与 OpeningRushDetector 同):
 *   1. universe / quotes / kline 加载失败 → 整次 SUCCESS(0)
 *   2. per-symbol try/catch
 *   3. runOnce 永不抛
 *
 * 任何 caller (CLI / node -e / 单测 / 直接 require) 在 require 本模块时
 * 立即触发 sequelize addModels (AR-1 范式).
 */

import { logger } from '../utils/logger';
import moment from 'moment-timezone';
import { Op } from 'sequelize';
import { isAShareTradeDay } from '../utils/tradingCalendar';
import { normalizeSymbol } from '../utils/stockSymbol';
import { ensureModelsRegistered } from '../config/database';

// PR-Q (2026-06-30): cold-path Model not initialized hot-fix (AR-1 范式).
ensureModelsRegistered();

export const SOURCE_TYPE_AFTERNOON_KICK = 'afternoon_kick_detector';
export const TIMING_TAG_AFTERNOON_KICK = 'afternoon_kick';

export type AfternoonKickPattern =
  | 'strong_open'    // A19 午后强势开盘
  | 'noon_catalyst'  // A20 午间利好引爆
  | 'exhaustion'     // A21 午后衰竭反转 (REDUCE 警告)
  | 'sector_kick';   // A22 板块联动午后启动

export const PATTERN_RULE_IDS: Record<AfternoonKickPattern, string> = Object.freeze({
  strong_open: 'afternoon_kick_strong_open',
  noon_catalyst: 'afternoon_kick_noon_catalyst',
  exhaustion: 'afternoon_kick_exhaustion',
  sector_kick: 'afternoon_kick_sector_kick',
});

export const PATTERN_LABELS: Record<AfternoonKickPattern, string> = Object.freeze({
  strong_open: '☀️ 午后强势开盘',
  noon_catalyst: '📢 午间利好引爆',
  exhaustion: '⚠️ 午后衰竭反转',
  sector_kick: '🔗 板块联动午后启动',
});

export const PATTERN_DECISIONS: Record<AfternoonKickPattern, 'buy' | 'reduce'> = Object.freeze({
  strong_open: 'buy',
  noon_catalyst: 'buy',
  exhaustion: 'reduce',
  sector_kick: 'buy',
});

// 阈值
export const STRONG_OPEN_MIN_PCT = 0.5;          // A19: 13:01 vs 11:30 涨 > 0.5%
export const STRONG_OPEN_MIN_VOL_RATIO = 1.2;    // A19: 量比 > 1.2 (与上午同期对比)
export const NOON_CATALYST_MIN_PCT = 2.0;        // A20: 13:01 vs prev_close 涨 > 2%
export const EXHAUSTION_MORNING_GAIN_PCT = 3.0;  // A21: 上午涨 > +3%
export const SECTOR_KICK_MORNING_MAX = 1;        // A22: 上午板块涨停 ≤ 1
export const SECTOR_KICK_NOON_MIN = 2;           // A22: 午盘后板块涨停 ≥ 2

export const DEFAULT_UNIVERSE_LIMIT = 500;
export const DEFAULT_TOP_K = 30;

export interface QuoteLike {
  symbol: string;
  name: string | null;
  industry: string | null;
  current_price: number | null; // 13:01 实时价
  change_percent: number | null; // vs T-1 close
  volume: number | null;
  prev_close: number | null;
}

export interface MorningKlineLike {
  symbol: string;
  close_11_30: number | null; // 11:00-11:30 bar 的 close 视作 11:30 close
  volume_morning: number | null; // 上午全部 4 根 30min bar volume 之和 (上午 4 根: 9:30/10:00/10:30/11:00)
}

export interface CriticalAnnouncementLike {
  stock_code: string;
  announce_date: string;
  priority: string;
  event_type: string | null;
  summary: string | null;
}

export interface LimitUpRecordLike {
  trade_date: string;
  stock_code: string;
  industry: string | null;
  limit_up_time: string | null; // HH:MM:SS
}

export interface AfternoonKickHit {
  symbol: string;
  name: string | null;
  pattern: AfternoonKickPattern;
  rule_id: string;
  label: string;
  decision: 'buy' | 'reduce';
  reason: string;
  confidence_score: number;
  metadata: Record<string, unknown>;
}

export interface AfternoonKickDataSource {
  loadUniverseSymbols(limit: number): Promise<string[]>;
  loadQuotes(symbols: string[]): Promise<QuoteLike[]>;
  loadMorningKlines(symbols: string[], tradeDate: string): Promise<MorningKlineLike[]>;
  loadNoonCriticalAnnouncements(tradeDate: string): Promise<CriticalAnnouncementLike[]>;
  loadLimitUpToday(tradeDate: string): Promise<LimitUpRecordLike[]>;
  writeSignals(
    rows: Array<{
      source_id: string;
      symbol: string;
      name: string | null;
      signal_date: string;
      decision: 'buy' | 'reduce';
      confidence_score: number;
      rationale: string;
      metadata: Record<string, unknown>;
    }>
  ): Promise<{ created: number; updated: number; errors: number }>;
  writeRiskAlerts(
    rows: Array<{
      symbol: string;
      name: string | null;
      level: 'MEDIUM' | 'HIGH';
      rule_id: string;
      message: string;
    }>
  ): Promise<{ written: number; errors: number }>;
}

export interface AfternoonKickRunOptions {
  now?: Date;
  force?: boolean;
  trade_date?: string;
  universe_limit?: number;
  top_k?: number;
  dry_run?: boolean;
}

export interface AfternoonKickRunResult {
  scenario: 'afternoon_kick_detector';
  trade_date: string;
  scanned: number;
  matched: number;
  written_signals: number;
  written_alerts: number;
  by_pattern: Record<AfternoonKickPattern, number>;
  skipped_reason: string | null;
  hits: AfternoonKickHit[];
  errors: string[];
  dry_run: boolean;
}

export function todayTradeDate(now: Date = new Date()): string {
  return moment(now).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

export function emptyByPattern(): Record<AfternoonKickPattern, number> {
  return {
    strong_open: 0,
    noon_catalyst: 0,
    exhaustion: 0,
    sector_kick: 0,
  };
}

/**
 * 13:00-13:30 之间触发 (cron 13:01, 留 buffer 到 13:30).
 * force=true 时绕过此检查.
 */
export function isAfternoonKickWindow(now: Date = new Date()): boolean {
  const sh = moment(now).tz('Asia/Shanghai');
  const minutes = sh.hour() * 60 + sh.minute();
  return minutes >= 13 * 60 && minutes <= 13 * 60 + 30;
}

export function buildSourceId(
  pattern: AfternoonKickPattern,
  symbol: string,
  tradeDate: string
): string {
  return `afternoon_kick::${pattern}::${symbol}::${tradeDate}`;
}

// ===========================================================================
// 4 classifier 纯函数 (全部 export, 单测无需 DB)
// ===========================================================================

/**
 * A19 午后强势开盘:
 *   - 13:01 实时价 / 11:30 close > 1 + STRONG_OPEN_MIN_PCT/100  (涨幅 > 0.5%)
 *   - 量比 (假定 13:00-13:01 volume 累计 vs 上午同期分钟均量) > 1.2
 *     工程上 13:01 时 realtime_quotes.volume 是当日累计量, 减去上午 volume_morning
 *     再除以 1 分钟均量 (上午 volume_morning / 120 min) 即"午后第一分钟量比".
 *
 * input.morning_volume / input.afternoon_volume 用 caller 传 raw 累计量, 函数内做比.
 */
export function detectStrongOpen(input: {
  close_11_30: number | null;
  price_13_01: number | null;
  morning_volume: number | null;
  afternoon_volume: number | null; // 13:01 累计量 - 上午累计量
}): boolean {
  if (input.close_11_30 === null || input.close_11_30 <= 0) return false;
  if (input.price_13_01 === null || input.price_13_01 <= 0) return false;
  const gainPct = ((input.price_13_01 - input.close_11_30) / input.close_11_30) * 100;
  if (gainPct <= STRONG_OPEN_MIN_PCT) return false;
  if (
    input.morning_volume === null ||
    input.morning_volume <= 0 ||
    input.afternoon_volume === null ||
    input.afternoon_volume <= 0
  ) {
    // 量比缺失但价格已强势 → 弱判定: 价格 condition 已满足即推 (上午无量数据也可能是新股)
    return true;
  }
  // 上午 120 分钟均量 vs 午后 1 分钟实际量
  const morningPerMin = input.morning_volume / 120;
  if (morningPerMin <= 0) return true;
  const ratio = input.afternoon_volume / morningPerMin;
  return ratio >= STRONG_OPEN_MIN_VOL_RATIO;
}

/**
 * A20 午间利好引爆:
 *   - 12:00-13:00 期间该股有 priority=critical 公告
 *   - 13:01 涨幅 (vs prev_close) > 2%
 */
export function detectNoonCatalyst(input: {
  has_noon_critical: boolean;
  change_percent_vs_prev_close: number | null;
}): boolean {
  if (!input.has_noon_critical) return false;
  if (input.change_percent_vs_prev_close === null) return false;
  return input.change_percent_vs_prev_close > NOON_CATALYST_MIN_PCT;
}

/**
 * A21 午后衰竭反转 (REDUCE 警告):
 *   - 上午涨幅 (= 11:30 close vs prev_close) > +3%
 *   - 13:01 price < 11:30 close (午后开盘走弱)
 *
 * 此 pattern 输出 decision='reduce' + RiskAlert level=HIGH 警告持仓.
 */
export function detectExhaustion(input: {
  prev_close: number | null;
  close_11_30: number | null;
  price_13_01: number | null;
}): boolean {
  if (input.prev_close === null || input.prev_close <= 0) return false;
  if (input.close_11_30 === null) return false;
  if (input.price_13_01 === null) return false;
  const morningGainPct = ((input.close_11_30 - input.prev_close) / input.prev_close) * 100;
  if (morningGainPct <= EXHAUSTION_MORNING_GAIN_PCT) return false;
  return input.price_13_01 < input.close_11_30;
}

/**
 * A22 板块联动午后启动:
 *   - 上午板块涨停 ≤ 1 (limit_up_time <= '11:30:00')
 *   - 当日 (午后) 板块涨停 ≥ 2 (limit_up_time > '11:30:00' OR 全天累计)
 *
 * 函数判 industry-level 而非 single-stock: 给同一板块的所有票推同款"板块启动"信号.
 * caller 传 morning_count / afternoon_count 已按 industry 聚合好.
 */
export function detectSectorKick(input: {
  morning_limit_up_count: number;
  afternoon_limit_up_count: number;
}): boolean {
  if (input.morning_limit_up_count > SECTOR_KICK_MORNING_MAX) return false;
  return input.afternoon_limit_up_count >= SECTOR_KICK_NOON_MIN;
}

// ===========================================================================
// scoring + reasoning
// ===========================================================================

export function scoreAfternoonKick(pattern: AfternoonKickPattern): number {
  switch (pattern) {
    case 'noon_catalyst':
      return 85;
    case 'strong_open':
      return 78;
    case 'sector_kick':
      return 72;
    case 'exhaustion':
      return 70; // REDUCE 警告也要高 confidence 才推
  }
}

export function buildReason(
  pattern: AfternoonKickPattern,
  ctx: {
    morning_gain_pct?: number | null;
    afternoon_open_gain_pct?: number | null;
    change_percent_vs_prev_close?: number | null;
    event_summary?: string | null;
    industry?: string | null;
    morning_limit_up_count?: number;
    afternoon_limit_up_count?: number;
  }
): string {
  const label = PATTERN_LABELS[pattern];
  switch (pattern) {
    case 'strong_open': {
      const g = ctx.afternoon_open_gain_pct;
      const gStr = g !== null && g !== undefined ? `${g > 0 ? '+' : ''}${g.toFixed(2)}%` : 'N/A';
      return `${label} · 午后开盘 ${gStr} (13:01 vs 11:30) · 建议 13:00-13:30 内买`;
    }
    case 'noon_catalyst': {
      const c = ctx.change_percent_vs_prev_close;
      const cStr = c !== null && c !== undefined ? `${c > 0 ? '+' : ''}${c.toFixed(2)}%` : 'N/A';
      const evt = (ctx.event_summary || '').slice(0, 40);
      return `${label} · 13:01 涨 ${cStr} · 午间公告: ${evt || 'critical'} · 建议 30min 内跟进`;
    }
    case 'exhaustion': {
      const g = ctx.morning_gain_pct;
      const gStr = g !== null && g !== undefined ? `${g > 0 ? '+' : ''}${g.toFixed(2)}%` : 'N/A';
      return `${label} · 上午涨 ${gStr} 后午后开盘走弱 · 建议持仓减仓 / 暂停加仓`;
    }
    case 'sector_kick': {
      const ind = ctx.industry || '板块';
      const m = ctx.morning_limit_up_count ?? 0;
      const a = ctx.afternoon_limit_up_count ?? 0;
      return `${label} · ${ind} 板块涨停 上午${m} 午后${a} · 板块午后启动跟风`;
    }
  }
}

// ===========================================================================
// Production DataSource — lazy require(), fail-OPEN per query
// ===========================================================================

class DefaultAfternoonKickDataSource implements AfternoonKickDataSource {
  async loadUniverseSymbols(limit: number): Promise<string[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { intradayUniverseService } = require('./IntradayUniverseService');
      return await intradayUniverseService.resolveUniverse({
        min_size: Math.min(100, limit),
        max_size: limit,
        include_market_movers: true,
      });
    } catch (e: any) {
      logger.warn(`[AfternoonKick] resolveUniverse failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadQuotes(symbols: string[]): Promise<QuoteLike[]> {
    if (!symbols.length) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RealtimeQuote } = require('../models/RealtimeQuote');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../models/Stock');
      const rows: any[] = await RealtimeQuote.findAll({
        where: { symbol: { [Op.in]: symbols } },
        order: [['quote_time', 'DESC']],
        raw: true,
      });
      const seen = new Set<string>();
      const latest: any[] = [];
      for (const r of rows) {
        const s = String(r.symbol);
        if (seen.has(s)) continue;
        seen.add(s);
        latest.push(r);
      }
      const stocks: any[] = await Stock.findAll({
        attributes: ['symbol', 'name', 'industry'],
        where: { symbol: { [Op.in]: symbols } },
        raw: true,
      });
      const stockMap = new Map<string, { name: string | null; industry: string | null }>();
      for (const s of stocks) {
        stockMap.set(String(s.symbol), { name: s.name ?? null, industry: s.industry ?? null });
      }
      return latest.map(r => {
        const m = stockMap.get(String(r.symbol)) || { name: null, industry: null };
        const cp = r.current_price !== null && r.current_price !== undefined ? Number(r.current_price) : null;
        const chg = r.change_percent !== null && r.change_percent !== undefined ? Number(r.change_percent) : null;
        // prev_close = current_price / (1 + change_percent/100)
        let prevClose: number | null = null;
        if (cp !== null && chg !== null && Math.abs(1 + chg / 100) > 0.001) {
          prevClose = cp / (1 + chg / 100);
        }
        return {
          symbol: normalizeSymbol(String(r.symbol)),
          name: m.name,
          industry: m.industry,
          current_price: cp,
          change_percent: chg,
          volume: r.volume !== null && r.volume !== undefined ? Number(r.volume) : null,
          prev_close: prevClose,
        };
      });
    } catch (e: any) {
      logger.warn(`[AfternoonKick] loadQuotes failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadMorningKlines(symbols: string[], tradeDate: string): Promise<MorningKlineLike[]> {
    if (!symbols.length) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { IntradayKline30Min } = require('../models/IntradayKline30Min');
      const startTs = moment
        .tz(`${tradeDate} 09:30:00`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Shanghai')
        .toDate();
      const endTs = moment
        .tz(`${tradeDate} 11:30:00`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Shanghai')
        .toDate();
      const rows: any[] = await IntradayKline30Min.findAll({
        where: {
          symbol: { [Op.in]: symbols },
          kline_time: { [Op.gte]: startTs, [Op.lte]: endTs },
        },
        attributes: ['symbol', 'kline_time', 'close', 'volume'],
        raw: true,
      });
      // 收集每股 4 根上午 bar (起始 9:30/10:00/10:30/11:00, 结束 10:00/10:30/11:00/11:30)
      // 这里 kline_time 是 bar 起始时刻 (统一对齐到 30min 整点).
      // 注: PR-M2 注释说 "AKShare 返回的'时间'字段是 bar 结束时刻 (10:00 表示 9:30-10:00),
      //     IntradayKlineSyncService.parseKlineTime 统一对齐到 30min 整点"
      //     IntradayMomentumDetector 用 9:30 + 10:00 算 r1, 即 "bar 起始" 语义.
      //     这里我们也以 bar 起始时刻为准, 11:00 bar 的 close = 11:00-11:30 那根 close.
      const grp = new Map<string, { close_11_30: number | null; volume_morning: number }>();
      for (const r of rows) {
        const sym = normalizeSymbol(String(r.symbol));
        if (!sym) continue;
        const kt = new Date(r.kline_time);
        const sh = moment(kt).tz('Asia/Shanghai');
        const minutes = sh.hour() * 60 + sh.minute();
        const close = r.close !== null && r.close !== undefined ? Number(r.close) : null;
        const vol = r.volume !== null && r.volume !== undefined ? Number(r.volume) : 0;
        const cur = grp.get(sym) || { close_11_30: null, volume_morning: 0 };
        // 11:00 起始 bar = 11:00-11:30, close 就是 11:30 收盘价
        if (minutes === 11 * 60 && close !== null) {
          cur.close_11_30 = close;
        }
        if (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 && Number.isFinite(vol)) {
          cur.volume_morning += vol;
        }
        grp.set(sym, cur);
      }
      const out: MorningKlineLike[] = [];
      for (const sym of symbols) {
        const cur = grp.get(sym);
        out.push({
          symbol: sym,
          close_11_30: cur?.close_11_30 ?? null,
          volume_morning: cur && cur.volume_morning > 0 ? cur.volume_morning : null,
        });
      }
      return out;
    } catch (e: any) {
      logger.warn(`[AfternoonKick] loadMorningKlines failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadNoonCriticalAnnouncements(tradeDate: string): Promise<CriticalAnnouncementLike[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AnnouncementSummary } = require('../models/AnnouncementSummary');
      // announcement_summaries 没存"具体时间", announce_date 只能精确到天.
      // 折中: 当日 priority='critical' 公告全部纳入 (实际中 12:00-13:00 落库, 也只今天的有时效).
      const rows: any[] = await AnnouncementSummary.findAll({
        attributes: ['stock_code', 'announce_date', 'priority', 'event_type', 'summary'],
        where: {
          announce_date: tradeDate,
          priority: 'critical',
        },
        raw: true,
      });
      return rows.map(r => ({
        stock_code: String(r.stock_code),
        announce_date: String(r.announce_date),
        priority: String(r.priority),
        event_type: r.event_type ?? null,
        summary: r.summary ?? null,
      }));
    } catch (e: any) {
      logger.warn(`[AfternoonKick] loadNoonCriticalAnnouncements failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadLimitUpToday(tradeDate: string): Promise<LimitUpRecordLike[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LimitUpStock } = require('../models/LimitUpStock');
      const rows: any[] = await LimitUpStock.findAll({
        attributes: ['trade_date', 'stock_code', 'industry', 'limit_up_time'],
        where: { trade_date: tradeDate },
        raw: true,
      });
      return rows.map(r => ({
        trade_date: String(r.trade_date),
        stock_code: String(r.stock_code),
        industry: r.industry ?? null,
        limit_up_time: r.limit_up_time ?? null,
      }));
    } catch (e: any) {
      logger.warn(`[AfternoonKick] loadLimitUpToday failed: ${e?.message || e}`);
      return [];
    }
  }

  async writeSignals(
    rows: Array<{
      source_id: string;
      symbol: string;
      name: string | null;
      signal_date: string;
      decision: 'buy' | 'reduce';
      confidence_score: number;
      rationale: string;
      metadata: Record<string, unknown>;
    }>
  ): Promise<{ created: number; updated: number; errors: number }> {
    let created = 0;
    let updated = 0;
    let errors = 0;
    if (!rows.length) return { created, updated, errors };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AIInvestmentSignal } = require('../models/AIInvestmentSignal');
      for (const row of rows) {
        try {
          // PR-S Bug B2: 跌票不推 BUY — A21 exhaustion 走 'reduce' 是合法的 normalized_decision='hold' 语义.
          // V3 funnel 只 fan-in normalized_decision='buy' 的, exhaustion 推荐不会出现在 buy 卡片.
          const normalized = row.decision === 'buy' ? 'buy' : 'hold';
          const [, isCreated] = await AIInvestmentSignal.findOrCreate({
            where: {
              source_type: SOURCE_TYPE_AFTERNOON_KICK,
              source_id: row.source_id,
            },
            defaults: {
              source_type: SOURCE_TYPE_AFTERNOON_KICK,
              source_id: row.source_id,
              symbol: row.symbol,
              name: row.name,
              signal_date: row.signal_date,
              decision: row.decision,
              normalized_decision: normalized,
              confidence_score: row.confidence_score,
              rationale: row.rationale,
              metadata: row.metadata,
              forward_returns: {},
              verification_status: 'pending',
            },
          });
          if (isCreated) created++;
          else updated++;
        } catch (e: any) {
          errors++;
          logger.warn(`[AfternoonKick] writeSignal ${row.symbol} failed: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      logger.warn(`[AfternoonKick] writeSignals top throw: ${e?.message || e}`);
    }
    return { created, updated, errors };
  }

  async writeRiskAlerts(
    rows: Array<{
      symbol: string;
      name: string | null;
      level: 'MEDIUM' | 'HIGH';
      rule_id: string;
      message: string;
    }>
  ): Promise<{ written: number; errors: number }> {
    let written = 0;
    let errors = 0;
    if (!rows.length) return { written, errors };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RiskAlert } = require('../models/RiskAlert');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPortfolio } = require('../models/PaperTradingPortfolio');
      const portfolios: any[] = await PaperTradingPortfolio.findAll({
        attributes: ['user_id'],
        where: { is_active: true },
        group: ['user_id'],
        raw: true,
      });
      const userIds = portfolios
        .map(p => Number(p.user_id))
        .filter(u => Number.isFinite(u) && u > 0);
      if (!userIds.length) return { written, errors };
      for (const row of rows) {
        for (const uid of userIds) {
          try {
            await RiskAlert.create({
              user_id: uid,
              symbol: row.symbol,
              name: row.name || row.symbol,
              level: row.level,
              message: row.message,
              rule_id: row.rule_id,
            });
            written++;
          } catch (e: any) {
            errors++;
            logger.warn(
              `[AfternoonKick] writeRiskAlert ${row.symbol}/${uid} failed: ${e?.message || e}`
            );
          }
        }
      }
    } catch (e: any) {
      logger.warn(`[AfternoonKick] writeRiskAlerts top throw: ${e?.message || e}`);
    }
    return { written, errors };
  }
}

export const PRODUCTION_AFTERNOON_KICK_DATA_SOURCE: AfternoonKickDataSource =
  new DefaultAfternoonKickDataSource();

// ===========================================================================
// AfternoonKickDetector — orchestration class
// ===========================================================================

export class AfternoonKickDetector {
  constructor(
    private ds: AfternoonKickDataSource = PRODUCTION_AFTERNOON_KICK_DATA_SOURCE
  ) {}

  async runOnce(options: AfternoonKickRunOptions = {}): Promise<AfternoonKickRunResult> {
    const now = options.now || new Date();
    const tradeDate = options.trade_date || todayTradeDate(now);
    const dryRun = options.dry_run === true;
    const topK = options.top_k ?? DEFAULT_TOP_K;
    const universeLimit = options.universe_limit ?? DEFAULT_UNIVERSE_LIMIT;
    const byPattern = emptyByPattern();
    const errors: string[] = [];

    if (!options.force && !isAShareTradeDay(now)) {
      return {
        scenario: 'afternoon_kick_detector',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written_signals: 0,
        written_alerts: 0,
        by_pattern: byPattern,
        skipped_reason: 'not_trading_day',
        hits: [],
        errors,
        dry_run: dryRun,
      };
    }

    if (!options.force && !isAfternoonKickWindow(now)) {
      return {
        scenario: 'afternoon_kick_detector',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written_signals: 0,
        written_alerts: 0,
        by_pattern: byPattern,
        skipped_reason: 'not_in_afternoon_kick_window',
        hits: [],
        errors,
        dry_run: dryRun,
      };
    }

    let symbols: string[] = [];
    try {
      symbols = await this.ds.loadUniverseSymbols(universeLimit);
    } catch (e: any) {
      errors.push(`universe:${e?.message || e}`);
    }
    if (!symbols.length) {
      return {
        scenario: 'afternoon_kick_detector',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written_signals: 0,
        written_alerts: 0,
        by_pattern: byPattern,
        skipped_reason: 'empty_universe',
        hits: [],
        errors,
        dry_run: dryRun,
      };
    }

    const [quotes, klines, anns, limitUps] = await Promise.all([
      this.ds.loadQuotes(symbols).catch(e => {
        errors.push(`quotes:${e?.message || e}`);
        return [] as QuoteLike[];
      }),
      this.ds.loadMorningKlines(symbols, tradeDate).catch(e => {
        errors.push(`klines:${e?.message || e}`);
        return [] as MorningKlineLike[];
      }),
      this.ds.loadNoonCriticalAnnouncements(tradeDate).catch(e => {
        errors.push(`anns:${e?.message || e}`);
        return [] as CriticalAnnouncementLike[];
      }),
      this.ds.loadLimitUpToday(tradeDate).catch(e => {
        errors.push(`limit_ups:${e?.message || e}`);
        return [] as LimitUpRecordLike[];
      }),
    ]);

    // map klines / announcements / limit-ups by symbol or industry
    const klineMap = new Map<string, MorningKlineLike>();
    for (const k of klines) klineMap.set(k.symbol, k);

    // critical announcements indexed by 6-digit stock_code (公告表用 6 位代码)
    const annStockCodes = new Set<string>();
    const annMap = new Map<string, CriticalAnnouncementLike>();
    for (const a of anns) {
      annStockCodes.add(a.stock_code);
      annMap.set(a.stock_code, a);
    }

    // 按板块聚合 limit-up: 早盘 (<= 11:30:00) vs 午后 (> 11:30:00)
    const industryMorningCount = new Map<string, number>();
    const industryAfternoonCount = new Map<string, number>();
    for (const lu of limitUps) {
      if (!lu.industry) continue;
      const t = lu.limit_up_time || '';
      const isMorning = t !== '' && t <= '11:30:00';
      const isAfternoon = t !== '' && t > '11:30:00';
      if (isMorning) {
        industryMorningCount.set(lu.industry, (industryMorningCount.get(lu.industry) || 0) + 1);
      } else if (isAfternoon) {
        industryAfternoonCount.set(lu.industry, (industryAfternoonCount.get(lu.industry) || 0) + 1);
      }
    }

    const hits: AfternoonKickHit[] = [];

    for (const q of quotes) {
      try {
        const k = klineMap.get(q.symbol);
        // 6-digit code (announcement_summaries 用 6 位 stock_code, quotes 用 'sh.600519' 之类)
        const sixDigit = q.symbol.replace(/^(sh\.|sz\.|bj\.)/, '');
        const hasNoonCritical = annStockCodes.has(sixDigit);

        const close1130 = k?.close_11_30 ?? null;
        const volMorning = k?.volume_morning ?? null;
        // 13:01 累计 volume - 上午 volume = 午后 1 分钟实际量
        const afternoonVol =
          q.volume !== null && volMorning !== null ? Math.max(0, q.volume - volMorning) : null;

        // A19 strong_open
        if (
          detectStrongOpen({
            close_11_30: close1130,
            price_13_01: q.current_price,
            morning_volume: volMorning,
            afternoon_volume: afternoonVol,
          })
        ) {
          const gain =
            close1130 !== null && q.current_price !== null && close1130 > 0
              ? ((q.current_price - close1130) / close1130) * 100
              : null;
          hits.push({
            symbol: q.symbol,
            name: q.name,
            pattern: 'strong_open',
            rule_id: PATTERN_RULE_IDS.strong_open,
            label: PATTERN_LABELS.strong_open,
            decision: 'buy',
            reason: buildReason('strong_open', { afternoon_open_gain_pct: gain }),
            confidence_score: scoreAfternoonKick('strong_open'),
            metadata: {
              afternoon_open_gain_pct: gain,
              close_11_30: close1130,
              price_13_01: q.current_price,
              morning_volume: volMorning,
              afternoon_volume: afternoonVol,
              industry: q.industry,
            },
          });
          byPattern.strong_open++;
        }

        // A20 noon_catalyst
        if (
          detectNoonCatalyst({
            has_noon_critical: hasNoonCritical,
            change_percent_vs_prev_close: q.change_percent,
          })
        ) {
          const ann = annMap.get(sixDigit);
          hits.push({
            symbol: q.symbol,
            name: q.name,
            pattern: 'noon_catalyst',
            rule_id: PATTERN_RULE_IDS.noon_catalyst,
            label: PATTERN_LABELS.noon_catalyst,
            decision: 'buy',
            reason: buildReason('noon_catalyst', {
              change_percent_vs_prev_close: q.change_percent,
              event_summary: ann?.summary || ann?.event_type || null,
            }),
            confidence_score: scoreAfternoonKick('noon_catalyst'),
            metadata: {
              change_percent: q.change_percent,
              event_type: ann?.event_type ?? null,
              event_summary: ann?.summary ?? null,
              industry: q.industry,
            },
          });
          byPattern.noon_catalyst++;
        }

        // A21 exhaustion
        if (
          detectExhaustion({
            prev_close: q.prev_close,
            close_11_30: close1130,
            price_13_01: q.current_price,
          })
        ) {
          const morningGain =
            q.prev_close !== null && q.prev_close > 0 && close1130 !== null
              ? ((close1130 - q.prev_close) / q.prev_close) * 100
              : null;
          hits.push({
            symbol: q.symbol,
            name: q.name,
            pattern: 'exhaustion',
            rule_id: PATTERN_RULE_IDS.exhaustion,
            label: PATTERN_LABELS.exhaustion,
            decision: 'reduce',
            reason: buildReason('exhaustion', { morning_gain_pct: morningGain }),
            confidence_score: scoreAfternoonKick('exhaustion'),
            metadata: {
              morning_gain_pct: morningGain,
              close_11_30: close1130,
              price_13_01: q.current_price,
              prev_close: q.prev_close,
              industry: q.industry,
            },
          });
          byPattern.exhaustion++;
        }

        // A22 sector_kick — 按板块判定, 同板块所有票推
        if (q.industry) {
          const m = industryMorningCount.get(q.industry) || 0;
          const a = industryAfternoonCount.get(q.industry) || 0;
          if (
            detectSectorKick({
              morning_limit_up_count: m,
              afternoon_limit_up_count: a,
            }) &&
            // 板块启动跟风: 仅推非已涨停的票 (避免重复推涨停板)
            (q.change_percent === null || q.change_percent < 9.5)
          ) {
            hits.push({
              symbol: q.symbol,
              name: q.name,
              pattern: 'sector_kick',
              rule_id: PATTERN_RULE_IDS.sector_kick,
              label: PATTERN_LABELS.sector_kick,
              decision: 'buy',
              reason: buildReason('sector_kick', {
                industry: q.industry,
                morning_limit_up_count: m,
                afternoon_limit_up_count: a,
              }),
              confidence_score: scoreAfternoonKick('sector_kick'),
              metadata: {
                industry: q.industry,
                morning_limit_up_count: m,
                afternoon_limit_up_count: a,
                change_percent: q.change_percent,
              },
            });
            byPattern.sector_kick++;
          }
        }
      } catch (e: any) {
        errors.push(`scan:${q.symbol}:${e?.message || e}`);
      }
    }

    // sort hits: noon_catalyst > strong_open > sector_kick > exhaustion (按 score)
    hits.sort((a, b) => b.confidence_score - a.confidence_score);
    const picked = hits.slice(0, topK);

    let writtenSignals = 0;
    let writtenAlerts = 0;
    if (!dryRun && picked.length > 0) {
      try {
        const signalRows = picked.map(h => ({
          source_id: buildSourceId(h.pattern, h.symbol, tradeDate),
          symbol: h.symbol,
          name: h.name,
          signal_date: tradeDate,
          decision: h.decision,
          confidence_score: h.confidence_score,
          rationale: h.reason,
          metadata: {
            timing_tag: TIMING_TAG_AFTERNOON_KICK,
            source: 'afternoon_kick_detector',
            pattern: h.pattern,
            rule_id: h.rule_id,
            label: h.label,
            decision: h.decision,
            ...h.metadata,
          },
        }));
        const sr = await this.ds.writeSignals(signalRows);
        writtenSignals = sr.created + sr.updated;
        if (sr.errors > 0) errors.push(`signal_errors:${sr.errors}`);
      } catch (e: any) {
        errors.push(`signals:${e?.message || e}`);
      }
      try {
        const alertRows = picked.map(h => ({
          symbol: h.symbol,
          name: h.name,
          level: (h.pattern === 'exhaustion' ? 'HIGH' : 'MEDIUM') as 'HIGH' | 'MEDIUM',
          rule_id: h.rule_id,
          message: h.reason,
        }));
        const ar = await this.ds.writeRiskAlerts(alertRows);
        writtenAlerts = ar.written;
        if (ar.errors > 0) errors.push(`alert_errors:${ar.errors}`);
      } catch (e: any) {
        errors.push(`alerts:${e?.message || e}`);
      }
    }

    logger.info(
      `[AfternoonKick] trade_date=${tradeDate} scanned=${quotes.length} ` +
        `matched=${hits.length} written_signals=${writtenSignals} written_alerts=${writtenAlerts} ` +
        `dry=${dryRun} by_pattern=${JSON.stringify(byPattern)} errors=${errors.length}`
    );

    return {
      scenario: 'afternoon_kick_detector',
      trade_date: tradeDate,
      scanned: quotes.length,
      matched: hits.length,
      written_signals: writtenSignals,
      written_alerts: writtenAlerts,
      by_pattern: byPattern,
      skipped_reason: null,
      hits: picked,
      errors,
      dry_run: dryRun,
    };
  }
}

export const afternoonKickDetector = new AfternoonKickDetector();
