/**
 * RiskGuardFailClosed — US-011 (PR-006)
 *
 * Unified fail-CLOSED helper extracted from BETA-7 (DrawdownCircuitBreaker
 * audit M-13). Before this module the fail-CLOSED contract was duplicated in
 * three places:
 *
 *   1. `DrawdownCircuitBreaker.checkBuyAllowed` — inline try/catch + new
 *      RiskGuardUnavailableError;
 *   2. `PaperTradingFacade._placeOrderInner` — duplicated catch + RiskAlert
 *      HIGH write + rethrow block;
 *   3. `preTradeGuards.checkPreBuyGuards` — same duplicated block returning
 *      `{ok:false, code:'RISK_GUARD_UNAVAILABLE'}`.
 *
 * Three drifts already showed up under audit:
 *   - `PositionLimitGuard.checkBuyOrder` never had fail-CLOSED at all (DB
 *     outage in `loadConfig` / `loadPortfolio` / `loadPositions` propagated as
 *     raw Sequelize errors, eventually surfacing as 500 to the user with no
 *     RiskAlert);
 *   - Caller-side RiskAlert write payload was copy-pasted with mildly
 *     diverging `message` / `metadata` shapes (e.g. facade message had no
 *     leading ⚠️ on first iteration);
 *   - Future guards (BlackSwanWatchdog pre-trade hook, IndustryConcentrationGuard
 *     etc.) would inherit none of this if they got wired into a BUY path.
 *
 * This module is the single source of truth for:
 *   - `RiskGuardUnavailableError` — class identifying the "guard's own
 *     infrastructure failed, fail-CLOSED reject" contract (statusCode=503,
 *     code='RISK_GUARD_UNAVAILABLE');
 *   - `wrapFailClosed(guardName, fn, detail?)` — guard-side helper for any
 *     async pre-trade check. Re-throws RiskGuardUnavailableError unchanged,
 *     converts any other thrown error into RiskGuardUnavailableError so the
 *     contract holds even if the guard's own code throws unexpectedly;
 *   - `handleRiskGuardUnavailable(input)` — caller-side helper. Writes a HIGH
 *     RiskAlert with the standard `SYSTEM:RISK_GUARD_UNAVAILABLE` symbol +
 *     `rule_id` derived from the guard name. Best-effort: alert write failure
 *     is logged but never masks the rejection.
 *
 * Design constraints (sympathetic with other risk-guard patterns in this dir):
 *   - No DB import inside this file — the caller passes the RiskAlert model
 *     (or a fake) via `dataSource` to keep this module unit-testable without
 *     Sequelize init;
 *   - Re-export `RiskGuardUnavailableError` from `DrawdownCircuitBreaker.ts`
 *     stays alive (back-compat for existing imports — `preTradeGuards.ts`,
 *     `PaperTradingFacade.ts`, and several .test.ts files); we simply make
 *     `DrawdownCircuitBreaker.ts` re-export from here as the canonical source;
 *   - `wrapFailClosed` is fail-CLOSED even on programmer-error: if the
 *     wrapped fn throws a TypeError or ReferenceError due to a bug, the user
 *     experience is "503 风控不可用" (safe) instead of "500 cannot read
 *     property of undefined" (leaks stacktrace + technically a fail-OPEN since
 *     PaperTradingFacade's outer try doesn't catch it for the BUY path).
 *
 * Why a class instead of a plain Error subclass marker?
 *   - `err instanceof RiskGuardUnavailableError` is used at three call sites
 *     to discriminate "guard-rejected this trade for an infrastructure
 *     reason" vs "guard-rejected this trade for a business reason". The
 *     `code` string is also matched in tests, so both surface keep working.
 */

import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
//  Error class — fail-CLOSED contract
// ---------------------------------------------------------------------------

/**
 * Risk guard infrastructure unavailable — fail-CLOSED throw.
 *
 * Call sites:
 *   - guard-side: `wrapFailClosed` re-throws when the wrapped fn throws;
 *   - caller-side: `PaperTradingFacade._placeOrderInner`, `preTradeGuards.
 *     checkPreBuyGuards` catch this and convert to `{ok:false}` or a
 *     400/503 user-facing error after writing RiskAlert HIGH.
 *
 * Rationale: guard DB抖动 → 风控失效 → 大撤回不暂停 is a high-cost failure
 * mode. We trade a rare 503 for never letting risk silently bypass.
 */
export class RiskGuardUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'RISK_GUARD_UNAVAILABLE';
  readonly guardName: string;
  readonly detail?: Record<string, any>;
  constructor(message: string, guardName: string, detail?: Record<string, any>) {
    super(message);
    this.name = 'RiskGuardUnavailableError';
    this.guardName = guardName;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
//  Guard-side helper
// ---------------------------------------------------------------------------

/**
 * Wrap an async pre-trade check body in fail-CLOSED semantics.
 *
 * Behaviour matrix:
 *   - fn resolves cleanly → resolved value forwarded;
 *   - fn throws RiskGuardUnavailableError → re-thrown as-is (preserves the
 *     original `guardName` / `detail` from the inner guard);
 *   - fn throws any other Error → wrapped into RiskGuardUnavailableError
 *     tagged with the outer `guardName` + the caller-provided `detail`.
 *
 * `guardName` must be the short kebab-case identifier ('drawdown_breaker',
 * 'position_limit', 'trailing_stop', etc.) — it doubles as the `rule_id`
 * used by `handleRiskGuardUnavailable` when writing the RiskAlert row.
 *
 * @example
 *   async checkBuyAllowed(input: CheckBuyAllowedInput) {
 *     return wrapFailClosed('drawdown_breaker', async () => {
 *       const config = await this.source.loadConfig(input.user_id);
 *       // ... real logic ...
 *       return { ok: true };
 *     }, { user_id: input.user_id, symbol: input.symbol });
 *   }
 */
export async function wrapFailClosed<T>(
  guardName: string,
  fn: () => Promise<T>,
  detail?: Record<string, any>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RiskGuardUnavailableError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[risk-guard:${guardName}] fail-CLOSED on unexpected error: ${msg}`);
    throw new RiskGuardUnavailableError(`${guardName} 不可用: ${msg}`, guardName, {
      ...(detail || {}),
      cause: msg,
    });
  }
}

// ---------------------------------------------------------------------------
//  Caller-side helper
// ---------------------------------------------------------------------------

/**
 * Minimal RiskAlert model interface required by `handleRiskGuardUnavailable`.
 *
 * We declare this locally rather than importing the Sequelize RiskAlert
 * model to keep `RiskGuardFailClosed.ts` unit-testable without DB init; the
 * caller passes the real model (or a fake) via `dataSource`.
 */
export interface RiskAlertCreator {
  create(input: {
    user_id: number;
    symbol: string;
    name: string;
    level: 'HIGH' | 'MEDIUM' | 'LOW';
    rule_id: string;
    message: string;
    metadata?: Record<string, any>;
    is_read?: boolean;
  }): Promise<any>;
}

/**
 * Build the standard RiskAlert payload for a fail-CLOSED rejection.
 *
 * Exposed for unit tests — also lets non-default callers (e.g. realtime
 * dispatcher fan-out) inspect the payload without invoking RiskAlert.create.
 *
 * Keep this in sync with the existing wire-in shapes:
 *   - symbol = 'SYSTEM:RISK_GUARD_UNAVAILABLE' (UI / Grafana group all 503s);
 *   - name = `风控不可用 — <human label>` (auto-derived from guardName);
 *   - level = 'HIGH' (operator must see this — never bury fail-CLOSED);
 *   - rule_id = guardName (RealtimeAlertDispatcher dedup signature).
 */
export function buildRiskGuardUnavailablePayload(input: {
  user_id: number;
  guardName: string;
  symbol: string;
  reason: string;
  callerLabel: string;
  detail?: Record<string, any>;
}): {
  user_id: number;
  symbol: string;
  name: string;
  level: 'HIGH';
  rule_id: string;
  message: string;
  metadata: Record<string, any>;
  is_read: false;
} {
  const humanLabel = GUARD_LABELS[input.guardName] || input.guardName;
  return {
    user_id: input.user_id,
    symbol: 'SYSTEM:RISK_GUARD_UNAVAILABLE',
    name: `风控不可用 — ${humanLabel}`,
    level: 'HIGH',
    rule_id: input.guardName,
    message:
      `⚠️ ${humanLabel} 不可用: ${input.reason}. ` +
      `拒绝 ${input.callerLabel} BUY ${input.symbol} (fail-CLOSED).`,
    metadata: {
      guard: input.guardName,
      symbol: input.symbol,
      caller: input.callerLabel,
      ...(input.detail || {}),
    },
    is_read: false,
  };
}

/**
 * Human-readable guard labels for RiskAlert.name. Add new guards here when
 * wiring fail-CLOSED into another pre-trade gate.
 */
const GUARD_LABELS: Record<string, string> = {
  drawdown_breaker: 'DrawdownCircuitBreaker',
  position_limit: 'PositionLimitGuard',
  trailing_stop: 'TrailingStopGuard',
  per_stock_stop_loss: 'PerStockStopLossGuard',
  industry_concentration: 'IndustryConcentrationGuard',
  black_swan: 'BlackSwanWatchdog',
  market_regime: 'MarketRegimeAlertService',
  morning_checkup: 'MorningRiskCheckupService',
  restricted_share: 'RestrictedShareWatchdog',
};

/**
 * Caller-side: write a HIGH RiskAlert and return the structured payload.
 *
 * Best-effort: if `dataSource.create` throws (e.g. RiskAlert table is also
 * unavailable), we log and move on — the rejection itself is the primary
 * outcome, not the alert.
 *
 * `callerLabel` is a short identifier for which caller hit this fail-CLOSED
 * ('facade.placeOrder', 'automation.createBuyTrade', etc.). It appears in
 * the RiskAlert.message + metadata so operators can attribute the 503.
 *
 * Returns the payload for caller to use in error responses (e.g. the
 * `detail` field of the user-facing error).
 */
export async function handleRiskGuardUnavailable(input: {
  err: RiskGuardUnavailableError;
  user_id: number;
  symbol: string;
  callerLabel: string;
  dataSource: RiskAlertCreator;
}): Promise<ReturnType<typeof buildRiskGuardUnavailablePayload>> {
  const payload = buildRiskGuardUnavailablePayload({
    user_id: input.user_id,
    guardName: input.err.guardName || 'unknown_guard',
    symbol: input.symbol,
    reason: input.err.message,
    callerLabel: input.callerLabel,
    detail: input.err.detail,
  });
  try {
    await input.dataSource.create(payload);
  } catch (alertErr: any) {
    logger.warn(
      `[risk-guard-fail-closed] RiskAlert.create RISK_GUARD_UNAVAILABLE failed ` +
        `(caller=${input.callerLabel} guard=${input.err.guardName}): ` +
        `${alertErr?.message || alertErr}`
    );
  }
  return payload;
}

/**
 * Lazy RiskAlert loader — required for production callers since
 * `PaperTradingFacade.ts` already lazy-requires the model to avoid circular
 * import. Exposed here so callers don't need to repeat the require dance.
 */
export function loadProductionRiskAlertCreator(): RiskAlertCreator {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { RiskAlert } = require('../../models/RiskAlert');
  return RiskAlert as RiskAlertCreator;
}
