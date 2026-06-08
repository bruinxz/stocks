import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { bollinger, clamp, last, pct, round, valueNDaysAgo } from '../engine/QuantMath';

export class BollingerReversionStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'bollinger_reversion',
    name: '布林带回归策略',
    description: '识别价格触及布林下轨后的修复机会，并用中轨作为回归目标。',
    category: 'mean_reversion',
    default_params: { period: 20, multiplier: 2, min_bars: 35 },
    enabled: true,
    risk_level: 'medium',
    tags: ['布林带', '低吸', '震荡'],
    style: 'mean_reversion',
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const closes = (context.bars || []).map(bar => bar.close);
    const latestClose = last(closes) || 0;
    const b = bollinger(closes, Number(params.period), Number(params.multiplier));
    const middle = last(b.middle) || latestClose;
    const upper = last(b.upper) || latestClose;
    const lower = last(b.lower) || latestClose;
    const prevClose = valueNDaysAgo(closes, 1) || latestClose;
    const distanceToLower = lower ? ((latestClose - lower) / latestClose) * 100 : 0;
    const rebound = latestClose > prevClose;
    const momentum20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);
    let score = 43;
    const reasons: string[] = [];
    const risk_flags: string[] = [];
    if (latestClose <= lower * 1.015) {
      score += 24;
      reasons.push('价格接近或触及布林下轨，存在回归中轨机会');
    }
    if (rebound) {
      score += 10;
      reasons.push('最新收盘价较上一日回升，修复迹象出现');
    }
    if (middle > latestClose && middle / latestClose - 1 < 0.12) {
      score += 8;
      reasons.push('布林中轨上方空间存在且不极端');
    }
    if (momentum20 < -25) {
      score -= 12;
      risk_flags.push('近20日跌幅过大，可能处于下跌趋势而非震荡回归');
    }
    if (latestClose >= upper) {
      score -= 18;
      risk_flags.push('价格接近布林上轨，均值回归买点失效');
    }
    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: score >= 70 ? 'buy' : score >= 55 ? 'watch' : latestClose >= upper ? 'sell' : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - 12), 2),
      entry_price: latestClose,
      stop_loss_price: round(latestClose * 0.94, 4),
      take_profit_price: round(middle || latestClose * 1.08, 4),
      target_holding_days: 12,
      reasons: reasons.length ? reasons : ['价格未处于布林带低吸区间'],
      risk_flags,
      factors: {
        middle: round(middle, 4),
        upper: round(upper, 4),
        lower: round(lower, 4),
        distance_to_lower_pct: round(distanceToLower, 2),
        momentum20: round(momentum20, 2),
      },
    };
  }
}
