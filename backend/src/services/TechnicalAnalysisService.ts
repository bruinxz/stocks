import { Op } from 'sequelize';
import { TechnicalAnalysisReport } from '../models/TechnicalAnalysisReport';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { sma, ema, rsi, macd, bollinger } from '../quant/engine/QuantMath';
import { normalizeSymbol } from '../utils/stockSymbol';
import { logger } from '../utils/logger';

const TRADING_AGENTS_URL = process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000';

/**
 * TechnicalAnalysisService — US-061 AI 大模型技术面 K 线解读.
 *
 * 给定 `(stock_code, lookback_days)` 拉取近 N 个交易日的 OHLCV，本地预算 MACD /
 * RSI / 布林带 / 量比，把 "近期 K 线 + 指标快照" 喂给 TradingAgents AI 远端，
 * 解析出趋势 / 支撑位 / 压力位 / 买卖区间 / 总览 / 置信。结果以 24h TTL 缓存进
 * `technical_analysis_reports` 表，同 (stock_code, lookback_days) 24h 内重复请
 * 求直接返回缓存（`from_cache=true`），避免重复调用 TradingAgents。
 *
 * **核心契约**:
 *   - `buildIndicatorContext(bars)` → IndicatorContext (pure, 无 DB);
 *   - `parseRemoteAnalysis(payload, ctx)` → TechnicalAnalysisResult (pure);
 *   - `buildHeuristicFallback(ctx)` → 兜底 result (远端失败时启发式产出);
 *   - `formatSummary(...)` → markdown 总览拼装 (pure);
 *   - `analyze(stockCode, lookbackDays, options)` → 缓存命中或新生成;
 *   - `findActiveCache(stock_code, lookback_days)` → 读端 (controller 直接调).
 *
 * **6 项 AI feature checklist** (US-055 范式同款):
 *   1. **DataSource DI** — `TechnicalAnalysisDataSource` 接口暴露 5 个方法
 *      (loadBars / resolveStockName / callRemoteAnalyze / saveReport /
 *      findActiveCache); `DefaultTechnicalAnalysisDataSource` 走 Sequelize +
 *      TradingAgents axios; 生产 `PRODUCTION_TECHNICAL_ANALYSIS_DATA_SOURCE`
 *      singleton; 单测注入 fake.
 *   2. **pure helpers 全 export** — buildIndicatorContext / parseRemoteAnalysis /
 *      buildHeuristicFallback / formatSummary / normalizeLookbackDays /
 *      isCacheActive / clampConfidence / extractLastValues.
 *   3. **plain-object 返回类型** `TechnicalAnalysisResult` 兼容 from_cache /
 *      dry_run / persist=false / 失败 fallback 5 种路径.
 *   4. **status='partial' / 'failed' 仍 persist** — 启发式 fallback 当 status=
 *      'partial' 写库, 让 UI 知道 "AI 远端失败但有兜底结果" 而非显示 "尚未生成".
 *   5. **fail-OPEN on saveReport** — DB 写失败 warn + log + 返回结果不抛错.
 *   6. **双重防御 try/catch** — DataSource 内 callRemoteAnalyze 失败转 FAILED
 *      payload 不抛; service.analyze 仍外层 try/catch 处理 unexpected throw.
 *
 * **AI vs 启发式 fallback 分工** (与 AnnouncementNLPService 同款):
 *   - 默认调 TradingAgents `/api/nlp-technical-analysis` 远端 (AC 指定);
 *   - 远端 throw / FAILED → 启发式兜底 (近 N 日高低 + 当前 RSI/MACD 简单判趋势);
 *   - 兜底走 `buildHeuristicFallback` 给出可用解读, nlp_engine='heuristic_fallback'.
 *
 * **24h TTL 缓存判定**:
 *   - 读端: `findActiveCache(stock_code, lookback_days)` 返回 expires_at > now() 的最新行;
 *   - 写端: 新生成时 expires_at = generated_at + 24h;
 *   - **每次 cache miss 写新行不 update 旧行** — 旧行作为历史快照供回查;
 *   - `force_refresh=true` 强制跳过 cache 重新生成 (UI 刷新按钮触发).
 *
 * **指标计算**:
 *   - MACD(12, 26, 9) / RSI(14) / 布林(20, 2σ) — 都用 quant/engine/QuantMath 已有实现;
 *   - 量比 = 当日 volume / 近 5 日 volume avg;
 *   - 复用 QuantMath 保持 backtest / strategies / AI 解读三处指标口径一致.
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 趋势分类 (AC 要求 trend 字段) */
export const TREND_LABELS = Object.freeze({
  UPTREND: 'uptrend' as const,
  DOWNTREND: 'downtrend' as const,
  SIDEWAYS: 'sideways' as const,
  BREAKOUT: 'breakout' as const,
  REVERSAL: 'reversal' as const,
  UNKNOWN: 'unknown' as const,
});

export type TrendLabel =
  | typeof TREND_LABELS.UPTREND
  | typeof TREND_LABELS.DOWNTREND
  | typeof TREND_LABELS.SIDEWAYS
  | typeof TREND_LABELS.BREAKOUT
  | typeof TREND_LABELS.REVERSAL
  | typeof TREND_LABELS.UNKNOWN;

/** NLP 引擎标签 (写入 model.nlp_engine 列) */
export const NLP_ENGINES = Object.freeze({
  TRADING_AGENTS: 'trading_agents' as const,
  HEURISTIC: 'heuristic_fallback' as const,
  OPENAI: 'openai' as const,
});

/** 默认 lookback_days (60 日 ≈ 3 个月 K 线，覆盖 MACD 26+9 与布林 20 的最小窗口) */
export const DEFAULT_LOOKBACK_DAYS = 60;
/** lookback_days 下限 (布林 20 + 5 个观测兜底) */
export const MIN_LOOKBACK_DAYS = 20;
/** lookback_days 上限 (远端 prompt 长度 + 算力考虑) */
export const MAX_LOOKBACK_DAYS = 250;
/** 24h 缓存 TTL 毫秒 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 默认 axios timeout (远端模型响应较慢) */
export const REMOTE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单根 K 线 (与 DailyBar 字段对齐) */
export interface OHLCVBar {
  time: Date | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number | null;
}

/** 指标 context — 喂给 AI 远端 + 兜底启发式都依赖的中间结构 */
export interface IndicatorContext {
  bars: OHLCVBar[];
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  last_close: number;
  last_open: number;
  last_high: number;
  last_low: number;
  last_volume: number;
  /** 量比 = 当日 volume / 近 5 日 volume avg (无 5 日数据 → null) */
  vol_ratio: number | null;
  /** RSI(14) 当前值 (数据不足 → null) */
  last_rsi: number | null;
  /** MACD(12,26,9) 当前 dif / dea / hist (数据不足 → null) */
  last_macd: { dif: number; dea: number; hist: number } | null;
  /** 布林(20,2σ) 当前 mid/upper/lower (数据不足 → null) */
  last_bbands: { middle: number; upper: number; lower: number } | null;
  /** 近 N 日最高价 (供 AI 参考) */
  recent_high: number;
  /** 近 N 日最低价 (供 AI 参考) */
  recent_low: number;
  /** N 日动量 = (last_close - first_close) / first_close (无 first → null) */
  momentum_pct: number | null;
}

/** 远端 AI payload (TradingAgents /api/nlp-technical-analysis 占位) */
export interface RemoteTechnicalAnalysisPayload {
  status?: string;
  task_id?: string;
  data?: {
    trend?: string;
    support_levels?: number[];
    resistance_levels?: number[];
    buy_zone?: number[];
    sell_zone?: number[];
    summary?: string;
    confidence?: number;
    confidence_score?: number;
    error?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** plain-object 返回类型 — persist=true/false / from_cache 三种路径都返回同一形态 */
export interface TechnicalAnalysisResult {
  stock_code: string;
  stock_name: string | null;
  lookback_days: number;
  trend: TrendLabel;
  support_levels: number[];
  resistance_levels: number[];
  buy_zone: number[];
  sell_zone: number[];
  summary: string;
  confidence: number | null;
  status: 'completed' | 'partial' | 'failed';
  nlp_engine: string;
  indicators_snapshot: Record<string, unknown>;
  error: string | null;
  generated_at: string; // ISO timestamp
  expires_at: string; // ISO timestamp
  metadata: Record<string, unknown>;
  /** True iff served from existing cache (从 findActiveCache 命中) */
  from_cache: boolean;
  /** True iff 写表成功 (false = dry_run / fail-OPEN / from_cache) */
  persisted: boolean;
}

export interface AnalyzeOptions {
  /** 强制刷新跳过缓存 (UI 刷新按钮) */
  force_refresh?: boolean;
  /** dry_run=true 不写表 (前端预览) */
  dry_run?: boolean;
  /** 已知股票名称 (避免 DataSource resolveStockName 多查一次) */
  stock_name?: string;
  /** 触发用户 ID (cron / system 触发可省略) */
  user_id?: number;
  /** 任务来源标签 (写入 metadata.task_label, ops 区分入口) */
  task_label?: string;
  /** 显式指定生成时间 (单测稳定化用) */
  now?: Date;
}

// ---------------------------------------------------------------------------
// DataSource 注入接口
// ---------------------------------------------------------------------------

export interface TechnicalAnalysisDataSource {
  /** 拉近 N 个交易日的 OHLCV (按 time 升序) */
  loadBars(stockCode: string, lookbackDays: number): Promise<OHLCVBar[]>;
  /** 反查股票名称 (落表 snapshot 用); 返回 null 表示未找到 */
  resolveStockName(stockCode: string): Promise<string | null>;
  /** 远端 TradingAgents 调用; 失败时返回 status=FAILED 不抛 */
  callRemoteAnalyze(
    stockCode: string,
    ctx: IndicatorContext,
    lookbackDays: number
  ): Promise<RemoteTechnicalAnalysisPayload>;
  /** 24h TTL 缓存读 (expires_at > now); 返回最新一行或 null */
  findActiveCache(
    stockCode: string,
    lookbackDays: number,
    now: Date
  ): Promise<TechnicalAnalysisReport | null>;
  /** 写入新行 (cache miss 时新建, 不 update 旧行) */
  saveReport(record: TechnicalAnalysisResult): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default production DataSource
// ---------------------------------------------------------------------------

export class DefaultTechnicalAnalysisDataSource implements TechnicalAnalysisDataSource {
  async loadBars(stockCode: string, lookbackDays: number): Promise<OHLCVBar[]> {
    try {
      const stock = await Stock.findOne({
        where: { symbol: stockCode },
        attributes: ['id'],
      });
      if (!stock) return [];
      // 自然日窗口的 1.5x 兜底周末/节假日；上限再 +5 防边界舍入
      const calendarDays = Math.ceil(lookbackDays * 1.5) + 5;
      const since = new Date(Date.now() - calendarDays * 24 * 60 * 60 * 1000);
      const bars = await DailyBar.findAll({
        where: {
          stock_id: stock.id,
          time: { [Op.gte]: since },
        },
        order: [['time', 'ASC']],
      });
      return bars.map(bar => ({
        time: bar.time,
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: Number(bar.volume),
        turnover: bar.turnover === undefined || bar.turnover === null ? null : Number(bar.turnover),
      }));
    } catch (err: any) {
      logger.warn(`TechnicalAnalysis.loadBars(${stockCode}) failed: ${err.message}`);
      return [];
    }
  }

  async resolveStockName(stockCode: string): Promise<string | null> {
    try {
      const stock = await Stock.findOne({
        where: { symbol: stockCode },
        attributes: ['name'],
      });
      return stock?.name || null;
    } catch (err: any) {
      logger.warn(`TechnicalAnalysis.resolveStockName(${stockCode}) failed: ${err.message}`);
      return null;
    }
  }

  async callRemoteAnalyze(
    stockCode: string,
    ctx: IndicatorContext,
    lookbackDays: number
  ): Promise<RemoteTechnicalAnalysisPayload> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const axios = require('axios');
    try {
      const response = await axios.post(
        `${TRADING_AGENTS_URL}/api/nlp-technical-analysis`,
        {
          stock_code: stockCode,
          lookback_days: lookbackDays,
          last_close: ctx.last_close,
          recent_high: ctx.recent_high,
          recent_low: ctx.recent_low,
          last_rsi: ctx.last_rsi,
          last_macd: ctx.last_macd,
          last_bbands: ctx.last_bbands,
          vol_ratio: ctx.vol_ratio,
          momentum_pct: ctx.momentum_pct,
          // 限制喂入 K 线数量, 远端 prompt 长度可控 (最多最近 60 根)
          bars: ctx.bars.slice(-60).map(b => ({
            time: typeof b.time === 'string' ? b.time : b.time.toISOString(),
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          })),
        },
        { timeout: REMOTE_TIMEOUT_MS }
      );
      return response.data;
    } catch (error: any) {
      const message = error?.response?.data?.detail || error?.message || String(error);
      logger.warn(`TechnicalAnalysis.callRemoteAnalyze(${stockCode}) failed: ${message}`);
      return { status: 'FAILED', data: { error: message } };
    }
  }

  async findActiveCache(
    stockCode: string,
    lookbackDays: number,
    now: Date
  ): Promise<TechnicalAnalysisReport | null> {
    try {
      const row = await TechnicalAnalysisReport.findOne({
        where: {
          stock_code: stockCode,
          lookback_days: lookbackDays,
          expires_at: { [Op.gt]: now },
        },
        order: [['generated_at', 'DESC']],
      });
      return row || null;
    } catch (err: any) {
      logger.warn(
        `TechnicalAnalysis.findActiveCache(${stockCode}, ${lookbackDays}) failed: ${err.message}`
      );
      return null;
    }
  }

  async saveReport(record: TechnicalAnalysisResult): Promise<void> {
    await TechnicalAnalysisReport.create({
      stock_code: record.stock_code,
      stock_name: record.stock_name,
      lookback_days: record.lookback_days,
      trend: record.trend,
      support_levels: record.support_levels,
      resistance_levels: record.resistance_levels,
      buy_zone: record.buy_zone,
      sell_zone: record.sell_zone,
      summary: record.summary,
      confidence: record.confidence,
      status: record.status,
      nlp_engine: record.nlp_engine,
      indicators_snapshot: record.indicators_snapshot,
      error: record.error,
      generated_at: new Date(record.generated_at),
      expires_at: new Date(record.expires_at),
      metadata: record.metadata,
    } as any);
  }
}

export const PRODUCTION_TECHNICAL_ANALYSIS_DATA_SOURCE: TechnicalAnalysisDataSource =
  new DefaultTechnicalAnalysisDataSource();

// ---------------------------------------------------------------------------
// Pure helpers (export for unit tests — no DB / no axios)
// ---------------------------------------------------------------------------

/**
 * 净化 lookback_days 入参 (沉默退回默认而不 4xx, 与 normalizeXxxConfig 一致):
 * - undefined / NaN / < MIN → DEFAULT_LOOKBACK_DAYS (60);
 * - > MAX → MAX_LOOKBACK_DAYS (250);
 * - 浮点数 → Math.floor.
 */
export function normalizeLookbackDays(raw: any): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOOKBACK_DAYS;
  const floored = Math.floor(n);
  if (floored < MIN_LOOKBACK_DAYS) return DEFAULT_LOOKBACK_DAYS;
  if (floored > MAX_LOOKBACK_DAYS) return MAX_LOOKBACK_DAYS;
  return floored;
}

/**
 * 0-100 clamp + 非有限值 → null.
 *
 * AI 远端 confidence 可能传 0.85 (0-1 浮点) 或 85 (0-100)；这里只 clamp 不缩放，
 * 调用方 (parseRemoteAnalysis) 自己负责 *100 转换若小于 1.
 */
export function clampConfidence(raw: any): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * 提取价格数组最后 N 个有限值的尾值 (避免 NaN/Infinity 污染).
 */
export function extractLastValues(arr: number[], n = 1): number[] {
  if (!Array.isArray(arr) || arr.length === 0 || n <= 0) return [];
  const filtered = arr.filter(v => Number.isFinite(v));
  if (filtered.length === 0) return [];
  return filtered.slice(-n);
}

/**
 * 构造 IndicatorContext — 把原始 bars 折叠成 AI 提示所需的指标快照.
 *
 * - bars 不足 14 根 (RSI 最低要求) → last_rsi=null;
 * - bars 不足 26 根 (MACD slow) → last_macd=null;
 * - bars 不足 20 根 (布林) → last_bbands=null;
 * - bars 不足 6 根 → vol_ratio=null (5 日均 + 当日);
 * - 调用方应保证 bars >= MIN_LOOKBACK_DAYS, 但 helper 自身容错.
 */
export function buildIndicatorContext(bars: OHLCVBar[]): IndicatorContext {
  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      bars: [],
      closes: [],
      highs: [],
      lows: [],
      volumes: [],
      last_close: 0,
      last_open: 0,
      last_high: 0,
      last_low: 0,
      last_volume: 0,
      vol_ratio: null,
      last_rsi: null,
      last_macd: null,
      last_bbands: null,
      recent_high: 0,
      recent_low: 0,
      momentum_pct: null,
    };
  }

  const closes = bars.map(b => Number(b.close)).filter(Number.isFinite);
  const highs = bars.map(b => Number(b.high)).filter(Number.isFinite);
  const lows = bars.map(b => Number(b.low)).filter(Number.isFinite);
  const volumes = bars.map(b => Number(b.volume)).filter(Number.isFinite);
  const last = bars[bars.length - 1];

  const last_close = Number(last.close) || 0;
  const last_open = Number(last.open) || 0;
  const last_high = Number(last.high) || 0;
  const last_low = Number(last.low) || 0;
  const last_volume = Number(last.volume) || 0;

  // 量比 = 当日 / 近 5 日 avg (排除当日)
  let vol_ratio: number | null = null;
  if (volumes.length >= 6 && last_volume > 0) {
    const prev5 = volumes.slice(-6, -1);
    const sum5 = prev5.reduce((a, b) => a + b, 0);
    const avg5 = sum5 / prev5.length;
    if (avg5 > 0) vol_ratio = Math.round((last_volume / avg5) * 1000) / 1000;
  }

  // RSI(14)
  let last_rsi: number | null = null;
  if (closes.length >= 15) {
    const series = rsi(closes, 14);
    const tail = extractLastValues(series, 1);
    if (tail.length === 1) last_rsi = Math.round(tail[0] * 100) / 100;
  }

  // MACD(12, 26, 9)
  let last_macd: { dif: number; dea: number; hist: number } | null = null;
  if (closes.length >= 35) {
    const { dif, dea, histogram } = macd(closes, 12, 26, 9);
    if (dif.length > 0 && dea.length > 0 && histogram.length > 0) {
      const lastDif = dif[dif.length - 1];
      const lastDea = dea[dea.length - 1];
      const lastHist = histogram[histogram.length - 1];
      if (Number.isFinite(lastDif) && Number.isFinite(lastDea) && Number.isFinite(lastHist)) {
        last_macd = {
          dif: Math.round(lastDif * 10000) / 10000,
          dea: Math.round(lastDea * 10000) / 10000,
          hist: Math.round(lastHist * 10000) / 10000,
        };
      }
    }
  }

  // 布林(20, 2σ)
  let last_bbands: { middle: number; upper: number; lower: number } | null = null;
  if (closes.length >= 20) {
    const { middle, upper, lower } = bollinger(closes, 20, 2);
    if (middle.length > 0 && upper.length > 0 && lower.length > 0) {
      const m = middle[middle.length - 1];
      const u = upper[upper.length - 1];
      const l = lower[lower.length - 1];
      if (Number.isFinite(m) && Number.isFinite(u) && Number.isFinite(l)) {
        last_bbands = {
          middle: Math.round(m * 10000) / 10000,
          upper: Math.round(u * 10000) / 10000,
          lower: Math.round(l * 10000) / 10000,
        };
      }
    }
  }

  const recent_high = highs.length > 0 ? Math.max(...highs) : 0;
  const recent_low = lows.length > 0 ? Math.min(...lows) : 0;

  let momentum_pct: number | null = null;
  if (closes.length >= 2 && closes[0] > 0) {
    momentum_pct = Math.round(((last_close - closes[0]) / closes[0]) * 10000) / 100;
  }

  return {
    bars,
    closes,
    highs,
    lows,
    volumes,
    last_close,
    last_open,
    last_high,
    last_low,
    last_volume,
    vol_ratio,
    last_rsi,
    last_macd,
    last_bbands,
    recent_high,
    recent_low,
    momentum_pct,
  };
}

/**
 * 规范化 trend 字符串 (AI 远端可能返回 'UPTREND' / 'uptrend' / '上升' / '上涨趋势').
 */
export function normalizeTrend(raw: unknown): TrendLabel {
  if (!raw) return TREND_LABELS.UNKNOWN;
  const text = String(raw).trim().toLowerCase();
  if (!text) return TREND_LABELS.UNKNOWN;

  // 英文
  if (text.includes('uptrend') || text.includes('bull') || text.includes('rising')) {
    return TREND_LABELS.UPTREND;
  }
  if (text.includes('downtrend') || text.includes('bear') || text.includes('falling')) {
    return TREND_LABELS.DOWNTREND;
  }
  if (text.includes('sideways') || text.includes('range') || text.includes('flat')) {
    return TREND_LABELS.SIDEWAYS;
  }
  if (text.includes('breakout') || text.includes('break')) return TREND_LABELS.BREAKOUT;
  if (text.includes('reversal') || text.includes('reverse')) return TREND_LABELS.REVERSAL;

  // 中文
  if (/上升|上涨|多头|看多/.test(text)) return TREND_LABELS.UPTREND;
  if (/下降|下跌|空头|看空/.test(text)) return TREND_LABELS.DOWNTREND;
  if (/震荡|横盘|盘整/.test(text)) return TREND_LABELS.SIDEWAYS;
  if (/突破/.test(text)) return TREND_LABELS.BREAKOUT;
  if (/反转|反弹|超卖|超买/.test(text)) return TREND_LABELS.REVERSAL;

  return TREND_LABELS.UNKNOWN;
}

/**
 * 把"价格数组"规范化为升序/降序的纯数字数组 (过滤 NaN / 非有限 / 重复).
 *
 * - support_levels 期望递减 (最高支撑在前);
 * - resistance_levels 期望递增 (最近压力在前);
 * - max=3 保持 UI 紧凑.
 */
export function normalizePriceArray(
  raw: unknown,
  options: { ascending: boolean; max?: number }
): number[] {
  const max = options.max ?? 3;
  if (!Array.isArray(raw)) return [];
  const cleaned: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const n = Number(item);
    if (!Number.isFinite(n) || n <= 0) continue;
    const rounded = Math.round(n * 100) / 100;
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    cleaned.push(rounded);
  }
  cleaned.sort((a, b) => (options.ascending ? a - b : b - a));
  return cleaned.slice(0, max);
}

/**
 * 把"区间"规范化为 [low, high] 两元素数组.
 *
 * - 空 / 非数组 / 长度 < 2 → [];
 * - 不保证 low < high → 自动 sort;
 * - 非有限或非正数 → [].
 */
export function normalizePriceZone(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const a = Number(raw[0]);
  const b = Number(raw[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return [];
  const low = Math.round(Math.min(a, b) * 100) / 100;
  const high = Math.round(Math.max(a, b) * 100) / 100;
  return [low, high];
}

/**
 * 解析 TradingAgents 原始 payload → TechnicalAnalysisResult 字段子集.
 *
 * - status='FAILED' / 缺 data → 返回 null (caller 走 heuristic fallback);
 * - confidence < 1 视为 0-1 浮点, 乘 100 转 0-100 整数;
 * - support / resistance / zones 走 normalize* 净化非数字.
 */
export function parseRemoteAnalysis(payload: RemoteTechnicalAnalysisPayload): {
  trend: TrendLabel;
  support_levels: number[];
  resistance_levels: number[];
  buy_zone: number[];
  sell_zone: number[];
  summary: string;
  confidence: number | null;
} | null {
  const statusRaw = String(payload?.status || '').toUpperCase();
  const data = payload?.data;
  if (statusRaw === 'FAILED' || !data) return null;

  const trend = normalizeTrend(data.trend);
  const support_levels = normalizePriceArray(data.support_levels, { ascending: false, max: 3 });
  const resistance_levels = normalizePriceArray(data.resistance_levels, {
    ascending: true,
    max: 3,
  });
  const buy_zone = normalizePriceZone(data.buy_zone);
  const sell_zone = normalizePriceZone(data.sell_zone);
  const summary =
    typeof data.summary === 'string' && data.summary.trim().length > 0 ? data.summary.trim() : '';

  // confidence 可能是 0-1 浮点或 0-100; clamp 后若 <= 1 视为浮点 *100
  const rawConf =
    typeof data.confidence === 'number' && Number.isFinite(data.confidence)
      ? data.confidence
      : typeof data.confidence_score === 'number' && Number.isFinite(data.confidence_score)
      ? data.confidence_score
      : null;
  let confidence: number | null = null;
  if (rawConf !== null) {
    const scaled = rawConf > 0 && rawConf <= 1 ? rawConf * 100 : rawConf;
    confidence = clampConfidence(scaled);
  }

  return { trend, support_levels, resistance_levels, buy_zone, sell_zone, summary, confidence };
}

/**
 * 启发式 fallback — 远端失败时基于指标 ctx 给出最低限度可用解读.
 *
 * 规则 (与 LeftSideReversal / BreakoutStrategy 等同款方向判定):
 *   - trend: 优先 MACD hist + 布林 mid 判定方向; 一致 → 强信号;
 *     不一致 / 缺数据 → 用 N 日 momentum_pct 兜底 (> +5% 上升 / < -5% 下降).
 *     **momentum_pct 兜底很重要**: MACD 在长期单边行情末段 hist 可能反弹(收敛),
 *     此时 close 仍远在 middle 下方; 单看 MACD 会误判 sideways. 用 momentum 校正.
 *   - support_levels: 最近 20 日最低价 + 布林下轨 (取最低的两档)
 *   - resistance_levels: 最近 20 日最高价 + 布林上轨
 *   - buy_zone: 围绕布林下轨 [-1%, +1%]
 *   - sell_zone: 围绕布林上轨 [-1%, +1%]
 *   - confidence: 启发式固定 50 (低置信兜底)
 */
export function buildHeuristicFallback(ctx: IndicatorContext): {
  trend: TrendLabel;
  support_levels: number[];
  resistance_levels: number[];
  buy_zone: number[];
  sell_zone: number[];
  summary: string;
  confidence: number;
} {
  // 趋势判定 — 优先 MACD+布林强信号 (相向)
  let trend: TrendLabel = TREND_LABELS.SIDEWAYS;
  let strongSignal = false;
  if (ctx.last_macd && ctx.last_bbands) {
    if (ctx.last_macd.hist > 0 && ctx.last_close > ctx.last_bbands.middle) {
      trend = TREND_LABELS.UPTREND;
      strongSignal = true;
    } else if (ctx.last_macd.hist < 0 && ctx.last_close < ctx.last_bbands.middle) {
      trend = TREND_LABELS.DOWNTREND;
      strongSignal = true;
    }
  }
  // 无强信号 → 用 N 日 momentum 兜底 (覆盖 MACD 末段 hist 反弹但价格仍在下方的场景)
  if (!strongSignal && ctx.momentum_pct !== null) {
    if (ctx.momentum_pct > 5) trend = TREND_LABELS.UPTREND;
    else if (ctx.momentum_pct < -5) trend = TREND_LABELS.DOWNTREND;
  }

  // 支撑位 / 压力位
  const supports: number[] = [];
  const resistances: number[] = [];
  if (ctx.last_bbands) {
    supports.push(ctx.last_bbands.lower);
    resistances.push(ctx.last_bbands.upper);
  }
  if (ctx.recent_low > 0) supports.push(ctx.recent_low);
  if (ctx.recent_high > 0) resistances.push(ctx.recent_high);

  const support_levels = normalizePriceArray(supports, { ascending: false, max: 3 });
  const resistance_levels = normalizePriceArray(resistances, { ascending: true, max: 3 });

  // 买卖区间 (基于布林带或回看高低)
  let buy_zone: number[] = [];
  let sell_zone: number[] = [];
  if (ctx.last_bbands) {
    buy_zone = normalizePriceZone([ctx.last_bbands.lower * 0.99, ctx.last_bbands.lower * 1.01]);
    sell_zone = normalizePriceZone([ctx.last_bbands.upper * 0.99, ctx.last_bbands.upper * 1.01]);
  } else if (ctx.recent_low > 0 && ctx.recent_high > 0) {
    buy_zone = normalizePriceZone([ctx.recent_low * 0.99, ctx.recent_low * 1.02]);
    sell_zone = normalizePriceZone([ctx.recent_high * 0.98, ctx.recent_high * 1.01]);
  }

  const summary = formatHeuristicSummary(ctx, trend, support_levels, resistance_levels);

  return {
    trend,
    support_levels,
    resistance_levels,
    buy_zone,
    sell_zone,
    summary,
    confidence: 50,
  };
}

/**
 * 启发式兜底 markdown 总览拼装 (与 formatSummary 不同，不依赖 AI 返回字符串).
 */
export function formatHeuristicSummary(
  ctx: IndicatorContext,
  trend: TrendLabel,
  supports: number[],
  resistances: number[]
): string {
  const trendLabelMap: Record<TrendLabel, string> = {
    uptrend: '上升趋势',
    downtrend: '下降趋势',
    sideways: '震荡整理',
    breakout: '突破中',
    reversal: '反转迹象',
    unknown: '趋势不明',
  };
  const trendLabel = trendLabelMap[trend];

  const lines: string[] = [];
  lines.push(`**【AI 技术面解读 · 启发式兜底】**`);
  lines.push(`- 趋势：${trendLabel}（基于 MACD 柱与布林带位置）`);
  lines.push(
    `- 最新收盘：${ctx.last_close.toFixed(2)}（近期高 ${ctx.recent_high.toFixed(
      2
    )} / 低 ${ctx.recent_low.toFixed(2)}）`
  );
  if (ctx.last_rsi !== null) {
    const rsiNote = ctx.last_rsi >= 70 ? ' · 超买' : ctx.last_rsi <= 30 ? ' · 超卖' : '';
    lines.push(`- RSI(14)：${ctx.last_rsi.toFixed(2)}${rsiNote}`);
  }
  if (ctx.last_macd) {
    const macdSig = ctx.last_macd.hist >= 0 ? '柱体红' : '柱体绿';
    lines.push(
      `- MACD：DIF ${ctx.last_macd.dif.toFixed(4)} / DEA ${ctx.last_macd.dea.toFixed(
        4
      )} · ${macdSig}`
    );
  }
  if (ctx.vol_ratio !== null) {
    lines.push(`- 量比：${ctx.vol_ratio.toFixed(2)}`);
  }
  if (supports.length > 0) {
    lines.push(`- 支撑位：${supports.map(p => p.toFixed(2)).join(' / ')}`);
  }
  if (resistances.length > 0) {
    lines.push(`- 压力位：${resistances.map(p => p.toFixed(2)).join(' / ')}`);
  }
  lines.push('- 注：AI 远端不可用，本结果为启发式兜底（confidence=50），仅供参考。');
  return lines.join('\n');
}

/**
 * 格式化 AI 完整解读为 markdown 总览 (远端可能只返回纯文字, 这里再补 prefix).
 *
 * - 若 AI 返回的 summary 已经是 markdown, 直接保留;
 * - 否则用 **【AI 技术面解读 · stock_code】** prefix + AI 总览正文.
 */
export function formatSummary(
  stockCode: string,
  stockName: string | null,
  aiSummary: string,
  trend: TrendLabel,
  confidence: number | null
): string {
  if (aiSummary && aiSummary.startsWith('**【')) {
    return aiSummary;
  }

  const trendLabelMap: Record<TrendLabel, string> = {
    uptrend: '上升趋势',
    downtrend: '下降趋势',
    sideways: '震荡整理',
    breakout: '突破中',
    reversal: '反转迹象',
    unknown: '趋势不明',
  };
  const trendLabel = trendLabelMap[trend];

  const header = stockName
    ? `**【AI 技术面解读 · ${stockCode} · ${stockName}】**`
    : `**【AI 技术面解读 · ${stockCode}】**`;

  const confPart = confidence !== null ? `（置信 ${Math.round(confidence)}）` : '';
  const trendLine = `- 综合判断：${trendLabel}${confPart}`;

  if (!aiSummary || aiSummary.trim().length === 0) {
    return [header, trendLine, '- 注：AI 远端未返回详细总览。'].join('\n');
  }

  return [header, trendLine, '', aiSummary].join('\n');
}

/**
 * 缓存行是否仍在 24h TTL 内 (expires_at > now).
 */
export function isCacheActive(row: TechnicalAnalysisReport, now: Date): boolean {
  if (!row || !row.expires_at) return false;
  return row.expires_at.getTime() > now.getTime();
}

/**
 * 把 cached Sequelize 行折叠成 TechnicalAnalysisResult (pure transform).
 *
 * - DECIMAL / JSONB 数字字段 Number() 包装 (US-040 codebase pattern);
 * - support / resistance / zones 列已是 number[] 但 belt-and-suspenders 包装.
 */
export function cacheRowToResult(row: TechnicalAnalysisReport): TechnicalAnalysisResult {
  return {
    stock_code: row.stock_code,
    stock_name: row.stock_name,
    lookback_days: row.lookback_days,
    trend: (row.trend as TrendLabel) || TREND_LABELS.UNKNOWN,
    support_levels: Array.isArray(row.support_levels)
      ? row.support_levels.map((n: any) => Number(n)).filter(Number.isFinite)
      : [],
    resistance_levels: Array.isArray(row.resistance_levels)
      ? row.resistance_levels.map((n: any) => Number(n)).filter(Number.isFinite)
      : [],
    buy_zone: Array.isArray(row.buy_zone)
      ? row.buy_zone.map((n: any) => Number(n)).filter(Number.isFinite)
      : [],
    sell_zone: Array.isArray(row.sell_zone)
      ? row.sell_zone.map((n: any) => Number(n)).filter(Number.isFinite)
      : [],
    summary: row.summary || '',
    confidence: row.confidence === null ? null : Number(row.confidence),
    status: (row.status as 'completed' | 'partial' | 'failed') || 'completed',
    nlp_engine: row.nlp_engine || NLP_ENGINES.HEURISTIC,
    indicators_snapshot: row.indicators_snapshot || {},
    error: row.error,
    generated_at: row.generated_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    metadata: row.metadata || {},
    from_cache: true,
    persisted: true,
  };
}

// 内部 helper — 也 export 让单测直接验证
export function _emaTail(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const series = ema(closes, period);
  const tail = extractLastValues(series, 1);
  return tail.length === 1 ? tail[0] : null;
}

export function _smaTail(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const series = sma(closes, period);
  const tail = extractLastValues(series, 1);
  return tail.length === 1 ? tail[0] : null;
}

// ---------------------------------------------------------------------------
// TechnicalAnalysisService — main entry
// ---------------------------------------------------------------------------

export class TechnicalAnalysisService {
  private readonly dataSource: TechnicalAnalysisDataSource;

  constructor(dataSource: TechnicalAnalysisDataSource = PRODUCTION_TECHNICAL_ANALYSIS_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 主流程: 命中 24h 缓存即返回; 否则拉 K 线 → 算指标 → 调远端 → fallback 启发式
   * → 写新行 (cache miss).
   */
  async analyze(
    stockCode: string,
    lookbackDaysRaw: any,
    options: AnalyzeOptions = {}
  ): Promise<TechnicalAnalysisResult> {
    const normalizedCode = normalizeSymbol(stockCode) || stockCode;
    const lookbackDays = normalizeLookbackDays(lookbackDaysRaw);
    const now = options.now || new Date();
    const forceRefresh = options.force_refresh === true;
    const dryRun = options.dry_run === true;

    // 0. 缓存命中
    if (!forceRefresh) {
      try {
        const cached = await this.dataSource.findActiveCache(normalizedCode, lookbackDays, now);
        if (cached && isCacheActive(cached, now)) {
          return cacheRowToResult(cached);
        }
      } catch (err: any) {
        logger.warn(
          `TechnicalAnalysisService.findActiveCache(${normalizedCode}) failed: ${err.message}`
        );
        // 缓存查询失败不阻塞主流程, 继续生成新报告
      }
    }

    // 1. 反查 stock_name
    const stockName =
      typeof options.stock_name === 'string' && options.stock_name.trim().length > 0
        ? options.stock_name.trim()
        : await this.dataSource.resolveStockName(normalizedCode);

    // 2. 拉 K 线
    let bars: OHLCVBar[] = [];
    try {
      bars = await this.dataSource.loadBars(normalizedCode, lookbackDays);
    } catch (err: any) {
      logger.error(`TechnicalAnalysisService.loadBars(${normalizedCode}) failed: ${err.message}`);
    }

    const metadata: Record<string, unknown> = {
      user_id: options.user_id ?? null,
      task_label: options.task_label ?? null,
      requested_at: now.toISOString(),
      bars_loaded: bars.length,
    };

    // 3. K 线不足 → 直接 failed (无指标可算)
    if (bars.length < MIN_LOOKBACK_DAYS) {
      const failed = this.buildFailedResult(
        normalizedCode,
        stockName,
        lookbackDays,
        now,
        `K 线数据不足 (${bars.length} 根, 需 ≥ ${MIN_LOOKBACK_DAYS})`,
        metadata
      );
      await this.tryPersist(failed, dryRun);
      return failed;
    }

    // 4. 构造 indicator context
    const ctx = buildIndicatorContext(bars);
    const snapshot: Record<string, unknown> = {
      last_close: ctx.last_close,
      recent_high: ctx.recent_high,
      recent_low: ctx.recent_low,
      last_rsi: ctx.last_rsi,
      last_macd: ctx.last_macd,
      last_bbands: ctx.last_bbands,
      vol_ratio: ctx.vol_ratio,
      momentum_pct: ctx.momentum_pct,
      bars_count: bars.length,
    };

    // 5. 调远端
    let payload: RemoteTechnicalAnalysisPayload;
    try {
      payload = await this.dataSource.callRemoteAnalyze(normalizedCode, ctx, lookbackDays);
    } catch (err: any) {
      // 双重防御 — DataSource 内已应 catch + 返回 FAILED, 这里再兜一次
      logger.warn(
        `TechnicalAnalysisService.callRemoteAnalyze(${normalizedCode}) unexpected throw: ${err.message}`
      );
      payload = { status: 'FAILED', data: { error: err.message } };
    }

    const parsed = parseRemoteAnalysis(payload);
    const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);

    let result: TechnicalAnalysisResult;
    if (parsed) {
      // 6a. 远端成功 → 用 AI 结果
      const summary = formatSummary(
        normalizedCode,
        stockName,
        parsed.summary,
        parsed.trend,
        parsed.confidence
      );
      result = {
        stock_code: normalizedCode,
        stock_name: stockName,
        lookback_days: lookbackDays,
        trend: parsed.trend,
        support_levels: parsed.support_levels,
        resistance_levels: parsed.resistance_levels,
        buy_zone: parsed.buy_zone,
        sell_zone: parsed.sell_zone,
        summary,
        confidence: parsed.confidence,
        status: 'completed',
        nlp_engine: NLP_ENGINES.TRADING_AGENTS,
        indicators_snapshot: snapshot,
        error: null,
        generated_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        metadata: { ...metadata, raw_status: String(payload?.status || '').toUpperCase() },
        from_cache: false,
        persisted: false,
      };
    } else {
      // 6b. 远端失败 → 启发式兜底 → status=partial
      const fallback = buildHeuristicFallback(ctx);
      const aiError =
        (payload?.data && (payload.data as any).error) ||
        'TradingAgents 远端无可用结果, 已切换至启发式兜底';
      result = {
        stock_code: normalizedCode,
        stock_name: stockName,
        lookback_days: lookbackDays,
        trend: fallback.trend,
        support_levels: fallback.support_levels,
        resistance_levels: fallback.resistance_levels,
        buy_zone: fallback.buy_zone,
        sell_zone: fallback.sell_zone,
        summary: fallback.summary,
        confidence: fallback.confidence,
        status: 'partial',
        nlp_engine: NLP_ENGINES.HEURISTIC,
        indicators_snapshot: snapshot,
        error: String(aiError),
        generated_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        metadata: { ...metadata, raw_status: String(payload?.status || '').toUpperCase() },
        from_cache: false,
        persisted: false,
      };
    }

    // 7. 写表 (fail-OPEN)
    await this.tryPersist(result, dryRun);
    return result;
  }

  /** 强制重新生成 (UI 刷新按钮) */
  async refresh(
    stockCode: string,
    lookbackDays: any,
    options: AnalyzeOptions = {}
  ): Promise<TechnicalAnalysisResult> {
    return this.analyze(stockCode, lookbackDays, { ...options, force_refresh: true });
  }

  /** 读端 — 直接读最新缓存行 (不命中返回 null, 不触发新生成) */
  async findActiveCache(
    stockCode: string,
    lookbackDaysRaw: any
  ): Promise<TechnicalAnalysisResult | null> {
    const normalizedCode = normalizeSymbol(stockCode) || stockCode;
    const lookbackDays = normalizeLookbackDays(lookbackDaysRaw);
    const now = new Date();
    try {
      const row = await this.dataSource.findActiveCache(normalizedCode, lookbackDays, now);
      if (row && isCacheActive(row, now)) {
        return cacheRowToResult(row);
      }
      return null;
    } catch (err: any) {
      logger.warn(`TechnicalAnalysisService.findActiveCache failed: ${err.message}`);
      return null;
    }
  }

  // 内部构造失败 result
  private buildFailedResult(
    stockCode: string,
    stockName: string | null,
    lookbackDays: number,
    now: Date,
    errorMsg: string,
    metadata: Record<string, unknown>
  ): TechnicalAnalysisResult {
    return {
      stock_code: stockCode,
      stock_name: stockName,
      lookback_days: lookbackDays,
      trend: TREND_LABELS.UNKNOWN,
      support_levels: [],
      resistance_levels: [],
      buy_zone: [],
      sell_zone: [],
      summary: '',
      confidence: null,
      status: 'failed',
      nlp_engine: NLP_ENGINES.HEURISTIC,
      indicators_snapshot: {},
      error: errorMsg,
      generated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
      metadata,
      from_cache: false,
      persisted: false,
    };
  }

  // 内部写表 (fail-OPEN)
  private async tryPersist(result: TechnicalAnalysisResult, dryRun: boolean): Promise<void> {
    if (dryRun) return;
    try {
      await this.dataSource.saveReport(result);
      result.persisted = true;
    } catch (err: any) {
      logger.warn(
        `TechnicalAnalysisService.saveReport(${result.stock_code}) failed (fail-OPEN): ${err.message}`
      );
      // fail-OPEN — 仍返回 result.persisted=false
      result.metadata = { ...result.metadata, persist_error: err.message };
    }
  }
}

/** 生产 singleton */
export const technicalAnalysisService = new TechnicalAnalysisService();
