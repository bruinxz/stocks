import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import {
  adx,
  average,
  clamp,
  last,
  mfi,
  obv,
  pct,
  round,
  sma,
  valueNDaysAgo,
} from '../engine/QuantMath';

export class VolumePriceConfirmationStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'volume_price_confirmation',
    name: '量价确认策略',
    description: '用价格站位、温和放量、换手率和短周期动量确认资金参与度，过滤无量上涨和极端追高。',
    category: 'momentum',
    default_params: {
      min_bars: 60,
      min_volume_ratio: 1.08,
      max_volume_ratio: 3.2,
      min_turnover_rate: 1,
      max_return20: 38,
    },
    enabled: true,
    risk_level: 'medium',
    tags: ['量价', '资金确认', '动量过滤'],
    style: 'momentum',
    edge_hypothesis: {
      thesis:
        '量价同步确认：价格站上 MA10/MA20 + 量比 ∈ [1.08, 3.2]（温和放量非脉冲）+ 换手率 ≥ 1% + MFI ∈ [45, 78] 健康区 + OBV 改善 + ret5 > 0 AND ret20 > 4%',
      category: 'momentum',
      expected_edge_pct: 5.5,
      expected_holding_days: 12,
      key_factors: ['volume_ratio', 'turnover_rate', 'mfi_14', 'obv_trend_15d', 'adx_dmi', 'return_5d', 'return_20d', 'money_flow_score'],
      evidence_link: '量价配合经典 / Joseph Granville - OBV / Money Flow Index',
      failure_modes: [
        'volume_ratio > 3.2 异常放量是情绪化 short squeeze 而非真趋势',
        'ret20 > 38% 加速尾段量价配合也是末段追高',
        'MFI > 85 资金过热拥挤，OBV 同时走弱时背离信号已现',
      ],
      kill_switch_metric: 'win_rate_30d',
      kill_switch_threshold: 0.43,
    },
  };

  evaluate(context: QuantStockContext, options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const params = this.mergeParams(options);
    const bars = context.bars || [];
    const closes = bars.map(bar => bar.close);
    const volumes = bars.map(bar => Number(bar.volume || 0));
    const turnoverRates = bars.map(bar => Number(bar.turnover_rate || 0));
    const moneyFlowFactor = context.factor_snapshot?.money_flow || {};
    const latestClose = last(closes) || Number(context.latest_price || 0);
    const ma10 = last(sma(closes, 10)) || latestClose;
    const ma20 = last(sma(closes, 20)) || ma10;
    const ret5 = pct(latestClose, valueNDaysAgo(closes, 5) || latestClose);
    const ret20 = pct(latestClose, valueNDaysAgo(closes, 20) || latestClose);
    const volumeRatio = average(volumes.slice(-3)) / Math.max(average(volumes.slice(-20)), 1);
    const latestTurnoverRate = last(turnoverRates) || 0;
    const mfiValue = last(mfi(bars, 14)) || 50;
    const obvValues = obv(bars);
    const latestObv = last(obvValues) || 0;
    const obvBase = valueNDaysAgo(obvValues, 15) ?? latestObv;
    const obvTrendPct =
      Math.abs(obvBase) > 0 ? ((latestObv - obvBase) / Math.abs(obvBase)) * 100 : 0;
    const adxValues = adx(bars, 14);
    const latestAdx = last(adxValues.adx) || 0;
    const plusDi = last(adxValues.plus_di) || 0;
    const minusDi = last(adxValues.minus_di) || 0;
    const factorMoneyFlowScore = Number(moneyFlowFactor.money_flow_score || 0);
    const factorMomentum5 = Number(moneyFlowFactor.momentum_5d || 0);

    let score = 44;
    const reasons: string[] = [];
    const risk_flags: string[] = [];

    if (latestClose > ma10 && ma10 >= ma20) {
      score += 18;
      reasons.push('价格站上10/20日均线，短线结构较强');
    }
    if (
      volumeRatio >= Number(params.min_volume_ratio) &&
      volumeRatio <= Number(params.max_volume_ratio)
    ) {
      score += 18;
      reasons.push('近期成交量温和放大，资金参与度提升');
    } else if (volumeRatio > Number(params.max_volume_ratio)) {
      score -= 10;
      risk_flags.push('成交量异常放大，可能已进入情绪化阶段');
    } else {
      score -= 6;
      risk_flags.push('放量不足，上涨确认度不够');
    }
    if (latestTurnoverRate >= Number(params.min_turnover_rate)) {
      score += 8;
      reasons.push('换手率满足活跃度要求');
    }
    if (mfiValue >= 45 && mfiValue <= 78) {
      score += 8;
      reasons.push('MFI 处于健康资金参与区间');
    } else if (mfiValue > 85) {
      score -= 8;
      risk_flags.push('MFI 过热，短线资金拥挤');
    }
    if (obvTrendPct > 0) {
      score += 6;
      reasons.push('OBV 较近15日改善，量能累积为正');
    } else if (obvTrendPct < -12) {
      score -= 6;
      risk_flags.push('OBV 走弱，资金承接不足');
    }
    if (latestAdx >= 20 && plusDi > minusDi) {
      score += 6;
      reasons.push('ADX/DMI 确认上升趋势强度');
    } else if (latestAdx >= 22 && minusDi > plusDi) {
      score -= 8;
      risk_flags.push('ADX 显示下行趋势占优');
    }
    if (ret5 > 0 && ret20 > 4) {
      score += 12;
      reasons.push('5/20日动量方向一致，量价配合较好');
    }
    if (factorMoneyFlowScore >= 68) {
      score += 8;
      reasons.push('因子表资金流分较高，量价确认增强');
    } else if (factorMoneyFlowScore > 0 && factorMoneyFlowScore < 42) {
      score -= 6;
      risk_flags.push('因子表资金流分偏弱，需降低追入优先级');
    }
    if (ret20 > Number(params.max_return20)) {
      score -= 14;
      risk_flags.push('20日涨幅过高，量价确认不追高');
    }
    if (ret5 < -4) {
      score -= 8;
      risk_flags.push('近5日价格转弱，资金确认失效');
    }

    score = clamp(score);
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: score >= 72 ? 'buy' : score >= 58 ? 'watch' : ret5 < -6 ? 'sell' : 'hold',
      score: round(score, 2),
      confidence: round(clamp(score - risk_flags.length * 6), 2),
      entry_price: latestClose,
      stop_loss_price: round(latestClose * 0.925, 4),
      take_profit_price: round(latestClose * 1.13, 4),
      target_holding_days: 12,
      reasons: reasons.length ? reasons : ['量价配合尚未形成有效确认'],
      risk_flags,
      factors: {
        return5_pct: round(ret5, 2),
        return20_pct: round(ret20, 2),
        volume_ratio: round(volumeRatio, 2),
        turnover_rate: round(latestTurnoverRate, 2),
        mfi: round(mfiValue, 2),
        obv_trend_pct: round(obvTrendPct, 2),
        factor_date: context.factor_snapshot?.factor_date,
        factor_money_flow_score: round(factorMoneyFlowScore, 2),
        factor_momentum_5d: round(factorMomentum5, 2),
        factor_money_flow_source: moneyFlowFactor.source,
        adx: round(latestAdx, 2),
        plus_di: round(plusDi, 2),
        minus_di: round(minusDi, 2),
        ma10: round(ma10, 4),
        ma20: round(ma20, 4),
      },
    };
  }
}
