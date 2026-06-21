/**
 * US-042 / FE-003 「今日交易计划」纯函数 helper —— 把 3 个策略 (multi_factor /
 * dragon_head / earnings_surprise) 当日 BUY 信号拍平 → 去重 → 排序成一条统一的
 * "今日可下单清单"。
 *
 * 设计原则 (与 backend pure helper 同款 — US-026/028/029 风格)：
 *   - 输入 TodaySignalsData (来自 /api/today/signals), 输出 TradingPlanRow[];
 *   - 同股出现在多策略 (e.g. 多因子 + 业绩超预期) 时 dedup 到一行, sources
 *     array 保留所有命中策略; 排序 priority 取最高的 (high > medium > low);
 *   - 完全 pure: 不调网络 / 不读 state / 同输入永远同输出 — 便于 future 单测 +
 *     UI render path 可信赖.
 *
 * priority 决策表 (low / medium / high):
 *   - high   = 任一 source 是 dragon_head (连板龙头, 当日即买入即可能涨停封板,
 *              错过 1 天就买不到) OR earnings_surprise 且 profit_change_low ≥ 100%
 *   - medium = earnings_surprise (业绩超预期, 短期机会) OR multi_factor 且
 *              composite_score ≥ 0.6 (alpha 显著)
 *   - low    = 其它 (multi_factor 弱 alpha — 加仓而非 must-buy)
 *
 * 与既有 ApplyOrderItem (POST /apply-signals 返回) 的区别 — ApplyOrderItem 是
 * "下单后的结果", TradingPlanRow 是 "下单前的预览". 字段刻意保留 source/score/
 * priority 给 UI 直接展示 reason, 不依赖 backend 再算一遍.
 */

import {
  TodaySignalsData,
  MultiFactorAlphaSignal,
  DragonHeadSignal,
  EarningsSurpriseSignal,
} from '../../services/todayWorkspaceService';

// ---------- 公开类型 ----------

export type TradingPlanSource = 'multi_factor' | 'dragon_head' | 'earnings_surprise';

export type TradingPlanPriority = 'high' | 'medium' | 'low';

export interface TradingPlanRow {
  /** 唯一 key — symbol */
  stock_code: string;
  name: string | null;
  industry: string | null;
  /** 命中本股票的所有策略来源 (按入选优先级降序) */
  sources: TradingPlanSource[];
  /** 综合优先级 — UI 排序与 tag 颜色用 */
  priority: TradingPlanPriority;
  /** 0..1 综合分: 多策略命中加权平均, 用于排序 tie-breaker. 缺失为 null. */
  score: number | null;
  /** 单笔参考价 (来自 dragon_head.reference_price 或 earnings_surprise.reference_price) */
  reference_price: number | null;
  /** 一句话理由 — 拼合策略 + key 数字 */
  reason: string;
}

// ---------- 常量 (export 便于单测 / 调参单一来源) ----------

/** earnings_surprise profit_change_low ≥ 此值 → 升级到 high 优先级 */
export const HIGH_PRIORITY_EARNINGS_PROFIT_PCT = 100;

/** multi_factor composite_score ≥ 此值 → 升级到 medium 优先级 */
export const MEDIUM_PRIORITY_MFA_SCORE = 0.6;

/** sources 排序时的策略权重 (high → low) — 同股多策略命中时, sources[0] 为主源 */
export const SOURCE_PRIORITY_ORDER: TradingPlanSource[] = [
  'dragon_head',
  'earnings_surprise',
  'multi_factor',
];

// ---------- 纯函数 ----------

/**
 * 决定一行计划的优先级。
 * 输入 sources + 关键数字 (mfa_score / earnings_profit_pct) — 任一 source 命中
 * 升级规则即升级, 否则取 fallback (multi_factor → low / earnings → medium).
 */
export function computePlanPriority(input: {
  sources: TradingPlanSource[];
  mfa_score: number | null;
  earnings_profit_pct: number | null;
}): TradingPlanPriority {
  const { sources, mfa_score, earnings_profit_pct } = input;
  // high 档: dragon_head 一律 high; earnings_surprise 增幅 ≥ 100% high
  if (sources.includes('dragon_head')) return 'high';
  if (
    sources.includes('earnings_surprise') &&
    earnings_profit_pct != null &&
    Number.isFinite(earnings_profit_pct) &&
    earnings_profit_pct >= HIGH_PRIORITY_EARNINGS_PROFIT_PCT
  ) {
    return 'high';
  }
  // medium 档: earnings_surprise 或 mfa_score ≥ 0.6
  if (sources.includes('earnings_surprise')) return 'medium';
  if (
    sources.includes('multi_factor') &&
    mfa_score != null &&
    Number.isFinite(mfa_score) &&
    mfa_score >= MEDIUM_PRIORITY_MFA_SCORE
  ) {
    return 'medium';
  }
  // low 档: 其它 multi_factor (弱 alpha 加仓)
  return 'low';
}

/** sources 按 SOURCE_PRIORITY_ORDER 排序去重 */
export function sortSources(sources: TradingPlanSource[]): TradingPlanSource[] {
  const set = new Set(sources);
  return SOURCE_PRIORITY_ORDER.filter(s => set.has(s));
}

/** 把 source key 转中文 label — UI tag 用 */
export function sourceLabel(source: TradingPlanSource): string {
  if (source === 'multi_factor') return '多因子';
  if (source === 'dragon_head') return '龙头';
  if (source === 'earnings_surprise') return '业绩超预期';
  return source;
}

/** priority tag 颜色 — high 红 / medium 蓝 / low 灰 */
export function priorityTagColor(p: TradingPlanPriority): string {
  if (p === 'high') return 'red';
  if (p === 'medium') return 'blue';
  return 'default';
}

/** priority 中文 label — UI tag 内文字 */
export function priorityLabel(p: TradingPlanPriority): string {
  if (p === 'high') return '强烈';
  if (p === 'medium') return '建议';
  return '可选';
}

/**
 * 拼一句话 reason — 同股多策略命中时合并所有理由, 用 ｜ 分隔. 每个 source 一句
 * 短语 (e.g. "多因子 0.82 / 龙头 3 板 / 业绩 120%+"). 没有数字的 source 仅显
 * source label.
 */
export function buildPlanReason(
  parts: Array<{ source: TradingPlanSource; detail: string }>
): string {
  if (parts.length === 0) return '';
  return parts.map(p => `${sourceLabel(p.source)} ${p.detail}`.trim()).join(' ｜ ');
}

/**
 * 主入口 —— 把 TodaySignalsData 里 3 策略 BUY 信号合并成统一计划列表。
 *
 * 行为契约:
 *   - 仅纳入 signal === 'buy' 的条目 (sell/hold 不进计划);
 *   - 同 stock_code 多策略命中 → 合并到一行, sources / reason 累加;
 *   - 输出按 priority (high→medium→low) 再按 score 降序排; 同 priority 同 score
 *     按 stock_code 字母序稳定排序 (便于 React key 稳定 + UI tie 可预期);
 *   - 输入异常 (data 为 null / 单 block error / signals 为空) 全部容错返 [].
 */
export function buildTradingPlan(data: TodaySignalsData | null | undefined): TradingPlanRow[] {
  if (!data) return [];
  const rows = new Map<string, TradingPlanRow>();
  // 用单独 Map 暂存"原始数字"用于 priority 计算 (score / earnings_profit_pct)
  const scoreCache = new Map<string, number>();
  const earningsPctCache = new Map<string, number>();
  const reasonParts = new Map<string, Array<{ source: TradingPlanSource; detail: string }>>();

  // --- multi_factor ---
  const mfa = data.multi_factor?.signals ?? [];
  for (const s of mfa) {
    if (s.signal !== 'buy') continue;
    upsertRow(rows, reasonParts, s, 'multi_factor', {
      industry: s.industry ?? null,
      name: s.name ?? null,
      detail: mfaDetail(s),
    });
    if (typeof s.composite_score === 'number' && Number.isFinite(s.composite_score)) {
      scoreCache.set(s.stock_code, s.composite_score);
    }
  }

  // --- dragon_head ---
  const dh = data.dragon_head?.candidates ?? [];
  for (const s of dh) {
    if (s.signal !== 'buy') continue;
    upsertRow(rows, reasonParts, s, 'dragon_head', {
      industry: s.industry ?? null,
      name: s.name ?? null,
      detail: dragonHeadDetail(s),
    });
    if (typeof s.reference_price === 'number' && s.reference_price > 0) {
      const r = rows.get(s.stock_code);
      if (r) r.reference_price = s.reference_price;
    }
  }

  // --- earnings_surprise ---
  const es = data.earnings_surprise?.candidates ?? [];
  for (const s of es) {
    if (s.signal !== 'buy') continue;
    upsertRow(rows, reasonParts, s, 'earnings_surprise', {
      industry: s.industry ?? null,
      name: s.name ?? null,
      detail: earningsDetail(s),
    });
    if (typeof s.reference_price === 'number' && s.reference_price > 0) {
      const r = rows.get(s.stock_code);
      // dragon_head 的 reference_price 优先 (短线龙头当日入场价更敏感)
      if (r && r.reference_price == null) r.reference_price = s.reference_price;
    }
    if (typeof s.profit_change_low === 'number' && Number.isFinite(s.profit_change_low)) {
      earningsPctCache.set(s.stock_code, s.profit_change_low);
    }
  }

  // --- 汇总 priority / score / reason / sources ---
  rows.forEach((row, code) => {
    row.sources = sortSources(row.sources);
    const parts = reasonParts.get(code) ?? [];
    // reason 顺序也按 source priority 排
    parts.sort(
      (a, b) => SOURCE_PRIORITY_ORDER.indexOf(a.source) - SOURCE_PRIORITY_ORDER.indexOf(b.source)
    );
    row.reason = buildPlanReason(parts);
    row.priority = computePlanPriority({
      sources: row.sources,
      mfa_score: scoreCache.get(code) ?? null,
      earnings_profit_pct: earningsPctCache.get(code) ?? null,
    });
    // score: 取 mfa composite_score; 缺则用 1.0 (dragon_head / earnings_surprise
    // 没有数字 score, 用 1.0 让它们在 sort 中按 priority 主排, 不被无 score 拖到底)
    const mfaScore = scoreCache.get(code);
    row.score = mfaScore != null && Number.isFinite(mfaScore) ? mfaScore : 1.0;
  });

  // 排序: priority high→medium→low; 同 priority score 降序; 同 score stock_code 字母序
  const priorityRank: Record<TradingPlanPriority, number> = { high: 0, medium: 1, low: 2 };
  const out: TradingPlanRow[] = [];
  rows.forEach(r => out.push(r));
  return out.sort((a, b) => {
    const dp = priorityRank[a.priority] - priorityRank[b.priority];
    if (dp !== 0) return dp;
    const sa = a.score ?? -Infinity;
    const sb = b.score ?? -Infinity;
    if (sa !== sb) return sb - sa;
    return a.stock_code.localeCompare(b.stock_code);
  });
}

// ---------- 内部 helper ----------

function upsertRow(
  rows: Map<string, TradingPlanRow>,
  reasonParts: Map<string, Array<{ source: TradingPlanSource; detail: string }>>,
  signal: { stock_code: string; name?: string | null; industry?: string | null },
  source: TradingPlanSource,
  meta: { industry: string | null; name: string | null; detail: string }
): void {
  const code = signal.stock_code;
  let row = rows.get(code);
  if (!row) {
    row = {
      stock_code: code,
      name: meta.name,
      industry: meta.industry,
      sources: [],
      priority: 'low',
      score: null,
      reference_price: null,
      reason: '',
    };
    rows.set(code, row);
  } else {
    // name / industry 兜底补缺 — 不覆盖已有非空值, 避免 dragon_head 的 ST 名称
    // 被 multi_factor 的旧名覆盖
    if (!row.name && meta.name) row.name = meta.name;
    if (!row.industry && meta.industry) row.industry = meta.industry;
  }
  if (!row.sources.includes(source)) row.sources.push(source);
  const parts = reasonParts.get(code) ?? [];
  parts.push({ source, detail: meta.detail });
  reasonParts.set(code, parts);
}

function mfaDetail(s: MultiFactorAlphaSignal): string {
  if (typeof s.composite_score === 'number' && Number.isFinite(s.composite_score)) {
    return s.composite_score.toFixed(2);
  }
  return '';
}

function dragonHeadDetail(s: DragonHeadSignal): string {
  if (typeof s.continuous_days === 'number' && s.continuous_days > 0) {
    return `${s.continuous_days}板`;
  }
  return '';
}

function earningsDetail(s: EarningsSurpriseSignal): string {
  if (typeof s.profit_change_low === 'number' && Number.isFinite(s.profit_change_low)) {
    return `${Math.round(s.profit_change_low)}%+`;
  }
  if (s.forecast_type) return s.forecast_type;
  return '';
}
