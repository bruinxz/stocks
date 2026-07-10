/**
 * apiServerTimingStreaming.ts — ADR-0010 §4.14 · §4.7.2 vertical-of-vertical
 * continuation of §4.7 static (Server-Timing header) + §4.7.1 dynamic
 * (measure/measureAsync/start handler-facing API) + ADR-0010 §4.7.2.1
 * SSE keep-alive heartbeat sub-vertical (SUB-tier L3.1 extension) +
 * ADR-0010 §4.7.2.2 SSE Last-Event-ID resumption sub-vertical (SUB-tier
 * L3.2 extension) + ADR-0010 §4.7.2.3 SSE `retry:` field reconnect-time
 * hint sub-vertical (SUB-tier L3.3 extension).
 *
 * Six-tier vertical stack + sub-tier §4.7 → §4.7.1 → §4.7.2 → §4.7.2.1
 * → §4.7.2.2 → §4.7.2.3:
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
 *   §4.7.2.2 — SSE Last-Event-ID resumption (HTML5 §9.2.5 per spec:
 *              browser EventSource auto-transmits `Last-Event-ID` header
 *              on reconnect after disconnect; SSE `id:` field on each
 *              frame updates the client's lastEventId cursor). Adds
 *              optional `id?: string` param to `emit(name, dur?, desc?,
 *              id?)`, `getLastEventIdFromHeader(req): string | null`
 *              static helper for handler-side extraction, `resumeFrom(id,
 *              replay): void` advisory-only hook that replays cached
 *              frames strictly-after the given id, `readonly lastEventId:
 *              string | null` (last emitted id), and a bounded LIFO
 *              ring-buffer (default 100 frames). WebSocket + none kinds
 *              are no-op (Last-Event-ID is EventSource-native per HTML5
 *              §9.2.5). All operations fail-OPEN.
 *   §4.7.2.3 — SSE `retry:` field reconnect-time hint (HTML5 §9.2.5 per
 *              spec: `retry: <ms>\n\n` frame sets the EventSource client's
 *              reconnection timer to `<ms>` before the next auto-reconnect
 *              attempt after disconnect; positive-integer only per spec).
 *              Adds `setReconnectMs(ms: number): void` (validated positive
 *              integer within `[1, retry_max_ms]` bounds) which serializes
 *              a `retry: <ms>\n\n` frame + updates internal cursor, and
 *              `readonly reconnectMs: number | null` (current setting, or
 *              null before first successful set). WebSocket + none kinds
 *              are no-op (retry: is EventSource-native per HTML5 §9.2.5).
 *              All operations fail-OPEN.
 *   §4.7.2.4 — SSE `onerror` semantics / error-frame (HTML5 §9.2.5 per
 *              spec: EventSource `onerror` event fires when the connection
 *              transitions to CLOSED or when a network-level fault occurs;
 *              servers may emit a comment-frame `: error <reason>\n\n`
 *              before ending the stream to hint the client's onerror
 *              handler about the termination cause). Adds
 *              `emitStreamError(reason: string, retriable?: boolean): void`
 *              which validates `reason` as an RFC 7230 §3.2.6 token,
 *              optionally emits a preceding `retry: <default_ms>\n\n`
 *              control-frame when `retriable === true` (to hint the
 *              client's reconnect timer), then emits the error comment-
 *              frame + updates the internal cursor, and
 *              `readonly errorReason: string | null` (last emitted reason,
 *              or null before first successful emit). WebSocket + none
 *              kinds are no-op (comment-frame is EventSource-native per
 *              HTML5 §9.2.5-6). All operations fail-OPEN.
 *   §4.7.2.5 — SSE reconnection-jitter L3.5 SUB-tier (HTML5 §9.2.5 per
 *              spec: the EventSource client's reconnection timer is
 *              seeded by the last `retry:` field value; implementations
 *              are encouraged to add jitter to the timer to defend
 *              against thundering-herd reconnects when many clients
 *              simultaneously disconnect from the same origin). This
 *              tier moves the jitter production server-side so the emit
 *              is deterministic and reproducible per-request (rather
 *              than relying on browser-implementation-specific jitter).
 *              Adds `emitStreamRetryHint(baseMs: number, jitterMs?:
 *              number): void` which serializes a `retry: <base ± jitter>
 *              \n\n` control-frame with a deterministic, hash-derived
 *              jitter offset in `[-cap, +cap]` and updates the internal
 *              cursor, and `readonly retryJitterMs: number | null`
 *              (last emitted jitter offset in ms, or null before first
 *              successful emit). The jitter derivation uses
 *              `crypto.createHash('sha256')` seeded by
 *              `Date.now() + baseMs + monotonic-counter` — Math.random
 *              is banned per US-038. Composes with §4.7.2.3 (upstream
 *              `retry:` primary) and §4.7.2.4 (retriable-combo) so the
 *              retriable-error frame may pull the jittered value when
 *              `retry_jitter_enabled === true`. WebSocket + none kinds
 *              are no-op (retry: is EventSource-native per HTML5
 *              §9.2.5). All operations fail-OPEN.
 *
 * SSE (HTML5 §9.2 Server-Sent Events canonical) frame format:
 *   id: <id>\n         (optional; when present, updates client cursor)
 *   retry: <ms>\n\n    (§4.7.2.3 standalone control-frame; sets reconnect timer)
 *   retry: <ms>\n\n    (§4.7.2.5 jittered control-frame; base ± hash-derived offset)
 *   : error <reason>\n\n  (§4.7.2.4 standalone comment-frame; hints onerror)
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
 *       "heartbeat_comment": "keep-alive",
 *       "resume_enabled": false,
 *       "resume_history_size": 100,
 *       "resume_header_name": "Last-Event-ID",
 *       "retry_enabled": false,
 *       "retry_default_ms": 3000,
 *       "retry_max_ms": 300000,
 *       "error_frame_enabled": false,
 *       "error_frame_default_reason": "stream_terminated",
 *       "retry_jitter_enabled": false,
 *       "retry_jitter_max_ms": 500
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
import { createHash } from 'crypto';
import pkg from '../../package.json';

export interface ServerTimingStreamingConfig {
  enabled?: boolean;
  sse_event_name?: string;
  ws_frame_type?: string;
  heartbeat_enabled?: boolean;
  heartbeat_interval_ms?: number;
  heartbeat_comment?: string;
  resume_enabled?: boolean;
  resume_history_size?: number;
  resume_header_name?: string;
  retry_enabled?: boolean;
  retry_default_ms?: number;
  retry_max_ms?: number;
  error_frame_enabled?: boolean;
  error_frame_default_reason?: string;
  retry_jitter_enabled?: boolean;
  retry_jitter_max_ms?: number;
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
  /**
   * Emit a single metric frame. Invalid name silently drops the emit.
   * §4.7.2.2 · Optional `id` (RFC 7230 §3.2.6 token) attaches an SSE
   * `id:` line to the frame so client cursor advances, and the frame is
   * appended to the resume ring-buffer when resume is enabled. Non-token
   * id silently drops the id (still emits the frame without id).
   */
  emit(name: string, dur?: number, desc?: string, id?: string): void;
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
  /**
   * §4.7.2.2 · Last SSE `id:` value successfully attached to an emitted
   * frame (advisory; `null` before the first id-carrying emit).
   */
  readonly lastEventId: string | null;
  /**
   * §4.7.2.3 · Last SSE `retry:` reconnect-time hint successfully emitted
   * in ms (advisory; `null` before the first successful setReconnectMs).
   */
  readonly reconnectMs: number | null;
  /**
   * §4.7.2.4 · Last SSE error-frame reason successfully emitted
   * (advisory; `null` before the first successful emitStreamError).
   */
  readonly errorReason: string | null;
  /**
   * §4.7.2.5 · Last SSE reconnection-jitter offset (in ms) applied by a
   * successful `emitStreamRetryHint` call. Positive or negative integer
   * within `[-retry_jitter_max_ms, +retry_jitter_max_ms]`. `null` before
   * the first successful emit or when the jitter branch was inactive
   * (e.g. `jitterMs === 0`).
   */
  readonly retryJitterMs: number | null;
  /**
   * §4.7.2.2 · Replay cached frames strictly-after the given event id
   * (SSE `Last-Event-ID` reconnect cursor per HTML5 §9.2.5). Iterates
   * the bounded ring-buffer LIFO-ordered from oldest→newest and invokes
   * `replay(entry)` for each entry whose id lexically-compares strictly
   * greater than `sinceId` (or every cached entry when `sinceId` is
   * empty/null/undefined/missing-from-cache). No-op when kind !== 'sse',
   * response already ended, resume disabled, or replay throws (per-entry
   * fail-OPEN silent). Handler-facing surface: the callback may re-emit
   * the entry via adapter.emit() or a custom re-serializer. Never throws.
   */
  resumeFrom(
    sinceId: string | null | undefined,
    replay: (entry: ServerTimingResumeEntry) => void
  ): void;
  /**
   * §4.7.2.3 · Set the SSE `retry:` field reconnect-time hint per HTML5
   * §9.2.5. Emits a standalone `retry: <ms>\n\n` control-frame and updates
   * the internal `reconnectMs` cursor. Validates `ms` as a positive
   * integer within `[1, retry_max_ms]` bounds (default cap 300000ms = 5m).
   * No-op when kind !== 'sse', response already ended, retry disabled, or
   * ms fails validation. Never throws. Handler-facing surface for
   * server-hinted client reconnection-timer control.
   */
  setReconnectMs(ms: number): void;
  /**
   * §4.7.2.4 · Emit an SSE error-frame hint per HTML5 §9.2.5-6. Serializes
   * `: error <reason>\n\n` as a comment-frame (client-ignored per HTML5
   * §9.2.6, but the reason line remains visible to logs/proxies + a
   * subsequent connection-terminate triggers the client's onerror handler
   * per HTML5 §9.2.5 CLOSED transition). Validates `reason` as an RFC
   * 7230 §3.2.6 token (defensive against header-injection-shaped input).
   * When `retriable === true`, emits a preceding `retry: <default_ms>\n\n`
   * control-frame first (per §4.7.2.3 retry-hint semantics) so the client
   * knows to reconnect after its onerror handler fires. Updates the
   * internal `errorReason` cursor on success. No-op when kind !== 'sse',
   * response already ended, error-frame disabled, or reason fails
   * validation. Never throws. Handler-facing surface for
   * server-hinted stream-terminate reason exposure.
   */
  emitStreamError(reason: string, retriable?: boolean): void;
  /**
   * §4.7.2.5 · Emit an SSE `retry: <base ± jitter>\n\n` control-frame
   * with a deterministic, hash-derived jitter offset. `baseMs` is
   * validated as a positive integer within `[1, retry_max_ms]` (same
   * bounds as §4.7.2.3 `setReconnectMs`). `jitterMs` (optional) is
   * clamped to `[0, retry_jitter_max_ms]`; when omitted, the
   * configured `retry_jitter_max_ms` cap is used. When `jitterMs > 0`,
   * a deterministic offset in `[-jitterMs, +jitterMs]` is derived via
   * `crypto.createHash('sha256')` seeded by
   * `Date.now() + baseMs + monotonic-counter` (Math.random is banned
   * per US-038) and applied to `baseMs`. The final emitted value is
   * additionally clamped to `[1, retry_max_ms]` so downstream
   * §4.7.2.3 bounds are preserved. Updates the internal
   * `reconnectMs` cursor to the emitted value and `retryJitterMs`
   * cursor to the applied offset. No-op when kind !== 'sse', response
   * already ended, jitter disabled, or bounds fail validation. Never
   * throws. Handler-facing surface for thundering-herd-defense
   * reconnection scheduling.
   */
  emitStreamRetryHint(baseMs: number, jitterMs?: number): void;
}

/**
 * §4.7.2.2 · Single ring-buffer entry surfaced to the resumeFrom(replay)
 * callback. All fields intentionally read-only from the caller's view.
 */
export interface ServerTimingResumeEntry {
  readonly id: string;
  readonly name: string;
  readonly dur: number | undefined;
  readonly desc: string | undefined;
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
  id?: string
): string {
  const parts: string[] = [name];
  if (typeof desc === 'string' && desc.length > 0) {
    const escaped = desc.replace(/[\\"]/g, '\\$&');
    parts.push(`desc="${escaped}"`);
  }
  if (dur !== undefined && isValidDur(dur)) {
    parts.push(`dur=${dur}`);
  }
  const idLine = typeof id === 'string' && id.length > 0 && TOKEN_RE.test(id) ? `id: ${id}\n` : '';
  return `${idLine}event: ${eventName}\ndata: ${parts.join(';')}\n\n`;
}

function serializeWsFrame(
  frameType: string,
  name: string,
  dur: number | undefined,
  desc: string | undefined
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

// §4.7.2.2 · Last-Event-ID resumption (HTML5 §9.2.5).
// Ring-buffer bounded by `resume_history_size` (default 100, LIFO cap).
// Header name defaults to canonical `Last-Event-ID` per HTML5 spec but is
// configurable (some reverse-proxies rename headers). Header value must
// itself satisfy the RFC 7230 §3.2.6 token grammar to prevent header-
// injection attempts from smuggling through the resume path.
const DEFAULT_RESUME_HISTORY_SIZE = 100;
const DEFAULT_RESUME_HEADER_NAME = 'Last-Event-ID';

function isValidResumeHistorySize(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && Number.isInteger(n);
}

function sanitizeResumeHeaderName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_RESUME_HEADER_NAME;
  return TOKEN_RE.test(raw) ? raw : DEFAULT_RESUME_HEADER_NAME;
}

function getLastEventIdFromHeader(
  req: { headers?: Record<string, string | string[] | undefined> },
  headerName: string = DEFAULT_RESUME_HEADER_NAME
): string | null {
  if (!req || typeof req !== 'object' || !req.headers) return null;
  const lower = headerName.toLowerCase();
  const raw = req.headers[lower] ?? req.headers[headerName];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) return null;
  return TOKEN_RE.test(value) ? value : null;
}

// §4.7.2.3 · SSE `retry:` field reconnect-time hint (HTML5 §9.2.5).
// Per spec, the `retry:` field value MUST be a positive integer (ms) — the
// EventSource client parses and applies it as its next reconnection delay.
// We bound by `retry_max_ms` (default 300000 = 5m) to prevent handlers from
// hinting pathologically-long reconnection intervals that would strand
// clients (defense-in-depth; the spec has no upper bound itself).
const DEFAULT_RETRY_DEFAULT_MS = 3000;
const DEFAULT_RETRY_MAX_MS = 300000;

function isValidRetryMs(n: unknown, cap: number): n is number {
  return (
    typeof n === 'number' &&
    Number.isFinite(n) &&
    Number.isInteger(n) &&
    n >= 1 &&
    n <= cap
  );
}

function isValidRetryCap(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 1;
}

function serializeSseRetryFrame(ms: number): string {
  return `retry: ${ms}\n\n`;
}

// §4.7.2.4 · SSE error-frame hint (HTML5 §9.2.5-6).
// Comment-frame format `: error <reason>\n\n` — colon-prefixed line = comment
// per §9.2.6 (client-ignored) but the payload remains inspectable to logs,
// proxies, and browser DevTools. The connection-terminate itself is what
// triggers the client's onerror handler per §9.2.5 CLOSED transition; this
// hint is advisory-only metadata for the terminate. Validates reason as
// RFC 7230 §3.2.6 token to prevent CRLF-injection through the reason value.
const DEFAULT_ERROR_FRAME_REASON = 'stream_terminated';

function isValidErrorReason(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && TOKEN_RE.test(s);
}

function sanitizeErrorFrameDefaultReason(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_ERROR_FRAME_REASON;
  return TOKEN_RE.test(raw) ? raw : DEFAULT_ERROR_FRAME_REASON;
}

function serializeSseErrorFrame(reason: string): string {
  return `: error ${reason}\n\n`;
}

// §4.7.2.5 · SSE reconnection-jitter L3.5 SUB-tier (HTML5 §9.2.5).
// Deterministic hash-derived jitter offset in `[-cap, +cap]` seeded by
// `Date.now() + baseMs + monotonic-counter`. Math.random is banned per
// US-038 constraint; SHA-256 first-byte modulo yields a bounded value that
// is reproducible per-request-per-tick and diversifies across many
// concurrent handler invocations via the monotonic counter. The counter is
// module-scoped so consecutive emissions within the same tick derive
// distinct offsets. Sign parity (+/-) is derived from a separate byte to
// keep the offset centered around zero rather than skewed positive.
const DEFAULT_RETRY_JITTER_MAX_MS = 500;
let RETRY_JITTER_MONOTONIC_COUNTER = 0;

function isValidJitterCap(n: unknown): n is number {
  return (
    typeof n === 'number' &&
    Number.isFinite(n) &&
    Number.isInteger(n) &&
    n >= 0
  );
}

function isValidJitterMs(n: unknown, cap: number): n is number {
  return (
    typeof n === 'number' &&
    Number.isFinite(n) &&
    Number.isInteger(n) &&
    n >= 0 &&
    n <= cap
  );
}

function computeJitteredRetry(
  baseMs: number,
  jitterCapMs: number,
  seed: string
): { emittedMs: number; jitterOffset: number } {
  if (jitterCapMs <= 0) return { emittedMs: baseMs, jitterOffset: 0 };
  const digest = createHash('sha256').update(seed).digest();
  const magnitude = digest[0] % (jitterCapMs + 1);
  const sign = (digest[1] & 1) === 1 ? -1 : 1;
  const offset = sign * magnitude;
  return { emittedMs: baseMs + offset, jitterOffset: offset };
}

function detectKind(res: Response): ServerTimingStreamKind {
  const locals = res.locals as Record<string, unknown>;
  const ws = locals.serverTimingStreamWebSocket as ServerTimingStreamSocket | undefined;
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
  config: ServerTimingStreamingConfig
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
  // §4.7.2.2 · Resume config (default-OFF opt-in; SSE-only)
  const resumeEnabled = config.resume_enabled === true;
  const resumeHistorySize = isValidResumeHistorySize(config.resume_history_size)
    ? config.resume_history_size
    : DEFAULT_RESUME_HISTORY_SIZE;
  // §4.7.2.3 · Retry-hint config (default-OFF opt-in; SSE-only)
  const retryEnabled = config.retry_enabled === true;
  const retryMaxMs = isValidRetryCap(config.retry_max_ms)
    ? config.retry_max_ms
    : DEFAULT_RETRY_MAX_MS;
  const retryDefaultMs = isValidRetryMs(config.retry_default_ms, retryMaxMs)
    ? config.retry_default_ms
    : DEFAULT_RETRY_DEFAULT_MS;
  // §4.7.2.4 · Error-frame config (default-OFF opt-in; SSE-only)
  const errorFrameEnabled = config.error_frame_enabled === true;
  const errorFrameDefaultReason = sanitizeErrorFrameDefaultReason(
    config.error_frame_default_reason
  );
  // §4.7.2.5 · Retry-jitter config (default-OFF opt-in; SSE-only)
  const retryJitterEnabled = config.retry_jitter_enabled === true;
  const retryJitterMaxMs = isValidJitterCap(config.retry_jitter_max_ms)
    ? config.retry_jitter_max_ms
    : DEFAULT_RETRY_JITTER_MAX_MS;

  let cachedKind: ServerTimingStreamKind | null = null;
  let count = 0;
  let heartbeatCount = 0;
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // §4.7.2.2 · Bounded LIFO ring-buffer + last-emitted id cursor.
  const resumeHistory: ServerTimingResumeEntry[] = [];
  let lastEventId: string | null = null;
  // §4.7.2.3 · Reconnect-time hint cursor (advisory; null before first set).
  let reconnectMs: number | null = null;
  // §4.7.2.4 · Error-frame reason cursor (advisory; null before first emit).
  let errorReason: string | null = null;
  // §4.7.2.5 · Jitter offset cursor (advisory; null before first successful
  // emitStreamRetryHint or when the jitter branch was inactive).
  let retryJitterMs: number | null = null;

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

  function doEmit(
    name: string,
    dur: number | undefined,
    desc: string | undefined,
    id?: string
  ): void {
    if (closed) return;
    if (!isValidMetricName(name)) return;
    const kind = resolveKind();
    if (kind === 'none') return;
    // §4.7.2.2 · Validate id — non-token id silently drops id but keeps
    // emit (backwards-compat with pre-§4.7.2.2 handlers).
    const effectiveId =
      typeof id === 'string' && id.length > 0 && TOKEN_RE.test(id) ? id : undefined;
    try {
      if (kind === 'sse') {
        const frame = serializeSseFrame(sseEventName, name, dur, desc, effectiveId);
        // Only write if the underlying socket is still writable.
        if (!res.writableEnded) {
          res.write(frame);
          count++;
          if (effectiveId !== undefined) {
            lastEventId = effectiveId;
            if (resumeEnabled) {
              resumeHistory.push({ id: effectiveId, name, dur, desc });
              // Bounded LIFO cap — drop oldest when over capacity.
              if (resumeHistory.length > resumeHistorySize) {
                resumeHistory.splice(0, resumeHistory.length - resumeHistorySize);
              }
            }
          }
        }
      } else if (kind === 'websocket') {
        const locals = res.locals as Record<string, unknown>;
        const ws = locals.serverTimingStreamWebSocket as ServerTimingStreamSocket | undefined;
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
    emit(name: string, dur?: number, desc?: string, id?: string) {
      doEmit(name, dur, desc, id);
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
    resumeFrom(
      sinceId: string | null | undefined,
      replay: (entry: ServerTimingResumeEntry) => void
    ) {
      if (closed) return;
      if (!resumeEnabled) return;
      if (typeof replay !== 'function') return;
      const kind = resolveKind();
      if (kind !== 'sse') return;
      // Empty/null/undefined/non-token sinceId → replay every cached entry
      // (per HTML5 §9.2.5 EventSource default: no Last-Event-ID header on
      // first connect means client has no prior cursor).
      const cursor =
        typeof sinceId === 'string' && sinceId.length > 0 && TOKEN_RE.test(sinceId)
          ? sinceId
          : null;
      // Locate the cursor in cache; entries strictly-after (LIFO order
      // = insertion order = oldest→newest) get replayed.
      let startIdx = 0;
      if (cursor !== null) {
        const foundIdx = resumeHistory.findIndex(e => e.id === cursor);
        // cursor found → start after it; cursor not in cache → replay
        // everything (client is further behind than our ring-buffer holds,
        // so serve all we have — best-effort recovery per HTML5 §9.2.5).
        startIdx = foundIdx >= 0 ? foundIdx + 1 : 0;
      }
      for (let i = startIdx; i < resumeHistory.length; i++) {
        const entry = resumeHistory[i];
        try {
          replay(entry);
        } catch {
          // Per-entry fail-OPEN silent — advisory-only handler-side hook.
        }
      }
    },
    setReconnectMs(ms: number) {
      if (closed) return;
      if (!retryEnabled) return;
      const kind = resolveKind();
      if (kind !== 'sse') return;
      if (res.writableEnded) return;
      if (!isValidRetryMs(ms, retryMaxMs)) return;
      try {
        res.write(serializeSseRetryFrame(ms));
        reconnectMs = ms;
      } catch {
        // Fail-OPEN silent — advisory-only, never propagate transport errors.
      }
    },
    emitStreamError(reason: string, retriable?: boolean) {
      if (closed) return;
      if (!errorFrameEnabled) return;
      const kind = resolveKind();
      if (kind !== 'sse') return;
      if (res.writableEnded) return;
      if (!isValidErrorReason(reason)) return;
      try {
        // Retriable hint: emit a preceding `retry:` control-frame first so the
        // client's onerror handler + reconnection timer are aligned. The
        // retry emission itself is guarded by §4.7.2.3 semantics (positive-
        // integer + bounds); a validation failure there does NOT block the
        // error-frame emission below (advisory-only pairing).
        if (retriable === true && isValidRetryMs(retryDefaultMs, retryMaxMs)) {
          res.write(serializeSseRetryFrame(retryDefaultMs));
          reconnectMs = retryDefaultMs;
        }
        res.write(serializeSseErrorFrame(reason));
        errorReason = reason;
      } catch {
        // Fail-OPEN silent — advisory-only, never propagate transport errors.
      }
    },
    emitStreamRetryHint(baseMs: number, jitterMs?: number) {
      if (closed) return;
      if (!retryJitterEnabled) return;
      const kind = resolveKind();
      if (kind !== 'sse') return;
      if (res.writableEnded) return;
      if (!isValidRetryMs(baseMs, retryMaxMs)) return;
      // Resolve effective jitter cap: explicit jitterMs when valid, else
      // the configured retry_jitter_max_ms.
      const effectiveJitter =
        jitterMs === undefined
          ? retryJitterMaxMs
          : isValidJitterMs(jitterMs, retryJitterMaxMs)
            ? jitterMs
            : -1;
      if (effectiveJitter < 0) return;
      try {
        RETRY_JITTER_MONOTONIC_COUNTER += 1;
        const seed = `${Date.now()}:${baseMs}:${RETRY_JITTER_MONOTONIC_COUNTER}`;
        const { emittedMs: rawEmitted, jitterOffset } = computeJitteredRetry(
          baseMs,
          effectiveJitter,
          seed
        );
        // Clamp final value to §4.7.2.3 bounds so downstream client parsers
        // (and our own isValidRetryMs invariant) stay satisfied even when
        // baseMs + jitter would underflow to 0 or exceed the cap.
        const clamped =
          rawEmitted < 1 ? 1 : rawEmitted > retryMaxMs ? retryMaxMs : rawEmitted;
        res.write(serializeSseRetryFrame(clamped));
        reconnectMs = clamped;
        retryJitterMs = effectiveJitter === 0 ? 0 : jitterOffset;
      } catch {
        // Fail-OPEN silent — advisory-only, never propagate transport errors.
      }
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
    get lastEventId() {
      return lastEventId;
    },
    get reconnectMs() {
      return reconnectMs;
    },
    get errorReason() {
      return errorReason;
    },
    get retryJitterMs() {
      return retryJitterMs;
    },
  };
  return adapter;
}

// No-op adapter for the default-OFF path. Fully typed so handlers can call
// unconditionally without a null-guard.
function buildNoopAdapter(): ServerTimingStreamAdapter {
  return {
    emit(_name: string, _dur?: number, _desc?: string, _id?: string) {
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
    resumeFrom(
      _sinceId: string | null | undefined,
      _replay: (entry: ServerTimingResumeEntry) => void
    ) {
      /* no-op */
    },
    setReconnectMs(_ms: number) {
      /* no-op */
    },
    emitStreamError(_reason: string, _retriable?: boolean) {
      /* no-op */
    },
    emitStreamRetryHint(_baseMs: number, _jitterMs?: number) {
      /* no-op */
    },
    kind: 'none',
    count: 0,
    heartbeatCount: 0,
    lastEventId: null,
    reconnectMs: null,
    errorReason: null,
    retryJitterMs: null,
  };
}

export function buildApiServerTimingStreamingMiddleware(
  config: ServerTimingStreamingConfig | null
) {
  const enabled = config?.enabled === true;
  return (_req: Request, res: Response, next: NextFunction) => {
    const adapter = enabled
      ? buildAdapter(res, config as ServerTimingStreamingConfig)
      : buildNoopAdapter();
    (res.locals as Record<string, unknown>).serverTimingStream = adapter;
    next();
  };
}

export const apiServerTimingStreamingMiddleware = () =>
  buildApiServerTimingStreamingMiddleware(PKG_STREAMING_CONFIG);

export const CURRENT_STREAMING_CONFIG = PKG_STREAMING_CONFIG;

// §4.7.2.2 · Public helper exported for handlers that want to read the
// `Last-Event-ID` request header without hard-coding the field name.
// Accepts any object with a `headers` map (Express Request, Node IncomingMessage).
export function getLastEventIdHeader(
  req: { headers?: Record<string, string | string[] | undefined> },
  headerName?: string
): string | null {
  const config = PKG_STREAMING_CONFIG;
  const effectiveName = headerName ?? sanitizeResumeHeaderName(config?.resume_header_name);
  return getLastEventIdFromHeader(req, effectiveName);
}

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
  isValidResumeHistorySize,
  sanitizeResumeHeaderName,
  getLastEventIdFromHeader,
  isValidRetryMs,
  isValidRetryCap,
  serializeSseRetryFrame,
  isValidErrorReason,
  sanitizeErrorFrameDefaultReason,
  serializeSseErrorFrame,
  isValidJitterCap,
  isValidJitterMs,
  computeJitteredRetry,
  detectKind,
  buildNoopAdapter,
  buildAdapter,
};
