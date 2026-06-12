import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { clamp, last, pct, round, rsi, valueNDaysAgo } from '../engine/QuantMath';

export class RsiMeanReversionStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'rsi_reversion',
    name: 'RSI 均值回归策略',
    description: '捕捉 RSI 超卖后的修复机会，适合震荡市和强势股回调后的低吸。',
    category: 'mean_reversion',
    default_params: { period: 14, oversold: 35, overbought: 72, min_bars: 35 },
    enabled: true,
    risk_level: 'medium',
    tags: ['RSI', '低吸', '均值回归'],
    style: 'mean_reversion',
    edge_hypothesis: {
      thesis:
        'RSI 超卖修复：RSI(14) ≤ 35 进入超卖区 + RSI 较前一周期回升（拐头）+ 近 5 日跌幅在 (-18%, -5%) 区间（充分回调但非崩跌）',
      category: 'mean_reversion',
      expected_edge_pct: 5.0,
      expected_holding_days: 10,
      key_factors: ['rsi_14', 'rsi_rebound', 'price_drop_5d'],
      evidence_link: 'Welles Wilder - New Concepts in Technical Trading Systems (1978) / RSI',
      failure_modes: [
        '强趋势下行时 RSI 长时间钝化在超卖区，反复抄底反复止损',
        '近 5 日跌幅 ≤ -18% 的崩跌走势，"低吸"实为接飞刀',
        'RSI 进入超买 ≥ 72 但仓位未及时止盈，盈转亏',
      ],
      kill_switch_metric: 'win_rate_30d',
      kill_switch_threshold: 0.45,
    },
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const closes = (context.bars || []).map(bar => bar.close);
    const latestClose = last(closes) || 0;
    const rsiValues = rsi(closes, Number(params.period));
    const latestRsi = last(rsiValues) || 50;
    const prevRsi = valueNDaysAgo(rsiValues, 1) || latestRsi;
    const drop5 = pct(latestClose, valueNDaysAgo(closes, 5) || latestClose);
    const rebound = latestRsi > prevRsi;
    let score = 42;
    const reasons: string[] = [];
    const risk_flags: string[] = [];
    if (latestRsi <= Number(params.oversold)) {
      score += 24;
      reasons.push('RSI 进入超卖区域，具备均值修复条件');
    }
    if (rebound) {
      score += 12;
      reasons.push('RSI 较上一周期回升，短线修复动能改善');
    }
    if (drop5 < -5 && drop5 > -18) {
      score += 10;
      reasons.push('近5日回调较充分但未出现极端崩跌');
    }
    if (drop5 <= -18) {
      score -= 12;
      risk_flags.push('短期跌幅过大，可能不是健康回调');
    }
    if (latestRsi >= Number(params.overbought)) {
      score -= 16;
      risk_flags.push('RSI 进入超买区域，不适合均值回归买入');
    }
    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal:
        score >= 70
          ? 'buy'
          : score >= 55
          ? 'watch'
          : latestRsi > Number(params.overbought)
          ? 'sell'
          : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - 12), 2),
      entry_price: latestClose,
      stop_loss_price: round(latestClose * 0.94, 4),
      take_profit_price: round(latestClose * 1.09, 4),
      target_holding_days: 10,
      reasons: reasons.length ? reasons : ['RSI 未进入有效低吸区间'],
      risk_flags,
      factors: { rsi: round(latestRsi, 2), prev_rsi: round(prevRsi, 2), drop5: round(drop5, 2) },
    };
  }
}
