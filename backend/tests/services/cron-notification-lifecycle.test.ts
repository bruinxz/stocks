import {
  CronIncidentRepository,
  CronIncidentSnapshot,
  CronNotificationEventInput,
  CronNotificationLifecycleService,
} from '../../src/services/CronNotificationLifecycleService';

let failed = 0;
function assert(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

class FakeIncidentRepository implements CronIncidentRepository {
  incident: CronIncidentSnapshot | null = null;

  async recordFailure(input: CronNotificationEventInput): Promise<CronIncidentSnapshot> {
    const opening = !this.incident || this.incident.status !== 'open';
    const generation = opening ? (this.incident?.generation || 0) + 1 : this.incident!.generation;
    this.incident = {
      source_key: `cron:${input.task_id}`,
      status: 'open',
      generation,
      occurrence_count: opening ? 1 : this.incident!.occurrence_count + 1,
      severity: input.killed ? 'HIGH' : this.incident?.severity || 'WARN',
      summary: `${input.task_name} (${input.task_type})`,
      last_error: input.error_message || null,
      opened_at: opening ? input.occurred_at || new Date() : this.incident!.opened_at,
      last_seen_at: input.occurred_at || new Date(),
      resolved_at: null,
      escalated: opening ? false : this.incident!.escalated,
      opened_notification_generation: opening ? 0 : this.incident!.opened_notification_generation,
      recovered_notification_generation: this.incident?.recovered_notification_generation || 0,
      metadata: { failure_count: input.failure_count, killed: input.killed === true },
    };
    return { ...this.incident };
  }

  async loadOpen(task_id: number) {
    return this.incident?.source_key === `cron:${task_id}` && this.incident.status === 'open'
      ? { ...this.incident }
      : null;
  }

  async markOpenedNotified(source_key: string, generation: number, escalated: boolean) {
    if (
      !this.incident ||
      this.incident.source_key !== source_key ||
      this.incident.generation !== generation
    )
      return;
    this.incident.opened_notification_generation = generation;
    if (escalated) {
      this.incident.escalated = true;
      this.incident.severity = 'HIGH';
    }
  }

  async markEscalated(source_key: string, generation: number) {
    if (
      !this.incident ||
      this.incident.source_key !== source_key ||
      this.incident.generation !== generation
    )
      return;
    this.incident.escalated = true;
    this.incident.severity = 'HIGH';
  }

  async markResolved(source_key: string, generation: number, resolved_at: Date) {
    if (
      !this.incident ||
      this.incident.source_key !== source_key ||
      this.incident.generation !== generation
    )
      return;
    this.incident.status = 'resolved';
    this.incident.resolved_at = resolved_at;
    this.incident.recovered_notification_generation = generation;
  }
}

async function main() {
  const repo = new FakeIncidentRepository();
  const messages: any[] = [];
  const notifications = {
    async enqueueAndDeliver(input: any) {
      messages.push(input);
      return { success: true, status: 'sent', outbox_id: messages.length, attempts: 1 };
    },
  };
  const service = new CronNotificationLifecycleService(repo, notifications as any);
  const base = {
    task_id: 7,
    task_type: 'GLOBAL_MARKET_DAILY_SYNC',
    task_name: '全球市场日更',
    execution_log_id: 101,
  };

  await service.recordFailure({ ...base, failure_count: 1, error_message: 'BOJ conflict' });
  assert(
    'first failure emits opened',
    messages.length === 1 && messages[0].kind === 'cron_incident_opened'
  );
  assert('opened idempotency uses generation', messages[0].idempotency_key === 'cron:7:g1:opened');

  await service.recordFailure({ ...base, failure_count: 2, error_message: 'still failing' });
  assert('repeated failure is silent', messages.length === 1);
  assert('repeated failure increments incident count', repo.incident?.occurrence_count === 2);

  await service.recordFailure({
    ...base,
    failure_count: 5,
    error_message: 'threshold',
    killed: true,
  });
  assert(
    'kill switch emits one escalation',
    messages.length === 2 && messages[1].kind === 'cron_incident_escalated'
  );

  await service.recordFailure({ ...base, failure_count: 6, error_message: 'again', killed: true });
  assert('repeated killed failure remains silent', messages.length === 2);

  await service.recordRecovery({ ...base, occurred_at: new Date('2026-07-19T08:00:00Z') });
  assert(
    'recovery emits recovered',
    messages.length === 3 && messages[2].kind === 'cron_incident_recovered'
  );
  assert('incident resolved after enqueue', repo.incident?.status === 'resolved');

  await service.recordRecovery({ ...base });
  assert('repeat success without open incident is silent', messages.length === 3);

  await service.recordFailure({
    ...base,
    execution_log_id: 202,
    failure_count: 1,
    error_message: 'new incident',
  });
  assert('new failure after recovery starts generation 2', messages.length === 4);
  assert(
    'new generation gets new idempotency key',
    messages[3].idempotency_key === 'cron:7:g2:opened'
  );

  console.log(`[cron-notification-lifecycle] ${8 - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
