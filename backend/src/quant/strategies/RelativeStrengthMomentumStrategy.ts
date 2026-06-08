import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { average, clamp, last, pct, round, sma, stddev, valueNDaysAgo } from '../engine/QuantMath';

export class RelativeStrengthMomentumStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'relative_strength_momentum',
    name: '相对强弱动量策略',
    description: '以20/60日收益、波动率和量能确认强势股，适合全市场自动发现主线机会。',
    category: 'momentum',
    default_params: { short_window: 20, long_window: 60, min_bars: 75 },
    enabled: true,
    risk_level: 'medium',
    tags: ['动量', '相对强弱', '全市场'],
    style: 'momentum',
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const volumes = bars.map(bar => bar.volume || 0);
    const latestClose = last(closes) || 0;
    const ret20 = pct(
      latestClose,
      valueNDaysAgo(closes, Number(params.short_window)) || latestClose
    );
    const ret60 = pct(
      latestClose,
      valueNDaysAgo(closes, Number(params.long_window)) || latestClose
    );
    const dailyReturns = closes.slice(1).map((value, index) => pct(value, closes[index]));
    const vol20 = stddev(dailyReturns.slice(-20));
    const volRatio = average(volumes.slice(-5)) / Math.max(average(volumes.slice(-20)), 1);
    const ma20 = last(sma(closes, 20)) || latestClose;
    let score = 42;
    const reasons: string[] = [];
    const risk_flags: string[] = [];
    if (ret20 > 8) {
      score += 18;
      reasons.push('20日动量为正且强度较高');
    }
    if (ret60 > 12) {
      score += 18;
      reasons.push('60日趋势收益为正，具备中期相对强势');
    }
    if (latestClose > ma20) {
      score += 10;
      reasons.push('价格站上20日均线，动量延续性较好');
    }
    if (volRatio > 1.08) {
      score += 8;
      reasons.push('近期成交量能温和放大');
    }
    if (vol20 > 5.5) {
      score -= 8;
      risk_flags.push('短期波动率偏高，需控制仓位');
    }
    if (ret20 > 45) {
      score -= 10;
      risk_flags.push('20日涨幅过高，追高回撤风险较大');
    }
    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: score >= 72 ? 'buy' : score >= 58 ? 'watch' : ret20 < -8 ? 'sell' : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - 8), 2),
      entry_price: latestClose,
      stop_loss_price: round(latestClose * 0.92, 4),
      take_profit_price: round(latestClose * 1.18, 4),
      target_holding_days: 20,
      reasons: reasons.length ? reasons : ['相对强弱动量尚未达到入选阈值'],
      risk_flags,
      factors: {
        return20_pct: round(ret20, 2),
        return60_pct: round(ret60, 2),
        volatility20: round(vol20, 2),
        volume_ratio: round(volRatio, 2),
        ma20: round(ma20, 4),
      },
    };
  }
}
