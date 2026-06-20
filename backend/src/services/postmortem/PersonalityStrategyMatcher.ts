/**
 * PersonalityStrategyMatcher — L8-Postmortem / US-127 [PM-025] 性格 vs 策略匹配度
 *
 * 输入 (user_id, period_end) → 取近 lookback_days (默认 90) 天 PaperTradingTrade
 *   + 当前 PaperTradingPosition + 当前 QuantStrategyWeight (action != 'disabled')
 *   + QuantStrategyModel → 反推 personality (preferred_industries / risk_tolerance /
 *   trade_frequency / holding_period) + 策略画像 (industries_focus / expected_vol /
 *   turnover_class / hold_class) → 算单策略 match_score (0..100, 5 维加分制) →
 *   overall_score = weighted avg + best/worst + suggestions[] → heuristic ≤ 500 字
 *   summary → upsert PersonalityStrategyMatchReport. 永不 throw.
 *
 * EV-011 / 后续 story MONTHLY_PERSONALITY_MATCH cron 每月 1 号 09:00 对所有 active
 * 用户调本 service 的 matchForUser. 本 story 只做 service + model + migration + 单测;
 * cron 接入留给 EV-011.
 *
 * ─── 设计 (与 [[ErrorPatternAggregator]] / [[AIDiaryService]] 5 件套对齐) ─────────
 *
 * (1) 常量 / 类型 / 纯函数 helpers 全 export 便于单测
 * (2) PersonalityStrategyMatcherDataSource interface 把所有 I/O 抽干净 — 单测
 *     注入 fake 完全脱离 DB
 * (3) createProductionPersonalityStrategyMatcherDataSource() lazy-require model
 * (4) 主入口 matchForUser 三层 fail-OPEN — 任何异常 → status='failed' 留痕
 *
 * ─── fail-OPEN 三层 ─────────────────────────────────────────────────────────
 *
 * - load* throw → status='failed' reason='load_threw' 仍尝试 upsert 留痕
 *   (空 personality + 空 strategies + 空 matches + summary='')
 * - 无 trade && 无 active 策略 → status='skipped' reason='no_data' 留痕
 * - upsert 失败 → 顶层 try/catch + logger.warn, 返 persisted=false 不抛
 *
 * ─── (user_id, period_end) idempotent ─────────────────────────────────────
 *
 * 与 PersonalityStrategyMatchReport (user_id, period_end) UNIQUE 索引对齐 —
 * 月度 cron 重跑 (cron 第二次跑 / 手动 replay) 覆盖最新结果. sequelize upsert
 * 走 ON CONFLICT.
 */

import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** PRD 默认 90 天画像窗口 (与 [[ErrorPatternAggregator.DEFAULT_LOOKBACK_DAYS]] 一致). */
export const DEFAULT_LOOKBACK_DAYS = 90;

/** heuristic summary cap (与 [[ErrorPatternAggregator.ERROR_PATTERN_SUMMARY_MAX_CHARS]] 一致). */
export const PERSONALITY_MATCH_SUMMARY_MAX_CHARS = 500;

/** 偏好行业 top N (UI 卡片显示). */
export const PREFERRED_INDUSTRIES_TOP_N = 5;

/** suggestions 上限 — PRD AC "至少 1 条" 主验收, ≤ N 防 UI 列表炸. */
export const SUGGESTIONS_MAX = 5;

/** 单条 reason 长度 cap (UI 单行). */
export const REASON_MAX_CHARS = 60;

/** trade_frequency 分档阈值 — 每日均 trade 次数. */
export const TRADE_FREQ_HIGH_PER_DAY = 1.0;
export const TRADE_FREQ_MEDIUM_PER_DAY = 0.2;

/** holding_period 分档 — 平均持有天数. */
export const HOLD_LONG_MIN_DAYS = 30;
export const HOLD_MEDIUM_MIN_DAYS = 7;

/** risk_tolerance 分档 — 日 pnl 标准差 (百分点). */
export const VOL_HIGH_PCT = 2.0;
export const VOL_MEDIUM_PCT = 0.8;

/**
 * 单策略 match_score 5 维加分制 (每维 20 分, 满 100).
 *   - industry_overlap   行业偏好命中
 *   - vol_match          风险偏好对齐
 *   - turnover_match     频率对齐 (turnover_class vs trade_frequency)
 *   - hold_match         持仓周期对齐
 *   - quality_bonus      策略质量分 (quality_score 0..1 直接映射到 20 分)
 */
export const MATCH_DIMENSION_POINTS = 20;
export const MATCH_DIMENSIONS = Object.freeze([
  'industry_overlap',
  'vol_match',
  'turnover_match',
  'hold_match',
  'quality_bonus',
] as const);

/** overall_score 阈值 — 低于此触发"考虑调整组合" 综合建议 (PRD AC 至少 1 条). */
export const OVERALL_SCORE_LOW_THRESHOLD = 50;

/** source 枚举 (与 model.source 字段对齐, 本 story 仅 heuristic). */
export const PERSONALITY_MATCH_SOURCE = Object.freeze({
  HEURISTIC: 'heuristic',
  LLM: 'llm',
  MANUAL: 'manual',
} as const);

export type PersonalityMatchSource =
  (typeof PERSONALITY_MATCH_SOURCE)[keyof typeof PERSONALITY_MATCH_SOURCE];

/** status 枚举 (与 model.status 字段对齐, fail-OPEN 三态). */
export const PERSONALITY_MATCH_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const);

export type PersonalityMatchStatus =
  (typeof PERSONALITY_MATCH_STATUS)[keyof typeof PERSONALITY_MATCH_STATUS];

/** suggestion severity / category 枚举. */
export const SUGGESTION_SEVERITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const);

export type SuggestionSeverity = (typeof SUGGESTION_SEVERITY)[keyof typeof SUGGESTION_SEVERITY];

export const SUGGESTION_CATEGORY = Object.freeze({
  ADD: 'add',
  REDUCE: 'reduce',
  REMOVE: 'remove',
  TUNE: 'tune',
} as const);

export type SuggestionCategory = (typeof SUGGESTION_CATEGORY)[keyof typeof SUGGESTION_CATEGORY];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 单笔 trade 输入 (从 PaperTradingTrade 映射). PRODUCTION DataSource 把 row.toJSON()
 * 映射成本类型, service 本身不依赖 sequelize 实例类型.
 */
export interface TradeRecord {
  symbol: string;
  industry: string | null;
  direction: 'BUY' | 'SELL' | string;
  amount: number;
  trade_date: string; // 'YYYY-MM-DD'
}

/** 单笔 holding (从 PaperTradingPosition 映射). */
export interface PositionRecord {
  symbol: string;
  industry: string | null;
  market_value: number;
  /** opened_at 反推 hold days; 缺则按 0 算. */
  opened_at?: string | null;
}

/** 当前 active 策略 (从 QuantStrategyWeight join QuantStrategyModel 映射). */
export interface ActiveStrategyRecord {
  strategy_key: string;
  strategy_name: string | null;
  category: string | null;
  weight: number;
  /** 'observe' / 'enabled' / 'gated' / 'disabled' — service 仅吃非 disabled. */
  action: string;
  /** 0..1 — 缺则 null. */
  quality_score: number | null;
  tags: string[];
  /** 用于反推 industries_focus (e.g. ['行业:白酒', '行业:消费'] 或 ['白酒', '消费']). */
  default_params: Record<string, unknown>;
}

/** 近 lookback 日 pnl 序列 (反推 volatility). 缺则 personality.estimated_volatility=0. */
export interface DailyPnlPoint {
  date: string;
  pnl_pct: number;
}

export interface Personality {
  preferred_industries: Array<{ industry: string; share: number }>;
  risk_tolerance: 'low' | 'medium' | 'high';
  trade_frequency: 'low' | 'medium' | 'high';
  holding_period: 'short' | 'medium' | 'long';
  avg_hold_days: number;
  estimated_volatility: number;
}

export interface StrategyProfileItem {
  strategy_key: string;
  strategy_name: string;
  weight: number;
  industries_focus: string[];
  expected_vol: 'low' | 'medium' | 'high';
  turnover_class: 'low' | 'medium' | 'high';
  hold_class: 'short' | 'medium' | 'long';
  quality_score: number | null;
  match_score: number;
  match_reasons: string[];
}

export interface MatchSuggestion {
  severity: SuggestionSeverity;
  category: SuggestionCategory;
  strategy_key: string | null;
  text: string;
}

export interface Matches {
  overall_score: number;
  best_match: { strategy_key: string; score: number } | null;
  worst_match: { strategy_key: string; score: number } | null;
  suggestions: MatchSuggestion[];
}

export interface PersonalityMatchUpsertRow {
  user_id: number;
  period_start: string;
  period_end: string;
  lookback_days: number;
  personality: Record<string, unknown>;
  strategies: Record<string, unknown>;
  matches: Record<string, unknown>;
  summary: string;
  source: string;
  status: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  generated_at: Date;
}

export interface PersonalityStrategyMatcherDataSource {
  loadTrades(input: {
    user_id: number;
    period_start: string;
    period_end: string;
  }): Promise<TradeRecord[]>;
  loadPositions(input: { user_id: number }): Promise<PositionRecord[]>;
  loadActiveStrategies(): Promise<ActiveStrategyRecord[]>;
  /** 缺数据返 []; service 不强依赖. */
  loadDailyPnl(input: {
    user_id: number;
    period_start: string;
    period_end: string;
  }): Promise<DailyPnlPoint[]>;
  upsertPersonalityMatchReport(
    row: PersonalityMatchUpsertRow
  ): Promise<{ ok: boolean; reason?: string; error?: string }>;
}

export interface MatchForUserResult {
  status: PersonalityMatchStatus;
  personality: Personality;
  strategies: StrategyProfileItem[];
  matches: Matches;
  summary: string;
  reason: string | null;
  persisted: boolean;
}

// ---------------------------------------------------------------------------
// pure helpers — date math + safe coerce
// ---------------------------------------------------------------------------

/**
 * 计算 period_start = period_end - (lookbackDays - 1) (含 period_end 当天).
 * 与 [[ErrorPatternAggregator.computePeriodStart]] 同款契约.
 * 输入 / 输出均为 'YYYY-MM-DD'. period_end 非法 → 返 period_end 兜底 (空窗口).
 */
export function computePeriodStart(periodEnd: string, lookbackDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(periodEnd);
  if (!m) return periodEnd;
  const safeLookback = lookbackDays > 0 ? lookbackDays : DEFAULT_LOOKBACK_DAYS;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - (safeLookback - 1));
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** 计算两个 'YYYY-MM-DD' 之间天数差 (b - a, 任一非法 → 0). */
export function daysBetween(a: string, b: string): number {
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const ma = re.exec(a);
  const mb = re.exec(b);
  if (!ma || !mb) return 0;
  const da = Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]));
  const db = Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]));
  return Math.round((db - da) / 86400000);
}

function safeFinite(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  const s = String(v);
  return s.length > 0 ? s : fallback;
}

/** 把字符串硬截到 N 字符 (Array.from 计字符避免 surrogate pair 切坏). */
export function clampChars(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

// ---------------------------------------------------------------------------
// pure helpers — 性格画像反推
// ---------------------------------------------------------------------------

/**
 * 按 trade.amount 加权聚合 top N 偏好行业.
 * - 缺 industry 字段一律归 'unknown' 桶
 * - 输出按 share 降序; 同 share 按 industry 字母序 stable tie-break
 */
export function aggregatePreferredIndustries(
  trades: TradeRecord[],
  topN: number = PREFERRED_INDUSTRIES_TOP_N
): Array<{ industry: string; share: number }> {
  const acc = new Map<string, number>();
  let totalAmount = 0;
  for (const t of trades) {
    const amt = safeFinite(t.amount, 0);
    if (amt <= 0) continue;
    const ind = safeString(t.industry, 'unknown') || 'unknown';
    acc.set(ind, (acc.get(ind) || 0) + amt);
    totalAmount += amt;
  }
  if (totalAmount <= 0) return [];
  const out: Array<{ industry: string; share: number }> = [];
  acc.forEach((amount, industry) => {
    out.push({ industry, share: amount / totalAmount });
  });
  out.sort((a, b) => b.share - a.share || (a.industry < b.industry ? -1 : 1));
  return out.slice(0, Math.max(0, topN));
}

/**
 * 日 pnl 标准差 (百分点). pnl_pct 字段一般 = 当日盈亏占总资产 %, 值域 e.g. -3.0 ~ 3.0.
 * - 输入 < 2 点 → 返 0 (样本不足)
 * - 非 finite 过滤
 */
export function estimateVolatility(pnls: DailyPnlPoint[]): number {
  const xs: number[] = [];
  for (const p of pnls) {
    const v = safeFinite(p.pnl_pct, NaN);
    if (Number.isFinite(v)) xs.push(v);
  }
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const variance = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length;
  const sd = Math.sqrt(variance);
  return Number.isFinite(sd) ? sd : 0;
}

export function classifyRiskTolerance(volPct: number): 'low' | 'medium' | 'high' {
  if (volPct >= VOL_HIGH_PCT) return 'high';
  if (volPct >= VOL_MEDIUM_PCT) return 'medium';
  return 'low';
}

export function classifyTradeFrequency(
  tradeCount: number,
  lookbackDays: number
): 'low' | 'medium' | 'high' {
  if (lookbackDays <= 0) return 'low';
  const per = tradeCount / lookbackDays;
  if (per >= TRADE_FREQ_HIGH_PER_DAY) return 'high';
  if (per >= TRADE_FREQ_MEDIUM_PER_DAY) return 'medium';
  return 'low';
}

export function classifyHoldingPeriod(avgDays: number): 'short' | 'medium' | 'long' {
  if (avgDays >= HOLD_LONG_MIN_DAYS) return 'long';
  if (avgDays >= HOLD_MEDIUM_MIN_DAYS) return 'medium';
  return 'short';
}

/**
 * 平均持有天数 = 当前 positions 的 (period_end - opened_at) 平均 (≥ 0; 缺则按 0).
 * 无 positions → 0.
 */
export function avgHoldDays(positions: PositionRecord[], periodEnd: string): number {
  if (!positions.length) return 0;
  let sum = 0;
  let n = 0;
  for (const p of positions) {
    if (!p.opened_at) {
      sum += 0;
      n += 1;
      continue;
    }
    const d = daysBetween(p.opened_at, periodEnd);
    sum += d > 0 ? d : 0;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * buildPersonality — 把 trades / positions / pnls + lookback_days 折成 Personality.
 */
export function buildPersonality(input: {
  trades: TradeRecord[];
  positions: PositionRecord[];
  pnls: DailyPnlPoint[];
  period_end: string;
  lookback_days: number;
}): Personality {
  const preferred_industries = aggregatePreferredIndustries(input.trades);
  const estimated_volatility = estimateVolatility(input.pnls);
  const risk_tolerance = classifyRiskTolerance(estimated_volatility);
  const trade_frequency = classifyTradeFrequency(input.trades.length, input.lookback_days);
  const avg_hold_days = avgHoldDays(input.positions, input.period_end);
  const holding_period = classifyHoldingPeriod(avg_hold_days);
  return {
    preferred_industries,
    risk_tolerance,
    trade_frequency,
    holding_period,
    avg_hold_days,
    estimated_volatility,
  };
}

// ---------------------------------------------------------------------------
// pure helpers — 策略画像反推
// ---------------------------------------------------------------------------

/**
 * 从 strategy.tags + default_params 反推 industries_focus.
 *   - tag 形如 '行业:白酒' / 'industry:消费' / '白酒' (3 种格式)
 *   - default_params.industries / target_industries / focus_industries (3 种 key)
 *   - 去重 stable order, 最多 10 条
 */
export function inferStrategyIndustries(s: ActiveStrategyRecord): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    const str = safeString(raw).trim();
    if (!str) return;
    // 去掉前缀 '行业:' / 'industry:'
    const cleaned = str.replace(/^(行业[:：]|industry[:：])/i, '').trim();
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };
  const tags = Array.isArray(s.tags) ? s.tags : [];
  for (const tag of tags) push(tag);
  const dp = s.default_params || {};
  for (const key of ['industries', 'target_industries', 'focus_industries']) {
    const v = (dp as Record<string, unknown>)[key];
    if (Array.isArray(v)) v.forEach(push);
    else if (typeof v === 'string') push(v);
  }
  return out.slice(0, 10);
}

/**
 * 从 strategy.category / tags 推断 expected_vol.
 *   - 'momentum' / 'breakout' / 'cta' / 'high_vol' → high
 *   - 'mean_reversion' / 'value' / 'dividend' / 'low_vol' → low
 *   - 其它 → medium
 */
export function inferStrategyVol(s: ActiveStrategyRecord): 'low' | 'medium' | 'high' {
  const blob = `${safeString(s.category)} ${(s.tags || []).join(' ')}`.toLowerCase();
  if (/(momentum|breakout|cta|high[-_ ]?vol|动量|突破)/.test(blob)) return 'high';
  if (/(mean[-_ ]?reversion|value|dividend|low[-_ ]?vol|高股息|价值|低波)/.test(blob)) return 'low';
  return 'medium';
}

/**
 * 从 category / tags 推断 turnover_class (近似交易频率).
 *   - 'intraday' / 'daily' / 'cta' → high
 *   - 'weekly' / 'swing' → medium
 *   - 'monthly' / 'value' / 'dividend' / 'low_freq' → low
 *   - default medium
 */
export function inferStrategyTurnover(s: ActiveStrategyRecord): 'low' | 'medium' | 'high' {
  const blob = `${safeString(s.category)} ${(s.tags || []).join(' ')}`.toLowerCase();
  if (/(intraday|daily|cta|日频|日内)/.test(blob)) return 'high';
  if (/(weekly|swing|周频|波段)/.test(blob)) return 'medium';
  if (/(monthly|value|dividend|low[-_ ]?freq|月频|价值|高股息|低频)/.test(blob)) return 'low';
  return 'medium';
}

/**
 * 从 category / tags 推断 hold_class.
 *   - 'short' / 'intraday' / 'cta' → short
 *   - 'long' / 'value' / 'dividend' / 'monthly' → long
 *   - default medium
 */
export function inferStrategyHoldClass(s: ActiveStrategyRecord): 'short' | 'medium' | 'long' {
  const blob = `${safeString(s.category)} ${(s.tags || []).join(' ')}`.toLowerCase();
  if (/(short|intraday|cta|日内|短线)/.test(blob)) return 'short';
  if (/(long|value|dividend|monthly|长期|价值|高股息|月度)/.test(blob)) return 'long';
  return 'medium';
}

// ---------------------------------------------------------------------------
// pure helpers — 单策略 match_score 5 维加分
// ---------------------------------------------------------------------------

/**
 * industry_overlap — 用户偏好行业 vs 策略 industries_focus 的命中份额 × 20.
 * - 用户偏好为空 → 直接返 MATCH_DIMENSION_POINTS (无偏好不扣分)
 * - 策略 industries_focus 为空 → 返 0.6 × MATCH_DIMENSION_POINTS (中性)
 */
export function scoreIndustryOverlap(
  preferred: Array<{ industry: string; share: number }>,
  strategyIndustries: string[]
): { points: number; reason: string } {
  if (!preferred.length) {
    return { points: MATCH_DIMENSION_POINTS, reason: '用户无明显行业偏好, 行业维度中性满分.' };
  }
  if (!strategyIndustries.length) {
    return {
      points: MATCH_DIMENSION_POINTS * 0.6,
      reason: '策略未声明行业焦点, 行业维度中性给分.',
    };
  }
  const focusSet = new Set(strategyIndustries.map(s => s.toLowerCase()));
  let hitShare = 0;
  const hits: string[] = [];
  for (const p of preferred) {
    if (focusSet.has(p.industry.toLowerCase())) {
      hitShare += p.share;
      hits.push(p.industry);
    }
  }
  const points = MATCH_DIMENSION_POINTS * Math.min(1, hitShare);
  const reason = hits.length
    ? `策略覆盖偏好行业 ${hits.join('/')}, 命中份额 ${(hitShare * 100).toFixed(0)}%.`
    : '策略未覆盖任何偏好行业.';
  return { points, reason };
}

/** 任意两个三档枚举的距离: same=0, adj=1, opposite=2. */
function tierDistance3(
  a: 'low' | 'medium' | 'high' | 'short' | 'long',
  b: 'low' | 'medium' | 'high' | 'short' | 'long'
): number {
  const order: Record<string, number> = {
    low: 0,
    short: 0,
    medium: 1,
    high: 2,
    long: 2,
  };
  const da = order[a];
  const db = order[b];
  if (da == null || db == null) return 1;
  return Math.abs(da - db);
}

/** 三档对齐 → 距离 0/1/2 → 满分/0.5/0. */
function tierScore(
  a: 'low' | 'medium' | 'high' | 'short' | 'long',
  b: 'low' | 'medium' | 'high' | 'short' | 'long'
): number {
  const d = tierDistance3(a, b);
  if (d === 0) return MATCH_DIMENSION_POINTS;
  if (d === 1) return MATCH_DIMENSION_POINTS * 0.5;
  return 0;
}

export function scoreVolMatch(
  userTol: 'low' | 'medium' | 'high',
  stratVol: 'low' | 'medium' | 'high'
): { points: number; reason: string } {
  const points = tierScore(userTol, stratVol);
  const reason =
    userTol === stratVol
      ? `风险偏好与策略波动均为 ${userTol}, 完全匹配.`
      : `用户偏好 ${userTol} 风险, 策略波动 ${stratVol}, ${
          points > 0 ? '相邻可接受' : '严重失配'
        }.`;
  return { points, reason };
}

export function scoreTurnoverMatch(
  userFreq: 'low' | 'medium' | 'high',
  stratTurn: 'low' | 'medium' | 'high'
): { points: number; reason: string } {
  const points = tierScore(userFreq, stratTurn);
  const reason =
    userFreq === stratTurn
      ? `交易频率与策略换手均为 ${userFreq}, 完全匹配.`
      : `用户交易频率 ${userFreq}, 策略换手 ${stratTurn}, ${
          points > 0 ? '相邻可接受' : '严重失配'
        }.`;
  return { points, reason };
}

export function scoreHoldMatch(
  userHold: 'short' | 'medium' | 'long',
  stratHold: 'short' | 'medium' | 'long'
): { points: number; reason: string } {
  const points = tierScore(userHold, stratHold);
  const reason =
    userHold === stratHold
      ? `持仓周期与策略一致 (${userHold}).`
      : `用户偏好 ${userHold} 持仓, 策略偏好 ${stratHold} 持仓, ${
          points > 0 ? '相邻可接受' : '严重失配'
        }.`;
  return { points, reason };
}

export function scoreQualityBonus(qualityScore: number | null): { points: number; reason: string } {
  if (qualityScore == null || !Number.isFinite(qualityScore)) {
    return {
      points: MATCH_DIMENSION_POINTS * 0.5,
      reason: '策略尚无 quality_score, 中性给分.',
    };
  }
  const clamped = Math.max(0, Math.min(1, qualityScore));
  return {
    points: MATCH_DIMENSION_POINTS * clamped,
    reason: `策略 quality_score ${clamped.toFixed(2)} → 质量加分 ${(
      MATCH_DIMENSION_POINTS * clamped
    ).toFixed(1)}.`,
  };
}

/**
 * 单策略 match_score = 5 维加分总和 (0..100), 同时返 top 3 reason (按 |20 - points|
 * 排序 = 最影响最终分的维度优先 — 既呈现强匹配也呈现强失配).
 */
export function computeStrategyMatch(
  personality: Personality,
  strategy: ActiveStrategyRecord
): {
  match_score: number;
  match_reasons: string[];
  profile: {
    industries_focus: string[];
    expected_vol: 'low' | 'medium' | 'high';
    turnover_class: 'low' | 'medium' | 'high';
    hold_class: 'short' | 'medium' | 'long';
  };
} {
  const industries_focus = inferStrategyIndustries(strategy);
  const expected_vol = inferStrategyVol(strategy);
  const turnover_class = inferStrategyTurnover(strategy);
  const hold_class = inferStrategyHoldClass(strategy);
  const dims = [
    {
      key: 'industry_overlap',
      ...scoreIndustryOverlap(personality.preferred_industries, industries_focus),
    },
    { key: 'vol_match', ...scoreVolMatch(personality.risk_tolerance, expected_vol) },
    { key: 'turnover_match', ...scoreTurnoverMatch(personality.trade_frequency, turnover_class) },
    { key: 'hold_match', ...scoreHoldMatch(personality.holding_period, hold_class) },
    { key: 'quality_bonus', ...scoreQualityBonus(strategy.quality_score) },
  ];
  const match_score = dims.reduce((s, d) => s + d.points, 0);
  // 按"偏离中性 (10 分)"程度排序, 最强匹配 + 最强失配优先, top 3 cap reason
  const sorted = [...dims].sort(
    (a, b) =>
      Math.abs(b.points - MATCH_DIMENSION_POINTS / 2) -
      Math.abs(a.points - MATCH_DIMENSION_POINTS / 2)
  );
  const match_reasons = sorted.slice(0, 3).map(d => clampChars(d.reason, REASON_MAX_CHARS));
  return {
    match_score: Math.round(match_score * 10) / 10,
    match_reasons,
    profile: { industries_focus, expected_vol, turnover_class, hold_class },
  };
}

// ---------------------------------------------------------------------------
// pure helpers — 总体 matches + suggestions
// ---------------------------------------------------------------------------

export function buildStrategyProfiles(
  personality: Personality,
  strategies: ActiveStrategyRecord[]
): StrategyProfileItem[] {
  const out: StrategyProfileItem[] = [];
  for (const s of strategies) {
    const { match_score, match_reasons, profile } = computeStrategyMatch(personality, s);
    out.push({
      strategy_key: s.strategy_key,
      strategy_name: s.strategy_name || s.strategy_key,
      weight: safeFinite(s.weight, 0),
      industries_focus: profile.industries_focus,
      expected_vol: profile.expected_vol,
      turnover_class: profile.turnover_class,
      hold_class: profile.hold_class,
      quality_score: s.quality_score,
      match_score,
      match_reasons,
    });
  }
  // 按 weight 降序, 同 weight 按 strategy_key 字母序稳定排序 (UI 顺序)
  out.sort((a, b) => b.weight - a.weight || (a.strategy_key < b.strategy_key ? -1 : 1));
  return out;
}

/**
 * overall_score = sum(weight × match_score) / sum(weight). 全 weight=0 → 平均.
 * 输出 0..100, 1 位小数. 空数组 → 0.
 */
export function computeOverallScore(items: StrategyProfileItem[]): number {
  if (!items.length) return 0;
  let wsum = 0;
  let psum = 0;
  for (const it of items) {
    const w = it.weight > 0 ? it.weight : 0;
    wsum += w;
    psum += w * it.match_score;
  }
  if (wsum > 0) return Math.round((psum / wsum) * 10) / 10;
  const avg = items.reduce((s, it) => s + it.match_score, 0) / items.length;
  return Math.round(avg * 10) / 10;
}

/**
 * 生成 suggestions[]: PRD AC "至少 1 条". 规则:
 *   - 单策略 match_score < 40 → 'remove' high
 *   - 单策略 match_score < 60 → 'reduce' medium
 *   - 单策略 match_score ≥ 80 → 'add' low (鼓励加权)
 *   - overall_score < OVERALL_SCORE_LOW_THRESHOLD → 'tune' high 综合建议
 *   - 空 strategies → 1 条 'add' low 通用建议
 *   - 无任何上述触发 → 1 条 'tune' low 通用建议 (兜底)
 * 按 severity (high > medium > low) 排序, ≤ SUGGESTIONS_MAX.
 */
export function buildSuggestions(
  personality: Personality,
  items: StrategyProfileItem[],
  overallScore: number
): MatchSuggestion[] {
  const out: MatchSuggestion[] = [];
  if (!items.length) {
    out.push({
      severity: SUGGESTION_SEVERITY.LOW,
      category: SUGGESTION_CATEGORY.ADD,
      strategy_key: null,
      text: clampChars(
        `当前无活跃策略, 建议挑选 1-2 个与 ${personality.risk_tolerance} 风险偏好匹配的策略上线观察.`,
        REASON_MAX_CHARS * 2
      ),
    });
    return out;
  }
  for (const it of items) {
    if (it.match_score < 40) {
      out.push({
        severity: SUGGESTION_SEVERITY.HIGH,
        category: SUGGESTION_CATEGORY.REMOVE,
        strategy_key: it.strategy_key,
        text: clampChars(
          `策略 ${it.strategy_name} 与画像匹配度仅 ${it.match_score} 分, 建议关停或加严准入.`,
          REASON_MAX_CHARS * 2
        ),
      });
    } else if (it.match_score < 60) {
      out.push({
        severity: SUGGESTION_SEVERITY.MEDIUM,
        category: SUGGESTION_CATEGORY.REDUCE,
        strategy_key: it.strategy_key,
        text: clampChars(
          `策略 ${it.strategy_name} 匹配度 ${it.match_score} 分偏低, 建议把权重降至 50% 以下并加强复盘.`,
          REASON_MAX_CHARS * 2
        ),
      });
    } else if (it.match_score >= 80) {
      out.push({
        severity: SUGGESTION_SEVERITY.LOW,
        category: SUGGESTION_CATEGORY.ADD,
        strategy_key: it.strategy_key,
        text: clampChars(
          `策略 ${it.strategy_name} 匹配度 ${it.match_score} 分较高, 可在风控允许下适当加权.`,
          REASON_MAX_CHARS * 2
        ),
      });
    }
  }
  if (overallScore < OVERALL_SCORE_LOW_THRESHOLD) {
    out.push({
      severity: SUGGESTION_SEVERITY.HIGH,
      category: SUGGESTION_CATEGORY.TUNE,
      strategy_key: null,
      text: clampChars(
        `整体匹配度 ${overallScore} 分偏低, 建议重新对齐用户性格 (${personality.risk_tolerance}/${personality.holding_period}) 与策略组合.`,
        REASON_MAX_CHARS * 2
      ),
    });
  }
  if (!out.length) {
    out.push({
      severity: SUGGESTION_SEVERITY.LOW,
      category: SUGGESTION_CATEGORY.TUNE,
      strategy_key: null,
      text: clampChars(
        `整体匹配度 ${overallScore} 分尚可, 维持当前组合并持续观察策略 quality_score 与执行效果.`,
        REASON_MAX_CHARS * 2
      ),
    });
  }
  const sevOrder: Record<SuggestionSeverity, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  out.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  return out.slice(0, SUGGESTIONS_MAX);
}

export function buildMatches(items: StrategyProfileItem[], personality: Personality): Matches {
  const overall_score = computeOverallScore(items);
  let best: { strategy_key: string; score: number } | null = null;
  let worst: { strategy_key: string; score: number } | null = null;
  for (const it of items) {
    if (best == null || it.match_score > best.score) {
      best = { strategy_key: it.strategy_key, score: it.match_score };
    }
    if (worst == null || it.match_score < worst.score) {
      worst = { strategy_key: it.strategy_key, score: it.match_score };
    }
  }
  return {
    overall_score,
    best_match: best,
    worst_match: worst,
    suggestions: buildSuggestions(personality, items, overall_score),
  };
}

// ---------------------------------------------------------------------------
// pure helpers — heuristic summary
// ---------------------------------------------------------------------------

/**
 * heuristic summary — 永远 ≤ PERSONALITY_MATCH_SUMMARY_MAX_CHARS 字 (与
 * ErrorPatternAggregator.buildHeuristicSummary 同款契约). 描述 personality
 * + best/worst + 综合建议. 空数据时给简短占位.
 */
export function buildHeuristicSummary(
  personality: Personality,
  strategies: StrategyProfileItem[],
  matches: Matches,
  periodStart: string,
  periodEnd: string
): string {
  const parts: string[] = [];
  parts.push(`${periodStart}~${periodEnd} 性格 vs 策略匹配度报告.`);
  const indStr =
    personality.preferred_industries.length > 0
      ? personality.preferred_industries
          .slice(0, 3)
          .map(p => `${p.industry}(${(p.share * 100).toFixed(0)}%)`)
          .join('/')
      : '无明显偏好';
  parts.push(
    `用户画像: 风险=${personality.risk_tolerance}, 频率=${personality.trade_frequency}, 周期=${
      personality.holding_period
    }(均 ${personality.avg_hold_days.toFixed(
      1
    )}天), 估算波动=${personality.estimated_volatility.toFixed(2)}%, 偏好行业=${indStr}.`
  );
  if (!strategies.length) {
    parts.push('当前无活跃策略, 暂无匹配可评分.');
  } else {
    parts.push(
      `活跃策略 ${strategies.length} 个, 整体匹配度 ${matches.overall_score} 分 (满分 100).`
    );
    if (matches.best_match) {
      parts.push(`最匹配: ${matches.best_match.strategy_key} (${matches.best_match.score} 分).`);
    }
    if (
      matches.worst_match &&
      matches.worst_match.strategy_key !== matches.best_match?.strategy_key
    ) {
      parts.push(
        `最不匹配: ${matches.worst_match.strategy_key} (${matches.worst_match.score} 分).`
      );
    }
  }
  if (matches.suggestions.length > 0) {
    parts.push(`主要建议: ${matches.suggestions[0].text}`);
  }
  return clampChars(parts.join(' '), PERSONALITY_MATCH_SUMMARY_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * matchForUser — PM-025 主入口.
 *
 * 流程:
 *   (1) computePeriodStart 算 period_start = period_end - lookback_days + 1
 *   (2) 并行 load trades / positions / activeStrategies / dailyPnl
 *       - 任一 load throw → 整体降级 failed 留痕 (空 personality / 空 strategies)
 *   (3) trades 空 && strategies 空 → skipped 留痕
 *   (4) buildPersonality + buildStrategyProfiles + buildMatches + heuristic summary
 *   (5) upsert → 失败 logger.warn 不抛, 返 persisted=false
 *
 * 永不 throw. PRD AC "每月 1 号生成 PersonalityStrategyMatcher 报告, 至少给出 1 条
 * 匹配度建议" 强语义: 任何 cron 跑过都尝试留痕 (status='ok' / 'skipped' / 'failed'
 * 三态都 upsert), 不阻塞下一周期 / 下一用户.
 */
export async function matchForUser(
  userId: number,
  options: {
    period_end: string;
    data_source: PersonalityStrategyMatcherDataSource;
    lookback_days?: number;
    cron_run_id?: string | null;
  }
): Promise<MatchForUserResult> {
  const {
    period_end,
    data_source: ds,
    lookback_days = DEFAULT_LOOKBACK_DAYS,
    cron_run_id,
  } = options;
  const effectiveLookback = lookback_days > 0 ? lookback_days : DEFAULT_LOOKBACK_DAYS;
  const period_start = computePeriodStart(period_end, effectiveLookback);
  const baseMetadata: Record<string, unknown> = {
    lookback_days: effectiveLookback,
    data_sources_used: [
      'paper_trading_trade',
      'paper_trading_position',
      'quant_strategy_weight',
      'daily_attribution_report',
    ],
  };
  if (cron_run_id != null) baseMetadata.cron_run_id = cron_run_id;

  // (2) parallel load — 任一 throw 整体降级 failed
  let trades: TradeRecord[] = [];
  let positions: PositionRecord[] = [];
  let strategies: ActiveStrategyRecord[] = [];
  let pnls: DailyPnlPoint[] = [];
  let loadThrew = false;
  let loadErrMsg = '';
  try {
    const [t, p, s, pn] = await Promise.all([
      ds.loadTrades({ user_id: userId, period_start, period_end }),
      ds.loadPositions({ user_id: userId }),
      ds.loadActiveStrategies(),
      ds.loadDailyPnl({ user_id: userId, period_start, period_end }),
    ]);
    trades = Array.isArray(t) ? t : [];
    positions = Array.isArray(p) ? p : [];
    strategies = (Array.isArray(s) ? s : []).filter(x => x && x.action !== 'disabled');
    pnls = Array.isArray(pn) ? pn : [];
  } catch (err) {
    loadThrew = true;
    loadErrMsg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[personality-match] load user=${userId} period_end=${period_end} threw: ${loadErrMsg}`
    );
  }

  if (loadThrew) {
    const emptyPersonality: Personality = {
      preferred_industries: [],
      risk_tolerance: 'low',
      trade_frequency: 'low',
      holding_period: 'short',
      avg_hold_days: 0,
      estimated_volatility: 0,
    };
    const emptyMatches: Matches = {
      overall_score: 0,
      best_match: null,
      worst_match: null,
      suggestions: [],
    };
    const upsertRes = await safeUpsert(ds, {
      user_id: userId,
      period_start,
      period_end,
      lookback_days: effectiveLookback,
      personality: emptyPersonality as unknown as Record<string, unknown>,
      strategies: { items: [] } as Record<string, unknown>,
      matches: emptyMatches as unknown as Record<string, unknown>,
      summary: '',
      source: PERSONALITY_MATCH_SOURCE.HEURISTIC,
      status: PERSONALITY_MATCH_STATUS.FAILED,
      reason: 'load_threw',
      metadata: { ...baseMetadata, error: loadErrMsg },
      generated_at: new Date(),
    });
    return {
      status: PERSONALITY_MATCH_STATUS.FAILED,
      personality: emptyPersonality,
      strategies: [],
      matches: emptyMatches,
      summary: '',
      reason: 'load_threw',
      persisted: upsertRes.ok,
    };
  }

  baseMetadata.trade_count = trades.length;
  baseMetadata.strategy_count = strategies.length;
  baseMetadata.position_count = positions.length;
  baseMetadata.pnl_count = pnls.length;

  // (3) 数据全空 → skipped
  if (trades.length === 0 && strategies.length === 0 && positions.length === 0) {
    const emptyPersonality: Personality = {
      preferred_industries: [],
      risk_tolerance: 'low',
      trade_frequency: 'low',
      holding_period: 'short',
      avg_hold_days: 0,
      estimated_volatility: 0,
    };
    const emptyMatches: Matches = {
      overall_score: 0,
      best_match: null,
      worst_match: null,
      suggestions: [],
    };
    const upsertRes = await safeUpsert(ds, {
      user_id: userId,
      period_start,
      period_end,
      lookback_days: effectiveLookback,
      personality: emptyPersonality as unknown as Record<string, unknown>,
      strategies: { items: [] } as Record<string, unknown>,
      matches: emptyMatches as unknown as Record<string, unknown>,
      summary: '',
      source: PERSONALITY_MATCH_SOURCE.HEURISTIC,
      status: PERSONALITY_MATCH_STATUS.SKIPPED,
      reason: 'no_data',
      metadata: { ...baseMetadata, skipped_reason: 'no_data' },
      generated_at: new Date(),
    });
    return {
      status: PERSONALITY_MATCH_STATUS.SKIPPED,
      personality: emptyPersonality,
      strategies: [],
      matches: emptyMatches,
      summary: '',
      reason: 'no_data',
      persisted: upsertRes.ok,
    };
  }

  // (4) 真匹配
  const personality = buildPersonality({
    trades,
    positions,
    pnls,
    period_end,
    lookback_days: effectiveLookback,
  });
  const strategyProfiles = buildStrategyProfiles(personality, strategies);
  const matches = buildMatches(strategyProfiles, personality);
  const summary = buildHeuristicSummary(
    personality,
    strategyProfiles,
    matches,
    period_start,
    period_end
  );

  // (5) upsert
  const upsertRes = await safeUpsert(ds, {
    user_id: userId,
    period_start,
    period_end,
    lookback_days: effectiveLookback,
    personality: personality as unknown as Record<string, unknown>,
    strategies: { items: strategyProfiles } as Record<string, unknown>,
    matches: matches as unknown as Record<string, unknown>,
    summary,
    source: PERSONALITY_MATCH_SOURCE.HEURISTIC,
    status: PERSONALITY_MATCH_STATUS.OK,
    reason: null,
    metadata: baseMetadata,
    generated_at: new Date(),
  });

  if (!upsertRes.ok) {
    return {
      status: PERSONALITY_MATCH_STATUS.FAILED,
      personality,
      strategies: strategyProfiles,
      matches,
      summary,
      reason: upsertRes.reason || 'upsert_failed',
      persisted: false,
    };
  }
  return {
    status: PERSONALITY_MATCH_STATUS.OK,
    personality,
    strategies: strategyProfiles,
    matches,
    summary,
    reason: null,
    persisted: true,
  };
}

async function safeUpsert(
  ds: PersonalityStrategyMatcherDataSource,
  row: PersonalityMatchUpsertRow
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await ds.upsertPersonalityMatchReport(row);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason || 'upsert_returned_false' };
  } catch (err) {
    logger.warn(
      `[personality-match] upsertPersonalityMatchReport user=${row.user_id} period_end=${
        row.period_end
      } threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ok: false, reason: 'upsert_threw' };
  }
}

// ---------------------------------------------------------------------------
// PRODUCTION DataSource — lazy require model 让 DB-less 单测进程 require 本
// service 不被 sequelize 拽起 DB. 与 [[AIDiaryService]] /
// [[ErrorPatternAggregator]] 同款.
// ---------------------------------------------------------------------------

/**
 * 生产 DataSource 工厂. lazy require 所有 model 让单测进程 (无 PG) 不被 require
 * chain 拽起 sequelize 实例.
 *
 * - loadTrades — 按 user_id 查 PaperTradingPortfolio.id → PaperTradingTrade
 *   WHERE created_at BETWEEN period_start AND period_end + Op.between. Stock
 *   join 取 industry; 任何 throw 内部 try/catch 兜底返 [].
 * - loadPositions — 按 user_id 查 portfolio.id → PaperTradingPosition + Stock join.
 *   opened_at 取 position.created_at (paper trading 不维护单独的 opened_at).
 * - loadActiveStrategies — QuantStrategyWeight WHERE action != 'disabled' join
 *   QuantStrategyModel 取 name/category/tags/default_params.
 * - loadDailyPnl — DailyAttributionReport WHERE date BETWEEN + status='ok',
 *   pnl_pct = total_pnl_pct.
 * - upsertPersonalityMatchReport — 走 PersonalityStrategyMatchReport.upsert
 *   利用 (user_id, period_end) UNIQUE 索引的 ON CONFLICT.
 *
 * 任何 throw 内部 try/catch 兜底, **永不向上抛**.
 */
export function createProductionPersonalityStrategyMatcherDataSource(): PersonalityStrategyMatcherDataSource {
  return {
    async loadTrades({ user_id, period_start, period_end }) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PaperTradingPortfolio } = require('../../models/PaperTradingPortfolio');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PaperTradingTrade } = require('../../models/PaperTradingTrade');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Stock } = require('../../models/Stock');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Op } = require('sequelize');
        const portfolios = await PaperTradingPortfolio.findAll({
          where: { user_id, is_active: true },
          attributes: ['id'],
        });
        const portfolioIds = portfolios.map((p: { id: number }) => p.id);
        if (!portfolioIds.length) return [];
        // period_start 'YYYY-MM-DD' → start-of-day; period_end → end-of-day.
        const startTs = new Date(`${period_start}T00:00:00Z`);
        const endTs = new Date(`${period_end}T23:59:59Z`);
        const trades = await PaperTradingTrade.findAll({
          where: {
            portfolio_id: { [Op.in]: portfolioIds },
            created_at: { [Op.between]: [startTs, endTs] },
          },
        });
        // 一次拉取 Stock map symbol→industry (避免 N+1)
        const symbols: string[] = Array.from(
          new Set(trades.map((t: { symbol: string }) => t.symbol).filter(Boolean))
        );
        const stocks = symbols.length
          ? await Stock.findAll({
              where: { symbol: { [Op.in]: symbols } },
              attributes: ['symbol', 'industry'],
            })
          : [];
        const industryMap = new Map<string, string | null>();
        for (const s of stocks) {
          const j = typeof s.toJSON === 'function' ? s.toJSON() : s;
          industryMap.set(String(j.symbol), j.industry == null ? null : String(j.industry));
        }
        return trades.map((r: { toJSON?: () => Record<string, unknown> }) => {
          const j = typeof r.toJSON === 'function' ? r.toJSON() : (r as Record<string, unknown>);
          const sym = safeString(j.symbol);
          const created =
            j.created_at instanceof Date ? j.created_at : new Date(String(j.created_at));
          const ymd = Number.isFinite(created.getTime())
            ? created.toISOString().slice(0, 10)
            : period_end;
          return {
            symbol: sym,
            industry: industryMap.get(sym) ?? null,
            direction: safeString(j.direction) || 'BUY',
            amount: safeFinite(j.amount, 0),
            trade_date: ymd,
          };
        });
      } catch (err) {
        logger.warn(
          `[personality-match] PRODUCTION loadTrades user=${user_id} period=${period_start}~${period_end} threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },
    async loadPositions({ user_id }) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PaperTradingPortfolio } = require('../../models/PaperTradingPortfolio');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PaperTradingPosition } = require('../../models/PaperTradingPosition');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Stock } = require('../../models/Stock');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Op } = require('sequelize');
        const portfolios = await PaperTradingPortfolio.findAll({
          where: { user_id, is_active: true },
          attributes: ['id'],
        });
        const portfolioIds = portfolios.map((p: { id: number }) => p.id);
        if (!portfolioIds.length) return [];
        const positions = await PaperTradingPosition.findAll({
          where: { portfolio_id: { [Op.in]: portfolioIds } },
        });
        const symbols: string[] = Array.from(
          new Set(positions.map((p: { symbol: string }) => p.symbol).filter(Boolean))
        );
        const stocks = symbols.length
          ? await Stock.findAll({
              where: { symbol: { [Op.in]: symbols } },
              attributes: ['symbol', 'industry'],
            })
          : [];
        const industryMap = new Map<string, string | null>();
        for (const s of stocks) {
          const j = typeof s.toJSON === 'function' ? s.toJSON() : s;
          industryMap.set(String(j.symbol), j.industry == null ? null : String(j.industry));
        }
        return positions.map((r: { toJSON?: () => Record<string, unknown> }) => {
          const j = typeof r.toJSON === 'function' ? r.toJSON() : (r as Record<string, unknown>);
          const sym = safeString(j.symbol);
          const created =
            j.created_at instanceof Date ? j.created_at : new Date(String(j.created_at));
          const opened_at = Number.isFinite(created.getTime())
            ? created.toISOString().slice(0, 10)
            : null;
          return {
            symbol: sym,
            industry: industryMap.get(sym) ?? null,
            market_value: safeFinite(j.market_value, 0),
            opened_at,
          };
        });
      } catch (err) {
        logger.warn(
          `[personality-match] PRODUCTION loadPositions user=${user_id} threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },
    async loadActiveStrategies() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { QuantStrategyWeight } = require('../../models/QuantStrategyWeight');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { QuantStrategyModel } = require('../../models/QuantStrategyModel');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Op } = require('sequelize');
        const weights = await QuantStrategyWeight.findAll({
          where: { action: { [Op.ne]: 'disabled' } },
        });
        const keys: string[] = Array.from(
          new Set(weights.map((w: { strategy_key: string }) => w.strategy_key).filter(Boolean))
        );
        const models = keys.length
          ? await QuantStrategyModel.findAll({
              where: { strategy_key: { [Op.in]: keys } },
            })
          : [];
        const modelMap = new Map<string, Record<string, unknown>>();
        for (const m of models) {
          const j = typeof m.toJSON === 'function' ? m.toJSON() : m;
          modelMap.set(String(j.strategy_key), j);
        }
        return weights.map((r: { toJSON?: () => Record<string, unknown> }) => {
          const j = typeof r.toJSON === 'function' ? r.toJSON() : (r as Record<string, unknown>);
          const key = safeString(j.strategy_key);
          const m = modelMap.get(key) || {};
          return {
            strategy_key: key,
            strategy_name: safeString(j.strategy_name) || safeString(m.name) || key,
            category: safeString(m.category) || null,
            weight: safeFinite(j.weight, 0),
            action: safeString(j.action) || 'observe',
            quality_score:
              j.quality_score == null
                ? null
                : Number.isFinite(Number(j.quality_score))
                ? Number(j.quality_score)
                : null,
            tags: Array.isArray(m.tags) ? (m.tags as string[]) : [],
            default_params:
              m.default_params && typeof m.default_params === 'object'
                ? (m.default_params as Record<string, unknown>)
                : {},
          };
        });
      } catch (err) {
        logger.warn(
          `[personality-match] PRODUCTION loadActiveStrategies threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },
    async loadDailyPnl({ user_id, period_start, period_end }) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DailyAttributionReport } = require('../../models/DailyAttributionReport');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Op } = require('sequelize');
        const rows = await DailyAttributionReport.findAll({
          where: {
            user_id,
            status: 'ok',
            date: { [Op.between]: [period_start, period_end] },
          },
          order: [['date', 'ASC']],
        });
        return rows.map((r: { toJSON?: () => Record<string, unknown> }) => {
          const j = typeof r.toJSON === 'function' ? r.toJSON() : (r as Record<string, unknown>);
          return {
            date: String(j.date ?? ''),
            pnl_pct:
              j.total_pnl_pct == null
                ? 0
                : Number.isFinite(Number(j.total_pnl_pct))
                ? Number(j.total_pnl_pct)
                : 0,
          };
        });
      } catch (err) {
        logger.warn(
          `[personality-match] PRODUCTION loadDailyPnl user=${user_id} period=${period_start}~${period_end} threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },
    async upsertPersonalityMatchReport(row) {
      try {
        const {
          PersonalityStrategyMatchReport,
          // eslint-disable-next-line @typescript-eslint/no-var-requires
        } = require('../../models/PersonalityStrategyMatchReport');
        await PersonalityStrategyMatchReport.upsert(row);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[personality-match] PRODUCTION upsertPersonalityMatchReport user=${row.user_id} period_end=${row.period_end} threw: ${msg}`
        );
        return { ok: false, reason: 'upsert_threw', error: msg };
      }
    },
  };
}
