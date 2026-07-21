import moment from 'moment-timezone';
import { DailyBar } from '../models/DailyBar';
import { AIStockAnalysisReport } from '../models/AIStockAnalysisReport';
import { RealtimeQuote } from '../models/RealtimeQuote';
import { Stock } from '../models/Stock';
import { realtimeQuoteService } from '../data/services/RealtimeQuoteService';
import { logger } from '../utils/logger';
import {
  AIAdvisorService,
  AnalysisDimension,
  AnalyzeSingleStockResult,
  aiAdvisorService,
  buildResultFromPayload,
  RemoteAnalyzePayload,
} from './AIAdvisorService';

export type AIPriceDecisionPositionState = 'watching' | 'holding';
export type AIPriceFreshness = 'live' | 'same_day' | 'previous_close' | 'stale';

export interface AIPriceDecisionBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface AIPriceMarketSnapshot {
  stock_code: string;
  stock_name: string | null;
  current_price: number;
  change_percent: number | null;
  previous_close: number | null;
  day_open: number | null;
  day_high: number | null;
  day_low: number | null;
  quote_time: string;
  quote_source: string;
  quote_age_minutes: number;
  freshness: AIPriceFreshness;
  refresh_error: string | null;
  recent_bars: AIPriceDecisionBar[];
}

export interface AIPriceDecisionIndicators {
  atr_14: number;
  support_20: number | null;
  resistance_20: number | null;
  sma_20: number | null;
  volatility_20: number | null;
  bars_used: number;
}

export interface AIPriceDecisionPlan {
  action: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell' | 'unknown';
  action_label: string;
  position_action: 'open' | 'maintain' | 'close' | 'avoid';
  position_action_label: string;
  current_price: number;
  entry_zone: [number, number] | null;
  sell_zone: [number, number];
  stop_loss: number | null;
  take_profit: number | null;
  suggested_position_pct: number | null;
  planned_capital: number | null;
  planned_position_value: number | null;
  suggested_shares: number | null;
  holding_cost: number | null;
  holding_pnl_pct: number | null;
  risk_reward_ratio: number | null;
  support_level: number | null;
  resistance_level: number | null;
  atr_14: number;
  volatility_20: number | null;
  execution_ready: boolean;
  execution_note: string;
  decision_basis: string[];
  risk_warnings: string[];
  model: 'tradingagents_price_v1';
}

export interface AIPriceDecisionResult extends AnalyzeSingleStockResult {
  market_snapshot: Omit<AIPriceMarketSnapshot, 'recent_bars'> | null;
  price_decision: AIPriceDecisionPlan | null;
}

export interface AIPriceDecisionOptions {
  dimensions?: AnalysisDimension[];
  target_date?: string;
  user_id?: number;
  stock_name?: string;
  task_label?: string;
  dry_run?: boolean;
  refresh_quote?: boolean;
  position_state?: AIPriceDecisionPositionState;
  planned_capital?: number;
  holding_cost?: number;
}

export interface AIPriceDecisionTaskResult extends AIPriceDecisionResult {
  task_phase: 'pending' | 'processing' | 'completed' | 'failed';
  elapsed_time: number;
}

export interface AIPriceDecisionDataSource {
  loadMarketSnapshot(
    stock_code: string,
    options: { refresh_quote: boolean }
  ): Promise<AIPriceMarketSnapshot | null>;
  enrichReport(report_id: string, metadata: Record<string, unknown>): Promise<void>;
  loadReportByTask(task_id: string, user_id: number): Promise<AnalyzeSingleStockResult | null>;
  finalizeReport(result: AnalyzeSingleStockResult): Promise<void>;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function roundPrice(value: number): number {
  return Math.max(0.01, Math.round(value * 100) / 100);
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function localDate(iso: string): string {
  return moment(iso).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function safeIsoTime(value: unknown, fallback: Date): string {
  const parsed = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

export function selectAIPriceMarketSource(input: {
  quote_price: unknown;
  quote_time?: unknown;
  quote_source?: unknown;
  bar_price: unknown;
  bar_time?: unknown;
  stock_price: unknown;
  stock_updated_at?: unknown;
  now?: Date;
}): {
  current_price: number;
  quote_time: string;
  quote_source: string;
  using_quote: boolean;
} | null {
  const now = input.now || new Date();
  const quotePrice = positiveNumber(input.quote_price);
  if (quotePrice !== null) {
    return {
      current_price: quotePrice,
      quote_time: safeIsoTime(input.quote_time, now),
      quote_source: String(input.quote_source || 'realtime_quote'),
      using_quote: true,
    };
  }

  const barPrice = positiveNumber(input.bar_price);
  if (barPrice !== null) {
    return {
      current_price: barPrice,
      quote_time: safeIsoTime(input.bar_time, now),
      quote_source: 'daily_bar',
      using_quote: false,
    };
  }

  const stockPrice = positiveNumber(input.stock_price);
  if (stockPrice === null) return null;
  return {
    current_price: stockPrice,
    quote_time: safeIsoTime(input.stock_updated_at, now),
    quote_source: 'stock_snapshot',
    using_quote: false,
  };
}

export function classifyAIPriceFreshness(
  quote_time: string,
  now: Date = new Date()
): { freshness: AIPriceFreshness; quote_age_minutes: number } {
  const quote = new Date(quote_time);
  const age = Number.isNaN(quote.getTime())
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.round((now.getTime() - quote.getTime()) / 60_000));
  const sameDay = Number.isFinite(age) && localDate(quote_time) === localDate(now.toISOString());
  const freshness: AIPriceFreshness =
    age <= 20 ? 'live' : sameDay ? 'same_day' : age <= 96 * 60 ? 'previous_close' : 'stale';
  return {
    freshness,
    quote_age_minutes: Number.isFinite(age) ? age : 999_999,
  };
}

export function calculateAIPriceIndicators(
  market: Pick<AIPriceMarketSnapshot, 'current_price' | 'change_percent' | 'recent_bars'>
): AIPriceDecisionIndicators {
  const bars = (market.recent_bars || [])
    .map(bar => ({
      ...bar,
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
    }))
    .filter(
      bar =>
        Number.isFinite(bar.high) &&
        Number.isFinite(bar.low) &&
        Number.isFinite(bar.close) &&
        bar.high > 0 &&
        bar.low > 0 &&
        bar.close > 0
    )
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const trueRanges: number[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = index > 0 ? bars[index - 1].close : bar.close;
    trueRanges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previousClose),
        Math.abs(bar.low - previousClose)
      )
    );
  }
  const atrValues = trueRanges.slice(-14);
  const fallbackAtr =
    market.current_price *
    Math.max(0.02, Math.min(0.08, Math.abs(Number(market.change_percent || 0)) / 100));
  const rawAtr = atrValues.length
    ? atrValues.reduce((sum, item) => sum + item, 0) / atrValues.length
    : fallbackAtr;
  const atr14 = Math.max(
    market.current_price * 0.01,
    Math.min(market.current_price * 0.12, rawAtr)
  );

  const last20 = bars.slice(-20);
  const support = last20.length ? Math.min(...last20.map(bar => bar.low)) : null;
  const resistance = last20.length ? Math.max(...last20.map(bar => bar.high)) : null;
  const sma20 = last20.length
    ? last20.reduce((sum, bar) => sum + bar.close, 0) / last20.length
    : null;
  const returns: number[] = [];
  for (let index = Math.max(1, bars.length - 20); index < bars.length; index += 1) {
    const previous = bars[index - 1].close;
    if (previous > 0) returns.push(bars[index].close / previous - 1);
  }
  let volatility: number | null = null;
  if (returns.length >= 2) {
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance =
      returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    volatility = Math.sqrt(Math.max(0, variance));
  }

  return {
    atr_14: roundPrice(atr14),
    support_20: support === null ? null : roundPrice(support),
    resistance_20: resistance === null ? null : roundPrice(resistance),
    sma_20: sma20 === null ? null : roundPrice(sma20),
    volatility_20: volatility === null ? null : round(volatility),
    bars_used: bars.length,
  };
}

function normalizeConfidence(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

function hasHighRisk(risk_level: string | null): boolean {
  const text = String(risk_level || '').toLowerCase();
  return /高|high|critical|极高/.test(text);
}

function actionPresentation(
  recommendation: string,
  position_state: AIPriceDecisionPositionState
): Pick<
  AIPriceDecisionPlan,
  'action' | 'action_label' | 'position_action' | 'position_action_label'
> {
  if (recommendation === 'strong_buy') {
    return {
      action: 'strong_buy',
      action_label: position_state === 'holding' ? '回踩可加仓' : '分批买入',
      position_action: 'open',
      position_action_label: position_state === 'holding' ? '仅回踩加仓' : '建议分批建仓',
    };
  }
  if (recommendation === 'buy') {
    return {
      action: 'buy',
      action_label: position_state === 'holding' ? '持有并等回踩' : '逢低试仓',
      position_action: 'open',
      position_action_label: position_state === 'holding' ? '持有，回踩再加' : '小仓位试仓',
    };
  }
  if (recommendation === 'sell' || recommendation === 'strong_sell') {
    return {
      action: recommendation,
      action_label: position_state === 'holding' ? '减仓 / 卖出' : '暂不参与',
      position_action: position_state === 'holding' ? 'close' : 'avoid',
      position_action_label: position_state === 'holding' ? '建议分批退出' : '不建议新开仓',
    };
  }
  if (recommendation === 'hold') {
    return {
      action: 'hold',
      action_label: position_state === 'holding' ? '持有观察' : '等待回踩',
      position_action: position_state === 'holding' ? 'maintain' : 'avoid',
      position_action_label: position_state === 'holding' ? '维持当前仓位' : '等待更好价格',
    };
  }
  return {
    action: 'unknown',
    action_label: '等待更多证据',
    position_action: position_state === 'holding' ? 'maintain' : 'avoid',
    position_action_label: position_state === 'holding' ? '暂不调整仓位' : '暂不建仓',
  };
}

export function buildAIPriceDecisionPlan(input: {
  recommendation: string;
  confidence_score: number | null;
  risk_level: string | null;
  market: AIPriceMarketSnapshot;
  position_state?: AIPriceDecisionPositionState;
  planned_capital?: number;
  holding_cost?: number;
}): AIPriceDecisionPlan {
  const positionState = input.position_state === 'holding' ? 'holding' : 'watching';
  const price = input.market.current_price;
  const indicators = calculateAIPriceIndicators(input.market);
  const atr = indicators.atr_14;
  const supportCandidate =
    indicators.support_20 !== null &&
    indicators.support_20 <= price &&
    indicators.support_20 >= price - atr * 2.8
      ? indicators.support_20
      : null;
  const buyCenter = supportCandidate ?? price - atr * 0.55;
  const entryLow = roundPrice(Math.max(price - atr * 1.25, buyCenter - atr * 0.3));
  const entryHigh = roundPrice(Math.min(price, buyCenter + atr * 0.3));
  const entryZone: [number, number] = [
    Math.min(entryLow, entryHigh),
    Math.max(entryLow, entryHigh),
  ];

  const recommendation = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'].includes(
    input.recommendation
  )
    ? input.recommendation
    : 'unknown';
  const presentation = actionPresentation(recommendation, positionState);
  const isSell = recommendation === 'sell' || recommendation === 'strong_sell';
  const resistanceCandidate =
    indicators.resistance_20 !== null &&
    indicators.resistance_20 >= price + atr * 0.45 &&
    indicators.resistance_20 <= price + atr * 4
      ? indicators.resistance_20
      : null;
  const sellCenter = isSell ? price : resistanceCandidate ?? price + atr * 1.8;
  const sellLow = roundPrice(
    Math.max(isSell ? price - atr * 0.12 : price + atr * 0.45, sellCenter - atr * 0.25)
  );
  const sellHigh = roundPrice(Math.max(sellLow + 0.01, sellCenter + atr * 0.25));
  const sellZone: [number, number] = [sellLow, sellHigh];
  const stopLoss = roundPrice(Math.min(entryZone[0] - atr * 0.45, price - atr * 1.25));
  const effectiveEntry = (entryZone[0] + entryZone[1]) / 2;
  const effectiveTarget = (sellZone[0] + sellZone[1]) / 2;
  const downside = effectiveEntry - stopLoss;
  const riskReward =
    downside > 0 ? Math.max(0, (effectiveTarget - effectiveEntry) / downside) : null;

  const confidence = normalizeConfidence(input.confidence_score);
  let positionPct = recommendation === 'strong_buy' ? 0.12 : recommendation === 'buy' ? 0.08 : null;
  if (positionPct !== null) {
    if (confidence === null) positionPct *= 0.75;
    else if (confidence < 0.55) positionPct *= 0.5;
    else if (confidence < 0.7) positionPct *= 0.75;
    if (indicators.volatility_20 !== null && indicators.volatility_20 > 0.04) positionPct *= 0.5;
    else if (indicators.volatility_20 !== null && indicators.volatility_20 > 0.025)
      positionPct *= 0.75;
    if (hasHighRisk(input.risk_level)) positionPct *= 0.5;
    if (indicators.bars_used < 20) positionPct *= 0.5;
    positionPct = Math.max(0.01, Math.min(0.15, Math.round(positionPct * 200) / 200));
  }

  const plannedCapital = positiveNumber(input.planned_capital);
  const plannedValue =
    plannedCapital !== null && positionPct !== null ? plannedCapital * positionPct : null;
  const suggestedShares =
    plannedValue !== null ? Math.floor(plannedValue / price / 100) * 100 : null;
  const holdingCost = positiveNumber(input.holding_cost);
  const holdingPnl = holdingCost !== null ? price / holdingCost - 1 : null;
  const executionReady =
    input.market.freshness !== 'stale' &&
    indicators.bars_used >= 10 &&
    recommendation !== 'unknown';
  const riskWarnings: string[] = [];
  if (input.market.freshness === 'stale') riskWarnings.push('行情已过期，价格刷新前不要据此下单。');
  else if (input.market.freshness === 'previous_close')
    riskWarnings.push('当前为上一交易日收盘价，开盘后需重新确认。');
  else if (input.market.freshness === 'same_day')
    riskWarnings.push('当前为当日延迟行情，不是逐笔实时成交价。');
  if (input.market.refresh_error)
    riskWarnings.push(`实时行情刷新失败，已使用缓存：${input.market.refresh_error}`);
  if (indicators.bars_used < 20)
    riskWarnings.push(`仅有 ${indicators.bars_used} 根有效日线，区间可信度已降级。`);
  if (recommendation === 'unknown')
    riskWarnings.push('TradingAgents 未给出明确方向，本次只展示观察价位。');
  if (indicators.volatility_20 !== null && indicators.volatility_20 > 0.04) {
    riskWarnings.push('近 20 日波动率较高，建议减半仓位并避免追价。');
  }
  if (hasHighRisk(input.risk_level))
    riskWarnings.push('TradingAgents 标记为高风险，仓位上限已折半。');
  riskWarnings.push('价格区间由历史波动与支撑压力测算，不保证成交或收益。');

  const basis = [
    `TradingAgents 方向：${presentation.action_label}`,
    `现价 ¥${price.toFixed(2)}，ATR(14) ¥${atr.toFixed(2)}`,
  ];
  if (indicators.support_20 !== null)
    basis.push(`20 日支撑约 ¥${indicators.support_20.toFixed(2)}`);
  if (indicators.resistance_20 !== null)
    basis.push(`20 日压力约 ¥${indicators.resistance_20.toFixed(2)}`);

  return {
    ...presentation,
    current_price: roundPrice(price),
    entry_zone: isSell ? null : entryZone,
    sell_zone: sellZone,
    stop_loss: isSell && positionState === 'watching' ? null : stopLoss,
    take_profit: isSell ? null : roundPrice(effectiveTarget),
    suggested_position_pct: positionPct,
    planned_capital: plannedCapital,
    planned_position_value: plannedValue === null ? null : round(plannedValue, 2),
    suggested_shares: suggestedShares !== null && suggestedShares > 0 ? suggestedShares : null,
    holding_cost: holdingCost,
    holding_pnl_pct: holdingPnl === null ? null : round(holdingPnl),
    risk_reward_ratio: riskReward === null ? null : round(riskReward, 2),
    support_level: indicators.support_20,
    resistance_level: indicators.resistance_20,
    atr_14: indicators.atr_14,
    volatility_20: indicators.volatility_20,
    execution_ready: executionReady,
    execution_note: executionReady
      ? input.market.freshness === 'previous_close'
        ? '可用于下一交易日计划，开盘后须按新价格复核。'
        : '行情与历史数据可用，仍请使用限价单并自行确认风险。'
      : '当前数据不足以形成可执行下单建议，请等待行情刷新或补齐历史数据。',
    decision_basis: basis,
    risk_warnings: riskWarnings,
    model: 'tradingagents_price_v1',
  };
}

class ProductionAIPriceDecisionDataSource implements AIPriceDecisionDataSource {
  async loadMarketSnapshot(
    stock_code: string,
    options: { refresh_quote: boolean }
  ): Promise<AIPriceMarketSnapshot | null> {
    let refreshError: string | null = null;
    if (options.refresh_quote) {
      try {
        await realtimeQuoteService.syncQuotesForSymbols([stock_code], {
          source: 'auto',
          batch_size: 1,
        });
      } catch (error: any) {
        refreshError = String(error?.message || error).slice(0, 500);
        logger.warn(`[AIPriceDecision] refresh quote failed ${stock_code}: ${refreshError}`);
      }
    }

    const stock = await Stock.findOne({ where: { symbol: stock_code } });
    if (!stock) return null;
    const [quote, dailyBars] = await Promise.all([
      RealtimeQuote.findOne({ where: { symbol: stock_code }, order: [['quote_time', 'DESC']] }),
      DailyBar.findAll({
        where: { stock_id: stock.id },
        order: [['time', 'DESC']],
        limit: 60,
      }),
    ]);
    const bars = dailyBars
      .map(bar => ({
        time: new Date(bar.time).toISOString(),
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
      }))
      .filter(bar => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
      .reverse();
    const latestBar = bars[bars.length - 1];
    const previousBar = bars[bars.length - 2];
    const selectedSource = selectAIPriceMarketSource({
      quote_price: quote?.current_price,
      quote_time: quote?.quote_time,
      quote_source: quote?.source,
      bar_price: latestBar?.close,
      bar_time: latestBar?.time,
      stock_price: stock.price,
      stock_updated_at: stock.updated_at,
    });
    if (!selectedSource) return null;

    const currentPrice = selectedSource.current_price;
    const freshness = classifyAIPriceFreshness(selectedSource.quote_time);
    const raw = quote?.raw_payload || {};
    const barChangePercent =
      latestBar?.close > 0 && previousBar?.close > 0
        ? (latestBar.close / previousBar.close - 1) * 100
        : null;
    return {
      stock_code,
      stock_name: stock.name || quote?.name || null,
      current_price: currentPrice,
      change_percent: selectedSource.using_quote
        ? finiteNumber(quote?.change_percent)
        : finiteNumber(barChangePercent ?? stock.change_percent),
      previous_close: selectedSource.using_quote
        ? positiveNumber(raw.previous_close ?? previousBar?.close)
        : positiveNumber(previousBar?.close),
      day_open: positiveNumber(selectedSource.using_quote ? quote?.open : latestBar?.open),
      day_high: positiveNumber(selectedSource.using_quote ? quote?.high : latestBar?.high),
      day_low: positiveNumber(selectedSource.using_quote ? quote?.low : latestBar?.low),
      quote_time: selectedSource.quote_time,
      quote_source: selectedSource.quote_source,
      quote_age_minutes: freshness.quote_age_minutes,
      freshness: freshness.freshness,
      refresh_error: refreshError,
      recent_bars: bars,
    };
  }

  async enrichReport(report_id: string, metadata: Record<string, unknown>): Promise<void> {
    await AIStockAnalysisReport.update({ metadata }, { where: { report_id } });
  }

  async loadReportByTask(
    task_id: string,
    user_id: number
  ): Promise<AnalyzeSingleStockResult | null> {
    const row = await AIStockAnalysisReport.findOne({ where: { task_id, user_id } });
    if (!row) return null;
    const plain = row.get({ plain: true }) as any;
    return {
      report_id: plain.report_id,
      stock_code: plain.stock_code,
      stock_name: plain.stock_name,
      dimensions: Array.isArray(plain.dimensions) ? plain.dimensions : [],
      summary: plain.summary || '',
      recommendation: plain.recommendation || 'unknown',
      confidence_score:
        plain.confidence_score === null || plain.confidence_score === undefined
          ? null
          : Number(plain.confidence_score),
      risk_level: plain.risk_level || null,
      key_points:
        plain.key_points_json && typeof plain.key_points_json === 'object'
          ? plain.key_points_json
          : {},
      status: plain.status,
      task_id: plain.task_id,
      target_date: plain.target_date,
      error: plain.error || null,
      generated_at: new Date(plain.generated_at).toISOString(),
      metadata: plain.metadata && typeof plain.metadata === 'object' ? plain.metadata : {},
      persisted: true,
    } as AnalyzeSingleStockResult;
  }

  async finalizeReport(result: AnalyzeSingleStockResult): Promise<void> {
    await AIStockAnalysisReport.update(
      {
        summary: result.summary,
        recommendation: result.recommendation,
        confidence_score: result.confidence_score,
        risk_level: result.risk_level,
        key_points_json: result.key_points,
        status: result.status,
        task_id: result.task_id,
        target_date: result.target_date,
        error: result.error,
        generated_at: new Date(result.generated_at),
        metadata: result.metadata,
      },
      { where: { report_id: result.report_id } }
    );
  }
}

export const PRODUCTION_AI_PRICE_DECISION_DATA_SOURCE: AIPriceDecisionDataSource =
  new ProductionAIPriceDecisionDataSource();

function publicMarketSnapshot(
  market: AIPriceMarketSnapshot | null
): Omit<AIPriceMarketSnapshot, 'recent_bars'> | null {
  if (!market) return null;
  const snapshot: Partial<AIPriceMarketSnapshot> = { ...market };
  delete snapshot.recent_bars;
  return snapshot as Omit<AIPriceMarketSnapshot, 'recent_bars'>;
}

export class AIPriceDecisionService {
  constructor(
    private readonly analysis_service: Pick<
      AIAdvisorService,
      'analyzeSingleStock' | 'getTaskStatus'
    > = aiAdvisorService,
    private readonly data_source: AIPriceDecisionDataSource = PRODUCTION_AI_PRICE_DECISION_DATA_SOURCE
  ) {}

  async analyze(
    stock_code: string,
    options: AIPriceDecisionOptions = {}
  ): Promise<AIPriceDecisionResult> {
    const [analysis, market] = await Promise.all([
      this.analysis_service.analyzeSingleStock(stock_code, {
        dimensions: options.dimensions,
        target_date: options.target_date,
        user_id: options.user_id,
        stock_name: options.stock_name,
        dry_run: options.dry_run,
        task_label: options.task_label || 'ai_price_decision',
      }),
      this.data_source
        .loadMarketSnapshot(stock_code, { refresh_quote: options.refresh_quote !== false })
        .catch((error: any) => {
          logger.warn(
            `[AIPriceDecision] market snapshot failed ${stock_code}: ${error?.message || error}`
          );
          return null;
        }),
    ]);

    const plan =
      market && (analysis.status === 'completed' || analysis.status === 'partial')
        ? buildAIPriceDecisionPlan({
            recommendation: analysis.recommendation,
            confidence_score: analysis.confidence_score,
            risk_level: analysis.risk_level,
            market,
            position_state: options.position_state,
            planned_capital: options.planned_capital,
            holding_cost: options.holding_cost,
          })
        : null;
    const snapshot = publicMarketSnapshot(market);
    const metadata: Record<string, unknown> = {
      ...(analysis.metadata || {}),
      price_decision_version: 'tradingagents_price_v1',
      position_state: options.position_state === 'holding' ? 'holding' : 'watching',
      market_snapshot: snapshot,
      price_decision: plan,
      ...(plan
        ? {
            action: plan.action,
            entry_zone: plan.entry_zone,
            sell_zone: plan.sell_zone,
            stop_loss: plan.stop_loss,
            take_profit: plan.take_profit,
            suggested_position_pct: plan.suggested_position_pct,
            position_action: plan.position_action,
            risk_warnings: plan.risk_warnings,
            current_price: plan.current_price,
            quote_time: snapshot?.quote_time || null,
            price_source: snapshot?.quote_source || null,
          }
        : {}),
    };
    const result: AIPriceDecisionResult = {
      ...analysis,
      metadata,
      market_snapshot: snapshot,
      price_decision: plan,
    };

    if (analysis.persisted && !options.dry_run) {
      try {
        await this.data_source.enrichReport(analysis.report_id, metadata);
      } catch (error: any) {
        logger.warn(
          `[AIPriceDecision] enrich report failed report_id=${analysis.report_id}: ${
            error?.message || error
          }`
        );
        result.metadata = {
          ...metadata,
          price_decision_persist_error: String(error?.message || error),
        };
      }
    }
    return result;
  }

  /**
   * 只提交长耗时 TradingAgents 任务。接口返回后浏览器即可关闭配置弹窗；
   * 价格与仓位参数跟 pending report 一起持久化，后续任何页面实例都能继续轮询。
   */
  async submitAsync(
    stock_code: string,
    options: AIPriceDecisionOptions & { user_id: number }
  ): Promise<AIPriceDecisionTaskResult> {
    const analysis = await this.analysis_service.analyzeSingleStock(stock_code, {
      dimensions: options.dimensions,
      target_date: options.target_date,
      user_id: options.user_id,
      stock_name: options.stock_name,
      dry_run: false,
      is_async: true,
      task_label: options.task_label || 'ai_price_decision_async',
    });
    if (analysis.status !== 'pending' || !analysis.task_id) {
      throw new Error(analysis.error || 'TradingAgents 未返回可轮询的异步任务 ID');
    }

    const metadata: Record<string, unknown> = {
      ...(analysis.metadata || {}),
      price_decision_request: {
        position_state: options.position_state === 'holding' ? 'holding' : 'watching',
        planned_capital: options.planned_capital ?? null,
        holding_cost: options.holding_cost ?? null,
        refresh_quote: options.refresh_quote !== false,
      },
      async_phase: 'pending',
      async_submitted_at: new Date().toISOString(),
    };
    if (analysis.persisted) {
      try {
        await this.data_source.enrichReport(analysis.report_id, metadata);
      } catch (error: any) {
        logger.warn(
          `[AIPriceDecision] async request metadata persist failed report_id=${
            analysis.report_id
          }: ${error?.message || error}`
        );
        metadata.async_metadata_persist_error = String(error?.message || error);
      }
    }

    return {
      ...analysis,
      metadata,
      market_snapshot: null,
      price_decision: null,
      task_phase: 'pending',
      elapsed_time: 0,
    };
  }

  /**
   * 按当前用户读取并收口异步任务。完成时复用 TradingAgents 已产出的结果生成
   * 当前价计划，不再发起第二次大模型分析；重复轮询幂等返回同一份报告。
   */
  async getAsyncResult(
    task_id: string,
    user_id: number
  ): Promise<AIPriceDecisionTaskResult | null> {
    const stored = await this.data_source.loadReportByTask(task_id, user_id);
    if (!stored) return null;

    const storedMetadata = stored.metadata || {};
    const storedPhase = String(storedMetadata.async_phase || '').toLowerCase();
    if (
      (stored.status === 'completed' ||
        stored.status === 'partial' ||
        stored.status === 'failed') &&
      (storedPhase === 'completed' || storedPhase === 'failed')
    ) {
      return {
        ...stored,
        market_snapshot:
          (storedMetadata.market_snapshot as AIPriceDecisionResult['market_snapshot']) || null,
        price_decision: (storedMetadata.price_decision as AIPriceDecisionPlan) || null,
        task_phase: storedPhase === 'failed' ? 'failed' : 'completed',
        elapsed_time: Number(storedMetadata.elapsed_time || 0),
      };
    }

    const remote = (await this.analysis_service.getTaskStatus(task_id)) as RemoteAnalyzePayload & {
      elapsed_time?: number;
    };
    const remoteStatus = String(remote?.status || '').toUpperCase();
    const elapsedTime = Number(remote?.elapsed_time || 0);
    if (remoteStatus === 'PENDING' || remoteStatus === 'PROCESSING' || remoteStatus === 'RUNNING') {
      const taskPhase = remoteStatus === 'PENDING' ? 'pending' : 'processing';
      return {
        ...stored,
        status: 'pending',
        metadata: {
          ...storedMetadata,
          async_phase: taskPhase,
          elapsed_time: elapsedTime,
        },
        market_snapshot: null,
        price_decision: null,
        task_phase: taskPhase,
        elapsed_time: elapsedTime,
      };
    }

    const finalized = buildResultFromPayload(remote, {
      report_id: stored.report_id,
      stock_code: stored.stock_code,
      stock_name: stored.stock_name,
      dimensions: stored.dimensions,
      target_date: stored.target_date,
      metadata: storedMetadata,
      is_async: false,
      now: new Date(),
    });
    finalized.task_id = task_id;
    finalized.persisted = true;

    const request = (storedMetadata.price_decision_request || {}) as Record<string, unknown>;
    let market: AIPriceMarketSnapshot | null = null;
    let plan: AIPriceDecisionPlan | null = null;
    if (finalized.status === 'completed' || finalized.status === 'partial') {
      market = await this.data_source
        .loadMarketSnapshot(stored.stock_code, { refresh_quote: request.refresh_quote !== false })
        .catch((error: any) => {
          logger.warn(
            `[AIPriceDecision] async market snapshot failed ${stored.stock_code}: ${
              error?.message || error
            }`
          );
          return null;
        });
      if (market) {
        plan = buildAIPriceDecisionPlan({
          recommendation: finalized.recommendation,
          confidence_score: finalized.confidence_score,
          risk_level: finalized.risk_level,
          market,
          position_state: request.position_state === 'holding' ? 'holding' : 'watching',
          planned_capital: positiveNumber(request.planned_capital) ?? undefined,
          holding_cost: positiveNumber(request.holding_cost) ?? undefined,
        });
      }
    }

    const snapshot = publicMarketSnapshot(market);
    const taskPhase = finalized.status === 'failed' ? 'failed' : 'completed';
    finalized.metadata = {
      ...finalized.metadata,
      async_phase: taskPhase,
      elapsed_time: elapsedTime,
      async_finalized_at: new Date().toISOString(),
      price_decision_version: 'tradingagents_price_v1',
      market_snapshot: snapshot,
      price_decision: plan,
    };
    await this.data_source.finalizeReport(finalized);

    return {
      ...finalized,
      market_snapshot: snapshot,
      price_decision: plan,
      task_phase: taskPhase,
      elapsed_time: elapsedTime,
    };
  }
}

export const aiPriceDecisionService = new AIPriceDecisionService();
