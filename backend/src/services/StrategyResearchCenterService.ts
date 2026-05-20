import moment from 'moment-timezone';
import { quantStrategyService } from '../quant/services/QuantStrategyService';
import { quantStrategyFeedbackService } from '../quant/services/QuantStrategyFeedbackService';
import { quantStrategyExperimentService } from '../quant/services/QuantStrategyExperimentService';
import { quantStrategyParamVersionService } from '../quant/services/QuantStrategyParamVersionService';
import { recommendationTradeOutcomeService } from './RecommendationTradeOutcomeService';
import { logger } from '../utils/logger';

interface StrategyResearchCenterOptions {
  user_id?: number;
  username?: string;
  lookback_days?: number;
  limit?: number;
}

type PartialResult<T = any> = {
  ok: boolean;
  data: T | null;
  error?: string;
};

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundNumber(value: any, digits = 2): number {
  const parsed = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(parsed * base) / base;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asPlain<T = any>(record: any): T {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
}

function safeText(value: any, maxLength = 120): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function categoryLabel(value?: string): string {
  const labels: Record<string, string> = {
    trend: '趋势跟随',
    momentum: '动量强弱',
    mean_reversion: '均值回归',
    breakout: '突破启动',
    multi_factor: '多因子',
    risk_control: '风险质量',
  };
  return labels[String(value || '')] || value || '未分类';
}

function actionLabel(value?: string): string {
  const labels: Record<string, string> = {
    increase: '加权',
    slight_increase: '轻加权',
    observe: '观察',
    reduce: '降权',
    pause: '暂停',
    use: '采用参数',
    keep_default: '保持默认',
  };
  return labels[String(value || '')] || value || '观察';
}

function styleLabel(value?: string): string {
  const labels: Record<string, string> = {
    balanced: '均衡',
    momentum: '动量',
    value: '价值',
    low_risk: '低风险',
  };
  return labels[String(value || '')] || value || '未标注';
}

class StrategyResearchCenterService {
  async getCenter(options: StrategyResearchCenterOptions = {}) {
    const lookbackDays = clamp(toNumber(options.lookback_days, 180), 30, 3650);
    const limit = clamp(toNumber(options.limit, 2000), 100, 10000);

    const [
      strategiesResult,
      weightsResult,
      allocationResult,
      experimentsResult,
      suggestionsResult,
      paramDashboardResult,
      activeScanParamsResult,
      optimizationResult,
    ] = await Promise.all([
      this.safeRead('策略库', () => quantStrategyService.listStrategies()),
      this.safeRead('策略权重', () => quantStrategyFeedbackService.listWeights()),
      this.safeRead('策略资金预算', () =>
        quantStrategyFeedbackService.getAllocationPolicy({ capital: 200000 })
      ),
      this.safeRead('策略实验', () =>
        quantStrategyExperimentService.getExperimentSummary({ limit: 80 })
      ),
      this.safeRead('实验参数建议', () =>
        quantStrategyExperimentService.getParamsByStrategySuggestion({ limit: 300 })
      ),
      this.safeRead('参数版本验证', () =>
        quantStrategyParamVersionService.getDashboard({ limit: 1200 })
      ),
      this.safeRead('开盘扫描参数选择', () =>
        quantStrategyParamVersionService.getActiveParamsForScan()
      ),
      this.safeRead('自主闭环优化', () =>
        recommendationTradeOutcomeService.getOptimizationDashboard({
          user_id: options.user_id,
          username: options.username,
          include_open: true,
          lookback_days: lookbackDays,
          horizons: '1d,3d,5d,10d,20d',
          limit,
        } as any)
      ),
    ]);

    const strategies = (strategiesResult.data || []).map(item => asPlain<any>(item));
    const weights = (weightsResult.data || []).map(item => asPlain<any>(item));
    const allocation = allocationResult.data || null;
    const experiments = experimentsResult.data || null;
    const suggestions = suggestionsResult.data || null;
    const paramDashboard = paramDashboardResult.data || null;
    const activeScanParams = activeScanParamsResult.data || null;
    const optimization = optimizationResult.data || null;

    const mergedStrategies = this.buildStrategyRows({
      strategies,
      weights,
      allocation,
      experiments,
      suggestions,
      paramDashboard,
    });
    const summary = this.buildSummary({
      strategies,
      weights,
      allocation,
      experiments,
      suggestions,
      paramDashboard,
      optimization,
      mergedStrategies,
    });
    const nextActions = this.buildNextActions({ summary, optimization, paramDashboard, suggestions });

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      filters: { lookback_days: lookbackDays, limit },
      health: {
        strategies: this.toHealth(strategiesResult),
        weights: this.toHealth(weightsResult),
        allocation: this.toHealth(allocationResult),
        experiments: this.toHealth(experimentsResult),
        suggestions: this.toHealth(suggestionsResult),
        param_versions: this.toHealth(paramDashboardResult),
        active_scan_params: this.toHealth(activeScanParamsResult),
        optimization: this.toHealth(optimizationResult),
      },
      conclusion: this.buildConclusion(summary, optimization),
      summary,
      next_actions: nextActions,
      strategy_rows: mergedStrategies,
      champion_candidates: this.buildChampionCandidates({
        experiments,
        paramDashboard,
        optimization,
        mergedStrategies,
      }),
      weak_candidates: this.buildWeakCandidates({ paramDashboard, optimization, mergedStrategies }),
      allocation_policy: allocation
        ? {
            generated_at: allocation.generated_at,
            capital: allocation.capital,
            summary: allocation.summary,
            allocations: (allocation.allocations || []).slice(0, 12),
            rule: allocation.rule,
          }
        : null,
      experiment_summary: experiments
        ? {
            total: experiments.total,
            best: asPlain(experiments.best),
            by_strategy: experiments.by_strategy || [],
          }
        : null,
      param_dashboard: paramDashboard
        ? {
            summary: paramDashboard.summary,
            champion: paramDashboard.champion,
            lifecycle: paramDashboard.lifecycle,
            summary_by_strategy: paramDashboard.summary_by_strategy || [],
            summary_by_version: (paramDashboard.summary_by_version || []).slice(0, 20),
            environment_attribution: paramDashboard.environment_attribution,
          }
        : null,
      active_scan_params: activeScanParams
        ? {
            summary: activeScanParams.summary,
            selections: activeScanParams.selections || [],
            diagnostics_by_strategy: activeScanParams.diagnostics_by_strategy || {},
          }
        : null,
      autonomous_optimization: optimization
        ? {
            summary: optimization.summary,
            next_policy: optimization.next_policy,
            adaptive_risk: optimization.adaptive_risk,
            segment_actions: optimization.segment_actions,
            strategy_combos: optimization.strategy_combos,
            market_environment: optimization.market_environment,
            insights: optimization.insights,
          }
        : null,
      links: {
        weights: '/strategy-research/weights',
        versions: '/strategy-research/versions',
        experiments: '/strategy-research/experiments',
        optimization: '/strategy-research/optimization',
        review: '/review',
      },
    };
  }

  private async safeRead<T>(label: string, loader: () => Promise<T>): Promise<PartialResult<T>> {
    try {
      const data = await loader();
      return { ok: true, data };
    } catch (error: any) {
      const message = error?.message || String(error);
      logger.warn(`策略研究中心读取${label}失败: ${message}`);
      return { ok: false, data: null, error: message };
    }
  }

  private toHealth(result: PartialResult) {
    return result.ok
      ? { ok: true, status: 'ok' }
      : { ok: false, status: 'partial', message: safeText(result.error, 120) };
  }

  private buildStrategyRows(payload: Record<string, any>) {
    const weightByKey = new Map<string, any>(
      (payload.weights || []).map((item: any) => [item.strategy_key, item])
    );
    const allocationByKey = new Map<string, any>(
      (payload.allocation?.allocations || []).map((item: any) => [item.strategy_key, item])
    );
    const experimentByKey = new Map<string, any>(
      (payload.experiments?.by_strategy || []).map((item: any) => [item.strategy_key, item])
    );
    const suggestionByKey = new Map<string, any>(
      (payload.suggestions?.suggestions || []).map((item: any) => [item.strategy_key, item])
    );
    const paramByKey = new Map<string, any>(
      (payload.paramDashboard?.summary_by_strategy || []).map((item: any) => [
        item.strategy_key,
        item,
      ])
    );

    return (payload.strategies || [])
      .map((strategy: any) => {
        const weight = weightByKey.get(strategy.strategy_key) || {};
        const allocation = allocationByKey.get(strategy.strategy_key) || {};
        const experiment = experimentByKey.get(strategy.strategy_key) || {};
        const suggestion = suggestionByKey.get(strategy.strategy_key) || {};
        const param = paramByKey.get(strategy.strategy_key) || {};
        const champion = param.champion || {};
        return {
          strategy_key: strategy.strategy_key,
          name: strategy.name,
          category: strategy.category,
          category_label: categoryLabel(strategy.category),
          enabled: Boolean(strategy.enabled),
          risk_level: strategy.risk_level || '',
          tags: strategy.tags || [],
          execution_policy: strategy.execution_policy || {},
          environment_policy: strategy.environment_policy || {},
          lifecycle_policy: strategy.lifecycle_policy || {},
          notes: strategy.notes || '',
          display_order: toNumber(strategy.display_order, 0),
          weight: roundNumber(weight.weight || 1, 2),
          weight_action: weight.action || 'observe',
          weight_action_label: actionLabel(weight.action),
          quality_score: roundNumber(weight.quality_score || 0, 2),
          sample_count: toNumber(weight.sample_count, 0),
          closed_count: toNumber(weight.closed_count, 0),
          allocation_pct: roundNumber(allocation.allocation_pct, 2),
          capital_amount: roundNumber(allocation.capital_amount, 2),
          best_rank_score: roundNumber(experiment.best_rank_score, 2),
          best_excess_return_pct: roundNumber(experiment.best_excess_return_pct, 2),
          experiment_count: toNumber(experiment.experiment_count, 0),
          param_action: suggestion.action || 'keep_default',
          param_action_label: actionLabel(suggestion.action),
          param_confidence: roundNumber(suggestion.confidence, 2),
          champion_version_key: champion.version_key || '',
          champion_rank_score: roundNumber(champion.rank_score, 2),
          champion_avg_excess_return_pct: roundNumber(champion.avg_excess_return_pct, 2),
          champion_completed_count: toNumber(champion.completed_count, 0),
          reason: safeText(
            weight.reason || suggestion.reason || champion.adoption_reason || strategy.description,
            160
          ),
        };
      })
      .sort(
        (a: any, b: any) =>
          toNumber(a.display_order, 0) - toNumber(b.display_order, 0) ||
          Number(b.enabled) - Number(a.enabled) ||
          toNumber(b.quality_score) - toNumber(a.quality_score) ||
          toNumber(b.best_rank_score) - toNumber(a.best_rank_score)
      );
  }

  private buildSummary(payload: Record<string, any>) {
    const strategies = payload.strategies || [];
    const enabledCount = strategies.filter((item: any) => item.enabled).length;
    const categoryCount = new Set(strategies.map((item: any) => item.category).filter(Boolean)).size;
    const weights = payload.weights || [];
    const allocation = payload.allocation || {};
    const paramSummary = payload.paramDashboard?.summary || {};
    const optimizationSummary = payload.optimization?.summary || {};
    const nextPolicy = payload.optimization?.next_policy || {};
    const rows = payload.mergedStrategies || [];
    const boostedCount = weights.filter((item: any) =>
      ['increase', 'slight_increase'].includes(item.action)
    ).length;
    const reducedCount = weights.filter((item: any) =>
      ['reduce', 'pause'].includes(item.action)
    ).length;

    return {
      strategy_count: strategies.length,
      enabled_count: enabledCount,
      disabled_count: Math.max(0, strategies.length - enabledCount),
      category_count: categoryCount,
      boosted_count: boostedCount,
      reduced_count: reducedCount,
      allocation_count: toNumber(allocation.allocation_count, 0),
      total_allocation_pct: roundNumber(allocation.summary?.total_allocation_pct, 2),
      experiment_count: toNumber(payload.experiments?.total, 0),
      best_experiment_score: roundNumber(payload.experiments?.best?.rank_score, 2),
      best_experiment_strategy: payload.experiments?.best?.strategy_name || '',
      param_version_count: toNumber(paramSummary.version_count, 0),
      param_champion_count: toNumber(paramSummary.champion_count, 0),
      param_active_candidate_count: toNumber(paramSummary.active_candidate_count, 0),
      param_completed_count: toNumber(paramSummary.completed_count, 0),
      param_pending_count: toNumber(paramSummary.pending_count, 0),
      closed_count: toNumber(optimizationSummary.closed_count, 0),
      avg_excess_return_pct: roundNumber(optimizationSummary.avg_excess_return_pct, 2),
      excess_win_rate: roundNumber(optimizationSummary.excess_win_rate, 2),
      next_style: nextPolicy.recommended_style || '',
      next_style_label: styleLabel(nextPolicy.recommended_style),
      next_min_score: toNumber(nextPolicy.recommended_min_score, 72),
      next_default_position_pct: roundNumber(nextPolicy.recommended_default_position_pct, 2),
      next_trade_limit: toNumber(nextPolicy.recommended_paper_trade_limit, 0),
      top_strategy: rows[0] || null,
    };
  }

  private buildConclusion(summary: Record<string, any>, optimization: any) {
    const closedCount = toNumber(summary.closed_count, 0);
    const avgExcess = toNumber(summary.avg_excess_return_pct, 0);
    const championCount = toNumber(summary.param_champion_count, 0);
    if (closedCount < 5 && championCount === 0) {
      return {
        tone: 'wait',
        headline: '策略研究仍在样本沉淀期',
        reason: `闭环样本 ${closedCount}/5，参数冠军 ${championCount} 个，暂不建议大幅调参。`,
        next_action: '继续运行量化扫描、参数验证和模拟盘闭环，优先补齐样本。',
      };
    }
    if (avgExcess < -1) {
      return {
        tone: 'reduce',
        headline: '策略收益暂弱，下一轮提高门槛并降低预算',
        reason: `闭环平均超额 ${avgExcess.toFixed(2)}%，应先减少弱策略试错成本。`,
        next_action: '优先应用降权/暂停片段，保留小仓复采样。',
      };
    }
    const bestCombo = optimization?.strategy_combos?.best;
    if (bestCombo || championCount > 0) {
      return {
        tone: 'good',
        headline: '已有可晋级策略片段，可进入小幅放大验证',
        reason: bestCombo
          ? `${bestCombo.label} 平均超额 ${roundNumber(bestCombo.avg_excess_return_pct, 2)}%，闭环 ${bestCombo.closed_count} 笔。`
          : `参数冠军 ${championCount} 个，策略权重可按收益继续自动反哺。`,
        next_action: '只放大冠军策略/环境组合，弱组合继续冷却。',
      };
    }
    return {
      tone: 'watch',
      headline: '策略研究进入常规观察区',
      reason: '当前没有强晋级或强降权信号，保持现有策略池并继续验证。',
      next_action: '按收益复盘结果微调评分门槛和单票仓位。',
    };
  }

  private buildChampionCandidates(payload: Record<string, any>) {
    const candidates = [
      ...(payload.mergedStrategies || [])
        .filter((item: any) => item.enabled)
        .slice(0, 8)
        .map((item: any) => ({
          key: item.strategy_key,
          label: item.name,
          source: '策略权重',
          score: item.quality_score || item.best_rank_score,
          metric: `权重${item.weight}x / 预算${item.allocation_pct || 0}%`,
          reason: item.reason,
        })),
      ...(payload.paramDashboard?.lifecycle?.promotions || []).slice(0, 5).map((item: any) => ({
        key: item.version_key,
        label: `${item.strategy_name || item.strategy_key} / ${item.version_key}`,
        source: '参数晋级',
        score: item.rank_score,
        metric: `超额${roundNumber(item.avg_excess_return_pct, 2)}% / 样本${item.completed_count}`,
        reason: item.reason || item.adoption_reason,
      })),
      ...(payload.optimization?.segment_actions?.boost || []).slice(0, 5).map((item: any) => ({
        key: item.key,
        label: item.label,
        source: '闭环放大',
        score: item.robust_score || item.avg_excess_return_pct,
        metric: `超额${roundNumber(item.avg_excess_return_pct, 2)}% / 闭环${item.closed_count}`,
        reason: item.reason || item.budget_action_reason,
      })),
    ];
    return candidates
      .filter(item => item.key)
      .sort((a, b) => toNumber(b.score, 0) - toNumber(a.score, 0))
      .slice(0, 10);
  }

  private buildWeakCandidates(payload: Record<string, any>) {
    const candidates = [
      ...(payload.mergedStrategies || [])
        .filter((item: any) => ['reduce', 'pause'].includes(item.weight_action))
        .map((item: any) => ({
          key: item.strategy_key,
          label: item.name,
          source: '策略权重',
          score: item.quality_score,
          metric: `${item.weight_action_label} / 闭环${item.closed_count}`,
          reason: item.reason,
        })),
      ...(payload.paramDashboard?.lifecycle?.degradations || []).slice(0, 5).map((item: any) => ({
        key: item.version_key,
        label: `${item.strategy_name || item.strategy_key} / ${item.version_key}`,
        source: '参数降级',
        score: item.rank_score,
        metric: `超额${roundNumber(item.avg_excess_return_pct, 2)}% / 样本${item.completed_count}`,
        reason: item.reason || item.adoption_reason,
      })),
      ...(payload.optimization?.segment_actions?.reduce || []).slice(0, 5).map((item: any) => ({
        key: item.key,
        label: item.label,
        source: '闭环降权',
        score: item.robust_score || item.avg_excess_return_pct,
        metric: `超额${roundNumber(item.avg_excess_return_pct, 2)}% / 闭环${item.closed_count}`,
        reason: item.reason || item.budget_action_reason,
      })),
    ];
    return candidates
      .filter(item => item.key)
      .sort((a, b) => toNumber(a.score, 0) - toNumber(b.score, 0))
      .slice(0, 10);
  }

  private buildNextActions(payload: Record<string, any>) {
    const actions = [
      payload.summary.param_pending_count > 0
        ? `还有 ${payload.summary.param_pending_count} 条参数验证等待收益，先不要过早晋级。`
        : '',
      payload.summary.reduced_count > 0
        ? `${payload.summary.reduced_count} 个策略被降权/暂停，下一轮推荐应自动降低预算。`
        : '',
      payload.optimization?.next_policy
        ? `下一轮建议：${styleLabel(payload.optimization.next_policy.recommended_style)} / 评分≥${
            payload.optimization.next_policy.recommended_min_score
          } / 默认仓位 ${roundNumber(
            payload.optimization.next_policy.recommended_default_position_pct,
            2
          )}%。`
        : '',
      payload.paramDashboard?.summary?.conclusion,
      ...(payload.optimization?.insights || []).slice(0, 4),
    ]
      .map(item => safeText(item, 140))
      .filter(Boolean);
    return [...new Set(actions)].slice(0, 8);
  }
}

export const strategyResearchCenterService = new StrategyResearchCenterService();
