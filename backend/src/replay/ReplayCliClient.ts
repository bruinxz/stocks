import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { TextDecoder } from 'util';

import {
  REPLAY_PROTOCOL_VERSION,
  isCanonicalUuidV4,
  type ReplayJob,
  type ReplayPins,
} from './ReplayContract';

export { REPLAY_PROTOCOL_VERSION } from './ReplayContract';
export type { ReplayJob, ReplayPins } from './ReplayContract';

export const REPLAY_CLI_MAX_INPUT_BYTES = 64 * 1024;
export const REPLAY_CLI_MAX_OUTPUT_BYTES = 64 * 1024;
export const REPLAY_CLI_MAX_STDERR_BYTES = 4 * 1024;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 902_000;
const CHILD_REAP_TIMEOUT_MS = 1_000;
const DEFAULT_EXECUTABLE_PATH = '/usr/local/bin:/usr/bin:/bin';

export const REPLAY_CLI_ERROR_EXIT_CODES = {
  INPUT_TOO_LARGE: 2,
  INVALID_JSON: 2,
  INVALID_PROTOCOL: 2,
  INVALID_OPERATION: 2,
  INVALID_REQUEST: 2,
  INVALID_REPLAY_PINS: 3,
  REPLAY_JOB_NOT_FOUND: 3,
  REPLAY_CONFLICT: 3,
  REPLAY_RUNTIME_UNAVAILABLE: 4,
  REPLAY_STORE_UNAVAILABLE: 4,
  OUTPUT_TOO_LARGE: 4,
  INVALID_OUTPUT: 4,
  INTERNAL_ERROR: 4,
} as const;

const REPLAY_CLI_PUBLIC_ERROR_MESSAGES = {
  INPUT_TOO_LARGE: 'replay request too large',
  INVALID_JSON: 'invalid replay request',
  INVALID_PROTOCOL: 'unsupported replay protocol',
  INVALID_OPERATION: 'unsupported replay operation',
  INVALID_REQUEST: 'invalid replay request',
  INVALID_REPLAY_PINS: 'invalid replay pins',
  REPLAY_JOB_NOT_FOUND: 'replay job not found',
  REPLAY_CONFLICT: 'replay job conflict',
  REPLAY_RUNTIME_UNAVAILABLE: 'replay runtime unavailable',
  REPLAY_STORE_UNAVAILABLE: 'replay job store unavailable',
  OUTPUT_TOO_LARGE: 'replay response too large',
  INVALID_OUTPUT: 'invalid replay response',
  INTERNAL_ERROR: 'replay failed',
} as const satisfies Record<keyof typeof REPLAY_CLI_ERROR_EXIT_CODES, string>;

const REPLAY_TERMINAL_FAILURE_MESSAGES = new Set([
  'replay pipeline failed',
  'replay source invalid',
  'replay failed',
]);

const REPLAY_RUNTIME_ENV_KEYS = [
  'NODE_ENV',
  'STOCKS_REPLAY_RUNTIME_DIR',
  'STOCKS_REPLAY_WORKER_DEADLINE_SECONDS',
  'STOCKS_REPLAY_LEASE_SECONDS',
  'DATABASE_URL',
  'STOCKS_REPLAY_MODEL_VERSION',
  'STOCKS_REPLAY_TEMPLATE_HASH',
  'STOCKS_REPLAY_DISCLAIMERS_JSON',
] as const;

type JsonObject = Record<string, unknown>;
export type ReplayCliErrorCode = keyof typeof REPLAY_CLI_ERROR_EXIT_CODES;

export interface ReplayCliInvocationOptions {
  /** Zero deliberately disables the client-side timer for a durable worker call. */
  timeout_ms?: number;
  /** This boundary is opt-in; callers must not pass an HTTP request's abort signal implicitly. */
  signal?: AbortSignal;
}

export interface ReplayCliPort {
  submit(pins: ReplayPins, options?: ReplayCliInvocationOptions): Promise<ReplayJob>;
  status(jobId: string, options?: ReplayCliInvocationOptions): Promise<ReplayJob>;
  runOne(jobId: string, options?: ReplayCliInvocationOptions): Promise<ReplayJob>;
}

export interface ReplayCliClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  /** Only the documented replay variables are selected from this object. */
  env?: NodeJS.ProcessEnv;
  /** Zero disables the default client-side timer. */
  timeout_ms?: number;
  max_input_bytes?: number;
  max_output_bytes?: number;
  max_stderr_bytes?: number;
  spawn_process?: typeof spawn;
}

export class ReplayCliInputTooLargeError extends Error {
  constructor() {
    super('Replay CLI input exceeds the configured byte limit');
    this.name = 'ReplayCliInputTooLargeError';
  }
}

export class ReplayCliOutputTooLargeError extends Error {
  constructor(readonly stream: 'stdout' | 'stderr') {
    super(`Replay CLI ${stream} exceeds the configured byte limit`);
    this.name = 'ReplayCliOutputTooLargeError';
  }
}

export class ReplayCliTimeoutError extends Error {
  constructor() {
    super('Replay CLI timed out');
    this.name = 'ReplayCliTimeoutError';
  }
}

export class ReplayCliAbortedError extends Error {
  constructor() {
    super('Replay CLI invocation was aborted');
    this.name = 'ReplayCliAbortedError';
  }
}

export class ReplayCliUnavailableError extends Error {
  constructor() {
    super('Replay CLI is unavailable');
    this.name = 'ReplayCliUnavailableError';
  }
}

export class ReplayCliProtocolError extends Error {
  constructor(message = 'Replay CLI returned an invalid protocol response') {
    super(message);
    this.name = 'ReplayCliProtocolError';
  }
}

export class ReplayCliRejectedError extends Error {
  constructor(readonly code: ReplayCliErrorCode, message: string, readonly exit_code: number) {
    super(message);
    this.name = 'ReplayCliRejectedError';
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= MAX_TIMEOUT_MS
    ? Number(value)
    : fallback;
}

function configuredTimeout(): number {
  const parsed = Number(process.env.STOCKS_REPLAY_CLI_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_TIMEOUT_MS
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

function replayCliEnvironment(
  repositoryRoot: string,
  requested: NodeJS.ProcessEnv | undefined
): NodeJS.ProcessEnv {
  const source = requested ?? process.env;
  const environment: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? process.env.PATH ?? DEFAULT_EXECUTABLE_PATH,
    PYTHONPATH: repositoryRoot,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const key of REPLAY_RUNTIME_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertUnicodeScalars(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) throw new Error('unpaired high surrogate');
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new Error('unpaired high surrogate');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('unpaired low surrogate');
    }
  }
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) throw new Error('trailing JSON content');
    return value;
  }

  private parseValue(): unknown {
    const character = this.source[this.index];
    if (character === '{') return this.parseObject();
    if (character === '[') return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === 't') return this.parseLiteral('true', true);
    if (character === 'f') return this.parseLiteral('false', false);
    if (character === 'n') return this.parseLiteral('null', null);
    if (character === '-' || (character >= '0' && character <= '9')) return this.parseNumber();
    throw new Error('invalid JSON value');
  }

  private parseObject(): JsonObject {
    this.index += 1;
    this.skipWhitespace();
    const value: JsonObject = {};
    const keys = new Set<string>();
    if (this.consume('}')) return value;
    while (true) {
      if (this.source[this.index] !== '"') throw new Error('object key must be a string');
      const key = this.parseString();
      if (keys.has(key)) throw new Error('duplicate JSON object key');
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(':')) throw new Error('missing object colon');
      this.skipWhitespace();
      Object.defineProperty(value, key, {
        value: this.parseValue(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.skipWhitespace();
      if (this.consume('}')) return value;
      if (!this.consume(',')) throw new Error('missing object comma');
      this.skipWhitespace();
    }
  }

  private parseArray(): unknown[] {
    this.index += 1;
    this.skipWhitespace();
    const value: unknown[] = [];
    if (this.consume(']')) return value;
    while (true) {
      value.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume(']')) return value;
      if (!this.consume(',')) throw new Error('missing array comma');
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        const value = JSON.parse(this.source.slice(start, this.index)) as unknown;
        if (typeof value !== 'string') throw new Error('invalid JSON string');
        assertUnicodeScalars(value);
        return value;
      }
      this.index += character === '\\' ? 2 : 1;
    }
    throw new Error('unterminated JSON string');
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.index)
    );
    if (!match) throw new Error('invalid JSON number');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    return value;
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.index)) throw new Error('invalid JSON literal');
    this.index += literal.length;
    return value;
  }

  private consume(character: string): boolean {
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === ' ' ||
      this.source[this.index] === '\t' ||
      this.source[this.index] === '\n' ||
      this.source[this.index] === '\r'
    ) {
      this.index += 1;
    }
  }
}

function parseJsonObject(raw: Buffer, label: string): JsonObject {
  let parsed: unknown;
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    parsed = new StrictJsonParser(source).parse();
  } catch (_error) {
    throw new ReplayCliProtocolError(`${label} is not valid strict JSON`);
  }
  if (!isObject(parsed)) throw new ReplayCliProtocolError(`${label} must be a JSON object`);
  return parsed;
}

function parseReplayJob(value: unknown): ReplayJob {
  if (!isObject(value) || typeof value.job_id !== 'string' || !isCanonicalUuidV4(value.job_id)) {
    throw new ReplayCliProtocolError();
  }
  switch (value.status) {
    case 'queued':
    case 'running':
      if (!hasExactKeys(value, ['job_id', 'status'])) throw new ReplayCliProtocolError();
      return { job_id: value.job_id, status: value.status };
    case 'completed':
      if (
        !hasExactKeys(value, ['job_id', 'status', 'snapshot_id']) ||
        typeof value.snapshot_id !== 'string' ||
        !isCanonicalUuidV4(value.snapshot_id)
      ) {
        throw new ReplayCliProtocolError();
      }
      return { job_id: value.job_id, status: 'completed', snapshot_id: value.snapshot_id };
    case 'failed':
      if (
        !hasExactKeys(value, ['job_id', 'status', 'error']) ||
        typeof value.error !== 'string' ||
        !REPLAY_TERMINAL_FAILURE_MESSAGES.has(value.error)
      ) {
        throw new ReplayCliProtocolError();
      }
      return { job_id: value.job_id, status: 'failed', error: value.error };
    default:
      throw new ReplayCliProtocolError();
  }
}

function parseSuccess(stdout: Buffer, stderr: Buffer): ReplayJob {
  if (stderr.length !== 0) {
    throw new ReplayCliProtocolError('Successful replay invocation wrote to stderr');
  }
  const response = parseJsonObject(stdout, 'Replay CLI stdout');
  if (
    !hasExactKeys(response, ['protocol_version', 'ok', 'result']) ||
    response.protocol_version !== REPLAY_PROTOCOL_VERSION ||
    response.ok !== true ||
    !isObject(response.result) ||
    !hasExactKeys(response.result, ['job'])
  ) {
    throw new ReplayCliProtocolError();
  }
  return parseReplayJob(response.result.job);
}

function parseRejection(stderr: Buffer, stdout: Buffer, exitCode: number): never {
  if (stdout.length !== 0) {
    throw new ReplayCliProtocolError('Failed replay invocation wrote to stdout');
  }
  const response = parseJsonObject(stderr, 'Replay CLI stderr');
  if (
    !hasExactKeys(response, ['protocol_version', 'ok', 'error']) ||
    response.protocol_version !== REPLAY_PROTOCOL_VERSION ||
    response.ok !== false ||
    !isObject(response.error) ||
    !hasExactKeys(response.error, ['code', 'message']) ||
    typeof response.error.code !== 'string' ||
    !(response.error.code in REPLAY_CLI_ERROR_EXIT_CODES) ||
    typeof response.error.message !== 'string'
  ) {
    throw new ReplayCliProtocolError();
  }
  const code = response.error.code as ReplayCliErrorCode;
  if (response.error.message !== REPLAY_CLI_PUBLIC_ERROR_MESSAGES[code]) {
    throw new ReplayCliProtocolError('Replay CLI returned an unexpected public error message');
  }
  const expectedExitCode = REPLAY_CLI_ERROR_EXIT_CODES[code];
  if (exitCode !== expectedExitCode) {
    throw new ReplayCliProtocolError('Replay CLI error code/exit code mismatch');
  }
  throw new ReplayCliRejectedError(code, response.error.message, exitCode);
}

function exactPins(pins: ReplayPins): JsonObject {
  return {
    trading_day: pins.trading_day,
    as_of: pins.as_of,
    profile: pins.profile,
    market_scope: pins.market_scope,
    profile_version: pins.profile_version,
    contract_version: pins.contract_version,
    input_fingerprint: pins.input_fingerprint,
    strategy_version: pins.strategy_version,
    pipeline_version: pins.pipeline_version,
  };
}

export class ReplayCliClient implements ReplayCliPort {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxStderrBytes: number;
  private readonly spawnProcess: typeof spawn;
  private readonly unreapedChildren = new Set<ChildProcessWithoutNullStreams>();

  constructor(options: ReplayCliClientOptions = {}) {
    const repositoryRoot = path.resolve(__dirname, '../../..');
    this.command = options.command ?? process.env.STOCKS_REPLAY_PYTHON ?? 'python3';
    this.args = options.args ?? ['-m', 'ai.replay.cli'];
    this.cwd = options.cwd ?? repositoryRoot;
    this.env = replayCliEnvironment(repositoryRoot, options.env);
    this.timeoutMs = nonNegativeInteger(options.timeout_ms, configuredTimeout());
    this.maxInputBytes = Math.min(
      positiveInteger(options.max_input_bytes, REPLAY_CLI_MAX_INPUT_BYTES),
      REPLAY_CLI_MAX_INPUT_BYTES
    );
    this.maxOutputBytes = Math.min(
      positiveInteger(options.max_output_bytes, REPLAY_CLI_MAX_OUTPUT_BYTES),
      REPLAY_CLI_MAX_OUTPUT_BYTES
    );
    this.maxStderrBytes = Math.min(
      positiveInteger(options.max_stderr_bytes, REPLAY_CLI_MAX_STDERR_BYTES),
      REPLAY_CLI_MAX_STDERR_BYTES
    );
    this.spawnProcess = options.spawn_process ?? spawn;
  }

  submit(pins: ReplayPins, options: ReplayCliInvocationOptions = {}): Promise<ReplayJob> {
    return this.execute(
      {
        protocol_version: REPLAY_PROTOCOL_VERSION,
        op: 'submit',
        pins: exactPins(pins),
      },
      options
    );
  }

  status(jobId: string, options: ReplayCliInvocationOptions = {}): Promise<ReplayJob> {
    return this.execute(
      { protocol_version: REPLAY_PROTOCOL_VERSION, op: 'status', job_id: jobId },
      options
    );
  }

  runOne(jobId: string, options: ReplayCliInvocationOptions = {}): Promise<ReplayJob> {
    return this.execute(
      { protocol_version: REPLAY_PROTOCOL_VERSION, op: 'run_one', job_id: jobId },
      options
    );
  }

  private execute(request: JsonObject, invocation: ReplayCliInvocationOptions): Promise<ReplayJob> {
    if (invocation.signal?.aborted) return Promise.reject(new ReplayCliAbortedError());
    if (this.unreapedChildren.size > 0) {
      return Promise.reject(new ReplayCliUnavailableError());
    }

    let input: Buffer;
    try {
      input = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
    } catch (_error) {
      return Promise.reject(new ReplayCliProtocolError('Replay CLI request is not JSON-safe'));
    }
    if (input.length > this.maxInputBytes) {
      return Promise.reject(new ReplayCliInputTooLargeError());
    }
    const timeoutMs = nonNegativeInteger(invocation.timeout_ms, this.timeoutMs);

    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(this.command, this.args, {
          cwd: this.cwd,
          env: this.env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (_error) {
        reject(new ReplayCliUnavailableError());
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let pendingFailure: Error | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      let reapTimeout: NodeJS.Timeout | undefined;

      const abort = (): void => fail(new ReplayCliAbortedError());
      const clear = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        invocation.signal?.removeEventListener('abort', abort);
      };
      const terminate = (): void => {
        try {
          child.kill('SIGTERM');
        } catch (_error) {
          // The child may already have exited; the invocation is settled below.
        }
        forceKill = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (_error) {
            // Best-effort cleanup only.
          }
        }, 250);
        forceKill.unref();
      };
      const fail = (error: Error): void => {
        if (settled || pendingFailure) return;
        pendingFailure = error;
        clear();
        this.unreapedChildren.add(child);
        terminate();
        reapTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(error);
        }, CHILD_REAP_TIMEOUT_MS);
        reapTimeout.unref?.();
      };

      invocation.signal?.addEventListener('abort', abort, { once: true });
      if (timeoutMs > 0) {
        timeout = setTimeout(() => fail(new ReplayCliTimeoutError()), timeoutMs);
        timeout.unref();
      }

      child.stdout.on('data', (chunk: Buffer | string) => {
        if (pendingFailure) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > this.maxOutputBytes) {
          fail(new ReplayCliOutputTooLargeError('stdout'));
          return;
        }
        stdout.push(buffer);
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        if (pendingFailure) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += buffer.length;
        if (stderrBytes > this.maxStderrBytes) {
          fail(new ReplayCliOutputTooLargeError('stderr'));
          return;
        }
        stderr.push(buffer);
      });

      child.on('error', () => fail(new ReplayCliUnavailableError()));
      child.stdin.on('error', error => {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
          fail(new ReplayCliUnavailableError());
        }
      });

      child.on('close', (code, signal) => {
        this.unreapedChildren.delete(child);
        if (forceKill !== undefined) clearTimeout(forceKill);
        if (reapTimeout !== undefined) clearTimeout(reapTimeout);
        if (settled) return;
        settled = true;
        clear();
        if (pendingFailure) {
          reject(pendingFailure);
          return;
        }
        const stdoutBuffer = Buffer.concat(stdout);
        const stderrBuffer = Buffer.concat(stderr);
        try {
          if (code === 0 && signal == null) {
            resolve(parseSuccess(stdoutBuffer, stderrBuffer));
            return;
          }
          if (typeof code === 'number') parseRejection(stderrBuffer, stdoutBuffer, code);
          throw new ReplayCliUnavailableError();
        } catch (error: unknown) {
          reject(error);
        }
      });

      child.stdin.end(input);
    });
  }
}
