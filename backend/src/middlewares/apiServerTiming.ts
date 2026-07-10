/**
 * apiServerTiming.ts — ADR-0010 §4.7 · W3C Server-Timing Level 1 (Candidate
 * Recommendation 25-May-2022) advisory-observability header.
 *
 * §4.13 extension (ADR-0010 §4.7.1 · W3C Server-Timing L1 §2 dynamic
 * per-request metrics · handler-facing API surface): exposes a
 * `res.locals.serverTiming` accumulator with three canonical entry points —
 * `measure(name, dur, desc?)` for direct metric recording, `measureAsync(name,
 * promise, desc?)` for wall-clock instrumentation of an awaited promise, and
 * `start(name, desc?)` returning a stop-fn for scope-scoped measurement.
 * Dynamic metrics accumulate per-request and merge with static-metrics /
 * measure_total at the same writeHead-flush time — preserving the §4.7
 * canonical pattern discipline bit-perfect. All three entry points fail-OPEN
 * silently on invalid token / dur / desc (never throw, never overwrite route
 * authority).
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
 * 无 config → dynamic accumulator STILL exposed on `res.locals.serverTiming`
 * so handlers may call it unconditionally; header only emits when either
 * dynamic metrics were recorded, static metrics configured, or measure_total
 * enabled. Existing Server-Timing set by the route handler is NEVER
 * overwritten (route authority wins). Advisory-only (§4.7 does NOT enforce
 * any performance budget · pure request-response observability annotation).
 *
 * Header shape (Server-Timing L1 §2.2 canonical · §4.7 / §4.7.1 scope):
 *   HTTP/1.1 200 OK
 *   Server-Timing: app;desc="raft-backend", db;dur=12.5, cache;dur=3.1, total;dur=47.2
 *
 * Implementation: patches res.writeHead in-place (§4.6 pattern mirror ·
 * timing measurement is only meaningful at header-flush time; res.on('finish')
 * fires post-flush, too late to mutate headers). Uses process.hrtime.bigint()
 * ns-precision monotonic clock (immune to system-clock adjustments). Fail-OPEN
 * skip on invalid metric-name / invalid dur.
 *
 * Orch v235 §五 A-3 dispatch matrix: §4.7 Server-Timing autonomous CREATE-AUTHORIZE NOW.
 * Orch v263 §四 CREATE-AUTHORIZE msg=423d2179: §4.13 Option F ADOPTED — extend
 * §4.7 with dynamic measure/measureAsync/start handler-facing API surface.
 *
 * Attribution: W3C Server-Timing Level 1 (Candidate Recommendation 25-May-2022 ·
 * Ilya Grigorik / Nic Jansma editors · public open-standard) · RFC 7230 §3.2.6
 * token grammar (June 2014 · IETF · Roy Fielding + Julian Reschke) · 无外部
 * lib 借鉴 (pure express + pkg.json read + process.hrtime.bigint() Node
 * built-in · §4.6 writeHead-monkeypatch pattern mirror · §4.7 static-metric
 * pattern-extend for dynamic API surface per msg=ad6585cf 借鉴 独立性 铁律 ·
 * structural template ≠ code-copy · zero external npm dependency).
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

/**
 * Dynamic per-request accumulator exposed to route handlers via
 * `res.locals.serverTiming`. Three canonical entry points; all fail-OPEN on
 * invalid input (never throw · never overwrite route-set Server-Timing).
 */
export interface ServerTimingAccumulator {
  /** Record a metric directly. Invalid name silently drops the record. */
  measure(name: string, dur?: number, desc?: string): void;
  /**
   * Instrument an awaited promise. Records elapsed wall-clock in ms upon
   * resolution or rejection (before rethrowing). Uses process.hrtime.bigint
   * for ns-precision monotonic clock.
   */
  measureAsync<T>(name: string, promise: Promise<T>, desc?: string): Promise<T>;
  /**
   * Open a scope-scoped measurement. Returns a stop-fn that records elapsed
   * wall-clock in ms when invoked. Subsequent invocations of the stop-fn
   * no-op (idempotent).
   */
  start(name: string, desc?: string): () => void;
  /** Number of currently-recorded dynamic metrics (test/introspection). */
  readonly size: number;
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

function elapsedMs(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

function buildAccumulator(dynamicMetrics: ServerTimingMetric[]): ServerTimingAccumulator {
  const acc: ServerTimingAccumulator = {
    measure(name: string, dur?: number, desc?: string) {
      if (!isValidMetricName(name)) return;
      const metric: ServerTimingMetric = { name };
      if (typeof desc === 'string' && desc.length > 0) metric.desc = desc;
      if (dur !== undefined && isValidDur(dur)) metric.dur = dur;
      dynamicMetrics.push(metric);
    },
    async measureAsync<T>(name: string, promise: Promise<T>, desc?: string): Promise<T> {
      // Validate name up-front; if invalid, still await the promise (do not
      // consume caller's control flow) and skip the record on both paths.
      const valid = isValidMetricName(name);
      const t0 = process.hrtime.bigint();
      try {
        const result = await promise;
        if (valid) acc.measure(name, elapsedMs(t0), desc);
        return result;
      } catch (err) {
        if (valid) acc.measure(name, elapsedMs(t0), desc);
        throw err;
      }
    },
    start(name: string, desc?: string) {
      const valid = isValidMetricName(name);
      const t0 = process.hrtime.bigint();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        if (!valid) return;
        acc.measure(name, elapsedMs(t0), desc);
      };
    },
    get size() {
      return dynamicMetrics.length;
    },
  };
  return acc;
}

export function buildApiServerTimingMiddleware(config: ServerTimingConfig | null) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const staticMetrics =
      config && Array.isArray(config.static_metrics) ? config.static_metrics : [];
    const measureTotal = config?.measure_total === true;
    const dynamicMetrics: ServerTimingMetric[] = [];
    const accumulator = buildAccumulator(dynamicMetrics);

    // §4.13 canonical: accumulator ALWAYS exposed so handlers can call
    // res.locals.serverTiming.measure(...) unconditionally without a
    // null-guard, whether config is present or not.
    (res.locals as Record<string, unknown>).serverTiming = accumulator;

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
          for (const m of dynamicMetrics) {
            const serialized = serializeMetric(m);
            if (serialized !== null) {
              parts.push(serialized);
            }
          }
          if (measureTotal) {
            const total = elapsedMs(startNs);
            if (isValidDur(total)) {
              parts.push(`total;dur=${total.toFixed(3)}`);
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
