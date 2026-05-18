import { Op } from 'sequelize';
import { createHash } from 'crypto';
import moment from 'moment-timezone';
import { DailyBar } from '../../models/DailyBar';
import { QuantSignal } from '../../models/QuantSignal';
import { QuantStrategyParamValidation } from '../../models/QuantStrategyParamValidation';
import { QuantStrategyParamVersion } from '../../models/QuantStrategyParamVersion';
import { RecommendationTradeOutcome } from '../../models/RecommendationTradeOutcome';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { Stock } from '../../models/Stock';
import { benchmarkIndexService } from '../../services/BenchmarkIndexService';
import { PARAM_EXPERIMENT_PORTFOLIO_NAME } from '../../services/PaperTradingDashboardService';
import { normalizeSymbol } from '../../utils/stockSymbol';
import { logger } from '../../utils/logger';
import { round } from '../engine/QuantMath';
import { strategyRegistry } from '../engine/StrategyRegistry';
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
    const lifecyclePreview = this.buildLifecyclePreview(summaryByVersion, defaultByStrategy);
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

    return {
      generated_at: new Date().toISOString(),
      versions: plainVersions,
      validations: plainValidations,
      summary_by_version: summaryByVersion,
      summary_by_strategy: summaryByStrategy,
      champion,
      lifecycle: lifecyclePreview,
      environment_attribution: environmentAttribution,
      summary: {
        version_count: plainVersions.length,
        active_candidate_count: activeCandidateCount,
        champion_count: championCount,
        degraded_count: degradedCount,
        rolled_back_count: rolledBackCount,
        validation_count: plainValidations.length,
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
    const lifecycle = this.buildLifecyclePreview(
      rows,
      defaultByStrategy,
      options.policy,
      dashboard.environment_attribution,
      tradeAttribution
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
          lifecycle_last_action: {
            at: new Date().toISOString(),
            from_status: currentStatus,
            to_status: action.next_status,
            reason: action.reason,
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
    tradeAttribution?: any
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
        tradeClosedCount >= policy.trade_rollback_min_closed_samples &&
        tradeAvgExcess <= policy.trade_rollback_avg_excess_return_pct &&
        tradeTotalPnl <= policy.trade_rollback_total_pnl;
      const tradeShouldDegrade =
        Boolean(tradeDiagnostics) &&
        tradeClosedCount >= policy.trade_degrade_min_closed_samples &&
        tradeAvgExcess <= policy.trade_degrade_avg_excess_return_pct;
      const compact = {
        version_key: row.version_key,
        strategy_key: row.strategy_key,
        strategy_name: row.strategy_name,
        version_type: row.version_type,
        status: row.status,
        completed_count: completedCount,
        avg_excess_return_pct: row.avg_excess_return_pct,
        recent_avg_excess_return_pct: row.recent_avg_excess_return_pct,
        win_rate: row.win_rate,
        rank_score: row.rank_score,
        default_avg_excess_return_pct: defaultSummary?.avg_excess_return_pct,
        excess_delta_vs_default_pct: round(excessDelta, 4),
        environment_diagnostics: environmentDiagnostics,
        trade_diagnostics: tradeDiagnostics,
      };
      const envSatisfied =
        environmentDiagnostics.positive_bucket_count >= policy.min_positive_environment_buckets &&
        environmentDiagnostics.negative_bucket_count <= policy.max_negative_environment_buckets;
      const envShouldDegrade =
        environmentDiagnostics.qualified_bucket_count > 0 &&
        environmentDiagnostics.negative_bucket_count > policy.max_negative_environment_buckets;

      if (tradeShouldRollback) {
        rollbacks.push({
          ...compact,
          action: 'rollback',
          next_status: 'rolled_back',
          reason: `参数实验盘触发回滚：闭环 ${tradeClosedCount} 笔，交易均超额 ${round(
            tradeAvgExcess,
            2
          )}%，累计 PnL ${round(tradeTotalPnl, 2)}，低于交易护栏。`,
        });
        continue;
      }

      const canPromote =
        ['active_candidate', 'observing'].includes(status) &&
        completedCount >= policy.min_completed_samples &&
        avgExcess >= policy.min_avg_excess_return_pct &&
        winRate >= policy.min_win_rate &&
        rankScore >= policy.min_rank_score &&
        excessDelta >= policy.min_default_excess_delta_pct &&
        envSatisfied &&
        !tradeShouldDegrade;
      if (canPromote) {
        promotions.push({
          ...compact,
          action: 'promote',
          next_status: 'champion',
          reason: `满足冠军推广：样本 ${completedCount}，平均超额 ${round(
            avgExcess,
            2
          )}%，胜率 ${round(winRate, 1)}%，较默认参数超额 +${round(
            excessDelta,
            2
          )}%，环境优势桶 ${environmentDiagnostics.positive_bucket_count} 个。`,
        });
        continue;
      }

      if (
        ['active_candidate', 'observing'].includes(status) &&
        completedCount >= policy.min_completed_samples &&
        avgExcess >= policy.min_avg_excess_return_pct &&
        winRate >= policy.min_win_rate &&
        rankScore >= policy.min_rank_score &&
        excessDelta >= policy.min_default_excess_delta_pct &&
        !envSatisfied
      ) {
        observations.push({
          ...compact,
          action: 'observe',
          next_status: row.status,
          reason: `全局指标达标但环境分桶未达推广护栏：优势桶 ${environmentDiagnostics.positive_bucket_count}/${policy.min_positive_environment_buckets}，弱势桶 ${environmentDiagnostics.negative_bucket_count}/${policy.max_negative_environment_buckets}，继续小仓观察。`,
        });
        continue;
      }

      const shouldRollback =
        ['champion', 'active_candidate', 'degraded'].includes(status) &&
        completedCount >= policy.rollback_min_completed_samples &&
        recentExcess <= policy.rollback_recent_excess_return_pct &&
        avgExcess <= policy.rollback_avg_excess_return_pct;
      if (shouldRollback) {
        rollbacks.push({
          ...compact,
          action: 'rollback',
          next_status: 'rolled_back',
          reason: `触发回滚：近期平均超额 ${round(recentExcess, 2)}%，整体超额 ${round(
            avgExcess,
            2
          )}%，低于安全阈值，回退默认参数。`,
        });
        continue;
      }

      const shouldDegrade =
        ['champion', 'active_candidate'].includes(status) &&
        completedCount >= policy.degrade_min_completed_samples &&
        (avgExcess <= policy.degrade_avg_excess_return_pct ||
          winRate <= policy.degrade_win_rate ||
          recentExcess <= policy.degrade_recent_excess_return_pct ||
          (completedCount >= policy.min_completed_samples && envShouldDegrade) ||
          tradeShouldDegrade);
      if (shouldDegrade) {
        const degradeReason = tradeShouldDegrade
          ? `参数实验盘降级：闭环 ${tradeClosedCount} 笔，交易均超额 ${round(
              tradeAvgExcess,
              2
            )}%，暂缓放大。`
          : envShouldDegrade && completedCount >= policy.min_completed_samples
            ? `环境分桶降级：优势桶 ${environmentDiagnostics.positive_bucket_count}，弱势桶 ${environmentDiagnostics.negative_bucket_count}，跨行情稳定性不足。`
            : `降级观察：平均超额 ${round(avgExcess, 2)}%，近期超额 ${round(
                recentExcess,
                2
              )}%，胜率 ${round(winRate, 1)}%，未满足继续放大条件。`;
        degradations.push({
          ...compact,
          action: 'degrade',
          next_status: 'degraded',
          reason: degradeReason,
        });
        continue;
      }

      observations.push({
        ...compact,
        action: 'observe',
        next_status: row.status,
        reason:
          completedCount < policy.min_completed_samples
            ? `样本 ${completedCount}/${policy.min_completed_samples}，继续观察。`
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
      },
      trade_guard: {
        version_count: tradeDiagnosticsByVersion.size,
        degrade_min_closed_samples: policy.trade_degrade_min_closed_samples,
        degrade_avg_excess_return_pct: policy.trade_degrade_avg_excess_return_pct,
        rollback_min_closed_samples: policy.trade_rollback_min_closed_samples,
        rollback_avg_excess_return_pct: policy.trade_rollback_avg_excess_return_pct,
        rollback_total_pnl: policy.trade_rollback_total_pnl,
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

  private versionPriority(version: QuantStrategyParamVersion) {
    const status = String(version.status || '').toLowerCase();
    const type = String(version.version_type || '').toLowerCase();
    if (status === 'manual_override' || type === 'manual') return 40;
    if (status === 'champion') return 35;
    if (status === 'active_candidate') return 30;
    if (status === 'observing') return 20;
    if (status === 'baseline') return 10;
    return 0;
  }
}

export const quantStrategyParamVersionService = new QuantStrategyParamVersionService();
