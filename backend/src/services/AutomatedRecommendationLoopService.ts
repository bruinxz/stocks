import moment from 'moment-timezone';
import { quantRecommendationService } from './QuantRecommendationService';
import { aiInvestmentSignalService } from './AIInvestmentSignalService';
import { paperTradingAutomationService } from './PaperTradingAutomationService';
import { feishuTaskReportService } from './FeishuTaskReportService';
import { aiAdvisorService } from './AIAdvisorService';
import { logger } from '../utils/logger';
import { AISignalSourceType } from '../models/AIInvestmentSignal';
import { aiPollingQueue } from '../jobs/aiPollingQueue';
import { recommendationTradeOutcomeService } from './RecommendationTradeOutcomeService';
import { recommendationLoopPolicySnapshotService } from './RecommendationLoopPolicySnapshotService';
import {
  buildRecommendationStrategyVariant,
  normalizeRecommendationStyle,
  parseRecommendationStrategyKey,
  recommendationPositionBucketMidpoint,
  recommendationScoreBucketFloor,
  recommendationTradeLimitFromStrategyKey,
} from '../utils/recommendationStrategyVariant';

export interface AutomatedRecommendationLoopOptions {
  username?: string;
  portfolio_name?: string;
  initial_capital?: number;
  force_new_portfolio?: boolean;
  universe?: 'favorites' | 'market';
  style?: 'balanced' | 'momentum' | 'value' | 'low_risk';
  candidate_limit?: number;
  candidate_pool_limit?: number;
  lookback_days?: number;
  min_bars?: number;
  exclude_st?: boolean;
  min_market_cap_yi?: number;
  archive_limit?: number;
  verify_signals?: boolean;
  run_paper_trading?: boolean;
  dry_run?: boolean;
  paper_trade_limit?: number;
  paper_trade_scan_limit?: number;
  min_score?: number;
  max_positions?: number;
  default_position_pct?: number;
  max_position_pct?: number;
  min_trade_amount?: number;
  use_outcome_feedback?: boolean;
  use_policy_version_feedback?: boolean;
  policy_version_lookback_limit?: number;
  use_strategy_experiment_feedback?: boolean;
  strategy_experiment_min_quality_delta?: number;
  strategy_experiment_limit?: number;
  strategy_experiment_pool_limit?: number;
  outcome_feedback_lookback_days?: number;
  outcome_feedback_min_closed_samples?: number;
  use_profit_gate?: boolean;
  profit_gate_horizon?: string;
  profit_gate_min_samples?: number;
  profit_gate_min_quality_score?: number;
  submit_agent_analysis?: boolean;
  agent_max_count?: number;
  agent_min_score?: number;
  agent_session?: string;
  agent_auto_paper_trade?: boolean;
  target_date?: string;
  task_label?: string;
  execution_log_id?: number;
  report_to_feishu?: boolean;
  record_type?: string;
  use_entry_risk_guard?: boolean;
  max_daily_new_positions?: number;
  max_daily_new_exposure_pct?: number;
  max_total_exposure_pct?: number;
  max_industry_exposure_pct?: number;
  min_avg_turnover_yuan?: number;
  cooldown_days_after_loss?: number;
  block_limit_up?: boolean;
  block_limit_down?: boolean;
  block_suspended?: boolean;
  use_environment_policy_feedback?: boolean;
}

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const normalized = Math.floor(parsed);
  return max ? Math.min(normalized, max) : normalized;
}

function clampNumber(value: any, min: number, max: number): number {
  const parsed = toNumber(value, min);
  return Math.min(max, Math.max(min, parsed));
}

function roundNumber(value: any, digits = 2): number {
  const parsed = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(parsed * base) / base;
}

function buildLoopRunId(prefix = 'loop'): string {
  const stamp = moment().tz('Asia/Shanghai').format('YYYYMMDDHHmmss');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${suffix}`;
}

function normalizeConsensusSymbol(value: any): string {
  return String(value || '').trim();
}

function rankConsensusCandidates(candidates: any[], loopPolicy: any): any[] {
  const overlaps = Array.isArray(loopPolicy?.strategy_experiment?.overlaps)
    ? loopPolicy.strategy_experiment.overlaps
    : [];
  const consensusMap = new Map<string, any>();
  for (const item of overlaps) {
    const symbol = normalizeConsensusSymbol(item.symbol);
    if (!symbol) continue;
    consensusMap.set(symbol, item);
  }
  if (consensusMap.size === 0) return candidates;

  return [...candidates]
    .map((candidate, index) => {
      const consensus = consensusMap.get(normalizeConsensusSymbol(candidate.symbol));
      const consensus_count = Number(consensus?.variant_count || 0);
      const consensus_bonus = consensus_count > 1 ? Math.min(6, (consensus_count - 1) * 2) : 0;
      return {
        ...candidate,
        score: Math.min(100, Number(candidate.score || 0) + consensus_bonus),
        original_score: candidate.original_score ?? candidate.score,
        data_quality_adjusted_score: candidate.score,
        consensus_count,
        consensus_variants: consensus?.variants || [],
        consensus_bonus,
        tier_reason: consensus_bonus
          ? `${candidate.tier_reason || ''}；策略实验 ${consensus_count} 个策略共识，优先复核`
          : candidate.tier_reason,
        metadata_rank_index: index,
      };
    })
    .sort(
      (a, b) =>
        Number(b.consensus_count || 0) - Number(a.consensus_count || 0) ||
        Number(b.score || 0) - Number(a.score || 0) ||
        Number(a.metadata_rank_index || 0) - Number(b.metadata_rank_index || 0)
    );
}

class AutomatedRecommendationLoopService {
  private async applyPolicyVersionPromotion(
    policy: any,
    options: {
      enabled: boolean;
      username?: string;
      universe?: 'favorites' | 'market';
      lookback_limit: number;
      min_closed_samples: number;
      base_min_score: number;
      base_max_position_pct: number;
    }
  ) {
    const enrichedPolicy = {
      ...policy,
      policy_version_feedback_enabled: options.enabled,
      policy_version_feedback_applied: false,
      policy_version_feedback_reason: options.enabled
        ? '策略版本晋级反馈已读取，等待足够样本后接管下一轮参数'
        : '策略版本晋级反馈未启用',
      policy_promotion: null as any,
    };

    if (!options.enabled) return enrichedPolicy;

    try {
      const dashboard = await recommendationLoopPolicySnapshotService.getDashboard({
        username: options.username,
        universe: options.universe || 'all',
        limit: options.lookback_limit,
      } as any);
      const promotion: any = dashboard?.promotion || {};
      const summary: any = dashboard?.summary || {};
      const runCount = toNumber(summary.run_count, 0);
      const action = String(promotion.action || '');
      const confidence = toNumber(promotion.confidence, 0);
      const closedSamples = Math.max(
        toNumber(promotion.best_snapshot?.closed_trade_count, 0),
        toNumber(summary.best_snapshot?.closed_trade_count, 0),
        toNumber(summary.latest_policy?.closed_trade_count, 0)
      );
      const enoughSamples = closedSamples >= Math.min(Math.max(options.min_closed_samples, 3), 5);
      const promotableAction = ['scale_up', 'tighten', 'hold_and_compare'].includes(action);
      const compactPromotion = {
        action,
        confidence: roundNumber(confidence, 4),
        recommended_style: promotion.recommended_style,
        recommended_min_score: promotion.recommended_min_score,
        recommended_default_position_pct: promotion.recommended_default_position_pct,
        recommended_max_position_pct: promotion.recommended_max_position_pct,
        recommended_paper_trade_limit: promotion.recommended_paper_trade_limit,
        position_multiplier: promotion.position_multiplier,
        best_snapshot_id: promotion.best_snapshot?.id,
        best_snapshot_closed_trade_count: promotion.best_snapshot?.closed_trade_count,
        best_snapshot_avg_excess_return_pct: promotion.best_snapshot?.avg_excess_return_pct,
        best_strategy_key: promotion.best_strategy_key,
        reasons: Array.isArray(promotion.reasons) ? promotion.reasons.slice(0, 4) : [],
      };

      const shouldApply = runCount > 0 && promotableAction && confidence >= 0.5 && enoughSamples;
      if (!shouldApply) {
        return {
          ...enrichedPolicy,
          policy_promotion: compactPromotion,
          policy_version_feedback_reason:
            runCount === 0
              ? '暂无策略版本样本，先执行小样本闭环生成可比较快照'
              : `策略版本样本 ${closedSamples}/${Math.min(
                  Math.max(options.min_closed_samples, 3),
                  5
                )}、置信度 ${Math.round(confidence * 100)}%，暂不自动接管参数`,
        };
      }

      const allowedStyles = ['balanced', 'momentum', 'value', 'low_risk'];
      const recommendedStyle = allowedStyles.includes(String(promotion.recommended_style || ''))
        ? String(promotion.recommended_style)
        : policy.effective_style;
      const bestStrategy = promotion.best_strategy_key || null;
      const bestStrategyClosed = toNumber(bestStrategy?.closed_count, 0);
      const bestStrategyExcess = toNumber(bestStrategy?.avg_outcome_excess_return_pct, 0);
      const bestStrategyRobustScore = toNumber(bestStrategy?.robust_score, 0);
      const bestStrategyBayesianWinRate = toNumber(bestStrategy?.bayesian_win_rate, 50);
      const bestStrategySampleConfidence = toNumber(bestStrategy?.sample_confidence, 0);
      const strategyParsed = parseRecommendationStrategyKey(bestStrategy?.key);
      const shouldAdoptStrategyCombo =
        bestStrategy &&
        bestStrategy.key &&
        bestStrategy.key !== 'unknown' &&
        bestStrategyClosed >= 3 &&
        bestStrategySampleConfidence >= 0.25 &&
        bestStrategyRobustScore >= 8 &&
        bestStrategyBayesianWinRate >= 52 &&
        bestStrategyExcess > Math.max(0.5, toNumber(summary.avg_outcome_excess_return_pct, 0));
      const currentMinScore = toNumber(policy.effective_min_score, options.base_min_score);
      const comboMinScore = shouldAdoptStrategyCombo
        ? recommendationScoreBucketFloor(strategyParsed.score, currentMinScore)
        : currentMinScore;
      const recommendedMinScore = shouldAdoptStrategyCombo
        ? Math.max(toNumber(promotion.recommended_min_score, currentMinScore), comboMinScore)
        : toNumber(promotion.recommended_min_score, currentMinScore);
      const currentDefaultPosition = toNumber(policy.effective_default_position_pct, 3);
      const comboDefaultPosition = shouldAdoptStrategyCombo
        ? recommendationPositionBucketMidpoint(strategyParsed.pos, currentDefaultPosition)
        : currentDefaultPosition;
      const recommendedDefaultPosition = shouldAdoptStrategyCombo
        ? comboDefaultPosition
        : toNumber(promotion.recommended_default_position_pct, currentDefaultPosition);
      const currentMaxPosition = toNumber(
        policy.effective_max_position_pct,
        options.base_max_position_pct
      );
      const comboMaxPosition = shouldAdoptStrategyCombo
        ? recommendationPositionBucketMidpoint(strategyParsed.max, currentMaxPosition)
        : currentMaxPosition;
      const recommendedMaxPosition = shouldAdoptStrategyCombo
        ? Math.max(comboMaxPosition, comboDefaultPosition)
        : toNumber(promotion.recommended_max_position_pct, currentMaxPosition);
      const currentTradeLimit = toPositiveInt(policy.effective_paper_trade_limit, 2, 20);
      const comboTradeLimit = shouldAdoptStrategyCombo
        ? recommendationTradeLimitFromStrategyKey(bestStrategy.key, currentTradeLimit)
        : currentTradeLimit;
      const recommendedTradeLimit = shouldAdoptStrategyCombo
        ? comboTradeLimit
        : toPositiveInt(promotion.recommended_paper_trade_limit, currentTradeLimit, 20);

      let effectiveMinScore = currentMinScore;
      let effectiveDefaultPositionPct = currentDefaultPosition;
      let effectiveMaxPositionPct = currentMaxPosition;
      let effectivePaperTradeLimit = currentTradeLimit;

      if (action === 'tighten') {
        effectiveMinScore = Math.max(currentMinScore, recommendedMinScore);
        effectiveDefaultPositionPct = Math.min(currentDefaultPosition, recommendedDefaultPosition);
        effectiveMaxPositionPct = Math.min(currentMaxPosition, recommendedMaxPosition);
        effectivePaperTradeLimit = Math.min(currentTradeLimit, recommendedTradeLimit);
      } else if (action === 'scale_up') {
        effectiveMinScore = Math.max(
          Math.min(currentMinScore, recommendedMinScore),
          options.base_min_score - 2
        );
        effectiveDefaultPositionPct = Math.max(currentDefaultPosition, recommendedDefaultPosition);
        effectiveMaxPositionPct = Math.max(currentMaxPosition, recommendedMaxPosition);
        effectivePaperTradeLimit = Math.max(currentTradeLimit, recommendedTradeLimit);
      } else {
        effectiveMinScore = Math.max(currentMinScore, recommendedMinScore);
        effectiveDefaultPositionPct =
          recommendedDefaultPosition < currentDefaultPosition
            ? recommendedDefaultPosition
            : (currentDefaultPosition + recommendedDefaultPosition) / 2;
        effectiveMaxPositionPct =
          recommendedMaxPosition < currentMaxPosition
            ? recommendedMaxPosition
            : (currentMaxPosition + recommendedMaxPosition) / 2;
        effectivePaperTradeLimit = Math.min(
          Math.max(currentTradeLimit, 1),
          Math.max(recommendedTradeLimit, 1)
        );
      }

      effectiveDefaultPositionPct = clampNumber(
        effectiveDefaultPositionPct,
        1,
        Math.max(1, options.base_max_position_pct)
      );
      effectiveMaxPositionPct = clampNumber(
        Math.max(effectiveMaxPositionPct, effectiveDefaultPositionPct),
        effectiveDefaultPositionPct,
        Math.max(effectiveDefaultPositionPct, options.base_max_position_pct)
      );

      return {
        ...enrichedPolicy,
        effective_style: shouldAdoptStrategyCombo
          ? normalizeRecommendationStyle(strategyParsed.style || recommendedStyle)
          : recommendedStyle,
        effective_min_score: roundNumber(clampNumber(effectiveMinScore, 62, 94), 2),
        effective_default_position_pct: roundNumber(effectiveDefaultPositionPct, 2),
        effective_max_position_pct: roundNumber(effectiveMaxPositionPct, 2),
        effective_paper_trade_limit: Math.max(1, Math.min(8, effectivePaperTradeLimit)),
        policy_version_feedback_applied: true,
        policy_promotion: compactPromotion,
        promoted_strategy_key: shouldAdoptStrategyCombo ? bestStrategy.key : undefined,
        promoted_strategy_label: shouldAdoptStrategyCombo ? bestStrategy.label : undefined,
        policy_version_feedback_reason: `已应用策略版本晋级建议：${action}，置信度 ${Math.round(
          confidence * 100
        )}%、平仓样本 ${closedSamples}，下一轮采用 ${recommendedStyle}/评分≥${roundNumber(
          effectiveMinScore,
          2
        )}/仓位 ${roundNumber(effectiveDefaultPositionPct, 2)}%${
          shouldAdoptStrategyCombo ? `；组合冠军 ${bestStrategy.label}` : ''
        }`,
        reason: `${policy.reason}；策略版本反馈：${action} / ${Math.round(
          confidence * 100
        )}% 置信度，已调整下一轮扫描参数${
          shouldAdoptStrategyCombo ? `，优先采用组合 ${bestStrategy.label}` : ''
        }`,
      };
    } catch (error: any) {
      logger.warn(`读取策略版本晋级建议失败，沿用当前闭环参数: ${error?.message || error}`);
      return {
        ...enrichedPolicy,
        policy_version_feedback_reason: `策略版本晋级建议读取失败，沿用当前参数：${
          error?.message || error
        }`,
      };
    }
  }

  private async resolveEnvironmentPolicyFeedback(options: {
    enabled: boolean;
    username?: string;
    portfolio_name?: string;
    initial_capital?: number;
    force_new_portfolio?: boolean;
    loop_run_id: string;
    lookback_days: number;
  }) {
    const fallback = {
      enabled: options.enabled,
      applied: false,
      snapshot_id: `${options.loop_run_id}_env_pending`,
      default_position_multiplier: 1,
      confidence: 0,
      closed_samples: 0,
      blocked_segments: [] as any[],
      reduced_segments: [] as any[],
      boosted_segments: [] as any[],
      reason: options.enabled ? '环境闸门反馈已启用，等待优化台样本' : '环境闸门反馈未启用',
    };

    if (!options.enabled) return fallback;

    try {
      const dashboard = await recommendationTradeOutcomeService.getOptimizationDashboard({
        username: options.username,
        portfolio_name: options.portfolio_name,
        initial_capital: options.initial_capital,
        force_new_portfolio: options.force_new_portfolio,
        include_open: true,
        lookback_days: options.lookback_days,
        limit: 2000,
        report_to_feishu: false,
      } as any);
      const policy =
        (dashboard as any).environment_policy ||
        (dashboard as any).market_environment?.policy ||
        {};
      const confidence = toNumber(policy.confidence, 0);
      const closedSamples = toNumber(policy.closed_samples, 0);
      const applied = closedSamples >= 2 || confidence >= 0.15;
      return {
        ...policy,
        enabled: true,
        applied,
        snapshot_id: `${options.loop_run_id}_env_${moment()
          .tz('Asia/Shanghai')
          .format('YYYYMMDDHHmmss')}`,
        default_position_multiplier: roundNumber(
          clampNumber(toNumber(policy.default_position_multiplier, 1), 0.35, 1.15),
          2
        ),
        confidence: roundNumber(confidence, 4),
        closed_samples: closedSamples,
        blocked_segments: Array.isArray(policy.blocked_segments)
          ? policy.blocked_segments.slice(0, 8)
          : [],
        reduced_segments: Array.isArray(policy.reduced_segments)
          ? policy.reduced_segments.slice(0, 8)
          : [],
        boosted_segments: Array.isArray(policy.boosted_segments)
          ? policy.boosted_segments.slice(0, 8)
          : [],
        watch_segments: Array.isArray(policy.watch_segments)
          ? policy.watch_segments.slice(0, 8)
          : [],
        reason:
          policy.reason ||
          (applied ? '环境闸门策略已从闭环优化台生成' : '环境样本不足，暂按默认环境纪律执行'),
      };
    } catch (error: any) {
      logger.warn(`读取环境闸门反馈失败，沿用默认环境纪律: ${error?.message || error}`);
      return {
        ...fallback,
        reason: `环境闸门反馈读取失败：${error?.message || error}`,
      };
    }
  }

  private async resolveLoopPolicy(options: {
    username?: string;
    portfolio_name?: string;
    initial_capital?: number;
    force_new_portfolio?: boolean;
    enabled: boolean;
    use_policy_version_feedback?: boolean;
    policy_version_lookback_limit?: number;
    universe?: 'favorites' | 'market';
    base_style: 'balanced' | 'momentum' | 'value' | 'low_risk';
    base_min_score: number;
    base_default_position_pct: number;
    base_max_position_pct: number;
    base_paper_trade_limit: number;
    lookback_days: number;
    min_closed_samples: number;
  }) {
    const basePolicy = {
      enabled: options.enabled,
      closed_samples: 0,
      min_closed_samples: options.min_closed_samples,
      lookback_days: options.lookback_days,
      base_style: options.base_style,
      effective_style: options.base_style,
      base_min_score: options.base_min_score,
      effective_min_score: options.base_min_score,
      base_default_position_pct: options.base_default_position_pct,
      effective_default_position_pct: options.base_default_position_pct,
      base_max_position_pct: options.base_max_position_pct,
      effective_max_position_pct: options.base_max_position_pct,
      base_paper_trade_limit: options.base_paper_trade_limit,
      effective_paper_trade_limit: options.base_paper_trade_limit,
      avg_excess_return_pct: 0,
      excess_win_rate: 0,
      position_multiplier: 1,
      reason: options.enabled ? '收益闭环样本不足，沿用基础扫描策略' : '未启用收益闭环自适应',
      best_segments: [] as any[],
      weak_segments: [] as any[],
      next_actions: [] as string[],
      outcome_feedback_enabled: options.enabled,
    };

    if (!options.enabled) {
      return this.applyPolicyVersionPromotion(basePolicy, {
        enabled: options.use_policy_version_feedback !== false,
        username: options.username,
        universe: options.universe,
        lookback_limit: toPositiveInt(options.policy_version_lookback_limit, 120, 1000),
        min_closed_samples: options.min_closed_samples,
        base_min_score: options.base_min_score,
        base_max_position_pct: options.base_max_position_pct,
      });
    }

    try {
      const dashboard = await recommendationTradeOutcomeService.getDashboard({
        username: options.username,
        portfolio_name: options.portfolio_name,
        initial_capital: options.initial_capital,
        force_new_portfolio: options.force_new_portfolio,
        include_open: true,
        lookback_days: options.lookback_days,
        limit: 2000,
        report_to_feishu: false,
      });
      const summary: any = dashboard.summary || {};
      const feedback: any = dashboard.feedback || {};
      const closedSamples = Number(summary.closed_count || 0);
      const avgExcess = Number(summary.avg_excess_return_pct || 0);
      const excessWinRate = Number(summary.excess_win_rate || 0);
      const feedbackMinScore = Number(feedback.recommended_min_score || options.base_min_score);
      const positionMultiplier = Number(feedback.position_multiplier || 1);
      const bestSegments = Array.isArray(feedback.best_segments) ? feedback.best_segments : [];
      const weakSegments = Array.isArray(feedback.weak_segments) ? feedback.weak_segments : [];
      const bestStyle = bestSegments.find((segment: any) =>
        ['balanced', 'momentum', 'value', 'low_risk'].includes(String(segment.key || ''))
      );
      const weakStyle = weakSegments.find((segment: any) =>
        ['balanced', 'momentum', 'value', 'low_risk'].includes(String(segment.key || ''))
      );
      const shouldUseBestStyle =
        closedSamples >= options.min_closed_samples &&
        bestStyle &&
        Number(bestStyle.closed_count || 0) >= 2 &&
        Number(bestStyle.avg_excess_return_pct || 0) > Math.max(1, avgExcess);
      const shouldAvoidBaseStyle =
        closedSamples >= options.min_closed_samples &&
        weakStyle &&
        String(weakStyle.key) === options.base_style &&
        Number(weakStyle.closed_count || 0) >= 2 &&
        Number(weakStyle.avg_excess_return_pct || 0) < -1;
      const effectiveStyle =
        shouldUseBestStyle || shouldAvoidBaseStyle
          ? String(bestStyle?.key || 'low_risk')
          : options.base_style;
      const coldStart = closedSamples < options.min_closed_samples;
      const effectiveMinScore = coldStart
        ? options.base_min_score
        : Math.min(94, Math.max(options.base_min_score, feedbackMinScore));
      const boundedMultiplier = coldStart
        ? Math.min(positionMultiplier || 1, 0.75)
        : Math.min(1.2, Math.max(0.35, positionMultiplier || 1));
      const effectiveDefaultPositionPct = Math.max(
        1,
        Math.min(
          options.base_max_position_pct,
          options.base_default_position_pct * boundedMultiplier
        )
      );
      const effectiveMaxPositionPct = Math.max(
        effectiveDefaultPositionPct,
        Math.min(
          options.base_max_position_pct,
          options.base_max_position_pct * Math.max(0.45, boundedMultiplier)
        )
      );
      const effectivePaperTradeLimit =
        coldStart || avgExcess < -1 || excessWinRate < 45
          ? Math.max(1, Math.min(options.base_paper_trade_limit, 2))
          : avgExcess > 2 && excessWinRate >= 55
          ? Math.min(5, options.base_paper_trade_limit + 1)
          : options.base_paper_trade_limit;

      const outcomePolicy = {
        ...basePolicy,
        closed_samples: closedSamples,
        effective_style: effectiveStyle as typeof basePolicy.effective_style,
        effective_min_score: Math.round(effectiveMinScore * 100) / 100,
        effective_default_position_pct: Math.round(effectiveDefaultPositionPct * 100) / 100,
        effective_max_position_pct: Math.round(effectiveMaxPositionPct * 100) / 100,
        effective_paper_trade_limit: effectivePaperTradeLimit,
        avg_excess_return_pct: Math.round(avgExcess * 10000) / 10000,
        excess_win_rate: Math.round(excessWinRate * 100) / 100,
        position_multiplier: Math.round(boundedMultiplier * 100) / 100,
        reason: coldStart
          ? `闭环样本 ${closedSamples}/${options.min_closed_samples}，使用保守小仓采样`
          : `闭环样本 ${closedSamples}，平均超额 ${Math.round(avgExcess * 100) / 100}%、超额胜率 ${
              Math.round(excessWinRate * 100) / 100
            }%，自动调整扫描风格/评分/仓位`,
        best_segments: bestSegments.slice(0, 5),
        weak_segments: weakSegments.slice(0, 5),
        next_actions: Array.isArray(feedback.next_actions) ? feedback.next_actions.slice(0, 5) : [],
      };
      return this.applyPolicyVersionPromotion(outcomePolicy, {
        enabled: options.use_policy_version_feedback !== false,
        username: options.username,
        universe: options.universe,
        lookback_limit: toPositiveInt(options.policy_version_lookback_limit, 120, 1000),
        min_closed_samples: options.min_closed_samples,
        base_min_score: options.base_min_score,
        base_max_position_pct: options.base_max_position_pct,
      });
    } catch (error: any) {
      logger.warn(`读取全市场荐股闭环自适应策略失败，沿用基础参数: ${error?.message || error}`);
      return this.applyPolicyVersionPromotion(
        {
          ...basePolicy,
          reason: `收益闭环自适应读取失败，沿用基础参数：${error?.message || error}`,
        },
        {
          enabled: options.use_policy_version_feedback !== false,
          username: options.username,
          universe: options.universe,
          lookback_limit: toPositiveInt(options.policy_version_lookback_limit, 120, 1000),
          min_closed_samples: options.min_closed_samples,
          base_min_score: options.base_min_score,
          base_max_position_pct: options.base_max_position_pct,
        }
      );
    }
  }

  private async applyStrategyExperimentFeedback(
    policy: any,
    options: {
      enabled: boolean;
      username?: string;
      universe: 'favorites' | 'market';
      candidate_limit: number;
      candidate_pool_limit: number;
      lookback_days: number;
      min_bars?: number;
      exclude_st: boolean;
      min_market_cap_yi?: number;
      min_quality_delta: number;
    }
  ) {
    const enrichedPolicy = {
      ...policy,
      strategy_experiment_feedback_enabled: options.enabled,
      strategy_experiment_feedback_applied: false,
      strategy_experiment_feedback_reason: options.enabled
        ? '策略实验反馈已启用，等待实验结果确认是否切换风格'
        : '策略实验反馈未启用',
      strategy_experiment: null as any,
    };

    if (!options.enabled) return enrichedPolicy;

    try {
      const experiment = await quantRecommendationService.runStrategyExperiment({
        universe: options.universe,
        limit: Math.min(Math.max(options.candidate_limit, 6), 20),
        candidate_pool_limit: options.candidate_pool_limit,
        lookback_days: options.lookback_days,
        min_bars: options.min_bars,
        exclude_st: options.exclude_st,
        min_market_cap_yi: options.min_market_cap_yi,
      });
      const champion = experiment.champion;
      const baseVariant = (experiment.variants || []).find(
        (item: any) => item.style === policy.effective_style
      );
      const championQuality = toNumber(champion?.metrics?.quality_score, 0);
      const baseQuality = toNumber(baseVariant?.metrics?.quality_score, 0);
      const qualityDelta = championQuality - baseQuality;
      const championTrialCount = toNumber(champion?.metrics?.trial_count, 0);
      const championStrongCount = toNumber(champion?.metrics?.strong_count, 0);
      const canSwitch =
        champion &&
        champion.style &&
        champion.style !== policy.effective_style &&
        qualityDelta >= options.min_quality_delta &&
        championQuality >= 55 &&
        championTrialCount + championStrongCount >= 2;
      const compactExperiment = {
        generated_at: experiment.generated_at,
        champion: champion
          ? {
              key: champion.key,
              label: champion.label,
              style: champion.style,
              quality_score: championQuality,
              strong_count: championStrongCount,
              trial_count: championTrialCount,
              avg_score: champion.metrics?.avg_score,
            }
          : null,
        base_variant: baseVariant
          ? {
              key: baseVariant.key,
              label: baseVariant.label,
              style: baseVariant.style,
              quality_score: baseQuality,
            }
          : null,
        quality_delta: roundNumber(qualityDelta, 2),
        overlap_count: Array.isArray(experiment.overlaps) ? experiment.overlaps.length : 0,
        overlaps: Array.isArray(experiment.overlaps) ? experiment.overlaps.slice(0, 20) : [],
        insights: Array.isArray(experiment.insights) ? experiment.insights.slice(0, 3) : [],
      };

      if (!canSwitch) {
        return {
          ...enrichedPolicy,
          strategy_experiment: compactExperiment,
          strategy_experiment_feedback_reason: champion
            ? `策略实验冠军 ${champion.label} 质量分 ${championQuality}，相对当前 ${roundNumber(
                qualityDelta,
                2
              )}，未达到自动切换阈值 ${options.min_quality_delta}`
            : '策略实验未产生冠军，沿用当前风格',
        };
      }

      return {
        ...enrichedPolicy,
        effective_style: champion.style,
        strategy_experiment_feedback_applied: true,
        strategy_experiment: compactExperiment,
        strategy_experiment_feedback_reason: `策略实验冠军 ${
          champion.label
        } 明显优于当前风格，质量分差 ${roundNumber(qualityDelta, 2)}，本轮主扫描切换为 ${
          champion.style
        }`,
        reason: `${policy.reason}；策略实验反馈：${champion.label} 胜出，自动切换扫描风格`,
      };
    } catch (error: any) {
      logger.warn(`读取策略实验反馈失败，沿用当前扫描风格: ${error?.message || error}`);
      return {
        ...enrichedPolicy,
        strategy_experiment_feedback_reason: `策略实验反馈读取失败，沿用当前风格：${
          error?.message || error
        }`,
      };
    }
  }

  async run(options: AutomatedRecommendationLoopOptions = {}) {
    const loop_run_id = buildLoopRunId(options.record_type ? 'auto_loop' : 'loop');
    const universe = options.universe === 'favorites' ? 'favorites' : 'market';
    const baseStyle = ['balanced', 'momentum', 'value', 'low_risk'].includes(options.style || '')
      ? options.style!
      : 'balanced';
    const loop_policy = await this.resolveLoopPolicy({
      username: options.username,
      portfolio_name: options.portfolio_name,
      initial_capital: options.initial_capital,
      force_new_portfolio: options.force_new_portfolio,
      enabled: options.use_outcome_feedback !== false,
      use_policy_version_feedback: options.use_policy_version_feedback !== false,
      policy_version_lookback_limit: toPositiveInt(
        options.policy_version_lookback_limit,
        120,
        1000
      ),
      universe,
      base_style: baseStyle,
      base_min_score: Number(options.min_score || 72),
      base_default_position_pct: Number(options.default_position_pct || 5),
      base_max_position_pct: Number(options.max_position_pct || 10),
      base_paper_trade_limit: toPositiveInt(options.paper_trade_limit, 3, 20),
      lookback_days: toPositiveInt(options.outcome_feedback_lookback_days, 365, 3650),
      min_closed_samples: toPositiveInt(options.outcome_feedback_min_closed_samples, 5, 100),
    });
    const environment_policy = await this.resolveEnvironmentPolicyFeedback({
      enabled: options.use_environment_policy_feedback !== false,
      username: options.username,
      portfolio_name: options.portfolio_name,
      initial_capital: options.initial_capital,
      force_new_portfolio: options.force_new_portfolio,
      loop_run_id,
      lookback_days: toPositiveInt(options.outcome_feedback_lookback_days, 365, 3650),
    });
    Object.assign(loop_policy, {
      environment_policy,
      environment_policy_snapshot_id: environment_policy.snapshot_id,
      environment_feedback_applied: environment_policy.applied,
      environment_feedback_reason: environment_policy.reason,
    });
    const candidateLimit = toPositiveInt(
      options.candidate_limit,
      universe === 'market' ? 30 : 20,
      100
    );
    const lookbackDays = toPositiveInt(options.lookback_days, 120, 360);
    const candidatePoolLimit = toPositiveInt(
      options.candidate_pool_limit,
      universe === 'market' ? Math.max(candidateLimit * 12, 240) : Math.max(candidateLimit * 6, 60),
      1000
    );
    const experiment_policy = await this.applyStrategyExperimentFeedback(loop_policy, {
      enabled: options.use_strategy_experiment_feedback !== false,
      username: options.username,
      universe,
      candidate_limit: toPositiveInt(
        options.strategy_experiment_limit,
        Math.min(candidateLimit, 12),
        50
      ),
      candidate_pool_limit: toPositiveInt(
        options.strategy_experiment_pool_limit,
        Math.min(candidatePoolLimit, 240),
        1000
      ),
      lookback_days: lookbackDays,
      min_bars: toPositiveInt(options.min_bars, 35, lookbackDays),
      exclude_st: options.exclude_st !== false,
      min_market_cap_yi:
        options.min_market_cap_yi === undefined ? 30 : Number(options.min_market_cap_yi),
      min_quality_delta: Number(options.strategy_experiment_min_quality_delta || 4),
    });
    Object.assign(loop_policy, experiment_policy);
    const style = loop_policy.effective_style;
    const strategyVariant = buildRecommendationStrategyVariant(loop_policy, {
      loop_run_id,
      source: 'automated_recommendation_loop',
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
    });
    Object.assign(loop_policy, {
      strategy_key: strategyVariant.strategy_key,
      strategy_bucket_label: strategyVariant.strategy_bucket_label,
      strategy_variant: strategyVariant,
    });
    const archiveLimit = toPositiveInt(options.archive_limit, candidateLimit, 100);
    const generated = await quantRecommendationService.generateRecommendations({
      universe,
      style,
      limit: candidateLimit,
      lookback_days: lookbackDays,
      min_bars: toPositiveInt(options.min_bars, 35, lookbackDays),
      include_trend: true,
      candidate_pool_limit: candidatePoolLimit,
      exclude_st: options.exclude_st !== false,
      min_market_cap_yi:
        options.min_market_cap_yi === undefined ? 30 : Number(options.min_market_cap_yi),
    });

    const rankedRecommendations = rankConsensusCandidates(
      generated.recommendations || [],
      loop_policy
    );
    (generated as any).recommendations = rankedRecommendations;
    (generated as any).consensus_ranked = true;
    (generated as any).consensus_overlap_count =
      loop_policy.strategy_experiment?.overlap_count || 0;
    const archiveCandidates = rankedRecommendations.slice(0, archiveLimit);
    const archive = await aiInvestmentSignalService.archiveQuantRecommendations({
      candidates: archiveCandidates,
      universe,
      style,
      as_of: generated.as_of,
      loop_run_id,
      strategy_key: strategyVariant.strategy_key,
      strategy_variant: strategyVariant,
      environment_policy,
      environment_policy_snapshot_id: environment_policy.snapshot_id,
    });

    const agent_analysis =
      options.submit_agent_analysis === false
        ? { enabled: false, submitted: [], failed: [], skipped: [] }
        : await this.submitAgentAnalysis({
            candidates: archiveCandidates,
            max_count: toPositiveInt(options.agent_max_count, universe === 'market' ? 5 : 3, 10),
            min_score: Math.max(
              Number(options.agent_min_score || options.min_score || 72),
              loop_policy.effective_min_score
            ),
            target_date:
              options.target_date ||
              moment(generated.as_of || undefined)
                .tz('Asia/Shanghai')
                .format('YYYY-MM-DD'),
            task_label: options.task_label || options.record_type || '全市场荐股闭环',
            agent_session: options.agent_session || 'close',
            auto_paper_trade:
              options.agent_auto_paper_trade !== false && Boolean(options.run_paper_trading),
            paper_trade_username: options.username,
            paper_trade_portfolio_name: options.portfolio_name,
            paper_trade_initial_capital: options.initial_capital,
            paper_trade_force_new_portfolio: options.force_new_portfolio,
            paper_trade_min_score: loop_policy.effective_min_score,
            paper_trade_max_positions: toPositiveInt(options.max_positions, 8, 30),
            paper_trade_default_position_pct: loop_policy.effective_default_position_pct,
            paper_trade_max_position_pct: loop_policy.effective_max_position_pct,
            paper_trade_min_trade_amount: Number(options.min_trade_amount || 3000),
            execution_log_id: options.execution_log_id,
            loop_run_id,
            strategy_key: strategyVariant.strategy_key,
            strategy_variant: strategyVariant,
            environment_policy,
            environment_policy_snapshot_id: environment_policy.snapshot_id,
            universe,
            style,
          });

    let verification: any = null;
    if (options.verify_signals !== false) {
      verification = await aiInvestmentSignalService.verifySignals({
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
        limit: Math.max(archive.total || 0, 50),
      });
      (archive as any).verification = verification;
    }

    let paper_trading: any = null;
    let trade_outcomes: any = null;
    if (options.run_paper_trading) {
      paper_trading = await paperTradingAutomationService.runAutoSync({
        username: options.username,
        portfolio_name: options.portfolio_name,
        initial_capital: options.initial_capital,
        force_new_portfolio: options.force_new_portfolio,
        refresh_recommendations: false,
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
        limit: loop_policy.effective_paper_trade_limit,
        scan_limit: toPositiveInt(
          options.paper_trade_scan_limit,
          Math.max(archive.total, 100),
          500
        ),
        min_score: loop_policy.effective_min_score,
        max_positions: toPositiveInt(options.max_positions, 8, 30),
        default_position_pct: loop_policy.effective_default_position_pct,
        max_position_pct: loop_policy.effective_max_position_pct,
        min_trade_amount: Number(options.min_trade_amount || 3000),
        allowed_risk_levels: ['low', 'medium'],
        require_action_buy: true,
        use_attribution_feedback: true,
        use_profit_gate: options.use_profit_gate !== false,
        profit_gate_horizon: options.profit_gate_horizon || '5d',
        profit_gate_min_samples: toPositiveInt(options.profit_gate_min_samples, 5, 100),
        profit_gate_min_quality_score: Number(options.profit_gate_min_quality_score || 45),
        profit_gate_allow_deprioritized: false,
        use_entry_risk_guard: options.use_entry_risk_guard !== false,
        max_daily_new_positions: toPositiveInt(options.max_daily_new_positions, 3, 20),
        max_daily_new_exposure_pct: Number(options.max_daily_new_exposure_pct || 12),
        max_total_exposure_pct: Number(options.max_total_exposure_pct || 60),
        max_industry_exposure_pct: Number(options.max_industry_exposure_pct || 25),
        min_avg_turnover_yuan: Number(options.min_avg_turnover_yuan || 30000000),
        cooldown_days_after_loss: toPositiveInt(options.cooldown_days_after_loss, 12, 120),
        block_limit_up: options.block_limit_up !== false,
        block_limit_down: options.block_limit_down !== false,
        block_suspended: options.block_suspended !== false,
        signal_ids: archive.signal_ids,
        external_environment_policy: environment_policy,
        environment_policy_snapshot_id: environment_policy.snapshot_id,
        dry_run: Boolean(options.dry_run),
        report_to_feishu: false,
      });
      (paper_trading as any).consensus_executed = Array.isArray(paper_trading.trades)
        ? paper_trading.trades.filter(
            (item: any) => item.status === 'executed' && Number(item.consensus_count || 0) > 1
          ).length
        : 0;
      (paper_trading as any).consensus_planned = Array.isArray(paper_trading.trades)
        ? paper_trading.trades.filter(
            (item: any) => item.status === 'planned' && Number(item.consensus_count || 0) > 1
          ).length
        : 0;
      (paper_trading as any).consensus_top_trades = Array.isArray(paper_trading.trades)
        ? paper_trading.trades
            .filter((item: any) => Number(item.consensus_count || 0) > 1)
            .slice(0, 5)
            .map((item: any) => ({
              symbol: item.symbol,
              name: item.name,
              score: item.score,
              original_score: item.original_score,
              consensus_count: item.consensus_count,
              consensus_bonus: item.consensus_bonus,
              target_position_pct: item.target_position_pct,
              amount: item.amount,
              status: item.status,
            }))
        : [];
      (paper_trading as any).skip_reason_summary = paper_trading.skip_reason_summary || {
        total: paper_trading.skipped || 0,
        top_reasons: [],
        categories: {},
      };

      trade_outcomes = await recommendationTradeOutcomeService.refreshPortfolioOutcomes({
        username: options.username,
        portfolio_name: options.portfolio_name,
        initial_capital: options.initial_capital,
        force_new_portfolio: options.force_new_portfolio,
        include_open: true,
        lookback_days: 180,
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
        loop_run_id,
        report_to_feishu: false,
      });
    }

    const quality_report = await aiInvestmentSignalService.getSignalQualityReport({
      source_type: AISignalSourceType.QUANT_RECOMMENDATION,
      horizon: options.profit_gate_horizon || '5d',
      lookback_days: 60,
      min_samples: toPositiveInt(options.profit_gate_min_samples, 5, 100),
      limit: 5000,
      verify_before_report: false,
      auto_repair_missing_data: false,
      report_to_feishu: false,
    });

    const result = {
      loop_run_id,
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      universe,
      style,
      loop_policy,
      generated,
      archive,
      agent_analysis,
      verification,
      paper_trading,
      trade_outcomes: trade_outcomes
        ? {
            refreshed: trade_outcomes.refreshed,
            created_or_updated: trade_outcomes.created_or_updated,
            failed: trade_outcomes.failed,
            summary: trade_outcomes.dashboard?.summary,
            feedback: trade_outcomes.dashboard?.feedback,
            consensus_groups: trade_outcomes.dashboard?.groups?.by_consensus,
          }
        : undefined,
      quality_report: {
        overview: quality_report.overview,
        best_segments: quality_report.best_segments,
        worst_segments: quality_report.worst_segments,
      },
    };

    const policy_snapshot = await recommendationLoopPolicySnapshotService.recordFromLoopResult(
      result,
      {
        username: options.username,
        execution_log_id: options.execution_log_id,
        record_type: options.record_type || '全市场荐股闭环',
      }
    );
    (result as any).policy_snapshot = policy_snapshot
      ? {
          id: policy_snapshot.id,
          loop_run_id: policy_snapshot.loop_run_id,
          generated_at: policy_snapshot.generated_at,
          effective_style: policy_snapshot.effective_style,
          effective_min_score: policy_snapshot.effective_min_score,
          effective_default_position_pct: policy_snapshot.effective_default_position_pct,
        }
      : null;

    if (options.report_to_feishu !== false) {
      await feishuTaskReportService.reportAutomatedRecommendationLoop(result, {
        record_type: options.record_type || '全市场荐股闭环',
      });
    }

    logger.info(
      `荐股闭环完成：${universe}/${style} 候选 ${generated.analyzed_candidates}/${
        generated.total_candidates
      }，归档 ${archive.total}，模拟盘 ${
        paper_trading?.executed ?? paper_trading?.planned ?? 0
      }，Agent提交 ${agent_analysis.submitted?.length || 0}`
    );

    return result;
  }

  private async submitAgentAnalysis(options: {
    candidates: any[];
    max_count: number;
    min_score: number;
    target_date: string;
    task_label: string;
    agent_session: string;
    auto_paper_trade?: boolean;
    paper_trade_username?: string;
    paper_trade_portfolio_name?: string;
    paper_trade_initial_capital?: number;
    paper_trade_force_new_portfolio?: boolean;
    paper_trade_min_score?: number;
    paper_trade_max_positions?: number;
    paper_trade_default_position_pct?: number;
    paper_trade_max_position_pct?: number;
    paper_trade_min_trade_amount?: number;
    execution_log_id?: number;
    loop_run_id?: string;
    strategy_key?: string;
    strategy_variant?: any;
    environment_policy?: any;
    environment_policy_snapshot_id?: string;
    universe: string;
    style: string;
  }) {
    const candidates = (options.candidates || [])
      .filter(candidate => {
        const score = Number(candidate?.score || 0);
        return (
          candidate?.symbol &&
          score >= options.min_score &&
          ['buy', 'watch'].includes(String(candidate.action || '').toLowerCase())
        );
      })
      .slice(0, options.max_count);
    const submitted: any[] = [];
    const failed: any[] = [];
    const skipped = (options.candidates || [])
      .filter(candidate => !candidates.some(item => item.symbol === candidate.symbol))
      .slice(0, 20)
      .map(candidate => ({
        symbol: candidate.symbol,
        name: candidate.name,
        score: candidate.score,
        action: candidate.action,
        reason:
          Number(candidate?.score || 0) < options.min_score
            ? `评分低于 ${options.min_score}`
            : `动作 ${candidate.action || '-'} 不需要深度复核`,
      }));

    for (const candidate of candidates) {
      try {
        const response = await aiAdvisorService.analyzeStock(
          candidate.symbol,
          options.target_date,
          true
        );
        if (!response?.task_id) {
          failed.push({
            symbol: candidate.symbol,
            name: candidate.name,
            error: 'TradingAgents 未返回 task_id',
          });
          continue;
        }

        await aiPollingQueue.add(
          {
            taskId: response.task_id,
            symbol: candidate.symbol,
            name: candidate.name,
            executionLogId: options.execution_log_id,
            loopRunId: options.loop_run_id,
            taskLabel: options.task_label,
            quant_score: candidate.score,
            quant_factors: candidate.factors,
            quant_reasons: candidate.reasons,
            quant_warnings: candidate.warnings,
            recommendation_style: options.style,
            recommendation_source: options.universe,
            strategy_key: options.strategy_key,
            strategy_variant: {
              ...(options.strategy_variant || {}),
              market_environment: candidate.market_environment,
              environment_policy: options.environment_policy,
              environment_policy_snapshot_id: options.environment_policy_snapshot_id,
            },
            market_environment: candidate.market_environment,
            environment_policy: options.environment_policy,
            environment_policy_snapshot_id: options.environment_policy_snapshot_id,
            agent_session: options.agent_session,
            auto_paper_trade: options.auto_paper_trade,
            paper_trade_username: options.paper_trade_username,
            paper_trade_portfolio_name: options.paper_trade_portfolio_name,
            paper_trade_initial_capital: options.paper_trade_initial_capital,
            paper_trade_force_new_portfolio: options.paper_trade_force_new_portfolio,
            paper_trade_min_score: options.paper_trade_min_score,
            paper_trade_max_positions: options.paper_trade_max_positions,
            paper_trade_default_position_pct: options.paper_trade_default_position_pct,
            paper_trade_max_position_pct: options.paper_trade_max_position_pct,
            paper_trade_min_trade_amount: options.paper_trade_min_trade_amount,
            current_price: candidate.current_price,
            price_change_pct: candidate.change_percent,
            data_quality_score: candidate.data_quality_score,
            data_quality_bucket: candidate.data_quality_bucket,
            data_quality: candidate.data_quality,
          },
          {
            jobId: `auto-loop-ai-${options.execution_log_id || 'manual'}-${response.task_id}`,
            attempts: 10,
            backoff: { type: 'fixed', delay: 3 * 60 * 1000 },
          }
        );

        submitted.push({
          symbol: candidate.symbol,
          name: candidate.name,
          score: candidate.score,
          action: candidate.action,
          task_id: response.task_id,
          status: response.status,
          current_price: candidate.current_price,
          price_change_pct: candidate.change_percent,
          data_quality_score: candidate.data_quality_score,
          data_quality_bucket: candidate.data_quality_bucket,
          auto_paper_trade: Boolean(options.auto_paper_trade),
        });
      } catch (error: any) {
        failed.push({
          symbol: candidate.symbol,
          name: candidate.name,
          error: error.message,
        });
      }
    }

    return {
      enabled: true,
      target_date: options.target_date,
      task_label: options.task_label,
      agent_session: options.agent_session,
      auto_paper_trade: Boolean(options.auto_paper_trade),
      min_score: options.min_score,
      max_count: options.max_count,
      submitted,
      failed,
      skipped,
    };
  }
}

export const automatedRecommendationLoopService = new AutomatedRecommendationLoopService();
