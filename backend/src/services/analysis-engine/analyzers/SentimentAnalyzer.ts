/**
 * SentimentAnalyzer — 个股情绪 vs 市场情绪.
 *
 * 复用:
 *   - EastMoneyQAFactor / ConceptHeatFactor / ShareholderConcentrationFactor (z-score)
 *   - MarketSentimentIndexService.getLatest() — 市场级情绪 baseline
 *
 * 个股情绪 - 市场情绪 = 相对情绪 (z-score 差); 用其作为主分数.
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

const SENTIMENT_FACTORS: Record<string, { label: string; weight: number }> = {
  east_money_qa: { label: '股吧问答热度', weight: 0.4 },
  concept_heat: { label: '概念热度', weight: 0.35 },
  shareholder_concentration: { label: '股东集中度', weight: 0.25 },
};

export class SentimentAnalyzer extends BaseAnalyzer {
  readonly key: AnalyzerKey = 'sentiment';

  constructor(
    private readonly baseline: SentimentBaselineSource = PRODUCTION_SENTIMENT_BASELINE_SOURCE
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
      ],
      confidence,
      data_missing: dataMissing,
    };
  }
}

export const sentimentAnalyzer = new SentimentAnalyzer();
