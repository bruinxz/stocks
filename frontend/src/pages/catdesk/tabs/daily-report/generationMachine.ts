import type { GenerationJob, GenerationStatus } from './types';

export const POLL_DELAYS_MS = [1000, 2000, 5000, 10000] as const;
export const POLL_TIMEOUT_MS = 60_000;

export function pollDelay(attempt: number): number {
  return POLL_DELAYS_MS[Math.min(Math.max(attempt, 0), POLL_DELAYS_MS.length - 1)];
}

export function parseGenerationJob(value: unknown): GenerationJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Generation job must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.job_id !== 'string' || raw.job_id.length === 0) {
    throw new Error('Generation job_id is required');
  }
  const allowed = new Set<GenerationStatus>(['idle', 'queued', 'running', 'completed', 'failed']);
  if (typeof raw.status !== 'string' || !allowed.has(raw.status as GenerationStatus)) {
    throw new Error('Generation status is invalid');
  }
  if (raw.status === 'completed' && typeof raw.snapshot_id !== 'string') {
    throw new Error('Completed generation requires snapshot_id');
  }
  if (raw.status === 'failed' && typeof raw.error !== 'string') {
    throw new Error('Failed generation requires error');
  }
  return {
    job_id: raw.job_id,
    status: raw.status as GenerationStatus,
    snapshot_id: typeof raw.snapshot_id === 'string' ? raw.snapshot_id : undefined,
    error: typeof raw.error === 'string' ? raw.error : undefined,
    retry_after_ms:
      typeof raw.retry_after_ms === 'number' && Number.isFinite(raw.retry_after_ms)
        ? raw.retry_after_ms
        : undefined,
  };
}

export function nextGenerationState(
  current: GenerationJob,
  incoming: GenerationJob
): GenerationJob {
  if (current.job_id !== incoming.job_id) throw new Error('Generation job identity mismatch');
  const rank: Record<GenerationStatus, number> = {
    idle: 0,
    queued: 1,
    running: 2,
    completed: 3,
    failed: 3,
  };
  if (rank[incoming.status] < rank[current.status]) {
    throw new Error('Generation status cannot move backwards');
  }
  if (current.status === 'completed' || current.status === 'failed') {
    throw new Error('Terminal generation state cannot transition');
  }
  return incoming;
}
