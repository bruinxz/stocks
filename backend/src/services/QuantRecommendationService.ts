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
      tier_reason: `评分 ${round(params.score, 1)}，低风险、无硬警告，${factorPassCount} 个核心因子达标，可进入强推荐复核`,
    };
  }

  if (
    ['buy', 'watch'].includes(params.action) &&
    params.score >= 72 &&
    !hasCriticalWarning
  ) {
    return {
      recommendation_tier: 'trial_position',
      recommendation_tier_label: '轻仓试错池',
      tier_rank: 2,
      tier_reason: `评分 ${round(params.score, 1)}，具备交易候选价值，但仍需小仓试错或等待 Agent 复核`,
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
  switch (style) {
    case 'momentum':
      return { trend: 0.34, volume: 0.24, quality: 0.14, valuation: 0.1, risk: 0.18 };
    case 'value':
      return { trend: 0.2, volume: 0.14, quality: 0.24, valuation: 0.26, risk: 0.16 };
    case 'low_risk':
      return { trend: 0.2, volume: 0.12, quality: 0.22, valuation: 0.16, risk: 0.3 };
    case 'balanced':
    default:
      return { trend: 0.28, volume: 0.2, quality: 0.2, valuation: 0.14, risk: 0.18 };
  }
}

export class QuantRecommendationService {
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
        });
        if (item) recommendations.push(item);
      } catch (error: any) {
        logger.warn(`多因子推荐评分失败 ${stock.symbol}: ${error.message}`);
      }
    }

    recommendations.sort((a, b) => b.score - a.score);

    return {
      as_of: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      universe,
      style,
      total_candidates: stocks.length,
      analyzed_candidates: recommendations.length,
      recommendations: recommendations.slice(0, limit),
    };
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
              : `历史已有 ${feedback.signal_count || feedback.trade_outcome_count || 0} 次推荐/跟单记录，后验收益仍在跟踪`,
      });
    }

    const baseScore = clamp(
      factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0) /
        factors.reduce((sum, factor) => sum + factor.weight, 0)
    );
    const score = clamp(baseScore + feedback.score_adjustment);

    factors
      .filter(factor => factor.score >= 68)
      .slice(0, 3)
      .forEach(factor => reasons.push(factor.reason));

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
      warnings.length >= 2 || riskScore < 45
        ? 'high'
        : warnings.length === 1 || riskScore < 65
          ? 'medium'
          : 'low';
    const actionPlan = resolveAction({ score, risk_level, warnings, feedback });
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
        50 +
          factors.filter(f => f.value !== undefined && f.value !== null).length * 8 +
          feedback.confidence_boost
      ),
      current_price: Number(price.toFixed(4)),
      change_percent: round(changePercent, 2) ?? undefined,
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
        avg_turnover_rate_20d: round(avgTurnoverRate20d, 2),
        volatility_20d: round(volatility20d, 2),
        max_drawdown_60d: round(drawdown, 2),
        pe_dynamic: round(Number(stock.pe_dynamic), 2),
        pb: round(Number(stock.pb), 2),
        total_market_cap_yi: round(Number(stock.total_market_cap || 0) / 100000000, 2),
        base_score: round(baseScore, 2),
        feedback_score_adjustment: round(feedback.score_adjustment, 2),
      },
      feedback,
      ...tierPlan,
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
}

export const quantRecommendationService = new QuantRecommendationService();
