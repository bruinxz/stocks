/**
 * KOLAuthorTrackingService — US-140 KOL-007 研报机构胜率追踪.
 *
 * 把 AnalystForecast 表里"有方向预测"(评级 ≥ '增持' / ≤ '减持') 的研报与
 * DailyBar 的 forward return 拼起来, 按 analyst_firm 维度聚合"过去 N 天内
 * 命中率", 落 `kol_author_stats` 表; 前端 (未来 KOL-014) /factors/kol tab
 * 直接读本表渲染 "top author 排行".
 *
 * **AC §8** (PRD US-140): "90 天后 ≥ 3 author 胜率 ≥ 60%" — 由
 * identifyTopAuthors(stats, {min_samples, min_win_rate}) 输出 top N 满足条件的
 * analyst_firm. trackAuthors() 跑完后 caller 可直接调 identifyTopAuthors 对
 * 结果做 AC 验证.
 *
 * **核心契约**:
 *   - trackAuthors({as_of_date?, lookback_days?, forward_window_days?,
 *     min_samples_per_firm?, dry_run?, persist?}): 返 `TrackAuthorsResult`
 *     含全部 firm 的 KOLAuthorStatRecord[] (排序: win_rate desc + sample_size desc);
 *   - identifyTopAuthors(stats, {min_samples, min_win_rate, limit?}): pure helper
 *     接 stats 数组返过滤后按 win_rate desc 排序的 KOLAuthorStatRecord[];
 *   - 全部 pure helpers export (classifyRatingDirection / computeForwardReturn /
 *     computeAuthorStat / identifyTopAuthors) 便于单测.
 *
 * **fail-OPEN 契约** (与 [[QAStatAggregator]] / [[KOLAggregatorService]] 同款):
 *   - DataSource 失败 → trackAuthors 返 status='failed' + error 字段, 不抛;
 *   - saveStats 失败 → status='partial' + persisted=false, 数据仍返;
 *   - 计算 forward return 时单股缺数据 → 跳过该 sample, 不影响 firm 整体统计.
 *   - 与 risk guard fail-CLOSED 对偶 — 本 service 是统计/可视化层, DB 故障不应
 *     阻塞主流程.
 *
 * **DataSource DI** (与 [[KOLAggregatorService]] / [[QAStatAggregator]] 同款):
 *   - `KOLAuthorTrackingDataSource` interface (3 方法: loadResearchReports /
 *     loadDailyBarsForReturn / saveStats);
 *   - `DefaultKOLAuthorTrackingDataSource` 实现 lazy require AnalystForecast +
 *     DailyBar + Stock + KOLAuthorStat 模型;
 *   - 单测注入 fake source 完全绕开 DB.
 *
 * 与既有相关 service 边界:
 *   - **AnalystForecast (US-030)**: 数据源, 不动它的写入;
 *   - **KOLAggregatorService (US-056)**: 那边是按 stock 聚合 (`他人在看`卡片),
 *     这里是按 firm 聚合 (`top author 榜单`), 互补不重复;
 *   - **AIAttributionSummary (US-082)**: 未来 KOL-011 NewsAnalyzer 接 KOL 真
 *     实输出时, 可读本表的 win_rate 给"高胜率机构推荐"加权 (本 story 不实现);
 *   - **factor 体系**: 本表不参与因子打分, 仅给 UI 看, 也给后续 KOL-014
 *     /factors/kol tab 排行榜.
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// 评级 → 方向映射 (与 [[KOLAggregatorService]] RATING_SENTIMENT_MAP 一脉相承)
// ---------------------------------------------------------------------------

/** 看多评级 (sample 计入, direction = +1) */
export const BULLISH_RATINGS = Object.freeze([
  '买入',
  '推荐',
  '强烈推荐',
  '增持',
  '超配',
  '审慎推荐',
]);

/** 看空评级 (sample 计入, direction = -1) */
export const BEARISH_RATINGS = Object.freeze(['减持', '低配', '卖出', '回避']);

/** 中性评级 (sample **不**计入 — 无方向信号无法判定命中) */
export const NEUTRAL_RATINGS = Object.freeze(['持有', '中性', '观望']);

/** 评级 → 方向 (+1 = 看多, -1 = 看空, 0 = 中性/不计入) */
export type RatingDirection = 1 | -1 | 0;

/**
 * 评级文本归一化 + 方向分类.
 *
 * 与 [[KOLAggregatorService]] RATING_SENTIMENT_MAP 保持一致 — 同样的评级集合
 * 同样的方向分类, 防止两边漂移.
 *
 * 空值 / 未识别 / 未评级 → 0 (不计入 sample).
 */
export function classifyRatingDirection(rating: unknown): RatingDirection {
  if (typeof rating !== 'string') return 0;
  const trimmed = rating.trim();
  if (!trimmed) return 0;
  if (BULLISH_RATINGS.includes(trimmed)) return 1;
  if (BEARISH_RATINGS.includes(trimmed)) return -1;
  // 中性 / 未识别 / "未评级" 全部 → 0
  return 0;
}

// ---------------------------------------------------------------------------
// Forward return 计算
// ---------------------------------------------------------------------------

/** 单条 daily bar (close + 日期, 简化版供 forward return 计算) */
export interface ForwardReturnBar {
  /** YYYY-MM-DD */
  trade_date: string;
  close: number;
}

/**
 * 计算 forward return — 给 (report_date, stock_code) 一对找 30 天后的收益率.
 *
 * 算法:
 *   1. **基准价** = report_date 当天或之前最近一个交易日的 close (T-1 close);
 *      研报通常盘后发, 假设买入价 = 当天收盘 (与回测口径对齐);
 *   2. **结算价** = report_date + forward_window_days (自然日) 之后第一个交易日的
 *      close; 若该日股票停牌 / 无 bar, 继续向后找 ≤ 7 天兜底 (停牌窗口超 7 天放弃);
 *   3. **forward_return** = settle / base - 1;
 *   4. 任何一端缺数据 → 返 null (caller 跳过该 sample, 不影响 firm 整体).
 *
 * **fail-safe**: bars 空 / 全在 report_date 之前 → null; settle 找不到 → null.
 *
 * @param bars 该股票的 daily bars (按 trade_date asc, 来自上游已排序数据)
 * @param reportDate 研报发布日 YYYY-MM-DD
 * @param forwardWindowDays 默认 30 自然日
 */
export function computeForwardReturn(
  bars: ForwardReturnBar[],
  reportDate: string,
  forwardWindowDays = 30
): number | null {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  if (typeof reportDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return null;

  // 基准价: report_date 当天或之前最近交易日 close.
  let baseClose: number | null = null;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const b = bars[i];
    if (b.trade_date <= reportDate && Number.isFinite(b.close) && b.close > 0) {
      baseClose = b.close;
      break;
    }
  }
  if (baseClose == null) return null;

  // 结算价: report_date + forward_window_days 之后第一个交易日 close.
  // 用 Date 算目标日, 然后在 bars 里找 >= 目标日的第一个 (停牌时自然往后挪).
  const targetDate = addDays(reportDate, forwardWindowDays);
  // tolerance: 停牌 ≤ 7 天兜底, 超过放弃
  const toleranceCap = addDays(targetDate, 7);
  let settleClose: number | null = null;
  for (const b of bars) {
    if (b.trade_date < targetDate) continue;
    if (b.trade_date > toleranceCap) break;
    if (Number.isFinite(b.close) && b.close > 0) {
      settleClose = b.close;
      break;
    }
  }
  if (settleClose == null) return null;

  return settleClose / baseClose - 1;
}

/** 加自然日 (YYYY-MM-DD → YYYY-MM-DD), 跨月/跨年自动 handle. */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 主聚合: 计算 firm 维度 stat
// ---------------------------------------------------------------------------

/** 上游一条研报 (subset of AnalystForecast) */
export interface KOLAuthorResearchRow {
  report_date: string; // YYYY-MM-DD
  stock_code: string;
  analyst_firm: string;
  rating?: string | null;
}

/** 上游 daily bars 按 stock_code 分组的 map */
export type StockBarsMap = Map<string, ForwardReturnBar[]>;

/** 聚合后的单 firm stat (含 raw_payload 审计字段) */
export interface KOLAuthorStatRecord {
  analyst_firm: string;
  as_of_date: string;
  sample_size: number;
  win_count: number;
  loss_count: number;
  win_rate: number;
  avg_forward_return_pct: number | null;
  lookback_days: number;
  forward_window_days: number;
  latest_report_date: string | null;
  raw_payload: {
    rating_distribution: Record<string, number>;
    sample_stock_codes: string[];
    skipped_reasons: Record<string, number>;
  };
  persisted: boolean;
}

/**
 * 对单个 firm 的研报列表 + bars map → 聚合输出 1 条 stat.
 *
 * **方向校正后的 forward return**: 看空研报的 forward return 取负, 让"猜对方向"
 * 一致为正; 计算 avg_forward_return_pct 时按 (direction * raw_forward_return)
 * 取均值, 这样 avg > 0 表示"该 firm 总体方向准", 与 win_rate 同向.
 */
export function computeAuthorStat(input: {
  analyst_firm: string;
  as_of_date: string;
  rows: KOLAuthorResearchRow[];
  bars_by_stock: StockBarsMap;
  lookback_days: number;
  forward_window_days: number;
}): KOLAuthorStatRecord {
  const ratingDist: Record<string, number> = {};
  const skippedReasons: Record<string, number> = {};
  const stockCodesSet = new Set<string>();

  let sampleSize = 0;
  let winCount = 0;
  let lossCount = 0;
  let returnSum = 0;
  let returnCount = 0;
  let latestReportDate: string | null = null;

  for (const r of input.rows) {
    const rating = (r.rating || '未评级').trim() || '未评级';
    ratingDist[rating] = (ratingDist[rating] || 0) + 1;

    if (latestReportDate == null || r.report_date > latestReportDate) {
      latestReportDate = r.report_date;
    }

    const direction = classifyRatingDirection(rating);
    if (direction === 0) {
      skippedReasons['neutral_or_unrated'] = (skippedReasons['neutral_or_unrated'] || 0) + 1;
      continue;
    }

    const bars = input.bars_by_stock.get(r.stock_code) || [];
    const fwd = computeForwardReturn(bars, r.report_date, input.forward_window_days);
    if (fwd == null) {
      skippedReasons['no_forward_data'] = (skippedReasons['no_forward_data'] || 0) + 1;
      continue;
    }

    // 方向校正
    const adjusted = direction * fwd;
    sampleSize += 1;
    stockCodesSet.add(r.stock_code);
    returnSum += adjusted;
    returnCount += 1;
    if (adjusted > 0) winCount += 1;
    else lossCount += 1;
  }

  const winRate = sampleSize > 0 ? winCount / sampleSize : 0;
  const avgReturn = returnCount > 0 ? returnSum / returnCount : null;

  // 抽样最多 20 条 stock_code 放 audit payload (防 payload 爆)
  const sampleStockCodes = Array.from(stockCodesSet).slice(0, 20);

  return {
    analyst_firm: input.analyst_firm,
    as_of_date: input.as_of_date,
    sample_size: sampleSize,
    win_count: winCount,
    loss_count: lossCount,
    win_rate: roundTo4(winRate),
    avg_forward_return_pct: avgReturn == null ? null : roundTo4(avgReturn),
    lookback_days: input.lookback_days,
    forward_window_days: input.forward_window_days,
    latest_report_date: latestReportDate,
    raw_payload: {
      rating_distribution: ratingDist,
      sample_stock_codes: sampleStockCodes,
      skipped_reasons: skippedReasons,
    },
    persisted: false,
  };
}

/** 量化到 4 位小数 (与 DECIMAL(5,4) / DECIMAL(8,4) 列对齐). */
export function roundTo4(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// AC 主验收: identifyTopAuthors (pure helper)
// ---------------------------------------------------------------------------

export interface IdentifyTopAuthorsOptions {
  /** 最少样本数 (默认 5) — 防止小样本偶然命中率虚高 */
  min_samples?: number;
  /** 最低胜率 (默认 0.6, 即 60%) — AC §8 阈值 */
  min_win_rate?: number;
  /** 输出上限 (默认 20) */
  limit?: number;
}

/**
 * 从 stats 数组挑出"满足最低样本 + 最低胜率"的 author, 按 win_rate desc +
 * sample_size desc 排序, 取 top N.
 *
 * 这是 PRD AC §8 "90 天后 ≥ 3 author 胜率 ≥ 60%" 的事实源 — caller 拿到这个
 * 输出数组 length ≥ 3 即视为 AC 通过.
 */
export function identifyTopAuthors(
  stats: KOLAuthorStatRecord[],
  options: IdentifyTopAuthorsOptions = {}
): KOLAuthorStatRecord[] {
  const minSamples = Math.max(1, Math.floor(options.min_samples ?? 5));
  const minWinRate = Math.max(0, Math.min(1, options.min_win_rate ?? 0.6));
  const limit = Math.max(1, Math.floor(options.limit ?? 20));

  return stats
    .filter(s => s.sample_size >= minSamples && s.win_rate >= minWinRate)
    .sort((a, b) => {
      if (a.win_rate !== b.win_rate) return b.win_rate - a.win_rate;
      if (a.sample_size !== b.sample_size) return b.sample_size - a.sample_size;
      return a.analyst_firm < b.analyst_firm ? -1 : a.analyst_firm > b.analyst_firm ? 1 : 0;
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// DataSource DI 接口
// ---------------------------------------------------------------------------

export interface KOLAuthorTrackingDataSource {
  /** 拉 [sinceDate, asOfDate] 区间内的全部研报 (含 rating 列) */
  loadResearchReports(sinceDate: string, asOfDate: string): Promise<KOLAuthorResearchRow[]>;
  /**
   * 拉这些股票在 [sinceDate, asOfDate + forwardWindowDays + 7] 区间内的 daily bars.
   * 返按 stock_code 分组的 map, 每组按 trade_date asc.
   */
  loadDailyBarsForReturn(
    stockCodes: string[],
    sinceDate: string,
    untilDate: string
  ): Promise<StockBarsMap>;
  /** 写入 kol_author_stats (upsert) */
  saveStats(records: KOLAuthorStatRecord[]): Promise<void>;
}

/**
 * 生产实现 — lazy require 模型避免单测进程拽起 sequelize.
 * 与 [[KOLAggregatorService]] DefaultKOLAggregatorDataSource 同款.
 */
export class DefaultKOLAuthorTrackingDataSource implements KOLAuthorTrackingDataSource {
  async loadResearchReports(sinceDate: string, asOfDate: string): Promise<KOLAuthorResearchRow[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AnalystForecast } = require('../../models/AnalystForecast');
      const rows = await AnalystForecast.findAll({
        where: {
          report_date: { [Op.gte]: sinceDate, [Op.lte]: asOfDate },
        },
        attributes: ['report_date', 'stock_code', 'analyst_firm', 'rating'],
        raw: true,
      });
      return (rows as unknown as KOLAuthorResearchRow[]).map(r => ({
        report_date: typeof r.report_date === 'string' ? r.report_date : String(r.report_date),
        stock_code: r.stock_code,
        analyst_firm: r.analyst_firm,
        rating: r.rating ?? null,
      }));
    } catch (err: any) {
      logger.error(`KOLAuthorTracking.loadResearchReports failed: ${err.message || String(err)}`);
      return [];
    }
  }

  async loadDailyBarsForReturn(
    stockCodes: string[],
    sinceDate: string,
    untilDate: string
  ): Promise<StockBarsMap> {
    const map: StockBarsMap = new Map();
    if (stockCodes.length === 0) return map;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../../models/DailyBar');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../models/Stock');

      // 先把 stock_code 映射到 stock_id (DailyBar 用 stock_id PK)
      const stocks = await Stock.findAll({
        where: { code: { [Op.in]: stockCodes } },
        attributes: ['id', 'code'],
        raw: true,
      });
      const codeById = new Map<number, string>();
      const ids: number[] = [];
      for (const s of stocks as Array<{ id: number; code: string }>) {
        codeById.set(s.id, s.code);
        ids.push(s.id);
      }
      if (ids.length === 0) return map;

      const sinceTs = new Date(sinceDate + 'T00:00:00Z');
      const untilTs = new Date(untilDate + 'T23:59:59Z');
      const bars = await DailyBar.findAll({
        where: {
          stock_id: { [Op.in]: ids },
          time: { [Op.gte]: sinceTs, [Op.lte]: untilTs },
        },
        attributes: ['stock_id', 'time', 'close'],
        order: [['time', 'ASC']],
        raw: true,
      });

      for (const b of bars as Array<{ stock_id: number; time: Date; close: number }>) {
        const code = codeById.get(b.stock_id);
        if (!code) continue;
        const dt = (b.time instanceof Date ? b.time : new Date(b.time)).toISOString().slice(0, 10);
        const close = typeof b.close === 'string' ? parseFloat(b.close) : b.close;
        if (!Number.isFinite(close)) continue;
        let arr = map.get(code);
        if (!arr) {
          arr = [];
          map.set(code, arr);
        }
        arr.push({ trade_date: dt, close });
      }
      return map;
    } catch (err: any) {
      logger.error(
        `KOLAuthorTracking.loadDailyBarsForReturn failed: ${err.message || String(err)}`
      );
      return map;
    }
  }

  async saveStats(records: KOLAuthorStatRecord[]): Promise<void> {
    if (records.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { KOLAuthorStat } = require('../../models/KOLAuthorStat');
    await KOLAuthorStat.bulkCreate(
      records.map(r => ({
        analyst_firm: r.analyst_firm,
        as_of_date: r.as_of_date,
        sample_size: r.sample_size,
        win_count: r.win_count,
        loss_count: r.loss_count,
        win_rate: r.win_rate,
        avg_forward_return_pct: r.avg_forward_return_pct,
        lookback_days: r.lookback_days,
        forward_window_days: r.forward_window_days,
        latest_report_date: r.latest_report_date,
        raw_payload: r.raw_payload,
      })) as unknown as Array<Record<string, unknown>>,
      {
        updateOnDuplicate: [
          'sample_size',
          'win_count',
          'loss_count',
          'win_rate',
          'avg_forward_return_pct',
          'lookback_days',
          'forward_window_days',
          'latest_report_date',
          'raw_payload',
          'updated_at',
        ],
      }
    );
  }
}

export const PRODUCTION_KOL_AUTHOR_TRACKING_DATA_SOURCE: KOLAuthorTrackingDataSource =
  new DefaultKOLAuthorTrackingDataSource();

// ---------------------------------------------------------------------------
// Service-level 入口
// ---------------------------------------------------------------------------

export const DEFAULT_LOOKBACK_DAYS = 90;
export const DEFAULT_FORWARD_WINDOW_DAYS = 30;
export const DEFAULT_MIN_SAMPLES_PER_FIRM = 3;

export interface TrackAuthorsOptions {
  /** 截止日 (YYYY-MM-DD); 默认今天 (UTC) */
  as_of_date?: string;
  /** 统计窗口 (默认 90 天) */
  lookback_days?: number;
  /** forward return 窗口 (默认 30 自然日) */
  forward_window_days?: number;
  /** 单 firm 至少需要 N 条 sample 才输出 (默认 3); 防止"只发 1 条恰好命中" */
  min_samples_per_firm?: number;
  /** dry_run 跳过 DB 写入 */
  dry_run?: boolean;
}

export type TrackAuthorsStatus = 'ok' | 'partial' | 'skipped' | 'failed';

export interface TrackAuthorsResult {
  status: TrackAuthorsStatus;
  as_of_date: string;
  total_firms: number;
  total_reports: number;
  total_skipped: number;
  stats: KOLAuthorStatRecord[];
  error?: string;
  reason?: string;
}

export class KOLAuthorTrackingService {
  private readonly dataSource: KOLAuthorTrackingDataSource;

  constructor(
    dataSource: KOLAuthorTrackingDataSource = PRODUCTION_KOL_AUTHOR_TRACKING_DATA_SOURCE
  ) {
    this.dataSource = dataSource;
  }

  /**
   * 主入口 — 拉研报 + 拉 bars + 聚合 + 落表.
   *
   * 触发: 未来 cron `KOL_AUTHOR_TRACKING` (建议每周一 03:00 — 错开 02:00 QA_STAT
   * 聚合) / 手动 CLI / 灰度 API.
   *
   * **fail-OPEN 4 层**:
   *   1. PRODUCTION DataSource 内 try/catch + 返 [] / Map() — 单股错误不阻塞;
   *   2. 主入口顶层 try/catch — 返 {status:'failed', error} 不抛;
   *   3. saveStats 失败 → 返 {status:'partial'} + 数据仍包在 stats 里;
   *   4. 单 firm 数据缺失 → 跳过该 firm, 不影响其它 firm.
   */
  async trackAuthors(options: TrackAuthorsOptions = {}): Promise<TrackAuthorsResult> {
    const asOfDate = options.as_of_date || this.todayUTC();
    const lookbackDays = Math.max(7, Math.floor(options.lookback_days ?? DEFAULT_LOOKBACK_DAYS));
    const forwardWindowDays = Math.max(
      1,
      Math.floor(options.forward_window_days ?? DEFAULT_FORWARD_WINDOW_DAYS)
    );
    const minSamples = Math.max(
      1,
      Math.floor(options.min_samples_per_firm ?? DEFAULT_MIN_SAMPLES_PER_FIRM)
    );
    const sinceDate = addDays(asOfDate, -lookbackDays);

    try {
      const rows = await this.dataSource.loadResearchReports(sinceDate, asOfDate);
      if (rows.length === 0) {
        return {
          status: 'skipped',
          as_of_date: asOfDate,
          total_firms: 0,
          total_reports: 0,
          total_skipped: 0,
          stats: [],
          reason: 'no_reports_in_window',
        };
      }

      // 拉 bars (覆盖 [sinceDate, asOfDate + forwardWindow + 7d tolerance])
      const stockCodes = Array.from(new Set(rows.map(r => r.stock_code)));
      const barsUntil = addDays(asOfDate, forwardWindowDays + 7);
      const barsMap = await this.dataSource.loadDailyBarsForReturn(
        stockCodes,
        sinceDate,
        barsUntil
      );

      // 按 firm 分组
      const byFirm = new Map<string, KOLAuthorResearchRow[]>();
      for (const r of rows) {
        const firm = (r.analyst_firm || '').trim();
        if (!firm) continue;
        let arr = byFirm.get(firm);
        if (!arr) {
          arr = [];
          byFirm.set(firm, arr);
        }
        arr.push(r);
      }

      // 每 firm 算 stat
      const stats: KOLAuthorStatRecord[] = [];
      let totalSkippedFirms = 0;
      for (const [firm, firmRows] of byFirm) {
        const stat = computeAuthorStat({
          analyst_firm: firm,
          as_of_date: asOfDate,
          rows: firmRows,
          bars_by_stock: barsMap,
          lookback_days: lookbackDays,
          forward_window_days: forwardWindowDays,
        });
        // 样本不足直接跳过 (不落库 — 防 kol_author_stats 表充斥噪声)
        if (stat.sample_size < minSamples) {
          totalSkippedFirms += 1;
          continue;
        }
        stats.push(stat);
      }

      // 排序: win_rate desc + sample_size desc + firm 字母序
      stats.sort((a, b) => {
        if (a.win_rate !== b.win_rate) return b.win_rate - a.win_rate;
        if (a.sample_size !== b.sample_size) return b.sample_size - a.sample_size;
        return a.analyst_firm < b.analyst_firm ? -1 : a.analyst_firm > b.analyst_firm ? 1 : 0;
      });

      if (options.dry_run === true) {
        return {
          status: 'ok',
          as_of_date: asOfDate,
          total_firms: stats.length,
          total_reports: rows.length,
          total_skipped: totalSkippedFirms,
          stats,
          reason: 'dry_run',
        };
      }

      try {
        if (stats.length > 0) {
          await this.dataSource.saveStats(stats);
          stats.forEach(s => {
            s.persisted = true;
          });
        }
        logger.info(
          `KOLAuthorTracking: as_of=${asOfDate} firms=${stats.length} ` +
            `reports=${rows.length} skipped_firms=${totalSkippedFirms}`
        );
        return {
          status: 'ok',
          as_of_date: asOfDate,
          total_firms: stats.length,
          total_reports: rows.length,
          total_skipped: totalSkippedFirms,
          stats,
        };
      } catch (err: any) {
        // fail-OPEN — 数据仍返, 标 partial
        logger.error(`KOLAuthorTracking.saveStats failed: ${err.message || String(err)}`);
        return {
          status: 'partial',
          as_of_date: asOfDate,
          total_firms: stats.length,
          total_reports: rows.length,
          total_skipped: totalSkippedFirms,
          stats,
          error: `save_failed: ${err.message || String(err)}`,
        };
      }
    } catch (err: any) {
      logger.error(`KOLAuthorTracking.trackAuthors failed: ${err.message || String(err)}`);
      return {
        status: 'failed',
        as_of_date: asOfDate,
        total_firms: 0,
        total_reports: 0,
        total_skipped: 0,
        stats: [],
        error: err.message || String(err),
      };
    }
  }

  private todayUTC(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

/** 生产 singleton */
export const kolAuthorTrackingService = new KOLAuthorTrackingService();
