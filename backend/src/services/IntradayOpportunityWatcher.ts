/**
 * IntradayOpportunityWatcher — CE-B (2026-06-26)
 *
 * 盘中实时机会规则引擎. 1 轮 scan:
 *   1. universe = IntradayUniverseService.resolveUniverse() (≤500 票)
 *   2. 批量拉 RealtimeQuote (最新一行 per symbol) + 60d DailyBar + 北向 5d delta + 昨日涨停集
 *   3. 对每个 symbol 跑 10 类 detector (纯函数, < 50ms) → 命中收集到 candidates
 *   4. dedupe candidates by symbol (同股取 raw_score 最高)
 *   5. 对每个命中 symbol 调 analysisEngineService.analyzeStock → 取 overall_confidence × 100
 *   6. final_score < min_final_score (默认 65) → skip + pushed=false
 *   7. 否则调 intradayOpportunityPusher.push() (内部 dedup / circuit breaker / 飞书 fan-out)
 *
 * **detector 范式**:
 *   - 纯函数, 入 RuleContext, 返 RuleHit | null
 *   - 全部 export 让 detectorMap + 单测可独立验证
 *   - 不嵌入 LLM 调用, 不读 DB (RuleContext 已含全部数据)
 *
 * **fail-OPEN**:
 *   - 单股 ctx 构建 / detector / analyzeStock / push 任一失败 → 仅 logger.warn + 进 errors[]
 *   - DataSource 任一 batch 拉取 throw → throw 透传, watcher 自己 catch 后 errors[] 写一行
 *
 * **DataSource DI**:
 *   - PRODUCTION_WATCHER_DATA_SOURCE Sequelize 实现 + 单测注入 fake
 *   - lazy require() 避免 service 顶层 import 重 model
 *
 * **设计文档**:
 *   - 与 IntradayOpportunityPusher (CE-C) / IntradayUniverseService (CE-A) 串联
 *   - 见 backend/src/services/CLAUDE.md "advanced quant service" 范式
 */

import { logger } from '../utils/logger';
import { normalizeSymbol } from '../utils/stockSymbol';
import {
  intradayUniverseService,
  IntradayUniverseService,
} from './IntradayUniverseService';
import {
  intradayOpportunityPusher,
  IntradayOpportunityPusher,
  OpportunityInput,
  OpportunityDecision,
  OpportunityAction,
  OpportunityRiskLevel,
  OpportunityTargetGroup,
  OPPORTUNITY_TARGET_GROUPS,
} from './IntradayOpportunityPusher';
import {
  analysisEngineService,
  AnalysisEngineService,
} from './analysis-engine/AnalysisEngineService';
import type { RecommendationDecision } from './analysis-engine/AnalyzerTypes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const TRIGGER_RULE_IDS = Object.freeze([
  'breakout_60d_high',
  'breakout_20d_high',
  'volume_spike',
  'rapid_rise',
  'rapid_fall_stabilize',
  'gap_up_breakout',
  'northbound_inflow_surge',
  'limit_up_first_board',
  'dragon_tiger_first_board',
  'volume_price_confirmation',
] as const);

export type TriggerRuleId = (typeof TRIGGER_RULE_IDS)[number];

export const TRIGGER_RULE_LABELS: Record<TriggerRuleId, string> = Object.freeze({
  breakout_60d_high: '突破 60 日新高',
  breakout_20d_high: '突破 20 日新高',
  volume_spike: '放量异动',
  rapid_rise: '急涨',
  rapid_fall_stabilize: '急跌企稳',
  gap_up_breakout: '高开突破',
  northbound_inflow_surge: '北向资金流入加速',
  limit_up_first_board: '涨停首板',
  dragon_tiger_first_board: '龙虎榜首板',
  volume_price_confirmation: '量价齐升',
}) as Record<TriggerRuleId, string>;

export interface RuleBar {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 当日涨跌幅 (5.0 = 5%) */
  change_percent: number;
}

export interface RuleContext {
  symbol: string;
  name: string;
  industry: string | null;
  market_segment: string | null;
  current_price: number;
  /** 当日累计涨跌幅 (5.0 = 5%) */
  change_pct: number;
  current_volume: number;
  bid: number | null;
  ask: number | null;
  /** 升序, 不含今天 (今天数据在 current_price / change_pct / current_volume) */
  bars: RuleBar[];
  northbound_delta_5d?: number | null;
  limit_up_yesterday?: boolean;
}

export interface RuleHit {
  rule_id: TriggerRuleId;
  rule_label: string;
  /** 0-100 */
  raw_score: number;
  /** 1-3 条中文依据 */
  reasons: string[];
}

export interface WatcherScanOptions {
  symbols?: string[];
  rules?: TriggerRuleId[];
  /** 默认 65; analyzeStock.overall_confidence × 100 低于此值不推 */
  min_final_score?: number;
  dry_run?: boolean;
  /** 默认 ['business'] */
  target_groups?: OpportunityTargetGroup[];
  /** target_groups 含 'user' 时携带 */
  user_ids?: number[];
}

export interface WatcherHitOutcome {
  symbol: string;
  trigger_rule: TriggerRuleId;
  trigger_rule_label: string;
  raw_signal_score: number;
  final_decision_score?: number;
  pushed: boolean;
  push_skipped_reason?: string;
}

export interface WatchResult {
  scanned_count: number;
  hit_count: number;
  pushed_count: number;
  skipped_count: number;
  errors: Array<{ symbol: string; reason: string }>;
  hits: WatcherHitOutcome[];
}

// ---------------------------------------------------------------------------
// Constants used by detectors
// ---------------------------------------------------------------------------

export const VOLUME_SPIKE_RATIO_THRESHOLD = 2.0;
export const VOLUME_SPIKE_MIN_CHANGE_PCT = 1;
export const RAPID_RISE_CHANGE_PCT = 5;
export const RAPID_RISE_VOLUME_RATIO = 1.2;
export const RAPID_FALL_STABILIZE_PREV5D_DROP = -8;
export const RAPID_FALL_STABILIZE_MIN_CHANGE_PCT = -1;
export const RAPID_FALL_STABILIZE_VOLUME_RATIO = 1.0;
export const GAP_UP_THRESHOLD = 0.03;
export const NORTHBOUND_DELTA_THRESHOLD = 5;
export const LIMIT_UP_MAIN_PCT = 9;
export const LIMIT_UP_KECHUANG_CHINEXT_PCT = 19;
export const DRAGON_TIGER_MIN_CHANGE_PCT = 2;
export const VOLUME_PRICE_3D_CHANGE_PCT = 5;
export const DEFAULT_MIN_FINAL_SCORE = 65;

// ---------------------------------------------------------------------------
// Pure helpers — all exported for unit testing
// ---------------------------------------------------------------------------

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 100) return 100;
  return Math.round(score * 100) / 100;
}

function avg(values: number[]): number {
  if (!values || values.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * 是否创业板 / 科创板 (20% 涨跌停).
 * sz.30xxxx (创业板) / sh.688xxx (科创板) / bj.* (北交所, 30% 涨跌停, 但首板 19% 已算)
 */
export function isHighLimitSymbol(symbol: string): boolean {
  const sym = String(symbol || '').toLowerCase().replace(/[.\s]/g, '');
  if (!sym) return false;
  if (sym.startsWith('sz') && /^sz3[0-9]{5}$/.test(sym)) return true;
  if (sym.startsWith('sh688')) return true;
  if (sym.startsWith('bj')) return true;
  return false;
}

/**
 * 算 5 日 volume_ratio = current_volume / avg(bars[-5:].volume).
 * bars 不足 5 根 返 null. avg=0 (静默 5 日) 返 null.
 */
export function compute5dVolumeRatio(ctx: RuleContext): number | null {
  if (!ctx || !Array.isArray(ctx.bars) || ctx.bars.length < 5) return null;
  if (!Number.isFinite(ctx.current_volume) || ctx.current_volume <= 0) return null;
  const last5 = ctx.bars.slice(-5).map(b => Number(b.volume));
  const a = avg(last5);
  if (!Number.isFinite(a) || a <= 0) return null;
  return ctx.current_volume / a;
}

// ---------------------------------------------------------------------------
// Detectors (10 类 — pure functions)
// ---------------------------------------------------------------------------

export function detectBreakout60dHigh(ctx: RuleContext): RuleHit | null {
  if (!ctx || !Number.isFinite(ctx.current_price)) return null;
  if (!Array.isArray(ctx.bars) || ctx.bars.length < 60) return null;
  const window = ctx.bars.slice(-60);
  const maxHigh = Math.max(...window.map(b => Number(b.high)));
  if (!Number.isFinite(maxHigh) || maxHigh <= 0) return null;
  if (!(ctx.current_price > maxHigh)) return null;
  const score = clampScore(70 + Math.min(30, Math.max(0, ctx.change_pct) * 2));
  return {
    rule_id: 'breakout_60d_high',
    rule_label: TRIGGER_RULE_LABELS.breakout_60d_high,
    raw_score: score,
    reasons: [
      `现价 ${ctx.current_price.toFixed(2)} 突破 60 日新高 ${maxHigh.toFixed(2)}`,
      `当日涨幅 ${ctx.change_pct.toFixed(2)}%`,
    ],
  };
}

export function detectBreakout20dHigh(ctx: RuleContext): RuleHit | null {
  if (!ctx || !Number.isFinite(ctx.current_price)) return null;
  if (!Array.isArray(ctx.bars) || ctx.bars.length < 20) return null;
  // 不命中 60d (若 60 根足够, current > 60d high 由 60d 规则收掉, 这里跳过)
  if (ctx.bars.length >= 60) {
    const max60 = Math.max(...ctx.bars.slice(-60).map(b => Number(b.high)));
    if (ctx.current_price > max60) return null;
  }
  const window = ctx.bars.slice(-20);
  const maxHigh = Math.max(...window.map(b => Number(b.high)));
  if (!Number.isFinite(maxHigh) || maxHigh <= 0) return null;
  if (!(ctx.current_price > maxHigh)) return null;
  const score = clampScore(60 + Math.min(30, Math.max(0, ctx.change_pct) * 2));
  return {
    rule_id: 'breakout_20d_high',
    rule_label: TRIGGER_RULE_LABELS.breakout_20d_high,
    raw_score: score,
    reasons: [
      `现价 ${ctx.current_price.toFixed(2)} 突破 20 日新高 ${maxHigh.toFixed(2)}`,
      `当日涨幅 ${ctx.change_pct.toFixed(2)}%`,
    ],
  };
}

export function detectVolumeSpike(ctx: RuleContext): RuleHit | null {
  const ratio = compute5dVolumeRatio(ctx);
  if (ratio === null) return null;
  if (!(ratio > VOLUME_SPIKE_RATIO_THRESHOLD)) return null;
  if (!Number.isFinite(ctx.change_pct) || !(ctx.change_pct > VOLUME_SPIKE_MIN_CHANGE_PCT)) {
    return null;
  }
  const score = clampScore(50 + Math.min(40, (ratio - VOLUME_SPIKE_RATIO_THRESHOLD) * 10));
  return {
    rule_id: 'volume_spike',
    rule_label: TRIGGER_RULE_LABELS.volume_spike,
    raw_score: score,
    reasons: [
      `5 日量比 ${ratio.toFixed(2)} 倍 (阈值 > 2x)`,
      `当日涨幅 ${ctx.change_pct.toFixed(2)}%`,
    ],
  };
}

export function detectRapidRise(ctx: RuleContext): RuleHit | null {
  if (!ctx || !Number.isFinite(ctx.change_pct)) return null;
  if (!(ctx.change_pct >= RAPID_RISE_CHANGE_PCT)) return null;
  const ratio = compute5dVolumeRatio(ctx);
  if (ratio === null || !(ratio > RAPID_RISE_VOLUME_RATIO)) return null;
  const score = clampScore(50 + Math.min(40, ctx.change_pct * 4));
  return {
    rule_id: 'rapid_rise',
    rule_label: TRIGGER_RULE_LABELS.rapid_rise,
    raw_score: score,
    reasons: [
      `急涨 ${ctx.change_pct.toFixed(2)}% (阈值 ≥ 5%)`,
      `量比 ${ratio.toFixed(2)} 倍`,
    ],
  };
}

export function detectRapidFallStabilize(ctx: RuleContext): RuleHit | null {
  if (!ctx || !Number.isFinite(ctx.change_pct)) return null;
  if (!Array.isArray(ctx.bars) || ctx.bars.length < 5) return null;
  const last5 = ctx.bars.slice(-5);
  const prev5dChg = last5.reduce((s, b) => s + (Number.isFinite(b.change_percent) ? b.change_percent : 0), 0);
  if (!(prev5dChg < RAPID_FALL_STABILIZE_PREV5D_DROP)) return null;
  if (!(ctx.change_pct > RAPID_FALL_STABILIZE_MIN_CHANGE_PCT)) return null;
  const ratio = compute5dVolumeRatio(ctx);
  if (ratio === null || !(ratio > RAPID_FALL_STABILIZE_VOLUME_RATIO)) return null;
  const score = clampScore(50 + Math.min(30, Math.abs(prev5dChg) * 2));
  return {
    rule_id: 'rapid_fall_stabilize',
    rule_label: TRIGGER_RULE_LABELS.rapid_fall_stabilize,
    raw_score: score,
    reasons: [
      `近 5 日累计跌幅 ${prev5dChg.toFixed(2)}% (阈值 < -8%)`,
      `当日企稳 ${ctx.change_pct.toFixed(2)}%, 量比 ${ratio.toFixed(2)} 倍`,
    ],
  };
}

export function detectGapUpBreakout(ctx: RuleContext): RuleHit | null {
  if (!ctx || !Number.isFinite(ctx.current_price)) return null;
  if (!Array.isArray(ctx.bars) || ctx.bars.length < 1) return null;
  const prev = ctx.bars[ctx.bars.length - 1];
  if (!prev || !Number.isFinite(prev.close) || prev.close <= 0) return null;
  if (!Number.isFinite(prev.high) || prev.high <= 0) return null;
  // 今日 open: 优先用 bars-1 索引的 open? 不, 这里把今天的 open 当作 "需 caller 在 ctx 提供".
  // RuleContext 不强制今日 open 字段, 用 current_price 当 open 近似 (盘前用) 不准确.
  // 用法约定: caller (production DS) 把今日 open 放到 ctx.bars 的 last+1? 不,
  // 设计是 ctx.bars 不含今天, 所以今日 open 必须 caller 单独带. 这里采用 ctx 上的
  // optional bars 末根 + 今日 open via ctx 隐含: 用 `(ctx as any).today_open`.
  // 为保持接口干净, 我们用 current_price / prev.close 检测 gap (假设盘后/盘中触发,
  // gap = current_price 自带). 这是合理近似 — 高开后未回补就 current_price ≈ 开盘价.
  // 真实实现可在 RuleContext 加 today_open 字段; 此版本用 current_price 占位.
  const gap = ctx.current_price / prev.close - 1;
  if (!(gap > GAP_UP_THRESHOLD)) return null;
  if (!(ctx.current_price > prev.high)) return null;
  const score = clampScore(65 + Math.min(30, gap * 500));
  return {
    rule_id: 'gap_up_breakout',
    rule_label: TRIGGER_RULE_LABELS.gap_up_breakout,
    raw_score: score,
    reasons: [
      `高开 ${(gap * 100).toFixed(2)}% (阈值 > 3%)`,
      `现价 ${ctx.current_price.toFixed(2)} 突破前高 ${prev.high.toFixed(2)}`,
    ],
  };
}

export function detectNorthboundInflowSurge(ctx: RuleContext): RuleHit | null {
  if (!ctx) return null;
  const nb = ctx.northbound_delta_5d;
  if (nb === null || nb === undefined || !Number.isFinite(nb)) return null;
  if (!(nb > NORTHBOUND_DELTA_THRESHOLD)) return null;
  if (!Number.isFinite(ctx.change_pct) || !(ctx.change_pct > 0)) return null;
  const score = clampScore(60 + Math.min(35, nb * 3));
  return {
    rule_id: 'northbound_inflow_surge',
    rule_label: TRIGGER_RULE_LABELS.northbound_inflow_surge,
    raw_score: score,
    reasons: [
      `北向 5 日净流入持仓占比变动 +${nb.toFixed(2)}% (阈值 > 5%)`,
      `当日涨幅 ${ctx.change_pct.toFixed(2)}%`,
    ],
  };
}

export function detectLimitUpFirstBoard(ctx: RuleContext): RuleHit | null {
  if (!ctx || !Number.isFinite(ctx.change_pct)) return null;
  const isHigh = isHighLimitSymbol(ctx.symbol);
  const thresh = isHigh ? LIMIT_UP_KECHUANG_CHINEXT_PCT : LIMIT_UP_MAIN_PCT;
  if (!(ctx.change_pct >= thresh)) return null;
  if (ctx.limit_up_yesterday === true) return null;
  const score = clampScore(75 + Math.min(20, Math.max(0, ctx.change_pct - thresh)));
  return {
    rule_id: 'limit_up_first_board',
    rule_label: TRIGGER_RULE_LABELS.limit_up_first_board,
    raw_score: score,
    reasons: [
      `${isHigh ? '创业板/科创板' : '主板'}涨停 (${ctx.change_pct.toFixed(2)}% ≥ ${thresh}%)`,
      '昨日未涨停 → 首板',
    ],
  };
}

export function detectDragonTigerFirstBoard(ctx: RuleContext): RuleHit | null {
  if (!ctx) return null;
  if (ctx.limit_up_yesterday !== true) return null;
  if (!Number.isFinite(ctx.change_pct) || !(ctx.change_pct > DRAGON_TIGER_MIN_CHANGE_PCT)) {
    return null;
  }
  return {
    rule_id: 'dragon_tiger_first_board',
    rule_label: TRIGGER_RULE_LABELS.dragon_tiger_first_board,
    raw_score: 70,
    reasons: [
      '昨日涨停 → 龙虎榜资金关注',
      `今日续涨 ${ctx.change_pct.toFixed(2)}% (阈值 > 2%)`,
    ],
  };
}

export function detectVolumePriceConfirmation(ctx: RuleContext): RuleHit | null {
  if (!ctx || !Number.isFinite(ctx.change_pct) || !(ctx.change_pct > 0)) return null;
  if (!Array.isArray(ctx.bars) || ctx.bars.length < 3) return null;
  const last3 = ctx.bars.slice(-3);
  const chg3d = last3.reduce(
    (s, b) => s + (Number.isFinite(b.change_percent) ? b.change_percent : 0),
    0
  );
  if (!(chg3d > VOLUME_PRICE_3D_CHANGE_PCT)) return null;
  // 严格递增
  for (let i = 1; i < last3.length; i++) {
    const prev = Number(last3[i - 1].volume);
    const cur = Number(last3[i].volume);
    if (!(Number.isFinite(prev) && Number.isFinite(cur) && cur > prev)) return null;
  }
  const score = clampScore(55 + Math.min(35, chg3d * 3));
  return {
    rule_id: 'volume_price_confirmation',
    rule_label: TRIGGER_RULE_LABELS.volume_price_confirmation,
    raw_score: score,
    reasons: [
      `近 3 日累计涨幅 ${chg3d.toFixed(2)}% (阈值 > 5%)`,
      '成交量逐日递增 → 量价齐升',
      `当日涨幅 ${ctx.change_pct.toFixed(2)}%`,
    ],
  };
}

export const DETECTOR_MAP: Record<TriggerRuleId, (ctx: RuleContext) => RuleHit | null> =
  Object.freeze({
    breakout_60d_high: detectBreakout60dHigh,
    breakout_20d_high: detectBreakout20dHigh,
    volume_spike: detectVolumeSpike,
    rapid_rise: detectRapidRise,
    rapid_fall_stabilize: detectRapidFallStabilize,
    gap_up_breakout: detectGapUpBreakout,
    northbound_inflow_surge: detectNorthboundInflowSurge,
    limit_up_first_board: detectLimitUpFirstBoard,
    dragon_tiger_first_board: detectDragonTigerFirstBoard,
    volume_price_confirmation: detectVolumePriceConfirmation,
  }) as Record<TriggerRuleId, (ctx: RuleContext) => RuleHit | null>;

// ---------------------------------------------------------------------------
// Decision → OpportunityInput mapping
// ---------------------------------------------------------------------------

/** RecommendationAction → OpportunityAction (pusher 只支持 4 档买入向). */
export function mapDecisionAction(action: string | null | undefined): OpportunityAction {
  if (action === 'strong_buy') return 'strong_buy';
  if (action === 'buy') return 'buy';
  if (action === 'add') return 'add';
  return 'hold';
}

/** 用 risk_warnings 长度 + confidence_tier 简单推 risk_level. */
export function mapRiskLevel(decision: RecommendationDecision): OpportunityRiskLevel {
  const warnCount = Array.isArray(decision.risk_warnings) ? decision.risk_warnings.length : 0;
  if (warnCount >= 4 || decision.confidence_tier === 'low') return 'high';
  if (warnCount >= 2 || decision.confidence_tier === 'medium') return 'medium';
  return 'low';
}

export function buildPusherInputFromHit(
  ctx: RuleContext,
  hit: RuleHit,
  decision: RecommendationDecision,
  triggerTime: Date
): OpportunityInput {
  const oDecision: OpportunityDecision = {
    action: mapDecisionAction(decision.action),
    confidence_score: Math.round(
      Math.max(0, Math.min(1, Number(decision.overall_confidence) || 0)) * 100
    ),
    risk_level: mapRiskLevel(decision),
    suggested_position_pct:
      decision.suggested_position_pct === null || decision.suggested_position_pct === undefined
        ? null
        : Number(decision.suggested_position_pct),
    entry_zone: decision.entry_zone || null,
    stop_loss: decision.stop_loss === null || decision.stop_loss === undefined
      ? null
      : Number(decision.stop_loss),
    take_profit:
      decision.take_profit === null || decision.take_profit === undefined
        ? null
        : Number(decision.take_profit),
  };
  // 合并 reasons: 规则触发理由 + 引擎 top-2 key_reasons
  const ruleReasons = Array.isArray(hit.reasons) ? hit.reasons.slice(0, 2) : [];
  const engineReasons = Array.isArray(decision.key_reasons) ? decision.key_reasons.slice(0, 2) : [];
  const reasons = [...ruleReasons, ...engineReasons].slice(0, 3);

  const volumeRatio = compute5dVolumeRatio(ctx);

  return {
    symbol: ctx.symbol,
    name: ctx.name,
    trigger_rule: hit.rule_id,
    trigger_rule_label: hit.rule_label,
    trigger_time: triggerTime,
    current_price: ctx.current_price,
    change_pct: ctx.change_pct,
    volume_ratio: volumeRatio,
    decision: oDecision,
    reasons,
    industry: ctx.industry,
    market_segment: ctx.market_segment,
    source_signal_id: null,
  };
}

// ---------------------------------------------------------------------------
// DataSource (DI seam)
// ---------------------------------------------------------------------------

export interface WatcherSymbolSnapshot {
  symbol: string;
  name: string | null;
  industry: string | null;
  market_segment: string | null;
  current_price: number | null;
  change_pct: number | null;
  current_volume: number | null;
  bid: number | null;
  ask: number | null;
  bars: RuleBar[];
  northbound_delta_5d: number | null;
}

export interface WatcherDataSource {
  /**
   * 批量构造 ctx 候选: 一次拉 RealtimeQuote + DailyBar + Stock meta + 北向 delta,
   * 返每个 symbol 一份 snapshot (字段缺失允许 null, detector 自行 fail-OPEN).
   */
  loadSnapshotsForSymbols(symbols: string[]): Promise<WatcherSymbolSnapshot[]>;
  /** 最近 1 交易日涨停股 symbol Set (含前缀, 已 normalize). */
  loadYesterdayLimitUpSet(): Promise<Set<string>>;
}

class DefaultWatcherDataSource implements WatcherDataSource {
  async loadSnapshotsForSymbols(symbols: string[]): Promise<WatcherSymbolSnapshot[]> {
    if (!Array.isArray(symbols) || symbols.length === 0) return [];
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { Stock } = require('../models/Stock');
    const { DailyBar } = require('../models/DailyBar');
    const { RealtimeQuote } = require('../models/RealtimeQuote');
    const { NorthboundHolding } = require('../models/NorthboundHolding');
    const { Op } = require('sequelize');
    /* eslint-enable @typescript-eslint/no-var-requires */

    const normSymbols = symbols.map(s => normalizeSymbol(s)).filter(Boolean);
    const uniq = Array.from(new Set(normSymbols));

    // 1) Stock meta (id / name / industry)
    const stocks: any[] = await Stock.findAll({
      where: { symbol: { [Op.in]: uniq } },
      attributes: ['id', 'symbol', 'name', 'industry'],
      raw: true,
    });
    const stockBySym = new Map<string, any>();
    const idToSym = new Map<number, string>();
    for (const s of stocks) {
      stockBySym.set(String(s.symbol), s);
      idToSym.set(Number(s.id), String(s.symbol));
    }
    const stockIds = stocks.map(s => Number(s.id));

    // 2) RealtimeQuote 最新一行 per symbol (DISTINCT ON)
    const rtBySym = new Map<string, any>();
    const sequelize = RealtimeQuote.sequelize;
    if (sequelize) {
      try {
        const rtRows: any[] = await sequelize.query(
          `SELECT DISTINCT ON (symbol) symbol, current_price, change_percent, volume, raw_payload, updated_at
           FROM realtime_quotes
           WHERE symbol IN (:syms)
           ORDER BY symbol, updated_at DESC`,
          { replacements: { syms: uniq }, type: sequelize.QueryTypes.SELECT }
        );
        for (const r of rtRows || []) {
          rtBySym.set(String(r.symbol), r);
        }
      } catch (e: any) {
        logger.warn(`[IntradayOpportunityWatcher] RT batch fetch failed: ${e?.message || e}`);
      }
    }

    // 3) DailyBar 60d per symbol — group by stock_id 一次拉
    const barsBySym = new Map<string, RuleBar[]>();
    if (stockIds.length > 0) {
      try {
        const allBars: any[] = await DailyBar.findAll({
          where: { stock_id: { [Op.in]: stockIds } },
          attributes: ['stock_id', 'time', 'open', 'high', 'low', 'close', 'volume', 'change_percent'],
          order: [['stock_id', 'ASC'], ['time', 'DESC']],
          raw: true,
        });
        // 按 stock_id 分组, 每组取最近 60 根, reverse 为升序
        const grouped = new Map<number, any[]>();
        for (const b of allBars) {
          const sid = Number(b.stock_id);
          if (!grouped.has(sid)) grouped.set(sid, []);
          const arr = grouped.get(sid)!;
          if (arr.length < 60) arr.push(b);
        }
        for (const [sid, arr] of grouped) {
          const sym = idToSym.get(sid);
          if (!sym) continue;
          const bars: RuleBar[] = arr
            .slice()
            .reverse()
            .map(b => ({
              time: typeof b.time === 'string' ? new Date(b.time) : new Date(b.time),
              open: Number(b.open),
              high: Number(b.high),
              low: Number(b.low),
              close: Number(b.close),
              volume: Number(b.volume),
              change_percent: Number(b.change_percent || 0),
            }));
          barsBySym.set(sym, bars);
        }
      } catch (e: any) {
        logger.warn(`[IntradayOpportunityWatcher] DailyBar batch fetch failed: ${e?.message || e}`);
      }
    }

    // 4) Northbound 5d delta — fail-OPEN, 单股查很贵, 简化: 不查, 返 null
    //    生产可后续在 NorthboundHoldingService 提供 batch API. 此版本不实装.
    //    detector northbound_inflow_surge 只会在 ctx 上有显式 delta 时才触发.
    const nbBySym = new Map<string, number | null>();
    void NorthboundHolding; // suppress unused

    // 5) 装配
    const out: WatcherSymbolSnapshot[] = [];
    for (const sym of uniq) {
      const stock = stockBySym.get(sym);
      const rt = rtBySym.get(sym);
      const bars = barsBySym.get(sym) || [];
      const bid =
        rt?.raw_payload && typeof rt.raw_payload === 'object'
          ? rt.raw_payload.bid1_price ?? rt.raw_payload.bid1 ?? rt.raw_payload.bid ?? null
          : null;
      const ask =
        rt?.raw_payload && typeof rt.raw_payload === 'object'
          ? rt.raw_payload.ask1_price ?? rt.raw_payload.ask1 ?? rt.raw_payload.ask ?? null
          : null;
      out.push({
        symbol: sym,
        name: stock?.name || null,
        industry: stock?.industry || null,
        market_segment: null,
        current_price: rt?.current_price === undefined || rt?.current_price === null
          ? null
          : Number(rt.current_price),
        change_pct:
          rt?.change_percent === undefined || rt?.change_percent === null
            ? null
            : Number(rt.change_percent),
        current_volume:
          rt?.volume === undefined || rt?.volume === null ? null : Number(rt.volume),
        bid: bid === null || bid === undefined ? null : Number(bid),
        ask: ask === null || ask === undefined ? null : Number(ask),
        bars,
        northbound_delta_5d: nbBySym.get(sym) ?? null,
      });
    }
    return out;
  }

  async loadYesterdayLimitUpSet(): Promise<Set<string>> {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { LimitUpStock } = require('../models/LimitUpStock');
    /* eslint-enable @typescript-eslint/no-var-requires */
    const sequelize = LimitUpStock.sequelize;
    const out = new Set<string>();
    if (!sequelize) return out;
    try {
      const [latestRow]: any[] = await sequelize.query(
        `SELECT MAX(trade_date) AS latest FROM limit_up_stocks`,
        { type: sequelize.QueryTypes.SELECT }
      );
      const latest = latestRow?.latest;
      if (!latest) return out;
      const rows: any[] = await sequelize.query(
        `SELECT stock_code FROM limit_up_stocks WHERE trade_date = :latest`,
        { replacements: { latest }, type: sequelize.QueryTypes.SELECT }
      );
      for (const r of rows || []) {
        const sym = normalizeSymbol(String(r.stock_code || ''));
        if (sym) out.add(sym);
      }
    } catch (e: any) {
      logger.warn(`[IntradayOpportunityWatcher] limit_up batch failed: ${e?.message || e}`);
    }
    return out;
  }
}

export const PRODUCTION_WATCHER_DATA_SOURCE: WatcherDataSource = new DefaultWatcherDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface IntradayOpportunityWatcherDeps {
  dataSource?: WatcherDataSource;
  universeService?: IntradayUniverseService;
  analysisEngine?: AnalysisEngineService;
  pusher?: IntradayOpportunityPusher;
}

export class IntradayOpportunityWatcher {
  private readonly ds: WatcherDataSource;
  private readonly universe: IntradayUniverseService;
  private readonly engine: AnalysisEngineService;
  private readonly pusher: IntradayOpportunityPusher;

  constructor(deps: IntradayOpportunityWatcherDeps = {}) {
    this.ds = deps.dataSource ?? PRODUCTION_WATCHER_DATA_SOURCE;
    this.universe = deps.universeService ?? intradayUniverseService;
    this.engine = deps.analysisEngine ?? analysisEngineService;
    this.pusher = deps.pusher ?? intradayOpportunityPusher;
  }

  async scan(options: WatcherScanOptions = {}): Promise<WatchResult> {
    const result: WatchResult = {
      scanned_count: 0,
      hit_count: 0,
      pushed_count: 0,
      skipped_count: 0,
      errors: [],
      hits: [],
    };
    const minFinal = Number.isFinite(options.min_final_score)
      ? Number(options.min_final_score)
      : DEFAULT_MIN_FINAL_SCORE;
    const dryRun = options.dry_run === true;
    const targetGroups: OpportunityTargetGroup[] =
      options.target_groups && options.target_groups.length > 0
        ? options.target_groups
        : [OPPORTUNITY_TARGET_GROUPS.BUSINESS];
    const enabledRules: TriggerRuleId[] =
      options.rules && options.rules.length > 0
        ? options.rules.filter((r): r is TriggerRuleId =>
            (TRIGGER_RULE_IDS as readonly string[]).includes(r)
          )
        : (TRIGGER_RULE_IDS as readonly TriggerRuleId[]).slice();

    // (1) symbols
    let symbols: string[];
    try {
      symbols =
        options.symbols && options.symbols.length > 0
          ? options.symbols.map(s => normalizeSymbol(s)).filter(Boolean)
          : await this.universe.resolveUniverse();
    } catch (e: any) {
      result.errors.push({ symbol: '__universe__', reason: e?.message || String(e) });
      return result;
    }
    result.scanned_count = symbols.length;
    if (symbols.length === 0) return result;

    // (2) batch fetch
    let snapshots: WatcherSymbolSnapshot[] = [];
    try {
      snapshots = await this.ds.loadSnapshotsForSymbols(symbols);
    } catch (e: any) {
      result.errors.push({ symbol: '__snapshots__', reason: e?.message || String(e) });
      return result;
    }
    let limitUpYesterdaySet: Set<string>;
    try {
      limitUpYesterdaySet = await this.ds.loadYesterdayLimitUpSet();
    } catch (e: any) {
      logger.warn(`[IntradayOpportunityWatcher] limitUp set failed (fail-OPEN): ${e?.message || e}`);
      limitUpYesterdaySet = new Set();
    }

    // (3) run detectors per symbol; collect top hit per symbol
    const candidates = new Map<string, { ctx: RuleContext; hit: RuleHit }>();
    for (const snap of snapshots) {
      try {
        const ctx = buildRuleContextFromSnapshot(snap, limitUpYesterdaySet);
        if (!ctx) continue;
        let bestHit: RuleHit | null = null;
        for (const rule of enabledRules) {
          const detector = DETECTOR_MAP[rule];
          if (!detector) continue;
          try {
            const hit = detector(ctx);
            if (hit && (!bestHit || hit.raw_score > bestHit.raw_score)) {
              bestHit = hit;
            }
          } catch (e: any) {
            logger.warn(
              `[IntradayOpportunityWatcher] detector ${rule} on ${ctx.symbol} failed: ${
                e?.message || e
              }`
            );
          }
        }
        if (bestHit) {
          candidates.set(ctx.symbol, { ctx, hit: bestHit });
        }
      } catch (e: any) {
        result.errors.push({ symbol: snap?.symbol || '?', reason: e?.message || String(e) });
      }
    }
    result.hit_count = candidates.size;

    // (4) for each candidate: analyzeStock + push
    const triggerTime = new Date();
    for (const [symbol, { ctx, hit }] of candidates) {
      try {
        const decision = await this.engine.analyzeStock(symbol);
        const finalScore = Math.round(
          Math.max(0, Math.min(1, Number(decision.overall_confidence) || 0)) * 100
        );
        const outcome: WatcherHitOutcome = {
          symbol,
          trigger_rule: hit.rule_id,
          trigger_rule_label: hit.rule_label,
          raw_signal_score: hit.raw_score,
          final_decision_score: finalScore,
          pushed: false,
        };
        if (finalScore < minFinal) {
          outcome.push_skipped_reason = `final_score_below_min(${finalScore}<${minFinal})`;
          result.skipped_count += 1;
          result.hits.push(outcome);
          continue;
        }
        const pushInput = buildPusherInputFromHit(ctx, hit, decision, triggerTime);
        const pushRes = await this.pusher.push(pushInput, {
          target_groups: targetGroups,
          user_ids: options.user_ids,
          dry_run: dryRun,
        });
        outcome.pushed = !!pushRes.ok && !pushRes.skipped_reason;
        if (pushRes.skipped_reason) outcome.push_skipped_reason = pushRes.skipped_reason;
        if (outcome.pushed) result.pushed_count += 1;
        else result.skipped_count += 1;
        result.hits.push(outcome);
      } catch (e: any) {
        logger.warn(
          `[IntradayOpportunityWatcher] analyze/push ${symbol} failed: ${e?.message || e}`
        );
        result.errors.push({ symbol, reason: e?.message || String(e) });
      }
    }

    return result;
  }
}

/**
 * snapshot → RuleContext. 字段缺失 (price null / volume null) 返 null 跳过该股.
 * limit_up_yesterday 从外部 Set 注入.
 */
export function buildRuleContextFromSnapshot(
  snap: WatcherSymbolSnapshot,
  limitUpYesterdaySet: Set<string>
): RuleContext | null {
  if (!snap || !snap.symbol) return null;
  if (
    snap.current_price === null ||
    snap.current_price === undefined ||
    !Number.isFinite(snap.current_price)
  ) {
    return null;
  }
  return {
    symbol: snap.symbol,
    name: snap.name || snap.symbol,
    industry: snap.industry,
    market_segment: snap.market_segment,
    current_price: Number(snap.current_price),
    change_pct: Number.isFinite(snap.change_pct) ? Number(snap.change_pct) : 0,
    current_volume: Number.isFinite(snap.current_volume) ? Number(snap.current_volume) : 0,
    bid: snap.bid,
    ask: snap.ask,
    bars: Array.isArray(snap.bars) ? snap.bars : [],
    northbound_delta_5d: snap.northbound_delta_5d,
    limit_up_yesterday: limitUpYesterdaySet.has(snap.symbol),
  };
}

export const intradayOpportunityWatcher = new IntradayOpportunityWatcher();
