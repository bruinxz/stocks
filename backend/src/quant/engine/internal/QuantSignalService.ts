import { Op } from 'sequelize';
import { QuantSignal } from '../../../models/QuantSignal';
import { strategyRegistry } from '../../engine/StrategyRegistry';
import { quantDataService } from './QuantDataService';
import { QuantSignalResult, QuantUniverse } from '../../types/QuantTypes';
import { round } from '../../engine/QuantMath';
import { marketEnvironmentService } from '../../../services/MarketEnvironmentService';
import { Stock } from '../../../models/Stock';
import { logger } from '../../../utils/logger';
import { realtimeQuoteService } from '../../../data/services/RealtimeQuoteService';
import { quantStrategyService } from './QuantStrategyService';

function dateOnly(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStringArray(value: any): string[] {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

function daysBetween(from?: string | null, to?: string | null) {
  if (!from || !to) return null;
  const start = new Date(`${String(from).slice(0, 10)}T00:00:00.000Z`).getTime();
  const end = new Date(`${String(to).slice(0, 10)}T00:00:00.000Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

export class QuantSignalService {
  async generateSignals(options: {
    trade_date?: string;
    universe?: QuantUniverse;
    user_id?: number;
    symbols?: string[];
    strategy_keys?: string[];
    lookback_days?: number;
    candidate_limit?: number;
    min_score?: number;
    persist?: boolean;
    params_by_strategy?: Record<string, Record<string, any>>;
    param_version_by_strategy?: Record<string, any>;
    refresh_realtime_quotes?: boolean;
    quote_sync_limit?: number;
    realtime_quote_source?: string;
    include_realtime_quote?: boolean;
  }) {
    const trade_date = options.trade_date || dateOnly(new Date());
    let quoteSync: any = null;
    if (options.refresh_realtime_quotes) {
      try {
        const stocksForQuoteSync = await quantDataService.getStocks({
          universe: options.universe || 'market',
          user_id: options.user_id,
          symbols: options.symbols,
          limit: options.quote_sync_limit || options.candidate_limit || 180,
        });
        quoteSync = await realtimeQuoteService.syncQuotesForSymbols(
          stocksForQuoteSync.map(stock => stock.symbol),
          { source: options.realtime_quote_source || 'auto' }
        );
      } catch (error: any) {
        logger.warn(`量化信号实时行情刷新失败: ${error?.message || error}`);
        quoteSync = {
          requested_count: 0,
          persisted_count: 0,
          updated_stock_count: 0,
          error: error?.message || String(error),
        };
      }
    }
    const start = new Date(trade_date);
    start.setDate(start.getDate() - Number(options.lookback_days || 160));
    const contexts = await quantDataService.getContexts({
      universe: options.universe || 'market',
      user_id: options.user_id,
      symbols: options.symbols,
      start_date: dateOnly(start),
      end_date: trade_date,
      warmup_days: 80,
      limit: options.candidate_limit || 180,
      include_realtime_quote:
        options.include_realtime_quote !== undefined
          ? options.include_realtime_quote
          : trade_date >= dateOnly(new Date()),
    });
    const strategies = strategyRegistry.resolve(options.strategy_keys);
    const runtimePoliciesByStrategy = await quantStrategyService.getRuntimePoliciesByStrategy(
      strategies.map(strategy => strategy.definition.strategy_key)
    );
    const signals: QuantSignalResult[] = [];
    const policyDiagnostics: Record<string, any> = {};
    const needsEnvironmentPolicy = Object.values(runtimePoliciesByStrategy).some(policy => {
      const environmentPolicy = asPlainObject(policy.environment_policy);
      return (
        normalizeStringArray(environmentPolicy.blocked_market_regimes).length > 0 ||
        normalizeStringArray(environmentPolicy.preferred_market_regimes).length > 0
      );
    });
    const environmentBySymbol = new Map<string, any>();
    for (const context of contexts) {
      let contextMarketEnvironment: any = null;
      if (needsEnvironmentPolicy) {
        try {
          contextMarketEnvironment = await marketEnvironmentService.getEnvironmentForStock(
            context.symbol,
            {
              industry: context.industry || undefined,
              as_of: trade_date,
              use_cache: true,
            }
          );
          environmentBySymbol.set(context.symbol, contextMarketEnvironment);
        } catch (error: any) {
          logger.warn(`量化运行策略市场环境读取失败 ${context.symbol}: ${error?.message || error}`);
        }
      }
      for (const strategy of strategies) {
        const strategyKey = strategy.definition.strategy_key;
        const runtimePolicy = runtimePoliciesByStrategy[strategyKey] || {};
        const executionPolicy = asPlainObject(runtimePolicy.execution_policy);
        const environmentPolicy = asPlainObject(runtimePolicy.environment_policy);
        const blockedMarketRegimes = normalizeStringArray(environmentPolicy.blocked_market_regimes);
        const preferredMarketRegimes = normalizeStringArray(
          environmentPolicy.preferred_market_regimes
        );
        const minBars = Number(strategy.definition.default_params?.min_bars || 30);
        if ((context.bars || []).length < minBars) continue;
        const result = strategy.evaluate(context, {
          as_of: trade_date,
          params: options.params_by_strategy?.[strategyKey],
        });
        const originalScore = result.score;
        const originalConfidence = result.confidence;
        const policyMinScore = toNumber(executionPolicy.min_score, NaN);
        const effectiveMinScore = Math.max(
          Number(options.min_score || 0),
          Number.isFinite(policyMinScore) ? policyMinScore : 0
        );
        const contextMarketRegime = String(contextMarketEnvironment?.market_regime || '');
        const policyReasons: string[] = [];
        let adjustedScore = result.score;
        if (blockedMarketRegimes.length && blockedMarketRegimes.includes(contextMarketRegime)) {
          adjustedScore -= 4;
          policyReasons.push(
            `策略运行策略：当前市场环境 ${contextMarketRegime} 属于回避环境，降分观察`
          );
        } else if (
          preferredMarketRegimes.length &&
          contextMarketRegime &&
          preferredMarketRegimes.includes(contextMarketRegime)
        ) {
          adjustedScore += 1.5;
          policyReasons.push(
            `策略运行策略：当前市场环境 ${contextMarketRegime} 属于偏好环境，小幅加分`
          );
        }
        const factorDate = context.factor_snapshot?.factor_date || null;
        const factorLagDays = daysBetween(factorDate, trade_date);
        if (factorLagDays === null || factorLagDays > 10) {
          adjustedScore -= 2.5;
          result.risk_flags = [
            ...(result.risk_flags || []),
            factorLagDays === null
              ? '因子快照缺失，本次分数更依赖行情特征'
              : `因子快照滞后 ${factorLagDays} 天，已降低因子置信度`,
          ];
          policyReasons.push(
            factorLagDays === null
              ? '数据纪律：因子快照缺失，降分保守处理'
              : `数据纪律：因子快照滞后 ${factorLagDays} 天，降分保守处理`
          );
        }
        if (!policyDiagnostics[strategyKey]) {
          policyDiagnostics[strategyKey] = {
            strategy_key: strategyKey,
            min_score: effectiveMinScore,
            default_position_pct: executionPolicy.default_position_pct,
            max_position_pct: executionPolicy.max_position_pct,
            blocked_market_regimes: blockedMarketRegimes,
            preferred_market_regimes: preferredMarketRegimes,
            adjusted_signal_count: 0,
            rejected_by_min_score_count: 0,
          };
        }
        result.score = round(Math.max(0, Math.min(100, adjustedScore)), 4);
        result.confidence = round(
          Math.max(0, Math.min(100, originalConfidence + (result.score - originalScore) * 0.35)),
          4
        );
        result.factors = {
          ...(result.factors || {}),
          strategy_runtime_policy: {
            min_score: effectiveMinScore,
            default_position_pct: executionPolicy.default_position_pct,
            max_position_pct: executionPolicy.max_position_pct,
            candidate_limit: executionPolicy.candidate_limit,
            preferred_market_regimes: preferredMarketRegimes,
            blocked_market_regimes: blockedMarketRegimes,
            factor_date: factorDate,
            factor_lag_days: factorLagDays,
          },
          strategy_policy_adjustment_reasons: policyReasons,
        };
        if (policyReasons.length) {
          policyDiagnostics[strategyKey].adjusted_signal_count += 1;
          result.reasons = [...(result.reasons || []), ...policyReasons].slice(0, 8);
        }
        const meetsScoreGate = result.score >= effectiveMinScore;
        const isObservationSignal =
          result.signal === 'watch' && result.score >= Math.max(62, effectiveMinScore - 8);
        if (meetsScoreGate || isObservationSignal) {
          signals.push(result);
        } else {
          policyDiagnostics[strategyKey].rejected_by_min_score_count += 1;
        }
      }
    }
    signals.sort((a, b) => b.score - a.score);
    const limited = signals.slice(0, Math.min(Number(options.candidate_limit || 100), 1000));
    const contextBySymbol = new Map(contexts.map(context => [context.symbol, context]));

    if (options.persist !== false) {
      const stockRecords = await Stock.findAll({
        where: { symbol: { [Op.in]: limited.map(signal => signal.symbol) } },
      });
      const stockBySymbol = new Map(stockRecords.map(stock => [stock.symbol, stock]));
      for (const signal of limited) {
        const stock = stockBySymbol.get(signal.symbol);
        let marketEnvironment: any = null;
        try {
          marketEnvironment = await marketEnvironmentService.getEnvironmentForStock(signal.symbol, {
            stock,
            industry: stock?.industry,
            as_of: trade_date,
            use_cache: true,
          });
        } catch (error: any) {
          logger.warn(`量化信号市场环境归因失败 ${signal.symbol}: ${error?.message || error}`);
        }
        await QuantSignal.destroy({
          where: {
            trade_date,
            symbol: signal.symbol,
            strategy_key: signal.strategy_key,
          },
        });
        await QuantSignal.create({
          trade_date,
          symbol: signal.symbol,
          name: signal.name,
          strategy_key: signal.strategy_key,
          signal: signal.signal,
          score: round(signal.score, 4),
          confidence: round(signal.confidence, 4),
          entry_price: signal.entry_price,
          stop_loss_price: signal.stop_loss_price,
          take_profit_price: signal.take_profit_price,
          reason: (signal.reasons || []).slice(0, 4).join('；'),
          risk_flags: signal.risk_flags || [],
          raw_factors: {
            ...(signal.factors || {}),
            param_version_key:
              options.param_version_by_strategy?.[signal.strategy_key]?.version_key ||
              `qparam_${signal.strategy_key}_default`,
            param_version_type:
              options.param_version_by_strategy?.[signal.strategy_key]?.version_type || 'default',
            param_version_status:
              options.param_version_by_strategy?.[signal.strategy_key]?.status || 'baseline',
            param_version_ab_group:
              options.param_version_by_strategy?.[signal.strategy_key]?.metadata?.ab_group ||
              'default',
            param_version_source_experiment_key:
              options.param_version_by_strategy?.[signal.strategy_key]?.source_experiment_key ||
              null,
            strategy_params: options.params_by_strategy?.[signal.strategy_key] || {},
            strategy_runtime_policy:
              (signal.factors || {}).strategy_runtime_policy ||
              runtimePoliciesByStrategy[signal.strategy_key]?.execution_policy ||
              {},
            strategy_environment_policy:
              runtimePoliciesByStrategy[signal.strategy_key]?.environment_policy || {},
            price_source: contextBySymbol.get(signal.symbol)?.price_source || 'daily_bar',
            latest_quote_time: contextBySymbol.get(signal.symbol)?.latest_quote_time || null,
            market_environment: marketEnvironment || environmentBySymbol.get(signal.symbol) || null,
            industry: stock?.industry,
            market_regime: marketEnvironment?.market_regime,
            industry_regime: marketEnvironment?.industry?.regime,
          },
          agent_eligible:
            signal.score >= 72 && signal.signal === 'buy' && (signal.risk_flags || []).length <= 2,
          agent_status: 'pending',
        });
      }
    }

    const grouped = strategies.map(strategy => ({
      strategy_key: strategy.definition.strategy_key,
      name: strategy.definition.name,
      count: limited.filter(item => item.strategy_key === strategy.definition.strategy_key).length,
      buy_count: limited.filter(
        item => item.strategy_key === strategy.definition.strategy_key && item.signal === 'buy'
      ).length,
      avg_score: round(
        limited
          .filter(item => item.strategy_key === strategy.definition.strategy_key)
          .reduce((sum, item, _, arr) => sum + item.score / Math.max(arr.length, 1), 0),
        2
      ),
    }));

    return {
      generated_at: new Date().toISOString(),
      trade_date,
      scanned_stocks: contexts.length,
      strategy_count: strategies.length,
      signal_count: limited.length,
      persisted: options.persist !== false,
      quote_sync: quoteSync,
      param_version_by_strategy: options.param_version_by_strategy || {},
      runtime_policy_by_strategy: runtimePoliciesByStrategy,
      runtime_policy_diagnostics: Object.values(policyDiagnostics),
      by_strategy: grouped,
      signals: limited,
    };
  }

  async listSignals(options: {
    trade_date?: string;
    start_date?: string;
    end_date?: string;
    strategy_key?: string;
    signal?: string;
    symbol?: string;
    limit?: number;
  }) {
    const where: any = {};
    if (options.trade_date) where.trade_date = options.trade_date;
    if (options.strategy_key) where.strategy_key = options.strategy_key;
    if (options.signal) where.signal = options.signal;
    if (options.symbol) where.symbol = options.symbol;
    if (options.start_date || options.end_date) {
      where.trade_date = {};
      if (options.start_date) where.trade_date[Op.gte] = options.start_date;
      if (options.end_date) where.trade_date[Op.lte] = options.end_date;
    }
    return QuantSignal.findAll({
      where,
      order: [
        ['trade_date', 'DESC'],
        ['score', 'DESC'],
      ],
      limit: Math.min(Number(options.limit || 200), 1000),
    });
  }

  async getRankingDashboard(options: { trade_date?: string; limit?: number } = {}) {
    const requestedTradeDate = options.trade_date;
    let tradeDate = requestedTradeDate;
    if (tradeDate) {
      const exists = await QuantSignal.findOne({
        where: { trade_date: tradeDate },
        order: [['score', 'DESC']],
      });
      if (!exists) {
        tradeDate = undefined;
      }
    }
    tradeDate =
      tradeDate ||
      (
        await QuantSignal.findOne({
          order: [
            ['trade_date', 'DESC'],
            ['score', 'DESC'],
          ],
        })
      )?.trade_date;
    if (!tradeDate) {
      const quotePersistence = await realtimeQuoteService.getPersistenceSummary();
      return {
        generated_at: new Date().toISOString(),
        trade_date: null,
        quant_rankings: [],
        summary: {
          signal_count: 0,
          buy_count: 0,
          watch_count: 0,
          quant_scored: false,
          quote_persistence: quotePersistence,
        },
      };
    }
    const limit = Math.min(Math.max(Number(options.limit || 30), 1), 100);
    const allSignals = await QuantSignal.findAll({
      where: { trade_date: tradeDate },
      order: [
        ['score', 'DESC'],
        ['confidence', 'DESC'],
      ],
      limit: 5000,
    });
    const rankableSignals = allSignals.filter(item =>
      ['buy', 'watch', 'hold'].includes(String(item.signal || '').toLowerCase())
    );
    const signals = rankableSignals.slice(0, Math.max(limit * 5, 100));
    const grouped = new Map<string, QuantSignal[]>();
    for (const signal of signals) {
      const existing = grouped.get(signal.symbol) || [];
      existing.push(signal);
      grouped.set(signal.symbol, existing);
    }
    const quant_rankings = [...grouped.values()]
      .map(items => {
        const sorted = [...items].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
        const best = sorted[0];
        const strategyKeys = [...new Set(sorted.map(item => item.strategy_key).filter(Boolean))];
        const reasons = [
          ...new Set(
            sorted
              .flatMap(item => String(item.reason || '').split(/[；;\n]/))
              .map(item => item.trim())
              .filter(Boolean)
          ),
        ];
        const riskFlags = [...new Set(sorted.flatMap(item => item.risk_flags || []))];
        return {
          symbol: best.symbol,
          name: best.name,
          trade_date: best.trade_date,
          signal: best.signal,
          score: round(Number(best.score || 0), 2),
          confidence: round(Number(best.confidence || 0), 2),
          entry_price: best.entry_price,
          strategy_key: best.strategy_key,
          strategy_keys: strategyKeys,
          consensus_count: strategyKeys.length,
          reason: reasons.slice(0, 3).join('；') || best.reason,
          risk_flags: riskFlags.slice(0, 4),
          agent_eligible: sorted.some(item => item.agent_eligible),
          price_source: best.raw_factors?.price_source,
          latest_quote_time: best.raw_factors?.latest_quote_time,
          market_regime: best.raw_factors?.market_environment?.market_regime,
          industry_regime: best.raw_factors?.market_environment?.industry?.regime,
        };
      })
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, limit)
      .map((item, index) => ({ rank: index + 1, ...item }));
    const quotePersistence = await realtimeQuoteService.getPersistenceSummary({
      trade_date: tradeDate,
    });
    return {
      generated_at: new Date().toISOString(),
      trade_date: tradeDate,
      quant_rankings,
      summary: {
        requested_trade_date: requestedTradeDate || null,
        fallback_used: Boolean(requestedTradeDate && requestedTradeDate !== tradeDate),
        signal_count: allSignals.length,
        ranking_signal_count: rankableSignals.length,
        ranked_symbol_count: quant_rankings.length,
        buy_count: allSignals.filter(item => item.signal === 'buy').length,
        watch_count: allSignals.filter(item => item.signal === 'watch').length,
        hold_count: allSignals.filter(item => item.signal === 'hold').length,
        quant_scored: allSignals.length > 0,
        quote_persistence: quotePersistence,
      },
    };
  }
}

export const quantSignalService = new QuantSignalService();
