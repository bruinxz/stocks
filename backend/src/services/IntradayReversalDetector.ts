/**
 * IntradayReversalDetector — PR-M3 (2026-06-29)
 *
 * 学术 (PR-I 报告第 4 个致命短板):
 *   - Hsu/Viswanathan/Wang 2018 JPM (cited 71)
 *   - Fang/Olteanu-Veerman 2020 JII
 *   - Shrivastava 2018
 *   - Zhang & Zhu 2024 IREF
 *   4 篇独立研究共识 — A 股因 T+1 + 散户主导 → 短期反转主导, 而非动量.
 *
 * 当前 detector 全是动量方向 (breakout / volume_spike / rapid_rise / gap_up / ...),
 * PR-K 实证发现: 我们高 conf 推荐 win 30% < 低 conf win 40% (反向). 根因 = 因子方向反了.
 *
 * 本 service 做两件事:
 *   1. 'reversal_buy' detector — 找今日跌幅 < -3% 且周线/月线趋势仍向上的票 → T+1 反弹概率高
 *      实证: A 股短期反转主导, 中线趋势 + 短期超跌 = 高胜率买入信号
 *   2. 'reversal_sell' detector — 找今日涨幅 > +5% 且 RSI > 70 的票 → 短期超买回调
 *
 * 与既有 service 关系:
 *   - 完全独立: 不写 ai_investment_signals 主表 (那是 analysis_engine / quant_recommendation 的领域),
 *     仅返结果给 caller (cron tick 或 paper_trading_facade 调用)
 *   - 推荐 service 决定是否落 signal — 本 service 只输出"反向候选 + 置信度估算"
 *
 * fail-OPEN:
 *   - 单 stock throw → 仅 warn, 其它 stock 继续
 *   - daily_bars 拉失败 → 该 stock skip
 *   - 整次 runOnce 永不 throw
 *
 * Universe (与 BullishEventDetectorService 同款):
 *   - paper_trading_positions WHERE quantity > 0
 *   - favorite_stocks (JOIN stocks)
 *   - 近 30 日 AI 推荐过 buy/strong_buy
 *   - hard cap 1500 (避免一次扫太久)
 */

import { logger } from '../utils/logger';
import { normalizeSymbol } from '../utils/stockSymbol';
import { ensureModelsRegistered } from '../config/database';

// PR-Q (2026-06-30): cold-path Model not initialized hot-fix (AR-1 范式).
ensureModelsRegistered();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReversalSignalType = 'reversal_buy' | 'reversal_sell';

export const REVERSAL_SIGNAL_TYPES: readonly ReversalSignalType[] = Object.freeze([
  'reversal_buy',
  'reversal_sell',
]);

export const REVERSAL_SIGNAL_LABELS: Record<ReversalSignalType, string> = Object.freeze({
  reversal_buy: '超跌反弹买入',
  reversal_sell: '超买回调卖出',
}) as Record<ReversalSignalType, string>;

export interface ReversalDailyBar {
  /** YYYY-MM-DD (asc 排序, 最新在末尾) */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  change_percent?: number | null;
}

export interface ReversalHit {
  symbol: string;
  stock_name?: string | null;
  signal_type: ReversalSignalType;
  signal_label: string;
  /** 估算置信度, 0-100 (越高越确信) */
  confidence: number;
  /** 1-2 句中文理由 */
  reason: string;
  /** 当日 change_pct (%) */
  today_change_pct: number;
  /** RSI(14), 卖单触发用 */
  rsi14: number | null;
  /** 周线趋势 (10 日 close 线性回归斜率符号; 1 = 向上, 0 = 持平, -1 = 向下) */
  weekly_trend: 1 | 0 | -1;
  /** 月线趋势 (30 日 close 线性回归斜率符号) */
  monthly_trend: 1 | 0 | -1;
  /** 透传给前端 / 落 signal 的 payload */
  source_payload?: Record<string, unknown>;
}

export interface ReversalRunOptions {
  /** 测试 — 覆盖 universe */
  universe_override?: string[];
  /** 测试 — 覆盖 now */
  now?: Date;
  /** 测试 / CLI — 不落表 / 不推送 (默认 true: detector 本身不写库, 但留扩展位) */
  dry_run?: boolean;
}

export interface ReversalRunResult {
  ok: boolean;
  scanned: number;
  by_type: Record<ReversalSignalType, number>;
  hits: ReversalHit[];
  errors: Array<{ where: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// DataSource (DI seam)
// ---------------------------------------------------------------------------

export interface ReversalDataSource {
  listPositionSymbols(): Promise<string[]>;
  listFavoriteSymbols(): Promise<string[]>;
  listAIRecommendedSymbols(sinceDays: number): Promise<string[]>;
  /** 拉一只 stock 最近 N 天的 daily_bars (asc 排序) */
  listDailyBars(symbol: string, lookbackDays: number): Promise<ReversalDailyBar[]>;
  /** 给定 symbol set, 一次性查 name (用于显示) */
  resolveStockNames(symbols: string[]): Promise<Map<string, string>>;
}

// ---------------------------------------------------------------------------
// Pure helpers (全 export 单测)
// ---------------------------------------------------------------------------

/**
 * RSI(14) — Wilder's smoothing. 给定 close 数组 (asc), 返当前 RSI.
 * 数据不足 (< period + 1) → null.
 */
export function computeRSI(closes: number[], period: number = 14): number | null {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  // 先算 period 个 gain/loss 的 SMA, 再用 Wilder 平滑后续 (n-period-1) 个
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

/**
 * EMA — exponential moving average. 给定数组 (asc), 返末尾值. 不足 period → null.
 */
export function computeEMA(values: number[], period: number): number | null {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  // SMA seed
  let ema = 0;
  for (let i = 0; i < period; i++) ema += values[i];
  ema /= period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * 给定 close 数组 (asc, 日线), 算 N 日"趋势方向" (1 / 0 / -1).
 * 逻辑: 取末 N 日的线性回归斜率 (相对均价的百分比), > +0.1% = 1, < -0.1% = -1, 其它 0.
 * 数据不足 → 0.
 */
export function computeTrendDirection(closes: number[], lookbackDays: number): 1 | 0 | -1 {
  if (!Array.isArray(closes) || closes.length < lookbackDays || lookbackDays < 2) return 0;
  const slice = closes.slice(closes.length - lookbackDays);
  // 简单线性回归 (x = 0..n-1, y = close), 斜率
  const n = slice.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += slice[i];
    sumXY += i * slice[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const meanY = sumY / n;
  if (meanY === 0) return 0;
  const slopePct = (slope / meanY) * 100; // 每天涨幅 %
  if (slopePct > 0.1) return 1;
  if (slopePct < -0.1) return -1;
  return 0;
}

/**
 * Reversal Buy 判定 — 今日跌 < -3% AND 周/月线趋势仍向上.
 * 返 confidence 0-100; 不触发返 0.
 *   - 跌幅越深 confidence 越高 (-3% = 50, -5% = 70, -7%+ = 80)
 *   - 周线 + 月线都向上 = +15, 只一个向上 = +5
 */
export function evaluateReversalBuy(
  todayChangePct: number,
  weeklyTrend: 1 | 0 | -1,
  monthlyTrend: 1 | 0 | -1
): { triggered: boolean; confidence: number } {
  if (!Number.isFinite(todayChangePct)) return { triggered: false, confidence: 0 };
  if (todayChangePct >= -3) return { triggered: false, confidence: 0 };
  // 中线趋势必须仍向上 (周或月任一向上)
  if (weeklyTrend <= 0 && monthlyTrend <= 0) return { triggered: false, confidence: 0 };
  let conf = 50;
  if (todayChangePct <= -7) conf = 80;
  else if (todayChangePct <= -5) conf = 70;
  else if (todayChangePct <= -4) conf = 60;
  if (weeklyTrend > 0 && monthlyTrend > 0) conf += 15;
  else if (weeklyTrend > 0 || monthlyTrend > 0) conf += 5;
  conf = Math.min(95, Math.max(0, conf));
  return { triggered: true, confidence: conf };
}

/**
 * Reversal Sell 判定 — 今日涨 > +5% AND RSI > 70.
 * 返 confidence 0-100.
 *   - 涨幅越大 confidence 越高 (+5% = 50, +7% = 65, +9.5% 涨停附近 = 80)
 *   - RSI 70-80 = +10, > 80 = +20
 */
export function evaluateReversalSell(
  todayChangePct: number,
  rsi14: number | null
): { triggered: boolean; confidence: number } {
  if (!Number.isFinite(todayChangePct)) return { triggered: false, confidence: 0 };
  if (todayChangePct <= 5) return { triggered: false, confidence: 0 };
  if (rsi14 == null || !Number.isFinite(rsi14)) return { triggered: false, confidence: 0 };
  if (rsi14 <= 70) return { triggered: false, confidence: 0 };
  let conf = 50;
  if (todayChangePct >= 9.5) conf = 80;
  else if (todayChangePct >= 7) conf = 65;
  else if (todayChangePct >= 6) conf = 58;
  if (rsi14 > 80) conf += 20;
  else conf += 10;
  conf = Math.min(95, Math.max(0, conf));
  return { triggered: true, confidence: conf };
}

/**
 * 给定一只 stock 的 daily_bars (asc, ≥ 30 根), 跑两个 detector. 返 hit 数组 (0/1/2 条).
 * 数据不足直接返 []. 不依赖 DataSource — 纯函数, 单测覆盖.
 */
export function evaluateStockReversal(
  symbol: string,
  stockName: string | null | undefined,
  bars: ReversalDailyBar[]
): ReversalHit[] {
  if (!Array.isArray(bars) || bars.length < 30) return [];
  const last = bars[bars.length - 1];
  if (!last) return [];
  const closes = bars.map(b => Number(b.close)).filter(v => Number.isFinite(v));
  if (closes.length < 30) return [];
  let todayChange: number;
  if (last.change_percent != null && Number.isFinite(Number(last.change_percent))) {
    todayChange = Number(last.change_percent);
  } else if (bars.length >= 2) {
    const prev = bars[bars.length - 2].close;
    todayChange = prev > 0 ? ((last.close - prev) / prev) * 100 : 0;
  } else {
    todayChange = 0;
  }
  // 周线趋势: 10 个交易日 (~2 周) close 趋势
  const weeklyTrend = computeTrendDirection(closes, 10);
  // 月线趋势: 30 个交易日 (~6 周, 学界常用 month trend ≈ 20 trading days,
  // 这里 30 给更稳健的 "短期超跌 vs 中线趋势" 区分)
  const monthlyTrend = computeTrendDirection(closes, 30);
  const rsi = computeRSI(closes, 14);

  const hits: ReversalHit[] = [];

  // Buy 判定
  const buyEval = evaluateReversalBuy(todayChange, weeklyTrend, monthlyTrend);
  if (buyEval.triggered) {
    hits.push({
      symbol,
      stock_name: stockName ?? null,
      signal_type: 'reversal_buy',
      signal_label: REVERSAL_SIGNAL_LABELS.reversal_buy,
      confidence: buyEval.confidence,
      reason: `今日跌 ${todayChange.toFixed(2)}% 短期超跌; 周线趋势${weeklyTrend > 0 ? '向上' : weeklyTrend < 0 ? '向下' : '持平'}, 月线趋势${monthlyTrend > 0 ? '向上' : monthlyTrend < 0 ? '向下' : '持平'}; A 股 T+1 反转高概率 (Hsu/Viswanathan 2018 JPM)`,
      today_change_pct: Math.round(todayChange * 100) / 100,
      rsi14: rsi,
      weekly_trend: weeklyTrend,
      monthly_trend: monthlyTrend,
      source_payload: {
        today_close: last.close,
        today_low: last.low,
        bars_count: bars.length,
      },
    });
  }

  // Sell 判定
  const sellEval = evaluateReversalSell(todayChange, rsi);
  if (sellEval.triggered) {
    hits.push({
      symbol,
      stock_name: stockName ?? null,
      signal_type: 'reversal_sell',
      signal_label: REVERSAL_SIGNAL_LABELS.reversal_sell,
      confidence: sellEval.confidence,
      reason: `今日涨 ${todayChange.toFixed(2)}% 短期超买; RSI(14)=${rsi?.toFixed(1)}; 回调高概率 (Zhang & Zhu 2024 IREF)`,
      today_change_pct: Math.round(todayChange * 100) / 100,
      rsi14: rsi,
      weekly_trend: weeklyTrend,
      monthly_trend: monthlyTrend,
      source_payload: {
        today_close: last.close,
        today_high: last.high,
        bars_count: bars.length,
      },
    });
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Production DataSource (lazy require)
// ---------------------------------------------------------------------------

class DefaultReversalDataSource implements ReversalDataSource {
  async listPositionSymbols(): Promise<string[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPosition } = require('../models/PaperTradingPosition');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const rows: any[] = await PaperTradingPosition.findAll({
        attributes: ['symbol'],
        where: { quantity: { [Op.gt]: 0 } },
        group: ['symbol'],
        raw: true,
      });
      return (rows || []).map(r => String((r as any)?.symbol || '').trim()).filter(Boolean);
    } catch (e: any) {
      logger.warn(`[IntradayReversalDetector] listPositionSymbols failed: ${e?.message || e}`);
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
      logger.warn(`[IntradayReversalDetector] listFavoriteSymbols failed: ${e?.message || e}`);
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
      const rows: any[] = await AIInvestmentSignal.findAll({
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
      logger.warn(`[IntradayReversalDetector] listAIRecommendedSymbols failed: ${e?.message || e}`);
      return [];
    }
  }

  async listDailyBars(symbol: string, lookbackDays: number): Promise<ReversalDailyBar[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../models/DailyBar');
      const stock: any = await Stock.findOne({ where: { symbol }, raw: true });
      if (!stock) return [];
      const rows: any[] = await DailyBar.findAll({
        attributes: ['time', 'open', 'high', 'low', 'close', 'change_percent'],
        where: { stock_id: stock.id },
        order: [['time', 'DESC']],
        limit: lookbackDays,
        raw: true,
      });
      return (rows || [])
        .map((r: any) => ({
          time: typeof r.time === 'string' ? r.time : new Date(r.time).toISOString().slice(0, 10),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          change_percent: r.change_percent == null ? null : Number(r.change_percent),
        }))
        .reverse(); // 改 asc
    } catch (e: any) {
      logger.warn(`[IntradayReversalDetector] listDailyBars(${symbol}) failed: ${e?.message || e}`);
      return [];
    }
  }

  async resolveStockNames(symbols: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!symbols || symbols.length === 0) return out;
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
        if (r.symbol && r.name) out.set(String(r.symbol), String(r.name));
      }
    } catch (e: any) {
      logger.warn(`[IntradayReversalDetector] resolveStockNames failed: ${e?.message || e}`);
    }
    return out;
  }
}

export const DEFAULT_REVERSAL_DATA_SOURCE: ReversalDataSource = new DefaultReversalDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const AI_REC_LOOKBACK_DAYS = 30;
const DAILY_BARS_LOOKBACK = 60; // 60 个交易日, 够算 RSI + 30 日 trend + 余量
const UNIVERSE_HARD_CAP = 1500;

export interface IntradayReversalDetectorDeps {
  dataSource?: ReversalDataSource;
}

export class IntradayReversalDetector {
  private readonly ds: ReversalDataSource;

  constructor(deps: IntradayReversalDetectorDeps = {}) {
    this.ds = deps.dataSource ?? DEFAULT_REVERSAL_DATA_SOURCE;
  }

  /** 主入口. 整次永不 throw — 失败计入 result.errors. */
  async runOnce(options: ReversalRunOptions = {}): Promise<ReversalRunResult> {
    const result: ReversalRunResult = {
      ok: true,
      scanned: 0,
      by_type: { reversal_buy: 0, reversal_sell: 0 },
      hits: [],
      errors: [],
    };

    // Step 1: build universe
    let universe: string[] = [];
    try {
      universe = options.universe_override
        ? options.universe_override.map(s => normalizeSymbol(String(s || '').trim())).filter(Boolean)
        : await this.buildUniverse();
    } catch (e: any) {
      result.errors.push({ where: 'build_universe', reason: e?.message || String(e) });
      result.ok = false;
      return result;
    }
    if (universe.length === 0) {
      logger.info('[IntradayReversalDetector] universe is empty');
      return result;
    }
    result.scanned = universe.length;

    // Step 2: resolve names (batch)
    let nameMap = new Map<string, string>();
    try {
      nameMap = await this.ds.resolveStockNames(universe);
    } catch (e: any) {
      result.errors.push({ where: 'resolve_names', reason: e?.message || String(e) });
    }

    // Step 3: per-stock detector (sequential to avoid DB pool exhaustion)
    for (const symbol of universe) {
      try {
        const bars = await this.ds.listDailyBars(symbol, DAILY_BARS_LOOKBACK);
        if (!bars || bars.length < 30) continue;
        const hits = evaluateStockReversal(symbol, nameMap.get(symbol), bars);
        for (const h of hits) {
          result.hits.push(h);
          result.by_type[h.signal_type] = (result.by_type[h.signal_type] || 0) + 1;
        }
      } catch (e: any) {
        result.errors.push({
          where: `stock:${symbol}`,
          reason: e?.message || String(e),
        });
      }
    }

    return result;
  }

  private async buildUniverse(): Promise<string[]> {
    const bag = new Set<string>();
    const add = (s: string) => {
      const n = normalizeSymbol(String(s || '').trim());
      if (n) bag.add(n);
    };
    try {
      (await this.ds.listPositionSymbols()).forEach(add);
    } catch (e: any) {
      logger.warn(`[IntradayReversalDetector] universe positions failed: ${e?.message || e}`);
    }
    try {
      (await this.ds.listFavoriteSymbols()).forEach(add);
    } catch (e: any) {
      logger.warn(`[IntradayReversalDetector] universe favorites failed: ${e?.message || e}`);
    }
    try {
      (await this.ds.listAIRecommendedSymbols(AI_REC_LOOKBACK_DAYS)).forEach(add);
    } catch (e: any) {
      logger.warn(`[IntradayReversalDetector] universe AI rec failed: ${e?.message || e}`);
    }
    if (bag.size > UNIVERSE_HARD_CAP) {
      const trunc: string[] = [];
      let i = 0;
      for (const s of bag) {
        if (i++ >= UNIVERSE_HARD_CAP) break;
        trunc.push(s);
      }
      return trunc;
    }
    return Array.from(bag);
  }
}

export const intradayReversalDetector = new IntradayReversalDetector();
