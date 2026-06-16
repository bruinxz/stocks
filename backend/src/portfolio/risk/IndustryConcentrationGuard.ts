/**
 * IndustryConcentrationGuard — US-052
 *
 * **行业集中度告警与强制再平衡** — 每日收盘后扫描所有持仓，按行业聚合
 * 仓位市值，若某行业占比超过阈值（默认 35%）写 RiskAlert(level='MEDIUM')。
 * 配合 POST /api/portfolio/rebalance-industry 一键再平衡 endpoint：自动卖
 * 出占比最大的行业内涨幅最大的 1-2 只直到该行业占比 < 30%。
 *
 * 与 US-047/US-048/US-049/US-050/US-051 互补的**第 6 类风控形态** ——
 *   - US-047 PositionLimitGuard：pre-trade inline 单股 / 单行业上限（订单期）；
 *   - US-048 TrailingStopGuard：per-position 追踪止损（持有期）；
 *   - US-049 DrawdownCircuitBreaker：portfolio-level cascade（组合期）；
 *   - US-050 MarketRegimeAlertService：market-level 指数信号（大盘期）；
 *   - US-051 PerStockStopLossGuard：per-position 硬止损（成本期）；
 *   - **US-052 IndustryConcentrationGuard**：portfolio-level 行业聚合
 *     （**post-trade** 监控持有期间已建仓行业分布变化）+ 强制再平衡 endpoint。
 *
 * 与 US-047 单行业 cap 的关键区别：
 *   - US-047 是 **pre-trade** — 阻止 *新增* 订单导致超 30% 上限；
 *   - US-052 是 **post-trade** — 监控 *已持有* 仓位因价格上涨自然漂移到 >35%
 *     的情况（即使没有新订单也会触发，因 portfolio 自身价格变化会让行业占比变化）。
 *   两者门槛不同：35% > 30% 是为了让 pre-trade cap 留 5% buffer 处理价格波动，
 *   避免每天 cap-30% 后第二天又触发 alert。
 *
 * AC 关键点：
 *   1. 在 backend/src/portfolio/risk/ 新建 IndustryConcentrationGuard.ts；
 *   2. 每日收盘后计算每个行业的仓位占比，超 35% 写 RiskAlert（level=MEDIUM）；
 *   3. 新增 endpoint POST /api/portfolio/rebalance-industry：自动卖出占比
 *      最大的行业内涨幅最大的 1-2 只直到该行业 < 30%；
 *   4. 新增单元测试 + typecheck pass + tests pass。
 *
 * 触发流程：
 *   `evaluateAfterClose(user_id?, dry_run?)` — 收盘后定时任务
 *   - 默认 scope = 所有有 PaperTradingPortfolio 的用户；user_id 限定单 user；
 *   - 每个用户独立 try/catch 隔离（同 US-047/US-048/US-049/US-051 pattern）；
 *   - per-industry：聚合 industry → sum(market_value)，算 pct =
 *     industry_value / total_position_value（**不包含 cash**，更贴近真实
 *     "行业仓位占比" 概念）；
 *   - 单行业超 35% → 写 RiskAlert(level='MEDIUM',
 *     symbol='SYSTEM:INDUSTRY_CONCENTRATION:<industry>'，每个超标行业一条）。
 *
 * `rebalanceIndustry(user_id, options?)` — 一键再平衡 endpoint backend：
 *   - 找到当前**最超标**的行业（projected_pct DESC 排序）；
 *   - 该行业内按 gain_pct DESC（涨幅最大）排序，挑前 1-2 只（默认 max=2）；
 *   - 模拟逐只卖出，每卖一只重算 industry_pct，直到 industry_pct < 30%
 *     或挑光 max_sell_count；
 *   - **dry_run=true 仅返回 plan 不调用 facade.placeOrder**；
 *   - **dry_run=false 走 facade.closePosition** 真实下单（保持 facade 7-method
 *     收敛 + 兼容所有 pre-trade guard 链路）；
 *   - 返回 `{from_industry, sold_positions, before_pct, after_pct, ...}`。
 *
 * 设计约束 — 沿用 US-047/US-048/US-049/US-051 的 7 项 checklist：
 *   - DataSource 接口注入（生产 Sequelize + 测试 fake）；
 *   - 纯函数 helper 全 export 让单测无需 DB；
 *   - 配置在 User.risk_config.industry_concentration JSONB + Object.freeze 默认；
 *   - 行业超标 → RiskAlert(level='MEDIUM') — **MEDIUM** 而非 HIGH，因这是
 *     "应当关注的偏移" 而非 "必须立即止血"（与 US-047 LIMIT 违规不同 — 那
 *     是订单拒绝、HIGH 强制阻断）；
 *   - 写 RiskAlert 失败 try/catch + logger.warn 不掩盖 alert 返回；
 *   - 单 user 失败 try/catch 隔离不阻塞剩余 user；
 *   - HTTP 入口 GET /api/risk/industry-concentration（config CRUD）+ POST
 *     /api/portfolio/rebalance-industry（一键再平衡），与现有 risk endpoints
 *     共 namespace；
 *   - 不破坏 facade 收敛 — 一键再平衡调 facade.closePosition（不绕开 facade）。
 *
 * 边界与坑：
 *   - **total_position_value = sum(market_value)**，**不含 cash** — pct 是
 *     "行业占持仓的比例" 而非 "占总账户的比例"。若 portfolio 50% 现金 + 一
 *     只股票，按"占持仓" 该股 100%（应告警），按"占总账户"该股 50%（不告警）。
 *     用户期望前者，因 cash 可以瞬间分散到任何行业；
 *   - **multi-industry alert**：可同时触发多个行业告警（如 50% A 行业 + 36%
 *     B 行业 都超 35%）— 与 US-050 多信号并列模式一致，按 industry 各写一条；
 *   - **未分类行业（Stock.industry = null/空）**：按 sentinel '__UNKNOWN__'
 *     聚合（避免静默被合并到某个真实行业）。若未分类聚合超 35% 也会触发
 *     告警，提示用户补数据；
 *   - **行业边界用 `>` 严格不等**（与 US-047 single-industry cap 一致）—
 *     恰好 35% 不触发，超过才触发；
 *   - **rebalance 用 `<` 严格收敛到 30%** — 卖完后 pct 严格小于 30% 才停止
 *     （boundary 一致，避免回到 30% 再触发）；
 *   - **rebalance gain_pct 用 `(close - avg_cost) / avg_cost`** — 同
 *     US-051 computeLossRatio 镜像（盈利 = 正数）；
 *   - **rebalance max_sell_count=2** — AC 限制 "1-2 只"，但若 2 只仍未让
 *     行业 < 30% 则不强卖第 3 只（避免在小账户里把行业全清空 — 让用户
 *     人工介入决定）；
 *   - **rebalance 持仓 0 现金不动**：rebalance 不影响 BUY 链路，仅 SELL；
 *   - **空持仓 / 无超标行业**：returns empty alerts list / plan 不抛错；
 *   - **enabled=false**：整 user 跳过（returns NONE 不写任何 alert）；
 *   - **fail-OPEN**：rebalance 内部一只卖出失败不阻塞下一只（continue with
 *     logged warn + 标记 result.status='failed'）。
 */

import { Op } from 'sequelize';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { Stock } from '../../models/Stock';
import { RiskAlert } from '../../models/RiskAlert';
import { User } from '../../models/User';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

export interface IndustryConcentrationConfig {
  /** 是否启用（false = 跳过整个 guard）。 */
  enabled: boolean;
  /** 告警阈值 0-1（e.g. 0.35 = 单行业占比超 35% 写 MEDIUM 告警）。 */
  alert_pct: number;
  /** 再平衡目标阈值 0-1（e.g. 0.30 = 卖出后让行业占比降到 30% 以下）。 */
  rebalance_target_pct: number;
  /** 一键再平衡最多卖出几只（AC 指定 1-2 只）。 */
  rebalance_max_sell_count: number;
}

/**
 * 默认配置（AC 指定）：启用 + 35% 告警 + 30% 再平衡目标 + 最多卖 2 只。
 *
 * `Object.freeze` 防止模块级常量被意外 mutate（US-037 codebase pattern）。
 */
export const DEFAULT_INDUSTRY_CONCENTRATION_CONFIG: IndustryConcentrationConfig = Object.freeze({
  enabled: true,
  alert_pct: 0.35,
  rebalance_target_pct: 0.3,
  rebalance_max_sell_count: 2,
});

/** 哨兵 industry name（未分类持仓聚合到此 bucket）。 */
export const UNKNOWN_INDUSTRY_SENTINEL = '__UNKNOWN__';

/** 哨兵 symbol 前缀（同 US-049/US-050/US-051 SYSTEM: 范式）。 */
export const INDUSTRY_CONCENTRATION_SYMBOL_PREFIX = 'SYSTEM:INDUSTRY_CONCENTRATION:';

// ---------------------------------------------------------------------------
//  Domain types
// ---------------------------------------------------------------------------

/** Snapshot of one position for guard evaluation. */
export interface IndustryPositionSnapshot {
  id: number;
  portfolio_id: number;
  symbol: string;
  name?: string | null;
  quantity: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  /** Industry name (null/empty → UNKNOWN_INDUSTRY_SENTINEL bucket). */
  industry?: string | null;
}

/** Per-industry aggregation result. */
export interface IndustryAggregation {
  industry: string; // normalized — UNKNOWN_INDUSTRY_SENTINEL for unclassified
  total_value: number;
  pct: number; // 0-1, industry_value / sum(all_industry_values)
  position_count: number;
  symbols: string[]; // sorted ascending for stable output
}

/** One industry concentration alert. */
export interface IndustryConcentrationAlert {
  industry: string;
  pct: number;
  alert_pct: number;
  total_value: number;
  position_count: number;
  symbols: string[];
  /** Human-readable Chinese message. */
  message: string;
  /** Sentinel symbol used for RiskAlert.symbol. */
  symbol: string;
  /** Human-readable name used for RiskAlert.name. */
  name: string;
}

/** Per-user evaluation result. */
export interface IndustryConcentrationUserResult {
  user_id: number;
  portfolio_id: number | null;
  enabled: boolean;
  open_positions_count: number;
  total_position_value: number;
  industry_breakdown: IndustryAggregation[];
  alerts: IndustryConcentrationAlert[];
  error?: string;
}

/** Aggregate result of batch evaluation across all users. */
export interface IndustryConcentrationEvaluationResult {
  scanned_users: number;
  alerted_users: number;
  per_user: IndustryConcentrationUserResult[];
}

/** Plan entry for one position to sell during rebalance. */
export interface RebalanceSellPlan {
  position_id: number;
  /** portfolio_id 来自源 position; 让 executeFullClose 显式传给 facade 避免串盘 (修复 C2). */
  portfolio_id: number;
  symbol: string;
  name: string;
  quantity: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  gain_pct: number;
  /** projected industry pct AFTER this sell (in plan order). */
  projected_industry_pct_after: number;
}

/** Per-sell execution outcome. */
export interface RebalanceSellResult {
  position_id: number;
  symbol: string;
  status: 'sold' | 'failed' | 'skipped_dry_run';
  error?: string;
  executed_quantity?: number;
  executed_price?: number;
}

/** Rebalance result. */
export interface IndustryRebalanceResult {
  user_id: number;
  portfolio_id: number | null;
  from_industry: string | null; // null when no rebalance needed (no industry over alert)
  before_pct: number;
  after_pct: number;
  target_pct: number;
  total_position_value_before: number;
  sold_positions: RebalanceSellResult[];
  plan: RebalanceSellPlan[];
  /** True when rebalance halted because plan exhausted before reaching target. */
  partial: boolean;
  /** True when dry_run requested (no actual SELL). */
  dry_run: boolean;
  /** Human-readable Chinese summary. */
  message: string;
}

// ---------------------------------------------------------------------------
//  Pure helpers (export for unit tests — no DB)
// ---------------------------------------------------------------------------

/**
 * 净化 industry 名称：null/empty/whitespace-only → UNKNOWN_INDUSTRY_SENTINEL；
 * 否则 trim 后返回。
 */
export function normalizeIndustryName(industry: string | null | undefined): string {
  if (industry === null || industry === undefined) return UNKNOWN_INDUSTRY_SENTINEL;
  const t = String(industry).trim();
  if (t.length === 0) return UNKNOWN_INDUSTRY_SENTINEL;
  return t;
}

/**
 * 聚合持仓按行业归组 → industry → IndustryAggregation。
 *
 * - pct = industry_value / sum(all_industry_market_values)，**不包含 cash**。
 *   pct 是 "行业占持仓的比例"，更贴近用户对 "行业集中度" 的直觉
 *   （cash 可以瞬间分散到任何行业 / 任何 sector，不应稀释 industry concentration）。
 * - total_position_value = 0 → 所有 pct = 0（空账户无 industry concentration）。
 * - 输出按 pct DESC 排序（最大的行业在前），同 pct 时按 industry 名升序稳定 tie-break
 *   （V8 sort 不稳，显式次序避免月度 audit 偏差）。
 * - 0 quantity / 0 market_value 持仓静默剔除（已平仓但行还在）。
 */
export function aggregateByIndustry(positions: IndustryPositionSnapshot[]): {
  breakdown: IndustryAggregation[];
  total_position_value: number;
} {
  const valid = positions.filter(
    p =>
      Number.isFinite(p.quantity) &&
      p.quantity > 0 &&
      Number.isFinite(p.market_value) &&
      p.market_value > 0
  );
  const total = valid.reduce((s, p) => s + p.market_value, 0);
  const buckets = new Map<string, { value: number; positions: IndustryPositionSnapshot[] }>();
  for (const p of valid) {
    const key = normalizeIndustryName(p.industry);
    let b = buckets.get(key);
    if (!b) {
      b = { value: 0, positions: [] };
      buckets.set(key, b);
    }
    b.value += p.market_value;
    b.positions.push(p);
  }
  const breakdown: IndustryAggregation[] = [];
  for (const [industry, b] of buckets.entries()) {
    breakdown.push({
      industry,
      total_value: b.value,
      pct: total > 0 ? b.value / total : 0,
      position_count: b.positions.length,
      symbols: b.positions.map(p => p.symbol).sort(),
    });
  }
  // pct desc, industry asc (stable tie-break)
  breakdown.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    return a.industry.localeCompare(b.industry);
  });
  return { breakdown, total_position_value: total };
}

/**
 * 判定一个行业是否超过 alert 阈值。
 *
 * 用 `>` 严格不等（与 US-047 single-industry cap 一致）— 恰好 35% 不触发，
 * 超过才触发。alert_pct 非法（NaN / 负 / >1）→ 不触发（防御性 false）。
 */
export function isIndustryOverAlert(industryPct: number, alertPct: number): boolean {
  if (!Number.isFinite(industryPct) || industryPct < 0) return false;
  if (!Number.isFinite(alertPct) || alertPct < 0 || alertPct > 1) return false;
  return industryPct > alertPct;
}

/**
 * 找出所有超 alert 阈值的行业（按 pct DESC 排序，最严重在前）。
 *
 * 调用方可拿第 0 个做 rebalance 焦点。
 */
export function pickOverAlertIndustries(
  breakdown: IndustryAggregation[],
  alertPct: number
): IndustryAggregation[] {
  return breakdown.filter(b => isIndustryOverAlert(b.pct, alertPct)).sort((a, b) => b.pct - a.pct);
}

/**
 * 计算单只持仓的盈亏率 = (current_price - avg_cost) / avg_cost。
 *
 * - avg_cost ≤ 0 / 非有限 → 返回 0（防御性除零，再平衡时不歧视，按 0 排序排在中部）；
 * - current_price 非有限 → 返回 0。
 */
export function computeGainPct(currentPrice: number, avgCost: number): number {
  if (!Number.isFinite(avgCost) || avgCost <= 0) return 0;
  if (!Number.isFinite(currentPrice)) return 0;
  return (currentPrice - avgCost) / avgCost;
}

/**
 * 计算"卖出该持仓后行业 pct"。
 *
 * - 假设全平该持仓（quantity 全数 SELL）；
 * - new_industry_value = industry_value_before - market_value（卖出的钱进入 cash 不再
 *   计入任何 industry）；
 * - new_total_value = total_value_before - market_value；
 * - new_industry_value <= 0 / new_total_value <= 0 → 返回 0（行业被清空）。
 */
export function computeIndustryPctAfterSell(
  industryValueBefore: number,
  totalValueBefore: number,
  positionMarketValue: number
): number {
  const newIndustry = industryValueBefore - positionMarketValue;
  const newTotal = totalValueBefore - positionMarketValue;
  if (newIndustry <= 0 || newTotal <= 0) return 0;
  return newIndustry / newTotal;
}

/**
 * 在某行业内按 gain_pct DESC 排序，stable tie-break by symbol ASC（同
 * US-049 sort 模式）。
 */
export function sortByGainDescStable(
  positions: IndustryPositionSnapshot[]
): IndustryPositionSnapshot[] {
  return [...positions].sort((a, b) => {
    const gainA = computeGainPct(a.current_price, a.avg_cost);
    const gainB = computeGainPct(b.current_price, b.avg_cost);
    if (gainB !== gainA) return gainB - gainA;
    return a.symbol.localeCompare(b.symbol);
  });
}

/**
 * 生成 rebalance 卖出计划（pure simulation，不真实下单）。
 *
 * 算法：
 *   - 找到 from_industry（pct 最大的超 alert 行业）；
 *   - 在该行业内按 gain_pct DESC 排序持仓；
 *   - 依次模拟卖出（每只全平），每卖一只重算 projected_industry_pct；
 *   - 卖到 (a) projected_industry_pct < target_pct 或 (b) 达到 max_sell_count
 *     或 (c) 行业内持仓挑完，停止。
 *
 * 返回 `null` 当没有超 alert 行业（无需 rebalance）。
 */
export function buildRebalanceSellPlan(
  breakdown: IndustryAggregation[],
  positions: IndustryPositionSnapshot[],
  alertPct: number,
  targetPct: number,
  maxSellCount: number
): {
  from_industry: string;
  before_pct: number;
  plan: RebalanceSellPlan[];
  total_value_before: number;
  industry_value_before: number;
} | null {
  const over = pickOverAlertIndustries(breakdown, alertPct);
  if (over.length === 0) return null;
  const focus = over[0];
  const industryPositions = positions.filter(
    p =>
      normalizeIndustryName(p.industry) === focus.industry &&
      Number.isFinite(p.quantity) &&
      p.quantity > 0 &&
      Number.isFinite(p.market_value) &&
      p.market_value > 0
  );
  if (industryPositions.length === 0) {
    return {
      from_industry: focus.industry,
      before_pct: focus.pct,
      plan: [],
      total_value_before: breakdown.reduce((s, b) => s + b.total_value, 0),
      industry_value_before: focus.total_value,
    };
  }
  const sorted = sortByGainDescStable(industryPositions);
  const totalValueBefore = breakdown.reduce((s, b) => s + b.total_value, 0);
  let industryValueRemaining = focus.total_value;
  let totalValueRemaining = totalValueBefore;
  const plan: RebalanceSellPlan[] = [];
  const safeMax = Number.isInteger(maxSellCount) && maxSellCount >= 1 ? maxSellCount : 1;
  for (const pos of sorted) {
    if (plan.length >= safeMax) break;
    const projected_industry_pct_after = computeIndustryPctAfterSell(
      industryValueRemaining,
      totalValueRemaining,
      pos.market_value
    );
    plan.push({
      position_id: pos.id,
      portfolio_id: pos.portfolio_id, // 修复 C2: 让 executeFullClose 显式传 portfolio_id
      symbol: pos.symbol,
      name: pos.name || pos.symbol,
      quantity: pos.quantity,
      avg_cost: pos.avg_cost,
      current_price: pos.current_price,
      market_value: pos.market_value,
      gain_pct: computeGainPct(pos.current_price, pos.avg_cost),
      projected_industry_pct_after,
    });
    industryValueRemaining -= pos.market_value;
    totalValueRemaining -= pos.market_value;
    if (projected_industry_pct_after < targetPct) break;
  }
  return {
    from_industry: focus.industry,
    before_pct: focus.pct,
    plan,
    total_value_before: totalValueBefore,
    industry_value_before: focus.total_value,
  };
}

/**
 * 净化 raw config blob（来自 User.risk_config 或 PUT body）。
 *
 * - 非有限 / 负 / >1 pct → 默认；
 * - 非 boolean enabled → 默认 (true)；
 * - 非整数 / < 1 max_sell_count → 默认 (2)；
 *
 * 与 US-047/US-048/US-049/US-051 normalize 同款"沉默退回默认不 4xx"的范式。
 */
export function normalizeIndustryConcentrationConfig(raw: any): IndustryConcentrationConfig {
  const safePct = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
  };
  const safeBool = (v: any, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  const safeInt = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : dflt;
  };
  return {
    enabled: safeBool(raw?.enabled, DEFAULT_INDUSTRY_CONCENTRATION_CONFIG.enabled),
    alert_pct: safePct(raw?.alert_pct, DEFAULT_INDUSTRY_CONCENTRATION_CONFIG.alert_pct),
    rebalance_target_pct: safePct(
      raw?.rebalance_target_pct,
      DEFAULT_INDUSTRY_CONCENTRATION_CONFIG.rebalance_target_pct
    ),
    rebalance_max_sell_count: safeInt(
      raw?.rebalance_max_sell_count,
      DEFAULT_INDUSTRY_CONCENTRATION_CONFIG.rebalance_max_sell_count
    ),
  };
}

/** 拼装行业集中度告警 message（中文）。 */
export function buildIndustryConcentrationMessage(input: {
  industry: string;
  pct: number;
  alert_pct: number;
  position_count: number;
  symbols: string[];
}): string {
  const industryLabel = input.industry === UNKNOWN_INDUSTRY_SENTINEL ? '未分类' : input.industry;
  const symbolPreview = input.symbols.slice(0, 5).join(', ');
  const moreSuffix = input.symbols.length > 5 ? ` 等 ${input.symbols.length} 只` : '';
  return (
    `行业 [${industryLabel}] 仓位占比达 ${(input.pct * 100).toFixed(2)}%，` +
    `超过告警阈值 ${(input.alert_pct * 100).toFixed(2)}%。` +
    `涉及持仓：${symbolPreview}${moreSuffix}。` +
    `建议使用一键再平衡降低集中度。`
  );
}

/** 拼装 rebalance 结果 message（中文）。 */
export function buildRebalanceResultMessage(input: {
  industry: string;
  before_pct: number;
  after_pct: number;
  target_pct: number;
  sold_count: number;
  partial: boolean;
  dry_run: boolean;
}): string {
  const industryLabel = input.industry === UNKNOWN_INDUSTRY_SENTINEL ? '未分类' : input.industry;
  const head = input.dry_run ? '【预演】' : '';
  const status = input.partial
    ? '已卖出最大涨幅 1-2 只仍未达到目标，建议人工继续介入。'
    : '已成功降低到目标阈值以下。';
  return (
    `${head}行业 [${industryLabel}] 仓位从 ${(input.before_pct * 100).toFixed(2)}%` +
    ` 调整到 ${(input.after_pct * 100).toFixed(2)}%（目标 < ${(input.target_pct * 100).toFixed(
      2
    )}%）。` +
    `卖出 ${input.sold_count} 只。${status}`
  );
}

// ---------------------------------------------------------------------------
//  DataSource — DI seam for unit tests
// ---------------------------------------------------------------------------

export interface IndustryConcentrationDataSource {
  /** Load all users with at least one paper-trading portfolio. */
  loadAllUserIdsWithPortfolios(): Promise<number[]>;
  /** Load this user's effective config (defaults if absent). */
  loadConfig(user_id: number): Promise<IndustryConcentrationConfig>;
  /** Persist this user's config (UPSERT semantics). */
  saveConfig(
    user_id: number,
    config: IndustryConcentrationConfig
  ): Promise<IndustryConcentrationConfig>;
  /** Load the user's portfolio header (just id). */
  loadPortfolioId(user_id: number): Promise<number | null>;
  /** Load all open positions (quantity > 0) for the user, with industry joined. */
  loadOpenPositions(user_id: number): Promise<IndustryPositionSnapshot[]>;
  /** Write a single RiskAlert row (level='MEDIUM'). */
  writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    message: string;
  }): Promise<void>;
  /**
   * Execute a SELL for the entire position (delegates to facade.closePosition).
   * Returns the execution details on success; throws on failure.
   */
  executeFullClose(input: {
    user_id: number;
    symbol: string;
    /** 修复 (2026-06-16, CRITICAL C2): 显式传 portfolio_id 避免 facade 路由错盘 */
    portfolio_id?: number;
  }): Promise<{ executed_quantity: number; executed_price: number }>;
}

/**
 * Production DataSource — backed by Sequelize + PaperTradingFacade.
 *
 * `executeFullClose` is wired to the **facade** (not internal services
 * directly) so that pre-trade guards (DrawdownCircuitBreaker /
 * PositionLimitGuard) still run on the SELL leg, preserving the 7-method
 * invariant established in US-003.
 */
export class DefaultIndustryConcentrationDataSource implements IndustryConcentrationDataSource {
  async loadAllUserIdsWithPortfolios(): Promise<number[]> {
    const rows = await PaperTradingPortfolio.findAll({
      attributes: ['user_id'],
      group: ['user_id'],
    });
    return rows.map(r => r.user_id);
  }

  async loadConfig(user_id: number): Promise<IndustryConcentrationConfig> {
    const user = await User.findByPk(user_id);
    const raw = user?.risk_config?.industry_concentration;
    return normalizeIndustryConcentrationConfig(raw);
  }

  async saveConfig(
    user_id: number,
    config: IndustryConcentrationConfig
  ): Promise<IndustryConcentrationConfig> {
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`saveConfig: user ${user_id} not found`);
    }
    const merged = {
      ...(user.risk_config || {}),
      industry_concentration: { ...config },
    };
    user.risk_config = merged;
    // JSONB columns require explicit `changed('field', true)` per US-017.
    user.changed('risk_config', true);
    await user.save();
    return { ...config };
  }

  async loadPortfolioId(user_id: number): Promise<number | null> {
    // 修复 (2026-06-16, HIGH H2): 兼容旧 caller, 显式取 active 集合中 id 最小者.
    const p = await PaperTradingPortfolio.findOne({
      where: { user_id, is_active: true },
      order: [['id', 'ASC']],
    });
    return p ? p.id : null;
  }

  async loadOpenPositions(user_id: number): Promise<IndustryPositionSnapshot[]> {
    // 修复 (HIGH H2): 跨所有 active portfolio 拉持仓 (注意行业集中度按聚合算)
    const portfolios = await PaperTradingPortfolio.findAll({
      where: { user_id, is_active: true },
      attributes: ['id'],
    });
    if (portfolios.length === 0) return [];
    const rows = await PaperTradingPosition.findAll({
      where: {
        portfolio_id: { [Op.in]: portfolios.map(p => p.id) },
        quantity: { [Op.gt]: 0 },
      },
    });
    if (rows.length === 0) return [];
    const symbols = Array.from(new Set(rows.map(r => r.symbol)));
    const stocks = await Stock.findAll({
      where: { symbol: { [Op.in]: symbols } },
      attributes: ['symbol', 'industry'],
    });
    const industryMap = new Map<string, string | null>();
    stocks.forEach(s => industryMap.set(s.symbol, s.industry ?? null));
    return rows.map<IndustryPositionSnapshot>(r => ({
      id: r.id,
      portfolio_id: r.portfolio_id,
      symbol: r.symbol,
      name: r.name,
      quantity: Number(r.quantity),
      avg_cost: Number(r.avg_cost),
      current_price: Number(r.current_price),
      market_value: Number(r.market_value),
      industry: industryMap.get(r.symbol) ?? null,
    }));
  }

  async writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    message: string;
  }): Promise<void> {
    await RiskAlert.create({
      user_id: input.user_id,
      symbol: input.symbol,
      name: input.name,
      level: 'MEDIUM',
      message: input.message,
      // US-067 — 给 RealtimeAlertDispatcher dedup signature 用 (本 guard 写 MEDIUM
      // 不进 dispatcher 主流程，但保留 rule_id 让数据完整、未来扩 MEDIUM cron 聚合可复用)。
      rule_id: 'industry_concentration',
      is_read: false,
    } as any);
  }

  async executeFullClose(input: {
    user_id: number;
    symbol: string;
    portfolio_id?: number;
  }): Promise<{ executed_quantity: number; executed_price: number }> {
    // Lazy-require to avoid a circular import (facade → guard → facade).
    // The facade is the single ingress for SELL orders so all pre-trade
    // guards (drawdown breaker, future per-stock checks) still run.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { paperTradingFacade } = require('../PaperTradingFacade');
    const result = await paperTradingFacade.closePosition({
      user_id: input.user_id,
      portfolio_id: input.portfolio_id, // 修复 C2: 必传 — 否则 facade fallback 到 first portfolio 错卖
      symbol: input.symbol,
    });
    return {
      executed_quantity: Number(result.quantity) || 0,
      executed_price: Number(result.execute_price) || 0,
    };
  }
}

export const PRODUCTION_INDUSTRY_CONCENTRATION_DATA_SOURCE: IndustryConcentrationDataSource =
  new DefaultIndustryConcentrationDataSource();

// ---------------------------------------------------------------------------
//  Guard — public entry point
// ---------------------------------------------------------------------------

export interface EvaluateAfterCloseOptions {
  /** If set, only process this user. Otherwise scan all users with portfolios. */
  user_id?: number;
  /** If true, do NOT write RiskAlert rows (dry-run mode for UI dashboards). */
  dry_run?: boolean;
}

export interface RebalanceIndustryOptions {
  user_id: number;
  /** If true, generate the plan but don't actually call closePosition. */
  dry_run?: boolean;
}

export class IndustryConcentrationGuard {
  private source: IndustryConcentrationDataSource;

  constructor(
    source: IndustryConcentrationDataSource = PRODUCTION_INDUSTRY_CONCENTRATION_DATA_SOURCE
  ) {
    this.source = source;
  }

  /**
   * 每日收盘后批量评估所有用户的行业集中度。
   *
   * - 单 user 失败 try/catch 隔离（同 US-047/US-048/US-049/US-051 pattern）；
   * - disabled 用户跳过整个评估（returns enabled=false 不写任何 alert）；
   * - 多个行业可同时触发（每行业一条 RiskAlert(level='MEDIUM',
   *   symbol='SYSTEM:INDUSTRY_CONCENTRATION:<industry>')）；
   * - dry_run=true 跳过 RiskAlert 写入但仍返回完整 alerts / breakdown
   *   （UI 预演用）。
   */
  async evaluateAfterClose(
    options: EvaluateAfterCloseOptions = {}
  ): Promise<IndustryConcentrationEvaluationResult> {
    const dryRun = Boolean(options.dry_run);
    const userIds = options.user_id
      ? [options.user_id]
      : await this.source.loadAllUserIdsWithPortfolios();

    const result: IndustryConcentrationEvaluationResult = {
      scanned_users: userIds.length,
      alerted_users: 0,
      per_user: [],
    };

    for (const user_id of userIds) {
      try {
        const userResult = await this.evaluateOneUser(user_id, dryRun);
        result.per_user.push(userResult);
        if (userResult.alerts.length > 0) {
          result.alerted_users += 1;
        }
      } catch (err) {
        logger.warn(
          `IndustryConcentrationGuard.evaluateAfterClose user=${user_id} failed: ` +
            `${(err as Error).message}`
        );
        result.per_user.push({
          user_id,
          portfolio_id: null,
          enabled: false,
          open_positions_count: 0,
          total_position_value: 0,
          industry_breakdown: [],
          alerts: [],
          error: (err as Error).message,
        });
      }
    }

    return result;
  }

  /** Single-user evaluation extracted for clarity. */
  private async evaluateOneUser(
    user_id: number,
    dryRun: boolean
  ): Promise<IndustryConcentrationUserResult> {
    const config = await this.source.loadConfig(user_id);
    const portfolio_id = await this.source.loadPortfolioId(user_id);
    if (portfolio_id === null) {
      return {
        user_id,
        portfolio_id: null,
        enabled: config.enabled,
        open_positions_count: 0,
        total_position_value: 0,
        industry_breakdown: [],
        alerts: [],
      };
    }
    const positions = await this.source.loadOpenPositions(user_id);
    const open_positions_count = positions.filter(p => p.quantity > 0).length;
    const { breakdown, total_position_value } = aggregateByIndustry(positions);

    if (!config.enabled) {
      return {
        user_id,
        portfolio_id,
        enabled: false,
        open_positions_count,
        total_position_value,
        industry_breakdown: breakdown,
        alerts: [],
      };
    }

    const overAlertIndustries = pickOverAlertIndustries(breakdown, config.alert_pct);
    const alerts: IndustryConcentrationAlert[] = overAlertIndustries.map(b => {
      const message = buildIndustryConcentrationMessage({
        industry: b.industry,
        pct: b.pct,
        alert_pct: config.alert_pct,
        position_count: b.position_count,
        symbols: b.symbols,
      });
      const industryLabel = b.industry === UNKNOWN_INDUSTRY_SENTINEL ? '未分类' : b.industry;
      return {
        industry: b.industry,
        pct: b.pct,
        alert_pct: config.alert_pct,
        total_value: b.total_value,
        position_count: b.position_count,
        symbols: b.symbols,
        message,
        symbol: `${INDUSTRY_CONCENTRATION_SYMBOL_PREFIX}${b.industry}`,
        name: `行业集中度告警 - ${industryLabel}`,
      };
    });

    if (!dryRun) {
      for (const alert of alerts) {
        try {
          await this.source.writeAlert({
            user_id,
            symbol: alert.symbol,
            name: alert.name,
            message: alert.message,
          });
        } catch (err) {
          logger.warn(
            `IndustryConcentrationGuard.writeAlert user=${user_id} ` +
              `industry=${alert.industry}: ${(err as Error).message}`
          );
        }
      }
    }

    return {
      user_id,
      portfolio_id,
      enabled: true,
      open_positions_count,
      total_position_value,
      industry_breakdown: breakdown,
      alerts,
    };
  }

  /**
   * 一键再平衡：找到最严重的超标行业，按涨幅 DESC 卖出 1-2 只让行业占比 < 30%。
   *
   * - dry_run=true 返回 plan 不调用 facade.closePosition；
   * - dry_run=false 走 facade.closePosition（保持 facade 7-method 收敛 + 兼容
   *   所有 pre-trade guard 链路如 DrawdownCircuitBreaker）；
   * - 卖出失败（如停牌 / cash 不足等异常）记录 status='failed' 继续下一只
   *   而非抛错（fail-OPEN，让 partial result 仍能返回让用户决定）；
   * - returns from_industry=null 当没有超标行业（无需 rebalance）。
   */
  async rebalanceIndustry(options: RebalanceIndustryOptions): Promise<IndustryRebalanceResult> {
    const { user_id } = options;
    const dryRun = Boolean(options.dry_run);
    const config = await this.source.loadConfig(user_id);
    const portfolio_id = await this.source.loadPortfolioId(user_id);
    if (portfolio_id === null) {
      return {
        user_id,
        portfolio_id: null,
        from_industry: null,
        before_pct: 0,
        after_pct: 0,
        target_pct: config.rebalance_target_pct,
        total_position_value_before: 0,
        sold_positions: [],
        plan: [],
        partial: false,
        dry_run: dryRun,
        message: '未找到模拟盘，无可再平衡的持仓。',
      };
    }
    const positions = await this.source.loadOpenPositions(user_id);
    const { breakdown, total_position_value } = aggregateByIndustry(positions);
    const planBundle = buildRebalanceSellPlan(
      breakdown,
      positions,
      config.alert_pct,
      config.rebalance_target_pct,
      config.rebalance_max_sell_count
    );
    if (!planBundle) {
      return {
        user_id,
        portfolio_id,
        from_industry: null,
        before_pct: 0,
        after_pct: 0,
        target_pct: config.rebalance_target_pct,
        total_position_value_before: total_position_value,
        sold_positions: [],
        plan: [],
        partial: false,
        dry_run: dryRun,
        message: '当前无超出告警阈值的行业，无需再平衡。',
      };
    }
    const { from_industry, before_pct, plan } = planBundle;
    if (plan.length === 0) {
      return {
        user_id,
        portfolio_id,
        from_industry,
        before_pct,
        after_pct: before_pct,
        target_pct: config.rebalance_target_pct,
        total_position_value_before: total_position_value,
        sold_positions: [],
        plan: [],
        partial: true,
        dry_run: dryRun,
        message: `行业 [${
          from_industry === UNKNOWN_INDUSTRY_SENTINEL ? '未分类' : from_industry
        }] 已无可卖出持仓，无法再平衡。`,
      };
    }
    const sold: RebalanceSellResult[] = [];
    if (dryRun) {
      // 预演模式：plan 中每条都标记为 skipped_dry_run。
      for (const p of plan) {
        sold.push({
          position_id: p.position_id,
          symbol: p.symbol,
          status: 'skipped_dry_run',
          executed_quantity: p.quantity,
          executed_price: p.current_price,
        });
      }
    } else {
      for (const p of plan) {
        try {
          const res = await this.source.executeFullClose({
            user_id,
            symbol: p.symbol,
            portfolio_id: p.portfolio_id, // 修复 C2: 显式传 portfolio_id
          });
          sold.push({
            position_id: p.position_id,
            symbol: p.symbol,
            status: 'sold',
            executed_quantity: res.executed_quantity,
            executed_price: res.executed_price,
          });
        } catch (err) {
          logger.warn(
            `IndustryConcentrationGuard.rebalanceIndustry close failed user=${user_id} ` +
              `symbol=${p.symbol}: ${(err as Error).message}`
          );
          sold.push({
            position_id: p.position_id,
            symbol: p.symbol,
            status: 'failed',
            error: (err as Error).message,
          });
        }
      }
    }
    // After execution, the projected_industry_pct_after of the last
    // successfully-included plan step is the expected after_pct.  When the
    // plan stopped because target reached, that's the last entry; when it
    // stopped because max_sell_count reached, it's also the last entry but
    // partial=true.
    const lastPlan = plan[plan.length - 1];
    const after_pct = lastPlan.projected_industry_pct_after;
    const partial = after_pct >= config.rebalance_target_pct;
    return {
      user_id,
      portfolio_id,
      from_industry,
      before_pct,
      after_pct,
      target_pct: config.rebalance_target_pct,
      total_position_value_before: total_position_value,
      sold_positions: sold,
      plan,
      partial,
      dry_run: dryRun,
      message: buildRebalanceResultMessage({
        industry: from_industry,
        before_pct,
        after_pct,
        target_pct: config.rebalance_target_pct,
        sold_count: sold.filter(s => s.status === 'sold' || s.status === 'skipped_dry_run').length,
        partial,
        dry_run: dryRun,
      }),
    };
  }

  /** Return the user's effective config (defaults if not customized). */
  async getConfig(user_id: number): Promise<IndustryConcentrationConfig> {
    return this.source.loadConfig(user_id);
  }

  /** Persist a (normalized) updated config for the user. */
  async updateConfig(user_id: number, raw: any): Promise<IndustryConcentrationConfig> {
    const normalized = normalizeIndustryConcentrationConfig(raw);
    return this.source.saveConfig(user_id, normalized);
  }
}

/** Singleton — controllers / scheduler / facade reach this instead of `new`-ing per call. */
export const industryConcentrationGuard = new IndustryConcentrationGuard();
