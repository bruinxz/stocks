import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { average, clamp, last, pct, round, sma, valueNDaysAgo } from '../engine/QuantMath';

export class MinerviniTrendTemplateStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'minervini_trend_template',
    name: 'Minervini趋势模板策略',
    description: '参考Mark Minervini趋势模板，筛选价格强于长期均线且接近年度高位的强势股。',
    category: 'trend',
    default_params: {
      min_low52_multiple: 1.3,
      min_high52_ratio: 0.75,
      max_return20: 38,
      min_bars: 220,
    },
    enabled: true,
    risk_level: 'medium',
    tags: ['Minervini', '趋势模板', '强势股'],
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const lows = bars.map(bar => bar.low);
    const highs = bars.map(bar => bar.high);
    const volumes = bars.map(bar => Number(bar.volume || 0));
    const latestClose = last(closes) || Number(context.latest_price || 0);
    const ma50 = last(sma(closes, 50)) || latestClose;
    const ma150 = last(sma(closes, 150)) || ma50;
    const ma200Values = sma(closes, 200);
    const ma200 = last(ma200Values) || ma150;
    const ma200Past = valueNDaysAgo(ma200Values, 20) || ma200;
    const high52 = Math.max(...highs.slice(-252));
    const low52 = Math.min(...lows.slice(-252));
    const ret20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);
    const ret60 = pct(latestClose, valueNDaysAgo(closes, 60) || latestClose);
    const volumeRatio = average(volumes.slice(-5)) / Math.max(average(volumes.slice(-30)), 1);
    const qualityScore = Number(context.factor_snapshot?.fundamental?.quality_score || 0);
    const moneyFlowScore = Number(context.factor_snapshot?.money_flow?.money_flow_score || 0);

    let score = 42;
    const reasons: string[] = [];
    const risk_flags: string[] = [];

    if (latestClose > ma50 && ma50 > ma150 && ma150 > ma200) {
      score += 26;
      reasons.push('价格、50/150/200日均线符合趋势模板强势排列');
    }
    if (ma200 > ma200Past) {
      score += 10;
      reasons.push('200日均线向上，长期趋势没有走坏');
    }
    if (low52 > 0 && latestClose >= low52 * Number(params.min_low52_multiple)) {
      score += 8;
      reasons.push('价格较52周低点明显抬升，底部反转已较充分');
    }
    if (high52 > 0 && latestClose >= high52 * Number(params.min_high52_ratio)) {
      score += 10;
      reasons.push('价格接近52周高位，具备强势股特征');
    }
    if (ret60 > 8) {
      score += 8;
      reasons.push('60日涨幅为正，相对强势延续');
    }
    if (volumeRatio > 1.05 && volumeRatio < 2.5) {
      score += 6;
      reasons.push('近期量能温和放大，非无量上行');
    }
    if (qualityScore >= 68) {
      score += 5;
      reasons.push('质量因子较高，趋势模板可信度提升');
    }
    if (moneyFlowScore >= 68) {
      score += 5;
      reasons.push('资金流因子较强，主力参与度较好');
    }
    if (ret20 > Number(params.max_return20)) {
      score -= 12;
      risk_flags.push('20日涨幅过高，趋势模板不追极端短线加速');
    }
    if (latestClose < ma50) {
      score -= 18;
      risk_flags.push('价格跌破50日均线，趋势模板失效');
    }

    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: score >= 75 ? 'buy' : score >= 60 ? 'watch' : latestClose < ma50 ? 'sell' : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - risk_flags.length * 6), 2),
      entry_price: latestClose,
      stop_loss_price: round(Math.max(ma50 * 0.98, latestClose * 0.92), 4),
      take_profit_price: round(latestClose * 1.18, 4),
      target_holding_days: 25,
      reasons: reasons.length ? reasons : ['尚未满足Minervini趋势模板强势条件'],
      risk_flags,
      factors: {
        ma50: round(ma50, 4),
        ma150: round(ma150, 4),
        ma200: round(ma200, 4),
        ma200_past: round(ma200Past, 4),
        high52: round(high52, 4),
        low52: round(low52, 4),
        high52_ratio: high52 > 0 ? round((latestClose / high52) * 100, 2) : 0,
        low52_multiple: low52 > 0 ? round(latestClose / low52, 2) : 0,
        return20_pct: round(ret20, 2),
        return60_pct: round(ret60, 2),
        volume_ratio: round(volumeRatio, 2),
        quality_score: round(qualityScore, 2),
        money_flow_score: round(moneyFlowScore, 2),
      },
    };
  }
}
