import { Op } from 'sequelize';
import moment from 'moment-timezone';
import {
  AIInvestmentSignal,
  AISignalDecision,
  AISignalSourceType,
} from '../models/AIInvestmentSignal';
import { DailyScreener } from '../models/DailyScreener';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { normalizeSymbol } from '../utils/stockSymbol';
import { logger } from '../utils/logger';
import { DataSyncService } from '../data/services/DataSyncService';
import { benchmarkIndexService } from './BenchmarkIndexService';
import type { QuantRecommendationItem } from './QuantRecommendationService';
import { marketEnvironmentService } from './MarketEnvironmentService';

const DEFAULT_HORIZONS = [1, 3, 5, 10, 20];
const DEFAULT_PERFORMANCE_HORIZON = '5d';

export interface SignalQueryOptions {
  symbol?: string;
  decision?: string;
  source_type?: string;
  agent_session?: string;
  task_label?: string;
  loop_run_id?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  offset?: number;
}

export interface SignalPerformanceOptions extends SignalQueryOptions {
  horizon?: string;
  limit?: number;
  min_samples?: number;
}

export interface AgentTailAlphaLedgerOptions extends SignalPerformanceOptions {
  lookback_days?: number;
  horizons?: string[] | string;
}

export interface SignalQualityReportOptions extends SignalPerformanceOptions {
  lookback_days?: number;
  report_to_feishu?: boolean;
  record_type?: string;
  verify_before_report?: boolean;
  auto_repair_missing_data?: boolean;
  data_source?: string;
  repair_lookback_days?: number;
  sync_concurrency?: number;
  include_diagnosis_details?: boolean;
  diagnosis_detail_limit?: number;
}

export interface SignalVerificationDiagnosisOptions extends SignalQueryOptions {
  horizons?: number[];
  limit?: number;
  auto_sync_missing?: boolean;
  data_source?: string;
  lookback_days?: number;
  sync_concurrency?: number;
  include_details?: boolean;
  detail_limit?: number;
}

export interface QuantRecommendationArchiveOptions {
  candidates: QuantRecommendationItem[];
  universe?: string;
  style?: string;
  as_of?: string;
  signal_date?: string;
  loop_run_id?: string;
  loop_policy_snapshot_id?: number;
  strategy_key?: string;
  strategy_variant?: Record<string, any>;
  environment_policy?: Record<string, any>;
  environment_policy_snapshot_id?: string;
}

export interface TradingAgentsStructuredDecision {
  rating: string;
  normalized_decision: string;
  summary?: string;
  thesis?: string;
  raw_confidence_score?: number;
  confidence_score?: number;
  risk_level?: string;
  action_tags: string[];
  data_quality: AgentDataQualityAssessment;
  key_levels: {
    stop_loss?: number;
    take_profit?: number;
    entry?: number;
  };
}

export interface AgentDataQualityAssessment {
  score: number;
  bucket: 'high' | 'medium' | 'low' | 'critical';
  confidence_multiplier: number;
  auto_trade_allowed: boolean;
  recommendation:
    | 'allow_auto_trade'
    | 'allow_small_sample'
    | 'manual_review_required'
    | 'block_auto_trade';
  missing_sections: string[];
  warning_count: number;
  warnings: string[];
  coverage: {
    market_data: 'ok' | 'partial' | 'missing';
    technical_indicators: 'ok' | 'partial' | 'missing';
    fundamentals: 'ok' | 'partial' | 'missing';
    financial_statements: 'ok' | 'partial' | 'missing';
    news: 'ok' | 'partial' | 'missing';
    realtime_quote: 'ok' | 'partial' | 'missing';
  };
}

function toNumber(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function stripMarkdown(value: string): string {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/#+\s*/g, '')
    .replace(/\r/g, '')
    .trim();
}

function firstNumber(match?: RegExpMatchArray | null): number | undefined {
  if (!match?.[1]) return undefined;
  const num = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(num) ? num : undefined;
}

function getChinaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function resolveSignalDate(
  options: Pick<QuantRecommendationArchiveOptions, 'as_of' | 'signal_date'> = {}
): string {
  if (options.signal_date) return String(options.signal_date).slice(0, 10);
  if (options.as_of) {
    const datePart = String(options.as_of).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  }
  return getChinaToday();
}

export function inferAgentSession(
  taskLabel?: string,
  fallbackTime?: Date | string
): string | undefined {
  const label = String(taskLabel || '').toLowerCase();
  if (/尾盘|收盘|close|closing|eod|end[-_\s]?of[-_\s]?day/.test(label)) return 'close';
  if (/午盘|midday|noon/.test(label)) return 'midday';
  if (/早盘|morning|open|opening/.test(label)) return 'morning';

  if (fallbackTime) {
    const hour = moment(fallbackTime).tz('Asia/Shanghai').hour();
    if (hour >= 14 && hour <= 16) return 'close';
    if (hour >= 11 && hour <= 13) return 'midday';
    if (hour >= 8 && hour <= 10) return 'morning';
  }

  return undefined;
}

function buildSignalWhere(options: SignalQueryOptions = {}) {
  const where: any = {};
  if (options.symbol) where.symbol = normalizeSymbol(options.symbol);
  if (options.decision) where.normalized_decision = options.decision;
  if (options.source_type) where.source_type = options.source_type;
  if (options.loop_run_id) where.loop_run_id = options.loop_run_id;
  const metadataFilters: Record<string, any> = {};
  if (options.agent_session) metadataFilters.agent_session = options.agent_session;
  if (options.task_label) metadataFilters.task_label = options.task_label;
  if (Object.keys(metadataFilters).length > 0) {
    where.metadata = { [Op.contains]: metadataFilters };
  }
  if (options.start_date || options.end_date) {
    where.signal_date = {};
    if (options.start_date) where.signal_date[Op.gte] = options.start_date;
    if (options.end_date) where.signal_date[Op.lte] = options.end_date;
  }
  return where;
}

function mergeMetadata(metadata: any, patch: Record<string, any>) {
  return {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined && value !== null)
    ),
  };
}

function roundNumber(value: any, digits = 4): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function averageNumbers(values: number[]): number | null {
  const valid = values.filter(value => Number.isFinite(value));
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function medianNumber(values: number[]): number | null {
  const valid = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 0 ? (valid[mid - 1] + valid[mid]) / 2 : valid[mid];
}

function dateOnly(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().split('T')[0];
}

function subtractCalendarDays(date: string, days: number): string {
  return moment(date).subtract(days, 'days').format('YYYY-MM-DD');
}

function isVerificationMature(signalDate: string, maxHorizon: number): boolean {
  const elapsedCalendarDays = moment(getChinaToday()).diff(moment(signalDate), 'days');
  // A股交易日大致占自然日 5/7。给停牌/节假日留缓冲，避免刚生成的信号被误判为 no_data。
  const matureCalendarDays = Math.ceil(maxHorizon * 1.8) + 3;
  return elapsedCalendarDays >= matureCalendarDays;
}

function buildPendingForwardReturns(
  signal: AIInvestmentSignal,
  horizons: number[],
  reason: string
) {
  const signalSide = getSignalSide(signal.normalized_decision || signal.decision);
  return {
    decision_side: signalSide,
    reason,
    horizons: Object.fromEntries(
      horizons.map(horizon => [
        `${horizon}d`,
        {
          status: 'pending',
          horizon,
          reason,
        },
      ])
    ),
  };
}

function getSignalSide(decision?: string): 'long' | 'short' | 'neutral' {
  const normalized = String(decision || '').toLowerCase();
  if (
    normalized === AISignalDecision.SELL ||
    normalized === AISignalDecision.STRONG_SELL ||
    normalized.includes('sell') ||
    normalized.includes('卖')
  ) {
    return 'short';
  }
  if (
    normalized === AISignalDecision.BUY ||
    normalized === AISignalDecision.STRONG_BUY ||
    normalized.includes('buy') ||
    normalized.includes('买')
  ) {
    return 'long';
  }
  return 'neutral';
}

function consensusSignalBucketKey(value: any): string {
  const count = Number(value);
  if (Number.isFinite(count) && count >= 4) return 'consensus_4_plus';
  if (count === 3) return 'consensus_3';
  if (count === 2) return 'consensus_2';
  return 'no_consensus';
}

function consensusSignalBucketLabel(key: string): string {
  const labels: Record<string, string> = {
    consensus_4_plus: '4组以上共识',
    consensus_3: '3组共识',
    consensus_2: '2组共识',
    no_consensus: '无显式共识',
  };
  return labels[key] || key || 'unknown';
}

function directionalReturn(returnPct: number, decision?: string): number {
  const side = getSignalSide(decision);
  if (side === 'short') return -returnPct;
  if (side === 'neutral') return -Math.abs(returnPct);
  return returnPct;
}

function summarizeReturnSamples(samples: any[]) {
  const completedSamples = samples.filter(sample => Number.isFinite(Number(sample.return_pct)));
  const returns = completedSamples.map(sample => Number(sample.return_pct));
  const excessReturns = completedSamples
    .map(sample => Number(sample.excess_return_pct))
    .filter(Number.isFinite);
  const directionalReturns = completedSamples.map(sample =>
    Number.isFinite(Number(sample.directional_return_pct))
      ? Number(sample.directional_return_pct)
      : directionalReturn(Number(sample.return_pct), sample.normalized_decision)
  );
  const directionalExcessReturns = completedSamples
    .map(sample => Number(sample.directional_excess_return_pct))
    .filter(Number.isFinite);
  const wins = returns.filter(value => value > 0);
  const losses = returns.filter(value => value < 0);
  const excessWins = excessReturns.filter(value => value > 0);
  const directionalWins = directionalReturns.filter(value => value > 0);
  const directionalExcessWins = directionalExcessReturns.filter(value => value > 0);
  const mfeValues = completedSamples
    .map(sample => Number(sample.max_favorable_excursion_pct))
    .filter(Number.isFinite);
  const maeValues = completedSamples
    .map(sample => Number(sample.max_adverse_excursion_pct))
    .filter(Number.isFinite);

  const avgReturn = averageNumbers(returns);
  const avgWin = averageNumbers(wins);
  const avgLoss = averageNumbers(losses);
  const sumWins = wins.reduce((sum, value) => sum + value, 0);
  const sumLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const avgMfe = averageNumbers(mfeValues);
  const avgMae = averageNumbers(maeValues);

  return {
    count: completedSamples.length,
    avg_return_pct: roundNumber(avgReturn, 4) ?? 0,
    median_return_pct: roundNumber(medianNumber(returns), 4) ?? 0,
    excess_sample_count: excessReturns.length,
    avg_excess_return_pct: roundNumber(averageNumbers(excessReturns), 4) ?? 0,
    median_excess_return_pct: roundNumber(medianNumber(excessReturns), 4) ?? 0,
    excess_positive_count: excessWins.length,
    excess_positive_rate:
      excessReturns.length > 0
        ? roundNumber((excessWins.length / excessReturns.length) * 100, 2) ?? 0
        : 0,
    positive_count: wins.length,
    positive_rate:
      completedSamples.length > 0
        ? roundNumber((wins.length / completedSamples.length) * 100, 2) ?? 0
        : 0,
    directional_success_count: directionalWins.length,
    directional_success_rate:
      completedSamples.length > 0
        ? roundNumber((directionalWins.length / completedSamples.length) * 100, 2) ?? 0
        : 0,
    directional_excess_sample_count: directionalExcessReturns.length,
    directional_excess_success_count: directionalExcessWins.length,
    directional_excess_success_rate:
      directionalExcessReturns.length > 0
        ? roundNumber((directionalExcessWins.length / directionalExcessReturns.length) * 100, 2) ??
          0
        : 0,
    avg_win_pct: roundNumber(avgWin, 4) ?? 0,
    avg_loss_pct: roundNumber(avgLoss, 4) ?? 0,
    payoff_ratio:
      avgWin !== null && avgLoss !== null && avgLoss !== 0
        ? roundNumber(avgWin / Math.abs(avgLoss), 4) ?? 0
        : wins.length > 0 && losses.length === 0
        ? 999
        : 0,
    profit_factor:
      sumLosses > 0 ? roundNumber(sumWins / sumLosses, 4) ?? 0 : wins.length > 0 ? 999 : 0,
    expectancy_pct: roundNumber(avgReturn, 4) ?? 0,
    max_return_pct: returns.length > 0 ? roundNumber(Math.max(...returns), 4) ?? 0 : 0,
    min_return_pct: returns.length > 0 ? roundNumber(Math.min(...returns), 4) ?? 0 : 0,
    avg_mfe_pct: roundNumber(avgMfe, 4) ?? 0,
    avg_mae_pct: roundNumber(avgMae, 4) ?? 0,
    risk_reward_ratio:
      avgMfe !== null && avgMae !== null && avgMae !== 0
        ? roundNumber(avgMfe / Math.abs(avgMae), 4) ?? 0
        : 0,
  };
}

function extractCompletedReturnSamples(signals: any[], horizonFilter?: string) {
  const samples: any[] = [];

  for (const signal of signals) {
    const horizons = signal.forward_returns?.horizons || {};
    for (const [horizon, value] of Object.entries<any>(horizons)) {
      if (horizonFilter && horizon !== horizonFilter) continue;
      if (value?.status !== 'completed') continue;
      const returnPct = Number(value.return_pct);
      if (!Number.isFinite(returnPct)) continue;
      const normalizedDecision = signal.normalized_decision || 'unknown';
      samples.push({
        signal_id: signal.id,
        source_type: signal.source_type,
        symbol: signal.symbol,
        name: signal.name,
        signal_date: signal.signal_date,
        normalized_decision: normalizedDecision,
        agent_session: signal.metadata?.agent_session,
        task_label: signal.metadata?.task_label,
        consensus_count: Number(signal.metadata?.consensus_count || 0),
        consensus_bonus: Number(signal.metadata?.consensus_bonus || 0),
        original_score:
          signal.metadata?.original_score !== undefined
            ? Number(signal.metadata.original_score)
            : undefined,
        consensus_variants: Array.isArray(signal.metadata?.consensus_variants)
          ? signal.metadata.consensus_variants
          : [],
        consensus_bucket: consensusSignalBucketKey(signal.metadata?.consensus_count),
        recommendation_tier: signal.metadata?.recommendation_tier,
        recommendation_tier_label: signal.metadata?.recommendation_tier_label,
        data_quality_bucket: signal.metadata?.data_quality_bucket || 'unknown',
        data_quality_score: toNumber(signal.metadata?.data_quality_score),
        confidence_score: toNumber(signal.confidence_score),
        risk_level: signal.risk_level,
        horizon,
        horizon_days: Number(String(horizon).replace('d', '')),
        entry_date: signal.forward_returns?.entry_date,
        entry_price: Number(signal.forward_returns?.entry_price),
        exit_date: value.exit_date,
        exit_price: Number(value.exit_price),
        return_pct: returnPct,
        directional_return_pct:
          value.directional_return_pct !== undefined
            ? Number(value.directional_return_pct)
            : directionalReturn(returnPct, normalizedDecision),
        max_favorable_excursion_pct:
          value.max_favorable_excursion_pct !== undefined
            ? Number(value.max_favorable_excursion_pct)
            : undefined,
        max_adverse_excursion_pct:
          value.max_adverse_excursion_pct !== undefined
            ? Number(value.max_adverse_excursion_pct)
            : undefined,
        benchmark_code: value.benchmark_code,
        benchmark_name: value.benchmark_name,
        benchmark_return_pct:
          value.benchmark_return_pct !== undefined ? Number(value.benchmark_return_pct) : undefined,
        excess_return_pct:
          value.excess_return_pct !== undefined ? Number(value.excess_return_pct) : undefined,
        directional_excess_return_pct:
          value.directional_excess_return_pct !== undefined
            ? Number(value.directional_excess_return_pct)
            : undefined,
      });
    }
  }

  return samples;
}

function getHorizonStatus(signal: any, horizon: string): string {
  const horizons = signal.forward_returns?.horizons || {};
  const status = horizons?.[horizon]?.status;
  if (status) return String(status);
  if (signal.verification_status === 'no_data') return 'no_data';
  if (signal.verification_status === 'completed') return 'completed';
  if (signal.verification_status === 'partial') return 'pending';
  return signal.verification_status || 'pending';
}

function buildConsensusMaturity(signals: any[], horizon: string) {
  const bucketMap = new Map<
    string,
    {
      key: string;
      label: string;
      total: number;
      completed: number;
      pending: number;
      no_data: number;
      partial: number;
      latest_signal_date?: string;
    }
  >();
  const ensureBucket = (key: string) => {
    if (!bucketMap.has(key)) {
      bucketMap.set(key, {
        key,
        label: consensusSignalBucketLabel(key),
        total: 0,
        completed: 0,
        pending: 0,
        no_data: 0,
        partial: 0,
      });
    }
    return bucketMap.get(key)!;
  };

  for (const signal of signals) {
    const key = consensusSignalBucketKey(signal.metadata?.consensus_count);
    const bucket = ensureBucket(key);
    const status = getHorizonStatus(signal, horizon);
    bucket.total += 1;
    if (status === 'completed') bucket.completed += 1;
    else if (status === 'no_data') bucket.no_data += 1;
    else if (status === 'partial') bucket.partial += 1;
    else bucket.pending += 1;
    if (
      signal.signal_date &&
      (!bucket.latest_signal_date || String(signal.signal_date) > bucket.latest_signal_date)
    ) {
      bucket.latest_signal_date = String(signal.signal_date);
    }
  }

  const buckets = Array.from(bucketMap.values())
    .map(bucket => ({
      ...bucket,
      mature_rate:
        bucket.total > 0 ? roundNumber((bucket.completed / bucket.total) * 100, 2) ?? 0 : 0,
      waiting: bucket.pending + bucket.partial,
    }))
    .sort((a, b) => {
      const order = ['consensus_4_plus', 'consensus_3', 'consensus_2', 'no_consensus'];
      return order.indexOf(a.key) - order.indexOf(b.key);
    });

  const consensusBuckets = buckets.filter(bucket => bucket.key !== 'no_consensus');
  const consensusTotal = consensusBuckets.reduce((sum, bucket) => sum + bucket.total, 0);
  const consensusCompleted = consensusBuckets.reduce((sum, bucket) => sum + bucket.completed, 0);
  const consensusPending = consensusBuckets.reduce(
    (sum, bucket) => sum + bucket.pending + bucket.partial,
    0
  );
  const consensusNoData = consensusBuckets.reduce((sum, bucket) => sum + bucket.no_data, 0);
  return {
    horizon,
    buckets,
    consensus_total: consensusTotal,
    consensus_completed: consensusCompleted,
    consensus_pending: consensusPending,
    consensus_no_data: consensusNoData,
    consensus_mature_rate:
      consensusTotal > 0 ? roundNumber((consensusCompleted / consensusTotal) * 100, 2) ?? 0 : 0,
  };
}

function calculateQualityScore(summary: any, minSamples = 5): number {
  if (!summary || !summary.count) return 0;
  const primaryAvgReturn = Number(
    Number(summary.excess_sample_count || 0) > 0 && summary.avg_excess_return_pct !== undefined
      ? summary.avg_excess_return_pct
      : summary.avg_return_pct || 0
  );
  const primaryDirectionalRate = Number(
    Number(summary.directional_excess_sample_count || 0) > 0
      ? summary.directional_excess_success_rate || 0
      : summary.directional_success_rate || 0
  );
  const avgReturnScore = Math.max(-20, Math.min(35, primaryAvgReturn * 5));
  const directionalScore = (Math.max(0, Math.min(100, primaryDirectionalRate)) - 50) * 0.45;
  const payoffScore = Math.min(20, Math.max(0, Number(summary.payoff_ratio || 0) * 6));
  const riskRewardScore = Math.min(12, Math.max(-8, Number(summary.risk_reward_ratio || 0) * 4));
  const sampleScore = Math.min(18, (Number(summary.count || 0) / Math.max(minSamples, 1)) * 18);
  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        35 + avgReturnScore + directionalScore + payoffScore + riskRewardScore + sampleScore
      )
    )
  );
}

function classifyQualityGate(summary: any, minSamples = 5) {
  const count = Number(summary?.count || 0);
  const avgReturn = Number(
    Number(summary?.excess_sample_count || 0) > 0 && summary?.avg_excess_return_pct !== undefined
      ? summary.avg_excess_return_pct
      : summary?.avg_return_pct || 0
  );
  const directionalSuccessRate = Number(
    Number(summary?.directional_excess_sample_count || 0) > 0
      ? summary?.directional_excess_success_rate || 0
      : summary?.directional_success_rate || 0
  );
  const payoffRatio = Number(summary?.payoff_ratio || 0);
  const mae = Math.abs(Number(summary?.avg_mae_pct || 0));

  if (count === 0) {
    return {
      action: 'wait_for_samples',
      label: '等待样本',
      severity: 'watch',
      position_multiplier: 0,
      reason: '暂无完成样本，不能用于仓位放大',
    };
  }

  if (count < minSamples) {
    return {
      action: 'collect_more_samples',
      label: '继续观察',
      severity: 'watch',
      position_multiplier: 0.5,
      reason: `完成样本 ${count}/${minSamples}，仅适合小仓验证`,
    };
  }

  if (avgReturn > 1.5 && directionalSuccessRate >= 58 && payoffRatio >= 1.15) {
    return {
      action: 'scale_up',
      label: '可放大',
      severity: 'good',
      position_multiplier: mae > 6 ? 1.1 : 1.25,
      reason: `均收 ${roundNumber(avgReturn, 2)}%，方向胜率 ${roundNumber(
        directionalSuccessRate,
        1
      )}%，盈亏比 ${roundNumber(payoffRatio, 2)}`,
    };
  }

  if (avgReturn < -1.2 || directionalSuccessRate < 42) {
    return {
      action: 'deprioritize',
      label: '降权/暂避',
      severity: 'bad',
      position_multiplier: 0.25,
      reason: `均收 ${roundNumber(avgReturn, 2)}%，方向胜率 ${roundNumber(
        directionalSuccessRate,
        1
      )}%，不具备正期望`,
    };
  }

  return {
    action: 'normal_watch',
    label: '正常跟踪',
    severity: 'neutral',
    position_multiplier: 0.75,
    reason: `均收 ${roundNumber(avgReturn, 2)}%，方向胜率 ${roundNumber(
      directionalSuccessRate,
      1
    )}%，仍需等待更清晰优势`,
  };
}

function buildQualityBucket(key: string, label: string, samples: any[], minSamples = 5) {
  const summary = summarizeReturnSamples(samples);
  return {
    key,
    label,
    ...summary,
    quality_score: calculateQualityScore(summary, minSamples),
    gate: classifyQualityGate(summary, minSamples),
  };
}

function sourceLabelForPerformance(value?: string) {
  const labels: Record<string, string> = {
    quant_recommendation: '量化候选',
    tradingagents: 'TradingAgents',
    daily_screener: '每日优选',
    manual_analysis: '人工分析',
  };
  return labels[String(value || '')] || value || 'unknown';
}

function decisionLabelForPerformance(value?: string) {
  const labels: Record<string, string> = {
    strong_buy: '强买',
    buy: '买入',
    hold: '持有',
    sell: '卖出',
    strong_sell: '强卖',
    unknown: '未知',
  };
  return labels[String(value || '')] || value || 'unknown';
}

function agentSessionLabelForPerformance(value?: string) {
  const labels: Record<string, string> = {
    close: '尾盘/收盘',
    midday: '午盘',
    morning: '早盘',
  };
  return labels[String(value || '')] || value || 'unknown';
}

function confidenceBucket(value?: number) {
  const score = Number(value || 0);
  if (score >= 85) return 'score_85_plus';
  if (score >= 75) return 'score_75_84';
  if (score >= 60) return 'score_60_74';
  return 'score_below_60';
}

function confidenceBucketLabel(value?: string) {
  const labels: Record<string, string> = {
    score_85_plus: '置信≥85',
    score_75_84: '置信75-84',
    score_60_74: '置信60-74',
    score_below_60: '置信<60',
  };
  return labels[String(value || '')] || value || 'unknown';
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dataQualityBucket(score: number): AgentDataQualityAssessment['bucket'] {
  if (score >= 80) return 'high';
  if (score >= 60) return 'medium';
  if (score >= 40) return 'low';
  return 'critical';
}

function dataQualityBucketLabel(value?: string) {
  const labels: Record<string, string> = {
    high: '数据高可信',
    medium: '数据基本可用',
    low: '数据缺口较多',
    critical: '数据严重不足',
    unknown: '未标注数据质量',
  };
  return labels[String(value || '')] || value || 'unknown';
}

function assessTradingAgentsDataQuality(combined: string): AgentDataQualityAssessment {
  const text = String(combined || '');
  const warnings: string[] = [];
  const missingSections = new Set<string>();
  const coverage: AgentDataQualityAssessment['coverage'] = {
    market_data: /no data found for symbol|missing historical data|无法获取.*行情|缺失.*行情/i.test(
      text
    )
      ? 'missing'
      : /Technical indicators|历史|K线|OHLCV|Date,|收盘|成交量/i.test(text)
      ? 'ok'
      : 'partial',
    technical_indicators:
      /Cannot calculate indicators|missing valid OHLCV|Unsupported indicators|技术指标.*失败|无法计算.*指标/i.test(
        text
      )
        ? 'missing'
        : /Technical indicators|MACD|RSI|BOLL|SMA|EMA|技术指标/i.test(text)
        ? 'ok'
        : 'partial',
    fundamentals:
      /No fundamental data|无法获取.*基本面|无.*基本面|fundamental data unavailable|Data unavailable due to network issues/i.test(
        text
      )
        ? 'missing'
        : /fundamental|基本面|公司概况|PE|PB|市盈率|市净率/i.test(text)
        ? 'ok'
        : 'partial',
    financial_statements:
      /No balance sheet data|No cash flow data|No income statement data|无法获取.*资产负债|无法获取.*现金流|无法获取.*利润表|财务报表.*无|无可用数据/i.test(
        text
      )
        ? 'missing'
        : /balance sheet|cash flow|income statement|资产负债|现金流|利润表|财务报表/i.test(text)
        ? 'ok'
        : 'partial',
    news: /No news|未检索到.*新闻|未发现.*资讯|无相关新闻|新闻.*缺失/i.test(text)
      ? 'missing'
      : /新闻|舆情|公告|宏观|news/i.test(text)
      ? 'ok'
      : 'partial',
    realtime_quote: /Failed to get real-time quote|实时.*失败|无法获取.*实时/i.test(text)
      ? 'missing'
      : /Real-time Quote|最新价|实时|涨跌幅|current price/i.test(text)
      ? 'ok'
      : 'partial',
  };

  let score = 100;
  const penalize = (
    section: keyof AgentDataQualityAssessment['coverage'],
    points: number,
    msg: string
  ) => {
    const status = coverage[section];
    if (status === 'missing') {
      score -= points;
      missingSections.add(section);
      warnings.push(msg);
    } else if (status === 'partial') {
      score -= Math.round(points * 0.35);
    }
  };

  penalize('market_data', 45, '行情/K线数据缺失，价格与技术判断不可靠');
  penalize('technical_indicators', 28, '技术指标不可用，趋势/动量判断可信度下降');
  penalize('fundamentals', 18, '基本面数据缺失，无法验证估值与经营质量');
  penalize('financial_statements', 18, '核心财务报表缺失，需人工复核财务风险');
  penalize('news', 8, '新闻/舆情覆盖不足，事件驱动判断可能漏项');
  penalize('realtime_quote', 8, '实时行情缺失，入场价格与当日走势需复核');

  if (
    /Data unavailable due to network issues|network issues|NoneType|接口请求失败|触发限流|max retries/i.test(
      text
    )
  ) {
    score -= 10;
    warnings.push('外部数据源存在网络/限流异常，建议稍后重跑 Agent');
  }
  if (
    /无法形成具体的交易决策支持|无法出具最终交易提案|无法提供完整|无法获取核心基本面数据/i.test(
      text
    )
  ) {
    score -= 12;
    warnings.push('Agent 明确提示关键数据不足，不能直接作为自动买入依据');
  }
  if (/(^|[\s（(【\[])(?:\*?ST)(?=[\s）)】\]股票股风险])|退市|披星戴帽|面值退市/i.test(text)) {
    score -= 5;
    warnings.push('标的存在 ST/退市相关风险，需要强制人工复核或小仓位观察');
  }

  const normalizedScore = clampNumber(Math.round(score), 0, 100);
  const bucket = dataQualityBucket(normalizedScore);
  const confidenceMultiplier =
    bucket === 'high' ? 1 : bucket === 'medium' ? 0.88 : bucket === 'low' ? 0.65 : 0.45;
  const recommendation: AgentDataQualityAssessment['recommendation'] =
    bucket === 'high'
      ? 'allow_auto_trade'
      : bucket === 'medium'
      ? 'allow_small_sample'
      : bucket === 'low'
      ? 'manual_review_required'
      : 'block_auto_trade';

  return {
    score: normalizedScore,
    bucket,
    confidence_multiplier: confidenceMultiplier,
    auto_trade_allowed: ['high', 'medium'].includes(bucket),
    recommendation,
    missing_sections: Array.from(missingSections),
    warning_count: warnings.length,
    warnings: Array.from(new Set(warnings)).slice(0, 8),
    coverage,
  };
}

function applyAgentDataQualityToScore(
  score: number | undefined,
  dataQuality: AgentDataQualityAssessment
) {
  if (score === undefined) return undefined;
  const adjusted = score * dataQuality.confidence_multiplier;
  return roundNumber(adjusted, 2) ?? score;
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

export class AIInvestmentSignalService {
  parseTradingAgentsDecision(decision: string, detail?: any): TradingAgentsStructuredDecision {
    const text = typeof decision === 'string' ? decision : JSON.stringify(decision || '');
    const detailText =
      typeof detail === 'string'
        ? detail
        : detail?.text
        ? String(detail.text)
        : detail
        ? JSON.stringify(detail)
        : '';
    const combined = `${text}\n${detailText}`;

    const explicitDecision = this.normalizeDecision(text);
    const finalDecisionMatch =
      combined.match(
        /Final\s+Decision\s+(?:for\s+[^:：\n]+)?\s*[:：]\s*([A-Z_\-\s]+|强烈买入|买入|持有|观望|中性|卖出|强烈卖出|看多|看空)/i
      ) ||
      combined.match(
        /最终(?:交易)?(?:决策|提案|建议)\s*[:：]?\s*(?:\*\*)?\s*([A-Z_\-\s]+|强烈买入|买入|持有|观望|中性|卖出|强烈卖出|看多|看空)/i
      );
    const ratingMatch =
      combined.match(/(?:\*\*)?Rating(?:\*\*)?\s*[:：]\s*([^\n]+)/i) ||
      combined.match(/评级\s*[:：]\s*([^\n]+)/i);
    const rawRating = stripMarkdown(
      explicitDecision !== AISignalDecision.UNKNOWN
        ? text
        : finalDecisionMatch?.[1] || ratingMatch?.[1] || text.split('\n')[0] || 'UNKNOWN'
    );
    const normalized_decision =
      explicitDecision !== AISignalDecision.UNKNOWN
        ? explicitDecision
        : this.normalizeDecision(rawRating);

    const summaryMatch =
      combined.match(
        /(?:\*\*)?Executive Summary(?:\*\*)?\s*[:：]?\s*([\s\S]*?)(?=\n\s*(?:\d+\.\s*)?(?:\*\*)?(?:Investment Thesis|Risk|风险|投资论点)|$)/i
      ) || combined.match(/执行摘要\s*[:：]?\s*([\s\S]*?)(?=\n\s*(?:投资论点|风险|$))/i);
    const thesisMatch =
      combined.match(
        /(?:\*\*)?Investment Thesis(?:\*\*)?\s*[:：]?\s*([\s\S]*?)(?=\n\s*(?:\d+\.\s*)?(?:\*\*)?(?:Risk|风险|$))/i
      ) || combined.match(/投资论点\s*[:：]?\s*([\s\S]*?)(?=\n\s*(?:风险|$))/i);

    const upper = combined.toUpperCase();
    const action_tags: string[] = [];
    const actionTagRules: Array<[string, RegExp]> = [
      ['stop_loss', /止损|STOP[-\s]?LOSS/i],
      ['take_profit', /止盈|TAKE[-\s]?PROFIT/i],
      ['position_sizing', /仓位|POSITION/i],
      ['avoid_entry', /禁止介入|避免介入|AVOID/i],
      ['watchlist', /观察|WATCH/i],
    ];
    actionTagRules.forEach(([tag, regex]) => {
      if (regex.test(combined)) action_tags.push(tag);
    });

    const baseConfidenceScore =
      normalized_decision === AISignalDecision.STRONG_BUY
        ? 88
        : normalized_decision === AISignalDecision.BUY
        ? 78
        : normalized_decision === AISignalDecision.HOLD
        ? 58
        : normalized_decision === AISignalDecision.SELL
        ? 35
        : normalized_decision === AISignalDecision.STRONG_SELL
        ? 20
        : undefined;
    const data_quality = assessTradingAgentsDataQuality(combined);
    const confidence_score = applyAgentDataQualityToScore(baseConfidenceScore, data_quality);

    const risk_level =
      upper.includes('SELL') || /高风险|严格止损|禁止介入|清仓|HIGH RISK/i.test(combined)
        ? 'high'
        : /低风险|LOW RISK|稳健/i.test(combined)
        ? 'low'
        : 'medium';

    return {
      rating: rawRating,
      normalized_decision,
      summary: summaryMatch?.[1] ? stripMarkdown(summaryMatch[1]).slice(0, 1500) : undefined,
      thesis: thesisMatch?.[1] ? stripMarkdown(thesisMatch[1]).slice(0, 3000) : undefined,
      raw_confidence_score: baseConfidenceScore,
      confidence_score,
      risk_level,
      action_tags,
      data_quality,
      key_levels: {
        stop_loss: firstNumber(
          combined.match(/(?:止损(?:线|位)?|stop[-\s]?loss)[^0-9]{0,12}([0-9]+(?:\.[0-9]+)?)/i)
        ),
        take_profit: firstNumber(
          combined.match(/(?:止盈(?:线|位)?|take[-\s]?profit)[^0-9]{0,12}([0-9]+(?:\.[0-9]+)?)/i)
        ),
        entry: firstNumber(
          combined.match(/(?:买入|介入|entry|布局)[^0-9]{0,12}([0-9]+(?:\.[0-9]+)?)/i)
        ),
      },
    };
  }

  normalizeDecision(decision: string): string {
    const text = String(decision || '').toUpperCase();
    if (text.includes('STRONG_BUY') || text.includes('强烈买入') || text.includes('强买')) {
      return AISignalDecision.STRONG_BUY;
    }
    if (text.includes('STRONG_SELL') || text.includes('强烈卖出') || text.includes('强卖')) {
      return AISignalDecision.STRONG_SELL;
    }
    if (text.includes('SELL') || text.includes('卖出') || text.includes('看空')) {
      return AISignalDecision.SELL;
    }
    if (text.includes('BUY') || text.includes('买入') || text.includes('看多')) {
      return AISignalDecision.BUY;
    }
    if (
      text.includes('HOLD') ||
      text.includes('观望') ||
      text.includes('中性') ||
      text.includes('持有')
    ) {
      return AISignalDecision.HOLD;
    }
    return AISignalDecision.UNKNOWN;
  }

  decisionFromQuantScore(score: number): string {
    if (score >= 82) return AISignalDecision.STRONG_BUY;
    if (score >= 70) return AISignalDecision.BUY;
    return AISignalDecision.HOLD;
  }

  inferRiskLevel(record: any): string {
    const score = toNumber(record.score ?? record.confidence_score);
    const decision = this.normalizeDecision(record.decision || '');
    if ([AISignalDecision.SELL, AISignalDecision.STRONG_SELL].includes(decision as any)) {
      return 'high';
    }
    if (score !== undefined && score >= 85) return 'medium';
    if (score !== undefined && score >= 70) return 'low';
    return 'medium';
  }

  async syncFromDailyScreeners(): Promise<{ created: number; updated: number; total: number }> {
    const screeners = await DailyScreener.findAll({ order: [['created_at', 'DESC']] });
    let created = 0;
    let updated = 0;

    for (const screener of screeners) {
      const source_id = String(screener.id);
      const taskLabel = screener.scores?.task_label || screener.scores?.taskLabel;
      const agentSession =
        screener.scores?.agent_session ||
        screener.scores?.agentSession ||
        inferAgentSession(taskLabel, screener.created_at);
      const payload = {
        source_type: AISignalSourceType.DAILY_SCREENER,
        source_id,
        symbol: normalizeSymbol(screener.symbol),
        name: screener.name,
        signal_date: screener.date,
        decision: screener.decision || 'UNKNOWN',
        normalized_decision: this.normalizeDecision(screener.decision),
        confidence_score: toNumber(screener.score),
        risk_level: this.inferRiskLevel(screener),
        rationale: screener.rationale,
        detail: screener.detail,
        current_price: toNumber(screener.current_price),
        price_change_pct: toNumber(screener.price_change_pct),
        metadata: {
          scores: screener.scores || {},
          daily_screener_id: screener.id,
          task_label: taskLabel,
          agent_session: agentSession,
          is_tail_session: agentSession === 'close',
          created_at: screener.created_at,
        },
      };

      const [record, isCreated] = await AIInvestmentSignal.findOrCreate({
        where: {
          source_type: AISignalSourceType.DAILY_SCREENER,
          source_id,
        },
        defaults: payload,
      });

      if (isCreated) {
        created++;
      } else {
        await record.update(payload);
        updated++;
      }
    }

    return { created, updated, total: screeners.length };
  }

  async archiveTradingAgentsResult(params: {
    task_id?: string;
    symbol: string;
    signal_date?: string;
    decision: string;
    rationale?: string;
    detail?: any;
    confidence_score?: number;
    current_price?: number;
    price_change_pct?: number;
    source_type?: string;
    task_label?: string;
    agent_session?: string;
    loop_run_id?: string;
    loop_policy_snapshot_id?: number;
    strategy_key?: string;
    strategy_variant?: Record<string, any>;
    market_environment?: Record<string, any>;
  }): Promise<AIInvestmentSignal> {
    const symbol = normalizeSymbol(params.symbol);
    const signal_date = params.signal_date || new Date().toISOString().split('T')[0];
    const source_type = params.source_type || AISignalSourceType.TRADING_AGENTS;
    const source_id = params.task_id || `${symbol}_${signal_date}_${Date.now()}`;
    const stock = await Stock.findOne({ where: { symbol } });
    const detailText =
      typeof params.detail === 'string'
        ? params.detail
        : params.detail
        ? JSON.stringify(params.detail)
        : undefined;
    const structured = this.parseTradingAgentsDecision(
      params.decision || params.rationale || '',
      params.detail
    );
    const agent_session = params.agent_session || inferAgentSession(params.task_label);
    const normalizedDecision = structured.normalized_decision || AISignalDecision.UNKNOWN;
    const decisionText = String(
      normalizedDecision !== AISignalDecision.UNKNOWN
        ? normalizedDecision
        : params.decision || normalizedDecision || 'UNKNOWN'
    );
    const rawConfidenceScore = params.confidence_score ?? structured.raw_confidence_score;
    const dataQualityAdjustedScore = applyAgentDataQualityToScore(
      rawConfidenceScore,
      structured.data_quality
    );
    const effectiveRiskLevel =
      structured.data_quality.bucket === 'critical'
        ? 'high'
        : structured.data_quality.bucket === 'low' && normalizedDecision !== AISignalDecision.SELL
        ? 'medium'
        : structured.risk_level || this.inferRiskLevel(params);
    const marketEnvironment =
      params.market_environment ||
      (await marketEnvironmentService
        .getEnvironmentForStock(symbol, { stock, use_cache: true })
        .catch(error => {
          logger.warn(`TradingAgents 信号市场环境归因失败 ${symbol}: ${error?.message || error}`);
          return undefined;
        }));

    const payload = {
      source_type,
      source_id,
      loop_run_id: params.loop_run_id,
      symbol,
      name: stock?.name,
      signal_date,
      decision: decisionText.slice(0, 100),
      normalized_decision: normalizedDecision,
      confidence_score: dataQualityAdjustedScore,
      risk_level: effectiveRiskLevel,
      rationale: params.rationale || structured.summary,
      detail: detailText,
      current_price: params.current_price,
      price_change_pct: params.price_change_pct,
      metadata: mergeMetadata(undefined, {
        task_id: params.task_id,
        task_label: params.task_label,
        agent_session,
        is_tail_session: agent_session === 'close',
        loop_run_id: params.loop_run_id,
        loop_policy_snapshot_id: params.loop_policy_snapshot_id,
        strategy_key: params.strategy_key,
        strategy_variant: params.strategy_variant,
        strategy_bucket_label: params.strategy_variant?.strategy_bucket_label,
        market_environment: marketEnvironment,
        structured_decision: structured,
        data_quality: structured.data_quality,
        data_quality_score: structured.data_quality.score,
        data_quality_bucket: structured.data_quality.bucket,
        data_quality_adjusted_score: dataQualityAdjustedScore,
        raw_confidence_score: rawConfidenceScore,
        auto_trade_allowed_by_data_quality: structured.data_quality.auto_trade_allowed,
      }),
    };

    const [record, created] = await AIInvestmentSignal.findOrCreate({
      where: { source_type, source_id },
      defaults: payload,
    });

    if (!created) {
      await record.update(payload);
    }

    return record;
  }

  async backfillAgentSessionMetadata(
    options: { limit?: number; source_type?: string; loop_run_id?: string } = {}
  ) {
    const limit = Math.min(Math.max(Number(options.limit || 2000), 1), 10000);
    const where: any = {};
    if (options.source_type) where.source_type = options.source_type;
    if (options.loop_run_id) where.loop_run_id = options.loop_run_id;
    const signals = await AIInvestmentSignal.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit,
    });

    let updated = 0;
    for (const signal of signals) {
      const metadata = signal.metadata || {};
      if (metadata.agent_session) continue;

      const taskLabel =
        metadata.task_label ||
        metadata.taskLabel ||
        metadata.scores?.task_label ||
        metadata.scores?.taskLabel;
      const agentSession = inferAgentSession(taskLabel, signal.created_at);
      if (!agentSession) continue;

      await signal.update({
        metadata: mergeMetadata(metadata, {
          task_label: taskLabel,
          agent_session: agentSession,
          is_tail_session: agentSession === 'close',
        }),
      });
      updated++;
    }

    return { total: signals.length, updated };
  }

  async archiveQuantRecommendations(options: QuantRecommendationArchiveOptions): Promise<{
    created: number;
    updated: number;
    total: number;
    signal_ids: number[];
  }> {
    const candidates = Array.isArray(options.candidates) ? options.candidates : [];
    const universe = options.universe || 'favorites';
    const style = options.style || 'balanced';
    const loop_run_id = options.loop_run_id;
    let created = 0;
    let updated = 0;
    const signal_ids: number[] = [];

    for (const candidate of candidates) {
      if (!candidate?.symbol) continue;

      const symbol = normalizeSymbol(candidate.symbol);
      const latestTrendDate = candidate.trend?.[candidate.trend.length - 1]?.time;
      const signal_date = resolveSignalDate({
        signal_date: options.signal_date,
        as_of: latestTrendDate || options.as_of,
      });
      const decision =
        candidate.action === 'buy'
          ? AISignalDecision.BUY
          : candidate.action === 'avoid'
          ? AISignalDecision.HOLD
          : this.decisionFromQuantScore(Number(candidate.score || 0));
      const source_id = `${symbol}_${signal_date}_${style}_${universe}`;
      const stock = await Stock.findOne({ where: { symbol } });
      const payload = {
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
        source_id,
        loop_run_id,
        symbol,
        name: candidate.name || stock?.name,
        signal_date,
        decision,
        normalized_decision: decision,
        confidence_score: toNumber(candidate.score),
        risk_level:
          candidate.risk_level || this.inferRiskLevel({ score: candidate.score, decision }),
        rationale:
          (candidate.reasons || []).join('；') ||
          `${candidate.rating || '量化候选'}：多因子综合评分居前`,
        detail: JSON.stringify({
          rating: candidate.rating,
          confidence: candidate.confidence,
          action: candidate.action,
          action_label: candidate.action_label,
          recommendation_tier: candidate.recommendation_tier,
          recommendation_tier_label: candidate.recommendation_tier_label,
          tier_reason: candidate.tier_reason,
          original_score: candidate.original_score,
          pre_quality_score: candidate.pre_quality_score,
          data_quality: candidate.data_quality,
          data_quality_score: candidate.data_quality_score,
          data_quality_bucket: candidate.data_quality_bucket,
          data_quality_adjusted_score: candidate.score,
          auto_trade_allowed_by_data_quality: candidate.data_quality?.auto_trade_allowed,
          consensus_count: candidate.consensus_count,
          consensus_bonus: candidate.consensus_bonus,
          consensus_variants: Array.isArray(candidate.consensus_variants)
            ? candidate.consensus_variants
            : [],
          environment_strategy_adjustment: (candidate as any).environment_strategy_adjustment,
          environment_strategy_policy_label: (candidate as any).environment_strategy_policy_label,
          environment_strategy_policy_action: (candidate as any).environment_strategy_policy_action,
          environment_strategy_budget_action: (candidate as any).environment_strategy_budget_action,
          environment_strategy_budget_reason: (candidate as any).environment_strategy_budget_reason,
          environment_strategy_budget_multiplier: (candidate as any)
            .environment_strategy_budget_multiplier,
          environment_strategy_budget_policy_action: (candidate as any)
            .environment_strategy_budget_policy_action,
          environment_strategy_budget_policy_reason: (candidate as any)
            .environment_strategy_budget_policy_reason,
          environment_strategy_budget_policy_score_adjustment: (candidate as any)
            .environment_strategy_budget_policy_score_adjustment,
          environment_strategy_budget_policy_multiplier: (candidate as any)
            .environment_strategy_budget_policy_multiplier,
          environment_strategy_budget_policy_version_id: (candidate as any)
            .environment_strategy_budget_policy_version_id,
          environment_strategy_budget_policy_version_hash: (candidate as any)
            .environment_strategy_budget_policy_version_hash,
          environment_strategy_budget_policy_version_guard_action: (candidate as any)
            .environment_strategy_budget_policy_version_guard_action,
          environment_strategy_budget_policy_version_guard_reason: (candidate as any)
            .environment_strategy_budget_policy_version_guard_reason,
          environment_strategy_budget_policy_version_guard_champion: (candidate as any)
            .environment_strategy_budget_policy_version_guard_champion,
          environment_strategy_budget_policy_rollback_action: (candidate as any)
            .environment_strategy_budget_policy_rollback_action,
          environment_strategy_budget_policy_rollback_source: (candidate as any)
            .environment_strategy_budget_policy_rollback_source,
          environment_strategy_budget_policy_rollback_snapshot_id: (candidate as any)
            .environment_strategy_budget_policy_rollback_snapshot_id,
          environment_strategy_budget_policy_rollback_reason: (candidate as any)
            .environment_strategy_budget_policy_rollback_reason,
          environment_strategy_capital_efficiency_score: (candidate as any)
            .environment_strategy_capital_efficiency_score,
          market_environment: candidate.market_environment,
          environment_policy: options.environment_policy,
          environment_policy_snapshot_id: options.environment_policy_snapshot_id,
          strategy_key: options.strategy_key,
          strategy_variant: options.strategy_variant,
          strategy_bucket_label: options.strategy_variant?.strategy_bucket_label,
          suggested_position_pct: candidate.suggested_position_pct,
          stop_loss_pct: candidate.stop_loss_pct,
          take_profit_pct: candidate.take_profit_pct,
          factors: candidate.factors || [],
          metrics: candidate.metrics || {},
          warnings: candidate.warnings || [],
          trend: candidate.trend || [],
        }),
        current_price: toNumber(candidate.current_price),
        price_change_pct: toNumber(candidate.change_percent),
        metadata: {
          quant_candidate: true,
          universe,
          style,
          as_of: options.as_of,
          loop_run_id,
          loop_policy_snapshot_id: options.loop_policy_snapshot_id,
          source: candidate.source,
          rating: candidate.rating,
          confidence: candidate.confidence,
          action: candidate.action,
          action_label: candidate.action_label,
          recommendation_tier: candidate.recommendation_tier,
          recommendation_tier_label: candidate.recommendation_tier_label,
          tier_reason: candidate.tier_reason,
          original_score: candidate.original_score,
          pre_quality_score: candidate.pre_quality_score,
          data_quality: candidate.data_quality,
          data_quality_score: candidate.data_quality_score,
          data_quality_bucket: candidate.data_quality_bucket,
          data_quality_adjusted_score: candidate.score,
          auto_trade_allowed_by_data_quality: candidate.data_quality?.auto_trade_allowed,
          consensus_count: candidate.consensus_count,
          consensus_bonus: candidate.consensus_bonus,
          consensus_variants: Array.isArray(candidate.consensus_variants)
            ? candidate.consensus_variants
            : [],
          environment_strategy_adjustment: (candidate as any).environment_strategy_adjustment,
          environment_strategy_policy_label: (candidate as any).environment_strategy_policy_label,
          environment_strategy_policy_action: (candidate as any).environment_strategy_policy_action,
          environment_strategy_budget_action: (candidate as any).environment_strategy_budget_action,
          environment_strategy_budget_reason: (candidate as any).environment_strategy_budget_reason,
          environment_strategy_budget_multiplier: (candidate as any)
            .environment_strategy_budget_multiplier,
          environment_strategy_budget_policy_action: (candidate as any)
            .environment_strategy_budget_policy_action,
          environment_strategy_budget_policy_reason: (candidate as any)
            .environment_strategy_budget_policy_reason,
          environment_strategy_budget_policy_score_adjustment: (candidate as any)
            .environment_strategy_budget_policy_score_adjustment,
          environment_strategy_budget_policy_multiplier: (candidate as any)
            .environment_strategy_budget_policy_multiplier,
          environment_strategy_budget_policy_version_id: (candidate as any)
            .environment_strategy_budget_policy_version_id,
          environment_strategy_budget_policy_version_hash: (candidate as any)
            .environment_strategy_budget_policy_version_hash,
          environment_strategy_budget_policy_version_guard_action: (candidate as any)
            .environment_strategy_budget_policy_version_guard_action,
          environment_strategy_budget_policy_version_guard_reason: (candidate as any)
            .environment_strategy_budget_policy_version_guard_reason,
          environment_strategy_budget_policy_version_guard_champion: (candidate as any)
            .environment_strategy_budget_policy_version_guard_champion,
          environment_strategy_budget_policy_rollback_action: (candidate as any)
            .environment_strategy_budget_policy_rollback_action,
          environment_strategy_budget_policy_rollback_source: (candidate as any)
            .environment_strategy_budget_policy_rollback_source,
          environment_strategy_budget_policy_rollback_snapshot_id: (candidate as any)
            .environment_strategy_budget_policy_rollback_snapshot_id,
          environment_strategy_budget_policy_rollback_reason: (candidate as any)
            .environment_strategy_budget_policy_rollback_reason,
          environment_strategy_capital_efficiency_score: (candidate as any)
            .environment_strategy_capital_efficiency_score,
          market_environment: candidate.market_environment,
          environment_policy: options.environment_policy,
          environment_policy_snapshot_id: options.environment_policy_snapshot_id,
          strategy_key: options.strategy_key,
          strategy_variant: options.strategy_variant,
          strategy_bucket_label: options.strategy_variant?.strategy_bucket_label,
          suggested_position_pct: candidate.suggested_position_pct,
          stop_loss_pct: candidate.stop_loss_pct,
          take_profit_pct: candidate.take_profit_pct,
          factors: candidate.factors || [],
          metrics: candidate.metrics || {},
          reasons: candidate.reasons || [],
          warnings: candidate.warnings || [],
        },
      };

      const [record, isCreated] = await AIInvestmentSignal.findOrCreate({
        where: {
          source_type: AISignalSourceType.QUANT_RECOMMENDATION,
          source_id,
        },
        defaults: payload,
      });

      if (isCreated) {
        created++;
      } else {
        await record.update(payload);
        updated++;
      }
      signal_ids.push(record.id);
    }

    return { created, updated, total: candidates.length, signal_ids };
  }

  async verifySignalReturns(
    signal: AIInvestmentSignal,
    horizons = DEFAULT_HORIZONS
  ): Promise<AIInvestmentSignal> {
    const stock = await Stock.findOne({ where: { symbol: signal.symbol } });
    if (!stock) {
      await signal.update({ verification_status: 'no_data', verified_at: new Date() });
      return signal;
    }

    const bars = await DailyBar.findAll({
      where: {
        stock_id: stock.id,
        time: {
          [Op.gte]: new Date(`${signal.signal_date}T00:00:00.000Z`),
        },
      },
      order: [['time', 'ASC']],
      limit: Math.max(...horizons) + 5,
    });

    if (bars.length === 0) {
      const mature = isVerificationMature(signal.signal_date, Math.max(...horizons));
      await signal.update({
        forward_returns: mature
          ? signal.forward_returns
          : buildPendingForwardReturns(signal, horizons, 'waiting_for_market_data'),
        verification_status: mature ? 'no_data' : 'pending',
        verified_at: new Date(),
      });
      return signal;
    }

    const baseBar = bars.find(bar => dateOnly(bar.time) >= signal.signal_date) || bars[0];
    const baseIndex = bars.findIndex(bar => bar.time.getTime() === baseBar.time.getTime());
    const entryPrice = Number(baseBar.close);
    const signalSide = getSignalSide(signal.normalized_decision || signal.decision);
    const forward_returns: Record<string, any> = {
      entry_date: dateOnly(baseBar.time),
      entry_price: entryPrice,
      decision_side: signalSide,
      horizons: {},
    };

    const completedTargets = horizons.map(horizon => bars[baseIndex + horizon]).filter(Boolean);
    if (completedTargets.length > 0) {
      try {
        const benchmark = await benchmarkIndexService.resolveBenchmarkForStock(
          signal.symbol,
          stock
        );
        await benchmarkIndexService.ensureBenchmarkCoverage(
          dateOnly(baseBar.time),
          dateOnly(completedTargets[completedTargets.length - 1].time),
          {
            symbols: [benchmark.symbol],
            data_source: 'tencent_only',
          }
        );
      } catch (error: any) {
        logger.warn(`基准指数行情预同步失败 ${signal.symbol}#${signal.id}: ${error.message}`);
      }
    }

    let completed = 0;
    for (const horizon of horizons) {
      const target = bars[baseIndex + horizon];
      if (!target || !entryPrice) {
        forward_returns.horizons[`${horizon}d`] = {
          status: 'pending',
          horizon,
        };
        continue;
      }

      const exitPrice = Number(target.close);
      const returnPct = entryPrice ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
      const windowBars = bars.slice(baseIndex, baseIndex + horizon + 1);
      const highPrices = windowBars.map(bar => Number(bar.high)).filter(Number.isFinite);
      const lowPrices = windowBars.map(bar => Number(bar.low)).filter(Number.isFinite);
      const maxHigh = highPrices.length > 0 ? Math.max(...highPrices) : exitPrice;
      const minLow = lowPrices.length > 0 ? Math.min(...lowPrices) : exitPrice;
      const longMfe = entryPrice ? ((maxHigh - entryPrice) / entryPrice) * 100 : 0;
      const longMae = entryPrice ? ((minLow - entryPrice) / entryPrice) * 100 : 0;
      const directionalReturnPct = directionalReturn(
        returnPct,
        signal.normalized_decision || signal.decision
      );
      forward_returns.horizons[`${horizon}d`] = {
        status: 'completed',
        horizon,
        exit_date: dateOnly(target.time),
        exit_price: Number(exitPrice.toFixed(4)),
        return_pct: Number(returnPct.toFixed(4)),
        directional_return_pct: Number(directionalReturnPct.toFixed(4)),
        max_favorable_excursion_pct: Number(
          (signalSide === 'short' ? -longMae : longMfe).toFixed(4)
        ),
        max_adverse_excursion_pct: Number((signalSide === 'short' ? -longMfe : longMae).toFixed(4)),
        window_high: Number(maxHigh.toFixed(4)),
        window_low: Number(minLow.toFixed(4)),
      };

      try {
        const benchmarkReturn = await benchmarkIndexService.getBenchmarkReturnForStock(
          signal.symbol,
          dateOnly(baseBar.time),
          dateOnly(target.time),
          {
            stock,
            data_source: 'tencent_only',
            auto_sync: false,
          }
        );

        if (benchmarkReturn) {
          const excessReturnPct = returnPct - benchmarkReturn.benchmark_return_pct;
          forward_returns.horizons[`${horizon}d`] = {
            ...forward_returns.horizons[`${horizon}d`],
            ...benchmarkReturn,
            excess_return_pct: Number(excessReturnPct.toFixed(4)),
            directional_excess_return_pct: Number(
              directionalReturn(
                excessReturnPct,
                signal.normalized_decision || signal.decision
              ).toFixed(4)
            ),
          };
        }
      } catch (error: any) {
        logger.warn(`基准收益计算失败 ${signal.symbol}#${signal.id}/${horizon}d: ${error.message}`);
      }
      completed++;
    }

    await signal.update({
      forward_returns,
      verification_status:
        completed === 0 ? 'pending' : completed === horizons.length ? 'completed' : 'partial',
      verified_at: new Date(),
    });

    return signal.reload();
  }

  async diagnoseSignalVerification(options: SignalVerificationDiagnosisOptions = {}) {
    const horizons = options.horizons || DEFAULT_HORIZONS;
    const limit = Math.min(Math.max(Number(options.limit || 200), 1), 2000);
    const includeDetails = options.include_details !== false;
    const detailLimit = Math.min(Math.max(Number(options.detail_limit ?? 200), 0), 2000);
    const signals = await AIInvestmentSignal.findAll({
      where: buildSignalWhere(options),
      order: [
        ['signal_date', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit,
    });

    const maxHorizon = Math.max(...horizons);
    const details: any[] = [];
    const pushDetail = (item: any) => {
      if (!includeDetails) return;
      if (details.length >= detailLimit) return;
      details.push(item);
    };
    const missingSymbols = new Set<string>();
    const summary = {
      total_signals: signals.length,
      verified_signals: 0,
      pending_signals: 0,
      no_data_signals: 0,
      missing_stock: 0,
      missing_bars: 0,
      waiting_for_market_data: 0,
      insufficient_horizon_bars: 0,
      invalid_entry_price: 0,
      ready_for_verification: 0,
      symbols_need_sync: 0,
    };

    for (const signal of signals) {
      const symbol = normalizeSymbol(signal.symbol);
      const stock = await Stock.findOne({ where: { symbol } });
      const item: any = {
        signal_id: signal.id,
        symbol,
        name: signal.name,
        signal_date: signal.signal_date,
        source_type: signal.source_type,
        normalized_decision: signal.normalized_decision,
        verification_status: signal.verification_status,
        agent_session: signal.metadata?.agent_session,
      };

      if (!stock) {
        item.issue = 'missing_stock';
        item.message = '股票基础信息不存在，需先同步股票列表';
        summary.missing_stock++;
        summary.no_data_signals++;
        pushDetail(item);
        continue;
      }

      item.stock_id = stock.id;
      const bars = await DailyBar.findAll({
        where: {
          stock_id: stock.id,
          time: { [Op.gte]: new Date(`${signal.signal_date}T00:00:00.000Z`) },
        },
        order: [['time', 'ASC']],
        limit: maxHorizon + 5,
      });

      item.bar_count_after_signal = bars.length;
      if (bars.length === 0) {
        item.issue = 'missing_bars';
        const mature = isVerificationMature(signal.signal_date, maxHorizon);
        item.issue = mature ? 'missing_bars' : 'waiting_for_market_data';
        item.message = mature
          ? '信号日之后没有任何日线行情，需补齐历史行情'
          : '信号刚生成或后验周期未成熟，等待行情同步后再验证';
        summary.missing_bars++;
        if (mature) {
          summary.no_data_signals++;
          missingSymbols.add(symbol);
        } else {
          summary.pending_signals++;
          summary.waiting_for_market_data++;
        }
        pushDetail(item);
        continue;
      }

      const baseBar = bars.find(bar => dateOnly(bar.time) >= signal.signal_date) || bars[0];
      const baseIndex = bars.findIndex(bar => bar.time.getTime() === baseBar.time.getTime());
      const entryPrice = Number(baseBar.close);
      item.entry_date = dateOnly(baseBar.time);
      item.entry_price = entryPrice;
      item.latest_bar_date = dateOnly(bars[bars.length - 1].time);
      item.required_bars = maxHorizon + 1;
      item.available_forward_bars = Math.max(0, bars.length - baseIndex - 1);

      if (!entryPrice || !Number.isFinite(entryPrice)) {
        item.issue = 'invalid_entry_price';
        item.message = '入场日收盘价无效，需要重拉行情';
        summary.invalid_entry_price++;
        summary.no_data_signals++;
        missingSymbols.add(symbol);
      } else if (item.available_forward_bars < maxHorizon) {
        item.issue = 'insufficient_horizon_bars';
        item.message = `后验周期未完成或行情不足：需要 ${maxHorizon} 根后续K线，当前 ${item.available_forward_bars} 根`;
        summary.insufficient_horizon_bars++;
        summary.pending_signals++;
        missingSymbols.add(symbol);
      } else {
        item.issue = 'ready';
        item.message = '行情已满足验证条件';
        summary.ready_for_verification++;
        if (['completed', 'partial'].includes(signal.verification_status || '')) {
          summary.verified_signals++;
        }
      }

      pushDetail(item);
    }

    summary.symbols_need_sync = missingSymbols.size;

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      filters: {
        symbol: options.symbol,
        decision: options.decision,
        source_type: options.source_type,
        agent_session: options.agent_session,
        task_label: options.task_label,
        loop_run_id: options.loop_run_id,
        start_date: options.start_date,
        end_date: options.end_date,
        limit,
        horizons,
      },
      summary,
      symbols_need_sync: Array.from(missingSymbols),
      details_truncated: includeDetails && details.length < signals.length,
      details,
    };
  }

  async repairAndVerifySignals(options: SignalVerificationDiagnosisOptions = {}) {
    const horizons = options.horizons || DEFAULT_HORIZONS;
    const initialDiagnosis = await this.diagnoseSignalVerification({ ...options, horizons });
    const symbols = initialDiagnosis.symbols_need_sync.slice(
      0,
      Math.min(Math.max(Number(options.limit || 200), 1), 2000)
    );
    const endDate = getChinaToday();
    const earliestSignalDate = initialDiagnosis.details
      .map(item => item.signal_date)
      .filter(Boolean)
      .sort()[0];
    const startDate = earliestSignalDate
      ? subtractCalendarDays(earliestSignalDate, Number(options.lookback_days || 15))
      : subtractCalendarDays(endDate, Number(options.lookback_days || 180));

    let syncResult: Record<string, number> = {};
    if (options.auto_sync_missing !== false && symbols.length > 0) {
      const dataSyncService = new DataSyncService();
      syncResult = await dataSyncService.syncMultipleStocksHistory(
        symbols,
        startDate,
        endDate,
        Math.min(Math.max(Number(options.sync_concurrency || 2), 1), 5),
        undefined,
        options.data_source || 'tencent_only'
      );
    }

    const verification = await this.verifySignals({
      ...options,
      horizons,
      report_to_feishu: false,
    });
    const finalDiagnosis = await this.diagnoseSignalVerification({ ...options, horizons });

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      sync_window: {
        start_date: startDate,
        end_date: endDate,
        data_source: options.data_source || 'tencent_only',
      },
      initial_diagnosis: initialDiagnosis,
      sync_result: syncResult,
      verification,
      final_diagnosis: finalDiagnosis,
    };
  }

  async verifySignals(
    options: {
      limit?: number;
      horizons?: number[];
      report_to_feishu?: boolean;
    } & SignalQueryOptions = {}
  ): Promise<{
    total: number;
    verified: number;
    pending: number;
    no_data: number;
  }> {
    const limit = options.limit || 200;
    const signals = await AIInvestmentSignal.findAll({
      where: buildSignalWhere(options),
      order: [['signal_date', 'DESC']],
      limit,
    });

    let verified = 0;
    let pending = 0;
    let no_data = 0;

    for (const signal of signals) {
      try {
        const updated = await this.verifySignalReturns(
          signal,
          options.horizons || DEFAULT_HORIZONS
        );
        if (updated.verification_status === 'no_data') {
          no_data++;
        } else if (updated.verification_status === 'pending') {
          pending++;
        } else {
          verified++;
        }
      } catch (error: any) {
        logger.warn(
          `AI signal verification failed for ${signal.symbol}#${signal.id}: ${error.message}`
        );
      }
    }

    const result = { total: signals.length, verified, pending, no_data };

    if (options.report_to_feishu) {
      const stats = await this.getSignalStats({
        symbol: options.symbol,
        decision: options.decision,
        source_type: options.source_type,
        agent_session: options.agent_session,
        task_label: options.task_label,
        start_date: options.start_date,
        end_date: options.end_date,
      });
      const { feishuTaskReportService } = await import('./FeishuTaskReportService');
      await feishuTaskReportService.reportRecommendationPerformance({
        record_type: '推荐绩效刷新',
        source_type: options.source_type,
        result,
        stats,
      });
    }

    return result;
  }

  async listSignals(options: SignalQueryOptions = {}) {
    const where = buildSignalWhere(options);

    const limit = Math.min(options.limit || 50, 200);
    const offset = options.offset || 0;

    const { rows, count } = await AIInvestmentSignal.findAndCountAll({
      where,
      order: [
        ['signal_date', 'DESC'],
        ['confidence_score', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit,
      offset,
    });

    return { rows, count, limit, offset };
  }

  async getSignalStats(options: SignalQueryOptions = {}) {
    const signals = await AIInvestmentSignal.findAll({
      where: buildSignalWhere(options),
      raw: true,
    });
    const byDecision: Record<string, any> = {};
    const horizonSummary: Record<
      string,
      { count: number; avg_return_pct: number; positive_count: number }
    > = {};

    for (const signal of signals as any[]) {
      const decision = signal.normalized_decision || 'unknown';
      if (!byDecision[decision]) {
        byDecision[decision] = { count: 0, avg_confidence_score: 0, confidence_total: 0 };
      }
      byDecision[decision].count++;
      if (signal.confidence_score !== null && signal.confidence_score !== undefined) {
        byDecision[decision].confidence_total += Number(signal.confidence_score);
      }

      const horizons = signal.forward_returns?.horizons || {};
      for (const [key, value] of Object.entries<any>(horizons)) {
        if (value.status !== 'completed') continue;
        if (!horizonSummary[key]) {
          horizonSummary[key] = {
            count: 0,
            avg_return_pct: 0,
            positive_count: 0,
            avg_excess_return_pct: 0,
            excess_count: 0,
            excess_positive_count: 0,
          } as any;
        }
        horizonSummary[key].count++;
        horizonSummary[key].avg_return_pct += Number(value.return_pct || 0);
        if (Number(value.return_pct || 0) > 0) {
          horizonSummary[key].positive_count++;
        }
        const excessReturn = Number(value.excess_return_pct);
        if (Number.isFinite(excessReturn)) {
          (horizonSummary[key] as any).excess_count++;
          (horizonSummary[key] as any).avg_excess_return_pct += excessReturn;
          if (excessReturn > 0) (horizonSummary[key] as any).excess_positive_count++;
        }
      }
    }

    Object.values(byDecision).forEach((item: any) => {
      item.avg_confidence_score =
        item.count > 0 ? Number((item.confidence_total / item.count).toFixed(2)) : 0;
      delete item.confidence_total;
    });

    Object.values(horizonSummary).forEach(item => {
      item.avg_return_pct =
        item.count > 0 ? Number((item.avg_return_pct / item.count).toFixed(4)) : 0;
      (item as any).positive_rate =
        item.count > 0 ? Number(((item.positive_count / item.count) * 100).toFixed(2)) : 0;
      const excessCount = Number((item as any).excess_count || 0);
      (item as any).avg_excess_return_pct =
        excessCount > 0
          ? Number((Number((item as any).avg_excess_return_pct || 0) / excessCount).toFixed(4))
          : 0;
      (item as any).excess_positive_rate =
        excessCount > 0
          ? Number(
              ((Number((item as any).excess_positive_count || 0) / excessCount) * 100).toFixed(2)
            )
          : 0;
    });

    return {
      total_signals: signals.length,
      by_decision: byDecision,
      horizon_summary: horizonSummary,
    };
  }

  async getPerformanceDashboard(options: SignalPerformanceOptions = {}) {
    const horizon = options.horizon || DEFAULT_PERFORMANCE_HORIZON;
    const limit = Math.min(Math.max(Number(options.limit || 1000), 1), 5000);
    const minSamples = Math.min(Math.max(Number(options.min_samples || 5), 1), 100);
    const signals = (await AIInvestmentSignal.findAll({
      where: buildSignalWhere(options),
      order: [
        ['signal_date', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit,
      raw: true,
    })) as any[];

    const completedSamples = extractCompletedReturnSamples(signals, horizon);
    const allCompletedSamples = extractCompletedReturnSamples(signals);
    const pending_signals = signals.filter(signal =>
      ['pending', 'partial'].includes(signal.verification_status || '')
    ).length;
    const no_data_signals = signals.filter(
      signal => signal.verification_status === 'no_data'
    ).length;
    const consensus_maturity = buildConsensusMaturity(signals, horizon);

    const overview = {
      total_signals: signals.length,
      pending_signals,
      no_data_signals,
      completed_samples: completedSamples.length,
      horizon,
      ...summarizeReturnSamples(completedSamples),
    };

    const groupedSummary = (keySelector: (sample: any) => string | undefined | null) => {
      const grouped = new Map<string, any[]>();
      for (const sample of completedSamples) {
        const key = keySelector(sample) || 'unknown';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(sample);
      }
      return [...grouped.entries()]
        .map(([key, samples]) => ({
          key,
          ...summarizeReturnSamples(samples),
        }))
        .sort((a, b) => b.count - a.count);
    };

    const horizon_summary = Object.entries(
      allCompletedSamples.reduce((acc: Record<string, any[]>, sample) => {
        if (!acc[sample.horizon]) acc[sample.horizon] = [];
        acc[sample.horizon].push(sample);
        return acc;
      }, {})
    )
      .map(([key, samples]) => ({
        horizon: key,
        horizon_days: Number(key.replace('d', '')),
        ...summarizeReturnSamples(samples as any[]),
      }))
      .sort((a, b) => a.horizon_days - b.horizon_days);

    const symbolMap = new Map<string, any[]>();
    for (const sample of completedSamples) {
      if (!symbolMap.has(sample.symbol)) symbolMap.set(sample.symbol, []);
      symbolMap.get(sample.symbol)!.push(sample);
    }

    const top_symbols = [...symbolMap.entries()]
      .map(([symbol, samples]) => {
        const first = samples[0];
        return {
          symbol,
          name: first?.name,
          latest_signal_date: samples
            .map(sample => sample.signal_date)
            .sort()
            .reverse()[0],
          ...summarizeReturnSamples(samples),
        };
      })
      .sort((a, b) => {
        if (b.avg_return_pct !== a.avg_return_pct) return b.avg_return_pct - a.avg_return_pct;
        return b.count - a.count;
      })
      .slice(0, 20);

    const recent_signals = completedSamples
      .sort((a, b) => String(b.signal_date).localeCompare(String(a.signal_date)))
      .slice(0, 30);

    const equitySamples = [...completedSamples].sort((a, b) => {
      const dateCompare = String(a.exit_date || a.signal_date).localeCompare(
        String(b.exit_date || b.signal_date)
      );
      if (dateCompare !== 0) return dateCompare;
      return Number(a.signal_id) - Number(b.signal_id);
    });
    let cumulative = 0;
    let peak = 0;
    const equity_curve = equitySamples.map(sample => {
      cumulative += Number(sample.return_pct || 0);
      peak = Math.max(peak, cumulative);
      return {
        date: sample.exit_date || sample.signal_date,
        signal_id: sample.signal_id,
        symbol: sample.symbol,
        return_pct: roundNumber(sample.return_pct, 4) ?? 0,
        cumulative_return_pct: roundNumber(cumulative, 4) ?? 0,
        drawdown_pct: roundNumber(cumulative - peak, 4) ?? 0,
      };
    });

    const buildBucketSummary = (
      bucketKey: string,
      label: string,
      filter: (sample: any) => boolean
    ) => buildQualityBucket(bucketKey, label, completedSamples.filter(filter), minSamples);

    const playbook = {
      horizon,
      min_samples: minSamples,
      overall: buildQualityBucket('overall', '整体信号', completedSamples, minSamples),
      buy_side: buildBucketSummary('buy_side', '买入侧建议', sample =>
        ['buy', 'strong_buy'].includes(sample.normalized_decision)
      ),
      sell_side: buildBucketSummary('sell_side', '卖出侧建议', sample =>
        ['sell', 'strong_sell'].includes(sample.normalized_decision)
      ),
      best_segments: [
        ...groupedSummary(sample => sample.source_type).map(item => ({
          dimension: 'source_type',
          label: sourceLabelForPerformance(item.key),
          ...item,
          quality_score: calculateQualityScore(item, minSamples),
          gate: classifyQualityGate(item, minSamples),
        })),
        ...groupedSummary(sample => sample.normalized_decision).map(item => ({
          dimension: 'decision',
          label: decisionLabelForPerformance(item.key),
          ...item,
          quality_score: calculateQualityScore(item, minSamples),
          gate: classifyQualityGate(item, minSamples),
        })),
        ...groupedSummary(sample => sample.consensus_bucket).map(item => ({
          dimension: 'consensus',
          label: consensusSignalBucketLabel(item.key),
          ...item,
          quality_score: calculateQualityScore(item, minSamples),
          gate: classifyQualityGate(item, minSamples),
        })),
      ]
        .filter(item => item.count > 0)
        .sort((a, b) => b.quality_score - a.quality_score)
        .slice(0, 8),
      risk_notes: [
        overview.pending_signals > 0
          ? `${overview.pending_signals} 条信号仍在等待后验周期，避免过早评判 Agent 优劣`
          : '',
        overview.no_data_signals > 0
          ? `${overview.no_data_signals} 条信号缺行情数据，需先修复数据再纳入决策`
          : '',
        signals.some(signal => ['low', 'critical'].includes(signal.metadata?.data_quality_bucket))
          ? '存在数据质量偏低的 Agent 研报，自动跟单前需降权或人工复核'
          : '',
        completedSamples.length > 0 && Math.abs(Number(overview.avg_mae_pct || 0)) > 6
          ? `平均 MAE ${roundNumber(overview.avg_mae_pct, 2)}%，建议降低单笔仓位或收紧止损`
          : '',
      ].filter(Boolean),
    };

    const generated_at = moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');

    return {
      generated_at,
      filters: {
        symbol: options.symbol,
        decision: options.decision,
        source_type: options.source_type,
        agent_session: options.agent_session,
        task_label: options.task_label,
        start_date: options.start_date,
        end_date: options.end_date,
        horizon,
        limit,
        min_samples: minSamples,
      },
      overview,
      playbook,
      by_decision: groupedSummary(sample => sample.normalized_decision),
      by_source_type: groupedSummary(sample => sample.source_type),
      by_risk_level: groupedSummary(sample => sample.risk_level),
      by_data_quality: groupedSummary(sample => sample.data_quality_bucket).map(item => ({
        ...item,
        label: dataQualityBucketLabel(item.key),
        quality_score: calculateQualityScore(item, minSamples),
        gate: classifyQualityGate(item, minSamples),
      })),
      by_consensus: groupedSummary(sample => sample.consensus_bucket).map(item => ({
        ...item,
        label: consensusSignalBucketLabel(item.key),
        quality_score: calculateQualityScore(item, minSamples),
        gate: classifyQualityGate(item, minSamples),
      })),
      consensus_maturity,
      horizon_summary,
      top_symbols,
      recent_signals,
      equity_curve,
    };
  }

  async getAgentTailAlphaLedger(options: AgentTailAlphaLedgerOptions = {}) {
    const primaryHorizon = options.horizon || DEFAULT_PERFORMANCE_HORIZON;
    const horizons = normalizeHorizonList(options.horizons);
    const lookbackDays = Math.min(Math.max(Number(options.lookback_days || 180), 1), 3650);
    const endDate = options.end_date || getChinaToday();
    const startDate =
      options.start_date || moment(endDate).subtract(lookbackDays, 'days').format('YYYY-MM-DD');
    const limit = Math.min(Math.max(Number(options.limit || 5000), 1), 10000);
    const minSamples = Math.min(Math.max(Number(options.min_samples || 5), 1), 100);
    const sourceType = options.source_type || AISignalSourceType.TRADING_AGENTS;
    const agentSession = options.agent_session || 'close';

    const signals = (await AIInvestmentSignal.findAll({
      where: buildSignalWhere({
        source_type: sourceType,
        agent_session: agentSession,
        decision: options.decision,
        symbol: options.symbol,
        task_label: options.task_label,
        loop_run_id: options.loop_run_id,
        start_date: startDate,
        end_date: endDate,
      }),
      order: [
        ['signal_date', 'DESC'],
        ['confidence_score', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit,
      raw: true,
    })) as any[];

    const allCompletedSamples = extractCompletedReturnSamples(signals);
    const primarySamples = allCompletedSamples.filter(sample => sample.horizon === primaryHorizon);
    const pendingSignals = signals.filter(signal =>
      ['pending', 'partial'].includes(signal.verification_status || '')
    ).length;
    const noDataSignals = signals.filter(signal => signal.verification_status === 'no_data').length;
    const completedSignalIds = new Set(primarySamples.map(sample => sample.signal_id));
    const overall = buildQualityBucket(
      'tail_agent_overall',
      `${agentSessionLabelForPerformance(agentSession)} Agent`,
      primarySamples,
      minSamples
    );

    const groupSamples = (
      samples: any[],
      keySelector: (sample: any) => string | undefined | null,
      labelSelector: (key: string) => string = value => value || 'unknown'
    ) => {
      const grouped = new Map<string, any[]>();
      for (const sample of samples) {
        const key = keySelector(sample) || 'unknown';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(sample);
      }
      return [...grouped.entries()]
        .map(([key, bucketSamples]) => {
          const summary = summarizeReturnSamples(bucketSamples);
          return {
            key,
            label: labelSelector(key),
            ...summary,
            quality_score: calculateQualityScore(summary, minSamples),
            gate: classifyQualityGate(summary, minSamples),
          };
        })
        .sort(
          (a, b) =>
            b.quality_score - a.quality_score ||
            b.avg_excess_return_pct - a.avg_excess_return_pct ||
            b.count - a.count
        );
    };

    const horizonSummary = horizons.map(horizon => {
      const samples = allCompletedSamples.filter(sample => sample.horizon === horizon);
      const summary = summarizeReturnSamples(samples);
      return {
        horizon,
        horizon_days: Number(horizon.replace('d', '')),
        ...summary,
        quality_score: calculateQualityScore(summary, minSamples),
        gate: classifyQualityGate(summary, minSamples),
      };
    });

    const byDecision = groupSamples(
      primarySamples,
      sample => sample.normalized_decision,
      decisionLabelForPerformance
    );
    const byRiskLevel = groupSamples(
      primarySamples,
      sample => sample.risk_level,
      value => {
        const labels: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险' };
        return labels[value] || value || 'unknown';
      }
    );
    const byConfidence = groupSamples(
      primarySamples,
      sample => confidenceBucket(sample.confidence_score),
      confidenceBucketLabel
    );
    const byMonth = groupSamples(
      primarySamples,
      sample => moment(sample.exit_date || sample.signal_date).format('YYYY-MM'),
      value => value
    ).sort((a, b) => String(a.key).localeCompare(String(b.key)));
    const bySymbol = groupSamples(
      primarySamples,
      sample => sample.symbol,
      value => {
        const found = primarySamples.find(sample => sample.symbol === value);
        return found?.name ? `${found.name}(${value})` : value || 'unknown';
      }
    );

    const portfolioSamples = [...primarySamples].sort((a, b) => {
      const dateCompare = String(a.exit_date || a.signal_date).localeCompare(
        String(b.exit_date || b.signal_date)
      );
      if (dateCompare !== 0) return dateCompare;
      return Number(a.signal_id) - Number(b.signal_id);
    });
    let cumulativeReturn = 0;
    let cumulativeExcess = 0;
    let peakReturn = 0;
    const portfolioCurve = portfolioSamples.map(sample => {
      const returnPct = Number(sample.directional_return_pct ?? sample.return_pct ?? 0);
      const excessPct = Number.isFinite(Number(sample.directional_excess_return_pct))
        ? Number(sample.directional_excess_return_pct)
        : Number.isFinite(Number(sample.excess_return_pct))
        ? Number(sample.excess_return_pct)
        : returnPct;
      cumulativeReturn += returnPct;
      cumulativeExcess += excessPct;
      peakReturn = Math.max(peakReturn, cumulativeReturn);
      return {
        date: sample.exit_date || sample.signal_date,
        signal_id: sample.signal_id,
        symbol: sample.symbol,
        name: sample.name,
        return_pct: roundNumber(returnPct, 4) ?? 0,
        excess_return_pct: roundNumber(excessPct, 4) ?? 0,
        cumulative_return_pct: roundNumber(cumulativeReturn, 4) ?? 0,
        cumulative_excess_return_pct: roundNumber(cumulativeExcess, 4) ?? 0,
        drawdown_pct: roundNumber(cumulativeReturn - peakReturn, 4) ?? 0,
      };
    });

    const latestRecommendations = signals.slice(0, 30).map(signal => {
      const horizonStatus = Object.fromEntries(
        horizons.map(horizon => {
          const item = signal.forward_returns?.horizons?.[horizon] || {};
          return [
            horizon,
            {
              status: item.status || 'pending',
              return_pct: item.return_pct,
              excess_return_pct: item.excess_return_pct,
              directional_return_pct: item.directional_return_pct,
              exit_date: item.exit_date,
            },
          ];
        })
      );
      return {
        signal_id: signal.id,
        symbol: signal.symbol,
        name: signal.name,
        signal_date: signal.signal_date,
        decision: signal.normalized_decision || signal.decision,
        confidence_score: toNumber(signal.confidence_score),
        risk_level: signal.risk_level,
        consensus_count: Number(signal.metadata?.consensus_count || 0),
        consensus_bonus: Number(signal.metadata?.consensus_bonus || 0),
        consensus_variants: Array.isArray(signal.metadata?.consensus_variants)
          ? signal.metadata.consensus_variants
          : [],
        recommendation_tier_label: signal.metadata?.recommendation_tier_label,
        rationale: String(signal.rationale || '').slice(0, 260),
        verification_status: signal.verification_status,
        completed_for_primary_horizon: completedSignalIds.has(signal.id),
        horizons: horizonStatus,
      };
    });

    const bestSymbols = bySymbol.filter(item => item.count > 0).slice(0, 8);
    const weakSymbols = [...bySymbol]
      .filter(item => item.count > 0)
      .sort(
        (a, b) =>
          a.quality_score - b.quality_score ||
          a.avg_excess_return_pct - b.avg_excess_return_pct ||
          b.count - a.count
      )
      .slice(0, 8);
    const bestHorizon = [...horizonSummary]
      .filter(item => item.count > 0)
      .sort((a, b) => b.quality_score - a.quality_score || b.count - a.count)[0];
    const gate = overall.gate;
    const action =
      gate.action === 'scale_up'
        ? 'agent_tail_scale_up'
        : gate.action === 'deprioritize'
        ? 'agent_tail_deprioritize'
        : gate.action === 'collect_more_samples'
        ? 'agent_tail_collect_samples'
        : 'agent_tail_watch';
    const insights = [
      `尾盘 Agent 在 ${primaryHorizon} 周期已完成 ${overall.count}/${
        signals.length
      } 个样本，平均收益 ${roundNumber(overall.avg_return_pct, 2)}%、平均超额 ${roundNumber(
        overall.avg_excess_return_pct,
        2
      )}%。`,
      `当前收益闸门：${gate.label}，建议仓位倍率 ${gate.position_multiplier}x，原因：${gate.reason}。`,
      bestHorizon
        ? `当前相对最优持有周期是 ${bestHorizon.horizon}，质量分 ${
            bestHorizon.quality_score
          }、平均超额 ${roundNumber(bestHorizon.avg_excess_return_pct, 2)}%。`
        : '尚无完成样本，先继续沉淀尾盘建议。',
      bestSymbols[0]
        ? `当前表现最好标的片段：${bestSymbols[0].label}，样本 ${
            bestSymbols[0].count
          }，平均超额 ${roundNumber(bestSymbols[0].avg_excess_return_pct, 2)}%。`
        : '',
      pendingSignals > 0 ? `${pendingSignals} 条尾盘建议仍在后验周期内，不纳入最终收益评判。` : '',
      noDataSignals > 0 ? `${noDataSignals} 条尾盘建议缺行情数据，建议先执行刷新/修复。` : '',
    ].filter(Boolean);

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      filters: {
        source_type: sourceType,
        agent_session: agentSession,
        primary_horizon: primaryHorizon,
        horizons,
        lookback_days: lookbackDays,
        start_date: startDate,
        end_date: endDate,
        limit,
        min_samples: minSamples,
      },
      summary: {
        total_signals: signals.length,
        pending_signals: pendingSignals,
        no_data_signals: noDataSignals,
        completed_primary_samples: primarySamples.length,
        completed_all_samples: allCompletedSamples.length,
        overall,
        best_horizon: bestHorizon || null,
        action,
        gate,
      },
      horizon_summary: horizonSummary,
      by_decision: byDecision,
      by_risk_level: byRiskLevel,
      by_confidence: byConfidence,
      by_month: byMonth,
      best_symbols: bestSymbols,
      weak_symbols: weakSymbols,
      portfolio_curve: portfolioCurve,
      latest_recommendations: latestRecommendations,
      insights,
      next_actions: [
        gate.action === 'scale_up'
          ? '尾盘 Agent 当前具备正期望，可仅对 BUY/STRONG_BUY 且风控通过的样本小幅放大模拟跟单。'
          : '',
        gate.action === 'deprioritize'
          ? '尾盘 Agent 当前跑输，应暂停自动放大，仅保留观察与数据收集。'
          : '',
        overall.count < minSamples
          ? `继续收集至少 ${minSamples - overall.count} 个完成样本后再评估是否放大。`
          : '',
        noDataSignals > 0 ? '执行尾盘账本刷新，先补齐缺失行情并重新验证收益。' : '',
        '持续对比 1/3/5/10/20 日持有收益，后续把最佳周期反哺给自动模拟盘持有期参数。',
      ].filter(Boolean),
    };
  }

  async refreshPerformance(
    options: {
      limit?: number;
      horizons?: number[];
      horizon?: string;
      report_to_feishu?: boolean;
      record_type?: string;
    } & SignalQueryOptions = {}
  ) {
    const metadataBackfill = await this.backfillAgentSessionMetadata({
      limit: options.limit || 1000,
      source_type: options.source_type,
      loop_run_id: options.loop_run_id,
    });
    const verification = await this.verifySignals({
      ...options,
      report_to_feishu: false,
    });
    const dashboard = await this.getPerformanceDashboard({
      symbol: options.symbol,
      decision: options.decision,
      source_type: options.source_type,
      agent_session: options.agent_session,
      task_label: options.task_label,
      loop_run_id: options.loop_run_id,
      start_date: options.start_date,
      end_date: options.end_date,
      horizon: options.horizon,
      limit: options.limit || 1000,
    });

    if (options.report_to_feishu) {
      const { feishuTaskReportService } = await import('./FeishuTaskReportService');
      await feishuTaskReportService.reportRecommendationPerformance({
        record_type: options.record_type || '推荐绩效刷新',
        source_type: options.source_type,
        agent_session: options.agent_session,
        result: verification,
        dashboard,
      });
    }

    return { verification, dashboard, metadata_backfill: metadataBackfill };
  }

  async getSignalQualityReport(options: SignalQualityReportOptions = {}) {
    const lookbackDays = Math.min(Math.max(Number(options.lookback_days || 30), 1), 3650);
    const endDate = options.end_date || getChinaToday();
    const startDate =
      options.start_date || moment(endDate).subtract(lookbackDays, 'days').format('YYYY-MM-DD');
    const horizon = options.horizon || DEFAULT_PERFORMANCE_HORIZON;
    const minSamples = Math.min(Math.max(Number(options.min_samples || 5), 1), 100);
    const limit = Math.min(Math.max(Number(options.limit || 5000), 1), 10000);
    const horizonDays = Number(String(horizon).replace(/[^\d]/g, '')) || 5;
    const includeDiagnosisDetails = Boolean(options.include_diagnosis_details);
    const diagnosisDetailLimit = Math.min(
      Math.max(Number(options.diagnosis_detail_limit ?? (includeDiagnosisDetails ? 100 : 0)), 0),
      500
    );
    const diagnosisOptions = {
      source_type: options.source_type,
      agent_session: options.agent_session,
      task_label: options.task_label,
      loop_run_id: options.loop_run_id,
      decision: options.decision,
      symbol: options.symbol,
      start_date: startDate,
      end_date: endDate,
      limit,
      horizons: [horizonDays],
      include_details: includeDiagnosisDetails,
      detail_limit: diagnosisDetailLimit,
    };

    let repairResult: any = null;
    let diagnosis = await this.diagnoseSignalVerification(diagnosisOptions);

    if (options.auto_repair_missing_data) {
      repairResult = await this.repairAndVerifySignals({
        ...diagnosisOptions,
        auto_sync_missing: true,
        data_source: options.data_source || 'tencent_only',
        lookback_days: Number(options.repair_lookback_days || options.lookback_days || 30),
        sync_concurrency: Number(options.sync_concurrency || 2),
      });
      diagnosis = repairResult.final_diagnosis || diagnosis;
    }

    if (options.verify_before_report) {
      await this.verifySignals({
        source_type: options.source_type,
        agent_session: options.agent_session,
        task_label: options.task_label,
        loop_run_id: options.loop_run_id,
        decision: options.decision,
        start_date: startDate,
        end_date: endDate,
        limit,
        report_to_feishu: false,
      });
      diagnosis = await this.diagnoseSignalVerification(diagnosisOptions);
    }

    const signals = (await AIInvestmentSignal.findAll({
      where: buildSignalWhere({
        source_type: options.source_type,
        agent_session: options.agent_session,
        task_label: options.task_label,
        loop_run_id: options.loop_run_id,
        decision: options.decision,
        symbol: options.symbol,
        start_date: startDate,
        end_date: endDate,
      }),
      order: [
        ['signal_date', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit,
      raw: true,
    })) as any[];

    const completedSamples = extractCompletedReturnSamples(signals, horizon);
    const allCompletedSamples = extractCompletedReturnSamples(signals);
    const pendingSignals = signals.filter(signal =>
      ['pending', 'partial'].includes(signal.verification_status || '')
    ).length;
    const noDataSignals = signals.filter(signal => signal.verification_status === 'no_data').length;
    const diagnosisSummary: any = diagnosis?.summary || {};
    const syncResult = repairResult?.sync_result || {};
    const syncedSymbols = Object.entries(syncResult);
    const insertedBars = syncedSymbols.reduce(
      (sum, [, count]) => (Number(count) > 0 ? sum + Number(count) : sum),
      0
    );
    const dataHealth = {
      total_signals: diagnosisSummary.total_signals ?? signals.length,
      verified_signals: diagnosisSummary.verified_signals ?? 0,
      pending_signals: diagnosisSummary.pending_signals ?? pendingSignals,
      no_data_signals: diagnosisSummary.no_data_signals ?? noDataSignals,
      missing_stock: diagnosisSummary.missing_stock ?? 0,
      missing_bars: diagnosisSummary.missing_bars ?? 0,
      waiting_for_market_data: diagnosisSummary.waiting_for_market_data ?? 0,
      insufficient_horizon_bars: diagnosisSummary.insufficient_horizon_bars ?? 0,
      invalid_entry_price: diagnosisSummary.invalid_entry_price ?? 0,
      ready_for_verification: diagnosisSummary.ready_for_verification ?? 0,
      symbols_need_sync: diagnosisSummary.symbols_need_sync ?? 0,
    };
    const repairSummary = repairResult
      ? {
          enabled: true,
          sync_window: repairResult.sync_window,
          synced_symbols: syncedSymbols.length,
          inserted_bars: insertedBars,
          verification: repairResult.verification,
          before: repairResult.initial_diagnosis?.summary,
          after: repairResult.final_diagnosis?.summary,
          remaining_symbols_need_sync: repairResult.final_diagnosis?.symbols_need_sync || [],
        }
      : {
          enabled: Boolean(options.auto_repair_missing_data),
          synced_symbols: 0,
          inserted_bars: 0,
        };

    const rankBuckets = (
      dimension: string,
      labeler: (key: string) => string,
      keySelector: (sample: any) => string | undefined | null
    ) => {
      const grouped = new Map<string, any[]>();
      for (const sample of completedSamples) {
        const key = keySelector(sample) || 'unknown';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(sample);
      }
      return [...grouped.entries()]
        .map(([key, samples]) => {
          const summary = summarizeReturnSamples(samples);
          return {
            dimension,
            key,
            label: labeler(key),
            ...summary,
            quality_score: calculateQualityScore(summary, minSamples),
            gate: classifyQualityGate(summary, minSamples),
          };
        })
        .sort((a, b) => {
          if (b.quality_score !== a.quality_score) return b.quality_score - a.quality_score;
          if (b.avg_return_pct !== a.avg_return_pct) return b.avg_return_pct - a.avg_return_pct;
          return b.count - a.count;
        });
    };

    const rankings = {
      by_source_type: rankBuckets(
        'source_type',
        sourceLabelForPerformance,
        sample => sample.source_type
      ),
      by_agent_session: rankBuckets(
        'agent_session',
        value => {
          const labels: Record<string, string> = { close: '尾盘', midday: '午盘', morning: '早盘' };
          return labels[value] || value || 'unknown';
        },
        sample => sample.agent_session
      ),
      by_decision: rankBuckets(
        'decision',
        decisionLabelForPerformance,
        sample => sample.normalized_decision
      ),
      by_risk_level: rankBuckets(
        'risk_level',
        value => value || 'unknown',
        sample => sample.risk_level
      ),
      by_data_quality: rankBuckets(
        'data_quality',
        dataQualityBucketLabel,
        sample => sample.data_quality_bucket
      ),
      by_symbol: rankBuckets(
        'symbol',
        value => {
          const sample = completedSamples.find(item => item.symbol === value);
          return sample?.name ? `${sample.name}(${value})` : value;
        },
        sample => sample.symbol
      ).slice(0, 20),
    };

    const allRanked = [
      ...rankings.by_source_type,
      ...rankings.by_agent_session,
      ...rankings.by_decision,
      ...rankings.by_risk_level,
      ...rankings.by_data_quality,
    ].filter(item => item.count > 0);
    const bestSegments = [...allRanked]
      .sort((a, b) => b.quality_score - a.quality_score)
      .slice(0, 8);
    const worstSegments = [...allRanked]
      .filter(item => item.count >= Math.min(minSamples, 3))
      .sort((a, b) => {
        if (a.quality_score !== b.quality_score) return a.quality_score - b.quality_score;
        return a.avg_return_pct - b.avg_return_pct;
      })
      .slice(0, 8);

    const horizonSummary = Object.entries(
      allCompletedSamples.reduce((acc: Record<string, any[]>, sample) => {
        if (!acc[sample.horizon]) acc[sample.horizon] = [];
        acc[sample.horizon].push(sample);
        return acc;
      }, {})
    )
      .map(([key, samples]) => ({
        horizon: key,
        horizon_days: Number(key.replace('d', '')),
        ...summarizeReturnSamples(samples as any[]),
      }))
      .sort((a, b) => a.horizon_days - b.horizon_days);

    const overall = summarizeReturnSamples(completedSamples);
    const overallBucket = {
      key: 'overall',
      label: '整体信号',
      ...overall,
      quality_score: calculateQualityScore(overall, minSamples),
      gate: classifyQualityGate(overall, minSamples),
    };

    const actionItems = [
      overallBucket.count < minSamples
        ? `完成样本 ${overallBucket.count}/${minSamples}，日报仅用于观察，不建议放大自动跟单。`
        : '',
      bestSegments[0]
        ? `优先关注 ${bestSegments[0].label}：质量分 ${bestSegments[0].quality_score}，均收 ${bestSegments[0].avg_return_pct}%。`
        : '',
      worstSegments[0]
        ? `降权复盘 ${worstSegments[0].label}：质量分 ${worstSegments[0].quality_score}，均收 ${worstSegments[0].avg_return_pct}%。`
        : '',
      pendingSignals > 0 ? `${pendingSignals} 条信号仍在等待后验周期，避免过早下结论。` : '',
      noDataSignals > 0 ? `${noDataSignals} 条信号缺行情，需优先修复数据。` : '',
      rankings.by_data_quality.some(item => ['low', 'critical'].includes(item.key))
        ? '发现低可信 Agent 研报，自动跟单应保持降权，优先复核数据缺口。'
        : '',
      repairResult
        ? `本次自动修复同步 ${
            syncedSymbols.length
          } 只股票，新增/尝试写入 ${insertedBars} 条K线，修复后 no_data ${
            repairResult.final_diagnosis?.summary?.no_data_signals ?? 0
          } 条。`
        : '',
    ].filter(Boolean);

    const report = {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      filters: {
        start_date: startDate,
        end_date: endDate,
        lookback_days: lookbackDays,
        horizon,
        min_samples: minSamples,
        limit,
        source_type: options.source_type,
        agent_session: options.agent_session,
        task_label: options.task_label,
        decision: options.decision,
        auto_repair_missing_data: Boolean(options.auto_repair_missing_data),
        data_source: options.data_source,
      },
      overview: {
        total_signals: signals.length,
        pending_signals: pendingSignals,
        no_data_signals: noDataSignals,
        completed_samples: completedSamples.length,
        ...overallBucket,
      },
      data_health: dataHealth,
      repair_summary: repairSummary,
      diagnosis: {
        ...diagnosis,
        details: includeDiagnosisDetails
          ? (diagnosis?.details || []).slice(0, diagnosisDetailLimit)
          : [],
      },
      rankings,
      best_segments: bestSegments,
      worst_segments: worstSegments,
      horizon_summary: horizonSummary,
      action_items: actionItems,
    };

    if (options.report_to_feishu) {
      const { feishuTaskReportService } = await import('./FeishuTaskReportService');
      await feishuTaskReportService.reportSignalQualityDaily(report, {
        record_type: options.record_type || '信号质量日报',
      });
    }

    return report;
  }
}

export const aiInvestmentSignalService = new AIInvestmentSignalService();
