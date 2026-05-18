import moment from 'moment-timezone';
import { Op } from 'sequelize';
import { RecommendationTradeOutcome } from '../../models/RecommendationTradeOutcome';
import { QuantStrategyPerformanceSnapshot } from '../../models/QuantStrategyPerformanceSnapshot';
import { QuantStrategyWeight } from '../../models/QuantStrategyWeight';
import { strategyRegistry } from '../engine/StrategyRegistry';
import { round } from '../engine/QuantMath';

function getChinaDate(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values: number[]): number | null {
  const valid = values.filter(value => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function strategyKeysFromOutcome(outcome: RecommendationTradeOutcome): string[] {
  const metadata = asPlainObject(outcome.metadata);
  const strategyVariant = asPlainObject(metadata.strategy_variant);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const paperVariant = asPlainObject(paperTrading.strategy_variant);
  const keys = [
    metadata.strategy_key,
    strategyVariant.strategy_key,
    paperTrading.strategy_key,
    paperVariant.strategy_key,
    ...(Array.isArray(strategyVariant.strategy_keys) ? strategyVariant.strategy_keys : []),
    ...(Array.isArray(paperVariant.strategy_keys) ? paperVariant.strategy_keys : []),
    ...(Array.isArray(metadata.consensus_variants) ? metadata.consensus_variants : []),
  ]
    .map(item => String(item || '').trim())
    .filter(item => item && item !== 'unknown');
  return [...new Set(keys)];
}

function marketRegimeKey(outcome: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(outcome.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const paperEnvironmentPolicy = asPlainObject(paperTrading.environment_policy);
  const env =
    asPlainObject(metadata.market_environment).market_regime ||
    asPlainObject(signalMetadata.market_environment).market_regime ||
    asPlainObject(paperEnvironmentPolicy.market_environment).market_regime ||
    paperEnvironmentPolicy.market_regime;
  return String(env || 'unknown');
}

function marketRegimeLabel(key: string): string {
  const labels: Record<string, string> = {
    bull: '市场强势',
    bear: '市场弱势',
    range: '震荡市',
    rebound: '反弹市',
    stress: '压力市',
    unknown: '环境未知',
  };
  return labels[key] || key || '环境未知';
}

function industryRegimeKey(outcome: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(outcome.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const paperEnvironmentPolicy = asPlainObject(paperTrading.environment_policy);
  const industry =
    asPlainObject(asPlainObject(metadata.market_environment).industry).regime ||
    asPlainObject(asPlainObject(signalMetadata.market_environment).industry).regime ||
    asPlainObject(asPlainObject(paperEnvironmentPolicy.market_environment).industry).regime ||
    paperEnvironmentPolicy.industry_regime;
  return String(industry || 'unknown');
}

function industryRegimeLabel(key: string): string {
  const labels: Record<string, string> = {
    hot: '行业强势',
    warm: '行业中性',
    cold: '行业弱势',
    unknown: '行业未知',
  };
  return labels[key] || key || '行业未知';
}

function computeProfitFactor(values: number[]): number {
  const wins = values.filter(value => value > 0);
  const losses = values.filter(value => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  if (grossLoss > 0) return grossProfit / grossLoss;
  return grossProfit > 0 ? 99 : 0;
}

function computeQualityScore(params: {
  closed_count: number;
  avg_return_pct: number | null;
  avg_excess_return_pct: number | null;
  win_rate: number | null;
  excess_win_rate: number | null;
  profit_factor: number | null;
}): number {
  const sampleScore = Math.min(22, params.closed_count * 3.2);
  const returnScore = Math.max(-18, Math.min(24, toNumber(params.avg_return_pct) * 2.4));
  const excessScore = Math.max(-20, Math.min(26, toNumber(params.avg_excess_return_pct) * 3.2));
  const winScore = params.win_rate === null ? 0 : (params.win_rate - 50) * 0.38;
  const excessWinScore = params.excess_win_rate === null ? 0 : (params.excess_win_rate - 50) * 0.32;
  const profitScore =
    params.profit_factor === null ? 0 : Math.max(-10, Math.min(12, (params.profit_factor - 1) * 6));
  return round(
    Math.max(
      0,
      Math.min(
        100,
        50 + sampleScore + returnScore + excessScore + winScore + excessWinScore + profitScore
      )
    ),
    2
  );
}

function weightPolicy(qualityScore: number, closedCount: number) {
  if (closedCount < 3) {
    return {
      weight: 1,
      action: 'observe',
      reason: `闭环样本 ${closedCount} 笔，样本不足，维持默认权重`,
    };
  }
  if (qualityScore >= 76) {
    return {
      weight: 1.25,
      action: 'increase',
      reason: `质量分 ${qualityScore}，策略近期表现强，下一轮候选可小幅加权`,
    };
  }
  if (qualityScore >= 62) {
    return {
      weight: 1.08,
      action: 'slight_increase',
      reason: `质量分 ${qualityScore}，策略表现良好，下一轮轻微加权`,
    };
  }
  if (qualityScore >= 45) {
    return {
      weight: 1,
      action: 'observe',
      reason: `质量分 ${qualityScore}，策略表现中性，继续观察`,
    };
  }
  if (qualityScore >= 30) {
    return {
      weight: 0.78,
      action: 'reduce',
      reason: `质量分 ${qualityScore}，策略弱于预期，下一轮降低权重`,
    };
  }
  return {
    weight: 0.55,
    action: 'pause',
    reason: `质量分 ${qualityScore}，策略近期明显跑输，进入保护性降权`,
  };
}

function actionMultiplier(action: string): number {
  if (action === 'increase') return 1.18;
  if (action === 'slight_increase') return 1.08;
  if (action === 'reduce') return 0.72;
  if (action === 'pause') return 0;
  return 1;
}

function buildRegimeBuckets(
  records: RecommendationTradeOutcome[],
  keyGetter: (record: RecommendationTradeOutcome) => string,
  labelGetter: (key: string) => string
) {
  const groups = new Map<string, RecommendationTradeOutcome[]>();
  for (const record of records) {
    const key = keyGetter(record) || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(record);
  }

  return [...groups.entries()]
    .map(([key, items]) => {
      const closed = items.filter(record => record.trade_status === 'closed');
      const open = items.filter(record => record.trade_status !== 'closed');
      const returns = closed.map(record => toNumber(record.total_pnl_pct, NaN));
      const excessReturns = closed.map(record => toNumber(record.excess_return_pct, NaN));
      const avgReturn = average(returns);
      const avgExcess = average(excessReturns);
      const winRate = closed.length
        ? (closed.filter(record => toNumber(record.total_pnl_pct) > 0).length / closed.length) * 100
        : null;
      const excessWinRate = closed.length
        ? (closed.filter(record => toNumber(record.excess_return_pct) > 0).length / closed.length) *
          100
        : null;
      const profitFactor = closed.length ? computeProfitFactor(returns) : null;
      const qualityScore = computeQualityScore({
        closed_count: closed.length,
        avg_return_pct: avgReturn,
        avg_excess_return_pct: avgExcess,
        win_rate: winRate,
        excess_win_rate: excessWinRate,
        profit_factor: profitFactor,
      });

      return {
        key,
        label: labelGetter(key),
        sample_count: items.length,
        closed_count: closed.length,
        open_count: open.length,
        avg_return_pct: avgReturn === null ? undefined : round(avgReturn, 4),
        avg_excess_return_pct: avgExcess === null ? undefined : round(avgExcess, 4),
        win_rate: winRate === null ? undefined : round(winRate, 4),
        excess_win_rate: excessWinRate === null ? undefined : round(excessWinRate, 4),
        profit_factor: profitFactor === null ? undefined : round(profitFactor, 4),
        quality_score: qualityScore,
      };
    })
    .sort((a, b) => {
      if (b.closed_count !== a.closed_count) return b.closed_count - a.closed_count;
      return toNumber(b.avg_excess_return_pct) - toNumber(a.avg_excess_return_pct);
    });
}

export class QuantStrategyFeedbackService {
  private async ensureDefaultWeights() {
    const definitions = strategyRegistry.list();
    for (const definition of definitions) {
      const [record, created] = await QuantStrategyWeight.findOrCreate({
        where: { strategy_key: definition.strategy_key },
        defaults: {
          strategy_key: definition.strategy_key,
          strategy_name: definition.name,
          weight: 1,
          action: 'observe',
          quality_score: 50,
          sample_count: 0,
          closed_count: 0,
          reason: '暂无闭环交易样本，先按默认权重参与候选筛选。',
          last_evaluated_at: new Date(),
          metrics: {
            sample_count: 0,
            closed_count: 0,
            source: 'default_registry_seed',
          },
        },
      });
      if (!created && !record.strategy_name) {
        await record.update({ strategy_name: definition.name });
      }
    }
  }

  async refreshWeights(
    options: {
      snapshot_date?: string;
      lookback_days?: number;
      source_type?: string;
      horizon?: string;
      min_samples?: number;
    } = {}
  ) {
    await this.ensureDefaultWeights();
    const snapshot_date = options.snapshot_date || getChinaDate();
    const lookbackDays = Math.min(Math.max(Number(options.lookback_days || 365), 30), 3650);
    const startDate = moment(snapshot_date).subtract(lookbackDays, 'days').format('YYYY-MM-DD');
    const sourceType = options.source_type || 'paper_trading';
    const horizon = options.horizon || 'all';

    const outcomes = await RecommendationTradeOutcome.findAll({
      where: {
        entry_date: { [Op.gte]: startDate, [Op.lte]: snapshot_date },
      },
      order: [['entry_date', 'DESC']],
      limit: 10000,
    });

    const groups = new Map<string, RecommendationTradeOutcome[]>();
    for (const outcome of outcomes) {
      for (const strategyKey of strategyKeysFromOutcome(outcome)) {
        if (!groups.has(strategyKey)) groups.set(strategyKey, []);
        groups.get(strategyKey)!.push(outcome);
      }
    }

    const strategyNames = new Map(
      strategyRegistry.list().map(item => [item.strategy_key, item.name])
    );
    const snapshots: QuantStrategyPerformanceSnapshot[] = [];
    const weights: QuantStrategyWeight[] = [];

    for (const [strategyKey, records] of groups) {
      const closed = records.filter(record => record.trade_status === 'closed');
      const open = records.filter(record => record.trade_status !== 'closed');
      const returns = closed.map(record => toNumber(record.total_pnl_pct, NaN));
      const excessReturns = closed.map(record => toNumber(record.excess_return_pct, NaN));
      const avgReturn = average(returns);
      const avgExcess = average(excessReturns);
      const winRate = closed.length
        ? (closed.filter(record => toNumber(record.total_pnl_pct) > 0).length / closed.length) * 100
        : null;
      const excessWinRate = closed.length
        ? (closed.filter(record => toNumber(record.excess_return_pct) > 0).length / closed.length) *
          100
        : null;
      const profitFactor = closed.length ? computeProfitFactor(returns) : null;
      const qualityScore = computeQualityScore({
        closed_count: closed.length,
        avg_return_pct: avgReturn,
        avg_excess_return_pct: avgExcess,
        win_rate: winRate,
        excess_win_rate: excessWinRate,
        profit_factor: profitFactor,
      });
      const byMarketRegime = buildRegimeBuckets(records, marketRegimeKey, marketRegimeLabel);
      const byIndustryRegime = buildRegimeBuckets(records, industryRegimeKey, industryRegimeLabel);

      const snapshotPayload = {
        strategy_key: strategyKey,
        snapshot_date,
        source_type: sourceType,
        horizon,
        sample_count: records.length,
        closed_count: closed.length,
        open_count: open.length,
        avg_return_pct: avgReturn === null ? undefined : round(avgReturn, 4),
        avg_excess_return_pct: avgExcess === null ? undefined : round(avgExcess, 4),
        win_rate: winRate === null ? undefined : round(winRate, 4),
        excess_win_rate: excessWinRate === null ? undefined : round(excessWinRate, 4),
        profit_factor: profitFactor === null ? undefined : round(profitFactor, 4),
        quality_score: qualityScore,
        metrics: {
          lookback_days: lookbackDays,
          start_date: startDate,
          end_date: snapshot_date,
          by_market_regime: byMarketRegime,
          by_industry_regime: byIndustryRegime,
          best_market_regime: byMarketRegime
            .filter(item => item.closed_count > 0)
            .sort(
              (a, b) => toNumber(b.avg_excess_return_pct) - toNumber(a.avg_excess_return_pct)
            )[0],
          weakest_market_regime: byMarketRegime
            .filter(item => item.closed_count > 0)
            .sort(
              (a, b) => toNumber(a.avg_excess_return_pct) - toNumber(b.avg_excess_return_pct)
            )[0],
          best_trade: closed
            .slice()
            .sort((a, b) => toNumber(b.total_pnl_pct) - toNumber(a.total_pnl_pct))[0],
          worst_trade: closed
            .slice()
            .sort((a, b) => toNumber(a.total_pnl_pct) - toNumber(b.total_pnl_pct))[0],
        },
      };

      const [snapshot] = await QuantStrategyPerformanceSnapshot.findOrCreate({
        where: {
          strategy_key: strategyKey,
          snapshot_date,
          source_type: sourceType,
          horizon,
        },
        defaults: snapshotPayload,
      });
      await snapshot.update(snapshotPayload);
      snapshots.push(snapshot);

      const policy = weightPolicy(qualityScore, closed.length);
      const weightPayload = {
        strategy_key: strategyKey,
        strategy_name: strategyNames.get(strategyKey),
        weight: policy.weight,
        action: policy.action,
        quality_score: qualityScore,
        sample_count: records.length,
        closed_count: closed.length,
        reason: policy.reason,
        last_evaluated_at: new Date(),
        metrics: {
          ...snapshotPayload,
          best_trade: undefined,
          worst_trade: undefined,
          by_market_regime: byMarketRegime,
          by_industry_regime: byIndustryRegime,
        },
      };
      const [weight] = await QuantStrategyWeight.findOrCreate({
        where: { strategy_key: strategyKey },
        defaults: weightPayload,
      });
      await weight.update(weightPayload);
      weights.push(weight);
    }

    return {
      snapshot_date,
      lookback_days: lookbackDays,
      source_type: sourceType,
      horizon,
      scanned_outcomes: outcomes.length,
      strategy_count: groups.size,
      snapshots,
      weights: weights.sort((a, b) => Number(b.quality_score || 0) - Number(a.quality_score || 0)),
      summary: {
        increase: weights.filter(item => ['increase', 'slight_increase'].includes(item.action))
          .length,
        reduce: weights.filter(item => ['reduce', 'pause'].includes(item.action)).length,
        observe: weights.filter(item => item.action === 'observe').length,
      },
    };
  }

  async listWeights() {
    await this.ensureDefaultWeights();
    return QuantStrategyWeight.findAll({
      order: [
        ['quality_score', 'DESC NULLS LAST'],
        ['strategy_key', 'ASC'],
      ] as any,
    });
  }

  async getAllocationPolicy(
    options: {
      capital?: number;
      max_weight_pct?: number;
      min_weight_pct?: number;
    } = {}
  ) {
    await this.ensureDefaultWeights();
    const capital = Math.max(Number(options.capital || 200000), 10000);
    const maxWeightPct = Math.min(Math.max(Number(options.max_weight_pct || 35), 10), 60);
    const minWeightPct = Math.min(Math.max(Number(options.min_weight_pct || 4), 0), 12);
    const weights = await this.listWeights();
    const candidates = weights
      .map(record => {
        const closedCount = toNumber(record.closed_count, 0);
        const qualityScore = toNumber(record.quality_score, 50);
        const sampleConfidence = Math.min(1, 0.55 + Math.min(closedCount, 30) * 0.015);
        const rawScore =
          Math.max(0, toNumber(record.weight, 1)) *
          Math.max(15, qualityScore) *
          sampleConfidence *
          actionMultiplier(record.action);
        return {
          strategy_key: record.strategy_key,
          strategy_name: record.strategy_name,
          action: record.action,
          quality_score: qualityScore,
          closed_count: closedCount,
          sample_count: toNumber(record.sample_count, 0),
          strategy_weight: toNumber(record.weight, 1),
          raw_score: round(rawScore, 4),
          reason: record.reason,
        };
      })
      .filter(item => item.raw_score > 0);

    const totalScore = candidates.reduce((sum, item) => sum + item.raw_score, 0) || 1;
    const initial = candidates.map(item => ({
      ...item,
      allocation_pct: Math.min(
        maxWeightPct,
        Math.max(minWeightPct, (item.raw_score / totalScore) * 100)
      ),
    }));
    const boundedTotal = initial.reduce((sum, item) => sum + item.allocation_pct, 0) || 1;
    const allocations = initial
      .map(item => {
        const allocationPct = round((item.allocation_pct / boundedTotal) * 100, 2);
        return {
          ...item,
          allocation_pct: allocationPct,
          capital_amount: round((capital * allocationPct) / 100, 2),
          max_single_trade_pct: round(Math.min(10, Math.max(3, allocationPct / 3)), 2),
          max_single_trade_amount: round(
            (capital * Math.min(10, Math.max(3, allocationPct / 3))) / 100,
            2
          ),
        };
      })
      .sort((a, b) => b.allocation_pct - a.allocation_pct);

    return {
      generated_at: new Date().toISOString(),
      capital,
      max_weight_pct: maxWeightPct,
      min_weight_pct: minWeightPct,
      allocation_count: allocations.length,
      allocations,
      summary: {
        total_allocation_pct: round(
          allocations.reduce((sum, item) => sum + item.allocation_pct, 0),
          2
        ),
        paused_count: weights.filter(item => item.action === 'pause').length,
        reduced_count: weights.filter(item => item.action === 'reduce').length,
        boosted_count: weights.filter(item => ['increase', 'slight_increase'].includes(item.action))
          .length,
      },
      rule: 'allocation_score = strategy_weight * quality_score * sample_confidence * action_multiplier；再按上下限归一化。',
    };
  }
}

export const quantStrategyFeedbackService = new QuantStrategyFeedbackService();
