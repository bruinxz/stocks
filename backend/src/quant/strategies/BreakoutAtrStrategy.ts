import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { atr, average, clamp, last, pct, round, valueNDaysAgo } from '../engine/QuantMath';

export class BreakoutAtrStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'breakout_atr',
    name: 'ATR 突破策略',
    description: '识别N日新高/箱体突破，并用ATR设定保护止损，适合捕捉启动型机会。',
    category: 'breakout',
    default_params: { breakout_window: 20, atr_period: 14, volume_ratio: 1.25, min_bars: 45 },
    enabled: true,
    risk_level: 'high',
    tags: ['突破', 'ATR', '启动'],
    style: 'momentum',
    edge_hypothesis: {
      thesis:
        'ATR 加权突破：close 突破 N 日新高且突破幅度 >= ATR (有意义的突破，非震荡噪音)，配合放量确认',
      category: 'breakout',
      expected_edge_pct: 8.0,
      expected_holding_days: 15,
      key_factors: ['close_vs_n_day_high', 'breakout_atr_multiple', 'volume_confirmation'],
      evidence_link: 'Welles Wilder - ATR (1978) / Turtle Trading',
      failure_modes: [
        '低 ATR 期假突破（盘整突破后无后续）',
        '高 ATR 期突破点已经远离合理入场',
        '财报/事件驱动的突破缺乏延续性',
      ],
      kill_switch_metric: 'win_rate_30d',
      kill_switch_threshold: 0.4,
    },
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const highs = bars.map(bar => bar.high);
    const volumes = bars.map(bar => bar.volume || 0);
    const latest = last(bars);
    const latestClose = latest?.close || 0;
    const window = Number(params.breakout_window);
    const previousHigh = Math.max(...highs.slice(Math.max(0, highs.length - window - 1), -1));
    const atrValues = atr(bars, Number(params.atr_period));
    const latestAtr = last(atrValues) || latestClose * 0.04;
    const volRatio = average(volumes.slice(-3)) / Math.max(average(volumes.slice(-20)), 1);
    const ret20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);
    let score = 40;
    const reasons: string[] = [];
    const risk_flags: string[] = [];
    if (latestClose > previousHigh && Number.isFinite(previousHigh)) {
      score += 28;
      reasons.push(`收盘价突破${window}日高点`);
    }
    if (volRatio >= Number(params.volume_ratio)) {
      score += 14;
      reasons.push('突破伴随成交量放大');
    }
    if (ret20 > 5 && ret20 < 35) {
      score += 10;
      reasons.push('突破前动量健康，未出现极端过热');
    }
    if (ret20 >= 35) {
      score -= 12;
      risk_flags.push('突破前短期涨幅已高，可能是假突破或加速尾端');
    }
    if (latestAtr / Math.max(latestClose, 1) > 0.08) {
      score -= 8;
      risk_flags.push('ATR 波动率偏高，突破后回撤风险较大');
    }
    score = clamp(score);
    const stopLoss = Math.max(latestClose - latestAtr * 2, latestClose * 0.9);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal:
        score >= 72
          ? 'buy'
          : score >= 58
          ? 'watch'
          : latestClose < previousHigh * 0.96
          ? 'sell'
          : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - 10), 2),
      entry_price: latestClose,
      stop_loss_price: round(stopLoss, 4),
      take_profit_price: round(latestClose + latestAtr * 3, 4),
      target_holding_days: 15,
      reasons: reasons.length ? reasons : ['尚未形成有效突破'],
      risk_flags,
      factors: {
        previous_high: round(previousHigh, 4),
        atr: round(latestAtr, 4),
        volume_ratio: round(volRatio, 2),
        return20_pct: round(ret20, 2),
      },
    };
  }
}
