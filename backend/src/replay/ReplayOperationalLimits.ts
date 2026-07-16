export const REPLAY_OPERATIONAL_LIMIT_BOUNDS = Object.freeze({
  worker_deadline_seconds: { minimum: 1, maximum: 900, fallback: 120 },
  lease_seconds: { minimum: 1, maximum: 1_200, fallback: 150 },
  max_concurrency: { minimum: 1, maximum: 16, fallback: 2 },
  max_queue_depth: { minimum: 0, maximum: 1_000, fallback: 32 },
  submit_rate_per_minute: { minimum: 1, maximum: 120, fallback: 10 },
  status_rate_per_minute: { minimum: 1, maximum: 1_200, fallback: 120 },
  rate_max_users: { minimum: 1, maximum: 100_000, fallback: 10_000 },
} as const);

export const REPLAY_OPERATIONAL_ENV_NAMES = Object.freeze({
  worker_deadline_seconds: 'STOCKS_REPLAY_WORKER_DEADLINE_SECONDS',
  lease_seconds: 'STOCKS_REPLAY_LEASE_SECONDS',
  max_concurrency: 'STOCKS_REPLAY_MAX_CONCURRENCY',
  max_queue_depth: 'STOCKS_REPLAY_MAX_QUEUE_DEPTH',
  submit_rate_per_minute: 'STOCKS_REPLAY_SUBMIT_RATE_PER_MINUTE',
  status_rate_per_minute: 'STOCKS_REPLAY_STATUS_RATE_PER_MINUTE',
  rate_max_users: 'STOCKS_REPLAY_RATE_MAX_USERS',
} as const);

export interface ReplayOperationalLimits {
  worker_deadline_seconds: number;
  lease_seconds: number;
  max_concurrency: number;
  max_queue_depth: number;
  submit_rate_per_minute: number;
  status_rate_per_minute: number;
  rate_max_users: number;
}

export class ReplayOperationalConfigurationError extends Error {
  constructor() {
    super('Replay operational limits are invalid');
    this.name = 'ReplayOperationalConfigurationError';
  }
}

const LIMIT_KEYS = Object.freeze([
  'worker_deadline_seconds',
  'lease_seconds',
  'max_concurrency',
  'max_queue_depth',
  'submit_rate_per_minute',
  'status_rate_per_minute',
  'rate_max_users',
] as const);

export function validateReplayOperationalLimits(value: unknown): ReplayOperationalLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReplayOperationalConfigurationError();
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(',') !== [...LIMIT_KEYS].sort().join(',')) {
    throw new ReplayOperationalConfigurationError();
  }
  for (const key of LIMIT_KEYS) {
    const field = raw[key];
    const bounds = REPLAY_OPERATIONAL_LIMIT_BOUNDS[key];
    if (
      typeof field !== 'number' ||
      !Number.isSafeInteger(field) ||
      field < bounds.minimum ||
      field > bounds.maximum
    ) {
      throw new ReplayOperationalConfigurationError();
    }
  }
  const limits = { ...raw } as unknown as ReplayOperationalLimits;
  if (limits.lease_seconds < limits.worker_deadline_seconds + 5) {
    throw new ReplayOperationalConfigurationError();
  }
  return Object.freeze(limits);
}

function boundedInteger(
  raw: string | undefined,
  bounds: { readonly minimum: number; readonly maximum: number; readonly fallback: number },
  required: boolean
): number {
  if (raw === undefined || raw === '') {
    if (required) throw new ReplayOperationalConfigurationError();
    return bounds.fallback;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new ReplayOperationalConfigurationError();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    throw new ReplayOperationalConfigurationError();
  }
  return value;
}

/**
 * Resolve every capacity/deadline knob from a bounded allowlist. Production
 * requires all values explicitly so a deployment cannot silently inherit a
 * development throughput or recovery policy.
 */
export function replayOperationalLimits(
  env: NodeJS.ProcessEnv = process.env
): ReplayOperationalLimits {
  const production = env.NODE_ENV === 'production';
  const read = (key: keyof typeof REPLAY_OPERATIONAL_ENV_NAMES): number =>
    boundedInteger(
      env[REPLAY_OPERATIONAL_ENV_NAMES[key]],
      REPLAY_OPERATIONAL_LIMIT_BOUNDS[key],
      production
    );
  const result: ReplayOperationalLimits = {
    worker_deadline_seconds: read('worker_deadline_seconds'),
    lease_seconds: read('lease_seconds'),
    max_concurrency: read('max_concurrency'),
    max_queue_depth: read('max_queue_depth'),
    submit_rate_per_minute: read('submit_rate_per_minute'),
    status_rate_per_minute: read('status_rate_per_minute'),
    rate_max_users: read('rate_max_users'),
  };
  return validateReplayOperationalLimits(result);
}

export interface ReplayRateDecision {
  allowed: boolean;
  retry_after_seconds: number;
}

interface RateWindow {
  started_at_ms: number;
  count: number;
}

/** Bounded-memory fixed-window limiter keyed by authenticated numeric user id. */
export class PerUserReplayRateLimiter {
  private readonly windows = new Map<number, RateWindow>();
  private nextCleanupAtMs = Number.POSITIVE_INFINITY;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly maxUsers: number,
    private readonly now: () => number = Date.now
  ) {
    if (
      !Number.isInteger(requestsPerMinute) ||
      requestsPerMinute < 1 ||
      requestsPerMinute > REPLAY_OPERATIONAL_LIMIT_BOUNDS.status_rate_per_minute.maximum ||
      !Number.isInteger(maxUsers) ||
      maxUsers < 1 ||
      maxUsers > REPLAY_OPERATIONAL_LIMIT_BOUNDS.rate_max_users.maximum
    ) {
      throw new ReplayOperationalConfigurationError();
    }
  }

  consume(userId: number): ReplayRateDecision {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return { allowed: false, retry_after_seconds: 60 };
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { allowed: false, retry_after_seconds: 60 };
    }
    const existing = this.windows.get(userId);
    if (existing && now - existing.started_at_ms < 60_000) {
      if (existing.count >= this.requestsPerMinute) {
        return {
          allowed: false,
          retry_after_seconds: Math.min(
            60,
            Math.max(1, Math.ceil((60_000 - (now - existing.started_at_ms)) / 1_000))
          ),
        };
      }
      existing.count += 1;
      return { allowed: true, retry_after_seconds: 0 };
    }

    if (!existing && this.windows.size >= this.maxUsers && now >= this.nextCleanupAtMs) {
      this.removeExpired(now);
    }
    if (!existing && this.windows.size >= this.maxUsers) {
      const retryAfter = Number.isFinite(this.nextCleanupAtMs)
        ? Math.min(60, Math.max(1, Math.ceil((this.nextCleanupAtMs - now) / 1_000)))
        : 60;
      return { allowed: false, retry_after_seconds: retryAfter };
    }
    this.windows.set(userId, { started_at_ms: now, count: 1 });
    this.nextCleanupAtMs = Math.min(this.nextCleanupAtMs, now + 60_000);
    return { allowed: true, retry_after_seconds: 0 };
  }

  private removeExpired(now: number): void {
    this.nextCleanupAtMs = Number.POSITIVE_INFINITY;
    for (const [userId, window] of this.windows) {
      const expiresAt = window.started_at_ms + 60_000;
      if (now >= expiresAt) {
        this.windows.delete(userId);
      } else {
        this.nextCleanupAtMs = Math.min(this.nextCleanupAtMs, expiresAt);
      }
    }
  }
}
