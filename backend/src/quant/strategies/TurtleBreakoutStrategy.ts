import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { atr, average, clamp, last, pct, round, sma, valueNDaysAgo } from '../engine/QuantMath';
import {
  turtleEntryWithPatternFilter,
  inferLocalRegime,
} from '../../services/research/pattern-library';

export class TurtleBreakoutStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'turtle_breakout',
    name: '海龟突破策略',
    description: '参考海龟交易法的20/55日突破框架，强调顺势、波动止损和分批验证。',
    category: 'breakout',
    default_params: {
      fast_breakout_window: 20,
      slow_breakout_window: 55,
      atr_period: 20,
      min_volume_ratio: 1,
      min_bars: 95,
    },
    enabled: true,
    risk_level: 'high',
    tags: ['海龟交易', '20日突破', '55日突破', 'ATR'],
    style: 'momentum',
    edge_hypothesis: {
      thesis:
        '海龟 20/55 日双窗突破：close > 55 日新高（中期）或 > 20 日新高（短期）+ MA20>MA60 顺势 + 量能 3/20 日比 ≥ 1.0 + ATR 控制 N 值',
      category: 'breakout',
      expected_edge_pct: 8.0,
      expected_holding_days: 30,
      key_factors: [
        'close_vs_high_20',
        'close_vs_high_55',
        'ma20_vs_ma60',
        'atr_pct',
        'volume_3_20_ratio',
        'return_60d',
      ],
      evidence_link: 'Richard Dennis / Bill Eckhardt - Turtle Trading (1983)',
      failure_modes: [
        '震荡市 20 日突破频繁失败（whipsaw），ATR 止损反复触发',
        'ATR/价格比 > 9% 的高波动突破后回撤超过 2N 被止损',
        'ret20 > 50% 的加速尾段突破后立即回落洗盘',
      ],
      kill_switch_metric: 'win_rate_30d',
      kill_switch_threshold: 0.38,
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
    const fastWindow = Number(params.fast_breakout_window);
    const slowWindow = Number(params.slow_breakout_window);
    const high20 = Math.max(...highs.slice(Math.max(0, highs.length - fastWindow - 1), -1));
    const high55 = Math.max(...highs.slice(Math.max(0, highs.length - slowWindow - 1), -1));
    const low20 = Math.min(...lows.slice(Math.max(0, lows.length - fastWindow - 1), -1));
    const atrValue = last(atr(bars, Number(params.atr_period))) || latestClose * 0.04;
    const atrPct = latestClose > 0 ? (atrValue / latestClose) * 100 : 0;
    const ma20 = last(sma(closes, 20)) || latestClose;
    const ma60 = last(sma(closes, 60)) || ma20;
    const volumeRatio = average(volumes.slice(-3)) / Math.max(average(volumes.slice(-20)), 1);
    const ret20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);
    const ret60 = pct(latestClose, valueNDaysAgo(closes, 60) || latestClose);

    let score = 38;
    const reasons: string[] = [];
    const risk_flags: string[] = [];

    if (Number.isFinite(high20) && latestClose > high20) {
      score += 18;
      reasons.push('收盘价突破20日高点，出现短周期海龟入场信号');
    }
    if (Number.isFinite(high55) && latestClose > high55) {
      score += 24;
      reasons.push('收盘价突破55日高点，中期趋势确认更强');
    }
    if (latestClose > ma20 && ma20 > ma60) {
      score += 13;
      reasons.push('价格与20/60日均线保持顺势排列');
    }
    if (volumeRatio >= Number(params.min_volume_ratio)) {
      score += 8;
      reasons.push('突破伴随量能确认');
    }
    if (ret60 > 10 && ret20 > 0) {
      score += 8;
      reasons.push('20/60日动量同向，趋势延续性较好');
    }
    if (atrPct > 9) {
      score -= 12;
      risk_flags.push('单位波动N值过大，需要降低仓位或等待更好入场');
    }
    if (ret20 > 50) {
      score -= 9;
      risk_flags.push('短期涨幅过大，海龟突破容易遭遇回撤洗盘');
    }
    if (latestClose < low20) {
      score -= 18;
      risk_flags.push('价格跌破20日低点，触发海龟退出观察');
    }

    score = clamp(score);

    // Sprint 24 接入: Turtle entry × pattern reliability filter
    // 用 Bulkowski-style 形态置信度调整 score
    const regime = inferLocalRegime(closes);
    const turtleCheck = turtleEntryWithPatternFilter(closes, regime);
    const patternMul = turtleCheck.pattern_validation.multiplier;
    const scoreBeforePattern = score;
    score = clamp(score * patternMul);
    if (!turtleCheck.proceed && score >= 76) {
      // 形态过滤拦截 — 即使原 score 触发 buy, 形态不通过则降到 watch
      reasons.push(`形态过滤未通过 (${regime}市, mul=${patternMul.toFixed(2)}), 降级 buy→watch`);
      score = Math.min(score, 70);
    } else if (turtleCheck.proceed && patternMul > 1) {
      reasons.push(
        `形态确认 (${regime}市): mul ${patternMul.toFixed(2)} → ${scoreBeforePattern.toFixed(
          0
        )}→${score.toFixed(0)}`
      );
    }

    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal:
        score >= 76
          ? 'buy'
          : score >= 61
          ? 'watch'
          : latestClose < low20 || latestClose < ma60
          ? 'sell'
          : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - risk_flags.length * 7), 2),
      entry_price: latestClose,
      stop_loss_price: round(Math.max(latestClose - atrValue * 2, latestClose * 0.88), 4),
      take_profit_price: round(latestClose + atrValue * 4.5, 4),
      target_holding_days: 30,
      reasons: reasons.length ? reasons : ['尚未形成海龟突破入场条件'],
      risk_flags,
      factors: {
        high20: round(high20, 4),
        high55: round(high55, 4),
        low20: round(low20, 4),
        atr: round(atrValue, 4),
        atr_pct: round(atrPct, 2),
        ma20: round(ma20, 4),
        ma60: round(ma60, 4),
        volume_ratio: round(volumeRatio, 2),
        return20_pct: round(ret20, 2),
        return60_pct: round(ret60, 2),
        local_regime: regime,
        turtle_pattern_multiplier: round(patternMul, 3),
        turtle_entry_pass: turtleCheck.proceed,
      },
    };
  }
}
