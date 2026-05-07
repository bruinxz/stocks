import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { Stock } from '../models/Stock';
import { DailyBar } from '../models/DailyBar';
import { FavoriteStock } from '../models/FavoriteStock';
import { normalizeSymbol } from '../utils/stockSymbol';
import { logger } from '../utils/logger';

export type RecommendationUniverse = 'favorites' | 'market';
export type RecommendationStyle = 'balanced' | 'momentum' | 'value' | 'low_risk';
export type RecommendationSource = 'favorites' | 'market' | 'mixed';

export interface QuantRecommendationOptions {
  user_id?: number;
  universe?: RecommendationUniverse;
  style?: RecommendationStyle;
  limit?: number;
  lookback_days?: number;
  min_bars?: number;
  include_trend?: boolean;
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
  metrics: Record<string, number | null>;
  trend?: Array<{ time: string; close: number }>;
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

function scoreToRating(score: number): QuantRecommendationItem['rating'] {
  if (score >= 82) return '强烈关注';
  if (score >= 70) return '积极关注';
  if (score >= 58) return '观察';
  return '谨慎';
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

    const stocks = await this.getCandidateStocks({ ...options, universe, limit: Math.max(limit * 6, 60) });
    const recommendations: QuantRecommendationItem[] = [];

    for (const stock of stocks) {
      try {
        const item = await this.scoreStock(stock, {
          source: universe === 'favorites' ? 'favorites' : 'market',
          style,
          lookback_days,
          min_bars,
          include_trend: options.include_trend !== false,
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

    return Stock.findAll({
      where: {
        is_listed: true,
        [Op.or]: [{ type: 'stock' }, { type: null }],
        symbol: { [Op.notIn]: ['sh.000001', 'sh.000300', 'sz.399001', 'sz.399006'] },
      },
      order: [
        ['data_status', 'ASC'],
        ['total_market_cap', 'DESC NULLS LAST'],
        ['updated_at', 'DESC'],
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
    }
  ): Promise<QuantRecommendationItem | null> {
    const bars = await DailyBar.findAll({
      where: {
        stock_id: stock.id,
        time: {
          [Op.gte]: moment().tz('Asia/Shanghai').subtract(options.lookback_days * 1.6, 'days').toDate(),
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
      turnover: bar.turnover === null || bar.turnover === undefined ? undefined : Number(bar.turnover),
      turnover_rate:
        bar.turnover_rate === null || bar.turnover_rate === undefined ? undefined : Number(bar.turnover_rate),
      change_percent:
        bar.change_percent === null || bar.change_percent === undefined ? undefined : Number(bar.change_percent),
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
          ? `估值处于可接受区间，PE ${round(Number(stock.pe_dynamic), 1) ?? '--'} / PB ${round(Number(stock.pb), 1) ?? '--'}`
          : `估值或财务数据不充分，PE ${round(Number(stock.pe_dynamic), 1) ?? '--'} / PB ${round(Number(stock.pb), 1) ?? '--'}`,
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

    const score = clamp(
      factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0) /
        factors.reduce((sum, factor) => sum + factor.weight, 0)
    );

    factors
      .filter(factor => factor.score >= 68)
      .slice(0, 3)
      .forEach(factor => reasons.push(factor.reason));

    if (return5d !== undefined && return5d > 16) warnings.push(`近5日涨幅 ${round(return5d)}%，存在追高风险`);
    if (drawdown < -18) warnings.push(`近60日最大回撤 ${round(drawdown)}%，趋势波动较大`);
    if (volumeRatio !== undefined && volumeRatio > 3) warnings.push(`短期量能急剧放大，需警惕冲高回落`);
    if (!stock.pe_dynamic && !stock.pb) warnings.push('估值字段缺失，建议以 TradingAgents 深度研报复核');

    const risk_level: QuantRecommendationItem['risk_level'] =
      warnings.length >= 2 || riskScore < 45 ? 'high' : warnings.length === 1 || riskScore < 65 ? 'medium' : 'low';

    return {
      symbol: normalizeSymbol(stock.symbol),
      name: stock.name,
      market: stock.market,
      industry: stock.industry,
      source: options.source,
      score: Number(score.toFixed(2)),
      rating: scoreToRating(score),
      risk_level,
      confidence: clamp(50 + factors.filter(f => f.value !== undefined && f.value !== null).length * 8),
      current_price: Number(price.toFixed(4)),
      change_percent: round(changePercent, 2) ?? undefined,
      factors: factors.map(factor => ({ ...factor, score: Number(factor.score.toFixed(2)) })),
      reasons: reasons.length > 0 ? reasons : ['多因子评分居前，建议进入 TradingAgents 深度复核'],
      warnings,
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
      },
      trend: options.include_trend
        ? normalizedBars.slice(-30).map(bar => ({
            time: bar.time.toISOString().split('T')[0],
            close: Number(bar.close.toFixed(4)),
          }))
        : undefined,
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
    const marketCapYi = Number(stock.total_market_cap || stock.circulating_market_cap || 0) / 100000000;
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

  private scoreRisk(params: { drawdown: number; volatility20d?: number; return5d?: number }): number {
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
