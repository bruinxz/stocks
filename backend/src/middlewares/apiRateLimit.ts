/**
 * apiRateLimit.ts — ADR-0010 §4.5 · IETF draft-ietf-httpapi-ratelimit-headers-08 (2024)
 * RateLimit + RateLimit-Policy response headers.
 *
 * Reads optional `api_rate_limit` block from `backend/package.json`:
 *   {
 *     "api_rate_limit": {
 *       "policy_name": "default",
 *       "quota": 100,
 *       "window_seconds": 60
 *     }
 *   }
 *
 * 无 config → middleware zero-emit (default OFF). Advisory-only (§4.5 does NOT enforce
 * 429 · does NOT track counters). Enforcement is a separate future PR (pluggable adapter).
 *
 * Header shape (draft-08 canonical):
 *   RateLimit: "default";r=100;t=60
 *   RateLimit-Policy: "default";q=100;w=60
 *
 * Orch v222 §四 A-3 dispatch matrix: §4.5 candidate autonomous · CREATE-AUTHORIZE NOW.
 *
 * Attribution: IETF draft-ietf-httpapi-ratelimit-headers-08 (Roberto Polli et al · 2024) ·
 * GitHub REST + Stripe API rate-limit shape (advisory reference · not code-copy) ·
 * 无外部 lib 借鉴 (pure express + pkg.json read · §4.4 pattern mirror).
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

export interface RateLimitConfig {
  policy_name?: string;
  quota?: number;
  window_seconds?: number;
}

const PKG_RATE_LIMIT_CONFIG: RateLimitConfig | null =
  (pkg as { api_rate_limit?: RateLimitConfig }).api_rate_limit ?? null;

const DEFAULT_POLICY_NAME = 'default';

export function buildApiRateLimitMiddleware(config: RateLimitConfig | null) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!config) {
      return next();
    }
    const { policy_name, quota, window_seconds } = config;
    const name =
      typeof policy_name === 'string' && policy_name.length > 0 ? policy_name : DEFAULT_POLICY_NAME;
    const quotaOk = typeof quota === 'number' && Number.isFinite(quota);
    const windowOk = typeof window_seconds === 'number' && Number.isFinite(window_seconds);

    const policyParts: string[] = [`"${name}"`];
    if (quotaOk) policyParts.push(`q=${quota}`);
    if (windowOk) policyParts.push(`w=${window_seconds}`);
    if (policyParts.length > 1) {
      res.setHeader('RateLimit-Policy', policyParts.join(';'));
    }

    const rlParts: string[] = [`"${name}"`];
    if (quotaOk) rlParts.push(`r=${quota}`);
    if (windowOk) rlParts.push(`t=${window_seconds}`);
    if (rlParts.length > 1) {
      res.setHeader('RateLimit', rlParts.join(';'));
    }

    next();
  };
}

export const apiRateLimitMiddleware = () =>
  buildApiRateLimitMiddleware(PKG_RATE_LIMIT_CONFIG);

export const CURRENT_RATE_LIMIT_CONFIG = PKG_RATE_LIMIT_CONFIG;
