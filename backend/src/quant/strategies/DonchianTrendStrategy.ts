import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { atr, average, clamp, last, pct, round, sma, valueNDaysAgo } from '../engine/QuantMath';

export class DonchianTrendStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'donchian_trend',
    name: 'Donchian通道趋势策略',
    description: '借鉴经典通道突破体系，捕捉中期新高突破并用ATR控制波动风险。',
    category: 'breakout',
    default_params: {
      entry_window: 55,
      exit_window: 20,
      atr_period: 14,
      min_volume_ratio: 1.05,
      min_bars: 95,
    },
    enabled: true,
    risk_level: 'high',
    tags: ['Donchian', '通道突破', 'ATR风控'],
    style: 'momentum',
    edge_hypothesis: {
      thesis:
        'Donchian 55 日上轨突破 + MA50>MA100 多头排列 + 60 日动量 8-65% 区间 + 量能 5/20 日均比 ≥ 1.05 确认；ATR 控制波动风险',
      category: 'breakout',
      expected_edge_pct: 7.0,
      expected_holding_days: 25,
      key_factors: ['close_vs_donchian_55_high', 'ma50_vs_ma100', 'return_60d', 'atr_pct', 'volume_5_20_ratio'],
      evidence_link: 'Richard Donchian - 4-week rule (1960s) / Donchian Channel',
      failure_modes: [
        '震荡市频繁假突破，ATR 止损反复触发',
        '高 ATR 区间突破后回撤过深超过 2*ATR',
        '20 日动量 > 45% 的加速尾段突破后立即回落',
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
    const lows = bars.map(bar => bar.low);
    const volumes = bars.map(bar => Number(bar.volume || 0));
    const latestClose = last(closes) || Number(context.latest_price || 0);
    const entryWindow = Number(params.entry_window);
    const exitWindow = Number(params.exit_window);
    const previousEntryHigh = Math.max(
      ...highs.slice(Math.max(0, highs.length - entryWindow - 1), -1)
    );
    const previousExitLow = Math.min(...lows.slice(Math.max(0, lows.length - exitWindow - 1), -1));
    const ma50 = last(sma(closes, 50)) || latestClose;
    const ma100 = last(sma(closes, 100)) || ma50;
    const atrValue = last(atr(bars, Number(params.atr_period))) || latestClose * 0.04;
    const atrPct = latestClose > 0 ? (atrValue / latestClose) * 100 : 0;
    const volumeRatio = average(volumes.slice(-5)) / Math.max(average(volumes.slice(-20)), 1);
    const ret20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);
    const ret60 = pct(latestClose, valueNDaysAgo(closes, 60) || latestClose);

    let score = 40;
    const reasons: string[] = [];
    const risk_flags: string[] = [];

    if (Number.isFinite(previousEntryHigh) && latestClose > previousEntryHigh) {
      score += 32;
      reasons.push(`收盘价突破${entryWindow}日Donchian上轨`);
    }
    if (latestClose > ma50 && ma50 > ma100) {
      score += 14;
      reasons.push('价格位于50/100日均线上方，中期趋势结构成立');
    }
    if (volumeRatio >= Number(params.min_volume_ratio)) {
      score += 8;
      reasons.push('突破前后成交量温和放大，资金确认度较好');
    }
    if (ret60 > 8 && ret60 < 65) {
      score += 10;
      reasons.push('60日动量为正且未进入极端加速区');
    }
    if (ret20 > 45) {
      score -= 10;
      risk_flags.push('近20日涨幅过高，通道突破可能处于加速尾段');
    }
    if (atrPct > 8) {
      score -= 8;
      risk_flags.push('ATR占价格比例偏高，突破后回撤噪声较大');
    }
    if (latestClose < ma50) {
      score -= 10;
      risk_flags.push('价格跌回50日均线下方，趋势突破可靠性下降');
    }

    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal:
        score >= 74
          ? 'buy'
          : score >= 60
          ? 'watch'
          : latestClose < previousExitLow || ma50 < ma100
          ? 'sell'
          : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - risk_flags.length * 6), 2),
      entry_price: latestClose,
      stop_loss_price: round(Math.max(latestClose - atrValue * 2, latestClose * 0.9), 4),
      take_profit_price: round(latestClose + atrValue * 4, 4),
      target_holding_days: 25,
      reasons: reasons.length ? reasons : ['Donchian通道尚未出现有效向上突破'],
      risk_flags,
      factors: {
        previous_entry_high: round(previousEntryHigh, 4),
        previous_exit_low: round(previousExitLow, 4),
        ma50: round(ma50, 4),
        ma100: round(ma100, 4),
        atr: round(atrValue, 4),
        atr_pct: round(atrPct, 2),
        volume_ratio: round(volumeRatio, 2),
        return20_pct: round(ret20, 2),
        return60_pct: round(ret60, 2),
      },
    };
  }
}
