import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { clamp, last, macd, pct, round, valueNDaysAgo } from '../engine/QuantMath';

export class MacdTrendStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'macd_trend',
    name: 'MACD 趋势策略',
    description: '基于 DIF/DEA 和柱状图改善判断中短期趋势强度，适合趋势启动后的确认。',
    category: 'trend',
    default_params: { fast_period: 12, slow_period: 26, signal_period: 9, min_bars: 45 },
    enabled: true,
    risk_level: 'medium',
    tags: ['MACD', '趋势确认'],
    style: 'momentum',
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const latestClose = last(closes) || 0;
    const m = macd(
      closes,
      Number(params.fast_period),
      Number(params.slow_period),
      Number(params.signal_period)
    );
    const dif = last(m.dif) || 0;
    const dea = last(m.dea) || 0;
    const hist = last(m.histogram) || 0;
    const prevHist = valueNDaysAgo(m.histogram, 1) || 0;
    const momentum10 = pct(latestClose, valueNDaysAgo(closes, 10) || latestClose);
    let score = 45;
    const reasons: string[] = [];
    const risk_flags: string[] = [];
    if (dif > dea) {
      score += 18;
      reasons.push('MACD DIF 位于 DEA 上方');
    }
    if (hist > 0) {
      score += 12;
      reasons.push('MACD 柱状图为正，趋势动能偏强');
    }
    if (prevHist < 0 && hist > 0) {
      score += 12;
      reasons.push('MACD 柱状图由负转正，趋势改善');
    }
    if (hist > prevHist) {
      score += 8;
      reasons.push('MACD 动能继续抬升');
    }
    if (momentum10 < -6) {
      score -= 8;
      risk_flags.push('近10日价格走弱，MACD信号需等待价格确认');
    }
    if (momentum10 > 25) {
      score -= 5;
      risk_flags.push('短期动量过热，注意回撤');
    }
    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: score >= 72 ? 'buy' : score >= 58 ? 'watch' : dif < dea ? 'sell' : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - 10), 2),
      entry_price: latestClose,
      stop_loss_price: round(latestClose * 0.925, 4),
      take_profit_price: round(latestClose * 1.15, 4),
      target_holding_days: 18,
      reasons: reasons.length ? reasons : ['MACD 趋势优势不明显'],
      risk_flags,
      factors: {
        dif: round(dif, 4),
        dea: round(dea, 4),
        histogram: round(hist, 4),
        prev_histogram: round(prevHist, 4),
        momentum10: round(momentum10, 2),
      },
    };
  }
}
