import moment from 'moment-timezone';
import { Op } from 'sequelize';
import { RecommendationTradeOutcome } from '../../../models/RecommendationTradeOutcome';
import { QuantStrategyPerformanceSnapshot } from '../../../models/QuantStrategyPerformanceSnapshot';
import { QuantStrategyWeight } from '../../../models/QuantStrategyWeight';
import { strategyRegistry } from '../../engine/StrategyRegistry';
import { round } from '../../engine/QuantMath';

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

function pctText(value: any, digits = 1): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '--';
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(digits)}%`;
}

function compactList(values: Array<string | undefined | null>, limit = 4): string[] {
  return values
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function sampleConfidence(closedCount: number): {
  score: number;
  level: 'empty' | 'low' | 'medium' | 'high' | 'strong';
  label: string;
} {
  if (closedCount <= 0) return { score: 20, level: 'empty', label: '无闭环样本' };
  if (closedCount < 3) return { score: 35, level: 'low', label: '样本不足' };
  if (closedCount < 8) return { score: 55, level: 'medium', label: '低置信' };
  if (closedCount < 20) return { score: 72, level: 'high', label: '中等置信' };
  return {
    score: round(Math.min(95, 82 + Math.min(closedCount - 20, 30) * 0.45), 2),
    level: 'strong',
    label: '高置信',
  };
}

function actionText(action: string): string {
  const labels: Record<string, string> = {
    increase: '加权',
    slight_increase: '轻加权',
    observe: '观察',
    reduce: '降权',
    pause: '暂停',
  };
  return labels[action] || action || '观察';
}

function nextActionText(action: string): string {
  if (action === 'increase') return '下轮扫描放大候选权重，优先进入模拟盘验证。';
  if (action === 'slight_increase') return '小幅加权，继续用 3-5 笔闭环确认稳定性。';
  if (action === 'reduce') return '降低候选排序权重，只有多策略共识时再少量参与。';
  if (action === 'pause') return '保护性暂停资金分配，仅保留观察和复盘。';
  return '维持默认权重，等待更多平仓样本后再自动调参。';
}

function regimeBrief(item: any) {
  if (!item) return undefined;
  return {
    key: item.key,
    label: item.label || item.key,
    closed_count: toNumber(item.closed_count, 0),
    avg_excess_return_pct: item.avg_excess_return_pct,
    quality_score: item.quality_score,
  };
}

function bestRegime(items: any[]) {
  return items
    .filter(item => toNumber(item.closed_count, 0) > 0)
    .sort((a, b) => toNumber(b.avg_excess_return_pct) - toNumber(a.avg_excess_return_pct))[0];
}

function weakestRegime(items: any[]) {
  return items
    .filter(item => toNumber(item.closed_count, 0) > 0)
    .sort((a, b) => toNumber(a.avg_excess_return_pct) - toNumber(b.avg_excess_return_pct))[0];
}

function summarizeTrade(record?: RecommendationTradeOutcome) {
  if (!record) return undefined;
  return {
    id: record.id,
    symbol: record.symbol,
    name: record.name,
    entry_date: record.entry_date,
    exit_date: record.exit_date,
    total_pnl_pct: record.total_pnl_pct,
    excess_return_pct: record.excess_return_pct,
    holding_days: record.holding_days,
    exit_reason_label: record.exit_reason_label,
  };
}

function recentClosedRecords(records: RecommendationTradeOutcome[]): RecommendationTradeOutcome[] {
  if (!records.length) return [];
  const limit = Math.min(8, Math.max(3, Math.ceil(records.length * 0.35)));
  return records
    .slice()
    .sort((a, b) => {
      const bDate = String(b.exit_date || b.entry_date || b.signal_date || b.created_at || '');
      const aDate = String(a.exit_date || a.entry_date || a.signal_date || a.created_at || '');
      return bDate.localeCompare(aDate);
    })
    .slice(0, limit);
}

function worstAdversePct(records: RecommendationTradeOutcome[]): number | null {
  const values = records
    .map(record => toNumber(record.max_adverse_excursion_pct, NaN))
    .filter(value => Number.isFinite(value));
  if (!values.length) return null;
  const byAbsolute = values.map(value => -Math.abs(value));
  return Math.min(...byAbsolute);
}

function buildWeightDecision(params: {
  strategy_key: string;
  strategy_name?: string;
  sample_count: number;
  closed_count: number;
  open_count: number;
  quality_score: number;
  avg_return_pct: number | null;
  avg_excess_return_pct: number | null;
  win_rate: number | null;
  excess_win_rate: number | null;
  profit_factor: number | null;
  recent_avg_return_pct: number | null;
  recent_avg_excess_return_pct: number | null;
  recent_count: number;
  worst_return_pct: number | null;
  worst_adverse_pct: number | null;
  by_market_regime: any[];
  by_industry_regime: any[];
}) {
  const confidence = sampleConfidence(params.closed_count);
  const avgExcess = toNumber(params.avg_excess_return_pct, 0);
  const avgReturn = toNumber(params.avg_return_pct, 0);
  const winRate = params.win_rate === null ? 50 : toNumber(params.win_rate, 50);
  const excessWinRate = params.excess_win_rate === null ? 50 : toNumber(params.excess_win_rate, 50);
  const recentExcess =
    params.recent_avg_excess_return_pct === null
      ? avgExcess
      : toNumber(params.recent_avg_excess_return_pct, avgExcess);
  const worstReturn = params.worst_return_pct === null ? 0 : toNumber(params.worst_return_pct, 0);
  const adversePct =
    params.worst_adverse_pct === null ? 0 : Math.abs(toNumber(params.worst_adverse_pct, 0));
  const downsideGuard = worstReturn <= -12 || adversePct >= 12;
  const clearUnderperformance =
    params.closed_count >= 5 && (avgExcess <= -4 || recentExcess <= -5 || excessWinRate < 38);
  const recentDeteriorating =
    params.closed_count >= 6 && recentExcess < Math.min(-2, avgExcess - 3);

  let action = 'observe';
  let weight = 1;

  if (params.closed_count < 3) {
    action = 'observe';
    weight = 1;
  } else if (clearUnderperformance && params.quality_score < 34) {
    action = 'pause';
    weight = 0.55;
  } else if (clearUnderperformance || (downsideGuard && params.quality_score < 58)) {
    action = 'reduce';
    weight = 0.78;
  } else if (
    params.quality_score >= 78 &&
    avgExcess > 1 &&
    winRate >= 52 &&
    recentExcess >= -1 &&
    !downsideGuard
  ) {
    action = 'increase';
    weight = 1.25;
  } else if (
    params.quality_score >= 64 &&
    avgExcess >= 0 &&
    winRate >= 48 &&
    !recentDeteriorating
  ) {
    action = 'slight_increase';
    weight = 1.08;
  } else if (params.quality_score >= 45 && !clearUnderperformance) {
    action = 'observe';
    weight = 1;
  } else if (params.quality_score >= 30) {
    action = 'reduce';
    weight = 0.78;
  } else {
    action = 'pause';
    weight = 0.55;
  }

  if (confidence.score < 60 && action === 'increase') {
    action = 'slight_increase';
    weight = 1.08;
  }
  if (confidence.score < 45 && ['increase', 'slight_increase'].includes(action)) {
    action = 'observe';
    weight = 1;
  }

  const bestMarket = bestRegime(params.by_market_regime);
  const weakestMarket = weakestRegime(params.by_market_regime);
  const bestIndustry = bestRegime(params.by_industry_regime);
  const weakestIndustry = weakestRegime(params.by_industry_regime);

  const reasons = compactList([
    `质量分 ${params.quality_score.toFixed(1)}，${confidence.label}（闭环 ${
      params.closed_count
    } 笔）`,
    `平均收益 ${pctText(avgReturn)}，超额收益 ${pctText(avgExcess)}，胜率 ${
      params.win_rate === null ? '--' : pctText(params.win_rate, 0)
    }`,
    params.recent_count
      ? `近 ${params.recent_count} 笔超额 ${pctText(params.recent_avg_excess_return_pct)}`
      : undefined,
    bestMarket
      ? `优势环境：${bestMarket.label}，超额 ${pctText(bestMarket.avg_excess_return_pct)}`
      : undefined,
  ]);

  const risk_notes = compactList(
    [
      params.closed_count < 8
        ? `闭环样本仅 ${params.closed_count} 笔，禁止一次性重仓。`
        : undefined,
      downsideGuard
        ? `最差单笔 ${pctText(worstReturn)} / 最大不利波动 ${pctText(-adversePct)}，需压仓位。`
        : undefined,
      recentDeteriorating
        ? `近期超额 ${pctText(recentExcess)}，较整体表现转弱，需等待修复。`
        : undefined,
      excessWinRate < 45 && params.closed_count >= 5
        ? `超额胜率 ${pctText(excessWinRate, 0)}，跑赢指数稳定性不足。`
        : undefined,
      weakestMarket
        ? `弱势环境：${weakestMarket.label}，历史超额 ${pctText(
            weakestMarket.avg_excess_return_pct
          )}。`
        : undefined,
    ],
    5
  );

  const actionLabel = actionText(action);
  const next_action = nextActionText(action);
  const confidenceScore = round(
    Math.max(
      0,
      Math.min(
        100,
        confidence.score * 0.55 +
          params.quality_score * 0.3 +
          Math.max(0, Math.min(15, avgExcess + 7))
      )
    ),
    2
  );
  const reason = `${actionLabel}：${reasons.slice(0, 3).join('；')}。`;

  return {
    action,
    action_label: actionLabel,
    weight,
    confidence: confidenceScore,
    sample_confidence: confidence.score,
    sample_confidence_level: confidence.level,
    sample_confidence_label: confidence.label,
    reason,
    reasons,
    risk_notes,
    next_action,
    evidence: {
      strategy_key: params.strategy_key,
      strategy_name: params.strategy_name,
      sample_count: params.sample_count,
      closed_count: params.closed_count,
      open_count: params.open_count,
      quality_score: params.quality_score,
      avg_return_pct: params.avg_return_pct,
      avg_excess_return_pct: params.avg_excess_return_pct,
      win_rate: params.win_rate,
      excess_win_rate: params.excess_win_rate,
      profit_factor: params.profit_factor,
      recent_count: params.recent_count,
      recent_avg_return_pct: params.recent_avg_return_pct,
      recent_avg_excess_return_pct: params.recent_avg_excess_return_pct,
      worst_return_pct: params.worst_return_pct,
      worst_adverse_pct: params.worst_adverse_pct,
    },
    regime_fit: {
      best_market_regime: regimeBrief(bestMarket),
      weakest_market_regime: regimeBrief(weakestMarket),
      best_industry_regime: regimeBrief(bestIndustry),
      weakest_industry_regime: regimeBrief(weakestIndustry),
    },
    playbook: {
      sizing:
        action === 'increase'
          ? '可进入优先预算池，但单票仍按风控上限执行。'
          : action === 'slight_increase'
          ? '只做小幅预算倾斜，等待更多闭环确认。'
          : action === 'reduce'
          ? '降权参与，优先让多策略共识和低风险票通过。'
          : action === 'pause'
          ? '暂停资金分配，保留信号用于复盘。'
          : '默认预算观察，不主动放大。',
      review:
        params.closed_count < 8
          ? '优先补齐样本，至少观察到 8 笔闭环后再做激进调整。'
          : '每个交易日收盘后自动刷新，若近期转弱会继续降权。',
      guardrail: risk_notes[0] || '继续遵守单票仓位、止损和现金保留下限。',
    },
  };
}

function buildFallbackWeightDecision(record: QuantStrategyWeight, strategyName?: string) {
  const metrics = asPlainObject(record.metrics);
  const closedCount = toNumber(record.closed_count, 0);
  const sampleCount = toNumber(record.sample_count, closedCount);
  const qualityScore = toNumber(record.quality_score, 50);
  const confidence = sampleConfidence(closedCount);
  const action = record.action || 'observe';
  const actionLabel = actionText(action);
  const weight = toNumber(record.weight, 1);
  const evidence = {
    strategy_key: record.strategy_key,
    strategy_name: record.strategy_name || strategyName,
    sample_count: sampleCount,
    closed_count: closedCount,
    open_count: Math.max(0, sampleCount - closedCount),
    quality_score: qualityScore,
    avg_return_pct: metrics.avg_return_pct,
    avg_excess_return_pct: metrics.avg_excess_return_pct,
    win_rate: metrics.win_rate,
    excess_win_rate: metrics.excess_win_rate,
    profit_factor: metrics.profit_factor,
    recent_count: metrics.recent_count,
    recent_avg_return_pct: metrics.recent_avg_return_pct,
    recent_avg_excess_return_pct: metrics.recent_avg_excess_return_pct,
    worst_return_pct: metrics.worst_return_pct,
    worst_adverse_pct: metrics.worst_adverse_pct,
  };
  const reasons = compactList([
    `质量分 ${qualityScore.toFixed(1)}，${confidence.label}（闭环 ${closedCount} 笔）`,
    metrics.avg_excess_return_pct !== undefined
      ? `历史超额 ${pctText(metrics.avg_excess_return_pct)}`
      : undefined,
    record.reason || '旧版本权重记录已自动补齐可解释决策',
  ]);
  const risk_notes = compactList([
    closedCount < 8 ? `闭环样本仅 ${closedCount} 笔，禁止一次性重仓。` : undefined,
    metrics.worst_return_pct !== undefined
      ? `历史最差单笔 ${pctText(metrics.worst_return_pct)}，继续按风控上限执行。`
      : undefined,
  ]);

  return {
    action,
    action_label: actionLabel,
    weight,
    confidence: round(Math.max(20, Math.min(90, confidence.score * 0.6 + qualityScore * 0.4)), 2),
    sample_confidence: confidence.score,
    sample_confidence_level: confidence.level,
    sample_confidence_label: confidence.label,
    reason: record.reason || `${actionLabel}：${reasons.join('；')}。`,
    reasons,
    risk_notes,
    next_action: nextActionText(action),
    evidence,
    regime_fit: {
      best_market_regime: regimeBrief(metrics.best_market_regime),
      weakest_market_regime: regimeBrief(metrics.weakest_market_regime),
      best_industry_regime: regimeBrief(metrics.best_industry_regime),
      weakest_industry_regime: regimeBrief(metrics.weakest_industry_regime),
    },
    playbook: {
      sizing:
        action === 'pause'
          ? '暂停资金分配，保留信号用于复盘。'
          : action === 'reduce'
          ? '降权参与，优先让多策略共识和低风险票通过。'
          : ['increase', 'slight_increase'].includes(action)
          ? '可进入预算倾斜池，但单票仍按风控上限执行。'
          : '默认预算观察，不主动放大。',
      review:
        closedCount < 8
          ? '优先补齐样本，至少观察到 8 笔闭环后再做激进调整。'
          : '每个交易日收盘后自动刷新，若近期转弱会继续降权。',
      guardrail: risk_notes[0] || '继续遵守单票仓位、止损和现金保留下限。',
    },
    migrated_from_legacy_metrics: true,
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
    const definitionNames = new Map(definitions.map(item => [item.strategy_key, item.name]));
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
            weight_decision: {
              action: 'observe',
              action_label: '观察',
              weight: 1,
              confidence: 20,
              sample_confidence: 20,
              sample_confidence_label: '无闭环样本',
              reason: '观察：暂无闭环交易样本，先按默认权重参与候选筛选。',
              reasons: ['暂无闭环交易样本'],
              risk_notes: ['先让模拟盘积累平仓样本，再自动加减权。'],
              next_action: '维持默认权重，等待更多平仓样本后再自动调参。',
            },
          },
        },
      });
      if (!created && !record.strategy_name) {
        await record.update({ strategy_name: definition.name });
      }
    }

    const existing = await QuantStrategyWeight.findAll();
    for (const record of existing) {
      const metrics = asPlainObject(record.metrics);
      if (metrics.weight_decision) continue;
      const fallbackDecision = buildFallbackWeightDecision(
        record,
        definitionNames.get(record.strategy_key)
      );
      await record.update({
        metrics: {
          ...metrics,
          weight_decision: fallbackDecision,
        },
        reason: record.reason || fallbackDecision.reason,
        strategy_name:
          record.strategy_name || definitionNames.get(record.strategy_key) || record.strategy_name,
      });
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
      const recentClosed = recentClosedRecords(closed);
      const recentReturns = recentClosed.map(record => toNumber(record.total_pnl_pct, NaN));
      const recentExcessReturns = recentClosed.map(record =>
        toNumber(record.excess_return_pct, NaN)
      );
      const recentAvgReturn = average(recentReturns);
      const recentAvgExcess = average(recentExcessReturns);
      const bestMarketRegime = bestRegime(byMarketRegime);
      const weakestMarketRegime = weakestRegime(byMarketRegime);
      const bestIndustryRegime = bestRegime(byIndustryRegime);
      const weakestIndustryRegime = weakestRegime(byIndustryRegime);
      const bestTrade = closed
        .slice()
        .sort((a, b) => toNumber(b.total_pnl_pct) - toNumber(a.total_pnl_pct))[0];
      const worstTrade = closed
        .slice()
        .sort((a, b) => toNumber(a.total_pnl_pct) - toNumber(b.total_pnl_pct))[0];
      const worstReturnPct = worstTrade ? toNumber(worstTrade.total_pnl_pct, 0) : null;
      const worstAdverse = worstAdversePct(closed);
      const decision = buildWeightDecision({
        strategy_key: strategyKey,
        strategy_name: strategyNames.get(strategyKey),
        sample_count: records.length,
        closed_count: closed.length,
        open_count: open.length,
        quality_score: qualityScore,
        avg_return_pct: avgReturn,
        avg_excess_return_pct: avgExcess,
        win_rate: winRate,
        excess_win_rate: excessWinRate,
        profit_factor: profitFactor,
        recent_avg_return_pct: recentAvgReturn,
        recent_avg_excess_return_pct: recentAvgExcess,
        recent_count: recentClosed.length,
        worst_return_pct: worstReturnPct,
        worst_adverse_pct: worstAdverse,
        by_market_regime: byMarketRegime,
        by_industry_regime: byIndustryRegime,
      });

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
          best_market_regime: bestMarketRegime,
          weakest_market_regime: weakestMarketRegime,
          best_industry_regime: bestIndustryRegime,
          weakest_industry_regime: weakestIndustryRegime,
          recent_count: recentClosed.length,
          recent_avg_return_pct: recentAvgReturn === null ? undefined : round(recentAvgReturn, 4),
          recent_avg_excess_return_pct:
            recentAvgExcess === null ? undefined : round(recentAvgExcess, 4),
          worst_return_pct: worstReturnPct === null ? undefined : round(worstReturnPct, 4),
          worst_adverse_pct: worstAdverse === null ? undefined : round(worstAdverse, 4),
          best_trade: summarizeTrade(bestTrade),
          worst_trade: summarizeTrade(worstTrade),
          weight_decision: decision,
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

      const weightPayload = {
        strategy_key: strategyKey,
        strategy_name: strategyNames.get(strategyKey),
        weight: decision.weight,
        action: decision.action,
        quality_score: qualityScore,
        sample_count: records.length,
        closed_count: closed.length,
        reason: decision.reason,
        last_evaluated_at: new Date(),
        metrics: {
          ...snapshotPayload,
          best_trade: summarizeTrade(bestTrade),
          worst_trade: summarizeTrade(worstTrade),
          by_market_regime: byMarketRegime,
          by_industry_regime: byIndustryRegime,
          weight_decision: decision,
        },
      };
      const [weight] = await QuantStrategyWeight.findOrCreate({
        where: { strategy_key: strategyKey },
        defaults: weightPayload,
      });
      await weight.update(weightPayload);
      weights.push(weight);
    }

    const sortedWeights = weights.sort(
      (a, b) => Number(b.quality_score || 0) - Number(a.quality_score || 0)
    );
    const boostedWeights = sortedWeights.filter(item =>
      ['increase', 'slight_increase'].includes(item.action)
    );
    const reducedWeights = sortedWeights.filter(item => ['reduce', 'pause'].includes(item.action));
    const topBoosted = boostedWeights.slice(0, 3).map(item => ({
      strategy_key: item.strategy_key,
      strategy_name: item.strategy_name,
      action: item.action,
      weight: Number(item.weight || 1),
      quality_score: Number(item.quality_score || 0),
      reason: item.reason,
      decision: asPlainObject(item.metrics).weight_decision,
    }));
    const topReduced = reducedWeights.slice(0, 3).map(item => ({
      strategy_key: item.strategy_key,
      strategy_name: item.strategy_name,
      action: item.action,
      weight: Number(item.weight || 1),
      quality_score: Number(item.quality_score || 0),
      reason: item.reason,
      decision: asPlainObject(item.metrics).weight_decision,
    }));
    const highConfidenceCount = sortedWeights.filter(
      item =>
        toNumber(asPlainObject(asPlainObject(item.metrics).weight_decision).sample_confidence, 0) >=
        72
    ).length;
    const conclusion = sortedWeights.length
      ? `本轮调权完成：${boostedWeights.length} 个加权、${reducedWeights.length} 个降权/暂停，${highConfidenceCount} 个具备中高置信样本。`
      : '本轮暂无可调权策略，等待模拟盘平仓样本。';

    return {
      snapshot_date,
      lookback_days: lookbackDays,
      source_type: sourceType,
      horizon,
      scanned_outcomes: outcomes.length,
      strategy_count: groups.size,
      snapshots,
      weights: sortedWeights,
      summary: {
        increase: weights.filter(item => ['increase', 'slight_increase'].includes(item.action))
          .length,
        reduce: weights.filter(item => ['reduce', 'pause'].includes(item.action)).length,
        observe: weights.filter(item => item.action === 'observe').length,
        high_confidence_count: highConfidenceCount,
        conclusion,
        top_boosted: topBoosted,
        top_reduced: topReduced,
        next_actions: compactList([
          boostedWeights.length
            ? `优先让 ${boostedWeights
                .slice(0, 2)
                .map(item => item.strategy_name || item.strategy_key)
                .join('、')} 进入开盘候选预算池。`
            : undefined,
          reducedWeights.length
            ? `对 ${reducedWeights
                .slice(0, 2)
                .map(item => item.strategy_name || item.strategy_key)
                .join('、')} 保持降权/暂停，避免继续放大亏损。`
            : undefined,
          '继续用模拟盘闭环平仓结果反哺权重，样本不足策略只观察不重仓。',
        ]),
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
        const decision = asPlainObject(asPlainObject(record.metrics).weight_decision);
        const confidence = sampleConfidence(closedCount);
        const sampleConfidenceRatio = Math.min(
          1,
          Math.max(0.25, toNumber(decision.sample_confidence, confidence.score) / 100)
        );
        const confidenceRatio = Math.min(
          1.1,
          Math.max(0.45, toNumber(decision.confidence, qualityScore) / 100)
        );
        const rawScore =
          Math.max(0, toNumber(record.weight, 1)) *
          Math.max(15, qualityScore) *
          sampleConfidenceRatio *
          confidenceRatio *
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
          decision,
          sample_confidence: toNumber(decision.sample_confidence, confidence.score),
          sample_confidence_label: decision.sample_confidence_label || confidence.label,
          next_action: decision.next_action,
          risk_notes: Array.isArray(decision.risk_notes) ? decision.risk_notes : [],
          regime_fit: asPlainObject(decision.regime_fit),
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

    const boosted = allocations.filter(item =>
      ['increase', 'slight_increase'].includes(item.action)
    );
    const reduced = weights.filter(item => ['reduce', 'pause'].includes(item.action));
    const topAllocations = allocations.slice(0, 3);
    const conclusion = allocations.length
      ? `当前 20W 预算优先给 ${topAllocations
          .map(item => item.strategy_name || item.strategy_key)
          .join('、')}；${boosted.length} 个策略加权，${reduced.length} 个策略降权/暂停。`
      : '暂无可执行策略预算：所有策略处于暂停或样本不足状态。';
    const nextActions = compactList([
      boosted.length
        ? `加权策略用于开盘候选排序，但单票仍不超过各自 max_single_trade_pct。`
        : '暂无强加权策略，继续按默认权重积累样本。',
      reduced.length ? `降权/暂停策略只保留观察信号，避免扩大回撤。` : undefined,
      '每日收盘后用真实模拟盘平仓收益自动刷新下一轮预算。',
    ]);

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
        high_confidence_count: allocations.filter(item => toNumber(item.sample_confidence, 0) >= 72)
          .length,
        conclusion,
        top_boosted: boosted.slice(0, 3),
        top_reduced: reduced.slice(0, 3).map(item => ({
          strategy_key: item.strategy_key,
          strategy_name: item.strategy_name,
          action: item.action,
          quality_score: Number(item.quality_score || 0),
          reason: item.reason,
          decision: asPlainObject(item.metrics).weight_decision,
        })),
        next_actions: nextActions,
      },
      next_actions: nextActions,
      rule: 'allocation_score = strategy_weight * quality_score * sample_confidence * action_multiplier；再按上下限归一化。',
    };
  }
}

export const quantStrategyFeedbackService = new QuantStrategyFeedbackService();
