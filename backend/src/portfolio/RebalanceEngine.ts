/**
 * RebalanceEngine — US-086
 *
 * **统一的仓位再平衡引擎**：给定一个 portfolioId 和目标权重 Map（stock_code →
 * weight），生成最小化交易量的 BUY / SELL / HOLD 订单列表，并按 A 股 100 股
 * 最小交易单位自动取整。当某只股票的目标偏差 < `minTradePct`（默认 0.5%）时
 * 不下单（HOLD），避免无意义的微调换手。
 *
 * 与现有再平衡 surface 的关系：
 *   - **US-052 `IndustryConcentrationGuard.rebalanceIndustry`** 是"行业级"
 *     一键再平衡：只针对超标行业自动卖最大涨幅 1-2 只到 < 30%，不接受
 *     目标权重 Map。
 *   - **本 US-086 `RebalanceEngine.rebalance`** 是"通用"目标权重再平衡：
 *     caller 提供完整目标权重 Map，引擎生成完整 BUY/SELL/HOLD 列表
 *     （未在 Map 内的持仓 = 目标权重 0 = 清仓）。
 *   两者互补 — 行业 guard 适合系统自动应急，本引擎适合策略调仓 / 用户
 *   手动 rebalance / 组合优化结果落地。
 *
 * 算法（**最小化交易量** 与 **A 股 100 股最小交易单位**）：
 *   - 输入：portfolio_id + targetWeights: Map<stock_code, weight>（weight ∈ [0, 1]）。
 *   - 1) 读取 portfolio.total_value + 现有 positions（quantity > 0）。
 *   - 2) 对每只**目标 ∪ 持仓** 内的 stock：
 *        - target_value = total_value * weight   （未在 target 内的持仓 weight = 0）
 *        - current_value = position.market_value   （未持有则 0）
 *        - diff_value = target_value - current_value
 *        - diff_pct = |diff_value| / total_value
 *        - 若 diff_pct < minTradePct → HOLD（跳过，无意义微调）
 *        - 否则按 100 股最小交易单位计算 quantity：
 *            - BUY：quantity = floor(diff_value / current_price / 100) * 100
 *            - SELL：quantity = ceil(|diff_value| / current_price / 100) * 100，
 *                    上限 = 持仓 quantity（不能卖超）。
 *            - 取整后 quantity == 0 → HOLD（金额不足一手）。
 *   - 3) 按 SELL 优先 BUY 次后 HOLD 排序输出（撮合层应先卖出释放 cash）。
 *
 * 设计约束 — 沿用 US-047/US-048/US-049/US-051/US-052 的 6 项 checklist：
 *   - **DataSource 接口注入**（生产 Sequelize + 测试 fake）；
 *   - **纯函数 helper 全 export** 让单测无需 DB：
 *     `computeTradePlan` / `quantizeBuyQuantity` / `quantizeSellQuantity` /
 *     `classifyOrderSide` / `normalizeTargetWeights` /
 *     `normalizeRebalanceOptions` / `sortRebalanceOrders`。
 *   - **配置常量 Object.freeze**（`DEFAULT_REBALANCE_OPTIONS`）；
 *   - **A 股 100 股最小交易单位** 硬编码为 `MIN_TRADE_LOT_SIZE = 100`；
 *     如未来支持北交所（5 股 / 10 股 / 100 股阶梯）再扩 lot_size 参数；
 *   - **不破坏 facade 收敛** — 执行模式（`execute=true`）走
 *     `PaperTradingFacade.placeOrder`，不绕开 facade；
 *   - **dry_run 默认 true** —— 引擎默认只产 plan 不下单，让调用方
 *     review 后显式 `execute=true` 才下单（与 US-052 一键再平衡反向，
 *     因为通用 rebalance 涉及多只 stock 风险更大）。
 *
 * 边界与坑：
 *   - **targetWeights.size === 0**：语义 = 全部清仓（与 US-083 set-membership
 *     "default-deny" 同款 — 空集合 = 没有任何 stock 应保留 = 全部 SELL）。
 *     若 caller 真想"不改变当前 portfolio"，请传 `dry_run=true` 或不要
 *     调用本方法。jsdoc + 单测必须显式覆盖这个语义反差，避免误用。
 *   - **weight sum > 1**：不抛错，按 weight 直接算 target_value
 *     （sum > 1 时 sum(target_value) > total_value 会产生 BUY 但
 *     cash 不足让 placeOrder 在执行时拒单 — 让 facade 报"cash 不足"
 *     的真实错误，引擎层不要替它判定）。**weight sum < 1** 即剩余权重
 *     留 cash — 不是错误。
 *   - **weight < 0**：直接抛错（无 A 股做空场景，且空集合语义已用 0
 *     weight 表达）。
 *   - **current_price <= 0** 或 stock 缺数据：该 stock 标 status='skipped'
 *     + reason，不阻塞其他 stock 的 plan 生成（partial result 模式）。
 *   - **HOLD 项也输出**：让调用方 UI / 审计能看到"这只票被检查过 + 决定不动"。
 *   - **minTradePct 默认 0.5%**：threshold 用严格 `<` 不等（< minTradePct → HOLD），
 *     边界恰好 == minTradePct → 仍生成 trade（与 US-082 "合格线用严格 <" 一致）。
 *     0.5% / 200000 总资产 = 1000 元 ≈ 4-5 手 5 元低价股 / 1 手 100 元高价股
 *     —— 既能过滤"无意义微调"，又能保留小调仓机会。
 *   - **rounding bias**：BUY 用 floor（宁可少买防 cash 超支），SELL 用 ceil
 *     上限 held quantity（卖到目标 ± 一手，宁可多卖防超目标 weight）。
 *     算法引入的"trade 后实际 weight ≠ 目标 weight"误差最大约 100 股 ×
 *     current_price / total_value（通常 < 0.5% 即低于 minTradePct，自然收敛）。
 *
 * 注意：本引擎 **不参与价格预测**，targetWeights 由 caller 决定（典型来源：
 * 策略 generateSignals 输出 / PortfolioOptimizer 优化结果 / 用户手动指定）。
 */

import { Op } from 'sequelize';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

/**
 * A 股最小交易单位（1 手 = 100 股）。沪深主板 / 中小板 / 创业板 / 科创板
 * 一致，未来若支持北交所（5 股 / 10 股 / 100 股阶梯）再扩 lot_size 参数。
 */
export const MIN_TRADE_LOT_SIZE = 100;

/**
 * Rebalance 默认配置（Object.freeze 防 mutation，per US-037 pattern）。
 *
 * - `minTradePct=0.005` (0.5%)：**per-symbol** filter — 单只股票偏差 < 0.5%
 *   不交易（避免无意义微调）。
 * - `minDeviationPct=0.03` (3%)：**portfolio-level gate** (US-009 / PR-004
 *   "不日日动") — 在所有 universe 内 stock 的 `|diff_pct|` 都 < 3% 时，
 *   整次 rebalance 被抑制：全部订单转 HOLD（reason='within_min_deviation_pct'，
 *   `suppressed=true`），不下单也不消耗换手率。与 `minTradePct` 互补:
 *   - `minTradePct` 防"单只票微调"
 *   - `minDeviationPct` 防"全组合微动"（避免触发但每只都才动一点）
 *   设 `minDeviationPct=0` 即禁用 gate（caller 显式接管，例如
 *   `CompositeRebalanceService` 自己有 turnover cap）。
 * - `dryRun=true`：默认只产 plan 不下单，强制 caller 显式 `execute=true`
 *   才触发真实下单。
 */
export const DEFAULT_REBALANCE_OPTIONS: RebalanceOptions = Object.freeze({
  minTradePct: 0.005,
  minDeviationPct: 0.03,
  dryRun: true,
});

// ---------------------------------------------------------------------------
//  Domain types
// ---------------------------------------------------------------------------

export interface RebalanceOptions {
  /** 低于此目标偏差不交易（绝对值），默认 0.005 (0.5%) — per-symbol filter. */
  minTradePct: number;
  /**
   * Portfolio-level rebalance gate (US-009 / PR-004 "不日日动").
   * 当 universe 内**最大** `|diff_pct|` < minDeviationPct 时，整次 rebalance
   * 被抑制，所有订单转 HOLD（reason='within_min_deviation_pct'），不下单。
   * 默认 0.03 (3%)。设 0 即禁用 gate（caller 接管，例如有 turnover cap）。
   */
  minDeviationPct: number;
  /** 默认 true — 只产 plan 不下单；execute=true 时才走 facade.placeOrder。 */
  dryRun: boolean;
}

export type RebalanceOrderSide = 'BUY' | 'SELL' | 'HOLD';

export interface RebalanceOrder {
  /** 股票代码（保留 caller 传入的格式，例如 "600519.SH" 或 "600519"）。 */
  symbol: string;
  /** Side: BUY/SELL/HOLD。 */
  side: RebalanceOrderSide;
  /** 拟交易数量（股，已按 100 整数倍取整）。HOLD 时 = 0。 */
  quantity: number;
  /** 当前用于计算的 reference price（DailyBar.close）。 */
  current_price: number;
  /** 当前持仓数量（股）。未持有 = 0。 */
  current_quantity: number;
  /** 当前持仓市值（current_quantity × current_price）。 */
  current_value: number;
  /** 当前 weight = current_value / total_value（0-1）。 */
  current_weight: number;
  /** 目标 weight（caller 输入；未在 target 内则 0）。 */
  target_weight: number;
  /** 目标市值 = total_value × target_weight。 */
  target_value: number;
  /** target_value - current_value（正 = 需 BUY，负 = 需 SELL）。 */
  diff_value: number;
  /** |diff_value| / total_value。 */
  diff_pct: number;
  /** 执行模式下 placeOrder 的返回（dry-run 模式下未定义）。 */
  execution_status?: 'ok' | 'failed' | 'skipped_dry_run';
  execution_error?: string;
  /** 为什么 HOLD / skipped；helpful for debug。 */
  reason?: string;
}

export interface RebalanceTradePlanInput {
  total_value: number;
  positions: PositionSnapshot[];
  targetWeights: Map<string, number>;
  priceMap: Map<string, number>;
  minTradePct: number;
  /**
   * Portfolio-level deviation gate (US-009 / PR-004). When set and the
   * maximum `|diff_pct|` in the universe is below this value, every order is
   * coerced to HOLD with reason='within_min_deviation_pct'. Default 0 = gate
   * disabled (callers that want it must pass `minDeviationPct` explicitly).
   */
  minDeviationPct?: number;
}

export interface PositionSnapshot {
  symbol: string;
  quantity: number;
  current_price: number;
  market_value: number;
}

export interface RebalanceInput {
  portfolio_id: number;
  targetWeights: Map<string, number> | Record<string, number>;
  options?: Partial<RebalanceOptions> & { execute?: boolean };
}

export interface RebalanceResult {
  portfolio_id: number;
  user_id: number | null;
  total_value: number;
  orders: RebalanceOrder[];
  buy_count: number;
  sell_count: number;
  hold_count: number;
  skipped_count: number;
  dry_run: boolean;
  /**
   * `true` when the portfolio-level `minDeviationPct` gate suppressed the
   * entire rebalance (US-009 / PR-004 "不日日动"). All orders in this result
   * will be HOLD with `reason='within_min_deviation_pct'`, and execute mode
   * is a no-op (no `executeOrder` call). `false` for every other path
   * (including normal "everything aligned → all HOLD" — distinguishable by
   * `reason`).
   */
  suppressed: boolean;
  /**
   * 此次计算出的 universe 内**最大** `|diff_pct|`（gate 判定的依据值）。
   * 0 表示没有任何 stock 进入 universe (空 portfolio + 空 target) 或所有
   * `diff_pct` 都因 missing_price/total_value=0 被跳过；非 0 时给 caller /
   * UI 直观看到"我们离 gate 阈值还有多远"。
   */
  max_deviation_pct: number;
  options: RebalanceOptions;
  message: string;
}

// ---------------------------------------------------------------------------
//  Pure-function helpers (all exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Normalize a partial / record / Map of options into a fully-populated
 * `RebalanceOptions` with safe defaults.  Garbage (negative / NaN / > 1
 * minTradePct / minDeviationPct) silently falls back to default — caller-friendly.
 *
 * `minDeviationPct=0` is **explicitly accepted** and means "disable gate"
 * (US-009 / PR-004 — callers like `CompositeRebalanceService` that own their
 * own turnover gate opt out by passing 0).
 */
export function normalizeRebalanceOptions(input?: Partial<RebalanceOptions>): RebalanceOptions {
  const def = DEFAULT_REBALANCE_OPTIONS;
  const minTradePctRaw = input?.minTradePct;
  let minTradePct = def.minTradePct;
  if (
    typeof minTradePctRaw === 'number' &&
    Number.isFinite(minTradePctRaw) &&
    minTradePctRaw >= 0 &&
    minTradePctRaw <= 1
  ) {
    minTradePct = minTradePctRaw;
  }
  const minDeviationPctRaw = input?.minDeviationPct;
  let minDeviationPct = def.minDeviationPct;
  if (
    typeof minDeviationPctRaw === 'number' &&
    Number.isFinite(minDeviationPctRaw) &&
    minDeviationPctRaw >= 0 &&
    minDeviationPctRaw <= 1
  ) {
    minDeviationPct = minDeviationPctRaw;
  }
  // 严格 boolean — 持久化兼容（US-083 dryRun 范式），非 boolean 入默认。
  const dryRun = input?.dryRun === false || input?.dryRun === true ? input.dryRun : def.dryRun;
  return { minTradePct, minDeviationPct, dryRun };
}

/**
 * Convert a Map / plain object of target weights into a normalized Map.
 *
 * - **weight < 0** → throws (no short-selling support in A-share simulator).
 * - **weight is NaN / Infinity / non-finite** → throws (caller bug; better fail
 *   loud than silently zero out).
 * - **duplicate symbol** (e.g. via Object spread) → last-write-wins (Map
 *   iteration semantics).
 * - **empty input** → empty Map (caller meant 全清仓; see jsdoc top warning).
 */
export function normalizeTargetWeights(
  input: Map<string, number> | Record<string, number>
): Map<string, number> {
  const out = new Map<string, number>();
  if (input instanceof Map) {
    for (const [k, v] of input.entries()) {
      validateAndSet(out, k, v);
    }
  } else if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      validateAndSet(out, k, v);
    }
  } else {
    throw new Error('normalizeTargetWeights: input must be Map or Record');
  }
  return out;
}

function validateAndSet(out: Map<string, number>, key: string, raw: unknown): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`normalizeTargetWeights: invalid symbol key=${JSON.stringify(key)}`);
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(
      `normalizeTargetWeights: symbol=${key} weight is not a finite number (raw=${String(raw)})`
    );
  }
  if (raw < 0) {
    throw new Error(`normalizeTargetWeights: symbol=${key} negative weight=${raw} not supported`);
  }
  out.set(key, raw);
}

/**
 * For a BUY order — given target_value (positive), current_price, return the
 * 100-rounded-down quantity that fits.  Returns 0 when current_price <= 0 or
 * target_value < 1 lot's worth.
 */
export function quantizeBuyQuantity(targetValue: number, currentPrice: number): number {
  if (!Number.isFinite(targetValue) || targetValue <= 0) return 0;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return 0;
  const rawShares = targetValue / currentPrice;
  return Math.floor(rawShares / MIN_TRADE_LOT_SIZE) * MIN_TRADE_LOT_SIZE;
}

/**
 * For a SELL order — given |diff_value| (positive), current_price, held
 * quantity, return the 100-rounded-up quantity capped at held quantity.
 *
 * `ceil` is intentional: we'd rather slightly over-sell (cap at held) than
 * leave a tail position that's "almost zero but not enough to trade next round".
 * The ceil is then clipped to `heldQuantity` so we never sell what we don't
 * have.  Returns 0 when current_price <= 0, target_value <= 0, or held = 0.
 */
export function quantizeSellQuantity(
  absDiffValue: number,
  currentPrice: number,
  heldQuantity: number
): number {
  if (!Number.isFinite(absDiffValue) || absDiffValue <= 0) return 0;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return 0;
  if (!Number.isFinite(heldQuantity) || heldQuantity <= 0) return 0;
  const heldLots = Math.floor(heldQuantity / MIN_TRADE_LOT_SIZE);
  const heldQuantizedMax = heldLots * MIN_TRADE_LOT_SIZE;
  if (heldQuantizedMax <= 0) return 0;
  const rawShares = absDiffValue / currentPrice;
  const lots = Math.ceil(rawShares / MIN_TRADE_LOT_SIZE);
  const quantity = lots * MIN_TRADE_LOT_SIZE;
  return Math.min(quantity, heldQuantizedMax);
}

/**
 * Classify an order's side from diff_value.  Used internally by computeTradePlan
 * and exposed for tests / external callers wanting the same conventions.
 */
export function classifyOrderSide(
  diffValue: number,
  diffPct: number,
  minTradePct: number
): RebalanceOrderSide {
  if (!Number.isFinite(diffValue) || diffValue === 0) return 'HOLD';
  if (!Number.isFinite(diffPct) || diffPct < minTradePct) return 'HOLD';
  return diffValue > 0 ? 'BUY' : 'SELL';
}

/**
 * **Pure-function core of the engine.** Given the snapshot inputs, return the
 * full RebalanceOrder list (BUY / SELL / HOLD) sorted SELL → BUY → HOLD.
 *
 * No DB / no facade access — fully unit-testable.
 *
 * When `minDeviationPct > 0` and the maximum `|diff_pct|` across the universe
 * is **strictly below** `minDeviationPct`, the portfolio-level "不日日动" gate
 * (US-009 / PR-004) trips: every order in the returned list is coerced to
 * `side='HOLD'`, `quantity=0`, `reason='within_min_deviation_pct'` — same as
 * the within_min_trade_pct micro-filter but applied to the whole portfolio.
 * Edge: a universe with no priced symbols (every entry missing_price) trips
 * the gate (max_deviation_pct=0 < minDeviationPct) — keeps callers from
 * accidentally executing orders before price data lands.
 */
export function computeTradePlan(input: RebalanceTradePlanInput): RebalanceOrder[] {
  const { total_value, positions, targetWeights, priceMap, minTradePct } = input;
  const minDeviationPct =
    typeof input.minDeviationPct === 'number' && Number.isFinite(input.minDeviationPct)
      ? Math.max(0, input.minDeviationPct)
      : 0;
  const orders: RebalanceOrder[] = [];

  // Build position map keyed by symbol for O(1) lookup.
  const positionMap = new Map<string, PositionSnapshot>();
  for (const pos of positions) {
    positionMap.set(pos.symbol, pos);
  }

  // Universe = target ∪ held — anything appearing in either side gets considered.
  const universe = new Set<string>();
  for (const sym of targetWeights.keys()) universe.add(sym);
  for (const sym of positionMap.keys()) universe.add(sym);

  for (const symbol of universe) {
    const pos = positionMap.get(symbol);
    const target_weight = Math.max(0, targetWeights.get(symbol) ?? 0);
    const priceFromMap = priceMap.get(symbol);
    const current_price = Number.isFinite(priceFromMap)
      ? (priceFromMap as number)
      : pos?.current_price ?? 0;

    // Skip when no price available — we can't compute trade quantity.
    if (current_price <= 0) {
      orders.push({
        symbol,
        side: 'HOLD',
        quantity: 0,
        current_price: 0,
        current_quantity: pos?.quantity ?? 0,
        current_value: pos?.market_value ?? 0,
        current_weight: total_value > 0 ? (pos?.market_value ?? 0) / total_value : 0,
        target_weight,
        target_value: total_value > 0 ? total_value * target_weight : 0,
        diff_value: 0,
        diff_pct: 0,
        reason: 'missing_price',
      });
      continue;
    }

    const current_quantity = pos?.quantity ?? 0;
    const current_value = pos?.market_value ?? current_quantity * current_price;
    const current_weight = total_value > 0 ? current_value / total_value : 0;
    const target_value = total_value > 0 ? total_value * target_weight : 0;
    const diff_value = target_value - current_value;
    const diff_pct = total_value > 0 ? Math.abs(diff_value) / total_value : 0;
    const side = classifyOrderSide(diff_value, diff_pct, minTradePct);

    let quantity = 0;
    let reason: string | undefined;
    if (side === 'BUY') {
      quantity = quantizeBuyQuantity(diff_value, current_price);
      if (quantity === 0) {
        reason = 'below_one_lot';
      }
    } else if (side === 'SELL') {
      quantity = quantizeSellQuantity(Math.abs(diff_value), current_price, current_quantity);
      if (quantity === 0) {
        reason = current_quantity === 0 ? 'no_position' : 'below_one_lot';
      }
    } else {
      reason = 'within_min_trade_pct';
    }

    orders.push({
      symbol,
      side: quantity === 0 ? 'HOLD' : side,
      quantity,
      current_price,
      current_quantity,
      current_value,
      current_weight,
      target_weight,
      target_value,
      diff_value,
      diff_pct,
      reason,
    });
  }

  // Portfolio-level "不日日动" gate (US-009 / PR-004). Compute max |diff_pct|
  // across only orders we actually classified (skip missing_price entries —
  // those didn't contribute a real deviation signal). When the max sits
  // strictly below the gate, coerce **every classifiable** order to HOLD so
  // caller doesn't burn turnover on a portfolio that's still well-aligned.
  // missing_price orders are LEFT INTACT (still HOLD with that original reason)
  // so callers can distinguish "no data" from "gate-suppressed".
  if (minDeviationPct > 0) {
    const maxDeviationPct = computeMaxDeviationPct(orders);
    if (maxDeviationPct < minDeviationPct) {
      for (const order of orders) {
        if (order.reason === 'missing_price') continue;
        order.side = 'HOLD';
        order.quantity = 0;
        order.reason = 'within_min_deviation_pct';
      }
    }
  }

  return sortRebalanceOrders(orders);
}

/**
 * Compute the maximum `|diff_pct|` across a freshly-classified order list,
 * skipping orders that already carry `reason='missing_price'` (those didn't
 * contribute a deviation signal — the engine couldn't price them). Exported
 * for unit tests and for callers wanting to expose "you're N% away from the
 * rebalance gate" in their UI.
 */
export function computeMaxDeviationPct(orders: RebalanceOrder[]): number {
  let max = 0;
  for (const o of orders) {
    if (o.reason === 'missing_price') continue;
    if (Number.isFinite(o.diff_pct) && o.diff_pct > max) max = o.diff_pct;
  }
  return max;
}

/**
 * Sort orders: SELL first (release cash before BUY), then BUY, then HOLD.
 * Within a side, sort by `diff_pct` descending then `symbol` ascending for
 * deterministic output (per US-011 stable tie-break rule).
 */
export function sortRebalanceOrders(orders: RebalanceOrder[]): RebalanceOrder[] {
  const rank = { SELL: 0, BUY: 1, HOLD: 2 } as const;
  return [...orders].sort((a, b) => {
    const sideDiff = rank[a.side] - rank[b.side];
    if (sideDiff !== 0) return sideDiff;
    const pctDiff = b.diff_pct - a.diff_pct;
    if (pctDiff !== 0) return pctDiff;
    return a.symbol.localeCompare(b.symbol);
  });
}

// ---------------------------------------------------------------------------
//  DataSource — DI seam for unit tests
// ---------------------------------------------------------------------------

export interface RebalanceDataSource {
  /** Load portfolio header (or null if not found). */
  loadPortfolio(portfolio_id: number): Promise<{
    id: number;
    user_id: number;
    total_value: number;
  } | null>;
  /** Load open positions (quantity > 0) for the portfolio. */
  loadOpenPositions(portfolio_id: number): Promise<PositionSnapshot[]>;
  /** Load latest price for each requested symbol; missing prices → omitted from Map. */
  loadLatestPrices(symbols: string[]): Promise<Map<string, number>>;
  /**
   * Execute a single order via PaperTradingFacade.placeOrder (delegated so
   * pre-trade guards still run).  Throws on failure; caller logs and continues.
   */
  executeOrder(input: {
    user_id: number;
    symbol: string;
    direction: 'BUY' | 'SELL';
    quantity: number;
  }): Promise<{ executed_quantity: number; executed_price: number }>;
}

/**
 * Production DataSource — backed by Sequelize + PaperTradingFacade.
 *
 * Notes:
 * - `loadLatestPrices` queries DailyBar within the last 7 days and picks the
 *   most-recent close per symbol — same lookback window as
 *   `PaperTradingFacade._placeOrderInner` so the engine's reference price
 *   matches what the order would actually execute at.
 * - `executeOrder` calls `paperTradingFacade.placeOrder` (NOT the internal
 *   service) so PositionLimitGuard / DrawdownCircuitBreaker / fee logic still
 *   apply on the SELL/BUY leg.  This preserves the 7-method facade invariant
 *   established in US-003.
 * - Stock symbol convention follows `PaperTradingPosition.symbol` (suffixed
 *   form, e.g. `"600519.SH"`) — same as `PositionLimitGuard`.
 */
export class DefaultRebalanceDataSource implements RebalanceDataSource {
  async loadPortfolio(portfolio_id: number) {
    const row = await PaperTradingPortfolio.findByPk(portfolio_id);
    if (!row) return null;
    return {
      id: row.id,
      user_id: row.user_id,
      total_value: Number(row.total_value) || 0,
    };
  }

  async loadOpenPositions(portfolio_id: number): Promise<PositionSnapshot[]> {
    const rows = await PaperTradingPosition.findAll({
      where: { portfolio_id, quantity: { [Op.gt]: 0 } },
    });
    return rows.map(r => ({
      symbol: r.symbol,
      quantity: Number(r.quantity) || 0,
      current_price: Number(r.current_price) || 0,
      market_value: Number(r.market_value) || 0,
    }));
  }

  async loadLatestPrices(symbols: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!symbols || symbols.length === 0) return result;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Load stocks for symbol → id lookup
    const stocks = await Stock.findAll({
      where: { symbol: { [Op.in]: symbols } },
      attributes: ['id', 'symbol'],
    });
    const idToSymbol = new Map<number, string>();
    const stockIds: number[] = [];
    for (const s of stocks) {
      idToSymbol.set(s.id, s.symbol);
      stockIds.push(s.id);
    }
    if (stockIds.length === 0) return result;
    const bars = await DailyBar.findAll({
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.gte]: since },
      },
      attributes: ['stock_id', 'close', 'time'],
      order: [['time', 'DESC']],
    });
    // Pick the most-recent close per stock_id (first occurrence in DESC-sorted array).
    for (const bar of bars) {
      const symbol = idToSymbol.get(bar.stock_id);
      if (!symbol) continue;
      if (result.has(symbol)) continue;
      const close = Number((bar as any).close);
      if (Number.isFinite(close) && close > 0) {
        result.set(symbol, close);
      }
    }
    return result;
  }

  async executeOrder(input: {
    user_id: number;
    symbol: string;
    direction: 'BUY' | 'SELL';
    quantity: number;
  }): Promise<{ executed_quantity: number; executed_price: number }> {
    // Lazy-require avoids a circular import at module load time
    // (RebalanceEngine ← PaperTradingFacade ← maybe RebalanceEngine in future).
    // Same pattern as IndustryConcentrationGuard.executeFullClose (US-052).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { paperTradingFacade } = require('./PaperTradingFacade');
    const result = await paperTradingFacade.placeOrder({
      user_id: input.user_id,
      symbol: input.symbol,
      direction: input.direction,
      quantity: input.quantity,
    });
    // paperTradingFacade returns the legacy controller payload; pluck price/qty if present.
    const executed_price =
      Number(result?.price ?? result?.execute_price ?? result?.executed_price) || 0;
    const executed_quantity =
      Number(result?.quantity ?? result?.executed_quantity ?? input.quantity) || input.quantity;
    return { executed_quantity, executed_price };
  }
}

export const PRODUCTION_REBALANCE_DATA_SOURCE: RebalanceDataSource =
  new DefaultRebalanceDataSource();

// ---------------------------------------------------------------------------
//  Engine
// ---------------------------------------------------------------------------

export class RebalanceEngine {
  constructor(private readonly source: RebalanceDataSource = PRODUCTION_REBALANCE_DATA_SOURCE) {}

  /**
   * AC entry point: `rebalance(portfolioId, targetWeights)`.
   *
   * Returns a `RebalanceResult` with the full BUY/SELL/HOLD plan.  By default
   * (`dryRun=true`) **no orders are placed** — caller must pass
   * `options.execute=true` (and `options.dryRun=false`) to flip into
   * execution mode.
   */
  async rebalance(
    portfolio_id: number,
    targetWeightsInput: Map<string, number> | Record<string, number>,
    options?: Partial<RebalanceOptions> & { execute?: boolean }
  ): Promise<RebalanceResult> {
    const normalizedOptions = normalizeRebalanceOptions(options);
    // `execute=true` is a convenience alias for explicit "really place orders":
    // it flips `dryRun=false` regardless of the dryRun field.  Without it
    // we stay in dryRun (default safe behavior).
    const execute = options?.execute === true;
    const effectiveDryRun = execute ? false : normalizedOptions.dryRun;

    const targetWeights = normalizeTargetWeights(targetWeightsInput);

    const portfolio = await this.source.loadPortfolio(portfolio_id);
    if (!portfolio) {
      return {
        portfolio_id,
        user_id: null,
        total_value: 0,
        orders: [],
        buy_count: 0,
        sell_count: 0,
        hold_count: 0,
        skipped_count: 0,
        dry_run: effectiveDryRun,
        suppressed: false,
        max_deviation_pct: 0,
        options: { ...normalizedOptions, dryRun: effectiveDryRun },
        message: `未找到 portfolio_id=${portfolio_id}，无可再平衡的持仓。`,
      };
    }

    const positions = await this.source.loadOpenPositions(portfolio_id);
    const symbolsToPrice = new Set<string>();
    for (const sym of targetWeights.keys()) symbolsToPrice.add(sym);
    for (const pos of positions) symbolsToPrice.add(pos.symbol);
    const priceMap = await this.source.loadLatestPrices([...symbolsToPrice]);

    const orders = computeTradePlan({
      total_value: portfolio.total_value,
      positions,
      targetWeights,
      priceMap,
      minTradePct: normalizedOptions.minTradePct,
      minDeviationPct: normalizedOptions.minDeviationPct,
    });

    // Detect whether the portfolio-level "不日日动" gate (US-009 / PR-004)
    // tripped: at least one classifiable order was coerced to HOLD with reason
    // `within_min_deviation_pct`, and no non-HOLD orders survived. Detect from
    // the plan rather than re-computing so we stay in lock-step with
    // computeTradePlan's own decision. missing_price orders are allowed in the
    // mix (they aren't classifiable trades) but no real BUY/SELL may remain.
    const suppressed =
      normalizedOptions.minDeviationPct > 0 &&
      orders.some(o => o.reason === 'within_min_deviation_pct') &&
      orders.every(o => o.side === 'HOLD');
    const max_deviation_pct = computeMaxDeviationPct(orders);

    if (suppressed) {
      // Gate trip → skip execution entirely so we don't burn turnover.
      // No executeOrder call regardless of execute=true.
      logger.info(
        `RebalanceEngine.rebalance suppressed portfolio=${portfolio_id} ` +
          `max_deviation_pct=${max_deviation_pct.toFixed(4)} ` +
          `min_deviation_pct=${normalizedOptions.minDeviationPct.toFixed(4)} ` +
          `(US-009 / PR-004 不日日动 gate)`
      );
    } else if (!effectiveDryRun) {
      // Execute SELL first (sort already places SELLs at top).
      for (const order of orders) {
        if (order.side === 'HOLD' || order.quantity === 0) continue;
        try {
          await this.source.executeOrder({
            user_id: portfolio.user_id,
            symbol: order.symbol,
            direction: order.side,
            quantity: order.quantity,
          });
          order.execution_status = 'ok';
        } catch (err) {
          const msg = (err as Error).message;
          order.execution_status = 'failed';
          order.execution_error = msg;
          logger.warn(
            `RebalanceEngine.rebalance order failed portfolio=${portfolio_id} ` +
              `symbol=${order.symbol} side=${order.side} qty=${order.quantity}: ${msg}`
          );
        }
      }
    } else {
      for (const order of orders) {
        if (order.side === 'HOLD' || order.quantity === 0) continue;
        order.execution_status = 'skipped_dry_run';
      }
    }

    const buy_count = orders.filter(o => o.side === 'BUY' && o.quantity > 0).length;
    const sell_count = orders.filter(o => o.side === 'SELL' && o.quantity > 0).length;
    const hold_count = orders.filter(o => o.side === 'HOLD').length;
    const skipped_count = orders.filter(
      o => o.side === 'HOLD' && (o.reason === 'missing_price' || o.reason === 'below_one_lot')
    ).length;

    let message: string;
    if (suppressed) {
      message =
        `suppressed: max_deviation_pct=${(max_deviation_pct * 100).toFixed(2)}% ` +
        `< min_deviation_pct=${(normalizedOptions.minDeviationPct * 100).toFixed(2)}% ` +
        `(${hold_count} HOLD).`;
    } else if (effectiveDryRun) {
      message = `dry-run: ${buy_count} BUY + ${sell_count} SELL + ${hold_count} HOLD.`;
    } else {
      message = `executed: ${buy_count} BUY + ${sell_count} SELL + ${hold_count} HOLD.`;
    }

    return {
      portfolio_id,
      user_id: portfolio.user_id,
      total_value: portfolio.total_value,
      orders,
      buy_count,
      sell_count,
      hold_count,
      skipped_count,
      dry_run: effectiveDryRun,
      suppressed,
      max_deviation_pct,
      options: { ...normalizedOptions, dryRun: effectiveDryRun },
      message,
    };
  }
}

/**
 * Production singleton — controllers / scripts should import this directly.
 * `RebalanceEngine` class is still exported for tests that need a custom
 * DataSource injection.
 */
export const rebalanceEngine = new RebalanceEngine();
