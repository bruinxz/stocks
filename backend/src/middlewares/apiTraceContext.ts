/**
 * apiTraceContext.ts — ADR-0010 §4.9 · W3C Trace Context Level 1 (W3C
 * Recommendation 23-Nov-2021) distributed-tracing carrier advisory header.
 *
 * Reads optional `api_trace_context` block from `backend/package.json`:
 *   {
 *     "api_trace_context": {
 *       "echo_traceparent": true,
 *       "echo_tracestate": true
 *     }
 *   }
 *
 * 无 config → middleware zero-emit (default OFF · same-service tracing only).
 * echo_traceparent=false + echo_tracestate=false → also zero-emit. Advisory-only
 * (§4.9 does NOT enforce sampling or short-circuit; pure header pass-through
 * per W3C Trace Context §2 "propagation" carrier semantics).
 *
 * Header shapes (W3C Trace Context L1 §3 canonical · ABNF):
 *   traceparent = version "-" trace-id "-" parent-id "-" trace-flags
 *                 version    = 2HEXDIG          (this v0 accepts "00" only)
 *                 trace-id   = 32HEXDIG lower   (MUST NOT be all zeros)
 *                 parent-id  = 16HEXDIG lower   (MUST NOT be all zeros)
 *                 trace-flags= 2HEXDIG lower
 *   tracestate  = list-member 0*31( OWS "," OWS list-member )
 *                 list-member= key "=" value
 *
 * Echo-only v0 · this middleware does NOT generate new trace-id / parent-id
 * (avoids US-038 SeededRandom scope question · new-span generation deferred
 * to a future §4.9.1 explicit dispatch). When a well-formed incoming
 * traceparent is present, we echo it verbatim to the response so downstream
 * observability consumers can correlate the request/response pair. Invalid
 * or missing traceparent → zero-emit (fail-OPEN per §4.5-§4.8 discipline).
 *
 * Implementation: patches res.writeHead in-place (§4.7 + §4.8 pattern mirror
 * · trace-header emit at header-flush time so cross-cutting middleware
 * ordering doesn't matter). Existing traceparent / tracestate set by route
 * handler is NOT overwritten (route authority wins).
 *
 * Orch v243 §六 A-3 dispatch matrix: §4.9 W3C Trace Context autonomous
 * CREATE-AUTHORIZE NOW (msg=93ed7946).
 *
 * Attribution: W3C Trace Context Level 1 (Recommendation 23-November-2021 ·
 * Dominik Kundel / Nik Molnar editors · public open-standard) · RFC 7230
 * §3.2.6 token grammar (June 2014 · IETF · Roy Fielding + Julian Reschke)
 * · 无外部 lib 借鉴 (pure express + pkg.json read · §4.7 + §4.8
 * writeHead-monkeypatch pattern mirror per msg=ad6585cf 借鉴 独立性
 * 铁律 · structural template ≠ code-copy).
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

export interface TraceContextConfig {
  echo_traceparent?: boolean;
  echo_tracestate?: boolean;
}

const PKG_TRACE_CONTEXT_CONFIG: TraceContextConfig | null =
  (pkg as { api_trace_context?: TraceContextConfig }).api_trace_context ?? null;

// W3C Trace Context §3.2 traceparent v0 shape (accept version=="00" only per
// §3.2.2.1 "if the version cannot be parsed, the vendor creates a new
// traceparent header" — echo-only v0 declines to synthesize, drops silently).
// version-trace_id-parent_id-flags = 2 + 1 + 32 + 1 + 16 + 1 + 2 = 55 chars
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = '00000000000000000000000000000000';
const ZERO_PARENT_ID = '0000000000000000';

export function isValidTraceparent(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = TRACEPARENT_RE.exec(s);
  if (!m) return false;
  const [, version, traceId, parentId] = m;
  // v0 accepts only version="00" (W3C §3.2.2.1 forward-compat handled by
  // dropping unknown versions in echo-only mode).
  if (version !== '00') return false;
  // W3C §3.2.2.3 · trace-id and parent-id MUST NOT be all zeros.
  if (traceId === ZERO_TRACE_ID) return false;
  if (parentId === ZERO_PARENT_ID) return false;
  return true;
}

// W3C §3.3 tracestate list-member key/value grammar is complex; v0 accepts
// any non-empty printable-ASCII string of length ≤ 512 (§3.3.1.3 upper
// bound "combined header length SHOULD NOT exceed 512 characters"). This is
// echo-only pass-through; a full parser is deferred to §4.9.1.
const TRACESTATE_MAX_LEN = 512;
const TRACESTATE_PRINTABLE_RE = /^[\x20-\x7e]+$/;

export function isValidTracestate(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length <= TRACESTATE_MAX_LEN &&
    TRACESTATE_PRINTABLE_RE.test(s)
  );
}

export function buildApiTraceContextMiddleware(config: TraceContextConfig | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config) {
      return next();
    }
    const echoTraceparent = config.echo_traceparent === true;
    const echoTracestate = config.echo_tracestate === true;
    if (!echoTraceparent && !echoTracestate) {
      return next();
    }

    const origWriteHead = res.writeHead.bind(res);
    (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead =
      function patchedWriteHead(this: Response, ...args: unknown[]): Response {
        if (echoTraceparent && !res.getHeader('traceparent')) {
          const incoming = req.get('traceparent');
          if (isValidTraceparent(incoming)) {
            res.setHeader('traceparent', incoming);
          }
        }
        if (echoTracestate && !res.getHeader('tracestate')) {
          const incoming = req.get('tracestate');
          if (isValidTracestate(incoming)) {
            res.setHeader('tracestate', incoming);
          }
        }
        return (origWriteHead as (...a: unknown[]) => Response)(...args);
      };
    next();
  };
}

export const apiTraceContextMiddleware = () =>
  buildApiTraceContextMiddleware(PKG_TRACE_CONTEXT_CONFIG);

export const CURRENT_TRACE_CONTEXT_CONFIG = PKG_TRACE_CONTEXT_CONFIG;
