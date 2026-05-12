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
import type { QuantRecommendationItem } from './QuantRecommendationService';

const DEFAULT_HORIZONS = [1, 3, 5, 10, 20];
const DEFAULT_PERFORMANCE_HORIZON = '5d';

export interface SignalQueryOptions {
  symbol?: string;
  decision?: string;
  source_type?: string;
  agent_session?: string;
  task_label?: string;
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

export interface SignalQualityReportOptions extends SignalPerformanceOptions {
  lookback_days?: number;
  report_to_feishu?: boolean;
  record_type?: string;
  verify_before_report?: boolean;
}

export interface SignalVerificationDiagnosisOptions extends SignalQueryOptions {
  horizons?: number[];
  limit?: number;
  auto_sync_missing?: boolean;
  data_source?: string;
  lookback_days?: number;
  sync_concurrency?: number;
}

export interface QuantRecommendationArchiveOptions {
  candidates: QuantRecommendationItem[];
  universe?: string;
  style?: string;
  as_of?: string;
  signal_date?: string;
}

export interface TradingAgentsStructuredDecision {
  rating: string;
  normalized_decision: string;
  summary?: string;
  thesis?: string;
  confidence_score?: number;
  risk_level?: string;
  action_tags: string[];
  key_levels: {
    stop_loss?: number;
    take_profit?: number;
    entry?: number;
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

function directionalReturn(returnPct: number, decision?: string): number {
  const side = getSignalSide(decision);
  if (side === 'short') return -returnPct;
  if (side === 'neutral') return -Math.abs(returnPct);
  return returnPct;
}

function summarizeReturnSamples(samples: any[]) {
  const completedSamples = samples.filter(sample => Number.isFinite(Number(sample.return_pct)));
  const returns = completedSamples.map(sample => Number(sample.return_pct));
  const directionalReturns = completedSamples.map(sample =>
    Number.isFinite(Number(sample.directional_return_pct))
      ? Number(sample.directional_return_pct)
      : directionalReturn(Number(sample.return_pct), sample.normalized_decision)
  );
  const wins = returns.filter(value => value > 0);
  const losses = returns.filter(value => value < 0);
  const directionalWins = directionalReturns.filter(value => value > 0);
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
      });
    }
  }

  return samples;
}

function calculateQualityScore(summary: any, minSamples = 5): number {
  if (!summary || !summary.count) return 0;
  const avgReturnScore = Math.max(-20, Math.min(35, Number(summary.avg_return_pct || 0) * 5));
  const directionalScore =
    (Math.max(0, Math.min(100, Number(summary.directional_success_rate || 0))) - 50) * 0.45;
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
  const avgReturn = Number(summary?.avg_return_pct || 0);
  const directionalSuccessRate = Number(summary?.directional_success_rate || 0);
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

    const confidence_score =
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
      confidence_score,
      risk_level,
      action_tags,
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

    const payload = {
      source_type,
      source_id,
      symbol,
      name: stock?.name,
      signal_date,
      decision: decisionText.slice(0, 100),
      normalized_decision: normalizedDecision,
      confidence_score: params.confidence_score ?? structured.confidence_score,
      risk_level: structured.risk_level || this.inferRiskLevel(params),
      rationale: params.rationale || structured.summary,
      detail: detailText,
      current_price: params.current_price,
      price_change_pct: params.price_change_pct,
      metadata: mergeMetadata(undefined, {
        task_id: params.task_id,
        task_label: params.task_label,
        agent_session,
        is_tail_session: agent_session === 'close',
        structured_decision: structured,
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

  async backfillAgentSessionMetadata(options: { limit?: number; source_type?: string } = {}) {
    const limit = Math.min(Math.max(Number(options.limit || 2000), 1), 10000);
    const signals = await AIInvestmentSignal.findAll({
      where: options.source_type ? { source_type: options.source_type } : {},
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
          source: candidate.source,
          rating: candidate.rating,
          confidence: candidate.confidence,
          action: candidate.action,
          action_label: candidate.action_label,
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
    const missingSymbols = new Set<string>();
    const summary = {
      total_signals: signals.length,
      verified_signals: 0,
      pending_signals: 0,
      no_data_signals: 0,
      missing_stock: 0,
      missing_bars: 0,
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
        details.push(item);
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
        }
        details.push(item);
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

      details.push(item);
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
        start_date: options.start_date,
        end_date: options.end_date,
        limit,
        horizons,
      },
      summary,
      symbols_need_sync: Array.from(missingSymbols),
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
          horizonSummary[key] = { count: 0, avg_return_pct: 0, positive_count: 0 };
        }
        horizonSummary[key].count++;
        horizonSummary[key].avg_return_pct += Number(value.return_pct || 0);
        if (Number(value.return_pct || 0) > 0) {
          horizonSummary[key].positive_count++;
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
      horizon_summary,
      top_symbols,
      recent_signals,
      equity_curve,
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

    if (options.verify_before_report) {
      await this.verifySignals({
        source_type: options.source_type,
        agent_session: options.agent_session,
        task_label: options.task_label,
        decision: options.decision,
        start_date: startDate,
        end_date: endDate,
        limit,
        report_to_feishu: false,
      });
    }

    const signals = (await AIInvestmentSignal.findAll({
      where: buildSignalWhere({
        source_type: options.source_type,
        agent_session: options.agent_session,
        task_label: options.task_label,
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
      },
      overview: {
        total_signals: signals.length,
        pending_signals: pendingSignals,
        no_data_signals: noDataSignals,
        completed_samples: completedSamples.length,
        ...overallBucket,
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
