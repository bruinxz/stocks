import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { AIInvestmentSignal } from '../models/AIInvestmentSignal';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { User } from '../models/User';
import { benchmarkIndexService } from './BenchmarkIndexService';
import { paperTradingAutomationService } from './PaperTradingAutomationService';
import { feishuTaskReportService } from './FeishuTaskReportService';
import { recommendationLoopPolicySnapshotService } from './RecommendationLoopPolicySnapshotService';
import { normalizeSymbol, extractMarket } from '../utils/stockSymbol';
import { logger } from '../utils/logger';
import {
  recommendationScorePositionKey,
  recommendationScorePositionLabel,
  recommendationStrategyKeyLabel,
} from '../utils/recommendationStrategyVariant';

export interface RecommendationTradeOutcomeRefreshOptions {
  user_id?: number;
  username?: string;
  portfolio_id?: number;
  portfolio_name?: string;
  initial_capital?: number;
  force_new_portfolio?: boolean;
  loop_run_id?: string;
  include_open?: boolean;
  lookback_days?: number;
  source_type?: string;
  agent_session?: string;
  signal_id?: number;
  limit?: number;
  report_to_feishu?: boolean;
}

export interface RecommendationTradeOutcomeQueryOptions
  extends RecommendationTradeOutcomeRefreshOptions {
  trade_status?: string;
  start_date?: string;
  end_date?: string;
  offset?: number;
}

export interface RecommendationTradeOutcomeOptimizationOptions
  extends RecommendationTradeOutcomeQueryOptions {
  horizons?: string[] | string;
}

export interface RecommendationTradeOutcomeSummary {
  total_count: number;
  open_count: number;
  closed_count: number;
  win_count: number;
  loss_count: number;
  excess_win_count: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_pnl: number;
  avg_total_pnl_pct: number;
  avg_closed_return_pct: number;
  avg_excess_return_pct: number;
  win_rate: number;
  excess_win_rate: number;
  payoff_ratio: number;
  profit_factor: number;
  avg_holding_days: number;
  avg_mfe_pct: number;
  avg_mae_pct: number;
  open_exposure: number;
  best_trade?: any;
  worst_trade?: any;
}

export interface RecommendationTradeOutcomeDashboard {
  generated_at: string;
  portfolio_id: number;
  user_id: number;
  filters: Record<string, any>;
  summary: RecommendationTradeOutcomeSummary;
  groups: {
    by_source_type: RecommendationTradeOutcomeBucket[];
    by_agent_session: RecommendationTradeOutcomeBucket[];
    by_style: RecommendationTradeOutcomeBucket[];
    by_action: RecommendationTradeOutcomeBucket[];
    by_risk_level: RecommendationTradeOutcomeBucket[];
    by_industry: RecommendationTradeOutcomeBucket[];
    by_consensus: RecommendationTradeOutcomeBucket[];
    by_score_position_bucket: RecommendationTradeOutcomeBucket[];
    by_strategy_key: RecommendationTradeOutcomeBucket[];
    by_market_regime: RecommendationTradeOutcomeBucket[];
    by_industry_regime: RecommendationTradeOutcomeBucket[];
    by_environment_policy_version: RecommendationTradeOutcomeBucket[];
    by_environment_strategy_combo: RecommendationTradeOutcomeBucket[];
    by_resample: RecommendationTradeOutcomeBucket[];
  };
  outcomes: RecommendationTradeOutcome[];
  feedback: {
    recommended_min_score: number;
    position_multiplier: number;
    allowed_risk_levels: string[];
    best_segments: RecommendationTradeOutcomeBucket[];
    weak_segments: RecommendationTradeOutcomeBucket[];
    insights: string[];
    next_actions: string[];
  };
}

export interface RecommendationTradeOutcomeBucket {
  key: string;
  label: string;
  count: number;
  open_count: number;
  closed_count: number;
  tracked_count?: number;
  win_rate: number;
  excess_win_rate: number;
  avg_return_pct: number;
  avg_excess_return_pct: number;
  total_pnl: number;
  profit_factor: number;
  avg_holding_days: number;
  best_symbol?: string;
  best_name?: string;
  best_return_pct?: number;
  worst_symbol?: string;
  worst_name?: string;
  worst_return_pct?: number;
  avg_consensus_count?: number;
  avg_consensus_bonus?: number;
  dimension?: string;
  auto_action?: string;
  confidence?: number;
  robust_score?: number;
  sample_confidence?: number;
  bayesian_win_rate?: number;
  return_volatility_pct?: number;
  drawdown_penalty?: number;
  risk_adjusted_excess_return_pct?: number;
  takeover_ready?: boolean;
  takeover_reason?: string;
  cooldown_active?: boolean;
  cooldown_reason?: string;
  recent_loss_streak?: number;
  cooldown_days?: number;
  resample_ready?: boolean;
  resample_reason?: string;
  resample_position_multiplier?: number;
  resample_closed_count?: number;
  resample_avg_excess_return_pct?: number;
  resample_win_rate?: number;
  resample_excess_win_rate?: number;
  resample_total_pnl?: number;
  resample_profit_factor?: number;
  resample_decision?: 'promote' | 'continue_sampling' | 'cooldown' | 'observe';
  resample_decision_reason?: string;
  resample_recovery_ready?: boolean;
  resample_recovery_position_multiplier?: number;
  cooldown_extended?: boolean;
  cooldown_extension_days?: number;
  cooldown_expires_at?: string;
  resample_policy_action?:
    | 'recover_small'
    | 'extend_cooldown'
    | 'continue_resample'
    | 'observe'
    | 'none';
}

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toOptionalNumber(value: any): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  const normalized = Math.floor(num);
  return max ? Math.min(normalized, max) : normalized;
}

function toBoolean(value: any, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function roundNumber(value: any, digits = 2): number {
  const num = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function getChinaToday(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function consensusGroupKey(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const consensusCount = toNumber(signalMetadata.consensus_count, 0);
  if (consensusCount >= 4) return 'consensus_4_plus';
  if (consensusCount === 3) return 'consensus_3';
  if (consensusCount === 2) return 'consensus_2';
  return 'no_consensus';
}

function consensusGroupLabel(key: string): string {
  const labels: Record<string, string> = {
    consensus_4_plus: '4组以上共识',
    consensus_3: '3组共识',
    consensus_2: '2组共识',
    no_consensus: '无显式共识',
  };
  return labels[key] || key;
}

function marketRegimeKey(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const env =
    asPlainObject(metadata.market_environment).market_regime ||
    asPlainObject(signalMetadata.market_environment).market_regime;
  return String(env || 'unknown');
}

function marketRegimeLabel(key: string): string {
  const labels: Record<string, string> = {
    bull: '市场强势',
    bear: '市场弱势',
    range: '震荡市',
    rebound: '反弹市',
    stress: '压力市',
    unknown: '环境未知',
  };
  return labels[key] || key || '环境未知';
}

function industryRegimeKey(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const industry =
    asPlainObject(asPlainObject(metadata.market_environment).industry).regime ||
    asPlainObject(asPlainObject(signalMetadata.market_environment).industry).regime;
  return String(industry || 'unknown');
}

function industryRegimeLabel(key: string): string {
  const labels: Record<string, string> = {
    hot: '行业强势',
    warm: '行业中性',
    cold: '行业弱势',
    unknown: '行业未知',
  };
  return labels[key] || key || '行业未知';
}

function environmentPolicyVersionKey(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const environmentPolicy = asPlainObject(
    metadata.environment_policy ||
      signalMetadata.environment_policy ||
      paperTrading.environment_policy ||
      asPlainObject(signalMetadata.paper_trading).environment_policy
  );
  return String(
    metadata.environment_policy_snapshot_id ||
      signalMetadata.environment_policy_snapshot_id ||
      paperTrading.environment_policy_snapshot_id ||
      environmentPolicy.external_policy_snapshot_id ||
      environmentPolicy.snapshot_id ||
      environmentPolicy.id ||
      'unknown'
  );
}

function environmentPolicyVersionLabel(key: string): string {
  if (!key || key === 'unknown') return '环境版本未知';
  const parts = String(key).split('_env_');
  if (parts.length >= 2) return `环境闸门 ${parts[1]}`;
  return key;
}

function strategyKeyFromOutcome(record: RecommendationTradeOutcome): string {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  return (
    metadata.strategy_key ||
    signalMetadata.strategy_key ||
    asPlainObject(signalMetadata.strategy_variant).strategy_key ||
    paperTrading.strategy_key ||
    asPlainObject(paperTrading.strategy_variant).strategy_key ||
    'unknown'
  );
}

function environmentStrategyComboKey(record: RecommendationTradeOutcome): string {
  return `env:${environmentPolicyVersionKey(record)}|strategy:${strategyKeyFromOutcome(record)}`;
}

function environmentStrategyComboLabel(key: string): string {
  const envMatch = String(key || '').match(/env:([^|]+)/);
  const strategyMatch = String(key || '').match(/strategy:(.+)$/);
  const envKey = envMatch?.[1] || 'unknown';
  const strategyKey = strategyMatch?.[1] || 'unknown';
  return `${environmentPolicyVersionLabel(envKey)} × ${recommendationStrategyKeyLabel(
    strategyKey
  )}`;
}

function isResampleOutcome(record: RecommendationTradeOutcome): boolean {
  const metadata = asPlainObject(record.metadata);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const environmentPolicy = asPlainObject(
    metadata.environment_policy ||
      paperTrading.environment_policy ||
      signalMetadata.environment_policy ||
      asPlainObject(signalMetadata.paper_trading).environment_policy
  );
  return Boolean(
    metadata.resample_sample ||
      paperTrading.resample_sample ||
      signalMetadata.resample_sample ||
      environmentPolicy.resample_match ||
      metadata.resample_match ||
      paperTrading.resample_match
  );
}

function resampleGroupKey(record: RecommendationTradeOutcome): string {
  return isResampleOutcome(record) ? 'resample' : 'normal';
}

function resampleGroupLabel(key: string): string {
  return key === 'resample' ? '冷却复采样' : '常规推荐';
}

function dateOnly(value?: Date | string | null): string {
  if (!value) return getChinaToday();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return moment(date).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function normalizeHorizonList(
  value?: string[] | string,
  fallback = ['1d', '3d', '5d', '10d', '20d']
) {
  const raw = Array.isArray(value) ? value : value ? String(value).split(',') : fallback;
  const normalized = raw
    .map(item => {
      const days = Number(String(item).replace(/[^\d]/g, ''));
      return Number.isFinite(days) && days > 0 ? `${days}d` : '';
    })
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : fallback;
}

function holdingDays(start?: Date | string | null, end?: Date | string | null): number {
  if (!start) return 0;
  const startMoment = moment(start).tz('Asia/Shanghai');
  const endMoment = end ? moment(end).tz('Asia/Shanghai') : moment().tz('Asia/Shanghai');
  if (!startMoment.isValid() || !endMoment.isValid()) return 0;
  return Math.max(0, endMoment.diff(startMoment, 'days'));
}

function average(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function standardDeviation(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (valid.length <= 1) return 0;
  const mean = average(valid);
  const variance = average(valid.map(value => (value - mean) ** 2));
  return Math.sqrt(Math.max(0, variance));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeDateWindow(startDate: string, endDate: string): { start: Date; end: Date } {
  return {
    start: new Date(`${startDate}T00:00:00.000Z`),
    end: new Date(`${endDate}T23:59:59.999Z`),
  };
}

function modelToPlain<T = any>(record: any): T {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
}

function sourceTypeLabel(value?: string): string {
  const labels: Record<string, string> = {
    quant_recommendation: '量化候选',
    tradingagents: 'TradingAgents',
    daily_screener: 'AI每日优选',
    manual_analysis: '手动分析',
  };
  return labels[String(value || '')] || value || '未标注';
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

function riskLabel(value?: string): string {
  const labels: Record<string, string> = {
    low: '低风险',
    medium: '中风险',
    high: '高风险',
  };
  return labels[String(value || '')] || value || '未标注';
}

function agentSessionLabel(value?: string): string {
  const labels: Record<string, string> = {
    close: '尾盘/收盘',
    midday: '午盘',
    morning: '早盘',
  };
  return labels[String(value || '')] || value || '未标注';
}

export class RecommendationTradeOutcomeService {
  async refreshOutcomeBySignal(
    signal_id: number,
    options: { report_to_feishu?: boolean } = {}
  ): Promise<RecommendationTradeOutcome | null> {
    const signal = await AIInvestmentSignal.findByPk(signal_id);
    if (!signal) return null;

    const paperTrading = asPlainObject(asPlainObject(signal.metadata).paper_trading);
    if (!paperTrading.portfolio_id) return null;

    const outcome = await this.upsertFromExecutedSignal(signal, {
      include_open: true,
      portfolio_id: Number(paperTrading.portfolio_id),
    });

    if (outcome && options.report_to_feishu) {
      await feishuTaskReportService.reportRecommendationTradeOutcomes(
        await this.getDashboard({ portfolio_id: outcome.portfolio_id, include_open: true }),
        { record_type: '推荐交易收益闭环刷新' }
      );
    }

    return outcome;
  }

  async refreshPortfolioOutcomes(options: RecommendationTradeOutcomeRefreshOptions = {}): Promise<{
    portfolio_id: number;
    user_id: number;
    refreshed: number;
    created_or_updated: number;
    skipped: number;
    failed: number;
    outcomes: RecommendationTradeOutcome[];
    dashboard: RecommendationTradeOutcomeDashboard;
  }> {
    const includeOpen = toBoolean(options.include_open, true);
    const limit = toPositiveInt(options.limit, 2000, 10000);
    const lookbackDays = toPositiveInt(options.lookback_days, 180, 3650);
    const portfolio = await this.resolvePortfolio(options);

    if (includeOpen) {
      await paperTradingAutomationService.syncLatestPricesAndSnapshot(portfolio.id);
    }

    const signalWhere: any = {};
    if (options.signal_id) signalWhere.id = options.signal_id;
    if (options.source_type && options.source_type !== 'all')
      signalWhere.source_type = options.source_type;
    if (options.agent_session) {
      signalWhere.metadata = { [Op.contains]: { agent_session: options.agent_session } };
    }
    if (lookbackDays > 0 && !options.signal_id) {
      signalWhere.signal_date = {
        [Op.gte]: moment().tz('Asia/Shanghai').subtract(lookbackDays, 'days').format('YYYY-MM-DD'),
      };
    }

    const candidateSignals = await AIInvestmentSignal.findAll({
      where: signalWhere,
      order: [
        ['updated_at', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit,
    });

    const signals = candidateSignals.filter(signal => {
      const paperTrading = asPlainObject(asPlainObject(signal.metadata).paper_trading);
      const status = String(paperTrading.status || '');
      return (
        Number(paperTrading.portfolio_id) === Number(portfolio.id) &&
        ['executed', 'closing', 'closed'].includes(status)
      );
    });

    const outcomes: RecommendationTradeOutcome[] = [];
    let failed = 0;
    let skipped = 0;

    for (const signal of signals) {
      try {
        const outcome = await this.upsertFromExecutedSignal(signal, {
          include_open: includeOpen,
          portfolio_id: portfolio.id,
        });
        if (outcome) outcomes.push(outcome);
        else skipped++;
      } catch (error: any) {
        failed++;
        logger.warn(
          `刷新推荐交易收益闭环失败 signal#${signal.id} ${signal.symbol}: ${
            error?.message || error
          }`
        );
      }
    }

    const dashboard = await this.getDashboard({
      ...options,
      portfolio_id: portfolio.id,
      include_open: includeOpen,
      report_to_feishu: false,
    });

    const result = {
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      refreshed: signals.length,
      created_or_updated: outcomes.length,
      skipped,
      failed,
      outcomes,
      dashboard,
    };

    if (toBoolean(options.report_to_feishu, false)) {
      await feishuTaskReportService.reportRecommendationTradeOutcomes(dashboard, {
        record_type: '推荐交易收益闭环刷新',
      });
    }

    const loopRunIds = Array.from(
      new Set(
        outcomes
          .map(outcome => outcome.loop_run_id)
          .filter((value): value is string => Boolean(value))
      )
    );
    if (loopRunIds.length > 0) {
      await recommendationLoopPolicySnapshotService.refreshOutcomeMetrics({
        loop_run_ids: loopRunIds,
        limit: Math.max(loopRunIds.length, 1),
      });
    }

    return result;
  }

  async listOutcomes(options: RecommendationTradeOutcomeQueryOptions = {}) {
    const portfolio = await this.resolvePortfolio(options);
    const limit = toPositiveInt(options.limit, 50, 500);
    const offset = Math.max(0, Number(options.offset || 0));
    const where = this.buildOutcomeWhere({ ...options, portfolio_id: portfolio.id });

    const { rows, count } = await RecommendationTradeOutcome.findAndCountAll({
      where,
      order: [
        ['trade_status', 'ASC'],
        ['exit_date', 'DESC NULLS LAST'],
        ['entry_date', 'DESC NULLS LAST'],
        ['updated_at', 'DESC'],
      ] as any,
      limit,
      offset,
    });

    return {
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      rows,
      count,
      limit,
      offset,
      summary: this.buildSummary(rows),
    };
  }

  async getDashboard(
    options: RecommendationTradeOutcomeQueryOptions = {}
  ): Promise<RecommendationTradeOutcomeDashboard> {
    const portfolio = await this.resolvePortfolio(options);
    const includeOpen = toBoolean(options.include_open, true);

    if (includeOpen) {
      try {
        await paperTradingAutomationService.syncLatestPricesAndSnapshot(portfolio.id);
      } catch (error: any) {
        logger.warn(`收益闭环看板刷新模拟盘快照失败: ${error?.message || error}`);
      }
    }

    const limit = toPositiveInt(options.limit, 2000, 10000);
    const where = this.buildOutcomeWhere({ ...options, portfolio_id: portfolio.id });
    if (!includeOpen) where.trade_status = 'closed';

    const outcomes = await RecommendationTradeOutcome.findAll({
      where,
      order: [
        ['trade_status', 'ASC'],
        ['exit_date', 'DESC NULLS LAST'],
        ['entry_date', 'DESC NULLS LAST'],
        ['updated_at', 'DESC'],
      ] as any,
      limit,
    });

    const summary = this.buildSummary(outcomes);
    const groups = {
      by_source_type: this.buildBuckets(outcomes, item => item.source_type, sourceTypeLabel),
      by_agent_session: this.buildBuckets(outcomes, item => item.agent_session, agentSessionLabel),
      by_style: this.buildBuckets(
        outcomes,
        item => item.recommendation_style,
        value => value || '未标注',
        'style'
      ),
      by_action: this.buildBuckets(
        outcomes,
        item => item.action_label || item.action,
        value => value || '未标注'
      ),
      by_risk_level: this.buildBuckets(outcomes, item => item.risk_level, riskLabel),
      by_industry: this.buildBuckets(
        outcomes,
        item => item.industry,
        value => value || '未分类'
      ),
      by_consensus: this.buildBuckets(
        outcomes,
        item => consensusGroupKey(item),
        consensusGroupLabel
      ),
      by_score_position_bucket: this.buildBuckets(
        outcomes,
        item => recommendationScorePositionKey(item.score, item.position_pct),
        recommendationScorePositionLabel,
        'score_position'
      ),
      by_strategy_key: this.buildBuckets(
        outcomes,
        item => strategyKeyFromOutcome(item),
        recommendationStrategyKeyLabel,
        'strategy_key'
      ),
      by_market_regime: this.buildBuckets(
        outcomes,
        item => marketRegimeKey(item),
        marketRegimeLabel,
        'market_regime'
      ),
      by_industry_regime: this.buildBuckets(
        outcomes,
        item => industryRegimeKey(item),
        industryRegimeLabel,
        'industry_regime'
      ),
      by_environment_policy_version: this.buildBuckets(
        outcomes,
        item => environmentPolicyVersionKey(item),
        environmentPolicyVersionLabel,
        'environment_policy_version'
      ),
      by_environment_strategy_combo: this.buildBuckets(
        outcomes,
        item => environmentStrategyComboKey(item),
        environmentStrategyComboLabel,
        'environment_strategy_combo'
      ),
      by_resample: this.buildBuckets(
        outcomes,
        item => resampleGroupKey(item),
        resampleGroupLabel,
        'resample'
      ),
    };

    const dashboard: RecommendationTradeOutcomeDashboard = {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      portfolio_id: portfolio.id,
      user_id: portfolio.user_id,
      filters: {
        include_open: includeOpen,
        source_type: options.source_type || 'all',
        agent_session: options.agent_session || '',
        loop_run_id: options.loop_run_id || '',
        trade_status: options.trade_status || '',
        start_date: options.start_date || '',
        end_date: options.end_date || '',
        lookback_days: options.lookback_days || '',
      },
      summary,
      groups,
      outcomes: outcomes.slice(0, 200),
      feedback: this.buildFeedback(summary, groups),
    };

    if (toBoolean(options.report_to_feishu, false)) {
      await feishuTaskReportService.reportRecommendationTradeOutcomes(dashboard, {
        record_type: '推荐交易收益闭环看板',
      });
    }

    return dashboard;
  }

  async getOptimizationDashboard(options: RecommendationTradeOutcomeOptimizationOptions = {}) {
    const portfolio = await this.resolvePortfolio(options);
    const horizons = normalizeHorizonList(options.horizons);
    const lookbackDays = toPositiveInt(options.lookback_days, 180, 3650);
    const outcomeDashboard = await this.getDashboard({
      ...options,
      portfolio_id: portfolio.id,
      include_open: true,
      lookback_days: lookbackDays,
      limit: toPositiveInt(options.limit, 2000, 10000),
      report_to_feishu: false,
    });

    const outcomes = outcomeDashboard.outcomes.map(item => modelToPlain<any>(item));
    const signalIds = outcomes
      .map(item => Number(item.signal_id))
      .filter(value => Number.isFinite(value) && value > 0);
    const signals = signalIds.length
      ? await AIInvestmentSignal.findAll({
          where: { id: { [Op.in]: signalIds } },
          raw: true,
        })
      : [];
    const signalById = new Map<number, any>();
    signals.forEach((signal: any) => signalById.set(Number(signal.id), signal));

    const pathSamples = this.buildPathSamples(outcomes, signalById, horizons);
    const horizon_path = horizons.map(horizon => {
      const samples = pathSamples.filter(item => item.horizon === horizon);
      const wins = samples.filter(item => item.directional_return_pct > 0);
      const excessWins = samples.filter(item => Number(item.excess_return_pct || 0) > 0);
      return {
        horizon,
        horizon_days: Number(horizon.replace('d', '')),
        count: samples.length,
        completed_count: samples.length,
        avg_return_pct: roundNumber(average(samples.map(item => item.return_pct)), 4),
        avg_directional_return_pct: roundNumber(
          average(samples.map(item => item.directional_return_pct)),
          4
        ),
        avg_excess_return_pct: roundNumber(average(samples.map(item => item.excess_return_pct)), 4),
        win_rate: samples.length ? roundNumber((wins.length / samples.length) * 100, 2) : 0,
        excess_win_rate: samples.length
          ? roundNumber((excessWins.length / samples.length) * 100, 2)
          : 0,
        best_symbol: [...samples].sort(
          (a, b) => b.directional_return_pct - a.directional_return_pct
        )[0]?.symbol,
        worst_symbol: [...samples].sort(
          (a, b) => a.directional_return_pct - b.directional_return_pct
        )[0]?.symbol,
      };
    });

    const symbolPaths = this.buildSymbolPathSummaries(pathSamples, outcomes);
    const openOutcomes = outcomes.filter(item => item.trade_status !== 'closed');
    const closedOutcomes = outcomes.filter(item => item.trade_status === 'closed');
    const bestHorizon = [...horizon_path]
      .filter(item => item.count > 0)
      .sort(
        (a, b) =>
          b.avg_directional_return_pct - a.avg_directional_return_pct ||
          b.excess_win_rate - a.excess_win_rate ||
          b.count - a.count
      )[0];
    const currentHoldDays = roundNumber(
      average(openOutcomes.map(item => toNumber(item.holding_days))),
      2
    );
    const closedAvgHoldDays = roundNumber(
      average(closedOutcomes.map(item => toNumber(item.holding_days))),
      2
    );
    const recommendedMaxHoldDays = bestHorizon
      ? Math.max(5, Math.min(30, Number(bestHorizon.horizon_days || 10) * 2))
      : 20;
    const stopLossCandidates = closedOutcomes
      .map(item => Math.abs(toNumber(item.max_adverse_excursion_pct)))
      .filter(value => Number.isFinite(value) && value > 0);
    const takeProfitCandidates = closedOutcomes
      .map(item => toNumber(item.max_favorable_excursion_pct))
      .filter(value => Number.isFinite(value) && value > 0);
    const avgMfePct = average(takeProfitCandidates);
    const avgMaeAbsPct = average(stopLossCandidates);
    const weakOutcome =
      outcomeDashboard.summary.avg_closed_return_pct < 0 ||
      outcomeDashboard.summary.avg_excess_return_pct < -1 ||
      outcomeDashboard.summary.win_rate < 45 ||
      outcomeDashboard.summary.profit_factor < 0.9;
    const strongOutcome =
      outcomeDashboard.summary.avg_closed_return_pct > 2 &&
      outcomeDashboard.summary.avg_excess_return_pct > 0.8 &&
      outcomeDashboard.summary.win_rate >= 55 &&
      outcomeDashboard.summary.profit_factor >= 1.2;
    const adaptiveStopLoss = roundNumber(
      clamp(avgMaeAbsPct ? avgMaeAbsPct * (weakOutcome ? 0.85 : 1.1) : 7, 4, 10),
      2
    );
    const adaptiveTakeProfit = roundNumber(
      clamp(avgMfePct ? avgMfePct * (weakOutcome ? 0.72 : strongOutcome ? 0.9 : 0.82) : 14, 9, 22),
      2
    );
    const adaptiveTrailingActivation = roundNumber(
      clamp(avgMfePct ? avgMfePct * (weakOutcome ? 0.48 : strongOutcome ? 0.62 : 0.55) : 8, 5, 14),
      2
    );
    const adaptiveTrailingDrawdown = roundNumber(
      clamp(
        avgMaeAbsPct ? avgMaeAbsPct * (weakOutcome ? 0.55 : strongOutcome ? 0.75 : 0.65) : 4,
        2.5,
        7
      ),
      2
    );
    const adaptiveRisk = {
      recommended_max_hold_days: recommendedMaxHoldDays,
      recommended_stop_loss_pct: adaptiveStopLoss,
      recommended_take_profit_pct: adaptiveTakeProfit,
      recommended_trailing_activation_pct: adaptiveTrailingActivation,
      recommended_trailing_drawdown_pct: adaptiveTrailingDrawdown,
      current_open_avg_holding_days: currentHoldDays,
      closed_avg_holding_days: closedAvgHoldDays,
      best_horizon: bestHorizon || null,
      sample_count: closedOutcomes.length,
      confidence: roundNumber(clamp(closedOutcomes.length / 10, 0, 1), 2),
      mode: weakOutcome ? 'defensive' : strongOutcome ? 'growth' : 'balanced',
      reason: weakOutcome
        ? '闭环收益偏弱，建议收紧止损/止盈与移动止盈触发'
        : strongOutcome
        ? '闭环收益偏强，建议给强势标的更多收益空间'
        : '闭环收益中性，按 MFE/MAE 小幅校准风控参数',
    };

    const strategyComboGroups = outcomeDashboard.groups.by_strategy_key || [];
    const scorePositionGroups = outcomeDashboard.groups.by_score_position_bucket || [];
    const marketRegimeGroups = outcomeDashboard.groups.by_market_regime || [];
    const industryRegimeGroups = outcomeDashboard.groups.by_industry_regime || [];
    const environmentVersionGroups = outcomeDashboard.groups.by_environment_policy_version || [];
    const environmentStrategyComboGroups =
      outcomeDashboard.groups.by_environment_strategy_combo || [];
    const environmentPolicy = this.buildEnvironmentLoopPolicy({
      market_regime_groups: marketRegimeGroups,
      industry_regime_groups: industryRegimeGroups,
      version_groups: environmentVersionGroups,
      weak_outcome: weakOutcome,
      strong_outcome: strongOutcome,
    });

    const policyDashboard = await recommendationLoopPolicySnapshotService
      .getDashboard({
        username: options.username,
        universe: 'market',
        limit: 120,
      } as any)
      .catch(error => {
        logger.warn(`读取策略版本优化建议失败: ${error?.message || error}`);
        return null;
      });
    const promotion = policyDashboard?.promotion || null;
    const nextPolicy = {
      recommended_style: promotion?.recommended_style || 'balanced',
      recommended_min_score:
        promotion?.recommended_min_score || outcomeDashboard.feedback.recommended_min_score,
      recommended_default_position_pct: promotion?.recommended_default_position_pct || 3,
      recommended_max_position_pct: promotion?.recommended_max_position_pct || 6,
      recommended_paper_trade_limit: promotion?.recommended_paper_trade_limit || 2,
      confidence: promotion?.confidence || 0,
      action: promotion?.action || 'collect_samples',
      reasons: Array.isArray(promotion?.reasons) ? promotion.reasons.slice(0, 4) : [],
      environment_position_multiplier: environmentPolicy.default_position_multiplier,
      environment_confidence: environmentPolicy.confidence,
      environment_blocked_segments: environmentPolicy.blocked_segments.slice(0, 5),
      environment_reduced_segments: environmentPolicy.reduced_segments.slice(0, 5),
      environment_boosted_segments: environmentPolicy.boosted_segments.slice(0, 5),
    };

    const weakSegments = outcomeDashboard.feedback.weak_segments.slice(0, 4);
    const bestSegments = outcomeDashboard.feedback.best_segments.slice(0, 4);
    const bestStrategyCombo = strategyComboGroups
      .filter(segment => segment.key !== 'unknown' && segment.closed_count > 0)
      .sort(
        (a, b) =>
          toNumber(b.robust_score) - toNumber(a.robust_score) ||
          b.avg_excess_return_pct - a.avg_excess_return_pct ||
          b.excess_win_rate - a.excess_win_rate
      )[0];
    const weakStrategyCombo = strategyComboGroups
      .filter(segment => segment.key !== 'unknown' && segment.closed_count > 0)
      .sort(
        (a, b) =>
          toNumber(a.robust_score) - toNumber(b.robust_score) ||
          a.avg_excess_return_pct - b.avg_excess_return_pct ||
          a.excess_win_rate - b.excess_win_rate
      )[0];
    const killList = weakSegments
      .filter(segment => segment.closed_count >= 2 && segment.avg_excess_return_pct < -1)
      .map(segment => ({
        dimension: '收益片段',
        key: segment.key,
        label: segment.label,
        closed_count: segment.closed_count,
        avg_excess_return_pct: segment.avg_excess_return_pct,
        action: '下一轮降权或暂停自动跟单',
      }));
    const boostList = bestSegments
      .filter(segment => segment.closed_count >= 2 && segment.avg_excess_return_pct > 1)
      .map(segment => ({
        dimension: '收益片段',
        key: segment.key,
        label: segment.label,
        closed_count: segment.closed_count,
        avg_excess_return_pct: segment.avg_excess_return_pct,
        action: '下一轮优先保留小仓验证',
      }));

    const insights = [
      `自主模拟盘当前总盈亏 ${roundNumber(outcomeDashboard.summary.total_pnl, 2)}，闭环 ${
        outcomeDashboard.summary.closed_count
      }/${outcomeDashboard.summary.total_count} 笔，胜率 ${outcomeDashboard.summary.win_rate}%。`,
      bestHorizon
        ? `后验收益路径显示 ${bestHorizon.horizon} 当前更优，平均方向收益 ${bestHorizon.avg_directional_return_pct}%、超额胜率 ${bestHorizon.excess_win_rate}%。`
        : '收益路径样本不足，先继续让推荐进入小仓模拟盘沉淀样本。',
      `下一轮建议：${styleLabel(nextPolicy.recommended_style)} / 评分≥${
        nextPolicy.recommended_min_score
      } / 默认仓位 ${nextPolicy.recommended_default_position_pct}% / 跟单 ${
        nextPolicy.recommended_paper_trade_limit
      } 笔。`,
      killList[0]
        ? `需降权片段：${killList[0].label}，平均超额 ${killList[0].avg_excess_return_pct}%。`
        : '暂无明确需要永久剔除的片段，继续以收益闸门控制仓位。',
      bestStrategyCombo
        ? `参数组合冠军：${bestStrategyCombo.label}，稳健分 ${bestStrategyCombo.robust_score}，平均超额 ${bestStrategyCombo.avg_excess_return_pct}%、贝叶斯胜率 ${bestStrategyCombo.bayesian_win_rate}%。`
        : '',
      environmentStrategyComboGroups[0] &&
      !environmentStrategyComboGroups[0].key.includes('env:unknown') &&
      !environmentStrategyComboGroups[0].key.includes('strategy:unknown')
        ? `环境×策略冠军：${environmentStrategyComboGroups[0].label}，平均超额 ${environmentStrategyComboGroups[0].avg_excess_return_pct}%、闭环 ${environmentStrategyComboGroups[0].closed_count} 笔。`
        : '',
      environmentPolicy.blocked_segments[0]
        ? `环境闸门建议：暂停 ${environmentPolicy.blocked_segments[0].label}，原因 ${environmentPolicy.blocked_segments[0].reason}。`
        : environmentPolicy.reduced_segments[0]
        ? `环境闸门建议：${environmentPolicy.reduced_segments[0].label} 降至 ${environmentPolicy.reduced_segments[0].position_multiplier}x，小仓验证。`
        : environmentPolicy.boosted_segments[0]
        ? `环境闸门建议：优先小幅放大 ${environmentPolicy.boosted_segments[0].label}，倍率 ${environmentPolicy.boosted_segments[0].position_multiplier}x。`
        : '',
      environmentStrategyComboGroups.find(item => item.resample_recovery_ready)
        ? `复采样升降级：${
            environmentStrategyComboGroups.find(item => item.resample_recovery_ready)?.label
          } 复采样跑赢，下一轮解除冷却并以小仓恢复。`
        : environmentStrategyComboGroups.find(item => item.cooldown_extended)
        ? `复采样升降级：${
            environmentStrategyComboGroups.find(item => item.cooldown_extended)?.label
          } 复采样仍跑输，下一轮延长冷却。`
        : '',
    ].filter(Boolean);

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        initial_capital: toNumber(portfolio.initial_capital),
        total_value: toNumber(portfolio.total_value),
        current_cash: toNumber(portfolio.current_cash),
      },
      filters: {
        lookback_days: lookbackDays,
        horizons,
      },
      summary: outcomeDashboard.summary,
      feedback: outcomeDashboard.feedback,
      horizon_path,
      symbol_paths: symbolPaths,
      adaptive_risk: adaptiveRisk,
      next_policy: nextPolicy,
      segment_actions: {
        boost: boostList,
        reduce: killList,
      },
      strategy_combos: {
        best: bestStrategyCombo || null,
        weak: weakStrategyCombo || null,
        rankings: strategyComboGroups.slice(0, 8),
        score_position_rankings: scorePositionGroups.slice(0, 8),
      },
      environment_policy: environmentPolicy,
      market_environment: {
        market_regime_rankings: marketRegimeGroups.slice(0, 8),
        industry_regime_rankings: industryRegimeGroups.slice(0, 8),
        version_rankings: environmentVersionGroups
          .filter(item => item.key !== 'unknown')
          .slice(0, 10),
        strategy_combo_rankings: environmentStrategyComboGroups
          .filter(
            item =>
              item.key &&
              !item.key.includes('env:unknown') &&
              !item.key.includes('strategy:unknown')
          )
          .slice(0, 10),
        resample_summary: outcomeDashboard.groups.by_resample,
        resample_combo_rankings: environmentStrategyComboGroups
          .filter(item => toNumber(item.resample_closed_count, 0) > 0 || item.resample_decision)
          .sort(
            (a, b) =>
              toNumber(b.resample_avg_excess_return_pct, -999) -
                toNumber(a.resample_avg_excess_return_pct, -999) ||
              toNumber(b.resample_closed_count, 0) - toNumber(a.resample_closed_count, 0)
          )
          .slice(0, 8),
        policy: environmentPolicy,
      },
      policy_versions: policyDashboard
        ? {
            summary: policyDashboard.summary,
            promotion: policyDashboard.promotion,
            top_versions: (policyDashboard.rankings?.snapshots || []).slice(0, 5),
            top_strategy_combos: (policyDashboard.rankings?.by_strategy_key || []).slice(0, 5),
          }
        : null,
      insights,
    };
  }

  private buildEnvironmentLoopPolicy(options: {
    market_regime_groups: RecommendationTradeOutcomeBucket[];
    industry_regime_groups: RecommendationTradeOutcomeBucket[];
    version_groups?: RecommendationTradeOutcomeBucket[];
    weak_outcome: boolean;
    strong_outcome: boolean;
  }) {
    const marketGroups = options.market_regime_groups || [];
    const industryGroups = options.industry_regime_groups || [];
    const environmentGroups = [
      ...marketGroups.map(group => ({ ...group, dimension: group.dimension || 'market_regime' })),
      ...industryGroups.map(group => ({
        ...group,
        dimension: group.dimension || 'industry_regime',
      })),
    ].filter(group => group.key && group.key !== 'unknown' && group.closed_count > 0);

    const closedSamples = environmentGroups.reduce(
      (sum, group) => sum + toNumber(group.closed_count),
      0
    );
    const confidence = roundNumber(clamp(closedSamples / 24, 0, 1), 2);
    const defaultPositionMultiplier = options.weak_outcome
      ? 0.72
      : options.strong_outcome
      ? 1.04
      : 0.9;

    const normalizeSegment = (group: RecommendationTradeOutcomeBucket) => {
      const robustScore = toNumber(group.robust_score, 0);
      const avgExcess = toNumber(group.avg_excess_return_pct, 0);
      const riskAdjustedExcess = toNumber(group.risk_adjusted_excess_return_pct, avgExcess);
      const excessWinRate = toNumber(group.excess_win_rate, 0);
      const bayesianWinRate = toNumber(group.bayesian_win_rate, 50);
      const closedCount = toNumber(group.closed_count, 0);
      const sampleConfidence = toNumber(group.sample_confidence, clamp(closedCount / 10, 0, 1));

      let action = 'watch';
      let positionMultiplier = defaultPositionMultiplier;
      let reason = `样本 ${closedCount}，继续观察`;

      const shouldBlock =
        closedCount >= 3 &&
        (robustScore <= -6 || avgExcess <= -3 || riskAdjustedExcess <= -1.2 || excessWinRate < 30);
      const shouldReduce =
        closedCount >= 2 &&
        (robustScore <= -3 ||
          avgExcess < -1 ||
          riskAdjustedExcess < -0.8 ||
          bayesianWinRate < 45 ||
          excessWinRate < 40);
      const shouldBoost =
        closedCount >= 2 &&
        robustScore > 3 &&
        avgExcess > 1 &&
        riskAdjustedExcess > 0.5 &&
        bayesianWinRate >= 52 &&
        excessWinRate >= 50;

      if (shouldBlock) {
        action = 'block';
        positionMultiplier = 0;
        reason = `稳健分 ${roundNumber(robustScore, 2)}，平均超额 ${roundNumber(
          avgExcess,
          2
        )}%，暂停自动入场`;
      } else if (shouldReduce) {
        action = 'reduce';
        positionMultiplier = roundNumber(
          clamp(defaultPositionMultiplier * (sampleConfidence >= 0.6 ? 0.58 : 0.72), 0.35, 0.75),
          2
        );
        reason = `平均超额 ${roundNumber(avgExcess, 2)}%，贝叶斯胜率 ${roundNumber(
          bayesianWinRate,
          2
        )}%，降仓验证`;
      } else if (shouldBoost) {
        action = 'boost';
        positionMultiplier = roundNumber(
          clamp(defaultPositionMultiplier * (sampleConfidence >= 0.6 ? 1.14 : 1.06), 0.95, 1.15),
          2
        );
        reason = `平均超额 ${roundNumber(avgExcess, 2)}%，稳健分 ${roundNumber(
          robustScore,
          2
        )}，允许小幅放大`;
      }

      return {
        dimension: group.dimension,
        key: group.key,
        label: group.label,
        closed_count: closedCount,
        sample_confidence: roundNumber(sampleConfidence, 2),
        avg_excess_return_pct: roundNumber(avgExcess, 4),
        excess_win_rate: roundNumber(excessWinRate, 2),
        bayesian_win_rate: roundNumber(bayesianWinRate, 2),
        robust_score: roundNumber(robustScore, 4),
        risk_adjusted_excess_return_pct: roundNumber(riskAdjustedExcess, 4),
        action,
        position_multiplier: positionMultiplier,
        reason,
      };
    };

    const segments = environmentGroups.map(normalizeSegment).sort((a, b) => {
      const actionWeight: Record<string, number> = { block: 0, reduce: 1, watch: 2, boost: 3 };
      if (actionWeight[a.action] !== actionWeight[b.action]) {
        return actionWeight[a.action] - actionWeight[b.action];
      }
      return a.robust_score - b.robust_score;
    });
    const blockedSegments = segments.filter(segment => segment.action === 'block');
    const reducedSegments = segments.filter(segment => segment.action === 'reduce');
    const boostedSegments = segments
      .filter(segment => segment.action === 'boost')
      .sort(
        (a, b) =>
          b.robust_score - a.robust_score || b.avg_excess_return_pct - a.avg_excess_return_pct
      );
    const watchSegments = segments.filter(segment => segment.action === 'watch');

    return {
      enabled: true,
      confidence,
      closed_samples: closedSamples,
      default_position_multiplier: roundNumber(defaultPositionMultiplier, 2),
      blocked_segments: blockedSegments,
      reduced_segments: reducedSegments,
      boosted_segments: boostedSegments,
      watch_segments: watchSegments.slice(0, 8),
      version_rankings: (options.version_groups || [])
        .filter(group => group.key && group.key !== 'unknown')
        .slice(0, 8),
      rules: [
        '样本≥3且稳健分/超额收益显著转弱：暂停该环境自动入场',
        '样本≥2且平均超额或贝叶斯胜率偏弱：降仓小样本验证',
        '稳健分、平均超额、贝叶斯胜率均占优：仅小幅放大，不追高',
      ],
      reason: blockedSegments[0]
        ? `发现 ${blockedSegments.length} 个需暂停环境，优先保护本金`
        : reducedSegments[0]
        ? `发现 ${reducedSegments.length} 个需降仓环境，下一轮控制试错成本`
        : boostedSegments[0]
        ? `发现 ${boostedSegments.length} 个优势环境，可小幅放大验证`
        : '环境样本未出现显著优劣，维持保守仓位',
    };
  }

  async upsertFromExecutedSignal(
    signal: AIInvestmentSignal,
    options: { include_open?: boolean; portfolio_id?: number } = {}
  ): Promise<RecommendationTradeOutcome | null> {
    const metadata = asPlainObject(signal.metadata);
    const paperTrading = asPlainObject(metadata.paper_trading);
    const strategyVariant = asPlainObject(metadata.strategy_variant);
    const strategyKey =
      metadata.strategy_key ||
      strategyVariant.strategy_key ||
      paperTrading.strategy_key ||
      asPlainObject(paperTrading.strategy_variant).strategy_key;
    const environmentPolicy = asPlainObject(
      paperTrading.environment_policy || metadata.environment_policy
    );
    const environmentPolicySnapshotId =
      environmentPolicy.external_policy_snapshot_id ||
      environmentPolicy.snapshot_id ||
      metadata.environment_policy_snapshot_id;
    const portfolio_id = Number(options.portfolio_id || paperTrading.portfolio_id);
    if (!portfolio_id || !paperTrading.trade_id) return null;

    const entryTrade = await PaperTradingTrade.findOne({
      where: { id: Number(paperTrading.trade_id), portfolio_id },
    });
    const exitTrade = paperTrading.sell_trade_id
      ? await PaperTradingTrade.findOne({
          where: { id: Number(paperTrading.sell_trade_id), portfolio_id },
        })
      : null;
    const stock = await Stock.findOne({ where: { symbol: normalizeSymbol(signal.symbol) } });
    const position =
      paperTrading.status !== 'closed'
        ? await PaperTradingPosition.findOne({
            where: { portfolio_id, symbol: normalizeSymbol(signal.symbol) },
          })
        : null;

    const entryPrice = roundNumber(
      toNumber(
        paperTrading.execute_price,
        toNumber(entryTrade?.execute_price, toNumber(signal.current_price))
      ),
      4
    );
    const exitPrice = exitTrade
      ? roundNumber(toNumber(paperTrading.exit_price, toNumber(exitTrade.execute_price)), 4)
      : undefined;
    const latestPrice = roundNumber(
      toNumber(
        position?.current_price,
        exitPrice ??
          toNumber(paperTrading.latest_price, toNumber(entryTrade?.execute_price, entryPrice))
      ),
      4
    );
    const quantity = Math.floor(
      toNumber(
        paperTrading.exit_quantity,
        toNumber(
          paperTrading.quantity,
          toNumber(exitTrade?.quantity, toNumber(entryTrade?.quantity))
        )
      )
    );
    if (!entryPrice || !quantity) return null;

    const entryAmount = roundNumber(
      toNumber(paperTrading.amount, toNumber(entryTrade?.amount, entryPrice * quantity)),
      2
    );
    const exitAmount = exitTrade
      ? roundNumber(
          toNumber(
            paperTrading.exit_amount,
            toNumber(exitTrade.amount, (exitPrice || 0) * quantity)
          ),
          2
        )
      : undefined;
    const totalCommission = roundNumber(
      toNumber(paperTrading.commission, toNumber(entryTrade?.commission)) +
        toNumber(paperTrading.exit_commission, toNumber(exitTrade?.commission)),
      2
    );
    const entryDate = dateOnly(
      paperTrading.executed_at || entryTrade?.created_at || signal.signal_date
    );
    const exitDate = exitTrade
      ? dateOnly(paperTrading.closed_at || exitTrade.created_at)
      : undefined;
    const tradeStatus = paperTrading.status === 'closed' || exitTrade ? 'closed' : 'open';
    const effectiveExitDate = exitDate || getChinaToday();
    const realizedPnl =
      tradeStatus === 'closed'
        ? roundNumber(
            toNumber(
              paperTrading.realized_pnl,
              toNumber(
                exitTrade?.realized_pnl,
                toNumber(exitAmount) - entryAmount - totalCommission
              )
            ),
            2
          )
        : 0;
    const realizedPnlPct =
      tradeStatus === 'closed'
        ? roundNumber(
            toNumber(
              paperTrading.realized_pnl_pct,
              exitPrice && entryPrice ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0
            ),
            4
          )
        : 0;
    const unrealizedPnl =
      tradeStatus === 'open'
        ? roundNumber(toNumber(position?.unrealized_pnl, (latestPrice - entryPrice) * quantity), 2)
        : 0;
    const unrealizedPnlPct =
      tradeStatus === 'open' && entryPrice > 0
        ? roundNumber(((latestPrice - entryPrice) / entryPrice) * 100, 4)
        : 0;
    const totalPnl = tradeStatus === 'closed' ? realizedPnl : unrealizedPnl;
    const totalPnlPct = tradeStatus === 'closed' ? realizedPnlPct : unrealizedPnlPct;
    const mfeMae = await this.computeExcursions({
      stock,
      entry_date: entryDate,
      exit_date: effectiveExitDate,
      entry_price: entryPrice,
    });
    const benchmark = await this.resolveBenchmark({
      symbol: signal.symbol,
      stock,
      entry_date: entryDate,
      exit_date: effectiveExitDate,
      total_pnl_pct: totalPnlPct,
    });

    const payload: Record<string, any> = {
      portfolio_id,
      signal_id: signal.id,
      loop_run_id: signal.loop_run_id || metadata.loop_run_id || paperTrading.loop_run_id,
      source_type: signal.source_type,
      source_id: signal.source_id,
      symbol: normalizeSymbol(signal.symbol),
      name: signal.name || stock?.name || normalizeSymbol(signal.symbol),
      signal_date: signal.signal_date,
      decision: signal.normalized_decision || signal.decision,
      score: toOptionalNumber(signal.confidence_score),
      risk_level: signal.risk_level || metadata.risk_level,
      action: metadata.action,
      action_label: metadata.action_label,
      agent_session: metadata.agent_session,
      recommendation_style: metadata.style || metadata.recommendation_style,
      recommendation_source: metadata.universe || metadata.recommendation_source || metadata.source,
      industry: stock?.industry || metadata.industry,
      market: stock?.market || extractMarket(signal.symbol),
      trade_status: tradeStatus,
      entry_trade_id: toOptionalNumber(paperTrading.trade_id),
      exit_trade_id: toOptionalNumber(paperTrading.sell_trade_id),
      entry_date: entryDate,
      exit_date: exitDate,
      entry_price: entryPrice,
      exit_price: exitPrice,
      latest_price: latestPrice,
      quantity,
      position_pct: toOptionalNumber(
        paperTrading.target_position_pct ?? metadata.suggested_position_pct
      ),
      entry_amount: entryAmount,
      exit_amount: exitAmount,
      total_commission: totalCommission,
      realized_pnl: realizedPnl,
      realized_pnl_pct: realizedPnlPct,
      unrealized_pnl: unrealizedPnl,
      unrealized_pnl_pct: unrealizedPnlPct,
      total_pnl: roundNumber(totalPnl, 2),
      total_pnl_pct: roundNumber(totalPnlPct, 4),
      max_favorable_excursion_pct: mfeMae.max_favorable_excursion_pct,
      max_adverse_excursion_pct: mfeMae.max_adverse_excursion_pct,
      holding_days: toNumber(paperTrading.holding_days, holdingDays(entryDate, exitDate)),
      benchmark_code: benchmark?.benchmark_code,
      benchmark_name: benchmark?.benchmark_name,
      benchmark_return_pct: benchmark?.benchmark_return_pct,
      excess_return_pct:
        benchmark?.benchmark_return_pct !== undefined
          ? roundNumber(totalPnlPct - benchmark.benchmark_return_pct, 4)
          : undefined,
      exit_reason: paperTrading.exit_reason,
      exit_reason_label: paperTrading.exit_reason_label,
      metadata: {
        strategy_key: strategyKey,
        strategy_variant: Object.keys(strategyVariant).length
          ? strategyVariant
          : asPlainObject(paperTrading.strategy_variant),
        strategy_bucket_label:
          metadata.strategy_bucket_label ||
          strategyVariant.strategy_bucket_label ||
          asPlainObject(paperTrading.strategy_variant).strategy_bucket_label,
        market_environment: metadata.market_environment || environmentPolicy.market_environment,
        environment_policy: environmentPolicy,
        environment_policy_snapshot_id: environmentPolicySnapshotId,
        signal_metadata: metadata,
        paper_trading: paperTrading,
        benchmark,
        consensus: {
          consensus_count: toOptionalNumber(metadata.consensus_count),
          consensus_bonus: toOptionalNumber(metadata.consensus_bonus),
          original_score: toOptionalNumber(metadata.original_score),
          consensus_variants: Array.isArray(metadata.consensus_variants)
            ? metadata.consensus_variants
            : [],
          recommendation_tier: metadata.recommendation_tier,
          recommendation_tier_label: metadata.recommendation_tier_label,
        },
        refreshed_at: new Date().toISOString(),
        latest_position_id: position?.id,
        stock_id: stock?.id,
      },
    };

    const existing = await RecommendationTradeOutcome.findOne({
      where: { portfolio_id, signal_id: signal.id },
    });
    if (existing) {
      await existing.update(payload);
      return existing;
    }

    return RecommendationTradeOutcome.create(payload as any);
  }

  private async resolveBenchmark(params: {
    symbol: string;
    stock?: Stock | null;
    entry_date: string;
    exit_date: string;
    total_pnl_pct: number;
  }) {
    try {
      const benchmark = await benchmarkIndexService.getBenchmarkReturnForStock(
        params.symbol,
        params.entry_date,
        params.exit_date,
        { stock: params.stock, auto_sync: true }
      );
      return benchmark || null;
    } catch (error: any) {
      logger.warn(`推荐交易收益闭环基准收益计算失败 ${params.symbol}: ${error?.message || error}`);
      return null;
    }
  }

  private async computeExcursions(params: {
    stock?: Stock | null;
    entry_date: string;
    exit_date: string;
    entry_price: number;
  }): Promise<{ max_favorable_excursion_pct?: number; max_adverse_excursion_pct?: number }> {
    if (!params.stock?.id || !params.entry_price) return {};
    const { start, end } = safeDateWindow(params.entry_date, params.exit_date);
    const bars = await DailyBar.findAll({
      where: {
        stock_id: params.stock.id,
        time: { [Op.gte]: start, [Op.lte]: end },
      },
      order: [['time', 'ASC']],
      raw: true,
    });
    if (!bars.length) return {};

    let highest = params.entry_price;
    let lowest = params.entry_price;
    for (const bar of bars as any[]) {
      const high = toNumber(bar.high, params.entry_price);
      const low = toNumber(bar.low, params.entry_price);
      highest = Math.max(highest, high);
      lowest = Math.min(lowest, low);
    }

    return {
      max_favorable_excursion_pct: roundNumber(
        ((highest - params.entry_price) / params.entry_price) * 100,
        4
      ),
      max_adverse_excursion_pct: roundNumber(
        ((lowest - params.entry_price) / params.entry_price) * 100,
        4
      ),
    };
  }

  private async resolvePortfolio(
    options: Pick<
      RecommendationTradeOutcomeRefreshOptions,
      | 'user_id'
      | 'username'
      | 'portfolio_id'
      | 'portfolio_name'
      | 'initial_capital'
      | 'force_new_portfolio'
    >
  ): Promise<PaperTradingPortfolio> {
    if (options.portfolio_id) {
      const portfolio = await PaperTradingPortfolio.findByPk(options.portfolio_id);
      if (portfolio) return portfolio;
    }

    const user = await this.resolveUser(options.user_id, options.username);
    if (options.portfolio_name) {
      const namedPortfolio = await PaperTradingPortfolio.findOne({
        where: { user_id: user.id, name: options.portfolio_name },
        order: [['id', 'ASC']],
      });
      if (namedPortfolio) return namedPortfolio;
    }

    let portfolio: PaperTradingPortfolio | null = null;
    if (!options.portfolio_name) {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id: user.id, is_active: true },
        order: [['id', 'ASC']],
      });
    }
    if (!portfolio) {
      portfolio = await paperTradingAutomationService.ensurePortfolio({
        user_id: user.id,
        username: user.username,
        name: options.portfolio_name,
        initial_capital: options.initial_capital,
        force_new: options.force_new_portfolio,
      });
    }
    return portfolio;
  }

  private async resolveUser(user_id?: number, username?: string): Promise<User> {
    if (user_id) {
      const user = await User.findByPk(user_id);
      if (user) return user;
    }

    const preferredUsername = username || process.env.PAPER_TRADING_DEFAULT_USERNAME || 'lym';
    let user = await User.findOne({ where: { username: preferredUsername } });
    if (!user && preferredUsername !== 'lym') {
      user = await User.findOne({ where: { username: 'lym' } });
    }
    if (!user) {
      user = await User.findOne({
        where: { role: 'admin', is_active: true },
        order: [['id', 'ASC']],
      });
    }
    if (!user) {
      user = await User.findOne({ where: { is_active: true }, order: [['id', 'ASC']] });
    }
    if (!user) throw new Error('未找到可用于推荐交易收益闭环的用户');
    return user;
  }

  private buildOutcomeWhere(
    options: RecommendationTradeOutcomeQueryOptions & { portfolio_id: number }
  ) {
    const where: any = { portfolio_id: options.portfolio_id };
    if (options.trade_status && options.trade_status !== 'all')
      where.trade_status = options.trade_status;
    if (options.loop_run_id) where.loop_run_id = options.loop_run_id;
    if (options.source_type && options.source_type !== 'all')
      where.source_type = options.source_type;
    if (options.agent_session) where.agent_session = options.agent_session;
    if (options.signal_id) where.signal_id = options.signal_id;
    if (options.start_date || options.end_date) {
      where.entry_date = {};
      if (options.start_date) where.entry_date[Op.gte] = options.start_date;
      if (options.end_date) where.entry_date[Op.lte] = options.end_date;
    } else if (options.lookback_days) {
      where.entry_date = {
        [Op.gte]: moment()
          .tz('Asia/Shanghai')
          .subtract(toPositiveInt(options.lookback_days, 180, 3650), 'days')
          .format('YYYY-MM-DD'),
      };
    }
    return where;
  }

  private buildPathSamples(
    outcomes: any[],
    signalById: Map<number, any>,
    horizons: string[]
  ): any[] {
    const samples: any[] = [];
    for (const outcome of outcomes) {
      const signal = signalById.get(Number(outcome.signal_id));
      const forwardReturns = asPlainObject(signal?.forward_returns);
      const horizonMap = asPlainObject(forwardReturns.horizons);
      for (const horizon of horizons) {
        const item = asPlainObject(horizonMap[horizon]);
        if (item.status !== 'completed') continue;
        const returnPct = toNumber(item.return_pct, NaN);
        if (!Number.isFinite(returnPct)) continue;
        const decision = outcome.decision || signal?.normalized_decision || signal?.decision;
        const directionalReturn =
          item.directional_return_pct !== undefined
            ? toNumber(item.directional_return_pct)
            : ['sell', 'strong_sell'].includes(String(decision || '').toLowerCase())
            ? -returnPct
            : returnPct;
        samples.push({
          outcome_id: outcome.id,
          signal_id: outcome.signal_id,
          symbol: outcome.symbol,
          name: outcome.name,
          source_type: outcome.source_type,
          recommendation_style: outcome.recommendation_style,
          risk_level: outcome.risk_level,
          score: toNumber(outcome.score),
          signal_date: outcome.signal_date,
          entry_date: forwardReturns.entry_date || outcome.entry_date,
          entry_price: toNumber(forwardReturns.entry_price, toNumber(outcome.entry_price)),
          horizon,
          horizon_days: Number(horizon.replace('d', '')),
          exit_date: item.exit_date,
          exit_price: toNumber(item.exit_price),
          return_pct: roundNumber(returnPct, 4),
          directional_return_pct: roundNumber(directionalReturn, 4),
          excess_return_pct: roundNumber(toNumber(item.excess_return_pct, directionalReturn), 4),
          max_favorable_excursion_pct: roundNumber(toNumber(item.max_favorable_excursion_pct), 4),
          max_adverse_excursion_pct: roundNumber(toNumber(item.max_adverse_excursion_pct), 4),
          trade_status: outcome.trade_status,
          total_pnl_pct: toNumber(outcome.total_pnl_pct),
        });
      }
    }
    return samples;
  }

  private buildSymbolPathSummaries(pathSamples: any[], outcomes: any[]) {
    const grouped = new Map<string, any[]>();
    for (const sample of pathSamples) {
      if (!grouped.has(sample.symbol)) grouped.set(sample.symbol, []);
      grouped.get(sample.symbol)!.push(sample);
    }
    const outcomeBySymbol = new Map<string, any[]>();
    for (const outcome of outcomes) {
      if (!outcomeBySymbol.has(outcome.symbol)) outcomeBySymbol.set(outcome.symbol, []);
      outcomeBySymbol.get(outcome.symbol)!.push(outcome);
    }

    return [...grouped.entries()]
      .map(([symbol, samples]) => {
        const first = samples[0] || {};
        const symbolOutcomes = outcomeBySymbol.get(symbol) || [];
        const latestOutcome = [...symbolOutcomes].sort((a, b) =>
          String(b.entry_date || b.signal_date).localeCompare(String(a.entry_date || a.signal_date))
        )[0];
        const bestHorizon = [...samples].sort(
          (a, b) => b.directional_return_pct - a.directional_return_pct
        )[0];
        const worstHorizon = [...samples].sort(
          (a, b) => a.directional_return_pct - b.directional_return_pct
        )[0];
        return {
          symbol,
          name: first.name || latestOutcome?.name,
          latest_signal_date: latestOutcome?.signal_date || first.signal_date,
          trade_status: latestOutcome?.trade_status,
          score: latestOutcome?.score,
          count: samples.length,
          avg_directional_return_pct: roundNumber(
            average(samples.map(item => item.directional_return_pct)),
            4
          ),
          avg_excess_return_pct: roundNumber(
            average(samples.map(item => item.excess_return_pct)),
            4
          ),
          best_horizon: bestHorizon?.horizon,
          best_horizon_return_pct: bestHorizon?.directional_return_pct,
          worst_horizon: worstHorizon?.horizon,
          worst_horizon_return_pct: worstHorizon?.directional_return_pct,
          path: samples.sort((a, b) => a.horizon_days - b.horizon_days),
        };
      })
      .sort(
        (a, b) =>
          b.avg_directional_return_pct - a.avg_directional_return_pct ||
          b.avg_excess_return_pct - a.avg_excess_return_pct
      )
      .slice(0, 30);
  }

  private buildSummary(records: RecommendationTradeOutcome[]): RecommendationTradeOutcomeSummary {
    const plain = records.map(record => modelToPlain<any>(record));
    const closed = plain.filter(item => item.trade_status === 'closed');
    const open = plain.filter(item => item.trade_status !== 'closed');
    const wins = closed.filter(item => toNumber(item.realized_pnl) > 0);
    const losses = closed.filter(item => toNumber(item.realized_pnl) < 0);
    const excessWins = closed.filter(item => toNumber(item.excess_return_pct) > 0);
    const totalRealized = roundNumber(
      closed.reduce((sum, item) => sum + toNumber(item.realized_pnl), 0),
      2
    );
    const totalUnrealized = roundNumber(
      open.reduce((sum, item) => sum + toNumber(item.unrealized_pnl), 0),
      2
    );
    const winSum = wins.reduce((sum, item) => sum + toNumber(item.realized_pnl), 0);
    const lossSum = Math.abs(losses.reduce((sum, item) => sum + toNumber(item.realized_pnl), 0));
    const avgWinPct = average(wins.map(item => toNumber(item.realized_pnl_pct)));
    const avgLossPct = average(losses.map(item => toNumber(item.realized_pnl_pct)));
    const bestTrade = [...plain].sort(
      (a, b) => toNumber(b.total_pnl_pct) - toNumber(a.total_pnl_pct)
    )[0];
    const worstTrade = [...plain].sort(
      (a, b) => toNumber(a.total_pnl_pct) - toNumber(b.total_pnl_pct)
    )[0];

    return {
      total_count: plain.length,
      open_count: open.length,
      closed_count: closed.length,
      win_count: wins.length,
      loss_count: losses.length,
      excess_win_count: excessWins.length,
      total_realized_pnl: totalRealized,
      total_unrealized_pnl: totalUnrealized,
      total_pnl: roundNumber(totalRealized + totalUnrealized, 2),
      avg_total_pnl_pct: roundNumber(average(plain.map(item => toNumber(item.total_pnl_pct))), 4),
      avg_closed_return_pct: roundNumber(
        average(closed.map(item => toNumber(item.realized_pnl_pct))),
        4
      ),
      avg_excess_return_pct: roundNumber(
        average(closed.map(item => toNumber(item.excess_return_pct))),
        4
      ),
      win_rate: closed.length ? roundNumber((wins.length / closed.length) * 100, 2) : 0,
      excess_win_rate: closed.length
        ? roundNumber((excessWins.length / closed.length) * 100, 2)
        : 0,
      payoff_ratio:
        avgWinPct && avgLossPct
          ? roundNumber(avgWinPct / Math.abs(avgLossPct), 4)
          : wins.length > 0 && losses.length === 0
          ? 999
          : 0,
      profit_factor: lossSum > 0 ? roundNumber(winSum / lossSum, 4) : wins.length > 0 ? 999 : 0,
      avg_holding_days: roundNumber(average(plain.map(item => toNumber(item.holding_days))), 2),
      avg_mfe_pct: roundNumber(
        average(plain.map(item => toNumber(item.max_favorable_excursion_pct))),
        4
      ),
      avg_mae_pct: roundNumber(
        average(plain.map(item => toNumber(item.max_adverse_excursion_pct))),
        4
      ),
      open_exposure: roundNumber(
        open.reduce((sum, item) => sum + toNumber(item.latest_price) * toNumber(item.quantity), 0),
        2
      ),
      best_trade: bestTrade,
      worst_trade: worstTrade,
    };
  }

  private buildBuckets(
    records: RecommendationTradeOutcome[],
    keySelector: (record: RecommendationTradeOutcome) => string | undefined | null,
    labelSelector: (key: string) => string,
    dimension = 'segment'
  ): RecommendationTradeOutcomeBucket[] {
    const grouped = new Map<string, RecommendationTradeOutcome[]>();
    for (const record of records) {
      const key = String(keySelector(record) || 'unknown');
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(record);
    }

    return [...grouped.entries()]
      .map(([key, items]) => {
        const plain = items.map(item => modelToPlain<any>(item));
        const closed = plain.filter(item => item.trade_status === 'closed');
        const open = plain.filter(item => item.trade_status !== 'closed');
        const wins = closed.filter(item => toNumber(item.realized_pnl) > 0);
        const excessWins = closed.filter(item => toNumber(item.excess_return_pct) > 0);
        const consensusCounts = plain.map(item =>
          toNumber(asPlainObject(asPlainObject(item.metadata).signal_metadata).consensus_count, 0)
        );
        const consensusBonuses = plain.map(item =>
          toNumber(asPlainObject(asPlainObject(item.metadata).signal_metadata).consensus_bonus, 0)
        );
        const best = [...plain].sort(
          (a, b) => toNumber(b.total_pnl_pct) - toNumber(a.total_pnl_pct)
        )[0];
        const worst = [...plain].sort(
          (a, b) => toNumber(a.total_pnl_pct) - toNumber(b.total_pnl_pct)
        )[0];
        const winSum = closed
          .filter(item => toNumber(item.realized_pnl) > 0)
          .reduce((sum, item) => sum + toNumber(item.realized_pnl), 0);
        const lossSum = Math.abs(
          closed
            .filter(item => toNumber(item.realized_pnl) < 0)
            .reduce((sum, item) => sum + toNumber(item.realized_pnl), 0)
        );
        const closedExcessReturns = closed.map(item => toNumber(item.excess_return_pct));
        const avgExcessReturn = roundNumber(average(closedExcessReturns), 4);
        const excessWinRate = closed.length ? (excessWins.length / closed.length) * 100 : 0;
        const bayesianWinRate = closed.length
          ? ((excessWins.length + 2) / (closed.length + 4)) * 100
          : 50;
        const sampleConfidence = clamp(closed.length / 12, 0, 1);
        const returnVolatility = standardDeviation(closedExcessReturns);
        const drawdownPenalty = Math.abs(
          Math.min(0, average(plain.map(item => toNumber(item.max_adverse_excursion_pct))))
        );
        const riskAdjustedExcess =
          avgExcessReturn - returnVolatility * 0.18 - drawdownPenalty * 0.12;
        const recentClosed = [...closed].sort((a, b) =>
          String(b.exit_date || b.entry_date || '').localeCompare(
            String(a.exit_date || a.entry_date || '')
          )
        );
        let recentLossStreak = 0;
        for (const item of recentClosed) {
          if (toNumber(item.excess_return_pct) < 0 || toNumber(item.realized_pnl) < 0) {
            recentLossStreak += 1;
          } else {
            break;
          }
        }
        const robustScore = roundNumber(
          riskAdjustedExcess * 7 +
            (bayesianWinRate - 50) * 0.26 +
            Math.log1p(closed.length) * 2.2 +
            Math.min(10, toNumber(winSum) / 5000) -
            Math.max(0, 3 - closed.length) * 3,
          2
        );
        const autoAction =
          closed.length < 3
            ? 'collect_samples'
            : robustScore >= 12 && riskAdjustedExcess > 0.6 && bayesianWinRate >= 53
            ? 'boost'
            : robustScore <= -6 || riskAdjustedExcess < -0.8 || bayesianWinRate < 45
            ? 'reduce'
            : 'hold';
        const cooldownActive =
          dimension === 'environment_strategy_combo' &&
          closed.length >= 3 &&
          (recentLossStreak >= 2 ||
            avgExcessReturn <= -1 ||
            riskAdjustedExcess <= -0.8 ||
            bayesianWinRate < 45 ||
            drawdownPenalty >= 6);
        const cooldownReason =
          dimension === 'environment_strategy_combo' && cooldownActive
            ? recentLossStreak >= 2
              ? `最近 ${recentLossStreak} 笔连续跑输，冷却观察`
              : avgExcessReturn <= -1
              ? `平均超额 ${avgExcessReturn}% 为负，冷却观察`
              : riskAdjustedExcess <= -0.8
              ? `风险调整超额 ${roundNumber(riskAdjustedExcess, 2)}% 偏弱，冷却观察`
              : bayesianWinRate < 45
              ? `贝叶斯胜率 ${roundNumber(bayesianWinRate, 2)}% 偏低，冷却观察`
              : `最大不利波动 ${roundNumber(drawdownPenalty, 2)}% 偏高，冷却观察`
            : undefined;
        const latestClosedDate = recentClosed[0]?.exit_date || recentClosed[0]?.entry_date;
        const daysSinceLatestClosed = latestClosedDate
          ? Math.max(0, moment().tz('Asia/Shanghai').diff(moment(latestClosedDate), 'days'))
          : 0;
        const cooldownDays = cooldownActive ? Math.min(20, 5 + recentLossStreak * 3) : undefined;
        const improvementSignal =
          dimension === 'environment_strategy_combo' &&
          cooldownActive &&
          recentLossStreak === 0 &&
          (riskAdjustedExcess > -0.2 || bayesianWinRate >= 48 || robustScore >= -1);
        const resampleTrades =
          dimension === 'environment_strategy_combo'
            ? plain.filter(item => isResampleOutcome(item))
            : [];
        const closedResampleTrades = resampleTrades.filter(item => item.trade_status === 'closed');
        const resampleWins = closedResampleTrades.filter(item => toNumber(item.total_pnl) > 0);
        const resampleExcessWins = closedResampleTrades.filter(
          item => toNumber(item.excess_return_pct) > 0
        );
        const resampleLossSum = Math.abs(
          closedResampleTrades
            .filter(item => toNumber(item.realized_pnl) < 0)
            .reduce((sum, item) => sum + toNumber(item.realized_pnl), 0)
        );
        const resampleWinSum = closedResampleTrades
          .filter(item => toNumber(item.realized_pnl) > 0)
          .reduce((sum, item) => sum + toNumber(item.realized_pnl), 0);
        const resampleAvgExcess = roundNumber(
          average(closedResampleTrades.map(item => toNumber(item.excess_return_pct))),
          4
        );
        const resampleClosedCount = closedResampleTrades.length;
        const resampleWinRate = resampleClosedCount
          ? roundNumber((resampleWins.length / resampleClosedCount) * 100, 2)
          : undefined;
        const resampleExcessWinRate = resampleClosedCount
          ? roundNumber((resampleExcessWins.length / resampleClosedCount) * 100, 2)
          : undefined;
        const resampleTotalPnl = resampleTrades.length
          ? roundNumber(
              resampleTrades.reduce((sum, item) => sum + toNumber(item.total_pnl), 0),
              2
            )
          : undefined;
        const resampleProfitFactor =
          resampleClosedCount && resampleLossSum > 0
            ? roundNumber(resampleWinSum / resampleLossSum, 4)
            : resampleClosedCount && resampleWins.length > 0
            ? 999
            : resampleClosedCount
            ? 0
            : undefined;
        const resampleDecision: RecommendationTradeOutcomeBucket['resample_decision'] =
          dimension === 'environment_strategy_combo' && resampleClosedCount >= 2
            ? resampleAvgExcess >= 0.8 && toNumber(resampleExcessWinRate, 0) >= 50
              ? 'promote'
              : resampleAvgExcess <= -0.8 || toNumber(resampleExcessWinRate, 100) < 35
              ? 'cooldown'
              : 'continue_sampling'
            : dimension === 'environment_strategy_combo' && resampleTrades.length > 0
            ? 'observe'
            : undefined;
        const resampleDecisionReason =
          resampleDecision === 'promote'
            ? `复采样 ${resampleClosedCount} 笔平均超额 ${resampleAvgExcess}%，可评估恢复常规采样`
            : resampleDecision === 'cooldown'
            ? `复采样 ${resampleClosedCount} 笔仍跑输，继续冷却并避免放大`
            : resampleDecision === 'continue_sampling'
            ? `复采样 ${resampleClosedCount} 笔结论未稳定，继续小仓观察`
            : resampleDecision === 'observe'
            ? '已有复采样持仓但尚未形成闭环，等待平仓验证'
            : undefined;
        const resampleRecoveryReady =
          dimension === 'environment_strategy_combo' && resampleDecision === 'promote';
        const cooldownExtended =
          dimension === 'environment_strategy_combo' && resampleDecision === 'cooldown';
        const cooldownExtensionDays = cooldownExtended
          ? Math.min(30, toNumber(cooldownDays, 5) + 7)
          : undefined;
        const cooldownExpiresAt =
          cooldownExtended && latestClosedDate
            ? moment(latestClosedDate)
                .tz('Asia/Shanghai')
                .add(toNumber(cooldownExtensionDays, 0), 'days')
                .format('YYYY-MM-DD')
            : undefined;
        const resampleRecoveryPositionMultiplier = resampleRecoveryReady ? 0.58 : undefined;
        const resamplePolicyAction: RecommendationTradeOutcomeBucket['resample_policy_action'] =
          resampleRecoveryReady
            ? 'recover_small'
            : cooldownExtended
            ? 'extend_cooldown'
            : resampleDecision === 'continue_sampling'
            ? 'continue_resample'
            : resampleDecision === 'observe'
            ? 'observe'
            : 'none';
        const resampleReady =
          dimension === 'environment_strategy_combo' &&
          cooldownActive &&
          !cooldownExtended &&
          !resampleRecoveryReady &&
          (daysSinceLatestClosed >= toNumber(cooldownDays, 999) || improvementSignal);
        const resampleReason = resampleReady
          ? improvementSignal
            ? '冷却组合出现改善信号，仅允许小仓复采样'
            : `冷却已满 ${cooldownDays} 天，仅允许小仓复采样`
          : undefined;
        const effectiveCooldownActive = cooldownActive && !resampleRecoveryReady;
        const effectiveCooldownDays = cooldownExtended ? cooldownExtensionDays : cooldownDays;
        const effectiveCooldownReason = cooldownExtended
          ? `${resampleDecisionReason}，延长冷却至 ${cooldownExpiresAt || '后续交易日'}`
          : cooldownReason;
        return {
          key,
          label: labelSelector(key),
          count: plain.length,
          open_count: open.length,
          closed_count: closed.length,
          tracked_count: plain.length,
          win_rate: closed.length ? roundNumber((wins.length / closed.length) * 100, 2) : 0,
          excess_win_rate: roundNumber(excessWinRate, 2),
          avg_return_pct: roundNumber(
            average(closed.map(item => toNumber(item.realized_pnl_pct))),
            4
          ),
          avg_excess_return_pct: avgExcessReturn,
          total_pnl: roundNumber(
            plain.reduce((sum, item) => sum + toNumber(item.total_pnl), 0),
            2
          ),
          profit_factor: lossSum > 0 ? roundNumber(winSum / lossSum, 4) : wins.length > 0 ? 999 : 0,
          avg_holding_days: roundNumber(average(plain.map(item => toNumber(item.holding_days))), 2),
          best_symbol: best?.symbol,
          best_name: best?.name,
          best_return_pct: best?.total_pnl_pct,
          worst_symbol: worst?.symbol,
          worst_name: worst?.name,
          worst_return_pct: worst?.total_pnl_pct,
          avg_consensus_count: roundNumber(average(consensusCounts), 2),
          avg_consensus_bonus: roundNumber(average(consensusBonuses), 2),
          dimension,
          auto_action: autoAction,
          confidence: roundNumber(sampleConfidence, 2),
          robust_score: robustScore,
          sample_confidence: roundNumber(sampleConfidence, 2),
          bayesian_win_rate: roundNumber(bayesianWinRate, 2),
          return_volatility_pct: roundNumber(returnVolatility, 4),
          drawdown_penalty: roundNumber(drawdownPenalty, 4),
          risk_adjusted_excess_return_pct: roundNumber(riskAdjustedExcess, 4),
          takeover_ready:
            dimension === 'environment_strategy_combo' &&
            !effectiveCooldownActive &&
            !resampleRecoveryReady &&
            closed.length >= 3 &&
            sampleConfidence >= 0.25 &&
            robustScore >= 8 &&
            avgExcessReturn > 0.5 &&
            bayesianWinRate >= 52,
          takeover_reason:
            dimension === 'environment_strategy_combo'
              ? resampleRecoveryReady
                ? resampleDecisionReason
                : effectiveCooldownActive
                ? effectiveCooldownReason
                : closed.length < 3
                ? `闭环样本 ${closed.length}/3，不接管`
                : robustScore < 8
                ? `稳健分 ${robustScore}/8，不接管`
                : avgExcessReturn <= 0.5
                ? `平均超额 ${avgExcessReturn}% 不足，不接管`
                : bayesianWinRate < 52
                ? `贝叶斯胜率 ${roundNumber(bayesianWinRate, 2)}% 不足，不接管`
                : '满足样本、稳健分、超额收益和贝叶斯胜率，允许接管'
              : undefined,
          cooldown_active: effectiveCooldownActive,
          cooldown_reason: effectiveCooldownActive ? effectiveCooldownReason : undefined,
          recent_loss_streak:
            dimension === 'environment_strategy_combo' ? recentLossStreak : undefined,
          cooldown_days: effectiveCooldownActive ? effectiveCooldownDays : undefined,
          resample_ready: resampleReady,
          resample_reason: resampleReason,
          resample_position_multiplier: resampleReady ? 0.35 : undefined,
          resample_closed_count:
            dimension === 'environment_strategy_combo' ? resampleClosedCount : undefined,
          resample_avg_excess_return_pct:
            dimension === 'environment_strategy_combo' && resampleTrades.length
              ? resampleAvgExcess
              : undefined,
          resample_win_rate: resampleWinRate,
          resample_excess_win_rate: resampleExcessWinRate,
          resample_total_pnl: resampleTotalPnl,
          resample_profit_factor: resampleProfitFactor,
          resample_decision: resampleDecision,
          resample_decision_reason: resampleDecisionReason,
          resample_recovery_ready: resampleRecoveryReady,
          resample_recovery_position_multiplier: resampleRecoveryPositionMultiplier,
          cooldown_extended: cooldownExtended,
          cooldown_extension_days: cooldownExtensionDays,
          cooldown_expires_at: cooldownExpiresAt,
          resample_policy_action: resamplePolicyAction,
        };
      })
      .sort((a, b) => {
        if (b.robust_score !== a.robust_score) return b.robust_score - a.robust_score;
        if (b.closed_count !== a.closed_count) return b.closed_count - a.closed_count;
        if (b.avg_excess_return_pct !== a.avg_excess_return_pct) {
          return b.avg_excess_return_pct - a.avg_excess_return_pct;
        }
        return b.total_pnl - a.total_pnl;
      });
  }

  private buildFeedback(
    summary: RecommendationTradeOutcomeSummary,
    groups: RecommendationTradeOutcomeDashboard['groups']
  ): RecommendationTradeOutcomeDashboard['feedback'] {
    let recommendedMinScore = 72;
    if (summary.closed_count >= 5) {
      if (summary.avg_excess_return_pct < -1 || summary.excess_win_rate < 45)
        recommendedMinScore += 5;
      if (summary.avg_excess_return_pct > 2 && summary.excess_win_rate >= 55)
        recommendedMinScore -= 2;
      if (summary.profit_factor >= 1.6 && summary.win_rate >= 55) recommendedMinScore -= 1;
    }
    recommendedMinScore = Math.max(62, Math.min(88, recommendedMinScore));

    const positionMultiplier =
      summary.closed_count < 5
        ? 0.65
        : summary.avg_excess_return_pct > 2 && summary.excess_win_rate >= 55
        ? 1.15
        : summary.avg_excess_return_pct < -1 || summary.excess_win_rate < 45
        ? 0.55
        : 0.85;

    const riskGroups = groups.by_risk_level.filter(group =>
      ['low', 'medium', 'high'].includes(group.key)
    );
    const allowedRiskLevels = riskGroups
      .filter(
        group =>
          group.closed_count < 2 || group.avg_excess_return_pct >= 0 || group.excess_win_rate >= 50
      )
      .map(group => group.key);

    const allGroups = [
      ...groups.by_source_type,
      ...groups.by_agent_session,
      ...groups.by_style,
      ...groups.by_action,
      ...groups.by_consensus,
      ...groups.by_score_position_bucket,
      ...groups.by_strategy_key,
      ...groups.by_market_regime,
      ...groups.by_industry_regime,
      ...groups.by_industry,
    ];
    const bestSegments = allGroups
      .filter(group => group.closed_count > 0)
      .sort((a, b) => b.avg_excess_return_pct - a.avg_excess_return_pct)
      .slice(0, 5);
    const weakSegments = allGroups
      .filter(group => group.closed_count > 0)
      .sort((a, b) => a.avg_excess_return_pct - b.avg_excess_return_pct)
      .slice(0, 5);

    const insights: string[] = [];
    const nextActions: string[] = [];
    if (summary.closed_count === 0) {
      insights.push('暂无平仓样本，当前主要观察持仓浮盈亏和基准超额表现。');
      nextActions.push('继续让自动跟单积累样本，避免过早放大仓位。');
    } else {
      insights.push(
        `已闭环 ${summary.closed_count} 笔，胜率 ${summary.win_rate}%、超额胜率 ${summary.excess_win_rate}%、平均超额 ${summary.avg_excess_return_pct}%。`
      );
      if (summary.avg_excess_return_pct > 0) {
        insights.push('模拟交易相对基准取得正超额，当前选股/退出纪律具备继续放量验证的基础。');
      } else {
        insights.push('模拟交易尚未跑赢对应基准，需要收紧入场评分、降低仓位或优化退出条件。');
      }
      if (summary.avg_mae_pct < -6) {
        insights.push(
          `平均最大不利波动 ${summary.avg_mae_pct}%，持仓过程回撤偏大，止损/入场时点需优化。`
        );
      }
    }
    if (bestSegments[0]) {
      nextActions.push(
        `优先保留 ${bestSegments[0].label} 片段，平均超额 ${bestSegments[0].avg_excess_return_pct}% / 样本 ${bestSegments[0].closed_count}。`
      );
    }
    if (weakSegments[0] && weakSegments[0].avg_excess_return_pct < 0) {
      nextActions.push(
        `降低 ${weakSegments[0].label} 片段权重，平均超额 ${weakSegments[0].avg_excess_return_pct}%。`
      );
    }
    const consensusGroups = groups.by_consensus || [];
    const strongConsensus = consensusGroups
      .filter(group => group.key !== 'no_consensus' && group.closed_count > 0)
      .sort((a, b) => b.avg_excess_return_pct - a.avg_excess_return_pct)[0];
    const noConsensus = consensusGroups.find(group => group.key === 'no_consensus');
    if (strongConsensus) {
      const edge = roundNumber(
        strongConsensus.avg_excess_return_pct - toNumber(noConsensus?.avg_excess_return_pct),
        2
      );
      insights.push(
        `多策略共识组 ${strongConsensus.label} 平均超额 ${
          strongConsensus.avg_excess_return_pct
        }%，相对无显式共识 ${edge >= 0 ? '+' : ''}${edge} 个百分点。`
      );
      nextActions.push(
        edge >= 0
          ? `继续优先复核 ${strongConsensus.label} 标的，并保留共识加权进入模拟盘。`
          : `共识组尚未跑赢无共识样本，下一轮保持小仓验证，避免单纯因共识放大仓位。`
      );
    }
    nextActions.push(
      `下一轮自动跟单最低评分建议 ${recommendedMinScore}，仓位倍率 ${positionMultiplier}x。`
    );

    return {
      recommended_min_score: recommendedMinScore,
      position_multiplier: roundNumber(positionMultiplier, 2),
      allowed_risk_levels: allowedRiskLevels.length ? allowedRiskLevels : ['low', 'medium'],
      best_segments: bestSegments,
      weak_segments: weakSegments,
      insights,
      next_actions: nextActions,
    };
  }
}

export const recommendationTradeOutcomeService = new RecommendationTradeOutcomeService();
