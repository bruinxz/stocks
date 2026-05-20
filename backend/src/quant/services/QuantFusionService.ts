import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { QuantSignal } from '../../models/QuantSignal';
import {
  AIInvestmentSignal,
  AISignalDecision,
  AISignalSourceType,
} from '../../models/AIInvestmentSignal';
import { quantSignalService } from './QuantSignalService';
import { aiAdvisorService } from '../../services/AIAdvisorService';
import { aiPollingQueue } from '../../jobs/aiPollingQueue';
import { paperTradingAutomationService } from '../../services/PaperTradingAutomationService';
import { paperTradingRiskProfileService } from '../../services/PaperTradingRiskProfileService';
import { normalizeSymbol } from '../../utils/stockSymbol';
import { logger } from '../../utils/logger';
import { round } from '../engine/QuantMath';
import { QuantUniverse } from '../types/QuantTypes';
import { QuantStrategyWeight } from '../../models/QuantStrategyWeight';
import { quantStrategyFeedbackService } from './QuantStrategyFeedbackService';
import { recommendationLoopPolicySnapshotService } from '../../services/RecommendationLoopPolicySnapshotService';
import { riskThresholdStabilityService } from '../../services/RiskThresholdStabilityService';
import { quantStrategyExperimentService } from './QuantStrategyExperimentService';
import { quantStrategyParamVersionService } from './QuantStrategyParamVersionService';
import { stockFactorService } from '../../data/services/StockFactorService';
import { feishuBotWebhookService } from '../../services/FeishuBotWebhookService';
import {
  AUTONOMOUS_PORTFOLIO_NAME,
  QUANT_AGENT_FUSION_PORTFOLIO_NAME,
  QUANT_ONLY_PORTFOLIO_NAME,
  PARAM_EXPERIMENT_PORTFOLIO_NAME,
} from '../../services/PaperTradingDashboardService';

type QuantPipelineMode = 'archive_only' | 'agent_review' | 'paper_trade';

export interface QuantDailyPipelineOptions {
  user_id?: number;
  username?: string;
  trade_date?: string;
  target_date?: string;
  universe?: QuantUniverse;
  symbols?: string[];
  strategy_keys?: string[];
  lookback_days?: number;
  candidate_limit?: number;
  min_score?: number;
  archive_limit?: number;
  max_industry_candidates?: number;
  max_strategy_candidates?: number;
  submit_agent_analysis?: boolean;
  agent_max_count?: number;
  agent_min_score?: number;
  agent_session?: string;
  agent_auto_paper_trade?: boolean;
  run_paper_trading?: boolean;
  dry_run?: boolean;
  paper_trade_limit?: number;
  paper_trade_scan_limit?: number;
  max_positions?: number;
  default_position_pct?: number;
  max_position_pct?: number;
  use_entry_risk_guard?: boolean;
  max_daily_new_positions?: number;
  max_daily_new_exposure_pct?: number;
  max_total_exposure_pct?: number;
  max_industry_exposure_pct?: number;
  min_cash_reserve_pct?: number;
  max_portfolio_drawdown_pct?: number;
  max_single_stock_volatility_pct?: number;
  max_position_correlation?: number;
  max_portfolio_var_pct?: number;
  cooldown_days_after_loss?: number;
  min_avg_turnover_yuan?: number;
  block_limit_up?: boolean;
  block_limit_down?: boolean;
  block_suspended?: boolean;
  risk_profile_gate?: Record<string, any>;
  min_trade_amount?: number;
  portfolio_name?: string;
  initial_capital?: number;
  force_new_portfolio?: boolean;
  task_label?: string;
  execution_log_id?: number;
  report_to_feishu?: boolean;
  notify_to_feishu_bot?: boolean;
  params_by_strategy?: Record<string, Record<string, any>>;
  use_experiment_params?: boolean;
  experiment_param_policy?: Record<string, any>;
  refresh_realtime_quotes?: boolean;
  quote_sync_limit?: number;
  sync_factors_before_scan?: boolean;
  factor_sync_scope?: 'market' | 'favorites' | 'custom';
  factor_sync_limit?: number;
  factor_sync_skip_if_coverage_rate_gte?: number;
}

interface QuantFusionCandidate {
  symbol: string;
  name?: string;
  trade_date: string;
  signal: string;
  decision: string;
  action: 'buy' | 'watch' | 'hold' | 'avoid';
  action_label: string;
  score: number;
  quant_score: number;
  confidence: number;
  current_price?: number;
  price_change_pct?: number;
  stop_loss_price?: number;
  take_profit_price?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  suggested_position_pct: number;
  strategy_allocation_pct?: number;
  strategy_allocation_amount?: number;
  strategy_max_single_trade_pct?: number;
  strategy_max_single_trade_amount?: number;
  risk_level: 'low' | 'medium' | 'high';
  strategy_key: string;
  strategy_name?: string;
  strategy_keys: string[];
  consensus_count: number;
  consensus_bonus: number;
  quant_signal_ids: number[];
  reasons: string[];
  risk_flags: string[];
  factors: Record<string, any>;
  trace_url?: string;
}

function getChinaDate(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const normalized = Math.floor(parsed);
  return max ? Math.min(normalized, max) : normalized;
}

function roundNumber(value: any, digits = 2): number {
  const parsed = safeNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(parsed * base) / base;
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function splitReasonText(value: any): string[] {
  if (!value) return [];
  return String(value)
    .split(/[；;\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function compactFactors(raw_factors: any): Array<{ name: string; value: any }> {
  if (!raw_factors || typeof raw_factors !== 'object' || Array.isArray(raw_factors)) return [];
  return Object.entries(raw_factors)
    .slice(0, 12)
    .map(([name, value]) => ({ name, value }));
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function regimeBucketAdjustment(
  buckets: any[],
  key: any,
  dimension: 'market' | 'industry'
): { adjustment: number; matched?: any; reason?: string } {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey || normalizedKey === 'unknown' || !Array.isArray(buckets)) {
    return { adjustment: 0 };
  }
  const matched = buckets.find(item => String(item?.key || '') === normalizedKey);
  if (!matched || safeNumber(matched.closed_count, 0) < 3) return { adjustment: 0, matched };

  const excess = safeNumber(matched.avg_excess_return_pct, 0);
  const winRate = safeNumber(matched.excess_win_rate, 50);
  const sampleConfidence = Math.min(1, safeNumber(matched.closed_count, 0) / 12);
  const rawAdjustment =
    Math.max(-3.5, Math.min(3.5, excess * 0.45 + (winRate - 50) * 0.045)) * sampleConfidence;
  const adjustment = round(dimension === 'market' ? rawAdjustment : rawAdjustment * 0.65, 2);
  if (Math.abs(adjustment) < 0.1) return { adjustment: 0, matched };
  return {
    adjustment,
    matched,
    reason: `${dimension === 'market' ? '市场' : '行业'}环境 ${
      matched.label || normalizedKey
    }：闭环 ${matched.closed_count} 笔，平均超额 ${
      matched.avg_excess_return_pct ?? '--'
    }%，调整 ${adjustment}`,
  };
}

export class QuantFusionService {
  async runDailyPipeline(options: QuantDailyPipelineOptions = {}) {
    const trade_date = options.trade_date || getChinaDate();
    const archiveLimit = toPositiveInt(options.archive_limit, 30, 200);
    const agentMaxCount = toPositiveInt(options.agent_max_count, 5, 20);
    const agentMinScore = safeNumber(options.agent_min_score, 72);
    const requestedPortfolioName = options.portfolio_name;
    const useDefaultPortfolioFamily =
      !requestedPortfolioName || requestedPortfolioName === AUTONOMOUS_PORTFOLIO_NAME;
    const pureQuantPortfolioName = useDefaultPortfolioFamily
      ? QUANT_ONLY_PORTFOLIO_NAME
      : requestedPortfolioName;
    const agentFusionPortfolioName = useDefaultPortfolioFamily
      ? QUANT_AGENT_FUSION_PORTFOLIO_NAME
      : requestedPortfolioName;
    const factorSync =
      options.sync_factors_before_scan === false
        ? null
        : await stockFactorService
            .syncDerivedFactors({
              scope:
                options.factor_sync_scope ||
                (options.symbols?.length
                  ? 'custom'
                  : options.universe === 'favorites'
                  ? 'favorites'
                  : 'market'),
              symbols: options.symbols,
              limit: toPositiveInt(
                options.factor_sync_limit,
                Math.max(options.candidate_limit || 180, 180),
                1500
              ),
              as_of: trade_date,
              user_id: options.user_id,
              skip_if_coverage_rate_gte: safeNumber(
                options.factor_sync_skip_if_coverage_rate_gte,
                92
              ),
            })
            .catch(error => {
              logger.warn(`量化扫描前因子落盘失败，降级使用已有因子: ${error?.message || error}`);
              return {
                generated_at: new Date().toISOString(),
                skipped: true,
                error: error?.message || String(error),
                message: '量化扫描前因子落盘失败，本轮继续使用已有因子快照。',
              };
            });
    const experimentParamSuggestion =
      options.use_experiment_params === false
        ? null
        : await quantStrategyExperimentService
            .getParamsByStrategySuggestion(options.experiment_param_policy || {})
            .catch(error => {
              logger.warn(
                `读取量化策略实验参数建议失败，降级使用任务参数: ${error?.message || error}`
              );
              return null;
            });
    const paramVersionRefresh = await quantStrategyParamVersionService
      .refreshVersionsFromExperiments({
        suggestions: experimentParamSuggestion,
        manual_params_by_strategy: options.params_by_strategy,
        use_experiment_params: options.use_experiment_params !== false,
      })
      .catch(error => {
        logger.warn(`刷新量化策略参数版本失败，降级继续扫描: ${error?.message || error}`);
        return null;
      });
    const activeScanParams = await quantStrategyParamVersionService
      .getActiveParamsForScan({
        strategy_keys: options.strategy_keys,
        include_grid_search: true,
        include_experiment: options.use_experiment_params !== false,
        manual_params_by_strategy: options.params_by_strategy,
      })
      .catch(error => {
        logger.warn(`读取开盘扫描参数版本失败，降级使用实验/任务参数: ${error?.message || error}`);
        return null;
      });
    const effectiveParamsByStrategy = {
      ...(experimentParamSuggestion?.recommended_params_by_strategy || {}),
      ...(paramVersionRefresh?.recommended_params_by_strategy || {}),
      ...(activeScanParams?.recommended_params_by_strategy || {}),
      ...(options.params_by_strategy || {}),
    };
    const effectiveParamVersionByStrategy = {
      ...(paramVersionRefresh?.adopted_param_version_by_strategy || {}),
      ...(activeScanParams?.adopted_param_version_by_strategy || {}),
    };
    const generated = await quantSignalService.generateSignals({
      trade_date,
      universe: options.universe || 'market',
      user_id: options.user_id,
      symbols: options.symbols,
      strategy_keys: options.strategy_keys,
      lookback_days: options.lookback_days || 180,
      candidate_limit: options.candidate_limit || 180,
      min_score: options.min_score ?? 55,
      persist: true,
      params_by_strategy: effectiveParamsByStrategy,
      param_version_by_strategy: effectiveParamVersionByStrategy,
      refresh_realtime_quotes: options.refresh_realtime_quotes !== false,
      quote_sync_limit: options.quote_sync_limit || options.candidate_limit || 180,
    });
    const paramValidationRefresh = await quantStrategyParamVersionService
      .createPendingValidationsFromSignals({
        trade_date,
        strategy_keys: options.strategy_keys,
        limit: options.candidate_limit || 500,
      })
      .then(async create => ({
        create,
        refresh: await quantStrategyParamVersionService.refreshValidationReturns({
          limit: 1200,
          auto_sync_benchmark: false,
        }),
      }))
      .catch(error => {
        logger.warn(`刷新量化策略参数 A/B 收益验证失败，降级继续闭环: ${error?.message || error}`);
        return null;
      });
    const paramLifecycle = await quantStrategyParamVersionService
      .evaluateAndApplyLifecycle({ dry_run: false, limit: 5000 })
      .catch(error => {
        logger.warn(`评估量化参数冠军/回滚状态机失败，降级继续闭环: ${error?.message || error}`);
        return null;
      });

    const candidates = await this.buildFusionCandidates({
      trade_date,
      strategy_keys: options.strategy_keys,
      min_score: options.min_score ?? 55,
      limit: Math.max(archiveLimit * 4, 120),
    });

    const diversifiedSelection = this.selectDiversifiedCandidates(candidates, archiveLimit, {
      max_industry_candidates: options.max_industry_candidates,
      max_strategy_candidates: options.max_strategy_candidates,
    });
    const selectedCandidates = diversifiedSelection.selected;
    const archive = await this.archiveFusionCandidates(selectedCandidates, options);
    const thresholdSuggestion = await this.getRiskThresholdSuggestion(options);
    const preTradeRiskProfile =
      options.run_paper_trading && options.user_id
        ? await paperTradingRiskProfileService
            .getRiskProfile({
              user_id: options.user_id,
              portfolio_name: pureQuantPortfolioName,
              min_cash_reserve_pct: options.min_cash_reserve_pct,
              max_portfolio_drawdown_pct: options.max_portfolio_drawdown_pct,
              max_total_exposure_pct: options.max_total_exposure_pct,
              max_industry_exposure_pct: options.max_industry_exposure_pct,
              max_position_correlation: options.max_position_correlation,
              max_portfolio_var_pct: options.max_portfolio_var_pct,
              max_single_stock_volatility_pct: options.max_single_stock_volatility_pct,
            })
            .catch(error => {
              logger.warn(`量化闭环读取交易前组合风险画像失败: ${error?.message || error}`);
              return null;
            })
        : null;
    const riskProfileGate = this.buildRiskProfileGate(preTradeRiskProfile, {
      requested_trade_limit: toPositiveInt(options.paper_trade_limit, 3, 20),
      requested_default_position_pct: safeNumber(options.default_position_pct, 5),
      requested_max_position_pct: safeNumber(options.max_position_pct, 10),
      suggested_limits: thresholdSuggestion,
    });

    const agentAnalysis = await this.submitAgentReview(archive.candidates, archive.signal_records, {
      ...options,
      trade_date,
      target_date: options.target_date || trade_date,
      agent_max_count: agentMaxCount,
      agent_min_score: agentMinScore,
    });

    let paperTrading: any = null;
    let paramExperimentPaperTrading: any = null;
    if (options.run_paper_trading) {
      paperTrading = await paperTradingAutomationService.autoBuyFromSignals({
        user_id: options.user_id,
        username: options.username,
        portfolio_name: pureQuantPortfolioName,
        initial_capital: options.initial_capital,
        force_new_portfolio: options.force_new_portfolio,
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
        signal_ids: archive.signal_ids,
        limit: toPositiveInt(options.paper_trade_limit, 3, 20),
        scan_limit: toPositiveInt(
          options.paper_trade_scan_limit,
          Math.max(archive.signal_ids.length, 30),
          300
        ),
        min_score: agentMinScore,
        max_positions: toPositiveInt(options.max_positions, 8, 30),
        default_position_pct: safeNumber(options.default_position_pct, 5),
        max_position_pct: safeNumber(options.max_position_pct, 10),
        min_trade_amount: safeNumber(options.min_trade_amount, 3000),
        allowed_risk_levels: ['low', 'medium'],
        require_action_buy: true,
        dry_run: Boolean(options.dry_run),
        report_to_feishu: Boolean(options.report_to_feishu),
        ignore_profit_gate_for_forced_signals: true,
        use_profit_gate: true,
        use_outcome_feedback: true,
        use_entry_risk_guard: options.use_entry_risk_guard,
        max_daily_new_positions: options.max_daily_new_positions,
        max_daily_new_exposure_pct: options.max_daily_new_exposure_pct,
        max_total_exposure_pct: options.max_total_exposure_pct,
        max_industry_exposure_pct: options.max_industry_exposure_pct,
        min_cash_reserve_pct: options.min_cash_reserve_pct,
        max_portfolio_drawdown_pct: options.max_portfolio_drawdown_pct,
        max_single_stock_volatility_pct: options.max_single_stock_volatility_pct,
        max_position_correlation: options.max_position_correlation,
        max_portfolio_var_pct: options.max_portfolio_var_pct,
        min_avg_turnover_yuan: options.min_avg_turnover_yuan,
        cooldown_days_after_loss: options.cooldown_days_after_loss,
        block_limit_up: options.block_limit_up,
        block_limit_down: options.block_limit_down,
        block_suspended: options.block_suspended,
        risk_profile_gate: {
          ...riskProfileGate,
          ...(options.risk_profile_gate || {}),
        },
      });
      const lifecycleSummary = paramLifecycle?.lifecycle?.summary || {};
      const candidateLikeCount =
        Number(lifecycleSummary.promotion_count || 0) +
        Number(lifecycleSummary.observation_count || 0);
      if (candidateLikeCount > 0 || Object.keys(effectiveParamVersionByStrategy).length > 0) {
        paramExperimentPaperTrading = await paperTradingAutomationService
          .autoBuyFromSignals({
            user_id: options.user_id,
            username: options.username,
            portfolio_name: PARAM_EXPERIMENT_PORTFOLIO_NAME,
            initial_capital: options.initial_capital,
            force_new_portfolio: options.force_new_portfolio,
            source_type: AISignalSourceType.QUANT_RECOMMENDATION,
            signal_ids: archive.signal_ids,
            limit: Math.min(2, toPositiveInt(options.paper_trade_limit, 3, 20)),
            scan_limit: toPositiveInt(
              options.paper_trade_scan_limit,
              Math.max(archive.signal_ids.length, 30),
              300
            ),
            min_score: Math.max(68, agentMinScore - 4),
            max_positions: Math.min(6, toPositiveInt(options.max_positions, 8, 30)),
            default_position_pct: Math.min(3, safeNumber(options.default_position_pct, 5)),
            max_position_pct: Math.min(4, safeNumber(options.max_position_pct, 10)),
            min_trade_amount: safeNumber(options.min_trade_amount, 3000),
            allowed_risk_levels: ['low', 'medium'],
            require_action_buy: true,
            dry_run: Boolean(options.dry_run),
            report_to_feishu: false,
            ignore_profit_gate_for_forced_signals: true,
            use_profit_gate: true,
            use_outcome_feedback: true,
            use_entry_risk_guard: options.use_entry_risk_guard,
            max_daily_new_positions: Math.min(
              2,
              toPositiveInt(options.max_daily_new_positions, 3, 20)
            ),
            max_daily_new_exposure_pct: Math.min(
              6,
              safeNumber(options.max_daily_new_exposure_pct, 12)
            ),
            max_total_exposure_pct: Math.min(30, safeNumber(options.max_total_exposure_pct, 60)),
            max_industry_exposure_pct: Math.min(
              15,
              safeNumber(options.max_industry_exposure_pct, 25)
            ),
            min_cash_reserve_pct: Math.max(20, safeNumber(options.min_cash_reserve_pct, 8)),
            max_portfolio_drawdown_pct: Math.min(
              8,
              safeNumber(options.max_portfolio_drawdown_pct, 12)
            ),
            max_single_stock_volatility_pct: options.max_single_stock_volatility_pct,
            max_position_correlation: options.max_position_correlation,
            max_portfolio_var_pct: Math.min(6, safeNumber(options.max_portfolio_var_pct, 10)),
            min_avg_turnover_yuan: options.min_avg_turnover_yuan,
            cooldown_days_after_loss: options.cooldown_days_after_loss,
            block_limit_up: options.block_limit_up,
            block_limit_down: options.block_limit_down,
            block_suspended: options.block_suspended,
            risk_profile_gate: {
              ...riskProfileGate,
              action: riskProfileGate.action === 'pause' ? 'pause' : 'observe',
              reason:
                riskProfileGate.action === 'pause'
                  ? riskProfileGate.reason
                  : '参数实验盘仅做小仓 A/B 验证，默认降仓观察',
              position_multiplier: Math.min(
                0.45,
                safeNumber(riskProfileGate.position_multiplier, 1)
              ),
              metadata_contains: {
                quant_candidate: true,
                quant_framework_signal: true,
              },
              param_experiment: true,
              lifecycle_summary: lifecycleSummary,
              ...(options.risk_profile_gate || {}),
            },
          })
          .catch(error => {
            logger.warn(`参数实验模拟盘跟单失败，主闭环不受影响: ${error?.message || error}`);
            return null;
          });
      }
    }

    const riskProfile =
      options.run_paper_trading && options.user_id
        ? await paperTradingRiskProfileService
            .getRiskProfile({
              user_id: options.user_id,
              portfolio_name: pureQuantPortfolioName,
              min_cash_reserve_pct: options.min_cash_reserve_pct,
              max_portfolio_drawdown_pct: options.max_portfolio_drawdown_pct,
              max_total_exposure_pct: options.max_total_exposure_pct,
              max_industry_exposure_pct: options.max_industry_exposure_pct,
              max_position_correlation: options.max_position_correlation,
              max_portfolio_var_pct: options.max_portfolio_var_pct,
              max_single_stock_volatility_pct: options.max_single_stock_volatility_pct,
            })
            .catch(error => {
              logger.warn(`量化闭环读取组合风险画像失败: ${error?.message || error}`);
              return null;
            })
        : null;

    const result = {
      mode: this.resolveMode(options),
      generated_at: new Date().toISOString(),
      trade_date,
      universe: options.universe || 'market',
      generated: {
        scanned_stocks: generated.scanned_stocks,
        strategy_count: generated.strategy_count,
        signal_count: generated.signal_count,
        by_strategy: generated.by_strategy,
        quote_sync: generated.quote_sync,
        factor_sync: factorSync,
        experiment_param_suggestion: experimentParamSuggestion
          ? {
              policy: experimentParamSuggestion.policy,
              summary: experimentParamSuggestion.summary,
              adopted_strategy_keys: Object.keys(
                experimentParamSuggestion.recommended_params_by_strategy || {}
              ),
            }
          : null,
        param_version_refresh: paramVersionRefresh
          ? {
              summary: paramVersionRefresh.summary,
              adopted_strategy_keys: Object.keys(
                paramVersionRefresh.adopted_param_version_by_strategy || {}
              ),
            }
          : null,
        active_scan_params: activeScanParams
          ? {
              summary: activeScanParams.summary,
              adopted_strategy_keys: Object.keys(
                activeScanParams.adopted_param_version_by_strategy || {}
              ),
              selections: activeScanParams.selections,
            }
          : null,
        param_validation_refresh: paramValidationRefresh
          ? {
              created: paramValidationRefresh.create?.created || 0,
              updated: paramValidationRefresh.create?.updated || 0,
              completed: paramValidationRefresh.refresh?.completed || 0,
              pending: paramValidationRefresh.refresh?.pending || 0,
            }
          : null,
        param_lifecycle: paramLifecycle
          ? {
              applied: paramLifecycle.applied,
              summary: paramLifecycle.lifecycle?.summary,
            }
          : null,
      },
      fusion: {
        candidate_count: candidates.length,
        selected_count: selectedCandidates.length,
        diversification: diversifiedSelection.summary,
        top_candidates: selectedCandidates.slice(0, 10),
      },
      archive: {
        created: archive.created,
        updated: archive.updated,
        total: archive.total,
        signal_ids: archive.signal_ids,
        candidates: archive.candidates.slice(0, 10),
      },
      agent_analysis: agentAnalysis,
      paper_trading: paperTrading,
      param_experiment_paper_trading: paramExperimentPaperTrading,
      risk_profile: riskProfile || paperTrading?.risk_profile || preTradeRiskProfile || null,
      risk_profile_gate: riskProfileGate,
      risk_threshold_suggestion: thresholdSuggestion,
      message: this.buildResultMessage({
        generated,
        selectedCandidates,
        archive,
        agentAnalysis,
        paperTrading,
      }),
    };

    if (options.report_to_feishu !== false && options.notify_to_feishu_bot !== false) {
      await feishuBotWebhookService.sendRecommendationSummary({
        scenario: 'quant_daily_pipeline',
        record_type: '量化交易场景推荐',
        result,
      });
    }

    return result;
  }

  private resolveMode(options: QuantDailyPipelineOptions): QuantPipelineMode {
    if (options.run_paper_trading) return 'paper_trade';
    if (options.submit_agent_analysis !== false) return 'agent_review';
    return 'archive_only';
  }

  private buildSignalTraceUrl(signal_id?: number): string | undefined {
    if (!signal_id) return undefined;
    const baseUrl = String(process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '');
    const path = `/signals/${signal_id}/trace`;
    return baseUrl ? `${baseUrl}${path}` : path;
  }

  private buildRiskProfileGate(
    riskProfile: any,
    options: {
      requested_trade_limit: number;
      requested_default_position_pct: number;
      requested_max_position_pct: number;
      suggested_limits?: any;
    }
  ) {
    const level = String(riskProfile?.status?.level || 'safe').toLowerCase();
    const suggestedLimits = asPlainObject(
      options.suggested_limits?.limits || options.suggested_limits
    );
    const threshold_version = {
      action: options.suggested_limits?.action || 'observe',
      reason: options.suggested_limits?.reason,
      limits: suggestedLimits,
      stability:
        options.suggested_limits?.stability || options.suggested_limits?.suggestion_stability,
      attribution:
        options.suggested_limits?.attribution || options.suggested_limits?.threshold_attribution,
    };
    if (level === 'danger') {
      return {
        enabled: true,
        applied: true,
        action: 'pause',
        position_multiplier: 0,
        effective_trade_limit: 0,
        effective_default_position_pct: 0,
        effective_max_position_pct: 0,
        reason: riskProfile?.status?.conclusion || '组合风险画像显示风险过高，本轮暂停新增买入',
        status: riskProfile?.status,
        metrics: riskProfile?.risk_metrics,
        threshold_version,
      };
    }
    if (level === 'watch') {
      const multiplier = 0.5;
      return {
        enabled: true,
        applied: true,
        action: 'reduce',
        position_multiplier: multiplier,
        effective_trade_limit: Math.max(1, Math.min(options.requested_trade_limit, 2)),
        effective_default_position_pct: roundNumber(
          Math.max(1, options.requested_default_position_pct * multiplier),
          2
        ),
        effective_max_position_pct: roundNumber(
          Math.max(1, options.requested_max_position_pct * multiplier),
          2
        ),
        reason: riskProfile?.status?.conclusion || '组合风险画像进入谨慎区，本轮自动半仓验证',
        status: riskProfile?.status,
        metrics: riskProfile?.risk_metrics,
        threshold_version,
      };
    }
    return {
      enabled: true,
      applied: false,
      action: 'allow',
      position_multiplier: 1,
      effective_trade_limit: options.requested_trade_limit,
      effective_default_position_pct: options.requested_default_position_pct,
      effective_max_position_pct: options.requested_max_position_pct,
      reason: riskProfile?.status?.conclusion || '组合风险画像允许继续小仓',
      status: riskProfile?.status,
      metrics: riskProfile?.risk_metrics,
      threshold_version,
    };
  }

  private async getRiskThresholdSuggestion(options: QuantDailyPipelineOptions) {
    try {
      const dashboard = await recommendationLoopPolicySnapshotService.getDashboard({
        username: options.username,
        universe: 'all',
        limit: 8,
        risk_threshold_stability_config:
          riskThresholdStabilityService.buildConfigFromParameters(options),
      } as any);
      const analysis: any = dashboard?.risk_gate_analysis || {};
      if (!analysis?.suggested_limits) return null;
      return {
        ...analysis.suggested_limits,
        stability: analysis.suggestion_stability,
        attribution: analysis.threshold_attribution,
        field_gate_adjustment_attribution: dashboard?.field_gate_adjustment_attribution,
      };
    } catch (error: any) {
      logger.warn(`量化闭环读取风险阈值稳定建议失败: ${error?.message || error}`);
      return null;
    }
  }

  private selectDiversifiedCandidates(
    candidates: QuantFusionCandidate[],
    limit: number,
    options: { max_industry_candidates?: number; max_strategy_candidates?: number } = {}
  ): {
    selected: QuantFusionCandidate[];
    summary: {
      requested_limit: number;
      selected_count: number;
      max_industry_candidates: number;
      max_strategy_candidates: number;
      overflow_filled: number;
      by_industry: Record<string, number>;
      by_strategy: Record<string, number>;
    };
  } {
    const maxIndustryCandidates = toPositiveInt(options.max_industry_candidates, 4, 20);
    const maxStrategyCandidates = toPositiveInt(options.max_strategy_candidates, 8, 30);
    const selected: QuantFusionCandidate[] = [];
    const overflow: QuantFusionCandidate[] = [];
    const industryCounts = new Map<string, number>();
    const strategyCounts = new Map<string, number>();

    const industryKey = (candidate: QuantFusionCandidate) =>
      String(
        candidate.factors?.market_environment?.industry?.name ||
          candidate.factors?.best_raw_factors?.industry ||
          '未分类'
      );

    for (const candidate of candidates) {
      if (selected.length >= limit) break;
      const industry = industryKey(candidate);
      const strategy = candidate.strategy_key || 'unknown';
      const industryCount = industryCounts.get(industry) || 0;
      const strategyCount = strategyCounts.get(strategy) || 0;
      if (
        industryCount >= maxIndustryCandidates ||
        strategyCount >= maxStrategyCandidates ||
        candidate.risk_level === 'high'
      ) {
        overflow.push(candidate);
        continue;
      }
      selected.push(candidate);
      industryCounts.set(industry, industryCount + 1);
      strategyCounts.set(strategy, strategyCount + 1);
    }

    let overflowFilled = 0;
    for (const candidate of overflow) {
      if (selected.length >= limit) break;
      if (
        selected.some(item => normalizeSymbol(item.symbol) === normalizeSymbol(candidate.symbol))
      ) {
        continue;
      }
      selected.push(candidate);
      overflowFilled++;
    }

    return {
      selected,
      summary: {
        requested_limit: limit,
        selected_count: selected.length,
        max_industry_candidates: maxIndustryCandidates,
        max_strategy_candidates: maxStrategyCandidates,
        overflow_filled: overflowFilled,
        by_industry: Object.fromEntries(industryCounts.entries()),
        by_strategy: Object.fromEntries(strategyCounts.entries()),
      },
    };
  }

  private async buildFusionCandidates(options: {
    trade_date: string;
    strategy_keys?: string[];
    min_score: number;
    limit: number;
  }): Promise<QuantFusionCandidate[]> {
    const where: any = {
      trade_date: options.trade_date,
      score: { [Op.gte]: options.min_score },
      signal: { [Op.in]: ['buy', 'watch', 'hold', 'sell'] },
    };
    if (options.strategy_keys?.length) {
      where.strategy_key = { [Op.in]: options.strategy_keys };
    }

    const signals = await QuantSignal.findAll({
      where,
      order: [
        ['score', 'DESC'],
        ['confidence', 'DESC'],
      ],
      limit: Math.min(options.limit, 1000),
    });
    const weightRecords = await QuantStrategyWeight.findAll();
    const strategyWeights = new Map(
      weightRecords.map(record => [
        record.strategy_key,
        {
          weight: safeNumber(record.weight, 1),
          action: record.action,
          quality_score: record.quality_score,
          reason: record.reason,
          metrics: record.metrics || {},
        },
      ])
    );
    const allocationPolicy = await quantStrategyFeedbackService.getAllocationPolicy({
      capital: 200000,
    });
    const allocationByStrategy = new Map(
      (allocationPolicy.allocations || []).map((item: any) => [item.strategy_key, item])
    );

    const groups = new Map<string, QuantSignal[]>();
    for (const signal of signals) {
      const symbol = normalizeSymbol(signal.symbol);
      if (!symbol) continue;
      const existing = groups.get(symbol) || [];
      existing.push(signal);
      groups.set(symbol, existing);
    }

    return [...groups.values()]
      .map(items =>
        this.toFusionCandidate(items, options.trade_date, strategyWeights, allocationByStrategy)
      )
      .filter(Boolean)
      .sort(
        (a, b) =>
          Number(b?.score || 0) - Number(a?.score || 0) ||
          Number(b?.consensus_count || 0) - Number(a?.consensus_count || 0)
      ) as QuantFusionCandidate[];
  }

  private toFusionCandidate(
    items: QuantSignal[],
    trade_date: string,
    strategyWeights: Map<
      string,
      {
        weight: number;
        action?: string;
        quality_score?: any;
        reason?: string;
        metrics?: Record<string, any>;
      }
    >,
    allocationByStrategy?: Map<string, any>
  ): QuantFusionCandidate | null {
    const sorted = [...items].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const best = sorted[0];
    if (!best) return null;

    const strategyKeys = uniqueValues(sorted.map(item => item.strategy_key));
    const paramVersions = uniqueValues(
      sorted
        .map(item => {
          const raw = asPlainObject(item.raw_factors);
          return raw.param_version_key
            ? {
                strategy_key: item.strategy_key,
                version_key: raw.param_version_key,
                version_type: raw.param_version_type,
                status: raw.param_version_status,
                ab_group: raw.param_version_ab_group,
                source_experiment_key: raw.param_version_source_experiment_key,
              }
            : null;
        })
        .filter(Boolean)
        .map(item => JSON.stringify(item))
    ).map(item => JSON.parse(String(item)));
    const paramVersionKeys = uniqueValues(
      paramVersions.map(item => String(item.version_key || '').trim())
    );
    const riskFlags = uniqueValues(sorted.flatMap(item => item.risk_flags || []));
    const reasons = uniqueValues(sorted.flatMap(item => splitReasonText(item.reason))).slice(0, 8);
    const consensusCount = strategyKeys.length;
    const consensusBonus = Math.min(12, Math.max(0, consensusCount - 1) * 3);
    const riskPenalty = Math.min(12, riskFlags.length * 3);
    const quantScore = safeNumber(best.score, 0);
    const avgStrategyWeight =
      strategyKeys.reduce(
        (sum, key) => sum + Math.max(0.45, Math.min(1.35, strategyWeights.get(key)?.weight || 1)),
        0
      ) / Math.max(strategyKeys.length, 1);
    const weightAdjustment = (avgStrategyWeight - 1) * 18;
    const marketEnvironment = asPlainObject((best.raw_factors || {}).market_environment);
    const marketRegime = marketEnvironment.market_regime;
    const industryRegime = asPlainObject(marketEnvironment.industry).regime;
    const regimeAdjustments = strategyKeys.map(key => {
      const metrics = asPlainObject(strategyWeights.get(key)?.metrics);
      const marketAdjustment = regimeBucketAdjustment(
        Array.isArray(metrics.by_market_regime) ? metrics.by_market_regime : [],
        marketRegime,
        'market'
      );
      const industryAdjustment = regimeBucketAdjustment(
        Array.isArray(metrics.by_industry_regime) ? metrics.by_industry_regime : [],
        industryRegime,
        'industry'
      );
      return {
        strategy_key: key,
        market_regime: marketRegime,
        industry_regime: industryRegime,
        market_adjustment: marketAdjustment.adjustment,
        industry_adjustment: industryAdjustment.adjustment,
        total_adjustment: round(marketAdjustment.adjustment + industryAdjustment.adjustment, 2),
        market_match: marketAdjustment.matched,
        industry_match: industryAdjustment.matched,
        reasons: [marketAdjustment.reason, industryAdjustment.reason].filter(Boolean),
      };
    });
    const environmentAdjustment = round(
      regimeAdjustments.reduce((sum, item) => sum + item.total_adjustment, 0) /
        Math.max(regimeAdjustments.length, 1),
      2
    );
    const score = round(
      clamp(quantScore + consensusBonus + weightAdjustment + environmentAdjustment - riskPenalty),
      2
    );
    const currentPrice = safeNumber(best.entry_price, 0) || undefined;
    const stopLossPrice = safeNumber(best.stop_loss_price, 0) || undefined;
    const takeProfitPrice = safeNumber(best.take_profit_price, 0) || undefined;
    const stopLossPct =
      currentPrice && stopLossPrice
        ? round(Math.abs((currentPrice - stopLossPrice) / currentPrice) * 100, 2)
        : 7;
    const takeProfitPct =
      currentPrice && takeProfitPrice
        ? round(Math.abs((takeProfitPrice - currentPrice) / currentPrice) * 100, 2)
        : 14;
    const sellVotes = sorted.filter(item => item.signal === 'sell').length;
    const buyVotes = sorted.filter(item => item.signal === 'buy').length;
    const action =
      sellVotes > 0 && sellVotes >= buyVotes
        ? 'avoid'
        : best.signal === 'buy' && score >= 70
        ? 'buy'
        : best.signal === 'buy' || best.signal === 'watch'
        ? 'watch'
        : 'hold';
    const riskLevel: QuantFusionCandidate['risk_level'] =
      riskFlags.length >= 3 ? 'high' : riskFlags.length >= 1 ? 'medium' : 'low';
    const allocationCandidates = strategyKeys
      .map(key => allocationByStrategy?.get(key))
      .filter(Boolean)
      .sort(
        (a, b) =>
          safeNumber(a.max_single_trade_pct, 0) - safeNumber(b.max_single_trade_pct, 0) ||
          safeNumber(b.allocation_pct, 0) - safeNumber(a.allocation_pct, 0)
      );
    const primaryAllocation =
      allocationByStrategy?.get(best.strategy_key) || allocationCandidates[0] || undefined;
    const strategyMaxSingleTradePct = primaryAllocation
      ? safeNumber(primaryAllocation.max_single_trade_pct, 0)
      : 0;
    const strategyAllocationPct = primaryAllocation
      ? safeNumber(primaryAllocation.allocation_pct, 0)
      : 0;
    const baseSuggestedPositionPct =
      action === 'buy'
        ? clamp(3 + (score - 70) / 5 + consensusCount, 3, 10)
        : action === 'watch'
        ? clamp(1 + (score - 60) / 8, 1, 4)
        : 0;
    const suggestedPositionPct =
      action === 'buy' && strategyMaxSingleTradePct > 0
        ? Math.min(baseSuggestedPositionPct, strategyMaxSingleTradePct)
        : baseSuggestedPositionPct;

    return {
      symbol: best.symbol,
      name: best.name,
      trade_date,
      signal: best.signal,
      decision:
        action === 'buy'
          ? AISignalDecision.BUY
          : action === 'avoid'
          ? AISignalDecision.SELL
          : AISignalDecision.HOLD,
      action,
      action_label:
        action === 'buy'
          ? '可小仓试买'
          : action === 'watch'
          ? '等待Agent确认'
          : action === 'avoid'
          ? '量化卖出/回避'
          : '继续观察',
      score,
      quant_score: quantScore,
      confidence: round(Math.min(100, safeNumber(best.confidence, score) + consensusBonus / 2), 2),
      current_price: currentPrice,
      price_change_pct: safeNumber((best.raw_factors || {}).change_percent, NaN),
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      stop_loss_pct: stopLossPct,
      take_profit_pct: takeProfitPct,
      suggested_position_pct: round(suggestedPositionPct, 2),
      strategy_allocation_pct:
        strategyAllocationPct > 0 ? round(strategyAllocationPct, 2) : undefined,
      strategy_allocation_amount: primaryAllocation?.capital_amount,
      strategy_max_single_trade_pct:
        strategyMaxSingleTradePct > 0 ? round(strategyMaxSingleTradePct, 2) : undefined,
      strategy_max_single_trade_amount: primaryAllocation?.max_single_trade_amount,
      risk_level: riskLevel,
      strategy_key: best.strategy_key,
      strategy_keys: strategyKeys,
      consensus_count: consensusCount,
      consensus_bonus: consensusBonus,
      quant_signal_ids: sorted.map(item => item.id).filter(Boolean),
      reasons: reasons.length ? reasons : ['量化策略给出正向候选，但核心理由不足，需Agent复核'],
      risk_flags: riskFlags,
      factors: {
        best_strategy_key: best.strategy_key,
        best_raw_factors: best.raw_factors || {},
        param_versions: paramVersions,
        param_version_keys: paramVersionKeys,
        market_environment: marketEnvironment,
        strategy_weight: round(avgStrategyWeight, 4),
        strategy_weight_adjustment: round(weightAdjustment, 4),
        environment_weight_adjustment: environmentAdjustment,
        regime_adjustments: regimeAdjustments,
        strategy_weight_details: strategyKeys.map(key => ({
          strategy_key: key,
          ...(strategyWeights.get(key) || { weight: 1, action: 'observe' }),
        })),
        strategy_allocation_policy: primaryAllocation,
        strategy_allocation_candidates: allocationCandidates.slice(0, 5),
        strategy_votes: sorted.map(item => ({
          id: item.id,
          strategy_key: item.strategy_key,
          signal: item.signal,
          score: Number(item.score || 0),
          confidence: Number(item.confidence || 0),
          reason: item.reason,
          risk_flags: item.risk_flags || [],
          raw_factors: item.raw_factors || {},
        })),
      },
    };
  }

  private async archiveFusionCandidates(
    candidates: QuantFusionCandidate[],
    options: QuantDailyPipelineOptions
  ) {
    let created = 0;
    let updated = 0;
    const signal_ids: number[] = [];
    const signal_records: AIInvestmentSignal[] = [];

    for (const candidate of candidates) {
      const source_id = `quant_framework_${candidate.trade_date}_${normalizeSymbol(
        candidate.symbol
      )}`;
      const rationale = [
        `当前股价 ${candidate.current_price ? `¥${candidate.current_price}` : '--'}`,
        `融合分 ${candidate.score}，量化原始分 ${candidate.quant_score}`,
        `策略共识 ${candidate.consensus_count} 个：${candidate.strategy_keys.join('/')}`,
        candidate.reasons.slice(0, 3).join('；'),
      ]
        .filter(Boolean)
        .join('；');

      const payload = {
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
        source_id,
        symbol: normalizeSymbol(candidate.symbol),
        name: candidate.name,
        signal_date: candidate.trade_date,
        decision: candidate.decision,
        normalized_decision: candidate.decision,
        confidence_score: candidate.score,
        risk_level: candidate.risk_level,
        rationale,
        detail: JSON.stringify(candidate, null, 2),
        current_price: candidate.current_price,
        price_change_pct: Number.isFinite(Number(candidate.price_change_pct))
          ? candidate.price_change_pct
          : undefined,
        metadata: {
          quant_candidate: true,
          quant_framework_signal: true,
          fusion_version: 'quant_agent_v1',
          universe: options.universe || 'market',
          as_of: candidate.trade_date,
          source: 'quant_framework',
          rating: candidate.score >= 78 ? '强烈关注' : candidate.score >= 70 ? '积极关注' : '观察',
          confidence: candidate.confidence,
          action: candidate.action,
          action_label: candidate.action_label,
          recommendation_tier:
            candidate.action === 'buy'
              ? 'strong_recommend'
              : candidate.action === 'watch'
              ? 'watchlist'
              : 'avoid',
          recommendation_tier_label:
            candidate.action === 'buy'
              ? '强推荐池'
              : candidate.action === 'watch'
              ? '观察池'
              : '回避池',
          tier_reason: candidate.reasons.slice(0, 2).join('；'),
          original_score: candidate.quant_score,
          pre_quality_score: candidate.quant_score,
          data_quality_score: 82,
          data_quality_bucket: 'high',
          auto_trade_allowed_by_data_quality: true,
          consensus_count: candidate.consensus_count,
          consensus_bonus: candidate.consensus_bonus,
          consensus_variants: candidate.strategy_keys,
          strategy_key: candidate.strategy_key,
          strategy_variant: {
            source: 'quant_framework',
            strategy_keys: candidate.strategy_keys,
            quant_signal_ids: candidate.quant_signal_ids,
            fusion_score: candidate.score,
            param_versions: candidate.factors?.param_versions,
            param_version_keys: candidate.factors?.param_version_keys,
            fusion_formula:
              'quant_score + consensus_bonus + strategy_weight_adjustment + environment_weight_adjustment - risk_penalty',
            strategy_allocation_policy: candidate.factors?.strategy_allocation_policy,
            market_environment: candidate.factors?.market_environment,
            regime_adjustments: candidate.factors?.regime_adjustments,
          },
          market_environment: candidate.factors?.market_environment,
          suggested_position_pct: candidate.suggested_position_pct,
          strategy_allocation_pct: candidate.strategy_allocation_pct,
          strategy_allocation_amount: candidate.strategy_allocation_amount,
          strategy_max_single_trade_pct: candidate.strategy_max_single_trade_pct,
          strategy_max_single_trade_amount: candidate.strategy_max_single_trade_amount,
          strategy_allocation_policy: candidate.factors?.strategy_allocation_policy,
          stop_loss_pct: candidate.stop_loss_pct,
          take_profit_pct: candidate.take_profit_pct,
          factors: compactFactors(candidate.factors?.best_raw_factors),
          metrics: {
            quant_score: candidate.quant_score,
            fusion_score: candidate.score,
            consensus_count: candidate.consensus_count,
            environment_weight_adjustment: candidate.factors?.environment_weight_adjustment,
            stop_loss_price: candidate.stop_loss_price,
            take_profit_price: candidate.take_profit_price,
            strategy_allocation_pct: candidate.strategy_allocation_pct,
            strategy_max_single_trade_pct: candidate.strategy_max_single_trade_pct,
          },
          reasons: candidate.reasons,
          warnings: candidate.risk_flags,
          current_price: candidate.current_price,
          price_change_pct: candidate.price_change_pct,
          task_label: options.task_label,
          agent_session: options.agent_session,
        },
      };

      const [record, isCreated] = await AIInvestmentSignal.findOrCreate({
        where: { source_type: AISignalSourceType.QUANT_RECOMMENDATION, source_id },
        defaults: payload as any,
      });

      if (isCreated) {
        created++;
      } else {
        await record.update(payload as any);
        updated++;
      }

      signal_ids.push(record.id);
      signal_records.push(record);
      candidate.trace_url = this.buildSignalTraceUrl(record.id);
      await QuantSignal.update(
        { agent_status: 'archived' },
        { where: { id: { [Op.in]: candidate.quant_signal_ids } } }
      );
    }

    return {
      created,
      updated,
      total: candidates.length,
      signal_ids,
      signal_records,
      candidates,
    };
  }

  private async submitAgentReview(
    candidates: QuantFusionCandidate[],
    signalRecords: AIInvestmentSignal[],
    options: QuantDailyPipelineOptions & {
      trade_date: string;
      target_date: string;
      agent_max_count: number;
      agent_min_score: number;
    }
  ) {
    const enabled = options.submit_agent_analysis !== false;
    const submitted: any[] = [];
    const failed: any[] = [];
    const skipped: any[] = [];
    const requestedPortfolioName = options.portfolio_name;
    const agentFusionPortfolioName =
      !requestedPortfolioName || requestedPortfolioName === AUTONOMOUS_PORTFOLIO_NAME
        ? QUANT_AGENT_FUSION_PORTFOLIO_NAME
        : requestedPortfolioName;
    if (!enabled) {
      return { enabled: false, submitted, failed, skipped };
    }

    const recordsBySymbol = new Map(
      signalRecords.map(record => [normalizeSymbol(record.symbol), record])
    );
    const reviewCandidates = candidates
      .filter(
        candidate =>
          candidate.action === 'buy' &&
          candidate.score >= options.agent_min_score &&
          candidate.risk_level !== 'high'
      )
      .slice(0, options.agent_max_count);

    for (const candidate of candidates) {
      if (!reviewCandidates.includes(candidate)) {
        skipped.push({
          symbol: candidate.symbol,
          name: candidate.name,
          score: candidate.score,
          reason:
            candidate.action !== 'buy'
              ? '不是买入动作'
              : candidate.score < options.agent_min_score
              ? `融合分低于Agent阈值 ${options.agent_min_score}`
              : candidate.risk_level === 'high'
              ? '风险等级偏高'
              : '超过Agent提交上限',
        });
      }
    }

    for (const candidate of reviewCandidates) {
      try {
        const response = await aiAdvisorService.analyzeStock(
          normalizeSymbol(candidate.symbol),
          options.target_date,
          true
        );
        if (!response?.task_id) {
          failed.push({ symbol: candidate.symbol, name: candidate.name, error: '未返回task_id' });
          continue;
        }

        const archivedSignal = recordsBySymbol.get(normalizeSymbol(candidate.symbol));
        await aiPollingQueue.add(
          {
            taskId: response.task_id,
            symbol: normalizeSymbol(candidate.symbol),
            name: candidate.name || candidate.symbol,
            executionLogId: options.execution_log_id,
            scheduler_task_type: 'QUANT_DAILY_PIPELINE',
            taskLabel: options.task_label || '量化策略全市场扫描',
            quant_score: candidate.score,
            quant_factors: compactFactors(candidate.factors?.best_raw_factors),
            quant_reasons: candidate.reasons,
            quant_warnings: candidate.risk_flags,
            recommendation_style: 'quant_fusion',
            recommendation_source: options.universe || 'market',
            strategy_key: candidate.strategy_key,
            strategy_variant: {
              source: 'quant_framework',
              strategy_keys: candidate.strategy_keys,
              quant_signal_ids: candidate.quant_signal_ids,
              ai_signal_id: archivedSignal?.id,
              consensus_count: candidate.consensus_count,
              fusion_score: candidate.score,
              param_versions: candidate.factors?.param_versions,
              param_version_keys: candidate.factors?.param_version_keys,
              strategy_allocation_policy: candidate.factors?.strategy_allocation_policy,
              market_environment: candidate.factors?.market_environment,
              regime_adjustments: candidate.factors?.regime_adjustments,
            },
            market_environment: candidate.factors?.market_environment,
            agent_session: options.agent_session || 'close',
            current_price: candidate.current_price,
            price_change_pct: candidate.price_change_pct,
            data_quality_score: 82,
            data_quality_bucket: 'high',
            data_quality: {
              score: 82,
              bucket: 'high',
              auto_trade_allowed: true,
              warnings: candidate.risk_flags,
            },
            auto_paper_trade: options.agent_auto_paper_trade !== false,
            paper_trade_username: options.username,
            paper_trade_portfolio_name: agentFusionPortfolioName,
            paper_trade_initial_capital: options.initial_capital,
            paper_trade_force_new_portfolio: options.force_new_portfolio,
            paper_trade_min_score: options.agent_min_score,
            paper_trade_max_positions: options.max_positions,
            paper_trade_default_position_pct: options.default_position_pct,
            paper_trade_max_position_pct: Math.min(
              safeNumber(options.max_position_pct, 8),
              safeNumber(
                candidate.strategy_max_single_trade_pct,
                safeNumber(options.max_position_pct, 8)
              )
            ),
            paper_trade_min_trade_amount: options.min_trade_amount,
            paper_trade_risk_profile_gate: options.risk_profile_gate,
            strategy_allocation_policy: candidate.factors?.strategy_allocation_policy,
            strategy_allocation_pct: candidate.strategy_allocation_pct,
            strategy_max_single_trade_pct: candidate.strategy_max_single_trade_pct,
            quant_agent_fusion: true,
          },
          {
            jobId: `ai-poll-quant-${
              options.execution_log_id ? `log-${options.execution_log_id}` : 'manual'
            }-${response.task_id}`,
            attempts: 10,
            backoff: { type: 'fixed', delay: 3 * 60 * 1000 },
          }
        );

        await QuantSignal.update(
          { agent_status: 'submitted' },
          { where: { id: { [Op.in]: candidate.quant_signal_ids } } }
        );
        submitted.push({
          symbol: candidate.symbol,
          name: candidate.name,
          score: candidate.score,
          task_id: response.task_id,
          ai_signal_id: archivedSignal?.id,
        });
      } catch (error: any) {
        logger.warn(`量化候选提交 TradingAgents 失败 ${candidate.symbol}: ${error.message}`);
        await QuantSignal.update(
          { agent_status: 'failed' },
          { where: { id: { [Op.in]: candidate.quant_signal_ids } } }
        );
        failed.push({
          symbol: candidate.symbol,
          name: candidate.name,
          score: candidate.score,
          error: error?.message || String(error),
        });
      }
    }

    return { enabled, submitted, failed, skipped };
  }

  private buildResultMessage(payload: {
    generated: any;
    selectedCandidates: QuantFusionCandidate[];
    archive: any;
    agentAnalysis: any;
    paperTrading: any;
  }) {
    const best = payload.selectedCandidates[0];
    return [
      `量化扫描完成：扫描 ${payload.generated.scanned_stocks} 只股票，生成 ${payload.generated.signal_count} 条策略信号，归档 ${payload.archive.total} 条融合候选。`,
      payload.agentAnalysis?.enabled
        ? `TradingAgents复核：提交 ${payload.agentAnalysis.submitted.length} 条，失败 ${payload.agentAnalysis.failed.length} 条。`
        : 'TradingAgents复核：本次未启用。',
      payload.paperTrading
        ? `模拟盘：成交/计划 ${
            payload.paperTrading.executed ?? payload.paperTrading.planned ?? 0
          } 笔，跳过 ${payload.paperTrading.skipped ?? 0} 条。`
        : '',
      payload.generated?.quote_sync
        ? `实时行情：已落盘 ${payload.generated.quote_sync.persisted_count || 0} 条，更新 ${
            payload.generated.quote_sync.updated_stock_count || 0
          } 只股票快照。`
        : '',
      best
        ? `首选候选：${best.name || best.symbol}(${best.symbol})，当前股价 ${
            best.current_price ? `¥${best.current_price}` : '--'
          }，融合分 ${best.score}，理由：${best.reasons.slice(0, 2).join('；')}`
        : '暂无达到阈值的候选。',
    ]
      .filter(Boolean)
      .join('\n');
  }
}

export const quantFusionService = new QuantFusionService();
