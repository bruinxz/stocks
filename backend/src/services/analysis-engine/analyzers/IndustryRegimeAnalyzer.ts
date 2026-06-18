/**
 * IndustryRegimeAnalyzer — 行业 + market regime.
 *
 * 复用:
 *   - ctx.market_env (= MarketEnvironmentSnapshot)
 *   - factor.industry_momentum (z-score)
 *   - RegimeProbabilityService.classifyRegimeProbability (从 daily_bars 算)
 */

import { BaseAnalyzer, RawAnalyzerResult, weightedMean, zScoreToScore } from './BaseAnalyzer';
import type { AnalyzerContext, AnalyzerKey, EvidenceItem } from '../AnalyzerTypes';

const MARKET_REGIME_SCORE: Record<string, number> = {
  bull: 35,
  rebound: 15,
  range: 0,
  bear: -45,
  stress: -60,
  volatile: -20,
  unknown: 0,
};

const INDUSTRY_REGIME_SCORE: Record<string, number> = {
  hot: 30,
  warm: 10,
  cold: -25,
  unknown: 0,
};

export class IndustryRegimeAnalyzer extends BaseAnalyzer {
  readonly key: AnalyzerKey = 'industry_regime';

  protected requiredFields: readonly string[] = ['market_env', 'factor.industry_momentum'];

  protected async run(ctx: AnalyzerContext): Promise<RawAnalyzerResult> {
    const dataMissing: string[] = [];
    const evidence: EvidenceItem[] = [];
    const partials: Array<{ value: number | null; weight: number }> = [];

    const env = ctx.market_env as
      | {
          market_regime?: string;
          market_regime_label?: string;
          industry?: { regime?: string; label?: string; relative_return_20d_pct?: number };
        }
      | null
      | undefined;

    if (!env) {
      dataMissing.push('market_env');
    } else {
      const mr = env.market_regime || 'unknown';
      const mrScore = MARKET_REGIME_SCORE[mr] ?? 0;
      partials.push({ value: mrScore, weight: 0.4 });
      evidence.push({
        label: `市场 regime: ${env.market_regime_label || mr}`,
        metric_value: mrScore,
        direction: mrScore > 5 ? 'bullish' : mrScore < -5 ? 'bearish' : 'neutral',
        weight: 0.4,
      });

      if (env.industry) {
        const ir = env.industry.regime || 'unknown';
        const irScore = INDUSTRY_REGIME_SCORE[ir] ?? 0;
        partials.push({ value: irScore, weight: 0.35 });
        evidence.push({
          label: `行业 regime: ${env.industry.label || ir}`,
          detail:
            env.industry.relative_return_20d_pct !== undefined
              ? `相对市场 20d=${env.industry.relative_return_20d_pct.toFixed(2)}%`
              : undefined,
          metric_value: irScore,
          direction: irScore > 5 ? 'bullish' : irScore < -5 ? 'bearish' : 'neutral',
          weight: 0.35,
        });
      } else {
        dataMissing.push('industry_regime');
      }
    }

    const z = ctx.factor_snapshot?.['industry_momentum'];
    if (z === undefined || z === null) {
      dataMissing.push('factor.industry_momentum');
    } else {
      const score = zScoreToScore(z) ?? 0;
      partials.push({ value: score, weight: 0.25 });
      evidence.push({
        label: `行业动量 z=${z.toFixed(2)}`,
        metric_value: score,
        direction: score > 10 ? 'bullish' : score < -10 ? 'bearish' : 'neutral',
        weight: 0.25,
      });
    }

    const score = weightedMean(partials) ?? 0;
    const totalReq = 3;
    const have = totalReq - dataMissing.length;
    const confidence = totalReq > 0 ? Math.max(0, have / totalReq) : 0;

    return {
      score,
      evidence,
      data_sources: [
        { name: 'market_environment', as_of: ctx.as_of, is_realtime: false },
        { name: 'factor_scores.industry_momentum', as_of: ctx.as_of, is_realtime: false },
      ],
      confidence,
      data_missing: dataMissing,
    };
  }
}

export const industryRegimeAnalyzer = new IndustryRegimeAnalyzer();
