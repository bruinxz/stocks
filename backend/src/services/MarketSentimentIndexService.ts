import { Op, fn, col } from 'sequelize';
import { LimitUpStock } from '../models/LimitUpStock';
import { MarketSentimentIndex } from '../models/MarketSentimentIndex';
import { NorthboundHolding } from '../models/NorthboundHolding';
import { StockSentiment } from '../models/StockSentiment';
import { limitDownClient, LimitDownClient } from '../data/sources/LimitDownClient';
import { marginBalanceClient, MarginBalanceClient } from '../data/sources/MarginBalanceClient';
import { logger } from '../utils/logger';

/**
 * 市场情绪量化指数服务 — US-057 AI 增强层。
 *
 * **职责**：每个交易日收盘后聚合 4 大维度 (涨停-跌停 / 北向 / 融资 / 全市场问答热度)
 * 计算 raw_score 并归一化到 0-100 的 `index_value`，写入 `MarketSentimentIndex` 表。
 *
 * **AC 指定公式**：
 *
 *   raw = (涨停数 - 跌停数)         × 0.3
 *       + 北向净买入 z-score          × 0.3
 *       + 融资净买入 z-score          × 0.2
 *       + 全市场问答热度 z-score      × 0.2
 *
 *   index_value = 100 / (1 + exp(-raw / scale))  // sigmoid 归一化, scale=30 默认
 *
 * **z-score 计算口径** (所有维度统一):
 *   - lookback_days 默认 60 交易日 (含目标日)；
 *   - mean / sample-stddev 在 lookback 窗口内计算；
 *   - 样本数 < MIN_OBSERVATIONS (默认 5) 时 z-score = 0 (中性, 与 US-035 同款);
 *   - 标准差 < 1e-9 (近常数) 时 z-score = 0 防爆。
 *
 * **设计参考**:
 *
 *   - **DataSource DI** (与 KOLAggregatorService US-056 / AIAdvisorService US-055 同款 6 项 checklist):
 *     接口 `MarketSentimentDataSource` 暴露 6 个方法 (loadLimitUpCount / fetchLimitDownCount /
 *     loadNorthboundDailyTotal / fetchMarginDailyNetBuy / loadQADailyTotal / saveIndex);
 *     Default impl 走 DB / Python helper; 单测注入 fake source 完全脱 DB。
 *
 *   - **8+ 纯函数全 export** (mean / sampleStddev / computeZScore / sigmoidNormalize /
 *     normalizeDateOnly / isoDateMinusDays / aggregateComponents / buildSummaryMessage)
 *     让单测覆盖 NaN / 边界 / 已知数值 (≥ 5 项 / lookback 不足 / 全 0 / sigmoid 边界)。
 *
 *   - **plain-object 返回类型** `MarketSentimentIndexResult` 兼容 persist=true 与
 *     dry_run=true 同款形态 (与 US-037 OptimizationResultRecord / US-055 AnalyzeSingleStockResult 一致)。
 *
 *   - **status='partial' 仍正常 persist**: 某一维度数据缺失 (跌停接口当日空 /
 *     northbound 还没 sync) 不阻塞写入，写 status='partial' + components_json 标注
 *     哪些维度缺失。完全缺失 (4 维度全空) 写 status='failed' 仍 persist 让 ops 看到曾尝试。
 *
 *   - **fail-OPEN on saveIndex**: DB 故障不抛, 转 warning 返回 persisted=false 让 caller
 *     仍能拿到 index_value (与 US-055 同款)。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** AC 指定的 4 维度权重 (sum=1.0, Object.freeze 防 mutation) */
export const SENTIMENT_WEIGHTS = Object.freeze({
  limit_diff: 0.3,
  northbound: 0.3,
  margin: 0.2,
  qa_heat: 0.2,
} as const);

/** 默认参数 (Object.freeze 防 mutation) */
export const DEFAULT_PARAMS = Object.freeze({
  /** 横截面 z-score 回看窗口 (交易日) */
  lookback_days: 60,
  /** z-score 计算最少样本数 */
  min_observations: 5,
  /** sigmoid 归一化 scale (raw=±scale 时 index ≈ 27/73, raw=±2*scale 时 ≈ 12/88) */
  sigmoid_scale: 30,
} as const);

/** sample stddev 防 div-by-zero 阈值 */
const STDDEV_NEAR_ZERO = 1e-9;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface MarketSentimentIndexOptions {
  trade_date?: string;
  lookback_days?: number;
  min_observations?: number;
  sigmoid_scale?: number;
  /** dry_run=true 不写表 */
  dry_run?: boolean;
}

export interface SentimentComponentDetail {
  raw_value: number | null;
  z_score: number | null;
  weight: number;
  /** 已加权贡献 (= z_score * weight 或 limit_diff * weight) */
  contribution: number;
  /** 数据点数 (lookback 窗口内有效行数) — z-score 算法用 */
  observation_count: number;
  /** 该维度遇到的错误 (e.g. Python 调用失败) — null 表示正常 */
  error: string | null;
}

export interface MarketSentimentIndexResult {
  trade_date: string;
  index_value: number;
  raw_score: number;
  status: 'ok' | 'partial' | 'failed';
  message: string;
  persisted: boolean;
  dry_run: boolean;
  components: {
    limit_diff: SentimentComponentDetail & {
      limit_up_count: number | null;
      limit_down_count: number | null;
    };
    northbound: SentimentComponentDetail;
    margin: SentimentComponentDetail;
    qa_heat: SentimentComponentDetail;
  };
  /** 实际使用的参数 (defaults merged with options) */
  params: {
    lookback_days: number;
    min_observations: number;
    sigmoid_scale: number;
  };
}

// ---------------------------------------------------------------------------
// DataSource 接口
// ---------------------------------------------------------------------------

export interface MarketSentimentDataSource {
  /** 取一日全市场涨停数 (LimitUpStock 行数) */
  loadLimitUpCount(tradeDate: string): Promise<number>;
  /** 取一日全市场跌停数 (实时 Python 调用 stock_zt_pool_dtgc_em) */
  fetchLimitDownCount(tradeDate: string): Promise<number>;
  /**
   * 取 lookback 窗口内每日 全市场北向总持股市值 (元).
   * 返回升序日期 + 总市值。caller 会做 day-to-day diff 推算"净买入"。
   */
  loadNorthboundDailyTotal(
    startDate: string,
    endDate: string
  ): Promise<Array<{ date: string; total: number }>>;
  /** 取 lookback 窗口内每日 融资净买入 (亿元) (Python helper 一次拉全量切片) */
  fetchMarginDailyNetBuy(
    startDate: string,
    endDate: string
  ): Promise<Array<{ date: string; net_buy_yi: number }>>;
  /**
   * 取 lookback 窗口内每日 全市场 StockSentiment.post_count 之和。
   * 升序日期 + 总和。
   */
  loadQADailyTotal(
    startDate: string,
    endDate: string
  ): Promise<Array<{ date: string; total: number }>>;
  /** 保存 / 覆盖一行 MarketSentimentIndex */
  saveIndex(record: MarketSentimentIndexRecord): Promise<void>;
}

/** saveIndex 入参 — 对应 MarketSentimentIndex 的 column 子集 */
export interface MarketSentimentIndexRecord {
  trade_date: string;
  index_value: number;
  raw_score: number;
  limit_up_count: number | null;
  limit_down_count: number | null;
  northbound_net_buy_zscore: number | null;
  margin_net_buy_zscore: number | null;
  qa_heat_zscore: number | null;
  components_json: Record<string, unknown>;
  status: 'ok' | 'partial' | 'failed';
  message: string | null;
}

// ---------------------------------------------------------------------------
// Default DataSource (DB + Python helper)
// ---------------------------------------------------------------------------

export class DefaultMarketSentimentDataSource implements MarketSentimentDataSource {
  private limitDown: LimitDownClient;
  private margin: MarginBalanceClient;

  constructor(opts: { limitDown?: LimitDownClient; margin?: MarginBalanceClient } = {}) {
    this.limitDown = opts.limitDown || limitDownClient;
    this.margin = opts.margin || marginBalanceClient;
  }

  async loadLimitUpCount(tradeDate: string): Promise<number> {
    try {
      return await LimitUpStock.count({ where: { trade_date: tradeDate } });
    } catch (error) {
      logger.warn(
        `MarketSentiment.loadLimitUpCount(${tradeDate}) failed: ${
          (error as Error).message
        } — returning 0`
      );
      return 0;
    }
  }

  async fetchLimitDownCount(tradeDate: string): Promise<number> {
    try {
      const rows = await this.limitDown.fetchDailyPool(tradeDate);
      return rows.length;
    } catch (error) {
      logger.warn(
        `MarketSentiment.fetchLimitDownCount(${tradeDate}) failed: ${
          (error as Error).message
        } — returning 0`
      );
      return 0;
    }
  }

  async loadNorthboundDailyTotal(
    startDate: string,
    endDate: string
  ): Promise<Array<{ date: string; total: number }>> {
    try {
      // NorthboundHolding 是 per-stock 表; 取窗口内每日 sum(hold_amount)
      const rows = (await NorthboundHolding.findAll({
        attributes: ['trade_date', [fn('SUM', col('hold_amount')), 'total_hold']],
        where: {
          trade_date: { [Op.between]: [startDate, endDate] },
        },
        group: ['trade_date'],
        order: [['trade_date', 'ASC']],
        raw: true,
      })) as unknown as Array<{ trade_date: string; total_hold: string | number | null }>;
      return rows.map(r => ({
        date: r.trade_date,
        total: Number(r.total_hold || 0),
      }));
    } catch (error) {
      logger.warn(
        `MarketSentiment.loadNorthboundDailyTotal(${startDate}~${endDate}) failed: ${
          (error as Error).message
        } — returning []`
      );
      return [];
    }
  }

  async fetchMarginDailyNetBuy(
    startDate: string,
    endDate: string
  ): Promise<Array<{ date: string; net_buy_yi: number }>> {
    try {
      const rows = await this.margin.fetchTimeSeries(startDate, endDate);
      const out: Array<{ date: string; net_buy_yi: number }> = [];
      for (const r of rows) {
        if (
          r.rz_net_buy_yi !== null &&
          r.rz_net_buy_yi !== undefined &&
          Number.isFinite(r.rz_net_buy_yi)
        ) {
          out.push({ date: r.date, net_buy_yi: Number(r.rz_net_buy_yi) });
        }
      }
      return out;
    } catch (error) {
      logger.warn(
        `MarketSentiment.fetchMarginDailyNetBuy(${startDate}~${endDate}) failed: ${
          (error as Error).message
        } — returning []`
      );
      return [];
    }
  }

  async loadQADailyTotal(
    startDate: string,
    endDate: string
  ): Promise<Array<{ date: string; total: number }>> {
    try {
      const rows = (await StockSentiment.findAll({
        attributes: ['trade_date', [fn('SUM', col('post_count')), 'total_post']],
        where: {
          trade_date: { [Op.between]: [startDate, endDate] },
        },
        group: ['trade_date'],
        order: [['trade_date', 'ASC']],
        raw: true,
      })) as unknown as Array<{ trade_date: string; total_post: string | number | null }>;
      return rows.map(r => ({
        date: r.trade_date,
        total: Number(r.total_post || 0),
      }));
    } catch (error) {
      logger.warn(
        `MarketSentiment.loadQADailyTotal(${startDate}~${endDate}) failed: ${
          (error as Error).message
        } — returning []`
      );
      return [];
    }
  }

  async saveIndex(record: MarketSentimentIndexRecord): Promise<void> {
    await MarketSentimentIndex.upsert({
      trade_date: record.trade_date,
      index_value: record.index_value,
      raw_score: record.raw_score,
      limit_up_count: record.limit_up_count,
      limit_down_count: record.limit_down_count,
      northbound_net_buy_zscore: record.northbound_net_buy_zscore,
      margin_net_buy_zscore: record.margin_net_buy_zscore,
      qa_heat_zscore: record.qa_heat_zscore,
      components_json: record.components_json,
      status: record.status,
      message: record.message,
    });
  }
}

/** 生产环境 PRODUCTION singleton */
export const PRODUCTION_MARKET_SENTIMENT_DATA_SOURCE: MarketSentimentDataSource =
  new DefaultMarketSentimentDataSource();

// ---------------------------------------------------------------------------
// 纯函数 helpers (全 export 便于单测)
// ---------------------------------------------------------------------------

/** YYYY-MM-DD 规范化, 兼容 Date 对象 / 8 位 / 10 位 ISO */
export function normalizeDateOnly(d: string | Date | undefined | null): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const s = String(d).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/** YYYY-MM-DD 减 N 自然日 */
export function isoDateMinusDays(d: string, days: number): string {
  const dt = new Date(`${d}T00:00:00Z`);
  if (!Number.isFinite(dt.getTime())) return d;
  dt.setUTCDate(dt.getUTCDate() - days);
  return normalizeDateOnly(dt) || d;
}

/** 算数均值 (空数组返回 NaN) */
export function mean(values: number[]): number {
  if (!values || values.length === 0) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/**
 * 样本标准差 (Bessel's correction, n-1).
 * 空 / 单元素返回 NaN; n>=2 时返回 sqrt(sum((x-mean)^2) / (n-1)).
 */
export function sampleStddev(values: number[]): number {
  if (!values || values.length < 2) return NaN;
  const m = mean(values);
  let s = 0;
  for (const v of values) {
    const d = v - m;
    s += d * d;
  }
  return Math.sqrt(s / (values.length - 1));
}

/**
 * Z-score: (target - mean(history)) / stddev(history).
 * 数据不足 / stddev 近 0 / 非有限值统一返回 null (caller 判定是否退化为 0).
 *
 * @param historyValues 历史观测数组 (含 target_value 在末位也可, 函数不分)
 * @param targetValue 目标值
 * @param minObservations 最少观测数 (< 此数返回 null)
 */
export function computeZScore(
  historyValues: number[],
  targetValue: number,
  minObservations: number
): number | null {
  if (!Number.isFinite(targetValue)) return null;
  const finite = historyValues.filter(v => Number.isFinite(v));
  if (finite.length < minObservations) return null;
  const m = mean(finite);
  const sd = sampleStddev(finite);
  if (!Number.isFinite(m) || !Number.isFinite(sd) || sd < STDDEV_NEAR_ZERO) return null;
  const z = (targetValue - m) / sd;
  return Number.isFinite(z) ? z : null;
}

/**
 * Sigmoid 归一化到 0-100: 100 / (1 + exp(-raw / scale)).
 *
 * 边界:
 *   raw = 0     → 50.0
 *   raw = +scale → ~73.1
 *   raw = -scale → ~26.9
 *   raw = +∞     → 100.0
 *   raw = -∞     → 0.0
 *
 * scale 控制曲线陡峭度; 默认 30 让中等极值 (raw ± 30) 落在 ~27/73.
 */
export function sigmoidNormalize(raw: number, scale: number): number {
  if (!Number.isFinite(raw)) return 50;
  if (!Number.isFinite(scale) || scale <= 0) return 50;
  // exp 防溢出: |raw/scale| > 50 时直接饱和
  const x = raw / scale;
  if (x > 50) return 100;
  if (x < -50) return 0;
  return 100 / (1 + Math.exp(-x));
}

/**
 * 由 daily-total 时序计算每日 day-to-day diff (净增/减).
 * 输入: 升序日期 + 总值 array; 输出: 与输入长度 - 1, 第一日无 diff.
 */
export function computeDailyDiffs(
  series: Array<{ date: string; total: number }>
): Array<{ date: string; diff: number }> {
  if (!series || series.length < 2) return [];
  const out: Array<{ date: string; diff: number }> = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const curr = series[i];
    if (Number.isFinite(curr.total) && Number.isFinite(prev.total)) {
      out.push({ date: curr.date, diff: curr.total - prev.total });
    }
  }
  return out;
}

/**
 * 拼装人类可读的中文摘要消息 (用于 UI tooltip / 推送).
 */
export function buildSummaryMessage(result: {
  trade_date: string;
  index_value: number;
  status: string;
  components: MarketSentimentIndexResult['components'];
}): string {
  const grade =
    result.index_value >= 80
      ? '极度乐观'
      : result.index_value >= 60
      ? '偏多'
      : result.index_value >= 40
      ? '中性'
      : result.index_value >= 20
      ? '偏空'
      : '极度悲观';
  const lu = result.components.limit_diff.limit_up_count;
  const ld = result.components.limit_diff.limit_down_count;
  const nor = result.components.northbound.z_score;
  const mar = result.components.margin.z_score;
  const qa = result.components.qa_heat.z_score;
  const fmt = (v: number | null) => (v === null ? '-' : v.toFixed(2));
  return (
    `${result.trade_date} 市场情绪指数=${result.index_value.toFixed(1)} (${grade})。` +
    `涨停${lu ?? '-'}/跌停${ld ?? '-'}，北向z=${fmt(nor)}，融资z=${fmt(mar)}，问答热度z=${fmt(
      qa
    )}` +
    (result.status === 'partial' ? '（partial — 部分维度缺失）' : '')
  );
}

// ---------------------------------------------------------------------------
// 核心服务
// ---------------------------------------------------------------------------

export class MarketSentimentIndexService {
  private dataSource: MarketSentimentDataSource;

  constructor(dataSource?: MarketSentimentDataSource) {
    this.dataSource = dataSource || PRODUCTION_MARKET_SENTIMENT_DATA_SOURCE;
  }

  /**
   * 计算并 (可选) 持久化某交易日的市场情绪指数。
   *
   * @param options.trade_date 交易日 (默认今日 UTC)
   * @param options.lookback_days 横截面 z-score 回看窗 (默认 60)
   * @param options.min_observations z-score 最少样本数 (默认 5)
   * @param options.sigmoid_scale 归一化曲线陡度 (默认 30)
   * @param options.dry_run 不写库 (默认 false)
   */
  async computeAndPersist(
    options: MarketSentimentIndexOptions = {}
  ): Promise<MarketSentimentIndexResult> {
    const tradeDate = normalizeDateOnly(options.trade_date) || todayLocalIso();
    const lookback = Math.max(2, options.lookback_days ?? DEFAULT_PARAMS.lookback_days);
    const minObs = Math.max(2, options.min_observations ?? DEFAULT_PARAMS.min_observations);
    const scale = options.sigmoid_scale ?? DEFAULT_PARAMS.sigmoid_scale;
    const dryRun = options.dry_run === true;

    // lookback 用自然日近似 (覆盖约 1.5x 交易日 ~ lookback*1.5)
    const startDate = isoDateMinusDays(tradeDate, Math.max(lookback * 2, 30));

    // 4 维度并发 fetch, 各自带 fallback 不阻塞
    const [limitUpCount, limitDownCount, northSeries, marginSeries, qaSeries] = await Promise.all([
      safeAwait(this.dataSource.loadLimitUpCount(tradeDate), 0),
      safeAwait(this.dataSource.fetchLimitDownCount(tradeDate), 0),
      safeAwait(this.dataSource.loadNorthboundDailyTotal(startDate, tradeDate), []),
      safeAwait(this.dataSource.fetchMarginDailyNetBuy(startDate, tradeDate), []),
      safeAwait(this.dataSource.loadQADailyTotal(startDate, tradeDate), []),
    ]);

    // ---- 1. limit_diff (涨停-跌停, 无 z-score, 直接当数值 × 权重) ----
    const limitDiff = limitUpCount.value - limitDownCount.value;
    const limitDiffWeighted = limitDiff * SENTIMENT_WEIGHTS.limit_diff;
    const limitDiffMissing = limitUpCount.error !== null && limitDownCount.error !== null;

    // ---- 2. northbound z-score ----
    const northDiffs = computeDailyDiffs(northSeries.value);
    let northZ: number | null = null;
    let northTargetDiff: number | null = null;
    if (northDiffs.length > 0) {
      // 找 tradeDate 的 diff (若 tradeDate 不在 northbound sync 范围则取最近 ≤ tradeDate 的最后一天)
      const target = northDiffs[northDiffs.length - 1];
      if (target && target.date <= tradeDate) {
        northTargetDiff = target.diff;
        const history = northDiffs.slice(0, -1).map(d => d.diff);
        northZ = computeZScore(history, target.diff, minObs);
      }
    }
    const northContribution = (northZ ?? 0) * SENTIMENT_WEIGHTS.northbound;

    // ---- 3. margin z-score ----
    let marginZ: number | null = null;
    let marginTarget: number | null = null;
    if (marginSeries.value.length > 0) {
      const target = marginSeries.value[marginSeries.value.length - 1];
      if (target && target.date <= tradeDate) {
        marginTarget = target.net_buy_yi;
        const history = marginSeries.value.slice(0, -1).map(d => d.net_buy_yi);
        marginZ = computeZScore(history, target.net_buy_yi, minObs);
      }
    }
    const marginContribution = (marginZ ?? 0) * SENTIMENT_WEIGHTS.margin;

    // ---- 4. qa_heat z-score ----
    let qaZ: number | null = null;
    let qaTarget: number | null = null;
    if (qaSeries.value.length > 0) {
      const target = qaSeries.value[qaSeries.value.length - 1];
      if (target && target.date <= tradeDate) {
        qaTarget = target.total;
        const history = qaSeries.value.slice(0, -1).map(d => d.total);
        qaZ = computeZScore(history, target.total, minObs);
      }
    }
    const qaContribution = (qaZ ?? 0) * SENTIMENT_WEIGHTS.qa_heat;

    // ---- 综合 raw + sigmoid normalize ----
    const rawScore = limitDiffWeighted + northContribution + marginContribution + qaContribution;
    const indexValue = sigmoidNormalize(rawScore, scale);

    // ---- 维度可用性 → status ----
    const dimensionAvailability = {
      limit_diff: !limitDiffMissing,
      northbound: northZ !== null,
      margin: marginZ !== null,
      qa_heat: qaZ !== null,
    };
    const availableCount = Object.values(dimensionAvailability).filter(Boolean).length;
    const status: 'ok' | 'partial' | 'failed' =
      availableCount === 4 ? 'ok' : availableCount === 0 ? 'failed' : 'partial';

    const components: MarketSentimentIndexResult['components'] = {
      limit_diff: {
        raw_value: limitDiff,
        z_score: null,
        weight: SENTIMENT_WEIGHTS.limit_diff,
        contribution: limitDiffWeighted,
        observation_count: 1,
        error: limitDiffMissing
          ? `limit_up_error=${limitUpCount.error} limit_down_error=${limitDownCount.error}`
          : null,
        limit_up_count: limitUpCount.error ? null : limitUpCount.value,
        limit_down_count: limitDownCount.error ? null : limitDownCount.value,
      },
      northbound: {
        raw_value: northTargetDiff,
        z_score: northZ,
        weight: SENTIMENT_WEIGHTS.northbound,
        contribution: northContribution,
        observation_count: northDiffs.length,
        error: northSeries.error,
      },
      margin: {
        raw_value: marginTarget,
        z_score: marginZ,
        weight: SENTIMENT_WEIGHTS.margin,
        contribution: marginContribution,
        observation_count: marginSeries.value.length,
        error: marginSeries.error,
      },
      qa_heat: {
        raw_value: qaTarget,
        z_score: qaZ,
        weight: SENTIMENT_WEIGHTS.qa_heat,
        contribution: qaContribution,
        observation_count: qaSeries.value.length,
        error: qaSeries.error,
      },
    };

    const componentsJson: Record<string, unknown> = {
      limit_diff: components.limit_diff,
      northbound: components.northbound,
      margin: components.margin,
      qa_heat: components.qa_heat,
      params: {
        lookback_days: lookback,
        min_observations: minObs,
        sigmoid_scale: scale,
        start_date: startDate,
      },
    };

    const message = buildSummaryMessage({
      trade_date: tradeDate,
      index_value: indexValue,
      status,
      components,
    });

    let persisted = false;
    if (!dryRun) {
      try {
        await this.dataSource.saveIndex({
          trade_date: tradeDate,
          index_value: Number(indexValue.toFixed(3)),
          raw_score: Number(rawScore.toFixed(4)),
          limit_up_count: components.limit_diff.limit_up_count,
          limit_down_count: components.limit_diff.limit_down_count,
          northbound_net_buy_zscore: northZ,
          margin_net_buy_zscore: marginZ,
          qa_heat_zscore: qaZ,
          components_json: componentsJson,
          status,
          message,
        });
        persisted = true;
      } catch (error) {
        logger.warn(
          `MarketSentiment.saveIndex(${tradeDate}) failed: ${
            (error as Error).message
          } — returning result anyway`
        );
      }
    }

    return {
      trade_date: tradeDate,
      index_value: Number(indexValue.toFixed(3)),
      raw_score: Number(rawScore.toFixed(4)),
      status,
      message,
      persisted,
      dry_run: dryRun,
      components,
      params: {
        lookback_days: lookback,
        min_observations: minObs,
        sigmoid_scale: scale,
      },
    };
  }

  /**
   * 列表查询: 最近 N 天的指数 (UI 时序图消费)。
   *
   * @param days 默认 30, 上限 365 (防滥用)
   */
  async listRecentIndex(days = 30): Promise<MarketSentimentIndex[]> {
    const limit = Math.max(1, Math.min(365, Math.floor(days)));
    return MarketSentimentIndex.findAll({
      order: [['trade_date', 'DESC']],
      limit,
    });
  }
}

/** 生产环境 singleton */
export const marketSentimentIndexService = new MarketSentimentIndexService();

// ---------------------------------------------------------------------------
// 私有 helpers
// ---------------------------------------------------------------------------

/** 包装 Promise，失败时返回 {value: fallback, error: msg}；成功 {value, error: null} */
async function safeAwait<T>(
  p: Promise<T>,
  fallback: T
): Promise<{ value: T; error: string | null }> {
  try {
    const v = await p;
    return { value: v, error: null };
  } catch (e) {
    return { value: fallback, error: (e as Error).message };
  }
}

/** 取本地 UTC 当日 ISO 字符串 */
function todayLocalIso(): string {
  const now = new Date();
  return normalizeDateOnly(now)!;
}
