import { Op } from 'sequelize';
import { createHash } from 'crypto';
import moment from 'moment-timezone';
import { DailyBar } from '../../../models/DailyBar';
import { QuantSignal } from '../../../models/QuantSignal';
import { QuantStrategyParamValidation } from '../../../models/QuantStrategyParamValidation';
import { QuantStrategyParamVersion } from '../../../models/QuantStrategyParamVersion';
import { RecommendationTradeOutcome } from '../../../models/RecommendationTradeOutcome';
import { PaperTradingPortfolio } from '../../../models/PaperTradingPortfolio';
import { Stock } from '../../../models/Stock';
import { OptimizationRun } from '../../../models/OptimizationRun';
import { QuantStrategyModel } from '../../../models/QuantStrategyModel';
import { benchmarkIndexService } from '../../../services/BenchmarkIndexService';
import { PARAM_EXPERIMENT_PORTFOLIO_NAME } from '../../../portfolio/internal/PaperTradingDashboardService';
import { normalizeSymbol } from '../../../utils/stockSymbol';
import { logger } from '../../../utils/logger';
import { round } from '../../engine/QuantMath';
import { strategyRegistry } from '../../engine/StrategyRegistry';
import { quantStrategyExperimentService } from './QuantStrategyExperimentService';

type ParamSuggestionPayload = Awaited<
  ReturnType<typeof quantStrategyExperimentService.getParamsByStrategySuggestion>
>;

type ParamVersionPlain = {
  version_key: string;
  strategy_key: string;
  strategy_name?: string;
  version_type: string;
  status: string;
  params_json: Record<string, any>;
  source_experiment_id?: number;
  source_experiment_key?: string;
  source_rank_score?: number;
  source_excess_return_pct?: number;
  source_max_drawdown_pct?: number;
  source_trade_count?: number;
  adoption_reason?: string;
  active_from?: string;
  active_to?: string;
  metadata?: Record<string, any>;
};

type ActiveScanParamOptions = {
  strategy_keys?: string[];
  include_grid_search?: boolean;
  include_experiment?: boolean;
  include_observing?: boolean;
  include_degraded?: boolean;
  include_default?: boolean;
  manual_params_by_strategy?: Record<string, Record<string, any>>;
};

type ParamVersionLifecyclePolicy = {
  min_completed_samples: number;
  min_avg_excess_return_pct: number;
  min_win_rate: number;
  min_rank_score: number;
  min_default_excess_delta_pct: number;
  degrade_min_completed_samples: number;
  degrade_avg_excess_return_pct: number;
  degrade_win_rate: number;
  degrade_recent_excess_return_pct: number;
  rollback_min_completed_samples: number;
  rollback_recent_excess_return_pct: number;
  rollback_avg_excess_return_pct: number;
  min_positive_environment_buckets: number;
  max_negative_environment_buckets: number;
  min_environment_bucket_completed_samples: number;
  min_environment_bucket_excess_return_pct: number;
  trade_degrade_min_closed_samples: number;
  trade_degrade_avg_excess_return_pct: number;
  trade_rollback_min_closed_samples: number;
  trade_rollback_avg_excess_return_pct: number;
  trade_rollback_total_pnl: number;
  // Phase 1: Walk-Forward 验证门禁
  /** 是否要求 promote 前必须有最近的 walk-forward 验证 (默认 true) */
  wf_required: boolean;
  /** WF 验证最长有效期 (天)，超过这个时间的 WF 视为过期 (默认 90) */
  wf_max_age_days: number;
  /** WF 必须达到的 verdict 才放行 promote (默认 'PASS') */
  wf_required_verdict: 'PASS' | 'PASS_OR_INSUFFICIENT';
  // Phase 4: Edge Hypothesis 门禁
  /** 是否要求 promote 前必须有非空 edge_hypothesis.thesis (默认 true) */
  edge_hypothesis_required: boolean;
  // Sprint 1A: Research Integrity 门禁
  /** 是否要求 promote 前必须有最近的 research-integrity audit (默认 true) */
  ri_required: boolean;
  /** RI 审计最长有效期 (天)，超过这个时间的 audit 视为过期 (默认 30) */
  ri_max_age_days: number;
  /** RI 必须达到的 verdict 才放行 promote (默认 'PASS'; 可放宽到 'PASS_OR_WARN') */
  ri_required_verdict: 'PASS' | 'PASS_OR_WARN';
};

type StrategyRiskLevel = 'low' | 'medium' | 'high';

/**
 * Phase 1: 每个 strategy 最近一次 walk-forward 验证的关键信息
 */
type WalkForwardVerdictInfo = {
  run_id: number;
  verdict: 'PASS' | 'FAIL' | 'INSUFFICIENT';
  dsr: number | null;
  pbo: number | null;
  age_days: number;
  scheme: 'rolling' | 'cpcv' | null;
};

/**
 * Sprint 1A: 每个 strategy 最近一次 ResearchIntegrityAudit 的关键信息
 */
type ResearchIntegrityVerdictInfo = {
  audit_id: number;
  verdict: 'PASS' | 'WARN' | 'FAIL' | 'INSUFFICIENT';
  dsr: number | null;
  pbo: number | null;
  oos_decay: number | null;
  lookahead_count: number;
  age_days: number;
};

const DEFAULT_LIFECYCLE_POLICY: ParamVersionLifecyclePolicy = {
  min_completed_samples: 12,
  min_avg_excess_return_pct: 0.35,
  min_win_rate: 52,
  min_rank_score: 4,
  min_default_excess_delta_pct: 0.25,
  degrade_min_completed_samples: 8,
  degrade_avg_excess_return_pct: -0.8,
  degrade_win_rate: 42,
  degrade_recent_excess_return_pct: -1.2,
  rollback_min_completed_samples: 10,
  rollback_recent_excess_return_pct: -1.5,
  rollback_avg_excess_return_pct: -1.2,
  min_positive_environment_buckets: 1,
  max_negative_environment_buckets: 1,
  min_environment_bucket_completed_samples: 3,
  min_environment_bucket_excess_return_pct: -0.2,
  trade_degrade_min_closed_samples: 2,
  trade_degrade_avg_excess_return_pct: -0.8,
  trade_rollback_min_closed_samples: 3,
  trade_rollback_avg_excess_return_pct: -1.5,
  trade_rollback_total_pnl: -1200,
  // Phase 1: Walk-Forward 默认要求 90 天内有 PASS verdict
  wf_required: true,
  wf_max_age_days: 90,
  wf_required_verdict: 'PASS',
  // Phase 4: Edge Hypothesis 默认要求非空
  edge_hypothesis_required: true,
  // Sprint 1A: Research Integrity 默认要求 30 天内有 PASS / WARN 审计
  ri_required: true,
  ri_max_age_days: 30,
  ri_required_verdict: 'PASS',
};

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
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

function dateOnly(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
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

function shortHash(value: any, length = 10): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, length);
}

function modelToPlain<T = any>(record: any): T {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
}

function buildDefaultVersionKey(strategy_key: string) {
  return `qparam_${strategy_key}_default`;
}

function buildExperimentVersionKey(
  strategy_key: string,
  sourceKey: string | undefined,
  params: any
) {
  const suffix = sourceKey ? sourceKey.replace(/^qexp_/, '') : shortHash(params);
  return `qparam_${strategy_key}_exp_${suffix}`.slice(0, 120);
}

function buildGridVersionKey(strategy_key: string, groupId: string, params: any) {
  const suffix = `${groupId.replace(/^qgrid_/, '')}_${shortHash(params, 6)}`;
  return `qparam_${strategy_key}_grid_${suffix}`.slice(0, 120);
}

function buildManualVersionKey(strategy_key: string, params: any) {
  return `qparam_${strategy_key}_manual_${shortHash(params)}`.slice(0, 120);
}

function addCalendarDays(date: string, days: number) {
  return moment(date).add(days, 'days').format('YYYY-MM-DD');
}

function mergeLifecyclePolicy(
  policy?: Partial<ParamVersionLifecyclePolicy>
): ParamVersionLifecyclePolicy {
  return {
    ...DEFAULT_LIFECYCLE_POLICY,
    ...(policy || {}),
  };
}

function normalizeRiskLevel(value: any): StrategyRiskLevel {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'low' || normalized === 'high') return normalized;
  return 'medium';
}

function summarizeValidationRows(rows: any[], versionByKey: Map<string, any>) {
  const total = rows.length;
  const completed = rows.filter(row => row.status === 'completed');
  const pending = rows.filter(row => row.status === 'pending');
  const noData = rows.filter(row => row.status === 'no_data');
  const wins = completed.filter(row => toNumber(row.return_pct) > 0);
  const excessWins = completed.filter(row => toNumber(row.excess_return_pct) > 0);
  const avgReturn = completed.length
    ? completed.reduce((sum, row) => sum + toNumber(row.return_pct), 0) / completed.length
    : 0;
  const avgExcess = completed.length
    ? completed.reduce((sum, row) => sum + toNumber(row.excess_return_pct), 0) / completed.length
    : 0;
  const winRate = completed.length ? (wins.length / completed.length) * 100 : 0;
  const excessWinRate = completed.length ? (excessWins.length / completed.length) * 100 : 0;
  const avgBenchmark = completed.length
    ? completed.reduce((sum, row) => sum + toNumber(row.benchmark_return_pct), 0) / completed.length
    : 0;
  const version = versionByKey.get(rows[0]?.version_key);
  const sampleConfidence = Math.min(1, completed.length / 20);
  const rankScore = round(
    avgExcess * 1.35 + (winRate - 50) * 0.08 + sampleConfidence * 6 - noData.length * 0.15,
    4
  );
  const best = [...completed].sort((a, b) => toNumber(b.return_pct) - toNumber(a.return_pct))[0];
  const worst = [...completed].sort((a, b) => toNumber(a.return_pct) - toNumber(b.return_pct))[0];
  const recentCompleted = [...completed]
    .sort(
      (a, b) =>
        String(b.evaluation_date || b.updated_at || '').localeCompare(
          String(a.evaluation_date || a.updated_at || '')
        ) || Number(b.id || 0) - Number(a.id || 0)
    )
    .slice(0, 8);
  const recentAvgExcess = recentCompleted.length
    ? recentCompleted.reduce((sum, row) => sum + toNumber(row.excess_return_pct), 0) /
      recentCompleted.length
    : 0;
  const horizonMap = new Map<number, any[]>();
  for (const row of completed) {
    const horizon = toPositiveInt(row.horizon_days, 1, 60);
    if (!horizonMap.has(horizon)) horizonMap.set(horizon, []);
    horizonMap.get(horizon)!.push(row);
  }
  const byHorizon = [...horizonMap.entries()]
    .map(([horizon_days, horizonRows]) => {
      const horizonWins = horizonRows.filter(row => toNumber(row.return_pct) > 0);
      const horizonExcessWins = horizonRows.filter(row => toNumber(row.excess_return_pct) > 0);
      return {
        horizon_days,
        completed_count: horizonRows.length,
        avg_return_pct: round(
          horizonRows.reduce((sum, row) => sum + toNumber(row.return_pct), 0) /
            Math.max(horizonRows.length, 1),
          4
        ),
        avg_excess_return_pct: round(
          horizonRows.reduce((sum, row) => sum + toNumber(row.excess_return_pct), 0) /
            Math.max(horizonRows.length, 1),
          4
        ),
        win_rate: round((horizonWins.length / Math.max(horizonRows.length, 1)) * 100, 2),
        excess_win_rate: round(
          (horizonExcessWins.length / Math.max(horizonRows.length, 1)) * 100,
          2
        ),
      };
    })
    .sort((a, b) => a.horizon_days - b.horizon_days);
  return {
    version_key: rows[0]?.version_key,
    strategy_key: rows[0]?.strategy_key || version?.strategy_key,
    strategy_name: version?.strategy_name,
    version_type: version?.version_type,
    status: version?.status,
    total_count: total,
    completed_count: completed.length,
    pending_count: pending.length,
    no_data_count: noData.length,
    avg_return_pct: round(avgReturn, 4),
    avg_benchmark_return_pct: round(avgBenchmark, 4),
    avg_excess_return_pct: round(avgExcess, 4),
    win_rate: round(winRate, 2),
    excess_win_rate: round(excessWinRate, 2),
    recent_completed_count: recentCompleted.length,
    recent_avg_excess_return_pct: round(recentAvgExcess, 4),
    by_horizon: byHorizon,
    rank_score: rankScore,
    best_symbol: best?.symbol,
    best_name: best?.name,
    best_return_pct: best ? round(toNumber(best.return_pct), 4) : undefined,
    worst_symbol: worst?.symbol,
    worst_name: worst?.name,
    worst_return_pct: worst ? round(toNumber(worst.return_pct), 4) : undefined,
  };
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

function industryRegimeLabel(key: string): string {
  const labels: Record<string, string> = {
    hot: '行业强势',
    warm: '行业中性',
    cold: '行业弱势',
    unknown: '行业未知',
  };
  return labels[key] || key || '行业未知';
}

function normalizeSegmentKey(value: any, fallback = 'unknown'): string {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function resolveValidationEnvironment(row: any) {
  const metadata = asPlainObject(row.metadata);
  const marketEnvironment = asPlainObject(metadata.market_environment);
  const industryEnvironment = asPlainObject(marketEnvironment.industry);
  const market_regime = normalizeSegmentKey(
    metadata.market_regime || marketEnvironment.market_regime
  );
  const industry_regime = normalizeSegmentKey(
    metadata.industry_regime || industryEnvironment.regime
  );
  const industry = normalizeSegmentKey(
    metadata.industry || metadata.industry_name || industryEnvironment.name,
    'unknown_industry'
  );

  return {
    market_regime,
    market_regime_label:
      metadata.market_regime_label ||
      marketEnvironment.market_regime_label ||
      marketEnvironment.label ||
      marketRegimeLabel(market_regime),
    industry_regime,
    industry_regime_label:
      metadata.industry_regime_label ||
      industryEnvironment.label ||
      industryRegimeLabel(industry_regime),
    industry,
    industry_label: industry === 'unknown_industry' ? '行业未知' : industry,
  };
}

function compactVersionSummary(item: any) {
  if (!item) return null;
  return {
    version_key: item.version_key,
    strategy_key: item.strategy_key,
    strategy_name: item.strategy_name,
    version_type: item.version_type,
    status: item.status,
    completed_count: item.completed_count,
    avg_return_pct: item.avg_return_pct,
    avg_excess_return_pct: item.avg_excess_return_pct,
    recent_avg_excess_return_pct: item.recent_avg_excess_return_pct,
    win_rate: item.win_rate,
    rank_score: item.rank_score,
  };
}

function buildSegmentAttributionRows(
  rows: any[],
  versionByKey: Map<string, any>,
  segmentType: 'market_regime' | 'industry_regime' | 'industry'
) {
  const grouped = new Map<string, { label: string; rows: any[] }>();
  for (const row of rows) {
    const environment = resolveValidationEnvironment(row);
    const key = environment[segmentType];
    const label =
      segmentType === 'market_regime'
        ? environment.market_regime_label
        : segmentType === 'industry_regime'
        ? environment.industry_regime_label
        : environment.industry_label;
    if (!grouped.has(key)) grouped.set(key, { label, rows: [] });
    grouped.get(key)!.rows.push(row);
  }

  return [...grouped.entries()]
    .map(([key, value]) => {
      const completed = value.rows.filter(row => row.status === 'completed');
      const pending = value.rows.filter(row => row.status === 'pending');
      const noData = value.rows.filter(row => row.status === 'no_data');
      const wins = completed.filter(row => toNumber(row.return_pct) > 0);
      const excessWins = completed.filter(row => toNumber(row.excess_return_pct) > 0);
      const avgReturn = completed.length
        ? completed.reduce((sum, row) => sum + toNumber(row.return_pct), 0) / completed.length
        : 0;
      const avgBenchmark = completed.length
        ? completed.reduce((sum, row) => sum + toNumber(row.benchmark_return_pct), 0) /
          completed.length
        : 0;
      const avgExcess = completed.length
        ? completed.reduce((sum, row) => sum + toNumber(row.excess_return_pct), 0) /
          completed.length
        : 0;
      const winRate = completed.length ? (wins.length / completed.length) * 100 : 0;
      const excessWinRate = completed.length ? (excessWins.length / completed.length) * 100 : 0;
      const sampleConfidence = Math.min(1, completed.length / 24);
      const rankScore = round(
        avgExcess * 1.3 + (winRate - 50) * 0.07 + sampleConfidence * 6 - noData.length * 0.08,
        4
      );
      const versionGroups = new Map<string, any[]>();
      for (const row of value.rows) {
        if (!versionGroups.has(row.version_key)) versionGroups.set(row.version_key, []);
        versionGroups.get(row.version_key)!.push(row);
      }
      const versionSummaries = [...versionGroups.values()]
        .map(groupRows => summarizeValidationRows(groupRows, versionByKey))
        .sort((a, b) => toNumber(b.rank_score) - toNumber(a.rank_score));
      const bestVersion =
        versionSummaries.find(item => toNumber(item.completed_count) > 0) || versionSummaries[0];
      const weakestVersion = [...versionSummaries]
        .filter(item => toNumber(item.completed_count) > 0)
        .sort((a, b) => toNumber(a.avg_excess_return_pct) - toNumber(b.avg_excess_return_pct))[0];
      const bestSample = [...completed].sort(
        (a, b) => toNumber(b.return_pct) - toNumber(a.return_pct)
      )[0];
      const worstSample = [...completed].sort(
        (a, b) => toNumber(a.return_pct) - toNumber(b.return_pct)
      )[0];

      return {
        key,
        label: value.label,
        segment_type: segmentType,
        total_count: value.rows.length,
        completed_count: completed.length,
        pending_count: pending.length,
        no_data_count: noData.length,
        avg_return_pct: round(avgReturn, 4),
        avg_benchmark_return_pct: round(avgBenchmark, 4),
        avg_excess_return_pct: round(avgExcess, 4),
        win_rate: round(winRate, 2),
        excess_win_rate: round(excessWinRate, 2),
        rank_score: rankScore,
        best_version: compactVersionSummary(bestVersion),
        weakest_version: compactVersionSummary(weakestVersion),
        top_versions: versionSummaries.slice(0, 3).map(compactVersionSummary).filter(Boolean),
        best_symbol: bestSample?.symbol,
        best_name: bestSample?.name,
        best_return_pct: bestSample ? round(toNumber(bestSample.return_pct), 4) : undefined,
        worst_symbol: worstSample?.symbol,
        worst_name: worstSample?.name,
        worst_return_pct: worstSample ? round(toNumber(worstSample.return_pct), 4) : undefined,
      };
    })
    .sort((a, b) => {
      if (b.completed_count !== a.completed_count) return b.completed_count - a.completed_count;
      return toNumber(b.rank_score) - toNumber(a.rank_score);
    });
}

function buildEnvironmentAttribution(rows: any[], versionByKey: Map<string, any>) {
  const byMarketRegime = buildSegmentAttributionRows(rows, versionByKey, 'market_regime');
  const byIndustryRegime = buildSegmentAttributionRows(rows, versionByKey, 'industry_regime');
  const byIndustry = buildSegmentAttributionRows(rows, versionByKey, 'industry');
  const bestMarket =
    [...byMarketRegime]
      .filter(item => item.completed_count > 0)
      .sort((a, b) => toNumber(b.rank_score) - toNumber(a.rank_score))[0] || null;
  const weakestMarket =
    [...byMarketRegime]
      .filter(item => item.completed_count > 0)
      .sort((a, b) => toNumber(a.avg_excess_return_pct) - toNumber(b.avg_excess_return_pct))[0] ||
    null;
  const bestIndustryRegime =
    [...byIndustryRegime]
      .filter(item => item.completed_count > 0)
      .sort((a, b) => toNumber(b.rank_score) - toNumber(a.rank_score))[0] || null;
  const completedCount = rows.filter(item => item.status === 'completed').length;

  return {
    summary: {
      market_regime_count: byMarketRegime.length,
      industry_regime_count: byIndustryRegime.length,
      industry_count: byIndustry.length,
      completed_count: completedCount,
      best_market_regime: bestMarket,
      weakest_market_regime: weakestMarket,
      best_industry_regime: bestIndustryRegime,
      conclusion: bestMarket
        ? `参数版本在「${bestMarket.label}」环境中表现最好，平均超额 ${bestMarket.avg_excess_return_pct}%（样本 ${bestMarket.completed_count}）。`
        : '参数环境分桶已就绪，等待验证样本完成后识别适合放大的市场/行业环境。',
    },
    by_market_regime: byMarketRegime,
    by_industry_regime: byIndustryRegime,
    by_industry: byIndustry.slice(0, 20),
  };
}

function buildParamMaintenanceStatus(options: {
  versions: any[];
  validations: any[];
  lifecyclePreview: any;
}) {
  const { versions, validations, lifecyclePreview } = options;
  const now = new Date();
  const completed = validations.filter(item => item.status === 'completed');
  const pending = validations.filter(item => item.status === 'pending');
  const noData = validations.filter(item => item.status === 'no_data');
  const latestUpdatedAt = validations
    .map(item => new Date(item.updated_at || item.created_at || 0).getTime())
    .filter(item => Number.isFinite(item) && item > 0)
    .sort((a, b) => b - a)[0];
  const latestCompletedAt = completed
    .map(item => new Date(item.updated_at || item.created_at || 0).getTime())
    .filter(item => Number.isFinite(item) && item > 0)
    .sort((a, b) => b - a)[0];
  const latestSignalDate = validations
    .map(item => String(item.signal_date || '').slice(0, 10))
    .filter(Boolean)
    .sort()
    .pop();
  const latestEvaluationDate = validations
    .map(item => String(item.evaluation_date || '').slice(0, 10))
    .filter(Boolean)
    .sort()
    .pop();
  const activeCandidateCount = versions.filter(item => item.status === 'active_candidate').length;
  const championCount = versions.filter(item => item.status === 'champion').length;
  const degradedCount = versions.filter(item => item.status === 'degraded').length;
  const rolledBackCount = versions.filter(item => item.status === 'rolled_back').length;
  const promotionCount = toNumber(lifecyclePreview?.summary?.promotion_count);
  const degradationCount = toNumber(lifecyclePreview?.summary?.degradation_count);
  const rollbackCount = toNumber(lifecyclePreview?.summary?.rollback_count);
  const actionableCount = promotionCount + degradationCount + rollbackCount;
  const staleHours = latestUpdatedAt ? (now.getTime() - latestUpdatedAt) / 3600000 : null;
  const completionRate = validations.length ? (completed.length / validations.length) * 100 : 0;
  const pendingRate = validations.length ? (pending.length / validations.length) * 100 : 0;
  const noDataRate = validations.length ? (noData.length / validations.length) * 100 : 0;
  const status =
    validations.length === 0 || !latestUpdatedAt
      ? 'empty'
      : actionableCount > 0
      ? 'actionable'
      : staleHours !== null && staleHours > 36
      ? 'stale'
      : pendingRate > 80 && completed.length < 10
      ? 'warming_up'
      : 'healthy';
  const nextAction =
    status === 'empty'
      ? '等待下一次量化扫描生成 A/B 样本'
      : status === 'actionable'
      ? '执行参数生命周期维护'
      : status === 'stale'
      ? '刷新参数收益后验'
      : status === 'warming_up'
      ? '继续等待 1/3/5/10 日窗口完成'
      : '保持自动维护';
  const conclusion =
    status === 'empty'
      ? '参数 A/B 账本尚未产生样本；下一次量化扫描会自动创建。'
      : status === 'actionable'
      ? `发现 ${actionableCount} 个参数生命周期动作待处理（推广 ${promotionCount}、降级 ${degradationCount}、回滚 ${rollbackCount}）。`
      : status === 'stale'
      ? `参数后验超过 ${round(staleHours || 0, 1)} 小时未刷新，建议触发量化参数后验维护任务。`
      : status === 'warming_up'
      ? `参数样本已沉淀但多数仍在等待持有期完成；已完成 ${completed.length}，待完成 ${pending.length}。`
      : `参数后验维护正常：完成 ${completed.length} 条，待完成 ${pending.length} 条，冠军 ${championCount} 个。`;

  return {
    status,
    next_action: nextAction,
    conclusion,
    completion_rate: round(completionRate, 2),
    pending_rate: round(pendingRate, 2),
    no_data_rate: round(noDataRate, 2),
    latest_updated_at: latestUpdatedAt ? new Date(latestUpdatedAt).toISOString() : null,
    latest_completed_at: latestCompletedAt ? new Date(latestCompletedAt).toISOString() : null,
    stale_hours: staleHours === null ? null : round(staleHours, 2),
    latest_signal_date: latestSignalDate || null,
    latest_evaluation_date: latestEvaluationDate || null,
    actionable_lifecycle_count: actionableCount,
    promotion_count: promotionCount,
    degradation_count: degradationCount,
    rollback_count: rollbackCount,
    active_candidate_count: activeCandidateCount,
    champion_count: championCount,
    degraded_count: degradedCount,
    rolled_back_count: rolledBackCount,
  };
}

function normalizeStringArray(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.map(item => String(item || '').trim()).filter(item => item && item !== 'unknown')
    ),
  ];
}

function paramVersionKeysFromOutcome(outcome: any): string[] {
  const metadata = asPlainObject(outcome.metadata);
  const strategyVariant = asPlainObject(metadata.strategy_variant);
  const signalMetadata = asPlainObject(metadata.signal_metadata);
  const signalVariant = asPlainObject(signalMetadata.strategy_variant);
  const signalFactors = asPlainObject(signalMetadata.factors);
  const paperTrading = asPlainObject(metadata.paper_trading);
  const paperVariant = asPlainObject(paperTrading.strategy_variant);
  return [
    ...new Set(
      [
        ...normalizeStringArray(strategyVariant.param_version_keys),
        ...normalizeStringArray(signalVariant.param_version_keys),
        ...normalizeStringArray(signalFactors.param_version_keys),
        ...normalizeStringArray(paperVariant.param_version_keys),
        strategyVariant.param_version_key,
        signalVariant.param_version_key,
        signalMetadata.param_version_key,
        signalFactors.param_version_key,
        paperVariant.param_version_key,
      ]
        .map(item => String(item || '').trim())
        .filter(item => item && item !== 'unknown')
    ),
  ];
}

function summarizeParamTradeOutcomeRows(versionKey: string, rows: any[]) {
  const closed = rows.filter(item => item.trade_status === 'closed');
  const open = rows.filter(item => item.trade_status !== 'closed');
  const wins = closed.filter(item => toNumber(item.total_pnl) > 0);
  const excessWins = closed.filter(item => toNumber(item.excess_return_pct) > 0);
  const avgReturn = closed.length
    ? closed.reduce((sum, item) => sum + toNumber(item.total_pnl_pct), 0) / closed.length
    : 0;
  const avgExcess = closed.length
    ? closed.reduce((sum, item) => sum + toNumber(item.excess_return_pct), 0) / closed.length
    : 0;
  const totalPnl = rows.reduce((sum, item) => sum + toNumber(item.total_pnl), 0);
  const best = [...rows].sort((a, b) => toNumber(b.total_pnl_pct) - toNumber(a.total_pnl_pct))[0];
  const worst = [...rows].sort((a, b) => toNumber(a.total_pnl_pct) - toNumber(b.total_pnl_pct))[0];

  return {
    param_version_key: versionKey,
    total_count: rows.length,
    open_count: open.length,
    closed_count: closed.length,
    win_rate: closed.length ? round((wins.length / closed.length) * 100, 2) : 0,
    excess_win_rate: closed.length ? round((excessWins.length / closed.length) * 100, 2) : 0,
    avg_return_pct: round(avgReturn, 4),
    avg_excess_return_pct: round(avgExcess, 4),
    total_pnl: round(totalPnl, 2),
    best_symbol: best?.symbol,
    best_name: best?.name,
    best_return_pct: best ? round(toNumber(best.total_pnl_pct), 4) : undefined,
    worst_symbol: worst?.symbol,
    worst_name: worst?.name,
    worst_return_pct: worst ? round(toNumber(worst.total_pnl_pct), 4) : undefined,
  };
}

export class QuantStrategyParamVersionService {
  async getActiveParamsForScan(options: ActiveScanParamOptions = {}) {
    const definitions = strategyRegistry
      .list()
      .filter(
        definition =>
          !options.strategy_keys?.length || options.strategy_keys.includes(definition.strategy_key)
      );
    const strategyKeys = definitions.map(item => item.strategy_key);
    const manualParamsByStrategy = asPlainObject(options.manual_params_by_strategy);
    const includeDefault = options.include_default !== false;
    const statuses = ['manual_override', 'champion', 'active_candidate'];
    if (options.include_observing) statuses.push('observing');
    if (options.include_degraded) statuses.push('degraded');
    if (includeDefault) statuses.push('baseline');
    const versionTypes = ['manual', 'default'];
    if (options.include_experiment !== false) versionTypes.push('experiment');
    if (options.include_grid_search !== false) versionTypes.push('grid_search');

    const rawVersions = strategyKeys.length
      ? await QuantStrategyParamVersion.findAll({
          where: {
            strategy_key: { [Op.in]: strategyKeys },
            status: { [Op.in]: statuses },
            version_type: { [Op.in]: versionTypes },
          },
          order: [
            ['strategy_key', 'ASC'],
            ['updated_at', 'DESC'],
          ],
        })
      : [];
    const excludedVersions = await this.getScanExcludedVersions(strategyKeys);
    const excludedByStrategy = new Map<string, QuantStrategyParamVersion[]>();
    for (const version of excludedVersions) {
      if (!excludedByStrategy.has(version.strategy_key)) {
        excludedByStrategy.set(version.strategy_key, []);
      }
      excludedByStrategy.get(version.strategy_key)!.push(version);
    }
    const versions = rawVersions.filter(version => !this.shouldExcludeFromScan(version));
    const versionsByStrategy = new Map<string, QuantStrategyParamVersion[]>();
    for (const version of versions) {
      if (!versionsByStrategy.has(version.strategy_key)) {
        versionsByStrategy.set(version.strategy_key, []);
      }
      versionsByStrategy.get(version.strategy_key)!.push(version);
    }

    const adoptedByStrategy: Record<string, ParamVersionPlain> = {};
    const recommendedParamsForScan: Record<string, Record<string, any>> = {};
    const selectionRows: any[] = [];
    const diagnosticsByStrategy: Record<string, any> = {};
    let manualOverrideCount = 0;
    let championCount = 0;
    let gridSearchCount = 0;
    let experimentCount = 0;
    let defaultCount = 0;

    for (const definition of definitions) {
      const baseParams = asPlainObject(definition.default_params);
      const candidatesForStrategy = versionsByStrategy.get(definition.strategy_key) || [];
      let selected = this.selectBestScanVersion(candidatesForStrategy);
      const excludedForStrategy = excludedByStrategy.get(definition.strategy_key) || [];
      const manualParams = asPlainObject(manualParamsByStrategy[definition.strategy_key]);

      if (Object.keys(manualParams).length > 0) {
        const manualVersion = await this.upsertVersion({
          version_key: buildManualVersionKey(definition.strategy_key, {
            ...baseParams,
            ...manualParams,
          }),
          strategy_key: definition.strategy_key,
          strategy_name: definition.name,
          version_type: 'manual',
          status: 'manual_override',
          params_json: {
            ...baseParams,
            ...manualParams,
          },
          active_from: moment().tz('Asia/Shanghai').format('YYYY-MM-DD'),
          adoption_reason: '任务参数手工覆盖，优先级高于冠军/网格/实验参数。',
          metadata: {
            ab_group: 'manual_override',
            source: 'task_params_by_strategy',
          },
        });
        selected = manualVersion;
      }

      if (!selected && includeDefault) {
        selected = await this.upsertVersion({
          version_key: buildDefaultVersionKey(definition.strategy_key),
          strategy_key: definition.strategy_key,
          strategy_name: definition.name,
          version_type: 'default',
          status: 'baseline',
          params_json: baseParams,
          active_from: moment().tz('Asia/Shanghai').format('YYYY-MM-DD'),
          adoption_reason: '默认参数基线。',
          metadata: {
            ab_group: 'default',
            source: 'strategy_default',
            risk_level: definition.risk_level,
            tags: definition.tags || [],
          },
        });
      }

      if (!selected) continue;
      const plain = modelToPlain<ParamVersionPlain>(selected);
      const fullParams = {
        ...baseParams,
        ...asPlainObject(plain.params_json),
      };
      adoptedByStrategy[definition.strategy_key] = {
        ...plain,
        params_json: fullParams,
      };
      recommendedParamsForScan[definition.strategy_key] = fullParams;

      const status = String(plain.status || '').toLowerCase();
      const type = String(plain.version_type || '').toLowerCase();
      if (status === 'manual_override' || type === 'manual') manualOverrideCount++;
      else if (status === 'champion') championCount++;
      else if (type === 'grid_search') gridSearchCount++;
      else if (type === 'experiment') experimentCount++;
      else if (type === 'default') defaultCount++;

      selectionRows.push({
        strategy_key: definition.strategy_key,
        strategy_name: definition.name,
        version_key: plain.version_key,
        version_type: plain.version_type,
        status: plain.status,
        rank_score: toNumber(plain.source_rank_score, 0),
        source_excess_return_pct: toNumber(plain.source_excess_return_pct, 0),
        source_trade_count: toNumber(plain.source_trade_count, 0),
        reason: plain.adoption_reason || '按参数版本优先级自动选择。',
      });
      diagnosticsByStrategy[definition.strategy_key] = this.buildScanSelectionDiagnostic(
        definition,
        selected,
        candidatesForStrategy,
        excludedForStrategy
      );
    }

    return {
      generated_at: new Date().toISOString(),
      recommended_params_by_strategy: recommendedParamsForScan,
      adopted_param_version_by_strategy: adoptedByStrategy,
      selections: selectionRows,
      diagnostics_by_strategy: diagnosticsByStrategy,
      summary: {
        strategy_count: definitions.length,
        adopted_strategy_count: selectionRows.length,
        manual_override_count: manualOverrideCount,
        champion_count: championCount,
        grid_search_count: gridSearchCount,
        experiment_count: experimentCount,
        default_count: defaultCount,
        conclusion:
          championCount + gridSearchCount + experimentCount + manualOverrideCount > 0
            ? `已为 ${selectionRows.length} 个策略选择可用于开盘扫描的参数版本，其中冠军 ${championCount}、网格 ${gridSearchCount}、实验 ${experimentCount}、手工 ${manualOverrideCount}。`
            : '暂无冠军/网格/实验参数可采用，本轮扫描使用默认参数基线。',
      },
    };
  }

  async upsertGridSearchCandidates(options: { groups?: any[]; min_rank_score?: number } = {}) {
    const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    const definitionsByKey = new Map(
      strategyRegistry.list().map(item => [item.strategy_key, item])
    );
    const minRankScore = toNumber(options.min_rank_score, 0);
    const candidates = (options.groups || [])
      .map(group => ({ group, best: group?.best }))
      .filter(item => item.best?.strategy_key && item.best?.params);
    const versions: QuantStrategyParamVersion[] = [];

    for (const { group, best } of candidates) {
      if (toNumber(best.rank_score, -9999) < minRankScore) continue;
      const definition = definitionsByKey.get(best.strategy_key);
      const params = {
        ...(definition?.default_params || {}),
        ...asPlainObject(best.params),
      };
      const version = await this.upsertVersion({
        version_key: buildGridVersionKey(best.strategy_key, group.group_id, params),
        strategy_key: best.strategy_key,
        strategy_name: definition?.name || best.strategy_key,
        version_type: 'grid_search',
        status: best.validation_verdict === 'passed' ? 'active_candidate' : 'observing',
        params_json: params,
        source_experiment_key: group.group_id,
        source_rank_score: best.rank_score,
        source_excess_return_pct: best.excess_return_pct,
        source_max_drawdown_pct: best.max_drawdown_pct,
        source_trade_count: best.trade_count || 0,
        adoption_reason: `参数网格搜索冠军：${group.conclusion || ''}`,
        active_from: today,
        metadata: {
          ab_group:
            best.validation_verdict === 'passed' ? 'grid_search_candidate' : 'grid_search_observe',
          source: 'parameter_grid_search',
          group_id: group.group_id,
          task_id: best.task_id,
          grid_index: best.grid_index,
          validation_verdict: best.validation_verdict,
          validation_excess_return_pct: best.validation_excess_return_pct,
          test_excess_return_pct: best.test_excess_return_pct,
          total_return_pct: best.total_return_pct,
        },
      });
      versions.push(version);
    }

    return {
      generated_at: new Date().toISOString(),
      scanned_group_count: options.groups?.length || 0,
      upserted_count: versions.length,
      versions: versions.map(item => modelToPlain(item)),
      conclusion: versions.length
        ? `已将 ${versions.length} 个网格冠军参数沉淀为参数版本候选。`
        : '暂无达到门槛的网格冠军参数版本。',
    };
  }

  async refreshVersionsFromExperiments(
    options: {
      suggestions?: ParamSuggestionPayload | null;
      suggestion_options?: Record<string, any>;
      manual_params_by_strategy?: Record<string, Record<string, any>>;
      use_experiment_params?: boolean;
    } = {}
  ) {
    const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    const definitions = strategyRegistry.list();
    const manualParamsByStrategy = asPlainObject(options.manual_params_by_strategy);
    const suggestions =
      options.suggestions !== undefined
        ? options.suggestions
        : options.use_experiment_params === false
        ? null
        : await quantStrategyExperimentService.getParamsByStrategySuggestion(
            options.suggestion_options || {}
          );
    const suggestionByStrategy = new Map(
      ((suggestions as any)?.suggestions || []).map((item: any) => [item.strategy_key, item])
    );
    const recommendedParamsByStrategy = asPlainObject(
      (suggestions as any)?.recommended_params_by_strategy
    );

    const versions: QuantStrategyParamVersion[] = [];
    const adoptedByStrategy: Record<string, ParamVersionPlain> = {};
    const recommendedParamsForScan: Record<string, Record<string, any>> = {};

    for (const definition of definitions) {
      const defaultPayload = {
        version_key: buildDefaultVersionKey(definition.strategy_key),
        strategy_key: definition.strategy_key,
        strategy_name: definition.name,
        version_type: 'default',
        status: 'baseline',
        params_json: definition.default_params || {},
        active_from: today,
        metadata: {
          ab_group: 'default',
          source: 'strategy_default',
          risk_level: definition.risk_level,
          tags: definition.tags || [],
        },
      };
      const defaultVersion = await this.upsertVersion(defaultPayload);
      versions.push(defaultVersion);
      adoptedByStrategy[definition.strategy_key] = modelToPlain(defaultVersion);

      const suggestion = suggestionByStrategy.get(definition.strategy_key) as any;
      if (suggestion?.source_experiment) {
        const experimentParams = {
          ...(definition.default_params || {}),
          ...asPlainObject(suggestion.recommended_params),
        };
        const experimentPayload = {
          version_key: buildExperimentVersionKey(
            definition.strategy_key,
            suggestion.source_experiment?.experiment_key,
            experimentParams
          ),
          strategy_key: definition.strategy_key,
          strategy_name: definition.name,
          version_type: 'experiment',
          status: suggestion.action === 'use' ? 'active_candidate' : 'observing',
          params_json: experimentParams,
          source_experiment_id: suggestion.source_experiment?.id,
          source_experiment_key: suggestion.source_experiment?.experiment_key,
          source_rank_score: suggestion.source_experiment?.rank_score,
          source_excess_return_pct: suggestion.source_experiment?.excess_return_pct,
          source_max_drawdown_pct: suggestion.source_experiment?.max_drawdown_pct,
          source_trade_count: suggestion.source_experiment?.trade_count || 0,
          adoption_reason: suggestion.reason,
          active_from: today,
          metadata: {
            ab_group: suggestion.action === 'use' ? 'experiment_candidate' : 'experiment_observe',
            action: suggestion.action,
            confidence: suggestion.confidence,
            stable_count: suggestion.stable_count,
            experiment_count: suggestion.experiment_count,
            policy: (suggestions as any)?.policy,
          },
        };
        const experimentVersion = await this.upsertVersion(experimentPayload);
        versions.push(experimentVersion);
        if (options.use_experiment_params !== false && suggestion.action === 'use') {
          adoptedByStrategy[definition.strategy_key] = modelToPlain(experimentVersion);
          recommendedParamsForScan[definition.strategy_key] = experimentPayload.params_json;
        }
      }

      const manualParams = asPlainObject(manualParamsByStrategy[definition.strategy_key]);
      if (Object.keys(manualParams).length > 0) {
        const manualFullParams = {
          ...(definition.default_params || {}),
          ...manualParams,
        };
        const manualVersion = await this.upsertVersion({
          version_key: buildManualVersionKey(definition.strategy_key, manualFullParams),
          strategy_key: definition.strategy_key,
          strategy_name: definition.name,
          version_type: 'manual',
          status: 'manual_override',
          params_json: manualFullParams,
          active_from: today,
          adoption_reason: '任务参数手工覆盖，优先级高于实验建议。',
          metadata: {
            ab_group: 'manual_override',
            source: 'task_params_by_strategy',
          },
        });
        versions.push(manualVersion);
        adoptedByStrategy[definition.strategy_key] = modelToPlain(manualVersion);
        recommendedParamsForScan[definition.strategy_key] = manualFullParams;
      } else if (recommendedParamsByStrategy[definition.strategy_key]) {
        recommendedParamsForScan[definition.strategy_key] = asPlainObject(
          recommendedParamsByStrategy[definition.strategy_key]
        );
      }
    }

    const uniqueVersions = [...new Map(versions.map(item => [item.version_key, item])).values()];
    const activeCandidateCount = uniqueVersions.filter(
      item => item.status === 'active_candidate'
    ).length;
    const manualOverrideCount = uniqueVersions.filter(
      item => item.status === 'manual_override'
    ).length;

    return {
      generated_at: new Date().toISOString(),
      versions: uniqueVersions.map(item => modelToPlain(item)),
      adopted_param_version_by_strategy: adoptedByStrategy,
      recommended_params_by_strategy: recommendedParamsForScan,
      summary: {
        strategy_count: definitions.length,
        version_count: uniqueVersions.length,
        active_candidate_count: activeCandidateCount,
        manual_override_count: manualOverrideCount,
        conclusion:
          activeCandidateCount > 0
            ? `已生成 ${activeCandidateCount} 个实验候选参数版本，开盘扫描将按 A/B 验证持续跟踪。`
            : '暂无达到自动采用门槛的实验参数版本，继续以默认参数为基准验证。',
      },
    };
  }

  async createPendingValidationsFromSignals(
    options: {
      trade_date?: string;
      start_date?: string;
      end_date?: string;
      strategy_keys?: string[];
      horizons?: number[];
      limit?: number;
      signal?: string[];
    } = {}
  ) {
    const where: any = {};
    if (options.trade_date) where.trade_date = options.trade_date;
    if (options.start_date || options.end_date) {
      where.trade_date = {};
      if (options.start_date) where.trade_date[Op.gte] = options.start_date;
      if (options.end_date) where.trade_date[Op.lte] = options.end_date;
    }
    if (options.strategy_keys?.length) where.strategy_key = { [Op.in]: options.strategy_keys };
    where.signal = { [Op.in]: options.signal?.length ? options.signal : ['buy', 'watch'] };

    const signals = await QuantSignal.findAll({
      where,
      order: [
        ['trade_date', 'DESC'],
        ['score', 'DESC'],
      ],
      limit: toPositiveInt(options.limit, 500, 5000),
    });
    if (!signals.length) {
      return { created: 0, updated: 0, scanned: 0, horizons: options.horizons || [1, 3, 5, 10] };
    }

    const versions = await QuantStrategyParamVersion.findAll();
    const latestVersionByStrategy = new Map<string, QuantStrategyParamVersion>();
    for (const version of versions) {
      const existing = latestVersionByStrategy.get(version.strategy_key);
      const priority = this.versionPriority(version);
      const existingPriority = existing ? this.versionPriority(existing) : -1;
      if (!existing || priority > existingPriority) {
        latestVersionByStrategy.set(version.strategy_key, version);
      }
    }

    const horizons = (options.horizons?.length ? options.horizons : [1, 3, 5, 10])
      .map(item => toPositiveInt(item, 1, 60))
      .filter(Boolean);
    let created = 0;
    let updated = 0;

    for (const signal of signals) {
      const raw = asPlainObject(signal.raw_factors);
      const marketEnvironment = asPlainObject(raw.market_environment);
      const industryEnvironment = asPlainObject(marketEnvironment.industry);
      const inferredVersion =
        raw.param_version_key ||
        latestVersionByStrategy.get(signal.strategy_key)?.version_key ||
        buildDefaultVersionKey(signal.strategy_key);
      for (const horizon of horizons) {
        const payload = {
          version_key: inferredVersion,
          strategy_key: signal.strategy_key,
          quant_signal_id: signal.id,
          symbol: normalizeSymbol(signal.symbol),
          name: signal.name,
          signal_date: signal.trade_date,
          entry_price: signal.entry_price,
          horizon_days: horizon,
          evaluation_date: addCalendarDays(signal.trade_date, horizon),
          status: 'pending',
          metadata: {
            source: 'quant_signal',
            quant_signal_score: signal.score,
            quant_signal: signal.signal,
            param_version_type: raw.param_version_type,
            param_version_status: raw.param_version_status,
            param_version_key: inferredVersion,
            param_version_ab_group: raw.param_version_ab_group,
            param_version_source_experiment_key: raw.param_version_source_experiment_key,
            price_source: raw.price_source,
            latest_quote_time: raw.latest_quote_time,
            market_environment: marketEnvironment,
            market_regime: raw.market_regime || marketEnvironment.market_regime,
            market_regime_label:
              marketEnvironment.market_regime_label ||
              marketEnvironment.label ||
              marketRegimeLabel(
                String(raw.market_regime || marketEnvironment.market_regime || 'unknown')
              ),
            industry: raw.industry || industryEnvironment.name,
            industry_regime: raw.industry_regime || industryEnvironment.regime,
            industry_regime_label:
              industryEnvironment.label ||
              industryRegimeLabel(
                String(raw.industry_regime || industryEnvironment.regime || 'unknown')
              ),
          },
        };
        const [row, isCreated] = await QuantStrategyParamValidation.findOrCreate({
          where: {
            version_key: payload.version_key,
            symbol: payload.symbol,
            signal_date: payload.signal_date,
            horizon_days: payload.horizon_days,
          },
          defaults: payload as any,
        });
        if (isCreated) {
          created++;
        } else if (row.status === 'pending') {
          await row.update({
            quant_signal_id: payload.quant_signal_id,
            entry_price: row.entry_price || payload.entry_price,
            metadata: {
              ...(row.metadata || {}),
              ...payload.metadata,
            },
          } as any);
          updated++;
        }
      }
    }

    return { created, updated, scanned: signals.length, horizons };
  }

  async refreshValidationReturns(
    options: {
      limit?: number;
      status?: string[];
      include_completed?: boolean;
      auto_sync_benchmark?: boolean;
    } = {}
  ) {
    const statuses = options.status?.length
      ? options.status
      : options.include_completed
      ? ['pending', 'completed']
      : ['pending'];
    const rows = await QuantStrategyParamValidation.findAll({
      where: { status: { [Op.in]: statuses } },
      order: [
        ['signal_date', 'DESC'],
        ['id', 'ASC'],
      ],
      limit: toPositiveInt(options.limit, 1000, 10000),
    });

    let completed = 0;
    let pending = 0;
    let noData = 0;
    const touched: QuantStrategyParamValidation[] = [];
    const stockCache = new Map<string, Stock | null>();
    const barsCache = new Map<number, DailyBar[]>();

    for (const row of rows) {
      const symbol = normalizeSymbol(row.symbol);
      if (!stockCache.has(symbol)) {
        stockCache.set(symbol, await Stock.findOne({ where: { symbol } }));
      }
      const stock = stockCache.get(symbol);
      if (!stock) {
        await row.update({
          status: 'no_data',
          metadata: { ...(row.metadata || {}), no_data_reason: 'stock_not_found' },
        } as any);
        noData++;
        touched.push(row);
        continue;
      }

      if (!barsCache.has(stock.id)) {
        barsCache.set(
          stock.id,
          await DailyBar.findAll({
            where: {
              stock_id: stock.id,
              time: { [Op.gte]: new Date(`${row.signal_date}T00:00:00.000Z`) },
            },
            order: [['time', 'ASC']],
            limit: 160,
          })
        );
      }
      const bars = barsCache.get(stock.id) || [];
      const entryIndex = bars.findIndex(bar => dateOnly(bar.time) >= row.signal_date);
      if (entryIndex < 0) {
        await row.update({
          status: 'no_data',
          metadata: { ...(row.metadata || {}), no_data_reason: 'entry_bar_not_found' },
        } as any);
        noData++;
        touched.push(row);
        continue;
      }

      const entryBar = bars[entryIndex];
      const entryPrice = toNumber(row.entry_price, toNumber(entryBar.close));
      const exitIndex = entryIndex + toPositiveInt(row.horizon_days, 1, 60);
      const latestBar = bars[bars.length - 1];
      if (bars.length <= exitIndex) {
        const latestPrice = toNumber(latestBar?.close, entryPrice);
        const partialReturn = entryPrice > 0 ? ((latestPrice - entryPrice) / entryPrice) * 100 : 0;
        await row.update({
          entry_price: entryPrice,
          latest_price: latestPrice,
          return_pct: round(partialReturn, 4),
          status: 'pending',
          metadata: {
            ...(row.metadata || {}),
            partial: true,
            latest_bar_date: latestBar ? dateOnly(latestBar.time) : undefined,
            needed_trading_bars: row.horizon_days,
          },
        } as any);
        pending++;
        touched.push(row);
        continue;
      }

      const exitBar = bars[exitIndex];
      const exitDate = dateOnly(exitBar.time);
      const exitPrice = toNumber(exitBar.close);
      const returnPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
      let benchmarkReturnPct = 0;
      let benchmark: any = null;
      try {
        benchmark = await benchmarkIndexService.getBenchmarkReturnForStock(
          symbol,
          row.signal_date,
          exitDate,
          { stock, auto_sync: Boolean(options.auto_sync_benchmark) }
        );
        benchmarkReturnPct = toNumber(benchmark?.benchmark_return_pct, 0);
      } catch (error: any) {
        logger.warn(`参数版本收益验证读取基准失败 ${symbol}: ${error?.message || error}`);
      }

      await row.update({
        entry_price: entryPrice,
        evaluation_date: exitDate,
        latest_price: exitPrice,
        return_pct: round(returnPct, 4),
        benchmark_return_pct: round(benchmarkReturnPct, 4),
        excess_return_pct: round(returnPct - benchmarkReturnPct, 4),
        status: 'completed',
        metadata: {
          ...(row.metadata || {}),
          partial: false,
          exit_bar_date: exitDate,
          benchmark,
        },
      } as any);
      completed++;
      touched.push(row);
    }

    return {
      refreshed: touched.length,
      completed,
      pending,
      no_data: noData,
      rows: touched.map(item => modelToPlain(item)),
    };
  }

  async getDashboard(options: { limit?: number; strategy_key?: string } = {}) {
    const versionWhere: any = {};
    const validationWhere: any = {};
    if (options.strategy_key) {
      versionWhere.strategy_key = options.strategy_key;
      validationWhere.strategy_key = options.strategy_key;
    }
    const [versions, validations] = await Promise.all([
      QuantStrategyParamVersion.findAll({
        where: versionWhere,
        order: [
          ['strategy_key', 'ASC'],
          ['status', 'ASC'],
          ['updated_at', 'DESC'],
        ],
        limit: toPositiveInt(options.limit, 200, 1000),
      }),
      QuantStrategyParamValidation.findAll({
        where: validationWhere,
        order: [
          ['signal_date', 'DESC'],
          ['horizon_days', 'ASC'],
        ],
        limit: toPositiveInt(options.limit, 1000, 5000),
      }),
    ]);
    const plainVersions = versions.map(item => modelToPlain<any>(item));
    const plainValidations = validations.map(item => modelToPlain<any>(item));
    const versionByKey = new Map(plainVersions.map(item => [item.version_key, item]));
    const groupedByVersion = new Map<string, any[]>();
    for (const row of plainValidations) {
      if (!groupedByVersion.has(row.version_key)) groupedByVersion.set(row.version_key, []);
      groupedByVersion.get(row.version_key)!.push(row);
    }
    const summaryByVersion = [...groupedByVersion.values()]
      .map(rows => summarizeValidationRows(rows, versionByKey))
      .sort((a, b) => toNumber(b.rank_score) - toNumber(a.rank_score));
    const groupedByStrategy = new Map<string, any[]>();
    for (const item of summaryByVersion) {
      if (!groupedByStrategy.has(item.strategy_key)) groupedByStrategy.set(item.strategy_key, []);
      groupedByStrategy.get(item.strategy_key)!.push(item);
    }
    const summaryByStrategy = [...groupedByStrategy.entries()].map(([strategy_key, rows]) => {
      const champion = [...rows].sort((a, b) => toNumber(b.rank_score) - toNumber(a.rank_score))[0];
      return {
        strategy_key,
        strategy_name: champion?.strategy_name,
        version_count: rows.length,
        champion,
        avg_excess_return_pct: round(
          rows.reduce((sum, item) => sum + toNumber(item.avg_excess_return_pct), 0) /
            Math.max(rows.length, 1),
          4
        ),
      };
    });
    const defaultByStrategy = new Map(
      summaryByVersion
        .filter(item => item.version_type === 'default' || item.status === 'baseline')
        .map(item => [item.strategy_key, item])
    );
    const strategyRiskByKey = new Map(
      strategyRegistry
        .list()
        .map(definition => [definition.strategy_key, normalizeRiskLevel(definition.risk_level)])
    );
    const lifecyclePreview = this.buildLifecyclePreview(
      summaryByVersion,
      defaultByStrategy,
      undefined,
      undefined,
      undefined,
      strategyRiskByKey,
      undefined, // Phase 1: wf 验证暂不在 dashboard preview 中要求（避免阻塞展示），lifecycle apply 时才强制
      undefined // Phase 4: edge_hypothesis 同理
    );
    const environmentAttribution = buildEnvironmentAttribution(plainValidations, versionByKey);
    const champion =
      lifecyclePreview.promotions[0] ||
      summaryByVersion.find(item => item.status === 'champion' && item.completed_count > 0) ||
      summaryByVersion.find(item => item.completed_count > 0) ||
      null;
    const completedCount = plainValidations.filter(item => item.status === 'completed').length;
    const pendingCount = plainValidations.filter(item => item.status === 'pending').length;
    const activeCandidateCount = plainVersions.filter(
      item => item.status === 'active_candidate'
    ).length;
    const championCount = plainVersions.filter(item => item.status === 'champion').length;
    const degradedCount = plainVersions.filter(item => item.status === 'degraded').length;
    const rolledBackCount = plainVersions.filter(item => item.status === 'rolled_back').length;
    const maintenanceStatus = buildParamMaintenanceStatus({
      versions: plainVersions,
      validations: plainValidations,
      lifecyclePreview,
    });

    return {
      generated_at: new Date().toISOString(),
      versions: plainVersions,
      validations: plainValidations,
      summary_by_version: summaryByVersion,
      summary_by_strategy: summaryByStrategy,
      champion,
      lifecycle: lifecyclePreview,
      maintenance_status: maintenanceStatus,
      environment_attribution: environmentAttribution,
      summary: {
        version_count: plainVersions.length,
        active_candidate_count: activeCandidateCount,
        champion_count: championCount,
        degraded_count: degradedCount,
        rolled_back_count: rolledBackCount,
        validation_count: plainValidations.length,
        maintenance_status: maintenanceStatus.status,
        maintenance_next_action: maintenanceStatus.next_action,
        completed_count: completedCount,
        pending_count: pendingCount,
        conclusion: champion
          ? `当前参数 A/B 冠军为 ${champion.strategy_name || champion.strategy_key} / ${
              champion.version_key
            }，平均超额 ${champion.avg_excess_return_pct}%（样本 ${champion.completed_count}）。`
          : pendingCount > 0
          ? '参数版本已开始留痕，等待 1/3/5/10 日收益样本完成。'
          : '参数版本验证尚未产生样本；下一次量化扫描后会自动创建待验证记录。',
      },
    };
  }

  async evaluateAndApplyLifecycle(
    options: {
      policy?: Partial<ParamVersionLifecyclePolicy>;
      dry_run?: boolean;
      limit?: number;
    } = {}
  ) {
    const dashboard = await this.getDashboard({ limit: options.limit || 5000 });
    const versionByKey = new Map(
      (dashboard.versions || []).map((version: any) => [version.version_key, version])
    );
    const rows = dashboard.summary_by_version || [];
    const defaultByStrategy = new Map(
      rows
        .filter((row: any) => row.version_type === 'default' || row.status === 'baseline')
        .map((row: any) => [row.strategy_key, row])
    );
    const tradeAttribution = await this.getParamExperimentTradeAttribution();
    const strategyRiskByKey = new Map(
      strategyRegistry
        .list()
        .map(definition => [definition.strategy_key, normalizeRiskLevel(definition.risk_level)])
    );

    // Phase 1: 加载所有涉及策略的最近 walk-forward verdict (按 wf_max_age_days 范围)
    const policyForLoad = mergeLifecyclePolicy(options.policy);
    const wfVerdicts = await this.loadRecentWalkForwardVerdicts(
      rows.map((r: any) => r.strategy_key),
      policyForLoad.wf_max_age_days
    );

    // Phase 4: 加载所有涉及策略的 edge_hypothesis
    const edgeHypotheses = await this.loadStrategyEdgeHypotheses(
      rows.map((r: any) => r.strategy_key)
    );

    // Sprint 1A: 加载所有涉及策略的最近 research-integrity audit (按 ri_max_age_days 范围)
    const riVerdicts = await this.loadRecentResearchIntegrityVerdicts(
      rows.map((r: any) => r.strategy_key),
      policyForLoad.ri_max_age_days
    );

    const lifecycle = this.buildLifecyclePreview(
      rows,
      defaultByStrategy,
      options.policy,
      dashboard.environment_attribution,
      tradeAttribution,
      strategyRiskByKey,
      wfVerdicts,
      edgeHypotheses,
      riVerdicts
    );
    if (options.dry_run) {
      return {
        generated_at: new Date().toISOString(),
        dry_run: true,
        applied: 0,
        trade_attribution: tradeAttribution,
        lifecycle,
      };
    }

    const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    let applied = 0;
    const updated: any[] = [];
    const actions = [
      ...lifecycle.promotions.map((item: any) => ({ ...item, next_status: 'champion' })),
      ...lifecycle.degradations.map((item: any) => ({ ...item, next_status: 'degraded' })),
      ...lifecycle.rollbacks.map((item: any) => ({ ...item, next_status: 'rolled_back' })),
    ];
    for (const action of actions) {
      const plainVersion = versionByKey.get(action.version_key);
      if (!plainVersion) continue;
      const currentStatus = String(plainVersion.status || '');
      if (currentStatus === action.next_status) continue;
      const record = await QuantStrategyParamVersion.findOne({
        where: { version_key: action.version_key },
      });
      if (!record) continue;
      const metadata = asPlainObject(record.metadata);
      const history = Array.isArray(metadata.lifecycle_history)
        ? metadata.lifecycle_history.slice(-20)
        : [];
      const nextCooldownUntil =
        action.next_status === 'champion'
          ? null
          : action.cooldown_until || metadata.lifecycle_cooldown_until;
      await record.update({
        status: action.next_status,
        active_from:
          action.next_status === 'champion' ? record.active_from || today : record.active_from,
        active_to:
          action.next_status === 'rolled_back' || action.next_status === 'degraded'
            ? today
            : record.active_to,
        adoption_reason: action.reason,
        metadata: {
          ...metadata,
          lifecycle_policy: lifecycle.policy,
          lifecycle_effective_policy: action.effective_policy,
          lifecycle_cooldown_until: nextCooldownUntil,
          lifecycle_last_action: {
            at: new Date().toISOString(),
            from_status: currentStatus,
            to_status: action.next_status,
            reason: action.reason,
            cooldown_until: action.cooldown_until,
            summary: action,
          },
          lifecycle_history: [
            ...history,
            {
              at: new Date().toISOString(),
              from_status: currentStatus,
              to_status: action.next_status,
              reason: action.reason,
              rank_score: action.rank_score,
              avg_excess_return_pct: action.avg_excess_return_pct,
              recent_avg_excess_return_pct: action.recent_avg_excess_return_pct,
              cooldown_until: action.cooldown_until,
            },
          ],
        },
      } as any);
      applied++;
      updated.push({
        version_key: action.version_key,
        strategy_key: action.strategy_key,
        from_status: currentStatus,
        to_status: action.next_status,
        reason: action.reason,
      });
    }

    return {
      generated_at: new Date().toISOString(),
      dry_run: false,
      applied,
      updated,
      trade_attribution: tradeAttribution,
      lifecycle,
    };
  }

  private async upsertVersion(payload: Record<string, any>) {
    const [record, created] = await QuantStrategyParamVersion.findOrCreate({
      where: { version_key: payload.version_key },
      defaults: payload as any,
    });
    if (!created) {
      await record.update({
        ...payload,
        active_from: record.active_from || payload.active_from,
      } as any);
    }
    return record;
  }

  /**
   * Phase 1: 加载多个 strategy 的最近一次 walk-forward verdict
   *
   * 查询 OptimizationRun（optimizer_type='walk_forward', status='completed'）
   * 在过去 maxAgeDays 内 created_at 最近的一行，把它的 metadata_json.wf_summary
   * 解析成 WalkForwardVerdictInfo。
   *
   * 用于 promotion 门禁：strategy 必须有最近的 PASS 才允许 promote champion。
   *
   * @returns Map<strategy_key, WalkForwardVerdictInfo>；缺失策略不在 map 里
   */
  private async loadRecentWalkForwardVerdicts(
    strategyKeys: string[],
    maxAgeDays: number
  ): Promise<Map<string, WalkForwardVerdictInfo>> {
    const result = new Map<string, WalkForwardVerdictInfo>();
    if (!strategyKeys.length) return result;
    const uniqueKeys = Array.from(new Set(strategyKeys.filter(Boolean)));
    if (!uniqueKeys.length) return result;

    const cutoff = new Date(Date.now() - Math.max(1, maxAgeDays) * 24 * 3600 * 1000);
    try {
      // 拉所有相关 wf runs（按 strategy_name + created_at desc），group-by 取每 strategy 最近一行
      const rows = await OptimizationRun.findAll({
        where: {
          optimizer_type: 'walk_forward',
          status: 'completed',
          strategy_name: { [Op.in]: uniqueKeys },
          created_at: { [Op.gte]: cutoff },
        },
        order: [['created_at', 'DESC']],
        limit: uniqueKeys.length * 5, // 保险：每策略最多取 5 个
      });

      for (const run of rows) {
        const key = String(run.strategy_name);
        if (result.has(key)) continue; // 已有更近的就跳过
        const meta = (run.metadata_json || {}) as any;
        const summary = meta.wf_summary || null;
        const verdict = summary?.verdict;
        if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'INSUFFICIENT') {
          // 旧 run 没写 wf_summary 字段；跳过（视为缺失，下次跑会补上）
          continue;
        }
        const ageMs = Date.now() - new Date(run.created_at).getTime();
        const ageDays = ageMs / (24 * 3600 * 1000);
        result.set(key, {
          run_id: run.id,
          verdict,
          dsr: typeof summary?.dsr === 'number' ? summary.dsr : null,
          pbo: typeof summary?.pbo === 'number' ? summary.pbo : null,
          age_days: ageDays,
          scheme: summary?.scheme || null,
        });
      }
    } catch (error: any) {
      logger.warn(
        `[ParamVersionService] loadRecentWalkForwardVerdicts 失败: ${error?.message || error}`
      );
      // 失败时返回空 map，promotion 门禁会按 "缺少 wf" 拒绝（保守失败）
    }

    return result;
  }

  /**
   * Sprint 1A: 加载多个 strategy 的最近 ResearchIntegrityAudit 记录
   *
   * @returns Map<strategy_key, ResearchIntegrityVerdictInfo>；缺失策略不在 map 里
   */
  private async loadRecentResearchIntegrityVerdicts(
    strategyKeys: string[],
    maxAgeDays: number
  ): Promise<Map<string, ResearchIntegrityVerdictInfo>> {
    const result = new Map<string, ResearchIntegrityVerdictInfo>();
    if (!strategyKeys.length) return result;
    const uniqueKeys = Array.from(new Set(strategyKeys.filter(Boolean)));
    if (!uniqueKeys.length) return result;

    const cutoff = new Date(Date.now() - Math.max(1, maxAgeDays) * 24 * 3600 * 1000);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ResearchIntegrityAudit } = require('../../../models/ResearchIntegrityAudit');
      const rows = await ResearchIntegrityAudit.findAll({
        where: {
          strategy_key: { [Op.in]: uniqueKeys },
          created_at: { [Op.gte]: cutoff },
        },
        order: [['created_at', 'DESC']],
        limit: uniqueKeys.length * 5,
      });
      for (const row of rows) {
        const key = String(row.strategy_key || '');
        if (!key || result.has(key)) continue;
        const ageMs = Date.now() - new Date(row.created_at).getTime();
        result.set(key, {
          audit_id: row.id,
          verdict: row.verdict,
          dsr: row.dsr !== null && row.dsr !== undefined ? Number(row.dsr) : null,
          pbo: row.pbo !== null && row.pbo !== undefined ? Number(row.pbo) : null,
          oos_decay:
            row.oos_decay_ratio !== null && row.oos_decay_ratio !== undefined
              ? Number(row.oos_decay_ratio)
              : null,
          lookahead_count: Array.isArray(row.lookahead_issues_json)
            ? row.lookahead_issues_json.length
            : 0,
          age_days: ageMs / (24 * 3600 * 1000),
        });
      }
    } catch (error: any) {
      logger.warn(
        `[ParamVersionService] loadRecentResearchIntegrityVerdicts 失败: ${error?.message || error}`
      );
    }

    return result;
  }

  /**
   * Phase 4: 加载多个 strategy 的 edge_hypothesis JSONB 字段
   *
   * @returns Map<strategy_key, edge_hypothesis Record>；缺失策略 / 缺失字段不在 map 里
   */
  private async loadStrategyEdgeHypotheses(
    strategyKeys: string[]
  ): Promise<Map<string, Record<string, any>>> {
    const result = new Map<string, Record<string, any>>();
    if (!strategyKeys.length) return result;
    const uniqueKeys = Array.from(new Set(strategyKeys.filter(Boolean)));
    if (!uniqueKeys.length) return result;

    try {
      const rows = await QuantStrategyModel.findAll({
        where: { strategy_key: { [Op.in]: uniqueKeys } },
        attributes: ['strategy_key', 'edge_hypothesis'],
      });
      for (const row of rows) {
        const hypo = (row as any).edge_hypothesis || {};
        if (hypo && typeof hypo === 'object' && Object.keys(hypo).length) {
          result.set(String(row.strategy_key), hypo);
        }
      }
    } catch (error: any) {
      logger.warn(
        `[ParamVersionService] loadStrategyEdgeHypotheses 失败: ${error?.message || error}`
      );
      // 失败时返回空 map，promotion 门禁会按 "缺少 edge_hypothesis" 拒绝（保守失败）
    }
    return result;
  }

  /**
   * Phase 4: 把 edge_hypothesis JSONB 压缩成 UI 友好的摘要 (供 compact 字段渲染)
   */
  private summarizeEdgeHypothesis(hypo?: Record<string, any>): any {
    if (!hypo || typeof hypo !== 'object') {
      return { present: false };
    }
    const thesis = typeof hypo.thesis === 'string' ? hypo.thesis.trim() : '';
    return {
      present: thesis.length > 0,
      thesis_preview: thesis.slice(0, 80),
      category: hypo.category || null,
      expected_edge_pct: typeof hypo.expected_edge_pct === 'number' ? hypo.expected_edge_pct : null,
      kill_switch_metric: hypo.kill_switch_metric || null,
    };
  }

  private async getParamExperimentTradeAttribution() {
    try {
      const portfolios = await PaperTradingPortfolio.findAll({
        where: { name: PARAM_EXPERIMENT_PORTFOLIO_NAME },
        order: [['id', 'DESC']],
        limit: 20,
      });
      const portfolioIds = portfolios.map(item => Number(item.id)).filter(Boolean);
      if (!portfolioIds.length) {
        return {
          generated_at: new Date().toISOString(),
          portfolio_name: PARAM_EXPERIMENT_PORTFOLIO_NAME,
          portfolio_ids: [],
          by_version: [],
          summary: {
            portfolio_count: 0,
            outcome_count: 0,
            attributed_version_count: 0,
            conclusion: '参数实验盘尚未产生交易样本，生命周期暂仅依据 A/B 后验收益。',
          },
        };
      }

      const outcomes = (await RecommendationTradeOutcome.findAll({
        where: { portfolio_id: { [Op.in]: portfolioIds } },
        order: [
          ['entry_date', 'DESC'],
          ['id', 'DESC'],
        ],
        limit: 5000,
        raw: true,
      })) as any[];
      const grouped = new Map<string, any[]>();
      for (const outcome of outcomes) {
        for (const key of paramVersionKeysFromOutcome(outcome)) {
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key)!.push(outcome);
        }
      }
      const byVersion = [...grouped.entries()]
        .map(([key, rows]) => summarizeParamTradeOutcomeRows(key, rows))
        .sort(
          (a, b) =>
            toNumber(b.closed_count) - toNumber(a.closed_count) ||
            toNumber(b.avg_excess_return_pct) - toNumber(a.avg_excess_return_pct)
        );
      return {
        generated_at: new Date().toISOString(),
        portfolio_name: PARAM_EXPERIMENT_PORTFOLIO_NAME,
        portfolio_ids: portfolioIds,
        by_version: byVersion,
        summary: {
          portfolio_count: portfolioIds.length,
          outcome_count: outcomes.length,
          attributed_version_count: byVersion.length,
          conclusion: byVersion.length
            ? `参数实验盘已按 ${byVersion.length} 个参数版本沉淀交易收益，可参与生命周期护栏。`
            : '参数实验盘已有交易但暂未识别参数版本键，新信号会继续补齐归因。',
        },
      };
    } catch (error: any) {
      return {
        generated_at: new Date().toISOString(),
        portfolio_name: PARAM_EXPERIMENT_PORTFOLIO_NAME,
        portfolio_ids: [],
        by_version: [],
        error: error?.message || String(error),
        summary: {
          portfolio_count: 0,
          outcome_count: 0,
          attributed_version_count: 0,
          conclusion: '参数实验盘交易归因读取失败，生命周期暂不使用交易护栏。',
        },
      };
    }
  }

  private buildLifecyclePreview(
    rows: any[],
    defaultByStrategy: Map<string, any>,
    policyInput?: Partial<ParamVersionLifecyclePolicy>,
    environmentAttribution?: any,
    tradeAttribution?: any,
    strategyRiskByKey?: Map<string, StrategyRiskLevel>,
    // Phase 1: 每个 strategy_key 最近的 walk-forward verdict
    wfVerdicts?: Map<string, WalkForwardVerdictInfo>,
    // Phase 4: 每个 strategy_key 的 edge_hypothesis (无效或空字典即视为缺失)
    edgeHypotheses?: Map<string, Record<string, any>>,
    // Sprint 1A: 每个 strategy_key 最近的 research-integrity audit
    riVerdicts?: Map<string, ResearchIntegrityVerdictInfo>
  ) {
    const policy = mergeLifecyclePolicy(policyInput);
    const promotions: any[] = [];
    const degradations: any[] = [];
    const rollbacks: any[] = [];
    const observations: any[] = [];
    const environmentDiagnosticsByVersion = this.buildEnvironmentLifecycleDiagnostics(
      environmentAttribution,
      policy
    );
    const tradeDiagnosticsByVersion = new Map(
      ((tradeAttribution?.by_version || []) as any[]).map(item => [item.param_version_key, item])
    );

    for (const row of rows) {
      const status = String(row.status || '').toLowerCase();
      const versionType = String(row.version_type || '').toLowerCase();
      if (versionType === 'default' || status === 'baseline' || status === 'manual_override') {
        continue;
      }

      const completedCount = toNumber(row.completed_count);
      const avgExcess = toNumber(row.avg_excess_return_pct);
      const recentExcess = toNumber(row.recent_avg_excess_return_pct);
      const winRate = toNumber(row.win_rate);
      const rankScore = toNumber(row.rank_score);
      const defaultSummary = defaultByStrategy.get(row.strategy_key);
      const defaultExcess = toNumber(defaultSummary?.avg_excess_return_pct);
      const excessDelta = avgExcess - defaultExcess;
      const riskLevel = this.resolveStrategyRiskLevel(row, strategyRiskByKey);
      const effectivePolicy = this.buildRiskAdjustedLifecyclePolicy(policy, riskLevel);
      const cooldown = this.resolveLifecycleCooldown(row, effectivePolicy);
      const environmentDiagnostics = environmentDiagnosticsByVersion.get(row.version_key) || {
        positive_bucket_count: 0,
        negative_bucket_count: 0,
        qualified_bucket_count: 0,
        buckets: [],
      };
      const tradeDiagnostics = tradeDiagnosticsByVersion.get(row.version_key);
      const tradeClosedCount = toNumber((tradeDiagnostics as any)?.closed_count);
      const tradeAvgExcess = toNumber((tradeDiagnostics as any)?.avg_excess_return_pct);
      const tradeTotalPnl = toNumber((tradeDiagnostics as any)?.total_pnl);
      const tradeShouldRollback =
        Boolean(tradeDiagnostics) &&
        tradeClosedCount >= effectivePolicy.trade_rollback_min_closed_samples &&
        tradeAvgExcess <= effectivePolicy.trade_rollback_avg_excess_return_pct &&
        tradeTotalPnl <= effectivePolicy.trade_rollback_total_pnl;
      const tradeShouldDegrade =
        Boolean(tradeDiagnostics) &&
        tradeClosedCount >= effectivePolicy.trade_degrade_min_closed_samples &&
        tradeAvgExcess <= effectivePolicy.trade_degrade_avg_excess_return_pct;
      const compact = {
        version_key: row.version_key,
        strategy_key: row.strategy_key,
        strategy_name: row.strategy_name,
        version_type: row.version_type,
        status: row.status,
        risk_level: riskLevel,
        completed_count: completedCount,
        avg_excess_return_pct: row.avg_excess_return_pct,
        recent_avg_excess_return_pct: row.recent_avg_excess_return_pct,
        win_rate: row.win_rate,
        rank_score: row.rank_score,
        default_avg_excess_return_pct: defaultSummary?.avg_excess_return_pct,
        excess_delta_vs_default_pct: round(excessDelta, 4),
        effective_policy: this.compactLifecyclePolicy(effectivePolicy),
        cooldown_until: cooldown.cooldown_until,
        cooldown_active: cooldown.active,
        cooldown_reason: cooldown.reason,
        environment_diagnostics: environmentDiagnostics,
        trade_diagnostics: tradeDiagnostics,
        // Phase 1: 当前 strategy 最近的 walk-forward verdict
        wf_verdict: wfVerdicts?.get(row.strategy_key) || null,
        // Phase 4: 当前 strategy 的 edge_hypothesis 是否存在 + 摘要
        edge_hypothesis: this.summarizeEdgeHypothesis(edgeHypotheses?.get(row.strategy_key)),
      };
      const envSatisfied =
        environmentDiagnostics.positive_bucket_count >=
          effectivePolicy.min_positive_environment_buckets &&
        environmentDiagnostics.negative_bucket_count <=
          effectivePolicy.max_negative_environment_buckets;
      const envShouldDegrade =
        environmentDiagnostics.qualified_bucket_count > 0 &&
        environmentDiagnostics.negative_bucket_count >
          effectivePolicy.max_negative_environment_buckets;

      if (
        cooldown.active &&
        ['active_candidate', 'observing', 'degraded', 'rolled_back'].includes(status)
      ) {
        observations.push({
          ...compact,
          action: 'cooldown',
          next_status: row.status,
          reason: cooldown.reason,
        });
        continue;
      }

      if (tradeShouldRollback) {
        rollbacks.push({
          ...compact,
          action: 'rollback',
          next_status: 'rolled_back',
          cooldown_until: this.buildLifecycleCooldownUntil(riskLevel),
          reason: `参数实验盘触发回滚：闭环 ${tradeClosedCount} 笔，交易均超额 ${round(
            tradeAvgExcess,
            2
          )}%，累计 PnL ${round(tradeTotalPnl, 2)}，低于交易护栏。`,
        });
        continue;
      }

      // Phase 1: Walk-Forward 门禁
      // 当 wf_required=true 时，必须有最近 (wf_max_age_days 内) 的 wf verdict 满足要求
      // 默认 wf_required_verdict='PASS'，可配置为 'PASS_OR_INSUFFICIENT' 给灰度阶段使用
      const wfInfo = wfVerdicts?.get(row.strategy_key) || null;
      let wfGateSatisfied = true;
      let wfBlockReason: string | null = null;
      if (effectivePolicy.wf_required) {
        if (!wfInfo) {
          wfGateSatisfied = false;
          wfBlockReason = `缺少最近 ${effectivePolicy.wf_max_age_days} 天内的 walk-forward 验证`;
        } else if (wfInfo.age_days > effectivePolicy.wf_max_age_days) {
          wfGateSatisfied = false;
          wfBlockReason = `walk-forward 验证已过期 (${Math.floor(wfInfo.age_days)} 天 > ${
            effectivePolicy.wf_max_age_days
          } 天)`;
        } else {
          const requiredSet =
            effectivePolicy.wf_required_verdict === 'PASS_OR_INSUFFICIENT'
              ? new Set(['PASS', 'INSUFFICIENT'])
              : new Set(['PASS']);
          if (!requiredSet.has(wfInfo.verdict)) {
            wfGateSatisfied = false;
            const wfDsr = wfInfo.dsr !== null ? wfInfo.dsr.toFixed(3) : 'NaN';
            const wfPbo = wfInfo.pbo !== null ? wfInfo.pbo.toFixed(3) : 'NaN';
            wfBlockReason = `walk-forward verdict=${wfInfo.verdict} (DSR ${wfDsr}, PBO ${wfPbo})`;
          }
        }
      }

      // Phase 4: Edge Hypothesis 门禁
      // 当 edge_hypothesis_required=true 时，策略必须有完整 edge_hypothesis：
      //   1. thesis (≥10 字符，强迫团队真正写出可证伪的假设)
      //   2. category (必填，便于归类聚合)
      //   3. kill_switch_metric (必填，明确"什么时候停掉这个策略"的客观指标)
      // 防止 "数据挖掘策略" 没人能解释为什么会工作的就上线
      const edgeHypo = edgeHypotheses?.get(row.strategy_key) || null;
      let edgeGateSatisfied = true;
      let edgeBlockReason: string | null = null;
      if (effectivePolicy.edge_hypothesis_required) {
        const hypo = edgeHypo && typeof edgeHypo === 'object' ? edgeHypo : {};
        const thesis = typeof hypo.thesis === 'string' ? hypo.thesis.trim() : '';
        const category = typeof hypo.category === 'string' ? hypo.category.trim() : '';
        const killSwitch =
          typeof hypo.kill_switch_metric === 'string' ? hypo.kill_switch_metric.trim() : '';
        const missing: string[] = [];
        if (thesis.length < 10) missing.push('thesis ≥10 字');
        if (!category) missing.push('category');
        if (!killSwitch) missing.push('kill_switch_metric');
        if (missing.length > 0) {
          edgeGateSatisfied = false;
          edgeBlockReason = `edge_hypothesis 缺少: ${missing.join(', ')}`;
        }
      }

      // Sprint 1A: Research Integrity 门禁
      const riInfo = riVerdicts?.get(row.strategy_key) || null;
      let riGateSatisfied = true;
      let riBlockReason: string | null = null;
      if (effectivePolicy.ri_required) {
        if (!riInfo) {
          riGateSatisfied = false;
          riBlockReason = `缺少最近 ${effectivePolicy.ri_max_age_days} 天内的 research-integrity 审计`;
        } else if (riInfo.age_days > effectivePolicy.ri_max_age_days) {
          riGateSatisfied = false;
          riBlockReason = `research-integrity 审计已过期 (${Math.floor(riInfo.age_days)} 天 > ${
            effectivePolicy.ri_max_age_days
          } 天)`;
        } else {
          const allowedVerdicts =
            effectivePolicy.ri_required_verdict === 'PASS_OR_WARN'
              ? new Set(['PASS', 'WARN'])
              : new Set(['PASS']);
          if (!allowedVerdicts.has(riInfo.verdict)) {
            riGateSatisfied = false;
            riBlockReason = `research-integrity verdict=${riInfo.verdict} (DSR ${
              riInfo.dsr?.toFixed(3) ?? 'NaN'
            }, lookahead=${riInfo.lookahead_count})`;
          }
        }
      }

      const canPromote =
        ['active_candidate', 'observing'].includes(status) &&
        completedCount >= effectivePolicy.min_completed_samples &&
        avgExcess >= effectivePolicy.min_avg_excess_return_pct &&
        winRate >= effectivePolicy.min_win_rate &&
        rankScore >= effectivePolicy.min_rank_score &&
        excessDelta >= effectivePolicy.min_default_excess_delta_pct &&
        envSatisfied &&
        !tradeShouldDegrade &&
        wfGateSatisfied &&
        edgeGateSatisfied &&
        riGateSatisfied;
      if (canPromote) {
        const wfNote = wfInfo
          ? `walk-forward ${wfInfo.verdict} (DSR ${wfInfo.dsr?.toFixed(3) ?? 'NaN'})`
          : 'walk-forward 门禁未启用';
        const edgeNote = edgeHypo?.thesis
          ? `edge: "${String(edgeHypo.thesis).slice(0, 40)}..."`
          : 'edge 门禁未启用';
        const riNote = riInfo
          ? `RI ${riInfo.verdict} (DSR ${riInfo.dsr?.toFixed(3) ?? 'NaN'}, lookahead=${
              riInfo.lookahead_count
            })`
          : 'RI 门禁未启用';
        promotions.push({
          ...compact,
          action: 'promote',
          next_status: 'champion',
          reason: `满足冠军推广：样本 ${completedCount}，平均超额 ${round(
            avgExcess,
            2
          )}%，胜率 ${round(winRate, 1)}%，较默认参数超额 +${round(excessDelta, 2)}%，环境优势桶 ${
            environmentDiagnostics.positive_bucket_count
          } 个，策略风险级别 ${riskLevel} 已通过自适应护栏，${wfNote}，${edgeNote}，${riNote}。`,
        });
        continue;
      }

      // Phase 1+4+Sprint 1A: 如果只是 wf / edge / ri 门禁挡住，把它降级为 observe 而不是 silently 跳过
      const onlyWfOrEdgeBlocking =
        ['active_candidate', 'observing'].includes(status) &&
        completedCount >= effectivePolicy.min_completed_samples &&
        avgExcess >= effectivePolicy.min_avg_excess_return_pct &&
        winRate >= effectivePolicy.min_win_rate &&
        rankScore >= effectivePolicy.min_rank_score &&
        excessDelta >= effectivePolicy.min_default_excess_delta_pct &&
        envSatisfied &&
        !tradeShouldDegrade &&
        (!wfGateSatisfied || !edgeGateSatisfied || !riGateSatisfied);
      if (onlyWfOrEdgeBlocking) {
        const blockers: string[] = [];
        if (wfBlockReason) blockers.push(wfBlockReason);
        if (edgeBlockReason) blockers.push(edgeBlockReason);
        if (riBlockReason) blockers.push(riBlockReason);
        observations.push({
          ...compact,
          action: 'observe',
          next_status: row.status,
          reason: `所有业务指标已达标，但：${blockers.join('；')}。请先解决上述门禁。`,
        });
        continue;
      }

      if (
        ['active_candidate', 'observing'].includes(status) &&
        completedCount >= effectivePolicy.min_completed_samples &&
        avgExcess >= effectivePolicy.min_avg_excess_return_pct &&
        winRate >= effectivePolicy.min_win_rate &&
        rankScore >= effectivePolicy.min_rank_score &&
        excessDelta >= effectivePolicy.min_default_excess_delta_pct &&
        !envSatisfied
      ) {
        observations.push({
          ...compact,
          action: 'observe',
          next_status: row.status,
          reason: `全局指标达标但环境分桶未达推广护栏：优势桶 ${environmentDiagnostics.positive_bucket_count}/${effectivePolicy.min_positive_environment_buckets}，弱势桶 ${environmentDiagnostics.negative_bucket_count}/${effectivePolicy.max_negative_environment_buckets}，继续小仓观察。`,
        });
        continue;
      }

      const shouldRollback =
        ['champion', 'active_candidate', 'degraded'].includes(status) &&
        completedCount >= effectivePolicy.rollback_min_completed_samples &&
        recentExcess <= effectivePolicy.rollback_recent_excess_return_pct &&
        avgExcess <= effectivePolicy.rollback_avg_excess_return_pct;
      if (shouldRollback) {
        rollbacks.push({
          ...compact,
          action: 'rollback',
          next_status: 'rolled_back',
          cooldown_until: this.buildLifecycleCooldownUntil(riskLevel),
          reason: `触发回滚：近期平均超额 ${round(recentExcess, 2)}%，整体超额 ${round(
            avgExcess,
            2
          )}%，低于安全阈值，回退默认参数。`,
        });
        continue;
      }

      const shouldDegrade =
        ['champion', 'active_candidate'].includes(status) &&
        completedCount >= effectivePolicy.degrade_min_completed_samples &&
        (avgExcess <= effectivePolicy.degrade_avg_excess_return_pct ||
          winRate <= effectivePolicy.degrade_win_rate ||
          recentExcess <= effectivePolicy.degrade_recent_excess_return_pct ||
          (completedCount >= effectivePolicy.min_completed_samples && envShouldDegrade) ||
          tradeShouldDegrade);
      if (shouldDegrade) {
        const degradeReason = tradeShouldDegrade
          ? `参数实验盘降级：闭环 ${tradeClosedCount} 笔，交易均超额 ${round(
              tradeAvgExcess,
              2
            )}%，暂缓放大。`
          : envShouldDegrade && completedCount >= effectivePolicy.min_completed_samples
          ? `环境分桶降级：优势桶 ${environmentDiagnostics.positive_bucket_count}，弱势桶 ${environmentDiagnostics.negative_bucket_count}，跨行情稳定性不足。`
          : `降级观察：平均超额 ${round(avgExcess, 2)}%，近期超额 ${round(
              recentExcess,
              2
            )}%，胜率 ${round(winRate, 1)}%，未满足继续放大条件。`;
        degradations.push({
          ...compact,
          action: 'degrade',
          next_status: 'degraded',
          cooldown_until: this.buildLifecycleCooldownUntil(riskLevel, 'degraded'),
          reason: degradeReason,
        });
        continue;
      }

      observations.push({
        ...compact,
        action: 'observe',
        next_status: row.status,
        reason:
          completedCount < effectivePolicy.min_completed_samples
            ? `样本 ${completedCount}/${effectivePolicy.min_completed_samples}，继续观察。`
            : `暂不调整：收益、胜率或相对默认优势尚未触发推广/降级规则。`,
      });
    }

    const sortByImpact = (a: any, b: any) =>
      toNumber(b.rank_score) - toNumber(a.rank_score) ||
      toNumber(b.avg_excess_return_pct) - toNumber(a.avg_excess_return_pct);

    return {
      policy,
      environment_guard: {
        version_count: environmentDiagnosticsByVersion.size,
        min_positive_environment_buckets: policy.min_positive_environment_buckets,
        max_negative_environment_buckets: policy.max_negative_environment_buckets,
        min_environment_bucket_completed_samples: policy.min_environment_bucket_completed_samples,
        min_environment_bucket_excess_return_pct: policy.min_environment_bucket_excess_return_pct,
        risk_adjusted: true,
      },
      trade_guard: {
        version_count: tradeDiagnosticsByVersion.size,
        degrade_min_closed_samples: policy.trade_degrade_min_closed_samples,
        degrade_avg_excess_return_pct: policy.trade_degrade_avg_excess_return_pct,
        rollback_min_closed_samples: policy.trade_rollback_min_closed_samples,
        rollback_avg_excess_return_pct: policy.trade_rollback_avg_excess_return_pct,
        rollback_total_pnl: policy.trade_rollback_total_pnl,
        risk_adjusted: true,
      },
      risk_adjusted_policy: {
        enabled: true,
        low: this.compactLifecyclePolicy(this.buildRiskAdjustedLifecyclePolicy(policy, 'low')),
        medium: this.compactLifecyclePolicy(
          this.buildRiskAdjustedLifecyclePolicy(policy, 'medium')
        ),
        high: this.compactLifecyclePolicy(this.buildRiskAdjustedLifecyclePolicy(policy, 'high')),
      },
      promotions: promotions.sort(sortByImpact),
      degradations: degradations.sort(sortByImpact),
      rollbacks: rollbacks.sort(sortByImpact),
      observations: observations.sort(sortByImpact).slice(0, 20),
      summary: {
        promotion_count: promotions.length,
        degradation_count: degradations.length,
        rollback_count: rollbacks.length,
        observation_count: observations.length,
        conclusion:
          promotions.length > 0
            ? `发现 ${promotions.length} 个可推广冠军参数，建议小仓放大并继续观察。`
            : rollbacks.length > 0
            ? `发现 ${rollbacks.length} 个需回滚参数，避免继续扩大亏损。`
            : degradations.length > 0
            ? `发现 ${degradations.length} 个需降级观察参数，暂缓放大。`
            : '暂无需要推广或回滚的参数版本，继续积累 A/B 样本。',
      },
    };
  }

  private buildEnvironmentLifecycleDiagnostics(
    environmentAttribution: any,
    policy: ParamVersionLifecyclePolicy
  ) {
    const diagnostics = new Map<
      string,
      {
        positive_bucket_count: number;
        negative_bucket_count: number;
        qualified_bucket_count: number;
        buckets: any[];
      }
    >();
    const buckets = [
      ...(((environmentAttribution || {}).by_market_regime || []) as any[]),
      ...(((environmentAttribution || {}).by_industry_regime || []) as any[]),
    ];
    for (const bucket of buckets) {
      const version = bucket.best_version;
      const versionKey = String(version?.version_key || '').trim();
      if (!versionKey) continue;
      if (!diagnostics.has(versionKey)) {
        diagnostics.set(versionKey, {
          positive_bucket_count: 0,
          negative_bucket_count: 0,
          qualified_bucket_count: 0,
          buckets: [],
        });
      }
      const target = diagnostics.get(versionKey)!;
      const completedCount = toNumber(bucket.completed_count);
      const avgExcess = toNumber(bucket.avg_excess_return_pct);
      const isQualifiedBucket = completedCount >= policy.min_environment_bucket_completed_samples;
      if (isQualifiedBucket) {
        target.qualified_bucket_count++;
      }
      const bucketSummary = {
        key: bucket.key,
        label: bucket.label,
        segment_type: bucket.segment_type,
        completed_count: completedCount,
        avg_excess_return_pct: bucket.avg_excess_return_pct,
        rank_score: bucket.rank_score,
      };
      if (isQualifiedBucket && avgExcess >= policy.min_environment_bucket_excess_return_pct) {
        target.positive_bucket_count++;
      }
      if (isQualifiedBucket && avgExcess < policy.min_environment_bucket_excess_return_pct) {
        target.negative_bucket_count++;
      }
      target.buckets.push(bucketSummary);
    }
    for (const value of diagnostics.values()) {
      value.buckets = value.buckets
        .sort(
          (a, b) =>
            toNumber(b.completed_count) - toNumber(a.completed_count) ||
            toNumber(b.rank_score) - toNumber(a.rank_score)
        )
        .slice(0, 8);
    }
    return diagnostics;
  }

  private resolveStrategyRiskLevel(
    row: any,
    strategyRiskByKey?: Map<string, StrategyRiskLevel>
  ): StrategyRiskLevel {
    const metadata = asPlainObject(row?.metadata);
    return normalizeRiskLevel(
      row?.risk_level ||
        metadata.risk_level ||
        strategyRiskByKey?.get(String(row?.strategy_key || '')) ||
        'medium'
    );
  }

  private buildRiskAdjustedLifecyclePolicy(
    basePolicy: ParamVersionLifecyclePolicy,
    riskLevel: StrategyRiskLevel
  ): ParamVersionLifecyclePolicy {
    if (riskLevel === 'high') {
      return {
        ...basePolicy,
        min_completed_samples: Math.max(basePolicy.min_completed_samples, 18),
        min_avg_excess_return_pct: Math.max(basePolicy.min_avg_excess_return_pct, 0.65),
        min_win_rate: Math.max(basePolicy.min_win_rate, 55),
        min_rank_score: Math.max(basePolicy.min_rank_score, 5.5),
        min_default_excess_delta_pct: Math.max(basePolicy.min_default_excess_delta_pct, 0.45),
        min_positive_environment_buckets: Math.max(basePolicy.min_positive_environment_buckets, 2),
        max_negative_environment_buckets: Math.min(basePolicy.max_negative_environment_buckets, 0),
        min_environment_bucket_completed_samples: Math.max(
          basePolicy.min_environment_bucket_completed_samples,
          4
        ),
        trade_degrade_min_closed_samples: Math.max(basePolicy.trade_degrade_min_closed_samples, 2),
        trade_rollback_min_closed_samples: Math.max(
          basePolicy.trade_rollback_min_closed_samples,
          2
        ),
        trade_rollback_total_pnl: Math.min(basePolicy.trade_rollback_total_pnl, -800),
      };
    }

    if (riskLevel === 'low') {
      return {
        ...basePolicy,
        min_completed_samples: Math.max(8, Math.min(basePolicy.min_completed_samples, 10)),
        min_avg_excess_return_pct: Math.min(basePolicy.min_avg_excess_return_pct, 0.25),
        min_win_rate: Math.min(basePolicy.min_win_rate, 50),
        min_rank_score: Math.min(basePolicy.min_rank_score, 3.5),
        min_default_excess_delta_pct: Math.min(basePolicy.min_default_excess_delta_pct, 0.15),
        min_environment_bucket_completed_samples: Math.max(
          2,
          Math.min(basePolicy.min_environment_bucket_completed_samples, 3)
        ),
        trade_degrade_min_closed_samples: Math.max(basePolicy.trade_degrade_min_closed_samples, 3),
        trade_rollback_min_closed_samples: Math.max(
          basePolicy.trade_rollback_min_closed_samples,
          4
        ),
      };
    }

    return basePolicy;
  }

  private compactLifecyclePolicy(policy: ParamVersionLifecyclePolicy) {
    return {
      min_completed_samples: policy.min_completed_samples,
      min_avg_excess_return_pct: policy.min_avg_excess_return_pct,
      min_win_rate: policy.min_win_rate,
      min_rank_score: policy.min_rank_score,
      min_default_excess_delta_pct: policy.min_default_excess_delta_pct,
      min_positive_environment_buckets: policy.min_positive_environment_buckets,
      max_negative_environment_buckets: policy.max_negative_environment_buckets,
      min_environment_bucket_completed_samples: policy.min_environment_bucket_completed_samples,
      trade_degrade_min_closed_samples: policy.trade_degrade_min_closed_samples,
      trade_rollback_min_closed_samples: policy.trade_rollback_min_closed_samples,
      trade_rollback_total_pnl: policy.trade_rollback_total_pnl,
      // Phase 1: walk-forward 门禁配置
      wf_required: policy.wf_required,
      wf_max_age_days: policy.wf_max_age_days,
      wf_required_verdict: policy.wf_required_verdict,
      // Phase 4: edge_hypothesis 门禁配置
      edge_hypothesis_required: policy.edge_hypothesis_required,
      // Sprint 1A: research-integrity 门禁配置
      ri_required: policy.ri_required,
      ri_max_age_days: policy.ri_max_age_days,
      ri_required_verdict: policy.ri_required_verdict,
    };
  }

  private buildLifecycleCooldownUntil(
    riskLevel: StrategyRiskLevel,
    action: 'rolled_back' | 'degraded' = 'rolled_back'
  ) {
    const days =
      action === 'degraded'
        ? riskLevel === 'high'
          ? 10
          : riskLevel === 'low'
          ? 3
          : 5
        : riskLevel === 'high'
        ? 30
        : riskLevel === 'low'
        ? 10
        : 20;
    return moment().tz('Asia/Shanghai').add(days, 'days').format('YYYY-MM-DD');
  }

  private resolveLifecycleCooldown(row: any, policy: ParamVersionLifecyclePolicy) {
    const metadata = asPlainObject(row?.metadata);
    const cooldownUntil = String(metadata.lifecycle_cooldown_until || row?.cooldown_until || '');
    const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    const isRolledBack = String(row?.status || '').toLowerCase() === 'rolled_back';
    const active = Boolean(cooldownUntil && cooldownUntil >= today);
    if (active) {
      return {
        active: true,
        cooldown_until: cooldownUntil,
        reason: `参数版本处于冷却期至 ${cooldownUntil}，暂不重新参与开盘扫描候选。`,
      };
    }
    if (isRolledBack && !active) {
      const completedCount = toNumber(row?.completed_count);
      if (completedCount < policy.min_completed_samples) {
        return {
          active: true,
          cooldown_until: cooldownUntil || null,
          reason: `参数版本已回滚且新增有效样本 ${completedCount}/${policy.min_completed_samples} 不足，继续排除。`,
        };
      }
    }
    return { active: false, cooldown_until: cooldownUntil || null, reason: '' };
  }

  private versionPriority(version: QuantStrategyParamVersion) {
    const status = String(version.status || '').toLowerCase();
    const type = String(version.version_type || '').toLowerCase();
    if (this.shouldExcludeFromScan(version)) return -10;
    if (status === 'manual_override' || type === 'manual') return 40;
    if (status === 'champion') return 35;
    if (status === 'active_candidate') return 30;
    if (status === 'observing') return 20;
    if (status === 'baseline') return 10;
    return 0;
  }

  private async getScanExcludedVersions(strategyKeys: string[]) {
    if (!strategyKeys.length) return [];
    return QuantStrategyParamVersion.findAll({
      where: {
        strategy_key: { [Op.in]: strategyKeys },
        status: { [Op.in]: ['rolled_back', 'degraded'] },
      },
      order: [
        ['strategy_key', 'ASC'],
        ['updated_at', 'DESC'],
      ],
    }).catch(() => [] as QuantStrategyParamVersion[]);
  }

  private shouldExcludeFromScan(version: QuantStrategyParamVersion) {
    const status = String(version.status || '').toLowerCase();
    const metadata = asPlainObject(version.metadata);
    const cooldownUntil = String(metadata.lifecycle_cooldown_until || '').slice(0, 10);
    const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    if (cooldownUntil && cooldownUntil >= today) return true;
    return status === 'rolled_back';
  }

  private selectBestScanVersion(versions: QuantStrategyParamVersion[]) {
    return [...versions].sort((a, b) => {
      const priorityDelta = this.versionPriority(b) - this.versionPriority(a);
      if (priorityDelta !== 0) return priorityDelta;
      const rankDelta = toNumber(b.source_rank_score) - toNumber(a.source_rank_score);
      if (rankDelta !== 0) return rankDelta;
      const excessDelta =
        toNumber(b.source_excess_return_pct) - toNumber(a.source_excess_return_pct);
      if (excessDelta !== 0) return excessDelta;
      return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
    })[0];
  }

  private buildScanSelectionDiagnostic(
    definition: any,
    selected: QuantStrategyParamVersion,
    candidates: QuantStrategyParamVersion[],
    excluded: QuantStrategyParamVersion[] = []
  ) {
    const ranked = [...candidates].sort((a, b) => {
      const priorityDelta = this.versionPriority(b) - this.versionPriority(a);
      if (priorityDelta !== 0) return priorityDelta;
      const rankDelta = toNumber(b.source_rank_score) - toNumber(a.source_rank_score);
      if (rankDelta !== 0) return rankDelta;
      return (
        toNumber(b.source_excess_return_pct) - toNumber(a.source_excess_return_pct) ||
        new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
      );
    });
    const selectedKey = selected?.version_key;
    return {
      strategy_key: definition.strategy_key,
      strategy_name: definition.name,
      selected_version_key: selectedKey,
      selected_reason: selected?.adoption_reason || '按参数版本优先级自动选择。',
      candidate_count: candidates.length,
      excluded_count: excluded.length,
      candidates: ranked.slice(0, 5).map((item, index) => ({
        rank: index + 1,
        version_key: item.version_key,
        version_type: item.version_type,
        status: item.status,
        priority: this.versionPriority(item),
        source_rank_score: toNumber(item.source_rank_score, 0),
        source_excess_return_pct: toNumber(item.source_excess_return_pct, 0),
        source_trade_count: toNumber(item.source_trade_count, 0),
        selected: item.version_key === selectedKey,
        reason:
          item.version_key === selectedKey
            ? '当前采用'
            : this.explainWhyNotSelected(item, selected),
      })),
      excluded_versions: excluded.slice(0, 5).map((item, index) => ({
        rank: index + 1,
        version_key: item.version_key,
        version_type: item.version_type,
        status: item.status,
        cooldown_until: asPlainObject(item.metadata).lifecycle_cooldown_until || null,
        reason: this.explainScanExclusion(item),
      })),
    };
  }

  private explainScanExclusion(candidate: QuantStrategyParamVersion) {
    const metadata = asPlainObject(candidate.metadata);
    const cooldownUntil = String(metadata.lifecycle_cooldown_until || '').slice(0, 10);
    const status = String(candidate.status || '').toLowerCase();
    const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    if (cooldownUntil && cooldownUntil >= today) {
      return `处于冷却期至 ${cooldownUntil}，本轮开盘扫描排除。`;
    }
    if (status === 'rolled_back') return '参数已回滚，等待重新验证后才可恢复。';
    if (status === 'degraded') return '参数处于降级观察且冷却期未结束，暂不参与生产扫描。';
    return '未进入生产扫描候选状态。';
  }

  private explainWhyNotSelected(
    candidate: QuantStrategyParamVersion,
    selected: QuantStrategyParamVersion
  ) {
    if (!selected) return '无已选版本。';
    const candidatePriority = this.versionPriority(candidate);
    const selectedPriority = this.versionPriority(selected);
    if (candidatePriority < selectedPriority) {
      return `优先级低于已选版本（${candidate.status}/${candidate.version_type} < ${selected.status}/${selected.version_type}）。`;
    }
    if (candidatePriority > selectedPriority)
      return '优先级更高但未被排序选中，请检查状态或更新时间。';
    if (toNumber(candidate.source_rank_score) < toNumber(selected.source_rank_score)) {
      return `rank_score 较低（${toNumber(candidate.source_rank_score, 0)} < ${toNumber(
        selected.source_rank_score,
        0
      )}）。`;
    }
    if (
      toNumber(candidate.source_excess_return_pct) < toNumber(selected.source_excess_return_pct)
    ) {
      return `超额收益较低（${toNumber(candidate.source_excess_return_pct, 0)} < ${toNumber(
        selected.source_excess_return_pct,
        0
      )}）。`;
    }
    return '同优先级下更新时间更早或综合排序略低。';
  }
}

export const quantStrategyParamVersionService = new QuantStrategyParamVersionService();
