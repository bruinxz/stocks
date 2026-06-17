import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { QuantSignal } from '../../../models/QuantSignal';
import {
  AIInvestmentSignal,
  AISignalDecision,
  AISignalSourceType,
} from '../../../models/AIInvestmentSignal';
import { quantSignalService } from './QuantSignalService';
import { aiAdvisorService } from '../../../services/AIAdvisorService';
import { aiPollingQueue } from '../../../jobs/aiPollingQueue';
import { paperTradingAutomationService } from '../../../portfolio/internal/PaperTradingAutomationService';
import { paperTradingRiskProfileService } from '../../../portfolio/internal/PaperTradingRiskProfileService';
import { normalizeSymbol } from '../../../utils/stockSymbol';
import { logger } from '../../../utils/logger';
import { round } from '../../engine/QuantMath';
import { QuantUniverse } from '../../types/QuantTypes';
import { QuantStrategyWeight } from '../../../models/QuantStrategyWeight';
import { QuantBacktestResult } from '../../../models/QuantBacktestResult';
import { QuantBacktestTask } from '../../../models/QuantBacktestTask';
import { quantStrategyFeedbackService } from './QuantStrategyFeedbackService';
import { recommendationLoopPolicySnapshotService } from '../../../services/RecommendationLoopPolicySnapshotService';
import { riskThresholdStabilityService } from '../../../services/RiskThresholdStabilityService';
import { quantStrategyExperimentService } from './QuantStrategyExperimentService';
import { quantStrategyParamVersionService } from './QuantStrategyParamVersionService';
import { quantStrategyService } from './QuantStrategyService';
import { stockFactorService } from '../../../data/services/StockFactorService';
import { quantRuntimeHealthService } from '../../health/internal/QuantRuntimeHealthService';
import { feishuBotWebhookService } from '../../../services/FeishuBotWebhookService';
import {
  AUTONOMOUS_PORTFOLIO_NAME,
  QUANT_AGENT_FUSION_PORTFOLIO_NAME,
  QUANT_ONLY_PORTFOLIO_NAME,
  PARAM_EXPERIMENT_PORTFOLIO_NAME,
  PAPER_PORTFOLIO_EXPERIMENT_FAMILIES,
} from '../../../portfolio/internal/PaperTradingDashboardService';

type QuantPipelineMode = 'archive_only' | 'agent_review' | 'paper_trade';

interface StrategyRecentBacktestPerformance {
  strategy_key: string;
  task_samples: number;
  buy_fill_count: number;
  closed_trade_count: number;
  open_position_count: number;
  avg_return_pct: number;
  avg_excess_return_pct: number;
  avg_drawdown_pct: number;
  avg_sharpe: number;
  latest_task_end_date?: string;
  latest_task_name?: string;
  action: 'support' | 'observe' | 'reduce' | 'pause';
  reason: string;
}

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
  agent_paper_trade_min_score?: number;
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
  realtime_quote_source?: string;
  /**
   * Batch N (2026-06-17): runDailyPipeline 入口可接收 dry_run_strategy_keys, 透传到
   * submitAgentReview → aiPollingQueue 让 worker 在 autoBuyFromSignals 时尊重
   * dry-run lever. 之前完全未传, 此条 cron 链路 dry-run 失效.
   * caller 若不传, runDailyPipeline 内会自己调 strategyEngine.getDryRunStrategyKeys()
   * 作 fail-CLOSED 加载 (B1 同步修过).
   */
  dry_run_strategy_keys?: string[];
  sync_factors_before_scan?: boolean;
  factor_sync_scope?: 'market' | 'favorites' | 'custom';
  factor_sync_limit?: number;
  factor_sync_skip_if_coverage_rate_gte?: number;
  factor_sync_skip_if_real_provider_rate_gte?: number;
  factor_provider?: 'auto' | 'local_derived' | 'tushare' | 'eastmoney';
  block_buy_on_runtime_risk?: boolean;
  run_strategy_portfolio_experiments?: boolean;
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
  strategy_budget_action?: string;
  strategy_budget_label?: string;
  strategy_budget_reason?: string;
  strategy_budget_confidence?: number;
  strategy_budget_discipline?: Record<string, any>;
  strategy_runtime_policy?: Record<string, any>;
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

function compactText(value: any, maxLength = 120): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function actionLabelText(action: any): string {
  const normalized = String(action || '').toLowerCase();
  const labels: Record<string, string> = {
    increase: '加权',
    slight_increase: '轻加权',
    observe: '观察',
    reduce: '降权',
    pause: '暂停',
    allow: '放行',
  };
  return labels[normalized] || String(action || '').trim();
}

function buildStrategyBudgetDecision(
  primaryAllocation: any,
  options: {
    effective_single_trade_cap?: number;
    suggested_position_pct?: number;
    strategy_keys?: string[];
  } = {}
) {
  const allocation = asPlainObject(primaryAllocation);
  const decision = asPlainObject(allocation.decision || allocation.weight_decision);
  const action = decision.action || allocation.action || 'observe';
  const action_label = decision.action_label || actionLabelText(action) || '观察';
  const allocationPct = safeNumber(allocation.allocation_pct, 0);
  const capPct =
    safeNumber(options.effective_single_trade_cap, 0) ||
    safeNumber(allocation.max_single_trade_pct, 0);
  const sampleConfidence = safeNumber(
    decision.sample_confidence ?? allocation.sample_confidence,
    0
  );
  const reason = compactText(
    decision.reason || allocation.reason || '按策略后验质量、样本置信度和动作倍率分配预算。',
    120
  );
  const label = [
    allocation.strategy_name || allocation.strategy_key,
    allocationPct > 0 ? `预算${roundNumber(allocationPct, 1)}%` : '',
    capPct > 0 ? `单票≤${roundNumber(capPct, 1)}%` : '',
    action_label,
    sampleConfidence > 0 ? `置信${roundNumber(sampleConfidence, 0)}` : '',
  ]
    .filter(Boolean)
    .join('，');
  return {
    enabled: true,
    strategy_key: allocation.strategy_key,
    strategy_name: allocation.strategy_name,
    strategy_keys: options.strategy_keys || [],
    action,
    action_label,
    allocation_pct: allocationPct || undefined,
    capital_amount: allocation.capital_amount,
    max_single_trade_pct: capPct || undefined,
    max_single_trade_amount: allocation.max_single_trade_amount,
    suggested_position_pct: options.suggested_position_pct,
    sample_confidence: sampleConfidence || undefined,
    sample_confidence_label: decision.sample_confidence_label || allocation.sample_confidence_label,
    confidence: safeNumber(decision.confidence, 0) || undefined,
    reason,
    risk_notes: Array.isArray(decision.risk_notes) ? decision.risk_notes.slice(0, 3) : [],
    next_action: decision.next_action || allocation.next_action,
    label,
    policy: allocation,
  };
}

function buildStrategyAdmissionGate(
  strategyKeys: string[],
  strategyWeights: Map<
    string,
    {
      weight: number;
      action?: string;
      quality_score?: any;
      sample_count?: any;
      closed_count?: any;
      reason?: string;
      metrics?: Record<string, any>;
    }
  >,
  recentBacktestPerformanceByStrategy: Map<string, StrategyRecentBacktestPerformance> = new Map()
) {
  const details = strategyKeys.map(key => {
    const record = strategyWeights.get(key);
    const metrics = asPlainObject(record?.metrics);
    const decision = asPlainObject(metrics.weight_decision);
    const recentBacktest = recentBacktestPerformanceByStrategy.get(key);
    return {
      strategy_key: key,
      action: String(record?.action || 'observe'),
      quality_score: safeNumber(record?.quality_score, 50),
      closed_count: safeNumber(
        record?.closed_count ?? metrics.closed_count ?? decision.evidence?.closed_count,
        0
      ),
      sample_count: safeNumber(
        record?.sample_count ?? metrics.sample_count ?? decision.evidence?.sample_count,
        0
      ),
      avg_excess_return_pct: safeNumber(
        metrics.avg_excess_return_pct ?? decision.evidence?.avg_excess_return_pct,
        NaN
      ),
      recent_backtest: recentBacktest,
      reason: record?.reason,
    };
  });
  const hasPaused = details.some(item => item.action === 'pause');
  const hasReducedOnly = details.length > 0 && details.every(item => item.action === 'reduce');
  const hasActionable = details.some(item =>
    ['increase', 'slight_increase', 'observe'].includes(item.action)
  );
  const evidenceCount = details.filter(
    item =>
      (item.quality_score >= 58 && (item.closed_count > 0 || item.sample_count >= 3)) ||
      item.closed_count >= 3 ||
      item.sample_count >= 3
  ).length;
  const supportedCount = details.filter(
    item =>
      (item.quality_score >= 58 && item.closed_count >= 2) ||
      (item.closed_count >= 3 &&
        (!Number.isFinite(item.avg_excess_return_pct) || item.avg_excess_return_pct >= -1))
  ).length;
  const coldStart = evidenceCount === 0 || supportedCount === 0;
  const blocked = hasPaused || hasReducedOnly || !hasActionable;
  const scorePenalty = details.reduce(
    (sum, item) => {
      if (item.action === 'reduce') return sum + 8;
      if (item.quality_score < 45) return sum + 5;
      if (item.closed_count === 0 && item.quality_score <= 50) return sum + 3;
      if (item.closed_count > 0 && item.closed_count < 3) return sum + 5;
      const recent = item.recent_backtest;
      if (recent && recent.task_samples >= 3 && recent.buy_fill_count >= 10) {
        if (recent.action === 'pause') return sum + 12;
        if (recent.action === 'reduce') return sum + 8;
        if (recent.avg_excess_return_pct < -0.5) return sum + 5;
      }
      if (
        item.closed_count >= 3 &&
        Number.isFinite(item.avg_excess_return_pct) &&
        item.avg_excess_return_pct < -1
      ) {
        return sum + 4;
      }
      return sum;
    },
    coldStart ? 8 : 0
  );
  const reasons = [
    hasPaused ? '包含已暂停策略' : '',
    hasReducedOnly ? '策略全部处于降权状态' : '',
    !hasActionable ? '没有可执行策略权重' : '',
  ].filter(Boolean);
  const warnings = details
    .map(item => {
      const recent = item.recent_backtest;
      if (!recent || recent.task_samples < 3 || recent.buy_fill_count < 10) return '';
      if (recent.action === 'pause' || recent.action === 'reduce') {
        return `近期回测门禁：${item.strategy_key} ${recent.reason}`;
      }
      return '';
    })
    .concat(
      coldStart ? ['策略冷启动：缺少历史/模拟收益样本，本轮只降分观察并允许实验盘小仓采样'] : []
    )
    .filter(Boolean)
    .slice(0, 4);

  return {
    blocked,
    reasons,
    warnings,
    score_penalty: Math.min(18, scorePenalty),
    details,
  };
}

function buildRuntimeBuyGate(runtimeHealth: any) {
  if (!runtimeHealth) {
    return {
      action: 'allow',
      blocked: false,
      degraded: false,
      position_multiplier: 1,
      conclusion: '未启用运行时健康门禁。',
    };
  }
  const explicit = asPlainObject(runtimeHealth.buy_gate);
  if (explicit.action) {
    return {
      action: String(explicit.action || 'allow').toLowerCase(),
      blocked: Boolean(explicit.blocked),
      degraded: Boolean(explicit.degraded),
      position_multiplier: safeNumber(explicit.position_multiplier, 1),
      conclusion: explicit.conclusion || runtimeHealth.summary?.conclusion,
      blocking_checks: explicit.blocking_checks || [],
      degraded_checks: explicit.degraded_checks || [],
    };
  }
  const checks = Array.isArray(runtimeHealth.checks) ? runtimeHealth.checks : [];
  const riskChecks = checks.filter((item: any) => item.status === 'risk');
  const hardBlockKeys = new Set([
    'schema_columns',
    'strategy_registry',
    'quote_persistence',
    'schedule',
  ]);
  const hardBlocks = riskChecks.filter((item: any) => hardBlockKeys.has(String(item.key || '')));
  if (hardBlocks.length > 0 || runtimeHealth.status === 'risk') {
    return {
      action: hardBlocks.length > 0 ? 'pause' : 'reduce',
      blocked: hardBlocks.length > 0,
      degraded: hardBlocks.length === 0,
      position_multiplier: hardBlocks.length > 0 ? 0 : 0.5,
      conclusion: runtimeHealth.summary?.conclusion || '运行时健康存在风险。',
      blocking_checks: hardBlocks,
      degraded_checks: hardBlocks.length > 0 ? [] : riskChecks,
    };
  }
  return {
    action: runtimeHealth.status === 'warn' ? 'observe' : 'allow',
    blocked: false,
    degraded: runtimeHealth.status === 'warn',
    position_multiplier: runtimeHealth.status === 'warn' ? 0.75 : 1,
    conclusion: runtimeHealth.summary?.conclusion || '运行时健康未触发阻断。',
    blocking_checks: [],
    degraded_checks: checks.filter((item: any) => item.status === 'warn'),
  };
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
    // Batch N (2026-06-17): 解析 dry_run_strategy_keys 一次, 透传给 submitAgentReview /
    // autoBuyFromSignals. caller (cron / 手动 endpoint) 没传时, 自己加载 (fail-CLOSED:
    // 失败时整个 pipeline abort 而不是 silent 让 dry-run 策略真下单).
    let resolvedDryRunStrategyKeys: string[];
    if (Array.isArray(options.dry_run_strategy_keys)) {
      resolvedDryRunStrategyKeys = options.dry_run_strategy_keys;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { strategyEngine } = require('../StrategyEngine');
      resolvedDryRunStrategyKeys = await strategyEngine.getDryRunStrategyKeys();
    }
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
              provider: options.factor_provider || 'auto',
              prefer_real_provider: options.factor_provider !== 'local_derived',
              skip_if_coverage_rate_gte: safeNumber(
                options.factor_sync_skip_if_coverage_rate_gte,
                92
              ),
              skip_if_real_provider_rate_gte: safeNumber(
                options.factor_sync_skip_if_real_provider_rate_gte,
                65
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
      realtime_quote_source: options.realtime_quote_source || 'auto',
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
    const strategyAllocationPolicy = await quantStrategyFeedbackService
      .getAllocationPolicy({ capital: 200000 })
      .catch(error => {
        logger.warn(`读取策略资金分配摘要失败，飞书摘要降级: ${error?.message || error}`);
        return null;
      });
    const runtimeHealth =
      options.block_buy_on_runtime_risk === false
        ? null
        : await quantRuntimeHealthService.getHealth({ user_id: options.user_id }).catch(error => {
            logger.warn(`量化扫描运行时健康检查失败，本轮禁止自动买入: ${error?.message || error}`);
            return {
              status: 'risk',
              score: 0,
              summary: {
                conclusion: `量化扫描运行时健康检查失败：${error?.message || error}`,
              },
              buy_gate: {
                action: 'pause',
                blocked: true,
                degraded: false,
                position_multiplier: 0,
                conclusion: `量化扫描运行时健康检查失败：${error?.message || error}`,
              },
            };
          });
    const runtimeBuyGate = buildRuntimeBuyGate(runtimeHealth);
    const runtimeRiskBlocked = Boolean(runtimeBuyGate.blocked);
    if (runtimeRiskBlocked) {
      logger.warn(
        `量化运行时存在阻断风险，本轮仅归档观察信号，不执行 Agent 买入/模拟买入: ${
          runtimeHealth?.summary?.conclusion || 'runtime risk'
        }`
      );
      const result = {
        generated_at: new Date().toISOString(),
        trade_date,
        status: 'runtime_risk_watch_only',
        mode: 'archive_only' as QuantPipelineMode,
        universe: options.universe || 'market',
        runtime_health: runtimeHealth,
        runtime_buy_gate: runtimeBuyGate,
        runtime_risk_blocked: true,
        generated: {
          scanned_stocks: generated.scanned_stocks,
          strategy_count: generated.strategy_count,
          signal_count: generated.signal_count,
          by_strategy: generated.by_strategy,
          quote_sync: generated.quote_sync,
          runtime_policy_diagnostics: generated.runtime_policy_diagnostics,
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
        agent_analysis: {
          submitted: [],
          failed: [],
          skipped: true,
          reason: runtimeHealth?.summary?.conclusion || '量化运行时存在阻断风险。',
        },
        paper_trading: {
          planned: 0,
          executed: 0,
          skipped: archive.total || selectedCandidates.length,
          dry_run: true,
          reason: '量化运行时存在风险项，本轮只观察不买入。',
        },
        strategy_allocation_policy: strategyAllocationPolicy,
        message: '量化运行时存在风险项，本轮只归档观察信号，不执行模拟买入。',
      };
      // 量化扫描摘要默认不推；用户已经从 PAPER_TRADING_DAILY_DIGEST (15:30) 收到当日核心信息
      // 仅当 caller 显式 report_to_feishu=true 才发，避免 noise
      if (options.report_to_feishu === true && options.notify_to_feishu_bot !== false) {
        await feishuBotWebhookService.sendRecommendationSummary({
          scenario: 'quant_daily_pipeline',
          record_type: '量化交易场景推荐',
          result,
        });
      }
      return result;
    }
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
    const runtimeGateMultiplier = Math.max(
      0,
      Math.min(1, safeNumber(runtimeBuyGate.position_multiplier, 1))
    );
    const mergedRiskProfileGate =
      runtimeBuyGate.action === 'allow'
        ? riskProfileGate
        : {
            ...riskProfileGate,
            runtime_buy_gate: runtimeBuyGate,
            runtime_gate_action: runtimeBuyGate.action,
            action:
              riskProfileGate.action === 'pause' || runtimeBuyGate.action === 'pause'
                ? 'pause'
                : riskProfileGate.action === 'reduce' || runtimeBuyGate.action === 'reduce'
                ? 'reduce'
                : riskProfileGate.action === 'observe' || runtimeBuyGate.action === 'observe'
                ? 'observe'
                : riskProfileGate.action,
            position_multiplier: roundNumber(
              safeNumber(riskProfileGate.position_multiplier, 1) * runtimeGateMultiplier,
              4
            ),
            effective_trade_limit:
              runtimeBuyGate.action === 'reduce'
                ? Math.max(1, Math.min(safeNumber(riskProfileGate.effective_trade_limit, 1), 1))
                : riskProfileGate.effective_trade_limit,
            effective_default_position_pct: roundNumber(
              safeNumber(
                riskProfileGate.effective_default_position_pct,
                safeNumber(options.default_position_pct, 5)
              ) * runtimeGateMultiplier,
              2
            ),
            effective_max_position_pct: roundNumber(
              safeNumber(
                riskProfileGate.effective_max_position_pct,
                safeNumber(options.max_position_pct, 10)
              ) * runtimeGateMultiplier,
              2
            ),
            reason:
              runtimeBuyGate.action === 'reduce'
                ? `运行时非致命风险降仓：${runtimeBuyGate.conclusion || riskProfileGate.reason}`
                : runtimeBuyGate.conclusion || riskProfileGate.reason,
          };
    const effectiveRiskProfileGate = {
      ...mergedRiskProfileGate,
      ...(options.risk_profile_gate || {}),
    };

    const agentAnalysis = await this.submitAgentReview(archive.candidates, archive.signal_records, {
      ...options,
      trade_date,
      target_date: options.target_date || trade_date,
      agent_max_count: agentMaxCount,
      agent_min_score: agentMinScore,
      // Batch N (2026-06-17): 显式透传 dry_run_strategy_keys 让 agent path 尊重 dry-run.
      dry_run_strategy_keys: resolvedDryRunStrategyKeys,
    });

    let paperTrading: any = null;
    let paramExperimentPaperTrading: any = null;
    let strategyPortfolioExperiments: any[] = [];
    if (options.run_paper_trading) {
      paperTrading = await paperTradingAutomationService.autoBuyFromSignals({
        user_id: options.user_id,
        username: options.username,
        portfolio_name: pureQuantPortfolioName,
        initial_capital: options.initial_capital,
        force_new_portfolio: options.force_new_portfolio,
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
        signal_ids: archive.signal_ids,
        // Batch N: 直接 autoBuy path 同样尊重 dry-run lever
        dry_run_strategy_keys: resolvedDryRunStrategyKeys,
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
        risk_profile_gate: effectiveRiskProfileGate,
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
              ...effectiveRiskProfileGate,
              action: effectiveRiskProfileGate.action === 'pause' ? 'pause' : 'observe',
              reason:
                effectiveRiskProfileGate.action === 'pause'
                  ? effectiveRiskProfileGate.reason
                  : '参数实验盘仅做小仓 A/B 验证，默认降仓观察',
              position_multiplier: Math.min(
                0.45,
                safeNumber(effectiveRiskProfileGate.position_multiplier, 1)
              ),
              metadata_contains: {
                quant_candidate: true,
                quant_framework_signal: true,
              },
              param_experiment: true,
              lifecycle_summary: lifecycleSummary,
            },
          })
          .catch(error => {
            logger.warn(`参数实验模拟盘跟单失败，主闭环不受影响: ${error?.message || error}`);
            return null;
          });
      }
      if (useDefaultPortfolioFamily && options.run_strategy_portfolio_experiments !== false) {
        strategyPortfolioExperiments = await this.runStrategyPortfolioExperiments({
          options,
          archive_signal_ids: archive.signal_ids,
          effective_risk_profile_gate: effectiveRiskProfileGate,
          agent_min_score: agentMinScore,
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
        runtime_policy_diagnostics: generated.runtime_policy_diagnostics,
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
      runtime_health: runtimeHealth,
      runtime_buy_gate: runtimeBuyGate,
      runtime_risk_blocked: false,
      agent_analysis: agentAnalysis,
      paper_trading: paperTrading,
      param_experiment_paper_trading: paramExperimentPaperTrading,
      strategy_portfolio_experiments: strategyPortfolioExperiments,
      risk_profile: riskProfile || paperTrading?.risk_profile || preTradeRiskProfile || null,
      risk_profile_gate: effectiveRiskProfileGate,
      risk_threshold_suggestion: thresholdSuggestion,
      strategy_allocation_policy: strategyAllocationPolicy,
      message: this.buildResultMessage({
        generated,
        selectedCandidates,
        archive,
        agentAnalysis,
        paperTrading,
        paramLifecycle,
      }),
    };

    // 同上：默认不推，仅显式 true 才发
    if (options.report_to_feishu === true && options.notify_to_feishu_bot !== false) {
      await feishuBotWebhookService.sendRecommendationSummary({
        scenario: 'quant_daily_pipeline',
        record_type: '量化交易场景推荐',
        result,
      });
    }

    return result;
  }

  private async runStrategyPortfolioExperiments(params: {
    options: QuantDailyPipelineOptions;
    archive_signal_ids: number[];
    effective_risk_profile_gate: Record<string, any>;
    agent_min_score: number;
  }) {
    const { options, archive_signal_ids, effective_risk_profile_gate, agent_min_score } = params;
    if (!archive_signal_ids.length) return [];

    const results: any[] = [];
    for (const family of PAPER_PORTFOLIO_EXPERIMENT_FAMILIES) {
      const strategyKeys = [...family.strategy_keys];
      const familyRiskGate = {
        ...effective_risk_profile_gate,
        ...(family.risk_profile_gate || {}),
        action:
          effective_risk_profile_gate.action === 'pause'
            ? 'pause'
            : family.risk_profile_gate?.action || effective_risk_profile_gate.action,
        reason:
          effective_risk_profile_gate.action === 'pause'
            ? effective_risk_profile_gate.reason
            : family.risk_profile_gate?.reason || effective_risk_profile_gate.reason,
        metadata_contains: {
          quant_candidate: true,
          quant_framework_signal: true,
          ...(effective_risk_profile_gate.metadata_contains || {}),
        },
        strategy_family_key: family.key,
        strategy_filter_keys: strategyKeys,
      };

      const result = await paperTradingAutomationService
        .autoBuyFromSignals({
          user_id: options.user_id,
          username: options.username,
          portfolio_name: family.name,
          initial_capital: options.initial_capital,
          force_new_portfolio: options.force_new_portfolio,
          source_type: AISignalSourceType.QUANT_RECOMMENDATION,
          signal_ids: archive_signal_ids,
          strategy_keys: strategyKeys,
          strategy_family_key: family.key,
          limit: Math.min(
            Number(family.trade_limit || 2),
            Math.max(1, toPositiveInt(options.paper_trade_limit, 3, 20))
          ),
          scan_limit: toPositiveInt(
            options.paper_trade_scan_limit,
            Math.max(archive_signal_ids.length, 30),
            300
          ),
          min_score: Math.max(Number(family.min_score || 62), Math.min(agent_min_score, 70) - 8),
          max_positions: Math.min(
            Number(family.max_positions || 8),
            toPositiveInt(options.max_positions, 8, 30)
          ),
          default_position_pct: Math.min(
            Number(family.default_position_pct || 3),
            safeNumber(options.default_position_pct, 5)
          ),
          max_position_pct: Math.min(
            Number(family.max_position_pct || 6),
            safeNumber(options.max_position_pct, 10)
          ),
          min_trade_amount: safeNumber(options.min_trade_amount, 3000),
          allowed_risk_levels: [...family.allowed_risk_levels],
          require_action_buy: false,
          allow_watch_signals_for_sampling: true,
          dry_run: Boolean(options.dry_run),
          report_to_feishu: false,
          ignore_profit_gate_for_forced_signals: true,
          allow_min_lot_for_forced_signals: true,
          allow_min_lot_for_sampling_signals: true,
          use_profit_gate: true,
          use_outcome_feedback: true,
          use_entry_risk_guard: options.use_entry_risk_guard,
          max_daily_new_positions: Math.min(
            Number(family.trade_limit || 2),
            toPositiveInt(options.max_daily_new_positions, 3, 20)
          ),
          max_daily_new_exposure_pct: Math.min(
            Math.max(Number(family.default_position_pct || 3) * Number(family.trade_limit || 2), 5),
            safeNumber(options.max_daily_new_exposure_pct, 12)
          ),
          max_total_exposure_pct: Math.min(50, safeNumber(options.max_total_exposure_pct, 60)),
          max_industry_exposure_pct: Math.min(
            20,
            safeNumber(options.max_industry_exposure_pct, 25)
          ),
          min_cash_reserve_pct: Math.max(12, safeNumber(options.min_cash_reserve_pct, 8)),
          max_portfolio_drawdown_pct: Math.min(
            10,
            safeNumber(options.max_portfolio_drawdown_pct, 12)
          ),
          max_single_stock_volatility_pct: options.max_single_stock_volatility_pct,
          max_position_correlation: options.max_position_correlation,
          max_portfolio_var_pct: Math.min(8, safeNumber(options.max_portfolio_var_pct, 10)),
          min_avg_turnover_yuan: options.min_avg_turnover_yuan,
          cooldown_days_after_loss: options.cooldown_days_after_loss,
          block_limit_up: options.block_limit_up,
          block_limit_down: options.block_limit_down,
          block_suspended: options.block_suspended,
          risk_profile_gate: familyRiskGate,
        })
        .catch(error => {
          logger.warn(`${family.label}跟单失败，其他实验盘继续: ${error?.message || error}`);
          return {
            portfolio_name: family.name,
            strategy_family_key: family.key,
            strategy_keys: strategyKeys,
            error: error?.message || String(error),
          };
        });

      results.push({
        key: family.key,
        label: family.label,
        portfolio_name: family.name,
        strategy_keys: strategyKeys,
        result,
      });
    }
    return results;
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

  private async getRecentBacktestPerformance(options: {
    trade_date: string;
    strategy_keys?: string[];
    lookback_days?: number;
  }): Promise<Map<string, StrategyRecentBacktestPerformance>> {
    const since = moment()
      .tz('Asia/Shanghai')
      .subtract(Number(options.lookback_days || 14), 'days')
      .toDate();
    const tasks = await QuantBacktestTask.findAll({
      where: {
        status: 'COMPLETED',
        end_date: { [Op.lte]: options.trade_date },
        created_at: { [Op.gte]: since },
      },
      order: [['created_at', 'DESC']],
      limit: 120,
    }).catch(error => {
      logger.warn(`读取近期量化回测任务失败，推荐门禁降级: ${error?.message || error}`);
      return [] as QuantBacktestTask[];
    });
    const taskIds = tasks.map(task => Number(task.id)).filter(Boolean);
    if (!taskIds.length) return new Map();

    const resultWhere: any = { task_id: { [Op.in]: taskIds } };
    if (options.strategy_keys?.length) {
      resultWhere.strategy_key = { [Op.in]: options.strategy_keys };
    }
    const results = await QuantBacktestResult.findAll({ where: resultWhere }).catch(error => {
      logger.warn(`读取近期量化回测结果失败，推荐门禁降级: ${error?.message || error}`);
      return [] as QuantBacktestResult[];
    });
    const taskById = new Map(tasks.map(task => [Number(task.id), task]));
    const groups = new Map<string, QuantBacktestResult[]>();
    for (const result of results) {
      const key = result.strategy_key;
      const existing = groups.get(key) || [];
      existing.push(result);
      groups.set(key, existing);
    }

    const performance = new Map<string, StrategyRecentBacktestPerformance>();
    for (const [strategy_key, rows] of groups.entries()) {
      if (!rows.length) continue;
      const avg = (values: number[]) =>
        values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      const buyFillCount = rows.reduce((sum, row) => {
        const diagnostics = asPlainObject(asPlainObject(row.metrics_json).execution_diagnostics);
        return sum + safeNumber(diagnostics.buy_fill_count, 0);
      }, 0);
      const closedTradeCount = rows.reduce((sum, row) => sum + safeNumber(row.trade_count, 0), 0);
      const openPositionCount = rows.reduce(
        (sum, row) => sum + safeNumber(asPlainObject(row.metrics_json).open_positions, 0),
        0
      );
      const avgReturn = round(avg(rows.map(row => safeNumber(row.total_return_pct, 0))), 4);
      const avgExcess = round(avg(rows.map(row => safeNumber(row.excess_return_pct, 0))), 4);
      const avgDrawdown = round(avg(rows.map(row => safeNumber(row.max_drawdown_pct, 0))), 4);
      const avgSharpe = round(avg(rows.map(row => safeNumber(row.sharpe_ratio, 0))), 4);
      let action: StrategyRecentBacktestPerformance['action'] = 'observe';
      if (rows.length >= 3 && buyFillCount >= 10) {
        if (avgExcess <= -2 && avgReturn < 0) action = 'pause';
        else if (avgExcess <= -0.5 || avgReturn < -0.5) action = 'reduce';
        else if (avgExcess >= 0.3 && avgReturn >= 0) action = 'support';
      }
      const latestTask = rows
        .map(row => taskById.get(Number(row.task_id)))
        .filter(Boolean)
        .sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')))[0];
      const reason = `近${rows.length}个回测分片，平均收益${
        avgReturn >= 0 ? '+' : ''
      }${avgReturn}%、超额${avgExcess >= 0 ? '+' : ''}${avgExcess}%、买入${buyFillCount}次`;
      performance.set(strategy_key, {
        strategy_key,
        task_samples: rows.length,
        buy_fill_count: buyFillCount,
        closed_trade_count: closedTradeCount,
        open_position_count: openPositionCount,
        avg_return_pct: avgReturn,
        avg_excess_return_pct: avgExcess,
        avg_drawdown_pct: avgDrawdown,
        avg_sharpe: avgSharpe,
        latest_task_end_date: latestTask?.end_date,
        latest_task_name: latestTask?.task_name,
        action,
        reason,
      });
    }

    return performance;
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
          sample_count: record.sample_count,
          closed_count: record.closed_count,
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
    const runtimePoliciesByStrategy = await quantStrategyService.getRuntimePoliciesByStrategy(
      options.strategy_keys
    );
    const recentBacktestPerformanceByStrategy = await this.getRecentBacktestPerformance({
      trade_date: options.trade_date,
      strategy_keys: options.strategy_keys,
    });

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
        this.toFusionCandidate(
          items,
          options.trade_date,
          strategyWeights,
          allocationByStrategy,
          runtimePoliciesByStrategy,
          recentBacktestPerformanceByStrategy
        )
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
        sample_count?: any;
        closed_count?: any;
        reason?: string;
        metrics?: Record<string, any>;
      }
    >,
    allocationByStrategy?: Map<string, any>,
    runtimePoliciesByStrategy: Record<string, Record<string, any>> = {},
    recentBacktestPerformanceByStrategy: Map<string, StrategyRecentBacktestPerformance> = new Map()
  ): QuantFusionCandidate | null {
    const sorted = [...items].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const best = sorted[0];
    if (!best) return null;

    const strategyKeys = uniqueValues(sorted.map(item => item.strategy_key));
    const strategyAdmissionGate = buildStrategyAdmissionGate(
      strategyKeys,
      strategyWeights,
      recentBacktestPerformanceByStrategy
    );
    if (strategyAdmissionGate.blocked) {
      return null;
    }
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
    const admissionPenalty = strategyAdmissionGate.score_penalty;
    const score = round(
      clamp(
        quantScore +
          consensusBonus +
          weightAdjustment +
          environmentAdjustment -
          riskPenalty -
          admissionPenalty
      ),
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
    const strongStrategySupport =
      strategyAdmissionGate.details.some(
        item =>
          ['increase', 'slight_increase'].includes(item.action) ||
          (item.closed_count >= 3 &&
            (!Number.isFinite(item.avg_excess_return_pct) || item.avg_excess_return_pct >= 0))
      ) ||
      (consensusCount >= 2 &&
        strategyAdmissionGate.details.some(
          item => item.closed_count > 0 || item.sample_count >= 3
        ));
    const recentBacktestSupport = strategyKeys
      .map(key => recentBacktestPerformanceByStrategy.get(key))
      .filter(Boolean) as StrategyRecentBacktestPerformance[];
    const recentPerformanceGate = {
      enabled: recentBacktestSupport.length > 0,
      support_count: recentBacktestSupport.filter(item => item.action === 'support').length,
      reduce_count: recentBacktestSupport.filter(item => item.action === 'reduce').length,
      pause_count: recentBacktestSupport.filter(item => item.action === 'pause').length,
      observe_count: recentBacktestSupport.filter(item => item.action === 'observe').length,
      buy_allowed:
        recentBacktestSupport.length === 0 ||
        recentBacktestSupport.some(item => item.action === 'support') ||
        (consensusCount >= 3 &&
          recentBacktestSupport.every(item => !['pause', 'reduce'].includes(item.action)) &&
          recentBacktestSupport.some(item => item.avg_excess_return_pct >= -0.25)),
      details: recentBacktestSupport,
    };
    const action =
      sellVotes > 0 && sellVotes >= buyVotes
        ? 'avoid'
        : best.signal === 'buy' &&
          score >= 74 &&
          strongStrategySupport &&
          recentPerformanceGate.buy_allowed &&
          riskFlags.length <= 1
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
    const runtimePolicy = runtimePoliciesByStrategy[best.strategy_key] || {};
    const executionPolicy = asPlainObject(
      asPlainObject(best.raw_factors || {}).strategy_runtime_policy ||
        runtimePolicy.execution_policy
    );
    const environmentPolicy = asPlainObject(
      asPlainObject(best.raw_factors || {}).strategy_environment_policy ||
        runtimePolicy.environment_policy
    );
    const policyDefaultPositionPct = safeNumber(executionPolicy.default_position_pct, 0);
    const policyMaxPositionPct = safeNumber(executionPolicy.max_position_pct, 0);
    const strategyMaxSingleTradePct = primaryAllocation
      ? safeNumber(primaryAllocation.max_single_trade_pct, 0)
      : 0;
    const strategyAllocationPct = primaryAllocation
      ? safeNumber(primaryAllocation.allocation_pct, 0)
      : 0;
    const baseSuggestedPositionPct =
      action === 'buy'
        ? clamp(
            policyDefaultPositionPct || 3 + (score - 70) / 5 + consensusCount,
            1,
            policyMaxPositionPct || 10
          )
        : action === 'watch'
        ? clamp(1 + (score - 60) / 8, 1, 4)
        : 0;
    const effectiveSingleTradeCap = Math.min(
      ...[strategyMaxSingleTradePct, policyMaxPositionPct || undefined, 10]
        .map(item => safeNumber(item, 0))
        .filter(item => item > 0)
    );
    const suggestedPositionPct =
      action === 'buy' && effectiveSingleTradeCap > 0
        ? Math.min(baseSuggestedPositionPct, effectiveSingleTradeCap)
        : baseSuggestedPositionPct;
    const strategyBudgetDiscipline = buildStrategyBudgetDecision(primaryAllocation, {
      effective_single_trade_cap: effectiveSingleTradeCap,
      suggested_position_pct: round(suggestedPositionPct, 2),
      strategy_keys: strategyKeys,
    });

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
        effectiveSingleTradeCap > 0 ? round(effectiveSingleTradeCap, 2) : undefined,
      strategy_max_single_trade_amount: primaryAllocation?.max_single_trade_amount,
      strategy_budget_action: strategyBudgetDiscipline.action,
      strategy_budget_label: strategyBudgetDiscipline.label,
      strategy_budget_reason: strategyBudgetDiscipline.reason,
      strategy_budget_confidence: strategyBudgetDiscipline.sample_confidence,
      strategy_budget_discipline: strategyBudgetDiscipline,
      strategy_runtime_policy: {
        execution_policy: executionPolicy,
        environment_policy: environmentPolicy,
      },
      risk_level: riskLevel,
      strategy_key: best.strategy_key,
      strategy_keys: strategyKeys,
      consensus_count: consensusCount,
      consensus_bonus: consensusBonus,
      quant_signal_ids: sorted.map(item => item.id).filter(Boolean),
      reasons: reasons.length ? reasons : ['量化策略给出正向候选，但核心理由不足，需Agent复核'],
      risk_flags: [
        ...riskFlags,
        ...strategyAdmissionGate.reasons.map(reason => `策略门禁：${reason}`),
        ...strategyAdmissionGate.warnings,
        ...(!recentPerformanceGate.buy_allowed
          ? ['近期全市场回测未支持自动买入，本轮降级观察/等待Agent复核']
          : []),
      ],
      factors: {
        best_strategy_key: best.strategy_key,
        best_raw_factors: best.raw_factors || {},
        param_versions: paramVersions,
        param_version_keys: paramVersionKeys,
        market_environment: marketEnvironment,
        strategy_weight: round(avgStrategyWeight, 4),
        strategy_weight_adjustment: round(weightAdjustment, 4),
        environment_weight_adjustment: environmentAdjustment,
        strategy_admission_gate: strategyAdmissionGate,
        strategy_admission_penalty: admissionPenalty,
        recent_backtest_performance_gate: recentPerformanceGate,
        regime_adjustments: regimeAdjustments,
        strategy_weight_details: strategyKeys.map(key => ({
          strategy_key: key,
          ...(strategyWeights.get(key) || { weight: 1, action: 'observe' }),
        })),
        strategy_allocation_policy: primaryAllocation,
        strategy_allocation_candidates: allocationCandidates.slice(0, 5),
        strategy_budget_discipline: strategyBudgetDiscipline,
        strategy_runtime_policy: executionPolicy,
        strategy_environment_policy: environmentPolicy,
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
            strategy_runtime_policy: candidate.strategy_runtime_policy,
            fusion_formula:
              'quant_score + consensus_bonus + strategy_weight_adjustment + environment_weight_adjustment - risk_penalty - strategy_admission_penalty',
            strategy_allocation_policy: candidate.factors?.strategy_allocation_policy,
            strategy_budget_discipline: candidate.strategy_budget_discipline,
            market_environment: candidate.factors?.market_environment,
            regime_adjustments: candidate.factors?.regime_adjustments,
            recent_backtest_performance_gate: candidate.factors?.recent_backtest_performance_gate,
          },
          market_environment: candidate.factors?.market_environment,
          suggested_position_pct: candidate.suggested_position_pct,
          strategy_allocation_pct: candidate.strategy_allocation_pct,
          strategy_allocation_amount: candidate.strategy_allocation_amount,
          strategy_max_single_trade_pct: candidate.strategy_max_single_trade_pct,
          strategy_max_single_trade_amount: candidate.strategy_max_single_trade_amount,
          strategy_allocation_policy: candidate.factors?.strategy_allocation_policy,
          strategy_budget_action: candidate.strategy_budget_action,
          strategy_budget_label: candidate.strategy_budget_label,
          strategy_budget_reason: candidate.strategy_budget_reason,
          strategy_budget_confidence: candidate.strategy_budget_confidence,
          strategy_budget_discipline: candidate.strategy_budget_discipline,
          strategy_runtime_policy: candidate.strategy_runtime_policy,
          stop_loss_pct: candidate.stop_loss_pct,
          take_profit_pct: candidate.take_profit_pct,
          factors: compactFactors(candidate.factors?.best_raw_factors),
          metrics: {
            quant_score: candidate.quant_score,
            fusion_score: candidate.score,
            consensus_count: candidate.consensus_count,
            environment_weight_adjustment: candidate.factors?.environment_weight_adjustment,
            strategy_admission_penalty: candidate.factors?.strategy_admission_penalty,
            stop_loss_price: candidate.stop_loss_price,
            take_profit_price: candidate.take_profit_price,
            strategy_allocation_pct: candidate.strategy_allocation_pct,
            strategy_max_single_trade_pct: candidate.strategy_max_single_trade_pct,
            strategy_budget_action: candidate.strategy_budget_action,
            strategy_budget_confidence: candidate.strategy_budget_confidence,
          },
          recent_backtest_performance_gate: candidate.factors?.recent_backtest_performance_gate,
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
          ['buy', 'watch'].includes(candidate.action) &&
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
          reason: !['buy', 'watch'].includes(candidate.action)
            ? '不是买入/观察动作'
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
              strategy_budget_discipline: candidate.strategy_budget_discipline,
              strategy_runtime_policy: candidate.strategy_runtime_policy,
              market_environment: candidate.factors?.market_environment,
              regime_adjustments: candidate.factors?.regime_adjustments,
              quant_review_entry_action: candidate.action,
              recent_backtest_performance_gate: candidate.factors?.recent_backtest_performance_gate,
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
            // Batch N (2026-06-17): 透传 dry-run lever 到 worker → autoBuyFromSignals
            dry_run_strategy_keys: options.dry_run_strategy_keys,
            paper_trade_initial_capital: options.initial_capital,
            paper_trade_force_new_portfolio: options.force_new_portfolio,
            paper_trade_min_score: safeNumber(
              options.agent_paper_trade_min_score,
              Math.min(options.agent_min_score, 54)
            ),
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
            allow_low_data_quality_for_forced_signals: true,
            strategy_allocation_policy: candidate.factors?.strategy_allocation_policy,
            strategy_runtime_policy: candidate.strategy_runtime_policy,
            strategy_allocation_pct: candidate.strategy_allocation_pct,
            strategy_max_single_trade_pct: candidate.strategy_max_single_trade_pct,
            strategy_budget_discipline: candidate.strategy_budget_discipline,
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
    paramLifecycle?: any;
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
      payload.paramLifecycle
        ? `参数生命周期：应用 ${payload.paramLifecycle.applied || 0} 条，晋级 ${
            payload.paramLifecycle.lifecycle?.summary?.promotion_count || 0
          } / 降级 ${payload.paramLifecycle.lifecycle?.summary?.degradation_count || 0} / 回滚 ${
            payload.paramLifecycle.lifecycle?.summary?.rollback_count || 0
          }。`
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
