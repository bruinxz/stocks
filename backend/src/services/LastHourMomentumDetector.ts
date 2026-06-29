/**
 * LastHourMomentumDetector — PR-O3 修复 3 (2026-06-30)
 *
 * Yang/Li/Wang 2022 CFRI — A 股最稳 alpha: r1 (9:30-10:00) 显著预测
 * r2 (14:30-15:00).
 *
 * 与 PR-M2 IntradayMomentumDetector 关系:
 *   - PR-M2 已实现 r1 计算 + 写 RiskAlert (level=MEDIUM, rule_id=intraday_momentum_buy/sell).
 *   - 但 PR-M2 不写 `ai_investment_signals`, 所以前端 V3 推荐卡看不到.
 *   - 本 service 是 **接通器**: 复用 PR-M2 IntradayMomentumDetector → 把它产生的
 *     "buy" 信号 (r1 > +1%) 转写到 ai_investment_signals
 *     (source_type='last_hour_momentum', timing_tag='closing_grab', decision='buy').
 *
 * cron: 14:30 (复用 closing_grab 时机). PR-M2 IntradayMomentumDetector cron 已经是
 * 14:25, 此服务 14:30 跑保证 PR-M2 数据已经在 (但即使没在我们也直接调它的 runOnce
 * 自己出结果, 不依赖 RiskAlert 表读取).
 *
 * Design constraints:
 *   1. 完全复用 IntradayMomentumDetector — 不重写 r1 计算, 不重读 30min K 线
 *   2. dry_run 时调 PR-M2 with dry_run=true → 拿到 hits 不写 RiskAlert, 仅返回
 *   3. 不写 RiskAlert (PR-M2 已写), 只写 ai_investment_signals
 *   4. dedup: source_id = `last_hour_momentum::${symbol}::${trade_date}`
 *   5. fail-OPEN: per-symbol try/catch, runOnce 永不抛
 */

import { logger } from '../utils/logger';
import moment from 'moment-timezone';
import { isAShareTradeDay } from '../utils/tradingCalendar';
import {
  IntradayMomentumDetector,
  computeR1,
  MOMENTUM_BUY_THRESHOLD_PCT,
  classifyMomentumSignal,
  intradayMomentumDetector as productionIntradayMomentum,
} from './IntradayMomentumDetector';

export const SOURCE_TYPE_LAST_HOUR = 'last_hour_momentum';
export const TIMING_TAG_CLOSING_GRAB = 'closing_grab';

export interface LastHourMomentumDataSource {
  loadSymbolsAndR1(
    universeLimit: number,
    tradeDate: string
  ): Promise<Array<{ symbol: string; name: string | null; r1_pct: number | null }>>;
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

export interface LastHourRunOptions {
  now?: Date;
  force?: boolean;
  universe_limit?: number;
  top_k?: number;
  dry_run?: boolean;
}

export interface LastHourRunResult {
  scenario: 'last_hour_momentum';
  trade_date: string;
  scanned: number;
  matched: number;
  written: number;
  skipped_reason: string | null;
  dry_run: boolean;
  hits: Array<{
    symbol: string;
    name: string | null;
    r1_pct: number;
    confidence_score: number;
    reason: string;
  }>;
  errors: string[];
}

export const DEFAULT_UNIVERSE_LIMIT = 500;
export const DEFAULT_TOP_K = 20;

export function todayTradeDate(now: Date = new Date()): string {
  return moment(now).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

export function isAfter1430Shanghai(now: Date = new Date()): boolean {
  const sh = moment(now).tz('Asia/Shanghai');
  return sh.hour() * 60 + sh.minute() >= 14 * 60 + 30;
}

export function scoreFromR1(r1Pct: number): number {
  if (r1Pct >= 5) return 95;
  if (r1Pct >= 3) return 88;
  if (r1Pct >= 2) return 80;
  if (r1Pct >= 1) return 70;
  return 60;
}

export function buildLastHourReason(r1Pct: number): string {
  const sign = r1Pct > 0 ? '+' : '';
  return `🌆 尾盘埋 · 9:30-10:00 涨幅 ${sign}${r1Pct.toFixed(
    2
  )}% (Yang 2022 A股日内动量) · 建议 14:30-14:55 内买`;
}

export function buildLastHourSourceId(symbol: string, tradeDate: string): string {
  return `last_hour_momentum::${symbol}::${tradeDate}`;
}

class DefaultLastHourMomentumDataSource implements LastHourMomentumDataSource {
  constructor(private momentum: IntradayMomentumDetector = productionIntradayMomentum) {}

  async loadSymbolsAndR1(
    universeLimit: number,
    tradeDate: string
  ): Promise<Array<{ symbol: string; name: string | null; r1_pct: number | null }>> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const helpers = require('./IntradayMomentumDetector');
      const ds = (this.momentum as any).ds || helpers.PRODUCTION_INTRADAY_MOMENTUM_DATA_SOURCE;
      const symbols: string[] = await ds.loadUniverseSymbols(universeLimit);
      if (!symbols.length) return [];
      const klines = await ds.loadOpeningKlines(symbols, tradeDate);
      const nameMap: Map<string, string> = await ds.loadStockNames(symbols);
      const out: Array<{ symbol: string; name: string | null; r1_pct: number | null }> = [];
      for (const k of klines) {
        const r1 = computeR1(k);
        out.push({ symbol: k.symbol, name: nameMap.get(k.symbol) || null, r1_pct: r1 });
      }
      return out;
    } catch (e: any) {
      logger.warn(`[LastHourMomentum] loadSymbolsAndR1 failed: ${e?.message || e}`);
      return [];
    }
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
            where: { source_type: SOURCE_TYPE_LAST_HOUR, source_id: row.source_id },
            defaults: {
              source_type: SOURCE_TYPE_LAST_HOUR,
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
          logger.warn(`[LastHourMomentum] writeSignal ${row.symbol} failed: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      logger.warn(`[LastHourMomentum] writeSignals top throw: ${e?.message || e}`);
    }
    return { created, updated, errors };
  }
}

export const PRODUCTION_LAST_HOUR_MOMENTUM_DATA_SOURCE: LastHourMomentumDataSource =
  new DefaultLastHourMomentumDataSource();

export class LastHourMomentumDetector {
  constructor(private ds: LastHourMomentumDataSource = PRODUCTION_LAST_HOUR_MOMENTUM_DATA_SOURCE) {}

  async runOnce(options: LastHourRunOptions = {}): Promise<LastHourRunResult> {
    const now = options.now || new Date();
    const tradeDate = todayTradeDate(now);
    const dryRun = options.dry_run === true;
    const topK = options.top_k ?? DEFAULT_TOP_K;
    const universeLimit = options.universe_limit ?? DEFAULT_UNIVERSE_LIMIT;
    const errors: string[] = [];

    if (!options.force && !isAShareTradeDay(now)) {
      return {
        scenario: 'last_hour_momentum',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written: 0,
        skipped_reason: 'not_trading_day',
        dry_run: dryRun,
        hits: [],
        errors,
      };
    }

    let pairs: Array<{ symbol: string; name: string | null; r1_pct: number | null }> = [];
    try {
      pairs = await this.ds.loadSymbolsAndR1(universeLimit, tradeDate);
    } catch (e: any) {
      errors.push(`load:${e?.message || e}`);
    }
    if (!pairs.length) {
      return {
        scenario: 'last_hour_momentum',
        trade_date: tradeDate,
        scanned: 0,
        matched: 0,
        written: 0,
        skipped_reason: 'empty_universe',
        dry_run: dryRun,
        hits: [],
        errors,
      };
    }

    const matched: Array<{
      symbol: string;
      name: string | null;
      r1_pct: number;
      confidence_score: number;
      reason: string;
    }> = [];

    for (const p of pairs) {
      if (p.r1_pct === null) continue;
      const sig = classifyMomentumSignal({ r1_pct: p.r1_pct, is_position: false });
      if (sig !== 'buy') continue;
      if (p.r1_pct <= MOMENTUM_BUY_THRESHOLD_PCT) continue;
      matched.push({
        symbol: p.symbol,
        name: p.name,
        r1_pct: p.r1_pct,
        confidence_score: scoreFromR1(p.r1_pct),
        reason: buildLastHourReason(p.r1_pct),
      });
    }

    matched.sort((a, b) => b.confidence_score - a.confidence_score);
    const picked = matched.slice(0, topK);

    let written = 0;
    if (!dryRun && picked.length > 0) {
      try {
        const rows = picked.map(h => ({
          source_id: buildLastHourSourceId(h.symbol, tradeDate),
          symbol: h.symbol,
          name: h.name,
          signal_date: tradeDate,
          confidence_score: h.confidence_score,
          rationale: h.reason,
          metadata: {
            timing_tag: TIMING_TAG_CLOSING_GRAB,
            source: 'last_hour_momentum',
            battle_play: 'last_hour_momentum_play',
            battle_play_label: '🌆 尾盘半小时拉升',
            r1_pct: h.r1_pct,
          },
        }));
        const r = await this.ds.writeSignals(rows);
        written = r.created + r.updated;
        if (r.errors > 0) errors.push(`write_errors:${r.errors}`);
      } catch (e: any) {
        errors.push(`write:${e?.message || e}`);
      }
    }

    logger.info(
      `[LastHourMomentum] trade_date=${tradeDate} scanned=${pairs.length} matched=${matched.length} ` +
        `written=${written} dry=${dryRun}`
    );

    return {
      scenario: 'last_hour_momentum',
      trade_date: tradeDate,
      scanned: pairs.length,
      matched: matched.length,
      written,
      skipped_reason: null,
      dry_run: dryRun,
      hits: picked,
      errors,
    };
  }
}

export const lastHourMomentumDetector = new LastHourMomentumDetector();
