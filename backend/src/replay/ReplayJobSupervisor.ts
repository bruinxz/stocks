import type { ReplayJob, ReplayPins } from './ReplayContract';
import { ReplayCliRejectedError, type ReplayCliPort } from './ReplayCliClient';
import {
  replayOperationalLimits,
  validateReplayOperationalLimits,
  type ReplayOperationalLimits,
} from './ReplayOperationalLimits';

export type { ReplayCliPort } from './ReplayCliClient';

export interface ReplayJobSupervisorOptions {
  http_wait_ms?: number;
  control_timeout_ms?: number;
  operational_limits?: ReplayOperationalLimits;
  on_background_error?: (error: unknown) => void;
}

interface QueuedExecution {
  promise: Promise<ReplayJob>;
  resolve: (job: ReplayJob) => void;
  reject: (error: unknown) => void;
}

export class ReplayBackpressureError extends Error {
  constructor() {
    super('Replay execution capacity is exhausted');
    this.name = 'ReplayBackpressureError';
  }
}

function boundedMilliseconds(
  value: number | undefined,
  fallback: number,
  maximum: number,
  minimum = 0
): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return fallback;
  }
  return Number(value);
}

function delay(milliseconds: number): Promise<null> {
  return new Promise(resolve => {
    setTimeout(() => resolve(null), milliseconds);
  });
}

function isReplayConflict(error: unknown): boolean {
  return error instanceof ReplayCliRejectedError && error.code === 'REPLAY_CONFLICT';
}

/**
 * Process-wide scheduler for durable replay children. Capacity is reserved
 * before submit so a rejected request never leaves a newly-created queued job
 * outside the bounded scheduler. Worker children always have a finite timer;
 * an interrupted child leaves its authenticated lease for safe later reclaim.
 */
export class ReplayJobSupervisor {
  private readonly active = new Map<string, Promise<ReplayJob>>();
  private readonly queued = new Map<string, QueuedExecution>();
  private pendingAdmissions = 0;
  private controlInFlight = 0;
  private readonly httpWaitMs: number;
  private readonly controlTimeoutMs: number;
  private readonly workerTimeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly maxQueueDepth: number;
  private readonly onBackgroundError: (error: unknown) => void;

  constructor(private readonly cli: ReplayCliPort, options: ReplayJobSupervisorOptions = {}) {
    const limits = validateReplayOperationalLimits(
      options.operational_limits ?? replayOperationalLimits()
    );
    this.httpWaitMs = boundedMilliseconds(options.http_wait_ms, 1_000, 10_000);
    this.controlTimeoutMs = boundedMilliseconds(options.control_timeout_ms, 5_000, 30_000, 1);
    this.workerTimeoutMs = (limits.worker_deadline_seconds + 2) * 1_000;
    this.maxConcurrency = limits.max_concurrency;
    this.maxQueueDepth = limits.max_queue_depth;
    this.onBackgroundError = options.on_background_error ?? (() => undefined);
  }

  async submitAndRun(pins: ReplayPins): Promise<ReplayJob> {
    this.reserveAdmission();
    let submitted: ReplayJob;
    try {
      submitted = await this.runControl(() =>
        this.cli.submit(pins, { timeout_ms: this.controlTimeoutMs })
      );
    } finally {
      this.pendingAdmissions -= 1;
    }
    if (submitted.status === 'completed' || submitted.status === 'failed') return submitted;

    const execution = this.schedule(submitted.job_id, true);
    const observed = await Promise.race([execution, delay(this.httpWaitMs)]);
    if (observed !== null) return observed;
    try {
      return await this.runControl(() =>
        this.cli.status(submitted.job_id, { timeout_ms: this.controlTimeoutMs })
      );
    } catch (error: unknown) {
      // The durable submit result is still a truthful pending observation. Do
      // not exceed the global child-process bound merely to refresh it while
      // every slot is occupied by an admitted worker.
      if (error instanceof ReplayBackpressureError) return submitted;
      throw error;
    }
  }

  async status(job_id: string): Promise<ReplayJob> {
    const current = await this.runControl(() =>
      this.cli.status(job_id, { timeout_ms: this.controlTimeoutMs })
    );
    if (current.status === 'queued' || current.status === 'running') {
      try {
        this.schedule(current.job_id, false);
      } catch (error: unknown) {
        if (!(error instanceof ReplayBackpressureError)) throw error;
      }
    }
    return current;
  }

  private reserveAdmission(): void {
    if (this.totalScheduled() >= this.maxConcurrency + this.maxQueueDepth) {
      throw new ReplayBackpressureError();
    }
    this.pendingAdmissions += 1;
  }

  private totalScheduled(): number {
    return this.active.size + this.queued.size + this.pendingAdmissions;
  }

  private async runControl<T>(operation: () => Promise<T>): Promise<T> {
    if (this.childSlotsInUse() >= this.maxConcurrency) {
      throw new ReplayBackpressureError();
    }
    this.controlInFlight += 1;
    try {
      return await operation();
    } finally {
      this.controlInFlight -= 1;
      this.pump();
    }
  }

  private childSlotsInUse(): number {
    return this.active.size + this.controlInFlight;
  }

  private schedule(job_id: string, reserved: boolean): Promise<ReplayJob> {
    const active = this.active.get(job_id);
    if (active) return active;
    const queued = this.queued.get(job_id);
    if (queued) return queued.promise;
    if (!reserved && this.totalScheduled() >= this.maxConcurrency + this.maxQueueDepth) {
      throw new ReplayBackpressureError();
    }

    let resolve!: (job: ReplayJob) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ReplayJob>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.queued.set(job_id, { promise, resolve, reject });
    void promise.catch(error => {
      try {
        this.onBackgroundError(error);
      } catch (_ignored) {
        // Observability hooks must never break scheduler cleanup or capacity.
      }
    });
    this.pump();
    return promise;
  }

  private pump(): void {
    while (this.childSlotsInUse() < this.maxConcurrency && this.queued.size > 0) {
      const next = this.queued.entries().next().value as
        | [string, QueuedExecution]
        | undefined;
      if (!next) return;
      const [job_id, queued] = next;
      this.queued.delete(job_id);
      this.active.set(job_id, queued.promise);
      void this.invoke(job_id).then(
        job => {
          queued.resolve(job);
          this.finish(job_id, queued.promise);
        },
        error => {
          queued.reject(error);
          this.finish(job_id, queued.promise);
        }
      );
    }
  }

  private async invoke(job_id: string): Promise<ReplayJob> {
    try {
      return await this.cli.runOne(job_id, { timeout_ms: this.workerTimeoutMs });
    } catch (error: unknown) {
      if (isReplayConflict(error)) {
        return this.cli.status(job_id, { timeout_ms: this.controlTimeoutMs });
      }
      throw error;
    }
  }

  private finish(job_id: string, execution: Promise<ReplayJob>): void {
    if (this.active.get(job_id) === execution) this.active.delete(job_id);
    this.pump();
  }
}
