import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { TextDecoder } from 'util';

export const PROJECTION_CLI_PROTOCOL_VERSION = '1.0.0' as const;
export const PROJECTION_CLI_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const PROJECTION_CLI_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_EXECUTABLE_PATH = '/usr/local/bin:/usr/bin:/bin';
const PROJECTION_CLI_ERROR_EXIT_CODES = {
  INPUT_TOO_LARGE: 2,
  INVALID_JSON: 2,
  INVALID_PROTOCOL: 2,
  INVALID_OPERATION: 2,
  INVALID_REQUEST: 2,
  OUTPUT_TOO_LARGE: 2,
  INVALID_OUTPUT: 2,
  CONTRACT_ERROR: 3,
  INTERNAL_ERROR: 4,
} as const;

type JsonObject = Record<string, unknown>;

export interface ProjectionHistoryFilters {
  query?: string;
  profile?: string;
  market_scope?: string;
  from_day?: string;
  to_day?: string;
}

export interface ProjectionCliPort {
  projectDaily(envelope: JsonObject): Promise<JsonObject>;
  projectHistory(
    envelopes: JsonObject[],
    filters?: ProjectionHistoryFilters,
    tradingDays?: Record<string, string>
  ): Promise<JsonObject>;
}

export interface ProjectionCliClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout_ms?: number;
  max_input_bytes?: number;
  max_output_bytes?: number;
  max_stderr_bytes?: number;
  spawn_process?: typeof spawn;
}

export class ProjectionCliInputTooLargeError extends Error {
  constructor() {
    super('Projection CLI input exceeds the configured byte limit');
    this.name = 'ProjectionCliInputTooLargeError';
  }
}

export class ProjectionCliOutputTooLargeError extends Error {
  constructor(stream: 'stdout' | 'stderr') {
    super(`Projection CLI ${stream} exceeds the configured byte limit`);
    this.name = 'ProjectionCliOutputTooLargeError';
  }
}

export class ProjectionCliTimeoutError extends Error {
  constructor() {
    super('Projection CLI timed out');
    this.name = 'ProjectionCliTimeoutError';
  }
}

export class ProjectionCliUnavailableError extends Error {
  constructor(message = 'Projection CLI is unavailable') {
    super(message);
    this.name = 'ProjectionCliUnavailableError';
  }
}

export class ProjectionCliProtocolError extends Error {
  constructor(message = 'Projection CLI returned an invalid protocol response') {
    super(message);
    this.name = 'ProjectionCliProtocolError';
  }
}

export class ProjectionCliRejectedError extends Error {
  constructor(readonly code: string, message: string, readonly exit_code: number) {
    super(message);
    this.name = 'ProjectionCliRejectedError';
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function configuredTimeout(): number {
  const parsed = Number(process.env.TAB67_PROJECTION_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function projectionCliEnvironment(
  repositoryRoot: string,
  requested: NodeJS.ProcessEnv | undefined
): NodeJS.ProcessEnv {
  return {
    PATH: requested?.PATH ?? process.env.PATH ?? DEFAULT_EXECUTABLE_PATH,
    PYTHONPATH: repositoryRoot,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
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
      if (index + 1 >= value.length) {
        throw new Error('unpaired high surrogate');
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new Error('unpaired high surrogate');
      }
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
      if (character === '\\') {
        this.index += 2;
      } else {
        this.index += 1;
      }
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
  let value: unknown;
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    value = new StrictJsonParser(source).parse();
  } catch (_error) {
    throw new ProjectionCliProtocolError(`${label} is not valid strict JSON`);
  }
  if (!isObject(value)) {
    throw new ProjectionCliProtocolError(`${label} must be a JSON object`);
  }
  return value;
}

function parseSuccess(stdout: Buffer, stderr: Buffer): JsonObject {
  if (stderr.length !== 0) {
    throw new ProjectionCliProtocolError('Successful projection wrote to stderr');
  }
  const response = parseJsonObject(stdout, 'Projection CLI stdout');
  if (
    !hasExactKeys(response, ['protocol_version', 'ok', 'result']) ||
    response.protocol_version !== PROJECTION_CLI_PROTOCOL_VERSION ||
    response.ok !== true ||
    !isObject(response.result)
  ) {
    throw new ProjectionCliProtocolError();
  }
  return response.result;
}

function parseRejection(stderr: Buffer, stdout: Buffer, exitCode: number): never {
  if (stdout.length !== 0) {
    throw new ProjectionCliProtocolError('Failed projection wrote to stdout');
  }
  const response = parseJsonObject(stderr, 'Projection CLI stderr');
  if (
    !hasExactKeys(response, ['protocol_version', 'ok', 'error']) ||
    response.protocol_version !== PROJECTION_CLI_PROTOCOL_VERSION ||
    response.ok !== false ||
    !isObject(response.error) ||
    !hasExactKeys(response.error, ['code', 'message']) ||
    typeof response.error.code !== 'string' ||
    response.error.code.length === 0 ||
    typeof response.error.message !== 'string' ||
    response.error.message.length === 0
  ) {
    throw new ProjectionCliProtocolError();
  }
  if (!(response.error.code in PROJECTION_CLI_ERROR_EXIT_CODES)) {
    throw new ProjectionCliProtocolError('Projection CLI returned an unknown error code');
  }
  const expectedExitCode =
    PROJECTION_CLI_ERROR_EXIT_CODES[
      response.error.code as keyof typeof PROJECTION_CLI_ERROR_EXIT_CODES
    ];
  if (exitCode !== expectedExitCode) {
    throw new ProjectionCliProtocolError('Projection CLI error code/exit code mismatch');
  }
  throw new ProjectionCliRejectedError(response.error.code, response.error.message, exitCode);
}

export class ProjectionCliClient implements ProjectionCliPort {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxStderrBytes: number;
  private readonly spawnProcess: typeof spawn;

  constructor(options: ProjectionCliClientOptions = {}) {
    const repositoryRoot = path.resolve(__dirname, '../../..');
    this.command = options.command ?? process.env.TAB67_PROJECTION_PYTHON ?? 'python3';
    this.args = options.args ?? ['-m', 'strategy.reporting.cli'];
    this.cwd = options.cwd ?? repositoryRoot;
    this.env = projectionCliEnvironment(repositoryRoot, options.env);
    this.timeoutMs = positiveInteger(options.timeout_ms, configuredTimeout());
    this.maxInputBytes = positiveInteger(options.max_input_bytes, PROJECTION_CLI_MAX_INPUT_BYTES);
    this.maxOutputBytes = positiveInteger(
      options.max_output_bytes,
      PROJECTION_CLI_MAX_OUTPUT_BYTES
    );
    this.maxStderrBytes = positiveInteger(options.max_stderr_bytes, DEFAULT_MAX_STDERR_BYTES);
    this.spawnProcess = options.spawn_process ?? spawn;
  }

  async projectDaily(envelope: JsonObject): Promise<JsonObject> {
    return this.execute({
      protocol_version: PROJECTION_CLI_PROTOCOL_VERSION,
      op: 'daily',
      envelope,
    });
  }

  async projectHistory(
    envelopes: JsonObject[],
    filters: ProjectionHistoryFilters = {},
    tradingDays: Record<string, string> = {}
  ): Promise<JsonObject> {
    const request: JsonObject = {
      protocol_version: PROJECTION_CLI_PROTOCOL_VERSION,
      op: 'history',
      envelopes,
    };
    for (const key of ['query', 'profile', 'market_scope', 'from_day', 'to_day'] as const) {
      const value = filters[key];
      if (value !== undefined) request[key] = value;
    }
    if (Object.keys(tradingDays).length > 0) request.trading_days = tradingDays;
    return this.execute(request);
  }

  private execute(request: JsonObject): Promise<JsonObject> {
    let input: Buffer;
    try {
      input = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
    } catch (_error) {
      return Promise.reject(new ProjectionCliProtocolError('Projection request is not JSON-safe'));
    }
    if (input.length > this.maxInputBytes) {
      return Promise.reject(new ProjectionCliInputTooLargeError());
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(this.command, this.args, {
          cwd: this.cwd,
          env: this.env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        reject(new ProjectionCliUnavailableError(message));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const clear = (): void => {
        clearTimeout(timeout);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clear();
        child.kill('SIGTERM');
        const forceKill = setTimeout(() => child.kill('SIGKILL'), 250);
        forceKill.unref();
        reject(error);
      };

      const timeout = setTimeout(() => fail(new ProjectionCliTimeoutError()), this.timeoutMs);
      timeout.unref();

      child.stdout.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > this.maxOutputBytes) {
          fail(new ProjectionCliOutputTooLargeError('stdout'));
          return;
        }
        stdout.push(buffer);
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += buffer.length;
        if (stderrBytes > this.maxStderrBytes) {
          fail(new ProjectionCliOutputTooLargeError('stderr'));
          return;
        }
        stderr.push(buffer);
      });

      child.on('error', (error: Error) => {
        fail(new ProjectionCliUnavailableError(error.message));
      });

      child.stdin.on('error', error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPIPE') fail(new ProjectionCliUnavailableError(error.message));
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clear();
        const stdoutBuffer = Buffer.concat(stdout);
        const stderrBuffer = Buffer.concat(stderr);
        try {
          if (code === 0 && signal == null) {
            resolve(parseSuccess(stdoutBuffer, stderrBuffer));
            return;
          }
          if (typeof code === 'number') {
            parseRejection(stderrBuffer, stdoutBuffer, code);
          }
          throw new ProjectionCliUnavailableError(
            `Projection CLI terminated by signal ${signal ?? 'unknown'}`
          );
        } catch (error: unknown) {
          reject(error);
        }
      });

      child.stdin.end(input);
    });
  }
}
