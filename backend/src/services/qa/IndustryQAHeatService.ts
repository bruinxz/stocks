/**
 * IndustryQAHeatService — US-121 QA-004 行业级投资者问答热度榜.
 *
 * 消费 `EastMoneyQAStat` (US-038 QA-002 已落表的按周聚合) + `Stock` (industry 字段),
 * 不再二次拉远端 / 不重复 NLP 聚合;
 * 输入 industry → 输出 top N 个 "本行业最活跃股票" snapshot.
 *
 * **核心契约** (与 docs/trader-system/83_ai_qa_topic.md §B.2 IndustryQAHeatService 对齐):
 *
 *   for each industry:
 *     rank stocks by:
 *       - 7d questions count        (主权重, 行业级热度的最直接代理)
 *       - 7d answer rate            (副权重, 公司响应度)
 *       - 7d top_subtopic           (展示用, 不参与排名)
 *     output top 10 most active in industry
 *
 * 与 QALeadingSignalDetector 的分工:
 *   - QALeadingSignalDetector: per-stock 时序信号 (周环比 + earnings 主题), 输出"事件";
 *   - IndustryQAHeatService:   per-industry 横切 ranking, 输出"截面排行".
 *
 * **active_score 设计**:
 *   分数 ∈ [0, ∞), 不归一化 (各行业问答总量差异巨大, 跨行业归一化会丢失信息).
 *   组合规则:
 *     active_score = questions_count_7d * (1 + ANSWER_RATE_WEIGHT * answer_rate_7d)
 *   - 当 answer_rate_7d=0   → active_score = questions_count_7d        (基线热度)
 *   - 当 answer_rate_7d=1   → active_score = questions_count_7d * 1.5  (满分加成 50%)
 *   设计取舍: 用乘法 + 1.0 floor 而非加法权重, 防"零问题 + 高回答率"虚高;
 *   ANSWER_RATE_WEIGHT=0.5 是温和加成, 不让 answer_rate 喧宾夺主 (业务侧确认问题数才是行业热度核心).
 *
 * **关键边界**:
 *   - lookback_days ∈ [1, 365], 默认 7;
 *   - top ∈ [1, 100], 默认 10;
 *   - industry 必填 (trim 后非空), 否则 throw (caller 必须给行业);
 *   - 行业无任何 listed stock → 返回 { items: [], total_stocks: 0 } (非异常);
 *   - 行业有 stock 但 lookback 窗内无任何 stat 行 → 同上;
 *   - lookback 内单 stock 多周 stat → questions_count 直接相加, answer_rate
 *     用加权 (sum answer_count / sum questions_count, 避免直接平均把零提问周拉低);
 *   - top_subtopic_7d 按 raw_payload.subtopic_distribution 加和后挑 max-count;
 *     若 raw_payload 缺/格式异常, 降级用 stat.top_subtopic 出现次数 (按 priority 平票);
 *   - **fail-OPEN on DB 故障** — top-level service.getHotStocksInIndustry 不抛,
 *     return { items: [], total_stocks: 0, error } 让 controller 优雅 502.
 *
 * **6 项 AI feature checklist** (与 QAStatAggregator / QALeadingSignalDetector 同款):
 *   1. **DataSource DI** — `IndustryQAHeatDataSource` 接口
 *      (listStocksByIndustry / listStatsForStocksSince); 生产实现走 Stock + EastMoneyQAStat;
 *      单测注入 fake;
 *   2. **pure helpers 全 export** — computeActiveScore / pickTopSubtopicFromStats /
 *      aggregateStatsByStock / rankTopActive / clampLookbackDays / clampTopN /
 *      WEIGHTS;
 *   3. **plain-object 返回类型** `StockActiveSnapshot` 不耦合 Sequelize;
 *   4. **签名稳定 + 单元可重放** — 同 stat 输入同 ranking, 无 Date.now() (cutoff
 *      用 now: Date 参数), 无 IO;
 *   5. **fail-OPEN** — DataSource throw 时 service 层 catch + 返空结果;
 *   6. **双重防御 try/catch** — 内层 listStatsForStocksSince catch + 外层 service catch.
 *
 * **non-goals**:
 *   - 本 service **不** 跨行业排名 (业务上 "电池行业 vs 银行行业的 question 数" 不可比);
 *   - 本 service **不** 落库 (heat 是 derived view, 与 leading_signal 同款不存储);
 *   - 本 service **不** 写 RiskAlert.
 */

import { Op } from 'sequelize';
import { EastMoneyQAStat } from '../../models/EastMoneyQAStat';
import { Stock } from '../../models/Stock';
import {
  TOPIC_SUBCATEGORIES,
  TOPIC_SUBCATEGORY_PRIORITY,
  SUBTOPIC_VALUES,
  SubtopicCategory,
} from '../EastMoneyQATopicService';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// 常量 (Object.freeze, 单测验冻结)
// ---------------------------------------------------------------------------

/** 排名权重 — 改动必须改字典. */
export const WEIGHTS = Object.freeze({
  /** answer_rate 加成上限系数; active_score = qcount * (1 + W * rate). */
  ANSWER_RATE_WEIGHT: 0.5,
});

export const DEFAULT_LOOKBACK_DAYS = 7;
export const MAX_LOOKBACK_DAYS = 365;
export const DEFAULT_TOP_N = 10;
export const MAX_TOP_N = 100;

// ---------------------------------------------------------------------------
// Plain-object 返回类型
// ---------------------------------------------------------------------------

/** 单只股票在 lookback 窗内的活跃度快照. */
export interface StockActiveSnapshot {
  /** 6 位股票代码. */
  stock_code: string;
  /** 股票简称 (优先取 Stock.name, 退而求其次 EastMoneyQAStat.stock_name). */
  stock_name: string | null;
  /** 所属行业 (Stock.industry). */
  industry: string;
  /** lookback 窗内 questions_count 之和. */
  questions_count_7d: number;
  /** lookback 窗内 answer_count 之和. */
  answer_count_7d: number;
  /** 加权答复率 = answer_count_7d / questions_count_7d; 0 提问时 0. ∈ [0, 1]. */
  answer_rate_7d: number;
  /** lookback 窗内 max-count subtopic (subtopic_distribution 加和后挑). */
  top_subtopic_7d: SubtopicCategory;
  /** 复合活跃分; 越大越活跃 (公式见 computeActiveScore). */
  active_score: number;
  /** lookback 窗内被聚合的周数 (透明度). */
  weeks_covered: number;
}

export interface IndustryQAHeatResult {
  /** 行业名. */
  industry: string;
  /** lookback 天数. */
  lookback_days: number;
  /** top N 上限. */
  top_n: number;
  /** 行业内已上市股票总数 (DataSource 报告; ranking 池上限). */
  total_stocks: number;
  /** ranking items, 已按 active_score desc + stock_code asc 稳定排序; 上限 top_n. */
  items: StockActiveSnapshot[];
  /** 仅 fail-OPEN 时填; happy path 缺省. */
  error?: string;
}

// ---------------------------------------------------------------------------
// 纯函数 helpers (全 export, 便单测脱 DB)
// ---------------------------------------------------------------------------

/**
 * 算复合活跃分.
 *
 * 公式: questions_count * (1 + ANSWER_RATE_WEIGHT * answer_rate)
 *
 * 边界:
 *   - questions_count 负数 / 非有限 → 0;
 *   - answer_rate clamp 到 [0, 1] (容错; aggregator 已保证, 防 DECIMAL 漂移);
 *   - 输出非负有限 (失败兜底 0).
 *
 * 纯函数, 无 DB.
 */
export function computeActiveScore(questionsCount: number, answerRate: number): number {
  if (!Number.isFinite(questionsCount) || questionsCount <= 0) return 0;
  let rate = Number.isFinite(answerRate) ? answerRate : 0;
  if (rate < 0) rate = 0;
  if (rate > 1) rate = 1;
  const score = questionsCount * (1 + WEIGHTS.ANSWER_RATE_WEIGHT * rate);
  return Number.isFinite(score) ? score : 0;
}

/** 截断 lookback_days 到 [1, MAX_LOOKBACK_DAYS]. */
export function clampLookbackDays(days: number | undefined): number {
  if (days === undefined || days === null) return DEFAULT_LOOKBACK_DAYS;
  if (!Number.isFinite(days)) return DEFAULT_LOOKBACK_DAYS;
  const n = Math.floor(days);
  if (n < 1) return 1;
  if (n > MAX_LOOKBACK_DAYS) return MAX_LOOKBACK_DAYS;
  return n;
}

/** 截断 top_n 到 [1, MAX_TOP_N]. */
export function clampTopN(n: number | undefined): number {
  if (n === undefined || n === null) return DEFAULT_TOP_N;
  if (!Number.isFinite(n)) return DEFAULT_TOP_N;
  const v = Math.floor(n);
  if (v < 1) return 1;
  if (v > MAX_TOP_N) return MAX_TOP_N;
  return v;
}

/**
 * 从 lookback 内多周 stat 聚合 subtopic distribution → 选 top.
 *
 * 优先用 raw_payload.subtopic_distribution (aggregator 已细分 26 类计数);
 * 缺失/异常时降级用 stat.top_subtopic 出现次数;
 * 全空 → OTHER_GENERAL (与 pickTopSubtopic 兜底一致).
 *
 * 平票按 TOPIC_SUBCATEGORY_PRIORITY 升序 (business-value-first, deterministic).
 *
 * 纯函数, 无 DB.
 */
export function pickTopSubtopicFromStats(stats: StatLike[]): SubtopicCategory {
  if (!Array.isArray(stats) || stats.length === 0) return TOPIC_SUBCATEGORIES.OTHER_GENERAL;

  // counts[sub] 累加 (优先 raw_payload, 降级 top_subtopic 次数=1)
  const counts: Partial<Record<SubtopicCategory, number>> = {};
  for (const s of stats) {
    const dist = extractSubtopicDistribution(s);
    if (dist) {
      for (const [sub, c] of Object.entries(dist)) {
        if (!isKnownSubtopic(sub)) continue;
        const n = Number(c);
        if (!Number.isFinite(n) || n <= 0) continue;
        counts[sub as SubtopicCategory] = (counts[sub as SubtopicCategory] ?? 0) + n;
      }
    } else if (isKnownSubtopic(s.top_subtopic)) {
      const sub = s.top_subtopic as SubtopicCategory;
      counts[sub] = (counts[sub] ?? 0) + 1;
    }
  }

  let maxCount = 0;
  for (const sub of SUBTOPIC_VALUES) {
    const c = counts[sub] || 0;
    if (c > maxCount) maxCount = c;
  }
  if (maxCount === 0) return TOPIC_SUBCATEGORIES.OTHER_GENERAL;

  const winners = SUBTOPIC_VALUES.filter(s => (counts[s] || 0) === maxCount);
  winners.sort((a, b) => TOPIC_SUBCATEGORY_PRIORITY[a] - TOPIC_SUBCATEGORY_PRIORITY[b]);
  return winners[0];
}

function isKnownSubtopic(s: string | undefined | null): boolean {
  if (typeof s !== 'string') return false;
  return (SUBTOPIC_VALUES as readonly string[]).includes(s);
}

function extractSubtopicDistribution(s: StatLike): Record<string, number> | null {
  const payload = s.raw_payload;
  if (!payload || typeof payload !== 'object') return null;
  const dist = (payload as Record<string, unknown>).subtopic_distribution;
  if (!dist || typeof dist !== 'object') return null;
  return dist as Record<string, number>;
}

/**
 * 把 (stock_code → stat[]) 聚合成 (stock_code → StockActiveSnapshot) 不含 industry.
 *
 * - questions_count_7d / answer_count_7d 直接 sum;
 * - answer_rate_7d = sum answer / sum questions; 0 提问时 0;
 * - top_subtopic_7d 调 pickTopSubtopicFromStats;
 * - active_score 调 computeActiveScore;
 * - weeks_covered = stat.length (透明度);
 * - stock_name 取 stats[*].stock_name 第一个非空 (聚合时点)
 *   — 多周可能不同, 取最近一周 (输入排序无要求, 先按 week_start desc 排再取).
 *
 * 纯函数, 无 DB.
 */
export function aggregateStatsByStock(
  statsByStock: Map<string, StatLike[]>
): Map<string, Omit<StockActiveSnapshot, 'industry'>> {
  const out = new Map<string, Omit<StockActiveSnapshot, 'industry'>>();
  statsByStock.forEach((stats, code) => {
    if (!Array.isArray(stats) || stats.length === 0) return;

    let qSum = 0;
    let aSum = 0;
    for (const s of stats) {
      const q = Number(s.questions_count);
      const a = Number(s.answer_count);
      if (Number.isFinite(q) && q > 0) qSum += q;
      if (Number.isFinite(a) && a > 0) aSum += a;
    }
    // clamp aSum 不超过 qSum (DB 漂移防御)
    if (aSum > qSum) aSum = qSum;
    const rate = qSum > 0 ? aSum / qSum : 0;

    // stock_name: week_start 最近一周非空 stock_name
    const sortedByWeekDesc = [...stats].sort((x, y) =>
      x.week_start < y.week_start ? 1 : x.week_start > y.week_start ? -1 : 0
    );
    let stockName: string | null = null;
    for (const s of sortedByWeekDesc) {
      if (s.stock_name && String(s.stock_name).trim() !== '') {
        stockName = String(s.stock_name);
        break;
      }
    }

    const topSub = pickTopSubtopicFromStats(stats);
    const active = computeActiveScore(qSum, rate);

    out.set(code, {
      stock_code: code,
      stock_name: stockName,
      questions_count_7d: qSum,
      answer_count_7d: aSum,
      answer_rate_7d: Number.isFinite(rate) ? Math.round(rate * 1000) / 1000 : 0,
      top_subtopic_7d: topSub,
      active_score: Number.isFinite(active) ? Math.round(active * 1000) / 1000 : 0,
      weeks_covered: stats.length,
    });
  });
  return out;
}

/**
 * 排名 + 截取 top N.
 *
 * 排序:
 *   1. active_score desc;
 *   2. questions_count_7d desc (tie-break 1: 同分时问题数多者前);
 *   3. answer_rate_7d desc (tie-break 2);
 *   4. stock_code asc (deterministic, 防 flaky test).
 *
 * 过滤: active_score <= 0 直接剔除 (零热度不展示, 防榜单注水).
 *
 * 纯函数, 无 DB.
 */
export function rankTopActive(
  snapshots: StockActiveSnapshot[],
  topN: number
): StockActiveSnapshot[] {
  const filtered = snapshots.filter(s => s.active_score > 0);
  filtered.sort((a, b) => {
    if (a.active_score !== b.active_score) return b.active_score - a.active_score;
    if (a.questions_count_7d !== b.questions_count_7d)
      return b.questions_count_7d - a.questions_count_7d;
    if (a.answer_rate_7d !== b.answer_rate_7d) return b.answer_rate_7d - a.answer_rate_7d;
    return a.stock_code < b.stock_code ? -1 : a.stock_code > b.stock_code ? 1 : 0;
  });
  return filtered.slice(0, Math.max(1, topN));
}

// ---------------------------------------------------------------------------
// StatLike — 鸭子类型, EastMoneyQAStat / plain obj 都可塞入
// ---------------------------------------------------------------------------

export interface StatLike {
  stock_code: string;
  stock_name?: string | null;
  week_start: string;
  questions_count: number;
  answer_count: number;
  answer_rate: number;
  top_subtopic: string;
  /** raw_payload.subtopic_distribution 可选, 缺失时降级用 top_subtopic. */
  raw_payload?: Record<string, unknown> | null;
}

/** Stock 行的简表 (DataSource 返回). */
export interface StockBasicLike {
  stock_code: string;
  stock_name: string | null;
}

// ---------------------------------------------------------------------------
// DataSource DI
// ---------------------------------------------------------------------------

export interface IndustryQAHeatDataSource {
  /** 列出某行业全部 is_listed 的股票 (6 位代码 + 名称). */
  listStocksByIndustry(industry: string): Promise<StockBasicLike[]>;
  /** 拉 stocks 列表在 sinceIso (含) 之后的全部 EastMoneyQAStat 行. */
  listStatsForStocksSince(stockCodes: string[], sinceIso: string): Promise<StatLike[]>;
}

/**
 * 生产 DataSource — Stock + EastMoneyQAStat.
 *
 * symbol→stock_code 转换: Stock.symbol 是 "600519.SH" 形式, EastMoneyQAStat.stock_code
 * 是 "600519" 6 位纯码; 这里 strip 后缀 + 校验 6 位数字, 失败则丢弃.
 */
export class DefaultIndustryQAHeatDataSource implements IndustryQAHeatDataSource {
  async listStocksByIndustry(industry: string): Promise<StockBasicLike[]> {
    const rows = await Stock.findAll({
      where: {
        industry,
        is_listed: true,
        [Op.or]: [{ type: 'stock' }, { type: null }],
      },
      attributes: ['symbol', 'name'],
    });
    const out: StockBasicLike[] = [];
    for (const r of rows) {
      const sym = String(r.symbol || '').trim();
      const pure = stripSymbolSuffix(sym);
      if (!/^\d{6}$/.test(pure)) continue;
      out.push({
        stock_code: pure,
        stock_name: r.name ? String(r.name) : null,
      });
    }
    return out;
  }

  async listStatsForStocksSince(stockCodes: string[], sinceIso: string): Promise<StatLike[]> {
    if (stockCodes.length === 0) return [];
    const rows = await EastMoneyQAStat.findAll({
      where: {
        stock_code: { [Op.in]: stockCodes },
        week_start: { [Op.gte]: sinceIso },
      },
      order: [['week_start', 'DESC']],
    });
    return rows.map(rowToStatLike);
  }
}

/** Sequelize EastMoneyQAStat / plain obj 共用. */
export function rowToStatLike(row: EastMoneyQAStat | StatLike): StatLike {
  const r = row as unknown as Record<string, unknown>;
  return {
    stock_code: String(r.stock_code),
    stock_name: (r.stock_name ?? null) as string | null,
    week_start: String(r.week_start),
    questions_count: Number(r.questions_count),
    answer_count: Number(r.answer_count),
    answer_rate: Number(r.answer_rate),
    top_subtopic: String(r.top_subtopic),
    raw_payload: (r.raw_payload ?? null) as Record<string, unknown> | null,
  };
}

/** "600519.SH" / "sh.600519" / "600519" → "600519". */
export function stripSymbolSuffix(symbol: string): string {
  const trimmed = String(symbol || '').trim();
  // "sh.600519" / "sz.000001"
  const prefixMatch = trimmed.match(/^(?:sh|sz|bj)\.(\d{6})$/i);
  if (prefixMatch) return prefixMatch[1];
  // "600519.SH" / "000001.SZ"
  const suffixMatch = trimmed.match(/^(\d{6})\.(?:sh|sz|bj)$/i);
  if (suffixMatch) return suffixMatch[1];
  // 已是 6 位纯码
  if (/^\d{6}$/.test(trimmed)) return trimmed;
  return trimmed;
}

export const PRODUCTION_INDUSTRY_QA_HEAT_DATA_SOURCE: IndustryQAHeatDataSource =
  new DefaultIndustryQAHeatDataSource();

// ---------------------------------------------------------------------------
// 时间 helper (单测可 mock now)
// ---------------------------------------------------------------------------

/** 当前时间减 lookback_days 的 ISO date — service 层调用, 单测可 mock. */
export function getSinceIso(lookbackDays: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() - lookbackDays);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Service 入口
// ---------------------------------------------------------------------------

export interface GetHotStocksOptions {
  /** 回看天数 (默认 7). */
  lookback_days?: number;
  /** top N (默认 10). */
  top?: number;
  /** 单测可注入 now (默认 new Date()). */
  now?: Date;
}

export class IndustryQAHeatService {
  private readonly dataSource: IndustryQAHeatDataSource;

  constructor(dataSource: IndustryQAHeatDataSource = PRODUCTION_INDUSTRY_QA_HEAT_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 行业内 top N 活跃股票 — fail-OPEN.
   *
   * - industry trim 后必须非空, 否则 throw (caller 必须给行业);
   * - DataSource 任一步 throw → service 层 catch + 返 { items: [], error };
   * - 行业内无 stock / lookback 内无 stat → { items: [], total_stocks: actual };
   * - 输出 items 按 rankTopActive 稳定排序.
   */
  async getHotStocksInIndustry(
    industry: string,
    options: GetHotStocksOptions = {}
  ): Promise<IndustryQAHeatResult> {
    const trimmedIndustry = String(industry || '').trim();
    if (trimmedIndustry === '') {
      throw new Error('IndustryQAHeatService.getHotStocksInIndustry: industry 参数必填');
    }

    const lookbackDays = clampLookbackDays(options.lookback_days);
    const topN = clampTopN(options.top);
    const now = options.now ?? new Date();
    const sinceIso = getSinceIso(lookbackDays, now);

    try {
      const stocks = await this.dataSource.listStocksByIndustry(trimmedIndustry);
      if (stocks.length === 0) {
        return {
          industry: trimmedIndustry,
          lookback_days: lookbackDays,
          top_n: topN,
          total_stocks: 0,
          items: [],
        };
      }

      // stock_code → StockBasicLike (industry name lookup)
      const stockMeta = new Map<string, StockBasicLike>();
      for (const s of stocks) stockMeta.set(s.stock_code, s);

      let stats: StatLike[] = [];
      try {
        stats = await this.dataSource.listStatsForStocksSince(
          Array.from(stockMeta.keys()),
          sinceIso
        );
      } catch (err: any) {
        // 内层 catch — DB 故障不阻断 service, 返空 ranking 让 caller 优雅降级
        logger.warn(
          `IndustryQAHeatService.listStatsForStocksSince failed: ${err.message} ` +
            `(industry=${trimmedIndustry})`
        );
        return {
          industry: trimmedIndustry,
          lookback_days: lookbackDays,
          top_n: topN,
          total_stocks: stockMeta.size,
          items: [],
          error: `stats unavailable: ${err.message}`,
        };
      }

      // group by stock_code
      const statsByStock = new Map<string, StatLike[]>();
      for (const s of stats) {
        if (!stockMeta.has(s.stock_code)) continue; // 跨行业脏数据 guard
        const arr = statsByStock.get(s.stock_code) ?? [];
        arr.push(s);
        statsByStock.set(s.stock_code, arr);
      }

      const partials = aggregateStatsByStock(statsByStock);
      const snapshots: StockActiveSnapshot[] = [];
      partials.forEach((p, code) => {
        const meta = stockMeta.get(code);
        // 优先取 Stock.name (更权威), 退化用 stat.stock_name
        const name = meta?.stock_name ?? p.stock_name ?? null;
        snapshots.push({
          ...p,
          stock_name: name,
          industry: trimmedIndustry,
        });
      });

      const items = rankTopActive(snapshots, topN);
      return {
        industry: trimmedIndustry,
        lookback_days: lookbackDays,
        top_n: topN,
        total_stocks: stockMeta.size,
        items,
      };
    } catch (err: any) {
      // 外层 catch — listStocksByIndustry throw 或其他未捕获异常
      logger.warn(
        `IndustryQAHeatService.getHotStocksInIndustry failed: ${err.message} ` +
          `(industry=${trimmedIndustry})`
      );
      return {
        industry: trimmedIndustry,
        lookback_days: lookbackDays,
        top_n: topN,
        total_stocks: 0,
        items: [],
        error: err.message,
      };
    }
  }
}

/** 生产 singleton. */
export const industryQAHeatService = new IndustryQAHeatService();
