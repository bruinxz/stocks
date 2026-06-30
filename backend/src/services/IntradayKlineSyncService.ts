/**
 * IntradayKlineSyncService — PR-M2 (2026-06-29)
 *
 * 盘中 30-min K 线时序同步.
 *
 * 由 cron INTRADAY_KLINE_30MIN_SYNC 每 30min (10:05/11:05/13:05/14:05/14:35) 触发,
 * 对 universe ~500 票分批 (concurrency=BATCH_CONCURRENCY) 调 python ak.stock_zh_a_hist_min_em
 * 拿当日所有已结束 30-min bar → bulkCreate(updateOnDuplicate) 写 intraday_klines_30min.
 *
 * 用途:
 *   - Zhang/Ma/Zhu 2019 Economic Modelling (被引 109): r1 = 9:30-10:00 收益预测 r2 = 14:30-15:00 收益.
 *   - 给 IntradayMomentumDetector 消费, 14:25 跑 → r1 > +1% 推荐 14:30 加仓.
 *
 * Bar 时间语义:
 *   AKShare stock_zh_a_hist_min_em 返回的 '时间' 是 bar **结束** 时刻
 *   (e.g. '2026-06-29 10:00:00' 表示 9:30-10:00 那根).
 *
 * fail-OPEN:
 *   - universe 加载失败 → 退到空, 整次 SUCCESS(0 inserted)
 *   - 单股 python 调用 / classify / DB write 失败 → per-symbol try/catch
 *
 * Throttle:
 *   - PER_SYMBOL_TIMEOUT_MS=15s
 *   - BATCH_CONCURRENCY=4 — 4 python 并发 + 500 票 ≈ 4-6 分钟全跑完
 *
 * Design constraints (与 services/CLAUDE.md 一致):
 *   1. DataSource DI + fake injection.
 *   2. 纯函数 helpers 全 export.
 *   3. fail-OPEN: runOnce 永不抛.
 */

import { logger } from '../utils/logger';
import { spawn } from 'child_process';
import * as path from 'path';
import moment from 'moment-timezone';
import { isAShareTradeDay } from '../utils/tradingCalendar';
import { normalizeSymbol } from '../utils/stockSymbol';
import { intradayUniverseService } from './IntradayUniverseService';
import { numberOrNull } from './AuctionSnapshotSyncService';
import { ensureModelsRegistered } from '../config/database';

// PR-Q (2026-06-30): cold-path Model not initialized hot-fix (AR-1 范式).
ensureModelsRegistered();

export const PER_SYMBOL_TIMEOUT_MS = 15_000;
export const BATCH_CONCURRENCY = 4;
export const DEFAULT_UNIVERSE_LIMIT = 500;
export const FIRST_KLINE_END_HOUR = 10;
export const FIRST_KLINE_END_MINUTE = 0;

export interface IntradayKlineRow {
  symbol: string;
  kline_time: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  money: number | null;
}

export interface IntradayKlineDataSource {
  loadUniverseSymbols(limit: number): Promise<string[]>;
  fetchSymbolKlines(symbol: string): Promise<IntradayKlineRow[]>;
  upsertKlines(rows: IntradayKlineRow[]): Promise<number>;
}

export interface RunOnceOptions {
  now?: Date;
  force?: boolean;
  universe_limit?: number;
  symbols?: string[];
  dry_run?: boolean;
}

export interface RunOnceResult {
  scenario: 'intraday_kline_30min_sync';
  trade_date: string;
  scanned_symbols: number;
  succeeded_symbols: number;
  total_klines: number;
  inserted: number;
  skipped_reason: string | null;
  dry_run: boolean;
}

export function parseKlineTime(s: string): Date | null {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.trim();
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  const mObj = moment.tz(
    `${y}-${mo}-${d} ${hh}:${mm}:${ss || '00'}`,
    'YYYY-MM-DD HH:mm:ss',
    'Asia/Shanghai'
  );
  if (!mObj.isValid()) return null;
  return mObj.toDate();
}

export function isAfterFirstKlineClose(now: Date = new Date()): boolean {
  const sh = moment(now).tz('Asia/Shanghai');
  const minutes = sh.hour() * 60 + sh.minute();
  return minutes >= FIRST_KLINE_END_HOUR * 60 + FIRST_KLINE_END_MINUTE;
}

export function todayTradeDate(now: Date = new Date()): string {
  return moment(now).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

export function filterTodayKlines(rows: IntradayKlineRow[], today: string): IntradayKlineRow[] {
  return rows.filter(r => {
    const d = moment(r.kline_time).tz('Asia/Shanghai').format('YYYY-MM-DD');
    return d === today;
  });
}

export function chunkSymbols<T>(arr: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    out.push(arr.slice(i, i + chunkSize));
  }
  return out;
}

export async function runConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  const workers: Promise<void>[] = [];
  const c = Math.max(1, Math.min(concurrency, items.length));
  for (let k = 0; k < c; k++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return out;
}

function getPythonHelperPath(): { python: string; script: string } {
  return {
    python: process.env.PYTHON_PATH || 'python3',
    script: path.join(__dirname, '../../python/akshare_helper.py'),
  };
}

class DefaultIntradayKlineDataSource implements IntradayKlineDataSource {
  async loadUniverseSymbols(limit: number): Promise<string[]> {
    try {
      return await intradayUniverseService.resolveUniverse({
        min_size: Math.min(100, limit),
        max_size: limit,
        include_market_movers: true,
      });
    } catch (e: any) {
      logger.warn(`[IntradayKline30min] resolveUniverse failed: ${e?.message || e}`);
      return [];
    }
  }

  async fetchSymbolKlines(symbol: string): Promise<IntradayKlineRow[]> {
    const { python, script } = getPythonHelperPath();
    return new Promise<IntradayKlineRow[]>(resolve => {
      const child = spawn(python, [script, 'get_intraday_klines_30min', symbol]);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        logger.warn(
          `[IntradayKline30min] fetchSymbolKlines timeout symbol=${symbol} after ${PER_SYMBOL_TIMEOUT_MS}ms`
        );
        resolve([]);
      }, PER_SYMBOL_TIMEOUT_MS);
      child.stdout.on('data', b => {
        stdout += b.toString();
      });
      child.stderr.on('data', b => {
        stderr += b.toString();
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          logger.warn(
            `[IntradayKline30min] python symbol=${symbol} exit ${code}: ${stderr.slice(-200)}`
          );
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const data = Array.isArray(parsed?.data)
            ? parsed.data
            : Array.isArray(parsed)
            ? parsed
            : [];
          const rows: IntradayKlineRow[] = [];
          for (const v of data as any[]) {
            const kt = parseKlineTime(String(v?.time || ''));
            if (!kt) continue;
            rows.push({
              symbol,
              kline_time: kt,
              open: numberOrNull(v.open),
              high: numberOrNull(v.high),
              low: numberOrNull(v.low),
              close: numberOrNull(v.close),
              volume: numberOrNull(v.volume),
              money: numberOrNull(v.money),
            });
          }
          resolve(rows);
        } catch (e: any) {
          logger.warn(
            `[IntradayKline30min] parse python symbol=${symbol} failed: ${e?.message || e}`
          );
          resolve([]);
        }
      });
      child.on('error', e => {
        clearTimeout(timer);
        logger.warn(`[IntradayKline30min] spawn symbol=${symbol} error: ${e?.message || e}`);
        resolve([]);
      });
    });
  }

  async upsertKlines(rows: IntradayKlineRow[]): Promise<number> {
    if (!rows.length) return 0;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { IntradayKline30Min } = require('../models/IntradayKline30Min');
    const dedup = new Map<string, IntradayKlineRow>();
    for (const r of rows) {
      if (!r.symbol || !r.kline_time) continue;
      const key = `${r.symbol}::${r.kline_time.toISOString()}`;
      dedup.set(key, r);
    }
    const payload = Array.from(dedup.values());
    await IntradayKline30Min.bulkCreate(payload, {
      updateOnDuplicate: ['open', 'high', 'low', 'close', 'volume', 'money'],
    });
    return payload.length;
  }
}

export const PRODUCTION_INTRADAY_KLINE_DATA_SOURCE: IntradayKlineDataSource =
  new DefaultIntradayKlineDataSource();

export class IntradayKlineSyncService {
  constructor(private ds: IntradayKlineDataSource = PRODUCTION_INTRADAY_KLINE_DATA_SOURCE) {}

  async runOnce(options: RunOnceOptions = {}): Promise<RunOnceResult> {
    const now = options.now || new Date();
    const tradeDate = todayTradeDate(now);
    const universeLimit = options.universe_limit ?? DEFAULT_UNIVERSE_LIMIT;
    const dryRun = options.dry_run === true;

    if (!options.force && !isAfterFirstKlineClose(now)) {
      return {
        scenario: 'intraday_kline_30min_sync',
        trade_date: tradeDate,
        scanned_symbols: 0,
        succeeded_symbols: 0,
        total_klines: 0,
        inserted: 0,
        skipped_reason: 'before_first_kline_close',
        dry_run: dryRun,
      };
    }
    if (!options.force && !isAShareTradeDay(now)) {
      return {
        scenario: 'intraday_kline_30min_sync',
        trade_date: tradeDate,
        scanned_symbols: 0,
        succeeded_symbols: 0,
        total_klines: 0,
        inserted: 0,
        skipped_reason: 'not_trading_day',
        dry_run: dryRun,
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
          logger.warn(`[IntradayKline30min] loadUniverseSymbols failed: ${e?.message || e}`);
          symbols = [];
        }
      }
      if (!symbols.length) {
        return {
          scenario: 'intraday_kline_30min_sync',
          trade_date: tradeDate,
          scanned_symbols: 0,
          succeeded_symbols: 0,
          total_klines: 0,
          inserted: 0,
          skipped_reason: 'empty_universe',
          dry_run: dryRun,
        };
      }

      const allRows: IntradayKlineRow[] = [];
      let succeeded = 0;
      const results = await runConcurrent(symbols, BATCH_CONCURRENCY, async sym => {
        try {
          const fetched = await this.ds.fetchSymbolKlines(sym);
          const todayOnly = filterTodayKlines(fetched, tradeDate);
          return { sym, rows: todayOnly, ok: true };
        } catch (e: any) {
          logger.warn(
            `[IntradayKline30min] per-symbol fetch sym=${sym} failed: ${e?.message || e}`
          );
          return { sym, rows: [] as IntradayKlineRow[], ok: false };
        }
      });
      for (const r of results) {
        if (r.ok) succeeded += 1;
        for (const row of r.rows) allRows.push(row);
      }

      let inserted = 0;
      if (!dryRun && allRows.length > 0) {
        try {
          inserted = await this.ds.upsertKlines(allRows);
        } catch (e: any) {
          logger.warn(`[IntradayKline30min] upsertKlines failed: ${e?.message || e}`);
        }
      }

      logger.info(
        `[IntradayKline30min] trade_date=${tradeDate} scanned=${symbols.length} ok=${succeeded} ` +
          `klines=${allRows.length} inserted=${inserted} dry=${dryRun}`
      );

      return {
        scenario: 'intraday_kline_30min_sync',
        trade_date: tradeDate,
        scanned_symbols: symbols.length,
        succeeded_symbols: succeeded,
        total_klines: allRows.length,
        inserted,
        skipped_reason: null,
        dry_run: dryRun,
      };
    } catch (e: any) {
      logger.warn(`[IntradayKline30min] runOnce top throw: ${e?.message || e}`);
      return {
        scenario: 'intraday_kline_30min_sync',
        trade_date: tradeDate,
        scanned_symbols: 0,
        succeeded_symbols: 0,
        total_klines: 0,
        inserted: 0,
        skipped_reason: `top_error:${(e?.message || 'unknown').slice(0, 80)}`,
        dry_run: dryRun,
      };
    }
  }
}

export const intradayKlineSyncService = new IntradayKlineSyncService();
