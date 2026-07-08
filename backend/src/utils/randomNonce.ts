/**
 * Cryptographically-random alphabet nonce helper.
 *
 * Extracted in US-038 Phase 3 (Task #29) so that WeChat OA `nonceStr`
 * generation (WeChatOAClient `defaultRand6`) stops driving each character
 * pick through Math.random(). Unlike `randomHex.ts`, callers here need a
 * custom character set (e.g. `A-Z0-9`, 36 symbols) rather than raw hex,
 * so `crypto.randomBytes(N).toString('hex')` is not a drop-in replacement.
 *
 * `crypto.randomInt(min, max)` performs unbiased rejection sampling internally,
 * so the returned character is exactly-uniform over `alphabet` regardless of
 * whether `alphabet.length` divides evenly into a power of two.
 *
 * Semantics vs original loop:
 *   original: chars[Math.floor(Math.random() * chars.length)] × len   (biased for non-power-of-2 alphabets · replay-safe)
 *   new    : alphabet[crypto.randomInt(0, alphabet.length)] × len     (unbiased · crypto-random · no replay)
 *
 * Use this for NONCE-style tokens (WeChat OA, other API signature nonces).
 * Do NOT use for backtest / execution PRNG paths — those must remain
 * deterministic via `utils/SeededRandom`.
 */

import { randomInt } from 'crypto';

export function randomAlphaNonce(len: number, alphabet: string): string {
  if (!Number.isInteger(len) || len <= 0) {
    throw new Error(`randomAlphaNonce: invalid len=${len} · expected positive integer`);
  }
  if (typeof alphabet !== 'string' || alphabet.length === 0) {
    throw new Error('randomAlphaNonce: alphabet must be a non-empty string');
  }
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}
