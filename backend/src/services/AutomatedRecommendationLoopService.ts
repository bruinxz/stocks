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

export interface AutomatedRecommendationLoopOptions {
  username?: string;
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
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const normalized = Math.floor(parsed);
  return max ? Math.min(normalized, max) : normalized;
}

class AutomatedRecommendationLoopService {
  private async resolveLoopPolicy(options: {
    username?: string;
    enabled: boolean;
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
    };

    if (!options.enabled) return basePolicy;

    try {
      const dashboard = await recommendationTradeOutcomeService.getDashboard({
        username: options.username,
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
        shouldUseBestStyle || shouldAvoidBaseStyle ? String(bestStyle?.key || 'low_risk') : options.base_style;
      const coldStart = closedSamples < options.min_closed_samples;
      const effectiveMinScore = coldStart
        ? options.base_min_score
        : Math.min(94, Math.max(options.base_min_score, feedbackMinScore));
      const boundedMultiplier = coldStart
        ? Math.min(positionMultiplier || 1, 0.75)
        : Math.min(1.2, Math.max(0.35, positionMultiplier || 1));
      const effectiveDefaultPositionPct = Math.max(
        1,
        Math.min(options.base_max_position_pct, options.base_default_position_pct * boundedMultiplier)
      );
      const effectiveMaxPositionPct = Math.max(
        effectiveDefaultPositionPct,
        Math.min(options.base_max_position_pct, options.base_max_position_pct * Math.max(0.45, boundedMultiplier))
      );
      const effectivePaperTradeLimit =
        coldStart || avgExcess < -1 || excessWinRate < 45
          ? Math.max(1, Math.min(options.base_paper_trade_limit, 2))
          : avgExcess > 2 && excessWinRate >= 55
            ? Math.min(5, options.base_paper_trade_limit + 1)
            : options.base_paper_trade_limit;

      return {
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
    } catch (error: any) {
      logger.warn(`读取全市场荐股闭环自适应策略失败，沿用基础参数: ${error?.message || error}`);
      return {
        ...basePolicy,
        reason: `收益闭环自适应读取失败，沿用基础参数：${error?.message || error}`,
      };
    }
  }

  async run(options: AutomatedRecommendationLoopOptions = {}) {
    const universe = options.universe === 'favorites' ? 'favorites' : 'market';
    const baseStyle = ['balanced', 'momentum', 'value', 'low_risk'].includes(options.style || '')
      ? options.style!
      : 'balanced';
    const loop_policy = await this.resolveLoopPolicy({
      username: options.username,
      enabled: options.use_outcome_feedback !== false,
      base_style: baseStyle,
      base_min_score: Number(options.min_score || 72),
      base_default_position_pct: Number(options.default_position_pct || 5),
      base_max_position_pct: Number(options.max_position_pct || 10),
      base_paper_trade_limit: toPositiveInt(options.paper_trade_limit, 3, 20),
      lookback_days: toPositiveInt(options.outcome_feedback_lookback_days, 365, 3650),
      min_closed_samples: toPositiveInt(options.outcome_feedback_min_closed_samples, 5, 100),
    });
    const style = loop_policy.effective_style;
    const candidateLimit = toPositiveInt(
      options.candidate_limit,
      universe === 'market' ? 30 : 20,
      100
    );
    const archiveLimit = toPositiveInt(options.archive_limit, candidateLimit, 100);
    const lookbackDays = toPositiveInt(options.lookback_days, 120, 360);
    const generated = await quantRecommendationService.generateRecommendations({
      universe,
      style,
      limit: candidateLimit,
      lookback_days: lookbackDays,
      min_bars: toPositiveInt(options.min_bars, 35, lookbackDays),
      include_trend: true,
      candidate_pool_limit: toPositiveInt(
        options.candidate_pool_limit,
        universe === 'market'
          ? Math.max(candidateLimit * 12, 240)
          : Math.max(candidateLimit * 6, 60),
        1000
      ),
      exclude_st: options.exclude_st !== false,
      min_market_cap_yi:
        options.min_market_cap_yi === undefined ? 30 : Number(options.min_market_cap_yi),
    });

    const archiveCandidates = (generated.recommendations || []).slice(0, archiveLimit);
    const archive = await aiInvestmentSignalService.archiveQuantRecommendations({
      candidates: archiveCandidates,
      universe,
      style,
      as_of: generated.as_of,
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
            auto_paper_trade: options.agent_auto_paper_trade !== false && Boolean(options.run_paper_trading),
            paper_trade_username: options.username,
            paper_trade_min_score: loop_policy.effective_min_score,
            paper_trade_max_positions: toPositiveInt(options.max_positions, 8, 30),
            paper_trade_default_position_pct: loop_policy.effective_default_position_pct,
            paper_trade_max_position_pct: loop_policy.effective_max_position_pct,
            paper_trade_min_trade_amount: Number(options.min_trade_amount || 3000),
            execution_log_id: options.execution_log_id,
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
        dry_run: Boolean(options.dry_run),
        report_to_feishu: false,
      });

      trade_outcomes = await recommendationTradeOutcomeService.refreshPortfolioOutcomes({
        username: options.username,
        include_open: true,
        lookback_days: 180,
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
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
          }
        : undefined,
      quality_report: {
        overview: quality_report.overview,
        best_segments: quality_report.best_segments,
        worst_segments: quality_report.worst_segments,
      },
    };

    const policy_snapshot = await recommendationLoopPolicySnapshotService.recordFromLoopResult(result, {
      username: options.username,
      execution_log_id: options.execution_log_id,
      record_type: options.record_type || '全市场荐股闭环',
    });
    (result as any).policy_snapshot = policy_snapshot
      ? {
          id: policy_snapshot.id,
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
      `荐股闭环完成：${universe}/${style} 候选 ${generated.analyzed_candidates}/${generated.total_candidates}，归档 ${archive.total}，模拟盘 ${
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
    paper_trade_min_score?: number;
    paper_trade_max_positions?: number;
    paper_trade_default_position_pct?: number;
    paper_trade_max_position_pct?: number;
    paper_trade_min_trade_amount?: number;
    execution_log_id?: number;
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
            taskLabel: options.task_label,
            quant_score: candidate.score,
            quant_factors: candidate.factors,
            quant_reasons: candidate.reasons,
            quant_warnings: candidate.warnings,
            recommendation_style: options.style,
            recommendation_source: options.universe,
            agent_session: options.agent_session,
            auto_paper_trade: options.auto_paper_trade,
            paper_trade_username: options.paper_trade_username,
            paper_trade_min_score: options.paper_trade_min_score,
            paper_trade_max_positions: options.paper_trade_max_positions,
            paper_trade_default_position_pct: options.paper_trade_default_position_pct,
            paper_trade_max_position_pct: options.paper_trade_max_position_pct,
            paper_trade_min_trade_amount: options.paper_trade_min_trade_amount,
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
