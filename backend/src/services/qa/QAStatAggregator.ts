/**
 * QAStatAggregator — US-038 QA-002 投资者问答按 (stock, week) 维度聚合 + 落 EastMoneyQAStat 表.
 *
 * 与 EastMoneyQATopicService 互补 (不重复):
 *   - EastMoneyQATopicService.syncStock(): 拉远端 Q&A → 按 (week, topic) N 行聚合落
 *     `east_money_qa_topics` 表 (粗粒度 6 topic);
 *   - QAStatAggregator.aggregateForStock(): 拉同一份 Q&A → 按 (week) 1 行聚合落
 *     `east_money_qa_stats` 表 (汇总指标 — 提问数/回答率/top_subtopic/模板话术分等).
 *
 * 设计原则:
 *   - 数据源沿用 StockQAClient (与 EastMoneyQATopicService 同口径), 避免双拉浪费;
 *   - 主题分类沿用 classifySubtopic (TOPIC_SUBCATEGORIES 26 类), 保证 (top_subtopic)
 *     与 east_money_qa_topics 行可严格对得上;
 *   - 情绪打分沿用 scoreSentiment (4 档 + 0 中性), 保证 avg_*_sentiment 与
 *     east_money_qa_topics.sentiment_score 在同一标尺;
 *   - **detectTemplateAnswer** 是本 service 的新 pure helper — 识别 "感谢关注 /
 *     详见公告 / 投资有风险" 等高频模板话术, 返 ∈ [0, 1] (1 = 纯模板, 0 = 高质量);
 *   - aggregateForWeek() 是核心 pure transform (rows → AggregatedWeekStat), 完全无 DB;
 *   - aggregateForStock() 是带 fetch + persist 的 service-level 入口.
 *
 * **6 项 AI feature checklist** (与 EastMoneyQATopicService / AnnouncementNLPService 同款):
 *   1. **DataSource DI** — `QAStatAggregatorDataSource` 接口
 *      (fetchForStock / saveStats); 生产 singleton lazy require model + StockQAClient;
 *      单测注入 fake;
 *   2. **pure helpers 全 export** — detectTemplateAnswer / aggregateForWeek /
 *      computeWeekStart (复用 EastMoneyQATopicService);
 *   3. **plain-object 返回类型** `AggregatedWeekStat` 兼容 persist=true/false;
 *   4. **status='partial' / 'failed' 仍可见** — sync 失败仍返 SyncStockResult
 *      带 error, 避免重复触发;
 *   5. **fail-OPEN on saveStats** — DB 故障不抛, warn + persisted=false;
 *   6. **双重防御 try/catch** — DataSource 内 catch + service 层再 catch.
 *
 * **fail-OPEN 边界 (与 risk guard fail-CLOSED 对偶)**:
 *   - aggregator 失败不阻塞主流程 (cron tick), 仅 log;
 *   - 与 RiskAlertService 不同 — QA 聚合是统计/可视化层, DB 故障不应让用户拿不到决策.
 */

import { Op } from 'sequelize';
import { EastMoneyQAStat } from '../../models/EastMoneyQAStat';
import { StockQAClient, StockQARow, stockQAClient } from '../../data/sources/StockQAClient';
import {
  classifySubtopic,
  scoreSentiment,
  computeWeekStart,
  TOPIC_SUBCATEGORIES,
  SubtopicCategory,
  TOPIC_SUBCATEGORY_PRIORITY,
  SUBTOPIC_VALUES,
  NLP_ENGINES,
} from './qaTopicClassification';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// 模板话术识别 (detectTemplateAnswer)
// ---------------------------------------------------------------------------

/**
 * 模板话术关键词字典 (与 QA-004 doc 83 对齐).
 *
 * - **strong** = 极高强度 (单条命中即视为纯模板, weight 1.0);
 *   * "感谢关注 / 详见公告 / 投资有风险 / 以公司公告为准 / 您好,..." 等;
 * - **moderate** = 中等强度 (单条命中视为半模板, weight 0.5);
 *   * "暂无 / 不便透露 / 请关注 / 后续会披露 / 按照计划推进" 等;
 *
 * **打分规则** (单回答):
 *   - 命中至少 1 个 strong → 1.0 (纯模板);
 *   - 命中至少 1 个 moderate 且无 strong → 0.5;
 *   - 全无命中 → 0 (高质量);
 *   - 文本长度 < 6 (空回答 / 极短) → 1.0 兜底 (短回答天然信息量低);
 *
 * 字典按 "具体度从高到低" 排 (与 US-026 classifyEventType 同款), 但本场景
 * 只看 "是否命中", 不在乎命中数, 所以排序仅为可读性, 不影响打分.
 */
export const TEMPLATE_ANSWER_KEYWORDS = Object.freeze({
  strong: Object.freeze([
    '感谢关注',
    '感谢您的关注',
    '感谢您的提问',
    '感谢提问',
    '详见公告',
    '详见定期报告',
    '详见相关公告',
    '请见公告',
    '以公司公告为准',
    '以上市公司公告为准',
    '以公司披露',
    '投资有风险',
    '投资需谨慎',
    '股市有风险',
    '请理性投资',
    '请投资者注意投资风险',
    '请勿盲目跟风',
    '不构成投资建议',
    '不作为投资依据',
  ]),
  moderate: Object.freeze([
    '暂无',
    '暂无相关',
    '暂未',
    '暂不便透露',
    '不便透露',
    '不便回复',
    '请关注',
    '请持续关注',
    '后续会披露',
    '按照计划推进',
    '按计划推进',
    '请以公告',
    '以披露内容',
    '正常推进',
    '保密',
    '不予置评',
    '尚未确定',
  ]),
});

/** 极短回答阈值 — 低于此长度天然视为模板话术 (信息量过低). */
export const TEMPLATE_SHORT_ANSWER_THRESHOLD = 6;

/**
 * 模板话术识别 — 返 ∈ [0, 1] (1 = 纯模板, 0 = 高质量).
 *
 * - 空 / 全空白 / 极短回答 → 1 (兜底视为模板);
 * - 命中 strong 字典任一 → 1.0;
 * - 否则命中 moderate 字典任一 → 0.5;
 * - 否则 → 0.
 *
 * pure, 无 DB, 无远端.
 */
export function detectTemplateAnswer(answer: string | null | undefined): number {
  if (!answer) return 1;
  const text = String(answer).trim();
  if (!text) return 1;
  if (text.length < TEMPLATE_SHORT_ANSWER_THRESHOLD) return 1;

  // strong 优先
  for (const kw of TEMPLATE_ANSWER_KEYWORDS.strong) {
    if (text.includes(kw)) return 1.0;
  }
  for (const kw of TEMPLATE_ANSWER_KEYWORDS.moderate) {
    if (text.includes(kw)) return 0.5;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 聚合主入口 (aggregateForWeek) — pure transform, 无 DB
// ---------------------------------------------------------------------------

export interface AggregatedWeekStat {
  stock_code: string;
  stock_name: string | null;
  week_start: string;
  questions_count: number;
  answer_count: number;
  /** ∈ [0, 1]; 0 提问时 0. */
  answer_rate: number;
  /** 当周最高 mention 的 subcategory (SubtopicCategory). */
  top_subtopic: SubtopicCategory;
  /** ∈ [-1, +1]. */
  avg_question_sentiment: number;
  /** ∈ [-1, +1]; null = 当周无回答. */
  avg_answer_sentiment: number | null;
  /** ∈ [0, 1]; null = 当周无回答. */
  answer_template_score: number | null;
  nlp_engine: string;
  raw_payload: {
    subtopic_distribution: Partial<Record<SubtopicCategory, number>>;
    template_hits_sample: string[]; // 命中模板的样本 question_id, ≤ 5 条
    sample_question_ids: string[]; // ≤ 5 条整体样本
  };
  /** True iff actually written to DB. */
  persisted: boolean;
}

/**
 * 把一只股票的 Q&A 行按周聚合 → 多周 stat (与 EastMoneyQATopic.aggregateWeekly 同思路).
 *
 * - 同周多条问题 → questions_count + 平均情绪 + subtopic 分布;
 * - 有回答的子集 → answer_count + 平均回答情绪 + 平均模板分;
 * - top_subtopic 取当周 max-mention subcategory; tie-break TOPIC_SUBCATEGORY_PRIORITY;
 * - 全周无答 → avg_answer_sentiment + answer_template_score 均为 null.
 *
 * Pure / 无 DB / 无远端.
 */
export function aggregateForWeek(
  rows: StockQARow[],
  options: {
    stock_code: string;
    stock_name?: string | null;
    nlp_engine?: string;
    since_date?: string;
  }
): AggregatedWeekStat[] {
  const engine = options.nlp_engine || NLP_ENGINES.HEURISTIC;
  const sinceDate = options.since_date;

  type Acc = {
    questions: number;
    answer_count: number;
    sum_q_sent: number;
    sum_a_sent: number;
    sum_template: number;
    answered_n: number; // 平均分母 (= answer_count)
    subtopic_counts: Partial<Record<SubtopicCategory, number>>;
    template_hits_sample: string[];
    sample_question_ids: string[];
  };

  const bucket: Map<string, Acc> = new Map();

  for (const row of rows) {
    if (!row.question || !row.question_time) continue;
    if (sinceDate) {
      const dateOnly = row.question_time.slice(0, 10);
      if (dateOnly < sinceDate) continue;
    }
    let week: string;
    try {
      week = computeWeekStart(row.question_time);
    } catch {
      continue;
    }

    let acc = bucket.get(week);
    if (!acc) {
      acc = {
        questions: 0,
        answer_count: 0,
        sum_q_sent: 0,
        sum_a_sent: 0,
        sum_template: 0,
        answered_n: 0,
        subtopic_counts: {},
        template_hits_sample: [],
        sample_question_ids: [],
      };
      bucket.set(week, acc);
    }

    acc.questions += 1;
    acc.sum_q_sent += scoreSentiment(row.question);
    const sub = classifySubtopic(row.question);
    acc.subtopic_counts[sub] = (acc.subtopic_counts[sub] || 0) + 1;

    if (acc.sample_question_ids.length < 5) {
      acc.sample_question_ids.push(row.question_id);
    }

    // 回答相关 — 只在 answer 非空非空白时计
    const answer = row.answer ? String(row.answer).trim() : '';
    if (answer) {
      acc.answer_count += 1;
      acc.sum_a_sent += scoreSentiment(answer);
      const template = detectTemplateAnswer(answer);
      acc.sum_template += template;
      acc.answered_n += 1;
      // 命中模板 (≥0.5) 的回答样本 ≤ 5
      if (template >= 0.5 && acc.template_hits_sample.length < 5) {
        acc.template_hits_sample.push(row.question_id);
      }
    }
  }

  const out: AggregatedWeekStat[] = [];
  for (const [week, acc] of bucket.entries()) {
    const avgQ = acc.questions > 0 ? acc.sum_q_sent / acc.questions : 0;
    const avgA = acc.answered_n > 0 ? acc.sum_a_sent / acc.answered_n : null;
    const avgT = acc.answered_n > 0 ? acc.sum_template / acc.answered_n : null;
    const rate = acc.questions > 0 ? acc.answer_count / acc.questions : 0;
    const top = pickTopSubtopic(acc.subtopic_counts);

    out.push({
      stock_code: options.stock_code,
      stock_name: options.stock_name ?? null,
      week_start: week,
      questions_count: acc.questions,
      answer_count: acc.answer_count,
      answer_rate: roundTo3(rate),
      top_subtopic: top,
      avg_question_sentiment: roundTo3(avgQ),
      avg_answer_sentiment: avgA === null ? null : roundTo3(avgA),
      answer_template_score: avgT === null ? null : roundTo3(avgT),
      nlp_engine: engine,
      raw_payload: {
        subtopic_distribution: acc.subtopic_counts,
        template_hits_sample: acc.template_hits_sample,
        sample_question_ids: acc.sample_question_ids,
      },
      persisted: false,
    });
  }

  // 稳定排序 (week_start desc)
  out.sort((a, b) => (a.week_start < b.week_start ? 1 : a.week_start > b.week_start ? -1 : 0));
  return out;
}

/**
 * 从 subcategory 计数 Map 选 top — max-count + TOPIC_SUBCATEGORY_PRIORITY tie-break.
 *
 * 全空 → OTHER_GENERAL 兜底 (与 classifySubtopic null 兜底一致).
 */
export function pickTopSubtopic(
  counts: Partial<Record<SubtopicCategory, number>>
): SubtopicCategory {
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

/** 量化到 3 位小数 (与 DECIMAL(5,3) 列对齐). */
export function roundTo3(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// DataSource DI 接口
// ---------------------------------------------------------------------------

export interface QAStatAggregatorDataSource {
  fetchForStock(stockCode: string, limit?: number): Promise<StockQARow[]>;
  saveStats(rows: AggregatedWeekStat[]): Promise<void>;
}

export class DefaultQAStatAggregatorDataSource implements QAStatAggregatorDataSource {
  private client: StockQAClient;

  constructor(client: StockQAClient = stockQAClient) {
    this.client = client;
  }

  async fetchForStock(stockCode: string, limit?: number): Promise<StockQARow[]> {
    return this.client.fetchForStock(stockCode, limit);
  }

  async saveStats(rows: AggregatedWeekStat[]): Promise<void> {
    if (rows.length === 0) return;
    await EastMoneyQAStat.bulkCreate(
      rows.map(r => ({
        stock_code: r.stock_code,
        stock_name: r.stock_name,
        week_start: r.week_start,
        questions_count: r.questions_count,
        answer_count: r.answer_count,
        answer_rate: r.answer_rate,
        top_subtopic: r.top_subtopic,
        avg_question_sentiment: r.avg_question_sentiment,
        avg_answer_sentiment: r.avg_answer_sentiment,
        answer_template_score: r.answer_template_score,
        nlp_engine: r.nlp_engine,
        raw_payload: r.raw_payload,
      })) as unknown as Array<Record<string, unknown>>,
      {
        updateOnDuplicate: [
          'stock_name',
          'questions_count',
          'answer_count',
          'answer_rate',
          'top_subtopic',
          'avg_question_sentiment',
          'avg_answer_sentiment',
          'answer_template_score',
          'nlp_engine',
          'raw_payload',
          'updated_at',
        ],
      }
    );
  }
}

export const PRODUCTION_QA_STAT_AGGREGATOR_DATA_SOURCE: QAStatAggregatorDataSource =
  new DefaultQAStatAggregatorDataSource();

// ---------------------------------------------------------------------------
// Service-level 入口
// ---------------------------------------------------------------------------

export const DEFAULT_QA_STAT_FETCH_LIMIT = 200;
export const DEFAULT_QA_STAT_LIST_WEEKS = 13;

export interface AggregateStockOptions {
  /** 拉取上限 (默认 200) */
  limit?: number;
  /** dry_run 跳过 DB 写入 */
  dry_run?: boolean;
  /** 显式起始日期 (YYYY-MM-DD); 早于此的问题不聚合 */
  since_date?: string;
}

export interface AggregateStockResult {
  stock_code: string;
  fetched: number;
  weeks_aggregated: number;
  rows_upserted: number;
  skipped: boolean;
  error?: string;
}

export interface AggregateStocksOptions extends AggregateStockOptions {
  continue_on_error?: boolean;
  interval_ms?: number;
}

export interface AggregateStocksResult {
  total_stocks: number;
  succeeded: number;
  failed: number;
  details: AggregateStockResult[];
}

export class QAStatAggregator {
  private readonly dataSource: QAStatAggregatorDataSource;

  constructor(dataSource: QAStatAggregatorDataSource = PRODUCTION_QA_STAT_AGGREGATOR_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 单股聚合 — fetch + 按周聚合 + upsert.
   *
   * 触发: cron `WEEKLY_QA_STAT_AGGREGATE` (周一 02:00, 早于 04:00 AC 截止);
   *       手动 CLI / API.
   */
  async aggregateForStock(
    stockCode: string,
    options: AggregateStockOptions = {}
  ): Promise<AggregateStockResult> {
    const code = String(stockCode || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return {
        stock_code: stockCode,
        fetched: 0,
        weeks_aggregated: 0,
        rows_upserted: 0,
        skipped: false,
        error: `Invalid stock_code: ${stockCode}`,
      };
    }

    const limit = options.limit ?? DEFAULT_QA_STAT_FETCH_LIMIT;

    try {
      const rows = await this.dataSource.fetchForStock(code, limit);
      if (rows.length === 0) {
        logger.warn(`QAStatAggregator: no Q&A returned for stock=${code}`);
        return {
          stock_code: code,
          fetched: 0,
          weeks_aggregated: 0,
          rows_upserted: 0,
          skipped: false,
        };
      }

      const stockName = rows[0]?.stock_name || null;

      const aggregated = aggregateForWeek(rows, {
        stock_code: code,
        stock_name: stockName,
        nlp_engine: NLP_ENGINES.HEURISTIC,
        since_date: options.since_date,
      });

      if (options.dry_run !== true) {
        try {
          await this.dataSource.saveStats(aggregated);
          aggregated.forEach(r => {
            r.persisted = true;
          });
        } catch (err: any) {
          // fail-OPEN
          logger.error(`QAStatAggregator.saveStats(${code}) failed: ${err.message}`);
          return {
            stock_code: code,
            fetched: rows.length,
            weeks_aggregated: aggregated.length,
            rows_upserted: 0,
            skipped: false,
            error: `save_failed: ${err.message}`,
          };
        }
      }

      logger.info(
        `QAStatAggregator: stock=${code} ${rows.length} questions → ` +
          `${aggregated.length} weekly stats ` +
          `(top_subtopic=${aggregated[0]?.top_subtopic ?? '-'})`
      );
      return {
        stock_code: code,
        fetched: rows.length,
        weeks_aggregated: aggregated.length,
        rows_upserted: options.dry_run === true ? 0 : aggregated.length,
        skipped: false,
      };
    } catch (err: any) {
      // 双重防御外层 catch
      logger.error(`QAStatAggregator.aggregateForStock(${code}) failed: ${err.message}`);
      return {
        stock_code: code,
        fetched: 0,
        weeks_aggregated: 0,
        rows_upserted: 0,
        skipped: false,
        error: err.message,
      };
    }
  }

  /**
   * 批量聚合 — 顺序执行 + intervalMs 节流.
   */
  async aggregateForStocks(
    stockCodes: string[],
    options: AggregateStocksOptions = {}
  ): Promise<AggregateStocksResult> {
    const continueOnError = options.continue_on_error !== false;
    const intervalMs = Math.max(0, options.interval_ms ?? 500);

    const details: AggregateStockResult[] = [];
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < stockCodes.length; i++) {
      const code = stockCodes[i];
      const result = await this.aggregateForStock(code, options);
      details.push(result);
      if (result.error) {
        failed += 1;
        if (!continueOnError) break;
      } else {
        succeeded += 1;
      }
      if (intervalMs > 0 && i < stockCodes.length - 1) {
        await sleep(intervalMs);
      }
    }

    return {
      total_stocks: stockCodes.length,
      succeeded,
      failed,
      details,
    };
  }

  /**
   * 读端 — 按股票代码查最近 N 周聚合.
   * GET /api/sentiment/qa-stats?stock_code=000001&weeks=13 直接调.
   */
  async listByStock(
    stockCode: string,
    weeks = DEFAULT_QA_STAT_LIST_WEEKS
  ): Promise<EastMoneyQAStat[]> {
    const code = String(stockCode || '').trim();
    if (!/^\d{6}$/.test(code)) return [];

    const weeksCap = Math.max(1, Math.min(104, Math.floor(weeks)));
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - weeksCap * 7);
    const sinceIso = since.toISOString().slice(0, 10);

    return EastMoneyQAStat.findAll({
      where: {
        stock_code: code,
        week_start: { [Op.gte]: sinceIso },
      },
      order: [['week_start', 'DESC']],
    });
  }
}

/** Promise sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 生产 singleton */
export const qaStatAggregator = new QAStatAggregator();
