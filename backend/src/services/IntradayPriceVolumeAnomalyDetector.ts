/**
 * IntradayPriceVolumeAnomalyDetector — PR-O3 修复 2 (2026-06-30)
 *
 * 价量异动 detector. BullishEventDetector 是文本类 (公告/新闻/KOL/关注度), 名字
 * intraday_anomaly 误导. 本服务专注价量类异动 6 类:
 *
 *   1. volume_surge          量比突增 (当前累计量 / 历史同期 20d 均值 > 2x)
 *   2. main_force_inflow     主力净流入 (板块主力净流入 > 0 + 涨幅 > 5%)
 *   3. limit_up_breakout     接近涨停且封单大 (涨幅 > 9.0% 准涨停)
 *   4. sector_link_undermove 板块联动滞涨 (同板块涨停 ≥ 3 + 自己未涨)
 *   5. broken_refill         涨停打开后再封 (LimitUpStock 含 limit_up_open_times)
 *   6. second_board_acceleration 前日首板今日 9:30 内秒板 (LimitUpStock 连板 = 2)
 *
 * cron: 每 30 min 跑一次 (与 BULLISH_EVENT_DETECT 每 30min cron 同步轴).
 *
 * 数据源:
 *   - realtime_quotes        (今日最新累计成交量 + 涨跌幅)
 *   - daily_bars             (历史 20d 同期均量)
 *   - limit_up_stocks        (连板天数 / 封板时间 / 炸板次数)
 *   - industry_flow_intraday (板块主力净流入)
 *
 * 输出:
 *   - 写 RiskAlert (level=MEDIUM, rule_id=intraday_volume_surge 等)
 *   - 写 ai_investment_signals (source_type='intraday_price_volume_anomaly',
 *     timing_tag='intraday_anomaly', decision='buy')
 *
 * fail-OPEN 三层 (与 OpeningRushDetector 同):
 *   - universe / quotes / kline 失败 → 整次 SUCCESS(0)
 *   - per-symbol try/catch
 *   - runOnce 永不抛
 */

import { logger } from '../utils/logger';
import moment from 'moment-timezone';
import { Op } from 'sequelize';
import { isAShareTradeDay } from '../utils/tradingCalendar';
import { normalizeSymbol } from '../utils/stockSymbol';
import { ensureModelsRegistered } from '../config/database';

// PR-Q (2026-06-30): cold-path Model not initialized hot-fix (AR-1 范式).
ensureModelsRegistered();

export const VOLUME_SURGE_RATIO_THRESHOLD = 2.0;
export const MAIN_INFLOW_CHANGE_PCT_THRESHOLD = 5.0;
export const LIMIT_UP_BREAKOUT_CHANGE_PCT_THRESHOLD = 9.0;
export const SECTOR_LINK_LIMIT_UP_COUNT = 3;
export const SECOND_BOARD_CONSECUTIVE_DAYS = 2;
export const SECOND_BOARD_LIMIT_TIME_CUTOFF = '09:35:00';
export const DEFAULT_UNIVERSE_LIMIT = 500;
export const DEFAULT_TOP_K = 30;

/**
 * PR-S (2026-06-30) Bug B2 fix — 方向过滤阈值.
 *
 * 用户实测: 巨化 sh.600160 跌 -7.51% 当日仍被推 BUY (杀跌 + 量增 误报).
 *
 * 修复约束:
 *   - volume_surge / main_force_inflow / limit_up_breakout: 必须 change_pct > 0 (价涨) 才推
 *   - sector_link_undermove: 板块涨停 ≥ 3 + 自己 change_pct >= 0 (允许平盘滞涨, 但不允许杀跌)
 *   - broken_refill / second_board_acceleration: 数据源 LimitUpStock 已隐含涨停状态, 无需价向过滤
 *
 * 杀跌 (price down + volume surge) = 恐慌出货 ≠ BUY signal. 任何 detector 推 BUY 前都必须
 * 校 change_pct 方向, 否则推荐质量崩盘.
 */
export const POSITIVE_DIRECTION_CHANGE_PCT_THRESHOLD = 0;

export const SOURCE_TYPE_PRICE_VOLUME = 'intraday_price_volume_anomaly';
export const TIMING_TAG_INTRADAY_ANOMALY = 'intraday_anomaly';

export type AnomalyType =
  | 'volume_surge'
  | 'main_force_inflow'
  | 'limit_up_breakout'
  | 'sector_link_undermove'
  | 'broken_refill'
  | 'second_board_acceleration';

export const ANOMALY_RULE_IDS: Record<AnomalyType, string> = Object.freeze({
  volume_surge: 'intraday_volume_surge',
  main_force_inflow: 'intraday_main_force_inflow',
  limit_up_breakout: 'intraday_limit_up_breakout',
  sector_link_undermove: 'intraday_sector_link_undermove',
  broken_refill: 'intraday_broken_refill',
  second_board_acceleration: 'intraday_second_board_acceleration',
});

export const ANOMALY_LABELS: Record<AnomalyType, string> = Object.freeze({
  volume_surge: '📈 量比突增',
  main_force_inflow: '💰 主力净流入领涨',
  limit_up_breakout: '🚀 接近涨停',
  sector_link_undermove: '🔗 板块联动滞涨',
  broken_refill: '🔄 炸板回封',
  second_board_acceleration: '⚡ 二板秒封',
});

export interface QuoteLike {
  symbol: string;
  name: string | null;
  industry: string | null;
  current_price: number | null;
  change_percent: number | null;
  volume: number | null;
  turnover: number | null;
}

export interface AvgVolume20D {
  symbol: string;
  avg_volume_20d: number | null;
}

export interface LimitUpRecord {
  trade_date: string;
  stock_code: string;
  stock_name: string | null;
  industry: string | null;
  continuous_days: number | null;
  limit_up_time: string | null;
  limit_up_open_times: number | null;
}

export interface IndustryFlowLike {
  industry_name: string;
  main_inflow: number | null;
  change_pct: number | null;
}

export interface AnomalyHit {
  symbol: string;
  name: string | null;
  anomaly_type: AnomalyType;
  rule_id: string;
  label: string;
  reason: string;
  confidence_score: number;
  current_price: number | null;
  change_percent: number | null;
  metadata: Record<string, unknown>;
}

export interface PriceVolumeAnomalyDataSource {
  loadUniverseSymbols(limit: number): Promise<string[]>;
  loadQuotes(symbols: string[]): Promise<QuoteLike[]>;
  loadAvgVolume20D(symbols: string[], beforeDate: string): Promise<AvgVolume20D[]>;
  loadLimitUpToday(tradeDate: string): Promise<LimitUpRecord[]>;
  loadLimitUpYesterday(tradeDate: string): Promise<LimitUpRecord[]>;
  loadIndustryFlowsRecent(): Promise<IndustryFlowLike[]>;
  writeRiskAlerts(
    rows: Array<{
      symbol: string;
      name: string | null;
      rule_id: string;
      message: string;
    }>
  ): Promise<{ written: number; errors: number }>;
  writeSignals(
    rows: Array<{
      source_id: string;
      symbol: string;
      name: string | null;
      signal_date: string;
      confidence_score: number;
      rationale: string;
      metadata: Record<string, unknown>;
    }>
  ): Promise<{ created: number; updated: number; errors: number }>;
}

export interface AnomalyRunOptions {
  now?: Date;
  force?: boolean;
  universe_limit?: number;
  top_k?: number;
  dry_run?: boolean;
}

export interface AnomalyRunResult {
  scenario: 'intraday_price_volume_anomaly';
  trade_date: string;
  scanned: number;
  matched: number;
  written_alerts: number;
  written_signals: number;
  by_type: Record<AnomalyType, number>;
  skipped_reason: string | null;
  hits: AnomalyHit[];
  errors: string[];
  dry_run: boolean;
}

export function todayTradeDate(now: Date = new Date()): string {
  return moment(now).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

export function emptyAnomalyByType(): Record<AnomalyType, number> {
  return {
    volume_surge: 0,
    main_force_inflow: 0,
    limit_up_breakout: 0,
    sector_link_undermove: 0,
    broken_refill: 0,
    second_board_acceleration: 0,
  };
}

export function isInIntradayTradingTime(now: Date = new Date()): boolean {
  const sh = moment(now).tz('Asia/Shanghai');
  const minutes = sh.hour() * 60 + sh.minute();
  return (
    (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30) ||
    (minutes >= 13 * 60 && minutes <= 15 * 60)
  );
}

export function detectVolumeSurge(
  quote: QuoteLike,
  avg20d: number | null,
  now: Date = new Date()
): boolean {
  if (!avg20d || avg20d <= 0) return false;
  if (quote.volume === null || quote.volume === undefined || quote.volume <= 0) return false;
  // PR-S Bug B2: 杀跌 + 放量 = 恐慌出货 ≠ BUY. 必须价涨才推.
  if (quote.change_percent === null || quote.change_percent <= POSITIVE_DIRECTION_CHANGE_PCT_THRESHOLD) {
    return false;
  }
  const sh = moment(now).tz('Asia/Shanghai');
  const minutes = sh.hour() * 60 + sh.minute();
  let elapsed = 0;
  if (minutes < 9 * 60 + 30) elapsed = 0;
  else if (minutes <= 11 * 60 + 30) elapsed = minutes - (9 * 60 + 30);
  else if (minutes < 13 * 60) elapsed = 120;
  else if (minutes <= 15 * 60) elapsed = 120 + (minutes - 13 * 60);
  else elapsed = 240;
  if (elapsed <= 0) return false;
  const expectedVolume = (avg20d * elapsed) / 240;
  if (expectedVolume <= 0) return false;
  return quote.volume / expectedVolume > VOLUME_SURGE_RATIO_THRESHOLD;
}

export function detectMainForceInflow(quote: QuoteLike, flow: IndustryFlowLike | null): boolean {
  if (!flow) return false;
  if (flow.main_inflow === null || flow.main_inflow <= 0) return false;
  if (quote.change_percent === null) return false;
  // PR-S Bug B2: 与现有 > 5% 阈值天然蕴含 > 0, 这里写显式 guard 防未来阈值调整漏掉方向校验.
  if (quote.change_percent <= POSITIVE_DIRECTION_CHANGE_PCT_THRESHOLD) return false;
  return quote.change_percent > MAIN_INFLOW_CHANGE_PCT_THRESHOLD;
}

export function detectLimitUpBreakout(quote: QuoteLike): boolean {
  if (quote.change_percent === null) return false;
  // PR-S Bug B2: 与现有 >= 9% 阈值天然蕴含 > 0, 这里写显式 guard 防未来阈值调整漏掉方向校验.
  if (quote.change_percent <= POSITIVE_DIRECTION_CHANGE_PCT_THRESHOLD) return false;
  return quote.change_percent >= LIMIT_UP_BREAKOUT_CHANGE_PCT_THRESHOLD;
}

export function detectSectorLinkUndermove(quote: QuoteLike, industryLimitUpCount: number): boolean {
  if (industryLimitUpCount < SECTOR_LINK_LIMIT_UP_COUNT) return false;
  if (quote.change_percent === null) return false;
  // PR-S Bug B2: 板块涨 + 自己**杀跌** ≠ 滞涨, 那是脱节砸盘. 滞涨要求 0 ≤ self < 2%.
  if (quote.change_percent < POSITIVE_DIRECTION_CHANGE_PCT_THRESHOLD) return false;
  return quote.change_percent < 2.0;
}

export function detectBrokenRefill(record: LimitUpRecord): boolean {
  if (record.limit_up_open_times === null || record.limit_up_open_times === undefined) return false;
  return record.limit_up_open_times >= 1;
}

export function detectSecondBoardAcceleration(record: LimitUpRecord): boolean {
  if (record.continuous_days !== SECOND_BOARD_CONSECUTIVE_DAYS) return false;
  if (!record.limit_up_time) return false;
  return record.limit_up_time <= SECOND_BOARD_LIMIT_TIME_CUTOFF;
}

export function scoreAnomaly(type: AnomalyType): number {
  switch (type) {
    case 'second_board_acceleration':
      return 88;
    case 'limit_up_breakout':
      return 82;
    case 'broken_refill':
      return 78;
    case 'main_force_inflow':
      return 75;
    case 'volume_surge':
      return 72;
    case 'sector_link_undermove':
      return 68;
  }
}

export function buildAnomalyReason(
  type: AnomalyType,
  quote: QuoteLike,
  extra: { avg20d?: number | null; industryName?: string | null; record?: LimitUpRecord | null }
): string {
  const label = ANOMALY_LABELS[type];
  const pct =
    quote.change_percent !== null
      ? `${quote.change_percent > 0 ? '+' : ''}${quote.change_percent.toFixed(2)}%`
      : 'N/A';
  switch (type) {
    case 'volume_surge': {
      const ratio =
        extra.avg20d && extra.avg20d > 0 && quote.volume
          ? (quote.volume / extra.avg20d).toFixed(1)
          : 'N/A';
      return `${label} · 涨幅 ${pct} · 量比 ${ratio}x 20日均量`;
    }
    case 'main_force_inflow':
      return `${label} · 涨幅 ${pct} · ${extra.industryName || '板块'} 主力净流入`;
    case 'limit_up_breakout':
      return `${label} · 当前涨幅 ${pct} 接近涨停`;
    case 'sector_link_undermove':
      return `${label} · ${
        extra.industryName || '板块'
      } 已 ${SECTOR_LINK_LIMIT_UP_COUNT}+ 涨停, 自身 ${pct} 滞涨`;
    case 'broken_refill': {
      const opens = extra.record?.limit_up_open_times ?? 0;
      return `${label} · 当日炸板 ${opens} 次后回封`;
    }
    case 'second_board_acceleration': {
      const t = extra.record?.limit_up_time || '';
      return `${label} · 二板, 封板时刻 ${t}`;
    }
  }
}

/**
 * PR-S (2026-06-30) Bug B1 fix — source_id 改成每日稳定 ID.
 *
 * 原 30min slot 设计在生产 7+ 次 cron 间会写出 7 行 ai_investment_signals (同股同型),
 * V3 前端不 dedup 直接展开 → 推荐卡重复显示 4 次 (用户实测 sh.600113 浙江东日).
 *
 * 改成 `pv_anomaly::${type}::${symbol}::${tradeDate}` 一日一行: AIInvestmentSignal.findOrCreate
 * 天然走 UPSERT 语义 (where 命中则不更新, defaults 仅 create 时生效). 第一次 cron 写入即定型,
 * 后续 cron 同 source_id 都被跳过, 一天最多 1 条 / (symbol, anomaly_type).
 *
 * windowMs / now 参数保留: 单测可以传 windowMs <= 0 退化到旧的"每分钟一桶"行为做兼容测试,
 * 但生产 caller 不传 → 走每日稳定 ID.
 */
export function buildAnomalySourceId(
  type: AnomalyType,
  symbol: string,
  tradeDate: string,
  windowMs: number = 0,
  now: Date = new Date()
): string {
  if (windowMs && windowMs > 0) {
    const slot = Math.floor(now.getTime() / windowMs);
    return `pv_anomaly::${type}::${symbol}::${tradeDate}::${slot}`;
  }
  return `pv_anomaly::${type}::${symbol}::${tradeDate}`;
}

class DefaultPriceVolumeAnomalyDataSource implements PriceVolumeAnomalyDataSource {
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
      logger.warn(`[PVAnomaly] resolveUniverse failed: ${e?.message || e}`);
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
        return {
          symbol: normalizeSymbol(String(r.symbol)),
          name: m.name,
          industry: m.industry,
          current_price: r.current_price !== null ? Number(r.current_price) : null,
          change_percent: r.change_percent !== null ? Number(r.change_percent) : null,
          volume: r.volume !== null ? Number(r.volume) : null,
          turnover: r.turnover !== null ? Number(r.turnover) : null,
        };
      });
    } catch (e: any) {
      logger.warn(`[PVAnomaly] loadQuotes failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadAvgVolume20D(symbols: string[], beforeDate: string): Promise<AvgVolume20D[]> {
    if (!symbols.length) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../models/DailyBar');
      const stocks: any[] = await Stock.findAll({
        attributes: ['id', 'symbol'],
        where: { symbol: { [Op.in]: symbols } },
        raw: true,
      });
      const idToSym = new Map<number, string>();
      const idList: number[] = [];
      for (const s of stocks) {
        idToSym.set(Number(s.id), String(s.symbol));
        idList.push(Number(s.id));
      }
      if (!idList.length) return [];
      const before = new Date(`${beforeDate}T00:00:00.000Z`);
      const bars: any[] = await DailyBar.findAll({
        attributes: ['stock_id', 'volume'],
        where: {
          stock_id: { [Op.in]: idList },
          time: { [Op.lt]: before },
        },
        order: [['time', 'DESC']],
        limit: idList.length * 20,
        raw: true,
      });
      const grp = new Map<number, number[]>();
      for (const b of bars) {
        const sid = Number(b.stock_id);
        if (!grp.has(sid)) grp.set(sid, []);
        const arr = grp.get(sid) as number[];
        if (arr.length >= 20) continue;
        const v = Number(b.volume);
        if (Number.isFinite(v) && v > 0) arr.push(v);
      }
      const out: AvgVolume20D[] = [];
      for (const sid of idList) {
        const sym = idToSym.get(sid) as string;
        const arr = grp.get(sid) || [];
        if (arr.length === 0) {
          out.push({ symbol: sym, avg_volume_20d: null });
          continue;
        }
        const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
        out.push({ symbol: sym, avg_volume_20d: avg });
      }
      return out;
    } catch (e: any) {
      logger.warn(`[PVAnomaly] loadAvgVolume20D failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadLimitUpToday(tradeDate: string): Promise<LimitUpRecord[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LimitUpStock } = require('../models/LimitUpStock');
      const rows: any[] = await LimitUpStock.findAll({
        where: { trade_date: tradeDate },
        raw: true,
      });
      return rows.map(r => ({
        trade_date: String(r.trade_date),
        stock_code: String(r.stock_code),
        stock_name: r.stock_name ?? null,
        industry: r.industry ?? null,
        continuous_days: r.continuous_days !== null ? Number(r.continuous_days) : null,
        limit_up_time: r.limit_up_time ?? null,
        limit_up_open_times: r.limit_up_open_times !== null ? Number(r.limit_up_open_times) : null,
      }));
    } catch (e: any) {
      logger.warn(`[PVAnomaly] loadLimitUpToday failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadLimitUpYesterday(tradeDate: string): Promise<LimitUpRecord[]> {
    const yesterday = moment(tradeDate).subtract(1, 'days').format('YYYY-MM-DD');
    return this.loadLimitUpToday(yesterday);
  }

  async loadIndustryFlowsRecent(): Promise<IndustryFlowLike[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { IndustryFlowIntraday } = require('../models/IndustryFlowIntraday');
      const since = new Date(Date.now() - 30 * 60 * 1000);
      const rows: any[] = await IndustryFlowIntraday.findAll({
        where: { snapshot_ts: { [Op.gte]: since } },
        order: [['snapshot_ts', 'DESC']],
        raw: true,
      });
      const dedup = new Map<string, any>();
      for (const r of rows) {
        const key = String(r.industry_name);
        if (dedup.has(key)) continue;
        dedup.set(key, r);
      }
      return Array.from(dedup.values()).map(r => ({
        industry_name: String(r.industry_name),
        main_inflow: r.main_inflow !== null ? Number(r.main_inflow) : null,
        change_pct: r.change_pct !== null ? Number(r.change_pct) : null,
      }));
    } catch (e: any) {
      logger.warn(`[PVAnomaly] loadIndustryFlowsRecent failed: ${e?.message || e}`);
      return [];
    }
  }

  async writeRiskAlerts(
    rows: Array<{ symbol: string; name: string | null; rule_id: string; message: string }>
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
              level: 'MEDIUM',
              message: row.message,
              rule_id: row.rule_id,
            });
            written++;
          } catch (e: any) {
            errors++;
            logger.warn(
              `[PVAnomaly] writeRiskAlert ${row.symbol}/${uid} failed: ${e?.message || e}`
            );
          }
        }
      }
    } catch (e: any) {
      logger.warn(`[PVAnomaly] writeRiskAlerts top throw: ${e?.message || e}`);
    }
    return { written, errors };
  }

  async writeSignals(
    rows: Array<{
      source_id: string;
      symbol: string;
      name: string | null;
      signal_date: string;
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
          const [, isCreated] = await AIInvestmentSignal.findOrCreate({
            where: { source_type: SOURCE_TYPE_PRICE_VOLUME, source_id: row.source_id },
            defaults: {
              source_type: SOURCE_TYPE_PRICE_VOLUME,
              source_id: row.source_id,
              symbol: row.symbol,
              name: row.name,
              signal_date: row.signal_date,
              decision: 'buy',
              normalized_decision: 'buy',
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
          logger.warn(`[PVAnomaly] writeSignal ${row.symbol} failed: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      logger.warn(`[PVAnomaly] writeSignals top throw: ${e?.message || e}`);
    }
    return { created, updated, errors };
  }
}

export const PRODUCTION_PRICE_VOLUME_ANOMALY_DATA_SOURCE: PriceVolumeAnomalyDataSource =
  new DefaultPriceVolumeAnomalyDataSource();

export class IntradayPriceVolumeAnomalyDetector {
  constructor(
    private ds: PriceVolumeAnomalyDataSource = PRODUCTION_PRICE_VOLUME_ANOMALY_DATA_SOURCE
  ) {}

  async runOnce(options: AnomalyRunOptions = {}): Promise<AnomalyRunResult> {
    const now = options.now || new Date();
    const tradeDate = todayTradeDate(now);
    const dryRun = options.dry_run === true;
    const topK = options.top_k ?? DEFAULT_TOP_K;
    const universeLimit = options.universe_limit ?? DEFAULT_UNIVERSE_LIMIT;
    const byType = emptyAnomalyByType();
    const errors: string[] = [];

    if (!options.force && !isAShareTradeDay(now)) {
      return {
        scenario: 'intraday_price_volume_anomaly',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written_alerts: 0,
        written_signals: 0,
        by_type: byType,
        skipped_reason: 'not_trading_day',
        hits: [],
        errors,
        dry_run: dryRun,
      };
    }
    if (!options.force && !isInIntradayTradingTime(now)) {
      return {
        scenario: 'intraday_price_volume_anomaly',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written_alerts: 0,
        written_signals: 0,
        by_type: byType,
        skipped_reason: 'not_in_trading_session',
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
        scenario: 'intraday_price_volume_anomaly',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written_alerts: 0,
        written_signals: 0,
        by_type: byType,
        skipped_reason: 'empty_universe',
        hits: [],
        errors,
        dry_run: dryRun,
      };
    }

    const [quotes, avg20Arr, limitUpToday, flows] = await Promise.all([
      this.ds.loadQuotes(symbols).catch(e => {
        errors.push(`quotes:${e?.message || e}`);
        return [] as QuoteLike[];
      }),
      this.ds.loadAvgVolume20D(symbols, tradeDate).catch(e => {
        errors.push(`avg20:${e?.message || e}`);
        return [] as AvgVolume20D[];
      }),
      this.ds.loadLimitUpToday(tradeDate).catch(e => {
        errors.push(`limit_up:${e?.message || e}`);
        return [] as LimitUpRecord[];
      }),
      this.ds.loadIndustryFlowsRecent().catch(e => {
        errors.push(`flows:${e?.message || e}`);
        return [] as IndustryFlowLike[];
      }),
    ]);

    const avgMap = new Map<string, number | null>();
    for (const a of avg20Arr) avgMap.set(a.symbol, a.avg_volume_20d);

    const flowMap = new Map<string, IndustryFlowLike>();
    for (const f of flows) flowMap.set(f.industry_name, f);

    const industryLimitUpCount = new Map<string, number>();
    const limitUpBySymbol = new Map<string, LimitUpRecord>();
    for (const lu of limitUpToday) {
      if (lu.industry) {
        industryLimitUpCount.set(lu.industry, (industryLimitUpCount.get(lu.industry) || 0) + 1);
      }
      limitUpBySymbol.set(lu.stock_code, lu);
    }

    const hits: AnomalyHit[] = [];

    for (const q of quotes) {
      try {
        const avg20d = avgMap.get(q.symbol) ?? null;
        const industryFlow = q.industry ? flowMap.get(q.industry) ?? null : null;
        const industryLimitN = q.industry ? industryLimitUpCount.get(q.industry) ?? 0 : 0;
        const luRecord =
          limitUpBySymbol.get(q.symbol) ||
          limitUpBySymbol.get(q.symbol.replace(/^(sh\.|sz\.|bj\.)/, '')) ||
          null;

        if (detectVolumeSurge(q, avg20d, now)) {
          hits.push(this.makeHit('volume_surge', q, { avg20d }));
          byType.volume_surge++;
        }
        if (detectMainForceInflow(q, industryFlow)) {
          hits.push(this.makeHit('main_force_inflow', q, { industryName: q.industry }));
          byType.main_force_inflow++;
        }
        if (detectLimitUpBreakout(q)) {
          hits.push(this.makeHit('limit_up_breakout', q, {}));
          byType.limit_up_breakout++;
        }
        if (detectSectorLinkUndermove(q, industryLimitN)) {
          hits.push(this.makeHit('sector_link_undermove', q, { industryName: q.industry }));
          byType.sector_link_undermove++;
        }
        if (luRecord && detectBrokenRefill(luRecord)) {
          hits.push(this.makeHit('broken_refill', q, { record: luRecord }));
          byType.broken_refill++;
        }
        if (luRecord && detectSecondBoardAcceleration(luRecord)) {
          hits.push(this.makeHit('second_board_acceleration', q, { record: luRecord }));
          byType.second_board_acceleration++;
        }
      } catch (e: any) {
        errors.push(`scan:${q.symbol}:${e?.message || e}`);
      }
    }

    hits.sort((a, b) => b.confidence_score - a.confidence_score);
    const picked = hits.slice(0, topK);

    let writtenAlerts = 0;
    let writtenSignals = 0;
    if (!dryRun && picked.length > 0) {
      try {
        const alertRows = picked.map(h => ({
          symbol: h.symbol,
          name: h.name,
          rule_id: h.rule_id,
          message: h.reason,
        }));
        const ar = await this.ds.writeRiskAlerts(alertRows);
        writtenAlerts = ar.written;
        if (ar.errors > 0) errors.push(`alert_errors:${ar.errors}`);
      } catch (e: any) {
        errors.push(`alerts:${e?.message || e}`);
      }
      try {
        const signalRows = picked.map(h => ({
          source_id: buildAnomalySourceId(h.anomaly_type, h.symbol, tradeDate, 0, now),
          symbol: h.symbol,
          name: h.name,
          signal_date: tradeDate,
          confidence_score: h.confidence_score,
          rationale: h.reason,
          metadata: {
            timing_tag: TIMING_TAG_INTRADAY_ANOMALY,
            anomaly_type: h.anomaly_type,
            rule_id: h.rule_id,
            label: h.label,
            ...h.metadata,
          },
        }));
        const sr = await this.ds.writeSignals(signalRows);
        writtenSignals = sr.created + sr.updated;
        if (sr.errors > 0) errors.push(`signal_errors:${sr.errors}`);
      } catch (e: any) {
        errors.push(`signals:${e?.message || e}`);
      }
    }

    logger.info(
      `[PVAnomaly] trade_date=${tradeDate} scanned=${quotes.length} matched=${hits.length} ` +
        `written_alerts=${writtenAlerts} written_signals=${writtenSignals} dry=${dryRun} ` +
        `by_type=${JSON.stringify(byType)}`
    );

    return {
      scenario: 'intraday_price_volume_anomaly',
      trade_date: tradeDate,
      scanned: quotes.length,
      matched: hits.length,
      written_alerts: writtenAlerts,
      written_signals: writtenSignals,
      by_type: byType,
      skipped_reason: null,
      hits: picked,
      errors,
      dry_run: dryRun,
    };
  }

  private makeHit(
    type: AnomalyType,
    quote: QuoteLike,
    extra: { avg20d?: number | null; industryName?: string | null; record?: LimitUpRecord | null }
  ): AnomalyHit {
    return {
      symbol: quote.symbol,
      name: quote.name,
      anomaly_type: type,
      rule_id: ANOMALY_RULE_IDS[type],
      label: ANOMALY_LABELS[type],
      reason: buildAnomalyReason(type, quote, extra),
      confidence_score: scoreAnomaly(type),
      current_price: quote.current_price,
      change_percent: quote.change_percent,
      metadata: {
        industry: quote.industry,
        avg_volume_20d: extra.avg20d ?? null,
        industry_main_inflow: extra.industryName ? extra.industryName : null,
      },
    };
  }
}

export const intradayPriceVolumeAnomalyDetector = new IntradayPriceVolumeAnomalyDetector();
