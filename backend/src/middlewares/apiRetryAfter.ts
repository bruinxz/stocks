/**
 * apiRetryAfter.ts — ADR-0010 §4.6 · RFC 9110 §10.2.3 Retry-After header
 * (delay-seconds form).
 *
 * Reads optional `api_retry_after` block from `backend/package.json`:
 *   {
 *     "api_retry_after": {
 *       "map": {
 *         "429": 60,
 *         "503": 30
 *       }
 *     }
 *   }
 *
 * 无 config → middleware zero-emit (default OFF). Advisory-only (§4.6 does NOT
 * decide when to send 429/503 · enforcement is a separate future PR).
 *
 * Header shape (RFC 9110 §10.2.3 delay-seconds canonical · §4.6 scope):
 *   HTTP/1.1 429 Too Many Requests
 *   Retry-After: 60
 *   HTTP/1.1 503 Service Unavailable
 *   Retry-After: 30
 *
 * Implementation: patches res.writeHead in-place (unlike §4.1/§4.4/§4.5 which
 * emit at middleware invocation, Retry-After depends on route-decided
 * res.statusCode observed at header-flush time · res.on('finish') fires AFTER
 * headers are flushed, too late). Fail-OPEN skip on invalid seconds. Existing
 * Retry-After set by route handler is NOT overwritten (route authority wins).
 *
 * Orch v232 §六/§七 A-3 dispatch matrix: §4.6 Retry-After autonomous CREATE-AUTHORIZE NOW.
 *
 * Attribution: RFC 9110 §10.2.3 (June 2022 · IETF HTTP Working Group · Roy Fielding et al ·
 * public open-standard) · RFC 6585 §4 (429 Too Many Requests semantic · April 2012) ·
 * 无外部 lib 借鉴 (pure express + pkg.json read · §4.4/§4.5 pattern mirror per
 * msg=ad6585cf 借鉴独立性 铁律).
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

export interface RetryAfterConfig {
  map?: Record<string, number>;
}

const PKG_RETRY_AFTER_CONFIG: RetryAfterConfig | null =
  (pkg as { api_retry_after?: RetryAfterConfig }).api_retry_after ?? null;

export function buildApiRetryAfterMiddleware(config: RetryAfterConfig | null) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!config || !config.map) {
      return next();
    }
    const map = config.map;
    const origWriteHead = res.writeHead.bind(res);
    (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead =
      function patchedWriteHead(this: Response, ...args: unknown[]): Response {
        const status = args[0];
        if (typeof status === 'number' && Object.prototype.hasOwnProperty.call(map, String(status))) {
          const seconds = map[String(status)];
          if (
            typeof seconds === 'number' &&
            Number.isFinite(seconds) &&
            seconds >= 0 &&
            Number.isInteger(seconds)
          ) {
            if (!res.getHeader('Retry-After')) {
              res.setHeader('Retry-After', String(seconds));
            }
          }
        }
        return (origWriteHead as (...a: unknown[]) => Response)(...args);
      };
    next();
  };
}

export const apiRetryAfterMiddleware = () =>
  buildApiRetryAfterMiddleware(PKG_RETRY_AFTER_CONFIG);

export const CURRENT_RETRY_AFTER_CONFIG = PKG_RETRY_AFTER_CONFIG;
