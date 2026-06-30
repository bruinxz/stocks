/**
 * OpeningRushDetector — PR-O3 修复 1 (2026-06-30)
 *
 * 真消费 PR-M1 `overnight_signals` + PR-M2 `auction_snapshots` 两张表, 跑战法库
 * §1.1-1.2 集合竞价 + 涨停板战法, 把命中票写入 `ai_investment_signals`
 * (source_type='opening_rush_detector', timing_tag='opening_rush').
 *
 * 真接通器 — PR-M1/M2 之前数据进库 0 处下游, 本 service 把它们接到 V3 推荐链.
 *
 * cron: 9:26 (AUCTION_SNAPSHOT_SYNC 9:25 写库后 1min, 9:30 开盘前用户可见).
 *
 * 战法库 §1.1-1.2 对应:
 *   - one_word         一字板 (战法 1-1-01)
 *   - t_word           T 字板 (战法 1-1-02)
 *   - high_open_volume 高开巨量 (战法 1-1-04 强势板 + 6-02 板块联动)
 *   - gap_up           普通高开 (战法 2-2-02 缺口, 配合 overnight 走强使用)
 *   - low_open_v       低开 V 反弹 (战法 1-4-* 反包)
 *
 * 大盘 gate (战法库 PR-I 教训 — 普跌日不要盲推):
 *   overnight.market_direction === 'bearish'  → 整次跳过推荐
 *   bullish / neutral / unknown → 继续
 *
 * fail-OPEN 三层:
 *   1. universe / overnight / auction 加载失败 → 整次返 SUCCESS(scanned=0, reason)
 *   2. 单票 score / write 失败 → per-symbol try/catch
 *   3. runOnce 永不抛
 */

import { logger } from '../utils/logger';
import moment from 'moment-timezone';
import { Op } from 'sequelize';
import { isAShareTradeDay } from '../utils/tradingCalendar';
import { normalizeSymbol } from '../utils/stockSymbol';
import {
  overnightSignalSyncService,
  type OvernightContext,
  type MarketDirection,
} from './OvernightSignalSyncService';
import { ensureModelsRegistered } from '../config/database';

// PR-Q (2026-06-30): cold-path Model not initialized hot-fix (AR-1 范式).
// 任何 caller (CLI / node -e / 单测 / 直接 require detector) 在 require 本模块时
// 立即触发 sequelize addModels, 避免首次 Model.findAll/create 抛 "needs to be added".
ensureModelsRegistered();

export const PATTERN_TO_BATTLE_PLAY: Record<string, string> = Object.freeze({
  one_word: 'one_word_play',
  t_word: 't_word_play',
  high_open_volume: 'high_open_volume_play',
  gap_up: 'gap_up_play',
  low_open_v: 'low_open_v_play',
  shrink_limit: 'shrink_limit_play',
  northbound_block: 'northbound_block_play',
  gap_down: 'gap_down_play',
  normal: 'normal_play',
});

export const PATTERN_TO_BATTLE_PLAY_LABEL: Record<string, string> = Object.freeze({
  one_word: '🚀 一字板',
  t_word: '🎯 T字板',
  high_open_volume: '☀️ 高开巨量',
  gap_up: '⬆️ 高开缺口',
  low_open_v: '🔄 低开V反包',
  shrink_limit: '🔥 缩量涨停',
  northbound_block: '🌐 北向竞价大单',
  gap_down: '',
  normal: '',
});

export const ACTIONABLE_PATTERNS: ReadonlyArray<string> = Object.freeze([
  'one_word',
  'shrink_limit',
  'high_open_volume',
  't_word',
  'low_open_v',
  'gap_up',
  'northbound_block',
]);

export const HIGH_OPEN_MIN_PCT = 3.0;
export const GAP_UP_MIN_PCT = 2.0;
export const DEFAULT_AUCTION_LIMIT = 500;
export const DEFAULT_TOP_K = 20;

export const SOURCE_TYPE_OPENING_RUSH = 'opening_rush_detector';
export const TIMING_TAG_OPENING_RUSH = 'opening_rush';

export interface AuctionSnapshotLike {
  trade_date: string;
  symbol: string;
  name: string | null;
  open_price: number | null;
  open_volume: number | null;
  open_amount: number | null;
  prev_close: number | null;
  open_change_pct: number | null;
  is_limit_up: boolean;
  pattern: string;
}

export interface OpeningRushHit {
  symbol: string;
  name: string | null;
  pattern: string;
  battle_play: string;
  battle_play_label: string;
  open_change_pct: number | null;
  is_limit_up: boolean;
  confidence_score: number;
  reason: string;
  overnight_a50: number | null;
  overnight_direction: MarketDirection;
}

export interface OpeningRushRunOptions {
  now?: Date;
  force?: boolean;
  top_k?: number;
  auction_limit?: number;
  dry_run?: boolean;
}

export interface OpeningRushRunResult {
  scenario: 'opening_rush_detector';
  trade_date: string;
  scanned: number;
  matched: number;
  written: number;
  by_pattern: Record<string, number>;
  overnight_direction: MarketDirection;
  overnight_reason: string;
  skipped_reason: string | null;
  dry_run: boolean;
  hits: OpeningRushHit[];
  errors: string[];
}

export interface OpeningRushDataSource {
  loadOvernightContext(now: Date): Promise<OvernightContext>;
  loadAuctionSnapshots(tradeDate: string, limit: number): Promise<AuctionSnapshotLike[]>;
  writeSignals(
    rows: WriteSignalRow[]
  ): Promise<{ created: number; updated: number; errors: number }>;
}

export interface WriteSignalRow {
  source_type: string;
  source_id: string;
  symbol: string;
  name: string | null;
  signal_date: string;
  decision: string;
  normalized_decision: string;
  confidence_score: number;
  rationale: string;
  metadata: Record<string, unknown>;
  detail: string | null;
}

export function todayTradeDate(now: Date = new Date()): string {
  return moment(now).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

export function isAfterAuctionEnd(now: Date = new Date()): boolean {
  const sh = moment(now).tz('Asia/Shanghai');
  const minutes = sh.hour() * 60 + sh.minute();
  return minutes >= 9 * 60 + 25;
}

export function deriveBattlePlay(pattern: string): string {
  return PATTERN_TO_BATTLE_PLAY[pattern] || 'normal_play';
}

export function deriveBattlePlayLabel(pattern: string): string {
  return PATTERN_TO_BATTLE_PLAY_LABEL[pattern] || '';
}

export function shouldPush(
  snapshot: AuctionSnapshotLike,
  _overnight?: OvernightContext | null
): boolean {
  if (!ACTIONABLE_PATTERNS.includes(snapshot.pattern)) return false;
  const pct = typeof snapshot.open_change_pct === 'number' ? snapshot.open_change_pct : null;
  if (snapshot.pattern === 'high_open_volume') {
    return pct !== null && pct >= HIGH_OPEN_MIN_PCT;
  }
  if (snapshot.pattern === 'gap_up') {
    return pct !== null && pct >= GAP_UP_MIN_PCT;
  }
  return true;
}

export function scoreOpeningRush(
  snapshot: AuctionSnapshotLike,
  overnight: OvernightContext | null
): number {
  let score = 60;
  switch (snapshot.pattern) {
    case 'one_word':
      score = 90;
      break;
    case 'shrink_limit':
      score = 85;
      break;
    case 'high_open_volume':
      score = 80;
      break;
    case 't_word':
      score = 78;
      break;
    case 'low_open_v':
      score = 72;
      break;
    case 'northbound_block':
      score = 75;
      break;
    case 'gap_up':
      score = 68;
      break;
  }
  if (overnight) {
    if (overnight.market_direction === 'bullish') score += 5;
    if (overnight.market_direction === 'neutral') score += 1;
  }
  if (snapshot.is_limit_up) score += 3;
  const pct = typeof snapshot.open_change_pct === 'number' ? snapshot.open_change_pct : 0;
  if (pct >= 5) score += 5;
  else if (pct >= 3) score += 3;
  else if (pct >= 1) score += 1;
  return Math.min(99, Math.max(50, Math.round(score)));
}

export function buildHitReason(
  snapshot: AuctionSnapshotLike,
  overnight: OvernightContext | null
): string {
  const battleLabel = deriveBattlePlayLabel(snapshot.pattern) || snapshot.pattern;
  const pct = snapshot.open_change_pct;
  const pctStr =
    pct !== null && typeof pct === 'number' ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : 'N/A';
  let overnightTag = '';
  if (overnight && overnight.market_direction !== 'unknown') {
    const tagWord =
      overnight.market_direction === 'bullish'
        ? '走强'
        : overnight.market_direction === 'bearish'
        ? '走弱'
        : '中性';
    overnightTag = ` · 隔夜${tagWord} (${overnight.reason})`;
  }
  return `${battleLabel} · 开盘 ${pctStr}${overnightTag}`;
}

export function buildSourceId(symbol: string, tradeDate: string): string {
  return `opening_rush::${symbol}::${tradeDate}`;
}

export function hitToSignalRow(
  hit: OpeningRushHit,
  tradeDate: string,
  overnight: OvernightContext | null
): WriteSignalRow {
  const a50 = overnight?.signals.get('a50_future')?.change_pct ?? null;
  const vix = overnight?.signals.get('us_vix')?.change_pct ?? null;
  return {
    source_type: SOURCE_TYPE_OPENING_RUSH,
    source_id: buildSourceId(hit.symbol, tradeDate),
    symbol: hit.symbol,
    name: hit.name,
    signal_date: tradeDate,
    decision: 'buy',
    normalized_decision: 'buy',
    confidence_score: hit.confidence_score,
    rationale: hit.reason,
    metadata: {
      timing_tag: TIMING_TAG_OPENING_RUSH,
      source: 'opening_rush_detector',
      pattern: hit.pattern,
      battle_play: hit.battle_play,
      battle_play_label: hit.battle_play_label,
      open_change_pct: hit.open_change_pct,
      is_limit_up: hit.is_limit_up,
      overnight_direction: hit.overnight_direction,
      overnight_a50: a50,
      overnight_vix: vix,
      overnight_reason: overnight?.reason ?? null,
    },
    detail: JSON.stringify({
      pattern: hit.pattern,
      battle_play: hit.battle_play,
      reason: hit.reason,
      key_reasons: [hit.reason],
      overnight: overnight
        ? {
            direction: overnight.market_direction,
            reason: overnight.reason,
            a50_pct: a50,
            vix_pct: vix,
            source_count: overnight.source_count,
          }
        : null,
    }),
  };
}

export function emptyByPattern(): Record<string, number> {
  return {
    one_word: 0,
    t_word: 0,
    high_open_volume: 0,
    gap_up: 0,
    low_open_v: 0,
    shrink_limit: 0,
    northbound_block: 0,
  };
}

class DefaultOpeningRushDataSource implements OpeningRushDataSource {
  async loadOvernightContext(now: Date): Promise<OvernightContext> {
    return overnightSignalSyncService.loadRecentContext(now);
  }

  async loadAuctionSnapshots(tradeDate: string, limit: number): Promise<AuctionSnapshotLike[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AuctionSnapshot } = require('../models/AuctionSnapshot');
      const rows = await AuctionSnapshot.findAll({
        where: {
          trade_date: tradeDate,
          pattern: { [Op.in]: ACTIONABLE_PATTERNS as string[] },
        },
        order: [
          ['is_limit_up', 'DESC'],
          ['open_change_pct', 'DESC'],
        ],
        limit,
        raw: true,
      });
      return (rows as any[]).map(r => ({
        trade_date: String(r.trade_date),
        symbol: normalizeSymbol(String(r.symbol)),
        name: r.name ?? null,
        open_price:
          r.open_price !== null && r.open_price !== undefined ? Number(r.open_price) : null,
        open_volume:
          r.open_volume !== null && r.open_volume !== undefined ? Number(r.open_volume) : null,
        open_amount:
          r.open_amount !== null && r.open_amount !== undefined ? Number(r.open_amount) : null,
        prev_close:
          r.prev_close !== null && r.prev_close !== undefined ? Number(r.prev_close) : null,
        open_change_pct:
          r.open_change_pct !== null && r.open_change_pct !== undefined
            ? Number(r.open_change_pct)
            : null,
        is_limit_up: Boolean(r.is_limit_up),
        pattern: String(r.pattern || 'normal'),
      }));
    } catch (e: any) {
      logger.warn(`[OpeningRush] loadAuctionSnapshots failed: ${e?.message || e}`);
      return [];
    }
  }

  async writeSignals(
    rows: WriteSignalRow[]
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
            where: { source_type: row.source_type, source_id: row.source_id },
            defaults: {
              ...row,
              forward_returns: {},
              verification_status: 'pending',
            },
          });
          if (isCreated) created++;
          else updated++;
        } catch (e: any) {
          errors++;
          logger.warn(`[OpeningRush] write signal ${row.symbol} failed: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      logger.warn(`[OpeningRush] writeSignals top throw: ${e?.message || e}`);
    }
    return { created, updated, errors };
  }
}

export const PRODUCTION_OPENING_RUSH_DATA_SOURCE: OpeningRushDataSource =
  new DefaultOpeningRushDataSource();

export class OpeningRushDetector {
  constructor(private ds: OpeningRushDataSource = PRODUCTION_OPENING_RUSH_DATA_SOURCE) {}

  async runOnce(options: OpeningRushRunOptions = {}): Promise<OpeningRushRunResult> {
    const now = options.now || new Date();
    const tradeDate = todayTradeDate(now);
    const dryRun = options.dry_run === true;
    const topK = options.top_k ?? DEFAULT_TOP_K;
    const auctionLimit = options.auction_limit ?? DEFAULT_AUCTION_LIMIT;
    const byPattern = emptyByPattern();
    const errors: string[] = [];
    const hits: OpeningRushHit[] = [];

    if (!options.force && !isAShareTradeDay(now)) {
      return {
        scenario: 'opening_rush_detector',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written: 0,
        by_pattern: byPattern,
        overnight_direction: 'unknown',
        overnight_reason: '',
        skipped_reason: 'not_trading_day',
        dry_run: dryRun,
        hits: [],
        errors,
      };
    }

    if (!options.force && !isAfterAuctionEnd(now)) {
      return {
        scenario: 'opening_rush_detector',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written: 0,
        by_pattern: byPattern,
        overnight_direction: 'unknown',
        overnight_reason: '',
        skipped_reason: 'before_auction_end',
        dry_run: dryRun,
        hits: [],
        errors,
      };
    }

    let overnight: OvernightContext | null = null;
    try {
      overnight = await this.ds.loadOvernightContext(now);
    } catch (e: any) {
      logger.warn(`[OpeningRush] loadOvernight failed: ${e?.message || e}`);
      errors.push(`overnight:${e?.message || e}`);
      overnight = null;
    }

    const direction: MarketDirection = overnight?.market_direction ?? 'unknown';
    const reason = overnight?.reason ?? '';

    if (overnight && direction === 'bearish') {
      logger.info(
        `[OpeningRush] trade_date=${tradeDate} skipped: market bearish (${overnight.reason})`
      );
      return {
        scenario: 'opening_rush_detector',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written: 0,
        by_pattern: byPattern,
        overnight_direction: direction,
        overnight_reason: reason,
        skipped_reason: 'bearish_overnight',
        dry_run: dryRun,
        hits: [],
        errors,
      };
    }

    let snapshots: AuctionSnapshotLike[] = [];
    try {
      snapshots = await this.ds.loadAuctionSnapshots(tradeDate, auctionLimit);
    } catch (e: any) {
      logger.warn(`[OpeningRush] loadAuctionSnapshots failed: ${e?.message || e}`);
      errors.push(`auction:${e?.message || e}`);
    }

    if (!snapshots.length) {
      return {
        scenario: 'opening_rush_detector',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written: 0,
        by_pattern: byPattern,
        overnight_direction: direction,
        overnight_reason: reason,
        skipped_reason: 'empty_auction',
        dry_run: dryRun,
        hits: [],
        errors,
      };
    }

    for (const s of snapshots) {
      try {
        if (!shouldPush(s, overnight)) continue;
        const score = scoreOpeningRush(s, overnight);
        const battle = deriveBattlePlay(s.pattern);
        const battleLabel = deriveBattlePlayLabel(s.pattern);
        hits.push({
          symbol: s.symbol,
          name: s.name,
          pattern: s.pattern,
          battle_play: battle,
          battle_play_label: battleLabel,
          open_change_pct: s.open_change_pct,
          is_limit_up: s.is_limit_up,
          confidence_score: score,
          reason: buildHitReason(s, overnight),
          overnight_a50: overnight?.signals.get('a50_future')?.change_pct ?? null,
          overnight_direction: direction,
        });
        byPattern[s.pattern] = (byPattern[s.pattern] || 0) + 1;
      } catch (e: any) {
        errors.push(`score:${s.symbol}:${e?.message || e}`);
      }
    }

    hits.sort((a, b) => b.confidence_score - a.confidence_score);
    const picked = hits.slice(0, topK);

    let written = 0;
    if (!dryRun && picked.length > 0) {
      try {
        const rows = picked.map(h => hitToSignalRow(h, tradeDate, overnight));
        const r = await this.ds.writeSignals(rows);
        written = r.created + r.updated;
        if (r.errors > 0) errors.push(`write_errors:${r.errors}`);
      } catch (e: any) {
        errors.push(`write:${e?.message || e}`);
      }
    }

    logger.info(
      `[OpeningRush] trade_date=${tradeDate} dir=${direction} scanned=${snapshots.length} ` +
        `matched=${hits.length} written=${written} dry=${dryRun} ` +
        `by_pattern=${JSON.stringify(byPattern)}`
    );

    return {
      scenario: 'opening_rush_detector',
      trade_date: tradeDate,
      scanned: snapshots.length,
      matched: hits.length,
      written,
      by_pattern: byPattern,
      overnight_direction: direction,
      overnight_reason: reason,
      skipped_reason: null,
      dry_run: dryRun,
      hits: picked,
      errors,
    };
  }
}

export const openingRushDetector = new OpeningRushDetector();
