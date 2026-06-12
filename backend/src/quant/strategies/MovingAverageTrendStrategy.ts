import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { clamp, last, pct, round, sma, valueNDaysAgo } from '../engine/QuantMath';

export class MovingAverageTrendStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'ma_trend',
    name: '双均线趋势策略',
    description: '用短/长周期均线趋势、价格位置和成交量确认趋势方向，适合右侧趋势跟随。',
    category: 'trend',
    default_params: { short_period: 5, long_period: 20, volume_period: 20, min_bars: 35 },
    enabled: true,
    risk_level: 'medium',
    tags: ['趋势', '均线', '右侧'],
    style: 'momentum',
    edge_hypothesis: {
      thesis:
        '双均线右侧入场：价格站上长周期 MA20 + 短 MA5 > 长 MA20 + 短上穿长（金叉）+ 长 MA20 向上 + 量能 ≥ 1.15 均量确认',
      category: 'trend',
      expected_edge_pct: 5.0,
      expected_holding_days: 20,
      key_factors: ['close_vs_ma_long', 'ma_short_vs_long', 'ma_long_slope', 'volume_ratio', 'price_momentum_20d'],
      evidence_link: '经典双均线系统 / Stan Weinstein - Secrets For Profiting (1988)',
      failure_modes: [
        '震荡市频繁金叉死叉，换手率爆炸 alpha 被费率吞噬',
        '短期 momentum20 > 35% 加速尾段追高即套',
        'momentum20 < -8% 时金叉信号是死叉前的最后一弹',
      ],
      kill_switch_metric: 'win_rate_30d',
      kill_switch_threshold: 0.4,
    },
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const volumes = bars.map(bar => bar.volume || 0);
    const latest = last(bars);
    const shortMa = sma(closes, Number(params.short_period));
    const longMa = sma(closes, Number(params.long_period));
    const volumeMa = sma(volumes, Number(params.volume_period));
    const latestShort = last(shortMa) || 0;
    const prevShort = valueNDaysAgo(shortMa, 1) || latestShort;
    const latestLong = last(longMa) || 0;
    const prevLong = valueNDaysAgo(longMa, 1) || latestLong;
    const latestClose = latest?.close || 0;
    const volumeRatio = last(volumeMa) ? (latest?.volume || 0) / (last(volumeMa) || 1) : 1;
    const momentum20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);

    let score = 45;
    const reasons: string[] = [];
    const risk_flags: string[] = [];
    if (latestClose > latestLong) {
      score += 16;
      reasons.push('收盘价站上长周期均线');
    }
    if (latestShort > latestLong) {
      score += 18;
      reasons.push('短均线位于长均线上方，趋势结构偏强');
    }
    if (prevShort <= prevLong && latestShort > latestLong) {
      score += 10;
      reasons.push('出现短均线上穿长均线的趋势确认信号');
    }
    if (latestLong > prevLong) {
      score += 8;
      reasons.push('长周期均线开始上行');
    }
    if (volumeRatio >= 1.15) {
      score += 6;
      reasons.push('成交量较均量放大，趋势确认度提升');
    }
    if (momentum20 < -8) {
      score -= 10;
      risk_flags.push('近20日走势偏弱，趋势信号可能尚未确认');
    }
    if (momentum20 > 35) {
      score -= 6;
      risk_flags.push('短期涨幅较高，追高风险上升');
    }

    score = clamp(score);
    const signal =
      score >= 72 ? 'buy' : score >= 58 ? 'watch' : latestShort < latestLong ? 'sell' : 'hold';
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal,
      score: round(score, 2),
      confidence: round(clamp(score - 8), 2),
      entry_price: latestClose,
      stop_loss_price: round(latestClose * 0.93, 4),
      take_profit_price: round(latestClose * 1.14, 4),
      target_holding_days: 20,
      reasons: reasons.length ? reasons : ['均线趋势尚未形成明显优势'],
      risk_flags,
      factors: {
        latest_close: latestClose,
        short_ma: round(latestShort, 4),
        long_ma: round(latestLong, 4),
        volume_ratio: round(volumeRatio, 2),
        momentum20: round(momentum20, 2),
      },
    };
  }
}
