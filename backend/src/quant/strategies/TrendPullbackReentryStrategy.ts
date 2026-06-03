import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { average, clamp, last, pct, round, rsi, sma, valueNDaysAgo } from '../engine/QuantMath';

export class TrendPullbackReentryStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'trend_pullback_reentry',
    name: '趋势回踩再入场策略',
    description: '寻找中期趋势仍强、短线回踩到均线附近且RSI修复的低吸再入场机会。',
    category: 'mean_reversion',
    default_params: {
      max_distance_to_ma20_pct: 5,
      min_distance_to_ma20_pct: -4,
      min_rsi: 38,
      max_rsi: 62,
      min_bars: 75,
    },
    enabled: true,
    risk_level: 'medium',
    tags: ['趋势低吸', '均线回踩', 'RSI修复'],
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const volumes = bars.map(bar => Number(bar.volume || 0));
    const latestClose = last(closes) || Number(context.latest_price || 0);
    const ma20 = last(sma(closes, 20)) || latestClose;
    const ma60 = last(sma(closes, 60)) || ma20;
    const ma120 = last(sma(closes, 120)) || ma60;
    const distanceToMa20Pct = ma20 > 0 ? ((latestClose - ma20) / ma20) * 100 : 0;
    const ret5 = pct(latestClose, valueNDaysAgo(closes, 5) || latestClose);
    const ret20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);
    const ret60 = pct(latestClose, valueNDaysAgo(closes, 60) || latestClose);
    const rsiValues = rsi(closes, 14);
    const latestRsi = last(rsiValues) || 50;
    const prevRsi = valueNDaysAgo(rsiValues, 1) || latestRsi;
    const volumeRatio = average(volumes.slice(-3)) / Math.max(average(volumes.slice(-20)), 1);

    let score = 43;
    const reasons: string[] = [];
    const risk_flags: string[] = [];

    if (ma20 > ma60 && ma60 >= ma120 && ret60 > 6) {
      score += 22;
      reasons.push('20/60/120日均线保持多头结构，中期趋势仍在');
    }
    if (
      distanceToMa20Pct >= Number(params.min_distance_to_ma20_pct) &&
      distanceToMa20Pct <= Number(params.max_distance_to_ma20_pct)
    ) {
      score += 18;
      reasons.push('价格回踩到20日均线附近，入场位置不过分追高');
    }
    if (latestRsi >= Number(params.min_rsi) && latestRsi <= Number(params.max_rsi) && latestRsi >= prevRsi) {
      score += 14;
      reasons.push('RSI位于修复区间且开始回升，短线低吸条件改善');
    }
    if (ret5 < 1 && ret20 > -8 && ret60 > 0) {
      score += 8;
      reasons.push('短线回调但中期趋势仍为正，符合趋势内回踩');
    }
    if (volumeRatio >= 0.75 && volumeRatio <= 2.2) {
      score += 6;
      reasons.push('回踩阶段量能没有异常失控');
    }
    if (latestClose < ma60) {
      score -= 16;
      risk_flags.push('价格跌破60日均线，趋势回踩可能演变为趋势破坏');
    }
    if (ret20 > 35) {
      score -= 8;
      risk_flags.push('20日涨幅仍偏高，回踩不充分');
    }
    if (latestRsi > 72) {
      score -= 10;
      risk_flags.push('RSI过热，不符合低吸再入场条件');
    }
    if (ret5 < -12) {
      score -= 8;
      risk_flags.push('5日跌幅过大，可能不是健康回踩');
    }

    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: score >= 71 ? 'buy' : score >= 57 ? 'watch' : latestClose < ma60 ? 'sell' : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - risk_flags.length * 6), 2),
      entry_price: latestClose,
      stop_loss_price: round(Math.min(ma60 * 0.98, latestClose * 0.93), 4),
      take_profit_price: round(latestClose * 1.12, 4),
      target_holding_days: 14,
      reasons: reasons.length ? reasons : ['趋势回踩再入场条件尚不充分'],
      risk_flags,
      factors: {
        distance_to_ma20_pct: round(distanceToMa20Pct, 2),
        rsi: round(latestRsi, 2),
        prev_rsi: round(prevRsi, 2),
        return5_pct: round(ret5, 2),
        return20_pct: round(ret20, 2),
        return60_pct: round(ret60, 2),
        volume_ratio: round(volumeRatio, 2),
        ma20: round(ma20, 4),
        ma60: round(ma60, 4),
        ma120: round(ma120, 4),
      },
    };
  }
}
