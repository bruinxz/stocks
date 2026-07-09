/**
 * apiTimingAllowOrigin.ts — ADR-0010 §4.8 · W3C Server-Timing Level 1 §3
 * "Timing-Allow-Origin" (Candidate Recommendation 25-May-2022) cross-origin
 * observation advisory header.
 *
 * Reads optional `api_timing_allow_origin` block from `backend/package.json`:
 *   {
 *     "api_timing_allow_origin": {
 *       "allow_all": false,
 *       "allowlist": [
 *         "https://raft-frontend.example.com",
 *         "https://staging.raft.example.com"
 *       ]
 *     }
 *   }
 *
 * 无 config → middleware zero-emit (default OFF · same-origin observation
 * only per browser default). allow_all=false + empty allowlist → also
 * zero-emit. Advisory-only (§4.8 does NOT enforce or short-circuit; pure
 * cross-origin exposure annotation composed with §4.7 Server-Timing).
 *
 * Header shape (Server-Timing L1 §3 canonical · ABNF):
 *   Timing-Allow-Origin = "*" / #origin
 *
 * When `allow_all=true`  → emit `Timing-Allow-Origin: *` verbatim
 * When `allowlist` match → emit `Timing-Allow-Origin: <matched-origin>` echo
 * When neither          → zero-emit (cross-origin observation blocked)
 *
 * Implementation: patches res.writeHead in-place (§4.7 pattern mirror ·
 * origin match happens at header-flush time so cross-cutting middleware
 * ordering doesn't matter). Existing Timing-Allow-Origin set by route
 * handler is NOT overwritten (route authority wins).
 *
 * Orch v238 §四 A-3 dispatch matrix: §4.8 Option A CORS Timing-Allow-Origin
 * autonomous CREATE-AUTHORIZE ISSUED (msg=ad829377).
 *
 * Attribution: W3C Server-Timing Level 1 §3 "Timing-Allow-Origin" (Candidate
 * Recommendation 25-May-2022 · Ilya Grigorik / Nic Jansma editors · public
 * open-standard) · RFC 6454 origin grammar §4 (December 2011 · IETF · Adam
 * Barth) · 无外部 lib 借鉴 (pure express + pkg.json read · §4.7
 * writeHead-monkeypatch pattern mirror per msg=ad6585cf 借鉴 独立性 铁律).
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

export interface TimingAllowOriginConfig {
  allow_all?: boolean;
  allowlist?: string[];
}

const PKG_TAO_CONFIG: TimingAllowOriginConfig | null =
  (pkg as { api_timing_allow_origin?: TimingAllowOriginConfig }).api_timing_allow_origin ?? null;

// RFC 6454 §4 origin = scheme "://" host [ ":" port ]
// v0 canonical: exact case-sensitive match against allowlist (no wildcard
// subdomain, no scheme/host normalization). Callers publish canonical
// origins in config verbatim.
function matchesAllowlist(origin: string, allowlist: string[]): boolean {
  return allowlist.includes(origin);
}

export function buildApiTimingAllowOriginMiddleware(config: TimingAllowOriginConfig | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config) {
      return next();
    }
    const allowAll = config.allow_all === true;
    const allowlist = Array.isArray(config.allowlist) ? config.allowlist : [];
    if (!allowAll && allowlist.length === 0) {
      return next();
    }

    const origWriteHead = res.writeHead.bind(res);
    (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead =
      function patchedWriteHead(this: Response, ...args: unknown[]): Response {
        if (!res.getHeader('Timing-Allow-Origin')) {
          if (allowAll) {
            res.setHeader('Timing-Allow-Origin', '*');
          } else {
            const origin = req.get('origin');
            if (typeof origin === 'string' && matchesAllowlist(origin, allowlist)) {
              res.setHeader('Timing-Allow-Origin', origin);
            }
          }
        }
        return (origWriteHead as (...a: unknown[]) => Response)(...args);
      };
    next();
  };
}

export const apiTimingAllowOriginMiddleware = () =>
  buildApiTimingAllowOriginMiddleware(PKG_TAO_CONFIG);

export const CURRENT_TAO_CONFIG = PKG_TAO_CONFIG;
