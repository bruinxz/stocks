import {
  ReplayBackpressureError,
  ReplayJobSupervisor,
  type ReplayCliPort,
} from '../../src/replay/ReplayJobSupervisor';
import {
  ReplayCliRejectedError,
  type ReplayCliInvocationOptions,
} from '../../src/replay/ReplayCliClient';
import type { ReplayJob, ReplayPins } from '../../src/replay/ReplayContract';
import type { ReplayOperationalLimits } from '../../src/replay/ReplayOperationalLimits';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const PINS: ReplayPins = {
  trading_day: '2026-07-14',
  as_of: '2026-07-14T06:00:00Z',
  profile: 'us_preferred',
  market_scope: 'us',
  profile_version: '1.0.0',
  contract_version: '0.3.1',
  input_fingerprint: 'a'.repeat(64),
  strategy_version: '1.0.0',
  pipeline_version: '1.0.0',
};
const LIMITS: ReplayOperationalLimits = {
  worker_deadline_seconds: 120,
  lease_seconds: 150,
  max_concurrency: 2,
  max_queue_depth: 32,
  submit_rate_per_minute: 10,
  status_rate_per_minute: 120,
  rate_max_users: 10_000,
};

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}`);
  }
}

class FakeCli implements ReplayCliPort {
  submit_result: ReplayJob = { job_id: JOB_ID, status: 'queued' };
  status_result: ReplayJob = { job_id: JOB_ID, status: 'running' };
  run_result: Promise<ReplayJob> = Promise.resolve({
    job_id: JOB_ID,
    status: 'completed',
    snapshot_id: SNAPSHOT_ID,
  });
  submit_calls: Array<{ pins: ReplayPins; options?: ReplayCliInvocationOptions }> = [];
  status_calls: Array<{ job_id: string; options?: ReplayCliInvocationOptions }> = [];
  run_calls: Array<{ job_id: string; options?: ReplayCliInvocationOptions }> = [];

  async submit(pins: ReplayPins, options?: ReplayCliInvocationOptions): Promise<ReplayJob> {
    this.submit_calls.push({ pins, options });
    return this.submit_result;
  }

  async status(job_id: string, options?: ReplayCliInvocationOptions): Promise<ReplayJob> {
    this.status_calls.push({ job_id, options });
    return this.status_result;
  }

  runOne(job_id: string, options?: ReplayCliInvocationOptions): Promise<ReplayJob> {
    this.run_calls.push({ job_id, options });
    return this.run_result;
  }
}

async function main(): Promise<void> {
  const immediate = new FakeCli();
  const immediateResult = await new ReplayJobSupervisor(immediate, {
    http_wait_ms: 100,
  }).submitAndRun(PINS);
  assert('fast durable run returns terminal job', immediateResult.status === 'completed');
  assert(
    'submit uses bounded control timeout',
    immediate.submit_calls[0].options?.timeout_ms === 5000
  );
  assert(
    'run_one has a finite deadline below its durable lease and no request signal',
    immediate.run_calls[0].options?.timeout_ms === 122_000 &&
      immediate.run_calls[0].options?.signal === undefined
  );

  let completeSlow: ((job: ReplayJob) => void) | undefined;
  const slow = new FakeCli();
  slow.run_result = new Promise(resolve => {
    completeSlow = resolve;
  });
  const slowSupervisor = new ReplayJobSupervisor(slow, { http_wait_ms: 1 });
  const timedOutResult = await slowSupervisor.submitAndRun(PINS);
  assert('HTTP wait expiry returns durable status', timedOutResult.status === 'running');
  assert('HTTP wait expiry does not cancel run_one', slow.run_calls.length === 1);
  completeSlow?.({ job_id: JOB_ID, status: 'completed', snapshot_id: SNAPSHOT_ID });
  await slow.run_result;

  let finishSingleflight: ((job: ReplayJob) => void) | undefined;
  const concurrent = new FakeCli();
  concurrent.run_result = new Promise(resolve => {
    finishSingleflight = resolve;
  });
  const concurrentSupervisor = new ReplayJobSupervisor(concurrent, { http_wait_ms: 100 });
  const first = concurrentSupervisor.submitAndRun(PINS);
  const second = concurrentSupervisor.submitAndRun(PINS);
  await Promise.resolve();
  assert(
    'same durable job is singleflight within one Backend process',
    concurrent.run_calls.length === 1
  );
  finishSingleflight?.({ job_id: JOB_ID, status: 'completed', snapshot_id: SNAPSHOT_ID });
  const concurrentResults = await Promise.all([first, second]);
  assert(
    'singleflight callers observe same terminal state',
    concurrentResults.every(job => job.status === 'completed')
  );

  const terminal = new FakeCli();
  terminal.submit_result = { job_id: JOB_ID, status: 'completed', snapshot_id: SNAPSHOT_ID };
  const terminalResult = await new ReplayJobSupervisor(terminal).submitAndRun(PINS);
  assert(
    'idempotent terminal submit does not rerun pipeline',
    terminalResult.status === 'completed'
  );
  assert('terminal submit makes no run_one call', terminal.run_calls.length === 0);

  const conflict = new FakeCli();
  const conflictError = new ReplayCliRejectedError('REPLAY_CONFLICT', 'replay job conflict', 3);
  conflict.run_result = Promise.reject(conflictError);
  conflict.status_result = { job_id: JOB_ID, status: 'running' };
  const conflictResult = await new ReplayJobSupervisor(conflict, {
    http_wait_ms: 100,
  }).submitAndRun(PINS);
  assert(
    'cross-process CAS conflict recovers through durable status',
    conflictResult.status === 'running'
  );

  const recovery = new FakeCli();
  recovery.status_result = { job_id: JOB_ID, status: 'running' };
  const recoverySupervisor = new ReplayJobSupervisor(recovery);
  const recoveredStatus = await recoverySupervisor.status(JOB_ID);
  await Promise.resolve();
  assert(
    'status remains a durable observation during recovery',
    recoveredStatus.status === 'running'
  );
  assert('status polling schedules safe run_one recovery', recovery.run_calls.length === 1);
  assert(
    'recovery worker is still bounded',
    recovery.run_calls[0].options?.timeout_ms === 122_000
  );

  const jobIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ];
  class CapacityCli extends FakeCli {
    private index = 0;
    readonly resolvers: Array<(job: ReplayJob) => void> = [];

    override async submit(
      pins: ReplayPins,
      options?: ReplayCliInvocationOptions
    ): Promise<ReplayJob> {
      this.submit_calls.push({ pins, options });
      return { job_id: jobIds[this.index++], status: 'queued' };
    }

    override runOne(job_id: string, options?: ReplayCliInvocationOptions): Promise<ReplayJob> {
      this.run_calls.push({ job_id, options });
      return new Promise(resolve => this.resolvers.push(resolve));
    }

    override async status(
      job_id: string,
      options?: ReplayCliInvocationOptions
    ): Promise<ReplayJob> {
      this.status_calls.push({ job_id, options });
      return { job_id, status: 'running' };
    }
  }
  const capacity = new CapacityCli();
  const capacitySupervisor = new ReplayJobSupervisor(capacity, {
    http_wait_ms: 0,
    operational_limits: { ...LIMITS, max_concurrency: 1, max_queue_depth: 1 },
  });
  await capacitySupervisor.submitAndRun(PINS);
  await capacitySupervisor.submitAndRun({ ...PINS, trading_day: '2026-07-15' });
  let backpressured = false;
  try {
    await capacitySupervisor.submitAndRun({ ...PINS, trading_day: '2026-07-16' });
  } catch (error: unknown) {
    backpressured = error instanceof ReplayBackpressureError;
  }
  assert(
    'global scheduler starts no more than max_concurrency workers',
    capacity.run_calls.length === 1
  );
  assert(
    'global queue rejects before a third durable submit',
    backpressured && capacity.submit_calls.length === 2
  );
  capacity.resolvers[0]({
    job_id: jobIds[0],
    status: 'completed',
    snapshot_id: SNAPSHOT_ID,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert(
    'queue dispatches the next job only after capacity is released',
    capacity.run_calls.length === 2
  );

  let finishStatus: ((job: ReplayJob) => void) | undefined;
  const control = new FakeCli();
  control.status = (job_id, options) => {
    control.status_calls.push({ job_id, options });
    return new Promise(resolve => {
      finishStatus = resolve;
    });
  };
  const controlSupervisor = new ReplayJobSupervisor(control, {
    operational_limits: { ...LIMITS, max_concurrency: 1 },
    control_timeout_ms: 0,
  });
  const firstStatus = controlSupervisor.status(JOB_ID);
  await Promise.resolve();
  let controlBackpressured = false;
  try {
    await controlSupervisor.status(JOB_ID);
  } catch (error: unknown) {
    controlBackpressured = error instanceof ReplayBackpressureError;
  }
  assert('status control children obey a global concurrency bound', controlBackpressured);
  assert(
    'control timeout zero falls back to a finite timeout',
    control.status_calls[0].options?.timeout_ms === 5000
  );
  finishStatus?.({ job_id: JOB_ID, status: 'completed', snapshot_id: SNAPSHOT_ID });
  await firstStatus;

  let finishWorker: ((job: ReplayJob) => void) | undefined;
  const sharedCapacity = new FakeCli();
  sharedCapacity.run_result = new Promise(resolve => {
    finishWorker = resolve;
  });
  const sharedCapacitySupervisor = new ReplayJobSupervisor(sharedCapacity, {
    http_wait_ms: 0,
    operational_limits: { ...LIMITS, max_concurrency: 1 },
  });
  const admitted = await sharedCapacitySupervisor.submitAndRun(PINS);
  assert(
    'HTTP wait fallback returns the durable submit state when the worker owns the only slot',
    admitted.status === 'queued' && sharedCapacity.status_calls.length === 0
  );
  let workerBlocksControl = false;
  try {
    await sharedCapacitySupervisor.status(JOB_ID);
  } catch (error: unknown) {
    workerBlocksControl = error instanceof ReplayBackpressureError;
  }
  assert(
    'active workers and control calls share one global child-process bound',
    workerBlocksControl && sharedCapacity.status_calls.length === 0
  );
  finishWorker?.({ job_id: JOB_ID, status: 'completed', snapshot_id: SNAPSHOT_ID });
  await sharedCapacity.run_result;

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
