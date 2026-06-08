import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import {
  average,
  clamp,
  last,
  maxDrawdownFromValues,
  pct,
  round,
  sma,
  stddev,
  valueNDaysAgo,
} from '../engine/QuantMath';

export class QualityMomentumBlendStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'quality_momentum_blend',
    name: '质量动量融合策略',
    description: '融合质量、估值、资金流与中期动量，偏向寻找可持续上涨而非纯追高的标的。',
    category: 'multi_factor',
    default_params: {
      min_avg_turnover_yuan: 20000000,
      max_drawdown60: 22,
      max_volatility20: 5.8,
      min_bars: 120,
    },
    enabled: true,
    risk_level: 'medium',
    tags: ['质量', '动量', '资金流', '多因子'],
    style: 'multi_factor_alpha',
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const turnovers = bars.map(bar => Number(bar.turnover || 0));
    const volumes = bars.map(bar => Number(bar.volume || 0));
    const latestClose = last(closes) || Number(context.latest_price || 0);
    const ma20 = last(sma(closes, 20)) || latestClose;
    const ma60 = last(sma(closes, 60)) || ma20;
    const ret20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);
    const ret60 = pct(latestClose, valueNDaysAgo(closes, 60) || latestClose);
    const ret120 = pct(latestClose, valueNDaysAgo(closes, 120) || latestClose);
    const returns = closes.slice(1).map((value, index) => pct(value, closes[index]));
    const vol20 = stddev(returns.slice(-20));
    const drawdown60 = Math.abs(maxDrawdownFromValues(closes.slice(-60)));
    const avgTurnover = average(turnovers.slice(-20));
    const volumeRatio = average(volumes.slice(-5)) / Math.max(average(volumes.slice(-20)), 1);
    const valuationFactor = context.factor_snapshot?.valuation || {};
    const moneyFlowFactor = context.factor_snapshot?.money_flow || {};
    const fundamentalFactor = context.factor_snapshot?.fundamental || {};
    const valuationScore = Number(valuationFactor.valuation_score || 0);
    const moneyFlowScore = Number(moneyFlowFactor.money_flow_score || 0);
    const qualityScore = Number(fundamentalFactor.quality_score || 0);
    const pe = Number(valuationFactor.pe_ttm ?? context.pe_dynamic ?? 0);
    const pb = Number(valuationFactor.pb ?? context.pb ?? 0);

    const trendScore = clamp(45 + ret20 * 0.85 + ret60 * 0.38 + ret120 * 0.12);
    const qualityPart = qualityScore > 0 ? qualityScore : 55 + Math.max(0, ret60) * 0.25;
    const valuationPart =
      valuationScore > 0
        ? valuationScore
        : 55 + (pe > 0 && pe < 55 ? 8 : 0) + (pb > 0 && pb < 7 ? 6 : 0) - (pe > 90 ? 12 : 0);
    const riskPart = clamp(80 - Math.max(0, vol20 - 2.5) * 7 - Math.max(0, drawdown60 - 12) * 1.2);
    const flowPart = moneyFlowScore > 0 ? moneyFlowScore : 52 + (volumeRatio - 1) * 22;
    const liquidityPart = avgTurnover >= Number(params.min_avg_turnover_yuan) ? 72 : 42;
    let score = clamp(
      trendScore * 0.32 +
        qualityPart * 0.2 +
        flowPart * 0.18 +
        riskPart * 0.14 +
        valuationPart * 0.1 +
        liquidityPart * 0.06
    );

    const reasons: string[] = [];
    const risk_flags: string[] = [];
    if (trendScore >= 68) reasons.push('动量因子较强，20/60/120日趋势贡献为正');
    if (qualityPart >= 68) reasons.push('质量因子较高，趋势持续性更可信');
    if (flowPart >= 66) reasons.push('资金流/量能因子较好，承接力量较强');
    if (valuationPart >= 62) reasons.push('估值因子没有明显极端压力');
    if (riskPart >= 65) reasons.push('波动和回撤处于可接受区间');
    if (latestClose > ma20 && ma20 >= ma60) reasons.push('价格维持在20/60日均线上方');
    if (avgTurnover < Number(params.min_avg_turnover_yuan)) {
      score -= 8;
      risk_flags.push('近20日成交额偏低，策略容量和执行质量不足');
    }
    if (drawdown60 > Number(params.max_drawdown60)) {
      score -= 10;
      risk_flags.push('近60日回撤偏大，质量动量组合降级');
    }
    if (vol20 > Number(params.max_volatility20)) {
      score -= 8;
      risk_flags.push('短期波动率偏高，质量动量不宜放大仓位');
    }
    if (ret20 > 42) {
      score -= 8;
      risk_flags.push('20日涨幅过高，存在追高风险');
    }

    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: score >= 73 ? 'buy' : score >= 60 ? 'watch' : score < 42 ? 'avoid' : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - risk_flags.length * 6), 2),
      entry_price: latestClose,
      stop_loss_price: round(latestClose * 0.93, 4),
      take_profit_price: round(latestClose * 1.16, 4),
      target_holding_days: 22,
      reasons: reasons.length ? reasons : ['质量、资金流和动量尚未形成合力'],
      risk_flags,
      factors: {
        trend_score: round(trendScore, 2),
        quality_score: round(qualityPart, 2),
        money_flow_score: round(flowPart, 2),
        valuation_score: round(valuationPart, 2),
        risk_score: round(riskPart, 2),
        liquidity_score: round(liquidityPart, 2),
        return20_pct: round(ret20, 2),
        return60_pct: round(ret60, 2),
        return120_pct: round(ret120, 2),
        volatility20: round(vol20, 2),
        drawdown60_pct: round(drawdown60, 2),
        avg_turnover_yuan: round(avgTurnover, 2),
        volume_ratio: round(volumeRatio, 2),
        pe_dynamic: round(pe, 2),
        pb: round(pb, 2),
        factor_date: context.factor_snapshot?.factor_date,
        factor_valuation_source: valuationFactor.source,
        factor_money_flow_source: moneyFlowFactor.source,
        factor_fundamental_source: fundamentalFactor.source,
        ma20: round(ma20, 4),
        ma60: round(ma60, 4),
      },
    };
  }
}
