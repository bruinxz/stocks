/**
 * SentimentAnalyzer — 个股情绪 vs 市场情绪.
 *
 * 复用:
 *   - EastMoneyQAFactor / ConceptHeatFactor / ShareholderConcentrationFactor (z-score)
 *   - MarketSentimentIndexService.getLatest() — 市场级情绪 baseline
 *   - QAStatAggregator (US-038 QA-002) — 周聚合的 questions_count / answer_rate,
 *     抽出 questions_growth (vs 上周) + answer_rate 两个 QA 新维度 (US-122 QA-005).
 *
 * 个股情绪 - 市场情绪 = 相对情绪 (z-score 差); 用其作为主分数, QA 新维度作为辅助 partial
 * (weight 0.1 各, 温和加成不喧宾夺主).
 *
 * **QA 新维度计分契约** (US-122):
 *   - questions_growth_pct = (curr - prev) / prev (与 QALeadingSignalDetector 同款公式);
 *     prev=0 且 curr>0 → +Inf (按上限 +200% 截);
 *     prev=null/undefined → null (无 baseline, evidence 缺失);
 *   - answer_rate ∈ [0,1] (上游已 clamp; 容错再 clamp);
 *   - **小样本守门** — curr.questions_count < QA_MIN_QUESTIONS_COUNT (5) 时
 *     视为噪音, 不入 evidence, 不进 partial; 与 QALeadingSignalDetector.MIN_QUESTIONS_COUNT 对齐;
 *   - 单测可注入 fake SentimentQASource, 生产走 qaStatAggregator.listByStock(code, 2).
 */

import { BaseAnalyzer, RawAnalyzerResult, weightedMean, zScoreToScore } from './BaseAnalyzer';
import type { AnalyzerContext, AnalyzerKey, EvidenceItem } from '../AnalyzerTypes';

export interface SentimentBaselineSource {
  /** 返回 [0, 100] 市场情绪百分位; null 表示拿不到. */
  getMarketSentimentPercentile(asOf: string): Promise<number | null>;
}

export const PRODUCTION_SENTIMENT_BASELINE_SOURCE: SentimentBaselineSource = {
  async getMarketSentimentPercentile(_asOf) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { marketSentimentIndexService } = require('../../MarketSentimentIndexService');
      const latest = await marketSentimentIndexService.getLatest?.();
      // 不同实现字段名可能不同, 兜底找一个数值字段.
      if (!latest) return null;
      const candidates = [
        latest.percentile,
        latest.sentiment_percentile,
        latest.percentile_60d,
        latest.score,
      ];
      for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
      }
      return null;
    } catch (_e) {
      return null;
    }
  },
};

/**
 * US-122 QA-005 — SentimentAnalyzer 直读 QAStatAggregator (周聚合) 最近 2 周, 提取
 * questions_growth + answer_rate 当成新 evidence.
 */
export interface QAStatSnapshot {
  /** 6 位纯代码 (与 EastMoneyQAStat.stock_code 一致). */
  stock_code: string;
  /** 当周 week_start ISO 日期 (YYYY-MM-DD). */
  week_start: string;
  /** 当周提问数 (整数 ≥ 0). */
  questions_count_curr: number;
  /** 上周提问数; null = 无上周 baseline (新股 / 首周聚合). */
  questions_count_prev: number | null;
  /** 当周答复率 ∈ [0, 1]. */
  answer_rate: number;
}

export interface SentimentQASource {
  /**
   * 返回某只股票最近一周 QA 聚合 snapshot (含上周提问数作 growth baseline).
   * stockCode 是原始 sym (含 sh./sz.); 实现内部负责正则化到 6 位.
   * 任何故障 (DB 不可达 / 表为空 / 代码格式异常) → null, 不抛.
   */
  getQAStatSnapshot(stockCode: string): Promise<QAStatSnapshot | null>;
}

export const PRODUCTION_SENTIMENT_QA_SOURCE: SentimentQASource = {
  async getQAStatSnapshot(stockCode) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { qaStatAggregator } = require('../../qa/QAStatAggregator');
      // EastMoneyQAStat 用 6 位纯代码 (无 sh./sz. 前缀) — 与 KOLAggregatorService 同款剥前缀
      const code = String(stockCode || '')
        .replace(/[a-zA-Z.]/g, '')
        .slice(-6);
      if (!/^\d{6}$/.test(code)) return null;
      const rows = await qaStatAggregator.listByStock(code, 2);
      if (!rows || !rows.length) return null;
      // listByStock 返回 DESC 排序 (week_start desc); [0]=本周 [1]=上周
      const curr = rows[0] as { week_start: string; questions_count: any; answer_rate: any };
      const prev = rows.length > 1 ? (rows[1] as { questions_count: any }) : null;
      const ar = Number(curr.answer_rate);
      return {
        stock_code: code,
        week_start: String(curr.week_start),
        questions_count_curr: Number(curr.questions_count) || 0,
        questions_count_prev: prev ? Number(prev.questions_count) || 0 : null,
        answer_rate: Number.isFinite(ar) ? Math.max(0, Math.min(1, ar)) : 0,
      };
    } catch (_e) {
      return null;
    }
  },
};

const SENTIMENT_FACTORS: Record<string, { label: string; weight: number }> = {
  east_money_qa: { label: '股吧问答热度', weight: 0.4 },
  concept_heat: { label: '概念热度', weight: 0.35 },
  shareholder_concentration: { label: '股东集中度', weight: 0.25 },
};

// ---------------------------------------------------------------------------
// QA 新维度评分常量 (Object.freeze, 单测验冻结)
// ---------------------------------------------------------------------------

/** QA 新维度计分阈值, 与 QALeadingSignalDetector.SIGNAL_THRESHOLDS 对齐. */
export const QA_DIMENSION_THRESHOLDS = Object.freeze({
  /** questions_growth_pct 用于评分时上限截断 (避免 +Inf 拉爆 partial). */
  GROWTH_PCT_CAP: 2.0,
  /** questions_growth_pct 用于评分时下限截断. */
  GROWTH_PCT_FLOOR: -1.0,
  /** answer_rate 视为"中性"的基准点; 实际 rate - REF → 正向利多, 负向利空. */
  ANSWER_RATE_REF: 0.3,
  /** 当周 questions_count 至少 ≥ 此数, 才把 QA 维度计入 evidence/partial (小样本守门).
   *  与 QALeadingSignalDetector.SIGNAL_THRESHOLDS.MIN_QUESTIONS_COUNT 一致. */
  MIN_QUESTIONS_COUNT: 5,
});

/** QA 新维度 evidence/partial 权重 (温和加成不喧宾夺主). */
export const QA_DIMENSION_WEIGHTS = Object.freeze({
  QUESTIONS_GROWTH: 0.1,
  ANSWER_RATE: 0.1,
});

/**
 * 把 growth_pct (比例; 0=持平, 2.0=+200%) 转 [-30, +30] partial 分.
 * 纯函数, 单测白盒.
 */
export function questionsGrowthToScore(growthPct: number | null): number | null {
  if (growthPct === null || growthPct === undefined) return null;
  if (!Number.isFinite(growthPct)) {
    // +Inf (prev=0 curr>0) → 按上限算 bullish; -Inf 防御性按下限.
    return growthPct > 0 ? 30 : -30;
  }
  const capped = Math.max(
    QA_DIMENSION_THRESHOLDS.GROWTH_PCT_FLOOR,
    Math.min(QA_DIMENSION_THRESHOLDS.GROWTH_PCT_CAP, growthPct)
  );
  // 映射 [-1.0, +2.0] → 大致 [-15, +30]; 用 GROWTH_PCT_CAP 作为 ±100% 归一基.
  return (capped / QA_DIMENSION_THRESHOLDS.GROWTH_PCT_CAP) * 30;
}

/**
 * 把 answer_rate ∈ [0, 1] 转 [-30, +30] partial 分.
 * REF=0.3 中性; rate=0.5+ bullish (公司主动响应); rate<0.1 bearish (回避).
 * 纯函数, 单测白盒.
 */
export function answerRateToScore(answerRate: number | null): number | null {
  if (answerRate === null || answerRate === undefined || !Number.isFinite(answerRate)) {
    return null;
  }
  const ar = Math.max(0, Math.min(1, answerRate));
  // 映射: (ar - REF) × 100 限制在 [-30, +30] 内.
  // ar=0   → -30; ar=0.3 → 0; ar=0.6 → +30; ar=1.0 → +30 (clip)
  const raw = (ar - QA_DIMENSION_THRESHOLDS.ANSWER_RATE_REF) * 100;
  return Math.max(-30, Math.min(30, raw));
}

/** computeQuestionsGrowth — 与 QALeadingSignalDetector.computeQuestionsGrowthPct 同语义.
 *  抽到本 module export, 单测无需 import detector 模块. */
export function computeQuestionsGrowth(
  curr: number,
  prev: number | null | undefined
): number | null {
  if (!Number.isFinite(curr)) return null;
  if (prev === null || prev === undefined) return null;
  if (!Number.isFinite(prev)) return null;
  if (curr < 0 || prev < 0) return null;
  if (prev === 0) {
    return curr === 0 ? null : Number.POSITIVE_INFINITY;
  }
  return (curr - prev) / prev;
}

export class SentimentAnalyzer extends BaseAnalyzer {
  readonly key: AnalyzerKey = 'sentiment';

  constructor(
    private readonly baseline: SentimentBaselineSource = PRODUCTION_SENTIMENT_BASELINE_SOURCE,
    private readonly qaSource: SentimentQASource = PRODUCTION_SENTIMENT_QA_SOURCE
  ) {
    super();
  }

  protected requiredFields: readonly string[] = ['factor.east_money_qa'];

  protected async run(ctx: AnalyzerContext): Promise<RawAnalyzerResult> {
    const factors = ctx.factor_snapshot || {};
    const dataMissing: string[] = [];
    const evidence: EvidenceItem[] = [];
    const partials: Array<{ value: number | null; weight: number }> = [];

    let stockSentimentZ = 0;
    let stockSentimentCount = 0;

    for (const fname of Object.keys(SENTIMENT_FACTORS)) {
      const z = factors[fname];
      if (z === undefined || z === null) {
        dataMissing.push(`factor.${fname}`);
        continue;
      }
      stockSentimentZ += z;
      stockSentimentCount += 1;
      const meta = SENTIMENT_FACTORS[fname];
      const score = zScoreToScore(z) ?? 0;
      partials.push({ value: score, weight: meta.weight });
      evidence.push({
        label: `${meta.label} z=${z.toFixed(2)}`,
        metric_value: score,
        direction: score > 10 ? 'bullish' : score < -10 ? 'bearish' : 'neutral',
        weight: meta.weight,
      });
    }

    const avgStockZ = stockSentimentCount > 0 ? stockSentimentZ / stockSentimentCount : 0;

    // market baseline
    const marketPctl = await this.baseline.getMarketSentimentPercentile(ctx.as_of);
    if (marketPctl === null) {
      dataMissing.push('market_sentiment_baseline');
    } else {
      // 市场 percentile 50 = 中性; > 70 偏热 (对个股相对情绪扣分), < 30 偏冷 (个股相对情绪加分)
      const marketZ = (marketPctl - 50) / 25; // ~[-2, +2]
      const relativeZ = avgStockZ - marketZ;
      const relScore = (relativeZ / 3) * 30; // 最大 ±30
      evidence.push({
        label: `市场情绪百分位 ${marketPctl.toFixed(1)}, 个股 z=${avgStockZ.toFixed(2)}`,
        detail: `相对市场 z=${relativeZ.toFixed(2)}`,
        metric_value: relativeZ,
        direction: relScore > 5 ? 'bullish' : relScore < -5 ? 'bearish' : 'neutral',
        weight: 0.2,
      });
      partials.push({ value: relScore, weight: 0.2 });
    }

    // ----- US-122 QA-005: 接 QA 新维度 -----
    // 拉本股最近 2 周 stat, 提取 questions_growth + answer_rate.
    // fail-OPEN: 任何 source 异常 / 数据缺失 → data_missing 标记, 不阻塞 analyzer.
    const qaSnap = await this.qaSource.getQAStatSnapshot(ctx.stock.code);
    if (qaSnap === null) {
      dataMissing.push('qa_stat_snapshot');
    } else if (qaSnap.questions_count_curr < QA_DIMENSION_THRESHOLDS.MIN_QUESTIONS_COUNT) {
      // 小样本守门: 当周 questions_count < 5 视为噪音, 不入 partial / 不入 evidence.
      // 标记 data_missing 让 confidence 显式下调 (不静默吞).
      dataMissing.push('qa_questions_growth');
      dataMissing.push('qa_answer_rate');
    } else {
      // questions_growth evidence
      const growth = computeQuestionsGrowth(
        qaSnap.questions_count_curr,
        qaSnap.questions_count_prev
      );
      if (growth === null) {
        dataMissing.push('qa_questions_growth');
      } else {
        const gScore = questionsGrowthToScore(growth) ?? 0;
        const growthPctStr = Number.isFinite(growth)
          ? `${growth >= 0 ? '+' : ''}${Math.round(growth * 100)}%`
          : 'Inf';
        evidence.push({
          label: `本周提问环比 ${growthPctStr}`,
          detail: `curr=${qaSnap.questions_count_curr}, prev=${qaSnap.questions_count_prev}`,
          metric_value: gScore,
          direction: gScore > 5 ? 'bullish' : gScore < -5 ? 'bearish' : 'neutral',
          weight: QA_DIMENSION_WEIGHTS.QUESTIONS_GROWTH,
        });
        partials.push({ value: gScore, weight: QA_DIMENSION_WEIGHTS.QUESTIONS_GROWTH });
      }

      // answer_rate evidence
      const arScore = answerRateToScore(qaSnap.answer_rate);
      if (arScore === null) {
        dataMissing.push('qa_answer_rate');
      } else {
        evidence.push({
          label: `公司答复率 ${Math.round(qaSnap.answer_rate * 100)}%`,
          detail: `当周 ${qaSnap.questions_count_curr} 提问`,
          metric_value: arScore,
          direction: arScore > 5 ? 'bullish' : arScore < -5 ? 'bearish' : 'neutral',
          weight: QA_DIMENSION_WEIGHTS.ANSWER_RATE,
        });
        partials.push({ value: arScore, weight: QA_DIMENSION_WEIGHTS.ANSWER_RATE });
      }
    }

    const score = weightedMean(partials) ?? 0;
    const total = Object.keys(SENTIMENT_FACTORS).length;
    const have = total - dataMissing.filter(f => f.startsWith('factor.')).length;
    const confidence = total > 0 ? have / total : 0;

    return {
      score,
      evidence,
      data_sources: [
        { name: 'factor_scores.sentiment', as_of: ctx.as_of, is_realtime: false },
        { name: 'market_sentiment_index', as_of: ctx.as_of, is_realtime: false },
        { name: 'east_money_qa_stats', as_of: ctx.as_of, is_realtime: false },
      ],
      confidence,
      data_missing: dataMissing,
    };
  }
}

export const sentimentAnalyzer = new SentimentAnalyzer();
