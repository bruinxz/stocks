import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { Stock } from '../models/Stock';
import { DailyBar } from '../models/DailyBar';
import { FavoriteStock } from '../models/FavoriteStock';
import { AIInvestmentSignal, AISignalSourceType } from '../models/AIInvestmentSignal';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { normalizeSymbol } from '../utils/stockSymbol';
import { logger } from '../utils/logger';
import { DEFAULT_BENCHMARK_INDICES } from './BenchmarkIndexService';
import {
  marketEnvironmentService,
  type MarketEnvironmentSnapshot,
} from './MarketEnvironmentService';

export type RecommendationUniverse = 'favorites' | 'market';
export type RecommendationStyle = 'balanced' | 'momentum' | 'value' | 'low_risk';
export type RecommendationSource = 'favorites' | 'market' | 'mixed';
export type RecommendationAction = 'buy' | 'watch' | 'hold' | 'avoid';
export type RecommendationTier = 'strong_recommend' | 'trial_position' | 'watchlist' | 'avoid';

export interface QuantRecommendationOptions {
  user_id?: number;
  universe?: RecommendationUniverse;
  style?: RecommendationStyle;
  limit?: number;
  lookback_days?: number;
  min_bars?: number;
  include_trend?: boolean;
  candidate_pool_limit?: number;
  exclude_st?: boolean;
  min_market_cap_yi?: number;
}

export interface QuantRecommendationExperimentVariant {
  key?: string;
  label?: string;
  universe?: RecommendationUniverse;
  style?: RecommendationStyle;
  limit?: number;
  candidate_pool_limit?: number;
  lookback_days?: number;
  min_bars?: number;
  exclude_st?: boolean;
  min_market_cap_yi?: number;
}

export interface QuantRecommendationExperimentOptions {
  user_id?: number;
  universe?: RecommendationUniverse;
  limit?: number;
  candidate_pool_limit?: number;
  lookback_days?: number;
  min_bars?: number;
  exclude_st?: boolean;
  min_market_cap_yi?: number;
  variants?: QuantRecommendationExperimentVariant[];
}

interface FactorScore {
  name: string;
  label: string;
  score: number;
  weight: number;
  value?: number | string;
  reason: string;
}

interface EnrichedBar {
  time: Date;
  close: number;
  volume: number;
  turnover?: number;
  turnover_rate?: number;
  change_percent?: number;
  is_suspended?: boolean;
}

export type QuantDataQualityBucket = 'high' | 'medium' | 'low' | 'critical';

export interface QuantDataQualityAssessment {
  score: number;
  bucket: QuantDataQualityBucket;
  confidence_multiplier: number;
  position_multiplier: number;
  auto_trade_allowed: boolean;
  recommendation:
    | 'allow_auto_trade'
    | 'allow_reduced_position'
    | 'manual_review_required'
    | 'block_auto_trade';
  issues: string[];
  warnings: string[];
  coverage: {
    bars: 'ok' | 'partial' | 'missing';
    freshness: 'ok' | 'partial' | 'missing';
    price: 'ok' | 'missing';
    turnover: 'ok' | 'partial' | 'missing';
    valuation: 'ok' | 'partial' | 'missing';
    listing_status: 'ok' | 'blocked';
  };
  metrics: {
    bar_count: number;
    expected_min_bars: number;
    latest_date?: string;
    days_since_latest?: number;
    valid_close_count: number;
    zero_volume_count: number;
    turnover_coverage_pct: number;
    avg_turnover_yuan?: number;
    market_cap_yi?: number | null;
    valuation_field_count: number;
  };
}

export interface QuantRecommendationItem {
  symbol: string;
  name: string;
  market?: string;
  industry?: string;
  source: RecommendationSource;
  score: number;
  rating: '强烈关注' | '积极关注' | '观察' | '谨慎';
  risk_level: 'low' | 'medium' | 'high';
  confidence: number;
  current_price: number;
  change_percent?: number;
  data_quality_score: number;
  data_quality_bucket: QuantDataQualityBucket;
  data_quality: QuantDataQualityAssessment;
  factors: FactorScore[];
  reasons: string[];
  warnings: string[];
  action: RecommendationAction;
  action_label: '可小仓试买' | '等待确认' | '继续持有观察' | '暂不参与';
  suggested_position_pct: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  metrics: Record<string, number | null>;
  feedback?: RecommendationFeedback;
  recommendation_tier: RecommendationTier;
  recommendation_tier_label: '强推荐池' | '轻仓试错池' | '观察池' | '回避池';
  tier_reason: string;
  tier_rank: number;
  original_score?: number;
  pre_quality_score?: number;
  consensus_count?: number;
  consensus_bonus?: number;
  consensus_variants?: string[];
  market_environment?: MarketEnvironmentSnapshot;
  trend?: Array<{ time: string; close: number }>;
}

export interface RecommendationFeedback {
  signal_count: number;
  completed_count: number;
  trade_outcome_count?: number;
  closed_trade_count?: number;
  avg_return_pct: number | null;
  avg_excess_return_pct?: number | null;
  avg_trade_return_pct?: number | null;
  avg_trade_excess_return_pct?: number | null;
  positive_rate: number | null;
  excess_positive_rate?: number | null;
  trade_win_rate?: number | null;
  trade_excess_win_rate?: number | null;
  best_horizon?: string;
  score_adjustment: number;
  confidence_boost: number;
  latest_signal_date?: string;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number | undefined | null, digits = 2): number | null {
  if (value === undefined || value === null || !Number.isFinite(value)) return null;
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

function pct(current: number, previous: number): number | undefined {
  if (!previous || !Number.isFinite(current) || !Number.isFinite(previous)) return undefined;
  return ((current - previous) / previous) * 100;
}

function average(values: number[]): number | undefined {
  const valid = values.filter(v => Number.isFinite(v));
  if (valid.length === 0) return undefined;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function stddev(values: number[]): number | undefined {
  const avg = average(values);
  if (avg === undefined || values.length < 2) return undefined;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function maxDrawdown(closes: number[]): number {
  let peak = closes[0] || 0;
  let maxDd = 0;
  for (const close of closes) {
    if (close > peak) peak = close;
    if (peak > 0) {
      const dd = ((close - peak) / peak) * 100;
      maxDd = Math.min(maxDd, dd);
    }
  }
  return maxDd;
}

function buildEmptyFeedback(): RecommendationFeedback {
  return {
    signal_count: 0,
    completed_count: 0,
    trade_outcome_count: 0,
    closed_trade_count: 0,
    avg_return_pct: null,
    avg_excess_return_pct: null,
    avg_trade_return_pct: null,
    avg_trade_excess_return_pct: null,
    positive_rate: null,
    excess_positive_rate: null,
    trade_win_rate: null,
    trade_excess_win_rate: null,
    score_adjustment: 0,
    confidence_boost: 0,
  };
}

function scoreToRating(score: number): QuantRecommendationItem['rating'] {
  if (score >= 82) return '强烈关注';
  if (score >= 70) return '积极关注';
  if (score >= 58) return '观察';
  return '谨慎';
}

function resolveAction(params: {
  score: number;
  risk_level: QuantRecommendationItem['risk_level'];
  warnings: string[];
  feedback: RecommendationFeedback;
}): {
  action: RecommendationAction;
  action_label: QuantRecommendationItem['action_label'];
  suggested_position_pct: number;
} {
  const negativeFeedback =
    params.feedback.completed_count >= 3 && Number(params.feedback.avg_return_pct || 0) < -2;

  if (params.score < 58 || params.risk_level === 'high' || negativeFeedback) {
    return {
      action: 'avoid',
      action_label: '暂不参与',
      suggested_position_pct: 0,
    };
  }

  if (params.score >= 76 && params.risk_level === 'low' && params.warnings.length === 0) {
    return {
      action: 'buy',
      action_label: '可小仓试买',
      suggested_position_pct: Math.min(12, Math.max(5, Math.round((params.score - 66) / 2))),
    };
  }

  if (params.score >= 66) {
    return {
      action: 'watch',
      action_label: '等待确认',
      suggested_position_pct: params.risk_level === 'medium' ? 3 : 5,
    };
  }

  return {
    action: 'hold',
    action_label: '继续持有观察',
    suggested_position_pct: params.risk_level === 'low' ? 4 : 2,
  };
}

function resolveRecommendationTier(params: {
  score: number;
  risk_level: QuantRecommendationItem['risk_level'];
  action: RecommendationAction;
  warnings: string[];
  feedback: RecommendationFeedback;
  factors: FactorScore[];
}): {
  recommendation_tier: RecommendationTier;
  recommendation_tier_label: QuantRecommendationItem['recommendation_tier_label'];
  tier_reason: string;
  tier_rank: number;
} {
  const primaryFeedbackReturn =
    params.feedback.avg_trade_excess_return_pct ??
    params.feedback.avg_trade_return_pct ??
    params.feedback.avg_excess_return_pct ??
    params.feedback.avg_return_pct;
  const primaryWinRate =
    params.feedback.trade_excess_win_rate ??
    params.feedback.trade_win_rate ??
    params.feedback.excess_positive_rate ??
    params.feedback.positive_rate;
  const hasClosedFeedback =
    Number(params.feedback.closed_trade_count || 0) > 0 || params.feedback.completed_count > 0;
  const positiveFeedback =
    hasClosedFeedback &&
    Number(primaryFeedbackReturn || 0) >= -0.5 &&
    (primaryWinRate === null || primaryWinRate === undefined || Number(primaryWinRate) >= 45);
  const negativeFeedback =
    hasClosedFeedback &&
    (Number(primaryFeedbackReturn || 0) < -2 ||
      (primaryWinRate !== null && primaryWinRate !== undefined && Number(primaryWinRate) < 38));
  const factorPassCount = params.factors.filter(factor => factor.score >= 68).length;
  const hasCriticalWarning = params.warnings.some(warning =>
    /追高|回撤|缺失|急剧放大|后验收益/.test(warning)
  );

  if (params.action === 'avoid' || params.risk_level === 'high' || negativeFeedback) {
    return {
      recommendation_tier: 'avoid',
      recommendation_tier_label: '回避池',
      tier_rank: 4,
      tier_reason: negativeFeedback
        ? `历史后验偏弱，平均收益/超额 ${round(primaryFeedbackReturn, 2) ?? '--'}%，先降权回避`
        : '风险等级偏高或交易纪律为暂不参与，禁止自动买入',
    };
  }

  if (
    params.action === 'buy' &&
    params.score >= 82 &&
    params.risk_level === 'low' &&
    params.warnings.length === 0 &&
    factorPassCount >= 3 &&
    (!hasClosedFeedback || positiveFeedback)
  ) {
    return {
      recommendation_tier: 'strong_recommend',
      recommendation_tier_label: '强推荐池',
      tier_rank: 1,
      tier_reason: `评分 ${round(
        params.score,
        1
      )}，低风险、无硬警告，${factorPassCount} 个核心因子达标，可进入强推荐复核`,
    };
  }

  if (['buy', 'watch'].includes(params.action) && params.score >= 72 && !hasCriticalWarning) {
    return {
      recommendation_tier: 'trial_position',
      recommendation_tier_label: '轻仓试错池',
      tier_rank: 2,
      tier_reason: `评分 ${round(
        params.score,
        1
      )}，具备交易候选价值，但仍需小仓试错或等待 Agent 复核`,
    };
  }

  return {
    recommendation_tier: 'watchlist',
    recommendation_tier_label: '观察池',
    tier_rank: 3,
    tier_reason:
      params.score >= 62
        ? '趋势或量能有迹象，但评分/风险/警告尚不足以进入自动交易'
        : '综合得分仍偏低，仅保留观察，不进入自动跟单',
  };
}

function getStyleWeights(style: RecommendationStyle): Record<string, number> {
  // Batch AD (2026-06-18): 加 today_burst + industry_regime 两个维度.
  // 之前 trend/volume 看 5-60d 均量比和中期收益, 单日 +5~8% 完全不奖励;
  // 加 today_burst (today change_pct + volume_ratio 当日爆发) + industry_regime
  // (所在行业近 5 日是否 hot 板块) 让单日轮动板块的强势股能进 top N.
  // 各 style 重平衡, sum 保持 1.0:
  switch (style) {
    case 'momentum':
      // 动量 style 最看重单日爆发 + 行业轮动
      return {
        trend: 0.26,
        volume: 0.16,
        quality: 0.1,
        valuation: 0.08,
        risk: 0.12,
        today_burst: 0.18,
        industry_regime: 0.1,
      };
    case 'value':
      // 价值 style 仍以基本面 / 估值为主, 今日维度仅微调
      return {
        trend: 0.18,
        volume: 0.1,
        quality: 0.22,
        valuation: 0.24,
        risk: 0.14,
        today_burst: 0.06,
        industry_regime: 0.06,
      };
    case 'low_risk':
      // 低风险 style 不奖励单日爆发
      return {
        trend: 0.18,
        volume: 0.1,
        quality: 0.2,
        valuation: 0.14,
        risk: 0.28,
        today_burst: 0.04,
        industry_regime: 0.06,
      };
    case 'balanced':
    default:
      return {
        trend: 0.22,
        volume: 0.16,
        quality: 0.16,
        valuation: 0.12,
        risk: 0.16,
        today_burst: 0.1,
        industry_regime: 0.08,
      };
  }
}

export class QuantRecommendationService {
  async runStrategyExperiment(options: QuantRecommendationExperimentOptions = {}) {
    const baseUniverse = options.universe || 'market';
    const baseLimit = Math.min(Math.max(options.limit || 12, 3), 50);
    const basePoolLimit = Math.min(
      Math.max(Number(options.candidate_pool_limit || 0) || baseLimit * 10, 80),
      1000
    );
    const defaultVariants: QuantRecommendationExperimentVariant[] = [
      { key: 'balanced_core', label: '均衡核心', style: 'balanced' },
      { key: 'momentum_breakout', label: '动量突破', style: 'momentum' },
      { key: 'value_reversal', label: '价值反转', style: 'value' },
      { key: 'low_risk_steady', label: '低波稳健', style: 'low_risk' },
    ];
    const variants = (options.variants?.length ? options.variants : defaultVariants).slice(0, 8);
    const results: any[] = [];
    const symbolToVariants = new Map<string, Set<string>>();

    for (const variant of variants) {
      const style = ['balanced', 'momentum', 'value', 'low_risk'].includes(variant.style || '')
        ? variant.style!
        : 'balanced';
      const universe = variant.universe || baseUniverse;
      const generated = await this.generateRecommendations({
        user_id: options.user_id,
        universe,
        style,
        limit: Math.min(Math.max(variant.limit || baseLimit, 3), 80),
        candidate_pool_limit: Math.min(
          Math.max(Number(variant.candidate_pool_limit || 0) || basePoolLimit, 80),
          1000
        ),
        lookback_days: Math.min(
          Math.max(variant.lookback_days || options.lookback_days || 120, 45),
          360
        ),
        min_bars: variant.min_bars || options.min_bars,
        include_trend: false,
        exclude_st: variant.exclude_st ?? options.exclude_st ?? true,
        min_market_cap_yi:
          variant.min_market_cap_yi ??
          options.min_market_cap_yi ??
          (universe === 'market' ? 30 : undefined),
      });
      const recommendations = generated.recommendations || [];
      const tierCounts = recommendations.reduce((acc: Record<string, number>, item) => {
        const tier = item.recommendation_tier || 'watchlist';
        acc[tier] = (acc[tier] || 0) + 1;
        return acc;
      }, {});
      const riskCounts = recommendations.reduce((acc: Record<string, number>, item) => {
        const risk = item.risk_level || 'unknown';
        acc[risk] = (acc[risk] || 0) + 1;
        return acc;
      }, {});
      const avgScore =
        recommendations.length > 0
          ? recommendations.reduce((sum, item) => sum + Number(item.score || 0), 0) /
            recommendations.length
          : 0;
      const avgPosition =
        recommendations.length > 0
          ? recommendations.reduce(
              (sum, item) => sum + Number(item.suggested_position_pct || 0),
              0
            ) / recommendations.length
          : 0;
      const feedbackAdjusted = recommendations.filter(
        item => Number(item.feedback?.signal_count || 0) > 0
      ).length;
      const topSymbols = recommendations.slice(0, 5).map(item => {
        const key = variant.key || `${style}_${universe}`;
        if (!symbolToVariants.has(item.symbol)) symbolToVariants.set(item.symbol, new Set());
        symbolToVariants.get(item.symbol)!.add(key);
        return {
          symbol: item.symbol,
          name: item.name,
          score: item.score,
          tier: item.recommendation_tier,
          tier_label: item.recommendation_tier_label,
          risk_level: item.risk_level,
          action: item.action,
          suggested_position_pct: item.suggested_position_pct,
        };
      });
      const qualityScore = round(
        avgScore * 0.58 +
          Number(tierCounts.strong_recommend || 0) * 5 +
          Number(tierCounts.trial_position || 0) * 2.4 -
          Number(tierCounts.avoid || 0) * 3 -
          Number(riskCounts.high || 0) * 4 +
          Math.min(8, feedbackAdjusted * 0.8),
        2
      );

      results.push({
        key: variant.key || `${style}_${universe}`,
        label: variant.label || style,
        universe,
        style,
        params: {
          limit: generated.recommendations.length,
          candidate_pool_limit: variant.candidate_pool_limit || basePoolLimit,
          lookback_days: variant.lookback_days || options.lookback_days || 120,
          min_market_cap_yi:
            variant.min_market_cap_yi ??
            options.min_market_cap_yi ??
            (universe === 'market' ? 30 : undefined),
        },
        generated: {
          total_candidates: generated.total_candidates,
          analyzed_candidates: generated.analyzed_candidates,
        },
        metrics: {
          avg_score: round(avgScore, 2),
          avg_position_pct: round(avgPosition, 2),
          strong_count: tierCounts.strong_recommend || 0,
          trial_count: tierCounts.trial_position || 0,
          watch_count: tierCounts.watchlist || 0,
          avoid_count: tierCounts.avoid || 0,
          low_risk_count: riskCounts.low || 0,
          medium_risk_count: riskCounts.medium || 0,
          high_risk_count: riskCounts.high || 0,
          feedback_adjusted_count: feedbackAdjusted,
          quality_score: qualityScore || 0,
        },
        tier_counts: tierCounts,
        risk_counts: riskCounts,
        top_symbols: topSymbols,
      });
    }

    const overlaps = [...symbolToVariants.entries()]
      .map(([symbol, variantSet]) => ({
        symbol,
        variant_count: variantSet.size,
        variants: [...variantSet],
      }))
      .filter(item => item.variant_count > 1)
      .sort((a, b) => b.variant_count - a.variant_count || a.symbol.localeCompare(b.symbol))
      .slice(0, 20);
    const champion = [...results].sort(
      (a, b) =>
        Number(b.metrics.quality_score || 0) - Number(a.metrics.quality_score || 0) ||
        Number(b.metrics.strong_count || 0) - Number(a.metrics.strong_count || 0) ||
        Number(b.metrics.avg_score || 0) - Number(a.metrics.avg_score || 0)
    )[0];

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      filters: {
        universe: baseUniverse,
        limit: baseLimit,
        candidate_pool_limit: basePoolLimit,
        lookback_days: options.lookback_days || 120,
        variant_count: variants.length,
      },
      champion,
      variants: results,
      overlaps,
      insights: [
        champion
          ? `当前候选质量最高策略：${champion.label}，质量分 ${champion.metrics.quality_score}，强推荐 ${champion.metrics.strong_count}、轻仓 ${champion.metrics.trial_count}。`
          : '暂无可比较策略结果。',
        overlaps.length
          ? `${overlaps.length} 个标的被多个策略同时选中，可作为共识观察池优先复核。`
          : '不同策略暂未形成明显共识标的，建议继续扩大候选池或等待行情确认。',
      ],
    };
  }

  /**
   * Batch AD (2026-06-18): 一次性查近 5 个交易日 IndustryFlow, 算每行业的
   * mean(change_pct) + mean(main_inflow_ratio × 100) 综合得分. 返回 Map<industry_name, score>.
   *
   * 一次 query 复用给所有 scoreStock, 让"今天该买哪个板块" 的判定单次 DB IO 完成.
   * fail-safe: IndustryFlow 表空 (Batch AB cron 还没跑过) → 返回空 Map,
   * scoreIndustryRegime 走 50 中性, 不阻塞主流程.
   */
  private async buildIndustryScoreMap(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { IndustryFlow } = require('../models/IndustryFlow');
      const sevenDaysAgo = moment().tz('Asia/Shanghai').subtract(7, 'days').format('YYYY-MM-DD');
      const rows = await IndustryFlow.findAll({
        attributes: ['industry_name', 'change_pct', 'main_inflow_ratio'],
        where: { trade_date: { [Op.gte]: sevenDaysAgo } },
        raw: true,
      });
      if (!Array.isArray(rows) || rows.length === 0) return map;

      const agg = new Map<string, { changes: number[]; ratios: number[] }>();
      for (const r of rows as any[]) {
        const name = String(r.industry_name || '').trim();
        if (!name) continue;
        if (!agg.has(name)) agg.set(name, { changes: [], ratios: [] });
        const g = agg.get(name)!;
        const ch = Number(r.change_pct);
        const rt = Number(r.main_inflow_ratio);
        if (Number.isFinite(ch)) g.changes.push(ch);
        if (Number.isFinite(rt)) g.ratios.push(rt);
      }
      for (const [name, g] of agg.entries()) {
        const meanCh = g.changes.length
          ? g.changes.reduce((s, v) => s + v, 0) / g.changes.length
          : 0;
        const meanRt = g.ratios.length
          ? g.ratios.reduce((s, v) => s + v, 0) / g.ratios.length
          : 0;
        map.set(name, meanCh + meanRt * 100);
      }
    } catch (err: any) {
      logger.warn(`buildIndustryScoreMap 失败 (fail-safe 走空 Map): ${err?.message || err}`);
    }
    return map;
  }

  async generateRecommendations(options: QuantRecommendationOptions = {}): Promise<{
    as_of: string;
    universe: RecommendationUniverse;
    style: RecommendationStyle;
    total_candidates: number;
    analyzed_candidates: number;
    recommendations: QuantRecommendationItem[];
  }> {
    const universe = options.universe || 'favorites';
    const style = options.style || 'balanced';
    const limit = Math.min(Math.max(options.limit || 20, 1), 100);
    const lookback_days = Math.min(Math.max(options.lookback_days || 120, 45), 360);
    const min_bars = Math.min(Math.max(options.min_bars || 35, 20), lookback_days);

    const candidatePoolLimit =
      universe === 'market'
        ? Math.min(
            Math.max(Number(options.candidate_pool_limit || 0) || limit * 12, limit * 6, 120),
            1000
          )
        : Math.max(limit * 6, 60);
    const stocks = await this.getCandidateStocks({
      ...options,
      universe,
      limit: candidatePoolLimit,
    });
    const feedbackMap = await this.getRecommendationFeedbackMap(
      stocks.map(stock => stock.symbol).filter(Boolean)
    );
    // Batch AD (2026-06-18): 一次性 query 近 5 日 IndustryFlow, 算每行业的
    // mean(change_pct + main_inflow_ratio×100) 得分, 传给所有 scoreStock 调用.
    // 避免 N 只候选股各自 query → DB N+1.
    const industryScoreMap = await this.buildIndustryScoreMap();
    const recommendations: QuantRecommendationItem[] = [];

    for (const stock of stocks) {
      try {
        const item = await this.scoreStock(stock, {
          source: universe === 'favorites' ? 'favorites' : 'market',
          style,
          lookback_days,
          min_bars,
          include_trend: options.include_trend !== false,
          feedback: feedbackMap.get(normalizeSymbol(stock.symbol)) || buildEmptyFeedback(),
          industryScoreMap,
        });
        if (item) recommendations.push(item);
      } catch (error: any) {
        logger.warn(`多因子推荐评分失败 ${stock.symbol}: ${error.message}`);
      }
    }

    recommendations.sort((a, b) => b.score - a.score);
    const selectedRecommendations = recommendations.slice(0, limit);
    await this.attachMarketEnvironment(selectedRecommendations);

    return {
      as_of: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      universe,
      style,
      total_candidates: stocks.length,
      analyzed_candidates: recommendations.length,
      recommendations: selectedRecommendations,
    };
  }

  private async attachMarketEnvironment(recommendations: QuantRecommendationItem[]) {
    await Promise.all(
      recommendations.map(async item => {
        try {
          item.market_environment = await marketEnvironmentService.getEnvironmentForStock(
            item.symbol,
            {
              industry: item.industry,
              use_cache: true,
            }
          );
        } catch (error: any) {
          logger.warn(`推荐候选市场环境归因失败 ${item.symbol}: ${error?.message || error}`);
        }
      })
    );
  }

  async getCandidateStocks(options: {
    user_id?: number;
    universe: RecommendationUniverse;
    limit: number;
    exclude_st?: boolean;
    min_market_cap_yi?: number;
  }): Promise<Stock[]> {
    if (options.universe === 'favorites') {
      if (options.user_id) {
        const favorites = await FavoriteStock.findAll({
          where: { user_id: options.user_id },
          include: [{ model: Stock }],
          order: [
            ['sort_order', 'DESC'],
            ['created_at', 'DESC'],
          ],
          limit: options.limit,
        });

        const stocks = favorites.map(favorite => favorite.stock).filter(Boolean) as Stock[];
        if (stocks.length > 0) return stocks;
      }

      // 定时任务没有具体 user_id 时，使用全站自选股交集作为候选池。
      const globalFavorites = (await FavoriteStock.findAll({
        attributes: ['stock_id'],
        group: ['stock_id'],
        limit: options.limit,
        raw: true,
      })) as any[];
      const stockIds = globalFavorites.map(item => item.stock_id).filter(Boolean);
      if (stockIds.length > 0) {
        const stocks = await Stock.findAll({
          where: { id: { [Op.in]: stockIds } },
          limit: options.limit,
        });
        if (stocks.length > 0) return stocks;
      }
    }

    const excludedSymbols = DEFAULT_BENCHMARK_INDICES.map(index => index.symbol);
    const minMarketCapYi =
      options.min_market_cap_yi === undefined ? 30 : Number(options.min_market_cap_yi || 0);
    const marketWhere: any = {
      is_listed: true,
      [Op.or]: [{ type: 'stock' }, { type: null }],
      symbol: { [Op.notIn]: excludedSymbols },
    };
    if (options.exclude_st !== false) {
      marketWhere.name = {
        [Op.and]: [{ [Op.notILike]: '%ST%' }, { [Op.notILike]: '%退%' }],
      };
    }
    if (minMarketCapYi > 0) {
      marketWhere[Op.and] = [
        ...(marketWhere[Op.and] || []),
        {
          [Op.or]: [
            { total_market_cap: { [Op.gte]: minMarketCapYi * 100000000 } },
            { total_market_cap: null },
          ],
        },
      ];
    }

    return Stock.findAll({
      attributes: [
        'id',
        'symbol',
        'name',
        'market',
        'industry',
        'data_status',
        'total_market_cap',
        'circulating_market_cap',
        'pe_dynamic',
        'pb',
        'turnover_rate',
        'price',
        'change_percent',
        'type',
        'is_listed',
        'updated_at',
      ],
      where: {
        ...marketWhere,
      },
      order: [
        ['change_percent', 'DESC NULLS LAST'],
        ['turnover_rate', 'DESC NULLS LAST'],
        ['updated_at', 'DESC'],
        ['total_market_cap', 'DESC NULLS LAST'],
      ] as any,
      limit: options.limit,
    });
  }

  private async scoreStock(
    stock: Stock,
    options: {
      source: RecommendationSource;
      style: RecommendationStyle;
      lookback_days: number;
      min_bars: number;
      include_trend: boolean;
      feedback: RecommendationFeedback;
      /**
       * Batch AD (2026-06-18): industry → today_score Map, 由 caller 在
       * generateRecommendations 入口一次性 query IndustryFlow 后传入,
       * 让 scoreStock 内的 scoreIndustryRegime 拿到该股所在行业当日热度.
       * Map 缺失 / 行业未命中 → industry_regime score 退到 50 中性, 不阻塞.
       */
      industryScoreMap?: Map<string, number>;
    }
  ): Promise<QuantRecommendationItem | null> {
    const bars = await DailyBar.findAll({
      where: {
        stock_id: stock.id,
        time: {
          [Op.gte]: moment()
            .tz('Asia/Shanghai')
            .subtract(options.lookback_days * 1.6, 'days')
            .toDate(),
        },
      },
      order: [['time', 'DESC']],
      limit: options.lookback_days,
      raw: true,
    });

    if (!bars || bars.length < options.min_bars) return null;

    const normalizedBars: EnrichedBar[] = [...bars].reverse().map((bar: any) => ({
      time: new Date(bar.time),
      close: Number(bar.close),
      volume: Number(bar.volume || 0),
      turnover:
        bar.turnover === null || bar.turnover === undefined ? undefined : Number(bar.turnover),
      turnover_rate:
        bar.turnover_rate === null || bar.turnover_rate === undefined
          ? undefined
          : Number(bar.turnover_rate),
      change_percent:
        bar.change_percent === null || bar.change_percent === undefined
          ? undefined
          : Number(bar.change_percent),
      is_suspended: Boolean((bar as any).is_suspended),
    }));

    const closes = normalizedBars.map(bar => bar.close).filter(value => value > 0);
    if (closes.length < options.min_bars) return null;

    const latest = normalizedBars[normalizedBars.length - 1];
    const prev = normalizedBars[normalizedBars.length - 2] || latest;
    const last5 = closes.slice(-5);
    const last10 = closes.slice(-10);
    const last20 = closes.slice(-20);
    const last60 = closes.slice(-60);
    const ma5 = average(last5);
    const ma10 = average(last10);
    const ma20 = average(last20);
    const ma60 = average(last60);
    const return5d = last5.length >= 2 ? pct(last5[last5.length - 1], last5[0]) : undefined;
    const return20d = last20.length >= 2 ? pct(last20[last20.length - 1], last20[0]) : undefined;
    const return60d = last60.length >= 2 ? pct(last60[last60.length - 1], last60[0]) : undefined;
    const drawdown = maxDrawdown(closes.slice(-60));
    const dailyReturns = closes.slice(1).map((close, index) => pct(close, closes[index]) || 0);
    const volatility20d = stddev(dailyReturns.slice(-20));
    const volume5 = average(normalizedBars.slice(-5).map(bar => bar.volume));
    const volume20 = average(normalizedBars.slice(-20).map(bar => bar.volume));
    const volumeRatio = volume5 && volume20 ? volume5 / volume20 : undefined;
    const avgTurnover = average(
      normalizedBars
        .slice(-20)
        .map(bar => bar.turnover)
        .filter((value): value is number => value !== undefined && Number.isFinite(value))
    );
    const avgTurnoverRate20d = average(
      normalizedBars
        .slice(-20)
        .map(bar => bar.turnover_rate)
        .filter((value): value is number => value !== undefined)
    );
    const price = latest.close;
    const changePercent = latest.change_percent ?? pct(latest.close, prev.close);

    const weights = getStyleWeights(options.style);
    const feedback = options.feedback || buildEmptyFeedback();
    const factors: FactorScore[] = [];
    const reasons: string[] = [];
    const warnings: string[] = [];
    const dataQuality = this.assessQuantDataQuality({
      stock,
      bars: normalizedBars,
      min_bars: options.min_bars,
      avg_turnover_yuan: avgTurnover,
      price,
    });

    const trendScore = this.scoreTrend({ price, ma5, ma20, ma60, return20d, return60d });
    factors.push({
      name: 'trend',
      label: '趋势动量',
      score: trendScore,
      weight: weights.trend,
      value: round(return20d),
      reason:
        trendScore >= 70
          ? `20日收益 ${round(return20d) ?? '--'}%，均线结构偏强`
          : `趋势尚未形成共振，20日收益 ${round(return20d) ?? '--'}%`,
    });

    const volumeScore = this.scoreVolume({ volumeRatio, avgTurnoverRate20d, changePercent });
    factors.push({
      name: 'volume',
      label: '量能活跃',
      score: volumeScore,
      weight: weights.volume,
      value: round(volumeRatio, 2),
      reason:
        volumeScore >= 70
          ? `近5日量能约为20日均量 ${round(volumeRatio, 2) ?? '--'} 倍，资金关注度提升`
          : `量能配合一般，近5/20日均量比 ${round(volumeRatio, 2) ?? '--'}`,
    });

    const qualityScore = this.scoreQuality(stock);
    factors.push({
      name: 'quality',
      label: '基本质量',
      score: qualityScore,
      weight: weights.quality,
      value: round(Number(stock.total_market_cap || 0) / 100000000, 0),
      reason:
        qualityScore >= 70
          ? `流动性/市值基础较好，行业：${stock.industry || '未分类'}`
          : `基础画像一般，需进一步核验财务和行业景气`,
    });

    const valuationScore = this.scoreValuation(stock);
    factors.push({
      name: 'valuation',
      label: '估值安全',
      score: valuationScore,
      weight: weights.valuation,
      value: stock.pe_dynamic ? round(Number(stock.pe_dynamic), 1) : undefined,
      reason:
        valuationScore >= 70
          ? `估值处于可接受区间，PE ${round(Number(stock.pe_dynamic), 1) ?? '--'} / PB ${
              round(Number(stock.pb), 1) ?? '--'
            }`
          : `估值或财务数据不充分，PE ${round(Number(stock.pe_dynamic), 1) ?? '--'} / PB ${
              round(Number(stock.pb), 1) ?? '--'
            }`,
    });

    const riskScore = this.scoreRisk({ drawdown, volatility20d, return5d });
    factors.push({
      name: 'risk',
      label: '风险约束',
      score: riskScore,
      weight: weights.risk,
      value: round(drawdown),
      reason:
        riskScore >= 70
          ? `近60日最大回撤约 ${round(drawdown) ?? '--'}%，波动可控`
          : `近60日最大回撤约 ${round(drawdown) ?? '--'}%，短线风险偏高`,
    });

    // Batch AD (2026-06-18): today_burst — 今日单日爆发评分.
    // 之前 trend/volume 看 5-60d 中期, +5~8% 单日不奖励. 现在显式给当日 change_pct
    // + volume_ratio 加权: 涨 3-8% + 量比 1.5-3 给最高分, > 9% 反而扣分 (追涨停风险).
    const burstScore = this.scoreTodayBurst({ changePercent, volumeRatio });
    factors.push({
      name: 'today_burst',
      label: '今日爆发',
      score: burstScore,
      weight: weights.today_burst ?? 0,
      value: round(changePercent, 2),
      reason:
        burstScore >= 70
          ? `今日 ${round(changePercent, 2) ?? '--'}% + 量比 ${round(volumeRatio, 2) ?? '--'}，明显爆发`
          : burstScore <= 35
          ? `今日 ${round(changePercent, 2) ?? '--'}%，量价节奏未跟上`
          : `今日 ${round(changePercent, 2) ?? '--'}%，温和`,
    });

    // Batch AD (2026-06-18): industry_regime — 所在行业近 5 日热度.
    // industryScoreMap 由 caller 一次性 query IndustryFlow + 算 mean(change_pct +
    // main_inflow_ratio×100) 后传入. 命中 hot 板块 (score > 5) → +20 ~ +40 分.
    const industry = String(stock.industry || '').trim();
    const industryScore = options.industryScoreMap?.get(industry);
    const industryRegimeScore = this.scoreIndustryRegime(industryScore);
    factors.push({
      name: 'industry_regime',
      label: '行业热度',
      score: industryRegimeScore,
      weight: weights.industry_regime ?? 0,
      value: industryScore !== undefined ? round(industryScore, 2) : undefined,
      reason:
        industryRegimeScore >= 70
          ? `所在行业 "${industry || '未分类'}" 近 5 日热度 ${round(industryScore, 2) ?? '--'}，板块向上`
          : industryRegimeScore <= 40
          ? `所在行业 "${industry || '未分类'}" 近 5 日偏弱`
          : `所在行业 "${industry || '未分类'}" 近 5 日中性`,
    });

    if (feedback.signal_count > 0 || Number(feedback.trade_outcome_count || 0) > 0) {
      const feedbackScore = this.scoreFeedback(feedback);
      factors.push({
        name: 'feedback',
        label: '后验反馈',
        score: feedbackScore,
        weight: 0.12,
        value:
          feedback.avg_trade_excess_return_pct ??
          feedback.avg_excess_return_pct ??
          feedback.avg_return_pct ??
          undefined,
        reason:
          (feedback.closed_trade_count || 0) > 0
            ? `模拟盘闭环 ${feedback.closed_trade_count} 笔，平均超额 ${
                round(feedback.avg_trade_excess_return_pct, 2) ?? '--'
              }%，超额胜率 ${round(feedback.trade_excess_win_rate, 1) ?? '--'}%`
            : feedback.completed_count > 0
            ? `历史推荐 ${feedback.completed_count} 个完成样本，平均收益 ${
                round(feedback.avg_return_pct, 2) ?? '--'
              }%，胜率 ${round(feedback.positive_rate, 1) ?? '--'}%`
            : `历史已有 ${
                feedback.signal_count || feedback.trade_outcome_count || 0
              } 次推荐/跟单记录，后验收益仍在跟踪`,
      });
    }

    factors.push({
      name: 'data_quality',
      label: '数据可信度',
      score: dataQuality.score,
      weight: 0.16,
      value: dataQuality.score,
      reason:
        dataQuality.bucket === 'high'
          ? `行情覆盖充分，最新交易日 ${
              dataQuality.metrics.latest_date || '--'
            }，数据可用于自动跟单`
          : `数据质量 ${dataQuality.score} 分：${
              dataQuality.issues.slice(0, 2).join('；') || '存在缺失项，需谨慎复核'
            }`,
    });

    const baseScore = clamp(
      factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0) /
        factors.reduce((sum, factor) => sum + factor.weight, 0)
    );
    const preQualityScore = clamp(baseScore + feedback.score_adjustment);
    const score = clamp(preQualityScore * dataQuality.confidence_multiplier);

    factors
      .filter(factor => factor.score >= 68)
      .slice(0, 3)
      .forEach(factor => reasons.push(factor.reason));
    if (dataQuality.bucket !== 'high') {
      warnings.push(
        `数据质量${dataQuality.score}分/${dataQuality.bucket}：${
          dataQuality.issues.slice(0, 2).join('；') || '建议先复核行情完整性'
        }`
      );
    }
    if (!dataQuality.auto_trade_allowed) {
      warnings.push('数据质量未达到自动跟单要求，仅允许观察或人工复核');
    }

    if (return5d !== undefined && return5d > 16)
      warnings.push(`近5日涨幅 ${round(return5d)}%，存在追高风险`);
    if (drawdown < -18) warnings.push(`近60日最大回撤 ${round(drawdown)}%，趋势波动较大`);
    if (volumeRatio !== undefined && volumeRatio > 3)
      warnings.push(`短期量能急剧放大，需警惕冲高回落`);
    if (!stock.pe_dynamic && !stock.pb)
      warnings.push('估值字段缺失，建议以 TradingAgents 深度研报复核');
    const primaryFeedbackReturn =
      feedback.avg_trade_excess_return_pct ??
      feedback.avg_trade_return_pct ??
      feedback.avg_excess_return_pct ??
      feedback.avg_return_pct;
    if (
      (Number(feedback.closed_trade_count || 0) > 0 || feedback.completed_count > 0) &&
      Number(primaryFeedbackReturn || 0) < -3
    ) {
      warnings.push(
        `历史/模拟盘后验收益 ${round(primaryFeedbackReturn, 2)}%，需降低仓位或等待确认`
      );
    }

    const risk_level: QuantRecommendationItem['risk_level'] =
      dataQuality.bucket === 'critical' || warnings.length >= 2 || riskScore < 45
        ? 'high'
        : dataQuality.bucket === 'low' || warnings.length === 1 || riskScore < 65
        ? 'medium'
        : 'low';
    const rawActionPlan = resolveAction({ score, risk_level, warnings, feedback });
    const actionPlan = !dataQuality.auto_trade_allowed
      ? {
          action: 'avoid' as const,
          action_label: '暂不参与' as const,
          suggested_position_pct: 0,
        }
      : {
          ...rawActionPlan,
          suggested_position_pct: Number(
            (rawActionPlan.suggested_position_pct * dataQuality.position_multiplier).toFixed(2)
          ),
        };
    const tierPlan = resolveRecommendationTier({
      score,
      risk_level,
      action: actionPlan.action,
      warnings,
      feedback,
      factors,
    });
    const stop_loss_pct = risk_level === 'low' ? 6 : risk_level === 'medium' ? 4.5 : 3;
    const take_profit_pct =
      actionPlan.action === 'buy' ? 14 : actionPlan.action === 'watch' ? 10 : 8;

    return {
      symbol: normalizeSymbol(stock.symbol),
      name: stock.name,
      market: stock.market,
      industry: stock.industry,
      source: options.source,
      score: Number(score.toFixed(2)),
      rating: scoreToRating(score),
      risk_level,
      confidence: clamp(
        (50 +
          factors.filter(f => f.value !== undefined && f.value !== null).length * 8 +
          feedback.confidence_boost) *
          dataQuality.confidence_multiplier
      ),
      current_price: Number(price.toFixed(4)),
      change_percent: round(changePercent, 2) ?? undefined,
      data_quality_score: dataQuality.score,
      data_quality_bucket: dataQuality.bucket,
      data_quality: dataQuality,
      factors: factors.map(factor => ({ ...factor, score: Number(factor.score.toFixed(2)) })),
      reasons: reasons.length > 0 ? reasons : ['多因子评分居前，建议进入 TradingAgents 深度复核'],
      warnings,
      action: actionPlan.action,
      action_label: actionPlan.action_label,
      suggested_position_pct: actionPlan.suggested_position_pct,
      stop_loss_pct,
      take_profit_pct,
      metrics: {
        ma5: round(ma5, 2),
        ma20: round(ma20, 2),
        ma60: round(ma60, 2),
        return_5d: round(return5d, 2),
        return_20d: round(return20d, 2),
        return_60d: round(return60d, 2),
        volume_ratio: round(volumeRatio, 2),
        avg_turnover_yuan_20d: round(avgTurnover, 2),
        avg_turnover_rate_20d: round(avgTurnoverRate20d, 2),
        volatility_20d: round(volatility20d, 2),
        max_drawdown_60d: round(drawdown, 2),
        pe_dynamic: round(Number(stock.pe_dynamic), 2),
        pb: round(Number(stock.pb), 2),
        total_market_cap_yi: round(Number(stock.total_market_cap || 0) / 100000000, 2),
        base_score: round(baseScore, 2),
        pre_quality_score: round(preQualityScore, 2),
        feedback_score_adjustment: round(feedback.score_adjustment, 2),
        data_quality_score: dataQuality.score,
        data_quality_multiplier: dataQuality.confidence_multiplier,
        data_quality_position_multiplier: dataQuality.position_multiplier,
      },
      feedback,
      ...tierPlan,
      pre_quality_score: round(preQualityScore, 2) ?? undefined,
      trend: options.include_trend
        ? normalizedBars.slice(-30).map(bar => ({
            time: bar.time.toISOString().split('T')[0],
            close: Number(bar.close.toFixed(4)),
          }))
        : undefined,
    };
  }

  private async getRecommendationFeedbackMap(
    symbols: string[]
  ): Promise<Map<string, RecommendationFeedback>> {
    const normalizedSymbols = [
      ...new Set(symbols.map(symbol => normalizeSymbol(symbol)).filter(Boolean)),
    ];
    const feedbackMap = new Map<string, RecommendationFeedback>();
    if (normalizedSymbols.length === 0) return feedbackMap;

    const [signals, outcomes] = await Promise.all([
      AIInvestmentSignal.findAll({
        where: {
          source_type: AISignalSourceType.QUANT_RECOMMENDATION,
          symbol: { [Op.in]: normalizedSymbols },
        },
        attributes: ['symbol', 'signal_date', 'forward_returns', 'verification_status'],
        order: [['signal_date', 'DESC']],
        raw: true,
      }) as any,
      RecommendationTradeOutcome.findAll({
        where: {
          symbol: { [Op.in]: normalizedSymbols },
        },
        attributes: [
          'symbol',
          'trade_status',
          'entry_date',
          'realized_pnl_pct',
          'total_pnl_pct',
          'excess_return_pct',
        ],
        order: [['updated_at', 'DESC']],
        raw: true,
      }) as any,
    ]);

    const grouped = new Map<string, any[]>();
    for (const signal of signals as any[]) {
      const symbol = normalizeSymbol(signal.symbol);
      if (!grouped.has(symbol)) grouped.set(symbol, []);
      grouped.get(symbol)!.push(signal);
    }

    const outcomeGrouped = new Map<string, any[]>();
    for (const outcome of outcomes as any[]) {
      const symbol = normalizeSymbol(outcome.symbol);
      if (!outcomeGrouped.has(symbol)) outcomeGrouped.set(symbol, []);
      outcomeGrouped.get(symbol)!.push(outcome);
    }

    const allSymbols = new Set([...grouped.keys(), ...outcomeGrouped.keys()]);
    for (const symbol of allSymbols) {
      const records = grouped.get(symbol) || [];
      const tradeOutcomes = outcomeGrouped.get(symbol) || [];
      const returns: number[] = [];
      const excessReturns: number[] = [];
      const tradeReturns: number[] = [];
      const tradeExcessReturns: number[] = [];
      let completed_count = 0;
      let positive_count = 0;
      let excess_positive_count = 0;
      const horizonBuckets: Record<string, number[]> = {};

      for (const record of records) {
        const horizons = record.forward_returns?.horizons || {};
        for (const [horizon, value] of Object.entries<any>(horizons)) {
          if (value?.status !== 'completed') continue;
          const returnPct = Number(value.return_pct || 0);
          if (!Number.isFinite(returnPct)) continue;
          const excessReturnPct = Number(value.excess_return_pct);
          const feedbackReturn = Number.isFinite(excessReturnPct) ? excessReturnPct : returnPct;
          returns.push(returnPct);
          if (Number.isFinite(excessReturnPct)) excessReturns.push(excessReturnPct);
          completed_count++;
          if (returnPct > 0) positive_count++;
          if (feedbackReturn > 0) excess_positive_count++;
          if (!horizonBuckets[horizon]) horizonBuckets[horizon] = [];
          horizonBuckets[horizon].push(feedbackReturn);
        }
      }

      let closed_trade_count = 0;
      let trade_positive_count = 0;
      let trade_excess_positive_count = 0;
      for (const outcome of tradeOutcomes) {
        if (outcome.trade_status !== 'closed') continue;
        const tradeReturn = Number(outcome.realized_pnl_pct ?? outcome.total_pnl_pct);
        if (!Number.isFinite(tradeReturn)) continue;
        const tradeExcess = Number(outcome.excess_return_pct);
        closed_trade_count++;
        tradeReturns.push(tradeReturn);
        if (tradeReturn > 0) trade_positive_count++;
        if (Number.isFinite(tradeExcess)) {
          tradeExcessReturns.push(tradeExcess);
          if (tradeExcess > 0) trade_excess_positive_count++;
        } else if (tradeReturn > 0) {
          trade_excess_positive_count++;
        }
      }

      const avg_return_pct =
        returns.length > 0
          ? Number((returns.reduce((s, v) => s + v, 0) / returns.length).toFixed(4))
          : null;
      const avg_excess_return_pct =
        excessReturns.length > 0
          ? Number((excessReturns.reduce((s, v) => s + v, 0) / excessReturns.length).toFixed(4))
          : null;
      const positive_rate =
        completed_count > 0 ? Number(((positive_count / completed_count) * 100).toFixed(2)) : null;
      const excess_positive_rate =
        completed_count > 0
          ? Number(((excess_positive_count / completed_count) * 100).toFixed(2))
          : null;
      const avg_trade_return_pct =
        tradeReturns.length > 0
          ? Number((tradeReturns.reduce((s, v) => s + v, 0) / tradeReturns.length).toFixed(4))
          : null;
      const avg_trade_excess_return_pct =
        tradeExcessReturns.length > 0
          ? Number(
              (tradeExcessReturns.reduce((s, v) => s + v, 0) / tradeExcessReturns.length).toFixed(4)
            )
          : null;
      const trade_win_rate =
        closed_trade_count > 0
          ? Number(((trade_positive_count / closed_trade_count) * 100).toFixed(2))
          : null;
      const trade_excess_win_rate =
        closed_trade_count > 0
          ? Number(((trade_excess_positive_count / closed_trade_count) * 100).toFixed(2))
          : null;
      const best_horizon = Object.entries(horizonBuckets)
        .map(([horizon, values]) => ({
          horizon,
          avg: values.reduce((sum, value) => sum + value, 0) / values.length,
        }))
        .sort((a, b) => b.avg - a.avg)[0]?.horizon;

      const primaryPositiveRate = trade_excess_win_rate ?? excess_positive_rate ?? positive_rate;
      const primaryAvgReturn =
        avg_trade_excess_return_pct ??
        avg_trade_return_pct ??
        avg_excess_return_pct ??
        avg_return_pct;
      const positiveBonus =
        primaryPositiveRate === null || primaryPositiveRate === undefined
          ? 0
          : (primaryPositiveRate - 50) * 0.08;
      const returnBonus =
        primaryAvgReturn === null || primaryAvgReturn === undefined
          ? 0
          : Math.max(-12, Math.min(12, primaryAvgReturn)) * 0.75;
      const effectiveCompleted = closed_trade_count || completed_count;
      const samplePenalty = effectiveCompleted > 0 && effectiveCompleted < 3 ? -1.5 : 0;
      const score_adjustment = Math.max(
        -8,
        Math.min(8, returnBonus + positiveBonus + samplePenalty)
      );
      const confidence_boost = Math.min(8, Math.max(0, Math.log10(records.length + 1) * 5));

      feedbackMap.set(symbol, {
        signal_count: records.length,
        completed_count,
        trade_outcome_count: tradeOutcomes.length,
        closed_trade_count,
        avg_return_pct,
        avg_excess_return_pct,
        avg_trade_return_pct,
        avg_trade_excess_return_pct,
        positive_rate,
        excess_positive_rate,
        trade_win_rate,
        trade_excess_win_rate,
        best_horizon,
        score_adjustment: Number(score_adjustment.toFixed(2)),
        confidence_boost: Number(confidence_boost.toFixed(2)),
        latest_signal_date: records[0]?.signal_date,
      });
    }

    return feedbackMap;
  }

  private scoreFeedback(feedback: RecommendationFeedback): number {
    if (
      !feedback ||
      (feedback.signal_count === 0 && Number(feedback.trade_outcome_count || 0) === 0)
    )
      return 55;
    let score = 55;
    const primaryReturn =
      feedback.avg_trade_excess_return_pct ??
      feedback.avg_trade_return_pct ??
      feedback.avg_excess_return_pct ??
      feedback.avg_return_pct;
    const primaryPositiveRate =
      feedback.trade_excess_win_rate ??
      feedback.trade_win_rate ??
      feedback.excess_positive_rate ??
      feedback.positive_rate;
    if (primaryReturn !== null && primaryReturn !== undefined) {
      score += Math.max(-15, Math.min(18, primaryReturn)) * 1.1;
    }
    if (primaryPositiveRate !== null && primaryPositiveRate !== undefined) {
      score += (primaryPositiveRate - 50) * 0.32;
    }
    const effectiveCompleted = Number(feedback.closed_trade_count || 0) || feedback.completed_count;
    if (effectiveCompleted >= 5) score += 6;
    else if (effectiveCompleted > 0 && effectiveCompleted < 3) score -= 4;
    return clamp(score);
  }

  private assessQuantDataQuality(params: {
    stock: Stock;
    bars: EnrichedBar[];
    min_bars: number;
    avg_turnover_yuan?: number;
    price: number;
  }): QuantDataQualityAssessment {
    const { stock, bars, min_bars, price } = params;
    const issues: string[] = [];
    const warnings: string[] = [];
    let score = 100;

    const latest = bars[bars.length - 1];
    const latestMoment = latest?.time ? moment(latest.time).tz('Asia/Shanghai') : null;
    const latestDate = latestMoment?.isValid() ? latestMoment.format('YYYY-MM-DD') : undefined;
    const daysSinceLatest = latestMoment?.isValid()
      ? moment().tz('Asia/Shanghai').startOf('day').diff(latestMoment.startOf('day'), 'days')
      : undefined;
    const validCloseCount = bars.filter(bar => Number.isFinite(bar.close) && bar.close > 0).length;
    const zeroVolumeCount = bars.filter(
      bar => !Number.isFinite(bar.volume) || bar.volume <= 0
    ).length;
    const turnoverCount = bars.filter(
      bar => bar.turnover !== undefined && Number.isFinite(bar.turnover) && bar.turnover > 0
    ).length;
    const turnoverCoveragePct =
      bars.length > 0 ? Number(((turnoverCount / bars.length) * 100).toFixed(2)) : 0;
    const marketCapYi =
      Number(stock.total_market_cap || stock.circulating_market_cap || 0) > 0
        ? Number(stock.total_market_cap || stock.circulating_market_cap || 0) / 100000000
        : null;
    const valuationFieldCount = [stock.pe_dynamic, stock.pb].filter(value =>
      Number.isFinite(Number(value))
    ).length;

    if (!stock.is_listed || /(^|\*)ST|退/i.test(stock.name || '')) {
      score -= 45;
      issues.push('上市状态/ST/退市风险不满足自动交易要求');
    }
    if (stock.data_status && ['no_data', 'conflict'].includes(stock.data_status)) {
      score -= 35;
      issues.push(`股票数据状态为 ${stock.data_status}`);
    } else if (stock.data_status === 'incomplete') {
      score -= 16;
      warnings.push('股票数据状态 incomplete，需关注同步完整性');
    }
    if (bars.length < min_bars) {
      score -= 35;
      issues.push(`K线数量 ${bars.length} 条，低于最小要求 ${min_bars} 条`);
    } else if (bars.length < min_bars * 1.25) {
      score -= 8;
      warnings.push(`K线覆盖刚达标：${bars.length}/${min_bars}`);
    }
    if (!latestDate) {
      score -= 35;
      issues.push('缺少最新K线日期');
    } else if (daysSinceLatest !== undefined && daysSinceLatest > 14) {
      score -= 30;
      issues.push(`最新K线距今 ${daysSinceLatest} 天，行情明显过期`);
    } else if (daysSinceLatest !== undefined && daysSinceLatest > 5) {
      score -= 14;
      warnings.push(`最新K线距今 ${daysSinceLatest} 天，可能不是最新交易日`);
    }
    if (!Number.isFinite(price) || price <= 0 || validCloseCount < min_bars) {
      score -= 38;
      issues.push('有效收盘价不足，无法可靠计算收益和均线');
    }
    if (zeroVolumeCount > 0) {
      const penalty = Math.min(22, zeroVolumeCount * 3);
      score -= penalty;
      warnings.push(`${zeroVolumeCount} 条K线成交量为空/为0`);
    }
    if (turnoverCoveragePct < 30) {
      score -= 18;
      issues.push(`成交额覆盖率仅 ${turnoverCoveragePct}%`);
    } else if (turnoverCoveragePct < 70) {
      score -= 8;
      warnings.push(`成交额覆盖率 ${turnoverCoveragePct}%，流动性判断置信度下降`);
    }
    if (Number(params.avg_turnover_yuan || 0) > 0 && Number(params.avg_turnover_yuan) < 20000000) {
      score -= 10;
      warnings.push(`20日均成交额约 ${Math.round(Number(params.avg_turnover_yuan) / 10000)} 万`);
    }
    if (marketCapYi !== null && marketCapYi < 20) {
      score -= 10;
      warnings.push(`市值约 ${round(marketCapYi, 1)} 亿，流动性和冲击成本需谨慎`);
    }
    if (valuationFieldCount === 0) {
      score -= 8;
      warnings.push('PE/PB 估值字段缺失');
    }
    if (latest?.is_suspended) {
      score -= 40;
      issues.push('最新交易日标记停牌');
    }

    const normalizedScore = Math.round(clamp(score));
    const bucket: QuantDataQualityBucket =
      normalizedScore >= 82
        ? 'high'
        : normalizedScore >= 68
        ? 'medium'
        : normalizedScore >= 45
        ? 'low'
        : 'critical';
    const confidenceMultiplier =
      bucket === 'high' ? 1 : bucket === 'medium' ? 0.94 : bucket === 'low' ? 0.78 : 0.55;
    const positionMultiplier =
      bucket === 'high' ? 1 : bucket === 'medium' ? 0.75 : bucket === 'low' ? 0.35 : 0;
    const autoTradeAllowed = bucket !== 'critical' && bucket !== 'low';

    return {
      score: normalizedScore,
      bucket,
      confidence_multiplier: confidenceMultiplier,
      position_multiplier: positionMultiplier,
      auto_trade_allowed: autoTradeAllowed,
      recommendation:
        bucket === 'high'
          ? 'allow_auto_trade'
          : bucket === 'medium'
          ? 'allow_reduced_position'
          : bucket === 'low'
          ? 'manual_review_required'
          : 'block_auto_trade',
      issues,
      warnings,
      coverage: {
        bars: bars.length >= min_bars ? 'ok' : bars.length > 0 ? 'partial' : 'missing',
        freshness:
          daysSinceLatest === undefined || daysSinceLatest > 14
            ? 'missing'
            : daysSinceLatest > 5
            ? 'partial'
            : 'ok',
        price: Number.isFinite(price) && price > 0 ? 'ok' : 'missing',
        turnover:
          turnoverCoveragePct >= 70 ? 'ok' : turnoverCoveragePct >= 30 ? 'partial' : 'missing',
        valuation:
          valuationFieldCount >= 2 ? 'ok' : valuationFieldCount === 1 ? 'partial' : 'missing',
        listing_status:
          !stock.is_listed || /(^|\*)ST|退/i.test(stock.name || '') ? 'blocked' : 'ok',
      },
      metrics: {
        bar_count: bars.length,
        expected_min_bars: min_bars,
        latest_date: latestDate,
        days_since_latest: daysSinceLatest,
        valid_close_count: validCloseCount,
        zero_volume_count: zeroVolumeCount,
        turnover_coverage_pct: turnoverCoveragePct,
        avg_turnover_yuan: round(params.avg_turnover_yuan, 2) ?? undefined,
        market_cap_yi: round(marketCapYi, 2),
        valuation_field_count: valuationFieldCount,
      },
    };
  }

  private scoreTrend(params: {
    price: number;
    ma5?: number;
    ma20?: number;
    ma60?: number;
    return20d?: number;
    return60d?: number;
  }): number {
    let score = 50;
    if (params.return20d !== undefined) score += clamp(params.return20d, -20, 30) * 1.1;
    if (params.return60d !== undefined) score += clamp(params.return60d, -30, 45) * 0.35;
    if (params.ma5 && params.ma20 && params.ma5 > params.ma20) score += 10;
    if (params.ma20 && params.ma60 && params.ma20 > params.ma60) score += 10;
    if (params.ma20 && params.price > params.ma20) score += 8;
    if (params.return20d !== undefined && params.return20d > 35) score -= 8;
    return clamp(score);
  }

  private scoreVolume(params: {
    volumeRatio?: number;
    avgTurnoverRate20d?: number;
    changePercent?: number;
  }): number {
    let score = 50;
    if (params.volumeRatio !== undefined) {
      if (params.volumeRatio >= 0.8 && params.volumeRatio <= 2.2) score += 22;
      else if (params.volumeRatio > 2.2 && params.volumeRatio <= 3.5) score += 12;
      else if (params.volumeRatio < 0.55) score -= 12;
    }
    if (params.avgTurnoverRate20d !== undefined) {
      if (params.avgTurnoverRate20d >= 1 && params.avgTurnoverRate20d <= 8) score += 14;
      else if (params.avgTurnoverRate20d > 12) score -= 6;
    }
    if (params.changePercent !== undefined && params.changePercent > 0) score += 5;
    return clamp(score);
  }

  private scoreQuality(stock: Stock): number {
    let score = 52;
    const marketCapYi =
      Number(stock.total_market_cap || stock.circulating_market_cap || 0) / 100000000;
    if (marketCapYi >= 800) score += 20;
    else if (marketCapYi >= 200) score += 14;
    else if (marketCapYi >= 80) score += 8;
    else if (marketCapYi > 0 && marketCapYi < 30) score -= 8;

    if (stock.industry) score += 6;
    if (stock.data_status === 'complete') score += 8;
    if (stock.data_status === 'no_data' || stock.data_status === 'conflict') score -= 15;
    return clamp(score);
  }

  private scoreValuation(stock: Stock): number {
    let score = 56;
    const pe = Number(stock.pe_dynamic);
    const pb = Number(stock.pb);
    if (Number.isFinite(pe) && pe > 0) {
      if (pe <= 12) score += 18;
      else if (pe <= 25) score += 12;
      else if (pe <= 45) score += 2;
      else score -= 12;
    }
    if (Number.isFinite(pb) && pb > 0) {
      if (pb <= 1.5) score += 12;
      else if (pb <= 3.5) score += 6;
      else if (pb > 8) score -= 8;
    }
    if ((!Number.isFinite(pe) || pe <= 0) && (!Number.isFinite(pb) || pb <= 0)) score -= 8;
    return clamp(score);
  }

  private scoreRisk(params: {
    drawdown: number;
    volatility20d?: number;
    return5d?: number;
  }): number {
    let score = 78;
    if (params.drawdown < -30) score -= 30;
    else if (params.drawdown < -20) score -= 20;
    else if (params.drawdown < -12) score -= 10;
    if (params.volatility20d !== undefined) {
      if (params.volatility20d > 5) score -= 18;
      else if (params.volatility20d > 3.5) score -= 10;
      else if (params.volatility20d < 1.8) score += 6;
    }
    if (params.return5d !== undefined && params.return5d > 18) score -= 14;
    if (params.return5d !== undefined && params.return5d < -10) score -= 8;
    return clamp(score);
  }

  /**
   * Batch AD (2026-06-18): 今日单日爆发评分.
   * 主张: 涨幅 3-8% + 量比 1.5-3 = "健康爆发" 给最高分;
   *      涨幅 > 9% 接近涨停 = 追涨风险, 反扣;
   *      涨幅 < 0 = 当日弱势, 给低分.
   *
   * 关键 calibration:
   *   change=0, vol=1 → 50 中性
   *   change=5%, vol=2 → ~85 (用户图里这种)
   *   change=8%, vol=2.5 → ~92 (兆易创新的状态)
   *   change=10%, vol=4 → ~70 (涨停/接近涨停, 追涨风险, 反扣)
   *   change=-5% → ~30
   */
  private scoreTodayBurst(params: {
    changePercent?: number;
    volumeRatio?: number;
  }): number {
    let score = 50;
    const ch = params.changePercent;
    const vr = params.volumeRatio;
    if (typeof ch === 'number' && Number.isFinite(ch)) {
      if (ch >= 3 && ch <= 8) score += 25 + Math.min(15, (ch - 3) * 2); // 25~35 加分
      else if (ch > 8 && ch < 9.5) score += 20; // 已经偏高
      else if (ch >= 9.5) score -= 12; // 接近 / 已涨停, 追涨风险
      else if (ch >= 1) score += 12;
      else if (ch >= 0) score += 5;
      else if (ch >= -3) score -= 8;
      else if (ch >= -6) score -= 18;
      else score -= 28;
    }
    if (typeof vr === 'number' && Number.isFinite(vr)) {
      if (vr >= 1.5 && vr <= 3) score += 12; // 健康放量
      else if (vr > 3 && vr <= 5) score += 6; // 异常放量
      else if (vr > 5) score -= 8; // 过度放量, 接近天量
      else if (vr >= 0.9) score += 2;
      else score -= 4;
    }
    return clamp(score);
  }

  /**
   * Batch AD (2026-06-18): 所在行业近 5 日热度评分.
   * industryScore 来自 IndustryFlow mean(change_pct) + mean(main_inflow_ratio×100).
   * 命中 hot 板块 (score > 5) → 高分; cold 板块 (score < -3) → 低分.
   */
  private scoreIndustryRegime(industryScore?: number): number {
    if (industryScore === undefined || !Number.isFinite(industryScore)) {
      return 50; // 未知行业 / 数据缺失 → 中性
    }
    let score = 55;
    if (industryScore >= 8) score = 92;
    else if (industryScore >= 5) score = 82;
    else if (industryScore >= 3) score = 72;
    else if (industryScore >= 1) score = 62;
    else if (industryScore >= 0) score = 55;
    else if (industryScore >= -2) score = 42;
    else if (industryScore >= -5) score = 30;
    else score = 20;
    return clamp(score);
  }
}

export const quantRecommendationService = new QuantRecommendationService();
