/**
 * PositionLimitGuard — US-047
 *
 * Pre-trade risk gate for buy orders.  Rejects orders that would violate
 * the global "持仓上限与单股仓位限制" (position limits + per-stock exposure)
 * policy, and records every violation as a `RiskAlert(level='HIGH')` so that
 * the user can see why their order was blocked.
 *
 * 3 checks are evaluated in order:
 *   (1) **Max positions** — would this BUY push total distinct holdings
 *       past `max_positions`?  (Adding to an existing holding doesn't count.)
 *   (2) **Single-stock cap** — would `(existing_value + this_order_value) /
 *       total_value` exceed `max_single_stock_pct`?
 *   (3) **Single-industry cap** — would `(existing_industry_exposure +
 *       this_order_value) / total_value` exceed `max_single_industry_pct`?
 *
 * Each check returns a structured `LimitViolation` describing which rule
 * fired, current vs. proposed values, and the threshold.  The guard then
 * fans the violation out to:
 *   - A thrown `Error` (caller — i.e. `PaperTradingFacade.placeOrder` —
 *     surfaces it to the controller, which turns it into an HTTP 400).
 *   - A persisted `RiskAlert` row with `level='HIGH'` so the user sees it
 *     in their bell.
 *
 * Design notes (follow the project's "组合级 strategy" + "factor diagnostic"
 * patterns):
 *   - **Pure-function helpers** (`evaluatePositionCount`, `evaluateSingleStock`,
 *     `evaluateSingleIndustry`, `pickSingleViolation`) are all `export`ed so
 *     unit tests can drive them with synthetic snapshots and zero DB.
 *   - **DataSource interface injection** (`PositionLimitDataSource`) lets the
 *     production code talk to Sequelize while tests inject a fake snapshot
 *     bag.  This matches `MultiFactorAlphaStrategy` / `FactorICReport` /
 *     `PortfolioOptimizer`.
 *   - **Global config** lives in `DEFAULT_POSITION_LIMITS` (Object.freeze'd to
 *     prevent accidental mutation, per US-037 pattern) and is also persisted
 *     per-user in `User.risk_config.position_limits` so the
 *     `GET/PUT /api/risk/position-limits` endpoint can mutate it without
 *     a server restart.
 *   - **Symbol convention** matches `PaperTradingPosition.symbol` —
 *     suffixed form (e.g. `"600519.SH"`) — because that's what the facade
 *     receives.  The Stock lookup keys off this exact field; no stripping.
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

export interface PositionLimitsConfig {
  /** Maximum number of distinct holdings allowed at any time. */
  max_positions: number;
  /** Maximum percentage of `total_value` any single stock may occupy. (0-1, e.g. 0.10 = 10%.) */
  max_single_stock_pct: number;
  /** Maximum percentage of `total_value` any single industry may occupy. (0-1.) */
  max_single_industry_pct: number;
}

/**
 * Project-wide defaults per AC: max 20 holdings, 10% per stock, 30% per industry.
 *
 * `Object.freeze` (per the US-037 codebase pattern) keeps callers from
 * accidentally mutating the shared default in-place.
 */
export const DEFAULT_POSITION_LIMITS: PositionLimitsConfig = Object.freeze({
  max_positions: 20,
  max_single_stock_pct: 0.1,
  max_single_industry_pct: 0.3,
});

// ---------------------------------------------------------------------------
//  Domain types
// ---------------------------------------------------------------------------

/** Snapshot of one already-held position for guard evaluation. */
export interface HeldPositionSnapshot {
  symbol: string;
  market_value: number;
  industry?: string | null;
}

/** All inputs needed to evaluate a proposed BUY. */
export interface OrderContext {
  user_id: number;
  symbol: string;
  proposed_value: number; // execute_price * quantity (NOT including commission)
  total_value: number; // portfolio.total_value at decision time
  positions: HeldPositionSnapshot[];
  industry?: string | null; // industry of the order's symbol (null = unknown → industry check skipped)
}

/** Structured rule violation; one is emitted per blocked order. */
export type ViolationRule = 'max_positions' | 'max_single_stock_pct' | 'max_single_industry_pct';

export interface LimitViolation {
  rule: ViolationRule;
  message: string; // human-readable Chinese explanation
  detail: Record<string, unknown>; // structured detail so the UI can render numbers
}

// ---------------------------------------------------------------------------
//  Pure helpers (export for unit tests — no DB)
// ---------------------------------------------------------------------------

/**
 * Returns true iff this BUY would introduce a NEW distinct holding
 * (i.e. the symbol isn't already in `positions`).  Adding to an existing
 * holding doesn't count toward `max_positions`.
 */
export function isNewHolding(symbol: string, positions: HeldPositionSnapshot[]): boolean {
  return !positions.some(p => p.symbol === symbol);
}

/**
 * (1) Position-count check.  Returns a violation iff this is a NEW holding
 * AND the current distinct-holding count already equals/exceeds
 * `config.max_positions`.
 */
export function evaluatePositionCount(
  ctx: OrderContext,
  config: PositionLimitsConfig
): LimitViolation | null {
  if (!isNewHolding(ctx.symbol, ctx.positions)) return null;
  const current_count = ctx.positions.length;
  if (current_count >= config.max_positions) {
    return {
      rule: 'max_positions',
      message:
        `持仓数量达到上限 ${config.max_positions} 只，无法新开 ${ctx.symbol}。` +
        `请先平掉部分持仓再开新仓。`,
      detail: {
        current_count,
        max_positions: config.max_positions,
        symbol: ctx.symbol,
      },
    };
  }
  return null;
}

/**
 * (2) Single-stock cap.  Returns a violation iff
 * `(existing + proposed) / total_value > max_single_stock_pct`.
 *
 * Uses strict `>` (not `≥`) so a position landing exactly on the boundary
 * is allowed — matches the "硬数字阈值用严格 >" convention codified by
 * US-025 (`backend/src/quant/strategies/CLAUDE.md` boundary section).
 */
export function evaluateSingleStock(
  ctx: OrderContext,
  config: PositionLimitsConfig
): LimitViolation | null {
  if (ctx.total_value <= 0) return null; // 防御性：除零意味着账户还没建仓位价值，让上层别的校验先报错
  const existing = ctx.positions
    .filter(p => p.symbol === ctx.symbol)
    .reduce((s, p) => s + (Number.isFinite(p.market_value) ? p.market_value : 0), 0);
  const projected = existing + ctx.proposed_value;
  const projected_pct = projected / ctx.total_value;
  if (projected_pct > config.max_single_stock_pct) {
    return {
      rule: 'max_single_stock_pct',
      message:
        `${ctx.symbol} 仓位将达到 ${(projected_pct * 100).toFixed(2)}%，超过单股上限 ` +
        `${(config.max_single_stock_pct * 100).toFixed(2)}%。`,
      detail: {
        symbol: ctx.symbol,
        existing_value: existing,
        proposed_value: ctx.proposed_value,
        projected_value: projected,
        total_value: ctx.total_value,
        projected_pct,
        max_single_stock_pct: config.max_single_stock_pct,
      },
    };
  }
  return null;
}

/**
 * (3) Single-industry cap.  Returns a violation iff
 * `(industry_existing + proposed) / total_value > max_single_industry_pct`.
 *
 * Skipped (returns null) when `ctx.industry` is null/empty — an unknown
 * industry can't be aggregated and we prefer to fail open rather than
 * silently group every "unknown" stock into one bucket and trip the cap.
 * Operators see "industry not classified" via the surrounding logs.
 */
export function evaluateSingleIndustry(
  ctx: OrderContext,
  config: PositionLimitsConfig
): LimitViolation | null {
  if (ctx.total_value <= 0) return null;
  const industry = (ctx.industry || '').trim();
  if (!industry) return null;
  const existing = ctx.positions
    .filter(p => (p.industry || '').trim() === industry)
    .reduce((s, p) => s + (Number.isFinite(p.market_value) ? p.market_value : 0), 0);
  const projected = existing + ctx.proposed_value;
  const projected_pct = projected / ctx.total_value;
  if (projected_pct > config.max_single_industry_pct) {
    return {
      rule: 'max_single_industry_pct',
      message:
        `行业 [${industry}] 仓位将达到 ${(projected_pct * 100).toFixed(2)}%，` +
        `超过单行业上限 ${(config.max_single_industry_pct * 100).toFixed(2)}%。`,
      detail: {
        industry,
        symbol: ctx.symbol,
        existing_industry_value: existing,
        proposed_value: ctx.proposed_value,
        projected_value: projected,
        total_value: ctx.total_value,
        projected_pct,
        max_single_industry_pct: config.max_single_industry_pct,
      },
    };
  }
  return null;
}

/**
 * Run all 3 checks in priority order (count → single-stock → industry) and
 * return the FIRST violation found, or null if all checks pass.
 *
 * Priority matters for `RiskAlert` UX: we surface ONE clear reason ("超持仓
 * 数") rather than spamming the user with a cascade.  If they fix the first
 * one (e.g. closing a position) the next attempt will see the second check
 * cleanly.
 */
export function pickSingleViolation(
  ctx: OrderContext,
  config: PositionLimitsConfig
): LimitViolation | null {
  return (
    evaluatePositionCount(ctx, config) ||
    evaluateSingleStock(ctx, config) ||
    evaluateSingleIndustry(ctx, config)
  );
}

// ---------------------------------------------------------------------------
//  DataSource — DI seam for unit tests
// ---------------------------------------------------------------------------

export interface PositionLimitDataSource {
  /** Load the user's portfolio (current_cash + total_value) or null. */
  loadPortfolio(user_id: number): Promise<{ total_value: number } | null>;
  /** Load all PaperTradingPosition rows for the user (already-held holdings). */
  loadPositions(user_id: number): Promise<HeldPositionSnapshot[]>;
  /** Look up the industry classification for `symbol`. */
  loadIndustryForSymbol(symbol: string): Promise<string | null>;
  /** Load this user's persisted config; falls back to defaults if absent. */
  loadConfig(user_id: number): Promise<PositionLimitsConfig>;
  /** Persist this user's config (UPSERT semantics). */
  saveConfig(user_id: number, config: PositionLimitsConfig): Promise<PositionLimitsConfig>;
  /** Write a single RiskAlert row. */
  writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    message: string;
  }): Promise<void>;
}

/**
 * Production DataSource — backed by Sequelize.  All DB I/O goes through
 * here; the guard methods only see the snapshot data.
 */
export class DefaultPositionLimitDataSource implements PositionLimitDataSource {
  async loadPortfolio(user_id: number) {
    // 修复 (2026-06-16, HIGH H2): 跨所有 active portfolio 聚合 total_value
    const portfolios = await PaperTradingPortfolio.findAll({
      where: { user_id, is_active: true },
      attributes: ['total_value'],
    });
    if (portfolios.length === 0) return null;
    const totalValue = portfolios.reduce((s, p) => s + Number(p.total_value || 0), 0);
    return { total_value: totalValue };
  }

  async loadPositions(user_id: number) {
    // 修复 (HIGH H2): 跨所有 active portfolio 拉持仓
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
    return rows.map<HeldPositionSnapshot>(r => ({
      symbol: r.symbol,
      market_value: Number(r.market_value),
      industry: industryMap.get(r.symbol) ?? null,
    }));
  }

  async loadIndustryForSymbol(symbol: string) {
    const s = await Stock.findOne({ where: { symbol }, attributes: ['industry'] });
    return s?.industry ?? null;
  }

  async loadConfig(user_id: number) {
    const user = await User.findByPk(user_id);
    const raw = user?.risk_config?.position_limits;
    return normalizePositionLimitsConfig(raw);
  }

  async saveConfig(user_id: number, config: PositionLimitsConfig) {
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`saveConfig: user ${user_id} not found`);
    }
    const merged = {
      ...(user.risk_config || {}),
      position_limits: { ...config },
    };
    user.risk_config = merged;
    // JSONB columns require explicit `changed('field', true)` after in-place
    // mutation per the project's US-017 pattern.
    user.changed('risk_config', true);
    await user.save();
    return { ...config };
  }

  async writeAlert(input: { user_id: number; symbol: string; name: string; message: string }) {
    // 拿 stock_name 拼到 RiskAlert.name，让飞书卡片/UI 显示"贵州茅台 仓位限制告警 - single_industry_cap"
    // 而不只是"600519 仓位限制告警 - single_industry_cap"
    let stockName = '';
    try {
      const { Stock } = require('../../models/Stock');
      const stock = await Stock.findOne({
        where: { symbol: input.symbol },
        attributes: ['name'],
        raw: true,
      });
      if (stock?.name) stockName = stock.name;
    } catch {
      // 静默：拿不到 stock_name 不影响 alert 写入
    }
    const enrichedName = stockName ? `${stockName} · ${input.name}` : input.name;
    await RiskAlert.create({
      user_id: input.user_id,
      symbol: input.symbol,
      name: enrichedName,
      level: 'HIGH',
      message: input.message,
      // US-067 — RealtimeAlertDispatcher 用 rule_id 作 dedup signature 一部分。
      // 不同 guard 写入的 rule_id 不同，避免"持仓数上限"和"行业集中度"等不同
      // 规则的 HIGH 告警被 unknown::symbol::HIGH 同 signature dedup 互相吃掉。
      rule_id: 'position_limit',
      is_read: false,
    } as any);
  }
}

export const PRODUCTION_POSITION_LIMIT_DATA_SOURCE: PositionLimitDataSource =
  new DefaultPositionLimitDataSource();

// ---------------------------------------------------------------------------
//  Config normalization
// ---------------------------------------------------------------------------

/**
 * Sanitize a raw `position_limits` blob loaded from `User.risk_config` (or
 * the request body) into a guaranteed-valid `PositionLimitsConfig`.
 *
 * - Missing / non-numeric / non-finite values fall back to `DEFAULT_*`.
 * - Negative counts coerce to the default.
 * - Percentages outside `[0, 1]` coerce to the default.  Allowing 1.0 (100%)
 *   means "no cap"; allowing 0 means "block all buys" which is a valid
 *   safe-mode and not coerced away.
 */
export function normalizePositionLimitsConfig(raw: any): PositionLimitsConfig {
  const safeInt = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : dflt;
  };
  const safePct = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
  };
  return {
    max_positions: safeInt(raw?.max_positions, DEFAULT_POSITION_LIMITS.max_positions),
    max_single_stock_pct: safePct(
      raw?.max_single_stock_pct,
      DEFAULT_POSITION_LIMITS.max_single_stock_pct
    ),
    max_single_industry_pct: safePct(
      raw?.max_single_industry_pct,
      DEFAULT_POSITION_LIMITS.max_single_industry_pct
    ),
  };
}

// ---------------------------------------------------------------------------
//  Guard — public entry point
// ---------------------------------------------------------------------------

export interface CheckOrderInput {
  user_id: number;
  symbol: string;
  proposed_value: number;
}

export interface CheckOrderResult {
  ok: boolean;
  violation?: LimitViolation;
  config: PositionLimitsConfig;
}

export class PositionLimitGuard {
  private source: PositionLimitDataSource;

  constructor(source: PositionLimitDataSource = PRODUCTION_POSITION_LIMIT_DATA_SOURCE) {
    this.source = source;
  }

  /**
   * Evaluate a proposed BUY against the user's current portfolio.  If a
   * violation is found:
   *   - persist a `RiskAlert(level='HIGH')` row (best-effort, errors logged)
   *   - return `{ok:false, violation, config}`
   * Callers (PaperTradingFacade.placeOrder) should throw a user-facing
   * error using `violation.message`.
   */
  async checkBuyOrder(input: CheckOrderInput): Promise<CheckOrderResult> {
    const config = await this.source.loadConfig(input.user_id);
    const portfolio = await this.source.loadPortfolio(input.user_id);
    if (!portfolio || portfolio.total_value <= 0) {
      // Without a portfolio (or zero total value) we cannot evaluate
      // percentages.  Pass through — the upstream `placeOrder` already
      // rejects orders without a portfolio.
      return { ok: true, config };
    }
    const positions = await this.source.loadPositions(input.user_id);
    const industry = await this.source.loadIndustryForSymbol(input.symbol);

    const ctx: OrderContext = {
      user_id: input.user_id,
      symbol: input.symbol,
      proposed_value: input.proposed_value,
      total_value: portfolio.total_value,
      positions,
      industry,
    };

    const violation = pickSingleViolation(ctx, config);
    if (!violation) {
      return { ok: true, config };
    }

    // Persist alert — failures here MUST NOT mask the violation; we still
    // want to reject the order.
    try {
      await this.source.writeAlert({
        user_id: input.user_id,
        symbol: input.symbol,
        name: `仓位限制告警 - ${violation.rule}`,
        message: violation.message,
      });
    } catch (err) {
      logger.warn(
        `PositionLimitGuard: writeAlert failed user=${input.user_id} symbol=${input.symbol} ` +
          `rule=${violation.rule}: ${(err as Error).message}`
      );
    }

    return { ok: false, violation, config };
  }

  /** Return the user's effective config (uses defaults if not customized). */
  async getConfig(user_id: number): Promise<PositionLimitsConfig> {
    return this.source.loadConfig(user_id);
  }

  /** Persist a (normalized) updated config for the user. */
  async updateConfig(user_id: number, raw: any): Promise<PositionLimitsConfig> {
    const normalized = normalizePositionLimitsConfig(raw);
    return this.source.saveConfig(user_id, normalized);
  }
}

/** Singleton — controllers / facade reach this instead of `new`-ing per call. */
export const positionLimitGuard = new PositionLimitGuard();
