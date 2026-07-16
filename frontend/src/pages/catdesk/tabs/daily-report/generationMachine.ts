import type { GenerationJob, RemoteGenerationJob } from './types';

export const POLL_DELAYS_MS = [1000, 2000, 5000, 10000] as const;
export const POLL_TIMEOUT_MS = 60_000;

export function pollDelay(attempt: number): number {
  return POLL_DELAYS_MS[Math.min(Math.max(attempt, 0), POLL_DELAYS_MS.length - 1)];
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

function assertExactFields(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(raw).filter(key => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Generation job has unexpected field: ${unexpected.join(', ')}`);
  }
}

export function parseGenerationJob(value: unknown): RemoteGenerationJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Generation job must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (!hasOwn(raw, 'job_id') || typeof raw.job_id !== 'string' || !UUID_V4.test(raw.job_id)) {
    throw new Error('Generation job_id must be a canonical UUIDv4');
  }
  if (!hasOwn(raw, 'status') || typeof raw.status !== 'string') {
    throw new Error('Generation status is invalid');
  }

  switch (raw.status) {
    case 'queued':
    case 'running': {
      assertExactFields(raw, ['job_id', 'status', 'retry_after_ms']);
      if (
        hasOwn(raw, 'retry_after_ms') &&
        (typeof raw.retry_after_ms !== 'number' ||
          !Number.isInteger(raw.retry_after_ms) ||
          raw.retry_after_ms <= 0 ||
          raw.retry_after_ms > 10_000)
      ) {
        throw new Error('Generation retry_after_ms must be a positive integer at most 10000');
      }
      return hasOwn(raw, 'retry_after_ms')
        ? {
            job_id: raw.job_id,
            status: raw.status,
            retry_after_ms: raw.retry_after_ms as number,
          }
        : { job_id: raw.job_id, status: raw.status };
    }
    case 'completed':
      assertExactFields(raw, ['job_id', 'status', 'snapshot_id']);
      if (
        !hasOwn(raw, 'snapshot_id') ||
        typeof raw.snapshot_id !== 'string' ||
        !UUID_V4.test(raw.snapshot_id)
      ) {
        throw new Error('Completed generation requires a UUIDv4 snapshot_id');
      }
      return { job_id: raw.job_id, status: raw.status, snapshot_id: raw.snapshot_id };
    case 'failed':
      assertExactFields(raw, ['job_id', 'status', 'error']);
      if (!hasOwn(raw, 'error') || typeof raw.error !== 'string' || raw.error.trim().length === 0) {
        throw new Error('Failed generation requires a nonempty error');
      }
      return { job_id: raw.job_id, status: raw.status, error: raw.error };
    case 'idle':
      throw new Error('Generation idle status is local-only');
    default:
      throw new Error('Generation status is invalid');
  }
}

export function nextGenerationState(
  current: GenerationJob,
  incoming: GenerationJob
): GenerationJob {
  if (current.job_id !== incoming.job_id) throw new Error('Generation job identity mismatch');
  if (current.status === 'completed' || current.status === 'failed') {
    throw new Error('Terminal generation state cannot transition');
  }
  if (current.status === 'idle' || incoming.status === 'idle') {
    throw new Error('Local idle generation state cannot transition');
  }

  const allowed =
    current.status === 'queued'
      ? incoming.status === 'queued' ||
        incoming.status === 'running' ||
        incoming.status === 'completed' ||
        incoming.status === 'failed'
      : incoming.status === 'running' ||
        incoming.status === 'completed' ||
        incoming.status === 'failed';
  if (!allowed) throw new Error('Generation status transition is invalid');
  return incoming;
}
