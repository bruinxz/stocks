/**
 * AuctionSnapshotSyncService — PR-M2 (2026-06-29)
 *
 * 9:25 集合竞价撮合后, 拉 universe (~500 票) 的开盘价 + 量 + 昨收, 计算 7+1 战法
 * pattern, bulkCreate(updateOnDuplicate) 写入 auction_snapshots.
 *
 * 学术依据 (PR-I 报告引用):
 *   - Han/Hu/Jia 2023 SSRN: A 股集合竞价信息含量 > 美股, 隔夜信息主要在 9:15-9:25 释放
 *   - Gu/Ren 2010 Physica A: 集合竞价是 A 股最重要 price discovery 通道
 *   - Yamamoto 2025: opening price reflects "majority of overnight information"
 *
 * 7+1 战法 (pattern 字段值域, 与 classifyAuctionPattern 严格对齐):
 *   1. one_word          一字板 (open=high=low + open_pct ≈ +limit_pct)
 *   2. shrink_limit      缩量涨停 (one_word 子类, 留扩展, 本服务暂归入 one_word)
 *   3. high_open_volume  高开巨量 (open_pct ≥ +3% 且巨量, 简化: open_pct ≥ +3%)
 *   4. gap_up            高开 [+1%, +3%) 轻度高开
 *   5. gap_down          低开 (≤ -1%)
 *   6. t_word            T 字板 — 需 intraday 数据, 本服务不识别
 *   7. low_open_v        低开 V 型反弹 — 需 intraday
 *   8. northbound_block  北向竞价大单 — 需 KOL 北向, 暂不识别
 *   9. normal            平开 (其它)
 *
 * fail-OPEN 三层:
 *   1. universe 加载失败 → 退到空 universe, 整次 SUCCESS(0 inserted)
 *   2. python 批量取价失败 → 退到空 quote map, 整次 SUCCESS(0 inserted)
 *   3. 单股 classify / DB write 失败 → per-symbol try/catch, 不阻塞其它
 *
 * 与既有 services 关系:
 *   - 复用 IntradayUniverseService 的 resolveUniverse() (限 ~500 票活跃池)
 *   - 复用 python ak.stock_zh_a_spot_em (新 get_auction_snapshot_batch helper, 返 prev_close)
 *   - 输出 auction_snapshots 表给 OpeningRushDetector / IntradayMomentumDetector / UI 卡片消费
 *
 * Design constraints (与 services/CLAUDE.md 一致):
 *   1. DataSource DI: PRODUCTION_AUCTION_SNAPSHOT_DATA_SOURCE 真实现 + 单测注入 fake 全脱 DB.
 *   2. 纯函数 helpers 全 export (classifyAuctionPattern / roundTo / numberOrNull).
 *   3. fail-OPEN: runOnce 永不抛.
 *   4. 不写 RiskAlert — 本服务只写 auction_snapshots 表.
 */

import { logger } from '../utils/logger';
import { spawn } from 'child_process';
import * as path from 'path';
import moment from 'moment-timezone';
import { isAShareTradeDay } from '../utils/tradingCalendar';
import { inferMarketSegment, getLimitPct } from '../quant/marketLimits';
import { isSTName } from '../utils/stNameUtils';
import { normalizeSymbol } from '../utils/stockSymbol';
import { intradayUniverseService } from './IntradayUniverseService';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const HIGH_OPEN_VOLUME_PCT_THRESHOLD = 3.0;
export const GAP_UP_PCT_THRESHOLD = 1.0;
export const GAP_DOWN_PCT_THRESHOLD = -1.0;
export const ONE_WORD_LIMIT_TOLERANCE_PCT = 0.5;
export const ONE_WORD_PRICE_EPSILON = 0.001;
export const AUCTION_END_HOUR = 9;
export const AUCTION_END_MINUTE = 25;
export const SPOT_FETCH_TIMEOUT_MS = 60_000;
export const DEFAULT_UNIVERSE_LIMIT = 500;

export type AuctionPattern =
  | 'one_word'
  | 'shrink_limit'
  | 'high_open_volume'
  | 'gap_up'
  | 'gap_down'
  | 't_word'
  | 'low_open_v'
  | 'northbound_block'
  | 'normal';

export const ALL_AUCTION_PATTERNS: ReadonlyArray<AuctionPattern> = Object.freeze([
  'one_word',
  'shrink_limit',
  'high_open_volume',
  'gap_up',
  'gap_down',
  't_word',
  'low_open_v',
  'northbound_block',
  'normal',
]);

export interface AuctionSpotQuote {
  symbol: string;
  name: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  current: number | null;
  prev_close: number | null;
  volume: number | null;
  turnover: number | null;
}

export interface AuctionClassifyInput {
  symbol: string;
  name?: string | null;
  open: number | null;
  high?: number | null;
  low?: number | null;
  prev_close: number | null;
  volume?: number | null;
}

export interface AuctionClassifyResult {
  pattern: AuctionPattern;
  open_change_pct: number | null;
  is_limit_up: boolean;
}

export interface AuctionSnapshotRow {
  trade_date: string;
  symbol: string;
  name: string | null;
  open_price: number | null;
  open_volume: number | null;
  open_amount: number | null;
  prev_close: number | null;
  open_change_pct: number | null;
  is_limit_up: boolean;
  pattern: AuctionPattern;
  raw_payload: Record<string, unknown>;
}

export interface AuctionSnapshotDataSource {
  loadUniverseSymbols(limit: number): Promise<string[]>;
  fetchSpotQuotes(symbols: string[]): Promise<AuctionSpotQuote[]>;
  upsertSnapshots(tradeDate: string, rows: AuctionSnapshotRow[]): Promise<number>;
}

export interface RunOnceOptions {
  now?: Date;
  force?: boolean;
  universe_limit?: number;
  dry_run?: boolean;
}

export interface RunOnceResult {
  scenario: 'auction_snapshot_sync';
  trade_date: string;
  scanned: number;
  inserted: number;
  by_pattern: Record<AuctionPattern, number>;
  skipped_reason: string | null;
  dry_run: boolean;
}

// pure helpers — export

export function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function roundTo(v: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(v * m) / m;
}

export function todayTradeDate(now: Date = new Date()): string {
  return moment(now).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

export function isAfterAuctionEnd(now: Date = new Date()): boolean {
  const sh = moment(now).tz('Asia/Shanghai');
  const minutes = sh.hour() * 60 + sh.minute();
  return minutes >= AUCTION_END_HOUR * 60 + AUCTION_END_MINUTE;
}

export function classifyAuctionPattern(input: AuctionClassifyInput): AuctionClassifyResult {
  const open = numberOrNull(input.open);
  const prevClose = numberOrNull(input.prev_close);
  if (open === null || prevClose === null || prevClose <= 0) {
    return { pattern: 'normal', open_change_pct: null, is_limit_up: false };
  }
  const pct = ((open - prevClose) / prevClose) * 100;
  const pctRounded = roundTo(pct, 4);

  const high = numberOrNull(input.high);
  const low = numberOrNull(input.low);
  let isOneWord = false;
  if (high !== null && low !== null) {
    const threeEqual =
      Math.abs(open - high) <= ONE_WORD_PRICE_EPSILON &&
      Math.abs(open - low) <= ONE_WORD_PRICE_EPSILON;
    if (threeEqual) {
      const segment = inferMarketSegment(input.symbol);
      const isST = isSTName(input.name || null);
      const limitPct = getLimitPct(segment, isST) * 100;
      if (Math.abs(pct - limitPct) <= ONE_WORD_LIMIT_TOLERANCE_PCT) {
        isOneWord = true;
      }
    }
  }

  if (isOneWord) {
    return { pattern: 'one_word', open_change_pct: pctRounded, is_limit_up: true };
  }
  if (pct >= HIGH_OPEN_VOLUME_PCT_THRESHOLD) {
    return { pattern: 'high_open_volume', open_change_pct: pctRounded, is_limit_up: false };
  }
  if (pct >= GAP_UP_PCT_THRESHOLD) {
    return { pattern: 'gap_up', open_change_pct: pctRounded, is_limit_up: false };
  }
  if (pct <= GAP_DOWN_PCT_THRESHOLD) {
    return { pattern: 'gap_down', open_change_pct: pctRounded, is_limit_up: false };
  }
  return { pattern: 'normal', open_change_pct: pctRounded, is_limit_up: false };
}

export function quoteToSnapshotRow(
  tradeDate: string,
  q: AuctionSpotQuote
): AuctionSnapshotRow {
  const cls = classifyAuctionPattern({
    symbol: q.symbol,
    name: q.name,
    open: q.open,
    high: q.high,
    low: q.low,
    prev_close: q.prev_close,
    volume: q.volume,
  });
  const openAmount =
    q.turnover !== null && q.turnover !== undefined
      ? q.turnover
      : q.open !== null && q.volume !== null
      ? roundTo(q.open * q.volume, 4)
      : null;
  return {
    trade_date: tradeDate,
    symbol: q.symbol,
    name: q.name,
    open_price: q.open,
    open_volume: q.volume,
    open_amount: openAmount,
    prev_close: q.prev_close,
    open_change_pct: cls.open_change_pct,
    is_limit_up: cls.is_limit_up,
    pattern: cls.pattern,
    raw_payload: {
      high: q.high,
      low: q.low,
      current: q.current,
      turnover: q.turnover,
    },
  };
}

export function emptyPatternCounter(): Record<AuctionPattern, number> {
  return {
    one_word: 0,
    shrink_limit: 0,
    high_open_volume: 0,
    gap_up: 0,
    gap_down: 0,
    t_word: 0,
    low_open_v: 0,
    northbound_block: 0,
    normal: 0,
  };
}

export function countByPatternInMemory(
  rows: AuctionSnapshotRow[]
): Record<AuctionPattern, number> {
  const out = emptyPatternCounter();
  for (const r of rows) {
    out[r.pattern] = (out[r.pattern] || 0) + 1;
  }
  return out;
}

// production DataSource

function getPythonHelperPath(): { python: string; script: string } {
  return {
    python: process.env.PYTHON_PATH || 'python3',
    script: path.join(__dirname, '../../python/akshare_helper.py'),
  };
}

class DefaultAuctionSnapshotDataSource implements AuctionSnapshotDataSource {
  async loadUniverseSymbols(limit: number): Promise<string[]> {
    try {
      const universe = await intradayUniverseService.resolveUniverse({
        min_size: Math.min(100, limit),
        max_size: limit,
        include_market_movers: true,
      });
      return universe;
    } catch (e: any) {
      logger.warn(`[AuctionSnapshot] resolveUniverse failed: ${e?.message || e}`);
      return [];
    }
  }

  async fetchSpotQuotes(symbols: string[]): Promise<AuctionSpotQuote[]> {
    if (!symbols.length) return [];
    const symbolsStr = symbols.join(',');
    const { python, script } = getPythonHelperPath();
    return new Promise<AuctionSpotQuote[]>(resolve => {
      const child = spawn(python, [script, 'get_auction_snapshot_batch', symbolsStr]);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        logger.warn(
          `[AuctionSnapshot] fetchSpotQuotes timeout after ${SPOT_FETCH_TIMEOUT_MS}ms (symbols=${symbols.length})`
        );
        resolve([]);
      }, SPOT_FETCH_TIMEOUT_MS);
      child.stdout.on('data', b => {
        stdout += b.toString();
      });
      child.stderr.on('data', b => {
        stderr += b.toString();
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          logger.warn(`[AuctionSnapshot] python exit ${code}: ${stderr.slice(-200)}`);
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const data =
            parsed && typeof parsed === 'object' && Array.isArray((parsed as any).data)
              ? (parsed as any).data
              : Array.isArray(parsed)
              ? parsed
              : [];
          const out: AuctionSpotQuote[] = [];
          for (const v of data as any[]) {
            const sym = normalizeSymbol(String(v?.symbol || ''));
            if (!sym) continue;
            out.push({
              symbol: sym,
              name: typeof v.name === 'string' ? v.name : null,
              open: numberOrNull(v.open),
              high: numberOrNull(v.high),
              low: numberOrNull(v.low),
              current: numberOrNull(v.current),
              prev_close: numberOrNull(v.prev_close),
              volume: numberOrNull(v.volume),
              turnover: numberOrNull(v.turnover),
            });
          }
          resolve(out);
        } catch (e: any) {
          logger.warn(`[AuctionSnapshot] parse python output failed: ${e?.message || e}`);
          resolve([]);
        }
      });
      child.on('error', e => {
        clearTimeout(timer);
        logger.warn(`[AuctionSnapshot] spawn python error: ${e?.message || e}`);
        resolve([]);
      });
    });
  }

  async upsertSnapshots(tradeDate: string, rows: AuctionSnapshotRow[]): Promise<number> {
    if (!rows.length) return 0;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AuctionSnapshot } = require('../models/AuctionSnapshot');
    const dedup = new Map<string, AuctionSnapshotRow>();
    for (const r of rows) {
      if (!r.symbol) continue;
      dedup.set(`${r.trade_date}::${r.symbol}`, r);
    }
    const payload = Array.from(dedup.values());
    await AuctionSnapshot.bulkCreate(payload, {
      updateOnDuplicate: [
        'name',
        'open_price',
        'open_volume',
        'open_amount',
        'prev_close',
        'open_change_pct',
        'is_limit_up',
        'pattern',
        'raw_payload',
      ],
    });
    return payload.length;
  }
}

export const PRODUCTION_AUCTION_SNAPSHOT_DATA_SOURCE: AuctionSnapshotDataSource =
  new DefaultAuctionSnapshotDataSource();

// service

export class AuctionSnapshotSyncService {
  constructor(private ds: AuctionSnapshotDataSource = PRODUCTION_AUCTION_SNAPSHOT_DATA_SOURCE) {}

  async runOnce(options: RunOnceOptions = {}): Promise<RunOnceResult> {
    const now = options.now || new Date();
    const tradeDate = todayTradeDate(now);
    const universeLimit = options.universe_limit ?? DEFAULT_UNIVERSE_LIMIT;
    const dryRun = options.dry_run === true;
    const counter = emptyPatternCounter();

    if (!options.force && !isAfterAuctionEnd(now)) {
      return {
        scenario: 'auction_snapshot_sync',
        trade_date: tradeDate,
        scanned: 0,
        inserted: 0,
        by_pattern: counter,
        skipped_reason: 'before_auction_end',
        dry_run: dryRun,
      };
    }
    if (!options.force && !isAShareTradeDay(now)) {
      return {
        scenario: 'auction_snapshot_sync',
        trade_date: tradeDate,
        scanned: 0,
        inserted: 0,
        by_pattern: counter,
        skipped_reason: 'not_trading_day',
        dry_run: dryRun,
      };
    }

    try {
      let universe: string[] = [];
      try {
        universe = await this.ds.loadUniverseSymbols(universeLimit);
      } catch (e: any) {
        logger.warn(`[AuctionSnapshot] loadUniverseSymbols failed: ${e?.message || e}`);
        universe = [];
      }
      if (universe.length === 0) {
        return {
          scenario: 'auction_snapshot_sync',
          trade_date: tradeDate,
          scanned: 0,
          inserted: 0,
          by_pattern: counter,
          skipped_reason: 'empty_universe',
          dry_run: dryRun,
        };
      }

      let quotes: AuctionSpotQuote[] = [];
      try {
        quotes = await this.ds.fetchSpotQuotes(universe);
      } catch (e: any) {
        logger.warn(`[AuctionSnapshot] fetchSpotQuotes failed: ${e?.message || e}`);
        quotes = [];
      }

      const rows: AuctionSnapshotRow[] = [];
      for (const q of quotes) {
        try {
          const row = quoteToSnapshotRow(tradeDate, q);
          rows.push(row);
          counter[row.pattern] = (counter[row.pattern] || 0) + 1;
        } catch (e: any) {
          logger.warn(
            `[AuctionSnapshot] classify symbol=${q?.symbol} failed: ${e?.message || e}`
          );
        }
      }

      let inserted = 0;
      if (!dryRun && rows.length > 0) {
        try {
          inserted = await this.ds.upsertSnapshots(tradeDate, rows);
        } catch (e: any) {
          logger.warn(`[AuctionSnapshot] upsertSnapshots failed: ${e?.message || e}`);
        }
      }

      logger.info(
        `[AuctionSnapshot] trade_date=${tradeDate} universe=${universe.length} ` +
          `quotes=${quotes.length} classified=${rows.length} inserted=${inserted} dry=${dryRun} ` +
          `by_pattern=${JSON.stringify(counter)}`
      );

      return {
        scenario: 'auction_snapshot_sync',
        trade_date: tradeDate,
        scanned: quotes.length,
        inserted,
        by_pattern: counter,
        skipped_reason: null,
        dry_run: dryRun,
      };
    } catch (e: any) {
      logger.warn(`[AuctionSnapshot] runOnce top throw: ${e?.message || e}`);
      return {
        scenario: 'auction_snapshot_sync',
        trade_date: tradeDate,
        scanned: 0,
        inserted: 0,
        by_pattern: counter,
        skipped_reason: `top_error:${(e?.message || 'unknown').slice(0, 80)}`,
        dry_run: dryRun,
      };
    }
  }
}

export const auctionSnapshotSyncService = new AuctionSnapshotSyncService();
