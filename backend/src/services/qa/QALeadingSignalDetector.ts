/**
 * QALeadingSignalDetector — US-039 QA-003 投资者问答 leading signal 检测器.
 *
 * 消费 `EastMoneyQAStat` (US-038 QA-002 落表的按周聚合) — 不再二次拉远端,
 * 不重复 NLP/聚合; 输入 N 周 stat 行 → 输出 leading_signal 列表.
 *
 * **3 类信号** (与 docs/trader-system/83_ai_qa_topic.md §B.2 leading-signal 模板对齐):
 *
 *   1. **earnings_bullish** (P0 主验收对应)
 *      触发: questions_growth_pct > +200% AND answer_rate > 50%
 *      含义: "公司主动 + 散户密集关注" → 业绩超预期 / 重大利好前瞻
 *
 *   2. **earnings_bearish**
 *      触发: questions_growth_pct > +200% AND answer_rate < 10%
 *      含义: "散户集中关注但公司回避" → 业绩雷 / 负面前瞻
 *
 *   3. **earnings_forecast_leading**
 *      触发: top_subtopic = EARNINGS_FORECAST AND answer_template_score < 0.3
 *            (要求该周 answer_count > 0; null template_score 不触发)
 *      含义: "本周问答主题集中业绩预告 + 公司高质量回答" → 业绩预增信号
 *
 * **核心契约 (与 docs §E.4 — "至少识别 5 个业绩 leading 信号在最近 90 天" 对齐)**:
 *   - detectForStocks() 接受 stock_code[] + lookback_days, 内部按 stock 调
 *     `aggregator.listByStock()` 拉每只股票最近 lookback_weeks 的 stat 行,
 *     再 per-stock 按 week 计算 questions_growth_pct (vs 上周) + 触发条件;
 *   - 输出 `QALeadingSignal[]` 已按 week_start desc + signal_type 稳定排序;
 *   - **fail-OPEN**: per-stock DB 故障不抛, 仅 logger.warn, 继续下一只股票
 *     (与 QAStatAggregator 同款) — 监控/AI 层不应阻塞业务主流程.
 *
 * **6 项 AI feature checklist** (与 QAStatAggregator / EastMoneyQATopicService 同款):
 *   1. **DataSource DI** — `QALeadingSignalDataSource` 接口 (listByStock);
 *      生产实现走 qaStatAggregator singleton; 单测注入 fake;
 *   2. **pure helpers 全 export** — computeQuestionsGrowthPct / classifySignalLevel /
 *      detectForStat / detectForStockStats / SIGNAL_THRESHOLDS;
 *   3. **plain-object 返回类型** `QALeadingSignal` 不耦合 Sequelize 模型;
 *   4. **签名稳定 + 单元可重放** — 同 stat 序列同 detector 输出一致, 无 Date.now() / 无 IO;
 *   5. **fail-OPEN on listByStock 故障** — per-stock try/catch 吞错;
 *   6. **双重防御 try/catch** — DataSource 内 catch + service 层再 catch.
 *
 * **non-goals (与 QA-009 / QA-010 分工)**:
 *   - 本 service **不** 写 RiskAlert (告警通路由 SentimentAnalyzer / Factor 触发);
 *   - 本 service **不** 落库 (signal 是 derived view, 不重复存储);
 *   - 本 service **不** 跨周期合并 (按周 stat 已经是最小决策单元).
 */

import { EastMoneyQAStat } from '../../models/EastMoneyQAStat';
import { qaStatAggregator, QAStatAggregator } from './QAStatAggregator';
import { TOPIC_SUBCATEGORIES, SubtopicCategory } from '../EastMoneyQATopicService';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// 阈值常量 (单 source-of-truth, 单测验冻结)
// ---------------------------------------------------------------------------

/**
 * Leading signal 触发阈值 — Object.freeze, 业务侧改动必须改字典.
 *
 * 阈值来源: docs/trader-system/83_ai_qa_topic.md §B.2 leading-signal 模板
 * (questions_growth > 200% / answer_rate 50% / 10% / template_score 0.3).
 *
 * 数值含义:
 *   - questions_growth_pct: 比例 (1.0 = +100%, 2.0 = +200%);
 *   - answer_rate: ∈ [0, 1];
 *   - answer_template_score: ∈ [0, 1] (1 = 纯模板, 0 = 高质量).
 *
 * 边界比较为**严格大于/小于** (不含等号), 防止默认值 = 阈值的边界假信号.
 */
export const SIGNAL_THRESHOLDS = Object.freeze({
  /** earnings_bullish/bearish: 周增 > 200% 才视为"暴增" */
  QUESTIONS_GROWTH_PCT_HIGH: 2.0,
  /** earnings_bullish: 答复率 > 50% */
  ANSWER_RATE_HIGH: 0.5,
  /** earnings_bearish: 答复率 < 10% */
  ANSWER_RATE_LOW: 0.1,
  /** earnings_forecast_leading: 模板分 < 0.3 (高质量回答) */
  TEMPLATE_SCORE_HIGH_QUALITY: 0.3,
  /** earnings_bullish/bearish: 本周 questions_count 至少 ≥ 此数, 防小样本噪音 */
  MIN_QUESTIONS_COUNT: 5,
  /** earnings_forecast_leading: 至少 ≥ 此 answer_count 才计 */
  MIN_ANSWER_COUNT: 3,
});

/** 信号类型, 与字符串字面值绑定 (UI/前端枚举对齐). */
export const SIGNAL_TYPES = Object.freeze({
  EARNINGS_BULLISH: 'earnings_bullish' as const,
  EARNINGS_BEARISH: 'earnings_bearish' as const,
  EARNINGS_FORECAST_LEADING: 'earnings_forecast_leading' as const,
});

export type QALeadingSignalType = (typeof SIGNAL_TYPES)[keyof typeof SIGNAL_TYPES];

/** 信号强度等级 (前端展示 / RiskAlert severity 映射用). */
export const SIGNAL_LEVELS = Object.freeze({
  STRONG: 'strong' as const,
  MODERATE: 'moderate' as const,
});

export type QALeadingSignalLevel = (typeof SIGNAL_LEVELS)[keyof typeof SIGNAL_LEVELS];

// ---------------------------------------------------------------------------
// Plain-object 返回类型
// ---------------------------------------------------------------------------

export interface QALeadingSignal {
  /** 6 位股票代码. */
  stock_code: string;
  /** 股票简称 (聚合时点). */
  stock_name: string | null;
  /** 该周周一 ISO 日期 (YYYY-MM-DD). */
  week_start: string;
  /** 信号类型. */
  signal_type: QALeadingSignalType;
  /** 信号等级 (前端 color / RiskAlert 映射). */
  level: QALeadingSignalLevel;
  /** 周提问数 (本周). */
  questions_count: number;
  /** 周回答数 (本周). */
  answer_count: number;
  /** 周答复率 ∈ [0, 1]. */
  answer_rate: number;
  /** vs 上周问题数增长率 (比例; +2.0 = +200%; null = 无上周 baseline). */
  questions_growth_pct: number | null;
  /** top_subtopic. */
  top_subtopic: SubtopicCategory;
  /** 周模板分 ∈ [0, 1] 或 null (null = 周无回答). */
  answer_template_score: number | null;
  /** 人话理由, UI 直接展示. */
  reason: string;
}

// ---------------------------------------------------------------------------
// 纯函数 helpers (全 export 便单测脱 DB)
// ---------------------------------------------------------------------------

/**
 * 算周 questions_count 的同股环比增长率.
 *
 * 返回比例 (0.0 = 持平, 1.0 = +100%, 2.0 = +200%);
 * - prev = 0 且 curr > 0 → Infinity (∞ 增长, 等价于无穷利好); UI 展示请显式处理;
 * - prev = 0 且 curr = 0 → null (无 baseline, 无法判断);
 * - curr / prev 任一非有限 / 负数 → null (保守 fail-soft).
 *
 * 纯函数, 无 DB.
 */
export function computeQuestionsGrowthPct(
  currQuestions: number,
  prevQuestions: number
): number | null {
  if (!Number.isFinite(currQuestions) || !Number.isFinite(prevQuestions)) return null;
  if (currQuestions < 0 || prevQuestions < 0) return null;
  if (prevQuestions === 0) {
    return currQuestions === 0 ? null : Number.POSITIVE_INFINITY;
  }
  return (currQuestions - prevQuestions) / prevQuestions;
}

/**
 * 把单 stat 行 + 上周 baseline 评估为 0..N 个信号.
 *
 * 同周可能命中多个信号 (例: earnings_bullish + earnings_forecast_leading),
 * 全部返回; caller 自行去重/合并.
 *
 * 纯函数, 无 DB.
 */
export function detectForStat(args: { curr: StatLike; prev?: StatLike | null }): QALeadingSignal[] {
  const { curr, prev } = args;
  const out: QALeadingSignal[] = [];

  // prev=null/undefined → 没有上周 baseline; growth 留 null, 不触发 growth 类信号
  // (与 "prev=0 curr>0 = +Inf" 严格区分 — 后者是 "上周聚合存在 + 实际无提问").
  const growth =
    prev === null || prev === undefined
      ? null
      : computeQuestionsGrowthPct(Number(curr.questions_count), Number(prev.questions_count));

  const answerRate = Number(curr.answer_rate);
  const templateScore =
    curr.answer_template_score === null || curr.answer_template_score === undefined
      ? null
      : Number(curr.answer_template_score);

  const hasEnoughQuestions = curr.questions_count >= SIGNAL_THRESHOLDS.MIN_QUESTIONS_COUNT;
  const growthExceeds = growth !== null && growth > SIGNAL_THRESHOLDS.QUESTIONS_GROWTH_PCT_HIGH;

  // 1) earnings_bullish: 增 > 200% + 答复率 > 50%
  if (
    hasEnoughQuestions &&
    growthExceeds &&
    Number.isFinite(answerRate) &&
    answerRate > SIGNAL_THRESHOLDS.ANSWER_RATE_HIGH
  ) {
    out.push(
      buildSignal({
        curr,
        type: SIGNAL_TYPES.EARNINGS_BULLISH,
        level: SIGNAL_LEVELS.STRONG,
        growth,
        reason: buildGrowthReason(growth, answerRate, /*bullish*/ true),
      })
    );
  }

  // 2) earnings_bearish: 增 > 200% + 答复率 < 10%
  if (
    hasEnoughQuestions &&
    growthExceeds &&
    Number.isFinite(answerRate) &&
    answerRate < SIGNAL_THRESHOLDS.ANSWER_RATE_LOW
  ) {
    out.push(
      buildSignal({
        curr,
        type: SIGNAL_TYPES.EARNINGS_BEARISH,
        level: SIGNAL_LEVELS.STRONG,
        growth,
        reason: buildGrowthReason(growth, answerRate, /*bullish*/ false),
      })
    );
  }

  // 3) earnings_forecast_leading: top_subtopic=earnings_forecast + 高质量回答
  if (
    curr.top_subtopic === TOPIC_SUBCATEGORIES.EARNINGS_FORECAST &&
    curr.answer_count >= SIGNAL_THRESHOLDS.MIN_ANSWER_COUNT &&
    templateScore !== null &&
    Number.isFinite(templateScore) &&
    templateScore < SIGNAL_THRESHOLDS.TEMPLATE_SCORE_HIGH_QUALITY
  ) {
    out.push(
      buildSignal({
        curr,
        type: SIGNAL_TYPES.EARNINGS_FORECAST_LEADING,
        // moderate 是因为不依赖 growth, 单周状态;
        // earnings_bullish/bearish 同周同时触发时 strong 优先排前面.
        level: SIGNAL_LEVELS.MODERATE,
        growth,
        reason:
          `top_subtopic=earnings_forecast + 模板分=${templateScore.toFixed(2)} ` +
          `(高质量回答 ${curr.answer_count}/${curr.questions_count}) — 业绩预增前瞻`,
      })
    );
  }

  return out;
}

/** signal-level 排序权 (UI 列表 strong 排前). */
export function classifySignalLevel(type: QALeadingSignalType): QALeadingSignalLevel {
  if (type === SIGNAL_TYPES.EARNINGS_BULLISH || type === SIGNAL_TYPES.EARNINGS_BEARISH) {
    return SIGNAL_LEVELS.STRONG;
  }
  return SIGNAL_LEVELS.MODERATE;
}

/**
 * 对单只股票一组 stat (任意时序) 跑 leading signal 检测.
 *
 * - 先按 week_start asc 排序 (保证 vs 上周 baseline 对齐);
 * - 取连续两周 (curr, prev) per loop, prev=null 则不算 growth 类信号 (但 leading
 *   仍可触发);
 * - 输出按 week_start desc + level asc (strong 先) 稳定排序.
 *
 * 纯函数, 无 DB.
 */
export function detectForStockStats(stats: StatLike[]): QALeadingSignal[] {
  if (!Array.isArray(stats) || stats.length === 0) return [];
  // ASC sort by week_start; 与 input 顺序无关
  const sorted = [...stats].sort((a, b) =>
    a.week_start < b.week_start ? -1 : a.week_start > b.week_start ? 1 : 0
  );

  const out: QALeadingSignal[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i];
    const prev = i > 0 ? sorted[i - 1] : null;
    out.push(...detectForStat({ curr, prev }));
  }

  // DESC by week_start, then strong before moderate, then signal_type asc 稳定
  out.sort((a, b) => {
    if (a.week_start !== b.week_start) return a.week_start < b.week_start ? 1 : -1;
    const la = a.level === SIGNAL_LEVELS.STRONG ? 0 : 1;
    const lb = b.level === SIGNAL_LEVELS.STRONG ? 0 : 1;
    if (la !== lb) return la - lb;
    return a.signal_type < b.signal_type ? -1 : a.signal_type > b.signal_type ? 1 : 0;
  });

  return out;
}

// ---------------------------------------------------------------------------
// 内部 helper (build signal / reason)
// ---------------------------------------------------------------------------

function buildSignal(args: {
  curr: StatLike;
  type: QALeadingSignalType;
  level: QALeadingSignalLevel;
  growth: number | null;
  reason: string;
}): QALeadingSignal {
  const { curr, type, level, growth, reason } = args;
  return {
    stock_code: curr.stock_code,
    stock_name: curr.stock_name ?? null,
    week_start: curr.week_start,
    signal_type: type,
    level,
    questions_count: curr.questions_count,
    answer_count: curr.answer_count,
    answer_rate: Number(curr.answer_rate),
    questions_growth_pct: growth,
    top_subtopic: curr.top_subtopic as SubtopicCategory,
    answer_template_score:
      curr.answer_template_score === null || curr.answer_template_score === undefined
        ? null
        : Number(curr.answer_template_score),
    reason,
  };
}

function buildGrowthReason(growth: number, answerRate: number, bullish: boolean): string {
  const growthPct = Number.isFinite(growth) ? `+${Math.round(growth * 100)}%` : 'Inf';
  const ratePct = `${Math.round(answerRate * 100)}%`;
  if (bullish) {
    return `本周提问 ${growthPct} + 公司答复率 ${ratePct} (>50%) — 公司主动配合, 业绩超预期前瞻`;
  }
  return `本周提问 ${growthPct} + 公司答复率 ${ratePct} (<10%) — 散户密集关注 + 公司回避, 业绩雷前瞻`;
}

// ---------------------------------------------------------------------------
// StatLike — 鸭子类型, EastMoneyQAStat 与 AggregatedWeekStat 都可塞入
// ---------------------------------------------------------------------------

export interface StatLike {
  stock_code: string;
  stock_name?: string | null;
  week_start: string;
  questions_count: number;
  answer_count: number;
  answer_rate: number;
  top_subtopic: string;
  answer_template_score: number | null;
}

// ---------------------------------------------------------------------------
// DataSource DI
// ---------------------------------------------------------------------------

export interface QALeadingSignalDataSource {
  /** 拉单股近 N 周聚合 (Sequelize 实例 或 plain obj). */
  listByStock(stockCode: string, weeks: number): Promise<StatLike[]>;
}

export class DefaultQALeadingSignalDataSource implements QALeadingSignalDataSource {
  private aggregator: QAStatAggregator;

  constructor(aggregator: QAStatAggregator = qaStatAggregator) {
    this.aggregator = aggregator;
  }

  async listByStock(stockCode: string, weeks: number): Promise<StatLike[]> {
    const rows = await this.aggregator.listByStock(stockCode, weeks);
    return rows.map(rowToStatLike);
  }
}

/** Sequelize EastMoneyQAStat / plain obj 共用 — 取必要字段成 plain. */
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
    answer_template_score:
      r.answer_template_score === null || r.answer_template_score === undefined
        ? null
        : Number(r.answer_template_score),
  };
}

export const PRODUCTION_QA_LEADING_SIGNAL_DATA_SOURCE: QALeadingSignalDataSource =
  new DefaultQALeadingSignalDataSource();

// ---------------------------------------------------------------------------
// Service 入口
// ---------------------------------------------------------------------------

/** 默认 lookback 天数 (AC: 90 天 ≥ 5 信号). */
export const DEFAULT_LOOKBACK_DAYS = 90;
/** lookback_weeks 上限 — 防止异常输入. */
export const MAX_LOOKBACK_WEEKS = 104;

export interface DetectStocksOptions {
  /** 回看天数 (默认 90). */
  lookback_days?: number;
  /** per-stock 故障是否继续 (默认 true). */
  continue_on_error?: boolean;
}

export interface DetectStocksResult {
  total_stocks: number;
  stocks_succeeded: number;
  stocks_failed: number;
  signals: QALeadingSignal[];
}

export class QALeadingSignalDetector {
  private readonly dataSource: QALeadingSignalDataSource;

  constructor(dataSource: QALeadingSignalDataSource = PRODUCTION_QA_LEADING_SIGNAL_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 批量检测 — per-stock fail-OPEN.
   *
   * 输出已按 week_start desc + stock_code asc + level (strong 先) 稳定排序;
   * caller 可直接前端列表展示.
   */
  async detectForStocks(
    stockCodes: string[],
    options: DetectStocksOptions = {}
  ): Promise<DetectStocksResult> {
    const continueOnError = options.continue_on_error !== false;
    const lookbackDays = clampLookbackDays(options.lookback_days);
    const weeks = Math.max(2, Math.ceil(lookbackDays / 7) + 1); // +1 留 prev baseline

    const codes = Array.isArray(stockCodes) ? stockCodes : [];

    const signals: QALeadingSignal[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const code of codes) {
      const trimmed = String(code || '').trim();
      if (!/^\d{6}$/.test(trimmed)) {
        failed += 1;
        logger.warn(`QALeadingSignalDetector: invalid stock_code='${code}', skip`);
        if (!continueOnError) break;
        continue;
      }
      try {
        const stats = await this.dataSource.listByStock(trimmed, weeks);
        const stockSignals = detectForStockStats(stats);
        // 过滤掉 lookback 早于 cutoff 的信号 (DataSource 已经做了 weeks 窗,
        // 但 detectForStockStats 不感知 cutoff — 双保险按 lookback_days 截断).
        const cutoff = getCutoffIso(lookbackDays);
        const filtered = stockSignals.filter(s => s.week_start >= cutoff);
        signals.push(...filtered);
        succeeded += 1;
      } catch (err: any) {
        failed += 1;
        logger.warn(`QALeadingSignalDetector: listByStock(${trimmed}) failed: ${err.message}`);
        if (!continueOnError) break;
      }
    }

    // 全局排序 — week_start desc → level strong 先 → stock_code asc
    signals.sort((a, b) => {
      if (a.week_start !== b.week_start) return a.week_start < b.week_start ? 1 : -1;
      const la = a.level === SIGNAL_LEVELS.STRONG ? 0 : 1;
      const lb = b.level === SIGNAL_LEVELS.STRONG ? 0 : 1;
      if (la !== lb) return la - lb;
      if (a.stock_code !== b.stock_code) {
        return a.stock_code < b.stock_code ? -1 : 1;
      }
      return a.signal_type < b.signal_type ? -1 : a.signal_type > b.signal_type ? 1 : 0;
    });

    return {
      total_stocks: codes.length,
      stocks_succeeded: succeeded,
      stocks_failed: failed,
      signals,
    };
  }
}

/** 截断 lookback_days 到 [1, 728]. */
export function clampLookbackDays(days: number | undefined): number {
  if (days === undefined || days === null) return DEFAULT_LOOKBACK_DAYS;
  if (!Number.isFinite(days)) return DEFAULT_LOOKBACK_DAYS;
  const n = Math.floor(days);
  if (n < 1) return 1;
  if (n > MAX_LOOKBACK_WEEKS * 7) return MAX_LOOKBACK_WEEKS * 7;
  return n;
}

/** 当前时间减 lookback_days 的 ISO date — service 层调用, 单测可 mock. */
export function getCutoffIso(lookbackDays: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() - lookbackDays);
  return d.toISOString().slice(0, 10);
}

/** 生产 singleton. */
export const qaLeadingSignalDetector = new QALeadingSignalDetector();
