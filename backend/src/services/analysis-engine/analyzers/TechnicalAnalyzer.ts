/**
 * TechnicalAnalyzer — 复用 TechnicalAnalysisService.analyze().
 *
 * 把 TechnicalAnalysisResult (trend/support/resistance/buy_zone/sell_zone/confidence)
 * 转 evidence. trend 上行 → 正分; trend 下行 → 负分. RSI 超买/超卖 + MACD hist + 量比
 * 作辅助 evidence.
 *
 * Aggregator 把 buy_zone / support_levels[0] / resistance_levels[0] 当 entry/stop/target.
 */

import { BaseAnalyzer, RawAnalyzerResult, clampScore } from './BaseAnalyzer';
import type { AnalyzerContext, AnalyzerKey, EvidenceItem } from '../AnalyzerTypes';

export interface TechnicalAnalyzeSource {
  analyze(
    stockCode: string,
    lookbackDays: number,
    options?: { stock_name?: string }
  ): Promise<{
    trend: string;
    support_levels: number[];
    resistance_levels: number[];
    buy_zone: number[];
    sell_zone: number[];
    confidence: number | null;
    indicators_snapshot: Record<string, unknown>;
    summary: string;
    status: string;
    nlp_engine: string;
    generated_at: string;
  }>;
}

export const PRODUCTION_TECHNICAL_SOURCE: TechnicalAnalyzeSource = {
  async analyze(stockCode, lookbackDays, options) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { technicalAnalysisService } = require('../../TechnicalAnalysisService');
    return technicalAnalysisService.analyze(stockCode, lookbackDays, options || {});
  },
};

const TREND_SCORE_MAP: Record<string, number> = {
  strong_uptrend: 70,
  uptrend: 50,
  rebound: 25,
  range: 0,
  pullback: -25,
  downtrend: -50,
  strong_downtrend: -70,
  unknown: 0,
};

export class TechnicalAnalyzer extends BaseAnalyzer {
  readonly key: AnalyzerKey = 'technical';

  constructor(private readonly source: TechnicalAnalyzeSource = PRODUCTION_TECHNICAL_SOURCE) {
    super();
  }

  protected requiredFields: readonly string[] = ['daily_bars', 'trend'];

  protected async run(ctx: AnalyzerContext): Promise<RawAnalyzerResult> {
    const dataMissing: string[] = [];
    const evidence: EvidenceItem[] = [];

    if (!ctx.daily_bars || ctx.daily_bars.length < 20) {
      dataMissing.push('daily_bars');
      return {
        score: 0,
        evidence: [],
        data_sources: [],
        confidence: 0,
        data_missing: dataMissing,
      };
    }

    let result: Awaited<ReturnType<TechnicalAnalyzeSource['analyze']>>;
    try {
      result = await this.source.analyze(ctx.stock.code, Math.min(120, ctx.daily_bars.length), {
        stock_name: ctx.stock.name || undefined,
      });
    } catch (e: any) {
      dataMissing.push('technical_analysis_remote');
      return {
        score: 0,
        evidence: [
          {
            label: '技术分析远端不可用',
            detail: e?.message || 'unknown',
            direction: 'neutral',
            weight: 1,
          },
        ],
        data_sources: [],
        confidence: 0,
        data_missing: dataMissing,
      };
    }

    const trendScore = TREND_SCORE_MAP[result.trend] ?? 0;
    evidence.push({
      label: `技术趋势: ${result.trend}`,
      detail: result.summary?.slice(0, 200) || undefined,
      metric_value: trendScore,
      direction: trendScore > 10 ? 'bullish' : trendScore < -10 ? 'bearish' : 'neutral',
      weight: 0.5,
    });

    // RSI evidence
    const rsi = pickNumber(result.indicators_snapshot, 'last_rsi');
    if (rsi !== null) {
      const rsiScore = rsi > 70 ? -20 : rsi < 30 ? 20 : 0;
      evidence.push({
        label: `RSI(14)=${rsi.toFixed(1)} ${rsi > 70 ? '超买' : rsi < 30 ? '超卖' : '中性'}`,
        metric_value: rsi,
        threshold: rsi > 50 ? 70 : 30,
        direction: rsiScore > 0 ? 'bullish' : rsiScore < 0 ? 'bearish' : 'neutral',
        weight: 0.15,
      });
    } else {
      dataMissing.push('rsi');
    }

    // MACD hist
    const macd = result.indicators_snapshot?.last_macd as { hist?: number } | null | undefined;
    if (macd && Number.isFinite(macd.hist)) {
      const hist = Number(macd.hist);
      const histScore = hist > 0 ? 15 : -15;
      evidence.push({
        label: `MACD hist=${hist.toFixed(3)}`,
        metric_value: hist,
        direction: hist > 0 ? 'bullish' : 'bearish',
        weight: 0.15,
      });
      void histScore;
    } else {
      dataMissing.push('macd');
    }

    // 量比
    const volRatio = pickNumber(result.indicators_snapshot, 'vol_ratio');
    if (volRatio !== null) {
      evidence.push({
        label: `量比=${volRatio.toFixed(2)}`,
        metric_value: volRatio,
        direction: volRatio > 1.5 ? 'bullish' : volRatio < 0.5 ? 'bearish' : 'neutral',
        weight: 0.1,
      });
    }

    const score = clampScore(trendScore + 0); // trend 已为主, RSI/MACD 仅 evidence
    const confidence =
      result.confidence === null ? 0.5 : Math.max(0, Math.min(1, result.confidence));

    return {
      score,
      evidence,
      data_sources: [
        {
          name: result.nlp_engine || 'technical_analysis',
          as_of: result.generated_at || ctx.as_of,
          is_realtime: false,
        },
      ],
      confidence,
      data_missing: dataMissing,
    };
  }
}

function pickNumber(snap: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!snap) return null;
  const v = snap[key];
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const technicalAnalyzer = new TechnicalAnalyzer();
