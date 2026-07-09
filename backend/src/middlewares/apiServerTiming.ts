/**
 * apiServerTiming.ts — ADR-0010 §4.7 · W3C Server-Timing Level 1 (Candidate
 * Recommendation 25-May-2022) advisory-observability header.
 *
 * Reads optional `api_server_timing` block from `backend/package.json`:
 *   {
 *     "api_server_timing": {
 *       "static_metrics": [
 *         { "name": "app", "desc": "raft-backend" }
 *       ],
 *       "measure_total": true
 *     }
 *   }
 *
 * 无 config → middleware zero-emit (default OFF). Empty static_metrics +
 * measure_total=false → also zero-emit. Advisory-only (§4.7 does NOT enforce
 * any performance budget · pure request-response observability annotation).
 *
 * Header shape (Server-Timing L1 §2.2 canonical · §4.7 scope):
 *   HTTP/1.1 200 OK
 *   Server-Timing: app;desc="raft-backend", total;dur=47.2
 *
 * Implementation: patches res.writeHead in-place (§4.6 pattern mirror ·
 * timing measurement is only meaningful at header-flush time; res.on('finish')
 * fires post-flush, too late to mutate headers). Uses process.hrtime.bigint()
 * ns-precision monotonic clock (immune to system-clock adjustments). Fail-OPEN
 * skip on invalid metric-name / invalid dur. Existing Server-Timing set by
 * route handler is NOT overwritten (route authority wins).
 *
 * Orch v235 §五 A-3 dispatch matrix: §4.7 Server-Timing autonomous CREATE-AUTHORIZE NOW.
 *
 * Attribution: W3C Server-Timing Level 1 (Candidate Recommendation 25-May-2022 ·
 * Ilya Grigorik / Nic Jansma editors · public open-standard) · RFC 7230 §3.2.6
 * token grammar (June 2014 · IETF · Roy Fielding + Julian Reschke) · 无外部
 * lib 借鉴 (pure express + pkg.json read + process.hrtime.bigint() Node
 * built-in · §4.6 writeHead-monkeypatch pattern mirror per msg=ad6585cf 借鉴
 * 独立性 铁律).
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

export interface ServerTimingMetric {
  name: string;
  dur?: number;
  desc?: string;
}

export interface ServerTimingConfig {
  static_metrics?: ServerTimingMetric[];
  measure_total?: boolean;
}

const PKG_SERVER_TIMING_CONFIG: ServerTimingConfig | null =
  (pkg as { api_server_timing?: ServerTimingConfig }).api_server_timing ?? null;

// RFC 7230 §3.2.6 token = 1*tchar
// tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." / "^"
//       / "_" / "`" / "|" / "~" / DIGIT / ALPHA
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isValidMetricName(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && TOKEN_RE.test(s);
}

function isValidDur(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function serializeMetric(m: ServerTimingMetric): string | null {
  if (!isValidMetricName(m.name)) {
    return null;
  }
  const parts: string[] = [m.name];
  if (typeof m.desc === 'string' && m.desc.length > 0) {
    // quoted-string canonical per RFC 7230 · always quote for safety
    const escaped = m.desc.replace(/[\\"]/g, '\\$&');
    parts.push(`desc="${escaped}"`);
  }
  if (m.dur !== undefined && isValidDur(m.dur)) {
    parts.push(`dur=${m.dur}`);
  }
  return parts.join(';');
}

export function buildApiServerTimingMiddleware(config: ServerTimingConfig | null) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!config) {
      return next();
    }
    const staticMetrics = Array.isArray(config.static_metrics) ? config.static_metrics : [];
    const measureTotal = config.measure_total === true;
    if (staticMetrics.length === 0 && !measureTotal) {
      return next();
    }

    const startNs = process.hrtime.bigint();
    const origWriteHead = res.writeHead.bind(res);
    (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead =
      function patchedWriteHead(this: Response, ...args: unknown[]): Response {
        if (!res.getHeader('Server-Timing')) {
          const parts: string[] = [];
          for (const m of staticMetrics) {
            const serialized = serializeMetric(m);
            if (serialized !== null) {
              parts.push(serialized);
            }
          }
          if (measureTotal) {
            const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
            if (isValidDur(elapsedMs)) {
              parts.push(`total;dur=${elapsedMs.toFixed(3)}`);
            }
          }
          if (parts.length > 0) {
            res.setHeader('Server-Timing', parts.join(', '));
          }
        }
        return (origWriteHead as (...a: unknown[]) => Response)(...args);
      };
    next();
  };
}

export const apiServerTimingMiddleware = () =>
  buildApiServerTimingMiddleware(PKG_SERVER_TIMING_CONFIG);

export const CURRENT_SERVER_TIMING_CONFIG = PKG_SERVER_TIMING_CONFIG;
