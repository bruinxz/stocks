import { Op } from 'sequelize';
import { createHash } from 'crypto';
import { QuantStrategyExperiment } from '../../../models/QuantStrategyExperiment';
import { QuantBacktestTask } from '../../../models/QuantBacktestTask';
import { QuantBacktestResult } from '../../../models/QuantBacktestResult';
import { round } from '../../engine/QuantMath';
import { strategyRegistry } from '../../engine/StrategyRegistry';

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stableStringify(value: any): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value: any, length = 12): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, length);
}

function paramsForStrategy(parameters: Record<string, any>, strategy_key: string) {
  const paramsByStrategy = asPlainObject(
    parameters.params_by_strategy || parameters.paramsByStrategy
  );
  return asPlainObject(paramsByStrategy[strategy_key]);
}

function isSameParams(left: Record<string, any>, right: Record<string, any>) {
  return stableStringify(left) === stableStringify(right);
}

export class QuantStrategyExperimentService {
  async recordBacktestTask(task_id: number) {
    const task = await QuantBacktestTask.findByPk(task_id);
    if (!task || task.status !== 'COMPLETED') return { recorded: 0, experiments: [] };

    const results = await QuantBacktestResult.findAll({ where: { task_id } });
    const experiments = [];
    for (const result of results) {
      const metrics = asPlainObject(result.metrics_json);
      const diagnostics = asPlainObject(metrics.execution_diagnostics);
      const experimentKey = this.buildExperimentKey(task, result);
      const rankScore = this.computeRankScore(result, diagnostics);
      const payload = {
        experiment_key: experimentKey,
        task_id: task.id,
        result_id: result.id,
        strategy_key: result.strategy_key,
        strategy_name: result.strategy_name,
        status: 'completed',
        start_date: task.start_date,
        end_date: task.end_date,
        universe: task.universe,
        symbols: task.symbols || [],
        parameters_json: task.parameters || {},
        metrics_json: metrics,
        execution_diagnostics: diagnostics,
        total_return_pct: result.total_return_pct,
        excess_return_pct: result.excess_return_pct,
        max_drawdown_pct: result.max_drawdown_pct,
        sharpe_ratio: result.sharpe_ratio,
        win_rate: result.win_rate,
        trade_count: result.trade_count,
        rank_score: rankScore,
        conclusion: this.buildConclusion(result, diagnostics, rankScore),
      };
      const [experiment] = await QuantStrategyExperiment.findOrCreate({
        where: { experiment_key: experimentKey },
        defaults: payload as any,
      });
      await experiment.update(payload as any);
      experiments.push(experiment);
    }
    return { recorded: experiments.length, experiments };
  }

  async listExperiments(options: { limit?: number; strategy_key?: string } = {}) {
    const where: any = {};
    if (options.strategy_key) where.strategy_key = options.strategy_key;
    return QuantStrategyExperiment.findAll({
      where,
      order: [
        ['rank_score', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit: Math.min(Math.max(Number(options.limit || 50), 1), 200),
    });
  }

  async getExperimentSummary(options: { limit?: number } = {}) {
    const experiments = await this.listExperiments({ limit: options.limit || 80 });
    const best = experiments[0] || null;
    const byStrategy = new Map<string, any[]>();
    for (const experiment of experiments) {
      if (!byStrategy.has(experiment.strategy_key)) byStrategy.set(experiment.strategy_key, []);
      byStrategy.get(experiment.strategy_key)!.push(experiment);
    }
    return {
      total: experiments.length,
      best,
      by_strategy: [...byStrategy.entries()]
        .map(([strategy_key, rows]) => ({
          strategy_key,
          strategy_name: rows[0]?.strategy_name,
          experiment_count: rows.length,
          best_rank_score: round(Math.max(...rows.map(item => toNumber(item.rank_score))), 2),
          best_excess_return_pct: round(
            Math.max(...rows.map(item => toNumber(item.excess_return_pct))),
            4
          ),
          avg_rank_score: round(
            rows.reduce((sum, item) => sum + toNumber(item.rank_score), 0) /
              Math.max(rows.length, 1),
            2
          ),
        }))
        .sort((a, b) => b.best_rank_score - a.best_rank_score),
      experiments,
    };
  }

  async getParamsByStrategySuggestion(
    options: {
      limit?: number;
      min_rank_score?: number;
      min_excess_return_pct?: number;
      min_trade_count?: number;
      max_drawdown_pct?: number;
      min_stable_count?: number;
    } = {}
  ) {
    const limit = Math.min(Math.max(Number(options.limit || 300), 50), 1000);
    const minRankScore = toNumber(options.min_rank_score, 8);
    const minExcessReturnPct = toNumber(options.min_excess_return_pct, 0);
    const minTradeCount = Math.max(Math.floor(toNumber(options.min_trade_count, 1)), 0);
    const maxDrawdownPct = Math.max(Math.abs(toNumber(options.max_drawdown_pct, 35)), 1);
    const minStableCount = Math.max(Math.floor(toNumber(options.min_stable_count, 1)), 1);

    const experiments = await QuantStrategyExperiment.findAll({
      where: {
        status: 'completed',
        trade_count: { [Op.gte]: minTradeCount },
      },
      order: [
        ['rank_score', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit,
    });

    const definitions = strategyRegistry.list();
    const recommendedParamsByStrategy: Record<string, Record<string, any>> = {};
    const suggestions = definitions.map(definition => {
      const rows = experiments.filter(row => row.strategy_key === definition.strategy_key);
      const eligible = rows.filter(row => {
        const drawdown = Math.abs(toNumber(row.max_drawdown_pct));
        return (
          toNumber(row.rank_score) >= minRankScore &&
          toNumber(row.excess_return_pct) >= minExcessReturnPct &&
          drawdown <= maxDrawdownPct
        );
      });
      const best = eligible[0] || rows[0] || null;
      const bestParameters = asPlainObject(best?.parameters_json);
      const experimentParams = best
        ? paramsForStrategy(bestParameters, definition.strategy_key)
        : {};
      const recommendedParams = {
        ...(definition.default_params || {}),
        ...experimentParams,
      };
      const hasCustomParams = Object.keys(experimentParams).length > 0;
      const stableCount = best
        ? eligible.filter(row =>
            isSameParams(
              {
                ...(definition.default_params || {}),
                ...paramsForStrategy(asPlainObject(row.parameters_json), definition.strategy_key),
              },
              recommendedParams
            )
          ).length
        : 0;
      const drawdown = Math.abs(toNumber(best?.max_drawdown_pct));
      const rankScore = toNumber(best?.rank_score);
      const excessReturn = toNumber(best?.excess_return_pct);
      const eligibleEnough = Boolean(
        best &&
          eligible.includes(best as any) &&
          stableCount >= minStableCount &&
          toNumber(best.trade_count) >= minTradeCount
      );
      const confidence = best
        ? round(
            Math.min(
              100,
              Math.max(
                0,
                48 +
                  Math.min(28, rankScore) +
                  Math.min(14, Math.max(0, excessReturn) * 0.45) +
                  Math.min(10, toNumber(best.trade_count) * 0.35) -
                  Math.min(18, drawdown * 0.22) +
                  Math.min(8, stableCount * 2)
              )
            ),
            2
          )
        : 0;
      const action = eligibleEnough ? 'use' : best ? 'observe' : 'keep_default';
      if (action === 'use') {
        recommendedParamsByStrategy[definition.strategy_key] = recommendedParams;
      }
      return {
        strategy_key: definition.strategy_key,
        strategy_name: definition.name,
        action,
        confidence,
        stable_count: stableCount,
        experiment_count: rows.length,
        has_custom_params: hasCustomParams,
        recommended_params: recommendedParams,
        default_params: definition.default_params || {},
        source_experiment: best
          ? {
              id: best.id,
              experiment_key: best.experiment_key,
              task_id: best.task_id,
              result_id: best.result_id,
              start_date: best.start_date,
              end_date: best.end_date,
              rank_score: round(rankScore, 4),
              total_return_pct: round(toNumber(best.total_return_pct), 4),
              excess_return_pct: round(excessReturn, 4),
              max_drawdown_pct: round(toNumber(best.max_drawdown_pct), 4),
              sharpe_ratio: round(toNumber(best.sharpe_ratio), 4),
              win_rate: round(toNumber(best.win_rate), 4),
              trade_count: toNumber(best.trade_count),
              conclusion: best.conclusion,
            }
          : null,
        reason:
          action === 'use'
            ? `采用实验分 ${round(rankScore, 1)} 的稳定参数，超额 ${round(
                excessReturn,
                2
              )}%，回撤 ${round(toNumber(best?.max_drawdown_pct), 2)}%，成交 ${
                best?.trade_count || 0
              } 笔。`
            : best
            ? `暂不自动采用：实验分/超额/回撤/稳定性尚未同时达标，当前仅观察。`
            : '暂无实验样本，继续使用策略默认参数。',
      };
    });

    const useCount = suggestions.filter(item => item.action === 'use').length;
    const observeCount = suggestions.filter(item => item.action === 'observe').length;
    return {
      generated_at: new Date().toISOString(),
      policy: {
        min_rank_score: minRankScore,
        min_excess_return_pct: minExcessReturnPct,
        min_trade_count: minTradeCount,
        max_drawdown_pct: maxDrawdownPct,
        min_stable_count: minStableCount,
      },
      recommended_params_by_strategy: recommendedParamsByStrategy,
      suggestions,
      summary: {
        experiment_count: experiments.length,
        strategy_count: definitions.length,
        use_count: useCount,
        observe_count: observeCount,
        keep_default_count: suggestions.length - useCount - observeCount,
        conclusion:
          useCount > 0
            ? `已生成 ${useCount} 个可自动用于开盘扫描的策略参数建议，其余策略继续观察或使用默认参数。`
            : experiments.length > 0
            ? '已有实验样本，但暂未达到自动采用门槛；开盘扫描继续使用默认/手工参数。'
            : '暂无实验样本；请先完成真实执行跑分以沉淀参数建议。',
      },
    };
  }

  private buildExperimentKey(task: QuantBacktestTask, result: QuantBacktestResult) {
    return `qexp_${shortHash({
      task_id: task.id,
      result_id: result.id,
      strategy_key: result.strategy_key,
      start_date: task.start_date,
      end_date: task.end_date,
      parameters: task.parameters,
    })}`;
  }

  private computeRankScore(result: QuantBacktestResult, diagnostics: Record<string, any>) {
    const excess = toNumber(result.excess_return_pct ?? result.total_return_pct);
    const drawdownPenalty = Math.abs(toNumber(result.max_drawdown_pct)) * 0.45;
    const sharpeScore = toNumber(result.sharpe_ratio) * 8;
    const winScore = (toNumber(result.win_rate) - 50) * 0.18;
    const tradeScore = Math.min(toNumber(result.trade_count), 60) * 0.12;
    const blocked =
      toNumber(diagnostics.blocked_buy_count) + toNumber(diagnostics.blocked_sell_count);
    const attempt =
      toNumber(diagnostics.buy_attempt_count) + toNumber(diagnostics.sell_attempt_count);
    const blockedPenalty = attempt > 0 ? (blocked / attempt) * 12 : 0;
    return round(
      excess * 1.3 - drawdownPenalty + sharpeScore + winScore + tradeScore - blockedPenalty,
      4
    );
  }

  private buildConclusion(
    result: QuantBacktestResult,
    diagnostics: Record<string, any>,
    rankScore: number
  ) {
    const blocked =
      toNumber(diagnostics.blocked_buy_count) + toNumber(diagnostics.blocked_sell_count);
    const cost =
      toNumber(diagnostics.total_commission) +
      toNumber(diagnostics.total_stamp_tax) +
      toNumber(diagnostics.total_slippage_cost);
    if (toNumber(result.trade_count) <= 0) return '未形成有效交易样本，暂不纳入生产权重。';
    if (rankScore >= 20) {
      return `可重点观察：超额 ${round(
        toNumber(result.excess_return_pct),
        2
      )}%，真实执行阻塞 ${blocked} 次，成本约 ${round(cost, 2)} 元。`;
    }
    if (rankScore >= 8) {
      return `可小仓验证：收益/回撤尚可，真实执行阻塞 ${blocked} 次，需继续扩大样本。`;
    }
    return `暂观察：真实成本和回撤后优势不足，阻塞 ${blocked} 次，建议等待更多样本或调参。`;
  }
}

export const quantStrategyExperimentService = new QuantStrategyExperimentService();
