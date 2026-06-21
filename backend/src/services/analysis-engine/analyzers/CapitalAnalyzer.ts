/**
 * CapitalAnalyzer — 资金面: 北向 / 主力 / 内部 / 融资融券 / 龙虎榜 / 大宗 / 基金共识 +
 * 盘口 bid/ask spread 健康度.
 *
 * 复用 7 个资金类 factor z-score + ctx.realtime_quote (含 bid/ask 时计算 spread).
 */

import { BaseAnalyzer, RawAnalyzerResult, weightedMean, zScoreToScore } from './BaseAnalyzer';
import type { AnalyzerContext, AnalyzerKey, EvidenceItem } from '../AnalyzerTypes';

const CAPITAL_FACTORS: Record<string, { label: string; weight: number }> = {
  northbound: { label: '北向资金', weight: 0.18 },
  money_flow: { label: '主力资金流向', weight: 0.18 },
  insider_trade: { label: '内部增减持', weight: 0.12 },
  margin_flow: { label: '融资融券', weight: 0.12 },
  dragon_tiger: { label: '龙虎榜机构', weight: 0.15 },
  block_trade_signal: { label: '大宗交易', weight: 0.1 },
  fund_consensus: { label: '基金一致持仓', weight: 0.15 },
};

export class CapitalAnalyzer extends BaseAnalyzer {
  readonly key: AnalyzerKey = 'capital';

  protected requiredFields: readonly string[] = ['factor.northbound', 'factor.money_flow'];

  protected async run(ctx: AnalyzerContext): Promise<RawAnalyzerResult> {
    const factors = ctx.factor_snapshot || {};
    const dataMissing: string[] = [];
    const evidence: EvidenceItem[] = [];
    const partials: Array<{ value: number | null; weight: number }> = [];

    for (const fname of Object.keys(CAPITAL_FACTORS)) {
      const z = factors[fname];
      if (z === undefined || z === null) {
        dataMissing.push(`factor.${fname}`);
        continue;
      }
      const score = zScoreToScore(z) ?? 0;
      const meta = CAPITAL_FACTORS[fname];
      partials.push({ value: score, weight: meta.weight });
      evidence.push({
        label: `${meta.label} z=${z.toFixed(2)}`,
        detail: `归一化分 ${score.toFixed(1)}`,
        metric_value: score,
        direction: score > 10 ? 'bullish' : score < -10 ? 'bearish' : 'neutral',
        weight: meta.weight,
      });
    }

    // spread health (bid/ask)
    const q = ctx.realtime_quote;
    if (q && Number.isFinite(q.bid as number) && Number.isFinite(q.ask as number) && q.price > 0) {
      const bid = Number(q.bid);
      const ask = Number(q.ask);
      if (bid > 0 && ask >= bid) {
        const spreadPct = (ask - bid) / q.price;
        // < 0.001 良好, > 0.005 警告
        const spreadScore = spreadPct < 0.001 ? 10 : spreadPct > 0.005 ? -20 : -5;
        partials.push({ value: spreadScore, weight: 0.05 });
        evidence.push({
          label: `盘口价差 ${(spreadPct * 100).toFixed(3)}%`,
          metric_value: spreadPct,
          direction: spreadPct < 0.001 ? 'bullish' : spreadPct > 0.005 ? 'bearish' : 'neutral',
          weight: 0.05,
        });
      } else {
        dataMissing.push('orderbook_bid_ask_invalid');
      }
    } else {
      dataMissing.push('orderbook_bid_ask');
    }

    const score = weightedMean(partials) ?? 0;
    const totalReq = Object.keys(CAPITAL_FACTORS).length;
    const haveReq = totalReq - dataMissing.filter(f => f.startsWith('factor.')).length;
    const confidence = totalReq > 0 ? Math.min(1, haveReq / totalReq + 0.1) : 0;

    return {
      score,
      evidence,
      data_sources: [
        { name: 'factor_scores.capital', as_of: ctx.as_of, is_realtime: false },
        { name: 'orderbook', as_of: ctx.as_of, is_realtime: true },
      ],
      confidence,
      data_missing: dataMissing,
    };
  }
}

export const capitalAnalyzer = new CapitalAnalyzer();
