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

export class LowVolatilityQualityStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'low_volatility_quality',
    name: '低波质量防守策略',
    description: '优先选择趋势仍在、波动和回撤较低、估值不过热且流动性可执行的稳健候选。',
    category: 'risk_control',
    default_params: {
      min_bars: 75,
      max_volatility20: 4.2,
      max_drawdown60: 18,
      min_avg_turnover_yuan: 15000000,
    },
    enabled: true,
    risk_level: 'low',
    tags: ['低波', '质量', '防守'],
    style: 'low_volatility',
    edge_hypothesis: {
      thesis:
        '低波动异象：20 日波动率 ≤ 4.2 + 60 日回撤 ≤ 18% + 价格站上 MA20/MA60 + 估值/质量因子分位较安全，长期年化超额来自风险溢价错配',
      category: 'risk_control',
      expected_edge_pct: 4.0,
      expected_holding_days: 18,
      key_factors: [
        'volatility_20d',
        'drawdown_60d',
        'ma20_vs_ma60',
        'avg_turnover_20d',
        'valuation_score',
        'quality_score',
      ],
      evidence_link:
        'Baker, Bradley, Wurgler - Benchmarks as Limits to Arbitrage (2011) / Low Volatility Anomaly',
      failure_modes: [
        '高波动 regime（系统性危机）下"低波"票同步崩跌，相对优势失效',
        '低波因子拥挤交易：大资金集中流入后 sharpe 大幅压缩',
        '20 日成交额 < 1500 万的流动性陷阱，离场困难',
      ],
      kill_switch_metric: 'sharpe_30d',
      kill_switch_threshold: 0.2,
    },
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const turnovers = bars.map(bar => Number(bar.turnover || 0));
    const latestClose = last(closes) || Number(context.latest_price || 0);
    const ma20 = last(sma(closes, 20)) || latestClose;
    const ma60 = last(sma(closes, 60)) || ma20;
    const ret20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);
    const ret60 = pct(latestClose, valueNDaysAgo(closes, 60) || latestClose);
    const dailyReturns = closes.slice(1).map((value, index) => pct(value, closes[index]));
    const vol20 = stddev(dailyReturns.slice(-20));
    const drawdown60 = Math.abs(maxDrawdownFromValues(closes.slice(-60)));
    const avgTurnover = average(turnovers.slice(-20));
    const valuationFactor = context.factor_snapshot?.valuation || {};
    const fundamentalFactor = context.factor_snapshot?.fundamental || {};
    const pe = Number(valuationFactor.pe_ttm ?? context.pe_dynamic ?? 0);
    const pb = Number(valuationFactor.pb ?? context.pb ?? 0);
    const valuationScore = Number(valuationFactor.valuation_score || 0);
    const qualityScore = Number(fundamentalFactor.quality_score || 0);

    let score = 48;
    const reasons: string[] = [];
    const risk_flags: string[] = [];

    if (latestClose > ma20 && ma20 >= ma60) {
      score += 16;
      reasons.push('价格位于20/60日均线上方，趋势没有破坏');
    }
    if (ret20 > 0 && ret60 > 0) {
      score += 12;
      reasons.push('20/60日收益均为正，具备温和上行质量');
    }
    if (vol20 <= Number(params.max_volatility20)) {
      score += 14;
      reasons.push('20日波动率较低，持仓体验更平滑');
    } else {
      score -= 10;
      risk_flags.push('20日波动率偏高，不符合防守策略偏好');
    }
    if (drawdown60 <= Number(params.max_drawdown60)) {
      score += 12;
      reasons.push('近60日回撤受控，趋势稳定性较好');
    } else {
      score -= 12;
      risk_flags.push('近60日回撤较大，防守属性不足');
    }
    if (avgTurnover >= Number(params.min_avg_turnover_yuan)) {
      score += 8;
      reasons.push('成交额满足执行要求，流动性可接受');
    } else {
      score -= 8;
      risk_flags.push('近20日成交额偏低，交易执行可能受限');
    }
    if ((pe > 0 && pe <= 55) || (pb > 0 && pb <= 7)) {
      score += 6;
      reasons.push('估值未见明显极端压力');
    }
    if (valuationScore >= 68) {
      score += 5;
      reasons.push('因子表估值分位较安全');
    }
    if (qualityScore >= 68) {
      score += 7;
      reasons.push('因子表质量分较高，防守属性增强');
    }
    if (ret20 > 32) {
      score -= 10;
      risk_flags.push('近20日涨幅较高，防守策略不追高');
    }

    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: score >= 72 ? 'buy' : score >= 58 ? 'watch' : drawdown60 > 24 ? 'avoid' : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - risk_flags.length * 7), 2),
      entry_price: latestClose,
      stop_loss_price: round(latestClose * 0.95, 4),
      take_profit_price: round(latestClose * 1.1, 4),
      target_holding_days: 18,
      reasons: reasons.length ? reasons : ['低波质量因子尚未形成明显优势'],
      risk_flags,
      factors: {
        return20_pct: round(ret20, 2),
        return60_pct: round(ret60, 2),
        volatility20: round(vol20, 2),
        drawdown60_pct: round(drawdown60, 2),
        avg_turnover_yuan: round(avgTurnover, 2),
        pe_dynamic: round(pe, 2),
        pb: round(pb, 2),
        factor_date: context.factor_snapshot?.factor_date,
        valuation_score: round(valuationScore, 2),
        quality_score: round(qualityScore, 2),
        factor_valuation_source: valuationFactor.source,
        factor_fundamental_source: fundamentalFactor.source,
        ma20: round(ma20, 4),
        ma60: round(ma60, 4),
      },
    };
  }
}
