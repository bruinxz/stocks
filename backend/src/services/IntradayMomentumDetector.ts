/**
 * IntradayMomentumDetector — PR-M2 (2026-06-29)
 *
 * Zhang/Ma/Zhu 2019 Economic Modelling (被引 109) 论文核心:
 *   - r1 = 9:30-10:00 30min 收益预测 r2 = 14:30-15:00 30min 收益
 *   - "mainly evident in China" → A 股最 robust 日内 alpha
 *
 * 本 detector 14:25 跑 (cron `25 14 * * 1-5`), 给每只 universe 票:
 *   1. 读 intraday_klines_30min 当日 9:30 / 10:00 两根 → 算 r1 = (close[10:00] - close[9:30]) / close[9:30]
 *   2. r1 > +1% → 推荐"14:30 加仓" (写 RiskAlert level=MEDIUM rule_id='intraday_momentum_buy')
 *   3. r1 < -1% AND 持仓 → 推荐"14:30 减仓 T+1" (rule_id='intraday_momentum_sell')
 *   4. 同股同日 dedup (按 rule_id::symbol::trade_date)
 *
 * fail-OPEN:
 *   - universe / kline / positions 加载失败 → 空 + 继续
 *   - 单 user RiskAlert 写入失败 → per-user try/catch
 *
 * Design constraints:
 *   1. DataSource DI + fake injection.
 *   2. 纯函数 helpers 全 export.
 *   3. fail-OPEN: runOnce 永不抛.
 *   4. 写 RiskAlert 必须设 rule_id.
 */

import { logger } from '../utils/logger';
import moment from 'moment-timezone';
import { isAShareTradeDay } from '../utils/tradingCalendar';
import { normalizeSymbol } from '../utils/stockSymbol';
import { intradayUniverseService } from './IntradayUniverseService';
import { numberOrNull } from './AuctionSnapshotSyncService';
import { ensureModelsRegistered } from '../config/database';

// PR-Q (2026-06-30): cold-path Model not initialized hot-fix (AR-1 范式).
ensureModelsRegistered();

export const MOMENTUM_BUY_THRESHOLD_PCT = 1.0;
export const MOMENTUM_SELL_THRESHOLD_PCT = -1.0;
export const DEFAULT_UNIVERSE_LIMIT = 500;
export const RULE_ID_BUY = 'intraday_momentum_buy';
export const RULE_ID_SELL = 'intraday_momentum_sell';
export const DEDUP_HOURS = 24;

export type MomentumSignalType = 'buy' | 'sell' | 'none';

export interface SymbolKline930And1000 {
  symbol: string;
  close_9_30: number | null;
  close_10_00: number | null;
}

export interface IntradayMomentumDataSource {
  loadUniverseSymbols(limit: number): Promise<string[]>;
  loadOpeningKlines(symbols: string[], tradeDate: string): Promise<SymbolKline930And1000[]>;
  loadPositionsByUser(): Promise<Map<number, Set<string>>>;
  listActiveUserIds(): Promise<number[]>;
  loadRecentDedupKeys(dedupHours: number): Promise<Set<string>>;
  writeRiskAlerts(input: {
    user_ids: number[];
    symbol: string;
    name: string | null;
    level: 'MEDIUM';
    rule_id: string;
    message: string;
  }): Promise<{ created_ids: number[]; failed: number }>;
  loadStockNames(symbols: string[]): Promise<Map<string, string>>;
}

export interface RunOnceOptions {
  now?: Date;
  force?: boolean;
  universe_limit?: number;
  symbols?: string[];
  dry_run?: boolean;
}

export interface RunOnceResult {
  scenario: 'intraday_momentum_detect';
  trade_date: string;
  scanned: number;
  matched_buy: number;
  matched_sell: number;
  written_alerts: number;
  deduped: number;
  skipped_reason: string | null;
  dry_run: boolean;
  errors: string[];
}

export function computeR1(input: {
  close_9_30: number | null;
  close_10_00: number | null;
}): number | null {
  const a = numberOrNull(input.close_9_30);
  const b = numberOrNull(input.close_10_00);
  if (a === null || b === null || a <= 0) return null;
  return ((b - a) / a) * 100;
}

export function classifyMomentumSignal(input: {
  r1_pct: number | null;
  is_position: boolean;
}): MomentumSignalType {
  if (input.r1_pct === null || !Number.isFinite(input.r1_pct)) return 'none';
  if (input.r1_pct > MOMENTUM_BUY_THRESHOLD_PCT) return 'buy';
  if (input.r1_pct < MOMENTUM_SELL_THRESHOLD_PCT && input.is_position) return 'sell';
  return 'none';
}

export function dedupKeyFor(ruleId: string, symbol: string, tradeDate: string): string {
  return `${ruleId}::${symbol}::${tradeDate}`;
}

export function todayTradeDate(now: Date = new Date()): string {
  return moment(now).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

export function formatMomentumMessage(input: {
  symbol: string;
  name: string | null;
  r1_pct: number;
  signal: MomentumSignalType;
  trade_date: string;
}): string {
  const sign = input.r1_pct > 0 ? '+' : '';
  const ruleId = input.signal === 'buy' ? RULE_ID_BUY : RULE_ID_SELL;
  const dedupKey = dedupKeyFor(ruleId, input.symbol, input.trade_date);
  const action = input.signal === 'buy' ? '建议 14:30 加仓' : '建议 14:30 减仓 (T+1)';
  return (
    `[盘中动量] ${input.name || input.symbol} ` +
    `9:30-10:00 收益 ${sign}${input.r1_pct.toFixed(2)}% → ${action}. ` +
    `参考论文 Zhang/Ma/Zhu 2019 A 股日内动量. [dedup_key:${dedupKey}]`
  );
}

class DefaultIntradayMomentumDataSource implements IntradayMomentumDataSource {
  async loadUniverseSymbols(limit: number): Promise<string[]> {
    try {
      return await intradayUniverseService.resolveUniverse({
        min_size: Math.min(100, limit),
        max_size: limit,
        include_market_movers: true,
      });
    } catch (e: any) {
      logger.warn(`[IntradayMomentum] resolveUniverse failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadOpeningKlines(
    symbols: string[],
    tradeDate: string
  ): Promise<SymbolKline930And1000[]> {
    if (!symbols.length) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { IntradayKline30Min } = require('../models/IntradayKline30Min');
      const sequelize = IntradayKline30Min.sequelize;
      if (!sequelize) return [];
      const startTs = moment
        .tz(`${tradeDate} 09:30:00`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Shanghai')
        .toDate();
      const endTs = moment
        .tz(`${tradeDate} 10:00:00`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Shanghai')
        .toDate();
      const rows: Array<{ symbol: string; kline_time: string | Date; close: string | number | null }> =
        await sequelize.query(
          `SELECT symbol, kline_time, close
           FROM intraday_klines_30min
           WHERE symbol = ANY(:symbols)
             AND kline_time IN (:t1, :t2)`,
          {
            replacements: { symbols, t1: startTs, t2: endTs },
            type: sequelize.QueryTypes.SELECT,
          }
        );
      const map = new Map<
        string,
        { close_9_30: number | null; close_10_00: number | null }
      >();
      for (const r of rows || []) {
        const sym = String((r as any).symbol || '');
        if (!sym) continue;
        const kt = new Date((r as any).kline_time);
        const close = numberOrNull((r as any).close);
        const cur = map.get(sym) || { close_9_30: null, close_10_00: null };
        if (Math.abs(kt.getTime() - startTs.getTime()) < 60_000) {
          cur.close_9_30 = close;
        } else if (Math.abs(kt.getTime() - endTs.getTime()) < 60_000) {
          cur.close_10_00 = close;
        }
        map.set(sym, cur);
      }
      const out: SymbolKline930And1000[] = [];
      for (const sym of symbols) {
        const cur = map.get(sym);
        out.push({
          symbol: sym,
          close_9_30: cur?.close_9_30 ?? null,
          close_10_00: cur?.close_10_00 ?? null,
        });
      }
      return out;
    } catch (e: any) {
      logger.warn(`[IntradayMomentum] loadOpeningKlines failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadPositionsByUser(): Promise<Map<number, Set<string>>> {
    const out = new Map<number, Set<string>>();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPosition } = require('../models/PaperTradingPosition');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPortfolio } = require('../models/PaperTradingPortfolio');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const portfolios: any[] = await PaperTradingPortfolio.findAll({
        attributes: ['id', 'user_id'],
        where: { is_active: true },
        raw: true,
      });
      const pidToUser = new Map<number, number>();
      const pids: number[] = [];
      for (const p of portfolios) {
        const pid = Number(p.id);
        const uid = Number(p.user_id);
        if (Number.isFinite(pid) && Number.isFinite(uid) && uid > 0) {
          pidToUser.set(pid, uid);
          pids.push(pid);
        }
      }
      if (!pids.length) return out;
      const positions: any[] = await PaperTradingPosition.findAll({
        attributes: ['portfolio_id', 'symbol', 'quantity'],
        where: { portfolio_id: { [Op.in]: pids }, quantity: { [Op.gt]: 0 } },
        raw: true,
      });
      for (const ps of positions) {
        const uid = pidToUser.get(Number(ps.portfolio_id));
        if (!uid) continue;
        const sym = normalizeSymbol(String(ps.symbol || ''));
        if (!sym) continue;
        if (!out.has(uid)) out.set(uid, new Set());
        out.get(uid)!.add(sym);
      }
    } catch (e: any) {
      logger.warn(`[IntradayMomentum] loadPositionsByUser failed: ${e?.message || e}`);
    }
    return out;
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
      logger.warn(`[IntradayMomentum] listActiveUserIds failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadRecentDedupKeys(dedupHours: number): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RiskAlert } = require('../models/RiskAlert');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const cutoff = new Date(Date.now() - dedupHours * 60 * 60 * 1000);
      const rows: any[] = await RiskAlert.findAll({
        attributes: ['message'],
        where: {
          rule_id: { [Op.in]: [RULE_ID_BUY, RULE_ID_SELL] },
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
      logger.warn(`[IntradayMomentum] loadRecentDedupKeys failed: ${e?.message || e}`);
    }
    return out;
  }

  async writeRiskAlerts(input: {
    user_ids: number[];
    symbol: string;
    name: string | null;
    level: 'MEDIUM';
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
            name: input.name || input.symbol,
            level: input.level,
            message: input.message,
            rule_id: input.rule_id,
          });
          if (row?.id) created_ids.push(Number(row.id));
        } catch (e: any) {
          failed += 1;
          logger.warn(
            `[IntradayMomentum] write RiskAlert user=${uid} symbol=${input.symbol} failed: ${e?.message || e}`
          );
        }
      }
    } catch (e: any) {
      logger.warn(`[IntradayMomentum] writeRiskAlerts top throw: ${e?.message || e}`);
    }
    return { created_ids, failed };
  }

  async loadStockNames(symbols: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!symbols.length) return out;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const rows: any[] = await Stock.findAll({
        attributes: ['symbol', 'name'],
        where: { symbol: { [Op.in]: symbols } },
        raw: true,
      });
      for (const r of rows || []) {
        const sym = String(r.symbol || '');
        const name = String(r.name || '');
        if (sym && name) out.set(sym, name);
      }
    } catch (e: any) {
      logger.warn(`[IntradayMomentum] loadStockNames failed: ${e?.message || e}`);
    }
    return out;
  }
}

export const PRODUCTION_INTRADAY_MOMENTUM_DATA_SOURCE: IntradayMomentumDataSource =
  new DefaultIntradayMomentumDataSource();

export class IntradayMomentumDetector {
  constructor(
    private ds: IntradayMomentumDataSource = PRODUCTION_INTRADAY_MOMENTUM_DATA_SOURCE
  ) {}

  async runOnce(options: RunOnceOptions = {}): Promise<RunOnceResult> {
    const now = options.now || new Date();
    const tradeDate = todayTradeDate(now);
    const universeLimit = options.universe_limit ?? DEFAULT_UNIVERSE_LIMIT;
    const dryRun = options.dry_run === true;
    const errors: string[] = [];

    if (!options.force && !isAShareTradeDay(now)) {
      return {
        scenario: 'intraday_momentum_detect',
        trade_date: tradeDate,
        scanned: 0,
        matched_buy: 0,
        matched_sell: 0,
        written_alerts: 0,
        deduped: 0,
        skipped_reason: 'not_trading_day',
        dry_run: dryRun,
        errors,
      };
    }

    try {
      let symbols: string[] = [];
      if (Array.isArray(options.symbols) && options.symbols.length > 0) {
        symbols = options.symbols
          .map(s => normalizeSymbol(s))
          .filter((s): s is string => !!s);
      } else {
        try {
          symbols = await this.ds.loadUniverseSymbols(universeLimit);
        } catch (e: any) {
          logger.warn(`[IntradayMomentum] universe failed: ${e?.message || e}`);
          symbols = [];
        }
      }
      if (!symbols.length) {
        return {
          scenario: 'intraday_momentum_detect',
          trade_date: tradeDate,
          scanned: 0,
          matched_buy: 0,
          matched_sell: 0,
          written_alerts: 0,
          deduped: 0,
          skipped_reason: 'empty_universe',
          dry_run: dryRun,
          errors,
        };
      }

      const [klines, positionsByUser, activeUsers, dedupSet, nameMap] = await Promise.all([
        this.ds.loadOpeningKlines(symbols, tradeDate).catch(e => {
          errors.push(`klines:${e?.message || e}`);
          return [] as SymbolKline930And1000[];
        }),
        this.ds.loadPositionsByUser().catch(e => {
          errors.push(`positions:${e?.message || e}`);
          return new Map<number, Set<string>>();
        }),
        this.ds.listActiveUserIds().catch(e => {
          errors.push(`active_users:${e?.message || e}`);
          return [] as number[];
        }),
        this.ds.loadRecentDedupKeys(DEDUP_HOURS).catch(e => {
          errors.push(`dedup:${e?.message || e}`);
          return new Set<string>();
        }),
        this.ds.loadStockNames(symbols).catch(e => {
          errors.push(`names:${e?.message || e}`);
          return new Map<string, string>();
        }),
      ]);

      const symbolToUsers = new Map<string, Set<number>>();
      for (const [uid, syms] of positionsByUser.entries()) {
        for (const s of syms) {
          if (!symbolToUsers.has(s)) symbolToUsers.set(s, new Set());
          symbolToUsers.get(s)!.add(uid);
        }
      }

      let matchedBuy = 0;
      let matchedSell = 0;
      let writtenAlerts = 0;
      let deduped = 0;

      for (const k of klines) {
        const r1 = computeR1(k);
        if (r1 === null) continue;
        const holders = symbolToUsers.get(k.symbol) || new Set<number>();
        const signal = classifyMomentumSignal({
          r1_pct: r1,
          is_position: holders.size > 0,
        });
        if (signal === 'none') continue;
        if (signal === 'buy') matchedBuy += 1;
        else if (signal === 'sell') matchedSell += 1;

        const ruleId = signal === 'buy' ? RULE_ID_BUY : RULE_ID_SELL;
        const dedupKey = dedupKeyFor(ruleId, k.symbol, tradeDate);
        if (dedupSet.has(dedupKey)) {
          deduped += 1;
          continue;
        }

        const name = nameMap.get(k.symbol) || null;
        const msg = formatMomentumMessage({
          symbol: k.symbol,
          name,
          r1_pct: r1,
          signal,
          trade_date: tradeDate,
        });

        const recipients = signal === 'buy' ? activeUsers : Array.from(holders);
        if (!recipients.length) continue;

        if (dryRun) {
          logger.info(
            `[IntradayMomentum:DRY] ${signal} symbol=${k.symbol} r1=${r1.toFixed(2)}% recipients=${recipients.length}`
          );
          continue;
        }

        try {
          const r = await this.ds.writeRiskAlerts({
            user_ids: recipients,
            symbol: k.symbol,
            name,
            level: 'MEDIUM',
            rule_id: ruleId,
            message: msg,
          });
          writtenAlerts += r.created_ids.length;
          dedupSet.add(dedupKey);
        } catch (e: any) {
          errors.push(`write:${k.symbol}:${e?.message || e}`);
        }
      }

      logger.info(
        `[IntradayMomentum] trade_date=${tradeDate} scanned=${symbols.length} ` +
          `buy=${matchedBuy} sell=${matchedSell} written=${writtenAlerts} deduped=${deduped} dry=${dryRun}`
      );

      return {
        scenario: 'intraday_momentum_detect',
        trade_date: tradeDate,
        scanned: symbols.length,
        matched_buy: matchedBuy,
        matched_sell: matchedSell,
        written_alerts: writtenAlerts,
        deduped,
        skipped_reason: null,
        dry_run: dryRun,
        errors,
      };
    } catch (e: any) {
      logger.warn(`[IntradayMomentum] runOnce top throw: ${e?.message || e}`);
      return {
        scenario: 'intraday_momentum_detect',
        trade_date: tradeDate,
        scanned: 0,
        matched_buy: 0,
        matched_sell: 0,
        written_alerts: 0,
        deduped: 0,
        skipped_reason: `top_error:${(e?.message || 'unknown').slice(0, 80)}`,
        dry_run: dryRun,
        errors: [String(e?.message || e), ...errors],
      };
    }
  }
}

export const intradayMomentumDetector = new IntradayMomentumDetector();
