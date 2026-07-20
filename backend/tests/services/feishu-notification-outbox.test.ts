import {
  EnqueueFeishuNotificationInput,
  FeishuNotificationRepository,
  FeishuNotificationListFilters,
  FeishuNotificationService,
  FeishuOutboxRow,
  resolveProductionFeishuTarget,
} from '../../src/services/FeishuNotificationService';

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

class FakeRepository implements FeishuNotificationRepository {
  rows = new Map<number, FeishuOutboxRow>();
  byKey = new Map<string, number>();
  seq = 1;

  async findOrCreate(input: EnqueueFeishuNotificationInput, now: Date) {
    const existingId = this.byKey.get(input.idempotency_key);
    if (existingId) return { row: this.clone(this.rows.get(existingId)!), created: false };
    const row: FeishuOutboxRow = {
      id: this.seq++,
      idempotency_key: input.idempotency_key,
      topic_key: input.topic_key,
      audience: input.audience,
      recipient_user_id: input.recipient_user_id ?? null,
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      max_attempts: input.max_attempts || 6,
      next_attempt_at: new Date(now),
      locked_at: null,
      sent_at: null,
      dead_at: null,
      last_error: null,
      last_status_code: null,
      response: {},
      correlation_id: input.correlation_id || null,
      metadata: input.metadata || {},
    };
    this.rows.set(row.id, row);
    this.byKey.set(row.idempotency_key, row.id);
    return { row: this.clone(row), created: true };
  }

  async findById(id: number) {
    const row = this.rows.get(id);
    return row ? this.clone(row) : null;
  }

  async claim(id: number, now: Date, stale_before: Date) {
    const row = this.rows.get(id);
    if (!row) return false;
    const due = (row.status === 'pending' || row.status === 'retry') && row.next_attempt_at <= now;
    const stale = row.status === 'sending' && !!row.locked_at && row.locked_at <= stale_before;
    if (!due && !stale) return false;
    row.status = 'sending';
    row.locked_at = new Date(now);
    return true;
  }

  async update(id: number, patch: Partial<FeishuOutboxRow>) {
    const row = this.rows.get(id);
    if (!row) throw new Error('missing row');
    Object.assign(row, patch);
  }

  async loadDue(now: Date, stale_before: Date, limit: number) {
    return [...this.rows.values()]
      .filter(
        row =>
          ((row.status === 'pending' || row.status === 'retry') && row.next_attempt_at <= now) ||
          (row.status === 'sending' && !!row.locked_at && row.locked_at <= stale_before)
      )
      .slice(0, limit)
      .map(row => this.clone(row));
  }

  async list(filters: FeishuNotificationListFilters) {
    return [...this.rows.values()]
      .filter(row => !filters.statuses?.length || filters.statuses.includes(row.status))
      .filter(row => !filters.audiences?.length || filters.audiences.includes(row.audience))
      .filter(row => !filters.kind || row.kind === filters.kind)
      .filter(row => !filters.topic_key || row.topic_key === filters.topic_key)
      .sort((a, b) => b.id - a.id)
      .slice(0, Math.max(1, Number(filters.limit) || 50))
      .map(row => this.clone(row));
  }

  async getHealth(now: Date, stale_before: Date) {
    const counts = {
      pending: 0,
      sending: 0,
      retry: 0,
      sent: 0,
      dead: 0,
      suppressed: 0,
    };
    for (const row of this.rows.values()) counts[row.status] += 1;
    const backlog = counts.pending + counts.retry + counts.sending;
    const dueRows = await this.loadDue(now, stale_before, Number.MAX_SAFE_INTEGER);
    const oldest = [...this.rows.values()]
      .filter(row => ['pending', 'retry', 'sending'].includes(row.status))
      .sort((a, b) => a.next_attempt_at.getTime() - b.next_attempt_at.getTime())[0];
    const latest = [...this.rows.values()].sort((a, b) => b.id - a.id)[0];
    return {
      status: counts.dead > 0 ? ('critical' as const) : backlog > 0 ? ('degraded' as const) : ('healthy' as const),
      counts,
      backlog,
      due: dueRows.length,
      dead: counts.dead,
      oldest_due_at: oldest?.next_attempt_at.toISOString() || null,
      latest: latest ? this.clone(latest) : null,
    };
  }

  async requeueTerminal(id: number, now: Date) {
    const row = this.rows.get(id);
    if (!row || (row.status !== 'dead' && row.status !== 'suppressed')) return false;
    row.status = 'retry';
    row.attempts = 0;
    row.next_attempt_at = new Date(now);
    row.locked_at = null;
    row.dead_at = null;
    return true;
  }

  private clone(row: FeishuOutboxRow): FeishuOutboxRow {
    return {
      ...row,
      next_attempt_at: new Date(row.next_attempt_at),
      locked_at: row.locked_at ? new Date(row.locked_at) : null,
      sent_at: row.sent_at ? new Date(row.sent_at) : null,
      dead_at: row.dead_at ? new Date(row.dead_at) : null,
      payload: { ...row.payload },
      response: { ...row.response },
      metadata: { ...row.metadata },
    };
  }
}

function input(key: string, max_attempts = 3): EnqueueFeishuNotificationInput {
  return {
    idempotency_key: key,
    topic_key: 'topic',
    audience: 'ops',
    kind: 'test',
    severity: 'WARN',
    title: 'test',
    payload: { msg_type: 'text', content: { text: key } },
    max_attempts,
  };
}

async function main() {
  let now = new Date('2026-07-19T00:00:00Z');

  {
    const repo = new FakeRepository();
    let sends = 0;
    const service = new FeishuNotificationService(
      repo,
      async () => ({ url: 'https://open.feishu.cn/hook/test' }),
      async () => {
        sends += 1;
        return { success: true, status_code: 200, data: { code: 0 } };
      },
      () => new Date(now)
    );
    const result = await service.enqueueAndDeliver(input('happy'));
    assert('happy path sent', result.status === 'sent' && result.success);
    assert('happy path sender once', sends === 1);
    assert('happy path attempts=1', repo.rows.get(1)?.attempts === 1);
  }

  {
    const repo = new FakeRepository();
    let sends = 0;
    const service = new FeishuNotificationService(
      repo,
      async () => ({ url: 'https://open.feishu.cn/hook/test' }),
      async () => {
        sends += 1;
        return sends === 1
          ? { success: false, status_code: 504, message: 'timeout' }
          : { success: true, status_code: 200, data: { code: 0 } };
      },
      () => new Date(now)
    );
    const first = await service.enqueueAndDeliver(input('retry'));
    assert('failure remains retryable', first.status === 'retry');
    const duplicate = await service.enqueueAndDeliver(input('retry'));
    assert(
      'dedup does not suppress pending retry',
      duplicate.status === 'retry' && duplicate.deduped === true
    );
    now = new Date(now.getTime() + 61_000);
    const summary = await service.dispatchPending();
    assert('worker retries and sends', summary.sent === 1 && sends === 2);
  }

  {
    const repo = new FakeRepository();
    const service = new FeishuNotificationService(
      repo,
      async () => ({ url: 'https://open.feishu.cn/hook/test' }),
      async () => ({ success: false, message: 'down' }),
      () => new Date(now)
    );
    await service.enqueueAndDeliver(input('dead', 2));
    now = new Date(now.getTime() + 61_000);
    const second = await service.dispatchPending();
    assert('max attempts becomes dead', second.dead === 1 && repo.rows.get(1)?.status === 'dead');

    const health = await service.getHealth();
    assert('dead delivery makes health critical', health.status === 'critical' && health.dead === 1);
    const replay = await service.retryTerminal(1);
    assert('manual dead replay re-enters retry lifecycle', replay.status === 'retry');
    assert('manual replay resets and consumes a fresh attempt budget', replay.attempts === 1);
  }

  {
    const repo = new FakeRepository();
    await repo.findOrCreate(input('stale'), now);
    const row = repo.rows.get(1)!;
    row.status = 'sending';
    row.locked_at = new Date(now.getTime() - 6 * 60_000);
    let sends = 0;
    const service = new FeishuNotificationService(
      repo,
      async () => ({ url: 'https://open.feishu.cn/hook/test' }),
      async () => {
        sends += 1;
        return { success: true };
      },
      () => new Date(now)
    );
    const summary = await service.dispatchPending();
    assert('stale lock recovered', summary.sent === 1 && sends === 1);
  }

  {
    const repo = new FakeRepository();
    const created = await repo.findOrCreate(input('concurrent'), now);
    let sends = 0;
    const service = new FeishuNotificationService(
      repo,
      async () => ({ url: 'https://open.feishu.cn/hook/test' }),
      async () => {
        sends += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { success: true };
      },
      () => new Date(now)
    );
    await Promise.all([service.deliver(created.row.id), service.deliver(created.row.id)]);
    assert('concurrent claim sends once', sends === 1);
  }

  {
    const repo = new FakeRepository();
    let sends = 0;
    const factory = () =>
      new FeishuNotificationService(
        repo,
        async () => ({ url: 'https://open.feishu.cn/hook/test' }),
        async () => {
          sends += 1;
          return { success: true };
        },
        () => new Date(now)
      );
    await Promise.all([
      factory().enqueueAndDeliver(input('cross-instance')),
      factory().enqueueAndDeliver(input('cross-instance')),
    ]);
    assert('idempotency across service instances', repo.rows.size === 1 && sends === 1);
    const listed = await factory().listDeliveries({ statuses: ['sent'], limit: 10 });
    assert('admin list returns persisted sent delivery', listed.length === 1 && listed[0].status === 'sent');
  }

  {
    const saved = { ...process.env };
    try {
      delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
      process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK = 'https://open.feishu.cn/business';
      process.env.LIVE_ALERT_FEISHU_WEBHOOK = '';
      const base = (audience: any): FeishuOutboxRow => ({
        id: 1,
        idempotency_key: 'x',
        topic_key: 'x',
        audience,
        recipient_user_id: null,
        kind: 'x',
        severity: 'INFO',
        title: 'x',
        payload: {},
        status: 'pending',
        attempts: 0,
        max_attempts: 2,
        next_attempt_at: now,
        locked_at: null,
        sent_at: null,
        dead_at: null,
        last_error: null,
        last_status_code: null,
        response: {},
        correlation_id: null,
        metadata: {},
      });
      const ops = await resolveProductionFeishuTarget(base('ops'));
      const live = await resolveProductionFeishuTarget(base('live'));
      const business = await resolveProductionFeishuTarget(base('business'));
      assert('ops never falls back to business', !ops.url && /OPS/.test(ops.reason || ''));
      assert('live never falls back to business', !live.url && /LIVE/.test(live.reason || ''));
      assert(
        'business uses business webhook',
        business.url === process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK
      );
    } finally {
      process.env = saved;
    }
  }

  console.log(`[feishu-notification-outbox] ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
