import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { average, clamp, last, pct, round, sma, stddev, valueNDaysAgo } from '../engine/QuantMath';

export class DualMomentumRotationStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'dual_momentum_rotation',
    name: '双动量轮动策略',
    description: '结合绝对动量和相对强弱，优先选择中短期趋势同时为正且波动可控的候选。',
    category: 'momentum',
    default_params: {
      short_window: 20,
      middle_window: 60,
      long_window: 120,
      max_volatility20: 6.2,
      min_bars: 150,
    },
    enabled: true,
    risk_level: 'medium',
    tags: ['双动量', '轮动', '相对强弱'],
    style: 'momentum',
    edge_hypothesis: {
      thesis:
        '绝对动量 + 相对强弱双确认：ret20 > 5% AND ret60 > 8% AND ret120 > 10%，价格站上 MA20/MA60，20 日波动率 ≤ 6.2 控制风险',
      category: 'momentum',
      expected_edge_pct: 6.5,
      expected_holding_days: 18,
      key_factors: ['return_20d', 'return_60d', 'return_120d', 'volatility_20d', 'volume_5_30_ratio', 'money_flow_score'],
      evidence_link: 'Antonacci - Dual Momentum Investing (2014)',
      failure_modes: [
        '动量崩塌（regime shift）：bull→bear 切换时全部 ret 转负仍按 momentum 入场',
        '波动放大到 > 6.2 时降级但仓位未及时缩减',
        '短期 ret20 > 42% 的加速尾段追高被立即收割',
      ],
      kill_switch_metric: 'sharpe_30d',
      kill_switch_threshold: 0.3,
    },
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const volumes = bars.map(bar => Number(bar.volume || 0));
    const latestClose = last(closes) || Number(context.latest_price || 0);
    const ret20 = pct(
      latestClose,
      valueNDaysAgo(closes, Number(params.short_window)) || latestClose
    );
    const ret60 = pct(
      latestClose,
      valueNDaysAgo(closes, Number(params.middle_window)) || latestClose
    );
    const ret120 = pct(
      latestClose,
      valueNDaysAgo(closes, Number(params.long_window)) || latestClose
    );
    const ma20 = last(sma(closes, 20)) || latestClose;
    const ma60 = last(sma(closes, 60)) || ma20;
    const returns = closes.slice(1).map((value, index) => pct(value, closes[index]));
    const vol20 = stddev(returns.slice(-20));
    const volumeRatio = average(volumes.slice(-5)) / Math.max(average(volumes.slice(-30)), 1);
    const moneyFlowScore = Number(context.factor_snapshot?.money_flow?.money_flow_score || 0);

    const momentumComposite = ret20 * 0.45 + ret60 * 0.38 + ret120 * 0.17;
    let score = 45;
    const reasons: string[] = [];
    const risk_flags: string[] = [];

    if (ret20 > 5 && ret60 > 8) {
      score += 20;
      reasons.push('20/60日绝对动量均为正，短中期趋势同向');
    }
    if (ret120 > 10) {
      score += 10;
      reasons.push('120日长周期动量为正，轮动背景较好');
    }
    if (momentumComposite > 12) {
      score += 12;
      reasons.push('综合动量得分较高，具备相对强势候选特征');
    }
    if (latestClose > ma20 && ma20 >= ma60) {
      score += 10;
      reasons.push('价格站上20/60日均线，动量没有破坏');
    }
    if (vol20 <= Number(params.max_volatility20)) {
      score += 8;
      reasons.push('短期波动率可控，轮动持仓体验更稳定');
    } else {
      score -= 8;
      risk_flags.push('20日波动率偏高，轮动策略需降低仓位');
    }
    if (volumeRatio > 1.05) {
      score += 6;
      reasons.push('量能温和放大，动量延续获得成交确认');
    }
    if (moneyFlowScore >= 68) {
      score += 6;
      reasons.push('资金流因子较强，轮动资金承接较好');
    }
    if (ret20 > 42) {
      score -= 10;
      risk_flags.push('短期动量过热，避免轮动追高');
    }
    if (ret20 < -5 || latestClose < ma60) {
      score -= 12;
      risk_flags.push('短期绝对动量转弱，轮动候选降级');
    }

    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: score >= 73 ? 'buy' : score >= 59 ? 'watch' : ret20 < -8 ? 'sell' : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - risk_flags.length * 6), 2),
      entry_price: latestClose,
      stop_loss_price: round(latestClose * 0.925, 4),
      take_profit_price: round(latestClose * 1.15, 4),
      target_holding_days: 18,
      reasons: reasons.length ? reasons : ['双动量轮动优势尚不明显'],
      risk_flags,
      factors: {
        return20_pct: round(ret20, 2),
        return60_pct: round(ret60, 2),
        return120_pct: round(ret120, 2),
        momentum_composite: round(momentumComposite, 2),
        volatility20: round(vol20, 2),
        volume_ratio: round(volumeRatio, 2),
        money_flow_score: round(moneyFlowScore, 2),
        ma20: round(ma20, 4),
        ma60: round(ma60, 4),
      },
    };
  }
}
