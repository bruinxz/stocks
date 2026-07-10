/**
 * apiServerTimingStreaming.ts — ADR-0010 §4.14 · §4.7.2 vertical-of-vertical
 * continuation of §4.7 static (Server-Timing header) + §4.7.1 dynamic
 * (measure/measureAsync/start handler-facing API) + ADR-0010 §4.7.2.1
 * SSE keep-alive heartbeat sub-vertical (SUB-tier L3.1 extension).
 *
 * Three-tier vertical stack + sub-tier §4.7 → §4.7.1 → §4.7.2 → §4.7.2.1:
 *   §4.7     — static Server-Timing header set at writeHead-flush (advisory).
 *   §4.7.1   — dynamic per-request accumulator merged at writeHead-flush.
 *   §4.7.2   — streaming per-metric frame-emit during an open SSE or
 *              WebSocket session AFTER headers have been flushed. Handler-
 *              facing surface `res.locals.serverTimingStream` exposes
 *              emit/emitAsync/start/close + readonly `kind` ('sse' |
 *              'websocket' | 'none') + readonly `count`.
 *   §4.7.2.1 — SSE keep-alive heartbeat comment-frame `: keep-alive\n\n`
 *              (HTML5 §9.2.6 client-ignored per spec) emitted on a fixed
 *              interval to defeat proxy idle-timeout (60s default) for
 *              long-lived SSE streams. Adds `sendHeartbeat(): void` +
 *              `startHeartbeat(): () => void` handler surface plus
 *              `readonly heartbeatCount: number`. WebSocket + none kinds
 *              are no-op (heartbeat is SSE-specific per HTML5 §9.2.6).
 *
 * SSE (HTML5 §9.2 Server-Sent Events canonical) frame format:
 *   event: server-timing\n
 *   data: {name;dur=X.YZ;desc="..."}\n
 *   \n
 *
 * WebSocket (RFC 6455 §5.6 text data-frame) JSON envelope:
 *   {"type":"server-timing","name":"...","dur":X.YZ,"desc":"..."}
 *
 * Reads optional `api_server_timing_streaming` block from
 * `backend/package.json`:
 *   {
 *     "api_server_timing_streaming": {
 *       "enabled": true,
 *       "sse_event_name": "server-timing",
 *       "ws_frame_type": "server-timing",
 *       "heartbeat_enabled": false,
 *       "heartbeat_interval_ms": 30000,
 *       "heartbeat_comment": "keep-alive"
 *     }
 *   }
 *
 * Default-OFF opt-in: when `enabled !== true`, the middleware still exposes a
 * no-op adapter on `res.locals.serverTimingStream` (kind='none') so handlers
 * may call it unconditionally without a null-guard. When enabled, the adapter
 * detects the stream kind at first-emit time:
 *   1. If `res.locals.serverTimingStreamWebSocket` (WebSocket instance) is
 *      already assigned by an upgrade handler, kind='websocket'.
 *   2. Else if response Content-Type starts with `text/event-stream`,
 *      kind='sse'.
 *   3. Else kind='none' (fail-OPEN silent — advisory-only, never overwrite
 *      route authority).
 *
 * Route authority wins: this adapter never mutates response body payload or
 * headers set by the route handler. It only writes frames to an already-open
 * SSE stream (via res.write) or WebSocket socket (via socket.send). Handlers
 * remain responsible for stream lifecycle (open, close, back-pressure).
 *
 * Attribution: W3C Server-Timing Level 1 (Candidate Recommendation 25-May-2022 ·
 * Ilya Grigorik / Nic Jansma editors · public open-standard) · WHATWG HTML5
 * §9.2 Server-Sent Events (living standard · Ian Hickson editor · public
 * open-standard) · RFC 6455 The WebSocket Protocol (December 2011 · IETF ·
 * Ian Fette + Alexey Melnikov) · RFC 7230 §3.2.6 token grammar (June 2014 ·
 * IETF · Roy Fielding + Julian Reschke) · 无外部 lib 借鉴 (pure express + `ws`
 * built-in + pkg.json read + process.hrtime.bigint() Node built-in · §4.6
 * writeHead-pattern mirror · §4.7 static-metric pattern-extend · §4.7.1
 * accumulator pattern-extend · §4.7.2 stream-emit vertical-of-vertical per
 * msg=ad6585cf 借鉴 独立性 铁律 · structural template ≠ code-copy · zero
 * external npm dependency beyond already-listed `ws`).
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

export interface ServerTimingStreamingConfig {
  enabled?: boolean;
  sse_event_name?: string;
  ws_frame_type?: string;
  heartbeat_enabled?: boolean;
  heartbeat_interval_ms?: number;
  heartbeat_comment?: string;
}

export type ServerTimingStreamKind = 'sse' | 'websocket' | 'none';

/**
 * Minimal WebSocket-like interface (RFC 6455). Compatible with the `ws`
 * package's WebSocket class + browser-native WebSocket + any transport that
 * exposes a `send(data: string)` sink. Intentionally structural to avoid
 * a hard `ws` type dependency for consumers that mount their own upgrade.
 */
export interface ServerTimingStreamSocket {
  readyState?: number;
  send(data: string): void;
}

/**
 * Handler-facing streaming-emit adapter exposed via
 * `res.locals.serverTimingStream`. All four entry points fail-OPEN on invalid
 * input (never throw · never overwrite route-set headers or body).
 */
export interface ServerTimingStreamAdapter {
  /** Emit a single metric frame. Invalid name silently drops the emit. */
  emit(name: string, dur?: number, desc?: string): void;
  /**
   * Instrument an awaited promise. Emits elapsed wall-clock in ms upon
   * resolution or rejection (before rethrowing). Uses process.hrtime.bigint
   * for ns-precision monotonic clock.
   */
  emitAsync<T>(name: string, promise: Promise<T>, desc?: string): Promise<T>;
  /**
   * Open a scope-scoped measurement. Returns a stop-fn that emits elapsed
   * wall-clock in ms when invoked. Subsequent invocations of the stop-fn
   * no-op (idempotent).
   */
  start(name: string, desc?: string): () => void;
  /** Idempotent flush + release. Handlers should still close their own
   *  stream lifecycle; this only releases adapter-internal state. */
  close(): void;
  /**
   * §4.7.2.1 · Send a single SSE keep-alive heartbeat comment-frame
   * `: <comment>\n\n` (HTML5 §9.2.6 client-ignored per spec). No-op when
   * kind !== 'sse', response already ended, or heartbeat disabled. Never
   * throws. Handler-facing surface for one-shot heartbeat emission.
   */
  sendHeartbeat(): void;
  /**
   * §4.7.2.1 · Start a repeating SSE heartbeat on the configured interval
   * (default 30000ms). Returns a stop-fn that clears the interval and is
   * idempotent (subsequent calls no-op). No-op when kind !== 'sse',
   * response already ended, or heartbeat disabled. The interval is
   * automatically cleared on adapter.close() and on `res.on('close')`
   * (native Node stream lifecycle). Multiple concurrent starts share the
   * single adapter-owned interval (last stop-fn wins the clear).
   */
  startHeartbeat(): () => void;
  /** Detected stream kind at the time of the first emit (lazy). */
  readonly kind: ServerTimingStreamKind;
  /** Number of frames successfully emitted (test/introspection). */
  readonly count: number;
  /** Number of §4.7.2.1 heartbeat comment-frames successfully emitted. */
  readonly heartbeatCount: number;
}

const PKG_STREAMING_CONFIG: ServerTimingStreamingConfig | null =
  (pkg as { api_server_timing_streaming?: ServerTimingStreamingConfig })
    .api_server_timing_streaming ?? null;

// RFC 7230 §3.2.6 token grammar (mirrored from §4.7 apiServerTiming).
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isValidMetricName(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && TOKEN_RE.test(s);
}

function isValidDur(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function elapsedMs(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

// RFC 6455 §4.1 OPEN readyState = 1. Guard optional; when readyState is
// undefined (custom sink) we allow the send.
const WS_READY_OPEN = 1;

function serializeSseFrame(
  eventName: string,
  name: string,
  dur: number | undefined,
  desc: string | undefined,
): string {
  const parts: string[] = [name];
  if (typeof desc === 'string' && desc.length > 0) {
    const escaped = desc.replace(/[\\"]/g, '\\$&');
    parts.push(`desc="${escaped}"`);
  }
  if (dur !== undefined && isValidDur(dur)) {
    parts.push(`dur=${dur}`);
  }
  return `event: ${eventName}\ndata: ${parts.join(';')}\n\n`;
}

function serializeWsFrame(
  frameType: string,
  name: string,
  dur: number | undefined,
  desc: string | undefined,
): string {
  const payload: Record<string, unknown> = { type: frameType, name };
  if (dur !== undefined && isValidDur(dur)) payload.dur = dur;
  if (typeof desc === 'string' && desc.length > 0) payload.desc = desc;
  return JSON.stringify(payload);
}

// §4.7.2.1 · SSE keep-alive heartbeat comment-frame (HTML5 §9.2.6).
// Format: `: <comment>\n\n` — colon-prefixed line = comment per spec;
// clients (EventSource) silently discard. Empty/multiline comments
// sanitized to a single-line safe payload; ':' + '\n' + '\r' stripped.
const DEFAULT_HEARTBEAT_COMMENT = 'keep-alive';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;

function sanitizeHeartbeatComment(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_HEARTBEAT_COMMENT;
  const stripped = raw.replace(/[\r\n]/g, '').trim();
  return stripped.length > 0 ? stripped : DEFAULT_HEARTBEAT_COMMENT;
}

function serializeSseHeartbeat(comment: string): string {
  return `: ${comment}\n\n`;
}

function isValidHeartbeatInterval(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function detectKind(res: Response): ServerTimingStreamKind {
  const locals = res.locals as Record<string, unknown>;
  const ws = locals.serverTimingStreamWebSocket as
    | ServerTimingStreamSocket
    | undefined;
  if (ws && typeof ws.send === 'function') return 'websocket';
  const ct = res.getHeader('Content-Type');
  const ctStr = Array.isArray(ct) ? ct[0] : ct;
  if (typeof ctStr === 'string' && ctStr.toLowerCase().startsWith('text/event-stream')) {
    return 'sse';
  }
  return 'none';
}

function buildAdapter(
  res: Response,
  config: ServerTimingStreamingConfig,
): ServerTimingStreamAdapter {
  const sseEventName =
    typeof config.sse_event_name === 'string' && TOKEN_RE.test(config.sse_event_name)
      ? config.sse_event_name
      : 'server-timing';
  const wsFrameType =
    typeof config.ws_frame_type === 'string' && TOKEN_RE.test(config.ws_frame_type)
      ? config.ws_frame_type
      : 'server-timing';
  // §4.7.2.1 · Heartbeat config (default-OFF opt-in; SSE-only)
  const heartbeatEnabled = config.heartbeat_enabled === true;
  const heartbeatIntervalMs = isValidHeartbeatInterval(config.heartbeat_interval_ms)
    ? config.heartbeat_interval_ms
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatComment = sanitizeHeartbeatComment(config.heartbeat_comment);

  let cachedKind: ServerTimingStreamKind | null = null;
  let count = 0;
  let heartbeatCount = 0;
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function resolveKind(): ServerTimingStreamKind {
    if (cachedKind === null) cachedKind = detectKind(res);
    return cachedKind;
  }

  function clearHeartbeatTimer(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // §4.7.2.1 · Auto-cleanup on native res 'close' event (Node stream lifecycle).
  // Idempotent: adapter.close() may also fire this path.
  res.on('close', () => {
    closed = true;
    clearHeartbeatTimer();
  });

  function doHeartbeat(): void {
    if (closed) return;
    if (!heartbeatEnabled) return;
    const kind = resolveKind();
    if (kind !== 'sse') return;
    if (res.writableEnded) return;
    try {
      res.write(serializeSseHeartbeat(heartbeatComment));
      heartbeatCount++;
    } catch {
      // Fail-OPEN silent — advisory-only.
    }
  }

  function doEmit(name: string, dur: number | undefined, desc: string | undefined): void {
    if (closed) return;
    if (!isValidMetricName(name)) return;
    const kind = resolveKind();
    if (kind === 'none') return;
    try {
      if (kind === 'sse') {
        const frame = serializeSseFrame(sseEventName, name, dur, desc);
        // Only write if the underlying socket is still writable.
        if (!res.writableEnded) {
          res.write(frame);
          count++;
        }
      } else if (kind === 'websocket') {
        const locals = res.locals as Record<string, unknown>;
        const ws = locals.serverTimingStreamWebSocket as
          | ServerTimingStreamSocket
          | undefined;
        if (!ws || typeof ws.send !== 'function') return;
        if (typeof ws.readyState === 'number' && ws.readyState !== WS_READY_OPEN) return;
        ws.send(serializeWsFrame(wsFrameType, name, dur, desc));
        count++;
      }
    } catch {
      // Fail-OPEN silent — advisory-only, never propagate transport errors
      // into route control flow.
    }
  }

  const adapter: ServerTimingStreamAdapter = {
    emit(name: string, dur?: number, desc?: string) {
      doEmit(name, dur, desc);
    },
    async emitAsync<T>(name: string, promise: Promise<T>, desc?: string): Promise<T> {
      const valid = isValidMetricName(name);
      const t0 = process.hrtime.bigint();
      try {
        const result = await promise;
        if (valid) doEmit(name, elapsedMs(t0), desc);
        return result;
      } catch (err) {
        if (valid) doEmit(name, elapsedMs(t0), desc);
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
        doEmit(name, elapsedMs(t0), desc);
      };
    },
    close() {
      closed = true;
      clearHeartbeatTimer();
    },
    sendHeartbeat() {
      doHeartbeat();
    },
    startHeartbeat() {
      let stopped = false;
      if (closed || !heartbeatEnabled) {
        return () => {
          stopped = true;
        };
      }
      // Idempotent: reuse an already-running adapter-owned interval.
      if (heartbeatTimer === null) {
        heartbeatTimer = setInterval(() => {
          doHeartbeat();
        }, heartbeatIntervalMs);
        // Node timers hold the event loop open; do not block process exit.
        if (typeof (heartbeatTimer as { unref?: () => void }).unref === 'function') {
          (heartbeatTimer as { unref: () => void }).unref();
        }
      }
      return () => {
        if (stopped) return;
        stopped = true;
        clearHeartbeatTimer();
      };
    },
    get kind() {
      return resolveKind();
    },
    get count() {
      return count;
    },
    get heartbeatCount() {
      return heartbeatCount;
    },
  };
  return adapter;
}

// No-op adapter for the default-OFF path. Fully typed so handlers can call
// unconditionally without a null-guard.
function buildNoopAdapter(): ServerTimingStreamAdapter {
  return {
    emit(_name: string, _dur?: number, _desc?: string) {
      /* no-op */
    },
    async emitAsync<T>(_name: string, promise: Promise<T>, _desc?: string): Promise<T> {
      return promise;
    },
    start(_name: string, _desc?: string) {
      return () => {
        /* no-op */
      };
    },
    close() {
      /* no-op */
    },
    sendHeartbeat() {
      /* no-op */
    },
    startHeartbeat() {
      return () => {
        /* no-op */
      };
    },
    kind: 'none',
    count: 0,
    heartbeatCount: 0,
  };
}

export function buildApiServerTimingStreamingMiddleware(
  config: ServerTimingStreamingConfig | null,
) {
  const enabled = config?.enabled === true;
  return (_req: Request, res: Response, next: NextFunction) => {
    const adapter = enabled ? buildAdapter(res, config as ServerTimingStreamingConfig) : buildNoopAdapter();
    (res.locals as Record<string, unknown>).serverTimingStream = adapter;
    next();
  };
}

export const apiServerTimingStreamingMiddleware = () =>
  buildApiServerTimingStreamingMiddleware(PKG_STREAMING_CONFIG);

export const CURRENT_STREAMING_CONFIG = PKG_STREAMING_CONFIG;

// Test-facing helpers (exported for the sibling test file only; runtime code
// should use the middleware factories above).
export const __test__ = {
  isValidMetricName,
  isValidDur,
  serializeSseFrame,
  serializeWsFrame,
  serializeSseHeartbeat,
  sanitizeHeartbeatComment,
  isValidHeartbeatInterval,
  detectKind,
  buildNoopAdapter,
  buildAdapter,
};
