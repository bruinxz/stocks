/**
 * Cryptographically-random hex helpers.
 *
 * Extracted in US-038 Phase 2 (Task #29) so that the four report services
 * (DailyTradingDigest / EnhancedTradingJournal / RealtimeAlertDispatcher /
 * WeeklyReviewReport) share one implementation instead of each declaring a
 * local `randHex4` that ultimately called `Math.random()`.
 *
 * Space equivalence: `crypto.randomBytes(2)` yields 16 bits of entropy,
 * matching the original `Math.floor(Math.random() * 0xffff)` range of
 * `0x0000`-`0xffff`. Hard-random is preferred here because report IDs have
 * no replay/seed requirement (unlike backtest/execution PRNG paths).
 */

import { randomBytes } from 'crypto';

export function randHex4(): string {
  return randomBytes(2).toString('hex');
}
