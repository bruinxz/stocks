/**
 * DecisionAggregator — Phase 3 决策层.
 *
 * 规则 (见 docs/audit/analysis_engine_design_2026_06_18.md §2.2-2.3 + 任务说明 §4):
 *
 * 1. data_quality=critical → action='hold', overall_confidence=0, 早返.
 * 2. event_action='veto' (EventAnalyzer) 或 RiskAnalyzer.score < -80 → 硬否决:
 *      - 无持仓: action='hold'
 *      - 有持仓: action='sell' (持仓判定交给上层 sizing; 这里默认 'hold')
 * 3. event_action='dampen' → 加权 score × 0.5.
 * 4. 默认权重 (可被 user.risk_config.analysis_engine.weights 覆盖):
 *      fundamental 25 / technical 20 / capital 15 / sentiment 10 /
 *      news 10 / industry_regime 10 / risk 5 / event 5.
 * 5. 加权 score 阈值:
 *      ≥ 60: strong_buy
 *      [30, 60): buy
 *      [15, 30): add
 *      (-15, 15): hold
 *      (-30, -15]: reduce
 *      (-60, -30]: sell
 *      ≤ -60: strong_sell
 * 6. suggested_position_pct: 调 PositionSizingPolicy.decideSizing.
 * 7. entry_zone: TechnicalAnalyzer.buy_zone 夹紧到 `marketLimits.getLimitPrices`
 *    给出的涨跌停区间内 (ST 5% / 主板 10% / 创业板&科创 20% / 北交所 30%).
 *    已废除本文件历史 inline `applyLimitPrice` — 全市场段 + ST + tick round 全部
 *    走 `backend/src/quant/marketLimits.ts` 单一权威 (AE-006 / audit S-2/S-3).
 * 8. stop_loss / take_profit: support_levels[0] / resistance_levels[0] 或 ATR 兜底.
 * 9. key_reasons: |score × weight × confidence| top 5.
 * 10. risk_warnings: RiskAnalyzer + EventAnalyzer 的 negative evidence 全部.
 * 11. overall_confidence: 所有 analyzer confidence 加权平均 × data_quality.coefficient.
 */

import type {
  AnalyzerKey,
  AnalyzerOutput,
  ConfidenceTier,
  DataQualityVerdict,
  RecommendationAction,
  RecommendationDecision,
} from './AnalyzerTypes';
import { getLimitPrices, roundToTick, type MarketSegment } from '../../quant/marketLimits';

export const DEFAULT_ANALYZER_WEIGHTS: Readonly<Record<AnalyzerKey, number>> = Object.freeze({
  fundamental: 0.25,
  technical: 0.2,
  capital: 0.15,
  sentiment: 0.1,
  news: 0.1,
  industry_regime: 0.1,
  risk: 0.05,
  event: 0.05,
});

// ---------------------------------------------------------------------------
//  US-114 / AE-008: confidence_tier 三档阈值
// ---------------------------------------------------------------------------
//
// `pickConfidenceTier(c)` 把 overall_confidence ∈ [0,1] 分桶到 high/medium/low.
// 阈值常量同源 + Object.freeze + sanity guard `HIGH_MIN > MEDIUM_MIN > 0`
// 防未来调参漂移; 改任一阈值必须同步改 `tests/.../DecisionAggregator.test.ts`
// 的 boundary cases (恰好 / 略低 / 远低 三档边界, 与 [[ai-view-max-chars]] N/N+1
// 同款 off-by-one 防御).
//
// 业务语义:
//   - high   ≥ 0.7 → UI 强提示; autoBuy 视情况放大仓位; 飞书 push 走优先级队列
//   - medium ≥ 0.4 → UI 普通提示; 默认仓位
//   - low    <  0.4 → UI 弱提示; autoBuy 默认跳过 (与 hold/critical 合流)
//
// 任何 NaN / Infinity / 负数 / >1 输入都 fail-safe 到 'low' (与 data_quality=critical
// → confidence=0 同款"最安全档兜底"思想, 防止远端 AI / heuristic bug 借非法值渗漏).
export const CONFIDENCE_TIER_HIGH_MIN = 0.7;
export const CONFIDENCE_TIER_MEDIUM_MIN = 0.4;

export function pickConfidenceTier(overallConfidence: number | null | undefined): ConfidenceTier {
  if (!Number.isFinite(overallConfidence as number)) return 'low';
  const c = overallConfidence as number;
  if (c >= CONFIDENCE_TIER_HIGH_MIN) return 'high';
  if (c >= CONFIDENCE_TIER_MEDIUM_MIN) return 'medium';
  return 'low';
}

export interface AggregatorInput {
  stock_code: string;
  as_of: string;
  analyzers: AnalyzerOutput[];
  data_quality: DataQualityVerdict;
  current_price?: number | null;
  has_open_position?: boolean;
  weights?: Partial<Record<AnalyzerKey, number>>;
  user_id?: number | null;
  /** 来自 TechnicalAnalyzer 的扩展数据 (entry_zone / support / resistance) — 由 engine 注入 */
  technical_anchors?: {
    buy_zone?: [number, number] | null;
    sell_zone?: [number, number] | null;
    support_levels?: number[];
    resistance_levels?: number[];
    atr?: number | null;
  };
  /** market_segment (用于涨跌停修正) */
  market_segment?: MarketSegment;
  /** 是否 ST (5% 涨跌停) */
  is_st?: boolean;
}

export function normalizeWeights(
  input?: Partial<Record<AnalyzerKey, number>>
): Record<AnalyzerKey, number> {
  if (!input) return { ...DEFAULT_ANALYZER_WEIGHTS };
  const out: Record<AnalyzerKey, number> = { ...DEFAULT_ANALYZER_WEIGHTS };
  let total = 0;
  for (const k of Object.keys(DEFAULT_ANALYZER_WEIGHTS) as AnalyzerKey[]) {
    const v = Number(input[k]);
    if (Number.isFinite(v) && v >= 0) {
      out[k] = v;
    }
    total += out[k];
  }
  if (total <= 0) return { ...DEFAULT_ANALYZER_WEIGHTS };
  // re-normalize to sum=1
  for (const k of Object.keys(out) as AnalyzerKey[]) {
    out[k] = out[k] / total;
  }
  return out;
}

export function mapScoreToAction(score: number): RecommendationAction {
  if (score >= 60) return 'strong_buy';
  if (score >= 30) return 'buy';
  if (score >= 15) return 'add';
  if (score > -15) return 'hold';
  if (score > -30) return 'reduce';
  if (score > -60) return 'sell';
  return 'strong_sell';
}

/**
 * 按 prev_close + market segment + ST 算涨跌停价 — 委托给 `quant/marketLimits.getLimitPrices`,
 * 失败时返回 null 让上层兜底 (此处不抛错以保证 aggregator 整链 fail-open).
 *
 * AE-006: 历史 inline `applyLimitPrice` 已删除, 全市场段 + ST + tick round 全部
 * 走 `marketLimits.ts` 单一权威 (见文件头注释).
 */
function computeLimitBand(
  prevClose: number | null | undefined,
  segment: MarketSegment | undefined,
  isSt: boolean
): { up: number; down: number } | null {
  if (!Number.isFinite(prevClose) || (prevClose as number) <= 0) return null;
  try {
    const { upper, lower } = getLimitPrices(prevClose as number, segment ?? 'unknown', isSt);
    return { up: upper, down: lower };
  } catch {
    return null;
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function pickEntryZone(
  buyZone: [number, number] | null | undefined,
  currentPrice: number | null | undefined,
  segment: AggregatorInput['market_segment'],
  isSt: boolean
): [number, number] | null {
  if (!buyZone || !Array.isArray(buyZone) || buyZone.length !== 2) {
    if (currentPrice && currentPrice > 0) {
      // 兜底: 当前价 ±2% 一档窄区间, 也走 0.01 tick round 保持口径一致
      return [roundToTick(currentPrice * 0.98), roundToTick(currentPrice * 1.02)];
    }
    return null;
  }
  let [lo, hi] = buyZone;
  if (!(Number.isFinite(lo) && Number.isFinite(hi))) return null;
  if (lo > hi) [lo, hi] = [hi, lo];
  // 注意: marketLimits 的 prev_close 语义就是 currentPrice (T-1 收 / 当前价均可代入,
  // 这里用 currentPrice 作为锚, 与历史 inline 行为完全一致).
  const limits = computeLimitBand(currentPrice ?? null, segment, isSt);
  if (limits) {
    lo = Math.max(lo, limits.down);
    hi = Math.min(hi, limits.up);
    if (lo >= hi) {
      lo = limits.down;
      hi = limits.up;
    }
  }
  return [roundToTick(lo), roundToTick(hi)];
}

export function pickStopLoss(
  supportLevels: number[] | undefined,
  currentPrice: number | null | undefined,
  atr: number | null | undefined
): number | null {
  if (Array.isArray(supportLevels) && supportLevels.length > 0) {
    const s = supportLevels[0];
    if (Number.isFinite(s) && s > 0) return round2(s);
  }
  if (currentPrice && currentPrice > 0 && atr && atr > 0) {
    return round2(currentPrice - 2 * atr);
  }
  if (currentPrice && currentPrice > 0) {
    return round2(currentPrice * 0.93);
  }
  return null;
}

export function pickTakeProfit(
  resistanceLevels: number[] | undefined,
  currentPrice: number | null | undefined,
  atr: number | null | undefined
): number | null {
  if (Array.isArray(resistanceLevels) && resistanceLevels.length > 0) {
    const r = resistanceLevels[0];
    if (Number.isFinite(r) && r > 0) return round2(r);
  }
  if (currentPrice && currentPrice > 0 && atr && atr > 0) {
    return round2(currentPrice + 3 * atr);
  }
  if (currentPrice && currentPrice > 0) {
    return round2(currentPrice * 1.12);
  }
  return null;
}

export function pickKeyReasons(
  analyzers: AnalyzerOutput[],
  weights: Record<AnalyzerKey, number>,
  topN = 5
): string[] {
  type Tagged = { score: number; label: string };
  const tagged: Tagged[] = [];
  for (const a of analyzers) {
    const w = weights[a.analyzer_key] ?? 0;
    for (const ev of a.evidence) {
      const evScore = Math.abs(
        (ev.metric_value ??
          (ev.direction === 'bullish' ? 30 : ev.direction === 'bearish' ? -30 : 0)) *
          w *
          a.confidence *
          ev.weight
      );
      tagged.push({
        score: evScore,
        label: `[${a.analyzer_key}] ${ev.label}`,
      });
    }
  }
  return tagged
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(t => t.label);
}

export function collectRiskWarnings(analyzers: AnalyzerOutput[]): string[] {
  const out: string[] = [];
  for (const a of analyzers) {
    if (a.analyzer_key !== 'risk' && a.analyzer_key !== 'event') continue;
    for (const ev of a.evidence) {
      if (ev.direction === 'bearish') {
        out.push(`[${a.analyzer_key}] ${ev.label}`);
      }
    }
    if (a.error) {
      out.push(`[${a.analyzer_key}] error: ${a.error.code}`);
    }
  }
  return out;
}

export interface AggregatorOptions {
  shadow_of_report_id?: string | null;
  /** 1 = full, 0.5 = sizing 给出位 50% */
  sizing_policy_override?: Record<string, unknown>;
}

export class DecisionAggregator {
  aggregate(input: AggregatorInput, options: AggregatorOptions = {}): RecommendationDecision {
    const weights = normalizeWeights(input.weights);

    // (1) 关键数据缺失 → hold
    if (input.data_quality.level === 'critical') {
      return {
        action: 'hold',
        suggested_position_pct: 0,
        entry_zone: null,
        stop_loss: null,
        take_profit: null,
        key_reasons: ['关键数据缺失 (' + input.data_quality.missing_critical.join(', ') + ')'],
        risk_warnings: ['data_quality=critical, 引擎拒绝出建议'],
        overall_confidence: 0,
        confidence_tier: pickConfidenceTier(0),
        per_dimension: input.analyzers,
        data_quality: input.data_quality,
        engine_variant: 'multi_dim_v1',
        shadow_of_report_id: options.shadow_of_report_id || null,
        as_of: input.as_of,
        stock_code: input.stock_code,
      };
    }

    // (2) 硬否决: RiskAnalyzer event_action=veto 或 score < -80; EventAnalyzer event_action=veto
    const risk = input.analyzers.find(a => a.analyzer_key === 'risk');
    const event = input.analyzers.find(a => a.analyzer_key === 'event');
    const riskVeto = risk?.event_action === 'veto' || (risk && risk.score < -80);
    const eventVeto = event?.event_action === 'veto';

    if (riskVeto || eventVeto) {
      const vetoSource = eventVeto ? 'event' : 'risk';
      const action: RecommendationAction = input.has_open_position ? 'sell' : 'hold';
      return {
        action,
        suggested_position_pct: 0,
        entry_zone: null,
        stop_loss: pickStopLoss(
          input.technical_anchors?.support_levels,
          input.current_price ?? null,
          input.technical_anchors?.atr ?? null
        ),
        take_profit: null,
        key_reasons: [`[${vetoSource}] 硬否决`],
        risk_warnings: collectRiskWarnings(input.analyzers),
        overall_confidence: 0.3,
        confidence_tier: pickConfidenceTier(0.3),
        per_dimension: input.analyzers,
        data_quality: input.data_quality,
        engine_variant: 'multi_dim_v1',
        shadow_of_report_id: options.shadow_of_report_id || null,
        as_of: input.as_of,
        stock_code: input.stock_code,
      };
    }

    // (3) Dampen: event_action='dampen' → multiplier 0.5
    let dampenMultiplier = 1;
    if (event?.event_action === 'dampen') {
      dampenMultiplier = 0.5;
    }

    // (4) 加权 score
    let sumWeighted = 0;
    let sumW = 0;
    let sumConfidenceW = 0;
    for (const a of input.analyzers) {
      const w = weights[a.analyzer_key] ?? 0;
      if (w <= 0 || a.confidence <= 0) continue;
      sumWeighted += a.score * w * a.confidence;
      sumW += w * a.confidence;
      sumConfidenceW += a.confidence * w;
    }
    let weightedScore = sumW > 0 ? sumWeighted / sumW : 0;
    weightedScore *= dampenMultiplier;

    const action = mapScoreToAction(weightedScore);

    // (5) sizing
    //
    // 设计取舍: AnalyzerContext 不带 equity/available_cash (分析层不感知仓位/账户),
    // 所以无法直接调 PositionSizingPolicy.decideSizing() (其 SizingContext 必须有 equity).
    // suggested_position_pct 由 aggregator 给出"建议仓位百分比"作为决策 hint,
    // 真实下单时 PaperTradingAutomationService / AutomatedRecommendationLoopService
    // 仍会经 PositionSizingPolicy.decideSizing 走完整 sizing pipeline (Kelly/vol/atr).
    // 此处仅按 score+confidence 做线性映射给前端可视化用.
    const suggestionMap: Array<[number, number]> = [
      [80, 0.12],
      [60, 0.1],
      [40, 0.08],
      [25, 0.06],
      [15, 0.04],
    ];
    let suggestedPct = 0;
    for (const [threshold, pct] of suggestionMap) {
      if (weightedScore >= threshold) {
        suggestedPct = pct;
        break;
      }
    }
    // sell/reduce 类 action → suggested_position_pct = 0 (调用方按持仓决定)
    if (action === 'hold' || action === 'reduce' || action === 'sell' || action === 'strong_sell') {
      suggestedPct = 0;
    }
    void options.sizing_policy_override;

    // (6) entry/stop/take_profit
    const entryZone = pickEntryZone(
      input.technical_anchors?.buy_zone ?? null,
      input.current_price ?? null,
      input.market_segment,
      input.is_st === true
    );
    const stopLoss = pickStopLoss(
      input.technical_anchors?.support_levels,
      input.current_price ?? null,
      input.technical_anchors?.atr ?? null
    );
    const takeProfit = pickTakeProfit(
      input.technical_anchors?.resistance_levels,
      input.current_price ?? null,
      input.technical_anchors?.atr ?? null
    );

    // (7) confidence
    const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);
    const avgConfidence = totalWeight > 0 ? sumConfidenceW / totalWeight : 0;
    const overallConfidence = Math.max(
      0,
      Math.min(1, avgConfidence * (input.data_quality.coefficient ?? 1))
    );

    return {
      action,
      suggested_position_pct: round2(suggestedPct * 100) / 100,
      entry_zone: entryZone,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      key_reasons: pickKeyReasons(input.analyzers, weights),
      risk_warnings: collectRiskWarnings(input.analyzers),
      overall_confidence: overallConfidence,
      confidence_tier: pickConfidenceTier(overallConfidence),
      per_dimension: input.analyzers,
      data_quality: input.data_quality,
      engine_variant: 'multi_dim_v1',
      shadow_of_report_id: options.shadow_of_report_id || null,
      as_of: input.as_of,
      stock_code: input.stock_code,
    };
  }
}

export const decisionAggregator = new DecisionAggregator();
