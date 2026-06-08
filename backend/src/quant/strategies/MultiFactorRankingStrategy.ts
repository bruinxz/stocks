import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import {
  adx,
  average,
  clamp,
  cci,
  last,
  maxDrawdownFromValues,
  mfi,
  obv,
  pct,
  round,
  sma,
  stddev,
  valueNDaysAgo,
} from '../engine/QuantMath';

export class MultiFactorRankingStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'multi_factor_ranking',
    name: '多因子打分策略',
    description: '综合趋势、动量、量能、风险和估值因子，为全市场候选生成可解释综合分。',
    category: 'multi_factor',
    default_params: { min_bars: 75, min_avg_turnover_yuan: 20000000 },
    enabled: true,
    risk_level: 'medium',
    tags: ['多因子', '全市场', '核心策略'],
    style: 'multi_factor_alpha',
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const volumes = bars.map(bar => bar.volume || 0);
    const turnovers = bars.map(bar => Number(bar.turnover || 0));
    const latestClose = last(closes) || Number(context.latest_price || 0);
    const ma20 = last(sma(closes, 20)) || latestClose;
    const ma60 = last(sma(closes, 60)) || ma20;
    const ret20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);
    const ret60 = pct(latestClose, valueNDaysAgo(closes, 60) || latestClose);
    const dailyReturns = closes.slice(1).map((value, index) => pct(value, closes[index]));
    const vol20 = stddev(dailyReturns.slice(-20));
    const drawdown60 = maxDrawdownFromValues(closes.slice(-60));
    const avgTurnover = average(turnovers.slice(-20));
    const volumeRatio = average(volumes.slice(-5)) / Math.max(average(volumes.slice(-20)), 1);
    const factorSnapshot = context.factor_snapshot || {};
    const valuationFactor = factorSnapshot.valuation || {};
    const moneyFlowFactor = factorSnapshot.money_flow || {};
    const fundamentalFactor = factorSnapshot.fundamental || {};
    const pe = Number(valuationFactor.pe_ttm ?? context.pe_dynamic ?? 0);
    const pb = Number(valuationFactor.pb ?? context.pb ?? 0);
    const factorValuationScore = Number(valuationFactor.valuation_score || 0);
    const factorMoneyFlowScore = Number(moneyFlowFactor.money_flow_score || 0);
    const factorQualityScore = Number(fundamentalFactor.quality_score || 0);
    const adxValues = adx(bars, 14);
    const latestAdx = last(adxValues.adx) || 0;
    const plusDi = last(adxValues.plus_di) || 0;
    const minusDi = last(adxValues.minus_di) || 0;
    const mfiValue = last(mfi(bars, 14)) || 50;
    const cciValue = last(cci(bars, 20)) || 0;
    const obvValues = obv(bars);
    const latestObv = last(obvValues) || 0;
    const obvBase = valueNDaysAgo(obvValues, 20) ?? latestObv;
    const obvTrendPct =
      Math.abs(obvBase) > 0 ? ((latestObv - obvBase) / Math.abs(obvBase)) * 100 : 0;

    const trendScore = clamp(
      (latestClose > ma20 ? 45 : 20) +
        (ma20 > ma60 ? 35 : 10) +
        (ma20 > 0 ? Math.min(20, Math.max(-10, ((latestClose - ma20) / ma20) * 100)) : 0) +
        (latestAdx >= 22 && plusDi > minusDi ? 10 : latestAdx >= 18 ? 4 : 0)
    );
    const momentumScore = clamp(50 + ret20 * 1.15 + ret60 * 0.45);
    const volumeScore = clamp(
      45 +
        (volumeRatio - 1) * 30 +
        (avgTurnover >= Number(params.min_avg_turnover_yuan) ? 18 : -12) +
        (mfiValue >= 45 && mfiValue <= 78 ? 8 : mfiValue > 85 ? -8 : 0) +
        (obvTrendPct > 0 ? 6 : obvTrendPct < -10 ? -6 : 0) +
        (factorMoneyFlowScore > 0 ? (factorMoneyFlowScore - 50) * 0.22 : 0)
    );
    const riskScore = clamp(82 - Math.max(0, vol20 - 2) * 8 + Math.max(-30, drawdown60));
    const valuationScore = clamp(
      factorValuationScore > 0
        ? factorValuationScore
        : 55 + (pe > 0 && pe < 45 ? 12 : 0) + (pb > 0 && pb < 6 ? 8 : 0) - (pe > 90 ? 15 : 0)
    );
    const qualityScore = clamp(
      factorQualityScore > 0 ? factorQualityScore : 55 + (riskScore - 50) * 0.35
    );
    const oscillatorScore = clamp(
      52 +
        (cciValue > -80 && cciValue < 180 ? 10 : 0) +
        (cciValue > 220 ? -12 : 0) +
        (mfiValue > 82 ? -10 : mfiValue < 25 ? -6 : 0)
    );

    const score = clamp(
      trendScore * 0.25 +
        momentumScore * 0.21 +
        volumeScore * 0.18 +
        riskScore * 0.14 +
        valuationScore * 0.1 +
        oscillatorScore * 0.08 +
        qualityScore * 0.04
    );
    const reasons: string[] = [];
    const risk_flags: string[] = [];
    if (trendScore >= 70) reasons.push('趋势因子优秀：价格与均线结构偏强');
    if (momentumScore >= 70) reasons.push('动量因子优秀：20/60日收益强于常规阈值');
    if (volumeScore >= 65) reasons.push('量能因子较好：成交额/成交量支持交易执行');
    if (riskScore >= 65) reasons.push('风险因子可接受：波动和回撤处于可控区间');
    if (valuationScore >= 65) reasons.push('估值因子未见明显极端压力');
    if (factorValuationScore > 0 || factorMoneyFlowScore > 0 || factorQualityScore > 0)
      reasons.push('已读取因子表：估值/资金流/质量因子参与打分');
    if (qualityScore >= 70) reasons.push('质量因子较好，适合进入模拟盘观察');
    if (latestAdx >= 22 && plusDi > minusDi) reasons.push('ADX/DMI 显示上升趋势强度较好');
    if (mfiValue >= 45 && mfiValue <= 78 && obvTrendPct > 0)
      reasons.push('MFI/OBV 显示资金流入较健康');
    if (avgTurnover > 0 && avgTurnover < Number(params.min_avg_turnover_yuan))
      risk_flags.push('近20日成交额偏低，流动性不足');
    if (vol20 > 5.5) risk_flags.push('短期波动率较高，建议降低仓位');
    if (drawdown60 < -22) risk_flags.push('近60日最大回撤偏大，趋势稳定性不足');
    if (ret20 > 45) risk_flags.push('短期涨幅过高，追高风险较大');
    if (latestAdx >= 22 && minusDi > plusDi) risk_flags.push('ADX显示下跌趋势强度较高');
    if (mfiValue > 85 || cciValue > 220) risk_flags.push('资金/摆动指标过热，追高风险上升');

    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: score >= 74 ? 'buy' : score >= 62 ? 'watch' : score < 42 ? 'avoid' : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - risk_flags.length * 6), 2),
      entry_price: latestClose,
      stop_loss_price: round(latestClose * 0.93, 4),
      take_profit_price: round(latestClose * 1.16, 4),
      target_holding_days: 20,
      reasons: reasons.length ? reasons : ['多因子综合优势尚不明显'],
      risk_flags,
      factors: {
        trend_score: round(trendScore, 2),
        momentum_score: round(momentumScore, 2),
        volume_score: round(volumeScore, 2),
        risk_score: round(riskScore, 2),
        valuation_score: round(valuationScore, 2),
        quality_score: round(qualityScore, 2),
        oscillator_score: round(oscillatorScore, 2),
        factor_date: factorSnapshot.factor_date,
        factor_valuation_score: round(factorValuationScore, 2),
        factor_money_flow_score: round(factorMoneyFlowScore, 2),
        factor_quality_score: round(factorQualityScore, 2),
        factor_valuation_source: valuationFactor.source,
        factor_money_flow_source: moneyFlowFactor.source,
        factor_fundamental_source: fundamentalFactor.source,
        adx: round(latestAdx, 2),
        plus_di: round(plusDi, 2),
        minus_di: round(minusDi, 2),
        mfi: round(mfiValue, 2),
        cci: round(cciValue, 2),
        obv_trend_pct: round(obvTrendPct, 2),
        return20_pct: round(ret20, 2),
        return60_pct: round(ret60, 2),
        volatility20: round(vol20, 2),
        drawdown60_pct: round(drawdown60, 2),
        avg_turnover_yuan: round(avgTurnover, 2),
        volume_ratio: round(volumeRatio, 2),
        pe_dynamic: round(pe, 2),
        pb: round(pb, 2),
      },
    };
  }
}
