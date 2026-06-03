import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { average, clamp, last, maxDrawdownFromValues, pct, round, sma, stddev, valueNDaysAgo } from '../engine/QuantMath';

export class VolatilityContractionBreakoutStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'volatility_contraction_breakout',
    name: '波动收缩突破策略',
    description: '捕捉波动率和振幅连续收敛后的放量突破，适合寻找平台整理后的启动点。',
    category: 'breakout',
    default_params: {
      breakout_window: 20,
      contraction_window: 10,
      max_range10_pct: 13,
      min_volume_ratio: 1.15,
      min_bars: 75,
    },
    enabled: true,
    risk_level: 'high',
    tags: ['波动收缩', '平台突破', 'VCP'],
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const highs = bars.map(bar => bar.high);
    const lows = bars.map(bar => bar.low);
    const volumes = bars.map(bar => Number(bar.volume || 0));
    const latestClose = last(closes) || Number(context.latest_price || 0);
    const breakoutWindow = Number(params.breakout_window);
    const contractionWindow = Number(params.contraction_window);
    const previousHigh = Math.max(...highs.slice(Math.max(0, highs.length - breakoutWindow - 1), -1));
    const rangeHigh = Math.max(...highs.slice(-contractionWindow));
    const rangeLow = Math.min(...lows.slice(-contractionWindow));
    const rangePct = latestClose > 0 ? ((rangeHigh - rangeLow) / latestClose) * 100 : 0;
    const returns = closes.slice(1).map((value, index) => pct(value, closes[index]));
    const vol10 = stddev(returns.slice(-10));
    const vol60 = stddev(returns.slice(-60));
    const ma20 = last(sma(closes, 20)) || latestClose;
    const ma60 = last(sma(closes, 60)) || ma20;
    const volumeRatio = average(volumes.slice(-3)) / Math.max(average(volumes.slice(-20)), 1);
    const ret20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);
    const drawdown60 = Math.abs(maxDrawdownFromValues(closes.slice(-60)));

    let score = 40;
    const reasons: string[] = [];
    const risk_flags: string[] = [];

    if (vol60 > 0 && vol10 <= vol60 * 0.68) {
      score += 18;
      reasons.push('短期波动率较60日波动明显收缩，平台整理充分');
    }
    if (rangePct > 0 && rangePct <= Number(params.max_range10_pct)) {
      score += 12;
      reasons.push('近10日价格振幅收敛，筹码换手趋于稳定');
    }
    if (Number.isFinite(previousHigh) && latestClose > previousHigh * 0.995) {
      score += 22;
      reasons.push(`价格接近或突破${breakoutWindow}日平台高点`);
    }
    if (volumeRatio >= Number(params.min_volume_ratio)) {
      score += 14;
      reasons.push('平台突破伴随量能放大');
    }
    if (latestClose > ma20 && ma20 >= ma60) {
      score += 10;
      reasons.push('均线结构支持向上突破');
    }
    if (ret20 > 35) {
      score -= 10;
      risk_flags.push('突破前20日涨幅偏高，平台收缩可能不充分');
    }
    if (drawdown60 > 24) {
      score -= 8;
      risk_flags.push('60日回撤偏大，整理平台稳定性不足');
    }
    if (volumeRatio > 4) {
      score -= 8;
      risk_flags.push('成交量异常放大，可能已进入短线情绪脉冲');
    }

    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: score >= 74 ? 'buy' : score >= 60 ? 'watch' : latestClose < ma60 ? 'sell' : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - risk_flags.length * 7), 2),
      entry_price: latestClose,
      stop_loss_price: round(Math.min(rangeLow * 0.98, latestClose * 0.93), 4),
      take_profit_price: round(latestClose * 1.16, 4),
      target_holding_days: 16,
      reasons: reasons.length ? reasons : ['波动收缩或平台突破条件尚未完整出现'],
      risk_flags,
      factors: {
        previous_high: round(previousHigh, 4),
        range10_pct: round(rangePct, 2),
        volatility10: round(vol10, 2),
        volatility60: round(vol60, 2),
        volume_ratio: round(volumeRatio, 2),
        return20_pct: round(ret20, 2),
        drawdown60_pct: round(drawdown60, 2),
        ma20: round(ma20, 4),
        ma60: round(ma60, 4),
      },
    };
  }
}
