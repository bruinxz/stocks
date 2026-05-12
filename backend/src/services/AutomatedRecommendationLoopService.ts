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
  use_profit_gate?: boolean;
  profit_gate_horizon?: string;
  profit_gate_min_samples?: number;
  profit_gate_min_quality_score?: number;
  submit_agent_analysis?: boolean;
  agent_max_count?: number;
  agent_min_score?: number;
  agent_session?: string;
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
  async run(options: AutomatedRecommendationLoopOptions = {}) {
    const universe = options.universe === 'favorites' ? 'favorites' : 'market';
    const style = ['balanced', 'momentum', 'value', 'low_risk'].includes(options.style || '')
      ? options.style!
      : 'balanced';
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
            min_score: Number(options.agent_min_score || options.min_score || 72),
            target_date:
              options.target_date ||
              moment(generated.as_of || undefined)
                .tz('Asia/Shanghai')
                .format('YYYY-MM-DD'),
            task_label: options.task_label || options.record_type || '全市场荐股闭环',
            agent_session: options.agent_session || 'close',
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
        limit: toPositiveInt(options.paper_trade_limit, 3, 20),
        scan_limit: toPositiveInt(
          options.paper_trade_scan_limit,
          Math.max(archive.total, 100),
          500
        ),
        min_score: Number(options.min_score || 72),
        max_positions: toPositiveInt(options.max_positions, 8, 30),
        default_position_pct: Number(options.default_position_pct || 5),
        max_position_pct: Number(options.max_position_pct || 10),
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
      min_score: options.min_score,
      max_count: options.max_count,
      submitted,
      failed,
      skipped,
    };
  }
}

export const automatedRecommendationLoopService = new AutomatedRecommendationLoopService();
