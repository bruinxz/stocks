import { Op } from 'sequelize';
import {
  AIInvestmentSignal,
  AISignalDecision,
  AISignalSourceType,
} from '../models/AIInvestmentSignal';
import { DailyScreener } from '../models/DailyScreener';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { normalizeSymbol } from '../utils/stockSymbol';
import { logger } from '../utils/logger';
import type { QuantRecommendationItem } from './QuantRecommendationService';

const DEFAULT_HORIZONS = [1, 3, 5, 10, 20];

export interface SignalQueryOptions {
  symbol?: string;
  decision?: string;
  source_type?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  offset?: number;
}

export interface QuantRecommendationArchiveOptions {
  candidates: QuantRecommendationItem[];
  universe?: string;
  style?: string;
  as_of?: string;
  signal_date?: string;
}

function toNumber(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function getChinaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function resolveSignalDate(
  options: Pick<QuantRecommendationArchiveOptions, 'as_of' | 'signal_date'> = {}
): string {
  if (options.signal_date) return String(options.signal_date).slice(0, 10);
  if (options.as_of) {
    const datePart = String(options.as_of).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  }
  return getChinaToday();
}

function buildSignalWhere(options: SignalQueryOptions = {}) {
  const where: any = {};
  if (options.symbol) where.symbol = normalizeSymbol(options.symbol);
  if (options.decision) where.normalized_decision = options.decision;
  if (options.source_type) where.source_type = options.source_type;
  if (options.start_date || options.end_date) {
    where.signal_date = {};
    if (options.start_date) where.signal_date[Op.gte] = options.start_date;
    if (options.end_date) where.signal_date[Op.lte] = options.end_date;
  }
  return where;
}

export class AIInvestmentSignalService {
  normalizeDecision(decision: string): string {
    const text = String(decision || '').toUpperCase();
    if (text.includes('STRONG_BUY') || text.includes('强烈买入') || text.includes('强买')) {
      return AISignalDecision.STRONG_BUY;
    }
    if (text.includes('BUY') || text.includes('买入') || text.includes('看多')) {
      return AISignalDecision.BUY;
    }
    if (text.includes('STRONG_SELL') || text.includes('强烈卖出') || text.includes('强卖')) {
      return AISignalDecision.STRONG_SELL;
    }
    if (text.includes('SELL') || text.includes('卖出') || text.includes('看空')) {
      return AISignalDecision.SELL;
    }
    if (
      text.includes('HOLD') ||
      text.includes('观望') ||
      text.includes('中性') ||
      text.includes('持有')
    ) {
      return AISignalDecision.HOLD;
    }
    return AISignalDecision.UNKNOWN;
  }

  decisionFromQuantScore(score: number): string {
    if (score >= 82) return AISignalDecision.STRONG_BUY;
    if (score >= 70) return AISignalDecision.BUY;
    return AISignalDecision.HOLD;
  }

  inferRiskLevel(record: any): string {
    const score = toNumber(record.score ?? record.confidence_score);
    const decision = this.normalizeDecision(record.decision || '');
    if ([AISignalDecision.SELL, AISignalDecision.STRONG_SELL].includes(decision as any)) {
      return 'high';
    }
    if (score !== undefined && score >= 85) return 'medium';
    if (score !== undefined && score >= 70) return 'low';
    return 'medium';
  }

  async syncFromDailyScreeners(): Promise<{ created: number; updated: number; total: number }> {
    const screeners = await DailyScreener.findAll({ order: [['created_at', 'DESC']] });
    let created = 0;
    let updated = 0;

    for (const screener of screeners) {
      const source_id = String(screener.id);
      const payload = {
        source_type: AISignalSourceType.DAILY_SCREENER,
        source_id,
        symbol: normalizeSymbol(screener.symbol),
        name: screener.name,
        signal_date: screener.date,
        decision: screener.decision || 'UNKNOWN',
        normalized_decision: this.normalizeDecision(screener.decision),
        confidence_score: toNumber(screener.score),
        risk_level: this.inferRiskLevel(screener),
        rationale: screener.rationale,
        detail: screener.detail,
        current_price: toNumber(screener.current_price),
        price_change_pct: toNumber(screener.price_change_pct),
        metadata: {
          scores: screener.scores || {},
          daily_screener_id: screener.id,
          created_at: screener.created_at,
        },
      };

      const [record, isCreated] = await AIInvestmentSignal.findOrCreate({
        where: {
          source_type: AISignalSourceType.DAILY_SCREENER,
          source_id,
        },
        defaults: payload,
      });

      if (isCreated) {
        created++;
      } else {
        await record.update(payload);
        updated++;
      }
    }

    return { created, updated, total: screeners.length };
  }

  async archiveTradingAgentsResult(params: {
    task_id?: string;
    symbol: string;
    signal_date?: string;
    decision: string;
    rationale?: string;
    detail?: any;
    confidence_score?: number;
    current_price?: number;
    price_change_pct?: number;
    source_type?: string;
  }): Promise<AIInvestmentSignal> {
    const symbol = normalizeSymbol(params.symbol);
    const signal_date = params.signal_date || new Date().toISOString().split('T')[0];
    const source_type = params.source_type || AISignalSourceType.TRADING_AGENTS;
    const source_id = params.task_id || `${symbol}_${signal_date}_${Date.now()}`;
    const stock = await Stock.findOne({ where: { symbol } });
    const detailText =
      typeof params.detail === 'string'
        ? params.detail
        : params.detail
        ? JSON.stringify(params.detail)
        : undefined;

    const payload = {
      source_type,
      source_id,
      symbol,
      name: stock?.name,
      signal_date,
      decision: params.decision || 'UNKNOWN',
      normalized_decision: this.normalizeDecision(params.decision || ''),
      confidence_score: params.confidence_score,
      risk_level: this.inferRiskLevel(params),
      rationale: params.rationale,
      detail: detailText,
      current_price: params.current_price,
      price_change_pct: params.price_change_pct,
      metadata: {
        task_id: params.task_id,
      },
    };

    const [record, created] = await AIInvestmentSignal.findOrCreate({
      where: { source_type, source_id },
      defaults: payload,
    });

    if (!created) {
      await record.update(payload);
    }

    return record;
  }

  async archiveQuantRecommendations(options: QuantRecommendationArchiveOptions): Promise<{
    created: number;
    updated: number;
    total: number;
    signal_ids: number[];
  }> {
    const candidates = Array.isArray(options.candidates) ? options.candidates : [];
    const universe = options.universe || 'favorites';
    const style = options.style || 'balanced';
    let created = 0;
    let updated = 0;
    const signal_ids: number[] = [];

    for (const candidate of candidates) {
      if (!candidate?.symbol) continue;

      const symbol = normalizeSymbol(candidate.symbol);
      const latestTrendDate = candidate.trend?.[candidate.trend.length - 1]?.time;
      const signal_date = resolveSignalDate({
        signal_date: options.signal_date,
        as_of: latestTrendDate || options.as_of,
      });
      const decision = this.decisionFromQuantScore(Number(candidate.score || 0));
      const source_id = `${symbol}_${signal_date}_${style}_${universe}`;
      const stock = await Stock.findOne({ where: { symbol } });
      const payload = {
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
        source_id,
        symbol,
        name: candidate.name || stock?.name,
        signal_date,
        decision,
        normalized_decision: decision,
        confidence_score: toNumber(candidate.score),
        risk_level:
          candidate.risk_level || this.inferRiskLevel({ score: candidate.score, decision }),
        rationale:
          (candidate.reasons || []).join('；') ||
          `${candidate.rating || '量化候选'}：多因子综合评分居前`,
        detail: JSON.stringify({
          rating: candidate.rating,
          confidence: candidate.confidence,
          factors: candidate.factors || [],
          metrics: candidate.metrics || {},
          warnings: candidate.warnings || [],
          trend: candidate.trend || [],
        }),
        current_price: toNumber(candidate.current_price),
        price_change_pct: toNumber(candidate.change_percent),
        metadata: {
          quant_candidate: true,
          universe,
          style,
          as_of: options.as_of,
          source: candidate.source,
          rating: candidate.rating,
          confidence: candidate.confidence,
          factors: candidate.factors || [],
          metrics: candidate.metrics || {},
          reasons: candidate.reasons || [],
          warnings: candidate.warnings || [],
        },
      };

      const [record, isCreated] = await AIInvestmentSignal.findOrCreate({
        where: {
          source_type: AISignalSourceType.QUANT_RECOMMENDATION,
          source_id,
        },
        defaults: payload,
      });

      if (isCreated) {
        created++;
      } else {
        await record.update(payload);
        updated++;
      }
      signal_ids.push(record.id);
    }

    return { created, updated, total: candidates.length, signal_ids };
  }

  async verifySignalReturns(
    signal: AIInvestmentSignal,
    horizons = DEFAULT_HORIZONS
  ): Promise<AIInvestmentSignal> {
    const stock = await Stock.findOne({ where: { symbol: signal.symbol } });
    if (!stock) {
      await signal.update({ verification_status: 'no_data', verified_at: new Date() });
      return signal;
    }

    const bars = await DailyBar.findAll({
      where: {
        stock_id: stock.id,
        time: {
          [Op.gte]: new Date(`${signal.signal_date}T00:00:00.000Z`),
        },
      },
      order: [['time', 'ASC']],
      limit: Math.max(...horizons) + 5,
    });

    if (bars.length === 0) {
      await signal.update({ verification_status: 'no_data', verified_at: new Date() });
      return signal;
    }

    const baseBar =
      bars.find(bar => bar.time.toISOString().split('T')[0] >= signal.signal_date) || bars[0];
    const baseIndex = bars.findIndex(bar => bar.time.getTime() === baseBar.time.getTime());
    const entryPrice = Number(baseBar.close);
    const forward_returns: Record<string, any> = {
      entry_date: baseBar.time.toISOString().split('T')[0],
      entry_price: entryPrice,
      horizons: {},
    };

    let completed = 0;
    for (const horizon of horizons) {
      const target = bars[baseIndex + horizon];
      if (!target || !entryPrice) {
        forward_returns.horizons[`${horizon}d`] = {
          status: 'pending',
          horizon,
        };
        continue;
      }

      const exitPrice = Number(target.close);
      const returnPct = entryPrice ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
      forward_returns.horizons[`${horizon}d`] = {
        status: 'completed',
        horizon,
        exit_date: target.time.toISOString().split('T')[0],
        exit_price: Number(exitPrice.toFixed(4)),
        return_pct: Number(returnPct.toFixed(4)),
      };
      completed++;
    }

    await signal.update({
      forward_returns,
      verification_status:
        completed === 0 ? 'pending' : completed === horizons.length ? 'completed' : 'partial',
      verified_at: new Date(),
    });

    return signal.reload();
  }

  async verifySignals(
    options: { limit?: number; horizons?: number[] } & SignalQueryOptions = {}
  ): Promise<{
    total: number;
    verified: number;
    no_data: number;
  }> {
    const limit = options.limit || 200;
    const signals = await AIInvestmentSignal.findAll({
      where: buildSignalWhere(options),
      order: [['signal_date', 'DESC']],
      limit,
    });

    let verified = 0;
    let no_data = 0;

    for (const signal of signals) {
      try {
        const updated = await this.verifySignalReturns(
          signal,
          options.horizons || DEFAULT_HORIZONS
        );
        if (updated.verification_status === 'no_data') {
          no_data++;
        } else {
          verified++;
        }
      } catch (error: any) {
        logger.warn(
          `AI signal verification failed for ${signal.symbol}#${signal.id}: ${error.message}`
        );
      }
    }

    return { total: signals.length, verified, no_data };
  }

  async listSignals(options: SignalQueryOptions = {}) {
    const where = buildSignalWhere(options);

    const limit = Math.min(options.limit || 50, 200);
    const offset = options.offset || 0;

    const { rows, count } = await AIInvestmentSignal.findAndCountAll({
      where,
      order: [
        ['signal_date', 'DESC'],
        ['confidence_score', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit,
      offset,
    });

    return { rows, count, limit, offset };
  }

  async getSignalStats(options: SignalQueryOptions = {}) {
    const signals = await AIInvestmentSignal.findAll({
      where: buildSignalWhere(options),
      raw: true,
    });
    const byDecision: Record<string, any> = {};
    const horizonSummary: Record<
      string,
      { count: number; avg_return_pct: number; positive_count: number }
    > = {};

    for (const signal of signals as any[]) {
      const decision = signal.normalized_decision || 'unknown';
      if (!byDecision[decision]) {
        byDecision[decision] = { count: 0, avg_confidence_score: 0, confidence_total: 0 };
      }
      byDecision[decision].count++;
      if (signal.confidence_score !== null && signal.confidence_score !== undefined) {
        byDecision[decision].confidence_total += Number(signal.confidence_score);
      }

      const horizons = signal.forward_returns?.horizons || {};
      for (const [key, value] of Object.entries<any>(horizons)) {
        if (value.status !== 'completed') continue;
        if (!horizonSummary[key]) {
          horizonSummary[key] = { count: 0, avg_return_pct: 0, positive_count: 0 };
        }
        horizonSummary[key].count++;
        horizonSummary[key].avg_return_pct += Number(value.return_pct || 0);
        if (Number(value.return_pct || 0) > 0) {
          horizonSummary[key].positive_count++;
        }
      }
    }

    Object.values(byDecision).forEach((item: any) => {
      item.avg_confidence_score =
        item.count > 0 ? Number((item.confidence_total / item.count).toFixed(2)) : 0;
      delete item.confidence_total;
    });

    Object.values(horizonSummary).forEach(item => {
      item.avg_return_pct =
        item.count > 0 ? Number((item.avg_return_pct / item.count).toFixed(4)) : 0;
      (item as any).positive_rate =
        item.count > 0 ? Number(((item.positive_count / item.count) * 100).toFixed(2)) : 0;
    });

    return {
      total_signals: signals.length,
      by_decision: byDecision,
      horizon_summary: horizonSummary,
    };
  }
}

export const aiInvestmentSignalService = new AIInvestmentSignalService();
